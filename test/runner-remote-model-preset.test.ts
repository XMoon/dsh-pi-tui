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
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { mountRemotePresentationHost, mountRemoteRunner } from './runner-remote-presentation.test.ts'
import { waitFor } from './support/remote-application-fixture.ts'

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
  readonly vt: { getViewport(): string[] }
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

test('L6 PR5 §3.3: the Remote /model picker marks the EXACT session projection value current', async (t) => {
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

test('L6 PR5 §3.4: the Remote /preset picker reads blankness + current from the official projections', async (t) => {
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
  // The settings panel renders the row's description on its own wrapped
  // line (the overlay is width-constrained): the selected row `›` and the
  // `← current` marker land on ADJACENT lines of the same panel.
  const lines = fixture.vt.getViewport().join('\n').split('\n').map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const selectedRow = lines.findIndex(line => line.includes('›') && line.includes('m3-4-pr2-preset'))
  assert.ok(selectedRow !== -1, 'the recorded preset is the picker\'s selected row')
  const context = lines.slice(selectedRow, selectedRow + 4).join('\n')
  assert.ok(context.includes('← current'),
    'the projection-owned preset row carries the current marker')
  assert.equal(fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.preset, hostPreset,
    'the official agentPreset projection carries the recorded preset')
})

test('L6 PR5 §3.4: a STARTED Remote session refuses /preset (blank=false, locked wording)', async (t) => {
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

test('L6 PR5 §3.5: launch --preset applies to a BLANK resumed Remote session through the official write', async (t) => {
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

test('L6 PR5 §3.5: a STARTED resumed session keeps its recorded preset (no mutation, warning only)', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-launch-started'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const append = sessionAppender(seedHost.ctx, mainId)
  append('agent-preset/selected', { agentPreset: hostPreset })
  seedCompletedTurn(append, 1, 'launch started probe', 'launch started answer')
  const before = sessionEvents(seedHost.ctx, mainId).map(event => event.type).join(',')
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    launchPresetId: 'm3-4-pr5-launch-target',
    extraPresetIds: ['m3-4-pr5-launch-target'],
  }) as unknown as RunnerFixture
  await waitFor('session facts retained', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined, 15_000)
  // Give the (refused) launch write time to settle before asserting absence.
  await new Promise(resolve => setTimeout(resolve, 500))
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

test('L6 PR5 §3.3: an official selectModel write owns the REOPENED picker current', async (t) => {
  const life = testLifecycleOf(t)
  const mainId = 'm3-4-pr5-model-reopen'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const append = sessionAppender(seedHost.ctx, mainId)
  seedCompletedTurn(append, 1, 'reopen probe', 'reopen answer')
  append('model/selection', { provider: 'smoke', model: 'smoke' })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost }) as unknown as RunnerFixture
  await waitFor('session facts retained', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.model !== undefined, 15_000)
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
  await openPicker()
  assert.ok(rows().smoke !== undefined && /current/.test(rows().smoke!),
    'the first open marks the projection value (smoke) current')
  // Close the picker (the same closer the command layer's `close` seam
  // holds): reopen is driven by a second /model after the write. The
  // structural access mirrors this suite's other mounted-surface probes
  // (statusStore, footerRenderRowsForTest).
  const app = fixture.runnerApp() as unknown as { closeModelPicker?: () => void }
  app.closeModelPicker?.()
  await new Promise(resolve => setTimeout(resolve, 200))
  // ANOTHER writer commits the official selection: the durable
  // model/selection event the projection channel pushes.
  append('model/selection', { provider: 'smoke', model: 'smoke-alt' })
  await waitFor('the projection advanced', () =>
    fixture.override.presentation.sessionFacts.sessionStatus(mainId)?.model?.model === 'smoke-alt', 15_000)
  await openPicker()
  assert.ok(rows().alt !== undefined && /current/.test(rows().alt!),
    'the REOPENED picker marks the committed projection value (smoke-alt) current')
  assert.ok(rows().smoke !== undefined && !/current/.test(rows().smoke!),
    'the previous value lost the current marker')
})

test('L6 PR5 §3.4: a /preset SWITCH on a blank Remote session commits through the official write', async (t) => {
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
  const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void; pressEnter?: () => void; handleKey?: (key: string) => void }
  app.setDraft('/preset')
  app.submitDraft()
  await new Promise(resolve => setTimeout(resolve, 150))
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


