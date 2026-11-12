import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { formatHostUserShellResult } from '../../src/app/submission/user-shell.ts'
import {
  PiTuiHostUserShellService,
  type PiTuiHostUserShellHostDeps,
  type SandboxServiceLike,
  type SandboxPolicyServiceLike,
  type SubprocessServiceLike,
} from '../../src/app/host/features/host-user-shell.ts'
import {
  MAX_HOST_USER_SHELL_RESULT_BYTES,
  MAX_HOST_USER_SHELL_STREAM_BYTES,
} from '../../src/runtime/host-user-shell-port.ts'
import { parseHostUserShellRunOutcome } from '../../src/runtime/remote/pi-tui-host-user-shell-contract.ts'

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

function ownerInvocation(signal = new AbortController().signal): unknown {
  const peer = { id: 'peer-owner', principal: { kind: 'owner' }, signal }
  return { peer, signal }
}

function collectedReader(text: string, truncated = false, spillPath?: string) {
  return {
    readFrom: (_fromByte: number) => ({
      text,
      nextOffset: Buffer.byteLength(text, 'utf8'),
      lossy: truncated,
      ...(spillPath === undefined ? {} : { spillPath }),
    }),
  }
}

interface FakeHandleOptions {
  readonly outcome?: SubprocessOutcome
  readonly doneError?: unknown
  readonly stdout?: string
  readonly stderr?: string
  readonly stdoutTruncated?: boolean
  readonly stderrTruncated?: boolean
  readonly stdoutSpill?: string
  readonly stderrSpill?: string
  readonly waitForExit?: () => Promise<boolean>
  /** Per-call results for `waitForExit`; an Error rejects that call. */
  readonly waitForExitResults?: readonly (boolean | Error)[]
  readonly onTerminate?: () => void
  readonly onWaitForExit?: () => void
  /** Resolve only after the spawn spec's abort signal fires. */
  readonly killOnAbort?: boolean
  readonly signal?: AbortSignal
}

function fakeHandle(options: FakeHandleOptions = {}): SubprocessHandle {
  const outcome = options.outcome ?? { exitCode: 0, signal: null }
  let waitIndex = 0
  const waitForExit = async (): Promise<boolean> => {
    options.onWaitForExit?.()
    if (options.waitForExitResults === undefined) {
      return options.waitForExit === undefined ? true : await options.waitForExit()
    }
    const next = options.waitForExitResults[waitIndex]
    waitIndex += 1
    if (next instanceof Error) throw next
    return next ?? true
  }
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: collectedReader(options.stdout ?? '', options.stdoutTruncated ?? false, options.stdoutSpill),
      stderr: collectedReader(options.stderr ?? '', options.stderrTruncated ?? false, options.stderrSpill),
    },
    done: options.doneError !== undefined
      ? Promise.reject(options.doneError)
      : options.killOnAbort === true
        ? new Promise<SubprocessOutcome>(resolve => {
          // The abort listener, not a timed wait: the promise settles on the
          // real signal event (`resolveOnAbort`, not the fixed-wait helper
          // name `settle`).
          const resolveOnAbort = (): void => resolve({ exitCode: null, signal: 'SIGTERM' })
          if (options.signal?.aborted === true) resolveOnAbort()
          else options.signal?.addEventListener('abort', resolveOnAbort, { once: true })
        })
        : Promise.resolve(outcome),
    terminate: () => options.onTerminate?.(),
    waitForExit,
  }
}

interface Fixture {
  readonly subprocess: SubprocessServiceLike
  readonly spawns: SubprocessSpawnSpec[]
  spawnError?: Error
  beforeSpawn?: (spec: SubprocessSpawnSpec) => void
  handle: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

function fakeSubprocess(handle: (spec: SubprocessSpawnSpec) => SubprocessHandle): Fixture {
  const fixture: Fixture = {
    spawns: [],
    handle,
    subprocess: {
      spawn(spec) {
        fixture.beforeSpawn?.(spec)
        if (fixture.spawnError !== undefined) throw fixture.spawnError
        fixture.spawns.push(spec)
        return fixture.handle(spec)
      },
    },
  }
  return fixture
}

function hostDeps(overrides: Partial<PiTuiHostUserShellHostDeps> = {}): {
  readonly deps: PiTuiHostUserShellHostDeps
  readonly session: { readonly id: string }
  readonly agent: { readonly id: string; readonly session: { readonly id: string } }
} {
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  return {
    session,
    agent,
    deps: {
      agentFor: () => agent,
      sessionFor: () => session,
      workingDirectory: () => ({ get: () => process.cwd() }),
      sandboxPolicy: () => undefined,
      sandbox: () => undefined,
      subprocess: () => undefined,
      pathCompletion: { complete: async () => ({ kind: 'ok', candidates: [] }) },
      shellPolicy: () => 'bypass',
      workspaces: () => undefined,
      ...overrides,
    },
  }
}

async function run(service: PiTuiHostUserShellService, options: {
  readonly command?: string
  readonly policy?: 'bypass' | 'sandbox'
  readonly signal?: AbortSignal
  readonly cwd?: string
} = {}) {
  return service.run(
    'session-a',
    options.cwd ?? process.cwd(),
    options.command ?? 'true',
    options.policy ?? 'bypass',
    options.signal ?? new AbortController().signal,
  )
}

function fullConfined(argv: readonly string[], overrides: Partial<ConfinedArgv> = {}): ConfinedArgv {
  return {
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
    ...overrides,
  }
}

test('Windows Host Bash execution fails closed before Session lookup or spawn', async () => {
  let lookups = 0
  const subprocess = fakeSubprocess(() => fakeHandle())
  const { deps } = hostDeps({
    agentFor: () => { lookups += 1; return undefined },
    sessionFor: () => { lookups += 1; return undefined },
    subprocess: () => subprocess.subprocess,
  })
  const { service, ctx } = await mount(deps, ownerInvocation())
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  assert.ok(platform?.configurable)
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const outcome = await run(service)
    assert.equal(outcome.kind, 'refused')
    if (outcome.kind !== 'refused') throw new Error('expected a refusal')
    assert.equal(outcome.reason, 'policy-unavailable')
    assert.match(outcome.message, /unsupported on Windows/u)
    assert.equal(lookups, 0)
    assert.equal(subprocess.spawns.length, 0)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    await ctx.fiber.dispose()
  }
})

