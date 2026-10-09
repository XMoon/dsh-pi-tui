# Tern TSP PR3-B evidence — interactive pane (B0..B4)

> **Status: B0 implemented and review-accepted on
> `feat/tern-tsp-pr3-b0-ports` @ 33a5b7e8 — awaiting PR/merge; B1..B4 gates
> open.**
> This file accumulates per-PR evidence for PR3-B exactly as
> [pr3-a.md](./pr3-a.md) did for PR3-A. Each PR section records its base SHA,
> the behavioral contract anchors, the authority/lifetime changes, the actual
> commands and outcomes, and the review acceptance state. Nothing here
> authorizes a merge by itself.
>
> **Plan:** `temp/tern/dsh-pi-tui-tern-tsp-pr3-b-implementation-plan-v2-20261009.md`
> (authoritative for PR3-B tactics). **Overall:**
> `temp/tern/dsh-pi-tui-tern-tsp-overall-roadmap-v1-20261008.md`.

## B0 — `refactor(tern-tsp): isolate composer and interaction presenters`

- **Base**: `next @ f910c2680e117a829088b11e43718e9216164607` (verified at
  branch creation; no drift from the plan's frozen value).
- **Scope**: ports only — no product-visible TSP input, no behavior change on
  the PiTui path.

### What changed (source anchors)

| Zone | Change |
|---|---|
| `src/app/submission/composer-port.ts` (new) | The seven-method `SubmissionComposerPort` (`getDraft`/`setDraft`/`setEditorText`/`insertIntoEditor`/`notify`/`setSubmitPending`/`clearSettledLocalMessages`), `setSubmitPending` typed by the existing `SubmitPendingDetail` from `app/submission/ack.ts` (no `unknown` escape). |
| `src/app/submission/controller.ts` | `SubmissionControllerDeps.app: () => SubmissionComposerPort` — a TYPE-only narrowing. Every business branch, the `runOwned` tasks, `mergeDraft` ordering, the session-scoped writer and `ComposerSubmitRequest` are untouched. No `TuiApp` import remains (guard test). |
| `src/app/surface/interaction-presenter.ts` (new) | `SurfaceInteractionPresenter` (`showApprovalPrompt`/`askQuestions`/`setSettledQuestionAnswersLookup`/`notify`) with the exact existing shared types re-exported from the stable `tui-app.ts` facade (`TuiQuestion*`, `ApprovalPromptRequest`, `ApprovalOutcome`) — no new DTOs, no `tui/**` import (the architecture gate admits only the facade). |
| `src/app/surface/interaction-runtime.ts` | Reads `presenter()`/`livePresenter()` instead of `mounted()`/`liveApp()`. The `supportsModals === false` fail-closed admission, the ONE `QuestionSurfaceController`, the settled-answer lookup and the disposal order are byte-identical in behavior. |
| `src/app/surface/runtime.ts` | `SurfaceRendererMount.mount()` now returns `{ display, composer, interaction, dispose }`; the PiTui branch assigns the ONE live `TuiApp` to both projections (structural compatibility, no wrapper); `SurfaceRuntime.composer` is the renderer-neutral read. |
| `src/tui/tsp/session.ts` | `TspRenderer` gains the B0 INERT `composer` (every member throws — no silent no-op against a renderer without an editor; `notify` maps to the dock) and INERT `interaction` (every ask rejects with the flow's cancellation error — fail-closed, matching `supportsModals: false`). No SDK feature, no input change: the read-only key loop is untouched. |
| `src/app/bootstrap.ts` | `createSubmissionController` injects `() => surface.composer`; `createUserShell` gains the renderer-neutral `notify` injection (`surface.display.notify`) for its failure/interrupt notices. |
| `src/app/bootstrap/renderer-selection.ts` | The mount carries the two new projections through. |
| `src/app/submission/user-shell.ts` | Interrupt/failure notices route through the injected `notify`; the local-card members (`pushLocalMessage`/`updateLocalMessage`/`clearSettledLocalMessages`) stay on `app()` and remain reachable only inside a real PiTui shell `run()`. |
| `docs/tern-tsp.md` | The display-seam PiTui-shaped DTO debt gets its **PR4 closure owner** recorded; PR3-B adds the no-new-TuiApp-import rule for `app/submission/**`. |

### Authority and lifetime changes

None. The submission writer/admission owner, the question/approval lifecycle
owner, the exit/fatal taxonomy and the renderer release contract are unchanged.
The two new ports are pure type-level seams; the PiTui branch is behaviorally
identical (the app instance IS both ports).

### Verification (worktree `feat/tern-tsp-pr3-b0-ports`, node v24.20.0, pnpm 11.7.0)

| Command | Result |
|---|---|
| `node --test test/tern-tsp-pr3b-ports.test.ts` (new guards) | 5/5 pass — controller imports no `TuiApp`; UserShell notices are neutral; `TuiApp` structurally satisfies both ports; all seven composer members live on a real PiTui app; the interrupt failure surfaces through the neutral notify with zero local-card calls |
| `node --test test/tern-tsp-live-mount.test.ts` | 17/17 pass (renderer mount contract incl. the new mount members) |
| `node --test test/tern-tsp-renderer-selection.test.ts` | 19/19 pass |
| `node --test test/terminal-progress-lifecycle.test.ts` | 80/80 pass (production interaction-runtime over the presenter seam) |
| `node --test test/question-park-reopen.test.ts test/question-remote-lifecycle.test.ts` | 29/29 pass |
| `node --test test/interaction-port.test.ts test/question-flow.test.ts` | 99/99 pass |
| `pnpm typecheck:bundle` | pass |
| `pnpm gate:architecture` | pass (451 files, dependency direction clean) |
| `pnpm gate:boundary` | pass (31 files, no new Host coupling) |
| `pnpm test:product` | 7478/7478 pass |
| `pnpm verify:prepush` | pass (exit 0 — full pipeline: typecheck:fork/bench, test:fork, test:docs, test:tooling, architecture/boundary/keybinding/naming/session-event/installation-doc/pi-divergence/pi-vendor gates, audit, pack:release incl. its pre/postpack smokes) |

### PiTui no-regression statement

`pnpm test:product` green on this tree covers the full PiTui application
matrix (submission, questions/approvals, renderer selection, teardown). The
only PiTui-visible difference is the injection indirection
(`surface.composer` → the same `TuiApp`), which the guard tests pin
structurally.

### Remaining exclusions (tracked owners)

- `SurfaceRendererMount.bindInput` (plan §3.3): **DEFERRED_WITH_OWNER: B1.**
  The external review ruled B0 must not add an empty `bindInput` to satisfy
  the interface shape — B0's stage gate requires TSP to stay read-only, and
  the real input binding (single bind, handshake-window early keys, teardown
  discard) belongs to B1's SDK key/editor wiring.
- Question-attention chrome coupling (`SurfaceRuntime` feeds
  `InteractionRuntime.setQuestionAttention` through the PiTui
  `mounted().setQuestionAttention`): **DEFERRED_WITH_OWNER: B3.** Unreachable
  while `supportsModals === false` (the controller that publishes attention is
  never attached on TSP); once B3 enables it, the attention presentation must
  become renderer-neutral in the same slice — not an empty B0 interface
  without a consumer.
- TSP editor/input: **B1** (`tui/tsp/editor.ts`, controlled `ui.editor`).
- TSP submit/command admission: **B2**.
- TSP interactive modals (`supportsModals: true`): **B3** — the B0 inert
  presenter rejects every ask; the fail-closed admission still decides first.
- Display-seam DTO narrowing: **PR4** (recorded in `docs/tern-tsp.md`).

### Review

- **External review** (on `33a5b7e8`): 2 P3 findings + 2 boundary rulings —
  P3-1 the inert `clearSettledLocalMessages` mapped to the WRONG state
  (`display.setDockNotice(undefined)` clears the transient dock-notice stream,
  not the settled-local-card set; fixed to fail-fast like every other inert
  member); P3-2 the interrupt test waited a fixed 20 ms (fixed to a
  notify-resolved promise with a 2 s timeout); rulings recorded above
  (`bindInput` → B1, attention chrome → B3).
- **Round 1** (durable reviewer, read-only, snapshot `33a5b7e8`, tree clean at
  start/end): **accepted** — zero P0/P1/P2. Coverage: all 14 files, every hunk;
  B0 zones 1-8 verified with code anchors; merge-gate items verified against
  the supplied same-state evidence; the shared-seme analysis confirmed the
  ports are pure projections (no new session/queue/writer/classifier
  authority). "accepted ≠ merge authorization; B1-B4 and the PR4 display DTO
  debt remain with their owners."
- **Round 2** (delta `86bd3bce`, docs-only ledger commit): **accepted**, zero
  findings. Noted `pnpm test:docs` covers only `docs/tmux/*.test.mjs`; this
  ledger's accuracy is proven by the human diff check, not that lane.
- **Round 3** (delta `1ddf12e2`, the two external-review fixes): **accepted**,
  zero findings. Confirmed the fail-fast semantics against the authoritative
  `TuiApp.clearSettledLocalMessages` contract and every production caller;
  confirmed B0 has no reachable path into the new throw (the TSP SDK loop
  still only routes `requestExit`); confirmed the promise-race guard has no
  unhandled-rejection path. Two non-blocking notes recorded as-is: the race's
  losing timer is not cleared (a passed test lingers ~2 s before file exit)
  and the guard now proves the first notice's content + zero card calls
  (not a strict exactly-once count). B1 must implement the member against the
  real composer state — the inert throw must not be inherited.
