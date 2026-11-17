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

/** 继续的原因：崩溃中断 / 运行出错 / 桌面版退出 / 排队消息未投递。 */
export type ContinueCause = 'interrupted' | 'error' | 'disposed' | 'queued'

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

/** 把 error 失败对象收成一句可读摘要（带上稳定错误码），截 200 字符。 */
export function errorDetail(error: unknown): string | undefined {
  let text: string | undefined
  let code: string | undefined
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    // 有些网关把内层 error 对象整个传过来（顶层无 message），或把关键文案放在
    // 嵌套的 error.message / type 里。先把这些可读字段挖出来，别让一串 JSON
    // 把「网络错误」「请稍后重试」这类判定依据挤到 200 字截断线之外。
    text = firstNonEmptyString(record.message)
      ?? firstNonEmptyString(nestedRecord(record, 'error')?.message)
      ?? firstNonEmptyString(record.type)
      ?? JSON.stringify(error)
    code = typeof record.code === 'string' ? record.code : undefined
  } else if (error !== undefined && error !== null) {
    text = String(error)
  }
  if (text === undefined) return undefined
  if (code !== undefined && code !== '' && !text.includes(code)) text = `${text} [${code}]`
  // 截断优先保住尾部：网关常把状态码/前缀堆在前面、把「网络错误，请稍后重试」
  // 放在末尾。整句超长时留头 100 + 尾 100，判定依据不因截断丢失。
  if (text.length <= 200) return text
  return `${text.slice(0, 100)}…${text.slice(-100)}`
}

/** 取对象里第一个非空字符串字段（形状不对回 undefined）。 */
function firstNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 取对象里嵌一层的 record（形状不对回 undefined）。 */
function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 「暂时性失败」的特征：网络断、超时、429 限速这类，过一会儿可能自己好。
 * 摘要里带稳定错误码（如 `QUOTA_EXCEEDED`），按码或按字面匹配都行。
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\b5(02|03|04)\b/,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /quota[ _-]?exceed/i,
  /timeout|timed out/i,
  /econn(reset|refused|aborted)|enotfound|eai_again|ehostunreach|enetunreach/i,
  /socket hang up/i,
  /fetch failed/i,
  /network (error|unreachable)|temporarily unavailable|service unavailable/i,
  /upstream (error|unavailable)|overloaded/i,
  // 529 是部分网关（MiniMax 等）表示「集群过载」的状态码；中文文案与
  // overloaded_error 这类英文类型也一并认，避免只靠一个关键词漏判（2026-11-17）。
  /\b529\b/,
  /集群负载|请稍后重试|负载较高|服务集群|overloaded_error/i,
  // 5xx 里其余常见的服务端错误（尤其 500）；GLM 网关用 500 包「网络错误，请稍后重试」
  // （2026-11-17 现场）。只认「(500) / status 500 / failed 500」这类状态码语境，
  // 不认裸数字（请求 id、时间戳里也可能出现 500）。中文网络类说法也补上，别只认英文。
  /(\(|\bstatus\s*[:=]?\s*|\bfailed\s*[:=]?\s*|\bcode\s*[:=]?\s*)5\d\d\b/i,
  /网络错误|网络异常|网络连接|连接失败|连接中断|网络(不可用|中断|超时)/i,
  /api_error|内部错误|internal server error/i,
]

/**
 * 「服务暂时不可用」这一类暂时性失败：值得等 5 分钟、只重试一次。
 *
 * 服务端明确说「负载高 / 网络错误 / 请稍后重试」「5xx」「api_error」，说明这会儿
 * 发不出去或处理不了，秒级或十分钟内反复重投只会继续被拒。它比一般暂时性失败
 * 更特殊，所以单列一个节奏（默认等 5 分钟、重试一次）。
 *
 * 判定证据（任一）：529 状态码、overloaded_error、集群负载/负载较高、其余 5xx、
 * api_error、中文网络错误/异常、「请稍后重试」。**不含** 429 限速、401 登录、纯超时
 * ——它们仍走普通 10 分钟×3 的节奏（额度类重试无意义，登录类要人来处理）。
 */
const SHORT_UNAVAILABLE_PATTERNS: RegExp[] = [
  /\b529\b/,
  /overloaded_error|集群负载|负载较高|服务集群/i,
  /(\(|\bstatus\s*[:=]?\s*|\bfailed\s*[:=]?\s*|\bcode\s*[:=]?\s*)5\d\d\b/i,
  /网络错误|网络异常|网络连接|连接失败|连接中断|网络(不可用|中断|超时)/i,
  /api_error|internal server error|内部错误/i,
  /service unavailable|bad gateway|gateway timeout|upstream (error|unavailable)/i,
  /请稍后重试|稍后再试|try again later|please retry/i,
]

/** 是不是「服务暂时不可用」类失败（走等 5 分钟、只重试一次的单列节奏）。 */
export function isShortUnavailableErrorDetail(detail: string | undefined): boolean {
  if (detail === undefined || detail === '') return false
  return SHORT_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))
}

/**
 * 「集群负载高 / 过载」判定的兼容入口。
 *
 * 上一轮只为 529 overloaded_error 引入了单列节奏；本轮把它扩成「服务暂时不可用」
 * （中文网络错误、500 等也走这条）。账本、配置、接线仍调用这个名字，保留为别名，
 * 语义以 `isShortUnavailableErrorDetail` 为准。
 */
export const isOverloadErrorDetail = isShortUnavailableErrorDetail

/** 一句话是不是「暂时性失败」（网络 / 限速 / 超时 / 服务暂时不可用这类）。 */
export function isTransientErrorDetail(detail: string | undefined): boolean {
  if (detail === undefined || detail === '') return false
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(detail))
    || isShortUnavailableErrorDetail(detail)
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

