/**
 * Delivered files PR2 / M10: the Direct delivered-file read adapter over the
 * REAL official Host file service (no fake interface).
 *
 * ```text
 * DeliveredFileReadPort.stat/read -> scope (live header ?? persisted ?? sandbox root)
 *                                 -> official ctx.workspaceFiles (real bytes)
 * ```
 * @module @xmoon76/dsh-pi-tui/runtime/direct/deliverables-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DeliveredFileReadError,
  deliveredFileReadErrorFrom,
} from '../../../src/runtime/deliverables-port.ts'
import { DirectDeliveredFileReadPort } from '../../../src/runtime/direct/deliverables-direct.ts'
import { createRemoteApplicationHostFixture } from '../../support/remote-application-fixture.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

const abort = new AbortController().signal

test('the Direct adapter answers real Host metadata, pages and refusals', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'pr2-direct-preset')
  const workspace = life.tempDir('dsh-pr2-direct-ws-')
  const docsDir = join(workspace, 'docs')
  mkdirSync(docsDir, { recursive: true })
  const content = 'alpha\nbeta\ngamma\n'
  const filePath = join(docsDir, 'report.md')
  writeFileSync(filePath, content)
  writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]))
  const sessionId = SessionId('pr2-direct-session')
  await host.harness.create(sessionId, undefined, { cwd: workspace })
  const port = new DirectDeliveredFileReadPort(host.ctx)

  const stat = await port.stat(sessionId, filePath, abort)
  assert.equal(typeof stat.version, 'string')
  assert.equal(stat.bytes, Buffer.byteLength(content))

  const page = await port.read(sessionId, filePath, 1, abort)
  assert.deepEqual(
    { offset: page.offset, limit: page.limit, lines: page.lines, eof: page.eof, text: page.text },
    { offset: 1, limit: 120, lines: 3, eof: true, text: 'alpha\nbeta\ngamma' },
  )
  assert.equal(page.stat.version, stat.version)

  // A file LONGER than one page: the port's fixed 120-line bound and the Host's
  // own line accounting decide the page, never a caller-supplied limit.
  const longPath = join(docsDir, 'long.txt')
  const longLines = Array.from({ length: 130 }, (_, index) => `l${index + 1}`)
  writeFileSync(longPath, longLines.join('\n'))
  const firstPage = await port.read(sessionId, longPath, 1, abort)
  assert.deepEqual(
    { offset: firstPage.offset, limit: firstPage.limit, lines: firstPage.lines, eof: firstPage.eof },
    { offset: 1, limit: 120, lines: 120, eof: false },
  )
  assert.equal(firstPage.text.split('\n').at(-1), 'l120')
  const secondPage = await port.read(sessionId, longPath, 121, abort)
  assert.deepEqual(
    { offset: secondPage.offset, limit: secondPage.limit, lines: secondPage.lines, eof: secondPage.eof },
    { offset: 121, limit: 120, lines: 10, eof: true },
  )
  assert.equal(secondPage.text.split('\n')[0], 'l121')

  // The path resolves RELATIVE to the Session's header cwd (never the Client cwd).
  const relative = await port.read(sessionId, 'docs/report.md', 1, abort)
  assert.equal(relative.text, 'alpha\nbeta\ngamma')

  await assertRejectionCode(port.stat(sessionId, join(workspace, 'missing.md'), abort), 'not-found')
  await assertRejectionCode(port.read(sessionId, join(workspace, 'binary.bin'), 1, abort), 'not-text')
  await assertRejectionCode(port.stat(sessionId, docsDir, abort), 'not-regular-file')
  await assertRejectionCode(port.stat('unknown-session', filePath, abort), 'session-unavailable')
  // The Session resolves, but the Host service is not mounted: a definite
  // "unavailable", never a Direct filesystem fallback.
  const withoutService = { get: (name: string) => name === 'workspaceFiles' ? undefined : host.ctx.get(name) }
  await assertRejectionCode(
    new DirectDeliveredFileReadPort(withoutService).stat(sessionId, filePath, abort),
    'service-unavailable',
  )
})

test('the failure mapper keeps known refusals and rethrows unknown ones', () => {
  const mapped = deliveredFileReadErrorFrom(Object.assign(new Error('nope'), { code: 'workspace-file/too-large' }))
  assert.ok(mapped instanceof DeliveredFileReadError)
  assert.equal(mapped.code, 'too-large')
  assert.ok(mapped.cause instanceof Error, 'the official failure stays attached as the cause')

  const unknown = Object.assign(new Error('weird'), { code: 'workspace-file/not-directory' })
  assert.equal(deliveredFileReadErrorFrom(unknown), unknown, 'an unrecognized code is never invented into a state')
  const shapeless = new Error('boom')
  assert.equal(deliveredFileReadErrorFrom(shapeless), shapeless)
})

async function assertRejectionCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeliveredFileReadError, `expected a definite refusal, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('the Direct adapter serves the COLD persisted header, an absolute path outside the workspace, and real refusals', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'pr2-direct-cold-preset')
  const workspace = life.tempDir('dsh-pr2-cold-ws-')
  mkdirSync(workspace, { recursive: true })
  const outsideDir = life.tempDir('dsh-pr2-cold-outside-')
  mkdirSync(outsideDir, { recursive: true })
  const insidePath = join(workspace, 'cold.md')
  const outsidePath = join(outsideDir, 'outside.md')
  writeFileSync(insidePath, 'cold-bytes\n')
  writeFileSync(outsidePath, 'outside-bytes\n')
  const sessionId = SessionId('pr2-direct-cold')
  await host.harness.create(sessionId, undefined, { cwd: workspace })
  const port = new DirectDeliveredFileReadPort(host.ctx)

  // T17 / F03: an ABSOLUTE path the official Host FS can read but that lives
  // OUTSIDE the Session workspace must still be served (upstream authority, not
  // a Client workspace containment check).
  const outside = await port.read(sessionId, outsidePath, 1, abort)
  assert.equal(outside.text, 'outside-bytes', 'the Host file authority allows an outside absolute path')

  // T17 COLD path: drop the LIVE Session entry, so the adapter must resolve the
  // scope from the PERSISTED header instead. This is the exact cold-start case.
  const sessions = host.ctx.get('sessions') as unknown as { store: Map<string, unknown>; get(id: string): unknown }
  assert.notEqual(sessions.get(sessionId), undefined, 'precondition: the Session is live')
  sessions.store.delete(sessionId)
  assert.equal(sessions.get(sessionId), undefined, 'the live entry is gone: only persistence remains')
  const coldStat = await port.stat(sessionId, 'cold.md', abort)
  assert.equal(coldStat.bytes, Buffer.byteLength('cold-bytes\n'), 'the persisted header resolved the workspace root')
  const coldPage = await port.read(sessionId, 'cold.md', 1, abort)
  assert.equal(coldPage.text, 'cold-bytes', 'a RELATIVE declared path resolves against the cold header cwd')

  // T25: REAL Host refusals, never invented at the port.
  // `stat` is METADATA: it answers even for a file the TEXT read refuses, which
  // is what lets the failure page still show the size/path.
  const invalidPath = join(workspace, 'invalid-utf8.bin')
  writeFileSync(invalidPath, Buffer.from([0xc3, 0x28, 0x0a]))
  const invalidStat = await port.stat(sessionId, invalidPath, abort)
  assert.equal(invalidStat.bytes, 3, 'the Host still reports the metadata')
  await assertRejectionCode(port.read(sessionId, invalidPath, 1, abort), 'not-text')

  const giantPath = join(workspace, 'giant-line.txt')
  writeFileSync(giantPath, 'x'.repeat(3 * 1024 * 1024))
  const giantStat = await port.stat(sessionId, giantPath, abort)
  assert.equal(giantStat.bytes, 3 * 1024 * 1024)
  await assertRejectionCode(port.read(sessionId, giantPath, 1, abort), 'too-large')
})
