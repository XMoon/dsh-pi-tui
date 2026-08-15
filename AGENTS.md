# AGENTS.md

dsh-pi-tui — a third-party TUI mode for DeepSeek Harness (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui). Read this file before editing.

## Naming (hard rules)

Collision-avoidance is a deliberate choice: the official dsh project will plausibly ship its own `dsh-tui` / `@deepseek-ai/dsh-tui`, so nothing here may use that family.

| Thing | Name | Notes |
|---|---|---|
| Repository | `dsh-pi-tui` | repo root (this directory) |
| Profile (`dsh --profile`) | `pi-tui` | **Never `tui`** — that is reserved territory |
| Vendored fork package | `@xmoon76/pi-tui` | rescopped from `@moonshot-ai/pi-tui`; `private: true`, **never published** — bundled into the release package at build time |
| Bundle package | `@xmoon76/dsh-pi-tui` | the `dsh.bundle` patch layer; the **only** published package |
| Plugin row ids | `tui-startup`, `tui-app` | internal Loader ids, fine as-is |
| Startup service | `tuiStartup` (`TUI_STARTUP_SERVICE`) | |

## Repository layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork. The vendored version
                    and upstream commit live in ONE place —
                    packages/pi-tui/package.json `repository.note` (see
                    that field, never a copy in this file or README). Its
                    own AGENTS.md (kept from the fork) is the source of
                    record for the local divergence fixes and their
                    guarding tests; re-verify every entry on each
                    re-vendor. native/ prebuilds are NOT vendored; loading
                    degrades gracefully without them.
packages/dsh-pi-tui/   The dsh bundle (the only published package). cordis.patch.yml
                    inserts the startup row (parses `dsh --profile pi-tui` flags)
                    and the runner row (starts the TUI). src/tui-app.ts is the
                    testable surface core (terminal injected); src/theme.ts the
                    palette; demo.ts a standalone interactive demo. Builds with
                    tsdown into dist/, bundling @xmoon76/pi-tui (deps.onlyBundle)
                    so the tarball is self-contained; dist/ is gitignored —
                    build before install. The tarball is verified by
                    scripts/tarball-smoke.mjs (prepack builds+verifies,
                    postpack smokes the exact bytes; root `pnpm pack:release`).
