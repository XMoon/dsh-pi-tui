/**
 * Headless tests for the busy-Enter preference surface (web busyEnter
 * parity): the /settings row reflects the persisted value and its Enter
 * toggle persists the other behavior, and the pure dispatch gate
 * (shouldSteerOnEnter) separates LOCAL commands (always execute) from
 * everything else (plain prompts AND per-skill slash commands steer while
 * the agent is running). The steer-side semantics (steerAll onlyDraft)
 * live in steer.test.ts; the Ctrl+Enter chord lives in
 * input-experience.test.ts.
 * @module @xmoon76/dsh-pi-tui/busy-enter.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { LOCAL_COMMANDS, shouldSteerOnEnter } from '../src/index.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** The TUI-owned command names registered by registerTuiCommands (commands.ts). */
const TUI_OWNED = [
  'copy', 'exit', 'export', 'fork', 'help', 'kill', 'login', 'logout',
  'model', 'new', 'preset', 'queue', 'quit', 'reload', 'rename', 'resume',
  'search', 'sessions', 'settings', 'skill', 'status', 'subagents', 'tasks',
  'title', 'yolo',
]

test('LOCAL_COMMANDS covers every TUI-owned command and nothing else', () => {
  for (const name of TUI_OWNED) {
    assert.ok(LOCAL_COMMANDS.has(name), `TUI-owned command ${name} must be local`)
  }
  // A skill command name is NOT local (the per-skill registrations live in
  // the catalog, not in the TUI-owned set).
  assert.ok(!LOCAL_COMMANDS.has('grilling'), 'skill commands must not be local')
  assert.ok(!LOCAL_COMMANDS.has('matrix-cli'), 'skill commands must not be local')
  // SESSIONLESS_COMMANDS is a subset (sessionless commands run locally).
  for (const name of ['exit', 'settings', 'help', 'login', 'logout', 'model', 'reload', 'sessions', 'resume', 'search', 'new', 'fork', 'preset']) {
    assert.ok(LOCAL_COMMANDS.has(name), `sessionless command ${name} must be local`)
  }
})

test('shouldSteerOnEnter: plain prompts and skill commands steer; local commands never do', () => {
  const cmd = (name: string) => ({ name })
  // Plain prompt (no slash command): steers while running with the
  // preference set — the web parity baseline.
  assert.equal(shouldSteerOnEnter(undefined, true, 'steer', false), true, 'plain prompt + running + steer')
  assert.equal(shouldSteerOnEnter(undefined, true, 'queue', false), false, 'queue preference queues')
  assert.equal(shouldSteerOnEnter(undefined, false, 'steer', false), false, 'idle never steers')
  assert.equal(shouldSteerOnEnter(undefined, true, undefined, false), false, 'absent preference queues')
  // Local commands ALWAYS execute, even with the preference set.
  assert.equal(shouldSteerOnEnter(cmd('status'), true, 'steer', false), false, '/status must execute')
  assert.equal(shouldSteerOnEnter(cmd('settings'), true, 'steer', false), false, '/settings must execute')
  assert.equal(shouldSteerOnEnter(cmd('queue'), true, 'steer', false), false, '/queue must execute')
  assert.equal(shouldSteerOnEnter(cmd('skill'), true, 'steer', false), false, '/skill picker must execute')
  // Non-local commands (per-skill slash commands) steer like plain prompts:
  // the raw `/name` line lands in the running turn and the host's pre-step
  // listener (dsh-tool-skill) resolves the skill body — web parity.
  assert.equal(shouldSteerOnEnter(cmd('grilling'), true, 'steer', false), true, 'skill command steers while running')
  assert.equal(shouldSteerOnEnter(cmd('grilling'), true, 'queue', false), false, 'queue preference queues the skill')
  assert.equal(shouldSteerOnEnter(cmd('grilling'), false, 'steer', false), false, 'idle skill executes normally')
  // The Ctrl+Enter chord forces queue mode for EVERYTHING.
  assert.equal(shouldSteerOnEnter(undefined, true, 'steer', true), false, 'the chord never steers')
  assert.equal(shouldSteerOnEnter(cmd('grilling'), true, 'steer', true), false, 'the chord queues skill commands')
})

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
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
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
  return { vt, app, run, view, settings, registered: commands.defs.map(def => def.name) }
}

test('every command registerTuiCommands registers is in LOCAL_COMMANDS', () => {
  // A future TUI command added to commands.ts but forgotten in the local
  // set would silently steer under busyEnter=steer instead of executing.
  const t = setup()
  for (const name of t.registered) {
    assert.ok(LOCAL_COMMANDS.has(name), `registered command ${name} must be local`)
  }
  t.app.stop()
})

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
