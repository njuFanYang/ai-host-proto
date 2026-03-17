# Per-Session Write Concurrency Review

## Scope

- [x] Review completed
- [x] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews how the current host behaves when more than one controller writes to the same managed session.

The focus is:

- direct CLI writes
- direct app-server writes
- wrapper-managed IDE writes
- future Feishu channel writes

This review does not redesign the whole event model.
It only evaluates whether current write behavior is safe enough once multiple controllers exist.

## Files Reviewed

- `src/host/app-server-client.js`
- `src/host/codex-cli.js`
- `src/server.js`
- `src/host/session-registry.js`
- `src/host/approval-service.js`

## Implementation Note

The prototype now includes a first-pass host-level session controller and input queue:

- `SessionControlService` persists attached controllers in session metadata.
- Only one `active-write` controller is allowed unless takeover is explicitly requested.
- `POST /sessions/{id}/messages` now writes through the host-level input queue instead of calling the transport directly.
- Inputs are blocked while a session is in `waiting_approval` and resume after approval resolution.
- Deferred transports such as wrapper-managed IDE sessions now hold later queued inputs until the host receives a fresh `session available` signal.
- `GET /sessions/{id}/controllers` and `GET /sessions/{id}/inputs` expose the current controller and queue state.

This closes the most immediate multi-controller correctness gap for v1 host-managed sessions.
It does not yet make the Feishu dependency safe by default, because public ingress isolation and channel binding policy still remain open.

The sections below preserve the original review findings that motivated this redesign. They are no longer a description of the exact current code path in every detail.

## Current Write Model

Today the host effectively assumes a mostly single-writer model per session.

### exec-json

`exec-json` is serialized by process lifecycle:

- if a run is already active, `sendMessage()` rejects with `409`
- next prompt must wait until the current run exits

This is a coarse but clear single-writer rule.

### direct app-server

`app-server` uses an explicit in-flight turn guard:

- `startTurn()` rejects when `connection.inFlightTurn` is already true
- only one turn can be active per managed session at a time

This is the most important concurrency rule in the current implementation.

### wrapper-managed app-server proxy

Wrapper-managed sessions do not yet have a host-level write scheduler.

Instead:

- Host enqueues wrapper commands
- wrapper polls and executes them in order
- concurrency is controlled only by queue order, not by a session-level arbitration model

### approvals

Approval decisions are also effectively single-path:

- approval may be resolved by policy
- or by human
- or by wrapper-observed client response

But the current model does not yet define controller priority across:

- local terminal
- IDE
- future channel adapter

## What Works

For a local prototype, the current behavior is internally consistent:

- direct app-server prevents overlapping turns
- exec-json prevents overlapping runs
- wrapper-managed control is funneled through queued commands

That is enough for one active operator path at a time.

## Problems

### 1. There is no explicit controller model

The host does not currently model:

- who is the active controller of a session
- whether the session is attached to more than one controller
- whether one controller is read-only while another is read-write

Without that, future multi-endpoint operation becomes ambiguous.

Example:

- local CLI user is still interacting
- Feishu user sends another prompt
- IDE wrapper also forwards a write-capable action

The system has no first-class rule for who wins.

### 2. direct app-server will reject concurrent writes, but only at transport level

The current protection sits inside `startTurn()`.

That means the system behavior is:

- write request arrives
- transport rejects with `409 already has an in-flight turn`

That is acceptable for internal transport correctness.
It is not enough for a multi-controller host.

At host level, rejected writes are still a poor UX because:

- the caller receives a conflict
- the host does not queue and serialize the write
- no cross-controller fairness exists

### 3. wrapper-managed queue is ordered, but not coordinated with other writers

Wrapper-managed sessions have a wrapper command queue.
But that queue is local to wrapper-managed command delivery.

It is not a general session input queue.

So even if wrapper-managed writes are serialized among themselves, they are not yet coordinated with:

- future channel writes
- future host-side operator writes
- any local out-of-band actions

### 4. approvals can race with user input

A session in `waiting_approval` can still have multiple potential controller paths.

Current model does not define:

- whether new prompts should be blocked while approval is pending
- whether channel attach should become read-only during approval
- whether the same approval can be answered from more than one controller race

The approval service resolves the approval record, but controller conflict policy is still missing.

### 5. Feishu will turn this from an edge case into a normal case

Once Feishu is added, multiple controllers are no longer theoretical.

A realistic session may have:

- local CLI window
- VS Code wrapper-managed IDE
- Feishu bound conversation

If all of them can send messages, then transport-level 409 is not a sufficient host behavior.

## Reconsidered Feishu Impact

This review changes the Feishu v1 interpretation in an important way:

Feishu should not be treated as "just another place to call `/sessions/{id}/messages`".

Feishu should instead be treated as:

- a remote controller candidate
- usually secondary to the local primary controller
- often better as read-mostly unless explicitly attached for write mode

That means Feishu integration needs a controller policy, not just a routing layer.

## Recommended Model

The host should add two explicit concepts.

### 1. Session input queue

Each managed session should have a host-level input queue.

That queue should serialize write intents before they hit the transport.

Possible lifecycle:

```txt
queued -> executing -> completed
queued -> blocked -> resumed
queued -> failed
```

This queue is different from wrapper command delivery:

- input queue is session-level
- wrapper command queue is transport-delivery-level

### 2. Controller role model

Each session should track attached controllers, for example:

- `local-cli`
- `local-ide`
- `feishu:<conversationId>`

And each controller should have a mode:

- `watch`
- `request-write`
- `active-write`

The host should then define rules such as:

- only one `active-write` controller at a time
- other controllers remain watch-only
- session owner can be switched explicitly
- approvals may require active-write ownership or stronger role

## Minimum Acceptable v1 Policy

For Feishu v1, a conservative policy is enough.

Recommended:

- every session can have many watchers
- only one active writer exists at a time
- Feishu defaults to `watch`
- Feishu must explicitly `attach` to become the active writer
- if local IDE or CLI is already active writer, Feishu attach should either:
  - fail
  - or request takeover

This would avoid many ambiguous concurrent writes.

## Why This Is Better Than Only Returning 409

Transport-level `409` protects correctness.

Host-level queueing and controller policy protect usability.

Without host-level arbitration:

- users see conflicts
- retries become manual
- channel UX feels random

With host-level arbitration:

- writes become predictable
- session ownership is visible
- channel behavior becomes explainable

## Review Conclusion

The current implementation is transport-safe enough for one active writer.

It is **not** host-safe enough for multi-controller session use.

So the current design is still acceptable for local prototype scope, but not yet sufficient for Feishu-backed remote interaction.

This item should remain `P0`.

## Suggested Next Steps

1. Add a host-level session input queue abstraction.
2. Add controller metadata to session state.
3. Define attach / detach / takeover policy before Feishu write-mode is implemented.
4. Keep Feishu v1 conservative:
   - watch first
   - explicit attach for write

## Status

- [x] Review completed
- [x] Redesign implemented
- [ ] Safe enough for Feishu dependency



