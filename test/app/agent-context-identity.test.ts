/**
 * The Agent Context identity enrichment (`app/surface/agent-context-identity.ts`).
 *
 * These cases pin the owner's read ladder and its currentness fences: the
 * synchronous official-title read, the catalog-label fallback, the ONE
 * list + projection-batch demand round for cold senders, the subject/source
 * reset that drops every name of the previous target, the stale async
 * completion that must not publish, and the truthful fallback on failure
 * (never a fabricated empty title and never a retry poll).
 *
 * The real Surface/Task/TuiApp composition (the painted frame) is covered by
 * `agent-context-identity-integration.test.ts`; this file owns the internal
 * lifecycle contracts.
 * @module @xmoon76/dsh-pi-tui/app/agent-context-identity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgentContextIdentity,
  type AgentContextIdentity,
  type AgentContextIdentitySubject,
} from '../../src/app/surface/agent-context-identity.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { SessionContentSearchPage, SessionReader, SessionStatusProjection, SessionSummary } from '../../src/runtime/session-reader-port.ts'

const MAIN: AgentContextIdentitySubject = { subjectKind: 'main', subjectId: 'session-main', sourceIdentity: {} }
const VIEWED: AgentContextIdentitySubject = { subjectKind: 'viewed-child', subjectId: 'session-child', sourceIdentity: {} }

/** One relay row exactly as the fold materializes it (presentation-only
 * `contextPresentation` included). */
function relayRow(senderSessionId: string, text = `Agent ${senderSessionId} sent a message: done`): TranscriptMessage {
  return {
    kind: 'system',
    turn: 0,
    text,
    label: 'agent-message',
    icon: 'context-generic',
    context: true,
    contextPresentation: { sourceKind: 'agent-message', form: 'relay', senderSessionId, role: 'inject' },
  }
}

/** The controllable semantic SessionReader: only the three capabilities this
 * owner consumes are real; every other port member answers the truthful
 * "unavailable". */
class FakeSessionReader implements SessionReader {
  readonly statusTitles = new Map<string, string>()
  readonly listed: SessionSummary[] = []
  readonly batchTitles = new Map<string, string>()
  readonly listCalls: Array<string | undefined> = []
  readonly batchCalls: Array<readonly string[]> = []
  holdBatch: Promise<void> | undefined
  listFailure: Error | undefined
  listUnavailable = false

  sessionStatus(sessionId: string): SessionStatusProjection | undefined {
    const title = this.statusTitles.get(sessionId)
    return title === undefined ? undefined : { sessionId, title }
  }

