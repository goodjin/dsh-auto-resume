/**
 * fs 直查最近候选：不经过宿主的逐会话枚举，从会话库里按 mtime 找出最近
 * 活动过的会话。
 *
 * 为什么要有这条通道（2026-11-07 现场）：宿主 `sessionPersistence.stat(id)`
 * 对每个会话都要遍历全部项目目录定位日志（实测 ~20ms/会话），遇到历史格式
 * 还要重算全语料 revision——对全量会话逐个调用会把一次启动扫描拖成十几分钟，
 * 预筛一旦缺席还会退化成逐会话整读，把宿主内存读爆。fs 直查是两轮 readdir
 * 加每会话一次直路径 stat，微秒级，且不可能挂。
 *
 * 目录约定（DSH 会话库）：`<root>/<项目目录>/<会话 id>/session.<版本>.jsonl[.zstd]`。
 * 会话目录名即会话 id；日志文件名带版本号，取目录里版本号最高的那一份。
 *
 * @module @goodjin2/dsh-auto-resume/recent
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一个最近候选：会话 id + 日志文件时间。 */
export interface RecentCandidate {
  sessionId: string
  mtime: number
}

/** fs 直查的输入。 */
export interface RecentFsOptions {
  /** 会话库根目录（`<DSH_HOME>/sessions`）。 */
  root: string
  /** 只看最近这么多小时内的活动。 */
  lookbackHours: number
  /** 最多返回多少个候选（按 mtime 降序取前 N）。 */
  maxObservations: number
  /** 当前时间（毫秒）。 */
  now: number
}

/** 会话库根目录：`$DSH_HOME/sessions`，缺省 `~/.dsh/sessions`。 */
export function sessionsRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * 日志文件名 → 版本号；不是日志文件回 undefined。
 * `session.v4.jsonl.zstd` → 4，`session.jsonl.zstd` → 0，`session.lock` → undefined。
 */
function logVersion(name: string): number | undefined {
  const match = /^session\.(?:v(\d+)\.)?jsonl(?:\.zstd)?$/.exec(name)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * 枚举窗口内最近活动过的会话，按 mtime 降序，最多 `maxObservations` 个。
 * 根目录不存在或读不动时回空列表（不抛：枚举失败不该带崩整场扫描）。
 */
export async function listRecentByFs(options: RecentFsOptions): Promise<RecentCandidate[]> {
  const windowStart = options.now - options.lookbackHours * 3_600_000
  const candidates: RecentCandidate[] = []

  let projects
  try {
    projects = await readdir(options.root, { withFileTypes: true })
  } catch {
    return []
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(options.root, project.name)
    let sessions
    try {
      sessions = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const path = await newestLogPath(join(projectPath, session.name))
      if (path === undefined) continue
      let mtime: number
      try {
        mtime = (await stat(path)).mtimeMs
      } catch {
        continue
      }
      if (mtime < windowStart) continue
      candidates.push({ sessionId: session.name, mtime })
    }
  }

  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates.slice(0, Math.max(options.maxObservations, 0))
}

/** 会话目录里版本号最高的日志文件路径；没有日志文件回 undefined。 */
async function newestLogPath(dir: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  let best: { path: string; version: number } | undefined
  for (const name of entries) {
    const version = logVersion(name)
    if (version === undefined) continue
    if (best === undefined || version > best.version) best = { path: join(dir, name), version }
  }
  return best?.path
}
