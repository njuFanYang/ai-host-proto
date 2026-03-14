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

## 1. 结论与范围

### 1.1 结论

该方案可行，但前提是 Host 必须成为 Codex 会话的启动入口或控制入口。

也就是说：

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

原因：

- Codex CLI 本身就是交互式终端工具，适合保留真实 PowerShell / terminal 窗口。
- CLI 有本地 session / transcript 持久化与 `resume` 能力。
- 对自动化控制场景，可以补充使用结构化输出模式。

因此，CLI managed session 可以同时支持两种形态，但能力等级不同：

1. **真实终端交互会话**
   - Host 启动真实终端窗口。
   - 用户继续在本地命令行里直接使用 Codex。
   - Host 负责登记、基础状态跟踪、有限事件关联和有限审批代理。
   - 该模式优先保留用户体验，不承诺与结构化模式同等级的自动化控制能力。

2. **受控结构化会话**
   - Host 以 `exec-json` 或 SDK/thread 方式启动 Codex。
   - 该模式是 v1 自动化、完整事件采集和自动审批的主路径。
   - 更适合自动注入消息、完整记录事件和可靠回放。

### 2.2 VS Code 侧

VS Code 路线条件可行，但 v1 不应该把“完全接管官方扩展”当作主目标。

当前可行的稳定方向是：

- 让 Host 启动 VS Code。
- 通过 wrapper 接管 Codex 启动入口。
- 先实现受控注册、基础事件关联和有限审批链路验证。
- 后续再演进为自研 extension / panel。

因此，VS Code 路线分成两期：

- **v1**
  - 通过 `codex-wrapper` 以实验性方式纳管启动入口。
  - Host 负责 session 注册、基础输出采集和 PoC 级审批链路验证。

- **v2**
  - 自研 extension / panel。
  - 直接连接 Host 或官方 rich client 接口。
  - 让 IDE 集成不再依赖 wrapper 的兼容边界。

### 2.3 关于“自动注册所有会话”

本方案不建立在“Codex 提供统一注册总线”的前提上。

当前设计采用的是：

- `host launch`
- `wrapper self-register`

而不是：

- 被动旁路发现所有本地会话

这意味着：

- Host 能完整控制自己启动的会话。
- Host 不承诺识别和接管用户直接启动的原生会话。

---

## 3. 总体架构

### 3.1 角色划分

Host 内部按以下子系统拆分：

- `Session Registry`
  - 统一登记和管理所有 managed session。

- `Launcher Layer`
  - 启动 CLI 或 IDE 会话。

- `Wrapper Layer`
  - 负责在上游 Codex 进程启动前完成本地注册和元数据注入。

- `Adapter Layer`
  - 负责将不同来源的会话抽象成统一事件模型。

- `Event Bus`
  - 负责事件流转、存储和订阅。

- `HiTL Policy Engine`
  - 负责审批请求的自动决策与人工升级。

- `Session API`
  - 提供给未来 UI、脚本和自动化系统使用。

### 3.2 session 建模原则

Host 监控的核心对象是 **session/thread**，不是窗口，也不是进程。

一个 session 至少包含：

- 来源类型
- Host 本地主键
- 上游会话 ID
- 当前工作目录
- 当前状态
- 时间信息
- 事件流
- 审批状态
- 控制模式
- 注册状态

建议内部统一使用“两阶段绑定”：

```txt
hostSessionId = host-generated
upstreamSessionId/threadId = bind later
```

例如：

```txt
host-cli-0001 -> abc123
host-ide-0001 -> thread-xyz
```

---

## 4. 数据模型

### 4.1 `SessionRecord`

建议定义如下结构：

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

### 4.2 `SessionEvent`

```ts
interface SessionEvent {
  eventId: string
  hostSessionId: string
  controllability: "observed" | "controllable"
  kind:
    | "session_started"
    | "session_ended"
    | "user_input"
    | "assistant_output"
    | "tool_call"
    | "tool_result"
    | "approval_request"
    | "approval_result"
    | "error"
  timestamp: string
  payload: unknown
}
```

### 4.3 `ApprovalRequest`

```ts
interface ApprovalRequest {
  requestId: string
  hostSessionId: string
  riskLevel: "low" | "medium" | "high"
  actionType: string
  summary: string
  rawRequest: unknown
}
```

### 4.4 `ApprovalDecision`

```ts
interface ApprovalDecision {
  requestId: string
  decision: "approve" | "deny" | "escalate"
  decidedBy: "policy" | "human"
  reason?: string
}
```

说明：

- “自动审批”是目标能力，不是所有 transport 的既成事实。
- `approval_result` 的自动回注能力必须结合当前 transport 能力矩阵判断。

### 4.5 transport capability matrix

| transport | session 注册 | 输出采集 | 消息注入 | 自动 HiTL | 稳定性定位 |
|---|---|---|---|---|---|
| `tty` | 支持 | 有限 | 条件支持 | 条件支持 | 体验优先 |
| `exec-json` | 支持 | 完整 | 支持 | 支持 | v1 主路径 |
| `sdk/thread` | 支持 | 完整 | 支持 | 支持 | v1/v2 主路径 |
| `app-server` | 支持 | 完整 | 支持 | PoC 先行 | IDE 长期方向 |

