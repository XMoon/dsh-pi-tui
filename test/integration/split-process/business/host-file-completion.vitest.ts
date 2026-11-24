/**
 * Split-process business anchor: Host workspace file completion before the
 * first Session.
 *
 * The only evidence here is a real installed candidate, a real Supervisor-owned
 * Host, two real PTY Clients and the product's own keyboard/completion/Session
 * persistence path. Nothing types into an internal method, writes a Profile
 * directly or fakes a Workspace.
 */

import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
