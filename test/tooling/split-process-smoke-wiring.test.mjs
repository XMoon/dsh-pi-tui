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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { assertSelectedVerdict, runSelectedCase, waitForCondition } from '../../scripts/split-process-smoke.mjs'
import { PR_A_WEB_ROWS, raceWithAbortableDeadline, redactWebQualificationText } from '../../scripts/smoke/split-process/web-helpers.mjs'
import { createSmokeDiagnostics, redactErrorForStep } from '../../scripts/lib/split-smoke-diagnostics.mjs'
import { statusMatches } from '../../scripts/lib/split-smoke-processes.mjs'
import {
  listSelectableCases,
  parseSelectionArgs,
  resolveSelection,
  selectedPassLine,
} from '../../scripts/lib/split-smoke-selection.mjs'
import { HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import { encodeUnitValue } from '../../src/app/remote-process/local-host-manager.ts'
import { encodeExecArg, stopAndRemoveManagedUnit, unitBelongsToRun, unitFileSafetyError } from '../../scripts/smoke/split-process/managed-host-m6-2b.mjs'

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
  assert.equal(failureMirrors.length, 5, 'every full/selected/input failure boundary mirrors the safe CI report')
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
  // The mandatory Client dependency closure of the shipped official UIs, the
  // official file-actions / message-quotes / changed-files capability rows and
  // the deleted official label are stated independently here: the oracle may
  // not silently keep a dead package or drop a required row. The SET is the
  // contract, never a historical row count.
  for (const id of ['ui-context-menu', 'ui-file-drag', 'ui-file-actions', 'message-quotes', 'workspace-changes', 'ui-deliverables']) {
    assert.equal(ids.includes(id), true, `the frozen roster must include the official "${id}" row`)
  }
  assert.equal(ids.includes('ui-deepseek-model-label-1017'), false,
    'the deleted official label may not return to the frozen roster')
  const overlay = parseYaml(HOST_ONLY_PATCH)
  const inserts = overlay.filter(entry => Array.isArray(entry.insert))
  const declared = inserts.map(entry => entry.insert)
    .find(rows => rows.some(row => row.id === ids[0]))
  assert.ok(declared, 'the Host-only overlay must declare the exported Web roster')
  assert.deepEqual(declared.map(row => row.id), ids, 'the overlay Web ids drifted from the frozen roster')
  assert.deepEqual(declared.map(row => row.name), PR_A_WEB_ROWS.map(row => row.name),
    'the overlay Web packages drifted from the frozen roster')
  assert.ok(declared.every(row => row.disabled === true), 'every Web row stays disabled by default')
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
    ...listSelectableCases().map(entry => `suite=${entry.suite} case=${entry.id} title=${entry.title}`),
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
})

