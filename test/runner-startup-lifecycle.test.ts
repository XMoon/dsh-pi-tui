/** Runner startup process-lifecycle coverage: the Loader barrier, the
 * Starting DSH status, resume-status handoff, pre-mount aborts, Host Loader
 * stall/rejection, fatal startup log/exit ordering, status-clear retry
 * behavior, invalid --preset on a healthy resume, and the deferred-start exit. */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import {
  disposeContext,
  fakeSession,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
} from './support/runner-harness.ts'
import { installProbe } from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

test('the Loader barrier shows Starting DSH… then clears; explicit cold resume continues with the resume status', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-startup-status-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  // Capture the runner's status writes through the INJECTED output seam
  // (never a global process.stdout patch — that would fight the test
  // reporter's own writes) and the cordis logger messages into ONE
  // ordered log: the shared order lets the failure path assert that the
  // status is suspended BEFORE the failure logs (a TTY shares one cursor
  // between stdout and stderr).
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let resumeContext: Context | undefined
  let deferredContext: Context | undefined
  let failContext: Context | undefined
  let resumeFiber: { dispose: () => Promise<unknown> } | undefined
  let deferredFiber: { dispose: () => Promise<unknown> } | undefined
  let failFiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (failContext !== undefined) return disposeContext(failContext) })
  life.defer(() => { if (deferredContext !== undefined) return disposeContext(deferredContext) })
  life.defer(() => { if (resumeContext !== undefined) return disposeContext(resumeContext) })
  life.defer(() => { if (failFiber !== undefined) return failFiber.dispose() })
  life.defer(() => { if (deferredFiber !== undefined) return deferredFiber.dispose() })
  life.defer(() => { if (resumeFiber !== undefined) return resumeFiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'startup-status-session',
    header: { id: 'startup-status-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const resumeHarness = makeHarness(home, resumed)
  resumeContext = new Context()
  resumeFiber = await mountRunner(resumeContext, home, resumeHarness, { sessionId: resumed.id }, { sessionId: resumed.id, startupStatusOutput: statusOutput })
  // The FIRST pre-mount status is the Loader barrier: it must be written
  // BEFORE the barrier resolves and cleared immediately after, so a stalled
  // optional row is visible instead of a dead blank terminal.
  const startingWrites = orderedLog
    .filter(write => write.startsWith('stdout:') && (write.includes('Starting DSH…') || write === 'stdout:\r\x1b[2K'))
    .map(write => write.slice('stdout:'.length))
  assert.ok(startingWrites.some(write => write.includes('Starting DSH…')),
    `the Loader barrier must show Starting DSH…: ${JSON.stringify(startingWrites)}`)
  const startIndex = startingWrites.findIndex(write => write.includes('Starting DSH…'))
  const startClearIndex = startingWrites.findIndex((write, index) => index > startIndex && write === '\r\x1b[2K')
  assert.ok(startClearIndex > startIndex,
    `Starting DSH… must be cleared after the Loader settles: ${JSON.stringify(startingWrites)}`)
  const statusWrites = orderedLog
    .filter(write => write.startsWith('stdout:') && (write.includes('Resuming session') || write.includes('Preparing conversation') || write === 'stdout:\r\x1b[2K'))
    .map(write => write.slice('stdout:'.length))
  assert.ok(statusWrites.some(write => write.includes('Resuming session…')),
    `the resume status must be written before mount: ${JSON.stringify(statusWrites)}`)
  assert.ok(statusWrites.some(write => write.includes('Preparing conversation…')),
    `the preparing stage must replace the resume line: ${JSON.stringify(statusWrites)}`)
  const showIndexes = statusWrites
    .map((write, index) => write.includes('Resuming') || write.includes('Preparing') ? index : -1)
    .filter(index => index >= 0)
  // The status is suspended before the success log (a mid-resume clear)
  // and cleared again before mount: the LAST clear must follow the last
  // show.
  const lastClearIndex = statusWrites.map((write, index) => write === '\r\x1b[2K' ? index : -1).filter(index => index >= 0).at(-1)
  assert.ok(lastClearIndex !== undefined && lastClearIndex > showIndexes[showIndexes.length - 1]!,
    `the status must be cleared after the last show (before mount): ${JSON.stringify(statusWrites)}`)
  // The resume lifecycle is untouched: exactly one hydration, no extra
  // transcript rows.
  assert.equal(probe.transcriptHydrateCount, 1)
  assert.equal(probe.statsHydrateCount, 1)
  assert.equal(probe.transcriptApplyCount, 1)

  await resumeFiber.dispose()
  await disposeContext(resumeContext)
  resumeFiber = undefined
  resumeContext = undefined

  // A fresh (deferred) start shows ONLY the Loader barrier status: it must
  // never emit the resume/preparing stages, and the barrier line must not
  // survive into the mounted surface.
  orderedLog.length = 0
  const deferredHarness = makeHarness(home)
  deferredContext = new Context()
  deferredFiber = await mountRunner(deferredContext, home, deferredHarness, {}, { startupStatusOutput: statusOutput })
  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2KStarting DSH…'),
    `a fresh start must show the Loader barrier status: ${JSON.stringify(orderedLog)}`)
  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2K'),
    `the Loader barrier status must be cleared: ${JSON.stringify(orderedLog)}`)
  assert.ok(!orderedLog.some(write => write.includes('Resuming session') || write.includes('Preparing conversation')),
    `a fresh start must not emit the resume/preparing stages: ${JSON.stringify(orderedLog)}`)

  await deferredFiber.dispose()
  await disposeContext(deferredContext)
  deferredFiber = undefined
  deferredContext = undefined

  // A FAILED resume also clears the status (the surface starts
  // sessionless — no stale line may survive), and the clear happens
  // BEFORE the failure logs: the status owns the current terminal
  // line, so a logger write must never interleave with it (a TTY
  // shares one cursor between stdout and stderr).
  orderedLog.length = 0
  const failedSession: FakeSession = fakeSession({
    id: 'missing-session',
    header: { id: 'missing-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('failed resume history'),
  })
  const failHarness = makeHarness(
    home,
    failedSession,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Error('boom'),
  )
  const failCtx = new Context()
  const appsBeforeFailure = probe.apps.length
  failContext = failCtx
  // Capture the runner's failure logs through the cordis logger
  // exporter (the same sink a real deployment registers). The exporter
  // threshold lives in `levels.default` (the MAXIMUM level exported):
  // WARN (2) admits the runner's warn/error lines (the default INFO
  // threshold would drop them). Registered inside a fiber — cordis
  // registers exporters through ctx.effect.
  const exporterFiber = failCtx.plugin(() => {
    failCtx.logger.exporter({
      levels: { default: 2 },
      export: (message) => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  failFiber = await mountRunner(failContext, home, failHarness, { sessionId: 'missing-session' }, { sessionId: 'missing-session', startupStatusOutput: statusOutput })
  assert.equal(failHarness.resumeSignals[0]?.aborted, false,
    'an ordinary resume failure must observe a live lifecycle signal')
  assert.equal(probe.apps.length, appsBeforeFailure + 1,
    'an ordinary resume failure must keep the existing sessionless fallback mount')
  assert.ok(orderedLog.some(write => write.includes('resume missing-session failed: boom')),
    `the ordinary resume error must remain visible: ${JSON.stringify(orderedLog)}`)
  const failWrites = orderedLog.filter(write => write.includes('Resuming session') || write === 'stdout:\r\x1b[2K')
  assert.ok(failWrites.some(write => write.includes('Resuming session…')),
    `the failed resume still shows the status: ${JSON.stringify(failWrites)}`)
  assert.ok(failWrites.some(write => write === 'stdout:\r\x1b[2K'),
    `the failed resume clears the status: ${JSON.stringify(failWrites)}`)
  const clearIndexInLog = orderedLog.findIndex(write => write === 'stdout:\r\x1b[2K')
  const warnIndexInLog = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('resume missing-session failed'))
  assert.ok(clearIndexInLog >= 0 && warnIndexInLog > clearIndexInLog,
    `the status must be cleared BEFORE the failure log (clear at ${clearIndexInLog}, warn at ${warnIndexInLog}): ${JSON.stringify(orderedLog)}`)
})

test('disposing before explicit resume publication cancels startup without mounting a fallback surface', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-startup-cancel-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const resumed: FakeSession = fakeSession({
    id: 'startup-cancel-session',
    header: { id: 'startup-cancel-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  let resumeStarted!: () => void
  const resumeStartedPromise = new Promise<void>(resolve => { resumeStarted = resolve })
  let capturedSignal: AbortSignal | undefined
  const agents = harness.agents as {
    resume: (options: { resumeSessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  agents.resume = async ({ signal }) => {
    harness.resumeSignals.push(signal)
    capturedSignal = signal
    resumeStarted()
    if (signal === undefined) throw new Error('test resume did not receive a lifecycle signal')
    if (signal.aborted) throw new Error('resume cancelled')
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('resume cancelled')), { once: true })
    })
  }
  let exitCalls = 0
  const cancellationLogs: string[] = []
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        cancellationLogs.push(`${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id },
    () => { exitCalls += 1 },
  )
  await resumeStartedPromise
  assert.equal(harness.resumeSignals[0], capturedSignal)
  assert.ok(capturedSignal, 'explicit resume must receive a runner lifecycle signal')

  await fiber.dispose()
  fiber = undefined
  assert.equal(capturedSignal.aborted, true, 'fiber disposal must abort the pending resume')
  await settle()

  assert.equal(probe.apps.length, 0, 'cancelled startup must not mount a TUI')
  assert.equal(harness.createdSessions.length, 0, 'cancelled startup must not fall back to a fresh session')
  assert.equal((harness.agents as { get: (id: string) => unknown }).get(resumed.id), undefined,
    'the pre-publication fake must not publish a target Agent')
  assert.equal(exitCalls, 0, 'lifecycle cancellation must not take the fatal startup exit path')
  assert.ok(!cancellationLogs.some(log => log.includes('resume failed') || log.includes('fatal')),
    `lifecycle cancellation must not emit ordinary/fatal startup failure logs: ${JSON.stringify(cancellationLogs)}`)
  await disposeContext(context)
  context = undefined
})

test('the Preparing status stays on screen through the catalog ready barrier', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-catalog-barrier-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'slow-catalog-session',
    header: { id: 'slow-catalog-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  // A SLOW skills service: the catalog ready barrier (resolveInitialCatalog
  // → readSurfaceCatalog → readHumanSkillCatalog) takes ~300ms, so the
  // test can observe the status while the barrier is still pending.
  context.provide('skills', {
    snapshot: async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return { skills: [], complete: true }
    },
  } as never)
  // Start the mount WITHOUT awaiting: the barrier is in flight while
  // the assertions below run.
  const mountPromise = mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id, startupStatusOutput: statusOutput })
  const statusWrites = (): string[] => orderedLog
    .filter(write => write.startsWith('stdout:') && (write.includes('Preparing conversation') || write === 'stdout:\r\x1b[2K'))
    .map(write => write.slice('stdout:'.length))
  // Wait until the Preparing stage is on screen — the barrier is still
  // pending (its slow skills read has not settled yet).
  const deadline = Date.now() + 5000
  let observed = false
  while (Date.now() < deadline) {
    const writes = statusWrites()
    if (writes.some(write => write.includes('Preparing conversation'))) {
      const last = writes[writes.length - 1]!
      assert.ok(last.includes('Preparing conversation'),
        `the status must STAY on screen through the catalog barrier (last write: ${JSON.stringify(last)}): ${JSON.stringify(writes)}`)
      observed = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(observed, 'the Preparing stage must appear while the barrier is pending')
  fiber = await mountPromise
  // The fiber load settles when applyRunner returns (the startup IIFE
  // is fire-and-forget), so the mount promise resolves BEFORE the
  // barrier completes: wait for the runner to actually reach the
  // mount-time clear — the barrier resolved and the TUI is about to
  // mount.
  const deadline2 = Date.now() + 5000
  while (Date.now() < deadline2) {
    const writes = statusWrites()
    if (writes[writes.length - 1] === '\r\x1b[2K') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const writes = statusWrites()
  const last = writes[writes.length - 1]!
  assert.equal(last, '\r\x1b[2K',
    `the status must be cleared before mount: ${JSON.stringify(writes)}`)
  // Let the post-mount wiring settle before the finally disposes the
  // context (the runner's startup IIFE is fire-and-forget).
  await new Promise(resolve => setTimeout(resolve, 200))
})

test('a fresh start with a FAILING preset resolution shows only the Loader barrier status', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fresh-preset-fail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // Deferred start (no sessionId) with a BROKEN agentPresets roster:
  // every compose throws (the launch-preset fallback AND the default
  // fallback), so the catalog block's catch runs. The failure path
  // must NOT re-arm the startup status: the Loader barrier line was
  // already cleared, and no resume/preparing stage may appear.
  const harness = makeHarness(home)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async () => { throw new Error('roster broken') },
  } as never)
  fiber = await mountRunner(context, home, harness, {}, { startupStatusOutput: statusOutput })
  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2KStarting DSH…'),
    `the Loader barrier status is shown once on this path too: ${JSON.stringify(orderedLog)}`)
  assert.ok(!orderedLog.some(write => write.includes('Resuming session') || write.includes('Preparing conversation')),
    `a fresh start with a failing preset must not show the resume/preparing stages: ${JSON.stringify(orderedLog)}`)
  // The TUI still mounts (degraded — the failure is a one-shot warn).
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must still create a TuiApp')
})

test('a stalled Host Loader keeps Starting DSH… on screen with no surface and no Agent', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-barrier-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // A controllable Host Loader: the readiness barrier parks here until the
  // test releases it, exactly like a remote MCP row whose initial connect or
  // `tools/list` never answers.
  let loaderAwaited = false
  let releaseLoader!: () => void
  const loaderGate = new Promise<void>(resolve => { releaseLoader = resolve })
  const loader = {
    await: async (): Promise<void> => {
      loaderAwaited = true
      await loaderGate
    },
  }
  const resumed: FakeSession = fakeSession({
    id: 'loader-barrier-session',
    header: { id: 'loader-barrier-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    () => {},
    loader,
  )
  // The barrier is parked: the status owns the line and NOTHING downstream
  // of the barrier may have started.
  assert.equal(loaderAwaited, true, 'the runner must await the Host Loader before creating an Agent')
  assert.deepEqual(orderedLog, ['stdout:\r\x1b[2KStarting DSH…'],
    `Starting DSH… must be the only output while the Loader stalls: ${JSON.stringify(orderedLog)}`)
  assert.equal(probe.apps.length, 0, 'the TUI must not mount while the Loader is pending')
  assert.equal(harness.resumeSignals.length, 0, 'no Agent may be resumed while the Loader is pending')
  assert.equal(harness.createdSessions.length, 0, 'no Agent may be created while the Loader is pending')

  // The Loader settles: the line clears and the ordinary startup continues.
  releaseLoader()
  await settle()
  assert.equal(orderedLog[0], 'stdout:\r\x1b[2KStarting DSH…')
  assert.equal(orderedLog[1], 'stdout:\r\x1b[2K', 'the barrier line must clear as soon as the Loader settles')
  assert.equal(harness.resumeSignals.length, 1, 'the resume must proceed after the Loader settles')
  assert.equal(probe.apps.length, 1, 'the TUI must mount after the Loader settles')
})

test('an abort while the Host Loader is still pending clears the barrier status and never mounts', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-abort-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  let releaseLoader!: () => void
  const loaderGate = new Promise<void>(resolve => { releaseLoader = resolve })
  const loader = { await: async (): Promise<void> => { await loaderGate } }
  const resumed: FakeSession = fakeSession({
    id: 'loader-abort-session',
    header: { id: 'loader-abort-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    () => {},
    loader,
  )
  assert.deepEqual(orderedLog, ['stdout:\r\x1b[2KStarting DSH…'],
    `the barrier line must be the only output while the Loader stalls: ${JSON.stringify(orderedLog)}`)

  // Teardown while the barrier is parked (HMR unload / early exit): the
  // lifecycle abort must clear the pre-mount line so no stale status survives
  // into whatever owns the terminal next, and no Agent may be created.
  await disposeContext(context)
  context = undefined
  fiber = undefined
  assert.equal(orderedLog.at(-1), 'stdout:\r\x1b[2K',
    `the abort must clear the barrier status line: ${JSON.stringify(orderedLog)}`)

  // Release the parked barrier so the startup root observes the abort and
  // returns without mounting anything.
  releaseLoader()
  await settle()
  assert.equal(probe.apps.length, 0, 'an aborted startup must not mount a TUI')
  assert.equal(harness.resumeSignals.length, 0, 'an aborted startup must not resume an Agent')
  assert.equal(harness.createdSessions.length, 0, 'an aborted startup must not create an Agent')
})

test('a rejecting Host Loader clears the barrier status before the fatal log and never mounts', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-reject-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  // Status writes and the cordis fatal log share ONE ordered log: a TTY shares
  // one cursor between stdout and stderr, so the order is the contract.
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'loader-reject-session',
    header: { id: 'loader-reject-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  const exitCodes: number[] = []
  const appExit = (code?: number): void => { exitCodes.push(code ?? 0) }
  const loader = {
    await: async (): Promise<void> => { throw new Error('loader exploded') },
  }
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    appExit,
    loader,
  )
  await settle()

  const shownIndex = orderedLog.findIndex(write => write === 'stdout:\r\x1b[2KStarting DSH…')
  const clearIndex = orderedLog.findIndex((write, index) => index > shownIndex && write === 'stdout:\r\x1b[2K')
  const logIndex = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('tui-runner'))
  assert.ok(shownIndex >= 0, `the barrier status must be shown: ${JSON.stringify(orderedLog)}`)
  assert.ok(clearIndex > shownIndex,
    `a rejected Loader must still clear the barrier line: ${JSON.stringify(orderedLog)}`)
  assert.ok(logIndex > clearIndex,
    `the fatal log must be written only AFTER the barrier line is cleared: ${JSON.stringify(orderedLog)}`)
  assert.equal(probe.apps.length, 0, 'a fatal loader rejection must not mount a TUI')
  assert.equal(harness.resumeSignals.length, 0, 'the resume must never start after a rejected Loader')
  assert.equal(harness.createdSessions.length, 0, 'no Agent may be created after a rejected Loader')
  assert.deepEqual(exitCodes, [1], 'the fatal startup path must exit(1)')
})

test('a throwing status clear cannot block the fatal teardown or exit(1)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-reject-throw-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  // The status output seam throws on the ERASE-LINE write only, so the barrier
  // reports its wait and then its release fails — the failure the fatal root
  // must contain.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      if (text === '\r\x1b[2K') throw new Error('status stream exploded')
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'loader-reject-throw-session',
    header: { id: 'loader-reject-throw-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  // The discarded startup chain is a terminal boundary: a rejection escaping it
  // would surface here as an unhandled rejection (and skip exit(1)).
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  life.defer(() => { process.off('unhandledRejection', onUnhandled) })
  const exitCodes: number[] = []
  const appExit = (code?: number): void => { exitCodes.push(code ?? 0) }
  const loader = {
    await: async (): Promise<void> => { throw new Error('loader exploded') },
  }
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    appExit,
    loader,
  )
  await settle()

  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2KStarting DSH…'),
    `the barrier status must still be shown: ${JSON.stringify(orderedLog)}`)
  assert.ok(orderedLog.some(write => write.startsWith('log:') && write.includes('tui-runner')),
    `the fatal log must still be written despite the throwing clear: ${JSON.stringify(orderedLog)}`)
  assert.deepEqual(exitCodes, [1], 'the fatal path must still reach exit(1)')
  assert.deepEqual(unhandled, [], 'the discarded startup chain must not leak a rejection')
  assert.equal(probe.apps.length, 0, 'no TUI may mount')
  assert.equal(harness.resumeSignals.length, 0, 'no Agent may be resumed')
})

test('a transiently failing status erase is retried before the fatal log', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-reject-retry-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  let eraseAttempts = 0
  // The FIRST erase fails (the barrier's own clear); the retry — the fatal
  // root's clear — must actually land BEFORE the log line is written.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      if (text === '\r\x1b[2K' && (eraseAttempts += 1) === 1) throw new Error('erase exploded once')
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'loader-reject-retry-session',
    header: { id: 'loader-reject-retry-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  const exitCodes: number[] = []
  const appExit = (code?: number): void => { exitCodes.push(code ?? 0) }
  const loader = {
    await: async (): Promise<void> => { throw new Error('loader exploded') },
  }
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    appExit,
    loader,
  )
  await settle()

  const logIndex = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('tui-runner'))
  const lastEraseIndex = orderedLog.map((write, index) => write === 'stdout:\r\x1b[2K' ? index : -1).filter(index => index >= 0).at(-1)
  assert.equal(eraseAttempts, 2, `the failed erase must be retried: ${JSON.stringify(orderedLog)}`)
  assert.ok(logIndex >= 0, `the fatal log must still be written: ${JSON.stringify(orderedLog)}`)
  assert.ok(lastEraseIndex !== undefined && lastEraseIndex < logIndex,
    `the retried erase must land BEFORE the fatal log: ${JSON.stringify(orderedLog)}`)
  assert.deepEqual(exitCodes, [1], 'the fatal path must still reach exit(1)')
  assert.equal(probe.apps.length, 0, 'no TUI may mount')
})

test('a one-off erase failure on the resume-failure path is retried before the warning', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-resume-fail-retry-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  let resumingStage = false
  let resumeEraseAttempts = 0
  let injected = false
  // Fail the FIRST erase of the resume stage only. That clear is immediately
  // followed by `ctx.logger.warn`/`diag.error`, so the retry must land inside
  // the clear and therefore BEFORE the warning.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      if (text.includes('Resuming session')) resumingStage = true
      if (resumingStage && text === '\r\x1b[2K') {
        resumeEraseAttempts += 1
        if (!injected) {
          injected = true
          throw new Error('erase exploded once')
        }
      }
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const failed: FakeSession = fakeSession({
    id: 'resume-fail-retry-session',
    header: { id: 'resume-fail-retry-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('failed resume history'),
  })
  const harness = makeHarness(
    home,
    failed,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Error('boom'),
  )
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  fiber = await mountRunner(context, home, harness, { sessionId: failed.id }, { sessionId: failed.id, startupStatusOutput: statusOutput })
  await settle()

  const warnIndex = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('resume') && write.includes('failed'))
  const landedEraseIndex = orderedLog
    .map((write, index) => write === 'stdout:\r\x1b[2K' ? index : -1)
    .filter(index => index >= 0)
    .at(-1)
  assert.equal(resumeEraseAttempts, 2, `the failed resume-stage erase must be retried: ${JSON.stringify(orderedLog)}`)
  assert.ok(warnIndex >= 0, `the resume failure must still be logged: ${JSON.stringify(orderedLog)}`)
  assert.ok(landedEraseIndex !== undefined && landedEraseIndex < warnIndex,
    `the retried erase must land BEFORE the resume-failure warning: ${JSON.stringify(orderedLog)}`)
})

test('a fresh-start preset failure never re-touches the status row the barrier released', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-preset-fail-row-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusWrites: string[] = []
  // Every write is recorded; an erase would be visible here. The point of the
  // test is that the failure paths emit NONE.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      statusWrites.push(text)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // Deferred start (no sessionId) with a BROKEN agentPresets roster: the
  // preset-resolution failure and the cold catalog read both take their
  // failure branch. Measured: `Preparing conversation…` is never shown on this
  // path, and the Loader barrier's `finally` already released the row, so every
  // later `clear()` is a `!shown` no-op — it must not emit an erase that could
  // damage the failure log's line.
  const harness = makeHarness(home)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async () => { throw new Error('roster broken') },
  } as never)
  fiber = await mountRunner(context, home, harness, {}, { startupStatusOutput: statusOutput })
  await settle()
  assert.ok(probe.apps.at(-1), 'a degraded-but-mounted surface is expected on this path')
  assert.deepEqual(statusWrites, ['\r\x1b[2KStarting DSH…', '\r\x1b[2K'],
    `the barrier owns the row and the failure paths must not touch it: ${JSON.stringify(orderedLog)}`)
})

test('the exit resume hint names the Host profileContext profile, not the argv fallback', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-resume-profile-hint-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'resume-profile-hint-session',
    header: { id: 'resume-profile-hint-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  // The Host profile service a profile boot always publishes. Its name is the
  // ONLY source that is correct under every launch form: the positional
  // `dsh <name>` never appears as `--profile` in process.argv, so the argv
  // scrape answers the pi-tui fallback and would name the wrong profile.
  context.provide('profileContext', { name: 'tui-custom', home })
  // The hint has no injected output seam (unlike the startup status), so it is
  // captured through a pass-through stdout wrapper: every write still reaches
  // the test reporter, and only the resume-command line is recorded.
  const hintWrites: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    const text = String(chunk)
    if (text.includes('dsh --profile')) hintWrites.push(text)
    return (originalWrite as unknown as (chunk: unknown, ...rest: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
  } as typeof process.stdout.write
  life.defer(() => { process.stdout.write = originalWrite })
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  const hint = hintWrites.join('')
  assert.ok(hint.includes('dsh --profile tui-custom --session resume-profile-hint-session'),
    `the hint must name the Host profile: ${JSON.stringify(hintWrites)}`)
  assert.ok(!hint.includes('--profile pi-tui '),
    `the hint must not fall back to the argv default: ${JSON.stringify(hintWrites)}`)
})

test('an invalid --preset on a healthy resumed session never degrades the resume', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-resume-invalid-preset-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'resume-invalid-preset',
    header: { id: 'resume-invalid-preset', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async (id?: string) => {
      if (id === 'broken') throw new Error('agent-presets: preset "broken" not found (available: standard)')
      return { id: id ?? 'standard', trust: 'system' }
    },
    // The composition the resumed Agent mounts on (the recorded/default preset).
    mount: async () => {},
    recompose: async () => ({ id: 'standard' }),
    composedPreset: () => undefined,
    // The started resumed session refuses the launch override.
    select: async () => { throw Object.assign(new Error('session has already started; its agent preset is fixed'), { code: 'agent-preset/locked' }) },
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id, presetId: 'broken' }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the healthy resume must still mount')
  assert.ok(!probe.notices.some(notice => notice.includes('unavailable; started with the default')),
    `an invalid --preset must not degrade a healthy resume: ${JSON.stringify(probe.notices)}`)
  assert.ok(!probe.notices.some(notice => notice.includes('not applied on resume')),
    `the started-session locked override is expected, not a degradation notice: ${JSON.stringify(probe.notices)}`)
})

test('deferred-start exit retires nothing and disposes the surface only', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-deferred-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // Deferred start: no session, no agent, no handle.
  const harness = makeHarness(home)
  context = new Context()
  fiber = await mountRunner(context, home, harness, {}, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await fiber.dispose()
  fiber = undefined
  assert.deepEqual(harness.retirementEvents, [],
    'a sessionless exit must not cancel/drain/flush/dispose anything')
})
