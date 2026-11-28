/**
 * Split-process optional anchor: Client Git branch locality across the
 * sessionless -> live Remote Session transition.
 *
 * Uses a private Client workspace with a synthetic `.git/HEAD` branch name:
 * the sessionless footer visibly paints the local branch (positive control),
 * then opening a real Host Session keeps the Host-authoritative cwd basename
 * in the same footer while omitting the Client-local branch.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

const LOCAL_BRANCH = 'workspace-local-branch'

function composerDraft(frame: string): string | undefined {
  const lines = frame.split('\n')
  const marker = lines.findLastIndex(line => line.trimStart().startsWith('❯')
    && !line.includes('[connection]'))
  if (marker < 0) return undefined
  const at = lines[marker]!.indexOf('❯')
  return lines[marker]!.slice(at + '❯'.length).trim()
}

async function waitForComposerDraft(
  client: SplitProcessClient,
  expected: string,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    const draft = composerDraft(await client.text())
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
  client: SplitProcessClient,
  predicate: (frame: string) => boolean,
  label: string,
  timeoutMs = 120_000,
): Promise<string> {
  const started = Date.now()
  for (;;) {
    const frame = await client.text()
    if (predicate(frame)) return frame
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${label}: condition not met within ${String(timeoutMs)}ms; frame=${JSON.stringify(frame.slice(-2000))}`)
    }
    await sleep(50)
  }
}

async function waitForConfirmedDirectory(
  client: SplitProcessClient,
  canonicalPath: string,
  label: string,
  timeoutMs = 120_000,
): Promise<void> {
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  await waitForFrame(client, frame => {
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

function footerRegion(frame: string): string {
  const lines = frame.split('\n')
  let bottom = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^─{10,}$/u.test(lines[index]!.trim())) bottom = index
  }
  return bottom < 0 ? '' : lines.slice(bottom + 1).join('\n')
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'git-branch-locality failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('shows the Client branch before a Session and never attributes it to a live Remote Session', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const clientWorkspace = join(scene.workDir, 'git-locality-workspace')
    const clientHome = join(scene.workDir, 'git-locality-home')
    mkdirSync(join(clientWorkspace, '.git'), { recursive: true, mode: 0o700 })
    mkdirSync(clientHome, { recursive: true, mode: 0o700 })
    const headFile = join(clientWorkspace, '.git', 'HEAD')
    writeFileSync(headFile, `ref: refs/heads/${LOCAL_BRANCH}\n`, { mode: 0o600 })
    expect(readFileSync(headFile, 'utf8').trim()).toBe(`ref: refs/heads/${LOCAL_BRANCH}`)

    const canonicalWorkspace = realpathSync(clientWorkspace)
    const workspaceBasename = basename(canonicalWorkspace)

    const host = await scene.startHost()
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const client = await scene.startClient({
      label: 'git-branch-locality',
      cwd: clientWorkspace,
      home: clientHome,
      cols: 140,
      rows: 40,
    })
    expect(client.ready.sessionOpen).toBe(false)
    expect(client.ready.surfaceMounted).toBe(true)
    expect(client.ready.hostPid).toBe(hostPid)
    expect(client.ready.businessPid).not.toBe(hostPid)
    await waitForConfirmedDirectory(client, canonicalWorkspace, 'git-branch-locality confirmed Host directory')

    // Positive control: the sessionless footer paints BOTH the workspace basename
    // and the synthetic Client-local branch in the same painted frame.
    const sessionlessFrame = await waitForFrame(client, frame => {
      const footer = footerRegion(frame)
      return footer.includes(workspaceBasename) && footer.includes(LOCAL_BRANCH)
    }, 'sessionless footer paints workspace cwd and Client-local branch')
    expect(footerRegion(sessionlessFrame)).toContain(LOCAL_BRANCH)

    // Submit an ordinary prompt to open a real live Host Session.
    const sessionsBefore = new Set(await scene.sessionIds())
    const prompt = 'verify remote git branch locality'
    await waitForComposerDraft(client, '', 'empty composer before first prompt')
    await client.type(prompt)
    await waitForComposerDraft(client, prompt, 'typed first prompt')
    await client.press('Enter')

    const sessionId = await scene.waitForNewSessionId(sessionsBefore, 'new Host Session for git branch locality')
    const header = await scene.waitForHostSessionHeader(sessionId, 'durable Host Session header')
    expect((header as Record<string, any>).cwd).toBe(canonicalWorkspace)
    await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'assistant/message' && JSON.stringify(event.data ?? {}).includes('stub answer'),
      'first Host Turn offline answer',
    )
    await scene.waitForSessionEvent(
      sessionId,
      0,
      event => event.type === 'turn/end',
      'first Host Turn completed',
    )

    // Negative control in the live Remote Session: the same footer keeps the
    // Host-authoritative cwd basename and drops the Client-local branch.
    const liveFrame = await waitForFrame(client, frame => {
      const footer = footerRegion(frame)
      return footer.includes(workspaceBasename) && !footer.includes(LOCAL_BRANCH)
    }, 'live Remote Session footer keeps cwd and omits Client-local branch')
    expect(footerRegion(liveFrame)).toContain(workspaceBasename)
    expect(footerRegion(liveFrame)).not.toContain(LOCAL_BRANCH)

    await client.exitGracefully()
    const hostAfter = await scene.hostStatus(host)
    expect(hostAfter.localHost?.hostPid).toBe(hostPid)
    expect(hostAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})
