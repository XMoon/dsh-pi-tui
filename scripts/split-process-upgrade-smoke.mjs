#!/usr/bin/env node
/**
 * Split-process cross-build Client/Host qualification with two real packages.
 *
 * This lane proves the real old-Host / new-Client transition with two genuine
 * packaged payloads:
 *
 *   old tgz installed in the one canonical profile (Host A + Client A)
 *   new tgz installed side-by-side as a real package root (Client B candidate)
 *     only after Host A has admitted a Turn and Client A is still live
 *   same DSH_HOME / profile / UID / DSH runtime for both builds
 *
 * U07 then reexecutes Client A onto the side-by-side build: the OLD Client A
 * keeps its real PTY, releases every Client resource through its ONE stop
 * coordinator, and a NEW OS PID loads the new `dist/local-client.mjs`, which
 * re-authenticates the SAME Host A and reopens the SAME Session. The old PID
 * remains only as the waiting parent that forwards the replacement exit code.
 *
 * Both packages name the same `dsh-pi-tui/local/1` wire protocol and the same
 * exact DSH runtime, but carry different package versions, bundles and
 * buildIds. The new Client B must authenticate the SAME Host A, call the real
 * official `session/list`, private PiFile RPC and private terminal-progress
 * watch, and the new build's real PTY surface must open the SAME running
 * Session. Neither Client may mutate Host A, its registry/launch files, or
 * release its admitted Turn.
 *
 * Only after the turn completes and a separate explicit SIGTERM (mapped by the
 * Host entry to its ONE official `runProfile` shutdown owner) does the lane
 * install the new payload into the profile and prove a fresh Host identity plus
 * durable Session readback.
 *
 * The side-by-side shape is deliberate: replacing a live profile package
 * payload in place is NOT a qualified hot-upgrade path. A local probe showed
 * the old Host can complete its shutdown records while the process remains
 * alive when its on-disk payload was replaced under it. This lane therefore
 * qualifies the safe order — introduce the new build, stop the old Host
 * explicitly, then replace the installed profile — and leaves the running old
 * installation byte-for-byte intact while the cross-build Client attaches.
 *
 * The three real scenes live in `scripts/smoke/split-upgrade/` and are frozen in
 * `scripts/lib/split-upgrade-selection.mjs`: the full lane runs every registered
 * case in order, while `--case`/`--suite` run only the selected set in its own
 * isolated profile and never claim cross-build compatibility.
 *
 * Usage:
 *   pnpm smoke:split-upgrade -- --old <absolute-old.tgz> --new <absolute-new.tgz> [--evidence <file>]
 *   pnpm smoke:split-upgrade -- --list
 *   pnpm smoke:split-upgrade -- --old <old.tgz> --new <new.tgz> --case <case-id>
 *   pnpm smoke:split-upgrade -- --old <old.tgz> --new <new.tgz> --suite <suite>
 *
 * Both artifacts must be real `.tgz` files with a matching package name and a
 * different SHA256. The lane never downloads an arbitrary "latest" build and
 * never derives the old artifact by mutating the new one.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dshInvocation,
  isolatedEnvironment,
  runDsh,
  runPnpmInstall,
} from './lib/dsh-smoke-harness.mjs'
import { loadDshDistribution, npmDshVersion, PACKAGE_ROOT } from './lib/dsh-distribution.mjs'
import {
  boundedName,
  createSmokeDiagnostics,
  emitInputFailure,
  requireExactSmokeDshPin,
  safeFailureSummary,
  smokeArtifactIdentity,
  SplitSmokeInputError,
  writePrivateReport,
} from './lib/split-smoke-diagnostics.mjs'
import {
  createSplitProcessScope,
  findIsolatedProcesses,
  killIsolatedProcesses,
  seatFree,
} from './lib/split-smoke-processes.mjs'
import {
  listSelectableUpgradeCases,
  parseUpgradeSelectionArgs,
  resolveUpgradeSelection,
  selectedUpgradePassLine,
} from './lib/split-upgrade-selection.mjs'
import { sha256 } from './lib/split-upgrade-support.mjs'

// The two `/reload-client` waits keep their historical import path for the
// shared diagnostics tooling; the ONE implementation lives in Support.
export { waitForAcceptedHandoff, waitForReloadNotice } from './lib/split-upgrade-support.mjs'

const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
const KEEP = process.env.SPLIT_UPGRADE_KEEP === '1'
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
/** The one failure-injection key; only these exact case names are recognized. */
const FAILPOINT = process.env.SPLIT_UPGRADE_SMOKE_FAIL_AFTER
const FIXED_FAILPOINTS = Object.freeze([
  'upgrade.cross-build-compatibility.after-old-host-spawn',
  'client-reload.production-command.after-host-spawn',
  'client-reload.target-source-isolation.after-host-spawn',
])

