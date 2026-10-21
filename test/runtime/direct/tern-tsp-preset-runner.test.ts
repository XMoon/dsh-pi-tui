/** PR4-A `/preset` through the REAL classifier, capability admission, original
 *  command handler and Direct Host sinks.
 *
 * The TSP opt-in, the shipped SDK pane, the real runner/`SubmissionController`,
 * the real Direct Host composition (agent loop, persistence, the official
 * `agent-presets` registry) and the ORIGINAL `/preset` handler all execute. Only
 * the physical terminal and the LLM endpoint are scripted.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-preset-runner.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createDirectTspFixture, waitFor } from '../../support/direct-tsp-fixture.ts'
import { ownTspBoot, settle, waitUntil } from '../../support/tsp-runner-harness.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'
import { DirectPresetCatalog } from '../../../src/runtime/direct/catalog-direct.ts'
import {
  PRESET_LAYER_PREFIX as P,
  clickLayerNode,
  layerNodes,
  pickerActionByBase,
  pickerNode,
  pickerProps,
  sendActivate,
  sendPickerAction,
  sheetText,
  wireNodes,
  type WireNode,
} from '../../support/tsp-picker-wire.ts'

const props = (pane: { readonly output: unknown } | never): Record<string, unknown> => pickerProps(pane as never, P)
const node = (pane: unknown): unknown => pickerNode(pane as never, P)
/** One footer entry by the BASE id it does: a rendered id carries the frame token. */
const action = (pane: unknown, base: string): Record<string, unknown> | undefined =>
  pickerActionByBase(pane as never, base, P)

/** The `/preset` Overview overlay, or `undefined` while the catalogue shows. */
const details = (pane: unknown): WireNode | undefined =>
  layerNodes(pane as never, P).find((node) => node.k === 'overlay' && node.id.includes('preset-details-'))

/** The reading page's scrolling body: ONE identity per reading. */
const readingBody = (pane: unknown): WireNode | undefined =>
  layerNodes(pane as never, P).find((node) => node.k === 'col' && node.id.includes('preset-reading-body-'))

/** Every visible string of the preset layer (the Details page's own text). */
const layerText = (pane: unknown): string => sheetText(pane as never, P)

/** The mounted catalogue's card records (the roster's own projected badges). */
const items = (pane: { readonly output: unknown } | never): Array<Record<string, unknown>> =>
  (props(pane).items ?? []) as Array<Record<string, unknown>>

