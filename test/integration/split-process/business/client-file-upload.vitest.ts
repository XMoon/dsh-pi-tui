/**
 * Split-process business anchor: Client-local file and image uploads through
 * prompt, `/skill`, `/image`, changed-source refusal and sessionless first
 * prompt, verified against the official Host Attachment Store readback.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

import { expect, test } from 'vitest'

import {
  createSplitProcessScene,
  type SessionEvent,
  type SplitProcessClient,
  type SplitProcessScene,
} from '../../../support/split-process-fixture.ts'

type WorkEvent = Record<string, any>

const { waitForC1WorkEvent } = await import(
  pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'split-smoke-fixtures.mjs')).href
) as {
  waitForC1WorkEvent(
    root: string,
    predicate: (event: WorkEvent) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<WorkEvent>
}

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

function deterministicBytes(seed: number, length = 8 * 1024 * 1024): Buffer {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) % 251
  return bytes
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return ~crc
}

function deterministicPng(seed: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.from([0, (seed >>> 0) & 0xff, (seed >>> 8) & 0xff, (seed >>> 16) & 0xff])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function requestAttachmentProbe(probeDir: string, sessionId: string, marker: string): void {
  const tmpPath = join(probeDir, `request-${marker}.tmp`)
  const finalPath = join(probeDir, `request-${marker}.json`)
  writeFileSync(tmpPath, JSON.stringify({ sessionId, marker }), { mode: 0o600 })
  renameSync(tmpPath, finalPath)
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: Record<string, any>) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: Record<string, any>) => String(block.text))
    .join('')
}

function findDurableAttachmentMessages(
  scene: SplitProcessScene,
  sessionId: string,
  marker: string,
  kind: 'file' | 'image',
): Array<{ event: SessionEvent; block: Record<string, any>; text: string }> {
  const events = scene.sessionEvents(sessionId) ?? []
  const matches: Array<{ event: SessionEvent; block: Record<string, any>; text: string }> = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as Record<string, any> | undefined
    if (data?.source?.kind !== 'user' || !Array.isArray(data.content)) continue
    const text = contentText(data.content)
    if (!text.includes(marker)) continue
    const block = data.content.find(
      (candidate: Record<string, any>) => candidate?.type === kind && candidate.attachment?.attachmentId !== undefined,
    )
    if (block !== undefined) matches.push({ event, block, text })
  }
  return matches
}

async function waitForCompletedAttachmentTurn(
  scene: SplitProcessScene,
  sessionId: string,
  afterIndex: number,
  marker: string,
  kind: 'file' | 'image',
  label: string,
): Promise<{ event: SessionEvent; block: Record<string, any>; text: string }> {
  const userEvent = await scene.waitForSessionEvent(
    sessionId,
    afterIndex,
    event => {
      if (event.type !== 'user/message') return false
      const data = event.data as Record<string, any> | undefined
      if (data?.source?.kind !== 'user' || !Array.isArray(data.content)) return false
      if (!contentText(data.content).includes(marker)) return false
      return data.content.some(
        (candidate: Record<string, any>) => candidate?.type === kind && candidate.attachment?.attachmentId !== undefined,
      )
    },
    `${label}: durable ${kind} user/message`,
  )
  const events = scene.sessionEvents(sessionId) ?? []
  const userIndex = events.findIndex(event => event.seq === userEvent.seq)
  const turnStart = await scene.waitForSessionEvent(
    sessionId,
    afterIndex,
    event => event.type === 'turn/start' && typeof (event.data as Record<string, any>)?.turn === 'number',
    `${label}: turn/start`,
  )
  const turn = (turnStart.data as Record<string, any>).turn as number
  const startIndex = Math.min(
    userIndex,
    (scene.sessionEvents(sessionId) ?? []).findIndex(event => event.seq === turnStart.seq),
  )
  await scene.waitForSessionEvent(
    sessionId,
    startIndex + 1,
    event => event.type === 'assistant/message' && (event.data as Record<string, any>)?.turn === turn,
    `${label}: assistant/message`,
  )
  await scene.waitForSessionEvent(
    sessionId,
    startIndex + 1,
    event => event.type === 'turn/end'
      && (event.data as Record<string, any>)?.turn === turn
      && (event.data as Record<string, any>)?.reason?.kind === 'completed',
    `${label}: turn/end completed`,
  )
  const data = userEvent.data as Record<string, any>
  const block = (data.content as Record<string, any>[]).find(
    candidate => candidate?.type === kind && candidate.attachment?.attachmentId !== undefined,
  )!
  return { event: userEvent, block, text: contentText(data.content) }
}

async function stageAttachment(
  client: SplitProcessClient,
  command: '/attach' | '/image',
  filePath: string,
  placeholderKind: 'file' | 'image',
  label: string,
): Promise<string> {
  await waitForFrame(client, frame => splitFrame(frame).composer.includes('❯'), `${label}: composer ready`)
  const draft = `${command} ${filePath}`
  await client.type(draft)
  await waitForFrame(client, frame => splitFrame(frame).composer.includes(draft), `${label}: typed ${command}`)
  await client.press('Enter')
  const pattern = placeholderKind === 'image' ? /\[image #\d+ \([^)]+\)\]/u : /\[file #\d+ \([^)]+\)\]/u
  const frame = await waitForFrame(
    client,
    candidate => pattern.test(splitFrame(candidate).composer),
    `${label}: staged ${placeholderKind} placeholder`,
    30_000,
  )
  const match = splitFrame(frame).composer.match(pattern)
  expect(match, `${label}: missing staged placeholder`).not.toBeNull()
  return match![0]
}

async function disposeScene(scene: SplitProcessScene, primary: unknown): Promise<void> {
  try {
    await scene.dispose()
  } catch (cleanupError) {
    if (primary !== undefined) {
      throw new AggregateError([primary, cleanupError], 'client-file-upload failed and Scene cleanup also failed')
    }
    throw cleanupError
  }
}

test('uploads Client bytes through prompt, skill and image intake without binding another Session', async () => {
  const scene = await createSplitProcessScene()
  let primary: unknown
  try {
    const hostWorkspace = join(scene.workDir, 'file-upload-workspace')
    const clientAHome = join(scene.workDir, 'upload-client-a-home')
    const clientACwd = join(scene.workDir, 'upload-client-a-cwd')
    const clientBHome = join(scene.workDir, 'upload-client-b-home')
    const clientBCwd = join(scene.workDir, 'upload-client-b-cwd')
    for (const dir of [hostWorkspace, clientAHome, clientACwd, clientBHome, clientBCwd]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const canonicalHostWorkspace = realpathSync(hostWorkspace)
    const canonicalClientACwd = realpathSync(clientACwd)
    const canonicalClientBCwd = realpathSync(clientBCwd)
    expect(canonicalClientACwd).not.toBe(canonicalHostWorkspace)
    expect(canonicalClientBCwd).not.toBe(canonicalHostWorkspace)

    // Deterministic 8MiB Client file + same-named Host poison
    const sharedFileName = 'client-upload-report.bin'
    const clientASource = deterministicBytes(7, 8 * 1024 * 1024)
    const clientASha256 = createHash('sha256').update(clientASource).digest('hex')
    const hostPoison = deterministicBytes(193, 8 * 1024 * 1024)
    const hostPoisonSha256 = createHash('sha256').update(hostPoison).digest('hex')
    expect(clientASha256).not.toBe(hostPoisonSha256)
    const clientAPath = join(canonicalClientACwd, sharedFileName)
    writeFileSync(clientAPath, clientASource, { mode: 0o600 })
    writeFileSync(join(canonicalHostWorkspace, sharedFileName), hostPoison, { mode: 0o600 })

    // Skill 192KiB file
    const skillSource = deterministicBytes(53, 192 * 1024)
    const skillSha256 = createHash('sha256').update(skillSource).digest('hex')
    const skillFilePath = join(canonicalClientACwd, 'client-skill-input.bin')
    writeFileSync(skillFilePath, skillSource, { mode: 0o600 })

    // Valid deterministic PNG
    const pngBytes = deterministicPng(0x46_34_50_4e)
    const pngSha256 = createHash('sha256').update(pngBytes).digest('hex')
    const pngPath = join(canonicalClientACwd, 'client-upload-shot.png')
    writeFileSync(pngPath, pngBytes, { mode: 0o600 })

    // Changed-source 256KiB file
    const changedPath = join(canonicalClientACwd, 'client-changed-source.bin')
    writeFileSync(changedPath, deterministicBytes(11, 256 * 1024), { mode: 0o600 })

    // Client B 1MiB file
    const clientBSource = deterministicBytes(29, 1024 * 1024)
    const clientBSha256 = createHash('sha256').update(clientBSource).digest('hex')
    expect(clientBSha256).not.toBe(clientASha256)
    expect(clientBSha256).not.toBe(hostPoisonSha256)
    const clientBPath = join(canonicalClientBCwd, 'client-b-upload.bin')
    writeFileSync(clientBPath, clientBSource, { mode: 0o600 })

    const host = await scene.startHost({ scenario: 'client-file-upload' })
    expect(host.workloadRoot).toBeTypeOf('string')
    const probeDir = join(host.workloadRoot!, 'attachment-probe')
    const hostPid = host.ready.localHost?.hostPid
    const hostInstanceId = host.ready.localHost?.instanceId

    const seeded = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f4-host-session-created' && event.sessionId === 'file-upload-session',
      'file-upload Host seeded Session',
    )
    expect(seeded.cwd).toBe(canonicalHostWorkspace)
    const sessionA = String(seeded.sessionId)

    const clientA = await scene.startClient({
      label: 'upload-client-a',
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

    // ── 1. Ordinary prompt with 8MiB `/attach` -> multi-chunk Store readback ─
    const promptMarker = 'UPLOAD_PROMPT_FILE_MARKER'
    const beforePrompt = (scene.sessionEvents(sessionA) ?? []).length
    await stageAttachment(clientA, '/attach', clientAPath, 'file', 'prompt 8MiB attach')
    await clientA.type(` ${promptMarker}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(promptMarker), 'prompt file draft marker')
    await clientA.press('Enter')

    const durablePrompt = await waitForCompletedAttachmentTurn(
      scene,
      sessionA,
      beforePrompt,
      promptMarker,
      'file',
      'prompt 8MiB upload',
    )
    expect(findDurableAttachmentMessages(scene, sessionA, promptMarker, 'file')).toHaveLength(1)
    expect(durablePrompt.block.attachment.name).toBe(sharedFileName)
    expect(durablePrompt.block.attachment.bytes).toBe(clientASource.byteLength)

    requestAttachmentProbe(probeDir, sessionA, promptMarker)
    const probePrompt = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f4-file-probe' && event.marker === promptMarker,
      'prompt 8MiB Host Store readback',
      120_000,
    )
    expect(probePrompt.error).toBeUndefined()
    expect(probePrompt.sessionId).toBe(sessionA)
    expect(probePrompt.attachmentId).toBe(durablePrompt.block.attachment.attachmentId)
    expect(probePrompt.name).toBe(sharedFileName)
    expect(probePrompt.refBytes).toBe(clientASource.byteLength)
    expect(probePrompt.bytes).toBe(clientASource.byteLength)
    expect(probePrompt.chunks).toBeGreaterThan(1)
    expect(probePrompt.sha256).toBe(clientASha256)
    expect(probePrompt.sha256).not.toBe(hostPoisonSha256)

    // ── 2. `/skill` retained placeholder delivery ───────────────────────────
    const skillMarker = 'UPLOAD_SKILL_FILE_MARKER'
    const beforeSkill = (scene.sessionEvents(sessionA) ?? []).length
    const skillPlaceholder = await stageAttachment(clientA, '/attach', skillFilePath, 'file', 'skill file attach')
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'skill draft cleared')
    const skillDraft = `/skill file-attachment-skill ${skillPlaceholder} ${skillMarker}`
    await clientA.type(skillDraft)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(skillMarker), 'skill draft ready')
    await clientA.press('Enter')

    const durableSkill = await waitForCompletedAttachmentTurn(
      scene,
      sessionA,
      beforeSkill,
      skillMarker,
      'file',
      'skill file upload',
    )
    expect(durableSkill.text).toContain('/file-attachment-skill')
    requestAttachmentProbe(probeDir, sessionA, skillMarker)
    const probeSkill = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f4-file-probe' && event.marker === skillMarker,
      'skill Host Store readback',
      120_000,
    )
    expect(probeSkill.error).toBeUndefined()
    expect(probeSkill.sessionId).toBe(sessionA)
    expect(probeSkill.attachmentId).toBe(durableSkill.block.attachment.attachmentId)
    expect(probeSkill.refBytes).toBe(skillSource.byteLength)
    expect(probeSkill.bytes).toBe(skillSource.byteLength)
    expect(probeSkill.sha256).toBe(skillSha256)

    // ── 3. `/image` PNG upload -> official `readImage` readback ─────────────
    const imageMarker = 'UPLOAD_IMAGE_PNG_MARKER'
    const beforeImage = (scene.sessionEvents(sessionA) ?? []).length
    await stageAttachment(clientA, '/image', pngPath, 'image', 'image PNG attach')
    await clientA.type(` ${imageMarker}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(imageMarker), 'image draft marker')
    await clientA.press('Enter')

    const durableImage = await waitForCompletedAttachmentTurn(
      scene,
      sessionA,
      beforeImage,
      imageMarker,
      'image',
      'image PNG upload',
    )
    expect(findDurableAttachmentMessages(scene, sessionA, imageMarker, 'image')).toHaveLength(1)
    requestAttachmentProbe(probeDir, sessionA, imageMarker)
    const probeImage = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f4-file-probe' && event.marker === imageMarker,
      'image Host Store readback',
      120_000,
    )
    expect(probeImage.error).toBeUndefined()
    expect(probeImage.sessionId).toBe(sessionA)
    expect(durableImage.block.attachment.attachmentId).toBe(`sha256:${String(probeImage.sha256)}`)
    expect(probeImage.mediaType).toBe('image/png')
    expect(probeImage.pngSignature).toBe(true)
    expect(probeImage.width).toBe(1)
    expect(probeImage.height).toBe(1)
    expect(probeImage.bytes).toBe(probeImage.refBytes)
    expect(probeImage.bytes).toBe(pngBytes.byteLength)
    expect(probeImage.sha256).toBe(pngSha256)

    // ── 4. Changed source refusal ───────────────────────────────────────────
    const changedMarker = 'UPLOAD_CHANGED_SOURCE_MARKER'
    await stageAttachment(clientA, '/attach', changedPath, 'file', 'changed-source attach')
    await clientA.type(` ${changedMarker}`)
    await waitForFrame(clientA, frame => splitFrame(frame).composer.includes(changedMarker), 'changed-source draft ready')
    writeFileSync(changedPath, Buffer.alloc(3, 9), { mode: 0o600 })
    await clientA.press('Enter')

    await waitForFrame(clientA, frame => frame.includes('changed since it was attached'), 'changed-source refusal')
    await waitForFrame(
      clientA,
      frame => splitFrame(frame).composer.includes('[file #') && splitFrame(frame).composer.includes(changedMarker),
      'changed-source restored draft',
    )
    expect(findDurableAttachmentMessages(scene, sessionA, changedMarker, 'file')).toHaveLength(0)
    await clientA.press('Ctrl+U')
    await waitForFrame(clientA, frame => !splitFrame(frame).composer.includes('[file #'), 'changed-source draft cleared')

    // ── 5. Sessionless Client B cold first prompt with `/attach` ────────────
    const clientB = await scene.startClient({
      label: 'upload-client-b',
      cwd: clientBCwd,
      home: clientBHome,
    })
    expect(clientB.ready.sessionOpen).toBe(false)
    expect(clientB.ready.hostPid).toBe(hostPid)
    expect(clientB.ready.instanceId).toBe(hostInstanceId)
    await waitForConfirmedDirectory(clientB, canonicalClientBCwd, 'client B confirmed Workspace')

    const sessionsBeforeB = new Set(await scene.sessionIds())
    const logCountBeforeB = scene.hostSessionLogCount()
    const markerB = 'UPLOAD_CLIENT_B_FIRST_PROMPT_MARKER'
    await stageAttachment(clientB, '/attach', clientBPath, 'file', 'client B sessionless attach')
    expect([...await scene.sessionIds()].sort()).toEqual([...sessionsBeforeB].sort())
    expect(scene.hostSessionLogCount()).toBe(logCountBeforeB)

    await clientB.type(` ${markerB}`)
    await waitForFrame(clientB, frame => splitFrame(frame).composer.includes(markerB), 'client B draft marker')
    await clientB.press('Enter')

    const sessionB = await scene.waitForNewSessionId(sessionsBeforeB, 'client B cold first-prompt Session')
    expect(sessionB).not.toBe(sessionA)
    await clientB.waitForSurfaceStatus(
      record => record.sessionOpen === true && record.openSessionId === sessionB,
      'client B mounted created Session',
    )
    const headerB = await scene.waitForHostSessionHeader(sessionB, 'client B durable Session header') as Record<string, any>
    const headerCwd = headerB.meta?.cwd ?? headerB.data?.meta?.cwd ?? headerB.cwd
    expect(realpathSync(String(headerCwd))).toBe(canonicalClientBCwd)

    const durableB = await waitForCompletedAttachmentTurn(
      scene,
      sessionB,
      0,
      markerB,
      'file',
      'client B cold first prompt upload',
    )
    expect(findDurableAttachmentMessages(scene, sessionB, markerB, 'file')).toHaveLength(1)
    requestAttachmentProbe(probeDir, sessionB, markerB)
    const probeB = await waitForC1WorkEvent(
      host.workloadRoot!,
      event => event.kind === 'f4-file-probe' && event.marker === markerB,
      'client B Host Store readback',
      120_000,
    )
    expect(probeB.error).toBeUndefined()
    expect(probeB.sessionId).toBe(sessionB)
    expect(probeB.attachmentId).toBe(durableB.block.attachment.attachmentId)
    expect(probeB.refBytes).toBe(clientBSource.byteLength)
    expect(probeB.bytes).toBe(clientBSource.byteLength)
    expect(probeB.sha256).toBe(clientBSha256)
    expect(probeB.sha256).not.toBe(hostPoisonSha256)

    // Cross-session isolation and final changed-source absence cut
    expect(findDurableAttachmentMessages(scene, sessionA, changedMarker, 'file')).toHaveLength(0)
    expect(findDurableAttachmentMessages(scene, sessionA, markerB, 'file')).toHaveLength(0)
    expect(findDurableAttachmentMessages(scene, sessionB, promptMarker, 'file')).toHaveLength(0)

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
