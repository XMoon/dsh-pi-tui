/**
 * M3-4 PR3 Step 12 — Remote submission currentness/race qualification (L6).
 *
 * The race matrix from plan §28/§12, driven over the REAL runner + official
 * wire with a PARKED serializer (the park window is the writer's own
 * echo→serialize→dispatch sequence — serialize runs AFTER the official echo
 * exists and BEFORE the Host dispatch, exactly the pre-dispatch stale window
 * the plan fences).
 *
 * PRODUCTION PREREQUISITES REPRODUCED: same host/runner composition as the
 * submission L6 suite (real rc.2 Host, real in-process carrier, real Client,
 * production runner; the production serializer wrapped with a park gate).
 * TEST STAND-INS: the park gate (serializer wrapper), the held LLM adapter.
 * DELIBERATELY ABSENT: PR4 command plane; a qualified Remote shell carrier.
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-races.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import type { RemotePromptSerializer } from '../src/runtime/remote/session-writer-remote.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import { RemotePromptSerializerProduction } from '../src/runtime/remote/prompt-serializer-remote.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

class StubStreamingLlmAdapter extends (await import('@deepseek-ai/dsh-llm')).LlmAdapter {
  private gate: Promise<void> | undefined
  private openGate: (() => void) | undefined

  hold(): () => void {
    this.gate = new Promise<void>(resolve => { this.openGate = resolve })
    return () => {
      const open = this.openGate
      this.gate = undefined
      this.openGate = undefined
      open?.()
    }
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    options.signal?.throwIfAborted()
    const gate = this.gate
    if (gate !== undefined) {
      const signal = options.signal
      if (signal === undefined) {
        await gate
      } else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            cleanup()
            reject(signal.reason instanceof Error ? signal.reason : new Error('LLM stream aborted'))
          }
          const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
          signal.addEventListener('abort', onAbort, { once: true })
          gate.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
        })
      }
    }
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'remote reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'remote reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

type HostFixture = Awaited<ReturnType<typeof import('./support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>

async function mountHost(life: TestLifecycle, presetId: string, options: { readonly llmAdapter?: StubStreamingLlmAdapter } = {}) {
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  return createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: options.llmAdapter ?? new StubStreamingLlmAdapter(),
  })
}

/**
 * A production serializer wrapped with ONE park gate: the first serialize()
 * call completes only after the test releases it (the writer's own
 * echo→serialize→dispatch window is the pre-dispatch stale window).
 */
interface ParkedSerializer {
  readonly serializer: RemotePromptSerializer
  /** Arm the park: the NEXT serialize() call blocks until release(). */
  park(): void
  /** Release the parked serialize (no-op when not parked). */
  release(): void
  /** Whether a serialize() call has actually reached the park. */
  parked(): boolean
}

function parkedSerializer(): ParkedSerializer {
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  let wasParked = false
  const production = new RemotePromptSerializerProduction()
  const serializer: RemotePromptSerializer = {
    preflight: prepared => production.preflight(prepared),
    serialize: async (prepared, signal) => {
      if (gate !== undefined) {
        wasParked = true
        await gate
        gate = undefined
        open = undefined
      }
      return production.serialize(prepared, signal)
    },
  }
  return {
    serializer,
    park: () => { gate = new Promise<void>(resolve => { open = resolve }) },
    release: () => { open?.() },
    parked: () => wasParked,
  }
}

interface RaceFixture {
  host: HostFixture
  vt: VirtualTerminal
  runnerApp(): unknown
  aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  /** PR5 §3.9: drive the runner fiber's registered teardown directly. */
  runnerFiberDispose(): Promise<void>
}

async function mountRaceRunner(
  life: TestLifecycle,
  options: {
    readonly presetId?: string
    readonly resumeSessionId?: string
    readonly host?: HostFixture
    readonly serializer?: RemotePromptSerializer
  } = {},
): Promise<RaceFixture> {
  const presetId = options.presetId ?? 'm3-4-pr3-race-preset'
  const host = options.host ?? await mountHost(life, presetId)
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    ...(options.serializer === undefined ? {} : { promptSerializer: options.serializer }),
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))
  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = await import('./support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)
  const runnerCtx = host.ctx
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  runnerCtx.provide('appExit', (code: number) => { void code })
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, {
    sessionId: options.resumeSessionId,
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
  }
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never), override)
  })
  await runnerFiber
  await waitFor('race runner mount', () => vt.getViewport().join('').length > 0, 20_000)
  life.defer(() => { void runnerFiber.dispose() })
  return {
    host,
    vt,
    runnerApp: (): unknown => apps.at(-1),
    aggregate,
    runnerFiberDispose: () => runnerFiber.dispose(),
  }
}

function submitDraft(fixture: RaceFixture, text: string, request: string = 'enter'): void {
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft(text)
  app.submitDraft(request as never)
}

