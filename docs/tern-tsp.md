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
- **Production is PiTui only.** `dsh --profile pi-tui` renders through the
  vendored PiTui surface. There is no TSP flag, profile, setting, command or
  automatic selection, and `src/startup.ts` stays dependency-free. TSP is
  currently dev/test-only.
- **What exists:** PR1 (a standalone opt-in replay spike with a real Tern pane
  smoke) and PR2 (an optional read-only projection observer that lets an
  isolated TSP consumer render the live application projection). Both are
  experimental; neither replaces PiTui.
- **As tested, not a compatibility promise:** `@stencil-hq/tern@0.1.0` (npm,
  `devDependencies` only) against real Tern `0.6.2 (4b3ed42)`, on
  `next @ a4473563`. A future SDK or pane version may change any field below.
- **Last verified:** 2026-10-08 (UTC+8).

| Item | State |
|---|---|
| PR1 replay spike → real Tern pane | DONE (manual, opt-in script) |
| PR2 live application projection → isolated TSP surface | IMPLEMENTED on `feat/tern-tsp-pr2-live-presentation` (see the ledger; update to DONE when merged) |
| TSP pane as the product renderer (one physical tty) | PLANNED (PR3) |
| Editor/submit/Question/Approval inside TSP | PLANNED (PR3+) |

## Upstream protocol and SDK

Authoritative sources (this repository does not reproduce the specification):

- [Tern Surface Protocol overview](https://docs.stencil.so/tern/protocol/index.html)
- [Tern SDKs](https://docs.stencil.so/tern/protocol/sdks.html)
- [SDK source (TypeScript)](https://github.com/stencil-hq/tern-sdk/tree/main/typescript)

What the integration relies on, in the shape the pinned SDK exposes it:

- `connect(options)` probes the terminal (DA1) and returns a session, or `null`
  when the environment is not a supporting pane (non-TTY, `TERN_TSP=0`, tmux,
  screen, zellij). It takes raw mode only after the handshake is accepted and
  restores it on close.
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
  - `sourceIdentity` — the exact `TranscriptFolder` instance, for `===` only;
  - `messages` — the exact array the mounted app just received (same reference).
- It re-checks the active target after the commit, so a `setTranscript()` that
  synchronously switches the subject (viewer open/exit, session switch) drops
  the stale frame; `dispose()` releases the observer before the app dies.
- `test/tern-tsp-live-projection.test.ts` (8 tests) drives the REAL routing
  bodies, fold/window, `repaintTarget` and mounted `TuiApp`, and renders through
  the real SDK surface on a separate scripted TTY: routed durable events, live
  assistant input, the attachment/foreign-session fences, main ↔ viewed-child,
  the re-entrancy drop, coalescing (one commit per 50 ms window; an identical
  view is zero ops on the wire), dispose, and tty/product isolation.
- The dev/test consumer (frame → `projectTranscriptStructure` → PR1 mapper → SDK
  `Surface.render`) lives inside that test file; there is deliberately no
  production bridge module, no CLI option and no setting until the physical
  mount is designed.

### Why the renderer is not switched at runtime yet

PiTui claims the process TTY at mount. Rendering the same Session through a TSP
pane instead means selecting exactly one input owner *before* PiTui takes stdin,
with a PiTui fallback when `connect()` returns `null`. That composition point,
and the editor/input authority behind it, are PR3 scope; building a second
`TuiApp`-shaped facade now would implement PR3 by accident.

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
- **Close semantics.** Normal quit uses `close({ keep: false })`. On
  `SIGINT`/`SIGTERM` the SDK closes with `keep: true`, leaving the last `main` in
  scrollback, then re-raises; taking that over would mean owning signal handling
  outside the SDK session, which this project does not do (see
  [PR3 handoff issues](#next-decisions)).
- **Failures stay visible.** Nothing catches an observer or SDK error to report
  "unsupported": an unsupported environment is only the SDK's own `null`, and a
  throwing consumer propagates to the caller. After `dispose()` no frame is
  published.

## Compatibility and capability matrix

| Capability | State |
|---|---|
| PiTui full application (`dsh --profile pi-tui`) | Production, unchanged by PR1/PR2 |
| Canonical projection → native TSP nodes (mapper) | DONE (pure, unit-covered) |
| Replay spike in a real Tern pane | DONE (PR1; real Tern 0.6.2, 7 acked frames) |
| Live application projection → isolated TSP surface | DONE in tests (PR2) |
| Live application projection → real Tern pane | UNVERIFIED (PR3) |
| TSP as the single product renderer / editor owner | PLANNED (PR3) |
| Search/Reveal/Focus parity inside TSP | PLANNED (PR4–PR5) |
| ExtensionView / custom renderers over TSP | PLANNED (policy undefined) |
| SSH, tmux, screen, zellij, `TERN_TSP=0` | Unsupported by the SDK (`connect()` declines) |
| Remote generated wire (L5) / full product (L6) over TSP | NOT CLAIMED |

## Verification and reproducibility

```sh
# PR2 seam + live projection chain (real routing, real fold, real SDK surface)
node --test test/tern-tsp-live-projection.test.ts

# PR1 mapper/spike oracles
node --test test/tern-tsp-transcript-spike.test.ts

# types and the architecture/coupling gates that cover src/app/surface
pnpm typecheck:bundle
pnpm gate:architecture
pnpm gate:boundary
```

A real Tern pane smoke is documented in
[PR1 evidence § Real Tern smoke](./tern-tsp/evidence/pr1.md) (headless
`tern serve` + `tern ctl`, `TERN_TSP_RECORD` recording, `tern ctl key/shot`).

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
| PR2 | IMPLEMENTED (this PR) | Real application routing/fold/window/commit → read-only frame → real SDK surface on an isolated tty | Real Tern pane; product renderer selection; editor/input | [./tern-tsp/evidence/pr2.md](./tern-tsp/evidence/pr2.md) |
| PR3+ | PLANNED | Renderer selection at one composition point; editor/input authority; Question/Approval hand-off | — | — |

## Next decisions

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

**Updating this document:** after every TSP PR, update *Current implementation*,
*Compatibility and capability matrix* and *Milestones and evidence ledger*, and
write that PR's measurements into its own
`docs/tern-tsp/evidence/prN.md`. Never rewrite an earlier evidence file's
numbers; add the new PR's file. Never describe a passing unit test as "DSH
running inside Tern".
