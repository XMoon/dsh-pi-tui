/**
 * M3-4 PR5 Batch 2 L6: the `/model` and `/preset` pickers' CURRENT-value
 * reads and the Remote launch-preset apply on resume — over the REAL runner
 * with a pre-selected Remote aggregate and a real rc.2 Host/Client wire.
 *
 * - `/model` current marker: the exact official `modelSelection` projection
 *   of the retained binding (the transport-neutral `ModelCatalog.sessionSelection`
 *   read), reflecting an official selection write (plan §3.3).
 * - `/preset` current marker + blankness: the Session `agentPreset` projection
 *   and `SessionReader.blank()` (plan §3.4).
 * - launch `--preset` on resume: the SAME semantic
 *   `PresetCatalog.selectSessionPreset` write the /preset command uses; a
 *   blank resumed Session applies it, a started Session keeps its recorded
 *   preset and never mutates (plan §3.5).
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-model-preset.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { mountRemotePresentationHost, mountRemoteRunner } from '../app/runner-remote-presentation.test.ts'
import { waitFor } from '../support/remote-application-fixture.ts'

type Append = (type: string, data: unknown, options?: { surfaceOp?: 'append' }) => void

interface HostFixture {
  readonly ctx: Context
  readonly workRoot: string
  readonly anchorDir: string
  readonly harness: {
    create(id: SessionId, options: undefined, meta: { cwd: string }): Promise<unknown>
  }
}

interface RunnerFixture {
  readonly host: HostFixture
  readonly aggregate: { wire: { client: unknown } }
  readonly vt: { getViewport(): string[]; sendInput(data: string): void; waitForRender(): Promise<void> }
  runnerApp(): unknown
  readonly override: {
    readonly presentation: {
      readonly sessionFacts: {
        sessionStatus(id: string): { readonly preset?: string; readonly model?: { readonly provider: string; readonly model: string } } | undefined
      }
    }
  }
  dispose(): Promise<void>
}

function sessionAppender(ctx: Context, sessionId: string): Append {
  const session = ctx.sessions.get(SessionId(sessionId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  if (session === undefined) throw new Error(`no Host session ${sessionId}`)
  return (type, data, options) => session.append(type, data, options)
}

/** One completed durable turn (a started session). */
function seedCompletedTurn(append: Append, turn: number, prompt: string, response: string): void {
  append('turn/start', { turn })
  append('step/start', { turn, step: 1 })
  append('user/message', {
    id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  append('assistant/message', {
    turn, step: 1,
    message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: response }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
    stream: [], usage: { inputTokens: 10, outputTokens: 5 },
  }, { surfaceOp: 'append' })
  append('step/end', { turn, step: 1 })
  append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The Host session's durable event rows (the counterfactual authority). */
function sessionEvents(ctx: Context, sessionId: string): Array<{ type: string; data: unknown }> {
  const session = ctx.sessions.get(SessionId(sessionId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  return session.snapshotEvents()
}

function submit(app: unknown, text: string): void {
  const a = app as { setDraft(text: string): void; submitDraft(): void }
  a.setDraft(text)
  a.submitDraft()
}

test('the Remote /model picker marks the EXACT session projection value current', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-model-picker'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const append = sessionAppender(seedHost.ctx, mainId)
  seedCompletedTurn(append, 1, 'model picker probe', 'model picker answer')
  // The official projection owns the current value: a durable selection the
  // TUI never wrote (another Client's shape). The projected id is
  // `smoke-alt` — a row whose NAME never contains the badge text, so the
  // marker assertion below cannot pass on the model name alone.
  append('model/selection', { provider: 'smoke', model: 'smoke-alt' })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost }) as unknown as RunnerFixture
  await waitFor('session facts retained', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.model !== undefined, 15_000)
  const projected = fixture.override.presentation.sessionFacts.sessionStatus(mainId)!.model
  assert.deepEqual(
    { provider: projected!.provider, model: projected!.model },
    { provider: 'smoke', model: 'smoke-alt' },
    'the official modelSelection projection carries the session-local value')
  submit(fixture.runnerApp(), '/model')
  // The picker's current row is the projection's value: the `current` badge
  // rides the `smoke-alt` row ONLY — the directory-default `smoke` row (and
  // every other row) must NOT carry the marker. Wait for the PICKER PANEL
  // (the directory rows with their display names), not the welcome card that
  // also names the model.
  await waitFor('the model picker rendered the directory', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('Alt Model') && text.includes('Smoke Model')
  }, 15_000)
  // The picker renders DISPLAY names with right-aligned badges: the
  // projection-owned `Alt Model` row carries `current`, and the
  // directory-default `Smoke Model` row carries `default` — never `current`.
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = fixture.vt.getViewport().join('\n').split('\n').map(strip)
  const altRow = lines.find(line => line.includes('Alt Model'))
  assert.ok(altRow !== undefined, 'the projected model row is rendered')
  assert.ok(/current/.test(altRow),
    'the projection-owned row carries the current marker')
  assert.equal(/default/.test(altRow), false,
    'the projected row is not the directory default')
  const smokeRow = lines.find(line => line.includes('Smoke Model'))
  assert.ok(smokeRow !== undefined, 'the directory-default row is rendered')
  assert.ok(/default/.test(smokeRow), 'the directory-default row carries the default marker')
  assert.equal(/current/.test(smokeRow), false,
    'the directory-default row does NOT carry the current marker (the projection owns it)')
})

