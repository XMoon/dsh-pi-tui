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
import { inflateRawSync } from 'node:zlib'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'
import { DirectSessionArchive } from '../src/runtime/direct/session-archive-direct.ts'

/** One stored logical session log served by the fake persistence backend. */
interface StoredLog {
  readonly header: {
    version: 2
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
    version: 2,
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
      // The upstream read contract differs across DSH distributions: the npm
      // 0.1.3-alpha.2 line destructures `{ events }` from the detached read
      // result, while the pinned source line (0.1.3-alpha.1) consumes the
      // events array directly. Return a shape satisfying BOTH (an array
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

/** A minimal ZIP reader (test-only): End-of-Central-Directory + central
 * directory + local headers, DEFLATE entries inflated with node:zlib. */
function unzipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Locate the End of Central Directory record (scan the last 64 KiB + 22).
  let eocd = -1
  const scanStart = Math.max(0, bytes.length - 0xffff - 22)
  for (let i = bytes.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  assert.ok(eocd >= 0, 'EOCD record found')
  const entryCount = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  const entries = new Map<string, Uint8Array>()
  let cursor = cdOffset
  for (let index = 0; index < entryCount; index++) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, 'central directory signature')
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    // Local header: signature + fixed fields + name + extra.
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, 'local header signature')
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, method === 0 ? data : inflateRawSync(data))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
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
  const rootEntry = entries.get('session.v2.jsonl')
  assert.ok(rootEntry !== undefined, 'root log entry present')
  assert.ok(new TextDecoder().decode(rootEntry).includes('session-root'), 'root log names the root session')
  // Descendant log under subagents/<id>/.
  const childEntry = entries.get('subagents/session-child/session.v2.jsonl')
  assert.ok(childEntry !== undefined, 'descendant log entry present (descendants=true)')
  assert.ok(new TextDecoder().decode(childEntry).includes('session-child'), 'descendant log names the child')
  // Generic file under files/<prefix>/<digest>/<name>.
  const fileEntry = entries.get('files/fi/file-1/notes.txt')
  assert.ok(fileEntry !== undefined, 'generic file entry present')
  assert.deepEqual([...fileEntry], [1, 2, 3, 4, 5], 'generic file bytes are exact')
})
