#!/usr/bin/env node
/**
 * M4-B1/B2-HF real-OS split-process authenticated-link smoke.
 *
 * Installs the candidate tarball into an isolated `pi-tui` profile using the
 * published exact DSH family, then drives the two internal process entries
 * from the installed package directory. The lane proves the A0 lifecycle
 * assertions that still hold plus the B1 gates:
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
 *   T14/T16/T17 forged registry, unresponsive Host, build/auth failures
 *   T15 a dead Host leaves only a stale candidate; a Client safely starts a new one
 *   T18 installed package shape and Direct `--help` remain unchanged
 *   T19 signal admission precedes publication; repeated same signals stay idempotent (no ready)
 *   T20 an early forced exit removes the Host-created scratch before profile boot
 *   T21 the official Session-serving rows + ONE built-in Host Runtime row are ACTIVE
 *   T22/T23/T24 a real Client PID proves official session/list, private PiFile RPC
 *                and the private terminal-progress snapshot over the authenticated link
 *   T25 repeated probes register no duplicate descriptor; Client exit keeps the same Host
 *   T26 missing runtime artifact / required official row / Cookie fail closed, no Ready
 *
 * Usage: node scripts/split-process-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:split-process -- [path-to-candidate.tgz]
 *
 * Set SPLIT_PROCESS_SMOKE_KEEP=1 to preserve the isolated work directory and
 * SPLIT_PROCESS_TRACE=<path> to append sanitized qualification events (never a
 * token, Cookie or connect URL).
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
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
import { basename, dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import xterm from '@xterm/headless'

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
import { loadDshDistribution, npmDshVersion } from './lib/dsh-distribution.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TRACE_PATH = process.env.SPLIT_PROCESS_TRACE
const KEEP = process.env.SPLIT_PROCESS_SMOKE_KEEP === '1'
const HOST_LOG_LIMIT = 2 * 1024 * 1024
/** Qualification-only failure point for the smoke's own finally cleanup proof. */
const FAILPOINT = process.env.SPLIT_PROCESS_SMOKE_FAIL_AFTER

let traceFd
let sequence = 0
let statusSequence = 0
const activeProcesses = new Set()
/** Detached processes this round owns: PID -> its kernel starttime (if known). */
const trackedProcesses = new Map()

