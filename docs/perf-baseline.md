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

`DSH_TUI_SCROLL_PROFILE=1` emits one stderr line per coalesced scroll frame —
a frame whose render request was opened by a fullscreen `scrollBy` that
actually changed scroll state (the offset moved or the follow-end state
flipped). A boundary wheel that scrolls nothing still repaints, but it is not
a scroll frame and emits no line:

```text
scroll frame=6.30ms write=0.05ms snapshot=0.02ms refresh=0.00ms remeasure=0.00ms hits=0.00ms bytes=6204 rowsRW=34 blocks=59 rows=227 viewport=34 scrollTop=96 preset=full search=off
```

`latency` covers scroll input → painted frame; `refresh`/`remeasure`/`hits`
are the snapshot-commit internals; `bytes` is the per-frame terminal write
volume in UTF-8 bytes (the wire cost SSH/xterm.js pays — not
`string.length`); `rowsRW` is the erased/redrawn row count. The window is
discarded without emitting by every seam that pauses the paint loop
(`resetScrollProfileFrame()` at the fullscreen swap/exit, external-editor
suspend, `stop()`, `dispose()`). It is a diagnostic switch, disabled by
default, and deliberately separate from `DSH_TUI_RENDER_PROFILE` (transcript
presentation commits). The probe/benchmark lives in the perf report
referenced above.

## Relay Context row render cache + transcript boundary fast-path (2026-10-06)

> Measured 2026-10-06 · baseline `next @ e2a2712e43c7eb77da9f1864b7bc3f93b75b52c3` ·
> same machine, Node v24.20.0 · headless xterm 160x45 · real exported session corpus
> (`~/.dsh/sessions/--home-xmoon-project-dsh-pi-tui--/…/session.v4.jsonl.zstd`, 499 messages in the
> bounded 20-turn window, ~1.66 MB of message text, 8 Context rows of which 5 are `relay`) ·
> warm fullscreen page-scroll frames (alternating `PageDown`/`PageUp`, 20 frames per preset, after
> two settling paints). Timing is observational; the cache and semantic tests are the CI gate.
>
> Local measurement probes (untracked, not part of the product):
> `temp/tern/frame-cost-probe.mts` — per-frame CPU/wall inside `TuiAltScreen.doRender`;
> `temp/tern/frame-profile-probe.mts` — per-class render attribution.
> `temp/tern/boundary-cost-probe.mts` — the per-event boundary work on a bare `TuiApp`.
> All probe-side prototype hooks are disabled for every figure below.
>
> ```sh
> node --import tsx/esm temp/tern/frame-cost-probe.mts
> for p in compact focus full; do PRESET=$p node --import tsx/esm temp/tern/frame-profile-probe.mts; done
> node --import tsx/esm temp/tern/boundary-cost-probe.mts
> ```
> Figures are **frame CPU** p50 / p95 (`frameCpuMs`, measured inside `TuiAltScreen.doRender`),
> not wall time (20 warm frames per preset).

### A → B → C record

```text
A = clean next @ e2a2712e43c7eb77da9f1864b7bc3f93b75b52c3
B = Commit 1 (Relay render cache)
C = Commit 2 (transcript boundary fast-path) = the final HEAD
```

Measurement provenance — the exact snapshots the probes ran against:

| stage | measured snapshot | note |
|---|---|---|
| A | `e2a2712e` | clean next (remote) |
| B | `f6d84413` | local measurement commit — not retained as a remote ref |
| C | `e9e2c8e9` | local measurement commit — not retained as a remote ref |

The delivered commits keep byte-identical `src` trees — `src` tree
`21c6cb893a4cc34607eb404a857f020014c5bbc5` for Commit 1 and
`eedea39409b84a1c38525eef3a368468a53403ab` for Commit 2 (verify with
`git rev-parse <delivered-commit>:src`); only tests and this document changed after the measurement, so
the figures transfer to the delivered commits. The delivered commit ids — which change on every
rebase/amend — are pinned in the PR body.

