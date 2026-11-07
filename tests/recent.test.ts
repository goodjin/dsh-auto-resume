import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listRecentByFs, sessionsRoot } from '../src/recent.ts'

const NOW = new Date('2026-11-07T02:00:00').getTime()
const HOUR = 3_600_000

/** 建一棵临时会话库：项目目录 → 会话目录 → 日志文件。 */
async function makeTree(files: Array<{ project: string; session: string; name: string; mtime: number }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'auto-resume-recent-'))
  for (const file of files) {
    const dir = join(root, file.project, file.session)
    await mkdir(dir, { recursive: true })
    const path = join(dir, file.name)
    await writeFile(path, 'x')
    await utimes(path, new Date(file.mtime), new Date(file.mtime))
  }
  return root
}

describe('sessionsRoot', () => {
  it('缺省指向 ~/.dsh/sessions；DSH_HOME 覆盖', () => {
    const original = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(sessionsRoot().endsWith('/.dsh/sessions')).toBe(true)
      process.env.DSH_HOME = '/tmp/dsh-home'
      expect(sessionsRoot()).toBe('/tmp/dsh-home/sessions')
    } finally {
      if (original === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = original
    }
  })
})

describe('listRecentByFs：最近候选枚举', () => {
  it('按窗口过滤：窗口外的老会话不进候选', async () => {
    const root = await makeTree([
      { project: 'p1', session: 'recent', name: 'session.v4.jsonl.zstd', mtime: NOW - 2 * HOUR },
      { project: 'p1', session: 'old', name: 'session.v4.jsonl.zstd', mtime: NOW - 48 * HOUR },
    ])
    const candidates = await listRecentByFs({ root, lookbackHours: 24, maxObservations: 30, now: NOW })
    expect(candidates.map((c) => c.sessionId)).toEqual(['recent'])
  })

  it('同一会话有多代日志时取版本号最高的那一份的 mtime', async () => {
    const root = await makeTree([
      { project: 'p1', session: 's', name: 'session.v3.jsonl.zstd', mtime: NOW - 20 * HOUR },
      { project: 'p1', session: 's', name: 'session.v4.jsonl.zstd', mtime: NOW - 30 * HOUR },
    ])
    const candidates = await listRecentByFs({ root, lookbackHours: 24, maxObservations: 30, now: NOW })
    // v4 的 mtime 在窗口外 → 不进候选（证明读的是 v4 而不是 v3）
    expect(candidates).toEqual([])
  })

  it('未来的版本号照样取最高代（v5 优先于 v4）', async () => {
    const root = await makeTree([
      { project: 'p1', session: 's', name: 'session.v4.jsonl.zstd', mtime: NOW - 20 * HOUR },
      { project: 'p1', session: 's', name: 'session.v5.jsonl.zstd', mtime: NOW - 1 * HOUR },
    ])
    const candidates = await listRecentByFs({ root, lookbackHours: 24, maxObservations: 30, now: NOW })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.mtime).toBe(NOW - 1 * HOUR)
  })

  it('按 mtime 降序取前 maxObservations 个', async () => {
    const root = await makeTree([
      { project: 'p1', session: 'a', name: 'session.v4.jsonl.zstd', mtime: NOW - 5 * HOUR },
      { project: 'p1', session: 'b', name: 'session.v4.jsonl.zstd', mtime: NOW - 1 * HOUR },
      { project: 'p1', session: 'c', name: 'session.v4.jsonl.zstd', mtime: NOW - 3 * HOUR },
    ])
    const candidates = await listRecentByFs({ root, lookbackHours: 24, maxObservations: 2, now: NOW })
    expect(candidates.map((c) => c.sessionId)).toEqual(['b', 'c'])
  })

  it('非日志文件（session.lock、备份文件）不算候选', async () => {
    const root = await makeTree([
      { project: 'p1', session: 'only-lock', name: 'session.lock', mtime: NOW - 1 * HOUR },
      { project: 'p1', session: 'bak', name: 'session.v4.jsonl.zstd.bak-123', mtime: NOW - 1 * HOUR },
    ])
    const candidates = await listRecentByFs({ root, lookbackHours: 24, maxObservations: 30, now: NOW })
    expect(candidates).toEqual([])
  })

  it('根目录不存在 → 空候选，不抛', async () => {
    const candidates = await listRecentByFs({
      root: '/tmp/definitely-not-here-auto-resume',
      lookbackHours: 24,
      maxObservations: 30,
      now: NOW,
    })
    expect(candidates).toEqual([])
  })
})
