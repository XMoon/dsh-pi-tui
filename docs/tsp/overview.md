# Tern Surface Protocol (TSP) integration

This is the entry point for TSP in `dsh-pi-tui`: the protocol/product boundary,
the single projection chain, the renderer opt-in and its verification entry
points. The ownership/event contract is specified in
[foundation.md](./foundation.md); the product surfaces in
[model-selection.md](./model-selection.md),
[preset-selection.md](./preset-selection.md) and
[session-browser.md](./session-browser.md); real-pane operations in
[../guides/tern-pane-testing.md](../guides/tern-pane-testing.md).

## What TSP is, and is not

TSP (Tern Surface Protocol) is an in-band semantic UI protocol: a program
running inside a Tern pane sends a semantic node tree plus incremental ops, and
Tern owns native layout, styling and rendering. The program keeps its own state
and input loop.

TSP is **not** the Tern Luau plugin API, and it is not a second application.
`dsh-pi-tui` remains the owner of its transcript fold, session projection,
command admission and business writes; Tern owns only the terminal surface.

Untrusted node text (`ui.text`/`ui.md`/`ui.code`/`ui.card.head`/`ui.badge` and
picker `label`/`detail`/`title`) uses the same display projection as PiTui
(see [terminal-output.md](../architecture/terminal-output.md)). A structural
node check proves the payload carries no raw control; it does not prove the
closed-source client's own rendering, so physical GUI behavior is not claimed
until a pinned Tern pane is actually run.

## Product boundary

PiTui is the production default. `dsh --profile pi-tui` renders through the
vendored PiTui surface. TSP adds ONE experimental internal opt-in
(`DSH_PI_TUI_RENDERER=tsp`; no profile/setting/command/public CLI):

```text
TSP opt-in set
  -> official SDK connect()
       -> null: mount PiTui unchanged
       -> session: the TSP renderer owns the terminal, including the
          interactive editor, submission and the official
          Question/Approval modal seat
       -> throw: startup failure
```

Unsupported terminals (SSH, tmux, screen, zellij, `TERN_TSP=0`) are declined by
the SDK. Default environments never load the SDK (lazy import), and
`src/startup.ts` stays dependency-free. The TSP path remains experimental; it
has no public selector and does not flip the product default.

## One projection chain

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
SurfaceRuntime.repaintTarget()  -- the ONE projection glue
   |                                    |
   | production                         | optional read-only observer
   v                                    v
TuiApp.setTranscript(...)        onTranscriptProjected (absent in production)
(PiTui, the product)                        |
                                            v
                              experimental TSP consumer
                              projectTranscriptStructure()
                                -> TSP node mapper
                                -> official SDK Surface.render()
