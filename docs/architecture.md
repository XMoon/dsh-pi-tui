# Architecture: controller ownership

> **Status: PLAN — no extraction has happened yet.** The "Target controllers"
> below are a design for future commits, not a record of completed work: as of
> 2026-08-17 no `RunnerLifecycle`/`SessionController`/`InputDispatcher`/
> `OverlayController`/`CommandRegistry`/`StatusController` class exists in
> `src/` (verified by grep), and both `src/tui-app.ts` (~3.2k lines) and
> `src/index.ts` (~3.0k lines) keep growing. Mark an item DONE here in the
> same commit that extracts it; until then treat the table below as the
> extraction order, not the current state.

The behavior work is complete; this document records the OWNERSHIP map for
the large modules so future extractions follow it one responsibility at a
time — each move in its own commit, no "god Context" with dozens of mutable
fields.

## Current surface

| Concern | Lives in | State it owns |
|---|---|---|
| Layout, rendering, input routing, overlays | `src/tui-app.ts` (`TuiApp`) | messages, messageComponents render cache, themeRevision, expandedOverride, search overlay, status/todo/dock/queue state, working indicator |
| Transcript folding / projection | `src/transcript.ts` | incremental read grouping, assistant/thinking entries, pending calls |
| Exit contract | `src/exit.ts` | flushWithTimeout (pure, tested) |
| Detached tasks | `src/detached.ts` | runDetached rejection classification (pure, tested) |
| Diagnostics | `src/diag.ts` | file/stderr sinks |
| Model menu | `src/model-menu.ts` | per-open disposed latch + AbortController |
| Commands | `src/commands.ts` | command registry, skill disposers (generation-checked) |
| The runner | `src/index.ts` (`apply`) | everything else: lifecycle controller + cleanup, session generation, callArgs, search state, local shell (`!` submits its command+output to the session via `shell-context.ts`; `!!` stays local), external editor, event firehose |

## Target controllers (extraction order, one responsibility per commit)

1. **RunnerLifecycle** — start, cleanup (idempotent), lifecycle abort, exit
   order (block input → flush with timeout → record → cleanup → exit),
   detached-task accounting. Already has its primitives (`exit.ts`,
   `detached.ts`, the runner's `cleanup()`); extraction = moving the runner
   closure's lifecycle block into a class with an explicit dependency
   interface (`{ diag, app, signal }`).
2. **SessionController** — create/resume/switch, `sessionGeneration` bump +
   per-session teardown (callArgs, search, expansion overrides),
   write-fence wiring, event subscription. Depends on
   `submit-ack.ts` / `submit-latency.ts` (already pure) and the generation
   accessor (already on `TuiCommandRunner`).
3. **InputDispatcher** — editor submit, shortcuts (Ctrl+S/Alt+↑/Esc), local
   shell routing (`!` context vs `!!` local lives in `shell-context.ts`,
   already pure). Depends on `bounded-output.ts` / `shell-words.ts` (already
   pure) and `TuiApp`'s event hooks.
4. **OverlayController** — settings/model/question/approval/search mutual
   exclusion and stacking. `TuiApp` currently owns overlay handles; the
   controller would own the stack rules and leave rendering in `TuiApp`.
5. **CommandRegistry** — slash-command lifecycle and skill refresh
   generation checks (the race fix already lives in `commands.ts`).
6. **StatusController** — header/footer/dock/todo/queue incremental updates
   (semantic state → render at theme revision; the re-render plumbing is
   already in `TuiApp.repaintAllSurfaces`).

## Rules

- No single controller holds a "universal Context" of mutable fields; each
  controller declares the state it owns, its `dispose()` method, and a
  narrow dependency interface.
- `TuiApp` keeps layout and rendering; it never owns session-service
  lifecycle.
- Move exactly one responsibility per commit; the diff must stay reviewable
  and the headless suites green at every step.
- Behavior fixes land BEFORE extraction (the completed work did this); the
  remaining moves are pure restructuring with no behavior change, so each
  one is verified by the unchanged suites.
