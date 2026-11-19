/**
 * M6 PR-A canonical TUI preferences across the real Split Host.
 *
 * ```text
 * real Host Ready -> real authenticated Peer
 *   -> official generated settings.describe('pi-tui-preferences')
 *   -> SettingsForms.mutate(field, revision)  (real ConfigEditor)
 *   -> profile USER cordis.patch.yml canonical row
 *   -> Host stop -> NEW cold Host reads the persisted USER value
 *   -> a stale revision is refused with the official conflict code
 * ```
 *
 * The retired `tui-app` / `split-host-pi-tui-runtime` namespaces are never the
 * write target, and a direct write to the retired namespace cannot recreate
 * the split-authority bug.
 *
 * @module split-process/profile-preferences
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

export async function runProfilePreferencesQualification(context) {
  const { EntryProcess, workDir, dshHome, base, entries, trace } = context
  const hosts = []
  const peers = []
  let requestSequence = 0

  const startHost = async label => {
    const host = new EntryProcess('host', entries.host, { ...base })
    hosts.push(host)
    const ready = await host.waitFor(record => record.m4a0 === 'ready', `${label} Host ready`, 240_000)
    trace('profile-preferences/host-ready', { label, pid: ready.pid })
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
  const preferenceRequest = async (peer, request, label) => {
    const requestId = `pr-a-pref-${++requestSequence}`
    peer.send({ op: 'qualification-tui-preferences', requestId, ...request })
    const record = await peer.waitFor(entry => entry.op === 'tui-preferences' && entry.requestId === requestId,
      `${label} tui-preferences`, 120_000)
    return record
  }
  const readPreferences = async (peer, label) => {
    const record = await preferenceRequest(peer, {}, label)
    assert(record.ok === true && record.action === 'read', `${label}: canonical preferences are not readable`)
    assert(record.ns === 'pi-tui-preferences', `${label}: the Peer read a non-canonical namespace`)
    assert(typeof record.revision === 'number', `${label}: the revision fence is missing`)
    return record
  }
  const parseJson = (text, label) => {
    try {
      return JSON.parse(String(text ?? '{}'))
    } catch {
      throw new SplitSmokeAssertionError(`${label}: the wire value is not JSON`)
    }
  }

  let verdict
  try {
    // ── 1. Default Host: canonical section alive over the real wire ───────
    const first = await startHost('PR-A default')
    const peer = await startPeer('PR-A')
    const initial = await readPreferences(peer, 'PR-A initial')
    const initialValue = parseJson(initial.valueText, 'PR-A initial value')
    assert(initialValue.theme === 'auto',
      `PR-A: the canonical row projects its schema default; got ${JSON.stringify(initialValue.theme)}`)
    assert(initial.userText === undefined || JSON.parse(initial.userText).theme === undefined,
      'PR-A: a default profile owns no USER theme')

    // ── 2. Canonical write through the official settings wire ─────────────
    const write = await preferenceRequest(peer, {
      tuiPreferencesField: 'theme',
      tuiPreferencesValue: 'dark',
      tuiPreferencesRevision: initial.revision,
    }, 'PR-A canonical write')
    assert(write.ok === true && write.action === 'write',
      `PR-A: the canonical write failed: ${JSON.stringify({ code: write.errorCode, error: write.error })}`)
    assert(write.readBack === true, 'PR-A: the authoritative re-read did not see the committed theme')
    const settledValue = parseJson(write.valueText, 'PR-A settled value')
    const settledUser = parseJson(write.userText, 'PR-A settled user')
    assert(settledValue.theme === 'dark' && settledUser.theme === 'dark',
      'PR-A: both the effective and USER layers carry the committed theme')

    // The durable document is the profile USER patch, never a second file.
    const patchPath = join(dshHome, 'profiles', 'pi-tui', 'cordis.patch.yml')
    const rows = parseYaml(readFileSync(patchPath, 'utf8'))
    const canonicalRow = Array.isArray(rows) ? rows.find(row => row?.id === 'pi-tui-preferences') : undefined
    assert(canonicalRow !== undefined, 'PR-A: the profile patch carries the canonical USER row')
    assert(canonicalRow.insert === undefined, 'PR-A: the persisted row is an ordinary USER row')
    assert(canonicalRow.config?.theme === 'dark', 'PR-A: the canonical row stores the committed theme')

    // ── 3. A stale revision is the official conflict ──────────────────────
    const stale = await preferenceRequest(peer, {
      tuiPreferencesField: 'theme',
      tuiPreferencesValue: 'light',
      tuiPreferencesRevision: initial.revision,
    }, 'PR-A stale write')
    assert(stale.ok === false, 'PR-A: a write against the pre-commit revision must be refused')
    assert(/conflict/iu.test(String(stale.errorCode ?? '')) || /conflict/iu.test(String(stale.error ?? '')),
      `PR-A: the stale write must report the official conflict, got ${JSON.stringify(stale.errorCode)}`)
    const afterStale = await readPreferences(peer, 'PR-A after stale')
    assert(parseJson(afterStale.valueText, 'PR-A after stale').theme === 'dark',
      'PR-A: the refused write left the committed theme untouched')

    await peer.shutdown()
    await first.host.shutdown()

    // ── 5. Cold Host reads the SAME persisted USER value ──────────────────
    const second = await startHost('PR-A cold')
    const coldPeer = await startPeer('PR-A cold')
    const cold = await readPreferences(coldPeer, 'PR-A cold read')
    const coldValue = parseJson(cold.valueText, 'PR-A cold value')
    const coldUser = parseJson(cold.userText, 'PR-A cold user')
    assert(coldValue.theme === 'dark', 'PR-A: a cold Host must read the persisted canonical theme')
    assert(coldUser.theme === 'dark', 'PR-A: the cold USER layer carries the persisted theme')
    await coldPeer.shutdown()
    await second.host.shutdown()

    verdict = {
      status: 'PASS',
      scope: 'REAL_SPLIT_PROCESS_L6',
      canonicalActive: true,
      persistedAcrossColdHost: coldUser.theme === 'dark',
      staleRevisionRefused: true,
    }
  } catch (error) {
    verdict = {
      status: 'FAIL',
      scope: 'REAL_SPLIT_PROCESS_L6',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    for (const peer of peers) await peer.shutdown().catch(() => {})
    for (const host of hosts) await host.shutdown().catch(() => {})
  }
  trace('profile-preferences/verdict', verdict)
  return verdict
}