test('the selectable registry is the single source for listing, resolution and the run bridge', () => {
  const cases = listSelectableCases()
  assert.ok(Array.isArray(cases) && cases.length > 0, 'the registry must expose at least one case')
  assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length, 'every registered case ID must be unique')
  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string', 'a registered case must expose a string ID')
    assert.ok(entry.id !== '', 'a registered case ID must be non-empty')
    assert.equal(typeof entry.suite, 'string', `${entry.id} must declare a suite`)
    assert.ok(entry.suite !== '', `${entry.id} must declare a non-empty suite`)
    assert.equal(typeof entry.run, 'function', `${entry.id} must expose a callable run`)
  }
  assert.ok(Object.isFrozen(cases) && cases.every(entry => Object.isFrozen(entry)), 'the registry must stay frozen')

  // Every case resolves to itself, and every live suite resolves to exactly the
  // registry entries that declare it, in registry order.
  for (const entry of cases) {
    assert.deepEqual(resolveSelection({ mode: 'case', id: entry.id }).cases, [entry])
  }
  for (const suite of new Set(cases.map(entry => entry.suite))) {
    assert.deepEqual(resolveSelection({ mode: 'suite', suite }).cases,
      cases.filter(entry => entry.suite === suite))
  }
  assert.throws(() => resolveSelection({ mode: 'case', id: 'does-not-exist' }),
    error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')
  assert.throws(() => resolveSelection({ mode: 'suite', suite: 'does-not-exist' }),
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
  assert.equal(unitBelongsToRun(content, { ...base, hostEntry: '/other/inst/dist/local-host.mjs' }), 'other-install')
  assert.equal(unitBelongsToRun(content, { ...base, publishedBuildId: 'd'.repeat(64) }), 'other-build')
  assert.equal(unitBelongsToRun(content, { ...base, publishedBuildId: undefined }), 'no-published-build')
  assert.equal(unitBelongsToRun(content, { ...base, publishedBuildId: '' }), 'no-published-build')
  assert.equal(unitBelongsToRun(content.replace('local-host-manager-v1', 'someone-else'), base), 'foreign-owner')
  // An unsafe cleanup target (symlink / wrong owner / wrong mode / non-file) is refused.
  const uid = 1000
  const safe = { isSymbolicLink: () => false, isFile: () => true, uid, mode: 0o100600 }
  assert.equal(unitFileSafetyError(safe, uid), null)
  assert.equal(unitFileSafetyError({ ...safe, isSymbolicLink: () => true }, uid), 'unsafe-file')
  assert.equal(unitFileSafetyError({ ...safe, uid: 2000 }, uid), 'unsafe-file')
  assert.equal(unitFileSafetyError({ ...safe, mode: 0o100644 }, uid), 'unsafe-file')
  assert.equal(unitFileSafetyError({ ...safe, isFile: () => false }, uid), 'unsafe-file')
  // Cleanup's ExecStart encoding MUST equal the production encoder for %/$/"/\.
  for (const value of ['/a b/c', '/a%b$c', '/a\\b"c', '/sp ace/%/x$y']) {
    assert.equal(encodeExecArg(value), encodeUnitValue(value, 'probe', true), `encode mismatch for ${JSON.stringify(value)}`)
  }
})

test('cleanup actually stops and removes this run\u2019s unit and refuses foreign, unsafe and failed-stop cases', t => {
  const uid = process.getuid?.()
  const mkRun = ({ artifactBuild, contentBuild = artifactBuild, stopStatus = 0, symlink = false }) => {
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
    const content = ['[Unit]', 'X-DshPiTuiOwner=local-host-manager-v1', `X-DshPiTuiScopeId=${scopeId}`, `X-DshPiTuiInstallBuild=${contentBuild}`, '[Service]', `ExecStart="${process.execPath}" ${encodeExecArg(hostEntry)}`].join('\n')
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
      return { status: 0, stdout: '', stderr: '' }
    }
    const installation = { profileDir, profilePackage, dshHome: join(root, 'dsh-home'), anchor }
    const result = stopAndRemoveManagedUnit(installation, () => {}, undefined, {
      uid, homeDir: home, systemctl: fakeRun, instanceBuild: () => undefined, artifactBuild: () => artifactBuild,
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
  // A symlinked unit path is refused and its target kept.
  const sym = mkRun({ artifactBuild: 'b'.repeat(64), symlink: true })
  assert.equal(sym.result.removed, false)
  assert.equal(existsSync(sym.unitPath), true)
  // A failed stop never unlinks.
  const failed = mkRun({ artifactBuild: 'b'.repeat(64), stopStatus: 1 })
  assert.equal(failed.result.removed, false)
  assert.equal(existsSync(failed.unitPath), true)
  // No build known at all -> not ours, kept.
  const nobuild = mkRun({ artifactBuild: undefined, contentBuild: 'b'.repeat(64) })
  assert.equal(nobuild.result.removed, false)
  assert.equal(existsSync(nobuild.unitPath), true)
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
test('a selected result names only the selectable scope', () => {
  const first = listSelectableCases()[0]
  assert.ok(first, 'the registry must expose a case')
  assert.equal(selectedPassLine(first.id),
    `SPLIT_PROCESS_SELECTED_PASS id=${first.id} scope=SELECTABLE_ONLY`)
})
