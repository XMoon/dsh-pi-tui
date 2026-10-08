# Tern TSP PR1 evidence — standalone canonical-transcript TSP spike

Status of this document: **PR1 feasibility evidence record**, not a subsystem
contract. It exists to make PR2 start from measured facts instead of a claim.
PR1 shipped **only** an experimental, manually launched spike; no production
launch path, profile, command, public export or Host port changed.

- **Date:** 2026-10-08 (UTC+8)
- **Worktree / branch:** `/home/xmoon/project/dsh-pi-tui-tern-tsp-pr1` · `feat/tern-tsp-pr1-feasibility-spike`
- **Base:** `origin/next` @ `aa7631e27e1398a121403aa90824ac6a8c095f63`
- **Plan:** `temp/tern/dsh-pi-tui-tern-tsp-pr1-feasibility-plan-20261008.md`
- **Environment:** Node `24.20.0`, pnpm `11.7.0`, TypeScript `5.9.3`,
  `@xmoon76/dsh-pi-tui@0.5.1`, dev DSH deps `0.2.0-rc.2`
- **SDK:** `@stencil-hq/tern@0.1.0` from the public registry (exact pin,
  `devDependencies` only; see §Dependency)
- **Real terminal:** Tern `0.6.2 (4b3ed42)` on this host, driven headless with
  `tern serve` + `tern ctl` (see §Real Tern smoke)

## Deliverables (all experimental)

| Path | What it is |
|---|---|
| `scripts/tern-tsp-transcript-spike.mts` | Manually runnable spike: SDK `connect` → one `inline` surface → deterministic replay → `n`/`q` → `close({keep:false})`. Exports `runTernTranscriptSpike` / `buildReplaySteps` / `applyReplayStep` for tests; direct execution is guarded. |
| `scripts/support/tern-tsp-transcript-view.ts` | Pure `TranscriptStructureBlock[] → TSP view` mapper plus `TranscriptNodeKeys`, the one replay-local presentation-key allocator. |
| `test/tern-tsp-transcript-spike.test.ts` | 22 tests: real fold → canonical projection → mapper → SDK `View.from`/`View.ops`, scripted-tty SDK composition, runner lifecycle, isolation. |
| `package.json` / `pnpm-lock.yaml` | `@stencil-hq/tern` added to `devDependencies` (not shipped; not reachable from `src/**`). |

No `src/**` file, public export, `cordis.patch.yml`, startup path, DSH port,
Direct/Remote adapter or published-bundle contract was touched. `git diff
--stat` against the base shows exactly `package.json`, `pnpm-lock.yaml` (both
dependency-only) and `docs/README.md` (one index row), plus the four new files
listed above.

## Dependency

- `pnpm view @stencil-hq/tern version` → `0.1.0` (published; installed as
  `@stencil-hq/tern@0.1.0`, integrity `sha512-CVwFMnlDcLzU9NeILdpaE3jlxMgiHbKuJr3RJ4cvnBZKT03gItIuO57JvSALEbwW03bXHlfCx24u+qgDXtzJZg==`).
- The published `0.1.0` is **not byte-identical** to the audited GitHub
  baseline `typescript/src`: `props.ts` widens `input.placeholder` from
  `string` to `Spans`, and `wire.ts` adds the blob `id` parameter to the framed
  `b` message. PR1 uses neither input placeholders nor blobs, so the spike was
  written and tested against the **published** declarations (`node_modules`),
  which is the version this document's evidence covers.
- The SDK ships `dist/*.d.ts` built with TypeScript 6; this repository's
  TypeScript 5.9.3 accepts them (`pnpm typecheck:bundle` green). No toolchain
  upgrade was needed.

## Source-to-sink proof (T3–T8)

The replay (`buildReplaySteps()`) is built from genuine durable
`SessionEvent` envelopes (`turn/start`, `user/message`, `tool/call`,
`tool/result`, `assistant/message`, `command/run`, `command/done`, `turn/end`)
plus one live `AssistantLiveInput` reasoning stream. It is applied to a real
`TranscriptFolder`; the mapper consumes only
`projectTranscriptStructure(folder.messages())`.

Canonical structure of the full replay:

```text
message:user · work(thinking+tool) · message:assistant · context-cluster(2)
· work(tool) · message:tool(ask_user_question) · message:command · message:tool(post-turn orphan)
```

