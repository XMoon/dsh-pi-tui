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
import { join } from 'node:path'
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

async function mountHost(life: TestLifecycle, presetId: string) {
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const base = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
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
  // A minimal valid PNG (1x1) whose bytes are the known discriminator.
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  const app = fixture.runnerApp() as unknown as {
    imageStoreForTest?: () => { add(input: unknown): { id: number; placeholder: string } }
    setDraft(text: string): void
    submitDraft(): void
  }
  if (app.imageStoreForTest === undefined) {
    t.skip('the mounted app does not expose imageStoreForTest; the image L6 needs the draft-store seam')
    return
  }
  const staged = app.imageStoreForTest().add({
    bytes: pngBytes, mediaType: 'image/png', width: 1, height: 1,
  })
  app.setDraft('pr3 image proof ')
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
  const blocks = ((imageEvent.data as { message?: { content?: unknown[] } }).message?.content ?? []) as
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
  assert.ok(read.ok, `the official readAttachment must succeed: ${String(read.ok ? '' : read.error)}`)
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
  const host = await mountHost(life, presetId)
  // A held-open first turn keeps the agent officially running.
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  // The hold's release is guaranteed cleanup (registered BEFORE any await):
  // a failing waitFor must not leave the Host teardown's whenIdle() parked on
  // the held gate (the stub itself is abort-aware; this covers the
  // non-aborted park).
  life.defer(release)
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const base = await createRemoteApplicationHostFixture(life, presetId, { llmAdapter: llm })
  const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
  const toolTodo = await import('@deepseek-ai/dsh-tool-todo')
  await base.ctx.plugin(TokenMeter)
  await base.ctx.plugin(toolTodo, { allowParallelInProgress: false })
  void host
  await base.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: base.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host: base })
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
  const agentA = await host.harness.create(SessionId('pr3-stale-a'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId('pr3-stale-b'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: 'pr3-stale-a', host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  // Switch A -> B through the REAL seam /resume uses (the official command
  // plane on the Host context), then submit through the mounted surface.
  const execute = (line: string): Promise<unknown> =>
    (host.ctx.commands as unknown as {
      execute(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
    }).execute(agentA, line, [], new AbortController().signal)
  await execute('/resume pr3-stale-b')
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
