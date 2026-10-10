/** Viewer/Task application integration coverage for non-main surfaces:
 * interactive child viewers, child opening/cold-resume lifecycle, the
 * parent/child Preparing projection rollover, and the Task Center / Job
 * surfaces bound to the correct Session owner. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import {
  disposeContext,
  event,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
} from './support/runner-harness.ts'
import {
  emitLiveStream,
  installProbe,
  liveAgentOf,
  liveChunkFrame,
  liveCommittedEnd,
  liveStart,
  modelEvent,
} from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A mutable jobs-registry fake for the Task Center runner paths. */
function makeJobsFake(
  initial: readonly { id: string; kind: string; label: string; status: string; startedAt: number }[],
) {
  type Entry = { id: string; kind: string; label: string; status: string; startedAt: number }
  let entries: Entry[] = initial.map(entry => ({ ...entry }))
  let listFailure: Error | undefined
  const listeners: Array<(event: { type: string }) => void> = []
  const subscribeFilters: unknown[] = []
  let subscribeDisposals = 0
  const registry = {
    list: (caller?: unknown): Entry[] => {
      // DSH 0.1.7 JobRegistry ownership: the caller, when present, is the
      // owning SessionId — never an Agent object.
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`jobs.list must receive a SessionId, got ${String(caller)}`)
      }
      if (listFailure !== undefined) throw listFailure
      return entries.map(entry => ({ ...entry }))
    },
    get: (id: string, caller?: unknown): Entry => {
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`jobs.get must receive a SessionId, got ${String(caller)}`)
      }
      const entry = entries.find(candidate => candidate.id === id)
      // A vanished job is the registry's own "not found" contract.
      if (entry === undefined) throw new Error(`unknown job ${id}`)
      return { ...entry }
    },
    kill: (id: string, caller?: unknown): string => {
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`jobs.kill must receive a SessionId, got ${String(caller)}`)
      }
      return 'accepted'
    },
    // DSH 0.1.7 JobRegistry unified event seam: the runner subscribes
    // through `events.subscribe(filter, listener)`; the disposer removes
    // the listener so disposal semantics are observable. Emissions carry
    // the official JobEvent type vocabulary so the listener's event-type
    // filtering is exercised exactly as the registry delivers it.
    events: {
      subscribe: (filter: unknown, listener: (event: { type: string }) => void): (() => void) => {
        subscribeFilters.push(filter)
        listeners.push(listener)
        return () => {
          subscribeDisposals += 1
          const index = listeners.indexOf(listener)
          if (index !== -1) listeners.splice(index, 1)
        }
      },
    },
    setEntries: (next: readonly Entry[]): void => { entries = next.map(entry => ({ ...entry })) },
    setListFailure: (error: Error | undefined): void => { listFailure = error },
    emit: (type = 'settled'): void => { for (const listener of [...listeners]) listener({ type }) },
    /** C1 contract probes: exactly-once subscribe/dispose observability. */
    subscribeCount: (): number => subscribeFilters.length,
    disposalCount: (): number => subscribeDisposals,
    activeListenerCount: (): number => listeners.length,
    filterAt: (index: number): unknown => subscribeFilters[index],
  }
  return registry
}

test('an inactive child completion during observeSession is replayed by the viewer opening cut', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-viewer-opening-gap-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'viewer-opening-parent',
    header: { id: 'viewer-opening-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'viewer-opening-child',
    header: {
      id: 'viewer-opening-child',
      cwd: home,
      createdAt: 1_700_000_000_001,
      version: SESSION_FORMAT_VERSION,
      isSeeded: true,
      parentSession: parent.id,
    },
    events: [
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event('user/message', {
        id: MessageId('viewer-opening-parent-prompt'),
        role: 'user',
        content: [{ type: 'text', text: 'parent prompt hidden from child viewer' }],
        source: { kind: 'user' },
      }, 2, 'append'),
      event('user/message', {
        id: MessageId('viewer-opening-parent-notice'),
        role: 'user',
        content: [{ type: 'text', text: 'parent settlement notice hidden from child viewer' }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: 'parent settlement notice hidden from child viewer',
          senderSessionId: SessionId('viewer-opening-child'),
        },
      }, 3, 'append'),
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('viewer-opening-parent-reply'),
          role: 'assistant',
          content: [{ type: 'text', text: 'parent reply hidden from child viewer' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 9, outputTokens: 3 },
        stream: [],
      }, 4, 'append'),
      event('step/end', { turn: 1, step: 1 }, 5),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
      event('session/end-seed', { inherited: true }, 7),
      event('turn/start', { turn: 2 }, 8),
      event('step/start', { turn: 2, step: 1 }, 9),
      event('user/message', {
        id: MessageId('viewer-opening-first-prompt'),
        role: 'user',
        content: [{ type: 'text', text: 'child first prompt' }],
        source: { kind: 'user' },
      }, 10, 'append'),
      event('assistant/message', {
        turn: 2,
        step: 1,
        message: {
          id: MessageId('viewer-opening-first-reply'),
          role: 'assistant',
          content: [{ type: 'text', text: 'child first reply' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 9, outputTokens: 3 },
        stream: [],
      }, 11, 'append'),
      event('step/end', { turn: 2, step: 1 }, 12),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 13),
    ],
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child', id: child.id, label: 'opening child', mode: 'continuable', activity: 'inactive',
      hasChildren: false, parentId: parent.id, depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  let releaseObservation!: () => void
  const observationGate = new Promise<void>(resolve => { releaseObservation = resolve })
  let observationStarted!: () => void
  const observationStartedPromise = new Promise<void>(resolve => { observationStarted = resolve })
  const sessionQuery = harness.sessionQuery as {
    observeSession: (id: unknown, options?: unknown) => Promise<{ header: unknown; events: readonly SessionEvent[]; [Symbol.dispose](): void }>
  }
  const originalObserve = sessionQuery.observeSession
  sessionQuery.observeSession = async (id, options) => {
    const snapshot = await originalObserve(id, options)
    if (String(id) === child.id) {
      observationStarted()
      await observationGate
    }
    return snapshot
  }

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  // A subagent row opens the child TRANSCRIPT (a session/viewer surface):
  // the disposition is 'close', so the Task Center must be gone — unlike a
  // Job status detail, which stays mounted underneath (see the jobs-only
  // test below).
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be open before the selection')
  input('\r')
  assert.equal(app.overlayGraphState().handles, 0, 'a subagent transcript must replace the browser')
  await observationStartedPromise

  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  const childAgent = liveAgentOf(harness, child.id)
  const emitDurable = (type: string, data: unknown, surfaceOp?: 'append'): void => {
    const next = child.append!(type, data, surfaceOp === undefined ? undefined : { surfaceOp }) as SessionEvent
    context!.emit('session/event', child as never, next)
  }
  emitDurable('session/end-seed', {})
  emitDurable('turn/start', { turn: 3 })
  emitDurable('step/start', { turn: 3, step: 1 })
  emitDurable('user/message', {
    id: MessageId('viewer-opening-resumed-prompt'),
    role: 'user',
    content: [{ type: 'text', text: 'child resumed prompt' }],
    source: { kind: 'user' },
  }, 'append')
  emitDurable('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      id: MessageId('viewer-opening-completed'),
      role: 'assistant',
      content: [{ type: 'text', text: 'child resumed reply' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 9, outputTokens: 3 },
    stream: [],
  }, 'append')
  emitDurable('step/end', { turn: 3, step: 1 })
  emitDurable('turn/end', { turn: 3, reason: { kind: 'completed' } })
  context.emit('agent/disposed', { agent: childAgent } as never)
  await childHandle.dispose()

  releaseObservation()
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must mount after the cold observation returns')
  const messages = probe.capturedMessages ?? []
  const texts = messages.map(message => message.text ?? '')
  assert.equal(texts.filter(text => text === 'child resumed reply').length, 1,
    'buffered child durable events must be hydrated exactly once after the stale observation cut')
  for (const visible of ['child first prompt', 'child first reply', 'child resumed prompt', 'child resumed reply']) {
    assert.ok(texts.includes(visible), `child history must include ${visible}: ${texts.join(' | ')}`)
  }
  for (const hidden of ['parent prompt hidden from child viewer', 'parent reply hidden from child viewer', 'parent settlement notice hidden from child viewer']) {
    assert.ok(!texts.includes(hidden), `parent history must stay hidden: ${hidden}`)
  }
  assert.ok(texts.indexOf('child first prompt') < texts.indexOf('child resumed prompt'),
    `child turns must remain in order: ${texts.join(' | ')}`)
})

test('an inactive child cold-resume replays its opening prefix and running activity', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-viewer-opening-live-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'viewer-opening-live-parent',
    header: { id: 'viewer-opening-live-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'viewer-opening-live-child',
    header: { id: 'viewer-opening-live-child', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('child history'),
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child', id: child.id, label: 'opening live child', mode: 'continuable', activity: 'inactive',
      hasChildren: false, parentId: parent.id, depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  let releaseObservation!: () => void
  const observationGate = new Promise<void>(resolve => { releaseObservation = resolve })
  let observationStarted!: () => void
  const observationStartedPromise = new Promise<void>(resolve => { observationStarted = resolve })
  const sessionQuery = harness.sessionQuery as {
    observeSession: (id: unknown, options?: unknown) => Promise<{ header: unknown; events: readonly SessionEvent[]; [Symbol.dispose](): void }>
  }
  const originalObserve = sessionQuery.observeSession
  sessionQuery.observeSession = async (id, options) => {
    const snapshot = await originalObserve(id, options)
    if (String(id) === child.id) {
      observationStarted()
      await observationGate
    }
    return snapshot
  }

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  // A subagent row opens the child TRANSCRIPT (a session/viewer surface):
  // the disposition is 'close', so the Task Center must be gone — unlike a
  // Job status detail, which stays mounted underneath (see the jobs-only
  // test below).
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be open before the selection')
  input('\r')
  assert.equal(app.overlayGraphState().handles, 0, 'a subagent transcript must replace the browser')
  await observationStartedPromise

  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childHandle.dispose())
  const childAgent = liveAgentOf(harness, child.id)
  ;(childAgent as { status: 'idle' | 'running' }).status = 'running'
  const emitDurable = (type: string, data: unknown): void => {
    const next = child.append!(type, data) as SessionEvent
    context!.emit('session/event', child as never, next)
  }
  emitLiveStream(context, childAgent, { type: 'start', attemptId: 'viewer-opening-live', revision: 1, turn: 1, step: 0 })
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'viewer-opening-live', revision: 2, index: 0,
    time: 1_700_000_000_200, chunk: { type: 'text-delta', index: 0, text: 'child opening prefix' },
  })
  releaseObservation()
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must mount after observation')
  assert.equal((probe.capturedViewerMode as { activity?: string } | undefined)?.activity, 'running',
    'the attached Agent runtime status must override stale catalog and durable history activity during viewer opening')
  assert.ok((probe.capturedMessages ?? []).some(message => message.text === 'child opening prefix'),
    'the exact child Agent baseline must replay after durable opening hydration')
})