What the tests pin (all against the shipped `code under test`, never a second
hand-authored tree):

| Item | Evidence |
|---|---|
| T3 | Real events → folder → `projectTranscriptStructure()`; mapper emits `card`/`section`/`tool`/`md`/`badge` nodes with the fold's own text and the canonical cluster summary (`AGENTS.md · skill-catalog`). |
| T4 | The ambient pair clusters (2 members) and the following non-ambient Work row flushes it instead of joining it. |
| T5 | Step 1 → step 2 `View.ops` is a small delta: the growing reasoning text is `['text', '….body', 'append', ' boundaries and the ambient clusters']`, the settled tool is a single `['set', '….msg-3', {status:'done'}]`, no `del`, no `move`, and no op touches the user card or the Work container. |
| T6 | Two legitimate rebuilds are pinned: a merged read-group card **replaces** the carrier object (its Work container is legitimately `del`+`add` while the untouched user card keeps its id), and adding a second raw-adjacent ambient row coalesces a lone standalone Context row into a cluster — the carrier object and its allocation key are retained, but its full node id moves from `main.msg-N` to `main.ctx-msg-N.msg-N`, so the standalone node is legitimately `del`+`add`. Stability is therefore scoped to retained nodes whose **parent structure is unchanged**; this is the honest identity limit, not an asserted impossible stability. |
| T7 | Two Work spans sharing turn 1 with identical text get distinct container ids; `View.from` accepts the view and all ids are unique. Negative control: two siblings with one key really do throw `ViewError`. |
| T8 | The settled `ask_user_question` and the `/status` command are standalone root children (never Work members); the post-turn orphan result renders as a warning `card` with an `unmatched result` badge and **no** status (no fabricated success); a `<system-reminder>` body goes through `systemContextBody()` (no raw envelope XML) and shows the source-derived `ambient` kind badge. |

## Verification results

| Command | Result |
|---|---|
| `node --test --import tsx/esm test/tern-tsp-transcript-spike.test.ts` | **22 pass / 0 fail** |
| `node --test test/tern-tsp-transcript-spike.test.ts` (plain Node, the `test:product` path) | **22 pass / 0 fail** |
| `node --test --import tsx/esm test/projection-convergence.test.ts test/transcript.test.ts test/compact-projection.test.ts test/transcript-reveal.test.ts test/tern-terminal.test.ts` | **280 pass / 0 fail** |
| `pnpm typecheck:bundle` | exit 0 |
| `pnpm build` (fork + bundle) | exit 0 |
| `node scripts/application-architecture-gate.mjs` | `ok (436 file(s), dependency direction clean)` |
| `client-boundary-gate` / `naming-gate` / `check-no-session-events` / `temp-hygiene-gate` | all ok |
| `pnpm pack:release` on the pre-fix snapshot; post-fix re-runs below | exit 0 — see §Product suite |
| `git diff --check` (unstaged) and `git diff --cached --check` (staged) | clean |

## Product suite

