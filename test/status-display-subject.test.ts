/**
 * M3-5 PR1 §11.2: the display-subject status derivation. ONE selector decides
 * which Session's status is displayed (the current main Session or the viewed
 * child Session); every Session-owned section of a child comes from
 * `SessionReader.sessionStatus(childId)` and nothing falls back to the parent,
 * the viewer's bounded StatsFolder, or a default.
 * @module @xmoon76/dsh-pi-tui/status-display-subject.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createStatusRuntime, type StatusRuntimeDeps } from '../src/app/surface/status-runtime.ts'
import type { SessionStatusProjection } from '../src/runtime/session-reader-port.ts'
import { StatsFolder } from '../src/domain/status/stats.ts'
import { StatusStore } from '../src/domain/status/store.ts'
import { emptyStatusSnapshot, type StatusPatch } from '../src/domain/status/types.ts'
import { renderViewerSubjectBar } from '../src/tui/presentation/viewer-subject-bar.ts'
import type { DisplaySubjectPresentation, StatusData, TuiApp } from '../src/tui-app.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** The viewed child identity the selector reads (ViewerRuntime's read model). */
interface ViewerRead {
  readonly id: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
  readonly activity: 'running' | 'inactive'
  readonly cwd: string
  readonly stats: StatsFolder
}

interface Commit {
  readonly patch: StatusPatch
  readonly legacy: Partial<StatusData>
  readonly presentation: DisplaySubjectPresentation | undefined
}

/** A stats fold with one completed turn/step (the viewer-local presentation). */
function childStats(): StatsFolder {
  const folder = new StatsFolder()
  folder.hydrate([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/end', seq: 1, time: 1, data: { turn: 1, step: 0 } },
  ] as never)
  return folder
}

function makeHarness(options: { remote?: boolean } = {}): {
  runtime: ReturnType<typeof createStatusRuntime>
  commits: Commit[]
  store: StatusStore
  child: ViewerRead | undefined
  setChild(child: ViewerRead | undefined): void
  setStatus(sessionId: string, status: SessionStatusProjection | undefined): void
} {
  const store = new StatusStore(emptyStatusSnapshot())
  const commits: Commit[] = []
  const statuses = new Map<string, SessionStatusProjection>()
  const mainStats = new StatsFolder()
  let child: ViewerRead | undefined
  const runtime = createStatusRuntime({
    surface: {
      // Only commitStatus is exercised by refreshStatusCheap.
      app: {} as TuiApp,
      status: { snapshot: () => store.snapshot() },
      commitStatus: (
        patch: StatusPatch,
        legacy: Partial<StatusData>,
        presentation: DisplaySubjectPresentation | undefined,
      ) => {
        commits.push({ patch, legacy, presentation })
        store.update(patch)
      },
    },
    updateTerminalTitle: () => {},
    isCleanedUp: () => false,
    // The harness exercises the DIRECT (Agent-less) status path; the main
    // subject's sections are asserted from the store, not from a live Agent.
    liveAgent: () => undefined,
    generation: () => 1,
    currentSessionId: () => 'main',
    measureContext: () => 42,
    sessionStatus: (sessionId: string) => statuses.get(sessionId),
    model: {
      selection: () => undefined,
      currentOf: () => undefined,
      defaultSelection: () => undefined,
      marker: () => undefined,
      preset: () => undefined,
    },
    host: () => ({
      permissionPresets: undefined,
      sandboxPolicy: undefined,
      approval: undefined,
      planMode: undefined,
      sessionProjections: undefined,
    }),
    ...options.remote === true ? { remote: { plan: () => undefined } } : {},
    presentation: { mainStats: () => mainStats },
    viewer: { read: () => child },
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} },
    clientCwd: '/client',
  } as unknown as StatusRuntimeDeps)
  const harness = {
    runtime,
    commits,
    store,
    get child() { return child },
    setChild: (next: ViewerRead | undefined) => { child = next },
    setStatus: (sessionId: string, status: SessionStatusProjection | undefined) => {
      if (status === undefined) statuses.delete(sessionId)
      else statuses.set(sessionId, status)
    },
  }
  return harness
}

function childRead(id: string, label = id): ViewerRead {
  return { id, label, mode: 'continuable', activity: 'running', cwd: '/child/header', stats: childStats() }
}

