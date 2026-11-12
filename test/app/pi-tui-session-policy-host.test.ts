/**
 * L2 IN_PROCESS: the private `piTuiSessionPolicy` Host bridge over the REAL
 * official `ctx.approval` and `ctx.sandboxPolicy` services, dispatched
 * through the REAL Typert Gateway with explicit peers, against REAL
 * production AgentLoop agents created through the harness registry.
 *
 * The approval service is mounted from the installed official package (the
 * same row the production Host runs); the sandbox-policy service is the one
 * the fixture already composes. The two-Client OS-process proof is the
 * split-process `session-policy` suite (M6-1 F8 L6).
 *
 * Evidence level: IN_PROCESS. It pins H01–H09 of the plan's §6.1 matrix.
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-session-policy-host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { PI_TUI_SESSION_POLICY_NAMESPACE } from '../../src/runtime/remote/pi-tui-session-policy-contract.ts'
import type { SessionPolicyRead, SessionPolicySetOutcome } from '../../src/runtime/session-policy-port.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

const SESSION_A = 'f8-policy-session-a'
const SESSION_B = 'f8-policy-session-b'

interface HostFixture {
  readonly ctx: Host['ctx']
  readonly peerOwner: PeerScope
  readonly peerSecondOwner: PeerScope
  readonly nonOwner: PeerScope
  invoke(method: string, args: Record<string, unknown>, peer?: PeerScope): Promise<unknown>
  dispose(): Promise<void>
}

async function hostFixture(life: TestLifecycle, presetId: string, options: { readonly withoutSandbox?: boolean } = {}): Promise<HostFixture> {
  const host = await createRemoteApplicationHostFixture(life, presetId, options.withoutSandbox === true ? { withoutSandbox: true } : {})
  // The H07 composition omits the sandbox provider on purpose; the unrelated
  // workspace-files prerequisite the in-process carrier asserts is stubbed so
  // only the sandbox axis is absent.
  if (options.withoutSandbox === true) host.ctx.provide('workspaceFiles', {} as never)
  // The REAL official approval service row (the same plugin the production
  // Host mounts); its projection seam (`sessionProjections`) is already live.
  const approval = await import('@deepseek-ai/dsh-user-approval')
  await host.ctx.plugin((approval as unknown as { default: unknown }).default as never, {} as never)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const connection = host.ctx.connection
  const peerOwner = connection.browserPeer
  const peerSecondOwner = connection.createPeer({ principal: { kind: 'owner' } })
  const nonOwner = connection.createPeer({ principal: { kind: 'viewer' } } as never)
  const gateway = host.ctx.typertGateway
  return {
    ctx: host.ctx,
    peerOwner,
    peerSecondOwner,
    nonOwner,
    invoke: (method, args, peer = peerOwner) => gateway.invoke({
      namespace: PI_TUI_SESSION_POLICY_NAMESPACE,
      method,
      args,
      peer,
      signal: new AbortController().signal,
    }),
    dispose: async () => {
      await Promise.all([peerSecondOwner.dispose(), nonOwner.dispose()])
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** Create one REAL production agent for `sessionId` through the registry. */
async function createLiveAgent(host: HostFixture, sessionId: string, cwd: string): Promise<void> {
  await host.ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: 'smoke', model: 'smoke' },
    meta: { cwd },
  })
}

function readOf(result: unknown): SessionPolicyRead {
  return result as SessionPolicyRead
}

function outcomeOf(result: unknown): SessionPolicySetOutcome {
  return result as SessionPolicySetOutcome
}

