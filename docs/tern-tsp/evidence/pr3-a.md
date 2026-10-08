# Tern TSP PR3-A evidence — single-tty read-only live mount

> **Status: IN PROGRESS** — this file is the A0 audit deliverable first; the
> test matrix, real-pane smoke and review ledger are appended as the stage
> progresses. Historical PR1/PR2 evidence is never rewritten (see
> [pr1.md](./pr1.md) / [pr2.md](./pr2.md)).
>
> **Plan:** `temp/tern/dsh-pi-tui-tern-tsp-pr3-two-stage-code-plan-v1-20261008.md`
> (PR3-A section). **Overall:** `temp/tern/dsh-pi-tui-tern-tsp-overall-roadmap-v1-20261008.md`.

## A0 — implementation reachability inventory (the freeze gate)

Baseline: `next @ 11b0e106` (worktree `feat/tern-tsp-pr3-a-live-mount`,
`origin/next` 2026-10-09). All line numbers below were re-read on this tree;
the plan's own line references were treated as stale hints only.

### A0.1 What `SurfaceRuntime` mounts today (FACT)

- `src/app/surface/runtime.ts:1549-1581` — `start(deps)` builds a
  `TuiAppEvents` overlay and calls `startProcessTui(events, options)`
  (`src/tui-app.ts:19348`): `new TuiApp(new ProcessTerminal(), …)` +
  `app.start()`. `ProcessTerminal` (`packages/pi-tui/src/terminal.ts:182`)
  owns `process.stdin` raw mode + the resize listener. `claimProcessTuiSlot`
  (`src/tui/process-slot.ts`) enforces one live TuiApp per process.
- `surface.app` is hard-typed `TuiApp` (`runtime.ts:321,1404`); every
  application owner reads it back after `bootstrap.ts:2371`
  (`app = surface.app`).
- The ONE transcript projection chain (`repaintTarget`, `runtime.ts:816-840`)
  does `controller.setTurns` → ONE `folder.window()` → `mounted()
  .setTranscript(...)` → optional PR2 `onTranscriptProjected` observer with the
  four-part target re-check. This chain is renderer-neutral except for the
  `mounted().setTranscript` commit.

### A0.2 Caller-family audit — who touches `TuiApp` and whether read-only TSP must serve it

Method-call counts are per call site (grep-verified on this tree).

