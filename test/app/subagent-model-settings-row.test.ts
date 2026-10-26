/**
 * Regression for the /settings "Subagent model selection" toggle row
 * (review round 2): rapid toggles must SERIALIZE their official-section
 * writes (a slow earlier write can never land after a newer one), every
 * settle re-syncs the row to the ACTUAL committed state, and a rejected
 * write rolls the row back with a notice.
 * @module @xmoon76/dsh-pi-tui/subagent-model-settings-row.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { navigateToLegacySettings } from '../support/open-legacy-settings.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces
 * (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})


/** The minimal live-Agent surface the settings handler's scope reads need
 *  (`sessionScopeFacts` validates currency, so the row requires a real one). */
const LIVE_AGENT = {
  session: { id: 'settings-scope-session', header: { cwd: '/ws' }, snapshotEvents: () => [] },
  options: { provider: 'p', model: 'm' },
  status: 'idle',
}

const ENTER = '\r'

function fakeCommands(): { defs: Array<{ name: string; handler?: unknown }>; service: unknown } {
  const defs: Array<{ name: string; handler?: unknown }> = []
  return {
    defs,
    service: {
      register: (def: { name: string; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => [],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

interface SettingsDoc {
  enabled?: boolean
  allowedModels?: Array<{ provider: string; model: string }>
}

/** A settings service whose writes can be DELAYED (the serialization
 * repro: the first write must not land after the second). */
function settingsService(initial: SettingsDoc): {
  service: { describe(): Array<{ ns: string; value: unknown; user: unknown; revision: number }>; mutate(ns: string, ops: unknown): Promise<unknown> }
  doc: SettingsDoc
  writes: Array<{ enabled: boolean; allowedModels: unknown }>
  setPromises: Promise<void>[]
  gateNextWrite: () => { release: () => void }
  failNextWrite: () => void
} {
  const doc: SettingsDoc = { ...initial }
  const writes: Array<{ enabled: boolean; allowedModels: unknown }> = []
  const setPromises: Promise<void>[] = []
  let gate: { release: () => void } | undefined
  let fail = false
  return {
    service: {
      describe: () => [{ ns: 'subagent-model-selection-settings', value: doc, user: doc, revision: 2 }],
      mutate: async (_ns: string, ops: unknown) => {
        const attempt = (async () => {
          if (fail) {
            fail = false
            throw new Error('official validation rejected the section')
          }
          const parsed = ops as Array<{ op: string; path: string[]; value: unknown }>
          const enabled = parsed.find(op => op.path[0] === 'enabled')?.value as boolean
          const allowedModels = parsed.find(op => op.path[0] === 'allowedModels')?.value as unknown
          writes.push({ enabled, allowedModels })
          if (gate !== undefined) {
            const pending = gate
            gate = undefined
            await new Promise<void>(resolve => pending.release = resolve)
          }
          doc.enabled = enabled
          doc.allowedModels = allowedModels as SettingsDoc['allowedModels']
        })()
        setPromises.push(attempt)
        await attempt
      },
    },
    doc,
    writes,
    setPromises,
    gateNextWrite: () => {
      const pending = { release: () => {} }
      gate = pending
      return pending
    },
    failNextWrite: () => { fail = true },
  }
}

/** Flush the serialized write chain and await every section write started
 * so far (deterministic — never a fixed timer). The chain's settle
 * handlers (syncFromSection / revert / notify) run one microtask AFTER the
 * write promise itself settles, so a final bounded flush covers them. */
async function settle(harness: ReturnType<typeof makeHarness>, expectedWrites: number): Promise<void> {
  for (let i = 0; i < 16 && harness.settings.setPromises.length < expectedWrites; i += 1) {
    await Promise.resolve()
  }
  await Promise.allSettled(harness.settings.setPromises)
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

function makeHarness(initial: SettingsDoc, options: { realSettings?: boolean; liveAgent?: unknown } = {}): {
  runner: TuiCommandRunner
  app: TuiApp
  vt: VirtualTerminal
  settings: ReturnType<typeof settingsService>
  defs: Array<{ name: string; handler?: unknown }>
  settingsChange: Parameters<TuiApp['openSettings']>[1] | undefined
  settingsItems: Parameters<TuiApp['openSettings']>[0] | undefined
  onCancel: (() => void) | undefined
  notices: Array<{ message: string; kind: 'info' | 'error' }>
} {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const { defs, service: commandsService } = fakeCommands()
  ctx.provide('commands', commandsService as never)
  const settings = settingsService(initial)
  ctx.provide('settings', settings.service as never)
  // The 0.1.7 read authority is the official service's current() snapshot;
  // the fake serves the same document the settings write commits.
  ctx.provide('subagentModelSelection', { current: () => ({ enabled: settings.doc.enabled, allowedModels: (settings.doc.allowedModels ?? []).map(route => ({ ...route })) }) } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'p', name: 'Provider P' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => undefined, saveSelection: async () => {} } as never)
  const notices: Array<{ message: string; kind: 'info' | 'error' }> = []
  app.notify = ((message: string, kind: 'info' | 'error' = 'info') => {
    notices.push({ message, kind })
  }) as TuiApp['notify']
  let settingsChange: Parameters<TuiApp['openSettings']>[1] | undefined
  let settingsItems: Parameters<TuiApp['openSettings']>[0] | undefined
  let onCancel: (() => void) | undefined
  if (options.realSettings === true) {
    // Keep the REAL SettingsList mount (the fork generation guard is part of
    // the behavior under test) while still capturing the panel arguments.
    const original = app.openSettings.bind(app)
    app.openSettings = ((...args: Parameters<TuiApp['openSettings']>) => {
      settingsItems = args[0]
      settingsChange = args[1]
      onCancel = args[2]
      return original(...args)
    }) as TuiApp['openSettings']
  } else {
    app.openSettings = ((...args: Parameters<TuiApp['openSettings']>) => {
      settingsItems = args[0]
      settingsChange = args[1]
      onCancel = args[2]
      return () => {}
    }) as TuiApp['openSettings']
  }
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    ...sessionScopeFacts(() => options.liveAgent as never, () => 0),
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => ({ items: [], hasMore: false }), projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined },
    sessionWriter: { prompt: async () => ({ kind: 'committed' as const, value: undefined }), updateQueue: async () => ({ kind: 'committed' as const, value: undefined }), cancel: async () => ({ kind: 'committed' as const, value: undefined }), rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }), refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { questions: { subscribe: () => undefined,  onRequest: () => true, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const }, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
    applyFooterSettings: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  // The captured panel args are read through GETTERS: the mock assigns the
  // outer variables when the handler runs, so a value snapshot taken at
  // harness construction would stay undefined.
  return {
    runner,
    app,
    vt,
    settings,
    defs,
    get settingsChange() { return settingsChange },
    get settingsItems() { return settingsItems },
    get onCancel() { return onCancel },
    notices,
  }
}

/** Open the /settings panel through the registered command, crossing the B2-A
 *  workspace's `Agent → Agent settings…` transition launcher. */
async function openSettingsPanel(harness: ReturnType<typeof makeHarness>): Promise<void> {
  const settings = harness.defs.find(entry => entry.name === 'settings')
  assert.ok(settings?.handler !== undefined, 'the settings command must be registered')
  await (settings.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await harness.vt.waitForRender()
  await navigateToLegacySettings(harness.vt)
}

test('the /settings panel exposes the official subagent model-selection rows', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const items = harness.settingsItems
  assert.ok(items !== undefined, 'the panel must open')
  const toggle = items!.find(item => item.id === 'subagent-model-selection')
  assert.ok(toggle !== undefined, 'the toggle row must exist when the official service is mounted')
  assert.deepEqual(toggle!.values, ['off', 'on'])
  assert.equal(toggle!.currentValue, 'off')
  const allowlist = items!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlist !== undefined, 'the allowlist row must exist')
  assert.equal(allowlist!.currentValue, '0 routes')
  // The UI order expresses the setup dependency: configure the allowed
  // routes BEFORE enabling selection (the allowlist row comes first).
  assert.ok(
    items!.indexOf(allowlist!) < items!.indexOf(toggle!),
    'the allowlist row must precede the selection toggle',
  )
})

test('rapid toggles SERIALIZE: a slow earlier write never lands after a newer one', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] })
  await openSettingsPanel(harness)
  const change = harness.settingsChange!
  // The first write is GATED (stays in flight); the second toggle happens
  // while it is pending. Serialization must order them: the second write
  // only starts after the first settles, so the LAST toggle wins.
  const gate = harness.settings.gateNextWrite()
  change('subagent-model-selection', 'on', () => {})
  change('subagent-model-selection', 'off', () => {})
  await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the second write must wait for the first')
  gate.release()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 2, 'both writes commit in order')
  assert.deepEqual(harness.settings.writes.map(write => write.enabled), [true, false])
  assert.equal(harness.settings.doc.enabled, false, 'the LAST toggle wins')
})