```

- `src/tui/transcript/structure.ts` → `projectTranscriptStructure()` remains the
  ONLY Work/Context/standalone segmentation authority; the TSP mapper consumes
  its blocks and never re-groups rows.
- The mapper renders canonical `TranscriptWorkSpan.parts`: a snapshot-only
  Context cluster carried by a Work becomes a nested `ui.card` inside the Work
  `ui.section` (member cards stay under that card); a proven Working
  `tool-jobs` Notice is a direct card child of that section. A retained Context
  row whose parent changes from standalone to Work-internal legitimately
  produces a local `del` of the old top-level card plus one `add` carrying the
  new Work subtree; Work and unrelated user/assistant node ids stay stable.
- One fold, one window, one currentness authority. The TSP path adds neither a
  second `TranscriptFolder`, nor a second SessionEvent subscription, nor a new
  Host port, nor a Host service read (`src/app/surface/**` stays Host-free and
  is gate-enforced).
- Local surfaces that read one already-projected row (the Work Hub and its
  bounded reader) stay inside the same renderer: the Hub resolves the current
  row, the renderer owns the surface, and the reading is a pure projection that
  cannot select, stop or answer anything. Reads can be synchronous; no
  arbitrary await, timeout or watchdog is introduced for them.
- Locality: the whole path is Client-local presentation. Nothing here reads Host
  cwd/filesystem or Session writer authority.
- `TERM_PROGRAM=tern` handling in `src/tui/terminal/tern.ts` (OSC 7 / OSC 9;4)
  is terminal specialization for the Tern terminal emulator. It is not a TSP
  capability probe and does not depend on a TSP session.

The optional observer (`SurfaceRuntimeOptions.onTranscriptProjected`) is
synchronous and read-only, and the production composition root never injects
it. A frame carries `subjectKind`/`subjectId` sampled from the same selection
the repaint used, an opaque `===`-only `sourceIdentity`, and the exact
`messages` array the mounted app received. It captures the active
folder/window/subject before the commit and publishes only if all are still
live afterwards; a session switch, viewer open/exit or teardown drops the stale
frame, and `dispose()` releases the observer before the app dies.

## Surface, frame and lifecycle invariants

- One persistent inline Tern surface per TSP renderer, with ONE bounded
  exception: a temporary read-only `mode:'screen'` **reader surface** on the same
  SDK session and in the same pane, reachable only after a current Work Hub row
  exists, used to make that one row readable. It is a rendering container, not a
  second UI application: no business authority, no second input iterator, no
  second transcript chain, no Host read, no state the base surface needs. At most
  one exists, and the base surface stays resident — an ownership fact, not a
  claim that the user still sees it, which is the client's own presentation
  ([foundation.md](./foundation.md#bounded-reader-surface-lifecycle)).
- The live `layer` producers return a `ui.col` region root, with
  overlays/pickers as children. That is a verified project shape, not an SDK
  mandate that every root must be `col`.
- `surface.render(view)` sends only the diff from the last sent view; every
  region that must exist is submitted on every frame (an omitted region is
  deleted). Node identity follows the presenter's own key/epoch/revision
  contract ([foundation.md](./foundation.md#node-identity-and-currentness)).
- Frame credit/queuing and queued focus are SDK-boundary concerns. Do not
  repair a suspected SDK defect in the renderer with a second focus queue,
  frame reconciler, ACK watchdog or deferred focus latch; report it upstream
  and keep the SDK boundary intact. A single protocol rejection is build-specific
  evidence, not a universal user-visible defect claim.
- The application remains the desired focus/seat owner; Tern owns rendered node
  effects. `ui.overlay({modal:true})` is not an application input-arbitration
  implementation.
- `preview:'side'|'below'|'none'` is a layout hint, not a guaranteed visible
  place. Key information and every action need another reachable path.
- The client's advertised kinds/features/credits/cell size describe that run,
  not other sizes, fonts or builds. A capability gate must require each kind
  the presenter really builds.

## Capability and admission

Command/action provenance comes from the ONE registration seam
(`registerTuiCommands` → `registerOne`/`registerTuiCommand`), never from file
names or a completion union. The capability taxonomy is:

```text
SUPPORTED / RENDERED_READ_ONLY / EXPLICIT_UNAVAILABLE /
NOT_REACHABLE / PROJECTION_ONLY / UNCLASSIFIED(+blocker)
```

`evidence_state` and `qualification_tier` are independent axes.
`EXPLICIT_UNAVAILABLE` requires a real input path refused with a visible
outcome; silently ignored input is `NOT_REACHABLE`. `SUPPORTED` requires the
capability's own authority to close successfully with positive AND negative
evidence. A registry entry, installed package or generic dispatch route is not
enough. `PROJECTION_ONLY` is not navigable state.

## Verification entry points

- Headless/semantic suites: `test/tern-tsp-*.test.ts` (transcript mapper,
  renderer selection, interaction, projection) — the routine gate.
- Real-pane operations: [../guides/tern-pane-testing.md](../guides/tern-pane-testing.md)
  (`scripts/tern-pane-drive.mjs`, `scripts/tern-pane-smoke.mjs`, geometry and
  instrumentation helpers).
- SDK pin/source identity: compare the installed source/integrity and pinned
  commit, never a version label alone (see
  [foundation.md](./foundation.md#6-evidence-tiers-and-qualification)).

## Known limits

- TSP is experimental and opt-in; PiTui remains the product renderer.
- TSP transcript folding/disclosure is partial; it is not PiTui's complete
  Compact/Focus/Full model.
- Physical GUI, IME, fonts, wheel/trackpad, theme modes and Remote TSP
  qualification are outside the automated contract; only a specific real-pane
  run may claim them.
- No Remote TSP renderer is claimed; a Remote TSP projection observer over the
  real wire remains a follow-up (see the repository handoff issue).
