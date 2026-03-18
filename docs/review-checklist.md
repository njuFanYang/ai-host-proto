# Host Review Checklist

## Scope

当前 checklist 只针对 **CLI-only host**。

P0:
- [x] Public ingress vs internal control surface
- [x] Per-session write concurrency
- [x] Channel binding model

P1:
- [x] app-server protocol drift boundary
- [x] approval safety model
- [x] event mapping baseline

P2:
- [x] persistence hardening baseline
- [x] API surface layering
- [x] observability baseline
- [x] documentation realignment

## Notes

- VS Code / IDE / wrapper 相关项已整体移出范围。
- 未来 Feishu 接入只允许依赖 CLI session。
