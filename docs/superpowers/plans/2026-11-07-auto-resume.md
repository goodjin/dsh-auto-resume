# dsh-auto-resume 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面版启动后扫描全部会话，自动继续因异常停掉的（崩溃/网络断/超时/应用退出），用户主动停的永不继续。

**Architecture:** 纯宿主侧插件。注入宿主服务枚举与判定，`sessionController.prompt` 投递继续消息（与界面发送同路）；判定器是纯函数，编排与投递各一文件，只读健康路由自报账目。

**Tech Stack:** TypeScript（宿主 strip-only 直载，无构建）、vitest、`@deepseek-ai/schemastery`。

**Spec:** `docs/superpowers/specs/2026-11-07-auto-resume-design.md`

## Global Constraints

- 包名 `@goodjin2/dsh-auto-resume`；服务名导出 `name = 'auto-resume'`；路由路径 `/auto-resume/health`。
- `inject = ['sessionQuery', 'agents', 'workspaceRegistry', 'sessionController']`（必需）；`sessionPersistence`、`webServer` 机会式取用，缺席不挡主功能。
- 默认值：`enabled=true, lookbackHours=24, startupDelayMs=8000, staggerMs=2000, includeError=true, includeDisposed=true`，模板字符串见 Task 1（含 `{reason}`/`{time}` 占位符）。
- 用户停止（`aborted`/`user`）优先级最高：即使尾部有排队消息也跳过。
- 子代理（`origin === 'subagent'` 或有 `parentSession`）、已归档、运行中（`status === 'running'`）的会话在扫描层过滤；attached-idle 仍继续。
- 每个 TypeScript 文件带模块级中文 doc comment；测试中文描述。
- 门禁：`pnpm typecheck` 与 `pnpm test` 全绿；容器 `scripts/check-host-rows.mjs` 两宿主绿（合并后跑）。

## Review Focus

1. **用户停止 + 收件箱滞留**：停过的会话哪怕 inbox 还留着用户自己的消息，也必须跳过——停止语义故意保留队列。→ Task 2 用例「用户停止优先于排队消息」。
2. **空事件序列**：`events.length === 0` 不得抛错，按空白跳过。→ Task 2 用例。
3. **单会话读取失败**（日志损坏等）：账目记一行 error 跳过，其余会话照常判定。→ Task 3 用例。
4. **单点投递失败**（writer-held / 会话冲突）：只标记该会话 `ok:false`，不拦其余投递。→ Task 4 用例。
5. **未知结束原因**（`TurnEndReasonMap` 可合并扩展）：保守按普通结束跳过，不误继续。→ Task 2 用例。

---

### Task 1: 配置与模板（config.ts）

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `interface ResolvedConfig { enabled: boolean; lookbackHours: number; startupDelayMs: number; staggerMs: number; includeError: boolean; includeDisposed: boolean; messageTemplate: string }`；`resolveConfig(raw: unknown): ResolvedConfig`（缺省补默认、数值负数取 0）；`renderMessage(template: string, reason: string, time: string): string`（替换 `{reason}`/`{time}` 全部出现）；`export const Config: Schema<AutoResumeConfig>`（schemastery object，键与默认值同上，供声明行核查）。

