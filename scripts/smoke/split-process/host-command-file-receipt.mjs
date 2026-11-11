/**
 * M6 PR-C distribution-boundary proof: a REAL installed Split Host + REAL PiTui
 * PTY Clients deliver a staged ordinary FILE through the official Host command
 * receipt authority.
 *
 * Source isolation: the Client-local file lives only in the Client's launch
 * directory; the Host workspace carries a SAME-NAMED poison file, so a path or
 * name mix-up changes the Host-read hash. The test-only `/files` command
 * (declared `input.attachments: true`) is registered by the isolated C1 Host
 * fixture, never by the product profile; it reads each admitted durable block
 * through the official Host attachment authority (`readFileStream`) and records
 * its own proof.
 *
 * @module split-process/host-command-file-receipt
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
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

/** Extract the canonical attachment placeholder from the live composer. */
async function stagedPlaceholder(client, kind, label) {
  const composer = await client.composerText()
  const pattern = kind === 'image' ? /\[image #\d+ \([^)]+\)\]/u : /\[file #\d+ \([^)]+\)\]/u
  const match = composer?.match(pattern)
  assert(match !== null && match !== undefined,
    `${label}: no staged ${kind} placeholder in the composer: ${JSON.stringify(composer)}`)
  return match[0]
}

/** `/attach <path>` through the real editor, then submit the exact command line. */
async function attachAndSubmitCommand(client, path, command, marker, label) {
  await waitForComposer(client, '❯', `${label} prompt composer`)
  client.send(`/attach ${path}`)
  client.send('\r')
  await waitForComposer(client, '[file #', `${label} attachment placeholder`)
  const placeholder = await stagedPlaceholder(client, 'file', label)
  // Clear the visible line only: the staged draft stays referenced by no text
  // and is kept because no further attach prune runs before the submit.
  client.send('\x15')
  await waitForComposerGone(client, '[file #', `${label} draft line cleared`)
  client.send(`${command} ${placeholder} ${marker}`)
  await waitForComposer(client, marker, `${label} command draft`)
  client.send('\r')
}

/** Deterministic bytes: `seed` differs between the Client source and the Host poison. */
function deterministicBytes(seed, length) {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) % 251
  return bytes
}

/** The one Host-private proof line matching `predicate`, or undefined. */
function proofOf(hostWorkRoot, predicate) {
  return readC1WorkEvents(hostWorkRoot).find(predicate)
}

