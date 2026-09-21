# Performance baseline

> Measured 2026-08-15 · commit `57e835d` (before) vs the working tree after
> the optimization (incremental read grouping + per-message render cache) ·
> Node v26.7.0 · headless xterm at 24 rows · `BENCH_FAST=1` iteration counts.
>
> Re-run: `pnpm bench` (full sweep), `pnpm bench:fast` (short sweep), or
> `pnpm bench:smoke` (reduced smoke workload). Full timing sweeps are manual
> and non-default; the reduced smoke workload is part of tooling CI.

## Transcript invalidation baseline (2026-09-19)

> Repaired-benchmark before SHA: `120ad66c0f7e45140966116dfe8d63b3db48d923`.
> Optimization SHA: `9549f96d0d6a4f1caf7cd5a79d2c41750342fd5e` (content-only
> transcript invalidation). Node
> `v24.20.0`; `BENCH_FAST=1 pnpm bench:fast`; headless terminals at 24 rows.
> The renderer fixture hydrates 30 turns, projects a bounded 20-turn indexed
> window, and drives the live tail through `TranscriptFolder.applyLiveInput()`.
> Wall-clock values are observational; structural counters are the regression
> gate.

### Structural work counters

The repaired pre-optimization harness did not emit counters, but every warm
projection and live flush entered `rebuildMessages()`. The equivalent observed
counts are shown as `structural / content / no-op`; the optimized values are
emitted by the benchmark itself:

| scenario | before | after |
|---|---:|---:|
| repeated latest projection @40 | 50 / 0 / 0 | 0 / 0 / 50 |
| ordinary live stream @40 | 50 / 0 / 0 | 0 / 50 / 0 |
| Focus collapsed streaming | not separately reported | 0 / 50 / 0 |
| Focus expanded streaming | not separately reported | 0 / 50 / 0 |
| fullscreen streaming | 20 / 0 / 0 | 0 / 20 / 0 |

### Same-machine timing sample

| scenario | before | after |
|---|---:|---:|
| cold bounded projection @40 | 170.62ms | 153.26ms |
| repeated projection @40 (p50 / p95 / p99 / mean) | 0.70 / 1.38 / 1.72 / 0.79ms | 0.12 / 0.47 / 1.22 / 0.19ms |
| live stream @40 (p50 / p95 / p99 / mean) | 1.06 / 1.46 / 1.92 / 1.10ms | 0.46 / 0.70 / 1.31 / 0.51ms |
| fullscreen stream @120 (p50 / p95 / p99 / mean) | 0.56 / 0.76 / 0.78 / 0.61ms | 0.37 / 0.55 / 0.55 / 0.39ms |
| heap growth per warm projection | 81.8 B/rebuild | -63.2 B/rebuild |

`pnpm bench:smoke` is the runtime-maintenance gate and does not assert timing
thresholds. `pnpm bench:fast` and the full `pnpm bench` sweep remain manual
observational measurements. Search-decorated content changes intentionally use
the one-commit structural fallback when the mounted highlight wrapper cannot be
proven safe to swap in place.

## Before (pre-optimization)

| scenario | value |
|---|---|
| ingest 17776 events (1111 turns) | 6.04ms |
| messages() ×200 (11110 messages) | p50 0.13ms · p95 0.38ms · p99 0.53ms |
| ingest 88880 events (5555 turns) | 21.15ms |
| messages() ×200 (55550 messages) | p50 0.53ms · p95 1.21ms · p99 3.68ms |
| rebuild 2220 messages @40 cols (cold, fresh app) | 155.17ms |
| same content (warm) @40 | p50 81.13ms · p95 86.67ms |
| streaming 1 message/frame @40 | p50 79.11ms · p95 86.17ms |
| same content (warm) @80 | p50 73.79ms · p95 83.72ms |
| streaming 1 message/frame @80 | p50 75.17ms · p95 81.46ms |
| same content (warm) @160 | p50 72.01ms · p95 76.39ms |
| fullscreen rebuild @120 | p50 70.78ms · p95 72.93ms |
| heap growth per warm rebuild | ≈ 0 B/rebuild |

