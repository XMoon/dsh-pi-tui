/**
 * Headless tests for the startup compatibility notice: on a DeepSeek Harness
 * older than the minimum (dsh-v0.1.2-rc.1) the TUI prints ACTIONABLE
 * upgrade/rollback guidance when it can prove the version, but does not make
 * concurrent Loader ordering a hard startup contract. The 0.4 line has no
 * 0.1.1 compatibility shim; the alpha.2/alpha.3 baseline falls back to
 * 0.4.0-alpha.1, the alpha.4/alpha.5 baseline falls back to 0.4.0-alpha.2,
 * and everything older belongs on the 0.3 line. Future runtime lines are not
 * rejected without evidence of a break. `--help` stays available on any
 * harness (the action never runs).
 * @module @xmoon76/dsh-pi-tui/startup.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyStartup, TUI_STARTUP_SERVICE, HARNESS_COMPAT, bundleVersionLabel, harnessCompatEntryFor, incompatibleHarnessMessage } from '../src/startup.ts'
import { versionAtLeast } from '../src/dsh-version.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

/** Point process.argv[1] at a fabricated @deepseek-ai/dsh package whose
 * version the launcher walk resolves. */
function fakeLauncher(life: TestLifecycle, version: string): { restore: () => void } {
  const root = life.tempDir('dsh-startup-gate-')
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'bin'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  const bin = join(dshDir, 'bin', 'dsh')
  writeFileSync(bin, '')
  const previous = process.argv[1]
  process.argv[1] = bin
  return { restore: () => { process.argv[1] = previous } }
}

