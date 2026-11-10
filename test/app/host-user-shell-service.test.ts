import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { PiTuiHostUserShellService, type PiTuiHostUserShellHostDeps } from '../../src/app/host/features/host-user-shell.ts'
import type { HostUserShellAck, HostUserShellFrame } from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'

const requestId = '550e8400-e29b-41d4-a716-446655440000'

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: item })
    else this.items.push(item)
  }

  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const item = this.items.shift()
        if (item !== undefined) return { done: false, value: item }
        if (this.ended) return { done: true, value: undefined }
        return await new Promise<IteratorResult<T>>(resolve => { this.waiters.push(resolve) })
      },
      return: async () => { this.end(); return { done: true, value: undefined } },
    }
  }
}

async function mount(deps: PiTuiHostUserShellHostDeps, remoteInvocation?: unknown): Promise<{ service: PiTuiHostUserShellService; ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (remoteInvocation !== undefined) Object.defineProperty(ctx, 'invocation', { configurable: true, value: remoteInvocation })
  let service: PiTuiHostUserShellService | undefined
  const fiber = ctx.inject(PiTuiHostUserShellService.inject, pluginCtx => {
    service = new PiTuiHostUserShellService(pluginCtx, deps)
  })
  await fiber
  if (service === undefined) throw new Error('Host Shell test service did not mount')
  return { service, ctx }
}

function ownerInvocation(uplink: AsyncQueue<unknown>, signal = new AbortController().signal): unknown {
  const peer = { id: 'peer-owner', principal: { kind: 'owner' }, signal }
  return { peer, signal, uplink: () => uplink }
}

function hostDeps(overrides: Partial<PiTuiHostUserShellHostDeps> = {}): PiTuiHostUserShellHostDeps {
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  return {
    agentFor: () => agent,
    sessionFor: () => session,
    workingDirectory: () => ({ get: () => process.cwd() }),
    sandboxPolicy: () => undefined,
    sandbox: () => undefined,
    subprocess: () => undefined,
    pathCompletion: { complete: async () => ({ kind: 'ok', candidates: [] }) },
    shellPolicy: () => 'bypass',
    ...overrides,
  }
}

async function refusalAndDrain(
  service: PiTuiHostUserShellService,
  signal = new AbortController().signal,
): Promise<unknown> {
  const iterator = service.run('session-a', requestId, process.cwd(), 'true', 'bypass', signal)[Symbol.asyncIterator]()
  const refusal = await iterator.next()
  assert.equal(refusal.value?.kind, 'refused')
  assert.equal((await iterator.next()).done, true, 'the caller drains the refusal terminal')
  return refusal.value
}

test('a missing Gateway invocation refuses before Session lookup or process spawn', async () => {
  let lookups = 0
  let spawns = 0
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => { lookups += 1; return undefined },
    subprocess: () => ({ spawn: () => { spawns += 1; throw new Error('must not spawn') } }),
  }))
  await refusalAndDrain(service)
  assert.equal(lookups, 0)
  assert.equal(spawns, 0)
  await ctx.fiber.dispose()
})

test('a non-owner Gateway principal refuses before Host Session lookup', async () => {
  let lookups = 0
  let spawns = 0
  const signal = new AbortController().signal
  const nonOwner = { peer: { id: 'peer-viewer', principal: { kind: 'viewer' }, signal }, signal, uplink: () => new AsyncQueue<unknown>() }
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => { lookups += 1; return undefined },
    subprocess: () => ({ spawn: () => { spawns += 1; throw new Error('must not spawn') } }),
  }), nonOwner)
  await refusalAndDrain(service, signal)
  assert.equal(lookups, 0)
  assert.equal(spawns, 0)
  await ctx.fiber.dispose()
})

test('missing subprocess and synchronous spawn failure are terminal pre-start refusals', async () => {
  for (const failure of ['missing-provider', 'spawn-throws'] as const) {
    const signal = new AbortController().signal
    const uplink = new AsyncQueue<unknown>()
    let spawnCalls = 0
    const { service, ctx } = await mount(hostDeps({
      subprocess: () => failure === 'missing-provider' ? undefined : ({
        spawn: () => { spawnCalls += 1; throw new Error('spawn unavailable') },
      }),
    }), ownerInvocation(uplink, signal))
    try {
      const iterator = service.run('session-a', requestId, process.cwd(), 'true', 'bypass', signal)[Symbol.asyncIterator]()
      const refusal = await iterator.next()
      assert.equal(refusal.value?.kind, 'refused', `${failure} is known before a process starts`)
      if (refusal.value?.kind !== 'refused') throw new Error('expected a pre-start refusal')
      assert.equal(refusal.value.reason, 'policy-unavailable')
      assert.match(refusal.value.message, /nothing was executed/u)
      assert.equal((await iterator.next()).done, true, 'the refusal is the stream terminal fact')
      assert.equal(spawnCalls, failure === 'missing-provider' ? 0 : 1)
    } finally {
      uplink.end()
      await ctx.fiber.dispose()
    }
  }
})