## After (optimized)

| scenario | value |
|---|---|
| ingest 17776 events (1111 turns) | 6.09ms |
| messages() ×200 (11110 messages) | p50 0.06ms · p95 0.12ms · p99 0.47ms |
| ingest 88880 events (5555 turns) | 16.29ms |
| messages() ×200 (55550 messages) | p50 0.40ms · p95 1.16ms · p99 3.79ms |
| rebuild 2220 messages @40 cols (cold, fresh app) | 158.65ms |
| same content (warm) @40 | p50 0.29ms · p95 0.69ms |
| streaming 1 message/frame @40 | p50 0.46ms · p95 0.70ms |
| same content (warm) @80 | p50 0.28ms · p95 0.69ms |
| streaming 1 message/frame @80 | p50 0.48ms · p95 0.59ms |
| same content (warm) @160 | p50 0.25ms · p95 0.34ms |
| fullscreen rebuild @120 | p50 0.24ms · p95 0.44ms |
| heap growth per warm rebuild | ≈ 0 B/rebuild |

## Reading

- The **warm rebuild** is the per-frame cost of a running TUI (each paint
  rebuilds the message tree). It dropped ~280× (≈80ms → ≈0.3ms p50 for
  2220 messages): unchanged messages reuse their component, so the fork's
  text-identity render caches hit and markdown is not re-parsed per frame.
- The **streaming** case (one message's text replaced per frame, the 20 Hz
  assistant-token shape) costs ≈0.5ms p50 — single-frame cost no longer
  grows with the full history; only the changed message re-renders.
- The **cold** rebuild (fresh app, full markdown parse of every message)
  is unchanged — that cost is paid once per session/theme change, not per
  frame.
- Heap growth per warm rebuild is ~0; the settled working set grows with
  the transcript size (the cache holds one rendered component per message,
  bounded and cleared on session switch).

## Acceptance criteria

- ✅ baseline saved (this file + `scripts/bench.mts` rerunnable);
- ✅ 10k-event streaming per-frame cost no longer linear in history
  (0.5ms p50 regardless of the 2220-message transcript);
- ✅ heap enters a stable range under sustained streaming (growth ≈ 0);
- ✅ all transcript golden/headless tests keep identical output.

## Long-session projection baseline (PR A foundations)

PR A keeps the full session log and changes only local replay bookkeeping:

- open reasoning entries are indexed by turn, so `turn/end` settles only the
  still-open entries it owns;
- decode-window duration is accumulated as a scalar, so
  `StatsFolder.snapshot()` does not revisit completed samples;
- resume, create, and session-switch surface setup share
  `hydrateSessionUi(events)` instead of pre-folding a resumed log and then
  hydrating it again;
- the benchmark fixtures include reasoning-heavy, adjacent-read,
  one-turn-many-step, and a 700k-character text-heavy session. Current
  projection measurements use the PR B cold `hydrate` path and report
  transcript/stats hydration, snapshot, and heap/RSS separately from renderer
  timings;
- late replay timing is fenced to the current turn and ignores token deltas
  after a step has already settled, so tool-loop replay remains linear.

Run the projection and renderer sweep with:

```sh
BENCH_FAST=1 node --expose-gc --import tsx/esm scripts/bench.mts
```

The benchmark is intentionally observational rather than a wall-clock test;
compare runs on the same machine and Node version. Its semantic gates remain
cold-fold/incremental parity and the existing transcript/stats regression
suites.

## Long-session bulk hydration (PR B)

PR B separates the cold-session path from live event delivery. `hydrate()` folds
all events in order but defers adjacent settled-read grouping until one final
linear pass. Normal live tail suffixes continue to use `apply()` and extend a
read run from its boundary in constant bookkeeping time; non-tail settlements
retain the defensive reflow fallback. `StatsFolder.hydrate()` exposes the same
cold-resume boundary while preserving its existing incremental fold.

The following warmed p50 comparison uses the same synthetic one-turn log on
Node v24.15.0 in the PR B worktree. `apply()` is the event-by-event baseline;
`hydrate()` is the cold path:

