# Public Ingress vs Local Privileged Control Plane Isolation Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews whether the current host server surface is safely structured for future Feishu integration.

The focus is:

- how the current host exposes HTTP endpoints
- which endpoints are local privileged control APIs
- what changes once Feishu is introduced as a remote interaction channel
- whether public ingress is actually required for Feishu v1

## Files Reviewed

- `src/server.js`
- `src/host/codex-cli.js`
- `src/wrapper/codex-wrapper.js`
- `docs/plan.md`

## Current Design

The current host uses one HTTP server.

That single server currently serves all of the following:

- user-facing session APIs
- approval APIs
- SSE watch APIs
- wrapper registration APIs
- wrapper runtime update APIs
- wrapper command claim APIs
- wrapper completion APIs

In practice, these are mixed on one local server surface.

Examples:

- `POST /sessions/cli`
- `POST /sessions/ide`
- `POST /sessions/{id}/messages`
- `GET /sessions/{id}/events/stream`
- `POST /internal/wrappers/register`
- `GET /internal/wrappers/{id}/commands`
- `POST /internal/wrappers/{id}/commands/{commandId}/complete`

## What Works Today

For a local-only prototype, this arrangement is acceptable.

It gives the project:

- a simple single-process control plane
- easy wrapper registration
- easy local testing
- no cross-process auth design yet

For the current Windows local prototype scope, this is a valid simplification.

## Problems

### 1. Privileged wrapper APIs are not separated from future external ingress

The `/internal/wrappers/*` endpoints are high-trust control endpoints.

They allow a caller to:

- register sessions
- report runtime state
- post session events
- claim commands
- complete commands

That is a much higher privilege level than an external chat channel should ever receive.

If Feishu is introduced on the same HTTP surface without strict separation, the trust boundary becomes unclear.

### 2. The current server does not express trust zones

Right now the design does not clearly distinguish:

- local trusted caller
- external untrusted caller
- future channel adapter

This is not only an auth issue.
It is also a routing and deployment issue.

Today the code structure encourages one server doing everything.
That is fine for local wrapper traffic, but it is the wrong default for external channel ingress.

### 3. If future webhook ingress is added directly, the blast radius is too large

If the same server later receives public callback traffic, the following risks appear immediately:

- internal wrapper control endpoints become co-located with public endpoints
- accidental exposure becomes easier
- request validation rules become mixed
- observability becomes less clear

Even if authentication were added later, the deployment boundary would still be weak.

### 4. The implementation currently assumes loopback deployment

The current server binds to `127.0.0.1` by default.
That is good for the local prototype.

But once Feishu is introduced, the deployment question becomes architectural:

- keep local-only host
- add a separate Feishu adapter process
- or expose the same host publicly

The third option is the weakest one and should not become the default path.

## Reconsidered Feishu Feasibility

The important review result is:

**Feishu v1 does not necessarily require a public webhook ingress on the same host process.**

There are two viable Feishu directions.

### Option A: Preferred for v1

Use Feishu server SDK long connection / persistent connection mode in a dedicated channel adapter.

That gives:

- no need to expose the host itself publicly
- no need to put wrapper control endpoints on a public surface
- simpler local development
- clearer trust separation

### Option B: Fallback

Use traditional webhook ingress.

If this is used, then the Feishu-facing ingress must be split from local privileged wrapper APIs.

That split can be:

- a separate process
- a separate listener
- or a strictly different deployment boundary

## Why Option A Changes the Plan

Without looking at the official Feishu docs, it is easy to assume:

```txt
Feishu integration => must expose public webhook => same host must become public
```

After reviewing the docs, that assumption is too strong.

A better conclusion is:

```txt
Feishu integration => can use dedicated channel adapter over long connection
```

That means the host can stay local and privileged, while a Feishu adapter handles external integration concerns.

## Recommended Architecture Direction

The next-stage design should use three logical layers:

```txt
Feishu Adapter
    |
    v
Host External Channel API
    |
    v
Host Core Control Plane
    |
    v
Local Wrapper / CLI / IDE Sessions
```

And separately:

```txt
Local Wrapper / CLI
    |
    v
Host Internal Control API
```

The key idea is:

- Feishu should never talk directly to wrapper-only control endpoints
- wrapper should never depend on Feishu ingress behavior

## Minimum Redesign Requirement

Before Feishu work starts, the implementation should at least distinguish:

- `internal control API`
  - wrapper registration
  - wrapper runtime reporting
  - wrapper command claim
  - wrapper command completion

- `external channel API`
  - session listing for channels
  - channel attach / detach
  - channel send message
  - approval action from channel
  - watch summary for channel

This distinction should exist even if both APIs still temporarily run inside one codebase.

## Additional Feishu Constraints That Affect This Review

Feishu long connection mode is attractive, but it also has constraints:

- it is only supported for enterprise self-built apps
- the runtime still needs outbound public network access
- callback processing still has a short response budget
- delivery is cluster-style rather than broadcast if multiple clients are connected

These do not invalidate the approach.
They just mean the Feishu adapter should be designed as a dedicated component.

## Review Conclusion

The current implementation is acceptable for a local-only prototype.

It is **not** a safe final shape for Feishu integration if everything remains on one undifferentiated server surface.

However, after checking official Feishu callback and long-connection documentation, the implementation path should be reconsidered in an important way:

- Feishu v1 should prefer a dedicated adapter using SDK long connection
- the host should remain a privileged local control plane
- webhook-style public ingress should be treated as a fallback path, not the default

So the issue is real, but the solution is not simply "publish the current host securely".

The better solution is:

- separate trust zones
- separate API surfaces
- prefer a dedicated Feishu adapter process

## Recommended Next Steps

1. Keep `src/server.js` local-first for now.
2. Define explicit internal vs external API groups.
3. Add a dedicated Feishu adapter design instead of making the host itself public by default.
4. Only if webhook fallback is required, design a separate public ingress boundary.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
