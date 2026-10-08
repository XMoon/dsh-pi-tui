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
| `test/tern-tsp-live-projection.test.ts` | 9 tests: the real routing → fold/window → `repaintTarget` → mounted `TuiApp` → observer → PR1 mapper → real SDK surface chain, plus the fences, the replaced-fold re-scope, the re-entrancy drop, coalescing, dispose and tty/product isolation. |
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
attachment and live-owner fences) → the real `TranscriptFolder` →
the real `repaintTarget()` → the real mounted `TuiApp` on a `VirtualTerminal` →
the injected observer → `projectTranscriptStructure()` + the PR1 mapper → the
real `@stencil-hq/tern` surface on a separate scripted tty (official handshake,
credit acks, frame decoding from the wire). The assistant-stream identity fence
(`isCurrentAssistantAgent`, never on the `routeSessionEvent` path) is asserted
separately, as the Direct install consults it before `applyAssistantInput`.

| ID | Scenario | State | Where |
|---|---|---|---|
| P2-01 | First commit after attach | PARTIAL: the first projection after the attach fences is covered; a bulk cold re-hydrate is not (it does not route through `routeSessionEvent` in production) | `P2-01/P2-02` |
| P2-02 | Live durable `tool/call` → `tool/result` | DONE: one tool card running → done on the wire (`set status done`, 0 `del`, 0 `move`) | `P2-01/P2-02`, `P2-09` |
| P2-03 | Live assistant delta | DONE: `applyAssistantInput` → the same streaming card; the growth is an SDK `text` op | `P2-03` |
| P2-04 | Wrong attached object / stale session | DONE: a foreign Session's durable event and stream neither fold nor schedule a repaint | `P2-04` |
| P2-05 | main → viewed child → main | DONE: each subject carries its own id and identity token; the main fold keeps updating behind the viewer; leaving republishes the main projection | `P2-05` |
| P2-06 | Same Session id, replaced fold (the production session-commit/rehydrate shape) | SEAM-LEVEL DONE: replacing the main fold under the same id — with the ONE retained window controller re-bound to it, exactly as `session-presentation.ts` does — produces a NEW identity scope (no cross-attribution, the stale fold stops receiving), so the seam carries no Direct/`same-id` assumption. The real Remote `Connection` generation/transport rollover over the wire stays with the existing Remote qualification suites — see *Deferred with owner* | `P2-06/P2-07` |
| P2-07 | Remote bounded window / `loadOlder` | PARTIAL: the observer publishes whatever committed window the routing exposes, so ordinary window changes are exercised by `P2-02`/`P2-09` and a re-bound fold by `P2-06/P2-07`; the production window CONTROLLER is never replaced within one subject, and the bounded reader's `hasMore`/`loadOlder` semantics are untouched, keeping their own coverage in the history-extension and Remote suites | `P2-06/P2-07` |
| P2-08 | Read merge / Context clustering | INHERITED from PR1 (mapper `View.ops` rebuild case, `test/tern-tsp-transcript-spike.test.ts`); not re-asserted through the live chain | PR1 T6 |
| P2-09 | Repaint coalescing / unchanged view | DONE: three events in one flush window commit once; a repaint of an identical projection emits **zero ops** on the wire | `P2-09` |
| P2-10 | Synchronous subject switch inside `setTranscript` | DONE (see the discrimination table) | `P2-10` |
| P2-11 | `dispose()` / late event / SDK close | DONE: a late routed event still schedules a repaint, and no frame is published; the SDK closes with `keep:false` and restores raw mode on its own tty | `P2-11`, `P2-01/P2-02` |
| P2-12 | Physical stdin ownership | DONE as source lock + object identity: PiTui's `VirtualTerminal` and the SDK's `TermInput`/`TermOutput` are different objects; a PiTui keystroke reaches neither the SDK input nor the wire; production never handshakes | `P2-12/P2-14` |
| P2-13 | Docs migration / index | DONE: one canonical entry, PR1 archived, no dangling reference (`docs/tern-tsp/evidence/pr1.md` keeps the old path only in its migration note) | `rg` check |
| P2-14 | Release artifact boundary | DONE as a source lock: no file under `src/**` imports `@stencil-hq/tern`, and `bootstrap.ts` never injects the observer; the packaging smoke is part of the stage-final lane | `P2-12/P2-14` |

### Deferred with owner

| Item | Owner | Reason | Closure condition |
|---|---|---|---|
| Real Remote `Connection` generation / transport-token rollover driving the projection observer over the wire | The M3 Remote qualification contract (`docs/client-server-migration.md`; the existing `smoke:remote-*` / runner Remote L6 suites) | Those suites own the real binding/reader fixtures; PR2 must not build a second Remote harness, and the plan itself grades P2-06 as needing "a real binding fixture" | A Remote L6 case that replaces the binding mid-session and asserts the projected subject identity is re-scoped |

