/**
 * M3-4 PR4 Step 7 command/action L6 qualification (plan §7.4 scenarios
 * 1–6, 8, 11 and §7.5 negative instrumentation): the REAL Remote
 * application composition driving REAL submit gestures, with every
 * forbidden reachability proven absent by AUTHORITATIVE durable facts
 * (the official executor's `command/run` lifecycle rows) rather than by
 * test-internal flags.
 *
 * M3-6 PR1 rewrote the extension evidence (§FACT 2.8 correction): the
 * positive extension command and the collision registration are mounted by
 * a REAL Client plugin fiber on `aggregate.wire.client.context` through the
 * public extension service — the selected `override.extensionService` — so
 * the L6 below now proves genuine Client Context ownership, with a
 * simultaneously mounted Host-context extension service as the negative
 * control (present, distinct, and never the selected authority).
 *
 * Scenario coverage:
 * 1. TUI built-in  — the Client handler runs; ZERO Host `command/run`.
 * 2. Extension     — the CLIENT-CONTEXT callback runs (the selected Client
 *                    service); the simultaneously present Host-context
 *                    extension callback runs ZERO times; ZERO Host
 *                    `command/run`.
 * 3. Host command  — executes EXACTLY ONCE through HostCommandPort (one
 *                    `command/run` + one `command/done`).
 * 4. Collision     — the Host claim wins; the same-named CLIENT-CONTEXT
 *                    extension callback is never invoked.
 * 5. Sessionless   — a sessionless TUI built-in works without creating a
 *                    Session.
 * 6. /copy         — the newest assistant message OUTSIDE the initial
 *                    window is reached by paging (the observable OSC 52
 *                    clipboard payload, never the window-only refusal).
 *
 * The known/unknown tool-card L6 lives in the PR2 presentation suite, whose
 * fixture materializes durable events into the Client window (this suite's
 * lighter fixture does not).
 *
 * PRODUCTION PREREQUISITES REPRODUCED: the real rc.2 Host services + the
 * whole-log projection rows, the official Client/Gateway path over the real
 * in-process carrier, the REAL runner composition root and the production
 * Remote prompt serializer.
 *
 * TEST STAND-INS: the scripted streaming LLM adapter; the extension host is
 * mounted through its REAL public service (contribution registration) — on
 * the Client Context for the selected authority and on the Host Context
 * only as the negative control.
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-command-plane.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Fiber } from '@deepseek-ai/cordis'
import { symbols } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import { PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** Unwrap a Cordis traceable service proxy to its implementation (service
 * identity comparisons in this suite compare the unwrapped instances). */
function unwrapService(value: unknown): unknown {
  const original = (value as Record<symbol, unknown>)[symbols.original]
  return original ?? value
}

class StubStreamingLlmAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  private held: Promise<void> | undefined

  override async *stream(): AsyncGenerator<never> {
    // A held stream never yields: the turn stays RUNNING until released.
    if (this.held !== undefined) await this.held
  }

  /** Hold every subsequent stream open until released (a running turn). */
  hold(): () => void {
    let release: () => void = () => {}
    this.held = new Promise<void>(resolve => { release = resolve })
    return release
  }
}

