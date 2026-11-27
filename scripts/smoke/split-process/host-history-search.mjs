/**
 * PR1 Host accepted-input history search: the REAL installed Host → official
 * durable Session event → private `piTuiHistorySearch` → authenticated Split
 * Client path.
 *
 * The scene starts ONE real Host and TWO real PTY surface Clients (different
 * OS PIDs, same isolated Host home). Client A submits unique prompts through
 * the normal surface; the case first proves the official persisted event
 * (`agent/inbox/spliced` / `user/message`) with the independent
 * `hostSessionEvents` reader, THEN Client B reads the private namespace on its
 * already-mounted `domains.remote.piTuiHistorySearch` through the
 * qualification-only `SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST` input.
 *
 * Pinned here: cross-Client exact occurrence identity (id, cwd, seq, time,
 * preview, content hash), exact-text recovery by chunks, both keyset pages and
 * cursor staleness, same-text distinct occurrences, Session/directory/All
 * scopes, official queue edit/remove/steer stability, real `/fork` inheritance,
 * event-time cwd changes and a clean Host restart replay.
 *
 * @module split-process/host-history-search
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'


import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus } from '../../lib/split-smoke-processes.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  hostSessionEvents,
  waitForHostSessionEvent,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function textOfMessage(value) {
  if (value === null || typeof value !== 'object') return ''
  const content = value.content
  if (!Array.isArray(content)) return ''
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}

/** Whether one durable message is an official user-sourced admission, never an injected notice. */
function isAcceptedUserMessage(message) {
  return message !== null && typeof message === 'object'
    && typeof message.id === 'string' && message.id !== ''
    && message.source?.kind === 'user'
}

/** The first durable accepted message for `text` and the event that proved it. */
function acceptedMessage(events, text) {
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
      const message = event.data.inserted.find(candidate => textOfMessage(candidate) === text && isAcceptedUserMessage(candidate))
      if (message !== undefined) return { event, message }
    }
    if (event.type === 'user/message' && textOfMessage(event.data) === text && isAcceptedUserMessage(event.data)) {
      return { event, message: event.data }
    }
  }
  return undefined
}

/** Find the first durable event whose accepted text is exactly `text`. */
async function waitForAcceptedMessage(dshHome, sessionId, text, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const events = hostSessionEvents(dshHome, sessionId)
    const found = events === undefined ? undefined : acceptedMessage(events, text)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label}: no durable accepted event for ${JSON.stringify(text)} in Session ${sessionId}`)
}

/** Send one prompt through the real Client surface; callers wait the durable event. */
async function submitPrompt(client, text) {
  client.send(`${text}\r`)
}

let probeSequence = 0

/** One qualification-only history-search request on the already-mounted Client namespace. */
async function probe(client, requestPath, request, label, timeoutMs = 120_000) {
  const nonce = `hsp-${String(process.pid)}-${String(++probeSequence)}`
  writeFileSync(requestPath, JSON.stringify({ nonce, ...request }), { mode: 0o600 })
  client.signalBusiness('SIGUSR2')
  const record = await client.waitFor(candidate => candidate.m4b2s === 'qualification'
    && candidate.op === 'history-search-proof'
    && candidate.nonce === nonce
    && (candidate.phase === 'result' || candidate.phase === 'failed'),
  `${label} history record`, timeoutMs)
  assert(record.phase === 'result', `${label}: the Client history read failed: ${JSON.stringify(record)}`)
  return record.answer
}

async function search(client, requestPath, request, label) {
  return probe(client, requestPath, { op: 'search', ...request }, label)
}

async function readSessionRecall(client, requestPath, request, label) {
  return probe(client, requestPath, { op: 'readSessionRecall', ...request }, label)
}

/** Wait for the bounded recall window of ONE target to leave `loading`. */
async function recallSettled(client, requestPath, sessionId, label, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    const answer = await readSessionRecall(client, requestPath, { sessionId }, label)
    if (answer.kind === 'ready') return answer
    assert(answer.kind === 'loading' || answer.kind === 'incomplete',
      `${label}: unexpected recall state ${JSON.stringify(answer)}`)
    assert(Date.now() - started < timeoutMs, `${label}: the recall window never became ready`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}


/** Reach the ACTIVE All-directory scope from the captured default without
 *  assuming whether the resumed Session or a sessionless Directory default won
 *  the open. The active label is bracketed; an inactive label is not. */
async function reachAllScope(client, label) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lines = await client.viewport()
    const historyRow = lines.find(line => line.includes('Input History'))
    if (historyRow?.includes('[All Directories]')) return
    client.send('\t')
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  const lines = await client.viewport()
  throw new SplitSmokeAssertionError(`${label}: History never reached the ACTIVE All scope: ${JSON.stringify(lines)}`)
}

/** Wait for the CURRENT Results region to paint the target's selected marker
 *  and its verified exact body, stable across two real frames. The transcript
 *  or query text alone is not a witness. */
async function waitForStableHistoryResult(client, target, label, timeoutMs = 120_000) {
  const started = Date.now()
  let previous = ''
  for (;;) {
    const lines = await client.viewport()
    const frame = lines.join('\n')
    const selected = lines.some(line => /^\s*>\s/u.test(line) && line.includes(target))
    const bodyReady = lines.some(line => line.includes('Copy All [Alt+C]'))
    const useReady = lines.some(line => line.includes('Use Selected [Enter]'))
    const results = lines.some(line => line.includes('Results ·'))
    if (selected && bodyReady && useReady && results && frame === previous) return lines
    previous = frame
    if (Date.now() - started > timeoutMs) {
      throw new SplitSmokeAssertionError(`${label}: the selected exact result never became the stable painted frame: ${JSON.stringify(lines)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
}

/** The ACTUAL composer row (the last prompt line), not a transcript echo. */
function composerDraftOf(lines) {
  const row = lines.filter(line => line.trimStart().startsWith('❯')).at(-1)
  if (row === undefined) return undefined
  const at = row.indexOf('❯')
  return row.slice(at + '❯'.length).trim()
}

/** Press the REAL ↑ sink until the async Host seed has committed one of the
 *  expected original texts into the composer. A committed seed is the only
 *  success signal; the loop is bounded by the caller deadline. */
