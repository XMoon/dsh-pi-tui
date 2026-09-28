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
  assert.deepEqual(viewerUsage?.tokens, { input: 21, output: 5, cacheRead: 0, cacheWrite: 0 })
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
  assert.ok(app.pendingInputForTest().steering.some(row => row.text === 'PARENT-STEER'),
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
  assert.ok(viewed.steering.some(row => row.text === 'CHILD-STEER' && row.rpcId === 'child-rpc'),
    `the child authoritative steering must be visible: ${JSON.stringify(viewed.steering)}`)
  assert.ok(!viewed.steering.some(row => row.text === 'PARENT-STEER'),
    'the parent pending row must not leak into the child viewer')

  // Leaving the viewer re-projects the MAIN subject: the child row must not leak.
  const mountedGeneration = app.getViewerGeneration()
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.ok(app.getViewerGeneration() > mountedGeneration, 'Esc must close the viewer')
  const restored = app.pendingInputForTest()
  assert.ok(!restored.steering.some(row => row.text === 'CHILD-STEER'),
    'the closed child pending row must not leak to the parent surface')
  assert.ok(restored.steering.some(row => row.text === 'PARENT-STEER'),
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

  // A vanished job must leave the parent usable: the registry lookup throws,
  // so openJobView opens nothing and reports keep-open.
  jobs.setEntries([])
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1,
    'a vanished job must not dismiss the parent browser')
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
