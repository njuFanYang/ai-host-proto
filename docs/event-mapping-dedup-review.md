# Event Mapping Completeness And Deduplication Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews how the host currently maps Codex transport events into host events,
and whether those events are complete enough and stable enough for future channel adapters.

The focus is:

- how `exec-json` events are normalized
- how direct `app-server` events are normalized
- how wrapper-managed proxy events are normalized
- where semantic duplicates already exist
- what is still missing before Feishu or another remote channel can safely depend on these events

## Files Reviewed

- `src/host/codex-event-parser.js`
- `src/host/codex-cli.js`
- `src/host/app-server-client.js`
- `src/host/session-registry.js`
- `src/wrapper/codex-wrapper.js`
- `test/codex-event-parser.test.js`
- `test/codex-cli.test.js`
- `test/app-server-client.test.js`

## External Documentation Cross-Check

The current review was also checked against current official Codex docs.

Relevant documented expectations:

- `codex exec --json` emits JSONL events such as `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`
- `item.*` can represent agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates
- `codex app-server` is the rich-client protocol used by clients such as the VS Code extension
- `app-server` uses JSON-RPC with requests, responses, and notifications over stdio by default

That means the host should assume:

- there are more item shapes than just assistant text vs generic tool output
- rich-client transports may expose both streamed notifications and later state reads
- transport events need normalization into a host event model rather than one-off handling per transport

## Current Design

### 1. `exec-json` path

`src/host/codex-event-parser.js` maps only a narrow subset:

- `thread.started` -> `session_started`
- `turn.started` -> `turn_started`
- `turn.completed` -> `turn_completed`
- `turn.failed` -> `error`
- `item.completed` with `agent_message` -> `assistant_output`
- every other `item.completed` -> `tool_result`
- everything else -> `raw_event`

This is simple and usable, but it is incomplete.

The main limitation is that many documented `item.*` variants are collapsed into one generic `tool_result` bucket.

Examples that are not separated today:

- reasoning output
- plan output
- file change items
- command execution items
- web search items
- MCP items

So the `exec-json` path currently gives broad observability, but not rich semantic typing.

### 2. Direct `app-server` path

`src/host/app-server-client.js` handles more event forms.

Notification mapping includes:

- `thread/started`
- `turn/started`
- `turn/completed`
- `item/agentMessage/delta`
- `item/completed`
- `thread/compacted`
- `error`
- approval request methods

There is also a second path based on `thread/read` polling.

That polling path reconstructs turn state and maps unseen items into:

- `assistant_output`
- `plan_output`
- `reasoning_output`
- `tool_result`

So direct `app-server` currently has the richest mapping logic in the codebase.

### 3. Wrapper-managed proxy path

`src/host/codex-cli.js` mirrors part of the `app-server` protocol and also supports alternate event names such as:

- `codex/event/agent_message_content_delta`
- `codex/event/item_completed`
- `codex/event/task_complete`

This is useful because it makes wrapper-managed sessions observable without directly embedding inside VS Code.

But the wrapper path still shares the same semantic narrowing for completed items:

- assistant message -> `assistant_output`
- everything else -> `tool_result`

So even though the wrapper path recognizes more wire-level variants, it still does not preserve all item semantics.

## What Works

### The host already has a real normalization layer

This is not raw pass-through logging only.

The code already creates host-level event kinds such as:

- `assistant_output`
- `assistant_output_delta`
- `turn_started`
- `turn_completed`
- `context_compacted`
- `approval_request`
- `approval_result`

That is the right direction.

### The direct `app-server` path already does partial deduplication

The strongest current dedup logic is in `extractTurnSnapshot()` plus `seenItemIds`.

That protects against one important duplicate class:

- item already seen from live notifications
- same item later seen again from `thread/read`

Without that set, the direct `app-server` path would double-append many completed items.

### The wrapper proxy already avoids one approval echo loop

The wrapper tracks:

- `pendingApprovalMethods`
- `hostInjectedRequests`
- `hostResolvedApprovalIds`

That prevents one important false duplicate:

- Host injects an approval result
- wrapper sees the same client response on stdin
- wrapper suppresses re-reporting it as if the human typed it locally

That is a good local guard.

## Problems

### 1. Event completeness differs too much by transport

Today the same semantic Codex action can produce different host event shapes depending on transport.

Examples:

- reasoning appears as `reasoning_output` only on the `thread/read` path, not on `exec-json`
- plans appear as `plan_output` only on the `thread/read` path, not on `exec-json`
- many completed items become plain `tool_result` on `exec-json` and wrapper paths
- assistant deltas exist on `app-server` and wrapper paths, but not on `exec-json`

This means a future Feishu adapter cannot assume a stable cross-transport event vocabulary yet.

### 2. Canonical events and observed side-band events are mixed together

Approval handling already creates semantic overlap.

Current approval request flow often produces:

- `approval_request` from `SessionRegistry.createApproval()`
- `approval_request_observed` from transport-specific handling

Current approval result flow often produces:

- `approval_result` from `SessionRegistry.resolveApproval()`
- `approval_result_observed` or `approval_result_upstream` from transport-specific handling

That is not inherently wrong.