  async list(currentSessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary[] | undefined> {
    this.listCalls.push(currentSessionId)
    signal?.throwIfAborted()
    if (this.listUnavailable) return undefined
    if (this.listFailure !== undefined) throw this.listFailure
    return [...this.listed]
  }

  async projectionBatch(rows: readonly SessionSummary[], signal?: AbortSignal): Promise<Map<string, { title?: string }>> {
    this.batchCalls.push(rows.map(row => row.id))
    if (this.holdBatch !== undefined) await this.holdBatch
    signal?.throwIfAborted()
    const result = new Map<string, { title?: string }>()
    for (const row of rows) {
      const title = this.batchTitles.get(row.id)
      if (title !== undefined) result.set(row.id, { title })
    }
    return result
  }

  async search(): Promise<SessionContentSearchPage | undefined> {
    return undefined
  }

  blank(): boolean | undefined {
    return undefined
  }

  measureContext(): number | undefined {
    return undefined
  }

  turnOutline(): [] {
    return []
  }
}

function summary(id: string): SessionSummary {
  return { id, updatedAt: 1, cwd: '/workspace', live: false }
}

interface Harness {
  readonly reader: FakeSessionReader
  identity: AgentContextIdentity
  readonly published: Array<ReadonlyMap<string, string>>;
  readonly catalog: Map<string, string>
  /** The recorded diagnostics lines (the never-swallowed failure channel). */
  readonly diagnostics: string[]
  current: boolean
  /** The names of the most recent publication. */
  labels(): ReadonlyMap<string, string>
}

function harness(): Harness {
  const reader = new FakeSessionReader()
  const catalog = new Map<string, string>()
  const published: Array<ReadonlyMap<string, string>> = []
  const diagnostics: string[] = []
  const harness: Harness = {
    reader,
    catalog,
    published,
    diagnostics,
    current: true,
    identity: undefined as never,
    labels: () => published[published.length - 1] ?? new Map(),
  }
  harness.identity = createAgentContextIdentity({
    reader,
    catalogChildLabel: childId => catalog.get(childId),
    publish: labels => { published.push(labels) },
    isCurrentSubject: () => harness.current,
    diag: createDiag({
      filePath: undefined,
      stderrLevel: 'off',
      sinks: [{ write: line => { diagnostics.push(line) } }],
    }),
    sessionId: () => 'session-main',
    isCleanedUp: () => false,
  })
  return harness
}

/** Drain the owned task continuation turns after an explicitly released read.
 * The fake's promises are already resolved or explicitly released, so this is
 * a deterministic task drain for the publication microtasks, not a time window. */
async function drainIdentity(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('the already-materialized official title wins over the catalog label', () => {
  const h = harness()
  h.reader.statusTitles.set('session-child-1', '可复用性审核员')
  h.catalog.set('session-child-1', 'Catalog Reviewer')
  h.identity.observe([relayRow('session-child-1')], MAIN)
  assert.equal(h.labels().get('session-child-1'), '可复用性审核员')
  assert.deepEqual(h.reader.listCalls, [], 'a proven title needs no list read')
})

test('a later official title update replaces the title already on screen', () => {
  const h = harness()
  h.reader.statusTitles.set('session-child-update', '第一次标题')
  h.identity.observe([relayRow('session-child-update')], MAIN)
  assert.equal(h.labels().get('session-child-update'), '第一次标题')
  // The same live subject repaints after the official projection changed.
  h.reader.statusTitles.set('session-child-update', '第二次标题')
  h.identity.observe([relayRow('session-child-update')], MAIN)
  assert.equal(h.labels().get('session-child-update'), '第二次标题',
    'the cached title never suppresses the current materialized projection')
  assert.ok(h.published.length >= 2, 'the replacement was actually republished')
})

test('an async fallback title yields to a later official title update', async () => {
  const h = harness()
  h.reader.listed.push(summary('session-child-async-update'))
  h.reader.batchTitles.set('session-child-async-update', '异步标题')
  h.identity.observe([relayRow('session-child-async-update')], MAIN)
  await drainIdentity()
  assert.equal(h.labels().get('session-child-async-update'), '异步标题', 'the batch fallback is shown first')
  h.reader.statusTitles.set('session-child-async-update', '正式标题')
  h.identity.observe([relayRow('session-child-async-update')], MAIN)
  assert.equal(h.labels().get('session-child-async-update'), '正式标题',
    'the materialized official projection replaces the older async fallback')
})

test('an absent status title is UNKNOWN and never clears a proven title', () => {
  const h = harness()
  h.reader.statusTitles.set('session-child-unknown', '已知标题')
  h.identity.observe([relayRow('session-child-unknown')], MAIN)
  assert.equal(h.labels().get('session-child-unknown'), '已知标题')
  h.reader.statusTitles.delete('session-child-unknown')
  h.identity.observe([relayRow('session-child-unknown')], MAIN)
  assert.equal(h.labels().get('session-child-unknown'), '已知标题',
    'absence conflates no-title and failed-read; it is not a confirmed removal')
})

test('the catalog label shows immediately and one projection batch resolves the title', async () => {
  const h = harness()
  h.catalog.set('session-child-2', 'Catalog Reviewer')
  h.reader.listed.push(summary('session-unrelated'), summary('session-child-2'))
  h.reader.batchTitles.set('session-child-2', '官方标题')
  h.identity.observe([relayRow('session-child-2')], MAIN)
  assert.equal(h.labels().get('session-child-2'), 'Catalog Reviewer', 'the synchronous frame shows the catalog label')
  await drainIdentity()
  assert.deepEqual(h.reader.listCalls, ['session-main'], 'ONE list per demand round')
  assert.deepEqual(h.reader.batchCalls, [['session-child-2']], 'only the already-listed matching row is projected')
  assert.equal(h.labels().get('session-child-2'), '官方标题', 'the official title then wins')
})

test('a cold cache miss stays unknown and is never retried by another frame', async () => {
  const h = harness()
  h.reader.listed.push(summary('session-unrelated'))
  h.identity.observe([relayRow('session-child-3')], MAIN)
  await drainIdentity()
  assert.deepEqual(h.reader.batchCalls, [], 'no matching listed row means no projection batch')
  assert.equal(h.labels().has('session-child-3'), false, 'unknown is not published as a confirmed empty title')
  h.identity.observe([relayRow('session-child-3')], MAIN)
  await drainIdentity()
  assert.deepEqual(h.reader.listCalls, ['session-main'], 'a repeated frame reuses the demand round instead of polling')
})

test('a new sender appearing while a batch is in flight gets its own demand round', async () => {
  const h = harness()
  h.reader.listed.push(summary('session-child-4'), summary('session-child-5'))
  h.reader.batchTitles.set('session-child-4', '四号审核员')
  h.reader.batchTitles.set('session-child-5', '五号审核员')
  let release: () => void = () => {}
  h.reader.holdBatch = new Promise<void>(resolve => { release = resolve })
  h.identity.observe([relayRow('session-child-4')], MAIN)
  h.identity.observe([relayRow('session-child-4'), relayRow('session-child-5')], MAIN)
  assert.equal(h.reader.listCalls.length, 1, 'the in-flight batch is reused for the frame')
  release()
  await drainIdentity()
  assert.equal(h.labels().get('session-child-4'), '四号审核员')
  assert.equal(h.labels().get('session-child-5'), '五号审核员', 'the later sender was demanded after the first batch settled')
  assert.deepEqual(h.reader.batchCalls, [[ 'session-child-4' ], ['session-child-5']])
})

test('a subject switch aborts the pending batch and drops every old name', async () => {
  const h = harness()
  h.reader.statusTitles.set('session-child-6', '主会话审核员')
  h.reader.listed.push(summary('session-child-6'), summary('session-child-7'))
  h.reader.batchTitles.set('session-child-6', '过期标题')
  h.reader.batchTitles.set('session-child-7', '子视图审核员')
  let release: () => void = () => {}
  h.reader.holdBatch = new Promise<void>(resolve => { release = resolve })
  h.identity.observe([relayRow('session-child-6')], MAIN)
  assert.equal(h.labels().get('session-child-6'), '主会话审核员')
  // Enter the child viewer: a DIFFERENT subject (and source identity).
  h.identity.observe([relayRow('session-child-7')], VIEWED)
  release()
  await drainIdentity()
  assert.equal(h.labels().get('session-child-6'), undefined, 'the old subject name was cleared')
  assert.equal(h.labels().get('session-child-7'), '子视图审核员')
  assert.ok(h.published.some(labels => labels.size === 0), 'the subject switch published the cleared map')
})

test('a same-id folder replacement (new source identity) is a different subject', () => {
  const h = harness()
  h.reader.statusTitles.set('session-child-8', '第一次标题')
  h.identity.observe([relayRow('session-child-8')], MAIN)
  assert.equal(h.labels().get('session-child-8'), '第一次标题')
  h.reader.statusTitles.delete('session-child-8')
  const replaced: AgentContextIdentitySubject = { ...MAIN, sourceIdentity: {} }
  h.identity.observe([relayRow('session-child-8')], replaced)
  assert.equal(h.labels().has('session-child-8'), false, 'the replaced folder does not inherit the old title')
})

test('an async completion for a no-longer-current subject is discarded', async () => {
  const h = harness()
  h.reader.listed.push(summary('session-child-9'))
  h.reader.batchTitles.set('session-child-9', '晚到的标题')
  let release: () => void = () => {}
  h.reader.holdBatch = new Promise<void>(resolve => { release = resolve })
  h.identity.observe([relayRow('session-child-9')], MAIN)
  h.current = false
  release()
  await drainIdentity()
  assert.equal(h.labels().has('session-child-9'), false, 'a stale batch cannot relabel the live subject')
})

test('a catalog commit re-resolves the SAME frame without another Session read', async () => {
  const h = harness()
  h.reader.listed.push(summary('session-unrelated'))
  h.identity.observe([relayRow('session-child-10')], MAIN)
  await drainIdentity()
  assert.equal(h.labels().has('session-child-10'), false)
  h.catalog.set('session-child-10', 'Catalog Later')
  h.identity.catalogChanged()
  assert.equal(h.labels().get('session-child-10'), 'Catalog Later')
  assert.deepEqual(h.reader.listCalls, ['session-main'], 'the catalog commit triggers no list read')
})

test('a failed list records the failure, keeps the fallback and is not retried', async () => {
  const h = harness()
  h.catalog.set('session-child-11', 'Catalog Reviewer')
  h.reader.listed.push(summary('session-child-11'))
  h.reader.listFailure = new Error('session list unavailable')
  h.identity.observe([relayRow('session-child-11')], MAIN)
  await drainIdentity()
  assert.equal(h.labels().get('session-child-11'), 'Catalog Reviewer', 'the truthful fallback survives the failure')
  assert.ok(h.diagnostics.some(line => line.includes('session list unavailable')), 'the failure reached the diagnostics channel')
  h.identity.observe([relayRow('session-child-11')], MAIN)
  await drainIdentity()
  assert.deepEqual(h.reader.listCalls, ['session-main'], 'a failure is not turned into a polling retry')
})

test('dispose cancels the pending batch and publishes nothing afterwards', async () => {
  const h = harness()
  h.reader.listed.push(summary('session-child-12'))
  h.reader.batchTitles.set('session-child-12', '晚到的标题')
  let release: () => void = () => {}
  h.reader.holdBatch = new Promise<void>(resolve => { release = resolve })
  h.identity.observe([relayRow('session-child-12')], MAIN)
  const publishedBefore = h.published.length
  h.identity.dispose()
  release()
  await drainIdentity()
  assert.equal(h.published.length, publishedBefore, 'no publication after dispose')
  assert.equal(h.labels().has('session-child-12'), false)
})
