import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

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
    effect(factory: () => unknown, _label?: string) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return disposer
    },
    inject(deps: string[], body: (child: unknown) => void) {
      injectCalls.push(deps)
      body({ webServer: { register: (route: unknown) => route }, effect: (factory: () => unknown) => factory() })
    },
  }
  return { ctx, disposers, injectCalls }
}

describe('apply 行为', async () => {
  const { apply } = (await import('../src/index.ts')) as {
    apply: (ctx: unknown, config: unknown) => void
  }

  const NOW = new Date('2026-11-07T02:00:00').getTime()

  function fakeServices() {
    const prompts: Array<{ sessionId: string }> = []
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
        sessionController: {
          prompt: async (request: { sessionId: string }) => {
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
    expect(injectCalls).toEqual([['webServer']])
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
    expect(injectCalls).toEqual([['webServer']])
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

  it('可选服务 sessionPersistence 未注入（读属性即抛）→ 走 ctx.get，扫描照常', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { prompts, services } = fakeServices()
    // cordis 语义：未注入的属性读一次抛一次；get 回 undefined。
    const ctx = {
      ...services,
      effect(factory: () => unknown) {
        return factory()
      },
      inject() {},
      get(serviceName: string) {
        if (serviceName === 'sessionPersistence') return undefined
        throw new Error(`cannot get property "${serviceName}" without inject`)
      },
    }
    Object.defineProperty(ctx, 'sessionPersistence', {
      get() {
        throw new Error('cannot get property "sessionPersistence" without inject')
      },
    })
    apply(ctx, { startupDelayMs: 0, staggerMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(prompts.map((call) => call.sessionId)).toEqual(['need-resume'])
    const logged = infoSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).not.toContain('error:')
    infoSpy.mockRestore()
  })
})
