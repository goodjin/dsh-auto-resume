import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionEventLike } from '../src/classify.ts'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('接线：package.json 与 patch 行', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name: string
    main: string
    exports?: Record<string, unknown>
    dsh?: { bundle?: { patch?: string }; client?: unknown }
  }

  it('包名与入口：exports["."] 默认指向 src/index.ts', () => {
    expect(pkg.name).toBe('@goodjin2/dsh-auto-resume')
    expect(pkg.main).toBe('./src/index.ts')
    expect((pkg.exports?.['.'] as { default?: string }).default).toBe('./src/index.ts')
  })

  it('dsh.bundle.patch 指向存在的 cordis.patch.yml，且无浏览器半边', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(() => readFileSync(join(ROOT, pkg.dsh?.bundle?.patch ?? ''), 'utf8')).not.toThrow()
    expect(pkg.dsh?.client).toBeUndefined()
  })

  it('patch 里挂载行的 name 是裸包名', () => {
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: '@goodjin2/dsh-auto-resume'")
    expect(patch).toContain('id: auto-resume')
  })
})

describe('接线：入口导出形状', async () => {
  const entry = (await import('../src/index.ts')) as Record<string, unknown>

  it('导出 name / inject / apply / Config', () => {
    expect(entry.name).toBe('auto-resume')
    expect(entry.inject).toEqual(['sessionQuery', 'agents', 'workspaceRegistry', 'sessionController'])
    expect(typeof entry.apply).toBe('function')
    expect(entry.Config).toBeDefined()
  })
})

/** 假宿主上下文：注入服务直接挂属性，effect/inject 记录调用。 */
function makeCtx(services: Record<string, unknown>) {
  const disposers: Array<() => void> = []
  const injectCalls: string[][] = []
  const ctx = {
    ...services,
    get(serviceName: string) {
      return services[serviceName]
    },
    effect(factory: () => unknown, _label?: string) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return disposer
    },
    inject(deps: string[], body: (child: unknown) => void) {
      injectCalls.push(deps)
      body({
        webServer: { register: (route: unknown) => route },
        effect: (factory: () => unknown) => factory(),
        ...(services.subagents === undefined ? {} : { subagents: services.subagents }),
      })
    },
  }
  return { ctx, disposers, injectCalls }
}

