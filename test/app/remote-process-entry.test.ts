/**
 * M4-A0 process-entry contracts at the composition level.
 *
 * These tests prove the parts that do not need a real OS process: the Host-only
 * overlay disables exactly the surface rows, the shared Host prerequisite gate
 * fails closed and names the missing service, and the Client-only subtree mounts
 * and disposes on a plain Client Context while reporting `not-connected`.
 * The real two-PID / tarball qualification lives in the evidence package's
 * process harness (A0-T01…T05).
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-entry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { startLocalClient } from '../../src/app/remote-process/client-bootstrap.ts'
import { createControlDispatcher } from '../../src/app/remote-process/entry-control.ts'
import { stopLocalClient } from '../../src/app/remote-process/local-client-entry.ts'
import { finishHostFailureCleanup, HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import {
  assertRemoteHostPrerequisites,
  REMOTE_HOST_PREREQUISITE_SERVICES,
} from '../../src/app/remote/host-prerequisites.ts'

test('the Host-only overlay disables the TUI runner and the Client UI rows only', () => {
  const disabled = [...HOST_ONLY_PATCH.matchAll(/^- id: (\S+)$/gmu)].map(match => match[1])
  assert.deepEqual(disabled, ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'])
  assert.doesNotMatch(HOST_ONLY_PATCH, /id: tui-startup/u, 'Host rows gated on tuiStartup must keep their provider')
})

test('the shared Host prerequisite gate names the first missing service', () => {
  const ctx = new Context()
  assert.throws(
    () => assertRemoteHostPrerequisites(ctx),
    /missing the required "credentials" service/u,
  )
  for (const service of REMOTE_HOST_PREREQUISITE_SERVICES) ctx.provide(service, {} as never)
  assert.doesNotThrow(() => assertRemoteHostPrerequisites(ctx))
})

test('the Client-only subtree mounts on a plain Client Context and reports not-connected', async () => {
  const context = new Context()
  const handle = await startLocalClient(context, { sessionId: 'synthetic-session' })
  try {
    assert.equal(handle.status.processRole, 'client')
    assert.equal(handle.status.transport, 'not-connected')
    assert.equal(handle.status.sessionOpen, false)
    assert.equal(handle.status.fiberOwner, 'client-root')
    assert.deepEqual(handle.status.startupFacts, { sessionId: 'synthetic-session' })
    assert.notEqual(context.get(PI_TUI_EXTENSIONS_SERVICE), undefined)
  } finally {
    await handle.dispose()
  }
  assert.equal(context.get(PI_TUI_EXTENSIONS_SERVICE), undefined, 'the Client root disposal releases the extension host')
})

test('a Client-local mount failure unwinds the startup-facts fiber it already owned', async () => {
  const context = new Context()
  // Pre-occupy the extension service so the real extension-host fiber fails
  // during construction, AFTER the startup-facts fiber mounted. The unwind
  // must leave no Client-local service behind.
  context.provide(PI_TUI_EXTENSIONS_SERVICE, {} as never)
  await assert.rejects(startLocalClient(context, {}))
  assert.equal(context.get('tuiStartup'), undefined, 'the startup-facts fiber must be unwound')
})

test('a rejected control handler is reported and does not strand later commands', async () => {
  const records: Array<Record<string, unknown>> = []
  const seen: string[] = []
  const dispatcher = createControlDispatcher(async request => {
    seen.push(request.op)
    if (request.op === 'boom') throw new Error('control handler exploded')
    return false
  }, { emit: record => { records.push(record) } })
  await dispatcher.dispatch('{"op":"status"}')
  await dispatcher.dispatch('{"op":"boom"}')
  await dispatcher.dispatch('{"op":"status"}')
  assert.deepEqual(seen, ['status', 'boom', 'status'], 'the queue continues after a rejected handler')
  assert.equal(records.filter(record => record.m4a0 === 'control-failure').length, 1)
})

test('a rejecting Host shutdown reports cleanup-failure and never claims completed', async () => {
  const records: Array<Record<string, unknown>> = []
  const completed = await finishHostFailureCleanup(
    { shutdown: async () => { throw new Error('host dispose exploded') } },
    record => { records.push(record) },
  )
  assert.equal(completed, false)
  assert.equal(records.filter(record => record.m4a0 === 'cleanup-failure').length, 1)
  assert.equal(records.filter(record => record.m4a0 === 'cleanup').length, 0)
})

test('a rejecting Client dispose becomes a nonzero shutdown with a cleanup-failure', async () => {
  const records: Array<Record<string, unknown>> = []
  const exitCode = await stopLocalClient(
    { dispose: async () => { throw new Error('client dispose exploded') } },
    0,
    record => { records.push(record) },
  )
  assert.equal(exitCode, 1)
  assert.equal(records.filter(record => record.m4a0 === 'cleanup-failure').length, 1)
})

test('a successful Client dispose keeps the requested code and reports no failure', async () => {
  const records: Array<Record<string, unknown>> = []
  const exitCode = await stopLocalClient({ dispose: async () => {} }, 0, record => { records.push(record) })
  assert.equal(exitCode, 0)
  assert.deepEqual(records, [])
})

test('the real Client handle turns a rejecting root disposer into cleanup-failure + code 1', async () => {
  const context = new Context()
  const handle = await startLocalClient(context, {})
  const root = context.fiber as unknown as { dispose: () => Promise<void> }
  root.dispose = async () => { throw new Error('root dispose exploded') }
  const records: Array<Record<string, unknown>> = []
  const exitCode = await stopLocalClient(handle, 0, record => { records.push(record) })
  assert.equal(exitCode, 1)
  assert.equal(records.filter(record => record.m4a0 === 'cleanup-failure').length, 1)
})