/** Append one sanitized qualification event. Never pass a secret here. */
function trace(event, fields = {}) {
  if (TRACE_PATH === undefined || TRACE_PATH === '') return
  if (traceFd === undefined) {
    mkdirSync(dirname(resolve(TRACE_PATH)), { recursive: true })
    traceFd = openSync(TRACE_PATH, 'a', 0o600)
  }
  writeFileSync(traceFd, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${message}`)
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
      const poll = () => {
        const record = this.records.find(predicate)
        if (record !== undefined) {
          clearInterval(interval)
          clearTimeout(timer)
          resolveWait(record)
          return
        }
        if (this.exited) {
          clearInterval(interval)
          clearTimeout(timer)
          reject(new Error(`${this.role}: exited before ${label}; records=${JSON.stringify(this.records.slice(-4))}; stderr=${this.stderr.slice(-1500)}`))
        }
      }
      const interval = setInterval(poll, 20)
      const timer = setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`${this.role}: timed out after ${String(Date.now() - started)}ms waiting for ${label}; records=${JSON.stringify(this.records.slice(-3))}; stderr=${this.stderr.slice(-2000)}`))
      }, timeoutMs)
      poll()
    })
  }

  waitForExit(timeoutMs = 120_000) {
    let timer
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${this.role}: process did not exit within ${String(timeoutMs)}ms`))
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

  /** Parse only COMPLETE lines: the entry appends while this polls. */
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
      const poll = () => {
        if (this.recordError !== undefined) {
          cleanup()
          reject(this.recordError)
          return
        }
        const record = this.records.find(predicate)
        if (record !== undefined) {
          cleanup()
          resolveWait(record)
          return
        }
        if (this.exited) {
          cleanup()
          reject(new Error(`${this.role}: exited before ${label}; records=${JSON.stringify(this.records.slice(-4))}; stderr=${this.stderr.slice(-1500)}; raw=${JSON.stringify(this.raw.slice(-1200))}`))
        }
      }
      const interval = setInterval(poll, 20)
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`${this.role}: timed out after ${String(Date.now() - started)}ms waiting for ${label}; records=${JSON.stringify(this.records.slice(-3))}; raw=${JSON.stringify(this.raw.slice(-2000))}`))
      }, timeoutMs)
      const cleanup = () => {
        clearInterval(interval)
        clearTimeout(timer)
      }
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

  /** Wait until the PAINTED frame contains the text (escape-aware). */
  async waitForScreen(needle, label, timeoutMs = 60_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const viewport = await this.viewport()
      if (viewport.join('\n').includes(needle)) return
      if (this.exited) {
        throw new Error(`${this.role}: exited while waiting for the ${label} frame; raw=${JSON.stringify(this.raw.slice(-2000))}`)
      }
      await sleep(50)
    }
    const viewport = await this.viewport()
    throw new Error(`${this.role}: timed out waiting for the ${label} frame; viewport=${JSON.stringify(viewport)}`)
  }

  /** Wait until the COMPOSER line (after the last separator) holds the text. */
  async waitForComposerDraft(text, timeoutMs = 30_000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const viewport = await this.viewport()
      const separators = []
      for (let index = 0; index < viewport.length; index += 1) {
        if (/^─+$/u.test(viewport[index].trim())) separators.push(index)
      }
      if (separators.length > 0) {
        // The input box is drawn between its top and bottom rule; use the
        // SECOND-TO-LAST rule so the footer rule below it is not mistaken for
        // the box top.
        const top = separators.length >= 2 ? separators[separators.length - 2] : separators[separators.length - 1]
        const bottom = separators.length >= 2 ? separators[separators.length - 1] : viewport.length
        const composer = viewport.slice(top + 1, bottom).join('\n')
        if (composer.includes('❯') && composer.includes(text)) return
      }
      if (this.exited) {
        throw new Error(`${this.role}: exited while waiting for the composer draft; raw=${JSON.stringify(this.raw.slice(-2000))}`)
      }
      await sleep(50)
    }
    const viewport = await this.viewport()
    throw new Error(`${this.role}: timed out waiting for the composer draft ${JSON.stringify(text)}; viewport=${JSON.stringify(viewport)}`)
  }

  /** Send terminal input to the Client through the pty master. */
  send(data) {
    this.child.stdin.write(data)
  }

  /** Signal the business Client process (never the `script` wrapper). */
  signalBusiness(signal) {
    const pid = this.records.find(record => record.m4a0 === 'ready')?.pid
      ?? this.records.find(record => record.m4a0 === 'client-started')?.pid
    if (!Number.isInteger(pid)) throw new Error(`${this.role}: no business PID is known yet`)
    process.kill(pid, signal)
  }

  waitForExit(timeoutMs = 120_000) {
    let timer
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${this.role}: process did not exit within ${String(timeoutMs)}ms`))
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
function hostSessionEvents(dshHome, sessionId) {
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
 * The M4-C1 isolated Host workload overlay. The fixture file is copied into
 * the installed profile so its official `@deepseek-ai/*` imports resolve from
 * that profile (never from the repository checkout), exactly like the stub
 * LLM row above. One row registers the scripted adapter; `agent-default-model`
 * routes the Agent to it.
 */
export function writeC1WorkFixture(profileDir, workDir) {
  const source = join(SCRIPT_DIR, 'fixtures', 'm4-c1-host-work.mjs')
  const fixturePath = join(profileDir, 'm4-c1-host-work.mjs')
  writeFileSync(fixturePath, readFileSync(source), { mode: 0o600 })
  chmodSync(fixturePath, 0o600)
  const rows = [
    '- insert:',
    '    - id: m4-c1-host-work',
    `      name: '${pathToFileURL(fixturePath).href}'`,
    '      inject: [llm, tools, jobs, subagents, agents]',
    '- id: agent-default-model',
    '  config:',
    '    provider: c1-qualification',
    '    model: c1',
    '',
  ]
  const patchPath = join(workDir, 'm4-c1-work.patch.yml')
  writeFileSync(patchPath, rows.join('\n'), { mode: 0o600 })
  chmodSync(patchPath, 0o600)
  // T52: the official TIMED ask_user_question form. This is an isolated
  // qualification profile only; the production preset keeps its legacy form.
  const timedPatchPath = join(workDir, 'm4-c1-work-timed.patch.yml')
  writeFileSync(timedPatchPath, [
    ...rows.slice(0, -1),
    '- id: tool-ask-user',
    '  config:',
    '    mode: timed',
    '    timeout: 1',
    '',
  ].join('\n'), { mode: 0o600 })
  chmodSync(timedPatchPath, 0o600)
  return { fixturePath, patchPath, timedPatchPath }
}

/** Read every M4-C1 fixture proof line (an absent file is simply empty). */
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
async function waitForC1WorkEvent(workRoot, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const event = readC1WorkEvents(workRoot).find(predicate)
    if (event !== undefined) return event
    await sleep(25)
  }
  throw new Error(`${label}: no M4-C1 work proof matched within ${String(timeoutMs)}ms; events=${JSON.stringify(readC1WorkEvents(workRoot).slice(-8))}`)
}