| metric | A baseline | B after Commit 1 | C after Commit 2 | A→B | B→C | A→C |
|---|---:|---:|---:|---:|---:|---:|
| compact frame CPU p50 | 97.47 ms | 17.74 ms | 16.32 ms | −79.73 ms | −1.42 ms | −81.15 ms (−83%) |
| focus frame CPU p50 | 85.41 ms | 7.81 ms | 7.73 ms | −77.60 ms | −0.08 ms | −77.68 ms (−91%) |
| full frame CPU p50 | 92.85 ms | 11.73 ms | 10.71 ms | −81.12 ms | −1.02 ms | −82.14 ms (−88%) |
| compact frame CPU p95 | 150.51 ms | 32.62 ms | 31.34 ms | −117.89 ms | −1.28 ms | −119.17 ms |
| focus frame CPU p95 | 98.11 ms | 18.60 ms | 14.18 ms | −79.51 ms | −4.42 ms | −83.93 ms |
| full frame CPU p95 | 121.26 ms | 16.48 ms | 14.90 ms | −104.78 ms | −1.58 ms | −106.36 ms |
| `RelayContextRow` attributed ms/frame (compact) | 81.25 ms | 0.00 ms | 0.01 ms | −81.25 ms | 0 | −81.24 ms |
| `RelayContextRow` attributed ms/frame (focus) | 84.21 ms | 0.00 ms | 0.00 ms | −84.21 ms | 0 | −84.21 ms |
| `RelayContextRow` attributed ms/frame (full) | 68.23 ms | 0.01 ms | 0.01 ms | −68.22 ms | 0 | −68.22 ms |
| `RelayContextRow` render calls/frame | 5 | 5 | 5 | 0 | 0 | 0 |
| local boundary no-op anchor captures / event | 1 | 1 | 0 | 0 | −1 | −1 |
| boundary no-op capture + remeasure per event | 82.24 ms | 2.60 ms | 0 ms (2.24 ms of work removed) | −79.64 ms | −2.60 ms | −82.24 ms |

Commit 2 is a boundary-path change, so B→C is near-flat on the steady frames (the −0.08 … −1.42 ms
spread is run-to-run noise on the same machine; C was measured on the same corpus, terminal and probe
invocation). Its effect is the removed per-event work below. The two commits also interact: Commit 1
makes ANY full mounted remeasure ~30× cheaper (the relay body is no longer re-wrapped), which is why
the same boundary no-op capture drops from 82.24 ms/event to 2.60 ms/event before Commit 2 removes the
capture entirely.

### Boundary no-op cost removed by Commit 2

`temp/tern/boundary-cost-probe.mts` is a bare-`TuiApp` probe (it does NOT mount the surface runtime).
On the same corpus (160x45, compact, 200 no-op wheel-down events at the tail bottom) it measures the
fork input path alone and the same path with one mounted `captureTranscriptViewportAnchor()` per event
(a full `remeasureTranscriptBlocks` over every mounted block):

```text
A (clean next):   input only 103.9 us/event, 0 remeasures | with one capture/event 82,348 us/event, 200 remeasures
B (Commit 1):     input only  78.4 us/event, 0 remeasures | with one capture/event  2,678 us/event, 200 remeasures
C (Commit 2):     input only  67.2 us/event, 0 remeasures | the production fast-path performs ZERO captures
                  (replaying the removed work still measures 2,309 us/event, 200 remeasures)
```

The durable regression gate is the **ordered production call trace**, not a timing threshold:
`test/transcript-history-extension.test.ts` mounts the real `createSurfaceRuntime` over a virtual
`ProcessTerminal` (routing source: the test-owned `TranscriptFolder` + `TranscriptWindowController` +
an `extendLoadedHistory()` recorder), instruments the mounted app and the controller, and drives the
real page gestures through the fork. The asserted traces:

