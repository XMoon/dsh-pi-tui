/**
 * Split-process business qualification: the real authenticated Host transport,
 * the official HTTP/WebSocket admission fence, Workspace Remote ownership and
 * the qualification Client transport lifecycle.
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  assertClientHostMatchesPublished,
  assertNoSecret,
  assertPublishedHostMatchesKernel,
  assertWitnessIdentityLive,
  closeMuxSocket,
  exchangeCookie,
  muxAttempt,
  muxSocketClosed,
  muxSocketOpen,
  openMuxSocket,
  rawHttpRequest,
  readAuthenticatedIdentity,
  readScopeFiles,
} from '../../../support/split-process-authentication.ts'
import {
  createSplitProcessScene,
  type DiscoveryRefusal,
  type QualificationClientHandle,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

function expectSameBytes(actualPath: string, expected: Buffer, label: string): void {
  const actual = readFileSync(actualPath)
  expect(actual.length === expected.length && actual.equals(expected), `${label}: the bytes changed`).toBe(true)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  await waitForValue(async () => (await predicate()) ? true : undefined, label, timeoutMs)
}

async function waitForValue<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 120_000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: timed out after ${String(timeoutMs)}ms`)
    await sleep(50)
  }
}

/** A genuinely closed loopback port: never a random external endpoint. */
async function closedLoopbackOrigin(): Promise<string> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the loopback listener has no port')
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return `http://127.0.0.1:${String(address.port)}`
}

interface PrivateFileSnapshot {
  bytes: Buffer
  mode: number
}

function savePrivateFile(path: string): PrivateFileSnapshot {
  return { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }
}

function restorePrivateFile(path: string, snapshot: PrivateFileSnapshot): void {
  writeFileSync(path, snapshot.bytes, { mode: snapshot.mode })
  chmodSync(path, snapshot.mode)
}

function writePrivateJson(path: string, value: Record<string, any>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function waitForWatchCount(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  expected: number,
  label: string,
): Promise<void> {
  await waitFor(async () => {
    const status = await scene.hostStatus(host)
    return status.terminalProgressWatches === expected
  }, label)
}

function workspaceRequestEnvelope(relativePath: string): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: 'workspace-admission',
    method: 'workspace/create',
    payload: { args: { request: { path: relativePath } } },
  })
}

async function assertAuthenticatedHost(scene: SplitProcessScene, host: SplitProcessHostHandle): Promise<string> {
  const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
  assertPublishedHostMatchesKernel(files.registry as never, 'the published registry')
  const cookie = await exchangeCookie(host.ready.localHost.origin, files.launch)
  const identity = await readAuthenticatedIdentity(host.ready.localHost.origin, cookie, 'the authenticated identity')
  assertClientHostMatchesPublished(identity.identity as never, files.registry as never, 'the authenticated identity')
  return cookie
}

async function waitForFrame(
  client: SplitProcessClient,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: the current frame never showed ${JSON.stringify(text)}; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForFrameGone(
  client: SplitProcessClient,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (!frame.includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} stayed on the current frame for ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

test('authenticates the installed Host and rejects unauthenticated HTTP and duplicate mux peers', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const [client] = await scene.startQualificationClients({ mode: 'attach' })
    const ready = await scene.waitEntryRecord(client!, { m4a0: 'ready' })
    expect(ready.transport).toBe('connected')
    expect(ready.surfaceMounted).toBe(false)
    expect(ready.sessionOpen).toBe(false)
    expect(Number.isInteger(ready.generationId)).toBe(true)
    expect(ready.host.hostPid).toBe(host.ready.localHost.hostPid)
    assertClientHostMatchesPublished(ready.host as never, host.ready.localHost as never, 'the qualification Client ready')

    const origin = host.ready.localHost.origin
    const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    expect(statSync(files.scopeDir).mode & 0o777).toBe(0o700)
    expect(files.registryMode).toBe(0o600)
    expect(files.launchMode).toBe(0o600)
    const token = new URL(files.launch.connectUrl).searchParams.get('token')
    expect(typeof token).toBe('string')
    expect(files.launch.instanceId).toBe(files.registry.instanceId)
    expect(files.launch.schema).toBe(1)
    const launchText = readFileSync(files.launchPath, 'utf8')
    const registryText = readFileSync(files.registryPath, 'utf8')
    expect(launchText.includes(String(host.ready.localHost.instanceId))).toBe(true)
    for (const forbidden of ['token', 'connectUrl', 'cookie']) {
      expect(registryText.includes(forbidden)).toBe(false)
    }

    // The official admission fence on the identity route.
    const noToken = await rawHttpRequest(origin, { path: '/connect' })
    expect(noToken.status).toBe(401)
    expect(Boolean(noToken.headers['set-cookie'])).toBe(false)
    const wrongToken = await rawHttpRequest(origin, { path: '/connect?token=deadbeef&interactions=answer' })
    expect(wrongToken.status).toBe(401)
    const fakeCookie = await rawHttpRequest(origin, {
      path: '/api/pi-tui.local-host',
      headers: { cookie: 'dsh_session=deadbeef' },
    })
    expect(fakeCookie.status).toBe(401)
    const wrongHost = await rawHttpRequest(origin, {
      path: '/api/pi-tui.local-host',
      headers: { host: 'evil.example' },
    })
    expect(wrongHost.status).toBe(403)
    const wrongOrigin = await rawHttpRequest(origin, {
      path: '/api/pi-tui.local-host',
      headers: { origin: 'http://evil.example' },
    })
    expect(wrongOrigin.status).toBe(403)
    const unauthenticated = await rawHttpRequest(origin, { path: '/api/pi-tui.local-host' })
    expect([401, 403]).toContain(unauthenticated.status)
    expect(unauthenticated.body.includes(String(files.registry.instanceId))).toBe(false)

    const validCookie = await exchangeCookie(origin, files.launch)
    const identity = await readAuthenticatedIdentity(origin, validCookie, 'the authenticated identity')
    assertClientHostMatchesPublished(identity.identity as never, files.registry as never, 'the authenticated identity')
    assertNoSecret(JSON.stringify(await scene.entryRecords(client!)), [String(token), validCookie], 'the Client records')

    // The SAME fence must protect the official Workspace Remote namespace.
    const workspaceRoute = '/api/workspace/create'
    const workspaceEnvelope = workspaceRequestEnvelope('split-process/relative-not-absolute')
    const unauthenticatedWorkspace = await rawHttpRequest(origin, {
      path: workspaceRoute,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: workspaceEnvelope,
    })
    expect([401, 403]).toContain(unauthenticatedWorkspace.status)
    const fakeCookieWorkspace = await rawHttpRequest(origin, {
      path: workspaceRoute,
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'dsh_session=deadbeef' },
      body: workspaceEnvelope,
    })
    expect(fakeCookieWorkspace.status).toBe(401)
    const wrongOriginWorkspace = await rawHttpRequest(origin, {
      path: workspaceRoute,
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: workspaceEnvelope,
    })
    expect(wrongOriginWorkspace.status).toBe(403)
    for (const refused of [unauthenticatedWorkspace, fakeCookieWorkspace, wrongOriginWorkspace]) {
      expect(refused.body.includes('workspace/invalid-path')).toBe(false)
    }
    const ownerWorkspace = await rawHttpRequest(origin, {
      path: workspaceRoute,
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: validCookie },
      body: workspaceEnvelope,
    })
    expect(ownerWorkspace.status).toBe(200)
    const ownerEnvelope = JSON.parse(ownerWorkspace.body) as Record<string, any>
    expect(ownerEnvelope.result?.ok).toBe(false)
    expect(ownerEnvelope.result?.error?.code).toBe('workspace/invalid-path')

    // The real mux peer admission: one live socket, a duplicate refused with
    // 409, and the released slot refused while the generation is retiring.
    const profilePackage = join(scene.installation.profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    const first = await openMuxSocket(profilePackage, origin, validCookie)
    try {
      const duplicate = await muxAttempt(profilePackage, origin, validCookie)
      expect(duplicate.opened).toBe(false)
      expect(duplicate.status).toBe(409)
      expect(muxSocketOpen(profilePackage, first)).toBe(true)
      closeMuxSocket(profilePackage, first)
      await waitFor(async () => muxSocketClosed(profilePackage, first), 'the first mux socket close')
      await waitFor(async () => {
        const attempt = await muxAttempt(profilePackage, origin, validCookie)
        if (attempt.opened) {
          // A re-opened slot after the release is a failure, never a retry.
          if (attempt.socket !== undefined) closeMuxSocket(profilePackage, attempt.socket)
          throw new Error('the released mux slot was reopened instead of refused')
        }
        if (attempt.status === 401) return true
        if (attempt.status === 409) return false
        throw new Error(`the third mux attempt returned ${String(attempt.status)}`)
      }, 'the released mux slot to be refused', 30_000)
    } finally {
      if (!muxSocketClosed(profilePackage, first)) closeMuxSocket(profilePackage, first)
    }

    const clientExit = await scene.finishEntry(client!)
    expect(clientExit.exit).toEqual({ code: 0, signal: null })
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the transport authentication test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the transport authentication test passed but its Scene cleanup failed')
    }
  }
})

