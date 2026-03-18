# ai-host-proto

本项目现在只支持 **Codex CLI** 作为受控 session。

范围内能力：
- 通过 Host 启动和登记 Codex CLI session
- 支持 `tty`、`exec-json`、`app-server`、`sdk` 四种 CLI 模式
- 采集 session、event、approval
- 通过 Host 向可控 CLI session 注入消息
- 用 channel binding 把远程对话面绑定到某个 CLI session

不再支持：
- VS Code Codex extension
- 任意 IDE wrapper
- `codex-wrapper` 代理链路
- `/sessions/ide` 与任何 `/internal/wrappers/*` 接口

## 当前实现

已完成：
- `SessionRegistry` 持久化 session 与 event
- `ApprovalService` 与 `PolicyEngine`
- `SessionControlService`：controller model + input queue
- `ChannelBindingRegistry` / `ChannelBindingService`
- internal / external API surface 拆分
- CLI launch: `tty` / `exec-json` / `app-server` / `sdk`

当前主路径：
- 最稳的是 `exec-json`
- `app-server` / `sdk` 可用于结构化受控 session
- `tty` 更偏本地终端体验

## 目录

```txt
bin/
  codex-cli.cmd
  codex-watch.cmd
  codex-approvals.cmd
  codex-approve.cmd
src/
  server.js
  host/
    app-server-client.js
    approval-service.js
    channel-binding-registry.js
    channel-binding-service.js
    codex-cli.js
    codex-event-parser.js
    policy-engine.js
    session-control-service.js
    session-registry.js
    utils.js
docs/
  plan.md
  review-checklist.md
test/
  *.test.js
```

## 启动 Host

```powershell
node src/server.js
```

默认 internal listener:
```txt
http://127.0.0.1:7788
```

如果设置了 `AI_HOST_EXTERNAL_PORT`，会额外启动 external listener。

## 注册命令

把 `bin` 加到 PATH：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-shell-commands.ps1 -UserPath
```

随后可以直接使用：

```powershell
codex-cli -CliMode tty -Cwd E:\Develop\ai-host-proto
codex-cli -CliMode exec-json -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo" -SkipGitRepoCheck
codex-cli -CliMode app-server -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
codex-cli -CliMode sdk -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
```

## 监看与审批

```powershell
codex-watch -Latest -Once
codex-watch -SessionId <hostSessionId> -Stream
codex-approvals -Stream
codex-approve <requestId> -Decision approve -Reason "manual override"
```

## 核心接口

Internal:
- `POST /sessions/cli`
- `POST /sessions/{id}/approvals`

Public / external-safe:
- `GET /sessions`
- `GET /sessions/{id}`
- `GET /sessions/{id}/events`
- `GET /sessions/{id}/events/stream`
- `POST /sessions/{id}/messages`
- `GET /approvals`
- `GET /approvals/stream`
- `POST /approvals/{requestId}/decision`
- `GET /channel-bindings`
- `POST /channel-bindings/{channel}/{conversationId}/attach`
- `POST /channel-bindings/{channel}/{conversationId}/switch`
- `POST /channel-bindings/{channel}/{conversationId}/detach`
- `POST /channel-bindings/{channel}/{conversationId}/messages`
- `GET /channel-bindings/{channel}/{conversationId}/watch`

## 测试

当前环境里更稳的跑法：

```powershell
node -e "require('./test/session-registry.test.js'); require('./test/codex-cli.test.js'); require('./test/app-server-client.test.js'); require('./test/approval-service.test.js'); require('./test/policy-engine.test.js'); require('./test/session-control-service.test.js'); require('./test/channel-binding-service.test.js'); require('./test/server.test.js'); require('./test/server-surface.test.js');"
```
