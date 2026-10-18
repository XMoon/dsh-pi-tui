/**
 * S2/PR-B §B1 — the rc.2 Session persistence and event boundary (L5).
 *
 * SOURCE → DECISION → SINK: the OFFICIAL JSONL persistence writes and reads the
 * rc.2 vocabulary (`job/registered`, `job/settled`, `working-directory/change`,
 * `subagent/catalog` v2 external) and the optional log-only DeepSeek Messages
 * `thinking` request field verbatim; a RELEASED old generation on disk is
 * classified, read through the official migration WITHOUT being rewritten, and
 * only a write open publishes the current-generation successor; a newer stored
 * format is refused explicitly instead of reading as an empty Session.
 *
 * FIXTURE (real): the official Agent-loop prerequisites (real projections +
 * directory owner), the real `session-persistence-jsonl` backend on an isolated
 * root, the real session-query engine, and the REAL released-v1 artifact
 * committed at `test/fixtures/session-format/`. STAND-INS: none — the old
 * generation is a real official product artifact. ABSENT: the user's real
 * DSH_HOME, network, an Agent/model request.
 *
 * The released-v3 reader itself is NOT runnable in this dependency set: the
 * old-reader refusal expectation is verified against the OFFICIAL released-v3
 * admission contract (`assertV3EventAdmission` + `RELEASED_V3_EVENT_TYPES`)
 * instead, and is never reported as an executed old-reader run.
 *
 * @module @xmoon76/dsh-pi-tui/session-v4-rc2-persistence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION, type SessionHeader } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import { restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { buildTaskRows } from '../src/domain/task/browser.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const FIXTURE_V1 = new URL('./fixtures/session-format/released-v1-real-shapes.jsonl', import.meta.url)
const CURRENT_SUFFIX = '.zstd'
/** The generation artifacts in one session directory (the backend's lock file
 *  is not a generation). */
function generationFiles(dir: string): string[] {
  return readdirSync(dir).filter(name => name.startsWith('session.') && name !== 'session.lock').sort()
}
const signal = new AbortController().signal

interface Booted {
  readonly ctx: Context
  readonly persistence: SessionPersistence
  readonly root: string
}

/** Mount the real persistence + query composition on an isolated root. */
async function boot(life: TestLifecycle, root: string): Promise<Booted> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  return { ctx, persistence: ctx.get('sessionPersistence') as SessionPersistence, root }
}

