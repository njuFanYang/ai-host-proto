# Documentation Re-Alignment Review

## Scope

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency

This document reviews whether the current project documentation still matches
the actual implementation and review conclusions.

The focus is:

- wording around stable vs experimental vs PoC
- wording around `sdk/thread`
- wording around `app-server`
- whether the main docs still reflect the current review set

## Files Reviewed

- `README.md`
- `docs/plan.md`
- `docs/review-checklist.md`
- review documents under `docs/*.md`
- transport metadata in:
  - `src/host/app-server-client.js`
  - `src/host/codex-cli.js`
  - `src/host/session-registry.js`

## What Is Already Better Than Before

Compared with the earlier state of the project,
the documentation is now much better aligned in several important areas.

Examples:

- wrapper-managed IDE is usually described as experimental
- `sdk/thread` is usually described as a compatibility shim
- Feishu is described as the next-stage channel adapter, not a new session type
- the plan distinguishes stronger CLI paths from weaker IDE PoC paths

So the documentation direction is mostly correct now.

## Remaining Drift

### 1. `sdk/thread` still sounds more stable than it really is

This is the most important remaining wording issue.

The code makes clear that:

- `sdk/thread` is implemented on top of `codex app-server`
- it is not a real separate SDK-backed local transport yet

Some docs already say this well.

But other wording still risks implying:

- this is already the future-proof application integration path
- this is already more stable than direct `app-server`

That is too strong.

Recommended wording:

- `sdk/thread` is a prototype compatibility transport
- current implementation reuses `app-server`
- do not treat it as proof that a real SDK transport already exists

### 2. direct `app-server` is usable, but should remain explicitly version-sensitive

Current reviews already concluded:

- the path works
- the path is useful
- the path is also hand-written against a subset of protocol behavior

So documentation should prefer language like:

- usable
- validated in prototype
- version-sensitive
- experimental rich-client / secondary control path

over language like:

- stable long-term integration layer

### 3. wrapper-managed IDE wording is mostly correct, but should stay strict

The code already labels wrapper-managed IDE as experimental in runtime metadata.

That is good.

Docs should continue to avoid drifting toward claims such as:

- stable IDE automation
- stable approval callback injection
- full IDE parity with structured CLI

That parity does not exist yet.

### 4. The checklist and the review corpus are now ahead of the README summary

The review documents now contain more precise conclusions than the top-level summary docs.

That is normal temporarily.

But it means a new reader can still get a slightly softer impression from `README.md`
than from the detailed reviews.

The README does not need to repeat everything.
It should, however, stay consistent with the strongest current conclusions.

### 5. API-layer language is not yet reflected in main docs strongly enough

The reviews now clearly distinguish:

- core control API
- internal wrapper API
- future external channel API

That layering is not yet strongly reflected in the main user-facing docs.

Once Feishu work starts, that wording should move from review docs into main architecture docs.

### 6. PowerShell rendering issues make some docs look corrupted in terminal output

There is also a practical documentation problem:

- `README.md`
- `docs/plan.md`

can render as mojibake in some PowerShell output paths.

This is not necessarily a semantic mismatch in file content.
But it is still a documentation usability problem,
because it makes review and operator reading harder in the current environment.

This should be treated as an encoding/display issue until proven otherwise.

## Reconsidered Documentation Policy

The project now needs a stricter wording policy.

### Prefer these labels

- `stable for local prototype`
- `validated`
- `experimental`
- `PoC`
- `compatibility shim`
- `version-sensitive`

### Avoid these labels unless truly justified

- `stable` without scope
- `SDK transport` for current `sdk/thread`
- `full IDE support`
- `Feishu-ready`

The key is to scope claims precisely.

## Recommended Documentation Baseline

At this stage, the project should describe itself roughly like this:

- `exec-json` is the strongest current structured CLI path
- direct `app-server` is usable but version-sensitive
- `sdk/thread` is a compatibility shim, not a real SDK-backed transport
- wrapper-managed IDE is experimental and observation-first
- Feishu is still a next-stage adapter plan, not a completed integration

That baseline matches the current review set.

## Review Conclusion

The documentation is much closer to reality than it was earlier,
but a few wording drifts still matter because they influence architectural expectations.

The biggest remaining documentation risk is:

- overstating the maturity of `sdk/thread` and direct `app-server`

So this item should remain open until the main docs are tightened to match the review corpus more exactly.

## Suggested Next Steps

1. Tighten `README.md` wording around `sdk/thread` and direct `app-server`.
2. Carry the API-layer vocabulary into the main plan docs.
3. Keep wrapper-managed IDE wording explicitly experimental.
4. Resolve or document the PowerShell encoding/display issue for main docs.

## Status

- [x] Review completed
- [ ] Redesign implemented
- [ ] Safe enough for Feishu dependency
