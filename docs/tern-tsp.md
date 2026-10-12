# Tern Surface Protocol (TSP) integration

Long-term entry point for everything TSP-related in `dsh-pi-tui`. It records the
protocol boundary, the current implementation status and its limits, and the
evidence ledger. Per-PR measurements live under
[`docs/tern-tsp/evidence/`](./tern-tsp/evidence/) and are linked, not copied.

## Scope and status

- **TSP is not the Tern Luau plugin API.** TSP (Tern Surface Protocol) is an
  in-band semantic UI protocol: a program running inside a Tern pane sends a
  semantic node tree plus incremental ops, and Tern owns the native layout,
  styling and rendering. The program keeps its own state and input loop.
- **Production default is PiTui.** `dsh --profile pi-tui` renders through the
  vendored PiTui surface. TSP adds ONE experimental internal opt-in
  (`DSH_PI_TUI_RENDERER=tsp`, no profile/setting/command/public CLI): when it
  is set and the official SDK `connect()` succeeds, the Tern TSP renderer owns
  the terminal and, since PR3-B, the interactive editor, submission and the
  official Question/Approval modal seat; `connect() === null` mounts PiTui
  unchanged and a connect throw is a startup failure. Unsupported terminals
  (SSH, tmux, screen, zellij, `TERN_TSP=0`) are declined by the SDK. Default
  environments never load the SDK (lazy import) and `src/startup.ts` stays
  dependency-free.
- **What exists:** PR1 (a standalone opt-in replay spike with a real Tern pane
  smoke), PR2 (an optional read-only projection observer that lets an isolated
  TSP consumer render the live application projection), PR3-A (the single-tty
  read-only TSP renderer mount behind the internal experimental opt-in), PR3-B
  B0–B3 (the display seam, the shared composer/submission and command admission,
  and the unified Question/Approval modal seat with its official lifecycle) and
  **PR3-B B4**, whose end-to-end real-pane qualification is recorded and
  owner-QA-confirmed (see the ledger below). All remain experimental. The one
  B4 item the owner explicitly deferred to PR4 — the masked Question's physical
  qualification — is recorded as deferred below and must not be read as done.
- **PR4-A Model:** the original `/model` handler now has PiTui and native TSP
  presentation adapters implementing the Owner-frozen Model UX (wide B2
  explorer, compact drill-down, K2 keyboard, explicit-apply-only writes, native
  components only). The required native kinds enable only this additional TUI
  builtin; the existing model reads/writes and modal seat remain authoritative.
  The Owner's earlier follow-up revisions added the scope-column click protocol
  and the then-drill-down details/Effort pages, and the Model-UX restructuring
  revision SUPERSEDED that footer and those pages: it removed the global
  `Operation` block, the `Action:` strip, the `More actions` page and the vague
  `Confirm` verb, and replaced them with the three-page
  **Models → Overview → Full details** flow: the wide side column edits one model
  in place (or becomes ONE `Open model & effort ›` entry), every other layout
  opens that model's own Overview — which now carries every Reasoning Effort
  candidate, so the former `Reasoning Effort` page no longer exists — the Full
  details page is read-only, and only the explicitly labelled `Switch` /
  `Save default` action writes.
  See [Model selection](./tern-tsp/model-selection.md) for the behavior,
  ownership, regression coverage and qualification limits, and
  [PR4-A evidence](./tern-tsp/evidence/pr4-a.md) for the durable summary of what is
  certified at which tier and which pitfalls became rules.
- **PR4-A Preset:** the original `/preset` command family now has PiTui and
  native TSP presentation adapters implementing the Owner-frozen Preset UX (one
  compact native picker, Built-in/Custom rows, a read-only Details page,
  independent Current/Next-session/default/Draft facts, two-zone K2,
  explicit-action-only writes). The whole command family rides ONE capability
  behind the same native kinds; every read, write and Config owner stays in the
  original command. See [Preset selection](./tern-tsp/preset-selection.md) and
  [PR4-A Preset evidence](./tern-tsp/evidence/pr4-a-preset.md).
