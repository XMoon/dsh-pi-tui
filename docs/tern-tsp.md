# Tern Surface Protocol (TSP) integration

Long-term entry point for everything TSP-related in `dsh-pi-tui`. It records the
protocol boundary, the current implementation status and its limits, and the
evidence ledger. Per-PR measurements live under
[`docs/tern-tsp/evidence/`](./tern-tsp/evidence/) and are linked, not copied.

The shared TSP runtime, event and capability architecture is specified in
[Foundation contract](./tern-tsp/foundation.md); the version-pinned SDK and
official-product comparisons are in [Upstream reference](./tern-tsp/upstream-reference.md).
The dated audit and Tern 0.8.3 evidence are in
[Foundation audit (2026-10-13)](./tern-tsp/evidence/foundation-20261013.md).

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
- **PR4-A Model — CURRENT:** the original `/model` handler has PiTui and TSP
  presentation adapters. The TSP surface now uses **two pages**: one list-first
  native Picker with one Reasoning Effort strip and an explicit `Switch` /
  `Save default` footer, painted as the client's `size:'md'` dialog at every
  supported pane width; a read-only native Full details Reader, painted as the
  client's `size:'lg'` overlay. The sole business read/write owner and modal
  seat are unchanged. The required native
  kinds are `picker`, `row` and `overlay`; `strip` is a **Picker prop/region**,
  not a separate required kind. **Historical evolution (superseded, below):**
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
  `Save default` action writes. The later Model-Responsive / Reader revision
  replaced the absolute `cols >= 120` shell rule with the MEASURED pane width at
  which the client really paints the side preview, ordered the Overview so the
  effort candidates precede every long fact, and turned the Full details page into
  a native Reader (complete client-wrapped values plus an app-driven native scroll
  and its own `Back` row). The **list-first** revision then SUPERSEDED the wide
  side column, the provider scope column and the bounded `Open model & effort ›`
  card: the catalogue is ONE native picker at every pane width with a deterministic
  provider mark, the real lowercase `current` / `default` state chips, a
  `Current · Default` group first, and NO preview region and NO fact column at any
  width; the ONE explicit `Switch` / `Save default` write sits in its footer
  EVERYWHERE, and the sheet is the client's `md` dialog at every width (a measured
  `lg` sheet filled 87% of both axes of a 1280x800 pane, which is not a dialog).
  This revision's own follow-up promotes the Reasoning Effort editor into that page
  as the native picker `strip` — one button per candidate the highlighted model
  advertises, with the local draft painted as the client's own `on` chip — and
  retires the intermediate Overview page: `select` only highlights while
  `activate`/`Enter` opens that model's read-only **Full details** page DIRECTLY,
  which groups its facts into Identity / Configuration / Description.
  See [Model selection](./tern-tsp/model-selection.md) for the behavior,
  ownership, regression coverage and qualification limits,
  [the list-first visual evidence](./tern-tsp/evidence/model-list-first-visual-20261013.md)
  for the client Gates behind it, and
  [PR4-A evidence](./tern-tsp/evidence/pr4-a.md) for the durable summary of what is
  certified at which tier and which pitfalls became rules.