test('the parent Preparing projection and child viewer lifecycle rollover stay live', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-parent-preparing-viewer-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'parent-preparing-viewer-session',
    header: { id: 'parent-preparing-viewer-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'child-preparing-viewer-session',
    header: { id: 'child-preparing-viewer-session', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('child answer'),
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child',
      id: child.id,
      label: 'child viewer',
      mode: 'continuable',
      activity: 'running',
      hasChildren: false,
      parentId: parent.id,
      depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childHandle.dispose())
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const parentArguments = '{"path":"parent.ts"}'
  const childArguments = '{"command":"child"}'

  // The main session owns the first preview before the viewer opens.
  context.emit('session/event', parent as never, event('turn/start', { turn: 1 }, 10))
  const parentAgent = liveAgentOf(harness, parent.id)
  emitLiveStream(context, parentAgent, liveStart('p1', 1, 0))
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 0, {
    type: 'tool-call-delta', index: 0, id: '', name: 'edit', argumentsDelta: parentArguments,
  }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => [
    preview.callId, preview.name, preview.argumentBytes, preview.summary,
  ]), [['', 'edit', Buffer.byteLength(parentArguments, 'utf8'), 'parent.ts']])

  // The child Agent is already live, but its viewer has not mounted yet. Its
  // active prefix must remain available for the later exact-Agent replay.
  const childAgent = liveAgentOf(harness, child.id)
  emitLiveStream(context, childAgent, { type: 'start', attemptId: 'c1', revision: 1, turn: 1, step: 0 })
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'c1', revision: 2, index: 0,
    time: 1_700_000_000_100, chunk: { type: 'text-delta', index: 0, text: 'late child answer' },
  })
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'c1', revision: 3, index: 1,
    time: 1_700_000_000_101, chunk: {
      type: 'tool-call-delta', index: 1, id: 'child-call', name: 'bash', argumentsDelta: childArguments,
    },
  })

  // /tasks opens the real runner browser, and Enter mounts the child viewer.
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must be mounted')
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'late child answer'),
    'a late child viewer must replay the exact Agent baseline after durable hydration')
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => [
    preview.callId, preview.name, preview.argumentBytes, preview.summary,
  ]), [['child-call', 'bash', Buffer.byteLength(childArguments, 'utf8'), 'child']])

  // The same continuable child can roll from Activation A to a new Agent B
  // without closing the viewer. A's delayed frame must stay fenced while B's
  // first live text is immediately visible.
  emitLiveStream(context, childAgent, {
    type: 'end', attemptId: 'c1', revision: 4, index: 2,
    outcome: { kind: 'abandoned' },
  })
  const childBHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childBHandle.dispose())
  const childAgentB = liveAgentOf(harness, child.id)
  context.emit('agent/disposed', { agent: childAgent } as never)
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'c1', revision: 5, index: 2,
    time: 1_700_000_000_102, chunk: { type: 'text-delta', index: 0, text: 'STALE-A' },
  })
  context.emit('session/event', child as never, event('turn/start', { turn: 2 }, 25))
  context.emit('session/event', child as never, event('step/start', { turn: 2, step: 0 }, 26))
  emitLiveStream(context, childAgentB, { type: 'start', attemptId: 'c2', revision: 1, turn: 2, step: 0 })
  emitLiveStream(context, childAgentB, {
    type: 'chunk', attemptId: 'c2', revision: 2, index: 0,
    time: 1_700_000_026_100, chunk: { type: 'text-delta', index: 0, text: 'follow-up live' },
  })
  emitLiveStream(context, childAgentB, {
    type: 'chunk', attemptId: 'c2', revision: 3, index: 1,
    time: 1_700_000_026_101, chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } },
  })
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'follow-up live'),
    'the replacement Agent must feed the still-open viewer immediately')

  emitLiveStream(context, childAgentB, {
    type: 'end', attemptId: 'c2', revision: 4, index: 2,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 30 },
  })
  context.emit('session/event', child as never, event('assistant/message', {
    turn: 2,
    step: 0,
    message: {
      id: MessageId('child-rollover-message'),
      role: 'assistant',
      content: [{ type: 'text', text: 'follow-up durable' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 11, outputTokens: 3 },
    stream: [],
  }, 30, 'append'))
  context.emit('session/event', child as never, event('step/end', { turn: 2, step: 0 }, 31))
  context.emit('session/event', child as never, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 32))
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedMessages?.filter(message => message.kind === 'assistant' && message.text === 'follow-up durable').length, 1,
    'B durable settlement must replace its live row exactly once')
  assert.equal(probe.capturedMessages?.some(message => message.text === 'STALE-A'), false,
    'A delayed frames must not contaminate B')
  const rolloverActivity = probe.capturedActivities?.get(2) as {
    lastAssistantVisible?: boolean
    usage?: { inputTokens: number; outputTokens: number }
  } | undefined
  assert.equal(rolloverActivity?.lastAssistantVisible, true, 'Focus must follow B visibility')
  assert.deepEqual(rolloverActivity?.usage, { inputTokens: 11, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const viewerUsage = probe.capturedViewerUsage as {
    tokens?: { input: number; output: number }
    performance?: { firstTokenMs: number }
  } | undefined
  // M3-5 PR1 §9.5: the child's CUMULATIVE tokens are a SessionStatus fact.
  // This fixture has no `sessionProjections` service, so the child's official
  // usage is UNAVAILABLE — the bounded child transcript fold's 21/5 sum must
  // never be presented as a session total.
  assert.equal(viewerUsage?.tokens, undefined,
    'the bounded child fold token sum must not masquerade as the child cumulative usage')
  // The recent-performance figures stay presentation-local and still reach the
  // child stats footer.
  assert.ok((viewerUsage?.performance?.firstTokenMs ?? 0) > 0, 'B first-token timing must reach the child stats footer')

  // Parent events continue through the runner while the child owns the
  // visible transcript. Updating A and adding B must both survive the visit.
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 1, { type: 'tool-call-delta', index: 0, id: '', name: 'write', argumentsDelta: '}' }))
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 2, { type: 'tool-call-delta', index: 1, id: 'parent-call-b', name: 'read', argumentsDelta: '{' }))
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 3, {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'parent-call-a', name: 'write' },
  }))
  emitLiveStream(context, parentAgent, liveCommittedEnd('p1', 4, 'assistant/message'))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()

  // Esc returns to the parent surface; its hidden map, not a reset map, is
  // projected and therefore contains the latest A plus the new B.
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => [
    preview.callId, preview.name, preview.argumentBytes, preview.summary,
  ]), [
    ['parent-call-a', 'write', Buffer.byteLength(parentArguments + '}', 'utf8'), 'parent.ts'],
    ['parent-call-b', 'read', Buffer.byteLength('{', 'utf8'), undefined],
  ])

  // A parent call that materializes while the child remains visible must be
  // removed from the hidden main map, not recreated when the viewer closes.
  context.emit('session/event', parent as never, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 15))
  await vt.waitForRender()
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.getViewerGeneration(), 3, 'the child viewer must reopen')
  context.emit('session/event', parent as never, event('turn/start', { turn: 2 }, 16))
  emitLiveStream(context, parentAgent, liveStart('p2', 2, 0))
  emitLiveStream(context, parentAgent, liveChunkFrame('p2', 0, { type: 'tool-call-delta', index: 0, id: 'parent-call-c', name: 'edit', argumentsDelta: '{' }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  context.emit('session/event', parent as never, event('tool/call', {
    turn: 2,
    step: 0,
    callId: 'parent-call-c' as ToolCallId,
    name: 'edit',
    arguments: '{}',
  }, 18))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [],
    'a parent preview materialized behind the viewer must not return on exit')
})

test('the interactive child viewer projects its own authoritative steering and never leaks the parent subject', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-child-steering-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent = fakeSession({
    id: 'parent-child-steering',
    header: { id: 'parent-child-steering', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child = fakeSession({
    id: 'child-child-steering',
    header: {
      id: 'child-child-steering',
      cwd: home,
      createdAt: 1_700_000_000_001,
      version: SESSION_FORMAT_VERSION,
      parentSession: 'parent-child-steering',
    },
    events: sessionEvents('child answer'),
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child',
      id: child.id,
      label: 'child steer',
      mode: 'continuable',
      activity: 'running',
      hasChildren: false,
      parentId: parent.id,
      depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childHandle.dispose())
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }

  // Both subjects hold an authoritative user steering occurrence in their inbox.
  const parentAgent = liveAgentOf(harness, parent.id) as unknown as { inbox: { nextStep: unknown[] } }
  const childAgent = liveAgentOf(harness, child.id) as unknown as { status: string; inbox: { nextStep: unknown[] } }
  parentAgent.inbox.nextStep.push({
    id: 'parent-step-1',
    role: 'user',
    content: [{ type: 'text', text: 'PARENT-STEER' }],
    source: { kind: 'user', rpcId: 'parent-rpc' },
  })
  childAgent.status = 'running'
  childAgent.inbox.nextStep.push({
    id: 'child-step-1',
    role: 'user',
    content: [{ type: 'text', text: 'CHILD-STEER' }],
    source: { kind: 'user', rpcId: 'child-rpc' },
  })
  context.emit('session/event', parent as never, event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [] }, 40))
  await settle()
  await vt.waitForRender()
  const userRowsOf = (pending: ReturnType<TuiApp['pendingInputForTest']>) =>
    pending.tail.filter(item => item.kind === 'user').map(item => item.row)
  assert.ok(userRowsOf(app.pendingInputForTest()).some(row => row.text === 'PARENT-STEER'),
    'the main subject shows its authoritative steering before the viewer opens')

  // Enter the interactive continuable child viewer.
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must be mounted')

  context.emit('session/event', child as never, event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [] }, 41))
  await settle()
  await vt.waitForRender()
  const viewed = app.pendingInputForTest()
  const viewedUsers = userRowsOf(viewed)
  assert.ok(viewedUsers.some(row => row.text === 'CHILD-STEER' && row.rpcId === 'child-rpc'),
    `the child authoritative steering must be visible: ${JSON.stringify(viewedUsers)}`)
  assert.ok(!viewedUsers.some(row => row.text === 'PARENT-STEER'),
    'the parent pending row must not leak into the child viewer')

  // Leaving the viewer re-projects the MAIN subject: the child row must not leak.
  const mountedGeneration = app.getViewerGeneration()
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.ok(app.getViewerGeneration() > mountedGeneration, 'Esc must close the viewer')
  const restored = app.pendingInputForTest()
  const restoredUsers = userRowsOf(restored)
  assert.ok(!restoredUsers.some(row => row.text === 'CHILD-STEER'),
    'the closed child pending row must not leak to the parent surface')
  assert.ok(restoredUsers.some(row => row.text === 'PARENT-STEER'),
    'the parent subject is re-projected after the viewer closes')
})

test('a Job detail opened from /tasks keeps its parent mounted and live-refreshes it (jobs-only)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-disposition-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-disposition-parent',
    header: { id: 'task-disposition-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  // NO subagents service: this is the jobs-only path (the fallback browser).
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be the only overlay')

  input('\r') // open the selected running job's status detail
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2, 'the Job detail must keep the parent browser mounted')

  // The job settles WHILE the parent is hidden. In a jobs-only session the
  // only channel is jobs.events.subscribe → refreshTasks, which must repaint the
  // open (hidden) browser, not just the dock badge.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  jobs.emit()
  await settle()
  await vt.waitForRender()

  input('\x1b') // Esc closes ONLY the Job detail
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'Esc must close only the Job detail')
  assert.ok(view().includes('completed'),
    `the restored parent must show the live-refreshed job status:\n${view()}`)

  // A row that left the CURRENT Task projection must leave the parent usable:
  // the selection resolves against the current rows (the Task row identity
  // authority, not a registry lookup), so a vanished row opens nothing and
  // reports keep-open.
  jobs.setEntries([])
  jobs.emit()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1,
    'a row that left the current projection must not dismiss the parent browser')
})

test('the runner-level Job event subscription is exactly-once and disposed with the surface (C1)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-jobs-events-lifecycle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'jobs-events-lifecycle-parent',
    header: { id: 'jobs-events-lifecycle-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  assert.ok(probe.apps.at(-1), 'the production runner must create a TuiApp')
  await settle()

  // The runner subscribes exactly once through the unified event seam, with
  // the composition scope filter — never process-global observation.
  assert.equal(jobs.subscribeCount(), 1,
    'the runner must subscribe exactly once through jobs.events')
  assert.deepEqual(jobs.filterAt(0), { owners: 'scope' },
    'the runner-level filter must be the composition scope, not { owners: \'all\' }')

  // A live emission still reaches the refresh channel.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  jobs.emit()
  await settle()

  // Surface teardown releases the subscription exactly once, and a later
  // emission has no listener left to fire a post-disposal refresh.
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  await mountedFiber.dispose()
  fiber = undefined
  await settle()
  assert.equal(jobs.disposalCount(), 1, 'the subscription must be disposed exactly once')
  assert.equal(jobs.activeListenerCount(), 0, 'no listener may survive the surface teardown')
  jobs.emit()
  await settle()
  assert.equal(jobs.disposalCount(), 1, 'a post-disposal emission must not re-subscribe')
  assert.equal(jobs.subscribeCount(), 1, 'a post-disposal emission must not create a new subscription')
})

test('job events route by semantics: output ignored, progress/stopping runtime-only, membership full (rc.1)', async (t) => {
  // rc.1 JobEvent semantic routing: `output` (one ring append per streamed
  // chunk) is pure stream noise; `progress`/`stopping` change only JobView
  // runtime facts; only the membership vocabulary (registered/settled/
  // removed) may move the subagent catalog, whose refresh (listDescendants)
  // can read persistence — so routing matches the TaskBrowserRuntime's own
  // catalog/runtime split.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-jobs-event-routing-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)

  const parent: FakeSession = fakeSession({
    id: 'jobs-output-filter-parent',
    header: { id: 'jobs-output-filter-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  let descendantReads = 0
  const subagents = {
    listDescendants: async () => {
      descendantReads += 1
      return []
    },
  }
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  // refreshTasks lands in app.setTasks; count calls through the prototype
  // to observe exactly which emissions reached the refreshes.
  const setTasksCalls: number[] = []
  const originalSetTasks = TuiApp.prototype.setTasks
  TuiApp.prototype.setTasks = function (tasks: unknown) {
    setTasksCalls.push((tasks as { id: string }[]).length)
    return originalSetTasks.call(this, tasks as never)
  }
  life.defer(() => { TuiApp.prototype.setTasks = originalSetTasks })

  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  assert.ok(probe.apps.at(-1), 'the production runner must create a TuiApp')
  await settle()
  // The initial seed refresh (+ the subagents-backed catalog refresh).
  const setTasksBaseline = setTasksCalls.length
  const descendantBaseline = descendantReads
  assert.ok(descendantBaseline > 0, 'the mount must have performed the initial catalog refresh')

  // A burst of output events (one per streamed chunk) must reach NEITHER
  // refresh channel: no task repaint, no catalog read.
  for (let chunk = 0; chunk < 5; chunk += 1) jobs.emit('output')
  await settle()
  await vt.waitForRender()
  assert.equal(setTasksCalls.length, setTasksBaseline, 'output events must not repaint the Task rows')
  assert.equal(descendantReads, descendantBaseline, 'output events must not trigger the subagent catalog refresh')

  // `progress` (a producer's live progress line) and `stopping` (a kill
  // acknowledged) change only JobView runtime facts: the Task rows repaint
  // from the runtime-only refresh while the CATALOG (listDescendants —
  // which may read persistence) stays untouched.
  for (const type of ['progress', 'stopping'] as const) {
    const taskBaseline = setTasksCalls.length
    const catalogBaseline = descendantReads
    jobs.emit(type)
    await settle()
    await vt.waitForRender()
    assert.ok(setTasksCalls.length > taskBaseline, `a ${type} event must repaint the Task rows`)
    assert.equal(descendantReads, catalogBaseline, `a ${type} event must NOT trigger the subagent catalog refresh`)
  }

  // Lifecycle vocabulary still refreshes normally: the roster changed and
  // a settlement implies membership may have moved.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  for (const type of ['settled', 'registered', 'removed'] as const) {
    const taskBaseline = setTasksCalls.length
    const catalogBaseline = descendantReads
    jobs.emit(type)
    await settle()
    await vt.waitForRender()
    assert.ok(setTasksCalls.length > taskBaseline, `a ${type} event must repaint the Task rows`)
    assert.ok(descendantReads > catalogBaseline, `a ${type} event must trigger the subagent catalog refresh`)
  }
})

test('Task Center membership follows the registry: settlement retains, removal disappears (rc.1)', async (t) => {
  // DSH 0.1.7 foreground shell contract in the OPEN full Task Center: a
  // `settled` event with the record RETAINED (a handed-out background
  // job) keeps the row visible as completed, while the authoritative
  // registry removal makes the row leave with the registry. The TUI keeps
  // no tombstone — `removed` IS the membership change.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-membership-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-membership-parent',
    header: { id: 'task-membership-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  // Jobs-only session: refreshTasks is the browser's only refresh channel.
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  // Open the full Task Center on a direct /tasks (tracked scope).
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be the only overlay')
  assert.ok(view().includes('build'), `the running job row must be visible:\n${view()}`)

  // Retained settlement: the registry keeps the terminal record (a
  // handed-out background job) — the row must STAY and show completed.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  jobs.emit('settled')
  await settle()
  await vt.waitForRender()
  const settledView = view()
  assert.ok(settledView.includes('build'), `a retained settlement must keep the row:\n${settledView}`)
  assert.ok(settledView.includes('completed'), `the retained row must show its terminal status:\n${settledView}`)

  // Authoritative removal: the registry drops the record (e.g. a
  // provisional foreground shell collected by its direct result) — the
  // row must leave the open Task Center with the registry.
  jobs.setEntries([])
  jobs.emit('removed')
  await settle()
  await vt.waitForRender()
  assert.ok(!view().includes('build'),
    `an authoritative removal must remove the row from the open Task Center:\n${view()}`)
})

test('a failed jobs read never blanks the retained Task Browser parent', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-read-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-read-failure-parent',
    header: { id: 'task-read-failure-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be the only overlay')
  assert.ok(view().includes('build'), `the browser must show the job:\n${view()}`)

  input('\r') // Job detail; the parent stays mounted but hidden
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2)

  // The close-time refresh hits a transient registry failure: that must NOT
  // be interpreted as an authoritative empty catalog.
  jobs.setListFailure(new Error('registry unavailable'))
  input('\x1b') // close the Job detail → onClose → refreshTasks()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'Esc must close only the Job detail')
  assert.ok(view().includes('build'),
    `the retained parent must keep its rows across a failed registry read:\n${view()}`)
})

test('a failed jobs read never blanks a coordinator-backed Task Browser', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-runtime-read-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-runtime-read-failure-parent',
    header: { id: 'task-runtime-read-failure-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  // A subagents service makes this the COORDINATOR-backed runtime path (the
  // TaskBrowserRuntime.readJobs hook), not the jobs-only fallback browser.
  const subagents = { listDescendants: async () => [] }
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'), `the browser must show the job:\n${view()}`)

  // A runtime refresh (jobs change → refreshAgents → TaskBrowserRuntime.apply)
  // whose registry read fails must keep the retained Job rows.
  jobs.setListFailure(new Error('registry unavailable'))
  jobs.emit()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'),
    `the coordinator-backed browser must keep its rows across a failed registry read:\n${view()}`)
})

