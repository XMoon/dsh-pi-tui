/**
 * The TSP submit + ↑/↓ recall path against the REAL persistence owner: the
 * official Direct composition (`support/direct-tsp-fixture.ts` — the real
 * runner, the real `ApplicationEvents` + `SubmissionController`, the real
 * `InputHistory` write policy and session-scoped hydration, the real
 * `$DSH_HOME/user-history` file, the real TSP renderer over a scripted pane;
 * only the model and the tty are scripted).
 *
 * What this lane owns, and what it deliberately does NOT claim:
 *
 * - PROVEN HERE: a real TSP Enter is carried by the PRODUCTION submission owner
 *   all the way into the production history writer. The appended row, its
 *   `sessionId`, the per-file write-policy SKIP, the absence of a row for a
 *   refused shell line and the absence of a plain-text row for a staged
 *   attachment are read back from the real file. The TSP mount now also exposes
 *   a real recall surface: decoded CSI-A / CSI-B typed through the pane's input
 *   channel is read back from the controlled dock editor's `text` and UTF-16
 *   `cursor` wire props after the launch-cwd boot seed and after the production
 *   Session hydration reseed.
 * - NOT PROVEN HERE, and not claimed: the OCCURRENCE TOKEN a submission carries
 *   reaches only the settlement payload. `persistHistoryRecord` writes
 *   `v / content / cwd / ts / sessionId` and nothing else, so no file assertion
 *   can witness the token. The same-mount settlement and token are pinned in
 *   `test/app/tern-tsp-live-mount.test.ts`, where the test owns the mount and can
 *   observe its display seam directly. PiTui's boot recall is a sibling lane's
 *   contract (`test/tui/input-experience.test.ts`, `test/client/tui-app.test.ts`),
 *   not this official Direct TSP qualification.
 *
 * These lanes are the writer half and the occurrence half of ONE contract.
 * Neither is presented as the whole chain, and no case here may be read as a
 * physical-GUI or Remote qualification.
 * @module @xmoon76/dsh-pi-tui/test/integration/tern-tsp-history-persist-direct
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createDirectTspFixture, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { historyFilePath } from '../../src/client/history/store.ts'

/** The SDK's own decoded arrow gestures, sent as raw terminal bytes. */
const UP = '\u001b[A'
const DOWN = '\u001b[B'

/** One parsed history row, read back through the production store's own path. */
interface Row {
  readonly content?: unknown
  readonly cwd?: unknown
  readonly sessionId?: unknown
}

interface SeedRow {
  readonly content: string
  readonly version?: 1 | 2
  readonly sessionId?: string
}

/** The latest controlled editor text the wire carries for `dock.composer`. */
function composerText(fixture: DirectTspFixture): string {
  let text = ''
  for (const match of fixture.pane.output.text().matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
      } else if (op[0] === 'set' && op[1] === 'dock.composer') {
        const props = op[2] as { text?: string }
        if (props.text !== undefined) text = props.text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        text = op[2] === 'append' ? text + (op[3] as string) : (op[3] as string)
      }
    }
  }
  return text
}

/** The UTF-16 caret the folded wire currently carries for `dock.composer`. */
function composerCursor(fixture: DirectTspFixture): number {
  const editor = wireNodes(fixture.pane).find(node => node.id === 'dock.composer')
  return editor === undefined ? -1 : Number(editor.p.cursor ?? 0)
}

/** Every history row written under the fixture's isolated DSH home. */
function historyRows(workRoot: string): Row[] {
  const dir = join(workRoot, 'user-history')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Row))
}

