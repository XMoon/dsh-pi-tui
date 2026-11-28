/**
 * Split-process business anchor: Host workspace file completion before the
 * first Session.
 *
 * The only evidence here is a real installed candidate, a real Supervisor-owned
 * Host, two real PTY Clients and the product's own keyboard/completion/Session
 * persistence path. Nothing types into an internal method, writes a Profile
 * directly or fakes a Workspace.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const PRIMARY_MARKER = 'workspace-proof-primary.ts'
const SECONDARY_MARKER = 'workspace-proof-secondary.ts'
const CLIENT_LOCAL_MARKER = 'workspace-proof-client-local.ts'

async function frameText(client: SplitProcessClient): Promise<string> {
  return await client.text()
}

async function waitForFrame(
  client: SplitProcessClient,
  text: string,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await frameText(client)
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
    const frame = await frameText(client)
    if (!frame.includes(text)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: ${JSON.stringify(text)} stayed on the current frame for ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

/**
 * Wait for the Welcome's Host-CONFIRMED directory. The card wraps a long path
 * across rows and the whale art owns the left columns, so each row is sliced
 * from the label column and flattened before the complete canonical path is
 * matched. `Checking Host directory:` and `Host directory unavailable:` are
 * distinct states, never a confirmation.
 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Test-owned teardown of the real completion UI before the Client leaves. */
async function dismissSplitUi(client: SplitProcessClient): Promise<void> {
  if (client.closed) return
  const state = await client.state().catch(() => undefined)
  if (state !== undefined && state.exited) return
  await client.press('Escape')
  await sleep(200)
  await client.press('Ctrl+U')
  await sleep(100)
}

async function waitForConfirmedDirectory(
  client: SplitProcessClient,
  canonicalPath: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  const started = Date.now()
  for (;;) {
    const frame = await frameText(client)
    const rows = frame.split('\n')
    const labelRow = rows.find(row => row.includes('Host directory:'))
    if (labelRow !== undefined) {
      const factsStart = labelRow.indexOf('Host directory:')
      const flat = rows
        .map(row => (row.length > factsStart ? row.slice(factsStart) : ''))
        .join('')
        .replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/gu, '')
        .replace(/\s+/gu, '')
      if (!flat.includes('CheckingHostdirectory:')
        && !flat.includes('Hostdirectoryunavailable:')
        && flat.includes(flatPath)) {
        return
      }
    }
    if (Date.now() - started >= timeoutMs) {
      const last = await frameText(client)
      throw new Error(`${label}: the Welcome never confirmed ${canonicalPath}; frame=${JSON.stringify(last.slice(-2000))}`)
    }
    await sleep(50)
  }
}