test('M3-5 PR1: the main subject keeps the main view with the live session sections', () => {
  const h = makeHarness()
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  assert.deepEqual(h.store.snapshot().view, { subject: { kind: 'main' } })
  assert.equal(h.store.snapshot().workspace.cwd, '/client')
  assert.equal(commit.presentation, undefined, 'no display-subject projection on the main subject')
})

test('M3-5 PR1: every child Session-owned section comes from SessionStatus(childId)', () => {
  const h = makeHarness()
  h.setStatus('main', {
    sessionId: 'main',
    model: { provider: 'parent', model: 'parent-model' },
    permission: 'danger-full-access',
  })
  h.setStatus('child-a', {
    sessionId: 'child-a',
    cwd: '/child-a/ws',
    model: { provider: 'deepseek', model: 'child-model', reasoningEffort: 'high' },
    preset: 'child-preset',
    permission: 'read-only',
    title: 'child title',
    goal: { objective: 'fix the build', phase: 'active' },
    context: { projectedTokens: 100, contextWindow: 2000 },
    usage: { uncachedInputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
    todos: [{ content: 'child todo', status: 'in_progress' }],
  })
  h.setChild(childRead('child-a', 'research'))
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  assert.deepEqual(commit.patch.view, {
    subject: { kind: 'subagent', id: 'child-a', label: 'research', mode: 'continuable', activity: 'running' },
  })
  assert.deepEqual(commit.patch.composition, {
    model: { provider: 'deepseek', id: 'child-model', displayName: 'child-model', reasoningEffort: 'high' },
    agentPreset: { id: 'child-preset', label: 'child-preset' },
  })
  assert.deepEqual(commit.patch.access, {
    permissionPreset: { id: 'read-only', label: 'read-only', matched: true },
  })
  assert.deepEqual(commit.patch.workspace, { cwd: '/child-a/ws', project: 'ws' })
  assert.equal(commit.patch.usage?.tokens?.input, 5)
  assert.equal(commit.patch.usage?.tokens?.output, 2)
  assert.deepEqual(commit.patch.usage?.context, { usedTokens: 100, windowTokens: 2000, percent: 5 })
  assert.equal(commit.patch.usage?.turns, 1, 'the child turn counter stays the viewer fold’s own fact')
  assert.equal(commit.patch.usage?.steps, 1)
  assert.deepEqual(commit.presentation, {
    sessionId: 'child-a',
    workspaceRoot: '/child-a/ws',
    title: 'child title',
    todos: [{ content: 'child todo', status: 'in_progress' }],
    goal: 'goal ● fix the build',
  })
  // The legacy display fields are the LIVE session's (their own facts — here the
  // Agent-less harness: the client cwd and no model), never the child's: the
  // extension's v2 live-session snapshot stays truthful while a child is shown.
  assert.equal(commit.legacy?.cwd, '/client', 'the live-session legacy slot keeps the LIVE cwd')
  assert.equal(commit.legacy?.model, 'no model', 'and the LIVE model, never the child’s')
  assert.match(commit.presentation?.goal ?? '', /^goal ● fix the build$/u,
    'the child goal badge is a display-subject presentation fact')
})

test('M3-5 PR1: an unavailable child SessionStatus leaves the Session-owned fields ABSENT (never the parent’s)', () => {
  const h = makeHarness()
  // The MAIN subject is committed first (the parent facts the child must not
  // inherit).
  h.store.update({
    view: { subject: { kind: 'main' } },
    composition: { model: { provider: 'parent', id: 'parent-model', displayName: 'parent-model' } },
    access: { permissionPreset: { id: 'danger-full-access', label: 'danger-full-access', matched: true } },
    workspace: { cwd: '/parent/ws' },
    usage: {
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 0, firstTokenMs: 0, tokensPerSec: 0 },
      turns: 9,
      steps: 9,
    },
  })
  h.setChild(childRead('cold-child'))
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  assert.equal(commit.patch.view?.subject.kind, 'subagent')
  const snap = h.store.snapshot()
  assert.deepEqual(snap.composition, {}, 'no parent model may fill the child’s composition')
  assert.deepEqual(snap.access, {}, 'no parent permission may fill the child’s access')
  assert.deepEqual(snap.workspace, { cwd: '' }, 'no parent cwd may fill the child’s workspace')
  assert.equal(snap.usage.tokens, undefined, 'no fold total may stand in for the child’s cumulative usage')
  assert.equal(snap.usage.context, undefined)
  assert.equal(commit.legacy?.cwd, '/client', 'the live-session legacy fields still describe the LIVE session')
  assert.deepEqual(commit.presentation, {
    sessionId: 'cold-child',
    workspaceRoot: '',
    title: '',
    todos: [],
    goal: undefined,
  })
})

