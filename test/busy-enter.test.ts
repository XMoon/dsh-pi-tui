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
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** The TUI-owned command names registered by registerTuiCommands (commands.ts). */
const TUI_OWNED = [
  'copy', 'exit', 'export', 'fork', 'help', 'kill', 'login', 'logout',
  'model', 'new', 'preset', 'quit', 'reload', 'rename', 'resume',
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
  assert.equal(shouldSteerOnEnter(cmd('subagents'), true, 'steer', false), false, '/subagents alias must execute (alias of /tasks)')
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
function fakeTuiSettings(busyEnter: string, localShellSandbox = 'bypass'): { value: TuiSettingsLike; writes: Array<Record<string, unknown>> } {
  const doc: Record<string, unknown> = {
    theme: 'auto', footer: 'full', fullscreen: 'on', busyEnter, localShellSandbox, history: {},
  }
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    value: {
      get: () => ({ ...doc }) as unknown as TuiSettingsLike['get'] extends () => infer R ? R : never,
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
function setup(options: { busyEnter?: string; localShellSandbox?: string } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = fakeCommands()
  ctx.provide('commands', commands.service as never)
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  const settings = fakeTuiSettings(options.busyEnter ?? 'queue', options.localShellSandbox ?? 'bypass')
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: settings.value,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort(() => undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
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
  // Run ANY registered command (defaults to /settings for the existing
  // tests; /help uses the same surface).
  const runCommand = async (name: string, rawInput = ''): Promise<unknown> => {
    const found = commands.defs.find(entry => entry.name === name)
    assert.ok(found?.handler !== undefined, `${name} handler missing`)
    return (found!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
      commandId: CommandId('cmd-test-1'),
      agent: undefined as never,
      rawInput,
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, runCommand, view, settings, registered: commands.defs.map(def => def.name) }
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
  // Key-neutral label (review round 37): the preference is the semantic
  // SUBMIT action's busy behavior — never a physical Enter claim (the
  // submit key may be remapped).
  assert.ok(view.includes('Submit while busy'), `busy-enter row missing:\n${view}`)
  assert.ok(view.includes('steer'), `persisted value missing:\n${view}`)
  t.app.stop()
})

test('the busy-enter row Enter toggle persists the other behavior', async () => {
  const t = setup({ busyEnter: 'steer' })
  await t.run('')
  await t.view()
  // Rows without a session: theme, icon-style, expand, thinking, footer,
  // busy-enter, fullscreen, separator, cwd — the busy-enter row is the
  // 6th.
  t.vt.sendInput('\x1b[B') // down × 5
  t.vt.sendInput('\x1b[B')
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

test('/settings shows the local-shell-sandbox row with the persisted value', async () => {
  const t = setup({ localShellSandbox: 'sandbox' })
  await t.run('')
  await t.view()
  // The row sits below the initial fold (theme, icon-style, expand,
  // thinking, footer, busy-enter, then sandbox).
  for (let i = 0; i < 6; i += 1) t.vt.sendInput('\x1b[B')
  const view = await t.view()
  assert.ok(view.includes('Local shell sandbox'), `local-shell-sandbox row missing:\n${view}`)
  assert.ok(view.includes('sandbox'), `persisted value missing:\n${view}`)
  t.app.stop()
})

test('the local-shell-sandbox row defaults to bypass', async () => {
  const t = setup()
  await t.run('')
  await t.view()
  for (let i = 0; i < 6; i += 1) t.vt.sendInput('\x1b[B')
  const view = await t.view()
  assert.ok(view.includes('bypass'), `default bypass value missing:\n${view}`)
  t.app.stop()
})

test('the local-shell-sandbox row Enter toggle persists the other behavior', async () => {
  const t = setup({ localShellSandbox: 'bypass' })
  await t.run('')
  await t.view()
  // Rows without a session: theme, icon-style, expand, thinking, footer,
  // busy-enter, local-shell-sandbox, fullscreen, separator, cwd — the
  // sandbox row is the 7th.
  t.vt.sendInput('\x1b[B') // down × 6
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\x1b[B')
  t.vt.sendInput('\r') // toggle the selected row's value
  await t.view()
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.localShellSandbox, 'sandbox', `the toggle must flip bypass -> sandbox, wrote: ${JSON.stringify(last)}`)
  t.app.stop()
})

test('shouldSteerOnEnter: /skill <name> with args steers; the bare picker does not (review finding)', () => {
  const withArgs = shouldSteerOnEnter({ name: 'skill', rawInput: 'grilling [image #1 (800×600)]' }, true, 'steer', false)
  assert.equal(withArgs, true, '/skill <name> [image ...] is agent input while running')
  const bare = shouldSteerOnEnter({ name: 'skill', rawInput: '' }, true, 'steer', false)
  assert.equal(bare, false, 'the bare /skill picker stays local')
  const idle = shouldSteerOnEnter({ name: 'skill', rawInput: 'grilling x' }, false, 'steer', false)
  assert.equal(idle, false, 'idle never steers')
})

test('/help copy is key-neutral after a remap — no stale bare Esc/Enter claims (review round 37)', async () => {
  // The effective-key copy convention: after remapping interrupt -> ctrl+x
  // and submit -> ctrl+z, /help must NOT claim the physical Esc (the
  // double-action follows the EFFECTIVE interrupt key) or Enter (submit).
  // The prose is semantic/key-neutral; the LABEL column shows the
  // effective keys (`Ctrl+X`, `Ctrl+Z`). The settings panel shows the
  // SELECTED row's description only, so navigate to each row.
  const t = setup()
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    'app.agent.interrupt': 'ctrl+x',
    'app.input.submit': 'ctrl+z',
  }))
  await t.runCommand('help')
  let view = await t.view()
  // The first row (submit) is selected: its label shows the effective key
  // and its description is visible.
  assert.ok(view.includes('Ctrl+Z'), `the effective submit key must be shown:\n${view}`)
  const submitRow = view.split('\n').find(line => line.includes('Submit the draft'))
  assert.ok(submitRow !== undefined, 'the selected submit row must render its description')
  assert.ok(!submitRow!.includes('Enter'), `the submit row must not claim physical Enter:\n${submitRow}`)
  // Navigate down to the cancel row (row 3: submit, queue, exit, cancel).
  for (let i = 0; i < 3; i += 1) t.vt.sendInput('\x1b[B')
  view = await t.view()
  // The cancel description wraps across panel lines — search the whole
  // viewport (the label row itself only carries the effective key).
  assert.ok(view.includes('Cancel the active turn'), 'the selected cancel row must render its description')
  assert.ok(!view.includes('one Esc while'), `the cancel copy must not claim physical Esc:\n${view}`)
  assert.ok(view.includes('interrupt action twice'), 'the cancel prose is key-neutral (semantic action)')
  t.app.stop()
})
