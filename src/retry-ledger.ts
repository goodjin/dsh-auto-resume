/**
 * 重试账本：登记「暂时性失败（网络 / 限速 / 超时）、值得按周期重试」的会话，
 * 以及重试到底后放弃的会话（不再重试）。
 *
 * 落盘成 JSON（`<DSH_HOME>/auto-resume/retry-ledger.json`）：重启后启动扫描
 * 还能认得「已放弃、别再碰」的会话，也认得「还在重试周期里」的会话。
 *
 * 放弃标记会自然过期：会话后来有了新动静（日志尾部时间晚于放弃时的尾部），
 * 说明它往前走了，标记作废，该登记还登记。
 *
 * @module @goodjin2/dsh-auto-resume/retry-ledger
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isOverloadErrorDetail } from './classify.ts'

/** 按失败类型生成一条活跃登记的输入。 */
export interface MakeActiveRetryEntryInput {
  sessionId: string
  /** 失败摘要；据此判定是不是「服务暂时不可用」类（5xx / 集群负载 / 网络错误等）。 */
  detail?: string
  /** 登记时刻（epoch ms）。 */
  now: number
  /** 同一会话已有的登记（重复失败时保留到期时间与已试次数，不往后推）。 */
  existing?: RetryActiveEntry | undefined
  /** 子会话的父会话 id。 */
  parentId?: string | undefined
  /** 「服务暂时不可用」类等待时长（默认由配置传入）。 */
  overloadRetryDelayMs: number
  /** 普通暂时性失败的全局周期（保留参数以便将来统一到期模型）。 */
  retryIntervalMs: number
}

/**
 * 生成一条活跃登记：按每个会话自己的「下次到期时间」驱动周期重试。
 *
 * - 普通暂时性失败：`dueAt = now + retryIntervalMs`，沿用 10 分钟一次的节奏；
 * - 「服务暂时不可用」类（529/集群负载、500 等 5xx、api_error、中文网络错误、
 *   「请稍后重试」）：`overload` 打标、`dueAt = now + overloadRetryDelayMs`，
 *   等 5 分钟后只重试一次就收手。
 *
 * 所有条目都带 `dueAt`，周期心跳就只需一个短间隔，到没到点由账本说了算（重启也不丢）。
 * 纯函数，两个登记入口（会话事件广播、启动扫描）共用，避免两边判定漂移。
 */
export function makeActiveRetryEntry(input: MakeActiveRetryEntryInput): RetryActiveEntry {
  const { sessionId, detail, now, existing, parentId, overloadRetryDelayMs, retryIntervalMs } = input
  const overload = isOverloadErrorDetail(detail)
  const base: RetryActiveEntry = {
    sessionId,
    ...(detail === undefined ? {} : { detail }),
    tailTime: now,
    attempts: existing?.attempts ?? 0,
    failures: existing?.failures ?? 0,
    registeredAt: existing?.registeredAt ?? now,
    ...(parentId === undefined ? {} : { parentId }),
    // 老账本里没有 dueAt 的条目：缺字段就当「这轮到期」，重投后自愈成有 dueAt。
    dueAt: existing?.dueAt ?? now + (overload ? overloadRetryDelayMs : retryIntervalMs),
  }
  if (!overload) return base
  // 重复登记同一「服务暂时不可用」会话：已在等待/已试过的不重置到期与计数，否则服务每次
  // 继续报同类错误都会把「等 5 分钟」无限往后推，永远等不到重投。
  return {
    ...base,
    overload: true,
    overloadAttempts: existing?.overloadAttempts ?? 0,
  }
}

/** 一条还在重试周期里的登记。 */
export interface RetryActiveEntry {
  sessionId: string
  /** 会话自己的失败原因（人话，随账本一起给出来）。 */
  detail?: string
  /** 登记时（或最近一次重试时）的日志尾部时间：判断会话有没有往前走。 */
  tailTime: number
  /** 已经投递过几次（含启动那次）。 */
  attempts: number
  /** 连续多少个周期仍在同一处失败。 */
  failures: number
  registeredAt: number
  /** 子会话时有值：投递走子代理路由的正门。 */
  parentId?: string
  /**
   * 「服务暂时不可用」类失败的单列节奏标记（内部沿用 overload 字段名，兼容旧账本）。
   * 服务端明确说「负载高 / 网络错误 / 请稍后重试」或回 5xx，说明这会儿处理不了：
   * 按 `dueAt` 等一段时间，只重试 `overloadMaxRetries` 次就收手。
   * 老账本里没有这些字段的条目一律当普通暂时性失败（兼容旧数据）。
   */
  overload?: boolean
  /** 这类条目的下次到期时间（epoch ms）；没到点周期不碰它。 */
  dueAt?: number
  /** 这类条目已经等完并重投过几次。 */
  overloadAttempts?: number
}

/** 一条已放弃的登记（连续失败到上限，不再重试）。 */
export interface RetryAbandonedEntry {
  sessionId: string
  /** 放弃时的日志尾部时间：会话往前走了就说明标记过期。 */
  tailTime: number
  abandonedAt: number
  attempts: number
  reason: string
}

/** 重试账本。 */
export interface RetryLedger {
  active: Record<string, RetryActiveEntry>
  abandoned: Record<string, RetryAbandonedEntry>
}

/** 空账本。 */
export function emptyLedger(): RetryLedger {
  return { active: {}, abandoned: {} }
}

/** 插件自己的数据目录：`<DSH_HOME>/auto-resume`，缺省 `~/.dsh/auto-resume`。 */
export function pluginDataDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'auto-resume')
}

/** 重试账本文件路径。 */
export function retryLedgerPath(dataDir: string = pluginDataDir()): string {
  return join(dataDir, 'retry-ledger.json')
}

/** 读账本：文件缺失或读不动回空账本（账本坏了不该带崩扫描）。 */
export function loadRetryLedger(path: string): RetryLedger {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RetryLedger>
    return {
      active: raw.active && typeof raw.active === 'object' ? raw.active : {},
      abandoned: raw.abandoned && typeof raw.abandoned === 'object' ? raw.abandoned : {},
    }
  } catch {
    return emptyLedger()
  }
}

/** 写账本（目录不存在就建；写失败向上抛——账本写不进去，重试周期就是空转）。 */
export function saveRetryLedger(path: string, ledger: RetryLedger): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

/**
 * 放弃标记在这里是否仍然作数：标记在案，且会话的日志尾部没有晚于放弃时的尾部
 * ——会话后来往前走了，标记就过期了。
 */
export function isAbandonedHere(
  ledger: RetryLedger,
  sessionId: string,
  lastEventTime: number,
): RetryAbandonedEntry | undefined {
  const entry = ledger.abandoned[sessionId]
  if (entry === undefined) return undefined
  return lastEventTime > entry.tailTime ? undefined : entry
}