/** One `<Label>: <value>` fact of the preset catalogue's ONE native subtitle line. */
function statusOf(pane: { readonly output: { text(): string } }, label: string): string | undefined {
  const at = dockText(pane).indexOf(`${label}: `)
  if (at < 0) return undefined
  const rest = dockText(pane).slice(at)
  const end = rest.search(/ · |"/u)
  return end < 0 ? rest : rest.slice(0, end)
}

/** The pane's own dock/notice text (the display seam's visible facts). */
const dockText = (pane: { output: { text(): string } }): string => pane.output.text()

/** The visible composer draft (the editor node's own text property). */
const composerText = (pane: unknown): string | undefined =>
  wireNodes(pane as never).find((entry) => entry.k === 'editor' && entry.id.includes('composer'))?.p.text as
  | string
  | undefined

/** The fixture pane type (kept structural: this suite reads only these facts). */
type Pane = { key(sequence: string): void; output: { text(): string } }

/* ------------------------------------------------------- capability admission */

test('a pane without the picker kind refuses /preset before the handler', async (t) => {
  const life = testLifecycle(t), home = life.tempDir('dsh-preset-gate-')
  const boot = await ownTspBoot({ life, home, logFile: home + '/diag.log' })
  try {
    await waitUntil('renderer ready', () => dockText(boot.pane).includes('dock.composer'))
    boot.pane.key('/preset\r')
    await waitUntil('capability refusal', () =>
      dockText(boot.pane).includes("This command's UI is not available in TSP yet"))
    // The draft is restored into the composer and NOTHING ran: no session, no picker.
    await waitUntil('draft restored', () => composerText(boot.pane) === '/preset')
    assert.equal(node(boot.pane), undefined)
    assert.equal(boot.harness.createdSessions.length, 0, 'a refused UI never creates a session')
  } finally {
    await boot.settle()
  }
})

/* ------------------------------------------------------- real Direct Host runs */

test('the real /preset handler opens the native picker over the REAL roster', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    presets: [{ id: 'minimal-preset', name: 'Minimal preset', description: 'A second real target.' }],
  })
  const original = DirectPresetCatalog.prototype.selectSessionPreset
  const switches: Array<{ sessionId: string; presetId: string }> = []
  DirectPresetCatalog.prototype.selectSessionPreset = async function (...args) {
    switches.push({ sessionId: args[0], presetId: args[1] })
    return original.apply(this, args)
  }
  t.after(() => { DirectPresetCatalog.prototype.selectSessionPreset = original })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('/preset\r')
    await waitFor('native preset picker', () => props(fixture.pane).state === 'ready')
    assert.deepEqual(items(fixture.pane).map((entry) => entry.id), ['preset:b2-direct-preset', 'preset:minimal-preset'])
    const cards = items(fixture.pane)
    assert.equal(cards[0]?.label, 'B2 direct preset')
    assert.deepEqual(cards[0]?.badges, [{ text: 'Default' }])
    assert.match(String(cards[1]?.detail), /^Custom · A second real target\.$/)
    // The two session facts are independent display facts of this subject (Owner
    // ruling "a": the ready picker paints no status text — the committed facts are
    // the cards' own badges and the native `current` slot).
    assert.equal(items(fixture.pane).some((entry) => (entry.badges as Array<{ text: string }>)?.some((badge) => badge.text === 'Next session')), false,
      'a sessionless subject states no Next session before a choice exists')
    // A sessionless subject can never present a Current row.
    assert.deepEqual(props(fixture.pane).current, [])
    // Browsing and Enter on the list are read-only: the Host writer is untouched.
    // The card's own activation opens the read-only Overview: no write, and the
    // picker is gone while it reads (ONE page at a time).
    sendActivate(fixture.pane, 'preset:b2-direct-preset', pickerNode(fixture.pane, P)!.id)
    await waitFor('the Details page replaced the picker', () => details(fixture.pane) !== undefined)
    assert.equal(pickerNode(fixture.pane, P), undefined, 'a reading page carries no picker')
    assert.equal(switches.length, 0)
    clickLayerNode(fixture.pane, 'preset-details-back-', P)
    await waitFor('back on the catalogue', () => pickerNode(fixture.pane, P) !== undefined)
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    assert.equal(switches.length, 0, 'browsing never writes')
    fixture.pane.key('\r')
    await waitFor('the catalogue Enter opens Details only', () =>
      switches.length === 0 && details(fixture.pane) !== undefined)
    fixture.pane.key('\u001b')
    await waitFor('Details Esc returns to the catalogue', () => pickerNode(fixture.pane, P) !== undefined)
    // Esc closes; the picker is a pure view so far.
    fixture.pane.key('\u001b')
    await waitFor('closed', () => node(fixture.pane) === undefined)
    assert.equal(switches.length, 0)
  } finally {
    await fixture.settle()
  }
})

test('sessionless Use stages the run-local pending preset without a Session', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('/preset\r')
    await waitFor('picker ready', () => props(fixture.pane).state === 'ready')
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    // Tab then Enter: the focused `Use for next session` is the ONE write.
    fixture.pane.key('\t')
    await waitFor('use focused', () => String(action(fixture.pane, 'use')?.label).includes('[Enter]'))
    fixture.pane.key('\r')
    await waitFor('staged notice', () => dockText(fixture.pane).includes('new sessions will start on preset minimal-preset'))
    await waitFor('picker dismissed', () => node(fixture.pane) === undefined)
    assert.equal([...fixture.ctx.agents.list()].length, 0, 'staging creates no Session')
    // Reopening the SAME authority shows the staged choice as the Next session.
    fixture.pane.key('/preset\r')
    await waitFor('reopened', () => props(fixture.pane).state === 'ready')
    const badges = (items(fixture.pane).find((entry) => entry.id === 'preset:minimal-preset')?.badges ?? []) as Array<{ text: string }>
    assert.deepEqual(badges, [{ text: 'Next session' }],
      'the staged choice is that card\'s own native badge (Owner ruling "a")')
    assert.equal(props(fixture.pane).selected, 'preset:minimal-preset')
    assert.deepEqual(props(fixture.pane).current, [], 'the next-session choice is not a current badge')
    fixture.pane.key('\u001b')
    await waitFor('closed', () => node(fixture.pane) === undefined)
  } finally {
    await fixture.settle()
  }
})

