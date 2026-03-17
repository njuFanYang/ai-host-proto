# 本地 Codex 监控 Host 方案

## Summary

本方案将当前项目中的本地 Host 定义为一个 **受控 session 控制平面**，而不是 UI 抓取器或旁路监听器。Host 的核心职责是：

- 启动并注册新的 Codex 会话。
- 将 CLI 和 IDE 会话统一建模为 session。
- 采集输出、工具活动、审批请求与审批结果。
- 对受控会话提供消息注入能力。
- 在需要时代表用户处理 HiTL。

本方案默认采用以下决策：

- 只支持 `managed session`，不实现旁路发现模式。
- `hostSessionId` 由 Host 先生成，`upstreamSessionId/threadId` 后续绑定。
- CLI 分为“原生终端体验模式”和“高保真结构化模式”，后者是 v1 自动化主路径。
- VS Code 路线采用“先 wrapper，后演进到自研 extension”，其中 wrapper 为 v1 实验性集成。
- HiTL 按 transport 分层支持，CLI 结构化路径优先支持自动代答，IDE 路径先做 PoC。

---

## 0. 当前实施状态

截至 2026-03-15，当前仓库与本方案的对齐状态如下。

### 0.1 已完成

- `Session Registry`、事件持久化、approval 持久化、host 重启恢复
- `exec-json` CLI 主路径
- `tty` CLI 次路径
- `app-server` direct managed CLI 路径
- `sdk/thread` compatibility 路径
- `HiTL Policy Engine` 与人工审批接口
- `GET /sessions/*`、`GET /approvals*`、`POST /sessions/{id}/messages`
- SSE 事件流：`/sessions/{id}/events/stream`、`/approvals/stream`
- wrapper-managed IDE 的注册、runtime 跟踪、状态刷新
- wrapper-managed 在 `app-server` 代理模式下的 assistant output / approval observation

### 0.2 部分完成

- wrapper-managed IDE 的事件关联：已有可用 PoC，但映射覆盖仍不完整
- IDE 路径的 HiTL：当前以观测链路为主，不承诺稳定自动回注
- IDE 路径的消息注入：仍是条件能力 / PoC 边界
- `sdk/thread`：当前不是独立本地 SDK，而是 `app-server` 协议兼容层

### 0.3 未完成

- 自研 VS Code extension / panel
- wrapper-managed IDE 的稳定消息注入
- wrapper-managed IDE 的稳定 approval 自动回注
- 更完整的 `codex/event/*` 结构化映射覆盖
- 以 IDE 为中心的长期稳定控制面

### 0.4 当前建议理解

当前仓库并不是“plan 已全部完成后又在做额外高级功能”。

更准确地说：

- CLI 主路径已经基本成型。
- 最近几轮实现的是 plan 中 IDE / wrapper 路线原本就缺的 PoC 深化。
- 当前最完整的可交付路径仍然是 `exec-json` 和 direct `app-server` / `sdk-thread` CLI。

---

## 1. 结论与范围

### 1.1 结论

该方案可行，但前提是 Host 必须成为 Codex 会话的启动入口或控制入口。

- 如果会话是通过 Host 启动的，那么 Host 可以稳定地完成注册、监控、消息注入和 HiTL 处理。
- 如果用户绕过 Host，直接启动原生 `codex` CLI 或原生 VS Code Codex 扩展，则这些会话不属于本方案的受控范围。

### 1.2 范围内目标

- 提供统一的 session 注册表。
- 支持通过 Host 启动 CLI managed session。
- 支持通过 Host 启动 IDE managed session。
- 支持采集用户输入、模型输出、工具事件和审批事件。
- 支持通过 Host API 向 managed session 注入消息。
- 支持 Host 对具备控制能力的 transport 按策略处理 HiTL。

### 1.3 明确不做

- 不做 UI 文本抓取。
- 不做对所有本地 Codex 会话的全局自动接管。
- 不把“原生 VS Code 扩展直连第三方 host”当作稳定前提。
- v1 不做团队级审计平台、多机分布式调度或远程 agent mesh。

---

## 2. 可行性判断

### 2.1 CLI 侧

CLI 路线可行，而且是 v1 最稳的入口。

