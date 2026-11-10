import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { HostUserShellOutputMux } from '../../src/app/host/features/host-user-shell-stream.ts'
import { RemoteHostShellCompletionPort } from '../../src/runtime/remote/host-shell-completion-remote.ts'
import { RemoteHostUserShellPort } from '../../src/runtime/remote/host-user-shell-remote.ts'
import type { HostUserShellAck, HostUserShellFrame, PiTuiHostUserShellNamespace } from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture, waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

interface Wire {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  readonly shell: RemoteHostUserShellPort
  readonly completion: RemoteHostShellCompletionPort
  readonly downlinkFrames: HostUserShellFrame[]
  readonly acknowledgements: HostUserShellAck[]
  readonly ownerPeer: import('@deepseek-ai/dsh-client-connection').PeerScope
  dispose(): Promise<void>
}

async function mountWire(life: ReturnType<typeof testLifecycle>, preset: string): Promise<Wire> {
  const host = await createRemoteApplicationHostFixture(life, preset)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const ownerPeer = host.ctx.connection.browserPeer
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const downlinkFrames: HostUserShellFrame[] = []
  const acknowledgements: HostUserShellAck[] = []
  const remote = client.remote.piTuiHostUserShell
  const namespace: PiTuiHostUserShellNamespace = {
    complete: (...args) => remote.complete(...args),
    run: (...args) => {
      const handle = remote.run(...args)
      const iterator = handle[Symbol.asyncIterator]()
      const tapped: RemoteStreamHandle<HostUserShellFrame, HostUserShellAck> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              const next = await iterator.next()
              if (!next.done) downlinkFrames.push(next.value)
              return next
            },
            async return() {
              return await iterator.return?.() ?? { done: true, value: undefined }
            },
          }
        },
        send(item) {
          acknowledgements.push(item)
          handle.send(item)
        },
        end() { handle.end() },
        dispose() { handle.dispose() },
      }
      return tapped
    },
  }
  const shell = new RemoteHostUserShellPort(namespace, client.connection.generation)
  const completion = new RemoteHostShellCompletionPort(namespace, client.connection.generation)
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    shell,
    completion,
    downlinkFrames,
    acknowledgements,
    ownerPeer,
    async dispose() {
      if (disposed) return
      disposed = true
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

async function waitForFrames(frames: readonly HostUserShellFrame[], count: number): Promise<void> {
  await waitFor(`Host shell downlink frames ${count}`, () => frames.filter(frame => frame.kind === 'output').length >= count, 10_000)
}

test('one authenticated Gateway stream carries 32 MiB Host stdout and 2 MiB stderr with consumed-output ACKs', async t => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'm6-f1-real-gateway-shell')
  assert.equal(wire.ownerPeer.principal.kind, 'owner', 'the Gateway call speaks for the real Host browser Owner Peer')
  const hostMuxBytes = { stdout: 0, stderr: 0 }
  const originalMuxNext = HostUserShellOutputMux.prototype.next
  HostUserShellOutputMux.prototype.next = async function (signal) {
    const chunk = await originalMuxNext.call(this, signal)
    if (chunk !== undefined) hostMuxBytes[chunk.stream] += chunk.bytes.length
    return chunk
  }
  const sessionId = 'm6-f1-real-gateway-shell-session'
  try {
    const hostAgent = await wire.host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    assert.strictEqual(wire.host.ctx.agents.get(SessionId(sessionId)), hostAgent)
    assert.strictEqual(wire.host.ctx.sessions.get(SessionId(sessionId)), hostAgent.session)
    const retained = wire.client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
    await retained.ready
    try {
      const hostCwd = wire.host.ctx.workingDirectory.get(hostAgent.session)
      const admission = await wire.shell.execute({
        sessionId,
        cwd: hostCwd,
        command: `for ((i=0;i<64;i++)); do printf '%32768s' '' >&2; done; for ((i=0;i<1024;i++)); do printf '%32768s' ''; done; printf '\\377' >&2`,
        policy: 'bypass',
        signal: new AbortController().signal,
      })
      if (admission.kind !== 'executing') {
        const refusal = admission.kind === 'unavailable' ? admission.reason.message : admission.message
        throw new Error(`the authenticated Gateway Owner run was ${admission.kind}: ${refusal}`)
      }

      // The application has not called output() yet: the full eight-frame
      // consumer window may reach the real Client StreamInbox, but no ninth
      // Host frame may be sent until the business iterator consumes an item.
      await waitForFrames(wire.downlinkFrames, 8)
      // This bounded negative observation lets an eager Host pump expose a ninth frame.
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(wire.downlinkFrames.filter(frame => frame.kind === 'output').length, 8,
        'Host stops producing at the eight unconsumed-frame window')
      assert.equal(wire.acknowledgements.length, 0, 'Gateway reception alone is not a consumer ACK')

      const consumedBytes = { stdout: 0, stderr: 0 }
      let replacementCharacters = 0
      const drain = (async (): Promise<void> => {
        for await (const chunk of admission.execution.output()) {
          consumedBytes[chunk.stream] += chunk.bytes
          replacementCharacters += [...chunk.text].filter(character => character === '\ufffd').length
          await new Promise(resolve => setTimeout(resolve, 1))
        }
      })()
      const result = await admission.execution.result()
      await drain
      const outputFrames = wire.downlinkFrames.filter((frame): frame is Extract<HostUserShellFrame, { kind: 'output' }> => frame.kind === 'output')
      const wireBytes = { stdout: 0, stderr: 0 }
      const stderrChunks: Buffer[] = []
      for (const frame of outputFrames) {
        const bytes = Buffer.from(frame.base64, 'base64')
        wireBytes[frame.stream] += bytes.length
        if (frame.stream === 'stderr') stderrChunks.push(bytes)
      }
      const stderrWire = Buffer.concat(stderrChunks)
      assert.deepEqual(hostMuxBytes, wireBytes, `Host mux ${JSON.stringify(hostMuxBytes)} diverged from Gateway wire ${JSON.stringify(wireBytes)}`)
      assert.deepEqual(consumedBytes, { stdout: 32 * 1024 * 1024, stderr: 2 * 1024 * 1024 + 1 },
        `consumed bytes ${JSON.stringify(consumedBytes)} did not match wire bytes ${JSON.stringify(wireBytes)} across ${outputFrames.length} frames; result ${JSON.stringify(result.exit)}; stderr tail hex ${stderrWire.subarray(-128).toString('hex')}`)
      assert.equal(replacementCharacters, 1, 'invalid UTF-8 reaches the existing Client decoder as one replacement without changing raw byte accounting')
      assert.deepEqual(result.exit, { kind: 'exit', code: 0 })
      assert.equal(result.aborted, false)

      assert.ok(outputFrames.length >= 1025, 'the 34 MiB real output traversed many bounded wire frames')
      assert.equal(wire.acknowledgements.length, outputFrames.length,
        'every output frame is acknowledged once by output() consumption, never on receipt')
      assert.deepEqual(wire.acknowledgements.map(ack => ack.seq), outputFrames.map(frame => frame.seq))
      const wireHashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }
      for (const frame of outputFrames) wireHashes[frame.stream].update(Buffer.from(frame.base64, 'base64'))
      assert.equal(wireHashes.stdout.digest('hex'), createHash('sha256').update(Buffer.alloc(32 * 1024 * 1024, 0x20)).digest('hex'))
      assert.equal(wireHashes.stderr.digest('hex'), createHash('sha256').update(Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x20), Buffer.from([0xff])])).digest('hex'))
      assert.equal(wire.downlinkFrames.filter(frame => frame.kind === 'started').length, 1)
      assert.equal(wire.downlinkFrames.filter(frame => frame.kind === 'settled').length, 1)
    } finally {
      retained.release()
    }
  } finally {
    HostUserShellOutputMux.prototype.next = originalMuxNext
    await wire.dispose()
  }
})