```

## Key decisions (do not silently reverse)

1. **In-process bundle, not BFF client.** Like `dsh-headless`, the TUI runs inside the Cordis context and consumes `ctx.*` services directly. The web surface's remote RPC exists only because a browser cannot be in-process; a TUI has no such constraint. Remote attach via the apiproxy is **explicitly not planned** (removed from the roadmap).
2. **Vendored fork, not npm dependency.** `@moonshot-ai/pi-tui` is not published (npm 404). Vendored from the kimi-code fork (not upstream pi-mono) to keep its five local fixes: CJK wrap recursion guard, container width clamp, overwide-line truncation instead of throw, negative-width guards, per-frame processed-line reuse. Re-verify those on every re-vendor — the fork's AGENTS.md lists them with guarding tests.
3. **`TuiMainScreen`, not `TUI`.** In this fork the constructible entry is `TuiMainScreen` (main screen + scrollback, `mode: "regular"`); the README's `new TUI(...)` is stale upstream docs. `TuiAltScreen` is the alternative.
4. **Source exports, built artifacts.** Both packages build with tsdown (`dist/`); dsh-pi-tui bundles the vendored pi-tui fork (`deps.onlyBundle: ['@xmoon76/pi-tui']`, the kimi-code pattern) so the published tarball is self-contained. `exports` point at built files; neither `dist/` is committed — build before installing into a profile. Node 26 refuses type-stripping inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts`-exporting package cannot load from a profile's node_modules.
5. **No native prebuilds.** darwin/win32 modifier-key addons are optional; the loader returns `undefined` on other platforms without attempting a load. Revisit only if modifier detection matters on macOS/Windows.
6. **`chalk` is a runtime dependency** of `dsh-pi-tui` (theme.ts lives in `src`, unlike pi-tui's tests-only chalk).
7. **Single-package release model.** `@xmoon76/pi-tui` is `private: true` and never published (same as `@moonshot-ai/pi-tui` in kimi-code); `@xmoon76/dsh-pi-tui` is the only registry package and carries the fork inside its dist. Its `dependencies` therefore list pi-tui's runtime deps (`marked`, `get-east-asian-width`) directly, and `@xmoon76/pi-tui` lives in `devDependencies` (build-time only).
8. **Fix in dsh-pi-tui first; keep the fork pristine.** Anything achievable on the consumer side must be implemented in `packages/dsh-pi-tui` — every fork change is a divergence that must be re-verified on every upstream sync (the fork's AGENTS.md lists them with guarding tests). Only touch `packages/pi-tui` when the fix is impossible from the consumer. Example: the slash-command autocomplete lag (the fresh list never painted in fullscreen because the editor's render requests target the stopped main screen) is fixed by `TuiApp.routeInput` forcing a repaint of the ACTIVE screen — no fork change needed.

## Development

```sh
pnpm install
pnpm build          # pi-tui tsdown (dist/) + dsh-pi-tui tsdown (dist/, bundles pi-tui)
pnpm test           # pi-tui's own suite (node --test) + dsh-pi-tui headless tests
pnpm typecheck
node --import tsx/esm packages/dsh-pi-tui/demo.ts   # standalone demo in a real TTY
```

### Installing into the local dsh profile (dev loop)

Two profiles exist. **Never touch `pi-tui`** — it is the real-use profile and
installs the published upstream package from the npm registry:

```sh
dsh plugin --profile pi-tui -- add "@xmoon76/dsh-pi-tui"   # registry install (0.1.x)
dsh --profile pi-tui [--session <id>]                      # real use
```

Development runs in the **`pi-tui-dev`** profile, whose `package.json`
declares a `link:` dependency to this repo (a live symlink, so a `pnpm build`
is picked up immediately — no re-install, no store copies):

```sh
# one-time setup (idempotent): create/repoint the dev profile at the repo
mkdir -p ~/.dsh/profiles/pi-tui-dev
cat > ~/.dsh/profiles/pi-tui-dev/package.json <<'EOF'
{
  "name": "dsh-profile-pi-tui-dev",
  "private": true,
  "dependencies": { "@xmoon76/dsh-pi-tui": "link:/home/xmoon/project/me/dsh-pi-tui/packages/dsh-pi-tui" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@xmoon76/dsh-pi-tui"] } }
}
EOF
cd ~/.dsh/profiles/pi-tui-dev && pnpm install
# dev loop: rebuild the bundle, then run the dev profile
pnpm build
dsh --profile pi-tui-dev [--session <id>]
```

Restoring a messed-up `pi-tui` profile: reinstall the registry package from
the lockfile (`cd ~/.dsh/profiles/pi-tui && pnpm install --frozen-lockfile`).
The profile's `pnpm-workspace.yaml` excludes `@xmoon76/dsh-pi-tui@0.1.x` from
the minimum-release-age policy; if the supply-chain check still rejects the
version, append it to `minimumReleaseAgeExclude` or pass
`--config.minimum-release-age=0`.

Headless UI tests drive `@xterm/headless` through `packages/dsh-pi-tui/test/virtual-terminal.ts`
(copied from the fork's `test/virtual-terminal.ts`, import path changed) — rendering
and input routing are verified without a TTY or a model connection.

## Reusable flow (from the initial build, worth repeating for the next capability)

1. **Read both sides before designing**: the dsh bundle shape (`packages/bundle/web-app`: startup.ts commander row + index.ts glue + `cordis.patch.yml` with `dsh.bundle.patch`), and the library's real API (check `src/index.ts` exports, not the README).
2. **Vendor**: `rsync -a --exclude native --exclude CHANGELOG.md --exclude node_modules` from the fork; rescope the package name; keep LICENSE + the fork's AGENTS.md; record the upstream commit in `repository.note` (the single source of truth — do not copy the version/commit into root docs); run the fork's own test suite unchanged as the sync gate.
3. **Bundle skeleton**: package with `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; patch inserts a `*-startup` row (commander via `@deepseek-ai/dsh-cmdline`'s `parseCmdline`, provides a service) and a runner row injecting that service; exports `./startup` and `./cordis.patch.yml`.
4. **Testable core**: inject the terminal (`Terminal` interface) so tests drive a `VirtualTerminal`; keep the process entry (`ProcessTerminal`) as a thin wrapper.
5. **Verification matrix** (all passed in the P0 spike): fork's own tests; headless render/input/exit; the full import chain under the tsx ESM hook (dsh source-launch contract, incl. `@deepseek-ai/dsh-cmdline` + commander); non-TTY stdin guard (`setRawMode` existence check); native graceful fallback.
6. **Install path**: `dsh plugin --profile pi-tui -- add <package>` — `dsh plugin` reconciles `dsh.profile.bundles` from installed state, so any dependency declaring `dsh.bundle` joins the layer stack automatically; no dsh installation edits needed.

## Traps hit (do not reintroduce)

- **`TUI` is not constructible** — use `TuiMainScreen` (see decisions).
- **`constructor(private readonly x: T)` parameter properties** fail Node's strip-only mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — write them as explicit fields.
- **Returning a mutable counter by value** in test helpers: `return { exits }` copies the number; closures update the local, assertions read the stale copy. Expose a getter or an object.
- **`TuiInputListener` must return `TuiInputListenerResult`** (or `undefined`) — a bare `void` arrow fails typecheck; return `{ consume: true }` for handled keys like Ctrl+C.
- **Editor needs a theme** (`EditorTheme`) — pi-tui ships no default; `packages/dsh-pi-tui/src/theme.ts` is the palette.
- **`imports` `#/*` alias** in the fork's package.json: fine for its internal `src` imports under tsx/Node 24+, but any future `dist` build must bundle (tsdown) rather than tsc-emit, or the alias must go.
- **tmux `send-keys` looks like a paste to the editor**: `send-keys 'text' Enter` delivers the whole batch in a few ms; the editor's `PasteBurst` heuristic (≥8 plain chars within 8ms, Enter suppressed for 120ms) then turns Enter into a newline, so submissions silently "don't work". This is upstream design (protects against non-bracketed-paste terminals), NOT a regression — real keyboards type slower than 8ms/char. When driving the TUI from tmux, type with a pause: `send-keys 'text'`, sleep ≥0.3s, then `send-keys Enter`. (Learned while real-testing the 2026-08 fix batch.)
- **`setFullscreen` must refocus the editor**: a fresh `TuiAltScreen` starts with no focused component — after Ctrl+F the app-level listener still handles shortcuts but text and Enter are dropped, making the transcript look frozen. `TuiApp.setFullscreen` sets focus on the alt screen when entering and restores it on the way back; keep that when touching fullscreen (guarded by the "editor input routes to the alt screen" headless test).

## Cross-process safety (2026-08 batch)

- **dsh has no cross-process session coordination**: two dsh processes (TUI + web, or two TUIs) holding one session can mint the same `seq` (each numbers from its own in-memory log length) and corrupt the log at the `session/end-seed` resume marker. This is an upstream limitation — the TUI cannot fix it, only detect and warn (README documents the "one surface per session" rule).
- **`src/guard.ts`** — divergence guard: before each session-writing submission, `locate()` + `fs.stat` gate (cheap) then `readFrom(id, 0)` (full committed read) compares the file's committed event count against the live `session.events.length`; file ahead of memory ⇒ external writer ⇒ block. The second identical operation forces through a ONE-TIME token binding session, observed file revision, action (`submit` vs `save`) and a draft fingerprint — an edited draft, a swapped key, a new revision or a session switch invalidates it. A same-count but different-tail rewrite (same `seq`/`type`/content-hash comparison) reports `tail-mismatch` and blocks too. Guard state is per-session and resets on switch. `readFrom` throws on a corrupt committed prefix — that is the unreadable case.
- **`src/diag.ts`** — `ctx.logger` is invisible in this process (no exporter), so the TUI's own diagnostics go to stderr + `$DSH_HOME/logs/pi-tui-<pid>.log` (env `DSH_PI_TUI_LOG` / `DSH_PI_TUI_LOG_LEVEL`, default `info`). Keep new lifecycle logging in diag, not just ctx.logger. Fire-and-forget tasks go through `src/detached.ts` — **never a bare `void somePromise()`** — via one of two entries, BOTH taking a TASK FACTORY invoked SYNCHRONOUSLY before the helper returns (ownership actions like Ctrl+G's `stop()` take effect immediately; a synchronous throw is converted to a rejection and classified like any other): `runDetached(label, () => task, opts)` for detached work with NO result consumer (settings writes, theme autodetect, skill refresh), and `runOwned(label, () => task, { isCancellation?, onResult, onCancel, onError })` for result-consuming main flows (submit/steer dispatch, command execution, local commands, local-shell card settle, session switch, question flows, model-menu loads, external editor). Failure phases are DISTINCT: (1) the TASK phase (factory throw / task rejection) classifies cancellations — error shape (`isCancellation`, `cancellationError(...)`) plus the task-local `isCancellation` predicate (use it when only the task knows it was cancelled: `() => localSignal.aborted`, `() => this.disposed`) — and records DEBUG for cancellations / ERROR for failures; (2) `onResult` is the RESULT CONSUMER: its sync/async failure is a PRIMARY failure — ERROR + `onError`, never a cancellation, regardless of error shape (even an AbortError) or task-local state, since the task already settled; (3) `onCancel`/`onError` are TERMINAL side-effect handlers and the task-local classifier: their own sync/async failures land exactly once in the `${label} handler failed` sink (thrown values are never mutated — primitives, null and frozen errors are carried by an internal wrapper), never re-classified, never repeated, zero unhandled rejections. Error observation is SYNC-TOTAL (`src/error-boundary.ts`): describing any legal thrown value (hostile Proxy/getter/coercion) can never make a chain reject — but an observer that spawns its OWN detached async work while being observed (e.g. `void Promise.reject(...)` inside `toString`) is OUTSIDE the contract; do not describe this module as a strict "any legal value, zero side effects" guarantee. The LIFECYCLE ROOTS are equally total: startup and exit (`src/index.ts` root catch, `src/exit.ts`) protect every step individually (session read, diag, cleanup, warn, hint, exit) so no throw can skip the teardown or leak a rejection — `flushWithTimeout` returns a deterministic `failed` outcome for any hostile rejection (never a misreported `timed-out`, and the disabled-timeout path always settles). Owned callbacks do CORRECTNESS FIRST (draft restore, card settle, controller release) and best-effort formatting/notify afterwards, all through the shared `safeErrorMessage`. UI-layer modules receive the owned entry by injection (`TuiAppEvents.runOwned`, `SubmenuDeps.runOwned`) — never their own bare `void`. The external-editor hook is a BOUND pair in `TuiAppEvents`: `openExternalEditor` requires `runOwned` (type union + constructor check), and the launch is SINGLE-FLIGHT with the ownership latch cleared in the outermost `finally` (a `stop`/`start` throw can never leave it stuck). The ONLY bare-`void` exceptions are the terminal sinks inside `src/detached.ts` itself and the two lifecycle roots (startup in index.ts, exit in exit.ts), each marked with an `allowlist` comment on the same line; `test/rules.test.ts` statically detects COMMON SINGLE-LINE `void call()` discards (recursive over src/, with matcher self-tests) — it is deliberately NOT a substitute for review or a type-aware lint (`@typescript-eslint/no-floating-promises`), and new hand-written `void` chains in the detected forms fail the suite.
- **`scripts/repair-session.mjs`** — standalone repair for corrupted logs (duplicate seq ⇒ renumber from the first collision with old→new reference remap; gap/unparsable ⇒ truncate; wrong frame layout ⇒ re-frame; torn tail ⇒ truncate at the last COMPLETE frame boundary with byte accounting). Resolves `decodeStorageRecord` from the dsh install; `--scan` lists damaged sessions read-only; `--yes` applies with a mandatory fsynced backup first and a post-write full verify. References to a seq that occurs MORE THAN ONCE are ambiguous: the repair REFUSES by default and requires `--duplicate-reference=first|last|segment` — never silently guess. The frame walker (`scanZstdFrames` in `repair-core.mjs`) is adapted from `dsh-session-persistence-jsonl` — dsh appends ONE zstd frame per flush, and `node:zlib`'s `zstdDecompressSync` only decodes the FIRST frame of a concatenated set, so frame-slicing is mandatory (verified against the 11079-frame ab79200b log). The walker never throws on a bad tail: it reports `tornStart`/`garbageStart` so a torn log is NEVER reported healthy.
- **Repaired logs must preserve the dsh frame layout**: the first frame has to decode to EXACTLY the header line, and each frame holds complete JSONL records. `compressLog` (repair-core.mjs) writes the header line alone in frame one, then the remaining lines in ~16 KiB plaintext chunks (checksummed like the harness writer). NEVER compress a repaired log as one whole-log frame: it decompresses fine but every dsh reader (`session.list`, `load`, `readFrom`) rejects it with `corrupt Zstandard session log: first frame is not exactly one header line` — this exact bug broke the web's session list when the 2026-08-15 repair rewrote three logs as single frames. `scanZstdLayout` is the layout gate used by both `--scan` and post-write verify. Repaired files are written 0600, same as the harness (`writeFileSync` must pass `{ mode: 0o600 }`, not the umask default).
- **Storage rows vs events**: file rows are the storage format; packed `*-chunks` rows (`seq0` + `dt`) expand via `decodeStorageRecord` into individual events with real `seq`. Any code that counts "events in the file" must expand rows first (guard's `readFrom` does; naive line-counting does not).

## Docs

- README.md — install and run instructions for humans.
