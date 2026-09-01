/**
 * Regression for the /settings "Subagent model selection" toggle row
 * (review round 2): rapid toggles must SERIALIZE their official-section
 * writes (a slow earlier write can never land after a newer one), every
 * settle re-syncs the row to the ACTUAL committed state, and a rejected
 * write rolls the row back with a notice.
 * @module @xmoon76/dsh-pi-tui/subagent-model-settings-row.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
  service: { get(ns: string): unknown; mutate(ns: string, ops: unknown): Promise<unknown> }
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
      get: (ns: string) => (ns === 'subagent-model-selection' ? doc : undefined),
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

function makeHarness(initial: SettingsDoc): {
  runner: TuiCommandRunner
  app: TuiApp
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
  const { defs, service: commandsService } = fakeCommands()
  ctx.provide('commands', commandsService as never)
  const settings = settingsService(initial)
  ctx.provide('settings', settings.service as never)
  ctx.provide('subagentModelSelection', {} as never)
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
  app.openSettings = ((...args: Parameters<TuiApp['openSettings']>) => {
    settingsItems = args[0]
    settingsChange = args[1]
    onCancel = args[2]
    return () => {}
  }) as TuiApp['openSettings']
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: { warn: () => {}, error: () => {}, info: () => {} } as never,
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    agents: {} as never,
    sessionReader: { list: async () => [], search: async () => [], projectionBatch: async () => new Map(), measureContext: () => undefined, readExportData: async () => ({ kind: 'none' }) },
    sessionWriter: { followup: () => {}, steer: () => {}, dequeue: () => {}, cancel: () => {}, rename: () => true, refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }) },
    interaction: { registerQuestionProvider: () => true, onApprovalRequest: () => {}, setApprovalPolicy: () => true },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    hostFile: new DirectHostFilePort(() => undefined),
    commandRegistry: ctx.get('commands') as never,
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: {} as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
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
    applyFooterSettings: () => {},
  }
  registerTuiCommands(runner)
  // The captured panel args are read through GETTERS: the mock assigns the
  // outer variables when the handler runs, so a value snapshot taken at
  // harness construction would stay undefined.
  return {
    runner,
    app,
    settings,
    defs,
    get settingsChange() { return settingsChange },
    get settingsItems() { return settingsItems },
    get onCancel() { return onCancel },
    notices,
  }
}

/** Open the /settings panel through the registered command. */
async function openSettingsPanel(harness: ReturnType<typeof makeHarness>): Promise<void> {
  const settings = harness.defs.find(entry => entry.name === 'settings')
  assert.ok(settings?.handler !== undefined, 'the settings command must be registered')
  await (settings.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
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

test('a rejected toggle rolls the row back and notifies', async () => {
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const change = harness.settingsChange!
  const reverted: string[] = []
  // Enabling with an EMPTY allowlist is refused by the official rule.
  change('subagent-model-selection', 'on', (previous) => { reverted.push(previous) })
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  assert.equal(harness.settings.doc.enabled, false, 'the section stays off')
  assert.deepEqual(reverted, ['off'], 'the row display rolls back to the previous value')
  assert.equal(harness.notices.at(-1)?.kind, 'error')
  assert.match(harness.notices.at(-1)?.message ?? '', /requires at least one allowed model/u)
})

test('closing the WHOLE settings panel disposes the allowlist submenu (no late toast, row converges)', async () => {
  // The review's outer-teardown scenario: the allowlist submenu is open
  // with a write pending, and the user closes the ENTIRE /settings panel
  // (Esc -> the panel's onCancel). The submenu must be disposed with the
  // panel: the pending write settling afterwards neither toasts nor
  // repaints, and the outer row still converges to the committed summary.
  const harness = makeHarness({ enabled: false, allowedModels: [] })
  await openSettingsPanel(harness)
  const allowlistRow = harness.settingsItems!.find(item => item.id === 'subagent-model-allowlist')
  assert.ok(allowlistRow?.submenu !== undefined, 'the allowlist row must carry the submenu')
  const dones: Array<string | undefined> = []
  const menu = allowlistRow.submenu!('0 routes', (selected) => { dones.push(selected) }) as { handleInput(data: string): void }
  menu.handleInput(ENTER) // open the provider's models
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  harness.settings.failNextWrite()
  menu.handleInput(ENTER) // toggle m1 ON — this write will FAIL
  // Close the whole panel while the write is still pending.
  const cancel = harness.onCancel
  assert.ok(cancel !== undefined, 'the panel onCancel must be captured')
  cancel()
  await settle(harness, 1)
  assert.equal(harness.notices.length, 0, 'a failure settling after the panel closed stays silent')
  assert.deepEqual(dones.at(-1), '0 routes', 'the outer row converges to the COMMITTED summary')
})