| boundary case | asserted production trace (C) | A/B production order |
|---|---|---|
| local newer no-op (live tail) | `moveNewer` — 0 capture, 0 repaint, 0 restore | capture 1 → remeasure → return |
| local older no-op, no Remote page | `moveOlder`, `extendLoadedHistory` (exactly 1) — 0 capture, 0 repaint | capture 1 → remeasure → extend 1 |
| local older no-op, Remote page available | same trace; the extension answer is still returned | capture 1 → remeasure → extend 1 |
| successful local older page move | `moveOlder`, `capture`, `repaint`, `restore:top` (capture once, BEFORE the repaint) + the old top row still visible | capture 1 → move → repaint → restore top |
| successful newer move that STAYS in history | `moveNewer`, `capture`, `repaint`, `restore:bottom` (capture once, BEFORE the repaint) + the old bottom row still visible | capture 1 → move → repaint → restore bottom |
| successful newer move from history@newest | `moveNewer`, `capture`, `repaint`, `scrollToBottom` (capture once, BEFORE the repaint) | capture 1 → move → repaint → latest fallback |

The ordering assertions were mutation-verified: moving the older capture back before the movement
decision, adding a second newer capture after the repaint, or swapping either restore edge (`'top'` / `'bottom'`) each
make the suite fail (5 / 3 / 3 failing tests). No wall-clock threshold is asserted anywhere in CI.

### Commit 1 — `RelayContextRow` renders once per width

`RelayContextRow.render()` wrapped, colored and disclosure-sliced the whole relay body on every
paint. The row now keeps a last-width cache of the FINAL rows (one entry; `invalidate()` clears it),
so a steady frame at an unchanged width returns them without re-wrapping.

The remaining compact frame cost (16–18 ms) is the collapsed Work card plus the still-uncached
`NoticeContextRow` and the row-map/geometry work; the focus/full frames are back at the 8–12 ms class
this document recorded on 2026-09-21.

## DIV cache A/B evidence: X039 / X014 / X035 (2026-10-11)

> Measured 2026-10-11 · base `next @ 1d09bbb0` · every variant built from that
> same commit in a throwaway worktree · Node v24.20.0 · AMD Ryzen 7 5825U,
> 15.6 GiB, shared box (load average ≈2.4 during the runs) · headless
> `NullTerminal` 120×40 (X014 additionally at 80/160), forced synchronous
> frames, one fresh worker PROCESS per (round, variant, workload) with the
> variant order rotated per round. Rounds: 7 (X039 four-way), 9 (X035 A/B),
> 21 (X014 paired, per width). Percentiles are nearest-rank, so with 9 rounds a
> reported "p95" equals the maximum round: X035's tail numbers are not a stable
> tail-latency claim. X035 drives a controlled synthetic streaming component
> through the host's Regular screen class `TuiMainScreen` (the class
> `src/tui-app.ts` mounts); the full `TuiApp` composition, a real terminal and the
> complete Kitty lifecycle are **not** exercised. "Equivalence" here means an
> identical 32-bit FNV hash of every byte written to the terminal sink — not a
> byte-for-byte comparison. Full methodology, per-round raw data and the
> analysis: `temp/perf/div-cache-ab-report-20261011.md` (untracked investigation
> artifact; the verdicts below are the durable record). Every run executed under
> `systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0` plus a
> wall-clock timeout.

This section is the isolated A/B evidence that the `tests` entries of the three
`PERF_HOST_DEPENDENT` ledger records (`X039`, `X014`, `X035`) point at. It changes
no divergence status: **all three stay `ACTIVE`** — these are measurements, not
retirement decisions. The acceptance policy was fixed before the numbers: a cache
may only be *proposed* for retirement when the no-cache / smaller-cache variant is
at most **5 % slower on the median** in every representative primary scenario, p95
no worse than **10 %**, with identical geometry; a difference inside the measured
noise band is reported as `INCONCLUSIVE`.

