# Observability Review

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

## Current Baseline

已能观察：
- session lifecycle
- approval lifecycle
- controller attach / detach
- session input queue lifecycle
- channel binding attach / switch / detach

## Removed Scope

不再跟踪任何 IDE wrapper command lifecycle，因为该能力已移除。
