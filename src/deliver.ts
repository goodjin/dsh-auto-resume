/**
 * 投递：把继续消息逐个发给候选会话。
 *
 * 走 `sessionController.prompt`（与界面发送同一条路）：会话自动 resume、
 * 宿主崩溃恢复自动补中断收尾，模型带着完整历史接着跑。一次只投一个，
 * 相邻目标隔 `staggerMs`，避免多个会话同时开跑；单点失败只折进该目标的
 * 结果（`ok: false` + 一句摘要），不拦其余投递。
 *
 * @module @goodjin2/dsh-auto-resume/deliver
 */

import { DEFAULT_CHILD_MESSAGE_TEMPLATE, renderMessage } from './config.ts'
import type { ContinueCause } from './classify.ts'
import type { PendingChild } from './children.ts'

/** 一个待投递目标（来自扫描账目里的 continue 行）。 */
export interface DeliveryTarget {
  sessionId: string
  cause: ContinueCause
  detail?: string
  lastTime: number
  /** 待恢复的子会话（cause 为 `awaiting-child` 时有值）。 */
  children?: PendingChild[]
}

/**
 * 子会话恢复需要的宿主面。
 *
 * 子会话归子代理路由管，通用会话投递一律被宿主拒绝；正门是子代理服务上的
 * 「人写的提示」入口：父 agent 在线时把提示排进子会话的收件箱，子会话不在
 * 内存里就按它的日志冷恢复。
 */
export interface ChildResumeHost {
  /** 活的父 agent（不在则无法授权投递）。 */
  parentAgent(sessionId: string): unknown
  /** 把一条人写的提示排进子会话。 */
  queueChildPrompt(parent: unknown, childId: string, content: string, signal: AbortSignal): Promise<unknown>
}

/** 投递需要的最小 prompt 面（宿主 Remote 方法的形状：request + signal）。 */
export interface PromptHost {
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'followup'
      content: Array<{ type: 'text'; text: string }>
    },
    signal: AbortSignal,
  ): Promise<unknown>
}

/** 可注入的副作用通道：等待与标识（测试立桩照这个来）。 */
export interface DeliverIo {
  sleep(ms: number): Promise<void>
  uuid(): string
}

/** 一个目标的投递结果。 */
export interface DeliveryResult {
  sessionId: string
  ok: boolean
  detail?: string
  /** 子会话恢复结果（cause 为 `awaiting-child` 时有值）。 */
  children?: Array<{ childId: string; ok: boolean; detail?: string }>
}

/** 继续原因 → 消息里的人话措辞。 */
function reasonWording(cause: ContinueCause, detail: string | undefined): string {
  switch (cause) {
    case 'interrupted':
      return '应用退出或进程中断'
    case 'queued':
      return '排队消息未投递'
    case 'disposed':
      return '桌面版退出时被中断'
    case 'error':
      return detail === undefined ? '运行中出错' : `运行中出错（${detail}）`
    case 'awaiting-child':
      return '等待中的子会话被中断'
  }
}