test('enabling with an EMPTY allowlist is a setup guide, not a write: no settings write, row stays off', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const change = harness.settingsChange!
  const reverted: string[] = []
  const navigated: string[] = []
  // Enabling with an EMPTY allowlist is a UI precondition: the toggle must
  // NOT call the official section write at all (no Host settings mutation),
  // keep the row off, and guide the user to the allowlist row.
  change('subagent-model-selection', 'on', (previous) => { reverted.push(previous) }, (targetId) => { navigated.push(targetId) })
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 0, 'no official section write may be produced')
  assert.equal(harness.settings.doc.enabled, false, 'the section stays off')
  assert.deepEqual(reverted, ['off'], 'the row display rolls back to the previous value')
  assert.deepEqual(navigated, ['subagent-model-allowlist'], 'the cursor moves to the allowlist row')
  const notice = harness.notices.at(-1)
  assert.equal(notice?.kind, 'info', 'the guidance is an info notice, not an error')
  assert.match(notice?.message ?? '', /Select at least one Subagent allowed model/i)
  assert.doesNotMatch(notice?.message ?? '', /write failed/i, 'a setup precondition must never surface as a write failure')
})

test('enabling with a NON-EMPTY allowlist writes the whole official section', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] })
  await openSettingsPanel(harness)
  const change = harness.settingsChange!
  const reverted: string[] = []
  change('subagent-model-selection', 'on', (previous) => { reverted.push(previous) })
  await settle(harness, 1)
  assert.equal(harness.settings.writes.length, 1, 'the official section write must happen')
  assert.deepEqual(harness.settings.writes[0], {
    enabled: true,
    allowedModels: [{ provider: 'p', model: 'm1' }],
  }, 'the whole section rides along: enabled flips, the allowlist is preserved')
  assert.equal(harness.settings.doc.enabled, true, 'the section commits enabled')
  assert.deepEqual(reverted, ['on'], 'the row re-syncs to the committed state')
  assert.equal(harness.notices.length, 0, 'a legal write produces no notice')
})