### Discrimination checks (mutations run against the final test file)

| Temporary mutation | Observed |
|---|---|
| `publishProjected()`'s post-commit currentness re-check removed | `P2-10` fails (`1 !== 0`): the stale main frame is published |
| `dispose()`'s observer release removed | `P2-11` fails: the late event's repaint publishes a frame |

Both mutations were reverted; the committed tree has neither. `P2-06/P2-07`
asserts a direct property (the replaced fold must produce a different identity
token while the Session id stays the same), so it cannot pass for the wrong
reason: a dropped frame or a re-used token both fail it.

## Verification results (snapshot-qualified)

| Lane | Command | Result | Snapshot |
|---|---|---|---|
| Types | `pnpm typecheck:bundle` | exit 0 | `7f06f7b5`, re-run green with the 9th test |
| PR2 suite | `node --test test/tern-tsp-live-projection.test.ts` | 9 pass / 0 fail | R1-fix tree (see the commit list) |
| Targeted (9 files) | `node --test test/tern-tsp-live-projection.test.ts test/tern-tsp-transcript-spike.test.ts test/transcript-history-extension.test.ts test/surface-lifecycle.test.ts test/status-ownership.test.ts test/projection-convergence.test.ts test/transcript.test.ts test/remote-live-ingress.test.ts test/session-ui-hydrate.test.ts` | 297 pass / 0 fail | `e373aeda` (earlier snapshot, 8-test file; superseded by the product lane) |
| Product suite | `pnpm test:product` | 7370 pass / 0 fail (includes the 9 PR2 tests) | `7f06f7b5` (8-test file), re-run inside the stage-final pipeline below |
| Architecture gate | `pnpm gate:architecture` | exit 0 | `7f06f7b5`, re-run inside the stage-final pipeline |
| Client-boundary gate | `pnpm gate:boundary` | exit 0 | `7f06f7b5`, re-run inside the stage-final pipeline |
| Naming / session-events / install-doc gates | `node scripts/naming-gate.mjs`, `node scripts/check-no-session-events.mjs`, `node scripts/installation-doc-gate.mjs` | exit 0 (all three) | `7f06f7b5`, re-run inside the stage-final pipeline |
| Whitespace | `git diff --check`, `git diff --cached --check` | exit 0 (both) | `7f06f7b5` |
| Stage-final `pnpm verify:prepush` (fork typechecks + `test:fork` + `test:docs` 364/0 + `test:tooling` + all gates + `pnpm audit` "No known vulnerabilities found" + `pack:release` prepack `typecheck:bundle` + `test:product` **7370/0** + the 8 postpack smokes) | `pnpm verify:prepush` | exit 0 | working tree committed as the R1-fix commits (content-identical) |

## Plan checklist mapping (§10 acceptance / §2 MUST / §9 stop conditions)

| Plan item | Where it is satisfied |
|---|---|
| Branch off the actual `next` with no unexpected worktree changes | Base `a4473563`; `git status` clean; the diff touches 7 files (3 code/test, 4 docs) |
| The ONE `repaintTarget` exit covers the active window; no second event/fold/window authority | `mounted().setTranscript(` exists exactly once in `src/**` (`src/app/surface/runtime.ts:816`); every `repaintTarget()` caller passes `activeFolder()`/`activeWindow()`; the publish point is inside that same function; PR2 adds no subscription, fold, window, reader or port |
| Production keeps PiTui and never handshakes on its tty; the SDK stays dev/test-scoped | `docs/tern-tsp.md` + `P2-12/P2-14` test: no `src/**` file imports the SDK, `bootstrap.ts` never injects the observer, the two terminals are distinct objects; `@stencil-hq/tern` remains in `devDependencies` |
| A real application event-routing source→fold→window→observer→SDK sink test, plus a stream live input positive | `P2-01/P2-02` and `P2-03` (real routing bodies, real fold/window, real `repaintTarget`, real mounted `TuiApp`, real SDK surface) |
| main/viewer, same-id rebind, Remote bounded/currentness, rehydrate, late event, dispose — covered or level-marked | `P2-05`, `P2-06/P2-07` (replaced fold under the same id), `P2-10`, `P2-11` for the seam; the real Remote wire rollover is recorded as *Deferred with owner*; `P2-01` bulk cold-hydrate and `P2-08` are inherited/level-marked |
| `View.ops` keeps increments; Read/Context reparenting may rebuild; no reinvented business id | `P2-09` (unchanged projection = zero ops) plus PR1's `View.ops` cases; the seam introduces no identity of its own |
| Production repaint/search/status/input timing unchanged; no wider abstraction | One optional option + one call in `repaintTarget()`; with no observer the path is one `undefined` check; `pnpm test:product` 7370/0 in the stage-final pipeline |
| `docs/tern-tsp.md` created as the long-term entry | `docs/tern-tsp.md` (scope/status, upstream, ownership boundary, implementation, contracts, capability matrix, verification, ledger, next decisions) |
| PR1 evidence archived; PR2 evidence written | `docs/tern-tsp/evidence/pr1.md` (verbatim `git mv` + snapshot note), `docs/tern-tsp/evidence/pr2.md` |
| `docs/README.md` indexes one entry; no dangling internal links | One row pointing at `tern-tsp.md`; `rg 'tern-tsp-pr1-evidence\.md' docs scripts test src` matches only the archive's own migration note |
| Targeted + gates + stage-final results recorded with SHA; CI green before merge | The snapshot table above; `pnpm verify:prepush` exit 0 on the R1-fix tree; CI recorded after the push |
| Reviewer re-read `docs/code-review.md` and reviewed the whole PR | Review history appended below |
| Docs separate verified from unverified scope with a PR3 handoff | "What PR2 proved / did NOT prove" and "PR3 handoff" above |

