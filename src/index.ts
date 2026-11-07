/**
 * 入口：桌面版启动后扫描全部会话，自动继续异常中断的。
 *
 * 装载即排期：等 `startupDelayMs`（默认 8 秒，让启动稳定下来）后跑一次
 * `scanSessions`，把账目里的 continue 行逐个 `sessionController.prompt`
 * 投递（与界面发送同一条路），打一行统计并把完整快照挂给
 * `/auto-resume/health`。只在启动时跑这一次；运行中断开等下次启动。
 *
 * 必需服务走 `inject`（缺席行装载失败，fail loud）；webServer 机会式取用。
 *
 * @module @goodjin2/dsh-auto-resume
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { resolveConfig, type ResolvedConfig } from './config.ts'
import type { ContinueCause } from './classify.ts'
import { scanSessions, type RecentEnumeration, type ScanHosts, type ScanLedgerRow } from './scan.ts'
import { listRecentByFs, sessionsRoot } from './recent.ts'
import { deliverContinuations, type ChildResumeHost, type DeliveryResult, type DeliverIo, type PromptHost } from './deliver.ts'
import { registerHealthRoute, type HealthRouteContext } from './route.ts'

export { Config } from './config.ts'

/** 宿主侧服务名（cordis loader 用）。 */
export const name = 'auto-resume'

/** 必需的宿主服务：缺席即本行装载失败（fail loud，不留静默残废）。 */
export const inject = ['sessionQuery', 'agents', 'workspaceRegistry', 'sessionController']

/** 插件 apply 需要的宿主上下文面（注入服务 + effect + 机会式 get/inject）。 */
interface PluginContext extends ScanHosts, HealthRouteContext {
  sessionController: PromptHost
  get?(serviceName: string): unknown
  inject?(deps: string[], body: (child: unknown) => void): unknown
}

/** 一次启动扫描的完整快照（路由账目就存这个）。 */
export interface ScanSnapshot {
  enabled: boolean
  startedAt: number | null
  finishedAt: number | null
  /** 头部过滤已处理的会话数（实时递增，观察扫描卡段的探针）。 */
  scanned: number
  /** 需要枚举的会话总数（listSessions 返回后填上）。 */
  total: number
  config: ResolvedConfig
  rows: ScanLedgerRow[]
  deliveries: DeliveryResult[]
  /** 子会话恢复的自报状态：服务在不在、恢复了谁。 */
  children: ChildReport
}

/** 子会话恢复的账目（路由自报用）。 */
export interface ChildReport {
  /** 子代理服务是否可用（不可用时只能续父会话）。 */
  serviceAvailable: boolean
  /** 判定阶段认定「被中断、值得恢复」的子会话数。 */
  pending: number
  /** 实际投递结果。 */
  resumed: Array<{ parentId: string; childId: string; ok: boolean; detail?: string }>
}

/** 最近一次启动扫描的快照（进程内，随装载生命周期）。 */
let latestSnapshot: ScanSnapshot | null = null

/**
 * 子代理服务（`ctx.subagents`）：子会话恢复的正门。
 * 走 `ctx.inject` 机会式取用——服务在场才启用子会话恢复，缺席就只续父会话。
 */
let subagentsService: SubagentsService | null = null

/** 子代理服务需要的最小面（测试立桩照这个来）。 */
interface SubagentsService {
  queuePrompt(
    parent: unknown,
    childId: string,
    content: Array<{ type: 'text'; text: string }>,
    source: { kind: string; rpcId: string },
    signal: AbortSignal,
  ): Promise<unknown>
}

/**
 * 装载入口：挂账目路由；enabled 时排一次启动扫描。
 */
