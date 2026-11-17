import { describe, expect, it } from 'vitest'
import { DEFAULT_CHILD_MESSAGE_TEMPLATE, DEFAULT_MESSAGE_TEMPLATE, renderMessage, resolveConfig } from '../src/config.ts'

describe('resolveConfig：缺省补默认、负数取 0', () => {
  it('空对象得到全部默认值', () => {
    expect(resolveConfig({})).toEqual({
      enabled: true,
      lookbackHours: 24,
      startupDelayMs: 8000,
      staggerMs: 2000,
      includeError: true,
      includeDisposed: true,
      maxObservations: 30,
      resumeChildren: true,
      maxChildObservations: 20,
      maxChildResumes: 10,
      retryIntervalMs: 600_000,
      maxRetries: 3,
      overloadRetryDelayMs: 300_000,
      overloadMaxRetries: 1,
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      childMessageTemplate: DEFAULT_CHILD_MESSAGE_TEMPLATE,
    })
  })

  it('显式值覆盖默认', () => {
    const resolved = resolveConfig({ enabled: false, lookbackHours: 2, staggerMs: 5 })
    expect(resolved.enabled).toBe(false)
    expect(resolved.lookbackHours).toBe(2)
    expect(resolved.staggerMs).toBe(5)
    expect(resolved.startupDelayMs).toBe(8000)
  })

  it('子会话相关开关可关、可限量', () => {
    const resolved = resolveConfig({ resumeChildren: false, maxChildObservations: 0, maxChildResumes: 3 })
    expect(resolved.resumeChildren).toBe(false)
    expect(resolved.maxChildObservations).toBe(0)
    expect(resolved.maxChildResumes).toBe(3)
  })

  it('重试周期与上限可配', () => {
    const resolved = resolveConfig({ retryIntervalMs: 0, maxRetries: 5 })
    expect(resolved.retryIntervalMs).toBe(0)
    expect(resolved.maxRetries).toBe(5)
  })

  it('过载类失败单列节奏：默认等 5 分钟、只重试一次，两个值都可配', () => {
    expect(resolveConfig({}).overloadRetryDelayMs).toBe(300_000)
    expect(resolveConfig({}).overloadMaxRetries).toBe(1)
    const resolved = resolveConfig({ overloadRetryDelayMs: 60_000, overloadMaxRetries: 2 })
    expect(resolved.overloadRetryDelayMs).toBe(60_000)
    expect(resolved.overloadMaxRetries).toBe(2)
  })

  it('过载类节奏负数取 0（0 = 不等、不重试）', () => {
    expect(resolveConfig({ overloadRetryDelayMs: -5 }).overloadRetryDelayMs).toBe(0)
    expect(resolveConfig({ overloadMaxRetries: -1 }).overloadMaxRetries).toBe(0)
  })

  it('负数值取 0', () => {
    expect(resolveConfig({ lookbackHours: -5 }).lookbackHours).toBe(0)
    expect(resolveConfig({ startupDelayMs: -1 }).startupDelayMs).toBe(0)
    expect(resolveConfig({ staggerMs: -3 }).staggerMs).toBe(0)
  })
})

describe('renderMessage：占位符全部替换', () => {
  it('替换 {reason} 与 {time} 的全部出现', () => {
    expect(renderMessage('原因:{reason}@{time}再{reason}', 'x', 't')).toBe('原因:x@t再x')
  })

  it('默认模板里两个占位符都被替换', () => {
    const text = renderMessage(DEFAULT_MESSAGE_TEMPLATE, '应用退出或进程中断', '2026-11-07 02:00')
    expect(text).toContain('应用退出或进程中断')
    expect(text).toContain('2026-11-07 02:00')
    expect(text).not.toContain('{reason}')
    expect(text).not.toContain('{time}')
  })
})