test('preserves official Remote ownership across watch release, carrier replacement and Client detach', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const workspacePath = join(scene.workDir, 'host-foundation-workspace')
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
    const canonicalWorkspace = realpathSync(workspacePath)
    const hostEntriesBefore = host.ready.entries as Array<{ id: string; fiberUid?: number }>
    const workspaceFiber = hostEntriesBefore.find(entry => entry.id === 'workspace-controller')?.fiberUid
    const registryFiber = hostEntriesBefore.find(entry => entry.id === 'workspace')?.fiberUid
    expect(typeof workspaceFiber).toBe('number')
    expect(typeof registryFiber).toBe('number')

    const [client] = await scene.startQualificationClients({ mode: 'attach', foundationBarrier: true })
    await scene.waitEntryRecord(client!, { m4a0: 'ready' })
    await expect(scene.request('START_QUALIFICATION_CLIENTS', { mode: 'attach', foundationBarrier: 'yes' }))
      .rejects.toThrow(/foundationBarrier must be the boolean true/u)
    await expect(scene.request('QUALIFICATION_CLIENT_CONTROL', {
      entryId: client!.entryId,
      control: { op: 'qualification-host-foundation', requestId: 'unsafe-workspace', workspacePath: '/tmp/outside' },
    })).rejects.toThrow(/must be a contained Scene path/u)
    await expect(scene.request('QUALIFICATION_CLIENT_CONTROL', {
      entryId: client!.entryId,
      control: { op: 'shutdown' },
    })).rejects.toThrow(/unsupported op/u)
    await expect(scene.request('QUALIFICATION_CLIENT_CONTROL', {
      entryId: client!.entryId,
      control: { op: 'qualification-drop-websocket', requestId: '../bad' },
    })).rejects.toThrow(/business requestId/u)
    await expect(scene.request('QUALIFICATION_CLIENT_CONTROL', {
      entryId: client!.entryId,
      control: { op: 'qualification-host-foundation', requestId: 'resume-without-path', workspaceResume: true },
    })).rejects.toThrow(/workspaceResume requires workspacePath/u)
    await expect(scene.request('SIGNAL_ENTRY', { entryId: client!.entryId, signal: 'SIGUSR1' }))
      .rejects.toThrow(/unsupported signal/u)
    await expect(scene.request('WAIT_ENTRY_RECORD', {
      entryId: client!.entryId,
      match: { predicate: 'not-allowed' },
    })).rejects.toThrow(/rejects that record match shape/u)
    const control = (requestId: string, extras: Record<string, any>) =>
      scene.qualificationControl(client!, {
        op: 'qualification-host-foundation',
        requestId,
        workspacePath: canonicalWorkspace,
        ...extras,
      })

    // First proof: the real watch is open on the Host before the barrier is
    // released; the generation-resume control then drops the physical carrier.
    await control('host-foundation-first-1', { workspaceResume: true, schedule: true })
    await scene.waitEntryRecord(client!, { m4b2hf: 'host-rpc-watch-open', requestId: 'host-foundation-first-1' })
    await waitForWatchCount(scene, host, 1, 'the live Host terminal-progress watch')
    scene.releaseBarrier(client!, 'foundation')
    const proof = await scene.waitEntryRecord(client!, { m4b2hf: 'host-rpc-proof', requestId: 'host-foundation-first-1' })
    expect(proof.hostPid).toBe(host.ready.localHost.hostPid)
    expect(proof.hostInstanceId).toBe(host.ready.localHost.instanceId)
    expect(proof.clientPid).toBe(client!.pid)
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned',
      'workspaceRemote', 'workspaceBaseline', 'workspaceGenerationAdvanced',
      'workspaceHeldStreamClosed', 'workspaceRestoredBaseline',
      'scheduleRemote', 'scheduleCatalog', 'scheduleCreate', 'scheduleEdit', 'scheduleDeleted',
      'scheduleReconnectCatalog']) {
      expect(proof[field], `the Host foundation proof field ${field}`).toBe(true)
    }
    expect(proof.workspaceCreated).toBe(true)
    expect(proof.workspaceInBaseline).toBe(false)
    expect(proof.workspaceUpsert).toBe(true)
    expect(proof.workspaceIdempotent).toBe(true)
    expect(typeof proof.workspaceId).toBe('string')
    expect(proof.workspaceId.length).toBeGreaterThan(0)
    expect(proof.workspacePath).toBe(canonicalWorkspace)
    await waitForWatchCount(scene, host, 0, 'the released Host watch')

    // A repeat probe on the SAME Client must not create a second Workspace.
    await control('host-foundation-repeat-2', {})
    const repeat = await scene.waitEntryRecord(client!, { m4b2hf: 'host-rpc-proof', requestId: 'host-foundation-repeat-2' })
    expect(repeat.hostPid).toBe(host.ready.localHost.hostPid)
    expect(repeat.hostInstanceId).toBe(host.ready.localHost.instanceId)
    expect(repeat.clientPid).toBe(client!.pid)
    expect(repeat.workspaceCreated).toBe(false)
    expect(repeat.workspaceInBaseline).toBe(true)
    expect(repeat.workspaceId).toBe(proof.workspaceId)
    expect(repeat.workspacePath).toBe(canonicalWorkspace)
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      expect(repeat[field]).toBe(true)
    }
    await waitForWatchCount(scene, host, 0, 'the repeat Host watch')

    const clientExit = await scene.finishEntry(client!)
    expect(clientExit.exit).toEqual({ code: 0, signal: null })
    const hostStatus = await scene.hostStatus(host)
    expect(hostStatus.localHost.hostPid).toBe(host.ready.localHost.hostPid)
    expect(hostStatus.localHost.instanceId).toBe(host.ready.localHost.instanceId)
    expect(hostStatus.rootFiberUid).toBe(host.ready.rootFiberUid)
    expect(hostStatus.services.piTuiHostReady).toBe(true)

    // A NEW qualification Client must see the same Workspace baseline without
    // re-mounting the Host rows.
    const [next] = await scene.startQualificationClients({ mode: 'attach' })
    await scene.waitEntryRecord(next!, { m4a0: 'ready' })
    await scene.qualificationControl(next!, {
      op: 'qualification-host-foundation',
      requestId: 'host-foundation-detach-3',
      workspacePath: canonicalWorkspace,
    })
    const detached = await scene.waitEntryRecord(next!, { m4b2hf: 'host-rpc-proof', requestId: 'host-foundation-detach-3' })
    expect(detached.hostPid).toBe(host.ready.localHost.hostPid)
    expect(detached.hostInstanceId).toBe(host.ready.localHost.instanceId)
    expect(detached.workspaceCreated).toBe(false)
    expect(detached.workspaceInBaseline).toBe(true)
    expect(detached.workspaceId).toBe(proof.workspaceId)
    expect(detached.workspacePath).toBe(canonicalWorkspace)
    const afterStatus = await scene.hostStatus(host)
    const afterWorkspaceFiber = (afterStatus.entries as Array<{ id: string; fiberUid?: number }>)
      .find(entry => entry.id === 'workspace-controller')?.fiberUid
    const afterRegistryFiber = (afterStatus.entries as Array<{ id: string; fiberUid?: number }>)
      .find(entry => entry.id === 'workspace')?.fiberUid
    expect(afterWorkspaceFiber).toBe(workspaceFiber)
    expect(afterRegistryFiber).toBe(registryFiber)
    await waitForWatchCount(scene, host, 0, 'the detached Client Host watch')
    const nextExit = await scene.finishEntry(next!)
    expect(nextExit.exit).toEqual({ code: 0, signal: null })
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the Remote ownership test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the Remote ownership test passed but its Scene cleanup failed')
    }
  }
})

