/**
 * M4 PR4 RFL-007 regression — the rewind picker selection is an accepted
 * session mutation whose pre-fork `loadThrough` Host read runs AFTER the
 * `/rewind` handler returned and BEFORE `forkSession`/`trackFork`. The fix
 * registers the ONE controller-owned accepted-write lifetime in the selection
 * adoption callback (the REAL `application-events` owner) and releases it in
 * `finally` at the whole rewind task's settlement.
 *
 * The test drives the REAL surface:
 * - the REAL `createApplicationEvents` owner and its `openRewindPicker`
 *   selection callback (the REAL `app.openPicker` seam captured),
 * - a held `deps.rewind.loadThrough` (the pre-fork window) and a held
 *   `forkSession` (the post-fork window),
 * - the REAL `SubmissionController` lifetime via the public `beginClientWrite`
 *   seam and the REAL `createClientReloadCommandRequest` gate,
 * - the REAL `/reload-client` handler/notice.
 *
 * Asserts: during `loadThrough` the lifetime is open and `hasPendingForks`
 * (probed by the fork owner) is still false; reload is refused; the fork then
 * starts and the reload stays refused; after settlement the lifetime releases,
 * the fork ran exactly once and the next reload is accepted. Every terminal
 * path (undefined, throw, abort, superseded, fork error) releases; picker
 * cancellation registers NOTHING.
 *
 * @module @xmoon76/dsh-pi-tui/client-reload-rewind-picker.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { createApplicationEvents, type ApplicationEventsDeps } from '../../src/app/surface/application-events.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createClientReloadCommandRequest } from '../../src/app/command/client-reload.ts'
import { registerReloadClientCommand, CLIENT_RELOAD_REFUSAL_NOTICES } from '../../src/tui/commands/utility.ts'
import { createClientReloadLifetimeOwner } from '../support/client-reload-lifetime-owner.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { runOwned as runOwnedReal, type OwnedTaskOptions } from '../../src/runtime/process/tasks.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import type { SessionForkOutcome } from '../../src/app/session/runtime.ts'

type TerminalMode = 'success' | 'undefined' | 'throw' | 'abort' | 'superseded' | 'fork-error'

function event(type: string, data: Record<string, unknown>, seq: number): never {
  return { type, seq: SessionSeq(seq), time: 1, data } as never
}

/** Two completed human turns: the row value 6 is turn 2's start; its
 *  candidate forks at the first turn/end (seq 5) and restores prompt B. */
function loadedWindow(): readonly never[] {
  return [
    event('turn/start', { turn: 1 }, 0),
    event('user/message', { id: MessageId('u-1'), role: 'user', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } }, 2),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    event('turn/start', { turn: 2 }, 6),
    event('user/message', { id: MessageId('u-2'), role: 'user', content: [{ type: 'text', text: 'B' }], source: { kind: 'user' } }, 8),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 11),
  ]
}

interface Harness {
  readonly controller: ReturnType<typeof createClientReloadLifetimeOwner>['controller']
  readonly notices: Array<{ text: string; kind: string | undefined }>
  readonly draft: { value: string }
  readonly forkCalls: { value: number }
  readonly forkAtSeq: { value: number | undefined }
  readonly forkPending: { value: boolean }
  open(): void
  select(value: string): void
  cancel(): void
  resolveLoad(): void
  rejectLoad(error: unknown): void
  resolveFork(outcome: SessionForkOutcome): void
  readonly requests: number
  reload(): Promise<{ kind: string; text?: string }>
  drain(): Promise<void>
}

