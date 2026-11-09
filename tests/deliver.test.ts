import { describe, expect, it, vi } from 'vitest'
import { deliverContinuations, type ChildResumeHost, type DeliveryTarget, type PromptHost } from '../src/deliver.ts'
import { DEFAULT_CHILD_MESSAGE_TEMPLATE, DEFAULT_MESSAGE_TEMPLATE } from '../src/config.ts'

const NOW = new Date('2026-11-07T02:00:00').getTime()

function target(partial: Partial<DeliveryTarget>): DeliveryTarget {
  return {
    sessionId: 's1',
    cause: 'interrupted',
    lastTime: NOW - 3_600_000,
    ...partial,
  }
}

/** 假投递通道：记录每次 prompt 请求。 */
function fakePromptHost(behavior: (request: unknown) => Promise<unknown> = async () => ({ accepted: true })) {
  const calls: unknown[] = []
  const host: PromptHost = {
    prompt: async (request, _signal) => {
      calls.push(request)
      return behavior(request)
    },
  }
  return { host, calls }
}

/** 假时钟通道：真 sleep、固定时间、可数的 uuid。 */
const realIo = (uuidPrefix: string = 'u') => ({
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  uuid: (() => {
    let n = 0
    return () => `${uuidPrefix}-${(n += 1)}`
  })(),
})

describe('deliverContinuations：请求形状', () => {
  it('每个目标一次 prompt：followup、单 text 片段、模板渲染、requestId 各异', async () => {
    const { host, calls } = fakePromptHost()
    const targets = [
      target({ sessionId: 'a', cause: 'interrupted' }),
      target({ sessionId: 'b', cause: 'error', detail: 'fetch failed' }),
    ]
    const results = await deliverContinuations(targets, host, DEFAULT_MESSAGE_TEMPLATE, 0, realIo())
    expect(results).toEqual([
      { sessionId: 'a', ok: true },
      { sessionId: 'b', ok: true },
    ])
    expect(calls).toHaveLength(2)
    const first = calls[0] as { requestId: string; sessionId: string; mode: string; content: Array<{ type: string; text: string }> }
    expect(first.mode).toBe('followup')
    expect(first.sessionId).toBe('a')
    expect(first.content).toHaveLength(1)
    expect(first.content[0]?.type).toBe('text')
    expect(first.content[0]?.text).toContain('应用退出或进程中断')
    expect(first.requestId).toBe('u-1')
    const second = calls[1] as { requestId: string; content: Array<{ type: string; text: string }> }
    expect(second.requestId).toBe('u-2')
    expect(second.content[0]?.text).toContain('fetch failed')
  })

  it('时间占位符渲染成本地 YYYY-MM-DD HH:mm', async () => {
    const { host, calls } = fakePromptHost()
    await deliverContinuations([target({})], host, '时间:{time}', 0, realIo())
    const text = (calls[0] as { content: Array<{ text: string }> }).content[0]?.text
    expect(text).toBe('时间:2026-11-07 01:00')
  })
})

describe('deliverContinuations：节流与失败隔离', () => {
  it('目标之间各 sleep 一次 staggerMs，最后一个之后不 sleep', async () => {
    const { host } = fakePromptHost()
    const sleeps: number[] = []
    const io = {
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      uuid: () => 'u',
    }
    await deliverContinuations(
      [target({ sessionId: 'a' }), target({ sessionId: 'b' }), target({ sessionId: 'c' })],
      host,
      '继续',
      2000,
      io,
    )
    expect(sleeps).toEqual([2000, 2000])
  })

  it('单点 prompt 抛错 → 该目标 ok:false 带错误摘要，其余照常投递', async () => {
    const { host, calls } = fakePromptHost(async (request) => {
      if ((request as { sessionId: string }).sessionId === 'bad') {
        throw new Error('session/writer-held')
      }
      return { accepted: true }
    })
    const results = await deliverContinuations(
      [target({ sessionId: 'bad' }), target({ sessionId: 'next' })],
      host,
      '继续',
      0,
      realIo(),
    )
    expect(results[0]).toMatchObject({ sessionId: 'bad', ok: false, detail: expect.stringContaining('session/writer-held') })
    expect(results[1]).toMatchObject({ sessionId: 'next', ok: true })
    expect(calls).toHaveLength(2)
  })
})