export function apply(ctx: PluginContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  latestSnapshot = {
    enabled: config.enabled,
    startedAt: null,
    finishedAt: null,
    scanned: 0,
    total: 0,
    config,
    rows: [],
    deliveries: [],
    children: { serviceAvailable: false, pending: 0, resumed: [] },
  }

  ctx.inject?.(['webServer'], (child) => {
    registerHealthRoute(child as HealthRouteContext, () => latestSnapshot)
  })

  // 子代理服务：缺席就不做子会话恢复（父会话照旧续）。
  // 两条取法都留着：服务已在场时 `ctx.get` 直接拿到（宿主自己的代码也这么取），
  // 晚到时 `ctx.inject` 的回调补上。
  const present = optionalService(ctx, 'subagents')
  if (isSubagentsService(present)) subagentsService = present
  ctx.inject?.(['subagents'], (child) => {
    const service = (child as { subagents?: unknown }).subagents
    if (isSubagentsService(service)) subagentsService = service
  })

  if (!config.enabled) return

  // 排期与插件 fiber 同生命周期：行卸载时清掉还没到点的定时器。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      runOnce(ctx, config).catch((error: unknown) => {
        console.error('auto-resume: 启动扫描失败', error)
      })
    }, config.startupDelayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'auto-resume: 启动扫描排期')
}

/** 跑一次扫描 + 投递 + 记账 + 打一行统计。 */
async function runOnce(ctx: PluginContext, config: ResolvedConfig): Promise<void> {
  const snapshot = latestSnapshot
  if (snapshot === null) return
  snapshot.startedAt = Date.now()

  const rows = await scanSessions(
    hostsOf(ctx),
    {
      now: snapshot.startedAt,
      lookbackHours: config.lookbackHours,
      includeError: config.includeError,
      includeDisposed: config.includeDisposed,
      maxObservations: config.maxObservations,
      maxChildObservations: config.resumeChildren ? config.maxChildObservations : 0,
    },
    { statMtime: statMtimeMs },
    (scanned, total) => {
      snapshot.scanned = scanned
      snapshot.total = total
    },
    recentChannelOf(ctx),
  )
  const targets = rows
    .filter((row) => row.action === 'continue')
    .map((row) => ({
      sessionId: row.sessionId,
      cause: row.cause as ContinueCause,
      ...(row.detail === undefined ? {} : { detail: row.detail }),
      lastTime: row.lastTime,
      ...(row.children === undefined ? {} : { children: row.children }),
    }))
  const deliverIo: DeliverIo = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uuid: () => randomUUID(),
  }
  const childResume = childResumeHostOf(ctx, deliverIo)
  const deliveries = await deliverContinuations(
    targets,
    ctx.sessionController,
    config.messageTemplate,
    config.staggerMs,
    deliverIo,
    config.resumeChildren ? childResume : undefined,
    config.childMessageTemplate,
    config.maxChildResumes,
  )

  snapshot.rows = rows
  snapshot.deliveries = deliveries
  snapshot.children = {
    serviceAvailable: subagentsService !== null,
    pending: rows.reduce((sum, row) => sum + (row.children?.length ?? 0), 0),
    resumed: deliveries.flatMap((delivery) =>
      (delivery.children ?? []).map((child) => ({
        parentId: delivery.sessionId,
        childId: child.childId,
        ok: child.ok,
        ...(child.detail === undefined ? {} : { detail: child.detail }),
      })),
    ),
  }
  snapshot.finishedAt = Date.now()
  console.info(summarize(snapshot))
}

/**
 * 子会话恢复通道：父 agent 在线时，经子代理服务把提示排进子会话。
 * 服务缺席时回 undefined——只续父会话，不做子会话恢复。
 */
function childResumeHostOf(ctx: PluginContext, io: DeliverIo): ChildResumeHost | undefined {
  if (subagentsService === null) return undefined
  const service = subagentsService
  return {
    parentAgent: (sessionId: string) => ctx.agents.get(sessionId),
    queueChildPrompt: async (parent, childId, content, signal) =>
      service.queuePrompt(
        parent,
        childId,
        [{ type: 'text', text: content }],
        { kind: 'user', rpcId: io.uuid() },
        signal,
      ),
  }
}

/** 子代理服务形状检查：认得 queuePrompt 才算可用。 */
function isSubagentsService(service: unknown): service is SubagentsService {
  return (
    typeof service === 'object' &&
    service !== null &&
    typeof (service as { queuePrompt?: unknown }).queuePrompt === 'function'
  )
}

/** 日志路径 → mtime 毫秒；文件消失等错误折成 undefined（该会话照常整读）。 */
async function statMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * 最近候选通道：宿主提供 `sessionRecent` 时用它，否则退回本机 fs 直查。
 *
 * fs 直查的实现与理由见 recent.ts（两轮 readdir + 每会话一次直路径 stat，
 * 不经过宿主逐会话枚举与 stat——那条路 2026-11-07 现场把启动扫描拖成
 * 十几分钟，预筛缺席时还会把宿主内存读爆）。
 */
