/**
 * Direct Host user-shell adapter coverage: both policies run the raw
 * `['bash', '-c', command]` argv through the SAME official subprocess core the
 * split Host uses; sandbox confines exactly once with the exact Session policy
 * and fails closed before spawn unless enforcement is full.
 * @module @xmoon76/dsh-pi-tui/host-user-shell-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessServiceLike } from '../../src/runtime/host-user-shell-execution.ts'
import {
  DirectHostUserShellPort,
  type DirectHostUserShellDeps,
} from '../../src/runtime/direct/host-user-shell-direct.ts'
import { formatHostUserShellResult } from '../../src/app/submission/user-shell.ts'
import {
  MAX_HOST_USER_SHELL_STREAM_BYTES,
  type HostUserShellResult,
} from '../../src/runtime/host-user-shell-port.ts'

const idle = new AbortController().signal
const session = { id: 's' }

function request(overrides: Partial<Parameters<DirectHostUserShellPort['execute']>[0]> = {}) {
  return {
    sessionId: 's',
    cwd: process.cwd(),
    command: 'true',
    policy: 'bypass' as const,
    signal: idle,
    ...overrides,
  }
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

interface HandleOptions {
  readonly outcome?: SubprocessOutcome
  readonly doneError?: unknown
  readonly stdout?: string
  readonly stderr?: string
  readonly stdoutTruncated?: boolean
  readonly stderrTruncated?: boolean
  readonly stdoutSpill?: string
  readonly signal?: AbortSignal
  readonly killOnAbort?: boolean
}

function fakeHandle(options: HandleOptions = {}): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: collectedReader(options.stdout ?? '', options.stdoutTruncated ?? false, options.stdoutSpill),
      stderr: collectedReader(options.stderr ?? '', options.stderrTruncated ?? false),
    },
    done: options.doneError !== undefined
      ? Promise.reject(options.doneError)
      : options.killOnAbort === true
        ? new Promise<SubprocessOutcome>(resolve => {
          const settle = (): void => resolve({ exitCode: null, signal: 'SIGTERM' })
          if (options.signal?.aborted === true) settle()
          else options.signal?.addEventListener('abort', settle, { once: true })
        })
        : Promise.resolve(options.outcome ?? { exitCode: 0, signal: null }),
    terminate: () => {},
    waitForExit: async () => true,
  }
}

interface SubprocessFixture {
  readonly spawns: SubprocessSpawnSpec[]
  readonly service: SubprocessServiceLike
  spawnError?: Error
}

function fakeSubprocess(handle: (spec: SubprocessSpawnSpec) => SubprocessHandle = () => fakeHandle()): SubprocessFixture {
  const fixture = {
    spawns: [] as SubprocessSpawnSpec[],
    spawnError: undefined as Error | undefined,
    service: {
      spawn(spec: SubprocessSpawnSpec) {
        if (fixture.spawnError !== undefined) throw fixture.spawnError
        fixture.spawns.push(spec)
        return handle(spec)
      },
    },
  }
  return fixture as SubprocessFixture
}

interface Fixture {
  readonly deps: DirectHostUserShellDeps
  readonly subprocess: SubprocessFixture
  readonly confineCalls: { readonly argv: readonly string[]; readonly policy: unknown }[]
  readonly sessions: (id: string) => { readonly id: string } | undefined
}

function makeFixture(options: {
  readonly sandboxPolicy?: DirectHostUserShellDeps['sandboxPolicy']
  readonly sandbox?: DirectHostUserShellDeps['sandbox']
  readonly handle?: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly sessionFor?: DirectHostUserShellDeps['sessionFor']
  readonly effectiveCwdFor?: DirectHostUserShellDeps['effectiveCwdFor']
  readonly shellPolicy?: DirectHostUserShellDeps['shellPolicy']
} = {}): Fixture {
  const subprocess = fakeSubprocess(options.handle)
  const confineCalls: { readonly argv: readonly string[]; readonly policy: unknown }[] = []
  const sessions = options.sessionFor ?? (() => session)
  return {
    subprocess,
    confineCalls,
    sessions,
    deps: {
      subprocess: () => subprocess.service,
      sandbox: options.sandbox ?? (() => ({ confine: async (argv, policy) => {
        confineCalls.push({ argv, policy })
        return fullConfined(argv)
      } })),
      sandboxPolicy: options.sandboxPolicy ?? (() => ({ resolve: async () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) })),
      sessionFor: sessions,
      effectiveCwdFor: options.effectiveCwdFor ?? (() => process.cwd()),
      shellPolicy: options.shellPolicy ?? (() => 'bypass'),
    },
  }
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

function port(fixture: Fixture | undefined): DirectHostUserShellPort {
  if (fixture !== undefined) return new DirectHostUserShellPort(fixture.deps)
  return new DirectHostUserShellPort({
    subprocess: () => undefined,
    sandbox: () => undefined,
    sandboxPolicy: () => undefined,
    sessionFor: () => session,
    effectiveCwdFor: () => process.cwd(),
    shellPolicy: () => 'bypass',
  })
}

test('a composition without the official Subprocess provider is unsupported and fails closed', async () => {
  const direct = port(undefined)
  assert.deepEqual(direct.availability, { supported: false, policies: [] })
  for (const policy of ['bypass', 'sandbox'] as const) {
    const outcome = await direct.execute(request({ policy }))
    assert.equal(outcome.kind, 'unavailable')
    if (outcome.kind !== 'unavailable') throw new Error('expected a capability-gap refusal')
    assert.match(outcome.reason.message, /subprocess provider is unavailable/u)
  }
})

test('bypass spawns the raw bash argv exactly once through the official Subprocess port', async () => {
  const fixture = makeFixture({ handle: () => fakeHandle({ outcome: { exitCode: 7, signal: null }, stdout: 'out', stderr: 'err' }) })
  const direct = port(fixture)
  assert.deepEqual(direct.availability, { supported: true, policies: ['bypass', 'sandbox'] })
  const outcome = await direct.execute(request({ command: 'printf out' }))
  assert.equal(outcome.kind, 'settled')
  if (outcome.kind !== 'settled') throw new Error('expected a settled run')
  assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 7 })
  assert.deepEqual(outcome.result.stdout, { text: 'out', truncated: false })
  assert.deepEqual(outcome.result.stderr, { text: 'err', truncated: false })
  assert.equal(fixture.subprocess.spawns.length, 1)
  const spec = fixture.subprocess.spawns[0]!
  assert.deepEqual(spec.argv, ['bash', '-c', 'printf out'])
  assert.equal(spec.cwd, process.cwd())
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.equal(fixture.confineCalls.length, 0, 'bypass performs no confinement')
})

test('sandbox confines the exact Session policy once and spawns the EXACT returned argv', async () => {
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    handle: () => fakeHandle({ outcome: { exitCode: 13, signal: null }, stderr: 'policy-denied\n' }),
  })
  const direct = port(fixture)
  const outcome = await direct.execute(request({ policy: 'sandbox', command: 'touch /outside/file' }))
  assert.equal(outcome.kind, 'settled')
  if (outcome.kind !== 'settled') throw new Error('expected a settled sandbox run')
  assert.equal(fixture.confineCalls.length, 1, 'the official confine ran exactly once')
  assert.deepEqual(fixture.confineCalls[0]!.argv, ['bash', '-c', 'touch /outside/file'])
  assert.deepEqual(fixture.confineCalls[0]!.policy, { mode: 'workspace-write', workspaceRoot: process.cwd() })
  assert.equal(fixture.subprocess.spawns.length, 1)
})

test('sandbox spawns the exact argv object returned by the one confine call', async () => {
  const confined = fullConfined(['bash', '-c', 'printf confined'], { denialSignatures: ['permission denied'] })
  const fixture = makeFixture({ shellPolicy: () => 'sandbox', sandbox: () => ({ confine: async () => confined }) })
  const direct = port(fixture)
  const outcome = await direct.execute(request({ policy: 'sandbox', command: 'printf confined' }))
  assert.equal(outcome.kind, 'settled')
  assert.strictEqual(fixture.subprocess.spawns[0]!.argv, confined.argv,
    'the exact argv returned by the one confine call is spawned')
})

test('sandbox partial enforcement fails closed BEFORE spawn (zero spawn)', async () => {
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    sandbox: () => ({ confine: async argv => fullConfined(argv, { enforcement: 'partial' }) }),
  })
  const outcome = await port(fixture).execute(request({ policy: 'sandbox' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a fail-closed refusal')
  assert.match(outcome.reason.message, /enforcement is not full/u)
  assert.equal(fixture.subprocess.spawns.length, 0, 'partial enforcement must never spawn')
})

test('sandbox danger-full-access and missing sandbox capabilities fail closed before spawn', async () => {
  const danger = makeFixture({
    shellPolicy: () => 'sandbox',
    sandboxPolicy: () => ({ resolve: async () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) }),
  })
  const dangerOutcome = await port(danger).execute(request({ policy: 'sandbox' }))
  assert.equal(dangerOutcome.kind, 'unavailable')
  assert.equal(danger.subprocess.spawns.length, 0)

  const missing = makeFixture({ shellPolicy: () => 'sandbox', sandbox: () => undefined })
  const missingOutcome = await port(missing).execute(request({ policy: 'sandbox' }))
  assert.equal(missingOutcome.kind, 'unavailable')
  assert.match(missingOutcome.kind === 'unavailable' ? missingOutcome.reason.message : '', /sandbox policy is unavailable/u)
  assert.equal(missing.subprocess.spawns.length, 0)
})

test('a missing live Session fails closed without a fabricated identity', async () => {
  const fixture = makeFixture({ sessionFor: () => undefined })
  const outcome = await port(fixture).execute(request())
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a session refusal')
  assert.match(outcome.reason.message, /live Host Session is unavailable/u)
  assert.equal(fixture.subprocess.spawns.length, 0)
})

test('a Session identity that changes during sandbox preparation vetoes the spawn', async () => {
  let current = session
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    sessionFor: () => current,
    sandboxPolicy: () => ({ resolve: async () => {
      current = { id: 's' }
      return { mode: 'workspace-write', workspaceRoot: process.cwd() }
    } }),
  })
  const outcome = await port(fixture).execute(request({ policy: 'sandbox' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a session-change refusal')
  assert.match(outcome.reason.message, /live Host Session changed/u)
  assert.equal(fixture.subprocess.spawns.length, 0, 'the stale Session never spawns')
})


// ── Live cwd/policy currentness: the request values are EXPECTED, not authority ──

test('a matching live cwd and policy spawn exactly once in the official effective cwd', async () => {
  const liveCwd = '/live/workspace-a'
  const fixture = makeFixture({
    effectiveCwdFor: () => liveCwd,
    shellPolicy: () => 'sandbox',
  })
  const outcome = await port(fixture).execute(request({ cwd: liveCwd, policy: 'sandbox', command: 'pwd' }))
  assert.equal(outcome.kind, 'settled')
  assert.equal(fixture.confineCalls.length, 1, 'the official confine ran exactly once')
  assert.equal(fixture.subprocess.spawns.length, 1)
  assert.equal(fixture.subprocess.spawns[0]!.cwd, liveCwd, 'the run uses the checked effective cwd')
})

test('an entry-time cwd mismatch fails closed before any preparation or spawn', async () => {
  const fixture = makeFixture({ effectiveCwdFor: () => '/live/workspace-b' })
  const outcome = await port(fixture).execute(request({ cwd: '/live/workspace-a' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a cwd-currentness refusal')
  assert.match(outcome.reason.message, /Host working directory changed or is unavailable/u)
  assert.equal(fixture.confineCalls.length, 0, 'the stale request is refused before sandbox preparation')
  assert.equal(fixture.subprocess.spawns.length, 0)
})

test('a composition without an authoritative Session cwd fails closed', async () => {
  const fixture = makeFixture({ effectiveCwdFor: () => undefined })
  const outcome = await port(fixture).execute(request())
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a cwd-authority refusal')
  assert.match(outcome.reason.message, /Host working directory changed or is unavailable/u)
  assert.equal(fixture.subprocess.spawns.length, 0)
})

test('an entry-time policy mismatch fails closed in both directions', async () => {
  for (const [requested, live] of [['sandbox', 'bypass'], ['bypass', 'sandbox']] as const) {
    const fixture = makeFixture({ shellPolicy: () => live })
    const outcome = await port(fixture).execute(request({ policy: requested }))
    assert.equal(outcome.kind, 'unavailable', `${requested} request against a live ${live} setting`)
    if (outcome.kind !== 'unavailable') throw new Error('expected a policy-currentness refusal')
    assert.match(outcome.reason.message, /user shell policy changed/u)
    assert.equal(fixture.confineCalls.length, 0, 'nothing is prepared for a stale policy request')
    assert.equal(fixture.subprocess.spawns.length, 0)
  }
})

test('a working-directory change during sandbox preparation vetoes the spawn', async () => {
  let liveCwd = process.cwd()
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    effectiveCwdFor: () => liveCwd,
    sandboxPolicy: () => ({ resolve: async () => {
      // The SAME Session object moves; its identity never changes.
      liveCwd = '/live/workspace-b'
      return { mode: 'workspace-write', workspaceRoot: process.cwd() }
    } }),
  })
  const outcome = await port(fixture).execute(request({ policy: 'sandbox' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a cwd-change refusal')
  assert.match(outcome.reason.message, /Host working directory changed during shell preparation/u)
  assert.equal(fixture.confineCalls.length, 1, 'preparation already ran, but the final gate still vetoes the spawn')
  assert.equal(fixture.subprocess.spawns.length, 0, 'the stale request never spawns')
})

test('a shell-policy change during preparation vetoes the spawn and never switches policy', async () => {
  let livePolicy: 'bypass' | 'sandbox' = 'sandbox'
  const fixture = makeFixture({
    shellPolicy: () => livePolicy,
    sandboxPolicy: () => ({ resolve: async () => {
      livePolicy = 'bypass'
      return { mode: 'workspace-write', workspaceRoot: process.cwd() }
    } }),
  })
  const outcome = await port(fixture).execute(request({ policy: 'sandbox' }))
  assert.equal(outcome.kind, 'unavailable')
  if (outcome.kind !== 'unavailable') throw new Error('expected a policy-change refusal')
  assert.match(outcome.reason.message, /user shell policy changed during shell preparation/u)
  assert.equal(fixture.confineCalls.length, 1)
  assert.equal(fixture.subprocess.spawns.length, 0, 'the changed preference never runs the request under another policy')
})

test('spawn failure is a pre-start refusal; post-start provider failure is a real failure', async () => {
  const spawnFailure = makeFixture()
  spawnFailure.subprocess.spawnError = new Error('spawn unavailable')
  const refused = await port(spawnFailure).execute(request())
  assert.equal(refused.kind, 'unavailable')
  if (refused.kind !== 'unavailable') throw new Error('expected a pre-start refusal')
  assert.match(refused.reason.message, /could not start.*spawn unavailable/u)

  const provider = makeFixture({ handle: () => fakeHandle({ doneError: new Error('provider vanished') }) })
  await assert.rejects(() => port(provider).execute(request()), /failed before reporting an outcome.*provider vanished/u)
})

test('bounded collected output is clamped to the semantic tail and keeps the Host-local spill fact', async () => {
  const text = `${'a'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES)}TAIL`
  const fixture = makeFixture({
    handle: () => fakeHandle({ stdout: text, stderr: 'small', stderrTruncated: true, stdoutSpill: '/host/spill' }),
  })
  const outcome = await port(fixture).execute(request())
  assert.equal(outcome.kind, 'settled')
  if (outcome.kind !== 'settled') throw new Error('expected a settled run')
  assert.equal(outcome.result.stdout.truncated, true)
  assert.equal(outcome.result.stdout.text.endsWith('TAIL'), true)
  assert.ok(Buffer.byteLength(outcome.result.stdout.text, 'utf8') <= MAX_HOST_USER_SHELL_STREAM_BYTES)
  assert.equal(outcome.result.stdout.spillPath, '/host/spill')
  assert.equal(outcome.result.stderr.truncated, true)
})

test('a run without any exit fact fails instead of inventing one', async () => {
  const fixture = makeFixture({ handle: () => fakeHandle({ outcome: { exitCode: null, signal: null } }) })
  await assert.rejects(() => port(fixture).execute(request()), /neither an exit code/u)
})

test('cancellation aborts the official spawn signal and settles aborted after joining', async () => {
  const controller = new AbortController()
  const fixture = makeFixture({ handle: spec => fakeHandle({ killOnAbort: true, signal: spec.signal }) })
  const pending = port(fixture).execute(request({ command: 'sleep 30', signal: controller.signal }))
  while (fixture.subprocess.spawns.length === 0) await new Promise(resolve => setImmediate(resolve))
  const spawnedSignal = fixture.subprocess.spawns[0]!.signal
  assert.ok(spawnedSignal !== undefined)
  controller.abort()
  assert.equal(spawnedSignal!.aborted, true)
  const outcome = await pending
  assert.equal(outcome.kind, 'settled')
  if (outcome.kind !== 'settled') throw new Error('expected the killed run to settle')
  assert.equal(outcome.result.aborted, true)
  assert.deepEqual(outcome.result.exit, { kind: 'signal', signal: 'SIGTERM' })
})


// ── Official bounded-tail sandbox diagnostic presentation ──────────────────

const REASON_UNKNOWN = 'stderr truncated; failure reason cannot be determined, command may have executed; do not retry automatically'

function settledShellResult(overrides: Partial<HostUserShellResult> = {}): HostUserShellResult {
  return {
    exit: { kind: 'exit', code: 1 },
    stdout: { text: '', truncated: false },
    stderr: { text: 'policy output tail', truncated: true },
    sandboxDenied: false,
    aborted: false,
    timedOut: false,
    ...overrides,
  }
}

test('a nonzero sandbox exit with truncated stderr is reason-unknown, not a definite denial', () => {
  for (const sandboxDenied of [false, true]) {
    const formatted = formatHostUserShellResult(settledShellResult({ sandboxDenied }), 'sandbox')
    assert.ok(formatted.includes(REASON_UNKNOWN))
    assert.match(formatted, /\[exit 1\]/u, 'the real exit fact is preserved')
    assert.ok(formatted.includes('policy output tail'), 'the retained stderr tail is still shown')
    assert.doesNotMatch(formatted, /sandbox denied/u, 'a definite denial is not claimed from a truncated tail')
    assert.doesNotMatch(formatted, /failed:/u, 'the reason-unknown card is not an ordinary failure card')
  }
})

test('complete diagnostics keep confirmed denial and ordinary-failure semantics', () => {
  const confirmed = formatHostUserShellResult(settledShellResult({
    sandboxDenied: true,
    stderr: { text: 'permission denied', truncated: false },
  }), 'sandbox')
  assert.match(confirmed, /sandbox denied/u)
  assert.doesNotMatch(confirmed, /failure reason cannot be determined/u)

  const ordinary = formatHostUserShellResult(settledShellResult({
    sandboxDenied: false,
    stderr: { text: 'boom', truncated: false },
  }), 'sandbox')
  assert.doesNotMatch(ordinary, /failure reason cannot be determined/u)
  assert.doesNotMatch(ordinary, /sandbox denied/u)

  const zero = formatHostUserShellResult(settledShellResult({ exit: { kind: 'exit', code: 0 } }), 'sandbox')
  assert.doesNotMatch(zero, /failure reason cannot be determined/u)
  assert.match(zero, /\[exit 0\]/u)

  const signal = formatHostUserShellResult(settledShellResult({ exit: { kind: 'signal', signal: 'SIGTERM' } }), 'sandbox')
  assert.match(signal, /\[signal SIGTERM\]/u)
  assert.doesNotMatch(signal, /failure reason cannot be determined/u)

  const bypass = formatHostUserShellResult(settledShellResult(), 'bypass')
  assert.doesNotMatch(bypass, /failure reason cannot be determined/u)
  assert.doesNotMatch(bypass, /sandbox denied/u)
})


// ── Direct adapter result path → the shared reason-unknown card ─────────────

test('the Direct sandbox adapter forwards a truncated nonzero denial diagnostic as reason-unknown', async () => {
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    sandbox: () => ({ confine: async () => fullConfined(['/runner', 'bash', '-c', 'make check'], {
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: fatal'], informationalLines: [] }],
    }) }),
    handle: () => fakeHandle({
      outcome: { exitCode: 1, signal: null },
      stderr: 'permission denied\n',
      stderrTruncated: true,
    }),
  })
  const outcome = await port(fixture).execute(request({ policy: 'sandbox', command: 'make check' }))
  assert.equal(outcome.kind, 'settled', 'the retained tail matches no runner-fatal rule, so the reason stays unknown')
  if (outcome.kind !== 'settled') throw new Error('expected a settled reason-unknown Direct result')
  assert.deepEqual(outcome.result.exit, { kind: 'exit', code: 1 })
  assert.equal(outcome.result.stderr.truncated, true)
  assert.equal(outcome.result.sandboxDenied, false, 'truncated diagnostics never serialize a definite denial')
  const card = formatHostUserShellResult(outcome.result, 'sandbox')
  assert.ok(card.includes('stderr truncated; failure reason cannot be determined, command may have executed; do not retry automatically'),
    'the Direct card renders the shared reason-unknown notice')
  assert.ok(card.includes('[exit 1]'), 'the real exit fact is shown')
  assert.ok(card.includes('stderr truncated'), 'truncation is stated')
  assert.doesNotMatch(card, /sandbox denied/u, 'no definite denial from a truncated tail')
  assert.doesNotMatch(card, /failed:/u, 'not an ordinary failure card')
})

test('the Direct sandbox adapter fails a truncated retained runner-fatal tail as sandbox-runner', async () => {
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    sandbox: () => ({ confine: async () => fullConfined(['/runner', 'bash', '-c', 'make check'], {
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: fatal'], informationalLines: [] }],
    }) }),
    handle: () => fakeHandle({
      outcome: { exitCode: 125, signal: null },
      stderr: 'runner: fatal\n',
      stderrTruncated: true,
    }),
  })
  await assert.rejects(
    () => port(fixture).execute(request({ policy: 'sandbox', command: 'make check' })),
    /sandbox runner failed before the user command executed \(runner: fatal\)/u,
  )
  assert.equal(fixture.subprocess.spawns.length, 1, 'the retained runner fatal is classified after the real spawn')
})

test('the Direct sandbox adapter still fails on positive non-truncated runner evidence', async () => {
  const fixture = makeFixture({
    shellPolicy: () => 'sandbox',
    sandbox: () => ({ confine: async argv => fullConfined(argv, {
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: fatal'], informationalLines: [] }],
    }) }),
    handle: () => fakeHandle({
      outcome: { exitCode: 125, signal: null },
      stderr: 'runner: fatal\n',
      stderrTruncated: false,
    }),
  })
  await assert.rejects(
    () => port(fixture).execute(request({ policy: 'sandbox', command: 'make check' })),
    /sandbox runner failed before the user command executed/u,
  )
})


test('the Direct adapter treats whole-stream signatures evicted into the truncated prefix as reason-unknown', async () => {
  // The whole stderr stream starts with a runner-fatal and a denial line, then
  // >64 KiB trailing data. The official collector's retained tail contains
  // neither; only the truncated-away prefix did.
  const prefix = 'runner: fatal to establish confinement\npermission denied\n'
  const trailing = 'x'.repeat(MAX_HOST_USER_SHELL_STREAM_BYTES + 4_096)
  const whole = `${prefix}${trailing}`
  const retainedTail = whole.slice(-MAX_HOST_USER_SHELL_STREAM_BYTES)
  assert.ok(whole.includes('runner: fatal') && whole.includes('permission denied'))
  assert.ok(!retainedTail.includes('runner: fatal') && !retainedTail.includes('permission denied'))

  for (const exitCode of [125, 1]) {
    const confined = fullConfined(['/runner', 'bash', '-c', 'make check'], {
      runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['runner: fatal'], informationalLines: [] }],
      denialSignatures: ['permission denied'],
    })
    const fixture = makeFixture({
      shellPolicy: () => 'sandbox',
      sandbox: () => ({ confine: async () => confined }),
      handle: () => fakeHandle({
        outcome: { exitCode, signal: null },
        stderr: retainedTail,
        stderrTruncated: true,
      }),
    })
    const outcome = await port(fixture).execute(request({ policy: 'sandbox', command: 'make check' }))
    assert.equal(outcome.kind, 'settled', `exit ${String(exitCode)}: the Direct adapter must not claim runner failure or denial`)
    if (outcome.kind !== 'settled') throw new Error('expected a settled reason-unknown Direct result')
    assert.deepEqual(outcome.result.exit, { kind: 'exit', code: exitCode })
    assert.equal(outcome.result.stderr.truncated, true)
    assert.equal(outcome.result.sandboxDenied, false, 'the evicted denial line is absent from the retained tail')
    const card = formatHostUserShellResult(outcome.result, 'sandbox')
    assert.ok(card.includes('stderr truncated; failure reason cannot be determined, command may have executed; do not retry automatically'))
    assert.ok(card.includes(`[exit ${String(exitCode)}]`))
    assert.ok(card.includes('stderr truncated'))
    assert.doesNotMatch(card, /sandbox denied/u)
    assert.doesNotMatch(card, /failed:/u)
  }
})


test('truncation markers stay short and terminal after the raw tails and long spill paths', () => {
  const longPath = `/host/${'p'.repeat(300)}`
  const result = settledShellResult({
    exit: { kind: 'exit', code: 1 },
    stdout: { text: 'RAW_STDOUT', truncated: true, spillPath: `${longPath}/out` },
    stderr: { text: 'RAW_STDERR', truncated: true, spillPath: `${longPath}/err` },
  })
  const lines = formatHostUserShellResult(result, 'bypass').split('\n')
  assert.ok(lines.includes('stdout truncated'), 'the exact short stdout marker is present')
  assert.ok(lines.includes('stderr truncated'), 'the exact short stderr marker is present')
  const stdoutSpill = lines.findIndex(line => line.startsWith('stdout spill (Host-local): '))
  const stderrSpill = lines.findIndex(line => line.startsWith('stderr spill (Host-local): '))
  const stdoutMarker = lines.indexOf('stdout truncated')
  const stderrMarker = lines.indexOf('stderr truncated')
  const exit = lines.indexOf('[exit 1]')
  assert.ok(stdoutSpill >= 0, 'the Host-local stdout spill fact is a separate line')
  assert.ok(stderrSpill >= 0, 'the Host-local stderr spill fact is a separate line')
  assert.ok(stdoutMarker > stdoutSpill, 'the short marker follows the long path, not the reverse')
  assert.ok(stderrMarker > stderrSpill, 'the short marker follows the long path, not the reverse')
  assert.ok(stdoutMarker < exit && stderrMarker < exit, 'the markers precede the real exit fact')
  assert.ok(stdoutMarker >= lines.length - 3 && stderrMarker >= lines.length - 3,
    'both markers sit in the terminal rows the card keeps after compaction')

  // The reason-unknown notice is also terminal, after the markers and before
  // the exit; markers remain visible even with the longer notice present.
  const unknownLines = formatHostUserShellResult({ ...result, sandboxDenied: false }, 'sandbox').split('\n')
  const unknownStdout = unknownLines.indexOf('stdout truncated')
  const unknownStderr = unknownLines.indexOf('stderr truncated')
  const notice = unknownLines.findIndex(line => line.startsWith('stderr truncated; failure reason cannot be determined'))
  const unknownExit = unknownLines.indexOf('[exit 1]')
  assert.ok(unknownStdout >= 0 && unknownStderr >= 0 && notice >= 0)
  assert.ok(unknownStdout < notice && unknownStderr < notice && notice < unknownExit)
  assert.ok(unknownStdout >= unknownLines.length - 4 && unknownStderr >= unknownLines.length - 4,
    'the short markers survive alongside the reason-unknown notice')
})
