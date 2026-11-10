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
 * INTEGRATION SINKS
 * - one authenticated Host-owned shell stream through the real Gateway, with
 *   `!!` card-only settlement and `!` result submission to the same Host Session
 *
 * DELIBERATELY ABSENT
 * - PR4 command plane (slash-command catalog/claim) — plain prompts only
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-submission.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../../src/index.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { probeAttachment } from '../../src/client/media/attachment/intake.ts'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import { TRANSITION_FENCE_NOTICE } from '../../src/app/submission/steer.ts'
import type { RemoteApplicationOverride } from '../../src/app/application-runtime.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import type { RemotePromptSerializer } from '../../src/runtime/remote/session-writer-remote.ts'
import { RemotePromptSerializerProduction } from '../../src/runtime/remote/prompt-serializer-remote.ts'
import { createRemoteFileReceiptUploader } from '../../src/runtime/remote/file-upload-remote.ts'
import type { ExperimentalRemoteRuntime } from '../support/m3-inprocess/runtime.ts'
import { createRemoteApplicationRuntime } from '../support/m3-inprocess/application-runtime.ts'
import { waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

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
type HostFixture = Awaited<ReturnType<typeof import('../support/remote-application-fixture.ts')['createRemoteApplicationHostFixture']>>

async function mountHost(life: TestLifecycle, presetId: string, options: { readonly llmAdapter?: StubStreamingLlmAdapter } = {}) {
  const { createRemoteApplicationHostFixture } = await import('../support/remote-application-fixture.ts')
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
  // One REAL human-invocable skill in the Host composition: the official
  // skill registry is mounted once (unless the base already provides it) and a
  // runtime skill is registered before any agent/catalog read.
  if (base.ctx.get('skills') === undefined) {
    const SkillRegistry = (await import('@deepseek-ai/dsh-skill')).default
    await base.ctx.plugin(SkillRegistry, {})
  }
  base.ctx.get('skills')!.register({
    name: 'f4-l6-skill',
    description: 'F4 L6 qualification skill',
    content: 'F4_L6_SKILL_BODY_20261111',
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  })
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
  options: {
    readonly presetId?: string
    readonly resumeSessionId?: string
    readonly host?: HostFixture
    readonly buildPromptSerializer?: (wire: ExperimentalRemoteRuntime) => RemotePromptSerializer
  } = {},
): Promise<Pr3Fixture> {
  const presetId = options.presetId ?? 'm3-4-pr3-preset'
  const host = options.host ?? await mountHost(life, presetId)
  const { createRemoteApplicationRuntime } = await import('../support/m3-inprocess/application-runtime.ts')
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    // NO promptSerializer: the PRODUCTION serializer composes by default.
    // A qualification wrapper may still decorate that production serializer.
    ...(options.buildPromptSerializer === undefined ? {} : { buildPromptSerializer: options.buildPromptSerializer }),
    // The runner receives the same startup facts (M3-6 PR1).
    clientUiStartup: {
      ...(options.resumeSessionId === undefined ? {} : { sessionId: options.resumeSessionId }),
    },
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = await import('../support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)

  const runnerCtx = host.ctx
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  runnerCtx.provide('appExit', (code: number) => { void code })
  const { TUI_STARTUP_SERVICE } = await import('../../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, {
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

/** Collect the notices the mounted surface posts (the canonical prototype
 * recorder: unbound original, same function identity restored on teardown). */
function recordNotices(life: TestLifecycle, fixture: Pr3Fixture): string[] {
  void fixture
  const notices: string[] = []
  const originalNotify = TuiApp.prototype.notify
  TuiApp.prototype.notify = function patchedNotify(this: TuiApp, message: string, kind?: 'error' | 'info'): void {
    notices.push(message)
    return originalNotify.call(this, message, kind)
  }
  life.defer(() => { TuiApp.prototype.notify = originalNotify })
  return notices
}

/** The runner's own post-transition report: the production composition writes
 * `diag.info('switch ok', { from, to })` only after the committed owner's
 * surface and live catalog are ready, so it is the real completion signal a
 * user's next submit waits for. The diagnostics file lives under this
 * fixture's DSH_HOME. */
function switchReported(host: HostFixture, fromSessionId: string): boolean {
  let text: string
  try {
    text = readFileSync(join(host.workRoot, 'logs', `pi-tui-${process.pid}.log`), 'utf8')
  } catch {
    return false
  }
  // The Remote composition has no direct agent for the incoming owner, so the
  // report's `to` is undefined; the transition is identified by its SOURCE.
  return text.split('\n').some(line => line.includes('switch ok') && line.includes(`from=${fromSessionId}`))
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

test('prompt: an idle plain prompt reaches the Host durable log through the official wire (echo → prompt → durable, no duplicate)', async (t) => {
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

test('prompt negative: an empty or whitespace-only draft dispatches nothing', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr3-empty'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)

  // Count every SessionFace.prompt on the production Client Session class.
  // Install before either negative gesture; the valid control below takes the
  // same submit FIFO turn and settles after any earlier dispatch.
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never)
  assert.ok(binding !== undefined, 'the mounted Client retains the current Session binding')
  const sessionFace = binding.session
  const sessionPrototype = Object.getPrototypeOf(sessionFace) as { prompt: typeof sessionFace.prompt }
  const originalPrompt = sessionPrototype.prompt
  type PromptResult = Awaited<ReturnType<typeof originalPrompt>>
  const promptCalls: Array<{ sessionId: string; result: PromptResult | undefined }> = []
  sessionPrototype.prompt = function (this: typeof sessionFace, ...args: Parameters<typeof originalPrompt>) {
    const call = { sessionId: this.sessionId, result: undefined as PromptResult | undefined }
    promptCalls.push(call)
    return originalPrompt.call(this, ...args).then(result => {
      call.result = result
      return result
    })
  }
  life.defer(() => { sessionPrototype.prompt = originalPrompt })

  submitDraft(fixture, '')
  submitDraft(fixture, '   ')

  // A real accepted prompt is the positive completion control. Its settlement
  // drains earlier FIFO work; the durable row separately witnesses Host commit.
  submitDraft(fixture, 'after empty gamma')
  await waitFor('the real SessionFace prompt settles', () =>
    promptCalls.length === 1 && promptCalls[0]?.result !== undefined, 20_000)
  assert.equal(promptCalls[0]?.sessionId, mainId)
  assert.equal(promptCalls[0]?.result?.ok, true, 'the positive control was accepted by the official Client')
  await waitFor('the positive control reaches Host durable history', () =>
    hostUserRows(fixture, mainId).some(row => row.includes('after empty gamma')), 20_000)
  assert.equal(promptCalls.length, 1, 'empty and whitespace-only submits never call the official SessionFace.prompt')

  const rows = hostUserRows(fixture, mainId)
  assert.equal(rows.filter(row => row.includes('after empty gamma')).length, 1,
    'the positive control creates exactly one durable Host row')
  assert.equal(rows.filter(row => row.trim() === '').length, 0,
    'an empty/whitespace draft never reaches the Host')
  const pending = fixture.aggregate.presentation.submissionPresentation.snapshot(mainId) ?? []
  assert.equal(pending.some(item => item.text.trim() === ''), false,
    'no official submission echo exists for an empty draft')
})

test('prompt: a sessionless first prompt creates the Session, then reaches the Host durable log', async (t) => {
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

test('shell (Remote): `!!` settles on its card and `!` writes the drained Host result once', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f1-remote-shell-writer'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  const notices = recordNotices(life, fixture)
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const durableBefore = hostUserRows(fixture, mainId).length

  submitDraft(fixture, '!!echo remote-shell-local-marker')
  await waitFor('Remote `!!` output card', () => {
    const view = fixture.vt.getViewport().join('')
    return view.includes('remote-shell-local-marker') && view.includes('exit 0')
  }, 20_000)
  assert.equal(hostUserRows(fixture, mainId).length, durableBefore,
    '!! executes on the Host but adds no Session/model message')

  submitDraft(fixture, '!echo remote-shell-context-marker')
  await waitFor('Remote `!` Host result is serialized and accepted', () =>
    hostUserRows(fixture, mainId).some(row => row.includes('remote-shell-context-marker')) || notices.length > 0, 20_000)
  const resultRows = hostUserRows(fixture, mainId).filter(row => row.includes('remote-shell-context-marker'))
  assert.equal(resultRows.length, 1,
    `! adds exactly one Host result Session message: ${JSON.stringify(resultRows)}; notices=${JSON.stringify(notices)}`)
  assert.ok(resultRows[0]?.includes('$ echo remote-shell-context-marker'),
    `the Host writer preserves the command/result context: ${JSON.stringify(resultRows[0])}`)
  assert.deepEqual(notices, [], `Remote shell completion must not report writer/transport errors: ${JSON.stringify(notices)}`)
})

test('image: known staged bytes → PromptContentPart → Host durable attachment → official readAttachment byte equality', async (t) => {
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
    draftImageStoreForTest?: import('../../src/client/media/image/draft-store.ts').DraftImageStore
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
    Array<{ type: string; attachment?: ImageAttachmentRefLike }>
  const imageBlock = blocks.find(block => block.type === 'image')
  assert.ok(imageBlock?.attachment?.attachmentId !== undefined,
    'the durable row carries a Host attachment id (the image became durable)')
  assert.equal(imageBlock.attachment.mediaType, 'image/png',
    'the durable block carries the full reference metadata, not only the id')
  assert.equal(imageBlock.attachment.width, 1)
  assert.equal(imageBlock.attachment.height, 1)
  assert.ok(imageBlock.attachment.bytes > 0)
  // The OFFICIAL authorized read through the real Client binding, addressed by
  // the COMPLETE durable reference the persisted user/message block carries.
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
    session: {
      readAttachment(attachment: ImageAttachmentRefLike): Promise<
        | { ok: true; value: { data: Uint8Array } }
        | { ok: false; error: unknown }
      >
    }
  } | undefined
  assert.ok(binding !== undefined, 'the retained binding serves the official attachment read')
  const read = await binding.session.readAttachment(imageBlock.attachment)
  assert.ok(read.ok, 'the official readAttachment must succeed')
  if (read.ok) {
    assert.deepEqual(
      Buffer.from(read.value.data).toString('hex'),
      Buffer.from(pngBytes).toString('hex'),
      'staged bytes → PromptContentPart → Host durable attachment → readAttachment BYTE EQUALITY',
    )
  }
})

test('generic file: the real /attach intake → official receipt → Host durable file block with byte equality', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-remote-file'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)

  // The durable Host proof is the Session event; the official Host attachment
  // read is the byte authority. The Client-local source lives in a directory
  // the Host workspace does NOT contain.
  const sourceDir = life.tempDir('dsh-f4-client-source-')
  const path = join(sourceDir, 'client-only-report.bin')
  const source = Buffer.alloc(8 * 1024 * 1024)
  for (let index = 0; index < source.length; index += 1) source[index] = index % 251
  writeFileSync(path, source)
  const sourceSha256 = createHash('sha256').update(source).digest('hex')

  // Record the official beginSubmission echo input on the production Session
  // instance: the pending FILE metadata must be the Host-issued ref, never a
  // local name/size guess.
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never)
  assert.ok(binding !== undefined, 'the mounted Client retains the current Session binding')
  const sessionFace = binding.session as unknown as {
    beginSubmission(input: unknown): unknown
    prompt(...args: unknown[]): unknown
  }
  const sessionPrototype = Object.getPrototypeOf(sessionFace) as {
    beginSubmission: (this: unknown, input: unknown) => unknown
  }
  const originalBegin = sessionPrototype.beginSubmission
  const begins: unknown[] = []
  sessionPrototype.beginSubmission = function patchedBegin(this: unknown, input: unknown) {
    begins.push(input)
    return originalBegin.call(this, input)
  }
  life.defer(() => { sessionPrototype.beginSubmission = originalBegin })

  // REAL TUI intake: the /attach command stages the metadata draft and inserts
  // the canonical placeholder into the live composer.
  submitDraft(fixture, `/attach ${path}`)
  const app = fixture.runnerApp() as unknown as { getDraft(): string; submitDraft(): void }
  await waitFor('the /attach placeholder reaches the composer', () => app.getDraft().includes('[file #'), 15_000)
  app.submitDraft()

  const fileEventOf = (): { data: { content?: Array<{ type: string; attachment?: { attachmentId: string; name: string; bytes: number } }> } } | undefined => {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    return session.snapshotEvents().find(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('client-only-report.bin')) as
      { data: { content?: Array<{ type: string; attachment?: { attachmentId: string; name: string; bytes: number } }> } } | undefined
  }
  await waitFor('the Host durable user/message row carries the file block', () => fileEventOf() !== undefined, 60_000)
  const blocks = fileEventOf()!.data.content ?? []
  const fileBlock = blocks.find(block => block.type === 'file')
  assert.ok(fileBlock?.attachment?.attachmentId !== undefined,
    'the durable row carries a Host attachment id (the uploaded file became durable)')
  const ref = fileBlock!.attachment!
  assert.equal(ref.name, 'client-only-report.bin')
  assert.equal(ref.bytes, source.byteLength, 'the Host metadata describes the actual uploaded byte count')

  // G: the official echo registered the SAME Host-issued file metadata.
  const fileBegin = begins.map(input => input as {
    attachments?: Array<{ type: string; value?: { attachmentId?: string; name?: string; bytes?: number } }>
  }).find(input => input.attachments?.some(attachment => attachment.type === 'file'))
  assert.ok(fileBegin !== undefined, 'a file-bearing beginSubmission was registered')
  const echoFile = fileBegin!.attachments!.find(attachment => attachment.type === 'file')!
  assert.equal(echoFile.value?.attachmentId, ref.attachmentId,
    'the pending FILE metadata is the Host-issued attachmentId, not a local guess')
  assert.equal(echoFile.value?.name, ref.name)
  assert.equal(echoFile.value?.bytes, ref.bytes)

  // The Host's OWN attachment authority reads the stored bytes: SHA256 and
  // length must equal the Client source exactly.
  const attachments = host.ctx.get('attachments') as unknown as {
    readFileStream(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
  }
  const stored: Uint8Array[] = []
  for await (const chunk of attachments.readFileStream(ref)) stored.push(chunk)
  const storedBytes = Buffer.concat(stored.map(chunk => Buffer.from(chunk)))
  assert.equal(storedBytes.byteLength, source.byteLength)
  assert.equal(createHash('sha256').update(storedBytes).digest('hex'), sourceSha256,
    'Host stored bytes === Client source bytes (SHA256); chunk sizing is the Client streamer contract, proven at L1/L3')

  // The TUI paints the accepted file row (the durable event is the source).
  await waitFor('the file placeholder is painted in the transcript', () =>
    fixture.vt.getViewport().join('').includes('client-only-report.bin'), 30_000)
})

test('generic file: a source changed after /attach is refused with no Host prompt', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-remote-file-changed'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  const notices = recordNotices(life, fixture)
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)

  const sourceDir = life.tempDir('dsh-f4-client-changed-')
  const path = join(sourceDir, 'changed-report.bin')
  writeFileSync(path, Buffer.alloc(256 * 1024, 3))
  submitDraft(fixture, `/attach ${path}`)
  const app = fixture.runnerApp() as unknown as { getDraft(): string; setDraft(text: string): void; submitDraft(): void }
  await waitFor('the /attach placeholder reaches the composer', () => app.getDraft().includes('[file #'), 15_000)
  app.setDraft(`${app.getDraft()} F4_CHANGED_SOURCE_PROMPT`)
  // The source changes AFTER the immutable prepared snapshot's attach-time
  // fingerprint was recorded, so the submit-time read must refuse.
  writeFileSync(path, Buffer.alloc(3, 9))
  const durableBefore = (() => {
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as { snapshotEvents(): Array<{ type: string }> }
    return session.snapshotEvents().filter(event => event.type === 'user/message').length
  })()
  app.submitDraft()

  await waitFor('the changed source is visibly refused', () =>
    notices.some(notice => notice.includes('changed since it was attached')), 20_000)
  const durableAfter = (() => {
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as { snapshotEvents(): Array<{ type: string; data: unknown }> }
    return session.snapshotEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('F4_CHANGED_SOURCE_PROMPT')).length
  })()
  assert.equal(durableAfter, 0, 'a changed source never produces a durable Host prompt')
  assert.equal(app.getDraft().includes('F4_CHANGED_SOURCE_PROMPT'), true,
    'the refused draft is restored for the user')
  assert.equal(durableBefore, 0)
})

test('mixed file/image prompt: both file receipts and the image keep their source order in the Host row', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-remote-file-mixed'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const app = fixture.runnerApp() as unknown as {
    getDraft(): string
    setDraft(text: string): void
    submitDraft(): void
    draftImageStoreForTest?: import('../../src/client/media/image/draft-store.ts').DraftImageStore
    draftFileStoreForTest?: import('../../src/client/media/attachment/file-draft.ts').DraftFileStore
  }
  assert.ok(app.draftFileStoreForTest !== undefined, 'the mounted app exposes its live file draft store')
  assert.ok(app.draftImageStoreForTest !== undefined, 'the mounted app exposes its live image draft store')
  const fileStore = app.draftFileStoreForTest!
  const imageStore = app.draftImageStoreForTest!
  const sourceDir = life.tempDir('dsh-f4-mixed-l6-')

  const stagedFiles: { placeholder: string; bytes: Buffer }[] = []
  for (const [name, seed] of [['mix-a.bin', 3], ['mix-b.bin', 5]] as const) {
    const path = join(sourceDir, name)
    const bytes = Buffer.alloc(80 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index + seed) % 239
    writeFileSync(path, bytes)
    const probe = await probeAttachment(path, sourceDir)
    assert.equal(probe.kind, 'file')
    if (probe.kind !== 'file') return
    const draft = fileStore.add({
      name: probe.name,
      byteLength: probe.byteLength,
      source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
    })
    stagedFiles.push({ placeholder: draft.placeholder, bytes })
  }
  const pngBytes = await d12PngBytes()
  const stagedImage = imageStore.add({
    bytes: pngBytes,
    mediaType: 'image/png',
    width: 1,
    height: 1,
    name: 'mixed-image.png',
  })

  const marker = 'F4_MIXED_FILE_IMAGE_20261111'
  app.setDraft(`${stagedFiles[0]!.placeholder} middle ${stagedImage.placeholder} ${stagedFiles[1]!.placeholder} tail ${marker}`)
  app.submitDraft()

  const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  await waitFor('the mixed row is durable', () => session.snapshotEvents().some(event =>
    event.type === 'user/message' && JSON.stringify(event.data).includes(marker)), 30_000)
  const durable = session.snapshotEvents().find(event =>
    event.type === 'user/message' && JSON.stringify(event.data).includes(marker))!
  const content = (durable.data as { content: Array<{ type: string; text?: string; attachment?: { attachmentId?: string; width?: number; height?: number } }> }).content
  assert.deepEqual(content.map(block => block.type),
    ['file', 'text', 'image', 'text', 'file', 'text'],
    'the source order (file → text → image → text → file → text) reaches the Host unchanged')
  assert.equal(content[1]?.text, ' middle ')
  assert.equal(content[5]?.text, ` tail ${marker}`)
  const attachments = host.ctx.get('attachments') as unknown as {
    readFileStream(ref: unknown): AsyncIterable<Uint8Array>
  }
  for (const [blockIndex, source] of [[0, stagedFiles[0]!.bytes], [4, stagedFiles[1]!.bytes]] as const) {
    const ref = content[blockIndex]!.attachment
    assert.ok(ref?.attachmentId !== undefined, 'each file block carries its Host attachment')
    const chunks: Uint8Array[] = []
    for await (const chunk of attachments.readFileStream(ref)) chunks.push(chunk)
    assert.deepEqual(
      Buffer.from(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))),
      source,
      'each file keeps its own uploaded bytes in the mixed prompt',
    )
  }
  assert.equal(content[2]?.attachment?.width, 1, 'the image block keeps its real dimensions')
  assert.equal(content[2]?.attachment?.height, 1)
})

