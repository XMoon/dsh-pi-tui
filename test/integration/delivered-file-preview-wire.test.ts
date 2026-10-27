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
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../../src/app/remote/host-runtime.ts'
import { DeliveredFileReadError } from '../../src/runtime/deliverables-port.ts'
import { DirectDeliveredFileReadPort } from '../../src/runtime/direct/deliverables-direct.ts'
import { DeliveredFilesPanel } from '../../src/tui/deliverables/delivered-files-panel.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
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
    const viaPort = await port.read(sessionId, filePath, 1, abort)
    assert.deepEqual(
      { offset: viaPort.offset, limit: viaPort.limit, lines: viaPort.lines, eof: viaPort.eof, text: viaPort.text },
      { offset: 1, limit: 120, lines: 3, eof: true, text: 'line one\nline two\nline three' },
    )
    await assertRejectsCode(port.stat(sessionId, join(workspace, 'missing.md'), abort), 'not-found')
    await assertRejectsCode(port.read(sessionId, binaryPath, 1, abort), 'not-text')
    await assertRejectsCode(port.stat('missing-session', filePath, abort), 'session-unavailable')

    // ── The REAL chain all the way to the PAINTED page ─────────────────────
    // Host file bytes -> official workspaceFiles over the generated Remote wire
    // -> RemoteDeliveredFileReadPort -> the panel's preview state machine ->
    // the rows the Details page paints. Nothing in this leg is a stand-in: the
    // snapshot names the declared path, and the capability is the port above.
    const bound = {
      stat: (path: string, signal: AbortSignal) => port.stat(sessionId, path, signal),
      read: (path: string, offset: number, signal: AbortSignal) =>
        port.read(sessionId, path, offset, signal),
    }
    // A UNIQUE token in the real file: no stub, constant or replayed body can
    // satisfy this assertion — only the bytes on the Host filesystem can.
    const token = randomUUID()
    const panelPath = join(docsDir, 'panel-real.md')
    writeFileSync(panelPath, `the real report\n${token}\ntail line\n`)
    const panel = new DeliveredFilesPanel({
      snapshot: {
        subjectKind: 'main',
        sessionId,
        sourceIdentity: {},
        turns: [{ turn: 1, files: [{ path: panelPath, description: 'the real report' }] }],
      },
      initial: { turn: 1, path: panelPath, page: 'details' },
      preview: bound,
      requestRender: () => {},
      close: () => {},
      copyPath: (_path, settle) => settle(true),
    })
    panel.setMaxRows(20)
    const paint = (): string => panel.render(96).map(row => stripTerminalSequences(row)).join('\n')
    // Wait for the REAL wire to settle instead of assuming a tick count.
    const deadline = Date.now() + 5_000
    while (!paint().includes(token) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const painted = paint()
    assert.ok(painted.includes(token), `the UNIQUE Host bytes reach the painted page:\n${painted}`)
    assert.ok(painted.includes('the real report'), `the first real line is painted:\n${painted}`)
    assert.ok(painted.includes('tail line'), `the tail line is painted:\n${painted}`)
    assert.ok(painted.includes('Host: ') && painted.includes(panelPath), `the declared path is the subject:\n${painted}`)
    assert.ok(!painted.includes('Loading'), `the page left the loading state:\n${painted}`)

    // The SAME chain on a REAL refusal: the Host's official not-found code maps
    // to the definite sentence the user reads.
    const missingPanel = new DeliveredFilesPanel({
      snapshot: {
        subjectKind: 'main',
        sessionId,
        sourceIdentity: {},
        turns: [{ turn: 1, files: [{ path: join(workspace, 'missing.md') }] }],
      },
      initial: { turn: 1, path: join(workspace, 'missing.md'), page: 'details' },
      preview: bound,
      requestRender: () => {},
      close: () => {},
      copyPath: (_path, settle) => settle(true),
    })
    missingPanel.setMaxRows(20)
    const missingPaint = (): string =>
      missingPanel.render(96).map(row => stripTerminalSequences(row)).join('\n')
    const missingDeadline = Date.now() + 5_000
    while (!missingPaint().includes('File no longer exists') && Date.now() < missingDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(missingPaint().includes('File no longer exists on Host'),
      `a real official refusal paints its definite sentence:\n${missingPaint()}`)
  } finally {
    await client?.dispose()
    await hostRuntime?.dispose()
  }
})

test('126 delivered files: only the SELECTED file reaches the Host, counted at the real service', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'pr2-bulk-preset')
  const workspace = life.tempDir('dsh-pr2-bulk-ws-')
  mkdirSync(workspace, { recursive: true })
  const sessionId = SessionId('pr2-bulk-session')
  await host.harness.create(sessionId, undefined, { cwd: workspace })

  // 126 REAL files, each with a unique body.
  const paths: string[] = []
  for (let index = 0; index < 126; index += 1) {
    const path = join(workspace, `f-${String(index + 1).padStart(3, '0')}.md`)
    writeFileSync(path, `body of file ${index + 1}\n`)
    paths.push(path)
  }

  // Count AT THE ACTUAL Host service: patch the mounted official instance's own
  // methods (unbound originals, restored in `finally`), so the count is what the
  // Host really served — never a stub's tally.
  const service = host.ctx.get('workspaceFiles') as unknown as {
    stat(...args: unknown[]): Promise<unknown>
    read(...args: unknown[]): Promise<unknown>
  }
  const originalStat = service.stat
  const originalRead = service.read
  const served: string[] = []
  service.stat = function patchedStat(this: unknown, ...args: unknown[]) {
    served.push(`stat:${String(args[1])}`)
    return originalStat.apply(this, args)
  }
  service.read = function patchedRead(this: unknown, ...args: unknown[]) {
    served.push(`read:${String(args[1])}`)
    return originalRead.apply(this, args)
  }
  try {
    const port = new DirectDeliveredFileReadPort(host.ctx)
    const bound = {
      stat: (path: string, signal: AbortSignal) => port.stat(sessionId, path, signal),
      read: (path: string, offset: number, signal: AbortSignal) => port.read(sessionId, path, offset, signal),
    }
    const panel = new DeliveredFilesPanel({
      snapshot: {
        subjectKind: 'main',
        sessionId,
        sourceIdentity: {},
        turns: [{ turn: 1, files: paths.map(path => ({ path })) }],
      },
      initial: { turn: 1, path: paths[0], page: 'details' },
      preview: bound,
      requestRender: () => {},
      close: () => {},
      copyPath: (_path, settle) => settle(true),
    })
    panel.setMaxRows(20)
    const paint = (): string => panel.render(96).map(row => stripTerminalSequences(row)).join('\n')
    const deadline = Date.now() + 5_000
    while (!paint().includes('body of file 1') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(paint().includes('body of file 1'), paint())

    // F08: entering ONE preview is one stat + one read, for THAT path only.
    assert.deepEqual(served, [`stat:${paths[0]}`, `read:${paths[0]}`],
      `126 declared files must not fan out into 126 Host requests: ${JSON.stringify(served)}`)

    // Selecting another row on the Files page still reads nothing.
    served.length = 0
    panel.handleInput('\u001b') // Esc back to Files
    for (let step = 0; step < 5; step += 1) panel.handleInput('\u001b[B') // ↓
    panel.render(96)
    assert.deepEqual(served, [], `browsing the list issues no Host request: ${JSON.stringify(served)}`)
  } finally {
    service.stat = originalStat
    service.read = originalRead
  }
})
