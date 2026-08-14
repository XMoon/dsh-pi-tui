# AGENTS.md

dsh-pi-tui — a third-party TUI mode for DeepSeek Harness (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui). Read this file before editing.

## Naming (hard rules)

Collision-avoidance is a deliberate choice: the official dsh project will plausibly ship its own `dsh-tui` / `@deepseek-ai/dsh-tui`, so nothing here may use that family.

| Thing | Name | Notes |
|---|---|---|
| Repository | `dsh-pi-tui` | repo root (this directory) |
| Profile (`dsh --profile`) | `pi-tui` | **Never `tui`** — that is reserved territory |
| Vendored fork package | `@xmoon76/pi-tui` | rescopped from `@moonshot-ai/pi-tui`; published (never under upstream's name or scope) |
| Bundle package | `@xmoon76/tui-app` | the `dsh.bundle` patch layer |
| Plugin row ids | `tui-startup`, `tui-app` | internal Loader ids, fine as-is |
| Startup service | `tuiStartup` (`TUI_STARTUP_SERVICE`) | |

## Repository layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork — kimi-code commit
                    b6144f94ea6b22455a4e750d1750d220987e7bc2 (v0.84.2).
                    Source of record for the five local fixes: its own
                    AGENTS.md (kept from the fork). native/ prebuilds are
                    NOT vendored; loading degrades gracefully without them.
packages/tui-app/   The dsh bundle. cordis.patch.yml inserts the startup row
                    (parses `dsh --profile pi-tui` flags) and the runner row
                    (starts the TUI). src/tui-app.ts is the testable surface
                    core (terminal injected); src/theme.ts the palette;
                    demo.ts a standalone interactive demo. lib/ (tsc output)
                    is gitignored like pi-tui's dist/ — build before install.
```

## Key decisions (do not silently reverse)

1. **In-process bundle, not BFF client.** Like `dsh-headless`, the TUI runs inside the Cordis context and consumes `ctx.*` services directly. The web surface's remote RPC exists only because a browser cannot be in-process; a TUI has no such constraint. Remote attach via the apiproxy is **explicitly not planned** (removed from the roadmap).
2. **Vendored fork, not npm dependency.** `@moonshot-ai/pi-tui` is not published (npm 404). Vendored from the kimi-code fork (not upstream pi-mono) to keep its five local fixes: CJK wrap recursion guard, container width clamp, overwide-line truncation instead of throw, negative-width guards, per-frame processed-line reuse. Re-verify those on every re-vendor — the fork's AGENTS.md lists them with guarding tests.
3. **`TuiMainScreen`, not `TUI`.** In this fork the constructible entry is `TuiMainScreen` (main screen + scrollback, `mode: "regular"`); the README's `new TUI(...)` is stale upstream docs. `TuiAltScreen` is the alternative.
4. **Source exports, built artifacts.** Both packages build: pi-tui via tsdown (`dist/`), tui-app via tsc with `rewriteRelativeImportExtensions` (`lib/`); `exports` point at built files. Neither `dist/` nor `lib/` is committed — build before installing into a profile. Node 26 refuses type-stripping inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts`-exporting package cannot load from a profile's node_modules.
5. **No native prebuilds.** darwin/win32 modifier-key addons are optional; the loader returns `undefined` on other platforms without attempting a load. Revisit only if modifier detection matters on macOS/Windows.
6. **`chalk` is a runtime dependency** of `tui-app` (theme.ts lives in `src`, unlike pi-tui's tests-only chalk).

## Development

```sh
pnpm install
pnpm build          # pi-tui tsdown (dist/) + tui-app tsc (lib/)
pnpm test           # pi-tui's own suite (node --test) + tui-app headless tests
pnpm typecheck
node --import tsx/esm packages/tui-app/demo.ts   # standalone demo in a real TTY
```

### Installing into the local dsh profile (dev loop)

```sh
dsh plugin --profile pi-tui -- add "@xmoon76/pi-tui@file:.../packages/pi-tui"
dsh plugin --profile pi-tui -- add "@xmoon76/tui-app@file:.../packages/tui-app"
# both pnpm `file:`/`link:` installs land as store copies, NOT symlinks — for a
# live dev loop replace them with manual symlinks (pnpm re-add overwrites them):
ln -sfn <repo>/packages/pi-tui ~/.dsh/profiles/pi-tui/node_modules/@xmoon76/pi-tui
ln -sfn <repo>/packages/tui-app ~/.dsh/profiles/pi-tui/node_modules/@xmoon76/tui-app
# run against the real dsh install:
dsh --profile pi-tui [--session <id>]
```

Headless UI tests drive `@xterm/headless` through `packages/tui-app/test/virtual-terminal.ts`
(copied from the fork's `test/virtual-terminal.ts`, import path changed) — rendering
and input routing are verified without a TTY or a model connection.

## Reusable flow (from the initial build, worth repeating for the next capability)

1. **Read both sides before designing**: the dsh bundle shape (`packages/bundle/web-app`: startup.ts commander row + index.ts glue + `cordis.patch.yml` with `dsh.bundle.patch`), and the library's real API (check `src/index.ts` exports, not the README).
2. **Vendor**: `rsync -a --exclude native --exclude CHANGELOG.md --exclude node_modules` from the fork; rescope the package name; keep LICENSE + the fork's AGENTS.md; record the upstream commit in `repository.note`; run the fork's own test suite unchanged (960 tests) as the sync gate.
3. **Bundle skeleton**: package with `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; patch inserts a `*-startup` row (commander via `@deepseek-ai/dsh-cmdline`'s `parseCmdline`, provides a service) and a runner row injecting that service; exports `./startup` and `./cordis.patch.yml`.
4. **Testable core**: inject the terminal (`Terminal` interface) so tests drive a `VirtualTerminal`; keep the process entry (`ProcessTerminal`) as a thin wrapper.
5. **Verification matrix** (all passed in the P0 spike): fork's own tests; headless render/input/exit; the full import chain under the tsx ESM hook (dsh source-launch contract, incl. `@deepseek-ai/dsh-cmdline` + commander); non-TTY stdin guard (`setRawMode` existence check); native graceful fallback.
6. **Install path**: `dsh plugin --profile pi-tui -- add <package>` — `dsh plugin` reconciles `dsh.profile.bundles` from installed state, so any dependency declaring `dsh.bundle` joins the layer stack automatically; no dsh installation edits needed.

## Traps hit (do not reintroduce)

- **`TUI` is not constructible** — use `TuiMainScreen` (see decisions).
- **`constructor(private readonly x: T)` parameter properties** fail Node's strip-only mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — write them as explicit fields.
- **Returning a mutable counter by value** in test helpers: `return { exits }` copies the number; closures update the local, assertions read the stale copy. Expose a getter or an object.
- **`TuiInputListener` must return `TuiInputListenerResult`** (or `undefined`) — a bare `void` arrow fails typecheck; return `{ consume: true }` for handled keys like Ctrl+C.
- **Editor needs a theme** (`EditorTheme`) — pi-tui ships no default; `packages/tui-app/src/theme.ts` is the palette.
- **`imports` `#/*` alias** in the fork's package.json: fine for its internal `src` imports under tsx/Node 24+, but any future `dist` build must bundle (tsdown) rather than tsc-emit, or the alias must go.
- **tmux `send-keys` looks like a paste to the editor**: `send-keys 'text' Enter` delivers the whole batch in a few ms; the editor's `PasteBurst` heuristic (≥8 plain chars within 8ms, Enter suppressed for 120ms) then turns Enter into a newline, so submissions silently "don't work". This is upstream design (protects against non-bracketed-paste terminals), NOT a regression — real keyboards type slower than 8ms/char. When driving the TUI from tmux, type with a pause: `send-keys 'text'`, sleep ≥0.3s, then `send-keys Enter`. (Learned while real-testing the 2026-08 fix batch.)
- **`setFullscreen` must refocus the editor**: a fresh `TuiAltScreen` starts with no focused component — after Ctrl+F the app-level listener still handles shortcuts but text and Enter are dropped, making the transcript look frozen. `TuiApp.setFullscreen` sets focus on the alt screen when entering and restores it on the way back; keep that when touching fullscreen (guarded by the "editor input routes to the alt screen" headless test).

## Docs

- README.md — install and run instructions for humans.
