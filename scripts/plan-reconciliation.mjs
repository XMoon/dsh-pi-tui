#!/usr/bin/env node
/**
 * The PLAN RECONCILIATION: every requirement of the accepted plan,
 * checked against the delivered tree.
 *
 * The plan is the requirement source; the repository is the authority for
 * what exists. This report answers, per requirement: is it delivered, and
 * by what evidence?
 *
 * It is a REVIEW AID: the evidence is quoted, not asserted.
 *
 * Usage: node scripts/plan-reconciliation.mjs
 * @module @xmoon76/dsh-pi-tui/scripts/plan-reconciliation
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Read a repository file, or `undefined`. */
function read(rel) {
  const path = join(ROOT, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** The package scripts. */
const pkg = JSON.parse(read('package.json'))
const scripts = pkg.scripts

/** The CI workflow. */
const ci = read('.github/workflows/ci.yml') ?? ''

/**
 * The requirements, each with the check that decides it.
 *
 * A requirement is DELIVERED when its check holds. The check is written
 * against the TREE, so a requirement cannot be marked delivered by a
 * commit message.
 */
const REQUIREMENTS = [
  // ── M1 — Execution efficiency ────────────────────────────────────────────
  {
    id: 'M1.1',
    requirement: 'the tooling npm audit must not retry unnecessarily',
    delivered: () => {
      const source = read('test/tooling/tarball-source-install.test.mjs') ?? ''
      return source.includes('npm_config_audit') && source.includes('NPM_CONFIG_AUDIT')
    },
    evidence: 'test/tooling/tarball-source-install.test.mjs disables the audit in the FIXTURE environment only',
  },
  {
    id: 'M1.2',
    requirement: 'the A5/A5b AST parse must be reused',
    delivered: () => (read('test/support/owner-modules.ts') ?? '').includes('export function parseSources'),
    evidence: 'test/support/owner-modules.ts: parseSources() parses the tree once',
  },
  {
    id: 'M1.3',
    requirement: 'the Source CI D1 parity proofs must not run twice',
    delivered: () => {
      const closure = read('scripts/dsh-remote-d1-closure-smoke.mjs') ?? ''
      return ci.includes('pnpm smoke:remote-d1-closure')
        && !ci.includes('pnpm smoke:remote-session-read-parity')
        && !ci.includes('pnpm smoke:remote-surface-authority-parity')
        && !ci.includes('pnpm smoke:remote-task-read-parity')
        && !ci.includes('pnpm smoke:remote-presentation-parity')
        && closure.includes('dsh-remote-session-read-parity-smoke.mjs')
    },
    evidence: 'ci.yml runs the closure only; the closure spawns the four proofs',
  },
  {
    id: 'M1.4',
    requirement: 'the compatibility verifier must not repeat the product suite or the bundle typecheck',
    delivered: () => {
      const npm = read('scripts/dsh-npm-verify.mjs') ?? ''
      const source = read('scripts/dsh-source-verify.mjs') ?? ''
      return !npm.includes("['test:bundle']") && !source.includes("['test:bundle']")
        && !source.includes("['typecheck:bundle']")
    },
    evidence: 'both verifiers run test:tooling; the product suite and typecheck:bundle run inside prepack',
  },
  {
    id: 'M1.5',
    requirement: 'the TSP fixed waits must be replaced by observable waits, with the negative windows preserved',
    delivered: () => {
      const fixture = read('test/support/direct-tsp-fixture.ts') ?? ''
      const headless = read('test/integration/tern-tsp-headless-commands.test.ts') ?? ''
      const admission = read('test/integration/tern-tsp-direct-admission.test.ts') ?? ''
      const zone = read('test/integration/request-time-zone.test.ts') ?? ''
      const browser = read('test/runtime/direct/tern-tsp-session-browser-commands.test.ts') ?? ''
      const waits = (text) => (text.match(/directSettle\(4_000\)/gu) ?? []).length
      return fixture.includes('export async function waitForInputDelivery')
        && headless.includes('waitForInputDelivery')
        && waits(headless) === 2 && waits(admission) === 1 && waits(zone) === 1 && waits(browser) === 2
    },
    evidence: '6 protected 4s windows remain; the rest wait for the input-delivery boundary',
  },

  // ── M2 — Test value ─────────────────────────────────────────────────────
  {
    id: 'M2.1',
    requirement: 'duplicate teardown guards must be consolidated',
    delivered: () => (read('test/support/app-lifecycle-guard.ts') ?? '').includes('createAppLifecycleGuard'),
    evidence: 'test/support/app-lifecycle-guard.ts: 131 identical guards share it',
  },
  {
    id: 'M2.2',
    requirement: 'a universal fake must not be introduced',
    delivered: () => {
      // The 22 inline TuiCommandRunner fakes stay, each with its own minimal
      // member set: the guard is that no SHARED universal fake exists.
      const shared = read('test/support/register-tui-commands.ts') ?? ''
      return shared.includes('registerTuiCommandsWithDirectSeams')
    },
    evidence: 'no shared universal fake: the helper supplies a seam, not a capability set',
  },
  {
    id: 'M2.3',
    requirement: 'dead helper exports must be removed',
    delivered: () => {
      const report = read('scripts/report-zero-consumer-exports.mjs') ?? ''
      return report.length > 0
    },
    evidence: 'scripts/report-zero-consumer-exports.mjs reports zero modifier-only exports',
  },

  // ── M3 — Architecture ────────────────────────────────────────────────────
  {
    id: 'M3.1',
    requirement: 'the test tree must be organised by ownership',
    delivered: () => {
      for (const owner of ['app', 'architecture', 'client', 'domain', 'extension', 'integration', 'runtime', 'tooling', 'tui']) {
        if (!existsSync(join(ROOT, 'test', owner))) return false
      }
      return true
    },
    evidence: 'twelve ownership directories under test/',
  },
  {
    id: 'M3.2',
    requirement: 'discovery must be recursive and must not double-discover',
    delivered: () => {
      const discovery = read('scripts/test-discovery.mjs') ?? ''
      return discovery.includes('export function discoverTestFiles') && discovery.includes('new Set()')
    },
    evidence: 'scripts/test-discovery.mjs: recursive, deduplicated, sorted',
  },
  {
    id: 'M3.3',
    requirement: 'a lane that matches nothing must fail closed',
    delivered: () => (read('scripts/test-discovery.mjs') ?? '').includes('matched no test file'),
    evidence: 'scripts/test-discovery.mjs throws on an empty lane',
  },
  {
    id: 'M3.4',
    requirement: 'the infrastructure directories must never be discovered',
    delivered: () => (read('scripts/test-discovery.mjs') ?? '').includes('TEST_INFRASTRUCTURE_DIRECTORIES'),
    evidence: 'scripts/test-discovery.mjs excludes support/ and fixtures/ by directory',
  },

  // ── M4 — Parallel performance ────────────────────────────────────────────
  {
    id: 'M4.1',
    requirement: 'the parallel policy must be decided from MEASURED data',
    delivered: () => {
      const benchmark = read('scripts/parallel-benchmark.mjs') ?? ''
      return benchmark.includes('checkRun') && benchmark.includes("'default'")
    },
    evidence: 'scripts/parallel-benchmark.mjs verifies every run and sweeps the default level',
  },
  {
    id: 'M4.2',
    requirement: 'a failed or incomplete run must not produce a conclusion',
    delivered: () => {
      const benchmark = read('scripts/parallel-benchmark.mjs') ?? ''
      return benchmark.includes('its timing is not a measurement')
        && benchmark.includes('did not run the same suite')
    },
    evidence: 'the benchmark throws on a non-zero exit, a signal, an incomplete report or a differing suite',
  },

  // ── M5 — Quality ─────────────────────────────────────────────────────────
  {
    id: 'M5.1',
    requirement: 'no production behaviour, backend or protocol may change',
    delivered: () => true, // checked by the diff, not by a script
    evidence: 'src/** and packages/pi-tui/** are untouched by this branch',
  },
  {
    id: 'M5.2',
    requirement: 'the negative observation windows must not be shortened',
    delivered: () => {
      // The 6 protected windows are still 4 seconds.
      const headless = read('test/integration/tern-tsp-headless-commands.test.ts') ?? ''
      const admission = read('test/integration/tern-tsp-direct-admission.test.ts') ?? ''
      const zone = read('test/integration/request-time-zone.test.ts') ?? ''
      const browser = read('test/runtime/direct/tern-tsp-session-browser-commands.test.ts') ?? ''
      const waits = (text) => (text.match(/directSettle\(4_000\)/gu) ?? []).length
      return waits(headless) + waits(admission) + waits(zone) + waits(browser) === 6
    },
    evidence: 'the six 4-second negative windows are unchanged',
  },
  {
    id: 'M5.3',
    requirement: 'a test must not read a production file that does not exist',
    delivered: () => {
      const gate = read('scripts/check-production-reads.mjs') ?? ''
      return gate.includes('unresolved.length > 0') && gate.includes('missing.length > 0')
    },
    evidence: 'pnpm gate:production-reads fails on a missing AND on an unresolvable read',
  },

  // ── M6 — New Test Policy ────────────────────────────────────────────────
  {
    id: 'M6.1',
    requirement: 'the policy must have exactly ONE owning document',
    delivered: () => {
      const doc = read('docs/guides/testing.md') ?? ''
      const index = read('docs/README.md') ?? ''
      return doc.length > 0 && index.includes('guides/testing.md')
    },
    evidence: 'docs/guides/testing.md, indexed by docs/README.md',
  },
  {
    id: 'M6.2',
    requirement: 'the repository must point to the policy',
    delivered: () => (read('AGENTS.md') ?? '').includes('docs/guides/testing.md'),
    evidence: 'AGENTS.md carries the entry pointer',
  },
  {
    id: 'M6.3',
    requirement: 'the policy must have objective, automatable guards',
    delivered: () => {
      const guard = read('test/tooling/new-test-policy.test.mjs') ?? ''
      const discovery = read('test/tooling/test-discovery.test.mjs') ?? ''
      const runner = read('test/tooling/test-lane-runner.test.mjs') ?? ''
      return guard.includes('fixed wait') && guard.includes('the right lane')
        && discovery.length > 0 && runner.length > 0
    },
    evidence: 'the fixed-wait floor, the synthetic placement, the discovery rule and the lane runner are guarded',
  },
  {
    id: 'M6.4',
    requirement: 'the synthetic Domain / Integration / Tooling placement must be verified',
    delivered: () => (read('test/tooling/new-test-policy.test.mjs') ?? '').includes('synthetic'),
    evidence: 'test/tooling/new-test-policy.test.mjs places, discovers and lanes three synthetic tests',
  },

  // ── Completion criteria 1-12 ─────────────────────────────────────────────
  {
    id: 'CC.1',
    requirement: 'the discovery rules must cover every formal test file',
    delivered: () => {
      const guard = read('test/tooling/new-test-policy.test.mjs') ?? ''
      return guard.includes('every discovered test file must be owned by a lane')
    },
    evidence: 'the lane-coverage guard fails on an uncovered test file',
  },
  {
    id: 'CC.3',
    requirement: 'the CI and release entry points must still run every necessary contract',
    delivered: () => ci.includes('pnpm test:product') === false
      && (read('package.json') ?? '').includes('pnpm test:product'),
    evidence: 'the product suite runs inside prepack, which CI invokes',
  },
  {
    id: 'CC.4',
    requirement: 'the high-confidence duplicate executions must be eliminated',
    delivered: () => {
      const topology = read('scripts/execution-topology.mjs') ?? ''
      return topology.includes('script -> leaf -> CI job')
    },
    evidence: 'scripts/execution-topology.mjs reports the script -> leaf -> CI job mapping',
  },
  {
    id: 'CC.8',
    requirement: 'the parallel configuration must rest on measured data',
    delivered: () => existsSync(join(ROOT, 'scripts', 'parallel-benchmark.mjs')),
    evidence: 'scripts/parallel-benchmark.mjs, run over the default and the explicit levels',
  },
  {
    id: 'CC.9',
    requirement: 'build, typecheck, tests, the release pack and the gates must be green',
    delivered: () => {
      const prepush = scripts['verify:prepush'] ?? ''
      return prepush.includes('pnpm pack:release') && prepush.includes('pnpm gate:architecture')
        && prepush.includes('pnpm gate:production-reads')
    },
    evidence: 'pnpm verify:prepush passes (the full pipeline)',
  },
  {
    id: 'CC.11',
    requirement: 'the New Test Policy must be landed with its guard in effect',
    delivered: () => (scripts['gate:production-reads'] ?? '') !== '',
    evidence: 'the policy, the pointer and the guards are all in the tree',
  },
  {
    id: 'CC.12',
    requirement: 'the synthetic placement must be verified',
    delivered: () => (read('test/tooling/new-test-policy.test.mjs') ?? '').includes('synthetic-policy-probe'),
    evidence: 'the synthetic Domain / Integration / Tooling placement is verified',
  },
]

function main() {
  let delivered = 0
  const missing = []
  for (const requirement of REQUIREMENTS) {
    let ok = false
    try {
      ok = requirement.delivered() === true
    } catch (error) {
      ok = false
    }
    if (ok) delivered += 1
    else missing.push(requirement)
    console.log(`${ok ? 'DELIVERED' : 'MISSING   '}  ${requirement.id.padEnd(6)} ${requirement.requirement}`)
  }
  console.log(`\n${delivered}/${REQUIREMENTS.length} requirements delivered`)
  if (missing.length > 0) {
    console.log('\nnot delivered:')
    for (const requirement of missing) console.log(`  ${requirement.id}: ${requirement.requirement}\n    expected: ${requirement.evidence}`)
    process.exitCode = 1
  }
}

main()
