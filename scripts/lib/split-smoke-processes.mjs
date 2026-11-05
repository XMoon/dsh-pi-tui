/**
 * Shared real-OS process/PTY support for the two split-process smoke lanes.
 *
 * One CLI run owns ONE `createSplitProcessScope()`: the scope binds the entry
 * constructors to its own active set and to one monotonically increasing
 * sequence, so a Host/Client wrapper can never be tracked, killed or named by
 * another lane or another run. Importing this module performs no I/O and
 * starts no process; entries exist only when a caller instantiates one.
 *
 * It is also the ONE owner of the operational helpers the extracted selectable
 * scenarios share with the still-inline full-lane blocks (status probes,
 * installed-payload facts, the authenticated Host HTTP/identity checks). Those
 * are test-operation helpers only; they are never imported by product code.
 *
 * @module split-smoke-processes
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import xterm from '@xterm/headless'

import { SplitSmokeAssertionError, SplitSmokeWaitError } from './split-smoke-diagnostics.mjs'

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

/** A status response belongs to exactly one qualification request. */
export function statusMatches(record, requestId) {
  return record.m4a0 === 'status' && record.requestId === requestId
}

/** The kernel starttime of one live process (`/proc/<pid>/stat` field 22). */
export function readStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  } catch {
    return undefined
  }
}

export function readProcState(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[0]
  } catch {
    return undefined
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * One lane's process ownership: the entry constructors bound to THIS scope's
 * active set and path sequence. A second lane creates its own scope, so its
 * cleanup can never kill or report this lane's children.
 */
export function createSplitProcessScope() {
  let sequence = 0
  const activeProcesses = new Set()

  /** One OS entry process with parsed JSON records. Bound to this scope's active set and path sequence. */
  class EntryProcess {
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
  class SurfaceEntryProcess {
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
  return { EntryProcess, SurfaceEntryProcess, activeProcesses }
}

/** The last `surface-status` record of a surface Client (no stdin channel). */
export function lastSurfaceStatus(client) {
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

export async function seatFree(name, timeoutMs = 5_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const free = await new Promise(resolveFree => {
      const server = createServer()
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
export function killTracked(pid, starttime, signal) {
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
export function findIsolatedProcesses(dshHome) {
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

export function killIsolatedProcesses(dshHome) {
  for (const pid of findIsolatedProcesses(dshHome)) {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
  }
}

export async function waitGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  return !alive(pid)
}

/** Whether one Linux abstract-socket seat can be claimed again. */
export async function seatIsFree(name) {
  return await new Promise((resolveSeat, rejectSeat) => {
    const server = createServer()
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

// ── Shared operational helpers ───────────────────────────────────────────────
// Moved out of `scripts/split-process-smoke.mjs` so the extracted selectable
// scenarios and the still-inline full-lane blocks call the SAME implementation.
// The Host HTTP/identity helpers are also consumed by the still-inline Web
// qualification; PR2-D re-homes the Web-only part into its own owner module.

/** The repository root, for the installed-payload helpers below. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** One qualification request id sequence for the two status probes. */
let statusSequence = 0

/** Ask one real Host for a current status snapshot and wait for ITS answer. */
export function hostStatus(host) {
  const requestId = `status-${++statusSequence}`
  host.send({ op: 'status', requestId })
  return host.waitFor(record => statusMatches(record, requestId), `host status ${requestId}`, 30_000)
}

/** Ask one qualification Client for a current status snapshot. */
export function clientStatus(client) {
  const requestId = `status-${++statusSequence}`
  client.send({ op: 'status', requestId })
  return client.waitFor(record => statusMatches(record, requestId), `client status ${requestId}`, 30_000)
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function modeOf(path) {
  return statSync(path).mode & 0o777
}

/** Remember one private file's exact bytes and permission bits. */
export function saveFile(path) {
  return { bytes: readFileSync(path), mode: modeOf(path) }
}

/** Put saved bytes back with their original mode (replacing any symlink). */
export function restoreFile(path, saved) {
  try { unlinkSync(path) } catch { /* missing is fine */ }
  writeFileSync(path, saved.bytes, { mode: saved.mode })
  chmodSync(path, saved.mode)
}

/** Wait for the ONE ready/failure outcome a Host or Client entry reports. */
export async function waitForOutcome(process, label, timeoutMs = 120_000) {
  return await process.waitFor(record => record.m4a0 === 'ready' || record.m4a0 === 'failure', label, timeoutMs)
}

/** Assert the refusal record carries the exact expected stable code. */
export function expectFailureRecord(process, label, expectedCode) {
  const failure = process.records.find(record => record.m4a0 === 'failure')
  assert(failure !== undefined, `${label}: no failure record; records=${JSON.stringify(process.records.slice(-3))}`)
  assert(failure.code === expectedCode, `${label}: expected ${expectedCode}, got ${JSON.stringify(failure.code ?? failure.error)}`)
}

/** The ONE installed dist chunk whose file name starts with the prefix. */
export function chunk(profilePackage, prefix) {
  const file = readdirSync(join(profilePackage, 'dist')).find(name => name.startsWith(prefix) && name.endsWith('.mjs'))
  if (file === undefined) throw new Error(`missing ${prefix} chunk in installed package`)
  return join(profilePackage, 'dist', file)
}

/** The production build fingerprint of one installed payload. */
export function productionBuildId(packageRoot, dshVersion) {
  const moduleUrl = pathToFileURL(join(PACKAGE_ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
  const code = `import { computeBuildId } from ${JSON.stringify(moduleUrl)}; process.stdout.write(computeBuildId(process.argv[1], process.argv[2]))`
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', code, packageRoot, dshVersion],
    { cwd: PACKAGE_ROOT, env: process.env, encoding: 'utf8', timeout: 60_000 },
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

/** One service-bound HTTP request with redirects and cache left to the caller. */
export async function fetchStatus(url, init = {}) {
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
export async function connectCookie(origin, launch) {
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

/** Every published Host identity field must match the expected facts. */
export function assertIdentityFields(actual, expected, label) {
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

/** A Client's echoed Host facts must name the SAME Host the lane is proving. */
export function assertClientHostFacts(client, host, label) {
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