MUST-NOT audit (all held; see `git diff a4473563..HEAD`): no change to
`src/startup.ts`, `src/index.ts`, `cordis.patch.yml`, the public extension API,
Host ports/wire, `src/tui/terminal/tern.ts`; no SDK handshake in the product
path; no second fold/subscription/reader; no editor/command/Question/search/
Focus work; no `try`/`catch` swallowing observer or SDK failures.

§9 stop conditions: none triggered — the observer consumes the existing
`folder.window()` output, needs no `TuiApp` facsimile, needs no new generation
authority, and the tests keep PiTui and the SDK on separate ttys.

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
   nothing; and replacing the fold under the SAME Session id produces a
   new identity scope, so the same id is never treated as the same view.
4. The production path is unchanged and SDK-free: no `src/**` import, no
   composition wiring, PiTui keeps its own tty.

NOT proved (do not read the tests as these):

1. **No real pane.** PR2 has no real-Tern run; the pane-level proof remains
   PR1's scripted-then-manual smoke.
2. **No product renderer.** PiTui is still the only renderer; nothing selects
   TSP at startup and there is no fallback path in the product.
3. **No Remote binding rollover over the wire.** The seam-level replacement case
   (P2-06/P2-07) covers what the surface sees; the real `Connection`
   generation/transport replacement was not exercised — see *Deferred with
   owner* above.
4. **No bulk cold-hydrate coverage** through the live chain (P2-01 PARTIAL).
5. **No editor/input, Question/Approval, search/reveal, ExtensionView or Focus
   work** inside TSP.
6. **No durable TSP node identity.** Keys stay replay-local and scoped to the
   consumer lifetime; Read-group/Context reparenting legitimately rebuilds ids.
7. **No performance claim.** The only measured signal is the zero-op frame for an
   unchanged projection; no long-session refresh benchmark was run.
8. **Read-only is type-level plus the opaque token**, with no defensive copy of
   the committed array: a consumer that ignores the `readonly` type could still
   mutate the array the app holds. That is out of the documented contract, and
   the seam deliberately does not pay for a copy.

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

## Review history

| Round | Verdict | Findings and disposition |
|---|---|---|
| Internal R1 (durable reviewer, reviewed `bfeac1d0`; code/test identical to `7f06f7b5`) | needs-fixes | P2 `docs/tern-tsp.md` still described `sourceIdentity` as the fold instance → corrected to the opaque token. P2 plan §2 MUST #1/#3 Remote ownership/window replacement + same-id rehydrate not delivered → `P2-06/P2-07` seam-level replacement test added; the real Remote wire rollover recorded as *Deferred with owner* above. P3 raw-mode timing → reworded against the shipped SDK's `handshake()`. P3 the `routeSessionEvent` fence list wrongly included the exact-Agent fence → split (with the note that `isCurrentAssistantAgent` is asserted separately). P3 the P2-06 parenthetical conflated a subject switch with a same-id rebind → rephrased. Non-blocking read-only observation → recorded as an explicit limit above. |
| Internal R2 (same reviewer, delta `bfeac1d0..67f13aae`) | **accepted-with-followups** | All five R1 findings verified fixed; it ran `node --test test/tern-tsp-live-projection.test.ts` itself (9/0) and accepted the wire-level Remote rollover as `DEFERRED_WITH_OWNER` (subject to the plan owner's confirmation). New P3: the fixture's `replaceMain()` also swapped the window controller, which production never does — fixed by replacing only the fold and re-binding the ONE retained controller (`session-presentation.ts`), with the comments and the P2-07 row corrected. |

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
