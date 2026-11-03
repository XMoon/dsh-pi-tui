# Tern Surface Protocol (TSP) integration

This is the entry point for TSP in `dsh-pi-tui`: the protocol/product boundary,
the single projection chain, the renderer opt-in and its verification entry
points. The ownership/event contract is specified in
[foundation.md](./foundation.md); the product surfaces in
[model-selection.md](./model-selection.md),
[preset-selection.md](./preset-selection.md),
[session-browser.md](./session-browser.md) and
[work-hub.md](./work-hub.md); real-pane operations in
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

The SDK declines a terminal that is not Tern and an explicit `TERN_TSP=0`, and
it declines the multiplexers that prevent the protocol (`screen`, `zellij`).
Inside tmux it attempts TSP only for a pane marked as Tern-drawn (`TMUX_PANE`
plus a non-empty `@tern-tsp` option), using its own handshake and holding that
pane's `allow-set-title` off until the session closes; any other tmux pane
declines. This states SDK admission, not the qualified behavior of any
particular client build's GUI. Default environments never load the SDK (lazy
import), and `src/startup.ts` stays dependency-free. The TSP path remains
experimental; it has no public selector and does not flip the product default.

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

### The Main empty state (Welcome)

The TSP renderer paints its invitation in **Main only**. The Dock stays the ONE
Quiet Composer — one fixed input, one cursor, one draft owner — and never
carries Session facts, a second input or a Session listing.

```text
the application's formal idle commit (no Session yet)  -> sessionless
SurfaceRuntime.repaintTarget() for the live MAIN subject
   SessionReader.blank(sessionId) === true
   AND the complete fold holds no turn                 -> blank-session
anything else (a started turn, an unknown read, a
   viewed child, the hydration window)                -> hidden
```

- The one blank authority is `SessionReader.blank` (Direct: the official
  turn-boundary projection; Remote: the official Client session-summary bit).
  An unknown read is never inferred from the rendered window, a row count or a
  running state, and the bounded display window is never the history: a fold
  that already carries a turn vetoes the empty state, while an empty window
  alone never proves blankness. On Remote that bit exists only once the session
  list is ready, so a fresh blank Session can show the Welcome at a later
  authorized commit instead of the first frame; nothing here adds a refresh, a
  subscription or a poll to hurry it up.
- The eligibility is a display-only argument carried by the SAME transcript
  commit (`SurfaceDisplaySeam.setTranscript`, appended last). A renderer never
  derives it from an empty projection, never shows a Welcome on its own
  initiative and keeps no second Session cache. `beginSessionHydration()`
  retires the presented Welcome in the same synchronous commit that installs
  the Loading state, so a retired subject's action can never act on the
  incoming subject.
- The single action delegates and owns nothing: it calls the registered
  `/sessions` command's argument-free UI entry, and the existing Session
  Browser owns membership, reading, search, cancel, resume and every outcome
  (see [session-browser.md](./session-browser.md)). The renderer never lists
  Sessions, never picks a row, never holds a `SessionScope` and never switches
  a Session. Where that business entry does not exist (the command is not
  registered, or this mount cannot present the Browser), the state says so
  instead of painting a control that does nothing.
- A pane that negotiated neither `el` nor `styles` gets the plain-text form of
  the same state with no claim of a clickable affordance; the typed command
  stays its route. The mascot rows come from the ONE shared whale asset
  (`src/tui/components/welcome-whale.ts`), picked once per renderer mount and
  never re-picked by a repaint, a resize or a status commit.

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
- Physical GUI, IME, the desktop font stack, wheel/trackpad, the real OS
  window theme/chrome and Remote TSP qualification are outside the automated
  contract; only a specific real-pane run may claim them. The client's own
  light/dark appearance is headless-controllable (`appearance`) and is covered
  by the real-pane harness, not by this list.
- No Remote TSP renderer is claimed; a Remote TSP projection observer over the
  real wire remains a follow-up (see the repository handoff issue).
