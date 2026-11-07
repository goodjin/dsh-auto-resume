/**
 * 全量会话扫描编排：枚举 → 过滤 → 预筛 → 判定 → 账目行。
 *
 * 每个会话独立成账：任何一个读取失败只记一行 error 跳过，不拦其余会话。
 * 顺序三层过滤都在读事件之前完成（子代理、已归档、运行中），mtime 预筛
 * 借 `sessionPersistence.stat` 拿日志路径再读文件时间——早于窗口起点的旧
 * 会话直接跳过，免整读大日志。
 *
 * @module @goodjin2/dsh-auto-resume/scan
 */

import { classifySession, type ClassifyOptions, type SessionEventLike, type Verdict } from './classify.ts'
import { catalogChildren, childNeedsResume, hasLocalSession, type PendingChild } from './children.ts'
import type { RecentCandidate } from './recent.ts'

/** 扫描需要的最小宿主服务面（测试立桩照这个来）。 */
export interface ScanHosts {
  sessionQuery: {
    listSessions(): Promise<SessionRecordLike[]>
    observeSession(id: string): Promise<SessionObservationLike>
  }
  agents: { get(id: string): { status?: string } | undefined }
  workspaceRegistry: { archivedSessionIds: readonly string[] }
  /** 缺席时跳过 mtime 预筛（功能不缺，只慢一点）。 */
  sessionPersistence?: { stat(id: string): Promise<StatLike | undefined> }
}

/** listSessions 返回的最小记录面。 */
export interface SessionRecordLike {
  header: {
    id: string
    cwd?: string
    origin?: string
    parentSession?: string
  }
}

/** observeSession 返回的最小观察面；可释放时由扫描负责释放。 */
export type SessionObservationLike = {
  events: SessionEventLike[]
  /**
   * 观察租约带回来的会话头。fs 直查通道枚举不到元数据，只有头这一处能认出
   * 子代理会话（`origin` / `parentSession`）——认不出就会白投一次、
   * 宿主回「owned by subagent routing」。
   */
  header?: { origin?: string; parentSession?: string }
} & {
  [Symbol.dispose]?: () => void
}

/** stat 返回里扫描只认日志路径。 */
export interface StatLike {
  location?: { path?: string }
}

/** 预筛的文件时间通道（生产实现读 mtimeMs，测试立桩给定值）。 */
export interface ScanIo {
  statMtime(path: string): Promise<number | undefined>
}

/** 一个会话的一行账目：继续（候选）或跳过（带原因）。 */
export interface ScanLedgerRow {
  sessionId: string
  cwd?: string
  action: 'continue' | 'skip'
  cause: string
  detail?: string
  lastTime: number
  /** 待恢复的子会话（cause 为 `awaiting-child` 时有值）。 */
  children?: PendingChild[]
}

/** 从判定结果折出账目行。 */
function ledgerRow(record: SessionRecordLike, verdict: Verdict): ScanLedgerRow {
  const base: ScanLedgerRow = {
    sessionId: record.header.id,
    ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
    action: verdict.action,
    cause: verdict.cause,
    lastTime: verdict.lastTime,
  }
  return verdict.action === 'continue' && verdict.detail !== undefined
    ? { ...base, detail: verdict.detail }
    : base
}

/** 有一行 skip 账目的小工具。 */
function skipRow(record: SessionRecordLike, cause: string): ScanLedgerRow {
  return { sessionId: record.header.id, action: 'skip', cause, lastTime: 0 }
}

/**
 * 扫描全部会话，返回账目行（`action === 'continue'` 的行即投递候选）。
 * 单会话与整场枚举的失败都折成 error 账目行，不外抛。
 *
 * 成本护栏（2026-11-07 现场：全量 observeSession 把宿主堆读爆）：先按 mtime
 * 过滤并降序排，只对最近 `maxObservations` 个做整读；mtime 拿不到的会话直接
 * 跳过（fail closed）——中断必然发生在最近，旧会话不读也不漏。
 */
export async function scanSessions(
  hosts: ScanHosts,
  options: ClassifyOptions & { maxObservations: number; maxChildObservations: number },
  io: ScanIo,
  progress?: (scanned: number, total: number) => void,
  recent?: RecentEnumeration,
): Promise<ScanLedgerRow[]> {
  // 快速通道优先：fs 直查候选，不碰宿主逐会话枚举与 stat（有挂死先例）。
  if (recent !== undefined) return scanViaRecent(hosts, options, recent, progress)
  let records: SessionRecordLike[]
  try {
    records = await hosts.sessionQuery.listSessions()
  } catch (error) {
    return [skipRowOf('all', `error: 列举会话失败：${messageOf(error)}`)]
  }
  progress?.(0, records.length)

  const archived = new Set(hosts.workspaceRegistry.archivedSessionIds)
  const rows: ScanLedgerRow[] = []
  const recentCandidates: Array<{ record: SessionRecordLike; mtime: number }> = []
  let scanned = 0
  for (const record of records) {
    const head = await headRow(hosts, options, io, record, archived)
    scanned += 1
    // mtime 有效 = 进入整读候选（行由 observeRow 出）；否则 head.row 就是最终账目。
    if (head.mtime !== undefined) recentCandidates.push({ record, mtime: head.mtime })
    else rows.push(head.row)
    if (scanned % 200 === 0) progress?.(scanned, records.length)
  }
  progress?.(scanned, records.length)
  recentCandidates.sort((a, b) => b.mtime - a.mtime)
  const budget = { left: options.maxChildObservations }
  for (const { record } of recentCandidates.slice(0, Math.max(options.maxObservations, 0))) {
    const row = await judgeCandidate(hosts, record.header.id, options, budget)
    rows.push({
      ...row,
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
    })
  }
  return rows
}

