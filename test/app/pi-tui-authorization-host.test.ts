/**
 * L2 IN_PROCESS: the private `piTuiAuthorization` Host bridge over the REAL
 * official `ctx.authorization` service and the REAL writable credential store,
 * dispatched through the REAL Typert Gateway with explicit peers.
 *
 * The flow used by each case is registered on the official authorization
 * registry and commits through the official `AuthorizationSession.commit()`
 * (which writes through `ctx.credentials.modifyRecord`), so the whole chain
 * `flow -> official commit -> authorization/settled` is the production one.
 * The only stand-in is the provider flow body itself, which is exactly the
 * plugin boundary the official service is designed around.
 *
 * Evidence level: IN_PROCESS. The real two-Client OS-process proof is the
 * split-process `provider-authorization` suite; this suite pins the state
 * machine (prompt semantics, exact peer ACL, cancel/commit race, bounded
 * teardown).
 *
 * @module @xmoon76/dsh-pi-tui/app/pi-tui-authorization-host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { symbols } from '@deepseek-ai/cordis'
import AuthorizationService, {
  type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import {
  PI_TUI_AUTHORIZATION_NAMESPACE,
  parsePiTuiAuthorizationFrame,
  parsePiTuiAuthorizationTargetsSnapshot,
  type AuthorizationTargetsSnapshot,
  type AuthorizationWireFrame,
} from '../../src/runtime/remote/pi-tui-authorization-contract.ts'

type Host = Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>

interface HostFixture {
  readonly ctx: Host['ctx']
  readonly peerA: PeerScope
  readonly peerB: PeerScope
  readonly invoke: (method: string, args: Record<string, unknown>, peer: PeerScope) => Promise<unknown>
  readonly stream: (method: string, args: Record<string, unknown>, peer: PeerScope) => Promise<AsyncIterable<unknown>>
  readonly registerFlow: (flow: Parameters<AuthorizationService['registerFlow']>[0]) => () => void
  readonly activeAttempts: () => number
  dispose(): Promise<void>
}

/** One bounded failure guard: a hung stream read fails the case, not the lane. */
function within<T>(promise: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer !== undefined) clearTimeout(timer) }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs)
    }),
  ])
}

