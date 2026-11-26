/**
 * PO-1B real-OS split-process qualification: the OPT-IN, DEFAULT-OFF local ACP
 * v1 Unix socket listener and its two independent authorities.
 *
 * PO-1 proved the socket mechanics once it exists. This case proves the NEW
 * opt-in classes on a REAL installed Host/Client pair:
 *
 *   a) default-OFF — a base Host is Ready with NO `acp.sock` and the ordinary
 *      TUI/Split transport still works.
 *   b) runtime toggle — the private `piTuiAcpAccess` Peer control flips the LIVE
 *      listener on and off without replacing the Host; disabling disconnects an
 *      open raw ACP client and retires its socket.
 *   c) preference persistence — the persisted `pi-tui-acp-preferences.autoStart`
 *      is a DIFFERENT authority: writing it never changes the running listener,
 *      but the NEXT cold Host applies it (bind before Ready / bind nothing).
 *   d) Direct vs Split — a settings-only edit never starts or stops the running
 *      listener (the Direct runtime check is not constructible in this lane; a
 *      trace records the boundary instead of a fabricated proof).
 *   e) recompose — a real settings write while the listener is enabled keeps the
 *      SAME Host PID/instanceId serving and the listener still enabled.
 *
 * Every fact comes from a REAL process and a REAL socket. Nothing here re-proves
 * the PO-1 frame/limit semantics or the 13 socket unit tests.
 *
 * @module split-process/acp-po1b
 */

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { createSplitSmokeProfile } from '../../lib/split-smoke-profile.mjs'
import { hostStatus, seatFree } from '../../lib/split-smoke-processes.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** One raw NDJSON JSON-RPC client over a real UDS connection. */
class AcpRawClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.waiter = undefined
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const message = JSON.parse(line)
        if (this.waiter !== undefined) {
          const waiter = this.waiter
          this.waiter = undefined
          waiter(message)
        } else {
          this.queue.push(message)
        }
      }
    })
    this.closed = new Promise(resolveClose => socket.on('close', () => resolveClose()))
    socket.on('error', () => {})
  }

  static open(path) {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.off('error', rejectOpen)
        resolveOpen(new AcpRawClient(socket))
      })
      socket.once('error', rejectOpen)
    })
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  next(timeoutMs = 8_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        rejectNext(new Error(`acp raw client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = value => { clearTimeout(timer); resolveNext(value) }
    })
  }

  async initialize(id) {
    this.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    return await this.next()
  }

  close() {
    this.socket.destroy()
  }
}

/** The scope directory that currently holds a bound `acp.sock` under this DSH home. */
function findScopeDirBySocket(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!exists(root)) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (exists(join(dir, 'acp.sock'))) return dir
  }
  return undefined
}

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Connect one raw ACP client through this process's OWN scope directory fd.
 *
 * A real `DSH_HOME`/scope pathname commonly exceeds the Linux `sun_path` byte
 * limit, so a full-length `net.connect(<logical path>)` is `EINVAL`. Connect
 * through `/proc/self/fd/<fd>/acp.sock` instead, then release the fd.
 */
async function openAcpClient(scopeDir) {
  const dirFd = openSync(scopeDir, 'r')
  try {
    return await AcpRawClient.open(`/proc/self/fd/${String(dirFd)}/acp.sock`)
  } finally {
    closeSync(dirFd)
  }
}

async function waitUntil(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new SplitSmokeAssertionError(`acp-po1b: timed out waiting for ${label}`)
}

/** The Linux abstract seat name one Host scope claims for this profile. */
function seatName(scopeId) {
  return `\0dsh-pi-tui-h-${String(scopeId).slice(0, 40)}`
}

/**
 * Run the PO-1B real split-process opt-in ACP control qualification.
 * Every returned boolean is a fact gathered from a REAL process/socket.
 */
export async function runAcpPo1bOptInControl(context) {
  const { EntryProcess, SurfaceEntryProcess, entries, base, dshHome, workDir, trace, installation } = context
  const hosts = []
  const clients = []
  const peers = []
  let sequence = 0
  let profileTouched = false
  let originalError

  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const socketPathFor = scopeId => join(scopeDirOf(scopeId), 'acp.sock')
  /** One REAL public management command against THIS isolated installation. */
  const runDsh = args => {
    const [executable, ...prefix] = installation.dshInvocation
    const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', ...args], {
      cwd: installation.profileDir,
      env: installation.env,
      encoding: 'utf8',
      timeout: 120_000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  /** PO-5D: one real `daemon status` observation, folded into its key=value fields. */
  const daemonStatus = label => {
    const result = runDsh(['daemon', 'status'])
    assert(result.code === 0, `${label}: daemon status exited ${result.code}: ${result.stderr.slice(-500)}`)
    const fields = {}
    for (const line of result.stdout.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
    }
    return fields
  }

  const startHost = label => {
    const host = new EntryProcess('host', entries.host, { ...base })
    host.qualificationLabel = label
    hosts.push(host)
    return host
  }
  const waitReady = async (host, label, timeoutMs = 180_000) => {
    const record = await host.waitFor(candidate => candidate.m4a0 === 'ready' || candidate.m4a0 === 'failure', label, timeoutMs)
    assert(record.m4a0 === 'ready',
      `${label} did not reach Ready: ${JSON.stringify({ code: record.code, error: record.error, phase: record.phase })}`)
    return record
  }
  const startReadyHost = async label => {
    const host = startHost(label)
    const ready = await waitReady(host, `${label} ready`)
    host.scopeId = ready.localHost.scopeId
    return { host, ready }
  }
  const stopHost = async (host, label) => {
    const exit = await host.shutdown()
    assert(exit.code === 0, `${label}: the Host did not stop cleanly: ${JSON.stringify(exit)}`)
    if (host.scopeId !== undefined) await seatFree(seatName(host.scopeId), 20_000)
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = label
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  const acpAccess = async (peer, label, value) => {
    const requestId = `acp-access-${String(++sequence)}-${String(process.pid)}`
    peer.send({
      op: 'qualification-acp-access',
      requestId,
      ...(value === undefined ? {} : { acpEnabled: value }),
    })
    return peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === requestId,
      `${label} acp-access`, 120_000)
  }
  const acpPreference = async (peer, label, value) => {
    const requestId = `acp-pref-${String(++sequence)}-${String(process.pid)}`
    peer.send({
      op: 'qualification-acp-autostart',
      requestId,
      ...(value === undefined ? {} : { acpAutoStart: value }),
    })
    return peer.waitFor(entry => entry.op === 'acp-autostart' && entry.requestId === requestId,
      `${label} acp-autostart`, 120_000)
  }
  const assertAccess = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private ACP access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
  }
  /** Wait for the running listener to reach a FINAL state (tolerates a recompose window). */
  const awaitRuntimeState = async (peer, expected, label) => {
    const deadline = Date.now() + 60_000
    let state = 'unknown'
    while (Date.now() < deadline) {
      const record = await acpAccess(peer, `${label} status`, undefined)
      assert(record.ok === true, `${label}: the ACP status call failed: ${JSON.stringify(record.errorCode ?? null)}`)
      state = record.status?.state
      if (state === expected) return record.status
      if (state !== 'disabled' && state !== 'changing') break
      await sleep(250)
    }
    assert(false, `${label}: the running Host never returned to ${expected} (last ${JSON.stringify(state)})`)
  }
  const rawInitialize = async (scopeId, id = 1) => {
    const client = await openAcpClient(scopeDirOf(scopeId))
    try {
      return await client.initialize(id)
    } finally {
      client.close()
    }
  }

  try {
    // ── a) DEFAULT OFF: Ready with NO socket, one real Split TUI and the
    //      ordinary private Peer control are live against the SAME Host. ─────
    const { host: host1, ready: ready1 } = await startReadyHost('acp-po1b default-off host')
    const scopeId = ready1.localHost.scopeId
    assert(findScopeDirBySocket(dshHome) === undefined,
      'a default-off: no acp.sock may be bound anywhere under the profile')
    assert(!exists(socketPathFor(scopeId)),
      'a default-off: the Ready Host must not have bound acp.sock in its own scope')
    const peer = await startPeer('acp-po1b runtime peer')
    assertAccess(await acpAccess(peer, 'a getStatus', undefined), 'disabled', 'a getStatus')
    // PO-5D: the REAL public `daemon status` observes the same live controller.
    const statusDisabledBefore = daemonStatus('a status disabled')
    assert(statusDisabledBefore.acp === 'disabled',
      `a: a disabled listener must report acp=disabled: ${JSON.stringify(statusDisabledBefore)}`)
    assert(statusDisabledBefore['acp-socket'] === undefined,
      'a: a disabled listener must print no endpoint')
    const tui = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    clients.push(tui)
    const tuiReady = await tui.waitFor(record => record.m4a0 === 'ready', 'acp-po1b rented TUI ready', 180_000)
    assert(tuiReady.surfaceMounted === true && tuiReady.transport === 'connected',
      'a default-off: the real Split TUI did not mount its surface with ACP off')
    trace('acp-po1b/default-off', {
      socketBound: false,
      tuiReady: true,
      hostPid: ready1.localHost.hostPid,
      instanceId: ready1.localHost.instanceId,
      scopeId,
    })

    // ── b0) ONE real /acp TUI journey: a disabled Host's painted Enable action
    //      binds the real listener, a staged Disable + Cancel keeps the live
    //      state, the explicit second confirmation retires it on the SAME Host,
    //      and the next-start preference is written once through the page. ───
    const frameOf = async target => (await target.viewport()).join('\n')
    /** Wait for a painted pattern (the page's own settled facts are asynchronous). */
    const waitFrame = async (target, pattern, label, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (pattern.test(await frameOf(target))) return await frameOf(target)
        await sleep(100)
      }
      assert(false, `${label}: the expected frame never appeared:\n${(await frameOf(target)).slice(-2500)}`)
    }
    /**
     * The FROZEN Disable risk sentence. The real page wraps it at the terminal
     * width, so the witness whitespace-normalizes the painted frame (physical
     * line breaks become single spaces) and requires the COMPLETE sentence —
     * a truncated or rewritten tail must fail here, not only in a structural
     * page test.
     */
    const RISK_SENTENCE = 'Disable the local ACP listener? All connected ACP clients will be disconnected. '
      + 'Host sessions, Agents and this TUI will keep running.'
    const flatFrameOf = async target => (await frameOf(target)).replace(/\s+/gu, ' ').trim()
    /** Wait for the WHOLE fixed sentence (wrapping allowed; scroll to read). */
    const waitRiskSentence = async (target, label, timeoutMs = 30_000) => {
      const prefix = 'Disable the local ACP listener?'
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !(await frameOf(target)).includes(prefix)) await sleep(100)
      assert((await frameOf(target)).includes(prefix), `${label}: the risk confirmation never appeared:\n${(await frameOf(target)).slice(-2500)}`)
      // The sentence is a scrollable first-class fact on a short grant: reveal
      // it, then require the complete fixed text (never a prefix-only witness).
      for (let step = 0; step < 6; step += 1) {
        if ((await flatFrameOf(target)).includes(RISK_SENTENCE)) return
        target.send(step === 0 ? '\x1b[H' : '\x1b[6~')
        await sleep(160)
      }
      assert((await flatFrameOf(target)).includes(RISK_SENTENCE),
        `${label}: the risk sentence is NOT complete:\n${(await frameOf(target)).slice(-2500)}`)
    }
    /** Down until the pattern's row owns the cursor (never a fixed key count). */
    const selectRow = async (target, pattern, label, maxSteps = 14) => {
      for (let step = 0; step < maxSteps; step += 1) {
        if (pattern.test(await frameOf(target))) return
        target.send('\x1b[B')
        await sleep(160)
      }
      assert(pattern.test(await frameOf(target)), `${label}: the row was never selected:\n${(await frameOf(target)).slice(-2500)}`)
    }
    /**
     * The accept row and its bar segment exist only while the risk copy shares
     * this frame. If the current grant hides it, walk the ONE real Detail column
     * with the page's own scroll keys instead of confirming a blanked control.
     */
    const waitConfirmAffordance = async (target, label, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      let step = 0
      while (Date.now() < deadline) {
        if (/Confirm \[Enter\]/u.test(await frameOf(target))) return
        target.send(step % 2 === 0 ? '\x1b[H' : '\x1b[6~')
        step += 1
        await sleep(160)
      }
      assert(false, `${label}: the painted Confirm [Enter] affordance never appeared:\n${(await frameOf(target)).slice(-2500)}`)
    }
    const sameSocketIdentity = identity => {
      if (!exists(socketPathFor(scopeId))) return false
      const stat = lstatSync(socketPathFor(scopeId))
      return stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino
    }
    const hostBeforeTui = await hostStatus(host1)
    tui.send('/acp\r')
    await tui.waitForScreen('Settings · Host · ACP access', 'b0: /acp typed deep link', 60_000)
    const firstFrame = await waitFrame(tui, /Listener\s+Disabled/u, 'b0: settled disabled listener')
    assert(/^> Enable ACP(?:\s|$)/mu.test(firstFrame),
      `b0: a disabled Host must focus its ONE real runtime action:\n${firstFrame}`)
    assert(!exists(socketPathFor(scopeId)), 'b0: merely opening /acp must not bind acp.sock')
    const prefBeforeTui = await acpPreference(peer, 'b0 preference read before journey', undefined)
    assert(prefBeforeTui.ok === true && prefBeforeTui.autoStart === false,
      `b0: opening /acp must not change the persisted preference: ${JSON.stringify(prefBeforeTui)}`)
    // ENABLE through the real painted action. The verdict is the REAL Host
    // readback, socket and raw protocol answer — never a specific page word.
    tui.send('\r')
    await waitUntil(() => exists(socketPathFor(scopeId)), 'b0: page Enable to bind acp.sock', 60_000)
    await awaitRuntimeState(peer, 'enabled', 'b0 after the page Enable')
    const pageSocketInfo = lstatSync(socketPathFor(scopeId))
    assert(pageSocketInfo.isSocket() && (pageSocketInfo.mode & 0o777) === 0o600
      && pageSocketInfo.uid === process.getuid(),
    'b0: the page-enabled socket must be a 0600 socket owned by this uid')
    const held = await openAcpClient(scopeDirOf(scopeId))
    const heldInit = await held.initialize(1)
    assert(heldInit?.result?.protocolVersion === 1, 'b0: the page-enabled socket must answer a raw ACP initialize')
    let heldClosed = false
    held.closed.then(() => { heldClosed = true })
    const heldStat = lstatSync(socketPathFor(scopeId))
    const heldSocketIdentity = { dev: heldStat.dev, ino: heldStat.ino }
    await waitFrame(tui, /Listener\s+Enabled/u, 'b0: settled enabled listener')
    // DISABLE stage → complete risk copy + painted Confirm affordance → Cancel.
    // Only observable live facts decide: the held peer stays connected, the SAME
    // socket inode survives, and the Host reports enabled. The L2/VT owner test
    // keeps the precise zero-dispatch proof.
    await selectRow(tui, /^> Disable ACP…(?:\s|$)/mu, 'b0 disable: staged action')
    tui.send('\r')
    await waitRiskSentence(tui, 'b0 disable: risk confirmation')
    await waitConfirmAffordance(tui, 'b0 disable: risk confirmation')
    tui.send('\x1b')
    const afterCancel = await waitFrame(tui, /^> Disable ACP…(?:\s|$)/mu, 'b0 disable: cancelled back to ready')
    assert(/Listener\s+Enabled/u.test(afterCancel), 'b0: Cancel must keep the listener enabled')
    assert(heldClosed === false, 'b0: Cancel must not close the held ACP peer')
    assert(sameSocketIdentity(heldSocketIdentity), 'b0: Cancel must keep the SAME live socket inode')
    assertAccess(await acpAccess(peer, 'b0 status after cancel', undefined), 'enabled', 'b0 status after cancel')
    // A real request/response round-trip on the held peer proves it stayed
    // connected; a second initialize is refused by contract but still answers.
    const secondInitialize = await held.initialize(2)
    assert(secondInitialize?.error !== undefined,
      'b0: the held ACP peer must still answer a real request after Cancel')
    // The SECOND explicit confirmation retires the listener and disconnects the
    // held peer on the SAME Host.
    tui.send('\r')
    await waitRiskSentence(tui, 'b0 disable: risk confirmation again')
    await waitConfirmAffordance(tui, 'b0 disable: risk confirmation again')
    tui.send('\r')
    await held.closed
    await waitUntil(() => !exists(socketPathFor(scopeId)), 'b0: confirmed page disable retires acp.sock')
    await awaitRuntimeState(peer, 'disabled', 'b0 after the confirmed page disable')
    const hostAfterDisable = await hostStatus(host1)
    assert(hostAfterDisable.pid === hostBeforeTui.pid
      && hostAfterDisable.localHost.instanceId === hostBeforeTui.localHost.instanceId,
    'b0: the real TUI page toggle must not replace the Host')
    await waitFrame(tui, /Listener\s+Disabled/u, 'b0: settled disabled listener after the confirm')
    // NEXT HOST START: the SAME page edits the persisted preference Off→On
    // once; the visible choice and confirm are required (never a blind Enter).
    await selectRow(tui, /^> Start automatically(?:\s|$)/mu, 'b0 autostart: row')
    tui.send('\r')
    await tui.waitForScreen('Choose the value the next Host start applies:', 'b0 autostart: choice', 30_000)
    await selectRow(tui, /^> On(?:\s|$)/mu, 'b0 autostart: On candidate')
    tui.send('\r')
    await tui.waitForScreen('Save the next Host start preference as On?', 'b0 autostart: confirm step', 30_000)
    await waitFrame(tui, /Confirm save \[Enter\]/u, 'b0 autostart: painted Confirm save affordance')
    profileTouched = true
    tui.send('\r')
    await waitFrame(tui, /Start automatically\s+On · Change…/u, 'b0 autostart On: persisted re-read')
    const readBackOn = await acpPreference(peer, 'b0 preference read back On', undefined)
    assert(readBackOn.ok === true && readBackOn.autoStart === true,
      `b0: the page-written On preference must read back On: ${JSON.stringify(readBackOn)}`)
    assert(!exists(socketPathFor(scopeId)), 'b0: saving autoStart On must never bind the current Host socket')
    assertAccess(await acpAccess(peer, 'b0 runtime after preference', undefined), 'disabled', 'b0 runtime after preference')
    const hostAfterPreference = await hostStatus(host1)
    assert(hostAfterPreference.pid === hostBeforeTui.pid
      && hostAfterPreference.localHost.instanceId === hostBeforeTui.localHost.instanceId,
    'b0: saving the next-start preference must not replace the Host')
    trace('acp-po1b/tui-journey', {
      pageFirstFrameNonWriting: true,
      slashAcpControl: true,
      enabledViaTui: true,
      cancelledDisableKeptLiveState: true,
      disabledViaTui: true,
      socket0600: true,
      sameHost: true,
      autoStartViaTui: true,
    })
    // Leave the workspace through the REAL Esc ladder, then exit naturally.
    for (let step = 0; step < 4 && (await frameOf(tui)).includes('Settings ·'); step += 1) {
      tui.send('\x1b')
      await sleep(220)
    }
    assert(!(await frameOf(tui)).includes('Settings ·'), 'b0: the Settings workspace must close with the real Esc ladder')
    tui.send('/exit\r')
    await tui.waitForExit(60_000)

    // ── b) ONE independent runtime toggle through the private Peer control:
    //      status/socket/owner-admission/same-Host evidence only. ──────────────
    assertAccess(await acpAccess(peer, 'b enable', true), 'enabled', 'b enable')
    const socketPath = socketPathFor(scopeId)
    assert(exists(socketPath), 'b: enabling the local ACP access must bind acp.sock')
    const info = lstatSync(socketPath)
    assert(info.isSocket(), 'b: the acp.sock path must be a socket')
    assert(info.uid === process.getuid(), 'b: the acp socket must be owned by this uid')
    assert((info.mode & 0o777) === 0o600,
      `b: the acp socket must be 0600, got ${(info.mode & 0o777).toString(8)}`)
    const raw = await openAcpClient(scopeDirOf(scopeId))
    const init = await raw.initialize(1)
    assert(init?.result?.protocolVersion === 1, 'b: the runtime-enabled socket must answer a raw ACP initialize')
    assert(init?.result?.agentInfo?.name === 'dsh-pi-tui', 'b: initialize must name dsh-pi-tui')
    const statusEnabled = daemonStatus('b status enabled')
    assert(statusEnabled.acp === 'enabled',
      `b: an enabled, serving listener must report acp=enabled: ${JSON.stringify(statusEnabled)}`)
    assert(statusEnabled['acp-socket'] === socketPath,
      `b: daemon status must print the live logical endpoint ${socketPath}: ${JSON.stringify(statusEnabled)}`)
    // D4: the read-only route sits behind the official Owner admission. An
    // unauthenticated GET is refused AND carries no ACP state body.
    const instanceRecord = JSON.parse(readFileSync(join(scopeDirOf(scopeId), 'instance.json'), 'utf8'))
    const refused = await fetch(`${instanceRecord.origin}/api/pi-tui.acp-status`, { redirect: 'manual' })
    const refusedBody = await refused.text()
    assert(refused.status === 401 || refused.status === 403,
      `b: an unauthenticated ACP status GET must be refused, got HTTP ${String(refused.status)}`)
    assert(!refusedBody.includes('"state"'),
      'b: an unauthenticated response must not carry the ACP status body')

    const identityBefore = await hostStatus(host1)
    const hostPidBefore = identityBefore.pid
    const instanceBefore = identityBefore.localHost.instanceId

    assertAccess(await acpAccess(peer, 'b disable', false), 'disabled', 'b disable')
    await raw.closed
    await waitUntil(() => !exists(socketPath), 'b: acp.sock to retire after a runtime disable')
    const statusDisabledAfter = daemonStatus('b status disabled after toggle')
    assert(statusDisabledAfter.acp === 'disabled',
      `b: a disabled listener must report acp=disabled: ${JSON.stringify(statusDisabledAfter)}`)
    assert(statusDisabledAfter['acp-socket'] === undefined,
      'b: the retired listener must print no endpoint')
    assert(statusDisabledAfter.pid === statusEnabled.pid && statusDisabledAfter.instance === statusEnabled.instance,
      'b: the SAME Host PID/instance served both daemon status reads across the runtime toggle')
    const afterDisable = await hostStatus(host1)
    assert(afterDisable.pid === hostPidBefore && afterDisable.localHost.instanceId === instanceBefore,
      'b: disabling the listener must not replace the Host')

    trace('acp-po1b/runtime-toggle', {
      disabledAtStart: true,
      enabledSocket0600: true,
      rawInitialize: true,
      disableDisconnectedClient: true,
      disableRetiredSocket: true,
      sameHostProcess: true,
    })

    // ── c) PREFERENCE PERSISTENCE is a DIFFERENT authority ───────────────────
    // The TUI journey above already left runtime Off and the persisted next-
    // start preference On; no second same-intent Peer save is performed here.
    assertAccess(await acpAccess(peer, 'c status before cold restart', undefined), 'disabled', 'c status before cold restart')
    assert((await peer.shutdown()).code === 0, 'c: the runtime peer did not stop')
    await stopHost(host1, 'c first host')

    // The NEXT cold Host on the SAME profile applies autoStart=On: bind before Ready.
    const { host: host2, ready: ready2 } = await startReadyHost('acp-po1b autostart-on host')
    const scopeId2 = ready2.localHost.scopeId
    assert(exists(socketPathFor(scopeId2)),
      'c: with autoStart true the next Host must bind acp.sock BEFORE publishing Ready')
    const init2 = await rawInitialize(scopeId2, 1)
    assert(init2?.result?.protocolVersion === 1, 'c: the auto-start socket must answer a raw initialize')
    const peer2 = await startPeer('acp-po1b autostart peer')

    // ── d/e) A settings-only edit NEVER starts/stops the LIVE listener ───────
    // (Direct cannot runtime-toggle; booting a Direct TUI is not constructible in
    // this lane, so that half is recorded as a boundary and NOT claimed. The
    // Split-observable half is proved here on the auto-started Host, where the
    // runtime is ENABLED: a REAL value-changing save (true→false) keeps it enabled
    // and the SAME Host process serving.)
    trace('acp-po1b/direct-boundary', {
      note: 'Direct has no local ACP listener authority; a Direct TUI runtime check is not booted in this lane (the Direct runtime Unavailable + persisted-only-edit disposition is proven at L2/VT in test/app/settings-acp-controls.test.ts)',
      settingsOnlyEditProvedOnSplit: true,
      // AC-14's stale-generation write-fail-closed fence is proven at L3 in
      // test/domain/remote-acp-access.test.ts (a dispatched setEnabled whose reply
      // is superseded is a SupersededReadError and is NEVER replayed). This lane
      // does not synthesize a live Connection rollover.
      staleGenerationWriteFencedAtL3: true,
    })
    const beforeSave = await hostStatus(host2)
    const savedWhileEnabled = await acpPreference(peer2, 'e preference write while enabled', false)
    assert(savedWhileEnabled.ok === true && savedWhileEnabled.autoStart === false && savedWhileEnabled.readBack === true,
      `e: the settings-only write did not read back: ${JSON.stringify(savedWhileEnabled)}`)
    profileTouched = false
    const stillEnabled = await awaitRuntimeState(peer2, 'enabled', 'e after settings save')
    assert(stillEnabled.state === 'enabled', 'e: the settings-only write must not stop the running listener')
    const afterSave = await hostStatus(host2)
    assert(afterSave.pid === beforeSave.pid && afterSave.localHost.instanceId === beforeSave.localHost.instanceId,
      'e: a settings save replaced the Host process')
    const recomposeKeepsSameHost = afterSave.pid === beforeSave.pid
      && afterSave.localHost.instanceId === beforeSave.localHost.instanceId
    trace('acp-po1b/recompose', {
      sameHostPid: afterSave.pid === beforeSave.pid,
      sameInstanceId: afterSave.localHost.instanceId === beforeSave.localHost.instanceId,
      stillEnabled: true,
    })

    // ── c) continued: the Off preference applies on the NEXT cold Host ───────
    assert((await peer2.shutdown()).code === 0, 'c: the auto-start peer did not stop')
    await stopHost(host2, 'c autostart-on host')
    await waitUntil(() => !exists(socketPathFor(scopeId2)), 'c: the auto-start host socket to retire')

    // A further cold Host with autoStart=Off binds NOTHING.
    const { host: host3, ready: ready3 } = await startReadyHost('acp-po1b autostart-off host')
    const scopeId3 = ready3.localHost.scopeId
    assert(!exists(socketPathFor(scopeId3)), 'c: with autoStart false a new Host must bind NO acp.sock')
    assert(findScopeDirBySocket(dshHome) === undefined, 'c: no acp.sock may remain with autoStart false')
    await stopHost(host3, 'c autostart-off host')
    trace('acp-po1b/preference-persistence', {
      autoStartTrueReadBack: true,
      coldBootBindsBeforeReady: true,
      coldBootRawInitialize: true,
      autoStartFalseReadBack: true,
      coldBootOffBindsNothing: true,
    })

    // ══ AC-10: runtime enable vs an unsafe / occupied socket path (real L6) ══
    // A foreign regular file, then a LIVE foreign server, occupy the Host's own
    // scope pathname. Runtime enable must be REJECTED (never enabled), the Host
    // must stay Ready, the foreign entry must be preserved, and a later clean
    // enable must work — proving dynamic enable honors the same safety rules.
    const { host: host4, ready: ready4 } = await startReadyHost('acp-po1b ac10 host')
    const scopeId4 = ready4.localHost.scopeId
    const scopeDir4 = scopeDirOf(scopeId4)
    const foreignPath = socketPathFor(scopeId4)
    mkdirSync(scopeDir4, { recursive: true, mode: 0o700 })
    const peer4 = await startPeer('acp-po1b ac10 peer')
    assertAccess(await acpAccess(peer4, 'ac10 initial', undefined), 'disabled', 'ac10 initial')
    writeFileSync(foreignPath, 'FOREIGN-REGULAR')
    const rejectFile = await acpAccess(peer4, 'ac10 enable unsafe file', true)
    assert(rejectFile.ok === false, `AC-10: enable over a foreign file must be rejected: ${JSON.stringify(rejectFile.status)}`)
    assert(readFileSync(foreignPath, 'utf8') === 'FOREIGN-REGULAR', 'AC-10: the foreign file must be preserved, never deleted')
    assertAccess(await acpAccess(peer4, 'ac10 after file reject', undefined), 'disabled', 'ac10 after file reject')
    unlinkSync(foreignPath)
    let fd4
    let foreignSrv
    try {
      fd4 = openSync(scopeDir4, 'r')
      foreignSrv = createServer(s => s.destroy())
      await new Promise((resolveListen, rejectListen) => {
        foreignSrv.once('error', rejectListen)
        foreignSrv.listen(`/proc/self/fd/${String(fd4)}/acp.sock`, () => { foreignSrv.off('error', rejectListen); resolveListen() })
      })
      const rejectBusy = await acpAccess(peer4, 'ac10 enable occupied', true)
      assert(rejectBusy.ok === false, 'AC-10: enable over a live foreign listener must be rejected (socket in use)')
      assert(foreignSrv.listening === true, 'AC-10: the live foreign server must keep listening after the rejection')
    } finally {
      // Release the foreign listener + its dirfd on EVERY path (success, assertion
      // failure, timeout, listen failure), preserving the original error.
      if (foreignSrv !== undefined) {
        await new Promise(resolveClose => { foreignSrv.close(() => resolveClose()) })
      }
      if (fd4 !== undefined) closeSync(fd4)
    }
    assertAccess(await acpAccess(peer4, 'ac10 clean enable', true), 'enabled', 'ac10 clean enable')
    assert(lstatSync(foreignPath).isSocket(), 'AC-10: our socket must bind once the foreign entry is gone')
    assertAccess(await acpAccess(peer4, 'ac10 disable again', false), 'disabled', 'ac10 disable again')
    assert((await hostStatus(host4)).pid === ready4.pid, 'AC-10: rejections must never replace or kill the Host')
    trace('acp-po1b/ac10-safety', { unsafeRejected: true, foreignFilePreserved: true, occupiedRejected: true, recovers: true, hostStayedReady: true })
    assert((await peer4.shutdown()).code === 0, 'AC-10: the peer did not stop')
    await stopHost(host4, 'ac10 host')

    // ══ AC-11: autoStart=true + real bind failure → Host still Ready + diag ══
    // Persist autoStart On, stop the Host, place an unsafe foreign file at its
    // scope path, then COLD start: bind fails but the Host must publish Ready and
    // emit one bounded `acp-autostart-unavailable` diagnostic (never crash).
    const { host: host5, ready: ready5 } = await startReadyHost('acp-po1b ac11 seed host')
    const scopeId5 = ready5.localHost.scopeId
    const peer5 = await startPeer('acp-po1b ac11 seed peer')
    const setOn = await acpPreference(peer5, 'ac11 set autostart On', true)
    assert(setOn.ok === true && setOn.autoStart === true, 'AC-11: preference On write failed')
    profileTouched = true
    assert((await peer5.shutdown()).code === 0, 'AC-11: seed peer did not stop')
    await stopHost(host5, 'ac11 seed host')
    const foreignPath11 = socketPathFor(scopeId5)
    mkdirSync(scopeDirOf(scopeId5), { recursive: true, mode: 0o700 })
    writeFileSync(foreignPath11, 'FOREIGN-AUTOSTART')
    const host6 = startHost('acp-po1b ac11 cold host')
    const ready6 = await waitReady(host6, 'ac11 cold host ready')
    host6.scopeId = ready6.localHost.scopeId
    const autostartDiag = (host6.records ?? []).find(record => record.m4a0 === 'diagnostic' && record.code === 'acp-autostart-unavailable')
    assert(autostartDiag !== undefined, 'AC-11: the Host must emit acp-autostart-unavailable when the autoStart bind fails')
    assert(ready6.localHost?.instanceId !== undefined, 'AC-11: the Host still published a normal Ready identity')
    assert(readFileSync(foreignPath11, 'utf8') === 'FOREIGN-AUTOSTART', 'AC-11: the foreign occupant must be preserved')
    unlinkSync(foreignPath11)
    const peer6 = await startPeer('acp-po1b ac11 reset peer')
    const resetOff = await acpPreference(peer6, 'ac11 reset Off', false)
    assert(resetOff.ok === true && resetOff.autoStart === false, 'AC-11: reset preference Off failed')
    profileTouched = false
    assert((await peer6.shutdown()).code === 0, 'AC-11: reset peer did not stop')
    await stopHost(host6, 'ac11 cold host')
    trace('acp-po1b/ac11-autostart-failsoft', { hostReadyDespiteBindFailure: true, diagnosticEmitted: true, foreignPreserved: true })

    // ══ AC-12: SIGTERM while a controller mutation is genuinely IN FLIGHT ══
    // A qualification-only barrier holds the controller INSIDE an accepted
    // mutation; SIGTERM is delivered only AFTER the Host records that it entered
    // the mutation — never inferred from send-time proximity.
    const barrier12 = join(workDir, `ac12-barrier-${String(process.pid)}`)
    writeFileSync(barrier12, '') // pre-create so the initial ENABLE passes the barrier
    const host7 = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_HOST_ACP_MUTATION_BARRIER: barrier12 },
    })
    host7.qualificationLabel = 'acp-po1b ac12 host'
    hosts.push(host7)
    const ready7 = await host7.waitFor(record => record.m4a0 === 'ready' || record.m4a0 === 'failure', 'ac12 host ready', 180_000)
    assert(ready7.m4a0 === 'ready', `AC-12: the Host did not reach Ready: ${JSON.stringify({ code: ready7.code, error: ready7.error })}`)
    host7.scopeId = ready7.localHost.scopeId
    const scopeId7 = ready7.localHost.scopeId
    const peer7 = await startPeer('acp-po1b ac12 peer')
    assertAccess(await acpAccess(peer7, 'ac12 enable', true), 'enabled', 'ac12 enable')
    assert(exists(socketPathFor(scopeId7)), 'AC-12: enabled socket expected before the race')
    const mutationStarts = () => (host7.records ?? []).filter(record => record.m4a0 === 'qualification' && record.op === 'acp-mutation-start').length
    const beforeCount = mutationStarts()
    // Remove the barrier so the NEXT mutation PAUSES inside the controller.
    unlinkSync(barrier12)
    peer7.send({ op: 'qualification-acp-access', requestId: `ac12-race-${String(process.pid)}`, acpEnabled: false })
    // Prove the controller has ENTERED the disable mutation (inFlight) before the signal.
    await waitUntil(() => mutationStarts() > beforeCount, 'AC-12: controller entered the disable mutation', 30_000)
    // NOW deliver SIGTERM while the mutation is provably in flight, then release.
    host7.kill('SIGTERM')
    host7.child.stdin.end()
    writeFileSync(barrier12, '')
    const exit12 = await host7.waitForExit(90_000)
    assert(exit12.code === 0 && exit12.signal === null, `AC-12: shutdown during in-flight mutation ended as ${JSON.stringify(exit12)}`)
    await waitUntil(() => !exists(socketPathFor(scopeId7)), 'AC-12: acp.sock to retire after shutdown during in-flight mutation')
    const cleanupFail12 = (host7.records ?? []).find(record => record.m4a0 === 'cleanup-failure')
    assert(cleanupFail12 === undefined, `AC-12: shutdown during in-flight mutation reported a cleanup failure: ${JSON.stringify(cleanupFail12)}`)
    trace('acp-po1b/ac12-shutdown-race', { mutationInFlight: true, cleanExit: true, socketRetired: true, noCleanupFailure: true })
    try { await peer7.dispose() } catch { /* host is gone */ }

    // ══ AC-20: different Profile/Home concurrent isolation (real L6) ══
    // A SECOND independent installed profile/home runs concurrently with this
    // one. Their scopes/sockets/autoStart are fully independent: enabling,
    // disabling and stopping one never creates, retires or writes the other.
    const secondWorkDir = join(workDir, 'ac20-second')
    const instB = createSplitSmokeProfile({
      tarball: context.tarball,
      targetDshVersion: context.targetDshVersion,
      workDir: secondWorkDir,
    })
    const startFrom = async (label, inst) => {
      const host = new EntryProcess('host', inst.entries.host, { ...inst.base })
      host.qualificationLabel = label
      hosts.push(host)
      const record = await host.waitFor(candidate => candidate.m4a0 === 'ready' || candidate.m4a0 === 'failure', label, 180_000)
      assert(record.m4a0 === 'ready', `${label} did not reach Ready: ${JSON.stringify({ code: record.code, error: record.error })}`)
      host.scopeId = record.localHost.scopeId
      return { host, ready: record, dshHome: inst.dshHome }
    }
    const peerFrom = async (label, inst) => {
      const peer = new EntryProcess('peer', inst.entries.client, {
        ...inst.base,
        env: { ...inst.base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
      })
      peer.qualificationLabel = label
      peers.push(peer)
      await peer.waitFor(record => record.m4a0 === 'ready', label, 180_000)
      return peer
    }
    const sockOf = (home, scopeId) => join(home, 'run', 'dsh-pi-tui', scopeId, 'acp.sock')
    const A = await startFrom('ac20 host A', context.installation)
    const B = await startFrom('ac20 host B', instB)
    const peerA = await peerFrom('ac20 peer A', context.installation)
    const peerB = await peerFrom('ac20 peer B', instB)
    const sockA = sockOf(A.dshHome, A.ready.localHost.scopeId)
    const sockB = sockOf(B.dshHome, B.ready.localHost.scopeId)
    assert(!exists(sockA) && !exists(sockB), 'AC-20: both independent profiles start default-off with no socket')
    assertAccess(await acpAccess(peerA, 'ac20 A enable', true), 'enabled', 'ac20 A enable')
    assert(exists(sockA) && !exists(sockB), 'AC-20: enabling profile A must not create a socket for profile B')
    assertAccess(await acpAccess(peerB, 'ac20 B enable', true), 'enabled', 'ac20 B enable')
    assert(exists(sockA) && exists(sockB), 'AC-20: each Host owns its own independent socket')
    assert(lstatSync(sockA).ino !== lstatSync(sockB).ino, 'AC-20: the two profile sockets are distinct inodes')
    // Persisted autoStart is a SEPARATE authority per profile: A writes On, B
    // must stay at its default Off.
    const aOn = await acpPreference(peerA, 'ac20 A autoStart On', true)
    assert(aOn.ok === true && aOn.autoStart === true, 'AC-20: profile A autoStart On write failed')
    profileTouched = true
    const bBefore = await acpPreference(peerB, 'ac20 B autoStart read', undefined)
    assert(bBefore.ok === true && bBefore.autoStart === false && bBefore.userOverridden === false,
      'AC-20: profile B autoStart must stay default Off after profile A writes On')
    assertAccess(await acpAccess(peerA, 'ac20 A disable', false), 'disabled', 'ac20 A disable')
    assert(!exists(sockA) && exists(sockB), 'AC-20: disabling profile A must not retire profile B socket')
    assert((await peerA.shutdown()).code === 0, 'AC-20: peer A did not stop')
    await stopHost(A.host, 'ac20 host A')
    assert(exists(sockB), 'AC-20: stopping profile A must not delete profile B socket')
    assertAccess(await acpAccess(peerB, 'ac20 B still enabled', undefined), 'enabled', 'ac20 B still enabled')
    assertAccess(await acpAccess(peerB, 'ac20 B disable', false), 'disabled', 'ac20 B disable')
    assert((await peerB.shutdown()).code === 0, 'AC-20: peer B did not stop')
    await stopHost(B.host, 'ac20 host B')
    // Cold boots prove the persisted preference is per-profile: A (On) binds,
    // B (default Off) binds nothing.
    const A2 = await startFrom('ac20 A cold host', context.installation)
    const B2 = await startFrom('ac20 B cold host', instB)
    const sockA2 = sockOf(A2.dshHome, A2.ready.localHost.scopeId)
    const sockB2 = sockOf(B2.dshHome, B2.ready.localHost.scopeId)
    assert(exists(sockA2), 'AC-20: profile A (autoStart On) must bind on cold boot')
    assert(!exists(sockB2), 'AC-20: profile B (autoStart Off) must bind NO socket on cold boot')
    const peerA2 = await peerFrom('ac20 A cold reset peer', context.installation)
    const aReset = await acpPreference(peerA2, 'ac20 A autoStart Off reset', false)
    assert(aReset.ok === true && aReset.autoStart === false, 'AC-20: profile A autoStart reset Off failed')
    profileTouched = false
    assert((await peerA2.shutdown()).code === 0, 'AC-20: cold reset peer did not stop')
    await stopHost(A2.host, 'ac20 A cold host')
    await stopHost(B2.host, 'ac20 B cold host')
    trace('acp-po1b/ac20-isolation', { independentSockets: true, noCrossDelete: true, hostAStopKeepsB: true, distinctProfiles: true, persistedAutoStartIsolated: true, coldBootAOnBinds: true, coldBootBOffNoSocket: true })

    return {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      defaultOffNoSocket: true,
      runtimeToggle: true,
      runtimeOffDisconnects: true,
      preferenceDoesNotChangeRuntime: true,
      autoStartBindsBeforeReady: true,
      autoStartFalseNoSocket: true,
      recomposeKeepsSameHost,
      originalSplitClientIntact: true,
      slashAcpControl: true,
    }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    for (const client of clients) {
      try { await client.dispose() } catch { /* the global backstop owns leftovers */ }
    }
    for (const peer of peers) {
      if (peer.exited) continue
      try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const host of hosts) {
      if (host.exited) continue
      try { host.kill('SIGKILL') } catch { /* already gone */ }
      try { await host.waitForExit(30_000) } catch { /* the global backstop owns leftovers */ }
    }
    // The persisted ACP startup preference is real profile state. When this case
    // may have left it On, restore Off through the REAL Settings wire on a fresh
    // Host/Peer. Best effort: preserve the original failure and expose only the
    // fixed recovery-failure category.
    let recoveryError
    if (profileTouched) {
      const hostBoundary = hosts.length
      const peerBoundary = peers.length
      try {
        const resetHost = startHost('acp-po1b preference reset host')
        await waitReady(resetHost, 'acp-po1b preference reset host ready')
        const resetPeer = await startPeer('acp-po1b preference reset peer')
        const reset = await acpPreference(resetPeer, 'acp-po1b preference reset', false)
        assert(reset.ok === true && reset.autoStart === false && reset.readBack === true,
          `acp-po1b preference reset did not read back Off: ${JSON.stringify(reset)}`)
        trace('acp-po1b/preference-restored', { autoStart: false, readBack: true })
      } catch (error) {
        recoveryError = error
      } finally {
        for (const peer of peers.slice(peerBoundary)) {
          if (peer.exited) continue
          try { await peer.shutdown() } catch { /* best effort */ }
        }
        for (const host of hosts.slice(hostBoundary)) {
          if (host.exited) continue
          try {
            host.kill('SIGTERM')
            host.child.stdin.end()
            await host.waitForExit(60_000)
          } catch {
            try { host.kill('SIGKILL') } catch { /* already gone */ }
          }
        }
      }
    }
    if (recoveryError !== undefined) {
      if (originalError === undefined) throw recoveryError
      trace('acp-po1b/preference-restore-failed', { result: 'recovery-failed-after-case-failure' })
    }
  }
}
