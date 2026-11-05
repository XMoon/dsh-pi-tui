/**
 * T26 artifact absence and recovery: the REAL module-absence negative, the two
 * required-row refusals, and the restored authenticated Host on the same
 * installed profile.
 *
 * This is ONE case because the recovery proof is causally bound to the absence
 * it follows: the same installed payload is renamed away, a Host must fail
 * closed with the real Loader import failure, the ORIGINAL bytes come back, and
 * a FRESH Host on that profile must reach Ready, answer the authenticated
 * identity route and release the kernel seat. Keeping the positive in the lane
 * tail (its historical position) left it detached from the negative it proves.
 *
 * @module split-process/runtime-artifact-recovery
 */

import { existsSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import {
  assertIdentityFields,
  connectCookie,
  fetchStatus,
  readJson,
  restoreFile,
  saveFile,
  seatFree,
} from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** Prove module absence, the required-row refusals, then the restored Host. */
export async function runRuntimeArtifactRecovery(context) {
  const { installation, EntryProcess, entries, base, workDir, dshHome, profilePackage, trace, failpoint } = context
  const { profileDir, harnessDir } = installation
  const sessionControllerMutationPatch = join(workDir, 't26-session-controller-disabled.patch.yml')
  const runRoot = join(dshHome, 'run', 'dsh-pi-tui')
  const hasPublishedIdentity = () => existsSync(runRoot)
    && readdirSync(runRoot, { recursive: true }).some(name => String(name).endsWith('instance.json'))

  // T26a-artifact-absent: the REAL module-absence negative (issue #474). The
  // Loader row stays inserted and enabled; only the installed module file is
  // gone. This is NOT the row-disabled control of the bootstrap pilot.
  //
  // The historical "renamed artifact still Ready" observation (PR #473) was
  // NOT a pnpm hardlink/store mirror and NOT a second installed copy. DSH's
  // HMR invalidates the profile's package.json at startup; its package-scope
  // hook then skips the profile directory (trailing-slash `dirname`), so
  // Node's package SELF-REFERENCE climbed to an enclosing `package.json`
  // (`name: @xmoon76/dsh-pi-tui`, `exports`) and resolved a second build of
  // the artifact. DSH app-boot's startup-audit retry (`importFailure` ->
  // `entry.parent.tree.import`) is what then made the row active. The Host
  // code itself fails closed once the artifact is genuinely unreachable, so
  // this control removes every remaining escape explicitly:
  // - no ancestor may provide another INSTALLED package copy;
  // - a non-matching `<DSH_HOME>/package.json` barrier shadows every enclosing
  //   package scope above it for THIS negative only (removed in `finally`);
  // - after the rename the profile-anchored resolver must really fail.
  // The scene work dir is outside the checkout; the barrier still shadows
  // every enclosing package scope above the isolated DSH home, so the
  // package-scope self-reference escape cannot reappear through another
  // layout.
  const hostRuntimeArtifact = join(profilePackage, 'dist', 'host-runtime.mjs')
  const hostRuntimeAbsentPath = `${hostRuntimeArtifact}.artifact-absent`
  const packageScopeBarrier = join(dshHome, 'package.json')
  const barrierBody = '{"name":"dsh-split-process-t26-artifact-barrier","private":true}\n'
  const profilesManifest = join(dirname(profileDir), 'package.json')
  assert(!existsSync(profilesManifest)
    || readJson(profilesManifest).name !== '@xmoon76/dsh-pi-tui',
    `T26a artifact-absent: an enclosing profiles package manifest carries the candidate package name: ${profilesManifest}`)
  const profileRequire = createRequire(join(profileDir, 'package.json'))
  assert(profileRequire.resolve('@xmoon76/dsh-pi-tui/host-runtime') === realpathSync(hostRuntimeArtifact),
    'T26a artifact-absent: the profile copy must be the normal resolvable Host Runtime artifact')
  const reachableAncestorCopies = []
  for (let directory = dirname(profileDir); ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    if (existsSync(candidate)) reachableAncestorCopies.push(candidate)
    if (dirname(directory) === directory) break
  }
  const harnessCopy = join(harnessDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
  if (existsSync(harnessCopy)) reachableAncestorCopies.push(harnessCopy)
  assert(reachableAncestorCopies.length === 0,
    `T26a artifact-absent: the isolated profile still has another installed package copy: ${reachableAncestorCopies.join(', ')}`)
  let artifactAbsentFailure
  let artifactAbsentExit
  let artifactAbsentStderr = ''
  const previousBarrier = existsSync(packageScopeBarrier) ? saveFile(packageScopeBarrier) : undefined
  try {
    writeFileSync(packageScopeBarrier, barrierBody)
    renameSync(hostRuntimeArtifact, hostRuntimeAbsentPath)
    // The lane's own fail-after control: this case's single Hook fires while the
    // installed artifact is RENAMED AWAY, so the shared failure path must still
    // put the original bytes back before the work root is removed.
    failpoint('bootstrap.runtime-artifact-recovery.after-rename')
    // Auxiliary normal-resolution check (the profile-anchored CJS resolver).
    // It cannot exercise the ESM package-scope retry by itself; the barrier
    // plus the Host's own fail-closed verdict below are the real proof.
    let resolutionError
    try {
      profileRequire.resolve('@xmoon76/dsh-pi-tui/host-runtime')
    } catch (error) {
      resolutionError = error
    }
    assert(resolutionError !== undefined
      && /ERR_MODULE_NOT_FOUND|Cannot find module/u.test(`${resolutionError?.code ?? ''} ${resolutionError?.message ?? resolutionError}`),
      'T26a artifact-absent: the renamed artifact must be genuinely unresolvable from the profile anchor')
    const artifactAbsent = new EntryProcess('host', entries.host, base)
    artifactAbsentFailure = await artifactAbsent.waitFor(record => record.m4a0 === 'failure', 'T26 Host Runtime artifact absent', 120_000)
    artifactAbsentExit = await artifactAbsent.waitForExit(60_000)
    artifactAbsentStderr = artifactAbsent.stderr
    assert(artifactAbsentExit.code === 1, `T26 Host Runtime artifact absent exit was ${JSON.stringify(artifactAbsentExit)}`)
    assert(!artifactAbsent.records.some(record => record.m4a0 === 'ready'), 'T26 Host Runtime artifact absent emitted ready')
    assert(!artifactAbsent.records.some(record => record.services?.piTuiHostReady === true),
      'T26 Host Runtime artifact absent published piTuiHostReady')
    assert(/expected exactly one active piTuiHostRuntime owner row, found 0/u.test(String(artifactAbsentFailure.error)),
      `T26 Host Runtime artifact absent: the strict owner audit did not reject the missing row: ${String(artifactAbsentFailure.error)}`)
    assert(/split-host-pi-tui-runtime \(@xmoon76\/dsh-pi-tui\/host-runtime\): failed to import/u.test(artifactAbsentStderr)
      && /ERR_MODULE_NOT_FOUND/u.test(artifactAbsentStderr),
      `T26 Host Runtime artifact absent: the Loader did not report the real import failure; stderr=${artifactAbsentStderr.slice(-800)}`)
    assert(!hasPublishedIdentity(), 'T26 Host Runtime artifact absent published a Host identity')
  } finally {
    if (existsSync(hostRuntimeAbsentPath)) renameSync(hostRuntimeAbsentPath, hostRuntimeArtifact)
    if (previousBarrier === undefined) rmSync(packageScopeBarrier, { force: true })
    else restoreFile(packageScopeBarrier, previousBarrier)
  }
  trace('t26-runtime-artifact-absent', {
    exit: artifactAbsentExit?.code,
    readyEmitted: false,
    identityPublished: false,
    error: String(artifactAbsentFailure?.error ?? '').slice(0, 160),
    loaderImportFailed: true,
    packageScopeBarrier: true,
  })

  // C-04 (issue #474 recovery): the SAME candidate/profile must start a FRESH
  // Host after the artifact-absent negative. A real Ready proves the failed
  // process released the kernel seat (a leak would produce
  // HOST_ALREADY_OWNED), and the authenticated /connect + identity read proves
  // the restored Host's identity is really usable, not only declared. It runs
  // here, inside the same isolated window as the absence it proves, and its
  // owner shutdown is completed immediately so no later scene inherits it.
  const restoredHost = new EntryProcess('host', entries.host, base)
  const restoredReady = await restoredHost.waitFor(record => record.m4a0 === 'ready', 'T26 Host Runtime artifact restored', 120_000)
  assert(!restoredHost.records.some(record => record.m4a0 === 'host-seat-conflict'),
    'T26 Host Runtime artifact absent leaked the Host kernel seat')
  const restoredPrivateBindings = restoredReady.services?.piTuiHostReady === true
    && restoredReady.services?.piTuiFileReferences === true
    && restoredReady.services?.piTuiTerminalProgress === true
  assert(restoredPrivateBindings,
    `T26 Host Runtime restored: the private Host services are not live: ${JSON.stringify(restoredReady.services)}`)
  assert(restoredReady.ownerEntries?.piTuiHostRuntime?.length === 1,
    `T26 Host Runtime restored: expected exactly ONE active Host Runtime owner row, got ${JSON.stringify(restoredReady.ownerEntries?.piTuiHostRuntime)}`)
  // Authenticated identity proof against THIS Host's own published material:
  // the /connect Cookie exchange, a 200 identity read and the registry match
  // are the same chain the transport case audits for its main Host.
  const restoredScopeDir = join(dshHome, 'run', 'dsh-pi-tui', restoredReady.localHost.scopeId)
  const restoredRegistry = readJson(join(restoredScopeDir, 'instance.json'))
  const restoredLaunch = readJson(join(restoredScopeDir, 'launch.json'))
  assertIdentityFields(restoredReady.localHost, restoredRegistry, 'T26 Host Runtime restored ready/registry')
  const restoredCookie = await connectCookie(restoredReady.localHost.origin, restoredLaunch)
  const restoredIdentityResponse = await fetchStatus(`${restoredReady.localHost.origin}/api/pi-tui.local-host`, {
    headers: { cookie: restoredCookie },
  })
  const restoredIdentityAuthenticated = restoredIdentityResponse.status === 200
  assert(restoredIdentityAuthenticated,
    `T26 Host Runtime restored authenticated identity returned HTTP ${String(restoredIdentityResponse.status)}`)
  assert(/application\/json\b/iu.test(String(restoredIdentityResponse.headers.get('content-type'))),
    'T26 Host Runtime restored identity response is not JSON')
  assertIdentityFields(JSON.parse(restoredIdentityResponse.body), restoredRegistry,
    'T26 Host Runtime restored authenticated identity')
  // The owner-governed stdin shutdown is the entry's documented qualification
  // path (a ready Host keeps its control dispatcher).
  const restoredExit = await restoredHost.shutdown()
  assert(restoredExit.code === 0, `T26 Host Runtime restored shutdown exit was ${JSON.stringify(restoredExit)}`)
  await seatFree(`\0dsh-pi-tui-h-${restoredReady.localHost.scopeId.slice(0, 40)}`, 10_000)
  trace('t26-runtime-artifact-restored', {
    exit: restoredExit.code,
    readyEmitted: true,
    identityAuthenticated: restoredIdentityAuthenticated,
    privateBindings: restoredPrivateBindings,
    registryMatched: true,
    hostSeatFree: true,
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

  // T26c (M5-WS1): the official Workspace Controller row disabled after the
  // overlay must fail BEFORE any Ready/identity publication. A Host that
  // would answer `Host ready` while `remote.workspace` has no owner is the
  // exact false green this control excludes.
  const workspaceControllerMutationPatch = join(workDir, 't26-workspace-controller-disabled.patch.yml')
  writeFileSync(workspaceControllerMutationPatch, '- id: workspace-controller\n  disabled: true\n')
  let workspaceControllerFailure
  let workspaceControllerExit
  try {
    const workspaceControllerDisabled = new EntryProcess('host', entries.host, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: workspaceControllerMutationPatch },
    })
    workspaceControllerFailure = await workspaceControllerDisabled.waitFor(
      record => record.m4a0 === 'failure',
      'T26 Workspace Controller row disabled',
      120_000,
    )
    workspaceControllerExit = await workspaceControllerDisabled.waitForExit(60_000)
    assert(workspaceControllerExit.code === 1, `T26 Workspace Controller row disabled exit was ${JSON.stringify(workspaceControllerExit)}`)
    assert(!workspaceControllerDisabled.records.some(record => record.m4a0 === 'ready'),
      'T26 Workspace Controller row disabled emitted ready')
    assert(/expected exactly one active workspaceController owner row, found 0/u.test(String(workspaceControllerFailure.error)),
      `T26 Workspace Controller row disabled: unexpected error ${String(workspaceControllerFailure.error)}`)
    assert(!workspaceControllerDisabled.records.some(record => record.services?.workspaceController === true),
      'T26 Workspace Controller row disabled reported a live workspaceController service')
    assert(!hasPublishedIdentity(), 'T26 Workspace Controller row disabled published a Host identity')
  } finally {
    rmSync(workspaceControllerMutationPatch, { force: true })
  }
  trace('t26-workspace-controller-disabled', {
    exit: workspaceControllerExit?.code,
    readyEmitted: false,
    identityPublished: false,
    error: String(workspaceControllerFailure?.error ?? '').slice(0, 160),
  })
}
