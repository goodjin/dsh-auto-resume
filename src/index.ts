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
import { errorDetail, isTransientErrorDetail, type SessionEventLike } from './classify.ts'
import { loadRetryLedger, makeActiveRetryEntry, saveRetryLedger, retryLedgerPath, type RetryLedger } from './retry-ledger.ts'
import { runRetryTick, type RetrySessionDeps, type RetryTickReport } from './retry.ts'
import { deliverContinuations, type ChildResumeHost, type DeliveryResult, type DeliveryTarget, type DeliverIo, type PromptHost } from './deliver.ts'
import { registerHealthRoute, type HealthRouteContext } from './route.ts'

export { Config } from './config.ts'

/** 宿主侧服务名（cordis loader 用）。 */
export const name = 'auto-resume'

/** 必需的宿主服务：缺席即本行装载失败（fail loud，不留静默残废）。 */
export const inject = ['sessionQuery', 'agents', 'workspaceRegistry', 'sessionController']

/**
 * 周期心跳：每隔这么久看一眼账本，按每个条目自己的 `dueAt` 决定谁到点。
 * 不用「一个全局 setInterval(retryIntervalMs)」了——过载类要精确到 5 分钟、
 * 普通类要 10 分钟，两个节奏只能由账本里的到期时间表达，心跳只负责勤快地看。
 * 60 秒的粒度对「等 5 分钟」足够（最多晚 1 分钟），代价是每分钟一次空转检查。
 */
const RETRY_HEARTBEAT_MS = 60_000

/** 周期重试是否启用：普通节奏或过载节奏任一开着就算启用。 */
function retryEnabled(config: ResolvedConfig): boolean {
  return config.retryIntervalMs > 0 || config.overloadRetryDelayMs > 0
}

/** 插件 apply 需要的宿主上下文面（注入服务 + effect + 机会式 get/inject）。 */
interface PluginContext extends ScanHosts, HealthRouteContext {
  sessionController: PromptHost
  get?(serviceName: string): unknown
  inject?(deps: string[], body: (child: unknown) => void): unknown
  /** 宿主广播的会话事件（轮次收尾等），用于「中止当下就登记」。 */
  on?(eventName: string, listener: (subject: unknown, event: unknown) => void): unknown
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
  /** 暂时性失败会话的周期重试账目。 */
  retries: RetryReport
}

/** 健康路由里一条「还在周期里」的会话账目。 */
export interface ActiveRetryRow {
  sessionId: string
  attempts: number
  failures: number
  parentId?: string
  /** 过载类（529 集群负载高）标记；在等 5 分钟时会带 dueAt。 */
  overload?: boolean
  dueAt?: number
  overloadAttempts?: number
}

