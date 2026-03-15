# ai-host-proto

本项目是一个本地 `Codex` host 原型，目标是把 `Codex CLI` 和后续的 IDE 集成纳入统一的 **managed session 控制平面**。

当前实现优先落地了 `docs/plan.md` 里的主路径：

- Host 自己生成 `hostSessionId`
- 结构化 `exec-json` CLI session 作为 v1 主路径
- `tty` CLI 作为体验优先的次路径
- VS Code wrapper 作为实验性接入

## 当前状态

已实现：

- 本地 HTTP host 服务
- session registry 和事件持久化
- `Codex CLI` 结构化 `exec-json` 启动与续写
- `Codex CLI` TTY 外部终端启动
- 实验性 `codex-wrapper`
- 基础 HiTL policy engine
- 基础测试

已验证：

- 真实 `codex exec --json` 会话创建
- Host 从 JSONL 事件流中绑定 `upstreamSessionId`
- 对同一结构化 session 继续发送消息
- 结构化 session 事件回放
- 低风险结构化审批自动批准
- 高风险结构化审批人工决策
- IDE 路径的人类 fallback 判定
- wrapper 路径的预注册和回收

未实现或仅 PoC：

- `sdk/thread` transport
- VS Code 正式 extension
- app-server 完整自动审批回注
- TTY 模式的完整事件采集
## 目录结构

```txt
bin/
  codex-wrapper.cmd         Windows wrapper 入口
docs/
  plan.md                   当前实施方案
  research.md               前期调研文档
src/
  server.js                 本地 host HTTP 服务
  host/
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

## 启动

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

如果你想在 host 启动后，直接在 PowerShell 或 cmd 里输入类似 `codex-cli` / `codex-ide` 的命令，可以用项目内置的包装器：

- `bin\codex-cli.cmd`
- `bin\codex-ide.cmd`
- `bin\codex-cli.ps1`
- `bin\codex-ide.ps1`

示例：

```powershell
bin\codex-cli.cmd -CliMode tty -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
bin\codex-cli.cmd -CliMode exec-json -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK." -SkipGitRepoCheck
bin\codex-ide.cmd -Cwd E:\Develop\ai-host-proto
```

如果你希望以后直接输入 `codex-cli` 和 `codex-ide`，可以把 `bin` 注册到 PATH：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-shell-commands.ps1 -UserPath
```

只想对当前终端会话生效：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-shell-commands.ps1 -SessionOnly
```

监督 session 可以直接用：

```powershell
bin\codex-watch.cmd -Latest -Once
bin\codex-watch.cmd -SessionId <hostSessionId>
```

如果你已经把 `bin` 注册进 PATH，也可以直接：

```powershell
codex-watch -Latest -Once
codex-watch -SessionId <hostSessionId>
```
注册后，重开 PowerShell 或 cmd，就可以直接输入：

```powershell
codex-cli -CliMode tty -Cwd E:\Develop\ai-host-proto
codex-ide -Cwd E:\Develop\ai-host-proto
```
## 快捷启动脚本

在 host 已启动后，可以直接用统一脚本启动 managed CLI 或 IDE。

CLI：

```powershell
scripts\start-managed.cmd cli -CliMode tty -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
```

结构化 CLI：

```powershell
scripts\start-managed.cmd cli -CliMode exec-json -Cwd E:\Develop\ai-host-proto -Prompt "Reply with exactly OK." -SkipGitRepoCheck
```

IDE：

```powershell
scripts\start-managed.cmd ide -Cwd E:\Develop\ai-host-proto
```

如果只想先注册 IDE session、不立刻打开 VS Code：

```powershell
scripts\start-managed.cmd ide -Cwd E:\Develop\ai-host-proto -NoLaunchCode
```
## 核心 API

### 1. 创建 CLI session

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
- `sdk` 当前会返回未实现

### 2. 续写结构化 session

```powershell
$body = @{
  prompt = "Reply with exactly SECOND."
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:7788/sessions/<hostSessionId>/messages" `
  -ContentType "application/json" `
  -Body $body
```

当前只对 `exec-json` session 提供稳定支持。

### 3. 查询 session

```powershell
Invoke-RestMethod http://127.0.0.1:7788/sessions
Invoke-RestMethod http://127.0.0.1:7788/sessions/<hostSessionId>
Invoke-RestMethod http://127.0.0.1:7788/sessions/<hostSessionId>/events
```

### 4. 创建 approval 请求

```powershell
$body = @{
  riskLevel = "low"
  actionType = "shell"
  summary = "read-only command"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:7788/sessions/<hostSessionId>/approvals" `
  -ContentType "application/json" `
  -Body $body
```

当前行为：

- `exec-json` 结构化 session 上，低风险请求默认自动批准
- `exec-json` 结构化 session 上，中高风险请求默认进入人工 fallback
- `app-server` / IDE 路径默认进入人工 fallback

### 5. 人工提交 approval 决策

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

### 6. 创建 IDE wrapper session

```powershell
$body = @{
  mode = "wrapper-managed"
  cwd = "E:\\Develop\\ai-host-proto"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:7788/sessions/ide" `
  -ContentType "application/json" `
  -Body $body
```

返回值中会带 `wrapperLaunchInfo`，其中包含：

- `wrapperPath`
- `hostUrl`
- `workspaceRoot`
- `env`

## Wrapper 用法

当前 wrapper 是实验性入口，不是新的 VS Code extension。

Windows 下可以直接调用：

```powershell
cmd /c bin\codex-wrapper.cmd --version
```

如果要手工绑定到 host，可提前设置：

```powershell
$env:AI_HOST_URL = "http://127.0.0.1:7788"
$env:AI_HOST_SESSION_ID = "<pre-registered-session-id>"
cmd /c bin\codex-wrapper.cmd --version
```

## 事件模型

当前 host 会把上游事件映射到统一事件流，典型事件包括：

- `session_started`
- `session_ended`
- `user_input`
- `assistant_output`
- `tool_result`
- `approval_request`
- `approval_result`
- `stderr`
- `raw_event`

结构化 CLI 主路径已经验证：

- `thread.started` -> 绑定 `upstreamSessionId`
- `item.completed(agent_message)` -> `assistant_output`

## 数据落盘

session 数据当前落在本地：

```txt
.host-data/sessions/
```

每个 managed session 对应一个 JSON 文件，包含：

- `record`
- `events`

`.host-data/` 已加入 `.gitignore`。

## 测试

```powershell
node --test
```

已覆盖：

- `SessionRegistry` 的 deferred upstream binding
- JSONL 事件映射

## 已完成的真实验证

当前不是只写了代码，还做过真实集成验证：

1. 调用 `codex exec --json` 创建结构化 session
2. 拿到真实 `thread_id`
3. 用 `codex exec resume ... --json` 对同一 session 续写
4. 在 host 中看到两次输出结果
5. 走 wrapper 路径完成 IDE session 的预注册和退出回收

## 当前限制

- `exec-json` 是当前唯一真正跑通的主路径
- TTY 模式只保证开外部终端和基础观测
- IDE 仍是实验性 wrapper 集成
- 审批引擎目前只有最小规则集
- 还没有远程部署、多用户和鉴权
## 下一步建议

按 `docs/plan.md` 的顺序，下一阶段应优先做：

1. `HiTL Policy Engine`
2. `tty` 模式的更多事件采集
3. `sdk/thread` transport
4. VS Code 自研 extension / panel
