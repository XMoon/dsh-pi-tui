/**
 * Orchestration regression for the session-title loader behind the
 * /sessions and /resume picker: every MAIN row the picker can display must
 * get a title read — including rows beyond any read window — while
 * SUBAGENT rows (never shown in the human session picker) must not be read
 * at all, and each main id must enter `sessionReader.titles()` exactly
 * once across the progressive batches.
 *
 * The regression pins the actual bug shape: the category scopes consume
 * the FULL row set, but the title loader used to walk only the first
 * MAX_PICKER_SESSIONS rows, so a displayed session beyond that window
 * (e.g. an old session in the "Current directory" scope) never got a
 * title and showed a bare short id forever.
 * @module @xmoon76/dsh-pi-tui/session-picker-titles.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** Poll `predicate` until true or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

/** A session id with a deterministic createdAt so sort order is stable. */
function row(id: string, createdAt: number): import('../src/sessions.ts').SessionPickerRow {
  return { id, createdAt, cwd: '/ws/project-a', live: false }
}

test('the picker title loader covers EVERY main row beyond the legacy window, and never reads subagents', async (t) => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  // Clean up even when an assertion / waitUntil timeout aborts the test.
  t.after(() => app.stop())

  // 250 main rows + 5 subagent rows; newest-first by createdAt. The
  // subagents would appear inside the first 200 rows, so a title loader
  // that (wrongly) capped at MAX_PICKER_SESSIONS would read them AND skip
  // main rows #201-#249.
  const rows = [
    { ...row('session-s000', 1_000_000 - 5), origin: 'subagent' as const },
    ...Array.from({ length: 250 }, (_, i) => row(`session-m${String(i).padStart(3, '0')}`, 1_000_000 - 6 - i)),
    { ...row('session-s001', 1_000_000 - 300), origin: 'subagent' as const },
    { ...row('session-s002', 1_000_000 - 500), origin: 'subagent' as const },
    { ...row('session-s003', 1_000_000 - 700), origin: 'subagent' as const },
    { ...row('session-s004', 1_000_000 - 900), origin: 'subagent' as const },
  ]

  // Record every id handed to sessionReader.titles, across all batches.
  // A Map counter (not a Set) so a duplicated id fails the exactly-once
  // assertions below instead of being silently deduped.
  const counts = new Map<string, number>()
  const batchLog: number[] = []
  const sessionReader = {
    list: async () =>
      [...rows]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ id, createdAt, cwd, origin }) => ({ id, createdAt, cwd, origin, live: false })),
    search: async () => [],
    titles: async (batch: readonly { id: string }[]) => {
      batchLog.push(batch.length)
      for (const { id } of batch) counts.set(id, (counts.get(id) ?? 0) + 1)
      // Every requested id gets a title; the relevant assertion is WHICH
      // ids were requested, not the map contents.
      return new Map(batch.map(({ id }) => [id, `title-of-${id}`]))
    },
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  }

  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {
        const i = defs.indexOf(def)
        if (i !== -1) defs.splice(i, 1)
      }
    },
    list: () => defs.map(({ name }) => ({ name, description: 'registered' })),
    find: () => undefined,
    execute: async () => undefined,
  }
  ctx.provide('commands', commands as never)

  const state: { agent: Agent | undefined } = { agent: undefined }
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return state.agent },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    agents: {} as never,
    sessionReader: sessionReader as never,
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as never,
    hostFile: new DirectHostFilePort(() => undefined),
    requestExit: () => {},
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 1 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { create: () => Promise<T> }) => ({ ok: true, next: await steps.create() }),
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
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
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommands(runner)

  const def = defs.find(entry => entry.name === 'sessions')
  assert.ok(def?.handler !== undefined, 'sessions handler missing')
  await (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => unknown)({
    commandId: CommandId('cmd-test-1'),
    agent: undefined as never,
    rawInput: '',
    signal: new AbortController().signal,
  })

  // The title loader runs detached; poll until every main row was handed
  // to sessionReader.titles (the old impl would block at 200 and time out).
  await waitUntil(() => counts.size >= 250)

  // Every main row exactly once, across the progressive batches.
  for (let i = 0; i < 250; i++) {
    const id = `session-m${String(i).padStart(3, '0')}`
    assert.equal(counts.get(id), 1, `main row ${id} must be read exactly once (old impl capped at 200)`)
  }
  assert.equal(counts.size, 250, 'only the 250 main rows may be read')
  assert.equal(Array.from(counts.values()).reduce((a, b) => a + b, 0), 250, 'no main id may be read twice')
  const subagentCounts = Array.from(counts.entries()).filter(([id]) => id.startsWith('session-s'))
  assert.deepEqual(subagentCounts, [], 'subagent rows must never reach the title reader')
  // Progressive batching: first batch ≤ TITLE_FIRST_BATCH, later batches ≤
  // TITLE_BATCH_SIZE, and every batch is non-empty.
  assert.ok(batchLog.length >= 5, `expected several batches, got ${batchLog.length}`)
  assert.ok(batchLog[0]! <= 20, `first batch must be ≤ TITLE_FIRST_BATCH, got ${batchLog[0]}`)
  for (const size of batchLog) assert.ok(size > 0 && size <= 50, `batch size ${size} out of range`)
  assert.equal(batchLog.reduce((a, b) => a + b, 0), 250, 'the batch sizes must sum to exactly the 250 main rows')
})