test('a human-invocable skill prompt carries its file through the same official writer', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-remote-skill-file'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const app = fixture.runnerApp() as unknown as {
    getDraft(): string
    setDraft(text: string): void
    submitDraft(): void
    draftFileStoreForTest?: import('../../src/client/media/attachment/file-draft.ts').DraftFileStore
  }
  assert.ok(app.draftFileStoreForTest !== undefined, 'the mounted app exposes its live file draft store')
  const sourceDir = life.tempDir('dsh-f4-skill-l6-')
  const path = join(sourceDir, 'skill-file.bin')
  const source = Buffer.alloc(72 * 1024)
  for (let index = 0; index < source.length; index += 1) source[index] = (index + 13) % 233
  writeFileSync(path, source)
  const probe = await probeAttachment(path, sourceDir)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const draft = app.draftFileStoreForTest!.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const marker = 'F4_SKILL_FILE_L6_20261111'
  app.setDraft(`/skill f4-l6-skill ${draft.placeholder} ${marker}`)
  app.submitDraft()
  const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  await waitFor('the skill file row is durable', () => session.snapshotEvents().some(event => {
    if (event.type !== 'user/message') return false
    const content = (event.data as { content?: Array<{ type: string; text?: string }> }).content ?? []
    return content.some(block => block.type === 'file') && JSON.stringify(event.data).includes(marker)
  }), 30_000)
  const durable = session.snapshotEvents().find(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(marker))!
  const content = (durable.data as { content: Array<{ type: string; text?: string; attachment?: { attachmentId?: string; bytes?: number } }> }).content
  const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  assert.match(text, /\/f4-l6-skill\b/u,
    `the durable row is the agent-facing skill line, not a raw /skill wrapper: ${JSON.stringify(text)}`)
  assert.ok(text.includes(marker), 'the user arguments survive the normalized skill line')
  const fileBlock = content.find(block => block.type === 'file')
  assert.ok(fileBlock?.attachment?.attachmentId !== undefined,
    'the skill prompt carries the Host-issued file attachment')
  assert.equal(fileBlock!.attachment!.bytes, source.byteLength)
  const attachments = host.ctx.get('attachments') as unknown as {
    readFileStream(ref: unknown): AsyncIterable<Uint8Array>
  }
  const chunks: Uint8Array[] = []
  for await (const chunk of attachments.readFileStream(fileBlock!.attachment!)) chunks.push(chunk)
  assert.equal(
    createHash('sha256').update(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).digest('hex'),
    createHash('sha256').update(source).digest('hex'),
    'the skill file bytes are the Client source bytes',
  )
})