- **PR4-A Preset:** the original `/preset` command family now has PiTui and
  native TSP presentation adapters implementing the Owner-frozen v4 Preset UX
  (the TWO-page shape: ONE native cards catalogue whose footer carries the
  THREE native business buttons — the panel's only writer — and ONE read-only
  Details page with the complete identity, the inline official Mode guide and
  the native Back navigation row; independent Current/Next-session/default/
  Draft facts; two-zone K2 with the footer's own arrow ring). The whole command
  family rides ONE capability behind the same native kinds; every read, write
  and Config owner stays in the original command. See
  [Preset selection](./tern-tsp/preset-selection.md),
  [Preset v4 evidence](./tern-tsp/evidence/preset-v4-two-page-20261014.md) and
  [PR4-A Preset evidence](./tern-tsp/evidence/pr4-a-preset.md).
- **PR4-B1 Session Browser — IMPLEMENTED; qualification partial:** B1-A added the native TSP Tree/Cards Picker and read-only Details Reader over
  the existing `SessionReader`; B1-B connects `/sessions`, `/resume`, `/search`,
  and the Footer/Enter/activate Resume actions to that same read owner and the
  existing guarded Session transition. Direct L6 success and real-Tern
  headless presentation are covered; physical G8 and Remote TSP remain
  unverified. See the [Session Browser contract](./tern-tsp/session-browser.md),
  [PR4-B1-A evidence](./tern-tsp/evidence/pr4-b1-a.md), and
  [PR4-B1-B evidence](./tern-tsp/evidence/pr4-b1-b.md).
- **As tested, not a compatibility promise:** `@stencil-hq/tern@0.1.0` (npm, a
  runtime `dependencies` entry) against real Tern `0.6.2` (PR1), `0.7.0` (PR3-B
  real-pane runs), `0.7.2` (PR4-A real-pane Model runs), `0.8.0` (the earlier
  PR4-A Preset runs), `0.8.3` (the v4 Preset and B1-A Session Browser headless
  runs), and `0.8.4` (B1-B Session Browser headless). A future SDK or pane
  version may change any field below.
- **Session Browser verified:** 2026-10-16 (UTC+8), real Tern 0.8.4 headless
  for B1-B; the historical B1-A visual run remains Tern 0.8.3.
- **Last verified:** 2026-10-16 (UTC+8) for the B1-B Session Browser headless
  flow; 2026-10-14 (UTC+8) for the v4 Preset surface (real-pane Preset runs on
  Tern `0.8.3`) and the PR4-A Model surface (real-pane Model runs on Tern
  `0.7.2`); 2026-10-10 for the interactive (PR3-B) surface; 2026-10-08 for the
  read-only PR3-A surface.

| Item | State |
|---|---|
| PR1 replay spike → real Tern pane | DONE (merged, [#256](https://github.com/XMoon/dsh-pi-tui/pull/256)) |
| PR2 live application projection (routed events, production cold hydration, Remote re-window) → isolated TSP surface | DONE (merged, [#257](https://github.com/XMoon/dsh-pi-tui/pull/257)) |
| PR3-A single-tty read-only TSP live mount (experimental opt-in `DSH_PI_TUI_RENDERER=tsp`) | DONE (merged, [#260](https://github.com/XMoon/dsh-pi-tui/pull/260)) |
| B0 display seam / B1 editor+input / B2 submit+command admission / B3 Question+Approval seat | DONE (merged: [#261](https://github.com/XMoon/dsh-pi-tui/pull/261), [#262](https://github.com/XMoon/dsh-pi-tui/pull/262), [#263](https://github.com/XMoon/dsh-pi-tui/pull/263), [#265](https://github.com/XMoon/dsh-pi-tui/pull/265)) |
| B4 end-to-end real-pane qualification (incl. real IME, physical paste, physical control keys) | **Qualification COMPLETE (owner QA-confirmed)** — every §6.4 case and the B-01..B-09 gates are recorded with evidence tiers in [PR3-B evidence](./tern-tsp/evidence/pr3-b.md), together with the reachability limits, the owner-deferred physical masked Question (`DEFERRED_WITH_OWNER` to PR4) and the owner's QA confirmation of the physical-tier items; the independent review of the delta accepted the code/test and its documentation findings were addressed. (The separate B4 `N/A_WITH_REASON` case is an Approval request with no derivable Session identity, not the masked item — see the evidence file.) |
| PR4-B1-A Session Browser read path | IMPLEMENTED as an internal read-only seam; see [contract](./tern-tsp/session-browser.md) and [evidence](./tern-tsp/evidence/pr4-b1-a.md) |
| PR4-B1-B Session Browser commands and Resume | IMPLEMENTED; Direct L6 and real-Tern headless covered, qualification partial because physical G8 and Remote TSP remain unverified; see [contract](./tern-tsp/session-browser.md) and [evidence](./tern-tsp/evidence/pr4-b1-b.md) |

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

### PR3–PR4 — renderer selection, input/modal seats and native Model, Preset and Session Browser UIs

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
| Native Preset (`/preset` + its typed verbs): the original handler behind the v4 TWO-page shape — a native CARDS catalogue whose footer carries the THREE native business buttons, and a read-only Details page (identity, inline official Mode guide, the native Back navigation row) | `src/app/command/preset-presentation.ts`, `src/tui/commands/models.ts`, `src/tui/tsp/preset-picker*.ts`, `src/tui/tsp/preset-guide-content.ts`, `src/tui/pickers/preset-presentation-pitui.ts`, `src/tui/pickers/preset-display.ts` | IMPLEMENTED under owner-frozen UX, qualification partial — see [preset-selection.md](./tern-tsp/preset-selection.md) and [evidence/preset-v4-two-page-20261014.md](./tern-tsp/evidence/preset-v4-two-page-20261014.md) |
| Session Browser (PR4-B1): SessionReader-backed workspace Tree / global Cards / read-only Details, existing TUI commands and guarded Resume transition | `src/app/command/session-browser-read.ts`, `src/tui/tsp/session-browser.ts`, `src/app/session/runtime.ts`, `src/tui/commands/sessions.ts` | IMPLEMENTED; Direct L6 path covered, real-Tern headless qualification only; physical G8 and Remote remain unverified — see [contract](./tern-tsp/session-browser.md), [B1-A evidence](./tern-tsp/evidence/pr4-b1-a.md) and [B1-B evidence](./tern-tsp/evidence/pr4-b1-b.md) |
| Editor/input inside TSP (a Client-controlled `ui.editor`) | the TSP composer | IMPLEMENTED (PR3-B B1/B2); real-GUI IME, physical paste and physical control keys stay B4 items |

TSP is still opt-in (`DSH_PI_TUI_RENDERER=tsp`) and experimental; Direct and PiTui remain
the defaults, and the capability matrix above is the authoritative status table.

### PR4-B2-A — headless basic commands

The PR4-0 audit and B1 left the TUI builtins whose implementation is a PiTui
panel/picker refused on the TSP renderer. PR4-B2-A admits the subset whose WHOLE
closure is an already-existing business owner, with **no new UI of any kind**:
`/new` and `/fork` (the Session runtime), `/title` and its `/rename` alias (the
authoritative `SessionWriter` title write), `/copy` (the shared Client-local
Clipboard Policy) and `/yolo` (the official permission-preset writer), plus
`/logout` in its **explicit-target form only** — the bare command still needs
the credential picker and stays refused.

Nothing about the routing changed: the same authoritative classifier selects the
winner, the same post-classification `tspBuiltinAvailability` predicate answers
"can the mounted renderer run it", and the same registered handler then reaches
its real authority. The predicate gained ONE input: the parsed line's
`rawInput`, used solely to distinguish `/logout <target>` from bare `/logout`.
Every other builtin (`/settings`, `/help`, `/status`, `/login`, `/attach`,
`/export`, …) is refused exactly as before, with the draft restored and no side
effect.

Because the TSP renderer paints no PiTui command card (and the Remote
Client-command registry appends no `command/run` row either), a confirmed
SUCCESS of those commands would otherwise be invisible. The B2-A handlers
therefore surface a confirmed success through the EXISTING renderer-neutral
notice sink (`CommandSurfaceDeps.notify`, threaded into the B2-A registrars
only). Refusal, cancellation and indeterminate outcomes are deliberately NOT
re-notified: they already have an owner (the Direct command card, the
controller's own local-command error notice, or the handler's inline notice),
and a second line would duplicate it on the same Dock. `TuiApp`-backed
renderers keep their long-standing command card and notice and receive no
duplicate line; no public runner member and no second notice owner is
introduced. `runner.app === undefined` is the "no PiTui presentation is
mounted" discriminator used for that supplement, never a Host/Remote decision.

`/copy` keeps the unchanged two-leg policy and is qualified only as
`OSC52_EMITTED`; the OS-clipboard dimension is `NOT_VERIFIED` in this
environment and the plan's `STOP_COPY_QUALIFICATION` is reported to the Owner.
See [PR4-B2-A evidence](./tern-tsp/evidence/pr4-b2-a.md) for the per-command
result tier, the real-Tern channel-integrity run and the exact gaps.

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
| Preset inspection and selection inside TSP | v4 TWO-PAGE revision over the PR4-A implementation: Owner-frozen native UI over the original command family — ONE `ui.picker` with `layout:'cards'` (ONE column at every pane width, `Built-in`/`Custom` groups with their counts, real state badges) whose native footer carries the THREE business buttons in the Owner shape (`Close` plain left; `Set default` + `Use next`/`Use session` both `primary`, packed right; disabled entries grey with the reason as tooltip — Owner ruling "a"), and ONE read-only `lg` Details page (complete identity incl. the `Use:/Default:` scope sentence, relationship facts, the full description/failure reason, and a SHIPPED preset's pinned official English Mode guide INLINE as native Markdown; its ONE interactive node is the native `ui.row({onClick})` Back NAVIGATION row — Owner A4 amendment: the measured client paints no stylesheet border/background on an `el` button, so the styled button was retired with the sheet; the keyboard Back/Esc is application-owned). The layer carries exactly ONE page node inside the app's `ui.col` wrapper (a bare page node paints nothing — measured). `picker`/`row`/`overlay`/`text`/`md` and the `scroll` feature are required (no stylesheet exists on this layer). Automated coverage includes the real Direct registry roster, the started-Session refusal, the typed verbs and the new-session-default write through the real ConfigEditor/Loader profile document plus a fresh-Context reload, and the blank-live-Session switch over a REAL persisted Session resumed through the official persistence seam (durable `agent-preset/selected`, authority reread, locked negative, clean teardown); real-Tern headless runs (Tern `0.8.3`) cover 1280x800, 900x640, 560x640 and the 400x600 minimum, the PAINTED footer order and Owner shape, the `off` greying + tooltip reason, real `select`/`activate`, the Back navigation row's real click path, the inline guide's real client scroll to the tail, and the long-value wrapping. Remote TSP, the shipped full profile/HMR and physical input remain open. [Preset selection](./tern-tsp/preset-selection.md) · [Preset v4 evidence](./tern-tsp/evidence/preset-v4-two-page-20261014.md) · [PR4-A Preset evidence](./tern-tsp/evidence/pr4-a-preset.md) |
| Session Browser (PR4-B1) | Existing `SessionReader` path with native workspace Tree/global Cards/Details; `/sessions`, `/resume`, `/search`, and guarded Resume route through the original command/runtime owners. Capability-gated by `picker`/`row`/`overlay`/`text` and `scroll`; Direct L6 covered, visual qualification is `REAL_TERN_HEADLESS` only. Physical GUI/IME/wheel/theme and Remote TSP remain unverified — [contract](./tern-tsp/session-browser.md) · [B1-A evidence](./tern-tsp/evidence/pr4-b1-a.md) · [B1-B evidence](./tern-tsp/evidence/pr4-b1-b.md) |
| Model/effort selection inside TSP | PR4-A implementation + Model-UX restructuring + Model-Responsive/Reader revision + the **list-first** revision and its strip/Reader follow-up: Owner-frozen native **Models → Full details** flow (TWO pages) over the original handler (ONE native catalogue picker of the client's `md` dialog size at every pane width, with provider marks, real lowercase `current` / `default` state chips and a `Current · Default` group first; the catalogue's own native Reasoning Effort `strip` as the ONE effort editor, painting the local draft as the client's `on` chip; the ONE explicit `Switch` / `Save default` write in the footer everywhere; `select` highlights while `activate`/`Enter` opens that model's read-only Full details DIRECTLY — there is no intermediate Overview page; K2 keyboard; one read owner with Retry); `picker`/`row`/`overlay` required (`strip` is a Picker prop/region), and the read-only details page is a native `overlay` Reader instead of a picker. The catalogue Picker and its layer keep one identity for a panel's life; the Reader body/Back have **one identity per reading** (fresh epoch on re-entry). A per-frame Picker key remounted the list and moved its viewport in the tested 42-row client probe. The bar's `retry`/`apply` IDs are revision-scoped; `close` is intentionally untokened, while Row/Strip events receive current-page/current-model validation. This is a Model-specific admission and lifecycle design, not a universal stable-key rule. Automated coverage includes live Agent selection, isolated profile persistence/restart and the full K2/wire matrix; the surface was additionally driven in a real Tern pane (the presenter's own `size`/`preview` claim against the client's own sheet classes at every supported size, the strip's own phase gate and chip clamp, real `select`/`activate`, sheet/footer containment, the one write, and the Reader's complete values with its app-driven native scroll and `Back`) by the repository's real-pane harness (`scripts/tern-pane-model-ux.mjs`, reproducible), with the enlarged-font matrix and physical wheel/trackpad recorded as NOT_VERIFIED. [Model selection](./tern-tsp/model-selection.md) · [List-first visual evidence](./tern-tsp/evidence/model-list-first-visual-20261013.md) |

| Search/Reveal/Focus parity inside TSP | PLANNED (PR4–PR5) |
| Basic headless commands (`/new`, `/fork`, `/title`+`/rename`, `/copy`, `/yolo`, `/logout <target>`) | IMPLEMENTED (PR4-B2-A) over the unchanged handlers and the same capability gate, with confirmed outcomes surfaced through the renderer-neutral notice sink. `/copy` is qualified `OSC52_EMITTED` only; the OS-clipboard qualifier is `NOT_VERIFIED` (`STOP_COPY_QUALIFICATION` reported to the Owner). Everything else stays refused — [evidence](./tern-tsp/evidence/pr4-b2-a.md) |
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
itself. The committed surface lanes are `scripts/tern-pane-model-ux.mjs`
(`/model`) and `scripts/tern-pane-preset-native-ux.mjs` (`/preset` with its
`-subject.mts` mount). See [`tern-pane-harness.md`](./tern-pane-harness.md). It is operator-run
(it needs the external Tern CLI) and is deliberately not part of `pnpm test`.

Evidence levels — do not merge these into a stronger claim:

- A scripted TTY that answers the official handshake is **not** a real Tern
  pane; the real-pane proof is the PR1 smoke.
- Driving the real `routeSessionEvent`/`repaintTarget`/`TuiApp` chain is **not**
  DSH wire (L5) or a real pane running the product (L6).
- Test counts are snapshot-qualified; re-running a suite on a later tree does not
  transfer to the earlier one.

## Runtime gap closure and SDK upstream tracking (2026-10-13)

The dated Foundation audit was followed by a bounded **F1/F2/F3 runtime-gap audit** and one independent diagnostic repair. The authoritative status and version-qualified measurements are in [Runtime gap evidence](./tern-tsp/evidence/runtime-gap-20261013.md); the cross-feature [Foundation contract](./tern-tsp/foundation.md) remains the current ownership/invariant reference. **Do not reinterpret the older** [Foundation evidence](./tern-tsp/evidence/foundation-20261013.md) **as covering these later runs.**

| Item | Current state | Scope / next step |
|---|---|---|
| **F3-001** — stale Focus Op after credit-blocked coalescing | `CONFIRMED_DEFECT / P2 / OPEN / UPSTREAM_REPORTED` | SDK `Surface.#queue/#flush` issue: [stencil-hq/tern-sdk#48](https://github.com/stencil-hq/tern-sdk/issues/48). Proven protocol `unknown id` in Tern `0.8.3` **headless**; a user-visible input/focus failure is **not** proven. **No local workaround or released SDK fix.** |
| **F3-002** — dropped protocol error diagnostic | **FIXED** by [PR #299](https://github.com/XMoon/dsh-pi-tui/pull/299), merged on `next@8d329ebf` | The renderer routes the client's `error{sf,s,op,msg}` into existing diagnostics; it does not repair F3-001, retry Focus, or turn the error into a fatal/user notice. |
| **F3-003** — fallback close `keep` divergence | `RISK_UNPROVEN` | Source/targeted failure path observed; residual client output has **not** been established. No code change. |
| F1/F2 and remaining Foundation findings | **Version-/case-qualified**; see evidence table | 14 total initial findings: 2 confirmed at audit time (one later fixed), 6 bounded risks/unknowns, 6 no-gap in tested scope; U8 (missing ACK) is an **independent unknown**, not an additional finding. |

**Engineering decision:** issue/report upstream, wait for an SDK fix and separately qualify any consumable SDK update. Isolated A1/A1′ experiments are **PoC only**; the E7/E8 addendum currently has an Agent-reported summary without the raw addendum files attached to the committed evidence. The team is **not** implementing a second Frame/Focus queue, ACK watchdog, local SDK fork, or four-language upstream patch. This remains experimental TSP functionality and does not alter the PiTui default.

## Model UX supersession record (PR #301, 2026-10-14)

The Owner-retired arrangements — wide Provider/Model/Preview Explorer, adaptive Overview page, `More actions`, second-level Effort and the six-row window — are **historical evidence**, not current feature requirements. They were superseded after real-client tests found the effort path unreachable in normal splits, `lg` sheet occupying most of a wide pane, fragmented long detail values and a per-frame Picker key causing remount/scroll movement. The currently authoritative contract is [`model-selection.md`](./tern-tsp/model-selection.md): two pages, one native catalogue strip, direct read-only Reader and explicit footer commit. Retain the historical evidence files as dated records; do not restore their old Must/keyboard/layout assertions without a new Owner decision. This change **does not supersede** Preset's independent UX, the Host/Client writer, TSP renderer opt-in, SDK Focus/Credit issue #48, or physical-GUI qualification gaps.

## Preset UX supersession record (native cards, 2026-10-14)

The Owner-retired arrangements — the `rows` catalogue whose long description was pre-split
into measured one-line `fact` rows on a second `Preset details` picker page, and the
2026-10-12 plan's HTML-like two-column card grid with a surface scoped stylesheet and a wide
`Set default` footer — are **historical evidence, not current feature requirements**. They
were superseded after the real Tern client showed that a native `md` picker is a MODAL sheet:
a sibling status line collapses the layer column and is painted behind the sheet's dim, while
`layout:'cards'` already gives EVERY card its own detail line in ONE column at every pane
width, and a native `lg` overlay is the reading surface that really wraps and scrolls long
values. The v3 THREE-page shape (`Catalog → Overview → Guide`, business actions as accent
`ui.row` operation rows) is retired in turn by the v4 Owner decision: the catalogue's footer
carries the THREE native business buttons (the panel's only writer) and reading is ONE page
with the guide inline. The currently authoritative contract is
[`preset-selection.md`](./tern-tsp/preset-selection.md) (TWO pages: cards catalogue +
Details reader; the Owner-shaped footer; per-panel/per-reading identity); the measured facts
and the G8 record are in
[`preset-v4-two-page-20261014.md`](./tern-tsp/evidence/preset-v4-two-page-20261014.md), with
the earlier revision's record kept as a dated snapshot in
[`preset-native-cards-reader-20261014.md`](./tern-tsp/evidence/preset-native-cards-reader-20261014.md).
Retain the historical evidence files as dated records; do not restore their old Must/keyboard/
layout assertions, and do NOT describe the native `cards` layout as a CSS two-column grid or
the `lg` reading pages as a second picker page. This change **does not supersede** the Model
UX, the Host/Client writer, TSP renderer opt-in, SDK Focus/Credit issue #48, or physical-GUI
qualification gaps.

## Milestones and evidence ledger

| PR | State | Proved | Not proved | Evidence |
|---|---|---|---|---|
| PR1 ([#256](https://github.com/XMoon/dsh-pi-tui/pull/256)) | DONE (merged) | Canonical transcript → native TSP nodes; real Tern 0.6.2 render, incremental ops, clean/signal close | Live application wiring; editor/input; durable identity | [./tern-tsp/evidence/pr1.md](./tern-tsp/evidence/pr1.md) |
| PR2 ([#257](https://github.com/XMoon/dsh-pi-tui/pull/257)) | DONE (merged) | Real application routing/fold/window/commit → read-only frame → real SDK surface on an isolated tty, including the production cold hydration and the Remote re-window (`rehydrateFromWindow`) | Real Tern pane; product renderer selection; editor/input; Remote wire rollover (deferred with owner) | [./tern-tsp/evidence/pr2.md](./tern-tsp/evidence/pr2.md) |
| PR3-A ([#260](https://github.com/XMoon/dsh-pi-tui/pull/260)) | DONE (merged) | One renderer selection at the composition root (SDK connect before PiTui; null→PiTui, throw→fatal); single SDK tty owner; read-only live transcript + status/notices through the display seam; Loading policy; fail-closed modals | Editor/input (PR3-B); real-pane parity of every capability | [./tern-tsp/evidence/pr3-a.md](./tern-tsp/evidence/pr3-a.md) |
| PR3-B B0–B3 ([#261](https://github.com/XMoon/dsh-pi-tui/pull/261), [#262](https://github.com/XMoon/dsh-pi-tui/pull/262), [#263](https://github.com/XMoon/dsh-pi-tui/pull/263), [#265](https://github.com/XMoon/dsh-pi-tui/pull/265)) | DONE (merged) | Display seam; shared composer + submission/command admission; the unified official Question/Approval modal seat with its lifecycle (timed/continued/`Alt+Q`/late answer), currentness and settlement rules | Real-GUI IME / physical paste / physical control keys (B4) | [./tern-tsp/evidence/pr3-b.md](./tern-tsp/evidence/pr3-b.md) |
| PR3-B B4 | Qualification COMPLETE (owner QA-confirmed) | The §6.4 mandatory cases and the B-01..B-09 gates with evidence tiers (real pane / real SDK+scripted tty / production harness), the fixture manifest, the per-case record digests, the owner's QA confirmation and the independent review record; the automated lanes are green on the frozen artifact | The explicit merge approval (and the reviewer's re-check of this revision). The masked Question's **physical** qualification was deferred by the owner to PR4 and is NOT part of this closure | [./tern-tsp/evidence/pr3-b.md](./tern-tsp/evidence/pr3-b.md) |
| PR4-0 capability audit | DONE (`AUDIT_DONE / SPLIT_PROPOSED_NOT_FROZEN`) | The actual reachability ledger: every registered command with its origin/refusal/handler, the panel/keybinding/session/task/viewer/media/extension consumers, the pinned SDK 0.1.0 vs real Tern 0.7.0 event proof, and a proposed (unfrozen) PR4A/B/C split with the owner decision sheet | The PR4A/B/C split and the first command batch are **owner decisions**, not accepted here; the physical/GUI tier is `GUI_BLOCKED`; the early-catalog `/settings` cause is `UNKNOWN` | [./tern-tsp/evidence/pr4-0.md](./tern-tsp/evidence/pr4-0.md) |
| PR4-A Model | IMPLEMENTED (owner-frozen UX); qualification partial | Original handler + native presenter implementing UX-D01/D02/D08/D09(K2)/D10/D12/D15 and Retry; regression tests cover the list-first catalogue, the explicit writes, the K2 write admission, read-error Retry, isolated profile persistence/restart and stale input; real-Tern headless runs cover the `md` dialog at ten pane widths, the catalogue's own Reasoning Effort strip, the direct row-to-Reader path, the eight-candidate wrap and the chip clamp | Physical GUI/IME/focus, full-profile/HMR, clean live-Agent teardown, Remote TSP Model success and catalogues beyond the scripted sizes are NOT certified (`GUI_BLOCKED` / `NOT_VERIFIED`) | [Model selection](./tern-tsp/model-selection.md) · [List-first visual evidence](./tern-tsp/evidence/model-list-first-visual-20261013.md) |
| PR4-A Preset | IMPLEMENTED (owner-frozen v4 UX); qualification partial | Original `/preset` handler plus one native presenter implementing the TWO-page shape: a `layout:'cards'` catalogue with `Built-in`/`Custom` groups, counts and real state badges whose native footer carries the THREE business buttons (`Close`; `Set default` + `Use next`/`Use session` as `primary` — the Owner shape; disabled entries grey with the reason as tooltip, per Owner ruling "a"), and a read-only `lg` Details page carrying the complete identity/scope facts, the full description/failure reason and a shipped preset's pinned official English Mode guide INLINE, with the native `ui.row({onClick})` Back NAVIGATION row (Owner A4 amendment: the measured client drops stylesheet border/background on `el` buttons, so the styled button and its sheet were retired); per-panel picker identity and per-reading overlay/body identity with a real `scroll` target; the same settings writer behind the footer button and the typed verb; regression tests cover the two-page keyboard contract (the footer's arrow ring, the error-phase Esc ladder), the settlement matrix, the stale/forged receivers, the per-kind capability negatives and the real Direct registry/handler path; the default write persists through the real ConfigEditor/Loader document and survives a fresh-Context reload; real-Tern headless runs (Tern `0.8.3`) cover 1280x800, 900x640, 560x640 and the 400x600 minimum — the ONE-column 54px cards, the PAINTED Owner footer shape, real `select`/`activate`, the Back navigation row's real click path, the inline guide's official copy and its real client scroll to the tail, and the long-value wrapping | Remote TSP preset success, the shipped full profile/HMR and physical GUI/IME/focus are NOT certified (`GUI_BLOCKED` / `NOT_VERIFIED`) | [Preset selection](./tern-tsp/preset-selection.md) · [Preset v4 evidence](./tern-tsp/evidence/preset-v4-two-page-20261014.md) · [PR4-A Preset evidence](./tern-tsp/evidence/pr4-a-preset.md) |
| PR4-B1-A Session Browser | IMPLEMENTED as an internal read-only path; qualification is `REAL_TERN_HEADLESS` only | `SessionReader` list/projection/search through one native Presenter; workspace Tree/global Cards/Details, lifecycle and Direct persisted-main-Session coverage; Tern 0.8.3 headless at 1280×800, 900×640, 560×640, 400×600 and the 400×440 Reader case | No production command or real Session switch; Owner accepted the current Headless screenshots, including the focused-footer/V13 frame; `REAL_TERN_GUI`, GUI/physical V13 sign-off, physical IME/wheel/theme and physical PageUp/PageDown remain `NOT_VERIFIED`; Remote TSP remains `UNKNOWN`; B1-B owns command admission and Resume | [Session Browser contract](./tern-tsp/session-browser.md) · [PR4-B1-A evidence](./tern-tsp/evidence/pr4-b1-a.md) |
| PR4-B1-B Session Browser commands and Resume | IMPLEMENTED; qualification partial | Registered command admission, one-list typed matching, Direct Host content search, Footer/Enter/activate and guarded switch; Direct authoritative reread plus real-Tern headless presentation | Physical G8, GUI/IME/wheel/theme and Remote command-catalogue qualification remain unverified; Remote Resume remains UNKNOWN | [Session Browser contract](./tern-tsp/session-browser.md) · [PR4-B1-B evidence](./tern-tsp/evidence/pr4-b1-b.md) |
| PR4-B2-A headless basic commands | IMPLEMENTED; qualification partial | `/new`, `/fork`, `/title`+`/rename`, `/copy`, `/yolo` and `/logout <target>` admitted through the ONE existing gate/handlers; confirmed outcomes visible on the Tern dock; each command's real authority reread (persisted Session, fork lineage, folded title, approval policy, credential read); genuine Host same-name winners untouched; real-Tern headless run proves the OSC 52 bytes reach the tty without breaking frame/ACK/input/close | A09 (flow-route logout) `NOT_VERIFIED` — no flow provider installed, so `/logout` is qualified for the **reference case** only, reported to the Owner; `/copy` OS-clipboard qualifier `NOT_VERIFIED` (`STOP_COPY_QUALIFICATION`); physical GUI/IME/Remote TSP unchanged | [PR4-B2-A evidence](./tern-tsp/evidence/pr4-b2-a.md) |
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