async function hostFixture(
  life: TestLifecycle,
  presetId: string,
  options: { readonly authorization?: boolean } = {},
): Promise<HostFixture> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  if (options.authorization !== false) await host.ctx.plugin(AuthorizationService)
  const connection = host.ctx.connection
  const peerA = connection.browserPeer
  const peerB = connection.createPeer({ principal: { kind: 'owner' } })
  const gateway = host.ctx.typertGateway
  const proxied = host.ctx.reflect.get('piTuiAuthorization') as {
    readonly [symbols.original]?: unknown
  }
  const raw = (proxied as { readonly [symbols.original]?: unknown })[symbols.original] ?? proxied
  const activeAttempts = (): number => {
    const value = (raw as { readonly activeAttempts?: unknown }).activeAttempts
    assert.equal(typeof value, 'number', 'the Host bridge must expose its live attempt count')
    return value as number
  }
  return {
    ctx: host.ctx,
    peerA,
    peerB,
    invoke: (method, args, peer) => gateway.invoke({
      namespace: PI_TUI_AUTHORIZATION_NAMESPACE,
      method,
      args,
      peer,
      signal: new AbortController().signal,
    }),
    stream: (method, args, peer) => gateway.stream({
      namespace: PI_TUI_AUTHORIZATION_NAMESPACE,
      method,
      args,
      peer,
      signal: new AbortController().signal,
    }),
    registerFlow: flow => (host.ctx.reflect.get('authorization') as AuthorizationService).registerFlow(flow),
    activeAttempts,
    dispose: async () => {
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** Read frames until a predicate is true, returning everything read. */
async function readUntil(
  iterator: AsyncIterator<unknown>,
  predicate: (frame: AuthorizationWireFrame) => boolean,
): Promise<AuthorizationWireFrame[]> {
  const frames: AuthorizationWireFrame[] = []
  for (;;) {
    const next = await within(iterator.next(), 'one authorization frame')
    if (next.done === true) return frames
    const frame = parsePiTuiAuthorizationFrame(next.value)
    frames.push(frame)
    if (predicate(frame)) return frames
  }
}

/** Read one more parsed frame. */
async function readFrame(iterator: AsyncIterator<unknown>): Promise<AuthorizationWireFrame> {
  const next = await within(iterator.next(), 'one authorization frame')
  assert.equal(next.done, false, 'the stream ended before the expected frame')
  return parsePiTuiAuthorizationFrame(next.value)
}

function terminalOf(frames: readonly AuthorizationWireFrame[]): AuthorizationWireFrame & { kind: 'settled' | 'unconfirmed' } {
  const terminal = frames[frames.length - 1]
  assert.ok(terminal !== undefined && (terminal.kind === 'settled' || terminal.kind === 'unconfirmed'),
    `the last frame must be terminal: ${JSON.stringify(frames)}`)
  return terminal
}

/** A credential record the official flow is allowed to commit. */
function grantRecord(token: string): { kind: 'grant'; payload: unknown } {
  return { kind: 'grant', payload: { provider: 'f7a', token } }
}

test('IN_PROCESS: list projects the official roster with the llm-pi-ai route and no foreign route', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-list')
  try {
    const registered = host.registerFlow({
      key: credentialKey('llm-pi-ai', 'f7a-codex'),
      label: 'F7A Codex',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async () => {},
    })
    host.registerFlow({
      key: credentialKey('other-plugin', 'grant'),
      label: 'Foreign flow',
      methods: [{ id: 'foreign', label: 'Foreign' }],
      run: async () => {},
    })
    const snapshot = parsePiTuiAuthorizationTargetsSnapshot(
      await host.invoke('list', {}, host.peerA),
    ) as AuthorizationTargetsSnapshot
    assert.equal(snapshot.kind, 'ready')
    if (snapshot.kind !== 'ready') return
    const codex = snapshot.targets.find(target => target.key === 'llm-pi-ai/f7a-codex')
    assert.deepEqual(codex, {
      kind: 'authorization',
      route: 'f7a-codex',
      key: 'llm-pi-ai/f7a-codex',
      label: 'F7A Codex',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false,
    })
    const foreign = snapshot.targets.find(target => target.key === 'other-plugin/grant')
    assert.equal(foreign?.route, undefined, 'a foreign scope must not fabricate a provider route')
    assert.equal('token' in (codex as object), false)
    registered()
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a missing official authorization service is a definite unavailable and a NO_FLOW attempt', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-missing', { authorization: false })
  try {
    const snapshot = parsePiTuiAuthorizationTargetsSnapshot(
      await host.invoke('list', {}, host.peerA),
    )
    assert.deepEqual(snapshot, {
      kind: 'unavailable',
      reason: 'the Host authorization service is not installed',
    })
    const stream = await host.stream('run', { key: 'llm-pi-ai/none' }, host.peerA)
    const frames = await readUntil(stream[Symbol.asyncIterator](), frame => frame.kind === 'settled')
    assert.equal(frames[0]?.kind, 'started')
    const terminal = terminalOf(frames)
    assert.equal(terminal.kind, 'settled')
    if (terminal.kind !== 'settled') return
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.code, 'NO_FLOW')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: notice, text/secret/select prompts and the official commit settle authorized exactly once', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-flow')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-flow') as CredentialKey
    host.registerFlow({
      key,
      label: 'F7A flow',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        session.notify({ message: 'Open the page', url: 'https://example.test/auth', code: 'CODE-1' })
        const first = await session.prompt({ kind: 'text', message: 'Your account name' })
        const secret = await session.prompt({ kind: 'secret', message: 'Paste the secret' })
        const picked = await session.prompt({
          kind: 'select',
          message: 'Pick one',
          options: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }],
        })
        await session.commit(grantRecord(`${first}|${secret}|${picked}`) as never)
      },
    })
    const iterator = (await host.stream('run', { key, method: 'device' }, host.peerA))[Symbol.asyncIterator]()
    const started = await readFrame(iterator)
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    const seen: string[] = []
    let answers: string[] = []
    for (;;) {
      const frame = await readFrame(iterator)
      if (frame.kind === 'settled') {
        assert.deepEqual(frame, { kind: 'settled', attemptId: started.attemptId, status: 'authorized' })
        break
      }
      if (frame.kind === 'notice') {
        seen.push(`notice:${frame.notice.message}:${frame.notice.url}:${frame.notice.code}`)
        continue
      }
      if (frame.kind !== 'prompt') {
        assert.fail(`unexpected frame ${JSON.stringify(frame)}`)
      }
      seen.push(`prompt:${frame.prompt.kind}:${frame.prompt.message}`)
      const answer = frame.prompt.kind === 'select' ? 'left' : frame.prompt.kind === 'secret' ? 'shh' : 'acct'
      await host.invoke('respond', { attemptId: started.attemptId, promptId: frame.promptId, answer }, host.peerA)
      answers.push(answer)
    }
    assert.deepEqual(seen, [
      'notice:Open the page:https://example.test/auth:CODE-1',
      'prompt:text:Your account name',
      'prompt:secret:Paste the secret',
      'prompt:select:Pick one',
    ])
    assert.deepEqual(answers, ['acct', 'shh', 'left'])
    const record = await host.ctx.credentials.readRecord(key)
    assert.deepEqual(record, grantRecord('acct|shh|left'))
    assert.equal(host.activeAttempts(), 0, 'the settled stream must release the Host attempt')
    assert.equal((await host.ctx.credentials.describeRecord(key)).configured, true)
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a human decline settles cancelled (not failed) and clears the attempt', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-decline')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-decline') as CredentialKey
    host.registerFlow({
      key,
      label: 'F7A decline',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        await session.prompt({ kind: 'text', message: 'Your code' })
        await session.commit(grantRecord('never') as never)
      },
    })
    const iterator = (await host.stream('run', { key }, host.peerA))[Symbol.asyncIterator]()
    const started = await readFrame(iterator)
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    const prompt = await readFrame(iterator)
    assert.equal(prompt.kind, 'prompt')
    if (prompt.kind !== 'prompt') return
    await host.invoke('respond', { attemptId: started.attemptId, promptId: prompt.promptId, answer: null }, host.peerA)
    const after = await readUntil(iterator, frame => frame.kind === 'settled')
    const terminal = terminalOf(after)
    assert.equal(terminal.kind, 'settled')
    if (terminal.kind !== 'settled') return
    assert.equal(terminal.status, 'cancelled')
    assert.equal((await host.ctx.credentials.describeRecord(key)).configured, false)
    assert.equal(host.activeAttempts(), 0)
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a prompt withdrawn by its own signal closes only that prompt and the flow continues', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-withdraw')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-withdraw') as CredentialKey
    const controller = new AbortController()
    host.registerFlow({
      key,
      label: 'F7A withdraw',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        const losing = session.prompt({ kind: 'text', message: 'Losing prompt', signal: controller.signal })
          .catch(() => 'withdrawn')
        // Retire the prompt exactly as a real racing flow does, then continue
        // with the winning prompt and the commit.
        controller.abort()
        assert.equal(await losing, 'withdrawn')
        await session.prompt({ kind: 'text', message: 'Winning prompt' })
        await session.commit(grantRecord('won') as never)
      },
    })
    const iterator = (await host.stream('run', { key }, host.peerA))[Symbol.asyncIterator]()
    const started = await readFrame(iterator)
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    const withdrawn = await readFrame(iterator)
    assert.equal(withdrawn.kind, 'prompt')
    if (withdrawn.kind !== 'prompt') return
    const withdrawal = await readFrame(iterator)
    assert.deepEqual(withdrawal, {
      kind: 'prompt-withdrawn',
      attemptId: started.attemptId,
      promptId: withdrawn.promptId,
    })
    const winning = await readFrame(iterator)
    assert.equal(winning.kind, 'prompt')
    if (winning.kind !== 'prompt') return
    assert.equal(winning.prompt.kind, 'text')
    await host.invoke('respond', { attemptId: started.attemptId, promptId: winning.promptId, answer: 'ok' }, host.peerA)
    const rest = await readUntil(iterator, frame => frame.kind === 'settled')
    const terminal = terminalOf(rest)
    assert.equal(terminal.kind, 'settled')
    if (terminal.kind !== 'settled') return
    assert.equal(terminal.status, 'authorized')
    assert.deepEqual(await host.ctx.credentials.readRecord(key), grantRecord('won'))
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: official refusals surface as ONE safe failed terminal', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-refuse')
  try {
    const noCommit = credentialKey('llm-pi-ai', 'f7a-no-commit') as CredentialKey
    host.registerFlow({
      key: noCommit,
      label: 'F7A no commit',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async () => {},
    })
    const methodKey = credentialKey('llm-pi-ai', 'f7a-method') as CredentialKey
    host.registerFlow({
      key: methodKey,
      label: 'F7A method',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => { await session.commit(grantRecord('x') as never) },
    })
    const cases: Array<{ args: Record<string, unknown>; code: string }> = [
      { args: { key: 'llm-pi-ai/f7a-absent' }, code: 'NO_FLOW' },
      { args: { key: methodKey, method: 'nope' }, code: 'UNKNOWN_METHOD' },
      { args: { key: noCommit }, code: 'NOT_COMMITTED' },
    ]
    for (const entry of cases) {
      const stream = await host.stream('run', entry.args, host.peerA)
      const frames = await readUntil(stream[Symbol.asyncIterator](), frame => frame.kind === 'settled')
      assert.equal(frames[0]?.kind, 'started', `${entry.code}: the stream admission comes first`)
      const terminal = terminalOf(frames)
      assert.equal(terminal.kind, 'settled')
      if (terminal.kind !== 'settled') continue
      assert.equal(terminal.status, 'failed', entry.code)
      assert.equal(terminal.code, entry.code)
      assert.equal(typeof terminal.message, 'string')
      assert.equal(host.activeAttempts(), 0)
    }
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: two attempts on the same key are refused ALREADY_IN_FLIGHT without disturbing the first', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-busy')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-busy') as CredentialKey
    host.registerFlow({
      key,
      label: 'F7A busy',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        await session.prompt({ kind: 'text', message: 'Code' })
        await session.commit(grantRecord('busy') as never)
      },
    })
    const first = (await host.stream('run', { key }, host.peerA))[Symbol.asyncIterator]()
    const firstStart = await readFrame(first)
    assert.equal(firstStart.kind, 'started')
    if (firstStart.kind !== 'started') return
    const firstPrompt = await readFrame(first)
    assert.equal(firstPrompt.kind, 'prompt')
    if (firstPrompt.kind !== 'prompt') return
    const second = (await host.stream('run', { key }, host.peerB))[Symbol.asyncIterator]()
    const secondFrames = await readUntil(second, frame => frame.kind === 'settled')
    const secondTerminal = terminalOf(secondFrames)
    assert.equal(secondTerminal.kind, 'settled')
    if (secondTerminal.kind !== 'settled') return
    assert.equal(secondTerminal.status, 'failed')
    assert.equal(secondTerminal.code, 'ALREADY_IN_FLIGHT')
    // The first attempt is untouched and still owns its prompt.
    await host.invoke('respond', { attemptId: firstStart.attemptId, promptId: firstPrompt.promptId, answer: 'ok' }, host.peerA)
    const firstRest = await readUntil(first, frame => frame.kind === 'settled')
    const firstTerminal = terminalOf(firstRest)
    assert.equal(firstTerminal.kind, 'settled')
    if (firstTerminal.kind !== 'settled') return
    assert.equal(firstTerminal.status, 'authorized')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: another owner peer can neither answer nor cancel an attempt it does not own', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-peer')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-peer') as CredentialKey
    host.registerFlow({
      key,
      label: 'F7A peer',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        await session.prompt({ kind: 'secret', message: 'Secret code' })
        await session.commit(grantRecord('owner-answer') as never)
      },
    })
    const iterator = (await host.stream('run', { key }, host.peerA))[Symbol.asyncIterator]()
    const started = await readFrame(iterator)
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    const prompt = await readFrame(iterator)
    assert.equal(prompt.kind, 'prompt')
    if (prompt.kind !== 'prompt') return
    await assert.rejects(
      host.invoke('respond', { attemptId: started.attemptId, promptId: prompt.promptId, answer: 'stolen' }, host.peerB),
      /different peer/,
    )
    await assert.rejects(host.invoke('cancel', { attemptId: started.attemptId }, host.peerB), /different peer/)
    // The owner's prompt is still pending and the official attempt is alive.
    await host.invoke('respond', { attemptId: started.attemptId, promptId: prompt.promptId, answer: 'mine' }, host.peerA)
    const rest = await readUntil(iterator, frame => frame.kind === 'settled')
    const terminal = terminalOf(rest)
    assert.equal(terminal.kind, 'settled')
    if (terminal.kind !== 'settled') return
    assert.equal(terminal.status, 'authorized')
    assert.deepEqual(await host.ctx.credentials.readRecord(key), grantRecord('owner-answer'))
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: a cancel request does not forge cancelled when the official commit was already accepted', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-cancel-commit')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-cancel-commit') as CredentialKey
    let release: () => void = () => {}
    const barrier = new Promise<void>(resolve => { release = resolve })
    host.registerFlow({
      key,
      label: 'F7A cancel commit',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        session.notify({ message: 'committing' })
        await session.commit(grantRecord('committed') as never)
        await barrier
      },
    })
    const iterator = (await host.stream('run', { key }, host.peerA))[Symbol.asyncIterator]()
    const started = await readFrame(iterator)
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    const notice = await readFrame(iterator)
    assert.equal(notice.kind, 'notice')
    // The commit is observably durable BEFORE the cancel request: cancelling at
    // this point must not turn the official outcome into `cancelled`.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await host.ctx.credentials.describeRecord(key)).configured) break
      await sleep(10)
    }
    assert.equal((await host.ctx.credentials.describeRecord(key)).configured, true)
    await host.invoke('cancel', { attemptId: started.attemptId }, host.peerA)
    release()
    const rest = await readUntil(iterator, frame => frame.kind === 'settled')
    const terminal = terminalOf(rest)
    assert.equal(terminal.kind, 'settled')
    if (terminal.kind !== 'settled') return
    assert.equal(terminal.status, 'authorized')
  } finally {
    await host.dispose()
  }
})

