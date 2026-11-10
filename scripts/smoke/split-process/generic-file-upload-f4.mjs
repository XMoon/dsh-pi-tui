/**
 * M6 F4 distribution-boundary proof: a REAL installed Host + REAL PiTui PTY
 * Clients drive the Client-local `/attach` intake through the official raw
 * upload route and the official Session receipt, and the Host's OWN stored
 * bytes are read back through `ctx.attachments.readFileStream`.
 *
 * Source isolation: the Client-local file lives only in the Client's launch
 * directory; the Host workspace carries a SAME-NAMED poison file. A path or
 * name mix-up would therefore produce the poison bytes and a different hash.
 *
 * @module split-process/generic-file-upload-f4
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Wait until the PAINTED composer box text contains `needle`. */
async function waitForComposer(client, needle, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const composer = await client.composerText()
    if (composer !== undefined && composer.includes(needle)) return
    await sleep(50)
  }
  throw new SplitSmokeAssertionError(`${label}: composer never contained ${needle}: ${JSON.stringify(await client.composerText())}`)
}

/** Wait until the PAINTED composer box text no longer contains `needle`. */
async function waitForComposerGone(client, needle, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const composer = await client.composerText()
    if (composer === undefined || !composer.includes(needle)) return
    await sleep(50)
  }
  throw new SplitSmokeAssertionError(`${label}: composer still contains ${needle}: ${JSON.stringify(await client.composerText())}`)
}

/** The durable user/message whose text carries `marker` (tolerates torn tails). */
function durableFileMessage(dshHome, sessionId, marker) {
  let events
  try {
    events = hostSessionEvents(dshHome, sessionId)
  } catch {
    return undefined
  }
  if (events === undefined) return undefined
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    const text = content.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('')
    if (!text.includes(marker)) continue
    const file = content.find(block => block?.type === 'file' && block.attachment?.attachmentId !== undefined)
    if (file !== undefined) return { event, file, text }
  }
  return undefined
}

