# ai-host-proto

本项目是一个本地 `Codex` host 原型，目标是把 `Codex CLI` 和后续 IDE 接入纳入统一的 **managed session 控制平面**。

当前实现对齐 `docs/plan.md` 的受控 session 方案：

- Host 先生成 `hostSessionId`
- `exec-json` CLI 是 v1 主路径
- `tty` CLI 是体验优先次路径
- `app-server` CLI 已接入最小可用 PoC
- VS Code wrapper 仍是实验性接入

## 当前状态

已实现：

- 本地 HTTP host 服务
- session registry、事件持久化、host 重启恢复
- `Codex CLI` `exec-json` 启动与续写
- `Codex CLI` `tty` 外部终端启动
- `Codex CLI` `app-server` 最小受控接入
- 实验性 `codex-wrapper`
- approval queue、policy engine、人工决策接口
- 基础测试

已验证：

- 真实 `codex exec --json` 会话创建、续写、事件回放
- `exec-json` 低风险审批自动批准
- `exec-json` 中高风险审批人工决策
- wrapper 路径的预注册与完成回收
- `app-server` 路径的 `initialize -> thread/start -> turn/start -> event capture`

当前限制：

- `sdk/thread` transport 未实现
- VS Code 仍不是正式 extension 集成
- `app-server` assistant 完整输出流还在继续验证中
- `app-server` approval 回注目前只对 direct managed session 做了最小回注能力
- `tty` 模式仍然只有有限观测

## 目录结构

```txt
bin/
  codex-wrapper.cmd         Windows wrapper 入口
docs/
  plan.md                   当前实施方案
src/
  server.js                 本地 host HTTP 服务
  host/
    app-server-client.js    app-server transport PoC
    approval-service.js     approval 服务与决策回调
    codex-cli.js            CLI launcher / adapter
    codex-event-parser.js   Codex JSONL 事件映射
    session-registry.js     session 与事件存储
    utils.js                通用工具
  wrapper/
    codex-wrapper.js        实验性 wrapper
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

如果你希望在 host 启动后，直接从 PowerShell 或 cmd 输入类似 `codex-cli` / `codex-ide` 的命令，可以用项目内置包装器：

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
codex-ide -Cwd E:\Develop\ai-host-proto
```

## 快捷启动脚本

在 host 已启动后，可以直接用统一脚本启动 managed CLI 或 IDE：

```powershell
scripts\start-managed.cmd cli -CliMode tty -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
scripts\start-managed.cmd cli -CliMode exec-json -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK." -SkipGitRepoCheck
scripts\start-managed.cmd cli -CliMode app-server -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK."
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

查看审批队列：

```powershell
codex-approvals -Once
codex-approvals -SessionId <hostSessionId> -Once
```

提交审批决定：

```powershell
codex-approve <requestId> -Decision approve -Reason "manual override"
```

## 核心 API

创建 CLI session：

```powershell
$body = @{
  mode = "exec-json"
  prompt = "Reply with exactly OK."
  cwd = "E:\\Develop\\ai-host-proto"
  sandbox = "read-only"
  skipGitRepoCheck = $true
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:7788/sessions/cli" `
  -ContentType "application/json" `
  -Body $body
```

支持的 `mode`：

- `exec-json`
- `tty`
- `app-server`
- `sdk` 当前返回未实现

向可控 session 续写消息：

```powershell
$body = @{ prompt = "Reply with exactly SECOND." } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7788/sessions/<hostSessionId>/messages" -ContentType "application/json" -Body $body
```

当前稳定支持：

- `exec-json`
- `app-server` direct managed session

查询 session / events / approvals：

```powershell
Invoke-RestMethod http://127.0.0.1:7788/sessions
Invoke-RestMethod http://127.0.0.1:7788/sessions/<hostSessionId>
Invoke-RestMethod http://127.0.0.1:7788/sessions/<hostSessionId>/events
Invoke-RestMethod http://127.0.0.1:7788/sessions/<hostSessionId>/approvals
Invoke-RestMethod http://127.0.0.1:7788/approvals
```

人工提交 approval 决策：

```powershell
$body = @{
  decision = "approve"
  decidedBy = "human"
  reason = "manual override"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:7788/approvals/<requestId>/decision" `
  -ContentType "application/json" `
  -Body $body
```

说明：

- 对 `exec-json`，Host 主要管理审批队列与状态。
- 对 direct `app-server` session，Host 会在可映射的 request 类型上尝试把人工决策回注回上游 JSON-RPC。
- 对 wrapper-managed IDE session，不承诺稳定 approval 回注；当前更偏观测与 PoC 验证。

## 测试

```powershell
node --test
```
