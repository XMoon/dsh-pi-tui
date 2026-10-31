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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { startLocalClient } from '../../src/app/remote-process/client-bootstrap.ts'
import { createControlDispatcher } from '../../src/app/remote-process/entry-control.ts'
import { stopLocalClient, surfaceStartupFailureLine } from '../../src/app/remote-process/local-client-entry.ts'
import { LocalScopeError } from '../../src/app/remote-process/local-scope.ts'
import { collectHostEntryStatus } from '../../src/app/remote-process/host-bootstrap.ts'
import { finishHostFailureCleanup, HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import {
  assertRemoteHostPrerequisites,
  REMOTE_HOST_PREREQUISITE_SERVICES,
} from '../../src/app/remote/host-prerequisites.ts'

test('the Host-only overlay disables the TUI runner and the Client UI rows only', () => {
  // The value matters as much as the id: matching only `- id:` lets a broken
  // `disabled: false` silently leave a Client UI row mounted.
  const disabled = [...HOST_ONLY_PATCH.matchAll(/^- id: (\S+)\n  disabled: true$/gmu)].map(match => match[1])
  assert.deepEqual(disabled, ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'])
  assert.equal((HOST_ONLY_PATCH.match(/disabled: true/gu) ?? []).length, 3)
  assert.doesNotMatch(HOST_ONLY_PATCH, /id: tui-startup/u, 'Host rows gated on tuiStartup must keep their provider')

  // Negative control: if any one disabled value is broken, this same assertion
  // no longer sees all three rows.
  const broken = HOST_ONLY_PATCH.replace('disabled: true', 'disabled: false')
  const stillDisabled = [...broken.matchAll(/^- id: (\S+)\n  disabled: true$/gmu)].map(match => match[1])
  assert.notDeepEqual(stillDisabled, ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'])
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

test('the Host audit fails closed when the Connection owner row is not active', () => {
  const context = new Context()
  for (const service of REMOTE_HOST_PREREQUISITE_SERVICES) context.provide(service, {} as never)
  context.provide('connection', {} as never)
  context.provide('webServer', {
    host: '127.0.0.1',
    port: 41000,
    getOrigin: () => 'http://127.0.0.1:41000',
  } as never)
  const active = (id: string, name: string) => ({ options: { id, name }, fiber: { state: 2 } })
  const entries = [
    active('agent', '@deepseek-ai/dsh-agent'),
    active('session', '@deepseek-ai/dsh-session'),
    active('job-controller', '@deepseek-ai/dsh-api-job-controller'),
    active('typert-gateway', '@deepseek-ai/dsh-api-gateway'),
    active('split-host-api-remotes', '@deepseek-ai/dsh-api-remotes'),
    active('webserver', '@deepseek-ai/dsh-host-webserver'),
  ]
  context.provide('loader', { entries: () => entries, await: async () => {} } as never)
  assert.throws(
    () => collectHostEntryStatus(context, { profile: 'pi-tui' }),
    /connection owner row, found 0/u,
  )
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

test('a prior cleanup failure suppresses a Host cleanup completed claim', async () => {
  const records: Array<Record<string, unknown>> = []
  const completed = await finishHostFailureCleanup(
    { shutdown: async () => {} },
    record => { records.push(record) },
    { priorCleanupFailure: 'settle failed' },
  )
  assert.equal(completed, false)
  assert.equal(records.filter(record => record.m4a0 === 'cleanup').length, 0)
  assert.equal(records.filter(record => record.m4a0 === 'cleanup-failure').length, 1)
  assert.equal(records[0]?.step, 'prior-cleanup')
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

test('the Host-only overlay adds exactly the two B1 owner rows and no second gateway/webserver', () => {
  const rows = [...HOST_ONLY_PATCH.matchAll(
    /^    - id: (split-host-connection|split-host-api-remotes)\n      name: '([^']+)'\n      inject: \[([^\]]+)\]\n(?:      config:\n        trustedHosts: \[\]\n)?/gmu,
  )].map(match => ({ id: match[1], name: match[2], inject: match[3].split(',').map(value => value.trim()) }))
  assert.deepEqual(rows, [
    {
      id: 'split-host-connection',
      name: '@deepseek-ai/dsh-client-connection',
      inject: ['tuiStartup', 'credentials', 'webServer'],
    },
    {
      id: 'split-host-api-remotes',
      name: '@deepseek-ai/dsh-api-remotes',
      inject: ['typertGateway', 'connection'],
    },
  ])
  assert.doesNotMatch(HOST_ONLY_PATCH, /- id: (?:typert-gateway|webserver|agent|session|job-controller)\n/u)
  assert.match(HOST_ONLY_PATCH, /^- insert:$/mu)
  assert.doesNotMatch(HOST_ONLY_PATCH, /split-host-connection\n(?:.*\n)*?      disabled: true/u)
  assert.doesNotMatch(HOST_ONLY_PATCH, /split-host-api-remotes\n(?:.*\n)*?      disabled: true/u)
})

test('the Host identity route rides the official owner-only Fetch registry', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'app', 'remote-process', 'local-host-entry.ts'),
    'utf8',
  )
  assert.match(source, /connection\.fetch\.register\(\{/u)
  assert.match(source, /path: '\/api\/pi-tui\.local-host'/u)
  assert.match(source, /methods: \['GET'\]/u)
  assert.match(source, /requestBody: 'buffered'/u)
  assert.doesNotMatch(source, /webServer\.register\(/u)
  assert.doesNotMatch(source, /registerUpgrade\(/u)
  assert.doesNotMatch(source, /webServer\.register\(route/u)
})

test('the Client status is projected from the official state/generation at call time', async () => {
  const context = new Context()
  let phase: 'connecting' | 'connected' | 'disconnected' = 'connecting'
  let generation: { id: number; host: { home: string } } | undefined
  const events: string[] = []
  const transport = {
    connection: {
      state: { getSnapshot: () => phase },
      generation: { getSnapshot: () => generation },
    },
    status: () => ({
      transport: phase,
      ...(generation === undefined ? {} : { generationId: generation.id, hostHome: generation.host.home }),
    }),
    dropWebSocketsForQualification: () => {},
    async dispose() {
      assert.equal(context.get(PI_TUI_EXTENSIONS_SERVICE), undefined, 'the Client UI must dispose before the transport')
      events.push('transport')
    },
  }
  const host = {
    schema: 1 as const,
    scopeId: 'a'.repeat(64),
    profileRealpath: '/private/profile',
    instanceId: '00000000-0000-4000-8000-000000000000',
    hostPid: 42,
    hostStarttime: '99',
    origin: 'http://127.0.0.1:41000',
    protocol: 'm4-b1/1' as const,
    bundleVersion: '0.5.4',
    dshVersion: '0.2.1-rc.4',
    buildId: 'b'.repeat(64),
  }
  const handle = await startLocalClient(context, {}, 'start', {
    transport: transport as never,
    host,
  })
  try {
    assert.equal(handle.status.transport, 'connecting')
    assert.equal(handle.status.generationId, undefined)
    generation = { id: 1, host: { home: '/home/host' } }
    phase = 'connected'
    assert.equal(handle.status.transport, 'connected')
    assert.equal(handle.status.generationId, 1)
    assert.equal(handle.status.hostHome, '/home/host')
    assert.equal(handle.status.host?.instanceId, host.instanceId)
    assert.equal(Object.hasOwn(handle.status.host ?? {}, 'profileRealpath'), false)
    generation = undefined
    phase = 'connecting'
    assert.equal(handle.status.transport, 'connecting')
    assert.equal(handle.status.generationId, undefined)
    phase = 'disconnected'
    assert.equal(handle.status.transport, 'disconnected')
    const root = context.fiber as unknown as { dispose: () => Promise<void> }
    const originalRootDispose = root.dispose
    root.dispose = async () => { events.push('root') }
    await handle.dispose()
    root.dispose = originalRootDispose
    assert.deepEqual(events, ['transport', 'root'])
  } finally {
    await handle.dispose()
    await context.fiber.dispose().catch(() => undefined)
  }
})

test('a disposing transport failure is primary and the Client root failure rides its cause', async () => {
  const context = new Context()
  const transport = {
    connection: {
      state: { getSnapshot: () => 'connected' as const },
      generation: { getSnapshot: () => ({ id: 1, host: { home: '/home/host' } }) },
    },
    status: () => ({ transport: 'connected' as const, generationId: 1 }),
    dropWebSocketsForQualification: () => {},
    async dispose() { throw new Error('transport dispose exploded') },
  }
  const host = {
    schema: 1 as const,
    scopeId: 'a'.repeat(64),
    profileRealpath: '/private/profile',
    instanceId: '00000000-0000-4000-8000-000000000000',
    hostPid: 42,
    hostStarttime: '99',
    origin: 'http://127.0.0.1:41000',
    protocol: 'm4-b1/1' as const,
    bundleVersion: '0.5.4',
    dshVersion: '0.2.1-rc.4',
    buildId: 'b'.repeat(64),
  }
  const handle = await startLocalClient(context, {}, 'start', { transport: transport as never, host })
  const root = context.fiber as unknown as { dispose: () => Promise<void> }
  const originalRootDispose = root.dispose
  root.dispose = async () => { throw new Error('root dispose exploded') }
  try {
    await assert.rejects(handle.dispose(), (error: unknown) => {
      const failure = error as Error & { cause?: unknown }
      assert.equal(failure.message, 'transport dispose exploded')
      assert.match(String(failure.cause instanceof Error ? failure.cause.message : failure.cause), /root dispose exploded/u)
      return true
    })
  } finally {
    root.dispose = originalRootDispose
    await context.fiber.dispose().catch(() => undefined)
  }
})

test('the B1 Client transport mounts exactly the three Node client halves and no private bridge', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'app', 'remote-process', 'local-transport.ts'),
    'utf8',
  )
  for (const specifier of [
    '@deepseek-ai/dsh-typert-registry/client',
    '@deepseek-ai/dsh-client-connection/client',
    '@deepseek-ai/dsh-api-gateway/client',
  ]) {
    assert.match(source, new RegExp(`'${specifier.replaceAll('/', '\\/')}'`, 'u'))
  }
  assert.doesNotMatch(source, /ownsHost\s*:/u)
  assert.doesNotMatch(source, /createExperimentalRemoteRuntime/u)
  assert.doesNotMatch(source, /app\/remote\/runtime\.ts/u)
  assert.doesNotMatch(source, /host-runtime\.ts/u)
  assert.doesNotMatch(source, /application-runtime\.ts/u)
  assert.doesNotMatch(source, /window\.__ModuleLoader__|globalThis\.window/u)
  assert.doesNotMatch(source, /\brpc\s*:/u)
  assert.doesNotMatch(source, /openStream\s*:/u)
  assert.match(source, /interactions: 'answer'/u)
  assert.match(source, /streamBaseUrl: origin/u)
})

test('a surface startup build refusal states the code, preserved Host and explicit manual stop', () => {
  const line = surfaceStartupFailureLine(
    new LocalScopeError('HOST_BUILD_INCOMPATIBLE', 'local discovery: the live Host was built from a different payload'),
  )
  assert.match(line, /^HOST_BUILD_INCOMPATIBLE: /u)
  assert.match(line, /has not been stopped or replaced/u)
  assert.match(line, /explicitly stop that Host through its normal operating-system shutdown signal/u)
  assert.match(line, /Automatic upgrade and migration of in-memory work are not supported/u)
  // The refusal must not turn an unauthenticated registry candidate into a
  // displayed PID/kill target or leak the private launch material.
  assert.doesNotMatch(line, /\bpid\b|connectUrl|token|cookie|\/home\/|\/users\//iu)
  // Other startup failures keep the existing surface diagnostic.
  assert.equal(
    surfaceStartupFailureLine(new LocalScopeError('HOST_UNRESPONSIVE', 'local discovery: identity route answered HTTP 503')),
    'split client surface: local discovery: identity route answered HTTP 503',
  )
})