Snapshot qualifier (the repository's "a lane is green only on the state it ran
against" rule): the release lane below ran on the tree **before** the internal
review's P3 fix (20 spike tests). Every later delta touched only
`scripts/**`, `test/**` and `docs/**`, so the lanes whose inputs are `src/**`,
`dist/**` or the packed manifest are inherited explicitly while the invalidated
`typecheck:bundle` / `test:product` lanes were re-run per snapshot.

| Stage | Snapshot | Result |
|---|---|---|
| `pnpm pack:release` → `prepack` `clean` + `clean:fork` + `build` (fork `tsdown` + bundle `tsdown`) | pre-fix (20 spike tests) | exit 0 |
| `pnpm pack:release` → `prepack` `typecheck:bundle` (`tsc -p tsconfig.json --noEmit`) | pre-fix | exit 0 |
| `pnpm pack:release` → `prepack` `test:product` (`test/*.test.ts` + `test/tarball-smoke.test.mjs`) | pre-fix | **7262 tests / 7262 pass / 0 fail** |
| `pnpm pack:release` → `postpack` `tarball-smoke`, `extension-fixture`, `advanced`, `phase4`, `unstable`, `vim`, `examples`, `compose-agent-compat` | pre-fix | exit 0 (`compose-agent-compat-smoke: verified xmoon76-dsh-pi-tui-0.5.1.tgz`) |
| `pnpm typecheck:bundle` + `pnpm test:product` (re-run after the internal-review P3 fix) | post-P3 (21 spike tests) | exit 0 · **7263 tests / 7263 pass / 0 fail** |
| `pnpm typecheck:bundle` + `pnpm test:product` (re-run after the external-review delta: the Context-coalescing identity test) | final (22 spike tests) | exit 0 · **7264 tests / 7264 pass / 0 fail** |

Every delta so far touches only `scripts/**`, `test/**` and `docs/**`, none of
which is packed (`files` = `dist`, `cordis.patch.yml`, `generated`,
`README*.md`, `LICENSE`) or rebuilt, so the postpack smokes, the built
`dist/**` and the published declaration graph are inherited unchanged.

`pack:release` produced `xmoon76-dsh-pi-tui-0.5.1.tgz` (gitignored). The tarball
contains only `dist/`, `cordis.patch.yml`, `generated/`, `README*.md` and
`LICENSE`; `scripts/**` and `test/**` are not shipped, so the dev-only SDK
dependency does not enter the released artifact.

## Real Tern smoke (T2)

Because a real Tern binary is installed on this host, T2 is **DONE** (not
BLOCKED): a headless Tern session was driven with the SDK's own documented
control surface.

Method (no GUI needed):

```sh
tern serve --control /tmp/tern-pr1.sock --out /tmp/tern-pr1-shots   # background
tern ctl --control /tmp/tern-pr1.sock ready
tern ctl --control /tmp/tern-pr1.sock --file /tmp/tern-pr1-scenario.txt
tern ctl --control /tmp/tern-pr1.sock quit
```

The scenario `run`s the spike inside the pane's shell with
`TERN_TSP_RECORD=/tmp/tern-pr1-rec.jsonl`, then drives `key n`, `key q`,
`shot` and `wait`.

Observed:

- **Handshake:** the recording begins with the spike's `q`/`hello` and Tern's
  real reply — `term=tern`, `ver=0.6.2`, `cols=160`, `credits=2`, all 44 kinds,
  `features=[blobs, settle, adopt, dock, program-palette, reduce-motion, aside,
  scroll, styles, flow]`.
- **Native render:** screenshots after each `n` show the transcript painted by
  Tern itself — the `You` card, a `Work · turn 1` section holding `Thinking` and
  a `Read src/tui/transcript/structure.ts` tool card (args + result as code
  blocks), the `Assistant` card, the `AGENTS.md · skill-catalog` Context
  cluster with two `ambient` member cards, a second `Work · turn 1` with
  `Bash pnpm test --filter transcript`, the standalone `Question` card, the
  `/status` card with a `Done` badge, and the warning `Tool call` card with the
  `unmatched result` badge.
- **Live update:** the shot element count grows per step
  (`455 → 523 → … → 669`), and Tern acks every frame.
- **Incremental wire proof:** the recording contains exactly **7 frames**, one
  per replay step. Frame 3 (`s=3`), which advances the running step to the
  settled one, carries only:

  ```json
  ["add", "main.msg-4", "main", null, {…Assistant card…}]
  ["set", "main.work-msg-2.msg-3", {"status": "done"}]
  ["add", "main.work-msg-2.msg-3.result", "main.work-msg-2.msg-3", null, {…code…}]
  ["set", "main.work-msg-2.msg-2", {"status": null}]
  ["set", "main.work-msg-2.msg-2.body", {"stream": null}]
  ["text", "main.work-msg-2.msg-2.body", "append", " boundaries and the ambient clusters"]
  ```

  No retained node is deleted or re-created; the growing text is an SDK
  `append`. This is the same delta the unit test asserts, now confirmed through
  a real Tern ack loop.
- **Clean close:** `q` sends `x` with `{"id":"s1","keep":false}`; the shot
  element count drops back to the 440-element baseline showing the shell
  prompt, and subsequent shell commands in the same pane run normally (no raw
  mode leak, no leftover surface).

### Interrupt / signal exit (real Tern pane)

Each signal run: start the spike in the pane with
`TERN_TSP_RECORD=/tmp/…jsonl`, confirm the `node` process id via
`/proc/<pid>/cmdline`, deliver the signal, then confirm the pane is usable
again with a follow-up shell command.

| Case | Observed |
|---|---|
| `kill -INT <node pid>` (real SIGINT) | process exits with status **130** in the pane; the recording holds `x {"id":"s1","keep":true}` and no further frames; `echo PANE_ALIVE_INT=$?` runs afterwards and the prompt returns — tty restored, no live surface, no input owner left |
| `kill -TERM <node pid>` (real SIGTERM) | process reported `terminated` with status **143**; recording holds `x {"id":"s1","keep":true}`; `echo PANE_ALIVE_TERM=$?` runs and the prompt returns |
| real Ctrl+C **keystroke** | NOT reproducible through the headless control tooling: a raw-byte probe showed `key n` delivers `BYTES 6e`, while `key Control+c` (and its accepted name variants) delivers **no byte at all** to the pty — Tern consumes the chord. The Ctrl+C path is therefore covered at the SDK/runner level (a stub key `{name:'c',ctrl:true}` reaches the same owned cleanup), not as a real keystroke; the SDK itself maps a terminal `0x03` in raw mode to that key |

Two different close semantics are visible and are SDK-owned, not spike logic:
the normal `q` path closes with `keep:false` (the demo leaves no panel), while
the SDK's signal hook closes with `keep:true`, so Tern keeps the final `main`
in the pane **scrollback** — the surface itself is closed and no raw-mode or
input ownership remains. Changing the signal-time `keep` would mean taking
signal handling away from the SDK session owner, which PR1 deliberately does
not do (see §PR2 handoff).

Raw artifacts live in `/tmp/tern-pr1-rec*.jsonl` and `/tmp/tern-pr1-shots/`
(synthetic fixture content only). They are **not committed**: the recordings are
excluded from Git per the plan, and the shots are regenerable.

### Negative environments (real Tern pane)

Run inside the same real Tern pane:

```sh
for v in TERN_TSP=0 TMUX=x STY=y ZELLIJ=1; do env $v node --import tsx/esm scripts/tern-tsp-transcript-spike.mts; echo EXIT_$v=$?; done
node --import tsx/esm scripts/tern-tsp-transcript-spike.mts | cat
```

All five cases print
`Tern Surface Protocol unavailable (not a supported Tern pane); no surface
opened.` and exit `0`, with no surface and no recording. Additional cases are
covered by the automated suite, which drives the **real** SDK `connect` with
scripted ttys: `TERN_TSP=0`, `TMUX`, `STY`, `ZELLIJ` and a non-tty all return
`null` without ever calling `setRawMode`; a tty that never answers the
handshake returns `null` after `raw [true, false]` (tty restored). A thrown SDK
error is never converted into `unsupported`.

## Lifecycle (T9)

- The runner adds **no** stdin listener and owns no raw mode: input comes only
  from the SDK session's async iterator.
- `runTernTranscriptSpike` creates the surface **inside** the owned scope and
  closes it with `keep:false`, then always closes the session (nested `finally`),
  on normal quit, Ctrl+C, self-ended session, render failure, surface-close
  failure and a throwing `session.open()`. Each case is a test with a stub
  session; a render/close/open error propagates to the caller with a non-zero
  CLI exit.
- With a scripted Tern tty and `exitHooks: true`, the process `exit` / `SIGINT`
  listener counts return to their pre-run values.
- Real-process interrupts were exercised in the real Tern pane, not only with
  stubs: SIGINT exits with status 130 and SIGTERM with status 143, each leaving
  `x {"id":"s1","keep":true}` in the recording and a usable shell afterwards
  (§Interrupt / signal exit). A real Ctrl+C keystroke is not synthesizable
  through `tern ctl` (raw-byte probe), so that key path stays stub-covered.

## Isolation (T10)

- `git diff --stat <base>` = dependency files + `docs/README.md` (one index row)
  + four new non-`src` files.
- A test asserts every import specifier of the two spike modules resolves to
  `node:*`, `@stencil-hq/tern`, `@deepseek-ai/*`, `src/domain/**`,
  `src/tui/transcript/**` or `src/runtime/assistant-stream-port.ts`.
- `pnpm build` / `pnpm typecheck:bundle` green; the architecture gate is clean.

## Plan checklist mapping

| Plan item | Status | Evidence in this document |
|---|---|---|
| §1.1 handshake on a real Tern pane; fail closed on `TERN_TSP=0`, non-TTY, tmux/screen/zellij, no hello | DONE | §Real Tern smoke, §Negative environments (real pane + automated; `setRawMode` untouched on the declines, restored after a silent handshake) |
| §1.1 real typed events → `TranscriptFolder` → `projectTranscriptStructure()` | DONE | §Source-to-sink proof (T3) |
| §1.1 mapper consumes the projected blocks, not hand-crafted nodes | DONE | `transcriptView()` takes only projector output; T3–T8 |
| §1.1 replay into the same folder emits a diff; retained ids stable; text growth appended | DONE | T5 + real frame `s=3`; stability is scoped to retained nodes whose parent structure is unchanged (T6) |
| §1.1 real Tern paints updated nodes | DONE | §Real Tern smoke (455→…→669 elements, 7 acked frames) |
| §1.1 terminal released on close and on manual Ctrl+C / signal cleanup | DONE | normal `q` close with `keep:false` and real SIGINT/SIGTERM exit with `x keep:true`, both leaving a usable shell and no live surface (§Interrupt / signal exit); the Ctrl+C **keystroke** is not synthesizable by the headless tooling and is covered by the runner test, as recorded there and in §Lifecycle |
| §1.1 non-Tern invocation exits cleanly with an explanation, no renderer | DONE | §Negative environments (exit 0, no surface, no recording) |
| §1.1 explicit proved / not-proved statement | DONE | §What PR1 proved, and what it did NOT prove |
| §1.2 every Must-NOT | DONE | §Isolation + §Verification results; diff review confirms no `src/**`, startup, export, preset or Host-port change |
| §3 file set; no `src/**`; no speculative production directory | DONE | §Deliverables |
| §4 Step A dependency / Node / TS gate | DONE | §Dependency |
| §4 Step B deterministic real-event replay with one folder | DONE | `buildReplaySteps()` + `applyReplayStep()`; T3 |
| §4 Step C mapper top-level cases and per-kind handling | DONE | §Source-to-sink proof; T3/T4/T8 |
| §4 Step D stable keys and incremental `View.ops` | DONE | T5/T6/T7 |
| §4 Step E standalone session loop (`connect` first, `keep:false`, error propagation, no diagnostics while active) | DONE | §Lifecycle (T9); only the unsupported note and the post-close summary reach stdout |
| §5 T1 | DONE | runner + real-SDK decline tests |
| §5 T2 | DONE (real Tern on this host) | §Real Tern smoke |
| §5 T3 | DONE | §Source-to-sink proof |
| §5 T4 | DONE | ambient cluster + Work-boundary assertions |
| §5 T5 | DONE | unit `View.ops` + real frame `s=3` |
| §5 T6 | DONE | merged read-group replacement test (legitimate `del`+`add`) |
| §5 T7 | DONE | sibling spans + duplicate-key negative control |
| §5 T8 | DONE | settled interaction, command, orphan, safe Context body |
| §5 T9 | DONE | runner lifecycle tests + scripted-tty hook release |
| §5 T10 | DONE | §Isolation |
| §5.2 real-Tern matrix (direct pane, `TERN_TSP=0`, tmux/STY/ZELLIJ, piped stdout) | DONE | §Real Tern smoke, §Negative environments |
| §5.2 SSH to a supported Tern pane | NOT ATTEMPTED | no Tern-capable SSH target on this host; not claimed as verified |
| §5.2 controlled render/input failure cleanup | DONE at the SDK/runner API level | §Lifecycle render/close/open-failure tests; no malformed control bytes were injected into a live terminal |
| §8 stop conditions | none triggered | — |
| §9 PR-level completion checklist | DONE | §Deliverables, §Verification results, §Product suite, §What PR1 proved / did NOT prove, §PR2 handoff |

## What PR1 proved, and what it did NOT prove

**Proved**

1. Official `@stencil-hq/tern@0.1.0` connects to a real Tern `0.6.2`, opens one
   `inline` surface, paints native nodes, acks frames, receives `n`/`q` keys and
   closes cleanly with `keep:false`.
2. Real `SessionEvent`/live-stream inputs → the production `TranscriptFolder` →
   `projectTranscriptStructure()` → native TSP nodes, including honest special
   families (settled interaction, command, post-turn orphan, safe Context body).
3. Incremental rendering through the SDK: unchanged nodes keep their ids; text
   growth is an `append`; only genuinely new rows/children are added. The
   guarantee is scoped to retained nodes whose parent structure is unchanged;
   a merged read group (new carrier) and a Context coalescing (new parent) both
   rebuild legitimately and are pinned as such.
4. Unsupported environments fail closed with an explanation and no surface.
5. Real-process interrupts in a real Tern pane (SIGINT → status 130, SIGTERM →
   status 143) close the surface and release the tty, leaving a usable shell;
   the normal close path leaves no panel (`keep:false`).

**Not proved (do not inherit as done)**

1. No live DSH Host session is attached. The spike replays a fixed synthetic
   event list; it does not subscribe to real session events, generations or
   Direct/Remote adapters.
2. No production launch/selection path exists: `dsh --profile pi-tui`,
   `src/startup.ts`, `src/index.ts` and `surface/runtime.ts` are untouched.
3. No editor/prompt submission, `/command` input, Question/Approval capture,
   search/reveal, Ctrl+O disclosure, media upload or plugin renderer parity.
4. Identity is **replay-local and parent-structure-scoped**: a
   `WeakMap<TranscriptMessage,string>` per surface, and the stable unit is a
   retained node whose parent structure is unchanged. It is not a durable or
   wire identity, cannot survive cold hydration or a recreated folder, and a
   retained carrier can legitimately have its FULL node id rebuilt when the
   canonical projector restructures its parent — both a merged read group
   (carrier object replaced) and a Context coalescing (same object, new
   cluster parent) do this; T6 pins both.
5. The rendering is a structural preview: expanded Work members and nested
   Context member cards are inspection aids, not Focus/Compact/Full parity.
   Assistant `content`/`displayBlocks` beyond the flat `text`, user attachment
   blocks and grouped-sub-call trees are not specially presented.
6. Mapper branches for rows the replay never produces are untested: the
   non-context `system` (`llm-retry` / `turn-max-tokens`), `compaction`,
   `workflow` and `summary` cases exist because `TranscriptMessage` is a closed
   union the mapper must answer exhaustively; they are "if they appear" handling
   (plan §4 Step C), not covered by the T-matrix.

## PR2 handoff (recorded unknowns, not implemented)

1. **Mount seam:** `src/app/surface/runtime.ts` owns `TuiApp`; PR2 must define
   the minimal callbacks a native surface needs without copying the app state
   machine.
2. **Backend selection:** a single pre-PiTui startup decision that keeps
   `src/startup.ts` a zero-dependency island.
3. **Live snapshot:** feed the mounted adapter from the same SessionPresentation
   that supplies PiTui, with generation/stale fencing and no second
   `TranscriptFolder`.
4. **Durable identity:** decide the source-backed identity that survives merged
   reads, Context coalescing and cold reconstruction, replacing PR1's
   replay-local `WeakMap`. PR1's guarantee is deliberately narrow: a retained
   node keeps its id only while its parent structure is unchanged; the merged
   read group and the Context cluster both rebuild legitimately.
5. **Signal-time disclosure:** the SDK session owner closes the surface with
   `keep:true` on SIGINT/SIGTERM (content stays in the pane scrollback), while
   the spike's own path uses `keep:false`. Decide whether production TSP wants a
   different signal-time `keep` before taking signal handling away from the SDK.
6. **Editor ownership:** route SDK key/edit/send into the existing submission
   authority while preserving Question/Approval and plugin editor-seat
   semantics.
7. **Extension policy:** `RendererRegistry`/`ExtensionView` are a terminal ABI;
   decide the unsupported/host-fallback behavior explicitly.
8. **Search/disclosure:** preserve `transcriptRevealPathFor()` owner semantics
   when replacing PiTui viewport geometry with native `Surface.reveal/scroll`.
9. **Package strategy:** production TSP needs its own runtime dependency,
   lazy-loading and footprint decision; PR1's pin is dev-only.

## Reproduction

```sh
pnpm install && pnpm build
node --test --import tsx/esm test/tern-tsp-transcript-spike.test.ts
node --import tsx/esm scripts/tern-tsp-transcript-spike.mts   # inside a real Tern pane
```
