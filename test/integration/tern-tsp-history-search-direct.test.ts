/**
 * TSP I-E: the `Ctrl+R` History search through the OFFICIAL Direct composition.
 *
 * This is the lane that proves the seat reads the REAL
 * `$DSH_HOME/user-history` JSONL through the REAL production
 * `FileHistorySearchSource`, mounted by the REAL `bootstrap` →
 * `selectRendererMount` → `SurfaceRuntime.start` → `mount(image, status,
 * historySearch)` chain over REAL live Agents, and that a Restore reaches the
 * ONE real composer WITHOUT touching the Session writer. The decisive sink is
 * the `DirectSessionWriter.prompt` call count: a Restore must leave it
 * unchanged and the NEXT Enter must raise it by exactly one.
 *
 * PRODUCTION PREREQUISITES REPRODUCED (see `test/support/direct-tsp-fixture`):
 * the real Host service composition and live Agents, the real TUI runner in its
 * Direct branch, the real `SubmissionController` / `DirectSessionWriter` /
 * `InputHistory`, the real `FileHistorySearchSource` over the isolated
 * `$DSH_HOME`, and the real TSP renderer over the shipped SDK.
 *
 * STAND-INS: the scripted streaming model (the endpoint only) and the scripted
 * tty. A REAL client keyboard/pointer/layout run is
 * `scripts/tern-pane-history-search-ux.mjs`, and the OS clipboard write, IME and
 * physical input stay `NOT_VERIFIED` in this file: the copy witness here is the
 * payload the Client-local policy received, never a claim about the desktop
 * clipboard.
 * @module @xmoon76/dsh-pi-tui/test/integration/tern-tsp-history-search-direct
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createDirectTspFixture, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitForEditableComposer, type ComposerProbeState } from '../support/tsp-composer-readiness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { historyFilePath } from '../../src/client/history/store.ts'

const CTRL_R = '\u0012'
const ENTER = '\r'
const TAB = '\t'
const DOWN = '\u001b[B'
const ALT_C = '\u001bc'

interface SeedRow {
  readonly content: string
  /** `1` writes the legacy kimi-shaped row (no cwd, no ts, no sessionId). */
  readonly version?: 1 | 2
  readonly sessionId?: string
  readonly cwd?: string
}

/** Every history row the isolated `$DSH_HOME` currently holds. */
function allRows(workRoot: string): Array<Record<string, unknown>> {
  const dir = join(workRoot, 'user-history')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>))
}