test('a STARTED Session is refused by the ORIGINAL message, never a picker', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    deltas: ['preset-started-turn'],
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  const original = DirectPresetCatalog.prototype.selectSessionPreset
  let switchCalls = 0
  DirectPresetCatalog.prototype.selectSessionPreset = async function (...args) {
    switchCalls += 1
    return original.apply(this, args)
  }
  t.after(() => { DirectPresetCatalog.prototype.selectSessionPreset = original })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('started turn\r')
    await waitFor('real turn finished', () => dockText(fixture.pane).includes('preset-started-turn'))
    // The bare picker path keeps the historical refusal text.
    fixture.pane.key('/preset\r')
    await waitFor('refusal notice', () => dockText(fixture.pane).includes('preset switching is only available in a new session'))
    assert.equal(node(fixture.pane), undefined, 'no selectable picker for a started Session')
    assert.equal(switchCalls, 0)
    // An ERROR result keeps the draft for correction (the repository's own
    // command-submission rule), so the next line starts from a clean composer.
    await clearComposer(fixture.pane)
    // The typed verb refuses through the SAME Host authority (the LOCKED
    // wording is its own: the bare refusal says `for future sessions`).
    fixture.pane.key('/preset minimal-preset\r')
    await waitFor('typed refusal', () => dockText(fixture.pane).includes('its agent preset is fixed —'))
    assert.equal(switchCalls, 1, 'the typed verb still reaches the Host, which refuses')
    assert.equal(node(fixture.pane), undefined)
    // `/preset status` stays a read (never a write, never a picker).
    fixture.pane.key('/preset status\r')
    await waitTo(() => switchCalls === 1 && node(fixture.pane) === undefined)
  } finally {
    await fixture.settle()
  }
})

/** Erase whatever the last submission restored into the visible composer. */
async function clearComposer(pane: Pane): Promise<void> {
  for (let attempt = 0; attempt < 8 && (composerText(pane) ?? '') !== ''; attempt += 1) {
    const draft = composerText(pane) ?? ''
    pane.key('\u007f'.repeat(draft.length))
    await waitTo(() => (composerText(pane) ?? '').length < draft.length)
  }
  assert.equal(composerText(pane), '', 'the composer must start clean')
}

/** A short settle for negative facts that need no new frame. */
async function waitTo(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('timed out waiting for a negative fact')
}

