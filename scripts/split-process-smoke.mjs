#!/usr/bin/env node
/**
 * Real-OS split-process authenticated-link smoke.
 *
 * Installs the candidate tarball into an isolated `pi-tui` profile using the
 * published exact DSH family, then drives the two internal process entries
 * from the installed package directory. The lane proves the lifecycle
 * assertions that still hold plus the first-launch gates:
 *
 *   T01 Host-only composition + official Connection/API-remotes owners
 *   T02 authenticated loopback HTTP + one real WebSocket `$events` generation
 *   T03/T04/T06 unauthenticated, wrong-token, wrong-identity refusals
 *   T05 one mux socket per authenticated peer; old Peer is dead after release
 *   T07 private-file permissions/symlinks fail closed
 *   T08 sixteen concurrent Host launches produce exactly one Host
 *   T09 two REAL Surface Clients (distinct PTYs/PIDs) admit to the SAME Host
 *   T09Q two qualification Clients race the ONE qualification-only Client seat
 *   M5B-01 two REAL Surface Clients retain the SAME Session X: shared history
 *                and Host stream, shared pending inbox plus the official
 *                empty-draft Ctrl+S steer of the other Client's occurrence,
 *                two independent same-text submits (never merged), A -> Y
 *                navigation while B keeps writing X, B-only exit
 *   G567 navigation-first forwarded interaction: a no-answer Alt+W hold opens
 *                the existing Session Workspace, the same official request is
 *                re-offered only after its own Session commits, and a loser
 *                never resurrects or produces a second Host settlement
 *   T10/T11/T12 Client normal exit, SIGKILL and SIGTERM leave the Host alive
 *   T13 a physical mux drop clears the generation and the same Host replaces it
 *   T14/T16/T17 forged registry, unresponsive Host, protocol/identity/auth failures
 *                and non-destructive installed-payload drift
 *   T15 a dead Host leaves only a stale candidate; a Client safely starts a new one
 *   T75 the PRODUCT Browser x real Split TUI qualification (WP-01..WP-11):
 *                token->Cookie->official Web shell, two-way Session/Turn,
 *                Question/Approval first settlement, TUI reload/exit/SIGKILL,
 *                `/web` toggle + recomposition, locality and the feature matrix
 *   T73 the official Web frontend runtime toggle on ONE Host: default-off
 *                serving, setEnabled(true) mounting the 59 declared rows,
 *                setEnabled(false) while a real TUI holds an accepted Turn (the
 *                Turn settles, the TUI keeps its Session and keeps prompting),
 *                a second enable on the SAME process with a real Chromium run,
 *                a second disable, and the refusing negative lanes
 *   T18 installed package shape and Direct `--help` remain unchanged
 *   T19 signal admission precedes publication; repeated same signals stay idempotent (no ready)
 *   T20 an early forced exit removes the Host-created scratch before profile boot
 *   T21 the official Session-serving rows, the ONE official Workspace registry /
 *                controller pair, and ONE built-in Host Runtime row are ACTIVE
 *   T22/T23/T24 a real Client PID proves official session/list, private PiFile RPC
 *                and the private terminal-progress snapshot over the authenticated link
 *   T25 repeated probes register no duplicate descriptor; Client exit keeps the same Host
 *   T26 Host Runtime row/artifact absence / required official row / Workspace
 *                Controller row disabled / Cookie fail closed, no Ready
 *   T27 a real `workspace` Remote creates a Host Workspace, is idempotent, and
 *                restores its baseline for a later Client PID after generation
 *                replacements
 *
 * Usage: node scripts/split-process-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:split-process -- [path-to-candidate.tgz]
 *
 * Set SPLIT_PROCESS_SMOKE_KEEP=1 to preserve the isolated work directory and
 * SPLIT_PROCESS_TRACE=<path> to append sanitized qualification events (never a
 * token, Cookie or connect URL).
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  boundedName,
  createSmokeDiagnostics,
  emitInputFailure,
  redactErrorForStep,
  safeFailureSummary,
  smokeArtifactIdentity,
  SplitSmokeAssertionError,
  SplitSmokeInputError,
} from './lib/split-smoke-diagnostics.mjs'
import {
  createSplitSmokeProfile,
  inspectSplitCandidate,
} from './lib/split-smoke-profile.mjs'
import {
  createSplitProcessScope,
  findIsolatedProcesses,
  killIsolatedProcesses,
  killTracked,
  seatFree,
  waitForCondition,
} from './lib/split-smoke-processes.mjs'
import {
  listSelectableCases,
  parseSelectionArgs,
  resolveSelection,
  selectedPassLine,
} from './lib/split-smoke-selection.mjs'
import { ENTRY_ADMISSION_MUTATIONS } from './smoke/split-process/entry-admission.mjs'

// Re-exported for the tooling guards that drive the bounded condition wait.
export { waitForCondition }


const TRACE_PATH = process.env.SPLIT_PROCESS_TRACE
const KEEP = process.env.SPLIT_PROCESS_SMOKE_KEEP === '1'
/** Qualification-only failure point for the smoke's own finally cleanup proof. */
const FAILPOINT = process.env.SPLIT_PROCESS_SMOKE_FAIL_AFTER
/**
 * Whether THIS run must prove the real Browser case. The CI release-tag lane
 * has no pinned Playwright install, so it legitimately reports the Browser
 * case as NOT_RUN and never claims it; a PR-A qualification run sets this to
 * turn a missing Browser into a hard failure.
 */
