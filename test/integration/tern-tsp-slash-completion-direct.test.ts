/**
 * TSP I-C (the first-line slash completion) on the OFFICIAL Direct composition.
 *
 * Every case here boots the real Direct application (`support/direct-tsp-fixture.ts`:
 * real rc.2 Host services + live Agents, the real `CommandRuntime` catalog, the real
 * `dsh-skill` registry, the real runner + `SubmissionController`, the real TSP
 * renderer over a scripted pane, the real `$DSH_HOME/user-history` file and the real
 * Client-local attachment store). Candidates are read back from the actual
 * `ui.editor`-anchored wire — the row nodes the SDK really sent — never from a
 * hand-built catalog: no case feeds the menu, the only install path is the production
 * `registerTuiCommands` commit point.
 *
 * EVIDENCE LEVEL: official Direct composition + SDK wire. STAND-INS: the scripted
 * pane (its advertised `el` kind IS the handshake) and the scripted streaming model.
 * ABSENT: a physical Tern GUI/OS input path and a user profile.
 *
 * LANE BOUNDARY: the seat's own interaction semantics on the mount are
 * `test/tui/tern-tsp-slash-completion.test.ts`; this file owns the OFFICIAL Direct
 * composition — the real registry provenance, a real Session create/resume and the
 * real persistence behind what the first-line menu shows and what an accept leaves.
 *
 * GENUINE Host-origin rows used as evidence (read back from the real registry, never
 * fabricated): `/permission`, registered by the shipped
 * `@deepseek-ai/dsh-permission-presets` plugin through its own production row
 * (`definitionId "@deepseek-ai/dsh-permission-presets"`), and `/settings`, a Host
 * command registered into the real catalog BEFORE the runner boots through the
 * fixture's documented `hostCommands` seam — the TUI's own same-name Host mirror is
 * refused as a duplicate there, so the Host definition really is the winner and the
 * case observes its sink. Per-Session candidate tracking uses the official per-agent
 * seam the Host registry itself names (`agent.ctx.get('commands').register(...)`),
 * i.e. a real agent-scoped Host command read back with `commands.list(agent)`.
 * @module @xmoon76/dsh-pi-tui/test/integration/tern-tsp-slash-completion-direct
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { createDirectTspFixture, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { SLASH_COMPLETION_MAX_ROWS } from '../../src/tui/tsp/slash-completion.ts'

/** The seat's own painted-row window: read the production constant, never a
 *  copy that can drift from the surface it is asserting on. */
const MAX_ROWS = SLASH_COMPLETION_MAX_ROWS

/** The bounded observation window for this file's ABSENCE claims. The bound is not a
 *  guess: the pane acks every drawn frame before the SDK sends its next View, and a
 *  candidate list is painted by that same frame path, so any list this mount was going
 *  to show has already been drawn (or withdrawn) when the window closes. */
const ABSENCE_WINDOW_MS = 400

const ENTER = '\r'
const ESCAPE = '\u001b'
const BACKSPACE = '\x7f'
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/** One parsed history row, read back through the real store the fixture writes. */
interface Row {
  readonly content?: unknown
}

/** The real Host command registry view this composition publishes. */
interface RegistryCommand {
  readonly name: string
  readonly description?: string
  readonly definitionId?: string
}

interface Registry {
  list(agent?: unknown): readonly RegistryCommand[]
  find(agent: unknown, name: string): { readonly definitionId?: string; readonly description?: string } | undefined
  register(definition: unknown): () => void
}

/** The styled candidate rows the SDK currently carries. */
function slashRows(fixture: DirectTspFixture): WireNode[] {
  return wireNodes(fixture.pane).filter(node => node.k === 'el' && /\.slash-[^.]+$/.test(node.id))
}

/** The catalog's own row text: `<name> — <description>` as the painter received it. */
function rowTitles(fixture: DirectTspFixture): string[] {
  return slashRows(fixture).map(node => String(node.p.title ?? ''))
}

/** The candidate NAMES currently offered, without their descriptions. */
function rowNames(fixture: DirectTspFixture): string[] {
  return rowTitles(fixture).map(title => title.split(' — ')[0]!)
}

function commandRow(fixture: DirectTspFixture, name: string): WireNode | undefined {
  return slashRows(fixture).find(node => String(node.p.title ?? '').startsWith(`/${name} `))
}

