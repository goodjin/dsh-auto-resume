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
  /** 普通暂时性失败的重试周期：一次重投后把到期时间往后推这么久。 */
  retryIntervalMs: number
  /** 过载类失败：等这么久再重试；0 = 不等（到点立即试）。 */
  overloadRetryDelayMs: number
  /** 过载类失败最多重投几次；到上限就收手（默认 1，等 5 分钟后重试一次）。 */
  overloadMaxRetries: number
}

/** 一轮重试的账目。 */
export interface RetryTickReport {
  /** 会话自己走完了 / 有结局了，从账本里摘掉。 */
  recovered: string[]
  /** 又投了一轮继续消息（含成败）。 */
  retried: Array<{ sessionId: string; ok: boolean; detail?: string; failures: number; attempts: number }>
  /** 连续失败到上限，放弃并标记不再重试。 */
  abandoned: Array<{ sessionId: string; reason: string; attempts: number }>
  /** 这轮没动作的（正在运行、还没到过载等待时间等）。 */
  skipped: Array<{ sessionId: string; detail: string }>
  /** 读不出来的登记（会话没了），一并放弃。 */
  dropped: Array<{ sessionId: string; detail: string }>
  /** 过载类失败：按约定等完、重投到上限后收手的会话（不再进下一轮）。 */
  overloadDone: string[]
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
  const report: RetryTickReport = {
    recovered: [], retried: [], abandoned: [], skipped: [], dropped: [], overloadDone: [],
  }
  for (const entry of Object.values(ledger.active)) {
    // 两个节奏各有开关：普通周期关掉（=0）就别动普通条目；过载重试次数关掉
    // （=0）就别动过载条目。心跳照跑，但「谁到点」也受各自开关约束。
    if (entry.overload !== true && options.retryIntervalMs <= 0) {
      report.skipped.push({ sessionId: entry.sessionId, detail: '普通周期重试已关闭（retryIntervalMs=0）' })
      continue
    }
    if (entry.overload === true && options.overloadMaxRetries <= 0) {
      report.skipped.push({ sessionId: entry.sessionId, detail: '过载重试已关闭（overloadMaxRetries=0）' })
      continue
    }
    // 每个会话按自己账本里的到期时间走：没到点连会话都不观察（省一次冷读）。
    // 老账本条目缺 dueAt 时当「这轮到期」，重投一次后自愈成有 dueAt 的正常条目。
    if (entry.dueAt === undefined) entry.dueAt = options.now
    if (entry.dueAt > options.now) {
      report.skipped.push({
        sessionId: entry.sessionId,
        detail: entry.overload === true
          ? `过载等待中，${String(entry.dueAt - options.now)}ms 后到点`
          : `未到重试周期，${String(entry.dueAt - options.now)}ms 后到点`,
      })
      continue
    }
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
    // 过载类到期：等完这段时间后重投一次；到上限就从账本摘掉（不再进下一轮）。
    // 它不混进普通「连续失败放弃」的账目——收手是约定，不是失败次数耗尽。
    if (entry.overload === true) {
      const used = (entry.overloadAttempts ?? 0) + 1
      const result = await deps.deliver({
        sessionId: entry.sessionId,
        cause: verdict.cause as ContinueCause,
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
        lastTime: verdict.lastTime,
        ...(entry.parentId === undefined ? {} : { parentSessionId: entry.parentId }),
      })
      entry.tailTime = verdict.lastTime
      entry.overloadAttempts = used
      if (used >= options.overloadMaxRetries || !result.ok) {
        // 收手时留一条「不再重试」标记：服务端若持续 529，会话每个轮次又会以
        // 同样失败收尾、被事件监听重新登记，形成 5 分钟一次的无限循环。标记在
        // 会话走出失败状态（正常完成/被停）时由既有逻辑解除，之后照常重新登记。
        abandon(ledger, entry.sessionId, entry,
          `集群负载高，等 ${String(Math.round(options.overloadRetryDelayMs / 60_000))} 分钟后已重试 ${String(used)} 次，不再重试`)
        report.overloadDone.push(entry.sessionId)
      } else {
        // 还没到上限：重置到期时间，等下一个 5 分钟（配置 >1 次时才走到这里）。
        entry.dueAt = options.now + options.overloadRetryDelayMs
      }
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
    // 这次重投完，把到期时间往后推一个周期，等待下一次心跳挑中它。
    entry.dueAt = options.now + options.retryIntervalMs
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