test('surface stop after the file upload but before dispatch makes zero prompt and restores the draft', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-remote-file-stop'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  // The qualification wrapper holds the PRODUCTION serializer right AFTER the
  // official upload returned a receipt and BEFORE the writer's dispatch fence.
  let uploaded = false
  let releaseDispatch!: () => void
  const dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve })
  life.defer(releaseDispatch)
  const fixture = await mountPr3Runner(life, {
    presetId,
    resumeSessionId: mainId,
    host,
    buildPromptSerializer: (wire: ExperimentalRemoteRuntime): RemotePromptSerializer => {
      const production = RemotePromptSerializerProduction.overSessions(
        wire.client.sessions,
        createRemoteFileReceiptUploader(wire.host.carrier.fetch),
      )
      return {
        preflight: prepared => production.preflight(prepared),
        async serialize(prepared, signal) {
          const serialized = await production.serialize(prepared, signal)
          if (serialized.kind === 'ok') {
            uploaded = true
            await dispatchGate
          }
          return serialized
        },
      }
    },
  })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const app = fixture.runnerApp() as unknown as {
    getDraft(): string
    setDraft(text: string): void
    submitDraft(): void
    draftFileStoreForTest?: import('../../src/client/media/attachment/file-draft.ts').DraftFileStore
  }
  assert.ok(app.draftFileStoreForTest !== undefined, 'the mounted app exposes its live file draft store')
  const sourceDir = life.tempDir('dsh-f4-stop-')
  const path = join(sourceDir, 'stop.bin')
  writeFileSync(path, Buffer.alloc(32 * 1024, 4))
  const probe = await probeAttachment(path, sourceDir)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const draft = app.draftFileStoreForTest!.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const marker = 'F4_SURFACE_STOP_20261111'
  app.setDraft(`${draft.placeholder} ${marker}`)
  // Count the official SessionFace.prompt on the production Client binding.
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never)
  assert.ok(binding !== undefined)
  const prototype = Object.getPrototypeOf(binding.session) as {
    prompt(...args: unknown[]): unknown
  }
  const originalPrompt = prototype.prompt
  let promptCalls = 0
  prototype.prompt = function patchedPrompt(this: unknown, ...args: unknown[]) {
    promptCalls += 1
    return originalPrompt.apply(this, args)
  }
  life.defer(() => { prototype.prompt = originalPrompt })
  const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  app.submitDraft()
  // Handshake: the official Host upload completed and the serializer is parked
  // before dispatch. Any prompt from here would violate the surface fence.
  await waitFor('the Host file upload completed before dispatch', () => uploaded, 20_000)
  assert.equal(promptCalls, 0, 'the prompt is still held after the upload and before dispatch')
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(marker)).length, 0,
  'an uploaded-but-undispatched file is not a Host prompt yet')
  const stopSurfaceAdmission = fixture.aggregate.selected.stopSurfaceAdmission
  assert.ok(stopSurfaceAdmission !== undefined, 'the Remote selection exposes the surface-stop admission')
  stopSurfaceAdmission()
  releaseDispatch()
  // The submission settles through the writer's post-serialize fence: the
  // draft returns and the official prompt is never called.
  await waitFor('the stopped submission restores the draft', () => app.getDraft().includes(marker), 20_000)
  for (let round = 0; round < 50; round += 1) await Promise.resolve()
  assert.equal(promptCalls, 0, 'a surface stop after upload dispatches zero prompts')
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(marker)).length, 0,
  'the stopped surface leaves no durable prompt')
})

