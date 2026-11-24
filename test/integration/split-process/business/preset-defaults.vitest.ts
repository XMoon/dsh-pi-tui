/**
 * Split-process business anchor: preset default persistence across a real Host
 * restart.
 *
 * The evidence is the product's own `/preset` picker, the real Host Config
 * writer and roster readback, the durable `agent-preset/selected` Session event
 * and a cold start of the SAME installed Profile. No configuration file is
 * written by the test and no picker label is treated as the write authority.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const TARGET_PRESET = 'minimal'
const TARGET_ROW = 'Minimal mode (minimal)'

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

/** One row containing `fact` from the CURRENT painted frame. */
function rowWith(frame: string, fact: string, label: string): string {
  const row = frame.split('\n').find(value => value.includes(fact))
  if (row === undefined) throw new Error(`${label}: no current row carries ${JSON.stringify(fact)}`)
  return row
}

async function openCatalog(client: SplitProcessClient, label: string): Promise<void> {
  await closeCatalog(client, `${label} previous catalog`)
  await client.press('Ctrl+U')
  await client.submit('/preset')
  await waitForFrame(client, 'Agent presets', `${label} catalog opened`)
  await waitForFrame(client, 'Standard mode (standard)', `${label} live roster`)
  await waitForFrameGone(client, 'Loading agent presets', `${label} roster hydrated`)
}

async function closeCatalog(client: SplitProcessClient, label: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await frameText(client)).includes('Agent presets')) return
    await client.press('Escape')
    await sleep(250)
  }
  if ((await frameText(client)).includes('Agent presets')) {
    throw new Error(`${label}: the preset catalog survived the Esc ladder`)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Test-owned teardown of the real preset UI before the Client leaves. */
async function dismissSplitUi(client: SplitProcessClient): Promise<void> {
  if (client.closed) return
  const state = await client.state().catch(() => undefined)
  if (state !== undefined && state.exited) return
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const frame = await client.text().catch(() => '')
    if (!frame.includes('Agent presets')) break
    await client.press('Escape')
    await sleep(200)
  }
  await client.press('Ctrl+U')
  await sleep(100)
}

async function waitForReleaseFile(path: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (existsSync(path)) return
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`the external sibling release ${path} never appeared`)
    }
    await sleep(100)
  }
}

async function waitForNotice(client: SplitProcessClient, notice: string, label: string): Promise<void> {
  const started = Date.now()
  for (;;) {
    const frame = (await frameText(client)).replace(/\s+/gu, ' ')
    if (frame.includes(notice)) return
    if (Date.now() - started >= 120_000) {
      throw new Error(`${label}: the real result notice ${JSON.stringify(notice)} never appeared`)
    }
    await sleep(50)
  }
}

