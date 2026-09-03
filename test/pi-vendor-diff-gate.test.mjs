/**
 * Hermetic tests for the vendor-diff gate's tarball fallback: the
 * extraction path must handle gzip BINARY (a UTF-8-decoded tarball is
 * corrupted and tar fails), and a local PI_UPSTREAM_TARBALL must be
 * honored without network.
 * @module @xmoon76/dsh-pi-tui/pi-vendor-diff-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'pi-vendor-diff-gate.mjs')

/** A test-owned env with the local-checkout candidates disabled (HOME
 * points at an empty dir, PI_UPSTREAM_REPO at a missing path), so the
 * gate can only resolve upstream through the tarball fallback. The
 * fallback hooks are explicitly REMOVED from the inherited env: a stray
 * PI_UPSTREAM_TARBALL/CURL would silently switch the branch under test. */
function makeEnv(t, extra) {
  const life = testLifecycle(t)
  const root = life.tempDir('pi-vendor-diff-test-')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, PI_UPSTREAM_REPO: join(root, 'no-such-repo'), HOME: home }
  delete env.PI_UPSTREAM_TARBALL
  delete env.PI_UPSTREAM_CURL
  return { root, env: { ...env, ...extra } }
}

function runGate(env) {
  return spawnSync(process.execPath, [GATE], { cwd: ROOT, env, encoding: 'utf8' })
}

/** Build a fake upstream tarball (root name irrelevant — the gate peels
 * one level with --strip-components=1) and return its path. It carries
 * ONE file that matches a real local fork file (utils.ts, copied
 * verbatim) so the comparison must report it as UNCHANGED — a fallback
 * that cannot read the extracted tree (e.g. running `git show` in a
 * non-git directory) would report every local file as local-only and
 * fail the unchanged assertion. */
function makeFakeUpstreamTarball(root) {
  const tree = join(root, 'pi-fake')
  mkdirSync(join(tree, 'packages', 'tui', 'src'), { recursive: true })
  writeFileSync(join(tree, 'packages', 'tui', 'src', 'foo.ts'), 'upstream foo\n')
  const localUtils = readFileSync(join(ROOT, 'packages', 'pi-tui', 'src', 'utils.ts'), 'utf8')
  writeFileSync(join(tree, 'packages', 'tui', 'src', 'utils.ts'), localUtils)
  const tarball = join(root, 'upstream.tar.gz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', root, 'pi-fake'])
  assert.equal(packed.status, 0, 'fixture tarball must be created')
  return tarball
}

/** The fake upstream covers all but one of the real fork's files, so the
 * gate must FAIL with unaccounted divergences (exit 1) — NOT with an
 * extraction error (exit 2) — and must report utils.ts as UNCHANGED. */
function assertGateRanComparison(result) {
  assert.equal(result.status, 1, `expected unaccounted-diff failure, stderr: ${result.stderr}`)
  assert.ok(result.stdout.includes('UNACCOUNTED divergence'), 'the comparison must have run')
  assert.ok(result.stdout.includes('unchanged: 1'), 'the matching utils.ts must be recognized as unchanged')
  assert.ok(!result.stderr.includes('failed to extract'), 'the tarball must extract cleanly')
}

/** Build a complete matching upstream tree. Every local source file matches,
 * so each source-active entry is stale; historical records must stay quiet.
 * This exercises strict stale detection without changing tracked files. */
function makeMatchingUpstreamTarball(root) {
  const tree = join(root, 'pi-matching')
  const upstreamSrc = join(tree, 'packages', 'tui', 'src')
  cpSync(join(ROOT, 'packages', 'pi-tui', 'src'), upstreamSrc, { recursive: true })
  const tarball = join(root, 'matching-upstream.tar.gz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', root, 'pi-matching'])
  assert.equal(packed.status, 0, 'matching fixture tarball must be created')
  return tarball
}

test('the tarball fallback extracts a local PI_UPSTREAM_TARBALL hermetically', (t) => {
  const { root, env } = makeEnv(t, {})
  const tarball = makeFakeUpstreamTarball(root)
  assertGateRanComparison(runGate({ ...env, PI_UPSTREAM_TARBALL: tarball }))
})

test('the curl fallback passes gzip BINARY through to tar (PI_UPSTREAM_CURL)', (t) => {
  const { root, env } = makeEnv(t, {})
  const tarball = makeFakeUpstreamTarball(root)
  // A fake curl that streams the fixture tarball to stdout, exactly like
  // the real codeload fetch. The gate must NOT decode it as UTF-8 text —
  // a decoded gzip is corrupted and tar fails to extract.
  const fakeCurl = join(root, 'fake-curl.sh')
  writeFileSync(fakeCurl, `#!/bin/sh\ncat "${tarball}"\n`)
  chmodSync(fakeCurl, 0o755)
  assertGateRanComparison(runGate({ ...env, PI_UPSTREAM_CURL: fakeCurl }))
})

test('strict mode rejects a stale active entry but ignores historical records', (t) => {
  const { root, env } = makeEnv(t, {})
  const tarball = makeMatchingUpstreamTarball(root)
  const result = runGate({ ...env, PI_UPSTREAM_TARBALL: tarball, PI_UPSTREAM_REPO: join(root, 'no-such-repo') })
  assert.equal(result.status, 0, 'default mode reports stale entries as warnings')
  assert.ok(result.stdout.includes('STALE ledger: X001'), 'active X001 must be reported stale')
  assert.ok(!result.stdout.includes('STALE ledger: X003'), 'removed X003 must not be treated as an active source entry')
  assert.ok(!result.stdout.includes('STALE ledger: X015'), 'absorbed X015 must not be treated as an active source entry')

  const strict = spawnSync(process.execPath, [GATE, '--strict'], {
    cwd: ROOT,
    env: { ...env, PI_UPSTREAM_TARBALL: tarball, PI_UPSTREAM_REPO: join(root, 'no-such-repo') },
    encoding: 'utf8',
  })
  assert.equal(strict.status, 1, 'strict mode must fail stale active entries')
  assert.ok(strict.stdout.includes('WARN (strict: failing)'), 'strict output must identify promoted warnings')
})

test('schema-v2 source coverage fails closed on missing status or files', (t) => {
  const { root, env } = makeEnv(t, {})
  const tarball = makeMatchingUpstreamTarball(root)
  const manifestPath = join(root, 'manifest.json')
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', 'pi-tui', 'vendor-divergences.json'), 'utf8'))

  delete manifest.divergences.X001.status
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const missingStatus = runGate({
    ...env,
    PI_VENDOR_MANIFEST: manifestPath,
    PI_UPSTREAM_TARBALL: tarball,
  })
  assert.equal(missingStatus.status, 2)
  assert.ok(missingStatus.stderr.includes('supported schema-v2 status'))

  manifest.divergences.X001.status = 'ACTIVE'
  manifest.divergences.X001.files = []
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const missingFiles = runGate({
    ...env,
    PI_VENDOR_MANIFEST: manifestPath,
    PI_UPSTREAM_TARBALL: tarball,
  })
  assert.equal(missingFiles.status, 2)
  assert.ok(missingFiles.stderr.includes('non-empty files array'))
})