test('multi-file submission: a later source failure sends no prompt and restores both placeholders', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-remote-file-partial'
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  const notices = recordNotices(life, fixture)
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const app = fixture.runnerApp() as unknown as {
    getDraft(): string
    setDraft(text: string): void
    submitDraft(): void
    draftFileStoreForTest?: import('../../src/client/media/attachment/file-draft.ts').DraftFileStore
  }
  assert.ok(app.draftFileStoreForTest !== undefined, 'the mounted app exposes its live file draft store')
  const fileStore = app.draftFileStoreForTest!
  const sourceDir = life.tempDir('dsh-f4-partial-l6-')
  const placeholders: string[] = []
  const paths: string[] = []
  for (const name of ['partial-a.bin', 'partial-b.bin']) {
    const path = join(sourceDir, name)
    writeFileSync(path, Buffer.alloc(64 * 1024, 6))
    paths.push(path)
    const probe = await probeAttachment(path, sourceDir)
    assert.equal(probe.kind, 'file')
    if (probe.kind !== 'file') return
    const draft = fileStore.add({
      name: probe.name,
      byteLength: probe.byteLength,
      source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
    })
    placeholders.push(draft.placeholder)
  }
  const marker = 'F4_PARTIAL_MULTI_FILE_20261111'
  app.setDraft(`${placeholders[0]!} ${placeholders[1]!} ${marker}`)
  // The SECOND file changes: the first upload may already be staged on the
  // Host, but the Prompt must never be sent and both placeholders must return.
  writeFileSync(paths[1]!, Buffer.alloc(3, 9))
  const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  app.submitDraft()
  await waitFor('the partial multi-file failure is visible', () =>
    notices.some(notice => notice.includes('changed since it was attached')), 20_000)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(marker)).length, 0,
  'no partial multi-file prompt is dispatched')
  const restored = app.getDraft()
  assert.ok(restored.includes(placeholders[0]!) && restored.includes(placeholders[1]!)
    && restored.includes(marker), `both placeholders and the text are restored: ${JSON.stringify(restored)}`)
})

