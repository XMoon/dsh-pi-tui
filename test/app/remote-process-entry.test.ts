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
import test, { type TestContext } from 'node:test'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { startLocalClient, type LocalClientStatus } from '../../src/app/remote-process/client-bootstrap.ts'
import { createControlDispatcher } from '../../src/app/remote-process/entry-control.ts'
import {
  assertHandoffSignalExclusivity,
  createClientReexecChildEnvironment,
  createClientReexecRequestHandler,
  expectedHostInstanceFromEnvironment,
  finishClientEntryShutdown,
  handoffStartupFailureLine,
  inspectClientReexecTarget,
  prepareClientReexec,
  resolveProfileInstalledClientTarget,
  stopLocalClient,
  surfaceStartupFailureLine,
  type ClientReexecIntent,
} from '../../src/app/remote-process/local-client-entry.ts'
import { LocalScopeError } from '../../src/app/remote-process/local-scope.ts'
import { collectHostEntryStatus } from '../../src/app/remote-process/host-bootstrap.ts'
import { finishHostFailureCleanup, HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import {
  assertRemoteHostPrerequisites,
  REMOTE_HOST_PREREQUISITE_SERVICES,
} from '../../src/app/remote/host-prerequisites.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

test('the Host-only overlay disables the TUI runner and the Client UI rows only', () => {
  // The value matters as much as the id: matching only `- id:` lets a broken
  // `disabled: false` silently leave a Client UI row mounted.
  const disabled = [...HOST_ONLY_PATCH.matchAll(/^- id: (\S+)\n  disabled: true$/gmu)].map(match => match[1])
  assert.deepEqual(disabled, ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'])
  assert.equal((HOST_ONLY_PATCH.match(/disabled: true/gu) ?? []).length, 3)
  assert.doesNotMatch(HOST_ONLY_PATCH, /id: tui-startup/u,
    'the overlay must not disable or redefine the tui-startup row itself')

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
      inject: ['credentials', 'webServer'],
    },
    {
      id: 'split-host-api-remotes',
      name: '@deepseek-ai/dsh-api-remotes',
      inject: ['typertGateway', 'connection'],
    },
  ])
  // Only inserted rows mount a row. `webserver` and `workspace-files` are
  // retuned by top-level in-place overrides (no `name`), which must never be
  // turned into a second Loader row for the same service.
  assert.doesNotMatch(HOST_ONLY_PATCH, /^    - id: (?:typert-gateway|webserver|agent|session|job-controller)$/mu)
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
    protocol: 'dsh-pi-tui/local/1' as const,
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
    protocol: 'dsh-pi-tui/local/1' as const,
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

test('a surface startup protocol refusal states the code, preserved Host and explicit manual stop', () => {
  const line = surfaceStartupFailureLine(
    new LocalScopeError('HOST_PROTOCOL_INCOMPATIBLE', 'local discovery: the live Host uses a different local protocol or DSH runtime'),
  )
  assert.match(line, /^HOST_PROTOCOL_INCOMPATIBLE: /u)
  assert.match(line, /different local protocol or DSH runtime/u)
  assert.match(line, /has not been stopped or replaced/u)
  assert.match(line, /explicitly stop that Host through its normal operating-system shutdown signal/u)
  assert.match(line, /start a compatible Host/u)
  assert.match(line, /Automatic upgrade and migration of in-memory work are not supported/u)
  // The refusal must not turn an unauthenticated registry candidate into a
  // displayed PID/kill target or leak the private launch material.
  assert.doesNotMatch(line, /\bpid\b|connectUrl|token|cookie|\/home\/|\/users\//iu)
  // Other startup failures keep the existing surface diagnostic.
  assert.equal(
    surfaceStartupFailureLine(new LocalScopeError('HOST_UNRESPONSIVE', 'local discovery: identity route answered HTTP 503')),
    'split client surface: local discovery: identity route answered HTTP 503',
  )
  assert.equal(
    surfaceStartupFailureLine(new LocalScopeError('HOST_BUILD_INCOMPATIBLE', 'local discovery: the Host cannot publish identity for another installed build')),
    'split client surface: local discovery: the Host cannot publish identity for another installed build',
  )
})

const REEXEC_HOST_INSTANCE = '00000000-0000-4000-8000-000000000000'

const CONNECTED_STATUS: LocalClientStatus = {
  processRole: 'client',
  pid: 4242,
  phase: 'client-local-ready',
  transport: 'connected',
  sessionOpen: true,
  openSessionId: 'session-s',
  surfaceMounted: true,
  fiberOwner: 'client-root',
  extensionService: { present: true },
  startupFacts: {},
  host: {
    scopeId: 'a'.repeat(64),
    instanceId: REEXEC_HOST_INSTANCE,
    hostPid: 77,
    hostStarttime: '123',
    origin: 'http://127.0.0.1:40000',
    protocol: 'dsh-pi-tui/local/1',
    bundleVersion: '0.5.4',
    dshVersion: '0.2.1-rc.4',
    buildId: 'b'.repeat(64),
  },
}

/** Write one minimal real replacement-package fixture. */
function writePackage(root: string, options: { version?: string; dshVersion?: string; name?: string } = {}): void {
  mkdirSync(join(root, 'dist'), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: options.name ?? '@xmoon76/dsh-pi-tui',
    version: options.version ?? '0.5.4-pr3new.1',
    devDependencies: { '@deepseek-ai/dsh-agent': options.dshVersion ?? '0.2.1-rc.4' },
  })}\n`)
  writeFileSync(join(root, 'dist', 'index.mjs'), 'export const value = 1\n')
  writeFileSync(join(root, 'dist', 'local-client.mjs'), 'export {}\n')
}

function reexecFixture(t: TestContext): { readonly packageRoot: string; readonly intent: ClientReexecIntent } {
  const root = testLifecycle(t).tempDir('dsh-pr3-reexec-')
  const packageRoot = join(root, 'package')
  writePackage(packageRoot)
  const target = inspectClientReexecTarget(packageRoot, '0.2.1-rc.4')
  return {
    packageRoot,
    intent: {
      expectedInstanceId: REEXEC_HOST_INSTANCE,
      sessionId: 'session-s',
      dshAnchor: join(root, 'dsh', 'package.json'),
      profile: 'pi-tui',
      dshVersion: '0.2.1-rc.4',
      targetPackageRoot: target.packageRoot,
      targetEntry: target.entry,
      targetBuildId: target.buildId,
      targetBundleVersion: target.bundleVersion,
    },
  }
}

test('the reexec target must be a real package pinned to the same DSH runtime', t => {
  const root = testLifecycle(t).tempDir('dsh-pr3-target-')
  const packageRoot = join(root, 'package')
  writePackage(packageRoot)
  const target = inspectClientReexecTarget(packageRoot, '0.2.1-rc.4')
  assert.equal(target.packageRoot, realpathSync(packageRoot))
  assert.equal(target.entry, join(realpathSync(packageRoot), 'dist', 'local-client.mjs'))
  assert.equal(target.bundleVersion, '0.5.4-pr3new.1')
  assert.match(target.buildId, /^[0-9a-f]{64}$/u)

  const wrongName = join(root, 'wrong-name')
  writePackage(wrongName, { name: '@xmoon76/dsh-pi-tui-other' })
  assert.throws(() => inspectClientReexecTarget(wrongName, '0.2.1-rc.4'), /not @xmoon76\/dsh-pi-tui/u)

  const wrongPin = join(root, 'wrong-pin')
  writePackage(wrongPin, { dshVersion: '0.2.1-rc.5' })
  assert.throws(() => inspectClientReexecTarget(wrongPin, '0.2.1-rc.4'), /pinned to a different DSH runtime/u)

  const missingEntry = join(root, 'missing-entry')
  writePackage(missingEntry)
  rmSync(join(missingEntry, 'dist', 'local-client.mjs'))
  assert.throws(() => inspectClientReexecTarget(missingEntry, '0.2.1-rc.4'), /has no Client entry/u)

  const symlinkedEntry = join(root, 'symlinked-entry')
  writePackage(symlinkedEntry)
  const outside = join(root, 'outside-entry.mjs')
  writeFileSync(outside, 'export {}\n')
  rmSync(join(symlinkedEntry, 'dist', 'local-client.mjs'))
  symlinkSync(outside, join(symlinkedEntry, 'dist', 'local-client.mjs'))
  assert.throws(() => inspectClientReexecTarget(symlinkedEntry, '0.2.1-rc.4'), /regular file owned by this process user/u)

  assert.throws(() => inspectClientReexecTarget('relative/package', '0.2.1-rc.4'), /must be absolute/u)

  // The production fingerprint is derived from the real payload, so a changed
  // candidate cannot pass the preflight with a stale build identity.
  writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const value = 2\n')
  assert.notEqual(inspectClientReexecTarget(packageRoot, '0.2.1-rc.4').buildId, target.buildId)
})

test('the default reexec target resolves through the active official profile', t => {
  const root = testLifecycle(t).tempDir('dsh-pr3-profile-')
  const profileDir = join(root, 'profile')
  mkdirSync(join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'), { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"fixture-profile","private":true}\n')
  const packageRoot = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
  writePackage(packageRoot)
  const target = resolveProfileInstalledClientTarget(profileDir, '0.2.1-rc.4')
  assert.equal(target.packageRoot, realpathSync(packageRoot))
  assert.equal(target.bundleVersion, '0.5.4-pr3new.1')

  const emptyProfile = join(root, 'empty-profile')
  mkdirSync(emptyProfile, { recursive: true, mode: 0o700 })
  writeFileSync(join(emptyProfile, 'package.json'), '{"name":"empty-profile","private":true}\n')
  assert.throws(
    () => resolveProfileInstalledClientTarget(emptyProfile, '0.2.1-rc.4'),
    /does not resolve the installed @xmoon76\/dsh-pi-tui/u,
  )
})

test('the reexec preflight captures the authoritative Session and refuses an incoherent status', t => {
  const fixture = reexecFixture(t)
  const prepare = (status: LocalClientStatus, overrides: Partial<Parameters<typeof prepareClientReexec>[0]> = {}) =>
    prepareClientReexec({
      status,
      verifiedHostInstanceId: REEXEC_HOST_INSTANCE,
      profileDir: '/profile',
      dshAnchor: fixture.intent.dshAnchor,
      profile: 'pi-tui',
      dshVersion: '0.2.1-rc.4',
      targetPackageRootOverride: fixture.packageRoot,
      ...overrides,
    })
  const intent = prepare(CONNECTED_STATUS)
  assert.equal(intent.expectedInstanceId, REEXEC_HOST_INSTANCE)
  assert.equal(intent.sessionId, 'session-s')
  assert.equal(intent.targetBuildId, fixture.intent.targetBuildId)
  assert.equal(intent.targetEntry, fixture.intent.targetEntry)

  // A sessionless Client is a legal handoff and carries no Session.
  const sessionless = prepare({ ...CONNECTED_STATUS, sessionOpen: false, openSessionId: undefined })
  assert.equal(sessionless.sessionId, undefined)

  // The CURRENT live status owns the Session: a stale launch `startup.sessionId`
  // is never used to invent one, and an open Session always wins.
  const staleStartup = { sessionId: 'startup-stale' }
  assert.equal(prepare({ ...CONNECTED_STATUS, startupFacts: staleStartup }).sessionId, 'session-s')
  assert.equal(prepare({
    ...CONNECTED_STATUS,
    startupFacts: staleStartup,
    sessionOpen: false,
    openSessionId: undefined,
  }).sessionId, undefined)

  assert.throws(() => prepare({ ...CONNECTED_STATUS, transport: 'disconnected' }), /transport is not connected/u)
  assert.throws(() => prepare({ ...CONNECTED_STATUS, surfaceMounted: false }), /surface is not mounted/u)
  assert.throws(() => prepare({ ...CONNECTED_STATUS, host: undefined }), /no authenticated Host identity/u)
  assert.throws(
    () => prepare(CONNECTED_STATUS, { verifiedHostInstanceId: randomUUID() }),
    /not the authenticated Host instance/u,
  )
  assert.throws(
    () => prepare({ ...CONNECTED_STATUS, openSessionId: undefined }),
    /open Session has no authoritative id/u,
  )
})


test('the reexec request latches one intent and keeps a refused Client running', t => {
  const fixture = reexecFixture(t)
  const records: Array<Record<string, unknown>> = []
  let stops = 0
  let prepareCalls = 0
  const handler = createClientReexecRequestHandler({
    status: () => CONNECTED_STATUS,
    prepare: () => {
      prepareCalls += 1
      return fixture.intent
    },
    requestStop: () => { stops += 1 },
    emit: record => { records.push(record) },
  })
  handler.request()
  handler.request()
  assert.equal(handler.intent, fixture.intent)
  assert.equal(prepareCalls, 1, 'a duplicate probe rewrote the one intent')
  assert.equal(stops, 1, 'a duplicate probe requested a second Client stop')
  assert.equal(records.filter(record => record.m4r === 'handoff-requested').length, 1)
  assert.equal(records.filter(record => record.m4r === 'handoff-request-ignored').length, 1)

  // A Client that is not ready yet is an observable no-op, never a stop.
  const notReadyRecords: Array<Record<string, unknown>> = []
  const notReady = createClientReexecRequestHandler({
    status: () => undefined,
    prepare: () => { throw new Error('must not prepare before readiness') },
    requestStop: () => { throw new Error('must not stop before readiness') },
    emit: record => { notReadyRecords.push(record) },
  })
  notReady.request()
  assert.equal(notReady.intent, undefined)
  assert.equal(notReadyRecords.filter(record => record.m4r === 'handoff-request-ignored' && record.reason === 'not-ready').length, 1)

  // A rejected preflight keeps the Client alive and unlatched; a later request
  // may retry, and only the accepted request owns the stop.
  const retryRecords: Array<Record<string, unknown>> = []
  let retryStops = 0
  let rejectFirst = true
  const retry = createClientReexecRequestHandler({
    status: () => CONNECTED_STATUS,
    prepare: () => {
      if (rejectFirst) {
        rejectFirst = false
        throw new Error('local client reexec: the target is invalid')
      }
      return fixture.intent
    },
    requestStop: () => { retryStops += 1 },
    emit: record => { retryRecords.push(record) },
  })
  retry.request()
  assert.equal(retry.intent, undefined)
  assert.equal(retryStops, 0, 'a rejected preflight stopped the live Client')
  assert.equal(retryRecords.filter(record => record.m4r === 'handoff-request-rejected').length, 1)
  retry.request()
  assert.equal(retry.intent, fixture.intent)
  assert.equal(retryStops, 1)

  // A request that races the ONE stop coordinator is an observable no-op: the
  // Client is already releasing its resources and must not record a new intent.
  const stoppingRecords: Array<Record<string, unknown>> = []
  const stopping = createClientReexecRequestHandler({
    status: () => CONNECTED_STATUS,
    prepare: () => fixture.intent,
    requestStop: () => { throw new Error('must not request a second stop') },
    emit: record => { stoppingRecords.push(record) },
    canRequest: () => false,
  })
  stopping.request()
  assert.equal(stopping.intent, undefined)
  assert.equal(stoppingRecords.filter(record => record.m4r === 'handoff-request-ignored' && record.reason === 'stopping').length, 1)
})

test('the replacement Client environment strips old qualification state and carries only handoff facts', t => {
  const fixture = reexecFixture(t)
  const env = createClientReexecChildEnvironment(fixture.intent, {
    PATH: '/bin',
    SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
    SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT: '/side',
    SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
    SPLIT_PROCESS_CLIENT_HMR_FAIL: '1',
    SPLIT_PROCESS_CLIENT_HMR_HOLD: 'surface@/hold',
    SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF: '1',
    SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: '/hold',
    SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY: 'surface@/hold',
    SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START: '/hold',
    SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE: '/hold',
    SPLIT_PROCESS_CLIENT_FORCE_FAILURE: 'client-bootstrap',
    SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL: '1',
    SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE: '1',
    SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1',
    SPLIT_PROCESS_CLIENT_OMIT_COOKIE: '1',
    SPLIT_PROCESS_CLIENT_PRESET: 'preset',
    SPLIT_PROCESS_CLIENT_MODE: 'qualification',
    SPLIT_PROCESS_CLIENT_SESSION: 'stale-session',
    SPLIT_PROCESS_CLIENT_RECORD_FILE: '/record/surface.jsonl',
    SPLIT_PROCESS_DSH_ANCHOR: '/dsh/package.json',
    SPLIT_PROCESS_PROFILE: 'pi-tui',
    SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE: 'client-bootstrap',
  })
  for (const name of [
    'SPLIT_PROCESS_CLIENT_REEXEC_PROBE',
    'SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT',
    'SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE',
    'SPLIT_PROCESS_CLIENT_HMR_PROBE',
    'SPLIT_PROCESS_CLIENT_HMR_FAIL',
    'SPLIT_PROCESS_CLIENT_HMR_HOLD',
    'SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF',
    'SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE',
    'SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY',
    'SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START',
    'SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE',
    'SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL',
    'SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE',
    'SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK',
    'SPLIT_PROCESS_CLIENT_OMIT_COOKIE',
    'SPLIT_PROCESS_CLIENT_PRESET',
  ]) {
    assert.equal(env[name], undefined, `${name} leaked into the replacement Client`)
  }
  assert.equal(env.PATH, '/bin')
  assert.equal(env.SPLIT_PROCESS_CLIENT_MODE, 'surface')
  assert.equal(env.SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID, fixture.intent.expectedInstanceId)
  assert.equal(env.SPLIT_PROCESS_CLIENT_SESSION, 'session-s')
  assert.equal(env.SPLIT_PROCESS_CLIENT_RECORD_FILE, '/record/surface.jsonl')
  assert.equal(env.SPLIT_PROCESS_DSH_ANCHOR, fixture.intent.dshAnchor)
  assert.equal(env.SPLIT_PROCESS_PROFILE, 'pi-tui')
  // The test-only child failure injection is delivered ONLY to this child.
  assert.equal(env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE, 'client-bootstrap')

  const plain = createClientReexecChildEnvironment(
    { ...fixture.intent, sessionId: undefined },
    { SPLIT_PROCESS_CLIENT_SESSION: 'stale-session', SPLIT_PROCESS_CLIENT_FORCE_FAILURE: 'client-bootstrap' },
  )
  assert.equal(plain.SPLIT_PROCESS_CLIENT_FORCE_FAILURE, undefined, 'an old Client fault injection was inherited')
  assert.equal(plain.SPLIT_PROCESS_CLIENT_SESSION, undefined, 'a stale Session intent was inherited')
})

test('the shutdown tail closes the seat before spawning and propagates the replacement exit', async t => {
  const fixture = reexecFixture(t)
  const order: string[] = []
  const records: Array<Record<string, unknown>> = []
  const code = await finishClientEntryShutdown({
    seat: { close: async () => { order.push('seat-close') } },
    reexec: { intent: fixture.intent, teardownSucceeded: true },
    emit: record => { records.push(record) },
    stderr: line => { order.push(`stderr:${line}`) },
    spawnChild: async (entry, env) => {
      order.push('spawn')
      assert.equal(entry, fixture.intent.targetEntry)
      assert.equal(env.SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID, fixture.intent.expectedInstanceId)
      assert.equal(env.SPLIT_PROCESS_CLIENT_MODE, 'surface')
      return { code: 7, signal: null }
    },
  })
  assert.equal(code, 7)
  assert.deepEqual(order, ['seat-close', 'spawn'], 'the replacement Client spawned before the seat closed')
  assert.equal(records.filter(record => record.m4r === 'handoff-parent-exit').length, 1)

  const signaled = await finishClientEntryShutdown({
    seat: { close: async () => {} },
    reexec: { intent: fixture.intent, teardownSucceeded: true },
    emit: record => { records.push(record) },
    stderr: () => {},
    spawnChild: async () => ({ code: null, signal: 'SIGTERM' }),
  })
  assert.equal(signaled, 128 + 15, 'a signaled replacement Client must surface as a signal exit status')
})

test('a failed seat close or teardown never spawns a replacement Client', async t => {
  const fixture = reexecFixture(t)
  let spawned = 0
  const records: Array<Record<string, unknown>> = []
  const seatFailure = await finishClientEntryShutdown({
    seat: { close: async () => { throw new Error('seat close exploded') } },
    reexec: { intent: fixture.intent, teardownSucceeded: true },
    emit: record => { records.push(record) },
    stderr: () => {},
    spawnChild: async () => { spawned += 1; return { code: 0, signal: null } },
  })
  assert.equal(seatFailure, 1)
  assert.equal(spawned, 0, 'a failed seat close still spawned C1')
  assert.equal(records.filter(record => record.m4a0 === 'cleanup-failure' && record.step === 'client-seat').length, 1)
  assert.equal(records.filter(record => record.m4r === 'handoff-failed' && record.phase === 'teardown').length, 1)

  const teardownFailure = await finishClientEntryShutdown({
    seat: { close: async () => {} },
    reexec: { intent: fixture.intent, teardownSucceeded: false },
    emit: record => { records.push(record) },
    stderr: () => {},
    spawnChild: async () => { spawned += 1; return { code: 0, signal: null } },
  })
  assert.equal(teardownFailure, 1)
  assert.equal(spawned, 0, 'an incomplete Client teardown still spawned C1')
})

test('a failed Client seat close stays a nonzero normal exit without a replacement', async () => {
  const records: Array<Record<string, unknown>> = []
  const code = await finishClientEntryShutdown({
    seat: { close: async () => { throw new Error('seat close exploded') } },
    emit: record => { records.push(record) },
    stderr: () => {},
  })
  assert.equal(code, 1, 'a seat close failure must stay a nonzero exit even without a reexec')
  assert.equal(records.filter(record => record.m4a0 === 'cleanup-failure' && record.step === 'client-seat').length, 1)
})

test('a replacement package that changed after the preflight is refused without spawning', async t => {
  const fixture = reexecFixture(t)
  let spawned = 0
  const stderr: string[] = []
  writeFileSync(join(fixture.packageRoot, 'dist', 'index.mjs'), 'export const value = 9\n')
  const records: Array<Record<string, unknown>> = []
  const code = await finishClientEntryShutdown({
    seat: { close: async () => {} },
    reexec: { intent: fixture.intent, teardownSucceeded: true },
    emit: record => { records.push(record) },
    stderr: line => { stderr.push(line) },
    spawnChild: async () => { spawned += 1; return { code: 0, signal: null } },
  })
  assert.equal(code, 1)
  assert.equal(spawned, 0, 'a changed target package was spawned')
  assert.equal(records.filter(record => record.m4r === 'handoff-failed' && record.phase === 'target').length, 1)
  assert.match(stderr.join('\n'), /changed between the preflight and the spawn/u)
  assert.doesNotMatch(stderr.join('\n'), /\/home\/|\/tmp\/|\/proc\//u)
})

test('a failing spawn is visible, nonzero and leaves no second Client owner', async t => {
  const fixture = reexecFixture(t)
  const stderr: string[] = []
  const records: Array<Record<string, unknown>> = []
  const code = await finishClientEntryShutdown({
    seat: { close: async () => {} },
    reexec: { intent: fixture.intent, teardownSucceeded: true },
    emit: record => { records.push(record) },
    stderr: line => { stderr.push(line) },
    spawnChild: async () => { throw new Error('spawn /private/place ENOENT') },
  })
  assert.equal(code, 1)
  assert.equal(records.filter(record => record.m4r === 'handoff-failed' && record.phase === 'spawn').length, 1)
  assert.match(stderr.join('\n'), /Start a compatible Client manually/u)
  assert.doesNotMatch(stderr.join('\n'), /\/private\/place|ENOENT|\bpid\b|cookie|token/iu,
    'the visible handoff failure leaked a private spawn detail')
})

test('a handoff failure line is concise, actionable and never leaks paths, PIDs or credentials', () => {
  const unavailable = handoffStartupFailureLine(
    new LocalScopeError('HOST_HANDOFF_UNAVAILABLE', 'local discovery: the expected Host is no longer available for Client handoff'),
  )
  assert.match(unavailable, /^Client handoff failed: the expected Host is no longer available\./u)
  assert.match(unavailable, /The Host was not stopped or replaced\./u)
  assert.match(unavailable, /Start a compatible Client manually to continue\./u)

  const mismatch = handoffStartupFailureLine(
    new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: the live Host is not the expected handoff instance'),
  )
  assert.match(mismatch, /not the expected instance/u)

  const protocol = handoffStartupFailureLine(
    new LocalScopeError('HOST_PROTOCOL_INCOMPATIBLE', 'local discovery: the live Host uses a different local protocol or DSH runtime'),
  )
  assert.match(protocol, /different local protocol or DSH runtime/u)

  const session = handoffStartupFailureLine(new Error('local client entry: the official Session history open failed'))
  assert.match(session, /official Session history open failed/u)

  const arbitrary = handoffStartupFailureLine(new Error('spawn /home/private/profile/node ENOENT'))
  assert.doesNotMatch(arbitrary, /\/home\/private|ENOENT|spawn/iu)
  for (const line of [unavailable, mismatch, protocol, session, arbitrary]) {
    assert.doesNotMatch(line, /cookie|connectUrl|token|\/proc\/|\bpid\b|\/home\/|\/tmp\//iu)
  }
})

test('the reexec trigger is internal, singular and starts only after the ONE seat close', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'app', 'remote-process', 'local-client-entry.ts'),
    'utf8',
  )
  assert.match(source, /if \(process\.env\.SPLIT_PROCESS_CLIENT_REEXEC_PROBE === '1'\)/u)
  assert.match(source, /process\.on\('SIGUSR2', \(\) => \{ reexecHandler\?\.request\(\) \}\)/u)
  assert.equal((source.match(/\bspawn\(process\.execPath/gu) ?? []).length, 1, 'the entry must own exactly one replacement spawn')
  const finishSource = source.slice(
    source.indexOf('export async function finishClientEntryShutdown'),
    source.indexOf('function expectedHostInstanceFromEnvironment'),
  )
  assert.ok(finishSource.indexOf('await options.seat.close()') >= 0)
  assert.ok(
    finishSource.indexOf('await options.seat.close()') < finishSource.indexOf('await spawnChild('),
    'the replacement Client must not spawn before the Client seat close',
  )
  assert.match(source, /expectedInstanceId: expectedHostInstanceId/u,
    'the handoff Client must pass the expected instance into discovery')
  assert.match(source, /spawn\(process\.execPath, \[entry\], \{/u,
    'the replacement argv must carry only the real installed entry')
})

/** Run one assertion block with the exact SIGUSR2/handoff environment. */
function withHandoffEnvironment(
  values: Readonly<Record<string, string | undefined>>,
  run: () => void,
): void {
  const names = [
    'SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID',
    'SPLIT_PROCESS_CLIENT_REEXEC_PROBE',
    'SPLIT_PROCESS_CLIENT_HMR_PROBE',
    'SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF',
    'SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE',
  ]
  const before = new Map(names.map(name => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) process.env[name] = value
    }
    run()
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('the handoff expectation is a surface-only UUID and rejects every SIGUSR2 conflict', () => {
  withHandoffEnvironment({}, () => {
    assert.equal(expectedHostInstanceFromEnvironment('surface'), undefined)
    assert.doesNotThrow(() => assertHandoffSignalExclusivity('surface', undefined))
  })
  withHandoffEnvironment({ SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: REEXEC_HOST_INSTANCE }, () => {
    assert.equal(expectedHostInstanceFromEnvironment('surface'), REEXEC_HOST_INSTANCE)
    assert.throws(
      () => expectedHostInstanceFromEnvironment('qualification'),
      /requires surface mode/u,
    )
  })
  withHandoffEnvironment({ SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: 'not-a-uuid' }, () => {
    assert.throws(() => expectedHostInstanceFromEnvironment('surface'), /Host instance UUID/u)
  })
  withHandoffEnvironment({ SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1' }, () => {
    assert.doesNotThrow(() => assertHandoffSignalExclusivity('surface', undefined))
    assert.throws(() => assertHandoffSignalExclusivity('qualification', undefined), /requires surface mode/u)
  })
  for (const [name, value] of [
    ['SPLIT_PROCESS_CLIENT_HMR_PROBE', '1'],
    ['SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF', '1'],
    ['SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE', '/hold'],
  ] as const) {
    withHandoffEnvironment({ SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1', [name]: value }, () => {
      assert.throws(
        () => assertHandoffSignalExclusivity('surface', undefined),
        /mutually exclusive with the HMR\/private-RPC\/T34 SIGUSR2 modes/u,
      )
    })
  }
  withHandoffEnvironment({
    SPLIT_PROCESS_CLIENT_REEXEC_PROBE: '1',
    SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: REEXEC_HOST_INSTANCE,
  }, () => {
    assert.throws(
      () => assertHandoffSignalExclusivity('surface', REEXEC_HOST_INSTANCE),
      /reexec probe and the handoff expectation are mutually exclusive/u,
    )
  })
  withHandoffEnvironment({
    SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
    SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID: REEXEC_HOST_INSTANCE,
  }, () => {
    assert.throws(
      () => assertHandoffSignalExclusivity('surface', REEXEC_HOST_INSTANCE),
      /may not inherit another SIGUSR2 qualification mode/u,
    )
  })
})