/** Wait for one durable Host Session event matching the predicate. */
async function waitForHostSessionEvent(dshHome, sessionId, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = hostSessionEvents(dshHome, sessionId)
    const event = events?.find(predicate)
    if (event !== undefined) return event
    await sleep(50)
  }
  throw new Error(`${label}: no durable Host Session event matched within ${String(timeoutMs)}ms; events=${JSON.stringify(hostSessionEvents(dshHome, sessionId)?.slice(-8))}`)
}

/** The last `surface-status` record of a surface Client (no stdin channel). */
function lastSurfaceStatus(client) {
  return client.records.filter(record => record.m4b2s === 'surface-status').at(-1)
}

/** Wait for a surface status matching the predicate. */
async function waitForSurfaceStatus(client, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = lastSurfaceStatus(client)
    if (status !== undefined && predicate(status)) return status
    await sleep(25)
  }
  throw new Error(`${label}: no surface status matched; records=${JSON.stringify(client.records.slice(-6))}`)
}

/** Wait for the first ready record among concurrent entries. */
async function waitForAnyReady(processes, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const process of processes) {
      const record = process.records.find(candidate => candidate.m4a0 === 'ready')
      if (record !== undefined) return { process, record }
    }
    if (processes.every(process => process.exited)) {
      throw new Error(`${label}: every contender exited without ready; ${JSON.stringify(processes.map(process => ({ role: process.role, exit: process.exitResult, records: process.records.slice(-2) })))}`)
    }
    await sleep(25)
  }
  throw new Error(`${label}: no contender became ready within ${String(timeoutMs)}ms`)
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
  const deadline = Date.now() + timeoutMs
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
  throw new Error(`abstract seat remained owned: ${name.slice(1)}`)
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

function assertNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    if (secret === undefined || secret === '') continue
    assert(!text.includes(secret), `${label} leaked a B1 secret`)
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
  const tarball = resolveTarball(candidateArgument(process.argv.slice(2)))
  validateCandidateTarball(tarball)
  /** The exact candidate artifact this run qualifies; re-read at the end. */
  const candidateSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const targetDshVersion = npmDshVersion()
  const distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-split-process-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  const scratch = join(workDir, 'scratch')
  for (const directory of [home, dshHome, harnessDir, scratch]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'evidence.json'))
  let isolatedScopeId
  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-split-process-harness',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': targetDshVersion },
    }, null, 2) + '\n', 'utf8')
    runPnpmInstall(harnessDir, env, distribution)
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    assert(version.status === 0, `installed DSH --version failed: ${version.stderr}`)
    assert(version.stdout.trim() === targetDshVersion, `installed DSH version ${version.stdout.trim()} != ${targetDshVersion}`)
    installPlugin(dsh, tarball, harnessDir, env, false)
    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    const profilePackage = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    assert(existsSync(join(profilePackage, 'dist', 'local-host.mjs')), 'candidate host entry missing from profile install')
    assert(existsSync(join(profilePackage, 'dist', 'local-client.mjs')), 'candidate client entry missing from profile install')
    const entries = entryPaths(profilePackage)
    const manifest = readJson(join(profilePackage, 'package.json'))
    assert(manifest.bin === undefined, 'B1 must not add a package bin')
    assert(!Object.keys(manifest.exports ?? {}).some(name => /local-(host|client)/u.test(name)), 'B1 entries must stay internal')
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
    // this whole run: the B1 lanes never prompt, and the surface lanes need a
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

    // §6 running mutations: these are real Host processes, not a unit fake.
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
    // the strict readiness audit with no Ready and no Host identity. A file
    // rename is not a stable negative on this pnpm hardlinked profile layout
    // (the same installed artifact can still resolve from the store mirror), so
    // the row-level absence is the faithful "missing built-in Host Runtime"
    // control the readiness audit actually owns.
    const runRoot = join(dshHome, 'run', 'dsh-pi-tui')
    const hasPublishedIdentity = () => existsSync(runRoot)
      && readdirSync(runRoot, { recursive: true }).some(name => String(name).endsWith('instance.json'))
    const hostRuntimeMutationPatch = join(workDir, 't26-host-runtime-disabled.patch.yml')
    writeFileSync(hostRuntimeMutationPatch, '- id: split-host-pi-tui-runtime\n  disabled: true\n')
    let runtimeMissingFailure
    let runtimeMissingExit
    try {
      const missingRuntime = new EntryProcess('host', entries.host, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: hostRuntimeMutationPatch },
      })
      runtimeMissingFailure = await missingRuntime.waitFor(record => record.m4a0 === 'failure', 'T26 missing Host Runtime row', 120_000)
      runtimeMissingExit = await missingRuntime.waitForExit(60_000)
      assert(runtimeMissingExit.code === 1, `T26 missing Runtime row exit was ${JSON.stringify(runtimeMissingExit)}`)
      assert(!missingRuntime.records.some(record => record.m4a0 === 'ready'), 'T26 missing Runtime row emitted ready')
      assert(/expected exactly one active piTuiHostRuntime owner row, found 0/u.test(String(runtimeMissingFailure.error)),
        `T26 missing Runtime row: unexpected error ${String(runtimeMissingFailure.error)}`)
      assert(!hasPublishedIdentity(), 'T26 missing Runtime row published a Host identity')
    } finally {
      rmSync(hostRuntimeMutationPatch, { force: true })
    }
    trace('t26-runtime-missing', {
      exit: runtimeMissingExit?.code,
      readyEmitted: false,
      error: String(runtimeMissingFailure?.error ?? '').slice(0, 160),
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

    // RFL-012: the Host must never treat SPLIT_PROCESS_SCRATCH as deletion
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
      const conflict = await foreign.waitFor(record => record.m4a0 === 'host-seat-conflict', 'RFL-012 foreign scratch seat conflict', 60_000)
      assert(foreign.effectiveScratch === target, `RFL-012 foreign Host did not receive ${target}: ${foreign.effectiveScratch}`)
      assert(conflict.error === 'HOST_ALREADY_OWNED', `RFL-012 foreign scratch conflict was ${JSON.stringify(conflict.error)}`)
      const foreignExit = await foreign.waitForExit(30_000)
      assert(foreignExit.code === 0, `RFL-012 foreign scratch exit was ${JSON.stringify(foreignExit)}`)
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
    assert(clientWinners.length === 1, `T09 expected one active Client, got ${String(clientWinners.length)}`)
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
        throw new Error('T05 released Peer unexpectedly opened the mux again')
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
    trace('t12', { sigterm: 'pass', ptyHup: 'NOT_RUN (Linux PTY limitation declared)' })

    // T17a: installed-payload drift. The Client's build fingerprint comes from
    // the actual dist; a renamed chunk is a different build and must not
    // connect to the live Host. The live Host is preserved.
    const clientChunk = chunk(profilePackage, 'client-bootstrap-')
    renameSync(clientChunk, `${clientChunk}.missing`)
    let driftExit
    let driftRecords
    try {
      const driftClient = new EntryProcess('client', entries.client, base)
      await driftClient.waitFor(record => record.m4a0 === 'failure', 'T17 payload drift', 60_000)
      driftExit = await driftClient.waitForExit(30_000)
      driftRecords = driftClient.records
    } finally {
      renameSync(`${clientChunk}.missing`, clientChunk)
    }
    assert(driftExit.code === 1, `T17 payload drift exit was ${JSON.stringify(driftExit)}`)
    assert(driftRecords.some(record => record.m4a0 === 'failure' && record.code === 'HOST_BUILD_INCOMPATIBLE'), 'T17 payload drift did not fail closed on the build identity')
    assert(driftRecords.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'T17 payload drift did not emit completed cleanup')
    assert(alive(hostReady.pid), 'T17 payload drift killed the Host')
    trace('t17-payload-drift', { code: 'HOST_BUILD_INCOMPATIBLE', hostAlive: true })

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

    // T16/T17: an alive-but-unresponsive PID, a build mismatch and a bad token
    // are terminal refusals that never kill or replace the live Host.
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
    const incompatibleRegistry = { ...registry, buildId: 'a'.repeat(64) }
    writeRawPrivate(registryPath, incompatibleRegistry)
    writeRawPrivate(launchPath, launch)
    try {
      await expectClientFailure('T16 build incompatible', 'HOST_BUILD_INCOMPATIBLE', () => {}, () => {})
      assert(alive(hostReady.pid), 'T16 build mismatch killed the live Host')
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
    trace('rejections-host', { unresponsive: 'HOST_UNRESPONSIVE', buildIncompatible: 'HOST_BUILD_INCOMPATIBLE', authFailure: 'HOST_AUTH_FAILED' })

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

    // RFL-010/F3: a real Client spawn whose Host fails before runProfile must
    // remove only its own launcher-created scratch. The main Host is already
    // dead, so ensureLocalHost actually spawns a candidate.
    const removalFailure = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_SCRATCH_REMOVE_FAILURE: '1' },
    })
    const removalReady = await waitForOutcome(removalFailure, 'RFL-014 scratch-removal-failure Host', 120_000)
    assert(removalReady.m4a0 === 'ready', `RFL-014 Host did not become ready: ${JSON.stringify(removalReady)}`)
    removalFailure.send({ op: 'shutdown' })
    const removalCleanup = await removalFailure.waitFor(record => record.m4a0 === 'cleanup-failure', 'RFL-014 cleanup failure', 60_000)
    assert(removalCleanup.step === 'scratch-remove', `RFL-014 cleanup step was ${JSON.stringify(removalCleanup.step)}`)
    const removalExit = await removalFailure.waitForExit(30_000)
    assert(removalExit.code === 1, `RFL-014 Host exit was ${JSON.stringify(removalExit)}`)
    trace('t15-removal-failure', { step: removalCleanup.step, exit: removalExit.code })

    const preProfileScratch = scopeScratchDirs().length
    const preProfile = new EntryProcess('client', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_FORCE_BOOT_FAILURE: 'before-profile' },
    })
    const preProfileFailure = await preProfile.waitFor(record => record.m4a0 === 'failure', 'F3 pre-profile Host failure', 120_000)
    const preProfileExit = await preProfile.waitForExit(30_000)
    assert(preProfileExit.code === 1, `F3 pre-profile Client exit was ${JSON.stringify(preProfileExit)}`)
    assert(preProfileFailure.code === 'HOST_START_TIMEOUT', `F3 pre-profile code was ${JSON.stringify(preProfileFailure.code ?? preProfileFailure.error)}`)
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
          throw new Error(`T19 ${signal}: the Host exited before the registry commit; records=${JSON.stringify(r1Host.records.slice(-3))}; stderr=${r1Host.stderr.slice(-1500)}`)
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

    // ── M4-B2-S real surface qualification (T27–T39) ──────────────────────
    // Everything above proves the B1 authenticated control/data link. This
    // block starts a DEDICATED Host with the test-only offline LLM row and
    // drives the ONE real tty surface Client over the SAME authenticated Host:
    // create/open/switch Sessions and prove a real Host commit reaches the
    // painted transcript, then exit/kill/reconnect without touching the Host.
    // T34 (writer pre-dispatch stop), T35 (post-write ACK drop) and T36 (private
    // PiFile/TerminalProgress business read) have no faithful qualification seam
    // in this surface lane yet; they are recorded as NOT_VERIFIED, never as pass.
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
      // T27/T28: ONE real surface over the SAME B1 connection; sessionless
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
      trace('t36', {
        sessionId: privateProof.sessionId,
        fileOk: privateProof.fileOk,
        fileKind: privateProof.fileKind,
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
        t01t26: 'pass except T26a artifact-missing NOT_VERIFIED (row-absence control passes)',
        surface: 'T27-T39 + T41/T42/T43 pass',
      })
    // ── M4-C1 continuity / interactions / Client-only HMR (T44–T60) ────────
    // Each scenario starts its OWN Host (one `C1_SCENARIO` per Host process)
    // and records its facts through the isolated fixture. The Client processes
    // are real PTY surfaces over the official authenticated B1 transport.
    const c1Work = writeC1WorkFixture(profileDir, workDir)
    const c1Hosts = []
    const c1Clients = []
    const c1WorkRoot = label => {
      const root = join(workDir, `c1-${label}`)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      return root
    }
    const startC1Host = async (scenario, label, extraEnv = {}) => {
      await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 15_000)
      const workRoot = c1WorkRoot(label)
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
        const { host, ready, workRoot } = await startC1Host('job', 't47')
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
        writeFileSync(jobRelease, 'release\n', { mode: 0o600 })
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === registered.jobId && event.event === 'settled', 'T47 job settled without a Client', 120_000)
        assert(settled.status === 'completed', `T47 the Job settled as ${JSON.stringify(settled.status)}`)
        assert(typeof settled.output === 'string' && settled.output.includes('c1-job-done'),
          `T47 the Job output ring did not carry the real process output: ${JSON.stringify(settled.output)}`)
        const { client: c2 } = await startC1Client('T47 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c2.waitForScreen('job accepted', 'T47 C2 job result')
        await exitC1Client(c2, 'T47 C2')
        await stopC1Host(host)
        trace('t47', { hostPid: ready.pid, sessionId, jobId: registered.jobId, jobStatus: settled.status, hostAlive: true, processOutput: true })
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

      if (process.env.SPLIT_PROCESS_SMOKE_SKIP_INTERACTIONS === '1') {
        trace('t49-t55', {
          status: 'BLOCKED',
          reason: 'the fresh Client event pump delivers a Host-pending forwarded interaction before the surface interaction port attaches; exact upstream capability is under Owner review',
        })
      } else {
        // T49/T50: an official pending Question survives C1 SIGKILL and a clean
        // Client exit. C2 receives the ORIGINAL callId through the Host Gateway
        // and its answer settles the same Host flow exactly once.
        for (const [mode, label] of [['kill', 't49'], ['exit', 't50']]) {
          const { host, ready, workRoot } = await startC1Host('question', label)
          const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
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
          // A clean Client teardown must not settle the Host question as
          // cancelled: no question-failed proof may appear before C2 answers.
          await sleep(300)
          assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'question-failed' && event.callId === callId)),
            `${label} the Client teardown sent a cancellation that settled the Host pending question`)
          const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
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
          await stopC1Host(host)
          trace(label, { hostPid: ready.pid, sessionId, callId, mode, c2Answer: 'Proceed', hostSettlements: settlements.length })
        }

        // T51: after the answer, a reattached Client does not resurrect the old
        // card and the Host never records a second answer. (The stale legal frame
        // replay needs a second simultaneous peer; that exact wire replay is
        // recorded as NOT_VERIFIED below, never as a pass.)
        {
          const { host, ready, workRoot } = await startC1Host('question', 't51')
          const { client: c1 } = await startC1Client('T51 C1')
          const sessionId = await openC1Session(c1, 't51 prompt', 'T51')
          const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T51 question tool/call')
          const callId = String(call.data.callId)
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T51 question pending')
          const { client: c2 } = await startC1Client('T51 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          await c2.waitForScreen('Continue the C1 test?', 'T51 C2 question')
          c2.send('1')
          await c2.waitForScreen('Submit', 'T51 C2 review')
          c2.send('\r')
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, 'T51 answered')
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T51 turn/end')
          await exitC1Client(c2, 'T51 C2')
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
          trace('t51', { hostPid: ready.pid, sessionId, callId, noResurrection: true, staleLegalFrameReplay: 'NOT_VERIFIED' })
        }

        // T52: the official TIMED question path. The tool returns the pending
        // payload after its foreground window; the Host projection keeps the call
        // answerable as `continued`. The exact C2 continued-answer UI path is
        // recorded as NOT_VERIFIED (no fabricated pass).
        {
          const { host, ready, workRoot } = await startC1Host('question', 't52', { C1_TIMED_QUESTION: '1', SPLIT_PROCESS_EXTRA_PATCH: c1Work.timedPatchPath })
          const { client: c1 } = await startC1Client('T52 C1')
          const sessionId = await openC1Session(c1, 't52 prompt', 'T52')
          const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T52 timed question tool/call')
          const callId = String(call.data.callId)
          const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T52 timed question request')
          assert(request.timed === true, 'T52 the Host question was not the official timed form')
          await waitForC1WorkEvent(workRoot, event => event.kind === 'question-failed' && event.sessionId === sessionId, 'T52 timed foreground ended', 120_000)
          await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, 'T52 pending tool result', 120_000)
          await exitC1Client(c1, 'T52 C1')
          await stopC1Host(host)
          trace('t52', { hostPid: ready.pid, sessionId, callId, timedForegroundEnded: true, continuedC2Answer: 'NOT_VERIFIED' })
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
          await sleep(300)
          assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'approval-settled')), `${label} the Client teardown settled the Host approval`)
          const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
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

        // T55: a Client exit during a pending Approval is NOT an implicit
        // decision; a later legal Client rejects it. The delayed-old-Peer and
        // Host-Agent-abort races are recorded as NOT_VERIFIED (the single-seat
        // lane cannot hold two real Peers at once).
        {
          const { host, ready, workRoot } = await startC1Host('approval-reject', 't55')
          const { client: c1 } = await startC1Client('T55 C1')
          const sessionId = await openC1Session(c1, 't55 prompt', 'T55')
          const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55 approval/asked', 120_000)
          const requestId = String(asked.data.id)
          await c1.waitForScreen('[y] Allow once', 'T55 C1 approval sheet', 120_000)
          c1.signalBusiness('SIGTERM')
          const cleanExit = await c1.waitForExit(60_000)
          assert(cleanExit.code === 0 && cleanExit.signal === null, `T55 C1 clean exit was ${JSON.stringify(cleanExit)}`)
          await c1.dispose()
          await sleep(300)
          const afterExit = hostSessionEvents(dshHome, sessionId) ?? []
          assert(!afterExit.some(event => event.type === 'approval/decided'), 'T55 the Client clean exit decided the Host approval')
          const { client: c2 } = await startC1Client('T55 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
          await c2.waitForScreen('Reject', 'T55 C2 approval sheet', 120_000)
          c2.send('n')
          const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55 approval/decided')
          assert(decided.data.outcome === 'rejected', 'T55 the later legal Client did not reject the approval')
          await exitC1Client(c2, 'T55 C2')
          await stopC1Host(host)
          trace('t55', { hostPid: ready.pid, sessionId, requestId, exitDidNotDecide: true, stalePeerRace: 'NOT_VERIFIED', hostAbortRace: 'NOT_VERIFIED' })
        }
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
      {
        const { host, ready } = await startC1Host('long-turn', 't57', { C1_HOLD_LONG_TURN: join(workDir, 't57-never-released') })
        const { client } = await startC1Client('T57 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true, 'T57 initial surface')
        const hostBefore = await hostIdentityFacts(host)
        const beforePid = before.pid
        const beforeRootFiber = before.rootFiberUid
        const beforeGeneration = before.generationId
        const beforeRevision = before.surfaceRevision
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T57 HMR start', 60_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T57 HMR retired', 120_000)
        const hmrReady = await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T57 HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.surfaceRevision === hmrReady.revision && record.surfaceMounted === true, 'T57 new surface status', 120_000)
        assert(after.pid === beforePid, 'T57 the HMR changed the OS PID')
        assert(after.rootFiberUid === beforeRootFiber, 'T57 the HMR changed the Client root Context fiber')
        assert(after.generationId === beforeGeneration, 'T57 the HMR changed the transport generation')
        assert(after.surfaceRevision !== beforeRevision, 'T57 the surface revision did not change')
        assert(after.surfaceFiberUid !== before.surfaceFiberUid, 'T57 the runner fiber did not change')
        await client.waitForScreen('type a message to start a session', 'T57 new TTY paint', 120_000)
        await assertHostIdentityKept(host, hostBefore, 'T57 Host identity')
        await exitC1Client(client, 'T57 Client')
        await stopC1Host(host)
        trace('t57', { hostPid: ready.pid, clientPid: beforePid, revisionBefore: beforeRevision, revisionAfter: after.surfaceRevision, sameContext: true, sameTransport: true, newTty: true })
      }

      // T58: HMR while a real Host Job is running. The Host Job continues
      // across the surface revision; the new surface re-attaches to the same
      // Session and reads the surviving work.
      {
        const { host, ready, workRoot } = await startC1Host('job', 't58')
        const { client } = await startC1Client('T58 Client', { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
        const sessionId = await openC1Session(client, 't58 prompt', 'T58')
        const job = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T58 running Job')
        assert(typeof job.jobId === 'string' && job.status === 'running', 'T58 no real running Host Job')
        const hostBefore = await hostIdentityFacts(host)
        client.signalBusiness('SIGUSR2')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T58 HMR start')
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T58 HMR retired', 120_000)
        await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T58 HMR ready', 180_000)
        const after = await waitForSurfaceStatus(client, record => record.sessionOpen === true && record.openSessionId === sessionId, 'T58 new surface Session', 120_000)
        assert(after.pid === client.records.find(record => record.m4a0 === 'ready')?.pid, 'T58 the HMR changed the Client PID')
        assert(alive(ready.pid), 'T58 the Host died during HMR')
        await assertHostIdentityKept(host, hostBefore, 'T58 Host after HMR')
        assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled')),
          'T58 the HMR settled the running Host Job')
        writeFileSync(join(workRoot, 'job.release'), 'release\n', { mode: 0o600 })
        const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === job.jobId && event.event === 'settled', 'T58 Job settled after HMR', 120_000)
        assert(settled.status === 'completed', `T58 Job settled as ${JSON.stringify(settled.status)}`)
        await client.waitForScreen('job accepted', 'T58 new surface Job readback', 120_000)
        await exitC1Client(client, 'T58 Client')
        await stopC1Host(host)
        trace('t58', { hostPid: ready.pid, sessionId, jobId: job.jobId, hmrDuringJob: true, jobContinued: true, newSurfaceReadback: true })
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
        writeFileSync(barrier, 'release\n', { mode: 0o600 })
        const stopExit = await stopping.waitForExit(60_000)
        assert(stopExit.code === 0, `T59 stop-during-HMR exit was ${JSON.stringify(stopExit)}`)
        assert(!stopping.records.some(record => record.m4a0 === 'cleanup-failure'), 'T59 stop-during-HMR reported a cleanup failure')
        assert(alive(stopReady.pid), 'T59 stop-during-HMR killed the Host')
        await stopping.dispose()
        await stopC1Host(stopHost)
        trace('t59-stop', { hostPid: stopReady.pid, exit: stopExit.code, cleanupFailures: 0, hostAlive: true })
      }

      // T60: final qualification inventory. The real stage-final lane runs the
      // release gates; this record proves the exact candidate stayed unchanged
      // across the whole REAL_SPLIT_PROCESS run and names the known gaps.
      assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
        'T60 the candidate artifact changed during the M4-C1 qualification')
      trace('t60', {
        candidate: basename(tarball),
        sha256: candidateSha256,
        dshVersion: targetDshVersion,
        t44t48: process.env.SPLIT_PROCESS_SMOKE_SKIP_INTERACTIONS === '1' ? 'T44-T48 pass' : 'executed',
        t49t55: process.env.SPLIT_PROCESS_SMOKE_SKIP_INTERACTIONS === '1' ? 'BLOCKED: upstream Client event-pump pre-answerer delivery gap' : 'executed',
        t56t59: process.env.SPLIT_PROCESS_SMOKE_SKIP_INTERACTIONS === '1' ? 'T56-T59 pass' : 'executed',
        t26aArtifactMissing: 'NOT_VERIFIED (#474)',
        t12PtyHup: 'NOT_RUN',
        releaseGates: 'run by the stage-final lane, not by this smoke',
      })
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


    // T18: installed package shape is already checked above; Direct `--help`
    // and the role-only negative control ran before any Host existed.
    assert(manifest.dependencies?.ws === '8.21.3', 'T18 ws runtime dependency missing')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-host'), 'T18 public Host entry appeared')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-client'), 'T18 public Client entry appeared')
    trace('t18', { packageShape: 'internal entries only', directHelp: 'pass', roleOnlyNegative: 'pass' })

    console.log(`split-process B1/B2-S authenticated-link + real-surface smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
  } finally {
    // A failed assertion must not leave a live Host/Client probe behind; each
    // entry is its own process group leader (`detached: true`).
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    for (const [pid, starttime] of trackedProcesses) killTracked(pid, starttime, 'SIGKILL')
    killIsolatedProcesses(dshHome)
    if (FAILPOINT !== undefined) {
      let leftovers = findIsolatedProcesses(dshHome)
      for (let attempt = 0; attempt < 100 && leftovers.length > 0; attempt += 1) {
        await sleep(50)
        killIsolatedProcesses(dshHome)
        leftovers = findIsolatedProcesses(dshHome)
      }
      let seatsOk = true
      if (isolatedScopeId !== undefined) {
        try {
          await seatFree(`\0dsh-pi-tui-h-${isolatedScopeId.slice(0, 40)}`, 15_000)
          await seatFree(`\0dsh-pi-tui-c-${isolatedScopeId.slice(0, 40)}`, 15_000)
        } catch (error) {
          seatsOk = false
          console.error(`FAILPOINT_SEAT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
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
    if (!KEEP) rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process B1 environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`SPLIT_PROCESS_SMOKE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