test('replaces dropped transport generations without retaining wrappers or sockets', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const hostPid = host.ready.localHost.hostPid
    const hostInstanceId = host.ready.localHost.instanceId
    const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    const [client] = await scene.startQualificationClients({ mode: 'attach' })
    await scene.waitEntryRecord(client!, { m4a0: 'ready' })
    const baseline = await scene.entryStatus(client!)
    expect(baseline.transport).toBe('connected')
    expect(baseline.activeWrappers).toBe(1)
    expect(baseline.liveSockets).toBe(1)
    let generation = Number(baseline.generationId)
    expect(Number.isInteger(generation)).toBe(true)

    // The historical real drop strength (36 carrier losses) is preserved, but
    // each loop proves the actual cleared generation and its strictly advanced
    // replacement, not merely a counter.
    for (let cycle = 1; cycle <= 36; cycle += 1) {
      const requestId = `drop-generation-${String(cycle)}`
      await scene.qualificationControl(client!, { op: 'qualification-drop-websocket', requestId })
      await scene.waitEntryRecord(client!, { m4a0: 'qualification', op: 'drop-websocket', requestId })
      await waitFor(async () => {
        const status = await scene.entryStatus(client!)
        return status.transport !== 'connected' && status.generationId === undefined
      }, `the dropped generation ${String(cycle)} to clear its transport and generation identity`, 30_000)
      const replaced = await waitForValue(async () => {
        const status = await scene.entryStatus(client!)
        return status.transport === 'connected'
          && Number.isInteger(status.generationId)
          && status.generationId > generation
          ? status
          : undefined
      }, `the replacement generation after drop ${String(cycle)}`, 60_000)
      expect(replaced.activeWrappers).toBe(1)
      expect(replaced.liveSockets).toBe(1)
      expect(replaced.host?.instanceId, `drop ${String(cycle)}: the replacement echoed another Host`).toBe(hostInstanceId)
      expect(replaced.host?.hostPid, `drop ${String(cycle)}: the replacement echoed another Host PID`).toBe(hostPid)
      generation = Number(replaced.generationId)
    }

    // The long-lived Client's qualification seat is released before the next
    // single-seat Client starts.
    const clientExit = await scene.finishEntry(client!)
    expect(clientExit.exit).toEqual({ code: 0, signal: null })

    // A retryable refresh interruption on the SAME Host is not a fatal exit.
    const [retryable] = await scene.startQualificationClients({ mode: 'refresh-unresponsive-once' })
    await scene.waitEntryRecord(retryable!, { m4a0: 'ready' })
    const retryableBaseline = await scene.entryStatus(retryable!)
    expect(retryableBaseline.activeWrappers).toBe(1)
    expect(retryableBaseline.liveSockets).toBe(1)
    await scene.qualificationControl(retryable!, { op: 'qualification-drop-websocket', requestId: 'retryable-drop' })
    await waitFor(async () => {
      const status = await scene.entryStatus(retryable!)
      return status.transport !== 'connected' && status.generationId === undefined
    }, 'the retryable refresh actual interruption and cleared generation', 30_000)
    const recovered = await waitForValue(async () => {
      const status = await scene.entryStatus(retryable!)
      return status.transport === 'connected'
        && Number.isInteger(status.generationId)
        && status.generationId > retryableBaseline.generationId
        ? status
        : undefined
    }, 'the retryable refresh replacement generation', 90_000)
    expect(recovered.activeWrappers).toBe(1)
    expect(recovered.liveSockets).toBe(1)
    expect(recovered.host?.instanceId, 'the retryable replacement echoed another Host').toBe(hostInstanceId)
    expect(recovered.host?.hostPid, 'the retryable replacement echoed another Host PID').toBe(hostPid)
    const retryableExit = await scene.finishEntry(retryable!)
    expect(retryableExit.exit).toEqual({ code: 0, signal: null })

    // A fatal identity change during the SAME refresh path must exit 1, never
    // keep retrying or replace the live Host.
    const [fatal] = await scene.startQualificationClients({ mode: 'identity-changed' })
    await scene.waitEntryRecord(fatal!, { m4a0: 'ready' })
    const launchSnapshot = savePrivateFile(files.launchPath)
    const launch = JSON.parse(launchSnapshot.bytes.toString('utf8')) as Record<string, any>
    try {
      writePrivateJson(files.launchPath, { ...launch, instanceId: randomUUID() })
      await scene.qualificationControl(fatal!, { op: 'qualification-drop-websocket', requestId: 'identity-change-drop' })
      const failure = await scene.waitEntryRecord(fatal!, { m4a0: 'failure' })
      expect(failure.code).toBe('HOST_IDENTITY_MISMATCH')
      const fatalTerminal = await scene.finishEntry(fatal!)
      expect(fatalTerminal.exit).toEqual({ code: 1, signal: null })
      expect(fatalTerminal.cleanupCompleted).toBe(1)
    } finally {
      restorePrivateFile(files.launchPath, launchSnapshot)
    }

    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost.instanceId).toBe(host.ready.localHost.instanceId)
    expect(statusAfter.localHost.hostPid).toBe(host.ready.localHost.hostPid)
    const [reattached] = await scene.startQualificationClients({ mode: 'attach' })
    const reattachedReady = await scene.waitEntryRecord(reattached!, { m4a0: 'ready' })
    expect(reattachedReady.host.instanceId).toBe(host.ready.localHost.instanceId)
    await scene.finishEntry(reattached!)
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the transport generation test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the transport generation test passed but its Scene cleanup failed')
    }
  }
})