test('a session switch never inherits the previous session cached Job rows', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-cache-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const sessionA: FakeSession = fakeSession({
    id: 'cache-switch-a',
    header: { id: 'cache-switch-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer a'),
  })
  const sessionB: FakeSession = fakeSession({
    id: 'cache-switch-b',
    header: { id: 'cache-switch-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer b'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const subagents = { listDescendants: async () => [] }
  const harness = makeHarness(home, [sessionA, sessionB], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register the /resume alias')
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'), `session A must show its job:\n${view()}`)

  // Switch sessions while the registry read fails: the cached A rows belong to
  // A's session identity and must not be committed into B.
  jobs.setListFailure(new Error('registry unavailable'))
  await resume({ rawInput: sessionB.id })
  await settle()
  await vt.waitForRender()
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(!view().includes('build'),
    `session B must not inherit session A cached Job rows:\n${view()}`)
})

test('switching sessions tears down the Job status viewer with its Task Browser', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-job-viewer-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const sessionA: FakeSession = fakeSession({
    id: 'job-viewer-switch-a',
    header: { id: 'job-viewer-switch-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer a'),
  })
  const sessionB: FakeSession = fakeSession({
    id: 'job-viewer-switch-b',
    header: { id: 'job-viewer-switch-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer b'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [sessionA, sessionB], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register the /resume alias')
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'), `the browser must show the job:\n${view()}`)

  input('\r') // open the Job status detail (a child overlay of the browser)
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2, 'browser + Job detail')
  assert.ok(view().includes('Esc back'), `the Job detail shows Esc back:\n${view()}`)

  await resume({ rawInput: sessionB.id })
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'the whole Task Center stack is torn down')
  assert.ok(!view().includes('Esc back'), `the old Job View must not survive the switch:\n${view()}`)
  assert.ok(!view().includes('build'), `the old browser must not survive the switch:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'editor', 'the new-session editor owns the keyboard')
})

/** One catalog descendant entry for the Task Center coalescing regressions. */
function descendantEntry(id: string, label: string, parentId: string): SubagentDescendantListEntry {
  return {
    kind: 'child',
    id,
    label,
    mode: 'one-shot',
    activity: 'inactive',
    hasChildren: false,
    parentId,
    depth: 1,
  } as unknown as SubagentDescendantListEntry
}

test('task catalog invalidation burst coalesces recursive descendant reads', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-catalog-burst-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  // Opt-in profiling is OFF by default; this test enables it to prove one
  // structured line is written per REAL traversal (and that the default path
  // would print nothing to the TUI).
  const previousProfile = process.env.DSH_TUI_TASK_REFRESH_PROFILE
  process.env.DSH_TUI_TASK_REFRESH_PROFILE = '1'
  life.defer(() => {
    if (previousProfile === undefined) delete process.env.DSH_TUI_TASK_REFRESH_PROFILE
    else process.env.DSH_TUI_TASK_REFRESH_PROFILE = previousProfile
  })
  // Pin the diag FILE sink to the default `$DSH_HOME/logs` path (and info
  // level) so the assertion reads the path the TUI really wrote, regardless of
  // an ambient DSH_PI_TUI_LOG / DSH_PI_TUI_LOG_LEVEL.
  const previousLogPath = process.env.DSH_PI_TUI_LOG
  const previousLogLevel = process.env.DSH_PI_TUI_LOG_LEVEL
  delete process.env.DSH_PI_TUI_LOG
  process.env.DSH_PI_TUI_LOG_LEVEL = 'info'
  life.defer(() => {
    if (previousLogPath === undefined) delete process.env.DSH_PI_TUI_LOG
    else process.env.DSH_PI_TUI_LOG = previousLogPath
    if (previousLogLevel === undefined) delete process.env.DSH_PI_TUI_LOG_LEVEL
    else process.env.DSH_PI_TUI_LOG_LEVEL = previousLogLevel
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  // The coordinator's summary is the projection the panel renders from: its
  // descendant total proves exactly which membership landed.
  const agentTotals: number[] = []
  const originalSetTaskSummary = TuiApp.prototype.setTaskSummary
  TuiApp.prototype.setTaskSummary = function (summary: unknown) {
    agentTotals.push((summary as { totalAgents: number }).totalAgents)
    return originalSetTaskSummary.call(this, summary as never)
  }
  life.defer(() => { TuiApp.prototype.setTaskSummary = originalSetTaskSummary })
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-catalog-burst-parent',
    header: { id: 'task-catalog-burst-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  // A DEFERRED descendant read: every catalog traversal gets its own resolver,
  // so the test controls exactly when each recursive read settles.
  const listings: { sessionId: string; resolve: (entries: readonly SubagentDescendantListEntry[]) => void }[] = []
  const subagents = {
    listDescendants: (sessionId: string) => new Promise<readonly SubagentDescendantListEntry[]>((resolve) => {
      listings.push({ sessionId, resolve })
    }),
  }
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  const emitSubagent = (name: string): void => {
    (context as unknown as { emit(name: string, payload: unknown): void }).emit(name, {})
  }
  await settle()
  assert.equal(listings.length, 1,
    `the mount must start exactly ONE recursive descendant read (started ${listings.length})`)
  assert.equal(listings[0]!.sessionId, parent.id)

  // Burst while the first traversal is pending: repeated lifecycle events, a
  // Task Center open and a Job membership event must ALL coalesce into the
  // pending read — never a second concurrent traversal.
  for (let index = 0; index < 4; index += 1) emitSubagent('subagent/start')
  await tasksHandler()
  jobs.emit('registered')
  await settle()
  await vt.waitForRender()
  assert.equal(listings.length, 1,
    `a burst during a pending traversal must not start another read (started ${listings.length})`)

  const oldChildren = Array.from({ length: 30 }, (_, index) => {
    const id = `child-${String(index + 1).padStart(2, '0')}`
    return descendantEntry(id, `child ${index + 1}`, parent.id)
  })
  // Settle the first traversal: the accumulated invalidations must produce
  // EXACTLY ONE trailing read that observes the latest membership.
  listings[0]!.resolve(oldChildren)
  await settle()
  assert.equal(listings.length, 2,
    `settle must start exactly one trailing read (started ${listings.length})`)
  assert.equal(listings[1]!.sessionId, parent.id)

  const newChild = descendantEntry('child-new', 'new child', parent.id)
  listings[1]!.resolve([newChild, ...oldChildren])
  await settle()
  await vt.waitForRender()
  assert.equal(listings.length, 2, 'the trailing read must settle without starting another read')
  assert.equal(agentTotals.at(-1), 31,
    `the trailing read's child-new must reach the Task Center projection (totals: ${agentTotals.join(',')})`)

  // The opt-in profile records one line per REAL traversal in the diag log
  // (never on stderr by default). Assert on the TRAILING line specifically:
  // the first read's line already carried the old count, so a whole-log
  // `includes()` would pass without locking the trailing read at all.
  const profileLines = readFileSync(join(home, 'logs', `pi-tui-${process.pid}.log`), 'utf8')
    .split('\n')
    .filter(line => line.includes('task catalog refresh profile'))
  const initialLine = profileLines.find(line => line.includes('trailing=false'))
  const trailingLine = profileLines.find(line => line.includes('trailing=true'))
  assert.ok(initialLine !== undefined,
    `the opt-in profiler must log the initial read:\n${profileLines.join('\n')}`)
  assert.ok(trailingLine !== undefined,
    `the coalesced trailing read must be marked as such:\n${profileLines.join('\n')}`)
  assert.ok(initialLine.includes('descendants=30'),
    `the initial read must report its durable descendant count:\n${initialLine}`)
  assert.ok(trailingLine.includes('descendants=31'),
    `the trailing read must report the NEW durable descendant count:\n${trailingLine}`)
  assert.ok(trailingLine.includes('outcome=ok'),
    `a settled read must record its outcome:\n${trailingLine}`)
  assert.ok(trailingLine.includes('superseded=false'),
    `a current-generation read must not be marked superseded:\n${trailingLine}`)
  assert.ok(/invalidations=\d+/.test(trailingLine),
    `the absorbed invalidation count must be recorded:\n${trailingLine}`)
})

test('session switch does not let an old coalesced refresh block the new session', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-catalog-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  // Opt-in profiling (with the diag file sink pinned) so the superseded
  // generation's late traversal must still leave an honest profile line.
  const previousProfile = process.env.DSH_TUI_TASK_REFRESH_PROFILE
  const previousLogPath = process.env.DSH_PI_TUI_LOG
  const previousLogLevel = process.env.DSH_PI_TUI_LOG_LEVEL
  process.env.DSH_TUI_TASK_REFRESH_PROFILE = '1'
  delete process.env.DSH_PI_TUI_LOG
  process.env.DSH_PI_TUI_LOG_LEVEL = 'info'
  life.defer(() => {
    if (previousProfile === undefined) delete process.env.DSH_TUI_TASK_REFRESH_PROFILE
    else process.env.DSH_TUI_TASK_REFRESH_PROFILE = previousProfile
    if (previousLogPath === undefined) delete process.env.DSH_PI_TUI_LOG
    else process.env.DSH_PI_TUI_LOG = previousLogPath
    if (previousLogLevel === undefined) delete process.env.DSH_PI_TUI_LOG_LEVEL
    else process.env.DSH_PI_TUI_LOG_LEVEL = previousLogLevel
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const sessionA: FakeSession = fakeSession({
    id: 'coalesce-switch-a',
    header: { id: 'coalesce-switch-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer a'),
  })
  const sessionB: FakeSession = fakeSession({
    id: 'coalesce-switch-b',
    header: { id: 'coalesce-switch-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer b'),
  })
  const childB: FakeSession = fakeSession({
    id: 'coalesce-switch-child-b',
    header: {
      id: 'coalesce-switch-child-b',
      cwd: home,
      createdAt: 1_700_000_000_001,
      version: SESSION_FORMAT_VERSION,
      parentSession: 'coalesce-switch-b',
    },
    events: sessionEvents('child b answer'),
  })
  const listings: { sessionId: string; resolve: (entries: readonly SubagentDescendantListEntry[]) => void }[] = []
  const subagents = {
    listDescendants: (sessionId: string) => new Promise<readonly SubagentDescendantListEntry[]>((resolve) => {
      listings.push({ sessionId, resolve })
    }),
  }
  const harness = makeHarness(home, [sessionA, sessionB, childB], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  // The child's live driver: session B's catalog must project it as running.
  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: childB.id })
  life.defer(() => childHandle.dispose())
  ;(harness.agents as { get(id: string): { status: string } }).get(childB.id).status = 'running'

  const badges: Array<readonly { id: string }[]> = []
  const originalSetAgents = TuiApp.prototype.setAgents
  TuiApp.prototype.setAgents = function (agents: unknown) {
    badges.push([...(agents as readonly { id: string }[])])
    return originalSetAgents.call(this, agents as never)
  }
  life.defer(() => { TuiApp.prototype.setAgents = originalSetAgents })

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const emitSubagent = (name: string): void => {
    (context as unknown as { emit(name: string, payload: unknown): void }).emit(name, {})
  }
  await settle()
  assert.equal(listings.length, 1, 'the mount must start exactly one session-A read')
  assert.equal(listings[0]!.sessionId, sessionA.id)

  emitSubagent('subagent/start')
  await settle()
  assert.equal(listings.length, 1, 'an A invalidation during the pending A read must coalesce (mark dirty)')

  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register the /resume alias')
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown
  await resume({ rawInput: sessionB.id })
  await settle()
  assert.equal(listings.length, 2,
    'the new session must start its own read while the old read is still pending')
  assert.equal(listings[1]!.sessionId, sessionB.id)

  // The OLD session settles while B's FIRST read is still in flight. The
  // generation fence must make it a total no-op: no A trailing read, and — the
  // point of this ordering — it must NOT clear B's in-flight mark.
  listings[0]!.resolve([descendantEntry('coalesce-switch-child-a', 'child a', sessionA.id)])
  await settle()
  assert.equal(listings.length, 2,
    'a superseded generation must not schedule a trailing read while the new session is in flight')
  // The superseded traversal is still PROFILED, but only with its own
  // start-time facts: it must never report the new session's catalog state.
  const supersededLine = readFileSync(join(home, 'logs', `pi-tui-${process.pid}.log`), 'utf8')
    .split('\n')
    .find(line => line.includes('task catalog refresh profile') && line.includes('superseded=true'))
  assert.ok(supersededLine !== undefined,
    'the superseded traversal must leave a profile line (not be silently dropped)')
  assert.ok(supersededLine.includes('outcome=ok'),
    `a successfully-read-but-superseded traversal must report its outcome:\n${supersededLine}`)
  assert.ok(!supersededLine.includes('descendants='),
    `a superseded line must not attribute the new generation's catalog to the old read:\n${supersededLine}`)
  // B is STILL in flight: this invalidation must coalesce into B's pending read.
  // If A's late settle had cleared B's in-flight mark, it would start a third
  // read here instead.
  emitSubagent('subagent/start')
  await settle()
  assert.equal(listings.length, 2,
    "the old settle must not clear the new session's in-flight gate")

  // B's first read settles: the coalesced B invalidation produces exactly ONE
  // trailing B read, then B is idle again.
  listings[1]!.resolve([descendantEntry(childB.id, 'child b', sessionB.id)])
  await settle()
  assert.equal(listings.length, 3, 'session B must produce its own trailing read')
  assert.equal(listings[2]!.sessionId, sessionB.id)
  listings[2]!.resolve([descendantEntry(childB.id, 'child b', sessionB.id)])
  await settle()
  assert.deepEqual(badges.at(-1)?.map(entry => entry.id), [childB.id],
    'session B must project its running child into the badge')
  assert.equal(listings.length, 3,
    'the old session\'s late settle must not touch the switched-in session')
})

test('a failed coalesced catalog read still runs exactly one trailing refresh', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-catalog-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-catalog-failure-parent',
    header: { id: 'task-catalog-failure-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const listings: {
    sessionId: string
    resolve: (entries: readonly SubagentDescendantListEntry[]) => void
    reject: (error: Error) => void
  }[] = []
  const subagents = {
    listDescendants: (sessionId: string) => new Promise<readonly SubagentDescendantListEntry[]>((resolve, reject) => {
      listings.push({ sessionId, resolve, reject })
    }),
  }
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' }, undefined, undefined, subagents)

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const emitSubagent = (name: string): void => {
    (context as unknown as { emit(name: string, payload: unknown): void }).emit(name, {})
  }
  await settle()
  assert.equal(listings.length, 1, 'the mount must start exactly one catalog read')

  // An invalidation while the read is in flight marks the gate dirty.
  emitSubagent('subagent/start')
  await settle()
  assert.equal(listings.length, 1, 'the invalidation must coalesce, not start a concurrent read')

  // The in-flight read FAILS: the dirty invalidation must not be swallowed —
  // exactly one trailing read still starts and can recover the membership.
  listings[0]!.reject(new Error('descendant read failed'))
  await settle()
  assert.equal(listings.length, 2,
    `a failed read must still schedule the coalesced trailing read (started ${listings.length})`)
  assert.equal(listings[1]!.sessionId, parent.id)
  listings[1]!.resolve([descendantEntry('child-after-failure', 'after failure', parent.id)])
  await settle()
  await vt.waitForRender()
  assert.equal(listings.length, 2, 'the trailing read must settle without starting another read')
})

test('a parked continued Question is reachable and reopenable from the Task Center', async (t) => {
  // Addendum §16.4 (surface integration, not a source-string assertion): the
  // literal user path is park -> Task Center -> Enter -> the SAME Question
  // returns to the editor seat. The Question controller owns the authority
  // interpretation; the surface composes its attention rows into the browser.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-question-park-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const session: FakeSession = fakeSession({
    id: 'question-park-session',
    header: { id: 'question-park-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer me later'),
  })
  const harness = makeHarness(home, [session], { provider: 'p', model: 'm' })

  context = new Context()
  // The production base contract this fixture must model: the Host provides the
  // `userQuestions` capability (`dsh-base` mounts it), and the Direct Question
  // adapter's `onRequest()` returns false without it — which would leave
  // `attach()` with nothing to cold-reconcile and silently hide the whole
  // parked-Question path. The fake is the minimal SEMANTIC shape the adapter
  // declares (`attachWait` + `answer`); this test never answers a late reply.
  context.provide('userQuestions', {
    attachWait: () => (async function* () {
      // No live timed wait for any call: the durable projection is the only
      // authority this fixture exercises.
      await new Promise(() => {})
    })(),
    answer: () => false,
  } as never)
  // The durable Question authority: one CONTINUED call with no queued reply.
  // A parked Question is discovered from this projection alone.
  let queuedReply = false
  let projectionListener: (() => void) | undefined
  const questionsProjection = context.provide('sessionProjections', {
    stateOf: (_session: unknown, key: string): unknown => key === 'userQuestions'
      ? {
          questions: {
            active: [{
              callId: 'call-parked',
              questions: [{ id: 'q1', question: 'Use staging or production?' }],
              state: 'continued',
            }],
            settled: [],
          },
        }
      : {
          'next-step': queuedReply ? [{ source: { kind: 'user-question-reply', callId: 'call-parked' } }] : [],
          'next-turn': [],
        },
    onChanged: (listener: (session: unknown, key: string) => void) => {
      // The adapter filters by owning session + projected unit, so the
      // notification carries the real arguments (an argument-less call would be
      // filtered out and prove nothing).
      projectionListener = () => listener({ id: 'question-park-session' }, 'inbox')
      return () => { projectionListener = undefined }
    },
  } as never)
  assert.ok(questionsProjection === undefined || questionsProjection !== undefined)
  fiber = await mountRunner(context, home, harness, { sessionId: session.id }, { sessionId: session.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  await settle()
  await vt.waitForRender()

  // COLD discovery parks it: the Question must NOT have stolen the editor seat,
  // yet the footer's Task Center trigger is armed by the parked attention alone
  // (no Job/Subagent is running in this fixture).
  assert.equal(app.overlayGraphState().handles, 0, 'cold discovery owns no overlay')
  const idle = vt.getViewport().join('\n')
  assert.ok(!idle.includes('Type your answer…'), `no Question panel was mounted:\n${idle}`)
  // COLD DISCOVERY closes the whole chain, with zero work of any kind: the
  // controller found the continued call at attach (the fixture now models the
  // production `userQuestions` capability), parked it, published the count, and
  // the footer therefore advertises the Task Center.
  assert.equal(app.isTasksActive(), true, 'a parked Question alone arms the affordance')
  assert.ok(idle.includes('? 1 awaiting'), `the footer counts it as human attention:\n${idle}`)
  assert.ok(idle.includes('↓ view'), `and advertises the reopen trigger:\n${idle}`)

  // The MANDATORY keyboard path: the literal ↓ opens Quick for a Questions-only
  // session.
  vt.sendInput('\x1b[B')
  await settle()
  await vt.waitForRender()
  const quickByKey = vt.getViewport().join('\n')
  assert.equal(app.overlayGraphState().handles, 1, `↓ opens Quick Tasks:\n${quickByKey}`)
  assert.equal(app.focusSeatForTest(), 'overlay', 'Quick owns keyboard focus while open')
  assert.ok(quickByKey.includes('Needs attention'), `with the attention group:\n${quickByKey}`)
  assert.ok(quickByKey.includes('Use staging or production?'), `and the parked Question row:\n${quickByKey}`)
  assert.ok(quickByKey.includes('awaiting answer'), `marked as awaiting an answer:\n${quickByKey}`)
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'Enter reopens the Question from Quick')
  const fromQuick = vt.getViewport().join('\n')
  assert.ok(fromQuick.includes('Type your answer…'), `the QuestionFlow is reopened:\n${fromQuick}`)
  assert.equal(app.focusSeatForTest(), 'overlay', 'the reopened Question owns keyboard focus')
  // Esc is LAYERED inside the flow (the reopened form restores the review page,
  // where the first Esc steps back and the next one cancels the flow); only the
  // flow's own cancel parks the continued Question.
  const editableFlows = (): number => (vt.getViewport().join('\n').match(/Type your answer…/gu) ?? []).length
  const parkQuestion = async (): Promise<void> => {
    for (let attempt = 0; attempt < 3 && editableFlows() > 0; attempt += 1) {
      vt.sendInput('\x1b')
      await settle()
      await vt.waitForRender()
    }
    assert.equal(editableFlows(), 0, 'the Question is parked')
  }

  // VISIBLE -> Esc -> literal ↓ -> Quick: the affordance comes back with the
  // park. (`visible -> answering` is NOT driven here: while a Question owns
  // input the Task Center is unreachable by design — only the modal-safe
  // inspection actions pass — so a concurrent state would be a fabricated
  // navigation contract. The mapping is covered by the pure projection test.)
  await parkQuestion()
  const parkedAgain = vt.getViewport().join('\n')
  assert.ok(parkedAgain.includes('? 1 awaiting'), `parking restores the attention figure:\n${parkedAgain}`)
  assert.ok(parkedAgain.includes('↓ view'), `and the trigger:\n${parkedAgain}`)
  // Ownership round-trip: Quick -> Question capture -> park -> the CURRENT
  // editor-seat occupant gets physical focus back.
  assert.equal(app.focusSeatForTest(), 'editor', 'parking restores the editor keyboard seat')
  assert.equal(
    app.focusedComponentForTest(),
    app.seatEditorForTest().component,
    'parking restores physical focus to the current editor-seat occupant',
  )
  vt.sendInput('\x1b[B')
  await settle()
  await vt.waitForRender()
  const quickAfterPark = vt.getViewport().join('\n')
  assert.equal(app.overlayGraphState().handles, 1, `↓ opens Quick after the park:\n${quickAfterPark}`)
  assert.ok(quickAfterPark.includes('Use staging or production?'), `with the Question row:\n${quickAfterPark}`)
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(editableFlows(), 1, 'and Enter reopens the QuestionFlow')

  // Park it once more so the row/live-removal leg below starts parked. This is
  // the reachable path to Full: park FIRST (the Question owns input while it is
  // visible), then open the Task Center.
  await parkQuestion()
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  const quick = vt.getViewport().join('\n')
  assert.equal(app.overlayGraphState().handles, 1, `the Task Center is open:\n${quick}`)
  assert.ok(quick.includes('Needs attention'), `it lists the parked Question:\n${quick}`)
  assert.ok(quick.includes('Use staging or production?'), `with its label:\n${quick}`)
  assert.ok(quick.includes('awaiting answer'), `as awaiting an answer:\n${quick}`)

  // Authority changes while the browser is open: the row disappears live, with
  // no catalog re-list and no stale row left behind.
  queuedReply = true
  projectionListener?.()
  await settle()
  await vt.waitForRender()
  const removed = vt.getViewport().join('\n')
  assert.ok(!removed.includes('Use staging or production?'), `a queued reply removes the row live:\n${removed}`)

  // The reply is discarded: the same call becomes answerable again, parked, and
  // the row returns.
  queuedReply = false
  projectionListener?.()
  await settle()
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('Use staging or production?'), `the row returns when the call is answerable again:\n${restored}`)

  // Enter reopens the SAME entry: the browser closes and the editable panel
  // returns (no transcript reconstruction, no second flow).
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'a reopened Question replaces the browser')
  const reopened = vt.getViewport().join('\n')
  assert.ok(reopened.includes('Use staging or production?'), `the Question panel returns:\n${reopened}`)
  assert.ok(reopened.includes('Type your answer…'), `the editable form owns the seat again:\n${reopened}`)
  const flowFrames = (reopened.match(/Type your answer…/gu) ?? []).length
  assert.equal(flowFrames, 1, 'exactly one editable flow exists')

  // Park it again and confirm the row is rebuilt from presentation state. The
  // flow's Esc is LAYERED, so a single press would only leave the edit layer:
  // the parked state must be proven (no editable frame, the attention figure
  // back) BEFORE the Task Center is opened, otherwise this leg would walk the
  // unreachable handler path it is meant to rule out.
  await parkQuestion()
  const parkedIdle = vt.getViewport().join('\n')
  assert.ok(!parkedIdle.includes('Type your answer…'), `the Question is parked, not visible:\n${parkedIdle}`)
  assert.ok(parkedIdle.includes('? 1 awaiting'), `the parked figure is back:\n${parkedIdle}`)
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  const reparked = vt.getViewport().join('\n')
  assert.ok(reparked.includes('Use staging or production?'), `the parked Question is reachable again:\n${reparked}`)
  assert.ok(reparked.includes('awaiting answer'), `and renders as awaiting an answer:\n${reparked}`)

  // Authority ends the interaction: with no other work or failure attention,
  // BOTH the attention figure and the trigger disappear — the affordance never
  // outlives the truth that produced it.
  await parkQuestion()
  queuedReply = true
  projectionListener?.()
  await settle()
  await vt.waitForRender()
  const ended = vt.getViewport().join('\n')
  assert.ok(!ended.includes('? 1 awaiting'), `a queued reply removes the attention figure:\n${ended}`)
  assert.ok(!ended.includes('↓ view'), `and the trigger with it:\n${ended}`)
  assert.equal(app.isTasksActive(), false, 'nothing is reachable any more')


})

