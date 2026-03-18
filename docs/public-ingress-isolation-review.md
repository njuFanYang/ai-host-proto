# Public Ingress Isolation Review

## Status

- [x] Review completed
- [x] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Conclusion

Host 现在区分两类 surface：
- `internal`
  - `POST /sessions/cli`
  - `POST /sessions/{id}/approvals`
- `external`
  - session read / stream / message
  - approval read / decision
  - channel binding API

这样 future channel adapter 不会碰到高权限启动入口。

## Remaining Risk

还没做：
- adapter auth
- public deployment boundary
- Feishu signer / token policy
