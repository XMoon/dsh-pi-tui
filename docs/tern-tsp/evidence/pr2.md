# Tern TSP PR2 evidence — live transcript projection observation seam

Status of this document: **PR2 execution record** for the TSP integration, not a
subsystem contract. Its numbers are snapshot-qualified to the commits listed
below; the long-term entry point is [`docs/tern-tsp.md`](../../tern-tsp.md).

- **Date / environment:** 2026-10-08 (UTC+8); Node `24.20.0`, pnpm `11.7.0`,
  TypeScript `5.9.3`, `@xmoon76/dsh-pi-tui@0.5.1`, dev DSH deps `0.2.0-rc.2`
- **Worktree / branch:** `/home/xmoon/project/dsh-pi-tui-tern-tsp-pr2` ·
  `feat/tern-tsp-pr2-live-presentation`
- **Base:** `origin/next` @ `a4473563b0c97f0fc08dfc2ef9626a2a9f5705bc`
- **Plan:** `temp/tern/dsh-pi-tui-tern-tsp-pr2-live-presentation-seam-plan-20261008.md`
- **SDK:** `@stencil-hq/tern@0.1.0` (npm, `devDependencies` only — unchanged by
  this PR, still unreachable from `src/**`)
- **Real Tern pane:** PR2 ran **no** new pane smoke; the pane-level evidence is
  PR1's, kept verbatim in [`pr1.md`](./pr1.md) (Tern `0.6.2 (4b3ed42)`).

## Deliverables

| Path | What it is |
|---|---|
| `src/app/surface/runtime.ts` | The PR2 seam: `SurfaceRuntimeOptions.onTranscriptProjected?` + `TranscriptProjectionFrame`, published by `repaintTarget()` after the ONE existing `folder.window()`/`setTranscript()`; released by `dispose()`. |
| `test/tern-tsp-live-projection.test.ts` | 8 tests: the real routing → fold/window → `repaintTarget` → mounted `TuiApp` → observer → PR1 mapper → real SDK surface chain, plus the fences, the re-entrancy drop, coalescing, dispose and tty/product isolation. |
| `docs/tern-tsp.md` | The long-term TSP entry point (protocol boundary, ownership chain, status, contracts, capability matrix, ledger, PR3 questions). |
| `docs/tern-tsp/evidence/pr1.md` | The PR1 record, `git mv`-archived verbatim (only a historical-snapshot note added). |
| `docs/tern-tsp/evidence/pr2.md` | This document. |
| `docs/README.md` | One index row, now pointing at `tern-tsp.md`. |

No startup/profile/command/setting/extension/Host-port change; `cordis.patch.yml`,
`src/startup.ts` and `src/index.ts` are untouched, and the SDK stays a
devDependency.

## The seam contract as implemented

```ts
readonly onTranscriptProjected?: (frame: TranscriptProjectionFrame) => void
```

- **Published once per commit**, by `repaintTarget()` *after* its ONE existing
  `folder.window()` call and after `mounted().setTranscript(...)`. The observer
  never re-folds, re-windows, re-reads the log or subscribes to anything.
- **Frame:** `subjectKind` (`main` / `viewed-child`) and `subjectId` sampled from
  the SAME active-target selection the repaint used (never inferred from a row);
  `sourceIdentity`, an opaque bare-object token that is identical for every frame
  from one `TranscriptFolder` and different once that fold is replaced (the fold
  instance itself is deliberately NOT handed out); and `messages`, the exact
  array the mounted app was asked to commit (same reference).
- **Withheld:** a commit that synchronously switches the active subject (viewer
  open/exit, session switch) publishes nothing — the target is re-sampled
  through the same owner reads after the commit; `dispose()` clears the observer
  before the mounted app dies.
- **Absent by default:** the production composition root never injects it, so
  `dsh --profile pi-tui` keeps its exact behaviour and the only cost on the
  production path is one `undefined` check per repaint.

## Source-to-sink proof

`test/tern-tsp-live-projection.test.ts` drives the REAL application bodies:
`SurfaceRuntime.routeSessionEvent()` → `app/surface/event-routing.ts` (the
attachment/currentness/exact-owner fences) → the real `TranscriptFolder` →
the real `repaintTarget()` → the real mounted `TuiApp` on a `VirtualTerminal` →
the injected observer → `projectTranscriptStructure()` + the PR1 mapper → the
real `@stencil-hq/tern` surface on a separate scripted tty (official handshake,
credit acks, frame decoding from the wire).

