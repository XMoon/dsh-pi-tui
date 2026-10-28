#!/usr/bin/env node
/**
 * M4-A0 real-OS split-process smoke.
 *
 * Installs the candidate tarball into an isolated `pi-tui` profile using the
 * published exact DSH family, then launches the two internal process entries
 * from the installed package directory and asserts the lifecycle contract:
 * distinct PIDs, stable Host start identity across Client shutdown/SIGKILL,
 * truthful `not-connected` Client state, required Host services, and nonzero
 * failure paths (missing profile, missing post-boot chunk) with a cleanup
 * record emitted by the owning entry.
 *
 * Usage: node scripts/split-process-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:split-process -- [path-to-candidate.tgz]
 *
 * This is a packaging qualification lane, not a unit test; it is wired into
 * the npm-mode CI `Build and pack` job next to the startup-strictness smoke.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** One OS entry process with parsed JSON records. */
class EntryProcess {
  constructor(role, entry, options) {
    this.role = role
    this.records = []
    this.waiters = []
    this.stderr = ''
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
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    let buffer = ''
    this.child.stdout.on('data', chunk => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        const record = JSON.parse(line)
        this.records.push(record)
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(record)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1)
            waiter.resolve(record)
          }
        }
      }
    })
    this.child.stderr.on('data', chunk => { this.stderr += chunk })
    activeProcesses.add(this)
    this.exit = new Promise(resolveExit => {
      // `close` fires after the child's stdio streams close; `exit` may fire
      // first and would let a caller read a truncated record tail.
      this.child.on('close', (code, signal) => {
        activeProcesses.delete(this)
        resolveExit({ code, signal })
      })
    })
  }

  waitFor(predicate, label, timeoutMs = 60_000) {
    const existing = this.records.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolveWait, reject) => {
      const waiter = { predicate, resolve: record => { clearTimeout(timer); resolveWait(record) } }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`${this.role}: timed out waiting for ${label}; records=${JSON.stringify(this.records.slice(-3))}; stderr=${this.stderr.slice(-1500)}`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  send(request) { this.child.stdin.write(`${JSON.stringify(request)}\n`) }

  async shutdown() {
    const exit = this.exit
    this.send({ op: 'shutdown' })
    return await exit
  }

  kill(signal) { process.kill(-this.child.pid, signal) }
}

let sequence = 0
let statusSequence = 0
const activeProcesses = new Set()

/** A status response belongs to exactly one qualification request. */
export function statusMatches(record, requestId) {
  return record.m4a0 === 'status' && record.requestId === requestId
}

function startIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  } catch {
    return undefined
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${message}`)
}

async function ready(run) {
  const record = await run.waitFor(record => record.m4a0 === 'ready', 'ready')
  const pid = record.pid ?? run.child.pid
  return { record, pid, startIdentity: startIdentity(pid), rootFiberUid: record.rootFiberUid }
}

async function status(host, ready, scenario) {
  // A fresh correlation id is the only thing that can satisfy this wait: the
  // previous status record from the same process is deliberately stale.
  const requestId = `status-${++statusSequence}`
  host.send({ op: 'status', requestId })
  const record = await host.waitFor(record => statusMatches(record, requestId), `status ${requestId}`)
  assert(record.pid === ready.record.pid, `${scenario}: status PID changed`)
  assert(record.processStartIdentity === ready.record.processStartIdentity, `${scenario}: Host start identity changed`)
  assert(record.rootFiberUid === ready.record.rootFiberUid, `${scenario}: Host root fiber identity changed`)
  assert(record.services?.agents === true, `${scenario}: Host status did not report a live agents service`)
  return record
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
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(harnessDir, { recursive: true })
  mkdirSync(scratch, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'evidence.json'))
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
    const base = { cwd: profileDir, env, anchor: realpathSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), profile: 'pi-tui', scratch }

    // Negative control: the role string alone is not Host-entry admission.
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
    assert(
      previousProfilePatch === undefined ? !existsSync(profilePatchPath) : readFileSync(profilePatchPath, 'utf8') === previousProfilePatch,
      'the temporary tui-app disable must be restored before the Host-only positive test',
    )

    const host = new EntryProcess('host', entries.host, base)
    const hostReady = await ready(host)
    assert(hostReady.record.processRole === 'host', 'host role mismatch')
    assert(hostReady.record.transport === 'not-connected', 'host must report not-connected')
    assert(Object.values(hostReady.record.services ?? {}).every(Boolean), 'not all Host prerequisites reported present')
    assert((hostReady.record.forbiddenActive ?? []).length === 0, 'forbidden TUI/Client rows active in Host')
    assert((hostReady.record.ownerEntries?.agents ?? []).length === 1, 'expected one active agents owner')
    assert((hostReady.record.ownerEntries?.sessions ?? []).length === 1, 'expected one active sessions owner')
    assert((hostReady.record.ownerEntries?.jobController ?? []).length === 1, 'expected one active jobController owner')
    assert((hostReady.record.ownerEntries?.connection ?? []).length === 0, 'A0 Host must not own a Connection')
    assert(hostReady.record.webServer?.host === '127.0.0.1' && hostReady.record.webServer?.port > 0, 'Host loopback webserver not ready')

    const client = new EntryProcess('client', entries.client, base)
    const clientReady = await ready(client)
    assert(clientReady.record.processRole === 'client', 'client role mismatch')
    assert(clientReady.record.transport === 'not-connected', 'client must report not-connected')
    assert(clientReady.record.sessionOpen === false, 'client must not report a session')
    assert(clientReady.pid !== hostReady.pid, 'Host and Client must be distinct PIDs')
    const clientExit = await client.shutdown()
    assert(clientExit.code === 0 && clientExit.signal === null, `normal client exit was ${JSON.stringify(clientExit)}`)
    assert(alive(hostReady.pid), 'Host died on normal Client exit')
    const afterNormal = await status(host, hostReady, 'normal-client-exit')
    assert(afterNormal.pid === hostReady.record.pid && afterNormal.processStartIdentity === hostReady.record.processStartIdentity, 'Host identity changed after normal Client exit')

    const killed = new EntryProcess('client', entries.client, base)
    await ready(killed)
    killed.kill('SIGKILL')
    const killedExit = await killed.exit
    assert(killedExit.signal === 'SIGKILL', `SIGKILL client exit was ${JSON.stringify(killedExit)}`)
    assert(alive(hostReady.pid), 'Host died on Client SIGKILL')
    const afterKill = await status(host, hostReady, 'client-sigkill')
    assert(afterKill.pid === hostReady.record.pid && afterKill.processStartIdentity === hostReady.record.processStartIdentity, 'Host identity changed after Client SIGKILL')
    const hostExit = await host.shutdown()
    assert(hostExit.code === 0, `host shutdown exit was ${JSON.stringify(hostExit)}`)

    // Negative control: a missing post-boot chunk must take the owning entry's
    // failure path (nonzero + cleanup record), not a bare process.exit.
    const hostChunk = chunk(profilePackage, 'host-bootstrap-')
    renameSync(hostChunk, `${hostChunk}.missing`)
    const missingHostChunk = new EntryProcess('host', entries.host, base)
    const missingHostExit = await missingHostChunk.exit
    renameSync(`${hostChunk}.missing`, hostChunk)
    assert(missingHostExit.code === 1, `missing host chunk exit was ${JSON.stringify(missingHostExit)}`)
    assert(missingHostChunk.records.some(record => record.m4a0 === 'failure' && record.phase === 'after-boot'), 'missing host chunk did not report after-boot failure')
    assert(missingHostChunk.records.some(record => record.m4a0 === 'cleanup' && record.status === 'completed'), 'missing host chunk did not emit completed cleanup record')
    assert(!missingHostChunk.records.some(record => record.m4a0 === 'cleanup-failure'), 'missing host chunk falsely reported cleanup failure')
    assert(!alive(missingHostChunk.child.pid), 'missing host chunk left a live process')

    const clientChunk = chunk(profilePackage, 'client-bootstrap-')
    renameSync(clientChunk, `${clientChunk}.missing`)
    const missingClientChunk = new EntryProcess('client', entries.client, base)
    const missingClientExit = await missingClientChunk.exit
    renameSync(`${clientChunk}.missing`, clientChunk)
    assert(missingClientExit.code === 1, `missing client chunk exit was ${JSON.stringify(missingClientExit)}`)
    assert(missingClientChunk.records.some(record => record.m4a0 === 'failure' && record.phase === 'after-context'), 'missing client chunk did not report after-context failure')
    assert(missingClientChunk.records.some(record => record.m4a0 === 'cleanup'), 'missing client chunk did not emit cleanup record')
    assert(!alive(missingClientChunk.child.pid), 'missing client chunk left a live process')

    console.log(`split-process bootstrap smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
  } finally {
    // A failed assertion must not leave a live Host/Client probe behind; each
    // entry is its own process group leader (`detached: true`).
    for (const run of activeProcesses) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (process.env.SPLIT_PROCESS_SMOKE_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process smoke environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`SPLIT_PROCESS_SMOKE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