### Variants

| Label | Source delta (scratch worktrees only, never committed) |
| --- | --- |
| `BASE` | none — the current `next` fork |
| `W512` | `packages/pi-tui/src/utils.ts`: `WIDTH_CACHE_SIZE = 4096` → `512` |
| `NO_LAYOUT_CACHE` | `packages/pi-tui/src/layout.ts`: upstream `measureWidth` (`renderCached(...).reduce(max visibleWidth)`) restored, `LayoutContext.maxWidthCache` member + its context init removed |
| `NO_RAW_REUSE` | `packages/pi-tui/src/tui-main-screen.ts`: only the same-raw-line preprocessing fast path disabled (`const reuseProcessed = false`); truncation, `asciiVisibleWidthEarlyExit`, `normalizeTerminalOutput`, `SEGMENT_RESET` and the kitty-id bookkeeping stay byte-identical |

The variants are **hand-built** from these recipes in throwaway worktrees (the harness
measures; it does not patch sources), so a re-run is "apply the recipe, build, then one
harness command" — not one command end to end.

Each variant's built `packages/pi-tui/dist/index.mjs` has a distinct sha256, and the
harness loads exactly the `--entry` it is given, so no variant can silently measure
another variant's build. Every worker reports a result hash; the orchestrator fails
if variants disagree, which is the cross-variant equivalence check below.

### X039 — `WIDTH_CACHE_SIZE` → `KEEP`

`visibleWidth` caches only non-ASCII results (ASCII takes the fast path). 512 is far
outside the 5 % budget on exactly the scenarios the 4096 cache exists for, and the
controls behave as the mechanism predicts:

| Workload (median ms of the timed interval — two corpus walks: cold fill + repeat) | 4096 (`BASE`) | 512 (`W512`) | 512 / 4096 |
| --- | --- | --- | --- |
| 1024 distinct styled CJK/emoji lines | 100.2 | 189.4 | **1.89×** |
| 4096 distinct styled CJK/emoji lines | 393.6 | 770.1 | **1.96×** |
| 1000 plain long CJK lines | 89.9 | 160.3 | **1.78×** |
| post-wrap width re-measure (600 CJK lines; `wrapTextWithAnsi` runs BEFORE the timer, only the per-row `visibleWidth` calls are timed) | 1.06 | 62.9 | **59.6×** |
| control: 4000 styled ASCII lines (cache bypassed) | 5.84 | 5.78 | 0.99× |
| control: 8192 distinct lines (above both sizes) | 778.9 | 757.7 | 0.97× |

Mechanism counters from a scratch-instrumented build agree: for the 1024- and
4096-string working sets the 4096 cache gives 100 % hits on the second pass
(1024/1024 and 4096/4096) while 512 gives **0**; for 8192 both thrash. The 59.6×
figure belongs to that one post-wrap re-measure workload — it is not a full render pass
and must not be quoted as a whole-TUI speedup.

### X014 — per-frame `LayoutContext.maxWidthCache` → `INCONCLUSIVE`

21 paired rounds per width (80/120/160), 21 rounds × 4 workloads × 2 variants:

