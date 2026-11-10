/** Direct local-shell coverage: both policies run the raw
 * `['bash', '-c', command]` argv through the official `ctx.subprocess`
 * provider behind the TUI's `!` / `!!` cards. `sandbox` additionally resolves
 * the exact Session policy and confines the raw argv exactly once with the
 * official `ctx.sandbox` provider; a composition without those capabilities
 * fails closed. These tests pin the runner surface and the user-visible card
 * semantics (bounded output, truncation, exit/signal facts, cancellation). */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxPolicyServiceLike, SandboxServiceLike } from '../../src/runtime/host-user-shell-execution.ts'
import { TuiApp } from '../../src/tui-app.ts'
import {
  disposeContext,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  // The harness's settle drains microtasks and waits for the painted frame; it
  // is imported under a name that cannot collide with the fixed-wait helper
  // `settle(ms)` in tsp-runner-harness, which the policy scan classifies by
  // name alone.
  settle as drainMicrotasks,
  type FakeSession,
} from '../support/runner-harness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { waitForFrame } from '../support/frame-wait.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** The minimal official CollectedOutput the runner consumes. */
function stream(text: string): { text: string; truncated: boolean; spillPath?: string } {
  return { text, truncated: false }
}

/** One resolved ShellRunResult fixture. */
function runResult(overrides: Partial<{
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
}>): {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
} {
  return {
    exitCode: overrides.exitCode !== undefined ? overrides.exitCode : 0,
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    aborted: overrides.aborted ?? false,
    timeoutMs: 30_000,
    stdout: stream(overrides.stdout ?? ''),
    stderr: stream(overrides.stderr ?? ''),
  }
}

/** The official Host capabilities the Direct adapter executes through. */
interface HostFake {
  readonly subprocess?: {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle
    readonly spawns: SubprocessSpawnSpec[]
  }
  readonly sandbox: SandboxServiceLike
  readonly sandboxPolicy: SandboxPolicyServiceLike
  readonly confineCalls: { readonly argv: readonly string[]; readonly policy: unknown }[]
  readonly policyResolves: { readonly session: { readonly id: string } }[]
  spawnCount(): number
}

/** One official Subprocess/Sandbox stand-in for the Direct adapter. By default
 *  the composition uses the REAL local subprocess provider (so bypass commands
 *  genuinely execute); `fakeSubprocess` records the exact spawn spec and
 *  settles with the scripted result instead. */
function makeHostFake(options: {
  readonly fakeSubprocess?: boolean
  readonly result?: () => Promise<ReturnType<typeof runResult>>
  readonly confineArgv?: readonly string[]
  readonly resolveError?: Error
  readonly confineError?: Error
  readonly prepareGate?: () => Promise<void>
} = {}): HostFake {
  const confineCalls: { readonly argv: readonly string[]; readonly policy: unknown }[] = []
  const policyResolves: { readonly session: { readonly id: string } }[] = []
  const spawns: SubprocessSpawnSpec[] = []
  let spawnCount = 0
  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    spawnCount += 1
    spawns.push(spec)
    const resultPromise = (options.result ?? (async () => runResult({})))()
    let settled: ReturnType<typeof runResult> | undefined
    const read = (which: 'stdout' | 'stderr') => {
      const output = settled?.[which] ?? stream('')
      return {
        text: output.text,
        nextOffset: Buffer.byteLength(output.text, 'utf8'),
        lossy: output.truncated,
        ...(output.spillPath === undefined ? {} : { spillPath: output.spillPath }),
      }
    }
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: { readFrom: () => read('stdout') },
        stderr: { readFrom: () => read('stderr') },
      },
      done: resultPromise.then(outcome => {
        settled = outcome
        return { exitCode: outcome.exitCode, signal: outcome.signal as NodeJS.Signals | null } satisfies SubprocessOutcome
      }),
      terminate: () => {},
      waitForExit: async () => true,
    }
  }
  return {
    ...(options.fakeSubprocess === true ? { subprocess: { spawn, spawns } } : {}),
    sandbox: {
      async confine(argv, policy) {
        if (options.confineError !== undefined) throw options.confineError
        confineCalls.push({ argv, policy })
        return {
          argv: [...(options.confineArgv ?? argv)],
          enforcement: 'full',
          denialSignatures: [],
          runnerFailureRules: [],
        }
      },
    },
    sandboxPolicy: {
      async resolve(input) {
        policyResolves.push({ session: input.session })
        if (options.prepareGate !== undefined) await options.prepareGate()
        if (options.resolveError !== undefined) throw options.resolveError
        return { mode: 'workspace-write', workspaceRoot: process.cwd() }
      },
    },
    confineCalls,
    policyResolves,
    spawnCount: () => spawnCount,
  }
}