interface Fixture {
  host: Awaited<ReturnType<typeof import('./support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>
  vt: VirtualTerminal
  app(): {
    setDraft(text: string): void
    submitDraft(request?: string): void
    getDraft(): string
  }
  aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  /** The raw stdout the client wrote (the OSC 52 clipboard leg rides it). */
  rawOutput(): string
  /** The durable rows of one session's log (the authoritative evidence). */
  events(sessionId: string): Array<{ type: string; data: unknown }>
  /** How many times the official executor entered a command handler. */
  hostCommandRuns(sessionId: string): number
  dispose(): Promise<void>
}

async function mountRunner(
  life: TestLifecycle,
  options: {
    readonly presetId?: string
    readonly resumeSessionId?: string
    readonly host?: Fixture['host']
    /** Register one CLIENT-CONTEXT extension command before the runner
     * mounts (M3-6 PR1: the fiber mounts on
     * `aggregate.wire.client.context` and reads the service through its OWN
     * plugin context — the selected authority). */
    readonly extensionCommands?: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly sessionless?: boolean
      readonly handler: () => { kind: 'success'; text?: string } | { kind: 'error'; text: string }
    }>
    /** Register one HOST-CONTEXT extension command of the same identity as
     * the negative control (mounted on the ordinary Host Context; it must
     * never be the Remote runner's authority). */
    readonly hostExtensionCommands?: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly sessionless?: boolean
      readonly handler: () => { kind: 'success'; text?: string } | { kind: 'error'; text: string }
    }>
    /** Register one HOST command before the runner mounts. */
    readonly hostCommands?: ReadonlyArray<{
      readonly name: string
      readonly handler: () => { kind: 'success'; text?: string }
    }>
    readonly seed?: (append: (type: string, data: unknown, options?: { surfaceOp?: 'append' }) => void) => void
    /** A test-provided LLM adapter (e.g. one that can hold a turn RUNNING). */
    readonly llmAdapter?: StubStreamingLlmAdapter
    /** A test-provided appExit observer (the PR5 /exit-/quit parity test). */
    readonly appExit?: (code: number) => void
  } = {},
): Promise<Fixture> {
  const presetId = options.presetId ?? 'm3-4-pr4-cmd-preset'
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const host = options.host ?? await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: options.llmAdapter ?? new StubStreamingLlmAdapter(),
  })
  // The SAME projection rows the PR2/PR4 presentation fixture mounts (the
  // proven Remote transcript/window prerequisite set).
  const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
  const toolTodo = await import('@deepseek-ai/dsh-tool-todo')
  const title = await import('@deepseek-ai/dsh-session-title')
  const goalUnit = await import('@deepseek-ai/dsh-goal')
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await host.ctx.plugin(TokenMeter)
  await host.ctx.plugin(toolTodo, { allowParallelInProgress: false })
  await host.ctx.plugin(title.default as never, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as never)
  await host.ctx.plugin(goalUnit.default as never, { defaultMaxGoalRounds: 5 } as never)
  await host.ctx.plugin(turnOutline)

  const sessionId = options.resumeSessionId
  if (sessionId !== undefined) {
    await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
    if (options.seed !== undefined) {
      const session = host.ctx.sessions.get(SessionId(sessionId)) as unknown as {
        append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
      }
      options.seed((type, data, appendOptions) => session.append(type, data, appendOptions))
    }
  }
  for (const command of options.hostCommands ?? []) {
    host.ctx.commands.register({ name: command.name, description: `host ${command.name}`, handler: command.handler })
  }

  // The REAL Host runner tuiStartup (unchanged: the runner row still reads
  // the Host/profile Context — only the extension authority moved).
  const runnerCtx = host.ctx
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId, shippedPresetRoot: host.workRoot })

  // THE aggregate FIRST (M3-6 PR1 §14.4 ordering): the Client UI subtree
  // mounts the extension host + builtins on the official Client Context.
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    // The runner receives the same startup facts: the exact detached
    // sessionId copy (the runner startup carries no launch preset on this
    // fixture — `presetId` above is the Host fixture's preset name, not a
    // `--preset` fact).
    clientUiStartup: {
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  // HOST-NEGATIVE CONTROL: a Host-context extension service carrying the
  // SAME test identity, mounted only as the ignored authority. It must be
  // a distinct object from the aggregate's Client service.
  let hostService: { registerCommand(contribution: unknown): unknown } | undefined
  if (options.hostExtensionCommands !== undefined) {
    const extensionHostModule = await import('../src/extensions.ts')
    await runnerCtx.plugin(extensionHostModule)
    hostService = runnerCtx.get(extensionHostModule.PI_TUI_EXTENSIONS_SERVICE) as typeof hostService
    for (const command of options.hostExtensionCommands) {
      hostService!.registerCommand({
        id: command.id,
        name: command.name,
        description: `host-ext ${command.name}`,
        ...command.sessionless === true ? { sessionless: true } : {},
        handler: command.handler,
      })
    }
  }

  // The CLIENT-CONTEXT extension contributions (the SELECTED authority):
  // a REAL Client plugin fiber reads the service through its OWN plugin
  // context and registers exactly like a real plugin — caller-fiber
  // ownership is preserved, and the outer test context never registers
  // directly on the service.
  let extensionFiber: Fiber | undefined
  if (options.extensionCommands !== undefined) {
    const contributions = options.extensionCommands
    extensionFiber = aggregate.wire.client.context.plugin(clientPluginCtx => {
      const service = clientPluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as {
        registerCommand(contribution: unknown): unknown
      } | undefined
      if (service === undefined) throw new Error('the Client plugin context did not see piTuiExtensions')
      for (const command of contributions) {
        service.registerCommand({
          id: command.id,
          name: command.name,
          description: `ext ${command.name}`,
          ...command.sessionless === true ? { sessionless: true } : {},
          handler: command.handler,
        })
      }
    })
    await extensionFiber
    // The test fiber unloads (AWAITED) BEFORE the aggregate transport
    // disposal (the lifecycle deferrals run in reverse registration order).
    life.defer(() => extensionFiber?.dispose())
  }

  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = await import('./support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)
  // /copy's terminal-client leg writes the OSC 52 sequence to stdout: tee it
  // so the test can decode the EXACT clipboard payload the client produced.
  const stdoutChunks: string[] = []
  const originalIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  life.defer(() => {
    if (originalIsTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTty)
  })
  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  life.defer(() => { process.stdout.write = originalStdoutWrite as typeof process.stdout.write })

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  runnerCtx.provide('appExit', (code: number) => { (options.appExit ?? ((c: number) => { void c }))(code) })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
  }
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId } as never), override)
  })
  await runnerFiber
  life.defer(() => { runnerFiber.dispose() })
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)

  const appOf = async () => {
    for (let i = 0; i < 600; i += 1) {
      const candidate = apps.at(-1) as unknown as { setDraft?: unknown } | undefined
      if (candidate !== undefined && typeof candidate.setDraft === 'function') return candidate as never
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the draft surface')
  }
  const app = await appOf()

  return {
    host,
    vt,
    app: () => app as never,
    aggregate,
    rawOutput: () => stdoutChunks.join(''),
    events: (id) => {
      const session = host.ctx.sessions.get(SessionId(id)) as unknown as {
        snapshotEvents(): Array<{ type: string; data: unknown }>
      }
      return session.snapshotEvents()
    },
    hostCommandRuns: (id) => {
      const session = host.ctx.sessions.get(SessionId(id)) as unknown as {
        snapshotEvents(): Array<{ type: string; data: unknown }>
      }
      return session.snapshotEvents().filter(event => event.type === 'command/run').length
    },
    dispose: async () => { await runnerFiber.dispose() },
  }
}