test('matching Session ids do not substitute for exact Agent/Session object identity', async () => {
  let spawns = 0
  const signal = new AbortController().signal
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session: { id: 'session-a' } }
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    subprocess: () => ({ spawn: () => { spawns += 1; throw new Error('must not spawn') } }),
  }), ownerInvocation(new AsyncQueue<unknown>(), signal))
  await refusalAndDrain(service, signal)
  assert.equal(spawns, 0)
  await ctx.fiber.dispose()
})

test('Owner stream preserves raw Host bytes and withholds terminal until consumption ACK', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  const bytes = Buffer.from([0xff, 0xc3, 0x28, 0x00])
  let argv: readonly string[] | undefined
  let terminateCalls = 0
  const { service, ctx } = await mount(hostDeps({
    subprocess: () => ({ spawn: spec => {
      argv = spec.argv
      return {
        stdin: undefined,
        control: undefined,
        collected: {},
        stdout: Readable.from([bytes]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 7, signal: null }),
        terminate: () => { terminateCalls += 1 },
        waitForExit: async () => true,
      }
    } }),
  }), ownerInvocation(uplink, signal))
  try {
    const iterator = service.run('session-a', requestId, process.cwd(), 'printf raw', 'bypass', signal)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.kind, 'started')
    const output = await iterator.next()
    if (output.value?.kind !== 'output') throw new Error('expected raw output frame')
    assert.deepEqual(Buffer.from(output.value.base64, 'base64'), bytes)
    let terminalDelivered = false
    const terminalPromise = iterator.next().then(frame => { terminalDelivered = true; return frame })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(terminalDelivered, false, 'Host waits for the actual consumer ACK')
    uplink.push({ kind: 'ack', requestId, seq: output.value.seq } satisfies HostUserShellAck)
    const terminal = await terminalPromise
    assert.equal(terminal.value?.kind, 'settled')
    if (terminal.value?.kind !== 'settled') throw new Error('expected authoritative terminal exit')
    assert.deepEqual(terminal.value.exit, { kind: 'exit', code: 7 })
    assert.equal(terminal.value.sandboxDenied, false)
    assert.deepEqual(argv?.slice(0, 2), ['bash', '-c'])
    assert.ok(argv?.[2]?.startsWith('exec 3>&2\nexec 2> >('), 'the one Bash invocation bridges Host stderr before running the user command')
    assert.ok(argv?.[2]?.includes(process.execPath), 'the stderr relay uses the exact Host Node runtime')
    assert.ok(argv?.[2]?.endsWith('\nprintf raw'), 'the original user command stays the final Bash script source')
    assert.equal(terminateCalls, 0)
    assert.equal((await iterator.next()).done, true)
  } finally {
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('the live Host shell policy refuses a mismatched Client policy before subprocess spawn', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  let spawns = 0
  let confines = 0
  const { service, ctx } = await mount(hostDeps({
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => {
      confines += 1
      return { argv: ['/sandbox-runner', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    } }),
    subprocess: () => ({ spawn: () => { spawns += 1; throw new Error('Host policy mismatch must not spawn') } }),
  }), ownerInvocation(uplink, signal))
  try {
    const iterator = service.run('session-a', requestId, process.cwd(), 'true', 'bypass', signal)[Symbol.asyncIterator]()
    const refusal = await iterator.next()
    assert.equal(refusal.value?.kind, 'refused')
    if (refusal.value?.kind !== 'refused') throw new Error('expected Host policy refusal')
    assert.equal(refusal.value.reason, 'policy-unavailable')
    assert.match(refusal.value.message, /does not match the current Host preference/u)
    assert.equal((await iterator.next()).done, true)
    assert.equal(confines, 0, 'the mismatched Client request does not prepare a different Host policy')
    assert.equal(spawns, 0, 'Client-reported bypass never weakens Host-owned sandbox mode')
  } finally {
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('a Host policy change during sandbox preparation is rechecked before spawn', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  let hostPolicy: 'bypass' | 'sandbox' = 'sandbox'
  let spawns = 0
  const { service, ctx } = await mount(hostDeps({
    shellPolicy: () => hostPolicy,
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => {
      hostPolicy = 'bypass'
      return { argv: ['/sandbox-runner', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    } }),
    subprocess: () => ({ spawn: () => { spawns += 1; throw new Error('stale Host policy must not spawn') } }),
  }), ownerInvocation(uplink, signal))
  try {
    const iterator = service.run('session-a', requestId, process.cwd(), 'true', 'sandbox', signal)[Symbol.asyncIterator]()
    const refusal = await iterator.next()
    assert.equal(refusal.value?.kind, 'refused')
    if (refusal.value?.kind !== 'refused') throw new Error('expected Host policy-currentness refusal')
    assert.match(refusal.value.message, /changed during preparation/u)
    assert.equal((await iterator.next()).done, true)
    assert.equal(spawns, 0)
  } finally {
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('Host Git subcommand completion requests Git main commands with the required list group', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  let argv: readonly string[] | undefined
  const { service, ctx } = await mount(hostDeps({
    subprocess: () => ({ spawn: spec => {
      argv = spec.argv
      return {
        stdin: undefined,
        control: undefined,
        collected: {},
        stdout: Readable.from([Buffer.from('checkout\n')]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
        waitForExit: async () => true,
      }
    } }),
  }), ownerInvocation(uplink, signal))
  try {
    assert.deepEqual(await service.complete('session-a', { kind: 'subcommands', command: 'git', prefix: 'che' }, signal), {
      kind: 'ok', candidates: ['checkout'],
    })
    assert.deepEqual(argv, ['git', '--list-cmds=main'])
  } finally {
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('Remote completion answers from the exact live Host Session workspace', async () => {
  const signal = new AbortController().signal
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  let calls = 0
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    pathCompletion: { complete: async (_cwd, prefix) => { calls += 1; return { kind: 'ok', candidates: [`host:${prefix}`] } } },
  }), ownerInvocation(new AsyncQueue<unknown>(), signal))
  assert.deepEqual(await service.complete('session-a', { kind: 'paths', prefix: 'src/de' }, signal), {
    kind: 'ok', candidates: ['host:src/de'],
  })
  assert.equal(calls, 1)
  await ctx.fiber.dispose()
})

test('full Host sandbox denial is a distinct settled outcome', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  let spawnArgv: readonly string[] | undefined
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => ({
      argv: ['/sandbox-runner', ...argv],
      enforcement: 'full',
      denialSignatures: ['policy-denied: '],
      runnerFailureRules: [],
    }) }),
    subprocess: () => ({ spawn: spec => {
      spawnArgv = spec.argv
      return {
        stdin: undefined, control: undefined, collected: {},
        stdout: Readable.from([]), stderr: Readable.from([Buffer.from('policy-denied: /outside/file\n')]),
        done: Promise.resolve({ exitCode: 13, signal: null }),
        terminate: () => {}, waitForExit: async () => true,
      }
    } }),
  }), ownerInvocation(uplink, signal))
  try {
    const iterator = service.run('session-a', requestId, process.cwd(), 'touch /outside/file', 'sandbox', signal)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.kind, 'started')
    const output = await iterator.next()
    if (output.value?.kind !== 'output') throw new Error('expected sandbox diagnostic output')
    uplink.push({ kind: 'ack', requestId, seq: output.value.seq } satisfies HostUserShellAck)
    const settled = await iterator.next()
    if (settled.value?.kind !== 'settled') throw new Error('expected command-level sandbox denial settlement')
    assert.equal(settled.value.sandboxDenied, true)
    assert.deepEqual(settled.value.exit, { kind: 'exit', code: 13 })
    assert.deepEqual(spawnArgv?.slice(0, 3), ['/sandbox-runner', 'bash', '-c'])
    assert.ok(spawnArgv?.[3]?.startsWith('exec 3>&2\nexec 2> >('))
    assert.ok(spawnArgv?.[3]?.endsWith(`\ntouch /outside/file`))
    assert.equal((await iterator.next()).done, true)
  } finally {
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('sandbox runner failure signatures at the end of a long stderr line stay bounded and fail closed', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  const stderr = Buffer.from(`${'x'.repeat(200_000)}runner: failed to establish confinement`)
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => ({
      argv: ['/sandbox-runner', ...argv],
      enforcement: 'full',
      denialSignatures: ['denied: '],
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: '], informationalLines: [] }],
    }) }),
    subprocess: () => ({ spawn: spec => ({
      stdin: undefined, control: undefined, collected: {},
      stdout: Readable.from([]), stderr: Readable.from([stderr]),
      done: Promise.resolve({ exitCode: 125, signal: null }),
      terminate: () => {}, waitForExit: async () => true,
      spec,
    }) }),
  }), ownerInvocation(uplink, signal))
  try {
    const iterator = service.run('session-a', requestId, process.cwd(), 'touch file', 'sandbox', signal)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value?.kind, 'started')
    let terminal: IteratorResult<HostUserShellFrame> | undefined
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) { terminal = next; break }
      if (next.value.kind === 'output') uplink.push({ kind: 'ack', requestId, seq: next.value.seq } satisfies HostUserShellAck)
      else if (next.value.kind === 'failed' || next.value.kind === 'settled') { terminal = next; break }
    }
    assert.equal(terminal?.value?.kind, 'failed')
    if (terminal?.value?.kind !== 'failed') throw new Error('the bounded classifier must recognize the Host runner failure')
    assert.equal(terminal.value.phase, 'sandbox-runner')
    assert.equal((await iterator.next()).done, true)
  } finally {
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('a user stdout runner-looking line does not become a sandbox runner failure', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => ({
      argv: ['/sandbox-runner', ...argv],
      enforcement: 'full',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: '], informationalLines: [] }],
    }) }),
    subprocess: () => ({ spawn: () => ({
      stdin: undefined, control: undefined, collected: {},
      stdout: Readable.from([Buffer.from('runner: user output\\n')]),
      stderr: Readable.from([]),
      done: Promise.resolve({ exitCode: 125, signal: null }),
      terminate: () => {}, waitForExit: async () => true,
    }) }),
  }), ownerInvocation(uplink, signal))
  const iterator = service.run('session-a', requestId, process.cwd(), 'printf runner', 'sandbox', signal)[Symbol.asyncIterator]()
  try {
    assert.equal((await iterator.next()).value?.kind, 'started')
    const output = await iterator.next()
    if (output.value?.kind !== 'output') throw new Error('expected stdout output')
    uplink.push({ kind: 'ack', requestId, seq: output.value.seq } satisfies HostUserShellAck)
    const settled = await iterator.next()
    assert.equal(settled.value?.kind, 'settled')
    if (settled.value?.kind !== 'settled') throw new Error('expected command settlement')
    assert.deepEqual(settled.value.exit, { kind: 'exit', code: 125 })
    assert.equal(settled.value.sandboxDenied, false)
  } finally {
    await iterator.return?.()
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('denial signatures split across stdout and stderr are not spliced into a denial', async () => {
  const signal = new AbortController().signal
  const uplink = new AsyncQueue<unknown>()
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => ({
      argv: ['/sandbox-runner', ...argv],
      enforcement: 'full',
      denialSignatures: ['read-only file system'],
      runnerFailureRules: [],
    }) }),
    subprocess: () => ({ spawn: () => ({
      stdin: undefined, control: undefined, collected: {},
      stdout: Readable.from([Buffer.from('read-only ')]),
      stderr: Readable.from([Buffer.from('file system\\n')]),
      done: Promise.resolve({ exitCode: 1, signal: null }),
      terminate: () => {}, waitForExit: async () => true,
    }) }),
  }), ownerInvocation(uplink, signal))
  const iterator = service.run('session-a', requestId, process.cwd(), 'printf split', 'sandbox', signal)[Symbol.asyncIterator]()
  try {
    assert.equal((await iterator.next()).value?.kind, 'started')
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('expected terminal settlement')
      if (next.value.kind === 'output') uplink.push({ kind: 'ack', requestId, seq: next.value.seq } satisfies HostUserShellAck)
      else {
        assert.equal(next.value.kind, 'settled')
        if (next.value.kind === 'settled') assert.equal(next.value.sandboxDenied, false)
        break
      }
    }
  } finally {
    await iterator.return?.()
    uplink.end()
    await ctx.fiber.dispose()
  }
})

test('partial Host sandbox enforcement refuses before subprocess spawn', async () => {
  const signal = new AbortController().signal
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  let spawns = 0
  const { service, ctx } = await mount(hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => ({ argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) }),
    subprocess: () => ({ spawn: () => { spawns += 1; throw new Error('must not spawn under partial enforcement') } }),
  }), ownerInvocation(new AsyncQueue<unknown>(), signal))
  try {
    const iterator = service.run('session-a', requestId, process.cwd(), 'true', 'sandbox', signal)[Symbol.asyncIterator]()
    const refusal = await iterator.next()
    assert.equal(refusal.value?.kind, 'refused')
    if (refusal.value?.kind !== 'refused') throw new Error('expected policy refusal')
    assert.equal(refusal.value.reason, 'policy-unavailable')
    assert.equal((await iterator.next()).done, true)
    assert.equal(spawns, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})