/** Every file under one root, with its content hash, as a comparable map. */
function treeDigest(root: string): Map<string, string> {
  const digest = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else digest.set(relative(root, full), createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(root)
  return digest
}

/** Place one plain-JSONL artifact as the official physical generation: zstd
 *  frames [header line][body], exactly what the JSONL backend writes. */
function placeArtifact(target: string, plainJsonl: string): void {
  const newline = plainJsonl.indexOf('\n')
  assert.ok(newline > 0, 'the artifact needs a header line')
  writeFileSync(target, Buffer.concat([
    zstdCompressSync(Buffer.from(plainJsonl.slice(0, newline + 1))),
    zstdCompressSync(Buffer.from(plainJsonl.slice(newline + 1))),
  ]))
}

/** The single stored session directory materialized under one persistence
 *  root (`<root>/<project>/<encoded session id>/`). */
function sessionDirOf(root: string): string {
  const projects = readdirSync(root)
  assert.equal(projects.length, 1, 'exactly one project directory')
  const dirs = readdirSync(join(root, projects[0]!))
  assert.equal(dirs.length, 1, 'exactly one session directory')
  return join(root, projects[0]!, dirs[0]!)
}

test('the rc.2 event vocabulary round-trips through the real persistence and the official cold read', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s2b-b1-vocabulary-')
  const booted = await boot(life, root)
  const id = SessionId('session-b1-rc2-vocabulary')
  const header: SessionHeader = {
    id,
    createdAt: 1_700_000_000_000,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  }
  const handle = await booted.persistence.create(header)
  const registered = {
    jobId: 'job-b1',
    owner: String(id),
    kind: 'bash',
    label: 'sleep 1',
    startedAt: 1_700_000_000_001,
  }
  await handle.append([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time: 3, data: {
      header: {
        config: {
          provider: 'scripted',
          model: 'scripted-model',
          // The DeepSeek Messages auxiliary search's OPTIONAL log-only field:
          // persistence stores it verbatim and no fold may reinterpret it.
          thinking: { type: 'disabled' },
        },
      },
      reason: 'initial',
    } },
    { type: 'job/registered', seq: 3, time: 4, data: registered },
    { type: 'job/settled', seq: 4, time: 5, data: {
      ...registered,
      finishedAt: 1_700_000_000_002,
      status: 'completed',
      cause: 'producer',
      producerReported: true,
    } },
    { type: 'working-directory/change', seq: 5, time: 6, data: { cwd: '/work/moved' } },
    { type: 'subagent/catalog', seq: 6, time: 7, data: {
      childId: 'child-external',
      childCreatedAt: 1_700_000_000_003,
      version: 2,
      mode: 'external',
      label: 'external run',
    } },
    { type: 'step/end', seq: 7, time: 8, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as never)
  await handle.flush()
  await handle.close()

  // Listing/stat classification: a current-format log needs no migration.
  const listed = await booted.persistence.list()
  const row = listed.find(candidate => String(candidate.header.id) === String(id))
  assert.ok(row, 'the stored session is listed')
  assert.equal(row.formatStatus, 'current')
  assert.equal((await booted.persistence.stat(id))?.formatStatus, 'current')

  // A read open returns the COMPLETE log, byte-for-byte values included, and
  // writes nothing: the root's file digest is identical afterwards.
  const before = treeDigest(root)
  const readHandle = await booted.persistence.open(id, 'read')
  const read = await readHandle.read()
  await readHandle.close()
  assert.equal(read.events.length, 9, 'every appended event is stored and returned')
  assert.deepEqual(
    read.events.map(event => event.type),
    ['turn/start', 'step/start', 'request/header', 'job/registered', 'job/settled', 'working-directory/change', 'subagent/catalog', 'step/end', 'turn/end'],
  )
  assert.deepEqual(
    (read.events[3]!.data as { readonly jobId?: unknown }).jobId,
    'job-b1',
    'the job registration identity survives verbatim',
  )
  assert.deepEqual(
    ((read.events[2]!.data as { header: { config: { thinking?: unknown } } }).header.config.thinking),
    { type: 'disabled' },
    'the optional log-only thinking field survives verbatim',
  )
  assert.deepEqual(treeDigest(root), before, 'a read open never rewrites the stored artifact')

  // The official COLD read the TUI's child/observation paths use: the same
  // complete log plus the official projection baseline of that cut.
  const query = booted.ctx.get('sessionQuery') as {
    observeSession(sessionId: SessionId, options?: { projectionMode?: 'all' | 'none' }): Promise<{
      header: SessionHeader
      events: readonly { readonly type: string }[]
      projections?: { readonly values?: Readonly<Record<string, unknown>> }
      [Symbol.dispose](): void
    }>
  }
  const observation = await query.observeSession(id, { projectionMode: 'all' })
  try {
    assert.equal(observation.header.cwd, '/work', 'the header keeps the ORIGINAL project')
    assert.equal(observation.events.length, 9)
    assert.equal(
      observation.projections?.values?.workingDirectory,
      '/work/moved',
      'the official projection carries the committed effective directory',
    )
  } finally {
    observation[Symbol.dispose]()
  }
  assert.deepEqual(treeDigest(root), before, 'the cold observation read writes nothing either')
})

test('a released generation the current migration refuses reports the diagnostic instead of an empty Session', async t => {
  // The committed released-v1 artifact has surface events BEFORE its first
  // step: the official v2->v3 promotion refuses to invent a system head for
  // it ("cannot acquire a system head without changing chronology"). That is a
  // real property of that published artifact — the reader must say so, keep the
  // source bytes untouched and publish nothing.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s2b-b1-released-refusal-')
  const fixtureText = readFileSync(FIXTURE_V1, 'utf8')
  const fixtureHeader = JSON.parse(fixtureText.slice(0, fixtureText.indexOf('\n'))) as { id: string; cwd?: string }
  const id = SessionId(fixtureHeader.id)
  const first = await boot(life, root)
  const seedHandle = await first.persistence.create({
    id,
    createdAt: 1,
    version: SESSION_FORMAT_VERSION,
    cwd: fixtureHeader.cwd as string,
    isSeeded: false,
    delegationDepth: 0,
  })
  await seedHandle.flush()
  await seedHandle.close()
  const sessionDir = sessionDirOf(root)
  rmSync(join(sessionDir, `session.v${SESSION_FORMAT_VERSION}.jsonl${CURRENT_SUFFIX}`), { force: true })
  const sourceName = 'session.v1.jsonl.zstd'
  const sourcePath = join(sessionDir, sourceName)
  placeArtifact(sourcePath, fixtureText)
  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  await first.ctx.fiber.dispose()

  const second = await boot(life, root)
  const refusal = await second.persistence.open(id, 'read').then(() => undefined, (error: unknown) => error as Error)
  assert.ok(refusal, 'the refused generation never resolves to an empty Session')
  assert.match(refusal.message, /cannot acquire a system head|surface before first step/u,
    `the refusal carries the official diagnostic: ${refusal.message}`)
  assert.equal(createHash('sha256').update(readFileSync(sourcePath)).digest('hex'), sourceHash,
    'the refused generation is byte-identical after the attempt')
  assert.deepEqual(generationFiles(sessionDir), [sourceName], 'a refused read publishes no successor')
})

/**
 * The OFFICIAL rc.2 released-v1 physical sample: `releasedV1PackedPhysicalLog`
 * from `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts`
 * (`deepseek-ai/deepseek-harness` @ `687f282e8625c6b8d11ff58211a90524be2e4317`,
 * the pinned 0.2.1-rc.2 source). One turn whose FIRST surface sits inside the
 * step (so the v2->v3 edge can insert the canonical system head) and whose
 * assistant stream is carried by a packed `text-chunks` row — the sample the
 * official suite reads as its POSITIVE released-v1 read. Copied shape-for-shape;
 * it is an official-format sample, not a product-recorded Session.
 */
function releasedV1PackedSample(id: string): string {
  const chunk = (seq: number, time: number, value: unknown): unknown =>
    ({ type: 'assistant/chunk', seq, time, data: { turn: 1, step: 1, chunk: value } })
  const rows = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'one-turn-user', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    },
    chunk(3, 3, { type: 'block-start', index: 0, blockType: 'text' }),
    { type: 'text-chunks', seq0: 4, time0: 3, data: { turn: 1, step: 1, index: 0, dt: [0, 0], texts: ['hello', '', ''] } },
    chunk(7, 4, { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }),
    chunk(8, 4, { type: 'finish', reason: { kind: 'stop' } }),
    {
      type: 'assistant/message', seq: 9, time: 4, surfaceOp: 'append',
      sourceEventSeqs: [3, 4, 5, 6, 7, 8],
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'one-turn-assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      },
    },
    { type: 'step/end', seq: 10, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 11, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const header = { type: 'session', version: 1, id, createdAt: 1, cwd: '/work', delegationDepth: 0 }
  return [header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n'
}

test('the installed rc.2 reader positively reads a released-v1 artifact and returns its complete log', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s2b-b1-released-v1-read-')
  const id = SessionId('session-b1-released-v1-read')
  const first = await boot(life, root)
  const seedHandle = await first.persistence.create({
    id,
    createdAt: 1,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  })
  await seedHandle.flush()
  await seedHandle.close()
  const sessionDir = sessionDirOf(root)
  rmSync(join(sessionDir, `session.v${SESSION_FORMAT_VERSION}.jsonl${CURRENT_SUFFIX}`), { force: true })
  const sourceName = 'session.v1.jsonl.zstd'
  const sourcePath = join(sessionDir, sourceName)
  placeArtifact(sourcePath, releasedV1PackedSample(String(id)))
  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  await first.ctx.fiber.dispose()

  const second = await boot(life, root)
  // The historical generation is CLASSIFIED as needing migration: a real
  // released old format is never invisible and never presented as current.
  assert.equal((await second.persistence.stat(id))?.formatStatus, 'migration-required')
  assert.equal(
    (await second.persistence.list()).find(row => String(row.header.id) === String(id))?.formatStatus,
    'migration-required',
  )

  const readHandle = await second.persistence.open(id, 'read')
  const read = await readHandle.read()
  assert.equal(readHandle.header.version, SESSION_FORMAT_VERSION, 'the restored artifact is served as the current format')
  await readHandle.close()
  // The complete historical log, restored through the official v1->v2->v3 chain:
  // the packed stream is expanded into the assistant message, the user message
  // survives verbatim, and the chronology rule inserts the canonical system head.
  assert.deepEqual(
    read.events.map(event => event.type),
    ['turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'step/end', 'turn/end'],
  )
  assert.deepEqual(
    (read.events[3]!.data as { readonly content?: unknown }).content,
    [{ type: 'text', text: 'hi' }],
    'the historical user message survives verbatim',
  )
  const assistant = read.events[4]!.data as {
    readonly message?: { readonly content?: unknown }
    readonly stream?: readonly { readonly type: string; readonly texts?: readonly string[] }[]
  }
  assert.deepEqual(assistant.message?.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(
    assistant.stream?.find(part => part.type === 'text-chunks')?.texts,
    ['hello', '', ''],
    'the packed released-v1 chunk row really decoded',
  )
  // A read open never rewrites the released artifact and publishes no successor.
  assert.equal(createHash('sha256').update(readFileSync(sourcePath)).digest('hex'), sourceHash,
    'the released-v1 artifact is byte-identical after the read')
  assert.deepEqual(generationFiles(sessionDir), [sourceName], 'a read open publishes no successor')
})

test('a newer stored format is refused explicitly, never read as an empty Session', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s2b-b1-newer-')
  const id = SessionId('session-b1-newer-format')
  const first = await boot(life, root)
  const handle = await first.persistence.create({
    id,
    createdAt: 1,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  })
  await handle.flush()
  await handle.close()
  const sessionDir = sessionDirOf(root)
  rmSync(join(sessionDir, `session.v${SESSION_FORMAT_VERSION}.jsonl${CURRENT_SUFFIX}`), { force: true })
  const futureVersion = SESSION_FORMAT_VERSION + 1
  placeArtifact(
    join(sessionDir, `session.v${futureVersion}.jsonl.zstd`),
    `${JSON.stringify({ type: 'session', version: futureVersion, id: String(id), createdAt: 1, cwd: '/work', delegationDepth: 0 })}\n`
      + `${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } })}\n`,
  )
  await first.ctx.fiber.dispose()

  const second = await boot(life, root)
  const refusal = await second.persistence.open(id, 'read').then(
    () => undefined,
    (error: unknown) => error as Error,
  )
  assert.ok(refusal, 'opening a newer stored format must fail, never resolve to an empty Session')
  assert.match(refusal.message, new RegExp(`v${futureVersion}`), `the refusal names the stored version: ${refusal.message}`)
  assert.ok(!readdirSync(sessionDir).includes(`session.v${SESSION_FORMAT_VERSION}.jsonl${CURRENT_SUFFIX}`),
    'a refused open publishes nothing')
})

test('the released-v3 reader refuses every rc.2 vocabulary event (old-reader refusal evidence)', () => {
  // NOT an executed old reader: the OFFICIAL released-v3 restore runs over an
  // artifact whose rows carry rc.2 vocabulary, with the released-v3 reader's
  // own known-type set — the exact admission an old generation's reader owns.
  const header = { version: 3, id: 'released-v3-admission', createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0 }
  for (const type of ['job/registered', 'job/settled', 'working-directory/change']) {
    assert.equal(RELEASED_V3_EVENT_TYPES.has(type), false, `${type} is not part of the released-v3 vocabulary`)
    assert.throws(
      () => restoreReleasedV3Artifact(
        { header, inheritedEventCount: 0, events: [{ type, seq: 0, time: 1, data: {} }] },
        RELEASED_V3_EVENT_TYPES,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /unknown event type/, `the refusal names the vocabulary gap: ${error.message}`)
        return true
      },
      `${type} must be refused by the released-v3 reader`,
    )
  }
  // Positive control: the same restore accepts an artifact without rc.2 rows.
  assert.doesNotThrow(
    () => restoreReleasedV3Artifact({ header, inheritedEventCount: 0, events: [] }, RELEASED_V3_EVENT_TYPES),
  )
})

test('an rc.2 catalog v2 external leaf is carried through and never becomes a browsable child row', () => {
  // The rc.2 vocabulary adds catalog version 2 with `mode: 'external'`: an
  // external provider execution with NO local child Session. The TUI read
  // ports carry the classification, and the ONE task-row projection keeps it
  // out of the browsable rows (there is no external-child viewer to open) —
  // while the SAME shape classified as a local mode stays browsable.
  const external = { kind: 'child' as const, id: 'child-external', label: 'external run', mode: 'external' as const, activity: 'inactive' as const }
  const oneShot = { kind: 'child' as const, id: 'child-one-shot', label: 'one shot', mode: 'one-shot' as const, activity: 'inactive' as const }
  const continuable = { kind: 'child' as const, id: 'child-continuable', label: 'continuable', mode: 'continuable' as const, activity: 'running' as const }
  const rows = buildTaskRows([], [external, oneShot, continuable])
  assert.deepEqual(
    rows.map(row => row.kind === 'job' ? row.jobId : row.childId),
    ['child-external', 'child-one-shot', 'child-continuable'],
    'the external leaf is carried in catalog order, never dropped',
  )
  assert.deepEqual(
    rows.map(row => row.kind === 'external' ? row.mode : row.kind === 'subagent' ? row.mode : undefined),
    ['external', 'one-shot', 'continuable'],
    'its durable classification stays `external` (never defaulted to a local mode)',
  )
  assert.equal(rows[0]?.kind, 'external')
})
