/**
 * Split-process smoke wiring guard.
 *
 * The real OS qualification lives in `scripts/split-process-smoke.mjs` and is
 * driven by the dedicated CI split-process job on npm release-tag pushes, or
 * by an explicitly opted-in workflow_dispatch on any npm-mode
 * refs/heads/... branch. An ordinary PR or branch push legally skips the job
 * — that skip is NOT the full smoke
 * passing: split-process development work runs `pnpm smoke:split-process`
 * manually under its own task plan. This tooling test is a lightweight
 * wiring/selector/CI/utility guard: it does NOT prove the complete
 * case registry, Host/Client behaviour, Browser qualification or a
 * Full PASS. Those claims are owned by the real lane runs and the shared
 * diagnostics tests.
 *
 * @module split-process-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { assertSelectedVerdict, runSelectedCase, waitForCondition } from '../../scripts/split-process-smoke.mjs'
import { PR_A_WEB_ROWS, raceWithAbortableDeadline, redactWebQualificationText } from '../../scripts/smoke/split-process/web-helpers.mjs'
import { createSmokeDiagnostics, failureCategoryOf, redactErrorForStep, SplitSmokeAssertionError } from '../../scripts/lib/split-smoke-diagnostics.mjs'
import { throwSceneFailure, sceneWorkspace } from '../../scripts/smoke/split-process/acp-sdk-content-interoperability.mjs'
import { statusMatches } from '../../scripts/lib/split-smoke-processes.mjs'
import {
  casePlatformsOf,
  listDefaultLaneCases,
  listSelectableCases,
  parseSelectionArgs,
  resolveSelection,
  selectedNotVerifiedLine,
  selectedPassLine,
} from '../../scripts/lib/split-smoke-selection.mjs'
import { HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import { encodeUnitValue } from '../../src/app/remote-process/local-host-manager.ts'
import { cleanupOutcomeError, killVerifiedHost, managedHostGateReason, stopAndRemoveManagedUnit, unitBelongsToRun, unitFileSafetyError } from '../../scripts/smoke/split-process/managed-host-m6-2b.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'split-process-smoke.mjs')
const WEB_HELPERS_MODULE = join(ROOT, 'scripts', 'smoke', 'split-process', 'web-helpers.mjs')

/** Run the real lane CLI with one private temp root. */
function runCli(args, tmpRoot, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, TMPDIR: tmpRoot, ...env },
  })
}

/** No lane work root may survive a rejected selection. */
function workRootsIn(tmpRoot) {
  return readdirSync(tmpRoot).filter(name => name.startsWith('dsh-split-process-'))
}

test('the split-process smoke runs on tag pushes or an explicit branch dispatch', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-process'], 'node scripts/split-process-smoke.mjs')
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  // Parse the two jobs rather than matching raw text: the split-process job
  // must run for npm release-tag pushes and explicit npm-mode branch dispatches
  // AND execute the real lane against the downloaded candidate. An ordinary
  // branch/PR skip remains the default; the qualifier verdict requires success
  // for opted-in runs.
  const workflow = parseYaml(ci)
  const job = workflow.jobs['split-process']
  assert.ok(job, 'the split-process smoke must be its own CI job')
  const splitRun = job.steps?.find(step => typeof step.run === 'string'
    && step.run.trim() === 'pnpm smoke:split-process -- "$CANDIDATE"')
  assert.ok(splitRun, 'the split-process job must execute the real lane against the downloaded candidate')
  const smokeSource = readFileSync(SCRIPT, 'utf8')
  const failureMirrors = smokeSource.match(/evidencePath: process\.env\.SPLIT_PROCESS_FAILURE_EVIDENCE/gu) ?? []
  assert.equal(failureMirrors.length, 6, 'every full/selected/input failure boundary mirrors the safe CI report')
  const evidenceSetupIndex = job.steps.findIndex(step => step.name === 'Prepare private Split failure evidence directory')
  const runIndex = job.steps.indexOf(splitRun)
  assert.ok(evidenceSetupIndex >= 0 && evidenceSetupIndex < runIndex,
    'the private evidence destination is ready before the smoke starts')
  const failureUpload = job.steps.find(step => step.name === 'Upload sanitized Split smoke failure report')
  assert.equal(failureUpload?.uses, 'actions/upload-artifact@v7')
  assert.equal(failureUpload?.if, 'always()')
  assert.equal(failureUpload?.with?.name, 'split-process-failure')
  assert.equal(failureUpload?.with?.path, '${{ runner.temp }}/dsh-pi-tui-split-failure/failure.json')
  assert.equal(failureUpload?.with?.['if-no-files-found'], 'ignore')
  assert.equal(failureUpload?.with?.overwrite, true)

  assert.equal(job.if,
    "${{ always() && needs.dsh-context.result == 'success' && needs.candidate.result == 'success' && needs.dsh-context.outputs.mode == 'npm' && ((github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')) || (github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && inputs.run_split_process)) }}",
    'only npm release-tag pushes or an explicit npm-mode branch dispatch may run this job')
  const dispatch = (workflow.on ?? workflow['on']).workflow_dispatch
  assert.equal(dispatch.inputs.run_split_process.default, false,
    'manual Split qualification is opt-in')
  assert.equal(dispatch.inputs.run_split_process.description,
    'Run full Host/Client Split qualification on the selected npm-mode branch')
  assert.match(job.if, /startsWith\(github\.ref, 'refs\/heads\/'\)/u,
    'the manual dispatch must accept any refs/heads/... branch')
  assert.doesNotMatch(job.if, /github\.ref == 'refs\/heads\/main'/u,
    'the manual dispatch must not stay main-only')
  const ciVerdict = workflow.jobs.qualified.steps.find(step => typeof step.run === 'string'
    && step.run.includes('ci-verdict.mjs qualify'))
  assert.ok(ciVerdict?.run.includes('--phase "split-process=${{ needs[\'split-process\'].result }}"'),
    'qualification verdict must consume the actual split-process job result')
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
    import { createSplitProcessScope } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'lib', 'split-smoke-processes.mjs')).href)}
    const { EntryProcess } = createSplitProcessScope()
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