/** 周期重试的账目（路由自报用）。 */
export interface RetryReport {
  /** 账本文件路径（读不出来时为空，等于没有周期重试）。 */
  ledgerPath: string | null
  /** 还在重试周期里的会话。 */
  active: ActiveRetryRow[]
  /** 已放弃、不再重试的会话。 */
  abandoned: Array<{ sessionId: string; reason: string; attempts: number }>
  /** 最近一轮重试的动作。 */
  lastTick: RetryTickReport | null
  /** 启动扫描时因为「已放弃」被跳过的会话。 */
  abandonedSkipped: Array<{ sessionId: string; reason: string }>
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

/** 重试账本（进程内一份，落盘在 <DSH_HOME>/auto-resume/retry-ledger.json）。 */
let retryLedger: RetryLedger | null = null
let retryLedgerPathValue: string | null = null
/** 重试周期是否正在跑（防止上一轮没跑完又起一轮）。 */
let retryTickRunning = false

/**
 * 子代理服务需要的最小面（测试立桩照这个来）。
 *
 * 两个宿主版本的口子不同：
 * - 新版（dsh 0.2.2+）有 `queuePrompt`：把一条**人写的**提示排进子会话收件箱；
 * - 旧版（0.2.1）只有 `sendMessage`：模型/宿主写的消息，子会话不在内存里时同样
 *   按它的日志冷恢复。
 * 两者对「被中断的子会话」都成立：新口子更贴语义（人写的），旧口子兜底。
 */
interface SubagentsService {
  queuePrompt?: (
    parent: unknown,
    childId: string,
    content: Array<{ type: 'text'; text: string }>,
    source: { kind: string; rpcId: string },
    signal: AbortSignal,
  ) => Promise<unknown>
  sendMessage?: (
    sender: unknown,
    targetId: string,
    content: Array<{ type: 'text'; text: string }>,
    options: { signal: AbortSignal },
  ) => Promise<unknown>
}

/**
 * 装载入口：挂账目路由；enabled 时排一次启动扫描。
 */
export function apply(ctx: PluginContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const snapshot: ScanSnapshot = {
    enabled: config.enabled,
    startedAt: null,
    finishedAt: null,
    scanned: 0,
    total: 0,
    config,
    rows: [],
    deliveries: [],
    children: { serviceAvailable: false, pending: 0, resumed: [] },
    retries: { ledgerPath: null, active: [], abandoned: [], lastTick: null, abandonedSkipped: [] },
  }
  latestSnapshot = snapshot

  ctx.inject?.(['webServer'], (child) => {
    registerHealthRoute(child as HealthRouteContext, () => latestSnapshot)
  })

  // 子代理服务：缺席就不做子会话恢复（父会话照旧续）。
  // 两条取法都留着：服务已在场时 `ctx.get` 直接拿到（宿主自己的代码也这么取），
  // 晚到时 `ctx.inject` 的回调补上。
  subagentsService = null
  const present = optionalService(ctx, 'subagents')
  if (isSubagentsService(present)) subagentsService = present
  ctx.inject?.(['subagents'], (child) => {
    const service = (child as { subagents?: unknown }).subagents
    if (isSubagentsService(service)) subagentsService = service
  })

  if (!config.enabled) return

  // 重试账本：装载即读（放弃标记要拦启动扫描，账本得先到位）。
  retryLedgerPathValue = retryLedgerPath()
  retryLedger = loadRetryLedger(retryLedgerPathValue)
  snapshot.retries.ledgerPath = retryLedgerPathValue
  snapshot.retries.abandoned = ledgerAbandonedList()

  // 中止当下就登记：宿主广播会话事件，轮次以「暂时性失败」收尾的当场进账本，
  // 不用等下一次启动扫描。整条回调就地兜底（宿主把没人接的异常当致命错误）。
  ctx.on?.('session/event', (session: unknown, event: unknown) => {
    try {
      if (retryLedger === null || !retryEnabled(config)) return
      const record = event as
        | { type?: string; time?: number; data?: { reason?: { kind?: string; error?: unknown } } }
        | undefined
      if (record?.type !== 'turn/end') return
      const sessionId = sessionOf(session)
      if (sessionId === undefined) return
      const kind = record.data?.reason?.kind
      if (kind !== 'error') {
        // 会话走出了失败状态：放弃标记的使命完成，摘掉（下次再失败照常登记）。
        if (retryLedger.abandoned[sessionId] !== undefined) {
          delete retryLedger.abandoned[sessionId]
          saveRetryLedger(retryLedgerPathValue ?? retryLedgerPath(), retryLedger)
          snapshot.retries.abandoned = ledgerAbandonedList()
          console.info(`auto-resume: 会话 ${sessionId} 已走出失败状态，解除「不再重试」标记`)
        }
        return
      }
      const detail = errorDetail(record.data?.reason?.error)
      if (!isTransientErrorDetail(detail)) return
      // 已放弃的会话不复活：连续失败到上限的标记要 hold 住
      if (retryLedger.abandoned[sessionId] !== undefined) return
      const existing = retryLedger.active[sessionId]
      const parentId = sessionParentIdOf(session)
      const now = record.time ?? Date.now()
      retryLedger.active[sessionId] = makeActiveRetryEntry({
        sessionId,
        ...(detail === undefined ? {} : { detail }),
        now,
        ...(existing === undefined ? {} : { existing }),
        ...(parentId === undefined ? {} : { parentId }),
        overloadRetryDelayMs: config.overloadRetryDelayMs,
        retryIntervalMs: config.retryIntervalMs,
      })
      saveRetryLedger(retryLedgerPathValue ?? retryLedgerPath(), retryLedger)
      snapshot.retries.active = ledgerActiveList()
      const overload = retryLedger.active[sessionId]?.overload === true
      console.info(
        `auto-resume: 已登记暂时性失败会话 ${sessionId}${parentId === undefined ? '' : `（父 ${parentId}）`}，`
        + (overload ? `集群负载高，等 ${String(Math.round(config.overloadRetryDelayMs / 60_000))} 分钟后重试一次` : '周期里会再试'),
      )
    } catch (error) {
      console.error('auto-resume: 会话事件登记失败', error)
    }
  })
  latestSnapshot.retries.ledgerPath = retryLedgerPathValue
  latestSnapshot.retries.abandoned = Object.entries(retryLedger.abandoned).map(([sessionId, entry]) => ({
    sessionId,
    reason: entry.reason,
    attempts: entry.attempts,
  }))

  // 排期与插件 fiber 同生命周期：行卸载时清掉还没到点的定时器。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      runOnce(ctx, config).catch((error: unknown) => {
        console.error('auto-resume: 启动扫描失败', error)
      })
    }, config.startupDelayMs)
    timer.unref?.()

    // 周期重试：心跳按固定短间隔看账本，每个条目自己的 `dueAt` 说了算——
    // 普通暂时性失败 10 分钟一轮，「集群负载高 / 529」类 5 分钟后重试一次。
    // 整个回调就地兜底——宿主把没人接的异常当致命错误，一条漏网的就能把整个进程带崩。
    let interval: NodeJS.Timeout | undefined
    if (retryEnabled(config)) {
      interval = setInterval(() => {
        if (retryTickRunning) return
        retryTickRunning = true
        runRetryCycle(ctx, config)
          .catch((error: unknown) => {
            console.error('auto-resume: 周期重试失败', error)
          })
          .finally(() => {
            retryTickRunning = false
          })
      }, RETRY_HEARTBEAT_MS)
      interval.unref?.()
    }
    return () => {
      clearTimeout(timer)
      if (interval !== undefined) clearInterval(interval)
    }
  }, 'auto-resume: 启动扫描与重试排期')
}