const REQUIRE_WEB_BROWSER = process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'
/**
 * M5-W PR-D: whether THIS run must prove the full product Browser x real-TUI
 * qualification (WP-01..WP-10). It defaults OFF and reports `NOT_RUN`; the npm
 * release-tag CI job and a manual PR-D qualification set it to require the
 * whole product matrix. A missing Playwright install, a failed case or a
 * partial matrix is a hard failure only in this required mode.
 */
const REQUIRE_WEB_PRODUCT = process.env.SPLIT_PROCESS_REQUIRE_WEB_PRODUCT === '1'

let traceFd
/** This run's bounded diagnostics (checkpoints + one default failure report). */
let diagnostics
// The lane's ONE process scope: module-level qualification helpers and the
// full/selected dispatchers resolve the same constructors. A CLI run takes
// exactly one of those paths, so this active set never spans two runs.
const { EntryProcess, SurfaceEntryProcess, activeProcesses } = createSplitProcessScope()
/** Detached processes this round owns: PID -> its kernel starttime (if known). */
const trackedProcesses = new Map()

/**
 * One business milestone: its bounded NAME is announced on stderr by default
 * (so a long scene keeps visible intermediate progress) and its optional
 * fields go to the explicit SPLIT_PROCESS_TRACE JSONL. Lifecycle scopes
 * (START/DONE/ERROR with durations) stay owned by `diagnostics.runStep`; this
 * function never prints the raw event fields. Never pass a secret.
 */
