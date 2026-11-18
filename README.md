# @goodjin2/dsh-auto-resume

桌面版启动后，扫描所有项目下的会话，把**因异常原因停掉**（不是用户主动停的）的会话自动继续：

- 进程被杀 / 断电 / 崩溃留下的中断（宿主崩溃恢复合成的 `interrupted` 收尾）；
- 运行中出错：网络断开、超时（`error`）；
- 桌面版退出时被中断（`aborted`/`disposed`）；
- 排了队但轮次再没打开的待投递消息。

**用户主动停止的会话永不自动继续**（宿主以 `aborted`/`user` 收尾，本插件认这个语义）。
手动停一次就是这个会话的永久豁免，不需要别的开关。

## 行为

只在桌面版启动时扫描一次（延迟默认 8 秒），一次只向一个会话投递继续消息（间隔默认
2 秒）。只处理「最后一次活动在最近 24 小时内」的异常会话。继续消息可在配置里改模板。

### 暂时性失败的周期重试

网络断、超时、429 限速这类「过一会儿可能自己好」的失败（按摘要与稳定错误码识别，
如 `QUOTA_EXCEEDED`、`fetch failed`、`ECONNRESET`），插件会登记进重试账本：

- **中止当下就登记**：监听宿主的会话事件广播，轮次以这类失败收尾的当场进账本，
  不用等下一次重启；启动扫描也会补一遍（兜住应用没在运行期间发生的失败）；
- 每 `retryIntervalMs`（默认 10 分钟）看一眼，按日志尾部判走向：**重投之后那一轮
  正常跑完（续成功）**、或被用户手动停掉 → 摘出账本；**仍在同一处失败** → 记一次
  连续失败，并再投一次继续消息；
- 连续 `maxRetries`（默认 3）个周期仍在失败 → 放弃并**标记不再重试**（落盘，重启
  后启动扫描也不会再碰它；会话走出失败状态则标记解除，之后照常登记）；
- 账目路由的 `retries` 段能看到：账本路径、还在周期里的会话、已放弃的会话、
  最近一轮的动作（含 `overloadDone`：服务暂时不可用类按约定收手的会话）。

### 「服务暂时不可用」失败：等 5 分钟后只重试一次

服务端明说「这会儿处理不了、请稍后重试」的失败，秒级或十分钟内反复重投只会继续被拒。
覆盖这几种（都属于暂时性失败，会被登记）：

- `529 overloaded_error`、文案带「当前服务集群负载较高，请稍后重试」（MiniMax 现场）；
- `500` 等 5xx、`api_error`，中文「网络错误 / 网络异常」、`请稍后重试`
  （GLM 现场：`GLM request failed (500): …[网络错误…请稍后重试。]`）；
- 英文 `service unavailable` / `bad gateway` / `upstream error` 等。

它单列一个节奏：

- **等 `overloadRetryDelayMs`（默认 5 分钟）后重投一次**，然后就收手、从账本摘掉，
  不再进下一轮；这一次的成败都不再排队重试（想多试几次可把 `overloadMaxRetries` 调大）；
- 到点前若会话自己续成功或被用户停掉，直接摘出账本，不再投；
- 等待按**每个会话自己的到期时间**算（落在账本里，重启不丢）；
- `429` 限速、`401` 登录、纯超时**不**属于这一类，仍按 `retryIntervalMs`（默认 10 分钟）
  × `maxRetries`（默认 3）的普通节奏，两者互不干扰。

### 主会话在等子会话的形态

主会话常常已经输出完回答块、正在等子会话主动回话（宿主给模型的指导就是「只剩等
子代理结果时就结束本轮」）。这种形态下主会话那一轮是**正常结束**的，按会话级判定
会被当成「正常结束」跳过——但子会话的活儿停在半路，没人接手。

插件会额外认这一种形态：主会话正常结束 **且** 它的子代理目录里有子会话 **且** 那个
子会话自己也是异常收尾（宿主冷读补出的 `interrupted` / `disposed`）→ 判定为
「在等子会话」（账目原因 `awaiting-child`），主会话被叫醒，并且那些子会话一并恢复。

**子会话已经向主会话报告过结果的，不算「还在等」**：结算通知（来源标记
`subagent-settled`）在主会话日志里就说明主会话知道结果了，这时把它叫醒是多余的
（2026-11-09 现场：一个正常做完的会话被子会话的失败通知拖去重跑）。通知哪怕还躺在
收件箱里没被领取，也算数——结果已经送到了。

**该续的是子会话本身，不是主会话。** 主会话没被打扰，就不会重做已经做完的活。
恢复子会话走宿主给「人」留的正门：子会话归子代理路由管，通用会话投递会被拒
（`owned by subagent routing`），正门是把父会话挂上线（不带任何消息），再把一条
人写的提示排进子会话的收件箱（子会话不在内存里就按它的日志冷恢复）。子会话跑完，
宿主会把结算通知送到在线的父级，父级空闲时被叫起来收尾。