/** 带硬超时的观察（周期重试用）；租约由调用方释放。 */
async function observeSessionTimed(
  ctx: PluginContext,
  sessionId: string,
): Promise<
  | { ok: true; observation: { events: SessionEventLike[]; [Symbol.dispose]?: () => void } }
  | { ok: false; detail: string }
> {
  try {
    const observation = await Promise.race([
      ctx.sessionQuery.observeSession(sessionId),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('observeSession 超时（15000ms）')), 15_000)
        timer.unref?.()
      }),
    ])
    return { ok: true, observation }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 跑一轮周期重试：看走向、该投的投、该放弃的放弃，账本落盘、快照更新。 */
async function runRetryCycle(ctx: PluginContext, config: ResolvedConfig): Promise<void> {
  const snapshot = latestSnapshot
  const ledger = retryLedger
  if (snapshot === null || ledger === null) return

  const now = Date.now()
  const report = await runRetryTick(
    ledger,
    {
      observe: async (sessionId: string) => {
        const running = hostsOf(ctx).agents.get(sessionId)?.status === 'running'
        const observed = await observeSessionTimed(ctx, sessionId)
        if (!observed.ok) return { ok: false as const, detail: observed.detail }
        const dispose = observed.observation[Symbol.dispose]
        return {
          ok: true as const,
          events: observed.observation.events,
          running,
          ...(dispose === undefined ? {} : { dispose }),
        }
      },
      deliver: async (target: DeliveryTarget) => {
        const [result] = await deliverContinuations(
          [target],
          ctx.sessionController,
          config.messageTemplate,
          0,
          { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), uuid: () => randomUUID() },
          childResumeHostOf(ctx, {
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            uuid: () => randomUUID(),
          }),
          config.childMessageTemplate,
        )
        return (
          result ?? { sessionId: target.sessionId, ok: false, detail: '投递通道没有返回结果' }
        )
      },
    },
    {
      now,
      lookbackHours: config.lookbackHours,
      includeError: config.includeError,
      includeDisposed: config.includeDisposed,
      maxRetries: config.maxRetries,
      retryIntervalMs: config.retryIntervalMs,
      overloadRetryDelayMs: config.overloadRetryDelayMs,
      overloadMaxRetries: config.overloadMaxRetries,
    },
  )
  const didSomething =
    report.recovered.length > 0 || report.retried.length > 0 || report.abandoned.length > 0
    || report.dropped.length > 0 || report.overloadDone.length > 0
  if (didSomething) saveRetryLedger(retryLedgerPathValue ?? retryLedgerPath(), ledger)
  snapshot.retries.lastTick = report
  snapshot.retries.active = ledgerActiveList()
  snapshot.retries.abandoned = Object.entries(ledger.abandoned).map(([sessionId, entry]) => ({
    sessionId,
    reason: entry.reason,
    attempts: entry.attempts,
  }))
  console.info(
    `auto-resume: 重试周期 recovered=${report.recovered.length} retried=${report.retried.length} abandoned=${report.abandoned.length} skipped=${report.skipped.length} dropped=${report.dropped.length} active=${Object.keys(ledger.active).length}`,
  )
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
      ...(retryLedger === null
        ? {}
        : {
            abandoned: new Map(Object.entries(retryLedger.abandoned)),
            // 过期的放弃标记顺手删掉并落盘：会话有新动静就说明该重新登记了。
            clearAbandoned: (sessionId: string) => {
              if (retryLedger === null) return
              delete retryLedger.abandoned[sessionId]
              saveRetryLedger(retryLedgerPathValue ?? retryLedgerPath(), retryLedger)
              snapshot.retries.abandoned = ledgerAbandonedList()
            },
          }),
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
      ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
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

  // 暂时性失败（网络 / 限速 / 超时）的会话登记进重试账本：周期到点再投，
  // 连续失败到上限就放弃并标记不再重试。已放弃的会话不会走到这里（扫描层已拦）。
  if (retryLedger !== null && retryEnabled(config)) {
    const delivered = new Map(deliveries.map((delivery) => [delivery.sessionId, delivery]))
    let ledgerDirty = false
    for (const row of rows) {
      if (row.action !== 'continue' || row.cause !== 'error') continue
      if (!isTransientErrorDetail(row.detail)) continue
      const entry = retryLedger.active[row.sessionId]
      const outcome = delivered.get(row.sessionId)
      if (outcome !== undefined && !outcome.ok) {
        // 这次投递本身没送进去：不登记周期重试，账目里留着失败原因。
        continue
      }
      retryLedger.active[row.sessionId] = {
        ...makeActiveRetryEntry({
          sessionId: row.sessionId,
          ...(row.detail === undefined ? {} : { detail: row.detail }),
          // 过载类的等待从「本次扫描/登记」起算，不用会话上次的失败时间（可能几小时前）。
          now: snapshot.startedAt ?? row.lastTime,
          ...(entry === undefined ? {} : { existing: entry }),
          ...(row.parentSessionId === undefined ? {} : { parentId: row.parentSessionId }),
          overloadRetryDelayMs: config.overloadRetryDelayMs,
          retryIntervalMs: config.retryIntervalMs,
        }),
        // 尾部时间始终是会话自己的最后事件时间（放弃标记按它判断会话有没有往前走）。
        tailTime: row.lastTime,
        // 启动扫描这次已经投递过继续消息：算一次（与旧账目一致）。
        // 过载类的「等 5 分钟后重试一次」是额外的一次，不计入 overloadAttempts。
        attempts: (entry?.attempts ?? 0) + 1,
      }
      ledgerDirty = true
    }
    // 没变化就不落盘（每次启动都写一遍，等于把账本当成日志用）。
    if (ledgerDirty) {
      saveRetryLedger(retryLedgerPathValue ?? retryLedgerPath(), retryLedger)
      snapshot.retries.active = ledgerActiveList()
    }
  }

  const childIds = new Set(rows.filter((row) => row.parentSessionId !== undefined).map((row) => row.sessionId))
  snapshot.children = {
    serviceAvailable: subagentsService !== null,
    pending: childIds.size,
    resumed: deliveries
      .filter((delivery) => childIds.has(delivery.sessionId))
      .map((delivery) => {
        const target = targets.find((item) => item.sessionId === delivery.sessionId)
        return {
          parentId: target?.parentSessionId ?? '',
          childId: delivery.sessionId,
          ok: delivery.ok,
          ...(delivery.detail === undefined ? {} : { detail: delivery.detail }),
        }
      }),
  }
  snapshot.finishedAt = Date.now()
  console.info(summarize(snapshot))
}

