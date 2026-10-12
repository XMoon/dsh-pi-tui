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
import { createDirectTspFixture, waitFor } from './support/direct-tsp-fixture.ts'
import { ownTspBoot, waitUntil } from './support/tsp-runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { DirectPresetCatalog } from '../src/runtime/direct/catalog-direct.ts'
import {
  PRESET_LAYER_PREFIX as P,
  pickerAction,
  pickerNode,
  pickerProps,
  sendAction,
  wireNodes,
} from './support/tsp-picker-wire.ts'

const props = (pane: { readonly output: unknown } | never): Record<string, unknown> => pickerProps(pane as never, P)
const node = (pane: unknown): unknown => pickerNode(pane as never, P)
const action = (pane: unknown, id: string): Record<string, unknown> | undefined =>
  pickerAction(pane as never, id, P)

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

test('PR4-A: a pane without the picker kind refuses /preset before the handler', async (t) => {
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

test('PR4-A: the real /preset handler opens the native picker over the REAL roster', async (t) => {
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
    const items = (props(fixture.pane).items ?? []) as Array<Record<string, unknown>>
    assert.deepEqual(items.map((entry) => entry.id), ['preset:b2-direct-preset', 'preset:minimal-preset'])
    assert.equal(items[0]?.label, 'B2 direct preset')
    assert.deepEqual(items[0]?.badges, [{ text: 'Default' }])
    assert.match(String(items[1]?.detail), /^Custom · A second real target\.$/)
    // The two session facts are independent display facts of this subject.
    assert.match(dockText(fixture.pane), /Next session: none/)
    assert.match(dockText(fixture.pane), /New-session default: b2-direct-preset/)
    // A sessionless subject can never present a Current row.
    assert.deepEqual(props(fixture.pane).current, [])
    // Browsing and Enter on the list are read-only: the Host writer is untouched.
    sendAction(fixture.pane, 'details', undefined, pickerNode(fixture.pane, P)!.id)
    await waitFor('details page', () => props(fixture.pane).title === 'Preset details')
    assert.equal(switches.length, 0)
    sendAction(fixture.pane, 'back', undefined, pickerNode(fixture.pane, P)!.id)
    await waitFor('back on the list', () => props(fixture.pane).title === 'Agent presets')
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    assert.equal(switches.length, 0, 'browsing never writes')
    fixture.pane.key('\r')
    await waitFor('list Enter is browse-only', () => switches.length === 0 && node(fixture.pane) !== undefined)
    // Esc closes; the picker is a pure view so far.
    fixture.pane.key('\u001b')
    await waitFor('closed', () => node(fixture.pane) === undefined)
    assert.equal(switches.length, 0)
  } finally {
    await fixture.settle()
  }
})

test('PR4-A: sessionless Use stages the run-local pending preset without a Session', async (t) => {
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
    await waitFor('use focused', () => String(action(fixture.pane, 'use')?.label).startsWith('▸'))
    fixture.pane.key('\r')
    await waitFor('staged notice', () => dockText(fixture.pane).includes('new sessions will start on preset minimal-preset'))
    await waitFor('picker dismissed', () => node(fixture.pane) === undefined)
    assert.equal([...fixture.ctx.agents.list()].length, 0, 'staging creates no Session')
    // Reopening the SAME authority shows the staged choice as the Next session.
    fixture.pane.key('/preset\r')
    await waitFor('reopened', () => props(fixture.pane).state === 'ready')
    assert.match(dockText(fixture.pane), /Next session: minimal-preset/)
    assert.equal(props(fixture.pane).selected, 'preset:minimal-preset')
    assert.deepEqual(props(fixture.pane).current, [], 'the next-session choice is not a current badge')
    fixture.pane.key('\u001b')
    await waitFor('closed', () => node(fixture.pane) === undefined)
  } finally {
    await fixture.settle()
  }
})

