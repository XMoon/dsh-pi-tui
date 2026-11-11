/**
 * TSP I-C (the first-line slash completion) + I-D (the Host `@` reference, the
 * declared `/attach` + `/image` argument, the body inline action and the inline
 * attachment intake) on the OFFICIAL Direct composition.
 *
 * HOST ROUTE PROVEN HERE (read this before crediting any `@` row): the Direct
 * adapter routes an `@` query by the TOKEN's own form — an EXPLICIT path scope
 * (`@src/tui/…`, `@../…`, `@/abs`) runs the real Host scoped discovery
 * (`runtime/direct/file-completion/host-discovery.ts`) over the real workspace, while a
 * BARE fuzzy query (`@editor`) delegates to the official `ctx.fileReferences`
 * provider, which THIS fixture mounts as the documented empty workspace-index
 * stand-in. The `@` cases below therefore prove the explicit-scope route against real
 * workspace files, and prove the bare route answers its authoritative empty WITHOUT a
 * Client-local fallback; the bare-fuzzy POSITIVE (a real provider ranking a fuzzy
 * query) cannot be proven against this stand-in and stays owned by
 * `test/domain/file-completion-convergence.test.ts` and
 * `test/app/pi-tui-file-reference-host.test.ts`.
 *
 * Every case here boots the real Direct application (`support/direct-tsp-fixture.ts`:
 * real rc.2 Host services + live Agents, the real `CommandRuntime` catalog, the real
 * `dsh-skill` registry, the real runner + `SubmissionController`, the real TSP
 * renderer over a scripted pane, the real `$DSH_HOME/user-history` file and the real
 * Client-local attachment store). Candidates are read back from the actual
 * `ui.editor`-anchored wire — the row nodes the SDK really sent — never from a
 * hand-built catalog: no case feeds the menu, the only install path is the production
 * `registerTuiCommands` commit point, and the only inline-attachment stager is the
 * production `artifactCommands.inlineAttachmentStager()` that SAME commit installs on
 * the real mount — no case injects a stager, and no case is handed a pre-staged
 * placeholder.
 *
 * EVIDENCE LEVEL: official Direct composition + SDK wire. STAND-INS: the scripted
 * pane (its advertised `el` kind IS the handshake) and the scripted streaming model.
 * ABSENT: a physical Tern GUI/OS input path and a user profile.
 *
 * LANE BOUNDARY: the seat's own interaction semantics on the mount are
 * `test/tui/tern-tsp-input-completion.test.ts`; this file owns the OFFICIAL Direct
 * composition — the real registry provenance, a real Session create/resume, the real
 * Host file port, the real Client-local intake/draft stores and the real delivered
 * prompt behind what the seat shows and what an accept leaves.
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
 * @module @xmoon76/dsh-pi-tui/test/integration/tern-tsp-input-completion-direct
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { createDirectTspFixture, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { waitForEditableComposer } from '../support/tsp-composer-readiness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { INPUT_COMPLETION_MAX_ROWS } from '../../src/tui/tsp/input-completion.ts'
import { readImageFileUninjected, setImageReadForTest } from '../../src/client/media/image/intake.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { TRANSCRIPT_SAVE_UNAVAILABLE_TEXT } from '../../src/app/command/tsp-capability.ts'

/** The seat's own painted-row window: read the production constant, never a
 *  copy that can drift from the surface it is asserting on. */
const MAX_ROWS = INPUT_COMPLETION_MAX_ROWS

/** The bounded observation window for this file's ABSENCE claims. The bound is not a
 *  guess: the pane acks every drawn frame before the SDK sends its next View, and a
 *  candidate list is painted by that same frame path, so any list this mount was going
 *  to show has already been drawn (or withdrawn) when the window closes. */
const ABSENCE_WINDOW_MS = 400

const ENTER = '\r'
const ESCAPE = '\u001b'
const BACKSPACE = '\x7f'
const RIGHT = '\u001b[C'
const LEFT = '\u001b[D'
const END = '\u001b[F'
/** Shift+Enter is the Composer’s own newline gesture (I-D needs a real multi-line
 *  draft); the SDK decodes this exact CSI-u sequence into `enter` + `shift`. */
const SHIFT_ENTER = '\u001b[13;2u'
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

/** The TSP builtin admission refusal the command plane publishes as a dock notice. */
const TSP_BUILTIN_REFUSAL = "This command's UI is not available in TSP yet"

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

/**
 * The styled candidate rows the SDK currently carries, for ANY seat (the I-C
 * command token, a Host `@` reference, a local path argument, an inline action).
 * A row is the popup's own `button` node; its MENU container, its hint line and
 * the row's inner text/description spans are NOT rows. The previous
 * `\.completion-[^.]+$` shape silently dropped every row whose value contains a
 * dot — i.e. exactly the file-name rows I-D paints (`photo.png`), because the
 * node key keeps the filename's own dot — so the identity test is the button
 * element plus the seat's row-key prefix, never a dot-free suffix.
 */
function slashRows(fixture: DirectTspFixture): WireNode[] {
  return wireNodes(fixture.pane).filter(node =>
    node.k === 'el' && node.p.tag === 'button' && /(^|\.)completion-/.test(node.id))
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

/**
 * The dock notice ids currently carrying the TSP builtin refusal, from ONE wire
 * fold.
 *
 * A notice is minted with a NEW id per publish (`notice-n<seq>`), and the
 * refusal text is re-painted by every later frame. So only an id that did not
 * exist before a submission can prove THAT submission produced the refusal;
 * searching the accumulated output for the phrase cannot.
 */
function noticeIdsWith(fixture: DirectTspFixture, text: string): string[] {
  return wireNodes(fixture.pane)
    .filter(node => /^dock\.notice-n\d+$/u.test(node.id)
      && String(node.p.text ?? '').includes(text))
    .map(node => node.id)
}

function refusalNoticeIds(fixture: DirectTspFixture): string[] {
  return noticeIdsWith(fixture, TSP_BUILTIN_REFUSAL)
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

/**
 * The production transition's TERMINAL report. `reportSwitch` writes
 * `diag.info('switch ok', { from, to })` as the LAST step of `transitionTo`,
 * only after the committed owner's surface rebuild AND live-catalog refresh have
 * settled — immediately before the `/new` handler's `finally` releases its
 * single-flight marker. A durable header / live Agent / hydration frame can all
 * appear while that marker is still held, so this report (the same signal the
 * sibling submission lanes wait on) is the real completion boundary for the next
 * `/new` gesture. The `to` id ties it to THIS round's Session.
 */
function switchReported(fixture: DirectTspFixture, toSessionId: string): boolean {
  let text: string
  try {
    text = readFileSync(join(fixture.workRoot, 'diag.log'), 'utf8')
  } catch {
    return false
  }
  return text.split('\n').some(line => line.includes('switch ok') && line.includes(`to=${toSessionId}`))
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

/** Wait until the composer physically accepts a printable probe, then erase it. A key
 *  the hydration fence DROPS never reaches the wire, so this — not a sleep — is the
 *  authority that the NEXT keystroke is consumed (the sibling recall lane's shape).
 *  `read` is this suite's authoritative wire reader: ONE folded snapshot per poll,
 *  preferring the quiet-composer editor path and falling back to the historical one. */
async function composerReady(fixture: DirectTspFixture): Promise<void> {
  await waitForEditableComposer(fixture.pane, () => {
    const node = composerNode(fixture)
    if (node === undefined) return { text: '', cursor: -1 }
    return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? -1) }
  })
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

/**
 * ONE real PNG, produced by the attachment backend’s own dependency (the same
 * producer `pasted-image-path-direct-submission.test.ts` uses), so the Client-local
 * intake decodes REAL bytes and REAL header dimensions instead of a hand-made
 * buffer the test could have invented.
 */
async function realPng(width = 8, height = 8): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const storeRoot = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharp = require(require.resolve('sharp', { paths: [storeRoot] })) as (
    input: unknown,
  ) => { png(): { toBuffer(): Promise<Buffer> } }
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: '#abcdef' } }).png().toBuffer())
}

/** One staging call the production intake made on a Client draft store. */
interface StagedCall {
  readonly placeholder: string
  readonly id: number
  readonly name: string
  readonly bytes?: Uint8Array
  readonly width?: number
  readonly height?: number
  readonly mediaType?: string
  readonly sourcePath?: string
  readonly byteLength?: number
  readonly inode?: bigint
}

