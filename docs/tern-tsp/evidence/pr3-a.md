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
  → resume hint → appExit(0)                       [the NORMAL exit path]
```

The owners differ per path, and only the normal exit runs in this order:

- **normal** (quit key / `/exit`): the exit controller awaits the teardown
  transaction, prints the resume hint and requests `appExit`. The full Direct
  owned-session retirement and the transport disposal are NOT awaited in front of
  `appExit` — they run inside the application-tree disposal that `appExit`
  starts (under the DSH process-shutdown watchdog); the exit controller brings
  only the FIRST cancel forward through the injected `prepareRetirement`
  (`sessionRuntime.preCancelOwnedSession`).
- **fatal** (`handleStartupFailure`): the SAME `disposeSurface` authority, then a
  BOUNDED retirement wait (cancel-first, 2 s bound) before its own exit — an
  error outcome, never a resume hint.
- **HMR / fiber unload** (`registerRunnerDisposal`): the teardown transaction is
  awaited, then the memoized retirement settles, then the selected transport is
  disposed — the unloading fiber observes the full teardown.

The TSP acquisition stage is part of that transaction: a quit that lands while
the SDK handshake is in flight is a CANCELLATION — the acquired renderer is
released, the boot stops (no `surface.start`, no PiTui fallback) and the exit
proceeds with the tty already restored.

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

## Implementation (this PR)

| Path | Responsibility |
|---|---|
| `src/app/surface/display-seam.ts` (new) | `SurfaceDisplaySeam`: the renderer-facing commit surface — transcript projection (+ the PR2 opaque `source` token), aggregated status facts, session resets, notices/dock notices, welcome, pending input, the two reads (`getSessionTitle`, viewer generation), and the capability flags (`supportsTaskCenter`/`supportsViewer`/`supportsModals`). Semantics stay owned by the existing application owners. |
| `src/app/surface/display-seam-pitui.ts` (new) | The PiTui adapter (thin delegation over the mounted `TuiApp`; `resetSessionFacts` keeps the ORIGINAL clear set — title/todo are re-derived by the new owner's own hydration, a clear in between raced them in a full-run ordering). |
| `src/tui/tsp/session.ts` (new) | The TSP renderer: the ONE SDK tty owner (official `connect` before PiTui), one `inline` surface (`main` transcript + `dock` banner/status/notices), the seam implementation, the quit-key input loop (the only PR3-A input intent), and the one-shot `surface.close({keep:false})` + `session.close()` disposal. |
| `src/tui/tsp/transcript-view.ts` (new) | The PR1 mapper moved verbatim into the production renderer; `scripts/support/tern-tsp-transcript-view.ts` re-exports it (one oracle, no second copy). |
| `src/app/surface/runtime.ts` | `SurfaceRendererMount` (an already-connected renderer the composition root hands to `start()`); the seam wiring (`display` getter; event-routing/status/session-presentation/task/interaction commit through it); the renderer branch in `start()`/`dispose()`; capability-gated Task-Center commits. |
| `src/app/bootstrap.ts` | The ONE renderer selection (`DSH_PI_TUI_RENDERER=tsp` → lazy SDK import → `connect()`; `null`→PiTui unchanged, throw→fatal catch); the TSP branch skips the PiTui-only chrome boot steps (keymap/theme/footer, plugin keybinds, extension seams, focus reporting, editor recall seed) per the A0 classification. |
| `src/app/surface/interaction-runtime.ts` | On `supportsModals === false`, `attach` registers the LEGAL fail-closed answerers (approval→`'unavailable'`, question→`next()` delegation) and pins the observable dock notice — no auto-approve, no hanging promise, no fake modal. |
| `package.json` | `@stencil-hq/tern@0.1.0` moved to `dependencies` (the lazy product import resolves from the profile install; the default path still never loads it — the tarball keeps it external, see the pack evidence below). |

## Test matrix (scripted tty — the real-pane smoke follows)

`test/tern-tsp-renderer-selection.test.ts` (12) + `test/tern-tsp-live-mount.test.ts`
(16) drive the PRODUCTION primitives: the real selector/connector, the real
`SurfaceRuntime`, the real `createSurfaceLifecycle`/`createExitController`, and a
real SDK session over a scripted pane. Only the legitimate boundaries are
replaced — the SDK `connect` call and the tty behind it.

| Guard | Invariant it pins |
|---|---|
| A-01 | opt-in + shipped-SDK connect success ⇒ the TSP renderer mounts, `surface.app` throws (no TuiApp), the SDK owns raw mode, the surface opens on the real wire, and a routed message renders |
| A-02 | `connect() === null` ⇒ no renderer mount; the PiTui `TuiApp` mounts and renders; no TSP `o`/`f` after the declined probe |
| A-03 / A-03b | without the opt-in (or with only `TERM_PROGRAM=tern`) the production selection never invokes the connector; the default PiTui mount runs |
| A-07 (selection) | a connector THROW propagates — never mapped to `null`/fallback (the runner fatal path owns it) |
| L6 composition | the FULL runner with the opt-in on a non-TSP environment still mounts PiTui end-to-end |
| A-04 / A-04b | cold hydration renders the first frame; a tool settle updates the same node; a live delta rides an SDK `text` op; the quit key (`q`/Ctrl+C/Ctrl+D) routes the exit intent and ordinary keys never do |
| A-05 | the generation bump raises `Loading session…`, and a repaint still reading the OLD fold is FENCED (no frame at all) until the new owner's own commit under a NEW source token renders |
| A-06 | a same-id fold replacement re-scopes into a FRESH node namespace (top-level keys carry a new `s<n>-` prefix); an ordinary delta stays inside the CURRENT namespace |
| A-07 (dispose) | dispose closes the SDK surface (`x keep:false`) exactly once, restores raw mode exactly once, and a late projection after dispose frames nothing |
| A-09 | ≥8 consecutive notices keep unique SDK dock keys — no `ViewError: duplicate child key` |
| A-10 | the joined pending presentation actually RENDERS: queued rows, the ordered tail (user status suffix), the non-user Context identity |
| A-11 | a REAL SDK iterator failure (a node `onAction` handler that throws) routes that exact error INSTANCE to the FATAL intent, never a normal exit intent |
| A-12 / A-12c / A-12d / A-12b | the failure-path release: a rejected mount closes the connected session exactly ONCE; a secondary tty-restoration failure never replaces the primary error; a MOUNTED teardown preserves BOTH close failures (`AggregateError`, first in position); the production handshake releases a mount a real `surface.start` rejected, idempotently |
| A-13 | the hydrate-tail reset keeps the just-committed status facts; a partial commit preserves siblings; an explicitly-present `sessionTitle: undefined` CLEARS (PRESENCE semantics) |
| A-14 | `surface.commitStatus` writes the shared StatusStore on the TSP branch (both renderers consume the same facts) |
| A-08 / A-08b | the read-only renderer advertises `supportsModals: false` with an observable dock notice; the REAL interaction owner's fail-closed registration resolves an approval `'unavailable'` and delegates a question to `next()` |
| F1 / R2-1a-c / R3-1a-b / R4-1 / R4-1b | the surface teardown transaction: it is published BEFORE the ordered batch and settled with its COMPLETE outcome (renderer release + the ACQUISITION stage + batch failure), so the exit/fatal/fiber paths — including a SYNCHRONOUS re-entrant caller reached from an abort listener — all await the same release before hint/`appExit`, and every caller observes the same failure. A sibling that legally `throw undefined` is still a FAILURE (R4-3/R4-3b), never a silent success |
| F8 | the PUBLIC settle-compaction surface keeps its three-setter structural contract (the aggregated seam stays internal) |

Guards outside these two files own the adjacent PR3-A invariants:

| Guard | Invariant |
|---|---|
| `test/tern-tsp-live-projection.test.ts` (F10, R2-2) | the PiTui transcript still scrolls only on NEW own input; one semantic commit produces exactly ONE store transaction (the child subject and its activity together) |
| `test/a5-composition-inventory.test.ts` | the composition zone (entry + facade + every nested `app/bootstrap/**` helper, `renderer-selection.ts` included) still owns the surface teardown and keeps the documented release order |
| `test/settings-footer-teardown.test.ts` | the settings owner releases ONLY the Pi footer runtime it actually armed: an unarmed runtime (the TSP branch, or a teardown before the boot applied the document) never reads the app; an armed one releases exactly once |
| A-08 / A-08b | the unsupported-modal notice is re-published at EVERY unsupported request, so a refusal stays observable after the hydrate-tail reset or ordinary-notice eviction cleared the attach-time notice (the request itself is the carrier) |
| `test/notification-wiring.test.ts` | focus reporting is enabled at mount and disabled on EVERY exit path — before the app dies |
| `test/rules.test.ts` | every production `void <promise>` discard is in `runtime/process/tasks.ts` or carries an explicit `allowlist` marker |
| `test/temp-hygiene-gate.test.mjs`, `scripts/check-host-keybindings.mts` | the required repo gates the renderer's fixtures and dock banner must satisfy |

## Validation snapshot

Worktree `feat/tern-tsp-pr3-a-live-mount`, at the commit carrying this file:

- `pnpm verify:prepush` — exit 0 end to end: `typecheck:fork` + `typecheck:bench`,
  `test:fork` (1195), `test:docs`, `test:tooling` (364), the architecture /
  boundary / keybinding / naming / session-event / installation-doc /
  pi-divergence / pi-vendor gates, `pnpm audit`, and `pack:release`
  (`clean` + `build` + `typecheck:bundle` + `test:product` **7452/7452** + the
  eight public-package smokes).
- `pnpm build` — exit 0; the lazy `session-*.mjs` chunk imports
  `@stencil-hq/tern` as an EXTERNAL (the default `index.mjs` contains no SDK
  reference; `DSH_PI_TUI_RENDERER` never loads it unset).
- `tsc -p tsconfig.json --noEmit` / `tsconfig.bench.json` — exit 0.
- `node --test` tern-tsp-renderer-selection (12) + tern-tsp-live-mount (16) =
  **28 pass / 0 fail**.

## Real Tern pane smoke (manual, headless `tern serve` + `tern ctl`)

Method: the PR1 recipe — `tern serve --control /tmp/tern-pr3a.sock --out
/tmp/tern-pr3a-shots`, then a scenario file (`run "…"`, `wait`, `expect`,
`shot`, `key q`). Profile: a temporary `~/.dsh/profiles/pi-tui-pr3a` linking
the worktree checkout (`@xmoon76/dsh-pi-tui` → `link:…/dsh-pi-tui-tern-tsp-pr3a`,
SDK resolving from the worktree's `node_modules`). Versions: Tern `0.6.2
(4b3ed42)`, `@stencil-hq/tern@0.1.0` (moved to `dependencies`), DSH
`0.2.0-rc.2`, worktree build `dist/`. NOT in CI (needs the Tern binary) —
this is the recorded manual proof.

| Case | Result | Evidence |
|---|---|---|
| Opt-in deferred start (`DSH_PI_TUI_RENDERER=tsp`, no session) | **DONE on the build below; OPEN on the current one — see "Pane re-run"** — real hello reply, `o` open, dock frames acked; the renderer stays live (no fatal); the read-only banner (which names the bare `q` quit key — the chord-labelled form is deliberately not rendered: this renderer owns no keymap to route a chord label through, and the host-keybindings gate closes its sanctioned-seam list to the keybinding authority tree) AND the fail-closed modals notice render natively in the dock (screenshot `live2.png`); `expect` on the banner times out by design (the dock is native chrome, not grid text — the recording is the evidence) | rec: `q hello` → `r hello` (kinds 45, features incl. dock/settle/adopt, credits 2) → `o s1 inline` → `f s1` dock banner → `f s2` modals notice → acks |
| Command registration under TSP | **DONE** — no crash; the completions install degrades to diagnostics: `command completions install skipped: no PiTui editor surface` (twice: initial + skills install); the command catalog itself registers | diag log (`INFO` lines) |
| Resume with a bad session id | **DONE (legal failure path)** — `resume failed … not found` surfaces through the seam as a dock notice (`! session … could not be resumed: … not found`), no fatal, no PiTui fallback | rec3: `f s2` adds `dock.notice-n0` with the failure text |
| Resume of a REAL persisted session (`--session session-823a…`, seq 167) | **DONE** — `resume ok seq=167`; 3 frames carry **168 `main.*` node ops**: the historical transcript (assistant markdown cards, tool rows) renders natively through the PR1 mapper; the dock shows the welcome facts (`DSH session … · ollama/deepseek-v4.1-flash:cloud`), the session title (`Rust GUI`) in the status line, the read-only banner (which names the bare `q` quit key — the chord-labelled form is deliberately not rendered: this renderer owns no keymap to route a chord label through, and the host-keybindings gate closes its sanctioned-seam list to the keybinding authority tree) and the modals notice | rec4 (10 lines); screenshots `resumed-full-id.png` (post-close scrollback) and `live-now.png` (the LIVE native render: assistant card + `/copy` receipt + dock) |
| Quit key (`q`) | **DONE** — `q` routes the exit intent; the wire shows `x {"id":"s1","keep":false}` exactly once, raw mode restored, the process exits and the shell prompt returns; no protocol bytes leak to the shell (unlike the earlier failed runs, where a fatal teardown left ack/resize events echoing into the grid) | rec4 tail; pane usable afterwards |
| Earlier fatal teardown observation (fixed) | The first smoke runs exposed the two boot-sequence couplings (§A0.3b rows 5 and 8) — after the fatal, `x keep:false` fired but a `resize` event then ECHOED into the cooked shell (`pi-tui-pr3atsp e:{"ev":"ack"…}` garbage in the grid). With the fixes the teardown is clean; the SDK's own 50 ms input drain (DRAIN_MS) covers late events | screenshots of the failed runs (kept for the record) |

### Pane re-run on the teardown/qualification delta — OPEN defect

The rows above were recorded on the `748589ca` build (its `dist/`, the profile
linked to that worktree). A re-run on the `3d2cd24d` build does **not**
reproduce the deferred start: the same command fails before the mount is
reached, and the teardown itself throws:

```text
ERROR cleanup failed error=the surface is not mounted              (the exit controller)
ERROR surface dispose failed error=the surface is not mounted      (the fiber/fatal recorder)
ERROR fatal error=the surface is already disposed
      at Object.start (dist/index.mjs) / at startRunner (dist/index.mjs)
```

An instrumented run shows an `exit` intent reaching `createExitController`
**before** `surface.start`: the exit tears the surface down, so `start()` finds
it already disposed and the startup root reports a FATAL, while the pre-mount
teardown reads the not-yet-mounted surface and fails too. The exit caller inside
that window was **not identified by an entry stack** at that time. The window is
scriptable — a queued SDK key decoded with the handshake, or a held handshake plus
a real fiber unload, reproduces it deterministically — and
`test/tern-tsp-runner-teardown.test.ts` now guards it at the PRODUCTION level
(the real connector → real surface/lifecycle/exit through `mountRunner`).
What remains outstanding for this stage is the LIVE-consumption gate below, not
this window.

Provenance of this record, kept explicit:

- the three logged errors above were observed on the `3d2cd24d` build (the range
  in which they reproduce is that build);
- the acquisition/cancellation fixes landed after it (`012eae25`, `9f1fce73`,
  `b0832be1`, `3c9b1e08`) and a **complete capture on the current build now
  exists** — see below;
- the rows above therefore remain recorded on `748589ca`.

#### Current-build pane capture (complete)

`3c9b1e08` + a fresh `dist/` (from `pack:release`), temporary
`~/.dsh/profiles/pi-tui-pr3a` linking this worktree, headless `tern serve --control
… --out …`, scenario `deferred start → wait → shot → key q → wait → shot → shell
echo`. The full diag record (`$DSH_HOME/logs/pi-tui-<pid>.log` — see the recipe
note below) reads:

```text
INFO  boot pid=49503 dsh=0.2.0-rc.2 … session=(deferred) preset=default services=…settings,skills,userQuestions,approval,permissionPresets
INFO  skill catalog standing ready preset=standard skills=6 complete=true
INFO  tsp renderer selected
INFO  tsp renderer: quit key key=q
INFO  exit code=0
INFO  retire complete failures=0
```

No `fatal`, no `cleanup failed`, no `surface dispose failed`, no `the surface is
not mounted` — the two defects recorded above (the unconditional Pi-footer read
and the pre-mount exit FATAL) are absent on the current build, and the exit is
clean (code 0, retirement `failures=0`). The pane rows above are therefore the
recorded history of `748589ca`; the current build's evidence is this capture.

Recipe note (a testing fact for THIS launch path, not a universal launcher claim):
in this pane launch the `DSH_PI_TUI_LOG` given on the command line did not reach
the app (`bootstrap.ts` still resolves it with `diagFromEnv(process.env)`), so the
diag landed on the DEFAULT `$DSH_HOME/logs/pi-tui-<pid>.log`. Read the file matching
the pane's own PID for a complete capture — the pane's scrollback is not a
substitute (it truncates and buffers).

Read-only live updates: the resumed-session smoke proves the FULL chain (fold →
canonical structure → PR1 mapper → SDK surface → real Tern render, ack loop
under credits:2). **This is an UNMET acceptance gate**, not a scope hand-off:
the plan requires the renderer to consume a real ongoing / resumed / externally
produced event, and read-only does NOT mean replay-only. A current-build live
tool/delta consumption record is still missing, and PR3-B's future interactive
turn is not a substitute for it.

### Known limits (recorded, not claimed done)

- **Pane history vs current build:** the three logged errors (`cleanup failed` /
  `surface dispose failed` / `fatal … already disposed`) belong to the `3d2cd24d`
  build. The fixes landed after it and the CURRENT build has a complete capture
  with none of them (see "Current-build pane capture"), plus the production-level
  guards in `test/tern-tsp-runner-teardown.test.ts`.
- The lanes above are the LOCAL stage-final pass. CI has not run for this branch,
  and the published-DSH compatibility lanes (`compat:dsh:npm`,
  `compat:dsh:client-family`) plus the migration smokes (`smoke:remote-*`,
  `smoke:boundary`, `smoke:startup-strictness`) are a separate stage-final step.
- A real interactive turn (live streaming deltas through a real agent) is not
  driven in the manual smoke; the scripted A-04 / A-05 pin the same-node delta and
  hydration-fence contracts. This does not close the live-consumption gate stated
  above.
- `TERN_TSP=0` and tmux-style fallback evidence is inherited from the L6
  composition fallback test plus the SDK's own decline semantics.