test('persists the preset default, updates the current blank session, and reads it after a cold Host restart', async () => {
  const scene = await createSplitProcessScene()
  let testError: unknown
  const uiClients: SplitProcessClient[] = []
  try {
    const root = scene.workDir
    const workspace = join(root, 'preset-workspace')
    const currentHome = join(root, 'preset-current-home')
    const readbackHome = join(root, 'preset-readback-home')
    for (const directory of [workspace, currentHome, readbackHome]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    }

    const idsBefore = new Set(await scene.sessionIds())
    const host = await scene.startHost()
    const client = await scene.startClient({ label: 'preset-current', cwd: workspace, home: currentHome })
    uiClients.push(client)
    expect(client.ready.transport).toBe('connected')
    expect(client.ready.surfaceMounted).toBe(true)
    expect(client.ready.sessionOpen).toBe(false)
    expect(client.ready.hostPid).toBe(host.ready.localHost?.hostPid)
    const beforeRestartHost = (await scene.hostStatus(host)).localHost

    // Probe-only sibling window: a second independent real Scene waits at its
    // authenticated Host+Client checkpoint until the external probe releases it.
    const siblingReleaseFile = process.env.SPLIT_VITEST_PROCESS_PROBE_SIBLING_RELEASE
    if (siblingReleaseFile !== undefined && siblingReleaseFile !== '') {
      await scene.report('process-probe-sibling-ready', {
        workerPid: process.pid,
        hostPid: client.ready.hostPid,
        hostInstanceId: client.ready.instanceId,
        clientId: client.clientId,
        clientSessionId: client.sessionId,
        businessPid: client.ready.businessPid,
      })
      await waitForReleaseFile(siblingReleaseFile, 300_000)
      await scene.report('process-probe-sibling-released', { workerPid: process.pid })
    }

    if (process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID !== undefined
      && process.env.SPLIT_VITEST_PARALLEL_AUDIT_RUN_ID !== '') {
      await scene.parallelReady('preset-defaults', host, client)
      await scene.parallelRelease('preset-defaults')
    }

    // Real baseline: the live Catalog is the authority for the effective
    // default, and a clean profile must NOT already default to the target.
    await openCatalog(client, 'preset baseline')
    const baselineFrame = await frameText(client)
    const defaultRow = rowWith(baselineFrame, '[default]', 'preset baseline')
    expect(defaultRow).toContain('Standard mode (standard)')
    expect(defaultRow).not.toContain(TARGET_ROW)
    expect(rowWith(baselineFrame, TARGET_ROW, 'preset baseline target row')).not.toContain('[default]')
    await closeCatalog(client, 'preset baseline')

    // A real blank Session through `/new`.
    await client.submit('/new')
    const opened = await client.waitForSurfaceStatus(
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'the real blank Session',
    )
    const sessionId = String(opened.openSessionId)
    expect(idsBefore.has(sessionId)).toBe(false)
    const idsAfterNew = await scene.sessionIds()
    expect(idsAfterNew.filter(id => !idsBefore.has(id))).toEqual(idsAfterNew.includes(sessionId) ? [sessionId] : [])
    const selectionBaseline = (scene.sessionEvents(sessionId) ?? [])
      .filter(event => event.type === 'agent-preset/selected').length
    expect((scene.sessionEvents(sessionId) ?? []).some(event => event.type === 'turn/start')).toBe(false)
    expect((await scene.hostStatus(host)).localHost?.instanceId).toBe(beforeRestartHost?.instanceId)

    // The real `Set default` path: picker → target → two real Tab steps →
    // the CURRENT painted `Set default [Enter]` focus → one Enter.
    await openCatalog(client, 'preset set default')
    await waitForFrame(client, 'Use session', 'set default live action label')
    await client.type(TARGET_PRESET)
    await waitForFrame(client, TARGET_ROW, 'set default target filter')
    await client.press('Tab')
    await waitForFrame(client, 'Use session [Enter]', 'the current Use session action focus')
    await client.press('Tab')
    const focusFrame = await waitForFrame(client, 'Set default [Enter]', 'the current Set default action focus')
      .catch(async () => await waitForFrame(client, 'Set [Enter]', 'the current compact Set action focus'))
    if (!focusFrame.includes('Set default [Enter]') && !focusFrame.includes('Set [Enter]')) {
      throw new Error(`preset set default: the current action focus is not Set default; frame=${JSON.stringify(focusFrame.slice(-2000))}`)
    }
    await client.press('Enter')
    await waitForFrameGone(client, 'Agent presets', 'preset catalog closed after the real write')
    await waitForNotice(client, 'current blank session switched to minimal', 'preset set default notice')

    const afterSet = await client.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionId,
      'the same blank Session after the default write',
      60_000,
    )
    expect(afterSet.sessionOpen).toBe(true)
    expect((await scene.hostStatus(host)).localHost?.instanceId).toBe(beforeRestartHost?.instanceId)
    expect(await scene.sessionIds()).toEqual(idsAfterNew)

    const selected = await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'agent-preset/selected' && event.data?.agentPreset === TARGET_PRESET,
      'the durable agent-preset/selected event',
    )
    expect(selected.data?.agentPreset).toBe(TARGET_PRESET)
    const selectionEvents = (scene.sessionEvents(sessionId) ?? [])
      .filter(event => event.type === 'agent-preset/selected')
    expect(selectionEvents.length).toBe(selectionBaseline + 1)
    expect((scene.sessionEvents(sessionId) ?? []).some(event => event.type === 'turn/start')).toBe(false)

    // The reopened live Catalog reads the switched relationship back from the
    // Host-authoritative Session fact, never from the closed panel's notice.
    await openCatalog(client, 'preset current readback')
    await client.type(TARGET_PRESET)
    await waitForFrame(client, TARGET_ROW, 'current preset target filter')
    expect(rowWith(await frameText(client), TARGET_ROW, 'preset current readback')).toContain('[current]')
    await closeCatalog(client, 'preset current readback')
    await client.press('Ctrl+U')
    await client.submit('/exit')
    expect(await client.close()).toEqual({ code: 0, signal: null })

    // Cold restart of the SAME installed Profile/DSH_HOME: a new real Host
    // instance and kernel birth, the same scope/build and the persisted default.
    await scene.stopHost(host)
    const restarted = await scene.startHost()
    const restartedStatus = await scene.hostStatus(restarted)
    expect(restarted.ready.localHost?.instanceId).not.toBe(beforeRestartHost?.instanceId)
    expect(restarted.ready.localHost?.hostPid).not.toBe(beforeRestartHost?.hostPid)
    expect(restarted.ready.localHost?.scopeId).toBe(scene.scope.scopeId)
    expect(restarted.ready.localHost?.buildId).toBe(scene.scope.buildId)
    if (process.platform === 'darwin') {
      expect(restartedStatus.localHost?.hostKernelIdentity?.uniqueId)
        .not.toBe(beforeRestartHost?.hostKernelIdentity?.uniqueId)
    } else {
      expect(restartedStatus.localHost?.hostStarttime).not.toBe(beforeRestartHost?.hostStarttime)
    }

    const readback = await scene.startClient({ label: 'preset-readback', cwd: workspace, home: readbackHome })
    uiClients.push(readback)
    expect(readback.ready.sessionOpen).toBe(false)
    expect(readback.ready.surfaceMounted).toBe(true)
    expect(readback.ready.hostPid).toBe(restarted.ready.localHost?.hostPid)
    await openCatalog(readback, 'cold restart default readback')
    await readback.type(TARGET_PRESET)
    await waitForFrame(readback, TARGET_ROW, 'cold restart target filter')
    const readbackFrame = await frameText(readback)
    const readbackRow = rowWith(readbackFrame, TARGET_ROW, 'cold restart default readback')
    expect(readbackRow).toContain('[default]')
    // A sessionless Client has no current Session relationship to paint.
    expect(readbackFrame).not.toContain('[current]')
    await closeCatalog(readback, 'cold restart default readback')

    // No extra Session appeared and the old Session's selection was not rewritten.
    expect(await scene.sessionIds()).toEqual(idsAfterNew)
    const persistedSelections = (scene.sessionEvents(sessionId) ?? [])
      .filter(event => event.type === 'agent-preset/selected' && event.data?.agentPreset === TARGET_PRESET)
    expect(persistedSelections.length).toBe(1)
    expect((scene.sessionEvents(sessionId) ?? []).some(event => event.type === 'turn/start')).toBe(false)

    await readback.press('Ctrl+U')
    await readback.submit('/exit')
    expect(await readback.close()).toEqual({ code: 0, signal: null })
    await scene.stopHost(restarted)
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
          'the preset-default business test failed and its Scene cleanup also failed')
      }
      throw new AggregateError(teardownErrors,
        'the preset-default business test passed but its Scene cleanup failed')
    }
  }
})