| Workload | paired OFF/ON median (cols=80) | (cols=120) | (cols=160) |
| --- | --- | --- | --- |
| `layout-auto-hstack` (extension-shaped: 12 rows × 8 auto entries) | 1.004× | 1.012× | 1.021× |
| `layout-aliased-hstack` (one instance in several entries — the cache's best case) | 0.991× | 1.035× | 1.014× |
| `layout-host-tree` (VStack + ScrollView + dock, the host's own shape) | 0.998× | 0.921× | 0.995× |
| `layout-auto-hstack-churn` (10 rows × 6 auto-basis cells whose text changes every frame) | 0.983× | 0.952× | 1.015× |

No cell reaches a robust direction: paired medians span 0.92×–1.05× and the sign
tests sit between 4/21 and 14/21 rounds in either direction, so the fixed thresholds
cannot be shown to pass. (The `churn` row is a correction: its earlier revision was a
padded `VStack` of plain `Text`s and never called `measureWidth` at all, so its
first-run numbers were not an X014 control. It is now 10 rows × 6 auto-basis `HStack`
cells whose text changes every frame, re-measured over 21 rounds per width.)

Per-frame `measureWidth` counts from an instrumented build (calls / distinct
`(component,width)` pairs / calls the per-frame cache could serve):

| Shape | calls | pairs | cache-serviceable |
| --- | --- | --- | --- |
| auto-basis HStack rows (12 × 8) | 96 | 96 | **0** |
| churn rows (10 × 6, text changes every frame) | 60 | 60 | **0** |
| host-like tree (VStack + ScrollView + dock) | 0 | 0 | 0 |
| aliased instances (2 instances across 5 entries) | 5 | 2 | 3 |

Equivalence is checked on the frame the LAYOUT ENGINE produced — every byte the alt
screen wrote — not on `root.render()`, which cannot see a changed `measureWidth`. The
sink is discriminating: scaling the measured width by 4 in the `NO_LAYOUT_CACHE` variant
makes the run fail with `HASH MISMATCH` (exit 1), while a ±1-column error on a single
auto entry is absorbed by `allocateStackSizes` and yields a genuinely identical painted
frame (expected for these fixed-width fixtures). The mechanism explains why: the cache can only hit when the
*same component instance* is measured from several auto-basis entries within one
frame, and the only reachable product path (an extension horizontal stack,
`src/extension/internal/component-compiler.ts`) compiles each child once, so every
`measureWidth` call is one distinct `(component,width)` pair per frame — the host's
own layout tree makes **0** `measureWidth` calls at all (instrumented probe: 96 pairs
× exactly 1 call per frame for the auto-basis stack; 3.0/2.0 calls per pair per frame
only when an instance is aliased by hand). The cache therefore costs one Map
allocation per frame in the reachable shapes and its expected benefit there is ≈0.

**Correction of the earlier 7-round result:** that run reported `RETIRE_CANDIDATE`
from medians that looked 5.9 %–21 % faster without the cache (and 8.5 % slower in the
aliased shape). With 21 rounds those differences do not survive — they were inside
the noise band, which the same run measured on identical-behaviour variant pairs
(paired medians 0.95×–1.02× but per-round ratios spanning 0.17×–1.74×). Note also
that with n=7 a reported "p95" is simply the maximum round, which is what made the
churn cell look like a +80 % tail regression. The corrected verdict is
`INCONCLUSIVE`: neither a robust benefit nor a robust regression was demonstrated.

### X035 — main-screen processed-line reuse → `KEEP`

9 rounds × 11 workloads, 10 frames each, `BASE` vs `NO_RAW_REUSE`, driven through the
host's Regular screen class `TuiMainScreen` (the class `src/tui-app.ts` mounts) with a
continuously streaming synthetic component; the full `TuiApp` composition and
fullscreen are not measured here:

| Workload (10 frames, median ms) | reuse ON | reuse OFF | paired OFF/ON median |
| --- | --- | --- | --- |
| steady transcript 1k lines, spinner-only change | 3.0 | 10.3 | **3.24×** |
| steady transcript 5k lines | 10.4 | 48.7 | **4.56×** |
| steady transcript 10k lines | 15.1 | 2171.6 | **153.7×** |
| 5k lines, each frame injects a change into 1 % of lines | 49.6 | 345.6 | **7.06×** |
| 5k lines, each frame injects a change into 10 % of lines | 231.9 | 694.9 | **2.79×** |
| 5k lines, 100 % dirty (control) | 1382.0 | 1406.1 | 1.00× |
| 5k lines whose visible characters are ASCII only (SGR styling aside) | 9.9 | 41.4 | **4.35×** |
| 5k lines with over-wide rows (truncation path) | 8.7 | 1342.5 | **176.8×** |
| 5k lines, transcript grows/shrinks every frame | 12.0 | 40.4 | 3.52× |
| 5k lines, three kitty image lines moving per frame | 35.4 | 63.0 | 1.78× |
| 5k lines, width cycles 80 → 120 → 160 across the measured frames | 36.5 | 53.4 | 1.60× (8/9 rounds slower) |

Every real workload is slower without the fast path in **9 of 9 rounds** (the
width-resize row in 8 of 9), and the dirty-fraction curve is exactly the mechanism: the
cache saves the work for *unchanged* lines, so the benefit decays as the dirty fraction
grows (1 % → 7.1×, 10 % → 2.8×) and disappears when every line changes (100 % → 1.00×,
the negative control). "Inject a change into N % of lines" is the *per-frame injection*
fraction: each frame is rebuilt from the pristine corpus, so the previous injection is
reverted and the adjacent-frame delta is roughly 2 N % (the instrumented run confirms
it: at 1 % injected, ≈2.6 % of lines per frame reach the preprocessing branch). It does
**not** reduce the per-frame cost to O(changed): the two arrays (`processedLines`,
`lineImageIds`) and the differential scan remain O(N).

The ascii row, the two dirty rows and the resize row were re-measured after the review
fixes (the ascii corpus previously contained `▸`/`│`/`✓` glyphs and was not ASCII, and
the resize window previously covered only two of the three widths); the other rows come
from the first 9-round run. Run-to-run spread on this shared box is wide enough that a
single ratio should not be read to two decimals — the sign tests are the robust part.

Correctness/equivalence (this is what makes the numbers usable): the complete terminal
write stream hashes **identically** between the two variants for all 11 workloads × 9
rounds — including kitty image lines moving every frame, transcripts growing and
shrinking, and width changes — and the source audit confirms that `restoreRenderState()`
/ `resetRenderState()` clear the cache (`captureRenderState()` only exports the state)
while the per-index kitty-id alignment cannot survive a length change by construction. An instrumented
build adds the mechanism counts: at 10k steady, 14 frames process 10,014 lines and
reuse 130,000 (i.e. only the first frame and the changed spinner line are processed);
at 100 % dirty the reuse count is 0. `asciiVisibleWidthEarlyExit` accounts for only
1–2 % of the preprocessing time (3.4–24.7 ms against 153–2288 ms), so it is not an
independent main factor and no separate variant was needed. X035 has no
user-approved numeric retirement threshold, so this section proposes none.

### Re-running these measurements

```sh
# 1. throwaway variants from the SAME commit, patched per the table above, then in each:
pnpm install && pnpm --dir packages/pi-tui build && sha256sum packages/pi-tui/dist/index.mjs

# 2. measure (ALWAYS under a hard memory cap and a wall-clock timeout)
systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 timeout 3600 \
  node --expose-gc --import tsx/esm scripts/bench/div-cache-ab.mts \
  --variants BASE=<base>/packages/pi-tui/dist/index.mjs,NO_RAW_REUSE=<off>/packages/pi-tui/dist/index.mjs \
  --rounds 9 --frames 10 \
  --workloads x035-steady-10k,x035-dirty-1pct,x035-corpus-ascii \
  --out temp/perf/div-cache-ab
```

The cap is not optional. An early revision of this harness used
`for (let i = 0; i < args.lines || 300; ...)`, which JavaScript parses as
`(i < args.lines) || 300` — an always-true condition when `--lines` is omitted. That
workload spun forever allocating rows, reached 4.2 GiB and hung for 27 minutes before
the host had to be restarted. The harness now uses explicit `positiveOr()` bounds,
`MAX_LINES` / `MAX_FRAMES` caps and a 120 s per-worker timeout, and every measurement
in this section ran inside the 2 GiB cgroup above.
