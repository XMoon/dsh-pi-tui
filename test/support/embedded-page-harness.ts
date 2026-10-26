/**
 * Mount ONE `EmbeddedSpecialistPage` the way the Settings workspace root does:
 * the page gets the real content-row grant plus the ONE physical Action Bar,
 * and that bar is the screen's LAST row. The harness owns no settings authority
 * and performs no Host IO; it only reproduces the root's body/bar composition
 * for tests that exercise a page without leasing a whole Settings screen.
 *
 * `close()` mirrors the root teardown (stop the screen, dispose the page) and
 * paints a stable `PAGE CLOSED` marker so a case can tell a closed page from a
 * still-painted one.
 * @module @xmoon76/dsh-pi-tui/embedded-page-harness
 */

import { TuiAltScreen, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { EmbeddedSpecialistPage } from '../../src/tui/panels/settings-workspace-panel.ts'
import type { VirtualTerminal } from './virtual-terminal.ts'

export interface EmbeddedPageMount {
  /** Row grant the page last received (the Settings root's body + bar grant). */
  readonly rows: () => number
  /** Ask the host screen for another frame (the app's `requestRender` target). */
  readonly requestRender: () => void
  readonly close: () => void
}

/** Mount `panel` on `vt` as the whole screen body. */
export function mountEmbeddedPage(vt: VirtualTerminal, panel: EmbeddedSpecialistPage): EmbeddedPageMount {
  const screen = new TuiAltScreen(vt)
  const host: Component = {
    render: (width: number) => {
      panel.focused = true
      panel.setMaxRows(vt.rows)
      const painted = panel.render(width)
      const body = painted.slice(0, Math.max(0, painted.length - 1))
      const bar = painted[painted.length - 1] ?? ''
      const lines: string[] = []
      for (let row = 0; row < Math.max(0, vt.rows - 1); row += 1) lines.push(body[row] ?? '')
      lines.push(bar)
      return lines
    },
    handleInput: (data: string) => { panel.handleInput(data) },
    handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => panel.handleMouse?.(event),
    invalidate: () => { panel.invalidate?.() },
  }
  screen.setLayoutRoot(host)
  screen.start()
  screen.setFocus(host)
  let closed = false
  return {
    rows: () => vt.rows,
    requestRender: () => screen.requestRender(),
    close: () => {
      if (closed) return
      closed = true
      screen.stop()
      panel.dispose()
      vt.clearScreen()
      vt.write('PAGE CLOSED')
    },
  }
}