- [ ] **Step 1: 写失败测试** `tests/config.test.ts`：空对象 resolve 得全默认；`renderMessage('原因:{reason}@{time}再{reason}', 'x', 't')` === `'原因:x@t再x'`；负数 `lookbackHours: -5` resolve 成 `0`。
- [ ] **Step 2:** `pnpm vitest run tests/config.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3:** 实现 `src/config.ts`。默认模板常量 `DEFAULT_MESSAGE_TEMPLATE`：

```
【自动恢复】检测到本会话上次因异常中断而停止（原因：{reason}，时间：{time}）。
请从中断处继续完成任务。如果任务其实已完成或已不再需要，请简要说明现状后结束，不要重新开始已做完的工作。
```

- [ ] **Step 4:** 复跑 → PASS。`git commit -m "feat: 配置解析与继续消息模板"`。

### Task 2: 判定器（classify.ts）

**Files:**
- Create: `src/classify.ts`
- Test: `tests/classify.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `type ContinueCause = 'interrupted' | 'error' | 'disposed' | 'queued'`；`type Verdict = { action: 'continue'; cause: ContinueCause; detail?: string; lastTime: number } | { action: 'skip'; cause: 'blank' | 'outside-window' | 'user-stopped' | 'normal-end' | 'cancel-by-parent-or-hook'; lastTime: number }`；`interface SessionEventLike { type: string; time: number; data?: Record<string, unknown> }`；`interface ClassifyOptions { now: number; lookbackHours: number; includeError: boolean; includeDisposed: boolean }`；`classifySession(events: readonly SessionEventLike[], options: ClassifyOptions): Verdict`。

- [ ] **Step 1: 写失败测试** `tests/classify.test.ts`，表格化覆盖（`now` 固定值）：
  - 空数组 → skip `blank`；
  - 末事件时间在窗外 → skip `outside-window`（边界：恰好 `lookbackHours*3600_000` 前 → 继续/跳过的判定以 `now - lastTime > 窗口毫秒` 为准，等于不算窗外）；
  - 无 `turn/end` 且无 `user/message`/`agent/inbox/spliced` → skip `blank`；
  - 无 `turn/end` 但有 `user/message` → continue `interrupted`；
  - 无 `turn/end` 但有 `agent/inbox/spliced` → continue `interrupted`；
  - 末轮 `turn/end` `reason.kind='interrupted'` → continue `interrupted`；
  - 末轮 `error` 且 `includeError=true` → continue `error` 且 `detail` 取 `data.reason.error.message`；`includeError=false` → skip；
  - 末轮 `aborted` 原因 `disposed`：`includeDisposed=true` → continue `disposed`；false → skip；
  - 末轮 `aborted` 原因 `user`（尾部另加一条 `agent/inbox/spliced`）→ skip `user-stopped`（Review Focus 1）；
  - 末轮 `aborted` 原因 `parent`/`hook` → skip `cancel-by-parent-or-hook`；
  - 末轮 `completed` + 尾部有 `agent/inbox/spliced` → continue `queued`；无尾部 → skip `normal-end`；
  - 末轮 `max-tokens`/`blocked`/`forked` 无尾部 → skip `normal-end`；
  - 末轮 reason 为未知 kind `{kind:'mystery'}` → skip `normal-end`（Review Focus 5）。
- [ ] **Step 2:** `pnpm vitest run tests/classify.test.ts` → FAIL。
- [ ] **Step 3:** 实现。算法：找最后一个 `turn/end` 的下标与 `data.reason`；扫描其后的 `user/message`/`agent/inbox/spliced` 记 `pendingAfter`；按 spec 判定表分支。`error.detail` = `String(message ?? error 序列化)` 截 200 字符。
- [ ] **Step 4:** 复跑 → PASS。`git commit -m "feat: 异常中断判定器（纯函数全分支）"`。

### Task 3: 扫描编排（scan.ts）

