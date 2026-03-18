# Approval Safety Review

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Scope

只关注 CLI session 与 future channel adapter 之间的审批边界。

## Current Rule

- policy auto decision 只在 transport capability 允许时闭环
- human decision 可从 external surface 提交
- channel approval 未来仍需额外 auth 与 policy 分层
