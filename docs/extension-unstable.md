# Extension Unstable tier — author guide (Phase 3)

The UNSTABLE extension surface (`@xmoon76/dsh-pi-tui/extensions/unstable`)
is the low-level escape hatch of the dsh-pi-tui extension platform. It is
a capability facade over the SAME `piTuiExtensions` Cordis service — NOT a
second plugin system, loader, or runtime. A plugin imports this entry and
calls `unstable(service)` to get the facade.

## Contract

- **NO compatibility guarantee.** Implementation may change at any time —
  API rename/removal, patch-breaking changes, implementation-coupled
  behavior. Plugin authors bear the upgrade cost.
- **A broken plugin can disrupt Host behavior.** Raw captures can consume
  or rewrite ANY input that reaches the Host router — Enter, Esc, Ctrl+C,
  paste, CSI-u. Host shortcuts may stop working. This is the
  accepted risk of the tier; it is not disguised as "safe". (The captures
  are a `preHostInput` seam: the TUI's own terminal-negotiation replies
  are filtered before them, so a capture cannot break the terminal
  negotiation itself.)
- **The ONLY Host-owned recovery is the emergency fail-safe** (triple-Esc
  within 1.5s): it releases every raw capture and closes every unstable
  mount, restoring Host input. It is detected BEFORE the captures are
  consulted, so it cannot be rewritten or consumed by a capture.
- **Still no repository-private imports.** Low-level access is exposed
  through this supported package entry; plugins never import
  repository-relative paths and never mutate Cordis runtime internals.
- **Same ownership model.** Every resource is caller-fiber-owned (owner
  unload/HMR disposes it) and surface-generation-scoped (a stale handle is
  inert). Failures ride the shared extension health ledger
  (`unstable.input.raw` slot).
- **Capability detection.** `service.api().capabilities` carries
  `unstable.input.raw` and `unstable.surface.handle` from service-provide
  time — feature-detect, never parse the host version.

## The facade

```ts
import { unstable } from '@xmoon76/dsh-pi-tui/extensions/unstable'
import { PI_TUI_EXTENSIONS_SERVICE } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'my-unstable-plugin'
export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx) {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE)
  if (service === undefined) return
  const ui = unstable(service)
  // ui.input.captureRaw(...) | ui.surface.handle
}
```

## 1. Raw input interception (`ui.input.captureRaw`)

Register a capture that receives the normalized terminal input sequence
BEFORE the Host routes it semantically (a `preHostInput` seam — NOT the
raw OS byte stream):

```ts
ui.input.captureRaw({
  id: 'my-raw',
  mode: 'capture',            // 'observe' | 'capture' | 'exclusive'
  priority: 10,               // ASC; ties break by id ASC (deterministic)
  when: () => myState.active, // optional gate
  handle: (event) => {
    // event.data is one normalized input sequence; event.surfaceId
    // identifies the surface.
    if (event.data === 'x') return { action: 'consume' }
    if (event.data === 'a') return { action: 'rewrite', data: 'b' }
    return { action: 'pass' } // or undefined
  },
})
```

What the capture actually sees — the Host input path is:

```text
OS stdin
  → ProcessTerminal / StdinBuffer (batched chunks split into individual
    sequences; bracketed-paste content re-wrapped in its markers)
  → keyboard-protocol negotiation (Kitty flags / DA replies filtered)
  → native modifier normalization (Windows / Apple Terminal Return →
    CSI-u Shift+Enter)
  → TUI-owned query replies filtered (OSC11 background, color-scheme
    reports, cell-size responses)
  → TUI input listeners
  → THIS capture (BEFORE Host semantic routing)
```

So a capture can see, consume or rewrite anything the Host router would
otherwise decode — Enter, Esc, Ctrl+C, bracketed paste (markers
preserved), CSI-u sequences — but it CANNOT see the terminal-negotiation
replies the TUI itself consumes (Kitty/DA, OSC11, color-scheme,
cell-size), and it never sees raw multi-byte chunks mid-sequence. A
capture therefore cannot break the terminal negotiation; it CAN still
make Host shortcuts stop working.

