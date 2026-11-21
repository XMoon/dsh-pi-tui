/**
 * L5 REAL_WIRE: the private `piTuiSessionPolicy` namespace through the
 * PRODUCTION Host row, the REAL rc.2 Gateway Client remote and the real
 * in-process carrier.
 *
 * ```text
 * real official ctx.approval / ctx.sandboxPolicy (production AgentLoop agents)
 *   -> PiTuiSessionPolicyHostService (production Host row)
 *   -> gateway carrier (production generated Client Remote)
 *   -> RemoteSessionPolicyPort (production Client code)
 *   -> typed read / exact-session approval write
 * ```
 *
 * This is NOT a fake namespace: the Host bridge and the generated Client
 * remote are the production ones; only the model is the fixture stand-in.
 * The two real OS-process Clients are the split-process `session-policy`
 * suite (L6).
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-session-policy-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { RemoteSessionPolicyPort } from '../../src/runtime/remote/session-policy-remote.ts'
import { RemoteConfigWriteLifetime } from '../../src/runtime/remote/config-write-lifetime.ts'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import type { SessionPolicyRead } from '../../src/runtime/session-policy-port.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

const SESSION_A = 'f8-wire-session-a'
const SESSION_B = 'f8-wire-session-b'

interface Wire {
  readonly host: Host
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  readonly port: RemoteSessionPolicyPort
  readonly config: RemoteConfigPort
  readonly workRootA: string
  dispose(): Promise<void>
}

async function mountWire(
  life: TestLifecycle,
  presetId: string,
  fault: { readonly match: (url: string) => boolean } | undefined = undefined,
): Promise<Wire> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  // The REAL official approval service row.
  const approval = await import('@deepseek-ai/dsh-user-approval')
  await host.ctx.plugin((approval as unknown as { default: unknown }).default as never, {} as never)
  const workRootA = life.tempDir('f8-wire-a-')
  await host.ctx.agents.create({
    sessionId: SessionId(SESSION_A),
    agentOptions: { provider: 'smoke', model: 'smoke' },
    meta: { cwd: workRootA },
  })
  await host.ctx.agents.create({
    sessionId: SessionId(SESSION_B),
    agentOptions: { provider: 'smoke', model: 'smoke' },
    meta: { cwd: life.tempDir('f8-wire-b-') },
  })
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  if (fault !== undefined) {
    // ONE-SHOT carrier fault: the request still reaches the Host (the official
    // setter really ran), but the answer never returns to the Client.
    const originalFetch = hostRuntime.carrier.fetch
    let injected = false
    hostRuntime.carrier.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const response = await originalFetch(input, init)
      if (!injected && fault.match(url)) {
        injected = true
        throw new Error('simulated carrier loss after the Host committed the call')
      }
      return response
    }
  }
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const writeLifetime = new RemoteConfigWriteLifetime()
  const port = new RemoteSessionPolicyPort(
    client.remote.piTuiSessionPolicy,
    client.connection.generation,
    writeLifetime,
  )
  // The SAME lifetime instance the production assembly hands the ConfigPort.
  const config = new RemoteConfigPort({ remote: client.remote, connection: { generation: client.connection.generation } }, { writeLifetime })
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    port,
    config,
    workRootA,
    dispose: async () => {
      if (disposed) return
      disposed = true
      config.dispose()
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

function assertNoHostInternals(value: unknown, workRoot: string): void {
  const text = JSON.stringify(value)
  assert.equal(text.includes(workRoot), false, 'the frame never carries the Host workspace path')
  assert.equal(text.includes('agent'), false, 'the frame never carries an Agent-shaped value')
}

test('L5 REAL_WIRE: the generated Client Remote reads two exact sessions through ONE private namespace', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'f8-wire-read')
  try {
    // The namespace is an accessor on the generated Client remote, never an
    // own field of a copied object.
    assert.equal(Object.hasOwn(wire.client.remote, 'piTuiSessionPolicy'), false,
      'the namespace is an accessor on the generated Client remote')
    assert.equal(typeof wire.client.remote.piTuiSessionPolicy.read, 'function')
    const outcome = await wire.port.setApproval(SESSION_A, 'never')
    assert.deepEqual(outcome, { kind: 'applied', sessionId: SESSION_A })
    const readA = await wire.port.read(SESSION_A) as SessionPolicyRead
    const readB = await wire.port.read(SESSION_B) as SessionPolicyRead
    assert.ok(readA.kind === 'ready' && readA.approval.state === 'ready')
    assert.equal(readA.approval.effective, 'never', 'the exact Session A override crossed the real wire')
    assert.ok(readB.kind === 'ready' && readB.approval.state === 'ready')
    assert.equal(readB.approval.effective, 'ask', "Session B never inherits Session A's value")
    assert.equal(readB.approval.override, undefined)
    assertNoHostInternals(readA, wire.workRootA)
    // The official Host log is the durable authority behind the frame.
    const events: string[] = []
    wire.host.ctx.on('session/event' as never, ((...args: unknown[]) => {
      const event = args[1] as { type?: string } | undefined
      if (event?.type === 'approval/policy') events.push(String(event.type))
    }) as never)
    assert.deepEqual(await wire.port.setApproval(SESSION_A, 'ask'), { kind: 'applied', sessionId: SESSION_A })
    assert.equal(events.length, 1, 'the second real switch appended one official approval/policy event')
  } finally {
    await wire.dispose()
  }
})

test('L5 REAL_WIRE: a Host-committed approval write whose ACK is lost is UNCONFIRMED and never replayed', async (t) => {
  const life = testLifecycle(t)
  let setRequests = 0
  const wire = await mountWire(life, 'f8-wire-ack-loss', {
    match: url => {
      if (!url.includes('piTuiSessionPolicy/setApproval')) return false
      setRequests += 1
      return true
    },
  })
  try {
    const outcome = await wire.port.setApproval(SESSION_A, 'never')
    assert.equal(outcome.kind, 'unconfirmed', 'a lost ACK is unconfirmed, never refused/not-sent')
    assert.equal(setRequests, 1, 'exactly ONE dispatch — no retry')
    // The Host REALLY committed: the durable official projection reads never.
    const read = readOf(await wire.port.read(SESSION_A))
    assert.ok(read.kind === 'ready' && read.approval.state === 'ready')
    assert.equal(read.approval.effective, 'never', 'the Host commit happened even though the Client never saw the ACK')
  } finally {
    await wire.dispose()
  }
})

test('L5 REAL_WIRE: the shared accepted-write lifetime is observable through hasUnsettledWrites', async (t) => {
  const life = testLifecycle(t)
  let releaseRead: (() => void) | undefined
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const wire = await mountWire(life, 'f8-wire-lifetime')
  try {
    const original = wire.hostRuntime.carrier.fetch
    wire.hostRuntime.carrier.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('piTuiSessionPolicy/setApproval')) await gate
      return original(input, init)
    }
    assert.equal(wire.config.hasUnsettledWrites(), false)
    const write = wire.port.setApproval(SESSION_A, 'never')
    // The ConfigPort reads the SAME counter the policy write brackets.
    assert.equal(wire.config.hasUnsettledWrites(), true, 'the shared lifetime observes the in-flight policy write')
    releaseRead?.()
    assert.deepEqual(await write, { kind: 'applied', sessionId: SESSION_A })
    assert.equal(wire.config.hasUnsettledWrites(), false, 'the write released the lifetime exactly once')
  } finally {
    await wire.dispose()
  }
})

function readOf(result: SessionPolicyRead): SessionPolicyRead {
  return result
}