/**
 * Attach ONE-TO-ONE recorders to the TWO production Client draft stores. The
 * Direct composition creates them inside the mounted runner
 * (`src/app/bootstrap.ts` `new DraftImageStore()` / `new DraftFileStore()`), so
 * the observation point is the shipped class prototype with the UNBOUND original
 * saved and re-invoked on the real receiver (never `.bind`), and `detach()`
 * restores the SAME function identity. Every recorded call carries the receiver,
 * which IS the mount's live store object — so `imageEntries()`/`fileEntries()`
 * read the real staged counts from the production store itself, never from a
 * test-side copy. `add` is the ONLY path that mints a draft entry, so a zero
 * call count is the authoritative "no draft store entry exists" fact.
 */
function watchDraftStores(): {
  readonly imageAdds: StagedCall[]
  readonly fileAdds: StagedCall[]
  /** How many image intakes reached the real `readImageFile` argument step. */
  readEntries(): number
  imageEntries(): number
  fileEntries(): number
  detach(): void
} {
  const imageAdds: StagedCall[] = []
  const fileAdds: StagedCall[] = []
  const imageStores = new Set<DraftImageStore>()
  const fileStores = new Set<DraftFileStore>()
  let reads = 0
  const imagePrototype = DraftImageStore.prototype as unknown as {
    add(this: DraftImageStore, input: never): { id: number; placeholder: string }
    remainingBytes(this: DraftImageStore): number
    values(this: DraftImageStore): readonly unknown[]
  }
  const filePrototype = DraftFileStore.prototype as unknown as {
    add(this: DraftFileStore, input: never): { id: number; placeholder: string }
  }
  const originalAdd = imagePrototype.add
  const originalRemaining = imagePrototype.remainingBytes
  const originalFileAdd = filePrototype.add
  imagePrototype.add = function (this: DraftImageStore, input: never) {
    imageStores.add(this)
    const staged = originalAdd.call(this, input)
    imageAdds.push({
      placeholder: staged.placeholder,
      id: staged.id,
      name: String((input as never as { name?: string }).name ?? ''),
      bytes: (input as never as { bytes?: Uint8Array }).bytes,
      width: (input as never as { width?: number }).width,
      height: (input as never as { height?: number }).height,
      mediaType: (input as never as { mediaType?: string }).mediaType,
      sourcePath: (input as never as { source?: { path?: string } }).source?.path,
    })
    return staged
  }
  imagePrototype.remainingBytes = function (this: DraftImageStore) {
    // The intake's OWN synchronous argument step: `readImageFile(path, cwd,
    // limits, store.remainingBytes())`. A call here is the fact that the
    // command plane entered the Client-local read for this stake.
    imageStores.add(this)
    reads += 1
    return originalRemaining.call(this)
  }
  filePrototype.add = function (this: DraftFileStore, input: never) {
    fileStores.add(this)
    const staged = originalFileAdd.call(this, input)
    fileAdds.push({
      placeholder: staged.placeholder,
      id: staged.id,
      name: String((input as never as { name?: string }).name ?? ''),
      byteLength: (input as never as { byteLength?: number }).byteLength,
      sourcePath: (input as never as { source?: { path?: string } }).source?.path,
      inode: (input as never as { source?: { fingerprint?: { ino?: bigint } } }).source?.fingerprint?.ino,
    })
    return staged
  }
  const sum = (stores: Set<{ values(): readonly unknown[] }>): number => {
    let total = 0
    for (const store of stores) total += store.values().length
    return total
  }
  return {
    imageAdds,
    fileAdds,
    readEntries: () => reads,
    imageEntries: () => sum(imageStores as Set<{ values(): readonly unknown[] }>),
    fileEntries: () => sum(fileStores as Set<{ values(): readonly unknown[] }>),
    detach: () => {
      imagePrototype.add = originalAdd
      imagePrototype.remainingBytes = originalRemaining
      filePrototype.add = originalFileAdd
    },
  }
}

/** Every transient notice this mount has painted (the Dock notice segment). */
function noticeTexts(fixture: DirectTspFixture): string[] {
  return wireNodes(fixture.pane)
    .filter(node => /(^|\.)notice-/.test(node.id) && typeof node.p.text === 'string')
    .map(node => String(node.p.text))
}

/** The candidate rows' OWN display text, without any description suffix. */
function rowTexts(fixture: DirectTspFixture): string[] {
  return rowTitles(fixture).map(title => title.split(' — ')[0]!)
}

/** One real Enter key the seat owns (accept a highlighted candidate). */
function pressEnter(fixture: DirectTspFixture): void {
  fixture.pane.input.type(ENTER)
}

/**
 * The intake SUCCESS notices the dock really paints. Counted, not merely “present”:
 * one accepted file commits exactly one announcement, and a settlement the currentness
 * fence refused adds none — the positive control earlier in the same case is what makes
 * that absence a fact about the fence rather than about a notice that never exists.
 */
function successNotices(fixture: DirectTspFixture): string[] {
  return noticeTexts(fixture).filter(text => text.startsWith('attached '))
}

/** The draft text of one logical line of the controlled composer. */
function composerLine(fixture: DirectTspFixture, index: number): string {
  return composerText(fixture).split('\n')[index] ?? ''
}