test('a REAL blank live Session switches preset through the Host and rereads it', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    // The fixture materializes a REAL persisted, released Session through the
    // official persistence seam; the runner's ordinary startup resumes it.
    persistedBlankSession: { id: 'blank-live-1' },
    startup: { sessionId: 'blank-live-1' },
    deltas: ['blank-switch-turn'],
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  // The registry instance itself is kept: the post-settle check must read the
  // SAME authority after the composition is disposed.
  const registry = fixture.ctx.get('agents') as unknown as {
    list(): ReadonlyArray<{ readonly session: { readonly id: unknown } }>
  }
  const liveAgents = (): string[] => [...registry.list()].map((agent) => String(agent.session.id))
  const sessionEvents = (type: string): ReadonlyArray<{ readonly type: string; readonly data: unknown }> =>
    ((fixture.ctx.agents.get('blank-live-1' as never)?.session.snapshotEvents() ?? []) as
      ReadonlyArray<{ readonly type: string; readonly data: unknown }>)
      .filter((event) => event.type === type)
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    assert.deepEqual(liveAgents(), ['blank-live-1'], 'the runner resumed the persisted Session')
    fixture.pane.key('/preset\r')
    await waitFor('native picker', () => props(fixture.pane).state === 'ready')
    // The Host turn-boundary authority says the resumed Session is still BLANK:
    // no started-Session refusal, a `Current session` fact, and the in-session
    // write offered by its own wording.
    assert.deepEqual(props(fixture.pane).current, ['preset:b2-direct-preset'])
    assert.equal(dockText(fixture.pane).includes('preset switching is only available in a new session'), false)
    assert.equal(String(action(fixture.pane, 'use')?.label), 'Use session')
    assert.equal(action(fixture.pane, 'use')?.disabled, undefined)
    assert.deepEqual(props(fixture.pane).current, ['preset:b2-direct-preset'])
    // Browse the second real preset and commit through the focused action.
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    fixture.pane.key('\t')
    await waitFor('use focused', () => String(action(fixture.pane, 'use')?.label).includes('[Enter]'))
    fixture.pane.key('\r')
    // The DURABLE Host commit: the live Session's own log holds exactly one
    // selection, and the Session was NEVER re-created or replaced.
    await waitFor('durable agent-preset/selected', () => sessionEvents('agent-preset/selected').length === 1)
    assert.deepEqual(sessionEvents('agent-preset/selected')[0]?.data, { agentPreset: 'minimal-preset' })
    assert.deepEqual(liveAgents(), ['blank-live-1'], 'the switch never created a second Session')
    await waitFor('picker dismissed', () => pickerNode(fixture.pane, P) === undefined)
    // The ORIGINAL Session authority reread: the official projection and a
    // reopened panel both report the new preset as the Current one.
    const sessionQuery = fixture.ctx.get('sessionQuery') as unknown as {
      observeSession(id: unknown): Promise<{ projections: { values: { agentPreset?: string } } }>
    }
    const observed = await sessionQuery.observeSession('blank-live-1')
    assert.equal(observed.projections.values.agentPreset, 'minimal-preset')
    fixture.pane.key('/preset\r')
    await waitFor('reopened', () => props(fixture.pane).state === 'ready')
    assert.deepEqual(props(fixture.pane).current, ['preset:minimal-preset'])
    // The new-session default is a CARD BADGE (on `b2-direct-preset`), never a
    // Current badge (Owner ruling "a").
    const b2Badges = (items(fixture.pane).find((entry) => entry.id === 'preset:b2-direct-preset')?.badges ?? []) as Array<{ text: string }>
    assert.deepEqual(b2Badges, [{ text: 'Default' }],
      'a Session switch never rewrites the new-session default')
    // A Session that has STARTED is refused by the Host (the locked negative).
    fixture.pane.key('\u001b')
    await waitFor('closed', () => pickerNode(fixture.pane, P) === undefined)
    fixture.pane.key('blank-switch-turn\r')
    await waitFor('the turn ran', () => dockText(fixture.pane).includes('blank-switch-turn'))
    await clearComposer(fixture.pane)
    fixture.pane.key('/preset minimal-preset\r')
    await waitFor('locked refusal', () => dockText(fixture.pane).includes('its agent preset is fixed —'))
    assert.equal(sessionEvents('agent-preset/selected').length, 1, 'the locked attempt wrote nothing')
  } finally {
    await fixture.settle()
  }
  // Teardown leaves no live Agent behind.
  assert.deepEqual(liveAgents(), [], 'the runner teardown released the resumed Session')
})

test('a Host write that settles after its panel was replaced notifies nobody', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    persistedBlankSession: { id: 'blank-live-1' },
    startup: { sessionId: 'blank-live-1' },
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  const original = DirectPresetCatalog.prototype.selectSessionPreset
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  DirectPresetCatalog.prototype.selectSessionPreset = async function (...args) {
    calls += 1
    await gate
    return original.apply(this, args)
  }
  t.after(() => { DirectPresetCatalog.prototype.selectSessionPreset = original })
  const selections = (): number =>
    ((fixture.ctx.agents.get('blank-live-1' as never)?.session.snapshotEvents() ?? []) as ReadonlyArray<{ type: string }>)
      .filter((event) => event.type === 'agent-preset/selected').length
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('/preset\r')
    await waitFor('picker ready', () => props(fixture.pane).state === 'ready')
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    fixture.pane.key('\t')
    await waitFor('use focused', () => String(action(fixture.pane, 'use')?.label).includes('[Enter]'))
    fixture.pane.key('\r')
    await waitFor('the write reached the Host writer', () => calls === 1)
    // Esc closes the panel; the admitted Host write keeps running (closing a
    // panel never cancels a write).
    fixture.pane.key('\u001b')
    await waitFor('closed', () => pickerNode(fixture.pane, P) === undefined)
    assert.equal(selections(), 0, 'the write is still in flight')
    // A NEWER `/preset` takes the surface while the first write is still open.
    fixture.pane.key('/preset\r')
    await waitFor('the new panel is ready', () => props(fixture.pane).state === 'ready'
      && pickerNode(fixture.pane, P) !== undefined)
    const newPanel = pickerNode(fixture.pane, P)!.id
    // The OLD write settles: no line may describe it on the surface that
    // replaced it.
    release()
    await waitFor('the old write committed', () => selections() === 1)
    await settle(600)
    assert.equal(pickerNode(fixture.pane, P)?.id, newPanel, 'the new panel is untouched')
    assert.equal(dockText(fixture.pane).includes('session preset switched to minimal-preset'), false,
      'a retired panel never notifies the surface that replaced it')
    // POSITIVE CONTROL on the same seam: while the panel still owns the surface,
    // the very same outcome IS announced (the fence is not a blanket silence).
    fixture.pane.key('\t')
    await waitFor('use focused again', () => String(action(fixture.pane, 'use')?.label).includes('[Enter]'))
    fixture.pane.key('\r')
    await waitFor('the control switch is announced', () =>
      dockText(fixture.pane).includes('session preset switched to b2-direct-preset'))
    assert.equal(selections(), 2)
  } finally {
    release()
    await fixture.settle()
  }
})

