import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectHostShellCompletionPort,
  type DirectShellCandidateRequest,
} from '../../../src/runtime/direct/host-shell-completion-direct.ts'
import type { HostShellPathCompletionBridge } from '../../../src/runtime/remote/pi-tui-host-user-shell-host-bridge.ts'

const signal = new AbortController().signal
const target = { kind: 'session' as const, sessionId: 'session-a' }

/** Run one test body under a simulated Host platform. */
async function withPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  assert.ok(descriptor?.configurable)
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    return await body()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

function fixture(options: {
  readonly agents?: () => { readonly session: { readonly id: string } } | undefined
  readonly paths?: (cwd: string, prefix: string) => string
  readonly candidates?: (request: DirectShellCandidateRequest, cwd: string) => readonly string[]
} = {}) {
  const pathCalls: { readonly cwd: string; readonly prefix: string }[] = []
  const candidateCalls: { readonly request: DirectShellCandidateRequest; readonly cwd: string }[] = []
  const state = { agent: options.agents === undefined ? () => ({ session: { id: 'session-a' } }) : options.agents }
  const pathCompletion: HostShellPathCompletionBridge = {
    async complete(cwd, prefix) {
      pathCalls.push({ cwd, prefix })
      return { kind: 'ok', candidates: [(options.paths ?? ((_cwd, value) => `${value}file.txt`))(cwd, prefix)] }
    },
  }
  const port = new DirectHostShellCompletionPort(
    () => '/host/cwd',
    () => state.agent(),
    async (request, cwd) => {
      candidateCalls.push({ request, cwd })
      return (options.candidates ?? (() => []))(request, cwd)
    },
    pathCompletion,
  )
  return { port, pathCalls, candidateCalls, state }
}

test('a Windows Direct Host routes every path request through the Host path bridge', async () => {
  const fixturePort = fixture()
  await withPlatform('win32', async () => {
    assert.equal(fixturePort.port.pathAuthority, 'host')
    assert.equal(fixturePort.port.pathLiteralDialect, 'powershell')
    const outcome = await fixturePort.port.complete({
      target,
      request: { kind: 'paths', prefix: 'C:\\work\\' },
      signal,
    })
    assert.deepEqual(outcome, { kind: 'ok', candidates: ['C:\\work\\file.txt'] })
    assert.deepEqual(fixturePort.pathCalls, [{ cwd: '/host/cwd', prefix: 'C:\\work\\' }])
    assert.equal(fixturePort.candidateCalls.length, 0, 'no Bash compgen candidate reader participates')
  })
})

test('a Windows Direct Host makes command, variable and git completion unavailable with zero helper', async () => {
  const fixturePort = fixture()
  await withPlatform('win32', async () => {
    for (const request of [
      { kind: 'commands' as const, prefix: 'gi' },
      { kind: 'variables' as const, prefix: 'HO' },
      { kind: 'subcommands' as const, command: 'git', prefix: 'che' },
    ]) {
      const outcome = await fixturePort.port.complete({ target, request, signal })
      assert.equal(outcome.kind, 'unavailable', request.kind)
      if (outcome.kind !== 'unavailable') throw new Error('expected an unavailable non-path completion')
      assert.match(outcome.reason, /unsupported/u)
    }
    assert.equal(fixturePort.pathCalls.length, 0)
    assert.equal(fixturePort.candidateCalls.length, 0)
  })
})

test('a POSIX Direct Host keeps the fork path authority and the existing Bash candidate reader', async () => {
  const fixturePort = fixture({ candidates: () => ['git'] })
  await withPlatform('linux', async () => {
    assert.equal(fixturePort.port.pathAuthority, 'client')
    assert.equal(fixturePort.port.pathLiteralDialect, 'bash')
    assert.deepEqual(await fixturePort.port.complete({ target, request: { kind: 'paths', prefix: 'src/' }, signal }), {
      kind: 'unavailable',
      reason: 'Direct shell paths use the existing path provider',
    })
    assert.deepEqual(await fixturePort.port.complete({ target, request: { kind: 'commands', prefix: 'gi' }, signal }), {
      kind: 'ok',
      candidates: ['git'],
    })
    assert.deepEqual(fixturePort.candidateCalls, [{ request: { kind: 'commands' }, cwd: '/host/cwd' }])
  })
})

test('a Direct completion re-resolves the exact live Session agent on every call', async () => {
  const fixturePort = fixture()
  await withPlatform('win32', async () => {
    const first = await fixturePort.port.complete({ target, request: { kind: 'paths', prefix: 'a' }, signal })
    assert.equal(first.kind, 'ok')
    fixturePort.state.agent = () => undefined
    fixturePort.pathCalls.length = 0
    const second = await fixturePort.port.complete({ target, request: { kind: 'paths', prefix: 'a' }, signal })
    assert.equal(second.kind, 'unavailable')
    if (second.kind !== 'unavailable') throw new Error('expected a missing-Agent refusal')
    assert.match(second.reason, /no live Direct Agent/u)
    assert.equal(fixturePort.pathCalls.length, 0, 'a stale Session target never reaches the Host path bridge')
  })
})
