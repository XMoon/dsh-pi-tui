# Extension API v1 — Stable author guide and stability contract

The dsh-pi-tui STABLE extension surface (`@xmoon76/dsh-pi-tui/extensions`)
is the compatibility-oriented public seam for third-party plugins. This
document is the STABLE API author guide and stability record (plan §16 —
M11 API v1 hardening). Advanced and Unstable tiers are documented in
`docs/extension-tiers.md`.

## Import rules (hard gate — Stable)

A STABLE plugin imports ONLY `@xmoon76/dsh-pi-tui/extensions`. The packed
declaration gate (scripts/tarball-smoke.mjs) and the editor acceptance
gate (scripts/vim-plugin-smoke.mjs) fail on:

- `@xmoon76/pi-tui` (the private vendored fork — bundled, never
  importable);
- `src/tui-app`, `TuiApp`, `TuiMainScreen`, `TuiAltScreen`;
- any repository-relative internal path;
- dynamic `import(...)` / `require(...)` of the same.

If a STABLE plugin NEEDS a private import, the SDK is missing a capability —
report it; there is deliberately no `unsafeGetTuiApp()` escape hatch. Higher
freedom belongs to the Advanced / Unstable entries, which expose low-level
capability through their own supported package boundary (never
repository-private imports).

## API tiers

The extension surface ships three tiers (plan §4/§5). A plugin imports
ONE tier entry — never the stable entry's internals, `TuiApp`,
`TuiMainScreen`, `TuiAltScreen` or repository-relative paths.

All extension plugins remain standard DeepSeek Harness / Cordis plugins using
`name`, `inject`, and `apply(ctx)`. The tier entries are package-export
boundaries: they may expose different types/helpers, but at runtime there is
ONE `piTuiExtensions` service and ONE shared Extension Runtime — never three
plugin systems, three loaders, or three HMR/lifecycle runtimes.

| Tier | Entry | Contract |
|---|---|---|
| Stable | `@xmoon76/dsh-pi-tui/extensions` | Compatibility-oriented; additive-first; existing semantics never silently change; public removal requires a planned breaking change. |
| Advanced | `@xmoon76/dsh-pi-tui/extensions/advanced` | Experimental; minor releases may break; a migration note is required; no long-term shims. |
| Unstable | `@xmoon76/dsh-pi-tui/extensions/unstable` | NO compatibility guarantee; implementation may change at any time. |

All tiers reuse the SAME shared extension runtime: caller-fiber
ownership, surface lifecycle, invalidation, capability discovery. Do not fork a
second ownership/lifecycle model per tier. Phase 1 ships only metadata: an
exported path, a level constant (`ADVANCED_API_LEVEL` / `UNSTABLE_API_LEVEL`,
both `0`), the reserved capability namespaces `advanced.` / `unstable.` and
the shared `ExtensionTier` type. No advanced/unstable capability is implemented
yet and no Host-private surface is exposed.

Reserved future scope (documented here so the docs never promise that the
Stable limits are platform-wide):

- **Advanced** may expose public higher-level interactive abstractions —
  normalized input ownership, interactive/focused UI, custom editor/component
  contracts, richer Host-managed capabilities.
- **Unstable** may intentionally expose low-level input interception,
  exclusive ownership, Host-policy bypass, or selected implementation-coupled
  primitives.

Such access is provided through the supported tier package entry
(`./extensions/advanced` / `./extensions/unstable`), never through
repository-private imports.

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

Editor replacement input is the ONE deliberate exception to the
normalized-key rule: while a replacement occupies the seat, its optional
`handleInput(event)` hook receives a SEMANTIC {@link EditorInputEvent} —
`{ kind: 'key', key }`, `{ kind: 'text', text }` or `{ kind: 'paste',
text }` — never raw terminal bytes. The Host decodes the terminal protocol
(legacy + Kitty CSI-u + modifyOtherKeys encodings, paste bursts, key
release/repeat filtering) BEFORE the plugin sees anything, so a plugin
editor behaves identically on every terminal. Returning `true` consumes the
event; returning `false` or `undefined` hands it back — the declined event
may fall back to Host editing behavior at the replacement's current text
and cursor, and the resulting draft/cursor may be synchronized back to the
visible replacement (the exact fallback internals are NOT part of the
Stable contract). Enter remains host-owned and submits through the normal
host path.

The editor id `host` is RESERVED for the built-in host editor: a
`registerEditor({ id: 'host', ... })` contribution is rejected. The host seat
is the fallback that occupies the seat whenever no plugin editor wins; the
host's input-routing guard distinguishes the host seat from display-only
replacements by this id (a plugin claiming it could never occupy the
replacement seat and would corrupt the seat-ownership checks). A display-only
replacement (no `handleInput` hook) never receives ordinary typing, and
ordinary typing is never silently routed into the hidden host editor while the
plugin seat is visible. The exact guard implementation is a Host detail, not
part of the Stable contract.

An `EditorHost` is bound to the editor-seat owner that created it. After a
handoff, every operation from the old host (`getSnapshot`, `replaceText`,
`dispatch`, `subscribe`, and `invalidate`) is inert; subscriptions created
while `create()` is running are registered but become live only after that
editor successfully commits the seat, while all create-time snapshot,
mutation, dispatch, and invalidation operations are inert. A host restore
stages the host adapter before disposing the old occupant, so an adapter
construction or restore failure leaves the old seat available.

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
- A STABLE plugin can never touch: the terminal, focus, submission policy,
  approvals/questions, session lock/guard, the overlay stack, the editor
  seat's internals, or the root layout. These boundaries are Stable-tier
  limits; Advanced / Unstable may later expose higher-freedom access through
  their own supported entry.

## Rendering contract

- Contributions are plain data (`ExtensionView` trees / styled spans);
  the host owns ANSI compilation, width measurement, wrapping and
  budgets.
- Rendering is synchronous, I/O-free, Promise-free.
- Empty content abdicates (renders nothing).
- `ExtensionView` trees / styled spans are the STABLE rendering model (the
  main way a Stable plugin expresses UI); advances on it belong to the
  Advanced/Unstable tiers, not to an unbounded Stable convenience surface.
- A throwing contribution is isolated (health ledger) — it can never
  stall the host.
- Stable plugins never receive raw terminal data: keys are normalized,
  tool snapshots are semantic + deeply frozen. (Advanced/Unstable may
  deliberately expose raw or lower-level input later, through their own
  entries.)

## Deprecation policy (M11)

`api().deprecations` maps deprecated capability ids / API names to their
migration note. A deprecated surface stays FUNCTIONAL in the current API
version and is REMOVED in the next version bump. Migrate before then.

## Stability

The extension surface is **early, stabilizing** (documented in the README).
The 0.x policy is deliberately NOT a freeze: no source-hash gate, no protocol
hash, no compatibility database is introduced to pin the surface. The tiers
carry the actual contract (see "API tiers" above):

- **Stable** (`./extensions`) is compatibility-oriented and additive-first;
  a documented semantic never silently changes, and a public removal is a
  planned breaking change with a migration path.
- **Advanced** (`./extensions/advanced`) is experimental; minor releases may
  break; a migration note is required; no long-term shims.
- **Unstable** (`./extensions/unstable`) carries NO compatibility guarantee;
  implementation may change at any time.

A full modal editor (Vim-class) is NOT a Stable-API proof target — it
belongs to the Advanced/Unstable roadmap. The vim test fixture validates the
editor-extension seam: the public package is consumable, the replacement
editor lifecycle works, and plugin editors consume semantic
`EditorInputEvent`s (never raw terminal bytes).
