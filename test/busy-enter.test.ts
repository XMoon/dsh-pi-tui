/**
 * Headless tests for the busy-Enter preference surface (web busyEnter
 * parity): the /settings row reflects the persisted value and its Enter
 * toggle persists the other behavior, and the pure dispatch boundary
 * (resolveSubmitDelivery) applies the web ComposerSubmissionPolicy to
 * agent-facing input while LOCAL commands always execute. The steer-side
 * semantics (steerAll onlyDraft) live in steer.test.ts; the accelerated
 * chord lives in input-experience.test.ts.
 * @module @xmoon76/dsh-pi-tui/busy-enter.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import { LOCAL_COMMANDS, resolveSubmitDelivery } from '../src/index.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** The TUI-owned command names registered by registerTuiCommands (commands.ts). */
const TUI_OWNED = [
  'copy', 'exit', 'export', 'fork', 'help', 'kill', 'login', 'logout',
  'model', 'new', 'preset', 'quit', 'reload', 'rename', 'resume',
  'search', 'sessions', 'settings', 'skill', 'status', 'subagents', 'tasks',
  'title', 'transcript', 'yolo',
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

test('resolveSubmitDelivery: plain prompts and skill commands follow the policy; local commands never do', () => {
  const cmd = (name: string) => ({ name })
  // Plain prompt (no slash command): the web ComposerSubmissionPolicy
  // baseline — an idle agent queues, plain Enter takes the preference.
  assert.equal(resolveSubmitDelivery(undefined, true, 'enter', 'steer'), 'steer', 'plain prompt + running + steer')
  assert.equal(resolveSubmitDelivery(undefined, true, 'enter', 'queue'), 'queue', 'queue preference queues')
  assert.equal(resolveSubmitDelivery(undefined, false, 'enter', 'steer'), 'queue', 'idle never steers')
  assert.equal(resolveSubmitDelivery(undefined, true, 'enter', undefined), 'queue', 'absent preference queues')
  // The ACCELERATED chord is the OPPOSITE of the preference (never a fixed
  // queue): with the DEFAULT preference it steers, with 'steer' it queues.
  assert.equal(resolveSubmitDelivery(undefined, true, 'accelerated', 'queue'), 'steer',
    'the accelerated chord steers under the default queue preference')
  assert.equal(resolveSubmitDelivery(undefined, true, 'accelerated', 'steer'), 'queue',
    'the accelerated chord queues under the steer preference')
  assert.equal(resolveSubmitDelivery(undefined, true, 'accelerated', undefined), 'steer',
    'an absent preference reads as queue, so the chord steers')
  assert.equal(resolveSubmitDelivery(undefined, false, 'accelerated', 'queue'), 'queue',
    'an idle agent queues every gesture')
  // Local commands ALWAYS execute, even with the preference set.
  assert.equal(resolveSubmitDelivery(cmd('status'), true, 'enter', 'steer'), 'queue', '/status must execute')
  assert.equal(resolveSubmitDelivery(cmd('settings'), true, 'enter', 'steer'), 'queue', '/settings must execute')
  assert.equal(resolveSubmitDelivery(cmd('subagents'), true, 'enter', 'steer'), 'queue', '/subagents alias must execute (alias of /tasks)')
  assert.equal(resolveSubmitDelivery(cmd('skill'), true, 'enter', 'steer'), 'queue', '/skill picker must execute')
  // A local command's delivery value is never consumed, so the accelerated
  // chord must not turn one into a steer either.
  assert.equal(resolveSubmitDelivery(cmd('status'), true, 'accelerated', 'queue'), 'queue',
    'a local command never steers, whatever the gesture')
  // Non-local commands (per-skill slash commands) follow the policy like
  // plain prompts: under steer the raw `/name` line lands in the running
  // turn and the host's pre-step listener (dsh-tool-skill) resolves the
  // skill body — web parity.
  assert.equal(resolveSubmitDelivery(cmd('grilling'), true, 'enter', 'steer'), 'steer', 'skill command steers while running')
  assert.equal(resolveSubmitDelivery(cmd('grilling'), true, 'enter', 'queue'), 'queue', 'queue preference queues the skill')
  assert.equal(resolveSubmitDelivery(cmd('grilling'), false, 'enter', 'steer'), 'queue', 'idle skill executes normally')
  assert.equal(resolveSubmitDelivery(cmd('grilling'), true, 'accelerated', 'steer'), 'queue', 'the chord queues skill commands')
  assert.equal(resolveSubmitDelivery(cmd('grilling'), true, 'accelerated', 'queue'), 'steer', 'the chord steers skill commands under the default preference')
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
      // The completion list mirrors the registry (like the real service's
      // effective view), so the advertised-claim surface sees registrations.
      list: () => defs.map(def => ({ name: def.name, description: 'a command', input: { hint: '' } })),
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** Register the TUI commands with a stubbed runner and return /settings. */
function setup(options: { busyEnter?: string; localShellSandbox?: string; extensions?: unknown } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings.value,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(),
      measureContext: () => undefined,
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
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: options.extensions as never,
    exit: () => {},
  }
  const installed = registerTuiCommands(runner)
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
  return { vt, app, run, runCommand, view, settings, installed, commands, registered: commands.defs.map(def => def.name) }
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

test('resolveSubmitDelivery: /skill <name> with args follows the policy; the bare picker does not (review finding)', () => {
  const withArgs = resolveSubmitDelivery({ name: 'skill', rawInput: 'grilling [image #1 (800×600)]' }, true, 'enter', 'steer')
  assert.equal(withArgs, 'steer', '/skill <name> [image ...] is agent input while running')
  const bare = resolveSubmitDelivery({ name: 'skill', rawInput: '' }, true, 'enter', 'steer')
  assert.equal(bare, 'queue', 'the bare /skill picker stays local')
  const idle = resolveSubmitDelivery({ name: 'skill', rawInput: 'grilling x' }, false, 'enter', 'steer')
  assert.equal(idle, 'queue', 'idle never steers')
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

test('/settings SettingsList row responds to a fullscreen mouse click (v0.85.1 mouse integration)', async () => {
  const t = setup({ busyEnter: 'steer' })
  t.app.setFullscreen(true)
  await t.run('')
  await t.view()
  const viewport = t.vt.getViewport()
  const rowY = viewport.findIndex(line => line.includes('Submit while busy'))
  assert.ok(rowY >= 0, `busy-enter row missing:\n${viewport.join('\n')}`)
  const leftBorder = viewport[rowY]?.indexOf('│') ?? -1
  assert.ok(leftBorder >= 0, 'frame left border missing')
  // SGR click on the row's content (1-based): the content starts two cells
  // right of the left border (`│` + one padding cell).
  t.vt.sendInput(`\x1b[<0;${leftBorder + 3};${rowY + 1}M`)
  t.vt.sendInput(`\x1b[<0;${leftBorder + 3};${rowY + 1}m`)
  await t.view()
  assert.ok(t.settings.writes.length >= 1, 'the mouse click must toggle and persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.busyEnter, 'queue', `the click must flip steer -> queue, wrote: ${JSON.stringify(last)}`)
  t.app.stop()
})

test('/settings frame borders do not activate SettingsList rows (v0.85.1 mouse integration)', async () => {
  const t = setup({ busyEnter: 'steer' })
  t.app.setFullscreen(true)
  await t.run('')
  await t.view()
  const viewport = t.vt.getViewport()
  const borderY = viewport.findIndex(line => line.includes('╰'))
  assert.ok(borderY >= 0, `frame bottom border missing:\n${viewport.join('\n')}`)
  const rowY = viewport.findIndex(line => line.includes('Submit while busy'))
  const leftBorder = viewport[rowY]?.indexOf('│') ?? -1
  assert.ok(leftBorder >= 0, 'frame left border missing')
  // Click the bottom border (inside the frame, on the border row): it must
  // NOT reach the child as a valid row.
  t.vt.sendInput(`\x1b[<0;${leftBorder + 2};${borderY + 1}M`)
  t.vt.sendInput(`\x1b[<0;${leftBorder + 2};${borderY + 1}m`)
  await t.view()
  assert.equal(t.settings.writes.length, 0, 'a bottom-border click must not toggle a row')
  t.app.stop()
})

test('/settings frame left padding does not activate SettingsList rows (v0.85.1 mouse integration)', async () => {
  const t = setup({ busyEnter: 'steer' })
  t.app.setFullscreen(true)
  await t.run('')
  await t.view()
  const viewport = t.vt.getViewport()
  const rowY = viewport.findIndex(line => line.includes('Submit while busy'))
  assert.ok(rowY >= 0, `busy-enter row missing:\n${viewport.join('\n')}`)
  const leftBorder = viewport[rowY]?.indexOf('│') ?? -1
  assert.ok(leftBorder >= 0, 'frame left border missing')
  // Click the padding cell between the left border and the content
  // (frame-local x=1): it must NOT reach the child as column 0.
  t.vt.sendInput(`\x1b[<0;${leftBorder + 2};${rowY + 1}M`)
  t.vt.sendInput(`\x1b[<0;${leftBorder + 2};${rowY + 1}m`)
  await t.view()
  assert.equal(t.settings.writes.length, 0, 'a left-padding click must not toggle a row')
  t.app.stop()
})

test('isHostCommand claims advertised non-skill commands and never skill wrappers (PR115-fix problem 1)', () => {
  const t = setup()
  // A Host command (e.g. /compact) registered by the Host joins the
  // effective catalog; a snapshot commit refreshes the advertised claims.
  t.commands.service.register({ name: 'compact', handler: () => ({ kind: 'success' }) })
  t.installed.installSnapshot({ commands: [], scopedCommands: [], skills: [], issues: [] })
  assert.equal(t.installed.isHostCommand('compact'), true,
    'an advertised Host command must be claimed as a Host command')
  // A TUI-owned skill wrapper is advertised too, but it is an agent-facing
  // invocation — never a Host-command claim.
  t.installed.installSnapshot({
    commands: [],
    scopedCommands: [],
    skills: [{ name: 'grilling', description: 'a skill' }],
    issues: [],
  })
  assert.equal(t.installed.isHostCommand('grilling'), false,
    'a TUI-owned skill wrapper must never be claimed as a Host command')
  // The claim is catalog-driven: a name absent from the effective catalog
  // is not claimed (it keeps the ordinary prompt semantics).
  assert.equal(t.installed.isHostCommand('not-a-command'), false,
    'an unadvertised name must not be claimed')
  t.app.stop()
})

test('isHostCommand keeps HOST AUTHORITY: a client contribution never removes a host claim', () => {
  // A client command contribution only ADDS a client-owned name. When the
  // host catalog resolves the same name, the host command keeps its claim —
  // upstream's candidate synthesis fails loud on the collision instead of
  // shadowing, so the dispatch can never downgrade it to a prompt.
  const contributions = new Map<string, { name: string }>([
    ['deploy', { name: 'deploy' }],
    ['panel', { name: 'panel' }],
  ])
  const t = setup({
    extensions: {
      commands: { find: (name: string) => contributions.get(name) },
    },
  })
  t.commands.service.register({ name: 'deploy', handler: () => ({ kind: 'success' }) })
  t.commands.service.register({ name: 'compact', handler: () => ({ kind: 'success' }) })
  t.installed.installSnapshot({ commands: [], scopedCommands: [], skills: [], issues: [] })
  assert.equal(t.installed.isHostCommand('deploy'), true,
    'a host command keeps its claim even when a client contribution shares the name')
  assert.equal(t.installed.isHostCommand('compact'), true,
    'a real Host command stays claimed')
  assert.equal(t.installed.isHostCommand('panel'), false,
    'a client-only name is not a host claim (it never entered the host list)')
  t.app.stop()
})

test('the deprecated app.input.queue action keeps its own (fixed-queue) identity', () => {
  // The chord became the web accelerated gesture, but the OLD action id is a
  // settings-level public name: a stored remap must keep meaning "queue the
  // draft" — never be silently re-interpreted as the opposite behavior, and
  // never be dropped as an unknown action.
  const parsed = parseUserKeybindings({ 'app.input.queue': 'ctrl+y' })
  assert.equal(parsed.bindings['app.input.queue'], 'ctrl+y', 'the deprecated action keeps its own declaration')
  assert.equal(parsed.bindings['app.input.submitAccelerated'], undefined,
    'the accelerated action must not inherit the legacy declaration')
  assert.deepEqual(parsed.diagnostics, [], 'the deprecated id is a KNOWN action — no diagnostic')
  // The two actions are independent: declaring both binds both.
  const both = parseUserKeybindings({ 'app.input.queue': 'ctrl+y', 'app.input.submitAccelerated': 'ctrl+k' })
  assert.equal(both.bindings['app.input.queue'], 'ctrl+y')
  assert.equal(both.bindings['app.input.submitAccelerated'], 'ctrl+k')
  assert.deepEqual(both.diagnostics, [], 'two distinct actions never collide')
})