test('the extracted split-smoke modules import without starting a lane', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-smoke-imports-')
  const urls = [
    'scripts/lib/split-smoke-processes.mjs',
    'scripts/lib/split-smoke-sessions.mjs',
    'scripts/lib/split-smoke-fixtures.mjs',
    'scripts/lib/split-smoke-profile.mjs',
    'scripts/lib/split-smoke-selection.mjs',
    'scripts/smoke/split-process/host-runtime-disabled.mjs',
    'scripts/smoke/split-process/account-composition.mjs',
    'scripts/smoke/split-process/subagent-settings-fr5a.mjs',
    'scripts/split-process-smoke.mjs',
    'scripts/split-process-upgrade-smoke.mjs',
  ].map(relative => JSON.stringify(pathToFileURL(join(ROOT, relative)).href))
  const probe = `
    for (const url of [${urls.join(', ')}]) await import(url)
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 15_000,
    cwd: dir,
    env: { ...process.env, TMPDIR: dir },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '', 'an import must not announce a checkpoint, identity or PASS')
  assert.deepEqual(readdirSync(dir), [], 'an import may not create a work root or report directory')
})

test('the Split lifecycle log owns START/DONE/ERROR and the Recovery subscenes', () => {
  const processSource = readFileSync(SCRIPT, 'utf8')
  assert.equal((processSource.match(/const result = await diagnostics\.runStep\(/gu) ?? []).length, 1,
    'the full registry loop owns its case scope')
  assert.equal((processSource.match(/export async function runSelectedCase\(/gu) ?? []).length, 1,
    'the selected case and its verdict admission share one helper')
  assert.match(processSource,
    /export async function runSelectedCase\(diagnostics, selectedCase, context\) \{\n  return diagnostics\.runStep\(`case\/\$\{selectedCase\.id\}`, async \(\) => \{\n    const result = await selectedCase\.run\(context\)\n    assertSelectedVerdict\(selectedCase\.id, result\)\n    return result\n  \}\)\n\}/u,
    'the selected verdict assertion must run INSIDE the case lifecycle scope')
  assert.equal((processSource.match(/runStep: \(name, operation\) => diagnostics\.runStep\(name, operation\)/gu) ?? []).length, 2,
    'both lane contexts expose the same collector to the scenarios')
  // trace() must keep emitting the business-milestone checkpoint on default
  // stderr (long scenes otherwise lose their intermediate progress); the
  // START/DONE/ERROR lifecycle scopes stay owned by runStep.
  assert.match(processSource, /diagnostics\?\.checkpoint\(event\)/u,
    'business milestones remain visible without SPLIT_PROCESS_TRACE')
  assert.match(processSource, /redactErrorForStep\(raw, failedStep\)/u,
    'the default failure output uses the ONE Web/non-Web redaction policy')
  const scenario = readFileSync(join(ROOT, 'scripts', 'smoke', 'split-process', 'detached-turn-interactions.mjs'), 'utf8')
  for (const name of ['t44', 't45', 't46', 't47', 'unowned-job-arm', 'goal-armed', 'goal-round',
    'maintenance-sweep', 'maintenance-wait-running', 'maintenance-read-liveness',
    'maintenance-release-and-settle', 'host-schedule', 't48', 't51', 't52', 't55a', 't55b', 't56']) {
    assert.ok(scenario.includes(`step('${name}'`), `the Recovery subscene ${name} must own a START/DONE/ERROR scope`)
  }
  // The loop-driven cases produce one scope PER ITERATION, never one merged step.
  assert.equal((scenario.match(/await step\(label, async \(\) => \{/gu) ?? []).length, 2,
    't49/t50 and t55c own one scope per iteration')
  assert.match(scenario, /await step\(scenario === 'approval-allow' \? 't53' : 't54'/u,
    't53/t54 own one scope per iteration')
})

test('a rejected selected verdict fails inside the case scope', async (t) => {
  const dir = testLifecycle(t).tempDir('split-selected-verdict-')
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = dir
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  })
  const diagnostics = createSmokeDiagnostics({
    lane: 'split-process',
    heading: 'SPLIT_PROCESS_SMOKE',
    marker: 'T',
    runtimeDshPin: '0.2.2-rc.1',
  })
  const chunks = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true }
  let caught
  try {
    await runSelectedCase(diagnostics, {
      id: 'web.official-composition',
      run: async () => ({ status: 'FAIL', browser: 'FAIL' }),
    }, {})
  } catch (error) {
    caught = error
  } finally {
    process.stderr.write = original
  }
  const stderr = chunks.join('')
  assert.match(stderr, /\[split\] \S+ START case\/web\.official-composition/u)
  assert.match(stderr, /\[split\] \S+ ERROR case\/web\.official-composition durationMs=\d+/u)
  assert.doesNotMatch(stderr, /DONE case\/web\.official-composition/u,
    'a rejected verdict must not leave the case marked DONE')
  // The failed scope is the rejected case, not a missing post-DONE step.
  assert.equal(diagnostics.failedStep(), 'case/web.official-composition')
  const report = diagnostics.reportFailure(caught)
  assert.equal(report.failedStep, 'case/web.official-composition')
  assert.match(report.error?.message ?? '', /selected web\.official-composition/u)
})

test('the npm release-tag split-process job pins and requires both Browser qualifications', () => {
  // The release-tag CI job installs ONE pinned Playwright and requires BOTH
  // Browser flags; no floating version and no PR-run Browser PASS.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const job = workflow.jobs['split-process']
  assert.equal(job.timeoutMinutes ?? job['timeout-minutes'], 60,
    'the product Browser lane needs the bounded longer job timeout')
  assert.match(job.env.PLAYWRIGHT_VERSION, /^\d+\.\d+\.\d+$/u,
    'the Playwright version must be a pinned exact version, not a range or tag')
  const install = job.steps.find(step => step.name === 'Install the isolated Playwright Chromium qualification tools')
  assert.ok(install, 'the split-process job must install the pinned Playwright Chromium')
  assert.match(install.run, /playwright@\$PLAYWRIGHT_VERSION/u)
  assert.match(install.run, /install --with-deps chromium/u)
  assert.match(install.run, /SPLIT_PROCESS_REQUIRE_WEB_BROWSER=1/u)
  assert.match(install.run, /SPLIT_PROCESS_REQUIRE_WEB_PRODUCT=1/u)
  assert.match(install.run, /M5_WEB_PRODUCT_EVIDENCE=/u)
  assert.match(install.run, /SPLIT_PROCESS_PLAYWRIGHT_ROOT=\$TOOLS/u)
  assert.ok(job.steps.some(step => step.name === 'Upload the product Browser qualification evidence'))
  assert.match(job.if, /startsWith\(github\.ref, 'refs\/tags\/'\)/u,
    'the Browser qualification must stay release-tag-only (ordinary PRs skip it)')
})

test('the frozen Web roster matches the Host-only overlay exactly and stays default-disabled', () => {
  const ids = PR_A_WEB_ROWS.map(row => row.id)
  assert.equal(new Set(ids).size, ids.length, 'the frozen roster owns each row id once')
  // The mandatory Client dependency closure of the shipped official UIs and
  // the file-actions / message-quotes / changed-files capability rows are
  // asserted independently: the oracle must not silently drop a required row.
  // The SET is the contract, never a historical row count.
  for (const id of ['ui-context-menu', 'ui-file-drag', 'ui-file-actions', 'message-quotes', 'workspace-changes', 'ui-deliverables']) {
    assert.equal(ids.includes(id), true, `the frozen roster must include the official "${id}" row`)
  }
  const generated = parseYaml(readFileSync(join(ROOT, 'generated', 'web-access', 'cordis.patch.yml'), 'utf8'))
  const inserts = generated.filter(entry => Array.isArray(entry.insert))
  assert.equal(inserts.length, 1, 'the generated Web layer must hold ONE insert group')
  const declared = inserts[0].insert
  assert.deepEqual(declared.map(row => row.id), ids, 'the generated Web ids drifted from the frozen roster')
  assert.deepEqual(declared.map(row => row.name), PR_A_WEB_ROWS.map(row => row.name),
    'the generated Web packages drifted from the frozen roster')
  assert.ok(declared.every(row => row.disabled === true), 'every Web row stays disabled by default')
  // The Host-only overlay must NOT re-declare a Web row: a command-line config
  // override blocks the official ConfigEditor from persisting that entry.
  const overlay = parseYaml(HOST_ONLY_PATCH)
  const overlayRows = overlay.flatMap(entry => entry.insert ?? [entry])
  for (const id of ids) {
    if (id === 'web-runtime' || id === 'office-kit' || id === 'skill-office') continue
    assert.equal(overlayRows.some(row => row.id === id), false,
      `the Host-only overlay must not re-declare the Web row "${id}"`)
  }
  // The three non-user safety values stay fixed at the Host layer.
  for (const id of ['web-runtime', 'office-kit', 'skill-office']) {
    assert.equal(overlayRows.filter(row => row.id === id).length, 1,
      `the Host-only overlay must keep exactly one fixed "${id}" override`)
  }
})

test('account callback failures redact state, code, PKCE and cookie from reports', () => {
  const raw = [
    'navigation failed at http://127.0.0.1:43121/oauth/callback?code=one-time&state=private-state',
    'code_verifier=private-verifier code_challenge=private-challenge redirect_uri=http://127.0.0.1:43121/oauth/callback',
    'Set-Cookie: session=private-cookie',
  ].join('\n')
  const redacted = redactErrorForStep(raw, 'case/account.official-composition')
  for (const secret of ['one-time', 'private-state', 'private-verifier', 'private-challenge', 'private-cookie']) {
    assert.equal(redacted.includes(secret), false, `${secret} must not survive the account failure report`)
  }
  const jsonSecrets = JSON.stringify({ state: 'json-state-secret', code: 'json-code-secret', code_verifier: 'json-verifier-secret' })
  const jsonRedacted = redactErrorForStep(jsonSecrets, 'case/account.official-composition')
  for (const secret of ['json-state-secret', 'json-code-secret', 'json-verifier-secret']) {
    assert.equal(jsonRedacted.includes(secret), false, `JSON field ${secret} must not survive the account failure report`)
  }
  assert.match(jsonRedacted, /"code_verifier":"<redacted>"/u)
  assert.match(redacted, /state=<redacted>/u)
  assert.match(redacted, /code=<redacted>/u)
  assert.match(redacted, /http:\/\/127\.0\.0\.1:<port>/u)
  assert.match(redacted, /set-cookie: <redacted>/iu)
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
  const headers = redactWebQualificationText([
    'Cookie: session=supersecretcookie',
    'Set-Cookie: dsh_session=anothersecret',
    'Authorization: Bearer topsecretvalue',
  ].join('\n'), [])
  assert.equal(/supersecretcookie|anothersecret|topsecretvalue/u.test(headers), false,
    'Cookie/Authorization values must not survive the redactor')
  assert.match(headers, /cookie: <redacted>/iu)
})

test('a completed abortable deadline releases its timer instead of holding the process', () => {
  const probe = `
    import { raceWithAbortableDeadline } from ${JSON.stringify(pathToFileURL(WEB_HELPERS_MODULE).href)}
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

// ── The selectable bootstrap foundation ─────────────────────────────────────

test('listing selectable split cases does not install a profile or claim complete coverage', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-selectable-list-')
  const result = runCli(['--list'], dir)
  assert.equal(result.status, 0, `--list must exit 0: ${result.stderr}`)
  // The listing prints the REGISTRY order — the same order a suite and the full
  // lane execute — so a sorted display can never show an order no run performs.
  // The frozen ID/suite/order oracle belongs to the registry test; here the
  // expectation is derived from the live registry so no second roster exists.
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    'SPLIT_PROCESS_SELECTABLE_CASES scope=SELECTABLE_ONLY',
    ...listSelectableCases().map(entry => `suite=${entry.suite} case=${entry.id} title=${entry.title} platforms=${casePlatformsOf(entry)}`),
  ], 'the listing must follow the registry execution order')
  // A listing never becomes a full PASS and never creates a scene.
  for (const forbidden of ['SPLIT_PROCESS_SMOKE_PASS', 'T60 PASS', 'PASS_REAL_SPLIT_PROCESS',
    'PASS_PRODUCT_BROWSER', 'WC-12 PASS']) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(forbidden),
      `a listing must not claim ${forbidden}`)
  }
  assert.deepEqual(workRootsIn(dir), [], 'a listing must not create a work root')
  assert.deepEqual(readdirSync(dir), [], 'a listing must not install or write a report')
})

test('every registry entry declares a conservative platform list and the nine shared cases are dual-platform', () => {
  const shared = [
    'surface.sessionless-host-file-f5b',
    'surface.generic-file-upload-f4',
    'surface.remote-git-branch-locality',
    'skills.sessionless-hot',
    'skills.live-hot',
    'skills.recovery',
    'mcp.servers-fr3',
    'mcp.servers-fr4',
    'multi-client.shared-session-interactions',
    // The product Browser×TUI matrix reads its process facts through the
    // platform seam (Linux /proc, Darwin lsof+ps) and drives the Browser from
    // the pinned Playwright install, so it is qualified on both platforms.
    'web.product-browser-tui',
    // The canonical preference case drives only the official settings wire,
    // the profile file and cold Host boots; there is no platform-specific
    // process/seat primitive beyond the shared Split harness.
    'profile.preferences',
  ]
  const cases = listSelectableCases()
  for (const entry of cases) {
    const platforms = entry.platforms ?? ['linux']
    assert.ok(Array.isArray(platforms) && platforms.length > 0 && platforms.every(p => p === 'linux' || p === 'darwin'),
      `${entry.id} must declare a real platform list, got ${JSON.stringify(platforms)}`)
    assert.ok(!platforms.includes('win32'), `${entry.id} must never claim Windows`)
  }
  for (const id of shared) {
    const entry = cases.find(candidate => candidate.id === id)
    assert.ok(entry, `${id} must stay registered`)
    assert.deepEqual(entry.platforms, ['linux', 'darwin'], `${id} must be the dual-platform shared case`)
  }
  // The invariant is a CEILING, not a frozen count: a case may claim Darwin
  // support only after it is listed in this audited matrix. A future native
  // evidence PR adds its id here deliberately; an accidental platform flag on
  // any other registry entry fails this guard.
  const dual = cases.filter(entry => (entry.platforms ?? ['linux']).includes('darwin'))
  const unaudited = dual.filter(entry => !shared.includes(entry.id)).map(entry => entry.id)
  assert.deepEqual(unaudited, [], 'only the audited shared cases may claim Darwin support')
})