/** Wait for the durable command lifecycle pair and the absence of a prompt row. */
async function waitForCommandLifecycle(dshHome, sessionId, commandId, marker, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = hostSessionEvents(dshHome, sessionId) ?? []
    const run = events.find(event => event.type === 'command/run' && event.data?.commandId === commandId)
    const done = events.find(event => event.type === 'command/done' && event.data?.commandId === commandId)
    const prompted = events.some(event => event.type === 'user/message'
      && JSON.stringify(event.data?.content ?? []).includes(marker))
    if (run !== undefined && done !== undefined) {
      assert(prompted === false, `${label}: a command invocation must never produce a plain user/message prompt`)
      return { run, done }
    }
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${label}: no durable command/run + command/done pair for ${commandId}`)
}

export async function runHostCommandFileReceipt(context) {
  const { dshHome, workDir, trace } = context
  const scene = createC1Scene(context)
  const sessionA = 'm6-prc-command-file-session-a'
  const hostDir = join(workDir, 'cfr-host-workspace')
  const clientDirA = join(workDir, 'cfr-client-a-cwd')
  const clientDirB = join(workDir, 'cfr-client-b-cwd')
  const clientHomeB = join(workDir, 'cfr-client-b-home')
  const workRoot = scene.c1WorkRoot('command-file-receipt')
  for (const directory of [hostDir, clientDirA, clientDirB, clientHomeB]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const clientFileName = 'client-only-report.bin'
  const clientSource = deterministicBytes(7, 256 * 1024)
  const clientSha256 = createHash('sha256').update(clientSource).digest('hex')
  const hostPoison = deterministicBytes(193, 256 * 1024)
  const hostPoisonSha256 = createHash('sha256').update(hostPoison).digest('hex')
  assert(clientSha256 !== hostPoisonSha256, 'the Client source and Host poison must differ')
  const clientPath = join(clientDirA, clientFileName)
  writeFileSync(clientPath, clientSource, { mode: 0o600 })
  writeFileSync(join(hostDir, clientFileName), hostPoison, { mode: 0o600 })
  // A real PNG for the mixed-order leg: the Client-local `/image`-family intake
  // reads these bytes; the Host only ever sees its admitted durable metadata.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const imagePath = join(clientDirA, 'client-shot.png')
  writeFileSync(imagePath, pngBytes, { mode: 0o600 })

  try {
    const { host, ready, workRoot: hostWorkRoot } = await scene.startC1Host(
      'command-file-receipt',
      'cfr-host',
      { C1_CFR_SESSION_ID: sessionA, C1_CFR_SESSION_CWD: realpathSync(hostDir) },
      workRoot,
    )
    const seeded = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'cfr-host-session-created' && event.sessionId === sessionA,
      'CFR Host-seeded exact Session',
    )
    assert(seeded.cwd === realpathSync(hostDir), 'CFR Session effective cwd must be the Host workspace')
    assert(ready.localHost?.instanceId !== undefined, 'CFR the installed Host identity is published')

    const { client: clientA, ready: readyA } = await scene.startC1Client('cfr-client-a', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionA,
    }, { cwd: clientDirA })
    const statusA = await clientA.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionA,
      'CFR Client A attached to the Host Session',
      120_000,
    )
    assert(statusA.sessionOpen === true, 'CFR Client A did not open the Host Session')

    // ── Seg A: one real FILE through /attach → official command receipt ─────
    const markerA = 'CFR_CLIENT_A_FILE_20261111'
    await attachAndSubmitCommand(clientA, clientPath, '/files inspect', markerA, 'CFR Seg A')
    const proofA = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'cfr-command-invocation' && event.command === 'files'
        && typeof event.args === 'string' && event.args.includes(markerA),
      'CFR Seg A Host command invocation',
      120_000,
    )
    assert(proofA.sessionId === sessionA, `CFR Seg A addressed another Session: ${JSON.stringify(proofA)}`)
    assert(proofA.attachments.length === 1, `CFR Seg A must carry exactly one block: ${JSON.stringify(proofA.attachments)}`)
    const fileBlock = proofA.attachments[0]
    assert(fileBlock.type === 'file', `CFR Seg A block is not a durable FILE: ${JSON.stringify(fileBlock)}`)
    assert(fileBlock.name === clientFileName, `CFR Seg A keeps the Client display name: ${JSON.stringify(fileBlock)}`)
    assert(fileBlock.bytes === clientSource.byteLength && fileBlock.refBytes === clientSource.byteLength,
      `CFR Seg A stored byte count mismatch: ${JSON.stringify(fileBlock)}`)
    assert(fileBlock.chunks > 1, 'CFR Seg A the Host read must stream more than one chunk')
    assert(fileBlock.sha256 === clientSha256,
      `CFR Seg A Host bytes differ from the Client source (${fileBlock.sha256} != ${clientSha256})`)
    assert(fileBlock.sha256 !== hostPoisonSha256,
      'CFR Seg A stored bytes are the Client source, never the same-named Host-workspace file')
    const lifecycleA = await waitForCommandLifecycle(dshHome, sessionA, proofA.commandId, markerA, 'CFR Seg A')
    assert(lifecycleA.run.data?.name === 'files', `CFR Seg A command/run names the command: ${JSON.stringify(lifecycleA.run)}`)
    assert(lifecycleA.done.data?.kind === 'success', `CFR Seg A command/done settled success: ${JSON.stringify(lifecycleA.done)}`)
    assert((readC1WorkEvents(hostWorkRoot).filter(event => event.kind === 'cfr-command-invocation'
      && typeof event.args === 'string' && event.args.includes(markerA))).length === 1,
    'CFR Seg A the Host handler ran exactly once')
    trace('cfr-seg-a-file', {
      sessionId: sessionA,
      commandId: proofA.commandId,
      attachmentId: fileBlock.attachmentId,
      bytes: fileBlock.bytes,
      chunks: fileBlock.chunks,
      sha256: fileBlock.sha256,
      hostPoisonRejected: true,
      hostPid: ready.localHost.hostPid,
      clientPid: readyA.pid,
    })

    // ── Seg B: one FILE + one real IMAGE in the SAME command, original order ─
    // The FILE is staged by the leading /attach route; the IMAGE is staged by a
    // REAL bracketed paste of its absolute path (the existing Client-local
    // pasted-path intake), which commits in place and keeps the staged FILE.
    const markerB = 'CFR_CLIENT_A_MIXED_20261111'
    await waitForComposer(clientA, '❯', 'CFR Seg B composer')
    clientA.send(`/attach ${clientPath}`)
    clientA.send('\r')
    await waitForComposer(clientA, '[file #', 'CFR Seg B file placeholder')
    const mixedFile = await stagedPlaceholder(clientA, 'file', 'CFR Seg B file')
    clientA.send(`\x1b[200~${imagePath} \x1b[201~`)
    await waitForComposer(clientA, '[image #', 'CFR Seg B image placeholder')
    const mixedImage = await stagedPlaceholder(clientA, 'image', 'CFR Seg B image')
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'CFR Seg B draft line cleared')
    // The SAME staged file/image placeholders are referenced TWICE: the
    // attachment occurrence contract keeps both occurrences (each FILE stages
    // its own receipt), so a real user draft proves the full
    // IMAGE → FILE → IMAGE → FILE handler order from one command.
    clientA.send(`/files inspect ${mixedImage} ${mixedFile} ${mixedImage} ${mixedFile} ${markerB}`)
    await waitForComposer(clientA, markerB, 'CFR Seg B command draft')
    clientA.send('\r')
    const proofB = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'cfr-command-invocation' && event.command === 'files'
        && typeof event.args === 'string' && event.args.includes(markerB),
      'CFR Seg B Host command invocation',
      120_000,
    )
    assert(proofB.sessionId === sessionA, `CFR Seg B addressed another Session: ${JSON.stringify(proofB)}`)
    assert(proofB.attachments.map(entry => entry.type).join(',') === 'image,file,image,file',
      `CFR Seg B keeps the submitted IMAGE/FILE interleaving: ${JSON.stringify(proofB.attachments)}`)
    for (const index of [1, 3]) {
      const fileBlock = proofB.attachments[index]
      assert(fileBlock.sha256 === clientSha256 && fileBlock.bytes === clientSource.byteLength,
        `CFR Seg B FILE occurrence ${index} carries the Client source bytes: ${JSON.stringify(fileBlock)}`)
    }
    for (const index of [0, 2]) {
      const imageBlock = proofB.attachments[index]
      assert(imageBlock.mediaType === 'image/png',
        `CFR Seg B IMAGE occurrence ${index} keeps its admitted media type: ${JSON.stringify(imageBlock)}`)
      assert(imageBlock.width === 1 && imageBlock.height === 1,
        `CFR Seg B IMAGE occurrence ${index} keeps its admitted dimensions: ${JSON.stringify(imageBlock)}`)
      assert(imageBlock.bytes === pngBytes.byteLength,
        `CFR Seg B IMAGE occurrence ${index} keeps its admitted byte count: ${JSON.stringify(imageBlock)}`)
      assert(typeof imageBlock.attachmentId === 'string' && imageBlock.attachmentId.length > 0,
        'CFR Seg B IMAGE resolves to a durable attachment identity')
    }
    await waitForCommandLifecycle(dshHome, sessionA, proofB.commandId, markerB, 'CFR Seg B')
    trace('cfr-seg-b-mixed', {
      sessionId: sessionA,
      commandId: proofB.commandId,
      order: proofB.attachments.map(entry => entry.type),
      files: [proofB.attachments[1].sha256, proofB.attachments[3].sha256],
      image: {
        attachmentId: proofB.attachments[0].attachmentId,
        mediaType: proofB.attachments[0].mediaType,
        bytes: proofB.attachments[0].bytes,
      },
    })

    // ── Negative: a genuine command WITHOUT `input.attachments` refuses ──────
    const markerNeg = 'CFR_NO_FILES_REFUSED_20261111'
    await waitForComposer(clientA, '❯', 'CFR negative composer')
    clientA.send(`/attach ${clientPath}`)
    clientA.send('\r')
    await waitForComposer(clientA, '[file #', 'CFR negative file placeholder')
    const refusedPlaceholder = await stagedPlaceholder(clientA, 'file', 'CFR negative file')
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'CFR negative draft line cleared')
    clientA.send(`/no-files ${refusedPlaceholder} ${markerNeg}`)
    await waitForComposer(clientA, markerNeg, 'CFR negative command draft')
    clientA.send('\r')
    await clientA.waitForScreen('does not accept attachments', 'CFR negative composer refusal', 60_000)
    await waitForComposer(clientA, '[file #', 'CFR negative restored draft')
    assert(proofOf(hostWorkRoot, event => event.kind === 'cfr-command-invocation'
      && event.command === 'no-files') === undefined,
    'CFR negative: an undeclared command never started a Host handler')
    trace('cfr-negative-no-declaration', { sessionId: sessionA, refused: true, hostHandlerStarted: false })
    // Clear the restored line before the next segment's leading /attach: the
    // composer must hold an empty draft for the command to be a leading line.
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'CFR negative draft cleared')

    // ── Negative: a source changed after /attach stages no receipt ──────────
    const markerChanged = 'CFR_CHANGED_SOURCE_20261111'
    const changedPath = join(clientDirA, 'client-changed.bin')
    writeFileSync(changedPath, deterministicBytes(11, 256 * 1024), { mode: 0o600 })
    await waitForComposer(clientA, '❯', 'CFR changed-source composer')
    clientA.send(`/attach ${changedPath}`)
    clientA.send('\r')
    await waitForComposer(clientA, '[file #', 'CFR changed-source placeholder')
    const changedPlaceholder = await stagedPlaceholder(clientA, 'file', 'CFR changed-source')
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'CFR changed-source draft line cleared')
    // The bytes change AFTER the attach-time fingerprint was captured.
    writeFileSync(changedPath, Buffer.alloc(3, 9), { mode: 0o600 })
    clientA.send(`/files inspect ${changedPlaceholder} ${markerChanged}`)
    await waitForComposer(clientA, markerChanged, 'CFR changed-source command draft')
    clientA.send('\r')
    await clientA.waitForScreen('changed since it was attached', 'CFR changed-source visible refusal', 60_000)
    await waitForComposer(clientA, '[file #', 'CFR changed-source restored draft')
    assert(proofOf(hostWorkRoot, event => event.kind === 'cfr-command-invocation'
      && typeof event.args === 'string' && event.args.includes(markerChanged)) === undefined,
    'CFR changed-source: the Host handler never started')
    trace('cfr-negative-changed-source', { sessionId: sessionA, refused: true, hostHandlerStarted: false })
    clientA.send('\x15')
    await waitForComposerGone(clientA, '[file #', 'CFR changed-source draft cleared')

    // ── Seg C: a SESSIONLESS Client's FIRST command creates its own Session ──
    const markerC = 'CFR_CLIENT_B_FIRST_COMMAND_20261111'
    const clientBSource = deterministicBytes(29, 128 * 1024)
    const clientBSha256 = createHash('sha256').update(clientBSource).digest('hex')
    const clientBPath = join(clientDirB, 'client-b-only.bin')
    writeFileSync(clientBPath, clientBSource, { mode: 0o600 })
    const { client: clientB, ready: readyB } = await scene.startC1Client('cfr-client-b', {
      HOME: clientHomeB,
    }, { cwd: clientDirB })
    assert(readyB.sessionOpen === false, 'CFR Client B must start sessionless')
    await attachAndSubmitCommand(clientB, clientBPath, '/files inspect', markerC, 'CFR Seg C')
    const statusB = await clientB.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
      'CFR Client B first command creates its exact Session',
      120_000,
    )
    const sessionB = statusB.openSessionId
    assert(sessionB !== sessionA, 'CFR Client B must never address Client A\'s Session')
    const proofC = await waitForC1WorkEvent(
      hostWorkRoot,
      event => event.kind === 'cfr-command-invocation' && event.command === 'files'
        && typeof event.args === 'string' && event.args.includes(markerC),
      'CFR Seg C Host command invocation',
      120_000,
    )
    assert(proofC.sessionId === sessionB,
      `CFR Seg C bound the receipt to the created Session (${proofC.sessionId} != ${sessionB})`)
    assert(proofC.attachments.length === 1 && proofC.attachments[0].type === 'file',
      `CFR Seg C carries its own durable FILE: ${JSON.stringify(proofC.attachments)}`)
    assert(proofC.attachments[0].sha256 === clientBSha256,
      'CFR Seg C Host bytes are Client B\'s own source')
    assert(proofC.attachments[0].sha256 !== hostPoisonSha256, 'CFR Seg C never reads the Host poison file')
    await waitForCommandLifecycle(dshHome, sessionB, proofC.commandId, markerC, 'CFR Seg C')
    const sessionAEvents = hostSessionEvents(dshHome, sessionA) ?? []
    assert(!sessionAEvents.some(event => JSON.stringify(event.data ?? {}).includes(markerC)),
      'CFR Client B\'s command never lands in Client A\'s Session')
    trace('cfr-seg-c-sessionless', {
      sessionId: sessionB,
      commandId: proofC.commandId,
      bytes: proofC.attachments[0].bytes,
      sha256: proofC.attachments[0].sha256,
      clientPid: readyB.pid,
    })

    await scene.exitC1Client(clientA, 'CFR Client A')
    await scene.exitC1Client(clientB, 'CFR Client B')
    await scene.stopC1Host(host)
    await scene.awaitSceneSeatFree()

    trace('m6-prc-host-command-file-receipt', {
      tarball: context.tarball,
      candidateSha256: context.candidateSha256,
      sessions: { a: sessionA, b: sessionB },
      fileSuccess: true,
      mixedOrder: proofB.attachments.map(entry => entry.type),
      sessionlessFirstCommand: true,
      undeclaredRefused: true,
      changedSourceRefused: true,
      hostPoisonRejected: true,
      result: 'PASS',
    })
    return { status: 'PASS', sessions: [sessionA, sessionB] }
  } finally {
    await scene.dispose()
  }
}
