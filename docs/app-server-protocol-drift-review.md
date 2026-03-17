# App-Server Protocol Drift Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews the current use of `codex app-server` and the risk of protocol drift.

The focus is:

- how much of the app-server protocol is currently hand-coded
- how stable that is likely to be over time
- when the current implementation is still acceptable
- where the boundary should move toward the official SDK

## Files Reviewed

- `src/host/app-server-client.js`
- `src/wrapper/codex-wrapper.js`
- `src/host/codex-cli.js`
- `docs/plan.md`

## Relevant Official Guidance

The official Codex app-server documentation describes `codex app-server` as the interface used by rich clients such as the VS Code extension.
It uses bidirectional JSON-RPC 2.0 over either:

- `stdio` with JSONL
- or experimental WebSocket transport

The docs also explicitly state that the message schema is version-specific and that you can generate TypeScript schema or JSON Schema artifacts from the exact Codex version you are running.

The same official docs also say:

- use app-server when you want deep client-style integration
- use the Codex SDK when you want programmatic control in your own application

The official SDK docs describe the SDK as the more comprehensive and flexible route for application/server-side integration.

## Current Design

The current host implements a hand-written app-server client.

It currently performs:

- `initialize`
- `initialized`
- `thread/start`
- `turn/start`
- `thread/read`

It also hand-maps selected notifications and server requests into host events.

Examples of currently recognized protocol messages:

- `thread/started`
- `turn/started`
- `turn/completed`
- `item/agentMessage/delta`
- `item/completed`
- `thread/compacted`
- `error`
- selected approval request methods

Wrapper-managed proxy mode also contains a second hand-written partial protocol observer.

So today the host has two custom protocol-consuming surfaces:

- direct `app-server` client
- wrapper-managed proxy observer

## What Works

The current implementation is good enough to prove that app-server integration is feasible.

It already demonstrates:

- successful startup handshake
- thread binding
- turn execution
- polling via `thread/read`
- approval request observation
- approval callback injection for supported methods

That is sufficient for a local experimental control plane.

## Problems

### 1. The implementation is version-coupled, but the code treats it as mostly static

The official docs explicitly say the schema is version-specific.

Current code instead hard-codes:

- message names
- selected payload shapes
- selected approval methods
- selected turn/read assumptions

This means any upstream protocol evolution may require code changes, but the current implementation has no schema-generation or version-gating mechanism.

### 2. There are two separate partial protocol consumers

The host currently interprets protocol in two places:

- `src/host/app-server-client.js`
- `src/wrapper/codex-wrapper.js`

That increases drift risk because:

- direct managed path may map one set of messages
- wrapper-managed path may map another set
- protocol coverage may diverge silently

This is manageable for a prototype.
It is not ideal as a long-lived integration surface.

### 3. Unknown server requests are rejected generically

In direct app-server mode, unknown server requests are replied to with JSON-RPC `-32601`.

That is safe in the sense that the host does not hang.
But it is fragile because future protocol additions may require specific handling rather than generic rejection.

### 4. `sdk/thread` currently suggests a stability level that is not real

Current `sdk/thread` is not a real SDK-backed path.
It is an app-server compatibility shim that reuses the same transport implementation.

That means the current naming risks overstating:

- maturity
- protocol stability
- long-term maintainability

### 5. app-server is the right interface for rich clients, but not necessarily the right long-term app integration primitive

The official docs draw a useful distinction:

- rich client / deep UI integration => app-server
- server-side application integration => SDK

The current project uses app-server both for:

- direct session control
- pseudo-SDK compatibility

That works for early validation, but it blurs the architecture boundary.

## Reconsidered Implementation Possibility

After checking official docs, the stronger long-term conclusion is:

- keep app-server for wrapper-managed / rich-client-style integration
- prefer the official SDK for application-style control flows

That means the current implementation direction does not need to be abandoned.

But it does need a sharper split:

- `app-server` remains an experimental rich-client transport
- `sdk/thread` should eventually become a true SDK-backed transport

## Minimum Acceptable Near-Term Improvements

If the project keeps the current hand-written app-server path for now, the following minimum improvements are recommended:

1. Record the exact protocol methods currently supported.
2. Centralize message mapping rules as much as possible.
3. Add a clear compatibility statement in docs:
   - app-server path is version-sensitive
   - wrapper path is observational/experimental
4. Add regression fixtures for protocol message variants already observed.
5. Stop implying that `sdk/thread` is already a real SDK layer.

## Preferred Long-Term Direction

### direct application control

Use the official Codex SDK.

That is the better fit for:

- server-side orchestration
- channel adapters
- future Feishu integration
- session continuation from application code

### wrapper-managed / IDE-adjacent control

Keep app-server for:

- wrapper-managed IDE observation
- rich client style interaction
- protocol-level research and compatibility work

## Review Conclusion

The current app-server implementation is acceptable as a prototype transport.

It is **not** a sufficient long-term abstraction boundary by itself.

The biggest risk is not that the current code is immediately broken.
The biggest risk is that the codebase may keep expanding on a hand-written protocol layer that the official docs already position as version-specific and rich-client oriented.

So this item should stay under active redesign attention.

The right strategic move is:

- preserve app-server path for experimental rich-client integration
- migrate true application control toward the official SDK

## Suggested Next Steps

1. Keep the current direct app-server path, but clearly label it experimental/version-sensitive.
2. Change the internal roadmap so `sdk/thread` means real SDK-backed transport in the future.
3. Add a separate review for `sdk/thread` naming and capability boundary.
4. When Feishu work begins, prefer SDK-backed session control rather than building more business logic on app-server shim behavior.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