| ID | Scenario | State | Where |
|---|---|---|---|
| P2-01 | First commit after attach | PARTIAL: the first projection after the attach fences is covered; a bulk cold re-hydrate is not (it does not route through `routeSessionEvent` in production) | `P2-01/P2-02` |
| P2-02 | Live durable `tool/call` → `tool/result` | DONE: one tool card running → done on the wire (`set status done`, 0 `del`, 0 `move`) | `P2-01/P2-02`, `P2-09` |
| P2-03 | Live assistant delta | DONE: `applyAssistantInput` → the same streaming card; the growth is an SDK `text` op | `P2-03` |
| P2-04 | Wrong attached object / stale session | DONE: a foreign Session's durable event and stream neither fold nor schedule a repaint | `P2-04` |
| P2-05 | main → viewed child → main | DONE: each subject carries its own id and identity token; the main fold keeps updating behind the viewer; leaving republishes the main projection | `P2-05` |
| P2-06 | Same-id rebind / Remote transport rollover | NOT COVERED at the binding level (needs the real Remote binding fixture); the same-id *frame* hazard is covered by the re-entrancy drop | `P2-06/P2-10` |
| P2-07 | Remote bounded window / `loadOlder` | NOT COVERED by PR2 (the reader is untouched; the pre-existing history-extension and Remote suites keep their own coverage) | — |
| P2-08 | Read merge / Context clustering | INHERITED from PR1 (mapper `View.ops` rebuild case, `test/tern-tsp-transcript-spike.test.ts`); not re-asserted through the live chain | PR1 T6 |
| P2-09 | Repaint coalescing / unchanged view | DONE: three events in one flush window commit once; a repaint of an identical projection emits **zero ops** on the wire | `P2-09` |
| P2-10 | Synchronous subject switch inside `setTranscript` | DONE (see the discrimination table) | `P2-06/P2-10` |
| P2-11 | `dispose()` / late event / SDK close | DONE: a late routed event still schedules a repaint, and no frame is published; the SDK closes with `keep:false` and restores raw mode on its own tty | `P2-11`, `P2-01/P2-02` |
| P2-12 | Physical stdin ownership | DONE as source lock + object identity: PiTui's `VirtualTerminal` and the SDK's `TermInput`/`TermOutput` are different objects; a PiTui keystroke reaches neither the SDK input nor the wire; production never handshakes | `P2-12/P2-14` |
| P2-13 | Docs migration / index | DONE: one canonical entry, PR1 archived, no dangling reference (`docs/tern-tsp/evidence/pr1.md` keeps the old path only in its migration note) | `rg` check |
| P2-14 | Release artifact boundary | DONE as a source lock: no file under `src/**` imports `@stencil-hq/tern`, and `bootstrap.ts` never injects the observer; the packaging smoke is part of the stage-final lane | `P2-12/P2-14` |

### Discrimination checks (mutations run against the final test file)

| Temporary mutation | Observed |
|---|---|
| `publishProjected()`'s post-commit currentness re-check removed | `P2-06/P2-10` fails (`1 !== 0`): the stale main frame is published |
| `dispose()`'s observer release removed | `P2-11` fails: the late event's repaint publishes a frame |

Both mutations were reverted; the committed tree has neither.

## Verification results (snapshot-qualified)

| Lane | Command | Result | Snapshot |
|---|---|---|---|
| Types | `pnpm typecheck:bundle` | exit 0 | `7f06f7b5` |
| PR2 suite | `node --test test/tern-tsp-live-projection.test.ts` | 8 pass / 0 fail | `7f06f7b5` |
| Targeted (9 files) | `node --test test/tern-tsp-live-projection.test.ts test/tern-tsp-transcript-spike.test.ts test/transcript-history-extension.test.ts test/surface-lifecycle.test.ts test/status-ownership.test.ts test/projection-convergence.test.ts test/transcript.test.ts test/remote-live-ingress.test.ts test/session-ui-hydrate.test.ts` | 297 pass / 0 fail | `e373aeda` (pre-token refinement; superseded by the product lane below) |
| Product suite | `pnpm test:product` | 7369 pass / 0 fail (includes the 8 PR2 tests) | `7f06f7b5` |
| Architecture gate | `pnpm gate:architecture` | exit 0 | `7f06f7b5` |
| Client-boundary gate | `pnpm gate:boundary` | exit 0 | `7f06f7b5` |
| Naming / session-events / install-doc gates | `node scripts/naming-gate.mjs`, `node scripts/check-no-session-events.mjs`, `node scripts/installation-doc-gate.mjs` | exit 0 (all three) | `7f06f7b5` |
| Whitespace | `git diff --check`, `git diff --cached --check` | exit 0 (both) | `7f06f7b5` |