function hostUserRows(fixture: RaceFixture, sessionId: string): string[] {
  const session = fixture.host.ctx.sessions.get(SessionId(sessionId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => {
      const raw = event.data as {
        message?: { content?: Array<{ type: string; text?: string }> }
        content?: Array<{ type: string; text?: string }>
      }
      const content = raw.message?.content ?? raw.content ?? []
      return content.map(block => block.type === 'text' ? block.text ?? '' : '[image]').join('')
    })
}

test('L6 §12 pre-dispatch stale capture: a submission parked mid-serialize survives a Connection generation replacement by dispatching NOTHING (fenced, echo abandoned, draft restored)', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr3-race-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId('race-stale-a'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const parked = parkedSerializer()
  parked.park()
  const fixture = await mountRaceRunner(life, { presetId, resumeSessionId: 'race-stale-a', host, serializer: parked.serializer })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  // Gesture targeting A; the writer parks INSIDE serialize (the official
  // echo for A already exists; the Host prompt has NOT been dispatched).
  submitDraft(fixture, 'stale-capture marker rho')
  await waitFor('parked inside serialize', () => parked.parked(), 10_000)
  // Invalidate the parked write's transport identity WITHOUT the writer
  // barrier: a /resume transition would queue behind the parked writer
  // admission (the writer-first contract), so the plan's §28 pre-dispatch
  // stale window is driven by a CONNECTION GENERATION REPLACEMENT — the
  // official reconnect() aborts the parked generation; the writer's
  // post-serialize fence must abandon the dispatch.
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('connection generation replaced', () => {
    const id = connection.generation.getSnapshot()?.id
    return id !== undefined && id !== generationBefore
  }, 15_000)
  // Release the parked write: the stale fence must abandon it.
  parked.release()
  await new Promise(resolve => setTimeout(resolve, 2500))
  // COUNTERFACTUAL: zero durable trace of the marker (the dispatch never
  // reached the Host on ANY generation).
  assert.equal(hostUserRows(fixture, 'race-stale-a').some(row => row.includes('stale-capture marker rho')), false,
    'the stale-captured submission NEVER dispatches after the generation replacement')
  // Safe restore: the abandoned write never silently loses the user's text.
  const app = fixture.runnerApp() as unknown as { getDraft(): string }
  await waitFor('draft restored', () => app.getDraft().includes('stale-capture marker rho'), 10_000)
  // The session stays healthy on the NEW generation (the fence refused only
  // the stale write; a fresh submit dispatches normally).
  submitDraft(fixture, 'fresh after reconnect tau')
  await waitFor('fresh write after reconnect', () => hostUserRows(fixture, 'race-stale-a').some(row => row.includes('fresh after reconnect tau')), 20_000)
})

/* ── PR5 (plan §3.9): selected-runtime teardown with pending main-path work ── */

test('L6 PR5 §3.9: selected Remote runtime teardown retires the owned session BEFORE the transport disposal, with pending work and no duplicate disposal', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr3-race-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId('race-teardown-a'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  {
    const session = host.ctx.sessions.get(SessionId('race-teardown-a')) as unknown as {
      append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'u-td', role: 'user', content: [{ type: 'text', text: 'teardown probe' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'a-td', role: 'assistant', content: [{ type: 'text', text: 'TEARDOWN-COPY' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  // One pending WRITE parks inside serialize (the official echo exists, the
  // Host prompt was never dispatched) across the whole teardown window.
  const parked = parkedSerializer()
  parked.park()
  const fixture = await mountRaceRunner(life, {
    presetId,
    resumeSessionId: 'race-teardown-a',
    host,
    serializer: parked.serializer,
  })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  submitDraft(fixture, 'pending write across teardown upsilon')
  await waitFor('parked inside serialize', () => parked.parked(), 10_000)
  // Instrument the selected transport disposer (order + duplicate probes).
  // The retirement order (surface → retireOwnedSession → disposeTransport)
  // is driven by the runner fiber's registered disposal effect — the same
  // owner as every production teardown path (fiber unload / exit).
  const selected = fixture.aggregate.selected as { disposeTransport(): Promise<void> }
  let transportDisposals = 0
  const originalDispose = selected.disposeTransport.bind(selected)
  selected.disposeTransport = async (): Promise<void> => {
    transportDisposals += 1
    await originalDispose()
  }
  // Release the parked write and START the teardown together: the pending
  // work settles while the registered effect runs the ordered teardown
  // (disposeSurface → retireOwnedSession drains the pending settlement work
  // → disposeTransport). Whatever the drained write dispatched happened
  // BEFORE the transport disposal; nothing new may land after it.
  parked.release()
  await fixture.runnerFiberDispose()
  assert.equal(transportDisposals, 1,
    'the selected transport disposes exactly once through the runner teardown')
  // Post-disposal quiescence: after the transport disposal no further
  // durable row lands (the counterfactual window for a post-disposal
  // visible commit).
  const rowsAtDisposal = hostUserRows(fixture, 'race-teardown-a').length
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal(hostUserRows(fixture, 'race-teardown-a').length, rowsAtDisposal,
    'no durable row lands after the selected transport disposal (no post-disposal visible commit)')
})