test('queue/steer: a busy queue prompt lands as an official queued occurrence; a steer lands as steering', async (t) => {
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

test('a submit inside a session transition is refused, keeps the draft and dispatches nothing', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId('pr3-transition-a'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId('pr3-transition-b'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: 'pr3-transition-a', host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  const notices = recordNotices(life, fixture)
  // The switch transaction keeps its writer fence closed until the committed
  // owner's surface and live catalog are ready. Parking the surface hydration
  // makes that window REAL instead of a timing guess, so this proof covers the
  // refusal contract without racing the settle: a submit inside the window must
  // be refused with the product notice, keep the draft, and dispatch nothing.
  const presentationSource = fixture.aggregate.presentation as unknown as {
    presentationReader: { read(sessionId: string, signal: AbortSignal): Promise<unknown> }
  }
  const originalRead = presentationSource.presentationReader.read
  let parked = 0
  let releaseHydration: (() => void) | undefined
  presentationSource.presentationReader.read = function parkedRead(
    this: unknown, sessionId: string, signal: AbortSignal,
  ): Promise<unknown> {
    parked += 1
    return new Promise((resolve, reject) => {
      releaseHydration = () => {
        presentationSource.presentationReader.read = originalRead
        originalRead.call(this, sessionId, signal).then(resolve, reject)
      }
    })
  }
  life.defer(() => {
    presentationSource.presentationReader.read = originalRead
    releaseHydration?.()
  })
  // PR-C: direct `/resume` now waits for its tracked settlement, so start the
  // same transition through the Browser selection (a non-FIFO navigation)
  // while keeping the hydration fence real.
  submitDraft(fixture, '/sessions')
  await waitFor('the Session Workspace is open', () => fixture.vt.getViewport().join('\n').includes('Sessions'), 15_000)
  // The fullscreen workspace never consumes printable bytes in the list seat:
  // `/` focuses the global editor, the raw query paints there, and the safe
  // two-Enter contract (results, then resume) is the only navigation path.
  fixture.vt.sendInput('/')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('pr3-transition-b')
  // The editor echoes the raw query immediately; the metadata RESULT row is
  // the fact this step needs (the safe two-Enter contract only advances once
  // the read owner has accepted a matching row).
  await waitFor('the target row is filtered', () => {
    const view = fixture.vt.getViewport().join('\n')
    return view.includes('pr3-transition-b') && view.includes('metadata')
  }, 15_000)
  fixture.vt.sendInput('\r')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\r')
  await waitFor('the transition committed and parked its surface hydration', () => parked >= 1, 15_000)
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void; getDraft(): string }
  app.setDraft('fenced transition draft zeta')
  app.submitDraft()
  await waitFor('the transition fence notice', () => notices.includes(TRANSITION_FENCE_NOTICE), 10_000)
  assert.equal(app.getDraft(), 'fenced transition draft zeta',
    'the refused submit keeps the user draft in the editor')
  assert.equal(hostUserRows(fixture, 'pr3-transition-a').length, 0,
    'a fenced submit dispatches nothing into the retired session')
  assert.equal(hostUserRows(fixture, 'pr3-transition-b').length, 0,
    'a fenced submit dispatches nothing into the incoming session')
  releaseHydration?.()
  await waitFor('the switch transaction reports completion', () => switchReported(host, 'pr3-transition-a'), 20_000)
  await waitFor('the post-transition paint settled', () => fixture.vt.getViewport().join('').includes('pr3-transition-b'), 20_000)
  assert.equal(hostUserRows(fixture, 'pr3-transition-b').length, 0,
    'a fenced submit is never dispatched later, once the transaction settles')
  assert.equal(hostUserRows(fixture, 'pr3-transition-a').length, 0,
    'the retired session stays untouched after the settle')
})

test('a Remote submit after /resume targets the replacement current Session, never the retired Session', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr3-preset'
  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId('pr3-stale-a'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId('pr3-stale-b'), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: 'pr3-stale-a', host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  // Patch the actual official SessionFace prototype before B is materialized.
  // The production Remote writer uses this ClientSessions binding source for
  // both A and the replacement B; the original method keeps its real receiver.
  const bindingA = fixture.aggregate.wire.client.sessions.binding(SessionId('pr3-stale-a') as never)
  assert.ok(bindingA !== undefined, 'the mounted Client retains Session A')
  const sessionFace = bindingA.session
  const sessionPrototype = Object.getPrototypeOf(sessionFace) as { prompt: typeof sessionFace.prompt }
  const originalPrompt = sessionPrototype.prompt
  type PromptResult = Awaited<ReturnType<typeof originalPrompt>>
  const promptCalls: Array<{ sessionId: string; result: PromptResult | undefined }> = []
  sessionPrototype.prompt = function (this: typeof sessionFace, ...args: Parameters<typeof originalPrompt>) {
    const call = { sessionId: this.sessionId, result: undefined as PromptResult | undefined }
    promptCalls.push(call)
    return originalPrompt.call(this, ...args).then(result => {
      call.result = result
      return result
    })
  }
  life.defer(() => { sessionPrototype.prompt = originalPrompt })
  // PR4 §1.2: switch A -> B through the seam a REAL user drives — a /resume
  // submit through the mounted surface (the Client command registry executes
  // the TUI built-in; the Host commands service carries no TUI callback on
  // the Remote branch).
  submitDraft(fixture, '/resume pr3-stale-b')
  // The runner reports the switch only after the committed owner's surface and
  // live catalog are ready — the product's own completion signal, i.e. exactly
  // what a real user waits for before pressing Enter again.
  await waitFor('the switch transaction reports completion', () => switchReported(host, 'pr3-stale-a'), 20_000)
  assert.equal(promptCalls.length, 0, '/resume changes the current Session without sending a prompt')
  // ONE submit after that signal, without retrying: the post-transition submit
  // contract is "dispatch exactly once into the new current owner".
  submitDraft(fixture, 'switched-session row epsilon')
  await waitFor('the single replacement SessionFace prompt settles', () =>
    promptCalls.length === 1 && promptCalls[0]?.result !== undefined, 20_000)
  assert.equal(promptCalls[0]?.sessionId, 'pr3-stale-b',
    'the official prompt call is addressed to the replacement Session B')
  assert.equal(promptCalls[0]?.result?.ok, true,
    'the official prompt settles with Host acceptance')
  assert.equal(promptCalls.length, 1, 'one post-switch submit invokes SessionFace.prompt exactly once')
  const inB = (): number => hostUserRows(fixture, 'pr3-stale-b').filter(row => row.includes('switched-session row epsilon')).length
  await waitFor('the single post-switch submit reaches B durable history', () => inB() === 1, 20_000)
  assert.equal(inB(), 1, 'the post-switch submit creates exactly one durable row in B')
  // …and NEVER in the retired session A. Scope note: this proves the
  // post-switch gesture uses the NEW current owner (rebind correctness), not
  // the pre-dispatch stale-capture race — that counterfactual (capture A →
  // switch → parked operation resumes → zero dispatch into EITHER session) is
  // Step 12 qualification.
  assert.equal(hostUserRows(fixture, 'pr3-stale-a').filter(row => row.includes('switched-session row epsilon')).length, 0,
    'the retired session A never receives the row addressed to B')
})


test('busy steer: a steer gesture while running lands as next-step with its own rpcId (never next-turn, never queued)', async (t) => {
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

test('busy steer with a file: the steered occurrence carries the Host file block into next-step and the durable row', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-f4-busy-file-steer'
  const presetId = 'm3-4-pr3-preset'
  const llm = new StubStreamingLlmAdapter()
  const release = llm.hold()
  life.defer(release)
  const host = await mountHost(life, presetId, { llmAdapter: llm })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountPr3Runner(life, { presetId, resumeSessionId: mainId, host })
  await waitFor('mount paint', () => fixture.vt.getViewport().join('').length > 0, 10_000)
  submitDraft(fixture, 'file steer opener')
  await waitFor('turn is running', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === true, 20_000)

  const sourceDir = life.tempDir('dsh-f4-busy-file-')
  const path = join(sourceDir, 'steer-file.bin')
  const source = Buffer.alloc(96 * 1024)
  for (let index = 0; index < source.length; index += 1) source[index] = index % 241
  writeFileSync(path, source)
  const app = fixture.runnerApp() as unknown as { getDraft(): string; setDraft(text: string): void; submitDraft(request?: string): void }
  submitDraft(fixture, `/attach ${path}`)
  await waitFor('the /attach placeholder reaches the composer', () => app.getDraft().includes('[file #'), 15_000)
  const marker = 'F4_BUSY_STEER_FILE_20261111'
  app.setDraft(`${app.getDraft()} ${marker}`)
  app.submitDraft('accelerated')

  const sessionOf = (): { snapshotEvents(): Array<{ type: string; data: unknown }> } =>
    host.ctx.sessions.get(SessionId(mainId)) as unknown as { snapshotEvents(): Array<{ type: string; data: unknown }> }
  const spliceOf = (needle: string): { target: string; file: boolean } | undefined => {
    for (const event of sessionOf().snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      if (!JSON.stringify(event.data).includes(needle)) continue
      const parsed = event.data as { target: string; inserted?: Array<{ content?: Array<{ type: string }> }> }
      return {
        target: parsed.target,
        file: parsed.inserted?.[0]?.content?.some(block => block.type === 'file') === true,
      }
    }
    return undefined
  }
  await waitFor('the steered file occurrence is spliced', () => spliceOf(marker)?.file === true, 20_000)
  assert.equal(spliceOf(marker)!.target, 'next-step',
    'a file-bearing steer targets the RUNNING turn, exactly like its text-only sibling')
  // Alt+Up on a queue holding a durable FILE: Remote refuses BEFORE any
  // recalled draft or queue removal, and the running turn keeps its queue.
  const queuePath = join(sourceDir, 'queued-file.bin')
  writeFileSync(queuePath, Buffer.alloc(48 * 1024, 7))
  const queueMarker = 'F4_BUSY_QUEUED_FILE_20261111'
  submitDraft(fixture, `/attach ${queuePath}`)
  await waitFor('the queued /attach placeholder reaches the composer', () => app.getDraft().includes('[file #'), 15_000)
  app.setDraft(`${app.getDraft()} ${queueMarker}`)
  app.submitDraft('explicit-queue')
  await waitFor('the queued file occurrence is spliced', () => spliceOf(queueMarker)?.file === true, 20_000)
  assert.equal(spliceOf(queueMarker)!.target, 'next-turn',
    'the explicit-queue file gesture appends a next-turn occurrence')
  fixture.vt.sendInput('\x1b[1;3A')
  await waitFor('the file queue pull-back is refused visibly', () =>
    fixture.vt.getViewport().join('').includes('cannot rebind its upload receipt'), 20_000)
  assert.equal(app.getDraft(), '', 'the refused recall never injects a recalled draft')
  assert.equal(spliceOf(queueMarker)?.file, true, 'the Host queue keeps its file occurrence')

  release()
  await waitFor('turn settles', () =>
    fixture.aggregate.presentation.sessionFacts.running(mainId) === false, 20_000)
  await waitFor('the steered file row is durable', () =>
    hostUserRows(fixture, mainId).some(row => row.includes(marker)), 20_000)
  const durable = sessionOf().snapshotEvents().find(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(marker)) as unknown as {
      data: { content: Array<{ type: string; attachment?: { attachmentId: string; name: string; bytes: number } }> }
    }
  const fileBlock = durable.data.content.find(block => block.type === 'file')
  assert.ok(fileBlock?.attachment?.attachmentId !== undefined,
    'the steered durable row carries the Host-issued file attachment')
  assert.equal(fileBlock!.attachment!.bytes, source.byteLength)
  const attachments = host.ctx.get('attachments') as unknown as {
    readFileStream(ref: unknown): AsyncIterable<Uint8Array>
  }
  const stored: Uint8Array[] = []
  for await (const chunk of attachments.readFileStream(fileBlock!.attachment!)) stored.push(chunk)
  assert.equal(
    createHash('sha256').update(Buffer.concat(stored.map(chunk => Buffer.from(chunk)))).digest('hex'),
    createHash('sha256').update(source).digest('hex'),
    'the steered file bytes are the Client source bytes',
  )
  // The preserved queue occurrence is delivered AFTER the running turn and
  // carries its own Host file attachment.
  await waitFor('the queued file row is durable', () =>
    hostUserRows(fixture, mainId).some(row => row.includes(queueMarker)), 30_000)
  const queuedDurable = sessionOf().snapshotEvents().find(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(queueMarker)) as unknown as {
      data: { content: Array<{ type: string; attachment?: { attachmentId: string; bytes: number } }> }
    }
  const queuedFileBlock = queuedDurable.data.content.find(block => block.type === 'file')
  assert.ok(queuedFileBlock?.attachment?.attachmentId !== undefined,
    'the preserved queued file occurrence reaches the Host durable row')
  assert.equal(queuedFileBlock!.attachment!.bytes, 48 * 1024)
})

test('remote cancel: a real cancel gesture stops the running official turn and PRESERVES the queued next-turn work', async (t) => {
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
  app.setDraft('queued second nu')
  app.submitDraft('explicit-queue')
  const spliceOf = (marker: string): boolean => {
    const session = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    return session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes(marker))
  }
  await waitFor('queued occurrence spliced', () => spliceOf('queued survives cancel lambda'), 20_000)
  await waitFor('second queued occurrence spliced', () => spliceOf('queued second nu'), 20_000)
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
  const sessionForTurns = fixture.host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string }>
  }
  const turnsBeforeWake = sessionForTurns.snapshotEvents().filter(event => event.type === 'turn/start').length
  submitDraft(fixture, 'wake after cancel mu')
  await waitFor('preserved occurrence delivered at the wake', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('queued survives cancel lambda'))
  }, 20_000)
  await waitFor('wake prompt delivered', () => {
    return hostUserRows(fixture, mainId).some(row => row.includes('wake after cancel mu'))
  }, 20_000)
  const rowsAfterWake = hostUserRows(fixture, mainId)
  const first = rowsAfterWake.findIndex(row => row.includes('queued survives cancel lambda'))
  const second = rowsAfterWake.findIndex(row => row.includes('queued second nu'))
  assert.ok(first >= 0 && second >= 0, 'both preserved queued rows must be delivered')
  assert.ok(first < second, 'the preserved queue must drain in FIFO order')
  assert.equal(rowsAfterWake.filter(row => row.includes('queued survives cancel lambda')).length, 1,
    'the first queued occurrence is consumed exactly once')
  assert.equal(rowsAfterWake.filter(row => row.includes('queued second nu')).length, 1,
    'the second queued occurrence is consumed exactly once')
  const turnsAfterWake = sessionForTurns.snapshotEvents().filter(event => event.type === 'turn/start').length
  // The wake delivers exactly the two preserved queued messages plus the real
  // prompt; each delivered message starts one Turn and nothing else does.
  assert.equal(turnsAfterWake - turnsBeforeWake, 3,
    'the wake produces exactly one Turn per delivered message (no extra/synthetic Turn)')
})