## What PR2 proved, and what it did NOT prove

Proved (on the snapshots above):

1. The authoritative application event chain — the real routing bodies, the real
   canonical fold/window and the real mounted `TuiApp` commit — reaches an
   optional read-only observer that carries the SAME message array.
2. A real `@stencil-hq/tern` surface renders that live projection on a separate
   tty: a settled tool card is a small `set` delta, streaming text is an
   `append`, and an unchanged projection produces no frame at all.
3. The existing fences stay in charge: a foreign Session, a stale live input, a
   synchronous subject switch inside the commit and a disposed surface publish
   nothing.
4. The production path is unchanged and SDK-free: no `src/**` import, no
   composition wiring, PiTui keeps its own tty.

NOT proved (do not read the tests as these):

1. **No real pane.** PR2 has no real-Tern run; the pane-level proof remains
   PR1's scripted-then-manual smoke.
2. **No product renderer.** PiTui is still the only renderer; nothing selects
   TSP at startup and there is no fallback path in the product.
3. **No Remote binding rollover coverage.** P2-06's real `Connection`
   generation/transport replacement was not exercised; PR2 only guarantees the
   seam does not add a second authority.
4. **No bulk cold-hydrate coverage** through the live chain (P2-01 PARTIAL).
5. **No editor/input, Question/Approval, search/reveal, ExtensionView or Focus
   work** inside TSP.
6. **No durable TSP node identity.** Keys stay replay-local and scoped to the
   consumer lifetime; Read-group/Context reparenting legitimately rebuilds ids.
7. **No performance claim.** The only measured signal is the zero-op frame for an
   unchanged projection; no long-session refresh benchmark was run.

## PR3 handoff (recorded, not implemented)

1. Which `SurfaceRuntime`-adjacent calls on `SurfaceRuntime.app: TuiApp` actually
   block a read-only TSP mount, per owner (`session-presentation.ts`,
   `event-routing.ts`, `bootstrap.ts`)? PR2 needed none of them because the
   scripted-mount fixture wires the surface directly; a real runner mount would.
2. Which single composition point can run a TSP handshake *before* PiTui claims
   stdin, and keep the existing PiTui fallback when `connect()` returns `null`?
   `src/startup.ts` must stay dependency-free. PR2 deliberately adds no such
   seam: today the observer is only injectable through `createSurfaceRuntime()`.
3. Which minimal editor/input state (`tui/interaction/editor-seat.ts`,
   `input-router.ts`) must the TSP owner take over, and which parts depend on
   PiTui `Component`/`Key` types?
4. How do Question/Approval modals, ExtensionView and the child viewer hand over
   input ownership so a TSP pane never swallows input it cannot serve?
5. Does the SDK's signal-time `keep: true` (vs the normal `keep: false`) need a
   product policy? Until proven safe, keep the SDK's own behaviour.
6. When TSP gains Search/Reveal, how do we reuse
   `src/tui/transcript/{reveal,container-owner}.ts` without moving PiTui
   geometry into the consumer?
7. A real runner-level end-to-end test (the `mountRunner` fixture) needs the
   observer to be reachable from the composition root; that is a deliberate
   product-architecture decision, not a test detail.

## Reproduction

```sh
pnpm build                                   # packages/pi-tui/dist + dist
pnpm typecheck:bundle
node --test test/tern-tsp-live-projection.test.ts
node --test test/tern-tsp-transcript-spike.test.ts
pnpm test:product
pnpm gate:architecture && pnpm gate:boundary
```

The PR2 suite needs no terminal: the PiTui side runs on `VirtualTerminal`
(`installVirtualProcessTerminal`) and the TSP side on a scripted `TermInput`/
`TermOutput`, so the two input owners are always distinct objects. Real-Tern
reproduction (PR1) is documented in [`pr1.md`](./pr1.md).
