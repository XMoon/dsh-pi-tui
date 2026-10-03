/**
 * M3-4 PR3 L6 submission/writer/image/user-shell qualification: the REAL
 * runner (`applyRunnerWithRuntime` with a pre-selected Remote aggregate, now
 * with the PRODUCTION prompt serializer) over a REAL rc.2 Host Context → the
 * official in-process carrier → a real official Client — driving real user
 * gestures (editor submit) end to end.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the real rc.2 Host services (the shared `remote-application-fixture`:
 *   persistence, storage, credentials, jobs + controller, gateway, loader,
 *   presets, userQuestions, workspace, filesystem, agent loop, TokenMeter,
 *   tool-todo, title, goal projection rows)
 * - the official Client/Gateway path over the real in-process carrier
 * - the REAL runner composition root through the production selection seam,
 *   consuming the aggregate's presentation bundle
 * - the PRODUCTION Remote prompt serializer (no test stub: preflight →
 *   beginSubmission → serialize → prompt over the real wire)
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - `StubStreamingLlmAdapter`: a scripted real `LlmAdapter` (one text turn);
 *   the LLM endpoint stand-in only — the Host emits real agent events, the
 *   wire forwards them, the surface renders them
 * - deterministic image bytes and Host-only/Client-only path markers where a
 *   wrong-machine discriminator is required
 *
 * DELIBERATELY ABSENT
 * - PR4 command plane (slash-command catalog/claim) — plain prompts only
 * - generic-file upload receipts (D4): the fail-closed path is proven at L1
 *   (remote-prompt-serializer.test.ts)
 * - a qualified Remote user-shell carrier (CARRIER_GAP): the Remote shell
 *   proofs here are the FAIL-CLOSED proofs
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-submission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** The LLM endpoint stand-in (same shape as the presentation fixture's). */
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
    // Model contract = the shared fixture's agentDefaultModel: smoke/smoke.
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    options.signal?.throwIfAborted()
    const gate = this.gate
    if (gate !== undefined) {
      // The held gate honors the CALLER's cancellation (the production LLM
      // contract): an aborted request wakes the wait with the abort reason
      // instead of parking the Host teardown's whenIdle() forever.
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

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The presentation fixture's host mount (re-exported shape). */
type HostFixture = Awaited<ReturnType<typeof import('./support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>

async function mountHost(life: TestLifecycle, presetId: string, options: { readonly llmAdapter?: StubStreamingLlmAdapter } = {}) {
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const base = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: options.llmAdapter ?? new StubStreamingLlmAdapter(),
  })
  const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
  const toolTodo = await import('@deepseek-ai/dsh-tool-todo')
  await base.ctx.plugin(TokenMeter)
  await base.ctx.plugin(toolTodo, { allowParallelInProgress: false })
  const title = await import('@deepseek-ai/dsh-session-title')
  await base.ctx.plugin(title.default as never, {
    fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80,
  } as never)
  const goalUnit = await import('@deepseek-ai/dsh-goal')
  await base.ctx.plugin(goalUnit.default as never, { defaultMaxGoalRounds: 5 } as never)
  return base
}

interface Pr3Fixture {
  host: HostFixture
  vt: VirtualTerminal
  runnerApp(): unknown
  aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  dispose(): Promise<void>
}

/**
 * Mount the REAL Remote runner WITHOUT a serializer stub: the aggregate's
 * default (the production serializer) is the composition under test.
 */
async function mountPr3Runner(
  life: TestLifecycle,
  options: { readonly presetId?: string; readonly resumeSessionId?: string; readonly host?: HostFixture } = {},
): Promise<Pr3Fixture> {
  const presetId = options.presetId ?? 'm3-4-pr3-preset'
  const host = options.host ?? await mountHost(life, presetId)
  const { createRemoteApplicationRuntime } = await import('../src/app/remote/runtime.ts')
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    // NO promptSerializer: the PRODUCTION serializer composes by default.
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
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)
  const dispose = async (): Promise<void> => { await runnerFiber.dispose() }
  life.defer(dispose)
  return {
    host,
    vt,
    runnerApp: (): unknown => apps.at(-1),
    aggregate,
    dispose,
  }
}