function registry(fixture: DirectTspFixture): Registry {
  return fixture.ctx.get('commands') as unknown as Registry
}

function registryNames(fixture: DirectTspFixture, agent?: unknown): string[] {
  return registry(fixture).list(agent).map(command => command.name)
}

function composerNode(fixture: DirectTspFixture): WireNode | undefined {
  return wireNodes(fixture.pane).find(node => node.id === 'dock.quiet-composer.composer'
    || node.id === 'dock.composer')
}

function composerText(fixture: DirectTspFixture): string {
  return String(composerNode(fixture)?.p.text ?? '')
}

function composerCursor(fixture: DirectTspFixture): number {
  const node = composerNode(fixture)
  return node === undefined ? -1 : Number(node.p.cursor ?? -1)
}

/** Every file the real Client-local attachment store holds under this work root. */
function stagedAttachmentFiles(workRoot: string): string[] {
  const root = join(workRoot, 'attachments')
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out.sort()
}

function historyRows(workRoot: string): Row[] {
  const dir = join(workRoot, 'user-history')
  if (!isDirectory(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Row))
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

async function sessionHeaders(fixture: DirectTspFixture): Promise<string[]> {
  const persistence = fixture.ctx.get('sessionPersistence') as unknown as {
    list(): Promise<readonly { header: { id: string } }[]>
  }
  return (await persistence.list()).map(entry => entry.header.id)
}

async function waitForSessionHeaders(fixture: DirectTspFixture, expected: number, label: string): Promise<string[]> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const ids = await sessionHeaders(fixture)
    if (ids.length === expected) return ids
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (got ${JSON.stringify(ids)})`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function liveAgentIds(fixture: DirectTspFixture): string[] {
  const agents = fixture.ctx.get('agents') as unknown as {
    list(): readonly { session: { id: string } }[]
  }
  return agents.list().map(agent => agent.session.id)
}

function liveAgent(fixture: DirectTspFixture, sessionId: string): object {
  const agents = fixture.ctx.get('agents') as unknown as {
    list(): readonly { session: { id: string } }[]
  }
  const agent = agents.list().find(entry => entry.session.id === sessionId)
  assert.ok(agent, `the live Agent for ${sessionId} exists (have ${JSON.stringify(liveAgentIds(fixture))})`)
  return agent as unknown as object
}

/** The official per-agent command seam the Host registry itself names. */
function agentCommands(fixture: DirectTspFixture, agent: object): Registry {
  const scoped = (agent as { ctx?: { get(name: string): unknown } }).ctx
  assert.ok(scoped, 'a live Agent carries its own scoped Cordis context')
  const commands = scoped.get('commands') as Registry | undefined
  assert.ok(commands, 'the agent context resolves the real command registry')
  return commands
}

/** The wire state a timed-out wait puts in its failure, so a red lane is locatable. */
function wireState(fixture: DirectTspFixture): string {
  return `composer=${JSON.stringify(composerText(fixture))} cursor=${composerCursor(fixture)} rows=${JSON.stringify(rowNames(fixture))}`
}

/** Wait on a renderer fact, and name the observed wire state when it never lands. */
async function settle(fixture: DirectTspFixture, label: string, predicate: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${wireState(fixture)})`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Poll a renderer fact for a bounded number of frame cycles without failing. */
async function waitsFor(predicate: () => boolean, attempts = 80): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return predicate()
}

/** Wait until the composer physically accepts a printable probe, then erase it. A key
 *  the hydration fence DROPS never reaches the wire, so this — not a sleep — is the
 *  authority that the NEXT keystroke is consumed (the sibling recall lane's shape). */
