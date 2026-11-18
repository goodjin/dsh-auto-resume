import { describe, expect, it, vi } from 'vitest'
import { apply, childResumeHostOf } from '../src/index.ts'

/**
 * attachParent 挂线路径的专项测试（2026-11-12 aacc1667 事故回归）：
 * 冷恢复必须走 sessionController.agents.resolveAgent 正门（prompt 同款、按会话
 * 记录重挂 agentPreset），绝不退回裸 ctx.agents.resume（不带组合，73→42）。
 */

/** 同一个假宿主 ctx：apply 用它把 subagents 写进模块状态，childResumeHostOf 用它闭包捕获服务面。 */
function makeCtx(overrides: { agents?: unknown; sessionController?: unknown } = {}) {
  const subagents = { queuePrompt: async () => ({ id: 'm' }) }
  const ctx = {
    sessionQuery: { listSessions: async () => [], observeSession: async () => ({ events: [] }) },
    agents: overrides.agents ?? { get: () => undefined },
    workspaceRegistry: { archivedSessionIds: [] },
    sessionController:
      overrides.sessionController ?? { prompt: async () => ({ accepted: true }) },
    get: (name: string) => (name === 'subagents' ? subagents : undefined),
    inject: (deps: string[], body: (child: unknown) => void) => {
      body(deps.includes('subagents') ? { subagents } : {})
    },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0], { enabled: false, startupDelayMs: 0 })
  return ctx as unknown as Parameters<typeof childResumeHostOf>[0]
}

const io = { sleep: async () => {}, uuid: () => 'u' }

describe('attachParent：挂线走组合完整的正门', () => {
  it('父会话已在内存 → 原样返回，不碰 sessionController', async () => {
    const live = { id: 'parent-1' }
    const resolveAgent = vi.fn(async () => ({ agent: { id: 'cold' } }))
    const ctx = makeCtx({
      agents: { get: () => live },
      sessionController: { prompt: async () => ({ accepted: true }), agents: { resolveAgent } },
    })
    const host = childResumeHostOf(ctx, io)
    await expect(host?.attachParent('parent-1')).resolves.toBe(live)
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('父会话不在内存 → 走 sessionController.agents.resolveAgent 正门', async () => {
    const cold = { id: 'parent-1' }
    const resolveAgent = vi.fn(async () => ({ agent: cold }))
    const ctx = makeCtx({
      agents: { get: () => undefined },
      sessionController: { prompt: async () => ({ accepted: true }), agents: { resolveAgent } },
    })
    const host = childResumeHostOf(ctx, io)
    await expect(host?.attachParent('parent-1')).resolves.toBe(cold)
    expect(resolveAgent).toHaveBeenCalledTimes(1)
    expect(resolveAgent).toHaveBeenCalledWith('parent-1')
  })

  it('正门返回 error → 抛出并带宿主拒绝原因（投递层折成 ok:false）', async () => {
    const resolveAgent = vi.fn(async () => ({
      error: new Error('session "parent-1" is owned by subagent routing'),
    }))
    const ctx = makeCtx({
      agents: { get: () => undefined },
      sessionController: { prompt: async () => ({ accepted: true }), agents: { resolveAgent } },
    })
    const host = childResumeHostOf(ctx, io)
    await expect(host?.attachParent('parent-1')).rejects.toThrow(/挂线被宿主拒绝.*subagent routing/)
  })

  it('正门缺席 → 拒绝裸恢复挂线，且绝不调 ctx.agents.resume（事故回归）', async () => {
    const bareResume = vi.fn(async () => ({ agent: { id: 'bare' } }))
    const ctx = makeCtx({
      agents: { get: () => undefined, resume: bareResume },
      sessionController: { prompt: async () => ({ accepted: true }) },
    })
    const host = childResumeHostOf(ctx, io)
    await expect(host?.attachParent('parent-1')).rejects.toThrow(/拒绝裸恢复挂线/)
    expect(bareResume).not.toHaveBeenCalled()
  })

  it('正门返回不认识的形状 → 视为挂不上线（undefined）', async () => {
    const resolveAgent = vi.fn(async () => ({ something: 'else' }))
    const ctx = makeCtx({
      agents: { get: () => undefined },
      sessionController: { prompt: async () => ({ accepted: true }), agents: { resolveAgent } },
    })
    const host = childResumeHostOf(ctx, io)
    await expect(host?.attachParent('parent-1')).resolves.toBeUndefined()
  })
})