/** Drive a real editor submit gesture through the mounted surface. */
function submitDraft(fixture: Pr3Fixture, text: string): void {
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
  app.setDraft(text)
  app.submitDraft()
}

/** Read the durable user rows the Host session log now holds (the payload
 * is either a bare message or `{message}`-wrapped depending on producer). */
function hostUserRows(fixture: Pr3Fixture, sessionId: string): string[] {
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

test('L6 §37 prompt: an idle plain prompt reaches the Host durable log through the official wire (echo → prompt → durable, no duplicate)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-plain'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  submitDraft(fixture, 'unique pr3 plain prompt alpha')
  // The durable user row is the AUTHORITATIVE settlement: exactly one row,
  // no duplicate identity (the official echo retired on it).
  await waitFor('durable user row', () => hostUserRows(fixture, mainId).some(row => row.includes('unique pr3 plain prompt alpha')), 20_000)
  const rows = hostUserRows(fixture, mainId).filter(row => row.includes('unique pr3 plain prompt alpha'))
  assert.equal(rows.length, 1, `exactly one durable row (got ${rows.length})`)
  // The official pending echo list retired (the authoritative event replaced it).
  await waitFor('official echo retired', () => {
    const pending = fixture.aggregate.presentation.submissionPresentation.snapshot(mainId)
    return pending !== undefined && pending.length === 0
  }, 15_000)
  // The stubbed model answers; the assistant row renders through the wire.
  await waitFor('assistant answer rendered', () => fixture.vt.getViewport().join('').includes('remote reply'), 20_000)
})

test('L6 §37 prompt: a sessionless first prompt creates the Session, then reaches the Host durable log', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr3-preset'
  const fixture = await mountPr3Runner(life, { presetId })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  submitDraft(fixture, 'first prompt creates the session beta')
  // The Host now owns exactly one session whose durable log carries the row.
  {
    const started = Date.now()
    for (;;) {
      const list = await fixture.aggregate.selected.backend.sessionReader.list(undefined)
      const found = list !== undefined && list.some(summary => hostUserRows(fixture, summary.id).some(row => row.includes('first prompt creates the session beta')))
      if (found) break
      if (Date.now() - started > 20_000) throw new Error('durable first row never landed (sessionless create path)')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
})

test('L6 §37 shell (Remote, CARRIER_GAP): `!` and `!!` BOTH fail closed — zero Client spawn, zero Session write, visible unavailable', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-shellgap'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const durableBefore = hostUserRows(fixture, mainId).length
  submitDraft(fixture, '!!echo client-poison-marker')
  await waitFor('unavailable notice', () => {
    return fixture.vt.getViewport().join('').includes('Host user-shell execution is unavailable')
  }, 15_000)
  submitDraft(fixture, '!echo context-poison-marker')
  await waitFor('second unavailable notice', () => {
    const view = fixture.vt.getViewport().join('')
    return view.includes('context-poison-marker') && view.includes('unavailable')
  }, 15_000)
  // ZERO execution: neither command's OUTPUT ever appears; ZERO Session write:
  // the durable user rows are unchanged (a `!` result submit never ran).
  const view = fixture.vt.getViewport().join('')
  assert.equal(view.includes('client-poison-marker\n'), false, 'the command never executed (no output body)')
  const durableAfter = hostUserRows(fixture, mainId)
  assert.equal(durableAfter.length, durableBefore,
    `zero durable user rows added by the failed-closed shell gestures (before ${durableBefore}, after ${durableAfter.length})`)
  assert.equal(durableAfter.some(row => row.includes('poison')), false,
    'no shell command or output reached the Session/model context')
})