test('platform-unsupported selections are refused before any candidate inspection', () => {
  const unsupportedPlatform = 'sunos'
  assert.throws(
    () => resolveSelection({ mode: 'case', id: 'managed-host.m6-2b-systemd' }, unsupportedPlatform),
    error => error.code === 'INPUT_PLATFORM_CASE_UNSUPPORTED'
      && /INPUT_PLATFORM_CASE_UNSUPPORTED/u.test(error.message)
      && /managed-host\.m6-2b-systemd/u.test(error.message),
    'a Linux-only case must be refused off its platform',
  )
  // A suite is refused as a WHOLE (never silently filtered) and names its members.
  assert.throws(
    () => resolveSelection({ mode: 'suite', suite: 'managed-host' }, unsupportedPlatform),
    error => error.code === 'INPUT_PLATFORM_CASE_UNSUPPORTED'
      && /managed-host\.m6-2b-systemd/u.test(error.message),
  )
  // A dual-platform case resolves on BOTH platforms; a Linux-only case stays valid on Linux.
  const f4 = resolveSelection({ mode: 'case', id: 'surface.generic-file-upload-f4' }, 'darwin')
  assert.equal(f4.cases.length, 1)
  assert.equal(resolveSelection({ mode: 'case', id: 'managed-host.m6-2b-systemd' }, 'linux').cases.length, 1)
  assert.equal(resolveSelection({ mode: 'suite', suite: 'managed-host' }, 'linux').cases.length,
    listSelectableCases().filter(entry => entry.suite === 'managed-host').length)
})

test('the no-selector full lane is refused off Linux before the candidate is read', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-full-platform-')
  // A missing candidate file would fail INPUT anyway; the platform refusal is
  // observable through the ordering: run the real CLI on a nonexistent tarball
  // on a non-Linux host and require the PLATFORM code, not a tarball error.
  if (process.platform === 'linux') {
    // On Linux the full lane proceeds to the ordinary candidate preflight; a
    // missing tarball must NOT be misreported as a platform refusal.
    const result = runCli(['definitely-missing.tgz'], dir)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, /INPUT_PLATFORM_FULL_UNSUPPORTED/u)
    return
  }
  const result = runCli(['definitely-missing.tgz'], dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /INPUT_PLATFORM_FULL_UNSUPPORTED/u,
    'the full lane must be refused by platform before the tarball is inspected')
  assert.match(result.stderr, /INPUT_UNQUALIFIED/u)
  assert.deepEqual(workRootsIn(dir), [], 'the refused full lane must not create a work root')
})

test('unknown and conflicting selectors are rejected before a work root exists', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-selectable-reject-')
  const id = 'bootstrap.host-runtime-disabled'
  const invalid = [
    ['--case', 'does-not-exist'],
    ['--case'],
    ['--case', id, '--suite', 'bootstrap'],
    ['--list', 'bogus.tgz'],
    ['--list', '--case', id],
    ['--shard', '2'],
    ['a.tgz', 'b.tgz'],
    ['--case', id, '--case', id],
  ]
  for (const args of invalid) {
    const result = runCli(args, dir)
    assert.notEqual(result.status, 0, `the selector ${JSON.stringify(args)} must fail`)
    assert.equal(result.signal, null, `the selector ${JSON.stringify(args)} must fail by itself`)
    assert.match(result.stderr, /INPUT_UNQUALIFIED/u, `the selector ${JSON.stringify(args)} must be an input failure`)
    assert.match(result.stderr, /INPUT_SMOKE_SELECTION_INVALID/u, `the selector ${JSON.stringify(args)} must name its code`)
    assert.deepEqual(workRootsIn(dir), [], `the selector ${JSON.stringify(args)} must not create a work root`)
  }
})

test('a required Browser qualification cannot be satisfied by a selected non-Browser case', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-selectable-browser-')
  if (process.platform === 'linux') {
    // On Linux the required-Browser refusal is the FIRST selector input check.
    for (const env of [{ SPLIT_PROCESS_REQUIRE_WEB_BROWSER: '1' }, { SPLIT_PROCESS_REQUIRE_WEB_PRODUCT: '1' }]) {
      const result = runCli(['--case', 'bootstrap.host-runtime-disabled'], dir, env)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /INPUT_UNQUALIFIED/u)
      assert.match(result.stderr, /INPUT_SMOKE_SELECTION_INVALID/u)
      assert.deepEqual(workRootsIn(dir), [], 'a required Browser run must not start a work root')
    }
    // The full-only mutation control is refused the same way, before any scene.
    const mutated = runCli(['--suite', 'bootstrap'], dir, { SPLIT_PROCESS_SMOKE_MUTATION: 'tui-enabled' })
    assert.notEqual(mutated.status, 0)
    assert.match(mutated.stderr, /INPUT_SMOKE_SELECTION_INVALID/u)
    assert.deepEqual(workRootsIn(dir), [], 'the full-only mutation control must not start a work root')
    return
  }
  // Off Linux the SAME selections are refused by the platform pre-check first
  // (both refusals are pre-install input boundaries; either code is honest).
  for (const env of [{ SPLIT_PROCESS_REQUIRE_WEB_BROWSER: '1' }, { SPLIT_PROCESS_REQUIRE_WEB_PRODUCT: '1' }]) {
    const result = runCli(['--case', 'bootstrap.host-runtime-disabled'], dir, env)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /INPUT_UNQUALIFIED/u)
    assert.match(result.stderr, /INPUT_PLATFORM_CASE_UNSUPPORTED/u)
    assert.deepEqual(workRootsIn(dir), [], 'a required Browser run must not start a work root')
  }
  const mutated = runCli(['--suite', 'bootstrap'], dir, { SPLIT_PROCESS_SMOKE_MUTATION: 'tui-enabled' })
  assert.notEqual(mutated.status, 0)
  assert.match(mutated.stderr, /INPUT_PLATFORM_CASE_UNSUPPORTED/u)
  assert.deepEqual(workRootsIn(dir), [], 'the full-only mutation control must not start a work root')
})

