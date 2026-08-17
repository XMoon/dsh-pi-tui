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

## Working rules (user-enforced)

- **Never push to a remote (and never force-push) without the user's explicit
  confirmation** — commit locally only unless told otherwise.
- **English only** for every user-facing string, comment, commit message and
  doc — including preset description YAML and the context-injection label
  (both crept in as Chinese once); scan `src/` and `config/` for CJK before
  committing. i18n is deferred.
- **No near-synonym command names.** `/session` was renamed to `/status`
  after colliding with `/sessions`; before adding a command, check the
  existing set and the official dsh command set for confusion risk.
- **Reference, don't copy.** pi/kimi-code are appearance references; behavior
  is implemented in dsh-pi-tui itself.

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
                    scripts/tarball-smoke.mjs (prepack builds + runs the
                    suite, postpack smokes the exact packed bytes; root
                    `pnpm pack:release`).
```

## Key decisions (do not silently reverse)

1. **In-process bundle, not BFF client.** Like `dsh-headless`, the TUI runs inside the Cordis context and consumes `ctx.*` services directly. The web surface's remote RPC exists only because a browser cannot be in-process; a TUI has no such constraint. Remote attach via the apiproxy is **explicitly not planned** (removed from the roadmap).
2. **Vendored fork, not npm dependency.** `@moonshot-ai/pi-tui` is not published (npm 404). Vendored from the kimi-code fork (not upstream pi-mono) to keep its local fixes — originally five (CJK wrap recursion guard, container width clamp, overwide-line truncation instead of throw, negative-width guards, per-frame processed-line reuse); the ledger has grown since. `packages/pi-tui/AGENTS.md` is the source of record for every divergence and its guarding tests — re-verify each entry on every re-vendor.
3. **`TuiMainScreen`, not `TUI`.** In this fork the constructible entry is `TuiMainScreen` (main screen + scrollback, `mode: "regular"`); the README's `new TUI(...)` is stale upstream docs. `TuiAltScreen` is the alternative.
4. **Source exports, built artifacts.** Both packages build with tsdown (`dist/`); dsh-pi-tui bundles the vendored pi-tui fork (`deps.onlyBundle: ['@xmoon76/pi-tui']`, the kimi-code pattern) so the published tarball is self-contained. `exports` point at built files; neither `dist/` is committed — build before installing into a profile. Node 26 refuses type-stripping inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts`-exporting package cannot load from a profile's node_modules.
5. **No native prebuilds.** darwin/win32 modifier-key addons are optional; the loader returns `undefined` on other platforms without attempting a load. Revisit only if modifier detection matters on macOS/Windows.
6. **`chalk` is a runtime dependency** of `dsh-pi-tui` (theme.ts lives in `src`, unlike pi-tui's tests-only chalk).
7. **Single-package release model.** `@xmoon76/pi-tui` is `private: true` and never published (same as `@moonshot-ai/pi-tui` in kimi-code); `@xmoon76/dsh-pi-tui` is the only registry package and carries the fork inside its dist. Its `dependencies` therefore list pi-tui's runtime deps (`marked`, `get-east-asian-width`) directly, and `@xmoon76/pi-tui` lives in `devDependencies` (build-time only). **Every `@deepseek-ai/*` import is a `peerDependency`, never a `dependency`**: in-box packages resolve from the dsh installation itself, and a duplicate copy in the profile's `node_modules` crashes on the FIRST tool call (`Cannot read properties of undefined (reading prepare)`). After (re)installing the bundle into a profile, verify `node_modules` contains NO `@deepseek-ai` entry. Same rule for dsh context services: type them structurally (`ctx.sessionQuery`), do not add package dependencies for them.
8. **Fix in dsh-pi-tui first; keep the fork pristine.** Anything achievable on the consumer side must be implemented in `packages/dsh-pi-tui` — every fork change is a divergence that must be re-verified on every upstream sync (the fork's AGENTS.md lists them with guarding tests). Only touch `packages/pi-tui` when the fix is impossible from the consumer. Example: the slash-command autocomplete lag (the fresh list never painted in fullscreen because the editor's render requests target the stopped main screen) is fixed by `TuiApp.routeInput` forcing a repaint of the ACTIVE screen — no fork change needed.
9. **Busy-Enter preference mirrors the web's `busyEnter`** (`ui-conversation` submission policy): while the agent is running, plain Enter uses the configured mode (`queue` default | `steer`) and Ctrl+Enter ALWAYS forces queue mode (the anti-steer chord — it only differs from Enter when the configured mode is `steer`). Enter-steer sends the DRAFT ONLY (`steerAll` `onlyDraft`) — explicitly queued messages are never swept along, because already-steered input cannot be pulled back. **Local commands** (the TUI-owned set, `LOCAL_COMMANDS` in index.ts: /status, /settings, /queue, ...) always execute directly and are never steered; everything else — plain prompts AND per-skill slash commands — steers as its raw `/name` line, which the host's pre-step listener (dsh-tool-skill) resolves into the injected skill body: web parity, where a skill invocation is a plain `session.prompt` with no command-execution wire. The queue-pane hint and Ctrl+S are unchanged (the steer verb is always advertised).
10. **Question dialogs live in the editor SEAT, never a centered overlay.** `ask_user_question` renders inside `editorSeat` (kimi's `mountEditorReplacement` pattern): full width, above the footer, capped at 60% of the terminal height when COLLAPSED (8..24 content rows, re-derived on EVERY render by `QuestionFrame` — resize- and queue-safe). The flow is a logical capturing modal: `presentQuestion` suspends visible overlays, `settleQuestions` restores them, and overlays created during a question join the suspension graph (`closeOverlayHandle`) so reverse modal order survives. `QuestionFlow`'s budget math (required-first question row, pinned free-text input, hint) is proven against actual chrome — do not reintroduce a fixed `budget - N` body formula. **The whole page — question, detail, EVERY option with its description, the free-text row — is ONE unified scrollport** (PageUp/PageDown page it; the `↓ N more lines`/`↑ M up` marker reports the remainder), so on any screen size the question starts at the top and every description is reachable by scrolling; cursor moves (↑↓/digits/click) follow the pointer into view. An explicit expand (`e` or a fullscreen click on the marker) grows the frame toward 80% (budget up to 38) — the 60% cap is the DEFAULT, not a hard ceiling — and is a no-op when everything fits; it KEEPS the scroll position (reveals more where the user is looking), and scroll + expand reset on every tab change. The hint fit loop RESERVES `esc cancel` (it always survives; other verbs drop from the end), and empty free-text rows show a dim placeholder instead of a bare cursor block. Fullscreen clicks inside the frame route through the seat's bottom-derived geometry (`QuestionFrame.rows` + footer height) to `QuestionFlow.clickRow`. Full rationale: `temp/question-dialog.md` (gitignored; on the implementing machine).
11. **Surface catalog: prefetch + coordinator + STANDING-SCOPE cold skills, no probe code.** The first input must eventually see the effective agent-scoped command + human-skill catalog, but opening the TUI must not create a chat session: `--session` PREFETCHES the resumed agent's catalog before mount (synchronous install during command registration); the deferred start reads the cold HUMAN SKILL catalog through the effective preset's STANDING SCOPE (`agentPresets.standingKeyFor(id)` → `skills.snapshot({cwd, scope})` — no Agent, no session, no turn). **Composition probes are REMOVED** (module + tests deleted): host-level `session/created` observers (dsh-permission-presets) write durable knob events into every fresh session, so any probe fails the zero-event gate and materializes a session artifact (200ms write-behind) — verified empirically; never reintroduce `agents.create()` for catalog discovery. Post-mount refreshes go through ONE `CatalogRefreshCoordinator` (epoch + abort + latest-only commit; agent targets install the live surface, preset targets install standing skills only; target changes turn old skill wrappers into revalidating transitions; a standing degradation rides the applied outcome as a one-shot notice; `skills/change` bursts are coalesced by `CoalescingRefreshGate` and always re-read the CURRENT ownership). All upstream service access is isolated in `src/skill-catalog.ts` (structural types; `standingKeyFor`/`snapshot` are capability-detected — an upstream change degrades to missing commands, never a crash). Full contract: `docs/surface-catalog.md`.

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
the minimum-release-age policy. Note: `minimumReleaseAgeExclude` only affects
pnpm's RESOLUTION path — the frozen-lockfile verification path ignores it, so
if the supply-chain check still rejects the version pass
`--config.minimum-release-age=0` (or cleanly remove + `dsh plugin` re-add)
instead of debugging the exclude list.

Headless UI tests drive `@xterm/headless` through `packages/dsh-pi-tui/test/virtual-terminal.ts`
(copied from the fork's `test/virtual-terminal.ts`, import path changed) — rendering
and input routing are verified without a TTY or a model connection.

## Reusable flow (worth repeating for the next capability)

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
- **tmux `send-keys` looks like a paste to the editor**: `send-keys 'text' Enter` delivers the whole batch in a few ms; the editor's `PasteBurst` heuristic (≥8 plain chars within 8ms, Enter suppressed for 120ms) then turns Enter into a newline, so submissions silently "don't work". This is upstream design (protects against non-bracketed-paste terminals), NOT a regression — real keyboards type slower than 8ms/char. When driving the TUI from tmux, type with a pause: `send-keys 'text'`, sleep ≥0.3s, then `send-keys Enter` (full recipe: `docs/tmux-testing.md`).
- **`setFullscreen` must refocus the editor**: a fresh `TuiAltScreen` starts with no focused component — after Ctrl+F the app-level listener still handles shortcuts but text and Enter are dropped, making the transcript look frozen. `TuiApp.setFullscreen` sets focus on the alt screen when entering and restores it on the way back; keep that when touching fullscreen (guarded by the "editor input routes to the alt screen" headless test).
- **Cordis service access: property read without `inject` throws.** In a Cordis context, `ctx.tools` property access throws `cannot get property "tools" without inject` at runtime when the service is not in the component's `inject` list. For services that are optional or not injected, read them with `ctx.get('name')` (e.g. `ctx.get('tools')`, `ctx.get('agentPresets')`), never bare property access.
- **dsh services are scoped by the live agent OBJECT, not `ctx`.** The tool registry and the skill catalog are keyed by the agent object: `ctx.get('tools')?.get(name, liveAgent)` and `skills.list({ cwd, scope: liveAgent })`. Passing `ctx` as scope (or omitting scope and passing only `cwd`) silently returns `undefined`/empty — the `/skill` list and edit-diff cards both broke exactly this way once.
- **pi-tui render quirks to respect from the consumer side**: (1) an emptied pane does NOT clear its previously painted rows — `setQueueItems([])`/`setText('')` leaves old content on screen, so rebuild or hide the component instead of just repainting text; (2) the fork schedules its immediate render via `process.nextTick`, which runs BEFORE promise microtasks, so an asynchronously-resolved list paints one frame late.
- **Terminal queries (OSC 11 theme) must go through the ACTIVE screen**: in
  fullscreen, an OSC 11 background-color query written to the stopped main
  screen is swallowed by the alt screen and times out (800ms), so theme
  autodetect never lands. Same class as the routeInput fix: route queries
  through the active screen and keep the reply listener registered on both.
- **Esc after a submenu/panel return gets consumed**: entering a read-only
  viewer (e.g. a subagent transcript) from a SettingsList row and pressing
  Esc once can leave the viewer "sticky" — the panel's submenu machinery eats
  the first Esc before the app's `onSingleEscape` fires. Give read-only
  viewers a dedicated exit path and a headless test for the
  Esc-after-panel sequence; do not rely on the app-level single-Esc handler.
- **Fullscreen toggling can leave a stale dialog frame**: after Ctrl+F (or
  a settings toggle) exits fullscreen, the main viewport may keep showing a
  dialog frame even though the overlay stack is empty — toggling fullscreen
  must stop the alt screen and re-start the main TUI (clean repaint), not
  just migrate overlay handles.
- **Headless test timing: never assert on a fixed `setTimeout`.** In
  async/race tests, flush the microtask/event queue with an explicit
  `settle()`/deferred helper instead of
  `await new Promise(r => setTimeout(r, 30))` — the fixed delay makes the
  test timing-sensitive and flakes across runs.
- **Validate serializers against the real consumer's layout rules, not a self round-trip.** A `compressLog` test that asserted "round-trips as one frame" passed while every real dsh reader rejected the output. The round-trip only proves self-consistency; the layout gate is the consumer's own checks.
- **Never flatten a message's Markdown/Text into a static `Text` at build time.** The 5a76526 bullet-alignment change rendered assistant/user messages once at the then-current width and froze the result — a terminal resize then only re-wrapped the frozen lines: markdown tables could never reflow (border lines wrapped as plain text on narrow windows). Keep the child LIVE through a width-aware wrapper that applies the bullet/indent at `render()` time and returns a REFERENCE-STABLE array (same child instance + same width → same prefixed array) so the fork's per-frame processed-line reuse keeps hitting. `BulletedComponent` in tui-app.ts is the pattern.
- **The busy-Enter opposite chord is Ctrl+Enter, and it needs a terminal that reports modifiers.** Plain Enter + Ctrl+Enter are the same `\r` on legacy terminals; only Kitty CSI u (`\x1b[13;5u`) or xterm modifyOtherKeys distinguishes them. The chord is a convenience (queue mode while busyEnter=steer) — `/queue` remains available everywhere, so the chord silently falling through to the editor on legacy terminals is accepted (documented in /help).

## Correctness contracts (full detail in docs/)

The rules below must never be broken; the full contracts live in `docs/`.

- **One surface per session.** dsh has no cross-process session coordination: two processes (TUI + web, or two TUIs) holding one session can mint the same `seq` and corrupt the log. The TUI detects the external writer (`src/guard.ts`) and blocks the write; the identical operation again forces through with a ONE-TIME token (session + observed revision + action + draft fingerprint). Full contract: `docs/concurrency.md`.
- **Never a bare `void somePromise()`.** Fire-and-forget work goes through `src/detached.ts` (`runDetached` / `runOwned`, task factory invoked synchronously); the TASK / result-consumer / terminal-handler phases classify failures differently, and error observation is sync-total. The only bare-`void` exceptions are the sinks inside detached.ts (exempt by filename) and the two lifecycle roots, which carry an `allowlist` comment; `test/rules.test.ts` enforces the common forms. Full contract: `docs/failure-model.md`.
- **Never repair a log as one whole zstd frame** — dsh readers reject it (`corrupt Zstandard session log: first frame is not exactly one header line`). `scripts/repair-session.mjs` (`--scan` read-only; `--yes` applies with backup + verify) preserves the frame layout, refuses ambiguous duplicate-`seq` references, and writes 0600. Full contract: `docs/repair-session.md`.
- **Zero-event catalog probes — REMOVED, do not reintroduce.** Composition probes were deleted along with their tests: `session/created` observers in this deployment write durable knob events, so any probe both fails a zero-event gate and materializes an artifact. Cold catalog discovery goes through the standing scope only (`standingKeyFor` + `snapshot`); never call `agents.create()` for a catalog. Full contract: `docs/surface-catalog.md`.

## Docs

- README.md — install and run instructions for humans.
- docs/README.md — index of the docs and how they evolve.
- packages/pi-tui/AGENTS.md — the fork's divergence ledger (guarding tests per fix).
- When you change behavior, record the decision or trap in its owning doc at the same time — a fix without a recorded reason is a trap waiting to be re-introduced.
