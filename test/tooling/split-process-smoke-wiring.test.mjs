/**
 * Split-process smoke wiring guard.
 *
 * The real OS qualification lives in `scripts/split-process-smoke.mjs` and is
 * driven by the dedicated CI split-process job on an npm release tag. An
 * ordinary PR legally skips that job — that skip is NOT the full smoke
 * passing: split-process development work runs `pnpm smoke:split-process`
 * manually under its own task plan. This tooling test is a lightweight
 * wiring/selector/CI/utility guard: it does NOT prove the real 14/14 cases,
 * Host/Client behaviour, Browser qualification or a Full PASS. Those claims
 * are owned by the real lane runs and the shared diagnostics tests.
 *
 * @module split-process-smoke-wiring.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { assertSelectedVerdict, waitForCondition } from '../../scripts/split-process-smoke.mjs'
import { PR_A_WEB_ROWS, raceWithAbortableDeadline, redactWebQualificationText } from '../../scripts/smoke/split-process/web-helpers.mjs'
import { statusMatches } from '../../scripts/lib/split-smoke-processes.mjs'
import {
  listSelectableCases,
  parseSelectionArgs,
  resolveSelection,
  selectedPassLine,
} from '../../scripts/lib/split-smoke-selection.mjs'
import { runEntryAdmission } from '../../scripts/smoke/split-process/entry-admission.mjs'
import { runHostRuntimeDisabled } from '../../scripts/smoke/split-process/host-runtime-disabled.mjs'
import { runRuntimeArtifactRecovery } from '../../scripts/smoke/split-process/runtime-artifact-recovery.mjs'
import { runAuthenticatedLifecycle } from '../../scripts/smoke/split-process/authenticated-lifecycle.mjs'
import { runPtySessionWriteRecovery } from '../../scripts/smoke/split-process/pty-session-write-recovery.mjs'
import { runSharedSessionInteractions } from '../../scripts/smoke/split-process/shared-session-interactions.mjs'
import { runNonDestructiveClientLifecycle } from '../../scripts/smoke/split-process/non-destructive-client-lifecycle.mjs'
import { runDetachedTurnInteractions } from '../../scripts/smoke/split-process/detached-turn-interactions.mjs'
import { runClientHmrSignals } from '../../scripts/smoke/split-process/client-hmr-signals.mjs'
import { runUnknownWriteHostDeath } from '../../scripts/smoke/split-process/unknown-write-host-death.mjs'
import { runOfficialWebComposition } from '../../scripts/smoke/split-process/official-web-composition.mjs'
import { runWebRuntimeToggle } from '../../scripts/smoke/split-process/web-runtime-toggle.mjs'
import { runWebStartupPreference } from '../../scripts/smoke/split-process/web-startup-preference.mjs'
import { runWebProductQualification } from '../../scripts/smoke/split-process/web-product.mjs'
import { HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'

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

test('the split-process smoke is a package script and a release-tag-only CI job', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:split-process'], 'node scripts/split-process-smoke.mjs')
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  // Parse the two jobs rather than matching raw text: the split-process job
  // must own the npm release-tag gate AND execute the real lane against the
  // downloaded candidate, and `qualify` must explicitly record the source-mode
  // skip for both npm-only surfaces. A text-only assertion could keep passing
  // while the run step was removed or the job-level gate was dropped.
  const workflow = parseYaml(ci)
  const job = workflow.jobs['split-process']
  assert.ok(job, 'the split-process smoke must be its own CI job')
  const splitRun = job.steps?.find(step => typeof step.run === 'string'
    && step.run.includes('pnpm smoke:split-process -- "$CANDIDATE"'))
  assert.ok(splitRun, 'the split-process job must execute the real lane against the downloaded candidate')
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

test('the npm release-tag split-process job pins and requires both Browser qualifications', () => {
  // The release-tag CI job installs ONE pinned Playwright and requires BOTH
  // Browser flags; no floating version and no PR-run Browser PASS.
  const workflow = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'))
  const job = workflow.jobs['split-process']
  assert.equal(job.timeoutMinutes ?? job['timeout-minutes'], 60,
    'the product Browser lane needs the bounded longer job timeout')
  assert.equal(job.env.PLAYWRIGHT_VERSION, '1.64.1')
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
  assert.equal((readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').match(/1\.64\.1/gu) ?? []).length, 1,
    'the Playwright version must be ONE job-level constant')
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
  const headers = redactWebQualificationText([
    'Cookie: session=supersecretcookie',
    'Set-Cookie: dsh_session=anothersecret',
    'Authorization: Bearer topsecretvalue',
  ].join('\n'), [])
  assert.equal(/supersecretcookie|anothersecret|topsecretvalue/u.test(headers), false,
    'Cookie/Authorization values must not survive the redactor')
  assert.match(headers, /cookie: <redacted>/iu)
  // Discriminating control: the SAME assertion group rejects the raw text.
  assert.throws(() => {
    assert.equal(raw.includes(token), false)
  })
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
  // The stable IDs, suites and order are the independent oracle; the readable
  // title is owned by the registry and must be echoed verbatim, so a legitimate
  // title rewording does not fail this wiring check.
  const expected = [
    ['bootstrap', 'bootstrap.host-runtime-disabled'],
    ['bootstrap', 'bootstrap.entry-admission'],
    ['bootstrap', 'bootstrap.runtime-artifact-recovery'],
    ['transport', 'transport.authenticated-lifecycle'],
    ['surface', 'surface.pty-session-write-recovery'],
    ['multi-client', 'multi-client.shared-session-interactions'],
    ['navigation', 'navigation.non-destructive-client-lifecycle'],
    ['recovery', 'recovery.detached-turn-interactions'],
    ['recovery', 'recovery.client-hmr-signals'],
    ['recovery', 'recovery.unknown-write-host-death'],
    ['web', 'web.official-composition'],
    ['web', 'web.runtime-toggle'],
    ['web', 'web.startup-preference'],
    ['web', 'web.product-browser-tui'],
  ]
  const titles = new Map(listSelectableCases().map(entry => [entry.id, entry.title]))
  assert.deepEqual(result.stdout.trimEnd().split('\n'), [
    'SPLIT_PROCESS_SELECTABLE_CASES scope=SELECTABLE_ONLY',
    ...expected.map(([suite, id]) => `suite=${suite} case=${id} title=${titles.get(id)}`),
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
  // The ORDER is the frozen execution order the full lane and `--suite` follow.
  assert.deepEqual(cases.map(entry => entry.id), [
    'bootstrap.host-runtime-disabled',
    'bootstrap.entry-admission',
    'bootstrap.runtime-artifact-recovery',
    'transport.authenticated-lifecycle',
    'surface.pty-session-write-recovery',
    'multi-client.shared-session-interactions',
    'navigation.non-destructive-client-lifecycle',
    'recovery.detached-turn-interactions',
    'recovery.client-hmr-signals',
    'recovery.unknown-write-host-death',
    'web.official-composition',
    'web.runtime-toggle',
    'web.startup-preference',
    'web.product-browser-tui',
  ])
  assert.deepEqual(cases.map(entry => entry.suite), [
    'bootstrap', 'bootstrap', 'bootstrap', 'transport', 'surface', 'multi-client', 'navigation',
    'recovery', 'recovery', 'recovery', 'web', 'web', 'web', 'web',
  ])
  const [pilot, entry, recovery, transport, surface, multiClient, navigation,
    detached, hmrSignals, unknownWrite, webComposition, webToggle, webPreference, webProduct] = cases
  assert.deepEqual([pilot.run, entry.run, recovery.run, transport.run, surface.run, multiClient.run, navigation.run,
    detached.run, hmrSignals.run, unknownWrite.run, webComposition.run, webToggle.run, webPreference.run, webProduct.run],
    [runHostRuntimeDisabled, runEntryAdmission, runRuntimeArtifactRecovery, runAuthenticatedLifecycle,
      runPtySessionWriteRecovery, runSharedSessionInteractions, runNonDestructiveClientLifecycle,
      runDetachedTurnInteractions, runClientHmrSignals, runUnknownWriteHostDeath,
      runOfficialWebComposition, runWebRuntimeToggle, runWebStartupPreference, runWebProductQualification],
    'every registered run must be the real scenario, not a copy or a re-wrapped stub')
  assert.ok(Object.isFrozen(cases) && cases.every(entry_ => Object.isFrozen(entry_)), 'the registry must stay frozen')

  assert.deepEqual(resolveSelection({ mode: 'case', id: transport.id }).cases, [transport])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'bootstrap' }).cases, [pilot, entry, recovery])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'transport' }).cases, [transport])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'surface' }).cases, [surface])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'multi-client' }).cases, [multiClient])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'navigation' }).cases, [navigation])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'recovery' }).cases, [detached, hmrSignals, unknownWrite])
  assert.deepEqual(resolveSelection({ mode: 'suite', suite: 'web' }).cases, [webComposition, webToggle, webPreference, webProduct])
  assert.throws(() => resolveSelection({ mode: 'case', id: 'does-not-exist' }),
    error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')
  assert.throws(() => resolveSelection({ mode: 'suite', suite: 'does-not-exist' }),
    error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')

  assert.deepEqual(parseSelectionArgs([]), { mode: 'full', candidate: undefined })
  assert.deepEqual(parseSelectionArgs(['--', 'candidate.tgz']), { mode: 'full', candidate: 'candidate.tgz' })
  assert.deepEqual(parseSelectionArgs(['--list']), { mode: 'list' })
  assert.deepEqual(parseSelectionArgs(['--case', transport.id]), { mode: 'case', id: transport.id, candidate: undefined })
  assert.deepEqual(parseSelectionArgs(['--suite', 'bootstrap', 'candidate.tgz']),
    { mode: 'suite', suite: 'bootstrap', candidate: 'candidate.tgz' })
  for (const invalid of [[['--case']], [['--case', 'a', '--suite', 'b']], [['--list', 'x.tgz']], [['--case', 'a', '--case', 'a']]]) {
    assert.throws(() => parseSelectionArgs(invalid[0]), error => error.code === 'INPUT_SMOKE_SELECTION_INVALID')
  }
})

test('selected dispatch fails closed on non-PASS Web verdicts', () => {
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
})
test('a selected result names only the selectable scope', () => {
  const line = selectedPassLine('bootstrap.host-runtime-disabled')
  assert.equal(line, 'SPLIT_PROCESS_SELECTED_PASS id=bootstrap.host-runtime-disabled scope=SELECTABLE_ONLY')
  for (const forbidden of ['SPLIT_PROCESS_SMOKE_PASS', 'T60', 'PASS_REAL_SPLIT_PROCESS',
    'PASS_PRODUCT_BROWSER', 'WC-12 PASS']) {
    assert.ok(!line.includes(forbidden), `a selected result must not claim ${forbidden}`)
  }
})
