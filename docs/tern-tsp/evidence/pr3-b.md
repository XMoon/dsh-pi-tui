# Tern TSP PR3-B evidence — interactive pane (B0..B4)

> **Status: B0 in progress on `feat/tern-tsp-pr3-b0-ports` — stage gates open.**
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

- TSP editor/input: **B1** (`tui/tsp/editor.ts`, controlled `ui.editor`).
- TSP submit/command admission: **B2**.
- TSP interactive modals (`supportsModals: true`): **B3** — the B0 inert
  presenter rejects every ask; the fail-closed admission still decides first.
- Display-seam DTO narrowing: **PR4** (recorded in `docs/tern-tsp.md`).