test('M3-5 PR1 L6: the Direct child viewer derives its display subject from SessionStatus(childId) and never leaks the parent', async (t) => {
  // The decisive Direct application proof: the REAL Task Center/viewer entry
  // mounts the child, and the status/footer sink shows the child's OWN
  // SessionStatus facts (model/preset/permission/cwd/context/usage/todos)
  // resolved through backend.sessionReader.sessionStatus(childId).
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-display-subject-l6-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  // Wide enough that the default footer preset keeps the model/context/token
  // items (the narrow 80-column budget legitimately drops them).
  const vt = new VirtualTerminal(140, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const childACwd = join(home, 'child-a-ws')
  const childBCwd = join(home, 'child-b-ws')
  const parent = fakeSession({
    id: 'display-subject-parent',
    header: { id: 'display-subject-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      ...sessionEvents('parent answer'),
      event('todo/write', { todos: [{ content: 'PARENT-TODO-V1', status: 'in_progress' }] }, 6),
    ],
  })
  const childA = fakeSession({
    id: 'display-subject-child-a',
    header: { id: 'display-subject-child-a', cwd: childACwd, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('child a answer'),
  })
  const childB = fakeSession({
    id: 'display-subject-child-b',
    header: { id: 'display-subject-child-b', cwd: childBCwd, createdAt: 1_700_000_000_002, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('child b answer'),
  })
  const subagents = {
    listDescendants: async () => [
      { kind: 'child', id: childA.id, label: 'child display subject A', mode: 'continuable', activity: 'running', hasChildren: false, parentId: parent.id, depth: 1 },
      { kind: 'child', id: childB.id, label: 'child display subject B', mode: 'continuable', activity: 'running', hasChildren: false, parentId: parent.id, depth: 1 },
    ],
  }
  const harness = makeHarness(home, [parent, childA, childB], { provider: 'p', model: 'parent-model' }, undefined, undefined, subagents)
  for (const id of [childA.id, childB.id]) {
    const handle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: id })
    life.defer(() => handle.dispose())
  }
  context = new Context()
  // The official Session-scoped projections the DirectSessionReader reads. Each
  // child carries DIFFERENT facts so a leak is immediately visible; the child's
  // `tokenUsage` (11/5) deliberately differs from its own bounded log fold
  // (10/2) so the sink proves the projection path, not the fold.
  // Child A's title/todos are MUTABLE: the invalidation regressions below move
  // the official projection and commit the corresponding durable event (the
  // real Host order), then require the display subject to follow WITHOUT a
  // turn/step boundary.
  let childATitle = 'child a title'
  let childATodos: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] = [
    { content: 'CHILD-A-TODO', status: 'in_progress' },
    { content: 'CHILD-A-TODO-2', status: 'pending' },
  ]
  let childAModel: { readonly provider: string; readonly model: string } = { provider: 'deepseek', model: 'child-a-model' }
  let childAPreset = 'child-a-preset'
  const statusValuesBySession: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    get [childA.id]() {
      return {
        get modelSelection() { return { lastUsed: childAModel } },
        get agentPreset() { return childAPreset },
        permissions: { currentValue: 'read-only' },
        get title() { return childATitle },
        goal: { goal: { objective: 'child a objective', phase: 'active' } },
        contextPressure: { projectedTokens: 100, contextWindow: 2000 },
        tokenUsage: { uncachedInputTokens: 11, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        get todos() { return childATodos },
      }
    },
    [childB.id]: {
      modelSelection: { lastUsed: { provider: 'deepseek', model: 'child-b-model' } },
      permissions: { currentValue: 'workspace-write' },
      title: 'child b title',
      contextPressure: { pressureTokens: 300, contextWindow: 4000 },
      tokenUsage: { uncachedInputTokens: 21, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
      todos: [{ content: 'CHILD-B-TODO', status: 'pending' }],
    },
  }
  // Flipped by the negative control below: with the child's official
  // projection REMOVED, its bounded fold sum must never be presented as the
  // cumulative usage.
  let childAProjectionAvailable = true
  context.provide('sessionProjections', {
    snapshot: (session: { header: { id: string } }, keys?: readonly string[]) => {
      const values = session.header.id === childA.id && !childAProjectionAvailable
        ? {}
        : statusValuesBySession[session.header.id]
      if (values === undefined) return { values: {} }
      if (keys === undefined) return { values }
      return {
        values: Object.fromEntries(keys
          .filter(key => key in values)
          .map(key => [key, (values as Record<string, unknown>)[key]])),
      }
    },
    stateOf: (_session: unknown, key: string) => key === 'turnBoundary'
      ? { 'next-step': [], 'next-turn': [] }
      : undefined,
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await settle()
  await vt.waitForRender()
  const mainSnapshot = probe.capturedChildStatus
  assert.equal(mainSnapshot, undefined, 'the main subject commits no child snapshot')

  // Both children are RUNNING live agents (their catalog row and the exact
  // Agent status agree).
  for (const session of [childA, childB]) {
    ;(liveAgentOf(harness, session.id) as { status: 'idle' | 'running' }).status = 'running'
  }
  // The REAL Task Center entry mounts child A.
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'child A must mount through the real Task Center entry')

  const aStatus = probe.capturedChildStatus
  assert.ok(aStatus, 'the child display subject must commit a StatusStore snapshot')
  assert.deepEqual(aStatus.view.subject, {
    kind: 'subagent',
    id: childA.id,
    label: 'child display subject A',
    mode: 'continuable',
    activity: 'running',
  })
  // Every Session-owned section is the CHILD's own SessionStatus.
  assert.deepEqual(aStatus.composition, {
    model: { provider: 'deepseek', id: 'child-a-model', displayName: 'child-a-model' },
    agentPreset: { id: 'child-a-preset', label: 'child-a-preset' },
  })
  assert.deepEqual(aStatus.access.permissionPreset, { id: 'read-only', label: 'read-only', matched: true })
  assert.equal(aStatus.workspace.cwd, childACwd, 'the child workspace must be the child session cwd')
  assert.deepEqual(aStatus.usage.tokens, { input: 11, output: 5, cacheRead: 0, cacheWrite: 0 },
    'the CHILD cumulative tokens are the official tokenUsage projection (11/5), not the bounded log fold (10/2)')
  assert.deepEqual(aStatus.usage.context, { usedTokens: 100, windowTokens: 2000, percent: 5 })
  assert.equal(aStatus.usage.turns, 1, 'turns stay the child fold’s own presentation fact')
  assert.equal(aStatus.usage.steps, 1)
  const aPresentation = probe.capturedDisplaySubject?.presentation
  assert.ok(aPresentation, 'the child display-subject presentation must travel in the same commit')
  assert.equal(aPresentation.sessionId, childA.id)
  assert.equal(aPresentation.workspaceRoot, childACwd)
  assert.equal(aPresentation.title, 'child a title')
  assert.deepEqual(aPresentation.todos, [
    { content: 'CHILD-A-TODO', status: 'in_progress' },
    { content: 'CHILD-A-TODO-2', status: 'pending' },
  ])
  // The legacy display fields describe the LIVE session (M3-5 PR1 contract
  // decision) and never re-point to the child; the child's own goal is a
  // presentation fact.
  assert.equal(probe.capturedDisplaySubject?.legacy?.cwd, home,
    'a child subject must not re-point the live-session legacy fields')
  assert.equal(probe.capturedDisplaySubject?.legacy?.model, 'p/parent-model',
    'the live-session legacy model stays the LIVE model')
  assert.match(aPresentation.goal ?? '', /^goal ● child a objective$/u)
  // The PARENT's facts are nowhere on the child subject.
  assert.notEqual(aStatus.workspace.cwd, home)
  assert.notEqual(aStatus.composition.model?.id, 'parent-model')
  // …and the child's OWN facts are ACTUALLY RENDERED (not merely captured):
  // model/provider, permission, the official cumulative tokens (11/5, never
  // the bounded fold's 10/2), the official context window, the child todo
  // count and the child workspace.
  const viewA = vt.getViewport().join('\n')
  assert.ok(viewA.includes('‹ back'), `the viewer subject bar must render:\n${viewA}`)
  assert.ok(viewA.includes('child display subject A'), `the child label must render:\n${viewA}`)
  assert.ok(viewA.includes('child-a-ws'), `the child workspace must render:\n${viewA}`)
  assert.ok(viewA.includes('deepseek/child-a-model'), `the child model must render:\n${viewA}`)
  assert.ok(!viewA.includes('[subagent · continuable]'), `the retired viewer badge must not render:\n${viewA}`)
  assert.ok(viewA.includes('[read-only]'), `the child permission must render:\n${viewA}`)
  assert.ok(viewA.includes('↑11'), `the official child input tokens must render:\n${viewA}`)
  assert.ok(viewA.includes('↓5'), `the official child output tokens must render:\n${viewA}`)
  assert.ok(viewA.includes('100/2.0k'), `the official child context must render:\n${viewA}`)
  assert.ok(viewA.includes('2 active · CHILD-A-TODO'),
    `the child todo summary/count must render (the parent has 1):\n${viewA}`)
  assert.ok(viewA.includes('goal ● child a objective'), `the child goal must render:\n${viewA}`)
  assert.ok(!viewA.includes('PARENT-TODO-V1'), `the parent todo summary must not render:\n${viewA}`)
  // WHOLE-VIEWPORT negative control (M3-5 PR1 §5/§9.6): the parent session's
  // model and session identity must not remain visible ANYWHERE on the child
  // surface — not in the footer and not in the main session's welcome card
  // (which is hidden while the display subject is the child).
  assert.ok(!viewA.includes('p/parent-model'), `the parent model must not render anywhere on the child surface:\n${viewA}`)
  assert.ok(!viewA.includes('display-subject-parent'), `the parent session identity must not render anywhere on the child surface:\n${viewA}`)

  // ── UX-1 (three-UX-fixes plan §4/§7 E1): the working row follows the
  // DISPLAYED child's own activity through the REAL Direct viewer path. The
  // child's `turn/end` durable event parks the viewer activity
  // (`viewer.endTurn()` → `refreshFooter`/`refreshStatus` →
  // `commitDisplaySubject` → `reconcileWorkingRow`); the next `turn/start`
  // re-activates it. The Main session is idle throughout (its own fixture turn
  // already ended), so the row can only describe the child.
  assert.ok(viewA.includes('Working...'), `a running child must own the working row:\n${viewA}`)
  context.emit('session/event', childA as never, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 44))
  await settle()
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('Working...'),
    `the child's turn/end must clear the working row:\n${vt.getViewport().join('\n')}`)
  context.emit('session/event', childA as never, event('turn/start', { turn: 2 }, 45))
  await settle()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Working...'),
    `the child's next turn/start must re-arm the working row:\n${vt.getViewport().join('\n')}`)

  // INVALIDATION (M3-5 PR1 review R4): a child `session/title` alone — with NO
  // step/end / turn/end boundary around it — must re-derive the display subject
  // immediately. The Host commits the event AND its projection moves.
  childATitle = 'child a retitled'
  // The Host commits the durable event through its own Session append (the
  // production shape: the fake session's `append` is the same primitive the
  // other runner suites use).
  context.emit('session/event', childA as never, childA.append!('session/title', { title: 'child a retitled' }) as SessionEvent)
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedDisplaySubject?.presentation?.title, 'child a retitled',
    'a lone child session/title must reach the display-subject presentation without a boundary')
  const subjectAfterTitle = probe.displaySubject() as { readonly title?: string; readonly sessionId?: string } | undefined
  assert.equal(subjectAfterTitle?.sessionId, childA.id)
  assert.equal(subjectAfterTitle?.title, 'child a retitled',
    'the EXTENSION-visible display-subject title must follow a lone child session/title immediately')
  // The BAR follows the same title-only change even though no StatusStore
  // SECTION changed (the store therefore does not notify); the presentation
  // projection is re-read at the atomic commit point.
  assert.ok(app.viewerSubjectBarRenderRowsForTest().join('\n').includes('child a retitled'),
    'a lone child session/title must refresh the subject bar without any store section change')

  // The same for a child `todo/write`: the display-subject todo list (and the
  // rendered summary line) must follow immediately.
  childATodos = [
    { content: 'CHILD-A-TODO-3', status: 'in_progress' },
    { content: 'CHILD-A-TODO-4', status: 'pending' },
    { content: 'CHILD-A-TODO-5', status: 'pending' },
  ]
  context.emit('session/event', childA as never, event('todo/write', { todos: [...childATodos] }, 41))
  await settle()
  await vt.waitForRender()
  assert.deepEqual(probe.capturedDisplaySubject?.presentation?.todos, childATodos,
    'a lone child todo/write must reach the display-subject presentation without a boundary')
  assert.equal(probe.capturedChildStatus?.activity.todoCount, 3)
  const viewTodoWrite = vt.getViewport().join('\n')
  assert.ok(viewTodoWrite.includes('3 active · CHILD-A-TODO-3'),
    `the rendered child todo summary must follow the lone todo/write:\n${viewTodoWrite}`)
  assert.ok(viewTodoWrite.includes('child a retitled'),
    `the committed child title must render in the subject bar:\n${viewTodoWrite}`)

  // INVALIDATION (M3-5 PR1 review R4): a lone child `model/selection` — the
  // durable model-selection commit, which can land outside a turn — and a lone
  // `agent-preset/selected` must re-derive the display subject immediately. Both
  // officially move `modelSelection` / `agentPreset`, which
  // `DirectSessionReader.sessionStatus` reads.
  childAModel = { provider: 'deepseek', model: 'child-a-model-v2' }
  context.emit('session/event', childA as never, event('model/selection', { provider: 'deepseek', model: 'child-a-model-v2' }, 42))
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-a-model-v2',
    'a lone child model/selection must reach the committed display subject')
  assert.ok(vt.getViewport().join('\n').includes('deepseek/child-a-model-v2'),
    `the subject bar must follow a lone child model/selection:\n${vt.getViewport().join('\n')}`)

  childAPreset = 'child-a-preset-v2'
  context.emit('session/event', childA as never, event('agent-preset/selected', { agentPreset: 'child-a-preset-v2' }, 43))
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.agentPreset?.id, 'child-a-preset-v2',
    'a lone child agent-preset/selected must reach the committed display subject')

  // A LATE parent refresh (a main todo/write + a main turn boundary) while the
  // child is displayed must never repaint the child subject with parent facts.
  context.emit('session/event', parent as never, event('todo/write', { todos: [{ content: 'PARENT-TODO-V2', status: 'pending' }] }, 7))
  // The LIVE parent's fold advances while the child owns the screen (an
  // ordinary second turn: the main stats fold counts at step/end) and the
  // status refresh keeps selecting the CHILD — the live legacy slot must still
  // follow the parent's current facts.
  context.emit('session/event', parent as never, event('turn/start', { turn: 1 }, 8))
  context.emit('session/event', parent as never, event('step/start', { turn: 1, step: 0 }, 81))
  context.emit('session/event', parent as never, event('step/end', { turn: 1, step: 0 }, 82))
  // NO child event is emitted here: the parent's OWN `step/end` (a cheap event
  // that advances the live fold but triggers no other refresh path) must refresh
  // the status and carry the LIVE sibling facts forward (M3-5 PR1 review R9).
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.view.subject.kind, 'subagent',
    'the committed display subject must stay the child after a late parent refresh')
  assert.deepEqual(probe.capturedDisplaySubject?.presentation?.todos, childATodos,
    'the parent todo write must not replace the child’s presentation projection')
  // The legacy slot is the LIVE session's and must stay CURRENT: the parent fold
  // advanced while the child was displayed and the LAST parent event was a cheap
  // `step/end` with no child event after it, so only the LIVE-event trigger can
  // have refreshed these (M3-5 PR1 reviews R5/R9).
  assert.equal(probe.capturedDisplaySubject?.legacy?.cwd, home,
    'the live-session legacy fields describe the LIVE session (its own cwd)')
  assert.equal(probe.capturedDisplaySubject?.legacy?.turns, 2,
    'the LIVE turn counter must keep advancing while the child is displayed')
  assert.equal(probe.capturedDisplaySubject?.legacy?.steps, 2,
    'the LIVE step counter must keep advancing on a lone parent step/end')
  // …while the child's OWN sections and presentation are untouched by the parent.
  assert.equal(probe.capturedChildStatus?.workspace.cwd, childACwd)
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-a-model-v2')
  assert.deepEqual(probe.capturedDisplaySubject?.presentation?.todos, childATodos)

  // UX-1 discriminator (plan §4): the parent's own turn is LIVE now
  // (`workingActive` true), while the DISPLAYED child A is still running — the
  // row belongs to the child. Parking the child (`turn/end`) must clear the row
  // EVEN THOUGH Main is running: the visible row follows the committed display
  // subject, never the Main drivers.
  assert.ok(vt.getViewport().join('\n').includes('Working...'),
    `precondition: the displayed running child owns the row:\n${vt.getViewport().join('\n')}`)
  context.emit('session/event', childA as never, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 46))
  await settle()
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('Working...'),
    `an inactive displayed child must hide the row even while Main runs:\n${vt.getViewport().join('\n')}`)
  context.emit('session/event', childA as never, event('turn/start', { turn: 3 }, 47))
  await settle()
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Working...'),
    `the displayed child's own turn/start must re-arm the row:\n${vt.getViewport().join('\n')}`)

  // ── UX-2 (§7 E4/E5, L6): the DISPLAYED child's Activity LIFETIME through the
  // production Session-event route (`context.emit('session/event')` → the
  // event routing → the mounted viewer's own folder → canonical structure →
  // the compact card → the painted viewport). The Compact preset is required
  // for the collapsed Activity header; it is restored right after.
  const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')
  const activitySeconds = (text: string): number | undefined => {
    const match = /(?:Activity|Thought) (\d+)s/u.exec(plain(text))
    return match === null ? undefined : Number(match[1])
  }
  app.setDisplayPreset('compact')
  await settle()
  await vt.waitForRender()
  // A bounded wait for the coalesced runner commit + paint (a raw `settle()`
  // does not guarantee the transcript commit has been flushed).
  const waitForView = async (needle: string): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (plain(vt.getViewport().join('\n')).includes(needle)) return
      await new Promise(resolve => setTimeout(resolve, 50))
      await vt.waitForRender()
    }
    assert.fail(`the viewport never rendered ${JSON.stringify(needle)}:\n${plain(vt.getViewport().join('\n'))}`)
  }
  // Growth driven ONLY by the shared working repaint (this loop flushes the
  // terminal; it feeds no event and re-commits no transcript).
  const waitForGrowth = async (previous: number): Promise<number> => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 300))
      await vt.waitForRender()
      const current = activitySeconds(vt.getViewport().join('\n'))
      if (current !== undefined && current > previous) return current
    }
    assert.fail(`the Activity duration never grew past ${previous}s with no new event:\n${plain(vt.getViewport().join('\n'))}`)
  }
  context.emit('session/event', childA as never, childA.append!('tool/call', {
    turn: 3, step: 0, callId: 'ux2-child-call' as ToolCallId, name: 'bash', arguments: '{"command":"echo hi"}',
  }) as SessionEvent)
  context.emit('session/event', childA as never, childA.append!('tool/result', {
    turn: 3, step: 0,
    message: {
      id: MessageId('ux2-child-result'), role: 'tool',
      toolCallId: 'ux2-child-call' as ToolCallId,
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'tool', callId: 'ux2-child-call' as ToolCallId },
    },
  }) as SessionEvent)
  await waitForView('Bash echo hi')
  // The tool has SETTLED: from here the only driver is the working repaint.
  const childStill = activitySeconds(vt.getViewport().join('\n'))
  assert.ok(childStill !== undefined,
    `the displayed child's settled Activity must render:\n${vt.getViewport().join('\n')}`)
  const childSilent = await waitForGrowth(childStill)
  // The child's first visible assistant text is the proven boundary: the frozen
  // value must be what the user was just seeing (a streamless durable message
  // still proves its settlement time — plan §5.2), and it must then STOP.
  context.emit('session/event', childA as never, childA.append!('assistant/message', {
    turn: 3, step: 0,
    message: {
      id: MessageId('ux2-child-answer'), role: 'assistant',
      content: [{ type: 'text', text: 'child answer ux2' }], source: { kind: 'assistant' },
    },
  }) as SessionEvent)
  await waitForView('child answer ux2')
  const childFrozenView = plain(vt.getViewport().join('\n'))
  const childFrozen = activitySeconds(vt.getViewport().join('\n'))
  assert.ok(childFrozen !== undefined && childFrozen >= childSilent && childFrozen <= childSilent + 2,
    `the child's boundary must freeze the value the user saw (${childSilent}s -> ${childFrozen}s):\n${childFrozenView}`)
  await new Promise(resolve => setTimeout(resolve, 1_200))
  await vt.waitForRender()
  assert.equal(activitySeconds(vt.getViewport().join('\n')), childFrozen,
    `a closed child Activity must stop counting:\n${plain(vt.getViewport().join('\n'))}`)
  // ── UX-2 E5 at L6 (the plan's §7 chain): a settled Work closed BY an injected
  // Context row, a Reasoning lane closed by its own first VISIBLE assistant
  // text, and the owning turn/end — all through real `session/event` routing
  // into the mounted viewer's folder. Deterministic event times (the `event()`
  // helper stamps `base + seq` seconds), so the frozen durations are exact.
  context.emit('session/event', childA as never, event('turn/start', { turn: 4 }, 300))
  context.emit('session/event', childA as never, event('tool/call', {
    turn: 4, step: 0, callId: 'ux2-e5-a' as ToolCallId, name: 'bash', arguments: '{"command":"echo a"}',
  }, 301))
  context.emit('session/event', childA as never, event('tool/result', {
    turn: 4, step: 0,
    message: {
      id: MessageId('ux2-e5-a-result'), role: 'tool',
      toolCallId: 'ux2-e5-a' as ToolCallId,
      content: [{ type: 'text', text: 'a' }],
      source: { kind: 'tool', callId: 'ux2-e5-a' as ToolCallId },
    },
  }, 302))
  // An injected Context row (a merge-extensible producer kind, so the event is
  // assembled structurally like the other suites' `eventAt` fixtures).
  context.emit('session/event', childA as never, {
    type: 'user/message',
    seq: 310,
    time: 1_700_000_000_000 + 310_000,
    data: {
      id: MessageId('ux2-e5-ctx'), role: 'user',
      content: [{ type: 'text', text: 'injected context e5' }],
      source: { kind: 'skill-invocation', name: 'demo' },
    },
  } as unknown as SessionEvent)
  context.emit('session/event', childA as never, event('assistant/message', {
    turn: 4, step: 0,
    message: {
      id: MessageId('ux2-e5-reasoning'), role: 'assistant',
      content: [{ type: 'reasoning', text: 'e5 thought' }, { type: 'text', text: 'e5 answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [
      { type: 'chunk', time: 1_700_000_000_000 + 322_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'chunk', time: 1_700_000_000_000 + 322_000, chunk: { type: 'reasoning-delta', index: 0, text: 'e5 thought' } },
      { type: 'chunk', time: 1_700_000_000_000 + 323_000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'e5 thought' } } },
      { type: 'chunk', time: 1_700_000_000_000 + 325_000, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
      { type: 'chunk', time: 1_700_000_000_000 + 325_000, chunk: { type: 'text-delta', index: 1, text: 'e5 answer' } },
      { type: 'chunk', time: 1_700_000_000_000 + 326_000, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'e5 answer' } } },
    ],
  }, 321))
  context.emit('session/event', childA as never, event('turn/end', { turn: 4, reason: { kind: 'completed' } }, 330))
  await settle()
  await vt.waitForRender()
  const e5View = plain(vt.getViewport().join('\n'))
  assert.ok(e5View.includes('Context injection demo'),
    `the injected Context boundary row must render (collapsed form shows its provenance label):\n${e5View}`)
  const e5Durations = [...e5View.matchAll(/(?:Activity|Thought) (\d+)s/gu)].map(match => match[1])
  assert.deepEqual(e5Durations.slice(-2), ['9', '3'],
    `at L6: Context(+10s) closes the settled Tool Work (1s..10s = 9s) and the visible assistant text(+325s) closes the Reasoning lane (322s..325s = 3s):\n${e5View}`)

  app.setDisplayPreset('full')
  await settle()
  await vt.waitForRender()

  // Child A → child B through the SAME real Task Center entry: no A residue.
  input('\x1b')
  await settle()
  await vt.waitForRender()
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\x1b[B')
  await settle()
  input('\r')
  await settle()
  await vt.waitForRender()
  const bStatus = probe.capturedChildStatus
  assert.ok(bStatus, 'child B must commit its own display-subject snapshot')
  assert.equal(bStatus.view.subject.kind === 'subagent' ? bStatus.view.subject.id : undefined, childB.id,
    'child B must be the committed display subject')
  assert.equal(bStatus.composition.model?.id, 'child-b-model')
  assert.deepEqual(bStatus.access.permissionPreset, { id: 'workspace-write', label: 'workspace-write', matched: true },
    'B’s own permission, never A’s read-only')
  assert.equal(bStatus.workspace.cwd, childBCwd)
  assert.deepEqual(bStatus.usage.tokens, { input: 21, output: 9, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(bStatus.usage.context, { usedTokens: 300, windowTokens: 4000, percent: 8 },
    'pressureTokens is B’s numerator when projectedTokens is absent')
  assert.equal(bStatus.composition.agentPreset, undefined, 'B records no preset — A’s must not survive')
  assert.deepEqual(probe.capturedDisplaySubject?.presentation?.todos, [{ content: 'CHILD-B-TODO', status: 'pending' }])
  assert.equal(probe.capturedDisplaySubject?.presentation?.title, 'child b title')
  assert.equal(probe.capturedDisplaySubject?.presentation?.goal, undefined, 'A’s goal must not survive into B')
  assert.equal(probe.capturedDisplaySubject?.legacy?.cwd, home, 'B’s commit keeps the LIVE legacy facts')
  const viewB = vt.getViewport().join('\n')
  assert.ok(viewB.includes('child display subject B'), `the rendered subject bar must show B’s identity:\n${viewB}`)
  assert.ok(viewB.includes('child-b-ws'), `the rendered footer must show B’s workspace:\n${viewB}`)
  assert.ok(!viewB.includes('child-a-ws'), `A’s workspace must not survive into B:\n${viewB}`)
  assert.ok(!viewB.includes('child-a-model'), `A’s model must not survive into the subject bar:\n${viewB}`)
  assert.ok(!viewB.includes('child a retitled'), `A’s title must not survive into B’s subject bar:\n${viewB}`)

  // Child → main restores the parent subject.
  input('\x1b')
  await settle()
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('p/parent-model'), `the parent footer must return:\n${restored}`)
  assert.ok(restored.includes('display-subject-parent'), `the parent welcome card must return:\n${restored}`)
  assert.ok(!restored.includes('[subagent · continuable]'), `the viewer badge must clear:\n${restored}`)
  assert.ok(!restored.includes('‹ back'), `the subject bar must clear on exit:\n${restored}`)
  assert.ok(!restored.includes('child-b-ws'), `the child workspace must clear:\n${restored}`)
  // UX-1: the exit re-derives the row from the LATEST Main fields, not the
  // entry-time snapshot — the parent's own `turn/start` (emitted while the child
  // owned the surface) is still live, so the row returns as a MAIN row.
  assert.ok(restored.includes('Working...'),
    `the exit must show the LATEST Main working state:\n${restored}`)

  // NEGATIVE CONTROL: with child A's official SessionStatus projection REMOVED,
  // its bounded transcript fold sum (10/2) must NOT be presented as the
  // cumulative usage — an unavailable official fact OMITS the section instead
  // of folding the window or copying the parent.
  childAProjectionAvailable = false
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(
    probe.capturedChildStatus?.view.subject.kind === 'subagent' ? probe.capturedChildStatus.view.subject.id : undefined,
    childA.id,
    'child A must be the display subject again',
  )
  assert.equal(probe.capturedChildStatus?.usage.tokens, undefined,
    'the child cumulative tokens are ABSENT when the official projection cannot answer')
  assert.equal(probe.capturedChildStatus?.usage.context, undefined)
  const viewNoOfficial = vt.getViewport().join('\n')
  assert.ok(!viewNoOfficial.includes('↑10'),
    `the bounded fold's input sum must not stand in for the cumulative usage:\n${viewNoOfficial}`)
  assert.ok(!viewNoOfficial.includes('↑11'), `the removed official value must not linger:\n${viewNoOfficial}`)
  assert.ok(!viewNoOfficial.includes('↓'), `no token figures may render when the official usage is unavailable:\n${viewNoOfficial}`)
  assert.ok(!viewNoOfficial.includes('100/2.0k'), `no context window may render when the official child context is unavailable:\n${viewNoOfficial}`)
  assert.ok(viewNoOfficial.includes('child display subject A'), `the child identity must still render:\n${viewNoOfficial}`)
  assert.ok(viewNoOfficial.includes('model ?'),
    `an absent official child model must render the unknown token, never a parent value:\n${viewNoOfficial}`)
  assert.ok(!viewNoOfficial.includes('child-a-model'),
    `the removed official model must not linger in the subject bar:\n${viewNoOfficial}`)

  // ── UX-3 (three-UX-fixes plan §7 E6): the FULLSCREEN `‹ back` glyph runs the
  // REAL viewer exit. This is a real SGR press/release on the painted subject
  // bar through the production `onCellPress`/`onCellClick` seam and the
  // production `onSingleEscape` → `viewerRuntime.exitView()` route — never a
  // synthetic `setViewerMode(undefined)`.
  const generationBeforeBack = app.getViewerGeneration()
  app.setFullscreen(true)
  await settle()
  await vt.waitForRender()
  // A real interactive child draft: typing reaches the child's OWN seat slot,
  // so the exit's draft lifecycle is observable (the child draft is parked and
  // the preserved MAIN draft is written back to the seat).
  input('ux3 child draft')
  await settle()
  assert.ok(app.seatTextForTest().includes('ux3 child draft'),
    `the child draft must reach the seat before the exit:\n${app.seatTextForTest()}`)
  const fullscreenRows = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const barRow = fullscreenRows.findIndex(row => row.includes('‹ back'))
  assert.ok(barRow >= 0, `the subject bar must be painted in fullscreen:\n${fullscreenRows.join('\n')}`)
  vt.sendInput(`\x1b[<0;2;${barRow + 1}M`) // press the `‹` glyph cell
  vt.sendInput(`\x1b[<0;2;${barRow + 1}m`) // release on the same cell
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedViewerMode, undefined,
    'the glyph click must run the production viewer exit (setViewerMode(undefined))')
  assert.ok(app.getViewerGeneration() > generationBeforeBack,
    'the real exit must bump the viewer generation')
  const backToMain = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  assert.ok(!backToMain.includes('‹ back'),
    `the subject bar must clear after the glyph exit:\n${backToMain}`)
  assert.ok(backToMain.includes('display-subject-parent'),
    `the MAIN session must be restored after the glyph exit:\n${backToMain}`)
  // The draft lifecycle ran through the REAL exit: the child draft left the
  // seat and the preserved MAIN draft (empty in this fixture) was written back
  // — the child's text must never leak into the main draft. (The child ingress
  // release / focus / scroll restoration are the SAME `exitView()` route the
  // Esc suites exercise; this click proves the route is reached and completes.)
  assert.equal(app.seatTextForTest(), '',
    `the exit must restore the MAIN draft, never keep the child draft:\n${app.seatTextForTest()}`)
  // Independent lifecycle sinks of the CLICK exit (not inherited from the Esc
  // suites): the focus seat returns to the editor and the main transcript's
  // follow state is live (the viewer scope is fully unwound).
  assert.equal(app.focusSeatForTest(), 'editor',
    'the glyph exit must return the focus seat to the editor')
  const restoredScroll = app.fullscreenScrollForTest()
  assert.ok(restoredScroll !== undefined && restoredScroll.isFollowingEnd,
    `the glyph exit must leave the MAIN transcript following its end:\n${JSON.stringify(restoredScroll)}`)

  // ── UX-2 Main (L6): the MAIN subject's Activity lifetime through the same
  // production Session-event route, after the exit restored the main surface.
  app.setDisplayPreset('compact')
  await settle()
  await vt.waitForRender()
  context.emit('session/event', parent as never, parent.append!('tool/call', {
    turn: 1, step: 0, callId: 'ux2-main-call' as ToolCallId, name: 'bash', arguments: '{"command":"echo main"}',
  }) as SessionEvent)
  context.emit('session/event', parent as never, parent.append!('tool/result', {
    turn: 1, step: 0,
    message: {
      id: MessageId('ux2-main-result'), role: 'tool',
      toolCallId: 'ux2-main-call' as ToolCallId,
      content: [{ type: 'text', text: 'main' }],
      source: { kind: 'tool', callId: 'ux2-main-call' as ToolCallId },
    },
  }) as SessionEvent)
  await waitForView('Bash echo main')
  const mainStill = activitySeconds(vt.getViewport().join('\n'))
  assert.ok(mainStill !== undefined,
    `the MAIN settled Activity must render:\n${vt.getViewport().join('\n')}`)
  const mainSilent = await waitForGrowth(mainStill)
  assert.ok(mainSilent > mainStill,
    `the MAIN settled Activity must keep counting (${mainStill}s -> ${mainSilent}s):\n${vt.getViewport().join('\n')}`)
  app.setDisplayPreset('full')
})