But it means the event stream currently mixes:

- canonical domain events
- transport observation events
- transport callback lifecycle events

without a clear contract for which one downstream consumers should render as "the real approval event".

For a human UI, that is manageable.
For a channel adapter, that becomes a duplicate-rendering risk.

### 3. Turn-level deduplication is weaker than item-level deduplication

Item dedup has `seenItemIds` in the direct `app-server` path.

But there is no equivalent stable dedup key for:

- `turn_completed`
- `turn_started`
- `context_compacted`
- `error`

The most likely race is:

- a live `turn/completed` notification arrives
- a scheduled `thread/read` poll also sees the same turn as completed
- both paths append `turn_completed`

The code often avoids this in practice because notifications stop polling quickly.
But it is timing-dependent, not identity-based.

### 4. `exec-json` has almost no semantic dedup or item typing

The `exec-json` path is currently the weakest normalization path.

It is acceptable for local prototype control because it already captures:

- session start
- turn boundaries
- assistant output
- fallback raw events

But it is not strong enough to be the canonical host event model yet.

The official docs explicitly describe richer `item.*` categories than the current parser preserves.

### 5. Event records have host-generated IDs only, not upstream idempotency keys

`SessionRegistry.appendEvent()` generates a fresh `eventId` each time.

That is useful for storage.
It is not enough for deduplication.

What is missing is a transport-derived identity layer such as:

- `threadId`
- `turnId`
- `itemId`
- `rpcRequestId`
- `transportEventKey`

Without that, the host cannot reliably answer:

- is this the same upstream event seen twice?
- is this a retransmission?
- is this the canonical event or an observation of the canonical event?

This becomes more important once a remote channel may retry messages or reconnect mid-stream.

### 6. The current model is not yet ready for Feishu-style delivery retries

Feishu or any other remote channel will eventually require its own dedup model.

That dedup cannot be built cleanly if host events themselves do not carry stable upstream identity.

Otherwise the channel adapter has to guess based on:

- timestamp
- event kind
- payload similarity

That is fragile and will break on reconnects or repeated notifications.

## Reconsidered Event Model Boundary

The host should stop thinking in terms of:

```txt
transport event == host event
```

and move toward:

```txt
transport event -> canonical domain event
transport event -> transport observation event
```

Those are different things.

Example:

- canonical event: `approval_request`
- observation event: `approval_request_observed`
- transport callback event: `approval_result_upstream`

All three may be stored.
But only one should normally drive downstream conversational rendering.

## Recommended Redesign

### 1. Introduce a canonical event schema with upstream identity

Every stored event should eventually be able to carry fields such as:

- `category`
- `kind`
- `transport`
- `upstreamThreadId`
- `upstreamTurnId`
- `upstreamItemId`
- `upstreamRpcRequestId`
- `transportEventKey`
- `isCanonical`

This does not require removing the current `kind` field immediately.

But it does require a stronger identity layer.

### 2. Separate canonical conversational events from transport lifecycle events

Recommended split:

- conversational canonical events
  - `user_input`
  - `assistant_output`
  - `plan_output`
  - `reasoning_output`
  - `tool_result`
  - `approval_request`
  - `approval_result`
- transport lifecycle events
  - `approval_request_observed`
  - `approval_result_observed`
  - `approval_result_upstream`
  - `wrapper_command_*`
  - `raw_event`
  - `raw_rpc_response`
  - `stderr`

This would make downstream rendering much simpler.

### 3. Expand `exec-json` item mapping

The `exec-json` parser should not continue collapsing all non-agent items into `tool_result`.

It should at least distinguish:

- reasoning
- plan
- command execution
- file change
- MCP tool call
- web search

If some shapes are not yet stable, they can still be stored under a more specific fallback such as `tool_result` plus `itemType`.

### 4. Add explicit dedup keys per transport

Examples:

- `exec-json`: `thread.started:<thread_id>`, `item.completed:<item.id>`, `turn.completed:<turn id if present>`
- `app-server`: `notif:item/completed:<item.id>`, `notif:turn/completed:<turn.id>`, `rpc:<id>`
- wrapper proxy: same as `app-server`, but tagged with `wrapper`

Then `SessionRegistry.appendEvent()` can optionally skip or merge duplicates.

### 5. Define a channel-facing render policy

Before Feishu work starts, the host should define:

- which event kinds are renderable in a chat surface
- which are audit-only
- which are transport-debug-only

Otherwise the first channel adapter will accidentally render too much internal noise.

## Review Conclusion

The current event system is good enough for local host prototyping because it already captures the main session lifecycle and approval lifecycle.

It is **not** yet complete enough or deduplicated enough to act as a stable cross-transport event backbone.

The main missing pieces are:

- a transport-independent canonical event model
- upstream idempotency keys
- a clearer split between canonical conversation events and transport observation/debug events

So this item should remain open before Feishu or any other remote session channel depends on host events as its primary source of truth.

## Suggested Next Steps

1. Design a canonical host event envelope with upstream identity fields.
2. Expand `exec-json` item typing so it is closer to `app-server` richness.
3. Introduce transport dedup keys before channel adapter work begins.
4. Define which events are renderable vs audit-only.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