test('settles qualification Client startup and exit failures without taking down the authenticated Host', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    const registrySnapshot = savePrivateFile(files.registryPath)
    const launchSnapshot = savePrivateFile(files.launchPath)
    const hostPid = host.ready.localHost.hostPid
    const hostInstanceId = host.ready.localHost.instanceId
    const assertHostUnchanged = async (): Promise<void> => {
      const status = await scene.hostStatus(host)
      expect(status.localHost.hostPid).toBe(hostPid)
      expect(status.localHost.instanceId).toBe(hostInstanceId)
      expect(status.services.piTuiHostReady).toBe(true)
    }
    const runFailureClient = async (
      mode: 'omit-cookie' | 'startup-fatal' | 'bootstrap-failure',
      expectedCode: string | null,
    ): Promise<Record<string, any>> => {
      const [client] = await scene.startQualificationClients({ mode })
      const failure = await scene.waitEntryRecord(client!, { m4a0: 'failure' })
      if (expectedCode !== null) expect(failure.code).toBe(expectedCode)
      const terminal = await scene.finishEntry(client!)
      expect(terminal.exit).toEqual({ code: 1, signal: null })
      await assertHostUnchanged()
      const facts = await scene.entryRecordFacts(client!)
      expect(facts.records.some(record => record.m4a0 === 'ready')).toBe(false)
      const failureRecords = facts.records.filter(record => record.m4a0 === 'failure')
      const cleanupRecords = facts.records.filter(record => record.m4a0 === 'cleanup')
      const cleanupFailures = facts.records.filter(record => record.m4a0 === 'cleanup-failure')
      expect(failureRecords, `${mode}: exactly one failure record`).toHaveLength(1)
      expect(cleanupRecords, `${mode}: exactly one completed cleanup record`)
        .toHaveLength(1)
      expect(cleanupRecords[0]?.status, `${mode}: the cleanup outcome is not completed`).toBe('completed')
      expect(cleanupFailures, `${mode}: cleanup-failure cannot be treated as clean success`).toHaveLength(0)
      return { failure, terminal }
    }

    await runFailureClient('omit-cookie', 'HOST_UNRESPONSIVE')
    await runFailureClient('startup-fatal', 'HOST_IDENTITY_MISMATCH')
    const bootstrap = await runFailureClient('bootstrap-failure', null)
    expect(bootstrap.failure.phase).toBe('after-context')
    expect(bootstrap.failure.activeWrappers).toBe(0)
    expect(bootstrap.failure.liveSockets).toBe(0)
    const bootstrapRecords = bootstrap.terminal.records as Record<string, any>[]
    expect(bootstrapRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed')).toBe(true)
    expect(bootstrapRecords.some(record => record.m4a0 === 'cleanup-failure')).toBe(false)

    // The real installed Client bootstrap chunk drifts; the Client still
    // authenticates to the SAME Host because buildId is not a Client gate.
    const drift = await scene.setInstallationFault('client-bootstrap-drift')
    try {
      expect(drift.buildIdAfter).not.toBe(drift.buildIdBefore)
      const [drifted] = await scene.startQualificationClients({ mode: 'client-bootstrap-drift' })
      const driftedReady = await scene.waitEntryRecord(drifted!, { m4a0: 'ready' })
      expect(driftedReady.transport).toBe('connected')
      expect(driftedReady.host.instanceId).toBe(hostInstanceId)
      expect(driftedReady.host.hostPid).toBe(hostPid)
      const driftedExit = await scene.finishEntry(drifted!)
      expect(driftedExit.exit).toEqual({ code: 0, signal: null })
      await assertHostUnchanged()
    } finally {
      await scene.restoreInstallation()
    }
    expectSameBytes(files.registryPath, registrySnapshot.bytes, 'the restored registry')
    expectSameBytes(files.launchPath, launchSnapshot.bytes, 'the restored launch')

    // Exact owned qualification Client signals: SIGKILL and SIGTERM are
    // different terminals and never take the Host down.
    const [killed] = await scene.startQualificationClients({ mode: 'attach' })
    await scene.waitEntryRecord(killed!, { m4a0: 'ready' })
    await scene.signalEntry(killed!, 'SIGKILL')
    const killedTerminal = await scene.finishEntry(killed!)
    expect(killedTerminal.outcome).toBe('signal')
    expect(killedTerminal.exit).toEqual({ code: null, signal: 'SIGKILL' })
    await assertHostUnchanged()

    const [terminated] = await scene.startQualificationClients({ mode: 'attach' })
    await scene.waitEntryRecord(terminated!, { m4a0: 'ready' })
    await scene.signalEntry(terminated!, 'SIGTERM')
    const terminatedTerminal = await scene.finishEntry(terminated!)
    expect(terminatedTerminal.outcome).toBe('signal')
    expect(terminatedTerminal.exit).toEqual({ code: 0, signal: null })
    const terminatedRecords = await scene.entryRecords(terminated!)
    expect(terminatedRecords.some(record => record.m4a0 === 'failure')).toBe(false)
    await assertHostUnchanged()

    // Final liveness readback, then the normal Host stop.
    const [finalClient] = await scene.startQualificationClients({ mode: 'attach' })
    const finalReady = await scene.waitEntryRecord(finalClient!, { m4a0: 'ready' })
    expect(finalReady.host.instanceId).toBe(hostInstanceId)
    expect(finalReady.transport).toBe('connected')
    await scene.finishEntry(finalClient!)
    await assertHostUnchanged()
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the qualification Client lifecycle test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the qualification Client lifecycle test passed but its Scene cleanup failed')
    }
  }
})

