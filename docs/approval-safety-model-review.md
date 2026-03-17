# Approval Safety Model Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews the current approval safety model.

The focus is:

- when approvals are created
- when they are auto-resolved
- when they require human fallback
- what changes once a remote channel such as Feishu is allowed to participate

## Files Reviewed

- `src/host/approval-service.js`
- `src/host/policy-engine.js`
- `src/host/app-server-client.js`
- `src/host/codex-cli.js`
- `src/server.js`

## Current Design

### approval creation

Approvals are created from transport events.

Main current sources:

- direct app-server server requests
- wrapper-managed proxy-observed approval requests
- explicit approval creation endpoint

### policy engine

The current policy is intentionally conservative.

Rules:

- `low` => approve
- `medium` => escalate
- `high` => escalate

And even that only applies when `transportCapabilities.autoHitl === "supported"`.

### decision resolution

Approval resolution then goes through `ApprovalService.resolveApproval()`.

Current behavior:

- human decisions are allowed
- non-human decisions are rejected unless transport auto-HiTL is marked `supported`
- if a transport-specific decision handler exists, it tries to inject the result upstream
- if that injection fails, approval resolution may be rejected with fallback status

## What Works

The current model is actually strong in one important way:

- it defaults toward escalation rather than silent auto-approval

That is good for prototype safety.

It also already distinguishes:

- local policy auto-resolution
- local human resolution
- transport callback injection

So the current approval model is not reckless by default.

## Problems

### 1. Risk classification is transport-local, not globally policy-driven

Current risk comes from transport mapping logic.

Examples:

- `item/permissions/requestApproval` => high
- `item/fileChange/requestApproval` => medium
- `item/commandExecution/requestApproval` => high

This is a useful start, but it is still shallow.

It does not yet consider:

- actual command content
- actual workspace target
- controller source
- whether the request comes from local trusted interaction or remote channel action

### 2. Approval identity and controller identity are not linked strongly enough

Today approval decisions can be attributed by `decidedBy`, but there is no stronger approval actor model such as:

- local trusted operator
- local IDE operator
- remote Feishu operator
- policy engine

That becomes important once mobile or remote channel approval is introduced.

### 3. Remote approve/deny is much riskier than local approve/deny

The current model treats human approval in a fairly generic way.

That is acceptable locally.

It is not enough once a remote channel participates.

Because channel approval is different:

- it is easier to click impulsively
- it may happen on mobile
- it may happen outside the local workstation context
- it may not expose enough context about the requested action

So "human" is too broad as a safety category.

### 4. The current system does not require stronger confirmation for high-risk actions

Current flow is basically:

- pending approval
- submit decision
- transport callback if supported

There is not yet an extra safety layer such as:

- confirm high-risk approval twice
- require explicit takeover ownership
- require local-only approval for certain risk classes

### 5. Feishu callback timing encourages asynchronous workflows, not deep confirmation flows

Feishu card callbacks need a fast response and are designed around short interaction loops.

That is fine for:

- acknowledge
- deny
- request takeover

It is less ideal for:

- rich local inspection
- deep review of dangerous actions

So Feishu approval should be more conservative than local terminal approval.

## Reconsidered Safety Boundary

The correct safety boundary should not be:

```txt
policy vs human
```

It should become:

```txt
policy vs local-human vs remote-human
```

And, for some classes:

```txt
remote-human => not allowed
```

That is the key design change.

## Recommended Approval Tiers

### Tier 1: low risk

Examples:

- read-like operations
- low-risk metadata actions

Policy may auto-approve on supported transports.

### Tier 2: medium risk

Examples:

- bounded file changes
- constrained workspace writes

Allowed:

- local human approve
- remote human approve only with explicit session ownership and enough action summary

### Tier 3: high risk

Examples:

- permission elevation
- shell execution with broad effect
- dangerous workspace mutation

Allowed:

- local human approve
- remote human deny
- remote human approve should default to disallowed in v1

## Recommended Feishu v1 Safety Rule

For Feishu v1, the safest policy is:

- Feishu may observe approvals
- Feishu may deny approvals
- Feishu may approve only low-risk requests
- medium/high-risk approval should default to:
  - escalate
  - or request local confirmation

This keeps Feishu useful without making it a general remote root button.

## Recommended Model Change

Approval records should eventually include more fields such as:

- `decisionSource`
- `controllerId`
- `controllerType`
- `requiresLocalConfirmation`
- `remoteApprovalAllowed`
- `riskTier`

This does not all need to be implemented immediately.
But the boundary should be made explicit before remote channel approval is added.

## Review Conclusion

The current approval model is acceptable for local prototype scope because it already defaults toward escalation.

It is **not** yet safe enough to treat all human approvals as equivalent once Feishu is introduced.

The biggest missing concept is:

- remote-human approval must be treated as a separate and more restricted class

So this item should remain active before Feishu write/approve flows are considered complete.

## Suggested Next Steps

1. Keep current conservative policy defaults.
2. Introduce explicit approval actor categories:
   - policy
   - local human
   - remote human
3. Add remote approval restrictions before Feishu adapter work begins.
4. Make high-risk remote approve disallowed by default in v1.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
