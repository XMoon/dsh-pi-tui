/**
 * M6-1/F5-B: the sessionless create gate around the ONE Workspace next-intent
 * owner. These cases pin the Host-request boundary the plan fixes:
 *
 * - UNSELECTED is a real state: the preflight and the first-session create
 *   dispatch ZERO Host calls, route the user to the existing Browser and keep
 *   the draft with the submission owner.
 * - an AUTO Client launch-cwd proposal is re-proved before the Host sees it and
 *   again before its WorkspaceId is adopted; revocation leaves the surface
 *   UNselected instead of adopting a stale local proof.
 * - a MANUAL confirmed Workspace survives `consumeAfterCommittedCreate`.
 *
 * @module @xmoon76/dsh-pi-tui/session-workspace-selection-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { bindSessionRuntime } from '../../src/app/session/runtime.ts'
import type { SessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import type { SessionRuntimeDeps, SessionRuntimeSurface } from '../../src/app/session/runtime.ts'
import { SessionOperationBarrier } from '../../src/app/session/operation-barrier.ts'
import { createWorkspaceNextIntentOwner } from '../../src/app/session/workspace-next-intent.ts'
import type { SessionLifecycle, ResolvedWorkspaceSelection } from '../../src/runtime/session-lifecycle-port.ts'
import { WorkspaceSelectionError } from '../../src/runtime/session-lifecycle-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'

interface SampledSurface {
  readonly surface: SessionRuntimeSurface
  readonly prompts: number
  readonly failures: string[]
  readonly resumed: number
}

function surface(options: {
  readonly awaitPendingDefaultWrite?: () => Promise<void>
} = {}): SampledSurface {
  const calls = { prompts: 0, failures: [] as string[], resumed: 0, compositions: 0 }
  const record = (..._args: unknown[]): void => {}
  const value: SessionRuntimeSurface = {
    warnRetirement: record,
    warnRetirementSkipped: record,
    isSurfaceDisposed: () => false,
    beginOpening: () => 1,
    clearOpening: record,
    settlePendingQueueRecalls: record,
    settleLocalSubmitAck: record,
    resetSubmitLatency: record,
    setCompletionOwner: record,
    initLiveSession: async () => {},
    refreshLiveCatalog: async () => {},
    reportSwitch: record,
    clearUnpinnedDrafts: () => {},
    withdrawReplacedPresentation: () => {},
    clearResumeFailure: () => {},
    retireStaleHistorySeat: () => {},
    beginInputHistoryScope: record,
    dropOutgoingActiveDraft: record,
    reportSwitchFailure: record,
    warnCommittedDurability: record,
    launchComposition: async () => {
      calls.compositions += 1
      return { composition: { agentPreset: 'default' } }
    },
    setResumeFailure: record,
    reportFirstSessionCreateFailure: (message: string) => { calls.failures.push(message) },
    promptWorkspaceSelection: () => { calls.prompts += 1 },
    notifyResumeFailure: () => { calls.resumed += 1 },
    awaitPendingDefaultWrite: options.awaitPendingDefaultWrite ?? (async () => {}),
    newSessionId: () => 'session-new',
    currentOpening: () => 1,
    resetOpening: record,
  }
  return {
    surface: value,
    get prompts() { return calls.prompts },
    get failures() { return calls.failures },
    get resumed() { return calls.resumed },
  }
}

interface HostTape {
  readonly lifecycle: SessionLifecycle
  readonly resolves: Array<{ readonly kind: string; readonly path?: string }>
  readonly creates: unknown[]
}

function lifecycle(options: {
  readonly resolve?: (intent: { readonly kind: string; readonly path?: string }) => Promise<ResolvedWorkspaceSelection>
} = {}): HostTape {
  const resolves: Array<{ readonly kind: string; readonly path?: string }> = []
  const creates: unknown[] = []
  const value = {
    resolveWorkspace: async (intent: { readonly kind: string; readonly path?: string }) => {
      resolves.push({ kind: intent.kind, ...(intent.path === undefined ? {} : { path: intent.path }) })
      if (options.resolve !== undefined) return await options.resolve(intent)
      return { workspaceId: 'workspace-host', path: '/host/root' }
    },
    create: async (request: unknown) => {
      creates.push(request)
      return { ok: true }
    },
  } as unknown as SessionLifecycle
  return { lifecycle: value, resolves, creates }
}

function bind(input: {
  readonly launchCwd: string | undefined
  readonly provenance?: 'launch' | 'auto' | 'manual'
  readonly autoWorkspaceRevalidate?: () => boolean
  readonly host?: HostTape
  readonly sampled?: SampledSurface
  readonly resolve?: (intent: { readonly kind: string; readonly path?: string }) => Promise<ResolvedWorkspaceSelection>
  readonly awaitPendingDefaultWrite?: () => Promise<void>
}): {
  readonly runtime: ReturnType<typeof bindSessionRuntime>
  readonly owner: ReturnType<typeof createWorkspaceNextIntentOwner>
  readonly host: HostTape
  readonly sampled: SampledSurface
} {
  const owner = createWorkspaceNextIntentOwner(input.launchCwd, input.provenance)
  const host = input.host ?? lifecycle({ ...(input.resolve === undefined ? {} : { resolve: input.resolve }) })
  const sampled = input.sampled ?? surface({
    ...(input.awaitPendingDefaultWrite === undefined ? {} : { awaitPendingDefaultWrite: input.awaitPendingDefaultWrite }),
  })
  const core = {
    owner: () => undefined,
    gate: { run: <T>(task: () => Promise<T>) => task() },
    barrier: new SessionOperationBarrier(),
  } as unknown as SessionOwnershipCore
  const deps = {
    owners: {} as never,
    retirement: {} as never,
    lifecycle: host.lifecycle,
    workspaceNextIntent: owner,
    ...(input.autoWorkspaceRevalidate === undefined ? {} : { autoWorkspaceRevalidate: input.autoWorkspaceRevalidate }),
    lifecycleSignal: new AbortController().signal,
    surface: sampled.surface,
    isScopeCurrent: () => true,
    captureScope: () => ({ sessionId: undefined }),
    diag: createDiag({ stderrLevel: 'off' }),
  } as unknown as SessionRuntimeDeps
  return { runtime: bindSessionRuntime(core, deps), owner, host, sampled }
}

test('an UNSELECTED preflight dispatches ZERO Host calls', async () => {
  const { runtime, owner, host } = bind({ launchCwd: undefined })
  await runtime.preflightWorkspace()
  assert.deepEqual(host.resolves, [], 'no workspace resolution without a legal target')
  assert.equal(owner.snapshot().status, 'unselected')
  assert.equal(owner.capture(), undefined)
})

test('an AUTO proposal whose local evidence is revoked before the Host call resolves nothing', async () => {
  const { runtime, owner, host, sampled } = bind({ launchCwd: '/client/cwd', provenance: 'auto', autoWorkspaceRevalidate: () => false })
  await runtime.preflightWorkspace()
  assert.deepEqual(host.resolves, [], 'the revoked auto candidate never reaches the Host')
  assert.equal(owner.snapshot().status, 'unselected')
  assert.equal(owner.capture(), undefined)
  assert.deepEqual(sampled.failures, [], 'revocation is not a user-visible first-session failure')
})

test('an AUTO proposal verified at admission but revoked before adoption leaves the surface unselected', async () => {
  let current = true
  const { runtime, owner, host } = bind({
    launchCwd: '/client/cwd',
    provenance: 'auto',
    autoWorkspaceRevalidate: () => current,
    resolve: async () => {
      // The mount view changed while the Host was creating/validating.
      current = false
      return { workspaceId: 'workspace-host', path: '/host/root' }
    },
  })
  await runtime.preflightWorkspace()
  assert.deepEqual(host.resolves, [{ kind: 'host-path', path: '/client/cwd' }],
    'the automatic candidate is resolved through the official Host path route')
  assert.equal(owner.snapshot().status, 'unselected',
    'the Host may have registered the path, but the CLIENT proof is what authorizes adopting the id')
  assert.equal(owner.capture(), undefined)
})

test('an AUTO proposal keeps its provenance through the verified adoption', async () => {
  const { runtime, owner } = bind({ launchCwd: '/client/cwd', provenance: 'auto', autoWorkspaceRevalidate: () => true })
  await runtime.preflightWorkspace()
  assert.equal(owner.snapshot().status, 'confirmed')
  assert.equal(owner.snapshot().provenance, 'auto')
  assert.equal(owner.snapshot().workspaceId, 'workspace-host')
  const capture = owner.capture()
  assert.ok(capture !== undefined)
  owner.consumeAfterCommittedCreate(capture)
  assert.equal(owner.snapshot().status, 'unselected', 'the one-shot auto adoption is consumed')
})

test('an UNSELECTED first-session create refuses before any Host write and opens the existing Browser once', async () => {
  const { runtime, host, sampled } = bind({ launchCwd: undefined })
  await assert.rejects(runtime.ensureSession(), (error: unknown) =>
    error instanceof WorkspaceSelectionError && error.code === 'workspace/not-selected')
  assert.deepEqual(host.resolves, [], 'no Host workspace resolution')
  assert.deepEqual(host.creates, [], 'no Host Session create')
  assert.match(sampled.failures[0] ?? '', /Choose a Host workspace/u)
  assert.equal(sampled.prompts, 1, 'the EXISTING Workspace Browser is opened once')
})

test('a LAUNCH proposal keeps the historical Direct first-session flow', async () => {
  const { runtime, owner } = bind({ launchCwd: '/launch' })
  await runtime.preflightWorkspace()
  assert.equal(owner.snapshot().status, 'confirmed')
  assert.equal(owner.snapshot().provenance, 'launch')
})

test('review P1: a refused Add leaves the confirmed target intact for the first-session boundary', async () => {
  const { runtime, owner, host } = bind({ launchCwd: undefined })
  owner.setResolvedWorkspace('workspace-a', '/host/a')
  // A DIFFERENT directory verifies and is REFUSED (the real Add entry's
  // `beginPathVerification` → `rejectPathVerification` pair).
  const verification = owner.beginPathVerification('/host/b')
  owner.rejectPathVerification(verification, 'the Host refused the proposed workspace directory')
  assert.equal(owner.snapshot().status, 'rejected')
  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' },
    'the confirmed create target survives the refused verification')

  // The first-session boundary resolves the STILL-CONFIRMED target — never B,
  // and without re-proposing any Host path. (The create below is stopped at
  // the resolve boundary; the full commit flow is owned by the runner suites.)
  await runtime.preflightWorkspace()
  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' })
  assert.deepEqual(host.resolves, [], 'a confirmed target needs no preflight resolution')
  await runtime.ensureSession().catch(() => {})
  assert.deepEqual(host.resolves, [{ kind: 'workspace-id' }],
    'the first create consumes the confirmed WorkspaceId; the refused B path was never proposed')
  assert.deepEqual(owner.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' },
    'the refused verification did not replace the target')
})

test('review P2: a preflight-confirmed AUTO candidate is re-proved at the consumption boundary', async () => {
  let current = true
  const { runtime, owner, host } = bind({
    launchCwd: '/client/cwd',
    provenance: 'auto',
    autoWorkspaceRevalidate: () => current,
    resolve: async () => ({ workspaceId: 'workspace-auto', path: '/host/cwd' }),
  })
  // The mount preflight confirms the automatic candidate LONG before the user
  // sends the first message.
  await runtime.preflightWorkspace()
  assert.equal(owner.snapshot().status, 'confirmed')
  assert.equal(owner.snapshot().workspaceId, 'workspace-auto')
  assert.deepEqual(host.resolves, [{ kind: 'host-path', path: '/client/cwd' }])

  // The mount view changed in the preflight→first-create window.
  current = false
  await assert.rejects(runtime.ensureSession(), (error: unknown) =>
    error instanceof WorkspaceSelectionError && error.code === 'workspace/not-selected')
  assert.deepEqual(host.creates, [], 'no Session is created on a revoked auto proof')
  assert.equal(owner.snapshot().status, 'unselected', 'the revoked candidate leaves the surface unselected')
  assert.equal(owner.capture(), undefined)
  // The consumption gate never re-proposed the auto path to the Host.
  assert.deepEqual(host.resolves, [{ kind: 'host-path', path: '/client/cwd' }],
    'the revoked window adds NO second Host resolution')
})

test('review P2: an explicit MANUAL selection needs no Client proof at the consumption boundary', async () => {
  const resolveCalls: Array<{ readonly kind: string; readonly workspaceId?: string }> = []
  const { runtime, owner } = bind({
    launchCwd: undefined,
    resolve: async (intent) => {
      const record = intent as { kind: string; workspaceId?: string }
      resolveCalls.push({ kind: record.kind, ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }) })
      // Stop at the resolve boundary: the consumption GATE is the fact under
      // test, not the full create commit (owned by the runner suites).
      throw new WorkspaceSelectionError('refused', 'stopped for the gate test', 'workspace/invalid-path')
    },
  })
  owner.setResolvedWorkspace('workspace-manual', '/host/manual')
  await runtime.ensureSession().catch(() => {})
  assert.deepEqual(resolveCalls, [{ kind: 'workspace-id', workspaceId: 'workspace-manual' }],
    'a manual workspace-id reaches the create boundary WITHOUT any Client-cwd proof')
})

test('review EXT-P2 (final window): a mount-view change during the LAST default-write wait cancels the create dispatch', async () => {
  let current = true
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const enteredGate = new Promise<void>(resolve => { entered = resolve })
  const { runtime, owner, host } = bind({
    launchCwd: '/client/cwd',
    provenance: 'auto',
    autoWorkspaceRevalidate: () => current,
    resolve: async () => ({ workspaceId: 'workspace-auto', path: '/host/cwd' }),
    awaitPendingDefaultWrite: async () => {
      entered()
      await hold
    },
  })
  // The preflight and the entry boundary both pass; the create is now parked
  // in its FINAL await, immediately before the Host dispatch.
  await runtime.preflightWorkspace()
  assert.equal(owner.snapshot().status, 'confirmed')
  const pending = runtime.ensureSession()
  await enteredGate
  // The directory object behind the automatic candidate is replaced WHILE the
  // create waits — exactly the window the entry gate cannot see.
  current = false
  release()
  await assert.rejects(pending, (error: unknown) =>
    error instanceof WorkspaceSelectionError && error.code === 'workspace/not-selected')
  assert.deepEqual(host.creates, [],
    'the final gate must cancel the Host Session create when the proof expires during the last wait')
  assert.equal(owner.snapshot().status, 'unselected')
})