test('L6 §37 image: known staged bytes → PromptContentPart → Host durable attachment → official readAttachment byte equality', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-image'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  // A REAL 1x1 PNG (sharp-generated; the store's admission strictly
  // verifies format/CRC) whose exact bytes are the known discriminator.
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharpPath = require.resolve('sharp', { paths: [storeDir] })
  const sharp = require(sharpPath) as { (input: unknown): { png(): { toBuffer(): Promise<Buffer> } } }
  const pngBytes = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#c0ffee' } }).png().toBuffer())
  // Stage through the PRODUCTION intake API (the same DraftImageStore.add +
  // placeholder form /image's client-local staging produces); the /image
  // COMMAND surface itself is PR4's Remote command-plane ownership — the
  // image PATH (prepare → PromptContentPart → durable → read) is what this
  // L6 proves.
  const app = await (async (): Promise<{
    getDraft(): string; setDraft(text: string): void; submitDraft(): void
    draftImageStoreForTest?: import('../src/image/draft-store.ts').DraftImageStore
  }> => {
    for (let i = 0; i < 600; i++) {
      const candidate = fixture.runnerApp() as unknown as { draftImageStoreForTest?: unknown }
      if (candidate !== undefined && candidate.draftImageStoreForTest !== undefined) return fixture.runnerApp() as never
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed draftImageStoreForTest')
  })()
  const store = app.draftImageStoreForTest!
  const staged = store.add({
    bytes: pngBytes,
    mediaType: 'image/png',
    width: 1,
    height: 1,
    name: 'pr3-proof.png',
  })
  app.setDraft(`pr3 image proof ${staged.placeholder}`)
  app.submitDraft()
  // Positive L6 image proof: the durable user row carries an image block
  // backed by a HOST attachment whose authorized read returns the SAME bytes.
  await waitFor('durable image row', () => {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    return session.snapshotEvents().some(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('image'))
  }, 20_000)
  const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  const imageEvent = session.snapshotEvents().find(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('image'))!
  // rc.2 durable user/message payload IS the message: content lives at
  // event.data.content (never .data.message.content).
  const blocks = ((imageEvent.data as { content?: unknown[] }).content ?? []) as
    Array<{ type: string; attachment?: { attachmentId?: string } }>
  const imageBlock = blocks.find(block => block.type === 'image')
  assert.ok(imageBlock?.attachment?.attachmentId !== undefined,
    'the durable row carries a Host attachment id (the image became durable)')
  // The OFFICIAL authorized read through the real Client binding.
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
    session: {
      readAttachment(attachmentId: never): Promise<
        | { ok: true; value: { data: Uint8Array } }
        | { ok: false; error: unknown }
      >
    }
  } | undefined
  assert.ok(binding !== undefined, 'the retained binding serves the official attachment read')
  const read = await binding.session.readAttachment(imageBlock.attachment!.attachmentId as never)
  assert.ok(read.ok, 'the official readAttachment must succeed')
  if (read.ok) {
    assert.deepEqual(
      Buffer.from(read.value.data).toString('hex'),
      Buffer.from(pngBytes).toString('hex'),
      'staged bytes → PromptContentPart → Host durable attachment → readAttachment BYTE EQUALITY',
    )
  }
})