CLI managed session 可以同时支持两种形态，但能力等级不同：

1. **真实终端交互会话**
   - Host 启动真实终端窗口。
   - 用户继续在本地命令行里直接使用 Codex。
   - Host 负责登记、基础状态跟踪、有限事件关联和有限审批代理。

2. **受控结构化会话**
   - Host 以 `exec-json`、`app-server` 或 `sdk/thread` 方式启动 Codex。
   - 其中最稳定主路径是 `exec-json`；`app-server` 与 `sdk/thread` 当前都已可用。
   - 更适合自动注入消息、完整记录事件和可靠回放。

### 2.2 VS Code 侧

VS Code 路线条件可行，但 v1 不应该把“完全接管官方扩展”当作主目标。

当前可行的稳定方向是：

- 让 Host 启动 VS Code。
- 通过 wrapper 接管 Codex 启动入口。
- 先实现受控注册、基础事件关联和有限审批链路验证。
- 后续再演进为自研 extension / panel。

其中当前已实现到：

- wrapper 注册
- runtime 跟踪
- `app-server` 代理模式下的有限协议观测

### 2.3 关于“自动注册所有会话”

本方案不建立在“Codex 提供统一注册总线”的前提上。

当前设计采用的是：

- `host launch`
- `wrapper self-register`

而不是：

- 被动旁路发现所有本地会话

---

## 3. 总体架构

Host 内部按以下子系统拆分：

- `Session Registry`
- `Launcher Layer`
- `Wrapper Layer`
- `Adapter Layer`
- `Event Bus`
- `HiTL Policy Engine`
- `Session API`

Host 监控的核心对象是 **session/thread**，不是窗口，也不是进程。

内部统一采用“两阶段绑定”：

```txt
hostSessionId = host-generated
upstreamSessionId/threadId = bind later
```

---

## 4. 数据模型与能力矩阵

### `SessionRecord`

```ts
interface SessionRecord {
  hostSessionId: string
  source: "cli" | "ide"
  transport: "tty" | "exec-json" | "sdk/thread" | "app-server"
  upstreamSessionId?: string
  workspaceRoot: string
  status: "starting" | "running" | "waiting_approval" | "ended" | "failed"
  registrationState: "pending_upstream" | "bound" | "failed"
  createdAt: string
  lastActivityAt: string
  controlMode: "managed"
}
```

### `SessionEvent`

```ts
interface SessionEvent {
  eventId: string
  hostSessionId: string
  controllability: "observed" | "controllable"
  kind: string
  timestamp: string
  payload: unknown
}
```

### transport capability matrix

| transport | session 注册 | 输出采集 | 消息注入 | 自动 HiTL | 稳定性定位 |
|---|---|---|---|---|---|
| `tty` | 支持 | 有限 | 条件支持 | 条件支持 | 体验优先 |
| `exec-json` | 支持 | 完整 | 支持 | 支持 | v1 主路径 |
| `sdk/thread` | 支持 | 完整 | 支持 | 支持 | v1 主路径 |
| `app-server` direct managed | 支持 | 完整 | 支持 | PoC / 条件支持 | v1 CLI 次主路径 |
| `app-server` wrapper-managed | 支持 | 有限到中等 | 条件支持 | PoC 观测优先 | IDE 实验性路径 |

v1 的“完整自动化能力”默认只以 `exec-json` / `sdk/thread` 路径验收。

---

## 5. 交互模式设计

### 5.1 CLI managed session

#### A. TTY 原生终端模式

- Host 启动真实的 PowerShell 或 terminal 窗口。
- Host 负责创建 session 记录、基础状态跟踪和有限审批代理。

#### B. 结构化受控模式

- Host 以 `exec-json`、`app-server` 或 `sdk/thread` 方式启动 Codex。
- 事件流直接进入 Host。
- 更适合自动化、回放、批量任务和自动审批。

### 5.2 IDE managed session

#### v1：wrapper 路线（实验性）

- Host 启动 VS Code。
- VS Code 使用 `codex-wrapper` 作为启动入口。
- wrapper 在启动真实 Codex 前先向 Host 注册。
- 如果真实启动的是 `codex app-server`，wrapper 会在本地做协议代理并把关键消息上报给 Host。
- 当前已验证：thread 绑定、assistant output delta、approval request / response observation。