/** This run's bounded diagnostics (checkpoints + one default failure report). */
let diagnostics

/** One U phase boundary: remembered and announced by default, never FIELDS. */
function checkpoint(name) {
  diagnostics?.checkpoint(name)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/**
 * Copy one live process handle into bounded failure facts. The PID is derived
 * from the FULL record chain, then stored beside the last eight event records;
 * long scenes must not lose their identity merely because the identity record
 * fell out of the event window.
 */
export function snapshotFailureHandle(handle) {
  if (handle === null || typeof handle !== 'object') return undefined
  const records = Array.isArray(handle.records) ? handle.records : []
  let identity
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const name = records[index]?.m4a0
    if (name === 'ready' || name === 'client-started') {
      identity = records[index]
      break
    }
  }
  const snapshot = {
    role: handle.role,
    exited: handle.exited === true,
    exitResult: handle.exitResult === undefined ? undefined : { ...handle.exitResult },
    records: records.slice(-8),
  }
  const pid = Number.isInteger(handle.pid) ? handle.pid : identity?.pid
  if (Number.isInteger(pid)) snapshot.pid = pid
  return snapshot
}

function failpoint(name) {
  if (!FIXED_FAILPOINTS.includes(name)) throw new TypeError(`split upgrade smoke: unknown failpoint ${name}`)
  if (FAILPOINT !== undefined && FAILPOINT === name) throw new Error(`qualification failpoint: ${name}`)
}

function readTarballManifest(path) {
  const result = spawnSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`the tarball manifest could not be read from ${path}: ${result.stderr || String(result.error ?? '')}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`the tarball manifest is not valid JSON: ${String(error)}`)
  }
}

function inspectArtifact(path, label) {
  const absolute = resolve(path)
  let info
  try {
    info = lstatSync(absolute)
  } catch {
    throw new Error(`${label} artifact does not exist: ${absolute}`)
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} artifact must be a regular file with exactly one link: ${absolute}`)
  }
  const manifest = readTarballManifest(absolute)
  if (manifest?.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`${label} artifact must be ${EXPECTED_PACKAGE_NAME}, got ${String(manifest?.name)}`)
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    throw new Error(`${label} artifact has an invalid version: ${String(manifest.version)}`)
  }
  return { path: absolute, manifest, sha256: sha256(absolute) }
}

/**
 * Parse the lane arguments. Exported so the tooling wiring test can prove the
 * fail-closed argument contract without running the expensive real lane.
 */
export function parseUpgradeArguments(argv) {
  const parsed = resolveUpgradeSelection(parseUpgradeSelectionArgs(argv))
  if (parsed.mode === 'list' || parsed.mode === 'help') return parsed
  const oldPath = resolve(parsed.old)
  const newPath = resolve(parsed.new)
  if (oldPath === newPath) {
    throw new SplitSmokeInputError(
      'INPUT_SMOKE_SELECTION_INVALID',
      'INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): '
        + 'split upgrade smoke: --old and --new must name different artifacts',
    )
  }
  return {
    ...parsed,
    old: oldPath,
    new: newPath,
    evidence: parsed.evidence === undefined ? undefined : resolve(parsed.evidence),
  }
}

/**
 * Write an operator-requested evidence document, or fail the lane.
 *
 * The PASS document is part of what the operator asked for, so a write that
 * cannot land is not a pass: the lane must exit nonzero instead of announcing
 * its success marker with no evidence behind it. The FAIL twin keeps the
 * opposite rule (a diagnostic write must never mask the real failure), so only
 * this requested-document path throws.
 */
export function writeRequestedEvidence(path, value) {
  if (writePrivateReport(path, value) === true) return
  throw Object.assign(new Error('the requested --evidence file could not be written'), {
    category: 'INFRA_FAILURE',
    code: 'EVIDENCE_WRITE_FAILED',
  })
}

function usage() {
  return [
    'usage: pnpm smoke:split-upgrade -- --old <absolute-old.tgz> --new <absolute-new.tgz> [--evidence <file>]',
    '       pnpm smoke:split-upgrade -- --list',
    '       pnpm smoke:split-upgrade -- --old <old.tgz> --new <new.tgz> --case upgrade.cross-build-compatibility',
    '       pnpm smoke:split-upgrade -- --old <old.tgz> --new <new.tgz> --suite client-reload',
    '       pnpm smoke:split-upgrade -- --old <old.tgz> --new <new.tgz> --case client-reload.production-command',
    '       pnpm smoke:split-upgrade -- --old <old.tgz> --new <new.tgz> --case client-reload.target-source-isolation',
  ].join('\n')
}

