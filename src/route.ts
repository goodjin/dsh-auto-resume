/**
 * 只读健康路由 `/auto-resume/health`。
 *
 * 桌面版从 Finder 启动时宿主 stderr 没人接，日志行看不见；这条路由是
 * 「每次启动扫了谁、继续了谁、为什么跳过」的可靠查账入口。webServer 缺席
 * 时静默跳过——路由是观测面，不是主功能，不该让它挡装载。
 *
 * @module @goodjin2/dsh-auto-resume/route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 路由路径：GET only。 */
export const HEALTH_ROUTE_PATH = '/auto-resume/health'

/** 注册路由需要的宿主面（webServer 可缺席）。 */
export interface HealthRouteContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer?: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): unknown
  }
}

/**
 * 挂上只读账目路由。`getSnapshot` 在每次请求时取最新快照，
 * 所以路由不持有旧数据的引用。
 */
export function registerHealthRoute(ctx: HealthRouteContext, getSnapshot: () => unknown): void {
  if (ctx.webServer === undefined) return
  ctx.effect(
    () =>
      ctx.webServer?.register({
        kind: 'exact',
        path: HEALTH_ROUTE_PATH,
        async handler(_request, response) {
          respondJson(response, 200, JSON.stringify(getSnapshot()))
        },
      }),
    'auto-resume: /auto-resume/health 账目路由',
  )
}

/** JSON 应答：no-store + 显式长度（照 acp-agent 路由的写法）。 */
function respondJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}
