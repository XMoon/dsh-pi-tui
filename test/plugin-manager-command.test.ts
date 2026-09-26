/**
 * `/plugins` and `/settings → Plugins` entry tests (P1-A1.8/A1.9): the
 * canonical direct entry opens the shared surface, and the Settings entry is
 * LAZY — merely rendering /settings must never build the Plugin Manager
 * submenu (and therefore never read plugin inventory).
 * @module @xmoon76/dsh-pi-tui/plugin-manager-command.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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

function proxyRunner(ctx: Context, app: TuiApp, commands: Record<string, unknown>, counts: { opened: number; submenu: number }): TuiCommandRunner {
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
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
    createPluginManagerSubmenu: () => {
      counts.submenu += 1
      return { render: () => [], invalidate: () => {} }
    },
    config: {
      permissions: {
        presetNames: () => [],
        defaultPreset: () => undefined,
        approvalOverrideOf: () => undefined,
      },
      subagentModelSelection: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  return new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
}

function setup(): { invoke: (name: string) => unknown; counts: { opened: number; submenu: number }; app: TuiApp } {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const counts = { opened: 0, submenu: 0 }
  registerTuiCommands(proxyRunner(ctx, app, services.commands, counts))
  const invoke = (name: string): unknown => {
    const definition = services.defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return { invoke, counts, app }
}

test('/plugins is registered and opens the shared Plugin Manager surface', () => {
  const { invoke, counts } = setup()
  const result = invoke('plugins') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.equal(counts.opened, 1)
  assert.equal(counts.submenu, 0)
})

test('/settings renders the Plugins row lazily (no submenu build, no inventory read)', () => {
  const { invoke, counts } = setup()
  const result = invoke('settings') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.equal(counts.submenu, 0, 'opening /settings must not build the Plugin Manager submenu')
  assert.equal(counts.opened, 0)
})