/** The ONE registry-backed selectable listing (no tarball, no setup). */
function printSelectableUpgradeCases() {
  process.stdout.write('SPLIT_UPGRADE_SELECTABLE_CASES scope=SELECTABLE_ONLY\n')
  for (const entry of listSelectableUpgradeCases()) {
    process.stdout.write(`suite=${entry.suite} case=${entry.id} title=${entry.title}\n`)
  }
}

/** Merge one case's real evidence fragment into the lane's accumulated JSON. */
function mergeEvidence(evidence, fragment) {
  for (const [key, value] of Object.entries(fragment)) {
    if ((key === 'old' || key === 'new') && value !== null && typeof value === 'object') {
      Object.assign(evidence[key], value)
    } else {
      evidence[key] = value
    }
  }
}

/**
 * The ONE protected setup/run/cleanup boundary.
 *
 * The Runner installs the single shared DSH CLI harness and creates the single
 * process scope; cases own their own installed profiles, real Host/Client
 * processes and round roots. The Runner finally is the OS process-group and
 * registered-DSH_HOME backstop only.
 */
async function runScene(options, oldArtifact, newArtifact, targetDshVersion) {
  let workRoot
  let home
  let dshHome
  let harnessDir
  let scratch
  let env
  let evidence
  const isolatedHomes = new Set()
  const registerIsolatedHome = path => { isolatedHomes.add(path) }
  const failureProcesses = []
  const publishedScopes = new Set()
  // Scope directories can disappear during Case/owner cleanup. Capture the
  // published Host scope identities BEFORE cleanup for the failpoint Seat proof.
  const collectPublishedScopes = () => {
    for (const isolatedHome of isolatedHomes) {
      const scopeRoot = join(isolatedHome, 'run', 'dsh-pi-tui')
      if (!existsSync(scopeRoot)) continue
      for (const entry of readdirSync(scopeRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) publishedScopes.add(entry.name)
      }
    }
  }
  // Case-owned failure snapshot: the case copies its live handles into bounded
  // facts BEFORE its own finally mutates/disposes them. The Runner still emits
  // the one report after the throw.
  const captureFailure = handles => {
    collectPublishedScopes()
    for (const handle of handles) {
      const snapshot = snapshotFailureHandle(handle)
      if (snapshot !== undefined) failureProcesses.push(snapshot)
    }
  }
  let failpointTriggered = false
  const { EntryProcess, SurfaceEntryProcess, activeProcesses } = createSplitProcessScope()
  try {
    const distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
    workRoot = mkdtempSync(join(tmpdir(), 'dsh-split-upgrade-'))
    home = join(workRoot, 'home')
    dshHome = join(workRoot, 'dsh-home')
    isolatedHomes.add(dshHome)
    harnessDir = join(workRoot, 'harness')
    scratch = join(workRoot, 'scratch')
    for (const directory of [home, dshHome, harnessDir, scratch]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(workRoot, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
    env = isolatedEnvironment(workRoot, home, dshHome, join(workRoot, 'evidence.json'))
    // The upgrade work root must be a real OS temp root outside this checkout:
    // an ancestor `node_modules` would otherwise lend the Client peer set that
    // each isolated installation must own itself (issue #476).
    const workRootFromCheckout = relative(realpathSync(PACKAGE_ROOT), realpathSync(workRoot))
    if (!(workRootFromCheckout === '..' || workRootFromCheckout.startsWith(`..${sep}`))) {
      throw new Error(`the split-upgrade work root must be outside the checkout: ${workRoot}`)
    }
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-split-upgrade-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': targetDshVersion,
      },
    }, null, 2) + '\n', 'utf8')
    runPnpmInstall(harnessDir, env, distribution)
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (!(version.status === 0 && version.stdout.trim() === targetDshVersion)) {
      throw new Error(`installed DSH version ${JSON.stringify(version.stdout.trim())} is not the pinned ${targetDshVersion}`)
    }
    const anchor = realpathSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    evidence = {
      lane: 'split-process upgrade safety',
      status: 'RUNNING',
      dshVersion: targetDshVersion,
      old: {
        tarball: basename(oldArtifact.path),
        sha256: oldArtifact.sha256,
        packageVersion: oldArtifact.manifest.version,
        sourceRevision: process.env.SPLIT_UPGRADE_OLD_REVISION,
      },
      new: {
        tarball: basename(newArtifact.path),
        sha256: newArtifact.sha256,
        packageVersion: newArtifact.manifest.version,
      },
    }
    const context = {
      EntryProcess,
      SurfaceEntryProcess,
      workRoot,
      home,
      dshHome,
      harnessDir,
      env,
      dsh,
      anchor,
      targetDshVersion,
      oldArtifact,
      newArtifact,
      checkpoint,
      failpoint: name => {
        if (FAILPOINT !== undefined && FAILPOINT === name) failpointTriggered = true
        failpoint(name)
      },
      registerIsolatedHome,
      captureFailure,
    }
    if (options.mode === 'full') {
      for (const entry of listSelectableUpgradeCases()) {
        diagnostics.checkpoint(`case/${entry.id}`)
        const fragment = await entry.run(context)
        mergeEvidence(evidence, fragment)
      }
      for (const path of [oldArtifact.path, newArtifact.path]) {
        if (sha256(path) !== (path === oldArtifact.path ? oldArtifact.sha256 : newArtifact.sha256)) {
          throw new Error(`the packaged artifact changed during the lane: ${basename(path)}`)
        }
      }
      evidence.status = 'PASS'
      evidence.verdict = 'cross-build-compatible'
      if (options.evidence !== undefined) writeRequestedEvidence(options.evidence, evidence)
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
      process.stdout.write('SPLIT_UPGRADE_SMOKE_PASS (cross-build-compatible)\n')
      return
    }
    // Selected mode: only the cases registered for this exact selection run.
    const selectedEvidence = {
      lane: 'split-process upgrade safety',
      scope: 'SELECTABLE_ONLY',
      dshVersion: targetDshVersion,
      old: {
        tarball: basename(oldArtifact.path),
        sha256: oldArtifact.sha256,
        packageVersion: oldArtifact.manifest.version,
      },
      new: {
        tarball: basename(newArtifact.path),
        sha256: newArtifact.sha256,
        packageVersion: newArtifact.manifest.version,
      },
      selectedCases: [],
    }
    for (const entry of options.cases) {
      diagnostics.checkpoint(`case/${entry.id}`)
      const fragment = await entry.run(context)
      mergeEvidence(selectedEvidence, fragment)
      selectedEvidence.selectedCases.push(entry.id)
    }
    for (const path of [oldArtifact.path, newArtifact.path]) {
      if (sha256(path) !== (path === oldArtifact.path ? oldArtifact.sha256 : newArtifact.sha256)) {
        throw new Error(`the packaged artifact changed during the lane: ${basename(path)}`)
      }
    }
    if (options.evidence !== undefined) writeRequestedEvidence(options.evidence, selectedEvidence)
    process.stdout.write(`${JSON.stringify(selectedEvidence, null, 2)}\n`)
    for (const id of selectedEvidence.selectedCases) process.stdout.write(`${selectedUpgradePassLine(id)}\n`)
  } catch (error) {
    // Report BEFORE the cleanup below: the projection reads the still-live
    // process handles, and the work root still exists while it is built.
    diagnostics.reportFailure(error, {
      processes: [...failureProcesses, ...activeProcesses],
      evidencePath: options.evidence,
    })
    throw error
  } finally {
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    collectPublishedScopes()
    for (const isolatedHome of isolatedHomes) killIsolatedProcesses(isolatedHome)
    if (FAILPOINT !== undefined && failpointTriggered && workRoot !== undefined) {
      await proveFailpointCleanup(isolatedHomes, publishedScopes)
    }
    if (workRoot === undefined) {
      // Nothing was created: setup failed before the work root existed.
    } else if (!KEEP) {
      rmSync(workRoot, { recursive: true, force: true })
    } else {
      process.stderr.write(`preserved split-upgrade environment: ${workRoot}\n`)
    }
  }
}