/** 无会话上下文的整场失败账目行（sessionId 占位）。 */
function skipRowOf(sessionId: string, cause: string): ScanLedgerRow {
  return { sessionId, action: 'skip', cause, lastTime: 0 }
}

/** 头部过滤的结果：要么是 skip 账目行（不进整读），要么带 mtime 进队列。 */
type HeadResult = { row: ScanLedgerRow; mtime: number | undefined }

/** 头部过滤：子代理/归档/运行中直接跳过；mtime 预筛决定是否值得整读。 */
async function headRow(
  hosts: ScanHosts,
  options: ClassifyOptions,
  io: ScanIo,
  record: SessionRecordLike,
  archived: Set<string>,
): Promise<HeadResult> {
  try {
    const header = record.header
    if (header.origin === 'subagent' || header.parentSession !== undefined) {
      return { row: skipRow(record, 'subagent'), mtime: undefined }
    }
    if (archived.has(header.id)) return { row: skipRow(record, 'archived'), mtime: undefined }
    const live = hosts.agents.get(header.id)
    if (live?.status === 'running') return { row: skipRow(record, 'running'), mtime: undefined }

    // mtime 预筛：早于窗口起点跳过；**拿不到时间也跳过**（fail closed）——
    // 2026-11-07 现场：预筛缺席时全量 observeSession 数千会话，把宿主堆读爆。
    // 中断必然发生在最近，mtime 不可知的旧会话不读也不漏。
    const mtime = await mtimeOf(hosts, header.id, io)
    if (mtime === undefined) return { row: skipRow(record, 'mtime-unknown'), mtime: undefined }
    if (options.now - mtime > options.lookbackHours * 3_600_000) {
      return { row: skipRow(record, 'outside-window'), mtime: undefined }
    }
    return { row: skipRow(record, 'pending-observation'), mtime }
  } catch (error) {
    return { row: { ...skipRow(record, `error: ${messageOf(error)}`), lastTime: 0 }, mtime: undefined }
  }
}

/** 经 stat 拿日志路径再读文件时间；任一环缺席都回 undefined（不预筛）。 */
async function mtimeOf(hosts: ScanHosts, sessionId: string, io: ScanIo): Promise<number | undefined> {
  const stat = (await hosts.sessionPersistence?.stat(sessionId))?.location?.path
  if (stat === undefined) return undefined
  return io.statMtime(stat)
}

/** 错误的一句话形式。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** fs 直查通道给出的候选：会话 id + 日志 mtime（实现在 recent.ts）。 */
export type { RecentCandidate }

/**
 * 最近候选枚举通道：按 mtime 降序返回窗口内最近的至多 `maxObservations` 个。
 *
 * 为什么要有它：宿主 `sessionPersistence.stat(id)` 对个别会话会永久挂起
 * （2026-11-07 现场：两次启动都精确卡在第 8000 个会话，CPU 200%+ 烧到 OOM）。
 * 纯 fs 枚举 + 直路径 stat 不经过宿主逐会话逻辑，微秒级且不可能挂。
 */
export interface RecentEnumeration {
  listRecent(lookbackHours: number, maxObservations: number, now: number): Promise<RecentCandidate[]>
}

/** 单个观察的硬超时：宿主 observeSession 对损坏日志也可能不返回。 */
const OBSERVE_TIMEOUT_MS = 15_000

/** 只有 sessionId 可用时的账目行（fs 通道没有 header，cwd 缺席）。 */
function ledgerRowOfId(sessionId: string, verdict: Verdict): ScanLedgerRow {
  return {
    sessionId,
    action: verdict.action,
    cause: verdict.cause,
    lastTime: verdict.lastTime,
    ...(verdict.action === 'continue' && verdict.detail !== undefined ? { detail: verdict.detail } : {}),
  }
}

