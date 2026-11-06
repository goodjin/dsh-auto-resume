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

import { renderMessage } from './config.ts'
import type { ContinueCause } from './classify.ts'

/** 一个待投递目标（来自扫描账目里的 continue 行）。 */
export interface DeliveryTarget {
  sessionId: string
  cause: ContinueCause
  detail?: string
  lastTime: number
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
 */
export async function deliverContinuations(
  targets: readonly DeliveryTarget[],
  promptHost: PromptHost,
  template: string,
  staggerMs: number,
  io: DeliverIo,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = []
  let first = true
  for (const item of targets) {
    if (!first && staggerMs > 0) await io.sleep(staggerMs)
    first = false
    results.push(await deliverOne(item, promptHost, template, io))
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
