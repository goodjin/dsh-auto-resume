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
export type SessionObservationLike = { events: SessionEventLike[] } & {
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
 */
export async function scanSessions(
  hosts: ScanHosts,
  options: ClassifyOptions,
  io: ScanIo,
): Promise<ScanLedgerRow[]> {
  let records: SessionRecordLike[]
  try {
    records = await hosts.sessionQuery.listSessions()
  } catch (error) {
    return [skipRowOf('all', `error: 列举会话失败：${messageOf(error)}`)]
  }

  const archived = new Set(hosts.workspaceRegistry.archivedSessionIds)
  const rows: ScanLedgerRow[] = []
  for (const record of records) {
    rows.push(await scanOne(hosts, options, io, record, archived))
  }
  return rows
}

/** 无会话上下文的整场失败账目行（sessionId 占位）。 */
function skipRowOf(sessionId: string, cause: string): ScanLedgerRow {
  return { sessionId, action: 'skip', cause, lastTime: 0 }
}

/** 扫描单个会话：过滤、预筛、判定，失败折成 error 行。 */
async function scanOne(
  hosts: ScanHosts,
  options: ClassifyOptions,
  io: ScanIo,
  record: SessionRecordLike,
  archived: Set<string>,
): Promise<ScanLedgerRow> {
  try {
    const header = record.header
    if (header.origin === 'subagent' || header.parentSession !== undefined) {
      return skipRow(record, 'subagent')
    }
    if (archived.has(header.id)) return skipRow(record, 'archived')
    const live = hosts.agents.get(header.id)
    if (live?.status === 'running') return skipRow(record, 'running')

    // mtime 预筛：日志文件早于窗口起点就直接跳过，不整读。
    const mtime = await mtimeOf(hosts, header.id, io)
    if (mtime !== undefined && options.now - mtime > options.lookbackHours * 3_600_000) {
      return skipRow(record, 'outside-window')
    }

    const observation = await hosts.sessionQuery.observeSession(header.id)
    try {
      return ledgerRow(record, classifySession(observation.events, options))
    } finally {
      observation[Symbol.dispose]?.()
    }
  } catch (error) {
    return { ...skipRow(record, `error: ${messageOf(error)}`), lastTime: 0 }
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