| Caller family (file) | Trigger | Calls | Necessary while A is read-only TSP? | Owner decision |
|---|---|---|---|---|
| `bootstrap.ts` mount block (2236-2440) | startup, always | `surface.start`, `app = surface.app` | **YES** (the mount is the renderer choice point) | renderer selection lives here (composition zone) |
| `settings-runtime.ts` (`applyBootDisplay`, `applyFooterSettings`, footer setters) | startup always (`bootstrap.ts:2433-2435`) | 46 | **NO — PiTui display-preference restoration** (fullscreen/theme/wheel/footer chrome; Tern owns its own theme via `caps.dark`) | TSP branch skips the boot-display/footer application at the composition point; NOT an unsupported capability |
| `surface/extension-runtime.ts` (`bindPluginKeybinds`, `attachSeams`) | startup always (`bootstrap.ts:2403`, `2395→surface.attachSurfaceSeams`) | `setPluginKeybindingRules`, `requestRender`, PiTui `Text` header/dock/footer host attach, advanced/unstable seams | **NO — PiTui chrome/keymap/extension surface host** (extension overlays are PiTui Components; TSP-A cannot present them) | TSP branch skips `bindPluginKeybinds` + `attachSurfaceSeams`; extension *services* still load, their UI seams are simply not attached |
| `surface/interaction-runtime.ts` (`attach`) | startup always (`bootstrap.ts:2927`) | `showApprovalPrompt`, `askQuestions`, `setSettledQuestionAnswersLookup`, `notify` | **POSSIBLY REACHABLE (A2 hard requirement)** | Do NOT attach the interactive answerer in TSP-A: the official waterfall then fails closed (`ApprovalPolicy 'ask'` + no composed answerer → `'unavailable'`; question timed wait times out into the official continued/late-answer lifecycle — both are the port's *legal* unavailable mechanisms). The TSP dock must SHOW that a request arrived and is not answerable here (observable, no fake answer, no swallowed promise) |
| `surface/session-presentation.ts` (`hydratePresentation`, `resetForGeneration`) | cold hydrate / resume / switch / rehydrate — **always** | `setPlanMode`, `setWorking`, `setBusy`, `setSessionTitle`, `setTodoSummary`, `clearLocalMessages`, `clearNotify`, `clearExitConfirmation`, `resetInputHistory`, `setSearchResult(0,0)`, `clearSessionOverrides`, `scrollToBottom/Top`, `surface.repaint()` | **YES (status facts + resets)**; scroll/history/search are viewport chrome | status facts + resets enter the display seam; `scrollTo*` are terminal-owned in TSP (no-op); input-history recall is editor-only (no-op) |
| `surface/event-routing.ts` | durable events, always | `setBusy`×4, `setWorking`×3, `setCompactionPhase`×3, `setSessionTitle`, `setTodoSummary`, `setPlanMode`, `notify` | **YES** | seam |
| `surface/task-runtime.ts` | registry/subagent events (background, reachable) | `notify`×11, `setAgents`×4, `setTasks`×2, `setTaskSummary`×2, `setQuestionAttention`, `openTaskBrowser`, `openOutputViewer` | `notify` **YES**; roster/summary = Task-Center chrome **NO**; `open*` are input-gated **UNREACHABLE** | `notify` enters the seam; Task-Center data calls stay PiTui-only and are gated by the seam's `supportsTaskCenter` capability (skipped, not faked) |
| `surface/viewer-runtime.ts` | user-triggered (↓/`/tasks`) **and event-driven auto-pop** | `setViewerMode`, `getViewerGeneration`, focus-scope trio, `getDraft`/`setEditorText`/`restoreSubagentDraft`, `clearLocalMessages`, `clearNotify`, `notify` | auto-pop **CAN fire in A** | the viewer is a PiTui presentation; in TSP-A the auto-pop entry is declined by the viewer owner through a narrow capability check (`display.supportsViewer === false` → stay on main + dock notice). No draft APIs are reachable (no editor input) |
| `surface/status-runtime.ts` | startup + provider/goal events | `notify`×5, `setWelcomeCard`×2, `setWelcomeIdle`, `setTerminalCwd`, `getSessionTitle` (read) | **YES (welcome + title/cwd facts)** | seam (welcome card → TSP `main` initial content; title → surface title / dock; `getSessionTitle` read moves into the seam) |
| `surface/input-history.ts` (`activateBootRecall`, `persist`) | startup always / submission | `resetInputHistory`, `notify` | recall **NO** (editor-only); `notify` YES | `resetInputHistory` no-ops on TSP (harmless, still seam'd); `notify` seam |
| `submission/controller.ts` | submit/steer/queue — all **input-gated, UNREACHABLE in A** (no editor) except background echo presentation via `refreshPendingInput` | `notify`×17, `getDraft`×13, `setEditorText`×11, `setSubmitPending`, `setDraft`, `clearSettledLocalMessages` | `notify` YES (async settle failures can still surface), rest UNREACHABLE | the draft/echo editor state stays PiTui-only; the seam carries `notify` + `setPendingInputPresentation` (background queue/steer from other clients IS visible in A) |
| `command/**` | `/` command input — UNREACHABLE in A (no input); async catalog results | `notify`×7, `insertIntoEditor`, `askSaveLocation` | `notify` YES; rest UNREACHABLE | seam carries `notify` only |
| `surface/application-events.ts` | the `TuiAppEvents` contract handed to `start()` — in TSP-A the SDK key loop replaces physical input; only `onExit` is wired (quit key) | `getDraft`, `insertIntoEditor`, `submitDraft`, `isFullscreen`, `setFullscreen`, `startTranscriptSearch`, `notify` | **NO input events can fire** (no PiTui input); the table is still constructed | the events table is constructed once and handed to whichever renderer mounts; in TSP-A only the exit path is exercised (via `lifecycle.requestExit`), matching A4 |
| `bootstrap.ts` direct `app.` uses | resume-failure notice, `getViewerGeneration` (image-scope key), draft merge (paste/queue paths) | `notify`×4, `getViewerGeneration`, `getDraft`, `setEditorText` | `notify` YES; viewer-generation is keyed by the viewer owner (TSP-A: viewer never opens → single stable generation source needed); draft paths input-gated UNREACHABLE | `notify` seam; `getViewerGeneration` — the image scope key needs a viewer-generation authority that exists without TuiApp: the surface seam exposes the same counter semantic from the surface owner (the viewer owner bumps it), OR the TSP-A branch keys child scopes by session id alone (viewer never mounts). Chosen: expose `getViewerGeneration()` on the seam backed by the SURFACE's viewer-generation counter, which the viewer owner bumps — one authority, two renderers read it |

### A0.3 Terminal-writer audit — who else writes stdout after mount (TSP: the SDK owns the tty)

| Writer | Path | TSP-A decision |
|---|---|---|
| PiTui renderer | via `ProcessTerminal` | absent (no TuiApp mounted) |
| startup status (`Starting DSH…`) | `src/tui/startup/status.ts` → injected output | pre-mount only; cleared before the mount — keep (finishes before SDK handshake; the handshake happens inside `surface.start` position) |
| terminal notifications (OSC 9/777/bell) + focus reporting (CSI ?1004) | `src/tui/notification/runtime.ts` over the guarded writer | **disable in TSP-A**: ANSI writes onto the SDK-owned tty can interleave with APC frames; completion notices route to the seam (`notify` → dock) |
| terminal title (OSC 0) / cwd (OSC 7) | `src/tui/terminal/title.ts`, OSC 7 in status-runtime | **suppress in TSP-A**: the SDK surface carries its own title; extra OSC writes onto the same tty are unproven against frame interleaving. Facts still computed (seam `setSessionTitle`) |
| OSC 52 clipboard | `surface/client-actions.ts` | input-gated (`/copy`, drag-selection) — unreachable in A; no change |
| exit resume hint (`process.stdout.write('\n…')`) | bootstrap exit controller | runs AFTER the SDK session closed (teardown order below) — safe, keep |

### A0.3b Boot-sequence walkthrough (added after the first real-pane smoke)

The first real-pane smoke (below) exposed that the §A0.2 family table alone
under-classified ONE shape of coupling: **synchronous startup steps between
`surface.start()` and the end of `startRunner()` that read the mounted app
immediately**, independent of any user input. The complete ordered walkthrough
of that window (re-verified line by line):

| # | Step (bootstrap.ts order) | Reads app? | Reads display seam? | TSP-A decision |
|---|---|---|---|---|
| 1 | `surface.start({…})` deps object (all closures; `getViewerGeneration` is read lazily at child-open time) | no | `surface.display.getViewerGeneration()` (lazy) | fine (seam read) |
| 2 | `app = surface.app` + boot chrome (keybindings, user keys, plugin keybinds, extension seams, focus reporting, boot display, footer, recall seed) | YES (the assignment itself) | — | **skipped on TSP** (`if (!tspRenderer)` block); `app` stays `undefined` |
| 3 | `status.refreshTerminalTitle()` / `refreshTerminalCwd()` | no | `display.getSessionTitle()`, `display.setTerminalCwd()` | fine (seam) |
| 4 | `surface.attachEventRouting({…})` (an object of closures) | no | — | fine |
| 5 | `surface.attachTasks({…})` + `surface.refreshPendingInput()` | no (after fix) | `display.setPendingInputPresentation` | **fixed**: the eager `mounted()` inside refreshPendingInput became a seam commit + a PiTui-only `app?.scrollToBottom()` |
| 6 | `command.attachRuntime()` — builds the runner facade (`app: () => app` closure) | only when invoked | — | the facade stores the accessor; on TSP `app` is `undefined` |
| 7 | `presentation.initLiveSession(...)` / `initRemoteLiveSurface(...)` / deferred branch (`setWelcomeIdle`, title/cwd refresh) | no (after fix) | seam commits (status facts, welcome, resetSessionFacts) | fine |
| 8 | `command.register({snapshot, skills})` — **boot-mandatory**: installs completions (`app.setCommandCompletions`) and collision notices | YES (immediate) | — | **guarded**: `TuiCommandRunner.app` widened to `TuiApp \| undefined`; the completions install and the collision notice degrade to diagnostics (`command completions install skipped: no PiTui editor surface`); the command CATALOG still registers, executions are input-gated |
| 9 | `surface.attachInteraction(backend.interaction, …)` | no | `display.supportsModals` at attach | fine (fail-closed answerers, §A0.2) |

The two **fixed** rows are exactly what the first real smoke surfaced
(`fatal error=the surface is not mounted` from row 5, then
`command registration failed: … (reading 'notify')` from row 8). The registrar
type widening in row 8 stays honest because every remaining `app` consumer is
either a stored reference used only on input-gated EXECUTION paths (they
cannot fire without an editor) or an explicit-unavailability error
(`/settings`, `/help` panels).

### A0.4 Architecture decision (per plan §2.3)

**Chosen: option 1 — a minimal application-owned display seam + two concrete
renderer sinks.** The audit above shows the read-only-A *reachable* application
output is a small, stable set (~18 methods: transcript projection, status
facts, notices, welcome, session resets, pending-input presentation, one read
`getSessionTitle`, one viewer-generation read). Everything else is either
input-gated (unreachable without an editor), PiTui chrome (theme/footer/
keymap/extension surfaces), or modal (interaction). Therefore:

1. **`SurfaceDisplaySeam`** (new, `src/app/surface/`): the narrow
   renderer-facing write/read surface listed in A0.2's "seam" rows. Semantics
   stay computed by the existing owners; the seam is a commit surface only.
   PiTui implementation = thin delegation to the mounted `TuiApp`. TSP
   implementation = SDK `Surface.render({ main, dock })`.
   Capability flags (`supportsTaskCenter`, `supportsViewer`, `modality`)
   let owners *decline* PiTui-only features at their real entry points (an
   observable dock notice, never a silent no-op and never a second command
   path).
2. **Renderer selection at the ONE composition point** (`bootstrap.ts`, inside
   the existing `startRunner` async root, before `surface.start`): the
   experimental opt-in `DSH_PI_TUI_RENDERER=tsp` (checked against the repo's
   existing `DSH_PI_TUI_*` env family; no `TERM_PROGRAM` inference) triggers a
   lazy `import('@stencil-hq/tern')` + `connect()`. `null` → PiTui mount,
   unchanged. A throw → the existing fatal lifecycle (startup failure), never
   a fallback. The SDK import is dynamic so the default path never loads it
   (startup zero-dep island untouched; A-03).
3. **Rejected alternatives** (per plan): (a) a no-op `TuiApp`-shaped facade —
   the audit shows ~200 distinct call sites; a facade would silently swallow
   real business state; (b) per-module `if (tsp)` business forks — the seam
   keeps behavior differences inside the two renderer implementations; (c)
   omp-style dual-backend row/native coexistence — see
   `temp/tern/omp-tern-tsp-survey-20261009.md`: their optimistic-start +
   row-fallback model is exactly what our plan's stop-conditions forbid.
4. **No stop condition met**: the reachable-A set is small; no second fold,
   no second SessionPresentation, no `applyRunner` duplication. The seam
   refactor is mechanical and type-driven (owners keep their call shapes;
   `deps.surface.app` becomes the seam interface that `TuiApp` structurally
   satisfies for the seam subset).

### A0.5 Teardown contract (per plan §3.1 A4)

TSP-A teardown rides the EXISTING exit/fatal/HMR orchestration — no new signal
handling (the SDK's own `exitHooks` restore the tty on SIGINT/SIGTERM and
re-raise, as PR1 verified on the real pane):

```text
exit request (SDK quit key → lifecycle.requestExit, or /exit, or fatal)
  → surfaceLifecycle.disposeSurface (frozen §12 order, unchanged)
      → surface.dispose() now also: stop the TSP input loop →
        surface.close({keep:false}) → session.close()   [SDK tty released once]
        (the PiTui branch keeps its existing app?.dispose())
  → Direct owned-session retirement → transport disposal → appExit
```

The resume hint prints after the SDK released the tty (it is written by the
exit controller after `cleanup()`). Signal-path `keep:true` stays SDK-owned
(PR1-verified); we do not override it.

### A0.6 Hydration-window (Loading) policy (plan §3.1 A3)

PR2 recorded the switch window: a new `subjectId` can be observed while the
old fold's content is still displayed. The TSP renderer scopes by
`sourceIdentity` (===): a NEW identity ⇒ the renderer drops its retained view
and shows `Loading session…` until the first frame for that identity commits.
The identity is the PR2 frame's opaque token — the renderer never reads the
fold. Same-id fold replacement (cold rehydrate) also mints a new token, which
is exactly the re-scope trigger. No timers, no guessing from `subjectId`.

---

*This is the A0 freeze-gate deliverable (inventory, boot-sequence walkthrough,
architecture decision, teardown contract). The implementation, test matrix,
real-pane smoke and the review ledger follow in the next commit.*
