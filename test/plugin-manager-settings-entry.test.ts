/**
 * `/settings → Plugins` entry tests (P1-A1.9): the row is a lazy SettingsList
 * submenu over the SAME Plugin Manager surface. Rendering /settings must not
 * read plugin inventory or build the submenu; activating the row builds it.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-settings-entry.test
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

function setup(): { invoke: (name: string) => unknown; counts: { opened: number; submenu: number }; vt: VirtualTerminal } {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  ctx.provide('commands', commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const counts = { opened: 0, submenu: 0 }
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    liveAgent: undefined,
    tuiSettings: undefined,
    extensions: undefined,
    openPluginManager: () => { counts.opened += 1 },
    createPluginManagerSubmenu: () => {
      counts.submenu += 1
      return { render: () => [], invalidate: () => {} }
    },
    config: {
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommands(runner)
  const invoke = (name: string): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return { invoke, counts, vt }
}

test('opening /settings alone never builds the Plugin Manager submenu', () => {
  const { invoke, counts } = setup()
  invoke('settings')
  assert.equal(counts.submenu, 0)
  assert.equal(counts.opened, 0)
})
