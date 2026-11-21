/**
 * R10: a REAL split Client never presents its OWN local Git HEAD as a live
 * Host Session branch.
 *
 * ONE real Host and ONE real PTY Client: the Client launches from a private
 * workspace whose `.git/HEAD` names a synthetic `R10_LOCAL_ONLY_<nonce>`
 * branch. The sessionless Footer (no open Session — the one Remote state that
 * keeps a Client-local branch) visibly paints that branch first, so the later
 * absence is never vacuous. Opening the real Host Session then proves the
 * locality gate end to end: the painted viewport keeps the session's
 * Host-authoritative cwd while the Client-local branch text disappears,
 * because a Remote LIVE Session's cwd belongs to the Host and must never
 * authorize a read of the Client's own `.git/HEAD`.
 *
 * The durable Session header must record the Host's ACTUAL effective cwd (the
 * canonical Client launch workspace) — the cwd fact stays, only the branch is
 * omitted. The Host and the Client are two different real business PIDs, and
 * the Host keeps its identity after the Client exits.
 *
 * @module split-process/remote-git-branch-locality
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionHeader } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Wait until the PAINTED viewport contains `text`. */
async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    throw new SplitSmokeAssertionError(`${label}: wanted ${JSON.stringify(text)}; frame=${JSON.stringify(frame.slice(-16))}`, { cause: error })
  }
}

/** Wait until the PAINTED viewport no longer contains `text`. */
async function waitForScreenGone(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => !(await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify(text)} never disappeared from the painted surface`, { cause: error })
  }
}

export async function runRemoteGitBranchLocality(context) {
  const { workDir, dshHome, trace } = context
  const scene = createC1Scene(context)
  // The synthetic Client-local branch: only this run's Client workspace names
  // it, so any painted occurrence proves the Client's own .git/HEAD spoke.
  const branchLabel = `R10_LOCAL_ONLY_${String(process.pid)}`
  const clientWorkspace = join(workDir, 'r10-client-workspace')

  try {
    // The Client launch workspace carries ONLY a synthetic Git HEAD (a bare
    // `.git` directory with no worktree): the branch fact is display-only.
    mkdirSync(join(clientWorkspace, '.git'), { recursive: true, mode: 0o700 })
    writeFileSync(join(clientWorkspace, '.git', 'HEAD'), `ref: refs/heads/${branchLabel}\n`, { mode: 0o600 })
    // Non-vacuous guard: the file really reads back that exact branch before
    // any Footer claim is made about it.
    assert(readFileSync(join(clientWorkspace, '.git', 'HEAD'), 'utf8').trim() === `ref: refs/heads/${branchLabel}`,
      `R10 the synthetic Client .git/HEAD does not read back the ${branchLabel} branch`)

    const { host, ready: hostReady } = await scene.startC1Host('unowned-job', 'r10-git-branch-host')
    const hostPid = hostReady.pid
    const hostBefore = await scene.hostIdentityFacts(host)

    const { client, ready: clientReady } = await scene.startC1Client('r10-git-branch-client', {}, {
      cwd: clientWorkspace,
      columns: 140,
    })
    const clientPid = clientReady.pid
    assert(clientReady.sessionOpen === false, `R10 the Client must start sessionless: ${JSON.stringify(clientReady)}`)

    // ── Phase 1 — SESSIONLESS positive control: the SAME terminal and Footer
    // layout visibly paint the Client's local branch. If this never appears
    // the scene is broken (no Footer / no branch) — fail here, never let a
    // later "absent" count as a pass.
    await waitForScreenText(client, branchLabel, 'R10 sessionless Footer shows the Client-local branch')

    // ── Phase 2 — open a REAL Host Session and prove the Host's ACTUAL
    // effective cwd is the canonical Client launch workspace.
    const sessionId = await scene.openC1Session(client, 'r10 remote git branch locality prompt', 'R10 open Host Session')
    const canonicalWorkspace = realpathSync(clientWorkspace)
    const header = await waitForHostSessionHeader(dshHome, sessionId, 'R10 durable Host Session header')
    assert(header.cwd === canonicalWorkspace,
      `R10 the Host Session cwd must be the canonical Client launch workspace: ${String(header.cwd)} != ${canonicalWorkspace}`)

    // ── Phase 3 — the LIVE Remote Session: the workspace section keeps the
    // session cwd while the Client-local branch is gone from the same Footer.
    const workspaceBasename = basename(canonicalWorkspace)
    await waitForScreenText(client, workspaceBasename, 'R10 live Session Footer keeps the session cwd')
    await waitForScreenGone(client, branchLabel, 'R10 live Session Footer dropped the Client-local branch')
    // One settled frame proves BOTH facts together: the Footer is still fully
    // painted (cwd visible) AND the branch text is absent from it.
    const liveFrame = (await client.viewport()).join('\n')
    assert(liveFrame.includes(workspaceBasename) && !liveFrame.includes(branchLabel),
      `R10 the live Session frame violates the branch-locality contract (cwd ${JSON.stringify(workspaceBasename)}, branch ${JSON.stringify(branchLabel)})`)
    // The split is real: the Host and the Client are two different processes.
    assert(Number.isInteger(hostPid) && Number.isInteger(clientPid) && hostPid !== clientPid,
      `R10 the Host and Client must be two different real business PIDs: host=${String(hostPid)} client=${String(clientPid)}`)

    await scene.exitC1Client(client, 'R10 Client')
    await scene.assertHostIdentityKept(host, hostBefore, 'R10 Host after the Client exit')

    trace('r10/remote-git-branch-locality', {
      status: 'PASS',
      hostPid,
      clientPid,
      sessionId,
      branchLabel,
      sessionlessBranchShown: true,
      liveSessionBranchOmitted: true,
    })
    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
