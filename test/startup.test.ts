/**
 * Headless tests for the startup compatibility notice: on a DeepSeek Harness
 * older than the pinned master floor (dsh-v0.1.3-alpha.1) the TUI prints
 * Source Mode guidance when it can prove the version, but does not make
 * concurrent Loader ordering a hard startup contract. The pinned alpha is
 * intentionally not suggested as an npm install because it is source-only.
 * Future runtime lines are not rejected without evidence of a break.
 * `--help` stays available on any harness (the action never runs).
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
    assert.ok(joined.includes('DeepSeek Harness 0.1.3-alpha.1 pinned master source baseline or later'), `stderr must name the Source Mode floor:\n${joined}`)
    assert.ok(joined.includes('pinned DSH master source distribution'), `stderr must give Source Mode guidance:\n${joined}`)
    assert.doesNotMatch(joined, /npm install .*0\.1\.3-alpha\.1/u, `stderr must not suggest an unpublished alpha:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the pinned master harness version starts normally and provides the service', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.1.3-alpha.1')
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

test('the previous alpha.3 line is rejected by the pinned master gate', (t) => {
  const life = testLifecycle(t)
  // The Source Mode minimum is >=0.1.3-alpha.1; the previous alpha line is
  // below the floor and must be refused with source-only guidance.
  const launcher = fakeLauncher(life, '0.1.2-alpha.3')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.2-alpha.3'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes('DeepSeek Harness 0.1.3-alpha.1 pinned master source baseline or later'), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes('pinned DSH master source distribution'), `stderr must give Source Mode guidance:\n${joined}`)
    assert.doesNotMatch(joined, /npm install .*0\.1\.3-alpha\.1/u, `stderr must not suggest an unpublished alpha:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the previous alpha.4/alpha.5 line is rejected by the pinned master gate', (t) => {
  const life = testLifecycle(t)
  // The Source Mode minimum is >=0.1.3-alpha.1: the previous alpha line is
  // below the floor and must be refused with source-only guidance.
  const launcher = fakeLauncher(life, '0.1.2-alpha.5')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.2-alpha.5'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes('DeepSeek Harness 0.1.3-alpha.1 pinned master source baseline or later'), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes('pinned DSH master source distribution'), `stderr must give Source Mode guidance:\n${joined}`)
    assert.doesNotMatch(joined, /npm install .*0\.1\.3-alpha\.1/u, `stderr must not suggest an unpublished alpha:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the pinned master and future stable lines start normally', (t) => {
  for (const version of ['0.1.3-alpha.1', '0.1.3', '0.2.0']) {
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
  assert.ok(message.includes('DeepSeek Harness 0.1.3-alpha.1 pinned master source baseline or later'), 'must name the requirement')
  assert.ok(message.includes('0.1.0-rc.8'), 'must name the installed version')
  assert.ok(message.includes('pinned DSH master source distribution'), 'must give Source Mode guidance')
  assert.doesNotMatch(message, /npm install .*dsh@0\.1\.3-alpha\.1/u, 'must not suggest an unpublished npm alpha')
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
    assert.equal(range, '>=0.1.3-alpha.1', `${name} must use the pinned-master DSH compatibility contract`)
    assert.ok(!range.includes('0.1.1'), `${name} must not claim DSH 0.1.1`)
  }
  for (const [name, version] of Object.entries(packageJson.devDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) {
      assert.equal(version, '0.1.2-rc.1', `${name} dev dependency must stay exact`)
    }
  }
})

test('harnessCompatEntryFor protects the pinned master Source Mode floor', () => {
  const floor = HARNESS_COMPAT[0]
  assert.ok(floor !== undefined)
  assert.equal(floor.max, '0.1.3-alpha.1')
  assert.equal(floor.since, '0.4.1')
  assert.equal(harnessCompatEntryFor('0.1.2-rc.1'), floor)
  assert.equal(harnessCompatEntryFor('0.1.3-alpha.0'), floor)
  assert.equal(harnessCompatEntryFor('0.1.3-alpha.1'), undefined, 'the pinned master floor is supported')
  assert.equal(harnessCompatEntryFor('0.1.3'), undefined, 'future stable runtimes are not rejected without evidence')
  assert.equal(harnessCompatEntryFor('1.0.0'), undefined)
})
