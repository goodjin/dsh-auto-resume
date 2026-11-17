import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  emptyLedger,
  isAbandonedHere,
  loadRetryLedger,
  makeActiveRetryEntry,
  pluginDataDir,
  retryLedgerPath,
  saveRetryLedger,
} from '../src/retry-ledger.ts'

const NOW = new Date('2026-11-11T10:00:00').getTime()

describe('账本落盘', () => {
  it('写进去再读出来，条目原样', () => {
    const dir = join(tmpdir(), `auto-resume-ledger-${Math.random().toString(36).slice(2)}`)
    const path = join(dir, 'retry-ledger.json')
    const ledger = emptyLedger()
    ledger.active['s1'] = { sessionId: 's1', tailTime: NOW, attempts: 2, failures: 1, registeredAt: NOW - HOUR_BACK }
    saveRetryLedger(path, ledger)
    const loaded = loadRetryLedger(path)
    expect(loaded.active['s1']).toMatchObject({ sessionId: 's1', tailTime: NOW, attempts: 2, failures: 1 })
  })

  it('文件缺失或损坏 → 空账本，不抛', () => {
    expect(loadRetryLedger('/tmp/definitely-not-here-ledger/x.json')).toEqual(emptyLedger())
    expect(loadRetryLedger('/tmp')).toEqual(emptyLedger())
  })
})

const HOUR_BACK = 3_600_000

describe('isAbandonedHere：放弃标记是否仍然作数', () => {
  const ledger = (() => {
    const l = emptyLedger()
    l.abandoned['given-up'] = { sessionId: 'given-up', tailTime: NOW - HOUR_BACK, abandonedAt: NOW, attempts: 3, reason: '连续失败' }
    return l
  })()

  it('放弃后日志没动静 → 标记作数，不再重试', () => {
    expect(isAbandonedHere(ledger, 'given-up', NOW - HOUR_BACK)?.reason).toBe('连续失败')
    expect(isAbandonedHere(ledger, 'given-up', NOW - 2 * HOUR_BACK)?.reason).toBe('连续失败')
  })

  it('会话后来往前走了 → 标记过期，该登记还登记', () => {
    expect(isAbandonedHere(ledger, 'given-up', NOW)).toBeUndefined()
  })

  it('没放弃过的会话 → 不受影响', () => {
    expect(isAbandonedHere(ledger, 'other', NOW - HOUR_BACK)).toBeUndefined()
  })
})

describe('makeActiveRetryEntry：按失败类型生成登记条目', () => {
  const opts = { overloadRetryDelayMs: 300_000, retryIntervalMs: 600_000 }

  it('普通暂时性失败 → 普通条目（dueAt = now + 10 分钟周期，无 overload）', () => {
    const entry = makeActiveRetryEntry({
      sessionId: 's1', detail: 'fetch failed [QUOTA_EXCEEDED]', now: NOW, existing: undefined, ...opts,
    })
    expect(entry.overload).toBeUndefined()
    expect(entry.dueAt).toBe(NOW + 600_000)
    expect(entry).toMatchObject({ sessionId: 's1', attempts: 0, failures: 0, registeredAt: NOW })
  })

  it('529 集群负载高 → 打上 overload 标记，dueAt = now + 5 分钟', () => {
    const detail = 'MiniMax request failed (529): 当前服务集群负载较高，请稍后重试'
    const entry = makeActiveRetryEntry({ sessionId: 'busy', detail, now: NOW, existing: undefined, ...opts })
    expect(entry.overload).toBe(true)
    expect(entry.dueAt).toBe(NOW + 300_000)
    expect(entry.overloadAttempts).toBe(0)
  })

  it('重复登记同一过载会话 → 不重置到期时间与已试次数（避免一直被往后推）', () => {
    const detail = '当前服务集群负载较高，请稍后重试'
    const existing = makeActiveRetryEntry({ sessionId: 'busy', detail, now: NOW - 60_000, existing: undefined, ...opts })
    existing.overloadAttempts = 1
    const again = makeActiveRetryEntry({ sessionId: 'busy', detail, now: NOW, existing, ...opts })
    expect(again.dueAt).toBe(NOW - 60_000 + 300_000)
    expect(again.overloadAttempts).toBe(1)
    expect(again.registeredAt).toBe(NOW - 60_000)
  })

  it('保留 parentId 与 detail', () => {
    const entry = makeActiveRetryEntry({
      sessionId: 'c', detail: 'overloaded_error (529)', now: NOW, existing: undefined, parentId: 'p', ...opts,
    })
    expect(entry.parentId).toBe('p')
    expect(entry.detail).toBe('overloaded_error (529)')
  })
})

describe('路径约定', () => {
  it('账本在 <DSH_HOME>/auto-resume 下；DSH_HOME 覆盖生效', () => {
    const original = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(retryLedgerPath().endsWith('/.dsh/auto-resume/retry-ledger.json')).toBe(true)
      process.env.DSH_HOME = '/tmp/dsh-home'
      expect(retryLedgerPath()).toBe('/tmp/dsh-home/auto-resume/retry-ledger.json')
      expect(pluginDataDir()).toBe('/tmp/dsh-home/auto-resume')
    } finally {
      if (original === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = original
    }
  })
})