/** Seed rows into the real store's own cwd file before a fixture boots. */
function seedHistoryRows(workRoot: string, cwd: string, rows: readonly SeedRow[]): string {
  const file = historyFilePath(workRoot, cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${rows.map((row, index) => row.version === 1
    ? JSON.stringify({ content: row.content })
    : JSON.stringify({
        v: 2,
        content: row.content,
        cwd,
        ts: 1_700_000_000_000 + index,
        sessionId: row.sessionId,
      })).join('\n')}\n`)
  return file
}

async function historyRowsFor(fixture: DirectTspFixture, content: string, sessionId?: string): Promise<void> {
  await waitFor(`the ${JSON.stringify(content)} history row${sessionId === undefined ? '' : ' for its session'}`, () =>
    historyRows(fixture.workRoot).some(row => row.content === content
      && (sessionId === undefined || row.sessionId === sessionId)), 30_000)
}

function firstSessionId(rows: readonly Row[], content: string): string {
  const row = rows.find(entry => entry.content === content)
  assert.equal(typeof row?.sessionId, 'string', `${JSON.stringify(content)} is persisted under a real Session id`)
  return row!.sessionId as string
}

async function sessionHeaders(fixture: DirectTspFixture): Promise<string[]> {
  const persistence = fixture.ctx.get('sessionPersistence') as unknown as {
    list(): Promise<readonly { header: { id: string } }[]>
  }
  return (await persistence.list()).map(entry => entry.header.id)
}

function liveAgentIds(fixture: DirectTspFixture): string[] {
  const agents = fixture.ctx.get('agents') as unknown as {
    list(): readonly { session: { id: string } }[]
  }
  return agents.list().map(agent => agent.session.id)
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
 * Type one line through the REAL key path and press Enter, waiting on the
 * renderer's own facts (the composer holding the draft, then the draft leaving
 * the composer) rather than on a guessed window — the same ladder a real user's
 * keystrokes take.
 */
async function submitLine(fixture: DirectTspFixture, line: string): Promise<void> {
  fixture.pane.input.type(line)
  await waitFor(`the composer to hold ${JSON.stringify(line)}`, () => composerText(fixture) === line, 25_000)
  fixture.pane.input.type('\r')
  await waitFor('the submitted line to leave the composer', () => composerText(fixture) !== line, 30_000)
}

/**
 * Wait until the composer is physically editable by sending real printable
 * bytes. A typed key that the hydration fence drops never reaches the wire;
 * observing the marker land and erase is the authority that the next arrow is
 * consumed rather than guessed through a sleep.
 */
async function composerReady(fixture: DirectTspFixture): Promise<void> {
  fixture.pane.input.type('x')
  await waitFor('the composer to accept a real typed probe', () =>
    composerText(fixture) === 'x' && composerCursor(fixture) === 1, 30_000)
  fixture.pane.input.type('\x7f')
  await waitFor('the composer to erase the real typed probe', () =>
    composerText(fixture) === '' && composerCursor(fixture) === 0, 30_000)
}

async function arrow(fixture: DirectTspFixture, bytes: typeof UP | typeof DOWN, expected: { readonly text: string; readonly cursor: number }): Promise<void> {
  const frameMark = fixture.pane.frameCount()
  fixture.pane.input.type(bytes)
  await waitFor(`the ${bytes === UP ? '↑' : '↓'} wire frame`, () =>
    fixture.pane.frameCount() > frameMark
      && composerText(fixture) === expected.text
      && composerCursor(fixture) === expected.cursor, 30_000)
}

/**
 * Prove an unmoved ↑ consumed nothing: insert one real printable byte at the
 * current caret. If the arrow had recalled a row, the marker would land inside
 * that row instead of the expected draft.
 */
async function probeNoRecall(fixture: DirectTspFixture, expected: { readonly text: string; readonly cursor: number }): Promise<void> {
  const cursor = Math.max(0, Math.min(expected.cursor, expected.text.length))
  const marker = 'p'
  const withMarker = `${expected.text.slice(0, cursor)}${marker}${expected.text.slice(cursor)}`
  fixture.pane.input.type(marker)
  await waitFor(`the composer to keep the unmoved draft around ${JSON.stringify(marker)}`, () =>
    composerText(fixture) === withMarker && composerCursor(fixture) === cursor + 1, 30_000)
  fixture.pane.input.type('\x7f')
  await waitFor('the probe marker to be erased', () =>
    composerText(fixture) === expected.text && composerCursor(fixture) === cursor, 30_000)
}

async function typeDraft(fixture: DirectTspFixture, draft: string): Promise<void> {
  fixture.pane.input.type(draft)
  await waitFor(`the composer to hold ${JSON.stringify(draft)}`, () =>
    composerText(fixture) === draft && composerCursor(fixture) === draft.length, 25_000)
}

/** One real PNG for the staged-attachment case, produced by the shipped sharp. */
async function realPng(): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
    input: unknown,
  ) => { png(): { toBuffer(): Promise<Buffer> } }
  return new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).png().toBuffer())
}

test('a real TSP Enter persists through the production owner with the FINAL session id, and an identical repeat is a policy SKIP with no second row or recall position', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'] })
  const prompts: Array<{ sessionId: string; mode: string }> = []
  const recorder = fixture.recordPrompts(call => { prompts.push({ sessionId: call.sessionId, mode: call.mode }) })
  try {
    await waitForInputDelivery(fixture.pane)
    assert.deepEqual(historyRows(fixture.workRoot), [], 'the store starts empty')

    await submitLine(fixture, 'shared recall chain')
    await waitFor('the first prompt write', () => prompts.length === 1, 30_000)
    // The write is synchronous inside the owner's detached task, so the row is
    // on disk once that submission settled.
    const afterFirst = historyRows(fixture.workRoot)
    assert.deepEqual(afterFirst.map(row => row.content), ['shared recall chain'],
      'the production owner appended exactly one real row')
    assert.equal(afterFirst[0]!.sessionId, prompts[0]!.sessionId,
      'the row carries the session the submission itself ensured — the deferred-start gate still holds through the TSP path')

    // The SECOND identical Enter is a real business submission (the writer runs,
    // the model turn happens) that the per-file consecutive dedupe SKIPS: one
    // submission accepted, no second row.
    await submitLine(fixture, 'shared recall chain')
    await waitFor('the second prompt write', () => prompts.length === 2, 30_000)
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content), ['shared recall chain'],
      'the repeat took the policy skip: still one row, not a broken chain')
    assert.equal(prompts[1]!.sessionId, prompts[0]!.sessionId,
      'both submissions reached the writer under the same live session')

    // The second occurrence has no phantom editor position: from a real draft,
    // the pre-browse ↑ owns the caret, the next ↑ enters the one settled row, a
    // third ↑ is unmoved, and ↓ restores the exact draft/caret.
    await composerReady(fixture)
    await typeDraft(fixture, 'my own draft')
    await arrow(fixture, UP, { text: 'my own draft', cursor: 0 })
    await arrow(fixture, UP, { text: 'shared recall chain', cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: 'my own draft', cursor: 12 })
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content), ['shared recall chain'],
      'the skipped second occurrence did not materialize as a second file row')
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('an input that really carries a staged attachment is delivered but persists no plain-text row (the real policy, not an injected predicate)', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], nativeImages: true })
  const prepared: Array<{ content: unknown }> = []
  const recorder = fixture.recordPrompts(call => { prepared.push(call.message as { content: unknown }) })
  try {
    const pastedPath = join(fixture.workRoot, 'staged-shot.png')
    writeFileSync(pastedPath, await realPng())

    await waitForInputDelivery(fixture.pane)
    // ONE real terminal bracketed paste: the production intake owner reads the
    // file, stages it and replaces exactly that span with the canonical token.
    fixture.pane.input.type(`\u001b[200~${pastedPath} \u001b[201~`)
    await waitFor('the composer to hold the canonical image token', () =>
      /\[image #\d+ \(8×8\)\]/u.test(composerText(fixture)), 25_000)
    const draft = composerText(fixture)
    assert.equal(draft.includes(pastedPath), false, 'the raw client path is gone from the draft')

    fixture.pane.input.type('\r')
    await waitFor('the attached prompt write', () => recorder.calls() >= 1, 30_000)
    // The business submission really ran, with a real image block…
    const wire = JSON.stringify(prepared[0])
    assert.ok(wire.includes('"type":"image"'), `a real image block was prepared (got ${wire.slice(0, 200)})`)
    // …while the history owner refused any plain-text row for it.
    assert.deepEqual(historyRows(fixture.workRoot), [],
      'an attachment-bearing submission persists no plain-text recall row')
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('the occurrence token is not a file-level fact: the row schema stays content/cwd/ts/sessionId', async (t) => {
  // Pinned so this lane's boundary stays honest: the token rides only the
  // settlement payload, which the JSONL never records. Nothing here can witness
  // it, and the chain case in `test/app/tern-tsp-live-mount.test.ts` owns that
  // half. If the schema ever gains an occurrence field, this is the case that
  // must change — together with the claim above.
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'] })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'a schema-pinned row')
    await historyRowsFor(fixture, 'a schema-pinned row')
    const dir = join(fixture.workRoot, 'user-history')
    const raw = readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).join('')
    const keys = Object.keys(JSON.parse(raw.trim().split('\n')[0]!) as Record<string, unknown>).sort()
    assert.deepEqual(keys, ['content', 'cwd', 'sessionId', 'ts', 'v'],
      'the persisted row carries no occurrence identity')
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('a sessionless TSP boot recalls launch-cwd history with real ↑/↓, then the first Session Enter replaces that pool with its own row', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-tsp-recall-boot-')
  const launchCwd = process.cwd()
  seedHistoryRows(workRoot, launchCwd, [
    { content: 'legacy launch cwd row', version: 1 },
    { content: 'older session cwd row', sessionId: 'older-session' },
  ])
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], workRoot })
  const prompts: Array<{ sessionId: string }> = []
  const recorder = fixture.recordPrompts(call => { prompts.push({ sessionId: call.sessionId }) })
  try {
    await waitForInputDelivery(fixture.pane)
    assert.deepEqual(await sessionHeaders(fixture), [], 'the boot is sessionless')
    await composerReady(fixture)
    await arrow(fixture, UP, { text: 'older session cwd row', cursor: 0 })
    await arrow(fixture, UP, { text: 'legacy launch cwd row', cursor: 0 })
    await arrow(fixture, DOWN, { text: 'older session cwd row', cursor: 'older session cwd row'.length })
    await arrow(fixture, DOWN, { text: '', cursor: 0 })
    assert.equal(recorder.calls(), 0, 'recall arrows submitted nothing')

    await submitLine(fixture, 'first session row')
    await waitFor('the first Session prompt', () => prompts.length === 1, 30_000)
    await historyRowsFor(fixture, 'first session row', prompts[0]!.sessionId)
    await composerReady(fixture)
    await typeDraft(fixture, 'unsent draft')
    await arrow(fixture, UP, { text: 'unsent draft', cursor: 0 })
    await arrow(fixture, UP, { text: 'first session row', cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: 'unsent draft', cursor: 'unsent draft'.length })
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content),
      ['legacy launch cwd row', 'older session cwd row', 'first session row'],
      'the file keeps the launch cwd rows while the live Session projects only its own')
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('a boot-seeded last row dedupes the first real Enter, and a startup resume with no own rows has no cwd recall candidate', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-tsp-recall-boot-dedupe-')
  const launchCwd = process.cwd()
  const last = 'the boot-seeded last row'
  seedHistoryRows(workRoot, launchCwd, [{ content: last, version: 1 }])
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], workRoot })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    assert.deepEqual(await sessionHeaders(fixture), [], 'the boot is sessionless')
    await composerReady(fixture)
    await arrow(fixture, UP, { text: last, cursor: 0 })
    await arrow(fixture, DOWN, { text: '', cursor: 0 })

    // The boot seed also initializes the canonical last-content anchor: the
    // real business submission happens, but the consecutive dedupe leaves the
    // production store with exactly ONE row and NO phantom recall position.
    await submitLine(fixture, last)
    await waitFor('the real business prompt', () => prompts.length === 1, 30_000)
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content), [last],
      'the real prompt was submitted but the boot anchor skipped a second row')
    await composerReady(fixture)
    await typeDraft(fixture, 'user draft')
    await arrow(fixture, UP, { text: 'user draft', cursor: 0 })
    await arrow(fixture, UP, { text: last, cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: 'user draft', cursor: 'user draft'.length })
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }

  // A SECOND clean `$DSH_HOME` with a startup-resumed, blank Session: the boot
  // guard must not seed the launch-cwd rows into A's recall window. Its own
  // hydration has no rows, so a real ↑ is a no-op rather than a cwd leak.
  const resumeRoot = life.tempDir('dsh-tsp-recall-resume-guard-')
  seedHistoryRows(resumeRoot, process.cwd(), [{ content: 'another window cwd row', version: 1 }])
  const resumed = await createDirectTspFixture(life, {
    deltas: ['ok'],
    workRoot: resumeRoot,
    persistedBlankSession: { id: 'ib-resume-guard-session' },
    startup: { sessionId: 'ib-resume-guard-session' },
  })
  try {
    await waitForInputDelivery(resumed.pane)
    await waitFor('the resumed Session to own a live Agent', () =>
      liveAgentIds(resumed).includes('ib-resume-guard-session'), 30_000)
    await composerReady(resumed)
    resumed.pane.input.type(UP)
    await probeNoRecall(resumed, { text: '', cursor: 0 })
  } finally {
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await resumed.settle()
  }
})

test('a browse opened on the boot cwd pool cannot survive the Enter that publishes the first Session', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-tsp-recall-publish-')
  const submitted = 'older row submitted by the browse'
  const newest = 'newest boot row'
  seedHistoryRows(workRoot, process.cwd(), [
    { content: submitted, sessionId: 'older-session' },
    { content: newest },
  ])
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], workRoot })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await composerReady(fixture)

    // A real draft, then a real browse of the boot pool. The pre-browse ↑ owns
    // the caret; the next two ↑ walk index 0 then index 1.
    await typeDraft(fixture, 'draft before the browse')
    await arrow(fixture, UP, { text: 'draft before the browse', cursor: 0 })
    await arrow(fixture, UP, { text: newest, cursor: 0 })
    await arrow(fixture, UP, { text: submitted, cursor: 0 })

    // Enter on the browsed row IS the first agent-facing input: it publishes the
    // Session, and the formal publication retires the browse with it.
    fixture.pane.input.type('\r')
    await waitFor('the browsed row to be submitted', () => composerText(fixture) === '', 30_000)
    await waitFor('the first Session prompt', () => prompts.length === 1, 30_000)
    await historyRowsFor(fixture, submitted, prompts[0]!)
    fixture.pane.input.type(DOWN)
    // If the outgoing browse had survived, this ↓ would have handed back the
    // pre-browse draft, and the probe could never read a bare `x`.
    await composerReady(fixture)

    await arrow(fixture, UP, { text: submitted, cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: '', cursor: 0 })
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content),
      [submitted, newest, submitted],
      'the boot rows stay in the file while the live Session projects only its own')
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('a startup resume does not seed launch-cwd rows into the mounted recall, and a real ↑ has no candidate before its own submit', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-tsp-recall-resume-')
  const target = 'ib-startup-resume-target'
  seedHistoryRows(workRoot, workRoot, [{ content: 'startup cwd row for another session', sessionId: 'other-startup' }])
  seedHistoryRows(workRoot, process.cwd(), [{ content: 'startup launch cwd row', version: 1 }])
  const fixture = await createDirectTspFixture(life, {
    deltas: ['ok'],
    workRoot,
    persistedBlankSession: { id: target },
    startup: { sessionId: target },
  })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    assert.deepEqual(await sessionHeaders(fixture), [target], 'startup already owns a published Session')
    await waitFor('the resumed Session to own a live Agent', () => liveAgentIds(fixture).includes(target), 30_000)
    await composerReady(fixture)
    fixture.pane.input.type(UP)
    await probeNoRecall(fixture, { text: '', cursor: 0 })

    await submitLine(fixture, 'resumed session row')
    await waitFor('the resumed Session prompt', () => prompts.length === 1, 30_000)
    await historyRowsFor(fixture, 'resumed session row', prompts[0]!)
    await composerReady(fixture)
    await typeDraft(fixture, 'keep this draft')
    await arrow(fixture, UP, { text: 'keep this draft', cursor: 0 })
    await arrow(fixture, UP, { text: 'resumed session row', cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: 'keep this draft', cursor: 'keep this draft'.length })
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('a staged image draft refuses recall through the existing application admission and its submit writes no dead placeholder row', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-tsp-recall-image-')
  seedHistoryRows(workRoot, process.cwd(), [{ content: 'plain row before staged image' }])
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], nativeImages: true, workRoot })
  const prepared: Array<{ content: unknown }> = []
  const recorder = fixture.recordPrompts(call => { prepared.push(call.message as { content: unknown }) })
  try {
    const pastedPath = join(fixture.workRoot, 'staged-no-placeholder.png')
    writeFileSync(pastedPath, await realPng())

    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type(`\u001b[200~${pastedPath} \u001b[201~`)
    await waitFor('the composer to hold the canonical image token', () =>
      /\[image #\d+ \(8×8\)\]/u.test(composerText(fixture)), 25_000)
    const staged = composerText(fixture)
    assert.equal(staged.includes(pastedPath), false, 'the raw client path is gone from the draft')

    // The first unmodified ↑ keeps its normal line-boundary duty; the next one
    // asks the existing application admission, which refuses an attachment
    // draft, so the staged bytes remain exactly what the user sees.
    if (composerCursor(fixture) !== 0) await arrow(fixture, UP, { text: staged, cursor: 0 })
    else fixture.pane.input.type(UP)
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: staged, cursor: staged.length })
    assert.equal(composerText(fixture), staged, 'the staged image was not replaced by a recalled placeholder')

    fixture.pane.input.type('\r')
    await waitFor('the attachment-bearing prompt write', () => recorder.calls() >= 1, 30_000)
    const wire = JSON.stringify(prepared[0])
    assert.ok(wire.includes('"type":"image"'), `the real image block was prepared (got ${wire.slice(0, 200)})`)
    assert.equal(historyRows(fixture.workRoot).some(row => typeof row.content === 'string'
      && row.content.includes('[image #')), false, 'no dead placeholder became a plain-text recall row')
    assert.deepEqual(historyRows(fixture.workRoot).map(row => row.content), ['plain row before staged image'],
      'the attachment submit added no row to the real history file')
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('a real /new and /resume switch shows B’s own row in B and A’s own row again after returning', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], sessionBrowser: true })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'row owned by A')
    await waitFor('A’s first prompt write', () => prompts.length === 1, 30_000)
    await historyRowsFor(fixture, 'row owned by A', prompts[0]!)
    const sessionA = firstSessionId(historyRows(fixture.workRoot), 'row owned by A')

    await composerReady(fixture)
    await arrow(fixture, UP, { text: 'row owned by A', cursor: 0 })
    // There is no genuine way to preserve an open browse immediately before a
    // typed `/new` command through the real composer: every draft edit (backspace,
    // paste, insert) already retires the browse at `src/tui/tsp/editor.ts`, and
    // the submission itself clears before the formal publication. This case owns
    // cross-Session projection isolation; browse retirement at a successful
    // publication is pinned in the dedicated boot-Enter case and the mount lane.
    await arrow(fixture, DOWN, { text: '', cursor: 0 })

    await submitLine(fixture, '/new')
    const afterNew = await waitForSessionHeaders(fixture, 2, 'the /new Session in the real store')
    const sessionB = afterNew.find(id => id !== sessionA)
    assert.ok(sessionB, '/new published a different real Session')
    await waitFor('B to own a live Agent', () => liveAgentIds(fixture).includes(sessionB), 30_000)
    await composerReady(fixture)
    // B is a brand-new Session with no rows of its own: a real ↑ is a no-op,
    // never A's row and never a launch-cwd fallback.
    fixture.pane.input.type(UP)
    await probeNoRecall(fixture, { text: '', cursor: 0 })

    await submitLine(fixture, 'row owned by B')
    await waitFor('B’s prompt write', () => prompts.length === 2, 30_000)
    await historyRowsFor(fixture, 'row owned by B', prompts[1]!)
    await composerReady(fixture)
    await arrow(fixture, UP, { text: 'row owned by B', cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: '', cursor: 0 })
    assert.equal(composerText(fixture), '', 'B’s browse never walks back A’s row')

    await submitLine(fixture, `/resume ${sessionA}`)
    await waitFor('A to own the live Agent again', () =>
      liveAgentIds(fixture).includes(sessionA) && !liveAgentIds(fixture).includes(sessionB), 30_000)
    await composerReady(fixture)
    await typeDraft(fixture, 'back in A')
    await arrow(fixture, UP, { text: 'back in A', cursor: 0 })
    await arrow(fixture, UP, { text: 'row owned by A', cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: 'back in A', cursor: 'back in A'.length })
  } finally {
    recorder.detach()
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})

test('a refused `!` user-shell line restores its draft but never enters the ↑ recall surface', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'] })
  const line = '!echo refused shell'
  try {
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type(line)
    await waitFor('the shell draft', () => composerText(fixture) === line, 25_000)
    fixture.pane.input.type('\r')
    await waitFor('the unchanged TSP shell refusal', () =>
      fixture.pane.output.text().includes('User-shell UI is not available in TSP yet'), 25_000)
    await waitFor('the refused line restored into the composer', () =>
      composerText(fixture) === line && composerCursor(fixture) === line.length, 25_000)
    assert.deepEqual(historyRows(fixture.workRoot), [],
      'the refusal sits before the production history writer')
    await arrow(fixture, UP, { text: line, cursor: 0 })
    fixture.pane.input.type(UP)
    await arrow(fixture, DOWN, { text: line, cursor: line.length })
    assert.equal(composerText(fixture), line, 'a refused shell line never became an editor-recall entry')
  } finally {
    // reason: the fixture's OWN bounded teardown window for the real disposal.
    await fixture.settle()
  }
})
