/**
 * The Busy Esc / extension `cancel-activity` entry must use the session
 * CONTROL admission, not an ordinary writer admission: while a navigation
 * transition has frozen the writer barrier and an already-admitted writer is
 * still in flight, the interrupt must still reach its captured owner and must
 * not produce a misclassified `agent interrupt` ERROR.
 *
 * The exact-owner/backend-cancel contract is proven by the session-runtime and
 * Direct/Remote owner suites; this case proves the production user-shell wiring
 * chooses the control entry and settles it silently on `committed`.
 * @module @xmoon76/dsh-pi-tui/interrupt-control-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserShell } from '../../src/app/submission/user-shell.ts'
import { createExitIntentFacts } from '../../src/app/bootstrap/exit-facts.ts'
import { createExitIntentCoordinator } from '../../src/app/bootstrap/exit-intent.ts'
import type { ExitChoiceModel } from '../../src/app/surface/exit-choice.ts'
import type { SessionScope } from '../../src/app/session/scope.ts'
import { HostUserShellOutcomeUnknownError } from '../../src/runtime/host-user-shell-port.ts'
import { SessionOperationBarrier } from '../../src/app/session/operation-barrier.ts'
import type { InterruptAgentLike } from '../../src/app/session/interrupt.ts'
import type { LiveSessionScope } from '../../src/app/session/scope.ts'
import type { TuiApp } from '../../src/tui-app.ts'

test('a started Host Shell transport loss leaves a visible no-retry card and no Session write', async () => {
  const scope = { sessionId: 'session-a' } as unknown as LiveSessionScope
  const card = { kind: 'tool', turn: 0, name: 'shell', args: '', result: '', status: 'running' }
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  let settled!: () => void
  const cardSettled = new Promise<void>(resolve => { settled = resolve })
  let promptCalls = 0
  let shellCalls = 0
  const shell = createUserShell<InterruptAgentLike>({
    app: () => ({
      pushLocalMessage: (message: Parameters<TuiApp['pushLocalMessage']>[0]) => Object.assign(card, message),
      updateLocalMessage: (_current: Parameters<TuiApp['updateLocalMessage']>[0], message: Parameters<TuiApp['updateLocalMessage']>[1]) => {
        Object.assign(card, message)
        if (message.kind === 'tool' && message.status === 'error') settled()
        return card
      },
    }) as unknown as TuiApp,
    notify: () => {},
    diag: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      dispose: () => {},
    },
    isCleanedUp: () => false,
    liveAgent: () => undefined,
    ownership: { generation: () => 1 },
    session: {
      withWriter: async (_captured, task) => task(),
      interrupt: async () => ({ kind: 'committed' as const, value: undefined }),
    },
    requireLiveScope: () => scope,
    captureLiveScope: () => scope,
    isLiveScopeCurrent: () => true,
    writerSection: async (_captured, task) => task(),
    writer: {
      prompt: async () => { promptCalls += 1; return { kind: 'committed' as const, value: undefined } },
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId, title) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    status: { sessionCwd: () => '/host/session-a' },
    tuiSettings: undefined,
    shell: {
      availability: { supported: true, policies: ['bypass', 'sandbox'] },
      async execute() {
        shellCalls += 1
        throw new HostUserShellOutcomeUnknownError('Host shell result was lost after start')
      },
    },
    submission: { settleAck: () => {}, markDispatch: () => {} },
  })

  shell.run('!!printf disconnect', undefined, finish, { anchor: undefined, turn: undefined, target: 'beginning', acceptedOrder: 0 })
  await Promise.all([cardSettled, finished])
  assert.equal(shellCalls, 1, 'the user gesture made exactly one Host execution request')
  assert.equal(card.status, 'error')
  assert.match(card.result, /Host shell result was lost after start/u)
  assert.match(card.result, /command may have executed/u)
  assert.match(card.result, /do not retry automatically/u)
  assert.equal(promptCalls, 0, 'an unknown Host process outcome writes no Session result')
  shell.dispose()
})

 test('Busy Esc uses the control admission while a frozen transition drains a writer, without an agent interrupt ERROR', async () => {
  const barrier = new SessionOperationBarrier()
  const scope = { sessionId: 'session-a' } as unknown as LiveSessionScope
  const notices: string[] = []
  const errors: string[] = []
  let withWriterCalls = 0
  let writerCancelCalls = 0
  let interruptCalls = 0
  let markInterrupted!: () => void
  const interrupted = new Promise<void>(resolve => { markInterrupted = resolve })

  const shell = createUserShell<InterruptAgentLike>({
    app: () => ({}) as TuiApp,
    notify: (message, kind) => { notices.push(`${kind ?? 'info'}:${message}`) },
    diag: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => { errors.push(message) },
      dispose: () => {},
    },
    isCleanedUp: () => false,
    liveAgent: () => ({ session: { id: 'session-a' }, status: 'running', cancel: () => {} }),
    ownership: { generation: () => 1 },
    session: {
      withWriter: (_scope, task) => {
        withWriterCalls += 1
        return Promise.resolve().then(task)
      },
      // The production seam is SessionRuntime.interrupt; this harness routes
      // it through the REAL barrier control section so the freeze admission is
      // exercised too.
      interrupt: () => barrier.runControl(async () => {
        interruptCalls += 1
        markInterrupted()
        return { kind: 'committed' as const, value: undefined }
      }),
    },
    requireLiveScope: () => scope,
    captureLiveScope: () => scope,
    isLiveScopeCurrent: () => true,
    writerSection: (_scope, task) => task(),
    writer: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => {
        writerCancelCalls += 1
        return { kind: 'committed' as const, value: undefined }
      },
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    status: { sessionCwd: () => '/tmp' },
    tuiSettings: undefined,
    shell: {
      execute: async () => ({ kind: 'unavailable' as const, reason: new Error('not exercised') }),
    } as never,
    submission: { settleAck: () => {}, markDispatch: () => {} },
  })

  // A writer admitted BEFORE the navigation holds the barrier drain open; the
  // transition freezes synchronously and parks on that writer.
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  let transitionRan = false
  const writer = barrier.runWriter('session-a', async () => { await writerGate })
  const transition = barrier.runTransition(async () => { transitionRan = true })
  assert.equal(barrier.inTransition, true)
  assert.equal(barrier.activeWriters, 1)

  shell.interrupt()
  await interrupted
  // The barrier callback resolves before runOwned's result consumer runs;
  // flush that owned settlement before asserting the diagnostic sink (the
  // real runner/diag end-to-end proof lives in submit-hot-path's frozen-Esc
  // case). A wrong implementation that rejected would log through diag.error.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(interruptCalls, 1, 'the control interrupt reached the backend seam')
  assert.equal(withWriterCalls, 0, 'the interrupt never entered the ordinary writer admission')
  assert.equal(writerCancelCalls, 0, 'the session writer cancel is not the control path anymore')
  assert.equal(barrier.inTransition, true, 'the transition is still frozen')
  assert.equal(transitionRan, false, 'the interrupt did not shortcut the writer drain')
  assert.deepEqual(errors, [], 'a normally admitted interrupt must not emit an ERROR diagnostic')
  assert.deepEqual(notices, [], 'a committed interrupt is silent')

  releaseWriter()
  await writer
  await transition
  assert.equal(transitionRan, true, 'the transition still completes after the drain')
})

test('a running user shell keeps the exit options with a reminder and is never aborted by Stay', async () => {
  // External review P1 + Owner decision: a Client-owned `!`/`!!` shell is NOT
  // the Session Agent Turn. The real user-shell owner reports it running; the
  // choice keeps the normal exit options but carries the shell reminder, and a
  // Stay must neither exit nor abort the run. Only the user's own cancel (Esc)
  // ends it, after which a normal idle detach is possible again.
  const scope = { sessionId: 'session-a' } as unknown as LiveSessionScope
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const card = { kind: 'tool', turn: 0, name: 'shell', args: '', result: '', status: 'running' }
  let executeStarted = false
  let executeAborted = false
  const shell = createUserShell<InterruptAgentLike>({
    app: () => ({
      pushLocalMessage: (message: Parameters<TuiApp['pushLocalMessage']>[0]) => Object.assign(card, message),
      updateLocalMessage: (_current: Parameters<TuiApp['updateLocalMessage']>[0], message: Parameters<TuiApp['updateLocalMessage']>[1]) => {
        Object.assign(card, message)
        return card
      },
    }) as unknown as TuiApp,
    notify: () => {},
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    isCleanedUp: () => false,
    liveAgent: () => undefined,
    ownership: { generation: () => 1 },
    session: {
      withWriter: async (_captured, task) => task(),
      interrupt: async () => ({ kind: 'committed' as const, value: undefined }),
    },
    requireLiveScope: () => scope,
    captureLiveScope: () => scope,
    isLiveScopeCurrent: () => true,
    writerSection: async (_captured, task) => task(),
    writer: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    status: { sessionCwd: () => '/tmp' },
    tuiSettings: undefined,
    shell: {
      availability: { supported: true, policies: ['bypass', 'sandbox'] },
      async execute({ signal }) {
        executeStarted = true
        await new Promise<void>(resolve => {
          if (signal.aborted) { resolve(); return }
          signal.addEventListener('abort', () => { executeAborted = true; resolve() }, { once: true })
        })
        return {
          kind: 'settled' as const,
          result: {
            exit: { kind: 'signal' as const, signal: 'SIGTERM' },
            stdout: { text: '', truncated: false },
            stderr: { text: '', truncated: false },
            sandboxDenied: false,
            aborted: true,
            timedOut: false,
          },
        }
      },
    },
    submission: { settleAck: () => {}, markDispatch: () => {} },
  })

  shell.run('!!sleep 100', undefined, finish, { anchor: undefined, turn: undefined, target: 'beginning', acceptedOrder: 0 })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(executeStarted, true, 'the real Host shell admission started')
  assert.equal(shell.isRunning(), true)

  const facts = createExitIntentFacts({
    backend: () => 'daemon',
    scopes: {
      capture: () => scope as unknown as SessionScope,
      captureLive: () => scope,
      isCurrent: () => true,
    },
    admissionPending: () => false,
    shellRunning: () => shell.isRunning(),
    remote: {
      // The Agent itself is idle; the shell alone is the in-flight work.
      running: () => false,
      captureTransportToken: () => ({ token: true }),
      isTransportTokenCurrent: () => true,
    },
  })
  const commits: Array<{ workStopped: boolean }> = []
  const stopCalls: string[] = []
  let opened: ExitChoiceModel | undefined
  const coordinator = createExitIntentCoordinator({
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    facts,
    commit: options => { commits.push(options) },
    presenter: () => ({
      open: model => { opened = model },
      update: model => { opened = model },
      close: () => {},
    }),
    stopCurrentWork: async () => {
      stopCalls.push('stop')
      return { kind: 'stopped' as const }
    },
  })

  coordinator.request('slash')
  assert.equal(opened?.kind, 'daemon-busy')
  assert.equal(opened?.shellRunning, true)
  assert.deepEqual(opened?.options.map(option => option.id), ['keep-and-disconnect', 'stop-and-disconnect', 'stay'])
  assert.ok(opened?.body.some(paragraph => paragraph.includes('user shell')), 'the shell reminder is painted')
  assert.deepEqual(commits, [], 'the choice never exits on open')

  opened!.select('stay')
  assert.deepEqual(commits, [], 'Stay never exits')
  assert.equal(shell.isRunning(), true, 'Stay never aborts the running shell')

  // The user cancels the shell through the EXISTING owner path (Esc); after its
  // real terminal settlement the idle Client detach proceeds normally.
  shell.cancelRun()
  await finished
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(executeAborted, true, 'the host admission observed the real abort')
  assert.equal(shell.isRunning(), false, 'the owner cleared the controller at settlement')
  coordinator.request('slash')
  assert.deepEqual(commits, [{ workStopped: false }], 'the idle daemon Client detaches after the shell settled')
  assert.deepEqual(stopCalls, [], 'the Agent Stop path was never used as a shell proof')
})
