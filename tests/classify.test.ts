import { describe, expect, it } from 'vitest'
import { classifySession, type SessionEventLike } from '../src/classify.ts'

/** now 固定值：2026-11-07 02:00:00 本地。 */
const NOW = new Date('2026-11-07T02:00:00').getTime()
const HOUR = 3_600_000

/** 造事件：时间按「now 前 N 小时」给。 */
function ev(type: string, hoursAgo: number, data?: Record<string, unknown>): SessionEventLike {
  return { type, time: NOW - hoursAgo * HOUR, ...(data === undefined ? {} : { data }) }
}

const OPTS = { now: NOW, lookbackHours: 24, includeError: true, includeDisposed: true }

function turnEnd(reason: Record<string, unknown>, hoursAgo: number): SessionEventLike {
  return ev('turn/end', hoursAgo, { turn: 1, reason })
}

describe('classifySession：空与窗外', () => {
  it('空事件序列 → skip blank，不抛错', () => {
    const verdict = classifySession([], OPTS)
    expect(verdict).toMatchObject({ action: 'skip', cause: 'blank' })
  })

  it('最后活动早于窗口 → skip outside-window', () => {
    const events = [
      ev('turn/start', 30),
      turnEnd({ kind: 'interrupted' }, 30),
    ]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'skip', cause: 'outside-window' })
  })

  it('恰好窗口边界（等于窗口毫秒）不算窗外', () => {
    const events = [turnEnd({ kind: 'interrupted' }, 24)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'continue', cause: 'interrupted' })
  })
})

describe('classifySession：没有 turn/end', () => {
  it('无轮次也无用户消息 → skip blank', () => {
    const events = [ev('system/message', 1)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'skip', cause: 'blank' })
  })

  it('只有 user/message（轮次从未打开）→ continue interrupted', () => {
    const events = [ev('user/message', 1)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'continue', cause: 'interrupted' })
  })

  it('只有 agent/inbox/spliced（排队未投递）→ continue interrupted', () => {
    const events = [ev('agent/inbox/spliced', 1)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'continue', cause: 'interrupted' })
  })
})

describe('classifySession：按最后一轮的结束原因', () => {
  it('interrupted → continue interrupted', () => {
    const events = [ev('turn/start', 2), turnEnd({ kind: 'interrupted' }, 2)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'continue', cause: 'interrupted' })
  })

  it('error 且 includeError → continue error，detail 取 error.message', () => {
    const events = [
      ev('turn/start', 2),
      turnEnd({ kind: 'error', error: { message: 'fetch failed', code: 'ECONNRESET' } }, 2),
    ]
    const verdict = classifySession(events, OPTS)
    expect(verdict).toMatchObject({ action: 'continue', cause: 'error', detail: 'fetch failed' })
  })

  it('error 且 includeError=false → skip error-excluded（账目里看得出是开关挡的）', () => {
    const events = [turnEnd({ kind: 'error', error: { message: 'x' } }, 2)]
    const verdict = classifySession(events, { ...OPTS, includeError: false })
    expect(verdict).toMatchObject({ action: 'skip', cause: 'error-excluded' })
  })

  it('aborted/disposed 且 includeDisposed → continue disposed', () => {
    const events = [turnEnd({ kind: 'aborted', reason: { kind: 'disposed' } }, 2)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'continue', cause: 'disposed' })
  })

  it('aborted/disposed 且 includeDisposed=false → skip disposed-excluded（账目里看得出是开关挡的）', () => {
    const events = [turnEnd({ kind: 'aborted', reason: { kind: 'disposed' } }, 2)]
    const verdict = classifySession(events, { ...OPTS, includeDisposed: false })
    expect(verdict).toMatchObject({ action: 'skip', cause: 'disposed-excluded' })
  })

  it('用户停止（aborted/user）即使尾部有排队消息 → skip user-stopped', () => {
    const events = [
      ev('turn/start', 2),
      turnEnd({ kind: 'aborted', reason: { kind: 'user' } }, 2),
      ev('agent/inbox/spliced', 1.5),
    ]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'skip', cause: 'user-stopped' })
  })

  it('aborted/parent 与 aborted/hook → skip cancel-by-parent-or-hook', () => {
    for (const kind of ['parent', 'hook']) {
      const events = [turnEnd({ kind: 'aborted', reason: { kind } }, 2)]
      expect(classifySession(events, OPTS)).toMatchObject({
        action: 'skip',
        cause: 'cancel-by-parent-or-hook',
      })
    }
  })

  it('completed 但尾部有排队消息 → continue queued', () => {
    const events = [
      ev('turn/start', 3),
      turnEnd({ kind: 'completed' }, 2),
      ev('agent/inbox/spliced', 1.5),
    ]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'continue', cause: 'queued' })
  })

  it('completed 且尾部干净 → skip normal-end', () => {
    const events = [ev('turn/start', 2), turnEnd({ kind: 'completed' }, 2)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'skip', cause: 'normal-end' })
  })

  it('max-tokens / blocked / forked 无尾部 → skip normal-end', () => {
    for (const kind of ['max-tokens', 'blocked', 'forked']) {
      const events = [turnEnd({ kind }, 2)]
      expect(classifySession(events, OPTS)).toMatchObject({ action: 'skip', cause: 'normal-end' })
    }
  })

  it('未知结束原因 → 保守 skip normal-end', () => {
    const events = [turnEnd({ kind: 'mystery' }, 2)]
    expect(classifySession(events, OPTS)).toMatchObject({ action: 'skip', cause: 'normal-end' })
  })

  it('verdict 带最后一事件的时间', () => {
    const events = [turnEnd({ kind: 'interrupted' }, 2)]
    expect(classifySession(events, OPTS).lastTime).toBe(NOW - 2 * HOUR)
  })
})