test('the selectable registry is the single source for listing, resolution and the run bridge', () => {
  const cases = listSelectableCases()
  assert.ok(Array.isArray(cases) && cases.length > 0, 'the registry must expose at least one case')
  assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length, 'every registered case ID must be unique')
  const subagentSettings = cases.find(entry => entry.id === 'subagent.settings-fr5a')
  assert.ok(subagentSettings, 'FR5-A requires a registered real two-Client qualification')
  assert.equal(subagentSettings.suite, 'subagent-settings')
  assert.equal(typeof subagentSettings.run, 'function')
  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string', 'a registered case must expose a string ID')
    assert.ok(entry.id !== '', 'a registered case ID must be non-empty')
    assert.equal(typeof entry.suite, 'string', `${entry.id} must declare a suite`)
    assert.ok(entry.suite !== '', `${entry.id} must declare a non-empty suite`)
    assert.equal(typeof entry.run, 'function', `${entry.id} must expose a callable run`)
  }
  assert.ok(Object.isFrozen(cases) && cases.every(entry => Object.isFrozen(entry)), 'the registry must stay frozen')

  // Every case resolves to itself, and every live suite resolves to exactly the
  // registry entries that declare it, in registry order. The platform argument
  // pins the audited Linux support the default lane documents.
  for (const entry of cases) {
    assert.deepEqual(resolveSelection({ mode: 'case', id: entry.id }, 'linux').cases, [entry])
  }
  for (const suite of new Set(cases.map(entry => entry.suite))) {
    assert.deepEqual(resolveSelection({ mode: 'suite', suite }, 'linux').cases,
      cases.filter(entry => entry.suite === suite))
  }
  assert.throws(() => resolveSelection({ mode: 'case', id: 'does-not-exist' }, 'linux'),
    error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')
  assert.throws(() => resolveSelection({ mode: 'suite', suite: 'does-not-exist' }, 'linux'),
    error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')

  const first = cases[0]
  assert.deepEqual(parseSelectionArgs([]), { mode: 'full', candidate: undefined })
  assert.deepEqual(parseSelectionArgs(['--', 'candidate.tgz']), { mode: 'full', candidate: 'candidate.tgz' })
  assert.deepEqual(parseSelectionArgs(['--list']), { mode: 'list' })
  assert.deepEqual(parseSelectionArgs(['--case', first.id]), { mode: 'case', id: first.id, candidate: undefined })
  assert.deepEqual(parseSelectionArgs(['--suite', first.suite, 'candidate.tgz']),
    { mode: 'suite', suite: first.suite, candidate: 'candidate.tgz' })
  for (const invalid of [[['--case']], [['--case', 'a', '--suite', 'b']], [['--list', 'x.tgz']], [['--case', 'a', '--case', 'a']]]) {
    assert.throws(() => parseSelectionArgs(invalid[0]), error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')
  }
})

test('selected dispatch fails closed on non-PASS Web and Account verdicts', () => {
  assert.equal(assertSelectedVerdict('account.official-composition', {
    status: 'PASS', browser: 'PASS', verifiedCallback: true, pkce: true,
    initialSignedOutWatch: true, accountRouteChangedFromStub: true,
    hostTaskKnownFalseObserved: true, wrongCodeWithValidPkce: true, missingHostBinding: true,
  }), undefined)
  assert.throws(() => assertSelectedVerdict('account.official-composition', { status: 'PASS', browser: 'NOT_RUN' }),
    /selected account\.official-composition/u)
  assert.equal(assertSelectedVerdict('web.official-composition', { status: 'PASS', browser: 'PASS' }), undefined)
  assert.equal(assertSelectedVerdict('web.runtime-toggle', { status: 'PASS', browser: 'PASS' }), undefined)
  assert.equal(assertSelectedVerdict('web.startup-preference', { verified: true }), undefined)
  assert.equal(assertSelectedVerdict('web.product-browser-tui', { status: 'DEFERRED_WITH_OWNER', browserSubset: 'PASS' }), undefined)
  assert.throws(() => assertSelectedVerdict('web.official-composition', { status: 'PASS', browser: 'NOT_RUN' }),
    /SELECTED_PASS|selected web\.official-composition/u)
  assert.throws(() => assertSelectedVerdict('web.runtime-toggle', { status: 'PASS', browser: 'INCOMPLETE' }),
    /selected web\.runtime-toggle/u)
  assert.throws(() => assertSelectedVerdict('web.product-browser-tui', { status: 'BLOCKED', browserSubset: 'PASS' }),
    /selected web\.product-browser-tui/u)
  assert.throws(() => assertSelectedVerdict('web.product-browser-tui', { status: 'PASS', browserSubset: 'FAIL' }),
    /selected web\.product-browser-tui/u)
  assert.throws(() => assertSelectedVerdict('web.startup-preference', { verified: false }),
    /selected web\.startup-preference/u)
  assert.equal(assertSelectedVerdict('bootstrap.host-runtime-disabled', { exitCode: 1 }), undefined)
  assert.throws(() => assertSelectedVerdict('bootstrap.host-runtime-disabled', { status: 'NOT_RUN' }),
    /selected bootstrap\.host-runtime-disabled/u)
  assert.equal(assertSelectedVerdict('herdr.h3-abrupt-lifecycle', {
    status: 'PASS', rhH3ClientCrash: 'REAL_SPLIT_PROCESS_L6',
    rhH3HostCrash: 'REAL_SPLIT_PROCESS_L6', hostReportedNothing: true,
  }), undefined)
  assert.throws(() => assertSelectedVerdict('herdr.h3-abrupt-lifecycle',
    { status: 'PASS', rhH3ClientCrash: 'REAL_SPLIT_PROCESS_L6', hostReportedNothing: true }),
    /selected herdr\.h3-abrupt-lifecycle/u)
  assert.throws(() => assertSelectedVerdict('herdr.h3-abrupt-lifecycle',
    { status: 'PASS', rhH3ClientCrash: 'REAL_SPLIT_PROCESS_L6', rhH3HostCrash: 'REAL_SPLIT_PROCESS_L6', hostReportedNothing: false }),
    /selected herdr\.h3-abrupt-lifecycle/u)
  assert.throws(() => assertSelectedVerdict('herdr.h3-abrupt-lifecycle',
    { status: 'NOT_VERIFIED', rhH3ClientCrash: 'REAL_SPLIT_PROCESS_L6', rhH3HostCrash: 'REAL_SPLIT_PROCESS_L6', hostReportedNothing: true }),
    /selected herdr\.h3-abrupt-lifecycle/u)
})
test('a managed-host selected case may report an honest NOT_VERIFIED, never SELECTED_PASS', () => {
  assert.equal(assertSelectedVerdict('managed-host.m6-2b-systemd', { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6' }), undefined)
  assert.equal(assertSelectedVerdict('managed-host.m6-2b-fallback', { status: 'NOT_VERIFIED', reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE' }), undefined)
  assert.throws(() => assertSelectedVerdict('managed-host.m6-2b-systemd', { status: 'FAIL' }),
    /selected managed-host\.m6-2b-systemd/u)
  assert.throws(() => assertSelectedVerdict('managed-host.m6-2b-manager-error', { status: 'BLOCKED' }),
    /selected managed-host\.m6-2b-manager-error/u)
})

test('a daemon-control selected case may report an honest NOT_VERIFIED, never SELECTED_PASS', () => {
  assert.equal(assertSelectedVerdict('daemon-control.m6-2c-systemd-lifecycle', { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6' }), undefined)
  assert.equal(assertSelectedVerdict('daemon-control.m6-2c-process-fallback', { status: 'NOT_VERIFIED', reason: 'NOT_AN_ABSENT_MANAGER_ENV' }), undefined)
  assert.throws(() => assertSelectedVerdict('daemon-control.m6-2c-manager-error', { status: 'FAIL' }),
    /selected daemon-control\.m6-2c-manager-error/u)
  assert.throws(() => assertSelectedVerdict('daemon-control.m6-2c-owner-and-multi-profile', { status: 'BLOCKED' }),
    /selected daemon-control\.m6-2c-owner-and-multi-profile/u)
})

test('managed unit cleanup only matches this run\u2019s exact owner metadata and safe file', () => {
  const scopeId = 'a'.repeat(64)
  const buildId = 'b'.repeat(64)
  const hostEntry = '/opt/inst/dist/local-host.mjs'
  const content = [
    'X-DshPiTuiOwner=local-host-manager-v1',
    `X-DshPiTuiScopeId=${scopeId}`,
    `X-DshPiTuiInstallBuild=${buildId}`,
    `ExecStart="/usr/bin/node" "${hostEntry}"`,
  ].join('\n')
  const base = { scopeId, hostEntry, publishedBuildId: buildId }
  assert.equal(unitBelongsToRun(content, base), null)
  assert.equal(unitBelongsToRun(content, { ...base, scopeId: 'c'.repeat(64) }), 'foreign-scope')
  assert.equal(unitBelongsToRun(content.replace('ExecStart=', 'ExecStartPre='), base), null)
  assert.equal(unitBelongsToRun(content, { ...base, publishedBuildId: 'd'.repeat(64) }), 'other-build')
  assert.equal(unitBelongsToRun(content, { ...base, publishedBuildId: undefined }), 'no-published-build')
  assert.equal(unitBelongsToRun(content, { ...base, publishedBuildId: '' }), 'no-published-build')
  assert.equal(unitBelongsToRun(content.replace('local-host-manager-v1', 'someone-else'), base), 'foreign-owner')
  // User links and 0644 files are valid; foreign owners and non-config files are not.
  const uid = 1000
  const safe = { isSymbolicLink: () => false, isFile: () => true, uid, mode: 0o100600 }
  assert.equal(unitFileSafetyError(safe, uid), null)
  assert.equal(unitFileSafetyError({ ...safe, isSymbolicLink: () => true }, uid), null)
  assert.equal(unitFileSafetyError({ ...safe, uid: 2000 }, uid), 'unsafe-file')
  assert.equal(unitFileSafetyError({ ...safe, mode: 0o100644 }, uid), null)
  assert.equal(unitFileSafetyError({ ...safe, isFile: () => false }, uid), 'unsafe-file')

})

test('cleanup actually stops and removes this run\u2019s unit and refuses foreign, unsafe and failed-stop cases', t => {
  const uid = process.getuid?.()
  const mkRun = ({ artifactBuild, contentBuild = artifactBuild, stopStatus = 0, symlink = false, reloadStatus = 0, instanceBuild = () => undefined }) => {
    const root = testLifecycle(t).tempDir('m62b-cleanup-')
    const home = join(root, 'home'); mkdirSync(home, { mode: 0o700 })
    const unitDir = join(home, '.config', 'systemd', 'user'); mkdirSync(unitDir, { recursive: true, mode: 0o700 })
    const profileDir = join(root, 'profile'); mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    // A `%` in the install path proves the encoded-ExecStart match works.
    const profilePackage = join(root, 'pkg%name'); mkdirSync(join(profilePackage, 'dist'), { recursive: true, mode: 0o700 })
    writeFileSync(join(profilePackage, 'dist', 'local-host.mjs'), 'process.exit(0)\n')
    const anchor = join(root, 'anchor.json'); writeFileSync(anchor, JSON.stringify({ version: '0.2.2-rc.3' }))
    const scopeId = createHash('sha256').update(`dsh-pi-tui/local-scope/1\0${uid}\0${realpathSync(profileDir)}`).digest('hex')
    const unit = `dsh-pi-tui@pi-tui-${scopeId.slice(0, 16)}.service`
    const unitPath = join(unitDir, unit)
    const hostEntry = realpathSync(join(profilePackage, 'dist', 'local-host.mjs'))
    const content = ['[Unit]', 'X-DshPiTuiOwner=local-host-manager-v1', `X-DshPiTuiScopeId=${scopeId}`, `X-DshPiTuiInstallBuild=${contentBuild}`, '[Service]', `ExecStart="${process.execPath}" ${encodeUnitValue(hostEntry, 'fixture entry', true)}`].join('\n')
    if (symlink) {
      const target = join(root, 'target')
      writeFileSync(target, content, { mode: 0o600 })
      symlinkSync(target, unitPath)
    } else {
      writeFileSync(unitPath, content, { mode: 0o600 })
    }
    const calls = []
    const fakeRun = args => {
      calls.push(args.join(' '))
      if (args.includes('show')) return { status: 0, stdout: `LoadState=loaded\nActiveState=active\nFragmentPath=${unitPath}\nDropInPaths=\n`, stderr: '' }
      if (args.includes('stop')) return { status: stopStatus, stdout: '', stderr: stopStatus === 0 ? '' : 'stop failed' }
      if (args.includes('daemon-reload')) return { status: reloadStatus, stdout: '', stderr: reloadStatus === 0 ? '' : 'reload failed' }
      return { status: 0, stdout: '', stderr: '' }
    }
    const installation = { profileDir, profilePackage, dshHome: join(root, 'dsh-home'), anchor }
    const result = stopAndRemoveManagedUnit(installation, () => {}, undefined, {
      uid, homeDir: home, systemctl: fakeRun, instanceBuild, artifactBuild: () => artifactBuild,
    })
    return { result, unitPath, calls }
  }
  // Happy AND pre-publish (no Host identity): recognized from the install artifact.
  const ok = mkRun({ artifactBuild: 'b'.repeat(64) })
  assert.equal(ok.result.removed, true)
  assert.equal(existsSync(ok.unitPath), false)
  assert.ok(ok.calls.some(c => c.includes('stop')), 'cleanup must call systemctl stop')
  assert.ok(ok.calls.some(c => c.includes('daemon-reload')), 'cleanup must daemon-reload after unlink')
  // A unit of a different build is left untouched.
  const foreign = mkRun({ artifactBuild: 'b'.repeat(64), contentBuild: 'c'.repeat(64) })
  assert.equal(foreign.result.removed, false)
  assert.equal(existsSync(foreign.unitPath), true)
  // A user configuration link is removed, leaving its source untouched.
  const sym = mkRun({ artifactBuild: 'b'.repeat(64), symlink: true })
  assert.equal(sym.result.removed, true)
  assert.equal(existsSync(sym.unitPath), false)
  // A failed stop never unlinks.
  const failed = mkRun({ artifactBuild: 'b'.repeat(64), stopStatus: 1 })
  assert.equal(failed.result.removed, false)
  assert.equal(existsSync(failed.unitPath), true)
  // No build known at all -> not ours, kept.
  const nobuild = mkRun({ artifactBuild: undefined, contentBuild: 'b'.repeat(64) })
  assert.equal(nobuild.result.removed, false)
  assert.equal(existsSync(nobuild.unitPath), true)
  // An OLD compatible Host's unit (build A) is NOT this candidate's (artifact B):
  // the live identity must never grant ownership; it only cross-checks.
  const stale = mkRun({ artifactBuild: 'b'.repeat(64), contentBuild: 'a'.repeat(64), instanceBuild: () => 'a'.repeat(64) })
  assert.equal(stale.result.removed, false)
  assert.equal(existsSync(stale.unitPath), true)
  // The file was unlinked but the manager reload failed: cleanup is NOT complete.
  const reloadFail = mkRun({ artifactBuild: 'b'.repeat(64), reloadStatus: 1 })
  assert.equal(reloadFail.result.removed, false)
  assert.equal(reloadFail.result.reason, 'reload-failed')
  assert.equal(reloadFail.result.fileRemoved, true)
  assert.equal(existsSync(reloadFail.unitPath), false)
})

test('the B13 crash kill is authorized only for the verified unit MainPID and Host identity', () => {
  const killed = []
  const kill = (pid, signal) => { killed.push([pid, signal]) }
  const base = { targetPid: 42, unitMainPid: 42, hostPids: [42], publishedStarttime: '123', readStarttime: () => '123', kill }
  assert.deepEqual(killVerifiedHost(base), { killed: true })
  assert.deepEqual(killed, [[42, 'SIGKILL']])
  killed.length = 0
  assert.equal(killVerifiedHost({ ...base, unitMainPid: 43 }).killed, false) // not the unit MainPID
  assert.equal(killVerifiedHost({ ...base, hostPids: [99] }).killed, false) // not this scope's Host
  assert.equal(killVerifiedHost({ ...base, readStarttime: () => '999' }).killed, false) // starttime changed
  assert.equal(killVerifiedHost({ ...base, targetPid: 0 }).killed, false) // invalid pid
  assert.equal(killed.length, 0, 'an unverified target must never receive SIGKILL')
})

test('environment-gated native cases are selectable-only, never in the default full lane', () => {
  const all = listSelectableCases()
  const managed = all.filter(entry => entry.suite === 'managed-host')
  assert.ok(managed.length >= 7, 'all managed-host native cases stay registered/selectable')
  // The continuously executed default lane never runs an environment-gated
  // native systemd case.
  assert.deepEqual(listDefaultLaneCases().filter(entry => entry.suite === 'managed-host'), [])
  assert.deepEqual(listDefaultLaneCases().map(entry => entry.id), all.filter(entry => entry.defaultLane !== false).map(entry => entry.id))
  // A selector still resolves them all (the opt-in route).
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'managed-host' }, 'linux').cases, managed)
  for (const id of [
    'managed-host.m6-2b-systemd',
    'managed-host.m6-2b-concurrent-cold-start',
    'managed-host.m6-2b-auth-failure-negative',
    'managed-host.m6-2b-crash-restart',
    'managed-host.m6-2b-two-profile-isolation',
    'managed-host.m6-2b-fallback',
    'managed-host.m6-2b-manager-error',
  ]) {
    assert.ok(all.some(entry => entry.id === id), `${id} must remain selectable`)
  }
})

test('the required daemon-control native cases are selectable-only and resolve through their suite', () => {
  const all = listSelectableCases()
  const controls = all.filter(entry => entry.suite === 'daemon-control')
  for (const id of [
    'daemon-control.m6-2c-status-safety',
    'daemon-control.m6-2c-systemd-lifecycle',
    'daemon-control.m6-2c-process-fallback',
    'daemon-control.m6-2c-manager-error',
    'daemon-control.m6-2c-owner-and-multi-profile',
    'daemon-control.m6-2c-concurrent-controls',
    'daemon-control.m6-2c-inflight-stop',
  ]) {
    assert.ok(controls.some(entry => entry.id === id), `${id} must remain selectable`)
  }
  assert.ok(controls.every(entry => entry.defaultLane === false))
  assert.deepEqual(listDefaultLaneCases().filter(entry => entry.suite === 'daemon-control'), [])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'daemon-control' }, 'linux').cases, controls)
})

test('a cleanup that did not remove this run\u2019s unit fails the scenario verdict', () => {
  assert.equal(cleanupOutcomeError({ removed: true }), undefined)
  assert.equal(cleanupOutcomeError({ removed: false, reason: 'absent' }), undefined)
  for (const reason of ['stop-failed', 'other-build', 'foreign-owner', 'no-artifact-build', 'not-this-install', 'unsafe-file', 'reload-failed']) {
    assert.equal(typeof cleanupOutcomeError({ removed: false, reason }), 'string', `cleanup ${reason} must be a scenario failure`)
  }
  assert.equal(typeof cleanupOutcomeError(undefined), 'string')
})

test('the managed-host native gate requires an attested non-root isolated account, not just HOME', t => {
  const home = testLifecycle(t).tempDir('m62b-gate-')
  const other = testLifecycle(t).tempDir('m62b-gate-other-')
  const base = { isolatedHome: home, optIn: '1', markerExists: true, uid: 1000, accountHome: home }
  assert.equal(managedHostGateReason(base), null)
  // `export ISOLATED_HOME=$HOME` alone is NOT proof of isolation.
  assert.equal(typeof managedHostGateReason({ ...base, optIn: undefined }), 'string')
  assert.equal(typeof managedHostGateReason({ ...base, optIn: '0' }), 'string')
  assert.equal(typeof managedHostGateReason({ ...base, markerExists: false }), 'string')
  assert.equal(typeof managedHostGateReason({ ...base, uid: 0 }), 'string')
  assert.equal(typeof managedHostGateReason({ ...base, accountHome: other }), 'string')
  assert.equal(typeof managedHostGateReason({ ...base, isolatedHome: '' }), 'string')
})

test('the ACP UDS selected verdict accepts only the complete real-L6 proof', () => {
  const complete = {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    acpVersionFromInstalledDsh: true,
    listenBeforeRegistry: true,
    permissions0700And0600: true,
    hostReadyAfterAcp: true,
    independentConnections: true,
    capacityAndBackpressure: true,
    unsupportedSessionMethodsFailClosed: true,
    stoppedAndUnlinked: true,
    staleReclaimedSafely: true,
    noTcpOrStdoutPollution: true,
    originalSplitClientIntact: true,
  }
  assert.equal(assertSelectedVerdict('acp.po1-uds-ready', complete), undefined)
  // A missing proof field is a rejected verdict.
  const missing = { ...complete }
  delete missing.staleReclaimedSafely
  assert.throws(() => assertSelectedVerdict('acp.po1-uds-ready', missing), /selected acp\.po1-uds-ready/u)
  // A proof field that is present but false is a rejected verdict.
  assert.throws(() => assertSelectedVerdict('acp.po1-uds-ready', { ...complete, listenBeforeRegistry: false }),
    /selected acp\.po1-uds-ready/u)
  // A NOT_VERIFIED status never becomes a selected PASS.
  assert.throws(() => assertSelectedVerdict('acp.po1-uds-ready', { ...complete, status: 'NOT_VERIFIED' }),
    /selected acp\.po1-uds-ready/u)
})
test('the ACP opt-in control selected verdict accepts only the complete real-L6 proof', () => {
  const complete = {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    defaultOffNoSocket: true,
    runtimeToggle: true,
    runtimeOffDisconnects: true,
    preferenceDoesNotChangeRuntime: true,
    autoStartBindsBeforeReady: true,
    autoStartFalseNoSocket: true,
    recomposeKeepsSameHost: true,
    originalSplitClientIntact: true,
  }
  assert.equal(assertSelectedVerdict('acp.po1b-opt-in-control', complete), undefined)
  // A missing proof field is a rejected verdict.
  const missing = { ...complete }
  delete missing.recomposeKeepsSameHost
  assert.throws(() => assertSelectedVerdict('acp.po1b-opt-in-control', missing), /selected acp\.po1b-opt-in-control/u)
  // A proof field that is present but false is a rejected verdict.
  assert.throws(() => assertSelectedVerdict('acp.po1b-opt-in-control', { ...complete, runtimeToggle: false }),
    /selected acp\.po1b-opt-in-control/u)
  // A NOT_VERIFIED status never becomes a selected PASS.
  assert.throws(() => assertSelectedVerdict('acp.po1b-opt-in-control', { ...complete, status: 'NOT_VERIFIED' }),
    /selected acp\.po1b-opt-in-control/u)
})
test('the ACP shared Session View selected verdict accepts only the complete real-L6 proof', () => {
  const complete = {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    acpVersionFromInstalledDsh: true,
    socketPermissions0700And0600: true,
    tuiAndAcpShareSession: true,
    secondConnectionConflict: true,
    closeReleasesOnlyView: true,
    tuiTurnAfterClose: true,
    newSessionViaHostWorkspace: true,
    closeKeepsSessionResumable: true,
    coldRestartResume: true,
    disconnectReleasesView: true,
    runtimeToggleDisconnects: true,
    negativesRejected: true,
    hostIdentityKept: true,
    originalSplitClientIntact: true,
    l6EvidenceRecorded: true,
  }
  assert.equal(assertSelectedVerdict('acp.po2-session-view', complete), undefined)
  // A missing proof field is a rejected verdict.
  const missing = { ...complete }
  delete missing.tuiTurnAfterClose
  assert.throws(() => assertSelectedVerdict('acp.po2-session-view', missing), /selected acp\.po2-session-view/u)
  // A proof field that is present but false is a rejected verdict.
  assert.throws(() => assertSelectedVerdict('acp.po2-session-view', { ...complete, secondConnectionConflict: false }),
    /selected acp\.po2-session-view/u)
  // A NOT_VERIFIED status never becomes a selected PASS.
  assert.throws(() => assertSelectedVerdict('acp.po2-session-view', { ...complete, status: 'NOT_VERIFIED' }),
    /selected acp\.po2-session-view/u)
})
test('the ACP prompt/turn/event selected verdict accepts only the complete real-L6 proof', () => {
  const complete = {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    acpVersionFromInstalledDsh: true,
    tuiAndAcpShareSession: true,
    promptAcceptedWhileRunning: true,
    ackIsNotCompletion: true,
    acpOnlyOutput: true,
    exactTurnCorrelation: true,
    updatesBeforeStopReason: true,
    tuiAfterPromptHistory: true,
    mixedTurnFailClosed: true,
    twoViewIsolation: true,
    disconnectKeepsHostTurn: true,
    staleGenerationNotReplayed: true,
    outputBackpressureIsolated: true,
    sameConnectionAfterFailure: true,
    hostIdentityKept: true,
    originalSplitClientIntact: true,
    l6EvidenceRecorded: true,
  }
  assert.equal(assertSelectedVerdict('acp.po3a-turn-events', complete), undefined)
  // A missing proof field is a rejected verdict.
  const missing = { ...complete }
  delete missing.mixedTurnFailClosed
  assert.throws(() => assertSelectedVerdict('acp.po3a-turn-events', missing), /selected acp\.po3a-turn-events/u)
  // A proof field that is present but false is a rejected verdict.
  assert.throws(() => assertSelectedVerdict('acp.po3a-turn-events', { ...complete, acpOnlyOutput: false }),
    /selected acp\.po3a-turn-events/u)
  // A NOT_VERIFIED status never becomes a selected PASS.
  assert.throws(() => assertSelectedVerdict('acp.po3a-turn-events', { ...complete, status: 'NOT_VERIFIED' }),
    /selected acp\.po3a-turn-events/u)
})

test('the ACP PO-3B scoped-cancel/approval selected verdict accepts only the complete real-L6 proof', () => {
  const complete = {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    acpVersionFromInstalledDsh: true,
    queuedCancelRemoved: true,
    runningCancelExactTurn: true,
    idleCancelNoOp: true,
    claimRaceSafe: true,
    cancelDrainBeforeStop: true,
    closeDrainedAndDetached: true,
    acpApprovalOnly: true,
    tuiApprovalOnly: true,
    policyNeverUnbypassed: true,
    lateApprovalNoLeak: true,
    twoViewsIsolated: true,
    queueRemoveSettled: true,
    steerMixedOwnership: true,
    queueEditRetained: true,
    tuiAndAcpShareSession: true,
    hostIdentityKept: true,
    l6EvidenceRecorded: true,
  }
  assert.equal(assertSelectedVerdict('acp.po3b-cancel-approval', complete), undefined)
  // A missing proof field is a rejected verdict.
  const missing = { ...complete }
  delete missing.runningCancelExactTurn
  assert.throws(() => assertSelectedVerdict('acp.po3b-cancel-approval', missing), /selected acp\.po3b-cancel-approval/u)
  // The queue-mutation proofs are required, not optional evidence.
  const missingQueue = { ...complete }
  delete missingQueue.queueRemoveSettled
  assert.throws(() => assertSelectedVerdict('acp.po3b-cancel-approval', missingQueue), /selected acp\.po3b-cancel-approval/u)
  const missingEdit = { ...complete }
  delete missingEdit.queueEditRetained
  assert.throws(() => assertSelectedVerdict('acp.po3b-cancel-approval', missingEdit), /selected acp\.po3b-cancel-approval/u)
  // A proof field that is present but false is a rejected verdict.
  assert.throws(() => assertSelectedVerdict('acp.po3b-cancel-approval', { ...complete, acpApprovalOnly: false }),
    /selected acp\.po3b-cancel-approval/u)
  // A NOT_VERIFIED status never becomes a selected PASS.
  assert.throws(() => assertSelectedVerdict('acp.po3b-cancel-approval', { ...complete, status: 'NOT_VERIFIED' }),
    /selected acp\.po3b-cancel-approval/u)
  // The new case is registered in the selectable registry (wired, not a stub).
  const registered = listSelectableCases().find(entry => entry.id === 'acp.po3b-cancel-approval')
  assert.ok(registered, 'the PO-3B case must be registered in the selectable registry')
  assert.equal(typeof registered.run, 'function', 'the registered case must carry its real runner')
})
test('the ACP PO-4A content-input selected verdict requires the complete real-L6 wire and Host evidence', () => {
  const complete = {
    status: 'PASS', scope: 'REAL_SPLIT_PROCESS_L6', imageCapabilityAdvertised: true,
    resourceLinkAdmittedAsText: true, imageOnlyAdmitted: true, mixedContentOrderPreserved: true,
    largeImageFrameOverOneMiB: true, hostRejectedInvalidAndOverLimit: true,
    imageCancelScopedToOwnAdmission: true, tuiRemainsActive: true, perSessionViewIsolation: true,
    sameSessionReattach: true, hostIdentityKept: true, readImageVerified: true, l6EvidenceRecorded: true,
    po4bMarkdownExact: true, po4bHostFileReadable: true, po4bHostPermissionDenied: true,
    po4bClientLocalityMeasured: true, po4bNoImplicitArtifact: true,
    evidence: {
      largeFrameBytes: 1_200_000,
      hostPid: 4242,
      hostInstanceId: 'host-instance',
      sessionId: 'S-1',
      imageProbes: [{ success: true }, { success: true }, { success: true }],
      po4b: {
        sessionId: 'S-1',
        turn: 7,
        assistantMessageId: 'm-po4b',
        hostPid: 4242,
        hostInstanceId: 'host-instance',
        blockSha256: ['a'.repeat(64), 'b'.repeat(64)],
        hostReportSha256: 'c'.repeat(64),
        hostMissing: 'ENOENT',
        hostUnreadable: 'EACCES',
      },
    },
  }
  assert.equal(assertSelectedVerdict('acp.po4a-content-input', complete), undefined)
  assert.throws(() => assertSelectedVerdict('acp.po4a-content-input', { ...complete, readImageVerified: false }),
    /selected acp\.po4a-content-input/u)
  assert.throws(() => assertSelectedVerdict('acp.po4a-content-input', {
    ...complete, evidence: { ...complete.evidence, largeFrameBytes: 1024 * 1024 },
  }), /selected acp\.po4a-content-input/u)
  // The PO-4B qualification facts are mandatory and cannot be inferred from
  // `status: PASS`: the Markdown fidelity and the Host file/permission facts
  // are each independently required.
  const missingMarkdown = { ...complete }
  delete missingMarkdown.po4bMarkdownExact
  assert.throws(() => assertSelectedVerdict('acp.po4a-content-input', missingMarkdown),
    /selected acp\.po4a-content-input/u)
  assert.throws(() => assertSelectedVerdict('acp.po4a-content-input', { ...complete, po4bHostPermissionDenied: false }),
    /selected acp\.po4a-content-input/u)
  assert.throws(() => assertSelectedVerdict('acp.po4a-content-input', {
    ...complete, evidence: { ...complete.evidence, po4b: { ...complete.evidence.po4b, hostReportSha256: 'not-a-digest' } },
  }), /selected acp\.po4a-content-input/u)
  const entry = listSelectableCases().find(item => item.id === 'acp.po4a-content-input')
  assert.ok(entry && entry.defaultLane === false, 'PO-4A remains selectable-only, not part of the default L6 lane')
  assert.equal(typeof entry.run, 'function')
})

test('the ACP PO-4C committed content-output selected verdict requires the complete real-L6 wire and Host evidence', () => {
  const complete = {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    assistantTextImageTextOrdered: true,
    assistantImageOnlyAccepted: true,
    toolResultOrderedContent: true,
    toolFailedStatus: true,
    missingImageRejected: true,
    largeImageFrameAboveLegacyCap: true,
    capacityPositive: true,
    capacityNegative: true,
    memoryMeasured: true,
    slowPeerIsolated: true,
    siblingAcpAndTuiUnaffected: true,
    reattachAfterFailureClean: true,
    lateReadAfterCloseInert: true,
    noForeignTurnProjected: true,
    hostIdentityKept: true,
    readImageVerified: true,
    l6EvidenceRecorded: true,
    evidence: {
      hostPid: 4242,
      hostInstanceId: 'host-instance-po4c',
      sessionId: 'S-po4c',
      assistant: {
        turn: 11,
        messageId: 'm-po4c',
        attachmentId: `sha256:${'a'.repeat(64)}`,
        storedBytes: 1_400_000,
        wireFrameBytes: 1_900_000,
        legacyFrameBytes: 256 * 1024,
        blockSha256: ['b'.repeat(64), 'c'.repeat(64)],
      },
      tool: {
        turn: 12,
        callId: 'po4c-tool-ok',
        resultAttachmentId: `sha256:${'d'.repeat(64)}`,
        resultStoredBytes: 12_000,
        a2uiSha256: 'e'.repeat(64),
      },
      failedTool: { turn: 13, callId: 'po4c-tool-failed', isError: true },
      missingImage: { turn: 14, attachmentId: `sha256:${'f'.repeat(64)}`, hostCode: 'ATTACHMENT_NOT_FOUND', acpCode: 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED' },
      capacity: {
        maxImageBytes: 4194304,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 524288,
        storedBytes: 3550000,
        base64Bytes: 4733336,
        deliveredFrameBytes: 4733610,
        derivedBudget: 6710616,
        positive: true,
      },
      boundedTransport: {
        overBudgetCode: 'LOCAL_ACP_OUTPUT_FRAME_TOO_LARGE',
        overBudgetImageCount: 2,
        overBudgetStoredBytes: [3550000, 3550000],
        noContentOrStopReason: true,
        siblingAfterOverflow: true,
        tuiAlive: true,
      },
      memory: {
        hostPid: 4242,
        rssBaselineBytes: 200000000,
        rssPeakBytes: 260000000,
        rssDeltaBytes: 60000000,
        storedBytes: 3550000,
        base64Bytes: 4733336,
        sdkFrameBytes: 1_900_000,
        writerBacklogBoundBytes: 262144,
        sdkMaterializesWholeFrame: true,
      },
      slowPeer: {
        backpressureCode: 'LOCAL_ACP_OUTPUT_BACKPRESSURE',
        siblingSessionId: 'S-sibling',
        tuiTurn: 15,
        reattachAttempts: 2,
        lateRead: {
          attachmentId: `sha256:${'a'.repeat(64)}`,
          hostCloseConnections: 2,
          claimHeldBeforeRelease: true,
          releasedAfterDisconnect: true,
          lateAttempts: 1,
        },
      },
      imageProbes: [{ kind: 'po4c-image-stored' }, { kind: 'po4c-image-stored' }],
    },
  }
  assert.equal(assertSelectedVerdict('acp.po4c-content-output', complete), undefined)
  // A missing proof field is a rejected verdict: the selected PASS cannot be
  // assembled from `status: 'PASS'` alone.
  for (const field of [
    'assistantTextImageTextOrdered', 'assistantImageOnlyAccepted', 'toolResultOrderedContent',
    'toolFailedStatus', 'missingImageRejected', 'largeImageFrameAboveLegacyCap', 'slowPeerIsolated',
    'siblingAcpAndTuiUnaffected', 'reattachAfterFailureClean', 'lateReadAfterCloseInert', 'noForeignTurnProjected',
    'readImageVerified', 'capacityPositive', 'capacityNegative', 'memoryMeasured',
  ]) {
    const missing = { ...complete }
    delete missing[field]
    assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', missing), /selected acp\.po4c-content-output/u)
  }
  // A present-but-false proof field is rejected.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', { ...complete, slowPeerIsolated: false }),
    /selected acp\.po4c-content-output/u)
  // A frame at (not above) the legacy cap never proves the new transport path.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, assistant: { ...complete.evidence.assistant, wireFrameBytes: 256 * 1024 } },
  }), /selected acp\.po4c-content-output/u)
  // The Host Store's own rejection code is required, not merely an ACP error.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, missingImage: { ...complete.evidence.missingImage, hostCode: 'READ_OK' } },
  }), /selected acp\.po4c-content-output/u)
  // The slow-reader and the sibling session must be the real distinct facts.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, slowPeer: { ...complete.evidence.slowPeer, siblingSessionId: 'S-po4c' } },
  }), /selected acp\.po4c-content-output/u)
  // The late Store read must be proven to have completed AFTER the Host
  // processed the disconnect AND while the dead connection still held the
  // Session claim.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, slowPeer: { ...complete.evidence.slowPeer, lateRead: { ...complete.evidence.slowPeer.lateRead, releasedAfterDisconnect: false } } },
  }), /selected acp\.po4c-content-output/u)
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, slowPeer: { ...complete.evidence.slowPeer, lateRead: { ...complete.evidence.slowPeer.lateRead, claimHeldBeforeRelease: false } } },
  }), /selected acp\.po4c-content-output/u)
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, slowPeer: { ...complete.evidence.slowPeer, lateRead: { ...complete.evidence.slowPeer.lateRead, hostCloseConnections: 0 } } },
  }), /selected acp\.po4c-content-output/u)
  // F1 (Owner amendment A1): the capacity positive/negative and the real RSS
  // measurement are required facts, not inferred from PASS.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', { ...complete, capacityNegative: false }),
    /selected acp\.po4c-content-output/u)
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, capacity: { ...complete.evidence.capacity, maxImageBytes: 524288 } },
  }), /selected acp\.po4c-content-output/u)
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, boundedTransport: { ...complete.evidence.boundedTransport, overBudgetCode: 'LOCAL_ACP_OUTPUT_BACKPRESSURE' } },
  }), /selected acp\.po4c-content-output/u)
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', {
    ...complete, evidence: { ...complete.evidence, memory: { ...complete.evidence.memory, rssPeakBytes: 1 } },
  }), /selected acp\.po4c-content-output/u)
  // A NOT_VERIFIED status never becomes a selected PASS.
  assert.throws(() => assertSelectedVerdict('acp.po4c-content-output', { ...complete, status: 'NOT_VERIFIED' }),
    /selected acp\.po4c-content-output/u)
  // The case is registered as a real selectable-only runner.
  const entry = listSelectableCases().find(item => item.id === 'acp.po4c-content-output')
  assert.ok(entry && entry.defaultLane === false, 'PO-4C stays selectable-only, not part of the default L6 lane')
  assert.equal(typeof entry.run, 'function')
})