test('IN_PROCESS: closing the attempt stream withdraws the official attempt and releases every owner', async (t) => {
  const life = testLifecycle(t)
  const host = await hostFixture(life, 'f7a-host-close')
  try {
    const key = credentialKey('llm-pi-ai', 'f7a-close') as CredentialKey
    const state = { promptSettled: false }
    host.registerFlow({
      key,
      label: 'F7A close',
      methods: [{ id: 'device', label: 'Device code' }],
      run: async (session: AuthorizationSession) => {
        try {
          await session.prompt({ kind: 'text', message: 'Code' })
        } finally {
          state.promptSettled = true
        }
      },
    })
    const stream = await host.stream('run', { key }, host.peerA)
    const iterator = stream[Symbol.asyncIterator]()
    const started = await readFrame(iterator)
    assert.equal(started.kind, 'started')
    await readFrame(iterator)
    assert.equal(host.activeAttempts(), 1)
    await iterator.return?.()
    for (let attempt = 0; attempt < 200 && !state.promptSettled; attempt += 1) await sleep(10)
    assert.equal(state.promptSettled, true, 'the withdrawn attempt must release its pending prompt')
    for (let attempt = 0; attempt < 200 && host.activeAttempts() !== 0; attempt += 1) await sleep(10)
    assert.equal(host.activeAttempts(), 0, 'a closed stream must leave no attempt behind')
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!(host.ctx.reflect.get('authorization') as AuthorizationService).describe(key)?.inFlight) break
      await sleep(10)
    }
    assert.equal((host.ctx.reflect.get('authorization') as AuthorizationService).describe(key)?.inFlight, false)
  } finally {
    await host.dispose()
  }
})