/** 从会话事件广播的会话对象里取 id（形状不对回 undefined）。 */
function sessionOf(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 子会话的父会话 id（顶层会话回 undefined）。 */
function sessionParentIdOf(session: unknown): string | undefined {
  const parentId = (session as { header?: { parentSession?: unknown } } | undefined)?.header?.parentSession
  return typeof parentId === 'string' && parentId !== '' ? parentId : undefined
}

/** 账本放弃区 → 快照里的账目。 */
function ledgerAbandonedList(): Array<{ sessionId: string; reason: string; attempts: number }> {
  if (retryLedger === null) return []
  return Object.entries(retryLedger.abandoned).map(([sessionId, entry]) => ({
    sessionId,
    reason: entry.reason,
    attempts: entry.attempts,
  }))
}

/** 账本活跃区 → 快照里的账目（含过载等待信息，健康路由能看见在等 5 分钟的会话）。 */
function ledgerActiveList(): ActiveRetryRow[] {
  if (retryLedger === null) return []
  return Object.values(retryLedger.active).map((entry) => ({
    sessionId: entry.sessionId,
    attempts: entry.attempts,
    failures: entry.failures,
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    ...(entry.overload === true ? { overload: true } : {}),
    ...(entry.dueAt === undefined ? {} : { dueAt: entry.dueAt }),
    ...(entry.overloadAttempts === undefined ? {} : { overloadAttempts: entry.overloadAttempts }),
  }))
}

/**
 * 子会话恢复通道：父 agent 在线时，经子代理服务把提示排进子会话。
 * 服务缺席时回 undefined——只续父会话，不做子会话恢复。
 */
function childResumeHostOf(ctx: PluginContext, io: DeliverIo): ChildResumeHost | undefined {
  if (subagentsService === null) return undefined
  const service = subagentsService
  return {
    // 父会话已在内存里就原样用；不在就把它挂上线（resume 只挂线，不带消息——
    // 主会话没被打扰就不会重做已完成的活）。
    attachParent: async (sessionId: string) => {
      const live = ctx.agents.get(sessionId)
      if (live !== undefined) return live
      const handle = (await ctx.agents.resume?.({ resumeSessionId: sessionId })) as
        | { agent?: unknown }
        | undefined
      return handle?.agent ?? handle
    },
    queueChildPrompt: async (parent, childId, content, signal) => {
      if (typeof service.queuePrompt === 'function') {
        return service.queuePrompt(
          parent,
          childId,
          [{ type: 'text', text: content }],
          { kind: 'user', rpcId: io.uuid() },
          signal,
        )
      }
      // 旧口子的 content 同样是内容块数组（不是纯文本）。
      return service.sendMessage?.(parent, childId, [{ type: 'text', text: content }], { signal })
    },
  }
}

/** 子代理服务形状检查：认得投递口子（queuePrompt / sendMessage 任一）才算可用。 */
function isSubagentsService(service: unknown): service is SubagentsService {
  if (typeof service !== 'object' || service === null) return false
  const candidate = service as { queuePrompt?: unknown; sendMessage?: unknown }
  return typeof candidate.queuePrompt === 'function' || typeof candidate.sendMessage === 'function'
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
    `retries=active:${snapshot.retries.active.length}`,
    `retryActive=[${snapshot.retries.active.map((entry) => `${entry.sessionId}(${entry.attempts}次/失败${entry.failures})`).join(',')}]`,
    `retryAbandoned=${snapshot.retries.abandoned.length}`,
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
