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
second ownership/lifecycle model per tier. Phase 1 shipped metadata only; the
tiers have since grown:

- **Advanced** (`ADVANCED_API_LEVEL = 1`, Phase 2): normalized input
  capture, focused interactive surfaces (interactive managed overlays) and
  advanced editor control — still Host-mediated, never raw terminal bytes.
  See `docs/extension-advanced.md`.
- **Unstable** (`UNSTABLE_API_LEVEL = 1`, Phase 3): raw input
  interception (observe/consume/rewrite, exclusive raw ownership), the
  Host emergency fail-safe (triple-Esc), and a selected low-level surface
  seam — NO compatibility guarantee; a broken plugin can disrupt Host
  behavior. See `docs/extension-unstable.md`.

Such access is provided through the supported tier package entry
(`./extensions/advanced` / `./extensions/unstable`), never through
repository-private imports.

## The surface (M1–M10)

| Area | Entry point | Capability | Since |
|---|---|---|---|
| Header badge slot | `register('chrome.header.badge', ...)` | `slot.chrome.header.badge` | M2 |
| Dock item slot | `register('input.dock.item', ...)` | `slot.input.dock.item` | M2 |
| Footer segment slot | `register('chrome.footer.status', ...)` | `slot.chrome.footer.status` | M2 |
| Configurable footer item | `register('chrome.footer.item', ...)` | `slot.chrome.footer.item` | M4 |
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

**Keybinding registration contract (M6).** `registerKeybinding` accepts
a normalized key (never raw terminal bytes) + one of the PUBLIC semantic
actions (`submit-draft`, `queue-draft`, `steer-draft`,
`cancel-activity`, `open-search`, `toggle-fullscreen`,
`cycle-permission` — the `TuiAction` set). Registrations are validated
and REJECTED loudly (a thrown error, nothing is silently dropped) when:
the action is outside the public set (Host-private `app.*` actions are
never plugin-triggerable); the key name is outside the host's key
grammar (the runtime parser can never produce it, so the binding could
never fire — e.g. `f13`, arbitrary strings); the key is a Host-reserved
lifecycle key (Exit/steer/search/fold/todo/external-editor/history/
clipboard/queue/submit/Esc/Shift+Tab/Alt+Up/Alt+T/Alt+K defaults); the
key is TEXT-PRODUCING — a bare letter, digit, symbol or the spacebar,
WITH OR WITHOUT Shift (Shift+A is the raw `A` byte on legacy terminals
and `a`+shift on Kitty — either way it produces text, so a binding on
it would steal the user's typing on some terminals; `Ctrl+Alt+X`-style
chords and named keys like `Shift+Left` are NOT
text-producing and stay bindable); or the key can never be MATCHED by
the runtime (the fork matcher's capability table: any modifier on F1-F12
or Esc is hard-rejected, and `clear` supports only exactly `shift` or
exactly `ctrl` — all other bases accept any grammar-supported modifier
via CSI-u/modifyOtherKeys); or the key is a legacy-terminal
collision (`ctrl+[`, `ctrl+j`, `ctrl+m`, `ctrl+i`, `ctrl+h`, `ctrl+_`,
`ctrl+-`, `ctrl+backspace` — on legacy terminals these are indistinguishable from
Esc/Enter/Tab/Backspace/Ctrl+-, so the binding could never fire through
the normalized lookup; the plugin registry shares the Host config
parser's legacy inventory); or the key is a FORK EDITOR-owned key (Tab,
arrows, Home/End, PageUp/PageDown, Backspace/Delete, word-moves,
kill/yank/undo, Shift+Enter — the focused editor consumes these before
the plugin stage on every keystroke, so the binding could never fire;
the registry shares the `EDITOR_OWNED_KEY_IDS` inventory). Keys are
canonicalized (aliases `esc`→`escape`, `return`→`enter`, modifier
order) before every check, so a spelling variant cannot bypass the
policy. Duplicate keys are an explicit conflict error; every
registration is fiber-bound and removed on owner unload.
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

## Theme registry (M5)

`registerTheme(contribution)` registers a named color palette into the
host's `/settings` theme picker. The contribution carries an `id`, the
**display `name`** shown in the picker, the semantic `palette` and an
optional `description`. Owner unload removes the theme; if the removed
theme is the one currently applied, the host falls back to its built-in
dark palette.

