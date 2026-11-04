/**
 * The TSP submit path against the REAL persistence owner: the official Direct
 * composition (`support/direct-tsp-fixture.ts` — the real runner, the real
 * `ApplicationEvents` + `SubmissionController`, the real `InputHistory` write
 * policy, the real `$DSH_HOME/user-history` file, the real TSP renderer over a
 * scripted pane; only the model and the tty are scripted).
 *
 * What this lane owns, and what it deliberately does NOT claim:
 *
 * - PROVEN HERE: a real TSP Enter is carried by the PRODUCTION submission owner
 *   all the way into the production history writer. The appended row, its
 *   `sessionId` and the per-file write-policy SKIP are read back from the real
 *   file, so a middle layer that dropped the submit plumbing cannot hide here.
 *   A real staged attachment is likewise refused by the real policy (delivered
 *   to the model, persisted as no row) — driven by the actual staged state,
 *   never by an injected predicate.
 * - NOT PROVEN HERE, and not claimed: the OCCURRENCE TOKEN a submission carries
 *   reaches only the settlement payload. `persistHistoryRecord` writes
 *   `v / content / cwd / ts / sessionId` and nothing else, so no file assertion
 *   can witness the token, and in this milestone the TSP mount presents no recall
 *   surface, so the real Direct lane has no observation point for its own
 *   mount's recall kernel at all. The token and the same-mount settlement are
 *   therefore pinned in `test/app/tern-tsp-live-mount.test.ts`, where the test
 *   owns the mount and can observe its display seam directly.
 *
 * These two lanes are the writer half and the occurrence half of ONE contract.
 * Neither is presented as the whole chain, and no case here may be read as a
 * physical-GUI, Remote or visible-recall qualification.
 * @module @xmoon76/dsh-pi-tui/test/integration/tern-tsp-history-persist-direct
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createDirectTspFixture, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** One parsed history row, read back through the production store's own path. */
interface Row {
  readonly content?: unknown
  readonly cwd?: unknown
  readonly sessionId?: unknown
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

test('a real TSP Enter persists through the production owner with the FINAL session id, and an identical repeat is a policy SKIP with no second row', async (t) => {
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
    const require = createRequire(import.meta.url)
    const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
    const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
      input: unknown,
    ) => { png(): { toBuffer(): Promise<Buffer> } }
    const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).png().toBuffer())
    const pastedPath = join(fixture.workRoot, 'staged-shot.png')
    writeFileSync(pastedPath, png)

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
    await waitFor('the history row', () => historyRows(fixture.workRoot).length > 0, 30_000)
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
