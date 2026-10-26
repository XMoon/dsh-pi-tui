/** Sandbox-opt-in local-shell coverage: the DSH 0.1.7 rc.1
 * `shell.resolve → execute → result()` foreground contract behind the TUI's
 * `!` / `!!` cards, plus the unavailable-fallback and default-bypass split.
 *
 * The default local `!`/`!!` path stays the plain Node spawn (covered by
 * submit-hot-path / local-shell-card suites); these tests pin ONLY the
 * sandbox-opt-in seam through the real runner surface. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../../src/tui-app.ts'
import { SHELL_OUTPUT_CAP_LINES } from '../../src/client/shell/output-capture.ts'
import {
  disposeContext,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
} from '../support/runner-harness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { waitForFrame } from '../support/frame-wait.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** The minimal official CollectedOutput the runner consumes. */
function stream(text: string): { text: string; truncated: boolean } {
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
  stdout: { text: string; truncated: boolean }
  stderr: { text: string; truncated: boolean }
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

/**
 * A structural ShellExecutor fake over the rc.1 execute/result contract.
 * `resolve` records the request and returns an opaque spec; `execute`
 * returns one prepared execution whose `result()` settles with the
 * scripted outcome. Call recordings feed the contract assertions.
 */
function makeShellFake(options: {
  result: () => Promise<ReturnType<typeof runResult>>
  executeError?: () => Error
  resolveError?: Error
  /** Optional full execute() override (e.g. gated or abort-shaped rejections). */
  executeImpl?: (spec: unknown) => Promise<{ result(): Promise<ReturnType<typeof runResult>> }>
}) {
  const requests: unknown[] = []
  const specs: unknown[] = []
  let executeCount = 0
  return {
    requests,
    specs,
    executeCount: (): number => executeCount,
    resolve: (request: unknown): { readonly __spec: true; readonly request: unknown } => {
      if (options.resolveError !== undefined) throw options.resolveError
      requests.push(request)
      return { __spec: true as const, request }
    },
    async execute(spec: unknown): Promise<{ result(): Promise<ReturnType<typeof runResult>> }> {
      executeCount += 1
      specs.push(spec)
      if (options.executeImpl !== undefined) return options.executeImpl(spec)
      if (options.executeError !== undefined) throw options.executeError()
      return { result: options.result }
    },
  }
}

interface MountedSandbox {
  readonly view: () => string
  readonly notices: readonly string[]
  readonly submit: (draft: string) => void
  readonly settle: () => Promise<void>
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
  shell: unknown | undefined,
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
  if (shell !== undefined) harness.shell = shell
  const context = new Context()
  life.defer(() => disposeContext(context))
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
    settle: async () => {
      await settle()
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
    await mounted.settle()
    const view = mounted.view()
    if (view.includes(needle)) return view
  }
  throw new Error(`timed out waiting for ${label}:\n${mounted.view()}`)
}

test('sandbox `!` success resolves through execute/result with the command and exit 0', async (t) => {
  const shell = makeShellFake({
    result: async () => runResult({ exitCode: 0, stdout: 'sandbox ok', stderr: 'warn line' }),
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make check')
  const view = await waitForView(mounted, 'exit 0', 'the settled success card')
  assert.ok(view.includes('sandbox ok'), `stdout must reach the card:\n${view}`)
  assert.ok(view.includes('exit 0'), `the exit marker must settle the card:\n${view}`)
  // The rc.1 contract: resolve() is the request boundary, execute() takes
  // the resolved spec, and result() is the foreground projection.
  assert.equal(shell.executeCount(), 1, 'execute must run exactly once per `!` command')
  assert.ok((shell.requests[0] as { command?: string } | undefined)?.command === 'make check',
    `resolve must receive the command request:\n${JSON.stringify(shell.requests[0])}`)
  assert.ok((shell.specs[0] as { __spec?: boolean } | undefined)?.__spec === true,
    'execute must receive the spec object returned by resolve')
})

test('a truncated sandbox run settles with the production retention report (canonical byte units)', async (t) => {
  // More lines than the retained-tail cap: the settle must report the ACTUAL
  // retained values (the cap), the real received total, and byte totals
  // through the canonical `domain/media/format` formatter.
  const stdout = `${Array.from({ length: SHELL_OUTPUT_CAP_LINES + 1000 }, (_, index) => `line ${index}`).join('\n')}\n`
  const shell = makeShellFake({ result: async () => runResult({ exitCode: 0, stdout }) })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make loud')
  const view = await waitForView(mounted, 'output truncated: retained', 'the truncated settle')
  assert.match(
    view,
    new RegExp(`output truncated: retained \\d+\\.\\d (KiB|MiB) display / ${SHELL_OUTPUT_CAP_LINES} lines`),
    `the ACTUAL retained values in canonical display units:\n${view}`,
  )
  assert.ok(view.includes(`(${SHELL_OUTPUT_CAP_LINES + 1000} lines total)`), `the real received total:\n${view}`)
  assert.ok(view.includes('exit 0'), `the exit marker still settles the card:\n${view}`)
})

test('a nonzero sandbox exit resolves (never rejects) into an error card', async (t) => {
  const shell = makeShellFake({
    result: async () => runResult({ exitCode: 3, stdout: '', stderr: 'boom' }),
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make fail')
  const view = await waitForView(mounted, 'exit 3', 'the nonzero exit card')
  assert.ok(view.includes('boom'), `stderr must reach the card:\n${view}`)
})

test('a signal-terminated sandbox run reports the signal, not an exit code', async (t) => {
  const shell = makeShellFake({
    result: async () => runResult({ exitCode: null, signal: 'SIGKILL', stdout: '' }),
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make killed')
  await waitForView(mounted, 'signal SIGKILL', 'the signal card')
})

test('a timeout kill resolves as a descriptive result, not an infrastructure rejection', async (t) => {
  const shell = makeShellFake({
    result: async () => runResult({ exitCode: null, signal: 'SIGTERM', timedOut: true }),
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make slow')
  const view = await waitForView(mounted, 'signal SIGTERM', 'the timeout-kill card')
  assert.ok(!view.includes('failed:'), `a timeout kill must not render as a failure exception:\n${view}`)
})

test('a caller abort while the process runs resolves aborted and settles the card', async (t) => {
  let releaseAbort!: () => void
  const abortedResult = new Promise<ReturnType<typeof runResult>>(resolve => {
    releaseAbort = () => resolve(runResult({ exitCode: null, signal: 'SIGTERM', aborted: true }))
  })
  const shell = makeShellFake({ result: () => abortedResult })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make long')
  await mounted.settle()
  // A second `!` command aborts the first run's controller FIRST; the
  // first execution's result() then RESOLVES with aborted: true (rc.1:
  // abort kills resolve, they do not reject).
  mounted.submit('!echo next')
  releaseAbort()
  await waitForView(mounted, 'aborted', 'the aborted card')
})

test('a caller abort while execute itself is pending routes the cancellation rejection to the aborted card', async (t) => {
  // §5.6 special-attention path: the caller aborts BEFORE execute settles.
  // rc.1 execute() throws on caller cancellation before process publication;
  // runOwned's task-local classifier must route that rejection to onCancel
  // (settle 'aborted'), never to a false ERROR card.
  let releaseExecute!: () => void
  const executeGate = new Promise<void>(resolve => { releaseExecute = resolve })
  let gated = true
  const shell = makeShellFake({
    result: async () => runResult({ stdout: 'next ok', exitCode: 0 }),
    executeImpl: async () => {
      // Only the FIRST execution takes the gated cancellation path; the
      // aborting second `!` command must run its own execution normally.
      if (!gated) return { result: async () => runResult({ stdout: 'next ok', exitCode: 0 }) }
      gated = false
      await executeGate
      throw new Error('execution cancelled before publication')
    },
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make gated')
  await mounted.settle()
  // The second `!` aborts the first controller while its execute() is still
  // pending; only then does execute reject with the cancellation.
  mounted.submit('!echo next')
  releaseExecute()
  const view = await waitForView(mounted, 'aborted', 'the aborted card')
  assert.ok(!view.includes('failed:'), `an execute-time cancellation must not render as an infrastructure failure:\n${view}`)
})

test('an execute() preparation failure rejects into the failed card (infrastructure)', async (t) => {
  const shell = makeShellFake({
    result: async () => runResult({}),
    executeError: () => new Error('spawn preparation refused'),
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make refused')
  const view = await waitForView(mounted, 'failed:', 'the failed card')
  assert.ok(view.includes('spawn preparation refused'), `the infrastructure reason must surface:\n${view}`)
})

test('a result() infrastructure rejection renders failed and never becomes an exception card', async (t) => {
  const shell = makeShellFake({
    result: async () => {
      throw new Error('sandbox stream broke')
    },
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make broken')
  const view = await waitForView(mounted, 'failed:', 'the rejected-result card')
  assert.ok(view.includes('sandbox stream broke'), `the rejection reason must surface:\n${view}`)
})

test('a synchronous resolve() throw settles the card like a failed run', async (t) => {
  const shell = makeShellFake({
    result: async () => runResult({}),
    resolveError: new Error('request refused by policy'),
  })
  const mounted = await mountSandboxRunner(t, shell)
  mounted.submit('!make refused-resolve')
  const view = await waitForView(mounted, 'failed:', 'the resolve-failure card')
  assert.ok(view.includes('request refused by policy'), `the resolve reason must surface:\n${view}`)
  assert.equal(shell.executeCount(), 0, 'a refused resolve must never reach execute')
})

test('the sandbox preference without a composition shell capability fails closed and executes nothing (shell amendment)', async (t) => {
  const mounted = await mountSandboxRunner(t, undefined)
  mounted.submit('!echo fallback-ok')
  const view = await waitForView(mounted, 'sandbox policy is unavailable', 'the fail-closed card')
  // CARRIER/POLICY fail-closed (M3-4 PR3): the run must NOT degrade to the
  // bypass spawn — the card carries the unavailable message and NEVER the
  // command's own output or an exit marker. (The command name itself appears
  // in the echoed `$ command` header; that is the card's args, not output.)
  assert.ok(!view.includes('exit 0'), `an unavailable sandbox policy must not execute the command:\n${view}`)
  assert.ok(!view.includes('exit 1'), `an unavailable sandbox policy must not execute the command:\n${view}`)
})

test('the default bypass preference never touches the composition shell capability', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-shell-bypass-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const apps: TuiApp[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function () {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })

  const parent: FakeSession = fakeSession({
    id: 'shell-bypass-parent',
    header: { id: 'shell-bypass-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  const shell = makeShellFake({ result: async () => runResult({ stdout: 'must-not-appear' }) })
  harness.shell = shell

  const context = new Context()
  life.defer(() => disposeContext(context))
  const fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: parent.id },
    { localShellSandbox: 'bypass' },
  )
  life.defer(() => fiber.dispose())
  assert.ok(apps.at(-1), 'the production runner must create a TuiApp')

  const target = apps.at(-1) as unknown as { setDraft(text: string): void; submitDraft(): void }
  target.setDraft('!echo bypass-local')
  target.submitDraft()
  let view = ''
  for (let round = 0; round < 50; round += 1) {
    await settle()
    await vt.waitForRender()
    view = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
    if (view.includes('bypass-local')) break
  }
  assert.ok(view.includes('bypass-local'), `the default path must run the plain local spawn:\n${view}`)
  assert.ok(!view.includes('must-not-appear'), `the sandbox executor must stay untouched:\n${view}`)
  assert.equal(shell.executeCount(), 0, 'the default bypass must never call the dsh shell capability')
})

// ── C2-R3: the persisted policy really selects the NEXT `!` execution path ──

test('a REAL Settings Confirm of the shell policy is what the next `!` executes under', async (t) => {
  const shell = makeShellFake({ result: async () => runResult({ exitCode: 0, stdout: 'sandboxed-by-settings' }) })
  const mounted = await mountSandboxRunner(t, shell, 'bypass')
  assert.equal(mounted.policy(), 'bypass', 'the document starts at bypass')

  // CONTROL: the plain local spawn runs, the Host shell capability is untouched.
  mounted.submit('!echo local-control')
  const control = await waitForView(mounted, 'local-control', 'the local control card')
  assert.equal(shell.executeCount(), 0, 'bypass never calls the dsh shell capability')
  assert.ok(control.includes('local-control'))

  // THE REAL UI PATH: open /settings → Agent → the shell policy row and Confirm
  // `sandbox` through the workspace's own keys and writer.
  await mounted.runSettings()
  const open = mounted.view()
  assert.match(open, /Settings · Categories/u, `the /settings workspace really opened:\n${open}`)
  // Every step waits for the AUTHORITATIVE frame it produces (the painted
  // breadcrumb / choice / status), never for a wall-clock window.
  const pressUntil = async (key: string, settled: () => boolean, label: string, limit: number): Promise<void> => {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      if (settled()) return
      mounted.vt().sendInput(key)
      // The key's owned task drains through microtasks and the workspace
      // repaints; bounded settle, no timer window.
      await mounted.settle()
    }
    assert.ok(settled(), label)
  }
  // Rail: About → Models → Account → Agent. The SELECTED rail row is the one
  // whose cursor sits in the categories column.
  const railSelects = (label: string): boolean => mounted.view().split('\n')
    .some(line => line.trimStart().startsWith(`> ${label}`))
  await pressUntil('\x1b[B', () => railSelects('Agent'), 'the rail selects Agent', 6)
  await pressUntil('\r', () => /Settings · Agent · Rows/u.test(mounted.view()), 'Enter enters the Agent rows', 1)
  // The Rows pane's cursor is the ONLY `> ` in that column; the Details column
  // starts after it, so the check reads the same cells the user does.
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
    // Bounded settle: the owned settings write settles, then the frame repaints.
    () => mounted.settle(),
    'the real Settings Confirm must settle as Verified',
  )

  // The write really went through the Host settings surface, and the document
  // the consumer reads now carries the new policy.
  const writes = mounted.settingsWrites().filter(write => write.ns === 'tui-app')
  assert.ok(writes.some(write => write.ops.some(op => op.path[0] === 'localShellSandbox' && op.value === 'sandbox')),
    `the confirm really mutated localShellSandbox:\n${JSON.stringify(writes)}`)
  assert.equal(mounted.policy(), 'sandbox', 'the persisted document really changed')
  // Leave the workspace by walking the real Esc gradient until its chrome is
  // gone (the frame itself is the settlement signal).
  for (let step = 0; step < 6 && /Settings · /u.test(mounted.view()); step += 1) {
    mounted.vt().sendInput('\x1b')
    // Bounded settle: the Esc gradient repaints before the next predicate read.
    await mounted.settle()
  }
  assert.doesNotMatch(mounted.view(), /Settings · /u, `the workspace closed:\n${mounted.view()}`)

  // SOURCE -> SINK: the NEXT `!` takes the sandbox executor.
  mounted.submit('!make check')
  const sandboxed = await waitForView(mounted, 'sandboxed-by-settings', 'the sandboxed card')
  assert.equal(shell.executeCount(), 1, 'the next `!` really entered the dsh shell capability')
  assert.ok(sandboxed.includes('sandboxed-by-settings'))

  // THE REVERSE TRIP, also through the real UI: reopen /settings, Confirm
  // `bypass` again, and the FOLLOWING `!` must return to the plain local spawn.
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
    // Bounded settle: the owned settings write drains, then the frame repaints.
    () => mounted.settle(),
    'the reverse Confirm must settle as Verified with the bypass effect',
  )
  assert.equal(mounted.policy(), 'bypass', 'the persisted document really flipped back')
  for (let step = 0; step < 6 && /Settings · /u.test(mounted.view()); step += 1) {
    mounted.vt().sendInput('\x1b')
    // Bounded settle: each Esc step repaints before the next predicate read.
    await mounted.settle()
  }
  assert.doesNotMatch(mounted.view(), /Settings · /u, `the workspace closed again:\n${mounted.view()}`)

  // SOURCE -> SINK, reversed: the plain local spawn runs again and the Host shell
  // capability stays at ONE execution.
  mounted.submit('!echo back-to-local')
  const backToLocal = await waitForView(mounted, 'back-to-local', 'the restored local card')
  assert.equal(shell.executeCount(), 1, 'the bypass run after the UI reverse never re-entered the sandbox')
  assert.ok(backToLocal.includes('back-to-local'))
})

test('a policy change on the live settings document routes the NEXT `!` through the other executor', async (t) => {
  const shell = makeShellFake({ result: async () => runResult({ exitCode: 0, stdout: 'sandboxed' }) })
  // The document starts at the DEFAULT bypass, exactly like a fresh profile.
  const mounted = await mountSandboxRunner(t, shell, 'bypass')
  assert.equal(mounted.policy(), 'bypass', 'the harness serves the real persisted value')

  // 1) bypass: the plain local spawn runs, the dsh shell capability is untouched.
  mounted.submit('!echo bypass-run')
  const bypassView = await waitForView(mounted, 'bypass-run', 'the bypass card')
  assert.equal(shell.executeCount(), 0, 'bypass never calls the dsh shell capability')
  assert.ok(bypassView.includes('bypass-run'))

  // 2) the Settings writer stores `sandbox` on the SAME document the consumer reads.
  mounted.setPolicy('sandbox')
  assert.equal(mounted.policy(), 'sandbox', 'the persisted policy really changed')

  // 3) the NEXT `!` takes the sandbox executor — the real Host policy path.
  mounted.submit('!make check')
  const sandboxView = await waitForView(mounted, 'sandboxed', 'the sandboxed card')
  assert.equal(shell.executeCount(), 1, 'the sandboxed `!` really entered the dsh shell capability')
  assert.ok(sandboxView.includes('sandboxed'), `the sandbox executor produced the card:\n${sandboxView}`)

  // 4) switching back routes the following `!` to bypass again.
  mounted.setPolicy('bypass')
  mounted.submit('!echo back-to-bypass')
  const backView = await waitForView(mounted, 'back-to-bypass', 'the restored bypass card')
  assert.equal(shell.executeCount(), 1, 'the bypass run after the switch never re-entered the sandbox')
  assert.ok(backView.includes('back-to-bypass'))
})
