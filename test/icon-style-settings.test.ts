/**
 * Icon-style /settings tests (plan §17 + §34.8): the row lists all three
 * styles, missing/invalid persisted values fall back to emoji, the toggle
 * applies to the app IMMEDIATELY (no restart, no session reload) and
 * persists a replace that preserves the other fields.
 * @module @xmoon76/dsh-pi-tui/icon-style-settings.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner, type TuiSettingsLike } from '../src/commands.ts'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** A fake TuiSettingsLike recording every replace (the TUI settings
 * document surface; the writes array lets tests assert persistence). */
function fakeSettings(doc: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    value: {
      get: () => ({ ...doc }) as unknown as TuiSettingsLike['get'] extends () => infer R ? R : never,
      replace: (next: TuiSettingsDoc) => {
        writes.push({ ...next })
        Object.assign(doc, next)
        return undefined as unknown
      },
    },
  }
}

/** Register the TUI commands with a stubbed runner and return /settings. */
function setupSettings(options: { iconStyle?: string } = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const defs: { name: string; handler?: unknown }[] = []
  ctx.provide('commands', {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  } as never)
  ctx.provide('settings', { describe: () => [{ ns: 'dsh-pi-tui', user: {} }] } as never)
  // The fake document starts from the FULL default shape. When no
  // iconStyle is passed, the field is OMITTED entirely — the exact shape
  // of an old settings file written before the preference existed.
  const settings = fakeSettings({
    theme: 'auto',
    footer: 'full',
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    focusMode: 'off',
    ...(options.iconStyle === undefined ? {} : { iconStyle: options.iconStyle }),
  })
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
    applyFooterSettings: () => {},
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
  const def = defs.find(entry => entry.name === 'settings')
  assert.ok(def?.handler !== undefined, 'settings handler missing')
  const run = async (): Promise<void> => {
    await (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
      commandId: CommandId('cmd-icon-test'),
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, settings, run, view }
}

test('/settings lists the Icon style row; missing and invalid persisted values fall back to emoji', async () => {
  // Missing field (old settings file): the row reads emoji.
  const t = setupSettings({})
  await t.run()
  await t.view()
  // Rows without a session: theme, icon-style, expand, thinking, footer,
  // busy-enter, local-shell-sandbox, home-end-keys, fullscreen — the
  // icon-style row is the 2nd.
  t.vt.sendInput('\x1b[B')
  const view = await t.view()
  assert.ok(view.includes('Icon style'), `row missing:\n${view}`)
  // The selected row's VALUE sits on the label's line (the description
  // below also names the styles, so assert on the row line specifically).
  const row = stripTerminalSequences(view).split('\n').find(line => line.includes('Icon style'))
  assert.ok(row !== undefined && row.includes('Icon style') && row.includes('emoji'),
    `missing persisted value must fall back to emoji (row: ${row}):\n${view}`)
  t.app.stop()

  // An invalid persisted value never renders outside the values list.
  const t2 = setupSettings({ iconStyle: 'garbage' })
  await t2.run()
  await t2.view()
  t2.vt.sendInput('\x1b[B')
  const view2 = await t2.view()
  assert.ok(stripTerminalSequences(view2).split('\n').some(line => line.includes('Icon style') && line.includes('emoji')),
    `invalid persisted value must fall back to emoji:\n${view2}`)
  assert.ok(!view2.includes('garbage'), `the raw invalid value must never render:\n${view2}`)
  t2.app.stop()

  // A persisted minimal value renders as minimal.
  const t3 = setupSettings({ iconStyle: 'minimal' })
  await t3.run()
  await t3.view()
  t3.vt.sendInput('\x1b[B')
  const view3 = await t3.view()
  assert.ok(stripTerminalSequences(view3).split('\n').some(line => line.includes('Icon style') && line.includes('minimal')),
    `persisted minimal must render on the row:\n${view3}`)
  t3.app.stop()
})

test('the Icon style row toggle applies immediately and persists without dropping other fields', async () => {
  const t = setupSettings({ iconStyle: 'emoji' })
  await t.run()
  await t.view()
  t.vt.sendInput('\x1b[B') // move to the icon-style row
  await t.view()
  t.vt.sendInput('\r') // toggle emoji -> symbols
  await t.view()
  // The app runtime switched IMMEDIATELY (no restart, no reload).
  assert.equal(t.app.currentIconStyle(), 'symbols', 'the app runtime must switch before persistence settles')
  assert.ok(t.settings.writes.length >= 1, 'the toggle must persist a write')
  const last = t.settings.writes[t.settings.writes.length - 1]
  assert.equal(last?.iconStyle, 'symbols', `wrote: ${JSON.stringify(last)}`)
  // A replace is wholesale: every other field rides along untouched.
  assert.equal(last?.theme, 'auto')
  assert.equal(last?.footer, 'full')
  assert.equal(last?.fullscreen, 'on')
  t.app.stop()
})

test('the toggle cycles through all three styles in one open panel', async () => {
  const t = setupSettings({ iconStyle: 'emoji' })
  await t.run()
  await t.view()
  t.vt.sendInput('\x1b[B') // icon-style row
  await t.view()
  t.vt.sendInput('\r') // -> symbols
  await t.view()
  assert.equal(t.app.currentIconStyle(), 'symbols')
  t.vt.sendInput('\r') // -> minimal
  await t.view()
  assert.equal(t.app.currentIconStyle(), 'minimal', 'minimal must be reachable in the same panel')
  t.vt.sendInput('\r') // -> emoji (wraps)
  await t.view()
  assert.equal(t.app.currentIconStyle(), 'emoji', 'the cycle wraps back to emoji')
  t.app.stop()
})
