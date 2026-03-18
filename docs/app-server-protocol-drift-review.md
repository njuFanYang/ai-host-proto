# app-server Protocol Drift Review

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Scope

当前 review 只关注 CLI 里的两条结构化路径：
- `app-server`
- `sdk`

## Conclusion

项目仍然手写消费了一部分 `codex app-server` JSON-RPC 语义。
这对 CLI prototype 可接受，但仍然有 drift 风险。

建议：
- 把 `app-server` 继续视为实验性协议适配层
- 把 `sdk` 命名边界保持清晰，不宣传成独立本地 SDK
