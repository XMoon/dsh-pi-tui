import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteHostShellCompletionPort } from '../../src/runtime/remote/host-shell-completion-remote.ts'
import { RemoteHostUserShellPort } from '../../src/runtime/remote/host-user-shell-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../src/runtime/remote/session-reader-remote.ts'
import type {
  HostUserShellRunOutcome,
  PiTuiHostUserShellNamespace,
} from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'
import {
  HostUserShellOutcomeUnknownError,
  HostUserShellSandboxRunnerError,
  MAX_HOST_USER_SHELL_STREAM_BYTES,
  type HostUserShellOutcome,
} from '../../src/runtime/host-user-shell-port.ts'
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
  dispose(): Promise<void>
}

async function mountWire(life: ReturnType<typeof testLifecycle>, preset: string): Promise<Wire> {
  const host = await createRemoteApplicationHostFixture(life, preset)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const remote = client.remote.piTuiHostUserShell
  const namespace: PiTuiHostUserShellNamespace = {
    complete: (...args) => remote.complete(...args),
    run: (...args) => remote.run(...args),
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
    async dispose() {
      if (disposed) return
      disposed = true
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

async function createSession(wire: Wire, sessionId: string): Promise<string> {
  const hostAgent = await wire.host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: wire.host.anchorDir })
  assert.strictEqual(wire.host.ctx.agents.get(SessionId(sessionId)), hostAgent)
  assert.strictEqual(wire.host.ctx.sessions.get(SessionId(sessionId)), hostAgent.session)
  return wire.host.ctx.workingDirectory.get(hostAgent.session)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

test('one authenticated one-shot Gateway invocation returns bounded output and the real exit fact', async t => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'm6-f1-real-gateway-shell')
  try {
    const sessionId = 'm6-f1-real-gateway-shell-session'
    const hostCwd = await createSession(wire, sessionId)
    const retained = wire.client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
    await retained.ready
    try {
      const outcome = await wire.shell.execute({
        sessionId,
        cwd: hostCwd,
        command: "for ((i=0;i<512;i++)); do printf '%200s\\n' ''; done; printf 'BOUNDED_TAIL_20261110\\n'; exit 7",
        policy: 'bypass',
        signal: new AbortController().signal,
      })
      assert.equal(outcome.kind, 'settled', JSON.stringify(outcome))
      if (outcome.kind !== 'settled') throw new Error('expected a settled one-shot result')
      assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 7 })
      assert.equal(outcome.result.stdout.truncated, true)
      assert.equal(outcome.result.stdout.text.endsWith('BOUNDED_TAIL_20261110\n'), true)
      assert.ok(Buffer.byteLength(outcome.result.stdout.text, 'utf8') <= MAX_HOST_USER_SHELL_STREAM_BYTES)
      assert.equal(typeof outcome.result.stdout.spillPath, 'string',
        'the official collect/spill disposition names a Host-local full-output file')
      assert.deepEqual(outcome.result.stderr, { text: '', truncated: false })
      assert.equal(outcome.result.sandboxDenied, false)
    } finally {
      retained.release()
    }
  } finally {
    await wire.dispose()
  }
})

test('raw Bash `$!`/`wait` and separate stdout/stderr FDs cross the Remote one-shot result', async t => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'm6-f1-real-gateway-shell-wait')
  try {
    const sessionId = 'm6-f1-real-gateway-shell-wait-session'
    const hostCwd = await createSession(wire, sessionId)
    const retained = wire.client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
    await retained.ready
    try {
      const outcome = await wire.shell.execute({
        sessionId,
        cwd: hostCwd,
        command: "sleep 0.05 & p=$!; wait \"$p\"; printf 'WAIT=%s PID=%s\\n' \"$?\" \"$p\"; printf 'FD_OUT\\n'; printf 'FD_ERR\\n' >&2",
        policy: 'bypass',
        signal: new AbortController().signal,
      })
      assert.equal(outcome.kind, 'settled', JSON.stringify(outcome))
      if (outcome.kind !== 'settled') throw new Error('expected a settled run')
      assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 0 })
      assert.match(outcome.result.stdout.text, /WAIT=0 PID=\d+/u)
      assert.ok(outcome.result.stdout.text.includes('FD_OUT'))
      assert.ok(!outcome.result.stdout.text.includes('FD_ERR'), 'stderr is not relayed into stdout')
      assert.equal(outcome.result.stderr.text, 'FD_ERR\n')
    } finally {
      retained.release()
    }
  } finally {
    await wire.dispose()
  }
})