/**
 * The qualification-only cleanup proof behind `SPLIT_UPGRADE_SMOKE_FAIL_AFTER`.
 *
 * It scans every DSH_HOME this run registered (the main one plus each case's
 * isolated round home), and only reports `seats=free` for scopes that actually
 * published one. A failure before any scope existed reports `seats=unchecked`.
 */
async function proveFailpointCleanup(isolatedHomes, publishedScopes) {
  let leftovers = 0
  for (const isolatedHome of isolatedHomes) {
    let pids = findIsolatedProcesses(isolatedHome)
    for (let attempt = 0; attempt < 100 && pids.length > 0; attempt += 1) {
      await sleep(50)
      killIsolatedProcesses(isolatedHome)
      pids = findIsolatedProcesses(isolatedHome)
    }
    leftovers += pids.length
  }
  // Only scopes captured BEFORE cleanup are evidence. A scope directory that
  // vanished during owner cleanup is not silently reclassified as free.
  const scopeIds = [...publishedScopes]
  let seatsOk = true
  for (const scopeId of scopeIds) {
    for (const seatName of [`\0dsh-pi-tui-h-${scopeId.slice(0, 40)}`, `\0dsh-pi-tui-c-${scopeId.slice(0, 40)}`]) {
      try {
        await seatFree(seatName, 15_000)
      } catch {
        seatsOk = false
        console.error(`SPLIT_UPGRADE_FAILPOINT_SEAT_FAILURE seat=${boundedName(seatName)} the Seat stayed owned`)
        break
      }
    }
    if (!seatsOk) break
  }
  const seats = scopeIds.length === 0 ? 'unchecked' : seatsOk ? 'free' : 'busy'
  console.error(`SPLIT_UPGRADE_FAILPOINT_CLEANUP leftovers=${String(leftovers)} seats=${seats}`)
  if (leftovers > 0 || seats !== 'free') {
    process.exitCode = 1
    return
  }
  console.error('SPLIT_UPGRADE_FAILPOINT_CLEANUP_OK')
}