function setup(mode: TerminalMode): Harness {
  const owner = createClientReloadLifetimeOwner()
  const notices: Array<{ text: string; kind: string | undefined }> = []
  const draft = { value: '' }
  const forkCalls = { value: 0 }
  const forkAtSeq: { value: number | undefined } = { value: undefined }
  const forkPending = { value: false }
  let picker: { onSelect: (value: string) => void; onCancel: () => void } | undefined
  const app = {
    getDraft: () => draft.value,
    setDraft: (text: string) => { draft.value = text },
    setEditorText: (text: string) => { draft.value = text },
    notify: (text: string, kind?: string) => { notices.push({ text, kind }) },
    openPicker: (rows: unknown, onSelect: (value: string) => void, onCancel: () => void) => {
      assert.ok(Array.isArray(rows) && rows.length === 1, 'the real outline produced exactly one rewind row')
      picker = { onSelect, onCancel }
    },
  }
  let resolveLoad!: () => void
  let rejectLoadGate!: (error: unknown) => void
  const loadGate = new Promise<void>((resolve, reject) => { resolveLoad = resolve; rejectLoadGate = reject })
  let resolveFork!: (outcome: SessionForkOutcome) => void
  const forkGate = new Promise<SessionForkOutcome>(resolve => { resolveFork = resolve })
  const controller = new AbortController()
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  const owned: Promise<void>[] = []

  const deps = {
    submission: owner.controller,
    viewer: {}, status: {}, settings: {}, subagentDelivery: {},
    surface: {
      app,
      get composer() { return { getDraft: () => draft.value } },
      handleTerminalFocus: () => {},
      noteUserInput: () => {},
      openTasksBrowser: () => {},
    },
    client: { readClipboardImage: async () => ({ kind: 'unavailable' }) },
    drafts: { images: new DraftImageStore(), files: new DraftFileStore() },
    imageLimits: () => undefined,
    lifecycle: {
      runOwned: <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag'> | undefined): void => {
        let taskPromise: Promise<T>
        try {
          taskPromise = Promise.resolve(task())
        } catch (error) {
          taskPromise = Promise.reject(error)
        }
        runOwnedReal(label, () => taskPromise, { ...options, diag })
        owned.push(taskPromise.then(() => undefined, () => undefined))
      },
      isCleanedUp: () => false,
      requestExit: () => {},
      liveAgent: () => ({ session: { id: 'session-a' } }),
      generation: () => 1,
      currentSessionId: () => 'session-a',
      navigationEpoch: () => 0,
      signal: () => controller.signal,
    },
    rewind: {
      turnOutline: () => [
        { turn: 1, seq: 0, prompt: 'A', response: 'a' },
        { turn: 2, seq: 6, prompt: 'B', response: 'b' },
      ],
      captureSelectionIdentity: () => ({}),
      isSelectionCurrent: () => mode !== 'superseded',
      loadThrough: () => {
        if (mode === 'undefined') {
          return Promise.resolve(undefined)
        }
        return loadGate.then(() => loadedWindow())
      },
      forkSession: (_source: string, atSeq: number, onAdopted: () => void): Promise<SessionForkOutcome> => {
        forkCalls.value += 1
        forkAtSeq.value = atSeq
        forkPending.value = true
        const pending = forkGate.then(outcome => {
          forkPending.value = false
          if (outcome.kind === 'success') onAdopted()
          return outcome
        })
        return pending
      },
      isNavigationCurrent: () => mode !== 'superseded',
    },
  } as unknown as ApplicationEventsDeps
  const ownerEvents = createApplicationEvents(deps)
  const registry = createClientCommandRegistry(parseCommand)
  let requests = 0
  const gate = createClientReloadCommandRequest({
    facts: {
      capable: () => true,
      ready: () => true,
      draftText: () => draft.value,
      stagedImageCount: () => 0,
      stagedFileCount: () => 0,
      hasUnsettledUserWrite: () => owner.controller.hasUnsettledClientWrite(),
      hasUnsettledInteraction: () => false,
      hasUnsettledTransition: () => forkPending.value,
    },
    request: () => {
      requests += 1
      return { kind: 'accepted' }
    },
  })
  registerReloadClientCommand({
    runner: { requestClientReload: gate },
    registerTuiCommand: (spec) => { registry.register({ name: spec.name, description: spec.description, handler: spec.handler }) },
    recordCommandDraftDisposition: () => {},
  })
  const reloadCommand = registry.get('reload-client')
  assert.ok(reloadCommand !== undefined)
  return {
    controller: owner.controller,
    notices,
    draft,
    forkCalls,
    forkAtSeq,
    forkPending,
    open: () => ownerEvents.openRewindPicker(),
    select: (value) => {
      assert.ok(picker !== undefined, 'the real rewind picker opened')
      picker.onSelect(value)
    },
    cancel: () => {
      assert.ok(picker !== undefined)
      picker.onCancel()
    },
    resolveLoad: () => {
      if (mode === 'abort') {
        rejectLoadGate(new DOMException('aborted', 'AbortError'))
        return
      }
      resolveLoad()
    },
    rejectLoad: (error) => { rejectLoadGate(error) },
    resolveFork: (outcome) => { resolveFork(outcome) },
    get requests() { return requests },
    reload: async () => await (reloadCommand.handler as unknown as (i: { commandId: string; rawInput: string; signal: AbortSignal }) => { kind: string; text?: string })({
      commandId: 'cmd-reload',
      rawInput: '',
      signal: controller.signal,
    }),
    drain: async (): Promise<void> => {
      for (const task of owned) await task
      for (let index = 0; index < 200; index += 1) await Promise.resolve()
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the rewind lifetime/gate')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('the rewind selection holds the reload gate from loadThrough through the fork settlement', async () => {
  const harness = setup('success')
  harness.open()
  harness.select('6')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true, 'the selection registers synchronously')
  assert.equal(harness.forkPending.value, false, 'no fork is pending during the pre-fork read')
  assert.equal(harness.forkCalls.value, 0)

  const preForkRefusal = await harness.reload()
  assert.equal(preForkRefusal.kind, 'error')
  assert.equal(preForkRefusal.text, CLIENT_RELOAD_REFUSAL_NOTICES.submission)
  assert.equal(harness.requests, 0)

  harness.resolveLoad()
  await waitFor(() => harness.forkCalls.value === 1)
  assert.equal(harness.forkAtSeq.value, 5, 'the candidate forks at the predecessor turn end')
  assert.equal(harness.forkPending.value, true)
  assert.equal(harness.controller.hasUnsettledClientWrite(), true, 'the lifetime covers the fork too')

  const forkRefusal = await harness.reload()
  assert.equal(forkRefusal.kind, 'error')
  assert.equal(forkRefusal.text, CLIENT_RELOAD_REFUSAL_NOTICES.submission)
  assert.equal(harness.requests, 0)

  harness.resolveFork({ kind: 'success', adoptedNavigation: { sessionId: 'session-a', navigationEpoch: 1 } })
  await waitFor(() => !harness.controller.hasUnsettledClientWrite())
  assert.equal(harness.draft.value, 'B', 'the adoption restored the exact prompt')
  assert.equal(harness.forkCalls.value, 1, 'no duplicate fork')
  assert.equal(harness.notices.some(notice => notice.text === 'rewound to turn 2'), true)

  // The restored prompt is real unsent input: the gate refuses for the draft
  // while the rewind lifetime is already released. Clear it (the user's edit)
  // and the SAME gate accepts.
  const draftRefusal = await harness.reload()
  assert.equal(draftRefusal.kind, 'error')
  assert.equal(draftRefusal.text, CLIENT_RELOAD_REFUSAL_NOTICES['draft-text'])
  harness.draft.value = ''
  const accepted = await harness.reload()
  assert.equal(accepted.kind, 'success')
  assert.equal(harness.requests, 1)
  assert.equal(harness.controller.hasUnsettledClientWrite(), false, '/reload-client never counts itself')
})

