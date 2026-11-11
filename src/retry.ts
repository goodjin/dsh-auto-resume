/**
 * 重试周期：每过一段时间，把账本里「暂时性失败」的会话再看一眼、该重投的投一次。
 *
 * 每个登记会话的走向（按日志尾部判定，而不是按投递成败）：
 * - 正在运行 → 不算失败也不重投（上一轮的恢复还在跑）；
 * - 会话自己走完了 / 被用户停了 → 从账本里摘掉（任务有结局了）；
 * - 仍在同一处失败 → 记一次连续失败，凑满上限就放弃并标记不再重试；没到上限
 *   就再投一次继续消息；
 * - 被再次中断（应用又退出）→ 不算失败，更新尾部时间、照常再投。
 *
 * @module @goodjin2/dsh-auto-resume/retry
 */

import { classifySession, type ClassifyOptions, type ContinueCause, type SessionEventLike } from './classify.ts'
import type { DeliveryResult, DeliveryTarget } from './deliver.ts'
import type { RetryActiveEntry, RetryLedger } from './retry-ledger.ts'

/** 重试周期需要的宿主面（测试立桩照这个来）。 */
export interface RetrySessionDeps {
  /**
   * 看一眼一个会话：事件流 + 是否正在运行。
   * 读不出来时 `ok: false`（会话没了/坏了，登记作废）。
   * `dispose` 由周期负责调用（观察租约用完得还）。
   */
  observe(sessionId: string): Promise<{
    ok: boolean
    events?: readonly SessionEventLike[]
    running?: boolean
    detail?: string
    dispose?: () => void
  }>
  /** 投递一条继续消息（普通会话走 prompt，子会话走子代理正门）。 */
  deliver(target: DeliveryTarget): Promise<DeliveryResult>
}

/** 重试周期的选项。 */
export interface RetryTickOptions extends ClassifyOptions {
  /** 连续失败到这个数就放弃。 */
  maxRetries: number
}

/** 一轮重试的账目。 */
export interface RetryTickReport {
  /** 会话自己走完了 / 有结局了，从账本里摘掉。 */
  recovered: string[]
  /** 又投了一轮继续消息（含成败）。 */
  retried: Array<{ sessionId: string; ok: boolean; detail?: string; failures: number; attempts: number }>
  /** 连续失败到上限，放弃并标记不再重试。 */
  abandoned: Array<{ sessionId: string; reason: string; attempts: number }>
  /** 这轮没动作的（正在运行等）。 */
  skipped: Array<{ sessionId: string; detail: string }>
  /** 读不出来的登记（会话没了），一并放弃。 */
  dropped: Array<{ sessionId: string; detail: string }>
}

/**
 * 跑一轮重试：逐个登记会话看走向、该投的投、该放弃的放弃。
 * 账本原地改（摘掉的条目直接删除），放弃条目由调用方落盘。
 */
export async function runRetryTick(
  ledger: RetryLedger,
  deps: RetrySessionDeps,
  options: RetryTickOptions,
): Promise<RetryTickReport> {
  const report: RetryTickReport = { recovered: [], retried: [], abandoned: [], skipped: [], dropped: [] }
  for (const entry of Object.values(ledger.active)) {
    const observed = await deps.observe(entry.sessionId).catch((error: unknown) => ({
      ok: false as const,
      detail: error instanceof Error ? error.message : String(error),
    }))
    if (!observed.ok || observed.events === undefined) {
      const detail = observed.ok ? '会话没有事件' : (observed.detail ?? '会话读不出来')
      abandon(ledger, entry.sessionId, entry, `会话读不出来：${detail}`)
      report.dropped.push({ sessionId: entry.sessionId, detail })
      continue
    }
    try {
    if (observed.running) {
      report.skipped.push({ sessionId: entry.sessionId, detail: '正在运行' })
      continue
    }
    const events = observed.events
    const verdict = classifySession(events, options)
    if (verdict.action === 'skip') {
      // 会话有了结局（正常完成 / 用户停过 / 被排除）——不再是失败状态。
      abandon(ledger, entry.sessionId, entry, `会话已不再失败（${verdict.cause}）`)
      report.recovered.push(entry.sessionId)
      continue
    }
    // 仍在失败（或又被中断）：连续失败只对「error」收尾计数，被再次打断的不算。
    if (verdict.cause === 'error') entry.failures += 1
    entry.tailTime = verdict.lastTime
    if (verdict.cause === 'error' && entry.failures >= options.maxRetries) {
      const reason = `连续 ${entry.failures} 个周期仍在失败（${entry.detail ?? '运行中出错'}），不再重试`
      abandon(ledger, entry.sessionId, entry, reason)
      report.abandoned.push({ sessionId: entry.sessionId, reason, attempts: entry.attempts })
      continue
    }
    entry.attempts += 1
    const result = await deps.deliver({
      sessionId: entry.sessionId,
      cause: verdict.cause as ContinueCause,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
      lastTime: verdict.lastTime,
      ...(entry.parentId === undefined ? {} : { parentSessionId: entry.parentId }),
    })
    report.retried.push({
      sessionId: entry.sessionId,
      ok: result.ok,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      failures: entry.failures,
      attempts: entry.attempts,
    })
    } finally {
      observed.dispose?.()
    }
  }
  return report
}

/** 把一条登记从活跃区挪进放弃区（原因与人话理由写进账目）。 */
function abandon(ledger: RetryLedger, sessionId: string, entry: RetryActiveEntry, reason: string): void {
  delete ledger.active[sessionId]
  ledger.abandoned[sessionId] = {
    sessionId,
    tailTime: entry.tailTime,
    abandonedAt: Date.now(),
    attempts: entry.attempts,
    reason,
  }
}
