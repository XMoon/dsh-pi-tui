/**
 * L5 REAL WIRE: the private `piTuiPromptPresence` Host service over the REAL
 * Typert Gateway with explicit authenticated Peers (M6 PR-C C3).
 *
 * Every case crosses the real generated official dispatch: the exact
 * descriptor, the per-parameter codecs, the Gateway's remote-access fence and
 * the Peer identity provenance (`RemoteInvocation.peer.id`). The service body
 * is the production `PiTuiPromptPresenceHostService` mounted by the built-in
 * Host Runtime row; the only stand-ins are the in-process Peers (the two-OS-
 * process Client proof is the split-process `prompt.session-focus-turn-parity`
 * smoke case).
 *
 * What this suite pins:
 *
 * - the Owner view commits BEFORE the ACK is returned (ACK-after-commit);
 * - the record key is the EXACT Peer identity — one Client can never vote for
 *   another, and a withdrawn view stops voting immediately;
 * - a non-Owner Peer is denied at the Gateway dispatch (never a service
 *   refusal pretending to be an empty roster);
 * - revision ordering refuses stale updates WITHOUT touching the record;
 * - an untrusted Session id (unknown, or subagent-origin) is refused and
 *   changes nothing;
 * - a disposed Peer's record is retired with its lifetime (and a late call on
 *   the dead Peer is refused);
 * - the fold (`snapshotVoters`) compares the CURRENT live Session/Agent
 *   objects and ORs presets (any Focus wins).
 *
 * @module @xmoon76/dsh-pi-tui/app/pi-tui-prompt-presence-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  PI_TUI_PROMPT_PRESENCE_NAMESPACE,
  parsePresenceSyncResult,
  type PiTuiPromptPresenceSyncResult,
} from '../../src/runtime/remote/pi-tui-prompt-presence-contract.ts'
import type {
  PromptPresenceRecord,
  PiTuiPromptPresenceHostService,
} from '../../src/app/host/features/prompt-presence.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

interface WireHost {
  readonly host: Host
  readonly peers: PeerScope[]
  invoke(
    method: 'syncView',
    args: Record<string, unknown>,
    peer: PeerScope,
  ): Promise<PiTuiPromptPresenceSyncResult>
  /** The production service, as the Host Runtime mounts it. */
  service(): PiTuiPromptPresenceHostService
  dispose(): Promise<void>
}