function seedRows(workRoot: string, cwd: string, rows: readonly SeedRow[]): string {
  const file = historyFilePath(workRoot, cwd)
  mkdirSync(dirname(file), { recursive: true })
  const lines = rows.map((row, index) => {
    if (row.version === 1) return JSON.stringify({ content: row.content })
    return JSON.stringify({
      v: 2,
      content: row.content,
      cwd: row.cwd ?? cwd,
      ts: 1_700_000_000_000 + index,
      ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    })
  })
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function composerState(fixture: DirectTspFixture): ComposerProbeState {
  const editor = wireNodes(fixture.pane).find(node => node.id === 'dock.quiet-composer.composer')
  if (editor === undefined) return { text: '', cursor: -1 }
  return { text: typeof editor.p.text === 'string' ? editor.p.text : '', cursor: Number(editor.p.cursor ?? -1) }
}

async function composerReady(fixture: DirectTspFixture): Promise<void> {
  await waitForEditableComposer(fixture.pane, () => composerState(fixture))
}

/** The current dock text set, read off the folded live wire. */
function dockTexts(fixture: DirectTspFixture): string[] {
  return wireNodes(fixture.pane).map(node => {
    const value = (node.p as { text?: unknown }).text
    return typeof value === 'string' ? value : ''
  }).filter(Boolean)
}

function cardPainted(fixture: DirectTspFixture): boolean {
  return wireNodes(fixture.pane).some(node => node.id.includes('history-card'))
}

/** Type a draft and wait for the wire to carry it (never a blind sleep). */
async function typeDraft(fixture: DirectTspFixture, draft: string): Promise<void> {
  await composerReady(fixture)
  fixture.pane.input.type(draft)
  await waitFor(`the composer holds ${JSON.stringify(draft)}`, () => composerState(fixture).text === draft, 30_000)
}

/** A real submission through the composer: type, Enter, wait for the clear. */
async function submitLine(fixture: DirectTspFixture, line: string): Promise<void> {
  await typeDraft(fixture, line)
  fixture.pane.input.type(ENTER)
  await waitFor('the submitted line to leave the composer', () => composerState(fixture).text !== line, 30_000)
}

/** One key that must repaint the surface, awaited on the frame itself. */
async function keyWithFrame(fixture: DirectTspFixture, bytes: string, label: string): Promise<void> {
  const mark = fixture.pane.frameCount()
  fixture.pane.input.type(bytes)
  await waitFor(`${label} painted a frame`, () => fixture.pane.frameCount() > mark, 30_000)
}

async function observeNothing(fixture: DirectTspFixture): Promise<void> {
  // A refused gesture writes no frame, and a pending debounced round settles
  // inside this span; the SDK frame-credit ack cycle is covered by the frame
  // waits above, so this is a bounded negative observation window, not a sleep.
  await new Promise(resolve => setTimeout(resolve, 400)) // reason: bounded negative window
}

/** The live Agent ids the real Host currently owns. */
function liveAgentIds(fixture: DirectTspFixture): string[] {
  const agents = fixture.ctx.get('agents') as unknown as { list(): Array<{ session: { id: string } }> }
  return agents.list().map(agent => agent.session.id)
}

/**
 * The projection scope the renderer is currently showing (`s3`), or `undefined`
 * while it sits BETWEEN scopes (the Loading state). Read-only: it folds the
 * same wire the assertions below read.
 */
function projectionScopeId(pane: DirectTspFixture['pane']): string | undefined {
  for (const node of wireNodes(pane)) {
    const match = /main\.(s\d+)-/u.exec(node.id)
    if (match !== null) return match[1]
  }
  return undefined
}

/** The REAL persisted session headers, as the sibling A/B/A lane reads them. */
async function waitForSessionHeaders(fixture: DirectTspFixture, expected: number, label: string): Promise<string[]> {
  const persistence = fixture.ctx.get('sessionPersistence') as unknown as {
    list(): Promise<readonly { header: { id: string } }[]>
  }
  const deadline = Date.now() + 30_000
  for (;;) {
    const ids = (await persistence.list()).map(entry => entry.header.id)
    if (ids.length === expected) return ids
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (got ${JSON.stringify(ids)})`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// ── A. The decisive real chain: source → scope → UI → draft, with no prompt ──

test('a real Ctrl+R over the production JSONL source restores the exact row into the ONE draft and writes no prompt', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], composerActions: true, historySearch: true })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'first real prompt to search')
    await waitFor('the real prompt write', () => prompts.length === 1, 30_000)
    const sessionA = prompts[0]!
    assert.ok(allRows(fixture.workRoot).some(row => row.content === 'first real prompt to search'
      && row.sessionId === sessionA), 'the production writer really recorded the row')

    await composerReady(fixture)
    await keyWithFrame(fixture, CTRL_R, 'the Ctrl+R chord')
    await waitFor('the card read the real store', () => dockTexts(fixture).some(text => text.startsWith('Results · 1 shown')), 30_000)
    assert.ok(dockTexts(fixture).some(text => text === '›first real prompt to search'),
      'the row the real source answered is the row on the wire')
    assert.ok(dockTexts(fixture).some(text => text === 'Session: ' + sessionA),
      'the Preview metadata names the real Session identity, not a guess')

    // Restore: the exact bytes land in the ONE composer, and the writer is untouched.
    await keyWithFrame(fixture, ENTER, 'the restore Enter')
    await waitFor('the restore wrote the draft', () => composerState(fixture).text === 'first real prompt to search', 30_000)
    assert.equal(prompts.length, 1, 'a Restore never reached the Session writer')
    assert.equal(cardPainted(fixture), false, 'and the card closed with it')
    await waitFor('the caret returned to the composer end',
      () => composerState(fixture).cursor === 'first real prompt to search'.length, 30_000)

    // The NEXT Enter is the one real submission.
    fixture.pane.input.type(ENTER)
    await waitFor('the later Enter wrote one prompt', () => prompts.length === 2, 30_000)
    assert.equal(prompts[1], sessionA, 'into the same live Session')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

// ── B. Scope rules are the SOURCE's rules, read through the seat ────────────

test('the Session scope hides v1 and foreign-session rows; Directory trusts them; All proves the cwd', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], composerActions: true, historySearch: true })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'mine in this session')
    await waitFor('the real prompt write', () => prompts.length === 1, 30_000)
    const sessionA = prompts[0]!
    const cwd = composerCwdOf(fixture)
    // Same file, three different truths: a legacy v1 row, a row owned by a
    // DIFFERENT session, and the live session's own row.
    seedRows(fixture.workRoot, cwd, [
      { content: 'legacy v1 row', version: 1 },
      { content: 'row owned by another session', sessionId: 'ses_definitely_not_live' },
      { content: 'mine in this session', sessionId: sessionA },
    ])

    await composerReady(fixture)
    await keyWithFrame(fixture, CTRL_R, 'Ctrl+R (Session scope)')
    await waitFor('the session page settled', () => dockTexts(fixture).some(text => text.startsWith('Results ·')), 30_000)
    const sessionPage = dockTexts(fixture).filter(text => text.startsWith('›'))
    assert.deepEqual(sessionPage, ['›mine in this session'],
      'the live Session scope shows ONLY its own v2 rows — never v1, never another session')

    await keyWithFrame(fixture, TAB, 'Tab → Directory')
    await waitFor('the directory page settled',
      () => dockTexts(fixture).some(text => text === 'Results · 3 shown'), 30_000)
    const summaries = dockTexts(fixture)
      .filter(text => /^[ ›]/.test(text) && !text.startsWith('Results ·'))
      .map(text => text.replace(/^[ ›]+/, ''))
    assert.ok(summaries.includes('legacy v1 row'), 'Directory includes the trusted legacy row')
    assert.ok(summaries.includes('row owned by another session'), 'and the other session\'s row')

    await keyWithFrame(fixture, TAB, 'Tab → All')
    await waitFor('the all-directory page settled',
      () => dockTexts(fixture).some(text => text.startsWith('Results · 3 shown')), 30_000)
    assert.ok(dockTexts(fixture).some(text => text === `Directory: ${cwd}`),
      'the Preview names the directory the row was proven to come from (Rule 1/2)')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

/** The live session cwd the `current` scope keys its file by. */
function composerCwdOf(fixture: DirectTspFixture): string {
  const files = readdirSync(join(fixture.workRoot, 'user-history')).filter(name => name.endsWith('.jsonl'))
  assert.equal(files.length, 1, 'the boot cwd has exactly one history file before the seed')
  const first = files[0]!
  const body = readFileSync(join(fixture.workRoot, 'user-history', first), 'utf8')
  const row = JSON.parse(body.split('\n').filter(line => line.trim() !== '')[0]!) as Record<string, unknown>
  assert.equal(typeof row.cwd, 'string', 'the production writer recorded a cwd')
  return row.cwd as string
}

test('All directories never fabricates a cwd for a legacy file it cannot prove', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], composerActions: true, historySearch: true })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'anchor row in the live cwd')
    await waitFor('the real prompt write', () => prompts.length === 1, 30_000)
    const liveCwd = composerCwdOf(fixture)
    // A second, UNPROVABLE history file: its name hashes a cwd nobody knows and
    // it holds only v1 rows. Rule 3 excludes it — the card must not invent a
    // directory for it.
    const ghostCwd = '/history-search/ghost-directory'
    seedRows(fixture.workRoot, ghostCwd, [{ content: 'unprovable legacy row', version: 1 }])

    await composerReady(fixture)
    await keyWithFrame(fixture, CTRL_R, 'Ctrl+R')
    await waitFor('the session page settled', () => dockTexts(fixture).some(text => text.startsWith('Results ·')), 30_000)
    await keyWithFrame(fixture, TAB, 'Tab → Directory')
    await keyWithFrame(fixture, TAB, 'Tab → All')
    await waitFor('the All page settled', () => dockTexts(fixture).filter(text => text.startsWith('›')).length >= 1, 30_000)
    const texts = dockTexts(fixture)
    assert.equal(texts.some(text => text.includes('unprovable legacy row')), false,
      'a legacy row with no cwd proof is excluded, never displayed under an invented directory')
    assert.ok(texts.some(text => text.includes(liveCwd.split('/').slice(-1)[0]!)),
      'the provable rows still name the directory they came from')
    // And the file itself was not lost: the proof rule is about display honesty,
    // not about the store.
    assert.ok(existsSync(historyFilePath(fixture.workRoot, ghostCwd)), 'the unprovable file stays on disk untouched')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

// ── C. Copy carries the RAW bytes, not the painted row ──────────────────────

test('Alt+C hands the Client-local copy policy the exact stored bytes including a painted-away newline', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], composerActions: true, historySearch: true })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'anchor prompt')
    await waitFor('the real prompt write', () => prompts.length === 1, 30_000)

    // A REAL bracketed paste keeps the newline inside the SAME prompt; the
    // production writer then stores the WHOLE entry as one JSONL row.
    const raw = 'first line\nsecond line of the same entry'
    await composerReady(fixture)
    fixture.pane.input.type('\u001b[200~' + raw + '\u001b[201~')
    await waitFor('the real draft holds the multi-line entry', () => composerState(fixture).text === raw, 30_000)
    fixture.pane.input.type(ENTER)
    await waitFor('the real multi-line prompt write', () => prompts.length === 2, 30_000)
    assert.ok(allRows(fixture.workRoot).some(row => row.content === raw),
      'the production writer stored the exact multi-line bytes in one row')

    await composerReady(fixture)
    await keyWithFrame(fixture, CTRL_R, 'Ctrl+R')
    await waitFor('the real page settled', () => dockTexts(fixture).some(text => text.startsWith('Results ·')), 30_000)
    // The multi-line row is the NEWEST, so it is selected from the first page:
    // the list shows its first line, the Preview carries the whole entry.
    assert.ok(dockTexts(fixture).some(text => text === '›first line'), 'the row summary is the first line only')
    assert.ok(dockTexts(fixture).some(text => text.includes('second line of the same entry')),
      'the FULL multi-line entry is readable in the Preview, not truncated')

    const beforeCopy = fixture.pane.output.text().length
    fixture.pane.input.type(ALT_C)
    await waitFor('the Client-local copy policy emitted its payload',
      () => fixture.pane.output.text().length > beforeCopy, 30_000)
    const emitted = fixture.pane.output.text().slice(beforeCopy)
    assert.ok(emitted.includes(Buffer.from(raw, 'utf8').toString('base64')),
      'the copy payload carries the EXACT stored bytes, newline included')
    assert.equal(prompts.length, 2, 'and Copy wrote no prompt')
    assert.equal(composerState(fixture).text, '', 'and touched no draft')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

// ── D. A real publication retires the open card ─────────────────────────────

test('a real /new after closing History scopes the next card to the new Session', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], composerActions: true, historySearch: true, sessionBrowser: true })
  const prompts: string[] = []
  const recorder = fixture.recordPrompts(call => { prompts.push(call.sessionId) })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitLine(fixture, 'row owned by the outgoing session')
    await waitFor('the real prompt write', () => prompts.length === 1, 30_000)
    const sessionA = prompts[0]!

    await composerReady(fixture)
    await keyWithFrame(fixture, CTRL_R, 'Ctrl+R')
    await waitFor('the card read the real store', () => dockTexts(fixture).some(text => text.startsWith('Results · 1 shown')), 30_000)

    // The card owns the keys, so a typed `/new` is HISTORY TEXT — the
    // publication below is driven through the production command path by
    // closing the card first, exactly as a user does.
    await keyWithFrame(fixture, '\u001b', 'Esc closes the card')
    assert.equal(cardPainted(fixture), false, 'the card is gone')
    // The Ctrl+R below must read B's Session scope, so this wait chain is the
    // FULL publication commit — Session store, live Agent, the new TSP Main
    // projection's Loading→Welcome frames and a settled composer — the same
    // barrier the sibling A/B/A history lane pins. Waiting only for "B exists"
    // let the chord open inside A's scope on slow CI runs and search A's rows.
    const scopeBeforeNew = projectionScopeId(fixture.pane)
    const framesBeforeNew = fixture.pane.frameCount()
    await submitLine(fixture, '/new')
    const afterNew = await waitForSessionHeaders(fixture, 2, 'the /new Session in the real store')
    const sessionB = afterNew.find(id => id !== sessionA)
    assert.ok(sessionB !== undefined, 'a DIFFERENT real Session was published')
    await waitFor('B owns a live Agent', () => liveAgentIds(fixture).includes(sessionB!), 30_000)
    await waitFor('the new Session projection commit', () => {
      const nodes = wireNodes(fixture.pane)
      if (nodes.some(node => node.id === 'main.loading')) return false
      if (fixture.pane.frameCount() <= framesBeforeNew) return false
      const scope = projectionScopeId(fixture.pane)
      if (scope !== undefined && scope !== scopeBeforeNew) return true
      return nodes.some(node => node.id.startsWith('main.welcome-'))
        && fixture.pane.frames().slice(framesBeforeNew).some(frame =>
          frame.ops.some(op => op[0] === 'add' && op[1] === 'main.loading'))
    }, 30_000)

    await composerReady(fixture)
    await keyWithFrame(fixture, CTRL_R, 'Ctrl+R in the new Session')
    // B is brand-new: its empty scope settles at EXACTLY zero rows. A loose
    // prefix would also pass while the card still shows A's old result page.
    await waitFor('the new scope settled', () => dockTexts(fixture).some(text => text === 'Results · 0 shown'), 30_000)
    assert.equal(dockTexts(fixture).some(text => text.includes('row owned by the outgoing session')), false,
      'the incoming Session never browses the outgoing Session\'s rows')
    const restore = wireNodes(fixture.pane).find(node => /-restore$/.test(node.id))
    assert.ok(restore !== undefined, 'the SAME card still paints its Restore button')
    assert.equal((restore.p['attrs'] as Record<string, unknown> | undefined)?.['aria-disabled'], 'true',
      'an empty page paints it disabled: no clickable control without a settled row')
    assert.equal(prompts.length, 1, 'and nothing was written by the whole switch')
  } finally {
    recorder.detach()
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})

// ── E. A pane without the capability states the truth ───────────────────────

test('a pane that never negotiated the card kinds consumes Ctrl+R with an explicit refusal and an intact draft', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ok'], composerActions: true })
  try {
    await waitForInputDelivery(fixture.pane)
    await typeDraft(fixture, 'draft before the chord')
    await keyWithFrame(fixture, CTRL_R, 'Ctrl+R on an unsupported pane')
    assert.ok(dockTexts(fixture).some(text => text === 'Input history search is unavailable in this Tern pane.'),
      'the refusal is stated on the existing notice surface')
    assert.equal(cardPainted(fixture), false, 'no half card appeared')
    assert.equal(composerState(fixture).text, 'draft before the chord',
      'and the chord inserted nothing into the draft')
    await observeNothing(fixture)
    assert.equal(composerState(fixture).text, 'draft before the chord', 'still untouched after the window')
  } finally {
    // reason: fixture.settle() awaits ownership cleanup, not a timer (receiver-blind guard).
    await fixture.settle()
  }
})
