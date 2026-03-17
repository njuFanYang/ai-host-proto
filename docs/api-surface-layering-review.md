# API Surface Layering Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews whether the current host API surface is cleanly layered enough
for the next stage of growth.

The focus is:

- session control APIs
- approval APIs
- wrapper-only APIs
- future channel-facing APIs

## Files Reviewed

- `src/server.js`
- `src/host/codex-cli.js`
- `src/host/approval-service.js`
- `docs/plan.md`
- `docs/public-ingress-isolation-review.md`
- `docs/channel-binding-model-review.md`

## Current Design

Today all host HTTP behavior lives inside one server file: `src/server.js`.

The current routes fall into three rough groups.

### 1. Core session APIs

- `GET /health`
- `GET /sessions`
- `GET /sessions/{id}`
- `GET /sessions/{id}/events`
- `GET /sessions/{id}/events/stream`
- `POST /sessions/cli`
- `POST /sessions/ide`
- `POST /sessions/{id}/messages`

### 2. Approval APIs

- `GET /approvals`
- `GET /approvals/{id}`
- `GET /approvals/stream`
- `GET /sessions/{id}/approvals`
- `POST /sessions/{id}/approvals`
- `POST /approvals/{id}/decision`

### 3. Wrapper control APIs

- `POST /internal/wrappers/register`
- `POST /internal/wrappers/{id}/runtime`
- `GET /internal/wrappers/{id}/commands`
- `POST /internal/wrappers/{id}/commands/{commandId}/complete`
- `POST /internal/wrappers/{id}/events`
- `POST /internal/wrappers/{id}/complete`

So there is already a naming distinction.

But the distinction is still mostly path-based, not architectural.

## What Works

### The current route family is readable

Even though the whole server is one file, the existing route groups are understandable.

In particular:

- session actions are mostly under `/sessions`
- approvals are mostly under `/approvals`
- wrapper internals are mostly under `/internal/wrappers`

That is a decent starting point.

### Wrapper internals already use a separate namespace

This is important.

If wrapper endpoints had been mixed directly into `/sessions`, cleanup would be harder.

So the current code already has the seed of the correct layering.

## Problems

### 1. The API layers are not first-class concepts yet

Right now the code does not express clear API modules such as:

- core control plane API
- internal wrapper API
- external channel API

Instead, all routing, validation, and trust assumptions are embedded together in one request handler.

That makes the code easy to start with,
but harder to evolve safely.

### 2. The current public-looking API and internal API share the same implementation boundary

Even though wrapper routes live under `/internal/wrappers`,
they are still handled by the same server, the same router logic, and the same error model as user-facing routes.

So the layering is nominal, not enforced.

That matters once:

- a Feishu adapter appears
- auth rules differ by caller type
- rate limits differ by caller type
- observability differs by caller type

### 3. Channel-facing APIs do not exist yet

The next stage of the design clearly needs APIs for:

- binding a conversation to a session
- switching the active session
- sending a channel-originated message
- fetching channel-safe watch summaries

If those are added directly into the current mixed router without a new layer,
the surface will become harder to reason about.

### 4. The current session APIs mix host orchestration with client convenience

Examples:

- `POST /sessions/cli` both creates a host session and launches a concrete transport
- `POST /sessions/ide` both creates a host record and returns wrapper launch metadata
- `GET /sessions/{id}` performs refresh behavior before returning state

This is fine for the local prototype.

But it means the API is currently more "orchestration endpoint" than "stable resource model".

That is acceptable now.
It should just be named honestly.

### 5. SSE watch behavior is useful, but not yet channel-shaped

`/sessions/{id}/events/stream` and `/approvals/stream` are good for local watchers.

But a future channel adapter will probably need:

- filtered summaries
- renderable-only event projections
- controller-aware updates

So the current stream API is a low-level watch feed, not yet the final external adapter feed.

## Reconsidered Layering Model

The host should eventually expose three logical API layers.

### Layer 1: Core control API

Used by:

- local CLI tools
- local dashboards
- operator tooling

Examples:

- session list and detail
- session message injection
- approval resolution
- audit/event access

### Layer 2: Internal wrapper API

Used only by:

- `codex-wrapper`
- trusted local helper processes

Examples:

- wrapper registration
- runtime reporting
- wrapper command claim
- wrapper command completion
- wrapper event relay

### Layer 3: External channel API

Used by:

- Feishu adapter
- future remote channel adapters

Examples:

- channel binding
- attach/detach/switch
- watch summary
- channel-originated send
- channel approval actions

This third layer should not simply reuse all low-level wrapper or raw event APIs.

## Recommended Direction

### 1. Keep the current paths, but document them as layers

Short-term improvement:

- explicitly classify existing endpoints by API layer
- stop describing all routes as equally public application APIs

### 2. Split router code by responsibility

Recommended future files:

- `src/server/core-routes.js`
- `src/server/internal-wrapper-routes.js`
- `src/server/external-channel-routes.js`

The exact filenames do not matter.

The point is to make API boundaries visible in code, not only in route names.

### 3. Add a channel-safe projection layer

Before Feishu work begins, the host should define what a channel adapter is actually allowed to see.

That likely means:

- not raw wrapper events
- not full low-level transport noise
- but filtered renderable session summaries and approvals

### 4. Keep `/internal/*` genuinely internal

That should become a code-level rule, not just a naming habit.

## Review Conclusion

The current API surface is acceptable for a local prototype.

It already contains the beginnings of route separation,
especially for wrapper internals.

But the layering is still informal.

So this item remains open until:

- the API groups are explicit in code
- channel-facing APIs are added as a separate family
- wrapper APIs are treated as a genuinely distinct trust layer

## Suggested Next Steps

1. Classify current routes into core, internal, and future external groups.
2. Split `src/server.js` into route modules before channel APIs are added.
3. Add a channel-safe projection layer instead of exposing raw event APIs directly.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