function submit(fixture: Fixture, text: string): void {
  const app = fixture.app()
  app.setDraft(text)
  app.submitDraft()
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

test('L6 §7.4-1 TUI built-in: the Client handler runs and the Host executor is NEVER entered', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-cmd-builtin'
  const fixture = await mountRunner(life, { resumeSessionId: mainId })
  submit(fixture, '/display compact')
  await waitFor('the Client handler applied the display preset', () => {
    const app = fixture.app() as unknown as { displayPreset?(): string }
    return app.displayPreset?.() === 'compact'
  }, 15_000)
  await settle()
  assert.equal(fixture.hostCommandRuns(mainId), 0,
    'a TUI built-in must never reach the Host command executor (zero command/run rows)')
})

test('L6 §7.4-2 extension (M3-6 PR1): the CLIENT-CONTEXT callback runs through the selected Client service; the Host-context twin and the Host executor are NEVER entered', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-cmd-ext'
  let clientCalls = 0
  let hostExtensionCalls = 0
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    extensionCommands: [{
      id: 'pr4-ext',
      name: 'pr4ext',
      sessionless: true,
      handler: () => { clientCalls += 1; return { kind: 'success', text: 'client-ext ran' } },
    }],
    hostExtensionCommands: [{
      id: 'pr4-ext',
      name: 'pr4ext',
      sessionless: true,
      handler: () => { hostExtensionCalls += 1; return { kind: 'success', text: 'host-ext ran' } },
    }],
  })
  // Source → decision → sink identity precondition: the selected authority
  // is the aggregate's CLIENT service, and the Host-context twin is a
  // simultaneously mounted, DISTINCT service implementation.
  assert.equal(
    unwrapService(fixture.aggregate.clientUi.extensionService),
    unwrapService(fixture.aggregate.wire.client.context.get(PI_TUI_EXTENSIONS_SERVICE)),
    'the selected extension service IS the Client Context service')
  const hostTwin = fixture.host.ctx.get(PI_TUI_EXTENSIONS_SERVICE)
  assert.notEqual(hostTwin, undefined, 'the negative-control Host extension service is mounted')
  assert.notEqual(
    unwrapService(fixture.aggregate.clientUi.extensionService), unwrapService(hostTwin),
    'the Host-context extension service is a distinct implementation')

  submit(fixture, '/pr4ext')
  await waitFor('the CLIENT-context extension callback ran', () => clientCalls === 1, 15_000)
  await settle()
  assert.equal(hostExtensionCalls, 0,
    'the simultaneously present Host-context extension callback executed ZERO times (ignored authority)')
  assert.equal(fixture.hostCommandRuns(mainId), 0,
    'an extension callback must never reach the Host command executor')
})

test('L6 §7.4-3 Host command: executes EXACTLY ONCE through HostCommandPort', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-cmd-host'
  let calls = 0
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    hostCommands: [{ name: 'pr4host', handler: () => { calls += 1; return { kind: 'success', text: 'host ran' } } }],
  })
  // Re-read the host catalog for the current session (the runner's refresh
  // installs the claims; the initial install is the startup prefetch).
  await settle(120)
  submit(fixture, '/pr4host')
  await waitFor('the Host command entered its handler', () => calls === 1, 15_000)
  await waitFor('the official lifecycle rows landed', () => {
    const kinds = fixture.events(mainId).map(event => event.type)
    return kinds.includes('command/run') && kinds.includes('command/done')
  }, 15_000)
  await settle()
  assert.equal(calls, 1, 'exactly one handler entry')
  assert.equal(fixture.hostCommandRuns(mainId), 1,
    'exactly ONE command/run row — the Host command is never auto-retried or double-dispatched')
})