/** The two-Client probe window; the Supervisor receipt holds the real facts. */
async function holdForProbe(scene: SplitProcessScene, client: SplitProcessClient, point: string): Promise<void> {
  const state = await client.state()
  await scene.report('process-probe-point', {
    point,
    workerPid: process.pid,
    clientId: client.clientId,
    clientSessionId: client.sessionId,
    hostPid: client.ready.hostPid,
    hostInstanceId: client.ready.instanceId,
    businessPids: state.businessPids,
    shellPid: state.shellPid,
  })
  await new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${point} probe checkpoint timed out: no external signal arrived`)), 120_000)
  })
}

test('completes Host workspace files before creating the first session in that workspace', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  const uiClients: SplitProcessClient[] = []
  try {
    const root = scene.workDir
    const primary = join(root, 'workspace-primary')
    const secondary = join(root, 'workspace-secondary')
    const primaryHome = join(root, 'workspace-primary-home')
    const secondaryHome = join(root, 'workspace-secondary-home')
    const fallbackHome = join(root, 'workspace-fallback-home')
    for (const directory of [primary, secondary, primaryHome, secondaryHome, fallbackHome]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
    writeFileSync(join(primary, PRIMARY_MARKER), 'primary\n', { mode: 0o600 })
    writeFileSync(join(secondary, SECONDARY_MARKER), 'secondary\n', { mode: 0o600 })
    writeFileSync(join(primaryHome, CLIENT_LOCAL_MARKER), 'client-local\n', { mode: 0o600 })
    writeFileSync(join(secondaryHome, CLIENT_LOCAL_MARKER), 'client-local\n', { mode: 0o600 })
    const canonicalPrimary = realpathSync(primary)
    const canonicalSecondary = realpathSync(secondary)
    expect(canonicalPrimary).not.toBe(canonicalSecondary)

    if (process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'fallback-host-ready') {
      // Probe-only path: NO explicit Host. The real product discovery starts the
      // fallback Host, the Supervisor registers its real kernel identity and
      // holds; an external SIGKILL must reclaim it. Reaching the end is a FAIL.
      const client = await scene.startClient({ label: 'workspace-primary', cwd: primary, home: fallbackHome })
      throw new Error(`the fallback-host-ready probe returned a Client without an external kill: ${client.clientId}`)
    }

    const sessionsBefore = new Set(await scene.sessionIds())
    const logCountBefore = scene.hostSessionLogCount()
    const host = await scene.startHost()

    // Input boundary on the REAL started Scene: a path-unsafe label, an
    // escaping cwd/home and an unknown handle are refused before any directory
    // or native spawn exists. The negative cwd/home input is the already
    // existing canonical private base (the parent of the Scene root), so the
    // refusal is the actual containment check rather than a missing-path
    // failure and the Worker allocates nothing outside the Supervisor-owned
    // Scene root. The refused starts must leave no Client reservation or owned
    // directory behind.
    const outsideBase = realpathSync(dirname(root))
    const idsBeforeBoundary = await scene.sessionIds()
    await expect(scene.startClient({ label: '../../escape', cwd: primary, home: primaryHome }))
      .rejects.toThrow(/INPUT_UNQUALIFIED/u)
    await expect(scene.startClient({ label: 'boundary-cwd', cwd: outsideBase, home: primaryHome }))
      .rejects.toThrow(/must be inside the Scene root/u)
    await expect(scene.startClient({ label: 'boundary-home', cwd: primary, home: outsideBase }))
      .rejects.toThrow(/must be inside the Scene root/u)
    await expect(scene.request('CLOSE_PROCESS_CLIENT', { clientId: 'unknown-process-client' }))
      .rejects.toThrow(/CLOSE_PROCESS_CLIENT|unknown|not registered/u)
    expect(await scene.sessionIds()).toEqual(idsBeforeBoundary)
    expect(readdirSync(root).filter(name => name.startsWith('escape'))).toEqual([])
    expect(existsSync(join(root, 'process-clients'))).toBe(false)

    const primaryClient = await scene.startClient({ label: 'workspace-primary', cwd: primary, home: primaryHome })
    const secondaryClient = await scene.startClient({ label: 'workspace-secondary', cwd: secondary, home: secondaryHome })
    uiClients.push(primaryClient, secondaryClient)

    // Official ready facts: two connected, mounted, sessionless Clients
    // authenticated to the SAME exact Host.
    expect(primaryClient.ready.transport).toBe('connected')
    expect(primaryClient.ready.surfaceMounted).toBe(true)
    expect(primaryClient.ready.sessionOpen).toBe(false)
    expect(secondaryClient.ready.transport).toBe('connected')
    expect(secondaryClient.ready.surfaceMounted).toBe(true)
    expect(secondaryClient.ready.sessionOpen).toBe(false)
    const hostPid = host.ready.localHost?.hostPid
    expect(typeof hostPid).toBe('number')
    expect(primaryClient.ready.hostPid).toBe(hostPid)
    expect(secondaryClient.ready.hostPid).toBe(hostPid)
    expect(primaryClient.ready.businessPid).not.toBe(secondaryClient.ready.businessPid)
    expect(primaryClient.ready.instanceId).toBe(secondaryClient.ready.instanceId)
    expect(primaryClient.ready.scopeId).toBe(scene.scope.scopeId)
    expect(primaryClient.ready.buildId).toBe(scene.scope.buildId)
    expect(secondaryClient.ready.scopeId).toBe(scene.scope.scopeId)
    expect(secondaryClient.ready.buildId).toBe(scene.scope.buildId)

    await waitForConfirmedDirectory(primaryClient, canonicalPrimary, 'workspace-primary confirmed Host directory')
    await waitForConfirmedDirectory(secondaryClient, canonicalSecondary, 'workspace-secondary confirmed Host directory')

    if (process.env.SPLIT_VITEST_PROCESS_FAILURE_POINT === 'after-client-ready') {
      // Negative control: both real Clients are live on a real Host when a test
      // assertion fails; teardown must still reclaim the whole Scene.
      throw new Error('SPLIT_VITEST_INTENTIONAL_FAILURE: a real assertion failed while both Clients were live')
    }

    if (process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'clients-ready'
      || process.env.SPLIT_VITEST_PROCESS_PROBE_POINT === 'process-main-signal') {
      await holdForProbe(scene, primaryClient, process.env.SPLIT_VITEST_PROCESS_PROBE_POINT)
    }
    if (process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID !== undefined
      && process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID !== '') {
      await scene.parallelReady('host-file-completion', host, primaryClient)
      await scene.parallelRelease('host-file-completion')
    }

    // No completion interaction may create a Host Session.
    expect(await scene.sessionIds()).toEqual([...sessionsBefore])

    // Each Client's completion popup lists its OWN Host workspace file only.
    await primaryClient.type('@workspace-proof')
    const primaryPopup = await waitForFrame(primaryClient, PRIMARY_MARKER, 'workspace-primary completion popup')
    expect(primaryPopup).not.toContain(SECONDARY_MARKER)
    expect(primaryPopup).not.toContain(CLIENT_LOCAL_MARKER)
    await secondaryClient.type('@workspace-proof')
    const secondaryPopup = await waitForFrame(secondaryClient, SECONDARY_MARKER, 'workspace-secondary completion popup')
    expect(secondaryPopup).not.toContain(PRIMARY_MARKER)
    expect(secondaryPopup).not.toContain(CLIENT_LOCAL_MARKER)
    expect(await scene.sessionIds()).toEqual([...sessionsBefore])

    // Accept the real completion and submit the first Prompt from the editor.
    await primaryClient.press('Tab')
    const accepted = await waitForFrame(primaryClient, `@${PRIMARY_MARKER}`, 'workspace-primary accepted draft')
    expect(accepted).not.toContain(SECONDARY_MARKER)
    expect(accepted).not.toContain(CLIENT_LOCAL_MARKER)
    await primaryClient.submit()

    const opened = await primaryClient.waitForSurfaceStatus(
      record => record.sessionOpen === true
        && typeof record.openSessionId === 'string'
        && record.transport === 'connected'
        && record.host?.hostPid === hostPid,
      'workspace-primary first Host Session on the same connected Host',
    )
    const sessionId = String(opened.openSessionId)
    const header = await scene.waitForHostSessionHeader(sessionId, 'workspace-primary durable Session header')
    expect((header as Record<string, any>).cwd).toBe(canonicalPrimary)
    await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes(`@${PRIMARY_MARKER}`),
      'the Host committed the submitted Host-located mention',
    )
    await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'the Host produced the offline real answer',
    )
    await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'turn/end',
      'the first Host Turn settled',
    )

    const idsAfter = await scene.sessionIds()
    expect(idsAfter.filter(id => !sessionsBefore.has(id))).toEqual([sessionId])
    expect(idsAfter.length).toBe(sessionsBefore.size + 1)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore + 1)

    // The secondary Client never attached, and the primary action did not
    // create or modify a Session in its own workspace.
    expect(secondaryClient.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)
    expect(secondaryClient.ready.sessionOpen).toBe(false)
    const secondaryStill = await frameText(secondaryClient)
    expect(secondaryStill).toContain(SECONDARY_MARKER)
    expect(secondaryStill).not.toContain(PRIMARY_MARKER)

    // Normal idle exit path: close the real popup, clear the draft, then /exit.
    await secondaryClient.press('Escape')
    await waitForFrameGone(secondaryClient, SECONDARY_MARKER, 'workspace-secondary popup closed')
    await secondaryClient.press('Ctrl+U')
    const clearedSecondary = await frameText(secondaryClient)
    expect(clearedSecondary).not.toContain(SECONDARY_MARKER)
    await secondaryClient.submit('/exit')
    const secondaryExit = await secondaryClient.close()
    expect(secondaryExit).toEqual({ code: 0, signal: null })

    await primaryClient.submit('/exit')
    // Observation is not a close: waitForExit records the real native terminal
    // state, then close() still owns the Supervisor-owned settlement.
    expect(await primaryClient.waitForExit()).toEqual({ code: 0, signal: null })
    const primaryExit = await primaryClient.close()
    expect(primaryExit).toEqual({ code: 0, signal: null })

    if (process.env.SPLIT_VITEST_PROCESS_FAILURE_POINT === 'assertion-and-invalid-client-record') {
      // Negative control: both real Clients already exited normally, then the
      // run's own official ledger gains one malformed COMPLETE line and a real
      // assertion fails. The final audit must refuse to call the Scene clean and
      // the root must be retained for inspection.
      appendFileSync(primaryClient.recordFile, 'not-json\n', { mode: 0o600 })
      expect('the negative control').toBe('the invalid record must be refused')
    }

    // The same Host survived both Client exits and is then explicitly stopped.
    const hostStatus = await scene.hostStatus(host)
    expect(hostStatus.localHost?.hostPid).toBe(hostPid)
    expect(hostStatus.localHost?.instanceId).toBe(host.ready.localHost?.instanceId)
    await scene.stopHost(host)
  } catch (error) {
    testError = error
    throw error
  } finally {
    const teardownErrors: Error[] = []
    for (const client of [...uiClients].reverse()) {
      try {
        await dismissSplitUi(client)
      } catch (error) {
        teardownErrors.push(asError(error))
      }
    }
    try {
      await scene.dispose()
    } catch (cleanupError) {
      teardownErrors.push(asError(cleanupError))
    }
    if (teardownErrors.length > 0) {
      if (testError !== undefined) {
        throw new AggregateError([testError, ...teardownErrors],
          'the Host-file business test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardownErrors,
        'the Host-file business test passed but its Scene cleanup failed')
    }
  }
})

function composerDraftOf(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯')
    && !line.includes('[connection]'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

function belowComposer(frame: string): string {
  const lines = frame.split('\n')
  let bottom = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^─{10,}$/u.test(lines[index]!.trim())) bottom = index
  }
  return bottom < 0 ? '' : lines.slice(bottom + 1).join('\n')
}

async function waitForDraft(
  client: SplitProcessClient,
  expected: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraftOf(await frameText(client))
    if (expected === '') {
      if (typeof draft === 'string' && (draft === '' || /^…{1,2}$/u.test(draft))) return
    } else if (draft === expected) {
      return
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: composer did not hold ${JSON.stringify(expected)} (saw ${JSON.stringify(draft)})`)
    }
    await sleep(25)
  }
}