async function waitForDurableFileMessage(dshHome, sessionId, marker, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = durableFileMessage(dshHome, sessionId, marker)
    if (found !== undefined) return found
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: no durable user/message with a file block for ${marker}`)
}

/** Deterministic bytes: `seed` differs between the Client source and the Host poison. */
function deterministicBytes(seed, length = 8 * 1024 * 1024) {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) % 251
  return bytes
}

/** Write the test-only Host probe request; the fixture resolves the exact Agent. */
function requestHostProbe(probeDir, sessionId, marker) {
  writeFileSync(join(probeDir, `request-${marker}.json`), JSON.stringify({ sessionId, marker }), { mode: 0o600 })
}

/** `/attach <path>` through the real editor, then submit the placeholder draft. */
async function attachAndSubmit(client, path, marker, label) {
  await waitForComposer(client, '❯', `${label} prompt composer`)
  client.send(`/attach ${path}`)
  client.send('\r')
  await waitForComposer(client, '[file #', `${label} attachment placeholder`)
  client.send(` ${marker}`)
  await waitForComposer(client, marker, `${label} draft marker`)
  client.send('\r')
}

/** Extract the canonical file placeholder from the live composer. */
async function stagedPlaceholder(client, label) {
  const composer = await client.composerText()
  const match = composer?.match(/\[file #\d+ \([^)]+\)\]/u)
  assert(match !== null && match !== undefined,
    `${label}: no staged file placeholder in the composer: ${JSON.stringify(composer)}`)
  return match[0]
}

/** The Host-stored attachment bytes and hash (from the Host fixture's own probe). */
async function hostProbe(workRoot, sessionId, marker, label, expected) {
  requestHostProbe(join(workRoot, 'probe'), sessionId, marker)
  const probe = await waitForC1WorkEvent(
    workRoot,
    event => event.kind === 'f4-file-probe' && event.marker === marker,
    label,
    120_000,
  )
  assert(probe.error === undefined, `${label}: Host probe failed: ${JSON.stringify(probe)}`)
  assert(probe.sessionId === sessionId, `${label}: probe addressed another Session: ${JSON.stringify(probe)}`)
  assert(probe.attachmentId === expected.attachmentId,
    `${label}: Host probe read a different attachment than the durable Session event`)
  assert(probe.bytes === expected.bytes && probe.refBytes === expected.bytes,
    `${label}: Host stored byte count mismatch: ${JSON.stringify(probe)}`)
  assert(probe.chunks > 1, `${label}: the Host read must stream the stored file in more than one chunk`)
  assert(probe.sha256 === expected.sha256,
    `${label}: Host stored bytes differ from the Client source (probe ${probe.sha256} != ${expected.sha256})`)
  return probe
}

export async function runGenericFileUploadF4(context) {
  const { workDir, dshHome, trace } = context
  const scene = createC1Scene(context, { fileProbe: true })
  const sessionId = 'm6-f4-upload-session-a'
  const hostDir = join(workDir, 'f4-host-workspace')
  const clientDir = join(workDir, 'f4-client-a-cwd')
  const clientDirB = join(workDir, 'f4-client-b-cwd')
  const clientHomeB = join(workDir, 'f4-client-b-home')
  const workRoot = scene.c1WorkRoot('f4-file-upload')
  const probeDir = join(workRoot, 'probe')
  for (const directory of [hostDir, clientDir, clientDirB, clientHomeB]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  mkdirSync(probeDir, { recursive: true, mode: 0o700 })
  chmodSync(probeDir, 0o700)
  const clientSource = deterministicBytes(7)
  const hostPoison = deterministicBytes(193)
  const clientSha256 = createHash('sha256').update(clientSource).digest('hex')
  const hostPoisonSha256 = createHash('sha256').update(hostPoison).digest('hex')
  assert(clientSha256 !== hostPoisonSha256, 'F4 the Client source and Host poison must differ')
  const clientFileName = 'client-only-report.bin'
  const clientPath = join(clientDir, clientFileName)
  writeFileSync(clientPath, clientSource, { mode: 0o600 })
  // A SAME-NAMED file in the Host workspace: a path/name substitution would
  // upload or cite these bytes instead.
  writeFileSync(join(hostDir, clientFileName), hostPoison, { mode: 0o600 })

  // A real human-invocable skill (the Host's official skill-filesystem root).
  const skillRoot = join(workDir, 'f4-skill-root')
  mkdirSync(join(skillRoot, 'f4-smoke'), { recursive: true, mode: 0o700 })
  chmodSync(join(skillRoot, 'f4-smoke'), 0o700)
  writeFileSync(join(skillRoot, 'f4-smoke', 'SKILL.md'), [
    '---',
    'name: f4-smoke',
    'description: F4 qualification skill (host-discovered)',
    'user-invocable: true',
    '---',
    '',
    'F4_SKILL_BODY_20261111',
    '',
  ].join('\n'), { mode: 0o600 })
  const skillSource = deterministicBytes(53, 192 * 1024)
  const skillSha256 = createHash('sha256').update(skillSource).digest('hex')
  const skillPath = join(clientDir, 'client-skill-file.bin')
  writeFileSync(skillPath, skillSource, { mode: 0o600 })

  try {
    const { host, ready, workRoot: hostWorkRoot } = await scene.startC1Host('f4-file', 'f4-file-host', {
      C1_F4_SESSION_ID: sessionId,
      C1_F4_SESSION_CWD: realpathSync(hostDir),
      C1_F4_PROBE_DIR: probeDir,
      DSH_BUNDLED_SKILL_DIR: skillRoot,
    }, workRoot)
    const seeded = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'f4-host-session-created' && event.sessionId === sessionId,
      'F4 Host-seeded exact Session',
    )
    assert(seeded.cwd === realpathSync(hostDir), 'F4 Session effective cwd must be the Host workspace')
    assert(ready.localHost?.instanceId !== undefined, 'F4 the installed Host identity is published')

    const { client: clientA, ready: readyA } = await scene.startC1Client('f4-file-client-a', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionId,
    }, { cwd: clientDir })
    const statusA = await clientA.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'F4 Client A attached to the Host Session',
      120_000,
    )
    assert(statusA.sessionOpen === true, 'F4 Client A did not open the Host Session')

    // ── A: real /attach → official receipt → durable file → Host stored bytes ─
    const markerA = 'F4_CLIENT_A_FILE_20261111'
    await attachAndSubmit(clientA, clientPath, markerA, 'F4 Client A /attach')
    const durableA = await waitForDurableFileMessage(dshHome, sessionId, markerA, 'F4 Client A durable file message')
    assert(durableA.file.attachment.name === clientFileName,
      `F4 the durable file keeps the Client display name: ${JSON.stringify(durableA.file)}`)
    assert(durableA.file.attachment.bytes === clientSource.byteLength,
      'F4 the durable file reports the uploaded byte count')
    const probeA = await hostProbe(workRoot, sessionId, markerA, 'F4 Client A Host byte authority', {
      attachmentId: durableA.file.attachment.attachmentId,
      bytes: clientSource.byteLength,
      sha256: clientSha256,
    })
    assert(probeA.sha256 !== hostPoisonSha256,
      'F4 the stored bytes are the Client source, never the same-named Host-workspace file')
    // The accepted file row is painted from the Host's durable event.
    await clientA.waitForScreen(clientFileName, 'F4 Client A paints the accepted file row', 60_000)
    trace('f4-file-client-a', {
      sessionId,
      attachmentId: durableA.file.attachment.attachmentId,
      bytes: probeA.bytes,
      chunks: probeA.chunks,
      sha256: probeA.sha256,
      hostPoisonRejected: true,
      hostPid: ready.localHost.hostPid,
      clientPid: readyA.pid,
    })

    // ── F: a REAL agent-facing `/skill` prompt carries the same file through
    // the SAME ordinary Session writer (not a command plane).
    const skillMarker = 'F4_SKILL_FILE_20261111'
    await waitForComposer(clientA, '❯', 'F4 skill prompt composer')
    clientA.send(`/attach ${skillPath}`)
    clientA.send('\r')
    await waitForComposer(clientA, '[file #', 'F4 skill attachment placeholder')
    const skillPlaceholder = await stagedPlaceholder(clientA, 'F4 skill attachment')
    // Replace the staged placeholder line with the real `/skill` invocation,
    // reusing the EXACT placeholder the intake produced.
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'F4 skill draft line cleared')
    clientA.send(`/skill f4-smoke ${skillPlaceholder} ${skillMarker}`)
    await waitForComposer(clientA, skillMarker, 'F4 skill invocation draft')
    clientA.send('\r')
    const durableSkill = await waitForDurableFileMessage(dshHome, sessionId, skillMarker, 'F4 /skill durable file message')
    assert(durableSkill.text.includes('/f4-smoke'),
      `F4 the durable row is the agent-facing skill line: ${JSON.stringify(durableSkill.text)}`)
    const probeSkill = await hostProbe(workRoot, sessionId, skillMarker, 'F4 /skill Host byte authority', {
      attachmentId: durableSkill.file.attachment.attachmentId,
      bytes: skillSource.byteLength,
      sha256: skillSha256,
    })
    trace('f4-skill-file', {
      sessionId,
      attachmentId: durableSkill.file.attachment.attachmentId,
      bytes: probeSkill.bytes,
      sha256: probeSkill.sha256,
    })

    // ── Negative: the source changes after /attach → visible refusal, no file row
    const changedMarker = 'F4_CHANGED_SOURCE_20261111'
    const changedPath = join(clientDir, 'client-changed.bin')
    writeFileSync(changedPath, deterministicBytes(11, 256 * 1024), { mode: 0o600 })
    await waitForComposer(clientA, '❯', 'F4 changed-source prompt composer')
    clientA.send(`/attach ${changedPath}`)
    clientA.send('\r')
    await waitForComposer(clientA, '[file #', 'F4 changed-source attachment placeholder')
    clientA.send(` ${changedMarker}`)
    await waitForComposer(clientA, changedMarker, 'F4 changed-source draft marker')
    // The bytes change AFTER the immutable prepared snapshot is taken at attach.
    writeFileSync(changedPath, Buffer.alloc(3, 9), { mode: 0o600 })
    clientA.send('\r')
    await clientA.waitForScreen('changed since it was attached', 'F4 changed-source visible refusal', 60_000)
    assert(durableFileMessage(dshHome, sessionId, changedMarker) === undefined,
      'F4 a changed source never produces a durable file-bearing prompt')
    await waitForComposer(clientA, changedMarker, 'F4 changed-source draft restore')
    // Clear the restored draft through the REAL editor before /exit: a
    // non-empty draft would make `/exit` ordinary prompt text.
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'F4 changed-source draft cleared')

    // ── D: a sessionless Client stages /attach, then its FIRST prompt creates
    // an exact Session and uploads there (never to Client A's Session).
    const markerB = 'F4_CLIENT_B_FIRST_PROMPT_20261111'
    const clientBSource = deterministicBytes(29, 1024 * 1024)
    const clientBSha256 = createHash('sha256').update(clientBSource).digest('hex')
    const clientBPath = join(clientDirB, 'client-b-only.bin')
    writeFileSync(clientBPath, clientBSource, { mode: 0o600 })
    const { client: clientB, ready: readyB } = await scene.startC1Client('f4-file-client-b', {
      HOME: clientHomeB,
    }, { cwd: clientDirB })
    assert(readyB.sessionOpen === false, 'F4 Client B must start sessionless')
    await attachAndSubmit(clientB, clientBPath, markerB, 'F4 Client B sessionless /attach')
    const statusB = await clientB.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
      'F4 Client B first prompt creates its exact Session',
      120_000,
    )
    const sessionB = statusB.openSessionId
    assert(sessionB !== sessionId, 'F4 Client B must never upload into Client A\'s Session')
    const durableB = await waitForDurableFileMessage(dshHome, sessionB, markerB, 'F4 Client B durable file message')
    assert(durableB.file.attachment.bytes === clientBSource.byteLength,
      'F4 Client B durable file reports its own byte count')
    assert(durableB.event.data.content.some(block => block.type === 'text' && block.text.includes(markerB))
      || durableB.text.includes(markerB), 'F4 Client B durable row keeps its own marker')
    const probeB = await hostProbe(workRoot, sessionB, markerB, 'F4 Client B Host byte authority', {
      attachmentId: durableB.file.attachment.attachmentId,
      bytes: clientBSource.byteLength,
      sha256: clientBSha256,
    })
    assert(probeB.attachmentId !== durableA.file.attachment.attachmentId,
      'F4 each Session keeps its own Host-issued attachment identity')
    // The Session A row does not gain B's marker.
    assert(durableFileMessage(dshHome, sessionId, markerB) === undefined,
      'F4 Client B\'s file never lands in Client A\'s Session')

    await scene.exitC1Client(clientA, 'F4 Client A')
    await scene.exitC1Client(clientB, 'F4 Client B')
    await scene.stopC1Host(host)
    await scene.awaitSceneSeatFree()

    trace('m6-f4-generic-file-upload', {
      tarball: context.tarball,
      candidateSha256: context.candidateSha256,
      sessions: { a: sessionId, b: sessionB },
      clientA: { bytes: probeA.bytes, chunks: probeA.chunks, sha256: probeA.sha256, attachmentId: probeA.attachmentId },
      clientB: { bytes: probeB.bytes, chunks: probeB.chunks, sha256: probeB.sha256, attachmentId: probeB.attachmentId },
      changedSourceRefused: true,
      hostPoisonRejected: true,
      sessionlessFirstPrompt: true,
      result: 'PASS',
    })
    return { status: 'PASS', sessions: [sessionId, sessionB] }
  } finally {
    await scene.dispose()
  }
}
