/**
 * Test harness: a TuiApp with the Direct Host-file port pre-wired (the
 * fallback-only seam: fd forced absent so the bounded scan is what the
 * completion exercises). Mirrors the other headless suites' startApp.
 * @module @xmoon76/dsh-pi-tui/test/support/app-harness
 */

import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../virtual-terminal.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { suggestPathArgument } from '../../src/mentions.ts'

export function startApp(cwd: string): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => {},
  })
  app.setCommandCompletions([], cwd, new DirectHostFilePort(() => undefined, null))
  app.start()
  return { vt, app }
}

/** Start the app with the /image path-argument command (the same shape
 * commands.ts installs — the convergence headless B/E flows drive it). */
export function startImageApp(cwd: string): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => {},
  })
  app.setCommandCompletions(
    [{ name: 'image', description: 'Attach an image file', getArgumentCompletions: (arg) => suggestPathArgument(arg, cwd) }],
    cwd,
    new DirectHostFilePort(() => undefined, null),
  )
  app.start()
  return { vt, app }
}
