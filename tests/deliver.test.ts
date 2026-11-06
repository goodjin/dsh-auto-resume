import { describe, expect, it, vi } from 'vitest'
import { deliverContinuations, type DeliveryTarget, type PromptHost } from '../src/deliver.ts'
import { DEFAULT_MESSAGE_TEMPLATE } from '../src/config.ts'

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
    prompt: async (request) => {
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
