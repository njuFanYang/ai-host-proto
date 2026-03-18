# Event Mapping Review

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Scope

只关注 CLI transports 的事件归一化：
- `exec-json`
- `app-server`
- `sdk`

## Main Gap

未来 channel adapter 仍需要一层 channel-safe render projection，避免把太多 transport noise 直接暴露出去。
