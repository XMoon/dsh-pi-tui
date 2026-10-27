/**
 * Delivered files PR2 — the REAL Host → generated Remote wire for the file
 * preview (`test/integration`).
 *
 * One in-process Remote carrier, the OFFICIAL `@deepseek-ai/dsh-api-workspace-files`
 * Host service the bundle's `cordis.patch.yml` mounts, and the generated Client
 * namespace contribution `src/app/remote/client-runtime.ts` mounts. The point is
 * the ROUTING, not a fake interface:
 *
 * ```text
 * Client remote.workspaceFiles.stat/read -> Host WorkspaceFiles (Session-derived scope)
 *                                        -> composed Host filesystem (real file bytes)
 * ```
 *
 * The positive case asserts the real decoded text/lines/eof/version, the
 * negative case asserts the official structured refusal code.
 * @module @xmoon76/dsh-pi-tui/integration/delivered-file-preview-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../../src/app/remote/host-runtime.ts'
import { DeliveredFileReadError } from '../../src/runtime/deliverables-port.ts'
import { RemoteDeliveredFileReadPort } from '../../src/runtime/remote/deliverables-remote.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const abort = new AbortController().signal

async function assertRejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeliveredFileReadError, `expected a definite refusal, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('the generated workspaceFiles Remote serves a real Host stat/read and a real refusal', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'pr2-wire-preset')
  let hostRuntime: RemoteHostRuntime | undefined
  let client: RemoteClientRuntime | undefined
  try {
    const workspace = life.tempDir('dsh-pr2-wire-ws-')
    const docsDir = join(workspace, 'docs')
    mkdirSync(docsDir, { recursive: true })
    const filePath = join(docsDir, 'report.md')
    const content = 'line one\nline two\nline three\n'
    writeFileSync(filePath, content)
    const sessionId = SessionId('pr2-wire-session')
    await host.harness.create(sessionId, undefined, { cwd: workspace })

    hostRuntime = await createRemoteHostRuntime(host.ctx)
    client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })

    const stat = await client.remote.workspaceFiles.stat(sessionId, filePath, abort)
    assert.equal(stat.ok, true, `the Host owned the stat: ${JSON.stringify(stat)}`)
    assert.ok(stat.ok)
    assert.equal(typeof stat.value.version, 'string', 'the freshness token is opaque but present')
    assert.equal(stat.value.bytes, Buffer.byteLength(content), 'the real byte size comes from the Host filesystem')
    assert.ok(stat.value.absolutePath.endsWith(join('docs', 'report.md')), stat.value.absolutePath)

    const page = await client.remote.workspaceFiles.read(sessionId, filePath, { offset: 1, limit: 120 }, abort)
    assert.equal(page.ok, true, `the Host owned the read: ${JSON.stringify(page)}`)
    assert.ok(page.ok)
    assert.equal(page.value.offset, 1)
    assert.equal(page.value.lines, 3)
    assert.equal(page.value.text, 'line one\nline two\nline three', 'the decoded UTF-8 text is the file on the Host')
    assert.equal(page.value.eof, true)
    assert.equal(page.value.version, stat.value.version)
    assert.equal(page.value.absolutePath, stat.value.absolutePath)

    // The second page is empty and past EOF: the wire preserves the Host's
    // line accounting instead of inventing a blank line.
    const past = await client.remote.workspaceFiles.read(sessionId, filePath, { offset: 4, limit: 120 }, abort)
    assert.ok(past.ok)
    assert.equal(past.value.lines, 0)
    assert.equal(past.value.eof, true)

    const missing = await client.remote.workspaceFiles.stat(sessionId, join(workspace, 'missing.md'), abort)
    assert.equal(missing.ok, false, `a missing file is the official refusal: ${JSON.stringify(missing)}`)
    if (!missing.ok) assert.equal(missing.error.code, 'workspace-file/not-found')

    // A file the Host filesystem reads but the text service refuses: NUL bytes
    // are the official `not-text` classification, not an empty success.
    const binaryPath = join(workspace, 'binary.bin')
    writeFileSync(binaryPath, Buffer.from([0x61, 0x00, 0x62]))
    const binary = await client.remote.workspaceFiles.read(sessionId, binaryPath, { offset: 1, limit: 120 }, abort)
    assert.equal(binary.ok, false)
    if (!binary.ok) assert.equal(binary.error.code, 'workspace-file/not-text')

    // The ADAPTER the preview consumes, over this SAME real wire: the official
    // namespace + the real Connection generation source.
    const port = new RemoteDeliveredFileReadPort(client.remote.workspaceFiles, client.connection.generation)
    const viaPort = await port.read(sessionId, filePath, 1, 120, abort)
    assert.deepEqual(
      { offset: viaPort.offset, limit: viaPort.limit, lines: viaPort.lines, eof: viaPort.eof, text: viaPort.text },
      { offset: 1, limit: 120, lines: 3, eof: true, text: 'line one\nline two\nline three' },
    )
    await assertRejectsCode(port.stat(sessionId, join(workspace, 'missing.md'), abort), 'not-found')
    await assertRejectsCode(port.read(sessionId, binaryPath, 1, 120, abort), 'not-text')
    await assertRejectsCode(port.stat('missing-session', filePath, abort), 'session-unavailable')
  } finally {
    await client?.dispose()
    await hostRuntime?.dispose()
  }
})