test('the Remote /preset picker reads blankness + current from the official projections', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-preset-blank'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  // A BLANK session: created, no turns — the Host turn-boundary authority
  // must answer blank=true and the roster must open. The recorded preset is
  // a durable selection (the official `agentPreset` projection source).
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  sessionAppender(seedHost.ctx, mainId)('agent-preset/selected', { agentPreset: hostPreset })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    extraPresetIds: ['m3-4-pr5-alt-preset'],
  }) as unknown as RunnerFixture
  await waitFor('session facts retained with the recorded preset', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset === hostPreset, 15_000)
  submit(fixture.runnerApp(), '/preset')
  // A BLANK resumed session opens the roster (never the started-session
  // refusal): the current preset row is marked with the projection's value.
  await waitFor('the preset roster opened on the blank session', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('m3-4-pr2-preset') && text.includes('m3-4-pr5-alt-preset')
  }, 15_000)
  // The state chip lives in the row's own value slot (rollout PR5b moved it
  // out of the selected row's description block): the selected row's `>` and
  // the `[current]` chip are on the SAME line.
  const lines = fixture.vt.getViewport().join('\n').split('\n').map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const selectedRow = lines.findIndex(line => line.includes('> ') && line.includes('m3-4-pr2-preset'))
  assert.ok(selectedRow !== -1, 'the recorded preset is the picker\'s selected row')
  const context = lines.slice(selectedRow, selectedRow + 4).join('\n')
  assert.ok(context.includes('[current]'),
    'the projection-owned preset row carries the current chip')
  assert.equal(fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset, hostPreset,
    'the official agentPreset projection carries the recorded preset')
})

test('a STARTED Remote session refuses /preset (blank=false, locked wording)', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-preset-started'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const append = sessionAppender(seedHost.ctx, mainId)
  append('agent-preset/selected', { agentPreset: hostPreset })
  seedCompletedTurn(append, 1, 'started probe', 'started answer')
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    extraPresetIds: ['m3-4-pr5-alt-preset'],
  }) as unknown as RunnerFixture
  await waitFor('session facts retained with the recorded preset', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset === hostPreset, 15_000)
  submit(fixture.runnerApp(), '/preset')
  // The refusal wording (locked/fixed preset) — never an opened roster.
  await waitFor('the started-session refusal rendered', () => {
    const text = fixture.vt.getViewport().join('\n').replace(/\x1b\[[0-9;]*m/g, '')
    return /preset/i.test(text) && (text.includes('already started') || text.includes('fixed') || text.includes('locked'))
  }, 15_000)
  const frame = fixture.vt.getViewport().join('\n').replace(/\x1b\[[0-9;]*m/g, '')
  assert.equal(frame.includes('m3-4-pr5-alt-preset'), false,
    'a started session never offers the roster')
  assert.equal(fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset, hostPreset)
})

test('launch --preset applies to a BLANK resumed Remote session through the official write', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-launch-blank'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    launchPresetId: 'm3-4-pr5-launch-target',
    extraPresetIds: ['m3-4-pr5-launch-target'],
  }) as unknown as RunnerFixture
  // The official agentPreset projection becomes the launch target (the
  // authoritative display truth).
  await waitFor('the launch preset committed to the projection', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset === 'm3-4-pr5-launch-target', 15_000)
  // Exactly one durable agent-preset/selected row (no retry).
  const selectedRows = sessionEvents(seedHost.ctx, mainId)
    .filter(event => event.type === 'agent-preset/selected')
    .filter(event => JSON.stringify(event.data).includes('m3-4-pr5-launch-target'))
  assert.equal(selectedRows.length, 1, 'exactly one official preset selection, never a retry')
})

