/**
 * Test harness: a TuiApp with the Direct Host-file port pre-wired (the
 * fallback-only seam: fd forced absent so the bounded scan is what the
 * completion exercises). Mirrors the other headless suites' startApp.
 * @module @xmoon76/dsh-pi-tui/test/support/app-harness
 */

import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { suggestPathArgument } from '../../src/tui/file-completion/path-argument.ts'
import type { HostFileScope } from '../../src/runtime/host-file-port.ts'

/** The fixture's ONE confirmed Host Workspace identity (the scope a
 *  sessionless surface uses after the Host signed the Workspace). */
const HARNESS_WORKSPACE_ID = 'workspace-harness'

/** The Direct Host-file port over the official Workspace registry: the
 *  workspace scope resolves through the registry to the fixture root. */
function hostPort(cwd: string): DirectHostFilePort {
  return new DirectHostFilePort(() => undefined, null, {
    get: (name: string) => name === 'workspaceRegistry'
      ? {
          create: async () => { throw new Error('the fixture never creates a workspace') },
          list: () => [],
          get: (id: string) => id === HARNESS_WORKSPACE_ID ? { path: cwd } : undefined,
        }
      : undefined,
  })
}

function hostScope(): HostFileScope {
  return { kind: 'workspace', workspaceId: HARNESS_WORKSPACE_ID, selectionRevision: 1 }
}

export function startApp(cwd: string): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => {},
  })
  app.setCommandCompletions([], cwd, hostPort(cwd), undefined, hostScope())
  app.start()
  return { vt, app }
}

/** Start the app with one path-argument command (the same shape commands.ts
 * installs — the convergence headless flows drive both /image and /attach). */
export function startImageApp(cwd: string, commandName: 'image' | 'attach' = 'image'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => {},
  })
  app.setCommandCompletions(
    [{ name: commandName, description: commandName === 'attach' ? 'Attach a file' : 'Attach an image file', getArgumentCompletions: (arg: string) => suggestPathArgument(arg, cwd) }],
    cwd,
    hostPort(cwd),
    undefined,
    hostScope(),
  )
  app.start()
  return { vt, app }
}