- **As tested, not a compatibility promise:** `@stencil-hq/tern@0.1.0` (npm, a
  runtime `dependencies` entry) against real Tern `0.6.2` (PR1), `0.7.0` (PR3-B
  real-pane runs), `0.7.2` (PR4-A real-pane Model runs) and `0.8.0` (the PR4-A
  real-pane Preset runs). A future SDK or pane version may change any field below.
- **Last verified:** 2026-10-12 (UTC+8) for the PR4-A Preset surface (real-pane
  Preset runs on Tern `0.8.0`) and the PR4-A Model surface (real-pane Model runs
  on Tern `0.7.2`); 2026-10-10 for the interactive (PR3-B) surface; 2026-10-08
  for the read-only PR3-A surface.

| Item | State |
|---|---|
| PR1 replay spike → real Tern pane | DONE (merged, [#256](https://github.com/XMoon/dsh-pi-tui/pull/256)) |
| PR2 live application projection (routed events, production cold hydration, Remote re-window) → isolated TSP surface | DONE (merged, [#257](https://github.com/XMoon/dsh-pi-tui/pull/257)) |
| PR3-A single-tty read-only TSP live mount (experimental opt-in `DSH_PI_TUI_RENDERER=tsp`) | DONE (merged, [#260](https://github.com/XMoon/dsh-pi-tui/pull/260)) |
| B0 display seam / B1 editor+input / B2 submit+command admission / B3 Question+Approval seat | DONE (merged: [#261](https://github.com/XMoon/dsh-pi-tui/pull/261), [#262](https://github.com/XMoon/dsh-pi-tui/pull/262), [#263](https://github.com/XMoon/dsh-pi-tui/pull/263), [#265](https://github.com/XMoon/dsh-pi-tui/pull/265)) |
| B4 end-to-end real-pane qualification (incl. real IME, physical paste, physical control keys) | **Qualification COMPLETE (owner QA-confirmed)** — every §6.4 case and the B-01..B-09 gates are recorded with evidence tiers in [PR3-B evidence](./tern-tsp/evidence/pr3-b.md), together with the reachability limits, the owner-deferred physical masked Question (`DEFERRED_WITH_OWNER` to PR4) and the owner's QA confirmation of the physical-tier items; the independent review of the delta accepted the code/test and its documentation findings were addressed. (The separate B4 `N/A_WITH_REASON` case is an Approval request with no derivable Session identity, not the masked item — see the evidence file.) |

## Upstream protocol and SDK

Authoritative sources (this repository does not reproduce the specification):

- [Tern Surface Protocol overview](https://docs.stencil.so/tern/protocol/index.html)
- [Tern SDKs](https://docs.stencil.so/tern/protocol/sdks.html)
- [SDK source (TypeScript)](https://github.com/stencil-hq/tern-sdk/tree/main/typescript)

What the integration relies on, in the shape the pinned SDK exposes it:

- `connect(options)` probes the terminal (DA1) and returns a session, or `null`
  when the environment is not a supporting pane (non-TTY, `TERN_TSP=0`, tmux,
  screen, zellij). The session enters raw mode for the probe and restores it
  when the handshake fails or the session closes.
- Handshake: the program sends a `q`/`hello` query; the pane answers `r` with
  `term`, `ver`, `kinds`, `features`, `apc`, `credits`, `cols` and cell size.
- Surfaces: `session.open({ mode: 'inline' | 'screen' | 'flow' })` opens one
  surface; `surface.render(view)` sends only the difference from the last sent
  view. Frames (`f`) carry `{ sf, s, ops }` with `add`/`set`/`text`/`splice`/
  `move`/`del`/`settle`/`focus`/`reveal`/`scroll`/`suspend`/`resume`.
- Flow control: at most `credits` frames may be unacknowledged; the pane acks
  with `{ ev: 'ack', sf, s }`. While blocked the SDK keeps the newest view.
- Events from the pane (resize, theme, motion, action/select/activate, edit,
  focus …) are delivered as an async iterable of `SessionInput`.
- Close: `surface.close({ keep })`; the normal path uses `keep: false`. Under
  `SIGINT`/`SIGTERM` the SDK closes with `keep: true` (the pane keeps the last
  `main` in scrollback) and re-raises the signal — see the failure contract
  below.
- `TERN_TSP_RECORD=<file>` records every inbound/outbound JSONL message for
  debugging. **Recordings contain transcript content:** never enable it around
  real user data; the PR1 recordings used synthetic fixture content only.

## dsh-pi-tui ownership boundary

```text
official DSH durable events + transient assistant input
                |
                v
existing SessionPresentation + SurfaceEventRoutingSource
   (session/attachment/currentness/exact-Agent fences)
                |
                v
ONE TranscriptFolder  (canonical fold)
                |
                v
ONE TranscriptWindowController  (the selected window)
                |
                v
SurfaceRuntime.repaintTarget()   -- the ONE projection glue
   |                                    |
   | production                         | optional read-only frame
   v                                    v
TuiApp.setTranscript(...)        onTranscriptProjected (absent in production)
(PiTui, the product)                        |
                                            v
                              experimental TSP consumer (dev/test)
                              projectTranscriptStructure() -> PR1 mapper
                                            -> official SDK Surface.render()
```

- `src/tui/transcript/structure.ts` → `projectTranscriptStructure()` remains the
  ONLY Work/Context/standalone segmentation authority; the TSP mapper consumes
  its blocks and never re-groups rows.
- One fold, one window, one currentness authority. The TSP path adds neither a
  second `TranscriptFolder`, nor a second SessionEvent subscription, nor a new
  Host port, nor a Host service read (`src/app/surface/**` stays Host-free and is
  gate-enforced).
- Locality: the whole path is Client-local presentation. Nothing here reads Host
  cwd/filesystem or Session writer authority.
- `TERM_PROGRAM=tern` handling in `src/tui/terminal/tern.ts` (OSC 7 / OSC 9;4) is
  terminal *specialization* for the Tern terminal emulator. It is **not** a TSP
  capability probe and does not depend on a TSP session; the two are independent.

## Current implementation

### PR1 — standalone replay spike (experimental)

| Path | Responsibility |
|---|---|
| `scripts/tern-tsp-transcript-spike.mts` | Manually runnable: SDK `connect` → one `inline` surface → deterministic replay of genuine `SessionEvent`/live inputs into a `TranscriptFolder` → `n` advances, `q`/Ctrl+C closes with `keep: false`. Direct execution is guarded. |
| `scripts/support/tern-tsp-transcript-view.ts` | Pure `TranscriptStructureBlock[] → native TSP node` mapper, plus `TranscriptNodeKeys`, the replay-local presentation-key allocator. |
| `test/tern-tsp-transcript-spike.test.ts` | 23 tests: canonical projection, mapper nodes, `View.ops` deltas, duplicate-key `ViewError` control, interaction/command/orphan cards, Context bodies, lifecycle and isolation. |

### PR2 — live projection observation seam (this PR)

- `SurfaceRuntimeOptions.onTranscriptProjected?: (frame) => void` is an
  optional, synchronous, read-only observer. The production composition root
  (`src/app/bootstrap.ts`) never injects it — a regression test pins that — so
  `dsh --profile pi-tui` behaviour and the product build graph are unchanged.
- The frame is published by `repaintTarget()` after its ONE existing
  `folder.window()` and after `TuiApp.setTranscript()`, and carries:
  - `subjectKind` / `subjectId` — the active display subject, sampled from the
    same selection the repaint used (never inferred from a row's turn);
  - `sourceIdentity` — an OPAQUE bare-object token, `===` only: the same fold
    keeps one token, a replaced fold gets a new one, and the fold instance itself
    is never handed to the observer;
  - `messages` — the exact array the mounted app just received (same reference).
- It CAPTURES the active target (folder, window controller, subject kind and
  id) at one instant before the commit and publishes only if all four are still
  live afterwards, so a `setTranscript()` that synchronously switches the
  subject (viewer open/exit), hands the session over to another owner while the
  previous fold/window are still mounted, or tears the surface down drops the
  stale frame; `dispose()` releases the observer before the app dies. This guard
  covers the INTERRUPTED commit. It does not gate the session-switch window in
  which the app keeps displaying the previous subject's transcript until the new
  hydration commits (`hydratePresentation` replaces the fold and repaints): a
  frame there carries the new subject id with the still-displayed fold's content,
  so a consumer must not treat that content as the new subject's — the renderer
  policy for that window is a PR3 decision (see *Next decisions*).
- `test/tern-tsp-live-projection.test.ts` (13 tests) drives the REAL routing
  bodies, fold/window, `repaintTarget` and mounted `TuiApp`, and renders through
  the real SDK surface on a separate scripted TTY: routed durable events, live
  assistant input, the attachment/foreign-session fences, main ↔ viewed-child,
  an owner handover and a replaced fold under the same Session id, the
  production cold hydration and the production Remote re-window
  (`rehydrateFromWindow`), coalescing (one commit per 50 ms window; an identical
  view is zero ops on the wire), dispose, and tty/product isolation.
- The dev/test consumer (frame → `projectTranscriptStructure` → PR1 mapper → SDK
  `Surface.render`) lives inside that test file; there is deliberately no
  production bridge module, no CLI option and no setting until the physical
  mount is designed.

### PR3–PR4 — renderer selection, input/modal seats and the native Model UI

The composition point the next section used to wait for landed in PR3-A: the renderer is
selected exactly once at the composition root, *before* PiTui claims stdin — a `connect()`
that returns `null` falls back to PiTui and a throwing consumer is fatal, so a TSP pane can
never leave the session without a renderer. `src/startup.ts` keeps its zero-dependency
island (the SDK import stays lazy).

| Area | Where | State |
|---|---|---|
| Renderer selection + the single SDK tty owner | `src/app/bootstrap/renderer-selection.ts`, `src/tui/tsp/session.ts` | DONE (PR3-A) |
| Display seam, shared composer, submission/command admission | `src/app/surface/**`, `src/app/submission/**` | DONE (PR3-A, PR3-B B0–B2) |
| Official Question/Approval modal seat and its lifecycle | reused as-is inside TSP | DONE (PR3-B B3); B4 is the owner-QA-confirmed physical qualification record |
| Native Model B2 (`/model`): model + Reasoning Effort selection over the original handler | `src/app/command/model-presentation.ts`, `src/tui/commands/models.ts`, `src/tui/tsp/model-picker*.ts`, `src/tui/pickers/model-directory.ts` | IMPLEMENTED under owner-frozen UX, qualification partial — see [model-selection.md](./tern-tsp/model-selection.md) and [evidence/pr4-a.md](./tern-tsp/evidence/pr4-a.md) |
| Native Preset (`/preset` + its typed verbs): the original handler behind one compact picker with a read-only Details page | `src/app/command/preset-presentation.ts`, `src/tui/commands/models.ts`, `src/tui/tsp/preset-picker*.ts`, `src/tui/pickers/preset-presentation-pitui.ts`, `src/tui/pickers/preset-display.ts` | IMPLEMENTED under owner-frozen UX, qualification partial — see [preset-selection.md](./tern-tsp/preset-selection.md) and [evidence/pr4-a-preset.md](./tern-tsp/evidence/pr4-a-preset.md) |
| Editor/input inside TSP (a Client-controlled `ui.editor`) | the TSP composer | IMPLEMENTED (PR3-B B1/B2); real-GUI IME, physical paste and physical control keys stay B4 items |

TSP is still opt-in (`DSH_PI_TUI_RENDERER=tsp`) and experimental; Direct and PiTui remain
the defaults, and the capability matrix above is the authoritative status table.

### Why the renderer used to be undecided

PiTui claims the process TTY at mount, so rendering the same Session through a TSP pane
instead means selecting exactly one input owner *before* PiTui takes stdin, with a PiTui
fallback when `connect()` returns `null`. PR3-A implemented exactly that at the
composition root (table above); the caution is kept here because it is why no second
`TuiApp`-shaped facade was ever built.

## Identity, currentness and failure contracts

- **Presentation keys are replay-local.** `TranscriptNodeKeys` allocates a node
  id per `TranscriptMessage` object in a `WeakMap`, scoped to one consumer
  lifetime. An id is stable only for a retained node whose parent structure did
  not change: a merged read-group replacement or a Context cluster membership
  change legitimately rebuilds that node's id (PR1 pinned both cases). This is
  NOT a durable semantic-identity protocol.
- **`sourceIdentity` is a change detector, not a generation.** A session commit,
  a same-id cold rehydrate and a viewer switch replace the `TranscriptFolder`
  instance; the observer re-scopes its keys then. A same session id alone is
  never proof that it is the same view — the routing's attachment / currentness
  fences decide, and the observer re-reads them after the commit.
- **One fold, one window.** The observer receives an already-selected window; it
  must not fold, window, page or subscribe. A key re-scope is presentation, never
  a business re-derivation.
- Close semantics. Normal quit uses `close({ keep: false })`. On
  `SIGINT`/`SIGTERM` the SDK closes with `keep: true`, leaving the last `main` in
  scrollback, then re-raises; taking that over would mean owning signal handling
  outside the SDK session, which this project does not do (see
  [PR3 handoff issues](#next-decisions)).
- **Display-seam type debt — closure owner: PR4.** The
  `SurfaceDisplaySeam` (`src/app/surface/display-seam.ts`) still imports the
  PiTui-shaped presentation types (`TranscriptSearchPresentation`, `StatusData`,
  `DisplaySubjectPresentation`) from `tui-app.ts`. They are type-only and the
  architecture gate accepts them, but the search/viewport-shaped parameters
  belong to the PiTui adapter side. PR3-B deliberately does NOT widen or narrow
  them: the submit/interaction authority refactor (`SubmissionComposerPort`,
  `SurfaceInteractionPresenter`) is independent of `TuiApp`, and moving the
  display DTOs is a distinct follow-up owned by PR4 (UI parity), which is also
  when the search/viewport members gain TSP meaning. PR3-B adds a rule instead:
  no NEW `TuiApp` type import may enter `src/app/submission/**` (the composer
  port is the only seam).
- **Failures stay visible.** Nothing catches an observer or SDK error to report
  "unsupported": an unsupported environment is only the SDK's own `null`, and a
  throwing consumer propagates to the caller. After `dispose()` no frame is
  published.

## Compatibility and capability matrix

| Capability | State |
|---|---|
| PiTui full application (`dsh --profile pi-tui`) | Production default, unchanged by TSP work |
| Canonical projection → native TSP nodes (mapper) | DONE (pure, unit-covered; the production copy lives in `src/tui/tsp/transcript-view.ts`) |
| Replay spike in a real Tern pane | DONE (PR1; real Tern 0.6.2, 7 acked frames) |
| Live application projection → isolated TSP surface | DONE in tests (PR2) |
| Single-tty read-only TSP renderer (PR3-A, opt-in env) | IMPLEMENTED (scripted-tty tests; real-pane smoke in the PR3-A evidence) |
| Live application projection → real Tern pane (product) | PR3-A manual smoke (see evidence); still experimental |
| Editor/submit input inside TSP | IMPLEMENTED (B1/B2); real-GUI IME / physical paste / physical control keys are B4 qualification items |
| Question/Approval modals inside TSP | IMPLEMENTED (B3): one official FIFO seat over the real lifecycle (timed → continued → `Alt+Q` → late answer); fail-closed in PR3-A only |
| Preset inspection and selection inside TSP | PR4-A implementation: Owner-frozen native UI over the original command family (Built-in/Custom rows, Current/Next-session/default/Draft facts, read-only Details page, two-zone K2, explicit-action-only `Use`/`Set new-session default`); `picker` required. Automated coverage includes the real Direct registry roster, the started-Session refusal, the typed verbs and the new-session-default write through the real ConfigEditor/Loader profile document plus a fresh-Context reload, and the blank-live-Session switch over a REAL persisted Session resumed through the official persistence seam (durable `agent-preset/selected`, authority reread, locked negative, clean teardown); Remote TSP, the shipped full profile/HMR and physical input remain open. [Preset selection](./tern-tsp/preset-selection.md) · [PR4-A Preset evidence](./tern-tsp/evidence/pr4-a-preset.md) |
| Model/effort selection inside TSP | PR4-A implementation + Model-UX restructuring: Owner-frozen native **Models → Overview → Full details** flow over the original handler (radio-row draft in the wide side column, that model's Overview as the compact/bounded path, a read-only Full details page, a short `Cancel` / `Back` / `Retry` / `Switch` / `Save default` footer, K2 keyboard, one read owner with Retry, scope clicks on the SDK's own `action` channel); `picker`/`row`/`card` required. Automated coverage includes live Agent selection, isolated profile persistence/restart and the full K2/wire matrix; the restructured surface was additionally driven in a real Tern 0.8.2 pane (card head/body pointer hit, real `select`/`activate`, footer containment and the one write at 400x600 and 1280x800) by the repository's real-pane harness (`scripts/tern-pane-model-ux.mjs`, reproducible), with the enlarged-font matrix recorded as NOT_VERIFIED. [Model selection](./tern-tsp/model-selection.md) · [PR4-A evidence](./tern-tsp/evidence/pr4-a.md) |

| Search/Reveal/Focus parity inside TSP | PLANNED (PR4–PR5) |
| ExtensionView / custom renderers over TSP | PLANNED (policy undefined) |
| SSH, tmux, screen, zellij, `TERN_TSP=0` | Unsupported by the SDK (`connect()` declines) |
| Remote generated wire (L5) / full product (L6) over TSP | NOT CLAIMED |

### TSP key semantics and deliberate PiTui differences

The interactive TSP composer is a CLIENT-CONTROLLED `ui.editor` (the SDK's native
`edit`/`undo`/`send` are not advertised), so TSP implements an explicit key
contract instead of the vendored PiTui editor:

| Chord | TSP behavior | PiTui behavior |
|---|---|---|
| `Enter` / `Shift+Enter` / `Ctrl+Enter` | submit / newline / accelerated submit (existing busy policy decides queue vs steer) | same business intent through its own editor |
| `Ctrl+C` | the EXISTING cancel/interrupt intent — modal cancel while a form owns the seat, interrupt while a turn runs, otherwise a no-op; **never an exit** | an exit key: clears a non-empty draft, then a second press within the confirmation window exits |
| `Ctrl+D` | exits ONLY when the composer is empty and no modal is up | same condition, but armed by the `Press <key> again to exit` confirmation window |
| `Escape` | modal cancel, otherwise the existing cancel intent | same intent |
| `Alt+Q` | reopens current-session continued Questions | n/a (PiTui shows them inline) |
| printable keys / bracketed paste | text; a paste is ONE atomic edit whose newlines and `/name`-looking lines are CONTENT, never separate dispatches | its own editor |
| other control chords (e.g. `Ctrl+A`, `Ctrl+V`) | ignored (unknown editing chords may no-op) | editor-native selection/clipboard |

**Known differences, owner-decided (B4):** the PiTui exit-confirmation window
(and its footer hint) is NOT implemented in the TSP renderer — TSP exits on a
single `Ctrl+D` while the draft is empty and no modal is up. This is recorded as
a **PR4 UI-parity item**, not a defect; the deliberate `Ctrl+C` difference above
is part of the frozen PR3-B key contract and must not be "fixed" into an exit.

## Verification and reproducibility

```sh
# PR2 seam + live projection chain (real routing, real fold, real SDK surface)
node --test test/tern-tsp-live-projection.test.ts

# PR1 mapper/spike oracles
node --test test/tern-tsp-transcript-spike.test.ts

# PR4-0 audit locks (command-origin admission, the non-modal event sink)
node --test test/tern-tsp-command-admission.test.ts
node --test test/tern-tsp-live-mount.test.ts

# types and the architecture/coupling gates that cover src/app/surface
pnpm typecheck:bundle
pnpm gate:architecture
pnpm gate:boundary
```

A real Tern pane smoke is documented in
[PR1 evidence § Real Tern smoke](./tern-tsp/evidence/pr1.md#real-tern-smoke-t2)
(headless `tern serve` + `tern ctl`, `TERN_TSP_RECORD` recording,
`tern ctl key/shot`).

The generic real-pane harness — headless `tern serve` + `tern ctl`, real pointer
and key input, the real node tree, PNG captures and the clipping/click oracle —
is `scripts/tern-pane-drive.mjs` with the pure `scripts/tern-pane-geometry.mjs`
oracle; a flow module mounts the surface under test, and
`scripts/tern-pane-smoke.mjs` is the committed end-to-end smoke of the instrument
itself. See [`tern-pane-harness.md`](./tern-pane-harness.md). It is operator-run
(it needs the external Tern CLI) and is deliberately not part of `pnpm test`.

Evidence levels — do not merge these into a stronger claim:

- A scripted TTY that answers the official handshake is **not** a real Tern
  pane; the real-pane proof is the PR1 smoke.
- Driving the real `routeSessionEvent`/`repaintTarget`/`TuiApp` chain is **not**
  DSH wire (L5) or a real pane running the product (L6).
- Test counts are snapshot-qualified; re-running a suite on a later tree does not
  transfer to the earlier one.

## Milestones and evidence ledger

| PR | State | Proved | Not proved | Evidence |
|---|---|---|---|---|
| PR1 ([#256](https://github.com/XMoon/dsh-pi-tui/pull/256)) | DONE (merged) | Canonical transcript → native TSP nodes; real Tern 0.6.2 render, incremental ops, clean/signal close | Live application wiring; editor/input; durable identity | [./tern-tsp/evidence/pr1.md](./tern-tsp/evidence/pr1.md) |
| PR2 ([#257](https://github.com/XMoon/dsh-pi-tui/pull/257)) | DONE (merged) | Real application routing/fold/window/commit → read-only frame → real SDK surface on an isolated tty, including the production cold hydration and the Remote re-window (`rehydrateFromWindow`) | Real Tern pane; product renderer selection; editor/input; Remote wire rollover (deferred with owner) | [./tern-tsp/evidence/pr2.md](./tern-tsp/evidence/pr2.md) |
| PR3-A ([#260](https://github.com/XMoon/dsh-pi-tui/pull/260)) | DONE (merged) | One renderer selection at the composition root (SDK connect before PiTui; null→PiTui, throw→fatal); single SDK tty owner; read-only live transcript + status/notices through the display seam; Loading policy; fail-closed modals | Editor/input (PR3-B); real-pane parity of every capability | [./tern-tsp/evidence/pr3-a.md](./tern-tsp/evidence/pr3-a.md) |
| PR3-B B0–B3 ([#261](https://github.com/XMoon/dsh-pi-tui/pull/261), [#262](https://github.com/XMoon/dsh-pi-tui/pull/262), [#263](https://github.com/XMoon/dsh-pi-tui/pull/263), [#265](https://github.com/XMoon/dsh-pi-tui/pull/265)) | DONE (merged) | Display seam; shared composer + submission/command admission; the unified official Question/Approval modal seat with its lifecycle (timed/continued/`Alt+Q`/late answer), currentness and settlement rules | Real-GUI IME / physical paste / physical control keys (B4) | [./tern-tsp/evidence/pr3-b.md](./tern-tsp/evidence/pr3-b.md) |
| PR3-B B4 | Qualification COMPLETE (owner QA-confirmed) | The §6.4 mandatory cases and the B-01..B-09 gates with evidence tiers (real pane / real SDK+scripted tty / production harness), the fixture manifest, the per-case record digests, the owner's QA confirmation and the independent review record; the automated lanes are green on the frozen artifact | The explicit merge approval (and the reviewer's re-check of this revision). The masked Question's **physical** qualification was deferred by the owner to PR4 and is NOT part of this closure | [./tern-tsp/evidence/pr3-b.md](./tern-tsp/evidence/pr3-b.md) |
| PR4-0 capability audit | DONE (`AUDIT_DONE / SPLIT_PROPOSED_NOT_FROZEN`) | The actual reachability ledger: every registered command with its origin/refusal/handler, the panel/keybinding/session/task/viewer/media/extension consumers, the pinned SDK 0.1.0 vs real Tern 0.7.0 event proof, and a proposed (unfrozen) PR4A/B/C split with the owner decision sheet | The PR4A/B/C split and the first command batch are **owner decisions**, not accepted here; the physical/GUI tier is `GUI_BLOCKED`; the early-catalog `/settings` cause is `UNKNOWN` | [./tern-tsp/evidence/pr4-0.md](./tern-tsp/evidence/pr4-0.md) |
| PR4-A Model | IMPLEMENTED (owner-frozen UX); qualification partial | Original handler + native presenter implementing UX-D01/D02/D08/D09(K2)/D10/D12/D15 and Retry; regression tests cover scoped writes, the K2 write admission, read-error Retry, isolated profile persistence/restart and stale input; real-Tern headless runs cover the wide/compact layouts | Physical GUI/IME/focus, full-profile/HMR, clean live-Agent teardown, Remote TSP Model success and catalogues beyond the scripted sizes are NOT certified (`GUI_BLOCKED` / `NOT_VERIFIED`) | [Model selection](./tern-tsp/model-selection.md) · [PR4-A evidence](./tern-tsp/evidence/pr4-a.md) |
| PR4-A Preset | IMPLEMENTED (owner-frozen UX); qualification partial | Original `/preset` handler plus one native presenter: Built-in/Custom rows, the independent Current/Next-session/default/Draft facts, a read-only Details page, two-zone K2 with explicit-action-only writes, and the same settings writer behind the picker action and the typed verb; regression tests cover the K2 admission, the settlement matrix, the capability/admission negatives and the real Direct registry/handler path; the default write persists through the real ConfigEditor/Loader document and survives a fresh-Context reload; real-Tern headless runs cover 1280x800, 900x640, 560x640 and the 400x600 minimum | Remote TSP preset success, the shipped full profile/HMR and physical GUI/IME/focus are NOT certified (`GUI_BLOCKED` / `NOT_VERIFIED`) | [Preset selection](./tern-tsp/preset-selection.md) · [PR4-A Preset evidence](./tern-tsp/evidence/pr4-a-preset.md) |
| PR4+ (feature work) | PLANNED | UI/panel/clipboard parity, exit-confirmation window, native editor chords — scoped by the PR4-0 proposal once the owner freezes the split | — | [./tern-tsp/evidence/pr4-0.md](./tern-tsp/evidence/pr4-0.md) |

## Next decisions

The PR4-0 audit
([./tern-tsp/evidence/pr4-0.md](./tern-tsp/evidence/pr4-0.md)) answers several
of the questions below with current source→sink evidence (the `TuiApp` coupling
per owner, the input/event gap, the display-seam reuse) and carries the owner
decision sheet for the PR4A/B/C split. The list is kept as the original
open-question record:

Open questions the next TSP PR must answer (recorded, not implemented):

1. Which calls on `SurfaceRuntime.app: TuiApp` genuinely block a read-only TSP
   mount, per owner (`session-presentation.ts`, `event-routing.ts`,
   `bootstrap.ts`)? List real call sites only — no giant mock interface.
2. Where is the single composition point where a TSP handshake can happen before
   PiTui takes stdin, with the existing PiTui fallback when `connect()` is
   `null`? `src/startup.ts` must stay dependency-free.
3. Which minimal editor/input state (`tui/interaction/editor-seat.ts`,
   `input-router.ts`) must the TSP owner take over, and which parts depend on
   PiTui `Component`/`Key` types?
4. How do Question/Approval modals, ExtensionView and the child viewer hand over
   input ownership so a TSP pane never swallows user input it cannot serve?
5. Does the signal-time `keep: true` (versus the normal `keep: false`) need a
   product-level policy? Until proven safe, keep the SDK's own behaviour.
6. When TSP gains Search/Reveal, how do we reuse
   `src/tui/transcript/{reveal,container-owner}.ts` without moving PiTui
   geometry into the TSP consumer?

7. During a session switch the mounted app keeps showing the previous subject's
   transcript until the hydration commit replaces the fold. Decide the TSP
   renderer policy for that window — keep the previous transcript, show a
   loading state, or suppress the pane — instead of presenting the previous
   content as the new subject's.

**Updating this document:** after every TSP PR, update *Current implementation*,
*Compatibility and capability matrix* and *Milestones and evidence ledger*, and
write that PR's measurements into its own
`docs/tern-tsp/evidence/prN.md`. Never rewrite an earlier evidence file's
numbers; add the new PR's file. Never describe a passing unit test as "DSH
running inside Tern".
