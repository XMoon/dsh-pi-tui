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
import { TuiApp } from '../src/tui-app.ts'
import {
  disposeContext,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
} from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
}

/** Mount the real runner with `localShellSandbox: 'sandbox'` and a shell fake. */
async function mountSandboxRunner(
  t: test.TestContext,
  shell: unknown | undefined,
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
  const fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: parent.id },
    { localShellSandbox: 'sandbox' },
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
    notices,
    submit,
    settle: async () => {
      await settle()
      await vt.waitForRender()
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

test('the sandbox preference without a composition shell capability notifies and falls back to the local spawn', async (t) => {
  const mounted = await mountSandboxRunner(t, undefined)
  mounted.submit('!echo fallback-ok')
  await waitForView(mounted, 'fallback-ok', 'the local spawn fallback card')
  assert.ok(mounted.notices.some(notice => notice.includes('sandbox unavailable')),
    `the downgrade must be surfaced, not silent:\n${mounted.notices.join('\n')}`)
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
