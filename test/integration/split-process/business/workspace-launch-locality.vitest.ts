/**
 * Split-process business anchor: public launch directory replacement and
 * workspace-object route authentication boundary.
 *
 * Uses one shared real public daemon Scene on Linux and macOS:
 *   1. An unauthenticated POST to `/api/pi-tui.workspace-object` returns
 *      401 or 403 and leaks no directory object identity or path.
 *   2. Renaming and recreating the Client's launch directory invalidates its
 *      automatic mount-time proof: the first submit opens the unselected
 *      Workspace tree with zero durable Session writes.
 *   3. Explicitly selecting the recreated path through `Add directory` +
 *      Verify authorizes it, and a subsequent deliberate submit creates
 *      exactly one durable Session and Turn on the same Host.
 */

import { mkdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type PublicDaemonLaunch,
  type SessionEvent,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const MAX_REFUSAL_BODY_BYTES = 1024

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯')
    && !line.includes('[connection]'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(
  launch: PublicDaemonLaunch,
  expected: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await launch.text())
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

async function waitForFrame(
  launch: PublicDaemonLaunch,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await launch.text()
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: condition not met within ${String(timeoutMs)}ms; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForConfirmedDirectory(
  launch: PublicDaemonLaunch,
  canonicalPath: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  await waitForFrame(launch, frame => {
    const rows = frame.split('\n')
    const labelRow = rows.find(row => row.includes('Host directory:'))
    if (labelRow === undefined) return false
    const factsStart = labelRow.indexOf('Host directory:')
    const flat = rows
      .map(row => (row.length > factsStart ? row.slice(factsStart) : ''))
      .join('')
      .replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/gu, '')
      .replace(/\s+/gu, '')
    return !flat.includes('CheckingHostdirectory:')
      && !flat.includes('Hostdirectoryunavailable:')
      && flat.includes(flatPath)
  }, label, timeoutMs)
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`refused response body exceeded ${String(maxBytes)} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function messageText(message: Record<string, any> | undefined): string {
  return (message?.content ?? [])
    .map((part: Record<string, any>) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('')
}

function isHumanUserEvent(event: SessionEvent, prompt: string): boolean {
  return event.type === 'user/message'
    && event.data?.source?.kind === 'user'
    && messageText(event.data) === prompt
}

function eventSeq(event: SessionEvent): number | undefined {
  const seq = (event as Record<string, any>).seq
  return typeof seq === 'number' ? seq : undefined
}

async function waitForCompletedTurn(
  scene: SplitProcessScene,
  sessionId: string,
  prompt: string,
  answer: string,
  label: string,
): Promise<{ user: SessionEvent; turn: number; end: SessionEvent }> {
  const user = await scene.waitForSessionEvent(
    sessionId, 0, event => isHumanUserEvent(event, prompt), `${label}: durable human user/message`)
  const userSeq = eventSeq(user)
  expect(userSeq, `${label}: durable user sequence`).toBeTypeOf('number')
  let start: SessionEvent | undefined
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    start = (scene.sessionEvents(sessionId) ?? [])
      .filter(event => event.type === 'turn/start' && (eventSeq(event) ?? Number.POSITIVE_INFINITY) < userSeq!)
      .at(-1)
    if (start !== undefined) break
    await sleep(25)
  }
  expect(start, `${label}: enclosing turn/start`).toBeDefined()
  const turn = start!.data?.turn
  expect(turn, `${label}: numeric turn identity`).toBeTypeOf('number')
  const end = await scene.waitForSessionEvent(
    sessionId, 0,
    event => event.type === 'turn/end' && event.data?.turn === turn && event.data?.reason?.kind === 'completed',
    `${label}: completed turn/end`,
  )
  await scene.waitForSessionEvent(
    sessionId, 0,
    event => event.type === 'assistant/message' && event.data?.turn === turn && messageText(event.data?.message).includes(answer),
    `${label}: durable assistant answer in the same Turn`,
  )
  return { user, turn: turn as number, end }
}

test('rejects a replaced launch directory and creates only after explicit Workspace selection', async () => {
  const scene = await createSplitProcessScene()
  let launch: PublicDaemonLaunch | undefined
  let primary: unknown
  try {
    launch = await scene.startPublicDaemon({
      label: 'launch-directory-replacement',
      backend: 'daemon',
      ownWorkspace: true,
      cols: 180,
      rows: 40,
    })
    expect(launch.ready).toBe(true)
    const origin = launch.host?.origin
    const instanceId = launch.host?.instanceId
    const hostPid = launch.host?.pid
    expect(origin, 'public Host publication must expose its origin').toBeTypeOf('string')
    expect(origin).not.toBe('')
    expect(instanceId, 'public Host publication must expose its instanceId').toBeTypeOf('string')
    expect(instanceId).not.toBe('')

    const canonicalLaunchCwd = realpathSync(launch.launchCwd)
    await waitForConfirmedDirectory(launch, canonicalLaunchCwd, 'initial public Welcome confirmed launch directory')
    await waitForComposerDraft(launch, '', 'initial public composer ready')

    const originalStat = statSync(canonicalLaunchCwd, { bigint: true })
    const sessionsBefore = [...await scene.sessionIds()].sort()
    const logCountBefore = scene.hostSessionLogCount()

    // 1. Unauthenticated workspace-object route negative control (no cookies/tokens)
    const routeResponse = await fetch(`${origin!}/api/pi-tui.workspace-object`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId, path: canonicalLaunchCwd }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    expect([401, 403]).toContain(routeResponse.status)
    const refusalBody = await readBoundedResponseText(routeResponse, MAX_REFUSAL_BODY_BYTES)
    expect(refusalBody).not.toMatch(/"device"|"inode"/u)
    expect(refusalBody).not.toContain(String(originalStat.ino))
    expect(refusalBody).not.toContain(canonicalLaunchCwd)

    // 2. Replace the launch directory object in place under the Scene-owned parent
    const displacedDir = join(dirname(canonicalLaunchCwd), 'original-launch-directory')
    renameSync(canonicalLaunchCwd, displacedDir)
    mkdirSync(canonicalLaunchCwd, { mode: 0o700 })
    const displacedStat = statSync(displacedDir, { bigint: true })
    const replacedStat = statSync(canonicalLaunchCwd, { bigint: true })
    expect(displacedStat.dev).toBe(originalStat.dev)
    expect(displacedStat.ino).toBe(originalStat.ino)
    expect(replacedStat.dev !== originalStat.dev || replacedStat.ino !== originalStat.ino).toBe(true)

    const refusedPrompt = 'launch directory replacement must not submit'
    await launch.type(refusedPrompt)
    await waitForComposerDraft(launch, refusedPrompt, 'typed refused prompt before Enter')
    await launch.press('Enter')

    // Revoked automatic proof opens the unselected full Workspace tree with zero durable writes.
    await waitForFrame(
      launch,
      frame => frame.includes('Sessions ·') && frame.includes('Add directory'),
      'unselected Workspace tree after launch directory replacement',
    )
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)

    // 3. Explicit manual selection via Add directory -> Verify -> Esc -> Welcome
    await launch.press('Home')
    await waitForFrame(
      launch,
      frame => frame.split('\n').some(line => line.includes('>') && line.includes('Add directory')),
      'selected Add directory row after replacement',
    )
    await launch.press('Enter')
    await waitForFrame(launch, frame => frame.includes('Host directory:'), 'inline Host editor after replacement')
    await launch.press('Ctrl+U')
    await waitForFrame(
      launch,
      frame => {
        const line = frame.split('\n').find(row => row.includes('Host directory:'))
        return line !== undefined && !line.includes(canonicalLaunchCwd)
      },
      'cleared inline Host editor before typing recreated path',
    )
    await launch.type(canonicalLaunchCwd)
    await waitForFrame(launch, frame => frame.includes(canonicalLaunchCwd), 'typed recreated canonical path')
    await launch.press('Enter')
    await waitForFrame(
      launch,
      frame => frame.includes('Sessions ·') && !frame.includes('Cancel [Esc]'),
      'ordinary Add Verify settled back to Browse tree',
    )
    await launch.press('Escape')
    await waitForFrame(launch, frame => !frame.includes('Sessions ·'), 'Browser closed back to Welcome')
    await waitForConfirmedDirectory(launch, canonicalLaunchCwd, 'Welcome confirmed explicitly selected Host directory')

    // Still zero durable Sessions/logs after explicit Verify.
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBefore)
    expect(scene.hostSessionLogCount()).toBe(logCountBefore)

    // Clear any leftover draft and submit a distinct prompt explicitly.
    const existingDraft = composerDraft(await launch.text())
    if (existingDraft !== undefined && existingDraft !== '' && !/^…{1,2}$/u.test(existingDraft)) {
      await launch.press('Ctrl+U')
    }
    await waitForComposerDraft(launch, '', 'empty composer before explicit post-replacement submit')

    const acceptedPrompt = 'explicit workspace selection after replacement'
    await launch.type(acceptedPrompt)
    await waitForComposerDraft(launch, acceptedPrompt, 'typed accepted post-replacement prompt')
    const beforeSubmitSet = new Set(sessionsBefore)
    await launch.press('Enter')

    const newSessionId = await scene.waitForNewSessionId(beforeSubmitSet, 'explicitly authorized post-replacement Session')
    const header = await scene.waitForHostSessionHeader(newSessionId, 'post-replacement durable header')
    expect((header as Record<string, any>).cwd).toBe(canonicalLaunchCwd)
    const settled = await waitForCompletedTurn(
      scene, newSessionId, acceptedPrompt, 'stub answer', 'post-replacement')

    const finalEvents = scene.sessionEvents(newSessionId) ?? []
    expect(finalEvents.filter(event => isHumanUserEvent(event, acceptedPrompt))).toHaveLength(1)
    expect(finalEvents
      .filter(event => event.type === 'user/message'
        && messageText(event.data) === acceptedPrompt
        && event.data?.source?.kind !== 'user')
      .map(event => event.data?.source?.kind ?? 'missing')).toEqual([])
    expect(finalEvents.some(event => event.type === 'turn/end'
      && event.data?.turn === settled.turn && event.data?.reason?.kind === 'completed')).toBe(true)
    expect(finalEvents.some(event => JSON.stringify(event.data ?? {}).includes(refusedPrompt))).toBe(false)
    expect([...await scene.sessionIds()].sort()).toEqual([...sessionsBefore, newSessionId].sort())
    expect(scene.hostSessionLogCount()).toBe(logCountBefore + 1)

    // 4. Normal exit on the same Host
    await waitForComposerDraft(launch, '', 'empty composer before /exit')
    await launch.submit('/exit')
    const exit = await launch.waitForExit()
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()
    await launch.close()

    const kernelAfter = await launch.kernelState()
    expect(kernelAfter.hostState).toBe('alive')
    expect(kernelAfter.hostPid).toBe(hostPid)
    expect(kernelAfter.hostInstanceId).toBe(instanceId)
    await launch.stopHost()
  } catch (error) {
    primary = error
    throw error
  } finally {
    const cleanupErrors: Error[] = []
    if (launch !== undefined && !launch.closed) {
      try {
        await launch.reclaim()
      } catch (reclaimError) {
        cleanupErrors.push(asError(reclaimError))
      }
    }
    try {
      await scene.dispose()
    } catch (disposeError) {
      cleanupErrors.push(asError(disposeError))
    }
    if (cleanupErrors.length > 0) {
      if (primary !== undefined) {
        throw new AggregateError([primary, ...cleanupErrors], 'workspace-launch-locality failed and cleanup also failed')
      }
      throw new AggregateError(cleanupErrors, 'workspace-launch-locality passed but cleanup failed')
    }
  }
})