test('L6 §7.4-4 collision (M3-6 PR1): the Host claim wins and the same-named CLIENT-CONTEXT extension callback is never invoked', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-cmd-collision'
  let hostCalls = 0
  let clientCalls = 0
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    hostCommands: [{ name: 'pr4collide', handler: () => { hostCalls += 1; return { kind: 'success', text: 'host wins' } } }],
    // A CLIENT-CONTEXT registration (M3-6 PR1): the extension side of the
    // collision is the selected Client service's contribution.
    extensionCommands: [{
      id: 'pr4-collide',
      name: 'pr4collide',
      sessionless: true,
      handler: () => { clientCalls += 1; return { kind: 'success', text: 'client' } },
    }],
  })
  await settle(120)
  submit(fixture, '/pr4collide')
  try {
    await waitFor('the Host command ran', () => hostCalls === 1, 15_000)
  } catch (error) {
    console.error('[collision-dump] hostCalls=', hostCalls, 'clientCalls=', clientCalls)
    console.error('[collision-dump] commandRuns=', fixture.hostCommandRuns(mainId))
    try {
      const names = (await fixture.aggregate.presentation.commandSource.readCommands(mainId))?.map(entry => entry.name)
      console.error('[collision-dump] command-source names=', JSON.stringify(names))
    } catch (probeError) {
      console.error('[collision-dump] command-source read failed:', probeError instanceof Error ? probeError.message : String(probeError))
    }
    console.error('[collision-dump] viewport:\n' + fixture.vt.getViewport().join('\n'))
    throw error
  }
  await settle()
  assert.equal(clientCalls, 0, 'the Host claim owns the line — the colliding Client callback never runs')
})

test('L6 §7.4-6 a sessionless TUI built-in works before the first Session and creates none', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRunner(life, {})
  const before = fixture.host.ctx.sessions.list().length
  submit(fixture, '/help')
  await settle(150)
  assert.equal(fixture.host.ctx.sessions.list().length, before,
    'a sessionless command never creates a Session')
})

