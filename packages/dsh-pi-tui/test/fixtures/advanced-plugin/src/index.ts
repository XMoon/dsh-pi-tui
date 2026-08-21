/**
 * The packed ADVANCED-plugin fixture: a THIRD-PARTY Cordis plugin that
 * imports ONLY the public `@xmoon76/dsh-pi-tui/extensions/advanced`
 * subpath (from the packed tarball) — the Phase-2 acceptance gate. It
 * verifies the ADVANCED_API_LEVEL contract, registers a normalized input
 * capture, opens an interactive overlay, and exercises the lifecycle —
 * proving an advanced plugin needs neither `@xmoon76/pi-tui` nor TuiApp
 * nor any repository internal.
 * @module dsh-pi-advanced-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ADVANCED_API_LEVEL,
  advanced,
  type AdvancedInputEvent,
  type AdvancedInteractiveComponent,
} from '@xmoon76/dsh-pi-tui/extensions/advanced'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'dsh-pi-advanced-fixture'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // The Phase-2 contract: the advanced tier is at level 1.
  if (ADVANCED_API_LEVEL !== 1) throw new Error('ADVANCED_API_LEVEL must be 1')

  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('advanced.input.capture')) return
  if (!service.api().capabilities.has('advanced.ui.interactive')) return

  const ui = advanced(service)

  // Normalized input capture: observe + capture (never raw terminal bytes).
  const observed: AdvancedInputEvent[] = []
  ui.input.capture({
    id: 'fixture-observe',
    mode: 'observe',
    handle: (event) => { observed.push(event) },
  })
  ui.input.capture({
    id: 'fixture-capture',
    mode: 'capture',
    handle: (event) => event.kind === 'key' && event.key.key === 'x',
  })

  // A focused interactive component (state owned by the plugin, rendering
  // compiled by the Host, input normalized by the Host).
  const component: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'advanced fixture' }] }),
    handleInput: (event) => {
      observed.push(event)
      return false
    },
    onFocus: () => {},
    onBlur: () => {},
    dispose: () => {},
  }

  // The interactive overlay lease (caller-fiber-owned; inert without a
  // mounted surface — every method is safe before the surface attaches).
  const lease = ui.ui.showInteractiveOverlay(component, { width: 40 })
  lease.focus()
  lease.blur()
  lease.invalidate()
  lease.hide()
  lease.show()
  lease.close()

  // The advanced editor controls (inert without a surface).
  ui.editor.getEditorState()
  ui.editor.setEditorText('')
  ui.editor.setEditorCursor(0)
  ui.editor.insertEditorText('')
  ui.editor.pasteToEditor('')
  ui.editor.requestEditorFocus()
}