- `observe` never consumes or rewrites; `capture` may consume or rewrite;
  `exclusive` is the SOLE capture consumer while live — capture-mode
  captures are not consulted (observers still run). A second exclusive
  registration is an explicit error, never a load-order winner.
- A rewrite replaces the sequence for the Host decoder. **Each sequence
  passes the interception chain at most once** — the replacement goes
  straight to the decoder and never re-enters the chain (no recursion,
  no reentrancy).
- A throwing handler (or `when` gate) is isolated and FAILS OPEN: the
  sequence passes through, and the failure is recorded in the health
  ledger.
- **Security / terminal safety:** the raw API deliberately bypasses the
  Stable sanitization. A plugin can send or interpret control sequences;
  the plugin author owns terminal behavior; the Host does not guarantee
  cross-terminal portability. The Host's own Stable surfaces keep their
  ANSI sanitization — the Unstable tier never changes the Stable
  boundary.

## 2. Exclusive raw ownership

`mode: 'exclusive'` declares that the plugin owns raw input: ordinary
Host input may receive nothing at all. This is the point of the tier. The
only exception is the emergency fail-safe (below), which is not part of
the ordinary input path and cannot be consumed by a plugin.

## 3. Emergency fail-safe

- **Trigger:** press Esc three times within 1.5 seconds.
- **Effect:** every unstable raw capture is released and every unstable
  mount is closed; Host input is restored.
- **Properties:** simple; documented; does not depend on any plugin
  handler; cannot be rewritten or consumed by the Unstable API (the Host
  detects the pattern before consulting the captures); only releases/
  disables unstable captures and closes unstable surfaces — it is not a
  general "all Ctrl+C/Enter stay Host-owned" rule.
- The first two Esc presses pass through (a plugin surface may use Esc
  normally); the third is consumed and triggers the release. The
  fail-safe is armed only while captures are live, so ordinary Esc
  behavior is unchanged otherwise.

## 4. Low-level surface seam (`ui.surface.handle`)

A SELECTED set of Host surface capabilities for low-level plugins:

```ts
const handle = ui.surface.handle
handle.surfaceId        // the attached surface generation's id
handle.generation       // the surface generation
handle.width / handle.height
handle.requestRender()  // repaint the active screen
const lease = handle.mountComponent({
  render: (width) => [`raw line at ${width}`],  // RAW lines, no sanitization
  handleInput: (raw) => { /* normalized input sequence while focused */ },
  dispose: () => {},
})
lease.focus(); lease.blur(); lease.invalidate()
lease.hide(); lease.show(); lease.close()
```

- The handle NEVER exposes `TuiApp`, `TuiMainScreen`, `TuiAltScreen` or
  the terminal object — only the capabilities a low-level plugin
  genuinely needs.
- The mount is a capturing overlay: the plugin renders RAW lines and
  receives the normalized input sequence (the same preHostInput contract
  as `captureRaw` — never raw OS bytes); the Host owns the physical
  mount, focus, stacking, fullscreen migration and teardown. With no
  `width` option, the mount follows the full available terminal width so
  `render(width)` changes after resize; an explicit width remains
  authoritative. The lease is caller-fiber-owned; a stale lease (surface
  disposed) is inert.
- The handle follows the CURRENT surface attachment; without a live
  surface it is inert (safe no-ops).

## Lifecycle

- Every capture and mount is caller-fiber-owned: plugin unload/HMR
  removes exactly that plugin's resources.
- Registrations may happen before any surface exists (captures are
  service-lifetime and attach later; the surface handle is inert until a
  surface is live).
- The surface GENERATION is stable across start/stop/fullscreen/external-
  editor round-trips; only a final surface dispose invalidates old
  handles.

## Non-goals (Phase 3)

- No full Vim, no Pi full parity, no all-pi-tui re-exports, no terminal
  emulator, no plugin sandbox, no compatibility shim, no version
  negotiation framework.
- The low-level mount seam is 方案 A (the plugin renders raw lines); the
  allowlisted pi-tui primitive re-export (方案 B) is NOT shipped — revisit
  only if a real plugin proves 方案 A insufficient.
