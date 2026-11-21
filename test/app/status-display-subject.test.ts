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
import { basename, join } from 'node:path'
import test, { afterEach } from 'node:test'
import { createStatusRuntime, type StatusLiveAgent, type StatusRuntimeDeps } from '../../src/app/surface/status-runtime.ts'
import { gitBranch } from '../../src/client/git/branch.ts'
import type { SessionStatusProjection } from '../../src/runtime/session-reader-port.ts'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import { StatusStore } from '../../src/domain/status/store.ts'
import { emptyStatusSnapshot, type StatusPatch, type StatusSnapshot } from '../../src/domain/status/types.ts'
import { ExtensionLedger } from '../../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../../src/extension/internal/surface-host.ts'
import { createBuiltinFooterRegistry } from '../../src/tui/footer/builtin-items.ts'
import { FooterComposer } from '../../src/tui/footer/composer.ts'
import { renderViewerSubjectBar } from '../../src/tui/presentation/viewer-subject-bar.ts'
import { TuiApp, type DisplaySubjectPresentation, type StatusData } from '../../src/tui-app.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

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

function makeHarness(options: {
  remote?: boolean
  /** A TRUE sessionless surface (no current Session id). */
  sessionless?: boolean
  /** The confirmed-save-with-unreadable-directory fact for the P2 status. */
  defaultUnavailable?: boolean
  /** M6-1 F8: the ONE session-policy observation the access derivation reads. */
  policyObservation?: { readSnapshot(sessionId: string): import('../../src/app/command/policy-observation-state.ts').PolicyObservationState; subscribe(listener: () => void): () => void }
  /** R10: a REAL Direct live Agent (session.id/header.cwd + options); absent = the Agent-less path. */
  liveAgent?: () => StatusLiveAgent | undefined
  /** R10: the dynamic current Session id (default 'main', or undefined when sessionless). */
  currentSessionId?: () => string | undefined
  /** R10: the resolved CLIENT working directory (default '/client'). */
  clientCwd?: string
  /** R10 (A6): share ONE StatusStore with a real TuiApp. */
  store?: StatusStore
  /** R10 (A6): route the atomic commit through the real `TuiApp.commitDisplaySubject` merge path. */
  commitStatus?: (patch: StatusPatch, legacy: Partial<StatusData>, presentation: DisplaySubjectPresentation | undefined) => void
} = {}): {
  runtime: ReturnType<typeof createStatusRuntime>
  commits: Commit[]
  store: StatusStore
  child: ViewerRead | undefined
  setChild(child: ViewerRead | undefined): void
  setStatus(sessionId: string, status: SessionStatusProjection | undefined): void
} {
  const store = options.store ?? new StatusStore(emptyStatusSnapshot())
  const commits: Commit[] = []
  const statuses = new Map<string, SessionStatusProjection>()
  const mainStats = new StatsFolder()
  let child: ViewerRead | undefined
  const runtime = createStatusRuntime({
    surface: {
      // Only commitStatus is exercised by refreshStatusCheap.
      app: {} as TuiApp,
      status: { snapshot: () => store.snapshot() },
      commitStatus: options.commitStatus ?? ((
        patch: StatusPatch,
        legacy: Partial<StatusData>,
        presentation: DisplaySubjectPresentation | undefined,
      ) => {
        commits.push({ patch, legacy, presentation })
        store.update(patch)
      }),
    },
    updateTerminalTitle: () => {},
    isCleanedUp: () => false,
    // The harness exercises the DIRECT (Agent-less) status path; the main
    // subject's sections are asserted from the store, not from a live Agent.
    liveAgent: options.liveAgent ?? (() => undefined),
    generation: () => 1,
    currentSessionId: options.currentSessionId ?? (options.sessionless === true ? () => undefined : () => 'main'),
    measureContext: () => 42,
    sessionStatus: (sessionId: string) => statuses.get(sessionId),
    model: {
      selection: () => undefined,
      currentOf: () => undefined,
      defaultSelection: () => undefined,
      defaultUnavailable: () => options.defaultUnavailable === true,
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
    ...options.policyObservation === undefined ? {} : { policyObservation: options.policyObservation },
    presentation: { mainStats: () => mainStats },
    viewer: { read: () => child },
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} },
    clientCwd: options.clientCwd ?? '/client',
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

/** A real FooterComposer over the builtin registry, to prove the `git-branch`
 *  item truly HIDES a Remote-live branch and SHOWS a Client-local one. */
const footerComposer = new FooterComposer(createBuiltinFooterRegistry())

/** Render ONLY the `git-branch` footer item from a real committed snapshot
 *  (ANSI-stripped) — the footer sink of the same status fact under test. */
function renderGitBranchFooter(snapshot: StatusSnapshot): string {
  return plain(footerComposer.render({
    snapshot,
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'git-branch' }], right: [] }] },
    width: 120,
    context: { taskBrowserAvailable: true, extensionFooterText: '' },
  }))
}