test('F4-R1: a viewer follow-up refusal settles through the production viewer into the right draft sink (current merge vs stale map-only) and an accepted send restores nothing', async (t) => {
  // The connected production chain under test:
  //   TuiApp viewer follow-up (Enter in an interactive continuable viewer)
  //     -> TuiAppEvents.onSubagentSubmit (application-events.ts)
  //     -> deps.subagentDelivery.subagent.prompt(...) inside runOwned
  //     -> the REAL DirectSubagentPort reading the injected `subagents` service
  //     -> onResult/onError -> viewer.settleSubmit (viewer-runtime.ts)
  //     -> the current/stale draft sink.
  // Nothing here stubs onSubagentSubmit or calls setEditorText/
  // restoreSubagentDraft to manufacture the sink; the injected official prompt
  // surface is the only fake.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-viewer-settle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'viewer-settle-parent',
    header: { id: 'viewer-settle-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'viewer-settle-child',
    header: {
      id: 'viewer-settle-child',
      cwd: home,
      createdAt: 1_700_000_000_001,
      version: SESSION_FORMAT_VERSION,
      isSeeded: true,
      parentSession: parent.id,
    },
    events: [
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event('user/message', {
        id: MessageId('viewer-settle-first-prompt'),
        role: 'user',
        content: [{ type: 'text', text: 'child first prompt' }],
        source: { kind: 'user' },
      }, 2, 'append'),
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('viewer-settle-first-reply'),
          role: 'assistant',
          content: [{ type: 'text', text: 'child first reply' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 3, outputTokens: 2 },
        stream: [],
      }, 3, 'append'),
      event('step/end', { turn: 1, step: 1 }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })

  // The official prompt surface the REAL DirectSubagentPort reads lazily. A
  // held refusal lets the test move the viewer BETWEEN the send and the
  // settlement; an accepting arm is the positive control.
  const promptCalls: { childSessionId: string; delivery: string; content: readonly { type: string; text?: string }[] }[] = []
  const held: (() => void)[] = []
  let accepted = false
  const subagents = {
    listDescendants: async () => [{
      kind: 'child',
      id: child.id,
      label: 'settle child',
      mode: 'continuable',
      activity: 'inactive',
      hasChildren: false,
      parentId: parent.id,
      depth: 1,
    }],
    prompt: async (request: { childSessionId: string; delivery: string; content: readonly { type: string; text?: string }[] }) => {
      promptCalls.push(request)
      if (accepted) return { messageId: 'viewer-settle-accepted' }
      await new Promise<void>(resolve => { held.push(resolve) })
      // A refused continuation: the Direct adapter classifies this as
      // `stale-child`, a PROVEN rejection (never indeterminate).
      throw { code: 'subagent/not-resumable' }
    },
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  const openViewer = async (): Promise<void> => {
    await tasksHandler()
    await settle()
    await vt.waitForRender()
    input('\r')
    await settle()
    await vt.waitForRender()
    assert.notEqual(app.getViewerGeneration(), 0, 'the continuable child viewer must mount')
  }
  const typeText = (text: string): void => { for (const char of text) input(char) }
  const clearVisibleDraft = (): void => {
    const current = app.getDraft()
    for (let index = 0; index < current.length; index += 1) input('\x7f')
  }
  const noTranscriptRow = (text: string): boolean =>
    !(probe.capturedMessages ?? []).some(message => (message.text ?? '').includes(text))

  // ── 0. ACCEPTED positive control: the official prompt resolves ok, so the
  // production settlement restores NOTHING to either draft sink.
  await openViewer()
  accepted = true
  typeText('accepted follow-up')
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(promptCalls.length, 1, 'the production viewer submit must reach the official prompt exactly once')
  assert.equal(promptCalls[0]!.childSessionId, child.id)
  assert.deepEqual(promptCalls[0]!.content, [{ type: 'text', text: 'accepted follow-up' }])
  assert.equal(app.getDraft(), '', 'an accepted send must not restore the visible draft')
  input('\x1b')
  await settle()
  await vt.waitForRender()
  await openViewer()
  assert.equal(app.getDraft(), '', 'an accepted send must not restore into the child slot either')

  // ── 1. CURRENT-viewer refusal: the production settlement merges the failed
  // text beneath whatever the user typed while the send was in flight.
  accepted = false
  const generationAtCurrentSend = app.getViewerGeneration()
  typeText('first refusal text')
  input('\r')
  await settle()
  assert.equal(promptCalls.length, 2, 'the refusal submit must reach the official prompt')
  assert.equal(app.getDraft(), '', 'the submit clears the visible draft before the async delivery')
  typeText('newer text')
  held.at(-1)!()
  await settle()
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'newer text\n\nfirst refusal text',
    'a refusal for the still-current viewer must merge the failed text under the newer visible draft')
  assert.equal(app.getViewerGeneration(), generationAtCurrentSend, 'the current arm must not have moved the viewer')
  assert.ok(noTranscriptRow('first refusal text'), 'a refusal must never insert a fake transcript row')

  // ── 2. DELAYED refusal after the SAME child viewer closed before settle:
  // the current (parent) editor is untouched and the text goes to the
  // addressed child's map-only slot, surfacing only on re-entry.
  clearVisibleDraft()
  await settle()
  assert.equal(app.getDraft(), '', 'the editor must be empty before the delayed send')
  const generationAtDelayedSend = app.getViewerGeneration()
  typeText('delayed refusal text')
  input('\r')
  await settle()
  assert.equal(promptCalls.length, 3, 'the delayed submit must reach the official prompt')
  assert.equal(app.getDraft(), '', 'the delayed submit clears the visible draft before delivery')
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.ok(app.getViewerGeneration() > generationAtDelayedSend, 'Esc must close the viewer before the refusal settles')
  assert.equal(app.getDraft(), '', 'the parent editor is untouched while the delayed send is pending')
  held.at(-1)!()
  await settle()
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'a stale refusal must never touch the current visible editor')
  assert.ok(noTranscriptRow('delayed refusal text'), 'a stale refusal must never insert a fake transcript row')
  await openViewer()
  assert.equal(app.getDraft(), 'delayed refusal text',
    'the stale refusal must restore into the ADDRESSED child slot (surfaced when that child is viewed again)')
})