/** 本地时区的 `YYYY-MM-DD HH:mm`（手写格式化，双位补零）。 */
function formatLocalTime(ms: number): string {
  const time = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * 顺序投递全部目标，返回逐个结果。目标之间 sleep `staggerMs`
 * （最后一个之后不 sleep，也不因空目标而 sleep）。
 *
 * `childResume` 缺席时只投父会话；给了就顺手把被中断的子会话也恢复（父会话
 * 先投：父 agent 上线后才有资格往子会话投递）。
 */
export async function deliverContinuations(
  targets: readonly DeliveryTarget[],
  promptHost: PromptHost,
  template: string,
  staggerMs: number,
  io: DeliverIo,
  childResume?: ChildResumeHost,
  childTemplate?: string,
  maxChildResumes?: number,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = []
  let first = true
  let childBudget = maxChildResumes ?? Number.POSITIVE_INFINITY
  for (const item of targets) {
    if (!first && staggerMs > 0) await io.sleep(staggerMs)
    first = false
    const result = await deliverOne(item, promptHost, template, io)
    if (childResume !== undefined && result.ok && item.children !== undefined && item.children.length > 0) {
      result.children = await resumeChildren(item, childResume, childTemplate ?? DEFAULT_CHILD_MESSAGE_TEMPLATE, childBudget)
      childBudget -= result.children.length
    }
    results.push(result)
  }
  return results
}

/** 单次投递的准入时限：prompt 准入（恢复会话 + 补中断收尾）应当秒级完成，120 秒是兜底。 */
const PROMPT_ADMISSION_TIMEOUT_MS = 120_000

/**
 * 投递单个目标；prompt 抛错折成 ok:false 摘要。
 * 第二个参数是宿主 Remote 方法的 AbortSignal（临时实例实测：缺了它宿主
 * 第一行 `signal.throwIfAborted()` 就 TypeError）；限时防准入挂死整条节流链。
 */
async function deliverOne(
  item: DeliveryTarget,
  promptHost: PromptHost,
  template: string,
  io: DeliverIo,
): Promise<DeliveryResult> {
  const message = parentMessage(item, template)
  try {
    await promptHost.prompt(
      {
        requestId: io.uuid(),
        sessionId: item.sessionId,
        mode: 'followup',
        content: [{ type: 'text', text: message }],
      },
      AbortSignal.timeout(PROMPT_ADMISSION_TIMEOUT_MS),
    )
    return { sessionId: item.sessionId, ok: true }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { sessionId: item.sessionId, ok: false, detail: text }
  }
}

/**
 * 父会话的继续消息：模板渲染 + 子会话附注。
 * 附注要点名哪些子会话正在被拉起来，免得模型以为没人管、重新委派一遍同样的活。
 */
function parentMessage(item: DeliveryTarget, template: string): string {
  const base = renderMessage(
    template,
    reasonWording(item.cause, item.detail),
    formatLocalTime(item.lastTime),
  )
  if (item.children === undefined || item.children.length === 0) return base
  const ids = item.children.map((child) => child.childId).join('、')
  return `${base}\n${CHILD_HINT.split('{children}').join(ids)}`
}

/** 父会话消息里的子会话附注。 */
export const CHILD_HINT =
  '另外，子会话 {children} 在你上次退出时也被中断，我正在让它们从中断处继续；请不要重复委派同样的活，等它们的结果即可。'

/** 单次子会话投递的时限（子会话冷恢复要重放历史，秒级到十几秒都可能）。 */
const CHILD_DELIVERY_TIMEOUT_MS = 120_000

/**
 * 恢复被中断的子会话。
 *
 * 顺序是硬约束：父 agent 必须先上线——子会话跑完的结算通知只送给**在线的**
 * 直接父级（宿主没有持久化父级信箱），父级不在的话通知会被直接丢掉。
 */
async function resumeChildren(
  item: DeliveryTarget,
  childResume: ChildResumeHost,
  template: string,
  budget: number,
): Promise<Array<{ childId: string; ok: boolean; detail?: string }>> {
  const results: Array<{ childId: string; ok: boolean; detail?: string }> = []
  const parent = childResume.parentAgent(item.sessionId)
  if (parent === undefined) {
    return (item.children ?? []).slice(0, Math.max(budget, 0)).map((child) => ({
      childId: child.childId,
      ok: false,
      detail: '父会话未上线，无法授权投递到子会话',
    }))
  }
  for (const child of item.children ?? []) {
    if (budget <= 0) break
    budget -= 1
    const content = renderMessage(
      template,
      reasonWording(child.cause as ContinueCause, undefined),
      formatLocalTime(item.lastTime),
    ).split('{parent}').join(item.sessionId)
    try {
      await childResume.queueChildPrompt(
        parent,
        child.childId,
        content,
        AbortSignal.timeout(CHILD_DELIVERY_TIMEOUT_MS),
      )
      results.push({ childId: child.childId, ok: true })
    } catch (error) {
      results.push({
        childId: child.childId,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