/** The real staged PNG/placeholder token the production store minted, if any. */
function lastPlaceholder(calls: readonly StagedCall[]): string {
  assert.ok(calls.length > 0, 'at least one staging call exists')
  return calls[calls.length - 1]!.placeholder
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
      // The refusal text is re-painted by every later frame, so only a notice id
      // minted AFTER this Enter can prove THIS command was really processed.
      const seenNotices = new Set(refusalNoticeIds(fixture))
      await submitCommand(fixture, line)
      await waitFor(`a NEW refusal notice for ${line}`, () => {
        const now = refusalNoticeIds(fixture)
        return now.some(id => !seenNotices.has(id))
      }, 25_000)
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

test('a sessionless TSP /transcript is refused with the fixed save-dialog copy, restores the draft and starts no save', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['IC-TRANSCRIPT'], composerActions: true })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    const seen = new Set(noticeIdsWith(fixture, TRANSCRIPT_SAVE_UNAVAILABLE_TEXT))
    await submitCommand(fixture, '/transcript')
    // A NEW notice id carrying the plan's fixed copy proves THIS submission was
    // really refused by the post-classification TSP admission (the typed handler
    // never runs on a renderer with no save dialog).
    await waitFor('the fixed /transcript refusal notice', () =>
      noticeIdsWith(fixture, TRANSCRIPT_SAVE_UNAVAILABLE_TEXT).some(id => !seen.has(id)), 25_000)
    await waitFor('the refused /transcript draft is restored', () => composerText(fixture) === '/transcript', 25_000)
    // No Session means no captured originating Agent and therefore no
    // post-success artifact workflow: the refusal happens before ensureSession.
    assert.deepEqual(await sessionHeaders(fixture), [], 'the refused /transcript created no Session')
    assert.equal(recorder.calls(), 0, 'a refused builtin never became a business submission')
    assert.equal(fixture.modelCalls(), 0, 'a refused builtin never reached the model')
    assert.deepEqual(historyRows(fixture.workRoot), [], 'a refused builtin persisted no recall row')
    assert.equal(fixture.pane.output.text().includes(TSP_BUILTIN_REFUSAL), false,
      'the generic TSP capability copy is not used for /transcript')
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
    const observedSessions: string[] = []
    for (const attempt of [0, 1]) {
      await queryRows(fixture, '/ne')
      fixture.pane.input.type(ENTER)
      await waitFor('the accept to complete /new', () => composerText(fixture) === '/new ', 25_000)
      assert.equal(slashRows(fixture).length, 0, 'the accepted frame shows no list')
      const beforeSubmitFrames = fixture.pane.frames().length
      fixture.pane.input.type(ENTER)
      // The Composer clears BEFORE /new's async single-flight guard is released.
      // Each round waits for THIS round's business facts (distinct durable
      // Session, its live Agent, the renderer's hydration→ready commit) AND the
      // production transition's terminal `switch ok` report, which precedes the
      // handler's marker release. The Composer probe alone only proves that the
      // editor accepts a key.
      const headers = await waitForSessionHeaders(fixture, attempt + 1, `the /new Session ${String(attempt + 1)}`)
      const freshSession = headers.find(id => !observedSessions.includes(id))
      assert.ok(freshSession, `the /new command ${String(attempt + 1)} published a distinct Session`)
      observedSessions.push(freshSession)
      await waitFor(`the /new Session ${String(attempt + 1)} to own a live Agent`, () =>
        liveAgentIds(fixture).includes(freshSession), 30_000)
      await waitFor(`the /new Session ${String(attempt + 1)} to commit its presented Main`, () =>
        wireNodes(fixture.pane).every(node => node.id !== 'main.loading')
        && fixture.pane.frames().slice(beforeSubmitFrames).some(frame =>
          frame.ops.some(op => op[0] === 'add' && op[1] === 'main.loading')), 30_000)
      await waitFor(`the /new command ${String(attempt + 1)} to finish its transition`, () =>
        switchReported(fixture, freshSession), 30_000)
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

test('the I-D contract on one mount: the Host `@` scope and the declared attachment argument DO open, while a shell line, an email, a version pin, prose and a bare path still open nothing and stage nothing', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-FENCE'], composerActions: true })
  const stores = watchDraftStores()
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    const attachable = join(fixture.workRoot, 'lane-note.pdf')
    writeFileSync(attachable, Buffer.from('%PDF-1.7 lane note'))
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [], 'the attachment store starts with no staged object')
    assert.equal(stores.imageEntries(), 0, 'the draft image store starts empty')
    assert.equal(stores.fileEntries(), 0, 'the draft file store starts empty')

    // POSITIVE CONTROL FIRST: on THIS mount the two I-D seats really do open. A
    // closed `@`/argument position would make every absence below vacuous, which
    // is exactly the I-C rule I-D replaces (Host `@` and a declared attachment
    // argument are now open seats).
    await prepareDraft(fixture, `看一下 /image ${fixture.workRoot}/lane`)
    await settle(fixture, 'the declared /attach-argument seat to open', () =>
      rowTexts(fixture).includes(attachable))
    await eraseDraft(fixture)
    await prepareDraft(fixture, '请看 /imag')
    await settle(fixture, 'the inline attachment ACTION seat to open', () => rowTexts(fixture).includes('/image'))
    await eraseDraft(fixture)

    // The provenance boundary: an `@` INSIDE a declared attachment argument stays
    // Client-local path text. A Host mention row is the official `@…` value; a
    // local argument row never is — the two sources never trade places.
    const atDir = join(fixture.workRoot, '@local')
    mkdirSync(atDir, { recursive: true })
    writeFileSync(join(atDir, 'inside.txt'), Buffer.from('inside an @-named directory'))
    await prepareDraft(fixture, `看一下 /attach ${fixture.workRoot}/@local/in`)
    await settle(fixture, 'the argument seat with an `@` in the path', () =>
      rowTexts(fixture).includes(join(atDir, 'inside.txt')))
    assert.equal(rowTexts(fixture).every(text => !text.startsWith('@')), true,
      `an ` + `@ inside an argument is path text, never a Host mention row (got ${JSON.stringify(rowTexts(fixture))})`)
    await eraseDraft(fixture)

    // The positions I-D still keeps closed. Each is typed, then ONE real printable
    // edit at the caret runs the natural trigger against THIS document.
    const cases: ReadonlyArray<{ readonly typed: string; readonly draft: string }> = [
      { typed: '!echo hi', draft: '!echo hi' },
      { typed: '!!echo hi', draft: '!!echo hi' },
      { typed: 'foo@bar.com', draft: 'foo@bar.com' },
      { typed: 'pkg@1.0.0', draft: 'pkg@1.0.0' },
      { typed: 'hello /ne', draft: 'hello /ne' },
      { typed: './lane-note.pdf', draft: './lane-note.pdf' },
      { typed: '/usr/bi', draft: '/usr/bi' },
      // A PASTED second line is not the first line’s command seat, and a `/ne`
      // body token matches neither attachment action nor any skill on this mount.
      { typed: `${PASTE_START}first line\n/ne${PASTE_END}`, draft: 'first line\n/ne' },
    ]
    for (const entry of cases) {
      await prepareDraft(fixture, entry.typed)
      await editAtCaret(fixture, `${entry.draft}x`, 'x')
      await observeNothing(fixture)
      assert.equal(slashRows(fixture).length, 0, `${JSON.stringify(entry.draft)} paints no candidate row`)
      assert.equal(composerText(fixture), `${entry.draft}x`,
        `the draft ${JSON.stringify(entry.draft)} was never auto-completed`)
      await eraseDraft(fixture)
    }

    assert.equal(stores.readEntries(), 0, 'no closed position even entered the Client-local read seam')
    assert.equal(stores.imageAdds.length, 0, 'no closed position read a Client-local image')
    assert.equal(stores.fileAdds.length, 0, 'no closed position staged a Client-local file')
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [],
      'typing an attach/path token staged no attachment object')
    assert.deepEqual(historyRows(fixture.workRoot), [], 'nothing was submitted, so the real store holds no row')
    assert.deepEqual(await sessionHeaders(fixture), [], 'no draft created a Session')
    assert.equal(recorder.calls(), 0, 'no draft produced a business submission')
    assert.equal(fixture.modelCalls(), 0, 'no draft reached the model')
    assert.equal(fixture.pane.output.text().includes('[file #'), false, 'no canonical attachment token entered the wire')
    assert.equal(fixture.pane.output.text().includes('[image #'), false, 'no canonical image token entered the wire')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

// ── TSP I-D: the Host `@` reference and the Client-local attachment seats ──────

