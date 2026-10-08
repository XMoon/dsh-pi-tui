/**
 * Production Remote runner L6 (owner review gate): the REAL Remote startup —
 * `applyRunnerWithRuntime` with the pre-built aggregate, its owner commit,
 * hydration and live-surface install — over the real AgentLoop, observed as the
 * OSC 7501 / OSC 9;4 bytes a terminal actually receives.
 *
 * ```text
 * dsh runner + TuiConfigSchema + RemoteApplicationOverride (production shape)
 *   -> Remote startup / owner commit / hydration / terminal-progress watch install
 *   -> real AgentLoop turn -> Host row -> private wire -> Client source -> Surface
 *   -> TuiApp -> VirtualTerminal (OSC 7501 records + OSC 9;4 state calls)
 * ```
 *
 * It also pins the owner-review P1 at the production level: a Connection
 * generation change re-installs the live surface, and the settled `done` must NOT
 * be resurrected into the new generation — the re-established watch opens on the
 * Host's current truth with `idle`, and the authority still works afterwards.
 *
 * FIXTURE MANIFEST: REAL runner composition, real aggregate, real AgentLoop, real
 * in-process carrier and the injected `VirtualTerminal`. STAND-IN: the scripted
 * LLM endpoint (the loop and its events are real). ABSENT: a real TCP transport
 * (the in-process carrier is the product's Remote path today) and GUI terminals.
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-terminal-progress.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TerminalProgressState } from '@xmoon76/pi-tui'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { createRemoteApplicationHostFixture, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const IDLE = '\x1b]7501;state=idle:app=dsh-pi-tui\x1b\\'
const WORKING = '\x1b]7501;state=working:app=dsh-pi-tui\x1b\\'
const DONE = '\x1b]7501;state=done:app=dsh-pi-tui\x1b\\'

/** A short ordered-timeline label for one OSC 7501 record. */
function programLabel(sequence: string): string {
  const match = /^\x1b\]7501;state=([^:\x1b]*)/.exec(sequence)
  return match === null ? `7501:${sequence}` : `7501:${match[1]}`
}

/** The scripted LLM endpoint: the loop and its events stay real. */
class CompletedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface RunnerProbe {
  readonly vt: VirtualTerminal
  /** Every OSC 7501 record the mounted app wrote, in order. */
  readonly program: string[]
  /** The merged 9;4 / 7501 write timeline. */
  readonly timeline: string[]
  readonly aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  submitDraft(text: string): void
}

/** Mount the REAL production Remote runner over the given Host fixture. */
async function mountRemoteRunner(
  life: TestLifecycle,
  options: { readonly presetId: string; readonly resumeSessionId: string; readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>> },
): Promise<RunnerProbe> {
  const host = options.host
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: options.resumeSessionId },
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  const vt = new VirtualTerminal(110, 32)
  const program: string[] = []
  const timeline: string[] = []
  vt.setProgress = (active: boolean) => { timeline.push(active ? '9;4:active' : '9;4:clear') }
  vt.setProgressState = (state: TerminalProgressState) => { timeline.push(`9;4:${state}`) }
  const passthrough = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) {
      program.push(match[0])
      timeline.push(programLabel(match[0]))
    }
    passthrough(data)
  }
  life.defer(installVirtualProcessTerminal(vt))

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  host.ctx.provide('appExit', (code: number) => { void code })
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  host.ctx.provide(TUI_STARTUP_SERVICE, {
    sessionId: options.resumeSessionId,
    shippedPresetRoot: host.workRoot,
  })

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
  const runnerFiber = host.ctx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never), override)
  })
  await runnerFiber
  life.defer(() => runnerFiber.dispose())
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)
  return {
    vt,
    program,
    timeline,
    aggregate,
    submitDraft(text: string): void {
      const app = apps.at(-1) as unknown as { setDraft(text: string): void; submitDraft(): void } | undefined
      assert.ok(app !== undefined, 'the mounted runner app must be captured')
      app.setDraft(text)
      app.submitDraft()
    },
  }
}