test('a cancellation aborts the one-shot Host run and cleans up the managed range once', async t => {
  const life = testLifecycle(t)
  const wire = await mountWire(life, 'm6-f1-real-gateway-shell-cancel')
  const scratch = life.tempDir('f1-wire-cancel-')
  const counter = join(scratch, 'invocations.txt')
  const childPidFile = join(scratch, 'child.pid')
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    const sessionId = 'm6-f1-real-gateway-shell-cancel-session'
    const hostCwd = await createSession(wire, sessionId)
    const retained = wire.client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
    await retained.ready
    try {
      const controller = new AbortController()
      const pending = wire.shell.execute({
        sessionId,
        cwd: hostCwd,
        command: `printf x >> ${shellQuote(counter)}; sleep 30 & child=$!; printf '%s\\n' "$child" > ${shellQuote(childPidFile)}; wait "$child"`,
        policy: 'bypass',
        signal: controller.signal,
      })
      for (let attempt = 0; attempt < 200 && !existsSync(childPidFile); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(existsSync(counter), true, 'the Host command really started once')
      const childPid = Number(readFileSync(childPidFile, 'utf8').trim())
      assert.ok(Number.isInteger(childPid) && childPid > 0, 'the background child pid was published')
      assert.equal(isAlive(childPid), true, 'the managed background child is alive before cancellation')
      controller.abort()
      await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError')
      for (let attempt = 0; attempt < 400 && isAlive(childPid); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(isAlive(childPid), false, 'the managed range (including the background child) was cleaned up')
      assert.equal(readFileSync(counter, 'utf8'), 'x', 'the cancelled Host command is never replayed')
    } finally {
      retained.release()
    }
  } finally {
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
        expectedCwd: process.cwd(),
        command: 'touch should-never-exist',
        policy: 'bypass',
      },
    }
    let refusal: unknown
    try {
      const items = await wire.host.ctx.typertGateway.wireStream.open(
        endpoint,
        payload,
        (async function* () {})(),
        peer,
        signal,
      )
      for await (const _item of items) { /* a denial must never yield */ }
    } catch (error) {
      refusal = error
    }
    assert.ok(refusal instanceof Error, 'the real non-owner call is refused before Host dispatch')
    assert.equal((refusal as Error & { code?: string }).code, 'remote-access/denied')
    assert.match((refusal as Error).message, /piTuiHostUserShell\/run: access denied \(no-allow\)/u)
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
    await createSession(wire, sessionId)
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
    } finally {
      retained.release()
    }
  } finally {
    await wire.dispose()
  }
})

// ── Remote adapter mapping (unary outcomes, not a transport stream) ─────────

function fakeNamespace(run: PiTuiHostUserShellNamespace['run']): PiTuiHostUserShellNamespace {
  return {
    run,
    complete: async () => ({ ok: true, value: { kind: 'ok', candidates: [] } }),
  }
}

function generationOf(): RemoteConnectionGenerationSource {
  const snapshot = {}
  return { getSnapshot: () => snapshot as never, subscribe: () => () => {} }
}

function requestOf(overrides: Partial<Parameters<RemoteHostUserShellPort['execute']>[0]> = {}) {
  return {
    sessionId: 'session-a',
    cwd: '/workspace',
    command: 'true',
    policy: 'bypass' as const,
    signal: new AbortController().signal,
    ...overrides,
  }
}

