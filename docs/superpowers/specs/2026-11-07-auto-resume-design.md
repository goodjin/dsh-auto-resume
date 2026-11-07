# 自动继续异常中断会话插件（dsh-auto-resume）设计

日期：2026-11-07
状态：已批准（对话设计由用户确认「可以，执行吧」）
仓库：`/Users/good/github/dsh-plugins/dsh-auto-resume`（`@goodjin2/dsh-auto-resume`）

## 目的与成功标准

桌面版启动后，扫描**所有项目**下的会话，把**因异常原因停掉**（不是用户主动停的）
的会话自动继续：进程被杀 / 断电 / 崩溃留下的中断、运行中出错（网络断开、超时）、
桌面版退出时被中断的轮次。成功标准：

- 用户重启桌面版后，上次跑一半被异常停掉的会话自己接着跑，不需要逐个点继续。
- 用户主动停止过的会话**永不**被自动继续。
- 行为可见：每次启动有一行自述日志和一个只读状态路由，能查到扫了谁、继续了谁、为什么跳过。

## 范围与边界（与用户确认过的决定）

- **只在启动时扫描一次**；运行期间的异常断开不在本轮处理，等下次启动再继续。
- **限定最近时间窗**：只继续「最后一次活动在最近 N 小时内」的异常会话（默认 24 小时，可配）。
- 纯宿主侧插件，无浏览器半边，无设置页 UI；配置走挂载行 config（profile patch）。

## 宿主机制依据（官方文档与运行版本源码均已核对，2026-11-07，dsh 0.2.2-rc.1）

1. **轮次有持久化的结束原因**。`turn/end` 携带 `TurnEndReason`：`completed` /
   `aborted`（原因 `user`/`parent`/`disposed`/`hook`/`legacy`）/ `blocked` / `error`
   （结构化失败信息）/ `max-tokens` / `interrupted` / `forked`。见官方文档
   `docs/official/reference/subsystems/session.md` 的 `TurnEndReasonMap`。
2. **崩溃恢复是宿主读路径自带的**。日志尾部一轮没关上（进程被杀/断电）时，
   agent-loop resume 与 session-query 冷读都会合成 `interrupted` 收尾事件并补齐
   未决工具结果（`interruptedTurnClosers`）。见
   `docs/official/reference/subsystems/persistence.md`。
3. **用户主动停止**走 `sessionController.cancel` → `agent.cancel({ kind: 'user' })`
   → `turn/end` 原因 `aborted`/`user`。
4. **桌面版退出**对运行中的 agent 是宿主 fiber 优雅卸载 → `turn/end` 原因
   `aborted`/`disposed`；强杀/断电则留下开尾轮次（下次读取合成 `interrupted`）。
5. **收件箱语义**：用户消息先落在持久收件箱（`agent/inbox/spliced`），轮次打开时
   才记录为 `user/message`；带待投递收件箱的 agent 被 resume 后**不会**自动开轮次
   （源码 `initializeAgent`/`runMaintenance` 核实）。用户停止保留收件箱
   （`keepInbox: true`）。
6. **枚举与继续的入口**：`ctx.sessionQuery.listSessions()`（全部持久 + 在册会话）、
   `ctx.sessionQuery.observeSession(id)`（整段事件，含合成的 `interrupted` 收尾；
   租约同时带回会话头 `header`）、`ctx.agents.get(id)`（在册/运行中）、
   `ctx.workspaceRegistry.archivedSessionIds`（已归档）、
   `ctx.sessionController.prompt({ requestId, sessionId, mode, content })`
   （与界面发送同一条路，会话自动 resume 后投递）。

   > **2026-11-07 现场修正（核对 dsh 0.2.2-rc.1 源码 + 本机实测）**：候选枚举
   > **不再**用 `ctx.sessionPersistence.stat(id)` 逐会话拿日志路径。该调用在
   > JSONL 后端里要遍历全部项目目录定位日志（实测 ~20ms/会话），遇到 v3 等历史
   > 格式会话还要每次重算一遍**全语料 revision**（本机 1329 个历史会话）——对
   > 全量会话逐个调用，一次启动扫描要十几分钟起步；预筛一旦缺席还会退化成
   > 对 9000+ 个会话逐个 `observeSession`（整读 + 回放校验 1.4GB 日志），把宿主
   > 内存读到 1.2GB。改为 fs 直查最近候选（见下）。

