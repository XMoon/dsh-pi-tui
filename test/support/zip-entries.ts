/**
 * A minimal test-only ZIP reader: End-of-Central-Directory + central directory
 * + local headers, with DEFLATE entries inflated through `node:zlib`.
 *
 * It exists so archive contract tests can assert what the upstream session-log
 * export actually produced instead of trusting a byte count. The upstream
 * package owns the exhaustive ZIP-format tests; this reader only has to handle
 * the archives that package writes.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/zip-entries
 */

import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'

/** Read every entry of a ZIP archive, keyed by its stored name. */
export function unzipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
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
    // The upstream session-log exporter deflates every entry. Anything else is
    // an archive this reader cannot interpret, and treating it as DEFLATE would
    // inflate garbage into a confusing assertion failure further downstream.
    assert.ok(method === 0 || method === 8,
      `unsupported ZIP compression method ${method} for entry "${name}"`)
    entries.set(name, method === 0 ? data : inflateRawSync(data))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