// ── The independent standard ACP SDK client case ────────────────────────────

const SDK_INTEROP_CASE_ID = 'acp.sdk-content-interoperability'
const SDK_INTEROP_OUTCOMES = Object.freeze([
  'officialSdkClient',
  'inputResourceLinkExact',
  'inputImageStoredVerified',
  'inputLargeImageViaSdk',
  'markdownBlocksExact',
  'workspaceLocalityProven',
  'negativeAdmissionNoHostMessage',
  'assistantBlocksOrdered',
  'outputImageVerified',
  'imageOnlyAccepted',
  'toolResultOrdered',
  'toolFailedStatusVerified',
  'missingStoreObjectFailedClosed',
  'healthyAfterFailure',
  'tuiHostSurvivedClientClose',
])
const SDK_INTEROP_INPUT_EVIDENCE = Object.freeze([
  'hostPid', 'hostInstanceId', 'sessionId', 'imageAttachmentId', 'imageSha256',
  'largeImageBytes', 'resourceLinkTurn', 'imageTurn', 'markdownTurn',
  'markdownMessageId', 'hostReportSha256', 'missingPathErrno', 'unreadablePathErrno',
  'negativeRejectedBeforeMessage',
])
const SDK_INTEROP_OUTPUT_EVIDENCE = Object.freeze([
  'hostPid', 'hostInstanceId', 'sessionId', 'assistantTurn', 'assistantMessageId',
  'assistantAttachmentId', 'assistantImageSha256', 'assistantImageBytes',
  'imageOnlyTurn', 'toolTurn', 'toolCallId', 'toolAttachmentId', 'toolStatus',
  'failedToolTurn', 'failedToolCallId', 'failedStatus', 'missingObjectCode',
  'acpErrorCode', 'healthyTurn', 'hostIdentityKept',
])

