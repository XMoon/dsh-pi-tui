/**
 * `/plugins` entry tests (S4-D1): the canonical direct entry opens the shared
 * fullscreen Plugin Manager page, and opening `/settings` alone never builds
 * the inline Plugin page (and therefore never reads plugin inventory).
 * @module @xmoon76/dsh-pi-tui/plugin-manager-command.test
 */

import assert from 'node:assert/strict'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function fakeCommands(): { defs: { name: string; handler?: unknown }[]; commands: Record<string, unknown> } {
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => {
      defs.push(definition)
      return () => {}
    },
    list: () => defs.map(definition => ({ name: definition.name, description: '' })),
    find: () => undefined,
    execute: async () => undefined,
  }
  return { defs, commands }
}

function proxyRunner(ctx: Context, app: TuiApp, commands: Record<string, unknown>, counts: { opened: number; page: number }): TuiCommandRunner {
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    // A sessionless surface: the completion install and the /settings
    // session rows must see no live scope.
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    listScopedCommands: () => [],
    tuiSettings: undefined,
    extensions: undefined,
    openPluginManager: () => { counts.opened += 1 },
    createPluginManagerPage: () => {
      counts.page += 1
      return { render: () => [], invalidate: () => {} }
    },
    config: {
      configReadiness: () => 'ready' as const,
      permissions: {
        presetNames: () => [],
        defaultPreset: () => undefined,
        approvalOverrideOf: () => undefined,
      },
      subagentModelSelection: { available: () => false },
      // The Web provider section is Host-only (S2/PR-B): this stub composes no
      // Host settings plane, so the section reports unavailable and offers no write.
      web: { available: () => false },
      // The credential STORE is not mounted either: the Web section's key row
      // reports unavailable instead of claiming "not configured".
      credentials: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  return new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
}

function setup(): { invoke: (name: string) => unknown; counts: { opened: number; page: number }; app: TuiApp } {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const counts = { opened: 0, page: 0 }
  registerTuiCommandsWithDirectSeams(proxyRunner(ctx, app, services.commands, counts))
  const invoke = (name: string): unknown => {
    const definition = services.defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return { invoke, counts, app }
}

test('/plugins is registered and opens the fullscreen Plugin Manager page', () => {
  const { invoke, counts } = setup()
  const result = invoke('plugins') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.equal(counts.opened, 1)
  assert.equal(counts.page, 0, 'the direct entry never builds the Settings-hosted page')
})

test('/settings renders lazily (no inline Plugin page build, no inventory read)', async () => {
  const { invoke, counts } = setup()
  // `/settings` reads the Host Web provider facts before it leases the
  // workspace screen (S2/PR-B §B3.4), so its handler is asynchronous.
  const result = await invoke('settings') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.equal(counts.page, 0, 'opening /settings must not build the Plugin Manager page')
  assert.equal(counts.opened, 0)
})