test('L6 §37 queue/steer: a busy queue prompt lands as an official queued occurrence; a steer lands as steering', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-busy'
  const presetId = 'm3-4-pr3-preset'
  // A held-open first turn keeps the agent officially running.
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  // The hold's release is guaranteed cleanup (registered BEFORE any await):
  // a failing waitFor must not leave the Host teardown's whenIdle() parked on
  // the held gate (the stub itself is abort-aware; this covers the
  // non-aborted park).
  life.defer(release)
  const host = await mountHost(life, presetId, { llmAdapter: llm })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  // Open a turn (the held adapter keeps it running).
  submitDraft(fixture, 'busy opener gamma')
  await waitFor('turn is running', () => {
    return fixture.aggregate.presentation.sessionFacts.running(mainId) === true
  }, 20_000)
  // BUSY QUEUE: an explicit queue gesture while running. The AUTHORITATIVE
  // evidence is the Host's own inbox splice (the official queued echo is a
  // short-lived client intermediate and must not be a required observation):
  // the second prompt lands as a next-turn occurrence with its OWN rpcId —
  // distinct from the running turn's already-consumed opener — while the
  // first turn is STILL running (queue semantics: never steered into
  // next-step, never dropped, never duplicated).
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft('queued while busy delta')
  app.submitDraft('explicit-queue')
  const spliceOf = (marker: string): { target: string; rpcId: string } | undefined => {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      const data = JSON.stringify(event.data)
      if (data.includes(marker)) {
        const parsed = event.data as {
          target: string
          inserted?: Array<{ content?: Array<{ type: string; text?: string }>; source?: { rpcId?: string } }>
        }
        const first = parsed.inserted?.[0]
        const text = first?.content?.map(block => block.type === 'text' ? block.text ?? '' : '').join('') ?? ''
        if (text.includes(marker)) {
          return { target: parsed.target, rpcId: first?.source?.rpcId ?? '' }
        }
      }
    }
    return undefined
  }
  await waitFor('queued occurrence spliced into next-turn', () => spliceOf('queued while busy delta') !== undefined, 20_000)
  const queued = spliceOf('queued while busy delta')!
  assert.equal(queued.target, 'next-turn', 'queue semantics: the occurrence targets NEXT turn, never a steer into the running one')
  const opener = spliceOf('busy opener gamma')
  assert.ok(opener !== undefined && opener.rpcId !== '', 'the opener occurrence is identifiable by its rpcId')
  assert.notEqual(queued.rpcId, opener.rpcId, 'the queued occurrence carries its OWN identity (no duplicate request id)')
  // The held turn must STILL be running at the moment the queue landed — the
  // queued message did not wait for, steer, or end the first turn.
  assert.equal(fixture.aggregate.presentation.sessionFacts.running(mainId), true,
    'the first turn is still running while the second prompt sits queued')
  // The queued message has NOT become a durable user row yet (it awaits the
  // next turn boundary — queue, not immediate prompt).
  const durableBeforeRelease = hostUserRows(fixture, mainId)
  assert.equal(durableBeforeRelease.some(row => row.includes('queued while busy delta')), false,
    'the queued occurrence is not yet a durable user row (it belongs to the next turn)')
  // BUSY STEER: release the held turn; both turns then settle in order.
  release()
  await waitFor('turn settles', () => {
    return fixture.aggregate.presentation.sessionFacts.running(mainId) === false
  }, 20_000)
  await waitFor('queued occurrence becomes durable', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('queued while busy delta'))
  }, 20_000)
})

