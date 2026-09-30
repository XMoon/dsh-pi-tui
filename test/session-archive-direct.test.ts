/**
 * Direct session-archive adapter contract tests (Pre-Stage-D export
 * convergence): the adapter delegates to the public DSH Host archive
 * primitives — missing required services → unavailable, missing root → none,
 * pre-aborted signal → cancellation, live root → flush before read, ready →
 * upstream filename + full-tree ZIP, real failures → reject (never
 * collapsed to none), and one integration path proving the produced ZIP
 * contains the root log, a descendant log and a generic-file attachment.
 * The upstream package owns its exhaustive ZIP-format tests; this suite pins
 * the TUI adapter contract only.
 * @module @xmoon76/dsh-pi-tui/session-archive-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'
import { DirectSessionArchive } from '../src/runtime/direct/session-archive-direct.ts'
import { unzipEntries } from './support/zip-entries.ts'

/** One stored logical session log served by the fake persistence backend. */
interface StoredLog {
  readonly header: {
    version: 4
    id: ReturnType<typeof SessionId>
    createdAt: number
    isSeeded: boolean
    cwd: string
    parentSession?: ReturnType<typeof SessionId>
    delegationDepth: number
  }
  readonly events: readonly unknown[]
}

function header(id: string, parentSession?: string): StoredLog['header'] {
  return {
    version: 4,
    id: SessionId(id),
    createdAt: 1000,
    isSeeded: false,
    cwd: '/proj',
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
    delegationDepth: parentSession === undefined ? 0 : 1,
  }
}

function storedLog(id: string, parentSession?: string, events: readonly unknown[] = []): StoredLog {
  return { header: header(id, parentSession), events }
}

/** A read handle over one stored log; only what readSessionLogText touches. */
function readHandle(stored: StoredLog) {
  return {
    id: stored.header.id,
    header: stored.header,
    access: 'read',
    inheritedEventCount: 0,
    read: async () => {
      const events = structuredClone(stored.events)
      // The upstream read contract differs across DSH distributions: some
      // lines destructure `{ events }` from the detached read result, while
      // others consume the events array directly. Return a shape satisfying
      // BOTH (an array
      // that also carries the detached `events` property), so the adapter
      // contract test is distribution-agnostic.
      return Object.assign(events, { eventState: 'detached', events })
    },
    close: async () => {},
  }
}

/** A user/message event carrying one generic-file reference. */
function fileEvent(id: string, name = 'notes.txt'): unknown {
  return {
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: { content: [{ type: 'file', attachment: { attachmentId: id, name, bytes: 5 } }] },
  }
}

/** A fake host context answering the export deps. */
function host(services: Record<string, unknown>): { get: (name: string) => unknown } {
  return { get: (name) => services[name] }
}

/** The fake persistence backend over stored logs. */
function persistence(logs: Record<string, StoredLog>, openImpl?: (id: string) => Promise<unknown>) {
  return {
    open: openImpl ?? (async (id: string) => {
      const stored = logs[String(id)]
      if (stored === undefined) throw new SessionPersistenceNotFoundError(SessionId(String(id)))
      return readHandle(stored)
    }),
  }
}

/** The fake attachment store: one generic file stream per ref. */
function attachments(files: Record<string, Uint8Array> = {}) {
  return {
    readImage: async () => { throw new Error('fixture has no images') },
    readFileStream: async function* (ref: { attachmentId: unknown; name: string }) {
      const data = files[String(ref.attachmentId)]
      if (data === undefined) throw new Error(`fixture has no file ${String(ref.attachmentId)}`)
      yield data
    },
  }
}

/** The fake session-query engine with one lineage tree. */
function sessionQuery(descendants: unknown[] = []) {
  return {
    traceSession: async () => ({
      target: { header: header('session-root'), live: false, persisted: true },
      ancestors: [],
      complete: true,
      root: { header: header('session-root'), live: false, persisted: true },
      descendants,
    }),
  }
}