v1 的“完整自动化能力”默认只以 `exec-json` / `sdk/thread` 路径验收。

---

## 5. 交互模式设计

### 5.1 CLI managed session

CLI managed session 支持两种形态：

#### A. TTY 原生终端模式

- Host 启动一个真实的 PowerShell 或 terminal 窗口。
- 窗口内运行 Codex CLI。
- 用户继续在该窗口中直接与 Codex 交互。
- Host 负责：
  - 创建 session 记录
  - 绑定工作目录和启动元数据
  - 基础事件关联
  - 审批感知与有限代理

该模式的目标是：**保留原生 CLI 体验，同时将会话纳入 Host 管理。**

该模式默认不作为完整自动化能力基线，事件完整性和可控性弱于结构化模式。

#### B. 结构化受控模式

- Host 以 `exec-json` 或 `sdk/thread` 方式启动 Codex。
- 事件流直接进入 Host。
- 更适合自动化、回放、批量任务和自动审批。
- 该模式是 v1 自动化和监控的主路径。

该模式的目标是：**让 Host 拥有更高的事件完整性和可控性。**

### 5.2 IDE managed session

IDE managed session 采用“两阶段方案”：

#### v1：wrapper 路线（实验性）

- Host 启动 VS Code。
- VS Code 使用 `codex-wrapper` 作为启动入口。
- wrapper 在启动真实 Codex 前先向 Host 注册。
- 如果 Host 不在线，则 wrapper 按降级策略直接启动真实 Codex。
- 该路线是基于 CLI 可执行路径替换的实验性集成，不应视为稳定的官方第三方注册协议。

该路线的价值是：

- 成本较低。
- 保留较多现有交互方式。
- 有利于快速验证 session 注册、事件关联与审批代理。

#### v2：自研 extension / panel

- 不再依赖 wrapper 作为长期主路径。
- IDE 前端直接连 Host 或上游接口。
- Host 成为会话、消息和审批的唯一控制面。

该路线的价值是：

- 控制力更强。
- 兼容性边界更清晰。
- 更适合长期产品化。

### 5.3 Host 注入消息

Host 应支持向 managed session 注入用户消息，但能力按 transport 分层。

规则如下：

- 只保证对 managed session 生效。
- 不保证对用户绕过 Host 启动的原生会话生效。
- CLI 的消息注入以结构化受控启动为前提。
- TTY 模式下的消息注入只视为条件能力。
- IDE 的消息注入在 v1 先局限于 wrapper 纳管会话的 PoC，在 v2 通过自研 extension 彻底稳定。

### 5.4 HiTL 处理

HiTL 支持级别按 transport 分层定义。

#### A. CLI 结构化受控模式 / SDK 模式

- 默认支持 Host policy 自动决策。
- 支持 `approve`、`deny`、`escalate`。
- 允许人工覆盖。

#### B. CLI TTY 原生模式

- 默认支持审批感知和有限代理。
- 不承诺与结构化模式同等级的稳定自动回注。

#### C. IDE / app-server 路径

- `approval_request` 采集属于 v1 可验证目标。
- `approval_result` 自动回注不写成稳定既有能力。
- 在 PoC 未闭环前，默认策略是升级人工、保留 fallback 或降级为只观测。

Host 需要保留两个通用能力：

- 记录审批请求与审批结果
- 在必要时允许人工覆盖策略决策

---

## 6. Wrapper 设计

### 6.1 CLI wrapper

CLI wrapper 的职责包括：

- 生成 Host 本地 `hostSessionId`
- 收集启动元数据
- 尝试连接本地 Host
- 向 Host 注册 session
- 在上游会话可用后绑定 `upstreamSessionId`
- 再转调真实 Codex

CLI wrapper 的价值是：

- 不改变用户的主要 CLI 使用习惯
- 将 session 创建过程纳入 Host
- 为后续注入消息和审批代理打基础

### 6.2 VS Code wrapper

VS Code wrapper **不是新的 extension**，而是一个本地启动器程序。

链路为：

```txt
VS Code 扩展 -> codex-wrapper -> Host 注册 -> 真实 codex
```

wrapper 的职责是：

- 对外伪装为 `codex`
- 在真实 Codex 启动前完成注册
- 注入必要的环境变量或上下文元数据
- 在 Host 不在线时执行降级启动

wrapper 不负责：

- 替换官方扩展 UI
- 伪装成完整的 IDE 客户端
- 在 v1 中承担所有会话逻辑

### 6.3 Host 不在线时的降级策略

当 wrapper 启动时，如果 Host 不在线：

- wrapper 允许直接启动真实 Codex
- 该会话不记为 managed session
- Host 后续不承诺对该会话进行控制

---

## 7. Host API 草案

建议在 v1 中定义以下本地 API：

### 7.1 `POST /sessions/cli`

用途：

- 启动一个新的 CLI managed session

请求参数：

- `mode: "tty" | "exec-json" | "sdk"`

