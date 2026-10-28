/**
 * F01 negative control (Delivered files PR2): a RELATIVE declared path must
 * resolve against the Host Session's header cwd, never the Client process cwd.
 *
 * The Client cwd is moved into its own temp tree holding the SAME relative path
 * with DIFFERENT bytes, so a Client-cwd fallback would return the wrong content.
 * This file owns its process, so `process.chdir()` cannot disturb another
 * suite's cwd-sensitive work.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/deliverables-direct-client-cwd.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DirectDeliveredFileReadPort } from '../../../src/runtime/direct/deliverables-direct.ts'
import { createRemoteApplicationHostFixture } from '../../support/remote-application-fixture.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

const abort = new AbortController().signal

test('a relative declared path resolves against the HOST cwd, not the Client cwd', async (t) => {
  const life = testLifecycle(t)
  // The HOST workspace: `docs/report.md` carries the Host bytes.
  const hostWorkspace = life.tempDir('dsh-f01-host-ws-')
  mkdirSync(join(hostWorkspace, 'docs'), { recursive: true })
  writeFileSync(join(hostWorkspace, 'docs', 'report.md'), 'HOST BYTES\n')
  // The CLIENT cwd: the very same RELATIVE path, deliberately different bytes.
  const clientCwd = life.tempDir('dsh-f01-client-cwd-')
  mkdirSync(join(clientCwd, 'docs'), { recursive: true })
  writeFileSync(join(clientCwd, 'docs', 'report.md'), 'CLIENT BYTES\n')

  const host = await createRemoteApplicationHostFixture(life, 'f01-preset')
  const sessionId = SessionId('f01-session')
  await host.harness.create(sessionId, undefined, { cwd: hostWorkspace })
  const port = new DirectDeliveredFileReadPort(host.ctx)

  const previousCwd = process.cwd()
  process.chdir(clientCwd)
  try {
    assert.equal(process.cwd(), clientCwd, 'fixture: the Client cwd really holds the decoy file')
    // A relative path: the Host header's cwd decides what "docs/report.md" means.
    const page = await port.read(sessionId, 'docs/report.md', 1, abort)
    assert.equal(page.text, 'HOST BYTES', 'the HOST bytes win; a Client-cwd fallback would show CLIENT BYTES')
    const stat = await port.stat(sessionId, 'docs/report.md', abort)
    assert.equal(stat.bytes, Buffer.byteLength('HOST BYTES\n'), 'the metadata is the Host file too')
  } finally {
    process.chdir(previousCwd)
  }
})