async function readWorkspaceBaseline(client: SplitProcessClient, label: string): Promise<Array<{
  workspaceId: string
  path: string | null
  sessionIds: string[]
}>> {
  const dispatched = await client.readAuthority({ op: 'workspaces', window: 'peer-baseline' })
  expect(dispatched.op, `${label}: unexpected read-authority op`).toBe('workspaces')
  const frame = await client.waitForRecord(
    record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === dispatched.nonce
      && record.phase === 'workspaces-frame',
    `${label}: workspaces baseline frame`,
  )
  await client.waitForRecord(
    record => record.m4b2s === 'qualification'
      && record.op === 'read-authority-proof'
      && record.nonce === dispatched.nonce
      && record.phase === 'workspaces-ended',
    `${label}: workspaces baseline terminal`,
  )
  const items = (Array.isArray(frame.items) ? frame.items : []).map((item: Record<string, any>) => ({
    workspaceId: String(item.workspaceId),
    path: typeof item.path === 'string' ? (existsSync(item.path) ? realpathSync(item.path) : item.path) : null,
    sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map(String).sort() : [],
  }))
  return items.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
}

test('completes explicit Host paths outside a selected Workspace and keeps bare queries scoped', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostHome = scene.installation.base.env.HOME
    expect(hostHome, 'the Scene installation must expose its isolated Host HOME').toBeTypeOf('string')
    const canonicalHostHome = realpathSync(hostHome!)
    const alphaName = 'workspace-scope-alpha'
    const externalName = 'workspace-scope-external'
    const alphaDir = join(canonicalHostHome, alphaName)
    const externalDir = join(canonicalHostHome, externalName)
    const clientCwd = join(scene.workDir, 'explicit-client-cwd')
    const clientHome = join(scene.workDir, 'explicit-client-home')
    const refusedHome = join(scene.workDir, 'refused-client-home')
    for (const dir of [alphaDir, externalDir, clientCwd, clientHome, refusedHome]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const insideFile = 'scope-marker-inside.ts'
    const outsideFile = 'scope-marker-outside.ts'
    const clientFile = 'scope-marker-client.ts'
    writeFileSync(join(alphaDir, insideFile), 'inside\n', { mode: 0o600 })
    writeFileSync(join(externalDir, outsideFile), 'outside\n', { mode: 0o600 })
    writeFileSync(join(clientCwd, clientFile), 'client\n', { mode: 0o600 })

    const canonicalAlpha = realpathSync(alphaDir)
    const canonicalExternal = realpathSync(externalDir)
    const canonicalClientCwd = realpathSync(clientCwd)
    expect(canonicalClientCwd).not.toBe(canonicalAlpha)

    const absoluteDraft = `@${canonicalExternal}/${outsideFile}`
    const explicitCols = Math.max(180, Math.min(400, absoluteDraft.length + 24))
    expect(absoluteDraft.length).toBeLessThan(explicitCols - 4)

    const host = await scene.startHost()
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const client = await scene.startClient({
      label: 'explicit-host-file',
      cwd: clientCwd,
      home: clientHome,
      readAuthorityProof: true,
      cols: explicitCols,
      rows: 40,
    })
    expect(client.ready.sessionOpen).toBe(false)
    expect(client.ready.surfaceMounted).toBe(true)
    await waitForConfirmedDirectory(client, canonicalClientCwd, 'explicit client initial auto-confirmed directory')

    // Manually select Host alpha through `/sessions` -> `Add directory`
    await waitForDraft(client, '', 'explicit client empty composer before /sessions')
    await client.type('/sessions')
    await waitForDraft(client, '/sessions', 'explicit client typed /sessions')
    await client.press('Enter')
    await waitForFrame(client, 'Sessions ·', 'explicit client Workspace tree')
    await waitForFrame(client, 'Add directory', 'explicit client Add directory row')
    await client.press('Home')
    const startedSelect = Date.now()
    for (;;) {
      const f = await frameText(client)
      if (f.split('\n').some(line => line.includes('>') && line.includes('Add directory'))) break
      if (Date.now() - startedSelect >= 60_000) throw new Error('explicit client did not select Add directory')
      await sleep(50)
    }
    await client.press('Enter')
    await waitForFrame(client, 'Host directory:', 'explicit client inline Host editor')
    await waitForFrame(client, canonicalHostHome, 'explicit client Host home prefill')
    await client.type(alphaName)
    await waitForFrame(client, `> ${alphaName}/`, 'explicit client Host alpha candidate')
    await client.press('Tab')
    await waitForFrame(client, `${alphaName}/`, 'explicit client accepted Host alpha path')
    await client.press('Enter')
    await waitForFrame(client, 'Directory added:', 'explicit client registered Host alpha')
    await client.press('Escape')
    await waitForFrameGone(client, 'Sessions ·', 'explicit client closed Browser')
    await waitForConfirmedDirectory(client, canonicalAlpha, 'explicit client confirmed Host alpha')

    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()
    const workspacesBefore = await readWorkspaceBaseline(client, 'explicit client before queries')

    // 1. Bare `@scope-marker-` stays scoped to the selected Host alpha Workspace
    const bareStart = Date.now()
    await waitForDraft(client, '', 'explicit client empty before bare query')
    await client.type('@scope-marker-')
    const barePopup = await waitForFrame(client, insideFile, 'explicit client bare inside candidate')
    const bareLatencyMs = Date.now() - bareStart
    const bareMenu = belowComposer(barePopup)
    expect(bareMenu).toContain(insideFile)
    expect(bareMenu).not.toContain(outsideFile)
    expect(bareMenu).not.toContain(clientFile)
    await client.press('Escape')
    await waitForFrameGone(client, insideFile, 'explicit client bare popup closed')
    await client.press('Ctrl+U')
    await waitForDraft(client, '', 'explicit client cleared bare draft')

    // 2. Explicit relative `@../<external>/` preserves the typed relative spelling
    const relativeQuery = `@../${basename(canonicalExternal)}/`
    const relativeExpected = `${relativeQuery}${outsideFile}`
    await client.type(relativeQuery)
    await waitForFrame(client, outsideFile, 'explicit client relative outside candidate')
    await client.press('Tab')
    await waitForDraft(client, relativeExpected, 'explicit client accepted relative outside draft')
    await client.press('Ctrl+U')
    await waitForDraft(client, '', 'explicit client cleared relative draft')

    // 3. Explicit absolute `@<canonicalExternal>/` preserves the canonical absolute spelling
    const absoluteQuery = `@${canonicalExternal}/`
    await client.type(absoluteQuery)
    await waitForFrame(client, outsideFile, 'explicit client absolute outside candidate')
    await client.press('Tab')
    await waitForDraft(client, absoluteDraft, 'explicit client accepted absolute outside draft')
    await client.press('Ctrl+U')
    await waitForDraft(client, '', 'explicit client cleared absolute draft')

    // 4. Refused manual proposal never falls back to its own launch cwd (`alphaDir`)
    const refusedClient = await scene.startClient({
      label: 'refused-host-file',
      cwd: alphaDir,
      home: refusedHome,
      invalidWorkspacePath: true,
    })
    expect(refusedClient.ready.sessionOpen).toBe(false)
    await waitForFrame(refusedClient, 'Host directory unavailable', 'refused client unavailable notice')
    await refusedClient.type('@scope-marker-')
    await waitForFrame(refusedClient, '@scope-marker-', 'refused client typed @ query')
    // Bounded negative window anchored to the positive bare query latency above.
    await sleep(Math.max(2_000, bareLatencyMs * 3))
    const refusedFrame = await frameText(refusedClient)
    expect(belowComposer(refusedFrame)).not.toContain(insideFile)
    expect(composerDraftOf(refusedFrame)).toBe('@scope-marker-')
    expect(refusedClient.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)
    await refusedClient.press('Ctrl+U')
    await refusedClient.exitGracefully()

    // 5. No Session, log or extra Workspace was created; same Host survives
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)
    expect(await readWorkspaceBaseline(client, 'explicit client after queries')).toEqual(workspacesBefore)
    expect(client.readRecords()
      .filter(record => record?.m4b2s === 'surface-status')
      .some(record => record.sessionOpen === true)).toBe(false)

    await client.exitGracefully()
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost?.hostPid).toBe(hostPid)
    expect(hostAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await scene.dispose()
    } catch (cleanupError) {
      if (primary !== undefined) {
        throw new AggregateError([primary, cleanupError], 'explicit host-file test failed and Scene cleanup also failed')
      }
      throw cleanupError
    }
  }
})