test('a Host `@` explicit-scope reference paints REAL HostFilePort rows, the accept writes only the literal mention, and the NEXT Enter sends that literal text with zero Client-local attachment state', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-HOST'], composerActions: true })
  const stores = watchDraftStores()
  const delivered: unknown[] = []
  const recorder = fixture.recordPrompts(call => { delivered.push(call.message) })
  try {
    await waitForInputDelivery(fixture.pane)
    // ROUTE: this is the Direct adapter’s EXPLICIT path-navigation route
    // (`runtime/direct/host-file-augmentation-direct.ts` → the Host scoped discovery
    // over the Session’s own workspace), NEVER the bare workspace fuzzy route. A
    // live Session makes the scope the official Session scope.
    const workspace = process.cwd()
    const target = join('src', 'tui', 'tsp', 'editor.ts')
    assert.ok(existsSync(join(workspace, target)),
      `the real Host workspace (${workspace}) really holds ${target}: the query below addresses a fact, not a fixture`)
    await submitCommand(fixture, '/new')
    const [sessionA] = await waitForSessionHeaders(fixture, 1, 'the Session whose scope the mention resolves against')
    await waitFor('the new Session to own a live Agent', () => liveAgentIds(fixture).includes(sessionA), 30_000)
    // A durable header and a live Agent can appear while /new's single-flight
    // marker is still held: the committed owner's surface rebuild and
    // live-catalog refresh settle only after them. The mention query is issued
    // ONCE when the text is typed, so a discovery that runs against the
    // unfinished transition paints no rows and never re-queries. Gate on the
    // production transition's terminal report, the same boundary the sibling
    // submission lanes use.
    await waitFor('the /new transition to finish its live-catalog refresh', () =>
      switchReported(fixture, sessionA), 30_000)

    await prepareDraft(fixture, `请看 @src/tui/tsp/edit`)
    await settle(fixture, 'the Host mention rows', () => slashRows(fixture).length > 0)
    const offered = rowTexts(fixture)
    assert.equal(offered.length <= MAX_ROWS, true, 'the list stays inside the seat budget')
    assert.equal(offered.every(text => text.startsWith('@')), true,
      `every row of an "@" seat is an official mention value (got ${JSON.stringify(offered)})`)
    assert.equal(offered.includes(`@${target}`), true,
      `the real Host discovery returned the real file (got ${JSON.stringify(offered)})`)
    for (const text of offered) {
      // A painted Host row must name a path the Host workspace really has: the proof
      // that the Provider carried the PORT’s answer, not a synthesized list.
      assert.equal(existsSync(join(workspace, text.slice(1).replace(/\/$/, ''))), true,
        `${text} names a REAL workspace path (got ${JSON.stringify(offered)})`)
    }
    assert.equal(stores.imageAdds.length, 0, 'painting Host rows read no file')
    assert.equal(stores.fileAdds.length, 0, 'painting Host rows staged no file')

    // THE ROUTE CONTRAST on the same mount: the same basename as a BARE fuzzy query
    // is the OFFICIAL `ctx.fileReferences` route, which this fixture mounts as the
    // documented empty workspace-index stand-in. Its authoritative `ok:[]` must stay
    // empty — the seat never re-derives an answer from the Client filesystem. (The
    // bare-fuzzy POSITIVE is not provable against that stand-in; see the header.)
    await eraseDraft(fixture)
    await prepareDraft(fixture, '请看 @editor')
    await observeNothing(fixture)
    assert.equal(slashRows(fixture).length, 0,
      'the bare Host route answers its authoritative empty and never falls back to a Client listing')

    // Accept the mention: an `@` row is NEVER an execution and NEVER an attachment.
    await prepareDraft(fixture, `请看 @src/tui/tsp/edit`)
    await settle(fixture, 'the Host mention rows again', () => slashRows(fixture).length > 0)
    pressEnter(fixture)
    await settle(fixture, 'the accept to write the literal mention', () =>
      composerText(fixture) === `请看 @${target} ` && composerCursor(fixture) === `请看 @${target} `.length)
    assert.equal(slashRows(fixture).length, 0, 'the accepted frame carries no stale list')
    assert.equal(stores.readEntries(), 0, 'a Host mention never entered the Client-local read seam')
    assert.equal(stores.imageAdds.length, 0, 'a Host mention accept staged no image')
    assert.equal(stores.fileAdds.length, 0, 'a Host mention accept staged no file')
    assert.equal(stores.imageEntries(), 0, 'the real image draft store holds no entry')
    assert.equal(stores.fileEntries(), 0, 'the real file draft store holds no entry')
    assert.equal(recorder.calls(), 0, 'the mention accept submitted nothing')
    assert.equal(fixture.modelCalls(), 0, 'the mention accept never reached the model')
    await observeNothing(fixture)
    assert.equal(stores.imageAdds.length + stores.fileAdds.length, 0,
      'and still no attachment read or staging after the window')
    assert.equal(composerText(fixture).includes('[image #'), false, 'no canonical image token exists')
    assert.equal(composerText(fixture).includes('[file #'), false, 'no canonical file token exists')

    // The NEXT Enter is the only submit, and the reference travels LITERALLY.
    pressEnter(fixture)
    await waitFor('the settled prompt write', () => recorder.calls() === 1, 30_000)
    const wire = JSON.stringify(delivered[0])
    assert.equal(wire.includes(`@${target}`), true,
      `the delivered prompt carries the literal @-reference (got ${wire.slice(0, 300)})`)
    assert.equal(wire.includes('"type":"image"'), false, 'the mention delivered no image part')
    assert.equal(wire.includes('"type":"file"'), false, 'the mention delivered no file part')
    assert.equal(stores.imageAdds.length + stores.fileAdds.length, 0,
      'the send did not turn the reference into a Client-local attachment')
    assert.equal(recorder.calls(), 1, 'exactly one submission settled')
    // The real `$DSH_HOME/user-history` rows: the `/new` command line plus the sent
    // draft. The mention itself travelled LITERALLY — the only difference from the
    // composer text is the submission owner’s own trim of the trailing separator.
    const contents = historyRows(fixture.workRoot).map(row => row.content)
    assert.deepEqual(contents, ['/new', `请看 @${target}`],
      `the real input-history store kept the LITERAL mention text (got ${JSON.stringify(contents)})`)
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [],
      'the durable attachment directory received nothing from a Host reference')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

test('a first-line `/image` argument completes ONLY the argument, and the NEXT Enter runs the real registered /image handler that stages the file', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-LEADING'], composerActions: true })
  const stores = watchDraftStores()
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })
    const png = await realPng()
    const image = join(shots, 'photo.png')
    writeFileSync(image, png)

    await prepareDraft(fixture, `/image ${shots}/ph`)
    await settle(fixture, 'the local path-argument rows', () => slashRows(fixture).length > 0)
    const offered = rowTexts(fixture)
    assert.equal(offered.includes(`${shots}/photo.png`), true,
      `the Client-local discovery offers the real file (got ${JSON.stringify(offered)})`)
    assert.equal(offered.every(text => !text.startsWith('@')), true,
      'an argument seat never dresses a Client-local path as a Host mention')
    assert.equal(stores.imageAdds.length, 0, 'listing the argument staged nothing')

    pressEnter(fixture)
    await settle(fixture, 'the argument-only completion', () =>
      composerText(fixture) === `/image ${image}` && composerCursor(fixture) === `/image ${image}`.length)
    assert.equal(slashRows(fixture).length, 0, 'the accept closed the list')
    assert.equal(stores.imageAdds.length, 0, 'completing an argument ran no intake')
    assert.equal(stores.readEntries(), 0, 'completing an argument started no Client-local read')
    assert.equal(stores.imageEntries(), 0, 'completing an argument staged no draft image')
    assert.equal(recorder.calls(), 0, 'completing an argument submitted nothing')
    assert.equal(composerText(fixture).startsWith('/image '), true, 'the command token is untouched')
    await observeNothing(fixture)
    assert.equal(stores.imageAdds.length, 0, 'and still nothing staged after the window')

    // The NEXT Enter is the gesture that runs the registered handler.
    pressEnter(fixture)
    await waitFor('the real /image handler to stage the file', () => stores.imageAdds.length === 1, 25_000)
    const staged = stores.imageAdds[0]!
    assert.equal(staged.width, 8, 'the staged entry carries the REAL parsed PNG width')
    assert.equal(staged.height, 8, 'the staged entry carries the REAL parsed PNG height')
    assert.equal(staged.mediaType, 'image/png', 'the media type came from the bytes, never the extension')
    assert.equal(staged.name, 'photo.png', 'the staged name is the file’s own basename')
    assert.deepEqual(staged.bytes, png, 'the staged bytes ARE the real file bytes (readImageFile ran)')
    assert.equal(staged.sourcePath, realpathSync(image), 'the intake read the resolved path the user chose')
    assert.equal(composerText(fixture), `${staged.placeholder} `,
      'the leading route inserts the canonical token at the composer cursor')
    await waitFor('the real intake notice to reach the dock', () =>
      noticeTexts(fixture).includes(`attached ${staged.placeholder} — Enter to send`), 8_000)
    assert.equal(stores.imageEntries(), 1, 'the production draft image store holds exactly the staged entry')
    assert.equal(recorder.calls(), 0, 'a command line is not an agent-facing submission')
    assert.equal(fixture.modelCalls(), 0, 'staging never reached the model')
    // The command line is a remembered input of its own (the ordinary DraftStore
    // history owner), and it is the ONLY row: no agent-facing submission followed.
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content), [`/image ${image}`],
      'the real history store holds the command line itself and nothing else')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D D11 (L6) — the ONE closed Client-local chain, proven in ONE run on the real
 * Direct composition (plan §7 “严禁拼接证明”): the typed body gesture → the real
 * Provider rows → the real TSP key seat → the real Composer edit → the
 * `artifactCommands.inlineAttachmentStager()` that the production
 * `registerTuiCommands` commit installed on THIS mount → the real `readImageFile`
 * → the real `DraftImageStore` entry → the canonical placeholder spliced IN PLACE →
 * the real notice → zero submits → then the user’s own Enter and the REAL prepared
 * and delivered prompt. No case here injects a stager, hands the composer a
 * pre-staged token, or calls the intake by hand.
 */