// Every real TuiApp constructed by the A6 combo test is disposed after each
// test — the vendored-fork process slot is released only by the FINAL dispose,
// never by stop() (mirrors test/domain/footer-view-subject.test.ts).
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

test('the main subject keeps the main view with the live session sections', () => {
  const h = makeHarness()
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  assert.deepEqual(h.store.snapshot().view, { subject: { kind: 'main' } })
  assert.equal(h.store.snapshot().workspace.cwd, '/client')
  assert.equal(commit.presentation, undefined, 'no display-subject projection on the main subject')
})

test('a sessionless Remote surface shows UNKNOWN (not no model) for a confirmed save whose directory is unreadable', () => {
  const unknown = makeHarness({ remote: true, sessionless: true, defaultUnavailable: true })
  unknown.runtime.refresh()
  assert.equal(unknown.commits.at(-1)!.legacy?.model, 'model unknown',
    'a confirmed default whose Host directory cannot be read is UNKNOWN, never fabricated')
  const absent = makeHarness({ remote: true, sessionless: true, defaultUnavailable: false })
  absent.runtime.refresh()
  assert.equal(absent.commits.at(-1)!.legacy?.model, 'no model',
    'a genuinely absent default stays no model')
})

test('every child Session-owned section comes from SessionStatus(childId)', () => {
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

test('an unavailable child SessionStatus leaves the Session-owned fields ABSENT (never the parent’s)', () => {
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
  // The child's workspace carries NO parent value; the display-only
  // `cwdUnavailable` flag states the unknown directory in words (S2/PR-B §B2 UI)
  // and is not a Session-owned fact.
  assert.deepEqual(snap.workspace, { cwd: '', cwdUnavailable: true },
    'no parent cwd may fill the child’s workspace, and the unknown state is stated')
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

test('child A → child B keeps no A residue', () => {
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

test('child → main re-derives the main subject from the main session', () => {
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

test('a REMOTE child’s Host cwd never implies a Client-local branch', (t) => {
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

test('the Remote main subject never retains a CHILD’s permission after the viewer closes', () => {
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

test('the child context numerator/window are the SessionStatus facts, never the fold', () => {
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

test('the viewer subject bar projects the SAME atomic snapshot the status runtime commits', () => {
  // Unit-level authority check (a fake StatusRuntime harness + the pure
  // renderer). The REAL L6 source→sink evidence lives in the runner suites
  // (runner-viewer-task-integration / runner-remote-task-center); this test
  // only pins the projection contract.
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
  assert.ok(barA.includes('‹ back') && barA.includes('research'), `the child identity must render:\n${barA}`)
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

test('TPS PR-2: the display subject’s OWN Host projection is the performance authority', () => {
  const h = makeHarness()
  // The MAIN session answers with a Host projection; the child does not.
  h.setStatus('main', {
    sessionId: 'main',
    performance: {
      recent: { outputTokens: 200, modelMs: 2000, samples: 2, firstTokenMs: 300, firstTokenSamples: 2 },
      all: { outputTokens: 500, modelMs: 5000, samples: 5 },
    },
  })
  h.setStatus('child-a', { sessionId: 'child-a', cwd: '/child-a/ws' })
  h.runtime.refresh()
  assert.deepEqual(h.commits.at(-1)!.patch.usage?.performance, {
    llmMs: 0,
    firstTokenMs: 150,
    tokensPerSec: 100,
    sessionTokensPerSec: 100,
  }, 'the main subject renders its own R5 + All + recent TTFB')

  // Main → child: the child has NO Host projection, so NOTHING is invented —
  // the parent's figures must not leak and no zero stand-in may appear.
  h.setChild(childRead('child-a', 'research'))
  h.runtime.refresh()
  assert.deepEqual(h.commits.at(-1)!.patch.usage?.performance, { llmMs: 0 },
    'an absent child projection omits every measured value (no parent fallback, no 0)')

  // The child's OWN projection then renders — not the parent's numbers.
  h.setStatus('child-a', {
    sessionId: 'child-a',
    cwd: '/child-a/ws',
    performance: {
      recent: { outputTokens: 30, modelMs: 1000, samples: 1, firstTokenMs: 0, firstTokenSamples: 1 },
      all: { outputTokens: 30, modelMs: 1000, samples: 1 },
    },
  })
  h.runtime.refresh()
  assert.deepEqual(h.commits.at(-1)!.patch.usage?.performance, {
    llmMs: 0,
    firstTokenMs: 0,
    tokensPerSec: 30,
    sessionTokensPerSec: 30,
  }, 'the child renders its own figures; a measured 0ms TTFB stays a visible zero, never absence')
})


test('M6-1 F8: sandbox/approval access facts come from the ONE observation of the DISPLAY SUBJECT', () => {
  const observation = (read: (sessionId: string) => import('../../src/app/command/policy-observation-state.ts').PolicyObservationState) => ({
    readSnapshot: read,
    subscribe: () => () => {},
  })
  // The main subject's proven facts ride the access section independently.
  const main = makeHarness({
    policyObservation: observation(sessionId => ({
      kind: 'ready',
      read: {
        kind: 'ready',
        sessionId,
        approval: { state: 'ready', effective: 'never', override: 'never' },
        sandbox: { state: 'ready', effective: 'read-only', override: 'read-only' },
      },
    })),
  })
  main.runtime.refresh()
  const mainAccess = main.store.snapshot().access
  assert.deepEqual(mainAccess.approval, { policy: 'never' })
  assert.deepEqual(mainAccess.sandbox, { mode: 'read-only' })
  assert.equal('enforcement' in (mainAccess.sandbox ?? {}), false, 'the policy fact never claims sandbox enforcement')

  // A viewed child reads the CHILD's OWN observed facts — never the parent's.
  const childObservation = makeHarness({
    policyObservation: observation(sessionId => sessionId === 'child-a'
      ? {
        kind: 'ready',
        read: {
          kind: 'ready',
          sessionId,
          approval: { state: 'ready', effective: 'ask' },
          sandbox: { state: 'ready', effective: 'workspace-write' },
        },
      }
      : { kind: 'checking' }),
  })
  childObservation.setStatus('child-a', {
    cwd: '/child-a/ws', permission: 'read-only', model: undefined, preset: undefined, todos: [],
  } as never)
  childObservation.setChild(childRead('child-a', 'research'))
  childObservation.runtime.refresh()
  const childAccess = childObservation.store.snapshot().access
  assert.deepEqual(childAccess.permissionPreset, { id: 'read-only', label: 'read-only', matched: true })
  assert.deepEqual(childAccess.approval, { policy: 'ask' }, 'the child approval is the child subject\'s own')
  assert.deepEqual(childAccess.sandbox, { mode: 'workspace-write' }, 'the child sandbox is the child subject\'s own')

  // A non-ready observation leaves those facts ABSENT (never a guessed default).
  const pending = makeHarness({ policyObservation: observation(() => ({ kind: 'checking' })) })
  pending.runtime.refresh()
  const pendingAccess = pending.store.snapshot().access
  assert.equal('approval' in pendingAccess, false)
  assert.equal('sandbox' in pendingAccess, false)
})


test('M6-1 F8: an invalidated Remote policy cannot leak the last-known sandbox/approval through the preset fallback', () => {
  // The historical §6.4 fallback keeps the last-known PRESET when the
  // permissions projection is unavailable. The independent sandbox/approval
  // facts must NOT ride that fallback: after a Connection generation change
  // (the observation answers checking) and an unavailable permission
  // projection, the footer may keep only the preset row.
  const pending = makeHarness({
    remote: true,
    policyObservation: {
      readSnapshot: () => ({ kind: 'checking' }),
      subscribe: () => () => {},
    },
  })
  // The PREVIOUS committed access still carries all three facts (the last Host).
  pending.store.update({
    access: {
      permissionPreset: { id: 'read-only', label: 'read-only', matched: true },
      sandbox: { mode: 'workspace-write' as const },
      approval: { policy: 'never' },
    },
  })
  pending.runtime.refresh()
  const access = pending.store.snapshot().access
  assert.deepEqual(access.permissionPreset, { id: 'read-only', label: 'read-only', matched: true },
    'the preset row keeps its subject-scoped last-known fallback')
  assert.equal('sandbox' in access, false,
    'the revoked sandbox fact must not survive through the preset fallback')
  assert.equal('approval' in access, false,
    'the revoked approval fact must not survive through the preset fallback')
})

// ─── R10: Remote Git branch locality ─────────────────────────────────────────
// The Client's `.git/HEAD` is a CLIENT filesystem fact. A Remote LIVE Session's
// cwd belongs to the Host, so it can never authorize reading this Client's
// `.git/HEAD` — its branch is omitted, never inferred. Direct and a Remote
// SESSIONLESS surface describe a directory on THIS Client and keep their local
// branch. Every case below drives the REAL `createStatusRuntime` + `gitBranch`.

/** Write a READABLE decoy branch into a checkout root — the local derivation
 *  CAN see it; the point is that a Remote LIVE Session must NOT. */
function decoy(root: string): string {
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/R10_CLIENT_DECOY\n')
  return root
}

test('R10 A1: a Remote live MAIN Session never shows a Client-local git branch, even from a readable checkout', (t) => {
  const root = decoy(testLifecycle(t).tempDir('dsh-pi-tui-r10-main-'))
  // Non-vacuous: this process CAN read the decoy branch from `root`.
  assert.equal(gitBranch(root), 'R10_CLIENT_DECOY')
  const h = makeHarness({ remote: true })
  h.setStatus('main', { sessionId: 'main', cwd: root })
  h.runtime.refresh()
  const snap = h.store.snapshot()
  assert.equal(snap.workspace.cwd, root, 'the Host cwd is the workspace fact')
  assert.equal(snap.workspace.project, basename(root), 'the project follows the Host cwd')
  assert.equal(snap.workspace.branch, undefined,
    'a Remote live MAIN branch is ABSENT — never the Client .git/HEAD')
  assert.equal(h.commits.at(-1)!.legacy.branch, '',
    'the legacy branch is EXPLICITLY cleared (maps to absence downstream)')
  assert.ok(!renderGitBranchFooter(snap).includes('R10_CLIENT_DECOY'),
    'the footer git-branch item stays hidden though the control directory is readable')
})

test('R10 A2: a Direct live main Session KEEPS the local git branch (locality is not over-restricted)', (t) => {
  const root = decoy(testLifecycle(t).tempDir('dsh-pi-tui-r10-direct-'))
  const h = makeHarness({
    liveAgent: () => ({ session: { id: 'main', header: { cwd: root } }, options: {} }),
  })
  h.setStatus('main', { sessionId: 'main', cwd: root })
  h.runtime.refresh()
  const commit = h.commits.at(-1)!
  assert.equal(commit.patch.workspace?.branch, 'R10_CLIENT_DECOY',
    'Direct main reads this machine’s own .git/HEAD')
  assert.equal(commit.legacy.branch, 'R10_CLIENT_DECOY', 'the legacy branch matches')
  assert.ok(renderGitBranchFooter(h.store.snapshot()).includes('R10_CLIENT_DECOY'),
    'the footer shows the Direct local branch')
})

test('R10 A3: a Remote main AND its viewed child both omit the Client branch, with no stale value across the transition', (t) => {
  const root = decoy(testLifecycle(t).tempDir('dsh-pi-tui-r10-child-'))
  const h = makeHarness({ remote: true })
  h.setStatus('main', { sessionId: 'main', cwd: root })
  h.setStatus('child-a', { sessionId: 'child-a', cwd: root })
  // MAIN: no branch.
  h.runtime.refresh()
  assert.equal(h.store.snapshot().workspace.branch, undefined, 'Remote main: no Client branch')
  assert.equal(h.commits.at(-1)!.legacy.branch, '', 'Remote main legacy: cleared')
  // ENTER child (its Host cwd is also a readable checkout): still no branch.
  h.setChild(childRead('child-a'))
  h.runtime.refresh()
  assert.equal(h.store.snapshot().workspace.branch, undefined, 'Remote child: no Client branch')
  assert.equal(h.commits.at(-1)!.legacy.branch, '',
    'the legacy slot (the LIVE/main owner) is cleared — never the child cwd’s')
  // EXIT back to main: still no branch, no child/main residue.
  h.setChild(undefined)
  h.runtime.refresh()
  assert.equal(h.store.snapshot().workspace.branch, undefined, 'back to Remote main: still no branch')
  assert.equal(h.commits.at(-1)!.legacy.branch, '', 'and the legacy branch stays cleared')
})

test('R10 A4: a Remote SESSIONLESS surface KEEPS its own Client launch-cwd branch (the distinguishing control)', (t) => {
  const root = decoy(testLifecycle(t).tempDir('dsh-pi-tui-r10-sessionless-'))
  const h = makeHarness({ remote: true, sessionless: true, clientCwd: root })
  h.runtime.refresh()
  const snap = h.store.snapshot()
  assert.equal(snap.workspace.cwd, root, 'the Client launch cwd is the Sessionless workspace')
  assert.equal(snap.workspace.branch, 'R10_CLIENT_DECOY',
    'Sessionless Remote reads its OWN Client .git/HEAD (no Host Session is open)')
  assert.equal(h.commits.at(-1)!.legacy.branch, 'R10_CLIENT_DECOY', 'the legacy branch matches')
  assert.ok(renderGitBranchFooter(snap).includes('R10_CLIENT_DECOY'),
    'the footer shows the Sessionless local branch')
})

test('R10 A5: Remote session switch / effective-cwd change / unavailable cwd never leave a Client branch or a stale value', (t) => {
  const life = testLifecycle(t)
  const rootA = decoy(life.tempDir('dsh-pi-tui-r10-a-'))
  const rootB = decoy(life.tempDir('dsh-pi-tui-r10-b-'))
  const rootC = decoy(life.tempDir('dsh-pi-tui-r10-c-'))
  let current: string | undefined = 'A'
  const h = makeHarness({ remote: true, currentSessionId: () => current })
  h.setStatus('A', { sessionId: 'A', cwd: rootA })
  h.setStatus('B', { sessionId: 'B', cwd: rootB })
  const noBranch = (label: string, expectedCwd: string): void => {
    const snap = h.store.snapshot()
    assert.equal(snap.workspace.cwd, expectedCwd, `${label}: cwd`)
    assert.equal(snap.workspace.project, basename(expectedCwd), `${label}: project`)
    assert.equal(snap.workspace.branch, undefined, `${label}: no Client branch`)
    assert.equal(h.commits.at(-1)!.legacy.branch, '', `${label}: legacy branch cleared`)
    assert.ok(!renderGitBranchFooter(snap).includes('R10_CLIENT_DECOY'), `${label}: footer hides branch`)
  }
  h.runtime.refresh(); noBranch('A', rootA)
  current = 'B'; h.runtime.refresh(); noBranch('A→B', rootB)
  // An OFFICIAL committed working-directory change (observable status value).
  h.setStatus('B', { sessionId: 'B', cwd: rootC }); h.runtime.refresh(); noBranch('B cwd change', rootC)
  current = 'A'; h.runtime.refresh(); noBranch('B→A (no residue)', rootA)
  // B returns but its status is GONE: the cwd is unavailable, never a fallback.
  current = 'B'; h.setStatus('B', undefined); h.runtime.refresh()
  const snap = h.store.snapshot()
  assert.equal(snap.workspace.cwd, '', 'unavailable: cwd is empty, never a Client fallback')
  assert.equal(snap.workspace.cwdUnavailable, true, 'unavailable: the fact is stated in words')
  assert.equal(snap.workspace.branch, undefined, 'unavailable: no branch')
  assert.equal(h.commits.at(-1)!.legacy.branch, '', 'unavailable: legacy branch cleared')
})

test('R10 A6: the real TuiApp legacy merge + Extension + Footer clear an old branch when a Remote live Session takes over', async (t) => {
  const root = decoy(testLifecycle(t).tempDir('dsh-pi-tui-r10-combo-'))
  // The Remote live Session's Host cwd IS this same readable checkout: the decoy
  // sits right there, yet Remote live must NOT show it (the airtight case).
  // ONE shared StatusStore wired into a REAL TuiApp + VirtualTerminal + Extension.
  const store = new StatusStore(emptyStatusSnapshot())
  const vt = new VirtualTerminal(120, 24)
  const extensionHost = new SurfaceHost(new ExtensionLedger(), () => {})
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store, extensionHost })
  app.start()
  startedApps.add(app)
  // Capture the legacy slot AND drive the REAL product merge path.
  const commits: Commit[] = []
  let current: string | undefined = undefined
  const h = makeHarness({
    remote: true,
    clientCwd: root,
    currentSessionId: () => current,
    store,
    commitStatus: (patch, legacy, presentation) => {
      commits.push({ patch, legacy, presentation })
      app.commitDisplaySubject(patch, legacy, presentation)
    },
  })
  h.setStatus('main', { sessionId: 'main', cwd: root })
  // Phase 1 — Remote SESSIONLESS: the Client launch-cwd branch is present.
  h.runtime.refresh()
  await vt.waitForRender()
  assert.equal(store.snapshot().workspace.branch, 'R10_CLIENT_DECOY',
    'Sessionless: the local branch is present (the OLD value)')
  assert.equal(extensionHost.state().session.branch, 'R10_CLIENT_DECOY',
    'Sessionless: the Extension v2 snapshot carries the branch')
  // Phase 2 — a Remote LIVE Session takes over (Host cwd = the same checkout).
  current = 'main'
  h.runtime.refresh()
  await vt.waitForRender()
  const snap = store.snapshot()
  assert.equal(snap.workspace.branch, undefined,
    'Remote live: the structured branch is ABSENT (the old value cleared)')
  assert.equal(commits.at(-1)!.legacy.branch, '',
    'Remote live: legacy branch \'\' drives the merge/Extension sync to CLEAR the old value')
  assert.equal(extensionHost.state().session.branch, undefined,
    'Remote live: the Extension v2 snapshot branch is cleared to undefined')
  assert.ok(!renderGitBranchFooter(snap).includes('R10_CLIENT_DECOY'),
    'Remote live: the real Footer Composer hides the branch')
})