test('M3-5 PR1: child A → child B keeps no A residue', () => {
  const h = makeHarness()
  h.setStatus('child-a', {
    sessionId: 'child-a',
    cwd: '/a',
    model: { provider: 'p', model: 'a' },
    permission: 'read-only',
    todos: [{ content: 'a todo', status: 'pending' }],
  })
  h.setStatus('child-b', {
    sessionId: 'child-b',
    cwd: '/b',
    model: { provider: 'p', model: 'b' },
    todos: [],
  })
  h.setChild(childRead('child-a'))
  h.runtime.refresh()
  h.setChild(childRead('child-b'))
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  const snap = h.store.snapshot()
  assert.equal(snap.composition.model?.id, 'b')
  assert.equal(snap.access.permissionPreset, undefined, 'B has no permission — A’s must not survive')
  assert.equal(snap.workspace.cwd, '/b')
  assert.deepEqual(commit.presentation?.todos, [])
  assert.equal(commit.legacy?.cwd, '/client', 'the live-session legacy fields still describe the LIVE session')
  assert.equal(snap.usage.tokens, undefined)
})

test('M3-5 PR1: child → main re-derives the main subject from the main session', () => {
  const h = makeHarness()
  h.setStatus('main', { sessionId: 'main', cwd: '/parent/ws', model: { provider: 'parent', model: 'm' } })
  h.setStatus('child-a', { sessionId: 'child-a', cwd: '/a', model: { provider: 'p', model: 'a' } })
  h.setChild(childRead('child-a'))
  h.runtime.refresh()
  h.setChild(undefined)
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  assert.deepEqual(h.store.snapshot().view, { subject: { kind: 'main' } })
  assert.equal(commit.presentation, undefined)
  assert.equal(h.store.snapshot().workspace.cwd, '/client', 'the main workspace is re-derived, not the child’s')
  assert.equal(commit.legacy.cwd, '/client')
})

test('M3-5 PR1: a REMOTE child’s Host cwd never implies a Client-local branch', (t) => {
  // A local checkout whose `.git/HEAD` the local derivation CAN read: the SAME
  // cwd proves a branch for a Direct (same-machine) child and must be omitted
  // for a Remote one.
  const root = testLifecycle(t).tempDir('dsh-pi-tui-display-branch-')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/m3-test\n')
  const direct = makeHarness()
  direct.setStatus('child-a', { sessionId: 'child-a', cwd: root })
  direct.setChild(childRead('child-a'))
  direct.runtime.refresh()
  assert.equal(direct.commits.at(-1)!.patch.workspace?.branch, 'm3-test',
    'a Direct child cwd is this process’s own filesystem — the local branch derivation is valid')

  const remote = makeHarness({ remote: true })
  remote.setStatus('child-a', { sessionId: 'child-a', cwd: root })
  remote.setChild(childRead('child-a'))
  remote.runtime.refresh()
  assert.equal(remote.commits.at(-1)!.patch.workspace?.branch, undefined,
    'a Remote child cwd is not a Client path — its branch must be omitted, never inferred')
})

test('M3-5 PR1: the Remote main subject never retains a CHILD’s permission after the viewer closes', () => {
  const h = makeHarness({ remote: true })
  h.setStatus('main', { sessionId: 'main', cwd: '/parent/ws' })
  h.setStatus('child-a', { sessionId: 'child-a', cwd: '/a', permission: 'read-only' })
  h.setChild(childRead('child-a'))
  h.runtime.refresh()
  assert.equal(h.commits.at(-1)!.patch.access?.permissionPreset?.id, 'read-only')
  // The main permission projection cannot answer right now.
  h.setChild(undefined)
  h.runtime.refresh()
  assert.equal(h.commits.at(-1)!.patch.access?.permissionPreset, undefined,
    'the child’s permission must never become the main session’s retained value')
})

