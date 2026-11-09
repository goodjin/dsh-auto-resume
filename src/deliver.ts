/**
 * 投递：把继续消息逐个发给候选会话。
 *
 * 两类目标，两条路：
 * - **普通会话**（自己异常收尾）：走 `sessionController.prompt`（与界面发送同一
 *   条路）：会话自动 resume、宿主崩溃恢复自动补中断收尾，模型带着完整历史接着跑。
 * - **子会话**（主会话正常收尾、子会话被中断）：归子代理路由管，通用 prompt 会被
 *   宿主拒绝（`owned by subagent routing`）。正门是把提示排进子会话的收件箱
 *   （子会话不在内存里就按它的日志冷恢复），前提是父 agent 在线。**主会话只挂线、
 *   不投消息**——它没被打扰就不会重做已完成的活；子会话跑完，宿主会把结算通知
 *   送到在线的父级，父级空闲时被叫起来收尾。
 *
 * 一次只投一个，相邻目标隔 `staggerMs`；单点失败只折进该目标的结果，不拦其余。
 *
 * @module @goodjin2/dsh-auto-resume/deliver
 */

import { DEFAULT_CHILD_MESSAGE_TEMPLATE, renderMessage } from './config.ts'
import type { ContinueCause } from './classify.ts'

/** 一个待投递目标（来自扫描账目里的 continue 行）。 */
export interface DeliveryTarget {
  sessionId: string
  cause: ContinueCause
  detail?: string
  lastTime: number
  /** 有值 = 这是子会话，投递走子代理路由的正门（父会话只挂线不投消息）。 */
  parentSessionId?: string
}

/**
 * 子会话投递需要的宿主面。
 *
 * `attachParent` 把父会话挂上线（不带任何消息）：子会话跑完的结算通知只送给
 * **在线的**直接父级（宿主没有持久化父级信箱），父级不在的话通知会被直接丢掉。
 */
export interface ChildResumeHost {
  /** 把父会话挂上线（已在内存里就原样返回），返回父 agent 本体。 */
  attachParent(sessionId: string): Promise<unknown>
  /** 把一条人写的提示排进子会话（必要时冷恢复）。 */
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
 * `childResume` 缺席时子会话目标投不了（记明原因），普通会话照旧。
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
    if (item.parentSessionId !== undefined) {
      if (childResume === undefined) {
        results.push({ sessionId: item.sessionId, ok: false, detail: '子代理服务缺席，子会话投不了' })
        continue
      }
      if (childBudget <= 0) {
        results.push({ sessionId: item.sessionId, ok: false, detail: '本次启动的子会话恢复名额已用完' })
        continue
      }
      childBudget -= 1
      results.push(await deliverChild(item, childResume, childTemplate ?? DEFAULT_CHILD_MESSAGE_TEMPLATE, io))
      continue
    }
    results.push(await deliverOne(item, promptHost, template, io))
  }
  return results
}

/** 单次投递的准入时限：prompt 准入（恢复会话 + 补中断收尾）应当秒级完成，120 秒是兜底。 */
const PROMPT_ADMISSION_TIMEOUT_MS = 120_000

/**
 * 投递单个普通会话目标；prompt 抛错折成 ok:false 摘要。
 * 第二个参数是宿主 Remote 方法的 AbortSignal（临时实例实测：缺了它宿主
 * 第一行 `signal.throwIfAborted()` 就 TypeError）；限时防准入挂死整条节流链。
 */
async function deliverOne(
  item: DeliveryTarget,
  promptHost: PromptHost,
  template: string,
  io: DeliverIo,
): Promise<DeliveryResult> {
  const message = renderMessage(
    template,
    reasonWording(item.cause, item.detail),
    formatLocalTime(item.lastTime),
  )
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

/** 单次子会话投递的时限（子会话冷恢复要重放历史，秒级到十几秒都可能）。 */
const CHILD_DELIVERY_TIMEOUT_MS = 120_000

/**
 * 投递单个子会话目标：先把父会话挂上线（不带消息），再把提示排进子会话。
 *
 * 主会话**不投消息**——它没被打扰就不会重做已完成的活；子会话跑完，宿主把结算
 * 通知送给在线的父级，父级空闲时被叫起来收尾。
 */
async function deliverChild(
  item: DeliveryTarget,
  childResume: ChildResumeHost,
  template: string,
  io: DeliverIo,
): Promise<DeliveryResult> {
  const parentId = item.parentSessionId ?? ''
  try {
    const parent = await childResume.attachParent(parentId)
    if (parent === undefined || parent === null) {
      return { sessionId: item.sessionId, ok: false, detail: `父会话 ${parentId} 挂不上线（结算通知只送给在线的父级）` }
    }
    const content = renderMessage(
      template,
      reasonWording(item.cause, item.detail),
      formatLocalTime(item.lastTime),
    ).split('{parent}').join(parentId)
    await childResume.queueChildPrompt(
      parent,
      item.sessionId,
      content,
      AbortSignal.timeout(CHILD_DELIVERY_TIMEOUT_MS),
    )
    return { sessionId: item.sessionId, ok: true }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { sessionId: item.sessionId, ok: false, detail: text }
  }
}
