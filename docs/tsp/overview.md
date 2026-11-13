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
ONE TranscriptFolder  (canonical fold of Client-loaded rows)
                |
                v
SurfaceRuntime.repaintTarget()  -- the ONE application writer
   +-> PiTui: folder.window(20 turns) -> TuiApp.setTranscript(...)
   +-> TSP: folder.messages() -> SurfaceDisplaySeam.setTranscript(...)
            -> projectTranscriptStructure()
            -> Full / Compact / Focus block descriptors
            -> ONE official SDK Surface:
                 Main = renderer-local targeted ops (empty stable root)
                 Dock / Layer / Welcome = SDK Surface.render()
            -> Tern native scroll / Follow
```

- `src/tui/transcript/structure.ts` → `projectTranscriptStructure()` remains the
  ONLY Work/Context/standalone segmentation authority; the TSP mapper consumes
  its blocks and never re-groups rows.
- The mapper renders canonical `TranscriptWorkSpan.parts`: a canonical
  snapshot-only Context Cluster carried by a Work becomes one native
  `ui.section` inside the Work `ui.section`; each eligible Context member is
  its own nested `ui.section` with an independent disclosure owner, while a
  non-eligible member stays directly readable. Cluster and member are two
  different disclosure owners: closing the ancestor never deletes a
  descendant's manual preference, and each operable node is admitted only from
  the current Main/Frame contribution index. A proven Working `tool-jobs`
  Notice is a direct card child of that section. A retained Context row whose
  parent changes from standalone to Work-internal legitimately produces a local
  `del` of the old top-level card plus one `add` carrying the new Work subtree;
  Work and unrelated user/assistant node ids stay stable.
- TSP keeps ONE `Surface` and ONE Main document. The transcript Main's
  top-level children are maintained as targeted SDK ops from the block
  descriptors (`describeTranscriptMainBlocksForPreset`), so a retained row is
  never re-materialized for an unrelated change. `Surface.render()` keeps a
  stable EMPTY Main root plus the Dock, the Layer and the formal Welcome Main;
  it never receives the transcript history again. Source identity, input seat,
  Fold ownership, Copy/Disclosure exact ids and image/blob authority are
  unchanged by that split.
- A row's display currency is derived from the Fold, not from node identity:
  `transcriptDisplayRevisionOf()` tracks the in-place mutations a row really
  underwent, and `assistantPresentationRevision()` / a tool's subtree revision
  carry the live-body and nested-call changes. Descriptor stamps combine those
  with the renderer-local disclosure, image/SVG and selection state, so a legal
  late `tool/result`, PTC child or settled answer can still refresh a very old
  row while unrelated history stays untouched.
- `settle()` is a bounded hint, never a correctness mechanism: only a
  top-level, currently mounted, pure User row whose owning turn is proven ended
  (and that carries no image or pending publication) is settled. Assistant
  stats/visuals, Work/Activity, Tool, Thinking, Context, Focus roots, Commands
  and any streaming row deliberately stay unsettled. Tern's own document
  retention may evict such a settled Main child and report `gone`; the evicted
  id is retired from the renderer's operable set and is not re-fetched, because
  bounded retention is a client fact, not a Host history loss.
- PiTui keeps its existing `TranscriptWindowController` and bounded
  `folder.window()` projection. TSP uses `folder.messages()` from that same
  Folder for all Client-loaded rows and commits them through the same
  `SurfaceDisplaySeam.setTranscript`; it does not add a window summary.
- The TSP `mode:'latest'` metadata describes the loaded-document tail only,
  not Tern's physical scroll position or Follow state. Tern owns native Main
  scroll and Follow; no app-level history navigation or scroll mirror is added.
- Remote projection remains limited to rows already loaded by the authorized
  Reader. Scrolling does not fetch Host history; authorized rehydrate replaces
  the Folder and starts a new source scope. The TSP path adds neither a
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

### Native card disclosure

The mapper owns the final presentation shape of every Main row; no row is
folded by a second business state machine.

- A Command or Compaction that carries real detail is a native `ui.section`
  with one renderer-local manual owner shared by both kinds. It starts
  collapsed and shows the bounded result/error preview plus the status word.
  A row without any detail stays a directly readable static card: it paints no
  operable disclosure head. A correlated manual `/compact` remains ONE
  Compaction card; its command's error kind outranks the compaction error
  text even when the normalized command text is empty.
- An ordinary Tool keeps its native `ui.tool` identity and disclosure. While
  collapsed it may carry one bounded human note derived from the existing
  `tool-presentation` helpers (read/write/skill/read_image envelopes, answer
  and Goal summaries, registered JSON summaries, action results, terminal
  output after the shared log policy). Raw XML/JSON, machine receipts and
  malformed envelopes never become that note; the existing error note keeps
  precedence, and an opened card drops the folded note.
- Standalone Notice/Recall/Relay rows reuse the existing Context owner. A
  producer Notice summary stays normal wrapped text beside its header; Recall
  names only its official label. A short Relay is directly readable, while a
  long Relay uses a bounded first/last preview. The Relay threshold (more than
  10 logical lines or 800 Unicode code points) is an explicit TSP text policy,
  not PiTui's physical visual-row metric. Ambient/unknown Context keeps its
  fail-open behavior, and T3 Context Cluster member semantics are unchanged.
- Every toggle is admitted only from the current frame's materialized head and
  the current source scope. A source replacement clears all manual owners; a
  removed ancestor makes its descendants inoperable without deleting an owner
  that is still loaded; an explicit Focus root close resets only the process
  owners that root projects. The application never writes business state from
  a disclosure toggle.

### Native Workflow disclosure

The canonical `TranscriptWorkflowMessage` remains the only Workflow business
authority: run/member terminal facts come from the official `tool-workflow/*`
events through `WorkflowProjection`, and a step/turn/idle fact never settles a
run. The TSP mapper renders that one row as a native Run `ui.section` whose head
always carries the real run status and the exact `workflowRunSummaryText`
counts, including while the Run is collapsed. When the Run is open, each phase
is a nested native `ui.section`; a phase with at most `WORKFLOW_INLINE_MEMBER_LIMIT`
members shows every member in durable order with a textual status word, while a
larger phase shows only its exact counts, an abnormal preview capped at
`WORKFLOW_ANOMALY_PREVIEW_LIMIT`, and the hidden abnormal count. No TSP-specific
Workflow fold state machine exists: `workflowPhasePresentations()` and
`workflowRunMode()` own the presentation rules.

Manual Run/Phase choices live in ONE source-scoped renderer map
(`WorkflowRunDisclosureState` per canonical `runId`) and are advanced by the
shared `advanceWorkflowDisclosureState()` edge policy only when the official
members array reference or run status changed. The map is cleared with the
projection source, hydration and disposal; a run that leaves the loaded window
loses its state, while a retained run keeps a valid manual choice. A cold
replay establishes its facts as the baseline rather than replaying historical
edges. Closing a parent never recursively clears a legal child preference.

Every toggle is admitted only from the exact current SDK frame's materialized
Section head and the current input seat; a stale/foreign id, a replaced source,
a modal/Reader/Hub seat or a hidden folded descendant never changes business
state. The Workflow row never emits a child-transcript Viewer action: this
renderer's `supportsViewer` remains `false`, and member rows are static text.
Only when the live Task Center and its scoped TaskRuntime entry are both
available does the frame paint one native scoped browse button (per phase, and
one run-wide button when `workflowRunViewAllVisible()` holds); clicking it opens
the existing read-only Work Hub, never a second task source.

### The Main empty state (Welcome)

The TSP renderer paints its invitation in **Main only**. The Dock stays the ONE
Quiet Composer — one fixed input, one cursor, one draft owner — and gives up the
empty state's identity line: no Session id/model welcome row and no Session
listing ever appear there. The Dock's ordinary status content is untouched by
this surface (session title, todo count, compaction phase, attention and visual
rows keep painting as before): "Main only" constrains where the *empty state*
lives, not everything the Dock may show.

```text
the application's formal idle commit (no Session yet)  -> sessionless
SurfaceRuntime.repaintTarget() for the live MAIN subject
   SessionReader.blank(sessionId) === true
   AND the fold holds no turn activity at all           -> blank-session
anything else (a started turn, an unknown read, a
   viewed child, the hydration window)                -> hidden
```

- The one blank authority is `SessionReader.blank` (Direct: the official
  turn-boundary projection; Remote: the official Client session-summary bit).
  An unknown read is never inferred from the rendered window, a row count or a
  running state, and the bounded display window is never the history: a fold
  that already carries a turn vetoes the empty state, while an empty window
  alone never proves blankness. The veto reads the fold's own turn *activity*,
  not its rendered turn index: a Session whose `turn/start` has been applied
  but which has produced no displayable row yet is already started, and a stale
  `blank:true` summary must not keep the Welcome — or its live Resume action —
  over it. On Remote that bit exists only once the session
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
- Each negotiated capability gates exactly the node it enables and nothing
  else: `el`+`styles` unlock the styled stage, the `icon` kind alone unlocks
  the action's leading icon, and the Browser's own picker vocabulary decides
  whether the action is operable at all. A pane missing one of them keeps the
  rest and is never sent a node it cannot paint.

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
- TSP now consumes the shared canonical transcript structure for native Full
  and Compact presentation. Focus still does not have a PiTui-equivalent TSP
  presentation, and some native disclosure interactions remain limited; Full
  and Compact support does not establish full PiTui feature parity.
- Physical GUI, IME, the desktop font stack, wheel/trackpad, the real OS
  window theme/chrome and Remote TSP qualification are outside the automated
  contract; only a specific real-pane run may claim them. The client's own
  light/dark appearance is headless-controllable (`appearance`) and is covered
  by the real-pane harness, not by this list.
- No Remote TSP renderer is claimed; a Remote TSP projection observer over the
  real wire remains a follow-up (see the repository handoff issue).
