# Persistence Hardening Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews what host state is currently persisted, what is reconstructed after restart,
and what important runtime state is still memory-only.

The focus is:

- session record persistence
- event persistence
- approval persistence
- wrapper command queue persistence
- runtime recovery after host restart

## Files Reviewed

- `src/host/session-registry.js`
- `src/host/codex-cli.js`
- `src/host/app-server-client.js`
- `src/host/approval-service.js`
- `src/host/utils.js`
- `src/wrapper/codex-wrapper.js`
- `test/session-registry.test.js`
- `test/server.test.js`

## External Documentation Cross-Check

The current review was also checked against current official Codex docs.

Relevant documented expectations:

- Codex stores local state under `CODEX_HOME`, which defaults to `~/.codex`
- resumed runs keep the original transcript, plan history, and approvals
- the app-server protocol is designed for conversation history, approvals, and streamed agent events

This matters because the host sits beside a tool that already has its own local persistence model.

So the host must be explicit about which guarantees come from:

- Codex upstream persistence
- host-local control-plane persistence

Those are not the same thing.

## Current Design

### 1. Session and event persistence

`SessionRegistry` persists each session into:

- `.host-data/sessions/<hostSessionId>.json`

Each file contains:

- `record`
- `events`

Persistence happens eagerly on:

- session creation
- session update
- event append

So the current host does have a real local persistence layer.

### 2. Approval persistence

Approvals are not stored in a separate file.

Instead:

- `approval_request` events carry the approval payload
- `approval_result` events carry the resolution payload
- `loadPersistedSessions()` rebuilds the in-memory approval map from those events

That is a valid lightweight design for a prototype.

### 3. Runtime control state

Several important runtime structures are memory-only:

- `CodexCliManager.activeRuns`
- `CodexCliManager.wrapperCommands`
- `CodexAppServerClient.connections`
- RPC pending request maps
- polling timers
- `seenItemIds`
- wrapper proxy local maps such as:
  - `pendingApprovalMethods`
  - `hostInjectedRequests`
  - `hostResolvedApprovalIds`

These are not reconstructed after host restart.

## What Works

### The host already survives a basic process restart for history viewing

If the host is stopped and started again, it can still load:

- prior sessions
- prior event streams
- rebuilt approvals

That is useful for local inspection and audit.

The existing test coverage already proves the basic session + approval reload path.

### Approval reconstruction is simple and understandable

Because approvals are derived from persisted events, the logic is easy to follow.

For a prototype, this is better than prematurely inventing a second storage system.

### Persistence layout is easy to inspect manually

One-session-per-file under `.host-data/sessions` is pragmatic.

For debugging, it is very convenient.

## Problems

### 1. Persistence is history-oriented, not recovery-oriented

The current system persists enough state to inspect what happened.

It does not persist enough state to reliably resume control over what was in progress.

That is the central gap.

Examples of non-recoverable state today:

- wrapper command queue contents
- which wrapper commands were claimed but not completed
- app-server RPC requests currently waiting for responses
- whether a turn was in flight
- which item ids have already been observed
- wrapper proxy temporary correlation state

So restart recovery today is closer to:

```txt
load old history
mark things ended or reconnect opportunistically
```

not:

```txt
recover exact control state
resume delivery safely
```

### 2. Wrapper command delivery is lost across restart

This was already identified in the queue review, but it is also a persistence problem.

Current queue state lives only in memory:

- `pending`
- `inFlight`

If the host restarts:

- queued commands disappear
- claimed but incomplete commands disappear
- the wrapper keeps running, but Host no longer knows which commands were outstanding

That is not acceptable once remote channels depend on command delivery.

### 3. In-flight approval state can become ambiguous

A plain pending approval reconstructs correctly after restart because its `approval_request` event is persisted.

But ambiguous windows still exist.

Example:

1. Host accepts a decision.
2. Host sends upstream callback or queues wrapper callback.
3. Host crashes before the final local resolution event is fully reflected.

Possible outcomes after restart:

