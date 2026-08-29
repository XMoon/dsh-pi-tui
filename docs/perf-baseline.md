# Performance baseline

> Measured 2026-08-15 · commit `57e835d` (before) vs the working tree after
> the optimization (incremental read grouping + per-message render cache) ·
> Node v26.7.0 · headless xterm at 24 rows · `BENCH_FAST=1` iteration counts.
>
> Re-run: `node --expose-gc --import tsx/esm scripts/bench.mts`
> (full sweep without `BENCH_FAST`). The benchmark is NOT part of the test
> suite — it is a manual, non-default tool by design.

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

## Long-session projection baseline (PR A)

PR A keeps the full session log and changes only local replay bookkeeping:

- open reasoning entries are indexed by turn, so `turn/end` settles only the
  still-open entries it owns;
- decode-window duration is accumulated as a scalar, so
  `StatsFolder.snapshot()` does not revisit completed samples;
- resume, create, and session-switch surface setup share
  `hydrateSessionUi(events)` instead of pre-folding a resumed log and then
  hydrating it again;
- the benchmark includes reasoning-heavy, adjacent-read, one-turn-many-step,
  and a 700k-character text-heavy fixture, and reports transcript/stats apply,
  snapshot, and heap/RSS measurements separately from renderer timings;
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
