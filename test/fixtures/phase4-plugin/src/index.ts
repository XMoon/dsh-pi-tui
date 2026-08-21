/**
 * The packed PHASE-4 plugin fixture: a THIRD-PARTY Cordis plugin that
 * imports ONLY the public `@xmoon76/dsh-pi-tui/extensions/advanced`
 * subpath (from the packed tarball) — the Phase-4 acceptance gate. It
 * exercises the imperative UI broker (select/confirm/input/notify), the
 * custom interactive UI (ui.custom), and the host-state facade
 * (theme/title/working/tools-expanded), proving a Phase-4 plugin needs
 * neither `@xmoon76/pi-tui` nor TuiApp nor any repository internal.
 * @module dsh-pi-phase4-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  advanced,
  type AdvancedCustomHost,
  type AdvancedInteractiveComponent,
} from '@xmoon76/dsh-pi-tui/extensions/advanced'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'dsh-pi-phase4-fixture'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('advanced.ui.interactive')) return

  const ui = advanced(service)

  // The imperative UI broker (plan §4A): every prompt settles (the seam is
  // absent without a mounted surface — the promises resolve immediately).
  void ui.ui.select({ items: [{ value: 'a', label: 'Alpha' }], header: 'Pick' })
  void ui.ui.confirm({ question: 'Proceed?', approveLabel: 'Go', rejectLabel: 'Stop' })
  void ui.ui.input({ question: 'Name?' })
  ui.ui.notify('phase4 fixture', { type: 'info' })

  // Custom interactive UI (plan §4B): the factory receives ONLY the
  // public host facade.
  const host: AdvancedCustomHost = {
    surfaceId: 'fixture',
    generation: 1,
    width: 80,
    height: 24,
    done: () => {},
    close: () => {},
  }
  const component: AdvancedInteractiveComponent = {
    render: () => ({ kind: 'text', spans: [{ text: 'phase4 custom' }] }),
    handleInput: (event) => {
      if (event.kind === 'key' && event.key.key === 'd') host.done('fixture-result')
      return true
    },
    dispose: () => {},
  }
  void ui.ui.custom(() => component, { width: 40 })

  // The host-state facade (plan §4D): inert without a surface — every
  // method is safe.
  ui.host.getTheme()
  ui.host.setTheme('dark')
  ui.host.setTitle('fixture title')
  ui.host.setWorkingMessage('fixture working')
  ui.host.setToolsExpanded(true)

  // The Phase-2 surface stays available through the same facade.
  ui.input.capture({ id: 'fixture-capture', mode: 'observe', handle: () => {} })
}