## 候选枚举（2026-11-07 现场修正）

会话库布局（`$DSH_HOME/sessions`，缺省 `~/.dsh/sessions`）：
`<项目目录>/<会话 id>/session.<版本>.jsonl[.zstd]`；会话目录名即会话 id。

枚举走 fs 直查（`src/recent.ts`）：两轮 readdir（项目目录 → 会话目录）加每个
会话一次直路径 `stat`，按日志 mtime 取窗口内最近活动过的会话，取版本号最高的
那一代日志；mtime 降序后最多取 `maxObservations`（默认 30）个进整读。

配套护栏：

- 观察单个会话有 15s 硬超时，坏日志 / 卡住的会话不拖死整场扫描；
- mtime 拿不到的会话 fail closed 跳过（旧会话不读，也不漏判）；
- 子代理会话在**观察之后**按租约带回的会话头判定（`origin` / `parentSession`），
  跳过不投递——fs 通道枚举不到会话元数据，投过去宿主会回
  「owned by subagent routing」。

## 「主会话在等子会话」的形态（2026-11-07 现场追加）

主会话常常已经输出完回答块、正在等子会话主动回话（宿主给模型的指导：「只剩等它们
的结果时，结束本轮，而不是休眠或轮询」）。这种形态下主会话那一轮是**正常结束**的
（`turn/end` = `completed`），按会话级判定会被当成「正常结束」跳过——但子会话的活
儿停在半路，没人接手。

宿主机制依据（核对 dsh 0.2.2-rc.1 源码）：

1. **子代理目录事实**：每创建一个子会话，宿主往父会话追加一条 `subagent/catalog`
   事实（`childId` / `childCreatedAt` / `mode` / `label`）。目录只记成员关系，
   **不记执行状态**。
2. **子会话的收尾看它自己的日志**：轮次还开着时，宿主冷读补出的收尾是
   `interrupted`（进程被杀）或 `disposed`（应用退出）——和顶层会话同一套判定器。
3. **通用投递对子会话一律被拒**：`owned by subagent routing … use subagent delivery
   for this child session`。正门是子代理服务上的「人写的提示」入口
   （`queuePrompt`：父 agent 在线时把提示排进子会话收件箱；子会话不在内存里就按它
   的日志冷恢复，前提是它的描述符写着「可继续」）。
4. **结算通知只送给在线的直接父级**：子会话结算时宿主先查「父会话是不是还是那个
   活着的 agent 实例」，不是就直接返回、不投递也不落盘（只留一条 warn）。宿主没有
   持久化父级信箱——所以**父 agent 必须先上线**，否则子会话跑完的结果没人收。

判定与动作：

| 主会话收尾 | 子会话收尾 | 判定 | 动作 |
| --- | --- | --- | --- |
| 异常（interrupted / error / disposed） | — | 照旧续 | 续主会话 |
| 正常结束 | 异常收尾 | `awaiting-child` | 续主会话 **且** 恢复那些子会话 |
| 正常结束 | 正常结束 / 用户停过 | `normal-end` | 跳过 |
| 正常结束 | 外部后端（无本地会话日志） | `normal-end` | 跳过（由主会话重新委派） |

执行顺序是硬约束：主会话先投（父 agent 上线），再往子会话投递；主会话的继续消息里
点名正在被拉起来的子会话，免得模型以为没人管、重新委派一遍同样的活。

## 判定规则

输入：一个会话的完整事件序列（`observeSession` 返回，尾部开轮次已被宿主补成
`interrupted`）、配置、当前时间。输出：继续（带原因）或跳过（带原因）。

