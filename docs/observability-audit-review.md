# Observability And Audit Trail Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews what the host currently records for observability and audit,
and what is still missing before remote control surfaces are added.

The focus is:

- session lifecycle visibility
- approval visibility
- wrapper command visibility
- controller attribution
- audit usefulness after the fact

## Files Reviewed

- `src/host/session-registry.js`
- `src/host/approval-service.js`
- `src/host/codex-cli.js`
- `src/host/app-server-client.js`
- `src/server.js`
- related tests under `test/`

## Current Design

The host already has one central audit mechanism:

- append structured session events

Those events are:

- persisted under `.host-data/sessions/*.json`
- emitted live through the registry event stream
- exposed over HTTP and SSE

The current system therefore already provides real observability for:

- session creation and updates
- output events
- approval creation and resolution
- wrapper command queue events
- transport debug fallbacks such as `raw_event`, `raw_stdout`, and `stderr`

## What Works

### 1. There is already a unified event timeline per session

This is the strongest part of the current observability model.

A user can inspect:

- session record
- ordered event history
- current approvals

without scraping logs from multiple places.

### 2. Approval decisions already preserve basic human vs policy attribution

Current approval result events include:

- `decision`
- `decidedBy`
- `reason`

That is a useful audit baseline.

### 3. Wrapper command lifecycle is at least partially visible

Current wrapper-managed flows append events such as:

- `wrapper_command_queued`
- `wrapper_command_completed`
- `wrapper_command_failed`

So wrapper control is not invisible.

### 4. SSE streams are good enough for live local supervision

Current endpoints:

- `GET /sessions/{id}/events/stream`
- `GET /approvals/stream`

make the host observable in real time for local tools.

For prototype scope, this is practical.

## Problems

### 1. Controller identity is still too weak

This is the single biggest audit gap.

Today most events do not reliably say:

- who triggered them
- through which control surface
- from which channel or local client

Examples of missing fields:

- `controllerType`
- `controllerId`
- `channelConversationId`
- `channelUserId`
- request correlation id

This becomes critical once one session may be touched by:

- local CLI
- local IDE
- future Feishu conversation

### 2. Event records are useful, but not audit-normalized

Current events are transport-facing first.

That means the event stream contains a mix of:

- canonical session events
- transport observations
- wrapper command lifecycle
- raw protocol noise

This is good for debugging.
It is less good for audit reporting.

A later auditor will want to answer questions like:

- who asked the model to do this
- who approved this risky action
- what exact output was shown remotely

The current event stream can help,
but it is not yet shaped around those questions.

### 3. Message injection origin is not strongly recorded

The system already appends `user_input` events.

But those events do not always carry a durable origin model such as:

- local user
- wrapper-managed replay
- future channel adapter
- policy-generated action

Some payloads include hints like `resumed: true` or `transport: "wrapper-managed"`,
but this is not a complete or uniform attribution model.

### 4. Approval audit still lacks actor class and callback state

`decidedBy` is helpful.

But it is still too coarse for future use.

It does not distinguish clearly between:

- local human
- remote human
- policy engine
- wrapper-observed client response

It also does not persist a richer callback lifecycle such as:

- decision accepted locally
- callback queued upstream
- callback acknowledged upstream
- callback failed

Some of this exists as separate events like `approval_result_upstream`,
but not as a normalized audit record.

### 5. There is no request-level access log or actor log

The server currently handles HTTP requests,
but it does not produce a structured access/audit log per request.

So the host cannot currently answer:

- which client called `/sessions/{id}/messages`
- when exactly the decision endpoint was hit
- whether a wrapper or external adapter called a route

For local-only use, this is acceptable.
For remote-control expansion, it is not enough.

### 6. There are no stable correlation keys across related events

This overlaps with the event-model review.

Without stable upstream or request correlation ids,
audit reconstruction is weaker than it should be.

Examples:

- message send request -> transport write -> turn started -> turn completed
- approval request -> decision -> upstream callback -> observed result

Today those relationships are inferred from time and payload shape,
not explicitly linked.

### 7. Summary-level observability is missing

The host is event-rich but summary-poor.

There is no built-in aggregated view such as:

- recent active sessions
- approvals by status
- wrapper command backlog
- controller ownership summary
- per-session last human action

That is not a correctness bug,
but it matters once a remote operator wants to supervise many sessions.

## Reconsidered Audit Boundary

The host should distinguish between:

- debug observability
- operator observability
- compliance-style audit trail

Current implementation is strongest in debug observability.

It is weaker in operator summary and audit attribution.

That is normal for a prototype.
It should just be stated clearly.

## Recommended Redesign

### 1. Add controller attribution fields to all write-affecting events

Minimum fields:

- `controllerType`
- `controllerId`
- `origin`
- `requestId`

### 2. Add normalized command and approval audit records

Not everything needs to be inferred from free-form event streams.

Recommended mutable audit objects:

- command record
- approval record
- channel binding record

with lifecycle timestamps.

### 3. Keep raw/debug events, but classify them

Each event should eventually be classed as:

- `renderable`
- `audit`
- `debug`

That will help both UI and channel adapters.

### 4. Add a structured access log for HTTP actions

Especially once external adapters are added,
the host should record:

- route
- caller type
- status code
- target session or approval id
- request correlation id

### 5. Add a session summary view

A future remote operator should not need to replay raw events just to answer:

- what is active
- what is waiting approval
- what changed recently

## Review Conclusion

The current host already has meaningful observability for local development and debugging.

It is **not** yet a strong audit trail for multi-controller or remote-channel operation.

The main missing concept is:

- durable actor attribution across all control actions

So this item should remain open before Feishu or any other remote control surface is considered safe enough to depend on the host.

## Suggested Next Steps

1. Add controller attribution fields to message, approval, and command events.
2. Add request correlation ids.
3. Introduce summary views beside raw event streams.
4. Add structured access logging before remote channel work begins.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