test('T6/T7: Direct viewer shows the child’s used model and follows later request headers without a registered projection', async (t) => {
  // The shipped `dsh-base` + TUI composition mounts `ctx.sessionProjections`
  // but registers no `modelSelection` unit (its only registrant is the API
  // SessionController row of the web bundle). Before this fix the child subject
  // bar therefore rendered `model ?` although the child Session had already
  // recorded the route it really used. This test drives the REAL runner entry
  // (`/tasks` → viewer) against a registry that owns no `modelSelection` key and
  // a child Session that really logged its `request/header`.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-direct-subagent-model-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(140, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const childACwd = join(home, 'model-child-a-ws')
  const childBCwd = join(home, 'model-child-b-ws')
  const parent = fakeSession({
    id: 'direct-model-parent',
    header: { id: 'direct-model-parent', cwd: home, createdAt: 1_700_000_000_100, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const childA = fakeSession({
    id: 'direct-model-child-a',
    header: { id: 'direct-model-child-a', cwd: childACwd, createdAt: 1_700_000_000_101, version: SESSION_FORMAT_VERSION },
    events: [
      ...sessionEvents('child a answer'),
      modelEvent('request/header', { header: { config: { provider: 'deepseek', model: 'child-a-used-model', reasoningEffort: 'high' } }, reason: 'initial' }, 6),
    ],
  })
  const childB = fakeSession({
    id: 'direct-model-child-b',
    header: { id: 'direct-model-child-b', cwd: childBCwd, createdAt: 1_700_000_000_102, version: SESSION_FORMAT_VERSION },
    events: [
      ...sessionEvents('child b answer'),
      modelEvent('request/header', { header: { config: { provider: 'deepseek', model: 'child-b-used-model' } }, reason: 'initial' }, 6),
    ],
  })
  const subagents = {
    listDescendants: async () => [
      { kind: 'child', id: childA.id, label: 'model child A', mode: 'continuable', activity: 'running', hasChildren: false, parentId: parent.id, depth: 1 },
      { kind: 'child', id: childB.id, label: 'model child B', mode: 'continuable', activity: 'running', hasChildren: false, parentId: parent.id, depth: 1 },
    ],
  }
  // The process default is deliberately labelled: a leak is unmistakable.
  const harness = makeHarness(home, [parent, childA, childB], { provider: 'global', model: 'global-default-model' }, undefined, undefined, subagents)
  for (const id of [childA.id, childB.id]) {
    const handle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: id })
    life.defer(() => handle.dispose())
  }
  context = new Context()
  // The official projection face: other keys ARE owned, `modelSelection` is
  // ABSENT (not null) for every Session — exactly the shipped registry.
  const ownedValues: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    [childA.id]: { permissions: { currentValue: 'workspace-write' } },
    [childB.id]: { permissions: { currentValue: 'read-only' } },
  }
  context.provide('sessionProjections', {
    snapshot: (session: { header: { id: string } }, keys?: readonly string[]) => {
      const values = ownedValues[String(session.header.id)] ?? {}
      if (keys === undefined) return { values: { ...values } }
      return {
        values: Object.fromEntries(keys
          .filter(key => key in values)
          .map(key => [key, (values as Record<string, unknown>)[key]])),
      }
    },
    stateOf: (_session: unknown, key: string) => key === 'turnBoundary'
      ? { 'next-step': [], 'next-turn': [] }
      : undefined,
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await settle()
  await vt.waitForRender()

  for (const session of [childA, childB]) {
    ;(liveAgentOf(harness, session.id) as { status: 'idle' | 'running' }).status = 'running'
  }

  // ── T6: the REAL Task Center entry mounts child A ─────────────────────────
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'child A must mount through the real Task Center entry')
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-a-used-model',
    'the committed display subject must carry the child Session’s own used route')
  assert.equal(probe.capturedChildStatus?.composition.model?.reasoningEffort, 'high',
    'the raw request-header effort must survive into the shared composition fact')
  const barA = app.viewerSubjectBarRenderRowsForTest().join('\n')
  assert.ok(barA.includes('deepseek/child-a-used-model'), `the SUBJECT BAR must show the child model:\n${barA}`)
  assert.ok(barA.includes('@high'), `the SUBJECT BAR must keep the used effort:\n${barA}`)
  assert.ok(barA.includes('model child A'), `the identity must still render:\n${barA}`)
  const viewA = vt.getViewport().join('\n')
  assert.ok(viewA.includes('[deepseek/child-a-used-model @high]'),
    `the child FOOTER model badge must read the SAME child fact:\n${viewA}`)
  assert.ok(!viewA.includes('model ?'), `the unknown stand-in must be gone for a child that requested:\n${viewA}`)
  assert.ok(!viewA.includes('global-default-model'), `the global default must never stand in for the child:\n${viewA}`)
  assert.ok(!viewA.includes('child-b-used-model'), `child B must not leak into A’s surface:\n${viewA}`)

  // ── T7: while mounted, the child makes a NEW request on a DIFFERENT model ──
  const appendToChildA = (type: string, data: unknown): SessionEvent =>
    childA.append!(type, data) as SessionEvent
  const explicitEvent = appendToChildA('request/header', {
    header: { config: { provider: 'anthropic', model: 'child-a-explicit-model', reasoningEffort: 'max' } },
    reason: 'change',
  })
  context.emit('session/event', childA as never, explicitEvent)
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-a-explicit-model',
    'EXPLICIT child route: the child’s own new request header owns the surface')
  assert.equal(probe.capturedChildStatus?.composition.model?.provider, 'anthropic')
  assert.equal(probe.capturedChildStatus?.composition.model?.reasoningEffort, 'max')
  assert.ok(app.viewerSubjectBarRenderRowsForTest().join('\n').includes('anthropic/child-a-explicit-model'),
    'the subject bar must follow the child’s own latest request')

  // DOCUMENTED REDUCTION (owner-approved scope): an unconsumed pending intent is
  // NOT reproduced by the compat source, so a lone `model/selection` must NOT
  // move the child surface — the latest USED route stays.
  const pendingEvent = appendToChildA('model/selection', {
    provider: 'google', model: 'child-a-pending-only-model', reasoningEffort: 'low',
  })
  context.emit('session/event', childA as never, pendingEvent)
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-a-explicit-model',
    'a lone child model/selection is OUT OF SCOPE for the compat read and must not move the surface')
  assert.ok(!app.viewerSubjectBarRenderRowsForTest().join('\n').includes('child-a-pending-only-model'),
    'the pending-only model must never reach the subject bar through this compat path')

  // The PARENT switching its own route while the child is displayed must not
  // touch the child surface.
  const parentSwitch = parent.append!('request/header', {
    header: { config: { provider: 'parent-provider', model: 'parent-after-switch', reasoningEffort: 'high' } },
    reason: 'change',
  }) as SessionEvent
  context.emit('session/event', parent as never, parentSwitch)
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-a-explicit-model',
    'a parent route switch must never repaint the displayed child')
  const viewAfterParentSwitch = vt.getViewport().join('\n')
  assert.ok(!viewAfterParentSwitch.includes('parent-after-switch'),
    `the parent’s new model must not leak into the child surface:\n${viewAfterParentSwitch}`)

  // ── T7 continued: child A → child B through the SAME real entry ───────────
  input('\x1b')
  await settle()
  await vt.waitForRender()
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\x1b[B')
  await settle()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'child-b-used-model',
    'child B must read ITS OWN request header')
  const viewB = vt.getViewport().join('\n')
  assert.ok(app.viewerSubjectBarRenderRowsForTest().join('\n').includes('deepseek/child-b-used-model'))
  assert.ok(!viewB.includes('child-a-explicit-model'), `A’s model must not survive into B:\n${viewB}`)
  assert.ok(!viewB.includes('child-a-pending-only-model'), `A’s pending-only intent must not survive into B:\n${viewB}`)

  // Leaving the viewer restores the MAIN subject's own facts.
  input('\x1b')
  await settle()
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(!restored.includes('‹ back'), `the subject bar must clear on exit:\n${restored}`)
  assert.ok(!restored.includes('child-b-used-model'), `the child model must not linger on the main subject:\n${restored}`)
})