| adjacent settled reads | `TranscriptFolder.apply()` | `TranscriptFolder.hydrate()` |
|---:|---:|---:|
| 100 | 0.42ms | 0.38ms |
| 500 | 0.64ms | 0.95ms |
| 1000 | 1.21ms | 1.07ms |

The result is still one grouped card with the same arguments, ordering, and
full result text. The benchmark script reports the cold path as
`TranscriptFolder.hydrate` / `StatsFolder.hydrate` in its reasoning-heavy,
read-heavy, and 700k-like scenarios.

## M11: extension-plugin overhead (plan §23)

Measured with the widget-outlet section of `scripts/bench.mts` (200 frames
per configuration):

| Configuration | Refresh cost |
|---|---|
| 0 widget contributions | ~5 µs/frame |
| 10 widget contributions | ~13 µs/frame |
| 50 widget contributions | ~13 µs/frame |
| 100 invalidations in one tick | 1 flush (coalesced) |

The 10→50 flatness is the outlet's early-out gate (a refresh skips when
the ledger revision, theme revision, width and row budget are unchanged);
the burst coalescing is the `InvalidateBatcher` (one flush per tick). The
renderer path adds a registry-revision cheap gate so renderer functions
never run in the frame loop for unchanged content.

## Migration baseline (M0)

> The server/client migration (docs/client-server-migration.md) freezes its
> pre-migration baseline at commit `658ed25` (M0 landing): `pnpm build`,
> `pnpm typecheck`, `pnpm test:bundle` (1809 tests), `pnpm test:docs`,
> `node scripts/naming-gate.mjs` and `node scripts/client-boundary-gate.mjs`
> are all green there. Per the migration plan, no absolute numbers are set
> yet — the M0–M5 rule is "no perceptible regression" on the Direct path,
> and the wire-local phase adds its own measured gates (startup, first
> paint, first keystroke, event-to-paint latency, idle RSS, streaming CPU)
> before any default flip.

## Session picker projection alignment (2026-09-01)

> Measured 2026-09-01 · `next @ 2fff355` (before) vs
> `perf/session-picker-projection` (after) · real session corpus copied to a
> temp `DSH_HOME`: **1478 sessions · 848 MB compressed logs** · cold
> projection/title caches, page cache warmed for both · tmux-driven
> (`scripts/bench-session-picker.sh`; first Enter after boot is dropped by
> the terminal, so every `picker_frame_ms` includes a ~3.0 s retry — the
> deltas are what matter).

| metric | before (next) | after (this PR) |
|---|---|---|
| cold: interactive picker frame (Enter → overlay owns input) | ≈ 1.4 s (opens only after `list()`) | ≈ 0.11 s (loading frame, pre-list) |
| cold: "All directories" rows visible after Tab | **63.4 s** | 7.4 s |
| cold: first enriched row (title+preset in one batch) | masked — presets land behind the same starved loop | +11 ms after rows |
| Esc during cold enrichment | 124 ms (measured after loop pressure passed) | 574 ms worst, stays interactive |
| warm reopen: picker frame | ≈ 20 s | ≈ 70 ms |
| warm reopen: rows visible | **62.6 s** | 6.3 s |

Reading: the old orchestration opened the picker only after the listing,
then started TWO eager detached enrichment paths (an `observeSession` preset
replay plus a per-session full-log title fold over every main row, ~848 MB
of zstd) that starved the event loop — the Tab re-render did not land for
over a minute, on every open. The new path opens the overlay before any
Host read, keeps the loop yielding between bounded batches, resolves title and
agentPreset from live projections or zero-I/O cache hints, and leaves cold
misses unknown. It drops the TUI-private title cache (DSH's
projection cache owns the durability) and never activates a cold Session for
picker labels.

## Fullscreen scroll frame: geometry-epoch snapshot reuse (2026-09-21)