test('the official Gateway denies a real non-owner Peer before Host dispatch', async t => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'm6-f1-gateway-viewer-shell-refusal')
  const signal = new AbortController().signal
  const peer = wire.host.ctx.connection.createPeer({ principal: { kind: 'test-guest', guest: 'm6-f1-viewer' }, interactions: 'none' })
  assert.notEqual(peer.principal.kind, 'owner')
  try {
    const endpoint = 'piTuiHostUserShell/run'
    const payload = {
      args: {
        sessionId: 'not-a-live-session',
        requestId: '550e8400-e29b-41d4-a716-446655440001',
        expectedCwd: process.cwd(),
        command: 'touch should-never-exist',
        policy: 'bypass',
      },
    }
    let refusal: unknown
    try {
      await wire.host.ctx.typertGateway.wireStream.open(
        endpoint,
        payload,
        (async function* () {})(),
        peer,
        signal,
      )
    } catch (error) {
      refusal = error
    }
    assert.ok(refusal instanceof Error, 'the real non-owner call is refused before a stream opens')
    assert.equal((refusal as Error & { code?: string }).code, 'remote-access/denied')
    assert.match((refusal as Error).message, /piTuiHostUserShell\/run: access denied \(no-allow\)/)
  } finally {
    await peer.dispose()
    await wire.dispose()
  }
})

test('the same authenticated Host namespace answers read-only Host completion', async t => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'm6-f1-real-gateway-completion')
  const sessionId = 'm6-f1-real-gateway-completion-session'
  try {
    const hostAgent = await wire.host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
    const retained = wire.client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
    await retained.ready
    try {
      const outcome = await wire.completion.complete({
        sessionId,
        request: { kind: 'commands', prefix: 'ba' },
        signal: new AbortController().signal,
      })
      assert.equal(outcome.kind, 'ok')
      if (outcome.kind !== 'ok') throw new Error('Host command completion was unavailable')
      assert.ok(outcome.candidates.includes('bash'))
      const git = await wire.completion.complete({
        sessionId,
        request: { kind: 'subcommands', command: 'git', prefix: 'che' },
        signal: new AbortController().signal,
      })
      assert.equal(git.kind, 'ok')
      if (git.kind !== 'ok') throw new Error('Host Git subcommand completion was unavailable')
      assert.ok(git.candidates.includes('checkout'), `the real Host Git command list was ${JSON.stringify(git.candidates)}`)
      assert.equal(hostAgent.session.id, sessionId)
    } finally {
      retained.release()
    }
  } finally {
    await wire.dispose()
  }
})
