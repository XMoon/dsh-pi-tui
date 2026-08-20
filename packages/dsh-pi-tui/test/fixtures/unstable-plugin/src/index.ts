/**
 * The packed UNSTABLE-plugin fixture: a THIRD-PARTY Cordis plugin that
 * imports ONLY the public `@xmoon76/dsh-pi-tui/extensions/unstable`
 * subpath (from the packed tarball) — the Phase-3 acceptance gate. It
 * verifies the UNSTABLE_API_LEVEL contract, registers raw input captures
 * (observe/consume/rewrite), exercises the low-level surface handle, and
 * proves an unstable plugin needs neither `@xmoon76/pi-tui` nor TuiApp
 * nor any repository internal.
 * @module dsh-pi-unstable-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  UNSTABLE_API_LEVEL,
  unstable,
  type UnstableRawInputEvent,
} from '@xmoon76/dsh-pi-tui/extensions/unstable'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'dsh-pi-unstable-fixture'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // The Phase-3 contract: the unstable tier is at level 1.
  if (UNSTABLE_API_LEVEL !== 1) throw new Error('UNSTABLE_API_LEVEL must be 1')

  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('unstable.input.raw')) return
  if (!service.api().capabilities.has('unstable.surface.handle')) return

  const ui = unstable(service)

  // Raw input interception: observe + capture + rewrite (RAW bytes — the
  // Unstable contract).
  const seen: UnstableRawInputEvent[] = []
  ui.input.captureRaw({
    id: 'fixture-observe',
    mode: 'observe',
    handle: (event) => { seen.push(event) },
  })
  ui.input.captureRaw({
    id: 'fixture-consume',
    mode: 'capture',
    handle: (event) => event.data === 'x' ? { action: 'consume' } : undefined,
  })
  ui.input.captureRaw({
    id: 'fixture-rewrite',
    mode: 'capture',
    handle: (event) => event.data === 'a' ? { action: 'rewrite', data: 'b' } : undefined,
  })

  // The low-level surface handle (inert without a mounted surface — every
  // method is safe before the surface attaches).
  const handle = ui.surface.handle
  handle.requestRender()
  const lease = handle.mountComponent({
    render: (width) => [`unstable fixture w=${width}`],
    handleInput: (raw) => { seen.push({ data: raw, surfaceId: handle.surfaceId }) },
    dispose: () => {},
  })
  lease.focus()
  lease.blur()
  lease.invalidate()
  lease.hide()
  lease.show()
  lease.close()
}
