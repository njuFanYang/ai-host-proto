# API Surface Layering Review

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Current Layers

- internal host API
  - CLI launch
  - internal approval creation
- external host API
  - session read / message / stream
  - approval read / decision
  - channel binding API

## Note

旧的 wrapper-only API 已从范围移除。
下一步真正需要补的是 channel-facing projection，而不是重新引入 IDE 层。