/** Capture stderr writes into an array. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => { lines.push(chunk); return true }) as typeof process.stderr.write
  return { lines, restore: () => { process.stderr.write = original } }
}

function mountStartup(args: string[] = []): Context {
  const ctx = new Context()
  ctx.provide('cmdlineArgs', { get: () => args })
  // parseCmdline requires the launcher pair (cmdlineArgs + appExit).
  ctx.provide('appExit', ((code: number) => { void code }) as never)
  applyStartup(ctx)
  return ctx
}

// ── versionAtLeast (pure semver comparison) ────────────────────────────────

test('versionAtLeast compares core versions', () => {
  assert.equal(versionAtLeast('0.1.1-rc.1', '0.1.1-rc.1'), true)
  assert.equal(versionAtLeast('0.1.1-rc.2', '0.1.1-rc.1'), true)
  assert.equal(versionAtLeast('0.1.1', '0.1.1-rc.1'), true, 'a release beats any prerelease of the same core')
  assert.equal(versionAtLeast('1.0.0', '0.1.1-rc.1'), true)
  assert.equal(versionAtLeast('0.2.0-rc.0', '0.1.1-rc.1'), true)
  assert.equal(versionAtLeast('0.1.0-rc.8', '0.1.1-rc.1'), false, 'the rc.8 line is below the floor')
  assert.equal(versionAtLeast('0.1.1-rc.0', '0.1.1-rc.1'), false, 'rc.0 precedes rc.1')
  assert.equal(versionAtLeast('0.1.0', '0.1.1-rc.1'), false)
  assert.equal(versionAtLeast('0.1.0-rc.9', '0.1.1-rc.1'), false)
})

test('versionAtLeast compares prerelease identifiers the semver way', () => {
  assert.equal(versionAtLeast('0.1.1-rc.10', '0.1.1-rc.9'), true, 'numeric identifiers compare numerically')
  assert.equal(versionAtLeast('0.1.1-rc.9', '0.1.1-rc.10'), false)
  assert.equal(versionAtLeast('0.1.1-rc.1', '0.1.1-rc.1'), true)
  assert.equal(versionAtLeast('0.1.1-alpha.1', '0.1.1-rc.1'), false, 'alphanumeric > numeric, so alpha < rc')
  assert.equal(versionAtLeast('0.1.1-rc.1', '0.1.1-alpha.1'), true)
})

// ── the gate itself ────────────────────────────────────────────────────────

test('an older harness gets actionable guidance without a hard Loader-ordering throw', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.1.0-rc.8')
  const stderr = captureStderr()
  try {
    const ctx = new Context()
    ctx.provide('cmdlineArgs', { get: () => ['--session', 's1'] })
    ctx.provide('appExit', ((code: number) => { void code }) as never)
    assert.doesNotThrow(() => applyStartup(ctx), 'the advisory notice must not block concurrent profile mounting')
    assert.equal((ctx.get(TUI_STARTUP_SERVICE) as { sessionId: string }).sessionId, 's1')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes(`running dsh 0.1.0-rc.8`), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes('npm install -g @deepseek-ai/dsh@0.1.2-rc.1'), `stderr must give the upgrade path:\n${joined}`)
    assert.ok(joined.includes('npm install -g @xmoon76/dsh-pi-tui@0.3'), `stderr must give the rollback path:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the rc.1 minimum harness version starts normally and provides the service', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.1.2-rc.1')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the startup service must be provided')
    assert.equal((ctx.get(TUI_STARTUP_SERVICE) as { sessionId: string }).sessionId, 's1')
    assert.equal(stderr.lines.length, 0, 'no gate message on a supported harness')
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the previous alpha.3 floor is rejected by the rc.1 minimum gate', (t) => {
  const life = testLifecycle(t)
  // The 0.4 minimum is >=0.1.2-rc.1: the alpha.2/alpha.3 baseline is
  // below the floor and must be refused with the 0.4.0-alpha.1 fallback
  // (the exact minimum-boundary regression — a future code drift that
  // silently uses rc.1-only APIs is easier to spot when the floor
  // contract is pinned on both sides).
  const launcher = fakeLauncher(life, '0.1.2-alpha.3')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.2-alpha.3'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes('DeepSeek Harness 0.1.2-alpha.4 or later'), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes('npm install -g @deepseek-ai/dsh@0.1.2-rc.1'), `stderr must give the upgrade path:\n${joined}`)
    assert.ok(joined.includes('npm install -g @xmoon76/dsh-pi-tui@0.4.0-alpha.1'), `stderr must give the 0.4-alpha fallback:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the previous alpha.4/alpha.5 baseline is rejected by the rc.1 minimum gate', (t) => {
  const life = testLifecycle(t)
  // The 0.4 minimum is >=0.1.2-rc.1: the alpha.4/alpha.5 baseline is
  // below the new rc.1 floor and must be refused with the last 0.4
  // prerelease that still accepts it (0.4.0-alpha.2).
  const launcher = fakeLauncher(life, '0.1.2-alpha.5')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.2-alpha.5'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes('DeepSeek Harness 0.1.2-rc.1 or later'), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes('npm install -g @deepseek-ai/dsh@0.1.2-rc.1'), `stderr must give the upgrade path:\n${joined}`)
    assert.ok(joined.includes('npm install -g @xmoon76/dsh-pi-tui@0.4.0-alpha.2'), `stderr must give the 0.4-alpha fallback:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the rc minimum and the 0.1.2 release line start normally', (t) => {
  for (const version of ['0.1.2-rc.1', '0.1.2', '0.1.3']) {
    const life = testLifecycle(t)
    const launcher = fakeLauncher(life, version)
    try {
      const ctx = mountStartup([])
      assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, `${version} should be supported`)
    } finally {
      launcher.restore()
    }
  }
})

test('an unresolvable launcher version does not block startup', () => {
  // process.argv[1] points at a path with no @deepseek-ai/dsh manifest: the
  // gate cannot prove incompatibility, so it must not refuse to start.
  const previous = process.argv[1]
  process.argv[1] = join(tmpdir(), 'dsh-startup-gate-nonexistent-bin')
  try {
    const ctx = mountStartup([])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'unknown harness version must not block startup')
  } finally {
    process.argv[1] = previous
  }
})

test('incompatibleHarnessMessage is actionable and names both versions', () => {
  const entry = harnessCompatEntryFor('0.1.0-rc.8')
  assert.ok(entry !== undefined, 'rc.8 must match an incompatible entry')
  const message = incompatibleHarnessMessage('0.1.0-rc.8', entry!)
  // The bundle version is read from package.json at runtime (never
  // hardcoded), so the assertion reads it the same way.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
  assert.ok(message.includes(`dsh-pi-tui v${pkg.version}`), `must name the bundle version: ${message}`)
  assert.ok(message.includes('DeepSeek Harness 0.1.2-alpha.2 or later'), 'must name the requirement')
  assert.ok(message.includes('0.1.0-rc.8'), 'must name the installed version')
  assert.ok(message.includes('npm install -g @deepseek-ai/dsh@0.1.2-rc.1'), 'must give the upgrade command')
  assert.ok(message.includes('npm install -g @xmoon76/dsh-pi-tui@0.3'), 'must give the compatible TUI pin command')
})

test('bundleVersionLabel falls back to the release line that imposed the requirement', () => {
  assert.ok(bundleVersionLabel('0.4.0-alpha.1').startsWith('v'), `read version label: ${bundleVersionLabel('0.4.0-alpha.1')}`)
})

test('DSH peer ranges keep the lower-bound compatibility contract', () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dshPeers = Object.entries(packageJson.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(dshPeers.length > 0, 'the bundle must declare DSH peers')
  for (const [name, range] of dshPeers) {
    assert.equal(range, '>=0.1.2-rc.1', `${name} must use the lower-bound DSH compatibility contract`)
    assert.ok(!range.includes('0.1.1'), `${name} must not claim DSH 0.1.1`)
  }
  for (const [name, version] of Object.entries(packageJson.devDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) {
      assert.equal(version, '0.1.2-rc.1', `${name} dev dependency must stay exact`)
    }
  }
})

test('harnessCompatEntryFor protects only the too-old runtime boundary', () => {
  const preAlpha2 = HARNESS_COMPAT.find(candidate => candidate.max === '0.1.2-alpha.2')
  assert.ok(preAlpha2 !== undefined, 'the pre-alpha.2 entry must exist')
  assert.equal(preAlpha2?.since, '0.4.0-alpha.1')
  const preAlpha4 = HARNESS_COMPAT.find(candidate => candidate.max === '0.1.2-alpha.4')
  assert.ok(preAlpha4 !== undefined, 'the alpha.4 floor entry must exist')
  assert.equal(preAlpha4?.min, '0.1.2-alpha.2', 'the alpha.4 entry covers only the alpha.2/alpha.3 baseline')
  const preRc1 = HARNESS_COMPAT.find(candidate => candidate.max === '0.1.2-rc.1')
  assert.ok(preRc1 !== undefined, 'the rc.1 floor entry must exist')
  assert.equal(preRc1?.min, '0.1.2-alpha.4', 'the rc.1 entry covers only the alpha.4/alpha.5 baseline')
  assert.equal(preRc1?.since, '0.4.0')
  assert.equal(harnessCompatEntryFor('0.1.1-rc.2'), preAlpha2, 'the old runtime falls back to the 0.3 line')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.0'), preAlpha2, 'alpha.0 is below the floor')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.1'), preAlpha2, 'the previous alpha.1 floor falls back to the 0.3 line')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.2'), preAlpha4, 'the alpha.2 baseline falls back to the previous 0.4 alpha')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.3'), preAlpha4, 'the alpha.3 baseline falls back to the previous 0.4 alpha')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.4'), preRc1, 'the alpha.4 baseline falls back to 0.4.0-alpha.2')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.5'), preRc1, 'the alpha.5 baseline falls back to 0.4.0-alpha.2')
  assert.equal(harnessCompatEntryFor('0.1.2-rc.1'), undefined, 'the rc.1 floor itself is supported')
  assert.equal(harnessCompatEntryFor('0.1.2'), undefined)
  assert.equal(harnessCompatEntryFor('0.1.3'), undefined, 'future runtimes are not rejected without evidence')
  assert.equal(harnessCompatEntryFor('1.0.0'), undefined)
})
