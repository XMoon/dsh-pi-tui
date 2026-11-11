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

function surface(): SampledSurface {
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
    awaitPendingDefaultWrite: async () => {},
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
}): {
  readonly runtime: ReturnType<typeof bindSessionRuntime>
  readonly owner: ReturnType<typeof createWorkspaceNextIntentOwner>
  readonly host: HostTape
  readonly sampled: SampledSurface
} {
  const owner = createWorkspaceNextIntentOwner(input.launchCwd, input.provenance)
  const host = input.host ?? lifecycle({ ...(input.resolve === undefined ? {} : { resolve: input.resolve }) })
  const sampled = input.sampled ?? surface()
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