interface MountedSandbox {
  readonly view: () => string
  readonly notices: readonly string[]
  readonly submit: (draft: string) => void
  readonly settleSurface: () => Promise<void>
  /** The live surface the runner created. */
  readonly app: () => TuiApp
  /** Write the persisted policy through the SAME volatile reference the
   *  `user-shell` consumer reads on its next `!`/`!!`. */
  readonly setPolicy: (value: 'bypass' | 'sandbox') => void
  /** Every real Host settings mutation this composition dispatched. */
  readonly settingsWrites: () => readonly { readonly ns: string; readonly ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }[]
  /** Open the REAL `/settings` workspace through the registered command. */
  readonly runSettings: () => Promise<void>
  /** The physical terminal the runner paints into. */
  readonly vt: () => VirtualTerminal
  /** The live persisted document value (the consumer's own source). */
  readonly policy: () => string | undefined
}

/** Mount the real runner with the given localShellSandbox document value. */
async function mountSandboxRunner(
  t: test.TestContext,
  host: HostFake | undefined,
  sandbox: 'sandbox' | 'bypass' = 'sandbox',
): Promise<MountedSandbox> {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-shell-sandbox-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  life.defer(installVirtualProcessTerminal(vt))
  /** The RESOLVED volatile refs: the SAME document `user-shell.ts` reads. */
  let resolved: Record<string, unknown> | undefined
  // The probe patches must be installed BEFORE mounting: the runner creates
  // its TuiApp during mountRunner.
  const notices: string[] = []
  const apps: TuiApp[] = []
  const originalNotify = TuiApp.prototype.notify
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.notify = function (message: string) {
    notices.push(message)
    return originalNotify.call(this, message)
  }
  TuiApp.prototype.start = function () {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => {
    TuiApp.prototype.notify = originalNotify
    TuiApp.prototype.start = originalStart
  })

  const parent: FakeSession = fakeSession({
    id: 'shell-sandbox-parent',
    header: { id: 'shell-sandbox-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  const context = new Context()
  life.defer(() => disposeContext(context))
  if (host !== undefined) {
    context.provide('sandbox', host.sandbox as never)
    context.provide('sandboxPolicy', host.sandboxPolicy as never)
    if (host.subprocess !== undefined) harness.subprocess = host.subprocess
  }
  // The ONE controlled stand-in of this composition: the Host `SettingsForms`
  // surface. Its `mutate` commits the requested ops into the SAME volatile
  // references the Loader/presentation plane hands the runner — so the Settings
  // writer, the authoritative read-back AND the `user-shell` consumer all read
  // one object. Every mutation is recorded.
  const settingsWrites: { readonly ns: string; readonly ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }[] = []
  let settingsRevision = 1
  const settingsValues = (): Record<string, unknown> => {
    const refs = resolved ?? {}
    const read = (field: string): unknown => (refs[field] as { get(): unknown } | undefined)?.get()
    return {
      theme: read('theme'),
      iconStyle: read('iconStyle'),
      footer: read('footer'),
      fullscreen: read('fullscreen'),
      busyEnter: read('busyEnter'),
      localShellSandbox: read('localShellSandbox'),
      homeEndKeys: read('homeEndKeys'),
      displayPreset: read('displayPreset'),
      progressUpdates: read('progressUpdates'),
      responseStyle: read('responseStyle'),
      gitAttribution: read('gitAttribution'),
      notificationMode: read('notificationMode'),
      notificationMethod: read('notificationMethod'),
      terminalProgress: read('terminalProgress'),
      wheelScrollLines: read('wheelScrollLines'),
    }
  }
  context.provide('settings', {
    describe: () => [{ ns: 'tui-app', value: settingsValues(), user: {}, revision: settingsRevision }],
    mutate: async (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      settingsWrites.push({ ns, ops })
      for (const op of ops) {
        const field = op.path[0]
        assert.ok(field !== undefined, 'a settings op must name a field')
        const ref = (resolved ?? {})[field] as { get(): unknown } & Record<symbol, (value: unknown) => void> | undefined
        if (op.op !== 'set' || ref === undefined) continue
        const write = ref[Object.getOwnPropertySymbols(ref)[0]!]
        write(op.value)
      }
      settingsRevision += 1
      return undefined
    },
  })

  const fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: parent.id },
    { localShellSandbox: sandbox },
    undefined,
    undefined,
    (config) => { resolved = config as Record<string, unknown> },
  )
  life.defer(() => fiber.dispose())
  assert.ok(apps.at(-1), 'the production runner must create a TuiApp')

  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const submit = (draft: string): void => {
    const target = apps.at(-1) as unknown as { setDraft(text: string): void; submitDraft(): void }
    target.setDraft(draft)
    target.submitDraft()
  }
  return {
    view,
    vt: () => vt,
    notices,
    submit,
    settleSurface: async () => {
      await drainMicrotasks()
      await vt.waitForRender()
    },
    app: () => apps.at(-1)!,
    settingsWrites: () => settingsWrites,
    runSettings: async (): Promise<void> => {
      const handler = (harness.commands as { handler(name: string): ((inv: unknown) => unknown) | undefined }).handler('settings')
      assert.ok(handler !== undefined, 'the production /settings command must be registered')
      await Promise.resolve(handler({ commandId: 'cmd-shell-policy', agent: undefined, rawInput: '', signal: new AbortController().signal }))
      await vt.waitForRender()
    },
    setPolicy: (value: 'bypass' | 'sandbox') => {
      assert.ok(resolved !== undefined, 'the resolved config refs must be reachable')
      // Write the SAME reference the consumer reads on its next `!` — this is
      // the document authority, not a UI copy.
      const ref = resolved.localShellSandbox as { get(): string } & Record<symbol, (value: string) => void>
      const write = ref[Object.getOwnPropertySymbols(ref)[0]!]
      write(value)
    },
    policy: () => {
      const ref = resolved?.localShellSandbox as { get(): string } | undefined
      return ref?.get()
    },
  }
}

/** Poll a view predicate with bounded settle rounds (the shell task is an
 * owned async workflow; settlement lands after microtask drains). */
async function waitForView(mounted: MountedSandbox, needle: string, label: string): Promise<string> {
  for (let round = 0; round < 50; round += 1) {
    await mounted.settleSurface()
    const view = mounted.view()
    if (view.includes(needle)) return view
  }
  throw new Error(`timed out waiting for ${label}:\n${mounted.view()}`)
}

test('sandbox `!` spawns the raw argv once and settles the official result', async (t) => {
  const host = makeHostFake({
    fakeSubprocess: true,
    result: async () => runResult({ exitCode: 0, stdout: 'sandbox ok\n', stderr: 'warn line\n' }),
  })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make check')
  const view = await waitForView(mounted, 'exit 0', 'the settled success card')
  assert.ok(view.includes('sandbox ok'), `stdout must reach the card:\n${view}`)
  assert.ok(view.includes('warn line'), `stderr must reach the card:\n${view}`)
  assert.ok(view.includes('[exit 0]'), `the exit marker must settle the card:\n${view}`)
  assert.equal(host.spawnCount(), 1, 'the official Subprocess spawned exactly once')
  assert.deepEqual(host.subprocess!.spawns[0]!.argv, ['bash', '-c', 'make check'])
  assert.ok(host.policyResolves.length >= 1, 'the exact Session policy was resolved')
  assert.ok(host.policyResolves.every(entry => entry.session.id === 'shell-sandbox-parent'),
    'every policy resolution named the exact live Session')
})

test('a truncated sandbox run paints the bounded tail and an explicit truncation line', async (t) => {
  const stdout = `${Array.from({ length: 900 }, (_, index) => `line ${index} ${'x'.repeat(120)}`).join('\n')}\nTAIL_20261110\n`
  const host = makeHostFake({
    fakeSubprocess: true,
    result: async () => runResult({ exitCode: 0, stdout }),
  })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make loud')
  const view = await waitForView(mounted, 'stdout truncated', 'the truncated settle')
  assert.ok(view.includes('TAIL_20261110'), `the retained tail must be painted:\n${view}`)
  assert.ok(view.includes('[exit 0]'), `the exit marker still settles the card:\n${view}`)
  assert.ok(!view.includes('output truncated: retained'), 'the retired streaming retention report is gone')
})

test('a nonzero sandbox exit resolves (never rejects) into an error card', async (t) => {
  const host = makeHostFake({ fakeSubprocess: true, result: async () => runResult({ exitCode: 3, stderr: 'boom\n' }) })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make fail')
  const view = await waitForView(mounted, 'exit 3', 'the nonzero exit card')
  assert.ok(view.includes('boom'), `stderr must reach the card:\n${view}`)
})

test('a signal-terminated sandbox run reports the signal, not an exit code', async (t) => {
  const host = makeHostFake({ fakeSubprocess: true, result: async () => runResult({ exitCode: null, signal: 'SIGKILL' }) })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make killed')
  await waitForView(mounted, 'signal SIGKILL', 'the signal card')
})

test('a caller abort while the command runs settles aborted and terminates the range', async (t) => {
  const host = makeHostFake()
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!sleep 30')
  await mounted.settleSurface()
  // A second `!` aborts the first run's controller; the official provider
  // terminates the managed range and the killed run settles aborted.
  mounted.submit('!printf next')
  const view = await waitForView(mounted, 'aborted', 'the aborted card')
  assert.ok(!view.includes('failed:'), `a caller abort must not render as an infrastructure failure:\n${view}`)
  assert.ok(host.confineCalls.some(call => call.argv.some(argument => argument.includes('sleep 30'))),
    'the aborted run prepared its own sandbox confinement')
})

test('a caller abort during sandbox preparation routes the cancellation to the aborted card', async (t) => {
  let releasePreparation!: () => void
  const gate = new Promise<void>(resolve => { releasePreparation = resolve })
  let gated = true
  const host = makeHostFake({
    prepareGate: async () => {
      if (!gated) return
      gated = false
      await gate
    },
  })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make gated')
  for (let round = 0; round < 200 && host.policyResolves.length === 0; round += 1) await mounted.settleSurface()
  assert.equal(host.policyResolves.length, 1, 'the first run reached policy preparation')
  // The second `!` aborts the first controller while its preparation is still
  // pending; the released preparation then observes the abort and settles
  // through runOwned's cancellation path.
  mounted.submit('!printf next')
  releasePreparation()
  const view = await waitForView(mounted, 'aborted', 'the aborted preparation card')
  assert.ok(!view.includes('failed:'), `a preparation cancellation must not render as a failure:\n${view}`)
})

test('a sandbox preparation failure settles the truthful unavailable card and never spawns', async (t) => {
  const host = makeHostFake({ confineError: new Error('request refused by policy') })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make refused-resolve')
  const view = await waitForView(mounted, 'request refused by policy', 'the preparation-failure card')
  assert.equal(host.spawnCount(), 0, 'a refused confinement preparation must never spawn')
})

test('a post-start provider failure renders failed and never becomes an exception card', async (t) => {
  const host = makeHostFake({
    fakeSubprocess: true,
    result: async () => { throw new Error('provider vanished') },
  })
  const mounted = await mountSandboxRunner(t, host)
  mounted.submit('!make broken')
  const view = await waitForView(mounted, 'failed:', 'the failed card')
  assert.ok(view.includes('provider vanished'), `the failure reason must surface:\n${view}`)
})

test('the sandbox preference without a composition sandbox capability fails closed and executes nothing', async (t) => {
  const mounted = await mountSandboxRunner(t, undefined)
  mounted.submit('!echo fallback-ok')
  const view = await waitForView(mounted, 'sandbox policy is unavailable', 'the fail-closed card')
  assert.ok(!view.includes('[exit 0]'), `an unavailable sandbox policy must not execute the command:\n${view}`)
})

test('the default bypass preference runs raw Bash through Subprocess and never confines', async (t) => {
  const host = makeHostFake()
  const mounted = await mountSandboxRunner(t, host, 'bypass')
  mounted.submit("!printf 'bypass-local\\n'")
  const view = await waitForView(mounted, 'bypass-local', 'the bypass card')
  assert.ok(view.includes('bypass-local'), `the default path must run the raw Bash command:\n${view}`)
  assert.equal(host.confineCalls.length, 0, 'bypass must never confine')
})

test('a REAL Settings Confirm of the shell policy is what the next `!` executes under', async (t) => {
  const host = makeHostFake({ confineArgv: ['bash', '-c', "printf 'sandboxed-by-settings\\n'"] })
  const mounted = await mountSandboxRunner(t, host, 'bypass')
  assert.equal(mounted.policy(), 'bypass', 'the document starts at bypass')

  // CONTROL: the raw Bash bypass runs; no sandbox preparation happens.
  mounted.submit("!printf 'local-control\\n'")
  const control = await waitForView(mounted, 'local-control', 'the local control card')
  assert.equal(host.confineCalls.length, 0, 'bypass never confines')
  assert.ok(control.includes('local-control'))

  // THE REAL UI PATH: open /settings → Agent → the shell policy row and Confirm
  // `sandbox` through the workspace's own keys and writer.
  await mounted.runSettings()
  const open = mounted.view()
  assert.match(open, /Settings · Categories/u, `the /settings workspace really opened:\n${open}`)
  const pressUntil = async (key: string, settled: () => boolean, label: string, limit: number): Promise<void> => {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      if (settled()) return
      mounted.vt().sendInput(key)
      await mounted.settleSurface()
    }
    assert.ok(settled(), label)
  }
  const railSelects = (label: string): boolean => mounted.view().split('\n')
    .some(line => line.trimStart().startsWith(`> ${label}`))
  await pressUntil('\x1b[B', () => railSelects('Agent'), 'the rail selects Agent', 6)
  await pressUntil('\r', () => /Settings · Agent · Rows/u.test(mounted.view()), 'Enter enters the Agent rows', 1)
  const selectedRow = (): string => {
    for (const line of mounted.view().split('\n')) {
      const marker = line.indexOf('> ')
      if (marker < 0) continue
      const after = line.slice(marker + 2)
      if (/^(?:Approval policy|Default permission|Subagent|User shell)/u.test(after)) return after
    }
    return ''
  }
  await pressUntil('\x1b[B', () => selectedRow().includes('User shell sandbox policy'),
    'the shell policy row is selected', 8)
  await pressUntil('\r', () => /Choose value/u.test(mounted.view()), 'the inline choice is open', 1)
  await pressUntil('\x1b[B', () => />\s*sandbox(?:\s|$)/mu.test(mounted.view()), 'sandbox becomes the chosen candidate', 2)
  mounted.vt().sendInput('\r') // explicit Confirm
  await waitForFrame(
    () => mounted.view(),
    frame => /Status\s+Verified/u.test(frame),
    () => mounted.settleSurface(),
    'the real Settings Confirm must settle as Verified',
  )
  const writes = mounted.settingsWrites().filter(write => write.ns === 'tui-app')
  assert.ok(writes.some(write => write.ops.some(op => op.path[0] === 'localShellSandbox' && op.value === 'sandbox')),
    `the confirm really mutated localShellSandbox:\n${JSON.stringify(writes)}`)
  assert.equal(mounted.policy(), 'sandbox', 'the persisted document really changed')
  for (let step = 0; step < 6 && /Settings · /u.test(mounted.view()); step += 1) {
    mounted.vt().sendInput('\x1b')
    await mounted.settleSurface()
  }
  assert.doesNotMatch(mounted.view(), /Settings · /u, `the workspace closed:\n${mounted.view()}`)

  // SOURCE -> SINK: the NEXT `!` takes the sandbox confinement.
  mounted.submit('!make check')
  const sandboxed = await waitForView(mounted, 'sandboxed-by-settings', 'the sandboxed card')
  assert.equal(host.confineCalls.length, 1, 'the next `!` really entered the sandbox path')
  assert.ok(sandboxed.includes('sandboxed-by-settings'))

  // THE REVERSE TRIP, also through the real UI.
  await mounted.runSettings()
  await pressUntil('\x1b[B', () => railSelects('Agent'), 'the rail selects Agent again', 6)
  await pressUntil('\r', () => /Settings · Agent · Rows/u.test(mounted.view()), 'Enter enters the Agent rows', 1)
  await pressUntil('\x1b[B', () => selectedRow().includes('User shell sandbox policy'),
    'the shell policy row is selected again', 8)
  await pressUntil('\r', () => /Choose value/u.test(mounted.view()), 'the inline choice is open again', 1)
  await pressUntil('\x1b[A', () => />\s*bypass(?:\s|$)/mu.test(mounted.view()), 'bypass becomes the chosen candidate', 2)
  mounted.vt().sendInput('\r') // explicit Confirm
  await waitForFrame(
    () => mounted.view(),
    frame => /Status\s+Verified/u.test(frame) && /Next ! \/ !! uses bypass/u.test(frame),
    () => mounted.settleSurface(),
    'the reverse Confirm must settle as Verified with the bypass effect',
  )
  assert.equal(mounted.policy(), 'bypass', 'the persisted document really flipped back')
  for (let step = 0; step < 6 && /Settings · /u.test(mounted.view()); step += 1) {
    mounted.vt().sendInput('\x1b')
    await mounted.settleSurface()
  }
  assert.doesNotMatch(mounted.view(), /Settings · /u, `the workspace closed again:\n${mounted.view()}`)

  mounted.submit("!printf 'back-to-local\\n'")
  const backToLocal = await waitForView(mounted, 'back-to-local', 'the restored bypass card')
  assert.equal(host.confineCalls.length, 1, 'the bypass run after the UI reverse never re-entered the sandbox')
  assert.ok(backToLocal.includes('back-to-local'))
})