function trace(event, fields = {}) {
  diagnostics?.checkpoint(event)
  if (TRACE_PATH === undefined || TRACE_PATH === '') return
  if (traceFd === undefined) {
    mkdirSync(dirname(resolve(TRACE_PATH)), { recursive: true })
    traceFd = openSync(TRACE_PATH, 'a', 0o600)
  }
  writeFileSync(traceFd, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`)
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * Run one selected case AND its verdict admission inside the SAME lifecycle
 * scope. A rejected selected verdict is the case's own ERROR (and therefore the
 * report's `failedStep`), never a post-DONE lane failure attributed to a
 * completed case. Exported for the tooling guard.
 */
export async function runSelectedCase(diagnostics, selectedCase, context) {
  return diagnostics.runStep(`case/${selectedCase.id}`, async () => {
    const result = await selectedCase.run(context)
    assertSelectedVerdict(selectedCase.id, result)
    return result
  })
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function failpoint(name) {
  if (FAILPOINT === name) throw new Error(`qualification failpoint: ${name}`)
}

async function main(explicitPath) {
  // The input phase has its own failure boundary: nothing exists yet, so the
  // lane may only emit the fixed safe projection (identity when the manifest
  // was readable, processes when none exist).
  let candidate
  try {
    // Input qualification BEFORE any install: the candidate must declare this
    // checkout's exact DSH runtime pin, the same rule the production Client
    // reexec preflight applies to a replacement target.
    candidate = inspectSplitCandidate(explicitPath)
  } catch (error) {
    emitInputFailure({
      lane: 'split-process',
      heading: 'SPLIT_PROCESS_SMOKE',
      error,
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw error
  }
  const { tarball, manifest: candidateManifest, candidateSha256, targetDshVersion } = candidate
  diagnostics = createSmokeDiagnostics({
    lane: 'split-process',
    heading: 'SPLIT_PROCESS_SMOKE',
    marker: 'T',
    runtimeDshPin: targetDshVersion,
    artifacts: [smokeArtifactIdentity('candidate', candidateManifest, candidateSha256)],
  })
  // The startup identity is announced only AFTER preflight qualified it.
  process.stderr.write(`${diagnostics.identityLine()}\n`)
  diagnostics.checkpoint('preflight/candidate-input')
  // The setup itself is inside the same failure boundary: a `mkdtemp`, `mkdir`
  // or `writeFileSync` failure must still leave the safe report AND still remove
  // whatever root was already created, instead of escaping past the cleanup.
  let workDir
  let dshHome
  // The setup itself is inside the same failure boundary: a `mkdtemp`, `mkdir`
  // or `writeFileSync` failure must still leave the safe report AND still remove
  // whatever root was already created, instead of escaping past the cleanup.
  try {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-split-process-'))
    // The cleanup scans this exact DSH_HOME even when the profile installation
    // fails before returning: assign it before the install, not after.
    dshHome = join(workDir, 'dsh-home')
    const installation = createSplitSmokeProfile({ tarball, targetDshVersion, workDir })
    const {
      entries,
      clientPeers,
      base: installedBase,
    } = installation
    trace('client-peer-install', {
      owner: 'active pi-tui profile',
      peers: clientPeers.map(([name, version]) => `${name}@${version}`),
      harnessOwnsClientPeer: false,
    })
    // The whole-lane mutation control injects ONE of the two installed-profile
    // faults the entry-admission case owns, so the patch must exist before the
    // first migrated case boots a Host with this base. The case writes the same
    // two descriptors for its own isolated negative controls.
    const mutationMode = process.env.SPLIT_PROCESS_SMOKE_MUTATION
    const mutation = mutationMode !== undefined && Object.hasOwn(ENTRY_ADMISSION_MUTATIONS, mutationMode)
      ? ENTRY_ADMISSION_MUTATIONS[mutationMode]
      : undefined
    if (mutation !== undefined) writeFileSync(join(workDir, mutation.file), mutation.body)
    // The running mutation wins when present (those cases replace the isolated
    // surface LLM overlay); otherwise the shared install's default stub-LLM
    // patch stays the ONE extra patch.
    const base = mutation === undefined
      ? installedBase
      : { ...installedBase, env: { ...installedBase.env, SPLIT_PROCESS_EXTRA_PATCH: join(workDir, mutation.file) } }
    // The ONE context every migrated case receives: the installed profile facts,
    // the scope-bound process constructors and the lane's single trace/failpoint
    // owner. A case never installs a second profile and never creates a scope.
    const context = {
      installation,
      EntryProcess,
      SurfaceEntryProcess,
      entries,
      base,
      workDir,
      dshHome,
      profilePackage: installation.profilePackage,
      tarball,
      candidateSha256,
      targetDshVersion,
      trace,
      failpoint,
      mode: 'full',
      // The scenario's own lifecycle scopes (START/DONE/ERROR) share this ONE
      // diagnostics collector; the runner adds the enclosing case scope.
      runStep: (name, operation) => diagnostics.runStep(name, operation),
      // Backstop only: the case kills its own detached processes first.
      trackDetachedPid: (pid, starttime) => trackedProcesses.set(pid, starttime),
    }
    /**
     * The Full lane IS the registry: every registered case runs once, in the
     * frozen order, and its real return value is recorded. There is no second
     * hand-written case list and no skipped-case assumption.
     */
    const actualCaseResults = []
    for (const registeredCase of listSelectableCases()) {
      const result = await diagnostics.runStep(
        `case/${registeredCase.id}`,
        () => registeredCase.run(context),
      )
      actualCaseResults.push({
        id: registeredCase.id,
        status: typeof result?.status === 'string' ? result.status : 'PASS',
        result,
      })
    }
    const registeredIds = listSelectableCases().map(entry => entry.id)
    const completedIds = actualCaseResults.map(entry => entry.id)
    assert(completedIds.length === registeredIds.length
      && registeredIds.every(id => completedIds.includes(id))
      && new Set(completedIds).size === completedIds.length,
    'T60 the actual case results do not match the frozen registry')
    const resultOf = id => actualCaseResults.find(entry => entry.id === id)
    const statusOf = id => resultOf(id)?.status ?? 'NOT_RUN'
    const requireWebBrowser = process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'
    const requireWebProduct = process.env.SPLIT_PROCESS_REQUIRE_WEB_PRODUCT === '1'
    const webCompositionResult = resultOf('web.official-composition')?.result
    const webToggleResult = resultOf('web.runtime-toggle')?.result
    const webPreferenceResult = resultOf('web.startup-preference')?.result
    const webProductResult = resultOf('web.product-browser-tui')?.result
    const webBrowserVerdict = webCompositionResult?.browser ?? 'NOT_RUN'
    const toggleBrowserVerdict = webToggleResult?.browser ?? 'NOT_RUN'
    // A required Browser run is met by PASS and nothing else. An optional run
    // records the honest NOT_RUN/INCOMPLETE verdict and never claims PASS.
    assert(!requireWebBrowser || (webBrowserVerdict === 'PASS' && toggleBrowserVerdict === 'PASS'),
      `T60 the required real-Browser qualification ended as ${String(webBrowserVerdict)}/${String(toggleBrowserVerdict)}; only PASS qualifies this lane`)
    assert(!requireWebProduct
      || ((webProductResult?.status === 'PASS' || webProductResult?.status === 'DEFERRED_WITH_OWNER')
        && webProductResult?.browserSubset === 'PASS'),
      `T60 the required product Browser x TUI subset ended as ${String(webProductResult?.browserSubset ?? webProductResult?.status)}`)
    assert(webPreferenceResult?.verified === true, 't74 the Web startup preference qualification did not complete')
    assert(webProductResult?.status === 'NOT_RUN'
      || ((webProductResult?.status === 'PASS' || webProductResult?.status === 'DEFERRED_WITH_OWNER')
        && webProductResult?.browserSubset === 'PASS'),
      `t75 the product Browser x TUI subset ended as ${String(webProductResult?.browserSubset ?? webProductResult?.status)}`)
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'T60 the candidate artifact changed during the split-process qualification')
    const webProductStatus = webProductResult?.status ?? 'NOT_RUN'
    trace('t60', {
      candidate: basename(tarball),
      sha256: candidateSha256,
      dshVersion: targetDshVersion,
      webComposition: webBrowserVerdict === 'PASS'
        ? 'PASS_OFFICIAL_WEB_COMPOSITION_REAL_BROWSER'
        : `NOT_RUN_OR_INCOMPLETE(${webBrowserVerdict})`,
      webBrowser: webBrowserVerdict,
      webRuntimeToggle: toggleBrowserVerdict === 'PASS'
        ? 'PASS_OFFICIAL_WEB_RUNTIME_TOGGLE_REAL_BROWSER'
        : `NOT_RUN_OR_INCOMPLETE(${toggleBrowserVerdict})`,
      webRuntimeToggleBrowser: toggleBrowserVerdict,
      webStartupPreference: webPreferenceResult?.verified === true
        ? 'PASS_PROFILE_AUTOSTART_AND_WEB_ENTRY_REAL_PROCESSES'
        : 'NOT_VERIFIED',
      webProduct: webProductStatus === 'PASS'
        ? 'PASS_PRODUCT_BROWSER_X_REAL_TUI'
        : webProductResult?.browserSubset === 'PASS'
          ? 'BROWSER_SUBSET_PASS_WC12_DEFERRED_WITH_OWNER'
          : 'NOT_RUN_OR_INCOMPLETE',
      webProductStatus,
      webProductBrowserSubset: webProductResult?.browserSubset,
      webProductWc: webProductResult?.wc,
      m4c1: statusOf('bootstrap.host-runtime-disabled') === 'PASS' ? 'PASS_REAL_SPLIT_PROCESS' : 'NOT_RUN',
      m5b: statusOf('multi-client.shared-session-interactions') === 'PASS'
        ? 'pass (two REAL surface Clients retained ONE Session X; shared pending inbox + official Ctrl+S steer of the other Client\'s occurrence; two independent same-text submits stayed two; A -> Y navigation kept B writing X; B-only exit kept A/Host)'
        : 'NOT_RUN',
      m5n: statusOf('navigation.non-destructive-client-lifecycle') === 'PASS'
        ? 'pass (NON-DESTRUCTIVE navigation: /new and /resume left a held-running Host Turn alive -> completed; a RUNNING target projected without an idle wait; already-current no-op; a Host-queued occurrence stayed with X across the Client\'s departure; explicit Busy Esc still aborted the exact Turn)'
        : 'NOT_RUN',
      t44t48: statusOf('recovery.detached-turn-interactions') === 'PASS' ? 'pass' : 'NOT_RUN',
      t49t55: statusOf('recovery.detached-turn-interactions') === 'PASS'
        ? 'pass (T49-T55, including detached pending UNKNOWN, real Gateway owner-stream eligibility, the old-peer protocol negatives and same-PID HMR pending question/approval)'
        : 'NOT_RUN',
      t56t59: statusOf('recovery.client-hmr-signals') === 'PASS' ? 'pass' : 'NOT_RUN',
      t60Status: statusOf('bootstrap.host-runtime-disabled') === 'PASS'
        ? 'PASS_REAL_SPLIT_PROCESS: T01-T66 split-process inventory and T26a restored identity completed; release gates pending the stage-final lane verdict'
        : 'NOT_RUN',
      t61StaleGeneration: statusOf('surface.pty-session-write-recovery') === 'PASS'
        ? 'pass (real mux rollover, one stale write not dispatched, one new-generation commit)' : 'NOT_RUN',
      t62ClientSigint: statusOf('recovery.client-hmr-signals') === 'PASS'
        ? 'pass (business PID SIGINT -> exit 130, client resources released, Host identity kept)' : 'NOT_RUN',
      t63KeyboardExit: statusOf('recovery.client-hmr-signals') === 'PASS'
        ? 'pass (real PTY double Ctrl+C and double Ctrl+D, empty draft)' : 'NOT_RUN',
      t64HostSighup: statusOf('recovery.client-hmr-signals') === 'PASS'
        ? 'pass (process failure, no fabricated settlement, new Host instance on stale discovery)' : 'NOT_RUN',
      t65HostSigkill: statusOf('recovery.client-hmr-signals') === 'PASS'
        ? 'pass (attached Client, no fake success, no cross-Host view continuity, no replayed write)' : 'NOT_RUN',
      t66UnknownWrite: statusOf('recovery.unknown-write-host-death') === 'PASS'
        ? 'pass (ACK-lost write committed once, committing Host killed, cold resume reads it exactly once)' : 'NOT_RUN',
      t57t58HostRows: statusOf('recovery.client-hmr-signals') === 'PASS'
        ? 'pass (every protected Host Loader row kept its live fiber UID across Client-only HMR)' : 'NOT_RUN',
      t26aArtifactMissing: statusOf('bootstrap.runtime-artifact-recovery') === 'PASS'
        ? 'pass (current main real artifact-absent + restored authenticated identity)' : 'NOT_RUN',
      t12PtyHup: statusOf('recovery.client-hmr-signals') === 'PASS'
        ? 'pass (real PTY master close, separate case)' : 'NOT_RUN',
      releaseGates: 'not run by this smoke; stage-final lane records the separate release-gate verdict',
    })
    console.log(`split-process registry smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}; cases=${String(actualCaseResults.length)}/${String(registeredIds.length)}; official Web composition ${webBrowserVerdict === 'PASS' ? 'PASS (real Browser)' : `NOT_QUALIFIED (${webBrowserVerdict})`}; official Web runtime toggle ${toggleBrowserVerdict === 'PASS' ? 'PASS (real Browser)' : `NOT_QUALIFIED (${toggleBrowserVerdict})`}; product Web x real TUI ${webProductStatus === 'PASS' ? 'PASS (real Browser + real PTY TUI)' : webProductResult?.browserSubset === 'PASS' ? `BROWSER SUBSET PASS; WC-12 ${webProductStatus} (Owner decision recorded)` : `NOT_RUN (${webProductStatus})`}`)
  } catch (error) {
    // Report BEFORE the cleanup below: the failure projection must read the
    // still-live process handles, and the work root must still exist while the
    // report is built. The original error is rethrown so the lane still fails.
    diagnostics.reportFailure(error, {
      processes: [...activeProcesses],
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw error
  } finally {
    // A failed assertion must not leave a live Host/Client probe behind; each
    // entry is its own process group leader (`detached: true`).
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    for (const [pid, starttime] of trackedProcesses) killTracked(pid, starttime, 'SIGKILL')
    if (dshHome !== undefined) killIsolatedProcesses(dshHome)
    if (FAILPOINT !== undefined && dshHome !== undefined) {
      // The failpoint proof reads this run's isolated scene: with no scene (a
      // setup failure before the root existed) there is nothing to prove.
      await proveFailpointCleanup(dshHome)
    }
    if (traceFd !== undefined) {
      closeSync(traceFd)
      traceFd = undefined
    }
    if (workDir === undefined) {
      // Nothing was created: setup failed before the work root existed.
    } else if (!KEEP) rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process environment: ${workDir}`)
  }
}