/** One complete minimum-schema result, built fresh for every mutation. */
function sdkInteropVerdict() {
  const inputImage = 'a'.repeat(64)
  const outputImage = 'c'.repeat(64)
  return {
    status: 'PASS',
    scope: 'REAL_SPLIT_PROCESS_L6',
    officialSdkClient: true,
    inputResourceLinkExact: true,
    inputImageStoredVerified: true,
    inputLargeImageViaSdk: true,
    markdownBlocksExact: true,
    workspaceLocalityProven: true,
    negativeAdmissionNoHostMessage: true,
    assistantBlocksOrdered: true,
    outputImageVerified: true,
    imageOnlyAccepted: true,
    toolResultOrdered: true,
    toolFailedStatusVerified: true,
    missingStoreObjectFailedClosed: true,
    healthyAfterFailure: true,
    tuiHostSurvivedClientClose: true,
    evidence: {
      candidateSha256: '1'.repeat(64),
      sdkVersion: '1.4.0',
      protocolVersion: 1,
      input: {
        hostPid: 4242,
        hostInstanceId: 'input-host-instance',
        sessionId: 'input-session',
        imageAttachmentId: `sha256:${inputImage}`,
        imageSha256: inputImage,
        largeImageBytes: 1024 * 1024 + 1,
        resourceLinkTurn: 3,
        imageTurn: 4,
        markdownTurn: 6,
        markdownMessageId: 'markdown-message',
        hostReportSha256: 'b'.repeat(64),
        missingPathErrno: 'ENOENT',
        unreadablePathErrno: 'EACCES',
        negativeRejectedBeforeMessage: true,
      },
      output: {
        hostPid: 5252,
        hostInstanceId: 'output-host-instance',
        sessionId: 'output-session',
        assistantTurn: 9,
        assistantMessageId: 'assistant-message',
        assistantAttachmentId: `sha256:${outputImage}`,
        assistantImageSha256: outputImage,
        assistantImageBytes: 1_400_000,
        imageOnlyTurn: 10,
        toolTurn: 11,
        toolCallId: 'tool-call',
        toolAttachmentId: `sha256:${'d'.repeat(64)}`,
        toolStatus: 'completed',
        failedToolTurn: 12,
        failedToolCallId: 'tool-call-failed',
        failedStatus: 'failed',
        missingObjectCode: 'ATTACHMENT_NOT_FOUND',
        acpErrorCode: 'LOCAL_ACP_PROMPT_ATTACHMENT_READ_FAILED',
        healthyTurn: 13,
        hostIdentityKept: true,
      },
    },
  }
}

