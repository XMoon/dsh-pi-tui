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
  const { EntryProcess, SurfaceEntryProcess, entries, base, dshHome, workDir, trace } = context
  const hosts = []
  const clients = []
  const peers = []
  let sequence = 0
  let profileTouched = false
  let originalError

  const scopeDirOf = scopeId => join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const socketPathFor = scopeId => join(scopeDirOf(scopeId), 'acp.sock')

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
    // ── a) DEFAULT OFF: Ready with NO socket, ordinary transport intact ──────
    const { host: host1, ready: ready1 } = await startReadyHost('acp-po1b default-off host')
    const scopeId = ready1.localHost.scopeId
    assert(findScopeDirBySocket(dshHome) === undefined,
      'a default-off: no acp.sock may be bound anywhere under the profile')
    assert(!exists(socketPathFor(scopeId)),
      'a default-off: the Ready Host must not have bound acp.sock in its own scope')
    const tui = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    clients.push(tui)
    const tuiReady = await tui.waitFor(record => record.m4a0 === 'ready', 'acp-po1b default-off TUI ready', 180_000)
    assert(tuiReady.surfaceMounted === true && tuiReady.transport === 'connected',
      'a default-off: the real Split TUI did not mount its surface with ACP off')
    tui.send('/exit\r')
    try { await tui.waitForExit(60_000) } catch { await tui.dispose() }
    trace('acp-po1b/default-off', { socketBound: false, tuiReady: true })

    // ── b0) REAL TUI Settings → Tools → ACP Server Confirm (end-to-end) ──────
    // The plan requires at least one runtime start/stop driven by the REAL Split
    // TUI Settings keyboard Confirm (not only a Peer invoke): drive the live
    // `/settings` workspace and prove the REAL socket follows.
    const frameOf = async target => (await target.viewport()).join('\n')
    const enterToolsRows = async (target, label) => {
      target.send('/settings\r')
      await target.waitForScreen('Settings ·', `${label}: /settings open`, 60_000)
      for (let step = 0; step < 16; step += 1) {
        if (/^\s*> Tools\b/mu.test(await frameOf(target))) break
        target.send('\x1b[B')
        await sleep(160)
      }
      assert(/^\s*> Tools\b/mu.test(await frameOf(target)), `${label}: the Tools category was never selected`)
      target.send('\r')
      await target.waitForScreen('ACP Server', `${label}: Tools rows`, 30_000)
    }
    const selectAcpServerRow = async (target, label) => {
      target.send('\x1b[H')
      await sleep(160)
      for (let step = 0; step < 12; step += 1) {
        if (/^> ACP Server(?:\s|$)/mu.test(await frameOf(target))) return
        target.send('\x1b[B')
        await sleep(160)
      }
      assert(/^> ACP Server(?:\s|$)/mu.test(await frameOf(target)), `${label}: the ACP Server row was never selected`)
    }
    const selectAcpAutostartRow = async (target, label) => {
      target.send('\x1b[H')
      await sleep(160)
      for (let step = 0; step < 12; step += 1) {
        if (/^> Auto-enable ACP on Host startup(?:\s|$)/mu.test(await frameOf(target))) return
        target.send('\x1b[B')
        await sleep(160)
      }
      assert(/^> Auto-enable ACP on Host startup(?:\s|$)/mu.test(await frameOf(target)),
        `${label}: the Auto-enable ACP on Host startup row was never selected`)
    }
    await seatFree(`\0dsh-pi-tui-c-${String(scopeId).slice(0, 40)}`, 20_000)
    const tuiSettings = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    clients.push(tuiSettings)
    const tuiSettingsReady = await tuiSettings.waitFor(record => record.m4a0 === 'ready', 'acp-po1b settings TUI ready', 180_000)
    assert(tuiSettingsReady.surfaceMounted === true && tuiSettingsReady.transport === 'connected',
      'b0: the real Split TUI did not mount for the Settings confirm path')
    await enterToolsRows(tuiSettings, 'b0 enable')
    await selectAcpServerRow(tuiSettings, 'b0 enable')
    tuiSettings.send('\r') // L2 choice (the Host is currently Off)
    await tuiSettings.waitForScreen('Choose value', 'b0 enable: ACP choice', 30_000)
    tuiSettings.send('\x1b[A') // Off -> On
    await sleep(150)
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Verified', 'b0 enable: Verified', 60_000)
    const tuiSocket = socketPathFor(scopeId)
    assert(exists(tuiSocket), 'b0: the REAL TUI Settings Confirm must bind acp.sock on the running Host')
    const tuiSocketInfo = lstatSync(tuiSocket)
    assert(tuiSocketInfo.isSocket() && (tuiSocketInfo.mode & 0o777) === 0o600,
      'b0: the TUI-enabled socket must be a 0600 socket')
    const tuiHostAfterEnable = await hostStatus(host1)
    // Disable through the SAME real TUI: Esc back to the rows, reopen, pick Off.
    tuiSettings.send('\x1b')
    await tuiSettings.waitForScreen('Visual tools', 'b0 disable: back to rows', 30_000)
    await selectAcpServerRow(tuiSettings, 'b0 disable')
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Choose value', 'b0 disable: ACP choice', 30_000)
    tuiSettings.send('\x1b[B') // On -> Off
    await sleep(150)
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Verified', 'b0 disable: Verified', 60_000)
    await waitUntil(() => !exists(tuiSocket), 'b0: acp.sock to retire after the TUI Confirm disable')
    const tuiHostAfterDisable = await hostStatus(host1)
    assert(tuiHostAfterDisable.pid === tuiHostAfterEnable.pid,
      'b0: the real TUI Settings Confirm toggle must not replace the Host')

    // Plan §4.5: the persisted autoStart preference is ALSO writable from the
    // REAL TUI keyboard (not only via a Peer settings call). Confirm the
    // `Auto-enable ACP on Host startup` row On (Verified = Host write + official
    // authoritative read-back agreed), then restore Off through the SAME path.
    tuiSettings.send('\x1b')
    await tuiSettings.waitForScreen('Visual tools', 'b0 autostart: back to rows', 30_000)
    await selectAcpAutostartRow(tuiSettings, 'b0 autostart On')
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Choose value', 'b0 autostart: choice', 30_000)
    tuiSettings.send('\x1b[A') // Off (default) -> On
    await sleep(150)
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Verified', 'b0 autostart On: Verified', 60_000)
    tuiSettings.send('\x1b')
    await tuiSettings.waitForScreen('Visual tools', 'b0 autostart: back to rows 2', 30_000)
    await selectAcpAutostartRow(tuiSettings, 'b0 autostart Off')
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Choose value', 'b0 autostart: choice 2', 30_000)
    tuiSettings.send('\x1b[B') // On -> Off
    await sleep(150)
    tuiSettings.send('\r')
    await tuiSettings.waitForScreen('Verified', 'b0 autostart Off: Verified', 60_000)
    tuiSettings.send('/exit\r')
    try { await tuiSettings.waitForExit(60_000) } catch { await tuiSettings.dispose() }
    trace('acp-po1b/tui-settings-confirm', { enabledViaTui: true, disabledViaTui: true, socket0600: true, sameHost: true, autoStartViaTui: true })

    // ── b) RUNTIME TOGGLE through the private Peer control ───────────────────
    const peer = await startPeer('acp-po1b runtime peer')
    assertAccess(await acpAccess(peer, 'b getStatus', undefined), 'disabled', 'b getStatus')
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

    const identityBefore = await hostStatus(host1)
    const hostPidBefore = identityBefore.pid
    const instanceBefore = identityBefore.localHost.instanceId

    assertAccess(await acpAccess(peer, 'b disable', false), 'disabled', 'b disable')
    await raw.closed
    await waitUntil(() => !exists(socketPath), 'b: acp.sock to retire after a runtime disable')
    const afterDisable = await hostStatus(host1)
    assert(afterDisable.pid === hostPidBefore && afterDisable.localHost.instanceId === instanceBefore,
      'b: disabling the listener must not replace the Host')

    assertAccess(await acpAccess(peer, 'b re-enable', true), 'enabled', 'b re-enable')
    const reinit = await rawInitialize(scopeId, 2)
    assert(reinit?.result?.protocolVersion === 1, 'b: the re-enabled socket must answer initialize again')
    const afterReEnable = await hostStatus(host1)
    assert(afterReEnable.pid === hostPidBefore && afterReEnable.localHost.instanceId === instanceBefore,
      'b: re-enabling the listener must not replace the Host')
    // Plan §4.5: after re-enabling, the ORIGINAL Split Client/Host must still be
    // usable. Boot a fresh REAL Split TUI against the same Host while ACP is on.
    await seatFree(`\0dsh-pi-tui-c-${String(scopeId).slice(0, 40)}`, 20_000)
    const tui2 = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    clients.push(tui2)
    const tui2Ready = await tui2.waitFor(record => record.m4a0 === 'ready', 'acp-po1b re-enable TUI ready', 180_000)
    assert(tui2Ready.surfaceMounted === true && tui2Ready.transport === 'connected',
      'b: after re-enabling ACP the original Split TUI must still mount its surface')
    tui2.send('/exit\r')
    try { await tui2.waitForExit(60_000) } catch { await tui2.dispose() }
    trace('acp-po1b/runtime-toggle', {
      disabledAtStart: true,
      enabledSocket0600: true,
      rawInitialize: true,
      disableDisconnectedClient: true,
      disableRetiredSocket: true,
      sameHostProcess: true,
    })

    // ── c) PREFERENCE PERSISTENCE is a DIFFERENT authority ───────────────────
    // Runtime is ENABLED from (b); disable it so persisting On can be proven NOT
    // to start the running listener.
    assertAccess(await acpAccess(peer, 'c disable for preference test', false), 'disabled', 'c disable')
    const wroteTrue = await acpPreference(peer, 'c preference write true', true)
    assert(wroteTrue.ok === true && wroteTrue.autoStart === true && wroteTrue.readBack === true,
      `c: the On preference write did not read back On: ${JSON.stringify(wroteTrue)}`)
    profileTouched = true
    await awaitRuntimeState(peer, 'disabled', 'c runtime after preference write')
    trace('acp-po1b/preference-independent', { readBack: true, runtimeUnchanged: true })
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
    const fd4 = openSync(scopeDir4, 'r')
    const foreignSrv = createServer(s => s.destroy())
    await new Promise((resolveListen, rejectListen) => {
      foreignSrv.once('error', rejectListen)
      foreignSrv.listen(`/proc/self/fd/${String(fd4)}/acp.sock`, () => { foreignSrv.off('error', rejectListen); resolveListen() })
    })
    const rejectBusy = await acpAccess(peer4, 'ac10 enable occupied', true)
    assert(rejectBusy.ok === false, 'AC-10: enable over a live foreign listener must be rejected (socket in use)')
    assert(foreignSrv.listening === true, 'AC-10: the live foreign server must keep listening after the rejection')
    await new Promise(resolveClose => foreignSrv.close(() => resolveClose()))
    closeSync(fd4)
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

    // ══ AC-12: a runtime toggle in flight + SIGTERM → one clean shutdown ══
    const { host: host7, ready: ready7 } = await startReadyHost('acp-po1b ac12 host')
    const scopeId7 = ready7.localHost.scopeId
    const peer7 = await startPeer('acp-po1b ac12 peer')
    assertAccess(await acpAccess(peer7, 'ac12 enable', true), 'enabled', 'ac12 enable')
    assert(exists(socketPathFor(scopeId7)), 'AC-12: enabled socket expected before the race')
    // Dispatch a disable WITHOUT awaiting it, then SIGTERM immediately so the
    // toggle races the ONE official shutdown on the controller's serial chain.
    peer7.send({ op: 'qualification-acp-access', requestId: `ac12-race-${String(process.pid)}`, acpEnabled: false })
    host7.kill('SIGTERM')
    host7.child.stdin.end()
    const exit12 = await host7.waitForExit(90_000)
    assert(exit12.code === 0 && exit12.signal === null, `AC-12: shutdown during toggle ended as ${JSON.stringify(exit12)}`)
    await waitUntil(() => !exists(socketPathFor(scopeId7)), 'AC-12: acp.sock to retire after shutdown during toggle')
    const cleanupFail12 = (host7.records ?? []).find(record => record.m4a0 === 'cleanup-failure')
    assert(cleanupFail12 === undefined, `AC-12: shutdown during toggle reported a cleanup failure: ${JSON.stringify(cleanupFail12)}`)
    trace('acp-po1b/ac12-shutdown-race', { cleanExit: true, socketRetired: true, noCleanupFailure: true })
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
    assertAccess(await acpAccess(peerA, 'ac20 A disable', false), 'disabled', 'ac20 A disable')
    assert(!exists(sockA) && exists(sockB), 'AC-20: disabling profile A must not retire profile B socket')
    assert((await peerA.shutdown()).code === 0, 'AC-20: peer A did not stop')
    await stopHost(A.host, 'ac20 host A')
    assert(exists(sockB), 'AC-20: stopping profile A must not delete profile B socket')
    assertAccess(await acpAccess(peerB, 'ac20 B still enabled', undefined), 'enabled', 'ac20 B still enabled')
    assertAccess(await acpAccess(peerB, 'ac20 B disable', false), 'disabled', 'ac20 B disable')
    assert((await peerB.shutdown()).code === 0, 'AC-20: peer B did not stop')
    await stopHost(B.host, 'ac20 host B')
    trace('acp-po1b/ac20-isolation', { independentSockets: true, noCrossDelete: true, hostAStopKeepsB: true, distinctProfiles: true })

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