test('image resend: a SECOND submission citing the recalled durable image re-delivers the authorized bytes (mounted durable-image resend)', async (t) => {
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
    draftImageStoreForTest?: import('../../src/client/media/image/draft-store.ts').DraftImageStore
  }
  await waitFor('draft store exposed', () => app.draftImageStoreForTest !== undefined, 10_000)
  const store = app.draftImageStoreForTest!
  const sessionOf = (): { snapshotEvents(): Array<{ type: string; data: unknown }> } =>
    fixture.host.ctx.sessions.get(SessionId(mainId)) as never
  const officialRead = async (attachment: ImageAttachmentRefLike): Promise<Uint8Array> => {
    const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
      session: {
        readAttachment(attachment: ImageAttachmentRefLike): Promise<
          { ok: true; value: { data: Uint8Array } } | { ok: false; error: unknown }
        >
      }
    } | undefined
    if (binding === undefined) throw new Error('no retained binding for the official attachment read')
    const read = await binding.session.readAttachment(attachment)
    if (!read.ok) throw new Error(`official readAttachment failed: ${JSON.stringify(read.error)}`)
    return read.value.data
  }
  const imageEventCount = (): number =>
    sessionOf().snapshotEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('image')).length
  /** The COMPLETE durable references of every image block (never bare ids). */
  const attachmentRefsOf = (): ImageAttachmentRefLike[] => {
    const refs: ImageAttachmentRefLike[] = []
    for (const event of sessionOf().snapshotEvents()) {
      if (event.type !== 'user/message') continue
      const blocks = ((event.data as { content?: unknown[] }).content ?? []) as
        Array<{ type: string; attachment?: ImageAttachmentRefLike }>
      for (const block of blocks) {
        if (block.type === 'image' && block.attachment?.attachmentId !== undefined) refs.push(block.attachment)
      }
    }
    return refs
  }
  // (1) FIRST submission: staged bytes → durable image → authorized read equality.
  const staged = store.add({ bytes: pngBytes, mediaType: 'image/png', width: 1, height: 1, name: 'resend-proof.png' })
  submitDraft(fixture, `resend first submit ${staged.placeholder}`)
  await waitFor('first durable image row', () => imageEventCount() >= 1, 20_000)
  const firstRefs = attachmentRefsOf()
  assert.equal(firstRefs.length, 1, 'exactly one attachment after the first submission')
  assert.deepEqual(
    Buffer.from(await officialRead(firstRefs[0]!)).toString('hex'),
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
    Array<{ type: string; attachment?: ImageAttachmentRefLike }>
  const resentBlock = lastBlocks.find(block => block.type === 'image')
  assert.ok(resentBlock?.attachment?.attachmentId !== undefined,
    "the second submission's durable row carries an image attachment (the recalled durable image was re-delivered)")
  assert.deepEqual(
    Buffer.from(await officialRead(resentBlock.attachment)).toString('hex'),
    Buffer.from(pngBytes).toString('hex'),
    'the SECOND submission (citing the recalled durable image) re-delivered the ORIGINAL authorized bytes through the official attachment read')
  release()
  await new Promise(resolve => setTimeout(resolve, 200))
})