test('IN_PROCESS: two live sessions read their own independent policy facts (H01)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h01')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h01-a-'))
    await createLiveAgent(host, SESSION_B, life.tempDir('f8-h01-b-'))
    const outcome = outcomeOf(await host.invoke('setApproval', { sessionId: SESSION_A, policy: 'never' }))
    assert.deepEqual(outcome, { kind: 'applied', sessionId: SESSION_A })
    const readA = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    const readB = readOf(await host.invoke('read', { sessionId: SESSION_B }))
    assert.ok(readA.kind === 'ready' && readA.approval.state === 'ready')
    assert.equal(readA.approval.effective, 'never', 'session A carries its own override')
    assert.equal(readA.approval.override, 'never')
    assert.ok(readB.kind === 'ready' && readB.approval.state === 'ready')
    assert.equal(readB.approval.effective, 'ask', "session B keeps the deployment default — A's value never answers for B")
    assert.equal(readB.approval.override, undefined)
    assert.ok(readA.sandbox.state === 'ready' && readB.sandbox.state === 'ready')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: an already-effective ask write is the official no-op and still applies (H02/H05/A05)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h02')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h02-'))
    let policyEvents = 0
    host.ctx.on('session/event' as never, ((...args: unknown[]) => {
      const event = args[1] as { type?: string; data?: unknown } | undefined
      if (event?.type === 'approval/policy') policyEvents += 1
    }) as never)
    const before = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    assert.ok(before.kind === 'ready' && before.approval.state === 'ready' && before.approval.effective === 'ask')
    assert.equal(before.approval.override, undefined, 'no override exists yet')
    const outcome = outcomeOf(await host.invoke('setApproval', { sessionId: SESSION_A, policy: 'ask' }))
    assert.deepEqual(outcome, { kind: 'applied', sessionId: SESSION_A }, 'the official no-op still returns applied')
    const after = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    assert.ok(after.kind === 'ready' && after.approval.state === 'ready')
    assert.equal(after.approval.effective, 'ask')
    assert.equal(after.approval.override, undefined, 'the no-op appended no approval/policy event; override stays none — and that IS Verified')
    assert.equal(policyEvents, 0, 'the official setter appended nothing when already effective')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a real ask→never→ask switch records official events and leaves sandbox untouched (H03/H04)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h03')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h03-'))
    const policies: string[] = []
    host.ctx.on('session/event' as never, ((...args: unknown[]) => {
      const event = args[1] as { type?: string; data?: { policy?: string } } | undefined
      if (event?.type === 'approval/policy') policies.push(String(event.data?.policy))
    }) as never)
    const sandboxBefore = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    assert.ok(sandboxBefore.kind === 'ready' && sandboxBefore.sandbox.state === 'ready')
    const modeBefore = sandboxBefore.sandbox.effective
    for (const policy of ['never', 'ask'] as const) {
      assert.deepEqual(outcomeOf(await host.invoke('setApproval', { sessionId: SESSION_A, policy })), { kind: 'applied', sessionId: SESSION_A })
    }
    assert.deepEqual(policies, ['never', 'ask'], 'both real switches appended the official durable approval/policy events')
    const after = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    assert.ok(after.kind === 'ready' && after.approval.state === 'ready')
    assert.equal(after.approval.effective, 'ask')
    assert.equal(after.approval.override, 'ask', 'an explicit ask override now exists')
    assert.ok(after.sandbox.state === 'ready' && after.sandbox.effective === modeBefore,
      'the approval write never touched the sandbox knob')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a non-owner peer and a malformed policy are refused before any service read (H06)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h06')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h06-'))
    // The Gateway's OWN remote-access decision refuses a non-owner peer
    // BEFORE the Host method runs (outer door); the service's Owner gate is
    // the inner door (both are real refusals with zero service reads).
    await assert.rejects(() => host.invoke('read', { sessionId: SESSION_A }, host.nonOwner), /denied|restricted to the authenticated Owner/u)
    await assert.rejects(() => host.invoke('setApproval', { sessionId: SESSION_A, policy: 'ask' }, host.nonOwner), /denied|restricted to the authenticated Owner/u)
    // The strict parameter codec refuses a malformed policy before the Host
    // method runs at all.
    await assert.rejects(() => host.invoke('setApproval', { sessionId: SESSION_A, policy: 'always' }))
    await assert.rejects(() => host.invoke('read', { sessionId: '' }))
    const read = readOf(await host.invoke('read', { sessionId: SESSION_A }, host.peerSecondOwner))
    assert.ok(read.kind === 'ready', 'a second authenticated Owner reads the same Host truth')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a missing exact session is a definite unavailable/refused fact, never a guessed default (H08)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h08')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h08-'))
    assert.deepEqual(readOf(await host.invoke('read', { sessionId: 'f8-ghost' })), {
      kind: 'unavailable', sessionId: 'f8-ghost', reason: 'session-not-live',
    })
    assert.deepEqual(outcomeOf(await host.invoke('setApproval', { sessionId: 'f8-ghost', policy: 'never' })), {
      kind: 'refused', reason: 'session-not-live',
    })
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: an unknown configured approval default fails the read (H09)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h09')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h09-'))
    const approval = host.ctx.approval as unknown as { config: { policy?: string } }
    const original = approval.config.policy
    approval.config.policy = 'sometimes'
    try {
      await assert.rejects(() => host.invoke('read', { sessionId: SESSION_A }),
        /unknown policy|gateway\/internal|internal/iu)
    } finally {
      approval.config.policy = original
    }
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a Host with approval but no sandbox service still reads the approval side (H07)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-h07', { withoutSandbox: true })
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-h07-'))
    const read = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    assert.ok(read.kind === 'ready', 'the Host bridge itself remains readable without the sandbox service')
    assert.ok(read.approval.state === 'ready', 'the available approval side keeps its proven fact')
    assert.deepEqual(read.sandbox, { state: 'unavailable', reason: 'service-not-installed' },
      'the missing sandbox service is THAT side\'s unavailable fact, never a fabricated mode')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: the durable replay keeps the override after a cold re-read (R14/A15 seed)', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f8-host-r14')
  try {
    await createLiveAgent(host, SESSION_A, life.tempDir('f8-r14-'))
    assert.deepEqual(outcomeOf(await host.invoke('setApproval', { sessionId: SESSION_A, policy: 'never' })), { kind: 'applied', sessionId: SESSION_A })
    // The official projection fold is the authority: a FRESH read of the same
    // live session replays the durable log, so the override persists.
    const read = readOf(await host.invoke('read', { sessionId: SESSION_A }))
    assert.ok(read.kind === 'ready' && read.approval.state === 'ready')
    assert.equal(read.approval.effective, 'never')
    assert.equal(read.approval.override, 'never')
  } finally {
    await host.dispose()
  }
})