function recentChannelOf(ctx: PluginContext): RecentEnumeration {
  const hostProvided = optionalService(ctx, 'sessionRecent') as RecentEnumeration | undefined
  if (hostProvided !== undefined) return hostProvided
  return {
    listRecent: (lookbackHours, maxObservations, now) =>
      listRecentByFs({ root: sessionsRoot(), lookbackHours, maxObservations, now }),
  }
}

/**
 * 组装扫描需要的宿主面。
 *
 * 可选服务（`sessionPersistence`，只影响预筛效率）必须走 `ctx.get` 现取：
 * cordis 上下文上读一个未注入的属性会当场抛错（可选链救不了「读属性」这一步），
 * `get` 才是缺席回 undefined 的安全口。取不到就让预筛缺席，功能不缺。
 */
function hostsOf(ctx: PluginContext): ScanHosts {
  // 归档清单双保险：宿主 registry 之外并上 workspace.json 的持久归档清单
  // （权威持久层），两边任一记录到都按归档跳过。文件缺失/损坏回空集不拦扫描。
  const fileArchived = archivedIdsFromFile()
  const registry: ScanHosts['workspaceRegistry'] = fileArchived.size === 0
    ? ctx.workspaceRegistry
    : {
        archivedSessionIds: Array.from(new Set([
          ...ctx.workspaceRegistry.archivedSessionIds,
          ...fileArchived,
        ])),
      }
  const hosts: ScanHosts = {
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    workspaceRegistry: registry,
  }
  const persistence = optionalService(ctx, 'sessionPersistence')
  if (persistence !== undefined) {
    hosts.sessionPersistence = persistence as NonNullable<ScanHosts['sessionPersistence']>
  }
  return hosts
}

/** 按名字安全取一个可能缺席的服务：没有 get 或取时抛错都算缺席。 */
function optionalService(ctx: PluginContext, serviceName: string): unknown {
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/** 一行统计：扫描数、命中数、投递结果、继续了谁、跳过分布。 */
function summarize(snapshot: ScanSnapshot): string {
  const continued = snapshot.deliveries
    .map((delivery) => {
      const row = snapshot.rows.find((item) => item.sessionId === delivery.sessionId)
      const cause = row?.cause ?? '?'
      return `${delivery.sessionId}(${cause}${delivery.ok ? '' : ':失败'})`
    })
    .join(', ')
  const skips: Record<string, number> = {}
  for (const row of snapshot.rows) {
    if (row.action !== 'skip') continue
    skips[row.cause] = (skips[row.cause] ?? 0) + 1
  }
  const delivered = snapshot.deliveries.filter((delivery) => delivery.ok).length
  const childRows = snapshot.children.resumed
  const childOk = childRows.filter((child) => child.ok).length
  return [
    `auto-resume:`,
    `scanned=${snapshot.rows.length}`,
    `candidates=${snapshot.deliveries.length}`,
    `delivered=${delivered}/${snapshot.deliveries.length}`,
    `continued=[${continued}]`,
    `skips=${JSON.stringify(skips)}`,
    `children=service:${snapshot.children.serviceAvailable ? 'present' : 'absent'}`,
    `pending=${snapshot.children.pending}`,
    `resumed=${childOk}/${childRows.length}`,
    `childIds=[${childRows.map((child) => `${child.childId}${child.ok ? '' : ':失败'}`).join(',')}]`,
  ].join(' ')
}

/**
 * 归档清单双保险：直接读 workspace.json 的 `global.archivedSessionIds`
 * （权威持久层），与宿主 registry 取并集。文件缺失/损坏回空集，
 * 不影响宿主 registry 这条主通道。
 */
function archivedIdsFromFile(): Set<string> {
  try {
    const workspaceJson = join(dirname(sessionsRoot()), 'storages', 'workspace.json')
    const raw = JSON.parse(readFileSync(workspaceJson, 'utf8')) as {
      global?: { archivedSessionIds?: unknown }
    }
    const ids = raw.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}