// ── TS8-C D12: the Remote Client intake never reads the Direct Host policy ──

/** A real 1×1 PNG (the D12 locality probe): a genuine image the Direct Host
 *  sentinel policy below (1 byte) would refuse outright. */
async function d12PngBytes(): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharpPath = require.resolve('sharp', { paths: [storeDir] })
  const sharp = require(sharpPath) as { (input: unknown): { png(): { toBuffer(): Promise<Buffer> } } }
  return new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#d12c0f' } }).png().toBuffer())
}

interface D12Fixture {
  readonly probe: Pr3Fixture
  readonly store: {
    size(): number
    values(): readonly { bytes: Uint8Array; source: { type: string } }[]
  }
  readonly pngBytes: Uint8Array
  readonly pngPath: string
  readonly hugePath: string
  /** The fake `wl-paste` invocation log (installed with `clipboard: true`). */
  readonly clipLog: string
  /** Reads of the Direct Host image policy observed so far. */
  reads(): number
}

/**
 * Mount the real Remote runner with the real Direct Host attachment service
 * present, wrapping its `imageLimits` with a COUNTED getter that returns a
 * 1-byte policy: the illegal Direct coupling would both REFUSE a real image and
 * leave an observable call witness (never a UI string). With `clipboard`, the
 * real Wayland probe is made to report a PNG through a fake `wl-paste`
 * installed first on PATH.
 */