/* ------------------------------------------------------------ typed verbs */

test('the typed verbs keep their original Host routes and never open a picker', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  const roster = DirectPresetCatalog.prototype.roster
  const resolve = DirectPresetCatalog.prototype.resolve
  const select = DirectPresetCatalog.prototype.selectSessionPreset
  let rosterReads = 0
  let resolves = 0
  let selections = 0
  DirectPresetCatalog.prototype.roster = async function (...args) {
    rosterReads += 1
    return roster.apply(this, args)
  }
  DirectPresetCatalog.prototype.resolve = async function (...args) {
    resolves += 1
    return resolve.apply(this, args)
  }
  DirectPresetCatalog.prototype.selectSessionPreset = async function (...args) {
    selections += 1
    return select.apply(this, args)
  }
  t.after(() => {
    DirectPresetCatalog.prototype.roster = roster
    DirectPresetCatalog.prototype.resolve = resolve
    DirectPresetCatalog.prototype.selectSessionPreset = select
  })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    // `/preset status` is a pure read.
    fixture.pane.key('/preset status\r')
    await waitTo(() => node(fixture.pane) === undefined)
    assert.equal(rosterReads, 0, 'status reads no roster')
    assert.equal(resolves, 0)
    assert.equal(selections, 0)
    // `/preset default` (no id) is a pure read too.
    fixture.pane.key('/preset default\r')
    await waitTo(() => node(fixture.pane) === undefined)
    assert.equal(resolves, 0, 'the read-only default form never validates or writes')
    assert.equal(selections, 0)
    // `/preset <id>` applies through the SAME original sessionless write.
    fixture.pane.key('/preset minimal-preset\r')
    await waitFor('original sessionless resolve', () => resolves === 1)
    assert.equal(selections, 0, 'a sessionless subject stages pending, it never switches a Session')
    assert.equal(node(fixture.pane), undefined, 'the typed verb never opens the picker')
    assert.equal(rosterReads, 0)
  } finally {
    await fixture.settle()
  }
})

test('a Host-owned /preset keeps its own route ahead of the TUI registration', async (t) => {
  const life = testLifecycle(t)
  const invoked: string[] = []
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    hostCommands: [{
      name: 'preset',
      description: 'Host-owned preset',
      handler: (invocation) => { invoked.push(invocation.rawInput) },
    }],
  })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('/preset\r')
    await waitFor('the Host handler ran', () => invoked.length === 1)
    assert.equal(node(fixture.pane), undefined, 'a genuine Host command never opens the TUI picker')
  } finally {
    await fixture.settle()
  }
})

/* ----------------------------------------------------- the default write */

/** The registry's real settings row inside the profile document. */
function presetDefaultRow(patchPath: string): string | undefined {
  const rows = parse(readFileSync(patchPath, 'utf8')) as Array<{
    readonly id?: string
    readonly config?: { readonly selectedDefault?: string }
  }>
  return rows.find((row) => row.id === 'agent-preset-registry')?.config?.selectedDefault
}

