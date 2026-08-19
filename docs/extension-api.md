# Extension API v1 — author guide and stability contract

The dsh-pi-tui extension surface (`@xmoon76/dsh-pi-tui/extensions`) is the
ONLY public seam for third-party plugins. This document is the v1 author
guide and the stability record (plan §16 — M11 API v1 hardening).

## Import rules (hard gate)

A plugin imports ONLY `@xmoon76/dsh-pi-tui/extensions`. The packed
declaration gate (scripts/tarball-smoke.mjs) and the vim acceptance gate
(scripts/vim-plugin-smoke.mjs) fail on:

- `@xmoon76/pi-tui` (the private vendored fork — bundled, never
  importable);
- `src/tui-app`, `TuiApp`, `TuiMainScreen`, `TuiAltScreen`;
- any repository-relative internal path;
- dynamic `import(...)` / `require(...)` of the same.

If a plugin NEEDS a private import, the SDK is missing a capability —
report it; there is deliberately no `unsafeGetTuiApp()` escape hatch.

## The surface (M1–M10)

| Area | Entry point | Capability | Since |
|---|---|---|---|
| Header badge slot | `register('chrome.header.badge', ...)` | `slot.chrome.header.badge` | M2 |
| Dock item slot | `register('input.dock.item', ...)` | `slot.input.dock.item` | M2 |
| Footer segment slot | `register('chrome.footer.status', ...)` | `slot.chrome.footer.status` | M2 |
| Widget slots | `register('input.widget.above'\|'input.widget.below', ...)` | `slot.input.widget` | M4 |
| Component kit | `ExtensionView` tree values | (compiled by the host) | M4 |
| Command ownership | `registerCommand(...)` | (always available) | M5 |
| Theme registry | `registerTheme(...)` | (always available) | M5 |
| Settings rows | `registerSetting(...)` | (always available) | M5 |
| Autocomplete | `registerAutocomplete(...)` | (always available) | M5 |
| Keybindings | `registerKeybinding(...)` | (always available) | M6 |
| Message renderer | `registerMessageRenderer(...)` | (always available) | M7 |
| Tool renderer | `registerToolRenderer(...)` | (always available) | M7 |
| Managed overlay | `showOverlay(view, options)` | (always available) | M8 |
| Editor replacement | `registerEditor(...)` | (always available) | M9 |

Always `service.api().capabilities.has(...)` before relying on a
capability — never parse the package version.

## Lifecycle contract

- Every registration is FIBER-BOUND: the host disposes it when the
  plugin's Cordis fiber unloads (HMR, disable). Explicit `dispose()` is
  idempotent.
- Registrations may happen BEFORE any surface exists; the host renders
  them when the surface attaches.
- The surface GENERATION is stable across start/stop/fullscreen/
  external-editor round-trips; only a final surface dispose invalidates
  old handles (they become inert no-ops).
- A plugin can never touch: the terminal, focus, submission policy,
  approvals/questions, session lock/guard, the overlay stack, the editor
  seat's internals, or the root layout.

## Rendering contract

- Contributions are plain data (`ExtensionView` trees / styled spans);
  the host owns ANSI compilation, width measurement, wrapping and
  budgets.
- Rendering is synchronous, I/O-free, Promise-free.
- Empty content abdicates (renders nothing).
- A throwing contribution is isolated (health ledger) — it can never
  stall the host.
- Plugins never receive raw terminal data: keys are normalized, tool
  snapshots are semantic + deeply frozen.

## Deprecation policy (M11)

`api().deprecations` maps deprecated capability ids / API names to their
migration note. A deprecated surface stays FUNCTIONAL in the current API
version and is REMOVED in the next version bump. Migrate before then.

## Stability

API v1 is **early, stabilizing** (documented in the README): the shape
above is the current contract, version `1` bumps ONLY on breaking
changes. M11 freezes the v1 surface for the 0.2.x line; the vim
acceptance plugin (test/fixtures/vim-plugin/) is the living proof that a
plugin needs nothing else.
