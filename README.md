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

扫描结果一行日志 + 只读状态路由 `GET /auto-resume/health`（返回最近一次启动的完整
账目：扫了谁、命中谁、继续了谁、跳过原因分布）。

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
| `includeDisposed` | `true` | 是否继续桌面版退出中断的会话。 |
| `messageTemplate` | 见源码 `config.ts` | 继续消息模板，含 `{reason}`/`{time}` 占位符。 |

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