test('first-time setup happy path: add an allowed route, then enable selection', async () => {
  // The complete first-configuration flow: 0 routes + off → open the
  // allowlist submenu (flat, provider-grouped: NO provider navigation step)
  // → Enter toggles the highlighted model → ONE Esc returns to the settings
  // list → toggle selection ON. The whole section must commit with the route
  // the user just granted.
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const dones: Array<string | undefined> = []
  const menu = allowlistRow.submenu!('0 routes', (selected) => { dones.push(selected) }) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // let provider discovery settle
  menu.handleInput(ENTER) // toggle the highlighted model ON directly — no provider step
  await settle(harness, 1)
  assert.deepEqual(harness.settings.doc.allowedModels, [{ provider: 'p', model: 'm1' }], 'the first route commits')
  // The picker's own chain re-reads the committed section after the write
  // settles; the close summary describes that read, not the earlier marker.
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  menu.handleInput('\x1b') // ONE Esc returns to /settings and reports the summary
  assert.deepEqual(dones, ['1 route'], 'a single Esc closes and the outer row shows the fresh route count')
  // Now the toggle may be enabled: the gate must NOT block a non-empty
  // allowlist, and the write carries the committed routes.
  const change = harness.settingsChange!
  change('subagent-model-selection', 'on', () => {})
  await settle(harness, 2)
  assert.equal(harness.settings.writes.length, 2, 'the allowlist write plus the enable write')
  assert.deepEqual(harness.settings.writes[1], {
    enabled: true,
    allowedModels: [{ provider: 'p', model: 'm1' }],
  })
  assert.equal(harness.settings.doc.enabled, true, 'selection commits enabled')
  assert.equal(harness.notices.length, 0, 'the happy path produces no notice')
})