async function wireHost(life: ReturnType<typeof testLifecycle>, presetId: string): Promise<WireHost> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  // The in-process Remote carrier: the real Host Connection service the
  // explicit test Peers hang off (the same composition the authorization
  // suite uses).
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const peers: PeerScope[] = []
  const gateway = host.ctx.typertGateway
  return {
    host,
    peers,
    invoke: async (method, args, peer) => {
      const result = await gateway.invoke({
        namespace: PI_TUI_PROMPT_PRESENCE_NAMESPACE,
        method,
        args,
        peer,
        signal: new AbortController().signal,
      })
      return parsePresenceSyncResult(result)
    },
    service: () => host.ctx.reflect.get(PI_TUI_PROMPT_PRESENCE_NAMESPACE) as PiTuiPromptPresenceHostService,
    dispose: async () => {
      for (const peer of peers) await peer.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

function ownerPeer(wire: WireHost): PeerScope {
  const peer = wire.host.ctx.connection.createPeer({ principal: { kind: 'owner' } })
  wire.peers.push(peer)
  return peer
}

type LiveSessionLike = { readonly id: string; readonly header: { readonly origin?: string } }

/** The exact live Host Session object the service's fold compares identity to. */
function liveSession(wire: WireHost, sessionId: string): LiveSessionLike {
  const sessions = wire.host.ctx.reflect.get('sessions') as
    | { get(id: never): LiveSessionLike | undefined }
    | undefined
  const session = sessions?.get(sessionId as never)
  assert.notEqual(session, undefined, `the fixture must hold a live Session ${sessionId}`)
  return session as LiveSessionLike
}

/** Assert one exact refusal, and that the call changed NO record. */
function assertRefused(result: PiTuiPromptPresenceSyncResult, reason: string): void {
  assert.deepEqual(result, { kind: 'refused', reason }, `expected the exact refusal ${reason}`)
}

test('an Owner view commits before the ACK and folds into the Host voter roster', async (t) => {
  const wire = await wireHost(testLifecycle(t), 'presence-fold')
  try {
    const { harness } = wire.host
    await harness.create(SessionId('presence-fold-s1'), { provider: 'smoke', model: 'smoke' } as never, { cwd: wire.host.anchorDir })
    await harness.create(SessionId('presence-fold-s2'), { provider: 'smoke', model: 'smoke' } as never, { cwd: wire.host.anchorDir })
    const s1 = liveSession(wire, 'presence-fold-s1')
    const s2 = liveSession(wire, 'presence-fold-s2')
    const peerA = ownerPeer(wire)
    const peerB = ownerPeer(wire)
    assert.notEqual(peerA.id, peerB.id, 'two Peers carry distinct identities')

    // The ACK is returned AFTER the map commit: the record is observable the
    // moment the call resolved.
    const first = await wire.invoke('syncView', { viewedSessionId: 'presence-fold-s1', displayPreset: 'focus', revision: 1 }, peerA)
    assert.deepEqual(first, { kind: 'applied', revision: 1 })
    const committed = wire.service().recordOf(peerA.id) as PromptPresenceRecord
    assert.equal(committed.viewedSessionId, 'presence-fold-s1')
    assert.equal(committed.displayPreset, 'focus')
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: true, focus: true })
    assert.deepEqual(wire.service().snapshotVoters(s2), { eligible: false, focus: false }, 'an unviewed Session has no voters')

    // A second Client on the SAME Session ORs presets (any Focus wins).
    await wire.invoke('syncView', { viewedSessionId: 'presence-fold-s1', displayPreset: 'full', revision: 1 }, peerB)
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: true, focus: true })
    // The second Client WITHDRAWS (`null` view): only its own vote leaves.
    const withdrawn = await wire.invoke('syncView', { viewedSessionId: null, displayPreset: 'full', revision: 2 }, peerB)
    assert.deepEqual(withdrawn, { kind: 'applied', revision: 2 })
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: true, focus: true }, 'the withdrawn Peer stopped voting')
    // With no Focus viewer left, the fold is eligible-only.
    await wire.invoke('syncView', { viewedSessionId: 'presence-fold-s1', displayPreset: 'full', revision: 2 }, peerA)
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: true, focus: false })
    await wire.invoke('syncView', { viewedSessionId: null, displayPreset: 'full', revision: 3 }, peerA)
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: false, focus: false })
  } finally {
    await wire.dispose()
  }
})

test('a non-Owner Peer is denied at the Gateway dispatch and votes nothing', async (t) => {
  const wire = await wireHost(testLifecycle(t), 'presence-owner')
  try {
    await wire.host.harness.create(SessionId('presence-owner-s1'), { provider: 'smoke', model: 'smoke' } as never, { cwd: wire.host.anchorDir })
    const viewer = wire.host.ctx.connection.createPeer({ principal: { kind: 'viewer' } } as never)
    wire.peers.push(viewer)
    const before = wire.service().recordCount()
    await assert.rejects(
      () => wire.invoke('syncView', { viewedSessionId: 'presence-owner-s1', displayPreset: 'focus', revision: 1 }, viewer),
      (error: unknown) => (error as { code?: string }).code === 'remote-access/denied',
      'the Gateway refuses a non-Owner before the service runs',
    )
    assert.equal(wire.service().recordOf(viewer.id), undefined)
    assert.equal(wire.service().recordCount(), before, 'a denied call changes nothing')
  } finally {
    await wire.dispose()
  }
})