describe('deliverContinuations：空目标', () => {
  it('无目标 → 不调 prompt，返回空数组', async () => {
    const { host, calls } = fakePromptHost()
    const results = await deliverContinuations([], host, '继续', 100, realIo())
    expect(results).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('不外发时 vi 不误报（sleep 通道未被调用）', async () => {
    const sleep = vi.fn()
    await deliverContinuations([], fakePromptHost().host, '继续', 100, {
      sleep,
      uuid: () => 'u',
    })
    expect(sleep).not.toHaveBeenCalled()
  })
})


describe('deliverContinuations：子会话恢复', () => {
  /** 假子会话通道：记录挂线与排队。 */
  function fakeChildResume(parentAgent: unknown = { id: 'parent' }) {
    const attached: string[] = []
    const calls: Array<{ parent: unknown; childId: string; content: string }> = []
    const host: ChildResumeHost = {
      attachParent: async (sessionId: string) => {
        attached.push(sessionId)
        return parentAgent
      },
      queueChildPrompt: async (parent, childId, content) => {
        calls.push({ parent, childId, content })
        return { messageId: 'm1' }
      },
    }
    return { host, attached, calls }
  }

  it('子会话目标：挂父会话上线（不带消息）→ 提示排进子会话', async () => {
    const { host, calls } = fakePromptHost()
    const { host: childHost, attached, calls: childCalls } = fakeChildResume()
    const results = await deliverContinuations(
      [
        target({
          sessionId: 'child-1',
          cause: 'interrupted',
          parentSessionId: 'parent-1',
        }),
      ],
      host,
      DEFAULT_MESSAGE_TEMPLATE,
      0,
      realIo(),
      childHost,
      DEFAULT_CHILD_MESSAGE_TEMPLATE,
    )
    // 主会话不投消息——它没被打扰就不会重做已完成的活
    expect(calls).toHaveLength(0)
    expect(attached).toEqual(['parent-1'])
    expect(childCalls).toHaveLength(1)
    expect(childCalls[0]?.childId).toBe('child-1')
    expect(childCalls[0]?.content).toContain('parent-1')
    expect(childCalls[0]?.content).toContain('应用退出或进程中断')
    expect(results[0]).toMatchObject({ sessionId: 'child-1', ok: true })
  })

  it('父会话挂不上线 → 子会话不投，记明原因（结算通知只送给在线的父级）', async () => {
    const { host, calls } = fakePromptHost()
    const childHost: ChildResumeHost = {
      attachParent: async () => undefined,
      queueChildPrompt: async () => {
        throw new Error('should not be called')
      },
    }
    const results = await deliverContinuations(
      [target({ sessionId: 'child-1', cause: 'interrupted', parentSessionId: 'parent-1' })],
      host,
      DEFAULT_MESSAGE_TEMPLATE,
      0,
      realIo(),
      childHost,
      DEFAULT_CHILD_MESSAGE_TEMPLATE,
    )
    expect(calls).toHaveLength(0)
    expect(results[0]).toMatchObject({ sessionId: 'child-1', ok: false, detail: expect.stringContaining('挂不上线') })
  })

  it('单个子会话投递失败 → 只记该子会话的失败，其余照常', async () => {
    const { host } = fakePromptHost()
    const childHost: ChildResumeHost = {
      attachParent: async () => ({ id: 'parent' }),
      queueChildPrompt: async (_parent, childId) => {
        if (childId === 'child-1') throw new Error('NOT_RESUMABLE')
        return { messageId: 'm' }
      },
    }
    const results = await deliverContinuations(
      [
        target({ sessionId: 'child-1', cause: 'interrupted', parentSessionId: 'parent-1' }),
        target({ sessionId: 'child-2', cause: 'interrupted', parentSessionId: 'parent-1' }),
      ],
      host,
      DEFAULT_MESSAGE_TEMPLATE,
      0,
      realIo(),
      childHost,
      DEFAULT_CHILD_MESSAGE_TEMPLATE,
    )
    expect(results.map((result) => result.ok)).toEqual([false, true])
    expect(results[0]?.detail).toBe('NOT_RESUMABLE')
  })

  it('maxChildResumes 限制一次启动恢复的子会话数', async () => {
    const { host } = fakePromptHost()
    const { host: childHost, calls: childCalls } = fakeChildResume()
    const results = await deliverContinuations(
      [
        target({ sessionId: 'child-1', cause: 'interrupted', parentSessionId: 'parent-1' }),
        target({ sessionId: 'child-2', cause: 'interrupted', parentSessionId: 'parent-1' }),
        target({ sessionId: 'child-3', cause: 'interrupted', parentSessionId: 'parent-1' }),
      ],
      host,
      DEFAULT_MESSAGE_TEMPLATE,
      0,
      realIo(),
      childHost,
      DEFAULT_CHILD_MESSAGE_TEMPLATE,
      2,
    )
    expect(childCalls).toHaveLength(2)
    expect(results[2]).toMatchObject({ ok: false, detail: expect.stringContaining('名额') })
  })

  it('没有子会话通道 → 子会话目标记明原因，不误投通用 prompt', async () => {
    const { host, calls } = fakePromptHost()
    const results = await deliverContinuations(
      [target({ sessionId: 'child-1', cause: 'interrupted', parentSessionId: 'parent-1' })],
      host,
      DEFAULT_MESSAGE_TEMPLATE,
      0,
      realIo(),
    )
    // 通用 prompt 对子会话一律被宿主拒绝，绝不能走这条路
    expect(calls).toHaveLength(0)
    expect(results[0]).toMatchObject({ sessionId: 'child-1', ok: false, detail: expect.stringContaining('子代理服务缺席') })
  })
})