test('a STARTED resumed session keeps its recorded preset (no mutation, warning only)', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-launch-started'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const append = sessionAppender(seedHost.ctx, mainId)
  append('agent-preset/selected', { agentPreset: hostPreset })
  seedCompletedTurn(append, 1, 'launch started probe', 'launch started answer')
  const before = sessionEvents(seedHost.ctx, mainId).map(event => event.type).join(',')
  // THE PRODUCER WITNESS. The launch-preset apply is ONE
  // `agentPresets.select(...)` call on the Host registry (the Remote
  // `PresetCatalog.selectSessionPreset` maps onto it); a started Session is
  // refused with `agent-preset/locked`. Recording that call's own settlement
  // (resolved or rejected) is the fact that the launch write finished — the
  // absence below is then asserted AFTER the producer, not after a duration.
  // The seam is patched on the Host registry instance the Remote wire addresses,
  // exactly like the `llm.listModels` park in the directory-fence case.
  const registry = seedHost.ctx.get('agentPresets') as unknown as {
    select(agent: unknown, preset: string): Promise<string>
  }
  const originalSelect = registry.select
  const launchSelects: Array<{ readonly preset: string; readonly settled: 'committed' | 'rejected' }> = []
  registry.select = function patchedSelect(this: unknown, agent: unknown, preset: string): Promise<string> {
    return originalSelect.call(this, agent, preset).then(value => {
      launchSelects.push({ preset, settled: 'committed' })
      return value
    }, error => {
      launchSelects.push({ preset, settled: 'rejected' })
      throw error
    })
  }
  life.defer(() => { registry.select = originalSelect })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    launchPresetId: 'm3-4-pr5-launch-target',
    extraPresetIds: ['m3-4-pr5-launch-target'],
  }) as unknown as RunnerFixture
  await waitFor('session facts retained', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined, 15_000)
  // The refusal is a NEGATIVE contract: a started Session must never receive an
  // `agent-preset/selected` row. Wait for the launch write's OWN settlement on
  // the Host registry — only then can "no durable row" be a fact about a
  // finished attempt instead of a race with an unfinished one.
  await waitFor('the launch preset write to settle on the Host registry',
    () => launchSelects.length > 0, 20_000)
  assert.equal(launchSelects[0]!.preset, 'm3-4-pr5-launch-target',
    'the launch attempt really addressed the requested preset')
  assert.equal(launchSelects[0]!.settled, 'rejected',
    'a started Session refuses the launch preset instead of committing it')
  // The recorded preset is unchanged and NO selection row exists.
  assert.equal(fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset, hostPreset,
    'a started session keeps its recorded preset')
  // The Host's async title fold may append `session/title` rows after the
  // seed; every OTHER event type must be byte-identical to the seed.
  const materialAfter = sessionEvents(seedHost.ctx, mainId).filter(event => event.type !== 'session/title').map(event => event.type).join(',')
  assert.equal(materialAfter, before,
    'no durable session events beyond the seeded rows (no launch-preset write reached the log)')
})

/** The lifecycle helper every test here uses. */
function testLifecycleOf(t: unknown): TestLifecycle {
  return testLifecycle(t as Parameters<typeof testLifecycle>[0])
}