test('refuses unsafe or forged Host discovery facts without killing or replacing the live owner', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  try {
    const host = await scene.startHost()
    const files = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    const registrySnapshot = savePrivateFile(files.registryPath)
    const launchSnapshot = savePrivateFile(files.launchPath)
    const registry = JSON.parse(registrySnapshot.bytes.toString('utf8')) as Record<string, any>
    const launch = JSON.parse(launchSnapshot.bytes.toString('utf8')) as Record<string, any>
    const hostPid = host.ready.localHost.hostPid
    const hostInstanceId = host.ready.localHost.instanceId
    const witness = await scene.startIdentityWitness('live-non-host')
    const closedOrigin = await closedLoopbackOrigin()
    const decoyDir = join(scene.workDir, 'discovery-decoys')
    mkdirSync(decoyDir, { recursive: true, mode: 0o700 })
    const assertHostAndWitnessAlive = async (): Promise<void> => {
      const status = await scene.hostStatus(host)
      expect(status.localHost.hostPid).toBe(hostPid)
      expect(status.localHost.instanceId).toBe(hostInstanceId)
      expect(status.services.piTuiHostReady).toBe(true)
      assertWitnessIdentityLive(witness, 'the live dummy witness')
    }
    const runRefusal = async (
      refusal: DiscoveryRefusal,
      expectedCode: string,
      apply: () => void,
      restore: () => void,
      verifyBeforeRestore?: () => void,
    ): Promise<void> => {
      apply()
      try {
        const [client] = await scene.startQualificationClients({ mode: 'discovery-refusal', refusal })
        const failure = await scene.waitEntryRecord(client!, { m4a0: 'failure' })
        expect(failure.code).toBe(expectedCode)
        const terminal = await scene.finishEntry(client!)
        expect(terminal.exit).toEqual({ code: 1, signal: null })
        const facts = await scene.entryRecordFacts(client!)
        expect(facts.records.some(record => record.m4a0 === 'ready')).toBe(false)
        verifyBeforeRestore?.()
      } finally {
        restore()
      }
      await assertHostAndWitnessAlive()
      expect(existsSync(join(scene.scopeDir, 'instance.json'))).toBe(true)
    }
    const writeRegistry = (patch: Record<string, any>): void => {
      writePrivateJson(files.registryPath, { ...registry, ...patch })
    }
    const writeLaunch = (patch: Record<string, any>): void => {
      writePrivateJson(files.launchPath, { ...launch, ...patch })
    }
    const restoreFiles = (): void => {
      restorePrivateFile(files.registryPath, registrySnapshot)
      restorePrivateFile(files.launchPath, launchSnapshot)
    }

    // Positive control: the product accepts an existing user-selected file mode
    // and never forces its own chmod. The scope directory itself is the Darwin
    // qualification-seat directory, whose real contract requires no group/other
    // access; that platform difference is asserted truthfully instead of being
    // forced into the Linux acceptance rule.
    for (const [label, path, mode] of [
      ['registry', files.registryPath, 0o644],
      ['launch', files.launchPath, 0o644],
    ] as const) {
      const originalMode = statSync(path).mode & 0o777
      chmodSync(path, mode)
      try {
        const [client] = await scene.startQualificationClients({ mode: 'attach' })
        const ready = await scene.waitEntryRecord(client!, { m4a0: 'ready' })
        expect(ready.host.instanceId).toBe(hostInstanceId)
        expect(statSync(path).mode & 0o777, `the product chmodded the existing ${label} mode`).toBe(mode)
        await scene.finishEntry(client!)
      } finally {
        chmodSync(path, originalMode)
      }
      await assertHostAndWitnessAlive()
    }
    {
      const originalMode = statSync(files.scopeDir).mode & 0o777
      chmodSync(files.scopeDir, 0o755)
      try {
        if (process.platform === 'linux') {
          const [client] = await scene.startQualificationClients({ mode: 'attach' })
          const ready = await scene.waitEntryRecord(client!, { m4a0: 'ready' })
          expect(ready.host.instanceId).toBe(hostInstanceId)
          expect(statSync(files.scopeDir).mode & 0o777).toBe(0o755)
          await scene.finishEntry(client!)
        } else {
          // Darwin: the scope directory is also the qualification-seat
          // directory, so a group/other-accessible mode is a real refusal and
          // the product never rewrites the owner's mode.
          await runRefusal('scope-directory', 'SCOPE_DIRECTORY_UNSAFE', () => {}, () => {})
          expect(statSync(files.scopeDir).mode & 0o777).toBe(0o755)
        }
      } finally {
        chmodSync(files.scopeDir, originalMode)
      }
      await assertHostAndWitnessAlive()
    }

    // A Scene-local symlink alias to an existing private parent, plus a unique
    // nonexistent child, must be rejected BEFORE any mkdir. The control creates
    // no sibling directory and removes only its own alias.
    const outsideParent = scene.tmpBase
    const outsideChild = `outside-child-${randomUUID()}`
    const outsideAlias = join(scene.workDir, `outside-alias-${randomUUID()}`)
    symlinkSync(outsideParent, outsideAlias)
    try {
      const [aliasClient] = await scene.startQualificationClients({ mode: 'attach' })
      await scene.waitEntryRecord(aliasClient!, { m4a0: 'ready' })
      await expect(scene.qualificationControl(aliasClient!, {
        op: 'qualification-host-foundation',
        requestId: 'outside-alias',
        workspacePath: join(outsideAlias, outsideChild),
      })).rejects.toThrow(/inside the Scene root|does not exist/u)
      expect(existsSync(join(outsideParent, outsideChild)), 'the rejected alias created an outside child').toBe(false)
      await scene.finishEntry(aliasClient!)
    } finally {
      unlinkSync(outsideAlias)
    }

    const registryReal = `${files.registryPath}.real`
    const registryDecoy = join(decoyDir, 'registry-decoy.json')
    await runRefusal('registry-symlink', 'LOCAL_FILE_UNSAFE', () => {
      writeFileSync(registryDecoy, registrySnapshot.bytes, { mode: 0o600 })
      chmodSync(registryDecoy, 0o600)
      renameSync(files.registryPath, registryReal)
      symlinkSync(registryDecoy, files.registryPath)
    }, () => {
      rmSync(files.registryPath, { force: true })
      renameSync(registryReal, files.registryPath)
    }, () => {
      expectSameBytes(registryDecoy, registrySnapshot.bytes, 'the symlink decoy registry')
      expect(statSync(registryDecoy).mode & 0o777).toBe(0o600)
    })

    const launchReal = `${files.launchPath}.real`
    const launchDecoy = join(decoyDir, 'launch-decoy.json')
    await runRefusal('launch-symlink', 'LOCAL_FILE_UNSAFE', () => {
      writeFileSync(launchDecoy, launchSnapshot.bytes, { mode: 0o600 })
      chmodSync(launchDecoy, 0o600)
      renameSync(files.launchPath, launchReal)
      symlinkSync(launchDecoy, files.launchPath)
    }, () => {
      rmSync(files.launchPath, { force: true })
      renameSync(launchReal, files.launchPath)
    }, () => {
      expectSameBytes(launchDecoy, launchSnapshot.bytes, 'the symlink decoy launch')
    })

    await runRefusal('forged-instance', 'HOST_IDENTITY_MISMATCH', () => {
      const forged = randomUUID()
      writeRegistry({ instanceId: forged })
      writeLaunch({ instanceId: forged })
    }, restoreFiles, () => {
      expect(JSON.parse(readFileSync(files.registryPath, 'utf8')).instanceId).not.toBe(hostInstanceId)
      expect(JSON.parse(readFileSync(files.launchPath, 'utf8')).instanceId).not.toBe(hostInstanceId)
    })

    const forgedPidRegistry: Record<string, any> = { ...registry, hostPid: witness.pid }
    if (registry.schema === 1) forgedPidRegistry.hostStarttime = witness.starttime
    else forgedPidRegistry.hostKernelIdentity = witness.kernelIdentity
    await runRefusal('forged-pid', 'HOST_IDENTITY_MISMATCH', () => {
      writePrivateJson(files.registryPath, forgedPidRegistry)
    }, restoreFiles, () => {
      expect(JSON.parse(readFileSync(files.registryPath, 'utf8')).hostPid).toBe(witness.pid)
    })

    const forgedOriginRegistry = { ...registry, origin: closedOrigin }
    const forgedOriginLaunch = {
      ...launch,
      connectUrl: String(launch.connectUrl).replace(String(registry.origin), closedOrigin),
    }
    await runRefusal('forged-origin', 'HOST_UNRESPONSIVE', () => {
      writePrivateJson(files.registryPath, forgedOriginRegistry)
      writePrivateJson(files.launchPath, forgedOriginLaunch)
    }, restoreFiles)

    const dummyOriginRegistry: Record<string, any> = {
      ...forgedPidRegistry,
      origin: closedOrigin,
    }
    await runRefusal('unresponsive-dummy-origin', 'HOST_UNRESPONSIVE', () => {
      writePrivateJson(files.registryPath, dummyOriginRegistry)
      writePrivateJson(files.launchPath, forgedOriginLaunch)
    }, restoreFiles)

    await runRefusal('protocol', 'HOST_PROTOCOL_INCOMPATIBLE', () => {
      writeRegistry({ protocol: 'dsh-pi-tui/local/1' })
    }, restoreFiles)

    const forgedBuild = 'a'.repeat(64)
    await runRefusal('forged-build', 'HOST_IDENTITY_MISMATCH', () => {
      writeRegistry({ buildId: forgedBuild })
    }, restoreFiles, () => {
      expect(JSON.parse(readFileSync(files.registryPath, 'utf8')).buildId).toBe(forgedBuild)
    })

    await runRefusal('wrong-token', 'HOST_AUTH_FAILED', () => {
      const url = new URL(String(launch.connectUrl))
      url.searchParams.set('token', 'deadbeefdeadbeef')
      writeLaunch({ connectUrl: url.href })
    }, restoreFiles)

    // A pristine authenticated attach/readback after every refusal.
    const pristineCookie = await exchangeCookie(host.ready.localHost.origin,
      JSON.parse(readFileSync(files.launchPath, 'utf8')))
    const pristineIdentity = await readAuthenticatedIdentity(host.ready.localHost.origin, pristineCookie,
      'the pristine identity after the refusals')
    expect(pristineIdentity.identity.instanceId).toBe(hostInstanceId)
    await scene.finishIdentityWitness(witness)
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (testError !== undefined) {
        throw new AggregateError([testError, asError(cleanupError)],
          'the discovery-refusal test failed and its Scene cleanup also failed')
      }
      throw new AggregateError([asError(cleanupError)],
        'the discovery-refusal test passed but its Scene cleanup failed')
    }
  }
})

