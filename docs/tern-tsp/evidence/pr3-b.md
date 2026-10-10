# Tern TSP PR3-B evidence — interactive pane (B0..B4)

> **Status: B0, B1 and B2 merged into `next` (PRs #261, #262, #263); B3
> implemented on `feat/tern-tsp-pr3-b3-interaction` and based on `next` @
> `d08e666c` after a clean rebase. Every finding of the internal rounds and of the
> six external rounds is CLOSED — the external review's final verdict is
> **code-level accepted, zero open P0/P1/P2** — and the presentation-currentness
> MUST (F6/C) is CLOSED with production-path witnesses for Questions AND Approvals.
> The only remaining step is the merge itself (CI green + this document's closing
> update). B4 keeps the IME / physical-paste / control-key matrix.**


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

### Real Tern pane submit + Assistant streaming (the B2 merge-gate proof)

**Delivered on a real Tern pane** (not a scripted tty). Method: a THROWAWAY DSH
profile linking this worktree, booted as
`DSH_PI_TUI_RENDERER=tsp dsh --profile <throwaway>` inside a headless
`tern serve` pane with `TERN_TSP_RECORD` capturing the wire; the prompt was typed
with `tern ctl type` and submitted with a real `key Enter`. Synthetic,
non-secret prompts only.

Environment: Tern 0.6.3, `dsh` 0.2.0-rc.2, this bundle (0.5.1) linked into the
profile, Tern SDK 0.1.0, a real Direct Agent through the profile's LLM provider.

What the record shows, in order:

1. **Typed into the controlled composer**: the program-owned editor state on
   the real renderer — COALESCED updates (the SDK merges consecutive keys into
   one `append`, e.g. `ply with e`, so it is not literally one op per key).
2. **The submit gesture cleared the composer BEFORE the application write**
   (§3.4 ordering): the composer `replace ""` frame lands, then the local
   `Submitting…` pending row, then the client-local echo
   `[1] you (sending…): <prompt>`.
3. **The real application write**: the pending row is replaced by the
   authoritative event, the canonical transcript gains the **You** card with the
   exact prompt text, the status line reports `working`, and a running row
   appears — one submission, no double-send.
4. **Assistant streaming**: for a longer answer the Assistant card is created
   with only its FIRST token, and the following frame carries a `text` APPEND
   with the remainder, then the turn/work streaming marker clears — incremental
   deltas on the real pane, not a single settled render. The incremental proof
   comes from the WIRE (the card's first-token frame followed by the append
   frame); the `b2p-4-stream-long` screenshot's viewport shows the second You
   card and the working row, so it is a locator for the run, not by itself
   proof of the completed reply.
5. **The session**: a real Session is created and its title reaches the dock.


**Artifact manifest (this round).** All artifacts live under `/tmp` (outside the
repository and outside the private DSH storage). Synthetic, non-secret prompts.

| Artifact | Path | Content hash (sha256) |
|---|---|---|
| TSP wire record (the authoritative evidence) | `/tmp/tern-b2-rec.jsonl` | `4fcb9eeaa7da73626e32fe56b71263e2275e2682d615c15a1fceb48c731d3b12` |
| Tern scenario 1 (prompt 1 + shots) | `/tmp/tern-b2-scenario.txt` | `078d2a23a6bd54e7e1b4406e992ed0ae242e115150e32caeb482d2cb7ba144ca` |
| Tern scenario 2 (prompt 2 + shot) | `/tmp/tern-b2-scenario2.txt` | `2393e1785837d4a04166136d31d6074d0ebe95f790f0f747ae274655ff0f16dd` |
| Pane/serve log | `/tmp/tern-b2-serve.log` | — |
| Screenshots | `/tmp/serve/b2p-1-initial.png`, `b2p-2-typed.png`, `b2p-3-streamed.png`, `b2p-4-stream-long.png` (each with a `.layout.json`) | — |

Prompts (exactly as typed): `Reply with exactly: B2-PHYSICAL-OK`, and
`Write the numbers 1 to 40 separated by spaces, then stop.`

Launch: a THROWAWAY DSH profile at `~/.dsh/profiles/b2-physical` whose
`package.json` links `@xmoon76/dsh-pi-tui` to THIS worktree (bundles
`@deepseek-ai/dsh-base` + `@xmoon76/dsh-pi-tui`); the pane ran
`DSH_PI_TUI_RENDERER=tsp TERN_TSP_RECORD=/tmp/tern-b2-rec.jsonl dsh --profile b2-physical`
inside `tern serve --control /tmp/tern-b2.sock --out /tmp`.

Key frames in the record (frame numbers are the SDK surface sequence `s`): the
per-key composer edits; the composer `replace ""` clearing at the submit; the
`dock.pending-submit` row; the client-local `dock.tail-0` echo; the canonical
`main.s1-msg-1` You card carrying the prompt; `dock.status` … `working`; the
`main.s1-msg-5` Assistant card; and for prompt 2 the `main.s1-msg-8` Assistant
card created with body text `1` followed by a `text` APPEND carrying the rest,
then the stream marker clearing.

Explicitly NOT claimed here: any IME composition (no GUI input method is
involved — the text is injected), and bracketed paste / control-chord delivery
(those remain the B1-recorded `tern ctl` limitations). The scripted-pane suites
still carry the paste/exit-path coverage.


### Direct production-equivalent fixture and the B2 admission matrix (§6.2)

`test/support/direct-tsp-fixture.ts` is the Direct counterpart of the Remote
application fixture: the rc.2 Host composition is mounted for real and the TUI
runner boots against it with the TSP pane owning the tty.

PRODUCTION PREREQUISITES REPRODUCED
- real Host service composition via `mountAgentLoopTestDependencies` +
  `mountAgentLoopTestHarness` (REAL live Agents), plus persistence (Jsonl),
  storage/domain, credentials, workspace, filesystem, presets, userQuestions,
  attachments (`@deepseek-ai/dsh-attachment-local`), jobs + job controller,
  commands, API gateway, loader and the TUI's own extension host and builtins
  row
- the REAL `applyRunner` composition, the REAL `SubmissionController`, the REAL
  Direct `SessionWriter`, the REAL command catalog/origin derivation, the REAL
  extension command bridge and the Real TSP renderer over the shipped SDK
  `connect`

TEST STAND-INS / SUBSTITUTIONS
- the MODEL only: a scripted streaming `LlmAdapter` registered on the Host
  `llm` service (it can also HOLD its stream to keep a turn running, and records
  whether its request observed an abort)
- `agentDefaultModel`: the fixed selection stand-in (the scripted provider and
  model id) so the live Agents resolve a model without a credentials-backed
  provider; `saveSelection` is a no-op
- `fileReferences`: the empty workspace index stand-in
- the scripted tty (the pane)

DELIBERATELY ABSENT
- generated Remote client L5/L6 (not part of B)
- native editor edit/undo/send (disabled by contract)
- durable event rows in the Jsonl store: the fixture's turn events stay in the
  live Agent's log (the persistence routing installer that pipes live events
  into the write handle is part of the real launcher composition, not this
  fixture); the writer's committed outcome is instead witnessed at the
  PRODUCTION writer itself (the one-to-one `prompt` recorder). The
  `user-history` input store IS real on this fixture (the `!` refusal's
  positive control reads it).
- a session-scoped skill catalog: a fixture provider makes a skill name
  ADVERTISED, but the fixture does not compose a session-scoped catalog that
  resolves it, so no successful live skill INVOCATION is claimed here. What is
  proven is the advertised-miss consumption of that name (below) and the
  predicate's `not-a-tui-builtin` verdict for the skill family.

