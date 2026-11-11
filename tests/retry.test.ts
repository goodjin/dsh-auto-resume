import { describe, expect, it } from 'vitest'

import type { SessionEventLike } from '../src/classify.ts'
import { emptyLedger } from '../src/retry-ledger.ts'
import { runRetryTick, type RetrySessionDeps } from '../src/retry.ts'

const NOW = new Date('2026-11-11T10:00:00').getTime()
const HOUR = 3_600_000
const OPTIONS = { now: NOW, lookbackHours: 24, includeError: true, includeDisposed: true, maxRetries: 3 }

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