test('L6: a Remote submit after /resume targets the replacement current Session, never the retired Session', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId('pr3-stale-a'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId('pr3-stale-b'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: 'pr3-stale-a', host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  // PR4 §1.2: switch A -> B through the seam a REAL user drives — a /resume
  // submit through the mounted surface (the Client command registry executes
  // the TUI built-in; the Host commands service carries no TUI callback on
  // the Remote branch).
  submitDraft(fixture, '/resume pr3-stale-b')
  await waitFor('switched to B', () => {
    return fixture.vt.getViewport().join('').includes('pr3-stale-b')
      || (fixture.aggregate.presentation as unknown as { sessionFacts: { sessionStatus(id: string): unknown } }).sessionFacts.sessionStatus('pr3-stale-b') !== undefined
  }, 15_000)
  submitDraft(fixture, 'switched-session row epsilon')
  // The row lands in the session the gesture TARGETED (B)…
  await waitFor('row lands in B', () => hostUserRows(fixture, 'pr3-stale-b').some(row => row.includes('switched-session row epsilon')), 20_000)
  // …and NEVER in the retired session A. Scope note: this proves the
  // post-switch gesture uses the NEW current owner (rebind correctness), not
  // the pre-dispatch stale-capture race — that counterfactual (capture A →
  // switch → parked operation resumes → zero dispatch into EITHER session) is
  // Step 12 qualification.
  assert.equal(hostUserRows(fixture, 'pr3-stale-a').some(row => row.includes('switched-session row epsilon')), false,
    'the retired session A never receives the row addressed to B')
})

test('L6 §37 busy steer: a steer gesture while running lands as next-step with its own rpcId (never next-turn, never queued)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-steer'
  const presetId = 'm3-4-pr3-preset'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const host = await mountHost(life, presetId, { llmAdapter: llm })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  submitDraft(fixture, 'steer opener theta')
  await waitFor('turn is running', () => {
    return fixture.aggregate.presentation.sessionFacts.running(mainId) === true
  }, 20_000)
  // A REAL steer gesture: the accelerated submit chord is the PREFERENCE'S
  // OPPOSITE — busyEnter defaults to queue, so 'accelerated' resolves to
  // steer through the same composer policy the keys drive.
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft('steer while busy iota')
  app.submitDraft('accelerated')
  // AUTHORITATIVE evidence (the official echo is short-lived): the Host inbox
  // splice for the steer marker targets next-STEP (steering semantics — it
  // interrupts the running turn) with its OWN rpcId, while the first turn is
  // STILL running.
  const spliceOf = (marker: string): { target: string; rpcId: string } | undefined => {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      if (!JSON.stringify(event.data).includes(marker)) continue
      const parsed = event.data as {
        target: string
        inserted?: Array<{ content?: Array<{ type: string; text?: string }>; source?: { rpcId?: string } }>
      }
      const first = parsed.inserted?.[0]
      const text = first?.content?.map(block => block.type === 'text' ? block.text ?? '' : '').join('') ?? ''
      if (text.includes(marker)) return { target: parsed.target, rpcId: first?.source?.rpcId ?? '' }
    }
    return undefined
  }
  await waitFor('steer occurrence spliced', () => spliceOf('steer while busy iota') !== undefined, 20_000)
  const steered = spliceOf('steer while busy iota')!
  assert.equal(steered.target, 'next-step',
    'steer semantics: the occurrence targets the RUNNING turn (next-step), never next-turn (queue)')
  const opener = spliceOf('steer opener theta')
  assert.ok(opener !== undefined && opener.rpcId !== '')
  assert.notEqual(steered.rpcId, opener.rpcId, 'the steer occurrence carries its OWN identity')
  assert.equal(fixture.aggregate.presentation.sessionFacts.running(mainId), true,
    'the first turn is still running at the steer moment')
  // Release: the steered message joins the current turn's flow and settles.
  release()
  await waitFor('turn settles', () => {
    return fixture.aggregate.presentation.sessionFacts.running(mainId) === false
  }, 20_000)
  await waitFor('steer marker durable', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('steer while busy iota'))
  }, 20_000)
})

test('L6 §27 remote cancel: a real cancel gesture stops the running official turn and PRESERVES the queued next-turn work', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-cancel'
  const presetId = 'm3-4-pr3-preset'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const host = await mountHost(life, presetId, { llmAdapter: llm })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  submitDraft(fixture, 'cancel opener kappa')
  await waitFor('turn is running', () => {
    return fixture.aggregate.presentation.sessionFacts.running(mainId) === true
  }, 20_000)
  // Queue a next-turn occurrence FIRST: the cancel must stop the running
  // turn WITHOUT discarding queued work (Direct keepInbox parity).
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
  app.setDraft('queued survives cancel lambda')
  app.submitDraft('explicit-queue')
  const spliceOf = (marker: string): boolean => {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    return session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes(marker))
  }
  await waitFor('queued occurrence spliced', () => spliceOf('queued survives cancel lambda'), 20_000)
  // The REAL cancel gesture: a single Esc while the agent is busy (the
  // surface routes it to events.onCancel — the same seam cancel-activity
  // drives).
  fixture.vt.sendInput('\x1b')
  await waitFor('turn cancelled', () => {
    return fixture.aggregate.presentation.sessionFacts.running(mainId) === false
  }, 20_000)
  // AUTHORITATIVE post-cancel evidence 1/2 — the LIVE pending projection:
  // the official snapshot must still carry the queued occurrence (a durable
  // splice event alone would remain even if the cancel had destroyed the
  // live pending item — that would be self-justifying).
  await waitFor('queued occurrence live after cancel', () => {
    const pending = fixture.aggregate.selected.backend.pendingInputReader.snapshot(mainId)
    return pending !== undefined
      && pending.items.some(item => JSON.stringify(item).includes('queued survives cancel lambda'))
  }, 15_000)
  // COUNTERFACTUAL (keepInbox): a broad cancel would destroy the queued
  // occurrence as a discarded/canceled removal — the durable history must
  // contain NO such removal for this rpcId's occurrence (the rc.2 inbox
  // contract: discard = a deletion splice with outcome=canceled + an
  // agent/inbox/discarded event; none of that may exist post-cancel).
  {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    const history = session.snapshotEvents()
    assert.equal(history.some(event => event.type === 'agent/inbox/discarded'), false,
      'no inbox discard event may exist (the cancel preserved the queue)')
    const canceledRemovals = history.filter(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes('canceled'))
    assert.equal(canceledRemovals.length, 0,
      'no outcome=canceled removal splice may exist (keepInbox parity)')
  }
  // AUTHORITATIVE post-cancel evidence 2/2 — DELIVERY: release the gate
  // (the cancelled turn settles) and submit a NEW prompt; the next wake must
  // drain the PARKED preserved occurrence before/with the new one (the
  // official parked-queue semantics: preserved work resumes at the next
  // wake — this proves the item was kept, not stranded).
  release()
  await waitFor('cancelled turn settled', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('cancel opener kappa'))
  }, 20_000)
  submitDraft(fixture, 'wake after cancel mu')
  await waitFor('preserved occurrence delivered at the wake', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('queued survives cancel lambda'))
  }, 20_000)
  await waitFor('wake prompt delivered', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('wake after cancel mu'))
  }, 20_000)
})

