# ai-host-proto

本项目目前只承载一种后端：**Claude Code CLI** session，通过 `claude -p --output-format stream-json --verbose` 拉起子进程，解析其结构化输出，并把会话状态、事件、审批请求、channel binding 统一暴露为 HTTP 接口。

核心能力：

- 通过 Host 拉起并登记 Claude Code session（单一 transport：`stream-json`）
- 采集 session / event / approval
- 以 `PreToolUse` hook 把工具调用审批转发给 Host 的 ApprovalService
- 通过 channel binding 把远程对话（如飞书）绑定到某个 session
- internal / external 两套 HTTP 接口分层

## 目录

```txt
bin/
  claude-cli.cmd / claude-cli.ps1
  claude-watch.cmd / claude-watch.ps1
  claude-approvals.cmd / claude-approvals.ps1
  claude-approve.cmd / claude-approve.ps1
scripts/
  claude-hook-approval.js       # Claude Code PreToolUse hook 脚本
  start-managed.ps1
  watch-session.ps1
  watch-approvals.ps1
  decide-approval.ps1
  register-shell-commands.ps1
src/
  server.js
  host/
    approval-service.js
    channel-binding-registry.js
    channel-binding-service.js
    claude-code-cli.js          # 取代原 codex-cli.js
    claude-code-event-parser.js # stream-json → 通用事件
    policy-engine.js
    session-control-service.js
    session-registry.js
    utils.js
```

## 启动 Host

```powershell
node src/server.js
```

默认 internal listener：

```txt
http://127.0.0.1:7788
```

若设置了 `AI_HOST_EXTERNAL_PORT`，会额外起一个 external listener，用于外部只读 / 消息注入。

## 注册命令

把 `bin` 加到 PATH：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-shell-commands.ps1 -UserPath
```

之后可直接使用：

```powershell
claude-cli -Cwd E:\Develop\ai-host-proto -Prompt "help me inspect this repo"
claude-cli -Cwd E:\Develop\ai-host-proto -Prompt "..." -PermissionMode acceptEdits -Model claude-opus-4-7
```

## 观察与审批

```powershell
claude-watch -Latest -Once
claude-watch -SessionId <hostSessionId> -Stream
claude-approvals -Stream
claude-approve <requestId> -Decision approve -Reason "manual override"
```

## 审批工作流（Claude Code PreToolUse hook）

Host 在拉起 session 时，会往 `<workspaceRoot>/.claude/settings.local.json` 注入一条 `PreToolUse` hook，指向 `scripts/claude-hook-approval.js`。每次 Claude 想调用工具：

1. hook 接到 stdin 的 JSON，拿到 `AI_HOST_SESSION_ID` / `AI_HOST_URL` 两个环境变量
2. 按工具名把风险等级映射为 `low / medium / high`
3. `POST /sessions/{hostSessionId}/approvals`
4. 若 PolicyEngine 自动裁定（`low → approve`），直接返回 decision
5. 否则轮询 `GET /approvals/{requestId}`，等到外部（如飞书）通过 `POST /approvals/{requestId}/decision` 解决
6. 按 decision 输出 `hookSpecificOutput.permissionDecision = allow | deny | ask`

当环境变量未注入时（即 Host 未启动，用户手动跑 `claude`），hook 会直接 allow，没有副作用。

## 飞书（Feishu）channel

已内置飞书 adapter，用长连接模式接入，不需要公网 URL。

1. 把飞书开放平台生成的凭证写到 `.env`（模板见 `.env.example`）：
   ```
   FEISHU_APP_ID=cli_xxxxxxxx
   FEISHU_APP_SECRET=xxxxxxxx
   FEISHU_VERIFICATION_TOKEN=xxxxxxxx
   FEISHU_ENCRYPT_KEY=

   # 本机有代理就加上这个，否则 axios 把 HTTPS 请求塞到 HTTP proxy 会 400
   NO_PROXY=open.feishu.cn,msg-frontier.feishu.cn,feishu.cn,larksuite.com

   # 可选：收到未绑定 chat 的首条消息时自动拉起 session，并把聊天绑到它
   FEISHU_AUTO_SESSION_CWD=E:\Develop\your-project
   FEISHU_AUTO_SESSION_PERMISSION_MODE=default
   ```
2. `node src/server.js` 启动后，Host 自动起 `WSClient`，订阅 `im.message.receive_v1` 和 `card.action.trigger`。
3. 在飞书里直接给机器人发消息——**如果设了 `FEISHU_AUTO_SESSION_CWD`**，Host 会：
   - 以这条消息为 prompt 启动一个新的 Claude Code session
   - 把该聊天 attach 到该 session（control 模式）
   - 之后的消息都会作为后续 turn 注入到这个 session
4. 如果没设 auto-session，可以手动绑定：
   ```powershell
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7788/channel-bindings/feishu/<chat_id>/attach" `
     -ContentType "application/json" `
     -Body (@{ hostSessionId = "<hostSessionId>"; mode = "control" } | ConvertTo-Json)
   ```
5. Host 会在该消息的 thread 里发一张 **session 卡片**，随事件自动更新（300ms debounce）：
   - 标题带状态图标（🟢running / 🟡waiting_approval / ⚪ended / 🔴failed）和 session 短 id
   - 展示 cwd、工具调用次数
   - 正文：最新一条 assistant 回复（截 800 字）
   - 折叠区：最近 5 条工具调用简讯（`🔧 \`ls\``、`📖 Read xxx` 等）
   - 需要审批时卡片里直接冒出 **Approve / Deny** 按钮和工具详情
   - 永远有三个按钮：`Stop`（杀 session）、`Detach`（断开绑定）、`Log`（发一条完整日志）
6. 整个 session 只有这一张会动的卡片，不会每条事件都刷屏。

### 多 session 并发 / 线程隔离

`FEISHU_THREAD_ISOLATION=true`（默认）时，每个**飞书消息串**对应一个独立的 Claude Code session：

- 发一条根消息 → 新开一个 session，后续跑在这个 session 里
- 发另一条根消息 → **另一个** session，独立上下文并发跑
- 在某个 assistant 的消息上点"回复" → 这条回复会被路由回原 session（续上它的 context）
- 输出也会在原消息串里以 reply 的形式推回，不会污染主聊天

这样你就能在同一个飞书聊天里同时跑多个项目/多个任务，彼此不串。

关掉 `FEISHU_THREAD_ISOLATION` 会退回到"一个飞书聊天 = 一个 session"，所有消息都塞进同一个 session。

### 快速命令

在飞书里直接发文字命令：

- `/approve <shortId>` — 审批通过（如果卡片发送失败、走了 fallback 文字提示时用）
- `/deny <shortId>` — 审批拒绝

权限/事件要求：开通 `im:message`、`im:message:send_as_bot`、`im:chat:readonly`；订阅事件 `im.message.receive_v1`；应用需发布到组织（自建应用免审核）。

## 核心接口

Internal：

- `POST /sessions/cli`
- `POST /sessions/{id}/approvals`

Public / external-safe：

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

```powershell
npm test
```

或针对某个套件：

```powershell
node --test test/claude-code-cli.test.js
```