test('M3-5 PR1: the child context numerator/window are the SessionStatus facts, never the fold', () => {
  const h = makeHarness()
  const stats = new StatsFolder()
  stats.hydrate([
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/end', seq: 1, time: 1, data: { turn: 1, step: 0 } },
  ] as never)
  h.setStatus('child-a', {
    sessionId: 'child-a',
    cwd: '/a',
    context: { pressureTokens: 250, contextWindow: 5000 },
    usage: { uncachedInputTokens: 11, outputTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })
  h.setChild({ id: 'child-a', label: 'a', mode: 'one-shot', activity: 'inactive', cwd: '/a', stats })
  h.runtime.refresh()
  const usage = h.commits.at(-1)!.patch.usage!
  assert.deepEqual(usage.context, { usedTokens: 250, windowTokens: 5000, percent: 5 },
    'pressureTokens is the numerator when projectedTokens is absent')
  assert.deepEqual(usage.tokens, { input: 11, output: 22, cacheRead: 0, cacheWrite: 0 },
    'the cumulative tokens are the official projection’s, never a fold sum')
})

/** Strip ANSI SGR sequences for text-level bar assertions. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, '')
}

test('L6: the viewer subject bar projects the SAME atomic snapshot the status runtime commits', () => {
  const h = makeHarness()
  h.setStatus('main', {
    sessionId: 'main',
    model: { provider: 'parent', model: 'parent-model' },
    permission: 'danger-full-access',
  })
  const childAStatus = {
    sessionId: 'child-a',
    cwd: '/child-a/ws',
    model: { provider: 'deepseek', model: 'child-model', reasoningEffort: 'high' },
    preset: 'child-preset',
    permission: 'read-only',
    title: 'child title',
  } as const
  h.setStatus('child-a', childAStatus)
  h.setChild(childRead('child-a', 'research'))
  h.runtime.refresh()
  const barOf = (): string => plain(renderViewerSubjectBar({
    snapshot: h.store.snapshot(),
    childTitle: h.commits.at(-1)?.presentation?.title,
    width: 120,
  }))
  const barA = barOf()
  assert.ok(barA.includes('‹ parent') && barA.includes('research'), `the child identity must render:\n${barA}`)
  assert.ok(barA.includes('● running'), `the child activity must render:\n${barA}`)
  assert.ok(barA.includes('deepseek/child-model'), `the child provider/model must render:\n${barA}`)
  assert.ok(barA.includes('@high'), `the child effort must render:\n${barA}`)
  assert.ok(barA.includes('child title'), `the committed child title must render:\n${barA}`)
  assert.ok(!barA.includes('parent-model'), `the parent model must never fill the bar:\n${barA}`)

  // A child model/selection update re-derives the same snapshot; the bar follows.
  h.setStatus('child-a', { ...childAStatus, model: { provider: 'deepseek', model: 'child-model-v2' } })
  h.runtime.refresh()
  const barA2 = barOf()
  assert.ok(barA2.includes('deepseek/child-model-v2'), `the updated model must render:\n${barA2}`)
  assert.ok(!barA2.includes('child-model @'), `the old model must not linger:\n${barA2}`)

  // child A → child B (no model) → main: no residue, no parent fallback.
  h.setStatus('child-b', { sessionId: 'child-b', cwd: '/b' })
  h.setChild(childRead('child-b', 'audit'))
  h.runtime.refresh()
  const barB = barOf()
  assert.ok(barB.includes('audit'), `B’s label must render:\n${barB}`)
  assert.ok(barB.includes('model ?'), `B’s absent model renders the unknown token:\n${barB}`)
  assert.ok(!barB.includes('child-model'), `A’s model must not survive into B:\n${barB}`)
  assert.ok(!barB.includes('parent-model'), `the parent model must never fill B:\n${barB}`)

  h.setChild(undefined)
  h.runtime.refresh()
  assert.equal(renderViewerSubjectBar({ snapshot: h.store.snapshot(), width: 120 }), '',
    'the main subject renders no bar (zero rows)')
})