**挂线必须走 `sessionController.agents.resolveAgent`（`prompt()` 发消息前的同一
口子）**：冷恢复会按会话记录重挂 agentPreset，组合（预设/技能/本机工具）齐全。
绝不退回裸 `ctx.agents.resume`——它不带任何组合，挂出来的父级只剩 base 工具
（平台工具 + MCP 连接器），还会经子会话冷恢复的「从父级继承组合」传染给整棵
会话树，之后 GUI 继续对话也不自愈。2026-11-12 现场：一棵 73 工具的巡查会话树
被裸恢复成 42 工具，模型所有本机命令全部误落云盒子连接器（含一次误删盒子）。
正门缺席时宁可放弃子会话恢复（记明原因），不做裸挂线。

恢复不了的子会话（外部后端：Codex / Claude Code / ACP 等没有本地会话日志）不硬来，
由主会话重新委派。

扫描结果一行日志 + 只读状态路由 `GET /auto-resume/health`（返回最近一次启动的完整
账目：扫了谁、命中谁、继续了谁、跳过原因分布，以及子代理服务在不在、恢复了哪些子会话）。

## 安装

```sh
dsh plugin --profile <你的 profile> add github:goodjin/dsh-auto-resume
```

或者安装 npm 上的包（效果相同，同样免构建步骤）：

```sh
dsh plugin --profile <你的 profile> add @goodjin2/dsh-auto-resume
```

手工安装（桌面 profile）：

1. `package.json` 依赖加 `"@goodjin2/dsh-auto-resume": "link:<本仓库路径>"`；
2. `dsh.profile.bundles` 加一条 `@goodjin2/dsh-auto-resume`（bundle id = 包名）；
3. `pnpm install`；
4. 本包 `cordis.patch.yml` 的 `insert` 段合并进 profile 的 `cordis.patch.yml`；
5. 重开桌面版生效。

## 配置（挂载行 config）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；false 时装载但不扫描。 |
| `lookbackHours` | `24` | 只继续最后活动在此窗口内的会话。 |
| `startupDelayMs` | `8000` | 启动后延迟多久开始扫描。 |
| `staggerMs` | `2000` | 相邻两次投递的间隔。 |
| `includeError` | `true` | 是否继续 `error` 结尾的会话。 |
| `includeDisposed` | `true` | 是否继续桌面版退出中断的会话（`aborted`/`disposed`）。 |
| `maxObservations` | `30` | 一次启动最多整读多少个最近候选（成本护栏）。 |
| `resumeChildren` | `true` | 是否恢复被中断的子会话（经父会话的子代理路由正门）。 |
| `maxChildObservations` | `20` | 判定阶段最多读多少个子会话日志。 |
| `maxChildResumes` | `10` | 一次启动最多恢复多少个子会话。 |
| `retryIntervalMs` | `600000` | 普通暂时性失败的会话按这个周期重试；0 = 不周期重试。 |
| `maxRetries` | `3` | 普通暂时性失败连续失败到这个数就放弃并标记不再重试。 |
| `overloadRetryDelayMs` | `300000` | 「服务暂时不可用」类（5xx / 集群负载 / 网络错误等）等多久再重试（默认 5 分钟）；0 = 不等。 |
| `overloadMaxRetries` | `1` | 「服务暂时不可用」类最多重投几次（默认 1，等 5 分钟后重试一次）。 |
| `messageTemplate` | 见源码 `config.ts` | 继续消息模板，含 `{reason}`/`{time}` 占位符。 |
| `childMessageTemplate` | 见源码 `config.ts` | 给子会话的继续消息模板，含 `{parent}`/`{reason}`/`{time}` 占位符。 |

两个 `include*` 开关只管「本来该续、被开关挡下」的两类：

- **人工停止（`aborted`/`user`）不受任何开关影响**——手动停一次就是永久豁免，
  永远不会自动继续；
- `includeDisposed=false` 时，「桌面版退出时被中断」的会话不续，账目里的跳过
  原因写 `disposed-excluded`（`includeError=false` 同理写 `error-excluded`），
  一眼能看出是开关挡的，而不是「本来就正常结束」。

设计依据与判定规则全文见
[docs/superpowers/specs/2026-11-07-auto-resume-design.md](docs/superpowers/specs/2026-11-07-auto-resume-design.md)。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # 编译宿主产物 lib/host
pnpm check       # 类型检查 + 测试 + 产物是否与源码一致
```

仓库随附编译产物（`lib/host/**`）：装到 node_modules 之后宿主不能再靠剥离类型来装载
源码，所以入口指向编译后的 JS。改完源码要跑 `pnpm build` 并提交产物，
`pnpm check` 会检查产物是否与源码一致。

## 许可

MIT