test('PR4-A: a STARTED Session is refused by the ORIGINAL message, never a picker', async (t) => {
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

/* ------------------------------------------------------------ typed verbs */

test('PR4-A: the typed verbs keep their original Host routes and never open a picker', async (t) => {
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

test('PR4-A: a Host-owned /preset keeps its own route ahead of the TUI registration', async (t) => {
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

/** The faithful settings-service stand-in: the Direct preset-default adapter
 *  mutates exactly this surface (namespace + set-op + revision). */
function settingsStandIn() {
  const mutations: Array<{ ns: string; ops: readonly { op: string; path: readonly string[]; value: unknown }[] }> = []
  return {
    mutations,
    describe: () => [{ ns: 'agent-preset-registry', revision: mutations.length }],
    mutate: async (ns: string, ops: readonly { op: string; path: readonly string[]; value: unknown }[]) => {
      mutations.push({ ns, ops })
      return { revision: mutations.length }
    },
  }
}

/** The default-write mutations only: the runner's own legacy settings migration
 *  goes through the SAME service and is not this write. */
const presetMutations = (settings: ReturnType<typeof settingsStandIn>) =>
  settings.mutations.filter((mutation) => mutation.ns === 'agent-preset-registry')

test('PR4-A: Set new-session default and the typed verb drive ONE settings writer', async (t) => {
  const life = testLifecycle(t)
  const settings = settingsStandIn()
  const fixture = await createDirectTspFixture(life, {
    presetPicker: true,
    settings,
    presets: [{ id: 'minimal-preset', name: 'Minimal preset' }],
  })
  try {
    await waitFor('renderer ready', () => dockText(fixture.pane).includes('dock.composer'))
    fixture.pane.key('/preset\r')
    await waitFor('picker ready', () => props(fixture.pane).state === 'ready')
    // The Config owner is present, so the default write is really offered.
    fixture.pane.key('\u001b[B')
    await waitFor('second preset browsed', () => props(fixture.pane).selected === 'preset:minimal-preset')
    assert.notEqual(action(fixture.pane, 'set-default')?.disabled, true)
    // Focus it explicitly and commit.
    fixture.pane.key('\t')
    await waitFor('use focused', () => String(action(fixture.pane, 'use')?.label).startsWith('▸'))
    fixture.pane.key('\u001b[C')
    await waitFor('default focused', () => String(action(fixture.pane, 'set-default')?.label).startsWith('▸'))
    fixture.pane.key('\r')
    await waitFor('the ONE default mutation', () => presetMutations(settings).length === 1)
    assert.deepEqual(presetMutations(settings)[0], {
      ns: 'agent-preset-registry',
      ops: [{ op: 'set', path: ['selectedDefault'], value: 'minimal-preset' }],
    })
    await waitFor('default notice', () => dockText(fixture.pane)
      .includes('new-session default set: minimal-preset — changes new sessions only'))
    await waitFor('dismissed', () => node(fixture.pane) === undefined)
    // The TYPED verb drives the very same writer.
    fixture.pane.key('/preset default b2-direct-preset\r')
    await waitFor('the second, identical mutation', () => presetMutations(settings).length === 2)
    assert.deepEqual(presetMutations(settings)[1], {
      ns: 'agent-preset-registry',
      ops: [{ op: 'set', path: ['selectedDefault'], value: 'b2-direct-preset' }],
    })
    assert.equal([...fixture.ctx.agents.list()].length, 0, 'a default write creates no Session')
  } finally {
    await fixture.settle()
  }
})

test('PR4-A: without a Config owner the default write is honestly disabled', async (t) => {
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
    assert.equal(action(fixture.pane, 'set-default')?.disabled, true)
    // Dispatching it anyway is a no-op, and the typed verb reports the missing
    // owner through the ORIGINAL message.
    sendAction(fixture.pane, 'set-default', undefined, pickerNode(fixture.pane, P)!.id)
    fixture.pane.key('\r')
    await waitFor('no cue on the disabled action', () => props(fixture.pane).state === 'ready')
    assert.equal(dockText(fixture.pane).includes('new-session default set:'), false)
    fixture.pane.key('/preset default minimal-preset\r')
    await waitFor('settings service unavailable', () => dockText(fixture.pane).includes('settings service unavailable'))
  } finally {
    await fixture.settle()
  }
})
