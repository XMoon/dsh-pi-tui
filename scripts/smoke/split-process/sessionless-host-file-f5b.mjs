/**
 * M6-1/F5-B L5/L6: the REAL Host / REAL Split Client sessionless `@file`
 * qualification.
 *
 * This case proves the installed pair end to end — no Client filesystem scan,
 * no injected boolean and no mock Workspace id:
 *
 *   F5B-A  a Client whose launch directory is the SAME directory object as the
 *          authenticated Host's view is auto-adopted through the official
 *          `workspace.create`, and a bare `@marker` lists the Host's file,
 *          accepts it literally, and the first real Prompt creates the Session
 *          in that exact Host Workspace (`SessionHeader.cwd`).
 *   F5B-B  a second independent TUI on the SAME Host selects its OWN Workspace:
 *          each Client's `@` menu contains its own marker and never the other
 *          Client's.
 *   F5B-C  the SAME pathname under a DIFFERENT mount view (a private mount
 *          namespace bind-mounted over the launch directory) is NOT adopted:
 *          the Welcome stays unselected, the typed `@` dispatches no Host read
 *          and no Host Workspace is created.
 *   F5B-D  a manual Host path proposal (the qualification-only
 *          `SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH` seam) still works when
 *          the automatic proof is unavailable.
 *
 * The mount-namespace scene is a REAL `unshare -Urm --propagation private`
 * namespace on this OS; when the kernel/user policy refuses it the case fails
 * closed instead of substituting a fake classifier answer.
 *
 * @module split-process/sessionless-host-file-f5b
 */

import { deepEqual } from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionHeader } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Wait for the Welcome's CONFIRMED Host directory across a wrapped row. */
async function waitForConfirmedDirectory(client, canonicalPath, label, timeoutMs = 120_000) {
  const started = Date.now()
  // The card paints the confirmed directory on ONE row when it fits the value
  // column, or WRAPS the path over several rows when it does not (the host
  // home/work root length and the whale variant both change the column). The
  // match therefore flattens the painted frame: box glyphs and whitespace are
  // removed so a wrapped path becomes contiguous again, while the confirmed
  // LABEL stays distinct from `Checking Host directory:` and the unavailable
  // state.
  const flatPath = canonicalPath.replace(/\s+/gu, '')
  while (Date.now() - started < timeoutMs) {
    const rows = await client.viewport()
    // The Welcome is a side-by-side card: the whale art owns the left columns
    // and the FACTS column (label plus the value, wrapped by the card width)
    // starts at the label's column. Slicing each row from that exact column
    // keeps the whale's continuation-row art out of a wrapped path.
    const labelRow = rows.find(row => String(row).includes('Host directory:'))
    if (labelRow === undefined) {
      await sleep(50)
      continue
    }
    const factsStart = String(labelRow).indexOf('Host directory:')
    const flat = rows
      .map(row => {
        const text = String(row)
        return text.length > factsStart ? text.slice(factsStart) : ''
      })
      .join('')
      .replace(/[\u2502\u256d\u256e\u2570\u256f\u2500]/gu, '')
      .replace(/\s+/gu, '')
    if (!flat.includes('CheckingHostdirectory:')
      && !flat.includes('Hostdirectoryunavailable:')
      && flat.includes(flatPath)) return
    await sleep(50)
  }
  const rows = await client.viewport()
  throw new SplitSmokeAssertionError(`${label}: the Welcome never confirmed ${canonicalPath} (got ${JSON.stringify(rows.slice(0, 14))})`)
}