Fixture setup ownership (the round-3 review's P2): the pane's process-tty
replacement, the cleared env vars and the partially mounted Context are each
registered for cleanup AT OWNERSHIP TIME (LIFO, idempotent, exactly once). A
rejecting setup step — not only a successful teardown — restores the process
exactly as it found it; the caller's `finally` never has to reach `settle()`
for cleanup to run.

Matrix proven on this fixture (`test/tern-tsp-direct-application.test.ts`,
`test/tern-tsp-direct-admission.test.ts`, with the PiTui busy-parity control
in `test/tern-tsp-busy-parity.test.ts`):

| Case | What it proves |
|---|---|
| SDK keys → composer → `onSubmit` → real controller → real writer → real Agent turn → scripted stream → canonical fold → SDK frames | the whole L6 chain automatically, with pre-gesture negative controls on both the assistant text and the writer's settled-record count (zero); the production writer's `prompt` then settles EXACTLY ONE committed queue write — the settled record carries the submitted prepared message and the resolved live Agent's running status — the model serves exactly one turn, and no further write settles after the turn |
| a GENUINE Host command sharing a TUI builtin's name | the authoritative catalog wins: the Host SINK runs and the TSP builtin gate never captures it |
| a FAILING Host command | the REAL Host failure sink ran exactly once (the anti-fake-green anchor: a swallowed submit fails here), the submitted line is live draft content again, and the command wrote ZERO session prompts and started ZERO model turns. (The §3.4 snapshot→clear is internal to the gesture — the renderer may coalesce the clear and the restore into one frame, so no intermediate wire-EMPTY state is claimed.) |
| a refused `!` line | NO input-history row is written (an accepted prompt is the positive control for the same isolated store) |
| `busyEnter`×gesture, plain Enter / Ctrl+Enter into a RUNNING turn | the REAL configured preference decides, the accelerated chord takes its OPPOSITE: each cell waits for THAT submission's OWN settled writer record (identified by its prepared message) and asserts its mode and committed outcome — never a warm-up record or a bare entry count; the PiTui control (`tern-tsp-busy-parity`) drives the same preference × gesture grid through the same real runner/config authority (its Agent is the harness stand-in) and observes the same deliveries at the stand-in's `followup`/`steer` producers |
| Esc during a RUNNING turn | the existing cancellation path runs end-to-end: the live model request observes its abort, and the TUI never exits; a typed-REJECTED cancel (fault-injected at the production writer's `cancel`) surfaces its structural message through the renderer-neutral notice sink (never an exit) |
| a registered CLIENT-EXTENSION contribution | it runs; the TSP builtin gate does not touch the extension family |
| an advertised name missing from the created session | the EXISTING advertised-miss path consumes it with its own notice, never a TSP-style refusal |
| a hydration that never commits a new subject | the renderer stays fail-closed: the Loading state is retained, the outgoing draft is preserved verbatim (no edit, no submit crosses the fence), and the lifecycle cancel intent stays live (the fence never exits the TUI) |

### Remaining / deferred (tracked owners)

- Clipboard image/path intake, plugin semantic actions, `@` completion and the
  PiTui panels on TSP: **PR4** UI parity.
- Question/Approval: **B3** — implemented (see the B3 section below); the
  physical IME / paste / control-key matrix and the full interactive
  qualification stay **B4**.

## B3 — `feat(tern-tsp): question and approval interaction seat`

- **Base**: the merged B2 tip of `next` (PR #263 — the addendum's verified
  baseline).

### What changed (source anchors)

| Zone | Change |
|---|---|
| `src/app/surface/interaction-presenter.ts` | The presenter contract gains `setQuestionAttention(parkedCount)` (a PRESENTATION of the ONE controller's parked count) and `withdrawPending()` (synchronously end this presenter's queued/active promises). The PiTui branch is no longer the bare `TuiApp`: it is the narrow delegating adapter `pituiSurfaceInteractionPresenter(app)`, which forwards every member with the app as receiver and keeps `withdrawPending` a documented NO-OP (that branch's cancellation owner remains the app's own `dispose()`). |
| `src/app/surface/interaction-runtime.ts` | The parked count is published through the renderer's presenter (no PiTui-only `mounted()` chrome read), so a renderer without a `TuiApp` receives it. `dispose()` retires the controller reference and subscription FIRST, then runs independent obligations in order: release the attention subscription → `controller.dispose()` → `presenter.withdrawPending()` → clear the settled lookup. The controller's own disposal therefore classifies a Host question first (`ASK_ABORTED`/`ASK_CANCELLED`), and the presenter only withdraws what the surface still owns. |
| `src/app/surface/runtime.ts` | `SurfaceInputBinding` carries `listContinuedQuestions()` (the FRESH authoritative rows; the renderer filters `parked`) and `reopenContinuedQuestion(sessionId, callId)` (routed to the ORIGINAL `QuestionSurfaceController.reopen`). The non-truncating teardown batch now STARTS the renderer/SDK release after `interaction.dispose()` and the PiTui app disposal, so a modal promise is settled before the terminal goes away — and the release is still started when an earlier synchronous step throws. |
| `src/tui/tsp/interaction.ts` (new) | The renderer's ONE interaction seat: a unified FIFO of the official Approval and Question requests (no second approval policy, no second Question controller), one `layer` overlay at a time, modal-first key ownership, one abort listener per slot, `settled` latches, and promise settlement exactly once. Approval keys are exactly unmodified `y`/`n`/Esc/Ctrl+C (every other key is consumed); the question form implements single/multi-select, the free-text/Other sub-state, the Review page, skip-on-forward, `intent.approve`-anchored highlighting, `(recommended)` display stripping with the ORIGINAL label preserved in the answer, `QuestionFlowDraft` snapshots, the real-answer-mutation hook (never on focus/cursor/highlight/repaint), masked display (one bullet per grapheme, plaintext only in seat memory), and the Alt+Q parked list that re-reads the authority on every frame and closes before the controller's `reopen` recheck decides. A malformed official payload is refused at the boundary with a visible notice and the flow's cancellation error — never a fabricated answer. A frame/focus failure while a form is being PRESENTED for the first time is the renderer's FATAL path: the slot is retired (no ghost seat keeps swallowing keys), its original promise settles exactly once (approval `cancelled` — never an allow), and the failure reaches the fatal sink. The real-answer hooks compare the draft's ANSWER SEMANTICS, so re-confirming the same option, re-entering the same text or merely accepting a restored draft fires nothing; and a real single-select choice invalidates the replaced free-text buffer as well as the draft, so the replaced Other text cannot resurrect. |
| `src/tui/tsp/session.ts` | The layer is submitted on EVERY frame (the SDK render is a full-view diff: an omitted region is deleted, so `layer` is always present, empty when no seat is active). Focus is no longer a one-shot latch: the renderer keeps the last APPLIED focus target and re-issues the op whenever the desired seat changes — `null` for a list/approval/select-only form, the real `layer.modal-<n>.answer` node id for an open free-text editor, `dock.composer` when no modal owns the seat. The input loop routes modal-first, and the modal seat now outranks the hydration fence (§3.5.4) — a form presented for the subject the surface still owns stays answerable while a later hydration starts, while `Alt+Q` stays fenced out of that window. `SessionInput.event` focus/edit/undo/send events are consumed while a modal owns the seat, so the terminal cannot hand the caret back. `supportsModals` becomes true only once `bindInput` installed the real application callbacks. |
| `src/tui/tsp/transcript-view.ts` | `TranscriptViewOptions` gains the settled-answer lookup: an `ask_user_question` row carrying the official `callId` renders the AUTHORITATIVE settled batch (`JSON.stringify({ answers })`) instead of its recorded result. The result BODY is decided by the SHOWN value, never by the recorded payload — a running row with an empty recorded result still reads the projection. An absent settled entry falls back to the recorded result; an EMPTY batch is a real settled outcome and does NOT fall back. |
| `src/tui/keybindings/hints.ts` + `scripts/check-host-keybindings.mts` | The key-label vocabulary owns the TSP seat's FIXED inspection chord (`TSP_CONTINUED_INSPECTION_LABEL`): the seat is not a Host command and owns no keymap action, so the label cannot come from `keyHint` — and it cannot go stale either, because no remap exists for it. The dock renders the imported label, and the host-keybindings gate sanctions that one line through its scoped seam list (owner-scoped to the keybindings tree, as its own fixture requires). |
| `test/support/tsp-terminal-fixture.ts` | Extended with key/event injection and wire-frame observation only (`frames()`, `key()`, `event()`); no renderer-local business state is exposed. |

### The L6 chain (real source → decision → sink)

`test/tern-tsp-interaction-runner.test.ts` mounts the REAL
`createSurfaceRuntime` with the REAL TSP renderer over a scripted SDK terminal
and the REAL `DirectInteractionPort`; the official request is delivered from
the Host event plane and answered through the ONE input loop, so the assertion
lands on the ORIGINAL sink:

| Case | What it proves |
|---|---|
| official `approval/request` → `y` | the exact `allowed-once` answer the official port resolves; the modal unmounts afterwards |
| official `user-questions/request` → real `QuestionSurfaceController` → SDK keys → producer | the official producer observed the real answer batch; the form was rendered from the official question text |
| cold `continued` projection at attach | the controller discovers it PARKED (no form steals the seat), the dock publishes the parked count, `Alt+Q` lists the fresh authoritative row, Enter reopens through the controller's own recheck, and `answerContinued` receives exactly one answer |
| settled projection + a recorded timeout row | the tool row shows the authoritative settled batch; an EMPTY batch is authoritative too |
| teardown with a live approval | the pending promise settles `cancelled`, exactly one SDK close frame is written, and input after retirement stays inert |

FIXTURE MANIFEST: REAL = `createSurfaceRuntime`, the `InteractionRuntime`, the
`SurfaceInteractionPresenter` wiring, `QuestionSurfaceController`,
`mountTspRenderer`, the shipped SDK session/surface, `DirectInteractionPort`
and the session-currentness reads. STAND-IN (the single external boundary) =
the Host SERVICE PLANE behind the Direct adapter (`userQuestions.
attachWait/answer`, the `sessionProjections` registry, the `approval/request` +
`user-questions/request` emitters), the Task Center source stub, and the
scripted tty pane. No renderer-local business state is fabricated.

SCRIPTED PANE, NOT A REAL TERN PANE: every row above is a scripted-tty
qualification; the real-pane B3 minimum is recorded separately below.

### Verified coverage (scripted)

| Suite | Result |
|---|---|
| `test/tern-tsp-interaction.test.ts` (new) | pass — one `layer` overlay per seat with real `focus(null)` / modal-input / `dock.composer` ops and a real `del layer.modal-<n>` on settle (the layer root is never deleted); approval `y`/`n`/Esc/Ctrl+C plus unknown-key consumption (no composer edit, no submit); unified FIFO with a fresh successor node id and no second focus; already-aborted / queued-abort / active-abort settlement; single/multi/free/Other/masked question forms; skip-on-forward and the Review round trip; `initialDraft` restore; Alt+Q fresh-read / refusal notice / official preemption; the modal seat outranking the hydration fence while `Alt+Q` stays fenced; the SDK focus-event shield; the real modal input node id; disposal settling an unanswered form |
| `test/tern-tsp-interaction-runner.test.ts` (new) | pass — the L6 table above |
| `test/tern-tsp-live-mount.test.ts` | pass — the B2 live-mount chain plus the B3 teardown-ORDER witness: with a fake renderer mount and a recording presenter, the surface withdraws the interaction owner BEFORE it starts the renderer release (`['interaction-withdraw','renderer-release']`) |
| `test/tern-tsp-editor-input.test.ts`, `test/tern-tsp-submission.test.ts` | pass — the B2 composer/submit behaviour is unchanged; the handler literals carry the two new renderer callbacks |
| `test/tern-tsp-pr3b-ports.test.ts` | pass — the composer port is still the live app; the modal presenter is now the narrow adapter (receiver-preserving delegation, `withdrawPending` no-ops on the PiTui branch) |
| `test/tern-tsp-runner-interactive.test.ts`, `test/tern-tsp-runner-teardown.test.ts`, `test/tern-tsp-command-admission.test.ts` | pass — the B2 admission, the fail-closed attach path and the runner lifecycle are unchanged |
| `test/terminal-progress-lifecycle.test.ts`, `test/question-park-reopen.test.ts`, `test/question-remote-lifecycle.test.ts` | pass — the PiTui presenter adapter and the controller's park/reopen/timed lifecycle suites still pass on their own authority |

MUTATION GUARDS (each mutation applied alone, its witness re-run, the tree
restored byte-identically): the parked count no longer reaching the presenter,
modal keys falling through to the composer, the one-shot focus latch,
`withdrawPending` leaving queued promises pending, the controller's reopen
skipping its queued-reply recheck, an EMPTY settled batch treated as absent,
and a masked value rendered in plaintext — each turned its witness RED.

### Negative controls and honest boundaries

- A cold continued Question is PARKED, never mounted: the dock count is a
  presentation of the controller's read, not an answerability claim.
- The masked plaintext is asserted absent from the WHOLE wire (every frame the
  renderer ever wrote), not only from the visible row.
- The refusal paths (`cannot answer this request in the TSP renderer`) never
  fabricate an answer: an unrepresentable approval resolves the cancellation
  rule (this presenter contract has no `unavailable` member) and an
  unrepresentable question rejects with the flow's cancellation error.
- No `SessionInput.event` business action (pointer/action/select) is
  implemented in B3; only the focus/edit/undo/send shield is.
- PiTui, the SDK-decline fallback and the default renderer are untouched: the
  B3 delta does not reach `packages/pi-tui/**`, the public extension surface or
  the Host coupling baseline.

### Real Tern pane (B3 minimum)

Environment: Tern **0.7.0**, `dsh` 0.2.0-rc.2, this bundle's B3 build linked into
a THROWAWAY profile created and removed for this record (the real-use `pi-tui`
profile was never touched), a headless `tern serve` pane with `TERN_TSP_RECORD`,
a real Direct Agent. Synthetic, non-secret prompts only.

QUESTION — PROVEN (real official request → TSP form → real keys → official
settled projection → transcript row → model continuation):

- the prompt asked the model to call `ask_user_question` with two options;
- the official request rendered as `layer.modal-1`: `Question 1/1`, the header,
  the question text, both options with their real labels/descriptions, the
  free-text row and the key hint (screenshot `b3-question-asked`);
- `Down` then `Enter` selected Green and advanced to the Review page
  (screenshot `b3-question-review`: `Review your answers / 1. Green`); `Enter`
  submitted the batch;
- the model continued, and the tool row then showed the AUTHORITATIVE settled
  batch `{"answers":[{"id":"color","selected":["Green"]}]}` (screenshot
  `b3-question-answered`) — the answer reached the official Host sink;
- the wire record holds the exact ops: frame 0 `add layer`, frame 1
  `focus dock.composer`, frame 129 `add layer.modal-1`, frame 130 `focus null`,
  frame 132 the Review diff (`del …row-0..2`, `add …review`, `add …answer-0`)
  under the SAME overlay id, frame 133 `del layer.modal-1`, frame 134
  `focus dock.composer`.

QUESTION (multi-page) — PROVEN: one official request carrying three questions
(a free-text/optionless one, a multi-select one and a single-select one)
rendered as `layer.modal-4`, its free-text page focused the REAL
`layer.modal-4.answer` node, `Space` toggled two options, `Enter` advanced, and
the Review page showed `1. teal / 2. red · green / 3. yes` — the multi-select
page listed the labels in ORIGINAL option order. Submitting made the tool row
show the authoritative batch
`{"answers":[{"id":"fav_colour","selected":[],"custom":"teal"},{"id":"liked_colours","selected":["red","green"]…}]}`
and the model summarised exactly those answers (screenshots `b3a-multi-q1`,
`b3a-multi-q2-toggled`, `b3a-multi-q3`, `b3a-multi-review`, `b3a-multi-answered`).

APPROVAL — PROVEN, and the earlier BLOCKED record is CORRECTED here. The first
attempt could not produce an approval request because the throwaway profile
inherited DSH's default permission preset `danger-full-access`
(`sandbox: danger-full-access` + `approval: never`) — the answerer was never
asked, so the absence was a PROFILE CONFIGURATION defect, not an environment
limit. With a throwaway profile whose only change is

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: workspace-write   # sandbox workspace-write + approval: ask
```

three SEPARATE genuine requests were driven end to end (each one a real Host
escalation of a write outside the workspace):

- `y` → the escalation ran and the probe directory was created (screenshot
  `b3a-approval-y-ask` shows the modal: `Approval required`, `tool: bash`, the
  Host's reason, the raw arguments and `y allow once · n reject · esc cancel`;
  `b3a-approval-y-result` shows the command's `created` output);
- `n` → the transcript recorded
  `the user rejected escalating this command to "danger-full-access"` and the
  probe directory was NOT created (`b3a-approval-n-ask`, `b3a-approval-n-result`);
- `Escape` → the transcript recorded
  `approval for escalating to "danger-full-access" was cancelled` (a distinct
  outcome from the rejection) and nothing ran (`b3a-approval-esc-ask`,
  `b3a-approval-esc-result`).

The wire record holds the three modal lifetimes in order: `add layer.modal-1` →
`focus null` → `del layer.modal-1` → `focus dock.composer`, then the same
add/focus/del/refocus quartet for `layer.modal-2` and `layer.modal-3` — one seat
at a time, the caret returned to the composer after each decision.

ALT+Q CONTINUED — PROVEN, after fixing a SECOND profile defect. The first
attempt could not produce a timed wait because the throwaway profile exposed the
LEGACY `ask_user_question` row (`mode: legacy`, no `timeout` parameter — the
model reported the absent parameter, screenshot `b3a-timed-ask`). The row is
configurable: `@deepseek-ai/dsh-tool-ask-user` accepts `mode: 'timed'` plus a
default `timeout`, and the official preset patch documents that a profile patch
overrides `preset-standard`'s `config.plugins` by id. A throwaway profile whose
only changes were the `workspace-write` permission preset and

```yaml
- id: preset-standard
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: standard
    order: 1
    plugins:
      - id: tool-ask-user
        name: "@deepseek-ai/dsh-tool-ask-user"
        config:
          mode: timed
          timeout: 15
```

produced the whole physical chain in a real Tern 0.7.0 pane: a genuine timed
question (the tool result recorded `{"pending":true,"callId":…}` when the Host's
15 s wait expired), the dock then showed `Continued questions: 1 · Alt+Q`
(screenshot `b3t-timed-countdown`), a PHYSICAL `Alt+Q` (the kitty CSI-u form
`ESC[113;3u`, since `tern ctl key` only carries named keys) opened the list
`sessions… · call_…` with `enter open · esc close` (`b3t-altq-list`), Enter
reopened the form through the controller's own recheck (`b3t-altq-reopened`),
the late answer `cat` was submitted, and the tool row then carried the official
settled batch `{"answers":[{"id":"favourite_animal","selected":[],"custom":"cat"}]}`
together with the official `user-question-reply` card and the controller's own
notices (`A reply for this question is already queued…` /
`This question is no longer awaiting an answer.`), after which the model
continued (`Your favourite animal is the cat.`; screenshot `b3t-altq-answered`).
The wire shows the whole sequence: `add layer.modal-1` + `focus
layer.modal-1.answer` (the timed form) → `del layer.modal-1` + `focus
dock.composer` (the timeout withdrawal) → `add layer.modal-2` + `focus null`
(the LIST) → `del layer.modal-2` (the list closes BEFORE the reopen) → `add
layer.modal-3` + `focus layer.modal-3.answer` (the reopened form) → the Review
diff under the same overlay id → `del layer.modal-3`.

NO PHYSICAL CELL REMAINS OUTSTANDING in the addendum's §6 minimum.

Artifacts (outside the repository, `/tmp` only; THREE physical runs, each with
its own pane directory and its own wire record — none of them stands in for
another):

| Run | Screenshots (pane `--out` dir) | Wire record + sha256 |
|---|---|---|
| 1 — Question single-select, and the three approval attempts that revealed the `danger-full-access` profile defect | `/tmp/tern-b3-shots/serve/b3-*.png` (+ `.layout.json`) | `/tmp/tern-b3-rec.jsonl` — copy `/tmp/b3-real-pane-wire.jsonl`, sha256 `878543d2b25e74c7f562…` |
| 2 — Approval `y`/`n`/`Escape` as separate requests, the three-question form, and the legacy-schema evidence | `/tmp/tern-b3a-shots/serve/b3a-*.png` (+ `.layout.json`) | `/tmp/tern-b3a-rec.jsonl` — copy `/tmp/b3-approval-wire.jsonl`, sha256 `2c3812ca285298bf366f…` |
| 3 — the timed question, the dock count and the physical `Alt+Q` late-answer chain | `/tmp/tern-b3t-shots/serve/b3t-*.png` (+ `.layout.json`) | `/tmp/tern-b3t-rec.jsonl` — copy `/tmp/b3-altq-wire.jsonl`, sha256 `0e6c798ca763930a2cba…` |

### Plan-authority ruling on the currentness MUST (recorded, not downgraded)

> A tentative Session opening is not an owner replacement. An unanswered live
> Question may legitimately remain mounted while ordinary transition quiescence
> prevents B from being published. Once B is actually published, A's modal must
> no longer own the TSP presentation or input, independently of whether A's Host
> request cancellation has completed.

The MUST was therefore kept OPEN until the three production-path witnesses
existed. They now exist (rounds 5–6 below), and they DID show the
renderer/controller presentation hook was missing: the fix landed at that hook
(`QuestionSurfaceController.reconcile` + the approval presentation registry in
the interaction owner + the renderer-facing presenter member + the runner's
published-session seam `SurfaceRuntime.reconcileInteractionPresentation`), never
in Session ownership and never by lowering the bar.

### Review round 2 — findings and how each was closed

The first full B3 review returned request-changes with zero P0/P1 and six P2
findings. F1–F5 were fixed at their root cause and locked with a witness that
fails on the pre-fix code (the mutation runs are listed after the table); F6 is
a QUALIFICATION-MATRIX finding, not a defect, and is reported as PARTIAL with
its remaining gaps named rather than as closed.

| Finding | Root cause and fix |
|---|---|
| F1 — a frame/focus failure while PRESENTING a form was swallowed | The initial presentation called the render sink inside the promise executor, so a throwing frame rejected the request while the seat stayed active and `supportsModals` stayed true (a ghost seat that kept swallowing keys). The initial mount now goes through the same fatal-guarded path as settlement: the slot is retired, its promise settles once (approval `cancelled`, question the flow's cancellation error) and the failure reaches `onFatal`. |
| F2 — a real single-select choice left the replaced Other text alive | Choosing a real option cleared the canonical `custom` but not the LIVE editor buffer, so reopening the Other row resurrected the replaced text and re-confirming it overwrote the new choice. The selection now invalidates the buffer with the draft. |
| F3 — re-confirming the same answer fired the real-answer hooks | The confirm path called the hook pair unconditionally; the same selection, the same text or an accepted `initialDraft` counted as mutations. The hooks now compare the draft's answer semantics and fire only on a real change (the controller's own frozen latch is idempotent, but a no-op answer is not a mutation). |
| F4 — an empty recorded result skipped the settled lookup | The result body was gated on the RECORDED payload being non-empty, so a running `ask_user_question` row never read the authoritative batch (or its authoritative emptiness). The shown value now decides the body; an absent lookup still renders nothing. |
| F5 — the new host-keybindings seam was registered on the wrong owner | The scoped seam list is owner-scoped to `src/tui/keybindings/**`, so a renderer file cannot own the row (the gate's own fixture enforces it). The fixed chord label now lives in the key-label vocabulary (`hints.ts`) and the renderer imports it; the seam row is registered against that file. The mandated `· Alt+Q` copy is preserved — it was NOT dropped, the fixture was NOT weakened, and no keymap action was invented for a chord the seat dispatches from the raw key stream. |
| F6 — qualification-matrix gaps | **CLOSED — the external review of PR #265 accepted the code with zero open P0/P1/P2 (rounds 5–6, confirmed after the six external rounds below)** — the physical minimum and the scripted matrix are proven, and the REAL app/session currentness connection is now proven on the production path for BOTH official request kinds on the branch that delivers them (the named production witnesses exist and the missing presentation hook was found and fixed: the Question flow at publication, and the approval prompt at publication via the official request's OWN Agent identity). The status stays PARTIAL because the reviewer kept the umbrella open until the re-review confirms the whole currentness model; rounds 7–9 closed its remaining defects (F9 per-request presentation identity, F10 admission currentness, F11 refused-admission teardown ownership and its closed-owner window, F12 opening-target consistency, F13 renderer-owned scoping, F14 the opening-authority producer). The B3-9 review reports every B3 finding CLOSED with zero open P0/P1/P2; round 10 was the doc/comment-only provenance correction, and the external review of PR #265 then took the same currentness model through six more rounds (a late continued offer, signal-less settlement, the owner-publication window, the commit-section Host read, multi-modal atomicity, settle-after-batch and the transient-list scope) before accepting the code with zero open P0/P1/P2 — so this row is CLOSED. An approval request with no derivable Session identity is recorded as N/A_WITH_REASON for the currently supported surface — the Direct `ApprovalRequest` always carries its own Agent and the Remote branch delivers no approval request at all — so no identity is invented and no scope is widened for a hypothetical provider. Recorded history of the gap as it stood at round 2: the REAL app/session currentness connection was OPEN: the consumer-side witness (a Host-ended request retires cleanly) and the seat-level retired-request guard are not a production-path proof. What is owed: a real ordinary `/new` transition showing the pre-commit quiesce preventing B's publication while A's live Question is unanswered, a real `/fork` showing A's modal withdrawn BY PRESENTATION CURRENTNESS at publication (not only after the later Agent cancel) plus the real retirement's `agent.cancel({kind:'user'})` ending the request as exactly `ASK_ABORTED`, and a real ordinary switch withdrawing a mounted CONTINUED form through the official projection reconcile. The plan authority kept this MUST (it was NOT downgraded to a boundary) and ruled that a tentative Session opening is not an owner replacement, while a PUBLISHED B must never leave A's modal owning the TSP presentation or input. Round 3 added: the same-call `timed → ASK_TIMED_OUT → continued → park → Alt+Q → late answer → queued → settled result card` closure; a claim fake that honours the CALLER's lifetime signal plus the surface-teardown release assertion; delta-based currentness assertions with the exact `ASK_ABORTED` classification and a fresh B seat identity; the symmetric Question→Approval handoff; a reentrant official request created SYNCHRONOUSLY inside a controller projection read; the §5.3 extension of `test/question-remote-lifecycle.test.ts` (the real seat driving the timed/continued lifecycle); and the real-PiTui answerer positive mapped to its existing guards (re-run in this round: `test/interaction-settlement-hardening.test.ts`, `test/terminal-progress-lifecycle.test.ts`, `test/advanced-interactive.test.ts`, `test/focus-ui.test.ts`). The physical minimum now covers Question single/multi/free-text + Review, Approval y/n/cancel AND the continued `Alt+Q` late-answer chain (both physical defects were PROFILE configuration, not Host limits). |

MUTATION WITNESSES (each mutation applied alone, its witness re-run, the tree
restored byte-identically): removing the initial-presentation fatal exit, keeping
the replaced Other buffer, firing the hooks on a no-op re-confirmation, and
gating the result body on the recorded payload — each turned its witness RED.

QUALIFICATION ADDED (scripted, real composition) — round 2 and round 3:

- a genuinely TIMED official request: the claim's deadline, the controller's own
  countdown, the timeout rejection the official sink observes
  (`ASK_TIMED_OUT`), the official `continued` bookkeeping, the re-offered late
  form, and `answerContinued` exactly once;
- a real answer mutation before the deadline FREEZING the countdown (the form
  never times out afterwards) and the Host ENDING the wait rejecting
  `ASK_ABORTED` — never a user cancel;
- the official approval sink for `n`, an already-aborted request, a queued abort
  and an active abort (never an implicit allow, and the one answerer stays
  interactive);
- a successor created from the ANSWERED request (the production reentry shape)
  is not answered by the key that settled its predecessor, plus ONE mixed
  handoff direction (an Approval owning the seat while a Question queues behind
  it). The symmetric direction and a synchronous callback reentry are still
  owed;
- currentness, NARROWED TO WHAT IT PROVES: with the surface moved to another
  session, a request that the Host ends cannot write into the new session's
  composer, and the same `callId` in the other session carries none of the first
  session's settled answers (it falls back to its own recorded result). The test
  drives the Host side of that retirement; it does NOT prove that an owner
  switch itself produces the retirement (the app's session-generation path
  retires pending input, tasks and the viewer — not a live dialog), and the next
  round owes either a real producer or a sharper boundary statement;
- the REAL seat driven by the ORIGINAL `QuestionSurfaceController` in the
  park/reopen suite: a cold continued call stays parked, the explicit reopen
  presents the seat, Esc parks it and the reopened form delivers the preserved
  draft exactly once.

ROUND 3 CLOSED THE REMAINING SCRIPTED CELLS:

- the same-call closure of the timed chain: the genuine claim deadline, the
  timeout classification the official sink observes, the official `continued`
  bookkeeping, the auto-offered late form, an Esc PARK, the dock count, `Alt+Q`
  over the fresh authoritative rows, the controller's reopen recheck, the late
  answer delivered through `answerContinued` exactly once, the queued
  confirmation, and — after the Host settles the call — the authoritative batch
  on the SAME tool row;
- the claim lifetime is FAITHFUL to the real adapter: the fake's stream ends
  either when the HOST ends it or when the CALLER's signal is released, and a
  dedicated case proves the surface teardown releases the live claim exactly
  once and ends the request as `ASK_ABORTED`;
- currentness with discriminating assertions: the retirement's op DELTA adds no
  overlay at all (never "some overlay exists"), the retired request is
  classified exactly `ASK_ABORTED` (not merely "an error code"), the new
  session's own form takes a FRESH seat id, and the same `callId` in the other
  session still carries none of the first session's settled answers;
- the symmetric handoff (a question owning the seat while an approval queues
  behind it) and a reentrant official request created SYNCHRONOUSLY inside a
  controller projection read — neither preempts the active form, and the same
  key never answers both;
- the §5.3 extension of `test/question-remote-lifecycle.test.ts`: the real TSP
  seat driving the controller's timed lifecycle — the countdown status rendered
  by the seat, the local deadline classified `ASK_TIMED_OUT` with the claim
  released once, and the Host's `continued` projection re-offered to the seat
  and answered into the official `answerContinued` sink.

ROUND 4 (review-fix delta) ADDED:

- the timed witness now parks the continued form with the ONE Escape its real
  page state needs and asserts the application's CANCEL path ran ZERO times (the
  previous double Escape left the modal seat and reached the main cancel, which
  the harness's empty event table had hidden — the recorder now exists);
- the same-call settlement is proven on the RETAINED row: the tool row is on
  screen first with its recorded timeout payload, the later authoritative batch
  arrives as an UPDATE of that same node (`text` op, no `del`, no second row),
  and dropping the settled entry falls the same row back to its recorded result;
- the seat-level retired-request guard OBSERVES the real detach: the abort
  listener registered on the live slot's signal is removed by identity at
  settlement (the unbound `addEventListener`/`removeEventListener` originals are
  called with the signal as receiver and the listener identities are compared
  strictly), and the retired `status` hooks do not fire again while the
  successor form is driven;
- the composition-time claim lifetime: the fake claim now ends on the caller's
  release OR the Host's ending, and the surface-teardown case asserts the release
  exactly once with `ASK_ABORTED`.

REAL PiTui ANSWERER POSITIVE (the sibling that must not regress), mapped to its
existing guards and re-run in this round because the surface interaction seam
changed: `test/interaction-settlement-hardening.test.ts` (the real
`TuiApp.showApprovalPrompt`/`askQuestions` settlement matrix),
`test/terminal-progress-lifecycle.test.ts` (the real surface app plus the
interaction runtime over the PiTui adapter), `test/advanced-interactive.test.ts`
and `test/focus-ui.test.ts` (the real app's question/approval UI and focus).

HONEST BOUNDARIES OF THE ROUNDS:

- A LIVE (non-continued) question whose session switches was, before round 5,
  withdrawn only by its OWN owner (the Host waterfall's request retirement), not
  by the continuation model (which owns continued rows). Round 5 fixed exactly
  that gap at the presentation hook (the publication-driven reconcile), so the
  owner switch itself now withdraws the PRESENTATION while the request keeps its
  Host-owned lifetime; the retirement still ends the request (witness 2). The
  same rule now covers an APPROVAL prompt (round 6) and a flow whose claim was
  still OPENING when the replacement was published (F7, round 6).
- `test/question-remote-lifecycle.test.ts` WAS extended after all (round 3): the
  real seat driving the controller's timed/continued lifecycle now lives there,
  in the file the addendum names, instead of only in the L6 suite.
- The physical minimum is COMPLETE for the addendum's §6 list (Question
  single/multi/free-text + Review, Approval `y`/`n`/`Escape` as separate genuine
  requests, and the timed → continued → park → `Alt+Q` → late-answer chain). B4
  still owns the full physical matrix (IME, physical paste, control keys).
- TWO boundaries remain stated rather than solved, and neither is claimed as
  closed: (a) the retirement of a LIVE question is driven by the Host waterfall's
  own lifetime — the app's session-generation path retires pending input, tasks
  and the viewer, not a live dialog — so the currentness witness exercises the
  SEAT's inertness after retirement (a retired request cannot write into the seat
  that follows) rather than proving that an owner switch itself produces that
  retirement; (b) the scripted timed witness drives the Host's continuation
  bookkeeping through its fake boundary, exactly as the fixture manifest says.
  Both are offered as boundaries for review, not as closed cells.

### Round 5 — finding C (the currentness MUST): defect reproduced, hook fixed, witnesses

The three production-path witnesses were written FIRST, against the unfixed tree,
and they failed on exactly the presentation fact the finding names. Only then was
the hook fixed.

WHAT THE WITNESSES SHOWED ON THE UNFIXED TREE (the reproduction):

- witness (2): at the FIRST frame that presents the replacement Session B, the
  wire still carried A's live `layer.modal-1` form — while A's official request
  was demonstrably STILL IN FLIGHT (the Host's cancellation was held open by the
  fake Host plane, exactly the "independently of whether A's Host request
  cancellation has completed" case). A's modal therefore outlived A's ownership;
- witness (3): the same for a MOUNTED continued form (`layer.modal-2` still
  presented in B's publication frame).

WHAT WAS FIXED (presentation currentness only — no Session-ownership change):

- `SurfaceRuntime.reconcileInteractionPresentation()` is a new surface member that
  re-derives the Question presentation against the CURRENT owner. The runner
  calls it from the published-session seam (`initLiveSession`, before the first
  frame of the new subject) — the same seam that hydrates the new owner, so the
  withdrawal is committed in or before that owner's first presented frame;
- `QuestionSurfaceController` now tracks each live foreground flow by the EXACT
  lifetime object its presenter call received, and `reconcile()` withdraws every
  flow whose Session no longer owns the surface. The promise is DELIBERATELY NOT
  settled: the official request keeps its Host-owned lifetime, and the Host's own
  cancellation still classifies it (never a fabricated settlement, never a user
  cancel). Continued entries keep their existing authority-driven drop (same
  reconcile);
- the renderer-facing presenter gained `withdrawQuestionPresentation(lifetime)`
  (the TSP seat implements it; the PiTui adapter is deliberately inert, exactly
  like `withdrawPending` — the app's own session-switch/disposal contract owns
  that branch). The TSP seat withdraws the slot from the seat (never rendered,
  never answered, keys no longer consumed, the input seat released) while KEEPING
  the slot owned with its abort listener attached, so the Host's cancellation
  settles that same promise and a surface teardown still settles it exactly once.

THE WITNESSES (all real runner + real TSP pane + real Session gate/core/retirement;
the HOST BACKEND stand-in is the suite's existing one — `fakeSession`/`fakeAgent`
(with the `whenIdleGate` busy window) behind the fake `persistence`/
`sessionQuery`/`agents`/`sessions`/`agentDefaultModel`/`llm`/`commands` services —
plus the official interaction plane (`userQuestions` + `sessionProjections` + the
`approval/request` waterfall) provided through the same Cordis path):

1. ordinary `/new`: A's live Question is unanswered, the real `/new` parks in its
   pre-commit quiesce (`idle:A` on the real retirement log), B is neither created
   nor published, A is neither cancelled nor disposed, A still owns the presented
   Session and the modal seat; the REAL answer on the pane resolves the ORIGINAL
   official sink, which idles the Agent and lets the SAME transition commit B and
   retire A. The registered command entry drives it (the modal seat legitimately
   owns every key while the form is up — the composer cannot submit `/new` then);
2. `/fork`: at B's own publication frame no modal is presented, and the assertion
   runs while A's request is STILL PENDING (the test holds the Host's cancellation
   completion, never the abort); the real post-`command/done` retirement then
   cancels A exactly once and the completed cancellation ends the request as
   exactly `ASK_ABORTED` (never a user cancel, never an answer); a Question
   arriving for B takes a FRESH seat identity and answers into ITS OWN request;
3. a real publication withdraws a MOUNTED continued form: the form is mounted
   through the real `Alt+Q` list + reopen, the replacement Session is published by
   `/new`, and at B's publication frame the form is gone, the replaced subject's
   parked count has left the dock, the Host's call is untouched and no answer was
   dispatched;
4. switch away and BACK (the restore half): the TSP renderer has NO session picker
   in this build (its `/sessions`/`/resume` overlay requires the PiTui app), so
   the switch-away/return half runs on the PiTui mount, whose `/resume` picker IS
   production-complete. A's continued entry leaves the presentation on the switch
   to B and is RESTORED from the official projection on the return to A, with no
   official answer dispatched in either direction.

DISCRIMINATION (each mutation applied alone, its witnesses re-run, the tree
restored byte-identically):

- seat: dropping the withdrawn slots from the teardown drain turns the new
  seat-level witness RED (`PENDING` — the promise would have been leaked);
- controller: removing the live-flow withdrawal from `reconcile()` turns witness
  (2) RED while (3) and (4) stay green — the split proves the two mechanisms are
  independently witnessed;
- runner: removing the published-session hook turns witnesses (2), (3) and (4)
  RED while witness (1) stays green — the pre-publication half (the quiesce MUST
  NOT change ownership) is unaffected by the withdrawal.

ROUND 6 CLOSED THE REVIEW'S THREE GAPS (see the round-6 section below): the
claim-opening remount (F7), the withdrawal's fatal exit (F8) and the approval
prompt's presentation currentness (F6, with the Session identity derived from the
official request's OWN Agent — never fabricated). Round 7 then closed the two
currentness defects that re-review found in that implementation (F9 shared-scope
identity collision, F10 late admission).

### Round 6 — the B3-5 findings (F7 claim opening, F8 fatal exit, F6 approvals, corrections)

The B3-5 review returned request-changes with 0 P0 / 0 P1 and three open P2. It
accepted the round-5 Question witnesses as production-path proof and named three
gaps; each is fixed at its root cause with a witness that fails on the pre-fix
code.

F7 — a flow whose timed CLAIM WAS STILL OPENING could still be mounted into the
replacement. The live-presentation intent was registered only after
`claimTimedWait` returned, so a publication landing during that await could not
retire it, and the flow then asked and mounted in B. Fixed in two halves: the
controller registers the presentation INTENT BEFORE any await (and the disposed
guard moved inside the settle region, so the registry has ONE lifecycle), and the
seat remembers a lifetime retired before its slot existed (`retiredLifetimes`) —
the form is never mounted for it, while the promise and its abort listener stay,
so only the request's OWN lifetime settles it. Witnesses: a held-claim
controller + real-seat witness (the retirement happens during the await, it names
exactly the lifetime the presenter later received, no mount after the claim
lands, no fabricated settlement, no revival on the return to A, and the Host end
still classified `ASK_ABORTED`) and a seat-level witness (a retired lifetime
never mounts a question form or an approval prompt).

F8 — a WITHDRAWAL whose frame/focus commit failed bypassed the renderer's fatal
sink: the slot had already left the seat while the error escaped into the
publication/reconcile call stack. The withdrawal now routes that failure through
the SAME fatal path as a failing presentation or settlement (`onFatal` with the
original error, non-truncating) and still settles nothing itself — the fatal
lifecycle and the surface release owner own the rest. Witness: a seat witness
that injects a throwing frame during a withdrawal and asserts the sink received
the original error while the request stayed pending and its own lifetime ended it.

F6 — an approval prompt was not withdrawn at publication because the port's
approval shape carried no Session identity. The official request DOES carry its
own Agent, so nothing is fabricated: `ApprovalRequestLike` gained an optional
`sessionId` derived by the Direct adapter from that Agent, the interaction owner
keeps the same live-presentation registry for approvals, and the SAME publication
seam (`reconcileInteractionPresentation`) withdraws a replaced subject's approval
presentation while the official request keeps its own lifetime. Witnesses: a
production-path witness (a live approval for A, a real `/fork` publishing B, no
prompt at B's publication frame while the held Host cancellation has not
completed, then the completed cancellation settling it exactly `cancelled` —
never an allow, and B's own approval taking a fresh seat) plus a seat witness.
`test/interaction-port.test.ts` now asserts the adapted shape carries the Session
IDENTITY and still no Agent object.

CORRECTIONS FROM THE SAME REVIEW:

- the seat suite's listener-identity recorder read `args[0]` (the event TYPE
  `'abort'`) instead of `args[1]` (the listener), which made the identity
  comparison vacuous; it now records and compares the real listener;
- the PiTui presenter comment claimed the app's session-switch tears down a live
  editor flow, which the round-5 witness does not prove; the comment now states
  only the actual contract (PiTui keeps its long-standing behavior and this slice
  changes nothing there);
- the witness section now names the WHOLE existing Host backend stand-in
  (`fakeSession`/`fakeAgent`/`whenIdleGate` behind the fake
  persistence/sessionQuery/agents/sessions/commands services) instead of only the
  interaction plane.

DISCRIMINATION FOR ROUND 6 (each mutation applied alone, the tree restored
byte-identically): registering the presentation after the claim await turns the
held-claim witness RED; removing the withdrawal's fatal routing turns the F8
witness RED (the error escapes rather than reaching the sink); disabling the
approval withdrawal turns the production approval witness RED on exactly the
publication-frame assertion.

### Round 7 — the B3-6 findings (F9 per-request identity, F10 admission currentness)

The B3-6 review re-verified F7 and F8 as closed and accepted the Agent-derived
approval identity, then returned two more reproduced currentness defects in the
same implementation. Both are fixed at the algorithm, not by widening the sweep.

F9 — a BORROWED cancellation scope is not a per-request presentation identity.
The registry and the seat were addressed by `req.signal`, but the official
request only promises that the signal controls cancellation: two legal approvals
may share one caller scope. The key then collided (only one of the two was
withdrawn, and the seat PROMOTED the other into the replacement), and the first
request's settlement deleted the shared key, erasing the still-pending second
request's registration entirely. Fixed by deriving a PER-REQUEST lifetime
(`AbortSignal.any([req.signal])`, or a fresh never-aborting signal when the Host
gives none) — every presentation is separately addressable while the borrowed
abort semantics are preserved exactly. Witnesses (real surface runtime + real
seat + real Direct port): two approvals sharing one scope are BOTH withdrawn at
publication (nothing is promoted), and answering the FIRST does not erase the
SECOND's registration (the later publication sweep still finds it). The Question
flow did not share the defect: the controller's combined local+request signal is
already unique per flow.

F10 — the publication sweep only covered registrations that EXISTED when it ran.
A legal upstream waterfall middleware may await before calling `next`, so a
request that started while A was still the owner can reach the answerer after B
was published (A's cancellation not yet completed) and was admitted and mounted
into B. Fixed with an ADMISSION currentness recheck at both entry points, using
the SURFACE's own authority — the Session it currently shows OR a Session it is
currently OPENING (a tentative opening is not an owner replacement, so its
request is still admitted, and the pre-commit quiesce still leaves the outgoing
owner's flow mounted). A stale admission presents nothing: the approval path
answers the fail-closed `cancelled` only when the Host's own lifetime ends, and
the question path waits on its own lifetime so the ordinary catch still
classifies the Host's end (`ASK_ABORTED`). A stale timed flow never even takes a
Host claim. Witnesses: the production-path approval race (an upstream middleware
holds A's request across a real `/fork`, the request is released after B's
publication, nothing is ever mounted, the held Host cancellation then settles it
`cancelled`, and B's OWN approval is answered `allowed-once` as the positive
control) and the question sibling on the real surface runtime.

SMALL ITEMS FROM THE SAME REVIEW (also fixed): the owning contract's rule 10 now
names the current member (`withdrawPresentation`); the held-claim unit has a
fallback release in its cleanup and observes its outcome from creation; the F8
unit asserts the injected error by IDENTITY and that the request was still
pending immediately before its own abort.

DISCRIMINATION FOR ROUND 7 (each mutation applied alone, the tree restored
byte-identically, verified with `sha256 -c`): reverting to the borrowed shared
signal turns BOTH F9 witnesses RED (the queued prompt survives the sweep / the
settled first registration erases the second); making the admission authority
permissive turns BOTH F10 witnesses RED (the late request mounts into the
replacement).

### Round 8 — the B3-7 findings (F11 refused-admission ownership, F12 opening consistency, F13 scoping)

The B3-7 review closed F9/F10 and returned three more reproduced defects in the
same implementation. Each is fixed where the ownership or the policy actually
lives.

F11 — a REFUSED admission was an unowned waiting promise. The stale-admission
path returns before the seat or the live registry ever sees the request, so
nothing in the teardown chain ended that wait: it stayed pending until the Host's
own abort, and for the official OPTIONAL signal case (where this owner creates the
lifetime itself) it could never end at all. The wait is now registered with its
OWNER (the interaction runtime) and drained in its disposal batch exactly once,
with the borrowed Host listener detached; a signal-less refusal is drained the
same way. Witnesses: a refused admission is drained by `surface.dispose()`
(`cancelled`, the listener count on the borrowed signal drops to ZERO — read with
`getEventListeners`), a repeated dispose is inert, and the signal-less variant is
drained too, while the orthogonal assertion that a refused admission does NOT
settle early is kept.

F12 — admission and retirement disagreed about an OPENING target. The admission
authority admits a Session the surface is showing OR OPENING, but the continuous
retirement still compared against `currentSessionId()` alone, so the next ordinary
event-driven reconcile withdrew a legitimate opening target's flow (and an opening that was rolled
back was only retired at the next publication). Both sweeps (the Question flows
and the live approvals) now use the SAME authority, and the ordinary event-driven
reconcile runs the WHOLE presentation pass, so admission and retirement can never
disagree. Witness: an opening target's flow is admitted, survives the ordinary
reconcile, and is retired when the opening is rolled back (the journal cleared
without a publication) — with its own lifetime still the only thing that settles
the request.

F13 — the new policy reached the DEFAULT branch. The admission predicate was wired
without a renderer distinction, so the default PiTui branch (and the SDK-declined
PiTui fallback) stopped forwarding a late foreign-session request to the app — a
behavior change this slice was never authorized for. The policy is now enabled
ONLY for a renderer-OWNED presentation (the TSP mount, set at `start()` from
`deps.renderer`); the PiTui branch answers `true` unconditionally and keeps its
original delegation semantics. Witnesses: a production-path PiTui control (a
foreign-session approval request is still forwarded to the real app presenter) and
the renderer-owned contrast already asserted by witness (6).

A WITNESS LESSON WORTH RECORDING (found while verifying round 8's own guard): the
first version of the F12 witness asserted "the opening target still owns its form"
IMMEDIATELY after the reconcile, so a *later* withdrawal frame satisfied both that
assertion and the rollback assertion — the witness passed even with the sweep
mutation applied. It now waits for any coalesced frame to land and then asserts
the AUTHORITATIVE negative (no `del layer.modal-*` op exists at all), which is what
makes it fail under the mutation.

SMALL ITEM FROM THE SAME REVIEW: the question late-admission witness (round 7) had
a held middleware whose release lived only on the happy path and used a fixed
50 ms wait; it now records the REAL admission (the instrumented listener
invocation) and asserts on that. The SAME hardening was applied to the
production-path twin; the unit-suite holds (this witness and the two round-8
refused-admission witnesses) kept a happy-path-only release in that round — the
round-9 review caught exactly that, and all three now release in their cleanup
with the hold declared where the cleanup can see it.

DISCRIMINATION FOR ROUND 8 (each mutation applied alone, the tree restored
byte-identically, `sha256 -c` verified): removing the refused-admission drain turns
BOTH F11 witnesses RED; reverting the sweeps to `currentSessionId`-only turns the
F12 witness RED on exactly "the ordinary reconcile committed NO withdrawal frame
for the opening target"; applying the policy to the default branch turns the F13
PiTui control RED.

### Round 9 — the B3-8 findings (F11 closed-owner window, F14 real producer, hold hygiene)

The B3-8 review closed F12's predicate root cause and F13, kept F11 open for one
more lifecycle window, and found that the new admission policy had no PRODUCER on
the real opening-rollback path. Both are fixed where the lifetime/authority
actually changes.

F11 (closed-owner window) — the approval answerer had no admission fence of its
own: a request held by a legal upstream middleware could arrive only AFTER the
surface (and the interaction owner) had ended, and it then registered a refused
wait that nothing could drain — permanently pending for the official OPTIONAL
signal shape. The answerer now takes the SAME fail-closed cancellation its sibling
answerers answer in that window (`ended || isCleanedUp()`), so a post-end arrival
never registers anything; the owner's disposal latch is also explicit and a second
disposal is inert. Witness: the DECLARED one-sided backend stand-in — this suite's
fake Host service plane, whose listener chain the harness invokes DIRECTLY, with no
Cordis dispatch anywhere in the witness — holds a NON-admissible request across
`surface.dispose()` + `whenRendererReleased()`, and both the signal-bearing and the
signal-less shapes are settled `cancelled` with no borrowed listener attached and
no unowned pending promise. Its qualification is therefore exactly the accepted L6
one (stand-in boundary + real Surface runtime / Direct port / Question controller /
TSP seat): NO real-Cordis post-dispose witness exists, and the real
`ctx.on`/`ctx.waterfall` plane is exercised by the separate PRODUCTION-path
witnesses of the navigation suite (C1–C3, C5/F6, F10(6), F13, F14(7)) — those are
their own witnesses and are NOT spliced into this one's provenance.

F14 (real producer for the opening authority) — the new `isAdmissibleSession`
policy consumed `openingJournal.isOpening`, but NOTHING called the presentation
pass when that authority actually changed: `clearOpening`/`resetOpening` only
mutated the journal, so a rolled-back target's modal survived on the surface
(there is no periodic reconcile — the pass runs at a publication or on an
event-driven activity reconcile, and a rollback may produce neither). The runner's
own opening seams now run the FULL pass after clearing/resetting the journal
(the token identity contract is unchanged), which covers every rollback caller in
the session runtime. Witness: a REAL `/new` whose Host create fails inside the
opening window (the test discovers the target id from the production create call,
delivers the target's own Question AND Approval during that window, then lets the
create fail) — the rolled-back target's presentation leaves the surface with no
session event, no manual reconcile and no other presentation trigger, while both
official requests keep their own lifetimes and settle only when the Host ends them
(`ASK_ABORTED` / `cancelled`).

WITNESS-QUALITY NOTES FROM THIS ROUND (both found while verifying my own guards):

- the first post-dispose F11 witness used the SHOWN session id, so the request was
  admissible and the seat's own disposed guard answered `cancelled` — the witness
  passed even with the owner fence removed. It now uses a NON-admissible session
  so it exercises the refused branch, and it fails under the mutation.
- the F14 witness's assertion needed one neutral terminal event to let the
  already-committed frame land: the SCRIPTED pane's SDK loop advances on terminal
  input (the same withdrawal lands unpumped in the L6 harness, and the real pane
  paints continuously), so the pump is a harness fact, never a presentation
  trigger — and the witness still fails when the producer is removed.

SMALL ITEM FROM THE SAME REVIEW: the three unit-suite held middleware releases now
have fallback releases in their cleanup (with the declarations hoisted so the
cleanup can see them), and the round-8 over-claim about that hygiene was corrected
above.

DISCRIMINATION FOR ROUND 9 (`sha256 -c` verified restores): removing the
closed-owner fence turns the post-dispose F11 witness RED; removing the two
opening-authority passes turns the F14 rollback witness RED ("timed out waiting for
the rolled-back target's presentation left the surface").

### Round 10 (doc/comment only) — provenance correction

No code changed. The round-9 F11 post-dispose witness was described as "a real
Cordis middleware"; it is not — it wraps this suite's fake Host service plane and
its listener chain is invoked directly, with no Cordis dispatch (the real
`ctx.on`/`ctx.waterfall` plane belongs to the separate production-path witnesses of
the navigation suite). The document, the owning contract's evidence pointer and the
witness's own comment now state the accepted L6 qualification instead, and the
owning doc's pointer was extended to the existing rounds 5–9. Nothing else in the
delivery was touched, so no code lane needed re-running for this delta.

### Round 11 — the external review of PR #265 (P2-1, P2-2, P3)

The first independent review of PR #265 confirmed the architecture (single modal
seat, real currentness producers, presentation-only withdrawal, input/focus
ownership, the Question form semantics and the test coverage) and returned
request-changes with two uncovered P2 lifecycle gaps plus one P3. All three are
fixed at the root cause with a witness that fails on the pre-fix code.

P2-1 — a LATE continued offer could remount the replaced subject's Question. The
  `awaitContinued` poll only checked `disposed`, so a timed call whose official
  `continued` projection became visible AFTER a replacement was published would
  `ensureEntry` + `mountEntry` into the replacement's seat. Every async resume of
  that offer now re-checks the SAME admission authority the reconcile uses and
  stops the local offer when the Session is no longer admissible — the official
  `continued` call stays exactly as answerable as the Host made it (no fabricated
  settlement, no Host write).
P2-2 — a request with NO official cancellation lifetime could stay pending until
  the whole TUI exited. Both official request shapes have an OPTIONAL signal; when
  it is absent, this owner creates the lifetime, so the replacement is the only
  owner that can end such a request. The presentation retirement now settles
  exactly that KIND of request — the Question flow as `ASK_ABORTED` (a
  session-driven end, never a user cancel) and the approval as `cancelled`
  (fail-closed, never an allow) — while a request that DOES carry a Host signal
  keeps the Host's own settlement right (the retirement never settles it). The
  owner also detaches its derived lifetime/listener on the way out.
P3 — the transient Alt+Q list could cross a Session hydration. A newly committed
  owner now closes it (`TspInteractionSeat.closeTransientList`, called from the
  renderer's hydration seam), so the replacement inherits neither the list nor its
  keys; its rows are re-read fresh from the authority the next time it opens.

WITNESSES (each fails under the matching mutation): the P2-1 L6 witness (a timed
foreground wait times out, the replacement is published, A's projection THEN
becomes `continued`, several offer cycles pass) asserts no overlay appears and the
official call is untouched; the P2-2 L6 witness presents a signal-less Question AND
a signal-less Approval, replaces the Session and asserts both settle
(`ASK_ABORTED`/`cancelled`) with no stale slot; the P2-2 PRODUCTION witness does the
same through a real `/fork` (no Host signal at all) and asserts the replacement's
own publication frame presents nothing of the replaced subject; the P3 production
witness opens the real Alt+Q list, drives a real `/new` and asserts the list did
not cross the replacement and the caret went back to the composer; a seat unit
witness asserts the closed list consumes no keys.

DISCRIMINATION FOR ROUND 11 (`sha256 -c` verified restores): removing the
continued-offer admission check → the P2-1 witness RED ("the late offer never
mounted into the replacement"); removing the Question's signal-less retirement →
the P2-2 L6 witness RED; removing the approval's → the P2-2 production witness RED
("timed out waiting for both signal-less requests settled"); removing the hydration
close → the P3 production witness RED ("the transient list must not cross the
replacement").

### Round 12 — the external review's second round (P2-A late admission, P2-B publication window)

The second external round confirmed the round-11 fixes (the late continued offer,
the registered signal-less settlement, the transient list) and returned two more
boundaries. Both are fixed at the root cause, each with a witness that fails on the
pre-fix code.

P2-A — a request that is ALREADY inadmissible when it reaches the answerer (a legal
  upstream middleware delayed it past the replacement) had no later retirement
  event to wait for: with no Host lifetime it stayed pending until the whole TUI
  exited. It now settles AT ADMISSION — Question `ASK_ABORTED`, approval
  `cancelled` (fail-closed) — while a request that carries a Host signal keeps the
  Host's own settlement right. The round-11 F11 expectation for the signal-less
  shape is updated accordingly (it is no longer teardown-only).
P2-B — the presentation-currentness withdrawal ran only at `initLiveSession`,
  i.e. AFTER the post-commit phase (`whenIdleOrAbort`, hydration is later): between
  the owner publication and that initialization the replaced subject's modal could
  still own the seat and accept its keys through the modal-first routing. The
  withdrawal now ALSO rides the SYNCHRONOUS publication commit — immediately after
  `setCurrentOwner`, in the same commit section as the outgoing-draft drop, for the
  ordinary transition, the fork adoption and a resume — so the seat is released
  before any post-commit await. That half is state-only and non-throwing: it reads
  no Host state, drops the replaced subject's mounted continued entries, settles
  the signal-less flows by the P2-2 rule and closes the renderer's transient list,
  with any renderer frame failure routed to that renderer's fatal sink (the
  park-count projection got the same guard). The full pass still runs at the
  hydration seam and on the event-driven reconcile.

WITNESSES: (P2-A) both kinds held upstream and released only after the replacement
was published settle at admission with NO surface teardown, while a positive
control proves the surface still serves its current subject; (P2-B) a REAL
publication through a real command (`/fork` AND `/new`) with the child's post-commit
quiesce HELD and the Host cancellation of the replaced owner ALSO held, so both of
its requests are still in flight when the witness observes the window: the modal has
already left the seat, and `y`, Enter and Esc can no longer answer either request
(they belong to the composer and, for Esc, to the application's own cancel intent).

DISCRIMINATION FOR ROUND 12 (`sha256 -c` verified restores): removing the
commit-time withdrawal from EITHER publication site turns the P2-B witness RED
("timed out waiting for the replaced modal left the seat AT publication"); removing
either kind's admission settlement turns the P2-A witness RED.

### Round 13 — the external review's third round (P2-C: the commit half must be state-only)

The third external round confirmed the round-12 fixes and found that the new
commit-time half was not actually state-only: the controller's commit method
notified attention, which republished the count through
`InteractionRuntime.publishAttention` → `QuestionController.attentionRows` →
`DirectInteractionPort.snapshot(sessionId)` → the official
`sessionProjections.stateOf(...)` read — a HOST READ inside the synchronous
publication commit, placed before the commit bookkeeping that follows it
(`transitionCommitted` / `forkCommitted` / `committedNavigation`). A throwing
projection read there would therefore strand exactly that bookkeeping even though
the owner was already published.

FIX (no new authority, no Session-ownership move): the commit-time method now
returns whether anything left the model and does NOT notify attention; the caller
clears the STALE displayed count locally (`setQuestionAttention(0)`) and the full
reconcile — hydration or the event-driven activity pass — republishes the
authoritative count for the new owner. It remains a no-op on the default PiTui
branch, because `dropped` can only be true where the renderer-owned admission
authority applies.

WITNESS: a real publication with a MOUNTED continued form for A (so the drop has
real work to do, which is exactly the path that used to publish attention) while
the child's projection read is ARMED to throw before the commit: the witness
asserts the commit performed NO `userQuestions` read for the new owner, that the
armed read never fired, that the replaced continued form left the interactive seat
in the publication window, and that the transition then completes with the new
owner published and the replaced owner retired exactly once.

DISCRIMINATION (`sha256 -c` verified restore): restoring the commit-time attention
notify turns the witness RED with the exact production symptom —
`transition commit seam failed after publication (child committed) …
the armed projection read fired …` — plus the zero-read assertion failing.

### Round 14 — the external review's fourth round (P2-D: atomic multi-modal withdrawal)

The fourth round confirmed rounds 11–13 and found the last presentation defect: the
replaced modals were withdrawn ONE AT A TIME. The seat's withdrawal removes the
active slot and then `promote()`s the next queued one, so with two replaced
requests (the first active, the second queued) the first withdrawal promoted and
RENDERED the second — a replaced modal painted under the already-published
replacement — before the second withdrawal removed it. The intermediate frame's
emission depends on SDK flow control, so the defect is not always visible on the
wire, but the promotion itself is deterministic.

FIX: the withdrawal is now an ATOMIC BATCH. The controller COLLECTS the
inadmissible live-flow lifetimes (state-only, no presenter call, no Host read) and
returns them; the interaction owner collects the approval lifetimes as well and
hands the whole set to the renderer in ONE `withdrawPresentations(lifetimes)` call
which removes every member of the batch FIRST, then picks the successor and commits
ONE layer/focus frame. No member of a batch can be promoted or painted in between,
and a successor (for example the replacement subject's own queued request) takes
the seat in that same frame. The commit-section half keeps every earlier property
(no Host read, no attention notify, a local stale-count reset).

WITNESSES: a seat-level witness drives a batch of two replaced approvals with a
successor already queued and asserts that the batch commits EXACTLY ONE frame, that
the frame contains no member of the batch, and that the successor appears in that
same frame; a production-path witness on the real surface runtime records the
presenter's call SIZES and asserts the publication handed ONE batch of two (never
one call per modal), that no intermediate overlay was added, that both replaced
requests settle only through their own lifetimes and that a successor queued
afterwards takes the seat.

DISCRIMINATION (`sha256 -c` verified restore): reverting the interaction owner to
one presenter call per lifetime turns the production witness RED on exactly "the
publication handed the renderer ONE batch with both replaced prompts" (and the
seat-level witness stays green, because it guards the seat's own batch semantics —
the two witnesses cover the two halves).

### Round 15 — the external review's fifth round (P2-E: settle AFTER the batch)

The fifth round confirmed round 14 and found the ordering twin of the same defect:
the batch API itself was correct, but the callers ran their local settlements
BEFORE calling it. An active signal-less approval's `retire()` aborts its lifetime,
whose abort listener settles that slot SYNCHRONOUSLY — and the seat's settlement
promotes the next queued slot and renders it (a replaced modal painted under the
already-published replacement) before the batch ever runs. The same held for the
mounted continued forms, whose `removeEntry` aborted their mount controller while
other replaced slots were still in the seat.

FIX: the publication pass is now three SYNCHRONOUS steps with no await anywhere:
(1) COLLECT — the controller and the interaction owner take every replaced
presentation out of their models and return the lifetimes to withdraw plus the
DEFERRED local settlement (the signal-less flows' retirement and the mounted
continued forms' mount aborts), aborting nothing; (2) WITHDRAW — one batched
`withdrawPresentations(lifetimes)` call takes every replaced slot out of the seat
and commits ONE layer/focus frame; (3) SETTLE — only then do the deferred aborts
run, and because their slots already left the seat, a settlement can no longer
promote (or paint) a replaced slot. Host-owned requests are untouched throughout:
the batch never settles them, and their `ASK_ABORTED` / `cancelled` classification
is unchanged.

WITNESSES (both on the real surface runtime, with the SESSION's own rendered `layer`
regions recorded — the deterministic observation the wire cannot give, since SDK
flow control may coalesce an intermediate frame away): (a) a signal-less ACTIVE
approval plus a signal-bearing QUEUED one; (b) a MOUNTED continued form plus a
queued approval. Each asserts that NO frame of the publication presents a replaced
modal, that the publication handed the renderer ONE batch of two, that the
signal-less request is settled by its owner while the Host-owned one is untouched
until the Host ends it (and that the dropped continued form sent no late answer),
and that the replacement's own input still works.

DISCRIMINATION (`sha256 -c` verified restore): running the settle step BEFORE the
batch turns BOTH witnesses RED on exactly "no frame of the publication presents a
replaced modal" / "…the mounted continued form or the queued replaced approval".

### Round 16 — the external review's sixth round and its acceptance

The sixth external round fixed the last presentation regression and then reviewed
the rebase:

P2-F — the ORDINARY activity reconcile closed the renderer's transient Alt+Q list.
  Reusing the publication withdrawal there meant any ordinary `model/selection`,
  tool or message event of the SAME session closed the list the user had just
  opened (no publication, nothing replaced). The transient-list policy is now
  explicit: the ordinary activity pass may withdraw replaced requests but never
  touches the list; a real owner publication (the synchronous commit section) and
  the publication/authority-change hydration seam still drop it, because the list
  belongs to the subject that opened it. Witnesses: the same session opens Alt+Q
  and then receives an ordinary `model/selection` event — the list stays open and
  Enter still reopens the parked question; the negative control is the existing
  production witness (a real `/new` must close it). Making the ordinary pass close
  the list turns the new witness RED.

REBASE: the branch is based on `next` @ `d08e666c` (17 upstream commits: the
TPS/TTFB Host-projection ownership change, the transcript Activity-lifetime fixes,
the viewer/UX fixes). The rebase applied without conflicts; because `next` added a
runtime dependency, the worktree was re-bootstrapped (`pnpm dev:bootstrap` →
`dev:doctor` READY) and rebuilt.

THE "DOUBLE SEND" SEMANTICS, confirmed on the rebased tree (22 suites, 679 pass /
0 fail) — three independent guards, not one test counted twice: the TSP
committed-prompt witness (exactly ONE prompt occurrence reaches the writer through
the real `SubmissionController` + Direct writer), `B2: an accepted submit leaves an
empty composer, so a second Enter cannot double-send`, and `B1/L2/P3: one accepted
edit calls Surface.render exactly ONCE` — plus `test/submit-hot-path.test.ts`,
`test/tern-tsp-submission.test.ts` and `test/tern-tsp-editor-input.test.ts`, with
the upstream draft-safety guard and `session-presentation-lifecycle` covered by the
full product suite.

ACCEPTANCE: the sixth round's verdict is **code-level accepted with zero open
P0/P1/P2**; its only remaining item was documentation (the stale refused-admission
contract in the owning rule, this document's F6 status and the missing rounds 5–6
history), corrected here. B4 keeps the IME / physical-paste / control-key matrix
and is not pulled into this PR.

---

# B4 — end-to-end real-pane qualification

> This chapter is the B4 acceptance record. It does not re-close B0–B3 (their
> history and evidence above are unchanged). Every case below states its EVIDENCE
> TIER: `real pane` (Tern GUI + real Direct Agent), `real SDK + scripted tty`
> (the production runtime driven by a scripted terminal) or `production harness`
> (the real application owners driven without a pane). A physical input that could
> not be produced records `N/A_WITH_REASON` or `BLOCKED`; scripted evidence is
> never presented as physical.

## Frozen qualification identity and environment

| Item | Value |
|---|---|
| Baseline | `next` @ `8d5f1adc` (branch `feat/tern-tsp-pr3-b4-qualification`, rebased onto the merged B3 `next`) |
| Packed artifact | `xmoon76-dsh-pi-tui-0.5.1.tgz`, sha256 `09a57d875c1dc1abdbfd7d6a25cf12384e63fd52af432accca5c1c68a786f8ca` — every case below ran against this artifact |
| Test profile | throwaway `b4-qual` (never the real `pi-tui` profile): `commandcode` / `deepseek/deepseek-v4.1-flash` / effort high (the owner's model), `workspace-write` + `approval: ask`, the OFFICIAL standard preset plugin list with only `tool-ask-user` extended to `mode: timed, timeout: 15`, `busyEnter: steer` (switched to `queue` for the second busy round) |
| Harness | `DSH_PI_TUI_RENDERER=tsp`; `TERN_TSP_RECORD` for wire evidence (synthetic data only); `TERN_TSP=0` / no opt-in for the negative controls |
| Real pane | Tern GUI `0.7.0` (the SDK handshake records `term: tern`, `ver: 0.7.0`); SDK `@stencil-hq/tern@0.1.0` |
| Agent environment | headless tty (no `DISPLAY`/`WAYLAND_DISPLAY`, no input-method daemon): the physical qualifications are executed by the Owner on a real GUI, per B1 Owner Amendment A1 |

## §6.4 mandatory real-pane smoke — final status

| §6.4 | Case | Status | Tier | Evidence / notes |
|---|---|---|---|---|
| 1 | Real pane mount, SDK selected, one tty owner, editable focus | DONE | real pane | The dock renders `DSH TSP renderer · experimental composer`; the editor accepts input; wire handshake ok |
| 2 | English/CJK/emoji, real IME, real multi-line paste, `Shift+Enter`, `q` | DONE | real pane | Real IME candidate/commit; grapheme move/delete across CJK and emoji; the physical paste arrived as ONE atomic editor update (newlines preserved, `/exit`-looking lines were CONTENT) and the following `Enter` produced exactly ONE submission with nothing executed; `Shift+Enter` newlines; `q` inserts text |
| 3 | Plain prompt → real Direct backend, Assistant streaming, real tool/call → result | DONE | real pane | Real `bash` calls with authoritative results (`touch` + `ls` visible with `exit=0`; a missing path with `exit=2`); streaming in the same session |
| 4 | Running-state `Enter` / `Ctrl+Enter` against the configured busy policy | DONE | real pane | Under `busyEnter: steer`: `Enter` steered (`[1] you (steering…)`) and `Ctrl+Enter` queued (`queued (followup)`); under `busyEnter: queue` the two gestures swap exactly as the contract states; the pending echo was visible and no submission appeared twice |
| 5 | `/exit`, `/quit`, `!`/`!!`, `/settings`, Host-origin same-spelling | DONE (Host-origin N/A_WITH_REASON) | real pane (+ automated origin coverage) | `/exit` and `/quit` exited normally with no prompt submission and a normal close; `!echo hi` / `!!echo hi` produced the existing shell refusal (`User-shell UI is not available in TSP yet`) with the draft restored and NO shell execution; `/settings` produced `This command's UI is not available in TSP yet` with the draft kept; no Host declaring a same-spelling command exists here, and the origin precedence is covered by the production-path admission witnesses |
| 6 | Genuine Question single/multi/free-text/masked, timed → continued → `Alt+Q` → late answer | DONE (masked N/A_WITH_REASON) | real pane (+ automated masked witnesses) | Multi-select with the Review page, free-text, and the full timed chain: a genuine 15 s claim → dock `Continued questions: 1 · Alt+Q` → the official `{"pending":true,…}` continuation → physical `Alt+Q` opened the transient list → `Enter` reopened the same question → the late answer was settled by the official controller (notices `A reply for this question is already queued…` / `This question is no longer awaiting an answer.`) → the official `user-question-reply` carried the same `callId`. **masked**: the agent tool's schema has no `masked` field (an extra `masked: true` was ignored and rendered plain) and the only producer, the builtin masked prompt (`/auth`), is not a TSP-reachable command — the renderer's masked behaviour is covered by two witnesses instead (edit page and Review page; plaintext never reaches the wire) |
| 7 | Genuine Approval `y`/`n`/`Esc`/`Ctrl+C`, repeat after settle | DONE | real pane | Four `Approval required` modals: allowed (the command really ran), cancelled and rejected (the tool results carry `cancelled` / `the user rejected … it stays denied`), plus a Question cancel; no second settlement or replay after a decision; a non-empty composer draft survived an approval unchanged |
| 8 | Rebind/Session switch, exit/error, terminal restore | DONE (publication via production harness) | real pane (exit/restore) + production harness (publication) | `/new` and `/fork` are NOT TSP-reachable (`This command's UI is not available in TSP yet`), so the whole owner-publication family — a live Question blocking B's publication, the publication-frame withdrawal, the old request settled by its own lifetime, old keys unable to answer — is proven by the production-harness witnesses listed below; the real pane itself proved exit and terminal restore |
| 9 | Non-TSP tty / `TERN_TSP=0` / no opt-in → real PiTui mount | DONE | real pane + automated | Both negatives (`TERN_TSP=0` with the opt-in present, and no opt-in at all) fell back to a fully normal PiTui; the SDK-decline, no-probe and no-output-gate-suspension assertions are covered by the automated lanes |

## B-01..B-09 gates

| Gate | Status | Basis |
|---|---|---|
| B-01 Editor | DONE | Real IME candidate/commit, grapheme editing, physical paste as one atomic edit — the two B1 Owner-Amendment items for real IME and physical paste are closed |
| B-02 Submit | DONE | Real writer admission, streaming, tool/call→result, one submission per gesture |
| B-03 Busy | DONE | Both busy policies with the exact gesture mapping, the pending echo and no double send |
| B-04 Commands | DONE | `/exit`/`/quit` positive, shell and Client-UI refusals with the draft restored, no Host writes; the Host-origin precedence is covered by the admission witnesses |
| B-05 Questions | DONE (masked N/A_WITH_REASON) | The full official Question lifecycle in a real pane, plus the Review/free-text/multi/cancel variants |
| B-06 Approval | DONE | All four physical decisions, single settlement, no replay, draft untouched |
| B-07 Generation | DONE | The production-harness publication/fork/settle witnesses below, plus the real-pane R1 result |
| B-08 Lifecycle | DONE | Physical `Ctrl+C` interrupt and `Ctrl+D` empty-draft exit in a real pane, exit/restore, plus the automated fatal/HMR/teardown lanes |
| B-09 PiTui | DONE | Both real negative launches plus the automated default-PiTui regression lanes |

## B3-review regressions (extra scenarios, not a substitute for §6.4)

| ID | Scenario | Status | Tier |
|---|---|---|---|
| R1 | An ordinary same-session event must NOT close the `Alt+Q` list | DONE | real pane (a 9-frame list lifetime carried four ordinary streaming events and closed only on the explicit reopen) + the automated `model/selection` witness |
| R2 | A real owner publication MUST drop the replaced subject's list | DONE | production harness |
| R3 | Several replaced modals together must not paint an intermediate old modal | DONE | production harness (per-request identity, atomic batch withdrawal, settle-after-batch, no Host read inside the commit section) |
| R4 | Physical `Ctrl+C` = the existing interrupt/cancel (never an exit); `Ctrl+D` exits only with an empty draft and no modal | DONE | real pane (the interrupted tool kept running the TUI; further input and frames followed before a normal close) |
| R5 | A paste containing command-looking lines stays ONE draft and is never dispatched line by line | DONE | real pane (inside §6.4-2) |

## Automated evidence on the frozen artifact

Green on the frozen identity above (the volatile per-lane counts live in the PR
conversation, not here): `pnpm verify:prepush` (its prepack runs `clean` + `build` +
`typecheck:bundle` + the full product suite; its postpack runs the eight
public-package smokes) and the repository audit, `pnpm compat:dsh:npm`,
`pnpm compat:dsh:client-family`, the nine `pnpm smoke:remote-*` migration probes,
the artifact-dependent `pnpm smoke:boundary` / `smoke:startup-strictness` /
`smoke:official-presets`, and `git diff --check` (unstaged and staged). The B3
review rounds' discriminating witnesses (per-request presentation identity, atomic
multi-modal withdrawal, settle-after-batch, no Host projection read inside the
synchronous commit section, the transient list's scope, masked rendering) all run
inside that product suite.

## Reachability limitations (recorded, not defects)

1. TSP accepts only the TUI-origin builtins `/exit` and `/quit`; `/settings`,
   `/new` and `/fork` are refused with the existing command-UI notice, and an
   unreachable `/name` line (for example `/auth`) is submitted as an ordinary
   prompt. The Session-publication qualifications therefore use the
   production-harness witnesses instead of the pane, exactly as the frozen plan's
   accessibility note requires.
2. The masked question type cannot be produced through the agent tool at all (its
   schema has no `masked` field), so §6.4-6's masked sub-item is
   `N/A_WITH_REASON` with the renderer behaviour covered by two witnesses.

## Known differences and remaining deferrals (owner-decided)

1. The PiTui `Press <key> again to exit` confirmation window is NOT implemented in
   the TSP renderer: TSP exits on a single `Ctrl+D` while the draft is empty and no
   modal is up. Frozen key contract, recorded as a **PR4 UI-parity item**.
2. `Ctrl+C` is not an exit key in TSP: it is the existing cancel/interrupt intent.
   This is a deliberate, frozen contract difference from PiTui and must not be
   turned into an exit later.
3. Native editor chords (`Ctrl+A`, `Ctrl+V`, undo/selection/clipboard) are ignored
   by the controlled composer and belong to the post-PR3-B editor/UX milestone
   (PR4), exactly as the PR3-B contract states.
4. Stage closure still requires the independent review and the owner's explicit
   merge approval; this chapter does not grant either.