test('T6b (owner item 1): a child that USED the same route as the process default reads it through the absence branch, never as a default fill', async (t) => {
  // The inherited-route case: the child's own `request/header` carries exactly
  // the process default's provider/model, so a default-fill bug would render the
  // SAME string and a broken compat read would render `model ?`. The test
  // therefore also moves the process default afterwards and requires the child
  // surface to stay on the route recorded in the child's OWN log.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-direct-model-inherited-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(140, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent = fakeSession({
    id: 'inherited-parent',
    header: { id: 'inherited-parent', cwd: home, createdAt: 1_700_000_000_300, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child = fakeSession({
    id: 'inherited-child',
    header: { id: 'inherited-child', cwd: join(home, 'inherited-child-ws'), createdAt: 1_700_000_000_301, version: SESSION_FORMAT_VERSION },
    events: [
      ...sessionEvents('inherited child answer'),
      modelEvent('request/header', {
        header: { config: { provider: 'shared', model: 'shared-inherited-model' } },
        reason: 'initial',
      }, 6),
    ],
  })
  const subagents = {
    listDescendants: async () => [
      { kind: 'child', id: child.id, label: 'inherited child', mode: 'continuable', activity: 'running', hasChildren: false, parentId: parent.id, depth: 1 },
    ],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'shared', model: 'shared-inherited-model' }, undefined, undefined, subagents)
  const handle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => handle.dispose())
  context = new Context()
  // The shipped registry: no `modelSelection` unit is registered for any Session.
  context.provide('sessionProjections', {
    snapshot: (session: { header: { id: string } }, keys?: readonly string[]) => {
      const values: Record<string, unknown> = String(session.header.id) === child.id
        ? { permissions: { currentValue: 'workspace-write' } }
        : {}
      if (keys === undefined) return { values: { ...values } }
      return { values: Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])) }
    },
    stateOf: (_session: unknown, key: string) => key === 'turnBoundary'
      ? { 'next-step': [], 'next-turn': [] }
      : undefined,
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await settle()
  await vt.waitForRender()
  ;(liveAgentOf(harness, child.id) as { status: 'idle' | 'running' }).status = 'running'
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the inherited child must mount through the real Task Center entry')
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'shared-inherited-model',
    'the child’s OWN used route must reach the display subject through the absence branch')
  assert.equal(probe.capturedChildStatus?.composition.model?.provider, 'shared')
  const bar = app.viewerSubjectBarRenderRowsForTest().join('\n')
  assert.ok(bar.includes('shared/shared-inherited-model'), `the subject bar must show the inherited-and-used route:\n${bar}`)
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('model ?'), `the unknown stand-in must be gone for a child that requested:\n${view}`)
  assert.ok(view.includes('[shared/shared-inherited-model]'), `the child footer badge must read the same fact:\n${view}`)

  // DISCRIMINATOR: a process-default FILL would move here; the child's own
  // recorded route must not.
  const defaultModel = harness.defaultModel as { saveSelection: (next: { provider: string; model: string }) => Promise<unknown> }
  await defaultModel.saveSelection({ provider: 'switched', model: 'switched-default-model' })
  const refresh = child.append!('todo/write', { todos: [{ content: 'INHERITED-REFRESH', status: 'pending' }] }) as SessionEvent
  context.emit('session/event', child as never, refresh)
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'shared-inherited-model',
    'the child surface must never follow the process default')
  const after = vt.getViewport().join('\n')
  assert.ok(!after.includes('switched-default-model'), `the changed process default must not leak into the child surface:\n${after}`)
  assert.ok(app.viewerSubjectBarRenderRowsForTest().join('\n').includes('shared/shared-inherited-model'),
    'the subject bar still renders the child’s own used route')
})