async function waitForSeededComposerDraft(client, allowed, label, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    const draft = composerDraftOf(await client.viewport())
    if (draft !== undefined && allowed.includes(draft)) return draft
    assert(Date.now() - started < timeoutMs,
      `${label}: the ↑ sink never recalled a Host-seeded row; draft=${JSON.stringify(draft)}`)
    client.send('\x1b[A')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Walk the real ↓ sink back to the saved empty draft after a recall seed.
 *  The newest row may have been skipped by the allowed-text wait, so one ↓ is
 *  not enough in general. */
async function clearSeededComposerDraft(client, label) {
  for (let step = 0; step < 20; step += 1) {
    if ((composerDraftOf(await client.viewport()) ?? '') === '') return
    client.send('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await waitForComposerDraft(client, '', label, 5_000)
}

/** Walk the REAL ↑ sink from an empty draft through every distinct recalled
 *  row (wrap-safe), so the caller can assert the COMPLETE browse membership,
 *  not just the one row the wait helper happened to accept. */
async function browseAllRecallDrafts(client, label) {
  const drafts = []
  const seen = new Set()
  for (let step = 0; step < 100; step += 1) {
    client.send('\x1b[A')
    await new Promise(resolve => setTimeout(resolve, 60))
    const draft = composerDraftOf(await client.viewport())
    if (!draft || seen.has(draft)) break
    seen.add(draft)
    drafts.push(draft)
  }
  assert(drafts.length >= 1, `${label}: the ↑ sink recalled no row`)
  return drafts
}

async function waitForComposerDraft(client, target, label, timeoutMs = 30_000) {
  const started = Date.now()
  for (;;) {
    const lines = await client.viewport()
    if (composerDraftOf(lines) === target) return lines
    if (Date.now() - started > timeoutMs) {
      throw new SplitSmokeAssertionError(`${label}: the composer region does not hold the exact draft: ${JSON.stringify(lines)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

/** The UI leg: a real Ctrl+R on a packed Client reads the Host, restores the
 *  exact draft and submits only on the SECOND Enter, while the legacy JSONL
 *  sentinel stays byte-identical. */
async function runUiCtrlR({ client, dshHome, sessionId, target, legacySentinel, label, submitAfterRestore = true }) {
  const acceptedIds = () => new Set((hostSessionEvents(dshHome, sessionId) ?? [])
    .map(event => acceptedMessage([event], target)?.message?.id)
    .filter(id => typeof id === 'string'))
  const acceptedCount = () => acceptedIds().size
  const before = acceptedCount()
  const beforeIds = acceptedIds()
  client.send('\x12')
  await client.waitForScreen('Input History', `${label} History seat`, 120_000)
  await reachAllScope(client, `${label} All scope`)
  client.send(target)
  await waitForStableHistoryResult(client, target, `${label} stable selected result`)
  // ONE Restore Enter, admitted only against the stable selected marker and
  // verified body. If History remains mounted, this is a real product/harness
  // defect to record, never a reason to send the gesture twice.
  client.send('\r')
  const closeDeadline = Date.now() + 15_000
  while ((await client.viewport()).some(line => line.includes('Input History'))) {
    if (Date.now() > closeDeadline) {
      assert(false, `${label}: History stayed mounted after ONE Restore Enter: ${JSON.stringify(await client.viewport())}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  await waitForComposerDraft(client, target, `${label} exact composer draft`)
  assert(acceptedCount() === before,
    `${label}: the restore submitted the history row`)
  assertLegacyV1Untouched(legacySentinel)
  if (!submitAfterRestore) return
  client.send('\r')
  const submitDeadline = Date.now() + 120_000
  while (acceptedCount() < before + 1 && Date.now() < submitDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert(acceptedCount() === before + 1,
    `${label}: the second Enter did not produce exactly one official occurrence`)
  return (hostSessionEvents(dshHome, sessionId) ?? []).find((event) => {
    const id = acceptedMessage([event], target)?.message?.id
    return typeof id === 'string' && !beforeIds.has(id)
  })
}

/** Wait until the official index has observed one already-durable occurrence. */
async function waitForIndexedOccurrence(client, requestPath, request, messageId, label, timeoutMs = 120_000) {
  const started = Date.now()
  for (;;) {
    const answer = assertReady(await searchSettled(client, requestPath, request, label), label)
    if (answer.items.some(item => item.messageId === messageId)) return answer
    if (Date.now() - started > timeoutMs) {
      throw new SplitSmokeAssertionError(`${label}: the durable occurrence never entered the ready index: ${JSON.stringify(answer)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Read every page of one Owner search in order. */
async function readAllHistoryItems(client, requestPath, request, label) {
  const items = []
  let cursor
  for (let page = 0; page < 1000; page += 1) {
    const answer = assertReady(await searchSettled(client, requestPath, {
      ...request,
      ...(cursor === undefined ? {} : { cursor }),
    }, `${label} page ${String(page)}`), label)
    items.push(...answer.items)
    if (answer.nextCursor === null) return items
    cursor = answer.nextCursor
  }
  throw new SplitSmokeAssertionError(`${label}: pagination did not terminate`)
}

/** The comparable semantic identity of one accepted occurrence. */
function historySemantic(item) {
  return {
    sessionId: item.sessionId,
    messageId: item.messageId,
    firstEventSeq: item.firstEventSeq,
    acceptedAt: item.acceptedAt,
    effectiveCwd: item.effectiveCwd,
    preview: item.preview,
    contentLength: item.contentLength,
    contentSha256: item.contentSha256,
    hasNonText: item.hasNonText,
  }
}

async function readText(client, requestPath, request, label) {
  return probe(client, requestPath, { op: 'readText', ...request }, label)
}

/** Poll the search until the asynchronous index leaves `loading`. */
async function searchSettled(client, requestPath, request, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const answer = await search(client, requestPath, request, label)
    if (answer.kind !== 'loading') return answer
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new SplitSmokeAssertionError(`${label}: history search stayed loading for ${String(timeoutMs)}ms`)
}

function assertReady(answer, label) {
  assert(answer.kind === 'ready', `${label}: expected ready, got ${JSON.stringify(answer)}`)
  return answer
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Read one occurrence's exact text through bounded chunks and prove identity. */
async function readFullText(client, requestPath, item, label, chunkLimit = 5) {
  const parts = []
  let offset = 0
  for (let pages = 0; pages < 10_000; pages += 1) {
    const answer = await readText(client, requestPath, {
      sessionId: item.sessionId,
      messageId: item.messageId,
      contentSha256: item.contentSha256,
      offset,
      limit: chunkLimit,
    }, `${label} chunk ${String(offset)}`)
    assert(answer.kind === 'ready', `${label}: readText at ${String(offset)} returned ${JSON.stringify(answer)}`)
    assert(answer.contentLength === item.contentLength,
      `${label}: readText contentLength ${String(answer.contentLength)} != item ${String(item.contentLength)}`)
    parts.push(answer.chunk)
    if (answer.nextOffset === null) break
    assert(answer.nextOffset > offset, `${label}: readText did not advance (offset ${String(offset)} -> ${String(answer.nextOffset)})`)
    offset = answer.nextOffset
  }
  return parts.join('')
}

/**
 * Test-only child writer source. It is executed by a SEPARATE Node process
 * against the isolated installed DSH family (resolved from the installation
 * harness), never against this workspace's modules. It only uses official
 * persistence handles and reports its PID/versions/closed facts.
 */
const INSTALLED_WRITER_SOURCE = String.raw`
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(process.env.HSP_HARNESS_PACKAGE)
const load = async (id) => import(pathToFileURL(require.resolve(id)).href)
const manifest = (id) => JSON.parse(readFileSync(require.resolve(id + '/package.json'), 'utf8'))
const { Context } = await load('@deepseek-ai/cordis')
const Jsonl = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { SESSION_FORMAT_VERSION, SessionId } = await load('@deepseek-ai/dsh-session')
const spec = JSON.parse(process.env.HSP_WRITER_SPEC)
const facts = {
  pid: process.pid,
  writer: 'installed-official',
  closed: false,
  versions: {
    jsonl: manifest('@deepseek-ai/dsh-session-persistence-jsonl').version,
    seam: manifest('@deepseek-ai/dsh-session-persistence').version,
    session: manifest('@deepseek-ai/dsh-session').version,
  },
}
const ctx = new Context()
let handle
try {
  await ctx.plugin(Jsonl, { root: spec.root })
  const persistence = ctx.reflect.get('sessionPersistence')
  if (spec.op === 'create') {
    handle = await persistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(spec.id),
      createdAt: Date.now(),
      cwd: spec.cwd,
      isSeeded: false,
    })
  } else {
    handle = await persistence.open(SessionId(spec.id), 'write')
  }
  const events = spec.events.map((event) => ({
    type: 'user/message',
    seq: event.seq,
    time: Date.now() + event.seq,
    surfaceOp: 'append',
    data: {
      id: event.id,
      role: 'user',
      content: [{ type: 'text', text: event.text }],
      // An uncorrelated input is an official legal user source: only the
      // producer kind classifies it.
      source: event.rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId: event.rpcId },
    },
  }))
  if (events.length > 0) await handle.append(events)
  await handle.flush()
  await handle.close()
  facts.closed = true
} finally {
  await ctx.fiber.dispose()
}
console.log(JSON.stringify(facts))
`

/** Run ONE isolated installed-family write child and prove its terminal facts. */
async function runInstalledWriter(installation, workDir, spec) {
  const scriptPath = join(workDir, `.hsp-installed-writer-${String(process.pid)}-${Date.now().toString(36)}.mjs`)
  writeFileSync(scriptPath, INSTALLED_WRITER_SOURCE, { mode: 0o600 })
  const child = spawn(process.execPath, [scriptPath], {
    cwd: installation.harnessDir,
    env: {
      ...process.env,
      HSP_HARNESS_PACKAGE: installation.anchor,
      HSP_WRITER_SPEC: JSON.stringify(spec),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  }).then(result => result)
  assert(code.exitCode === 0, `installed writer exited ${JSON.stringify(code)}: ${stderr}`)
  const facts = JSON.parse(stdout.trim().split('\n').at(-1))
  assert(facts.pid === child.pid, `installed writer PID ${String(facts.pid)} != spawned ${String(child.pid)}`)
  assert(facts.writer === 'installed-official' && facts.closed === true,
    `installed writer did not report an official closed handle: ${JSON.stringify(facts)}`)
  appendFileSync(join(workDir, 'installed-writer-facts.jsonl'), `${JSON.stringify({
    ...facts,
    parentPid: process.pid,
    exit: code,
    op: spec.op,
    id: spec.id,
    seqs: spec.events.map(event => event.seq),
  })}\n`, { mode: 0o600 })
  return facts
}

/** Create ONE cold official current-format Session with an installed child writer. */
async function seedOfficialColdSession(installation, dshHome, workDir, { id, cwd, texts, uncorrelatedTexts = [] }) {
  const facts = await runInstalledWriter(installation, workDir, {
    op: 'create',
    root: join(dshHome, 'sessions'),
    id,
    cwd,
    events: texts.map((text, seq) => ({
      seq,
      id: `seed-${id}-${String(seq)}`,
      text,
      ...(uncorrelatedTexts.includes(text) ? {} : { rpcId: `seed-rpc-${id}-${String(seq)}` }),
    })),
  })
  return facts
}

/** Append ONE official accepted event to a cold Session with the installed child writer. */
async function appendOfficialColdEvent(installation, dshHome, workDir, sessionId, { text, seq }) {
  const facts = await runInstalledWriter(installation, workDir, {
    op: 'open',
    root: join(dshHome, 'sessions'),
    id: sessionId,
    events: [{
      seq,
      id: `append-${sessionId}-${String(seq)}`,
      text,
      rpcId: `append-rpc-${sessionId}-${String(seq)}`,
    }],
  })
  return facts
}

/** Write a legacy v1 file set and capture its full observable identity. */
function writeLegacyV1Sentinel(profileDir) {
  const historyDir = join(profileDir, '.dsh-pi-tui', 'history-search')
  mkdirSync(join(profileDir, '.dsh-pi-tui'), { recursive: true, mode: 0o700 })
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(profileDir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  const dbPath = join(historyDir, 'v1.sqlite')
  const snapshot = new Map()
  for (const [suffix, contents] of [['', 'legacy-v1-main'], ['-wal', 'legacy-v1-wal'], ['-shm', 'legacy-v1-shm']]) {
    const file = `${dbPath}${suffix}`
    writeFileSync(file, contents, { mode: 0o600 })
    const stat = lstatSync(file)
    snapshot.set(suffix, {
      bytes: readFileSync(file),
      ino: stat.ino,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    })
  }
  return { dbPath, snapshot }
}

/** Verify the legacy v1 file set is byte/mode/inode identical and never renamed. */
function assertLegacyV1Untouched(sentinel) {
  for (const [suffix, before] of sentinel.snapshot) {
    const file = `${sentinel.dbPath}${suffix}`
    const after = lstatSync(file)
    assert(readFileSync(file).equals(before.bytes), `the legacy v1${suffix} bytes changed`)
    assert(after.ino === before.ino, `the legacy v1${suffix} inode was replaced`)
    assert(after.mode === before.mode, `the legacy v1${suffix} mode changed`)
    assert(after.mtimeMs === before.mtimeMs, `the legacy v1${suffix} was rewritten`)
  }
}

/** The last bootstrap diagnostics record of one Host debug log. */
function bootstrapCounters(logPath) {
  if (!existsSync(logPath)) return undefined
  const lines = readFileSync(logPath, 'utf8').split('\n')
  const line = [...lines].reverse().find(candidate => candidate.includes('history-search.bootstrap.end'))
  if (line === undefined) return undefined
  const fields = {}
  for (const part of line.split(' ')) {
    const match = /^([A-Za-z][A-Za-z]+)=(.+)$/u.exec(part)
    if (match !== null) fields[match[1]] = match[2]
  }
  return fields
}

/** Wait until a Host's bootstrap diagnostics record exists. */
async function waitForBootstrapCounters(logPath, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const counters = bootstrapCounters(logPath)
    if (counters !== undefined) return counters
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label}: no history-search.bootstrap.end record in ${logPath}`)
}

/** Read the derived v3 database (Host exited, no writer) without touching sources. */
function inspectDerivedHistory(profileDir) {
  const dbPath = join(profileDir, '.dsh-pi-tui', 'history-search', 'v3.sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const userVersion = db.prepare('PRAGMA user_version').get().user_version
    const sessions = db.prepare('SELECT COUNT(*) AS count FROM history_sessions').get().count
    const proofs = db.prepare('SELECT COUNT(*) AS count FROM history_source_proofs').get().count
    return { dbPath, userVersion, sessions, proofs }
  } finally {
    db.close()
  }
}

/** Read one committed proof row, if present (Host stopped). */
function sourceProofOf(profileDir, sessionId) {
  const dbPath = join(profileDir, '.dsh-pi-tui', 'history-search', 'v3.sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare('SELECT source_revision, checkpoint_hash, source_path FROM history_source_proofs WHERE session_id = ?').get(sessionId)
  } finally {
    db.close()
  }
}

/**
 * One test-only Host plugin installed only into THIS smoke's isolated profile.
 * It uses official Host services (workingDirectory/sessionController) to
 * exercise event-time cwd changes and real queue edit/remove while a Turn is
 * held; it writes bounded proof lines and never touches production code.
 */
const EXTRA_FIXTURE_SOURCE = [
  "import { appendFileSync } from 'node:fs'",
  "export const name = 'host-history-search-extra'",
  "export const inject = ['agents', 'workingDirectory', 'sessionController']",
  "const proof = process.env.HISTORY_SEARCH_EXTRA_PROOF",
  "const record = (kind, fields = {}) => {",
  "  if (proof !== undefined && proof !== '') appendFileSync(proof, JSON.stringify({ kind, ...fields, time: Date.now() }) + '\\n', { mode: 0o600 })",
  "}",
  "function textOf(value) {",
  "  if (value === null || typeof value !== 'object' || !Array.isArray(value.content)) return ''",
  "  return value.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\\n')",
  "}",
  "export function apply(ctx) {",
  "  record('plugin-loaded')",
  "  ctx.on('session/event', (session, event) => {",
  "    const cwdMarker = (event.type === 'user/message' && textOf(event.data) === 'hsp-cwd-switch')",
  "      || (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) && event.data.inserted.some(message => textOf(message) === 'hsp-cwd-switch'))",
  "    if (cwdMarker) {",
  "      const agent = ctx.agents.get(String(session.id))",
  "      const target = process.env.HISTORY_SEARCH_CWD_TARGET",
  "      if (agent === undefined || target === undefined || target === '') { record('cwd-error', { sessionId: String(session.id) }); return }",
  "      ctx.workingDirectory.set(agent, target).then(cwd => record('cwd-set', { sessionId: String(session.id), cwd })).catch(error => record('cwd-error', { sessionId: String(session.id), error: String(error) }))",
  "    }",
  "    if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {",
  "      const sessionId = String(session.id)",
  "      const target = event.data.inserted.find(message => textOf(message) === 'hsp-queue-target')",
  "      if (target !== undefined) {",
  "        const itemId = String(target.id)",
  "        const run = async () => {",
  "          record('queue-inserted', { sessionId, itemId })",
  "          await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'edit', content: [{ type: 'text', text: 'hsp-queue-edited' }] } })",
  "          record('queue-edited', { sessionId, itemId })",
  "          await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })",
  "          record('queue-removed', { sessionId, itemId })",
  "        }",
  "        setTimeout(() => run().catch(error => record('queue-error', { sessionId, itemId, error: String(error) })), 0)",
  "      }",
  "      const steer = event.data.inserted.find(message => textOf(message) === 'hsp-queue-steer')",
  "      if (steer !== undefined) {",
  "        const itemId = String(steer.id)",
  "        const run = async () => {",
  "          record('queue-steer-inserted', { sessionId, itemId })",
  "          await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'steer' } })",
  "          record('queue-steered', { sessionId, itemId })",
  "        }",
  "        setTimeout(() => run().catch(error => record('queue-error', { sessionId, itemId, error: String(error) })), 0)",
  "      }",
  "    }",
  "  }, { global: true })",
  "}",
].join('\n')

/** Install the one test-only extra row into this scene's isolated patch. */
function installExtraFixture(scene, workDir) {
  const fixturePath = join(workDir, 'host-history-search-extra.mjs')
  writeFileSync(fixturePath, EXTRA_FIXTURE_SOURCE, { mode: 0o600 })
  appendFileSync(scene.c1Work.patchPath,
    `\n- insert:\n    - id: host-history-search-extra\n      name: '${pathToFileURL(fixturePath).href}'\n      inject: [agents, workingDirectory, sessionController]\n`,
    { mode: 0o600 })
}

function extraProofEvents(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function waitForExtraProof(path, kind, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const event = extraProofEvents(path).find(candidate => candidate.kind === kind)
    if (event !== undefined) return event
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label}: no extra Host proof ${kind}`)
}

/** The real installed Split accepted-input history search case. */
export async function runHostHistorySearch(context) {
  const { workDir, dshHome, trace } = context
  const scene = createC1Scene(context)
  installExtraFixture(scene, workDir)
  const requestPath = join(workDir, 'host-history-search-request.json')
  const unique = `hsp-a-unique-pr1-${String(process.pid)}-${Date.now().toString(36)}`
  let sessionId
  let uiSessionId
  let clientA
  let clientB
  let host
  let firstEvent
  let firstMessage

  const sentinelId = 'hsp-cold-sentinel'
  const emptySentinelId = 'hsp-cold-empty'
  const sentinelTexts = ['hsp-sentinel-alpha', 'hsp-sentinel-beta']
  const logA = join(workDir, 'history-search-host-a.log')
  const logB = join(workDir, 'history-search-host-b.log')
  const logC = join(workDir, 'history-search-host-c.log')
  const logD = join(workDir, 'history-search-host-d.log')
  let legacySentinel
  let thirdHost
  let fourthHost

  try {
    // Cold official sentinels + a legacy v1 file set exist BEFORE the first
    // Host: neither is ever resumed, so their durable proof lifecycle is the
    // only thing the restarts exercise.
    const sentinelCwd = realpathSync(workDir)
    await seedOfficialColdSession(context.installation, dshHome, workDir, {
      id: sentinelId,
      cwd: sentinelCwd,
      texts: sentinelTexts,
      // ONE real official accepted input carries no request correlation; only
      // its official `source.kind` may classify it.
      uncorrelatedTexts: [sentinelTexts[1]],
    })
    await seedOfficialColdSession(context.installation, dshHome, workDir, { id: emptySentinelId, cwd: sentinelCwd, texts: [] })
    legacySentinel = writeLegacyV1Sentinel(context.installation.profileDir)

    const firstHost = await scene.startC1Host('history-search', 'history host 1', {
      DSH_PI_TUI_LOG: logA,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    host = firstHost.host
    const hostPid = firstHost.ready.pid
    assert(Number.isInteger(hostPid), 'host history search: the Host did not publish a real PID')
    const hostStatusBefore = await hostStatus(host)
    assert(hostStatusBefore.localHost !== undefined, 'host history search: the Host has no local identity')

    const clientAResult = await scene.startC1Client('history client A', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    clientA = clientAResult.client
    sessionId = await scene.openC1Session(clientA, unique, 'history client A first prompt')
    assert(typeof sessionId === 'string' && sessionId !== '', 'host history search: Client A did not open a Host Session')
    const header = await waitForHostSessionHeader(dshHome, sessionId, 'host history search durable Session header')
    assert(typeof header.cwd === 'string' && header.cwd !== '',
      `host history search: the durable Session header has no cwd: ${JSON.stringify(header)}`)

    // Oracle FIRST: the prompt is proven by the official durable Session log.
    const accepted = await waitForAcceptedMessage(dshHome, sessionId, unique, 'host history search first accepted message')
    firstEvent = accepted.event
    firstMessage = accepted.message
    assert(isAcceptedUserMessage(firstMessage),
      `host history search: the accepted message is not a user-sourced admission: ${JSON.stringify(firstMessage)}`)
    assert(firstEvent.type === 'agent/inbox/spliced' || firstEvent.type === 'user/message',
      `host history search: unexpected acceptance event ${firstEvent.type}`)

    const clientBResult = await scene.startC1Client('history client B', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    clientB = clientBResult.client
    assert(clientAResult.ready.pid !== clientBResult.ready.pid,
      'host history search: Client A and Client B must be two different real PIDs')
    assert(clientAResult.ready.pid !== hostPid && clientBResult.ready.pid !== hostPid,
      'host history search: the Clients and Host must be three different real PIDs')

    // ── W01: Client B reads a message Client A submitted. ───────────────────
    const firstAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'all', query: unique, limit: 25,
    }, 'host history search W01'), 'W01')
    assert(typeof firstAnswer.generation === 'string' && firstAnswer.generation !== '',
      'W01: the ready answer carries no index generation')
    assert(firstAnswer.items.length === 1, `W01: expected exactly one item, got ${JSON.stringify(firstAnswer.items)}`)
    const firstItem = firstAnswer.items[0]
    assert(firstItem.sessionId === sessionId, `W01: wrong Session id ${JSON.stringify(firstItem)}`)
    assert(firstItem.messageId === firstMessage.id, `W01: wrong message id ${JSON.stringify(firstItem)}`)
    assert(firstItem.preview === unique, `W01: wrong preview ${JSON.stringify(firstItem.preview)}`)
    assert(firstItem.contentLength === unique.length, `W01: wrong contentLength ${String(firstItem.contentLength)}`)
    assert(firstItem.contentSha256 === sha256(unique), 'W01: wrong immutable content hash')
    assert(firstItem.effectiveCwd === header.cwd, `W01: wrong cwd ${JSON.stringify({ item: firstItem.effectiveCwd, header: header.cwd })}`)
    assert(firstItem.firstEventSeq === firstEvent.seq,
      `W01: firstEventSeq ${String(firstItem.firstEventSeq)} != durable event seq ${String(firstEvent.seq)}`)
    assert(firstItem.acceptedAt === firstEvent.time,
      `W01: acceptedAt ${String(firstItem.acceptedAt)} != durable event time ${String(firstEvent.time)}`)
    assert(firstItem.hasNonText === false, 'W01: a pure-text prompt was marked hasNonText')
    assert(firstAnswer.nextCursor === null, 'W01: a one-row answer must not claim a next page')

    // W01b: the exact original text is recoverable through bounded chunks.
    const fullText = await readFullText(clientB, requestPath, firstItem, 'W01b exact text')
    assert(fullText === unique, `W01b: chunked readText changed the original text: ${JSON.stringify(fullText)}`)
    const wrongHash = await readText(clientB, requestPath, {
      sessionId: firstItem.sessionId,
      messageId: firstItem.messageId,
      contentSha256: sha256('not the accepted text'),
      offset: 0,
      limit: 16,
    }, 'W01b stale content')
    assert(wrongHash.kind === 'unavailable' && wrongHash.reason === 'stale-content',
      `W01b: a wrong content hash did not fail closed: ${JSON.stringify(wrongHash)}`)
    const unknownMessage = await readText(clientB, requestPath, {
      sessionId: firstItem.sessionId,
      messageId: 'hsp-unknown-message-id',
      contentSha256: sha256(unique),
      offset: 0,
      limit: 16,
    }, 'W01b unknown message')
    assert(unknownMessage.kind === 'unavailable' && unknownMessage.reason === 'not-found',
      `W01b: an unknown message did not report not-found: ${JSON.stringify(unknownMessage)}`)

    // ── W01c: the bounded session-recall window on the SAME private wire. ──
    // Client B reads the accepted occurrence of the Session Client A created;
    // the window is normalized, newest-first and never exceeds 100 rows.
    const recall = await recallSettled(clientB, requestPath, sessionId, 'host history W01c recall')
    assert(recall.sessionId === sessionId, `W01c: recall answered for ${JSON.stringify(recall.sessionId)}`)
    assert(recall.items.length >= 1 && recall.items.length <= 100,
      `W01c: recall window size ${String(recall.items.length)} is outside 1..100`)
    const recalled = recall.items.find(item => item.messageId === firstMessage.id)
    assert(recalled !== undefined, `W01c: the accepted occurrence is missing from recall: ${JSON.stringify(recall.items)}`)
    assert(recalled.text === unique, `W01c: recall changed the original text: ${JSON.stringify(recalled.text)}`)
    assert(recalled.firstEventSeq === firstEvent.seq, 'W01c: recall lost the first-admission identity')
    assert(recalled.rpcId === undefined || (typeof recalled.rpcId === 'string' && recalled.rpcId !== ''),
      'W01c: recall carried an unusable optional rpcId')

    // ── W07: the REAL packed Ctrl+R UI on an INDEPENDENT Client B. ─────────
    // Client B resumes the Session Client A created; the seed occurrence is
    // Client A's accepted line, and B's own open must find it in All.
    const uiTarget = unique
    uiSessionId = sessionId
    clientB.send(`/resume ${sessionId}\r`)
    await clientB.waitForScreen(unique, 'history client B resumed A Session', 120_000)
    const uiAccepted = await runUiCtrlR({
      client: clientB,
      dshHome,
      sessionId: uiSessionId,
      target: uiTarget,
      legacySentinel,
      label: 'W07 packed Ctrl+R on independent Client B',
    })
    assert(uiAccepted !== undefined, 'W07: the second Enter produced no accepted occurrence event')
    const uiAcceptedMessage = acceptedMessage([uiAccepted], uiTarget)?.message
    assert(uiAcceptedMessage !== undefined && typeof uiAcceptedMessage.id === 'string',
      'W07: the second Enter produced no accepted user-rpc message')
    // The durable event exists before the Host index observes it. Wait for the
    // ready index to include this exact occurrence before the next query.
    await waitForIndexedOccurrence(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 25,
    }, uiAcceptedMessage.id, 'W07 indexed occurrence')

    // ── W02a: the same text submitted twice keeps two message ids. ───────────
    const afterFirst = hostSessionEvents(dshHome, sessionId)?.length ?? 0
    await submitPrompt(clientA, unique)
    const secondAccepted = await waitForHostSessionEventAfter(
      dshHome,
      sessionId,
      afterFirst,
      event => (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)
        && event.data.inserted.some(candidate => textOfMessage(candidate) === unique))
        || (event.type === 'user/message' && textOfMessage(event.data) === unique),
      'host history search second accepted message',
    )
    const secondMessage = secondAccepted.type === 'agent/inbox/spliced'
      ? secondAccepted.data.inserted.find(candidate => textOfMessage(candidate) === unique && isAcceptedUserMessage(candidate))
      : secondAccepted.data
    assert(isAcceptedUserMessage(secondMessage) && secondMessage.id !== firstMessage.id,
      `W02: the second submission did not produce a distinct accepted message id: ${JSON.stringify(secondMessage)}`)
    const duplicateAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'all', query: unique, limit: 25,
    }, 'host history search W02 duplicates'), 'W02 duplicates')
    assert(duplicateAnswer.items.length === 3, `W02: expected three occurrences, got ${JSON.stringify(duplicateAnswer.items)}`)
    assert(new Set(duplicateAnswer.items.map(item => item.messageId)).size === 3,
      'W02: two same-text submissions collapsed to one message id')

    // ── W02b: a consumed user/message does not create a second occurrence. ──
    const consumed = await waitForHostSessionEvent(
      dshHome,
      sessionId,
      event => event.type === 'user/message' && textOfMessage(event.data) === unique,
      'host history search consumed user/message',
    )
    assert(consumed.type === 'user/message', 'W02: the consumed event is not user/message')
    const afterConsume = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'all', query: unique, limit: 25,
    }, 'host history search W02 consume'), 'W02 consume')
    assert(afterConsume.items.length === 3, `W02: consume changed the occurrence count: ${JSON.stringify(afterConsume.items)}`)

    // ── S01: two keyset pages, then a stale cursor after a new mutation. ─────
    const firstPage = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 1,
    }, 'host history search S01 first page'), 'S01 first page')
    assert(firstPage.items.length === 1, 'S01: the first keyset page must hold one row')
    assert(typeof firstPage.nextCursor === 'string' && firstPage.nextCursor !== '',
      'S01: a non-final page must carry a cursor')
    const secondPage = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 1, cursor: firstPage.nextCursor,
    }, 'host history search S01 second page'), 'S01 second page')
    assert(secondPage.items.length === 1, 'S01: the second keyset page must hold the other row')
    assert(secondPage.items[0].messageId !== firstPage.items[0].messageId,
      'S01: the two keyset pages returned the same occurrence')
    assert(typeof secondPage.nextCursor === 'string' && secondPage.nextCursor !== '',
      'S01: a non-final second page must carry a cursor')
    const thirdPage = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 1, cursor: secondPage.nextCursor,
    }, 'host history search S01 third page'), 'S01 third page')
    assert(thirdPage.items.length === 1, 'S01: the third keyset page must hold the last row')
    assert(thirdPage.items[0].messageId !== firstPage.items[0].messageId
      && thirdPage.items[0].messageId !== secondPage.items[0].messageId,
    'S01: the third keyset page repeated an occurrence')
    assert(thirdPage.nextCursor === null, 'S01: the final page must not carry a cursor')
    const thirdText = `hsp-third-${String(Date.now().toString(36))}`
    await submitPrompt(clientA, thirdText)
    await waitForAcceptedMessage(dshHome, sessionId, thirdText, 'host history search S01 third accepted')
    await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: thirdText, limit: 25,
    }, 'host history search S01 mutation observed')
    const staleCursor = await search(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 1, cursor: firstPage.nextCursor,
    }, 'host history search S01 stale cursor')
    assert(staleCursor.kind === 'stale' && staleCursor.reason === 'cursor-stale',
      `S01: a cursor from the previous index revision was not rejected: ${JSON.stringify(staleCursor)}`)

    // ── W02c: the Session and directory scopes address the same facts. ───────
    const sessionAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 25,
    }, 'host history search W02 session scope'), 'W02 session')
    assert(sessionAnswer.items.length === 3, `W02 session scope returned ${String(sessionAnswer.items.length)} items`)
    const directoryAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'directory', cwd: header.cwd, query: unique, limit: 25,
    }, 'host history search W02 directory scope'), 'W02 directory')
    assert(directoryAnswer.items.length === 3, `W02 directory scope returned ${String(directoryAnswer.items.length)} items`)
    const wrongDirectory = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'directory', cwd: join(workDir, 'wrong-directory'), query: unique, limit: 25,
    }, 'host history search W02 wrong directory'), 'W02 wrong directory')
    assert(wrongDirectory.items.length === 0, 'W02 wrong directory returned foreign entries')

    const beforeIds = duplicateAnswer.items.map(item => item.messageId).sort()

    // ── W03: clean Host restart replays the SAME occurrence identities. ─────
    await scene.exitC1Client(clientB, 'history client B exit')
    clientB = undefined
    await scene.exitC1Client(clientA, 'history client A exit')
    clientA = undefined
    await scene.stopC1Host(host)
    host = undefined

    const restarted = await scene.startC1Host('history-search', 'history host 2', {
      DSH_PI_TUI_LOG: logB,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    host = restarted.host
    assert(restarted.ready.pid !== hostPid,
      `W03: the restarted Host reused the first Host PID ${String(restarted.ready.pid)}`)
    assert(restarted.ready.localHost?.instanceId !== firstHost.ready.localHost?.instanceId,
      'W03: the restarted Host reused the first Host instance identity')
    const restartedClient = await scene.startC1Client('history client B restart', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    clientB = restartedClient.client
    const restartAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 25,
    }, 'host history search W03 restart'), 'W03 restart')
    assert(restartAnswer.items.length === 3, `W03: restart returned ${String(restartAnswer.items.length)} occurrences`)
    assert(JSON.stringify(restartAnswer.items.map(item => item.messageId).sort()) === JSON.stringify(beforeIds),
      `W03: restart changed occurrence identities: ${JSON.stringify({
        before: beforeIds,
        after: restartAnswer.items.map(item => item.messageId).sort(),
      })}`)
    const durableEvents = hostSessionEvents(dshHome, sessionId) ?? []
    // The indexed acceptance time is the official inbox admission time (the
    // first durable splice), not the later user/message projection.
    const admissionTimeOf = id => durableEvents
      .find(event => event.type === 'agent/inbox/spliced'
        && Array.isArray(event.data?.inserted)
        && event.data.inserted.some(message => message?.id === id))?.time
    const firstAdmissionTime = admissionTimeOf(firstMessage.id)
    const secondAdmissionTime = admissionTimeOf(secondMessage.id)
    const uiAdmissionTime = admissionTimeOf(uiAcceptedMessage.id)
    assert(firstAdmissionTime !== undefined, 'W01: the first occurrence has no durable admission event')
    assert(secondAdmissionTime !== undefined, 'W02: the duplicate occurrence has no durable admission event')
    assert(uiAdmissionTime !== undefined, 'W07: the accepted occurrence has no durable admission event')
    const expectedTimes = new Map([
      [firstMessage.id, firstAdmissionTime],
      [secondMessage.id, secondAdmissionTime],
      [uiAcceptedMessage.id, uiAdmissionTime],
    ])
    assert(restartAnswer.items.every(item => item.preview === unique && item.effectiveCwd === header.cwd
      && item.acceptedAt === expectedTimes.get(item.messageId)),
    `W03: restart changed preview, event cwd or acceptedAt: ${JSON.stringify({
      items: restartAnswer.items.map(item => ({ id: item.messageId, preview: item.preview,
        cwd: item.effectiveCwd, acceptedAt: item.acceptedAt,
        expected: expectedTimes.get(item.messageId) })),
      headerCwd: header.cwd,
    })}`)
    const restartText = await readFullText(clientB, requestPath, restartAnswer.items[0], 'W03 restart exact text')
    assert(restartText === unique, 'W03: restart changed the recoverable original text')

    // The restarted Client must recover Client B's original accepted line
    // through the real Ctrl+R UI, not only the private probe.
    clientB.send('\x12')
    await clientB.waitForScreen('Input History', 'W03 restart Ctrl+R seat', 120_000)
    // The restarted Client has no live Session but a confirmed Workspace, so
    // History opens on Directory; ONE scope tick reaches All.
    clientB.send('\t')
    await clientB.waitForScreen('[All Directories]', 'W03 restart All scope', 120_000)
    clientB.send(uiTarget)
    await waitForStableHistoryResult(clientB, uiTarget, 'W03 restart stable selected result')
    clientB.send('\x1b')
    await clientB.waitForScreen('❯', 'W03 restart History closed back to Composer', 30_000)

    // ── W04: a third real Host reuses the committed cold proofs. ───────────
    await scene.exitC1Client(clientB, 'history client B exit')
    clientB = undefined
    await scene.stopC1Host(host)
    host = undefined
    await scene.awaitSceneSeatFree()
    const countersB = await waitForBootstrapCounters(logB, 'W03 restarted host')
    assert(Number(countersB.sourceProofHit) >= 2,
      `W04: the restarted Host reused no cold sentinel proof: ${JSON.stringify(countersB)}`)
    thirdHost = await scene.startC1Host('history-search', 'history host 3', {
      DSH_PI_TUI_LOG: logC,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    host = thirdHost.host
    assert(thirdHost.ready.pid !== restarted.ready.pid,
      `W04: the third Host reused the second Host PID ${String(thirdHost.ready.pid)}`)
    assert(thirdHost.ready.localHost?.instanceId !== restarted.ready.localHost?.instanceId,
      'W04: the third Host reused the second Host instance identity')
    const clientCResult = await scene.startC1Client('history client C', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    clientB = clientCResult.client
    const sentinelAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId: sentinelId, query: 'hsp-sentinel-', limit: 25,
    }, 'host history search W04 sentinel'), 'W04 sentinel')
    assert(sentinelAnswer.items.length === 2,
      `W04: the reused cold sentinel projection returned ${JSON.stringify(sentinelAnswer.items)}`)
    assert(JSON.stringify(sentinelAnswer.items.map(item => item.preview).sort()) === JSON.stringify([...sentinelTexts].sort()),
      'W04: the reused cold sentinel changed its accepted previews')
    // The independent oracle proves the sentinel's second accepted input was
    // really written WITHOUT rpcId; the product must still index it exactly.
    const sentinelEvents = hostSessionEvents(dshHome, sentinelId) ?? []
    const sentinelBeta = acceptedMessage(sentinelEvents, sentinelTexts[1])
    assert(sentinelBeta !== undefined, 'W04: the oracle found no durable no-rpcId sentinel input')
    assert(sentinelBeta.message.source?.kind === 'user' && sentinelBeta.message.source?.rpcId === undefined,
      `W04: the sentinel input is not an uncorrelated user source: ${JSON.stringify(sentinelBeta.message.source)}`)
    const sentinelBetaItem = sentinelAnswer.items.find(item => item.messageId === sentinelBeta.message.id)
    assert(sentinelBetaItem !== undefined, 'W04: the no-rpcId sentinel occurrence is missing from the projection')
    const sentinelBetaText = await readFullText(clientB, requestPath, sentinelBetaItem, 'W04 no-rpcId sentinel text')
    assert(sentinelBetaText === sentinelTexts[1],
      `W04: readText did not recover the no-rpcId accepted text: ${JSON.stringify(sentinelBetaText)}`)
    const emptyAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId: emptySentinelId, query: '', limit: 25,
    }, 'host history search W04 empty sentinel'), 'W04 empty sentinel')
    assert(emptyAnswer.items.length === 0, 'W04: a header-only cold sentinel produced a phantom occurrence')
    const targetAgain = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 25,
    }, 'host history search W04 target'), 'W04 target')
    assert(targetAgain.items.length === 3 && JSON.stringify(targetAgain.items.map(item => item.messageId).sort())
      === JSON.stringify(beforeIds), 'W04: the reused proof changed the target occurrence identities')
    const countersC = await waitForBootstrapCounters(logC, 'W04 host')
    assert(Number(countersC.sourceProofHit) >= 3,
      `W04: the all-cold restart reused no proof: ${JSON.stringify(countersC)}`)
    for (const field of ['directPersistenceOpenCalls', 'directPersistenceReadCalls', 'directPersistenceStatCalls', 'replayAttempted']) {
      assert(Number(countersC[field]) === 0,
        `W04: a stable eligible cold corpus performed ${field}=${String(countersC[field])}`)
    }
    await scene.exitC1Client(clientB, 'history client C exit')
    clientB = undefined
    await scene.stopC1Host(host)
    host = undefined
    await scene.awaitSceneSeatFree()

    // ── W05: one offline official append is the ONLY rebuilt source. ───────
    const appendedText = 'hsp-sentinel-appended'
    await appendOfficialColdEvent(context.installation, dshHome, workDir, sentinelId, { text: appendedText, seq: sentinelTexts.length })
    fourthHost = await scene.startC1Host('history-search', 'history host 4', {
      DSH_PI_TUI_LOG: logD,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    host = fourthHost.host
    assert(fourthHost.ready.pid !== thirdHost.ready.pid && fourthHost.ready.pid !== restarted.ready.pid,
      'W05: the fourth Host reused a previous PID')
    assert(fourthHost.ready.localHost?.instanceId !== thirdHost.ready.localHost?.instanceId,
      'W05: the fourth Host reused the third instance identity')
    const clientDResult = await scene.startC1Client('history client D', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    clientB = clientDResult.client
    const appendedAnswer = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId: sentinelId, query: 'hsp-sentinel-', limit: 25,
    }, 'host history search W05 appended'), 'W05 appended')
    assert(appendedAnswer.items.length === 3,
      `W05: the changed cold sentinel returned ${JSON.stringify(appendedAnswer.items)}`)
    assert(JSON.stringify(appendedAnswer.items.map(item => item.preview).sort())
      === JSON.stringify([...sentinelTexts, appendedText].sort()),
    'W05: the rebuilt sentinel lost an accepted occurrence')
    const stableTarget = assertReady(await searchSettled(clientB, requestPath, {
      scope: 'session', sessionId, query: unique, limit: 25,
    }, 'host history search W05 stable target'), 'W05 stable target')
    assert(stableTarget.items.length === 3, 'W05: an unrelated stable source was not reused')
    const countersD = await waitForBootstrapCounters(logD, 'W05 host')
    assert(Number(countersD.sourceProofHit) >= 2,
      `W05: unchanged cold sources were not reused: ${JSON.stringify(countersD)}`)
    assert(Number(countersD.sourceProofMinted) === 1,
      `W05: the one changed source minted ${String(countersD.sourceProofMinted)} proofs`)
    assert(Number(countersD.directPersistenceOpenCalls) === 1,
      `W05: only the changed source may open: ${JSON.stringify(countersD)}`)
    assert(Number(countersD.directPersistenceStatCalls) === 1,
      `W05: only the changed source may stat: ${JSON.stringify(countersD)}`)
    assert(Number(countersD.directPersistenceReadCalls) >= 1,
      'W05: the changed source was not read')
    assert(Number(countersD.sourceProofMiss) >= 1,
      'W05: the changed revision did not miss its durable proof')
    // Complete D Owner witness: every ordered semantic row + exact full text.
    // This is the comparison witness for the independent fresh-v3 rebuild.
    const recoveredItems = await readAllHistoryItems(clientB, requestPath, {
      scope: 'all', query: '', limit: 7,
    }, 'W05 recovery witness')
    assert(recoveredItems.length >= 3, `W05: recovery witness has ${String(recoveredItems.length)} rows`)
    const recoveredText = new Map()
    for (const item of recoveredItems) {
      recoveredText.set(`${item.sessionId}/${item.messageId}`,
        await readFullText(clientB, requestPath, item, 'W05 recovery witness text'))
    }
    await scene.exitC1Client(clientB, 'history client D exit')
    clientB = undefined
    await scene.stopC1Host(host)
    host = undefined
    await scene.awaitSceneSeatFree()

    // ── W02c: real working-directory/change H1→H2 on the same Host. ───────
    const cwdProof = join(workDir, 'host-history-search-cwd-proof.jsonl')
    writeFileSync(cwdProof, '', { mode: 0o600 })
    // The Host Workspace resolution realpaths a proposed directory (macOS
    // `/var` -> `/private/var`), so the smoke addresses the SAME canonical
    // spellings the durable events will carry.
    mkdirSync(join(workDir, 'history-cwd-one'), { recursive: true, mode: 0o700 })
    mkdirSync(join(workDir, 'history-cwd-two'), { recursive: true, mode: 0o700 })
    const cwdOne = realpathSync(join(workDir, 'history-cwd-one'))
    const cwdTwo = realpathSync(join(workDir, 'history-cwd-two'))
    // ── S01 oracle: independent fresh-v3 cold rebuild before any new input. ─
    // D is stopped and the seat free. Move the EXACT active v3 set aside, start
    // the existing W02c Host against an absent derived store, and compare its
    // complete Owner pages + readText with D's witness BEFORE opening a Session.
    const historyDir = join(context.installation.profileDir, '.dsh-pi-tui', 'history-search')
    const backupDir = join(historyDir, `.oracle-v3-${String(process.pid)}-${Date.now().toString(36)}`)
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    chmodSync(backupDir, 0o700)
    let movedFiles = 0
    for (const suffix of ['', '-wal', '-shm']) {
      const file = join(historyDir, `v3.sqlite${suffix}`)
      if (!existsSync(file)) continue
      renameSync(file, join(backupDir, `v3.sqlite${suffix}`))
      movedFiles += 1
    }
    assert(movedFiles >= 1, 'S01 oracle: the active v3 set was not moved')
    assert(!existsSync(join(historyDir, 'v3.sqlite')), 'S01 oracle: the fresh v3 path is still present')
    const oracleLog = join(workDir, 'history-search-host-oracle.log')
    const cwdHost = await scene.startC1Host('history-search', 'history cwd host', {
      HISTORY_SEARCH_EXTRA_PROOF: cwdProof,
      HISTORY_SEARCH_CWD_TARGET: cwdTwo,
      DSH_PI_TUI_LOG: oracleLog,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    host = cwdHost.host
    const cwdClientResult = await scene.startC1Client('history cwd client', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    }, { cwd: cwdOne })
    const cwdClient = cwdClientResult.client
    const oracleItems = await readAllHistoryItems(cwdClient, requestPath, {
      scope: 'all', query: '', limit: 7,
    }, 'S01 oracle')
    assert(JSON.stringify(oracleItems.map(historySemantic)) === JSON.stringify(recoveredItems.map(historySemantic)),
      'S01 oracle: the fresh cold rebuild is not semantically equal to D')
    for (const item of oracleItems) {
      assert(await readFullText(cwdClient, requestPath, item, 'S01 oracle text')
        === recoveredText.get(`${item.sessionId}/${item.messageId}`),
      `S01 oracle: readText differs for ${item.sessionId}/${item.messageId}`)
    }
    const countersOracle = await waitForBootstrapCounters(oracleLog, 'S01 oracle host')
    assert(Number(countersOracle.sourceProofHit) === 0,
      `S01 oracle: a fresh v3 reused a proof: ${JSON.stringify(countersOracle)}`)
    assert(Number(countersOracle.sourceProofMinted) >= 3,
      `S01 oracle: the fresh cold rebuild minted ${String(countersOracle.sourceProofMinted)} proofs`)
    assert(Number(countersOracle.directPersistenceOpenCalls) >= 3,
      'S01 oracle: the fresh rebuild did not read the official sources')
    trace('host-history-search/pr3a-oracle', {
      movedFiles,
      rows: oracleItems.length,
      hits: Number(countersOracle.sourceProofHit),
      minted: Number(countersOracle.sourceProofMinted),
      opens: Number(countersOracle.directPersistenceOpenCalls),
      backupDir,
    })
    writeFileSync(join(workDir, 'history-search-oracle-facts.json'), `${JSON.stringify({
      movedFiles,
      backupDir,
      oraclePid: cwdClientResult.ready.pid,
      recovered: recoveredItems.map(historySemantic),
      oracle: oracleItems.map(historySemantic),
      recoveredTextLengths: Object.fromEntries([...recoveredText].map(([key, text]) => [key, text.length])),
      oracleTextLengths: Object.fromEntries(oracleItems.map(item => [`${item.sessionId}/${item.messageId}`, item.contentLength])),
      counters: countersOracle,
    }, null, 2)}\n`, { mode: 0o600 })
    const cwdSession = await scene.openC1Session(cwdClient, 'hsp-cwd-one', 'history cwd first prompt')
    const cwdHeader = await waitForHostSessionHeader(dshHome, cwdSession, 'history cwd durable header')
    await waitForHostSessionEvent(dshHome, cwdSession, event => event.type === 'turn/end', 'W02c first turn settled')
    assert(cwdHeader.cwd === cwdOne, `W02c: initial cwd ${JSON.stringify(cwdHeader.cwd)} != ${cwdOne}`)
    await submitPrompt(cwdClient, 'hsp-cwd-switch')
    await waitForAcceptedMessage(dshHome, cwdSession, 'hsp-cwd-switch', 'W02c cwd switch accepted')
    await waitForExtraProof(cwdProof, 'cwd-set', 'W02c official workingDirectory.set')
    const beforeSecond = (hostSessionEvents(dshHome, cwdSession) ?? []).length
    await submitPrompt(cwdClient, 'hsp-cwd-two')
    await waitForAcceptedMessage(dshHome, cwdSession, 'hsp-cwd-two', 'W02c cwd second accepted')
    await waitForHostSessionEventAfter(dshHome, cwdSession, beforeSecond, event => event.type === 'turn/end', 'W02c second turn settled')
    const cwdAll = assertReady(await searchSettled(cwdClient, requestPath, {
      scope: 'session', sessionId: cwdSession, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02c cwd session'), 'W02c cwd session')
    assert(cwdAll.items.length === 3, `W02c: expected three cwd occurrences (H1 prompt, H1 switch marker, H2 prompt), got ${JSON.stringify(cwdAll.items)}`)
    const cwdH1 = assertReady(await searchSettled(cwdClient, requestPath, {
      scope: 'directory', cwd: cwdOne, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02c cwd H1'), 'W02c cwd H1')
    const cwdH2 = assertReady(await searchSettled(cwdClient, requestPath, {
      scope: 'directory', cwd: cwdTwo, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02c cwd H2'), 'W02c cwd H2')
    assert(cwdH1.items.length === 2 && cwdH1.items.some(item => item.preview === 'hsp-cwd-one') && cwdH1.items.some(item => item.preview === 'hsp-cwd-switch'), `W02c H1: ${JSON.stringify(cwdH1.items)}`)
    assert(cwdH2.items.length === 1 && cwdH2.items[0].preview === 'hsp-cwd-two', `W02c H2: ${JSON.stringify(cwdH2.items)}`)

    // ── W02d: real /fork child inherits no new occurrence for the parent prefix. ──
    const forkBoundary = cwdClient.records.length
    cwdClient.send('/fork\r')
    const childStatus = await cwdClient.waitFor(record => cwdClient.records.indexOf(record) >= forkBoundary
      && record.m4b2s === 'surface-status' && record.sessionOpen === true
      && typeof record.openSessionId === 'string' && record.openSessionId !== cwdSession,
    'W02d Client adopted forked child', 120_000)
    const forkSession = childStatus.openSessionId
    assert(typeof forkSession === 'string' && forkSession !== cwdSession, 'W02d: /fork did not open a child')
    const childPromptText = 'hsp-fork-child-admission'
    await submitPrompt(cwdClient, childPromptText)
    await waitForAcceptedMessage(dshHome, forkSession, childPromptText, 'W02d child accepted message')
    const forkChild = assertReady(await searchSettled(cwdClient, requestPath, {
      scope: 'session', sessionId: forkSession, query: childPromptText, limit: 25,
    }, 'host history search W02d fork child'), 'W02d fork child')
    assert(forkChild.items.length === 1, `W02d: fork child occurrence ${JSON.stringify(forkChild.items)}`)
    const forkParent = assertReady(await searchSettled(cwdClient, requestPath, {
      scope: 'session', sessionId: cwdSession, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02d fork parent'), 'W02d fork parent')
    assert(forkParent.items.length === 3, `W02d: fork inherited prefix inflated parent occurrences: ${JSON.stringify(forkParent.items)}`)
    // The fork child's recall window carries ONLY its own post-cut input: the
    // inherited parent prefix is never a fork occurrence.
    const forkRecall = await recallSettled(cwdClient, requestPath, forkSession, 'host history W02d fork recall')
    assert(forkRecall.sessionId === forkSession, 'W02d: fork recall addressed another Session')
    assert(forkRecall.items.length === 1 && forkRecall.items[0].text === childPromptText,
      `W02d: fork recall must carry exactly its own input: ${JSON.stringify(forkRecall.items)}`)

    // Stop the cwd/fork Host before the long-turn Host: the profile owns ONE Host seat.
    await scene.exitC1Client(cwdClient, 'history cwd client exit')
    await scene.stopC1Host(cwdHost.host)
    await scene.awaitSceneSeatFree()

    // ── W02e: real official queue edit/remove on a held Turn. ──────────────
    const queueProof = join(workDir, 'host-history-search-queue-proof.jsonl')
    const queueBarrier = join(workDir, 'host-history-search-queue-release')
    writeFileSync(queueProof, '', { mode: 0o600 })
    const queueHost = await scene.startC1Host('long-turn', 'history queue host', {
      C1_HOLD_LONG_TURN: queueBarrier,
      HISTORY_SEARCH_EXTRA_PROOF: queueProof,
    })
    host = queueHost.host
    const queueClientResult = await scene.startC1Client('history queue client', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    const queueClient = queueClientResult.client
    const queueSession = await scene.openC1Session(queueClient, 'hsp-queue-seed', 'history queue seed')
    await waitForC1WorkEvent(queueHost.workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === queueSession, 'W02e held Turn')
    queueClient.send('hsp-queue-target\r')
    await waitForExtraProof(queueProof, 'queue-removed', 'W02e official updateQueue edit+remove')
    const queueAnswer = assertReady(await searchSettled(queueClient, requestPath, {
      scope: 'session', sessionId: queueSession, query: 'hsp-queue-target', limit: 25,
    }, 'host history search W02e queue original'), 'W02e queue original')
    assert(queueAnswer.items.length === 1 && queueAnswer.items[0].preview === 'hsp-queue-target',
      `W02e: queue edit/remove changed the accepted occurrence: ${JSON.stringify(queueAnswer.items)}`)
    const editedAnswer = assertReady(await searchSettled(queueClient, requestPath, {
      scope: 'session', sessionId: queueSession, query: 'hsp-queue-edited', limit: 25,
    }, 'host history search W02e queue edited'), 'W02e queue edited')
    assert(editedAnswer.items.length === 0, 'W02e: the edited body became a second occurrence')
    queueClient.send('hsp-queue-steer\r')
    const steerProof = await waitForExtraProof(queueProof, 'queue-steered', 'W02e official updateQueue steer')
    await waitForHostSessionEvent(dshHome, queueSession,
      event => event.type === 'agent/inbox/spliced' && event.data?.target === 'next-step'
        && Array.isArray(event.data.inserted) && event.data.inserted.some(message => message?.id === steerProof.itemId),
      'W02e official steer state')
    // W02d's fork child is now a COLD source after the Host restart: prove its
    // own accepted row survives and the inherited parent prefix remains cut.
    const coldForkOwn = assertReady(await searchSettled(queueClient, requestPath, {
      scope: 'session', sessionId: forkSession, query: childPromptText, limit: 25,
    }, 'host history search W02e cold fork own'), 'W02e cold fork own')
    assert(coldForkOwn.items.length === 1 && coldForkOwn.items[0].preview === childPromptText,
      `W02e: cold fork own row is not exactly one: ${JSON.stringify(coldForkOwn.items)}`)
    const coldForkInherited = assertReady(await searchSettled(queueClient, requestPath, {
      scope: 'session', sessionId: forkSession, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02e cold fork inherited cut'), 'W02e cold fork inherited cut')
    assert(coldForkInherited.items.length === 0,
      `W02e: cold fork inherited prefix leaked ${String(coldForkInherited.items.length)} rows`)
    const coldForkParent = assertReady(await searchSettled(queueClient, requestPath, {
      scope: 'session', sessionId: cwdSession, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02e cold fork parent'), 'W02e cold fork parent')
    assert(coldForkParent.items.length === 3,
      `W02e: cold fork changed the parent count: ${JSON.stringify(coldForkParent.items)}`)

    const steerAnswer = assertReady(await searchSettled(queueClient, requestPath, {
      scope: 'session', sessionId: queueSession, query: 'hsp-queue-steer', limit: 25,
    }, 'host history search W02e queue steer'), 'W02e queue steer')
    assert(steerAnswer.items.length === 1 && steerAnswer.items[0].preview === 'hsp-queue-steer',
      `W02e: the steered occurrence is not exactly one original: ${JSON.stringify(steerAnswer.items)}`)
    const beforeRelease = (hostSessionEvents(dshHome, queueSession) ?? []).length
    writeFileSync(queueBarrier, 'release\n', { mode: 0o600 })
    await waitForHostSessionEventAfter(dshHome, queueSession, beforeRelease,
      event => event.type === 'user/message' && textOfMessage(event.data) === 'hsp-queue-steer',
      'W02e steered message claimed after release', 120_000)
    await waitForC1WorkEvent(queueHost.workRoot,
      event => event.kind === 'long-turn-released' && event.sessionId === queueSession, 'W02e released Turn')
    await scene.exitC1Client(queueClient, 'history queue client exit')
    await scene.stopC1Host(queueHost.host)
    await scene.awaitSceneSeatFree()
    host = undefined

    // W02f: the cold fork rebuilt by W02e must now hit its committed proof on a
    // DISTINCT Host restart, with zero official body reads for the fork source.
    const forkProofBefore = sourceProofOf(context.installation.profileDir, forkSession)
    assert(forkProofBefore !== undefined, 'W02f: the cold fork has no committed proof before restart')
    const forkRestartLog = join(workDir, 'host-history-search-fork-restart.log')
    const forkRestart = await scene.startC1Host('history-search', 'history fork restart host', {
      DSH_PI_TUI_LOG: forkRestartLog,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    const forkRestartClientResult = await scene.startC1Client('history fork restart client', {
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    const forkRestartClient = forkRestartClientResult.client
    const forkRestartOwn = assertReady(await searchSettled(forkRestartClient, requestPath, {
      scope: 'session', sessionId: forkSession, query: childPromptText, limit: 25,
    }, 'host history search W02f fork restart own'), 'W02f fork restart own')
    assert(forkRestartOwn.items.length === 1 && forkRestartOwn.items[0].preview === childPromptText,
      `W02f: cold-fork proof hit own row: ${JSON.stringify(forkRestartOwn.items)}`)
    const forkRestartInherited = assertReady(await searchSettled(forkRestartClient, requestPath, {
      scope: 'session', sessionId: forkSession, query: 'hsp-cwd-', limit: 25,
    }, 'host history search W02f fork restart inherited'), 'W02f fork restart inherited')
    assert(forkRestartInherited.items.length === 0,
      `W02f: cold-fork proof hit inherited prefix leaked ${String(forkRestartInherited.items.length)} rows`)
    const forkRestartCounters = await waitForBootstrapCounters(forkRestartLog, 'W02f fork restart')
    assert(Number(forkRestartCounters.sourceProofHit) >= 5,
      `W02f: the restart did not prove the unchanged sources: ${JSON.stringify(forkRestartCounters)}`)
    assert(Number(forkRestartCounters.directPersistenceOpenCalls) <= 1,
      `W02f: more than one cold source opened: ${JSON.stringify(forkRestartCounters)}`)
    const forkProofAfter = sourceProofOf(context.installation.profileDir, forkSession)
    assert(forkProofAfter !== undefined
      && forkProofAfter.source_revision === forkProofBefore.source_revision
      && forkProofAfter.checkpoint_hash === forkProofBefore.checkpoint_hash,
    `W02f: the fork proof changed across the restart: ${JSON.stringify({ forkProofBefore, forkProofAfter })}`)
    await scene.exitC1Client(forkRestartClient, 'history fork restart client exit')
    await scene.stopC1Host(forkRestart.host)
    await scene.awaitSceneSeatFree()
    host = undefined

    // ── W04b: after the Host process restarts, FRESH Clients' real editor ↑/↓
    // restore the Host-seeded Session once; their submit creates exactly ONE new
    // official occurrence. A separate Client per Session proves no old row
    // leaks into the new scope. This runs after the cold-proof assertions so the
    // accepted submit cannot invalidate their unchanged-source evidence.
    const logE = join(workDir, 'host-history-search-recall-editor.log')
    const recallHost = await scene.startC1Host('history-search', 'history recall host', {
      DSH_PI_TUI_LOG: logE,
      DSH_PI_TUI_LOG_LEVEL: 'debug',
    })
    host = recallHost.host
    const targetRecallTexts = (hostSessionEvents(dshHome, sessionId) ?? []).flatMap((event) => {
      if (event.type === 'agent/inbox/spliced') {
        return (event.data.inserted ?? []).filter(isAcceptedUserMessage).map(textOfMessage)
      }
      if (event.type === 'user/message' && isAcceptedUserMessage(event.data)) return [textOfMessage(event.data)]
      return []
    })
    const recallAStart = await scene.startC1Client('history recall client A', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionId,
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    const recallA = recallAStart.client
    await recallA.waitForScreen('❯', 'W04b fresh A Client mounted', 120_000)
    await waitForComposerDraft(recallA, '', 'W04b fresh A editor starts empty', 120_000)
    const recalledText = await waitForSeededComposerDraft(recallA, targetRecallTexts, 'W04b A seed')
    // ↑ is the ONLY input; ↓ restores the exact pre-browse empty draft.
    await clearSeededComposerDraft(recallA, 'W04b ↓ returns to the empty draft')
    const aAllowed = [...new Set([...targetRecallTexts, recalledText])]
    const aDrafts = await browseAllRecallDrafts(recallA, 'W04b A complete browse')
    assert(aDrafts.every(text => aAllowed.includes(text)),
      `W04b: A browse carried a foreign row: ${JSON.stringify(aDrafts)}`)
    await clearSeededComposerDraft(recallA, 'W04b A browse cleared')
    const countAcceptedText = (text) => {
      const ids = new Set()
      for (const event of hostSessionEvents(dshHome, sessionId) ?? []) {
        if (event.type === 'agent/inbox/spliced') {
          for (const message of event.data.inserted ?? []) {
            if (isAcceptedUserMessage(message) && textOfMessage(message) === text) ids.add(message.id)
          }
        } else if (event.type === 'user/message' && isAcceptedUserMessage(event.data) && textOfMessage(event.data) === text) {
          ids.add(event.data.id)
        }
      }
      return ids.size
    }
    const beforeSubmit = countAcceptedText(recalledText)
    recallA.send('\x1b[A')
    await waitForComposerDraft(recallA, recalledText, 'W04b ↑ recalls the same seed again', 120_000)
    recallA.send('\r')
    const submitDeadline = Date.now() + 120_000
    while (countAcceptedText(recalledText) < beforeSubmit + 1 && Date.now() < submitDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert(countAcceptedText(recalledText) === beforeSubmit + 1,
      `W04b: the recalled submit did not create exactly one official occurrence (before=${String(beforeSubmit)}): ${JSON.stringify(await recallA.viewport())}`)
    await scene.exitC1Client(recallA, 'history recall client A exit')
    // B's own seed is the only recalled row in a fresh B Client.
    const recallBStart = await scene.startC1Client('history recall client B', {
      SPLIT_PROCESS_CLIENT_SESSION: sentinelId,
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    const recallB = recallBStart.client
    await recallB.waitForScreen('❯', 'W04b fresh B Client mounted', 120_000)
    await waitForComposerDraft(recallB, '', 'W04b fresh B editor starts empty', 120_000)
    const sentinelRecallText = await waitForSeededComposerDraft(recallB, sentinelTexts, 'W04b B seed')
    assert(targetRecallTexts.includes(sentinelRecallText) === false, 'W04b: A history leaked into B')
    await clearSeededComposerDraft(recallB, 'W04b B ↓ empty')
    const bAllowed = [...new Set([...sentinelTexts, appendedText])]
    const bDrafts = await browseAllRecallDrafts(recallB, 'W04b B complete browse')
    assert(bDrafts.every(text => bAllowed.includes(text)),
      `W04b: B browse carried a foreign row: ${JSON.stringify(bDrafts)}`)
    assert(bDrafts.some(text => targetRecallTexts.includes(text)) === false,
      'W04b: an A row appeared anywhere in B\'s complete browse')
    await clearSeededComposerDraft(recallB, 'W04b B browse cleared before exit')
    await scene.exitC1Client(recallB, 'history recall client B exit')
    // Back to A in a NEW Client: B's history never leaks into the restored A.
    const recallA2Start = await scene.startC1Client('history recall client A again', {
      SPLIT_PROCESS_CLIENT_SESSION: sessionId,
      SPLIT_PROCESS_CLIENT_HISTORY_SEARCH_REQUEST: requestPath,
    })
    const recallA2 = recallA2Start.client
    await recallA2.waitForScreen('❯', 'W04b fresh A Client returns', 120_000)
    await waitForComposerDraft(recallA2, '', 'W04b fresh A editor starts empty again', 120_000)
    const backToA = await waitForSeededComposerDraft(recallA2, targetRecallTexts, 'W04b A reseed')
    assert(sentinelTexts.includes(backToA) === false, 'W04b: B history leaked into the restored A')
    await clearSeededComposerDraft(recallA2, 'W04b A ↓ empty')
    const a2Drafts = await browseAllRecallDrafts(recallA2, 'W04b A complete browse again')
    assert(a2Drafts.every(text => aAllowed.includes(text)),
      `W04b: restored A browse carried a foreign row: ${JSON.stringify(a2Drafts)}`)
    const bOnly = [...new Set([...sentinelTexts, appendedText])]
    assert(a2Drafts.some(text => bOnly.includes(text)) === false,
      'W04b: a B row appeared anywhere in the restored A browse')
    await clearSeededComposerDraft(recallA2, 'W04b A browse cleared before exit')
    await scene.exitC1Client(recallA2, 'history recall client A again exit')
    await scene.stopC1Host(recallHost.host)
    await scene.awaitSceneSeatFree()
    host = undefined

    // W06: the active derived store is v3, private and profile-local; the
    // legacy v1 file set stayed byte/mode/inode identical.
    const dbPath = join(historyDir, 'v3.sqlite')
    const dbStat = statSync(dbPath)
    const dirStat = statSync(historyDir)
    assert((dbStat.mode & 0o777) === 0o600,
      `W06: the derived index file mode is ${(dbStat.mode & 0o777).toString(8)}, expected 600`)
    assert((dirStat.mode & 0o077) === 0,
      `W06: the derived index directory mode ${(dirStat.mode & 0o777).toString(8)} is not private`)
    assertLegacyV1Untouched(legacySentinel)
    const derived = inspectDerivedHistory(context.installation.profileDir)
    assert(derived.userVersion === 3, `W06: v3 user_version is ${String(derived.userVersion)}`)
    assert(derived.sessions >= 3, `W06: v3 holds ${String(derived.sessions)} sessions`)
    assert(derived.proofs >= 3, `W06: v3 holds ${String(derived.proofs)} durable proofs`)
    trace('host-history-search/pr3a', {
      status: 'PASS',
      hostPid,
      secondHostPid: restarted.ready.pid,
      thirdHostPid: thirdHost.ready.pid,
      fourthHostPid: fourthHost.ready.pid,
      clientAPid: clientAResult.ready.pid,
      clientBPid: clientBResult.ready.pid,
      sessionId,
      sentinelId,
      emptySentinelId,
      firstMessageId: firstMessage.id,
      firstEventSeq: firstEvent.seq,
      firstEventType: firstEvent.type,
      firstEventTime: firstEvent.time,
      cwd: header.cwd,
      occurrences: 3,
      sentinelColdTexts: sentinelTexts.length + 1,
      restarted: true,
      thirdHostAllColdHits: Number(countersC.sourceProofHit),
      thirdHostOpenCalls: Number(countersC.directPersistenceOpenCalls),
      fourthHostHits: Number(countersD.sourceProofHit),
      fourthHostOpens: Number(countersD.directPersistenceOpenCalls),
      cwdChange: true,
      forkChild: true,
      coldForkOwnRows: 1,
      coldForkInheritedRows: 0,
      coldForkProofHit: true,
      coldForkProofRevision: forkProofBefore.source_revision,
      coldForkProofCheckpoint: forkProofBefore.checkpoint_hash,
      coldForkProofUnchanged: forkProofAfter?.source_revision === forkProofBefore.source_revision
        && forkProofAfter?.checkpoint_hash === forkProofBefore.checkpoint_hash,
      coldForkHitOpens: Number(forkRestartCounters.directPersistenceOpenCalls),
      queueEditRemove: true,
      queueSteer: true,
      keysetPages: true,
      staleCursor: true,
      exactTextChunks: true,
      dbPath,
      v3UserVersion: derived.userVersion,
      v3Proofs: derived.proofs,
      legacyV1Untouched: true,
      hostLogs: [logA, logB, logC, logD],
      quiesced: true,
    })
    return { status: 'PASS' }
  } finally {
    if (clientA !== undefined) await clientA.dispose().catch(() => {})
    if (clientB !== undefined) await clientB.dispose().catch(() => {})
    await scene.dispose()
  }
}