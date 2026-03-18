# SDK-Thread Boundary Review

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Conclusion

当前 `sdk/thread` 仍然不是独立 SDK 实现。
它本质上还是 `codex app-server` 的兼容层命名。

这在 CLI-only host 范围内是可接受的，但要持续明确：
- `sdk/thread` 不是官方本地 SDK
- 不应把它当作长期命名已经定稿
- 如果未来真的引入官方 SDK，再重新整理 transport 命名