function sdkInteropVariant(mutate) {
  const result = sdkInteropVerdict()
  mutate(result)
  return result
}

function assertSdkInteropRejected(mutate) {
  assert.throws(() => assertSelectedVerdict(SDK_INTEROP_CASE_ID, sdkInteropVariant(mutate)),
    /selected acp\.sdk-content-interoperability/u)
}

test('the ACP SDK content-interoperability verdict rejects every unproved outcome', () => {
  assert.equal(assertSelectedVerdict(SDK_INTEROP_CASE_ID, sdkInteropVerdict()), undefined)
  for (const field of SDK_INTEROP_OUTCOMES) {
    assertSdkInteropRejected(result => { delete result[field] })
    assertSdkInteropRejected(result => { result[field] = false })
  }
  assertSdkInteropRejected(result => { delete result.status })
  assertSdkInteropRejected(result => { result.status = 'NOT_VERIFIED' })
  assertSdkInteropRejected(result => { result.status = 'FAIL' })
  assertSdkInteropRejected(result => { delete result.scope })
  assertSdkInteropRejected(result => { result.scope = 'SELECTABLE_ONLY' })
  assertSdkInteropRejected(result => { delete result.evidence })
  assertSdkInteropRejected(result => { result.evidence = null })
  assertSdkInteropRejected(result => { result.evidence = 'evidence' })
})