test('PERF (plan §5): the Direct compat read adds no perceptible refresh cost on a ≥2,000-event child Session', async (t) => {
  // Every durable child event makes the viewer re-derive the display subject,
  // which invokes the Direct compat read. The compat source answers from the
  // Session's own incrementally maintained `requestHeader()` (no log scan), so
  // this test drives the REAL routing on a 2,000+ event child Session and records
  // a per-event DISTRIBUTION (mean/p50/p95/max) for the same 100 appends with the
  // official `modelSelection` key absent (compat active) and present (compat
  // skipped). Numbers are printed; the assertion is a frame-budget ceiling.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-direct-model-perf-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(120, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  // 501 legal turns = 2,004 durable events, plus the child's own request header
  // (so the compat fold has a real value to find).
  const bulk: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 501; turn++) {
    bulk.push(event('turn/start', { turn }, seq++))
    bulk.push(event('step/start', { turn, step: 0 }, seq++))
    bulk.push(event('step/end', { turn, step: 0 }, seq++))
    bulk.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq++))
  }
  bulk.push(modelEvent('request/header', {
    header: { config: { provider: 'deepseek', model: 'perf-child-model', reasoningEffort: 'high' } },
    reason: 'initial',
  }, bulk.length))
  assert.equal(bulk.length, 2005, 'the perf fixture must exceed 2,000 legal durable events')
  const parent = fakeSession({
    id: 'perf-parent',
    header: { id: 'perf-parent', cwd: home, createdAt: 1_700_000_000_200, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child = fakeSession({
    id: 'perf-child',
    header: { id: 'perf-child', cwd: join(home, 'perf-child-ws'), createdAt: 1_700_000_000_201, version: SESSION_FORMAT_VERSION },
    events: bulk,
  })
  const subagents = {
    listDescendants: async () => [
      { kind: 'child', id: child.id, label: 'perf child', mode: 'continuable', activity: 'running', hasChildren: false, parentId: parent.id, depth: 1 },
    ],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'global', model: 'global-default-model' }, undefined, undefined, subagents)
  const handle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => handle.dispose())
  context = new Context()
  /** Flipped between the two measurement phases: the registry OWNS the
   *  official key only in the control phase. */
  let ownsOfficialKey = false
  context.provide('sessionProjections', {
    snapshot: (session: { header: { id: string } }, keys?: readonly string[]) => {
      const values: Record<string, unknown> = String(session.header.id) === child.id && ownsOfficialKey
        ? { modelSelection: { lastUsed: { provider: 'official', model: 'official-model' }, next: null } }
        : {}
      if (keys === undefined) return { values: { ...values } }
      return { values: Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])) }
    },
    stateOf: (_session: unknown, key: string) => key === 'turnBoundary'
      ? { 'next-step': [], 'next-turn': [] }
      : undefined,
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler)
  await settle()
  await vt.waitForRender()
  ;(liveAgentOf(harness, child.id) as { status: 'idle' | 'running' }).status = 'running'
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the perf child must be mounted in the viewer')
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'perf-child-model',
    'the compat read must already be live on this 2,005-event Session')

  const appendAndRefresh = (label: string): void => {
    const appended = child.append!('todo/write', { todos: [{ content: label, status: 'pending' }] }) as SessionEvent
    context!.emit('session/event', child as never, appended)
  }
  // Deterministic work counter (load-independent): every full-log read the status
  // path performs shows up here. The compat read must add ZERO log scans.
  const originalSnapshotEvents = child.snapshotEvents
  let logScans = 0
  child.snapshotEvents = () => { logScans += 1; return originalSnapshotEvents() }
  const measure = (phase: string, offset: number) => {
    logScans = 0
    const samples: number[] = []
    for (let index = 0; index < 100; index++) {
      const started = performance.now()
      appendAndRefresh(`PERF-${phase}-${offset + index}`)
      samples.push(performance.now() - started)
    }
    const sorted = [...samples].sort((left, right) => left - right)
    const at = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    console.log(
      `[perf] ${phase}: n=${samples.length} logScans=${logScans} mean=${mean.toFixed(3)} `
      + `p50=${at(0.5).toFixed(3)} p95=${at(0.95).toFixed(3)} max=${sorted[sorted.length - 1]!.toFixed(3)} ms/event`,
    )
    return { mean, p95: at(0.95), max: sorted[sorted.length - 1]!, logScans }
  }
  for (let index = 0; index < 10; index++) appendAndRefresh('PERF-warmup')
  await settle()
  await vt.waitForRender()
  const compat = measure('compat (modelSelection unit ABSENT)', 1000)
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'perf-child-model',
    'PHASE PROOF: with the key absent the surface reads the 2,005-event Session’s own request header')
  ownsOfficialKey = true
  const official = measure('official (modelSelection unit PRESENT)', 2000)
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedChildStatus?.composition.model?.id, 'official-model',
    'PHASE PROOF: once the key is owned the official value takes over (the compat read is skipped)')
  // The load-independent assertion: enabling the compat read must not add a single
  // Session-log scan to the refresh path (the only super-constant cost this lane
  // exists to rule out). The wall-clock figures are printed as a distribution and
  // guarded only by a generous stall ceiling, because the fixture's
  // `requestHeader()` is a naive re-derivation while production's is an
  // incrementally maintained cache — so the measured delta is an upper bound.
  assert.equal(compat.logScans, official.logScans,
    `the compat read must add no Session-log scan (compat ${compat.logScans}, official ${official.logScans})`)
  console.log(`[perf] compat overhead over the official path: mean ${(compat.mean - official.mean).toFixed(3)}`
    + ` p95 ${(compat.p95 - official.p95).toFixed(3)} max ${(compat.max - official.max).toFixed(3)} ms/event`)
  assert.ok(compat.p95 < 50,
    `no refresh lane may stall pathologically; measured p95 ${compat.p95.toFixed(3)} ms/event`)
})
