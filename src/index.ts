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
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, type ResolvedConfig } from './config.ts'
import type { ContinueCause } from './classify.ts'
import { scanSessions, type RecentCandidate, type RecentEnumeration, type ScanHosts, type ScanLedgerRow } from './scan.ts'
import { deliverContinuations, type DeliveryResult, type DeliverIo, type PromptHost } from './deliver.ts'
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
}

/** 最近一次启动扫描的快照（进程内，随装载生命周期）。 */
let latestSnapshot: ScanSnapshot | null = null

/**
 * 装载入口：挂账目路由；enabled 时排一次启动扫描。
 */
export function apply(ctx: PluginContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  latestSnapshot = { enabled: config.enabled, startedAt: null, finishedAt: null, scanned: 0, total: 0, config, rows: [], deliveries: [] }

  ctx.inject?.(['webServer'], (child) => {
    registerHealthRoute(child as HealthRouteContext, () => latestSnapshot)
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
    }))
  const deliverIo: DeliverIo = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    uuid: () => randomUUID(),
  }
  const deliveries = await deliverContinuations(
    targets,
    ctx.sessionController,
    config.messageTemplate,
    config.staggerMs,
    deliverIo,
  )

  snapshot.rows = rows
  snapshot.deliveries = deliveries
  snapshot.finishedAt = Date.now()
  console.info(summarize(snapshot))
}

/** 日志路径 → mtime 毫秒；文件消失等错误折成 undefined（该会话照常整读）。 */
async function statMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/** 会话库根目录：$DSH_HOME/sessions，缺省 ~/.dsh/sessions。 */
function sessionsRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * fs 直查最近候选：两轮 readdir + 每会话一次直路径 stat，不经过宿主
 * 逐会话服务（`sessionPersistence.stat` 有挂死先例，2026-11-07 现场）。
 * 会话目录名即会话 id（带或不带 `session-` 前缀，宿主按名解析）。
 */
async function listRecentFs(lookbackHours: number, maxObservations: number, now: number): Promise<RecentCandidate[]> {
  const root = sessionsRoot()
  const windowStart = now - lookbackHours * 3_600_000
  const out: RecentCandidate[] = []
  let workspaces: Dirent[]
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(root, workspace.name)
    let sessionDirs: Dirent[]
    try {
      sessionDirs = await readdir(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      let mtime: number
      try {
        mtime = (await stat(join(workspacePath, sessionDir.name, 'session.v4.jsonl.zstd'))).mtimeMs
      } catch {
        continue
      }
      if (mtime < windowStart) continue
      out.push({ sessionId: sessionDir.name, mtime })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, Math.max(maxObservations, 0))
}

/** 最近候选通道：宿主提供 `sessionRecent` 时用它，否则退回本机 fs 直查。 */
function recentChannelOf(ctx: PluginContext): RecentEnumeration {
  const hostProvided = optionalService(ctx, 'sessionRecent') as RecentEnumeration | undefined
  return hostProvided ?? { listRecent: listRecentFs }
}

/**
 * 组装扫描需要的宿主面。
 *
 * 可选服务（`sessionPersistence`，只影响预筛效率）必须走 `ctx.get` 现取：
 * cordis 上下文上读一个未注入的属性会当场抛错（可选链救不了「读属性」这一步），
 * `get` 才是缺席回 undefined 的安全口。取不到就让预筛缺席，功能不缺。
 */
function hostsOf(ctx: PluginContext): ScanHosts {
  const hosts: ScanHosts = {
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    workspaceRegistry: ctx.workspaceRegistry,
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
  return [
    `auto-resume:`,
    `scanned=${snapshot.rows.length}`,
    `candidates=${snapshot.deliveries.length}`,
    `delivered=${delivered}/${snapshot.deliveries.length}`,
    `continued=[${continued}]`,
    `skips=${JSON.stringify(skips)}`,
  ].join(' ')
}
