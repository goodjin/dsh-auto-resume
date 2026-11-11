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
- 每 `retryIntervalMs`（默认 10 分钟）看一眼：会话已经走完/被用户停了 → 摘出账本；
  还在同一处失败 → 记一次连续失败，并再投一次继续消息；
- 连续 `maxRetries`（默认 3）个周期仍在失败 → 放弃并**标记不再重试**（落盘，重启
  后启动扫描也不会再碰它；会话走出失败状态则标记解除，之后照常登记）；
- 账目路由的 `retries` 段能看到：账本路径、还在周期里的会话、已放弃的会话、
  最近一轮的动作。

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

恢复不了的子会话（外部后端：Codex / Claude Code / ACP 等没有本地会话日志）不硬来，
由主会话重新委派。

扫描结果一行日志 + 只读状态路由 `GET /auto-resume/health`（返回最近一次启动的完整
账目：扫了谁、命中谁、继续了谁、跳过原因分布，以及子代理服务在不在、恢复了哪些子会话）。

## 安装（桌面 profile）

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
| `retryIntervalMs` | `600000` | 暂时性失败的会话按这个周期重试；0 = 不周期重试。 |
| `maxRetries` | `3` | 连续失败到这个数就放弃并标记不再重试。 |
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
```

无构建产物：宿主以 strip-only 方式直接装载 `src/*.ts`（与
`dsh-command-commit-merge-push` 同款）。

## 许可

MIT