describe('apply 行为', async () => {
  const { apply } = (await import('../src/index.ts')) as {
    apply: (ctx: unknown, config: unknown) => void
  }

  // 时间基准取「当下」：写死日期会隔天掉出 24 小时窗口（2026-11-09 现场：三个用例集体变红）
  const NOW = Date.now()

  function fakeServices() {
    const prompts: Array<{ sessionId: string }> = []
    // statMtime 走真实 fs.stat：给一个真实存在、mtime 新鲜的文件路径。
    const realPath = fileURLToPath(import.meta.url)
    return {
      prompts,
      services: {
        sessionQuery: {
          async listSessions() {
            return [{ header: { id: 'need-resume' } }, { header: { id: 'fine' } }]
          },
          async observeSession(id: string) {
            if (id === 'fine') {
              return {
                events: [
                  { type: 'turn/start', time: NOW - 3_600_000 },
                  { type: 'turn/end', time: NOW - 3_600_000, data: { turn: 1, reason: { kind: 'completed' } } },
                ],
              }
            }
            return {
              events: [
                { type: 'turn/start', time: NOW - 3_600_000 },
                { type: 'turn/end', time: NOW - 3_600_000, data: { turn: 1, reason: { kind: 'interrupted' } } },
              ],
            }
          },
        },
        agents: { get: () => undefined },
        workspaceRegistry: { archivedSessionIds: [] },
        sessionRecent: {
          async listRecent(_lookbackHours: number, _maxObservations: number, _now: number) {
            return [{ sessionId: 'need-resume', mtime: NOW - 3_600_000 }]
          },
        },
        sessionPersistence: {
          async stat(_id: string) {
            return { location: { path: realPath } }
          },
        },
        sessionController: {
          prompt: async (request: { sessionId: string }, _signal?: AbortSignal) => {
            prompts.push(request)
            return { accepted: true }
          },
        },
      },
    }
  }

  it('enabled=false：挂路由但完全不扫描', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { ctx, injectCalls } = makeCtx(fakeServices().services)
    apply(ctx, { enabled: false, startupDelayMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(injectCalls).toEqual([['webServer'], ['subagents']])
    expect(infoSpy).not.toHaveBeenCalled()
    infoSpy.mockRestore()
  })

  it('enabled=true：延迟到点后扫描一次、投递候选、打一行统计', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { prompts, services } = fakeServices()
    const { ctx, injectCalls } = makeCtx(services)
    apply(ctx, { startupDelayMs: 0, staggerMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(prompts.map((call) => call.sessionId)).toEqual(['need-resume'])
    expect(injectCalls).toEqual([['webServer'], ['subagents']])
    const logged = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('auto-resume:')
    expect(logged).toContain('need-resume')
    infoSpy.mockRestore()
  })

  it('effect 的 disposer 清掉定时器且不抛', async () => {
    const { services } = fakeServices()
    const { ctx, disposers } = makeCtx(services)
    apply(ctx, { startupDelayMs: 60_000 })
    expect(disposers).toHaveLength(1)
    expect(() => disposers[0]?.()).not.toThrow()
  })

  it('sessionRecent 通道调用时抛错 → 整场折进 error 日志，不投递不外抛', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { prompts, services } = fakeServices()
    const all: Record<string, unknown> = {
      ...services,
      sessionRecent: {
        async listRecent() {
          throw new Error('enumeration offline')
        },
      },
    }
    const ctx = {
      ...all,
      get(serviceName: string) {
        return all[serviceName]
      },
      effect(factory: () => unknown) {
        return factory()
      },
      inject() {},
    }
    apply(ctx, { startupDelayMs: 0, staggerMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(prompts).toEqual([])
    const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('enumeration offline')
    errorSpy.mockRestore()
  })
})


describe('apply 行为：子会话恢复', async () => {
  const { apply } = (await import('../src/index.ts')) as {
    apply: (ctx: unknown, config: unknown) => void
  }

  const NOW = Date.now()
  const HOUR = 3_600_000

  /** 父会话：一轮正常结束 + 子代理目录事实。 */
  const parentEvents = [
    { type: 'turn/start', time: NOW - 3 * HOUR },
    { type: 'turn/end', time: NOW - 3 * HOUR, data: { turn: 1, reason: { kind: 'completed' } } },
    {
      type: 'subagent/catalog',
      time: NOW - 2 * HOUR,
      data: { version: 0, childId: 'child-1', childCreatedAt: NOW - 2 * HOUR, mode: 'continuable', label: '子任务' },
    },
  ]

  /** 子会话：轮次被中断。 */
  const childEvents = [
    { type: 'turn/start', time: NOW - 2 * HOUR },
    { type: 'turn/end', time: NOW - 2 * HOUR, data: { turn: 1, reason: { kind: 'interrupted' } } },
  ]

  it('主会话不投消息；父会话挂上线后，被中断的子会话经子代理服务被拉起来', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const prompts: Array<{ sessionId: string }> = []
    const resumed: string[] = []
    const queued: Array<{ parent: unknown; childId: string; content: string }> = []
    const services: Record<string, unknown> = {
      sessionQuery: {
        async listSessions() {
          return [{ header: { id: 'parent' } }]
        },
        async observeSession(id: string) {
          return { events: id === 'child-1' ? childEvents : parentEvents }
        },
      },
      agents: {
        get(id: string) {
          // 父会话不在线：插件要先把父会话挂上线，才有资格往子会话投递
          return undefined
        },
        async resume(options: { resumeSessionId: string }) {
          resumed.push(options.resumeSessionId)
          return { agent: { id: options.resumeSessionId } }
        },
      },
      workspaceRegistry: { archivedSessionIds: [] },
      sessionRecent: {
        async listRecent() {
          return [{ sessionId: 'parent', mtime: NOW - HOUR }]
        },
      },
      subagents: {
        async queuePrompt(parent: unknown, childId: string, content: Array<{ text: string }>) {
          queued.push({ parent, childId, content: content[0]?.text ?? '' })
          return { messageId: 'm1' }
        },
      },
      sessionController: {
        async prompt(request: { sessionId: string }) {
          prompts.push(request)
          return { accepted: true }
        },
      },
    }
    const { ctx } = makeCtx(services)
    apply(ctx, { startupDelayMs: 0, staggerMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 主会话不投消息
    expect(prompts).toEqual([])
    // 父会话先挂上线，子会话随后被拉起来
    expect(resumed).toEqual(['parent'])
    expect(queued.map((call) => call.childId)).toEqual(['child-1'])
    const logged = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('children=service:present')
    expect(logged).toContain('pending=1')
    expect(logged).toContain('resumed=1/1')
    infoSpy.mockRestore()
  })
})

describe('apply 行为：旧版子代理服务（只有 sendMessage）', async () => {
  const { apply } = (await import('../src/index.ts')) as {
    apply: (ctx: unknown, config: unknown) => void
  }

  const NOW = Date.now()
  const HOUR = 3_600_000

  it('没有 queuePrompt 时退回 sendMessage，子会话照样被拉起来', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const sent: Array<{ parent: unknown; targetId: string; content: string }> = []
    const services: Record<string, unknown> = {
      sessionQuery: {
        async listSessions() {
          return [{ header: { id: 'parent' } }]
        },
        async observeSession(id: string) {
          return {
            events:
              id === 'child-1'
                ? [
                    { type: 'turn/start', time: NOW - 2 * HOUR },
                    { type: 'turn/end', time: NOW - 2 * HOUR, data: { turn: 1, reason: { kind: 'interrupted' } } },
                  ]
                : [
                    { type: 'turn/start', time: NOW - 3 * HOUR },
                    { type: 'turn/end', time: NOW - 3 * HOUR, data: { turn: 1, reason: { kind: 'completed' } } },
                    {
                      type: 'subagent/catalog',
                      time: NOW - 2 * HOUR,
                      data: { version: 0, childId: 'child-1', childCreatedAt: NOW - 2 * HOUR, mode: 'continuable', label: '子任务' },
                    },
                  ],
          }
        },
      },
      agents: {
        get(id: string) {
          return id === 'parent' ? { id: 'parent' } : undefined
        },
      },
      workspaceRegistry: { archivedSessionIds: [] },
      sessionRecent: {
        async listRecent() {
          return [{ sessionId: 'parent', mtime: NOW - HOUR }]
        },
      },
      subagents: {
        async sendMessage(parent: unknown, targetId: string, content: Array<{ text: string }>) {
          sent.push({ parent, targetId, content: content[0]?.text ?? '' })
          return { messageId: 'm1' }
        },
      },
      sessionController: {
        async prompt() {
          return { accepted: true }
        },
      },
    }
    const { ctx } = makeCtx(services)
    apply(ctx, { startupDelayMs: 0, staggerMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent.map((call) => call.targetId)).toEqual(['child-1'])
    expect(sent[0]?.content).toContain('parent')
    const logged = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('children=service:present')
    expect(logged).toContain('resumed=1/1')
    infoSpy.mockRestore()
  })
})


describe('apply 行为：暂时性失败的周期重试登记', async () => {
  const { apply } = (await import('../src/index.ts')) as {
    apply: (ctx: unknown, config: unknown) => void
  }

  const NOW = Date.now()
  const HOUR = 3_600_000

  /** 一轮被限速打断的会话事件。 */
  const rateLimited: SessionEventLike[] = [
    { type: 'turn/start', time: NOW - HOUR },
    {
      type: 'turn/end',
      time: NOW - HOUR,
      data: { turn: 1, reason: { kind: 'error', error: { message: '429 Too Many Requests', code: 'QUOTA_EXCEEDED' } } },
    },
  ]

  it('暂时性失败的会话投出去之后，登记进周期重试账本', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    // 账本落在 <DSH_HOME>/auto-resume 下：测试用临时目录，别碰真账本
    const originalHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(tmpdir(), `auto-resume-test-${Math.random().toString(36).slice(2)}`)
    const prompts: Array<{ sessionId: string }> = []
    const services: Record<string, unknown> = {
      sessionQuery: {
        async listSessions() {
          return [{ header: { id: 'rate-limited' } }]
        },
        async observeSession() {
          return { events: rateLimited }
        },
      },
      agents: { get: () => undefined },
      workspaceRegistry: { archivedSessionIds: [] },
      sessionRecent: {
        async listRecent() {
          return [{ sessionId: 'rate-limited', mtime: NOW - HOUR }]
        },
      },
      sessionController: {
        async prompt(request: { sessionId: string }) {
          prompts.push(request)
          return { accepted: true }
        },
      },
    }
    const { ctx } = makeCtx(services)
    apply(ctx, { startupDelayMs: 0, staggerMs: 0, retryIntervalMs: 600_000, maxRetries: 3 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(prompts.map((call) => call.sessionId)).toEqual(['rate-limited'])
    const logged = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('retryActive=[rate-limited(1次/失败0)]')
    infoSpy.mockRestore()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })
})


describe('apply 行为：中止当下就登记', async () => {
  const { apply } = (await import('../src/index.ts')) as {
    apply: (ctx: unknown, config: unknown) => void
  }

  const NOW = Date.now()
  const HOUR = 3_600_000

  /** 造一个带事件监听器的假宿主。 */
  function ctxWithEvents(services: Record<string, unknown>) {
    const listeners: Record<string, Array<(subject: unknown, event: unknown) => void>> = {}
    const ctx = {
      ...services,
      on(eventName: string, listener: (subject: unknown, event: unknown) => void) {
        ;(listeners[eventName] ??= []).push(listener)
      },
      get(serviceName: string) {
        return services[serviceName]
      },
      effect(factory: () => unknown) {
        return factory()
      },
      inject(deps: string[], body: (child: unknown) => void) {
        body({
          webServer: { register: (route: unknown) => route },
          effect: (factory: () => unknown) => factory(),
          ...(services.subagents === undefined ? {} : { subagents: services.subagents }),
        })
      },
    }
    return { ctx, fire: (eventName: string, subject: unknown, event: unknown) => { for (const l of listeners[eventName] ?? []) l(subject, event) } }
  }

  const transientTurnEnd = {
    type: 'turn/end',
    time: NOW,
    data: { turn: 1, reason: { kind: 'error', error: { message: '429 Too Many Requests', code: 'QUOTA_EXCEEDED' } } },
  }
  const completedTurnEnd = { type: 'turn/end', time: NOW, data: { turn: 2, reason: { kind: 'completed' } } }

  it('轮次以暂时性失败收尾 → 当下进账本（子会话带上父会话）', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const originalHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(tmpdir(), `auto-resume-test-${Math.random().toString(36).slice(2)}`)
    const { ctx, fire } = ctxWithEvents({
      agents: { get: () => undefined },
      sessionController: { prompt: async () => ({ accepted: true }) },
    })
    apply(ctx, { startupDelayMs: 500_000, retryIntervalMs: 600_000 })
    fire('session/event', { id: 'child-9', header: { parentSession: 'parent-9' } }, transientTurnEnd)
    const logged = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('已登记暂时性失败会话 child-9（父 parent-9）')
    infoSpy.mockRestore()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })

  it('暂时性失败不匹配（比如正常完成）→ 不登记；放弃标记随之解除', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const originalHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(tmpdir(), `auto-resume-test-${Math.random().toString(36).slice(2)}`)
    const { ctx, fire } = ctxWithEvents({})
    apply(ctx, { startupDelayMs: 500_000, retryIntervalMs: 600_000 })
    // 先造一个放弃标记
    fire('session/event', { id: 'given-up' }, transientTurnEnd)
    const marked = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(marked).toContain('已登记暂时性失败会话 given-up')
    infoSpy.mockRestore()
    // 会话走出失败状态 → 标记解除（下次再失败照常登记）
    const infoSpy2 = vi.spyOn(console, 'info').mockImplementation(() => {})
    fire('session/event', { id: 'given-up' }, completedTurnEnd)
    const cleared = infoSpy2.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(cleared).not.toContain('given-up')
    infoSpy2.mockRestore()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })

  it('已放弃的会话再次暂时性失败 → 不复活登记（标记 hold 住）', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const originalHome = process.env.DSH_HOME
    const home = join(tmpdir(), `auto-resume-test-${Math.random().toString(36).slice(2)}`)
    process.env.DSH_HOME = home
    // 装载前就把放弃标记写进账本（启动扫描读得到，监听器也读得到）
    const ledgerPath = join(home, 'auto-resume', 'retry-ledger.json')
    mkdirSync(dirname(ledgerPath), { recursive: true })
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        active: {},
        abandoned: {
          'given-up': {
            sessionId: 'given-up',
            tailTime: NOW,
            abandonedAt: NOW,
            attempts: 3,
            reason: '连续 3 个周期仍在失败（fetch failed），不再重试',
          },
        },
      }),
    )
    const { ctx, fire } = ctxWithEvents({})
    apply(ctx, { startupDelayMs: 500_000, retryIntervalMs: 600_000 })
    // 同一个会话又失败了一次 → 标记 hold 住，不复活登记
    fire('session/event', { id: 'given-up' }, transientTurnEnd)
    const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8')) as typeof ledgerShape
    expect(onDisk.active['given-up']).toBeUndefined()
    expect(onDisk.abandoned['given-up']).toBeDefined()
    expect(infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')).not.toContain('已登记暂时性失败会话 given-up')
    infoSpy.mockRestore()
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })

  /** 账本文件的形状（测试里做形状断言用）。 */
  const ledgerShape = {
    active: {} as Record<string, unknown>,
    abandoned: {} as Record<string, unknown>,
  }
})