test('the ACP SDK content-interoperability verdict requires both scenes\' Host and Session attribution', () => {
  for (const field of SDK_INTEROP_INPUT_EVIDENCE) {
    assertSdkInteropRejected(result => { delete result.evidence.input[field] })
  }
  for (const field of SDK_INTEROP_OUTPUT_EVIDENCE) {
    assertSdkInteropRejected(result => { delete result.evidence.output[field] })
  }
  for (const scene of ['input', 'output']) {
    for (const value of [0, -1, 1.5, '4242']) {
      assertSdkInteropRejected(result => { result.evidence[scene].hostPid = value })
    }
    for (const field of ['hostInstanceId', 'sessionId']) {
      for (const value of ['', 42, undefined]) {
        assertSdkInteropRejected(result => { result.evidence[scene][field] = value })
      }
    }
  }
  // Two scenes must prove two Host instances and two Sessions: a duplicated
  // instance or Session means the second scene was never a separate Host.
  assertSdkInteropRejected(result => {
    result.evidence.output.hostInstanceId = result.evidence.input.hostInstanceId
  })
  assertSdkInteropRejected(result => {
    result.evidence.output.sessionId = result.evidence.input.sessionId
  })
  // Kernel PIDs may legitimately be reused across sequential scenes: equal
  // Host PIDs alone are not a reason to reject the two distinct instances.
  assert.equal(assertSelectedVerdict(SDK_INTEROP_CASE_ID, sdkInteropVariant(result => {
    result.evidence.input.hostPid = 7777
    result.evidence.output.hostPid = 7777
  })), undefined)
})

test('the ACP SDK content-interoperability verdict requires the pinned protocol, exact codes and digest-shaped refs', () => {
  for (const value of ['1.3.0', '1.4', 1.4, undefined]) {
    assertSdkInteropRejected(result => { result.evidence.sdkVersion = value })
  }
  for (const value of [0, 2, '1', undefined]) {
    assertSdkInteropRejected(result => { result.evidence.protocolVersion = value })
  }
  for (const value of ['A'.repeat(64), '1'.repeat(63), 'not-a-sha256', 42, undefined]) {
    assertSdkInteropRejected(result => { result.evidence.candidateSha256 = value })
  }
  // A durable attachment ref is the standard `sha256:<digest>` shape and must
  // name the same digest as the separately reported image hash.
  for (const value of ['a'.repeat(64), `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, 'sha256:', 42]) {
    assertSdkInteropRejected(result => { result.evidence.input.imageAttachmentId = value })
    assertSdkInteropRejected(result => { result.evidence.output.assistantAttachmentId = value })
    assertSdkInteropRejected(result => { result.evidence.output.toolAttachmentId = value })
  }
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'not-a-sha256', undefined]) {
    assertSdkInteropRejected(result => { result.evidence.input.imageSha256 = value })
    assertSdkInteropRejected(result => { result.evidence.output.assistantImageSha256 = value })
    assertSdkInteropRejected(result => { result.evidence.input.hostReportSha256 = value })
  }
  assertSdkInteropRejected(result => {
    result.evidence.input.imageSha256 = 'e'.repeat(64)
  })
  assertSdkInteropRejected(result => {
    result.evidence.output.assistantImageSha256 = 'e'.repeat(64)
  })
  // The native SDK input must actually carry a source image above 1 MiB, and
  // the decoded output image must have real bytes.
  for (const value of [1024 * 1024, 0, 1.5, undefined]) {
    assertSdkInteropRejected(result => { result.evidence.input.largeImageBytes = value })
  }
  for (const value of [0, -1, 1.5, undefined]) {
    assertSdkInteropRejected(result => { result.evidence.output.assistantImageBytes = value })
  }
  for (const field of ['resourceLinkTurn', 'imageTurn', 'markdownTurn']) {
    for (const value of [-1, 1.5, '3', undefined]) {
      assertSdkInteropRejected(result => { result.evidence.input[field] = value })
    }
  }
  for (const field of ['assistantTurn', 'imageOnlyTurn', 'toolTurn', 'failedToolTurn', 'healthyTurn']) {
    for (const value of [-1, 1.5, '9', undefined]) {
      assertSdkInteropRejected(result => { result.evidence.output[field] = value })
    }
  }
  for (const [scene, field] of [
    ['input', 'markdownMessageId'],
    ['output', 'assistantMessageId'],
    ['output', 'toolCallId'],
    ['output', 'failedToolCallId'],
  ]) {
    assertSdkInteropRejected(result => { result.evidence[scene][field] = '' })
  }
  // The Host codes, the standard status projection and the surviving Host
  // identity are each required, never inferred from a PASS status.
  assertSdkInteropRejected(result => { result.evidence.input.missingPathErrno = 'EACCES' })
  assertSdkInteropRejected(result => { result.evidence.input.unreadablePathErrno = 'ENOENT' })
  assertSdkInteropRejected(result => { result.evidence.input.negativeRejectedBeforeMessage = false })
  assertSdkInteropRejected(result => { result.evidence.output.toolStatus = 'failed' })
  assertSdkInteropRejected(result => { result.evidence.output.failedStatus = 'completed' })
  assertSdkInteropRejected(result => { result.evidence.output.missingObjectCode = 'ATTACHMENT_MISSING' })
  assertSdkInteropRejected(result => {
    result.evidence.output.acpErrorCode = 'LOCAL_ACP_PROMPT_HOST_REJECTED'
  })
  assertSdkInteropRejected(result => { result.evidence.output.hostIdentityKept = false })
})

test('the independent ACP SDK case is registered once as selectable-only and stays out of the default lane', () => {
  const registered = listSelectableCases().filter(entry => entry.id === SDK_INTEROP_CASE_ID)
  assert.equal(registered.length, 1, 'the independent SDK case must be registered exactly once')
  const [entry] = registered
  assert.equal(entry.suite, 'acp')
  assert.equal(entry.defaultLane, false)
  assert.equal(typeof entry.run, 'function')
  assert.equal(typeof entry.title, 'string')
  assert.ok(entry.title.length > 0)
  assert.equal(listDefaultLaneCases().some(item => item.id === SDK_INTEROP_CASE_ID), false,
    'the default lane must not run the independent SDK case')
  assert.deepEqual(listDefaultLaneCases(), listSelectableCases().filter(item => item.defaultLane !== false))
  assert.deepEqual(resolveSelection({ mode: 'case', id: SDK_INTEROP_CASE_ID }, 'linux').cases, [entry])
  assert.ok(resolveSelection({ mode: 'suite', suite: 'acp' }, 'linux').cases.includes(entry))
})

test('a selected result names the selectable scope AND the platform it qualified', () => {
  const first = listSelectableCases()[0]
  assert.ok(first, 'the registry must expose a case')
  // The historical prefix/id/scope stay byte-identical for existing consumers;
  // the platform fact is what says which executable support range was proved.
  assert.equal(selectedPassLine(first.id, 'linux'),
    `SPLIT_PROCESS_SELECTED_PASS id=${first.id} scope=SELECTABLE_ONLY platform=linux`)
  assert.equal(selectedPassLine(first.id, 'darwin'),
    `SPLIT_PROCESS_SELECTED_PASS id=${first.id} scope=SELECTABLE_ONLY platform=darwin`)
  assert.equal(selectedNotVerifiedLine(first.id, 'darwin', 'BROWSER_MISSING'),
    `SPLIT_PROCESS_SELECTED_NOT_VERIFIED id=${first.id} scope=SELECTABLE_ONLY platform=darwin reason=BROWSER_MISSING`)
})

test('an SDK scene failure keeps its real assertion class, message, stack and cleanup facts', () => {
  // The failure path attempts every owned teardown and then reports the ORIGINAL
  // failure. Wrapping it (for example in AggregateError) would reclassify a
  // qualification assertion as INFRA_FAILURE and drop the real message/stack
  // from the default one-shot report.
  const primary = new SplitSmokeAssertionError('the exact Host turn was not correlated')
  const cleanup = new Error('peer shutdown failed')
  let caught
  try {
    throwSceneFailure('input', primary, [cleanup])
  } catch (error) {
    caught = error
  }
  assert.equal(caught, primary)
  assert.equal(failureCategoryOf(caught), 'ASSERTION_FAILED')
  assert.match(caught.message, /the exact Host turn was not correlated/u)
  assert.equal(caught.stack, primary.stack)
  assert.deepEqual(caught.sceneCleanupFailures, [cleanup])
  // A clean scene returns; a cleanup-only failure still throws its real error.
  assert.equal(throwSceneFailure('output', undefined, []), undefined)
  let cleanupFailure
  try {
    throwSceneFailure('output', undefined, [cleanup])
  } catch (error) {
    cleanupFailure = error
  }
  assert.equal(cleanupFailure, cleanup)
  assert.equal(failureCategoryOf(cleanupFailure), 'INFRA_FAILURE')
})

test('the independent SDK case owns a workspace a sibling Markdown probe cannot poison', (t) => {
  // A full `--suite acp` shares ONE lane work dir. The existing PO-4A Markdown
  // probe leaves `workDir/.po4b/private.md` mode 000, and a later fixture write
  // to that existing path would keep the old mode and fail. The SDK case must
  // therefore use its own Host workspace instead of the shared root or another
  // case's leftovers.
  const root = testLifecycle(t).tempDir('sdk-workspace-isolation-')
  const poisonedRoot = join(root, '.po4b')
  mkdirSync(poisonedRoot, { recursive: true, mode: 0o700 })
  const poisoned = join(poisonedRoot, 'private.md')
  writeFileSync(poisoned, 'sibling-private', { mode: 0o600 })
  chmodSync(poisoned, 0o000)
  const workspace = sceneWorkspace({ workDir: root }, 'input')
  const resolvedRoot = realpathSync(root)
  assert.notEqual(workspace, resolvedRoot, 'the SDK Host workspace is not the shared lane root')
  assert.ok(workspace.startsWith(`${resolvedRoot}${sep}`), 'the SDK workspace lives under this run\'s work root')
  const ownProbe = join(workspace, '.po4b')
  mkdirSync(ownProbe, { mode: 0o700 })
  writeFileSync(join(ownProbe, 'private.md'), 'own-report', { mode: 0o600 })
  assert.equal(readFileSync(join(ownProbe, 'private.md'), 'utf8'), 'own-report')
  assert.equal(statSync(poisoned).mode & 0o777, 0, 'the sibling probe file keeps its unwritable mode')
  chmodSync(poisoned, 0o600)
  assert.equal(readFileSync(poisoned, 'utf8'), 'sibling-private', 'the sibling workspace is neither reused nor rewritten')
})
