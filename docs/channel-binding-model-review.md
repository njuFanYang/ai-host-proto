# Channel Binding Model Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews whether the current host already has a usable channel binding model
for a future Feishu adapter.

The focus is:

- whether a channel conversation can be bound to a host session
- whether the current code models active session selection
- whether watch mode and control mode exist yet
- what minimum binding model is needed for Feishu v1

## Files Reviewed

- `src/server.js`
- `src/host/session-registry.js`
- `src/host/codex-cli.js`
- `src/host/approval-service.js`
- `docs/plan.md`
- `docs/per-session-write-concurrency-review.md`
- `docs/public-ingress-isolation-review.md`

## External Documentation Cross-Check

The current review was also checked against current official Feishu bot documentation.

Relevant documented expectations:

- Feishu application bots can receive user messages in bot conversations and can reply into those conversations
- bots can send interactive cards and process card interactions
- the platform gives the bot a chat/message interaction surface, not a native "many backend sessions in one conversation" abstraction

That means if one Feishu conversation needs to control multiple host sessions, the multiplexing must be implemented by the host application itself.

In other words:

- Feishu gives a conversation surface
- the host must add the session selection and binding logic

## Current Design

### 1. There is no channel adapter implementation yet

Current runtime code does not include:

- Feishu adapter
- channel registry
- conversation binding store
- attach/detach endpoint family

So there is no hidden partial implementation here.

### 2. The current host model is only session-centric

Today the core records are:

- session records
- session events
- approvals

There is no first-class record for:

- channel conversation
- bound controller
- active remote terminal
- session watch subscription

So the host currently knows how to manage sessions,
but it does not know how an external chat surface attaches to those sessions.

### 3. The binding model currently exists only in planning documents

`docs/plan.md` already sketches the intended direction:

- Feishu conversation is not a new session type
- Feishu conversation binds to one `hostSessionId`
- one Feishu conversation can list multiple sessions
- one Feishu conversation has one active session at a time
- v1 should support commands such as `/sessions`, `/attach`, and `/watch`

This is the right design direction.

But it is still documentation only.

## What Works

### The current host object model leaves room for channel bindings

This is important.

Because the host already separates:

- session identity
- transport identity
- approval identity

it does not need to turn Feishu into a fake transport or fake session type.

That is good.

The clean extension point is:

- add channel binding beside the current session registry

not:

- rewrite the session model around Feishu

### The current API surface is already close to what a channel adapter would call

A future Feishu adapter could already reuse:

- `GET /sessions`
- `GET /sessions/{id}`
- `GET /sessions/{id}/events`
- `POST /sessions/{id}/messages`
- `GET /approvals`
- `POST /approvals/{requestId}/decision`

So the missing piece is not "how to send a message to a session".

The missing piece is:

- which session should this conversation be talking to right now

## Problems

### 1. There is no persisted `Conversation -> Session` binding record

This is the biggest gap.

Right now the host cannot store:

- `feishuConversationId`
- current active `hostSessionId`
- bind mode
- last selected session
- channel participant metadata

Without that, a channel adapter has nowhere to persist its routing decision.

### 2. There is no attach/detach/switch state machine

The current host does not define:

- how a conversation starts in watch mode
- how a user attaches to a session
- how a conversation switches to another session
- how takeover conflicts are handled
- how detach returns the conversation to neutral state

For local-only use, this is fine.
For Feishu, this is the core UX model.

### 3. There is no controller identity attached to channel actions

The approval and event reviews already exposed this from another angle.

Today the host does not persist strong controller fields such as:

- `controllerType`
- `controllerId`
- `channelConversationId`
- `channelUserId`

So even if a Feishu adapter were added tomorrow, the host would not be able to cleanly answer:

- who sent this prompt
- who switched this binding
- who approved this action

That makes both audit and conflict resolution weaker.

### 4. Feishu does not provide native multi-session chat multiplexing

This is an application-level problem, not a platform problem.

Inside one Feishu bot conversation, if you want the user to interact with session A or session B,
the bot must implement that selection itself.

So a design like this is necessary:

- list sessions
- choose one active session
- route plain chat messages to the active session

If that state is not explicit, the channel behavior will feel random.

### 5. Group chat and multi-user chat make the binding model stricter

A Feishu conversation may involve more than one human.

That immediately raises questions such as:

- is binding conversation-scoped or user-scoped
- can two people in the same chat switch the active session
- can one person watch while another controls
- who can answer approvals

The current code has no opinion on this yet.

That is acceptable because the feature is not implemented.
But the ambiguity should be resolved before adapter work starts.

## Reconsidered Minimal Feishu v1 Model

The safest v1 binding model is narrower than "full shared remote terminal".

Recommended baseline:

- binding is conversation-scoped
- one conversation has zero or one active `hostSessionId`
- one conversation may remember a small list of recent sessions
- conversation starts in neutral or watch state
- write requires explicit attach
- only one active writer exists per session across all controllers

This fits the earlier concurrency review.

## Recommended Binding Record

A future binding record should look roughly like:

```ts
interface ChannelBindingRecord {
  bindingId: string
  channel: "feishu"
  conversationId: string
  conversationType: "p2p" | "group"
  activeHostSessionId: string | null
  mode: "neutral" | "watch" | "control"
  pinnedSessionIds: string[]
  attachedBy?: string
  lastSwitchedAt?: string
  createdAt: string
  updatedAt: string
}
```

And, if multi-user conversation support is kept in scope, it should later add:

- `activeControllerId`
- `activeControllerType`
- `allowedApprovers`

## Recommended API Direction

Before real Feishu work begins, the host should grow a small external-channel API family such as:

- `GET /channel-bindings/{channel}/{conversationId}`
- `POST /channel-bindings/{channel}/{conversationId}/attach`
- `POST /channel-bindings/{channel}/{conversationId}/detach`
- `POST /channel-bindings/{channel}/{conversationId}/switch`
- `GET /channel-bindings/{channel}/{conversationId}/watch`

The exact path names can change.

The important point is that channel binding becomes a first-class resource,
not just adapter-local memory.

## Recommended Feishu v1 Scope Boundary

To keep v1 feasible, prefer these rules:

- support only Feishu application bot
- support only one active host session per conversation
- support session listing and explicit switching
- support watch-first behavior
- support approval actions only within the safety limits already described in the approval review

Avoid in v1:

- free-form multiplexing of many sessions in one natural-language stream
- implicit session switching based on LLM inference
- shared multi-user write control inside one group chat

## Review Conclusion

The current host does **not** yet implement a channel binding model.

That is not a hidden bug.
It is simply still unbuilt.

The good news is that the existing session-centric architecture is compatible with the planned direction:

- channel conversation as an external controller
- `hostSessionId` as the controlled target
- binding as a separate first-class record

So the design direction is viable.
But this item must remain open until:

- binding records exist
- attach/switch/detach semantics exist
- controller identity is written into channel-originated actions

## Suggested Next Steps

1. Add a first-class `ChannelBindingRegistry`.
2. Persist `FeishuConversation -> activeHostSessionId`.
3. Add attach, detach, and switch semantics before adapter work begins.
4. Keep Feishu v1 conversation-scoped and watch-first.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
