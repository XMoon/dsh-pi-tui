/**
 * One C1 continuity scene: the real Host/Client/fixture lifecycle a recovery,
 * multi-client or navigation case owns.
 *
 * `createC1Scene(context)` builds everything a C1 scenario needs from the ONE
 * installation the runner passes — the isolated work fixture, the Host work
 * roots, the REAL Host constructor and the REAL PTY surface Client — and keeps
 * its own Host/Client lists so `dispose()` releases exactly what this scene
 * created. There is no cross-case singleton: every case (and the temporary
 * legacy bridge for the still-inline T44-T66 block) creates its own scene.
 *
 * The scene learns the run's scope id from its OWN first real Ready record
 * (§4.3): a first boot relies on the kernel seat claim itself, and the seat is
 * only observed for release AFTER the scene's Host was stopped.
 *
 * @module split-process/c1-scene
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { writeC1WorkFixture } from '../../lib/split-smoke-fixtures.mjs'
import {
  assertIdentityFields,
  hostStatus,
  seatFree,
  waitForSurfaceStatus,
} from '../../lib/split-smoke-processes.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * The Loader row identities that carry Host authority or a Host-only business
 * service. Their live `fiber.uid` is the fact a Client-only surface revision
 * must not change: a re-mounted row would publish a new fiber.
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
  'split-host-account-controller',
  'split-host-session-log-download',
  'split-host-pi-tui-runtime',
  'pi-tui-performance-host',
  'pi-tui-visual-tools',
]

/**
 * Build ONE isolated C1 scene and return its real lifecycle helpers.
 *
 * The caller owns `dispose()` in a `finally`; the runner still owns the work
 * root, the process backstop and the abort cleanup.
 */
export function createC1Scene(context, options = {}) {
  const { EntryProcess, SurfaceEntryProcess, entries, base, workDir, installation } = context
  const { profileDir } = installation
  const c1Work = writeC1WorkFixture(profileDir, workDir, options)
  const c1Hosts = []
  const c1Clients = []
  /** This scene's full 64-character scope id, learned from its first Ready. */
  let hostScopeId

  const c1WorkRoot = label => {
    const root = join(workDir, `c1-${label}`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    return root
  }
  /**
   * The `job` scenarios' release barrier must be visible INSIDE the Job's
   * workspace-write sandbox. bwrap mounts an ephemeral `/tmp` there and binds
   * only the session workspace, which is the installed profile; a barrier under
   * the smoke work dir (also `/tmp`) would be invisible and the Job could never
   * settle. The profile is still inside the isolated OS temp work dir, not the
   * checkout.
   */
  const c1JobWorkRoot = label => {
    const root = join(profileDir, `c1-${label}`)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    return root
  }
  const startC1Host = async (scenario, label, extraEnv = {}, workRoot = c1WorkRoot(label)) => {
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
    const ready = await host.waitFor(record => record.m4a0 === 'ready' || record.m4a0 === 'failure', `${label} Host ready`, 180_000)
    assert(ready.m4a0 === 'ready',
      `${label} Host boot failed: ${JSON.stringify({ code: ready.code, error: ready.error, phase: ready.phase })}`)
    if (hostScopeId === undefined) hostScopeId = ready.localHost?.scopeId
    return { host, ready, workRoot }
  }
  const stopC1Host = async host => {
    if (host.exited) return
    try { await host.shutdown() } catch { /* the global backstop kills leftovers */ }
  }
  const startC1Client = async (label, extraEnv = {}, options = {}) => {
    // A real `surface` Client holds no profile-global Client seat, so a new
    // scenario only has to start its own process and authenticate the Host.
    // `options.cwd` gives one Client its own launch directory (its Workspace
    // proposal input); the Host Workspace identity still comes from the Host.
    const client = new SurfaceEntryProcess(entries.client, {
      ...base,
      workDir,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...base.env, ...extraEnv },
    })
    c1Clients.push(client)
    const ready = await client.waitFor(record => record.m4a0 === 'ready', `${label} Client ready`, 180_000)
    return { client, ready }
  }
  const exitC1Client = async (client, label) => {
    client.send('/exit\r')
    let exit
    try {
      exit = await client.waitForExit(60_000)
    } catch (error) {
      // The exit wait carries no frame by itself; capture the client's last
      // screen so a held exit is diagnosable (composer poison, open modal…).
      const frame = await client.viewport().catch(() => [])
      throw new SplitSmokeAssertionError(
        `${label} exit timed out; last frame: ${JSON.stringify(frame.slice(-16))}`,
        { cause: error },
      )
    }
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
  /**
   * The Client root's ONE official interaction listener pair. `ready` alone
   * never proves a surface could receive a Question or Approval: the startup
   * gate is the fact that the official `$on` pair exists exactly once before
   * the first forwarded request can arrive.
   */
  const assertInteractionGate = (client, label) => {
    const gate = client.records.find(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate')
    assert(gate !== undefined && gate.phase === 'listeners-ready' && gate.agentResolver === true
      && gate.questionListeners === 1 && gate.approvalListeners === 1 && gate.loaderTasks >= 1,
    `${label} interaction startup gate was not ready before the first generation: ${JSON.stringify(gate)}`)
    assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate').length === 1,
      `${label} registered the interaction startup gate more than once`)
  }
  /** The full scope id this scene published under (from its own first Ready). */
  const sceneScopeId = () => {
    assert(typeof hostScopeId === 'string' && hostScopeId.length === 64,
      'the C1 scene never learned the full 64-character scope id from a real Ready')
    return hostScopeId
  }
  /** The kernel Host-seat suffix of this scene's own scope. */
  const sceneScopeSuffix = () => sceneScopeId().slice(0, 40)
  /** Release proof for this scene's own Host seat after its Host was stopped. */
  const awaitSceneSeatFree = async (timeoutMs = 15_000) => {
    await seatFree(`\0dsh-pi-tui-h-${sceneScopeSuffix()}`, timeoutMs)
  }
  /** Release exactly the Clients and Hosts this scene created. */
  const dispose = async () => {
    for (const client of c1Clients) await client.dispose()
    for (const host of c1Hosts) await stopC1Host(host)
  }

  return {
    PROTECTED_HOST_ROWS,
    c1Work,
    c1WorkRoot,
    c1JobWorkRoot,
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
    hostIdentityFacts,
    assertHostIdentityKept,
    hostRowFiberUids,
    assertHostRowsKept,
    assertInteractionGate,
    sceneScopeId,
    sceneScopeSuffix,
    awaitSceneSeatFree,
    dispose,
  }
}