test('a body inline `/image` file acceptance runs the whole Client-local chain in ONE run: committed draft, real read, real draft store, in-place placeholder, notice, zero submits, then the real delivered prompt', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-INLINE'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const delivered: unknown[] = []
  const recorder = fixture.recordPrompts(call => { delivered.push(call.message) })
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })
    const png = await realPng()
    const image = join(shots, 'photo.png')
    writeFileSync(image, png)
    const blobId = createHash('sha256').update(png).digest('hex')
    assert.equal(stores.imageEntries(), 0, 'the production draft image store starts empty')

    // (1) the ACTION seat: `看一下 /im` offers the fixed inline `/image` action.
    await prepareDraft(fixture, '看一下 /im')
    await settle(fixture, 'the inline /image action row', () => rowTexts(fixture).includes('/image'))
    assert.equal(stores.readEntries(), 0, 'offering an action row started no Client-local read')
    assert.equal(stores.imageAdds.length, 0, 'offering an action row staged nothing')
    pressEnter(fixture)
    // (2) the action accept writes `/image ` and the SAME seat keeps browsing.
    await settle(fixture, 'the action accept to write `/image `', () =>
      composerText(fixture) === '看一下 /image ' && composerCursor(fixture) === '看一下 /image '.length)
    await settle(fixture, 'the local path rows at the same seat', () => slashRows(fixture).length > 0)
    assert.equal(rowTexts(fixture).every(text => !text.startsWith('@')), true,
      'the same seat now answers with Client-local paths, never Host mentions')
    assert.equal(stores.readEntries(), 0, 'the action accept read no file')

    // (3) the real path argument completes, then ONE key accepts the real FILE.
    await editAtCaret(fixture, `看一下 /image ${shots}/ph`, `${shots}/ph`)
    await settle(fixture, 'the real file row', () => rowTexts(fixture).includes(image))
    // (4) ONE key gesture, then the chain: the acceptance committed the Provider’s
    // own document and the ONE stager the production registration installed on this
    // mount ran against it. The committed text is transient once the read lands, so
    // the durable proof of "edit first, stage second" is the FINAL document below:
    // the acceptance’s document with ONLY the accepted fragment replaced.
    const accepted = `看一下 /image ${image} `
    pressEnter(fixture)
    await waitFor('the real Client-local read to stage the accepted file', () => stores.imageAdds.length === 1, 25_000)
    assert.equal(stores.readEntries(), 1, 'the intake entered the real read exactly once for this one accept')
    assert.equal(slashRows(fixture).length, 0, 'the accepted frame carries no stale list')
    assert.equal(recorder.calls(), 0, 'the accept itself never reached the submit path')
    const staged = stores.imageAdds[0]!
    assert.deepEqual(staged.bytes, png, 'the staged bytes ARE the real file bytes (readImageFile ran)')
    assert.equal(staged.mediaType, 'image/png', 'the media type came from the bytes, never the extension')
    assert.equal(staged.width, 8, 'the width came from the real PNG header')
    assert.equal(staged.height, 8, 'the height came from the real PNG header')
    assert.equal(staged.name, 'photo.png', 'the staged name is the file’s own basename')
    assert.equal(staged.sourcePath, realpathSync(image), 'the intake read the resolved path the user chose')
    assert.equal(stores.imageEntries(), 1, 'the production DraftImageStore holds exactly the staged entry')
    assert.equal(stores.fileAdds.length, 0, 'an `/image` intake never touched the generic-file store')

    // (6) the canonical placeholder replaced ONLY the accepted inline fragment: the
    // prose before the command token, the command token, the trailing space and the
    // caret all survive (`replaceInlineAttachmentFragment`, not a document rebuild).
    const placeholder = staged.placeholder
    await settle(fixture, 'the placeholder to splice into the draft', () =>
      composerText(fixture) === `看一下 ${placeholder} `)
    assert.equal(composerCursor(fixture), `看一下 ${placeholder}`.length,
      'the caret landed right after the placeholder, before the surviving separator')
    assert.equal(composerText(fixture).startsWith('看一下 '), true,
      'the prose before the `/image` token survived: the splice is in place, not from the line start')
    assert.equal(composerText(fixture).endsWith(' '), true, "the accepted fragment's own trailing space survived")
    assert.equal(accepted.includes(placeholder), false,
      'the token is the store’s own, not text the acceptance wrote')
    assert.equal(composerText(fixture).includes(image), false, 'the raw client path is gone from the draft')
    // The staged bytes also reached the ONE SDK blob sender through the production
    // preview path, so the draft token and its preview are the same staged object.
    await waitFor('the staged bytes to reach the SDK blob channel', () => fixture.pane.blobIds().includes(blobId), 25_000)
    assert.equal(recorder.calls(), 0, 'the whole intake submitted nothing')
    assert.equal(fixture.modelCalls(), 0, 'the whole intake never reached the model')
    assert.deepEqual(historyRows(fixture.workRoot), [], 'an intake persisted no recall row')
    // Plan §2.4 makes the success notice part of the intake contract (“原地 placeholder
    // + 正式 store + 通知”), asserted LAST in this block so a red run still exercises
    // every sink above it. ONE accepted file, ONE staged entry, ONE announcement: the
    // COUNT is the witness, so a duplicated notice, a leading-route notice borrowed
    // for an inline stage, or a notice a refused commit tried to claim all fail it.
    await waitFor('the real intake notice to reach the dock', () =>
      noticeTexts(fixture).includes(`attached ${placeholder} — Enter to send`), 8_000)
    assert.deepEqual(successNotices(fixture), [`attached ${placeholder} — Enter to send`],
      'exactly ONE success notice is visible for the one inline commit')

    // (6) the user’s OWN Enter is the only submit, and it carries the staged image.
    pressEnter(fixture)
    await waitFor('the settled prompt write', () => recorder.calls() === 1, 30_000)
    const wire = JSON.stringify(delivered[0])
    assert.equal(wire.includes('"type":"image"'), true,
      `the delivered prompt carries a real image part (got ${wire.slice(0, 300)})`)
    assert.equal(wire.includes('[image #'), false, 'the canonical token was expanded, never sent as text')
    assert.equal(wire.includes(image), false, 'the Client-local absolute path never reached the Host content')
    assert.equal(wire.includes('看一下'), true, 'the prose beside the placeholder travelled into the message')
    const ref = (delivered[0] as { content: { type: string; attachment?: { attachmentId: string; bytes: number } }[] })
      .content.find(block => block.type === 'image')!.attachment!
    assert.equal(ref.bytes, png.byteLength, 'the durable ref records the staged byte length')
    const attachments = fixture.ctx.get('attachments') as unknown as {
      readImage(ref: unknown): Promise<{ data: Uint8Array }>
    }
    const stored = await attachments.readImage(ref)
    assert.deepEqual(new Uint8Array(stored.data), png, 'the delivered image part carries the exact bytes the real file has')
    await waitFor('the staged draft is consumed by the submission', () => stores.imageEntries() === 0, 30_000)
    assert.ok((await sessionHeaders(fixture)).length >= 1, 'the prompt owned a real Session')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D D12 (L6) — the SAME one-run shape through `/attach`: the body action, the
 * real Client-local `probeAttachment`, the real `DraftFileStore`, a generic file
 * that is NEVER treated as an image, and the real delivered prompt.
 */
