/**
 * M4-A0 split-process smoke wiring guard.
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
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { EntryProcess, statusMatches } from '../../scripts/split-process-smoke.mjs'

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
  assert.match(source, /import \{ requireExactSmokeDshPin \} from '\.\/lib\/split-smoke-diagnostics\.mjs'/u,
    'the exact-pin rule is shared with the U lane, not restated per script')
  const main = source.slice(source.indexOf('async function main()'))
  const validate = main.indexOf('const candidateManifest = validateCandidateTarball(tarball)')
  const sha = main.indexOf('const candidateSha256 =')
  const target = main.indexOf('const targetDshVersion = npmDshVersion()')
  const guard = main.indexOf("requireExactSmokeDshPin('candidate', candidateManifest, targetDshVersion)")
  const distribution = main.indexOf('loadDshDistribution({ mode: ')
  const workRoot = main.indexOf("mkdtempSync(join(tmpdir(), 'dsh-split-process-'))")
  const install = main.indexOf('runPnpmInstall(harnessDir, env, distribution)')
  assert.ok(validate >= 0 && sha > validate && target > sha && guard > target,
    'the candidate manifest must be read, hashed and pinned against the lane target before anything is set up')
  assert.ok(distribution > guard && workRoot > guard && install > workRoot,
    'an unqualified candidate may not load the distribution, create a work root or install')
  // The shared validator keeps its own public semantics for every other caller.
  assert.doesNotMatch(source, /function validateCandidateTarball/u)
})

test('the upgraded smoke carries every B1/B2-HF gate and the critical negative controls', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  for (const gate of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T18', 'T19', 'T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30', 'T31', 'T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38', 'T39', 'T40', 'T41', 'T42', 'T43', 'T44', 'T45', 'T46', 'T47', 'T48', 'T49', 'T50', 'T51', 'T52', 'T53', 'T54', 'T55', 'T56', 'T57', 'T58', 'T59', 'T60']) {
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
    'c2a-goal-armed',
    'c2a-goal-round',
    'c2a-maintenance',
    'c2a-schedule',
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
    't26-no-cookie',
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
  assert.equal(extraPatchUses.length, 11,
    'the extra patch may only implement the two child mutations, the T26 Host-Runtime/official-row mutations, the whole-smoke mutation mode, the isolated surface LLM overlay, the isolated Host Schedule overlay and the isolated armed-Goal overlay')
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: tuiMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: connectionMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: sessionControllerMutationPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: schedulePatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: armedPatch/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: surfaceLlm\.patchPath/u)
  assert.match(source, /SPLIT_PROCESS_EXTRA_PATCH: hostRuntimeMutationPatch/u)
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
  assert.match(source, /const workDir = [A-Za-z]+Sync\(join\(tmpdir\(\), 'dsh-split-process-'\)\)/u)
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