- approval still appears pending even though upstream may have received the answer
- approval appears resolved locally but the upstream callback may not actually have been applied

There is no reconciliation model for this class of partial failure.

### 4. File persistence is not atomic

`persistSession()` writes the entire session file directly with `fs.writeFileSync()`.

There is no:

- temp file write
- atomic rename
- checksum
- journal

If the process crashes mid-write, the file can be partially written or corrupted.

`loadPersistedSessions()` then silently ignores corrupt files.

So a single interrupted write can cause silent session loss.

That is acceptable for a prototype.
It is not strong enough for a durable control plane.

### 5. The storage model rewrites the full event history every time

Each new event triggers a full rewrite of the whole session payload.

That creates two problems:

- write cost grows with event count
- corruption window grows with session size

For longer-lived sessions, this becomes increasingly inefficient.

It also makes a future high-volume channel adapter less safe.

### 6. There is no storage schema versioning or migration boundary

Persisted session files currently assume the in-memory shape is the storage shape.

There is no explicit:

- schema version
- migration routine
- backward compatibility contract

That makes future redesign harder, especially once channel bindings and command records are added.

### 7. Multi-process safety is not defined

The current host design implicitly assumes one host process owns one `.host-data` directory.

There is no:

- file lock
- writer lease
- host instance id

So two host processes pointing at the same project root can overwrite each other's session files.

This is probably acceptable for local prototype use, but the assumption should be documented.

### 8. Restart behavior is transport-specific and lossy

After restart, each transport behaves differently:

- `exec-json`
  - the host can sometimes detect the child PID is still alive
  - but it cannot recover missed stdout events from the time it was down
- direct `app-server`
  - in-memory connection state is gone
  - the host effectively treats the session as disconnected
- wrapper-managed
  - session history survives
  - wrapper may continue posting events using the old `hostSessionId`
  - but queued commands and in-flight correlation state are lost

So restart currently preserves observability better than controllability.

## Reconsidered Persistence Boundary

The host should define two different persistence levels.

### Level 1: audit persistence

This means:

- sessions can be listed after restart
- old events can be inspected
- approvals can be reconstructed

The current host already mostly has this.

### Level 2: control-state persistence

This means:

- command delivery survives restart
- pending approvals keep unambiguous state
- in-flight session operations can be resumed or safely failed
- channel bindings survive restart

The current host does not have this yet.

That distinction should be made explicit in the plan and docs.

## Recommended Redesign

### 1. Split append-only event storage from mutable control records

Recommended storage classes:

- append-only session event log
- mutable session record
- mutable approval record
- mutable wrapper command record
- mutable channel binding record

This avoids rewriting the full history file on every event.

### 2. Make wrapper commands durable records

Wrapper commands should be persisted with states such as:

- `queued`
- `leased`
- `completed`
- `failed`
- `requeued`

They should survive restart and lease expiry.

### 3. Persist approval transport state, not only approval domain state

Approval records should eventually carry fields such as:

- `callbackState`
- `callbackTransport`
- `callbackAttemptCount`
- `lastCallbackAt`
- `awaitingUpstreamAck`

That would make crash recovery less ambiguous.

### 4. Use atomic writes for mutable records

Minimum improvement:

- write temp file
- rename into place

That is enough to remove the current silent partial-write risk for single-record files.

### 5. Add a schema version

Every persisted record set should include a storage version.

This will matter once:

- event envelope changes
- channel binding state is added
- wrapper queue records become durable

### 6. Document single-host ownership explicitly

If the design remains single-process for now, the docs should say so.

That is better than leaving concurrency undefined.

## Review Conclusion

The current persistence model is acceptable for local prototype history and debugging.

It is **not** yet strong enough for durable control-plane recovery.

The biggest current gap is that the host persists:

- what happened

but not:

- what was still actively being controlled

So this item should remain open before Feishu or any other remote channel depends on the host for reliable write control.

## Suggested Next Steps

1. Introduce durable wrapper command records.
2. Split mutable control state from append-only event history.
3. Add atomic file writes and schema versioning.
4. Define restart semantics per transport explicitly.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
