# Tern TSP PR3-B evidence — interactive pane (B0..B4)

> **Status: B0 merged; B1 implemented on `feat/tern-tsp-pr3-b1-editor` —
> review gates open. B2..B4 pending.**

## B1 — `feat(tern-tsp): controlled composer and SDK key input`

- **Base**: the merged B0 tip of `next` (the frozen-plan baseline).
- **Scope**: the TSP renderer becomes composer-active — controlled
  `ui.editor`, SDK key/paste through the ONE input loop, grapheme-safe
  editing, the B1 submit refusal. NO backend submission (B2), no modals (B3).

### What changed (source anchors)

| Zone | Change |
|---|---|
| `src/tui/tsp/editor.ts` (new) | The ONE program-owned composer: state `{ text, cursor, focused }` (UTF-16 cursor KEPT AT A GRAPHEME-CLUSTER BOUNDARY — the F1 invariant: every numeric clamp normalizes forward to the containing cluster's end, every insertion normalizes after any merge with a following combining/ZWJ cluster, and both deletion endpoints are cluster-aligned), the port members (each mutator commits ONE frame through the `onChanged` sink — the F2 invariant), and `applyKey` — the fixed §3.4 editor-local reducer. Grapheme movement/deletion via `Intl.Segmenter` (never splits surrogate pairs/ZWJ clusters — verified: `👨‍👩‍👧` = 8 UTF-16 units, ONE cluster, consumed whole). Enter/Ctrl+Enter classify as submit GESTURES without mutating the draft; Shift+Enter inserts `\n`; paste is ONE atomic edit (SDK preserves `\r` bytes verbatim); Ctrl+D exits only on an empty draft; unknown control keys are ignored. `clearSettledLocalMessages` is a deliberate no-op (the B0 external-review P3-1 ruling: dock notices are a DIFFERENT state; the real settled-card surface arrives later). |
| `src/tui/tsp/session.ts` | The dock renders the controlled editor (`key:'composer'`, `maxLines:8`, placeholder, prompt) and focuses `dock.composer` exactly once, AFTER the first committed frame (probe: the SDK emits `["focus","dock.composer"]` as its own frame; a focus before the node exists would be meaningless). The input loop's fixed precedence: disposal fence → the §3.3 pre-bind HOLD (the B1 review F4 contract — every non-exit key waits in a bounded queue for `bindInput`; the legal early Ctrl+C / empty-draft Ctrl+D still route the exit) → bound Ctrl+C/Escape (the EXISTING cancel path — the external-review P2 fix) → the composer reducer → submit gestures refused with the explicit `SUBMIT_NOT_READY` notice, draft preserved. `bindInput(handlers)` binds ONCE (a second bind throws), consumes the held keys exactly once in arrival order, and a dispose-before-bind discards the queue unconsumed. `q` is TEXT (the PR3-A bare-`q` quit retired with the composer — `isQuitKey` now answers only the PRE-BIND Ctrl+C emergency exit; bound Ctrl+C cancels and the empty-draft Ctrl+D exit lives in the reducer). The composer PORT adapter is the composer object itself. The dock banner names no chords (the host-keybindings gate). `setSubmitPending` surfaces the application's pending fact as a dock line ('Submitting…'/'Queued…'). |
| `src/app/surface/runtime.ts` + `bootstrap/renderer-selection.ts` | `SurfaceRendererMount.mount()` gains `bindInput(handlers)`; `SurfaceRuntime.start` binds at its exact commit point, constructing the narrow projection from the already-built `deps.events` callbacks (`exit` from `onExit`, `noteUserInput` from the optional `onUserInput`, guarded). B2 widens the projection with the submission members. |
| `test/tern-tsp-editor-input.test.ts` (new) | 17 tests, two layers over the SAME production code: the reducer (printable/CJK/emoji inserts, surrogate/ZWJ-safe backspace/delete/left/right, line home/end, gesture classification, paste atomicity incl. `/exit\rq` never dispatching, Ctrl+D empty-vs-text, unknown keys, port members incl. the deliberate settled no-op) and the REAL SDK loop over the scripted pane (controlled editor on the wire + focus after the first frame, typed bytes → editor text, Enter refusal keeps the draft + observable notice, paste never dispatches, a bound Ctrl+C cancels (never exits) while `q` is text, input-after-dispose inert, handshake-batched key consumed through the composer, handshake-batched empty-draft Ctrl+D routes the legal exit). |
| `test/tern-tsp-live-mount.test.ts` | A-04b rewritten to the B1 exit semantics (`q` is editor text; Ctrl+D with a non-empty draft never exits). |
| `test/support/tsp-terminal-fixture.ts` | Unchanged this PR (its `queueWithHandshake` already models the batch race; the B1 suite's pane copies that shape inline). |

### Authority and lifetime

Unchanged from B0: the composer is renderer-local editor state; no session,
queue, writer or classifier authority. The input loop remains the ONE input
path (no `process.stdin` listener, no second dispatcher). The exit/fatal
taxonomy is untouched. Native SDK edit/undo/send features are NOT advertised
(`sendable` unset).

### Verification (worktree `feat/tern-tsp-pr3-b1-editor`, node v24.20.0, pnpm 11.7.0)

Each row ran green on the tree it names in the review ledger; counts and
SHAs are deliberately not restated here (they drift per round — the ledger
narrative carries the provenance).

| Command | Result |
|---|---|
| `node --test test/tern-tsp-editor-input.test.ts` | pass. Coverage: the F1 probe shapes, the port render sink, the held/bind/discard guards, the ordered pre-bind Ctrl+D, the v4-tail exit shape, the flood/overflow guard, the bound cancel semantics, and the Surface.render-call observer guard (one render per accepted edit — a wire-frame count is NOT discriminating) |
| `node --test test/tern-tsp-live-mount.test.ts` | pass (A-04b updated; re-run per round) |
| `node --test test/tern-tsp-renderer-selection.test.ts` | pass |
| `node --test test/tern-tsp-runner-teardown.test.ts` | pass |
| `node --test test/tern-tsp-pr3b-ports.test.ts` | pass |
| `pnpm typecheck:bundle` | pass |
| `pnpm gate:architecture` / `pnpm gate:boundary` | pass |
| `pnpm test:product` | pass (zero failures) |
| `pnpm verify:prepush` | pass |
| Host-keybindings note | — | the ONLY gate failure in any run was the chord-labelled dock banner (fixed by removing the labels per the PR3-A precedent — no gate exception) |

### Manual real-pane smoke (B1 IMPLEMENTATION DONE / MERGE QUALIFIED BY OWNER AMENDMENT A1)

**Owner Amendment A1 (2026-10-09)** — approved by the stage owner; the full
text lives in the plan next to the B1 merge gate. Verdict table:

| Item | B1 verdict | Final closure point |
|---|---|---|
| Real-pane per-key, CJK, emoji, caret, draft clearing | `VERIFIED` | B1 |
| Bracketed-paste atomicity | `SCRIPTED_VERIFIED` | B4: real physical paste |
| Ctrl+C / Ctrl+D physical key behavior | `SCRIPTED_VERIFIED` | B4: real-pane key presses |
| Real IME composition/commit | `NOT_TESTABLE_HEADLESS` | B4: real GUI-environment IME test |
| SDK lifecycle, input ownership, regression lanes | accepted on existing evidence | B1 |

Binding constraints carried from the amendment: typing CJK directly is NOT
IME testing (B4 must use a real input method: candidate selection, commit,
caret checks); B-01's full end-to-end qualification still waits for B4;
B2/B3 gates are unchanged (no scripted-substitution precedent); B4 has no
further automatic deferral — an unobtainable environment records `BLOCKED`
and PR3-B is NOT DONE.

Environment facts: the driving tool `tern ctl` cannot inject
bracketed-paste bytes (its `type` verb sends literal text — demonstrated by
the v2/v3 records where `\u001b[200~` arrived as six printable
characters) and delivers no byte for control chords (Tern's GUI consumes
them — the PR1-recorded limitation); the host is a headless SSH session
(`DISPLAY`/`WAYLAND_DISPLAY` empty) with no GUI/input-method framework, so
real IME is physically impossible here.

The PARTIAL record below (the F3 redo) is the evidence behind the
`VERIFIED` rows.

Method: real Tern 0.6.3, headless `tern serve --control … --out /tmp/serve` +
`tern ctl --file` scenarios `run`ning the REAL `connectTspRenderer` +
`bindInput` (shipped SDK connect, no scripted pane) with
`TERN_TSP_RECORD`. Three runs; the F3 redo (`/tmp/tern-b1-rec-v4.jsonl`, 31
wire messages, 8 screenshots `b1v4-*`) is the evidence of record after the
first two were judged non-probative (see the F3 root cause below).

PROVED on the real pane (from the v4 record):

- **Complete mount record**: the file starts at frame `s=1` with the dock's
  initial `add` (banner + the `dock.composer` editor node with
  `text:""`, `cursor:0`) — the first-run record that was missing in the F3
  finding.
- **Focus**: the `["focus","dock.composer"]` op is on the wire after the
  first committed frame.
- **Typed input**: the SDK coalesced the four ASCII keys into THREE editor
  text ops (`replace "t"`, `append "e"`, `append "xt"`) with THREE cursor
  `set` ops (1/2/4) — frame-level coalescing is the SDK's own, not ours.
- **CJK/emoji**: `你好` as single-unit edits; `👍` as ONE 2-unit surrogate
  edit (cursor 6→8) — never split.
- **Enter refused**: the notice `the TSP composer is not wired for submission
  yet — the draft was preserved` reached the real wire; the draft survived.
- **Ctrl+D policy — NOT PROVED on the real pane**: `Control+d` delivers
  no byte to the pty (see below), so NO Ctrl+D policy (with-text no-exit
  or empty-draft exit) was exercised there. Both policies are asserted by
  the scripted tests, including the v4-tail shape (type `ab`, two
  backspaces, `\x04` → exactly one exit).
- **Backspace empties the draft exactly**: 7 backspaces consumed
  `text你好👍` cluster-by-cluster to `text:"" , cursor:0` (each a
  `replace` op: `text你好` → `text你` → `tex` → `te` → `t` → `""`).

NOT PROVED on the real pane — COVERED by the scripted-tty SDK layer instead
(same shipped SDK `InputParser`/`KeyDecoder`, `test/tern-tsp-editor-input.test.ts`):

- **Bracketed paste atomicity**: `tern ctl` has no raw-byte injection — its
  `type` verb sends literal text (an `\u001b[200~…` sequence arrives as six
  printable characters, as the v2/v3 runs showed), so the paste PROTOCOL
  cannot be driven from the real-pane tool. The scripted layer's
  `input.type('\u001b[200~/exit\rq\u001b[201~')` covers the real protocol
  bytes through the same SDK decoder.
- **Ctrl+C / empty-draft Ctrl+D exit on the real pane**: the `key Control+d`
  chord delivers no byte to the pty (Tern's own GUI layer consumes control
  chords — the SAME tool limitation PR1 recorded for `Control+c`). The exit
  policies are asserted by the scripted tests — including 'the empty-draft
  Ctrl+D exit shape (the real-pane v4 tail) through the bound loop' (type
  `ab`, two backspaces, `\x04` → exactly one exit).

F3 root cause (recorded for the ledger): the first smoke's record was
overwritten by scenario rehearsals (`TERN_TSP_RECORD` rewrites per run), its
`/exit…` content was sent via `type` (per-key, NOT a bracketed paste), its
11 backspaces did not empty the seeded draft so the final Ctrl+D correctly
did NOT exit, and the "shot 8 shows the shell prompt" claim was written
without inspecting the image. All three claims were retracted and redone
above; screenshots are artifacts only (not independently verified by this
agent's model, which cannot read images — the RECORD is the evidence).

### Review round 1 (needs-fixes → fixed)

The durable reviewer's round-1 verdict (on the initial B1 implementation
commit) was **needs-fixes**
(four P2s), each verified with a REAL-SDK read-only probe against the
production mount:

- **F1 (cursor boundary invariant)** — legal input could strand the caret
  inside a merged cluster (bracketed-paste a combining mark, Home, type a
  letter → backspace emitted the lone mark; `setEditorText('👍')` after
  typing kept cursor 1 inside the pair → backspace left `\udc4d`). Fixed:
  the caret is now normalized to a cluster boundary after every clamp and
  insertion (forward affinity), and both deletion endpoints are
  cluster-aligned; regression tests reproduce BOTH reviewer probe shapes at
  the reducer layer.
- **F2 (port mutators never rendered)** — `setEditorText` changed
  `getDraft()` with zero new frames on the real wire. Fixed: an `onChanged`
  sink commits ONE controlled frame per authoritative mutation (reducer
  edits AND all three port mutators); a wire-level test drives the real SDK
  chain through `renderer.composer.setEditorText/setDraft/insertIntoEditor`.
- **F3 (smoke evidence overstated)** — the first smoke's record had been
  overwritten by rehearsals, its "paste" was per-key `type` output, the
  final Ctrl+D never saw an empty draft, and an image was cited without
  inspection. Fixed by the PARTIAL redo above (complete record, truthful
  tool-limitation boundaries) — no claim exceeds its artifact.
- **External review (PR #262, on the amendment-recorded commit)** — 1 P2 + 1 P3:
  - P2: bound Ctrl+C violated the frozen §3.4 row-3 semantics (it routed
    exit — interrupting a live Agent would have killed the TUI) and Escape
    was inert instead of cancel. Fixed: `SurfaceInputBinding`/`TspInputHandlers` gain
    `cancel()`, wired at `SurfaceRuntime.start` to the existing
    `deps.events.onCancel` (the UserShell interrupt path B0 already made
    renderer-neutral). Bound Ctrl+C AND Escape route exactly one cancel and
    never an exit; the empty-draft Ctrl+D stays the exit gesture; pre-bind
    Ctrl+C keeps the PR3-A emergency-exit compatibility. Guard tests assert
    the cancel/exit separation with independent counters.
  - P3: every accepted edit rendered twice (dispatchKey's render() on top of
    the composer's onChanged sink). Fixed: dispatchKey no longer renders;
    a render-call observer guard pins it (one Surface.render call per
    accepted edit — a wire-frame count alone would NOT detect a duplicate
    render, since the SDK's diff suppresses empty updates).
- **F4 (bindInput missing)** — the plan's §3.3 transitional B1 contract was
  silently moved to B2. Fixed by IMPLEMENTING it (not amending the plan):
  the bounded pre-bind hold queue, the once-only `bindInput` (second bind
  throws; dispose-before-bind discards), the `SurfaceRuntime.start`
  commit-point binding of the narrow `exit`/`noteUserInput` projection, and
  guards for held-then-consumed, discard-on-dispose, and the bound exit
  path. Submissions stay refused (B2).

### Remaining exclusions (tracked owners)

- Submit/steer/cancel admission wiring: **B2** (the B1 `bindInput` now binds
  the editor-local/lifecycle projection — exit + user activity — per the F4
  fix; B2 widens it with the submission members and retires the refusal).
- Interactive modals: **B3** (attention chrome neutralization included).
- History recall (↑): explicitly not in B (the plan §3.4 history note).
- `clearSettledLocalMessages` real semantics: with the local-card surface
  (B1 deliberate no-op per the B0 P3-1 ruling).


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

- **Base**: the plan's frozen `next` baseline (verified at branch creation;
  no drift).
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
| `node --test test/tern-tsp-live-mount.test.ts` | pass (renderer mount contract incl. the new mount members) |
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

- **External review** (on the B0 implementation commit): 2 P3 findings + 2 boundary rulings —
  P3-1 the inert `clearSettledLocalMessages` mapped to the WRONG state
  (`display.setDockNotice(undefined)` clears the transient dock-notice stream,
  not the settled-local-card set; fixed to fail-fast like every other inert
  member); P3-2 the interrupt test waited a fixed 20 ms (fixed to a
  notify-resolved promise with a 2 s timeout); rulings recorded above
  (`bindInput` → B1, attention chrome → B3).
- **Round 1** (durable reviewer, read-only, on the implementation commit,
  tree clean at start/end): **accepted** — zero P0/P1/P2. Coverage: all 14 files, every hunk;
  B0 zones 1-8 verified with code anchors; merge-gate items verified against
  the supplied same-state evidence; the shared-seme analysis confirmed the
  ports are pure projections (no new session/queue/writer/classifier
  authority). "accepted ≠ merge authorization; B1-B4 and the PR4 display DTO
  debt remain with their owners."
- **Round 2** (docs-only ledger commit): **accepted**, zero findings. Noted `pnpm test:docs` covers only `docs/tmux/*.test.mjs`; this
  ledger's accuracy is proven by the human diff check, not that lane.
- **Round 3** (the two external-review fixes): **accepted**,
  zero findings. Confirmed the fail-fast semantics against the authoritative
  `TuiApp.clearSettledLocalMessages` contract and every production caller;
  confirmed B0 has no reachable path into the new throw (the TSP SDK loop
  still only routes `requestExit`); confirmed the promise-race guard has no
  unhandled-rejection path. Two non-blocking notes recorded as-is: the race's
  losing timer is not cleared (a passed test lingers ~2 s before file exit)
  and the guard now proves the first notice's content + zero card calls
  (not a strict exactly-once count). B1 must implement the member against the
  real composer state — the inert throw must not be inherited.

## B2 — `feat(tern-tsp): shared submit, busy policy and command admission`

- **Base**: the merged B1 tip of `next`.

### What changed (source anchors)

| Zone | Change |
|---|---|
| `src/app/surface/runtime.ts` | `SurfaceInputBinding` gains `submit(text, request)` / `steer(text)`; `SurfaceRuntime.start` builds them from the already-constructed `deps.events.onSubmit` / `onSteer` (the optional member is guarded) at its exact commit point, so a TSP Enter rides the ONE existing `SubmissionController` — never a renderer-owned writer. |
| `src/tui/tsp/session.ts` | The composer's submit gesture implements the §3.4 ordering: snapshot the serialized draft, CLEAR the composer BEFORE the callback, never re-apply a stale pre-callback snapshot. The pre-bind window keeps holding keys; the B1 "composer not ready" refusal retired with the real binding (it had become unreachable — `dispatchKey` only runs bound). |
| `src/app/command/tsp-capability.ts` (new) | The pure post-classification predicate: given the ALREADY-authoritatively-selected winner and the parsed builtin name, it answers only "is this selected TUI builtin available on the TSP renderer?" (`exit`/`quit` only). Not a parser; never consults `hostClaimOf`/the completion union; no state, no IO. |
| `src/app/submission/controller.ts` | One shared renderer-capability refusal for TUI-origin builtins at the POST-CLASSIFICATION admission (`This command's UI is not available in TSP yet`, draft restored) — a genuine Host-origin command of the same spelling keeps its precedence. `!`/`!!` are refused at the ORIGINAL shell-branch admission BEFORE `persistHistory`/`ensureSession`/`acceptLocalSubmitAck`/`shell.run`, so a refused shell line creates no Host process, no history row and no Session (`User-shell UI is not available in TSP yet`, draft restored). |
| `src/app/surface/application-events.ts` | `ApplicationEventsSurface` gains the renderer-neutral composer projection; the newly reachable draft read (`isImageDraft`) uses it. Clipboard image/path intake, plugin semantic actions and the PiTui panels stay PiTui-only and are unreachable on TSP in B2 (deliberately not implemented — PR4). |
| `src/app/bootstrap.ts` | Injects the two renderer capabilities as LIVE getters over the same settled flag (`supportsLocalShellCards`, `supportsTuiBuiltinUi`), so the SDK-decline fallback (PiTui mounts) correctly keeps both available. |

### Busy / steer policy

The renderer never derives or fabricates a delivery mode: it passes the user's
GESTURE through (`enter` / `accelerated`) and lets the existing
`resolveSubmitDelivery` + the persisted `busyEnter` preference decide queue vs
steer. Parity with PiTui is therefore structural (one policy, one classifier),
not a second implementation — and the gesture pass-through is pinned by the
renderer tests.

### Verification

| Command | Result |
|---|---|
| `node --test test/tern-tsp-editor-input.test.ts` | pass (the submit cases are now B2: bound Enter submits once with the composer already empty at the callback; Ctrl+Enter submits the accelerated gesture; a pre-bind Enter is held then replayed in order) |
| `node --test test/tern-tsp-command-admission.test.ts` (new) | pass — the predicate with the REAL classifier, plus the Host-same-name / extension / skill / unknown-name negative controls |
| `node --test test/tern-tsp-runner-interactive.test.ts` (new) | pass — on the REAL Direct runner over the TSP pane: `/settings` refused with the notice + draft restored; `/exit` allowed and routes the exit orchestration; `!echo hi` refused with a recorder Host shell executor recording ZERO runs and the draft restored; a plain Enter takes the application submit path and the composer is cleared before the callback |
| whole TSP suite set | pass |
| `pnpm typecheck:bundle` / build / `gate:architecture` / `gate:boundary` | pass |
| `pnpm test:product` | pass (zero failures) |

### Remaining / deferred (tracked owners)

- **Real Tern pane submit + Assistant streaming** (plan §6.4 / the B2 merge
  gate): the Direct-Agent streaming demonstration on the physical pane stays
  with **B4**'s mandatory real-pane matrix, under the same Owner Amendment A1
  boundary B1 recorded (no scripted substitution may be presented as physical
  proof).
- Clipboard image/path intake, plugin semantic actions, `@` completion and the
  PiTui panels on TSP: **PR4** UI parity.
- Question/Approval: **B3**.
