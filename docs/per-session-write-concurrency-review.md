# Per-Session Write Concurrency Review

## Status

- [x] Review completed
- [x] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Implemented Model

当前 Host 已实现：
- 每个 session 一个 host-level input queue
- 每个 session 一个 controller model
- 同时只允许一个 `active-write` controller
- approval pending 时阻塞新输入
- session available 后继续 drain queue

## Scope Note

该模型现在只针对 CLI session：
- `exec-json`
- `app-server`
- `sdk`
- `tty`

不再包含 IDE / wrapper 路径。