**Files:**
- Create: `src/scan.ts`
- Test: `tests/scan.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `classifySession`/`Verdict`/`SessionEventLike`。
- Produces:
  - `interface ScanHosts { sessionQuery: { listSessions(): Promise<SessionRecordLike[]>; observeSession(id: string): Promise<SessionObservationLike> }; agents: { get(id: string): { status?: string } | undefined }; workspaceRegistry: { archivedSessionIds: readonly string[] } ; sessionPersistence?: { stat(id: string): Promise<StatLike | undefined> } }`，其中 `SessionRecordLike = { header: { id: string; cwd?: string; origin?: string; parentSession?: string } }`，`SessionObservationLike = { events: SessionEventLike[] } & { [Symbol.dispose]?: () => void }`，`StatLike = { location?: { path?: string } }`。
  - `interface ScanIo { statMtime(path: string): Promise<number | undefined> }`
  - `interface ScanLedgerRow { sessionId: string; cwd?: string; action: 'continue' | 'skip'; cause: string; detail?: string; lastTime: number }`
  - `scanSessions(hosts: ScanHosts, options: ClassifyOptions, io: ScanIo): Promise<ScanLedgerRow[]>`（候选即 `action==='continue'` 的行）。

- [ ] **Step 1: 写失败测试** `tests/scan.test.ts`（假 hosts 对象）：
  - 子代理（`origin:'subagent'`）与有 `parentSession` 的 → skip `subagent`，且不调 `observeSession`；
  - `archivedSessionIds` 命中 → skip `archived`，不调 `observeSession`；
  - `agents.get(id)` 返回 `{status:'running'}` → skip `running`；返回 `{status:'idle'}` → 仍判定（attached-idle）；
  - `stat` 给 mtime 早于窗口起点 → skip `outside-window`，不调 `observeSession`；`stat`/`statMtime` 缺席或返回 undefined → 照常观察；
  - `observeSession` 抛错 → 该会话 skip `cause` 以 `error:` 开头，其余会话正常进判定（Review Focus 3）；
  - observation 带 `[Symbol.dispose]` → 判定后恰好调用一次。
- [ ] **Step 2:** `pnpm vitest run tests/scan.test.ts` → FAIL。
- [ ] **Step 3:** 实现：`listSessions` → 逐会话 try/catch（catch 记 `error:` 行继续）→ 三层过滤 → mtime 预筛（`stat().location.path` → `io.statMtime`）→ `observeSession` → `classifySession` → ledger 行。dispose 用 `typeof observation[Symbol.dispose] === 'function'` 守卫。
- [ ] **Step 4:** 复跑 → PASS。`git commit -m "feat: 全量会话扫描编排（过滤+预筛+失败隔离）"`。

### Task 4: 投递（deliver.ts）

**Files:**
- Create: `src/deliver.ts`
- Test: `tests/deliver.test.ts`

**Interfaces:**
- Consumes: Task 1 `renderMessage`；Task 2 `Verdict`（continue 分支）。
- Produces:
  - `interface DeliveryTarget { sessionId: string; cause: string; detail?: string; lastTime: number }`
  - `interface PromptHost { prompt(request: { requestId: string; sessionId: string; mode: 'followup'; content: Array<{ type: 'text'; text: string }> }): Promise<unknown> }`
  - `interface DeliverIo { sleep(ms: number): Promise<void>; now(): number; uuid(): string }`
  - `deliverContinuations(targets: DeliveryTarget[], promptHost: PromptHost, template: string, staggerMs: number, io: DeliverIo): Promise<Array<{ sessionId: string; ok: boolean; detail?: string }>>`

- [ ] **Step 1: 写失败测试** `tests/deliver.test.ts`：
  - 两个目标：prompt 被调两次，content 是单个 text 片段、文本为模板渲染（`{reason}` 按目标 cause 的人话措辞替换、`{time}` 为 `now()` 的本地格式），`mode:'followup'`，两次 `requestId` 不同；
  - 间隔：staggerMs=50 时两次 prompt 之间 sleep(50) 恰好一次（最后一个目标后不 sleep）；
  - 第一个目标 prompt 抛错 → 结果 `{ok:false, detail含错误消息}`，第二个目标照常投递（Review Focus 4）。
- [ ] **Step 2:** `pnpm vitest run tests/deliver.test.ts` → FAIL。
- [ ] **Step 3:** 实现。cause → 人话：`interrupted`→「应用退出或进程中断」；`queued`→「排队消息未投递」；`disposed`→「桌面版退出时被中断」；`error`→`'运行中出错（' + detail + '）'`。时间格式 `YYYY-MM-DD HH:mm`（本地时区，手写格式化）。顺序 await，目标间 `io.sleep(staggerMs)`。
- [ ] **Step 4:** 复跑 → PASS。`git commit -m "feat: 逐会话投递继续消息（失败隔离+节流）"`。

### Task 5: 入口与健康路由（index.ts、route.ts）

**Files:**
- Create: `src/route.ts`、`src/index.ts`
- Test: `tests/wiring.test.ts`、`tests/scan.test.ts`（不新增；wiring 覆盖接线）

**Interfaces:**
- Consumes: Task 1–4 全部导出。
- Produces: `src/index.ts` 导出 `name = 'auto-resume'`、`inject`、`Config`、`apply(ctx, rawConfig)`；`src/route.ts` 导出 `HEALTH_ROUTE_PATH = '/auto-resume/health'`、`registerHealthRoute(ctx: { effect(f, label?): unknown; inject?(deps: string[], body: (child: unknown) => void): unknown }, getSnapshot: () => unknown): void`（`webServer` 缺席时静默跳过）。

- [ ] **Step 1: 写失败测试** `tests/wiring.test.ts`：
  - 读 `package.json`：`dsh.bundle.patch === './cordis.patch.yml'` 且该文件存在；`exports['.'].default === './src/index.ts'`；无 `dsh.client` 键；
  - 读 `cordis.patch.yml` 文本：含 `name: '@goodjin2/dsh-auto-resume'`（裸包名行）；
  - 动态 import `src/index.ts`：`name`、`inject` 数组含四个必需服务、`apply` 与 `Config` 为函数/对象；
  - `apply` 行为（假 ctx + 假 hosts，`startupDelayMs: 0`）：await 宏任务后扫描执行过一次、投递按候选发生、`console.info` 输出一行含 `auto-resume:` 与统计；`enabled:false` 时不扫描；`ctx.inject` 被 `['webServer']` 调用过；dispose effect 能清掉定时器（ctx.effect 收到的 disposer 可调用且不抛）。
- [ ] **Step 2:** `pnpm vitest run tests/wiring.test.ts` → FAIL。
- [ ] **Step 3:** 实现 `route.ts`（照 delegation-route 的 respondJson 写法：no-store + content-length）与 `index.ts`：`apply` 里 `resolveConfig` → `enabled` false 则只挂路由返回；否则 `ctx.effect` 包一个 setTimeout（`.unref()`，disposer 清它）到点跑 `scanSessions`（`io.statMtime` 用 `node:fs/promises` 的 stat mtimeMs）→ `deliverContinuations`（`io.sleep` 用 setTimeout Promise、`uuid` 用 `node:crypto` randomUUID、`now` 用 `Date.now`）→ 组装快照 → `console.info` 一行 → 存最新快照供路由读。路由用 `ctx.inject?.(['webServer'], child => register…)` 机会式挂。
- [ ] **Step 4:** `pnpm vitest run` 全绿 + `pnpm typecheck` 绿。
- [ ] **Step 5:** `git commit -m "feat: 入口编排与 /auto-resume/health 账目路由"`。

### Task 6: 合并与接线（worktree 外）

**Files:** 无新文件；操作 desktop profile 与容器 AGENTS.md。

- [ ] **Step 1:** worktree 里 `pnpm install`、`pnpm typecheck`、`pnpm test` 全绿后，在插件仓 merge 分支回 `main`，删工作分支与 worktree。
- [ ] **Step 2:** desktop profile `~/.dsh/profiles/desktop/package.json` 加 `"@goodjin2/dsh-auto-resume": "link:/Users/good/github/dsh-plugins/dsh-auto-resume"`，`dsh.profile.bundles` 加 `"@goodjin2/dsh-auto-resume"`（bundle id = 包名）；`cordis.patch.yml` 合并本包 insert 段；`pnpm install`。
- [ ] **Step 3:** `node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs` → 退出码 0，两宿主各「0 处问题」。
- [ ] **Step 4:** 容器 `AGENTS.md`：仓库清点与新插件归属映射各补一行。
- [ ] **Step 5:** 提示用户重开桌面版验收（规范约定不代劳）；git remote 指到 `git+https://github.com/goodjin/dsh-auto-resume.git`，push 交用户或明确授权后执行。