/**
 * The qualification-only cleanup proof behind `SPLIT_PROCESS_SMOKE_FAIL_AFTER`.
 *
 * Both execution paths use it, and it never reports a Seat verdict it did not
 * check: the names come from the scope directories this run's profile actually
 * published under, and an early failure that created no scope directory reports
 * the check as unchecked instead of a fabricated `free`.
 */
async function proveFailpointCleanup(dshHome) {
  let leftovers = findIsolatedProcesses(dshHome)
  for (let attempt = 0; attempt < 100 && leftovers.length > 0; attempt += 1) {
    await sleep(50)
    killIsolatedProcesses(dshHome)
    leftovers = findIsolatedProcesses(dshHome)
  }
  const scopeRoot = join(dshHome, 'run', 'dsh-pi-tui')
  const scopeIds = existsSync(scopeRoot)
    ? readdirSync(scopeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    : []
  let seatsOk = true
  for (const scopeId of scopeIds) {
    // The Host seat and the qualification-only Client seat are the two kernel
    // names one scope can own; a real `surface` Client never binds the second.
    for (const seatName of [`\0dsh-pi-tui-h-${scopeId.slice(0, 40)}`, `\0dsh-pi-tui-c-${scopeId.slice(0, 40)}`]) {
      try {
        await seatFree(seatName, 15_000)
      } catch {
        // The verdict is the fact; the thrown seat text (an abstract socket name
        // derived from this run's scope) is not default output.
        seatsOk = false
        console.error(`FAILPOINT_SEAT_FAILURE seat=${boundedName(seatName)} the Seat stayed owned; see the preserved work root under KEEP`)
        break
      }
    }
    if (!seatsOk) break
  }
  const seats = scopeIds.length === 0 ? 'unchecked' : seatsOk ? 'free' : 'busy'
  console.error(`FAILPOINT_CLEANUP leftovers=${String(leftovers.length)} seats=${seats}`)
  if (leftovers.length > 0 || !seatsOk) process.exitCode = 1
  else console.error('FAILPOINT_CLEANUP_OK')
}

/**
 * Print the ONE registry-backed selectable listing (no tarball, no setup).
 *
 * The registry order IS the execution order a suite or the full lane follows,
 * so the listing prints it verbatim: sorting here would show a bootstrap order
 * that no real run performs.
 */
function printSelectableCases() {
  process.stdout.write('SPLIT_PROCESS_SELECTABLE_CASES scope=SELECTABLE_ONLY\n')
  for (const entry of listSelectableCases()) {
    process.stdout.write(`suite=${entry.suite} case=${entry.id} title=${entry.title}\n`)
  }
}

/**
 * Fail closed when a selected case returns a verdict that is not SELECTED_PASS
 * material. The Full lane aggregates every result; the selected lane must not
 * turn `BLOCKED`/`INCOMPLETE`/`NOT_RUN` into its one-line PASS.
 *
 * Exported for the tooling guard that drives the real return contract without
 * installing a profile.
 */
export function assertSelectedVerdict(caseId, result) {
  if (caseId === 'web.startup-preference') {
    assert(result?.verified === true, `selected ${caseId}: the settings/cold-Host verdict was not verified`)
    return
  }
  if (caseId === 'web.product-browser-tui') {
    assert(result?.browserSubset === 'PASS'
      && (result?.status === 'PASS' || result?.status === 'DEFERRED_WITH_OWNER'),
    `selected ${caseId}: the Browser subset ended as ${String(result?.browserSubset ?? 'missing')}/${String(result?.status ?? 'missing')}`)
    return
  }
  if (caseId.startsWith('web.')) {
    assert(result?.status === 'PASS' && result?.browser === 'PASS',
      `selected ${caseId}: the Browser/Web verdict ended as ${String(result?.browser ?? 'missing')}/${String(result?.status ?? 'missing')}`)
    return
  }
  assert(result?.status === undefined || result?.status === 'PASS',
    `selected ${caseId}: the case returned ${String(result?.status)} instead of a successful verdict`)
}

/**
 * Run ONLY the resolved registry cases in their own isolated installation.
 *
 * This path never calls the full `main()`: no T18, T08, T75 or Browser
 * scenario runs, and the result names the selectable scope only.
 */
async function runSelectedCases(selection) {
  let candidate
  try {
    // A required Browser qualification may only travel with the FULL Web
    // suite: a specific Web --case carries its own Browser requirement, and a
    // non-Web selection must never receive a flag it cannot satisfy.
    const requiresBrowser = process.env.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'
      || process.env.SPLIT_PROCESS_REQUIRE_WEB_PRODUCT === '1'
    if (requiresBrowser && !(selection.mode === 'suite' && selection.suite === 'web')) {
      throw new SplitSmokeInputError('INPUT_SMOKE_SELECTION_INVALID',
        'INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): '
        + 'a required Browser qualification may only travel with --suite web')
    }
    if (process.env.SPLIT_PROCESS_SMOKE_MUTATION !== undefined) {
      throw new SplitSmokeInputError('INPUT_SMOKE_SELECTION_INVALID',
        'INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): '
        + 'SPLIT_PROCESS_SMOKE_MUTATION is a full-lane control and cannot be used with --case or --suite')
    }
    candidate = inspectSplitCandidate(selection.candidate)
  } catch (error) {
    emitInputFailure({
      lane: 'split-process',
      heading: 'SPLIT_PROCESS_SMOKE',
      error,
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw error
  }
  const { tarball, candidateSha256, targetDshVersion } = candidate
  diagnostics = createSmokeDiagnostics({
    lane: 'split-process',
    heading: 'SPLIT_PROCESS_SMOKE',
    marker: 'T',
    runtimeDshPin: targetDshVersion,
    artifacts: [smokeArtifactIdentity('candidate', candidate.manifest, candidateSha256)],
  })
  process.stderr.write(`${diagnostics.identityLine()}\n`)
  diagnostics.checkpoint('preflight/candidate-input')

  let workDir
  let dshHome
  try {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-split-process-'))
    // The cleanup scans this exact DSH_HOME even when the profile installation
    // fails before returning: assign it before the install, not after.
    dshHome = join(workDir, 'dsh-home')
    const installation = createSplitSmokeProfile({ tarball, targetDshVersion, workDir })
    diagnostics.checkpoint('setup/profile-install')
    // The SAME context shape the full lane passes to a migrated case; a selected
    // case gets the ONE installation of this run and never expands its own set.
    const context = {
      installation,
      EntryProcess,
      SurfaceEntryProcess,
      entries: installation.entries,
      base: installation.base,
      workDir,
      dshHome,
      profilePackage: installation.profilePackage,
      tarball,
      candidateSha256,
      targetDshVersion,
      trace,
      failpoint,
      mode: 'selected',
      // Same lifecycle owner as the full lane: one collector, nested scopes.
      runStep: (name, operation) => diagnostics.runStep(name, operation),
      // Backstop only: the case kills its own detached processes first.
      trackDetachedPid: (pid, starttime) => trackedProcesses.set(pid, starttime),
    }
    const selected = []
    for (const selectedCase of selection.cases) {
      await runSelectedCase(diagnostics, selectedCase, context)
      selected.push(selectedCase.id)
    }
    assert(createHash('sha256').update(readFileSync(tarball)).digest('hex') === candidateSha256,
      'the candidate artifact changed during the selected qualification')
    for (const caseId of selected) process.stdout.write(`${selectedPassLine(caseId)}\n`)
  } catch (error) {
    // Report BEFORE the cleanup below: the failure projection must read the
    // still-live process handles, and the work root must still exist while the
    // report is built. The original error is rethrown so the lane still fails.
    diagnostics.reportFailure(error, {
      processes: [...activeProcesses],
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw error
  } finally {
    for (const run of [...activeProcesses]) {
      try { process.kill(-run.child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    // The backstop for detached processes a case created and registered: the
    // case's own `finally` already killed them, and a stale entry is a no-op.
    for (const [pid, starttime] of trackedProcesses) killTracked(pid, starttime, 'SIGKILL')
    if (dshHome !== undefined) killIsolatedProcesses(dshHome)
    if (FAILPOINT !== undefined && dshHome !== undefined) {
      // The failpoint proof reads this run's isolated scene: with no scene (a
      // setup failure before the root existed) there is nothing to prove.
      await proveFailpointCleanup(dshHome)
    }
    if (workDir === undefined) {
      // Nothing was created: setup failed before the work root existed.
    } else if (!KEEP) rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved split-process environment: ${workDir}`)
  }
}

/** Strict CLI dispatch: `--list`, the old full run, or one selected case set. */
async function runLane() {
  let selection
  try {
    selection = resolveSelection(parseSelectionArgs(process.argv.slice(2)))
  } catch (error) {
    // A selector error exists before any reporter: it leaves the ONE fixed
    // input projection and never a work root, an install or a process.
    emitInputFailure({
      lane: 'split-process',
      heading: 'SPLIT_PROCESS_SMOKE',
      error,
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw error
  }
  if (selection.mode === 'list') {
    printSelectableCases()
    return
  }
  if (selection.mode === 'full') {
    await main(selection.candidate)
    return
  }
  await runSelectedCases(selection)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLane().catch(error => {
    // The stable machine identifier first, then the REAL caught error (stack
    // preferred). `KEEP` no longer decides whether the root cause is visible;
    // it only preserves the temporary scene. A Web-case scope applies the one
    // concrete credential redactor before the text leaves the process.
    console.error(`SPLIT_PROCESS_SMOKE_FAILURE: ${safeFailureSummary(error)}`)
    const failedStep = diagnostics?.failedStep?.()
    const raw = error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error ?? '')
    console.error(redactErrorForStep(raw, failedStep))
    process.exitCode = 1
  })
}
