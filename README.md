# ai-host-proto

本项目是一个本地 `Codex` host 原型，目标是把 `Codex CLI` 和后续 IDE 接入纳入统一的 **managed session 控制平面**。

当前实现与 `docs/plan.md` 对齐后的真实状态如下：

- Host 先生成 `hostSessionId`
- `exec-json` CLI 是当前最完整、最稳定的主路径
- `tty` CLI 是体验优先次路径
- `app-server` direct managed CLI 已可用并已验证
- `sdk/thread` 已实现为实验性 compatibility shim，底层复用 `codex app-server`
- VS Code wrapper 仍是实验性接入
- wrapper-managed IDE 已支持注册、runtime 跟踪，以及在 `app-server` 代理模式下的有限协议事件观测

## 当前状态

已完成：

- 本地 HTTP host 服务
- session registry、事件持久化、host 重启恢复
- `exec-json` CLI 启动、续写、事件采集
- `tty` CLI 启动与基础状态跟踪
- `app-server` direct managed CLI 路径
- `sdk/thread` compatibility 路径
- approval queue、policy engine、人工决策接口
- SSE 事件流与本地 watch 命令
- wrapper-managed IDE 的注册、runtime 跟踪
- wrapper-managed 在 `app-server` 代理模式下的 assistant output / approval observation

部分完成：

- wrapper-managed IDE 的协议事件映射：已有可用 PoC，但覆盖还不完整
- IDE 路径的 HiTL：当前以观测链路为主，不承诺稳定自动回注
- IDE 路径的消息注入：仍然只是条件能力 / PoC 边界

未完成：

- 真正长期路线的自研 extension / panel
- wrapper-managed IDE 的稳定可控输入闭环
- wrapper-managed IDE 的稳定 approval 自动回注
- 更完整的 `codex/event/*` 到结构化 host event 的映射覆盖

## 目录结构

```txt
bin/
  codex-wrapper.cmd         Windows wrapper 入口
docs/
  plan.md                   当前方案与实施状态
src/
  server.js                 本地 host HTTP 服务
  host/
    app-server-client.js    app-server / sdk-thread compatibility transport
    approval-service.js     approval 服务与决策回调
    codex-cli.js            CLI launcher / adapter
    codex-event-parser.js   Codex JSONL 事件映射
    session-registry.js     session 与事件存储
    utils.js                通用工具
  wrapper/
    codex-wrapper.js        实验性 wrapper / app-server 代理
test/
  *.test.js                 当前单测
```

## 环境要求

- Windows
- Node.js 22+
- 已安装并可运行 `codex`

当前原型使用原生 Node.js，不依赖第三方 npm 包。

## 启动 Host

```powershell
node src/server.js
```

默认监听：

```txt
http://127.0.0.1:7788
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:7788/health
```

## 命令包装器

项目内置包装器：

- `bin\codex-cli.cmd`
- `bin\codex-ide.cmd`
- `bin\codex-watch.cmd`
- `bin\codex-approvals.cmd`
- `bin\codex-approve.cmd`

把 `bin` 注册到 PATH：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-shell-commands.ps1 -UserPath
```

只对当前终端生效：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-shell-commands.ps1 -SessionOnly
```

注册后重开终端，就可以直接输入：

```powershell
codex-cli -CliMode tty -Cwd E:\Develop\ai-host-proto
codex-cli -CliMode exec-json -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK." -SkipGitRepoCheck
codex-cli -CliMode app-server -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK."
codex-cli -CliMode sdk -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK."
codex-ide -Cwd E:\Develop\ai-host-proto
```

## 快捷启动脚本

在 host 已启动后，可以直接用统一脚本启动 managed CLI 或 IDE：

```powershell
scripts\start-managed.cmd cli -CliMode tty -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
scripts\start-managed.cmd cli -CliMode exec-json -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK." -SkipGitRepoCheck
scripts\start-managed.cmd cli -CliMode app-server -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK."
scripts\start-managed.cmd cli -CliMode sdk -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK."
scripts\start-managed.cmd ide -Cwd E:\Develop\ai-host-proto
```

如果只想先注册 IDE session、不立刻打开 VS Code：

```powershell
scripts\start-managed.cmd ide -Cwd E:\Develop\ai-host-proto -NoLaunchCode
```

## 监督 Session

查看最新 session：

```powershell
codex-watch -Latest -Once
```

持续观察某个 session：

```powershell
codex-watch -SessionId <hostSessionId>
```

实时订阅某个 session：

```powershell
codex-watch -SessionId <hostSessionId> -Stream
```

`codex-watch` 会显示 `mode`、`upstreamSessionId`、transport capabilities、`processId`、`realCodex`、`proxyMode`、`launchedAt` 等信息。

查看审批队列：

```powershell
codex-approvals -Once
codex-approvals -SessionId <hostSessionId> -Once
```

实时订阅审批流：

```powershell
codex-approvals -Stream
codex-approvals -SessionId <hostSessionId> -Stream
```

提交审批决定：

```powershell
codex-approve <requestId> -Decision approve -Reason "manual override"
```

## 核心 API

支持的 `mode`：

- `exec-json`
- `tty`
- `app-server`
- `sdk`

向可控 session 续写消息：

```powershell
$body = @{ prompt = "Reply with exactly SECOND." } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7788/sessions/<hostSessionId>/messages" -ContentType "application/json" -Body $body
```

当前稳定支持：

- `exec-json`
- `app-server` direct managed session
- `sdk/thread` compatibility session

当前 PoC 支持：

- wrapper-managed IDE 的 `app-server` 代理观察模式

流式监督接口：

```txt
GET /sessions/<hostSessionId>/events/stream
GET /approvals/stream
GET /approvals/stream?hostSessionId=<hostSessionId>
```

wrapper 内部接口：

```txt
POST /internal/wrappers/register
POST /internal/wrappers/<hostSessionId>/runtime
POST /internal/wrappers/<hostSessionId>/events
POST /internal/wrappers/<hostSessionId>/complete
```

说明：

- 对 `exec-json`，Host 主要管理审批队列与状态。
- 对 direct `app-server` session，Host 会在可映射的 request 类型上尝试把人工决策回注回上游 JSON-RPC。
- 对 `sdk/thread` prototype，当前底层仍复用 `codex app-server` 协议，不是假定存在独立官方本地 SDK。
- 对 wrapper-managed IDE session，Host 当前支持 session 注册、runtime 上报、进程状态跟踪，以及在 `app-server` 代理模式下的 assistant output / approval 观测；仍不承诺稳定 approval 回注。

## 测试

```powershell
node --test
```
