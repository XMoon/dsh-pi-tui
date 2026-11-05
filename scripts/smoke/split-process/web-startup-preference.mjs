/**
 * M5-W PR-C profile-owned Web startup preference and the real TUI /web entry.
 *
 * @module split-process/web-startup-preference
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { writeC1WorkFixture, readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  assertClientHostFacts,
  assertIdentityFields,
  connectCookie,
  fetchStatus,
  hostStatus,
  lastSurfaceStatus,
  readJson,
  saveFile,
  seatFree,
  waitForCondition,
  waitForOutcome,
  waitForSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEventAfter,
  waitForHostSessionHeader,
} from '../../lib/split-smoke-sessions.mjs'
import {
  PR_A_CLIENT_MODULES_PACKAGE,
  PR_A_SINGLETON_PACKAGES,
  PR_A_WEB_ROWS,
  PR_A_WEB_RUNTIME_ID,
  PR_A_WELCOME_NOTICE_VERSION,
  assertWebIndexQualified,
  browserDriverExitBounded,
  openSseFrames,
  readHostWebIndex,
  redactWebQualificationText,
  sseProbe,
  whileBrowserDriverRuns,
} from './web-helpers.mjs'

const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

export async function runWebStartupPreference(context) {
  const { EntryProcess, SurfaceEntryProcess, workDir, dshHome, base, entries, targetDshVersion, trace } = context
  let webScopeSuffix
  let statusSequence = 0
  const autostartRoot = join(workDir, 'pr-c-autostart')
  mkdirSync(autostartRoot, { recursive: true, mode: 0o700 })
  chmodSync(autostartRoot, 0o700)
  const hosts = []
  const clients = []
  const peers = []
  const rowStates = ready => new Map(PR_A_WEB_ROWS.map(row => [row.id,
    (ready.entries ?? []).find(entry => entry.id === row.id)?.state]))
  /** No declared Web row is live (absent/state-4 are plainly off). */
  const assertFullyOff = (ready, label) => {
    const live = [...rowStates(ready)]
      .filter(([, state]) => state !== 'absent' && state !== 'state-4')
      .map(([id, state]) => `${id}:${state ?? 'missing'}`)
    assert(live.length === 0, `${label}: these Web rows are not plainly off: ${live.join(',')}`)
  }
  /** Every declared Web row is ACTIVE except the ONE allowed pending row. */
  const assertFullyOn = (ready, label) => {
    const notActive = [...rowStates(ready)]
      .filter(([id, state]) => id !== 'ui-deliverables' && state !== 'active')
      .map(([id, state]) => `${id}:${state ?? 'missing'}`)
    assert(notActive.length === 0, `${label}: these Web rows are not active: ${notActive.join(',')}`)
  }
  /** The ordinary HTTP facts of a Host with no served frontend. */
  const assertHttpOff = async (origin, label) => {
    const root = await fetchStatus(`${origin}/`)
    assert(root.status === 404, `${label}: GET / must be 404 with Web off, got ${root.status}`)
    const api = await fetchStatus(`${origin}/api`)
    assert(api.status === 401, `${label}: unauthenticated /api must stay 401, got ${api.status}`)
    return { root: root.status, api: api.status }
  }
  const assertServing = async (origin, launch, label) => {
    const facts = await readHostWebIndex(origin, launch, label)
    assertWebIndexQualified(facts, label, targetDshVersion)
    assert(facts.index.status === 200 && facts.graph !== undefined,
      `${label}: the authenticated Web index is not served (HTTP ${facts.index.status})`)
    const sse = await sseProbe(origin, '/plugins/events')
    assert(sse.status === 200 && sse.contentType.startsWith('text/event-stream'),
      `${label}: /plugins/events is not a live stream (${sse.status})`)
    return { index: facts.index.status, graphEntries: facts.graph.entries.length, sse: sse.status }
  }
  const startHost = async label => {
    const host = new EntryProcess('host', entries.host, { ...base })
    hosts.push(host)
    const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 240_000)
    if (webScopeSuffix === undefined) webScopeSuffix = ready.localHost.scopeId.slice(0, 40)
    return { host, ready }
  }
  const startPeer = async label => {
    const peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peers.push(peer)
    await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
    return peer
  }
  const startTui = async label => {
    await seatFree(`\0dsh-pi-tui-c-${webScopeSuffix}`, 15_000)
    const tui = new SurfaceEntryProcess(entries.client, { ...base, workDir })
    clients.push(tui)
    const ready = await tui.waitFor(record => record.m4a0 === 'ready', `${label} TUI ready`, 180_000)
    assert(ready.surfaceMounted === true && ready.transport === 'connected',
      `${label}: the real Split TUI did not mount its surface`)
    return tui
  }
  const webAccess = async (peer, label, value) => {
    const requestId = `prc-${++statusSequence}`
    peer.send({
      op: 'qualification-web-access',
      requestId,
      ...(value === undefined ? {} : { webAccessEnabled: value }),
    })
    return peer.waitFor(entry => entry.op === 'web-access' && entry.requestId === requestId,
      `${label} web-access`, 300_000)
  }
  const assertToggle = (record, expected, label) => {
    assert(record.ok === true, `${label}: the private Web access call failed: ${JSON.stringify(record.errorCode ?? null)}`)
    assert(record.status?.state === expected,
      `${label}: the Host reported ${JSON.stringify(record.status)} instead of ${expected}`)
  }
  const webPreference = async (peer, label, value) => {
    const requestId = `prc-pref-${++statusSequence}`
    peer.send({
      op: 'qualification-web-autostart',
      requestId,
      ...(value === undefined ? {} : { webAutoStart: value }),
    })
    return peer.waitFor(entry => entry.op === 'web-autostart' && entry.requestId === requestId,
      `${label} web-autostart`, 120_000)
  }
  const webAccessUrl = async (peer, label) => {
    const requestId = `prc-url-${++statusSequence}`
    peer.send({ op: 'qualification-web-access-url', requestId })
    return peer.waitFor(entry => entry.op === 'web-access-url' && entry.requestId === requestId,
      `${label} web-access-url`, 120_000)
  }
  let originalError
  try {
    // ── A. Default-Off Host + save On through the real Remote settings ───
    const first = await startHost('PC-07 default-off')
    const origin = first.ready.localHost.origin
    assertFullyOff(first.ready, 'PC-07a')
    const offHttp = await assertHttpOff(origin, 'PC-07a')
    const firstPid = first.ready.pid
    const peer = await startPeer('PC-07')
    assertToggle(await webAccess(peer, 'PC-07a status', undefined), 'disabled', 'PC-07a getStatus')

    const beforeSave = await webPreference(peer, 'PC-07a read', undefined)
    assert(beforeSave.ok === true && beforeSave.autoStart === false && beforeSave.userOverridden === false,
      `PC-07 the default preference is ${JSON.stringify(beforeSave)}`)
    const savedOn = await webPreference(peer, 'PC-07 write On', true)
    assert(savedOn.ok === true && savedOn.autoStart === true && savedOn.userOverridden === true && savedOn.readBack === true,
      `PC-07 the preference write did not read back On: ${JSON.stringify(savedOn)}`)
    // Saving the preference must NOT change the running Host.
    assertToggle(await webAccess(peer, 'PC-07a after-save', undefined), 'disabled', 'PC-07a after-save')
    const stillOff = await assertHttpOff(origin, 'PC-07a after-save')
    trace('t74-web-preference-saved', {
      readBack: savedOn.autoStart,
      userOverridden: savedOn.userOverridden,
      runningHostStillOff: stillOff.root === 404,
      hostPid: firstPid,
    })

    // ── B. The real TUI `/web → Enable Web` serves the frontend (PC-04/06) ──
    const tui = await startTui('PC-06 TUI')
    tui.send('/web\r')
    await tui.waitForScreen('Status: disabled', 'PC-06 menu')
    // The overlay owns the keyboard: ONE arrow per chunk, and the selected
    // row's own description is the authoritative "the move landed" signal.
    tui.send('\u001b[B')
    await tui.waitForScreen('Start serving the official Web frontend', 'PC-06 Enable row')
    tui.send('\r')
    await tui.waitForScreen('Status: enabled', 'PC-06 enabled projection')
    const enabledStatus = await hostStatus(first.host)
    assertFullyOn(enabledStatus, 'PC-06 enabled')
    assert(enabledStatus.pid === firstPid, 'PC-06 the enable changed the Host process')
    const launch = readJson(join(dshHome, 'run', 'dsh-pi-tui', first.ready.localHost.scopeId, 'launch.json'))
    const serving = await assertServing(origin, launch, 'PC-06')
    // Close the menu (Esc) before the TUI receives ordinary input: the open
    // overlay owns the keyboard, so a prompt typed into it would only edit
    // the list's own search box.
    tui.send('\u001b')
    await tui.waitForScreenGone('Status: enabled', 'PC-06 menu closed')
    // The TUI keeps working on the serving Host.
    tui.send('pc-06 tui works\r')
    await tui.waitForScreen('pc-06 tui works', 'PC-06 TUI prompt')
    trace('t74-web-tui-enable', {
      index: serving.index,
      graphEntries: serving.graphEntries,
      sse: serving.sse,
      tuiPromptAccepted: true,
      sameHostProcess: true,
    })

    // ── C. The official authenticated URL (PC-05) ───────────────────────
    const link = await webAccessUrl(peer, 'PC-05')
    assert(link.ok === true, `PC-05 the authenticated URL call failed: ${JSON.stringify(link.errorCode ?? null)}`)
    assert(link.loopback === true && link.protocol === 'http:' && link.pathname === '/',
      `PC-05 the launch URL is not the loopback Web root: ${JSON.stringify(link)}`)
    assert(link.tokenParams === 1 && link.paramNames?.length === 1 && link.paramNames[0] === 'token',
      `PC-05 the launch URL does not carry exactly the official token parameter: ${JSON.stringify(link)}`)
    assert(link.exchangeStatus >= 300 && link.exchangeStatus < 400,
      `PC-05 the launch URL was not exchanged for a cookie (HTTP ${String(link.exchangeStatus)})`)
    assert(link.pageStatus === 200 && link.pageBytes > 1024,
      `PC-05 the cookie did not reach the served page (HTTP ${String(link.pageStatus)}, ${String(link.pageBytes)} bytes)`)
    assert(!('url' in link) && !('token' in link), 'PC-05 the URL/token leaked into a record')
    // Copy Link through the SAME real TUI menu (enabled projection): rows are
    // status -> Open Browser -> Copy Link, so two Downs then Enter. Only the
    // clipboard acknowledgement may be painted.
    tui.send('/web\r')
    await tui.waitForScreen('Status: enabled', 'PC-05 menu')
    tui.send('\u001b[B')
    await tui.waitForScreen('Request the OS to open the official Web home page', 'PC-05 Open Browser row')
    tui.send('\u001b[B')
    await tui.waitForScreen('Copy the authenticated Web home link to the clipboard', 'PC-05 Copy Link row')
    tui.send('\r')
    // The copy result is painted INSIDE the open menu (the overlay covers the
    // base notice line at the smoke's PTY height).
    await tui.waitForScreen('Link copied', 'PC-05 copy acknowledgement')
    const copyScreen = (await tui.viewport()).join('\n')
    assert(!copyScreen.includes('token='), 'PC-05 the launch URL/token was painted by Copy Link')
    assert(copyScreen.includes('Link copied'), 'PC-05 the copy acknowledgement disappeared')
    trace('t74-web-authenticated-url', {
      exchangeStatus: link.exchangeStatus,
      pageStatus: link.pageStatus,
      pageBytes: link.pageBytes,
      tokenParameter: link.tokenParams,
      urlEmitted: false,
      copyAcknowledged: true,
    })

    // ── D. Manual `/web Disable` keeps the TUI working (PC-08) ──────────
    // Continue in the SAME menu the copy settled on: rows are status ->
    // copy result -> Open -> Copy -> Disable (the notice row is a disabled
    // fact but still a cursor stop). One arrow per chunk, each move proven
    // by the row's own selected description.
    tui.send('\u001b[B')
    await tui.waitForScreen('Action result.', 'PC-08 copy result row')
    tui.send('\u001b[B')
    await tui.waitForScreen('Request the OS to open the official Web home page', 'PC-08 Open Browser row')
    tui.send('\u001b[B')
    await tui.waitForScreen('Copy the authenticated Web home link to the clipboard', 'PC-08 Copy Link row')
    tui.send('\u001b[B')
    await tui.waitForScreen('Stop serving the official Web frontend', 'PC-08 Disable row')
    tui.send('\r')
    await tui.waitForScreen('Status: disabled', 'PC-08 disable')
    const disabledStatus = await hostStatus(first.host)
    assertFullyOff(disabledStatus, 'PC-08 manual disable')
    assert(disabledStatus.pid === firstPid, 'PC-08 the disable changed the Host process')
    await assertHttpOff(origin, 'PC-08 manual disable')
    tui.send('\u001b')
    await tui.waitForScreenGone('Status: disabled', 'PC-08 menu closed')
    tui.send('pc-08 after disable\r')
    await tui.waitForScreen('pc-08 after disable', 'PC-08 TUI prompt after disable')
    // Saving Off does not change the running Host's FINAL Web state. The
    // official Settings write reconciles/recomposes the profile and briefly
    // re-applies the overlay's disabled rows; the Host service restores its
    // live target after the official `app-boot/config-reload`. Owner-agreed
    // semantics: the FINAL state is preserved, a brief browser disconnect is
    // allowed. Wait for the final state, never poll-as-success without a bound.
    const savedOff = await webPreference(peer, 'PC-08 write Off', false)
    assert(savedOff.ok === true && savedOff.autoStart === false && savedOff.readBack === true,
      `PC-08 the Off write did not read back: ${JSON.stringify(savedOff)}`)
    assertToggle(await webAccess(peer, 'PC-08 re-enable', true), 'enabled', 'PC-08 re-enable')
    const enabledBeforeSaves = await hostStatus(first.host)
    assert(enabledBeforeSaves.pid === firstPid, 'PC-08 the re-enable changed the Host process')

    /** Wait for the post-recomposition repair to reach the FINAL target. */
    const awaitFinalWebState = async (label, expected) => {
      const deadline = Date.now() + 60_000
      let state = 'unknown'
      while (Date.now() < deadline) {
        const record = await webAccess(peer, `${label} status`, undefined)
        assert(record.ok === true, `${label}: the Web status call failed: ${JSON.stringify(record.errorCode ?? null)}`)
        state = record.status?.state
        if (state === expected) return record.status
        // A recomposition window legitimately shows disabled/changing; any
        // other state (`unavailable`) is a real failure, not a wait.
        if (state !== 'disabled' && state !== 'changing') break
        await sleep(250)
      }
      assert(false, `${label}: the running Host never returned to ${expected} (last ${JSON.stringify(state)})`)
    }
    // 1) Saving the SAME value (no value change) must preserve the final state.
    const sameValueOff = await webPreference(peer, 'PC-08 same-value Off save', false)
    assert(sameValueOff.ok === true && sameValueOff.autoStart === false && sameValueOff.readBack === true,
      `PC-08 the same-value Off save did not read back: ${JSON.stringify(sameValueOff)}`)
    await awaitFinalWebState('PC-08 same-value Off save', 'enabled')
    // 2) Saving a CHANGED value (On) must preserve it too.
    const changedOn = await webPreference(peer, 'PC-08 changed On save', true)
    assert(changedOn.ok === true && changedOn.autoStart === true && changedOn.readBack === true,
      `PC-08 the changed On save did not read back: ${JSON.stringify(changedOn)}`)
    await awaitFinalWebState('PC-08 changed On save', 'enabled')
    // 3) The FINAL save returns the preference to Off for the next cold boot,
    //    and the running Host still ends enabled.
    const finalOff = await webPreference(peer, 'PC-08 final Off save', false)
    assert(finalOff.ok === true && finalOff.autoStart === false && finalOff.readBack === true,
      `PC-08 the final Off save did not read back: ${JSON.stringify(finalOff)}`)
    await awaitFinalWebState('PC-08 final Off save', 'enabled')
    const afterSaves = await hostStatus(first.host)
    assert(afterSaves.pid === firstPid, 'PC-08 a settings save replaced the Host process')
    assertFullyOn(afterSaves, 'PC-08 after preference saves')
    const savedLaunch = readJson(join(dshHome, 'run', 'dsh-pi-tui', first.ready.localHost.scopeId, 'launch.json'))
    const stillServing = await assertServing(origin, savedLaunch, 'PC-08 after preference saves')
    trace('t74-web-recompose-repair', {
      sameValueSave: 'final enabled',
      changedValueSave: 'final enabled',
      finalOffSave: 'final enabled',
      index: stillServing.index,
      graphEntries: stillServing.graphEntries,
      sameHostProcess: true,
      transientRecomposeAccepted: true,
    })
    tui.send('/exit\r')
    assert((await tui.waitForExit(60_000)).code === 0, 'PC-08 the TUI did not exit normally')
    assert((await peer.shutdown()).code === 0, 'PC-08 the peer did not stop')
    assert((await first.host.shutdown()).code === 0, 'PC-08 the first Host did not stop')

    // ── E. The NEXT cold boot applies the (now Off) preference ──────────
    const second = await startHost('PC-08 next cold boot')
    assertFullyOff(second.ready, 'PC-08 next cold boot')
    assert(second.ready.pid !== firstPid, 'PC-08 the next Host must be a NEW process')
    await assertHttpOff(second.ready.localHost.origin, 'PC-08 next cold boot')
    trace('t74-web-autostart-next-boot-off', {
      hostPid: second.ready.pid,
      previousHostPid: firstPid,
      webRowsLive: 0,
      preferenceApplied: 'off',
    })
    assert((await second.host.shutdown()).code === 0, 'PC-08 the second Host did not stop')

    // ── F. Save On, stop, and prove the NEXT Host auto-starts (PC-07) ───
    const third = await startHost('PC-07 preference-off')
    assertFullyOff(third.ready, 'PC-07b')
    const thirdPid = third.ready.pid
    const peer2 = await startPeer('PC-07b')
    const onAgain = await webPreference(peer2, 'PC-07b write On', true)
    assert(onAgain.ok === true && onAgain.autoStart === true, 'PC-07 the second On write did not settle')
    assertToggle(await webAccess(peer2, 'PC-07b after-save', undefined), 'disabled',
      'PC-07 saving On enabled the running Host')
    await peer2.shutdown()
    assert((await third.host.shutdown()).code === 0, 'PC-07 the third Host did not stop')

    const autostarted = await startHost('PC-07 auto-start')
    assert(autostarted.ready.pid !== thirdPid, 'PC-07 the auto-start Host must be a NEW process')
    assertFullyOn(autostarted.ready, 'PC-07 auto-start')
    assert(autostarted.host.records.some(record => record.m4a0 === 'web-autostart' && record.status === 'enabled'),
      'PC-07 the Host did not record the applied auto-start')
    const autoLaunch = readJson(join(dshHome, 'run', 'dsh-pi-tui', autostarted.ready.localHost.scopeId, 'launch.json'))
    const autoServing = await assertServing(autostarted.ready.localHost.origin, autoLaunch, 'PC-07 auto-start')
    // A real TUI + Agent turn on the auto-started Host.
    const tui2 = await startTui('PC-07 TUI')
    tui2.send('pc-07 autostart turn\r')
    await tui2.waitForScreen('pc-07 autostart turn', 'PC-07 TUI prompt')
    await tui2.waitForScreen('stub answer', 'PC-07 Agent answer')
    tui2.send('/exit\r')
    assert((await tui2.waitForExit(60_000)).code === 0, 'PC-07 the TUI did not exit normally')
    assert((await autostarted.host.shutdown()).code === 0, 'PC-07 the auto-start Host did not stop')
    trace('t74-web-autostart', {
      previousHostPid: thirdPid,
      hostPid: autostarted.ready.pid,
      rowsActiveBeforeReady: [...rowStates(autostarted.ready)]
        .filter(([, state]) => state === 'active').length,
      autostartRecord: 'web-autostart enabled before ready',
      index: autoServing.index,
      graphEntries: autoServing.graphEntries,
      sse: autoServing.sse,
      tuiAgentTurn: 'accepted and answered',
      hiddenSameProcessRemount: false,
    })
    return { verified: true }
  } catch (error) {
    originalError = error
    throw error
  } finally {
    for (const client of clients) {
      try { await client.dispose() } catch { /* best effort */ }
    }
    for (const peer of peers) {
      if (peer.exited) continue
      try { await peer.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    for (const host of hosts) {
      if (host.exited) continue
      try { await host.shutdown() } catch { /* the global backstop owns leftovers */ }
    }
    // D3: the profile-owned preference is persistent state. Restore it through
    // the REAL Settings wire on a fresh Host/Peer even when the case failed
    // after changing it, and fail this case if the read-back does not confirm
    // Off. Never rewrite the preference file directly.
    let recoveryError
    if (webScopeSuffix !== undefined) {
      // Track array boundaries because startHost()/startPeer() publish their
      // process BEFORE waiting for Ready. If the wait throws, the local
      // cleanup must still find and stop those partially-started processes.
      const hostBoundary = hosts.length
      const peerBoundary = peers.length
      try {
        await startHost('PC-08 final preference reset')
        const resetPeer = await startPeer('PC-08 final preference reset')
        const reset = await webPreference(resetPeer, 'PC-08 final preference reset', false)
        assert(reset.ok === true && reset.autoStart === false && reset.readBack === true,
          `PC-08 final preference reset did not read back Off: ${JSON.stringify(reset)}`)
        trace('t74-web-preference-restored', { autoStart: false, readBack: true })
      } catch (error) {
        recoveryError = error
      } finally {
        for (const peer of peers.slice(peerBoundary)) {
          if (peer.exited) continue
          try { await peer.shutdown() } catch { /* best effort */ }
        }
        for (const host of hosts.slice(hostBoundary)) {
          if (host.exited) continue
          try { await host.shutdown() } catch { /* best effort */ }
        }
      }
    }
    if (recoveryError !== undefined) {
      if (originalError === undefined) throw recoveryError
      // Preserve the original qualification failure; expose only the fixed
      // recovery failure category, never raw error text or the settings value.
      trace('t74-web-preference-restore-failed', { result: 'recovery-failed-after-case-failure' })
    }
  }
}
