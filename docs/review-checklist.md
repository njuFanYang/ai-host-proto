# Host Review Checklist

## Purpose

This document records the current review checklist for the local Codex host implementation.
It is the written baseline for the next round of detailed source review and redesign decisions.

The goal is not to declare the current implementation invalid.
The goal is to identify the parts that must be tightened before the host is extended into a longer-lived control plane and before Feishu is added as a remote interaction channel.

## Current Assessment

The current implementation direction is still viable.

The CLI-first managed host model is sound.
The current direct `exec-json` and direct `app-server` paths are the strongest parts of the system.
The wrapper-managed IDE path is still experimental and must continue to be treated as such.

The main concern is not "whether the architecture is wrong".
The main concern is "which parts must be reinforced before more external surfaces are added".

## Priority Levels

### P0

These items should be reviewed and tightened before Feishu channel work begins.

- [x] Wrapper command queue reliability
  - Current `claim -> inFlight -> complete` flow is not yet a durable delivery model.
  - Need lease, timeout, requeue, retry count, and restart behavior.
  - Relevant code:
    - `src/host/codex-cli.js`
    - `src/wrapper/codex-wrapper.js`

- [x] Public ingress vs local privileged control plane isolation
  - Current host exposes wrapper control endpoints on the same server surface.
  - Feishu webhook ingress should not share the same trust boundary as local wrapper control.
  - Need explicit split between:
    - local/internal wrapper APIs
    - external/public channel APIs
  - Relevant code:
    - `src/server.js`

- [x] Per-session write concurrency model
  - Current app-server transport assumes a single active writer at a time.
  - Future CLI + IDE + Feishu concurrent writes will require a host-level input queue or active controller model.
  - Relevant code:
    - `src/host/app-server-client.js`
    - `src/host/codex-cli.js`

### P1

These items are not immediate blockers for all work, but they affect long-term correctness and maintainability.

- [x] app-server protocol drift risk
  - The current implementation consumes a hand-written subset of app-server JSON-RPC.
  - Need a decision:
    - continue as a guarded experimental path
    - or migrate toward the official SDK route
  - Relevant code:
    - `src/host/app-server-client.js`
    - `src/wrapper/codex-wrapper.js`

- [x] `sdk/thread` naming and capability boundary
  - Current `sdk/thread` is a compatibility shim over `app-server`.
  - This must not be misread as a stable dedicated SDK integration.
  - Need either:
    - rename for clarity
    - or replace with real SDK-backed implementation
  - Relevant code:
    - `src/host/app-server-client.js`
    - `docs/plan.md`

- [x] Approval safety model
  - Current approval flow works, but risk policy should be reviewed before mobile/channel approval is added.
  - Need clearer separation between:
    - policy auto-approval
    - local human approval
    - future channel-based approval
  - Relevant code:
    - `src/host/approval-service.js`
    - `src/host/policy-engine.js`

### P2

These items matter for production-like behavior and future channel integration quality.

- [x] Event mapping completeness and deduplication
  - Need clearer normalization strategy for output, tool, approval, and raw protocol events.
  - Need channel-side deduplication strategy before Feishu ingestion is added.

- [x] Persistence hardening
  - Need persistence and recovery review for:
    - wrapper command queue
    - future channel binding state
    - in-flight approvals

- [x] Channel binding model
  - Need explicit model for:
    - `FeishuConversation -> active hostSessionId`
    - switching active session
    - watch mode vs control mode

### P3

These items are lower priority but should remain visible.

- [x] API surface layering
  - Distinguish:
    - external API
    - internal wrapper API
    - future channel adapter API

- [x] Observability and audit trail
  - Need better tracking for:
    - command lifecycle
    - controller source
    - approval source
    - channel action history

- [x] Documentation re-alignment
  - Continue tightening wording around:
    - stable
    - experimental
    - PoC

## Review Method

Each checklist item should be reviewed in this order:

1. Read the current source implementation line by line.
2. Compare assumptions against official documentation where applicable.
3. Identify concrete failure modes, not just abstract concerns.
4. Decide whether the issue is:
   - acceptable for prototype scope
   - a required redesign
   - or a documentation-only correction
5. Record outcome before implementation changes are made.

## Per-Item Document Template

Each detailed review document should include a status section with checkboxes:

- [ ] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

When a review is finished, the first box should be checked.
When the corresponding redesign is implemented, the second box should be checked.
Only when the item is judged good enough for Feishu channel dependency should the third box be checked.

## Immediate Next Review Order

The next detailed source review should proceed in this order:

1. Wrapper command queue reliability
2. Public ingress vs local privileged control plane isolation
3. Per-session write concurrency model
4. app-server protocol drift and SDK migration boundary
5. Approval safety model

## Feishu Note

Feishu remains the preferred first channel target.

That does not change the current review order.

The host should not add Feishu as a remote terminal until:

- wrapper command delivery is made more reliable
- public ingress is isolated from local privileged control APIs
- the host has an explicit multi-controller write strategy