test('L6 production runner: a real Remote turn drives OSC 7501, and a reconnect never resurrects it', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rtp-runner-preset'
  const mainId = 'rtp-runner-main'
  const host = await createRemoteApplicationHostFixture(life, presetId, { llmAdapter: new CompletedAdapter() })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const runner = await mountRemoteRunner(life, { presetId, resumeSessionId: mainId, host })

  // The real startup asserted the idle baseline through the same writer.
  await waitFor('the idle acquisition', () => runner.program.length >= 1, 10_000)
  assert.equal(runner.program.at(-1), IDLE, `the Remote startup asserts idle: ${JSON.stringify(runner.program)}`)

  // A real submission: Remote submit -> Host AgentLoop -> the Host row -> the
  // private wire -> the Client source -> the mounted TuiApp -> the bytes.
  runner.submitDraft('runner progress probe')
  await waitFor('the turn settles done', () => runner.program.includes(DONE), 30_000)
  const workingAt = runner.program.indexOf(WORKING)
  const doneAt = runner.program.indexOf(DONE)
  assert.ok(workingAt >= 0 && workingAt < doneAt,
    `working precedes the settle: ${JSON.stringify(runner.program)}`)
  assert.ok(!runner.program.slice(workingAt, doneAt).includes(IDLE),
    `no idle between working and done: ${JSON.stringify(runner.program)}`)
  const activeAt = runner.timeline.indexOf('9;4:active')
  const clearAt = runner.timeline.indexOf('9;4:clear', activeAt)
  assert.ok(activeAt >= 0 && activeAt < runner.timeline.indexOf('7501:working'),
    `9;4 leads 7501 on the running edge: ${JSON.stringify(runner.timeline)}`)
  assert.ok(clearAt >= 0 && clearAt < runner.timeline.indexOf('7501:done', clearAt),
    `9;4 leads 7501 on the settle: ${JSON.stringify(runner.timeline)}`)

  // A REAL owner switch: `/new` adopts a fresh session as the main owner. The
  // retired owner's settled `done` must never be inherited by the new one.
  const doneCount = (): number => runner.program.filter(entry => entry === DONE).length
  const doneAfterFirst = doneCount()
  runner.submitDraft('/new')
  await waitFor('the new owner asserts idle', () => runner.program.at(-1) === IDLE, 30_000)
  assert.equal(doneCount(), doneAfterFirst,
    `a new owner never re-asserts the previous owner's done: ${JSON.stringify(runner.program)}`)

  // ... and the new owner drives its own real turn end to end.
  runner.submitDraft('second session probe')
  await waitFor('the new session settles done', () => doneCount() === doneAfterFirst + 1, 30_000)

  // Re-adopting the FIRST session is a NEW TUI owner over the SAME Host Agent
  // instance (its record and epoch survive the switch). Owner review P1: the
  // settled `done` belongs to the interval the OLD owner observed, so the
  // re-adopted owner must open on the Host's current truth (`idle`) instead of
  // resurrecting it.
  //
  // DISCRIMINATION NOTE: this end-to-end case pins the PRODUCTION behaviour (the
  // re-adopted owner re-asserts idle and never grows the `done` count). The
  // provenance rule itself is discriminated in `remote-terminal-progress-wire.
  // test.ts`, where the identical frame sequence asserted `done` before that fix
  // and asserts `idle` now — the two assertions are mutually exclusive.
  const doneAfterSecond = doneCount()
  runner.submitDraft(`/resume ${mainId}`)
  await waitFor('the re-adopted session asserts idle', () => runner.program.at(-1) === IDLE, 30_000)
  assert.equal(doneCount(), doneAfterSecond,
    `re-adopting a session never resurrects its settled done: ${JSON.stringify(runner.program)}`)

  // The authority is re-established for the re-adopted owner.
  runner.submitDraft('re-adopted probe')
  await waitFor('the re-adopted owner drives its own turn', () => doneCount() === doneAfterSecond + 1, 30_000)
})