> Measured 2026-09-21 · `next @ 976574e9` (before) vs
> `investigate/scroll-perf-post` @ `2004ef5f` (after) · Node v24.20.0 ·
> headless xterm 120x40, forced synchronous frames (`renderNow()`), 4
> interleaved rounds, medians. Full methodology and raw data:
> `temp/perf/fullscreen-scroll-performance-report-20260921.md` (untracked
> investigation artifact; the tables below are the durable record).

Two facts define fullscreen scroll cost (both refs identical, fork untouched
by the F6 range):

1. **A scroll frame costs the same as a no-op repaint.** `renderLayoutFrame`
   re-renders and recomposes the whole frame every paint (~7.5 ms at 120x40,
   proportional to viewport area, flat from 61 to 1501 mounted blocks thanks
   to the per-message render caches). The scroll's marginal diff cost is
   0.1-0.35 ms headless.
2. **Every scroll frame rewrites the FULL viewport** (per-row erase + redraw,
   2.6-9.8 KB by terminal size, independent of scroll distance) — the fork
   has no scroll-region optimization. This is the real-terminal cost.

The per-frame `commitFullscreenPaintSnapshot` remeasure
(`refreshMessageRows` → `remeasureTranscriptBlocks` → per-row hit
identities) was the stage that scaled with mounted transcript blocks. The
geometry-epoch optimization removes it from frames that did not change
transcript geometry.

### The geometry-epoch contract

`TuiApp.fullscreenRowsDirty` gates the snapshot rebuild. It is raised ONLY by:

- `updateTranscriptGeometry()` — every content/structural/search/disclosure
  commit flows through here (or through `rebuildMessages`, which calls it);
- `refreshMessageRows()` — the paint-time remeasure and the click-time live
  re-checks;
- the async image-settle seam (`ImageThumbnail` requestRender wiring) — a
  settle invalidates the component without either writer above;
- a terminal resize (detected at the snapshot commit).

Hard rule for future changes: **any path that changes the rendered transcript
geometry must reach one of the two row-map writers or raise the flag
itself.** A path that mutates disclosure/collapse state and only calls
`requestRender()` will paint with a STALE row map and stale press/release
fence identities. The regression tests in
`test/fullscreen-scroll-geometry-epoch.test.ts` pin the contract: pure
scroll frames never remeasure; an async image settle remeasures exactly on
the next painted frame; press/release fence semantics survive scrolled
repaints.

### Measured effect (p50 forced-frame wall time, median of 4)

| case (120x40) | before | after | snapshot stage |
|---|---:|---:|---|
| full preset, 61 blocks | 7.63 ms | 7.88 ms (noise) | 0.29 → 0.02 ms |
| compact collapsed | 8.81 ms | 7.44 ms (−16%) | 1.31 → 0.02 ms |
| focus collapsed | 12.57 ms | 9.43 ms (−25%) | 3.09 → 0.02 ms |
| focus turn-expanded | 12.51 ms | 9.10 ms (−27%) | 3.00 → 0.02 ms |
| 500-turn session (1501 blocks) | 13.08 ms | 8.20 ms (−37%) | 4.87 → 0.02 ms |
| focus, scrolling while streaming | 11.79 ms | 8.18 ms (−31%) | 3.03 → 0.02 ms |

Coalesced stream ticks (frames whose projection actually changed) keep the
full remeasure by design — those frames raised the flag themselves.

### Scroll-frame profiler

`DSH_TUI_SCROLL_PROFILE=1` emits one stderr line per coalesced scroll frame
(a frame whose render request was opened by a fullscreen `scrollBy`):

```text
scroll frame=6.30ms write=0.05ms snapshot=0.02ms refresh=0.00ms remeasure=0.00ms hits=0.00ms bytes=6204 rowsRW=34 blocks=61 rows=237 viewport=34 scrollTop=98 preset=full search=off
```

`latency` covers scroll input → painted frame; `refresh`/`remeasure`/`hits`
are the snapshot-commit internals; `bytes`/`rowsRW` are the per-frame
terminal rewrite volume. It is a diagnostic switch, disabled by default, and
deliberately separate from `DSH_TUI_RENDER_PROFILE` (transcript presentation
commits). The probe/benchmark lives in the perf report referenced above.