/** Strict CLI dispatch: `--list`, the old help, the complete lane or one selection. */
async function runLane() {
  let options
  try {
    options = parseUpgradeArguments(process.argv.slice(2))
  } catch (error) {
    // A selector error exists before any reporter: it leaves the ONE fixed
    // input projection and never a work root, an install or a process.
    emitInputFailure({ lane: 'split-upgrade', heading: 'SPLIT_PROCESS_UPGRADE_SMOKE', error })
    throw error
  }
  if (options.mode === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (options.mode === 'list') {
    printSelectableUpgradeCases()
    return
  }
  // Input qualification BEFORE any install: both artifacts must be readable
  // real single-link tarballs with the same package name and different bytes,
  // versions and exact DSH pins.
  let oldArtifact
  let newArtifact
  let targetDshVersion
  try {
    oldArtifact = inspectArtifact(options.old, 'old')
    newArtifact = inspectArtifact(options.new, 'new')
    if (oldArtifact.sha256 === newArtifact.sha256) {
      throw new Error('split upgrade smoke: --old and --new must be different packaged bytes')
    }
    if (oldArtifact.manifest.version === newArtifact.manifest.version) {
      throw new Error('split upgrade smoke: --old and --new must carry different package versions')
    }
    targetDshVersion = npmDshVersion()
    diagnostics = createSmokeDiagnostics({
      lane: 'split-upgrade',
      heading: 'SPLIT_PROCESS_UPGRADE_SMOKE',
      marker: 'U',
      runtimeDshPin: targetDshVersion,
      artifacts: [
        smokeArtifactIdentity('old', oldArtifact.manifest, oldArtifact.sha256),
        smokeArtifactIdentity('new', newArtifact.manifest, newArtifact.sha256),
      ],
    })
    // Input qualification BEFORE any install (the same exact-pin rule the
    // production Client reexec preflight applies): a differently pinned artifact
    // is an invalid test pairing, not a product result to observe.
    requireExactSmokeDshPin('old', oldArtifact.manifest, targetDshVersion)
    requireExactSmokeDshPin('new', newArtifact.manifest, targetDshVersion)
  } catch (error) {
    if (diagnostics === undefined) {
      emitInputFailure({
        lane: 'split-upgrade',
        heading: 'SPLIT_PROCESS_UPGRADE_SMOKE',
        error,
        evidencePath: options?.evidence,
      })
    } else {
      diagnostics.reportFailure(error, { evidencePath: options.evidence })
    }
    throw error
  }
  // The startup identity is announced only AFTER preflight qualified it.
  process.stderr.write(`${diagnostics.identityLine()}\n`)
  diagnostics.checkpoint('preflight/artifacts')
  await runScene(options, oldArtifact, newArtifact, targetDshVersion)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLane().catch(error => {
    // The machine identifier, then the REAL caught error. `KEEP` only preserves
    // the temporary scene; it never decides whether the root cause is visible.
    process.stderr.write(`SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE: ${safeFailureSummary(error)}\n`)
    process.stderr.write(`${error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error ?? '')}\n`)
    process.exitCode = 1
  })
}
