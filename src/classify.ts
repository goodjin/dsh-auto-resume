/**
 * 异常中断判定器：一个会话的事件序列 → 继续还是跳过。
 *
 * 纯函数、零宿主依赖。输入是 `sessionQuery.observeSession` 返回的事件
 * （尾部开轮次已被宿主崩溃恢复补成 `interrupted` 收尾），所以判定统一按
 * 「最后一轮的结束原因」走；唯一要单独看的形态是「轮次从未打开」（崩溃
 * 发生在投递之前），以及「正常结束后的排队尾巴」。
 *
 * 关键优先级：用户主动停止（`aborted`/`user`）永远跳过——停止语义会故意
 * 保留收件箱里用户自己的消息（`keepInbox`），那是用户的决定，不是异常。
 *
 * 判定表的依据见 docs/superpowers/specs/2026-11-07-auto-resume-design.md。
 *
 * @module @goodjin2/dsh-auto-resume/classify
 */

/** 判定器需要的最小事件面（多余字段一律忽略）。 */
export interface SessionEventLike {
  type: string
  time: number
  data?: Record<string, unknown>
}

/**
 * 继续的原因：崩溃中断 / 运行出错 / 桌面版退出 / 排队消息未投递 /
 * 主会话在等一个被中断的子会话。
 */
export type ContinueCause = 'interrupted' | 'error' | 'disposed' | 'queued' | 'awaiting-child'

/** 判定结果：继续（带原因与细节）或跳过（带跳过原因）。 */
export type Verdict =
  | { action: 'continue'; cause: ContinueCause; detail?: string; lastTime: number }
  | {
      action: 'skip'
      /**
       * 跳过原因。`disposed-excluded` / `error-excluded` 表示「本来该续，但被
       * 对应开关关掉了」——与 `normal-end`（本来就正常结束）分开，账目里一眼
       * 看得出是配置挡住的。
       */
      cause:
        | 'blank'
        | 'outside-window'
        | 'user-stopped'
        | 'normal-end'
        | 'cancel-by-parent-or-hook'
        | 'disposed-excluded'
        | 'error-excluded'
      lastTime: number
    }

/** 判定选项：当前时间、窗口、两个可关的继续类别。 */
export interface ClassifyOptions {
  now: number
  lookbackHours: number
  includeError: boolean
  includeDisposed: boolean
}

/** 消息已进会话但轮次没开的两类事件。 */
const UNDELIVERED_INPUT_TYPES = new Set(['user/message', 'agent/inbox/spliced'])

/** 取事件 data 里给定的键值，形状不对回 undefined。 */
function dataField(event: SessionEventLike, key: string): Record<string, unknown> | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** 从 `turn/end` 事件取 reason 对象；形状不对回 undefined。 */
function reasonOf(event: SessionEventLike): Record<string, unknown> | undefined {
  return dataField(event, 'reason')
}

/** 把 error 失败对象收成一句可读摘要，截 200 字符。 */
function errorDetail(error: unknown): string | undefined {
  let text: string | undefined
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    text = typeof message === 'string' && message.trim() !== '' ? message : JSON.stringify(error)
  } else if (error !== undefined && error !== null) {
    text = String(error)
  }
  if (text === undefined) return undefined
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * 判定一个会话：继续（带原因）或跳过（带原因）。
 * 判定表见模块注释与 spec；未知结束原因保守按普通结束跳过。
 */
export function classifySession(events: readonly SessionEventLike[], options: ClassifyOptions): Verdict {
  const last = events.at(-1)
  if (last === undefined) return { action: 'skip', cause: 'blank', lastTime: 0 }
  const lastTime = last.time

  const windowMs = options.lookbackHours * 3_600_000
  if (options.now - lastTime > windowMs) {
    return { action: 'skip', cause: 'outside-window', lastTime }
  }

  // 找最后一个 turn/end；顺带记「有没有投递过用户输入」。
  let lastTurnEndIndex = -1
  let sawDeliveredInput = false
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEventLike
    if (event.type === 'turn/end') {
      lastTurnEndIndex = index
      sawDeliveredInput = false
      continue
    }
    if (UNDELIVERED_INPUT_TYPES.has(event.type)) sawDeliveredInput = true
  }

  if (lastTurnEndIndex === -1) {
    return sawDeliveredInput
      ? { action: 'continue', cause: 'interrupted', lastTime }
      : { action: 'skip', cause: 'blank', lastTime }
  }

  // 尾部排队：最后一个 turn/end 之后又进了消息但轮次再没开。
  const pendingAfterTail = events
    .slice(lastTurnEndIndex + 1)
    .some((event) => UNDELIVERED_INPUT_TYPES.has(event.type))

  const reason = reasonOf(events[lastTurnEndIndex] as SessionEventLike)
  const kind = typeof reason?.kind === 'string' ? reason.kind : undefined

  switch (kind) {
    case 'aborted': {
      const cancelKind = reason?.reason
      const cancel = typeof cancelKind === 'object' && cancelKind !== null
        ? (cancelKind as Record<string, unknown>).kind
        : undefined
      if (cancel === 'user') return { action: 'skip', cause: 'user-stopped', lastTime }
      if (cancel === 'disposed') {
        return options.includeDisposed
          ? { action: 'continue', cause: 'disposed', lastTime }
          : { action: 'skip', cause: 'disposed-excluded', lastTime }
      }
      // parent / hook / legacy：父会话或钩子的主动行为，不算异常。
      return { action: 'skip', cause: 'cancel-by-parent-or-hook', lastTime }
    }
    case 'error': {
      if (!options.includeError) return { action: 'skip', cause: 'error-excluded', lastTime }
      const detail = errorDetail(reason?.error)
      return {
        action: 'continue',
        cause: 'error',
        ...(detail === undefined ? {} : { detail }),
        lastTime,
      }
    }
    case 'interrupted':
      return { action: 'continue', cause: 'interrupted', lastTime }
    default:
      // completed / max-tokens / blocked / forked / 未知 kind。
      return pendingAfterTail
        ? { action: 'continue', cause: 'queued', lastTime }
        : { action: 'skip', cause: 'normal-end', lastTime }
  }
}