返回：

- `hostSessionId`
- `terminalLaunchInfo`

### 7.2 `POST /sessions/ide`

用途：

- 启动一个新的 IDE managed session

请求参数：

- `mode: "wrapper-managed"`

返回：

- `hostSessionId`
- `workspaceRoot`
- `wrapperLaunchInfo`

### 7.3 `POST /sessions/{id}/messages`

用途：

- 向受控 session 注入一条用户消息

### 7.4 `GET /sessions`

用途：

- 列出当前所有 managed session

### 7.5 `GET /sessions/{id}`

用途：

- 查看单个 session 的当前状态与元数据

返回需包含：

- `registrationState`
- `transportCapabilities`

### 7.6 `GET /sessions/{id}/events`

用途：

- 顺序读取该 session 的事件流

要求：

- 事件可区分 `observed` 与 `controllable`

### 7.7 `POST /approvals/{requestId}/decision`

用途：

- 提交审批决策结果

返回要求：

- 仅当当前 transport 支持自动回注时返回成功
- 否则返回 `needs-human-fallback` 或等价状态

---

## 8. 能力等级划分

### 8.1 Managed CLI Session

具备以下能力：

- 可由 Host 启动
- 可注册
- 可监控
- 可记录事件
- 在结构化模式下可处理 HiTL
- 在结构化模式下可支持 Host 注入消息

### 8.2 Managed IDE Session

具备以下能力：

- 可由 Host 启动
- 可由 wrapper 注册
- 可建立受控 session 记录
- 可采集事件
- 可验证审批链路
- 后续可演进为更完整的自研客户端模式

### 8.3 Unmanaged Session

定义如下：

- 用户绕过 Host 直接启动的原生会话

v1 策略：

- 不纳管
- 不承诺识别
- 不承诺控制

---

## 9. 实施路线

### Phase 1

- 实现 `Session Registry`
- 实现 CLI launcher
- 实现基础 CLI wrapper
- 建立最小事件存储

### Phase 2

- 实现 `HiTL Policy Engine`
- 支持 CLI 结构化 managed session 的消息注入
- 补齐结构化受控模式

### Phase 3

- 实现 VS Code wrapper 集成
- 建立 IDE managed session 的注册和事件关联

### Phase 4

- 自研 extension / panel
- 减少对 wrapper 路线的长期依赖

---

## 10. 风险与约束

### 10.1 VS Code 路线兼容性风险

v1 的 wrapper 路线本质上是启动入口接管，而且属于实验性集成，不应被描述为“官方稳定的第三方注册协议”。

### 10.2 CLI 事件完整性差异

真实终端窗口模式更接近用户习惯，但事件完整性、消息注入稳定性和自动化可控性弱于结构化模式。

### 10.3 HiTL 回注仍需 PoC

审批请求的接收、策略判定和回注结果需要尽早做原型验证。

### 10.4 平台边界

v1 默认按本地单机方案设计，不扩展到跨机器调度、远程工作节点或组织级审计平台。

---

## 11. 验收场景

### 场景 1：CLI 启动注册

- 通过 Host 启动一个 `exec-json` 或 `sdk` CLI session
- Host 先生成 `hostSessionId`
- 后续成功补绑定 `upstreamSessionId`
- 事件流中出现 `session_started`

### 场景 2：CLI 直接交互

- 用户在终端中直接输入 prompt
- Host 能关联到对应 TTY session
- Host 能看到基础输出事件

### 场景 3：CLI 自动审批

- 结构化 CLI 会话触发审批请求
- Host 接收到审批事件
- Policy Engine 对低风险动作自动返回结果
- 高风险动作升级人工

### 场景 4：CLI 程序注入

- 通过 Host API 向结构化 CLI session 注入消息
- 消息进入同一会话上下文
- 结果继续写入同一事件流

### 场景 5：IDE 启动注册

- 通过 Host 启动 VS Code managed session
- wrapper 成功向 Host 注册
- Host 成功建立 IDE session 记录

### 场景 6：IDE 输出与审批流

- 在受控 IDE 会话中触发模型输出
- Host 可以关联输出事件
- `approval_request` 采集链路可验证
- `approval_result` 若无法稳定自动回注，则记录为 PoC 未闭环

### 场景 7：Host 离线降级

- wrapper 启动时 Host 不在线
- wrapper 直接启动真实 Codex
- 该会话不记为 managed session

### 场景 8：绕过 Host 的原生会话

- 用户直接启动原生 Codex
- Host 不保证识别
- 系统行为符合 out-of-scope 约定

---

## 12. 当前默认假设

- 当前仓库只有 `docs/research.md`，没有现成实现。
- 本文档作为后续实现的主规划文档。
- v1 是本地单机 Host。
- 只覆盖 managed session。
- v1 的完整能力承诺只覆盖 CLI 结构化受控路径。
- CLI TTY 模式是体验增强路径，不作为完整自动化能力基线。
- 不实现旁路发现模式。
- VS Code wrapper 是实验性接入，不作为长期主路径。
- VS Code 路线采用“先 wrapper，后演进到自研 extension”。