test('the picker default write persists through the official profile plane', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    presetProfile: {
      presets: [{ id: 'fixture-a', name: 'Fixture A' }, { id: 'fixture-b', name: 'Fixture B' }],
    },
  })
  const patchPath = join(fixture.workRoot, 'profile', 'cordis.patch.yml')
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    assert.equal(presetDefaultRow(patchPath), undefined, 'no test pre-seeds the saved default')
    assert.equal((fixture.ctx.get('agentPresets') as { defaultId: string }).defaultId, 'fixture-a')
    fixture.pane.key('/preset\r')
    await waitFor('picker ready', () => props(fixture.pane).state === 'ready')
    const fixtureABadges = (items(fixture.pane).find((entry) => entry.id === 'preset:fixture-a')?.badges ?? []) as Array<{ text: string }>
    assert.deepEqual(fixtureABadges, [{ text: 'Default' }], 'the recorded default is that card\'s own badge (Owner ruling "a")')
    // The registry IS a configurable plugin entry here, so the write is offered.
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:fixture-b')
    // The default write is the FOOTER's `Set default` button (the ONE writer, the
    // v4 two-page contract): Tab moves into the footer, one ArrowLeft walks the ring
    // onto `Set default`, Enter commits.
    fixture.pane.key('\t')
    await waitFor('footer focused', () => String(action(fixture.pane, 'use')?.label).includes('[Enter]'))
    fixture.pane.key('\u001b[D')
    await waitFor('default focused', () => String(action(fixture.pane, 'set-default')?.label).includes('[Enter]'))
    fixture.pane.key('\r')
    // The REAL ConfigEditor/Loader writes the selected default into the profile
    // document, and the registry's effective default follows it.
    await waitFor('the profile document holds the new default', () => presetDefaultRow(patchPath) === 'fixture-b')
    await waitFor('picker dismissed', () => pickerNode(fixture.pane, P) === undefined)
    assert.equal((fixture.ctx.get('agentPresets') as { defaultId: string }).defaultId, 'fixture-b')
    assert.equal([...fixture.ctx.agents.list()].length, 0, 'a default write creates no Session')
    // The TYPED verb drives the very same writer: the document flips back.
    await clearComposer(fixture.pane)
    fixture.pane.key('/preset default fixture-a\r')
    await waitFor('the typed verb writes the same document', () => presetDefaultRow(patchPath) === 'fixture-a')
    // A reopened panel reads the new default from the authority.
    fixture.pane.key('/preset\r')
    await waitFor('reopened', () => props(fixture.pane).state === 'ready')
    const reopenedBadges = (items(fixture.pane).find((entry) => entry.id === 'preset:fixture-a')?.badges ?? []) as Array<{ text: string }>
    assert.deepEqual(reopenedBadges, [{ text: 'Default' }], 'the reopened panel reads the default from the authority')
    fixture.pane.key('\u001b')
    await waitFor('closed', () => pickerNode(fixture.pane, P) === undefined)
  } finally {
    await fixture.settle()
  }
  // A FRESH composition composes the same profile document: its only input is
  // the real file saved above, never the original service instance.
  const fresh = new Context()
  life.defer(() => fresh.fiber.dispose())
  await fresh.plugin(Loader)
  const { mountAgentLoopTestDependencies } = await import('@deepseek-ai/dsh-agent-loop-testkit')
  await mountAgentLoopTestDependencies(fresh)
  const { mountPresetProfile } = await import('../../support/preset-profile-fixture.ts')
  const reloaded = await mountPresetProfile(fresh, fixture.workRoot, [])
  assert.equal((fresh.get('agentPresets') as { defaultId: string }).defaultId, 'fixture-a',
    'the new composition reads the persisted default')
  assert.equal(JSON.stringify(reloaded.patches).includes('selectedDefault'), true,
    'and it composes the saved profile document')
})

test('without a Config owner the default write is honestly disabled', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('/preset\r')
    await waitFor('picker ready', () => props(fixture.pane).state === 'ready')
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    // The footer's `Set default` states the real reason (its `disabled` string —
    // Owner ruling "a") and the SAME availability predicate refuses the program's
    // own action channel, so no forged receiver can write either.
    assert.equal(action(fixture.pane, 'set-default')?.disabled, 'Settings unavailable')
    const frames = fixture.pane.frameCount()
    sendPickerAction(fixture.pane, 'set-default', P)
    await settle(600)
    assert.equal(fixture.pane.frameCount(), frames, 'a disabled entry never repaints or dismisses')
    assert.equal(dockText(fixture.pane).includes('new-session default set:'), false)
    assert.equal(dockText(fixture.pane).includes('settings service unavailable'), false)
    // The panel owns the keyboard, so the typed verb runs after it closes.
    fixture.pane.key('\u001b')
    await waitFor('back on the catalogue', () => pickerNode(fixture.pane, P) !== undefined)
    fixture.pane.key('\u001b')
    await waitFor('closed', () => pickerNode(fixture.pane, P) === undefined)
    await clearComposer(fixture.pane)
    fixture.pane.key('/preset default minimal-preset\r')
    await waitFor('settings service unavailable', () => dockText(fixture.pane).includes('settings service unavailable'))
  } finally {
    await fixture.settle()
  }
})