#### v2：自研 extension / panel

- 不再依赖 wrapper 作为长期主路径。
- IDE 前端直接连 Host 或上游接口。
- Host 成为会话、消息和审批的唯一控制面。

### 5.3 Host 注入消息

Host 支持向 managed session 注入用户消息，但能力按 transport 分层：

- `exec-json`：稳定支持
- `sdk/thread`：当前稳定支持
- direct `app-server`：当前可用
- `tty`：条件能力
- wrapper-managed IDE：仍未承诺稳定支持

### 5.4 HiTL 处理

- CLI 结构化受控模式 / SDK 模式：支持 policy 自动决策与人工覆盖。
- CLI TTY 模式：只支持审批感知和有限代理。
- wrapper-managed IDE：`approval_request` 已可观测；`approval_result` 当前只支持“客户端响应已被观察到”的链路，不承诺 Host 稳定自动回注。

---

## 6. Wrapper 设计

### 6.1 CLI wrapper

CLI wrapper 的职责包括：

- 收集启动元数据
- 向 Host 注册 session
- 在上游会话可用后绑定 `upstreamSessionId`
- 再转调真实 Codex

### 6.2 VS Code wrapper

VS Code wrapper **不是新的 extension**，而是一个本地启动器程序。

链路为：

```txt
VS Code 扩展 -> codex-wrapper -> Host 注册 -> 真实 codex
```

如果 wrapper 看到自己启动的是 `codex app-server`，它会进入本地代理模式：

- 透传 stdin/stdout/stderr
- 把关键协议消息上报给 Host
- 帮助 Host 做“有限协议级观测”

### 6.3 Host 不在线时的降级策略

当 wrapper 启动时，如果 Host 不在线：

- wrapper 允许直接启动真实 Codex
- 该会话不记为 managed session
- Host 后续不承诺对该会话进行控制

---

## 7. Host API：当前实现状态

### 已实现

- `POST /sessions/cli`
- `POST /sessions/ide`
- `POST /sessions/{id}/messages`
- `GET /sessions`
- `GET /sessions/{id}`
- `GET /sessions/{id}/events`
- `GET /sessions/{id}/events/stream`
- `GET /approvals`
- `GET /approvals/stream`
- `POST /approvals/{requestId}/decision`
- `POST /internal/wrappers/register`
- `POST /internal/wrappers/{id}/runtime`
- `POST /internal/wrappers/{id}/events`
- `POST /internal/wrappers/{id}/complete`

### 仍未实现为稳定能力

- wrapper-managed IDE 的可控消息注入 API 闭环
- wrapper-managed IDE 的稳定 approval 自动回注

---

## 8. 能力等级划分

### Managed CLI Session

已具备：

- 可由 Host 启动
- 可注册
- 可监控
- 可记录事件
- 在结构化模式下可处理 HiTL
- 在结构化模式下可支持 Host 注入消息

### Managed IDE Session

当前已具备：

- 可由 Host 启动
- 可由 wrapper 注册
- 可建立受控 session 记录
- 可采集 runtime 与部分协议事件
- 可观察 approval request / response

当前仍不具备：

- 稳定的可控消息注入
- 稳定的 approval 自动回注

### Unmanaged Session

- 用户绕过 Host 直接启动的原生会话
- v1 不纳管、不承诺识别、不承诺控制

---

## 9. 实施路线

### Phase 1

- 实现 `Session Registry`
- 实现 CLI launcher
- 实现基础 CLI wrapper
- 建立最小事件存储

状态：已完成

### Phase 2

- 实现 `HiTL Policy Engine`
- 支持 CLI 结构化 managed session 的消息注入
- 补齐结构化受控模式

状态：已基本完成

### Phase 3

- 实现 VS Code wrapper 集成
- 建立 IDE managed session 的注册和事件关联

状态：已部分完成

当前已完成：注册、runtime 跟踪、app-server 代理观察模式

当前未完成：稳定输入注入、稳定 approval 回注、完整事件映射

### Phase 4

- 自研 extension / panel
- 减少对 wrapper 路线的长期依赖

