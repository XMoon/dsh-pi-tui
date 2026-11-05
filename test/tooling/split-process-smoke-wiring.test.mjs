/**
 * Split-process smoke wiring guard.
 *
 * The real OS qualification lives in `scripts/split-process-smoke.mjs` and is
 * driven by the dedicated CI split-process job on an npm release tag. An
 * ordinary PR legally skips that job — that skip is NOT the full smoke
 * passing: split-process development work runs `pnpm smoke:split-process`
 * manually under its own task plan. This tooling test keeps the lane discoverable and prevents the
 * script/CI/package wiring from silently rotting while the heavy installation
 * path stays out of the ordinary product lane.
 *
 * @module split-process-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { EntryProcess, PR_A_WEB_ROWS, raceWithAbortableDeadline, redactWebQualificationText, statusMatches, waitForCondition } from '../../scripts/split-process-smoke.mjs'
import { HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-smoke.mjs')

test('the split-process smoke is a package script and a release-tag-only CI job', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-process'], 'node scripts/split-process-smoke.mjs')
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /Host\/Client split-process bootstrap/u)
  assert.match(ci, /pnpm smoke:split-process -- "\$CANDIDATE"/u)
  assert.match(ci, /NOT_APPLICABLE: the startup strictness smoke is npm-only; the Host\/Client split-process job is also npm-only/u)

  // Parse the two jobs rather than only matching prose: the split-process job
  // must own the npm release-tag gate, and `qualify` must explicitly record
  // the source-mode skip for both npm-only surfaces. A text-only assertion
  // could keep passing while the job-level gate or the source record was
  // dropped.
  const workflow = parseYaml(ci)
  const job = workflow.jobs['split-process']
  assert.ok(job, 'the split-process smoke must be its own CI job')
  assert.match(job.if, /startsWith\(github\.ref, 'refs\/tags\/'\)/u,
    'the split-process job must only run on a release tag; an ordinary PR skips it')
  assert.match(job.if, /outputs\.mode == 'npm'/u, 'the split-process job must only run in npm mode')
  // The real npm run once skipped this job because its transitive
  // prepare-dsh-source need is legitimately skipped; without always() the
  // implicit all-needs success check propagates that skip and leaves the
  // required proof unrun. The generic static check only inspects jobs that
  // already use always(), so this exact assertion is the regression guard for
  // that observed scheduling failure.
  assert.match(job.if, /always\(\)/u, 'the split-process job must override the implicit transitive skip')
  const record = workflow.jobs.qualify.steps.find(step => step.name === 'Record the npm-only smoke on a source run')
  assert.ok(record, 'qualify must record the npm-only skip on a source run')
  assert.match(record.run, /startup strictness smoke is npm-only/u)
  assert.match(record.run, /split-process job is also npm-only/u)
})

test('the process smoke script parses as ESM', () => {
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('a stale or unrelated record cannot satisfy a new status request id', () => {
  const stale = { m4a0: 'status', requestId: 'status-1', pid: 10 }
  const fresh = { m4a0: 'status', requestId: 'status-2', pid: 10 }
  const unrelated = { m4a0: 'qualification', requestId: 'status-2', pid: 10 }
  assert.equal(statusMatches(stale, 'status-2'), false)
  assert.equal(statusMatches(fresh, 'status-2'), true)
  assert.equal(statusMatches(unrelated, 'status-2'), false)
})

test('a completed waitForExit does not leave its deadline holding the process', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-process-wait-exit-')
  const entry = join(dir, 'exit-now.mjs')
  writeFileSync(entry, 'process.exit(0)\n')
  const probe = `
    import { EntryProcess } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}
    const child = new EntryProcess('probe', ${JSON.stringify(entry)}, {
      cwd: ${JSON.stringify(dir)},
      env: { ...process.env },
      anchor: ${JSON.stringify(join(dir, 'anchor.json'))},
      profile: 'pi-tui',
      scratch: ${JSON.stringify(dir)},
    })
    const exit = await child.waitForExit(60_000)
    if (exit.code !== 0 || exit.signal !== null) {
      console.error('unexpected probe exit:', JSON.stringify(exit))
      process.exit(1)
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.equal(
    result.status,
    0,
    `the probe did not exit after waitForExit: status=${String(result.status)} signal=${String(result.signal)} ${result.stderr || String(result.error ?? '')}`,
  )
})

test('the candidate pin is qualified against the exact DSH runtime before any setup', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /requireExactSmokeDshPin,[\s\S]*?\} from '\.\/lib\/split-smoke-diagnostics\.mjs'/u,
    'the exact-pin rule is shared with the split-upgrade lane, not restated per script')
  const main = source.slice(source.indexOf('async function main()'))
  const validate = main.indexOf('const candidateManifest = validateCandidateTarball(tarball)')
  const sha = main.indexOf('candidateSha256 = createHash(')
  const target = main.indexOf('targetDshVersion = npmDshVersion()')
  const guard = main.indexOf("requireExactSmokeDshPin('candidate', candidateManifest, targetDshVersion)")
  const distribution = main.indexOf('loadDshDistribution({ mode: ')
  // Located by shape, never by the temp-API token: the temp-hygiene gate text-scans
  // the whole test tree, strings and comments included.
  const workRoot = main.search(/[A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-process-'\)\)/u)
  const install = main.indexOf('runPnpmInstall(harnessDir, env, distribution)')
  assert.ok(validate >= 0 && sha > validate && target > sha && guard > target,
    'the candidate manifest must be read, hashed and pinned against the lane target before anything is set up')
  assert.ok(distribution > guard && workRoot > guard && install > workRoot,
    'an unqualified candidate may not load the distribution, create a work root or install')
  // The shared validator keeps its own public semantics for every other caller.
  assert.doesNotMatch(source, /function validateCandidateTarball/u)
})

test('the upgraded smoke carries every inventory gate and the critical negative controls', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  for (const gate of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T09Q', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19', 'T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30', 'T31', 'T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38', 'T39', 'T40', 'T41', 'T42', 'T43', 'T44', 'T45', 'T46', 'T47', 'T48', 'T49', 'T50', 'T51', 'T52', 'T53', 'T54', 'T55', 'T56', 'T57', 'T58', 'T59', 'T60']) {
    assert.match(source, new RegExp(`\\b${gate}\\b`, 'u'), `missing ${gate}`)
  }
  for (const marker of [
    '/api/pi-tui.local-host',
    '/connect',
    'qualification-drop-websocket',
    'qualification-host-foundation',
    'host-rpc-watch-open',
    'host-rpc-proof',
    'SPLIT_PROCESS_CLIENT_MODE',
    'SPLIT_PROCESS_CLIENT_RECORD_FILE',
    'SPLIT_PROCESS_CLIENT_SESSION',
    'surfaceMounted',
    'sessionOpen',
    'SurfaceEntryProcess',
    'm4b2s-stub-llm',
    'm4b2s',
    'SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK',
    'SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE',
    'SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF',
    'SIGUSR2',
    'waitForComposerDraft',
    'SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY',
    'SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START',
    'assembly-hold',
    'before-start-hold',
    't41',
    't41-gate',
    'SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE',
    't42',
    't43',
    't34',
    't35',
    't36',
    'SPLIT_PROCESS_CLIENT_FORCE_FAILURE',
    'SPLIT_PROCESS_CLIENT_HMR_PROBE',
    'SPLIT_PROCESS_CLIENT_HMR_FAIL',
    'SPLIT_PROCESS_CLIENT_HMR_HOLD',
    'interaction-startup-gate',
    'peer-interaction',
    'peer-frame',
    'peer-send-stale-result',
    't55a',
    't55b',
    't55c-question',
    't55c-approval',
    't12-pty-hup',
    'C1_CANCEL_AGENT',
    'C1_HOLD_LONG_TURN',
    'C1_HOLD_TOOL',
    'C1_HOLD_CHILD',
    'goal-armed',
    'goal-round',
    'maintenance-sweep',
    'host-schedule',
    'C1_TIMED_QUESTION',
    'C1_SCENARIO',
    'C1_WORK_ROOT',
    'C1_UNOWNED_JOB_ARM',
    'C1_HAS_LIVE_CLIENT_PROBE',
    'C1_NON_ANSWERING_PEER_PROBE',
    'has-live-client',
    'non-answering-peer',
    'gateway/interactions-forbidden',
    'assertPendingUnobservable',
    'writeC1WorkFixture',
    'split-process-host-work',
    'hmr-revision-start',
    'hmr-revision-retired',
    'hmr-revision-ready',
    'hmr-revision-failure',
    't44',
    't45',
    't46',
    't47',
    't48',
    't49',
    't50',
    't51',
    't52',
    't53',
    't54',
    't55',
    't56',
    't57',
    't58',
    't59',
    't60',
    't61',
    't62',
    't63',
    't64',
    't65',
    't66',
    'SPLIT_PROCESS_CLIENT_OMIT_COOKIE',
    'SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL',
    'SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE',
    'SPLIT_PROCESS_SMOKE_FAIL_AFTER',
    'SPLIT_PROCESS_HOST_PUBLISH_BARRIER',
    'SPLIT_PROCESS_HOST_LIVENESS_BARRIER',
    'SPLIT_PROCESS_HOST_STOP_BARRIER',
    'SPLIT_PROCESS_HOST_FOUNDATION_BARRIER',
    'SPLIT_PROCESS_HOST_FORCE_EARLY_EXIT',
    'stop-repeat-ignored',
    'FAILPOINT_CLEANUP_OK',
    't14-startup-fatal',
    't13-retryable-refresh',
    't21',
    't22-t24-host-rpc-proof',
    't25-repeat-probe',
    't25-client-detach',
    't26-runtime-row-disabled',
    't26-runtime-artifact-absent',
    't26-runtime-artifact-restored',
    't26-official-row-disabled',
    't26-workspace-controller-disabled',
    't26-no-cookie',
    'workspace-admission',
    't27-workspace-restore',
    'mutation-tui-enabled',
    'mutation-connection-disabled',
    'killIsolatedProcesses',
    'trackedProcesses',
    't14-lifetime',
    'HOST_ALREADY_OWNED',
    'CLIENT_ALREADY_ACTIVE',
    'HOST_UNRESPONSIVE',
    'HOST_PROTOCOL_INCOMPATIBLE',
    'HOST_AUTH_FAILED',
    'HOST_IDENTITY_MISMATCH',
  ]) {
    assert.ok(source.includes(marker), `missing smoke marker ${marker}`)
  }
  const extraPatchUses = source.match(/SPLIT_PROCESS_EXTRA_PATCH/gu) ?? []
  assert.equal(extraPatchUses.length, 20,
    'the extra patch may only implement the two child mutations, the T26 Host-Runtime/official-row/Workspace-Controller mutations, the whole-smoke mutation mode, the isolated surface LLM overlay, the isolated Host Schedule overlay, the isolated armed-Goal overlay, the three bounded PR-A Web composition runs and the five bounded PR-B Web-toggle runs')
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: sessionControllerMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: schedulePatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: armedPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: surfaceLlm\.patchPath/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: hostRuntimeMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: workspaceControllerMutationPatch/u)
  // The PR-A Web composition owns exactly three of these runs: the isolated
  // enable, the missing-frontend-dist control and the duplicate-modules control.
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: webPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: duplicatePatch/u)
  assert.equal((source.match(/SPLIT_PROCESS_EXTRA_PATCH: webPatch/gu) ?? []).length, 2,
    'the isolated enable patch is reused by the positive run and the dist-absent control')
  // The PR-B toggle lane owns exactly four of these runs: the one default-off
  // Host that carries the whole toggle, its missing-asset negative control, the
  // duplicate-module-owner control and the malformed-argument control. The
  // toggle itself never needs a second patch: it flips the declared rows.
  assert.equal((source.match(/SPLIT_PROCESS_EXTRA_PATCH: hostPatch/gu) ?? []).length, 4,
    'the toggle patch is reused by the default-off Host and its three isolated negative lanes')
  assert.equal((source.match(/SPLIT_PROCESS_EXTRA_PATCH: duplicatePatch/gu) ?? []).length, 2,
    'the duplicate-module control keeps its own patch in both Web lanes')
  assert.match(source, /SPLIT_PROCESS_SMOKE_MUTATION/u)
  assert.match(source, /SPLIT_PROCESS_SMOKE_MUTATION/u)
  assert.match(source, /mutationEnv/u)
  assert.match(source, /DSH_PI_TUI_ROLE: 'host'/u, 'the inherited-role negative control must remain')

  // The artifact-absence control is the claim issue #474 left NOT_VERIFIED. It
  // must rename the installed module and prove the rename is REALLY
  // unresolvable from the profile anchor; a row toggle or an `existsSync`
  // precheck would test a different claim.
  assert.match(source, /renameSync\(hostRuntimeArtifact, hostRuntimeAbsentPath\)/u,
    'the artifact-absence control must remove the installed module itself, not disable the row')
  assert.match(source, /the renamed artifact must be genuinely unresolvable from the profile anchor/u,
    'the artifact-absence control must prove resolution failure before booting the Host')
  assert.match(source, /reachableAncestorCopies/u,
    'the artifact-absence control must reject a layout with a second reachable package copy')
  assert.match(source, /packageScopeBarrier/u,
    'the artifact-absence control must block the package-scope self-reference escape')
  assert.match(source, /profilesManifest/u,
    'the artifact-absence control must reject an enclosing profiles manifest carrying the candidate package name')
})

test('T09 is two real Surface Clients on one Host while T09Q keeps the qualification seat negative', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The qualification-only negative stays a real two-process EntryProcess race
  // with the kernel seat conflict; it must not be downgraded to a static claim.
  const t09qStart = source.indexOf('// T09Q: two QUALIFICATION Clients race')
  const t02Start = source.indexOf('// T02: real authenticated HTTP')
  assert.ok(t09qStart > 0 && t02Start > t09qStart, 'T09Q must stay before its original T02 continuation')
  const t09q = source.slice(t09qStart, t02Start)
  assert.match(t09q, /new EntryProcess\('client', entries\.client, probeClientBase\)/u)
  assert.match(t09q, /waitForOutcome\(client, `T09Q client/u)
  assert.match(t09q, /expectFailureRecord\(clientLoser, 'T09Q loser', 'CLIENT_ALREADY_ACTIVE'\)/u)
  assert.match(t09q, /trace\('t09-qualification'/u)
  // The real positive lives in the real-PTY lane, after A's durable Session A
  // turn and before A's /new navigation: B is a second REAL surface over the
  // same Host, with its own business PID and its own durable Host Session.
  const t09Start = source.indexOf('// T09 (M5-A): a SECOND real Surface Client')
  const t31Start = source.indexOf('// T31: Session switch')
  assert.ok(t09Start > 0 && t31Start > t09Start, 'T09 must precede the T31 A navigation it leaves intact')
  const t09 = source.slice(t09Start, t31Start)
  assert.match(t09, /new SurfaceEntryProcess\(entries\.client/u)
  assert.match(t09, /cwd: m5aWorkspaceB/u)
  assert.match(t09, /record => record\.m4a0 === 'ready'/u)
  assert.match(t09, /assertClientHostFacts\(m5aClientBReady\.host, surfaceHostFacts, 'T09 Client B'\)/u)
  assert.match(t09, /assert\(typeof c1Ready\.pid === 'number' && typeof m5aClientBReady\.pid === 'number'/u)
  assert.match(t09, /alive\(c1Ready\.pid\)/u)
  assert.match(t09, /message === 'm5a client b'/u)
  assert.match(t09, /hostAssistantHasText\(events, 'stub answer'\)/u)
  assert.match(t09, /headerM5aB\.cwd === canonicalM5aWorkspaceB/u)
  assert.match(t09, /sessionM5aB !== sessionA/u)
  assert.match(t09, /client-closed/u)
  assert.match(t09, /registryAfterM5aB\.instanceId === surfaceHostFacts\.instanceId/u)
  assert.match(t09, /trace\('t09',/u)
  // A's owner/transport facts must come from a CURRENT status record emitted
  // after B was admitted, not from A's initial ready snapshot.
  assert.doesNotMatch(t09, /assertClientHostFacts\(c1Ready\.host/u,
    'T09 must not use A\'s initial ready snapshot as current owner evidence')
  assert.match(t09, /const aStatusBoundary = c1\.records\.length/u)
  assert.match(t09, /c1\.records\.indexOf\(record\) >= aStatusBoundary/u)
  assert.match(t09, /assertClientHostFacts\(currentA\.host, surfaceHostFacts, 'T09 Client A current'\)/u)
  assert.match(t09, /currentA\.activeWrappers === 1/u)
  assert.match(t09, /currentA\.liveSockets === 1/u)
  assert.match(t09, /currentA\.owners\?\.\[owner\] === 1/u)
  assert.match(t09, /currentB\?\.openSessionId === sessionM5aB/u,
    'T09 must prove Client B is untouched by A\'s own status refresh')
  // Only ONE new dual-surface positive exists.
  assert.equal((source.match(/\/\/ T09 \(M5-A\): a SECOND real Surface Client/gu) ?? []).length, 1,
    'the real dual-surface positive must exist exactly once')
})

test('M5-B same-Session real two-PTY witness remains wired', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The M5-B Case is the FIRST C1 scenario: it owns one isolated Host and runs
  // before the M5-C Case and the T44 inventory it must not renumber.
  const start = source.indexOf('// M5B-01 (M5-B):')
  const end = source.indexOf('// M5C-01 (M5-C):')
  assert.ok(start > 0 && end > start, 'M5B-01 must stay immediately before the M5-C Case')
  assert.ok(start > source.indexOf('const startC1Client = async'),
    'M5B-01 must run inside the C1 helper section')
  assert.equal((source.match(/\/\/ M5B-01 \(M5-B\):/gu) ?? []).length, 1,
    'the shared-Session positive must exist exactly once')
  const m5b = source.slice(start, end)
  // One real Host with a HELD Turn: the queue proof needs the running Turn.
  assert.match(m5b, /startC1Host\('long-turn', 'm5b-same-session'/u)
  assert.match(m5b, /C1_HOLD_LONG_TURN: releaseBarrier/u)
  // TWO real SurfaceEntryProcess Clients (never the qualification EntryProcess);
  // B's startup intent names the SAME Session A opened.
  assert.equal((m5b.match(/startC1Client\(/gu) ?? []).length, 2,
    'M5B-01 must start exactly two real Surface Clients')
  assert.doesNotMatch(m5b, /new EntryProcess\('client'/u,
    'M5B-01 must never downgrade to the qualification EntryProcess')
  assert.match(m5b, /SPLIT_PROCESS_CLIENT_SESSION: sessionX/u)
  // Live, distinct business PIDs, distinct script(1) wrappers, and B's real
  // status opens exactly Session X.
  assert.match(m5b, /Number\.isInteger\(aReady\.pid\) && aReady\.pid > 0 && aReady\.pid !== hostBefore\.hostPid/u)
  assert.match(m5b, /Number\.isInteger\(bReady\.pid\) && bReady\.pid > 0 && bReady\.pid !== hostBefore\.hostPid/u)
  assert.match(m5b, /aReady\.pid !== bReady\.pid/u)
  assert.match(m5b, /clientA\.child\.pid !== clientB\.child\.pid/u)
  assert.match(m5b, /record\.openSessionId === sessionX/u)
  // B's durable-history read, and A's frame observing B's Host pending.
  assert.match(m5b, /clientB\.waitForScreen\('m5b-seed-a'/u)
  assert.match(m5b, /clientA\.waitForScreen\('m5b-b-queued'/u)
  // Ctrl+S is the official gesture, and the Host queue movement carries the
  // SAME occurrence identity (next-turn -> next-step).
  assert.match(m5b, /clientA\.send\('\\x13'\)/u)
  assert.match(m5b, /event\.data\?\.target === 'next-turn'/u)
  assert.match(m5b, /event\.data\?\.target === 'next-step'/u)
  assert.match(m5b, /message\?\.id === bQueuedItem\.id/u)
  assert.match(m5b, /event\.data\?\.id === bQueuedItem\.id/u)
  // Durable exact counts, including the two same-text commits; never a
  // text-guessed requestId.
  assert.match(m5b, /hostUserTexts\(settledEvents\)/u)
  assert.match(m5b, /text === 'm5b-same-text'\)\.length === 2/u)
  assert.match(m5b, /hostUserTexts\(xFinal\)/u)
  assert.doesNotMatch(m5b, /requestId/iu, 'M5B must not infer a requestId from a text match')
  // A navigates to Y, then B writes X and exits ONLY itself.
  assert.match(m5b, /clientA\.send\('\/new\\r'\)/u)
  assert.match(m5b, /'m5b-b-after-a-left-x'/u)
  assert.match(m5b, /record\.m4b2s === 'client-closed'/u)
  assert.match(m5b, /owners\?\.\[owner\] === 0/u)
  assert.match(m5b, /alive\(aReady\.pid\)/u)
  assert.match(m5b, /alive\(hostBefore\.hostPid\)/u)
  assert.match(m5b, /trace\('m5b-same-session'/u)
})

test('two real TUI Clients must both show one Host Question or Approval before first settlement', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The M5-C Case is ONE isolated C1 scope between the M5-B Case and the T44
  // inventory: it may not renumber, skip or absorb any existing Case.
  const start = source.indexOf('// M5C-01 (M5-C):')
  const end = source.indexOf('// M5N-01 (M5-N):')
  assert.ok(start > source.indexOf('// M5B-01 (M5-B):') && end > start,
    'M5C-01 must stay between the M5-B Case and the M5N-01 Case')
  assert.equal((source.match(/\/\/ M5C-01 \(M5-C\):/gu) ?? []).length, 1,
    'the dual-TUI first-settlement Case must exist exactly once')
  const m5c = source.slice(start, end)

  // The shared admission helper owns the fixed startup ORDER: A creates an
  // EMPTY Session with the real `/new` command, B joins the SAME Session
  // through its startup intent, and both real interaction gates are up before
  // any trigger exists. The prompt-submitting `openC1Session` helper would let
  // the Host ask BEFORE B exists and only prove a later replay.
  assert.match(m5c, /const admitM5cDualSurfaceScene = async \(scenario, label\) => \{/u)
  assert.equal((m5c.match(/startC1Client\(/gu) ?? []).length, 2,
    'the shared admission helper must start exactly two real Surface Clients per scene')
  assert.match(m5c, /clientA\.send\('\/new\\r'\)/u,
    'Client A must create the empty Session with the real /new command')
  assert.match(m5c, /SPLIT_PROCESS_CLIENT_SESSION: sessionX/u,
    'Client B must join the SAME Session X through its startup intent')
  assert.match(m5c, /record\.openSessionId === sessionX/u)
  assert.match(m5c, /record\.transport === 'connected'/u)
  assert.match(m5c, /record\.surfaceMounted === true/u)
  assert.match(m5c, /aReady\.pid !== bReady\.pid/u, 'the two Clients need distinct business PIDs')
  assert.match(m5c, /clientA\.child\.pid !== clientB\.child\.pid/u, 'the two Clients need distinct script(1) wrappers')
  assert.match(m5c, /assertInteractionGate\(clientA, `\$\{label\} Client A`\)/u)
  assert.match(m5c, /assertInteractionGate\(clientB, `\$\{label\} Client B`\)/u)
  assert.match(m5c, /assertClientHostFacts\(aOpen\.host, hostBefore/u)
  assert.match(m5c, /assertClientHostFacts\(bOpen\.host, hostBefore/u)
  assert.match(m5c, /event\.type === 'turn\/start' \|\| event\.type === 'tool\/call'/u,
    'the scene must prove nothing was pending before its trigger')
  assert.match(m5c, /event\.kind !== 'question-request'/u,
    'the fixture must prove no Question predated the trigger')
  assert.doesNotMatch(m5c, /openC1Session\(/u,
    'M5C must never prepare the Clients with the prompt-submitting helper')
  assert.doesNotMatch(m5c, /new EntryProcess\('client'/u,
    'M5C must never downgrade a real TUI to the qualification EntryProcess')

  // Three fixed Host scenes, each admitted BEFORE its own real keyboard trigger.
  for (const [scenario, label, trigger] of [
    ['question', 'm5c-question', 'm5c-question-trigger'],
    ['approval-allow', 'm5c-approval-reject', 'm5c-approval-reject-trigger'],
    ['approval-allow', 'm5c-approval-allow', 'm5c-approval-allow-trigger'],
  ]) {
    const admit = m5c.indexOf(`admitM5cDualSurfaceScene('${scenario}', '${label}')`)
    const sent = m5c.indexOf(`clientA.send('${trigger}\\r')`)
    assert.ok(admit >= 0, `${label} must use the shared dual-Surface admission`)
    assert.ok(sent > admit, `${label} must admit BOTH real Clients before its trigger prompt`)
  }

  // Question: both physically distinct frames observe the same answerable
  // modal, the winner goes through the REAL review page, and the ONE Host
  // tool/result is tied to the durable callId.
  assert.match(m5c, /clientA\.waitForScreen\('\[1\] Proceed'/u)
  assert.match(m5c, /clientB\.waitForScreen\('\[1\] Proceed'/u)
  assert.match(m5c, /clientA\.send\('1'\)/u)
  assert.match(m5c, /clientA\.waitForScreen\('Review your answer before submit'/u)
  assert.match(m5c, /clientA\.send\('\\r'\)/u)
  assert.match(m5c, /event\.type === 'tool\/result' && String\(event\.data\?\.message\?\.toolCallId\) === callId/u,
    'the Question settlement must be tied to the real durable callId')
  assert.match(m5c, /event\.kind === 'question-settled' && event\.sessionId === sessionX/u)
  assert.match(m5c, /event\.kind !== 'question-failed'/u)
  assert.match(m5c, /settled\.answers\?\.\[0\]\?\.selected\?\.\[0\] === 'Proceed'/u)
  // The loser withdrew its own modal and its late option key stayed inert.
  assert.match(m5c, /clientB\.waitForScreenGone\('\[1\] Proceed'/u,
    'the Question loser\'s CURRENT frame must prove the modal withdrawal')
  assert.match(m5c, /clientB\.send\('2'\)/u, 'the Question loser must try the old option key')
  assert.match(m5c, /waitForComposerDraft\('m5c-b-editor-after-question'/u,
    'the loser must prove the editor seat is usable again')
  assert.match(m5c, /a late loser option key reopened the settled question modal/u)
  assert.match(m5c, /a late loser key produced Host activity/u)
  assert.match(m5c, /the question was not settled exactly once/u)
  assert.match(m5c, /the Host wrote more than one tool result for the question call/u)
  assert.match(m5c, /afterExitEvents/u, 'the Question loser exit needs a NEW durable snapshot')

  // Approvals: BOTH scenes paint the same sheet on both real frames, one
  // winner settles each real outcome, and both late loser keys stay inert.
  assert.equal((m5c.match(/clientA\.waitForScreen\('\[y\] Allow once'/gu) ?? []).length, 2,
    'both Approval scenes must observe the same sheet on Client A')
  assert.equal((m5c.match(/clientB\.waitForScreen\('\[y\] Allow once'/gu) ?? []).length, 2,
    'both Approval scenes must observe the same sheet on Client B')
  assert.match(m5c, /event\.type === 'approval\/asked'/u)
  assert.match(m5c, /event\.type === 'approval\/decided' && String\(event\.data\?\.id\) === requestId/u,
    'the Approval settlement must be tied to the real ApprovalRequestId')
  assert.match(m5c, /decided\.data\.outcome === 'rejected'/u)
  assert.match(m5c, /decided\.data\.outcome === 'allowed-once'/u)
  assert.match(m5c, /event\.kind === 'approval-settled' && event\.outcome === 'rejected'/u)
  assert.match(m5c, /event\.kind === 'approval-settled' && event\.outcome === 'allowed-once'/u)
  // AR: B wins with `n`, then A's late `y` must not allow.
  assert.match(m5c, /clientB\.send\('n'\)/u)
  assert.match(m5c, /clientA\.waitForScreenGone\('\[y\] Allow once'/u)
  assert.match(m5c, /a rejected approval still executed the bash tool/u)
  assert.match(m5c, /the late loser allow produced a second\/changed Host decision/u)
  assert.match(m5c, /the late loser key settled an allowed approval/u)
  // AA: A wins with `y`, then B's late `n` must not reverse or re-execute.
  assert.match(m5c, /clientA\.send\('y'\)/u)
  assert.match(m5c, /clientB\.waitForScreenGone\('\[y\] Allow once'/u)
  assert.match(m5c, /the late loser key settled a second allowed approval/u)
  assert.match(m5c, /the late loser reject produced a second\/changed Host decision/u)
  // Each Approval scene proves the ONE request/decision pair it owns.
  assert.match(m5c, /the approval was not asked\/decided exactly once as rejected/u)
  assert.match(m5c, /the approval was not asked\/decided exactly once as allowed-once/u)
  // Each Approval scene runs exactly one winner key and one late loser key.
  assert.equal((m5c.match(/clientA\.send\('y'\)/gu) ?? []).length, 2,
    'Client A must allow once as the AA winner and once as the AR late loser')
  assert.equal((m5c.match(/clientB\.send\('n'\)/gu) ?? []).length, 2,
    'Client B must reject once as the AR winner and once as the AA late loser')
  // The harmless command's execution evidence is the Host work-root marker:
  // present with its payload for the allow, never present for the reject.
  assert.match(m5c, /join\(workRoot, 'approval-allow\.marker'\)/u)
  assert.match(m5c, /readFileSync\(marker, 'utf8'\) === 'c1-approval-allow'/u)
  assert.match(m5c, /the rejected harmless command executed/u)
  assert.match(m5c, /a marker appeared for the refused command/u)
  assert.match(m5c, /the allowed harmless command did not execute/u)

  // Identity, cleanup and the final Host durable counts are explicit asserts,
  // never trace-only claims.
  assert.equal((m5c.match(/typeof call\.data\.callId === 'string' && call\.data\.callId !== ''/gu) ?? []).length, 3,
    'every M5C scene must validate the durable tool call id BEFORE coercion/correlation')
  assert.equal((m5c.match(/host\.exited === true && host\.exitResult\?\.code === 0 && host\.exitResult\?\.signal === null/gu) ?? []).length, 3,
    'every M5C scene must assert a normal Host shutdown instead of the swallowing helper')
  assert.match(m5c, /hostExitCode: host\.exitResult\.code/u,
    'the trace must report the asserted Host exit code')
  assert.match(m5c, /assertHostIdentityKept\(host, hostBefore/u)
  assert.match(m5c, /exitC1Client\(clientA/u)
  assert.match(m5c, /exitC1Client\(clientB/u)
  assert.match(m5c, /stopC1Host\(host\)/u)
  assert.match(m5c, /event\.type === 'turn\/end'/u)
  for (const trace of ['m5c-01q', 'm5c-01ar', 'm5c-01aa']) {
    assert.ok(m5c.includes(`trace('${trace}'`), `${trace} must report its real facts`)
  }
  for (const legacy of ['t49', 't50', 't51', 't52', 't53', 't54', 't55a', 't55b', 't55c-question', 't55c-approval']) {
    assert.ok(source.includes(legacy), `the M5-C Case must not remove the legacy ${legacy} negative control`)
  }
  assert.ok(source.indexOf('// M5B-01 (M5-B):') > 0,
    'the M5-C Case must not remove the M5-B same-Session witness')
})

test('the non-destructive Split Remote navigation witness stays between M5-C and the T44 inventory', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // ONE isolated case, after the M5-C first-settlement Case and before the
  // M5N-02 sibling case and the T44 inventory it must not renumber or absorb.
  const start = source.indexOf('// M5N-01 (M5-N):')
  const end = source.indexOf('// M5N-02 (M5-N):')
  assert.ok(start > source.indexOf('// M5C-01 (M5-C):'), 'M5N-01 must run after the M5-C Case')
  assert.ok(end > start, 'M5N-01 must stay immediately before the M5N-02 sibling case')
  assert.equal((source.match(/\/\/ M5N-01 \(M5-N\):/gu) ?? []).length, 1,
    'the non-destructive navigation witness must exist exactly once')
  const m5n = source.slice(start, end)

  // ONE real Host with a HELD Turn: the held barrier is the only thing that
  // ends it, so no replay/timer can produce the continuation.
  assert.match(m5n, /startC1Host\('long-turn', 'm5n-navigation'/u)
  assert.match(m5n, /C1_HOLD_LONG_TURN: releaseBarrier/u)
  // TWO real SurfaceEntryProcess Clients (never the qualification
  // EntryProcess): A navigates, B joins the Session A left.
  assert.equal((m5n.match(/startC1Client\(/gu) ?? []).length, 2,
    'M5N-01 must start exactly two real Surface Clients')
  assert.doesNotMatch(m5n, /new EntryProcess\('client'/u,
    'M5N-01 must never downgrade to the qualification EntryProcess')
  assert.match(m5n, /SPLIT_PROCESS_CLIENT_SESSION: sessionX/u)
  assert.match(m5n, /aReady\.pid !== bReady\.pid/u)
  assert.match(m5n, /clientA\.child\.pid !== clientB\.child\.pid/u)

  // The case must PROVE the navigation did not wait: it asserts no turn/end
  // exists while the hold barrier is absent, for BOTH the /new and /resume.
  assert.match(m5n, /clientA\.send\('\/new\\r'\)/u)
  assert.match(m5n, /clientA\.send\(`\/resume \$\{sessionX\}\\r`\)/u)
  assert.match(m5n, /clientA\.send\(`\/resume \$\{sessionY\}\\r`\)/u)
  assert.equal((m5n.match(/!existsSync\(releaseBarrier\)/gu) ?? []).length, 4,
    'M5N must assert the hold barrier was still absent before and at each navigation commit')
  assert.match(m5n, /event\.type !== 'turn\/end'/u,
    'M5N must prove the held Turn did not settle before the barrier release')
  // The RUNNING target projection and the already-current no-op are explicit.
  assert.match(m5n, /record\.openSessionId === sessionX/u)
  assert.match(m5n, /long-turn started/u)
  assert.match(m5n, /already on this session/u)

  // A refused command line is RESTORED by the production editor contract
  // ("an error outcome keeps the draft"). The case must observe that restore
  // and clear it through the real editor before the next ordinary submit;
  // otherwise the queued text would be appended to `/resume <id>` and the
  // durable queue wait would blame the Host for a harness mistake.
  assert.match(m5n, /const refusedLine = `\/resume \$\{sessionX\}`/u,
    'M5N must name the refused line it expects the editor to restore')
  assert.match(m5n, /await clientA\.waitForComposerDraft\(refusedLine\)/u,
    'M5N must OBSERVE the restored refused line before clearing it')
  assert.match(m5n, /clientA\.send\('\\x15'\)/u,
    'M5N must clear the restored line with the real editor gesture (Ctrl+U)')
  assert.match(m5n, /cleared the refused command line/u,
    'M5N must wait until the refused line is gone from the composer')
  assert.match(m5n, /includes\('\/resume'\)/u,
    'M5N must reject a queued line that inherits the refused command line')
  {
    // The ORDER is the proof: observe the restored line FIRST, then clear it,
    // then require the composer to be clean. Clearing before observing would
    // be a harness guess that can race the production restore.
    const observed = m5n.indexOf('await clientA.waitForComposerDraft(refusedLine)')
    const cleared = m5n.indexOf("clientA.send('\\x15')", observed)
    const gone = m5n.indexOf("'M5N cleared the refused command line'", cleared)
    assert.ok(observed >= 0 && cleared > observed && gone > cleared,
      'M5N must observe the restored refused line, clear it with Ctrl+U, then wait until it is gone')
  }

  // The queued occurrence is submitted through the PAINTED composer: type,
  // confirm the composer holds the exact text, then Enter. A one-shot
  // `send('...\\r')` could be dropped by a closing overlay while the durable
  // wait still blamed the Host, so the readiness step is part of the proof.
  {
    const typed = m5n.indexOf("clientA.send('m5n-x-queued')")
    const confirmed = m5n.indexOf("await clientA.waitForComposerDraft('m5n-x-queued')")
    const noInherit = m5n.indexOf('the queued line must not inherit a refused command line')
    const entered = m5n.indexOf("clientA.send('\\r')", noInherit)
    assert.ok(typed >= 0 && confirmed > typed && noInherit > confirmed && entered > noInherit,
      'M5N must type the queued text, confirm the painted composer, reject an inherited refused line, then press Enter')
    assert.doesNotMatch(m5n, /send\('m5n-x-queued\\r'\)/u,
      'M5N must never submit the queued occurrence one-shot without the composer readiness fact')
  }

  // The old X Turn must COMPLETE (never be cancelled) after A left, and the
  // Host-queued occurrence must stay with X (exact identity, exactly once).
  assert.match(m5n, /waitForTurnEnds/u)
  assert.match(m5n, /reason\?\.kind === 'completed'/u)
  assert.match(m5n, /event\.type === 'agent\/inbox\/spliced'/u)
  assert.match(m5n, /event\.data\?\.target === 'next-turn'/u)
  assert.match(m5n, /event\.data\?\.id === queuedItem\.id/u)
  assert.doesNotMatch(m5n, /requestId/iu, 'M5N must not infer a requestId from a text match')

  // Explicit Busy Esc is the negative control: the SAME Host records an
  // aborted user settlement for that exact Turn.
  assert.match(m5n, /clientA\.send\('\\x1b'\)/u)
  assert.match(m5n, /reason\?\.kind === 'aborted'/u)
  assert.match(m5n, /reason\?\.reason\?\.kind === 'user'/u)

  // Identity, cleanup and the trace are explicit.
  assert.match(m5n, /assertHostIdentityKept\(host, hostBefore/u)
  assert.match(m5n, /exitC1Client\(clientA/u)
  assert.match(m5n, /exitC1Client\(clientB/u)
  assert.match(m5n, /stopC1Host\(host\)/u)
  assert.match(m5n, /trace\('m5n-01'/u)
})

test('the detached-navigation siblings stay between M5N-01 and the T44 inventory', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('// M5N-02 (M5-N):')
  const end = source.indexOf('// T44: a real accepted Turn survives')
  assert.ok(start > source.indexOf('// M5N-01 (M5-N):'), 'M5N-02 must run after the M5N-01 case')
  assert.ok(source.indexOf('// M5N-03 (M5-N):') > start, 'M5N-03 must run after the M5N-02 case')
  assert.ok(end > source.indexOf('// M5N-03 (M5-N):'),
    'M5N-03 must stay immediately before the T44 inventory')
  for (const marker of ['// M5N-02 (M5-N):', '// M5N-03 (M5-N):']) {
    assert.equal((source.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) ?? []).length, 1,
      `${marker} must exist exactly once`)
  }
  const m5n2 = source.slice(source.indexOf('// M5N-02 (M5-N):'), source.indexOf('// M5N-03 (M5-N):'))
  const m5n3 = source.slice(source.indexOf('// M5N-03 (M5-N):'), end)

  // ── M5N-02: `/fork` from a RUNNING source, the Client exit, and Stop ──────
  // ONE real Host holds its Turn until the barrier file exists: the fork cut is
  // the source's first COMPLETED turn, so the second Turn can stay held across
  // the adoption. Two REAL Surface Clients, never the qualification entry.
  assert.match(m5n2, /startC1Host\('long-turn', 'm5n2-siblings'/u)
  assert.match(m5n2, /C1_HOLD_LONG_TURN: releaseBarrier/u)
  assert.equal((m5n2.match(/startC1Client\(/gu) ?? []).length, 2,
    'M5N-02 must start exactly two real Surface Clients')
  assert.doesNotMatch(m5n2, /new EntryProcess\('client'/u,
    'M5N-02 must never downgrade to the qualification EntryProcess')
  assert.match(m5n2, /SPLIT_PROCESS_CLIENT_SESSION: sessionX/u)
  assert.match(m5n2, /aReady\.pid !== bReady\.pid/u)
  assert.match(m5n2, /clientA\.child\.pid !== clientB\.child\.pid/u)
  // A REAL completed turn is the fork cut; the RUNNING turn is the work the
  // fork must neither stop nor wait for.
  assert.match(m5n2, /clientA\.send\('\/fork\\r'\)/u)
  assert.match(m5n2, /event\.attempt === 1/u)
  assert.match(m5n2, /event\.attempt === 2/u)
  assert.equal((m5n2.match(/!existsSync\(releaseBarrier\)/gu) ?? []).length, 3,
    'M5N-02 must assert the hold barrier was still absent at each departure')
  assert.match(m5n2, /durableOf\(sessionX\)\.slice\(xTurn2Index\)\.every\(event => event\.type !== 'turn\/end'\)/u,
    'the fork must not end the running source Turn')
  assert.match(m5n2, /hostSessionLogCount\(dshHome\) === sessionsBeforeFork \+ 1/u,
    'the fork must publish exactly ONE durable child Session')
  assert.match(m5n2, /childHeader\.parentSession === sessionX/u,
    'the published child must name the source as its parent')
  // A Split Remote TUI command appends no Host `command/*` row: the scene must
  // not claim a durable command settlement this backend never writes.
  assert.doesNotMatch(m5n2, /event\.type === 'command\/done'/u,
    'M5N-02 must not assert a durable command/done the Remote command plane never appends')
  assert.match(m5n2, /childUserTexts\.filter\(text => text === 'm5n2-x-turn2'\)\.length === 0/u,
    'the child must not inherit the RUNNING source Turn')
  // The fork's Client move happens exactly once.
  assert.match(m5n2, /movesAfterFork\.every\(id => id === childId\)/u)
  // The Client EXIT: `/exit` through the real editor, then the source Turn
  // continues and the second Client still writes the same Session.
  assert.match(m5n2, /exitC1Client\(clientA, 'M5N2 A'\)/u)
  assert.match(m5n2, /await waitGone\(aPid, 15_000\)/u)
  assert.match(m5n2, /durableOf\(sessionX\)\.slice\(xTurn3Index\)\.every\(event => event\.type !== 'turn\/end'\)/u,
    'the Client exit must not end the running Host Turn')
  assert.match(m5n2, /hostSessionLogCount\(dshHome\) === sessionsBeforeExit/u,
    'the Client exit must not create or remove a durable Session')
  assert.match(m5n2, /m5n2-b-after-exit/u, 'the second Client must still write the Session after the exit')
  // Explicit Busy Esc remains the ONE aborting gesture.
  assert.match(m5n2, /clientB\.send\('\\x1b'\)/u)
  assert.match(m5n2, /event\.attempt === 4/u)
  assert.match(m5n2, /reason\?\.kind === 'aborted'/u)
  assert.match(m5n2, /reason\?\.reason\?\.kind === 'user'/u)
  // Identity, cleanup and the trace are explicit.
  assert.match(m5n2, /assertHostIdentityKept\(host, hostBefore/u)
  assert.match(m5n2, /exitC1Client\(clientB, 'M5N2 B'\)/u)
  assert.match(m5n2, /stopC1Host\(host\)/u)
  assert.match(m5n2, /trace\('m5n-02'/u)

  // ── M5N-03: leaving a pending Host Question ─────────────────────────────
  // ONE real Host question reaches TWO real modals before either Client leaves.
  assert.match(m5n3, /startC1Host\('question', 'm5n3-interaction'/u)
  assert.equal((m5n3.match(/startC1Client\(/gu) ?? []).length, 2,
    'M5N-03 must start exactly two real Surface Clients')
  assert.doesNotMatch(m5n3, /new EntryProcess\('client'/u,
    'M5N-03 must never downgrade to the qualification EntryProcess')
  assert.match(m5n3, /SPLIT_PROCESS_CLIENT_SESSION: sessionX/u)
  assert.match(m5n3, /aReady\.pid !== bReady\.pid/u)
  assert.match(m5n3, /name === 'ask_user_question'/u)
  assert.equal((m5n3.match(/waitForScreen\('\[1\] Proceed'/gu) ?? []).length, 3,
    'M5N-03 must paint the answerable modal on BOTH Clients before the departure')
  // A leaves WITHOUT answering: nothing may reach the Host, and B answers the
  // SAME callId afterwards.
  assert.match(m5n3, /clientA\.signalBusiness\('SIGTERM'\)/u)
  assert.match(m5n3, /await waitGone\(aPid, 15_000\)/u)
  assert.match(m5n3, /A\\'s departure settled the Host question or the Turn/u)
  assert.match(m5n3, /kind !== 'question-settled'/u)
  assert.match(m5n3, /clientB\.send\('1'\)/u)
  assert.match(m5n3, /waitForScreen\('Review your answer before submit'/u)
  assert.match(m5n3, /String\(event\.data\?\.message\?\.toolCallId\) === callId/u)
  assert.match(m5n3, /question Turn settled as/u)
  // EXACTLY ONCE, on the final durable state.
  assert.match(m5n3, /produced more than one tool result/u)
  assert.match(m5n3, /the Host settled the question more than once/u)
  assert.match(m5n3, /assertHostIdentityKept\(host, hostBefore/u)
  assert.match(m5n3, /exitC1Client\(clientB, 'M5N3 B'\)/u)
  assert.match(m5n3, /stopC1Host\(host\)/u)
  assert.match(m5n3, /trace\('m5n-03'/u)
})

test('the question lanes wait for the real review frame, never the permanent Submit tab', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // Every question page paints the `○ Submit` nav tab permanently, so a
  // `waitForScreen('Submit', …)` returned while the flow was still on the
  // option page; the driver's final Enter then landed before the review
  // seat existed. Only the review-only title proves that page is painted.
  assert.equal((source.match(/waitForScreen\(\s*'Submit'/gu) ?? []).length, 0,
    'the permanent Submit nav tab can never prove the review page')
  for (const [scenario, call] of [
    ['T49/T50', /waitForScreen\('Review your answer before submit', `\$\{label\} C2 review page`/u],
    ['T51', /waitForScreen\('Review your answer before submit', 'T51 C2 review'/u],
    ['T52', /waitForScreen\('Review your answer before submit', 'T52 continued form review'/u],
    ['T55c', /waitForScreen\('Review your answer before submit', 'T55c question review'/u],
  ]) {
    assert.match(source, call, `${scenario} must gate its final Enter on the unique review title`)
  }
  // T52 submits exactly ONCE from the painted review frame. The old second
  // Enter compensated for the missing review wait and could append an
  // unrelated reply instead of letting the official queued classification
  // prove the single submit.
  const t52 = source.slice(
    source.indexOf("await c2.waitForScreen('Review your answer before submit', 'T52 continued form review'"),
    source.indexOf('// The C2 UI\'s `answerContinued` return is observable'),
  )
  assert.ok(t52.length > 0, 'T52 form review wait not found')
  assert.equal((t52.match(/c2\.send\('\\r'\)/gu) ?? []).length, 1,
    'T52 must send exactly one final Enter after the review frame')
  // The official witness checks the fix must not weaken.
  assert.match(source, /duplicate question request\/settlement/u, 'T49/T50 keep the one-request/one-settlement check')
  assert.match(source, /T55c HMR replayed the Host question request/u, 'T55c keeps the no-replay check')
  assert.match(source, /T55c the new surface submitted the wrong answer/u, 'T55c must assert the submitted answer')
  assert.match(source, /T55c the Host pending was not settled exactly once for this session/u,
    'T55c must prove the single request/settlement pair with no failure')
  // The official non-timed `ask()` has no `wait`, so a waterfall record cannot
  // carry the callId; only the durable Host pair can, and it must stay checked.
  assert.match(source, /T55c question tool result/u, 'T55c must wait for the callId-exact durable tool result')
  assert.match(source, /T55c the answered question failed at the Host/u, 'T55c must reject an errored durable result')
})

test('the lane declares every setup local it later assigns', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const main = source.slice(source.indexOf('async function main()'))
  // A bare assignment to an undeclared name is a ReferenceError, and only the
  // REAL lane reaches this code, so the declarations are pinned here.
  for (const name of ['distribution', 'workDir', 'home', 'dshHome', 'harnessDir',
    'scratch', 'env', 'isolatedScopeId']) {
    const declared = main.search(new RegExp(`let ${name}$`, 'mu'))
    assert.ok(declared >= 0, `the setup must declare \`${name}\``)
    const assigned = main.search(new RegExp(`^\\s*${name} = `, 'mu'))
    assert.ok(assigned < 0 || assigned > declared,
      `\`${name}\` must be declared before its first assignment`)
  }
})

test('the lane setup shares the report and cleanup boundary with the run', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const main = source.slice(source.indexOf('async function main()'))
  // Pin qualification must still happen BEFORE anything is created on disk.
  const guard = main.indexOf("requireExactSmokeDshPin('candidate'")
  const root = main.search(/[A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-process-'\)\)/u)
  // Locate the REAL `try {` that owns the report and the cleanup, not a nearby
  // declaration: the guard must fail if the setup is moved back outside it.
  const setupTry = main.indexOf('try {', guard)
  const distributionLoad = main.indexOf('distribution = loadDshDistribution(', guard)
  assert.ok(guard > 0 && root > guard, 'no setup may run before the input is qualified')
  assert.ok(setupTry > guard, 'the reporting/cleanup try must follow the pin qualification')
  assert.ok(root > setupTry, 'the work root must be created INSIDE the reporting/cleanup try')
  assert.ok(distributionLoad > setupTry,
    'the distribution load must be inside the reporting/cleanup try, not before it')
  assert.ok(main.indexOf('if (workDir === undefined) {', root) > 0,
    'the finally must tolerate a root that never appeared')
  // The cleanup must tolerate a scene that never got created, and must remove a
  // root that was created before a later setup step failed.
  const finallyIndex = main.indexOf('} finally {', root)
  const cleanup = main.slice(finallyIndex)
  assert.match(cleanup, /if \(workDir === undefined\) \{/u, 'a missing work root must not break the cleanup')
  assert.match(cleanup, /else if \(!KEEP\) rmSync\(workDir/u)
  assert.match(cleanup, /if \(dshHome !== undefined\) killIsolatedProcesses\(dshHome\)/u)
  // The FAILPOINT proof reads the same scene, so it needs the same guard: an
  // undefined root must not reach a second read of the isolated process list.
  assert.match(cleanup, /if \(FAILPOINT !== undefined && dshHome !== undefined\) \{/u)
})

test('the split-process lane reports every failure through the shared safe projection', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // Startup identity and checkpoints are ON by default; the explicit trace file
  // keeps writing exactly what it wrote before.
  assert.match(source, /process\.stderr\.write\(`\$\{diagnostics\.identityLine\(\)\}\\n`\)/u)
  assert.match(source, /function trace\(event, fields = \{\}\) \{\n  diagnostics\?\.checkpoint\(event\)\n  if \(TRACE_PATH === undefined \|\| TRACE_PATH === ''\) return/u,
    'the checkpoint ring and stderr progress run WITHOUT SPLIT_PROCESS_TRACE')
  assert.match(source, /if \(TRACE_PATH === undefined \|\| TRACE_PATH === ''\) return[\s\S]{0,220}writeFileSync\(traceFd, `\$\{JSON\.stringify\(\{ ts: Date\.now\(\), event, \.\.\.fields \}\)\}\\n`\)/u,
    'the SPLIT_PROCESS_TRACE file keeps its existing content and trigger')
  assert.match(source, /diagnostics = createSmokeDiagnostics\(\{[\s\S]{0,200}lane: 'split-process'/u)
  assert.match(source, /marker: 'T'/u)
  // The report is built while the processes are still alive, BEFORE the finally
  // kills them and deletes the work root.
  const main = source.slice(source.indexOf('async function main()'))
  const report = main.indexOf('diagnostics.reportFailure(error, { processes: [...activeProcesses] })')
  const catchIndex = main.lastIndexOf('} catch (error) {', report)
  const finallyIndex = main.indexOf('} finally {', report)
  const cleanupKill = main.indexOf('for (const run of [...activeProcesses]) {', report)
  const cleanupRemove = main.indexOf('rmSync(workDir, { recursive: true, force: true })', report)
  assert.ok(report > 0 && catchIndex > 0 && catchIndex < report, 'the catch must precede the report')
  assert.ok(finallyIndex > report && cleanupKill > finallyIndex && cleanupRemove > finallyIndex,
    'the report must be written before the cleanup kills the processes and deletes the work root')
  assert.match(main.slice(finallyIndex), /if \(!KEEP\) rmSync\(workDir/u, 'the KEEP semantics stay unchanged')
  assert.match(main.slice(finallyIndex), /FAILPOINT_CLEANUP leftovers/u, 'the failpoint cleanup proof must remain')
  // Shared waiters fail with a classified bounded context, never a payload dump.
  assert.match(source, /SplitSmokeWaitError,\n\} from '\.\/lib\/split-smoke-diagnostics\.mjs'/u)
  for (const waiter of ['waitForScreen(needle, label, timeoutMs = 60_000)', 'waitForComposerDraft(text, timeoutMs = 30_000)']) {
    assert.ok(source.includes(waiter), `the shared waiter ${waiter} must remain`)
  }
  assert.doesNotMatch(source, /records=\$\{JSON\.stringify\(this\.records/u, 'a waiter must not dump its records into the error')
  assert.doesNotMatch(source, /stderr=\$\{this\.stderr\.slice/u, 'a waiter must not dump captured stderr into the error')
  assert.doesNotMatch(source, /raw=\$\{JSON\.stringify\(this\.raw/u, 'a waiter must not dump raw terminal bytes into the error')
  assert.doesNotMatch(source, /viewport=\$\{JSON\.stringify\(viewport\)/u, 'a waiter must not dump the viewport into the error')
  // One final synchronous JSONL read removes the poller-versus-snapshot tail race.
  assert.match(source, /finalRecordRead\(label\)/u)
  // The final stderr line stays concise even for an unexpected error shape.
  // The default final line is the fixed classification only; the raw error text
  // appears in one place, and only when the operator asked for a kept scene.
  assert.match(source, /SPLIT_PROCESS_SMOKE_FAILURE: \$\{safeFailureSummary\(error\)\}/u)
  assert.match(source, /if \(KEEP\) console\.error\(`SPLIT_PROCESS_SMOKE_FORENSICS: \$\{forensicErrorText\(error\)\}`\)/u)
  assert.doesNotMatch(source, /SPLIT_PROCESS_SMOKE_FAILURE: \$\{error instanceof Error \? error\.message/u)
  // A failure before the collector existed still leaves one safe report.
  assert.match(main, /if \(diagnostics === undefined\) emitInputFailure\(\{ lane: 'split-process'/u)
})

test('every real Client-detach recovery case observes the pending source as UNKNOWN', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const pendingChecks = source.match(/await assertPendingUnobservable\(host, hostBefore,/gu) ?? []
  assert.equal(pendingChecks.length, 2,
    'the detached pending UNKNOWN assertion must cover the Question detach loop (kill + clean exit) and the Approval outcome loop (allow + reject)')
  assert.match(source, /event\.kind === 'has-live-client' && event\.value === value && event\.sequence > afterSequence/u)
  assert.match(source, /C1_HAS_LIVE_CLIENT_PROBE: '1'/u)
  assert.match(source, /C1_NON_ANSWERING_PEER_PROBE: nonAnsweringBarrier/u)
})

test('the payload-drift gate proves a loadable cross-build Client against the same live Host', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // T17a must be a positive, non-destructive drift: append a harmless comment,
  // prove the production fingerprint changed, connect the same Host, and
  // restore the exact original bytes in finally.
  assert.ok(
    source.includes("appendFileSync(clientChunk, '\\n// harmless client build drift: protocol unchanged\\n')"),
    'T17a must append only a harmless comment to the client chunk',
  )
  assert.match(source, /productionBuildId\(profilePackage, hostReady\.localHost\.dshVersion\)/u)
  assert.match(source, /T17 drift Client authenticated the live Host/u)
  assert.match(source, /assertClientHostFacts\(driftedAuth\.host, hostReady\.localHost/u)
  assert.match(source, /assert\(driftReady\.transport === 'connected'/u)
  assert.match(source, /writeFileSync\(clientChunk, clientChunkBytes\)/u)
  assert.match(source, /T17 payload drift did not restore the installed client chunk/u)
  assert.doesNotMatch(source, /T17 payload drift did not fail closed on the build identity/u)
})

test('the Client peer set is installed into the profile that actually runs it', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The active profile owns the Client platform peer set, and every peer must
  // be installed BEFORE the candidate bundle. The isolated harness is only the
  // DSH CLI anchor: a harness devDependency is not a Client peer owner
  // (issue #476). The published store declares its zustand/immer engine
  // imports only as devDependencies, so the profile owns those exact pins too.
  const profileStoreInstall = source.indexOf(
    'installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)',
  )
  const zustandInstall = source.indexOf("installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)")
  const immerInstall = source.indexOf("installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)")
  const candidateInstall = source.indexOf('installPlugin(dsh, tarball, harnessDir, env, false)')
  assert.ok(profileStoreInstall >= 0, 'the Client store peer must be installed through the official profile CLI')
  assert.ok(zustandInstall > profileStoreInstall, 'the store engine peer zustand must follow the store install')
  assert.ok(immerInstall > zustandInstall, 'the store engine peer immer must follow the zustand install')
  assert.ok(candidateInstall > immerInstall, 'every Client peer must be installed before the candidate bundle')
  const harnessManifest = source.slice(
    source.indexOf("name: 'dsh-split-process-harness'"),
    source.indexOf('runPnpmInstall(harnessDir, env, distribution)'),
  )
  assert.doesNotMatch(harnessManifest, /dsh-client-store|zustand|immer/u,
    'the isolated harness must not pretend to own the Client peer set')

  // The work dir is a real OS temp root, and the checkout-ancestor escape is
  // rejected explicitly instead of silently falling back to the project temp.
  // Assigned inside the setup boundary, but still an OS temp root outside the checkout.
  assert.match(source, /workDir = [A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-process-'\)\)/u)
  assert.match(source, /relative\(realpathSync\(PACKAGE_ROOT\), realpathSync\(workDir\)\)/u)
  assert.match(source, /workDirFromCheckout\.startsWith\(`\.\.\$\{sep\}`\)/u)

  // The peer install is proven from the real owner: manifest dependency,
  // non-bundle activation, physical version and profile-anchored containment.
  assert.match(source, /const clientPeers = \[\n\s*\['@deepseek-ai\/dsh-client-store', targetDshVersion\],\n\s*\['zustand', '4\.5\.7'\],\n\s*\['immer', '10\.2\.0'\],\n\s*\]/u)
  assert.match(source, /profileManifest\.dependencies\?\.\[name\] === version/u)
  assert.match(source, /!\s*\(profileManifest\.dsh\?\.profile\?\.bundles \?\? \[\]\)\.includes\(name\)/u)
  assert.match(source, /profileManifest\.dsh\?\.profile\?\.bundles \?\? \[\]\)\.includes\('@xmoon76\/dsh-pi-tui'\)/u)
  assert.match(source, /realpathSync\(join\(profileDir, 'node_modules', name\)\)/u)
  assert.match(source, /readJson\(join\(peerDir, 'package\.json'\)\)\.version === version/u)
  assert.match(source, /createRequire\(join\(profileDir, 'package\.json'\)\)\.resolve\(name\)/u)
  assert.match(source, /peerRelative/u)

  // The sandboxed background-Job scenarios keep their release barrier inside
  // the session workspace (the installed profile): a workspace-write bwrap
  // sandbox mounts an ephemeral /tmp, so a barrier under the smoke work dir
  // would be invisible and the Job could never settle.
  assert.match(source, /const c1JobWorkRoot = label => \{\n\s*const root = join\(profileDir, `c1-\$\{label\}`\)/u)
  assert.match(source, /startC1Host\('job', 't47', \{\}, c1JobWorkRoot\('t47'\)\)/u)
  assert.match(source, /startC1Host\('job', 't58', \{\}, c1JobWorkRoot\('t58'\)\)/u)

  // The existing artifact-absence control and the cross-build drift gate must
  // stay intact next to the peer install (the full inventory remains in the
  // gate test above).
  assert.match(source, /renameSync\(hostRuntimeArtifact, hostRuntimeAbsentPath\)/u)
  assert.match(source, /reachableAncestorCopies/u)
  assert.match(source, /packageScopeBarrier/u)
  assert.ok(source.includes("appendFileSync(clientChunk, '\\n// harmless client build drift: protocol unchanged\\n')"))
})

test('the official Web composition qualification is discoverable and never fakes a pass', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  for (const marker of [
    't67-web-default-off',
    't68-web-qualified',
    't69-web-browser',
    't70-web-hmr',
    't71-web-shutdown',
    't72-web-negative-controls',
    'qualifyOfficialWebComposition',
    'PR_A_WEB_ROWS',
    'PR_A_SINGLETON_PACKAGES',
    'readHostWebIndex',
    'assertWebIndexQualified',
    'assertSingleWebOwners',
    'assertDeclaredWebRows',
    'pr-a-web-enabled.patch.yml',
    'pr-a-duplicate-modules.patch.yml',
    'SPLIT_PROCESS_PLAYWRIGHT_ROOT',
    'pr-a-web-browser.mjs',
    'PR_A_WELCOME_NOTICE_VERSION',
    'welcomeNoticeVersion',
    'documentsDirectory',
  ]) {
    assert.ok(source.includes(marker), `missing PR-A marker ${marker}`)
  }
  // Both states must exist: the plain (default-off) Host and the ONE isolated
  // enable patch. A script that only ran the enabled path could never prove the
  // product default, and one that only ran the default could never qualify Web.
  assert.match(source, /const plainHost = new EntryProcess\('host', entries\.host, base\)/u)
  assert.match(source, /env: \{ \.\.\.base\.env, SPLIT_PROCESS_EXTRA_PATCH: webPatch \}/u)
  // The Browser case is a hand/isolated-qualification proof, not a CI lane: it
  // runs only when the pinned external Playwright install is named. A run that
  // requires it (SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1) FAILS without it, and the
  // inventory/summary carry the verdict instead of claiming a full pass.
  assert.match(source, /const playwrightRoot = process\.env\.SPLIT_PROCESS_PLAYWRIGHT_ROOT/u)
  assert.match(source, /const REQUIRE_WEB_BROWSER = process\.env\.SPLIT_PROCESS_REQUIRE_WEB_BROWSER === '1'/u)
  assert.match(source, /assert\(!REQUIRE_WEB_BROWSER,/u)
  assert.match(source, /this run does NOT exercise the real Browser and does not claim it/u)
  assert.match(source, /const webQualification = await qualifyOfficialWebComposition\(\)/u)
  assert.match(source, /webComposition: webBrowserVerdict === 'PASS'/u)
  assert.match(source, /PASS_OFFICIAL_WEB_COMPOSITION_REAL_BROWSER/u)
  assert.match(source, /NOT_QUALIFIED \(\$\{webBrowserVerdict\}\)/u)
  // EVERY non-PASS verdict fails a required run, not only the absent root.
  assert.match(source, /assert\(!REQUIRE_WEB_BROWSER \|\| webQualification\.browser === 'PASS'/u)
  assert.match(source, /browserCase = existsSync\(join\(coordination, 'browser-result\.json'\)\) \? 'FAILED' : 'INCOMPLETE'/u)
  // No raw driver output may be retained: only fixed facts and redacted text.
  assert.doesNotMatch(source, /stderr: browserErr/u)
  assert.doesNotMatch(source, /stdout: browserOut/u)
  assert.match(source, /redactWebQualificationText/u)
  // The driver exit is awaited through ONE shared, timer-releasing bound.
  assert.match(source, /const browserExitBounded = timeoutMs => browserDriverExitBounded\(browserExit, timeoutMs, 'PR_A_BROWSER_EXIT_TIMEOUT'\)/u)
  assert.match(source, /export async function browserDriverExitBounded\(browserExit, timeoutMs, tag\)/u)
  assert.match(source, /export async function raceWithAbortableDeadline/u)
  assert.match(source, /AbortController/u)
  assert.match(source, /expiry\.abort\(\)/u)
  assert.match(source, /EXIT_TIMEOUT/u)
  assert.doesNotMatch(source, /await browserExit\.catch/u)
  // A driver that already exited fails the observation it owns immediately
  // instead of consuming the whole wait budget, and the wait it started is
  // CANCELLED so no polling timer survives the early failure. There is exactly
  // ONE such mechanism, and BOTH Browser lanes bind it.
  assert.equal((source.match(/export async function whileBrowserDriverRuns\(/gu) ?? []).length, 1,
    'the driver-exit/observation race must exist once, as a shared helper')
  assert.match(source, /const whileBrowserRuns = \(startWait, label\) => whileBrowserDriverRuns\(browserExit, startWait, 'PA-05', label\)/u)
  assert.match(source, /const stopWait = new AbortController\(\)/u)
  assert.match(source, /stopWait\.abort\(\)/u)
  assert.match(source, /the real-Browser driver exited \(\$\{String\(outcome\.exit\.code\)\}/u)
  assert.match(source, /signal => waitForCondition\(/u)
  assert.match(source, /QUALIFICATION_CONDITION_ABORTED/u)
  // The TUI paints are judged by the TUI, never by Browser liveness: the driver
  // may exit normally while the renderer paints the same Host message later.
  assert.doesNotMatch(source, /whileBrowserRuns\(\s*\n\s*tui\.waitForScreen\(/u,
    'no TUI screen wait may be raced against the Browser process lifetime')
  assert.match(source, /await tui\.waitForScreen\(marker, 'PA-05 TUI paints the Browser prompt'/u)
  assert.match(source, /await tui\.waitForScreen\('stub answer'/u)
  // The real-Browser driver redacts its own retained failure text.
  const driver = readFileSync(join(ROOT, 'scripts', 'fixtures', 'pr-a-web-browser.mjs'), 'utf8')
  assert.match(driver, /function redacted\(text\)/u)
  assert.match(driver, /result\.error = redacted\(String\(error\.message\)\)/u)
  assert.match(driver, /result\.consoleErrors\.push\(redacted\(message\.text\(\)\)/u)
  assert.match(driver, /console\.error\(`PR_A_BROWSER_FAILURE: \$\{redacted\(result\.error\)\}`\)/u)
  // The negative controls must restore the isolated install byte for byte.
  assert.match(source, /renameSync\(distIndex, missingDist\)/u)
  assert.match(source, /renameSync\(missingDist, distIndex\)/u)
  assert.match(source, /the official frontend dist was not restored byte for byte/u)
  assert.ok(existsSync(join(ROOT, 'scripts', 'fixtures', 'pr-a-web-browser.mjs')),
    'the real-Browser driver fixture must exist')
  // The two isolated-fixture facts ride the SAME private enable patch as the
  // roster: the first-run notice acknowledgement (the official UI cannot persist
  // it while the roster rides a CLI overlay) and the Workspace Controller's
  // Documents override (an isolated HOME has no usable Documents directory).
  // Neither is a product default.
  assert.match(source, /welcomeNoticeVersion: '\$\{PR_A_WELCOME_NOTICE_VERSION\}'/u)
  assert.match(source, /- id: workspace-controller\\n  config:\\n    documentsDirectory: '\$\{documentsDirectory\}'/u)
})

test('the Web runtime toggle lane drives the private Peer control, never a Host shortcut', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const start = source.indexOf('const qualifyWebRuntimeToggle = async () => {')
  const end = source.indexOf('const toggleQualification = await qualifyWebRuntimeToggle()')
  assert.ok(start > 0 && end > start, 'the t73 lane must stay one bounded function')
  const lane = source.slice(start, end)
  // The control path is the REAL authenticated Peer through the v2 Gateway: the
  // qualification op of the internal Client entry, correlated by requestId.
  assert.match(lane, /op: 'qualification-web-access'/u)
  assert.match(lane, /webAccessEnabled/u)
  assert.match(lane, /entry\.op === 'web-access' && entry\.requestId === requestId/u)
  assert.doesNotMatch(lane, /piTuiWebAccess\.(getStatus|setEnabled)\(/u,
    'the smoke may only reach the toggle through the authenticated Remote call')
  assert.doesNotMatch(lane, /registerFallback|loader\.resolve|Entry\.update/u,
    'the smoke must not drive the Loader directly')
  // The SMOKE function must own its C1 fixture and profile paths: the outer C1
  // section's bindings are BLOCK-SCOPED there, so reaching for one throws a
  // ReferenceError only when the lane finally runs. These two assertions scan
  // `lane`, which is the smoke function's own source slice — never this test.
  assert.match(lane, /const c1Fixture = writeC1WorkFixture\(/u,
    'the lane must build the C1 fixture it owns')
  assert.match(lane, /readFileSync\(c1Fixture\.patchPath/u)
  assert.doesNotMatch(lane, /\bc1Work\b|\bprofileDir\b/u,
    'the smoke function may not reference a binding declared inside another lane\'s block')
  // The three traces carry the verdicts the inventory reports.
  for (const marker of [
    't73-web-default-off',
    't73-web-enabled',
    't73-web-disabled-live',
    't73-web-reenabled',
    't73-web-toggle-final',
    't73-web-browser-result',
    't73-web-negative-controls',
  ]) {
    assert.ok(lane.includes(marker), `missing t73 marker ${marker}`)
  }
  // PB-01: the default-off Host must be asserted on the REAL HTTP surface, and
  // the TUI must really own a Session on it.
  assert.match(lane, /assertWebOffHttp\(origin, 'PB-01'\)/u)
  assert.match(lane, /tui\.send\('pr-b plain tui\\r'\)/u)
  assert.match(lane, /record\.openSessionId === sessionT/u)
  // PB-02/03: exactly the frozen roster is asserted active, and the ONE allowed
  // PENDING row is recorded instead of being ignored.
  assert.match(lane, /assertWebFullyOn\(enabledStatus, 'PB-02'\)/u)
  assert.match(lane, /const deliverablesState = enabledStates\.get\('ui-deliverables'\)/u)
  assert.match(lane, /deliverablesState === 'state-0' \|\| deliverablesState === 'active'/u,
    'the optional Web row may be pending or active, but the verdict must be recorded')
  assert.match(lane, /new Map\(PR_A_WEB_ROWS\.map\(row => \[row\.id/u,
    'the lane must assert the FROZEN roster, never a list derived from the Host')
  // PB-05/06: an ACCEPTED held Turn is in flight across the disable, the TUI
  // keeps its Session and transport generation, and it accepts a new prompt.
  assert.match(lane, /event\.kind === 'long-turn-held'/u)
  assert.match(lane, /assertToggle\(await webAccess\(peer, 'PB-04', false\), 'disabled', 'PB-04 setEnabled\(false\)'\)/u)
  assert.match(lane, /tuiStillOn\.generationId === tuiGeneration/u)
  assert.match(lane, /tui\.send\('pr-b after disable\\r'\)/u)
  assert.match(lane, /'PB-06 the TUI painted the post-disable answer'/u)
  // The shared Host owners are proved by LIVE fiber identity across every edge:
  // the sample below is the protected-row set the Host status reports.
  assert.match(lane, /enabledUids\[id\] === protectedUids\[id\]/u)
  assert.match(lane, /disabledUids\[id\] === protectedUids\[id\]/u)
  assert.match(lane, /reenabledUids\[id\] === protectedUids\[id\]/u)
  // PB-07: the real Browser run happens on the SAME Host process after the
  // second enable, and the TUI observes the Browser-written Turn.
  assert.match(lane, /assertToggle\(await webAccess\(peer, 'PB-07', true\), 'enabled'/u)
  assert.match(lane, /PR_A_EXPECTED_ANSWER_PREFIX: 'long-turn answer'/u,
    'the Browser driver must wait for the real model answer of this run')
  // The Browser Session file is a fact the DRIVER owns: the wait must be raced
  // against the driver's own exit (the PR-A mechanism), never a bare window.
  assert.match(lane, /whileBrowserDriverRuns\(\s*\n\s*browserExit,/u,
    'the PR-B lane must reuse the shared driver-exit race')
  assert.match(lane, /'PB-07',\n\s*'the Browser Session file appeared'/u)
  assert.doesNotMatch(lane, /await waitForCondition\(\(\) => existsSync\(join\(coordination, 'browser-session\.json'\)\)/u,
    'a bare fixed-window wait for a driver-owned fact is the defect this race removes')
  assert.match(lane, /const browserExitBounded = timeoutMs => browserDriverExitBounded\(browserExit, timeoutMs, 'PR_B_BROWSER_EXIT_TIMEOUT'\)/u)
  assert.match(lane, /await waitDurableTurn\(browserSession, marker, 'PB-07 Browser'\)/u)
  assert.match(lane, /browserCase = 'PASS'/u)
  assert.match(source, /assert\(!REQUIRE_WEB_BROWSER \|\| toggleQualification\.browser === 'PASS'/u,
    'a required Browser run may only be satisfied by a PASS verdict')
  // PB-10: nothing was persisted, and the official Host shutdown owns the exit.
  assert.match(lane, /profilePatchAfter\.equals\(profilePatchBefore\)/u)
  assert.match(lane, /const hostShutdown = await host\.shutdown\(\)/u)
  // PB-08/09: the three refusing lanes and their byte-for-byte restore.
  assert.match(lane, /absentRecord\.status\?\.state === 'enabled' \|\| absentRecord\.status\?\.state === 'unavailable'/u,
    'the missing-asset lane must accept the request-time read while refusing a served index')
  assert.match(lane, /const absentIndex = await readHostWebIndex\(/u,
    'the missing-asset lane must probe the authenticated index chain, not the mux cookie')
  assert.match(lane, /absentIndex\.graph === undefined/u,
    'the missing-asset lane must prove no browser graph is served')
  assert.match(lane, /indexServed: absentIndex\.index\.status === 200 && absentIndex\.hasModuleLoader/u)
  assert.match(lane, /duplicateRecord\.status\?\.state === 'unavailable'/u)
  // A core Web module that cannot be imported IS the plan's `unavailable`
  // witness: the enable refuses, nothing is mounted and no index is served.
  assert.match(lane, /brokenRecord\.status\?\.state === 'unavailable'/u,
    'a core Web module that cannot import must produce the unavailable verdict')
  assert.match(lane, /const modulesEntry = join\(dirname\(createRequire\(anchor\)\.resolve\('@deepseek-ai\/dsh-client-modules\/package\.json'\)\)/u)
  assert.match(lane, /renameSync\(missingModules, modulesEntry\)/u,
    'the missing core module must be restored byte for byte')
  assert.match(lane, /brokenActive\.length === 0/u)
  assert.match(lane, /second \.\*dsh-client-modules/u)
  assert.match(lane, /malformed\.errorCode === 'gateway\/input-invalid'/u)
  assert.match(lane, /renameSync\(missingDist, distIndex\)/u)
  // The lane may not invent a product surface: no flag, setting or CLI switch
  // selects the Web frontend.
  assert.doesNotMatch(lane, /--web\b|WEB_ENABLED|M5_WEB_MODE/u)
})

test('the frozen Web roster matches the Host-only overlay exactly and stays default-disabled', () => {
  assert.equal(PR_A_WEB_ROWS.length, 59, 'the PR-A Web roster is exactly 59 official rows')
  const ids = PR_A_WEB_ROWS.map(row => row.id)
  assert.equal(new Set(ids).size, ids.length, 'the frozen roster owns each row id once')
  const overlay = parseYaml(HOST_ONLY_PATCH)
  const inserts = overlay.filter(entry => Array.isArray(entry.insert))
  assert.equal(inserts.length, 2, 'the overlay declares the Host execution insert and ONE Web insert')
  const declared = inserts[inserts.length - 1].insert
  assert.deepEqual(declared.map(row => row.id), ids, 'the overlay Web ids drifted from the frozen roster')
  assert.deepEqual(declared.map(row => row.name), PR_A_WEB_ROWS.map(row => row.name),
    'the overlay Web packages drifted from the frozen roster')
  assert.ok(declared.every(row => row.disabled === true), 'every Web row stays disabled by default')
  // A deleted roster row must fail the comparison above instead of being
  // silently accepted: this control proves the assertion is discriminating.
  assert.notDeepEqual(declared.slice(1).map(row => row.id), ids, 'a dropped row must change the comparison')
})

test('the Web qualification redactor removes every credential shape from retained text', () => {
  const token = 'Zr3secretLaunchTokenValue'
  const raw = [
    `page.goto: Timeout 90000ms exceeded while loading http://127.0.0.1:41234/?token=${token}`,
    `net::ERR_FAILED at http://127.0.0.1:41234/plugins/events`,
    `cookie exchange ?token=${token}&interactions=answer`,
    `bare launch token ${token} in a log line`,
  ].join('\n')
  const redacted = redactWebQualificationText(raw, [token])
  assert.equal(redacted.includes(token), false, 'the exact launch token must not survive redaction')
  assert.equal(/[?&]token=(?!<redacted>)/u.test(redacted), false, 'a token query value must not survive redaction')
  assert.equal(/127\.0\.0\.1:\d+/u.test(redacted), false, 'a loopback origin must not survive redaction')
  assert.match(redacted, /bare launch token <redacted-token> in a log line/u)
  assert.match(redacted, /token=<redacted>/u)
  assert.match(redacted, /http:\/\/127\.0\.0\.1:<port>/u)
  // Discriminating control: the SAME assertion group rejects the raw text.
  assert.throws(() => {
    assert.equal(raw.includes(token), false)
  })
})

test('a completed abortable deadline releases its timer instead of holding the process', () => {
  const probe = `
    import { raceWithAbortableDeadline } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}
    const started = Date.now()
    const value = await raceWithAbortableDeadline(
      Promise.resolve({ code: 0, signal: null }),
      120_000,
      { code: null, signal: 'EXIT_TIMEOUT' },
    )
    if (value.code !== 0) process.exit(2)
    console.error('elapsed=' + String(Date.now() - started))
  `
  // spawnSync's own 10s bound is the witness: a surviving 120s timer would keep
  // the child alive past it and make this call report a timeout instead of 0.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.error, undefined, `the probe was still running when its bound expired: ${String(result.error)}`)
  assert.equal(result.status, 0, `the probe exited ${String(result.status)}: ${result.stderr}`)
  const elapsed = Number(/elapsed=(\d+)/u.exec(result.stderr ?? '')?.[1] ?? Number.NaN)
  assert.ok(Number.isFinite(elapsed) && elapsed < 3_000,
    `the completed deadline took ${String(elapsed)}ms to release; a bare sleep would hold it for 120s`)
})

test('an aborted condition wait stops polling instead of holding the process', () => {
  const probe = `
    import { waitForCondition } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 120) // bounded abort window: the probe's own input, not a settle
    try {
      await waitForCondition(() => false, 'probe condition', 240_000, controller.signal)
      process.exit(3)
    } catch (error) {
      if (error?.code !== 'QUALIFICATION_CONDITION_ABORTED') process.exit(4)
      console.error('elapsed=' + String(Date.now() - started))
    }
  `
  // A surviving poller would keep this child alive for the full 240s bound.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.error, undefined, `the probe was still running when its bound expired: ${String(result.error)}`)
  assert.equal(result.status, 0, `the probe exited ${String(result.status)}: ${result.stderr}`)
  const elapsed = Number(/elapsed=(\d+)/u.exec(result.stderr ?? '')?.[1] ?? Number.NaN)
  assert.ok(Number.isFinite(elapsed) && elapsed < 3_000,
    `the aborted wait took ${String(elapsed)}ms to stop; the poller must end with the signal`)
})

test('a Browser exit cannot turn a later TUI paint into a failure', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // The prompt paint is a TUI fact; the Host commitment is proved separately by
  // the durable-log assertion, so the wait must not be raced with the driver.
  const promptWait = source.slice(
    source.indexOf("// The TUI paint is NOT gated on Browser liveness"),
    source.indexOf('PA-05 TUI paints the Browser prompt'),
  )
  assert.ok(promptWait.length > 0, 'the decoupling comment must stay next to the prompt wait')
  assert.equal(/whileBrowserRuns/u.test(promptWait), false,
    'the TUI prompt paint must not be coupled to the Browser process lifetime')
  assert.match(source, /await waitBrowserTurn\(browserSession, marker, 'PA-05'\)/u,
    'the Host commitment of the Browser prompt must stay asserted independently')
})