test('L6 PR5 image resend: a SECOND submission citing the recalled durable image re-delivers the authorized bytes (mounted durable-image resend)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr5-image-resend'
  const presetId = 'm3-4-pr3-preset'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const host = await mountHost(life, presetId, { llmAdapter: llm })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharpPath = require.resolve('sharp', { paths: [storeDir] })
  const sharp = require(sharpPath) as { (input: unknown): { png(): { toBuffer(): Promise<Buffer> } } }
  const pngBytes = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#c0ffee' } }).png().toBuffer())
  const app = fixture.runnerApp() as unknown as {
    getDraft(): string; setDraft(text: string): void; submitDraft(): void
    draftImageStoreForTest?: import('../src/image/draft-store.ts').DraftImageStore
  }
  await waitFor('draft store exposed', () => app.draftImageStoreForTest !== undefined, 10_000)
  const store = app.draftImageStoreForTest!
  const sessionOf = (): { snapshotEvents(): Array<{ type: string; data: unknown }> } =>
    fixture.host.ctx.sessions.get(SessionId(mainId)) as never
  const officialRead = async (attachmentId: string): Promise<Uint8Array> => {
    const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
      session: { readAttachment(id: never): Promise<{ ok: true; value: { data: Uint8Array } } | { ok: false; error: unknown }> }
    } | undefined
    if (binding === undefined) throw new Error('no retained binding for the official attachment read')
    const read = await binding.session.readAttachment(attachmentId as never)
    if (!read.ok) throw new Error(`official readAttachment failed: ${JSON.stringify(read.error)}`)
    return read.value.data
  }
  const imageEventCount = (): number =>
    sessionOf().snapshotEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('image')).length
  const attachmentIdsOf = (): string[] => {
    const ids: string[] = []
    for (const event of sessionOf().snapshotEvents()) {
      if (event.type !== 'user/message') continue
      const blocks = ((event.data as { content?: unknown[] }).content ?? []) as
        Array<{ type: string; attachment?: { attachmentId?: string } }>
      for (const block of blocks) {
        if (block.type === 'image' && block.attachment?.attachmentId !== undefined) ids.push(block.attachment.attachmentId)
      }
    }
    return ids
  }
  // (1) FIRST submission: staged bytes → durable image → authorized read equality.
  const staged = store.add({ bytes: pngBytes, mediaType: 'image/png', width: 1, height: 1, name: 'resend-proof.png' })
  submitDraft(fixture, `resend first submit ${staged.placeholder}`)
  await waitFor('first durable image row', () => imageEventCount() >= 1, 20_000)
  const firstIds = attachmentIdsOf()
  assert.equal(firstIds.length, 1, 'exactly one attachment after the first submission')
  assert.deepEqual(
    Buffer.from(await officialRead(firstIds[0]!)).toString('hex'),
    Buffer.from(pngBytes).toString('hex'),
    '(1) the FIRST submission durably stored the image; the authorized read returns the original bytes')
  // The held stream keeps the turn officially RUNNING.
  await waitFor('the session is running (held turn)', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === true, 20_000)
  // (2) A second image-bearing submission lands in the official QUEUE (the
  // busyEnter default): its occurrence is an inbox SPLICE (next-turn),
  // carrying the durable image block.
  const staged2 = store.add({ bytes: pngBytes, mediaType: 'image/png', width: 1, height: 1, name: 'resend-second.png' })
  submitDraft(fixture, `resend queued submit ${staged2.placeholder}`)
  const queuedSpliceOf = (): { target: string; hasImage: boolean } | undefined => {
    for (const event of sessionOf().snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      if (!JSON.stringify(event.data).includes('resend queued submit')) continue
      const parsed = event.data as { target: string; inserted?: Array<{ content?: Array<{ type: string }> }> }
      const first = parsed.inserted?.[0]
      const hasImage = first?.content?.some(block => block.type === 'image') === true
      return { target: parsed.target, hasImage }
    }
    return undefined
  }
  await waitFor('the queued occurrence spliced with its image block', () => queuedSpliceOf()?.hasImage === true, 20_000)
  assert.equal(queuedSpliceOf()!.target, 'next-turn', 'the busy submission QUEUED (next-turn splice)')
  // (3) Alt+Up recall-all: pull the queued occurrence back as a RECALLED
  // draft. The recalled draft carries NO local bytes (recalledRef only) —
  // the second submission below cannot rely on any Client-local byte cache.
  fixture.vt.sendInput('\x1b[1;3A')
  await waitFor('the recalled placeholder is in the editor', () =>
    app.getDraft().includes('[image #'), 10_000)
  const draftImages = store.values()
  const recalled = draftImages.find(entry => entry.placeholder === (app.getDraft().match(/\[image #\d+[^\]]*\]/)?.[0] ?? ''))
  assert.ok(recalled !== undefined, 'the recalled draft is staged in the store')
  assert.equal(recalled.bytes.length, 0,
    'COUNTERFACTUAL: the recalled draft has NO local bytes (recalledRef only) — the resend must go through the official attachment read')
  assert.ok(recalled.recalledRef !== undefined, 'the recalled draft cites the durable attachment ref')
  // (4) SECOND submission: release the held turn first (an idle agent
  // consumes the resent line as a prompt; while running it would merely
  // queue again), then submit the recalled draft. The recalled durable
  // image re-delivers the authorized bytes through a fresh durable user row.
  release()
  await waitFor('the held turn ended (idle)', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) !== true, 20_000)
  const imageCountBeforeSecond = imageEventCount()
  app.submitDraft()
  await waitFor('the second durable image row lands', () => imageEventCount() > imageCountBeforeSecond, 20_000)
  // The LocalAttachmentStore is CONTENT-ADDRESSED: the resent block may
  // reuse the same attachment id (the acceptance is the delivered content
  // and its authorized path, not the storage id policy).
  const imageEvents = sessionOf().snapshotEvents().filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('image'))
  assert.ok(imageEvents.length >= 2,
    'the resent line produced its own durable user/message row')
  const lastImageEvent = imageEvents[imageEvents.length - 1]!
  const lastBlocks = ((lastImageEvent.data as { content?: unknown[] }).content ?? []) as
    Array<{ type: string; attachment?: { attachmentId?: string } }>
  const resentBlock = lastBlocks.find(block => block.type === 'image')
  assert.ok(resentBlock?.attachment?.attachmentId !== undefined,
    "the second submission's durable row carries an image attachment (the recalled durable image was re-delivered)")
  assert.deepEqual(
    Buffer.from(await officialRead(resentBlock!.attachment!.attachmentId!)).toString('hex'),
    Buffer.from(pngBytes).toString('hex'),
    'the SECOND submission (citing the recalled durable image) re-delivered the ORIGINAL authorized bytes through the official attachment read')
  release()
  await new Promise(resolve => setTimeout(resolve, 200))
})