**Selection identity is SOURCE-QUALIFIED.** The picker/apply/persist path
never addresses a theme by its display name — plugin themes are
identified by the selectable value `plugin:<owner>/<id>` (the owner is
the plugin's STABLE fiber name, the same identity the M4 canonical footer
keys use; both segments are percent-encoded), custom theme files by
`file:<name>`, and builtins by `auto|dark|light`. A plugin theme can
therefore never shadow or collide with a custom file of the same name,
and a persisted plugin selection degrades deterministically when the
plugin unloads (it resolves nothing — the built-in fallback, never
silently the same-named file). The registry's read-side view exposes
`selectableValues()` / `paletteForSelectable(value)` /
`displayNameForSelectable(value)` / `hasSelectable(value)` for the
picker; the bare `name` is a display label, never an identity. The
`/settings` picker carries the identity end-to-end: every picker row's
id IS the source-qualified value (display labels are unique per row —
builtin/file/plugin collisions are source-tagged — but are presentational
only and never round-tripped back to an identity at confirm time, so an
HMR unload between open and confirm can never redirect a selection to a
same-named new contribution). The vendored SettingsList submenu contract
writes the RAW selected value into the outer row's display; the host
rewrites it back to the friendly label through the openSettings
updateValue seam after a successful apply, so the panel never shows a raw
`plugin:` string and a re-open marks the right `← current`.

## Configurable footer items (M4)

`chrome.footer.item` is the configurable footer item slot: a plugin
contributes a **plain-data** item (`FooterItemContribution` — label,
description, a `FooterSegment` with its own `minWidth`, default zone,
importance) that
becomes a first-class citizen of the footer configurator — users can
show/hide, reorder and zone-place it like any builtin item. The
`FooterSegment.minWidth` is the item's minimum renderable width (never
truncated below it — it is the authority when both are set; the legacy
top-level `FooterItemContribution.minWidth` is DEPRECATED and honored
only when the segment carries none). Dynamic
updates use the standard `handle.replace(...)` / `handle.invalidate()`
pattern (async producer → cache → replace plain data → host render).

```ts
const quota = service.register<FooterItemContribution>('chrome.footer.item', {
  id: 'quota',
  order: 200,
  description: 'API quota footer item',
}, {
  label: 'API quota',
  defaultZone: 'right',
  importance: 50,
  segment: { spans: [{ text: 'quota 82%', tone: 'success' }], minWidth: 8 },
})

// later
quota.replace({
  label: 'API quota',
  defaultZone: 'right',
  importance: 50,
  segment: { spans: [{ text: 'quota 21%', tone: 'warning' }], minWidth: 8 },
})
```

The item's config identity is the canonical key `ext:<owner>/<id>` where
the owner is the registering plugin fiber's stable name (the nearest named
ancestor's display name; anonymous plugins share `root`) — stable across
HMR, because a reloaded plugin gets a NEW fiber (new uid) but the same
name. An npm-scoped plugin name (`@scope/name`) is legal: its `/` is
percent-ENCODED in the key via `encodeURIComponent`
(`ext:%40scope%2Fname/<id>`) — an injective encoding, so scoped plugins get
an unambiguous identity and a literal `~` owner can never collide with an
encoded slash owner; the id itself must not contain `/` or terminal
control characters (both rejected at registration: a control-char id
would be persisted into user layouts and rendered raw by the configurator
when the plugin is gone — the same injection class as a malicious
layout). A layout
referencing an unloaded plugin's item keeps the reference (the item is
skipped at render) and recovers automatically when the plugin reloads. The
ledger's (slot, owner, id) uniqueness still rejects two LIVE registrations
of the same id under the SAME owner — while DIFFERENT owners may
simultaneously register the same local id (their canonical keys embed the
owner, so the config identities stay distinct; the public contract: an id
is unique per (slot, owner)). The legacy
`chrome.footer.status` slot is unchanged: its segments aggregate into the
single `ext:*` item (show/hide as a whole, no per-segment ordering).

A Stable footer item can never control: row count, terminal writes, the
cursor, the root layout, the Host instruction surface, arbitrary ANSI,
shell, or keyboard focus — the host owns all of it.

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