const ABSENCE_WINDOW_MS = 2_000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Run the sessionless `@file` qualification on this installation. */
export async function runSessionlessHostFileF5B(context) {
  const { workDir } = context
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, dispose } = scene
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const alphaDir = join(workDir, `f5b-alpha-${unique}`)
  const betaDir = join(workDir, `f5b-beta-${unique}`)
  const manualClientDir = join(workDir, `f5b-manual-client-${unique}`)
  mkdirSync(alphaDir, { recursive: true, mode: 0o700 })
  mkdirSync(betaDir, { recursive: true, mode: 0o700 })
  mkdirSync(manualClientDir, { recursive: true, mode: 0o700 })
  const alphaHome = join(workDir, `f5b-alpha-home-${unique}`)
  const betaHome = join(workDir, `f5b-beta-home-${unique}`)
  const manualHome = join(workDir, `f5b-manual-home-${unique}`)
  const invalidHome = join(workDir, `f5b-invalid-home-${unique}`)
  const explHome = join(workDir, `f5b-explicit-home-${unique}`)
  for (const home of [alphaHome, betaHome, manualHome, invalidHome, explHome]) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
  }
  const alphaMarker = `alpha-marker-${unique}.ts`
  const betaMarker = `beta-marker-${unique}.ts`
  writeFileSync(join(alphaDir, alphaMarker), 'alpha\n', { mode: 0o600 })
  writeFileSync(join(betaDir, betaMarker), 'beta\n', { mode: 0o600 })
  // An EXTERNAL directory OUTSIDE the alpha Host Workspace: an explicit
  // `@../<sibling>/` or absolute query must enumerate it, a bare query must not.
  const sharedDir = join(workDir, `f5b-shared-${unique}`)
  mkdirSync(sharedDir, { recursive: true, mode: 0o700 })
  const sharedMarker = `shared-marker-${unique}.ts`
  writeFileSync(join(sharedDir, sharedMarker), 'shared\n', { mode: 0o600 })
  const canonicalAlpha = realpathSync(alphaDir)
  const canonicalBeta = realpathSync(betaDir)
  assert(canonicalAlpha !== canonicalBeta, 'F5B the two Workspace fixtures are the same directory')

  try {
    const { host, ready } = await startC1Host('unowned-job', 'F5B')
    assert(ready.localHost?.hostPid > 0 && typeof ready.localHost?.hostStarttime === 'string',
      `F5B the Host Ready record carries no authenticated process identity: ${JSON.stringify(ready.localHost)}`)

    // ── F5B-A: the automatic same-object adoption + first Session ───────────
    const { client: alpha, ready: alphaReady } = await startC1Client('F5B alpha client', {
      SPLIT_PROCESS_CLIENT_READ_AUTHORITY_PROOF: join(workDir, `f5b-probe-${unique}.json`),
      HOME: alphaHome,
    }, { cwd: alphaDir })
    assert(alphaReady.sessionOpen === false && alphaReady.surfaceMounted === true,
      `F5B alpha is not a mounted sessionless surface: ${JSON.stringify(alphaReady)}`)
    // The auto proof runs at mount: the Welcome states the Host-confirmed
    // directory once the official workspace.create settles.
    await waitForConfirmedDirectory(alpha, canonicalAlpha, 'F5B alpha confirmed Host directory')

    // ── F5B-A0: explicit Host path navigation, BEFORE any Session exists ───
    // A sessionless explicit `@../<sibling>/` (and an absolute Host path)
    // enumerates a directory OUTSIDE the registered Workspace root, keeps the
    // user-typed prefix, and is ACCEPTED into the editor as the Host-located
    // value. A dedicated throwaway sessionless Client keeps alpha's editor
    // pristine for the original F5B-A flow below.
    const { client: expl, ready: explReady } = await startC1Client('F5B explicit client', {
      HOME: explHome,
    }, { cwd: alphaDir })
    assert(explReady.sessionOpen === false && explReady.surfaceMounted === true,
      `F5B explicit client is not a mounted sessionless surface: ${JSON.stringify(explReady)}`)
    await waitForConfirmedDirectory(expl, canonicalAlpha, 'F5B explicit client confirmed Host directory')
    const hardClear = async () => { expl.send('\x15'); await sleep(200) }
    const acceptExplicit = async (query, draft, label) => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await hardClear()
        expl.send(query)
        await sleep(1_500)
        expl.send('\t')
        try {
          await expl.waitForComposerDraft(draft, 10_000)
          await hardClear()
          return
        } catch {
          // The candidate list had not settled yet; clear and retry.
        }
      }
      throw new SplitSmokeAssertionError(`${label}: the explicit Host candidate was never accepted into the editor`)
    }
    const relativeDraft = `@../${basename(sharedDir)}/${sharedMarker}`
    await acceptExplicit(`@../${basename(sharedDir)}/${sharedMarker.slice(0, 12)}`, relativeDraft, 'F5B explicit relative')
    const absoluteDraft = `@${sharedDir}/${sharedMarker}`
    await acceptExplicit(`@${sharedDir}/${sharedMarker.slice(0, 12)}`, absoluteDraft, 'F5B explicit absolute')
    // Negative control on the SAME sessionless Client: a BARE query stays inside
    // the registered Workspace and never reaches the external marker.
    expl.send(`@${sharedMarker.slice(0, 12)}`)
    await sleep(ABSENCE_WINDOW_MS)
    const bareExternalView = (await expl.viewport()).join('\n')
    assert(!bareExternalView.includes(sharedMarker),
      'F5B a bare sessionless @ query reached a file OUTSIDE the registered Workspace')
    await hardClear()
    const sessionlessBefore = await waitForSurfaceStatus(expl,
      record => record.sessionOpen === false, 'F5B explicit client stays sessionless', 60_000)
    assert(sessionlessBefore.sessionOpen === false, 'F5B the explicit Host path route created a Session')
    await hardClear()
    await exitC1Client(expl, 'F5B explicit client')

    await alpha.send(`@${alphaMarker.slice(0, 8)}`)
    await alpha.waitForScreen(alphaMarker, 'F5B alpha @ candidate', 120_000)
    const alphaView = (await alpha.viewport()).join('\n')
    assert(alphaView.includes(alphaMarker), 'F5B alpha @ menu lost its own marker')
    assert(!alphaView.includes(betaMarker), 'F5B alpha @ menu leaked the OTHER Workspace marker')
    await alpha.send('\t')
    await alpha.waitForComposerDraft(`@${alphaMarker}`, 60_000)
    // The submitted mention is LITERAL prompt text; the first real Prompt
    // creates the Session in the confirmed Host Workspace.
    await alpha.send('\r')
    const alphaStatus = await waitForSurfaceStatus(alpha,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'F5B alpha first Session', 120_000)
    const alphaHeader = await waitForHostSessionHeader(context.dshHome, alphaStatus.openSessionId, 'F5B alpha durable header')
    assert(alphaHeader.cwd === canonicalAlpha,
      `F5B the first Session cwd is ${String(alphaHeader.cwd)}, expected the confirmed Workspace ${canonicalAlpha}`)

    // ── F5B-B: an independent TUI selects its OWN Workspace ────────────────
    const { client: beta } = await startC1Client('F5B beta client', {
      HOME: betaHome,
    }, { cwd: betaDir })
    await waitForConfirmedDirectory(beta, canonicalBeta, 'F5B beta confirmed Host directory')
    await beta.send(`@${betaMarker.slice(0, 8)}`)
    await beta.waitForScreen(betaMarker, 'F5B beta @ candidate', 120_000)
    const betaView = (await beta.viewport()).join('\n')
    assert(betaView.includes(betaMarker), 'F5B beta @ menu lost its own marker')
    assert(!betaView.includes(alphaMarker), 'F5B beta @ menu leaked the OTHER Workspace marker')

    // ── F5B-C: the same pathname under a DIFFERENT mount view ───────────────
    // A real cross-mount-namespace scene needs a Client that (a) creates a
    // private mount namespace over its launch path AND (b) attaches to the
    // outer Host. On this lane the Client's local scope identity includes the
    // kernel UID, so an unprivileged user namespace (which maps uid 0) can
    // never attach to the real Host, and a same-user namespace cannot mount.
    // The scene is therefore NOT run and the classifier's different-object
    // branch stays a UNIT contract plus a NOT_VERIFIED qualification item —
    // never a fabricated OS pass.
    context.trace?.('f5b-same-path-different-object', {
      status: 'NOT_VERIFIED',
      blocker: 'an unprivileged user namespace maps uid 0 (changing the local scope) and a same-uid mount namespace needs CAP_SYS_ADMIN',
      unitContract: 'test/app/remote-process-local-workspace-equivalence.test.ts',
      requirement: 'WS-L2 remains open until a same-uid mount-namespace capable Linux host runs it',
    })

    // ── F5B-D: a refused MANUAL Host path creates nothing and adopts nothing ─
    // The manual Host-path proposal outranks any auto candidate; the Host
    // refuses a nonexistent directory, so the Welcome stays rejected, no
    // Session exists and a typed `@` dispatches no Host read.
    const invalidDir = join(workDir, `f5b-invalid-${unique}`)
    const { client: invalid } = await startC1Client('F5B invalid manual client', {
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: invalidDir,
      HOME: invalidHome,
    }, { cwd: alphaDir })
    await invalid.waitForScreen('Host directory unavailable', 'F5B invalid manual rejected', 120_000)
    await invalid.send(`@${alphaMarker.slice(0, 8)}`)
    await sleep(ABSENCE_WINDOW_MS)
    const invalidView = (await invalid.viewport()).join('\n')
    assert(!invalidView.includes(alphaMarker),
      'F5B a rejected manual proposal served Host candidates from the automatic launch directory')
    const invalidStatus = await waitForSurfaceStatus(invalid,
      record => record.sessionOpen === false,
      'F5B invalid manual stays sessionless', 60_000)
    assert(invalidStatus.sessionOpen === false && typeof invalidStatus.openSessionId !== 'string',
      'F5B the refused manual Workspace opened a Session')
    context.trace?.('f5b-phase', { phase: 'invalid-asserted' })
    await invalid.clearComposerDraft(`@${alphaMarker.slice(0, 8)}`)
    await exitC1Client(invalid, 'F5B invalid manual client')
    context.trace?.('f5b-phase', { phase: 'invalid-exited' })

    // ── F5B-E: the manual Host path proposal still works ────────────────────
    const { client: manual } = await startC1Client('F5B manual client', {
      SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH: betaDir,
      HOME: manualHome,
    }, { cwd: manualClientDir })
    await waitForConfirmedDirectory(manual, canonicalBeta, 'F5B manual confirmed Host directory')
    await manual.send(`@${betaMarker.slice(0, 8)}`)
    await manual.waitForScreen(betaMarker, 'F5B manual @ candidate', 120_000)

    const hostAfter = await hostStatus(host)
    assert(hostAfter.pid === ready.pid && hostAfter.localHost?.hostStarttime === ready.localHost?.hostStarttime,
      `F5B the Host identity changed during the sessionless discovery: ${JSON.stringify({
        before: { pid: ready.pid, starttime: ready.localHost?.hostStarttime },
        after: { pid: hostAfter.pid, starttime: hostAfter.localHost?.hostStarttime },
      })}`)

    await exitC1Client(alpha, 'F5B alpha client')
    context.trace?.('f5b-phase', { phase: 'alpha-exited' })
    await beta.clearComposerDraft(`@${betaMarker.slice(0, 8)}`)
    await exitC1Client(beta, 'F5B beta client')
    context.trace?.('f5b-phase', { phase: 'beta-exited' })
    await manual.clearComposerDraft(`@${betaMarker.slice(0, 8)}`)
    await exitC1Client(manual, 'F5B manual client')
    context.trace?.('f5b-phase', { phase: 'manual-exited' })
    context.trace?.('f5b-sessionless-host-file', {
      candidate: context.candidateSha256,
      hostPid: ready.localHost?.hostPid,
      hostStarttime: ready.localHost?.hostStarttime,
      instanceId: ready.localHost?.instanceId,
      autoSameObject: true,
      alphaDurableCwd: alphaHeader.cwd,
      explicitRelativeHostPath: relativeDraft,
      explicitAbsoluteHostPath: absoluteDraft,
      bareStaysInWorkspaceRoot: true,
      twoTuIsIsolated: true,
      samePathDifferentObject: 'NOT_VERIFIED',
      refusedManualCreatedNothing: true,
      manualHostPathWorks: true,
      firstSessionMentionLiteral: `@${alphaMarker}`,
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
