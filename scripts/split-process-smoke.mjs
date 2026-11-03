#!/usr/bin/env node
/**
 * Real-OS split-process authenticated-link smoke.
 *
 * Installs the candidate tarball into an isolated `pi-tui` profile using the
 * published exact DSH family, then drives the two internal process entries
 * from the installed package directory. The lane proves the lifecycle
 * assertions that still hold plus the first-launch gates:
 *
 *   T01 Host-only composition + official Connection/API-remotes owners
 *   T02 authenticated loopback HTTP + one real WebSocket `$events` generation
 *   T03/T04/T06 unauthenticated, wrong-token, wrong-identity refusals
 *   T05 one mux socket per authenticated peer; old Peer is dead after release
 *   T07 private-file permissions/symlinks fail closed
 *   T08 sixteen concurrent Host launches produce exactly one Host
 *   T09 a second Client is refused before it can spawn or steal a Host
 *   T10/T11/T12 Client normal exit, SIGKILL and SIGTERM leave the Host alive
 *   T13 a physical mux drop clears the generation and the same Host replaces it
 *   T14/T16/T17 forged registry, unresponsive Host, protocol/identity/auth failures
 *                and non-destructive installed-payload drift
 *   T15 a dead Host leaves only a stale candidate; a Client safely starts a new one
 *   T18 installed package shape and Direct `--help` remain unchanged
 *   T19 signal admission precedes publication; repeated same signals stay idempotent (no ready)
 *   T20 an early forced exit removes the Host-created scratch before profile boot
 *   T21 the official Session-serving rows + ONE built-in Host Runtime row are ACTIVE
 *   T22/T23/T24 a real Client PID proves official session/list, private PiFile RPC
 *                and the private terminal-progress snapshot over the authenticated link
 *   T25 repeated probes register no duplicate descriptor; Client exit keeps the same Host
 *   T26 Host Runtime row/artifact absence / required official row / Cookie fail closed, no Ready
 *
 * Usage: node scripts/split-process-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:split-process -- [path-to-candidate.tgz]
 *
 * Set SPLIT_PROCESS_SMOKE_KEEP=1 to preserve the isolated work directory and
 * SPLIT_PROCESS_TRACE=<path> to append sanitized qualification events (never a
 * token, Cookie or connect URL).
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import xterm from '@xterm/headless'
import { parse as parseYaml } from 'yaml'

import {
  candidateArgument,
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  resolveTarball,
  runDsh,
  runPnpmInstall,
  validateCandidateTarball,
} from './pi2dsh-compat-smoke.mjs'
import { loadDshDistribution, npmDshVersion, PACKAGE_ROOT } from './lib/dsh-distribution.mjs'
import {
  boundedName,
  createSmokeDiagnostics,
  emitInputFailure,
  forensicErrorText,
  requireExactSmokeDshPin,
  safeFailureSummary,
  smokeArtifactIdentity,
  SplitSmokeAssertionError,
  SplitSmokeWaitError,
} from './lib/split-smoke-diagnostics.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TRACE_PATH = process.env.SPLIT_PROCESS_TRACE
const KEEP = process.env.SPLIT_PROCESS_SMOKE_KEEP === '1'
const HOST_LOG_LIMIT = 2 * 1024 * 1024
/** Qualification-only failure point for the smoke's own finally cleanup proof. */
const FAILPOINT = process.env.SPLIT_PROCESS_SMOKE_FAIL_AFTER

let traceFd
let sequence = 0
let statusSequence = 0
/** This run's bounded diagnostics (checkpoints + one default failure report). */
let diagnostics
const activeProcesses = new Set()
/** Detached processes this round owns: PID -> its kernel starttime (if known). */
const trackedProcesses = new Map()

/**
 * One qualification checkpoint. The event NAME is always remembered (bounded to
 * a fixed length) and announced on stderr, so a default run is diagnosable
 * without `SPLIT_PROCESS_TRACE`; the fields stay out of the default output and
 * are written to the explicit trace file exactly as before. Never pass a secret.
 */
function trace(event, fields = {}) {
  diagnostics?.checkpoint(event)
  if (TRACE_PATH === undefined || TRACE_PATH === '') return
  if (traceFd === undefined) {
    mkdirSync(dirname(resolve(TRACE_PATH)), { recursive: true })
    traceFd = openSync(TRACE_PATH, 'a', 0o600)
  }
  writeFileSync(traceFd, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`)
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Quote one argument for the `sh -c` command string system `script(1)` runs. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function failpoint(name) {
  if (FAILPOINT === name) throw new Error(`qualification failpoint: ${name}`)
}

/** A status response belongs to exactly one qualification request. */
export function statusMatches(record, requestId) {
  return record.m4a0 === 'status' && record.requestId === requestId
}

function readStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  } catch {
    return undefined
  }
}

function readProcState(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0]
  } catch {
    return undefined
  }
}

/** Leave one real killed child unreaped by its shell parent; return its PID. */
async function makeZombie() {
  const holder = spawn('sh', ['-c', 'sleep 60 & echo $!; exec sleep 60'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  holder.unref()
  const pid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the zombie holder did not print a child pid')), 5_000)
    holder.stdout.once('data', chunk => {
      clearTimeout(timer)
      const value = Number(chunk.toString('utf8').split('\n')[0].trim())
      if (!Number.isInteger(value) || value <= 0) reject(new Error(`bad zombie child pid: ${String(value)}`))
      else resolve(value)
    })
  })
  const starttime = readStartIdentity(pid)
  assert(starttime !== undefined, 'the zombie child has no starttime')
  const holderStarttime = readStartIdentity(holder.pid)
  if (holderStarttime !== undefined) trackedProcesses.set(holder.pid, holderStarttime)
  process.kill(pid, 'SIGKILL')
  let state
  for (let attempt = 0; attempt < 250; attempt += 1) {
    state = readProcState(pid)
    if (state === 'Z') break
    await sleep(20)
  }
  assert(state === 'Z', 'the killed child did not become a real OS zombie')
  return { pid, starttime }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One OS entry process with parsed JSON records. Exported for the tooling liveness guard. */
export class EntryProcess {
  constructor(role, entry, options) {
    this.role = role
    this.records = []
    this.stderr = ''
    this.exited = false
    this.exitResult = undefined
    const effectiveScratch = options.env?.SPLIT_PROCESS_SCRATCH ?? join(options.scratch, `${role}-${++sequence}`)
    this.effectiveScratch = effectiveScratch
    this.child = spawn(process.execPath, [entry], {
      cwd: options.cwd,
      env: {
        ...options.env,
        SPLIT_PROCESS_DSH_ANCHOR: options.anchor,
        SPLIT_PROCESS_PROFILE: options.profile,
        SPLIT_PROCESS_SCRATCH: effectiveScratch,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    activeProcesses.add(this)
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    let buffer = ''
    this.child.stdout.on('data', chunk => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        this.records.push(JSON.parse(line))
      }
    })
    this.child.stderr.on('data', chunk => { this.stderr += chunk })
    this.exit = new Promise(resolveExit => {
      // `close` fires after the child's stdio streams close; `exit` may fire
      // first and would let a caller read a truncated record tail.
      this.child.on('close', (code, signal) => {
        this.exited = true
        this.exitResult = { code, signal }
        activeProcesses.delete(this)
        resolveExit(this.exitResult)
      })
    })
  }

  waitFor(predicate, label, timeoutMs = 120_000) {
    const existing = this.records.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolveWait, reject) => {
      const started = Date.now()
      const settle = (record) => {
        clearInterval(interval)
        clearTimeout(timer)
        resolveWait(record)
      }
      const fail = (category, code) => {
        clearInterval(interval)
        clearTimeout(timer)
        // Only the fixed label, the elapsed time and this process's bounded
        // summary travel in the error: never captured stderr or record bytes.
        reject(new SplitSmokeWaitError(category, {
          code,
          waitLabel: label,
          processRole: this.role,
          elapsedMs: Date.now() - started,
          process: this,
        }))
      }
      const poll = () => {
        const record = this.records.find(predicate)
        if (record !== undefined) {
          settle(record)
          return
        }
        if (this.exited) fail('PROCESS_EXITED', 'PROCESS_EXITED_BEFORE_RECORD')
      }
      const interval = setInterval(poll, 20)
      const timer = setTimeout(() => fail('WAIT_TIMEOUT', 'RECORD_WAIT_TIMEOUT'), timeoutMs)
      poll()
    })
  }

  waitForExit(timeoutMs = 120_000) {
    let timer
    const started = Date.now()
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new SplitSmokeWaitError('WAIT_TIMEOUT', {
          code: 'PROCESS_EXIT_TIMEOUT',
          waitLabel: 'process exit',
          processRole: this.role,
          elapsedMs: Date.now() - started,
          process: this,
        }))
      }, timeoutMs)
    })
    // A pending deadline is a live handle: without clearing it the whole smoke
    // stays alive until the longest timeout expires even though every child exited.
    return Promise.race([this.exit, deadline]).finally(() => clearTimeout(timer))
  }

  send(request) {
    this.child.stdin.write(`${JSON.stringify(request)}\n`)
  }

  async shutdown() {
    this.send({ op: 'shutdown' })
    return await this.waitForExit()
  }

  kill(signal) {
    try {
      process.kill(-this.child.pid, signal)
    } catch {
      try { this.child.kill(signal) } catch { /* already gone */ }
    }
  }
}

/**
 * One REAL PiTui surface Client driven through the system `script(1)` pseudo-TTY.
 *
 * Structured telemetry reads the private `0600` JSONL file the entry owns (never
 * the terminal); the terminal bytes stay on the pty and are parsed with the
 * repository's headless xterm parser, so "the frame shows …" is an escape-aware
 * fact rather than a substring of raw ANSI. The process tree is `script ->
 * node dist/local-client.mjs`; the business PID is the one in the `ready`
 * record, and signals for the surface Client are sent to THAT pid.
 */
export class SurfaceEntryProcess {
  constructor(entry, options) {
    this.role = 'surface-client'
    this.records = []
    this.raw = ''
    this.stderr = ''
    this.exited = false
    this.exitResult = undefined
    this.recordError = undefined
    this.recordPath = join(options.workDir, `surface-client-${String(++sequence)}.jsonl`)
    this.term = new xterm.Terminal({
      cols: options.columns ?? 100,
      rows: options.rows ?? 30,
      disableStdin: true,
      allowProposedApi: true,
    })
    this.child = spawn('script', [
      '-qefc',
      `${shellQuote(process.execPath)} ${shellQuote(entry)}`,
      '/dev/null',
    ], {
      cwd: options.cwd,
      env: {
        ...options.env,
        SPLIT_PROCESS_DSH_ANCHOR: options.anchor,
        SPLIT_PROCESS_PROFILE: options.profile,
        SPLIT_PROCESS_SCRATCH: options.effectiveScratch ?? join(options.scratch, `surface-${String(sequence)}`),
        SPLIT_PROCESS_CLIENT_MODE: 'surface',
        SPLIT_PROCESS_CLIENT_RECORD_FILE: this.recordPath,
        COLUMNS: String(options.columns ?? 100),
        LINES: String(options.rows ?? 30),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    activeProcesses.add(this)
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this.raw += chunk
      this.term.write(chunk)
    })
    this.child.stderr.on('data', chunk => { this.stderr += chunk })
    this.exit = new Promise(resolveExit => {
      this.child.on('close', (code, signal) => {
        this.exited = true
        this.exitResult = { code, signal }
        activeProcesses.delete(this)
        clearInterval(this.recordTimer)
        resolveExit(this.exitResult)
      })
    })
    this.recordTimer = setInterval(() => {
      try {
        this.readRecords()
      } catch (error) {
        this.recordError = error
      }
    }, 25)
  }

  /**
   * Parse only COMPLETE lines: the entry appends while this polls.
   *
   * A malformed line stays a real failure with its own text here — this private
   * `recordPath` JSONL is the record authority, and the bounded default report
   * never copies it.
   */
  readRecords() {
    if (!existsSync(this.recordPath)) return
    const text = readFileSync(this.recordPath, 'utf8')
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    const lines = text.slice(0, end).split('\n').filter(line => line !== '')
    this.records = lines.map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${this.role}: malformed record line ${String(index)}: ${line.slice(0, 200)} (${String(error)})`)
      }
    })
  }

  waitFor(predicate, label, timeoutMs = 120_000) {
    const existing = this.records.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolveWait, reject) => {
      const started = Date.now()
      let settled = false
      const cleanup = () => {
        clearInterval(interval)
        clearTimeout(timer)
      }
      const finish = (error, record) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined && error !== null) reject(error)
        else resolveWait(record)
      }
      // A bounded wait failure: the fixed label, the elapsed time and this
      // process's projection — never `raw`, `stderr` or the record bytes.
      const fail = (category, code) => finish(new SplitSmokeWaitError(category, {
        code,
        waitLabel: label,
        processRole: this.role,
        elapsedMs: Date.now() - started,
        process: this,
      }))
      // Before a timeout or an early exit is reported, take ONE synchronous
      // read of the complete JSONL tail: the 25ms poller and the failure
      // snapshot must never disagree about the last records.
      const settleOrFail = (category, code) => {
        const unread = this.finalRecordRead(label)
        if (unread !== undefined) {
          finish(unread)
          return
        }
        const record = this.records.find(predicate)
        if (record !== undefined) finish(undefined, record)
        else fail(category, code)
      }
      const poll = () => {
        if (this.recordError !== undefined) fail('INFRA_FAILURE', 'RECORD_READ_FAILED')
        else if (this.exited) settleOrFail('PROCESS_EXITED', 'PROCESS_EXITED_BEFORE_RECORD')
        else {
          const record = this.records.find(predicate)
          if (record !== undefined) finish(undefined, record)
        }
      }
      const interval = setInterval(poll, 20)
      const timer = setTimeout(() => settleOrFail('WAIT_TIMEOUT', 'RECORD_WAIT_TIMEOUT'), timeoutMs)
      poll()
    })
  }

  /** Flush the headless terminal and return its visible viewport. */
  async viewport() {
    await new Promise(resolveFlush => this.term.write('', resolveFlush))
    const lines = []
    const buffer = this.term.buffer.active
    for (let index = 0; index < this.term.rows; index += 1) {
      const line = buffer.getLine(buffer.viewportY + index)
      lines.push(line === undefined ? '' : line.translateToString(true))
    }
    return lines
  }

  /**
   * One final synchronous JSONL read before a wait gives up, so the poller and
   * the failure snapshot cannot disagree about the record tail. A malformed line
   * stays a real failure; its bytes never enter the reported context.
   */
  finalRecordRead(label) {
    try {
      this.readRecords()
    } catch {
      return new SplitSmokeWaitError('INFRA_FAILURE', {
        code: 'RECORD_READ_FAILED',
        waitLabel: label,
        processRole: this.role,
        process: this,
      })
    }
    return undefined
  }

  /** Wait until the PAINTED frame contains the text (escape-aware). */
  async waitForScreen(needle, label, timeoutMs = 60_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const viewport = await this.viewport()
      if (viewport.join('\n').includes(needle)) return
      if (this.exited) {
        const unread = this.finalRecordRead(label)
        throw unread ?? new SplitSmokeWaitError('PROCESS_EXITED', {
          code: 'PROCESS_EXITED_BEFORE_FRAME',
          waitLabel: label,
          processRole: this.role,
          elapsedMs: Date.now() - started,
          process: this,
        })
      }
      await sleep(50)
    }
    const unread = this.finalRecordRead(label)
    throw unread ?? new SplitSmokeWaitError('WAIT_TIMEOUT', {
      code: 'FRAME_WAIT_TIMEOUT',
      waitLabel: label,
      processRole: this.role,
      elapsedMs: Date.now() - started,
      process: this,
    })
  }

  /**
   * The COMPOSER box text of one viewport.
   *
   * The input box is drawn between its top and bottom rule; the SECOND-TO-LAST
   * rule is used as the box top so the footer rule below it is not mistaken for
   * the box. Returns `undefined` when the frame has no box.
   */
  composerOf(viewport) {
    const separators = []
    for (let index = 0; index < viewport.length; index += 1) {
      if (/^─+$/u.test(viewport[index].trim())) separators.push(index)
    }
    if (separators.length === 0) return undefined
    const top = separators.length >= 2 ? separators[separators.length - 2] : separators[separators.length - 1]
    const bottom = separators.length >= 2 ? separators[separators.length - 1] : viewport.length
    return viewport.slice(top + 1, bottom).join('\n')
  }

  /** Wait until the COMPOSER line (after the last separator) holds the text. */
  async waitForComposerDraft(text, timeoutMs = 30_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const composer = this.composerOf(await this.viewport())
      if (composer !== undefined && composer.includes('❯') && composer.includes(text)) return
      if (this.exited) {
        const unread = this.finalRecordRead('composer draft')
        throw unread ?? new SplitSmokeWaitError('PROCESS_EXITED', {
          code: 'PROCESS_EXITED_BEFORE_COMPOSER',
          waitLabel: 'composer draft',
          processRole: this.role,
          elapsedMs: Date.now() - started,
          process: this,
        })
      }
      await sleep(50)
    }
    const unread = this.finalRecordRead('composer draft')
    throw unread ?? new SplitSmokeWaitError('WAIT_TIMEOUT', {
      code: 'COMPOSER_WAIT_TIMEOUT',
      waitLabel: 'composer draft',
      processRole: this.role,
      elapsedMs: Date.now() - started,
      process: this,
    })
  }

  /** The current composer text, or `undefined` when no box is painted. */
  async composerText() {
    return this.composerOf(await this.viewport())
  }

  /**
   * Clear a restored draft through the REAL editor: one backspace per character,
   * then wait until the text is gone from the composer. Used where a case must
   * send a SECOND independent prompt on the same process.
   */
  async clearComposerDraft(text, timeoutMs = 30_000) {
    const started = Date.now()
    if (text !== '') this.send('\x7f'.repeat(text.length))
    while (Date.now() - started < timeoutMs) {
      const composer = await this.composerText()
      if (composer !== undefined && !composer.includes(text)) return
      await sleep(50)
    }
    const unread = this.finalRecordRead('composer cleared')
    throw unread ?? new SplitSmokeWaitError('WAIT_TIMEOUT', {
      code: 'COMPOSER_CLEAR_TIMEOUT',
      waitLabel: 'composer cleared',
      processRole: this.role,
      elapsedMs: Date.now() - started,
      process: this,
    })
  }

  /**
   * Wait until a previously painted row DISAPPEARS (escape-aware). Used to
   * observe the exit-confirmation window closing: the footer hint is the
   * product's own armed state, so the wait is bounded by that real cue instead
   * of a blind sleep.
   */
  async waitForScreenGone(needle, label, timeoutMs = 60_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const viewport = await this.viewport()
      if (!viewport.join('\n').includes(needle)) return
      if (this.exited) {
        // The process left while the row was still painted: that is the caller's
        // negative-control failure, not a timeout.
        const unread = this.finalRecordRead(label)
        throw unread ?? new SplitSmokeWaitError('PROCESS_EXITED', {
          code: 'PROCESS_EXITED_BEFORE_FRAME',
          waitLabel: label,
          processRole: this.role,
          elapsedMs: Date.now() - started,
          process: this,
        })
      }
      await sleep(50)
    }
    const unread = this.finalRecordRead(label)
    throw unread ?? new SplitSmokeWaitError('WAIT_TIMEOUT', {
      code: 'FRAME_WAIT_TIMEOUT',
      waitLabel: label,
      processRole: this.role,
      elapsedMs: Date.now() - started,
      process: this,
    })
  }

  /** Send terminal input to the Client through the pty master. */
  send(data) {
    this.child.stdin.write(data)
  }

  /** Signal the business Client process (never the `script` wrapper). */
  signalBusiness(signal) {
    const pid = this.records.find(record => record.m4a0 === 'ready')?.pid
      ?? this.records.find(record => record.m4a0 === 'client-started')?.pid
    assert(Number.isInteger(pid), `${this.role}: no business PID is known yet`)
    process.kill(pid, signal)
  }

  waitForExit(timeoutMs = 120_000) {
    let timer
    const started = Date.now()
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new SplitSmokeWaitError('WAIT_TIMEOUT', {
          code: 'PROCESS_EXIT_TIMEOUT',
          waitLabel: 'process exit',
          processRole: this.role,
          elapsedMs: Date.now() - started,
          process: this,
        }))
      }, timeoutMs)
    })
    return Promise.race([this.exit, deadline]).finally(() => clearTimeout(timer))
  }

  async dispose() {
    clearInterval(this.recordTimer)
    try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already gone */ }
    try { await this.waitForExit(15_000) } catch { /* best effort */ }
  }
}

/**
 * Decode a session log file: the Host appends one independently compressed
 * zstd frame per write, and Node's one-shot decoder reads only the first frame.
 * Splitting at the frame magic (a torn final frame is skipped) reconstructs the
 * whole durable log.
 */
function decodeZstdFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.compare(magic, 0, 4, index, index + 4) === 0) offsets.push(index)
  }
  if (offsets.length === 0 || offsets[0] !== 0) throw new Error('session log is not a zstd frame stream')
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const end = offsets[index + 1] ?? buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offsets[index], end)))
    } catch (error) {
      if (index === offsets.length - 1) break // a torn append tail
      throw new Error(`session log frame ${String(index)} is corrupt: ${String(error)}`)
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Locate one persisted Host Session log under the isolated DSH home. */
function findHostSessionLog(dshHome, sessionId) {
  const sessionsRoot = join(dshHome, 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  for (const dirent of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const sessionDir = join(sessionsRoot, dirent.name, sessionId)
    if (!existsSync(sessionDir)) continue
    for (const file of readdirSync(sessionDir)) {
      if (file.endsWith('.jsonl.zstd')) return join(sessionDir, file)
    }
  }
  return undefined
}

/** The durable Host Session events of one Session (undefined before any log). */
export function hostSessionEvents(dshHome, sessionId) {
  const path = findHostSessionLog(dshHome, sessionId)
  if (path === undefined) return undefined
  return decodeZstdFrames(readFileSync(path)).split('\n').filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined // a torn tail line while the Host appends
      }
    })
    .filter(event => event !== undefined)
}

/** The human-authored `user/message` texts of one persisted Host Session. */
function hostUserTexts(events) {
  return events
    .filter(event => event.type === 'user/message' && Array.isArray(event.data?.content))
    .map(event => event.data.content.map(part => typeof part?.text === 'string' ? part.text : '').join(''))
}

/** Whether the durable log carries one assistant message containing the text. */
function hostAssistantHasText(events, text) {
  return events.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes(text))
}

/** The test-only offline Host LLM route (official Loader row + patch override). */
export function writeSurfaceLlmFixture(profileDir, workDir) {
  const stubPath = join(profileDir, 'm4b2s-stub-llm.mjs')
  writeFileSync(stubPath, `import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const name = 'm4b2s-stub-llm'
export const inject = ['llm']
class StubLlmAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider: 'stub', id: model, name: model }) }
  listModels() { return Promise.resolve([{ provider: 'stub', id: 'stub', name: 'stub' }]) }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'stub answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'stub answer' } }
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['stub'], new StubLlmAdapter()) }
`, { mode: 0o600 })
  const patchPath = join(workDir, 'm4b2s-llm.patch.yml')
  writeFileSync(patchPath, [
    '- insert:',
    '    - id: m4b2s-stub-llm',
    `      name: '${pathToFileURL(stubPath).href}'`,
    '      inject: [llm]',
    '- id: agent-default-model',
    '  config:',
    '    provider: stub',
    '    model: stub',
    '',
  ].join('\n'), { mode: 0o600 })
  return { stubPath, patchPath }
}

/**
 * The isolated Host workload overlay. The fixture file is copied into
 * the installed profile so its official `@deepseek-ai/*` imports resolve from
 * that profile (never from the repository checkout), exactly like the stub
 * LLM row above. One row registers the scripted adapter; `agent-default-model`
 * routes the Agent to it.
 */
export function writeC1WorkFixture(profileDir, workDir) {
  const source = join(SCRIPT_DIR, 'fixtures', 'split-process-host-work.mjs')
  const fixturePath = join(profileDir, 'split-process-host-work.mjs')
  writeFileSync(fixturePath, readFileSync(source), { mode: 0o600 })
  chmodSync(fixturePath, 0o600)
  const rows = [
    '- insert:',
    '    - id: split-process-host-work',
    `      name: '${pathToFileURL(fixturePath).href}'`,
    '      inject: [llm, tools, jobs, subagents, agents, typertGateway, connection]',
    '- id: agent-default-model',
    '  config:',
    '    provider: c1-qualification',
    '    model: c1',
    '',
  ]
  const patchPath = join(workDir, 'm4-c1-work.patch.yml')
  writeFileSync(patchPath, rows.join('\n'), { mode: 0o600 })
  chmodSync(patchPath, 0o600)
  // T52: a profile-scoped override of the REAL `standard` preset. The
  // generated preset patch is the canonical plugin list; only the
  // `tool-ask-user` row switches to its official timed mode (1s foreground
  // window). The production preset itself is untouched.
  const standardPatch = parseYaml(readFileSync(join(SCRIPT_DIR, '..', 'generated', 'dsh-presets', 'standard.patch.yml'), 'utf8'))
  const presetRow = standardPatch.find(entry => Array.isArray(entry.insert))?.insert?.find(entry => entry.id === 'preset-standard')
  assert(presetRow !== undefined && presetRow.config !== undefined, 'T52 the generated standard preset row is missing')
  const plugins = structuredClone(presetRow.config.plugins)
  const askRow = plugins.find(entry => entry.id === 'tool-ask-user')
  assert(askRow !== undefined, 'T52 the standard preset has no tool-ask-user row')
  askRow.config = { mode: 'timed', timeout: 1 }
  const timedPatchPath = join(workDir, 'm4-c1-work-timed.patch.yml')
  const basePatches = parseYaml(readFileSync(patchPath, 'utf8'))
  writeFileSync(timedPatchPath, JSON.stringify([
    ...basePatches,
    { id: 'preset-standard', config: { ...presetRow.config, plugins } },
  ], null, 2), { mode: 0o600 })
  chmodSync(timedPatchPath, 0o600)
  return { fixturePath, patchPath, timedPatchPath }

}

