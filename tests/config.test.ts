import { describe, expect, it } from 'vitest'
import { DEFAULT_MESSAGE_TEMPLATE, renderMessage, resolveConfig } from '../src/config.ts'

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
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
    })
  })

  it('显式值覆盖默认', () => {
    const resolved = resolveConfig({ enabled: false, lookbackHours: 2, staggerMs: 5 })
    expect(resolved.enabled).toBe(false)
    expect(resolved.lookbackHours).toBe(2)
    expect(resolved.staggerMs).toBe(5)
    expect(resolved.startupDelayMs).toBe(8000)
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