async function composerReady(fixture: DirectTspFixture): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    fixture.pane.input.type('x')
    const accepted = await waitsFor(() => composerText(fixture) === 'x' && composerCursor(fixture) === 1)
    if (accepted) {
      fixture.pane.input.type(BACKSPACE)
      if (await waitsFor(() => composerText(fixture) === '' && composerCursor(fixture) === 0)) return
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the composer to accept a real typed probe (${wireState(fixture)})`)
    }
    // Whatever the wire shows now (a dropped probe, a stacked marker) is erased before
    // the next attempt, so a retry can never leave a stray byte behind.
    for (let index = 0; index < composerText(fixture).length; index += 1) fixture.pane.input.type(BACKSPACE)
    await waitsFor(() => composerText(fixture) === '' && composerCursor(fixture) === 0)
  }
}

/** Type one draft through the real key path and wait for the wire to carry it. */
async function typeDraft(fixture: DirectTspFixture, draft: string): Promise<void> {
  fixture.pane.input.type(draft)
  await settle(fixture, `the composer to hold ${JSON.stringify(draft)}`, () =>
    composerText(fixture) === draft && composerCursor(fixture) === draft.length)
}

/** ONE real printable edit at the caret, then wait for the wire to carry the result. */
async function editAtCaret(fixture: DirectTspFixture, expected: string, chars: string): Promise<void> {
  fixture.pane.input.type(chars)
  await settle(fixture, `the composer to hold ${JSON.stringify(expected)}`, () =>
    composerText(fixture) === expected && composerCursor(fixture) === expected.length)
}

/** Erase a draft with real backspaces. A draft edit also retires an open list — that
 *  IS the seat's documented behaviour, and this lane never needs an invisible list. */
async function eraseDraft(fixture: DirectTspFixture): Promise<void> {
  for (let index = 0; index < composerText(fixture).length; index += 1) fixture.pane.input.type(BACKSPACE)
  await settle(fixture, 'the composer to be empty', () =>
    composerText(fixture) === '' && composerCursor(fixture) === 0)
}

/** Land one exact draft through the real key path, on a composer proven editable. */
async function prepareDraft(fixture: DirectTspFixture, draft: string): Promise<void> {
  await eraseDraft(fixture)
  await composerReady(fixture)
  if (draft.startsWith(PASTE_START)) {
    fixture.pane.input.type(draft)
    const text = draft.slice(PASTE_START.length, draft.length - PASTE_END.length)
    await settle(fixture, `the pasted draft ${JSON.stringify(text)}`, () => composerText(fixture) === text)
    return
  }
  await typeDraft(fixture, draft)
}

/** Close an open candidate list with the real Escape, which the seat consumes and the
 *  draft never notices. With no list open this sends NOTHING: an unowned Escape would
 *  reach the application's cancel owner, which is not this gesture's business. */
async function dismissList(fixture: DirectTspFixture): Promise<void> {
  if (slashRows(fixture).length === 0) return
  const mark = fixture.pane.frameCount()
  fixture.pane.input.type(ESCAPE)
  await settle(fixture, 'Escape to close the candidate list', () =>
    fixture.pane.frameCount() > mark && slashRows(fixture).length === 0)
}

/**
 * Land a command line and press the Enter that SUBMITS it.
 *
 * The gesture ORDER is the point: while a candidate list is open a PLAIN Enter belongs
 * to the completion seat (it completes the name and submits nothing), so the lane
 * dismisses the list first — what a user who means to run the line does — and only then
 * presses Enter. Every caller then waits on ITS own observable effect, never on a
 * guessed window.
 */
async function submitCommand(fixture: DirectTspFixture, line: string): Promise<void> {
  await prepareDraft(fixture, line)
  await dismissList(fixture)
  assert.equal(slashRows(fixture).length, 0, 'no candidate list is open, so this Enter is the submit gesture')
  fixture.pane.input.type(ENTER)
  await waitsFor(() => composerText(fixture) !== line)
}

/** Query one command token through the real key path and wait for the list it paints. */
async function queryRows(fixture: DirectTspFixture, token: string): Promise<WireNode[]> {
  await prepareDraft(fixture, token)
  await settle(fixture, `the candidate list for ${JSON.stringify(token)}`, () => slashRows(fixture).length > 0)
  return slashRows(fixture)
}

/**
 * Query one token until the CURRENT catalog commit actually offers `name`.
 *
 * A catalog install replaces the seat's source and withdraws the painted list, and the
 * seat re-queries only on the next composer edit — so a token typed while a commit is
 * in flight can correctly show nothing. Re-typing is the real user gesture, never a
 * re-synthesized menu.
 */
async function queryUntil(fixture: DirectTspFixture, token: string, name: string, label: string): Promise<void> {
  const deadline = Date.now() + 25_000
  for (;;) {
    await prepareDraft(fixture, token)
    if (rowNames(fixture).includes(`/${name}`)) return
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label} (${wireState(fixture)})`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Deliver a real pointer click for one node id the pane once received. */
function clickRow(fixture: DirectTspFixture, id: string): void {
  fixture.pane.event({ ev: 'action', sf: fixture.pane.frames().at(-1)!.sf, id, act: 'click' })
}

/** Hold the wire still for the bounded negative window, then read it. */
async function observeNothing(fixture: DirectTspFixture): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS)) // reason: bounded negative observation window; the pane's frame-credit ack cycle already covers every list this mount could paint
}