/** 会话头是否表明它是子代理会话（子会话归父会话路由管，不单独继续）。 */
function isSubagentHeader(header: { origin?: string; parentSession?: string } | undefined): boolean {
  if (header === undefined) return false
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/** 带硬超时的观察：超时折成 error 账目行，不拖死整场扫描。 */
async function observeRowTimed(
  hosts: ScanHosts,
  sessionId: string,
  options: ClassifyOptions,
): Promise<ScanLedgerRow> {
  const observed = await observeTimed(hosts, sessionId)
  if (!observed.ok) {
    return { sessionId, action: 'skip', cause: `error: ${observed.detail}`, lastTime: 0 }
  }
  try {
    // 子代理会话归父会话路由管：观察租约带头，头里认得出就当场跳过，
    // 免得投一次被宿主回「owned by subagent routing」。
    if (isSubagentHeader(observed.observation.header)) {
      return { sessionId, action: 'skip', cause: 'subagent', lastTime: 0 }
    }
    return ledgerRowOfId(sessionId, classifySession(observed.observation.events, options))
  } finally {
    observed.observation[Symbol.dispose]?.()
  }
}

/** 一次带硬超时的观察结果（失败带一句摘要）。 */
type TimedObservation =
  | { ok: true; observation: SessionObservationLike }
  | { ok: false; detail: string }

/** 带硬超时的观察：拿不到就折成失败摘要，不抛。 */
async function observeTimed(hosts: ScanHosts, sessionId: string): Promise<TimedObservation> {
  try {
    const observation = await Promise.race([
      hosts.sessionQuery.observeSession(sessionId),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`observeSession 超时（${OBSERVE_TIMEOUT_MS}ms）`)), OBSERVE_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
    return { ok: true, observation }
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  }
}

/**
 * 判定一个候选会话，并回答「主会话是不是在等一个被中断的子会话」。
 *
 * 主会话自己异常收尾 → 照旧续它；
 * 主会话正常收尾（模型结束轮次去等子代理）→ 看它的子代理目录：若某个子会话
 * 自己也是异常收尾且没交过结算，那这就是「等子会话」的形态 → 主会话也要叫醒，
 * 并把那些子会话一并恢复（cause: awaiting-child）。
 */
async function judgeCandidate(
  hosts: ScanHosts,
  sessionId: string,
  options: ClassifyOptions & { maxChildObservations: number },
  budget: { left: number },
): Promise<ScanLedgerRow> {
  const observed = await observeTimed(hosts, sessionId)
  if (!observed.ok) {
    return { sessionId, action: 'skip', cause: `error: ${observed.detail}`, lastTime: 0 }
  }
  try {
    if (isSubagentHeader(observed.observation.header)) {
      return { sessionId, action: 'skip', cause: 'subagent', lastTime: 0 }
    }
    const events = observed.observation.events
    const verdict = classifySession(events, options)
    if (verdict.action === 'continue' || verdict.cause !== 'normal-end') {
      return ledgerRowOfId(sessionId, verdict)
    }
    const pending = await pendingChildren(hosts, events, options, budget)
    if (pending.length === 0) return ledgerRowOfId(sessionId, verdict)
    return {
      sessionId,
      action: 'continue',
      cause: 'awaiting-child',
      lastTime: verdict.lastTime,
      children: pending,
    }
  } finally {
    observed.observation[Symbol.dispose]?.()
  }
}

/**
 * 找出父会话下「被中断、值得恢复」的子会话。
 * 子会话的日志说了算：轮次还开着（宿主冷读补 `interrupted`）或异常收尾 → 续。
 */
async function pendingChildren(
  hosts: ScanHosts,
  parentEvents: readonly SessionEventLike[],
  options: ClassifyOptions,
  budget: { left: number },
): Promise<PendingChild[]> {
  const pending: PendingChild[] = []
  for (const child of catalogChildren(parentEvents)) {
    if (budget.left <= 0) break
    if (!hasLocalSession(child)) continue
    budget.left -= 1
    const observed = await observeTimed(hosts, child.childId)
    if (!observed.ok) continue
    try {
      const verdict = childNeedsResume(observed.observation.events, options)
      if (verdict.needs && verdict.cause !== undefined) {
        pending.push({ childId: child.childId, cause: verdict.cause })
      }
    } finally {
      observed.observation[Symbol.dispose]?.()
    }
  }
  return pending
}

/** 快速通道：fs 直查候选 → 运行中/归档过滤 → 带超时观察判定。 */
async function scanViaRecent(
  hosts: ScanHosts,
  options: ClassifyOptions & { maxObservations: number; maxChildObservations: number },
  recent: RecentEnumeration,
  progress?: (scanned: number, total: number) => void,
): Promise<ScanLedgerRow[]> {
  const candidates = await recent.listRecent(options.lookbackHours, options.maxObservations, options.now)
  progress?.(0, candidates.length)
  const archived = new Set(hosts.workspaceRegistry.archivedSessionIds)
  const rows: ScanLedgerRow[] = []
  const budget = { left: options.maxChildObservations }
  let scanned = 0
  for (const candidate of candidates) {
    scanned += 1
    const live = hosts.agents.get(candidate.sessionId)
    if (live?.status === 'running') {
      rows.push({ sessionId: candidate.sessionId, action: 'skip', cause: 'running', lastTime: 0 })
      progress?.(scanned, candidates.length)
      continue
    }
    if (archived.has(candidate.sessionId)) {
      rows.push({ sessionId: candidate.sessionId, action: 'skip', cause: 'archived', lastTime: 0 })
      progress?.(scanned, candidates.length)
      continue
    }
    rows.push(await judgeCandidate(hosts, candidate.sessionId, options, budget))
    progress?.(scanned, candidates.length)
  }
  return rows
}