test('C2-R3: a legacy toggle queued behind a HELD allowlist write keeps the routes that write committed', async () => {
  // The original cross-surface defect: the legacy editor toggle read the whole
  // section BEFORE its turn and then wrote that stale list, erasing a route the
  // picker had just committed. The toggle now owns only `enabled` and re-reads
  // the routes inside the shared queue, so this case fails on the old code.
  const harness = makeHarness({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const menu = allowlistRow.submenu!('2 routes', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // let the catalog settle

  // 1) The picker removes a route; its section write is HELD open.
  const gate = harness.settings.gateNextWrite()
  menu.handleInput('\x1b[B') // move off the first route
  menu.handleInput(ENTER)
  // The queue's fresh read + the write chain settle over a few microtasks.
  for (let i = 0; i < 8 && harness.settings.writes.length < 1; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the picker write really dispatched')

  // 2) The user leaves the picker and flips the legacy toggle while that write
  //    is still in flight. The toggle must NOT resurrect the removed route.
  menu.handleInput('\x1b')
  const change = harness.settingsChange!
  change('subagent-model-selection', 'off', () => {})
  await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the toggle waits for the held picker write')

  gate.release()
  await settle(harness, 2)
  const writes = harness.settings.writes
  assert.equal(writes.length, 2, 'both intents committed, in order')
  const surviving = writes[0]!.allowedModels as Array<{ provider: string; model: string }>
  assert.equal(surviving.length, 1, 'the picker removed exactly one route')
  assert.deepEqual(writes[1], { enabled: false, allowedModels: surviving },
    'the legacy toggle kept the FRESH routes: the removed route is never resurrected')
  assert.deepEqual(harness.settings.doc.allowedModels, surviving, 'the committed section carries the surviving route')
  assert.equal(harness.settings.doc.enabled, false, 'and the toggle really landed')
})

test('C2-R3: removing the LAST route while disabled, then enabling, is a setup guide — never a write failure', async () => {
  // RFL-006: the empty-allowlist precondition must be judged against the FRESH
  // section INSIDE the queue. The early check sees a non-empty list (the picker
  // removal has not settled yet), so only the in-queue decision can refuse the
  // enable with the setup guidance instead of a rejected write.
  const harness = makeHarness({ enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const menu = allowlistRow.submenu!('1 route', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // let the catalog settle

  // 1) Remove the ONLY route; that write is HELD open.
  const gate = harness.settings.gateNextWrite()
  menu.handleInput(ENTER) // the single allowed route is selected first
  for (let i = 0; i < 8 && harness.settings.writes.length < 1; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the removal really dispatched')
  assert.deepEqual(harness.settings.doc.allowedModels, [{ provider: 'p', model: 'm1' }],
    'the removal has NOT landed yet: the section still reads one route')

  // 2) Leave the picker and enable selection while the removal is in flight.
  menu.handleInput('\x1b')
  const reverted: string[] = []
  const navigated: string[] = []
  const change = harness.settingsChange!
  change('subagent-model-selection', 'on', (previous) => { reverted.push(previous) }, (targetId) => { navigated.push(targetId) })
  await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the enable waits for the held removal')

  gate.release()
  await settle(harness, 1)
  // The detached settlement owns a few more microtasks (queue turn → refusal →
  // revert/notice/navigate); flush until the row has really settled.
  for (let i = 0; i < 16 && reverted.length === 0; i += 1) await Promise.resolve()
  // The FRESH section is now empty, so the enable performs ZERO official writes
  // and reports the SETUP PRECONDITION instead of a write failure.
  assert.equal(harness.settings.writes.length, 1, 'no official enable write was dispatched')
  assert.equal(harness.settings.doc.enabled, false, 'the section stays off')
  assert.deepEqual(harness.settings.doc.allowedModels, [], 'the removal really committed')
  assert.deepEqual(reverted.at(-1), 'off', 'the row rolls back to off')
  assert.deepEqual(navigated, ['subagent-model-allowlist'], 'the cursor moves to the allowlist row')
  const notice = harness.notices.at(-1)
  assert.equal(notice?.kind, 'info', `the guidance is an info notice, not a failure: ${JSON.stringify(notice)}`)
  assert.match(notice?.message ?? '', /Select at least one Subagent allowed model/i)
  assert.doesNotMatch(notice?.message ?? '', /write failed/i, 'a setup precondition must never surface as a write failure')
})

test('C2-R3: enabling while a route ADD is still queued waits for it instead of refusing an empty list', async () => {
  // The reverse race of RFL-006: an early empty-allowlist read would refuse this
  // enable, dropping the user's intent even though the queued add is about to
  // make it legal. The empty check therefore lives ONLY inside the queue.
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const menu = allowlistRow.submenu!('0 routes', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // let the catalog settle

  // 1) Grant the first route; that write is HELD, so the section still reads [].
  const gate = harness.settings.gateNextWrite()
  menu.handleInput(ENTER)
  for (let i = 0; i < 8 && harness.settings.writes.length < 1; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the add really dispatched')
  assert.deepEqual(harness.settings.doc.allowedModels, [], 'the add has NOT landed yet')

  // 2) Leave the picker and enable selection right away.
  menu.handleInput('\x1b')
  const reverted: string[] = []
  const navigated: string[] = []
  const change = harness.settingsChange!
  change('subagent-model-selection', 'on', (previous) => { reverted.push(previous) }, (targetId) => { navigated.push(targetId) })
  await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'the enable waits behind the held add')

  gate.release()
  await settle(harness, 2)
  assert.deepEqual(navigated, [], 'no setup guidance: the queued add makes the enable legal')
  assert.equal(harness.settings.writes.length, 2, 'the enable really committed after the add')
  assert.deepEqual(harness.settings.writes[1], { enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] },
    'the enable carries the route the queued add committed')
  assert.equal(harness.settings.doc.enabled, true, 'selection is on')
  assert.deepEqual(harness.settings.doc.allowedModels, [{ provider: 'p', model: 'm1' }])
  assert.equal(harness.notices.length, 0, 'the happy ordering produces no notice')
})

test('C2-R3/F1: two picker opens compose their route GRANTS instead of dropping the earlier one', async () => {
  // The cross-instance race: picker A adds p/m1 and its write is HELD; the user
  // Escapes and re-enters (picker B reads the still-empty section), then adds
  // p/m2. Replaying B's whole list would erase p/m1 — a grant the user never
  // withdrew. Each toggle submits only its own (provider, model) intent.
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')

  // Picker A: add the FIRST catalog model, with the write held open.
  const gate = harness.settings.gateNextWrite()
  const menuA = allowlistRow.submenu('0 routes', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // catalog settles
  menuA.handleInput(ENTER)
  for (let i = 0; i < 8 && harness.settings.writes.length < 1; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'picker A dispatched its route')
  menuA.handleInput('\x1b') // leave A while its write is still pending

  // Picker B: a SECOND instance over the same still-empty section.
  const menuB = allowlistRow.submenu('0 routes', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  menuB.handleInput('\x1b[B') // move to the second catalog model
  menuB.handleInput(ENTER)
  await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1, 'picker B queues behind A')
  menuB.handleInput('\x1b')

  gate.release()
  await settle(harness, 2)
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  const routes = (harness.settings.doc.allowedModels ?? []).map(route => `${route.provider}/${route.model}`).sort()
  assert.deepEqual(routes, ['p/m1', 'p/m2'],
    'both grants survive: a later picker instance never drops an earlier one\'s route')
})

test('C2-R3/F3: a backend that goes stale while the write waits REJECTS instead of settling success', async () => {
  // The picker checks writability when the user acts, but the request may wait
  // behind another queued write. If the backend became non-current by then, the
  // write must NOT run — and the settlement must be a diagnosable failure, not a
  // resolved success that leaves the picker silently rolled back.
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const gate = harness.settings.gateNextWrite()
  const menu = allowlistRow.submenu('0 routes', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // catalog settles

  menu.handleInput(ENTER) // first route: HELD
  for (let i = 0; i < 8 && harness.settings.writes.length < 1; i += 1) await Promise.resolve()
  assert.equal(harness.settings.writes.length, 1)

  menu.handleInput('\x1b[B')
  menu.handleInput(ENTER) // second route: queued behind the held one
  await Promise.resolve()

  // The backend stops being current WHILE the queued write waits.
  ;(harness.runner.config as unknown as { configReadiness: () => string }).configReadiness = () => 'stale'
  gate.release()
  await settle(harness, 1)
  for (let i = 0; i < 12; i += 1) await Promise.resolve()

  assert.equal(harness.settings.writes.length, 1,
    'the queued write never reached the Host once the backend was not current')
  const refusal = harness.notices.find(notice => /not current|were not changed|could not be read/u.test(notice.message))
  assert.ok(refusal !== undefined,
    `the refusal must be diagnosable, got ${JSON.stringify(harness.notices)}`)
  assert.equal(refusal?.kind, 'error', 'a non-current refusal is an error, not silent success')
})

test('C2-R3/F4: an UNREADABLE official section is never treated as off + empty', async () => {
  // The Direct adapter used to swallow a throwing `current()` into the shipped
  // default `{enabled:false, allowedModels:[]}`. Writing that back would erase the
  // stored routes, and re-reading it would report a Verified the Host never made.
  const harness = makeHarness({ enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const menu = allowlistRow.submenu('1 route', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve()

  // Let the toggle write, but make the official READ throw before the write.
  const selection = harness.runner.ctx.get('subagentModelSelection') as unknown as { current(): unknown }
  const originalCurrent = selection.current
  let throwNow = false
  selection.current = () => {
    if (throwNow) throw new Error('official section read failed')
    return originalCurrent.call(selection)
  }

  throwNow = true
  menu.handleInput(ENTER) // toggle the route OFF while the read is broken
  await settle(harness, 0)
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  // The picker's failure branch re-syncs AFTER the rejection: keep the broken
  // read in place until that chain has fully drained, then restore it so no
  // stray rejection escapes the test.
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  throwNow = false
  await Promise.resolve()

  assert.equal(harness.settings.writes.length, 0,
    'an unreadable section performs ZERO writes: the shipped default is not the stored value')
  assert.deepEqual(harness.settings.doc.allowedModels, [{ provider: 'p', model: 'm1' }],
    'the stored route was never erased by a fabricated default')
})

test('C2-R3/EXT-3: a section that becomes UNAVAILABLE reverts the toggle to its displayed value, not a fabricated off', async () => {
  // The Direct adapter answers an ABSENT service with the shipped default
  // instead of throwing. That default is NOT a readable state: it may not become
  // the rollback target, or a user who had `on` would be left displaying `off`.
  const harness = makeHarness({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] })
  await openSettingsPanel(harness)
  const rowsBefore = harness.settingsItems!.map(item => item.id)
  assert.ok(rowsBefore.includes('subagent-model-selection'), 'the toggle row was built while the section was available')

  // Replace the WHOLE section with the absent-service shape BEFORE the toggle:
  // `available()` false, and `get()` answers the shipped default exactly like
  // DirectSubagentModelSelectionConfig does with no service mounted.
  const config = harness.runner.config as unknown as { subagentModelSelection: unknown }
  const real = config.subagentModelSelection
  config.subagentModelSelection = {
    available: () => false,
    get: () => ({ enabled: false, allowedModels: [] }),
    set: async () => { throw new Error('settings service unavailable') },
  }

  const reverted: string[] = []
  const change = harness.settingsChange!
  change('subagent-model-selection', 'off', (previous) => { reverted.push(previous) })
  await settle(harness, 0)
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  config.subagentModelSelection = real

  assert.equal(harness.settings.writes.length, 0, 'an unavailable section dispatches ZERO writes')
  // Reading the shipped default here would revert to `off`.
  assert.deepEqual(reverted, ['on'], 'the row reverts to its DISPLAYED value (on), never a fabricated off')
  const refusal = harness.notices.find(notice => /could not be read|not current|unavailable/u.test(notice.message))
  assert.ok(refusal !== undefined, `the refusal reaches the user: ${JSON.stringify(harness.notices)}`)
  assert.equal(refusal?.kind, 'error')
})

test('C2-R3/EXT-4: a picker that could not read the section never reports an invented summary', async () => {
  // With an unreadable section the picker starts empty; an optimistic toggle is
  // then refused by the queue. Closing must NOT report `1 route`/`0 routes` as if
  // the Host stored that — the outer row keeps its own authoritative value.
  const harness = makeHarness({ enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')

  const selectionService = harness.runner.ctx.get('subagentModelSelection') as unknown as { current(): unknown }
  const originalCurrent = selectionService.current
  selectionService.current = () => { throw new Error('official section read failed') }

  const dones: Array<string | undefined> = []
  const menu = allowlistRow.submenu('1 route', (selected) => { dones.push(selected) }) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  menu.handleInput(ENTER) // optimistic toggle: refused by the unreadable guard
  await settle(harness, 0)
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  menu.handleInput('\x1b') // close
  selectionService.current = originalCurrent

  assert.equal(harness.settings.writes.length, 0, 'the unreadable section dispatched zero writes')
  assert.deepEqual(dones, [undefined],
    'closing reports NO summary: an unread marker is never presented as stored fact')
  assert.equal(allowlistRow.currentValue, '1 route',
    'the outer row keeps its own authoritative value instead of an invented one')
})

test('closing the WHOLE settings panel disposes the allowlist submenu (no late toast, row converges)', async () => {
  // The outer-teardown scenario: the allowlist submenu is open with a write
  // pending, and the user closes the ENTIRE /settings panel. The submenu must
  // be disposed with the panel: the pending write settling afterwards neither
  // toasts nor repaints, and the captured row's displayed summary converges to
  // the COMMITTED state through `summarize` (the fork would reject a late
  // `done`).
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const menu = allowlistRow.submenu!('0 routes', () => {}) as { handleInput(data: string): void }
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // let provider discovery settle
  harness.settings.failNextWrite()
  menu.handleInput(ENTER) // toggle the highlighted model ON — this write will FAIL
  // Close the whole panel while the write is still pending.
  const cancel = harness.onCancel
  assert.ok(cancel !== undefined, 'the panel onCancel must be captured')
  cancel()
  // Count repaints scheduled by the LATE settle only (after the panel closed).
  let renders = 0
  const originalRender = harness.app.requestRender.bind(harness.app)
  harness.app.requestRender = () => { renders += 1; originalRender() }
  await settle(harness, 1)
  assert.equal(harness.notices.length, 0, 'a failure settling after the panel closed stays silent')
  assert.equal(renders, 0, 'a settle after the WHOLE panel closed must not schedule a repaint')
  assert.equal(allowlistRow.currentValue, '0 routes',
    'the outer row still converges to the COMMITTED summary through the summarize seam')
})

test('a real SettingsList converges the outer row after Esc + a late rejected write', async () => {
  // The fork SettingsList invalidates a submenu callback once the submenu
  // closed (its submenu generation guard), so the post-close convergence MUST
  // go through `summarize`. This drives the REAL SettingsList mount end to
  // end: open the allowlist submenu via the outer list, toggle with a
  // deferred rejected write, Esc back to the list, then let the write settle.
  const harness = makeHarness({ enabled: false, allowedModels: [] }, { realSettings: true })
  await openSettingsPanel(harness)
  await harness.vt.waitForRender()
  // Filter the outer list to the allowlist row, then open its submenu.
  harness.vt.sendInput('allowed models')
  await harness.vt.waitForRender()
  harness.vt.sendInput(ENTER)
  await harness.vt.waitForRender()
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // provider discovery settles
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow !== undefined, 'the allowlist row must exist')
  harness.settings.failNextWrite()
  harness.vt.sendInput(ENTER) // toggle the highlighted model ON — this write FAILS
  harness.vt.sendInput('\x1b') // Esc closes the SUBMENU through the real SettingsList
  await harness.vt.waitForRender()
  await settle(harness, 1)
  assert.equal(harness.notices.length, 0, 'a failure settling after the submenu closed stays silent')
  assert.equal(allowlistRow.currentValue, '0 routes',
    'the real SettingsList row must converge to the COMMITTED summary after the late rejection')
  await harness.vt.waitForRender()
  assert.ok(harness.vt.getViewport().join('\n').includes('0 routes'),
    `the OUTER rendered row must show the committed summary:\n${harness.vt.getViewport().join('\n')}`)
})

test('a fullscreen teardown suppresses the late allowlist settle repaint', async () => {
  // A fullscreen screen swap removes the whole /settings overlay WITHOUT
  // invoking its onCancel. The teardown-aware `onHidden` hook must flip the
  // mounted state so a late allowlist write settle does not schedule a
  // repaint of the removed surface.
  const harness = makeHarness({ enabled: false, allowedModels: [] }, { realSettings: true })
  await openSettingsPanel(harness)
  await harness.vt.waitForRender()
  harness.vt.sendInput('allowed models')
  await harness.vt.waitForRender()
  harness.vt.sendInput(ENTER) // open the submenu
  await harness.vt.waitForRender()
  for (let i = 0; i < 8; i += 1) await Promise.resolve() // provider discovery settles
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow !== undefined, 'the allowlist row must exist')
  const gate = harness.settings.gateNextWrite() // hold the allowlist write pending
  harness.vt.sendInput(ENTER) // toggle the highlighted model ON — the write is held
  harness.app.setFullscreen(true) // tears the settings overlay down without onCancel
  await harness.vt.waitForRender()
  let renders = 0
  const originalRender = harness.app.requestRender.bind(harness.app)
  harness.app.requestRender = () => { renders += 1; originalRender() }
  gate.release() // the held write settles only after the teardown
  await settle(harness, 1)
  // The picker's own chain needs one more microtask turn after the section
  // write settles before it re-syncs the row summary.
  for (let i = 0; i < 8 && allowlistRow.currentValue !== '1 route'; i += 1) await Promise.resolve()
  assert.equal(harness.notices.length, 0, 'a settle after a fullscreen teardown stays silent')
  assert.equal(renders, 0, 'a settle after a fullscreen teardown must not schedule a repaint')
  assert.equal(allowlistRow.currentValue, '1 route', 'the detached row still converges for bookkeeping')
  harness.app.setFullscreen(false)
  await harness.vt.waitForRender()
})

test('/settings announces a non-current config backend instead of presenting last-known values as current', async () => {
  // §9.1: a backend whose config reads are not current must SAY so. The rows
  // still show the last-known values (that is the documented disposition), so
  // the panel carries the explicit non-current notice. ONE harness per test:
  // the process allows a single live TuiApp.
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  ;(harness.runner.config as unknown as { configReadiness: () => string }).configReadiness = () => 'stale'
  await openSettingsPanel(harness)
  const notice = harness.notices.find(entry => /not current \(reconnecting\)/u.test(entry.message))
  assert.ok(notice !== undefined, `the panel must announce the non-current backend:\n${harness.notices.map(n => n.message).join('\n')}`)
  assert.equal(notice.kind, 'error')
})

test('/settings announces a disconnected config backend as unavailable', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  ;(harness.runner.config as unknown as { configReadiness: () => string }).configReadiness = () => 'unavailable'
  await openSettingsPanel(harness)
  assert.ok(
    harness.notices.some(entry => /configuration backend is unavailable/u.test(entry.message)),
    'a disconnected config backend is announced as unavailable',
  )
  // The harness has no settings document, so the rows show the panel's
  // BUILT-IN defaults: the notice must not call those "last known" Host values.
  assert.ok(
    harness.notices.some(entry => /built-in defaults, not Host values/u.test(entry.message)),
    'without a Host document the notice says so instead of claiming last-known values',
  )
})

test('/settings stays silent when the config backend is current', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  assert.equal(harness.notices.filter(entry => /not current|unavailable/u.test(entry.message)).length, 0,
    'a ready backend raises no false alarm (Direct is always ready)')
})

test('/settings omits the approval-policy row on a backend that cannot read or write it', async () => {
  // §9.2/§10: the Remote backend cannot read or write the independent session
  // approval override, so the row must be OMITTED. Rendering the consumer's own
  // `ask` default would present an unavailable policy as a real one.
  // A live session scope is required for the row to even be considered.
  const harness = makeHarness({ enabled: false, allowedModels: [] }, { liveAgent: LIVE_AGENT })
  ;(harness.runner.config.permissions as unknown as { approvalOverrideAvailable: () => boolean })
    .approvalOverrideAvailable = () => false
  await openSettingsPanel(harness)
  const ids = (harness.settingsItems ?? []).map(item => item.id)
  assert.ok(!ids.includes('approval'), `the approval row must be omitted:\n${ids.join(', ')}`)
})

test('/settings keeps the approval-policy row where the capability exists', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [] }, { liveAgent: LIVE_AGENT })
  await openSettingsPanel(harness)
  const ids = (harness.settingsItems ?? []).map(item => item.id)
  assert.ok(ids.includes('approval'), `the approval row must stay on a capable backend:\n${ids.join(', ')}`)
})