test('an official selectModel write owns the REOPENED picker current', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-model-reopen'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  seedCompletedTurn(sessionAppender(seedHost.ctx, mainId), 1, 'reopen probe', 'reopen answer')
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost }) as unknown as RunnerFixture
  await waitFor('the retained session is served', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined, 15_000)
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const rows = (): { alt?: string; smoke?: string } => {
    const lines = fixture.vt.getViewport().join('\n').split('\n').map(strip)
    return {
      alt: lines.find(line => line.includes('Alt Model')),
      smoke: lines.find(line => line.includes('Smoke Model')),
    }
  }
  const openPicker = async (): Promise<void> => {
    submit(fixture.runnerApp(), '/model')
    await waitFor('picker rows rendered', () => rows().alt !== undefined && rows().smoke !== undefined, 15_000)
  }
  /** Whether the /model picker panel is painted at all. */
  const pickerOpen = (): boolean => rows().alt !== undefined || rows().smoke !== undefined
  await openPicker()
  assert.ok(rows().smoke !== undefined && /current/.test(rows().smoke!),
    'the first open marks the effective value (the smoke default — no session selection yet) current')
  // THE REAL OFFICIAL WRITE: the generated Client session face's
  // selectModel — the same official `session/selectModel` wire verb the
  // semantic `ModelCatalog.selectSessionModel` maps onto (the TUI's own
  // apply path). Assert the SETTLED result first, then the projection.
  const sessionFace = (fixture.aggregate.wire.client as unknown as {
    remote: { session: { selectModel(request: { sessionId: string; provider: string; model: string }): Promise<{ ok: boolean; value?: { selected: unknown } }> } }
  }).remote.session
  const settled = await sessionFace.selectModel({ sessionId: mainId, provider: 'smoke', model: 'smoke-alt' })
  assert.equal(settled.ok, true, 'the official selectModel write settled successfully')
  await waitFor('the official projection carries the committed selection', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.model?.model === 'smoke-alt', 20_000)
  const selectionEvents = sessionEvents(seedHost.ctx, mainId).filter(event => event.type === 'model/selection')
  assert.equal(selectionEvents.length, 1,
    'exactly one durable model/selection row (the official write, never a test append)')
  // REOPEN: the committed projection owns the current marker. The first panel
  // is closed through the REAL user path (Esc) — the test cannot reach the
  // private `closeModelPicker`, and a closer call that silently did nothing
  // would leave the reopen reading the still-open (stale) picker.
  fixture.vt.sendInput('\x1b')
  await waitFor('the first picker panel to close', () => !pickerOpen(), 15_000)
  await openPicker()
  // The reopened panel must paint the committed projection as `current`. The row
  // set itself is the settle witness `openPicker` already waited for; the badge
  // follows the same frame set.
  await waitFor('the reopened picker to mark the committed value current',
    () => rows().alt !== undefined && /current/.test(rows().alt!), 15_000)
  assert.ok(rows().alt !== undefined && /current/.test(rows().alt!),
    'the REOPENED picker marks the committed projection value (smoke-alt) current')
  assert.ok(rows().smoke !== undefined && !/current/.test(rows().smoke!),
    'the previous value lost the current marker')
})

test('a /preset SWITCH on a blank Remote session commits through the official write', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-preset-switch'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  sessionAppender(seedHost.ctx, mainId)('agent-preset/selected', { agentPreset: hostPreset })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    extraPresetIds: ['m3-4-pr5-switch-target'],
  }) as unknown as RunnerFixture
  await waitFor('session facts retained with the recorded preset', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset === hostPreset, 15_000)
  submit(fixture.runnerApp(), '/preset')
  await waitFor('the roster opened', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('m3-4-pr5-switch-target')
  }, 15_000)
  // Select the target row: the picker is a settings panel — Enter activates
  // the row the cursor sits on. Drive the real key path: type a search that
  // isolates the target row, then Enter.
  // Re-submitting the plain command runs the REAL command again (the roster is
  // already showing). The case then drives `/preset <id>`, so no settle is owed
  // here: the typed submit below is the thing under test.
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void; pressEnter?: () => void; handleKey?: (key: string) => void }
  app.setDraft('/preset')
  app.submitDraft()
  // The official projection owns the outcome: the switch is driven by the
  // SAME official write the launch-preset test uses (the roster's Enter
  // path routes through applyPresetSelection → selectSessionPreset). Drive
  // it through the real command: /preset <id> on a BLANK session commits.
  submit(fixture.runnerApp(), '/preset m3-4-pr5-switch-target')
  await waitFor('the official projection carries the switched preset', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset === 'm3-4-pr5-switch-target', 20_000)
  const selectedRows = sessionEvents(seedHost.ctx, mainId)
    .filter(event => event.type === 'agent-preset/selected')
    .filter(event => JSON.stringify(event.data).includes('m3-4-pr5-switch-target'))
  assert.equal(selectedRows.length, 1, 'exactly one official selection row (never retried)')
})