test('a launch with no Session yet offers the real registered catalog to the first input, and accepting a candidate writes its name and submits nothing', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['IC-CATALOG'], composerActions: true })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    assert.deepEqual(await sessionHeaders(fixture), [], 'the launch owns no Session yet')

    const slash = await queryRows(fixture, '/')
    assert.equal(slash.length, MAX_ROWS,
      `the launch catalog overflows the seat window, which stays bounded (got ${slash.length})`)
    const offered = rowNames(fixture)
    const catalog = registryNames(fixture)
    assert.equal(catalog.length > 0, true, 'the real Host registry holds the launch catalog')
    for (const name of offered) {
      assert.equal(catalog.includes(name.replace(/^\//, '')), true,
        `${name} is a REAL registered command (registry: ${JSON.stringify(catalog)})`)
    }
    t.diagnostic(`launch catalog rows=${JSON.stringify(offered)} of registry=${JSON.stringify(catalog)}`)

    const narrow = await queryRows(fixture, '/ne')
    assert.equal(rowNames(fixture).includes('/new'), true,
      `/ne offers the registered /new (got ${JSON.stringify(rowNames(fixture))})`)
    assert.equal(narrow.length <= MAX_ROWS, true, 'the list stays inside the seat budget')

    fixture.pane.input.type(ENTER)
    await waitFor('the accept to write the command name', () =>
      composerText(fixture) === '/new ' && composerCursor(fixture) === 5, 25_000)
    assert.equal(slashRows(fixture).length, 0, 'the accepted frame carries no stale list')
    assert.deepEqual(await sessionHeaders(fixture), [], 'accepting a candidate created no Session')
    assert.equal(recorder.calls(), 0, 'accepting a candidate submitted nothing')
    assert.equal(fixture.modelCalls(), 0, 'accepting a candidate never reached the model')
    await observeNothing(fixture)
    assert.deepEqual(await sessionHeaders(fixture), [], 'and still no Session appears after the window')
    assert.equal(composerText(fixture), '/new ', 'the draft is left for the user to submit')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('a real TSP Enter on the accepted line runs the classified winner exactly once and the accept itself ran nothing', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['IC-ONCE'], composerActions: true })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    await queryRows(fixture, '/ne')
    fixture.pane.input.type(ENTER)
    await waitFor('the accept to complete the name', () => composerText(fixture) === '/new ', 25_000)
    assert.deepEqual(await sessionHeaders(fixture), [], 'the accept itself produced zero command effect')
    assert.equal(recorder.calls(), 0, 'the accept produced no business submission')
    assert.equal(slashRows(fixture).length, 0, 'the accept closed the list, so the next Enter is the submit gesture')

    fixture.pane.input.type(ENTER)
    const [sessionA] = await waitForSessionHeaders(fixture, 1, 'the /new Session in the real store')
    assert.ok(sessionA, 'the completed line created a Session')
    await waitFor('the new Session to own a live Agent', () => liveAgentIds(fixture).includes(sessionA), 30_000)
    await composerReady(fixture)
    await observeNothing(fixture)
    assert.equal((await sessionHeaders(fixture)).length, 1,
      'exactly ONE Session was created: the accepted line ran its winner once, not twice')
    assert.equal(recorder.calls(), 0, 'a command line is not an agent-facing submission')
    assert.equal(fixture.modelCalls(), 0, 'the winner ran through the command plane, never the model')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('a genuine Host-owned command keeps its row where the TUI gate withdraws that name, and the Host winner is the one that runs', async (t) => {
  const life = testLifecycle(t)
  const invocations: string[] = []
  const fixture = await createDirectTspFixture(life, {
    deltas: ['IC-HOST'],
    composerActions: true,
    officialServices: { permissionPresets: true },
    hostCommands: [{
      name: 'settings',
      description: 'genuine Host settings sink',
      handler: (invocation) => {
        invocations.push(invocation.rawInput)
        return { kind: 'success' }
      },
    }],
  })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    const global = registry(fixture).list(undefined)
    const permission = global.find(command => command.name === 'permission')
    assert.ok(permission, `/permission is in the real registry (got ${JSON.stringify(global.map(row => row.name))})`)
    assert.equal(String(permission.definitionId).includes('dsh-permission-presets'), true,
      `the shipped permission plugin owns the row (definitionId ${String(permission.definitionId)})`)
    const settings = registry(fixture).find(undefined, 'settings')
    assert.equal(settings?.definitionId, undefined,
      `the winning /settings definition is the Host one, not the TUI mirror (got ${JSON.stringify(settings)})`)
    assert.equal(settings?.description, 'genuine Host settings sink', 'the Host definition really owns the name')

    await queryRows(fixture, '/pe')
    assert.equal(rowNames(fixture).includes('/permission'), true,
      `the shipped plugin's Host command is offered (got ${JSON.stringify(rowNames(fixture))})`)
    assert.equal(slashRows(fixture).length < MAX_ROWS, true, 'the window is complete, so the next absence is a fact')
    assert.equal(rowNames(fixture).includes('/preset'), false,
      'the TUI /preset IS withdrawn on this mount, so a name-hiding gate is genuinely live here')

    // `/settings` is a TUI builtin this renderer cannot run; the gate may still never
    // hide it, because its winner is a genuine Host command.
    await queryUntil(fixture, '/set', 'settings', 'the Host-owned /settings row is offered')
    assert.ok(commandRow(fixture, 'settings'), 'the /settings candidate is addressed on the wire')

    await submitCommand(fixture, '/settings')
    await waitFor('the Host /settings sink to run', () => invocations.length === 1, 25_000)
    await observeNothing(fixture)
    assert.equal(invocations.length, 1, `the Host winner ran exactly once (rawInputs ${JSON.stringify(invocations)})`)
    assert.equal(fixture.pane.output.text().includes('not available in TSP'), false,
      'the Host winner is never refused by the TUI-builtin gate')
    assert.equal(recorder.calls(), 0, 'the Host command ran through the command plane')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('a TUI builtin this renderer cannot run is never offered as a bare candidate, while submitting it keeps its existing refusal', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['IC-GATE'], composerActions: true })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    // Positive control first: the seat IS live, so an absence below is a screen and
    // not a broken popup.
    await queryRows(fixture, '/ne')
    assert.equal(rowNames(fixture).includes('/new'), true, 'an admitted builtin is offered')

    const withdrawn: Array<[token: string, name: string]> = [
      ['/set', 'settings'],
      ['/hel', 'help'],
      ['/log', 'login'],
      ['/log', 'logout'],
      ['/mod', 'model'],
      ['/pre', 'preset'],
      ['/res', 'resume'],
      ['/ses', 'sessions'],
      ['/sea', 'search'],
      ['/tas', 'tasks'],
      ['/suba', 'subagents'],
      ['/rew', 'rewind'],
      ['/ke', 'keybindings'],
      ['/tran', 'transcript'],
      ['/foc', 'focus'],
      ['/disp', 'display'],
      ['/stat', 'status'],
      ['/plu', 'plugins'],
    ]
    for (const [token, name] of withdrawn) {
      // The name IS a real registered command on this mount, so the absence below is
      // the renderer-capability screen — never a command that simply does not exist.
      assert.equal(registryNames(fixture).includes(name), true,
        `/${name} is registered in the real catalog (registry: ${JSON.stringify(registryNames(fixture))})`)
      await prepareDraft(fixture, token)
      await observeNothing(fixture)
      const rows = rowNames(fixture)
      assert.equal(rows.length < MAX_ROWS, true,
        `the window for ${JSON.stringify(token)} is complete, so its absence is a fact (got ${JSON.stringify(rows)})`)
      assert.equal(rows.includes(`/${name}`), false,
        `${JSON.stringify(token)} never offers the unrunnable TUI builtin /${name} (got ${JSON.stringify(rows)})`)
      await eraseDraft(fixture)
    }

    // The business behaviour is UNCHANGED: submitting the original text still takes
    // the existing post-classification TSP admission refusal and restores the draft.
    for (const line of ['/settings', '/help']) {
      await submitCommand(fixture, line)
      await waitFor(`the existing refusal for ${line}`, () =>
        fixture.pane.output.text().includes('This command\'s UI is not available in TSP yet'), 25_000)
      await waitFor(`the refused draft ${line} is restored`, () => composerText(fixture) === line, 25_000)
      await eraseDraft(fixture)
    }
    assert.equal(recorder.calls(), 0, 'a refused builtin never became a business submission')
    assert.equal(fixture.modelCalls(), 0, 'a refused builtin never reached the model')
    assert.deepEqual(historyRows(fixture.workRoot), [], 'a refused builtin persisted no recall row')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('a session switch A → B → A offers the live Session’s own candidates, keeps A’s open list from being accepted into B, and re-queries on the return', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['IC-SWITCH'],
    composerActions: true,
    sessionBrowser: true,
  })
  const recorder = fixture.recordPrompts(() => {})
  const disposers: Array<() => void> = []
  try {
    await waitForInputDelivery(fixture.pane)
    await submitCommand(fixture, '/new')
    const [sessionA] = await waitForSessionHeaders(fixture, 1, 'Session A')
    await waitFor('A to own a live Agent', () => liveAgentIds(fixture).includes(sessionA), 30_000)

    // A REAL agent-scoped Host command, through the official per-agent seam, so the
    // candidate set genuinely differs between the two Sessions.
    disposers.push(agentCommands(fixture, liveAgent(fixture, sessionA)).register({
      name: 'ic-scope-a',
      description: 'a genuine agent-scoped Host command',
      handler: () => ({ kind: 'success' }),
    }))
    await queryUntil(fixture, '/ic-s', 'ic-scope-a', 'A’s own catalog offers the row registered on A')
    assert.equal(registryNames(fixture, liveAgent(fixture, sessionA)).includes('ic-scope-a'), true,
      'the row comes from A’s effective catalog read, not from a test-side list')

    const openAt = slashRows(fixture).map(node => node.id)
    const liveRow = openAt.find(id => id.endsWith('_ic-scope-a'))
    assert.ok(liveRow, 'the open list carries its own row identity')
    clickRow(fixture, liveRow)
    await waitFor('the current click to complete the name', () => composerText(fixture) === '/ic-scope-a ', 25_000)
    assert.equal(recorder.calls(), 0, 'a click completes; it never submits')
    await eraseDraft(fixture)

    // Re-open A’s list and capture its frame identity, then switch. Through the real
    // composer every draft edit retires the browse before the `/new` line is submitted
    // (the sibling recall lane records the same fact), so what survives the switch is
    // A’s painted FRAME — which is exactly what a stale pointer click delivers.
    await queryRows(fixture, '/ic-s')
    const aRowId = slashRows(fixture).map(node => node.id).find(id => id.endsWith('_ic-scope-a'))
    assert.ok(aRowId, 'A’s open list carries its own row identity')
    await eraseDraft(fixture)
    await submitCommand(fixture, '/new')
    const headers = await waitForSessionHeaders(fixture, 2, 'Session B')
    const sessionB = headers.find(id => id !== sessionA)
    assert.ok(sessionB, '/new published a different real Session')
    await waitFor('B to own the live Agent', () =>
      liveAgentIds(fixture).includes(sessionB) && !liveAgentIds(fixture).includes(sessionA), 30_000)

    clickRow(fixture, aRowId)
    await observeNothing(fixture)
    assert.equal(composerText(fixture), '', 'A’s retired row cannot write into B’s composer')
    assert.equal((await sessionHeaders(fixture)).length, 2, 'a stale click ran no command')
    assert.equal(recorder.calls(), 0, 'a stale click submitted nothing')

    disposers.push(agentCommands(fixture, liveAgent(fixture, sessionB)).register({
      name: 'ic-scope-b',
      description: 'a genuine agent-scoped Host command for the other Session',
      handler: () => ({ kind: 'success' }),
    }))
    await queryUntil(fixture, '/ic-s', 'ic-scope-b', 'B’s catalog offers B’s own row')
    assert.equal(rowNames(fixture).includes('/ic-scope-a'), false,
      `the candidates follow the current Session, never the previous one (got ${JSON.stringify(rowNames(fixture))})`)

    await eraseDraft(fixture)
    await submitCommand(fixture, `/resume ${sessionA}`)
    await waitFor('A to own the live Agent again', () =>
      liveAgentIds(fixture).includes(sessionA) && !liveAgentIds(fixture).includes(sessionB), 30_000)

    await prepareDraft(fixture, '/ic-s')
    await observeNothing(fixture)
    const backAt = rowNames(fixture)
    assert.equal(backAt.includes('/ic-scope-b'), false,
      `B’s scoped row never followed the switch back to A (got ${JSON.stringify(backAt)})`)
    assert.equal(backAt.includes('/ic-scope-a'), false,
      'and A’s earlier row went with the Agent instance it was registered on — the catalog always re-reads the live owner')
    await eraseDraft(fixture)

    await queryRows(fixture, '/ne')
    assert.equal(rowNames(fixture).includes('/new'), true,
      `a fresh query on the returned Session paints again (got ${JSON.stringify(rowNames(fixture))})`)
    fixture.pane.input.type(ENTER)
    await waitFor('the fresh accept to complete the name', () => composerText(fixture) === '/new ', 25_000)
    assert.equal((await sessionHeaders(fixture)).length, 2, 'the fresh accept ran nothing')
  } finally {
    for (const dispose of disposers) dispose()
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('a dynamic Skill wrapper enters the first-line candidates when the real catalog installs it and leaves when the catalog rolls', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['IC-SKILL'],
    composerActions: true,
    skills: [{ name: 'ic-standing-skill', description: 'A standing fixture skill', body: 'Stand.' }],
  })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    await queryRows(fixture, '/ic-st')
    const standing = commandRow(fixture, 'ic-standing-skill')
    assert.ok(standing, `the installed wrapper is a first-line candidate (got ${JSON.stringify(rowNames(fixture))})`)
    assert.equal(String(standing.p.title).includes('[skill] A standing fixture skill'), true,
      'the row description is the catalog’s own skill composition')

    await eraseDraft(fixture)
    await prepareDraft(fixture, '/ic-dyn')
    await observeNothing(fixture)
    assert.equal(rowNames(fixture).includes('/ic-dynamic-skill'), false, 'nothing is offered before the install')
    assert.equal(registryNames(fixture).includes('ic-dynamic-skill'), false,
      'the real registry holds no such wrapper yet')

    // The REAL skill registry: one more provider on the official service, which fires
    // the genuine `skills/change` roll the production refresh owner reads.
    const skills = fixture.ctx.get('skills') as unknown as {
      registerProvider(create: (control: unknown) => unknown): () => void
    }
    const disposeProvider = skills.registerProvider(() => ({
      name: 'direct-ic-lane-provider',
      list: async () => [{
        name: 'ic-dynamic-skill',
        description: 'a dynamic lane skill',
        rank: 10,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'direct-ic-lane-provider',
        locator: { name: 'ic-dynamic-skill' },
      }],
      get: async (candidate: { locator: { name: string } }) => ({
        name: candidate.locator.name,
        description: 'a dynamic lane skill',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'direct-ic-lane-provider',
        locator: candidate.locator,
        content: 'Dynamic.',
      }),
    }))

    await queryUntil(fixture, '/ic-dyn', 'ic-dynamic-skill', 'the real catalog install puts the wrapper on the wire')
    const dynamic = commandRow(fixture, 'ic-dynamic-skill')
    assert.ok(dynamic, 'the new wrapper is offered as a first-line candidate')
    assert.equal(String(dynamic.p.title).includes('[skill] a dynamic lane skill'), true,
      'the candidate row carries the skill description the catalog composed')
    assert.equal(registryNames(fixture).includes('ic-dynamic-skill'), true,
      'the wrapper is a real registered command, not a presentation-only row')

    disposeProvider()
    // The authoritative bound: the wrapper is unwound INSIDE the same synchronous
    // catalog commit that re-publishes the completions, so once the real registry no
    // longer resolves the name, the seat’s source has already been replaced.
    await waitFor('the real registry to drop the wrapper', () =>
      !registryNames(fixture).includes('ic-dynamic-skill'), 30_000)
    await observeNothing(fixture)
    await queryRows(fixture, '/ic-st')
    assert.equal(rowNames(fixture).includes('/ic-standing-skill'), true,
      `the roll did not withdraw the catalog that is still authoritative (got ${JSON.stringify(rowNames(fixture))})`)

    await prepareDraft(fixture, '/ic-dyn')
    await observeNothing(fixture)
    assert.equal(rowNames(fixture).includes('/ic-dynamic-skill'), false,
      'the rolled-off wrapper is no longer offered as a first-line candidate')
    assert.equal(recorder.calls(), 0, 'a candidate query never submitted anything')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('the same accepted text twice creates one real history row and one candidate row, never a phantom second entry', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['IC-REPEAT'], composerActions: true })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    for (const _attempt of [0, 1]) {
      await queryRows(fixture, '/ne')
      fixture.pane.input.type(ENTER)
      await waitFor('the accept to complete /new', () => composerText(fixture) === '/new ', 25_000)
      assert.equal(slashRows(fixture).length, 0, 'the accepted frame shows no list')
      fixture.pane.input.type(ENTER)
      await waitFor('the submitted line to leave the composer', () => composerText(fixture) !== '/new ', 30_000)
      await composerReady(fixture)
    }
    const headers = await waitForSessionHeaders(fixture, 2, 'the two /new Sessions')
    assert.equal(headers.length, 2, 'two accepted submissions ran the winner once each')
    const contents = historyRows(fixture.workRoot).map(row => row.content)
    assert.deepEqual(contents, ['/new'],
      `the real store kept ONE row for the repeated text (got ${JSON.stringify(contents)})`)

    const fresh = await queryRows(fixture, '/ne')
    assert.deepEqual(rowNames(fixture).filter(name => name === '/new'), ['/new'],
      `exactly one /new candidate row is offered (got ${JSON.stringify(rowNames(fixture))})`)
    assert.equal(fresh.length <= MAX_ROWS, true, 'the list is still inside its budget')
    assert.equal(recorder.calls(), 0, 'a command line is never an agent-facing submission')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('an argument position, an at-mention, a shell line, a pasted second line and ordinary prose offer no candidates and stage no file state', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['IC-FENCE'], composerActions: true })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    const attachable = join(fixture.workRoot, 'lane-note.pdf')
    writeFileSync(attachable, Buffer.from('%PDF-1.7 lane note'))
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [], 'the attachment store starts with no staged object')

    const cases: ReadonlyArray<{ readonly typed: string; readonly draft: string }> = [
      { typed: `/attach ${attachable}`, draft: `/attach ${attachable}` },
      { typed: '/image lane-note.pdf', draft: '/image lane-note.pdf' },
      { typed: '@lane', draft: '@lane' },
      { typed: '!echo hi', draft: '!echo hi' },
      { typed: '!!echo hi', draft: '!!echo hi' },
      { typed: `${PASTE_START}first line\n/ne${PASTE_END}`, draft: 'first line\n/ne' },
      { typed: 'hello /ne', draft: 'hello /ne' },
      { typed: '/usr/bi', draft: '/usr/bi' },
    ]
    for (const entry of cases) {
      await prepareDraft(fixture, entry.typed)
      // ONE real printable edit at the caret: the natural trigger runs against THIS
      // document, exactly as a user's next keystroke would.
      await editAtCaret(fixture, `${entry.draft}x`, 'x')
      await observeNothing(fixture)
      assert.equal(slashRows(fixture).length, 0, `${JSON.stringify(entry.draft)} paints no candidate row`)
      assert.equal(composerText(fixture), `${entry.draft}x`,
        `the draft ${JSON.stringify(entry.draft)} was never auto-completed`)
      await eraseDraft(fixture)
    }

    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [],
      'typing an attach/path token staged no attachment object')
    assert.deepEqual(historyRows(fixture.workRoot), [], 'nothing was submitted, so the real store holds no row')
    assert.deepEqual(await sessionHeaders(fixture), [], 'no draft created a Session')
    assert.equal(recorder.calls(), 0, 'no draft produced a business submission')
    assert.equal(fixture.modelCalls(), 0, 'no draft reached the model')
    assert.equal(fixture.pane.output.text().includes('[file #'), false, 'no canonical attachment token entered the wire')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})
