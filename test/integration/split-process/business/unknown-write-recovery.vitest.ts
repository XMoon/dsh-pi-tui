import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessHostHandle,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const fixtureHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  waitForC1WorkEvent(root: string, predicate: (event: Record<string, any>) => boolean, label: string, timeoutMs?: number): Promise<Record<string, any>>
}
const sessionHelpers = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-sessions.mjs')).href
) as {
  hostUserTexts(events: Record<string, any>[]): string[]
  hostAssistantHasText(events: Record<string, any>[], text: string): boolean
}

function clientDirectories(scene: SplitProcessScene, label: string): { home: string; cwd: string } {
  const root = join(scene.workDir, 'clients', label)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  // Node's mkdirSync is the only creator; paths are inside the Supervisor root.
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return { home, cwd }
}

async function waitFrame(client: SplitProcessClient, text: string, label: string, timeoutMs = 120_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (frame.includes(text)) return frame
    if (Date.now() - started >= timeoutMs) throw new Error(`${label}: ${JSON.stringify(text)} not painted; frame=${JSON.stringify(frame.slice(-2000))}`)
    await sleep(50)
  }
}

function composerOf(frame: string): string | undefined {
  const lines = frame.split('\n')
  const rules: number[] = []
  lines.forEach((line, index) => { if (/^─+$/u.test(line.trim())) rules.push(index) })
  if (rules.length < 2) return undefined
  const top = rules.at(-2)!
  const bottom = rules.at(-1)!
  return lines.slice(top + 1, bottom).join('\n')
}

async function exitChat(client: SplitProcessClient, label: string): Promise<void> {
  if (client.closed) return
  await client.exitGracefully()
  const facts = await client.close()
  expect(facts.code, `${label} exit code`).toBe(0)
  expect(facts.signal, `${label} exit signal`).toBeNull()
}

async function startHeldSession(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  client: SplitProcessClient,
  prompt: string,
  label: string,
): Promise<string> {
  const before = new Set(await scene.sessionIds())
  await client.submit(prompt)
  const sessionId = await scene.waitForNewSessionId(before, `${label} Session`)
  await fixtureHelpers.waitForC1WorkEvent(host.workloadRoot!, event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
    `${label} held Turn`)
  return sessionId
}

async function assertCarrierLoss(client: SplitProcessClient, label: string): Promise<void> {
  const lost = await client.waitForSurfaceStatus(record => record.transport !== 'connected', `${label} carrier loss`, 120_000)
  expect(['disconnected', 'connecting']).toContain(lost.transport)
}

async function recoverAndResume(
  scene: SplitProcessScene,
  host: SplitProcessHostHandle,
  oldClient: SplitProcessClient,
  sessionId: string,
  label: string,
  prompt: string,
): Promise<void> {
  await oldClient.signal('SIGTERM')
  await oldClient.waitForExit(120_000)
  await oldClient.close()
  const discovery = await scene.startClient({
    label: `${label}-discovery`,
    ...clientDirectories(scene, `${label}-discovery`),
    recoverFromHostId: host.hostId,
  })
  expect(discovery.ready.hostPid).not.toBe(host.ready.localHost.hostPid)
  expect(discovery.ready.instanceId).not.toBe(host.ready.localHost.instanceId)
  expect(discovery.ready.sessionOpen).toBe(false)
  const newHostPid = discovery.ready.hostPid
  const newInstanceId = discovery.ready.instanceId
  const discoveryId = discovery.clientId
  await exitChat(discovery, `${label} discovery`)
  const resumed = await scene.startClient({
    label: `${label}-resume`,
    ...clientDirectories(scene, `${label}-resume`),
    sessionId,
    attachRecoveredHostId: discoveryId,
  })
  expect(resumed.ready.hostPid).toBe(newHostPid)
  expect(resumed.ready.instanceId).toBe(newInstanceId)
  expect(resumed.ready.sessionOpen).toBe(true)
  await waitFrame(resumed, prompt, `${label} history`)
  const settled = await scene.waitForSessionEvent(sessionId, 0,
    event => event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted',
    `${label} orphan settlement`, 120_000)
  expect(settled.data?.reason?.kind).toBe('interrupted')
  const events = scene.sessionEvents(sessionId) ?? []
  const starts = events.filter(event => event.type === 'turn/start')
  const ends = events.filter(event => event.type === 'turn/end')
  expect(starts).toHaveLength(1)
  expect(ends).toHaveLength(1)
  expect(settled.data?.turn).toBe(starts[0]?.data?.turn)
  expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(sessionHelpers.hostUserTexts(events).filter(text => text === prompt)).toHaveLength(1)
  expect(sessionHelpers.hostAssistantHasText(events, 'long-turn answer')).toBe(false)
  expect((await resumed.text()).includes('long-turn answer')).toBe(false)
  await exitChat(resumed, `${label} resumed`)
  const stop = await scene.reclaimDiscoveredHost(discovery)
  expect(stop.normalStop).toBe(true)
  expect(stop.reclaimed).toBe(true)
  expect(stop.registryRemoved).toBe(true)
  expect(stop.scratchEntries).toEqual([])
}

