/**
 * Headless tests for the busy-Enter preference surface (web busyEnter
 * parity): the /settings row reflects the persisted value and its Enter
 * toggle persists the other behavior. The steer-side semantics (steerAll
 * onlyDraft) live in steer.test.ts; the Ctrl+Enter chord lives in
 * input-experience.test.ts; the runner's Enter dispatch decision is
 * closure glue verified end-to-end (tmux), like the rest of the submit
 * path.
 * @module @xmoon76/dsh-pi-tui/busy-enter.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — clear all three so the render paths under test stay live.
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A fake tuiSettings document recording every replace write. */
function fakeTuiSettings(busyEnter: string): { value: TuiSettingsLike; writes: Array<Record<string, unknown>> } {
  const doc: Record<string, unknown> = { theme: 'auto', footer: 'full', fullscreen: 'on', busyEnter, history: {} }
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    value: {
      get: () => ({ ...doc }) as TuiSettingsLike['get'] extends () => infer R ? R : never,
      replace: (next) => {
        writes.push({ ...next })
        Object.assign(doc, next)
        return undefined as unknown
      },
    },
  }
}

/** A fake commands service recording the registered definitions. */
function fakeCommands() {
  const defs: { name: string; handler?: unknown }[] = []
  return {
    defs,
    service: {
      register: (def: { name: string; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => [{ name: 'builtin', description: 'a builtin', input: { hint: '' } }],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** Register the TUI commands with a stubbed runner and return /settings. */
function setup(options: { busyEnter?: string } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  const settings = fakeTuiSettings(options.busyEnter ?? 'queue')
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    agents: {} as never,
    sessions: { flush: async () => {} },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    enterView: async () => {},
    requestExit: () => {},
    exit: () => {},
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const run = async (rawInput: string): Promise<unknown> =>
    (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
      commandId: CommandId('cmd-test-1'),
      agent: undefined as never,
      rawInput,
      signal: new AbortController().signal,
    })
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, view, settings }
}

test('/settings shows the busy-enter row with the persisted value', async () => {
  const t = setup({ busyEnter: 'steer' })
  await t.run('')
  const view = await t.view()
  assert.ok(view.includes('Enter while busy'), `busy-enter row missing:\n${view}`)
  assert.ok(view.includes('steer'), `persisted value missing:\n${view}`)
  t.app.stop()
})

test('the busy-enter row Enter toggle persists the other behavior', async () => {
  const t = setup({ busyEnter: 'steer' })
  await t.run('')
  await t.view()
  // Rows without a session: theme, expand, thinking, footer, busy-enter,
  // fullscreen, separator, cwd — the busy-enter row is the 5th.
  t.vt.sendInput('\x1b[B') // down × 4
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\r') // toggle the selected row's value
  await t.view()
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.busyEnter, 'queue', `the toggle must flip steer -> queue, wrote: ${JSON.stringify(last)}`)
  t.app.stop()
})

test('the busy-enter row defaults to queue', async () => {
  const t = setup()
  await t.run('')
  const view = await t.view()
  assert.ok(view.includes('queue'), `default value missing:\n${view}`)
  t.app.stop()
})
