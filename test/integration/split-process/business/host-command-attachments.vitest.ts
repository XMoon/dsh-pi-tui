/**
 * Split-process business anchor: Host command attachment catalog discovery,
 * ordered mixed image/file delivery, undeclared/changed-source refusals and
 * sessionless first-command Session binding.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SessionEvent,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>

const { readC1WorkEvents, waitForC1WorkEvent } = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  readC1WorkEvents(root: string): WorkEvent[]
  waitForC1WorkEvent(
    root: string,
    predicate: (event: WorkEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<WorkEvent>
}

const PNG_1X1_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function splitFrame(frame: string): { composer: string; below: string } {
  const lines = frame.split('\n')
  const ruleIndices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^─{10,}$/u.test(lines[index]!.trim())) ruleIndices.push(index)
  }
  if (ruleIndices.length < 2) return { composer: '', below: '' }
  const top = ruleIndices.at(-2)!
  const bottom = ruleIndices.at(-1)!
  return {
    composer: lines.slice(top + 1, bottom).join('\n'),
    below: lines.slice(bottom + 1).join('\n'),
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

function deterministicBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) % 251
  return bytes
}

async function stageFileViaAttach(
  client: SplitProcessClient,
  filePath: string,
  label: string,
): Promise<string> {
  await waitForFrame(client, frame => splitFrame(frame).composer.includes('❯'), `${label}: composer ready`)
  const draft = `/attach ${filePath}`
  await client.type(draft)
  await waitForFrame(client, frame => splitFrame(frame).composer.includes(draft), `${label}: typed /attach`)
  await client.press('Enter')
  const pattern = /\[file #\d+ \([^)]+\)\]/u
  const frame = await waitForFrame(
    client,
    candidate => pattern.test(splitFrame(candidate).composer),
    `${label}: staged file placeholder`,
    30_000,
  )
  const match = splitFrame(frame).composer.match(pattern)
  expect(match, `${label}: missing file placeholder`).not.toBeNull()
  return match![0]
}

async function waitForCommandLifecycle(
  scene: SplitProcessScene,
  sessionId: string,
  commandId: string,
  marker: string,
  label: string,
): Promise<{ run: SessionEvent; done: SessionEvent }> {
  const run = await scene.waitForSessionEvent(
    sessionId,
    0,
    event => event.type === 'command/run' && (event.data as Record<string, any>)?.commandId === commandId,
    `${label}: durable command/run`,
  )
  const done = await scene.waitForSessionEvent(
    sessionId,
    0,
    event => event.type === 'command/done' && (event.data as Record<string, any>)?.commandId === commandId,
    `${label}: durable command/done`,
  )
  const events = scene.sessionEvents(sessionId) ?? []
  const prompted = events.some(event => event.type === 'user/message'
    && JSON.stringify(event.data ?? {}).includes(marker))
  expect(prompted, `${label}: command must not create a user/message prompt`).toBe(false)
  return { run, done }
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'host-command-attachments failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('delivers ordered Host command attachments once and refuses unsupported or changed sources', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostWorkspace = join(scene.workDir, 'command-attachments-workspace')
    const clientAHome = join(scene.workDir, 'cmd-client-a-home')
    const clientACwd = join(scene.workDir, 'cmd-client-a-cwd')
    const clientBHome = join(scene.workDir, 'cmd-client-b-home')
    const clientBCwd = join(scene.workDir, 'cmd-client-b-cwd')
    for (const dir of [hostWorkspace, clientAHome, clientACwd, clientBHome, clientBCwd]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalHostWorkspace = realpathSync(hostWorkspace)
    const canonicalClientACwd = realpathSync(clientACwd)
    const canonicalClientBCwd = realpathSync(clientBCwd)

    // 8MiB Client A file + same-named Host poison
    const sharedFileName = 'command-attachment-report.bin'
    const clientASource = deterministicBytes(7, 8 * 1024 * 1024)
    const clientASha256 = createHash('sha256').update(clientASource).digest('hex')
    const hostPoison = deterministicBytes(193, 8 * 1024 * 1024)
    const hostPoisonSha256 = createHash('sha256').update(hostPoison).digest('hex')
    expect(clientASha256).not.toBe(hostPoisonSha256)
    const clientAPath = join(canonicalClientACwd, sharedFileName)
    writeFileSync(clientAPath, clientASource, { mode: 0o600 })
    writeFileSync(join(canonicalHostWorkspace, sharedFileName), hostPoison, { mode: 0o600 })

    const imagePath = join(canonicalClientACwd, 'command-shot.png')
    writeFileSync(imagePath, PNG_1X1_BYTES, { mode: 0o600 })

    const changedPath = join(canonicalClientACwd, 'command-changed.bin')
    writeFileSync(changedPath, deterministicBytes(11, 256 * 1024), { mode: 0o600 })

    const clientBSource = deterministicBytes(29, 128 * 1024)
    const clientBSha256 = createHash('sha256').update(clientBSource).digest('hex')
    expect(clientBSha256).not.toBe(clientASha256)
    expect(clientBSha256).not.toBe(hostPoisonSha256)
    const clientBPath = join(canonicalClientBCwd, 'client-b-command-file.bin')
    writeFileSync(clientBPath, clientBSource, { mode: 0o600 })

    const host = await scene.startHost({ scenario: 'host-command-attachments' })
    expect(host.workloadRoot).toBeTypeOf('string')
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const seeded = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'cfr-host-session-created' && event.sessionId === 'command-attachments-session',
      'command-attachments Host seeded Session',
    )
    expect(seeded.cwd).toBe(canonicalHostWorkspace)
    const sessionA = String(seeded.sessionId)

    const clientA = await scene.startClient({
      label: 'cmd-client-a',
      cwd: clientACwd,
      home: clientAHome,
      sessionId: sessionA,
    })
    expect(clientA.ready.hostPid).toBe(hostPid)
    expect(clientA.ready.instanceId).toBe(hostInstanceId)
    await clientA.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionA,
      'client A mounted seeded Session',
    )

    // ── 1. Live Host command catalog completion positive ────────────────────
    const invocationsBeforeCompletion = readC1WorkEvents(host.workloadRoot!)
      .filter(event => event.kind === 'cfr-command-invocation').length
    const runsBeforeCompletion = (scene.sessionEvents(sessionA) ?? [])
      .filter(event => event.type === 'command/run').length
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes('❯'), 'completion composer ready')
    const catalogDeadline = Date.now() + 60_000
    let completionMatched = false
    while (Date.now() < catalogDeadline) {
      await clientA.press('Escape')
      await clientA.press('Ctrl+U')
      await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('/fil'), 'cleared completion query', 15_000)
      await clientA.type('/fil')
      const frame = await waitForFrame(clientA, f => splitFrame(f).composer.includes('/fil'), 'typed /fil', 15_000)
      const below = splitFrame(frame).below
      if (/(?:^|\n)\s*→\s+files\b/u.test(below) && below.includes('C1 command FILE receipt proof')) {
        completionMatched = true
        break
      }
      await sleep(150)
    }
    expect(completionMatched, 'Host /files command descriptor must appear in live completion dropdown').toBe(true)
    await clientA.press('Escape')
    await waitForFrame(
      clientA,
      frame => !splitFrame(frame).below.includes('C1 command FILE receipt proof'),
      'closed /fil completion dropdown',
      15_000,
    )
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('/fil'), 'cleared /fil draft', 15_000)
    expect(readC1WorkEvents(host.workloadRoot!).filter(e => e.kind === 'cfr-command-invocation')).toHaveLength(invocationsBeforeCompletion)
    expect((scene.sessionEvents(sessionA) ?? []).filter(e => e.type === 'command/run')).toHaveLength(runsBeforeCompletion)

    // ── 2. Live mixed command: ordered [image, file, image, file] via paste ─
    const sessionsBeforeMixed = [...await scene.sessionIds()].sort()
    const mixedMarker = 'CMD_MIXED_ORDERED_MARKER'
    const mixedFilePlaceholder = await stageFileViaAttach(clientA, clientAPath, 'mixed command file attach')
    await clientA.paste(`${imagePath} `)
    const imagePattern = /\[image #\d+ \([^)]+\)\]/u
    const imageFrame = await waitForFrame(
      clientA,
      frame => imagePattern.test(splitFrame(frame).composer),
      'bracketed paste image placeholder',
      30_000,
    )
    const mixedImagePlaceholder = splitFrame(imageFrame).composer.match(imagePattern)![0]
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'mixed draft cleared')

    const mixedCommand = `/files inspect ${mixedImagePlaceholder} ${mixedFilePlaceholder} ${mixedImagePlaceholder} ${mixedFilePlaceholder} ${mixedMarker}`
    await clientA.type(mixedCommand)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(mixedMarker), 'mixed command draft ready')
    await clientA.press('Enter')

    const mixedProof = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'cfr-command-invocation'
        && event.command === 'files'
        && typeof event.args === 'string'
        && event.args.includes(mixedMarker),
      'mixed command Host invocation',
      120_000,
    )
    expect(mixedProof.sessionId).toBe(sessionA)
    expect(typeof mixedProof.commandId === 'string' && mixedProof.commandId.length > 0).toBe(true)
    expect(mixedProof.args).toContain('inspect')
    expect(mixedProof.args).toContain(mixedMarker)
    expect((mixedProof.attachments as Record<string, any>[]).map(entry => entry.type)).toEqual(['image', 'file', 'image', 'file'])
    for (const fileIndex of [1, 3]) {
      const fileEntry = mixedProof.attachments[fileIndex]
      expect(fileEntry.name).toBe(sharedFileName)
      expect(fileEntry.refBytes).toBe(clientASource.byteLength)
      expect(fileEntry.bytes).toBe(clientASource.byteLength)
      expect(fileEntry.chunks).toBeGreaterThan(1)
      expect(fileEntry.sha256).toBe(clientASha256)
      expect(fileEntry.sha256).not.toBe(hostPoisonSha256)
    }
    for (const imageIndex of [0, 2]) {
      const imageEntry = mixedProof.attachments[imageIndex]
      expect(imageEntry.mediaType).toBe('image/png')
      expect(imageEntry.width).toBe(1)
      expect(imageEntry.height).toBe(1)
      expect(imageEntry.bytes).toBe(PNG_1X1_BYTES.byteLength)
      expect(typeof imageEntry.attachmentId === 'string' && imageEntry.attachmentId.length > 0).toBe(true)
    }
    const mixedLifecycle = await waitForCommandLifecycle(scene, sessionA, String(mixedProof.commandId), mixedMarker, 'mixed command')
    expect((mixedLifecycle.run.data as Record<string, any>)?.name).toBe('files')
    expect((mixedLifecycle.done.data as Record<string, any>)?.kind).toBe('success')
    expect(
      readC1WorkEvents(host.workloadRoot!).filter(
        event => event.kind === 'cfr-command-invocation' && typeof event.args === 'string' && event.args.includes(mixedMarker),
      ),
    ).toHaveLength(1)
    expect([...await scene.sessionIds()].sort()).toEqual(sessionsBeforeMixed)

    // ── 3. Undeclared command refusal (`/no-files`) ─────────────────────────
    const undeclaredMarker = 'CMD_UNDECLARED_REFUSED_MARKER'
    const undeclaredPlaceholder = await stageFileViaAttach(clientA, clientAPath, 'undeclared command attach')
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'undeclared draft cleared')
    await clientA.type(`/no-files ${undeclaredPlaceholder} ${undeclaredMarker}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(undeclaredMarker), 'undeclared command draft')
    await clientA.press('Enter')

    await waitForFrame(clientA, frame => frame.includes('does not accept attachments'), 'undeclared command refusal')
    await waitForFrame(
      clientA,
      frame => splitFrame(frame).composer.includes('[file #') && splitFrame(frame).composer.includes(undeclaredMarker),
      'undeclared restored draft',
    )
    expect(readC1WorkEvents(host.workloadRoot!).some(e => e.kind === 'cfr-command-invocation' && e.command === 'no-files')).toBe(false)
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'undeclared draft cleared after refusal')

    // ── 4. Changed-source command refusal ───────────────────────────────────
    const changedMarker = 'CMD_CHANGED_SOURCE_REFUSED_MARKER'
    const changedPlaceholder = await stageFileViaAttach(clientA, changedPath, 'changed-source command attach')
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'changed-source draft cleared')
    writeFileSync(changedPath, Buffer.alloc(3, 9), { mode: 0o600 })
    await clientA.type(`/files inspect ${changedPlaceholder} ${changedMarker}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(changedMarker), 'changed-source command draft')
    await clientA.press('Enter')

    await waitForFrame(clientA, frame => frame.includes('changed since it was attached'), 'changed-source command refusal')
    await waitForFrame(
      clientA,
      frame => splitFrame(frame).composer.includes('[file #') && splitFrame(frame).composer.includes(changedMarker),
      'changed-source command restored draft',
    )
    expect(
      readC1WorkEvents(host.workloadRoot!).some(
        e => e.kind === 'cfr-command-invocation' && typeof e.args === 'string' && e.args.includes(changedMarker),
      ),
    ).toBe(false)
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'changed-source command draft cleared')

    // ── 5. Sessionless Client B first command creates exact Session ─────────
    const clientB = await scene.startClient({
      label: 'cmd-client-b',
      cwd: clientBCwd,
      home: clientBHome,
    })
    expect(clientB.ready.sessionOpen).toBe(false)
    expect(clientB.ready.hostPid).toBe(hostPid)
    expect(clientB.ready.instanceId).toBe(hostInstanceId)
    await waitForConfirmedDirectory(clientB, canonicalClientBCwd, 'client B confirmed Workspace')

    const sessionsBeforeB = new Set(await scene.sessionIds())
    const logCountBeforeB = scene.hostSessionLogCount()
    const markerB = 'CMD_CLIENT_B_FIRST_COMMAND_MARKER'
    const placeholderB = await stageFileViaAttach(clientB, clientBPath, 'client B sessionless attach')
    expect([...await scene.sessionIds()].sort()).toEqual([...sessionsBeforeB].sort())
    expect(scene.hostSessionLogCount()).toBe(logCountBeforeB)

    await clientB.press('Ctrl+U')
    await waitForFrame(clientB, frame => !splitFrame(frame).composer.includes('[file #'), 'client B draft cleared')
    await clientB.type(`/files inspect ${placeholderB} ${markerB}`)
    await waitForFrame(clientB, frame => splitFrame(frame).composer.includes(markerB), 'client B command draft')
    await clientB.press('Enter')

    const sessionB = await scene.waitForNewSessionId(sessionsBeforeB, 'client B first-command Session')
    expect(sessionB).not.toBe(sessionA)
    await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionB,
      'client B mounted created Session',
    )
    const headerB = await scene.waitForHostSessionHeader(sessionB, 'client B durable Session header') as Record<string, any>
    const headerCwd = headerB.meta?.cwd ?? headerB.data?.meta?.cwd ?? headerB.cwd
    expect(realpathSync(String(headerCwd))).toBe(canonicalClientBCwd)

    const proofB = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'cfr-command-invocation'
        && event.command === 'files'
        && typeof event.args === 'string'
        && event.args.includes(markerB),
      'client B Host command invocation',
      120_000,
    )
    expect(proofB.sessionId).toBe(sessionB)
    expect(proofB.attachments).toHaveLength(1)
    expect(proofB.attachments[0].type).toBe('file')
    expect(proofB.attachments[0].bytes).toBe(clientBSource.byteLength)
    expect(proofB.attachments[0].sha256).toBe(clientBSha256)
    expect(proofB.attachments[0].sha256).not.toBe(hostPoisonSha256)

    const lifecycleB = await waitForCommandLifecycle(scene, sessionB, String(proofB.commandId), markerB, 'client B first command')
    expect((lifecycleB.run.data as Record<string, any>)?.name).toBe('files')
    expect((lifecycleB.done.data as Record<string, any>)?.kind).toBe('success')

    // Final negative & isolation cuts
    const finalSessionAEvents = scene.sessionEvents(sessionA) ?? []
    expect(finalSessionAEvents.some(e => JSON.stringify(e.data ?? {}).includes(undeclaredMarker))).toBe(false)
    expect(finalSessionAEvents.some(e => JSON.stringify(e.data ?? {}).includes(changedMarker))).toBe(false)
    expect(finalSessionAEvents.some(e => JSON.stringify(e.data ?? {}).includes(markerB))).toBe(false)
    expect((scene.sessionEvents(sessionB) ?? []).some(e => JSON.stringify(e.data ?? {}).includes(mixedMarker))).toBe(false)
    expect(readC1WorkEvents(host.workloadRoot!).some(e => e.kind === 'cfr-command-invocation' && e.command === 'no-files')).toBe(false)
    expect(
      readC1WorkEvents(host.workloadRoot!).some(
        e => e.kind === 'cfr-command-invocation' && typeof e.args === 'string' && e.args.includes(changedMarker),
      ),
    ).toBe(false)

    await clientA.exitGracefully()
    await clientB.exitGracefully()
    const statusAfter = await scene.hostStatus(host)
    expect(statusAfter.localHost?.hostPid).toBe(hostPid)
    expect(statusAfter.localHost?.instanceId).toBe(hostInstanceId)
    await scene.stopHost(host)
  } catch (error) {
    primary = error
    throw error
  } finally {
    await disposeScene(scene, primary)
  }
})
