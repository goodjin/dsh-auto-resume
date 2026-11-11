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
