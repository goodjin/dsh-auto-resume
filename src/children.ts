/**
 * 子会话（子代理）识别：主会话正常收尾，但它名下有被中断、还没报告过的子会话。
 *
 * 场景（2026-11-07 现场）：主会话已经输出完回答块、正在等子会话主动回话，
 * 此时退出应用——主会话那一轮是**正常结束**的（宿主教模型「只剩等子代理结果
 * 时就结束本轮」），所以按会话级判定会被当成「正常结束」跳过，重启后没人
 * 再把它叫醒，子会话的活儿也停在半路。
 *
 * 判断依据全在日志里：
 * - 父会话的 `subagent/catalog` 事实记录了它有哪些子会话（只记成员关系，
 *   不记执行状态）；
 * - 子会话自己的日志尾部说了算：轮次还开着 → 宿主冷读补出的收尾是
 *   `interrupted`（被杀）/ `disposed`（退出）→ 属于异常中断，值得续；
 * - 子会话已经向主会话报告过结果的（结算通知在案）不算——主会话知道结果了，
 *   再续就是重做。
 *
 * @module @goodjin2/dsh-auto-resume/children
 */

import type { SessionEventLike } from './classify.ts'

/** 父会话目录里的一个子会话。 */
export interface CatalogChild {
  childId: string
  /** 本地可继续 / 外部后端（外部后端不可继续，只能让父会话重新委派）。 */
  mode?: string
  createdAt?: number
}

/** 从父会话的事件流里取出子代理目录（每创建一个子会话追加一条事实）。 */
export function catalogChildren(events: readonly SessionEventLike[]): CatalogChild[] {
  const children: CatalogChild[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.type !== 'subagent/catalog') continue
    const data = event.data
    if (typeof data !== 'object' || data === null) continue
    const record = data as Record<string, unknown>
    const childId = record.childId
    if (typeof childId !== 'string' || childId === '' || seen.has(childId)) continue
    seen.add(childId)
    const mode = record.mode
    const createdAt = record.childCreatedAt
    children.push({
      childId,
      ...(typeof mode === 'string' ? { mode } : {}),
      ...(typeof createdAt === 'number' ? { createdAt } : {}),
    })
  }
  return children
}

/**
 * 外部后端（Codex / Claude Code / ACP 等）的子会话没有本地会话日志，
 * 不可继续，只能让父会话重新委派。目录里的 `mode: 'external'` 就是这种。
 * 其余（含 `unknown` 的历史条目）都交给宿主判定——它按子会话自己的描述符
 * 决定能不能冷恢复。
 */
export function hasLocalSession(child: CatalogChild): boolean {
  return child.mode !== 'external'
}

/**
 * 主会话已经收到过结算通知的子会话（它们已经向主会话报告过结果了）。
 *
 * 结算通知是宿主往主会话追加的一条用户消息：来源标记 `subagent-settled`，
 * 带子会话 id（`senderSessionId`）与人话摘要（「Background subagent <id> …」）。
 *
 * 这一条是「主会话是不是还在等」的权威判据：子会话报过了，主会话就知道结果了
 * （哪怕通知还躺在收件箱里没被领取），这时把主会话叫醒是多余的。
 */
export function reportedChildIds(events: readonly SessionEventLike[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'agent/inbox/spliced') continue
    const source = event.data?.source
    if (typeof source !== 'object' || source === null) continue
    const record = source as Record<string, unknown>
    if (record.kind !== 'subagent-settled') continue
    const sender = record.senderSessionId
    if (typeof sender === 'string' && sender !== '') {
      ids.add(sender)
      continue
    }
    // 没有 senderSessionId 时从摘要里点名解析（人话里带子会话 id）。
    const summary = typeof record.summary === 'string' ? record.summary : ''
    const match = /Background subagent ([0-9a-zA-Z-]{2,})/.exec(summary)
    if (match?.[1] !== undefined) ids.add(match[1])
  }
  return ids
}
