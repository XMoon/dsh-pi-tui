# Extension Advanced tier — author guide (Phase 2)

The ADVANCED extension surface (`@xmoon76/dsh-pi-tui/extensions/advanced`)
is the experimental, higher-freedom tier of the dsh-pi-tui extension
platform. It is a capability facade over the SAME `piTuiExtensions`
Cordis service — NOT a second plugin system, loader, or runtime. A plugin
imports this entry and calls `advanced(service)` to get the facade.

## Contract

- **Experimental.** Minor releases may break; a migration note is
  required; no long-term shims.
- **Still Host-mediated.** Advanced plugins can own interactive state,
  focus and normalized input, but never touch raw terminal bytes, private
  screens, `TuiApp`, or repository internals. The Host decodes the
  terminal protocol (legacy + Kitty CSI-u + modifyOtherKeys encodings,
  bracketed paste, key release/repeat filtering) and owns every physical
  mount, focus seat and teardown.
- **Same ownership model.** Every resource is caller-fiber-owned (owner
  unload/HMR disposes it) and surface-generation-scoped (a stale handle is
  inert). No second health system: failures ride the shared extension
  health ledger.
- **Capability detection.** `service.api().capabilities` carries
  `advanced.input.capture`, `advanced.ui.interactive` and
  `advanced.editor.control` from service-provide time — feature-detect,
  never parse the host version.

## The facade

```ts
import { advanced } from '@xmoon76/dsh-pi-tui/extensions/advanced'
import { PI_TUI_EXTENSIONS_SERVICE } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'my-advanced-plugin'
export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx) {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE)
  if (service === undefined) return
  const ui = advanced(service)
  // ui.input.capture(...) | ui.ui.showInteractiveOverlay(...) | ui.editor
}
```

## 1. Normalized input capture (`ui.input.capture`)

Register a capture that receives NORMALIZED input events (`key` / `text` /
`paste`) after the Host's own capturing flows and reserved lifecycle keys,
and before the editor and the Stable keybindings.

```ts
ui.input.capture({
  id: 'my-capture',
  mode: 'capture',            // 'observe' | 'capture' | 'exclusive'
  priority: 10,               // ASC; ties break by id ASC (deterministic)
  when: () => myState.active, // optional gate
  handle: (event) => {
    if (event.kind === 'key' && event.key.key === 'x') return true // consume
    return false              // pass on
  },
})
```

- `observe` never consumes; `capture` may consume (return `true`);
  `exclusive` is the SOLE capture consumer while live — capture-mode
  captures are not consulted (observers still run). A second exclusive
  registration is an explicit error, never a load-order winner.
- A throwing handler (or `when` gate) is isolated and FAILS OPEN: the
  event continues down the Host ladder, and the failure is recorded in
  the extension health ledger (`advanced.input.capture` slot).
- **What a capture can preempt:** ordinary editor and panel input —
  typing, arrows, Enter with the host editor, and the Stable keybindings.
- **What a capture can NEVER preempt:** Host questions/approvals, Host
  overlays, and the reserved Host lifecycle keys (Esc double-cancel,
  Ctrl+C/Ctrl+D exit, Ctrl+S steer, Ctrl+G external editor, ...).
  Session safety stays Host-owned.

## 2. Focused interactive surface (`ui.ui.showInteractiveOverlay`)

The Phase-2 focused interactive surface is an interactive managed overlay
hosting an `AdvancedInteractiveComponent`:

```ts
const component = {
  render: (ctx) => ({ kind: 'text', spans: [{ text: `w=${ctx.width}` }] }),
  handleInput: (event) => { /* normalized input while focused */ return false },
  onFocus: () => {},
  onBlur: () => {},
  dispose: () => {},
}
const lease = ui.ui.showInteractiveOverlay(component, { width: 60 })
```

- The plugin owns the state; the Host compiles `render()` output through
  the M4 component kit (layout, ANSI, width/wrapping, error isolation).
- Input is normalized by the Host and forwarded to `handleInput` while
  the overlay owns focus. A throwing render/input/focus callback is
  isolated (health ledger) — it can never crash the Host.
- The lease is caller-fiber-owned: owner unload closes the overlay; the
  surface's final dispose closes every still-owned lease; a stale lease
  is inert. `focus()/blur()/invalidate()/close()/hide()/show()` control
  the overlay; `active`/`focused` report its state.
- The overlay survives a fullscreen toggle (the Host re-mounts it on the
  new active screen) and a terminal resize (the Host recompiles
  `render()` so `ctx.width/height` stay current).

## 3. Advanced editor control (`ui.editor`)

Direct semantic editor actions through the Host's editor seat:

```ts
ui.editor.getEditorState()          // { text, cursor, focused, replacementId, composing }
ui.editor.setEditorText('draft')
ui.editor.setEditorCursor(4)
ui.editor.insertEditorText('x')     // at the cursor, or at an explicit offset
ui.editor.pasteToEditor('pasted')   // insert at the cursor
ui.editor.requestEditorFocus()      // best-effort; never steals a capturing flow
```

- The Host owns submission/session safety: `dispatch('submit')` (the
  Stable editor SDK's explicit action) stays the submission path; these
  controls only carry text/cursor/focus.
- The controls follow the CURRENT surface attachment; without a live
  surface they are inert (safe no-ops).

## Lifecycle

- Every capture, overlay lease and editor action is caller-fiber-owned:
  plugin unload/HMR removes exactly that plugin's resources.
- Registrations may happen before any surface exists (captures are
  service-lifetime and attach later; overlay leases and editor controls
  are inert until a surface is live).
- The surface GENERATION is stable across start/stop/fullscreen/external-
  editor round-trips; only a final surface dispose invalidates old
  handles.

## Non-goals (Phase 2)

- No raw terminal bytes, no pre-decode interception, no escape-sequence
  rewrite, no Host-policy bypass, no private `TuiApp`/screen exposure, no
  repository-relative imports. Those belong to the Unstable tier
  (`docs/extension-unstable.md`).
- No production Vim, no full Pi parity.
