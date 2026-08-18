/**
 * The packed-extension fixture: a THIRD-PARTY Cordis plugin that imports
 * ONLY the public `@xmoon76/dsh-pi-tui/extensions` subpath (from the packed
 * tarball) — the M3 acceptance gate. It registers a header badge, a dock
 * item and a footer segment through the public service API, proving a
 * plugin needs neither `@xmoon76/pi-tui` nor TuiApp nor any repository
 * internal.
 * @module dsh-pi-extension-fixture
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type PiTuiExtensionService,
} from '@xmoon76/dsh-pi-tui/extensions'
import type {
  DockItem,
  FooterSegment,
  HeaderBadge,
  StyledSpan,
} from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'pi-extension-fixture'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return

  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('slot.chrome.header.badge')) return

  service.register<HeaderBadge>('chrome.header.badge', {
    id: 'fixture-badge',
    order: 500,
    description: 'Packed-fixture header badge.',
  }, {
    text: 'fixture',
    tone: 'success',
  })

  const label: StyledSpan[] = [{ text: '☑  fixture dock item', tone: 'textDim' }]
  service.register<DockItem>('input.dock.item', {
    id: 'fixture-dock',
    order: 500,
  }, { label })

  service.register<FooterSegment>('chrome.footer.status', {
    id: 'fixture-footer',
    order: 500,
  }, {
    spans: [{ text: 'fixture-segment', tone: 'textDim' }],
  })
}