/** Read every host-workload fixture proof line (an absent file is simply empty). */
function readC1WorkEvents(workRoot) {
  const path = join(workRoot, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** Wait for one fixture proof matching the predicate. */
export async function waitForC1WorkEvent(workRoot, predicate, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const event = readC1WorkEvents(workRoot).find(predicate)
    if (event !== undefined) return event
    await sleep(25)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'WORK_PROOF_WAIT_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
}

/** Wait for one durable Host Session event matching the predicate. */
export async function waitForHostSessionEvent(dshHome, sessionId, predicate, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const events = hostSessionEvents(dshHome, sessionId)
    const event = events?.find(predicate)
    if (event !== undefined) return event
    await sleep(50)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'SESSION_EVENT_WAIT_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
}

/** The last `surface-status` record of a surface Client (no stdin channel). */
function lastSurfaceStatus(client) {
  return client.records.filter(record => record.m4b2s === 'surface-status').at(-1)
}

/** Wait for a surface status matching the predicate. */
export async function waitForSurfaceStatus(client, predicate, label, timeoutMs = 120_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  /** Read the complete JSONL tail once, then re-check the status. */
  const settleOrFail = (category, code) => {
    const unread = client.finalRecordRead(label)
    if (unread !== undefined) throw unread
    const late = lastSurfaceStatus(client)
    if (late !== undefined && predicate(late)) return late
    throw new SplitSmokeWaitError(category, {
      code,
      waitLabel: label,
      processRole: client.role,
      elapsedMs: Date.now() - started,
      process: client,
    })
  }
  while (Date.now() < deadline) {
    const status = lastSurfaceStatus(client)
    if (status !== undefined && predicate(status)) return status
    // A Client that died while the status never arrived is not a timeout: that
    // is the failure itself, and it must not consume the whole budget. The
    // poller stops on close, so the LAST line may still be unread — read it
    // before deciding the status is missing.
    if (client.exited) return settleOrFail('PROCESS_EXITED', 'PROCESS_EXITED_BEFORE_STATUS')
    await sleep(25)
  }
  // Same read before a timeout: a status written just before the deadline must
  // not be reported as never having arrived.
  return settleOrFail('WAIT_TIMEOUT', 'SURFACE_STATUS_WAIT_TIMEOUT')
}

/** Wait for the first ready record among concurrent entries. */
export async function waitForAnyReady(processes, label, timeoutMs) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    for (const process of processes) {
      const record = process.records.find(candidate => candidate.m4a0 === 'ready')
      if (record !== undefined) return { process, record }
    }
    if (processes.every(process => process.exited)) {
      // The close callback removed every contender from `activeProcesses`, so a
      // report built later would show NO process at all for exactly the failure
      // that involves all of them. Carry them on the error for the projection.
      throw new SplitSmokeWaitError('PROCESS_EXITED', {
        code: 'READY_RACE_EXITED',
        waitLabel: label,
        elapsedMs: Date.now() - started,
        processes,
      })
    }
    await sleep(25)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'READY_RACE_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
}

async function waitForOutcome(process, label, timeoutMs = 120_000) {
  return await process.waitFor(record => record.m4a0 === 'ready' || record.m4a0 === 'failure', label, timeoutMs)
}

function expectFailureRecord(process, label, expectedCode) {
  const failure = process.records.find(record => record.m4a0 === 'failure')
  assert(failure !== undefined, `${label}: no failure record; records=${JSON.stringify(process.records.slice(-3))}`)
  assert(failure.code === expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(failure.code ?? failure.error)}`)
}

function entryPaths(profilePackage) {
  return {
    host: join(profilePackage, 'dist', 'local-host.mjs'),
    client: join(profilePackage, 'dist', 'local-client.mjs'),
  }
}

function chunk(profilePackage, prefix) {
  const file = readdirSync(join(profilePackage, 'dist')).find(name => name.startsWith(prefix) && name.endsWith('.mjs'))
  if (file === undefined) throw new Error(`missing ${prefix} chunk in installed package`)
  return join(profilePackage, 'dist', file)
}

/** The production build fingerprint of one installed payload. */
function productionBuildId(packageRoot, dshVersion) {
  const moduleUrl = pathToFileURL(join(SCRIPT_DIR, '..', 'src', 'app', 'remote-process', 'local-scope.ts')).href
  const code = `import { computeBuildId } from ${JSON.stringify(moduleUrl)}; process.stdout.write(computeBuildId(process.argv[1], process.argv[2]))`
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', code, packageRoot, dshVersion],
    { cwd: join(SCRIPT_DIR, '..'), env: process.env, encoding: 'utf8', timeout: 60_000 },
  )
  if (result.status !== 0) {
    throw new Error(`the production build fingerprint could not be computed for ${packageRoot}: ${result.stderr || String(result.error ?? '')}`)
  }
  const value = result.stdout.trim()
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`the production build fingerprint is not 64 hex characters: ${JSON.stringify(value)}`)
  }
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function modeOf(path) {
  return statSync(path).mode & 0o777
}

function writeRawPrivate(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function saveFile(path) {
  return { bytes: readFileSync(path), mode: modeOf(path) }
}

function restoreFile(path, saved) {
  try { unlinkSync(path) } catch { /* missing is fine */ }
  writeFileSync(path, saved.bytes, { mode: saved.mode })
  chmodSync(path, saved.mode)
}

/** One raw HTTP GET that keeps a forged Host/Origin header exactly as given. */
function rawGet(origin, path, headers = {}) {
  const url = new URL(path, origin)
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { connection: 'close', ...headers },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body,
      }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('raw HTTP timeout')))
    request.on('error', reject)
    request.end()
  })
}

async function fetchStatus(url, init = {}) {
  const response = await fetch(url, { redirect: 'manual', ...init })
  const body = await response.text()
  const setCookie = response.headers.getSetCookie?.() ?? []
  return {
    status: response.status,
    headers: response.headers,
    body,
    setCookie,
  }
}

/** Exchange the private launch URL for one qualification Cookie (never logged). */
async function connectCookie(origin, launch) {
  const url = new URL(launch.connectUrl)
  url.searchParams.set('interactions', 'answer')
  const response = await fetch(url, { redirect: 'manual', cache: 'no-store' })
  assert(response.status === 302, `valid /connect returned HTTP ${String(response.status)}`)
  assert(/\bno-store\b/iu.test(response.headers.get('cache-control') ?? ''), '/connect response is not no-store')
  const redirect = new URL(response.headers.get('location') ?? '/', url)
  assert(redirect.origin === origin && redirect.pathname === '/api/remote.mux', '/connect redirected outside the local mux')
  const setCookie = response.headers.getSetCookie?.() ?? []
  assert(setCookie.length > 0, '/connect returned no signed cookie')
  await response.body?.cancel()
  return setCookie[0].split(';', 1)[0].trim()
}

/** Open or refuse one raw mux WebSocket with the Cookie header. */
function muxAttempt(url, cookie, WebSocket) {
  return new Promise((resolveAttempt, reject) => {
    const socket = new WebSocket(url, { headers: { Cookie: cookie } })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveAttempt({ socket, ...value })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.terminate() } catch { /* already closed */ }
      reject(new Error('mux attempt timed out'))
    }, 10_000)
    socket.once('open', () => finish({ opened: true }))
    socket.once('unexpected-response', (request, response) => {
      request.destroy()
      try { socket.terminate() } catch { /* already closed */ }
      finish({ opened: false, status: response.statusCode })
    })
    socket.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

function closeMux(socket, WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise(resolveClose => {
    socket.once('close', () => resolveClose())
    try { socket.close(1000) } catch { resolveClose() }
  })
}

/** Bounded wait for a kernel abstract-socket name to become bindable. */
async function seatFree(name, timeoutMs = 5_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const free = await new Promise(resolveFree => {
      const server = createNetServer()
      server.once('error', () => resolveFree(false))
      server.listen(name, () => {
        server.close(() => resolveFree(true))
      })
    })
    if (free) return
    await sleep(50)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'SEAT_RELEASE_TIMEOUT',
    waitLabel: 'abstract seat release',
    elapsedMs: Date.now() - started,
  })
}

/** Read a live process starttime and kill only the process that still matches it. */
function killTracked(pid, starttime, signal) {
  if (starttime !== undefined && readStartIdentity(pid) !== starttime) return
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

/**
 * Failure backstop for detached processes the smoke did not learn about: only
 * PIDs whose environment carries THIS isolated DSH home and whose command line
 * is one of the two internal entries are killed.
 */
function findIsolatedProcesses(dshHome) {
  const marker = `DSH_HOME=${dshHome}`
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  const pids = []
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue
    const pid = Number(name)
    let cmdline
    let environ
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8')
    } catch {
      continue
    }
    if (!cmdline.includes('local-host.mjs') && !cmdline.includes('local-client.mjs')) continue
    if (!environ.split('\0').includes(marker)) continue
    pids.push(pid)
  }
  return pids
}

function killIsolatedProcesses(dshHome) {
  for (const pid of findIsolatedProcesses(dshHome)) {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
}

async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  return !alive(pid)
}

/** Whether one Linux abstract-socket seat can be claimed again. */
async function seatIsFree(name) {
  return await new Promise((resolveSeat, rejectSeat) => {
    const server = createNetServer()
    let settled = false
    server.once('error', error => {
      if (settled) return
      settled = true
      if (error.code === 'EADDRINUSE') resolveSeat(false)
      else rejectSeat(error)
    })
    server.listen(name, () => {
      if (settled) return
      settled = true
      server.close(() => resolveSeat(true))
    })
  })
}

function assertNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    assert(!text.includes(secret), `${label} leaked an authenticated-link secret`)
  }
}

function assertIdentityFields(actual, expected, label) {
  for (const key of [
    'schema',
    'scopeId',
    'profileRealpath',
    'instanceId',
    'hostPid',
    'hostStarttime',
    'origin',
    'protocol',
    'bundleVersion',
    'dshVersion',
    'buildId',
  ]) {
    assert(actual?.[key] === expected?.[key], `${label}: ${key} mismatch`)
  }
}

function assertClientHostFacts(client, host, label) {
  for (const key of [
    'scopeId',
    'instanceId',
    'hostPid',
    'hostStarttime',
    'origin',
    'protocol',
    'bundleVersion',
    'dshVersion',
    'buildId',
  ]) {
    assert(client?.[key] === host?.[key], `${label}: Client host ${key} mismatch`)
  }
}

function hostStatus(host) {
  const requestId = `status-${++statusSequence}`
  host.send({ op: 'status', requestId })
  return host.waitFor(record => statusMatches(record, requestId), `host status ${requestId}`, 30_000)
}

function clientStatus(client) {
  const requestId = `status-${++statusSequence}`
  client.send({ op: 'status', requestId })
  return client.waitFor(record => statusMatches(record, requestId), `client status ${requestId}`, 30_000)
}

async function main() {
  // The input phase has its own failure boundary: nothing exists yet, so the
  // lane may only emit the fixed safe projection (identity when the manifest
  // was readable, processes when none exist).
  let tarball
  let targetDshVersion
  /** The exact candidate artifact this run qualifies; re-read at the end. */
  let candidateSha256
  try {
    tarball = resolveTarball(candidateArgument(process.argv.slice(2)))
    const candidateManifest = validateCandidateTarball(tarball)
    candidateSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    targetDshVersion = npmDshVersion()
    diagnostics = createSmokeDiagnostics({
      lane: 'split-process',
      heading: 'SPLIT_PROCESS_SMOKE',
      marker: 'T',
      runtimeDshPin: targetDshVersion,
      artifacts: [smokeArtifactIdentity('candidate', candidateManifest, candidateSha256)],
    })
    // Input qualification BEFORE any install: the candidate must declare this
    // checkout's exact DSH runtime pin, the same rule the production Client
    // reexec preflight applies to a replacement target.
    requireExactSmokeDshPin('candidate', candidateManifest, targetDshVersion)
  } catch (error) {
    if (diagnostics === undefined) emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error })
    else diagnostics.reportFailure(error)
    throw error
  }
  // The startup identity is announced only AFTER preflight qualified it.
  process.stderr.write(`${diagnostics.identityLine()}\n`)
  diagnostics.checkpoint('preflight/candidate-input')
  // The setup itself is inside the same failure boundary: a `mkdtemp`, `mkdir`
  // or `writeFileSync` failure must still leave the safe report AND still remove
  // whatever root was already created, instead of escaping past the cleanup.
  let distribution
  let workDir
  let home
  let dshHome
  let harnessDir
  let scratch
  let env
  let isolatedScopeId
  try {
    distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
    workDir = mkdtempSync(join(tmpdir(), 'dsh-split-process-'))
    home = join(workDir, 'home')
    dshHome = join(workDir, 'dsh-home')
    harnessDir = join(workDir, 'harness')
    scratch = join(workDir, 'scratch')
    for (const directory of [home, dshHome, harnessDir, scratch]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
    env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'evidence.json'))
    // The qualification work dir must be a real OS temp root outside this
    // checkout: an ancestor `node_modules` would otherwise lend the Client
    // peer set that the isolated installation must supply itself (issue #476).
    const workDirFromCheckout = relative(realpathSync(PACKAGE_ROOT), realpathSync(workDir))
    assert(workDirFromCheckout === '..' || workDirFromCheckout.startsWith(`..${sep}`),
      `the split-process work dir must be outside the checkout: ${workDir}`)
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-split-process-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': targetDshVersion,
      },
    }, null, 2) + '\n', 'utf8')
    runPnpmInstall(harnessDir, env, distribution)
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    assert(version.status === 0, `installed DSH --version failed: ${version.stderr}`)
    assert(version.stdout.trim() === targetDshVersion, `installed DSH version ${version.stdout.trim()} != ${targetDshVersion}`)
    // The Client's static platform peer set belongs to the profile that will
    // run it, exactly like a production profile dependency; the harness only
    // anchors the DSH CLI installation (issue #476). The published store
    // declares its zustand/immer engine imports only as devDependencies, so
    // the profile must own those two as well; the pins are the exact versions
    // DSH 0.2.1-rc.4 resolved for the store.
    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    const clientPeers = [
      ['@deepseek-ai/dsh-client-store', targetDshVersion],
      ['zustand', '4.5.7'],
      ['immer', '10.2.0'],
    ]
    installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
    installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
    installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
    installPlugin(dsh, tarball, harnessDir, env, false)
    const profileManifest = readJson(join(profileDir, 'package.json'))
    for (const [name, version] of clientPeers) {
      assert(profileManifest.dependencies?.[name] === version,
        `the active profile does not declare the exact Client peer ${name}@${version}`)
      assert(!(profileManifest.dsh?.profile?.bundles ?? []).includes(name),
        `the plain Client peer ${name} must not become a profile bundle`)
      const peerDir = realpathSync(join(profileDir, 'node_modules', name))
      assert(readJson(join(peerDir, 'package.json')).version === version,
        `the active profile installed a different ${name} version`)
      const resolvedPeer = realpathSync(createRequire(join(profileDir, 'package.json')).resolve(name))
      const peerRelative = relative(peerDir, resolvedPeer)
      assert(peerRelative !== '' && peerRelative !== '..' && !peerRelative.startsWith(`..${sep}`),
        `the active profile ${name} resolves outside its own package: ${resolvedPeer}`)
    }
    assert((profileManifest.dsh?.profile?.bundles ?? []).includes('@xmoon76/dsh-pi-tui'),
      'the candidate bundle row disappeared from the active profile')
    trace('client-peer-install', {
      owner: 'active pi-tui profile',
      peers: clientPeers.map(([name, version]) => `${name}@${version}`),
      harnessOwnsClientPeer: false,
    })
    const profilePackage = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    assert(existsSync(join(profilePackage, 'dist', 'local-host.mjs')), 'candidate host entry missing from profile install')
    assert(existsSync(join(profilePackage, 'dist', 'local-client.mjs')), 'candidate client entry missing from profile install')
    const entries = entryPaths(profilePackage)
    const manifest = readJson(join(profilePackage, 'package.json'))
    assert(manifest.bin === undefined, 'the candidate must not add a package bin')
    assert(!Object.keys(manifest.exports ?? {}).some(name => /local-(host|client)/u.test(name)), 'the internal entries must stay unexported')
    assert(manifest.dependencies?.ws === '8.21.3', 'the installed package must declare ws@8.21.3')
    const anchor = realpathSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    const mutationMode = process.env.SPLIT_PROCESS_SMOKE_MUTATION
    const tuiMutationPatch = join(workDir, 'mutation-tui-enabled.patch.yml')
    const connectionMutationPatch = join(workDir, 'mutation-connection-disabled.patch.yml')
    const sessionControllerMutationPatch = join(workDir, 't26-session-controller-disabled.patch.yml')
    const mutationEnv = mutationMode === 'tui-enabled'
      ? { SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch }
      : mutationMode === 'connection-disabled'
        ? { SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch }
        : {}
    // The test-only offline Host LLM row is part of the isolated profile for
    // this whole run: the link lanes never prompt, and the surface lanes need a
    // real Host-side model route to prove a committed prompt round trip. The
    // running-mutation env wins when present (those cases replace the overlay).
    const surfaceLlm = writeSurfaceLlmFixture(profileDir, workDir)
    const base = {
      cwd: profileDir,
      env: { ...env, SPLIT_PROCESS_EXTRA_PATCH: surfaceLlm.patchPath, ...mutationEnv },
      anchor,
      profile: 'pi-tui',
      scratch,
    }
    const hostFoundationBarrier = join(workDir, 'host-foundation-watch-barrier')
    const probeClientBase = {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FOUNDATION_BARRIER: hostFoundationBarrier },
    }
    const requireFromProfile = createRequire(join(profilePackage, 'package.json'))
    const WebSocket = requireFromProfile('ws')

    // T18 negative control: the role string alone is not Host-entry admission.
    // A regular CLI that merely inherits DSH_PI_TUI_ROLE=host must still fail
    // loudly when its profile cannot mount the requested TUI surface. The
    // profile patch is temporary and is restored BEFORE the Host-only positive
    // test, so the overlay is the only tui-app-disable source there.
    const profilePatchPath = join(profileDir, 'cordis.patch.yml')
    const previousProfilePatch = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : undefined
    try {
      writeFileSync(profilePatchPath, '- id: tui-app\n  disabled: true\n')
      const roleOnlyEnv = { ...env, DSH_PI_TUI_ROLE: 'host' }
      delete roleOnlyEnv.DSH_PI_TUI_HOST_ENTRY
      const roleOnly = runDsh(dsh, ['--profile', 'pi-tui'], profileDir, roleOnlyEnv, 120_000)
      const roleOnlyOutput = `${roleOnly.stdout ?? ''}\n${roleOnly.stderr ?? ''}`
      assert(roleOnly.status !== 0, 'an inherited DSH_PI_TUI_ROLE=host must not turn a missing TUI into success')
      assert(roleOnlyOutput.includes('required TUI surface did not mount'), 'inherited role hid the missing-surface verdict')
    } finally {
      if (previousProfilePatch === undefined) rmSync(profilePatchPath, { force: true })
      else writeFileSync(profilePatchPath, previousProfilePatch)
    }
    const help = runDsh(dsh, ['--profile', 'pi-tui', '--help'], profileDir, env, 120_000)
    assert(help.status === 0, `Direct --help failed: ${help.stderr}`)

    // The running-state mutations below use real Host processes, not a unit fake.
    // (1) Re-enabling the Host-only TUI row after the overlay must make the
    // Host startup red; no ready record is allowed.
    writeFileSync(tuiMutationPatch, '- id: tui-app\n  disabled: false\n')
    const tuiMutation = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch },
    })
    const tuiMutationFailure = await tuiMutation.waitFor(record => record.m4a0 === 'failure', 'T01 mutation: TUI row re-enabled', 120_000)
    assert(/forbidden TUI\/Client-UI rows are not disabled: tui-app|TUI/u.test(String(tuiMutationFailure.error)), `T01 mutation: unexpected TUI failure ${String(tuiMutationFailure.error)}`)
    const tuiMutationExit = await tuiMutation.waitForExit(60_000)
    assert(tuiMutationExit.code === 1, `T01 mutation: TUI row re-enabled exit ${JSON.stringify(tuiMutationExit)}`)
    assert(!tuiMutation.records.some(record => record.m4a0 === 'ready'), 'T01 mutation: TUI row re-enabled emitted ready')
    trace('mutation-tui-enabled', { exit: tuiMutationExit.code, readyEmitted: false, error: String(tuiMutationFailure.error).slice(0, 160) })

    // (2) Disabling the Host-only Connection owner row after the overlay must
    // make the Host audit/startup red; T01/T02 could never turn green.
    writeFileSync(connectionMutationPatch, '- id: split-host-connection\n  disabled: true\n')
    const connectionMutation = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch },
    })
    const connectionMutationFailure = await connectionMutation.waitFor(record => record.m4a0 === 'failure', 'T01 mutation: Connection row disabled', 120_000)
    assert(/connection owner row, found 0/u.test(String(connectionMutationFailure.error)), `T01 mutation: unexpected Connection failure ${String(connectionMutationFailure.error)}`)
    const connectionMutationExit = await connectionMutation.waitForExit(60_000)
    assert(connectionMutationExit.code === 1, `T01 mutation: Connection row disabled exit ${JSON.stringify(connectionMutationExit)}`)
    assert(!connectionMutation.records.some(record => record.m4a0 === 'ready'), 'T01 mutation: Connection row disabled emitted ready')
    trace('mutation-connection-disabled', { exit: connectionMutationExit.code, readyEmitted: false, error: String(connectionMutationFailure.error).slice(0, 160) })

    // T26a: the built-in Host Runtime ROW disabled after the overlay must fail
    // the strict readiness audit with no Ready and no Host identity. This is the
    // ROW-absence control: the module artifact itself is still installed and
    // reachable, so it is NOT the artifact-absence claim (issue #474).
    const runRoot = join(dshHome, 'run', 'dsh-pi-tui')
    const hasPublishedIdentity = () => existsSync(runRoot)
      && readdirSync(runRoot, { recursive: true }).some(name => String(name).endsWith('instance.json'))
    const hostRuntimeMutationPatch = join(workDir, 't26-host-runtime-disabled.patch.yml')
    writeFileSync(hostRuntimeMutationPatch, '- id: split-host-pi-tui-runtime\n  disabled: true\n')
    let runtimeRowDisabledFailure
    let runtimeRowDisabledExit
    try {
      const rowDisabled = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: hostRuntimeMutationPatch },
      })
      runtimeRowDisabledFailure = await rowDisabled.waitFor(record => record.m4a0 === 'failure', 'T26 Host Runtime row disabled', 120_000)
      runtimeRowDisabledExit = await rowDisabled.waitForExit(60_000)
      assert(runtimeRowDisabledExit.code === 1, `T26 Host Runtime row disabled exit was ${JSON.stringify(runtimeRowDisabledExit)}`)
      assert(!rowDisabled.records.some(record => record.m4a0 === 'ready'), 'T26 Host Runtime row disabled emitted ready')
      assert(/expected exactly one active piTuiHostRuntime owner row, found 0/u.test(String(runtimeRowDisabledFailure.error)),
        `T26 Host Runtime row disabled: unexpected error ${String(runtimeRowDisabledFailure.error)}`)
      assert(!hasPublishedIdentity(), 'T26 Host Runtime row disabled published a Host identity')
    } finally {
      rmSync(hostRuntimeMutationPatch, { force: true })
    }
    trace('t26-runtime-row-disabled', {
      exit: runtimeRowDisabledExit?.code,
      readyEmitted: false,
      error: String(runtimeRowDisabledFailure?.error ?? '').slice(0, 160),
    })

    // T26a-artifact-absent: the REAL module-absence negative (issue #474). The
    // Loader row stays inserted and enabled; only the installed module file is
    // gone. This is NOT the row-disabled control above.
    //
    // The historical "renamed artifact still Ready" observation (PR #473) was
    // NOT a pnpm hardlink/store mirror and NOT a second installed copy. DSH's
    // HMR invalidates the profile's package.json at startup; its package-scope
    // hook then skips the profile directory (trailing-slash `dirname`), so
    // Node's package SELF-REFERENCE climbed to an enclosing `package.json`
    // (`name: @xmoon76/dsh-pi-tui`, `exports`) and resolved a second build of
    // the artifact. DSH app-boot's startup-audit retry (`importFailure` ->
    // `entry.parent.tree.import`) is what then made the row active. The Host
    // code itself fails closed once the artifact is genuinely unreachable, so
    // this control removes every remaining escape explicitly:
    // - no ancestor may provide another INSTALLED package copy;
    // - a non-matching `<DSH_HOME>/package.json` barrier shadows every enclosing
    //   package scope above it for THIS negative only (removed in `finally`);
    // - after the rename the profile-anchored resolver must really fail.
    // The smoke work dir is outside the checkout; the barrier still shadows
    // every enclosing package scope above the isolated DSH home, so the
    // package-scope self-reference escape cannot reappear through another
    // layout.
    const hostRuntimeArtifact = join(profilePackage, 'dist', 'host-runtime.mjs')
    const hostRuntimeAbsentPath = `${hostRuntimeArtifact}.artifact-absent`
    const packageScopeBarrier = join(dshHome, 'package.json')
    const barrierBody = '{"name":"dsh-split-process-t26-artifact-barrier","private":true}\n'
    const profilesManifest = join(dirname(profileDir), 'package.json')
    assert(!existsSync(profilesManifest)
      || readJson(profilesManifest).name !== '@xmoon76/dsh-pi-tui',
      `T26a artifact-absent: an enclosing profiles package manifest carries the candidate package name: ${profilesManifest}`)
    const profileRequire = createRequire(join(profileDir, 'package.json'))
    assert(profileRequire.resolve('@xmoon76/dsh-pi-tui/host-runtime') === realpathSync(hostRuntimeArtifact),
      'T26a artifact-absent: the profile copy must be the normal resolvable Host Runtime artifact')
    const reachableAncestorCopies = []
    for (let directory = dirname(profileDir); ; directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules', '@xmoon76', 'dsh-pi-tui')
      if (existsSync(candidate)) reachableAncestorCopies.push(candidate)
      if (dirname(directory) === directory) break
    }
    const harnessCopy = join(harnessDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    if (existsSync(harnessCopy)) reachableAncestorCopies.push(harnessCopy)
    assert(reachableAncestorCopies.length === 0,
      `T26a artifact-absent: the isolated profile still has another installed package copy: ${reachableAncestorCopies.join(', ')}`)
    let artifactAbsentFailure
    let artifactAbsentExit
    let artifactAbsentStderr = ''
    const previousBarrier = existsSync(packageScopeBarrier) ? saveFile(packageScopeBarrier) : undefined
    try {
      writeFileSync(packageScopeBarrier, barrierBody)
      renameSync(hostRuntimeArtifact, hostRuntimeAbsentPath)
      // Auxiliary normal-resolution check (the profile-anchored CJS resolver).
      // It cannot exercise the ESM package-scope retry by itself; the barrier
      // plus the Host's own fail-closed verdict below are the real proof.
      let resolutionError
      try {
        profileRequire.resolve('@xmoon76/dsh-pi-tui/host-runtime')
      } catch (error) {
        resolutionError = error
      }
      assert(resolutionError !== undefined
        && /ERR_MODULE_NOT_FOUND|Cannot find module/u.test(`${resolutionError?.code ?? ''} ${resolutionError?.message ?? resolutionError}`),
        'T26a artifact-absent: the renamed artifact must be genuinely unresolvable from the profile anchor')
      const artifactAbsent = new EntryProcess('host', entries.host, base)
      artifactAbsentFailure = await artifactAbsent.waitFor(record => record.m4a0 === 'failure', 'T26 Host Runtime artifact absent', 120_000)
      artifactAbsentExit = await artifactAbsent.waitForExit(60_000)
      artifactAbsentStderr = artifactAbsent.stderr
      assert(artifactAbsentExit.code === 1, `T26 Host Runtime artifact absent exit was ${JSON.stringify(artifactAbsentExit)}`)
      assert(!artifactAbsent.records.some(record => record.m4a0 === 'ready'), 'T26 Host Runtime artifact absent emitted ready')
      assert(!artifactAbsent.records.some(record => record.services?.piTuiHostReady === true),
        'T26 Host Runtime artifact absent published piTuiHostReady')
      assert(/expected exactly one active piTuiHostRuntime owner row, found 0/u.test(String(artifactAbsentFailure.error)),
        `T26 Host Runtime artifact absent: the strict owner audit did not reject the missing row: ${String(artifactAbsentFailure.error)}`)
      assert(/split-host-pi-tui-runtime \(@xmoon76\/dsh-pi-tui\/host-runtime\): failed to import/u.test(artifactAbsentStderr)
        && /ERR_MODULE_NOT_FOUND/u.test(artifactAbsentStderr),
        `T26 Host Runtime artifact absent: the Loader did not report the real import failure; stderr=${artifactAbsentStderr.slice(-800)}`)
      assert(!hasPublishedIdentity(), 'T26 Host Runtime artifact absent published a Host identity')
    } finally {
      if (existsSync(hostRuntimeAbsentPath)) renameSync(hostRuntimeAbsentPath, hostRuntimeArtifact)
      if (previousBarrier === undefined) rmSync(packageScopeBarrier, { force: true })
      else restoreFile(packageScopeBarrier, previousBarrier)
    }
    trace('t26-runtime-artifact-absent', {
      exit: artifactAbsentExit?.code,
      readyEmitted: false,
      identityPublished: false,
      error: String(artifactAbsentFailure?.error ?? '').slice(0, 160),
      loaderImportFailed: true,
      packageScopeBarrier: true,
    })

    // T26b: one required official Session-serving row disabled after the
    // overlay must fail the strict owner audit with no Ready.
    writeFileSync(sessionControllerMutationPatch, '- id: split-host-session-controller\n  disabled: true\n')
    const missingOfficialRow = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: sessionControllerMutationPatch },
    })
    const missingOfficialRowFailure = await missingOfficialRow.waitFor(
      record => record.m4a0 === 'failure',
      'T26 missing official Session-serving row',
      120_000,
    )
    const missingOfficialRowExit = await missingOfficialRow.waitForExit(60_000)
    assert(missingOfficialRowExit.code === 1, `T26 missing official row exit was ${JSON.stringify(missingOfficialRowExit)}`)
    assert(/sessionController owner row, found 0/u.test(String(missingOfficialRowFailure.error)),
      `T26 missing official row: unexpected error ${String(missingOfficialRowFailure.error)}`)
    assert(!missingOfficialRow.records.some(record => record.m4a0 === 'ready'), 'T26 missing official row emitted ready')
    assert(!hasPublishedIdentity(), 'T26 missing official row published a Host identity')
    trace('t26-official-row-disabled', { exit: missingOfficialRowExit.code, readyEmitted: false })

    // T08: sixteen concurrent Host launch/ensure candidates. The kernel seat is
    // the ONLY winner; every loser exits before creating a Host Context.
    const race = Array.from({ length: 16 }, () => new EntryProcess('host', entries.host, base))
    trace('race', { contenders: race.length })
    const winner = await waitForAnyReady(race, 'T08 16-host race', 180_000)
    const losers = race.filter(candidate => candidate !== winner.process)
    await Promise.all(losers.map(candidate => candidate.waitForExit(60_000)))
    for (const loser of losers) {
      const conflict = loser.records.find(record => record.m4a0 === 'host-seat-conflict')
      assert(conflict?.error === 'HOST_ALREADY_OWNED', `T08 loser did not report HOST_ALREADY_OWNED: ${JSON.stringify(loser.records.slice(-2))}`)
      assert(loser.exitResult?.code === 0, `T08 loser exit was ${JSON.stringify(loser.exitResult)}`)
    }
    assert(race.filter(candidate => candidate.records.some(record => record.m4a0 === 'ready')).length === 1, 'T08 produced more than one ready Host')
    const mainHost = winner.process
    const hostReady = winner.record
    trace('race-winner', {
      contenders: race.length,
      winnerPid: hostReady.pid,
      winnerInstanceId: hostReady.localHost?.instanceId,
      loserConflicts: losers.length,
    })

    // T01: Host-only composition and the official Connection owners.
    assert(hostReady.processRole === 'host', 'T01 host role mismatch')
    assert(typeof hostReady.pid === 'number' && hostReady.pid > 0, 'T01 host PID missing')
    assert(/^\d+$/u.test(hostReady.processStartIdentity ?? ''), 'T01 host starttime missing')
    assert(typeof hostReady.rootFiberUid === 'number', 'T01 host root fiber identity missing')
    assert(hostReady.transport === 'listening', 'T01 host transport is not listening')
    assert(hostReady.sessionOpen === false, 'T01 host must not claim an open Session')
    assert(hostReady.ownerEntries?.connection?.length === 1 && hostReady.ownerEntries.connection[0] === 'split-host-connection', 'T01 connection owner mismatch')
    assert(hostReady.ownerEntries?.apiRemotes?.length === 1 && hostReady.ownerEntries.apiRemotes[0] === 'split-host-api-remotes', 'T01 api-remotes owner mismatch')
    assert(hostReady.ownerEntries?.typertGateway?.length === 1 && hostReady.ownerEntries.typertGateway[0] === 'typert-gateway', 'T01 gateway owner mismatch')
    for (const owner of ['agents', 'sessions', 'jobController']) {
      assert(hostReady.ownerEntries[owner]?.length === 1, `T01 expected exactly one ${owner} owner`)
    }
    assert(hostReady.forbiddenActive?.length === 0, 'T01 forbidden TUI/Client rows are active')
    for (const id of ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins']) {
      assert(hostReady.entries?.find(entry => entry.id === id)?.state === 'absent', `T01 ${id} is not absent`)
    }
    assert(Object.values(hostReady.services ?? {}).every(Boolean), 'T01 not all Host prerequisites reported present')
    // Host liveness: the ready record and every later status carry one fresh
    // read-only snapshot. The stock Host must report the unmounted Schedule as
    // ABSENT and must not claim quiescence while rc.4's pending-interaction
    // and in-flight-write gaps remain unobservable.
    const startupLiveness = hostReady.liveness
    assert(startupLiveness !== undefined, 'T01 the Host ready record carries no liveness snapshot')
    assert(['BLOCKED', 'UNKNOWN', 'OBSERVED_QUIESCENT'].includes(startupLiveness.verdict), `T01 invalid liveness verdict ${JSON.stringify(startupLiveness.verdict)}`)
    for (const source of ['agent', 'jobs', 'goal', 'schedule', 'pending', 'write', 'other']) {
      assert(['ACTIVE', 'IDLE', 'ABSENT', 'UNKNOWN'].includes(startupLiveness.sourceStates?.[source]), `T01 liveness source ${source} missing or invalid: ${JSON.stringify(startupLiveness.sourceStates)}`)
    }
    assert(startupLiveness.sourceStates.schedule === 'ABSENT', 'T01 the stock Host must report Schedule ABSENT')
    assert(startupLiveness.verdict !== 'OBSERVED_QUIESCENT', 'T01 the stock Host cannot prove quiescence with rc.4 pending/write gaps')
    assert(startupLiveness.reasons.includes('pending-interaction-unobservable'), 'T01 the pending-interaction gap is not reported')
    assert(startupLiveness.reasons.includes('inflight-write-unproven'), 'T01 the in-flight-write gap is not reported')
    const startupStatus = await hostStatus(mainHost)
    assert(startupStatus.liveness !== undefined, 'T01 a Host status request carries no liveness snapshot')
    assert(startupStatus.liveness.epoch >= startupLiveness.epoch, 'T01 the liveness epoch moved backwards')
    for (const service of [
      'sessionController',
      'fileUploads',
      'settingsController',
      'piTuiFileReferences',
      'piTuiTerminalProgress',
      'piTuiHostReady',
      'piTuiPerformanceReady',
    ]) {
      assert(hostReady.services?.[service] === true, `T21 ${service} is not reported live`)
    }
    assert(hostReady.terminalProgressWatches === 0, 'T21 the Host must start with no terminal-progress watchers')
    assert(hostReady.webServer?.host === '127.0.0.1' && hostReady.webServer.port > 0, 'T01 loopback webserver not ready')
    assert(hostReady.entries.filter(entry => entry.name === '@deepseek-ai/dsh-client-connection').length === 1, 'T01 duplicate Connection row')
    assert(hostReady.entries.filter(entry => entry.name === '@deepseek-ai/dsh-api-remotes').length === 1, 'T01 duplicate api-remotes row')
    assert(hostReady.entries.filter(entry => entry.id === 'typert-gateway').length === 1, 'T01 duplicate gateway row')

    // T21: the six official Session-serving rows and the ONE built-in PiTui
    // Host Runtime row are all ACTIVE; pre-existing owners stay exactly one.
    const t21Rows = {
      fileUpload: 'split-host-file-upload',
      sessionStats: 'split-host-session-stats',
      turnOutline: 'split-host-turn-outline',
      sessionController: 'split-host-session-controller',
      settingsController: 'split-host-settings-controller',
      sessionLogExport: 'split-host-session-log-download',
      piTuiHostRuntime: 'split-host-pi-tui-runtime',
    }
    for (const [owner, id] of Object.entries(t21Rows)) {
      const owners = hostReady.ownerEntries?.[owner]
      assert(Array.isArray(owners) && owners.length === 1 && owners[0] === id,
        `T21 ${owner} owner mismatch: ${JSON.stringify(owners)}`)
      assert(
        hostReady.entries.filter(entry => entry.id === id && entry.state === 'active').length === 1,
        `T21 ${id} is not exactly one active row`,
      )
    }
    assert(
      hostReady.entries.filter(entry => entry.name === '@xmoon76/dsh-pi-tui/host-runtime').length === 1,
      'T21 duplicate built-in Host Runtime row',
    )
    assert(
      hostReady.entries.filter(entry => entry.name === '@xmoon76/dsh-pi-tui/performance-host').length === 1,
      'T21 Performance row missing or duplicated',
    )
    assert(
      hostReady.entries.filter(entry => entry.name === '@xmoon76/dsh-pi-tui/visual-tools').length === 1,
      'T21 Visual Tools row missing or duplicated',
    )
    assert(
      JSON.stringify(hostReady.ownerEntries?.performance) === JSON.stringify(['pi-tui-performance-host']),
      'T21 Performance owner mismatch',
    )
    assert(
      JSON.stringify(hostReady.ownerEntries?.visualTools) === JSON.stringify(['pi-tui-visual-tools']),
      'T21 Visual Tools owner mismatch',
    )
    trace('t21', {
      officialSessionServingRows: 6,
      builtInHostRuntimeRows: 1,
      performanceOwners: hostReady.ownerEntries.performance,
      visualToolOwners: hostReady.ownerEntries.visualTools,
      terminalProgressWatches: hostReady.terminalProgressWatches,
    })
    const origin = hostReady.localHost.origin
    const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', hostReady.localHost.scopeId)
    const registryPath = join(scopeDir, 'instance.json')
    const launchPath = join(scopeDir, 'launch.json')
    assert(modeOf(scopeDir) === 0o700, 'T01 scope directory is not 0700')
    assert(modeOf(registryPath) === 0o600, 'T01 registry is not 0600')
    assert(modeOf(launchPath) === 0o600, 'T01 launch material is not 0600')
    const registry = readJson(registryPath)
    const launch = readJson(launchPath)
    assertIdentityFields(registry, hostReady.localHost, 'T01 registry')
    assert(registry.profileRealpath === realpathSync(profileDir), 'T01 registry profile path is not canonical')
    assert(launch.schema === 1 && launch.instanceId === registry.instanceId, 'T01 launch material does not name the Host instance')
    const launchUrl = new URL(launch.connectUrl)
    const hostToken = launchUrl.searchParams.get('token')
    assert(hostToken !== null && hostToken !== '', 'T01 launch URL has no Host token')
    assert(launchUrl.origin === origin && launchUrl.pathname === '/connect', 'T01 launch URL is not the Host /connect authority')
    assert(!JSON.stringify(registry).includes(hostToken), 'T01 registry leaked the launch token')
    assert(!('connectUrl' in registry) && !('cookie' in registry) && !('token' in registry), 'T01 registry carries secret material')
    isolatedScopeId = hostReady.localHost.scopeId
    trace('host-ready', {
      pid: hostReady.pid,
      starttime: hostReady.processStartIdentity,
      instanceId: hostReady.localHost.instanceId,
      origin,
      scopeId: hostReady.localHost.scopeId,
      buildId: hostReady.localHost.buildId,
      connectionOwners: hostReady.ownerEntries.connection,
      apiRemotesOwners: hostReady.ownerEntries.apiRemotes,
      gatewayOwners: hostReady.ownerEntries.typertGateway,
    })

    // The Host must never treat SPLIT_PROCESS_SCRATCH as deletion
    // authority. A second Host whose env names the live Host's own scratch or
    // a scope-outside host-scratch-* directory must exit on the seat conflict
    // without deleting either.
    const scopeScratchDirs = () => readdirSync(scopeDir).filter(name => name.startsWith('host-scratch-'))
    assert(scopeScratchDirs().length === 1, `the 16-host winner must own exactly one scope scratch, found ${String(scopeScratchDirs().length)}`)
    const mainScratch = join(scopeDir, scopeScratchDirs()[0])
    const outsideScratch = join(workDir, 'host-scratch-outside')
    mkdirSync(outsideScratch, { mode: 0o700 })
    for (const target of [mainScratch, outsideScratch]) {
      const foreign = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_SCRATCH: target },
      })
      const conflict = await foreign.waitFor(record => record.m4a0 === 'host-seat-conflict', 'foreign scratch Host seat conflict', 60_000)
      assert(foreign.effectiveScratch === target, `the foreign Host did not receive the scratch it was launched with: ${target} != ${foreign.effectiveScratch}`)
      assert(conflict.error === 'HOST_ALREADY_OWNED', `the foreign scratch conflict code was ${JSON.stringify(conflict.error)}`)
      const foreignExit = await foreign.waitForExit(30_000)
      assert(foreignExit.code === 0, `the foreign scratch Host exit was ${JSON.stringify(foreignExit)}`)
    }
    assert(existsSync(mainScratch), 'a live Host scratch was deleted through SPLIT_PROCESS_SCRATCH')
    assert(existsSync(outsideScratch), 'a scope-outside directory was deleted through SPLIT_PROCESS_SCRATCH')
    trace('t08-scratch', { winnerScratch: 1, liveHostScratchKept: true, outsideKept: true, foreignScratchTargets: 2 })

    // T09: two Clients race for the one kernel TUI seat. Only the winner may
    // create a Client Context or reach the Host.
    const clients = [
      new EntryProcess('client', entries.client, probeClientBase),
      new EntryProcess('client', entries.client, probeClientBase),
    ]
    const clientOutcomes = await Promise.all(clients.map((client, index) => waitForOutcome(client, `T09 client ${String(index)}`)))
    const clientWinners = clients.filter(client => client.records.some(record => record.m4a0 === 'ready'))
    assert(clientWinners.length === 1,
      `T09 expected one active Client, got ${String(clientWinners.length)};`
      + ` outcomes=${JSON.stringify(clientOutcomes)};`
      + ` records=${JSON.stringify(clients.map(client => client.records.slice(-4)))};`
      + ` stderr=${JSON.stringify(clients.map(client => client.stderr.slice(-1200)))}`)
    const c1 = clientWinners[0]
    const c1Ready = clientOutcomes[clients.indexOf(c1)]
    assert(c1Ready.m4a0 === 'ready', 'T09 winning Client did not become ready')
    const clientLoser = clients.find(client => client !== c1)
    expectFailureRecord(clientLoser, 'T09 loser', 'CLIENT_ALREADY_ACTIVE')
    const loserExit = await clientLoser.waitForExit(30_000)
    assert(loserExit.code === 1, `T09 losing Client exit was ${JSON.stringify(loserExit)}`)
    trace('t09', {
      activeClientPid: c1Ready.pid,
      refusedClientPid: clientLoser.child.pid,
      refusalCode: 'CLIENT_ALREADY_ACTIVE',
    })

    // T02: real authenticated HTTP + one real WebSocket generation.
    assert(c1Ready.processRole === 'client', 'T02 client role mismatch')
    assert(c1Ready.pid !== hostReady.pid, 'T02 Host and Client must be distinct PIDs')
    assert(c1Ready.transport === 'connected', `T02 client transport is ${JSON.stringify(c1Ready.transport)}`)
    assert(c1Ready.sessionOpen === false, 'T02 client must not claim a Session')
    assert(Number.isSafeInteger(c1Ready.generationId) && c1Ready.generationId > 0, 'T02 client has no real generation')
    assert(c1Ready.hostHome === home, `T02 client host home is ${JSON.stringify(c1Ready.hostHome)}`)
    assert(c1Ready.rootFiberUid !== undefined, 'T02 client root fiber identity missing')
    assert(c1Ready.activeWrappers === 1, `T02 client active wrapper baseline is ${String(c1Ready.activeWrappers)}`)
    assert(c1Ready.liveSockets === 1, `T02 client live socket baseline is ${String(c1Ready.liveSockets)}`)
    assertClientHostFacts(c1Ready.host, hostReady.localHost, 'T02')
    assert(!Object.hasOwn(c1Ready.host, 'profileRealpath'), 'T02 client status leaked the profile path')
    trace('client-ready', {
      pid: c1Ready.pid,
      generationId: c1Ready.generationId,
      hostPid: c1Ready.host.hostPid,
      hostInstanceId: c1Ready.host.instanceId,
      hostHome: c1Ready.hostHome,
    })

    // T03/T04/T06: the official admission/authentication fence.
    const noToken = await rawGet(origin, '/connect')
    assert(noToken.status === 401, `T03 no-token /connect returned ${String(noToken.status)}`)
    assert((noToken.headers['set-cookie'] ?? []).length === 0, 'T03 no-token /connect minted a Cookie')
    const wrongToken = await rawGet(origin, '/connect?token=deadbeef&interactions=answer')
    assert(wrongToken.status === 401, `T04 wrong-token /connect returned ${String(wrongToken.status)}`)
    const fakeCookie = await fetchStatus(`${origin}/api/pi-tui.local-host`, { headers: { cookie: 'dsh_session=deadbeef' } })
    assert(fakeCookie.status === 401, `T04 fake Cookie returned ${String(fakeCookie.status)}`)
    const wrongHost = await rawGet(origin, '/api/pi-tui.local-host', { host: 'evil.example' })
    assert(wrongHost.status === 403, `T04 wrong Host authority returned ${String(wrongHost.status)}`)
    const wrongOrigin = await fetchStatus(`${origin}/api/pi-tui.local-host`, { headers: { origin: 'http://evil.example' } })
    assert(wrongOrigin.status === 403, `T04 wrong Origin returned ${String(wrongOrigin.status)}`)
    const unauthenticatedIdentity = await fetchStatus(`${origin}/api/pi-tui.local-host`)
    assert([401, 403].includes(unauthenticatedIdentity.status), `T06 unauthenticated identity returned ${String(unauthenticatedIdentity.status)}`)
    assert(!unauthenticatedIdentity.body.includes(hostReady.localHost.instanceId), 'T06 unauthenticated identity leaked the instance id')
    const validCookie = await connectCookie(origin, launch)
    const identityResponse = await fetchStatus(`${origin}/api/pi-tui.local-host`, { headers: { cookie: validCookie } })
    assert(identityResponse.status === 200, `T02 authenticated identity returned ${String(identityResponse.status)}`)
    assert(/application\/json\b/iu.test(String(identityResponse.headers.get('content-type'))), 'T02 identity response is not JSON')
    assert(/\bno-store\b/iu.test(String(identityResponse.headers.get('cache-control'))), 'T02 identity response is not no-store')
    const authenticatedIdentity = JSON.parse(identityResponse.body)
    assertIdentityFields(authenticatedIdentity, registry, 'T02 authenticated identity')
    trace('auth-audit', {
      noToken: noToken.status,
      wrongToken: wrongToken.status,
      fakeCookie: fakeCookie.status,
      wrongHost: wrongHost.status,
      wrongOrigin: wrongOrigin.status,
      unauthenticatedIdentity: unauthenticatedIdentity.status,
      authenticatedIdentity: identityResponse.status,
      generationId: c1Ready.generationId,
    })
    assertNoSecret('Host stdout records', JSON.stringify(mainHost.records), [hostToken, validCookie])
    assertNoSecret('Host stderr', mainHost.stderr, [hostToken, validCookie])
    assertNoSecret('Client stdout records', JSON.stringify(c1.records), [hostToken, validCookie])
    assertNoSecret('Client stderr', c1.stderr, [hostToken, validCookie])

    // T22/T23/T24: run the real Host RPC proof on the SAME authenticated
    // Client Context. The probe mounts its two contributions temporarily and
    // unmounts them; no second Client/Connection/Gateway/Context is created.
    // Running it twice is also the T25 duplicate-registration check.
    /** Wait for the Host to report exactly `expected` live progress watchers. */
    const waitForHostWatchCount = async (expected, label, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs
      let status = await hostStatus(mainHost)
      while (status.terminalProgressWatches !== expected && Date.now() < deadline) {
        await sleep(25)
        status = await hostStatus(mainHost)
      }
      assert(
        status.terminalProgressWatches === expected,
        `${label}: expected ${String(expected)} Host terminal-progress watcher(s), got ${JSON.stringify(status.terminalProgressWatches)}`,
      )
      return status
    }
    const runHostFoundationProbe = async (client, label) => {
      const requestId = `m4b2hf-${label}-${++statusSequence}`
      rmSync(hostFoundationBarrier, { force: true })
      client.send({ op: 'qualification-host-foundation', requestId })
      // The probe holds the real Host watch open after its opening snapshot and
      // waits for the private barrier file, so the harness can observe the live
      // Host subscription (1) before releasing it and then observe 0.
      await client.waitFor(
        record => record.m4b2hf === 'host-rpc-watch-open' && record.requestId === requestId,
        `${label} watch open`,
        180_000,
      )
      const during = await waitForHostWatchCount(1, `${label} live watch`)
      trace('host-rpc-watch-open', {
        requestId,
        hostTerminalProgressWatches: during.terminalProgressWatches,
      })
      writeFileSync(hostFoundationBarrier, 'release\n', { mode: 0o600 })
      const proof = await client.waitFor(
        record => record.m4b2hf === 'host-rpc-proof' && record.requestId === requestId,
        label,
        180_000,
      )
      const after = await waitForHostWatchCount(0, `${label} watch release`)
      return { proof, during, after }
    }
    const firstProbe = await runHostFoundationProbe(c1, 't22-24')
    const hostRpcProof = firstProbe.proof
    assert(hostRpcProof.hostPid === hostReady.pid, 'T22 probe Host PID mismatch')
    assert(hostRpcProof.hostInstanceId === hostReady.localHost.instanceId, 'T22 probe Host instance mismatch')
    assert(hostRpcProof.clientPid === c1Ready.pid, 'T22 probe Client PID mismatch')
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      assert(hostRpcProof[field] === true, `T22/T23/T24/T25 ${field} is not proven`)
    }
    const repeatedProbe = await runHostFoundationProbe(c1, 't25-repeat')
    const repeatedProof = repeatedProbe.proof
    assert(repeatedProof.hostPid === hostReady.pid, 'T25 repeat probe Host PID mismatch')
    assert(repeatedProof.hostInstanceId === hostReady.localHost.instanceId, 'T25 repeat probe Host instance mismatch')
    assert(repeatedProof.clientPid === c1Ready.pid, 'T25 repeat probe Client PID mismatch')
    for (const field of ['officialSessionList', 'privateFileRpc', 'terminalSnapshot', 'cleaned']) {
      assert(repeatedProof[field] === true, `T25 repeat ${field} is not proven`)
    }
    trace('t22-t24-host-rpc-proof', {
      hostPid: hostRpcProof.hostPid,
      hostInstanceId: hostRpcProof.hostInstanceId,
      clientPid: hostRpcProof.clientPid,
      officialSessionList: true,
      privateFileRpc: 'ok/unavailable',
      terminalSnapshot: 'snapshot:false:idle',
      cleaned: true,
      hostTerminalProgressWatchesBefore: hostReady.terminalProgressWatches,
      hostTerminalProgressWatchesDuring: firstProbe.during.terminalProgressWatches,
      hostTerminalProgressWatchesAfter: firstProbe.after.terminalProgressWatches,
    })
    trace('t25-repeat-probe', {
      hostPid: repeatedProof.hostPid,
      hostInstanceId: repeatedProof.hostInstanceId,
      clientPid: repeatedProof.clientPid,
      duplicateRegistration: false,
      hostTerminalProgressWatchesDuring: repeatedProbe.during.terminalProgressWatches,
      hostTerminalProgressWatchesAfter: repeatedProbe.after.terminalProgressWatches,
    })

    // T05: one mux socket per authenticated peer; release invalidates the Peer.
    const muxUrl = new URL('/api/remote.mux', origin)
    muxUrl.protocol = 'ws:'
    const firstMux = await muxAttempt(muxUrl.href, validCookie, WebSocket)
    assert(firstMux.opened === true, 'T05 first mux socket did not open')
    const secondMux = await muxAttempt(muxUrl.href, validCookie, WebSocket)
    assert(secondMux.opened === false && secondMux.status === 409, `T05 second mux returned ${JSON.stringify(secondMux.status)}`)
    assert(firstMux.socket.readyState === WebSocket.OPEN, 'T05 first mux socket did not survive the 409')
    await closeMux(firstMux.socket, WebSocket)
    let thirdMux
    const releaseDeadline = Date.now() + 5_000
    while (Date.now() < releaseDeadline) {
      thirdMux = await muxAttempt(muxUrl.href, validCookie, WebSocket)
      if (thirdMux.opened === false && thirdMux.status === 401) break
      if (thirdMux.opened === true) {
        await closeMux(thirdMux.socket, WebSocket)
        assert(false, 'T05 the released Peer opened the mux again')
      }
      await sleep(100)
    }
    assert(thirdMux?.opened === false && thirdMux.status === 401, `T05 released Peer returned ${JSON.stringify(thirdMux?.status)}`)
    trace('mux-audit', { first: 'open', second: 409, released: 401 })

    // T10: C1 normal exit keeps the Host; C2 re-authenticates to the same root.
    const c1Exit = await c1.shutdown()
    assert(c1Exit.code === 0 && c1Exit.signal === null, `T10 normal Client exit was ${JSON.stringify(c1Exit)}`)
    const hostAfterC1 = await hostStatus(mainHost)
    assertIdentityFields(hostAfterC1.localHost, hostReady.localHost, 'T10 Host after normal Client exit')
    assert(hostAfterC1.rootFiberUid === hostReady.rootFiberUid, 'T10 Host root fiber identity changed')
    // T25: the Client that ran the probe exited; the same Host PID/instance and
    // the one built-in Host Runtime owner remain, and later Clients still attach.
    const t25RuntimeOwners = hostAfterC1.ownerEntries?.piTuiHostRuntime
    assert(Array.isArray(t25RuntimeOwners) && t25RuntimeOwners.length === 1
      && t25RuntimeOwners[0] === 'split-host-pi-tui-runtime',
    `T25 the built-in Host Runtime owner changed after Client exit: ${JSON.stringify(t25RuntimeOwners)}`)
    assert(hostAfterC1.localHost.instanceId === hostReady.localHost.instanceId,
      'T25 the Host instance changed after Client exit')
    trace('t25-client-detach', {
      hostPid: hostAfterC1.localHost.hostPid,
      instanceId: hostAfterC1.localHost.instanceId,
      hostRuntimeOwner: hostAfterC1.ownerEntries.piTuiHostRuntime,
      hostAlive: alive(hostReady.pid),
    })

    // T02 negative mutation: the Client still authenticates during discovery,
    // then omits its Cookie from the official transport carrier. The Host must
    // refuse the mux; the Client must fail after its bounded generation wait.
    const noCookie = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_OMIT_COOKIE: '1' },
    })
    const noCookieFailure = await noCookie.waitFor(record => record.m4a0 === 'failure', 'T02 cookie omission mutation', 90_000)
    const noCookieExit = await noCookie.waitForExit(30_000)
    assert(noCookieExit.code === 1, `T02 cookie omission exit was ${JSON.stringify(noCookieExit)}`)
    assert(noCookieFailure.code === 'HOST_UNRESPONSIVE', `T02 cookie omission code was ${JSON.stringify(noCookieFailure.code ?? noCookieFailure.error)}`)
    const noCookieCleanup = noCookie.records.find(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
    assert(noCookieCleanup !== undefined, 'T02 cookie omission emitted no cleanup outcome')
    const noCookieReady = noCookie.records.some(record => record.m4a0 === 'ready')
    assert(!noCookieReady, 'T26 the no-Cookie Client must never emit ready')
    assert(alive(hostReady.pid), 'T02 cookie omission killed the Host')
    trace('t02-cookie-mutation', { code: 'HOST_UNRESPONSIVE', cleanup: noCookieCleanup.m4a0, hostAlive: true })
    trace('t26-no-cookie', { code: 'HOST_UNRESPONSIVE', readyEmitted: noCookieReady, hostAlive: true })

    // T14 startup fatal probe: a fatal that arrives before startLocalTransport
    // returns must reject the startup exactly once, emit no ready, and release
    // the Client seat while the Host stays alive.
    const startupFatal = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL: '1' },
    })
    const startupFailure = await startupFatal.waitFor(record => record.m4a0 === 'failure', 'T14 startup fatal', 60_000)
    const startupExit = await startupFatal.waitForExit(30_000)
    assert(startupExit.code === 1, `T14 startup fatal exit was ${JSON.stringify(startupExit)}`)
    assert(startupFailure.code === 'HOST_IDENTITY_MISMATCH', `T14 startup fatal code was ${JSON.stringify(startupFailure.code ?? startupFailure.error)}`)
    assert(!startupFatal.records.some(record => record.m4a0 === 'ready'), 'T14 startup fatal emitted ready')
    assert(startupFatal.records.filter(record => record.m4a0 === 'failure').length === 1, 'T14 startup fatal duplicated the failure record')
    const startupCleanup = startupFatal.records.filter(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure')
    assert(startupCleanup.length === 1, `T14 startup fatal emitted ${String(startupCleanup.length)} cleanup outcomes`)
    assert(alive(hostReady.pid), 'T14 startup fatal killed the Host')
    trace('t14-startup-fatal', { code: 'HOST_IDENTITY_MISMATCH', readyEmitted: false, cleanup: startupCleanup[0].m4a0, hostAlive: true })

    const c2 = new EntryProcess('client', entries.client, base)
    const c2Outcome = await waitForOutcome(c2, 'T10 C2')
    assert(c2Outcome.m4a0 === 'ready' && c2Outcome.transport === 'connected', `T10 C2 did not connect: ${JSON.stringify(c2Outcome)}`)
    assert(c2Outcome.pid !== c1Ready.pid, 'T10 C2 did not mint a new Client process')
    assertClientHostFacts(c2Outcome.host, hostReady.localHost, 'T10 C2')
    const beforeDropGeneration = c2Outcome.generationId
    trace('t10', {
      firstClientPid: c1Ready.pid,
      secondClientPid: c2Outcome.pid,
      generationId: c2Outcome.generationId,
      hostInstanceId: c2Outcome.host.instanceId,
    })
    trace('reconnect-baseline', { clientPid: c2Outcome.pid, generationId: beforeDropGeneration })

    // T13/F2: physically drop the actual mux socket repeatedly. Each cycle
    // must clear the generation, form a replacement on the same Host, and
    // return the active wrapper/socket ownership to its one-connection
    // baseline. Thirty-six cycles expose cumulative wrapper retention.
    const RECONNECT_CYCLES = 36
    assert(c2Outcome.activeWrappers === 1, `T13 wrapper baseline is ${String(c2Outcome.activeWrappers)}`)
    assert(c2Outcome.liveSockets === 1, `T13 socket baseline is ${String(c2Outcome.liveSockets)}`)
    let beforeGeneration = beforeDropGeneration
    let lastReconnected
    for (let cycle = 1; cycle <= RECONNECT_CYCLES; cycle += 1) {
      const requestId = `drop-${cycle}`
      c2.send({ op: 'qualification-drop-websocket', requestId })
      await c2.waitFor(record => record.m4a0 === 'qualification' && record.requestId === requestId, `T13 qualification drop ${cycle}`, 30_000)
      let sawInterruption = false
      let reconnected
      const reconnectDeadline = Date.now() + 20_000
      while (Date.now() < reconnectDeadline) {
        const status = await clientStatus(c2)
        if (!sawInterruption && status.transport !== 'connected') {
          sawInterruption = true
          assert(status.generationId === undefined, `T13 cycle ${cycle} interrupted status kept a stale generation`)
          if (cycle === 1) trace('reconnect-interruption', { transport: status.transport })
        }
        if (sawInterruption && status.transport === 'connected' && status.generationId > beforeGeneration) {
          reconnected = status
          break
        }
        await sleep(25)
      }
      assert(sawInterruption, `T13 cycle ${cycle} never observed a disconnected/connecting state`)
      assert(reconnected !== undefined, `T13 cycle ${cycle} never formed a replacement generation`)
      assert(reconnected.activeWrappers === 1, `T13 cycle ${cycle} retained ${String(reconnected.activeWrappers)} wrapper(s)`)
      assert(reconnected.liveSockets === 1, `T13 cycle ${cycle} retained ${String(reconnected.liveSockets)} socket(s)`)
      beforeGeneration = reconnected.generationId
      lastReconnected = reconnected
    }
    assertClientHostFacts(lastReconnected.host, hostReady.localHost, 'T13 reconnected')
    trace('reconnect', {
      cycles: RECONNECT_CYCLES,
      beforeGenerationId: beforeDropGeneration,
      afterGenerationId: lastReconnected.generationId,
      activeWrappers: lastReconnected.activeWrappers,
      liveSockets: lastReconnected.liveSockets,
      hostInstanceId: lastReconnected.host.instanceId,
    })
    const c2Exit = await c2.shutdown()
    assert(c2Exit.code === 0, `T13 C2 normal exit was ${JSON.stringify(c2Exit)}`)
    assert(alive(hostReady.pid), 'T13 Host died on C2 exit')

    // T14 lifetime: a CONNECTED Client whose replacement launch names another
    // Host instance must terminate with HOST_IDENTITY_MISMATCH; the official
    // Connection loop must not retry it as an ordinary carrier loss.
    const lifetimeClient = new EntryProcess('client', entries.client, base)
    const lifetimeReady = await waitForOutcome(lifetimeClient, 'T14 lifetime client', 120_000)
    assert(lifetimeReady.m4a0 === 'ready' && lifetimeReady.transport === 'connected', `T14 lifetime Client did not connect: ${JSON.stringify(lifetimeReady)}`)
    const lifetimeLaunchSaved = saveFile(launchPath)
    writeRawPrivate(launchPath, { ...launch, instanceId: randomUUID() })
    try {
      lifetimeClient.send({ op: 'qualification-drop-websocket', requestId: 'lifetime-drop' })
      await lifetimeClient.waitFor(record => record.m4a0 === 'qualification' && record.requestId === 'lifetime-drop', 'T14 lifetime drop', 30_000)
      const lifetimeFailure = await lifetimeClient.waitFor(record => record.m4a0 === 'failure', 'T14 lifetime identity', 60_000)
      const lifetimeExit = await lifetimeClient.waitForExit(30_000)
      assert(lifetimeExit.code === 1, `T14 lifetime exit was ${JSON.stringify(lifetimeExit)}`)
      assert(lifetimeFailure.code === 'HOST_IDENTITY_MISMATCH', `T14 lifetime code was ${JSON.stringify(lifetimeFailure.code ?? lifetimeFailure.error)}`)
      assert(lifetimeClient.records.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T14 lifetime did not emit completed cleanup')
      assert(alive(hostReady.pid), 'T14 lifetime killed the Host')
      trace('t14-lifetime', { code: 'HOST_IDENTITY_MISMATCH', hostAlive: true })
    } finally {
      restoreFile(launchPath, lifetimeLaunchSaved)
      if (!lifetimeClient.exited) lifetimeClient.kill('SIGKILL')
    }

    // T13 retryable refresh: a transient HOST_UNRESPONSIVE during Cookie
    // refresh must stay an official same-Host retry, not a fatal Client exit.
    const retryable = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE: '1' },
    })
    const retryableReady = await waitForOutcome(retryable, 'T13 retryable refresh Client', 120_000)
    assert(retryableReady.m4a0 === 'ready' && retryableReady.transport === 'connected', `T13 retryable Client did not connect: ${JSON.stringify(retryableReady)}`)
    const retryableBefore = retryableReady.generationId
    retryable.send({ op: 'qualification-drop-websocket', requestId: 'retryable-drop' })
    await retryable.waitFor(record => record.m4a0 === 'qualification' && record.requestId === 'retryable-drop', 'T13 retryable drop', 30_000)
    let retryableInterrupted = false
    let retryableAfter
    const retryableDeadline = Date.now() + 20_000
    while (Date.now() < retryableDeadline && !retryable.exited) {
      const status = await clientStatus(retryable)
      if (status.transport !== 'connected') retryableInterrupted = true
      if (status.transport === 'connected' && status.generationId > retryableBefore) {
        retryableAfter = status
        break
      }
      await sleep(50)
    }
    assert(!retryable.exited, 'T13 retryable refresh became a fatal Client exit')
    assert(retryableInterrupted, 'T13 retryable refresh never observed an interrupted state')
    assert(retryableAfter !== undefined, 'T13 retryable refresh never formed a replacement generation')
    assertClientHostFacts(retryableAfter.host, hostReady.localHost, 'T13 retryable')
    const retryableExit = await retryable.shutdown()
    assert(retryableExit.code === 0, `T13 retryable Client exit was ${JSON.stringify(retryableExit)}`)
    assert(alive(hostReady.pid), 'T13 retryable refresh killed the Host')
    trace('t13-retryable-refresh', {
      beforeGenerationId: retryableBefore,
      afterGenerationId: retryableAfter.generationId,
      hostAlive: true,
    })

    // T11: SIGKILL releases the Client seat; C2 reconnects to the same Host.
    const c3 = new EntryProcess('client', entries.client, base)
    const c3Outcome = await waitForOutcome(c3, 'T11 C3')
    assert(c3Outcome.m4a0 === 'ready' && c3Outcome.transport === 'connected', 'T11 C3 did not connect')
    c3.kill('SIGKILL')
    const c3Exit = await c3.waitForExit(30_000)
    assert(c3Exit.signal === 'SIGKILL', `T11 C3 exit was ${JSON.stringify(c3Exit)}`)
    assert(alive(hostReady.pid), 'T11 Host died on Client SIGKILL')
    const c4 = new EntryProcess('client', entries.client, base)
    const c4Outcome = await waitForOutcome(c4, 'T11 C4')
    assert(c4Outcome.m4a0 === 'ready' && c4Outcome.transport === 'connected', 'T11 C4 did not reconnect to the same Host')
    assert(c4Outcome.pid !== c3.pid, 'T11 C4 reused the killed Client PID')
    assertClientHostFacts(c4Outcome.host, hostReady.localHost, 'T11 C4')
    const c4Exit = await c4.shutdown()
    assert(c4Exit.code === 0, `T11 C4 exit was ${JSON.stringify(c4Exit)}`)
    assert(alive(hostReady.pid), 'T11 Host died on C4 exit')
    trace('t11', {
      killedClientPid: c3.pid,
      reconnectedClientPid: c4Outcome.pid,
      hostInstanceId: c4Outcome.host.instanceId,
    })

    // T12: SIGTERM disposes the Client only. PTY HUP is a declared Linux L1
    // limitation in this qualification lane (no PTY harness is installed).
    const c5 = new EntryProcess('client', entries.client, base)
    const c5Outcome = await waitForOutcome(c5, 'T12 C5')
    assert(c5Outcome.m4a0 === 'ready' && c5Outcome.transport === 'connected', 'T12 C5 did not connect')
    c5.kill('SIGTERM')
    const c5Exit = await c5.waitForExit(30_000)
    assert(c5Exit.code === 0, `T12 C5 SIGTERM exit was ${JSON.stringify(c5Exit)}`)
    assert(alive(hostReady.pid), 'T12 Host died on Client SIGTERM')
    // This record covers ONLY the SIGTERM half. The real PTY master-close
    // (HUP-class) positive is the separate `t12-pty-hup` record later in this
    // lane; it must never be inferred from here.
    trace('t12', { sigterm: 'pass', ptyHup: 'separate t12-pty-hup case' })

    // T17a: non-destructive installed-payload drift. Appending a harmless
    // comment changes the Client's recomputed build fingerprint while the
    // module stays loadable and the local wire contract is unchanged. The new
    // Client must authenticate to the SAME live Host; the Host identity,
    // Registry/Launch bytes and its running work stay untouched. The chunk is
    // restored byte-for-byte before T17b and every later gate runs.
    const clientChunk = chunk(profilePackage, 'client-bootstrap-')
    const clientChunkBytes = readFileSync(clientChunk)
    const undisturbedBuildId = productionBuildId(profilePackage, hostReady.localHost.dshVersion)
    const driftRegistryBytes = readFileSync(registryPath)
    const driftLaunchBytes = readFileSync(launchPath)
    let driftClient
    try {
      appendFileSync(clientChunk, '\n// harmless client build drift: protocol unchanged\n')
      const driftedBuildId = productionBuildId(profilePackage, hostReady.localHost.dshVersion)
      assert(driftedBuildId !== undisturbedBuildId, 'T17 payload drift did not change the production build fingerprint')
      assert(driftedBuildId !== hostReady.localHost.buildId, 'T17 payload drift did not differ from the live Host buildId')
      driftClient = new EntryProcess('client', entries.client, base)
      const driftedAuth = await driftClient.waitFor(
        record => record.m4a0 === 'host-authenticated',
        'T17 drift Client authenticated the live Host',
        120_000,
      )
      assertClientHostFacts(driftedAuth.host, hostReady.localHost, 'T17 drift authenticated Host')
      const driftReady = await driftClient.waitFor(record => record.m4a0 === 'ready', 'T17 drift Client ready', 240_000)
      assert(driftReady.transport === 'connected', `T17 drift transport was ${JSON.stringify(driftReady.transport)}`)
      const driftExit = await driftClient.shutdown()
      assert(driftExit.code === 0 && driftExit.signal === null, `T17 drift Client exit was ${JSON.stringify(driftExit)}`)
      assert(!driftClient.records.some(record => record.m4a0 === 'cleanup-failure'),
        'T17 drift Client reported a cleanup failure')
      assert(await seatIsFree(`\0dsh-pi-tui-c-${hostReady.localHost.scopeId.slice(0, 40)}`),
        'T17 drift Client did not release the Client seat')
      assert(alive(hostReady.pid), 'T17 payload drift killed the Host')
      assert(readFileSync(registryPath).equals(driftRegistryBytes), 'T17 drift Client mutated the Host registry')
      assert(readFileSync(launchPath).equals(driftLaunchBytes), 'T17 drift Client mutated the Host launch material')
      trace('t17-payload-drift', {
        buildIdChanged: true,
        transport: 'connected',
        hostInstanceId: driftedAuth.host.instanceId,
        hostAlive: true,
      })
    } finally {
      writeFileSync(clientChunk, clientChunkBytes)
      assert(readFileSync(clientChunk).equals(clientChunkBytes), 'T17 payload drift did not restore the installed client chunk')
      if (driftClient !== undefined && !driftClient.exited) driftClient.kill('SIGKILL')
    }

    // T17b: forced startup failure with an unchanged install. The internal
    // qualification flag exercises the same after-context reverse cleanup that
    // a real Client chunk-load failure takes, without changing the build id.
    const forcedClient = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_FORCE_FAILURE: 'client-bootstrap' },
    })
    await forcedClient.waitFor(record => record.m4a0 === 'failure', 'T17 forced bootstrap failure', 60_000)
    const forcedExit = await forcedClient.waitForExit(30_000)
    assert(forcedExit.code === 1, `T17 forced bootstrap failure exit was ${JSON.stringify(forcedExit)}`)
    const forcedFailure = forcedClient.records.find(record => record.m4a0 === 'failure')
    assert(forcedFailure !== undefined && forcedFailure.phase === 'after-context', 'T17 forced bootstrap failure did not report after-context failure')
    assert(forcedFailure.activeWrappers === 0, `T17 forced bootstrap retained ${String(forcedFailure.activeWrappers)} wrapper(s)`)
    assert(forcedFailure.liveSockets === 0, `T17 forced bootstrap retained ${String(forcedFailure.liveSockets)} socket(s)`)
    assert(forcedClient.records.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T17 forced bootstrap failure did not emit completed cleanup')
    assert(!forcedClient.records.some(record => record.m4a0 === 'cleanup-failure'), 'T17 forced bootstrap failure falsely reported cleanup failure')
    assert(alive(hostReady.pid), 'T17 forced bootstrap failure killed the Host')
    trace('t17-forced-bootstrap', { phase: 'after-context', cleanup: 'completed', hostAlive: true })

    // T07: unsafe private files/directories fail before any Host spawn.
    const expectClientFailure = async (label, expectedCode, mutate, restore, timeoutMs = 60_000) => {
      mutate()
      let failure
      let exit
      try {
        const client = new EntryProcess('client', entries.client, base)
        failure = await client.waitFor(record => record.m4a0 === 'failure', label, timeoutMs)
        exit = await client.waitForExit(30_000)
        assert(exit.code === 1, `${label}: exit was ${JSON.stringify(exit)}`)
        assert(failure.code === expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(failure.code ?? failure.error)}`)
        assert(
          !client.records.some(record => record.m4a0 === 'ready' || record.m4a0 === 'host-authenticated' || record.m4a0 === 'transport-ready'),
          `${label}: a refused Client reached a business-ready record`,
        )
      } finally {
        restore()
      }
      assert(alive(hostReady.pid), `${label}: Host died`)
      return failure
    }
    const registrySaved = saveFile(registryPath)
    await expectClientFailure('T07 registry mode', 'LOCAL_FILE_UNSAFE', () => {
      chmodSync(registryPath, 0o644)
    }, () => restoreFile(registryPath, registrySaved))
    const decoyPath = join(scopeDir, 'decoy.json')
    writeRawPrivate(decoyPath, registry)
    await expectClientFailure('T07 registry symlink', 'LOCAL_FILE_UNSAFE', () => {
      unlinkSync(registryPath)
      symlinkSync(decoyPath, registryPath)
    }, () => restoreFile(registryPath, registrySaved))
    unlinkSync(decoyPath)
    const scopeMode = modeOf(scopeDir)
    await expectClientFailure('T07 scope directory mode', 'SCOPE_DIRECTORY_UNSAFE', () => {
      chmodSync(scopeDir, 0o755)
    }, () => chmodSync(scopeDir, scopeMode))
    const launchSaved = saveFile(launchPath)
    await expectClientFailure('T07 launch mode', 'LOCAL_FILE_UNSAFE', () => {
      chmodSync(launchPath, 0o644)
    }, () => restoreFile(launchPath, launchSaved))
    trace('rejections', { registryMode: 'LOCAL_FILE_UNSAFE', registrySymlink: 'LOCAL_FILE_UNSAFE', scopeMode: 'SCOPE_DIRECTORY_UNSAFE', launchMode: 'LOCAL_FILE_UNSAFE' })

    // T14: a forged registry/launch pair cannot fabricate a Host; the real
    // authenticated identity wins and reports HOST_IDENTITY_MISMATCH.
    const forgedRegistry = { ...registry, instanceId: randomUUID() }
    const forgedLaunch = { ...launch, instanceId: forgedRegistry.instanceId }
    writeRawPrivate(registryPath, forgedRegistry)
    writeRawPrivate(launchPath, forgedLaunch)
    const forgedRegistryBytes = readFileSync(registryPath)
    const forgedLaunchBytes = readFileSync(launchPath)
    try {
      await expectClientFailure('T14 forged identity', 'HOST_IDENTITY_MISMATCH', () => {}, () => {}, 60_000)
      assert(readFileSync(registryPath).equals(forgedRegistryBytes), 'T14 Client mutated the registry')
      assert(readFileSync(launchPath).equals(forgedLaunchBytes), 'T14 Client mutated the launch material')
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    trace('rejections-identity', { forgedInstanceId: 'HOST_IDENTITY_MISMATCH' })

    // T16/T17: an alive-but-unresponsive PID, a protocol mismatch, a forged
    // registry build identity and a bad token are terminal refusals that never
    // kill or replace the live Host.
    const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    dummy.unref()
    trackedProcesses.set(dummy.pid, undefined)
    let dummyStarttime
    for (let attempt = 0; attempt < 100 && dummyStarttime === undefined; attempt += 1) {
      dummyStarttime = readStartIdentity(dummy.pid)
      if (dummyStarttime === undefined) await sleep(20)
    }
    assert(dummyStarttime !== undefined, 'T16 dummy PID has no starttime')
    trackedProcesses.set(dummy.pid, dummyStarttime)
    failpoint('dummy')
    let closedPort
    {
      const server = createNetServer()
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', () => resolveListen())
      })
      closedPort = server.address().port
      await new Promise(resolveClose => server.close(() => resolveClose()))
    }
    // T14 forged PID: the registry claims a live non-Host PID but keeps the
    // real authenticated Host endpoint. The authenticated identity echo differs
    // from the registry and must be HOST_IDENTITY_MISMATCH, not readiness.
    writeRawPrivate(registryPath, {
      ...registry,
      hostPid: dummy.pid,
      hostStarttime: dummyStarttime,
    })
    writeRawPrivate(launchPath, launch)
    try {
      await expectClientFailure('T14 forged PID', 'HOST_IDENTITY_MISMATCH', () => {}, () => {})
      assert(alive(dummy.pid), 'T14 forged PID killed the live non-Host PID')
      assert(alive(hostReady.pid), 'T14 forged PID killed the live Host')
      trace('t14-forged-pid', { code: 'HOST_IDENTITY_MISMATCH', hostAlive: true, dummyAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }

    // T14 forged origin: a real live Host PID with an unresponsive forged
    // loopback origin must fail closed as HOST_UNRESPONSIVE, never spawn.
    writeRawPrivate(registryPath, {
      ...registry,
      origin: `http://127.0.0.1:${String(closedPort)}`,
    })
    writeRawPrivate(launchPath, {
      schema: 1,
      instanceId: registry.instanceId,
      connectUrl: `http://127.0.0.1:${String(closedPort)}/connect?token=deadbeef`,
    })
    try {
      await expectClientFailure('T14 forged origin', 'HOST_UNRESPONSIVE', () => {}, () => {})
      assert(alive(hostReady.pid), 'T14 forged origin killed the live Host')
      trace('t14-forged-origin', { code: 'HOST_UNRESPONSIVE', hostAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }

    const unresponsiveRegistry = {
      ...registry,
      instanceId: randomUUID(),
      hostPid: dummy.pid,
      hostStarttime: dummyStarttime,
      origin: `http://127.0.0.1:${String(closedPort)}`,
    }
    writeRawPrivate(registryPath, unresponsiveRegistry)
    writeRawPrivate(launchPath, {
      schema: 1,
      instanceId: unresponsiveRegistry.instanceId,
      connectUrl: `${unresponsiveRegistry.origin}/connect?token=deadbeef`,
    })
    const unresponsiveBytes = readFileSync(registryPath)
    try {
      await expectClientFailure('T16 unresponsive Host', 'HOST_UNRESPONSIVE', () => {}, () => {})
      assert(alive(dummy.pid), 'T16 unresponsive Host test killed the dummy PID')
      assert(alive(hostReady.pid), 'T16 unresponsive Host test killed the live Host')
      assert(readFileSync(registryPath).equals(unresponsiveBytes), 'T16 unresponsive Host test mutated the registry')
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    const protocolIncompatibleRegistry = { ...registry, protocol: 'dsh-pi-tui/local/2' }
    writeRawPrivate(registryPath, protocolIncompatibleRegistry)
    writeRawPrivate(launchPath, launch)
    const protocolIncompatibleRegistryBytes = readFileSync(registryPath)
    const protocolIncompatibleLaunchBytes = readFileSync(launchPath)
    try {
      await expectClientFailure('T16 protocol incompatible', 'HOST_PROTOCOL_INCOMPATIBLE', () => {}, () => {})
      assert(alive(hostReady.pid), 'T16 protocol mismatch killed the live Host')
      assert(readFileSync(registryPath).equals(protocolIncompatibleRegistryBytes),
        'T16 protocol mismatch mutated the registry')
      assert(readFileSync(launchPath).equals(protocolIncompatibleLaunchBytes),
        'T16 protocol mismatch mutated the launch material')
      trace('t16-protocol-incompatible', { code: 'HOST_PROTOCOL_INCOMPATIBLE', hostAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    // A forged registry buildId is no longer a Client admission gate: this
    // candidate reaches the authenticated identity comparison, where the live
    // Host's real echo differs from the registry and is a hard identity
    // mismatch. That keeps buildId strict where it belongs (Host identity),
    // not as a cross-build admission key.
    const buildDriftRegistry = { ...registry, buildId: 'a'.repeat(64) }
    writeRawPrivate(registryPath, buildDriftRegistry)
    writeRawPrivate(launchPath, launch)
    try {
      await expectClientFailure('T16 registry build drift', 'HOST_IDENTITY_MISMATCH', () => {}, () => {})
      assert(alive(hostReady.pid), 'T16 registry build drift killed the live Host')
      trace('t16-registry-build-drift', { code: 'HOST_IDENTITY_MISMATCH', hostAlive: true })
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    writeRawPrivate(launchPath, {
      schema: 1,
      instanceId: registry.instanceId,
      connectUrl: `${origin}/connect?token=deadbeef`,
    })
    try {
      await expectClientFailure('T17 auth failure', 'HOST_AUTH_FAILED', () => {}, () => {})
      assert(alive(hostReady.pid), 'T17 auth failure killed the live Host')
    } finally {
      restoreFile(registryPath, registrySaved)
      restoreFile(launchPath, launchSaved)
    }
    killTracked(dummy.pid, dummyStarttime, 'SIGKILL')
    trace('rejections-host', {
      unresponsive: 'HOST_UNRESPONSIVE',
      protocolIncompatible: 'HOST_PROTOCOL_INCOMPATIBLE',
      registryBuildDrift: 'HOST_IDENTITY_MISMATCH',
      authFailure: 'HOST_AUTH_FAILED',
    })

    // T15: a killed Host leaves a stale registry. The next Client may start a
    // new Host only through the kernel seat; the old token/Cookie do not carry.
    mainHost.kill('SIGKILL')
    const mainHostExit = await mainHost.waitForExit(30_000)
    assert(mainHostExit.signal === 'SIGKILL', `T15 main Host exit was ${JSON.stringify(mainHostExit)}`)
    assert(!alive(hostReady.pid), 'T15 main Host survived SIGKILL')
    assert(existsSync(registryPath), 'T15 stale registry disappeared on SIGKILL')
    const hostChunk = chunk(profilePackage, 'host-bootstrap-')
    renameSync(hostChunk, `${hostChunk}.missing`)
    let missingHostExit
    let missingHostRecords
    try {
      const missingHost = new EntryProcess('host', entries.host, base)
      await missingHost.waitFor(record => record.m4a0 === 'failure', 'T17 missing host chunk', 120_000)
      missingHostExit = await missingHost.waitForExit(60_000)
      missingHostRecords = missingHost.records
    } finally {
      renameSync(`${hostChunk}.missing`, hostChunk)
    }
    assert(missingHostExit.code === 1, `T17 missing host chunk exit was ${JSON.stringify(missingHostExit)}`)
    assert(missingHostRecords.some(record => record.m4a0 === 'failure' && record.phase === 'after-boot'), 'T17 missing host chunk did not report after-boot failure')
    assert(missingHostRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T17 missing host chunk did not emit completed cleanup')
    assert(!missingHostRecords.some(record => record.m4a0 === 'cleanup-failure'), 'T17 missing host chunk falsely reported cleanup failure')
    trace('t17-host-chunk', { phase: 'after-boot', cleanup: 'completed' })

    // A real Client spawn whose Host fails before runProfile must
    // remove only its own launcher-created scratch. The main Host is already
    // dead, so ensureLocalHost actually spawns a candidate.
    const removalFailure = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_SCRATCH_REMOVE_FAILURE: '1' },
    })
    const removalReady = await waitForOutcome(removalFailure, 'scratch-removal-failure Host', 120_000)
    assert(removalReady.m4a0 === 'ready', `the scratch-removal Host did not become ready: ${JSON.stringify(removalReady)}`)
    removalFailure.send({ op: 'shutdown' })
    const removalCleanup = await removalFailure.waitFor(record => record.m4a0 === 'cleanup-failure', 'scratch removal cleanup failure', 60_000)
    assert(removalCleanup.step === 'scratch-remove', `the scratch removal reported cleanup step ${JSON.stringify(removalCleanup.step)}`)
    const removalExit = await removalFailure.waitForExit(30_000)
    assert(removalExit.code === 1, `the scratch removal Host exit was ${JSON.stringify(removalExit)}`)
    trace('t15-removal-failure', { step: removalCleanup.step, exit: removalExit.code })

    const preProfileScratch = scopeScratchDirs().length
    const preProfile = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_BOOT_FAILURE: 'before-profile' },
    })
    const preProfileFailure = await preProfile.waitFor(record => record.m4a0 === 'failure', 'pre-profile Host failure', 120_000)
    const preProfileExit = await preProfile.waitForExit(30_000)
    assert(preProfileExit.code === 1, `the pre-profile Client exit was ${JSON.stringify(preProfileExit)}`)
    assert(preProfileFailure.code === 'HOST_START_TIMEOUT', `the pre-profile failure code was ${JSON.stringify(preProfileFailure.code ?? preProfileFailure.error)}`)
    assert(scopeScratchDirs().length === preProfileScratch, 'an early Host failure left its private scratch behind')
    assert(
      readFileSync(join(scopeDir, 'host.log'), 'utf8').includes('qualification forced pre-profile failure'),
      'the Host did not fail before runProfile as requested',
    )
    trace('t15-preprofile-scratch', { before: preProfileScratch, after: scopeScratchDirs().length })

    // F1: the stale registry names a real killed-but-unreaped zombie. The
    // Client must classify it dead from /proc state Z + matching starttime and
    // start a replacement through the free kernel seat.
    const zombie = await makeZombie()
    writeRawPrivate(registryPath, { ...registry, hostPid: zombie.pid, hostStarttime: zombie.starttime })
    trace('t15-zombie', { pid: zombie.pid, state: 'Z', starttime: zombie.starttime })

    const c6 = new EntryProcess('client', entries.client, base)
    const c6Outcome = await waitForOutcome(c6, 'T15 restarted Host', 240_000)
    assert(c6Outcome.m4a0 === 'ready' && c6Outcome.transport === 'connected', `T15 Client did not connect to a new Host: ${JSON.stringify(c6Outcome)}`)
    assert(c6Outcome.host.instanceId !== hostReady.localHost.instanceId, 'T15 new Host reused the dead instance id')
    assert(c6Outcome.host.hostPid !== hostReady.localHost.hostPid, 'T15 new Host reused the dead PID')
    assert(c6Outcome.host.hostPid !== zombie.pid, 'T15 new Host reused the zombie PID')
    assert(c6Outcome.host.hostStarttime !== hostReady.localHost.hostStarttime, 'T15 new Host reused the dead starttime')
    assert(c6Outcome.host.hostStarttime !== zombie.starttime, 'T15 new Host reused the zombie starttime')
    assert(scopeScratchDirs().length === 2, 'T15 spawned Host scratch plus the stale SIGKILL scratch is not two directories')
    trace('t15-scratch-spawn', { afterSpawn: scopeScratchDirs().length })
    assertClientHostFacts(c6Outcome.host, readJson(registryPath), 'T15 new Client/registry')
    trackedProcesses.set(c6Outcome.host.hostPid, c6Outcome.host.hostStarttime)
    failpoint('spawned-host')
    const newOrigin = c6Outcome.host.origin
    const newLaunch = readJson(launchPath)
    const newToken = new URL(newLaunch.connectUrl).searchParams.get('token')
    assert(newToken !== null && newToken !== hostToken, 'T15 new Host reused the old launch token')
    const oldTokenConnect = await rawGet(newOrigin, `/connect?token=${encodeURIComponent(hostToken)}&interactions=answer`)
    assert(oldTokenConnect.status === 401, `T15 old token returned ${String(oldTokenConnect.status)}`)
    const oldCookieIdentity = await fetchStatus(`${newOrigin}/api/pi-tui.local-host`, { headers: { cookie: validCookie } })
    assert(oldCookieIdentity.status === 401, `T15 old Cookie returned ${String(oldCookieIdentity.status)}`)
    const hostLogPath = join(scopeDir, 'host.log')
    assert(existsSync(hostLogPath), 'T15 spawned Host did not write a private log')
    assert(modeOf(hostLogPath) === 0o600, 'T15 spawned Host log is not 0600')
    const hostLog = readFileSync(hostLogPath, 'utf8')
    assert(Buffer.byteLength(hostLog, 'utf8') <= HOST_LOG_LIMIT, 'T15 spawned Host log is unexpectedly large')
    assertNoSecret('T15 spawned Host log', hostLog, [hostToken, validCookie, newToken])
    const c6Exit = await c6.shutdown()
    assert(c6Exit.code === 0, `T15 new Client exit was ${JSON.stringify(c6Exit)}`)
    assert(alive(c6Outcome.host.hostPid), 'T15 new Host died on Client exit')
    const c7 = new EntryProcess('client', entries.client, base)
    const c7Outcome = await waitForOutcome(c7, 'T15 attach to active Host', 120_000)
    assert(c7Outcome.m4a0 === 'ready' && c7Outcome.transport === 'connected', `T15 attach did not connect: ${JSON.stringify(c7Outcome)}`)
    assertClientHostFacts(c7Outcome.host, c6Outcome.host, 'T15 attach')
    assert(scopeScratchDirs().length === 2, 'a new Client erased an active Host overlay scratch')
    trace('t15-scratch-attach', { afterAttach: scopeScratchDirs().length })
    const c7Exit = await c7.shutdown()
    assert(c7Exit.code === 0, `T15 attach exit was ${JSON.stringify(c7Exit)}`)
    assert(alive(c6Outcome.host.hostPid), 'T15 attach killed the new Host')
    trace('reconnect-new-host', {
      oldInstanceId: hostReady.localHost.instanceId,
      newInstanceId: c6Outcome.host.instanceId,
      oldPid: hostReady.localHost.hostPid,
      newPid: c6Outcome.host.hostPid,
      oldTokenRejected: oldTokenConnect.status,
      oldCookieRejected: oldCookieIdentity.status,
    })

    // Stop the spawned Host and prove no kernel seat or stale writer remains.
    killTracked(c6Outcome.host.hostPid, c6Outcome.host.hostStarttime, 'SIGTERM')
    if (!await waitGone(c6Outcome.host.hostPid, 20_000)) {
      killTracked(c6Outcome.host.hostPid, c6Outcome.host.hostStarttime, 'SIGKILL')
      await waitGone(c6Outcome.host.hostPid, 5_000)
    }
    assert(!alive(c6Outcome.host.hostPid), 'T17 spawned Host did not exit')
    assert(scopeScratchDirs().length === 1, 'the clean Host shutdown did not remove only its own scratch')
    trace('t15-scratch-clean', { afterCleanExit: scopeScratchDirs().length })

    // T19/R1: signal admission precedes discoverable publication. The Host is
    // held AFTER `instance.json` is committed but BEFORE it can report ready;
    // SIGTERM/SIGINT in that window must take the ordinary owner-governed
    // shutdown (official disposal + identity/scratch cleanup), never the
    // default signal exit, and never emit ready afterwards. The same signal is
    // repeated while still at the publication barrier AND while the completed
    // shutdown is held before admission release: both repeats must be observed
    // and ignored by the single stop intent, never default-terminate.
    const scopeSuffix = hostReady.localHost.scopeId.slice(0, 40)
    const r1BaselineScratch = new Set(scopeScratchDirs())
    for (const [signal, expectedCode] of [['SIGTERM', 0], ['SIGINT', 130]]) {
      const barrierPath = join(workDir, `r1-publish-barrier-${signal}`)
      const stopBarrierPath = join(workDir, `r1-stop-barrier-${signal}`)
      const r1Host = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_HOST_PUBLISH_BARRIER: barrierPath,
          SPLIT_PROCESS_HOST_STOP_BARRIER: stopBarrierPath,
        },
      })
      let r1Registry
      const barrierDeadline = Date.now() + 180_000
      while (Date.now() < barrierDeadline) {
        try {
          const candidate = readJson(registryPath)
          if (candidate.hostPid === r1Host.child.pid) {
            r1Registry = candidate
            break
          }
        } catch { /* the registry is not committed yet */ }
        if (r1Host.exited) {
          throw new SplitSmokeWaitError('PROCESS_EXITED', {
            code: 'REGISTRY_COMMIT_EXITED',
            waitLabel: `T19 ${signal}: the Host must stay alive until its registry commit`,
            processRole: r1Host.role,
            process: r1Host,
          })
        }
        await sleep(20)
      }
      assert(r1Registry !== undefined, `T19 ${signal}: the Host never committed a discoverable registry`)
      assert(existsSync(launchPath), `T19 ${signal}: launch material is missing at the registry commit`)
      assert(!r1Host.records.some(record => record.m4a0 === 'ready'), `T19 ${signal}: the Host reported ready while still held at the publication barrier`)
      r1Host.kill(signal)
      const stopRequested = await r1Host.waitFor(record => record.m4a0 === 'stop-requested', `T19 ${signal} admission`, 60_000)
      assert(
        stopRequested.signal === signal && stopRequested.phase === 'publication',
        `T19 ${signal}: unexpected admission record ${JSON.stringify(stopRequested)}`,
      )
      // Repeat the SAME signal while the Host is still paused after the
      // registry commit. A once-only handler would already be gone here and
      // this signal would default-terminate the process.
      r1Host.kill(signal)
      const publicationRepeat = await r1Host.waitFor(record => record.m4a0 === 'stop-repeat-ignored', `T19 ${signal} publication repeat`, 60_000)
      assert(
        publicationRepeat.signal === signal && publicationRepeat.phase === 'publication',
        `T19 ${signal}: unexpected publication repeat record ${JSON.stringify(publicationRepeat)}`,
      )
      assert(r1Host.records.filter(record => record.m4a0 === 'stop-requested').length === 1, `T19 ${signal}: more than one pending stop intent`)
      writeFileSync(barrierPath, 'release\n', { mode: 0o600 })
      const cleanup = await r1Host.waitFor(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure', `T19 ${signal} cleanup`, 60_000)
      assert(
        cleanup.m4a0 === 'cleanup' && cleanup.status === 'completed' && cleanup.phase === 'shutdown',
        `T19 ${signal}: cleanup was ${JSON.stringify(cleanup)}`,
      )
      assert(r1Host.records.filter(record => record.m4a0 === 'cleanup').length === 1, `T19 ${signal}: cleanup was not exactly once`)
      // Repeat the SAME signal once more while the completed shutdown is held
      // before admission release. It must still be observed and ignored.
      r1Host.kill(signal)
      const shutdownRepeat = await r1Host.waitFor(record => record.m4a0 === 'stop-repeat-ignored' && record.phase === 'shutdown', `T19 ${signal} shutdown repeat`, 60_000)
      assert(shutdownRepeat.signal === signal, `T19 ${signal}: unexpected shutdown repeat record ${JSON.stringify(shutdownRepeat)}`)
      assert(r1Host.records.filter(record => record.m4a0 === 'cleanup').length === 1, `T19 ${signal}: a repeat started a second cleanup`)
      writeFileSync(stopBarrierPath, 'release\n', { mode: 0o600 })
      const exit = await r1Host.waitForExit(60_000)
      assert(exit.code === expectedCode && exit.signal === null, `T19 ${signal} exit was ${JSON.stringify(exit)}`)
      assert(!r1Host.records.some(record => record.m4a0 === 'ready'), `T19 ${signal}: the Host emitted ready after a stop request`)
      assert(!r1Host.records.some(record => record.m4a0 === 'failure'), `T19 ${signal}: the Host reported a boot failure`)
      assert(!existsSync(registryPath), `T19 ${signal}: the registry survived the owner-governed shutdown`)
      assert(!existsSync(launchPath), `T19 ${signal}: launch material survived the owner-governed shutdown`)
      const remainingScratch = scopeScratchDirs()
      assert(
        remainingScratch.length === r1BaselineScratch.size
          && remainingScratch.every(name => r1BaselineScratch.has(name)),
        `T19 ${signal}: the Host's own scratch was not removed: ${JSON.stringify(remainingScratch)}`,
      )
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
      trace(`t19-${signal.toLowerCase()}`, {
        signal,
        exit: exit.code,
        cleanup: cleanup.status,
        readyEmitted: false,
        publicationRepeatIgnored: true,
        shutdownRepeatIgnored: true,
        stopIntents: 1,
        cleanupRecords: 1,
        registryRemoved: true,
        launchRemoved: true,
        scratchRemoved: true,
        hostSeatFree: true,
      })
    }

    // T19/R1b: the SAME stop-admission guarantee across the new asynchronous
    // first-liveness observation. The Host is held after publication while the
    // initial snapshot is in flight; a signal here must still own the process
    // and must never emit Ready after the observation returns.
    for (const [signal, expectedCode] of [['SIGTERM', 0], ['SIGINT', 130]]) {
      const livenessBarrierPath = join(workDir, `r1-liveness-barrier-${signal}`)
      const r1bHost = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_HOST_LIVENESS_BARRIER: livenessBarrierPath,
        },
      })
      const held = await r1bHost.waitFor(
        record => record.m4a0 === 'qualification' && record.op === 'liveness-barrier',
        `T19b ${signal} liveness barrier`,
        120_000,
      )
      assert(typeof held.pid === 'number' && held.pid > 0, `T19b ${signal}: the liveness barrier record has no PID`)
      assert(!r1bHost.records.some(record => record.m4a0 === 'ready'), `T19b ${signal}: Ready was published before the stop`)
      r1bHost.kill(signal)
      const stopRequested = await r1bHost.waitFor(record => record.m4a0 === 'stop-requested', `T19b ${signal} admission`, 60_000)
      assert(
        stopRequested.signal === signal && stopRequested.phase === 'running',
        `T19b ${signal}: unexpected admission record ${JSON.stringify(stopRequested)}`,
      )
      writeFileSync(livenessBarrierPath, 'release\n', { mode: 0o600 })
      const cleanup = await r1bHost.waitFor(record => record.m4a0 === 'cleanup' || record.m4a0 === 'cleanup-failure', `T19b ${signal} cleanup`, 60_000)
      assert(
        cleanup.m4a0 === 'cleanup' && cleanup.status === 'completed' && cleanup.phase === 'shutdown',
        `T19b ${signal}: cleanup was ${JSON.stringify(cleanup)}`,
      )
      const exit = await r1bHost.waitForExit(60_000)
      assert(exit.code === expectedCode && exit.signal === null, `T19b ${signal} exit was ${JSON.stringify(exit)}`)
      assert(!r1bHost.records.some(record => record.m4a0 === 'ready'), `T19b ${signal}: the Host emitted Ready after a stop request`)
      assert(!r1bHost.records.some(record => record.m4a0 === 'failure'), `T19b ${signal}: the Host reported a boot failure`)
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
      trace(`t19b-${signal.toLowerCase()}`, { signal, exit: exit.code, cleanup: cleanup.status, readyEmitted: false, livenessBarrier: true })
    }

    // T20: a forced exit after this Host created its scratch and BEFORE
    // runProfile installs the launcher's signal handlers bypasses the async
    // finally. The synchronous exit mirror must remove only this process's
    // own scratch; the Host seat is released by the OS and no profile boots.
    {
      const earlyBaselineScratch = new Set(scopeScratchDirs())
      const earlyExit = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_EARLY_EXIT: '1' },
      })
      const earlyExitResult = await earlyExit.waitForExit(30_000)
      assert(
        earlyExitResult.code === 1 && earlyExitResult.signal === null,
        `T20 early forced exit was ${JSON.stringify(earlyExitResult)}`,
      )
      assert(!earlyExit.records.some(record => record.m4a0 === 'profile-booted'), 'T20 exited after profile boot')
      const earlyRemaining = scopeScratchDirs()
      assert(
        earlyRemaining.length === earlyBaselineScratch.size
          && earlyRemaining.every(name => earlyBaselineScratch.has(name)),
        `T20 early forced exit leaked its own scratch: ${JSON.stringify(earlyRemaining)}`,
      )
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
      trace('t20-early-exit-scratch', {
        exit: earlyExitResult.code,
        profileBooted: false,
        scratchRemoved: true,
        hostSeatFree: true,
      })
    }

    await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
    await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 10_000)
    trace('seats-free', { hostSeat: 'free', clientSeat: 'free' })

    // ── Real-surface qualification (T27–T39) ─────────────────────────────
    // Everything above proves the authenticated control/data link. This
    // block starts a DEDICATED Host with the test-only offline LLM row and
    // drives the ONE real tty surface Client over the SAME authenticated Host:
    // create/open/switch Sessions and prove a real Host commit reaches the
    // painted transcript, then exit/kill/reconnect without touching the Host.
    // T34 (writer pre-dispatch stop), T35 post-write ACK drop and T36 (private
    // PiFile/terminal-progress business reads) run before the continuity cases.
    // The private PiFile business reads (T36) resolve files in the Host
    // WORKSPACE, which is the installed profile: `t36notes.md` is inside the
    // official provider's search tree, and `dist/` is a directory the OFFICIAL
    // provider EXCLUDES while the Host explicit-path scanner still serves it —
    // that difference makes the scoped witness discriminating. Both are created
    // BEFORE the Host starts, so the official workspace index sees them.
    writeFileSync(join(profileDir, 't36notes.md'), 'private file reference\n', { mode: 0o600 })
    mkdirSync(join(profileDir, 'dist'), { recursive: true })
    writeFileSync(join(profileDir, 'dist', 't36only-scoped.js'), 'x\n', { mode: 0o600 })
    // The `~/` shorthand must expand to the HOST's home — the isolated home in
    // this lane, never the operator's. One known file there turns the absolute
    // answer into a real sink instead of a vacuous "some absolute path".
    writeFileSync(join(home, 't36home-note.md'), 'private home reference\n', { mode: 0o600 })
    const surfaceHost = new EntryProcess('host', entries.host, base)
    const surfaceHostReady = await surfaceHost.waitFor(record => record.m4a0 === 'ready', 'T27 surface Host ready', 180_000)
    const surfaceHostPid = surfaceHostReady.pid
    const surfaceHostFacts = surfaceHostReady.localHost
    assert(surfaceHostReady.entries?.some(entry => entry.id === 'm4b2s-stub-llm' && entry.state === 'active') === true,
      'T30 the test-only offline Host LLM row is not active')
    assert(surfaceHostReady.localHost?.hostPid === surfaceHostPid, 'T27 Host ready PID mismatch')
    const surfaceClients = []
    let surfaceHostClosed = false
    let sessionA
    let sessionB
    try {
      // T27/T28: ONE real surface over the SAME authenticated connection; sessionless
      // Welcome painted on the real pty, no JSON on the terminal.
      const c1 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF: '1' },
      })
      surfaceClients.push(c1)
      const c1Ready = await c1.waitFor(record => record.m4a0 === 'ready', 'T27 surface Client ready', 180_000)
      assert(c1Ready.processRole === 'client', 'T27 surface Client role mismatch')
      assert(c1Ready.pid !== surfaceHostPid, 'T27 the surface Client and the Host must be distinct OS PIDs')
      assert(c1Ready.surfaceMounted === true, 'T27 the physical surface did not mount')
      assert(c1Ready.sessionOpen === false, 'T28 a sessionless surface must not claim an open Session')
      assert(c1Ready.transport === 'connected' && c1Ready.sessionsListPhase === 'ready',
        'T27 the official Client Session list is not ready')
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(c1Ready.owners?.[owner] === 1, `T27 expected exactly one ${owner} owner`)
      }
      assert(c1Ready.privateNamespaces === 2, 'T27 expected exactly the two private pi-tui namespaces')
      assertClientHostFacts(c1Ready.host, surfaceHostFacts, 'T27 surface Client')
      await c1.waitForScreen('type a message to start a session', 'T28 sessionless Welcome')
      trace('t27-t28', {
        hostPid: c1Ready.host.hostPid,
        clientPid: c1Ready.pid,
        sessionOpen: false,
        owners: c1Ready.owners,
        privateNamespaces: c1Ready.privateNamespaces,
        welcome: 'painted',
      })

      // T29/T30: real input -> official beginSubmission -> Host commit ->
      // durable readback -> retained presentation (the stub answer is produced
      // by the Host's official LLM adapter, never by a Client fake).
      c1.send('session a\r')
      const openedA = await c1.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true,
        'T29 Session open',
        120_000,
      )
      assert(typeof openedA.openSessionId === 'string' && openedA.openSessionId.startsWith('session-'),
        'T29 no official Session id was opened')
      sessionA = openedA.openSessionId
      await c1.waitForScreen('session a', 'T29 user message')
      await c1.waitForScreen('stub answer', 'T30 assistant answer')
      // T30's durable half: the Host's authoritative session log must carry
      // exactly ONE accepted human write and the assistant message; the painted
      // echo alone is not accepted-write evidence.
      const durableA = await (async () => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const events = hostSessionEvents(dshHome, sessionA)
          if (events !== undefined) {
            const users = hostUserTexts(events).filter(message => message === 'session a').length
            const assistant = hostAssistantHasText(events, 'stub answer')
            if (users === 1 && assistant) return { users, assistant }
          }
          await sleep(100)
        }
        return undefined
      })()
      assert(durableA !== undefined,
        'T30 the Host durable log did not carry exactly one accepted "session a" write and its assistant message')
      trace('t29-t30', {
        sessionId: sessionA,
        userMessage: 'painted',
        assistant: 'painted',
        hostUserMessages: durableA.users,
        hostAssistant: durableA.assistant,
      })

      // T31: Session switch A -> B -> A, each with retained-window hydration.
      c1.send('/new\r')
      const openedB = await c1.waitFor(
        record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId !== sessionA,
        'T31 new Session',
        120_000,
      )
      sessionB = openedB.openSessionId
      assert(sessionB !== sessionA, 'T31 /new did not open a different Session')
      c1.send('session b\r')
      await c1.waitForScreen('session b', 'T31 Session B user message')
      await c1.waitForScreen('stub answer', 'T31 Session B assistant answer')
      c1.send(`/resume ${sessionA}\r`)
      await c1.waitFor(
        record => record.m4b2s === 'surface-status' && record.openSessionId === sessionA,
        'T31 switch back to A',
        120_000,
      )
      await c1.waitForScreen('session a', 'T31 Session A re-hydration')
      c1.send(`/resume ${sessionB}\r`)
      await c1.waitFor(
        record => record.m4b2s === 'surface-status' && record.openSessionId === sessionB,
        'T31 switch to B',
        120_000,
      )
      await c1.waitForScreen('session b', 'T31 Session B re-hydration')
      c1.send(`/resume ${sessionA}\r`)
      await c1.waitFor(
        record => record.m4b2s === 'surface-status' && record.openSessionId === sessionA,
        'T31 switch A -> B -> A',
        120_000,
      )
      await c1.waitForScreen('session a', 'T31 final Session A hydration')
      trace('t31', { first: sessionA, second: sessionB, switches: 'A->B->A' })

      // T36: the private PiFile + terminal-progress RPCs through the ALREADY
      // mounted Domain namespaces on the SAME Client Context (no second
      // contribution, no Host service).
      c1.signalBusiness('SIGUSR2')
      const privateProof = await c1.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'private-rpc-proof',
        'T36 private RPC proof',
        60_000,
      )
      assert(privateProof.error === undefined, `T36 private RPC proof failed: ${JSON.stringify(privateProof)}`)
      assert(privateProof.fileOk === true, 'T36 the private PiFile RPC did not succeed')
      assert(typeof privateProof.fileKind === 'string', 'T36 the private PiFile RPC returned no business kind')
      assert(privateProof.terminalKind === 'snapshot', 'T36 the terminal-progress watch did not open with a snapshot')
      assert(privateProof.owners?.sessions === 1 && privateProof.privateNamespaces === 2,
        'T36 the private proof observed a duplicate/absent Domain owner')
      // Migrated from the retired built-bundle smoke: the private endpoint's
      // Host workspace semantics over the REAL authenticated split wire.
      assert(privateProof.bareOfficial === true,
        `T36 the bare query did not reach the official Host provider (observed ${String(privateProof.bareCount)} items)`)
      assert(privateProof.officialEmpty === true,
        'T36 an authoritative official [] did not stay empty')
      assert(privateProof.scopedOk === true && privateProof.scopedHostScanner === true,
        `T36 the explicit-path scope did not reach the Host scanner (observed ${String(privateProof.scopedCount)} items)`)
      assert(privateProof.homeAbsolute === true,
        'T36 the HOME shorthand did not answer absolute Host paths')
      trace('t36', {
        sessionId: privateProof.sessionId,
        fileOk: privateProof.fileOk,
        fileKind: privateProof.fileKind,
        bareOfficial: privateProof.bareOfficial,
        officialEmpty: privateProof.officialEmpty,
        scopedHostScanner: privateProof.scopedHostScanner,
        homeAbsolute: privateProof.homeAbsolute,
        terminalKind: privateProof.terminalKind,
        owners: privateProof.owners,
      })

      // T32/T38: normal surface exit releases every Client-owned resource and
      // leaves the Host PID/instance/build untouched.
      c1.send('/exit\r')
      const c1Exit = await c1.waitForExit(60_000)
      assert(c1Exit.code === 0, `T32 surface Client exit was ${JSON.stringify(c1Exit)}`)
      await c1.waitFor(record => record.m4b2s === 'client-closed', 'T38 client-closed record', 30_000)
      const closed = c1.records.find(record => record.m4b2s === 'client-closed')
      for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
        assert(closed.owners?.[owner] === 0, `T38 ${owner} survived the Client exit`)
      }
      assert(closed.sessionOpen === false && closed.surfaceMounted === false,
        'T38 the Client still claims an open surface/Session after exit')
      assert(closed.activeWrappers === 0 && closed.liveSockets === 0,
        'T38 the Client still owns transport wrappers/sockets after exit')
      assert(alive(surfaceHostPid), 'T32 the Host died on the normal surface exit')
      const registryAfterExit = readJson(join(scopeDir, 'instance.json'))
      assert(registryAfterExit.instanceId === surfaceHostFacts.instanceId, 'T32 the Host instance changed on the Client exit')
      assert(registryAfterExit.buildId === surfaceHostFacts.buildId, 'T32 the Host build changed on the Client exit')
      trace('t32-t38', {
        clientExit: c1Exit.code,
        hostPid: surfaceHostPid,
        hostInstanceId: surfaceHostFacts.instanceId,
        owners: closed.owners,
        wrappers: closed.activeWrappers,
        sockets: closed.liveSockets,
      })
      await c1.dispose()

      // T41/T42: a SIGTERM during the assembly must be owned by ONE coordinator:
      // no ready, no duplicate cleanup, the Client seat immediately reusable,
      // and the Host untouched. Two deterministic stages are held: after the
      // Domain readiness and after the runner fiber mount/before surface ready.
      for (const [stage, traceName] of [['domain', 't41'], ['surface', 't42']]) {
        const barrier = join(workDir, `${traceName}-assembly-barrier`)
        rmSync(barrier, { force: true })
        const stopping = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: {
            ...base.env,
            SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY: `${stage}@${barrier}`,
          },
        })
        surfaceClients.push(stopping)
        const held = await stopping.waitFor(
          record => record.m4b2s === 'qualification' && record.op === 'assembly-hold' && record.stage === stage,
          `${traceName} ${stage} assembly hold`,
          180_000,
        )
        stopping.signalBusiness('SIGTERM')
        // Ordering, not sleep: the barrier must be released only AFTER the
        // Client ADMITTED the signal (its own `signal` record). Signalling and
        // releasing back-to-back races the OS signal delivery against the
        // hold's 20ms poll — the assembly could legally finish and publish a
        // real `ready` before the signal was ever admitted, which is a
        // different (correct) outcome than this case's claim. T59 uses the
        // same admitted-signal gate for its mid-HMR stop.
        await stopping.waitFor(
          record => record.m4a0 === 'signal' && record.signal === 'SIGTERM',
          `${traceName} ${stage} stop signal admitted`,
          30_000,
        )
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        const stopped = await stopping.waitForExit(60_000)
        assert(stopped.code === 0, `${traceName} ${stage} stop exit was ${JSON.stringify(stopped)}`)
        assert(!stopping.records.some(record => record.m4a0 === 'ready'),
          `${traceName} ${stage} stop still published a ready surface`)
        assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'),
          `${traceName} ${stage} stop reported a duplicate/failed cleanup`)
        await stopping.dispose()
        // The kernel Client seat is free immediately: a NEW Client acquires it
        // and reaches a real surface over the SAME Host.
        const reusable = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        surfaceClients.push(reusable)
        const reusableReady = await reusable.waitFor(record => record.m4a0 === 'ready', `${traceName} reusable Client ready`, 180_000)
        assert(reusableReady.surfaceMounted === true, `${traceName} the reusable Client did not mount`)
        assert(alive(surfaceHostPid), `${traceName} the Host died on the startup stop`)
        const reusableInstance = readJson(join(scopeDir, 'instance.json'))
        assert(reusableInstance.instanceId === surfaceHostFacts.instanceId,
          `${traceName} the Host instance changed on the startup stop`)
        reusable.send('/exit\r')
        const reusableExit = await reusable.waitForExit(60_000)
        assert(reusableExit.code === 0, `${traceName} reusable Client exit was ${JSON.stringify(reusableExit)}`)
        await reusable.dispose()
        trace(traceName, {
          stage,
          heldAt: held.stage,
          readyEmitted: false,
          cleanupFailures: 0,
          seatReusable: true,
          hostAlive: true,
        })
      }

      // T41-gate: a SIGTERM while the REAL Cordis Loader gate is still pending
      // must enter the ONE stop coordinator before any Gateway start. The
      // process must exit cleanly, release the seat, leave no fake ready and
      // keep the Host alive; the same Host then accepts a fresh Client.
      {
        const gateBarrier = join(workDir, 't41-gate-barrier')
        rmSync(gateBarrier, { force: true })
        const gateStopping = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE: gateBarrier },
        })
        surfaceClients.push(gateStopping)
        const gateHeld = await gateStopping.waitFor(
          record => record.m4b2s === 'qualification' && record.op === 'startup-gate-hold' && record.stage === 'loader-gate',
          'T41-gate loader gate hold',
          180_000,
        )
        gateStopping.signalBusiness('SIGTERM')
        writeFileSync(gateBarrier, 'release\n', { mode: 0o600 })
        const gateExit = await gateStopping.waitForExit(60_000)
        assert(gateExit.code === 0, `T41-gate stop exit was ${JSON.stringify(gateExit)}`)
        assert(!gateStopping.records.some(record => record.m4a0 === 'ready'),
          'T41-gate stop still published a ready surface')
        assert(!gateStopping.records.some(record => record.m4a0 === 'cleanup-failure'),
          'T41-gate stop reported a cleanup failure')
        assert(!gateStopping.records.some(record => record.m4a0 === 'transport-ready'),
          'T41-gate stop allowed transport readiness after the signal')
        await gateStopping.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        assert(alive(surfaceHostPid), 'T41-gate the Host died on the gate stop')
        const gateReusable = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        surfaceClients.push(gateReusable)
        const gateReusableReady = await gateReusable.waitFor(record => record.m4a0 === 'ready', 'T41-gate reusable Client ready', 180_000)
        assert(gateReusableReady.surfaceMounted === true, 'T41-gate the reusable Client did not mount')
        gateReusable.send('/exit\r')
        const gateReusableExit = await gateReusable.waitForExit(60_000)
        assert(gateReusableExit.code === 0, `T41-gate reusable Client exit was ${JSON.stringify(gateReusableExit)}`)
        await gateReusable.dispose()
        trace('t41-gate', {
          heldAt: gateHeld.stage,
          readyEmitted: false,
          transportReady: false,
          cleanupFailures: 0,
          seatReusable: true,
          hostAlive: true,
        })
      }

      // T43: a signal in the PRE-STARTUP assignment window (after the lazy
      // client-bootstrap import, before `startupPromise` exists) must wait for
      // the ONE startup gate and never dispose the root underneath a late
      // `startLocalClient` call.
      const preStartBarrier = join(workDir, 't43-pre-start-barrier')
      rmSync(preStartBarrier, { force: true })
      const preStart = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START: preStartBarrier,
        },
      })
      surfaceClients.push(preStart)
      await preStart.waitFor(
        record => record.m4a0 === 'qualification' && record.op === 'before-start-hold',
        'T43 pre-startup assignment hold',
        180_000,
      )
      preStart.signalBusiness('SIGTERM')
      writeFileSync(preStartBarrier, 'release\n', { mode: 0o600 })
      const preStartExit = await preStart.waitForExit(60_000)
      assert(preStartExit.code === 0, `T43 pre-startup stop exit was ${JSON.stringify(preStartExit)}`)
      assert(!preStart.records.some(record => record.m4a0 === 'ready'),
        'T43 pre-startup stop still published a ready surface')
      assert(!preStart.records.some(record => record.m4a0 === 'cleanup-failure'),
        'T43 pre-startup stop reported a duplicate/failed cleanup')
      await preStart.dispose()
      const afterPreStart = new SurfaceEntryProcess(entries.client, { ...base, workDir })
      surfaceClients.push(afterPreStart)
      const afterPreStartReady = await afterPreStart.waitFor(record => record.m4a0 === 'ready', 'T43 reusable Client ready', 180_000)
      assert(afterPreStartReady.surfaceMounted === true, 'T43 the reusable Client did not mount')
      assert(alive(surfaceHostPid), 'T43 the Host died on the pre-startup stop')
      const afterPreStartInstance = readJson(join(scopeDir, 'instance.json'))
      assert(afterPreStartInstance.instanceId === surfaceHostFacts.instanceId,
        'T43 the Host instance changed on the pre-startup stop')
      afterPreStart.send('/exit\r')
      const afterPreStartExit = await afterPreStart.waitForExit(60_000)
      assert(afterPreStartExit.code === 0, `T43 reusable Client exit was ${JSON.stringify(afterPreStartExit)}`)
      await afterPreStart.dispose()
      trace('t43', {
        stage: 'pre-startup-assignment',
        readyEmitted: false,
        cleanupFailures: 0,
        seatReusable: true,
        hostAlive: true,
      })

      // T34: close the writer's pre-dispatch admission while a REAL
      // serialization barrier holds the write. The writer must return
      // not-dispatched, the draft must return to the composer, and the Host must
      // never see the prompt. The signal only closes the SAME admission gate the
      // surface-stop path owns; the surface stays mounted so the draft is visible.
      const holdBarrier = join(workDir, 't34-serializer-barrier')
      rmSync(holdBarrier, { force: true })
      const cHold = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_SESSION: sessionA,
          SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: holdBarrier,
        },
      })
      surfaceClients.push(cHold)
      const cHoldReady = await cHold.waitFor(record => record.m4a0 === 'ready', 'T34 hold Client ready', 180_000)
      assert(cHoldReady.sessionOpen === true && cHoldReady.openSessionId === sessionA,
        'T34 the hold Client did not open the retained Session')
      cHold.send('holdme\r')
      await cHold.waitForScreen('holdme', 'T34 pending echo', 60_000)
      cHold.signalBusiness('SIGUSR2')
      await cHold.waitFor(
        record => record.m4b2s === 'qualification' && record.op === 'stop-surface-admission',
        'T34 admission stop',
        30_000,
      )
      writeFileSync(holdBarrier, 'release\n', { mode: 0o600 })
      await cHold.waitForComposerDraft('holdme', 60_000)
      // The writer settled BEFORE dispatch (the admission record and the
      // restored composer draft are both observed). One bounded observation
      // window then proves the Host received nothing; a real dispatch would
      // persist immediately.
      await sleep(1_000)
      const holdEvents = hostSessionEvents(dshHome, sessionA)
      assert(holdEvents !== undefined, 'T34 no Host Session log is readable')
      assert(hostUserTexts(holdEvents).filter(message => message === 'holdme').length === 0,
        'T34 the refused pre-dispatch write still reached the Host')
      cHold.signalBusiness('SIGTERM')
      const holdExit = await cHold.waitForExit(60_000)
      assert(holdExit.code === 0, `T34 hold Client exit was ${JSON.stringify(holdExit)}`)
      await cHold.dispose()
      trace('t34', { preDispatch: 'not dispatched', hostWrites: 0, draft: 'restored' })

      // T35: the Host receives and commits ONE prompt, but the response ACK is
      // dropped after the write. The Client must report the write as
      // indeterminate (never committed), never replay it, and the NEXT Client
      // must reconcile from the Host's durable log.
      const c4 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: {
          ...base.env,
          SPLIT_PROCESS_CLIENT_SESSION: sessionA,
          SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1',
        },
      })
      surfaceClients.push(c4)
      const c4Ready = await c4.waitFor(record => record.m4a0 === 'ready', 'T35 ACK-drop Client ready', 180_000)
      assert(c4Ready.sessionOpen === true && c4Ready.openSessionId === sessionA,
        'T35 the ACK-drop Client did not open the retained Session')
      c4.send('ackdrop\r')
      await c4.waitForScreen('indeterminate', 'T35 indeterminate notice', 120_000)
      const committedAckdrop = async (expected) => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const events = hostSessionEvents(dshHome, sessionA)
          if (events !== undefined) {
            const count = hostUserTexts(events).filter(message => message === 'ackdrop').length
            if (count >= expected) return count
          }
          await sleep(100)
        }
        return undefined
      }
      const hostCommits = await committedAckdrop(1)
      assert(hostCommits === 1,
        `T35 expected exactly ONE Host-committed ackdrop message, got ${String(hostCommits)}`)
      c4.signalBusiness('SIGTERM')
      const c4Exit = await c4.waitForExit(60_000)
      assert(c4Exit.code === 0, `T35 ACK-drop Client exit was ${JSON.stringify(c4Exit)}`)
      await c4.dispose()

      const c5 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
      })
      surfaceClients.push(c5)
      const c5Ready = await c5.waitFor(record => record.m4a0 === 'ready', 'T35 reconciliation Client ready', 180_000)
      assert(c5Ready.sessionOpen === true && c5Ready.openSessionId === sessionA,
        'T35 the reconciliation Client did not open the retained Session')
      await c5.waitForScreen('ackdrop', 'T35 reconciled Host log')
      await sleep(500)
      const reconciledEvents = hostSessionEvents(dshHome, sessionA)
      assert(reconciledEvents !== undefined, 'T35 no persisted Host Session log is readable')
      assert(hostUserTexts(reconciledEvents).filter(message => message === 'ackdrop').length === 1,
        'T35 the next Client replayed the indeterminate prompt instead of reconciling the Host log')
      c5.send('/exit\r')
      const c5Exit = await c5.waitForExit(60_000)
      assert(c5Exit.code === 0, `T35 reconciliation Client exit was ${JSON.stringify(c5Exit)}`)
      await c5.dispose()
      assert(alive(surfaceHostPid), 'T35 the Host died on the ACK-drop flow')
      trace('t35', { hostCommits: 1, indeterminate: 'painted', replayed: false, reconcile: 'Host log' })

      // T29 resume + T33 SIGKILL survival: a NEW Client reads the committed
      // Session; killing it leaves the same Host instance alive; a THIRD Client
      // reads the SAME committed data again.
      const c2 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
      })
      surfaceClients.push(c2)
      const c2Ready = await c2.waitFor(record => record.m4a0 === 'ready', 'T29 resume Client ready', 180_000)
      assert(c2Ready.sessionOpen === true && c2Ready.openSessionId === sessionA,
        'T29 the explicit --session resume did not open the exact retained Session')
      await c2.waitForScreen('session a', 'T29 retained user message')
      await c2.waitForScreen('stub answer', 'T30 retained assistant answer')
      assertClientHostFacts(c2Ready.host, surfaceHostFacts, 'T29 C2')
      const c2Pid = c2Ready.pid
      c2.signalBusiness('SIGKILL')
      for (let attempt = 0; attempt < 200 && alive(c2Pid); attempt += 1) await sleep(25)
      assert(!alive(c2Pid), 'T33 the surface Client survived SIGKILL')
      assert(alive(surfaceHostPid), 'T33 the Host died on Client SIGKILL')
      await c2.dispose()

      const c3 = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_SESSION: sessionA },
      })
      surfaceClients.push(c3)
      const c3Ready = await c3.waitFor(record => record.m4a0 === 'ready', 'T33 post-kill Client ready', 180_000)
      assert(c3Ready.sessionOpen === true && c3Ready.openSessionId === sessionA,
        'T33 the post-SIGKILL Client did not re-open the committed Session')
      await c3.waitForScreen('session a', 'T33 committed readback after SIGKILL')
      assertClientHostFacts(c3Ready.host, surfaceHostFacts, 'T33 C3')
      trace('t33', { killedClient: c2Pid, resumedClient: c3Ready.pid, hostAlive: true, sessionId: sessionA })

      // T37: one physical mux drop -> official generation rollover -> the
      // retained main view is re-adopted and the transcript re-hydrates.
      const generationBefore = c3Ready.generationId
      c3.signalBusiness('SIGUSR1')
      const rolled = await c3.waitFor(
        record => record.m4b2s === 'surface-status'
          && typeof record.generationId === 'number'
          && record.generationId !== generationBefore
          && record.sessionOpen === true,
        'T37 connection generation rollover',
        120_000,
      )
      assert(rolled.openSessionId === sessionA, 'T37 the rollover lost the retained Session')
      await c3.waitForScreen('session a', 'T37 retained transcript after reconnect')
      assert(alive(surfaceHostPid), 'T37 the Host died on the mux rollover')
      assertClientHostFacts(c3Ready.host, surfaceHostFacts, 'T37 C3')
      trace('t37', { generationBefore, generationAfter: rolled.generationId, sessionOpen: true, hostAlive: true })

      c3.send('/exit\r')
      const c3Exit = await c3.waitForExit(60_000)
      assert(c3Exit.code === 0, `T37 surface Client exit was ${JSON.stringify(c3Exit)}`)
      assert(alive(surfaceHostPid), 'T37 the Host died on the Client exit')
      await c3.dispose()

      // T61: ONE write parked in the REAL prompt serializer while the official
      // Connection generation is replaced by a physical mux drop. The stale
      // captured generation must not dispatch (Host durable log: zero
      // occurrences, no `indeterminate` notice), the draft returns exactly once,
      // and a NEW write on the rolled-over generation must commit exactly once —
      // the fence refuses the superseded write without poisoning the carrier.
      {
        const barrier = join(workDir, 't61-serializer-barrier')
        rmSync(barrier, { force: true })
        const staleToken = 't61-stale-generation'
        const liveToken = 't61-live-generation'
        const stalePriors = hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
          .filter(text => text === staleToken).length
        assert(stalePriors === 0, 'T61 the stale token already exists in the Host durable log')
        const parked = new SurfaceEntryProcess(entries.client, {
          ...base,
          workDir,
          env: {
            ...base.env,
            SPLIT_PROCESS_CLIENT_SESSION: sessionA,
            SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE: barrier,
          },
        })
        surfaceClients.push(parked)
        const parkedReady = await parked.waitFor(record => record.m4a0 === 'ready', 'T61 parked Client ready', 180_000)
        assert(parkedReady.sessionOpen === true && parkedReady.openSessionId === sessionA,
          'T61 the parked Client did not open the retained Session')
        const generationBefore = parkedReady.generationId
        assert(typeof generationBefore === 'number', 'T61 the Client never observed an official transport generation')
        parked.send(`${staleToken}\r`)
        // The write really reached the serializer (not merely "Enter was sent").
        const heldAt = await parked.waitFor(
          record => record.m4b2s === 'qualification' && record.op === 'serialize-held',
          'T61 serializer armed',
          60_000,
        )
        assert(Number.isInteger(heldAt.revision), 'T61 the serializer hold did not name the pinned revision')
        // ONE physical mux drop: the official Connection replaces the generation
        // while the write is still parked.
        parked.signalBusiness('SIGUSR1')
        const rolledOver = await parked.waitFor(
          record => record.m4b2s === 'surface-status'
            && typeof record.generationId === 'number'
            && record.generationId !== generationBefore
            && record.sessionOpen === true
            && record.openSessionId === sessionA,
          'T61 generation rollover',
          120_000,
        )
        assert(alive(surfaceHostPid), 'T61 the Host died on the mux rollover')
        assertClientHostFacts(rolledOver.host, surfaceHostFacts, 'T61 after rollover')
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        await parked.waitForComposerDraft(staleToken, 60_000)
        // The restored draft IS the writer's own settlement: the outcome is final
        // before the composer paints it, so no observation window is needed here.
        assert(!(await parked.viewport()).join('\n').includes('indeterminate'),
          'T61 the not-dispatched write was reported as indeterminate')
        // Restored EXACTLY once: the composer holds the token once, not twice.
        const restoredComposer = await parked.composerText()
        assert(restoredComposer !== undefined, 'T61 the composer disappeared after the refusal')
        const restoredOccurrences = restoredComposer.split(staleToken).length - 1
        assert(restoredOccurrences === 1,
          `T61 the draft was restored ${String(restoredOccurrences)} times, expected exactly once`)
        // Same Client process, CURRENT generation: a fresh prompt must commit.
        await parked.clearComposerDraft(staleToken)
        parked.send(`${liveToken}\r`)
        const liveCommit = await (async () => {
          const deadline = Date.now() + 120_000
          while (Date.now() < deadline) {
            const texts = hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
            const count = texts.filter(text => text === liveToken).length
            if (count >= 1) return count
            await sleep(100)
          }
          return 0
        })()
        assert(liveCommit === 1, `T61 expected exactly ONE Host commit on the new generation, got ${String(liveCommit)}`)
        // Ordering witness, not a timer: the new generation's turn ENDS after the
        // stale refusal, and the Host durable log still carries zero stale
        // writes — a dispatched superseded write would be ordered before it.
        await waitForHostSessionEvent(dshHome, sessionA, event => event.type === 'turn/end', 'T61 new-generation turn/end', 120_000)
        assert(hostUserTexts(hostSessionEvents(dshHome, sessionA) ?? [])
          .filter(text => text === staleToken).length === 0,
        'T61 the superseded write was dispatched or replayed')
        await parked.waitForScreen('stub answer', 'T61 new-generation answer')
        assert(alive(surfaceHostPid), 'T61 the Host died on the new-generation write')
        // The surface section predates the C1 helpers, so this case uses the
        // same inline exit idiom as T29/T31/T33/T37 above.
        parked.send('/exit\r')
        const parkedExit = await parked.waitForExit(60_000)
        assert(parkedExit.code === 0 && parkedExit.signal === null,
          `T61 parked Client exit was ${JSON.stringify(parkedExit)}`)
        await parked.dispose()
        trace('t61', {
          oldGeneration: generationBefore,
          newGeneration: rolledOver.generationId,
          source: 'real-websocket-drop',
          staleWrite: 'not-dispatched',
          oldHostWrites: 0,
          newHostWrites: 1,
          draftRestoredOnce: true,
          hostIdentityKept: true,
        })
      }

      // T39: a missing official Client Domain module means NO surface ready;
      // the failure is loud and the Host stays alive. (The Host-side missing
      // Session row is T26b and still runs above.)
      const sessionControllerClient = createRequire(anchor).resolve('@deepseek-ai/dsh-api-session-controller/client')
      renameSync(sessionControllerClient, `${sessionControllerClient}.missing`)
      let missingDomain
      try {
        missingDomain = new SurfaceEntryProcess(entries.client, { ...base, workDir })
        surfaceClients.push(missingDomain)
        const failure = await missingDomain.waitFor(record => record.m4a0 === 'failure', 'T39 missing Client Domain module', 120_000)
        assert(!missingDomain.records.some(record => record.m4a0 === 'ready'),
          'T39 a missing official Client Domain module still emitted ready')
        assert(missingDomain.records.find(record => record.m4a0 === 'ready') === undefined,
          'T39 a missing official Client Domain module published a surface')
        assert(/Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT|not found/iu.test(JSON.stringify(failure)),
          `T39 unexpected missing-module error: ${JSON.stringify(failure.error ?? failure)}`)
        assert(alive(surfaceHostPid), 'T39 the missing Client Domain module killed the Host')
        trace('t39', { readyEmitted: false, failure: 'module-missing', hostAlive: true })
      } finally {
        renameSync(`${sessionControllerClient}.missing`, sessionControllerClient)
        await missingDomain?.dispose()
      }

      await surfaceHost.shutdown()
      surfaceHostClosed = true
      assert(!alive(surfaceHostPid), 'T40 the surface Host survived its owner-governed shutdown')
      assert(!existsSync(join(scopeDir, 'instance.json')), 'T40 the Host registry survived its owner-governed shutdown')
      assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
        'T40 the candidate artifact changed during qualification')
      trace('t40', {
        candidate: basename(tarball),
        sha256: candidateSha256,
        dshVersion: targetDshVersion,
        directHelp: 'pass',
        t01t26: 'pass (T26a row-disabled + real artifact-absent; T26b official row; T26 no-cookie)',
        surface: 'T27-T39 + T41/T42/T43 pass',
      })

    // ── Continuity / interactions / Client-only HMR (T44–T60) ─────────────
    // Each scenario starts its OWN Host (one `C1_SCENARIO` per Host process)
    // and records its facts through the isolated fixture. The Client processes
    // are real PTY surfaces over the official authenticated transport.
    const c1Work = writeC1WorkFixture(profileDir, workDir)
    const c1Hosts = []
    const c1Clients = []
    const c1WorkRoot = label => {
      const root = join(workDir, `c1-${label}`)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      return root
    }
    /**
     * The `job` scenarios' release barrier must be visible INSIDE the Job's
     * workspace-write sandbox. bwrap mounts an ephemeral `/tmp` there and
     * binds only the session workspace, which is the installed profile; a
     * barrier under the smoke work dir (also `/tmp`) would be invisible and
     * the Job could never settle. The profile is still inside the isolated
     * OS temp work dir, not the checkout.
     */
    const c1JobWorkRoot = label => {
      const root = join(profileDir, `c1-${label}`)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      return root
    }
    const startC1Host = async (scenario, label, extraEnv = {}, workRoot = c1WorkRoot(label)) => {
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
      const host = new EntryProcess('host', entries.host, {
        ...base,
        env: {
          ...base.env,
          SPLIT_PROCESS_EXTRA_PATCH: c1Work.patchPath,
          C1_SCENARIO: scenario,
          C1_WORK_ROOT: workRoot,
          ...extraEnv,
        },
      })
      c1Hosts.push(host)
      const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 180_000)
      return { host, ready, workRoot }
    }
    const stopC1Host = async host => {
      if (host.exited) return
      try { await host.shutdown() } catch { /* the global backstop kills leftovers */ }
    }
    const startC1Client = async (label, extraEnv = {}) => {
      await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
      const client = new SurfaceEntryProcess(entries.client, {
        ...base,
        workDir,
        env: { ...base.env, ...extraEnv },
      })
      c1Clients.push(client)
      const ready = await client.waitFor(record => record.m4a0 === 'ready', `${label} Client ready`, 180_000)
      return { client, ready }
    }
    const exitC1Client = async (client, label) => {
      client.send('/exit\r')
      const exit = await client.waitForExit(60_000)
      assert(exit.code === 0 && exit.signal === null, `${label} exit was ${JSON.stringify(exit)}`)
      await client.dispose()
      return exit
    }
    const openC1Session = async (client, prompt, label) => {
      client.send(`${prompt}\r`)
      await client.waitForScreen(prompt, `${label} prompt painted`, 120_000)
      const status = await waitForSurfaceStatus(client, record => record.sessionOpen === true && typeof record.openSessionId === 'string', `${label} session open`)
      return status.openSessionId
    }
    const hostIdentityFacts = async host => (await hostStatus(host)).localHost
    const assertHostIdentityKept = async (host, before, label) => {
      assertIdentityFields(await hostIdentityFacts(host), before, label)
    }
    /**
     * The Loader row identities that carry Host authority or a Host-only
     * business service. Their live `fiber.uid` is the fact a Client-only surface
     * revision must not change: a re-mounted row would publish a new fiber.
     */
    const PROTECTED_HOST_ROWS = [
      'agent',
      'session',
      'job-controller',
      'typert-gateway',
      'split-host-connection',
      'split-host-api-remotes',
      'split-host-file-upload',
      'split-host-session-stats',
      'split-host-turn-outline',
      'split-host-session-controller',
      'split-host-settings-controller',
      'split-host-session-log-download',
      'split-host-pi-tui-runtime',
      'pi-tui-performance-host',
      'pi-tui-visual-tools',
    ]
    /** `id -> live Loader fiber UID` for the ACTIVE protected rows only. */
    const hostRowFiberUids = async host => {
      const status = await hostStatus(host)
      const rows = new Map()
      for (const entry of status.entries ?? []) {
        if (!PROTECTED_HOST_ROWS.includes(entry.id)) continue
        rows.set(entry.id, { state: entry.state, fiberUid: entry.fiberUid })
      }
      return rows
    }
    /**
     * Every protected Host row must still be ACTIVE on the SAME fiber. The UID
     * is mandatory: a lane that only compares row ids accepts a re-mounted
     * Loader and would report a false "Host untouched".
     */
    const assertHostRowsKept = async (host, before, label) => {
      const after = await hostRowFiberUids(host)
      for (const id of PROTECTED_HOST_ROWS) {
        const expected = before.get(id)
        const actual = after.get(id)
        assert(expected !== undefined, `${label}: row "${id}" was not active before the HMR`)
        assert(Number.isInteger(expected.fiberUid), `${label}: row "${id}" reported no live Loader fiber UID`)
        assert(actual !== undefined, `${label}: row "${id}" is no longer active after the HMR`)
        assert(actual.state === 'active', `${label}: row "${id}" left the active state (${actual.state})`)
        assert(Number.isInteger(actual.fiberUid) && actual.fiberUid === expected.fiberUid,
          `${label}: row "${id}" was re-mounted (fiber ${String(expected.fiberUid)} -> ${String(actual.fiberUid)})`)
      }
    }

    try {
      // T44: a real accepted Turn survives a Client SIGKILL. The LLM stream is
      // held by the Host fixture; the Client disappears while the Host Agent is
      // running, then the SAME Host writes the final assistant message.
      {
        const releaseBarrier = join(workDir, 't44-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't44', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T44 C1')
        const sessionId = await openC1Session(c1, 't44 prompt', 'T44')
        const held = await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T44 long-turn held')
        assert(held.agentStatus === 'running', `T44 the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T44 turn/start')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        assert(!alive(c1Pid), 'T44 the surface Client survived SIGKILL')
        await c1.dispose()
        assert(alive(ready.pid), 'T44 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T44 Host after Client SIGKILL')
        const beforeRelease = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!beforeRelease.some(event => event.type === 'turn/end'),
          'T44 the Turn had already ended before the barrier was released — the case is not a running-Turn proof')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T44 turn/end without a Client')
        const events = hostSessionEvents(dshHome, sessionId) ?? []
        assert(hostUserTexts(events).filter(text => text === 't44 prompt').length === 1,
          'T44 the prompt was replayed or lost')
        assert(hostAssistantHasText(events, 'long-turn answer'), 'T44 the Host did not write the final assistant message without a Client')
        const { client: c2 } = await startC1Client('T44 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('long-turn answer', 'T44 C2 readback')
        await waitForSurfaceStatus(c2, record => record.openSessionId === sessionId, 'T44 C2 exact Session')
        await exitC1Client(c2, 'T44 C2')
        await stopC1Host(host)
        trace('t44', {
          hostPid: ready.pid,
          c1Pid,
          sessionId,
          hostAliveDuringDetach: true,
          turnEndedWithZeroClients: true,
          promptReplays: 1,
          c2Readback: true,
        })
      }

      // T45: the same running Turn survives a CLEAN Client exit (`/exit`).
      {
        const releaseBarrier = join(workDir, 't45-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't45', {
          C1_HOLD_LONG_TURN: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T45 C1')
        const sessionId = await openC1Session(c1, 't45 prompt', 'T45')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T45 long-turn held')
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T45 turn/start')
        const hostBefore = await hostIdentityFacts(host)
        await exitC1Client(c1, 'T45 C1 clean exit')
        assert(alive(ready.pid), 'T45 the Host died on the Client clean exit')
        await assertHostIdentityKept(host, hostBefore, 'T45 Host after clean Client exit')
        const beforeRelease = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!beforeRelease.some(event => event.type === 'turn/end'),
          'T45 the Client clean exit cancelled or settled the Host Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T45 turn/end without a Client')
        const events = hostSessionEvents(dshHome, sessionId) ?? []
        assert(hostUserTexts(events).filter(text => text === 't45 prompt').length === 1, 'T45 the prompt was replayed')
        const { client: c2 } = await startC1Client('T45 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('long-turn answer', 'T45 C2 readback')
        await exitC1Client(c2, 'T45 C2')
        await stopC1Host(host)
        trace('t45', { hostPid: ready.pid, sessionId, cleanExitDidNotCancel: true, c2Readback: true })
      }

      // T46: a real foreground Host Tool call survives the Client exit and its
      // result is written exactly once by the Host Tool authority.
      {
        const releaseBarrier = join(workDir, 't46-tool.release')
        const { host, ready, workRoot } = await startC1Host('foreground-tool', 't46', {
          C1_HOLD_TOOL: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T46 C1')
        const sessionId = await openC1Session(c1, 't46 prompt', 'T46')
        const toolStarted = await waitForC1WorkEvent(workRoot, event => event.kind === 'tool-started' && event.token?.includes(sessionId), 'T46 real Host tool call')
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool', 'T46 tool/call')
        assert(String(call.data.callId) === toolStarted.callId, 'T46 fixture proof and durable tool/call disagree on the call id')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T46 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T46 Host after Client detach')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const result = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolStarted.callId, 'T46 Host tool/result')
        assert(result.data?.message?.isError !== true, 'T46 the held Host Tool failed')
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T46 turn/end')
        const results = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolStarted.callId)
        assert(results.length === 1, `T46 the Host Tool executed ${String(results.length)} times`)
        const { client: c2 } = await startC1Client('T46 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('foreground answer', 'T46 C2 readback')
        await exitC1Client(c2, 'T46 C2')
        await stopC1Host(host)
        trace('t46', { hostPid: ready.pid, sessionId, callId: toolStarted.callId, toolResults: 1, hostAlive: true })
      }

      // T47: a real background Job (official ctx.jobs registry + OS process)
      // keeps running after the Client exits and settles without one.
      {
        const releaseBarrier = join(workDir, 't47-job.release')
        const { host, ready, workRoot } = await startC1Host('job', 't47', {}, c1JobWorkRoot('t47'))
        const jobRelease = join(workRoot, 'job.release')
        rmSync(jobRelease, { force: true })
        const { client: c1 } = await startC1Client('T47 C1')
        const sessionId = await openC1Session(c1, 't47 prompt', 'T47')
        const registered = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T47 job registered')
        assert(typeof registered.jobId === 'string' && registered.status === 'running', 'T47 no real running Host Job')
        assert(registered.owner === sessionId, 'T47 the Job owner is not the exact Session')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T47 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T47 Host after Client detach')
        await sleep(500)
        const eventsWhileDetached = readC1WorkEvents(workRoot).filter(event => event.kind === 'job-event' && event.jobId === registered.jobId)
        assert(eventsWhileDetached.every(event => event.event !== 'settled'), 'T47 the Job settled while no Client existed and the barrier was held')
        const jobLiveness = (await hostStatus(host)).liveness
        assert(jobLiveness?.verdict === 'BLOCKED', `T47 the Host status did not report BLOCKED while an owned Job ran: ${JSON.stringify(jobLiveness)}`)
        assert(jobLiveness.reasons?.includes('job-running'), 'T47 the owned Job did not contribute job-running')
        assert(jobLiveness.sourceStates?.jobs === 'ACTIVE', 'T47 the jobs source is not ACTIVE')
        writeFileSync(jobRelease, 'release\n', { mode: 0o600 })
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === registered.jobId && event.event === 'settled', 'T47 job settled without a Client', 120_000)
        assert(settled.status === 'completed', `T47 the Job settled as ${JSON.stringify(settled.status)}`)
        assert(typeof settled.output === 'string' && settled.output.includes('c1-job-done'),
          `T47 the Job output ring did not carry the real process output: ${JSON.stringify(settled.output)}`)
        const settledLiveness = (await hostStatus(host)).liveness
        assert(!settledLiveness.reasons?.includes('job-running') && !settledLiveness.reasons?.includes('job-stopping'),
          `T47 a settled Job left a ghost Job reason: ${JSON.stringify(settledLiveness)}`)
        const { client: c2 } = await startC1Client('T47 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('job accepted', 'T47 C2 job result')
        await exitC1Client(c2, 'T47 C2')
        await stopC1Host(host)
        trace('t47', { hostPid: ready.pid, sessionId, jobId: registered.jobId, jobStatus: settled.status, hostAlive: true, processOutput: true })
      }

      // Host liveness: one real DSH JobRegistry unowned Job. No Client and no
      // Agent is involved; the observer must see the registry's unowned list
      // and event lifecycle directly.
      {
        const { host, ready, workRoot } = await startC1Host('unowned-job', 'unowned-job-arm', {
          C1_UNOWNED_JOB_ARM: join(workDir, 'unowned-job-arm.arm'),
        })
        writeFileSync(join(workDir, 'unowned-job-arm.arm'), 'arm\n', { mode: 0o600 })
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'unowned-job-created', 'unowned job created', 120_000)
        const runningLiveness = (await hostStatus(host)).liveness
        assert(runningLiveness?.verdict === 'BLOCKED', `the unowned Job did not block: ${JSON.stringify(runningLiveness)}`)
        assert(runningLiveness.reasons?.includes('job-running'), 'the unowned Job did not contribute job-running')
        assert(runningLiveness.sourceStates?.jobs === 'ACTIVE', 'the unowned Job did not make the jobs source ACTIVE')
        writeFileSync(join(workRoot, 'unowned-job.release'), 'release\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'unowned-job-released' && event.jobId === created.jobId, 'unowned job released', 120_000)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'settled' && event.jobId === created.jobId, 'unowned job settled', 120_000)
        const settledLiveness = (await hostStatus(host)).liveness
        assert(!settledLiveness.reasons?.includes('job-running') && !settledLiveness.reasons?.includes('job-stopping'),
          `a settled unowned Job left a ghost reason: ${JSON.stringify(settledLiveness)}`)
        assert(settledLiveness.sourceStates?.jobs === 'IDLE', `the unowned Job source did not return to IDLE: ${JSON.stringify(settledLiveness.sourceStates)}`)
        await stopC1Host(host)
        trace('unowned-job-arm', { hostPid: ready.pid, jobId: created.jobId, runningVerdict: runningLiveness.verdict, settledJobsState: settledLiveness.sourceStates.jobs })
      }

      // Host liveness: ONE real armed Goal is the only thing that keeps this
      // Host from claiming quiescence. The automatic `goal-round-driver` row is
      // disabled on this Host on purpose: it reserves a round the moment the
      // Goal is armed, and with the fixture's instant scripted answer that
      // round ends and the driver then blocks the Goal at `round-limit`. The
      // armed state would then be a transient window whose Host status depends
      // on when the read lands, so the driver's own reservation is qualified
      // separately by the goal-round case below.
      {
        const armedPatch = join(workDir, 'goal-armed.patch.yml')
        const operations = parseYaml(readFileSync(c1Work.patchPath, 'utf8'))
        operations.push({ id: 'goal-round-driver', disabled: true })
        writeFileSync(armedPatch, JSON.stringify(operations, null, 2), { mode: 0o600 })
        const { host, ready, workRoot } = await startC1Host('goal-armed', 'goal-armed', {
          SPLIT_PROCESS_EXTRA_PATCH: armedPatch,
        })
        // The readiness record's Loader rows are the authority that the
        // automatic driver really is OFF here: a disabled row stays listed with
        // the `absent` state (a failed or transitional row would report a
        // `state-N` fiber value), exactly one row may carry the id, and its
        // name must be the official driver package.
        const driverRows = ready.entries.filter(entry => entry.id === 'goal-round-driver')
        assert(driverRows.length === 1
            && driverRows[0].state === 'absent'
            && driverRows[0].name === '@deepseek-ai/dsh-goal-round-driver',
          `the armed-Goal Host did not carry exactly one never-mounted goal-round-driver row: ${JSON.stringify(driverRows)}`)
        // Only the driver is isolated: the Goal service row stays ACTIVE, so
        // this Host still reads a real official Goal source.
        assert(ready.entries.some(entry => entry.id === 'goal'
            && entry.name === '@deepseek-ai/dsh-goal'
            && entry.state === 'active'),
          'the armed-Goal Host lost the real Goal service row instead of only its round driver')
        const { client } = await startC1Client('goal-armed C1')
        const sessionId = await openC1Session(client, 'goal-armed prompt', 'goal-armed')
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-created', 'goal-armed goal created', 120_000)
        assert(created.goalPhase === 'active' && created.activation === 'armed', `goal-armed goal was not armed: ${JSON.stringify(created)}`)
        const goalLiveness = (await hostStatus(host)).liveness
        assert(goalLiveness?.verdict === 'BLOCKED', `the armed Goal did not block: ${JSON.stringify(goalLiveness)}`)
        assert(goalLiveness.reasons?.includes('goal-armed'), 'the armed Goal did not contribute goal-armed')
        assert(goalLiveness.sourceStates?.goal === 'ACTIVE', 'the goal source is not ACTIVE')
        // The Goal is the sole blocking source: the Agent itself is idle with
        // an empty inbox, so neither of its live-work reasons may appear.
        assert(goalLiveness.sourceStates?.agent !== 'ACTIVE', `the Agent was ACTIVE beside the armed Goal: ${JSON.stringify(goalLiveness.sourceStates)}`)
        assert(!goalLiveness.reasons?.includes('agent-running') && !goalLiveness.reasons?.includes('agent-inbox'),
          `the Agent contributed a blocking reason beside the armed Goal: ${JSON.stringify(goalLiveness.reasons)}`)
        // The C1 Host mounts one active test-only file-URL Loader row through
        // `c1Work.patchPath`. Reading the REAL `context.loader` must surface it
        // as an unqualified Host source; the reflect-store probe this replaced
        // silently missed every active Loader row on the real Host path.
        assert(goalLiveness.sourceStates?.other === 'UNKNOWN', 'the active test-only Loader row was not observed through the real Loader')
        assert(goalLiveness.reasons?.includes('unqualified-host-source'), 'the unqualified Host source reason is missing')
        // The create is the only Goal transition this Host could have made: no
        // automatic round, so no pause/block/disarm inside the observation.
        const armedMutations = readC1WorkEvents(workRoot).filter(event => event.kind === 'goal-changed')
        assert(armedMutations.length === 1 && armedMutations[0].goalId === created.goalId && armedMutations[0].operation === 'create',
          `the isolated armed Goal moved out of the created state: ${JSON.stringify(armedMutations)}`)
        await exitC1Client(client, 'goal-armed C1')
        await stopC1Host(host)
        trace('goal-armed', {
          hostPid: ready.pid,
          sessionId,
          goalId: created.goalId,
          verdict: goalLiveness.verdict,
          goalState: goalLiveness.sourceStates.goal,
          agentState: goalLiveness.sourceStates.agent,
        })
      }

      // The REAL `goal-round-driver` owns the automatic reservation: the
      // fixture only creates the governing Goal through the official service
      // and never queues the round itself. This case proves the reservation is
      // a real Agent inbox round and that the one-round budget then ends the
      // armed state. It reads no Host liveness, because with this driver
      // mounted the armed Goal is transient by design; the stable armed-Goal
      // liveness proof is the goal-armed case above.
      {
        const { host, ready, workRoot } = await startC1Host('goal-round', 'goal-round')
        // Positive control for the armed case's row vocabulary: the same id,
        // name and `active` state are what the real driver mounts when the
        // overlay does not disable it.
        const driverRows = ready.entries.filter(entry => entry.id === 'goal-round-driver')
        assert(driverRows.length === 1
            && driverRows[0].state === 'active'
            && driverRows[0].name === '@deepseek-ai/dsh-goal-round-driver',
          `the goal-round Host did not mount exactly one active goal-round-driver row: ${JSON.stringify(driverRows)}`)
        const { client } = await startC1Client('goal-round C1')
        const sessionId = await openC1Session(client, 'goal-round prompt', 'goal-round')
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-created', 'goal-round goal created', 120_000)
        assert(created.goalPhase === 'active' && created.activation === 'armed', `goal-round goal was not armed: ${JSON.stringify(created)}`)
        const round = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-round-observed', 'goal round reserved', 120_000)
        assert(round.goalId === created.goalId, 'the reserved goal round names a different Goal')
        assert(round.revision === created.revision, `the reserved goal round names revision ${JSON.stringify(round.revision)}`)
        assert(round.round === 1, `the first automatic goal round was ${JSON.stringify(round.round)}`)
        assert(round.agentStatus === 'idle', `the goal round was reserved while the Agent was ${JSON.stringify(round.agentStatus)}`)
        // The reservation is durable: the official loop admitted this exact
        // round as a Session `user/message`, which is what consumes the budget.
        const admitted = await waitForHostSessionEvent(dshHome, sessionId,
          event => event.type === 'user/message' && event.data?.source?.kind === 'goal', 'goal round admitted', 120_000)
        assert(String(admitted.data.source.goalId) === created.goalId
            && admitted.data.source.revision === created.revision
            && admitted.data.source.round === round.round,
          `the durable goal round disagrees with the reservation: ${JSON.stringify(admitted.data.source)}`)
        // Then the driver ends the armed state at the round limit instead of
        // reserving another round: the recorded transition names the reason.
        const blocked = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-changed' && event.operation === 'block', 'goal round-limit block', 120_000)
        assert(String(blocked.goalId) === created.goalId && blocked.blockCode === 'round-limit' && blocked.goalPhase === 'blocked' && blocked.activation === 'disarmed',
          `the Goal did not leave the armed state at its round limit: ${JSON.stringify(blocked)}`)
        await exitC1Client(client, 'goal-round C1')
        await stopC1Host(host)
        trace('goal-round', {
          hostPid: ready.pid,
          sessionId,
          goalId: created.goalId,
          round: round.round,
          agentStatus: round.agentStatus,
          blockCode: blocked.blockCode,
        })
      }

      // Host liveness: Agent.runMaintenance() is really executing while the
      // public Agent status stays idle. The observer must not claim quiescence;
      // rc.4 has no synchronous maintenance getter, so UNKNOWN is correct.
      {
        const { host, ready, workRoot } = await startC1Host('maintenance', 'maintenance-sweep')
        const { client } = await startC1Client('maintenance C1')
        const sessionId = await openC1Session(client, 'maintenance prompt', 'maintenance')
        const maintenance = await waitForC1WorkEvent(workRoot, event => event.kind === 'maintenance' && event.phase === 'running', 'maintenance running', 120_000)
        assert(maintenance.agentStatus === 'idle', `maintenance ran while the Agent was ${JSON.stringify(maintenance.agentStatus)}`)
        const maintenanceLiveness = (await hostStatus(host)).liveness
        assert(maintenanceLiveness?.verdict === 'UNKNOWN', `maintenance did not leave the Host UNKNOWN: ${JSON.stringify(maintenanceLiveness)}`)
        assert(maintenanceLiveness.verdict !== 'OBSERVED_QUIESCENT', 'maintenance was reported as quiescent')
        assert(maintenanceLiveness.reasons?.includes('agent-maintenance-unproven'), 'the maintenance gap is not reported')
        writeFileSync(join(workRoot, 'maintenance.release'), 'release\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'maintenance' && event.phase === 'settled', 'maintenance settled', 120_000)
        await exitC1Client(client, 'maintenance C1')
        await stopC1Host(host)
        trace('maintenance-sweep', { hostPid: ready.pid, sessionId, agentStatus: maintenance.agentStatus, verdict: maintenanceLiveness.verdict })
      }

      // Host liveness: the optional official Schedule row is mounted in an
      // isolated test-only overlay. An active task must block with zero
      // Clients; deleting it must clear the schedule-active contribution.
      {
        const schedulePatch = join(workDir, 'host-schedule.patch.yml')
        const operations = parseYaml(readFileSync(c1Work.patchPath, 'utf8'))
        operations.push({ insert: [{ id: 'host-schedule', name: '@deepseek-ai/dsh-schedule' }] })
        writeFileSync(schedulePatch, JSON.stringify(operations, null, 2), { mode: 0o600 })
        const { host, ready, workRoot } = await startC1Host('schedule', 'host-schedule', { SPLIT_PROCESS_EXTRA_PATCH: schedulePatch })
        const { client } = await startC1Client('schedule C1')
        const sessionId = await openC1Session(client, 'schedule prompt', 'schedule')
        const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'schedule-created' && event.status === 'active', 'schedule created', 120_000)
        await exitC1Client(client, 'schedule C1')
        const activeLiveness = (await hostStatus(host)).liveness
        assert(activeLiveness?.verdict === 'BLOCKED', `the active Schedule task did not block: ${JSON.stringify(activeLiveness)}`)
        assert(activeLiveness.reasons?.includes('schedule-active'), 'the active Schedule task did not contribute schedule-active')
        assert(activeLiveness.sourceStates?.schedule === 'ACTIVE', 'the schedule source is not ACTIVE')
        writeFileSync(join(workRoot, 'schedule.delete'), 'delete\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'schedule-deleted' && event.deleted === true, 'schedule deleted', 120_000)
        const deletedLiveness = (await hostStatus(host)).liveness
        assert(!deletedLiveness.reasons?.includes('schedule-active'), `a deleted Schedule task left an active reason: ${JSON.stringify(deletedLiveness)}`)
        assert(deletedLiveness.sourceStates?.schedule === 'IDLE', `the schedule source did not return to IDLE: ${JSON.stringify(deletedLiveness.sourceStates)}`)
        await stopC1Host(host)
        trace('host-schedule', { hostPid: ready.pid, sessionId, scheduleId: created.scheduleId, activeVerdict: activeLiveness.verdict, deletedScheduleState: deletedLiveness.sourceStates.schedule })
      }

      // T48: a real continuable Child survives the Client exit; the Child
      // Session's own durable log carries its final assistant message.
      {
        const releaseBarrier = join(workDir, 't48-child.release')
        const { host, ready, workRoot } = await startC1Host('child', 't48', {
          C1_HOLD_CHILD: releaseBarrier,
        })
        const { client: c1 } = await startC1Client('T48 C1')
        const sessionId = await openC1Session(c1, 't48 prompt', 'T48')
        const started = await waitForC1WorkEvent(workRoot, event => event.kind === 'subagent-start', 'T48 real subagent/start', 120_000)
        assert(typeof started.childId === 'string' && started.childId !== sessionId, 'T48 no distinct Child Agent identity')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'child-stream-held' && event.sessionId === started.childId, 'T48 Child LLM stream held')
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T48 the Host died on the Client SIGKILL')
        await assertHostIdentityKept(host, hostBefore, 'T48 Host after Client detach')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        const ended = await waitForC1WorkEvent(workRoot, event => event.kind === 'subagent-end' && event.childId === started.childId, 'T48 real subagent/end', 120_000)
        assert(ended.runId === started.runId, 'T48 the subagent end does not pair the start run id')
        const childEvents = await (async () => {
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline) {
            const events = hostSessionEvents(dshHome, started.childId)
            if (events !== undefined && hostAssistantHasText(events, 'child answer')) return events
            await sleep(50)
          }
          return undefined
        })()
        assert(childEvents !== undefined, 'T48 the Child Session durable log has no final assistant message')
        const { client: c2 } = await startC1Client('T48 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('child delegated', 'T48 C2 parent readback')
        await exitC1Client(c2, 'T48 C2')
        await stopC1Host(host)
        trace('t48', { hostPid: ready.pid, parentSessionId: sessionId, childId: started.childId, runId: started.runId, childDurable: true })
      }

      const assertInteractionGate = (client, label) => {
        const gate = client.records.find(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate')
        assert(gate !== undefined && gate.phase === 'listeners-ready' && gate.agentResolver === true
          && gate.questionListeners === 1 && gate.approvalListeners === 1 && gate.loaderTasks >= 1,
        `${label} interaction startup gate was not ready before the first generation: ${JSON.stringify(gate)}`)
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate').length === 1,
          `${label} registered the interaction startup gate more than once`)
      }
      // rc.4 exposes no pending inventory: after a Client detaches, the Host
      // status must keep the pending source fail-closed as UNKNOWN with the
      // stable gap reason. This asserts only the absence of an inventory; it
      // never names a request id or claims an expiry outcome.
      const assertPendingUnobservable = async (host, before, label) => {
        const status = await hostStatus(host)
        assertIdentityFields(status.localHost, before, `${label} Host status identity`)
        const liveness = status.liveness
        assert(liveness?.sourceStates?.pending === 'UNKNOWN',
          `${label} the pending source is not UNKNOWN: ${JSON.stringify(liveness?.sourceStates)}`)
        assert(liveness.reasons?.includes('pending-interaction-unobservable'),
          `${label} the pending-interaction gap is not reported: ${JSON.stringify(liveness?.reasons)}`)
        assert(liveness.verdict !== 'OBSERVED_QUIESCENT',
          `${label} the Host claimed quiescence around an unobservable pending interaction`)
        return liveness
      }
      const startPeer = async (label, extraEnv = {}) => {
        const peer = new EntryProcess('peer', entries.client, {
          ...base,
          env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer', ...extraEnv },
        })
        const ready = await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
        return { peer, ready }
      }

      // T12-surface-PTY-HUP: closing the REAL PTY master (the `script(1)`
      // wrapper dies) is a HUP, not a SIGTERM sent to the business Client. The
      // business PID must observe the terminal end and exit; the seat frees and
      // the Host survives for a fresh Client.
      {
        const { host, ready } = await startC1Host('job', 't12-hup')
        const { client } = await startC1Client('T12 HUP Client')
        const businessPid = client.records.find(record => record.m4a0 === 'ready')?.pid
        assert(typeof businessPid === 'number', 'T12 HUP Client had no business PID')
        const scriptPid = client.child.pid
        try { process.kill(scriptPid, 'SIGKILL') } catch { /* already gone */ }
        await waitGone(businessPid, 20_000)
        assert(!alive(businessPid), 'T12 the business Client survived a real PTY master close')
        await client.dispose().catch(() => {})
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        assert(alive(ready.pid), 'T12 the Host died on a Client PTY HUP')
        const { client: recovered } = await startC1Client('T12 HUP recovery Client')
        await exitC1Client(recovered, 'T12 HUP recovery Client')
        await stopC1Host(host)
        trace('t12-pty-hup', { hostPid: ready.pid, clientPid: businessPid, scriptPid, masterClosed: true, seatReusable: true, hostAlive: true })
      }

      // T49/T50: an official pending Question survives C1 SIGKILL and a clean
      // Client exit. C2 receives the ORIGINAL callId through the Host Gateway
      // and its answer settles the same Host flow exactly once.
      for (const [mode, label] of [['kill', 't49'], ['exit', 't50']]) {
        // B-03 eligibility control: the kill case drives the full real Gateway
        // owner-event-stream lifecycle (none -> C1 -> none -> C2 -> none) and
        // one non-answering Peer negative control. The clean-exit case keeps
        // the same question recovery without duplicating the eligibility trace.
        const eligibilityProbe = mode === 'kill'
        const nonAnsweringBarrier = join(workDir, 't49-non-answering-peer.probe')
        rmSync(nonAnsweringBarrier, { force: true })
        const { host, ready, workRoot } = await startC1Host('question', label, eligibilityProbe
          ? { C1_HAS_LIVE_CLIENT_PROBE: '1', C1_NON_ANSWERING_PEER_PROBE: nonAnsweringBarrier }
          : {})
        const waitLiveClient = (value, afterSequence, probeLabel) => waitForC1WorkEvent(
          workRoot,
          event => event.kind === 'has-live-client' && event.value === value && event.sequence > afterSequence,
          probeLabel,
        )
        let liveSequence = 0
        if (eligibilityProbe) {
          const initial = await waitLiveClient(false, liveSequence, 'T49 initial Gateway eligibility')
          liveSequence = initial.sequence
          writeFileSync(nonAnsweringBarrier, 'probe\n', { mode: 0o600 })
          const negative = await waitForC1WorkEvent(workRoot, event => event.kind === 'non-answering-peer', 'T49 non-answering Peer negative control')
          assert(negative.opened === false, 'T49 a non-answering Peer opened the forwarded-event stream')
          assert(negative.code === 'gateway/interactions-forbidden', `T49 unexpected non-answering Peer refusal: ${JSON.stringify(negative)}`)
          assert(negative.liveClient === false, 'T49 the non-answering Peer made hasLiveClient() true')
        }
        const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
        if (eligibilityProbe) {
          const attached = await waitLiveClient(true, liveSequence, 'T49 C1 Gateway eligibility')
          liveSequence = attached.sequence
        }
        const sessionId = await openC1Session(c1, `${label} prompt`, label.toUpperCase())
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', `${label} ask_user_question tool/call`)
        const callId = String(call.data.callId)
        const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, `${label} Host question request`)
        assert(request.questions?.[0]?.question === 'Continue the C1 test?', `${label} the Host question payload is wrong`)
        // The Host ask is pending AND the real C1 modal is painted before the
        // detach: otherwise the kill would race the first forwarded delivery
        // and could legitimately observe "no answerer" instead of a held question.
        await c1.waitForScreen('[1] Proceed', `${label} C1 question modal`, 120_000)
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        if (mode === 'kill') {
          c1.signalBusiness('SIGKILL')
          await waitGone(c1Pid, 15_000)
          await c1.dispose()
        } else {
          // SIGTERM is the clean detach path while a modal owns the editor
          // seat; typing /exit into a modal would be modal input, not exit.
          c1.signalBusiness('SIGTERM')
          const cleanExit = await c1.waitForExit(60_000)
          assert(cleanExit.code === 0 && cleanExit.signal === null, `${label} C1 clean exit was ${JSON.stringify(cleanExit)}`)
          await c1.dispose()
        }
        assert(alive(ready.pid), `${label} the Host died on the Client exit`)
        await assertHostIdentityKept(host, hostBefore, `${label} Host after Client exit`)
        if (eligibilityProbe) {
          const detached = await waitLiveClient(false, liveSequence, 'T49 detached Gateway eligibility')
          liveSequence = detached.sequence
        }
        await assertPendingUnobservable(host, hostBefore, `${label} detached pending`)
        // A clean Client teardown must not settle the Host question as
        // cancelled: no question-failed proof may appear before C2 answers.
        await sleep(300)
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'question-failed' && event.callId === callId)),
          `${label} the Client teardown sent a cancellation that settled the Host pending question`)
        const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, `${label} C2`)
        if (eligibilityProbe) {
          const recovered = await waitLiveClient(true, liveSequence, 'T49 C2 Gateway eligibility')
          liveSequence = recovered.sequence
        }
        await c2.waitForScreen('Continue the C1 test?', `${label} C2 redelivered question`, 120_000)
        c2.send('1')
        await c2.waitForScreen('Submit', `${label} C2 review page`, 30_000)
        c2.send('\r')
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, `${label} Host question settled`, 120_000)
        assert(settled.answers?.[0]?.selected?.[0] === 'Proceed', `${label} the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
        const result = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, `${label} question tool result`)
        assert(result.data?.message?.isError !== true, `${label} the question tool failed after a legal answer`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', `${label} turn/end after answer`)
        const requests = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-request' && event.sessionId === sessionId)
        const settlements = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)
        assert(requests.length === 1 && settlements.length === 1, `${label} duplicate question request/settlement (${String(requests.length)}/${String(settlements.length)})`)
        await exitC1Client(c2, `${label} C2`)
        if (eligibilityProbe) {
          const final = await waitLiveClient(false, liveSequence, 'T49 final Gateway eligibility')
          liveSequence = final.sequence
        }
        await stopC1Host(host)
        trace(label, {
          hostPid: ready.pid,
          sessionId,
          callId,
          mode,
          c2Answer: 'Proceed',
          hostSettlements: settlements.length,
          ...(eligibilityProbe ? { gatewayEligibility: 'none>c1>none>c2>none', nonAnsweringPeer: 'refused' } : {}),
        })
      }

      // T51: after the original Client is gone, a legal new TUI answers the
      // SAME pending Question once; a reattached Client cannot resurrect it.
      // A separate test-only non-TUI answering Peer holds the OLD legal
      // delivery and submits its stale frame AFTER C2 settled. The Host must
      // ignore it: no second request, settlement or tool result.
      {
        let peer
        try {
          const { host, ready, workRoot } = await startC1Host('question', 't51')
          const { client: c1 } = await startC1Client('T51 C1')
          const sessionId = await openC1Session(c1, 't51 prompt', 'T51')
          const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T51 question tool/call')
          const callId = String(call.data.callId)
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T51 question pending')
          await c1.waitForScreen('[1] Proceed', 'T51 C1 question modal', 120_000)
          const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
          c1.signalBusiness('SIGKILL')
          await waitGone(c1Pid, 15_000)
          await c1.dispose()
          assert(alive(ready.pid), 'T51 the Host died on the Client SIGKILL')

          const startedPeer = await startPeer('T51 old peer')
          peer = startedPeer.peer
          await peer.waitFor(record => record.m4a0 === 'peer-interaction' && record.kind === 'question', 'T51 old peer held the stale question delivery', 120_000)
          const peerFrame = await peer.waitFor(record => record.m4a0 === 'peer-frame' && record.event === 'user-questions/request', 'T51 old peer captured the official question frame', 120_000)
          assert(typeof peerFrame.eventId === 'string' && peerFrame.eventId.length > 0,
            'T51 the old question frame has no eventId')
          assert(typeof peerFrame.clientId === 'string' && peerFrame.clientId.length > 0,
            'T51 the old question frame has no clientId')

          const { client: c2 } = await startC1Client('T51 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          assertInteractionGate(c2, 'T51 C2')
          await c2.waitForScreen('Continue the C1 test?', 'T51 C2 question', 120_000)
          c2.send('1')
          await c2.waitForScreen('Submit', 'T51 C2 review')
          c2.send('\r')
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, 'T51 answered')
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T51 turn/end')
          await exitC1Client(c2, 'T51 C2')

          // The old Peer's frame was issued BEFORE the Host settled the new
          // answer. Its `$events/result` must be ignored by the Host stale
          // delivery fence, never delegated into a second settlement.
          // The old legal frame is submitted through the official
          // `$events/result` RPC AFTER C2 settled. The Host must receive the
          // frame (RPC ok) and ignore it through the stale-delivery fence.
          peer.send({
            op: 'peer-send-stale-result',
            eventId: peerFrame.eventId,
            clientId: peerFrame.clientId,
            value: { kind: 'result', value: { answers: [{ id: 'c1-question', selected: ['Cancel'] }] } },
          })
          const staleSent = await peer.waitFor(record => record.m4a0 === 'peer-stale-result-sent' && record.eventId === peerFrame.eventId, 'T51 stale peer frame sent to Host', 30_000)
          assert(staleSent.ok === true, 'T51 the Host did not receive the old question result frame')

          const { client: c3 } = await startC1Client('T51 C3', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          await c3.waitForScreen('question answered', 'T51 C3 settled transcript')
          await sleep(500)
          const viewport = (await c3.viewport()).join('\n')
          assert(!viewport.includes('Submit'), 'T51 a settled question card was resurrected as an answerable flow')
          const settlements = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)
          const toolResults = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId)
          assert(settlements.length === 1 && toolResults.length === 1, 'T51 the settled question produced a second answer/result')
          await exitC1Client(c3, 'T51 C3')
          await stopC1Host(host)
          trace('t51', { hostPid: ready.pid, sessionId, callId, noResurrection: true, staleLegalFrameReplay: 'protocol-peer-negative', eventId: peerFrame.eventId, clientId: peerFrame.clientId })
        } finally {
          if (peer !== undefined) {
            await peer.shutdown().catch(() => {})
          }
        }
      }

      // T52: the official TIMED question becomes a durable `continued` entry.
      // C2 reopens it from the Task Quick projection, submits a late answer,
      // and the Host queues exactly one `user-question-reply` message. This is
      // the official askTimed()/continued lifetime, NOT a 30-minute orphan
      // expiry test.
      {
        const afterTimedBarrier = join(workDir, 't52-after-timed.release')
        const duplicateProbeBarrier = join(workDir, 't52-duplicate-probe.release')
        const expiredProbeBarrier = join(workDir, 't52-expired-probe.release')
        for (const barrier of [afterTimedBarrier, duplicateProbeBarrier, expiredProbeBarrier]) rmSync(barrier, { force: true })
        const { host, ready, workRoot } = await startC1Host('question', 't52', {
          C1_TIMED_QUESTION: '1',
          SPLIT_PROCESS_EXTRA_PATCH: c1Work.timedPatchPath,
          C1_HOLD_AFTER_TIMED: afterTimedBarrier,
          C1_ANSWER_PROBE_DUPLICATE: duplicateProbeBarrier,
          C1_ANSWER_PROBE_EXPIRED: expiredProbeBarrier,
        })
        const { client: c1 } = await startC1Client('T52 C1')
        const sessionId = await openC1Session(c1, 't52 prompt', 'T52')
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T52 timed question tool/call')
        const callId = String(call.data.callId)
        const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T52 timed question request')
        assert(request.timed === true, 'T52 the Host question was not the official timed form')
        // The C1 question UI owns the 1s foreground countdown; its official
        // ASK_TIMED_OUT rejection is what writes the pending tool result and
        // moves the durable projection to `continued`.
        await waitForC1WorkEvent(workRoot, event => event.kind === 'question-failed' && event.sessionId === sessionId, 'T52 timed foreground ended', 120_000)
        const projection = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-projection' && event.callId === callId
          && Array.isArray(event.active) && event.active.some(item => item?.callId === callId && item?.state === 'continued'), 'T52 official continued projection', 120_000)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, 'T52 pending tool result', 120_000)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'after-timed-held' && event.sessionId === sessionId, 'T52 Agent held after the timed question', 120_000)
        c1.signalBusiness('SIGTERM')
        const cleanExit = await c1.waitForExit(60_000)
        assert(cleanExit.code === 0 && cleanExit.signal === null, `T52 C1 clean exit was ${JSON.stringify(cleanExit)}`)
        await c1.dispose()

        const { client: c2 } = await startC1Client('T52 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, 'T52 C2')
        await c2.waitForScreen('t52 prompt', 'T52 C2 history')
        c2.send('\x1b[B')
        await c2.waitForScreen('Task Quick', 'T52 Task Quick opened', 60_000)
        await c2.waitForScreen('Continue the C1 test?', 'T52 continued row')
        c2.send('\r')
        c2.send('1')
        await c2.waitForScreen('Submit', 'T52 continued form review', 60_000)
        c2.send('\r')
        c2.send('\r')
        // The C2 UI's `answerContinued` return is observable through the
        // controller's queued notice; the Host-side probe then calls the
        // official `ctx.userQuestions.answer` service while the Agent is
        // still held, proving the duplicate REPLY_QUEUED classification.
        await c2.waitFor(record => record.m4b2s === 'qualification' && record.op === 'question-answer-continued'
          && record.result === 'queued', 'T52 queued answer classification', 60_000)
        writeFileSync(duplicateProbeBarrier, 'release\n', { mode: 0o600 })
        const duplicate = await waitForC1WorkEvent(workRoot, event => event.kind === 'answer-probe' && event.phase === 'duplicate', 'T52 duplicate continued answer probe', 60_000)
        assert(duplicate.code === 'REPLY_QUEUED', `T52 duplicate continued answer classification was ${JSON.stringify(duplicate)}`)

        writeFileSync(afterTimedBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T52 queued reply turn/end', 120_000)
        const replyDeadline = Date.now() + 60_000
        let queuedMessages = []
        while (Date.now() < replyDeadline) {
          queuedMessages = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'user/message'
            && JSON.stringify(event).includes('answer_to_pending_question')
            && JSON.stringify(event).includes(callId))
          if (queuedMessages.length > 0) break
          await sleep(50)
        }
        assert(queuedMessages.length === 1, `T52 expected exactly one durable queued reply, got ${String(queuedMessages.length)}`)
        const queuedSource = queuedMessages[0].data?.source
        assert(queuedSource?.kind === 'user-question-reply' && queuedSource?.callId === callId,
          `T52 the durable inbox source does not name the continued call: ${JSON.stringify(queuedSource)}`)

        writeFileSync(expiredProbeBarrier, 'release\n', { mode: 0o600 })
        const expired = await waitForC1WorkEvent(workRoot, event => event.kind === 'answer-probe' && event.phase === 'expired', 'T52 expired continued answer probe', 60_000)
        assert(expired.value === false, `T52 expired continued answer classification was ${JSON.stringify(expired)}`)
        await exitC1Client(c2, 'T52 C2')
        await stopC1Host(host)
        trace('t52', {
          hostPid: ready.pid,
          sessionId,
          callId,
          projectedState: projection.active.find(item => item?.callId === callId)?.state,
          continuedAnswer: 'queued',
          durableReplies: queuedMessages.length,
          duplicateAnswer: 'REPLY_QUEUED',
          expiredAnswer: 'not-continued',
        })
      }

      // T53/T54: an official Approval request survives the Client exit and a
      // fresh Client settles the SAME Host request exactly once. `allowed-once`
      // executes the harmless command; `rejected` never executes it.
      for (const [scenario, decision, expected, markerName] of [
        ['approval-allow', 'y', 'allowed-once', 'approval-allow.marker'],
        ['approval-reject', 'n', 'rejected', 'approval-reject.marker'],
      ]) {
        const label = scenario === 'approval-allow' ? 't53' : 't54'
        const { host, ready, workRoot } = await startC1Host(scenario, label)
        const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
        const sessionId = await openC1Session(c1, `${label} prompt`, label.toUpperCase())
        const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', `${label} approval/asked`, 120_000)
        const requestId = String(asked.data.id)
        const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-request', `${label} Host approval request`)
        assert(request.toolName === 'bash', `${label} the approval is not for the official bash tool`)
        await c1.waitForScreen('[y] Allow once', `${label} C1 approval sheet`, 120_000)
        const hostBefore = await hostIdentityFacts(host)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), `${label} the Host died on the Client SIGKILL`)
        await assertHostIdentityKept(host, hostBefore, `${label} Host after Client detach`)
        await assertPendingUnobservable(host, hostBefore, `${label} detached pending`)
        await sleep(300)
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'approval-settled')), `${label} the Client teardown settled the Host approval`)
        const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, `${label} C2`)
        await c2.waitForScreen(scenario === 'approval-allow' ? 'Allow once' : 'Reject', `${label} C2 approval sheet`, 120_000)
        c2.send(decision)
        const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, `${label} approval/decided`, 120_000)
        assert(decided.data.outcome === expected, `${label} approval outcome ${JSON.stringify(decided.data.outcome)} != ${expected}`)
        const decisions = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
        assert(decisions.length === 1, `${label} duplicated approval/decided`)
        const marker = join(workRoot, markerName)
        if (scenario === 'approval-allow') {
          await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-settled' && event.outcome === 'allowed-once', `${label} allowed-once`)
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === String(request.callId), `${label} bash tool result`, 120_000)
          assert(existsSync(marker), `${label} the allowed harmless command did not execute`)
        } else {
          await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-settled' && event.outcome === 'rejected', `${label} rejected`)
          assert(!existsSync(marker), `${label} the rejected harmless command executed`)
        }
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', `${label} turn/end`)
        await exitC1Client(c2, `${label} C2`)
        await stopC1Host(host)
        trace(label, { hostPid: ready.pid, sessionId, requestId, decision: expected, decisions: 1, marker: existsSync(marker) })
      }

      // T55a: an old, still-authenticated non-TUI Peer holds the original
      // approval delivery while the legal C2 rejects it. The old peer's late
      // `allowed-once` frame must not execute the tool or add a decision.
      {
        let peer
        try {
          const { host, ready, workRoot } = await startC1Host('approval-allow', 't55a')
          const { client: c1 } = await startC1Client('T55A C1')
          const sessionId = await openC1Session(c1, 't55a prompt', 'T55A')
          const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55a approval/asked', 120_000)
          const requestId = String(asked.data.id)
          await c1.waitForScreen('[y] Allow once', 'T55a C1 approval sheet', 120_000)
          const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
          c1.signalBusiness('SIGKILL')
          await waitGone(c1Pid, 15_000)
          await c1.dispose()
          const startedPeer = await startPeer('T55a old peer')
          peer = startedPeer.peer
          await peer.waitFor(record => record.m4a0 === 'peer-interaction' && record.kind === 'approval', 'T55a old peer held approval delivery', 120_000)
          const peerFrame = await peer.waitFor(record => record.m4a0 === 'peer-frame' && record.event === 'approval/request', 'T55a old peer captured the official approval frame', 120_000)
          assert(typeof peerFrame.eventId === 'string' && peerFrame.eventId.length > 0,
            'T55a the old approval frame has no eventId')
          assert(typeof peerFrame.clientId === 'string' && peerFrame.clientId.length > 0,
            'T55a the old approval frame has no clientId')
          const { client: c2 } = await startC1Client('T55A C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          assertInteractionGate(c2, 'T55A C2')
          await c2.waitForScreen('Reject', 'T55a C2 approval sheet', 120_000)
          c2.send('n')
          const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55a approval/decided', 120_000)
          assert(decided.data.outcome === 'rejected', 'T55a the legal Client did not reject the approval')
          peer.send({
            op: 'peer-send-stale-result',
            eventId: peerFrame.eventId,
            clientId: peerFrame.clientId,
            value: { kind: 'result', value: 'allowed-once' },
          })
          const staleSent = await peer.waitFor(record => record.m4a0 === 'peer-stale-result-sent' && record.eventId === peerFrame.eventId, 'T55a stale approval frame sent to Host', 30_000)
          assert(staleSent.ok === true, 'T55a the Host did not receive the old approval result frame')
          const decisions = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
          assert(decisions.length === 1 && decisions[0].data.outcome === 'rejected', 'T55a the stale old-peer allow produced a second decision')
          assert(!existsSync(join(workRoot, 'approval-allow.marker')), 'T55a the stale old-peer allow executed the tool')
          await exitC1Client(c2, 'T55A C2')
          await stopC1Host(host)
          trace('t55a', { hostPid: ready.pid, sessionId, requestId, oldPeerHeld: true, staleAllow: 'ignored', decisions: 1, marker: false, eventId: peerFrame.eventId, clientId: peerFrame.clientId })
        } finally {
          if (peer !== undefined) {
            await peer.shutdown().catch(() => {})
          }
        }
      }

      // T55b: a formal Host Agent cancel while the approval is pending must
      // settle the request as the official cancellation taxonomy; a late `y`
      // must not execute the marker.
      {
        const cancelBarrier = join(workDir, 't55b-cancel.release')
        const { host, ready, workRoot } = await startC1Host('approval-allow', 't55b', { C1_CANCEL_AGENT: cancelBarrier })
        const { client } = await startC1Client('T55B C1')
        const sessionId = await openC1Session(client, 't55b prompt', 'T55B')
        const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55b approval/asked', 120_000)
        const requestId = String(asked.data.id)
        await client.waitForScreen('[y] Allow once', 'T55b approval sheet', 120_000)
        writeFileSync(cancelBarrier, 'cancel\n', { mode: 0o600 })
        await waitForC1WorkEvent(workRoot, event => event.kind === 'agent-cancel-requested', 'T55b Host Agent cancel', 60_000)
        const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55b approval/decided', 120_000)
        assert(decided.data.outcome !== 'allowed-once', `T55b Host abort settled as allowed-once: ${JSON.stringify(decided.data)}`)
        assert(decided.data.outcome === 'cancelled', `T55b unexpected Host abort taxonomy: ${JSON.stringify(decided.data.outcome)}`)
        client.send('y')
        await sleep(500)
        assert(!existsSync(join(workRoot, 'approval-allow.marker')), 'T55b a late y executed the command after Host abort')
        assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId).length === 1,
          'T55b the Host abort produced a duplicate approval/decided')
        // The late `y` landed in the editor after the approval sheet was
        // withdrawn; clear it so the normal `/exit` is still a command.
        client.send('\x15')
        await exitC1Client(client, 'T55B C1')
        await stopC1Host(host)
        trace('t55b', { hostPid: ready.pid, sessionId, requestId, hostAbortTaxonomy: decided.data.outcome, lateAllowExecuted: false })
      }

      // T55c: same-PID HMR while a pending Question/Approval owns the modal.
      // The root delivery survives the revision swap; the new surface shows
      // the SAME Host pending and only the new surface's answer settles it.
      for (const [kind, scenario, label, confirmText, answer, expectedCount] of [
        ['question', 'question', 't55c-question', 'Continue the C1 test?', '1', 1],
        ['approval', 'approval-allow', 't55c-approval', '[y] Allow once', 'y', 1],
      ]) {
        const { host, ready, workRoot } = await startC1Host(scenario, label)
        const { client } = await startC1Client(`${label} Client`, { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, `${label} prompt`, label.toUpperCase())
        if (kind === 'question') {
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T55c question tool/call')
          await client.waitForScreen(confirmText, 'T55c C1 question modal', 120_000)
        } else {
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55c approval/asked', 120_000)
          await client.waitForScreen(confirmText, 'T55c C1 approval sheet', 120_000)
        }
        const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.sessionOpen === true, 'T55c initial surface')
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T55c HMR start', 60_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T55c HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T55c HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.surfaceRevision !== before.surfaceRevision, 'T55c new surface')
        assert(after.pid === before.pid && after.generationId === before.generationId, 'T55c HMR changed the Client PID or Connection generation')
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate').length === 1,
          'T55c HMR duplicated the root interaction startup gate')
        await client.waitForScreen(confirmText, 'T55c new surface shows the same Host pending', 120_000)
        if (kind === 'question') {
          client.send(answer)
          await client.waitForScreen('Submit', 'T55c question review', 30_000)
          client.send('\r')
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, 'T55c question settled', 120_000)
          assert(readC1WorkEvents(workRoot).filter(event => event.kind === 'question-request' && event.sessionId === sessionId).length === 1,
            'T55c HMR replayed the Host question request')
        } else {
          client.send(answer)
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided', 'T55c approval/decided', 120_000)
          assert(existsSync(join(workRoot, 'approval-allow.marker')), 'T55c the new surface allow did not execute once')
          assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided').length === expectedCount,
            'T55c HMR duplicated the approval decision')
        }
        await exitC1Client(client, `${label} Client`)
        await stopC1Host(host)
        trace(label, { hostPid: ready.pid, sessionId, samePid: true, sameGeneration: true, pendingReattached: true })
      }

      // T56: a new Client is a fresh Peer/binding; it reads the exact history
      // once and a new prompt appends live without duplication.
      {
        const releaseBarrier = join(workDir, 't56-long-turn.release')
        const rebuilt = await startC1Host('long-turn', 't56', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client: c1 } = await startC1Client('T56 C1b')
        const sessionId = await openC1Session(c1, 't56 first', 'T56')
        await waitForC1WorkEvent(rebuilt.workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T56 first held')
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T56 first turn end')
        const { client: c2 } = await startC1Client('T56 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('t56 first', 'T56 C2 history')
        c2.send('t56 second\r')
        await c2.waitForScreen('long-turn answer 2', 'T56 C2 live append', 120_000)
        const users = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
        assert(users.filter(text => text.startsWith('t56 first')).length === 1
          && users.filter(text => text.includes('t56 second')).length === 1,
        `T56 history duplication: ${JSON.stringify(users.map(text => text.slice(0, 80)))}`)
        await exitC1Client(c2, 'T56 C2')
        await stopC1Host(rebuilt.host)
        trace('t56', { hostPid: rebuilt.ready.pid, sessionId, historyOnce: true, liveAppend: true })
      }

      // T57: Client-only HMR happy path on the SAME Client PID/Context/transport.
      // The Session is open and its Turn has settled BEFORE the revision
      // replacement, so the new revision must re-adopt a fresh exact
      // `tuiMainView` wrapper rather than starting sessionless.
      {
        const releaseBarrier = join(workDir, 't57-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't57', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client } = await startC1Client('T57 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, 't57 prompt', 'T57')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T57 initial held Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T57 initial turn/end')
        const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.sessionOpen === true && record.openSessionId === sessionId, 'T57 initial surface')
        const hostBefore = await hostIdentityFacts(host)
        const rowsBefore = await hostRowFiberUids(host)
        const beforePid = before.pid
        const beforeRootFiber = before.rootFiberUid
        const beforeGeneration = before.generationId
        const beforeRevision = before.surfaceRevision
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T57 HMR start', 60_000)
        await waitForSurfaceStatus(client, record => record.surfaceRevision === beforeRevision && record.surfaceMounted === false, 'T57 retired surface status', 60_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T57 HMR retired', 120_000)
        const hmrReady = await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T57 HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.surfaceRevision === hmrReady.revision && record.surfaceMounted === true, 'T57 new surface status', 120_000)
        assert(after.pid === beforePid, 'T57 the HMR changed the OS PID')
        assert(after.rootFiberUid === beforeRootFiber, 'T57 the HMR changed the Client root Context fiber')
        assert(after.generationId === beforeGeneration, 'T57 the HMR changed the transport generation')
        assert(after.surfaceRevision !== beforeRevision, 'T57 the surface revision did not change')
        assert(after.surfaceFiberUid !== before.surfaceFiberUid, 'T57 the runner fiber did not change')
        assert(after.sessionOpen === true && after.openSessionId === sessionId, 'T57 the new revision did not re-adopt the exact Session wrapper')
        assert(after.owners?.typert === 1 && after.owners?.connection === 1 && after.owners?.remote === 1
          && after.owners?.fileUpload === 1 && after.owners?.sessions === 1 && after.owners?.jobs === 1,
        `T57 duplicate/absent Domain owners after HMR: ${JSON.stringify(after.owners)}`)
        assert(after.privateNamespaces === 2, 'T57 private namespaces were not remounted exactly once')
        for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-ready']) {
          assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === operation).length === 1,
            `T57 expected exactly one ${operation} record`)
        }
        await client.waitForScreen('long-turn answer', 'T57 new TTY paint', 120_000)
        await assertHostIdentityKept(host, hostBefore, 'T57 Host identity')
        await assertHostRowsKept(host, rowsBefore, 'T57 Host Loader rows')
        await exitC1Client(client, 'T57 Client')
        await stopC1Host(host)
        trace('t57', { hostPid: ready.pid, clientPid: beforePid, sessionId, revisionBefore: beforeRevision, revisionAfter: after.surfaceRevision, sameContext: true, sameTransport: true, sessionWrapper: 're-adopted', newTty: true, hostRows: 'same loader fibers', hostRowUids: PROTECTED_HOST_ROWS.length })
      }

      // T58: HMR while a real Host Job is running. The Host Job continues
      // across the surface revision; the new surface re-attaches to the same
      // Session and reads the surviving work.
      {
        const { host, ready, workRoot } = await startC1Host('job', 't58', {}, c1JobWorkRoot('t58'))
        const { client } = await startC1Client('T58 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, 't58 prompt', 'T58')
        const job = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T58 running Job')
        assert(typeof job.jobId === 'string' && job.status === 'running', 'T58 no real running Host Job')
        const hostBefore = await hostIdentityFacts(host)
        const rowsBefore = await hostRowFiberUids(host)
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T58 HMR start')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T58 HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T58 HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.sessionOpen === true && record.openSessionId === sessionId, 'T58 new surface Session', 120_000)
        assert(after.pid === client.records.find(record => record.m4a0 === 'ready')?.pid, 'T58 the HMR changed the Client PID')
        assert(after.owners?.sessions === 1 && after.owners?.jobs === 1 && after.privateNamespaces === 2,
          'T58 duplicate/absent owners after HMR')
        assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired').length === 1,
          'T58 duplicate HMR retirement records')
        assert(alive(ready.pid), 'T58 the Host died during HMR')
        await assertHostIdentityKept(host, hostBefore, 'T58 Host after HMR')
        await assertHostRowsKept(host, rowsBefore, 'T58 Host Loader rows')
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled')),
          'T58 the HMR settled the running Host Job')
        writeFileSync(join(workRoot, 'job.release'), 'release\n', { mode: 0o600 })
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled', 'T58 Job settled after HMR', 120_000)
        assert(settled.status === 'completed', `T58 Job settled as ${JSON.stringify(settled.status)}`)
        await client.waitForScreen('job accepted', 'T58 new surface Job readback', 120_000)
        await exitC1Client(client, 'T58 Client')
        await stopC1Host(host)
        trace('t58', { hostPid: ready.pid, sessionId, jobId: job.jobId, hmrDuringJob: true, jobContinued: true, newSurfaceReadback: true, hostRows: 'same loader fibers', hostRowUids: PROTECTED_HOST_ROWS.length })
      }

      // T59: HMR failure and stop-during-HMR both fail closed with exactly one
      // reverse disposal and no second TTY owner.
      {
        const { host, ready } = await startC1Host('job', 't59')
        const { client } = await startC1Client('T59 failure Client', {
          SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
          SPLIT_PROCESS_CLIENT_HMR_FAIL: '1',
        })
        const c1Pid = client.records.find(record => record.m4a0 === 'ready')?.pid
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 failure HMR start')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 failure HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-failure', 'T59 HMR failure', 120_000)
        const failureExit = await client.waitForExit(60_000)
        assert(failureExit.code === 1, `T59 HMR failure exit was ${JSON.stringify(failureExit)}`)
        for (const operation of ['hmr-revision-start', 'hmr-revision-retired', 'hmr-revision-failure']) {
          assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === operation).length === 1,
            `T59 expected exactly one ${operation} record on HMR failure`)
        }
        const closed = client.records.find(record => record.m4b2s === 'client-closed')
        assert(closed !== undefined, 'T59 HMR failure did not emit the final Client owner inventory')
        for (const owner of ['typert', 'connection', 'remote', 'fileUpload', 'sessions', 'jobs']) {
          assert(closed.owners?.[owner] === 0, `T59 HMR failure left ${owner} owner alive`)
        }
        assert(alive(ready.pid), 'T59 HMR failure killed the Host')
        await client.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        const reuse = await startC1Client('T59 reuse Client')
        await exitC1Client(reuse.client, 'T59 reuse Client')
        await stopC1Host(host)
        trace('t59-failure', { hostPid: ready.pid, clientPid: c1Pid, exit: failureExit.code, seatReusable: true, hostAlive: true })

        const barrier = join(workDir, 't59-hmr-hold')
        const { host: stopHost, ready: stopReady } = await startC1Host('job', 't59-stop')
        const { client: stopping } = await startC1Client('T59 stop Client', {
          SPLIT_PROCESS_CLIENT_HMR_PROBE: '1',
          SPLIT_PROCESS_CLIENT_HMR_HOLD: `surface@${barrier}`,
        })
        stopping.signalBusiness('SIGUSR2')
        await stopping.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T59 stop HMR start')
        await stopping.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T59 stop HMR retired', 120_000)
        stopping.signalBusiness('SIGTERM')
        await stopping.waitFor(record => record.m4a0 === 'signal' && record.signal === 'SIGTERM', 'T59 stop signal admitted', 30_000)
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        const stopExit = await stopping.waitForExit(60_000)
        assert(stopExit.code === 0, `T59 stop-during-HMR exit was ${JSON.stringify(stopExit)}`)
        assert(stopping.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start').length === 1,
          'T59 stop-during-HMR emitted a duplicate revision start')
        assert(stopping.records.filter(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired').length === 1,
          'T59 stop-during-HMR emitted a duplicate revision retirement')
        assert(!stopping.records.some(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready'),
          'T59 stop-during-HMR published a fake ready revision')
        assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'), 'T59 stop-during-HMR reported a cleanup failure')
        assert(alive(stopReady.pid), 'T59 stop-during-HMR killed the Host')
        await stopping.dispose()
        await stopC1Host(stopHost)
        trace('t59-stop', { hostPid: stopReady.pid, exit: stopExit.code, cleanupFailures: 0, hostAlive: true })
      }

      // ── Fatal Host conditions and signal dispositions (T62–T65) ──────────
      /**
       * Stop a Host this lane did not create through `startC1Host`: the one a
       * Client spawns by itself through `ensureLocalHost` after the previous
       * instance died. The official SIGTERM admission is the supported stop; the
       * kernel seat and the launch material must be gone afterwards.
       */
      const stopSpawnedHost = async (hostPid, instanceId, label) => {
        process.kill(hostPid, 'SIGTERM')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), `${label}: the spawned Host survived the official SIGTERM`)
        await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
        const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeSuffix)
        const launchPath = join(scopeDir, 'launch.json')
        const instancePath = join(scopeDir, 'instance.json')
        assert(!existsSync(launchPath), `${label}: the stopped Host left its launch material behind`)
        if (existsSync(instancePath)) {
          assert(readJson(instancePath)?.instanceId !== instanceId,
            `${label}: the stopped Host left its own instance record behind`)
        }
      }
      /** The live `dist/local-host.mjs` PIDs of THIS isolated DSH home. */
      const liveHostPids = () => findIsolatedProcesses(dshHome).filter(pid => {
        try {
          return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes('local-host.mjs')
        } catch {
          return false
        }
      })

      // T62: a real SIGINT delivered to the Client BUSINESS PID (never to the
      // `script(1)` wrapper) is the official 130 disposition: the seat is
      // released, the Host keeps its live identity, and a fresh Client reads the
      // existing Session history back. The Client never signals the Host.
      {
        // The `long-turn` fixture REQUIRES its barrier; release it immediately so
        // the first Turn settles before the signal is sent.
        const releaseBarrier = join(workDir, 't62-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't62', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client } = await startC1Client('T62 Client')
        const sessionId = await openC1Session(client, 't62 prompt', 'T62')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T62 held Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T62 settled Turn')
        const hostBefore = await hostIdentityFacts(host)
        const businessPid = client.records.find(record => record.m4a0 === 'ready')?.pid
        assert(Number.isInteger(businessPid), 'T62 the Client never published its business PID')
        client.signalBusiness('SIGINT')
        const admitted = await client.waitFor(
          record => record.m4a0 === 'signal' && record.signal === 'SIGINT',
          'T62 Client SIGINT admitted',
          30_000,
        )
        assert(admitted.pid === businessPid, 'T62 the SIGINT record did not come from the business PID')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 130 && exit.signal === null,
          `T62 Client SIGINT exit was ${JSON.stringify(exit)}, expected code 130`)
        await client.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        assert(alive(ready.pid), 'T62 the Client SIGINT killed the Host')
        await assertHostIdentityKept(host, hostBefore, 'T62 Host after Client SIGINT')
        const { client: reader } = await startC1Client('T62 reader Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await reader.waitForScreen('t62 prompt', 'T62 history readback')
        await exitC1Client(reader, 'T62 reader Client')
        await stopC1Host(host)
        trace('t62', {
          hostPid: ready.pid,
          clientPid: businessPid,
          signal: 'SIGINT',
          exitCode: exit.code,
          seatReleased: true,
          hostIdentityKept: true,
          historyReadback: true,
        })
      }

      // T63: the DEFAULT keyboard exit chord driven through the REAL PTY. Both
      // Ctrl+C and Ctrl+D require the SAME key twice inside the confirmation
      // window; one press is never enough. These are typed bytes on the pty
      // master, not signals. Ctrl+D needs an EMPTY draft (a non-empty draft turns
      // it into the editor's forward-delete).
      {
        const releaseBarrier = join(workDir, 't63-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't63', { C1_HOLD_LONG_TURN: releaseBarrier })
        const hostBefore = await hostIdentityFacts(host)
        const { client: ctrlC } = await startC1Client('T63 Ctrl+C Client')
        const sessionId = await openC1Session(ctrlC, 't63 prompt', 'T63')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T63 held Turn')
        writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T63 settled Turn')
        // The product's OWN armed-exit cue is painted in the footer; waiting for
        // it (and then for it to expire) is what makes this a double-press proof
        // instead of "the key exits":
        //   1. ONE press arms and paints the hint, and does NOT exit;
        //   2. the hint disappears when the confirmation window closes, and the
        //      Client is still alive;
        //   3. ONE more press arms again, and the NEXT one inside that window
        //      exits through the real controller.
        ctrlC.send('\x03')
        await ctrlC.waitForScreen('again to exit', 'T63 Ctrl+C confirmation armed')
        await ctrlC.waitForScreenGone('again to exit', 'T63 Ctrl+C confirmation expired')
        assert(!ctrlC.exited, 'T63 a SINGLE Ctrl+C press already exited the Client')
        ctrlC.send('\x03')
        await ctrlC.waitForScreen('again to exit', 'T63 Ctrl+C confirmation re-armed')
        ctrlC.send('\x03')
        const ctrlCExit = await ctrlC.waitForExit(60_000)
        assert(ctrlCExit.code === 0 && ctrlCExit.signal === null,
          `T63 Ctrl+C double press exit was ${JSON.stringify(ctrlCExit)}`)
        await ctrlC.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        assert(alive(ready.pid), 'T63 the Ctrl+C exit killed the Host')
        await assertHostIdentityKept(host, hostBefore, 'T63 Host after Ctrl+C')

        const { client: ctrlD } = await startC1Client('T63 Ctrl+D Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await ctrlD.waitForScreen('t63 prompt', 'T63 history readback before Ctrl+D')
        // Ctrl+D needs an EMPTY draft (a non-empty draft turns it into the
        // editor's forward-delete) and the SAME key twice inside the window.
        ctrlD.send('\x04')
        await ctrlD.waitForScreen('again to exit', 'T63 Ctrl+D confirmation armed')
        await ctrlD.waitForScreenGone('again to exit', 'T63 Ctrl+D confirmation expired')
        assert(!ctrlD.exited, 'T63 a SINGLE Ctrl+D press already exited the Client')
        ctrlD.send('\x04')
        await ctrlD.waitForScreen('again to exit', 'T63 Ctrl+D confirmation re-armed')
        ctrlD.send('\x04')
        const ctrlDExit = await ctrlD.waitForExit(60_000)
        assert(ctrlDExit.code === 0 && ctrlDExit.signal === null,
          `T63 Ctrl+D double press exit was ${JSON.stringify(ctrlDExit)}`)
        await ctrlD.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        assert(alive(ready.pid), 'T63 the Ctrl+D exit killed the Host')
        await assertHostIdentityKept(host, hostBefore, 'T63 Host after Ctrl+D')
        const { client: recovered } = await startC1Client('T63 recovery Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await recovered.waitForScreen('t63 prompt', 'T63 history readback after both exits')
        await exitC1Client(recovered, 'T63 recovery Client')
        await stopC1Host(host)
        trace('t63', {
          hostPid: ready.pid,
          ctrlC: { presses: 2, exitCode: ctrlCExit.code, via: 'real pty typed input' },
          ctrlD: { presses: 2, exitCode: ctrlDExit.code, via: 'real pty typed input', draft: 'empty' },
          hostIdentityKept: true,
          sessionPreserved: true,
        })
      }

      // T64: a REAL SIGHUP is a process/terminal failure, NOT the official
      // graceful stop (the Host registers no SIGHUP handler by contract). The
      // attached Client must observe the official Connection loss without
      // fabricating a settlement for the lost Turn; the dead instance is never
      // revived, and stale discovery starts a NEW Host with a new identity.
      {
        const holdRelease = join(workDir, 't64-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't64', { C1_HOLD_LONG_TURN: holdRelease })
        const { client } = await startC1Client('T64 Client')
        const sessionId = await openC1Session(client, 't64 prompt', 'T64')
        const held = await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T64 held Turn')
        assert(held.agentStatus === 'running', `T64 the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T64 turn/start')
        const hostBefore = await hostIdentityFacts(host)
        const hostPid = ready.pid
        process.kill(hostPid, 'SIGHUP')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'T64 the Host survived a real SIGHUP')
        const lost = await client.waitFor(
          record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
          'T64 Client observed the official Connection loss',
          60_000,
        )
        assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
          `T64 unexpected Client transport state after the HUP: ${JSON.stringify(lost.transport)}`)
        // The lost Turn is never reported as settled, and no answer is invented.
        const afterHup = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!afterHup.some(event => event.type === 'turn/end'),
          'T64 the lost Turn was reported as settled after a Host SIGHUP')
        assert(!hostAssistantHasText(afterHup, 'long-turn answer'),
          'T64 an answer was fabricated for the Turn lost in a Host SIGHUP')
        assert(!(await client.viewport()).join('\n').includes('long-turn answer'),
          'T64 the Client painted a fabricated answer for the Turn lost in a Host SIGHUP')
        // An ordinary carrier loss is retryable, not fatal: the Client is alive.
        assert(!client.exited, 'T64 the Client treated an ordinary Host carrier loss as a fatal exit')
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `T64 Client cleanup exit was ${JSON.stringify(exit)}`)
        assert(!client.records.some(record => record.m4a0 === 'cleanup-failure'),
          'T64 the Client reported a cleanup failure after the Host SIGHUP')
        await client.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        // Stale discovery: a fresh Client must create a NEW instance, never
        // revive the dead one, and must not claim the old Session is open.
        const { client: fresh, ready: freshReady } = await startC1Client('T64 fresh Client')
        const newHost = freshReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'T64 stale discovery reused the dead Host PID')
        assert(newHost.instanceId !== hostBefore.instanceId, 'T64 stale discovery reused the dead Host instance')
        assert(newHost.hostStarttime !== hostBefore.hostStarttime, 'T64 the new Host reuses the dead start identity')
        assert(freshReady.sessionOpen === false, 'T64 a sessionless Client claimed an open Session across a Host replacement')
        assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
          `T64 expected exactly the new Host to be live, found ${JSON.stringify(liveHostPids())}`)
        const newInstanceId = newHost.instanceId
        fresh.signalBusiness('SIGTERM')
        const freshExit = await fresh.waitForExit(60_000)
        assert(freshExit.code === 0 && freshExit.signal === null,
          `T64 fresh Client exit was ${JSON.stringify(freshExit)}`)
        await fresh.dispose()
        await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T64 spawned Host')
        trace('t64', {
          hostPid,
          signal: 'SIGHUP',
          classification: 'process failure, not the official graceful stop',
          clientObserved: lost.transport,
          fabricatedSettlement: false,
          clientExit: exit.code,
          newHostPid: newHost.hostPid,
          newInstanceId,
          seatReleased: true,
        })
      }

      // T65: a REAL SIGKILL of the Host while a Client is attached and the
      // Session is open. The official Connection goes disconnected, the pending
      // write never fakes success, the old `tuiMainView` does not survive across
      // Hosts, and a cold resume reads the durable log truthfully without
      // replaying the unknown write.
      {
        const holdRelease = join(workDir, 't65-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't65', { C1_HOLD_LONG_TURN: holdRelease })
        const { client } = await startC1Client('T65 Client')
        const sessionId = await openC1Session(client, 't65 prompt', 'T65')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T65 held Turn')
        const hostBefore = await hostIdentityFacts(host)
        const hostPid = ready.pid
        process.kill(hostPid, 'SIGKILL')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'T65 the Host survived SIGKILL')
        const lost = await client.waitFor(
          record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
          'T65 Client observed the official Connection loss',
          60_000,
        )
        assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
          `T65 unexpected Client transport state after the kill: ${JSON.stringify(lost.transport)}`)
        const afterKill = hostSessionEvents(dshHome, sessionId) ?? []
        assert(!afterKill.some(event => event.type === 'turn/end'),
          'T65 the pending Turn was reported as settled after a Host SIGKILL')
        assert(hostUserTexts(afterKill).filter(text => text === 't65 prompt').length === 1,
          'T65 the accepted write was lost or duplicated by the Host SIGKILL')
        assert(!client.exited, 'T65 the Client treated an ordinary Host carrier loss as a fatal exit')
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `T65 Client cleanup exit was ${JSON.stringify(exit)}`)
        await client.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        // No cross-Host continuity: a sessionless Client gets a NEW Host and no
        // inherited Session; only one Host owner exists at a time.
        const { client: fresh, ready: freshReady } = await startC1Client('T65 fresh Client')
        const newHost = freshReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'T65 stale discovery reused the killed Host PID')
        assert(newHost.instanceId !== hostBefore.instanceId, 'T65 stale discovery reused the killed Host instance')
        assert(freshReady.sessionOpen === false, 'T65 the old tuiMainView survived across a Host replacement')
        assert(JSON.stringify(liveHostPids()) === JSON.stringify([newHost.hostPid]),
          `T65 expected exactly one live Host owner, found ${JSON.stringify(liveHostPids())}`)
        const newInstanceId = newHost.instanceId
        // ONE Client seat per scope: the sessionless Client must leave BEFORE the
        // cold-resume Client can acquire the seat.
        fresh.signalBusiness('SIGTERM')
        const freshExit65 = await fresh.waitForExit(60_000)
        assert(freshExit65.code === 0 && freshExit65.signal === null,
          `T65 fresh Client exit was ${JSON.stringify(freshExit65)}`)
        await fresh.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        // A COLD resume of the same Session reads the durable history: the user
        // write is there exactly once and NO answer is invented for the lost Turn.
        const { client: resumed } = await startC1Client('T65 cold-resume Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await resumed.waitForScreen('t65 prompt', 'T65 cold-resume history')
        // The OFFICIAL Session open records the orphaned Turn's settlement. Waiting
        // for that durable record (not a timer) is what orders "after the resume,
        // nothing else is pending".
        const recovered = await waitForHostSessionEvent(
          dshHome,
          sessionId,
          event => event.type === 'turn/end',
          'T65 cold-resume orphan settlement',
          120_000,
        )
        assert(recovered.data?.reason?.kind !== 'completed',
          'T65 the cold resume settled the lost Turn as completed')
        const afterResume = hostSessionEvents(dshHome, sessionId) ?? []
        assert(hostUserTexts(afterResume).filter(text => text === 't65 prompt').length === 1,
          'T65 the cold resume replayed the unknown write')
        // The official Session open may record the ORPHANED Turn as a
        // fail-closed settlement (an interrupted Turn is truthful recovery and
        // is what the user must see). What it must never do is report that lost
        // work as SUCCESS or invent an answer for it.
        for (const settled of afterResume.filter(event => event.type === 'turn/end')) {
          const kind = settled.data?.reason?.kind
          assert(kind !== 'completed' && kind !== 'max-tokens',
            `T65 the cold resume settled the lost Turn as ${String(kind)}`)
        }
        assert(!hostAssistantHasText(afterResume, 'long-turn answer'),
          'T65 the cold resume fabricated an answer for the lost Turn')
        assert(!(await resumed.viewport()).join('\n').includes('long-turn answer'),
          'T65 the resumed surface painted a fabricated answer for the lost Turn')
        await exitC1Client(resumed, 'T65 cold-resume Client')
        await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T65 spawned Host')
        trace('t65', {
          hostPid,
          signal: 'SIGKILL',
          clientObserved: lost.transport,
          pendingTurnSettled: false,
          unknownWriteReplayed: false,
          crossHostViewContinuity: false,
          newHostPid: newHost.hostPid,
          newInstanceId,
          singleHostOwner: true,
        })
      }

      // T66: the UNKNOWN-WRITE half of the Host-death contract. An ACK-dropped
      // write is committed by the Host while the Client can only report
      // `indeterminate`; the committing Host then dies. A later Host must read the
      // durable log exactly once (never replay the unknown write), and no Host may
      // ever report that write as a success it did not observe.
      {
        const releaseBarrier = join(workDir, 't66-long-turn.release')
        const { host, ready, workRoot } = await startC1Host('long-turn', 't66', { C1_HOLD_LONG_TURN: releaseBarrier })
        const { client } = await startC1Client('T66 Client', { SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK: '1' })
        const unknownToken = 't66 unknown-write'
        const sessionId = await openC1Session(client, unknownToken, 'T66')
        // `waitForScreen` is a verdict helper: it throws unless the painted row
        // appears, so a returned value would be a fiction. The painted
        // `indeterminate` notice IS the observation.
        await client.waitForScreen('indeterminate', 'T66 indeterminate notice', 120_000)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T66 held Turn')
        const hostBefore = await hostIdentityFacts(host)
        const hostPid = ready.pid
        const text = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
          .filter(entry => entry === unknownToken).length
        assert(text === 1, `T66 the Host did not commit the ACK-dropped write exactly once (${String(text)})`)
        // The committing Host dies BEFORE the Turn settles: the write's outcome is
        // now permanently unknown to every Client.
        process.kill(hostPid, 'SIGKILL')
        await waitGone(hostPid, 30_000)
        assert(!alive(hostPid), 'T66 the Host survived SIGKILL')
        const lost = await client.waitFor(
          record => record.m4b2s === 'surface-status' && record.transport !== 'connected',
          'T66 Client observed the official Connection loss',
          60_000,
        )
        assert(lost.transport === 'disconnected' || lost.transport === 'connecting',
          `T66 unexpected Client transport state after the kill: ${JSON.stringify(lost.transport)}`)
        assert(!(await client.viewport()).join('\n').includes('long-turn answer'),
          'T66 the Client painted a settlement for the write whose Host died')
        client.signalBusiness('SIGTERM')
        const exit = await client.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, `T66 Client cleanup exit was ${JSON.stringify(exit)}`)
        await client.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        // A NEW Host on stale discovery, then a real cold resume of the SAME
        // Session: the durable log must still carry the unknown write EXACTLY ONCE
        // and no fabricated settlement.
        const { client: fresh, ready: freshReady } = await startC1Client('T66 fresh Client')
        const newHost = freshReady.host
        assert(newHost.hostPid !== hostBefore.hostPid, 'T66 stale discovery reused the killed Host PID')
        assert(freshReady.sessionOpen === false, 'T66 the dead Host view survived across the replacement')
        const newInstanceId = newHost.instanceId
        fresh.signalBusiness('SIGTERM')
        const freshExit = await fresh.waitForExit(60_000)
        assert(freshExit.code === 0 && freshExit.signal === null, `T66 fresh Client exit was ${JSON.stringify(freshExit)}`)
        await fresh.dispose()
        await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 15_000)
        const { client: resumed } = await startC1Client('T66 cold-resume Client', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await resumed.waitForScreen(unknownToken, 'T66 cold-resume history')
        const recovered = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T66 cold-resume orphan settlement', 120_000)
        assert(recovered.data?.reason?.kind !== 'completed', 'T66 the cold resume reported the lost Turn as completed')
        assert(!(await resumed.viewport()).join('\n').includes('long-turn answer'),
          'T66 the cold resume painted a fabricated answer')
        const afterResume = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
          .filter(entry => entry === unknownToken).length
        assert(afterResume === 1, `T66 the cold resume replayed the unknown write (${String(afterResume)} commits)`)
        await exitC1Client(resumed, 'T66 cold-resume Client')
        await stopSpawnedHost(newHost.hostPid, newInstanceId, 'T66 spawned Host')
        trace('t66', {
          hostPid,
          signal: 'SIGKILL',
          unknownWrite: 'indeterminate',
          hostCommits: 1,
          clientObserved: lost.transport,
          replayedAfterResume: false,
          fabricatedSettlement: false,
          newHostPid: newHost.hostPid,
          newInstanceId,
        })
      }

    } finally {
      for (const client of c1Clients) await client.dispose()
      for (const host of c1Hosts) await stopC1Host(host)
    }

    } finally {
      for (const client of surfaceClients) await client.dispose()
      if (!surfaceHostClosed) {
        try { await surfaceHost.shutdown() } catch { /* already gone */ }
      }
    }

    // C-04 (issue #474 recovery): the SAME candidate/profile must start a FRESH
    // Host after the artifact-absent negative. A real Ready proves the failed
    // process released the kernel seat (a leak would produce
    // HOST_ALREADY_OWNED), and the authenticated /connect + identity read proves
    // the restored Host's identity is really usable, not only declared. This runs
    // at the END of the lane so a full ready Host never changes the
    // preconditions of the T08-T43 flow, which starts its first ready Host at T08.
    const restoredHost = new EntryProcess('host', entries.host, base)
    const restoredReady = await restoredHost.waitFor(record => record.m4a0 === 'ready', 'T26 Host Runtime artifact restored', 120_000)
    assert(!restoredHost.records.some(record => record.m4a0 === 'host-seat-conflict'),
      'T26 Host Runtime artifact absent leaked the Host kernel seat')
    const restoredPrivateBindings = restoredReady.services?.piTuiHostReady === true
      && restoredReady.services?.piTuiFileReferences === true
      && restoredReady.services?.piTuiTerminalProgress === true
    assert(restoredPrivateBindings,
      `T26 Host Runtime restored: the private Host services are not live: ${JSON.stringify(restoredReady.services)}`)
    assert(restoredReady.ownerEntries?.piTuiHostRuntime?.length === 1,
      `T26 Host Runtime restored: expected exactly ONE active Host Runtime owner row, got ${JSON.stringify(restoredReady.ownerEntries?.piTuiHostRuntime)}`)
    // Authenticated identity proof against THIS Host's own published material:
    // the /connect Cookie exchange, a 200 identity read and the registry match
    // are the same chain T02 audits for the main Host.
    const restoredScopeDir = join(dshHome, 'run', 'dsh-pi-tui', restoredReady.localHost.scopeId)
    const restoredRegistry = readJson(join(restoredScopeDir, 'instance.json'))
    const restoredLaunch = readJson(join(restoredScopeDir, 'launch.json'))
    assertIdentityFields(restoredReady.localHost, restoredRegistry, 'T26 Host Runtime restored ready/registry')
    const restoredCookie = await connectCookie(restoredReady.localHost.origin, restoredLaunch)
    const restoredIdentityResponse = await fetchStatus(`${restoredReady.localHost.origin}/api/pi-tui.local-host`, {
      headers: { cookie: restoredCookie },
    })
    const restoredIdentityAuthenticated = restoredIdentityResponse.status === 200
    assert(restoredIdentityAuthenticated,
      `T26 Host Runtime restored authenticated identity returned HTTP ${String(restoredIdentityResponse.status)}`)
    assert(/application\/json\b/iu.test(String(restoredIdentityResponse.headers.get('content-type'))),
      'T26 Host Runtime restored identity response is not JSON')
    assertIdentityFields(JSON.parse(restoredIdentityResponse.body), restoredRegistry,
      'T26 Host Runtime restored authenticated identity')
    // The owner-governed stdin shutdown is the entry's documented qualification
    // path (a ready Host keeps its control dispatcher).
    const restoredExit = await restoredHost.shutdown()
    assert(restoredExit.code === 0, `T26 Host Runtime restored shutdown exit was ${JSON.stringify(restoredExit)}`)
    await seatFree(`\0dsh-pi-tui-h-${restoredReady.localHost.scopeId.slice(0, 40)}`, 10_000)
    trace('t26-runtime-artifact-restored', {
      exit: restoredExit.code,
      readyEmitted: true,
      identityAuthenticated: restoredIdentityAuthenticated,
      privateBindings: restoredPrivateBindings,
      registryMatched: true,
      hostSeatFree: true,
    })

    // T18: installed package shape is already checked above; Direct `--help`
    // and the role-only negative control ran before any Host existed.
    assert(manifest.dependencies?.ws === '8.21.3', 'T18 ws runtime dependency missing')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-host'), 'T18 public Host entry appeared')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-client'), 'T18 public Client entry appeared')
    trace('t18', { packageShape: 'internal entries only', directHelp: 'pass', roleOnlyNegative: 'pass' })

    // T60: the REAL_SPLIT_PROCESS inventory is emitted only after every smoke
    // sub-check above (including T26a restored identity and T18 package shape)
    // has completed on the SAME candidate. The cross-lane release gates are
    // NOT claimed by this script; the stage-final lane records their verdict
    // separately before the overall T60 status is final.
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'T60 the candidate artifact changed during the split-process qualification')
    trace('t60', {
      candidate: basename(tarball),
      sha256: candidateSha256,
      dshVersion: targetDshVersion,
      m4c1: 'PASS_REAL_SPLIT_PROCESS',
      t44t48: 'pass',
      t49t55: 'pass (T49-T55, including detached pending UNKNOWN, real Gateway owner-stream eligibility, the old-peer protocol negatives and same-PID HMR pending question/approval)',
      t56t59: 'pass',
      t60Status: 'PASS_REAL_SPLIT_PROCESS: T01-T66 split-process inventory and T26a restored identity completed; release gates pending the stage-final lane verdict',
      // T61-T65 are the M4 closure-gap cases added on top of the frozen
      // T01-T60 inventory. They are listed explicitly so a later edit cannot
      // silently drop one while T60 still claims the full inventory.
      t61StaleGeneration: 'pass (real mux rollover, one stale write not dispatched, one new-generation commit)',
      t62ClientSigint: 'pass (business PID SIGINT -> exit 130, seat released, Host identity kept)',
      t63KeyboardExit: 'pass (real PTY double Ctrl+C and double Ctrl+D, empty draft)',
      t64HostSighup: 'pass (process failure, no fabricated settlement, new Host instance on stale discovery)',
      t65HostSigkill: 'pass (attached Client, no fake success, no cross-Host view continuity, no replayed write)',
      t66UnknownWrite: 'pass (ACK-lost write committed once, committing Host killed, cold resume reads it exactly once)',
      t57t58HostRows: 'pass (every protected Host Loader row kept its live fiber UID across Client-only HMR)',
      t26aArtifactMissing: 'pass (current main real artifact-absent + restored authenticated identity)',
      t12PtyHup: 'pass (real PTY master close, separate case)',
      releaseGates: 'not run by this smoke; stage-final lane records the separate release-gate verdict',
    })

    console.log(`split-process authenticated-link + real-surface smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
  } catch (error) {
    // Report BEFORE the cleanup below: the failure projection must read the
    // still-live process handles, and the work root must still exist while the
    // report is built. The original error is rethrown so the lane still fails.
    diagnostics.reportFailure(error, { processes: [...activeProcesses] })
    throw error
  } finally {
    // A failed assertion must not leave a live Host/Client probe behind; each
    // entry is its own process group leader (`detached: true`).
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    for (const [pid, starttime] of trackedProcesses) killTracked(pid, starttime, 'SIGKILL')
    if (dshHome !== undefined) killIsolatedProcesses(dshHome)
    if (FAILPOINT !== undefined && dshHome !== undefined) {
      // The failpoint proof reads this run's isolated scene: with no scene (a
      // setup failure before the root existed) there is nothing to prove, and
      // the guard must cover every read in this branch, not only the kill.
      let leftovers = findIsolatedProcesses(dshHome)
      for (let attempt = 0; attempt < 100 && leftovers.length > 0; attempt += 1) {
        await sleep(50)
        killIsolatedProcesses(dshHome)
        leftovers = findIsolatedProcesses(dshHome)
      }
      let seatsOk = true
      if (isolatedScopeId !== undefined) {
        const seatName = `\0dsh-pi-tui-h-${isolatedScopeId.slice(0, 40)}`
        const clientSeatName = `\0dsh-pi-tui-c-${isolatedScopeId.slice(0, 40)}`
        try {
          await seatFree(seatName, 15_000)
          await seatFree(clientSeatName, 15_000)
        } catch {
          // The verdict is the fact; the thrown seat text (an abstract socket
          // name derived from this run's scope) is not default output.
          seatsOk = false
          console.error(`FAILPOINT_SEAT_FAILURE seat=${boundedName(seatName)} the Seat stayed owned; see the preserved work root under KEEP`)
        }
      }
      console.error(`FAILPOINT_CLEANUP leftovers=${String(leftovers.length)} seats=${seatsOk ? 'free' : 'busy'}`)
      if (leftovers.length > 0 || !seatsOk) process.exitCode = 1
      else console.error('FAILPOINT_CLEANUP_OK')
    }
    if (traceFd !== undefined) {
      closeSync(traceFd)
      traceFd = undefined
    }
    if (workDir === undefined) {
      // Nothing was created: setup failed before the work root existed.
    } else if (!KEEP) rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // One concise final line: the fixed category and its stable code. The
    // structured report (written BEFORE the work root was deleted) owns the
    // safe diagnosis; an `Error.message` of any origin is never copied here.
    console.error(`SPLIT_PROCESS_SMOKE_FAILURE: ${safeFailureSummary(error)}`)
    // Forensics stay explicit: `KEEP` is the operator's own preserved-scene
    // mode, and this is the only path that prints the raw error text.
    if (KEEP) console.error(`SPLIT_PROCESS_SMOKE_FORENSICS: ${forensicErrorText(error)}`)
    process.exitCode = 1
  })
}
