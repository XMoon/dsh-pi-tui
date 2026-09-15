# Fullscreen Focus replay harness

Investigation and regression tooling for the fullscreen Focus transient collapse
fixed by `fix(tui): keep transcript row refresh on the mounted component batch`.

Symptom it exists to catch: while a turn's final assistant message streams, with
Focus ON, fullscreen ON and every outer Thought root expanded, the composed
transcript height collapsed for one or two paints (`presentationRows` 51 → 24 →
52). `contentHeight` followed, `maxScrollTop` became 0 while `scrollTop` still held
the previous value, so the viewport clamped back to the top and momentarily showed
transcript that had already scrolled out, then recovered.

Root cause (context only — the fix and its regression test own the contract): the
fullscreen row-map refresh projected a **second, unmounted** transcript component
batch. That advanced the message-component cache ownership independently of the
batch still mounted in `messagesView`; `componentForMessage()` then disposed the
old component in place while it was still mounted, and a paint landing before the
next rebuild rendered the live-assistant container as zero rows.

The fix's contract is single-batch ownership: `rebuildMessages()` is the only
place that creates a transcript batch, it publishes the batch it mounts, and the
row-map refresh only re-measures those component instances. One exception to the
identity set: a block whose measured height is 0 keeps its component in the batch
but is never wrapped in a gutter, so it has no mounted row — the identity
invariant is over the batch's components, with zero-height blocks having no
mounted counterpart.

## What lives here

| Path | Role |
|---|---|
| `scripts/focus-replay-probe.mts` | Replay harness. Feeds a recorded assistant stream through the real production path (`TranscriptFolder.applyLiveInput` → Focus projection → `TuiApp.setTranscript` → `TuiAltScreen.doRender` → `Terminal.write`) at the original arrival timing, and records read-only evidence per paint, per flush and per transcript block. |
| `scripts/focus-screen-holes.mjs` | Screen-level oracle. Reads one probe artifact and reports `holes` (a run of rows blanking for a frame and returning at the same rows) and `abaAlternations` (frame *A* → *B* → *A*), i.e. a composed-frame flip that flips straight back. |
| `artifacts/focus-replay/*.json` | Probe output. Local run data (megabytes), excluded by the `artifacts/focus-replay/` `.gitignore` rule so runs never dirty the worktree. |

Neither script is production code: `tsdown` builds only `src/index.ts`, the test
runners collect `test/*.test.ts`, and the published `files` whitelist
(`dist`, `cordis.patch.yml`, `README.md`, `README.en.md`, `LICENSE`) contains no
`scripts` entry. They are investigation tooling that was used to localize the bug, and
the screen oracle is kept as a repeatable acceptance check.

## Preconditions for a valid run

A run is only meaningful when all of these hold; the probe establishes them
automatically and prints the result, and an unqualified run is invalid:

- Focus mode ON and fullscreen ON.
- **Every outer Focus Thought root expanded.** Ctrl+O is a bulk action (expand the
  most recent turns, or collapse all), so the headless path clicks each collapsed
  `🐋 Thought` header row (SGR mouse press + release) and scrolls older turns into
  view. A large exported history can stall that sweep, so every turn it could not
  reach is then expanded through exactly the operation a header click performs
  (the same `toggleFocusTurn` path); on a real `ProcessTerminal`, where the screen
  cannot be read back, that programmatic path expands every known turn outright.
  The result is a HARD GATE, not a report: the probe computes `allExpanded` over
  the folder's turns plus the final viewport's collapsed-root count, and **throws
  instead of producing metrics or an artifact when the precondition does not
  hold** (`stalled` is reported for diagnosis; the gate judges the turn-level
  state the stream actually starts from).
- Thinking detail left at its default (compact). Expanding it is a separate
  disclosure and changes what is measured.
- `followingEnd = true`.
- Production flush semantics: `REPLAY_FLUSH=coalesced` is the DEFAULT and mirrors
  the runner's `schedulePaint()` — apply the fold immediately and coalesce into
  one transcript rebuild per 50 ms. That applies to the live chunks AND to the
  durable events, which production delivers on the session/event firehose that
  also calls `schedulePaint()` (only permission-knob events skip the transcript
  repaint). The legacy `perevent` mode flushes the transcript for every delta, is
  **not** production-timing-faithful, and must not be used for conclusions.

## Usage