test('revision ordering refuses stale updates without touching the committed record', async (t) => {
  const wire = await wireHost(testLifecycle(t), 'presence-revision')
  try {
    await wire.host.harness.create(SessionId('presence-revision-s1'), { provider: 'smoke', model: 'smoke' } as never, { cwd: wire.host.anchorDir })
    const peer = ownerPeer(wire)
    assert.deepEqual(
      await wire.invoke('syncView', { viewedSessionId: 'presence-revision-s1', displayPreset: 'focus', revision: 5 }, peer),
      { kind: 'applied', revision: 5 },
    )
    assertRefused(
      await wire.invoke('syncView', { viewedSessionId: 'presence-revision-s1', displayPreset: 'full', revision: 5 }, peer),
      'stale-revision',
    )
    assertRefused(
      await wire.invoke('syncView', { viewedSessionId: null, displayPreset: 'full', revision: 3 }, peer),
      'stale-revision',
    )
    const record = wire.service().recordOf(peer.id) as PromptPresenceRecord
    assert.equal(record.revision, 5)
    assert.equal(record.displayPreset, 'focus', 'a refused call never changes the committed view')
    // A higher revision always wins (the monotonic per-Peer ordering).
    assert.deepEqual(
      await wire.invoke('syncView', { viewedSessionId: 'presence-revision-s1', displayPreset: 'full', revision: 6 }, peer),
      { kind: 'applied', revision: 6 },
    )
    const s1 = liveSession(wire, 'presence-revision-s1')
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: true, focus: false })
  } finally {
    await wire.dispose()
  }
})

test('an untrusted Session id is refused and the Peer record stays empty', async (t) => {
  const wire = await wireHost(testLifecycle(t), 'presence-session')
  try {
    await wire.host.harness.create(SessionId('presence-session-ordinary'), { provider: 'smoke', model: 'smoke' } as never, { cwd: wire.host.anchorDir })
    // A subagent-origin Session can never acquire TUI prompt policy through
    // presence (the official `origin` classification is the authority).
    await wire.host.harness.create(
      SessionId('presence-session-sub'),
      { provider: 'smoke', model: 'smoke' } as never,
      { cwd: wire.host.anchorDir, origin: 'subagent' } as never,
    )
    const peer = ownerPeer(wire)
    assertRefused(
      await wire.invoke('syncView', { viewedSessionId: 'presence-session-unknown', displayPreset: 'focus', revision: 1 }, peer),
      'session-not-live',
    )
    assertRefused(
      await wire.invoke('syncView', { viewedSessionId: 'presence-session-sub', displayPreset: 'focus', revision: 1 }, peer),
      'session-not-live',
    )
    assert.equal(wire.service().recordOf(peer.id), undefined, 'a refused call commits nothing')
    // The ordinary Session of the SAME call style is accepted afterwards.
    assert.deepEqual(
      await wire.invoke('syncView', { viewedSessionId: 'presence-session-ordinary', displayPreset: 'focus', revision: 1 }, peer),
      { kind: 'applied', revision: 1 },
    )
  } finally {
    await wire.dispose()
  }
})

test('a disposed Peer stops voting and its late calls are refused', async (t) => {
  const wire = await wireHost(testLifecycle(t), 'presence-lifetime')
  try {
    await wire.host.harness.create(SessionId('presence-lifetime-s1'), { provider: 'smoke', model: 'smoke' } as never, { cwd: wire.host.anchorDir })
    const s1 = liveSession(wire, 'presence-lifetime-s1')
    const peer = ownerPeer(wire)
    await wire.invoke('syncView', { viewedSessionId: 'presence-lifetime-s1', displayPreset: 'focus', revision: 1 }, peer)
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: true, focus: true })
    // The official Peer lifetime: disposing the scope aborts `peer.signal`
    // and the presence record is retired WITH it (no TTL, no heartbeat).
    await peer.dispose()
    assert.equal(peer.signal.aborted, true)
    assert.equal(wire.service().recordOf(peer.id), undefined, 'the record left with the Peer lifetime')
    assert.deepEqual(wire.service().snapshotVoters(s1), { eligible: false, focus: false })
    // A late call on the dead Peer can never resurrect its membership: the
    // Gateway refuses the disposed Peer at dispatch (fail-closed before the
    // service, and the service's own signal gate is the second fence).
    await assert.rejects(
      () => wire.invoke('syncView', { viewedSessionId: 'presence-lifetime-s1', displayPreset: 'focus', revision: 2 }, peer),
      /the calling Peer has been disposed/u,
    )
    assert.equal(wire.service().recordOf(peer.id), undefined, 'the late call committed nothing')
  } finally {
    await wire.dispose()
  }
})