test('a body inline `/attach` of a generic file probes it, stages it in the real file draft store, never in the image store, and delivers it as a file', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-ATTACH'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const delivered: unknown[] = []
  const recorder = fixture.recordPrompts(call => { delivered.push(call.message) })
  try {
    await waitForInputDelivery(fixture.pane)
    const notes = join(fixture.workRoot, 'notes')
    mkdirSync(notes, { recursive: true })
    const body = Buffer.from('# meeting notes\n\ngeneric file bytes, not an image.\n')
    const file = join(notes, 'meeting-notes.md')
    writeFileSync(file, body)
    const facts = statSync(file)

    await prepareDraft(fixture, '看一下 /att')
    await settle(fixture, 'the inline /attach action row', () => rowTexts(fixture).includes('/attach'))
    pressEnter(fixture)
    await settle(fixture, 'the action accept to write `/attach `', () =>
      composerText(fixture) === '看一下 /attach ' && composerCursor(fixture) === '看一下 /attach '.length)
    await settle(fixture, 'the local path rows at the same seat', () => slashRows(fixture).length > 0)
    assert.equal(stores.readEntries(), 0, 'the action accept read no file')
    assert.equal(stores.imageAdds.length + stores.fileAdds.length, 0, 'the action accept staged nothing')

    await editAtCaret(fixture, `看一下 /attach ${notes}/meeting`, `${notes}/meeting`)
    await settle(fixture, 'the real generic-file row', () => rowTexts(fixture).includes(file))
    pressEnter(fixture)
    // The acceptance’s own document is transient once the probe lands: the durable
    // proof of "one real commit, then stage" is the FINAL document asserted below.
    await waitFor('the real probe to stage the generic file', () => stores.fileAdds.length === 1, 25_000)
    assert.equal(stores.fileAdds.length, 1, 'exactly one generic-file staging call')
    assert.equal(recorder.calls(), 0, 'the accept itself never reached the submit path')
    const staged = stores.fileAdds[0]!
    assert.equal(staged.name, 'meeting-notes.md', 'the staged name is the probed file’s own basename')
    assert.equal(staged.byteLength, body.byteLength, 'the staged byte length came from the real file’s stat')
    assert.equal(staged.sourcePath, realpathSync(file), 'the probe resolved the path the user chose')
    assert.equal(staged.inode, statSync(file, { bigint: true }).ino, 'the staged fingerprint inode IS the real file’s inode (probeAttachment ran)')
    assert.equal(stores.imageAdds.length, 0, 'a generic file was NEVER read or staged as an image')
    assert.equal(stores.imageEntries(), 0, 'the real image draft store stayed empty')
    assert.equal(stores.fileEntries(), 1, 'the real file draft store holds exactly the staged file')

    const placeholder = staged.placeholder
    assert.match(placeholder, /^\[file #\d+ \(/u, 'the canonical generic-file placeholder is the store’s own token')
    await settle(fixture, 'the placeholder to splice into the draft', () =>
      composerText(fixture) === `看一下 ${placeholder} `)
    assert.equal(composerCursor(fixture), `看一下 ${placeholder}`.length,
      'the caret landed right after the placeholder, before the surviving separator')
    assert.equal(composerText(fixture).includes('image #'), false, 'no image placeholder was minted for a file')
    assert.equal(composerText(fixture).includes(file), false, 'the raw client path is gone from the draft')
    assert.equal(recorder.calls(), 0, 'the intake submitted nothing')
    assert.equal(fixture.modelCalls(), 0, 'the intake never reached the model')
    // The same §2.4 contract on the `/attach` route: one commit, one announcement.
    await waitFor('the real intake notice to reach the dock', () =>
      noticeTexts(fixture).includes(`attached ${placeholder} — Enter to send`), 8_000)
    assert.deepEqual(successNotices(fixture), [`attached ${placeholder} — Enter to send`],
      'exactly ONE success notice is visible for the one generic-file commit')

    pressEnter(fixture)
    await waitFor('the settled prompt write', () => recorder.calls() === 1, 30_000)
    const wire = JSON.stringify(delivered[0])
    assert.equal(wire.includes('"type":"file"'), true,
      `the delivered prompt carries the admitted generic file (got ${wire.slice(0, 300)})`)
    assert.equal(wire.includes('"type":"image"'), false, 'the delivered prompt carries no image part')
    assert.equal(wire.includes('[file #'), false, 'the file placeholder was expanded, never sent as text')
    assert.equal(wire.includes(file), false, 'the Client-local absolute path never reached the Host content')
    assert.equal(wire.includes('看一下'), true, 'the prose beside the placeholder travelled into the message')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D #541 on the REAL wire: this Composer inserts a bracketed paste verbatim, so a
 * Windows-clipboard CRLF pair really does land inside the draft (the vendored editor
 * normalizes a CR away; this renderer does not). The line break ends the path token,
 * so the accept completes the name on ITS OWN line, stages once through the real
 * Client-local intake, and never rewrites the line after the break.
 */
test('a pasted CRLF that ends the path’s own line still completes the inline file there, stages once through the real intake and leaves line 2 byte-for-byte', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-CRLF'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const recorder = fixture.recordPrompts(() => {})
  const paste = (body: string): void => { fixture.pane.input.type(`${PASTE_START}${body}${PASTE_END}`) }
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })
    const png = await realPng()
    const image = join(shots, 'crash-shot.png')
    writeFileSync(image, png)
    const typed = `看一下 /image ${shots}/cras`

    await prepareDraft(fixture, typed)
    // ONE real terminal bracketed paste of a CRLF pair plus prose: the pair is draft
    // CONTENT here, both bytes kept, and it is what ends the token the user typed.
    paste('\r\nsecond line')
    await settle(fixture, 'the pasted CRLF pair inside the draft', () =>
      composerText(fixture) === `${typed}\r\nsecond line`)
    assert.equal(composerText(fixture).includes('\r\n'), true, 'the real paste kept both bytes of the pair')

    // The caret sits after the pasted prose; the walk back is line 2 PLUS the one
    // `\r\n` cluster, which lands it at the end of the path token on line 1.
    fixture.pane.input.type(LEFT.repeat('second line'.length + 1))
    await settle(fixture, 'the caret parked on line 1 after the token', () => composerCursor(fixture) === typed.length)

    // One real character completes the token IN THE MIDDLE of the document: the
    // caret stays before the pasted break, which is exactly the shape the grammar
    // has to get right.
    fixture.pane.input.type('h')
    const crashed = `看一下 /image ${shots}/crash\r\nsecond line`
    await settle(fixture, 'the character appended to the token', () =>
      composerText(fixture) === crashed && composerCursor(fixture) === crashed.indexOf('\r'))
    await settle(fixture, 'the real file row on the CRLF line', () => rowTexts(fixture).includes(image))
    pressEnter(fixture)
    // The accepted path text is TRANSIENT once the real read lands, so the durable
    // proof of "completed on its own line, then staged" is the FINAL document: the
    // acceptance's document with ONLY its own fragment replaced.
    await waitFor('the real intake to stage the file from the CRLF line', () => stores.imageAdds.length === 1, 25_000)
    assert.equal(stores.readEntries(), 1, 'the intake entered the real read exactly once for this one accept')
    const placeholder = lastPlaceholder(stores.imageAdds)
    assert.equal(stores.imageEntries(), 1, 'the production draft image store holds exactly the one staged entry')
    await settle(fixture, 'the placeholder to splice into line 1', () =>
      composerText(fixture) === `看一下 ${placeholder} \r\nsecond line`)
    assert.equal(composerCursor(fixture), '看一下 '.length + placeholder.length,
      'the caret landed right after the placeholder, before the surviving separator')
    assert.equal(composerLine(fixture, 1), 'second line',
      'the in-place splice left the CRLF cluster and line 2 byte-for-byte')
    assert.equal(composerText(fixture).includes(image), false, 'the raw client path is gone from the draft')
    await waitFor('the real intake notice to reach the dock', () => successNotices(fixture).length === 1, 8_000)
    assert.deepEqual(successNotices(fixture), [`attached ${placeholder} — Enter to send`],
      'exactly ONE success announcement for the one commit')
    assert.equal(recorder.calls(), 0, 'the accept never submitted the multi-line draft')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D D13 — the intake refuses with its OWN error and the user keeps their text.
 * A `.png` name whose bytes are not a raster is a real `readImageFile` failure: the
 * acceptance stays as editable draft text, with NO placeholder, NO success notice
 * and ZERO draft-store entries (an orphan would keep its bytes resident).
 */
test('an inline `/image` of a file that is not an image keeps the user’s path text editable, reports the real intake error and leaves zero orphan store entries', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-REFUSE'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })
    const broken = join(shots, 'not-an-image.png')
    writeFileSync(broken, Buffer.from('this is definitely not a PNG, whatever the extension says'))

    // The candidate IS offered: the file exists, and an extension is never a MIME
    // authority — the refusal belongs to the read, not to the listing.
    await prepareDraft(fixture, `看一下 /image ${shots}/not-an`)
    await settle(fixture, 'the not-an-image row', () => rowTexts(fixture).includes(broken))
    pressEnter(fixture)
    const accepted = `看一下 /image ${broken} `
    await waitFor('the real intake to enter the Client-local read', () => stores.readEntries() === 1, 25_000)
    await settle(fixture, 'the committed acceptance to stay put (no token replaces it)', () =>
      composerText(fixture) === accepted && composerCursor(fixture) === accepted.length - 1)

    await waitFor('the real intake error notice', () =>
      noticeTexts(fixture).some(text => text.includes('Unsupported image format')), 25_000)
    await observeNothing(fixture)
    assert.equal(stores.imageAdds.length, 0, 'a refused intake staged nothing')
    assert.equal(stores.fileAdds.length, 0, 'a refused image intake never touched the file store')
    assert.equal(stores.imageEntries(), 0, 'the production image draft store holds zero entries (no orphan)')
    assert.equal(stores.fileEntries(), 0, 'the production file draft store holds zero entries (no orphan)')
    assert.equal(composerText(fixture), accepted,
      'the draft still holds the accepted path text — no fake placeholder replaced it')
    assert.equal(composerText(fixture).includes('[image #'), false, 'no success token was minted for a failure')
    assert.deepEqual(successNotices(fixture), [],
      `no success notice was claimed for a refused intake (got ${JSON.stringify(noticeTexts(fixture))})`)
    assert.equal(recorder.calls(), 0, 'the refusal submitted nothing')
    assert.equal(fixture.modelCalls(), 0, 'the refusal never reached the model')

    // The user’s own path text is still EDITABLE at the caret.
    fixture.pane.input.type(END)
    await settle(fixture, 'the caret to move to the line end', () => composerCursor(fixture) === accepted.length)
    await editAtCaret(fixture, `${accepted}x`, 'x')
    assert.equal(composerText(fixture), `${accepted}x`, 'the refused draft stays an ordinary editable draft')
    await eraseDraft(fixture)
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [], 'the refusal wrote no durable attachment')
  } finally {
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D D13 — the two remaining refusal branches, on the REAL deployment limits.
 * The non-image refusal is covered by the case above; the plan's D13 also names an
 * OVER-LIMIT file and an UNREADABLE one. Both are driven through the same production
 * intake the leading `/image` command uses, with the harness's own default byte cap
 * (`@deepseek-ai/dsh-attachment-local`: 20 MiB) and a real `EACCES` — no production
 * limit is overridden and no error is simulated. Each refusal must keep the user's own
 * path text editable, mint no placeholder, announce no success, and leave ZERO orphan
 * entries in either draft store (an orphan keeps bytes resident).
 */
test('an inline `/image` of an over-limit file and of an unreadable file both refuse with the real intake error and leave no orphan, no token and an editable draft', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-D13'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const recorder = fixture.recordPrompts(() => {})
  const secret = join(fixture.workRoot, 'shots', 'locked.png')
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })

    // (1) OVER-LIMIT: one byte past the deployment cap, and the guard reads only
    // the stat — the bytes are never pulled into memory. DSH 0.2.2 raised the
    // LocalAttachmentStore default `maxImageBytes` to 50 MiB, so the fixture is
    // bounded against that real default (never a stale 20 MiB literal).
    const huge = join(shots, 'huge.png')
    const overLimitBytes = 51 * 1024 * 1024
    writeFileSync(huge, Buffer.alloc(1))
    truncateSync(huge, overLimitBytes)
    assert.equal(statSync(huge).size, overLimitBytes, 'the file really is over the configured cap')
    assert.equal(stores.imageEntries(), 0, 'the image draft store starts empty')

    await prepareDraft(fixture, `看一下 /image ${shots}/huge`)
    await settle(fixture, 'the over-limit row', () => rowTexts(fixture).includes(huge))
    pressEnter(fixture)
    const overText = `看一下 /image ${huge} `
    await waitFor('the real over-limit error notice', () =>
      noticeTexts(fixture).some(text => text.includes('current attachment limit is')), 25_000)
    await settle(fixture, 'the over-limit acceptance to stay put', () =>
      composerText(fixture) === overText && composerCursor(fixture) === overText.length - 1)
    await observeNothing(fixture)
    assert.equal(stores.readEntries(), 1, 'the intake really ran its own read attempt for this accept')
    assert.equal(stores.imageAdds.length, 0, 'the over-limit refusal staged nothing')
    assert.equal(stores.imageEntries() + stores.fileEntries(), 0, 'no orphan entry in either draft store')
    assert.equal(overText.includes('[image #'), false, 'no success token was minted for a failure')
    assert.deepEqual(successNotices(fixture), [],
      `no success notice was claimed for the over-limit refusal (got ${JSON.stringify(noticeTexts(fixture))})`)
    assert.equal(recorder.calls(), 0, 'the refusal submitted nothing')
    assert.equal(fixture.modelCalls(), 0, 'the refusal never reached the model')

    // (2) UNREADABLE: a REAL PNG whose mode drops every read bit for this uid (1000),
    // so `stat` succeeds and the read itself fails — the intake's own IO error, not a
    // simulated one.
    fixture.pane.input.type(END)
    await settle(fixture, 'the over-limit draft caret reaches the line end', () =>
      composerCursor(fixture) === overText.length)
    await eraseDraft(fixture)
    const png = await realPng()
    writeFileSync(secret, png)
    chmodSync(secret, 0o000)
    await prepareDraft(fixture, `看一下 /image ${shots}/locked`)
    await settle(fixture, 'the unreadable row is still offered (it exists; an extension is not a read grant)',
      () => rowTexts(fixture).includes(secret))
    pressEnter(fixture)
    const unreadText = `看一下 /image ${secret} `
    await waitFor('the real unreadable-file error notice', () =>
      noticeTexts(fixture).some(text => text.includes('Image file cannot be read: locked.png')), 25_000)
    await settle(fixture, 'the unreadable acceptance to stay put', () =>
      composerText(fixture) === unreadText && composerCursor(fixture) === unreadText.length - 1)
    await observeNothing(fixture)

    const errorNotices = noticeTexts(fixture).filter(text => !text.startsWith('attached '))
    assert.equal(errorNotices.some(text => text.includes(secret)), false,
      `the error taxonomy stays basename-only: no notice carries the full Client path (got ${JSON.stringify(errorNotices)})`)
    assert.equal(stores.imageAdds.length, 0, 'the unreadable refusal staged nothing either')
    assert.equal(stores.imageEntries() + stores.fileEntries(), 0, 'still zero orphan entries in either draft store')
    assert.deepEqual(successNotices(fixture), [], 'and neither refusal announced a success')

    // The refused drafts remain ordinary editable text at the caret (the plan's own
    // wording for D13), for BOTH branches.
    fixture.pane.input.type(END)
    await settle(fixture, 'the caret at the line end', () => composerCursor(fixture) === unreadText.length)
    await editAtCaret(fixture, `${unreadText}x`, 'x')
    assert.equal(composerText(fixture), `${unreadText}x`, 'the refused draft stays an ordinary editable draft')
    await eraseDraft(fixture)
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [], 'the two refusals wrote no durable attachment')
  } finally {
    if (existsSync(secret)) chmodSync(secret, 0o600)
    recorder.detach()
    stores.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D D17 — a read that lands after the seat moved commits NOTHING.
 *
 * The read window is made deterministic with the intake’s OWN existing test seam
 * (`setImageReadForTest` in `src/client/media/image/intake.ts`, the seam
 * `test/app/inline-attachment-completion.test.ts`, `test/app/image-command.test.ts`
 * and `test/tui/terminal-pasted-image.test.ts` already use). The gate DELEGATES to
 * `readImageFileUninjected`, so the real read still runs; the gate only holds the
 * window open and announces that the intake has entered it. No production-only port
 * was added for this test and nothing about the intake’s behaviour is replaced.
 */
test('an inline intake whose read is still in flight when the draft moves commits no placeholder, no notice and no store mutation', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-STALE'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const recorder = fixture.recordPrompts(() => {})
  const realRead = readImageFileUninjected
  let gate: { readonly entered: () => void; readonly wait: Promise<void> } | undefined
  let releaseGate: (() => void) | undefined
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let wait!: Promise<void>
  wait = new Promise<void>(resolve => { releaseGate = resolve })
  setImageReadForTest(async (rawPath, cwd, limits, cap) => {
    const held = gate
    if (held !== undefined) {
      // The intake has ENTERED the real read: the stale input below arrives while
      // the IO is genuinely in flight, not before the acceptance settled.
      held.entered()
      await held.wait
    }
    return realRead(rawPath, cwd, limits, cap)
  })
  // A held gate always carries a guaranteed release, so a failing assertion in the
  // window below can never hang the lane.
  life.defer(() => { gate = undefined; releaseGate?.(); setImageReadForTest(undefined) })
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })
    const png = await realPng()
    const keep = join(shots, 'keep.png')
    const stale = join(shots, 'stale.png')
    writeFileSync(keep, png)
    writeFileSync(stale, png)

    // POSITIVE CONTROL first, on this same mount: with the draft untouched the
    // settlement DOES land. Without it the absence below would prove nothing.
    await prepareDraft(fixture, `看一下 /image ${shots}/keep`)
    await settle(fixture, 'the control file row', () => rowTexts(fixture).includes(keep))
    pressEnter(fixture)
    await waitFor('the control intake to commit its placeholder', () => composerText(fixture).includes('[image #'), 25_000)
    const controlPlaceholder = lastPlaceholder(stores.imageAdds)
    assert.equal(composerText(fixture), `看一下 ${controlPlaceholder} `,
      'the control acceptance spliced its placeholder in place')
    assert.equal(stores.imageAdds.length, 1, 'the control intake staged exactly one image')
    // The notice half of the positive control: this mount DOES announce an inline
    // success, so the absence asserted after the refused settlement is a fact about
    // the currentness fence and not about a notice that never exists.
    await waitFor('the control success notice to reach the dock', () =>
      successNotices(fixture).length === 1, 8_000)
    const noticesAtControl = successNotices(fixture).length

    // THE STALE GESTURE, on the NEXT line of the same draft: hold the read, then
    // move the caret and edit the draft while the intake is genuinely in flight.
    fixture.pane.input.type(END)
    await settle(fixture, 'the caret to the line end', () =>
      composerCursor(fixture) === `看一下 ${controlPlaceholder} `.length)
    fixture.pane.input.type(SHIFT_ENTER)
    assert.equal(composerLine(fixture, 0), `看一下 ${controlPlaceholder} `)
    await settle(fixture, 'a real second line', () =>
      composerText(fixture) === `看一下 ${controlPlaceholder} \n` && composerCursor(fixture) === `看一下 ${controlPlaceholder} \n`.length)
    const lineOne = composerLine(fixture, 0)
    await editAtCaret(fixture, `看一下 ${controlPlaceholder} \n再看 /image ${shots}/stale`, `再看 /image ${shots}/stale`)
    await settle(fixture, 'the stale file row', () => rowTexts(fixture).includes(stale))
    gate = { entered: markEntered, wait }
    pressEnter(fixture)
    await entered // authoritative: the intake is inside the held real read
    const addsAtRead = stores.imageAdds.length
    const entriesAtRead = stores.imageEntries()
    fixture.pane.input.type(RIGHT)
    fixture.pane.input.type(BACKSPACE)
    const moved = `看一下 ${controlPlaceholder} \n再看 /image ${stale}`
    await settle(fixture, 'the draft edit to land on the wire', () =>
      composerText(fixture) === moved && composerCursor(fixture) === moved.length)
    releaseGate?.()
    gate = undefined
    await observeNothing(fixture)
    assert.equal(stores.imageAdds.length, addsAtRead,
      'the moved seat staged nothing — no orphan draft entry behind the stale read')
    assert.equal(stores.imageEntries(), entriesAtRead,
      'the production image draft store count is UNCHANGED by the refused settlement')
    assert.equal(composerText(fixture), moved,
      "the user's own path text stayed exactly where they left it, editable")
    assert.equal(composerLine(fixture, 0), lineOne,
      'the control placeholder line survived the refused settlement byte-for-byte')
    assert.equal(composerLine(fixture, 1).includes('[image #'), false,
      'no placeholder replaced the moved draft')
    // And the refused settlement announced NOTHING: the success-notice count is
    // exactly what the control produced, so no `attached …` line was claimed for a
    // stage that never committed.
    assert.equal(successNotices(fixture).length, noticesAtControl,
      `no success notice was claimed for the refused settlement (got ${JSON.stringify(successNotices(fixture))})`)
    assert.equal(recorder.calls(), 0, 'nothing submitted')
    assert.equal(fixture.modelCalls(), 0, 'nothing reached the model')

    // The refused draft is still a live draft: one more real keystroke lands.
    fixture.pane.input.type(END)
    await editAtCaret(fixture, `${moved}x`, 'x')
    assert.deepEqual(stagedAttachmentFiles(fixture.workRoot), [], 'the refused intake wrote no durable attachment')
  } finally {
    recorder.detach()
    stores.detach()
    releaseGate?.()
    setImageReadForTest(undefined)
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/**
 * I-D D20 — a REAL bracketed-paste image lease and a SECOND inline attachment
 * placeholder in the same multi-line draft: the inline splice replaces only its own
 * fragment, every earlier placeholder survives byte-identically, and a paste lease
 * taken AFTER that in-place splice still resolves.
 */
test('a paste lease held open ACROSS an inline attachment splice still resolves into its own fragment, and the inline placeholder survives it', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ID-PASTE'], composerActions: true, nativeImages: true })
  const stores = watchDraftStores()
  const delivered: unknown[] = []
  const recorder = fixture.recordPrompts(call => { delivered.push(call.message) })
  // The same existing intake read seam, this time keyed to ONE path: it holds the
  // PASTED file’s real read window open while the inline attachment is accepted and
  // committed, so the inline splice provably happens while a paste lease is still
  // in flight — the overlap D20 is about, not a race and not a reordering. The read
  // itself still runs for real on release.
  const realRead = readImageFileUninjected
  let holdPath: string | undefined
  let readEntered = false
  let releaseRead!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  setImageReadForTest(async (rawPath, cwd, limits, cap) => {
    if (holdPath !== undefined && rawPath === holdPath) {
      readEntered = true
      await held
    }
    return realRead(rawPath, cwd, limits, cap)
  })
  life.defer(() => { holdPath = undefined; releaseRead(); setImageReadForTest(undefined) })
  const paste = (body: string): void => { fixture.pane.input.type(`${PASTE_START}${body}${PASTE_END}`) }
  try {
    await waitForInputDelivery(fixture.pane)
    const shots = join(fixture.workRoot, 'shots')
    mkdirSync(shots, { recursive: true })
    const png = await realPng()
    const pasted = join(shots, 'pasted-shot.png')
    const inline = join(shots, 'inline-shot.png')
    writeFileSync(pasted, png)
    writeFileSync(inline, png)

    // (1) ONE real terminal bracketed paste of an image path; its read is held, so
    // the application paste-path owner has a LIVE lease on that tracked span.
    holdPath = pasted
    paste(`${pasted} `)
    await waitFor('the paste-path intake to enter the real read', () => readEntered, 25_000)
    assert.equal(composerText(fixture), `${pasted} `,
      'the pasted path is still ordinary tracked draft text while its lease is live')
    assert.equal(stores.imageAdds.length, 0, 'the held read staged nothing yet')

    // (2) while that lease is in flight, a SECOND attachment goes through the body
    // inline seat on the NEXT line of the same draft.
    fixture.pane.input.type(END)
    fixture.pane.input.type(SHIFT_ENTER)
    await settle(fixture, 'a real second line', () => composerText(fixture) === `${pasted} \n`)
    await editAtCaret(fixture, `${pasted} \n看一下 /image ${shots}/inline`, `看一下 /image ${shots}/inline`)
    await settle(fixture, 'the inline file row on line 2', () => rowTexts(fixture).includes(inline))
    pressEnter(fixture)
    await waitFor('the inline intake to stage and splice on line 2', () => stores.imageAdds.length === 1, 25_000)
    const inlinePlaceholder = lastPlaceholder(stores.imageAdds)
    await settle(fixture, 'the line-2 placeholder to land', () => composerLine(fixture, 1) === `看一下 ${inlinePlaceholder} `)
    // The splice replaced ONLY its own fragment: the in-flight paste text survives
    // byte-for-byte at its shifted offset, and its lease is still the tracked span.
    assert.equal(composerLine(fixture, 0), `${pasted} `,
      'the in-flight pasted path survived the inline splice byte-for-byte')
    assert.equal(stores.imageEntries(), 1, 'only the inline image is staged while the paste read is held')

    // (3) release the held read: the lease still resolves, into ITS OWN span.
    holdPath = undefined
    releaseRead()
    await waitFor('the released paste lease to resolve', () => stores.imageAdds.length === 2, 25_000)
    const pastedPlaceholder = lastPlaceholder(stores.imageAdds)
    await settle(fixture, 'the paste placeholder to replace exactly the pasted path', () =>
      composerLine(fixture, 0) === `${pastedPlaceholder} `)
    assert.equal(composerLine(fixture, 1), `看一下 ${inlinePlaceholder} `,
      'the inline placeholder survived the paste replacement byte-for-byte')
    assert.equal(composerText(fixture).includes(pasted), false, 'the pasted raw path is gone')
    assert.equal(new Set([pastedPlaceholder, inlinePlaceholder]).size, 2,
      'the two attachments minted two distinct canonical tokens')
    assert.equal(stores.imageEntries(), 2, 'the real draft store holds both staged images')
    // Each of the two routes announced exactly ONE success, in commit order: the
    // inline splice first, then the released paste lease — never twice, never zero.
    assert.deepEqual(successNotices(fixture), [
      `attached ${inlinePlaceholder} — Enter to send`,
      `attached ${pastedPlaceholder} — Enter to send`,
    ], 'one success notice per attachment, in the order the two commits landed')
    assert.equal(recorder.calls(), 0, 'no attachment gesture submitted anything')
    assert.deepEqual(historyRows(fixture.workRoot), [], 'no attachment gesture persisted a recall row')

    // (4) the user’s OWN Enter sends the multi-line draft with both images.
    fixture.pane.input.type(END)
    pressEnter(fixture)
    await waitFor('the settled prompt write', () => recorder.calls() === 1, 30_000)
    const blocks = (delivered[0] as { content: { type: string }[] }).content
    assert.equal(blocks.filter(block => block.type === 'image').length, 2,
      `the delivered prompt carries both staged images (got ${JSON.stringify(blocks.map(b => b.type))})`)
    assert.equal(JSON.stringify(delivered[0]).includes('[image #'), false,
      'no canonical token text reached the model content')
  } finally {
    recorder.detach()
    stores.detach()
    holdPath = undefined
    releaseRead()
    setImageReadForTest(undefined)
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})