扫描流程（scan.ts）：fs 直查拿最近候选 → 按第 3、4、5 条过滤（子代理、归档、
运行中）→ 逐个 `observeSession(id)` 读事件进判定器（带 15s 超时）→ 收集候选，
按 `staggerMs` 逐个投递。

按顺序：

1. 无任何事件 → 跳过（空白会话）。
2. 最后事件时间早于时间窗（`now - lookbackHours`）→ 跳过（窗外）。
3. `header.origin === 'subagent'` 或 `header.parentSession` 存在 → 跳过（子代理会话，
   归父会话路由管）。此条在扫描层过滤，不在判定器内——fs 直查通道枚举不到
   会话元数据，改在观察之后按租约带回的会话头判定（效果相同，少一次投递）。
4. 已归档（`archivedSessionIds` 命中）→ 跳过。同上，扫描层过滤。
5. 会话正在运行（`agents.get(id)` 的 agent `status === 'running'`）→ 跳过。
   在册但空闲（attached-idle，用户开着会话没在跑）→ 仍继续——这正是本插件要替
   用户省掉的那次手动点击。扫描层过滤。
6. **没有任何 `turn/end`**：
   - 存在 `user/message` 或 `agent/inbox/spliced` → **继续**（原因 `interrupted`：
     消息已收下但轮次从未打开——停止操作不可能产生这种形态，因为没有可停的轮次）。
   - 否则 → 跳过（没有实质内容）。
7. **有 `turn/end`**，取最后一轮的原因：
   - `aborted` 且原因是 `user` → **跳过**（用户主动停止；哪怕收件箱里还留着用户自己的
     消息——那是停止语义故意保留的，属于用户的决定）。
   - `interrupted` → **继续**（崩溃 / 被杀 / 断电）。
   - `error` → **继续**（配置 `includeError`，默认开；原因摘要取 `error.message`）。
   - `aborted` 且原因是 `disposed` → **继续**（配置 `includeDisposed`，默认开；
     桌面版退出）。
   - `aborted` 且原因是 `parent`/`hook`/`legacy` → 跳过（父会话或钩子的主动行为，
     不是「异常」）。
   - `completed` / `max-tokens` / `blocked` → 跳过，**除非**最后一个 `turn/end` 之后
     存在 `agent/inbox/spliced`（用户排了队但轮次再没打开，应用退出了）→
     **继续**（原因 `interrupted`：排队消息未投递）。

## 继续动作

对每个命中会话调用 `sessionController.prompt`：

- `requestId`：每次一个新 UUID。
- `mode`: `'followup'`（唤醒驱动器；会话自动 resume，宿主自动补中断收尾，模型带着
  完整历史接着跑，收件箱里旧的待投递消息一并被领取）。
- `content`: 单个 text 片段，文案来自配置模板（默认中文），占位符 `{reason}`（人话原因）
  与 `{time}`（本地时间）由代码替换。
- 失败（会话冲突、写入被占等）记入账目，不中断其它会话。

默认模板：

> 【自动恢复】检测到本会话上次因异常中断而停止（原因：{reason}，时间：{time}）。
> 请从中断处继续完成任务。如果任务其实已完成或已不再需要，请简要说明现状后结束，
> 不要重新开始已做完的工作。

原因措辞：`interrupted` → 「应用退出或进程中断」；`error` → 「运行中出错（{detail}）」；
`disposed` → 「桌面版退出时被中断」；`queued`（第 7 条的排队形态）→ 「排队消息未投递」。

## 防护

- 每次启动每个会话最多继续一次（本次扫描内天然去重）。
- 一次只向一个会话投递，间隔 `staggerMs`（默认 2000），避免多会话同时开跑。
- 「不再自动继续这个会话」的出口就是宿主已有语义：手动停一次 → `aborted`/`user`
  → 永不命中。不引入插件自己的开关账本（YAGNI）。
- 已知边界：持续性错误（如配额用尽）的会话每次启动会被再试一次并失败一次，
  聊天里可见。接受此行为。

