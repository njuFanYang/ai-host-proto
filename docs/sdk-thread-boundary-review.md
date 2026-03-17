# SDK-Thread Boundary Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews the current `sdk/thread` transport naming and capability boundary.

The focus is:

- whether the current name matches the real implementation
- what assumptions the name may cause
- whether the current behavior is acceptable for prototype scope
- what the future naming or transport split should be

## Files Reviewed

- `src/host/app-server-client.js`
- `src/host/codex-cli.js`
- `docs/plan.md`
- `README.md`

## Current Implementation Reality

Today `sdk/thread` is not a dedicated SDK-backed transport.

It is implemented by reusing the same `codex app-server` transport stack that direct app-server mode uses.

The key difference today is metadata and intent, not underlying control mechanism.

In practice:

- `mode = sdk`
- `transport = sdk/thread`
- `runtime.mode = sdk`

But the implementation still:

- launches `codex app-server`
- performs JSON-RPC handshake
- drives `thread/start`
- drives `turn/start`
- drives `thread/read`

So the current path is:

```txt
sdk/thread => app-server compatibility shim
```

not:

```txt
sdk/thread => official SDK transport
```

## What Works

For prototype scope, the current choice had value.

It allowed the project to:

- represent a future SDK-oriented control path conceptually
- validate session continuation behavior
- keep the control plane shape compatible with a future SDK-backed implementation

As a migration placeholder, this is defensible.

## Problems

### 1. The name suggests a stronger boundary than the code actually provides

`sdk/thread` sounds like:

- real SDK semantics
- real SDK lifecycle
- real SDK stability expectations

But the implementation is still an app-server shim.

This can mislead future contributors and future planning decisions.

### 2. Transport capability claims may be over-inferred

Because the name includes `sdk`, readers may assume:

- this path is less protocol-sensitive than app-server
- this path is closer to official long-term support
- this path is already suitable for application integrations such as Feishu

Those assumptions are not currently true.

### 3. Documentation can drift into overstating maturity

Even if docs say "compatibility shim", the short name itself still pulls interpretation in the wrong direction.

Over time this creates documentation pressure:

- implementation stays shim-based
- wording slowly gets softer
- readers start mentally upgrading it into a real SDK path

That is a design hygiene issue.

### 4. It blurs future migration planning

If future work eventually introduces the real official SDK, the project will then have two choices:

- replace current `sdk/thread` in place
- or introduce another new name

If the current name remains ambiguous, migration becomes harder to explain.

## Reconsidered Design Boundary

After reviewing the official docs and current code, the clean conceptual split should be:

### app-server family

- direct app-server managed sessions
- wrapper-managed rich-client experimentation
- protocol-sensitive and version-sensitive transport

### SDK family

- application-driven control
- future channel adapters
- future Feishu integration
- official SDK-backed lifecycle

Today the implementation has only the first family, plus a placeholder that points toward the second.

That is acceptable as long as the placeholder is treated honestly.

## Recommended Options

### Option A: Keep behavior, rename for clarity

Rename the current transport to something like:

- `app-server-thread`
- `app-server-compat`
- `app-server-shim`

Pros:

- immediate clarity
- no false SDK expectation

Cons:

- changes current terminology

### Option B: Keep the name temporarily, but harden all wording

If renaming now is too disruptive, then every relevant place should make the boundary explicit:

- docs
- API responses
- runtime metadata
- tests

For example:

- `transport = sdk/thread`
- `runtime.compatibilityShim = app-server`
- docs explicitly say "not SDK-backed"

Pros:

- lower short-term churn

Cons:

- still leaves a misleading short name in place

### Option C: Replace it with a real SDK-backed implementation later

This is the long-term best option.

In that future state:

- `sdk/thread` becomes truthful
- app-server remains a separate path
- Feishu and other channel adapters can rely on the SDK-backed family

But until that replacement happens, the current boundary should still be treated as provisional.

## Recommended Near-Term Decision

The safest near-term decision is:

- keep current behavior
- keep the path explicitly marked as compatibility shim
- do not treat it as Feishu-ready application transport
- plan to replace it with a real SDK-backed path

That keeps the prototype moving without pretending the migration is already done.

## Review Conclusion

The current implementation is acceptable as a placeholder.

The current **name** is the main issue, not the current runtime behavior.

So this item is not primarily a transport correctness bug.
It is a boundary-clarity problem.

That still matters, because boundary confusion turns into bad architecture decisions later.

## Suggested Next Steps

1. Keep current compatibility shim behavior for now.
2. Strengthen wording wherever `sdk/thread` appears.
3. Consider renaming once the next transport cleanup pass starts.
4. Do not use `sdk/thread` as justification for Feishu application integration until a real SDK-backed path exists.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