状态：未开始

### Phase 5

- 引入 Feishu channel adapter
- 允许 Feishu 对话作为 managed session 的远程终端
- 允许在单个 Feishu 会话中列出多个已注册 session，并选择其中一个进入绑定态
- 支持 Feishu 绑定态下的消息注入、最近事件查看与审批操作

状态：未开始

Phase 5 的 v1 范围定义如下：

- 只支持 Feishu，不同时展开 WeCom / 微信公众号路线
- Feishu 侧采用官方应用 bot + 消息事件 + 卡片交互回调
- 不采用“自定义机器人静态卡片”作为主路径
- Host 新增 channel adapter 层，而不是把 Feishu 会话本身当作新的 session 主体
- Feishu conversation 通过本地绑定关系指向 `hostSessionId`
- 一个 Feishu conversation 在任意时刻只默认绑定一个 active session
- 同一个 Feishu conversation 允许列出多个 session，并通过 `/sessions` 或卡片按钮切换 active session
- v1 支持：
  - `/sessions`：列出当前已注册 session
  - `/attach <hostSessionId>` 或卡片点击绑定 session
  - 绑定态下继续发送消息到 `POST /sessions/{id}/messages`
  - `/watch`：查看最近事件摘要
  - 审批通知与 `approve` / `deny`
- v1 不支持：
  - 在同一条普通自然语言消息里自由混发多个 session
  - 复杂多路并发控制
  - WeCom / 微信公众号双栈同步实现
  - 个人微信非官方接入

---

## 10. 风险与约束

### 10.1 VS Code 路线兼容性风险

v1 的 wrapper 路线本质上是启动入口接管，而且属于实验性集成，不应被描述为“官方稳定的第三方注册协议”。

### 10.2 CLI 事件完整性差异

真实终端窗口模式更接近用户习惯，但事件完整性、消息注入稳定性和自动化可控性弱于结构化模式。

### 10.3 IDE 回注仍需继续验证

当前 wrapper-managed IDE 已经具备观测能力，但“Host 代表用户稳定回注控制决策”仍未闭环。

### 10.4 平台边界

v1 默认按本地单机方案设计，不扩展到跨机器调度、远程工作节点或组织级审计平台。

### 10.5 Feishu channel 风险

Feishu channel v1 的主要风险不在 session 建模，而在消息交互模型：

- Feishu webhook / 卡片回调需要快速响应，不能把长耗时的 Codex 执行直接阻塞在回调请求里
- channel adapter 必须采用“先确认收到，再异步推送 session 输出”的模式
- 同一 `hostSessionId` 可能同时被本地终端、IDE 和 Feishu 写入，需要显式定义 active controller 或最小并发策略
- 移动端审批能力必须保守，默认不应把高风险操作设计成单击即放行

---

## 11. 验收场景

### 已经可验证通过

1. `exec-json` CLI session 创建、绑定、续写、事件回放
2. direct `app-server` session 的输出采集与人工审批回注
3. `sdk/thread` compatibility session 的创建、续写与上下文连续性
4. TTY session 的启动、注册、状态跟踪
5. wrapper-managed IDE session 的注册、runtime 跟踪、进程刷新
6. wrapper-managed `app-server` 代理模式下的 assistant output / approval observation
7. SSE 事件流与本地 watch 命令的实时监督

### 仍待未来验收

1. wrapper-managed IDE 的稳定消息注入
2. wrapper-managed IDE 的稳定 approval 自动回注
3. 自研 extension / panel 路线

---

## 12. 当前默认假设

- 本文档继续作为主规划文档。
- v1 是本地单机 Host。
- 只覆盖 managed session。
- v1 的完整能力承诺只覆盖 CLI 结构化受控路径。
- CLI TTY 模式是体验增强路径，不作为完整自动化能力基线。
- 不实现旁路发现模式。
- VS Code wrapper 是实验性接入，不作为长期主路径。
- VS Code 路线采用“先 wrapper，后演进到自研 extension”。
- Feishu channel 是下一阶段扩展终端，而不是新的 session 主体。
- Feishu conversation 与 `hostSessionId` 之间是绑定关系，不替代现有 session registry。
