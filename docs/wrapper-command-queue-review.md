# Wrapper Command Queue Review

## Scope

- [x] Review completed
- [x] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews the current wrapper-managed command queue implementation.

Implementation note: the original in-memory queue described below has now been replaced in code by persisted wrapper command records with leases, requeue on expiry, and duplicate-safe completion via leaseToken.

The focus is narrow:

- how Host queues commands for wrapper-managed IDE sessions
- how wrapper claims and executes those commands
- whether the delivery model is reliable enough for future channel-based interaction

This is not yet a redesign document for the whole host.

## Files Reviewed

- `src/host/codex-cli.js`
- `src/wrapper/codex-wrapper.js`
- `src/server.js`
- `test/codex-cli.test.js`
- `test/server.test.js`

## Current Design

### Host-side flow

Host keeps an in-memory map:

```txt
wrapperCommands: Map<hostSessionId, { pending: [], inFlight: Map }>
```

The current flow is:

1. `enqueueWrapperCommand()`
   - append command to `pending`
   - append `wrapper_command_queued` event

2. `claimWrapperCommands()`
   - remove all commands from `pending`
   - mark them `dispatched`
   - move them into `inFlight`

3. `completeWrapperCommand()`
   - remove command from `inFlight`
   - mark it `completed` or `failed`
   - append completion event

### Wrapper-side flow

When wrapper runs in `app-server` proxy mode:

1. it polls `GET /internal/wrappers/{id}/commands`
2. it executes each command
3. it posts completion to:
   - `POST /internal/wrappers/{id}/commands/{commandId}/complete`

Supported commands today:

- `start_turn`
- `approval_response`

## What Works

The current implementation proves that the control path is viable.

It already supports:

- Host queuing a wrapper-managed message injection request
- wrapper polling and reading commands
- wrapper writing the translated JSON-RPC request upstream
- Host receiving command completion callback
- wrapper-managed approval callback path

For prototype validation, this is enough to demonstrate that:

```txt
Host -> wrapper -> codex app-server
```

can be used as a controllable path.

## Problems

### 1. Claim is destructive

`claimWrapperCommands()` drains `pending` immediately.

That means:

- after claim, Host no longer has a queued copy
- reliability now depends on wrapper reaching completion callback

If wrapper crashes after claim but before execution, the command is lost.

### 2. Only some in-flight commands are failure-reported on wrapper exit

Wrapper only reports failure for commands tracked inside `hostInjectedRequests`.

That covers a narrower case:

- command already translated into an upstream app-server request
- wrapper is waiting for upstream response

It does **not** cover all claimed commands.

So there is a gap between:

- Host says command was dispatched
- wrapper has not yet turned it into an upstream request

Commands in that gap can disappear silently.

### 3. No lease / timeout / retry model

Current command state does not include:

- `claimedAt`
- `leaseExpiresAt`
- `retryCount`
- `maxRetries`
- `lastError`

So Host cannot answer:

- is wrapper stuck?
- should this command be retried?
- should this command be considered permanently failed?

### 4. No persistence

Session state, events, and approvals are persisted.

Wrapper command queue is not.

So if Host restarts:

- pending wrapper commands disappear
- leased / in-flight wrapper work disappears
- recovery behavior is undefined

This is inconsistent with the rest of the host design.

### 5. No duplicate-handling strategy

The current queue model assumes:

- wrapper claims once
- wrapper executes once
- wrapper completes once

There is no explicit idempotency model for:

- duplicate complete calls
- duplicate command claims after reconnect
- retry after uncertain wrapper failure

This becomes important once command retry is introduced.

### 6. Tests cover happy path only

Current tests validate:

- queueing works
- HTTP claim works
- completion works

Current tests do not validate:

- claim then wrapper crash
- command lease timeout
- Host restart during pending work
- duplicate completion
- command requeue
- repeated execution protection

## Why This Matters

Today this is still acceptable as an internal PoC.

It is **not** acceptable as the foundation for a future remote terminal channel.

Once Feishu is added, Host will need asynchronous command delivery.
At that point, a user action may become:

```txt
Feishu click -> Host command queued -> wrapper executes later
```

If command delivery is lossy, the user-visible behavior becomes:

- message was accepted
- no actual session action happened
- no reliable retry happened

That will be experienced as silent failure.

## Review Conclusion

The current implementation is:

- good enough to prove architecture viability
- not reliable enough to be considered a durable control plane primitive

This item should remain `P0`.

## Recommended Redesign

### Minimum acceptable model

Replace the current queue state with a command record model:

```txt
queued -> leased -> completed
queued -> leased -> failed
queued -> leased -> queued (requeue)
```

Each command should include:

- `commandId`
- `hostSessionId`
- `kind`
- `payload`
- `status`
- `createdAt`
- `claimedAt?`
- `leaseExpiresAt?`
- `retryCount`
- `lastError?`
- `completedAt?`

### Required behavior

- claim should issue a lease, not permanently consume the command
- expired leases should be requeued automatically
- retry count should be bounded
- final permanent failure should emit an explicit event
- queue state should be persisted with session data or adjacent host state

### Suggested new events

- `wrapper_command_leased`
- `wrapper_command_requeued`
- `wrapper_command_completed`
- `wrapper_command_failed`
- `wrapper_command_abandoned`

## Suggested Next Tests

Add tests for:

1. command claimed, wrapper exits before execution, command requeues
2. command claimed, no completion before lease expiry, command requeues
3. command exceeds retry limit, command becomes failed
4. duplicate completion callback is handled safely
5. Host restart preserves queued commands

## Status

- [x] Review completed
- [x] Redesign implemented
- [ ] Safe enough for Feishu channel dependency