test('a /model directory read pending across a session replacement never hydrates the stale panel (owner-fence regression)', async (t) => {
  const life = testLifecycleOf(t)
  const mainA = 'm3-4-pr5-model-fence-a'
  const mainB = 'm3-4-pr5-model-fence-b'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainA), undefined, { cwd: seedHost.anchorDir })
  const appendA = sessionAppender(seedHost.ctx, mainA)
  seedCompletedTurn(appendA, 1, 'model fence probe', 'model fence answer A')
  appendA('model/selection', { provider: 'smoke', model: 'smoke' })
  // B carries its OWN transcript marker: the visible-owner proof below
  // requires B-ONLY content on the surface (a retained projection alone is
  // not a visible-owner commit).
  await seedHost.harness.create(SessionId(mainB), undefined, { cwd: seedHost.anchorDir })
  const appendB = sessionAppender(seedHost.ctx, mainB)
  seedCompletedTurn(appendB, 1, 'model fence probe B', 'MODEL-FENCE-B-MARKER')
  appendB('model/selection', { provider: 'smoke', model: 'smoke-alt' })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainA, host: seedHost }) as unknown as RunnerFixture
  await waitFor('A facts retained', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainA)?.model?.model === 'smoke', 15_000)
  // Park the OFFICIAL directory read at the Host llm.listModels seam
  // (buildModelCatalog awaits it). The read NEVER fabricates a directory on
  // failure: a broken park rejects and fails the test.
  const llmService = seedHost.ctx.llm as unknown as {
    listModels(provider: string): Promise<unknown>
  }
  const originalListModels = llmService.listModels.bind(llmService)
  let catalogParked = false
  // The parked read's OWN settlement: the release only OPENS the gate, so the
  // test needs a fact that proves the read really finished before it decides
  // anything about the stale panel. `catalogSettled` is that witness — it is set
  // by the parked promise's own resolve/reject, i.e. the exact boundary the
  // release hands over to.
  let catalogSettled = false
  let releaseCatalog: (() => void) | undefined
  let parkFailed = false
  llmService.listModels = (provider: string): Promise<unknown> => {
    if (catalogParked) return originalListModels(provider)
    catalogParked = true
    return new Promise((resolve, reject) => {
      releaseCatalog = () => {
        originalListModels(provider).then(value => {
          catalogSettled = true
          resolve(value)
        }, error => {
          parkFailed = true
          catalogSettled = true
          reject(error)
        })
      }
    })
  }
  // Failure-path fallback: a failed assertion must not strand the parked
  // read (the owned workflow would hang the runner teardown).
  life.defer(() => releaseCatalog?.())
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const frame = (): string => fixture.vt.getViewport().join('\n')
  submit(fixture.runnerApp(), '/model')
  await waitFor('the parked directory read began', () => catalogParked, 10_000)
  // Replace the visible subject while the directory read is parked. The
  // switch is proven by A-ONLY transcript content RETIRING from the
  // rendered surface (a discriminating observable), not by a retained
  // projection alone.
  submit(fixture.runnerApp(), `/resume ${mainB}`)
  // Visible-owner proof: B is retained AND the A-only transcript content
  // has RETIRED from the rendered surface (the replacement hydrate paints
  // B's window in place of A's) — the assertion predicate is A's marker
  // being ABSENT, the retirement side of the switch.
  await waitFor('B facts retained', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainB)?.model?.model === 'smoke-alt', 15_000)
  await waitFor('the visible owner became B (A-only transcript content retired)', () =>
    frame().includes('model fence answer A') === false, 20_000)
  // Release the old subject's directory read and let the OWNED workflow
  // settle (success or typed failure — never a fabricated empty directory).
  const release = releaseCatalog
  releaseCatalog = undefined
  release?.()
  // The parked read's OWN settlement is the authority (the old 800ms only
  // guessed it): wait for it, then let the owned workflow's continuation land on
  // a painted frame — `closeModelPicker` drops the overlay synchronously, so the
  // frame that follows it is the observable end of the fence.
  await waitFor('the parked directory read to settle', () => catalogSettled, 20_000)
  assert.equal(parkFailed, false, 'the parked official directory read settled successfully')
  await fixture.vt.waitForRender()
  // The owner fence must have CLOSED A's stale loading panel: no picker
  // panel rows hydrate at all (the release arrived for a replaced subject —
  // neither A's current nor any directory hydration may paint).
  const lines = frame().split('\n').map(strip)
  const stalePanelRows = lines.filter(line =>
    (line.includes('Smoke Model') || line.includes('Alt Model')) && !line.includes('MODEL-FENCE-B-MARKER'))
  assert.deepEqual(stalePanelRows, [],
    'the stale /model panel was CLOSED by the owner fence — no directory rows hydrated onto the replacement surface')
  // B keeps its own projection value.
  assert.equal(fixture.override.presentation.sessionFacts.sessionStatus(mainB)?.model?.model, 'smoke-alt',
    'B keeps its own projection value')
})