## 观测性

- 扫描结束打一行自述：扫了多少、窗口内几个、命中几个、继续了谁（含原因）、
  跳过分布（原因计数）。日志走 `console.info`（宿主行日志）。
- 只读 GET 路由 `/auto-resume/health`：返回最近一次启动扫描的完整账目 JSON
  （配置、会话清单及各自判定、继续结果、时间戳）。桌面版 stderr 没人接时，
  这是唯一可靠的查账入口。`webServer` 缺席时跳过路由，不影响主功能。

## 配置（挂载行 config）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；false 时本行装载但不扫描。 |
| `lookbackHours` | `24` | 只继续最后活动在此窗口内的会话。 |
| `startupDelayMs` | `8000` | 装载后延迟多久开始扫描（等服务稳定）。 |
| `staggerMs` | `2000` | 相邻两次投递的间隔。 |
| `includeError` | `true` | 是否继续 `error` 结尾的会话。 |
| `includeDisposed` | `true` | 是否继续 `aborted`/`disposed` 结尾的会话。 |
| `maxObservations` | `30` | 一次启动最多整读多少个最近候选（成本护栏）。 |
| `messageTemplate` | 见上 | 继续消息模板，含 `{reason}`/`{time}`。 |

`interrupted` 与排队形态不受开关保护（它们就是本插件的存在理由）；`includeError` /
`includeDisposed` 各自可关。

## 结构（单包，宿主侧）

```
src/
  index.ts          入口：name / inject / apply（排期扫描 + 挂路由）
  config.ts         Config schema（schemastery）+ 默认值 + 模板渲染
  classify.ts       纯判定器：events → verdict（无宿主依赖，单测覆盖）
  scan.ts           扫描编排：枚举 → 过滤 → mtime 预筛 → 判定 → 产出候选
  deliver.ts        投递：逐个 sessionController.prompt，收集结果
  route.ts          /auto-resume/health 只读路由
tests/
  classify.test.ts  判定规则全分支
  scan.test.ts      假服务编排：过滤、预筛、去重、失败隔离
  deliver.test.ts   模板渲染与投递记录
  wiring.test.ts    接线：package.json dsh 段 / patch 行 / 入口形状
```

`inject`: `['sessionQuery', 'agents', 'workspaceRegistry', 'sessionController']`
（必需，缺席即行装载失败——fail loud）。`sessionPersistence`、`webServer` 用
`ctx.get` / `ctx.inject` 机会式取用：前者只影响预筛效率，后者只影响路由。

## 测试策略

- 判定器：表格化用例覆盖第 6、7 条全部分支 + 时间窗边界 + 排队形态 + 用户停止优先。
- 扫描编排：注入假 `sessionQuery`/`agents`/`workspaceRegistry`/`sessionPersistence`，
  断言子代理/归档/运行中过滤、mtime 预筛短路、单会话判定失败不影响整体。
- 投递：假 `sessionController`，断言模板渲染、顺序投递、单点失败不拦整体。
- 接线：断言 package.json `dsh.bundle.patch` 指向存在的 patch 文件、patch 行 name
  是裸包名、包入口导出 `name`/`inject`/`apply`/`Config`（防「装上不生效」静默失败）。

## 接线与验收

- desktop profile：`package.json` 加 `"@goodjin2/dsh-auto-resume": "link:…/dsh-auto-resume"`
  + `dsh.profile.bundles` 一条（bundle id = 包名），`pnpm install`。
- 跑容器规范 `scripts/check-host-rows.mjs`，两个宿主全绿。
- 桌面版重开由用户执行（规范约定，不代劳）；验收观察启动日志行与
  `/auto-resume/health` 账目。
- 合并回 main 后更新容器 `AGENTS.md` 的仓库清点与归属映射。

## 非目标（本轮不做）

- 运行期间异常断开的即时自动继续。
- 防反复失败的重试账本（用户手动停止即永久豁免，已够用）。
- 设置页 / 浏览器半边 UI。