test('SIGKILL after an accepted write never fakes settlement and cold-resumes the Session once', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'long-turn', crashSignal: 'SIGKILL' })
    client = await scene.startClient({ label: 't65', ...clientDirectories(scene, 't65') })
    const sessionId = await startHeldSession(scene, host, client, 't65 prompt', 'T65')
    await scene.waitForSessionEvent(sessionId, 0, event => event.type === 'turn/start', 'T65 turn/start')
    const durable = scene.sessionEvents(sessionId) ?? []
    expect(sessionHelpers.hostUserTexts(durable).filter(text => text === 't65 prompt')).toHaveLength(1)
    await scene.signalEntry(host, 'SIGKILL')
    const terminal = await scene.finishEntry(host)
    expect(terminal.exit).toEqual({ code: null, signal: 'SIGKILL' })
    await assertCarrierLoss(client, 'T65')
    const afterKill = scene.sessionEvents(sessionId) ?? []
    expect(afterKill.some(event => event.type === 'turn/end')).toBe(false)
    expect(sessionHelpers.hostAssistantHasText(afterKill, 'long-turn answer')).toBe(false)
    expect((await client.text()).includes('long-turn answer')).toBe(false)
    await recoverAndResume(scene, host, client, sessionId, 't65', 't65 prompt')
    client = undefined
  } finally {
    await scene.dispose()
  }
})

test('ACK-dropped unknown write survives Host death and cold resume without replay', async () => {
  const scene = await createSplitProcessScene()
  let host: SplitProcessHostHandle | undefined
  let client: SplitProcessClient | undefined
  try {
    host = await scene.startHost({ scenario: 'long-turn', crashSignal: 'SIGKILL' })
    client = await scene.startClient({
      label: 't66',
      ...clientDirectories(scene, 't66'),
      dropPromptAck: true,
    })
    const token = 't66 unknown-write'
    const sessionId = await startHeldSession(scene, host, client, token, 'T66')
    await client.waitForRecord(record => record.m4b2s === 'qualification' && record.op === 'prompt-ack-dropped',
      'T66 ACK-drop witness', 120_000)
    const durable = scene.sessionEvents(sessionId) ?? []
    expect(sessionHelpers.hostUserTexts(durable).filter(text => text === token)).toHaveLength(1)
    let disposition: 'accepted' | 'unknown' | undefined
    const started = Date.now()
    while (Date.now() - started < 120_000) {
      const frame = await client.text()
      const composer = composerOf(frame)
      if (composer === undefined) throw new Error('T66 the current frame has no composer')
      const pending = frame.includes('Submitting…') || frame.includes('Queued…')
      if (!pending && composer.replace(/❯/gu, '').trim() === '') {
        expect(frame.includes('indeterminate')).toBe(false)
        disposition = 'accepted'
        break
      }
      if (!pending && composer.includes(token) && frame.includes('indeterminate')) {
        expect(composer.split(token).length - 1).toBe(1)
        disposition = 'unknown'
        break
      }
      await sleep(50)
    }
    expect(disposition, 'T66 composer/ACK settled disposition').toBeDefined()
    expect(client.readRecords().filter(record => record.m4b2s === 'qualification' && record.op === 'prompt-ack-dropped')).toHaveLength(1)
    await scene.signalEntry(host, 'SIGKILL')
    const terminal = await scene.finishEntry(host)
    expect(terminal.exit).toEqual({ code: null, signal: 'SIGKILL' })
    await assertCarrierLoss(client, 'T66')
    const afterKill = scene.sessionEvents(sessionId) ?? []
    expect(afterKill.some(event => event.type === 'turn/end')).toBe(false)
    expect(sessionHelpers.hostAssistantHasText(afterKill, 'long-turn answer')).toBe(false)
    expect((await client.text()).includes('long-turn answer')).toBe(false)
    await recoverAndResume(scene, host, client, sessionId, 't66', token)
    client = undefined
  } finally {
    await scene.dispose()
  }
})
