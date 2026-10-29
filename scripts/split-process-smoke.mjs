#!/usr/bin/env node
/**
 * M4-B1 real-OS split-process authenticated-link smoke.
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
 *
 * Usage: node scripts/split-process-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:split-process -- [path-to-candidate.tgz]
 *
 * Set SPLIT_PROCESS_SMOKE_KEEP=1 to preserve the isolated work directory and
 * SPLIT_PROCESS_TRACE=<path> to append sanitized qualification events (never a
 * token, Cookie or connect URL).
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
import { fileURLToPath } from 'node:url'

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

/** One OS entry process with parsed JSON records. */
class EntryProcess {
  constructor(role, entry, options) {
    this.role = role
    this.records = []
    this.stderr = ''
    this.exited = false
    this.exitResult = undefined
    this.child = spawn(process.execPath, [entry], {
      cwd: options.cwd,
      env: {
        ...options.env,
        SPLIT_PROCESS_DSH_ANCHOR: options.anchor,
        SPLIT_PROCESS_PROFILE: options.profile,
        SPLIT_PROCESS_SCRATCH: join(options.scratch, `${role}-${++sequence}`),
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
    return Promise.race([
      this.exit,
      sleep(timeoutMs).then(() => { throw new Error(`${this.role}: process did not exit within ${String(timeoutMs)}ms`) }),
    ])
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
    const mutationEnv = mutationMode === 'tui-enabled'
      ? { SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch }
      : mutationMode === 'connection-disabled'
        ? { SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch }
        : {}
    const base = { cwd: profileDir, env: { ...env, ...mutationEnv }, anchor, profile: 'pi-tui', scratch }
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
    assert(hostReady.webServer?.host === '127.0.0.1' && hostReady.webServer.port > 0, 'T01 loopback webserver not ready')
    assert(hostReady.entries.filter(entry => entry.name === '@deepseek-ai/dsh-client-connection').length === 1, 'T01 duplicate Connection row')
    assert(hostReady.entries.filter(entry => entry.name === '@deepseek-ai/dsh-api-remotes').length === 1, 'T01 duplicate api-remotes row')
    assert(hostReady.entries.filter(entry => entry.id === 'typert-gateway').length === 1, 'T01 duplicate gateway row')
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

    // T09: two Clients race for the one kernel TUI seat. Only the winner may
    // create a Client Context or reach the Host.
    const clients = [new EntryProcess('client', entries.client, base), new EntryProcess('client', entries.client, base)]
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
    assert(alive(hostReady.pid), 'T02 cookie omission killed the Host')
    trace('t02-cookie-mutation', { code: 'HOST_UNRESPONSIVE', cleanup: noCookieCleanup.m4a0, hostAlive: true })

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
    const scopeScratchDirs = () => readdirSync(scopeDir).filter(name => name.startsWith('host-scratch-'))
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
    assert(scopeScratchDirs().length === 1, 'T15 spawned Host scratch is not the one process-owned directory')
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
    assert(scopeScratchDirs().length === 1, 'a new Client erased the active Host overlay scratch')
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
    assert(scopeScratchDirs().length === 0, 'the clean Host shutdown left a host-scratch directory')
    trace('t15-scratch-clean', { afterCleanExit: scopeScratchDirs().length })
    const scopeSuffix = hostReady.localHost.scopeId.slice(0, 40)
    await seatFree(`\0dsh-pi-tui-h-${scopeSuffix}`, 10_000)
    await seatFree(`\0dsh-pi-tui-c-${scopeSuffix}`, 10_000)
    trace('seats-free', { hostSeat: 'free', clientSeat: 'free' })

    // T18: installed package shape is already checked above; Direct `--help`
    // and the role-only negative control ran before any Host existed.
    assert(manifest.dependencies?.ws === '8.21.3', 'T18 ws runtime dependency missing')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-host'), 'T18 public Host entry appeared')
    assert(!Object.keys(manifest.exports ?? {}).includes('./local-client'), 'T18 public Client entry appeared')
    trace('t18', { packageShape: 'internal entries only', directHelp: 'pass', roleOnlyNegative: 'pass' })

    console.log(`split-process B1 authenticated-link smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
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
