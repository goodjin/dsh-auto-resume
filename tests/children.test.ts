import { describe, expect, it } from 'vitest'

import { catalogChildren, childNeedsResume, hasLocalSession, reportedChildIds } from '../src/children.ts'
import type { SessionEventLike } from '../src/classify.ts'

const NOW = new Date('2026-11-07T02:00:00').getTime()
const HOUR = 3_600_000
const OPTS = { now: NOW, lookbackHours: 24, includeError: true, includeDisposed: true }

/** 一条子代理目录事实（宿主每创建一个子会话就往父会话追加一条）。 */
function catalog(childId: string, mode = 'continuable', createdAt = NOW - HOUR): SessionEventLike {
  return {
    type: 'subagent/catalog',
    time: createdAt,
    data: { version: 0, childId, childCreatedAt: createdAt, mode, label: '子任务' },
  }
}

/** 子会话事件：轮次异常收尾（宿主冷读时补出来的 interrupted）。 */
function interruptedEvents(): SessionEventLike[] {
  return [
    { type: 'turn/start', time: NOW - HOUR },
    { type: 'turn/end', time: NOW - HOUR, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]
}

/** 子会话事件：正常完成。 */
function completedEvents(): SessionEventLike[] {
  return [
    { type: 'turn/start', time: NOW - HOUR },
    { type: 'turn/end', time: NOW - HOUR, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('catalogChildren：父会话的子代理目录', () => {
  it('取出目录里的子会话（id、模式、创建时间）', () => {
    const children = catalogChildren([catalog('c1'), catalog('c2', 'external')])
    expect(children).toEqual([
      { childId: 'c1', mode: 'continuable', createdAt: NOW - HOUR },
      { childId: 'c2', mode: 'external', createdAt: NOW - HOUR },
    ])
  })

  it('同一个子会话只算一次（目录可能追加多条）', () => {
    expect(catalogChildren([catalog('c1'), catalog('c1')])).toHaveLength(1)
  })

  it('没有目录事实 → 空清单', () => {
    expect(catalogChildren([{ type: 'turn/end', time: NOW }])).toEqual([])
  })

  it('形状不对的事实跳过，不抛', () => {
    expect(catalogChildren([{ type: 'subagent/catalog', time: NOW, data: { childId: 42 } }])).toEqual([])
  })
})

describe('childNeedsResume：子会话要不要续', () => {
  it('异常收尾 → 要续（原因带出来）', () => {
    expect(childNeedsResume(interruptedEvents(), OPTS)).toEqual({ needs: true, cause: 'interrupted' })
  })

  it('正常完成 → 不用续', () => {
    expect(childNeedsResume(completedEvents(), OPTS)).toEqual({ needs: false })
  })

  it('用户主动停过 → 不用续', () => {
    const events: SessionEventLike[] = [
      { type: 'turn/start', time: NOW - HOUR },
      { type: 'turn/end', time: NOW - HOUR, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ]
    expect(childNeedsResume(events, OPTS)).toEqual({ needs: false })
  })
})

describe('hasLocalSession：外部后端的子会话没有本地会话', () => {
  it('mode=external → 没有本地会话', () => {
    expect(hasLocalSession({ childId: 'c', mode: 'external' })).toBe(false)
  })

  it('其余交给宿主判定（本地 / unknown 都试）', () => {
    expect(hasLocalSession({ childId: 'c', mode: 'continuable' })).toBe(true)
    expect(hasLocalSession({ childId: 'c', mode: 'unknown' })).toBe(true)
    expect(hasLocalSession({ childId: 'c' })).toBe(true)
  })
})


describe('reportedChildIds：主会话已经收到过结算通知的子会话', () => {
  it('从结算通知里取出子会话 id', () => {
    const events: SessionEventLike[] = [
      {
        type: 'user/message',
        time: NOW,
        data: {
          source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: 'Background subagent c1 failed before it finished.',
            senderSessionId: 'c1',
          },
        },
      },
    ]
    expect([...reportedChildIds(events)]).toEqual(['c1'])
  })

  it('没有 senderSessionId 时从摘要里点名解析', () => {
    const events: SessionEventLike[] = [
      {
        type: 'user/message',
        time: NOW,
        data: { source: { kind: 'subagent-settled', summary: 'Background subagent c2 finished.' } },
      },
    ]
    expect([...reportedChildIds(events)]).toEqual(['c2'])
  })

  it('收件箱里还没被领取的通知也算「已报告」', () => {
    const events: SessionEventLike[] = [
      {
        type: 'agent/inbox/spliced',
        time: NOW,
        data: { source: { kind: 'subagent-settled', senderSessionId: 'c3' } },
      },
    ]
    expect([...reportedChildIds(events)]).toEqual(['c3'])
  })

  it('普通消息不算', () => {
    expect(reportedChildIds([{ type: 'user/message', time: NOW, data: { source: { kind: 'user' } } }]).size).toBe(0)
  })
})