`REPLAY_SOURCE=trace` replays a provider delta capture (`REPLAY_TRACE=/path/to/trace.json`);
no trace file is shipped, the bare command fails loudly when the path is missing,
and a trace fixture streams turn 1 with no exported history. Prefer the exported
session, which carries real turns, real delta boundaries and real timing (restored
with the harness's own `expandAssistantStream`).

Exported-session replay of one message:

```sh
REPLAY_SOURCE=session REPLAY_SESSION=/path/session.v3.jsonl \
REPLAY_TURN=16 REPLAY_STEP=3 REPLAY_HISTORY=13,14,15 \
REPLAY_CADENCE=wallclock \
node --import tsx/esm scripts/focus-replay-probe.mts
```

Whole-turn replay (the shape that reproduces the bug: the turn's tool steps, their
durable settlements and the final text step, interleaved at their real times).
`REPLAY_TURN_MODE=interleaved` REQUIRES `REPLAY_SOURCE=session` — only an exported
session carries the compact whole-turn stream timeline, and the combination with
`trace` is rejected instead of silently falling back to a single stream.
`REPLAY_HISTORY` is honoured: those turns are applied durably first, so the
replay runs against the exported transcript rather than a synthetic fixture.

```sh
REPLAY_TURN_MODE=interleaved REPLAY_FLUSH=coalesced REPLAY_CADENCE=wallclock \
REPLAY_SOURCE=session REPLAY_SESSION=/path/session.v3.jsonl \
REPLAY_TURN=20 REPLAY_HISTORY=17,18,19 \
PROBE_LABEL=REPRO node --import tsx/esm scripts/focus-replay-probe.mts
```

Real terminal (direct, no multiplexer) — the probe then owns the TTY, so send its
diagnostics to a file:

```sh
REPLAY_TERMINAL=1 REPLAY_LOG=/tmp/replay.log REPLAY_SETTLE_BEFORE_STREAM=1500 \
REPLAY_TURN_MODE=interleaved REPLAY_FLUSH=coalesced REPLAY_CADENCE=wallclock \
REPLAY_SOURCE=session REPLAY_SESSION=/path/session.v3.jsonl \
REPLAY_TURN=20 REPLAY_HISTORY=17,18,19 \
node --import tsx/esm scripts/focus-replay-probe.mts
```

Screen oracle over a HEADLESS, `REPLAY_SYNC=on` artifact only:

```sh
node scripts/focus-screen-holes.mjs artifacts/focus-replay/REPRO-session-t20-wallclock.json
node scripts/focus-screen-holes.mjs /path/to/artifact.json --dump   # PRE / HOLE / POST screens
```

A real-terminal run records no xterm snapshots and `REPLAY_SYNC=off` strips the
`?2026` markers, so those artifacts have no screens or no synchronized-output
transactions. The oracle reports `usable: false` with a reason and exits non-zero
for them instead of printing a vacuous `holes = 0 / abaAlternations = 0`.

## Switches

| Variable | Meaning |
|---|---|
| `REPLAY_SOURCE` | `trace` (a provider delta capture; no fixture ships — see `REPLAY_TRACE`) or `session` (an exported session JSONL). A trace fixture streams turn 1 and has no exported history. |
| `REPLAY_TRACE` | Path to the trace file used by `REPLAY_SOURCE=trace`. |
| `REPLAY_SESSION`, `REPLAY_TURN`, `REPLAY_STEP`, `REPLAY_HISTORY` | Session file, target turn/step, and the turns applied durably first so the transcript has real history. |
| `REPLAY_TURN_MODE` | `singlestep` (default) or `interleaved` (whole turn: live chunks + durable events in real order/time). `interleaved` REQUIRES `REPLAY_SOURCE=session` and is rejected otherwise. |
| `REPLAY_SETTLE`, `REPLAY_SETTLE_EACH` | `REPLAY_SETTLE=0` skips the durable settlement that follows the live attempt: `REPLAY_SOURCE=session` + single-stream paths only (inert, with a warning, for `trace`; inert for `interleaved`, whose durable events are in the timeline). `REPLAY_SETTLE_EACH=1` paces one settle per event and applies **inside the `REPLAY_WINDOW` loop only**; anywhere else it is rejected. |
| `REPLAY_CADENCE` | `exact`, `wallclock` (absolute arrival targets, dispatch-lag logging, required by `interleaved`), `immediate`, `batched`. |
| `REPLAY_SPEED` | Speed multiplier for the arrival schedule; must be a finite number `> 0`. Honoured by the `REPLAY_WINDOW` loop (any cadence — its gaps are computed from the original offsets and divided by SPEED) and by the full `REPLAY_CADENCE=wallclock` stream; any other combination with `REPLAY_SPEED != 1` is rejected. SPEED is intentionally NOT implemented for `exact` (which does schedule at the original offsets — scaling it would be a policy choice, not a missing schedule), and it has no meaning for `immediate`/`batched`, which have no absolute schedule. |
| `REPLAY_LOOPS` | Whole-stream repetition; must be an integer `>= 1`. Honoured by the `exact` and `wallclock` full streams and by the `REPLAY_WINDOW` loop (any cadence); `immediate`/`batched` without `REPLAY_WINDOW`, and `interleaved`, are rejected. |
| `REPLAY_WINDOW` | Event window loop, honoured by every cadence (the window branch runs first); rejected with `REPLAY_TURN_MODE=interleaved`. **A window loop breaks markdown structure** (a half-open fence never closes) and is diagnostic only. |
| `REPLAY_FLUSH`, `REPLAY_FLUSH_MS` | `coalesced` is the DEFAULT (production scheduling: live chunks and durable session events share one rebuild per 50 ms); `perevent` = unfaithful legacy. `REPLAY_FLUSH_MS` must be a finite number `>= 0`. Overriding it is a diagnostic pressure knob, never production semantics. |
| `REPLAY_TERMINAL`, `REPLAY_LOG`, `REPLAY_SYNC` | Real `ProcessTerminal`; diagnostics to a file; `off` strips `?2026h/l` as a *diagnostic* for tearing comparison and is never a fix. |
| `REPLAY_COLUMNS`, `REPLAY_ROWS`, `COLUMNS_OVERRIDE`, `ROWS_OVERRIDE` | Virtual terminal size and the real-pane fallback size. |
| `REPLAY_SETTLE_BEFORE_STREAM` | Freeze (ms) between the disclosure precondition and the stream, so an operator can tell the automated expansion phase apart from the phase under test. |
| `REPLAY_THINKING` | `1` also expands Thinking detail (not the default and not required). |
| `REPLAY_PAINT_DETAIL`, `REPLAY_PAINT_BLOCKS`, `REPLAY_PREFIX` | Expensive read-only instrumentation: per-paint presentation/scroll state, per-block heights and component instance identity, and a byte-prefix terminal replay. Acceptance REQUIRES the default (on): with `REPLAY_PAINT_DETAIL=0` the presentation/L3-derived metrics (`liveBlockMissingPaints`, `liveDisappearancePaints`, `oldReappearancePaints`, `followEndPaints`, `followFreePaints`) are recorded as `null` (not measured) and `metrics.paintDetail` is `false`, so such an artifact is for pressure runs only. |
| `PROBE_LABEL` | Artifact name prefix. |

### Switch validation

The replay controls that would otherwise silently produce a vacuous run are
domain-checked AND combination-checked before any replay work:

- `REPLAY_SPEED` finite `> 0`; `REPLAY_LOOPS` integer `>= 1`; `REPLAY_FLUSH_MS`
  finite `>= 0`; `REPLAY_SETTLE_BEFORE_STREAM` finite `>= 0`.
- `REPLAY_TURN` / `REPLAY_STEP` positive integers when the session source uses them.
- `REPLAY_WINDOW` must be `"<from>-<to>"` with integer bounds `0 <= from <= to`
  that match at least one replay event — a malformed, reversed or non-matching
  window is refused instead of producing an artifact whose screens came only from
  the precondition (a clean-looking run that tested nothing).

The terminal-size inputs (`REPLAY_COLUMNS`, `REPLAY_ROWS`, `COLUMNS_OVERRIDE`,
`ROWS_OVERRIDE`) are passed to the terminal as-is. Every rejection fails loudly
with a diagnostic naming the switch and the supported modes:

```sh
REPLAY_SPEED=0   node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_SPEED must be a finite number > 0 (got 0)
REPLAY_LOOPS=0   node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_LOOPS must be an integer >= 1 (got 0)
REPLAY_FLUSH_MS=-1 node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_FLUSH_MS must be a finite number >= 0 (got -1)
REPLAY_WINDOW=20-10 node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_WINDOW must be "<from>-<to>" with integers 0 <= from <= to (got 20-10)
REPLAY_TRACE=/path/to/trace.json REPLAY_WINDOW=999999-999999 node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_WINDOW=999999-999999 matches no replay events (the run would test nothing); …
REPLAY_SPEED=2 REPLAY_CADENCE=exact node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_SPEED=2 is honoured by the REPLAY_WINDOW loop and by REPLAY_CADENCE=wallclock
#        (got exact without REPLAY_WINDOW; SPEED is intentionally not implemented for exact,
#        and immediate/batched have no absolute schedule)
REPLAY_LOOPS=2 REPLAY_CADENCE=immediate node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_LOOPS=2 is not supported by REPLAY_CADENCE=immediate without REPLAY_WINDOW …
REPLAY_SETTLE_EACH=1 node --import tsx/esm scripts/focus-replay-probe.mts
# Error: REPLAY_SETTLE_EACH=1 only applies inside the REPLAY_WINDOW loop
REPLAY_TURN_MODE=interleaved REPLAY_WINDOW=374-393 REPLAY_SOURCE=session …   # + REPLAY_TURN/REPLAY_SESSION
# Error: REPLAY_WINDOW is not supported with REPLAY_TURN_MODE=interleaved …
REPLAY_SETTLE=0 REPLAY_TRACE=/path/to/trace.json REPLAY_CADENCE=immediate …  # trace: warning, still runs
# [replay] warning: REPLAY_SETTLE has no effect for REPLAY_SOURCE=trace …
```

## What a run records

Per paint: triggering input, `rowWriteCount`, touched rows, bytes, duration,
mounted gutter row counts, `L3` (`contentHeight`, `viewportHeight`, `maxScrollTop`,
`scrollTop`, `isFollowingEnd`) and the full screen text. Per flush: the triggering
input, turn-activity facts (`revision`, `completed`, `assistantMessages`,
`lastAssistantVisible`, slot lengths), the `focusLiveHeightStates` entry
(activity identity, `expanded`, `width`, floor `height`), `presentationRows`, and
`L3`. With `REPLAY_PAINT_BLOCKS=1` also the ordered projection block inventory,
the production `normalTranscriptBlockHeight` calls, and projection vs mounted
component instance ids.

Detectors emitted with the artifact: `liveBlockMissingPaints`,
`answerDisappearancePaints`, `oldReappearancePaints`, `intraPaintWindows`,
`rowShiftPaints`, `osculationRuns`, `bigReflowPaints`, `followEndPaints`, and the
`allPaintsEndInSameWrite` transaction check.

## Known false positives (read before trusting a flag)

- **`osculationRuns` / `answerDisappearancePaints` are marker-based.** The marker
  strings also occur in the streaming reasoning tail, and the reasoning card
  scrolls, so these flags can fire without the answer block ever disappearing. The
  screen oracle is authoritative for whether something was actually visible.
- **The busy indicator glyph animates on wall-clock time** and is masked out of
  every comparison hash; a raw glyph difference is not a regression.
- **The automated Thought-expansion phase rewrites the whole viewport** for
  several seconds. It is precondition work, not the streaming behaviour under
  test; `REPLAY_SETTLE_BEFORE_STREAM` marks the boundary. The screen oracle
  reports those frames as shifts, not holes.
- **Terminal-buffer tools cannot see compositor tearing.** The oracle reads the
  buffer after each frame, which is always internally consistent.

## Acceptance procedure

For the transcript-batch lifecycle bug, before/after on the same reproducer
(`REPLAY_TURN_MODE=interleaved`, turn 20, `wallclock`, `coalesced` 50 ms, real
history `REPLAY_HISTORY=17,18,19`, fullscreen Focus, all Thought roots expanded,
follow-end, Node 24), 10 runs per side:

| Metric (10 runs) | Unfixed | Fixed |
|---|---:|---:|
| `liveBlockMissingPaints` (total / max / runs affected) | 120 / 17 / 10 of 10 | 0 / 0 / 0 of 10 |
| `contentHeight` single-frame drops ≥ 10 rows (total / max / runs affected) | 164 / 22 / 10 of 10 | 0 / 0 / 0 of 10 |
| `holes` | 0 | 0 |
| `abaAlternations` (per run) | 0–3 (non-zero in 5 of 10) | 0 in 10 of 10 |
| paints (average) | 580 | 582 |

The authoritative separation is `liveBlockMissingPaints` together with the
`contentHeight` single-frame drops. **`abaAlternations` is a diagnostic, not an
acceptance criterion**: it fired reliably only against the older synthetic
single-turn fixture, and with the exported multi-turn history it is noisy (0–3 on
the unfixed side, 0 on the fixed side). Do not use it as the gate.

Because the original failure was timing sensitive, repeat the run and require
`liveBlockMissingPaints = 0` and zero `contentHeight` single-frame drops ≥ 10 rows
in every run (the artifacts must also be `usable` per the oracle, and must have
`metrics.paintDetail: true` — with paint detail off those metrics are `null` and
cannot be read as acceptance). The
deterministic in-tree guard is `test/focus-mounted-batch-refresh.test.ts`, which
asserts the actual invariant — a row-map refresh must not dispose or replace the
mounted transcript batch, and the published batch must match the mounted gutters —
and fails on the unfixed tree with
`row-map refresh must not dispose the mounted component`.

## Limitations

- The real-terminal path runs well below real time (each flush rebuilds and
  repaints a large transcript), so it reproduces *content*, not arrival pace.
- Multiplexer runs (`tmux capture-pane`, `zellij subscribe`) report the
  multiplexer's own pane buffer; they cannot prove anything about the physical
  compositor.
- Whole-turn replay depends on the exported session's compact stream records; a
  session export without `assistant/message.data.stream` cannot be replayed.