const settledOutcome: HostUserShellRunOutcome = {
  kind: 'settled',
  result: {
    exit: { kind: 'exit', code: 0 },
    stdout: { text: 'ok\n', truncated: false },
    stderr: { text: '', truncated: false },
    sandboxDenied: false,
    aborted: false,
    timedOut: false,
  },
}

test('the Remote adapter maps a refusal to unavailable and keeps the Host message', async () => {
  const port = new RemoteHostUserShellPort(fakeNamespace(async () => ({
    ok: true,
    value: { kind: 'refused', reason: 'policy-unavailable', message: 'nothing executed' },
  })), generationOf())
  const outcome: HostUserShellOutcome = await port.execute(requestOf())
  assert.deepEqual(outcome, { kind: 'unavailable', reason: { reason: 'policy-unavailable', message: 'nothing executed' } })
})

test('a lost one-shot response is an unknown outcome, never a replay', async () => {
  const port = new RemoteHostUserShellPort(fakeNamespace(async () => { throw new Error('carrier lost') }), generationOf())
  await assert.rejects(() => port.execute(requestOf()), HostUserShellOutcomeUnknownError)
  const gatewayFailure = new RemoteHostUserShellPort(fakeNamespace(async () => ({
    ok: false,
    error: { code: 'gateway/invocation-unavailable', message: 'unavailable' },
  }) as unknown as RemoteResult<HostUserShellRunOutcome>), generationOf())
  await assert.rejects(() => gatewayFailure.execute(requestOf()), HostUserShellOutcomeUnknownError)
})

test('a Host sandbox-runner/execution failure keeps its truthful error class', async () => {
  const runner = new RemoteHostUserShellPort(fakeNamespace(async () => ({
    ok: true,
    value: { kind: 'failed', phase: 'sandbox-runner', message: 'runner failed' },
  })), generationOf())
  await assert.rejects(() => runner.execute(requestOf()), HostUserShellSandboxRunnerError)
  const infrastructure = new RemoteHostUserShellPort(fakeNamespace(async () => ({
    ok: true,
    value: { kind: 'failed', phase: 'infrastructure', message: 'lost after start' },
  })), generationOf())
  await assert.rejects(() => infrastructure.execute(requestOf()), HostUserShellOutcomeUnknownError)
})

test('a settled reply that lands after the Connection generation changed is UNKNOWN, never a stale result', async () => {
  const snapshot = {}
  let current: unknown = snapshot
  const generation: RemoteConnectionGenerationSource = {
    getSnapshot: () => current as never,
    subscribe: () => () => {},
  }
  const port = new RemoteHostUserShellPort(fakeNamespace(async () => {
    // The mux drops and reconnects while the unary call is in flight; the
    // reply then lands against a REPLACED generation. The terminal fact is
    // lost, so even a settled reply must not be accepted as authoritative.
    current = {}
    return { ok: true, value: settledOutcome }
  }), generation)
  await assert.rejects(() => port.execute(requestOf()), HostUserShellOutcomeUnknownError)
})

test('a settled one-shot result crosses the adapter unchanged and a disconnected Host is unavailable', async () => {
  const port = new RemoteHostUserShellPort(fakeNamespace(async () => ({ ok: true, value: settledOutcome })), generationOf())
  assert.deepEqual(await port.execute(requestOf()), { kind: 'settled', result: settledOutcome.result })
  const disconnected = new RemoteHostUserShellPort(
    fakeNamespace(async () => ({ ok: true, value: settledOutcome })),
    { getSnapshot: () => undefined, subscribe: () => () => {} },
  )
  const outcome = await disconnected.execute(requestOf())
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected an unavailable disconnected Host')
  assert.equal(outcome.reason.reason, 'carrier-gap')
})
