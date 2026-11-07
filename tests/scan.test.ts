import { describe, expect, it, vi } from 'vitest'
import { scanSessions, type ScanHosts, type SessionRecordLike } from '../src/scan.ts'
import type { SessionEventLike } from '../src/classify.ts'

const NOW = new Date('2026-11-07T02:00:00').getTime()
const HOUR = 3_600_000
const OPTS = { now: NOW, lookbackHours: 24, includeError: true, includeDisposed: true, maxObservations: 30 }

/** 一段「interrupted 结尾」的事件，时间 2 小时前。 */
function interruptedEvents(): SessionEventLike[] {
  return [
    { type: 'turn/start', time: NOW - 2 * HOUR },
    { type: 'turn/end', time: NOW - 2 * HOUR, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]
}

/** 造一个假 hosts：所有覆写共享同一个 observed 数组。 */
function makeHosts(overrides: {
  listSessions?: ScanHosts['sessionQuery']['listSessions']
  observeSession?: ScanHosts['sessionQuery']['observeSession']
  agents?: ScanHosts['agents']
  workspaceRegistry?: ScanHosts['workspaceRegistry']
  sessionPersistence?: ScanHosts['sessionPersistence']
} = {}): ScanHosts & { observed: string[] } {
  const observed: string[] = []
  const defaultListSessions = async () => [] as SessionRecordLike[]
  const defaultObserveSession = async () => ({ events: interruptedEvents() })
  const hosts: ScanHosts = {
    sessionQuery: {
      listSessions: overrides.listSessions ?? defaultListSessions,
      observeSession: async (id: string) => {
        const observer = overrides.observeSession ?? defaultObserveSession
        const observation = await observer(id)
        observed.push(id)
        return observation
      },
    },
    agents: overrides.agents ?? { get: () => undefined },
    workspaceRegistry: overrides.workspaceRegistry ?? { archivedSessionIds: [] },
    // 默认给每会话一个日志路径，让注入的 statMtime 通道说话；显式覆写优先。
    ...(overrides.sessionPersistence === undefined
      ? { sessionPersistence: { stat: async (id: string) => ({ location: { path: `/logs/${id}.jsonl.zstd` } }) } }
      : { sessionPersistence: overrides.sessionPersistence }),
  }
  return { ...hosts, observed }
}

/** 默认 mtime 通道：一律回 2 小时前（窗口内，可整读）。 */
const RECENT_MTIME = { statMtime: async () => NOW - 2 * HOUR }
/** mtime 不可知通道：stat/statMtime 都拿不到时间。 */
const NO_MTIME = { statMtime: async () => undefined }

function listing(...ids: string[]): ScanHosts['sessionQuery']['listSessions'] {
  return async () => ids.map((id) => ({ header: { id } }))
}

describe('scanSessions：扫描层过滤', () => {
  it('子代理会话（origin）与子会话（parentSession）→ skip，不读事件', async () => {
    const hosts = makeHosts({
      listSessions: async () => [
        { header: { id: 'child-origin', origin: 'subagent' } },
        { header: { id: 'child-parent', parentSession: 'p1' } },
        { header: { id: 'normal' } },
      ],
    })
    const rows = await scanSessions(hosts, OPTS, RECENT_MTIME)
    expect(hosts.observed).toEqual(['normal'])
    expect(rows.find((row) => row.sessionId === 'child-origin')).toMatchObject({ action: 'skip', cause: 'subagent' })
    expect(rows.find((row) => row.sessionId === 'child-parent')).toMatchObject({ action: 'skip', cause: 'subagent' })
    expect(rows.find((row) => row.sessionId === 'normal')).toMatchObject({ action: 'continue', cause: 'interrupted' })
  })

  it('已归档会话 → skip，不读事件', async () => {
    const hosts = makeHosts({
      listSessions: listing('arch-1', 'normal'),
      workspaceRegistry: { archivedSessionIds: ['arch-1'] },
    })
    const rows = await scanSessions(hosts, OPTS, RECENT_MTIME)
    expect(hosts.observed).toEqual(['normal'])
    expect(rows.find((row) => row.sessionId === 'arch-1')).toMatchObject({ action: 'skip', cause: 'archived' })
  })

  it('运行中的会话 → skip；attached-idle 仍判定', async () => {
    const hosts = makeHosts({
      listSessions: listing('busy', 'idle'),
      agents: {
        get(id: string) {
          return id === 'busy' ? { status: 'running' } : { status: 'idle' }
        },
      },
    })
    const rows = await scanSessions(hosts, OPTS, RECENT_MTIME)
    expect(rows.find((row) => row.sessionId === 'busy')).toMatchObject({ action: 'skip', cause: 'running' })
    expect(rows.find((row) => row.sessionId === 'idle')).toMatchObject({ action: 'continue' })
  })
})

describe('scanSessions：mtime 预筛', () => {
  it('mtime 早于窗口起点 → skip，不读事件', async () => {
    const hosts = makeHosts({
      listSessions: listing('old'),
      sessionPersistence: { stat: async () => ({ location: { path: '/logs/old.jsonl.zstd' } }) },
    })
    const io = { statMtime: async () => NOW - 48 * HOUR }
    const rows = await scanSessions(hosts, OPTS, io)
    expect(hosts.observed).toEqual([])
    expect(rows).toEqual([expect.objectContaining({ sessionId: 'old', action: 'skip', cause: 'outside-window' })])
  })

  it('stat 缺席或拿不到时间 → skip（fail closed），不读事件', async () => {
    const hosts = makeHosts({ listSessions: listing('no-stat') })
    const rows = await scanSessions(hosts, OPTS, NO_MTIME)
    expect(hosts.observed).toEqual([])
    expect(rows).toEqual([expect.objectContaining({ sessionId: 'no-stat', action: 'skip', cause: 'mtime-unknown' })])
  })

  it('maxObservations 截断：只整读最近 N 个，按 mtime 降序', async () => {
    const hosts = makeHosts({
      listSessions: listing('mid', 'newest', 'oldest'),
      sessionPersistence: { stat: async (id: string) => ({ location: { path: `/logs/${id}.jsonl.zstd` } }) },
    })
    const io = { statMtime: async (path: string) => {
      const table: Record<string, number> = { mid: NOW - 5 * HOUR, newest: NOW - 1 * HOUR, oldest: NOW - 20 * HOUR }
      return table[path.split('/').pop()!.replace('.jsonl.zstd', '')]
    } }
    const rows = await scanSessions(hosts, { ...OPTS, maxObservations: 2 }, io)
    expect(hosts.observed).toEqual(['newest', 'mid'])
    expect(rows.filter((row) => row.sessionId === 'oldest')).toHaveLength(0)
  })
})

describe('scanSessions：fs 直查通道', () => {
  /** fs 通道：只给 sessionId，没有 header（枚举层拿不到会话元数据）。 */
  const recent = {
    async listRecent() {
      return [
        { sessionId: 'child-origin', mtime: NOW - HOUR },
        { sessionId: 'child-parent', mtime: NOW - HOUR },
        { sessionId: 'top', mtime: NOW - HOUR },
      ]
    },
  }

  it('观察到的 header 标明子代理/子会话 → skip subagent（不投递）', async () => {
    const hosts = makeHosts({
      observeSession: async (id: string) => ({
        events: interruptedEvents(),
        ...(id === 'child-origin'
          ? { header: { origin: 'subagent' } }
          : id === 'child-parent'
            ? { header: { parentSession: 'p1' } }
            : {}),
      }),
    })
    const rows = await scanSessions(hosts, OPTS, NO_MTIME, undefined, recent)
    expect(rows.find((row) => row.sessionId === 'child-origin')).toMatchObject({ action: 'skip', cause: 'subagent' })
    expect(rows.find((row) => row.sessionId === 'child-parent')).toMatchObject({ action: 'skip', cause: 'subagent' })
    expect(rows.find((row) => row.sessionId === 'top')).toMatchObject({ action: 'continue', cause: 'interrupted' })
  })

  it('header 缺席时照常判定（不因缺元数据漏掉会话）', async () => {
    const hosts = makeHosts({ observeSession: async () => ({ events: interruptedEvents() }) })
    const rows = await scanSessions(hosts, OPTS, NO_MTIME, undefined, recent)
    expect(rows.filter((row) => row.action === 'continue')).toHaveLength(3)
  })
})

describe('scanSessions：失败隔离与资源', () => {
  it('单会话观察抛错 → 该行 skip cause 以 error: 开头，其余照常判定', async () => {
    const hosts = makeHosts({
      listSessions: listing('bad', 'good'),
      observeSession: async (id: string) => {
        if (id === 'bad') throw new Error('corrupt session log')
        return { events: interruptedEvents() }
      },
    })
    const rows = await scanSessions(hosts, OPTS, RECENT_MTIME)
    expect(rows.find((row) => row.sessionId === 'bad')).toMatchObject({
      action: 'skip',
      cause: expect.stringMatching(/^error:/),
    })
    expect(rows.find((row) => row.sessionId === 'good')).toMatchObject({ action: 'continue' })
  })

  it('observation 可释放时判定后恰好释放一次', async () => {
    const dispose = vi.fn()
    const hosts = makeHosts({
      listSessions: listing('d'),
      observeSession: async () => ({ events: interruptedEvents(), [Symbol.dispose]: dispose }),
    })
    await scanSessions(hosts, OPTS, RECENT_MTIME)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('listSessions 本身抛错 → 整场扫描记一行 error，不外抛', async () => {
    const hosts = makeHosts({
      listSessions: async () => {
        throw new Error('persistence offline')
      },
    })
    const rows = await scanSessions(hosts, OPTS, NO_MTIME)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'skip', cause: expect.stringMatching(/^error:/) })
  })
})
