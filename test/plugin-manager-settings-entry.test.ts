/**
 * `Settings → Plugins` entry tests (S4-D1): Plugins is a first-level Settings
 * category that opens the ONE fullscreen Plugin page IN PLACE (no empty Rows
 * level, no legacy overlay), and returning restores the same Settings screen
 * with Plugins still selected.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-settings-entry.test
 */

import assert from 'node:assert/strict'
import { createClientCommandRegistry } from '../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Component } from '@xmoon76/pi-tui'
import type { TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from './support/register-tui-commands.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function plain(view: readonly string[]): string {
  return view.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

function setup(): {
  invoke: (name: string) => unknown
  counts: { opened: number; page: number }
  vt: VirtualTerminal
  done: () => void
} {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
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
  const counts = { opened: 0, page: 0 }
  let pageDone: (() => void) | undefined
  const page: Component & { handleInput(data: string): void; dispose(): void } = {
    render: (width: number) => ['PLUGIN PAGE'.padEnd(Math.max(1, width))],
    invalidate: () => {},
    handleInput: (data: string) => {
      if (data === '\x1b') pageDone?.()
    },
    dispose: () => {},
  }
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
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    listScopedCommands: () => [],
    tuiSettings: undefined,
    extensions: undefined,
    openPluginManager: () => { counts.opened += 1 },
    createPluginManagerPage: (done: () => void) => {
      counts.page += 1
      pageDone = done
      return page
    },
    config: {
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name: string): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return { invoke, counts, vt, done: () => pageDone?.() }
}

test('opening /settings alone never builds the inline Plugin page', async () => {
  const { invoke, counts, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  assert.equal(counts.page, 0)
  assert.equal(counts.opened, 0)
  // The first-level category is visible; Plugins is one of the four.
  const view = plain(vt.getViewport())
  assert.match(view, /Settings/)
  assert.match(view, /Plugins/)
})

test('Settings → Plugins opens the page in place; Esc returns to the same Settings L0', async () => {
  const { invoke, counts, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  // L0 starts on Appearance; move to Plugins (third category) and open it.
  vt.sendInput('\x1b[B')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(counts.page, 1, 'activating the Plugins category builds the shared page')
  assert.equal(counts.opened, 0)
  assert.match(plain(vt.getViewport()), /PLUGIN PAGE/)

  // The page's normal close returns to Settings L0 with Plugins selected.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const back = plain(vt.getViewport())
  assert.doesNotMatch(back, /PLUGIN PAGE/)
  assert.match(back, /Settings/)
  assert.match(back, /Plugins/)
  assert.match(back, /> Plugins/)
})