test('every rewind terminal path releases the lifetime; picker cancellation registers nothing', async () => {
  for (const mode of ['undefined', 'throw', 'abort', 'superseded', 'fork-error'] as const) {
    const harness = setup(mode)
    harness.open()
    harness.select('6')
    assert.equal(harness.controller.hasUnsettledClientWrite(), true, `${mode}: registered at acceptance`)
    if (mode === 'throw') {
      harness.rejectLoad(new Error('loadThrough failed'))
    } else if (mode === 'undefined') {
      // loadThrough resolves undefined immediately.
    } else if (mode === 'superseded') {
      harness.resolveLoad()
    } else if (mode === 'abort') {
      harness.resolveLoad()
    } else {
      harness.resolveLoad()
      await waitFor(() => harness.forkCalls.value === 1)
      harness.resolveFork({ kind: 'error', reason: 'fork-failed' as never, text: 'fork failed', notificationNavigation: { sessionId: 'session-a', navigationEpoch: 0 } })
    }
    await harness.drain()
    await waitFor(() => !harness.controller.hasUnsettledClientWrite())
    const accepted = await harness.reload()
    assert.equal(accepted.kind, 'success', `${mode}: no leaked lifetime`)
    assert.equal(harness.forkCalls.value <= 1, true, `${mode}: never repeats the fork`)
    assert.equal(harness.draft.value, '', `${mode}: no erroneous editor restoration`)
    assert.equal(harness.notices.some(notice => notice.text.startsWith('rewound to turn')), false,
      `${mode}: no success settlement on a failed/superseded rewind`)
  }

  const cancelled = setup('success')
  cancelled.open()
  cancelled.cancel()
  assert.equal(cancelled.controller.hasUnsettledClientWrite(), false, 'a cancelled picker is not an accepted action')
  const accepted = await cancelled.reload()
  assert.equal(accepted.kind, 'success')
  assert.equal(cancelled.forkCalls.value, 0)
})
