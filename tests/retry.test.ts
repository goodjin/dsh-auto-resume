import { describe, expect, it } from 'vitest'

import type { SessionEventLike } from '../src/classify.ts'
import { emptyLedger } from '../src/retry-ledger.ts'
import { runRetryTick, type RetrySessionDeps } from '../src/retry.ts'

const NOW = new Date('2026-11-11T10:00:00').getTime()
const HOUR = 3_600_000
const OPTIONS = {
  now: NOW,
  lookbackHours: 24,
  includeError: true,
  includeDisposed: true,
  maxRetries: 3,
  retryIntervalMs: 600_000,
  overloadRetryDelayMs: 300_000,
  overloadMaxRetries: 1,
}

/** 一轮还在失败的会话事件。 */
function failingEvents(at = NOW): SessionEventLike[] {
  return [
    { type: 'turn/start', time: at - 1_000 },
    { type: 'turn/end', time: at, data: { turn: 1, reason: { kind: 'error', error: { message: 'fetch failed [QUOTA_EXCEEDED]' } } } },
  ]
}

/** 一轮已经完成的会话事件。 */
function completedEvents(at = NOW): SessionEventLike[] {
  return [
    { type: 'turn/start', time: at - 1_000 },
    { type: 'turn/end', time: at, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** 造一份账本：一个正在重试周期里的登记。 */
function ledgerWith(sessionId: string, over: Partial<{ failures: number; attempts: number; tailTime: number }> = {}) {
  const ledger = emptyLedger()
  ledger.active[sessionId] = {
    sessionId,
    detail: 'fetch failed [QUOTA_EXCEEDED]',
    tailTime: over.tailTime ?? NOW - HOUR,
    attempts: over.attempts ?? 1,
    failures: over.failures ?? 0,
    registeredAt: NOW - 2 * HOUR,
  }
  return ledger
}

/** 造一份账本：一个「集群负载高」的过载登记（带下次到期时间）。 */
function overloadLedger(
  sessionId: string,
  over: Partial<{ dueAt: number; overloadAttempts: number; tailTime: number }> = {},
) {
  const ledger = emptyLedger()
  ledger.active[sessionId] = {
    sessionId,
    detail: 'MiniMax request failed (529): 当前服务集群负载较高，请稍后重试',
    tailTime: over.tailTime ?? NOW - HOUR,
    attempts: 1,
    failures: 0,
    registeredAt: NOW - HOUR,
    overload: true,
    dueAt: over.dueAt ?? NOW + 300_000,
    overloadAttempts: over.overloadAttempts ?? 0,
  }
  return ledger
}

/** 假宿主面：观察与投递都记账。 */
function makeDeps(sessions: Record<string, { events: SessionEventLike[]; running?: boolean }>) {
  const delivered: Array<{ sessionId: string }> = []
  const deps: RetrySessionDeps = {
    observe: async (sessionId: string) => {
      const session = sessions[sessionId]
      if (session === undefined) return { ok: false, detail: 'not found' }
      const running = session.running
      return { ok: true, events: session.events, ...(running === undefined ? {} : { running }) }
    },
    deliver: async (target) => {
      delivered.push({ sessionId: target.sessionId })
      return { sessionId: target.sessionId, ok: true }
    },
  }
  return { deps, delivered }
}

describe('runRetryTick：周期重试', () => {
  it('仍在失败 → 记一次连续失败，并再投一次', async () => {
    const ledger = ledgerWith('s1')
    const { deps, delivered } = makeDeps({ s1: { events: failingEvents(NOW) } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toEqual([{ sessionId: 's1' }])
    expect(report.retried[0]).toMatchObject({ sessionId: 's1', ok: true, failures: 1, attempts: 2 })
    expect(ledger.active['s1']).toMatchObject({ failures: 1, attempts: 2 })
  })

  it('会话自己走完了（正常完成）→ 摘出账本，不投、不算失败', async () => {
    const ledger = ledgerWith('s1')
    const { deps, delivered } = makeDeps({ s1: { events: completedEvents(NOW) } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toHaveLength(0)
    expect(report.recovered).toEqual(['s1'])
    expect(ledger.active['s1']).toBeUndefined()
  })

  it('用户停过的会话 → 摘出账本，永不续', async () => {
    const ledger = ledgerWith('s1')
    const stopped: SessionEventLike[] = [
      { type: 'turn/start', time: NOW - 1_000 },
      { type: 'turn/end', time: NOW, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ]
    const { deps, delivered } = makeDeps({ s1: { events: stopped } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toHaveLength(0)
    expect(report.recovered).toEqual(['s1'])
  })

  it('连续失败凑满上限 → 放弃并标记不再重试，这一轮不再投', async () => {
    const ledger = ledgerWith('s1', { failures: 2, attempts: 3 })
    const { deps, delivered } = makeDeps({ s1: { events: failingEvents(NOW) } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toHaveLength(0)
    expect(report.abandoned[0]).toMatchObject({ sessionId: 's1', attempts: 3 })
    expect(ledger.active['s1']).toBeUndefined()
    expect(ledger.abandoned['s1']).toMatchObject({ sessionId: 's1', attempts: 3 })
    expect(ledger.abandoned['s1']?.reason).toContain('不再重试')
  })

  it('再次被中断（应用又退出）→ 不算失败，更新尾部并照常再投', async () => {
    const ledger = ledgerWith('s1', { failures: 2, attempts: 3 })
    const interrupted: SessionEventLike[] = [
      { type: 'turn/start', time: NOW - 1_000 },
      { type: 'turn/end', time: NOW, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ]
    const { deps, delivered } = makeDeps({ s1: { events: interrupted } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toHaveLength(1)
    expect(ledger.active['s1']).toMatchObject({ failures: 2, attempts: 4 })
    expect(report.abandoned).toHaveLength(0)
  })

  it('正在运行 → 不算失败也不重投', async () => {
    const ledger = ledgerWith('s1', { failures: 2, attempts: 3 })
    const running: SessionEventLike[] = [
      { type: 'turn/start', time: NOW - 1_000 },
      { type: 'step/start', time: NOW },
    ]
    const { deps, delivered } = makeDeps({ s1: { events: running, running: true } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toHaveLength(0)
    expect(report.skipped[0]).toMatchObject({ sessionId: 's1' })
    expect(ledger.active['s1']).toMatchObject({ failures: 2 })
  })

  it('会话读不出来 → 放弃（登记作废）', async () => {
    const ledger = ledgerWith('gone')
    const deps: RetrySessionDeps = {
      observe: async () => ({ ok: false, detail: 'not found' }),
      deliver: async () => ({ sessionId: 'gone', ok: true }),
    }
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(ledger.active['gone']).toBeUndefined()
    expect(report.dropped[0]).toMatchObject({ sessionId: 'gone' })
  })
})

describe('runRetryTick：过载类（529 集群负载高）按到期时间、只重试一次', () => {
  it('还没到 5 分钟（dueAt 未到）→ 跳过，连会话都不观察、不投递', async () => {
    const ledger = overloadLedger('busy', { dueAt: NOW + 300_000 })
    let observed = 0
    const deps: RetrySessionDeps = {
      observe: async () => { observed += 1; return { ok: true, events: failingEvents(NOW) } },
      deliver: async () => ({ sessionId: 'busy', ok: true }),
    }
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(observed).toBe(0)
    expect(report.skipped[0]).toMatchObject({ sessionId: 'busy' })
    expect(ledger.active['busy']).toBeDefined()
  })

  it('到期、仍在同一处失败 → 精确投一次，然后从账本摘掉（并留不再重试标记，防反复 529 无限循环）', async () => {
    const ledger = overloadLedger('busy', { dueAt: NOW - 1 })
    const { deps, delivered } = makeDeps({ busy: { events: failingEvents(NOW) } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toEqual([{ sessionId: 'busy' }])
    expect(ledger.active['busy']).toBeUndefined()
    expect(report.overloadDone).toEqual(['busy'])
    expect(report.retried).toHaveLength(0) // 不混进普通重试流水
    expect(ledger.abandoned['busy']?.reason).toContain('集群负载')
  })

  it('到期、会话已经续成功（走完/被停）→ 摘出账本，不投递', async () => {
    const ledger = overloadLedger('busy', { dueAt: NOW - 1 })
    const { deps, delivered } = makeDeps({ busy: { events: completedEvents(NOW) } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toHaveLength(0)
    expect(report.recovered).toEqual(['busy'])
    expect(ledger.active['busy']).toBeUndefined()
  })

  it('普通暂时性失败条目不受过载节奏影响（仍按旧周期重投）', async () => {
    const ledger = ledgerWith('normal')
    const { deps, delivered } = makeDeps({ normal: { events: failingEvents(NOW) } })
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(delivered).toEqual([{ sessionId: 'normal' }])
    expect(ledger.active['normal']).toBeDefined()
    expect(report.overloadDone).toHaveLength(0)
  })

  it('普通条目因心跳更快而被看到：dueAt 还在未来 → 跳过不投（仍是 10 分钟一轮）', async () => {
    const ledger = ledgerWith('normal')
    ledger.active['normal']!.dueAt = NOW + 600_000
    let observed = 0
    const deps: RetrySessionDeps = {
      observe: async () => { observed += 1; return { ok: true, events: failingEvents(NOW) } },
      deliver: async () => ({ sessionId: 'normal', ok: true }),
    }
    const report = await runRetryTick(ledger, deps, OPTIONS)
    expect(observed).toBe(0)
    expect(report.skipped[0]).toMatchObject({ sessionId: 'normal' })
  })

  it('普通条目本次重投后，dueAt 往后推一个周期（心跳下次才再挑中）', async () => {
    const ledger = ledgerWith('normal')
    const { deps } = makeDeps({ normal: { events: failingEvents(NOW) } })
    await runRetryTick(ledger, deps, OPTIONS)
    expect(ledger.active['normal']?.dueAt).toBe(NOW + 600_000)
  })
})

describe('runRetryTick：两个节奏各自的开关', () => {
  it('retryIntervalMs=0（普通周期关掉）→ 普通条目不重投，过载条目照常等 5 分钟后试', async () => {
    const off = { ...OPTIONS, retryIntervalMs: 0 }
    // 普通条目：不投，留在账本里等配置改回来（不删除、不误重试）。
    const normal = ledgerWith('normal')
    const normalDeps = makeDeps({ normal: { events: failingEvents(NOW) } })
    const normalReport = await runRetryTick(normal, normalDeps.deps, off)
    expect(normalDeps.delivered).toHaveLength(0)
    expect(normalReport.skipped[0]).toMatchObject({ sessionId: 'normal' })
    // 过载条目：到点仍按自己的节奏投一次。
    const busy = overloadLedger('busy', { dueAt: NOW - 1 })
    const busyDeps = makeDeps({ busy: { events: failingEvents(NOW) } })
    const busyReport = await runRetryTick(busy, busyDeps.deps, off)
    expect(busyDeps.delivered).toEqual([{ sessionId: 'busy' }])
    expect(busyReport.overloadDone).toEqual(['busy'])
  })

  it('overloadMaxRetries=0（过载重试关掉）→ 过载条目不投，普通条目照常', async () => {
    const off = { ...OPTIONS, overloadMaxRetries: 0 }
    const busy = overloadLedger('busy', { dueAt: NOW - 1 })
    const busyDeps = makeDeps({ busy: { events: failingEvents(NOW) } })
    const busyReport = await runRetryTick(busy, busyDeps.deps, off)
    expect(busyDeps.delivered).toHaveLength(0)
    expect(busyReport.skipped[0]).toMatchObject({ sessionId: 'busy' })
    const normal = ledgerWith('normal')
    const normalDeps = makeDeps({ normal: { events: failingEvents(NOW) } })
    await runRetryTick(normal, normalDeps.deps, off)
    expect(normalDeps.delivered).toEqual([{ sessionId: 'normal' }])
  })
})