/** Consume one archive stream into its unpacked entries. */
async function archiveEntries(stream: ReadableStream<Uint8Array>): Promise<Map<string, Uint8Array>> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return unzipEntries(bytes)
}

test('missing required services is unavailable', async () => {
  const archive = new DirectSessionArchive(host({}))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'unavailable')
})

test('missing session-query alone is unavailable', async () => {
  const archive = new DirectSessionArchive(host({
    sessionPersistence: persistence({ 'session-root': storedLog('session-root') }),
    attachments: attachments(),
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'unavailable')
})

test('missing root session is none', async () => {
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({}),
    attachments: attachments(),
  }))
  const result = await archive.open('session-gone')
  assert.equal(result.kind, 'none')
})

test('a pre-aborted signal rejects with the abort shape', async () => {
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': storedLog('session-root') }),
    attachments: attachments(),
  }))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(archive.open('session-root', controller.signal), error => {
    return error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR')
  })
})

test('a live root session is flushed before the root read', async () => {
  const calls: string[] = []
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': storedLog('session-root') }),
    attachments: attachments(),
    sessions: {
      get: (id: unknown) => String(id) === 'session-root' ? { id } : undefined,
      flush: async () => { calls.push('flush'); return true },
    },
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  assert.deepEqual(calls, ['flush'], 'the live root must be flushed before the read')
})

test('ready carries the upstream archive filename', async () => {
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': storedLog('session-root') }),
    attachments: attachments(),
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  assert.equal(result.artifact.filename, sessionLogZipFilename('session-root'))
  assert.equal(result.artifact.filename, 'dsh-session-session-root.zip')
})

test('a real root read failure rejects (never none)', async () => {
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({}, async () => { throw new Error('/host/private/session.jsonl') }),
    attachments: attachments(),
  }))
  await assert.rejects(archive.open('session-root'), /host\/private/)
})

test('a mid-stream failure rejects the stream (never converted to none)', async () => {
  // The root exists, but the descendant's stored log is missing: the archive
  // opens ready and the STREAM fails while producing the descendant entry.
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery([{ session: { header: header('session-child', 'session-root'), live: false, persisted: true }, descendants: [] }]),
    sessionPersistence: persistence({ 'session-root': storedLog('session-root') }),
    attachments: attachments(),
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  await assert.rejects(archiveEntries(result.artifact.stream), /has no stored log/)
})

test('integration: the produced ZIP contains the root log, a descendant log and a generic file', async () => {
  const root = storedLog('session-root', undefined, [fileEvent('file-1', 'notes.txt')])
  const child = storedLog('session-child', 'session-root')
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery([{ session: { header: header('session-child', 'session-root'), live: false, persisted: true }, descendants: [] }]),
    sessionPersistence: persistence({ 'session-root': root, 'session-child': child }),
    attachments: attachments({ 'file-1': new Uint8Array([1, 2, 3, 4, 5]) }),
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  const entries = await archiveEntries(result.artifact.stream)
  // Root log under the canonical session filename.
  const rootEntry = entries.get('session.v4.jsonl')
  assert.ok(rootEntry !== undefined, 'root log entry present')
  assert.ok(new TextDecoder().decode(rootEntry).includes('session-root'), 'root log names the root session')
  // Descendant log under subagents/<id>/.
  const childEntry = entries.get('subagents/session-child/session.v4.jsonl')
  assert.ok(childEntry !== undefined, 'descendant log entry present (descendants=true)')
  assert.ok(new TextDecoder().decode(childEntry).includes('session-child'), 'descendant log names the child')
  // Generic file under files/<prefix>/<digest>/<name>.
  const fileEntry = entries.get('files/fi/file-1/notes.txt')
  assert.ok(fileEntry !== undefined, 'generic file entry present')
  assert.deepEqual([...fileEntry], [1, 2, 3, 4, 5], 'generic file bytes are exact')
})