test('cancels an installed Client during an in-flight authentication without disturbing the Host or peer', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  let peer: SplitProcessClient | undefined
  let cancelled: QualificationClientHandle | undefined
  let cancelledFinished = false
  let listener: ReturnType<typeof createHttpServer> | undefined
  let listenerSockets: Set<Socket> = new Set()
  let privateSnapshot: { registryPath: string; registry: PrivateFileSnapshot; launchPath: string; launch: PrivateFileSnapshot } | undefined
  let restored = false

  const restorePrivate = (): void => {
    if (restored || privateSnapshot === undefined) return
    restorePrivateFile(privateSnapshot.registryPath, privateSnapshot.registry)
    restorePrivateFile(privateSnapshot.launchPath, privateSnapshot.launch)
    restored = true
  }
  const closeListener = async (): Promise<void> => {
    if (listener === undefined) return
    const current = listener
    listener = undefined
    current.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      current.close(error => error === undefined ? resolve() : reject(error))
    })
    for (const socket of listenerSockets) socket.destroy()
    listenerSockets = new Set()
  }
  /**
   * Terminate the target through the EXISTING Supervisor-owned signal/close
   * path before restoring the private fixture files. A still-live auth wait is
   * cancelled by the product's own SIGTERM startup-abort chain, never by
   * closing the test listener first.
   */
  const settleCancelledClient = async (): Promise<void> => {
    if (cancelled === undefined || cancelledFinished) return
    const facts = await scene.entryRecordFacts(cancelled)
    if (!facts.exited && facts.records.every(record => record.m4a0 !== 'signal')) {
      await scene.signalEntry(cancelled, 'SIGTERM')
    }
    await scene.finishEntry(cancelled)
    cancelledFinished = true
  }

  try {
    const host = await scene.startHost()
    const hostFiles = readScopeFiles(scene.installation.dshHome, scene.scope.scopeId)
    const hostPid = host.ready.localHost.hostPid
    const hostInstanceId = host.ready.localHost.instanceId
    const hostRootFiberUid = host.ready.rootFiberUid
    const sessionsBefore = await scene.sessionIds()
    await assertAuthenticatedHost(scene, host)

    // A real, independent surface peer: mounted on the same authenticated Host
    // and left alive for the whole cancellation. Its draft is the observable
    // proof the peer's editor still works after the cancelled Client is gone.
    const peerCwd = join(scene.workDir, 'auth-cancel-peer-workspace')
    const peerHome = join(scene.workDir, 'auth-cancel-peer-home')
    mkdirSync(peerCwd, { recursive: true, mode: 0o700 })
    mkdirSync(peerHome, { recursive: true, mode: 0o700 })
    peer = await scene.startClient({ label: 'auth-cancel-peer', cwd: peerCwd, home: peerHome })
    expect(peer.ready.transport).toBe('connected')
    expect(peer.ready.surfaceMounted).toBe(true)
    expect(peer.ready.hostPid).toBe(hostPid)
    expect(peer.ready.instanceId).toBe(hostInstanceId)
    const draft = `auth-cancel-draft-${randomUUID()}`
    await peer.type(draft)
    await waitForFrame(peer, draft, 'the authenticated peer draft')
    await peer.press('Ctrl+U')
    await waitForFrameGone(peer, draft, 'the authenticated peer draft clear')

    // The controlled loopback listener is the ONLY origin change: it holds one
    // real /connect transaction and never returns a Cookie, identity or
    // redirect. Everything else in the private registry/launch stays the real
    // Scene Host material.
    const syntheticToken = `synthetic-${randomUUID()}`
    const requests: Array<{ method: string; pathname: string; token: string | null; interactions: string | null; keys: string[] }> = []
    let requestSocket: Socket | undefined
    let requestArrivedAt: number | undefined
    let unexpected: Error | undefined
    let resolveFirstRequest: (() => void) | undefined
    const firstRequest = new Promise<void>(resolve => { resolveFirstRequest = resolve })
    listener = createHttpServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const keys = [...url.searchParams.keys()]
      const record = {
        method: request.method ?? '',
        pathname: url.pathname,
        token: url.searchParams.get('token'),
        interactions: url.searchParams.get('interactions'),
        keys,
      }
      requests.push(record)
      if (requests.length > 1) {
        unexpected ??= new Error(`the in-flight authentication sent ${String(requests.length)} requests instead of one`)
        request.resume()
        response.writeHead(409)
        response.end()
        resolveFirstRequest?.()
        return
      }
      const valid = record.method === 'GET'
        && record.pathname === '/connect'
        && record.token === syntheticToken
        && record.interactions === 'answer'
        && keys.length === 2
      if (!valid) {
        unexpected ??= new Error(`the in-flight authentication request is not the one expected /connect transaction: ${JSON.stringify(record)}`)
        request.resume()
        response.writeHead(400)
        response.end()
        resolveFirstRequest?.()
        return
      }
      requestSocket = request.socket
      requestArrivedAt = performance.now()
      resolveFirstRequest?.()
      // Deliberately hold the response: no status line, headers or body.
    })
    listener.on('connection', socket => {
      listenerSockets.add(socket)
      socket.once('close', () => listenerSockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      const current = listener
      if (current === undefined) {
        reject(new Error('the controlled listener disappeared before listen'))
        return
      }
      current.once('error', reject)
      current.listen(0, '127.0.0.1', () => resolve())
    })
    const address = listener.address()
    if (address === null || typeof address === 'string') throw new Error('the controlled listener has no loopback port')
    const listenerOrigin = `http://127.0.0.1:${String(address.port)}`

    privateSnapshot = {
      registryPath: hostFiles.registryPath,
      registry: savePrivateFile(hostFiles.registryPath),
      launchPath: hostFiles.launchPath,
      launch: savePrivateFile(hostFiles.launchPath),
    }
    const registry = JSON.parse(privateSnapshot.registry.bytes.toString('utf8')) as Record<string, any>
    const launch = JSON.parse(privateSnapshot.launch.bytes.toString('utf8')) as Record<string, any>
    writePrivateJson(hostFiles.registryPath, { ...registry, origin: listenerOrigin })
    writePrivateJson(hostFiles.launchPath, { ...launch, connectUrl: `${listenerOrigin}/connect?token=${syntheticToken}` })

    const [target] = await scene.startQualificationClients({ mode: 'attach' })
    cancelled = target!
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the in-flight authentication never reached the controlled listener')), 30_000)
      void firstRequest.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (unexpected !== undefined) throw unexpected
    const arrivedAt = requestArrivedAt
    if (arrivedAt === undefined || requestSocket === undefined) {
      throw new Error('the controlled listener did not record the real request arrival and socket')
    }
    expect(requestSocket.destroyed).toBe(false)

    // The decisive boundary is the real request already in flight, not a sleep
    // or a spawn timestamp: the Client has not authenticated, created a
    // Context or reached Ready, and no failure has been reported yet.
    const recordsBefore = await scene.entryRecords(cancelled)
    for (const recordName of ['host-authenticated', 'context-ready', 'ready', 'failure']) {
      expect(recordsBefore.some(record => record.m4a0 === recordName),
        `the cancelled Client reported ${recordName} before the request was held`).toBe(false)
    }

    await scene.signalEntry(cancelled, 'SIGTERM')
    const terminal = await scene.finishEntry(cancelled)
    cancelledFinished = true
    const exitedAt = performance.now()
    expect(exitedAt - arrivedAt, 'the cancelled Client did not exit within 5s of the real request arrival').toBeLessThan(5_000)
    expect(terminal.exit).toEqual({ code: 0, signal: null })
    expect(terminal.outcome).toBe('signal')

    const recordsAfter = await scene.entryRecords(cancelled)
    for (const recordName of ['host-authenticated', 'context-ready', 'ready', 'failure', 'cleanup-failure']) {
      expect(recordsAfter.some(record => record.m4a0 === recordName),
        `the cancelled Client reported ${recordName} after its terminal`).toBe(false)
    }
    const signals = recordsAfter.filter(record => record.m4a0 === 'signal' && record.signal === 'SIGTERM')
    expect(signals, 'exactly one real SIGTERM record').toHaveLength(1)
    const shutdown = recordsAfter.filter(record => record.m4a0 === 'shutdown-stage' && record.phase === 'cleanup-complete')
    expect(shutdown, 'exactly one shutdown-stage cleanup-complete record').toHaveLength(1)
    expect(shutdown[0]?.failure).toBe(false)
    expect(shutdown[0]?.errors).toBe(0)

    // The Client's abort closes the real in-flight socket; the test must not be
    // the one that ends it.
    const socketAtArrival = requestSocket
    await waitFor(async () => socketAtArrival.destroyed, 'the held authentication connection to close after the Client exit', 10_000)

    // Restore the private files only after the Client's real terminal, then
    // release the listener. The SAME Host must still authenticate with its own
    // original material.
    restorePrivate()
    await closeListener()
    await assertAuthenticatedHost(scene, host)

    const peerState = await peer.state()
    expect(peerState.exited).toBe(false)
    expect(peerState.businessPids).toContain(peer.ready.businessPid)
    expect(peerState.businessStates.every(state => state.state === 'alive')).toBe(true)
    const peerFrame = await peer.text()
    expect(peerFrame.length).toBeGreaterThan(0)

    // A fresh qualification Client must authenticate the same Host after the
    // cancelled entry released its qualification seat.
    const [fresh] = await scene.startQualificationClients({ mode: 'attach' })
    const freshReady = await scene.waitEntryRecord(fresh!, { m4a0: 'ready' })
    expect(freshReady.transport).toBe('connected')
    expect(freshReady.host.hostPid).toBe(hostPid)
    expect(freshReady.host.instanceId).toBe(hostInstanceId)
    const freshExit = await scene.finishEntry(fresh!)
    expect(freshExit.exit).toEqual({ code: 0, signal: null })

    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost.hostPid).toBe(hostPid)
    expect(statusAfter.localHost.instanceId).toBe(hostInstanceId)
    expect(statusAfter.rootFiberUid).toBe(hostRootFiberUid)
    expect(statusAfter.services.piTuiHostReady).toBe(true)
    expect(await scene.sessionIds()).toEqual(sessionsBefore)

    await peer.exitGracefully()
    await scene.stopHost(host)
    await scene.assertEntrySeatsFree()
  } catch (error) {
    testError = error
    throw error
  } finally {
    const cleanupErrors: Error[] = []
    try {
      await settleCancelledClient()
    } catch (error) {
      cleanupErrors.push(asError(error))
    }
    try {
      restorePrivate()
    } catch (error) {
      cleanupErrors.push(asError(error))
    }
    try {
      await closeListener()
    } catch (error) {
      cleanupErrors.push(asError(error))
    }
    if (peer !== undefined) {
      try {
        await peer.exitGracefully()
      } catch (error) {
        cleanupErrors.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (cleanupError) {
      cleanupErrors.push(asError(cleanupError))
    }
    if (cleanupErrors.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...cleanupErrors],
          'the in-flight authentication cancellation test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(cleanupErrors,
        'the in-flight authentication cancellation test passed but its Scene cleanup failed')
    }
  }
})
