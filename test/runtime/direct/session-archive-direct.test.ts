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
import { DirectSessionArchive } from '../../../src/runtime/direct/session-archive-direct.ts'
import { unzipEntries } from '../../support/zip-entries.ts'

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

/** A user/message event carrying one image reference. */
function imageEvent(id: string, mediaType = 'image/png'): unknown {
  return {
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: { content: [{ type: 'image', attachment: { attachmentId: id, mediaType } }] },
  }
}

/** An Error carrying the upstream attachment machine code. */
function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
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

// ── rc.3 missing-attachment semantics (upstream sessionLogZipEntries) ──────
// The TUI adapter adds NO error handling here: the upstream ZIP producer calls
// readFileStream/readImage, ignores exactly `ATTACHMENT_NOT_FOUND` /
// `INVALID_ATTACHMENT_REF` into one `attachments-missing.txt`, and rethrows
// every other failure. These cases prove that behavior reaches the adapter
// contract without the TUI decoding attachments or rewriting the archive.

test('the archive keeps readable attachments and reports unreadable references in one missing manifest', async () => {
  const okBytes = new Uint8Array([9, 8, 7, 6])
  const root = storedLog('session-root', undefined, [
    fileEvent('file-ok', 'ok.txt'),
    fileEvent('file-gone', 'gone.txt'),
  ])
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': root }),
    attachments: {
      readImage: async () => { throw new Error('fixture has no images') },
      readFileStream: async function* (ref: { attachmentId: unknown; name: string }) {
        if (String(ref.attachmentId) === 'file-gone') {
          // Thrown BEFORE the first iterator.next(): the missing reference is
          // discovered while the ZIP is still being produced, not mid-file.
          throw codedError('attachment file-gone is not stored', 'ATTACHMENT_NOT_FOUND')
        }
        yield okBytes
      },
    },
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  const entries = await archiveEntries(result.artifact.stream)
  assert.ok(entries.get('session.v4.jsonl') !== undefined, 'the root log is still exported')
  const okEntry = entries.get('files/fi/file-ok/ok.txt')
  assert.ok(okEntry !== undefined, 'the readable attachment is exported')
  assert.deepEqual([...okEntry!], [...okBytes], 'the readable attachment bytes are exact')
  assert.equal(entries.get('files/fi/file-gone/gone.txt'), undefined,
    'the unreadable reference contributes no file entry')
  const manifest = entries.get('attachments-missing.txt')
  assert.ok(manifest !== undefined, 'the missing-attachment manifest is present')
  const manifestText = new TextDecoder().decode(manifest)
  const manifestLines = manifestText.split('\n').filter(line => line !== '')
  assert.equal(manifestLines.length, 1, 'exactly ONE missing reference is recorded')
  assert.match(manifestText, /files\/fi\/file-gone\/gone\.txt\t/mu,
    'the manifest names the failed reference relative path')
  assert.match(manifestText, /attachment file-gone is not stored/u,
    'the manifest keeps the upstream error text')
})

test('an archive with every attachment readable omits the missing manifest', async () => {
  const root = storedLog('session-root', undefined, [fileEvent('file-1', 'a.txt')])
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': root }),
    attachments: attachments({ 'file-1': new Uint8Array([1, 2, 3]) }),
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  const entries = await archiveEntries(result.artifact.stream)
  assert.ok(entries.get('files/fi/file-1/a.txt') !== undefined, 'the attachment is exported')
  assert.equal(entries.get('attachments-missing.txt'), undefined,
    'no manifest when every attachment is readable')
})

test('an INVALID_ATTACHMENT_REF file and an unreadable image both join the missing manifest', async () => {
  const root = storedLog('session-root', undefined, [
    fileEvent('file-bad', 'bad.txt'),
    imageEvent('img-gone', 'image/png'),
  ])
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': root }),
    attachments: {
      readImage: async () => { throw codedError('image img-gone was deleted', 'ATTACHMENT_NOT_FOUND') },
      readFileStream: async function* () { throw codedError('the reference is malformed', 'INVALID_ATTACHMENT_REF') },
    },
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  const entries = await archiveEntries(result.artifact.stream)
  const manifest = entries.get('attachments-missing.txt')
  assert.ok(manifest !== undefined, 'both unreadable references share ONE manifest')
  const manifestText = new TextDecoder().decode(manifest)
  assert.equal(manifestText.split('\n').filter(line => line !== '').length, 2,
    'each unreadable reference is one line')
  assert.match(manifestText, /files\/fi\/file-bad\/bad\.txt/u, 'the invalid file reference path is listed')
  assert.match(manifestText, /the reference is malformed/u)
  assert.match(manifestText, /media\/img-gone\.png/u, 'the unreadable image path is listed')
  assert.match(manifestText, /image img-gone was deleted/u)
})

test('a readable image attachment is exported under media/ and needs no manifest', async () => {
  const imgBytes = new Uint8Array([4, 5, 6])
  const root = storedLog('session-root', undefined, [imageEvent('img-ok', 'image/png')])
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': root }),
    attachments: {
      readImage: async () => ({ data: imgBytes }),
      readFileStream: async function* () { throw new Error('fixture has no files') },
    },
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  const entries = await archiveEntries(result.artifact.stream)
  const mediaEntry = entries.get('media/img-ok.png')
  assert.ok(mediaEntry !== undefined, 'the readable image is content-addressed under media/')
  assert.deepEqual([...mediaEntry!], [...imgBytes], 'the image bytes are exact')
  assert.equal(entries.get('attachments-missing.txt'), undefined, 'a readable image needs no manifest')
})

test('a non-whitelisted attachment error fails the stream instead of producing a manifest ZIP', async () => {
  const root = storedLog('session-root', undefined, [fileEvent('file-denied', 'denied.txt')])
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': root }),
    attachments: {
      readImage: async () => { throw new Error('no images') },
      readFileStream: async function* () { throw codedError('EACCES: permission denied', 'EACCES') },
    },
  }))
  const result = await archive.open('session-root')
  // The missing-root / missing-service paths answer before streaming; a real
  // attachment I/O failure is discovered only while the stream is consumed.
  assert.equal(result.kind, 'ready', 'a real attachment I/O failure is not `none`/`unavailable`')
  if (result.kind !== 'ready') return
  // The whole stream MUST reject: never a successful-looking manifest ZIP.
  await assert.rejects(archiveEntries(result.artifact.stream), /EACCES/u)
})

test('an unreadable file reference releases its stream iterator through return()', async () => {
  let returned = false
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => { throw codedError('gone', 'ATTACHMENT_NOT_FOUND') },
        return: async (): Promise<IteratorResult<Uint8Array>> => {
          returned = true
          return { done: true, value: undefined }
        },
      }
    },
  }
  const root = storedLog('session-root', undefined, [fileEvent('file-gone', 'gone.txt')])
  const archive = new DirectSessionArchive(host({
    sessionQuery: sessionQuery(),
    sessionPersistence: persistence({ 'session-root': root }),
    attachments: {
      readImage: async () => { throw new Error('no images') },
      readFileStream: () => stream,
    },
  }))
  const result = await archive.open('session-root')
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  const entries = await archiveEntries(result.artifact.stream)
  assert.equal(returned, true, 'the abandoned stream iterator is released via return()')
  assert.ok(entries.get('attachments-missing.txt') !== undefined, 'the unreadable reference is still reported')
})