test('L6 §7.4-8 /copy reaches the newest assistant message OUTSIDE the initial window by paging', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-cmd-copy'
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    seed: (append) => {
      // Turn 1 carries the ONLY assistant message; the later turns are
      // completed-without-answer turns, so the tail window holds no
      // assistant/message and the paging loop must walk back to turn 1.
      append('turn/start', { turn: 1 })
      append('step/start', { turn: 1, step: 1 })
      append('user/message', {
        id: 'u-copy-1', role: 'user', content: [{ type: 'text', text: 'copy target prompt' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      append('assistant/message', {
        turn: 1, step: 1,
        message: { id: 'a-copy-1', role: 'assistant', content: [{ type: 'text', text: 'COPY-TARGET-TEXT' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
        stream: [], usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 1, step: 1 })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      for (let turn = 2; turn <= 20; turn += 1) {
        append('turn/start', { turn })
        append('step/start', { turn, step: 1 })
        append('user/message', {
          id: `u-copy-${turn}`, role: 'user', content: [{ type: 'text', text: `later prompt ${turn}` }], source: { kind: 'user' },
        }, { surfaceOp: 'append' })
        append('step/end', { turn, step: 1 })
        append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    },
  })
  await waitFor('the bounded window hydrated', () => fixture.vt.getViewport().join('').length > 0, 20_000)
  submit(fixture, '/copy')
  // The OSC 52 clipboard payload proves the paging loop found the OLDER
  // message: a window-only read would refuse (the refusal is the failure
  // mode this scenario exists to catch).
  await waitFor('the copy produced a clipboard payload', () =>
    /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/.test(fixture.rawOutput()), 20_000)
  const match = /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(fixture.rawOutput())
  assert.ok(match !== null, 'the OSC 52 sequence carries the base64 payload')
  assert.equal(Buffer.from(match![1]!, 'base64').toString('utf8'), 'COPY-TARGET-TEXT',
    'the copied text is the last assistant message reached by paging')
})

test('L6 §D3 (review F2-external): a REAL Host `/export` claim wins over the same-named TUI built-in', async (t) => {
  // The frozen rc.2 `dsh-session-log-export` Host plugin registers `/export`
  // (a Web-only ZIP download) — the REAL production collision. The TUI also
  // owns a Client `/export` built-in. The §D3 precedence contract: the
  // AUTHORITATIVE HOST catalog resolves the name first — the line goes to
  // HostCommandPort (one official command/run row), and the Client built-in
  // never executes its artifact-save path for it.
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-cmd-export-claim'
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    seed: (append) => {
      // One completed turn so the session is a real conversation subject.
      append('turn/start', { turn: 1 })
      append('step/start', { turn: 1, step: 1 })
      append('user/message', {
        id: 'u-export', role: 'user', content: [{ type: 'text', text: 'export prompt' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      append('assistant/message', {
        turn: 1, step: 1,
        message: { id: 'a-export', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
        stream: [], usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 1, step: 1 })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
  })
  await settle(120)
  // The HOST catalog (the official plugin's registration) resolves /export.
  const resolves = await (async () => {
    const names = (await fixture.aggregate.presentation.commandSource.readCommands(mainId))?.map(entry => entry.name)
    return names?.includes('export') === true
  })()
  assert.equal(resolves, true,
    'the official dsh-session-log-export Host registration is in the authoritative catalog')
  submit(fixture, '/export')
  // The OFFICIAL executor's durable command/run row is the authority: the
  // Host claim owns the line (the Client /export CALLBACK never executes —
  // note the shared command settlement still triggers the TUI's own
  // startArtifactSave('export') AFTER the Host success, which is the
  // correct local-save flow, not a Client-command execution).
  await waitFor('the HOST /export lifecycle rows landed', () => {
    const kinds = fixture.events(mainId).map(event => event.type)
    return kinds.includes('command/run') && kinds.includes('command/done')
  }, 15_000)
  assert.equal(fixture.hostCommandRuns(mainId), 1,
    'the /export line executed through the OFFICIAL Host executor exactly once (the Host claim owns it)')
})

test('L6 §7.4-6 sessionless standing skill: the Remote refresh reports EXPLICIT unavailable and creates NO Session', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRunner(life, {})
  const before = fixture.host.ctx.sessions.list().length
  submit(fixture, '/reload')
  await waitFor('the explicit standing-unavailable copy rendered', () =>
    fixture.vt.getViewport().join('').includes('catalog refresh failed')
    && fixture.vt.getViewport().join('').includes('no sessionless standing skill catalog'), 15_000)
  await settle(150)
  assert.equal(fixture.host.ctx.sessions.list().length, before,
    'the Remote standing refresh creates NO hidden Session')
})

test('L6 truthful-unavailable (review round 4): Remote /transcript refuses EXPLICITLY and never starts the artifact save', async (t) => {
  // The Markdown renderer reads the whole Session event history
  // (`snapshotEvents`) — no transport-neutral seam exists yet, so the
  // Remote post-success artifact save would resolve the projected agent and
  // crash inside `renderTranscriptMarkdown` AFTER the command already
  // reported success. The contract: the handler refuses with a shown error,
  // the notice renders, Save Location NEVER opens (zero artifact-save
  // workflows started), and the Host executor is never entered.
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-transcript-unavailable'
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    seed: (append) => {
      // One completed turn so the session is a real conversation subject
      // (the save path could otherwise be refused for emptiness).
      append('turn/start', { turn: 1 })
      append('step/start', { turn: 1, step: 1 })
      append('user/message', {
        id: 'u-transcript', role: 'user', content: [{ type: 'text', text: 'transcript prompt' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      append('assistant/message', {
        turn: 1, step: 1,
        message: { id: 'a-transcript', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
        stream: [], usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 1, step: 1 })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
  })
  // The save prompt is CLIENT-local UI: patch the production prototype so
  // the test observes the REAL workflow's entry (never a test-owned seam).
  let savePrompts = 0
  const originalAsk = TuiApp.prototype.askSaveLocation
  TuiApp.prototype.askSaveLocation = async function patchedAsk() {
    savePrompts += 1
    return { kind: 'cancelled' }
  }
  life.defer(() => { TuiApp.prototype.askSaveLocation = originalAsk })
  await settle(120)
  submit(fixture, '/transcript')
  await waitFor('the truthful-unavailable notice rendered', () =>
    fixture.vt.getViewport().join('').includes('transcript export is unavailable on this backend'), 15_000)
  await settle(150)
  assert.equal(savePrompts, 0,
    'a refused /transcript must never open Save Location (zero artifact-save workflows)')
  assert.equal(fixture.hostCommandRuns(mainId), 0,
    'the Remote /transcript refusal never reaches the Host command executor')
})

test('L6 §7.4-14 stale catalog (M3-6 PR2): refresh A → Connection replacement → the old snapshot cannot commit and generation B AUTOMATICALLY re-reads the Host catalog without /reload', async (t) => {
  // The F2a install fence over the MOUNTED composition, plus the M3-6 PR2
  // automatic reconnect recovery. The stale payload is REAL by construction:
  // the gated read completes FIRST (its snapshot verifiably contains
  // `stale-cmd`), then holds; while held, the OFFICIAL Connection is
  // REPLACED (`reconnect()`) and `stale-cmd` is DISPOSED — so the held
  // wrapper returns a snapshot whose content is wrong for every later
  // state. Without the install fence that stale snapshot WOULD commit (the
  // counterfactual force); with it, the completion rows must never offer
  // the retired name. M3-6 PR2 then proves the DECISIVE new path: the new
  // defined generation B triggers the CommandSurface's own generation
  // subscription — NO user /reload — and the B catalog installs and serves
  // a mounted submission through the REAL Host handler exactly once.
  const life = testLifecycle(t)
  const sessionA = 'm3-4-pr4-catalog-stale-a'
  // A post-reconnect B-side Host command: proving it dispatches through the
  // REAL Host handler exactly once is the PR2 source→decision→sink sink
  // (AC1). Its name ALSO carries a CLIENT-CONTEXT extension contribution —
  // the collision is the DISCRIMINATOR: whether the mounted line routes to
  // the Host executor depends on the INSTALLED B-side Host-origin claim, so
  // a no-op install (the counterfactual: the automatic refresh read B but
  // never installed it) would send the line nowhere and this test red.
  let bHostRuns = 0
  let bClientCalls = 0
  const fixture = await mountRunner(life, {
    resumeSessionId: sessionA,
    // The CLIENT-CONTEXT twin of the B Host command's name: registered BEFORE
    // the runner mounts, so both sides exist for the whole scenario. While
    // the B Host-origin claim is installed the Host route wins and this
    // callback never runs; without the installed claim the line cannot reach
    // the Host executor either (see the routing analysis above).
    extensionCommands: [{
      id: 'pr2-b-fresh-twin',
      name: 'b-fresh-cmd',
      sessionless: true,
      handler: () => { bClientCalls += 1; return { kind: 'success', text: 'client twin ran' } },
    }],
  })

  // The Host command whose name only the STALE snapshot carries, plus a
  // SURVIVOR command that stays registered — the post-release positive
  // control must see the survivor and never the retired name. The B-side
  // Host command (the collision's Host side) registers here too, BEFORE any
  // reconnect: only the generation-B catalog can ever claim its name.
  const commands = fixture.host.ctx.commands as {
    register(def: { name: string; description: string; handler: () => { kind: 'success' } }): () => void
  }
  const disposeStale = commands.register({
    name: 'stale-cmd',
    description: 'the stale catalog entry',
    handler: () => ({ kind: 'success' }),
  })
  commands.register({
    name: 'live-cmd',
    description: 'the surviving catalog entry',
    handler: () => ({ kind: 'success' }),
  })
  commands.register({
    name: 'b-fresh-cmd',
    description: 'the B generation command',
    handler: () => { bHostRuns += 1; return { kind: 'success', text: 'b ran' } },
  })

  // GATE the REAL commands provider read: the read COMPLETES first, then
  // holds; the held wrapper returns the SAVED snapshot (never re-reads).
  let releaseRead: (() => void) | undefined
  const readGate = new Promise<void>(resolve => { releaseRead = resolve })
  const commandSource = fixture.aggregate.presentation.commandSource as {
    readCommands(sessionId: string, signal?: AbortSignal): Promise<readonly { name: string }[] | undefined>
  }
  const originalReadCommands = commandSource.readCommands.bind(commandSource)
  const postReleaseReads: Array<{ sessionId: string; names: readonly string[] | undefined }> = []
  let readCount = 0
  let heldRead = false
  commandSource.readCommands = async (sessionId, signal) => {
    readCount += 1
    const result = await originalReadCommands(sessionId, signal)
    if (readCount > 1) postReleaseReads.push({ sessionId, names: result?.map(entry => entry.name) })
    if (readCount === 1 && sessionId === sessionA) {
      // The stale payload is verified BEFORE the hold: this snapshot really
      // contains the command the later state will have disposed.
      assert.ok(result?.some(entry => entry.name === 'stale-cmd') === true,
        `the held snapshot must verifiably contain stale-cmd: ${JSON.stringify(result?.map(entry => entry.name))}`)
      heldRead = true
      await readGate
      return result
    }
    return result
  }

  // The OFFICIAL Connection face (the frozen admission token's generation
  // component is the identity this scenario kills).
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id

  // The refresh gesture on A: the read completes and HOLDS with the saved
  // stale-cmd snapshot. (The /reload submit itself now waits inside the
  // refresh — the FIFO turn stays taken, so the replacement below must NOT
  // ride a submit gesture.)
  submit(fixture, '/reload')
  // A failure past this point must still release the gate, or the runner's
  // teardown waits forever on the held /reload submit turn.
  life.defer(() => releaseRead?.())
  await waitFor('the gated read holds the stale snapshot', () => heldRead, 10_000)

  // CONNECTION REPLACEMENT (plan scenario 14's second form — the /reload
  // submit's FIFO turn is held by the gated refresh, so a second submit
  // cannot run): the OFFICIAL reconnect replaces the Connection generation
  // while the read is still held. The rc.2 client publishes
  // generation=undefined SYNCHRONOUSLY on 'connecting' and only later a NEW
  // numeric id once reconnected — so the wait must demand a DEFINED and
  // DIFFERENT id: that proves both the old token's retirement AND that the
  // replacement Connection is actually established (a mere `!== old` would
  // pass while the client is still connecting with no generation at all).
  connection.reconnect()
  // While the old generation is gone (the client publishes `undefined`
  // synchronously on 'connecting'), the HOST TRUTH ITSELF CHANGES: the
  // stale-cmd registration is disposed before generation B ever appears, so
  // generation B's authoritative catalog legitimately no longer carries it
  // (the same offline-truth shape the presentation reconnect case uses).
  disposeStale()
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== generationBefore
  }, 20_000)

  // Release the held A read: its snapshot (captured under generation A,
  // verifiably containing the retired name) settles after B exists.
  releaseRead?.()

  // The stale snapshot must NOT commit: the completion rows never offer the
  // retired name (a committed stale install would — this is the
  // counterfactual force: without the install fence this snapshot, whose
  // payload verifiably contained the command, would install it).
  await settle(800)
  const rows = (fixture.app() as unknown as {
    commandCompletionsForTest(): readonly { name: string }[]
  }).commandCompletionsForTest()
  assert.equal(rows.some(row => row.name === 'stale-cmd'), false,
    `the stale snapshot never commits (the retired Host command must not appear): ${JSON.stringify(rows.map(row => row.name))}`)

  // ── M3-6 PR2 DECISIVE PATH: the automatic reconnect refresh. NO /reload
  // is submitted after the reconnect; the CommandSurface's own generation
  // subscription must have read the B catalog against the CURRENT session
  // id and installed it. The mounted-visible proof rides the CLAIM layer:
  // on Remote the completion DISPLAY list is deliberately Client-only
  // (PR4 §D3 — the Host catalog arrives as claims, never as display rows),
  // so the user-visible surface of the installed B catalog is which lines
  // the mounted submission still routes to the REAL Host executor.
  let liveRead: { sessionId: string; names: readonly string[] | undefined } | undefined
  try {
    await waitFor('the AUTOMATIC reconnect refresh settled a DEFINED post-retirement B read', () => {
      liveRead = postReleaseReads.find(read =>
        read.sessionId === sessionA
        && read.names !== undefined
        && read.names.includes('b-fresh-cmd')
        && !read.names.includes('stale-cmd'))
      return liveRead !== undefined
    }, 20_000)
  } catch (error) {
    console.error('[stale-dump] postReleaseReads=', JSON.stringify(postReleaseReads))
    throw error
  }
  const liveNames = liveRead!.names as readonly string[]
  assert.ok(liveNames.includes('live-cmd'),
    `the automatic B catalog read carries the surviving command: ${JSON.stringify(liveNames)}`)
  assert.equal(liveNames.includes('stale-cmd'), false,
    'the automatic B catalog read no longer carries the retired name')

  // The mounted submission routes the B Host command to the REAL Host
  // handler EXACTLY ONCE (the sink of the PR2 source→decision→sink chain:
  // wire.connection.generation → RemoteCommandSource subscription →
  // CommandSurface reconnect decision → CatalogRefreshCoordinator → real
  // Host command catalog B → Host-origin classifier → mounted submission →
  // official executor). The same-named CLIENT-CONTEXT twin never executes:
  // the INSTALLED B claim owns the line (the §D3 collision, and the
  // discriminator that makes a no-op install of the automatic B refresh
  // fail this whole block instead of passing vacuously).
  const commandRunsBefore = fixture.hostCommandRuns(sessionA)
  submit(fixture, '/b-fresh-cmd')
  await waitFor('the B Host command entered its real handler', () => bHostRuns === 1, 15_000)
  await settle()
  assert.equal(bHostRuns, 1, 'exactly one B Host handler entry (no auto-retry, no double dispatch)')
  assert.equal(fixture.hostCommandRuns(sessionA) - commandRunsBefore, 1,
    'exactly ONE new official command/run row for the B Host command')
  assert.equal(bClientCalls, 0,
    'the same-named Client twin never executed — the installed B Host claim owns the line')

  // NEGATIVE control on the same claim layer: the retired A-only Host
  // command no longer routes anywhere — the B claims are the authority, so
  // a /stale-cmd line must NOT reach the Host executor (and must not become
  // a Client callback either).
  const runsAfterB = fixture.hostCommandRuns(sessionA)
  submit(fixture, '/stale-cmd')
  await settle(600)
  assert.equal(fixture.hostCommandRuns(sessionA), runsAfterB,
    'the retired Host command is absent from the installed B claims (no command/run row)')
})

/* ── PR5 supplement: Client self-claim reachability under running + steer ── */

test('L6 PR5: TUI local commands stay reachable while the session RUNS and busy delivery resolves to STEER (the PR4 self-claim regression)', async (t) => {
  // The PR4 regression shape: this Client's own TUI registrations appear in
  // the effective claim union, and the retired line-claim discriminator
  // read them as Host territory — so /status under a running session with a
  // steer-resolved gesture was STEERED as agent input instead of reaching
  // its Client handler. The PR5 authority correction makes
  // `hostCatalogResolves` the only Host-NAME discriminator, so the local
  // line takes the queue placeholder and the handler RUNS.
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr5-reach-status'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    llmAdapter: llm,
    seed: (append) => {
      append('turn/start', { turn: 1 })
      append('step/start', { turn: 1, step: 1 })
      append('user/message', {
        id: 'u-reach', role: 'user', content: [{ type: 'text', text: 'reach opener' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 1, step: 1 })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
  })
  // Start a REAL running turn (the held stream keeps it open).
  submit(fixture, 'hold this turn open')
  await waitFor('the session is running', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === true, 20_000)
  // busyEnter defaults to queue ⇒ the ACCELERATED chord resolves to STEER
  // (the composer-policy opposite). /status must still reach its Client
  // handler (the settings panel opens), never steer.
  const app = fixture.app() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft('/status')
  app.submitDraft('accelerated')
  await waitFor('the /status panel opened', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('Session') && text.includes('Stats')
  }, 15_000)
  // The steer counterfactual: the literal line must NOT appear as agent
  // input (no inbox splice carries it), and no Host command/run row exists.
  const spliced = fixture.events(mainId).some(event =>
    event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('/status'))
  assert.equal(spliced, false, '/status was never steered into the agent inbox')
  assert.equal(fixture.hostCommandRuns(mainId), 0, 'a TUI built-in never reaches the Host executor')
  release()
})

test('L6 PR5: /copy under running + steer copies (the OSC 52 leg runs), never steers', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr5-reach-copy'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    llmAdapter: llm,
    seed: (append) => {
      append('turn/start', { turn: 1 })
      append('step/start', { turn: 1, step: 1 })
      append('user/message', {
        id: 'u-copy-r', role: 'user', content: [{ type: 'text', text: 'copy reach prompt' }], source: { kind: 'user' },
      }, { surfaceOp: 'append' })
      append('assistant/message', {
        turn: 1, step: 1,
        message: { id: 'a-copy-r', role: 'assistant', content: [{ type: 'text', text: 'REACH-COPY-TEXT' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
        stream: [], usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append' })
      append('step/end', { turn: 1, step: 1 })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
  })
  await waitFor('the window hydrated', () => fixture.vt.getViewport().join('').includes('REACH-COPY-TEXT'), 20_000)
  submit(fixture, 'hold this turn open')
  await waitFor('the session is running', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === true, 20_000)
  const app = fixture.app() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft('/copy')
  app.submitDraft('accelerated')
  await waitFor('the clipboard payload landed', () =>
    /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/.test(fixture.rawOutput()), 20_000)
  const match = /\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007/.exec(fixture.rawOutput())
  assert.equal(Buffer.from(match![1]!, 'base64').toString('utf8'), 'REACH-COPY-TEXT',
    'the copy ran through its Client handler while the session was running under steer delivery')
  const spliced = fixture.events(mainId).some(event =>
    event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('/copy'))
  assert.equal(spliced, false, '/copy was never steered into the agent inbox')
  release()
})

test('L6 PR5: /transcript under running + steer gives the explicit unavailable error, never steers', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr5-reach-transcript'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const fixture = await mountRunner(life, { resumeSessionId: mainId, llmAdapter: llm, seed: () => {} })
  submit(fixture, 'hold this turn open')
  await waitFor('the session is running', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === true, 20_000)
  const app = fixture.app() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft('/transcript')
  app.submitDraft('accelerated')
  await waitFor('the truthful-unavailable notice rendered', () =>
    fixture.vt.getViewport().join('\n').includes('transcript export is unavailable on this backend'), 15_000)
  const spliced = fixture.events(mainId).some(event =>
    event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('/transcript'))
  assert.equal(spliced, false, '/transcript was never steered into the agent inbox')
  release()
})

test('L6 PR5 negative controls: agent-facing and Host-owned lines keep their delivery under the same condition', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr5-reach-neg'
  let hostRuns = 0
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const fixture = await mountRunner(life, {
    resumeSessionId: mainId,
    llmAdapter: llm,
    hostCommands: [{ name: 'pr5host', handler: () => { hostRuns += 1; return { kind: 'success', text: 'host ran' } } }],
    seed: () => {},
  })
  await settle(120)
  submit(fixture, 'hold this turn open')
  await waitFor('the session is running', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === true, 20_000)
  const app = fixture.app() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  // (a) A plain prompt under the accelerated (steer) chord STILL steers.
  app.setDraft('plain steer probe')
  app.submitDraft('accelerated')
  await waitFor('the plain prompt steered', () => fixture.events(mainId).some(event =>
    event.type === 'agent/inbox/spliced' && JSON.stringify(event.data).includes('plain steer probe')), 20_000)
  // (b) A REAL Host command still executes through Host authority exactly
  // once (the authoritative catalog resolves its name).
  app.setDraft('/pr5host')
  app.submitDraft('accelerated')
  await waitFor('the Host command ran', () => hostRuns === 1, 15_000)
  await settle()
  assert.equal(hostRuns, 1, 'the Host command executed exactly once')
  release()
})

test('L6 PR5: /exit and /quit request the exit with NO session creation (sessionless alias parity)', async (t) => {
  const life = testLifecycle(t)
  const exits: number[] = []
  const fixture = await mountRunner(life, { appExit: code => { exits.push(code) } })
  const countSessions = (): number =>
    (fixture.host.ctx.sessions as unknown as { list(): unknown[] }).list().length
  assert.equal(countSessions(), 0, 'the runner started sessionless')
  submit(fixture, '/quit')
  await waitFor('/quit requested the exit', () => exits.length === 1, 15_000)
  assert.equal(countSessions(), 0, '/quit exits without creating a session')
})

test('L6 PR5: /exit (the canonical alias) behaves identically sessionless', async (t) => {
  const life = testLifecycle(t)
  const exits: number[] = []
  const fixture = await mountRunner(life, { appExit: code => { exits.push(code) } })
  const countSessions = (): number =>
    (fixture.host.ctx.sessions as unknown as { list(): unknown[] }).list().length
  submit(fixture, '/exit')
  await waitFor('/exit requested the exit', () => exits.length === 1, 15_000)
  assert.equal(countSessions(), 0, '/exit exits without creating a session (alias parity with /quit)')
})