test('a policy change on the live settings document routes the NEXT `!` through the other path', async (t) => {
  const host = makeHostFake({ confineArgv: ['bash', '-c', "printf 'sandboxed\\n'"] })
  const mounted = await mountSandboxRunner(t, host, 'bypass')
  assert.equal(mounted.policy(), 'bypass', 'the harness serves the real persisted value')

  mounted.submit("!printf 'bypass-run\\n'")
  const bypassView = await waitForView(mounted, 'bypass-run', 'the bypass card')
  assert.equal(host.confineCalls.length, 0, 'bypass never confines')
  assert.ok(bypassView.includes('bypass-run'))

  mounted.setPolicy('sandbox')
  assert.equal(mounted.policy(), 'sandbox', 'the persisted policy really changed')
  mounted.submit('!make check')
  const sandboxView = await waitForView(mounted, 'sandboxed', 'the sandboxed card')
  assert.equal(host.confineCalls.length, 1, 'the sandboxed `!` really entered the sandbox path')
  assert.ok(sandboxView.includes('sandboxed'))

  mounted.setPolicy('bypass')
  mounted.submit("!printf 'back-to-bypass\\n'")
  const backView = await waitForView(mounted, 'back-to-bypass', 'the restored bypass card')
  assert.equal(host.confineCalls.length, 1, 'the bypass run after the switch never re-entered the sandbox')
  assert.ok(backView.includes('back-to-bypass'))
})