test('a non-owner or missing Gateway invocation refuses before any Host lookup', async () => {
  for (const invocation of [undefined, { peer: { id: 'v', principal: { kind: 'viewer' }, signal: new AbortController().signal }, signal: new AbortController().signal }]) {
    let lookups = 0
    const subprocess = fakeSubprocess(() => fakeHandle())
    const { deps } = hostDeps({
      agentFor: () => { lookups += 1; return undefined },
      subprocess: () => subprocess.subprocess,
    })
    const { service, ctx } = await mount(deps, invocation)
    const outcome = await run(service)
    assert.equal(outcome.kind, 'refused')
    if (outcome.kind !== 'refused') throw new Error('expected an Owner refusal')
    assert.equal(outcome.reason, 'invalid-request')
    assert.equal(lookups, 0)
    assert.equal(subprocess.spawns.length, 0)
    await ctx.fiber.dispose()
  }
})

test('a missing live Session, mismatched cwd, or mismatched Host policy refuses before spawn', async () => {
  const cases: readonly {
    readonly label: string
    readonly deps: Partial<PiTuiHostUserShellHostDeps>
    readonly cwd?: string
    readonly policy?: 'bypass' | 'sandbox'
    readonly reason: string
  }[] = [
    { label: 'missing live Session', deps: { agentFor: () => undefined }, reason: 'scope-unavailable' },
    { label: 'mismatched expected cwd', deps: {}, cwd: '/definitely/not/the/host/cwd', reason: 'scope-unavailable' },
    { label: 'mismatched Client policy', deps: { shellPolicy: () => 'sandbox' }, policy: 'bypass', reason: 'policy-unavailable' },
  ]
  for (const entry of cases) {
    const subprocess = fakeSubprocess(() => fakeHandle())
    const { deps } = hostDeps({ ...entry.deps, subprocess: () => subprocess.subprocess })
    const { service, ctx } = await mount(deps, ownerInvocation())
    try {
      const outcome = await run(service, { cwd: entry.cwd, policy: entry.policy })
      assert.equal(outcome.kind, 'refused', entry.label)
      if (outcome.kind !== 'refused') throw new Error('expected a refusal')
      assert.equal(outcome.reason, entry.reason, entry.label)
      assert.equal(subprocess.spawns.length, 0, `${entry.label}: zero spawn`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('matching Session ids do not substitute for exact Agent/Session object identity', async () => {
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session: { id: 'session-a' } }
  const subprocess = fakeSubprocess(() => fakeHandle())
  const { deps } = hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    subprocess: () => subprocess.subprocess,
  })
  const { service, ctx } = await mount(deps, ownerInvocation())
  const outcome = await run(service)
  assert.equal(outcome.kind, 'refused')
  assert.equal(subprocess.spawns.length, 0)
  await ctx.fiber.dispose()
})

test('a missing Host subprocess provider refuses truthfully without executing', async () => {
  const { deps } = hostDeps()
  const { service, ctx } = await mount(deps, ownerInvocation())
  const outcome = await run(service)
  assert.equal(outcome.kind, 'refused')
  if (outcome.kind !== 'refused') throw new Error('expected a provider refusal')
  assert.equal(outcome.reason, 'policy-unavailable')
  assert.match(outcome.message, /subprocess provider is unavailable/u)
  await ctx.fiber.dispose()
})

test('bypass spawns the RAW bash argv exactly once with bounded collect/spill dispositions and no relay', async () => {
  const subprocess = fakeSubprocess(() => fakeHandle({
    outcome: { exitCode: 7, signal: null },
    stdout: 'raw\ufffd\n',
    stderr: 'err\n',
  }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service, { command: 'printf raw' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected a settled run')
    assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 7 })
    assert.deepEqual(outcome.result.stdout, { text: 'raw\ufffd\n', truncated: false })
    assert.deepEqual(outcome.result.stderr, { text: 'err\n', truncated: false })
    assert.equal(subprocess.spawns.length, 1)
    const spec = subprocess.spawns[0]!
    assert.deepEqual(spec.argv, ['bash', '-c', 'printf raw'])
    assert.equal(spec.cwd, process.cwd())
    assert.equal(spec.stdio.stdin, 'ignore')
    assert.deepEqual(spec.stdio.stdout, {
      maxBytes: MAX_HOST_USER_SHELL_STREAM_BYTES,
      spill: { maxBytes: 64 * 1024 * 1024 },
    })
    assert.deepEqual(spec.stdio.stderr, spec.stdio.stdout)
    assert.equal(spec.graceMs, 5_000)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('sandbox confines the RAW argv exactly once and spawns the EXACT returned argv', async () => {
  const session = { id: 'session-a' }
  const agent = { id: 'session-a', session }
  const confined: ConfinedArgv = fullConfined(['bash', '-c', 'touch /outside/file'], { denialSignatures: ['policy-denied: '] })
  const resolvedPolicy = { mode: 'workspace-write' as const, workspaceRoot: process.cwd() }
  const confineCalls: { readonly argv: readonly string[]; readonly policy: unknown; readonly signal: AbortSignal }[] = []
  const sandbox: SandboxServiceLike = {
    confine: async (argv, policy, signal) => {
      confineCalls.push({ argv, policy, signal: signal! })
      return confined
    },
  }
  const subprocess = fakeSubprocess(() => fakeHandle({
    outcome: { exitCode: 13, signal: null },
    stderr: 'policy-denied: /outside/file\n',
  }))
  const { deps } = hostDeps({
    agentFor: () => agent,
    sessionFor: () => session,
    shellPolicy: () => 'sandbox',
    subprocess: () => subprocess.subprocess,
    sandboxPolicy: () => ({ resolve: async () => resolvedPolicy }),
    sandbox: () => sandbox,
  })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service, { policy: 'sandbox', command: 'touch /outside/file' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected a settled sandbox run')
    assert.equal(outcome.result.sandboxDenied, true)
    assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 13 })
    assert.equal(confineCalls.length, 1, 'the official sandbox confine ran exactly once')
    assert.deepEqual(confineCalls[0]!.argv, ['bash', '-c', 'touch /outside/file'])
    assert.deepEqual(confineCalls[0]!.policy, resolvedPolicy)
    assert.equal(subprocess.spawns.length, 1)
    assert.strictEqual(subprocess.spawns[0]!.argv, confined.argv,
      'the EXACT argv returned by the one confine call is what was spawned')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('sandbox partial enforcement fails closed BEFORE spawn (zero spawn) and never re-confines', async () => {
  let confineCalls = 0
  const subprocess = fakeSubprocess(() => fakeHandle())
  const { deps } = hostDeps({
    shellPolicy: () => 'sandbox',
    subprocess: () => subprocess.subprocess,
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => {
      confineCalls += 1
      return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }
    } }),
  })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service, { policy: 'sandbox' })
    assert.equal(outcome.kind, 'refused')
    if (outcome.kind !== 'refused') throw new Error('expected a fail-closed refusal')
    assert.equal(outcome.reason, 'policy-unavailable')
    assert.match(outcome.message, /enforcement is not full/u)
    assert.equal(confineCalls, 1)
    assert.equal(subprocess.spawns.length, 0, 'partial enforcement must never spawn')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('sandbox danger-full-access, missing providers, and confine failure refuse before spawn', async () => {
  const cases: readonly {
    readonly label: string
    readonly sandboxPolicy?: SandboxPolicyServiceLike
    readonly sandbox?: SandboxServiceLike
  }[] = [
    {
      label: 'danger-full-access',
      sandboxPolicy: { resolve: async () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
      sandbox: { confine: async () => { throw new Error('must not confine danger-full-access') } },
    },
    { label: 'missing policy provider' },
    {
      label: 'missing sandbox provider',
      sandboxPolicy: { resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) },
    },
    {
      label: 'confine failure',
      sandboxPolicy: { resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) },
      sandbox: { confine: async () => { throw new Error('no usable runner') } },
    },
  ]
  for (const entry of cases) {
    const subprocess = fakeSubprocess(() => fakeHandle())
    const { deps } = hostDeps({
      shellPolicy: () => 'sandbox',
      subprocess: () => subprocess.subprocess,
      ...(entry.sandboxPolicy === undefined ? {} : { sandboxPolicy: () => entry.sandboxPolicy! }),
      ...(entry.sandbox === undefined ? {} : { sandbox: () => entry.sandbox! }),
    })
    const { service, ctx } = await mount(deps, ownerInvocation())
    try {
      const outcome = await run(service, { policy: 'sandbox' })
      assert.equal(outcome.kind, 'refused', entry.label)
      if (outcome.kind !== 'refused') throw new Error('expected a refusal')
      assert.equal(outcome.reason, 'policy-unavailable', entry.label)
      assert.equal(subprocess.spawns.length, 0, `${entry.label}: zero spawn`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('runner-failure rules and denial signatures classify the collected STDERR only', async () => {
  const confinedFor = (overrides: Partial<ConfinedArgv>): ConfinedArgv => fullConfined(['/runner', 'bash', '-c', 'true'], overrides)
  const runnerFailure = confinedFor({
    runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: failed'], informationalLines: [] }],
  })
  const runnerSubprocess = fakeSubprocess(() => fakeHandle({
    outcome: { exitCode: 125, signal: null },
    stderr: 'runner: failed to establish confinement\n',
  }))
  const runnerDeps = hostDeps({
    shellPolicy: () => 'sandbox',
    subprocess: () => runnerSubprocess.subprocess,
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async () => runnerFailure }),
  })
  const runner = await mount(runnerDeps.deps, ownerInvocation())
  try {
    const outcome = await run(runner.service, { policy: 'sandbox' })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind !== 'failed') throw new Error('expected a runner failure')
    assert.equal(outcome.phase, 'sandbox-runner')
    assert.equal(runnerSubprocess.spawns.length, 1, 'the runner failure is classified after the real spawn')
  } finally {
    await runner.ctx.fiber.dispose()
  }

  const denial = confinedFor({ denialSignatures: ['permission denied'] })
  const denialSubprocess = fakeSubprocess(() => fakeHandle({
    outcome: { exitCode: 1, signal: null },
    stdout: 'permission denied\n',
    stderr: 'permission denied\n',
  }))
  const denialDeps = hostDeps({
    shellPolicy: () => 'sandbox',
    subprocess: () => denialSubprocess.subprocess,
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async () => denial }),
  })
  const denialMount = await mount(denialDeps.deps, ownerInvocation())
  try {
    const outcome = await run(denialMount.service, { policy: 'sandbox' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected a settled denial')
    assert.equal(outcome.result.sandboxDenied, true)
  } finally {
    await denialMount.ctx.fiber.dispose()
  }

  const stdoutOnly = confinedFor({ denialSignatures: ['permission denied'] })
  const stdoutSubprocess = fakeSubprocess(() => fakeHandle({
    outcome: { exitCode: 1, signal: null },
    stdout: 'permission denied\n',
    stderr: '',
  }))
  const stdoutDeps = hostDeps({
    shellPolicy: () => 'sandbox',
    subprocess: () => stdoutSubprocess.subprocess,
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async () => stdoutOnly }),
  })
  const stdoutMount = await mount(stdoutDeps.deps, ownerInvocation())
  try {
    const outcome = await run(stdoutMount.service, { policy: 'sandbox' })
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected a settled run')
    assert.equal(outcome.result.sandboxDenied, false, 'a stdout-only signature is not a sandbox denial')
  } finally {
    await stdoutMount.ctx.fiber.dispose()
  }
})

test('a truncated nonzero sandbox diagnostic is reason-unknown unless the retained tail matches a runner-fatal rule', async () => {
  const cases: readonly {
    readonly label: string
    readonly confined: ConfinedArgv
    readonly exitCode: number
    readonly stderr: string
    readonly expect: 'runner-failure' | 'reason-unknown'
  }[] = [
    {
      label: 'runner fatal in the retained tail',
      confined: fullConfined(['/runner', 'bash', '-c', 'true'], {
        runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: fatal'], informationalLines: [] }],
      }),
      exitCode: 125,
      stderr: 'runner: fatal\n',
      expect: 'runner-failure',
    },
    {
      label: 'denial signature in the retained tail',
      confined: fullConfined(['/runner', 'bash', '-c', 'true'], {
        denialSignatures: ['permission denied'],
      }),
      exitCode: 1,
      stderr: 'permission denied\n',
      expect: 'reason-unknown',
    },
  ]
  for (const entry of cases) {
    const subprocess = fakeSubprocess(() => fakeHandle({
      outcome: { exitCode: entry.exitCode, signal: null },
      stderr: entry.stderr,
      stderrTruncated: true,
    }))
    const { deps } = hostDeps({
      shellPolicy: () => 'sandbox',
      subprocess: () => subprocess.subprocess,
      sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
      sandbox: () => ({ confine: async () => entry.confined }),
    })
    const { service, ctx } = await mount(deps, ownerInvocation())
    try {
      const outcome = await run(service, { policy: 'sandbox' })
      assert.equal(subprocess.spawns.length, 1)
      if (entry.expect === 'runner-failure') {
        assert.equal(outcome.kind, 'failed', `${entry.label}: a retained runner-fatal line outranks truncation`)
        if (outcome.kind !== 'failed') throw new Error('expected a runner failure')
        assert.equal(outcome.phase, 'sandbox-runner', entry.label)
        assert.match(outcome.message, /sandbox runner failed before the user command executed \(runner: fatal\)/u, entry.label)
        continue
      }
      assert.equal(outcome.kind, 'settled', `${entry.label}: the reason is uncertain, not a claimed runner failure`)
      if (outcome.kind !== 'settled') throw new Error('expected a reason-unknown settlement')
      assert.deepEqual(outcome.result.exit, { kind: 'exit', code: entry.exitCode })
      assert.equal(outcome.result.stderr.truncated, true)
      assert.equal(outcome.result.sandboxDenied, false,
        `${entry.label}: truncated diagnostics never serialize a definite denial`)
      const card = formatHostUserShellResult(outcome.result, 'sandbox')
      assert.ok(card.includes('stderr truncated; failure reason cannot be determined, command may have executed; do not retry automatically'),
        `${entry.label}: the Remote Host result renders the shared reason-unknown notice`)
      assert.ok(card.includes(`[exit ${String(entry.exitCode)}]`), `${entry.label}: the real exit fact is shown`)
      assert.doesNotMatch(card, /sandbox denied/u, `${entry.label}: no definite denial on truncated diagnostics`)
      assert.doesNotMatch(card, /failed:/u, `${entry.label}: the card is not an ordinary failure card`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('signatures evicted into the truncated stderr prefix are reason-unknown, not runner failure or denial', async () => {
  // Whole-stream source: both a runner-fatal line and a denial line LIVE at
  // the head. The official Subprocess collector's readFrom(0) returns only the
  // retained 64 KiB tail with lossy:true, so the service sees NEITHER line.
  const prefix = 'runner: fatal to establish confinement\npermission denied\n'
  const trailing = 'x'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES + 4_096)
  const whole = `${prefix}${trailing}`
  const retainedTail = whole.slice(-MAX_HOST_USER_SHELL_STREAM_BYTES)
  assert.ok(whole.includes('runner: fatal') && whole.includes('permission denied'))
  assert.ok(!retainedTail.includes('runner: fatal') && !retainedTail.includes('permission denied'),
    'the retained tail used by the result genuinely lacks both evicted signatures')

  for (const exitCode of [125, 1]) {
    const confined = fullConfined(['/runner', 'bash', '-c', 'true'], {
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: fatal'], informationalLines: [] }],
      denialSignatures: ['permission denied'],
    })
    const subprocess = fakeSubprocess(() => fakeHandle({
      outcome: { exitCode, signal: null },
      stderr: retainedTail,
      stderrTruncated: true,
    }))
    const { deps } = hostDeps({
      shellPolicy: () => 'sandbox',
      subprocess: () => subprocess.subprocess,
      sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
      sandbox: () => ({ confine: async () => confined }),
    })
    const { service, ctx } = await mount(deps, ownerInvocation())
    try {
      const outcome = await run(service, { policy: 'sandbox' })
      assert.equal(outcome.kind, 'settled', `exit ${String(exitCode)}: the evicted signatures cannot disprove a hidden runner fatal`)
      if (outcome.kind !== 'settled') throw new Error('expected a reason-unknown settlement')
      assert.deepEqual(outcome.result.exit, { kind: 'exit', code: exitCode })
      assert.equal(outcome.result.stderr.truncated, true)
      assert.equal(outcome.result.sandboxDenied, false, 'the evicted denial line is not in the retained tail')
      const serialized = parseHostUserShellRunOutcome({ kind: 'settled', result: outcome.result })
      assert.equal(serialized.kind, 'settled')
      if (serialized.kind !== 'settled') throw new Error('expected a serializable settled outcome')
      assert.equal(serialized.result.sandboxDenied, false,
        'the wire DTO carries NO sandbox-denied fact for this reason-unknown state')
      const card = formatHostUserShellResult(outcome.result, 'sandbox')
      assert.ok(card.includes('stderr truncated; failure reason cannot be determined, command may have executed; do not retry automatically'))
      assert.ok(card.includes(`[exit ${String(exitCode)}]`))
      assert.doesNotMatch(card, /sandbox denied/u)
      assert.doesNotMatch(card, /failed:/u)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('Session identity and Host policy are rechecked immediately before spawn', async () => {
  const cases: readonly {
    readonly label: string
    readonly mutate: 'session' | 'policy'
    readonly pattern: RegExp
  }[] = [
    { label: 'Session changed', mutate: 'session', pattern: /Session or working directory changed/u },
    { label: 'Host policy changed', mutate: 'policy', pattern: /policy changed during preparation/u },
  ]
  for (const entry of cases) {
    const firstSession = { id: 'session-a' }
    const secondSession = { id: 'session-a' }
    const fixture = fakeSubprocess(() => fakeHandle())
    const state: {
      agent: { id: string; session: { id: string } }
      session: { id: string }
      policy: 'sandbox' | 'bypass'
    } = {
      agent: { id: 'session-a', session: firstSession },
      session: firstSession,
      policy: 'sandbox',
    }
    const { deps } = hostDeps({
      agentFor: () => state.agent,
      sessionFor: () => state.session,
      shellPolicy: () => state.policy,
      subprocess: () => fixture.subprocess,
      sandboxPolicy: () => ({ resolve: async () => {
        if (entry.mutate === 'session') {
          state.agent = { id: 'session-a', session: secondSession }
          state.session = secondSession
        } else {
          state.policy = 'bypass'
        }
        return { mode: 'workspace-write', workspaceRoot: process.cwd() }
      } }),
      sandbox: () => ({ confine: async argv => fullConfined(argv) }),
    })
    const { service, ctx } = await mount(deps, ownerInvocation())
    try {
      const outcome = await run(service, { policy: 'sandbox' })
      assert.equal(outcome.kind, 'refused', entry.label)
      if (outcome.kind !== 'refused') throw new Error('expected a preparation-currentness refusal')
      assert.match(outcome.message, entry.pattern, entry.label)
      assert.equal(fixture.spawns.length, 0, `${entry.label}: the stale preparation never spawned`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('spawn and provider failures keep pre-start/refused and post-start/failed phases distinct', async () => {
  const preStart = fakeSubprocess(() => fakeHandle())
  preStart.spawnError = new Error('spawn unavailable')
  const refusedDeps = hostDeps({ subprocess: () => preStart.subprocess })
  const refusedMount = await mount(refusedDeps.deps, ownerInvocation())
  const refusedOutcome = await run(refusedMount.service)
  assert.equal(refusedOutcome.kind, 'refused')
  if (refusedOutcome.kind !== 'refused') throw new Error('expected a pre-start refusal')
  assert.match(refusedOutcome.message, /could not start.*spawn unavailable/u)
  await refusedMount.ctx.fiber.dispose()

  const provider = fakeSubprocess(() => fakeHandle({ doneError: new Error('provider vanished') }))
  const failedDeps = hostDeps({ subprocess: () => provider.subprocess })
  const failedMount = await mount(failedDeps.deps, ownerInvocation())
  const failedOutcome = await run(failedMount.service)
  assert.equal(failedOutcome.kind, 'failed')
  if (failedOutcome.kind !== 'failed') throw new Error('expected a post-start failure')
  assert.equal(failedOutcome.phase, 'infrastructure')
  assert.match(failedOutcome.message, /failed before reporting an outcome.*provider vanished/u)
  await failedMount.ctx.fiber.dispose()

  const runner = fakeSubprocess(() => fakeHandle())
  runner.spawnError = Object.assign(new Error('runner ENOENT'), { code: 'ENOENT', path: '/runner', syscall: 'spawn' })
  const runnerDeps = hostDeps({
    shellPolicy: () => 'sandbox',
    subprocess: () => runner.subprocess,
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }),
    sandbox: () => ({ confine: async argv => fullConfined(['/runner', ...argv]) }),
  })
  const runnerMount = await mount(runnerDeps.deps, ownerInvocation())
  const runnerOutcome = await run(runnerMount.service, { policy: 'sandbox' })
  assert.equal(runnerOutcome.kind, 'failed')
  if (runnerOutcome.kind !== 'failed') throw new Error('expected a runner spawn failure')
  assert.equal(runnerOutcome.phase, 'sandbox-runner')
  await runnerMount.ctx.fiber.dispose()
})

test('bounded collected output is clamped to the semantic tail and never becomes unbounded', async () => {
  const text = `${'a'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES)}TAIL`
  const subprocess = fakeSubprocess(() => fakeHandle({
    stdout: text,
    stderr: 'small',
    stderrTruncated: true,
    stdoutSpill: '/host/spill/out',
  }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service)
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected a settled run')
    assert.equal(outcome.result.stdout.truncated, true)
    assert.equal(outcome.result.stdout.text.endsWith('TAIL'), true)
    assert.ok(Buffer.byteLength(outcome.result.stdout.text, 'utf8') <= MAX_HOST_USER_SHELL_STREAM_BYTES)
    assert.equal(outcome.result.stdout.spillPath, '/host/spill/out')
    assert.equal(outcome.result.stderr.truncated, true)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('two full per-stream tails are clamped to the total result bound', async () => {
  const subprocess = fakeSubprocess(() => fakeHandle({
    stdout: 'a'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES),
    stderr: 'b'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES),
  }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service)
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected a settled run')
    const total = Buffer.byteLength(outcome.result.stdout.text, 'utf8')
      + Buffer.byteLength(outcome.result.stderr.text, 'utf8')
    assert.ok(total <= MAX_HOST_USER_SHELL_RESULT_BYTES, `the result stayed within the total bound (got ${total})`)
    assert.equal(outcome.result.stdout.truncated, false)
    assert.equal(outcome.result.stderr.truncated, true, 'the second stream is tail-clamped for the total budget')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a run without any exit fact is a truthful infrastructure failure', async () => {
  const subprocess = fakeSubprocess(() => fakeHandle({ outcome: { exitCode: null, signal: null } }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation())
  const outcome = await run(service)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') throw new Error('expected an infrastructure failure')
  assert.equal(outcome.phase, 'infrastructure')
  assert.match(outcome.message, /neither an exit code/u)
  await ctx.fiber.dispose()
})

test('a managed-range observation failure terminates, retries unbounded, and keeps the real outcome', async () => {
  let terminates = 0
  let waits = 0
  const subprocess = fakeSubprocess(() => fakeHandle({
    stdout: 'ok\n',
    outcome: { exitCode: 0, signal: null },
    waitForExitResults: [new Error('range observation failed'), true],
    onTerminate: () => { terminates += 1 },
    onWaitForExit: () => { waits += 1 },
  }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service)
    assert.equal(outcome.kind, 'settled', 'the retry confirmed an empty range and the observed exit facts stay authoritative')
    if (outcome.kind !== 'settled') throw new Error('expected the recovered settlement')
    assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 0 })
    assert.deepEqual(outcome.result.stdout, { text: 'ok\n', truncated: false })
    assert.equal(terminates, 1, 'the official terminate was issued on the observation failure')
    assert.equal(waits, 2, 'the unbounded no-signal waitForExit was retried exactly once')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a managed-range observation that cannot be confirmed is an explicit unknown, never a clean settlement', async () => {
  let terminates = 0
  let waits = 0
  const subprocess = fakeSubprocess(() => fakeHandle({
    stdout: 'ok\n',
    outcome: { exitCode: 0, signal: null },
    waitForExitResults: [new Error('first observation failed'), new Error('second observation failed')],
    onTerminate: () => { terminates += 1 },
    onWaitForExit: () => { waits += 1 },
  }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation())
  try {
    const outcome = await run(service)
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind !== 'failed') throw new Error('expected an explicit unknown infrastructure failure')
    assert.equal(outcome.phase, 'infrastructure')
    assert.match(outcome.message, /could not be observed/u)
    assert.match(outcome.message, /outcome is unknown/u)
    assert.match(outcome.message, /cleanup is not confirmed/u)
    assert.match(outcome.message, /second observation failed/u)
    assert.equal(terminates, 1)
    assert.equal(waits, 2, 'the second rejection is surfaced, not swallowed')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('cancellation aborts the spawn signal and dispose joins the active run', async () => {
  const controller = new AbortController()
  const subprocess = fakeSubprocess(spec => fakeHandle({ killOnAbort: true, signal: spec.signal }))
  const { deps } = hostDeps({ subprocess: () => subprocess.subprocess })
  const { service, ctx } = await mount(deps, ownerInvocation(controller.signal))
  try {
    const pending = run(service, { signal: controller.signal })
    while (subprocess.spawns.length === 0) await new Promise(resolve => setImmediate(resolve))
    const spawnedSignal = subprocess.spawns[0]!.signal
    assert.ok(spawnedSignal !== undefined)
    assert.equal(spawnedSignal!.aborted, false)
    controller.abort()
    assert.equal(spawnedSignal!.aborted, true, 'the caller abort reaches the official spawn signal')
    const outcome = await pending
    assert.equal(outcome.kind, 'settled')
    if (outcome.kind !== 'settled') throw new Error('expected the killed run to settle')
    assert.equal(outcome.result.aborted, true)
    assert.deepEqual(outcome.result.exit, { kind: 'signal', signal: 'SIGTERM' })
    await service.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('completion still uses the Host subprocess helper authority', async () => {
  const signal = new AbortController().signal
  const { Readable } = await import('node:stream')
  const spawns: SubprocessSpawnSpec[] = []
  const { deps } = hostDeps({
    subprocess: () => ({ spawn: spec => {
      spawns.push(spec)
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
  })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    assert.deepEqual(await service.complete('session-a', { kind: 'subcommands', command: 'git', prefix: 'che' }, signal), {
      kind: 'ok', candidates: ['checkout'],
    })
    assert.deepEqual(spawns[0]!.argv, ['git', '--list-cmds=main'])
  } finally {
    await ctx.fiber.dispose()
  }
})

test('Remote completion answers from the exact live Host Session workspace', async () => {
  const signal = new AbortController().signal
  let calls = 0
  const { deps } = hostDeps({
    pathCompletion: { complete: async (_cwd, prefix) => { calls += 1; return { kind: 'ok', candidates: [`host:${prefix}`] } } },
  })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    assert.deepEqual(await service.complete('session-a', { kind: 'paths', prefix: 'src/de' }, signal), {
      kind: 'ok', candidates: ['host:src/de'],
    })
    assert.equal(calls, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

// ── G14 sessionless Workspace completion (official workspaceRegistry) ───────

/** A registry whose `get` is the official id/path authority for one Host. */
function fakeWorkspaceRegistry(pathOf: (id: string) => string | undefined) {
  const lookups: string[] = []
  return {
    lookups,
    registry: {
      get(id: string) {
        lookups.push(id)
        const path = pathOf(id)
        return path === undefined ? undefined : { path }
      },
    },
  }
}

test('Workspace completion answers from the official registry path, not a Session or the Client', async () => {
  const signal = new AbortController().signal
  const { Readable } = await import('node:stream')
  const spawns: SubprocessSpawnSpec[] = []
  // A registered path DISTINCT from process.cwd() (and from the Session working
  // directory): a bug that used either would resolve the wrong directory.
  const workspacePath = mkdtempSync(join(tmpdir(), 'g14-registry-'))
  const { lookups, registry } = fakeWorkspaceRegistry(() => workspacePath)
  const { deps } = hostDeps({
    agentFor: () => { throw new Error('sessionless completion must not resolve a Host Agent') },
    sessionFor: () => { throw new Error('sessionless completion must not resolve a Host Session') },
    workingDirectory: () => { throw new Error('sessionless completion must not read a Session working directory') },
    workspaces: () => registry,
    subprocess: () => ({ spawn: spec => {
      spawns.push(spec)
      return {
        stdin: undefined,
        control: undefined,
        collected: {},
        stdout: Readable.from([Buffer.from('git\ncheckout\n')]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
        waitForExit: async () => true,
      }
    } }),
  })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    assert.deepEqual(await service.completeWorkspace('workspace-a', { kind: 'commands', prefix: 'gi' }, signal), {
      kind: 'ok', candidates: ['git', 'checkout'],
    })
    assert.deepEqual(lookups, ['workspace-a', 'workspace-a'], 'the registry is the authority BEFORE and AFTER the completion')
    assert.equal(spawns.length, 1, 'only the read-only completion helper spawns')
    assert.deepEqual(spawns[0]!.argv.slice(0, 3), ['bash', '-c', 'compgen -A command -- "$1"'])
    assert.equal(spawns[0]!.cwd, workspacePath, 'the helper queries the REGISTERED Workspace path')
    assert.notEqual(spawns[0]!.cwd, process.cwd(), 'the path is not the process cwd (a cwd fallback would be visible)')
  } finally {
    await ctx.fiber.dispose()
    rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('Workspace path completion uses the same Host path bridge under the Workspace path', async () => {
  const signal = new AbortController().signal
  const seen: string[] = []
  const workspacePath = mkdtempSync(join(tmpdir(), 'g14-registry-'))
  const { registry } = fakeWorkspaceRegistry(() => workspacePath)
  const { deps } = hostDeps({
    workspaces: () => registry,
    pathCompletion: { complete: async (cwd, prefix) => { seen.push(`${cwd}|${prefix}`); return { kind: 'ok', candidates: ['src/'] } } },
  })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    assert.deepEqual(await service.completeWorkspace('workspace-a', { kind: 'paths', prefix: 'sr' }, signal), {
      kind: 'ok', candidates: ['src/'],
    })
    assert.deepEqual(seen, [`${workspacePath}|sr`])
  } finally {
    await ctx.fiber.dispose()
    rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an unregistered, empty or unreadable Workspace is a definite unavailable fact with no helper run', async () => {
  const signal = new AbortController().signal
  const spawns: SubprocessSpawnSpec[] = []
  const { registry } = fakeWorkspaceRegistry(id => id === 'readable' ? process.cwd()
    : id === 'unreadable' ? '/definitely/not/a/host/directory/m6-g14'
      : id === 'relative' ? 'relative/g14-workspace'
        : undefined)
  const { deps } = hostDeps({
    workspaces: () => registry,
    subprocess: () => ({ spawn: spec => {
      spawns.push(spec)
      throw new Error('an unavailable Workspace must never start a helper')
    } }),
  })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    for (const workspaceId of ['missing', '', 'unreadable', 'relative']) {
      const outcome = await service.completeWorkspace(workspaceId, { kind: 'commands', prefix: 'gi' }, signal)
      assert.equal(outcome.kind, 'unavailable', `Workspace ${JSON.stringify(workspaceId)} must be unavailable: ${JSON.stringify(outcome)}`)
    }
    assert.equal(spawns.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a Host without the Workspace registry answers unavailable instead of guessing a path', async () => {
  const signal = new AbortController().signal
  const { deps } = hostDeps({ workspaces: () => undefined })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    const outcome = await service.completeWorkspace('workspace-a', { kind: 'commands', prefix: 'gi' }, signal)
    assert.equal(outcome.kind, 'unavailable')
    if (outcome.kind !== 'unavailable') throw new Error('expected an unavailable Workspace registry')
    assert.match(outcome.reason, /registry/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a non-owner invocation never consults the Workspace registry', async () => {
  const signal = new AbortController().signal
  const { lookups, registry } = fakeWorkspaceRegistry(() => process.cwd())
  const { deps } = hostDeps({ workspaces: () => registry })
  const { service, ctx } = await mount(deps, {
    peer: { id: 'peer-viewer', principal: { kind: 'viewer' }, signal },
    signal,
  })
  try {
    const outcome = await service.completeWorkspace('workspace-a', { kind: 'commands', prefix: 'gi' }, signal)
    assert.equal(outcome.kind, 'unavailable')
    assert.deepEqual(lookups, [], 'a non-owner call fails closed before the Workspace authority')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a Workspace replaced during the completion retires the old answer', async () => {
  const signal = new AbortController().signal
  let path: string | undefined = process.cwd()
  const { registry } = fakeWorkspaceRegistry(() => path)
  const { deps } = hostDeps({
    workspaces: () => registry,
    pathCompletion: {
      complete: async () => {
        path = join(tmpdir(), 'm6-g14-replaced-workspace')
        return { kind: 'ok', candidates: ['old-answer'] }
      },
    },
  })
  const { service, ctx } = await mount(deps, ownerInvocation(signal))
  try {
    const outcome = await service.completeWorkspace('workspace-a', { kind: 'paths', prefix: 'ol' }, signal)
    assert.equal(outcome.kind, 'unavailable')
    if (outcome.kind !== 'unavailable') throw new Error('expected the replaced Workspace to be unavailable')
    assert.match(outcome.reason, /changed during completion/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('aborting a Workspace completion rejects and drops the settled helper answer', async () => {
  const { Readable } = await import('node:stream')
  const controller = new AbortController()
  const registry = fakeWorkspaceRegistry(() => process.cwd())
  const { deps } = hostDeps({
    workspaces: () => registry.registry,
    subprocess: () => ({ spawn: () => ({
      stdin: undefined,
      control: undefined,
      collected: {},
      stdout: Readable.from([Buffer.from('git\n')]),
      stderr: Readable.from([]),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: async () => true,
    }) }),
  })
  const { service, ctx } = await mount(deps, ownerInvocation(controller.signal))
  try {
    controller.abort()
    await assert.rejects(
      () => service.completeWorkspace('workspace-a', { kind: 'commands', prefix: 'gi' }, controller.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
  } finally {
    await ctx.fiber.dispose()
  }
})