async function mountD12Fixture(life: TestLifecycle, options: { clipboard: boolean }): Promise<D12Fixture> {
  const presetId = 'm3-4-pr3-preset'
  const sessionId = 'm3-4-pr3-d12-locality'
  const pngBytes = await d12PngBytes()
  const probeDir = life.tempDir('dsh-ts8c-d12-')
  const pngPath = join(probeDir, 'd12-probe.png')
  writeFileSync(pngPath, pngBytes)
  // A file ABOVE the Client's own 64 MiB resident safety cap: refused by stat
  // alone, before any read.
  const hugePath = join(probeDir, 'd12-huge.png')
  const hugeHandle = openSync(hugePath, 'w')
  try {
    ftruncateSync(hugeHandle, 64 * 1024 * 1024 + 1)
  } finally {
    closeSync(hugeHandle)
  }

  const clipLog = join(probeDir, 'wl-paste.log')
  if (options.clipboard) {
    const wlPaste = join(probeDir, 'wl-paste')
    writeFileSync(wlPaste, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${clipLog}'`,
      'case "$*" in',
      '  *--list-types*) echo image/png ;;',
      `  *-t*image/png*) cat '${pngPath}' ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 })
    const pathBefore = process.env.PATH
    const waylandBefore = process.env.WAYLAND_DISPLAY
    process.env.PATH = `${probeDir}:${pathBefore ?? ''}`
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    life.defer(() => {
      if (pathBefore === undefined) delete process.env.PATH
      else process.env.PATH = pathBefore
      if (waylandBefore === undefined) delete process.env.WAYLAND_DISPLAY
      else process.env.WAYLAND_DISPLAY = waylandBefore
    })
  }

  const host = await mountHost(life, presetId)
  await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  // The REAL Direct Host attachment service is present on this in-process
  // Remote composition. Wrap its `imageLimits` with a COUNTED getter returning
  // a 1-byte policy: under the illegal coupling a real PNG would be refused
  // AND the read itself is observable.
  const { symbols } = await import('@deepseek-ai/cordis')
  const liveService = host.ctx.get('attachments') as never as Record<symbol, unknown> & { imageLimits: unknown }
  const attachmentImpl = (liveService[symbols.original] ?? liveService) as { imageLimits: unknown }
  const directLimits = attachmentImpl.imageLimits
  const sentinelLimits = Object.freeze({
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    maxImageDimension: 1,
    mediaTypes: Object.freeze(['image/png']) as readonly string[],
  })
  let hostLimitReads = 0
  Object.defineProperty(attachmentImpl, 'imageLimits', {
    configurable: true,
    get() {
      hostLimitReads += 1
      return sentinelLimits
    },
  })
  life.defer(() => {
    Object.defineProperty(attachmentImpl, 'imageLimits', { configurable: true, writable: true, value: directLimits })
  })

  const probe = await mountPr3Runner(life, { presetId, resumeSessionId: sessionId, host })
  await waitFor('mount paint', () => probe.vt.getViewport().join('').length > 0, 10_000)

  const app = probe.runnerApp() as unknown as {
    draftImageStoreForTest?: D12Fixture['store']
  }
  const store = app.draftImageStoreForTest!
  assert.equal(store.size(), 0, 'the mounted Remote surface starts with no staged media')

  // POSITIVE CONTROL: the counted Direct policy IS reachable through the live
  // service proxy — a later zero count is evidence, never a vacuous truth.
  const readsBeforeControl = hostLimitReads
  assert.equal(
    (host.ctx.get('attachments') as unknown as { imageLimits: unknown }).imageLimits,
    sentinelLimits,
    'the live service proxy resolves to the wrapped Direct Host policy',
  )
  assert.equal(hostLimitReads, readsBeforeControl + 1, 'the counted Direct Host policy is reachable')
  hostLimitReads = 0

  return { probe, store, pngBytes, pngPath, hugePath, clipLog, reads: () => hostLimitReads }
}

test('locality: Remote Client /image intake never reads the Direct Host image policy', async (t) => {
  const life = testLifecycle(t)
  const d12 = await mountD12Fixture(life, { clipboard: false })

  // A) Client-local /image intake on the Remote composition: the Direct Host
  // policy is 1 byte, so the illegal coupling would refuse this real PNG.
  submitDraft(d12.probe, `/image ${d12.pngPath}`)
  await waitFor('the /image draft is staged through the Client path', () => d12.store.size() > 0, 15_000)
  assert.equal(d12.reads(), 0, 'Remote /image intake must never read the Direct Host image policy')
  assert.equal(Buffer.from(d12.store.values()[0]!.bytes).toString('hex'), Buffer.from(d12.pngBytes).toString('hex'),
    'the staged bytes are the exact local file bytes')

  // B) The Client's OWN resident cap still bounds intake: a file above 64 MiB is
  // refused by stat alone, with the CLIENT cap in the message (the Direct policy
  // would have said "1 B"). Replacing the editor text prunes the /image
  // placeholder, so no draft survives the refused intake.
  submitDraft(d12.probe, `/image ${d12.hugePath}`)
  await waitFor('the over-cap notice names the Client cap', () =>
    d12.probe.vt.getViewport().join('').includes('current attachment limit is 64.0 MiB'), 15_000)
  assert.equal(d12.store.size(), 0, 'the over-cap file is refused before any read or draft')
  assert.equal(d12.reads(), 0, 'the refusal used the Client resident cap, not the Direct Host policy')
})

test('locality: Remote Ctrl+V clipboard image intake never reads the Direct Host image policy', async (t) => {
  // The fake `wl-paste` witness is only sound where the REAL production probe
  // routes to Wayland: darwin/win32 select the native backend and WSL selects
  // PowerShell BEFORE the Wayland branch, and Termux is unsupported
  // (src/client/clipboard/read.ts: isWsl/isTermux + the readClipboardImage
  // dispatch). Otherwise the test would read the real user clipboard.
  if (process.platform !== 'linux') {
    t.skip('the real clipboard probe selects the native backend off Linux')
    return
  }
  if (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined
    || process.env.WSLENV !== undefined) {
    t.skip('the real clipboard probe selects the WSL PowerShell backend here')
    return
  }
  if (process.env.TERMUX_VERSION !== undefined || process.env.PREFIX === '/data/data/com.termux/files/usr') {
    t.skip('the real clipboard probe is unsupported in Termux')
    return
  }
  const life = testLifecycle(t)
  const d12 = await mountD12Fixture(life, { clipboard: true })

  d12.probe.vt.sendInput('\x16')
  await waitFor('the clipboard image draft is staged', () => d12.store.size() === 1, 15_000)
  const draft = d12.store.values()[0]!
  assert.equal(draft.source.type, 'clipboard', 'the paste staged a clipboard-sourced draft')
  assert.equal(Buffer.from(draft.bytes).toString('hex'), Buffer.from(d12.pngBytes).toString('hex'),
    'the staged clipboard bytes are the probed image bytes')
  assert.equal(d12.reads(), 0, 'Remote clipboard image intake must never read the Direct Host image policy')
  // The witness is the REAL probe call, not the resulting UI state.
  assert.match(readFileSync(d12.clipLog, 'utf8'), /--list-types/, 'the real clipboard probe ran')
})
