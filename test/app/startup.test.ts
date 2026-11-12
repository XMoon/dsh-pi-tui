/**
 * Headless tests for the startup compatibility notice: on a DeepSeek Harness
 * older than the published npm floor (dsh-v0.2.2-rc.1) the TUI prints
 * npm-aware upgrade guidance when it can prove the version, but does not make
 * concurrent Loader ordering a hard startup contract. The recommended published
 * upgrade target (and its native install scripts) follows the shared compat
 * matrix, so the recovery target may be newer than the floor. Future runtime
 * lines are not rejected without evidence of a break. `--help` stays available
 * on any harness (the action never runs).
 * @module @xmoon76/dsh-pi-tui/startup.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyStartup, TUI_STARTUP_SERVICE, HARNESS_COMPAT, bundleVersionLabel, harnessCompatEntryFor, incompatibleHarnessMessage } from '../../src/startup.ts'
import type { TestContext } from 'node:test'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

/** The recovery expectations every below-floor notice shares, derived from the
 * same compat matrix the startup island inlines — never a second hand-written
 * copy of the requirement or the upgrade command. */
const FLOOR_ENTRY = harnessCompatEntryFor('0.1.0-rc.8')
const EXPECTED_REQUIREMENT = FLOOR_ENTRY?.requires ?? ''
const EXPECTED_UPGRADE = FLOOR_ENTRY?.upgradeCommand ?? ''

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

function mountStartup(t: TestContext, args: string[] = []): Context {
  const ctx = new Context()
  ctx.provide('cmdlineArgs', { get: () => args })
  // parseCmdline requires the launcher pair (cmdlineArgs + appExit).
  ctx.provide('appExit', ((code: number) => { void code }) as never)
  // A normal invocation installs the temporary model-listing console
  // interception, which mutates process-global console methods; every mount
  // must unload its row so the wrapper (and any language-level leak) cannot
  // outlive the test. Registered BEFORE the action runs, so a throwing
  // startup cannot strand the wrapper either.
  t.after(async () => { await ctx.fiber.dispose() })
  applyStartup(ctx)
  return ctx
}

// ── the compatibility boundary selection (the startup-local comparator) ────
// The runner's shared `versionAtLeast` was retired (TS8-F2), so the
// startup-local comparator is exercised through its only surviving consumer,
// the matrix selection, at the exact prerelease/range boundaries.

test('harnessCompatEntryFor selects the range whose inclusive min the version reaches', () => {
  assert.equal(harnessCompatEntryFor('0.1.0-rc.8')?.min, '0.1.0-rc.8', 'an inclusive lower bound belongs to its own range')
  assert.equal(harnessCompatEntryFor('0.1.1-rc.1')?.min, '0.1.1-rc.1')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.1')?.min, '0.1.2-alpha.1')
  assert.equal(harnessCompatEntryFor('0.1.3-alpha.1')?.min, '0.1.3-alpha.1')
  assert.equal(harnessCompatEntryFor('0.2.2-rc.1'), undefined, 'the current supported line has no incompatible entry')
  assert.equal(harnessCompatEntryFor('0.2.2'), undefined)
  // The previous 0.2.1-rc.* family is now BELOW the floor and notices its
  // published 0.5.5 pairing; 0.2.1-rc.1 (a matrix row without a TUI) and the
  // 0.2.0-rc.2 family keep their historical entries.
  assert.equal(harnessCompatEntryFor('0.2.1-rc.5')?.fallbackTui, '0.5.5',
    'the previous family notices its published 0.5.5 TUI pairing')
  assert.equal(harnessCompatEntryFor('0.2.1-rc.1')?.fallbackTui, undefined)
  assert.equal(harnessCompatEntryFor('0.2.0-rc.2')?.fallbackTui, '0.5.2-rc.1',
    'the previous family notices its published next-channel TUI pairing')
})

test('harnessCompatEntryFor compares prerelease identifiers the semver way', () => {
  // A release beats any prerelease of the same core: 0.1.1 stays in the range
  // whose inclusive min is 0.1.1-rc.1.
  assert.equal(harnessCompatEntryFor('0.1.1')?.min, '0.1.1-rc.1')
  // rc.0 precedes rc.1 (and alpha.0 precedes alpha.1), so each stays in the
  // PREVIOUS range: prerelease identifiers order below the next bound.
  assert.equal(harnessCompatEntryFor('0.1.1-rc.0')?.min, '0.1.0-rc.8')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.0')?.min, '0.1.1-rc.1')
  // The exclusive upper bound belongs to the next range, never this one.
  assert.equal(harnessCompatEntryFor('0.1.0-rc.7')?.max, '0.1.0-rc.8')
  assert.equal(harnessCompatEntryFor('0.1.2-alpha.2')?.min, '0.1.2-alpha.2')
})

// ── the gate itself ────────────────────────────────────────────────────────

test('an older harness gets actionable npm upgrade guidance without a hard Loader-ordering throw', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.1.0-rc.8')
  const stderr = captureStderr()
  try {
    const ctx = new Context()
    ctx.provide('cmdlineArgs', { get: () => ['--session', 's1'] })
    ctx.provide('appExit', ((code: number) => { void code }) as never)
    // The normal action installs the process-global model-listing console
    // interception, so this row must unload like any other mounted row.
    t.after(async () => { await ctx.fiber.dispose() })
    assert.doesNotThrow(() => applyStartup(ctx), 'the advisory notice must not block concurrent profile mounting')
    assert.deepEqual((ctx.get(TUI_STARTUP_SERVICE) as { sessionLaunch?: unknown }).sessionLaunch, { kind: 'lookup', query: 's1' })
    const joined = stderr.lines.join('')
    assert.ok(joined.includes(`running dsh 0.1.0-rc.8`), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the npm floor:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_UPGRADE), `stderr must give the exact npm upgrade:\n${joined}`)
    assert.doesNotMatch(joined, /pinned master source|pinned DSH master source distribution/u, `stderr must not keep Source Mode wording:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the published 0.2.2-rc.1 harness version starts normally and provides the service', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.2.2-rc.1')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the startup service must be provided')
    assert.deepEqual((ctx.get(TUI_STARTUP_SERVICE) as { sessionLaunch?: unknown }).sessionLaunch, { kind: 'lookup', query: 's1' })
    assert.equal(stderr.lines.length, 0, 'no gate message on a supported harness')
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the previous 0.2.0-rc.2 family is below the floor and gets the fallback notice', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.2.0-rc.2')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the new floor:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_UPGRADE), `stderr must give the exact npm upgrade:\n${joined}`)
    assert.ok(joined.includes('@xmoon76/dsh-pi-tui@0.5.2-rc.1'),
      `stderr must name the recorded pairing for that family:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the intermediate 0.2.1-rc.1 release is REFUSED at runtime with no TUI pairing', (t) => {
  // The runtime gate, not just the peer range / matrix: a real launcher on the
  // intermediate rc.1 release must be told to upgrade and must NOT be offered a
  // TUI line (the compatibility matrix records that version without a `tui`).
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.2.1-rc.1')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.2.1-rc.1'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the 0.2.2-rc.1 floor:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_UPGRADE), `stderr must give the exact npm upgrade:\n${joined}`)
    assert.doesNotMatch(joined, /compatible TUI line/u,
      `0.2.1-rc.1 has no paired TUI: no fallback line may be advertised:\n${joined}`)
    assert.doesNotMatch(joined, /@xmoon76\/dsh-pi-tui@0\.5\.\d/u,
      `the unsupported rc.1 release must never be told to install a 0.5.x TUI:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('an older alpha.1 line is rejected by the current npm gate', (t) => {
  const life = testLifecycle(t)
  // The npm minimum is >=0.2.0-rc.2; this older alpha line is below the
  // floor and must be refused with the exact npm upgrade.
  const launcher = fakeLauncher(life, '0.1.3-alpha.1')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.3-alpha.1'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_UPGRADE), `stderr must give the exact npm upgrade:\n${joined}`)
    assert.doesNotMatch(joined, /pinned master source|pinned DSH master source distribution/u, `stderr must not keep Source Mode wording:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the previous alpha.3 line is rejected by the 0.2.0-rc.2 npm gate', (t) => {
  const life = testLifecycle(t)
  // The npm minimum is >=0.2.0-rc.2; the previous alpha line is below
  // the floor and must be refused with the exact npm upgrade.
  const launcher = fakeLauncher(life, '0.1.2-alpha.3')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.2-alpha.3'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_UPGRADE), `stderr must give the exact npm upgrade:\n${joined}`)
    assert.doesNotMatch(joined, /pinned master source|pinned DSH master source distribution/u, `stderr must not keep Source Mode wording:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the previous alpha.4/alpha.5 line is rejected by the 0.2.0-rc.2 npm gate', (t) => {
  const life = testLifecycle(t)
  // The npm minimum is >=0.2.0-rc.2: the previous alpha line is below
  // the floor and must be refused with the exact npm upgrade.
  const launcher = fakeLauncher(life, '0.1.2-alpha.5')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.2-alpha.5'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_UPGRADE), `stderr must give the exact npm upgrade:\n${joined}`)
    assert.doesNotMatch(joined, /pinned master source|pinned DSH master source distribution/u, `stderr must not keep Source Mode wording:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the published floor and future stable lines start normally', (t) => {
  for (const version of ['0.2.2-rc.1', '0.2.2', '0.2.3']) {
    const life = testLifecycle(t)
    const launcher = fakeLauncher(life, version)
    try {
      const ctx = mountStartup(t, [])
      assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, `${version} should be supported`)
    } finally {
      launcher.restore()
    }
  }
})

test('the published 0.1.6-alpha.1 harness is refused by the alpha.2 contract gate', (t) => {
  const life = testLifecycle(t)
  // dsh-v0.1.6-alpha.1 is published and works with the older 0.4.7-alpha.1
  // bundle, but the current line depends on the 0.1.7 profile-config and
  // declarative-preset contracts: the user must be told to upgrade (or fall
  // back).
  const launcher = fakeLauncher(life, '0.1.6-alpha.1')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--session', 's1'])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the advisory notice must not block concurrent profile mounting')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes('running dsh 0.1.6-alpha.1'), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes(EXPECTED_REQUIREMENT), `stderr must name the requirement:\n${joined}`)
    assert.ok(joined.includes('@xmoon76/dsh-pi-tui@0.4.7-alpha.1'), `stderr must offer the compatible alpha.1 fallback:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('an unresolvable launcher version does not block startup', (t) => {
  // process.argv[1] points at a path with no @deepseek-ai/dsh manifest: the
  // gate cannot prove incompatibility, so it must not refuse to start.
  const previous = process.argv[1]
  process.argv[1] = join(tmpdir(), 'dsh-startup-gate-nonexistent-bin')
  try {
    const ctx = mountStartup(t, [])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'unknown harness version must not block startup')
  } finally {
    process.argv[1] = previous
  }
})

test('--help never runs the action, on any harness', (t) => {
  const life = testLifecycle(t)
  const launcher = fakeLauncher(life, '0.1.0-rc.8')
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(t, ['--help'])
    assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined, '--help must not provide the startup service')
    assert.equal(stderr.lines.length, 0, '--help must not print the compatibility notice')
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the CLI Session launch grammar maps the launcher argv to ONE intent', (t) => {
  const cases: Array<{ args: string[]; launch: unknown; preset?: string }> = [
    { args: [], launch: undefined },
    { args: ['--session'], launch: { kind: 'browse', query: '' } },
    { args: ['--session='], launch: { kind: 'browse', query: '' } },
    { args: ['--session', ''], launch: { kind: 'browse', query: '' } },
    { args: ['--session', '   '], launch: { kind: 'browse', query: '' } },
    { args: ['--session', 'mysql'], launch: { kind: 'lookup', query: 'mysql' } },
    { args: ['--session=mysql'], launch: { kind: 'lookup', query: 'mysql' } },
    { args: ['--session', ' mysql '], launch: { kind: 'lookup', query: 'mysql' } },
    { args: ['-c'], launch: { kind: 'continue' } },
    { args: ['--continue'], launch: { kind: 'continue' } },
    { args: ['-c', '--preset', 'x'], launch: { kind: 'continue' }, preset: 'x' },
    { args: ['--session', '--preset', 'x'], launch: { kind: 'browse', query: '' }, preset: 'x' },
    { args: ['--session', 'mysql', '--preset', 'x'], launch: { kind: 'lookup', query: 'mysql' }, preset: 'x' },
  ]
  for (const { args, launch, preset } of cases) {
    const ctx = mountStartup(t, args)
    const values = ctx.get(TUI_STARTUP_SERVICE) as { sessionLaunch?: unknown; presetId?: string } | undefined
    assert.ok(values !== undefined, `${args.join(' ')} must publish the startup service`)
    assert.deepEqual(values.sessionLaunch, launch, `${args.join(' ')}: the launch intent`)
    assert.equal(values.presetId, preset, `${args.join(' ')}: the preset is never swallowed by an optional value`)
  }
})

test('a conflicting --session/--continue launch fails before any startup side effect', (t) => {
  for (const args of [['--session', '-c'], ['-c', '--session', 'abc']]) {
    const stderr = captureStderr()
    const consoleBefore = console.error
    try {
      const { ctx, exitCodes, readyListenerCount } = mountStartupWithReady(t, args)
      assert.deepEqual(exitCodes, [1], `${args.join(' ')} must exit nonzero`)
      assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined, 'the startup service is never published')
      assert.equal(readyListenerCount(), 0, 'the readiness handshake is never armed')
      assert.equal(console.error, consoleBefore, 'the model-listing interception is never installed')
      assert.match(stderr.lines.join(''), /--session and --continue are mutually exclusive/u)
    } finally {
      stderr.restore()
    }
  }
})

/** Mount the startup row with captured `appReady` listeners and `appExit` codes. */
function mountStartupWithReady(t: TestContext, args: string[] = []): {
  ctx: Context
  fireReady: () => void
  exitCodes: number[]
  readyListenerCount: () => number
} {
  const exitCodes: number[] = []
  const listeners: (() => void)[] = []
  const ctx = new Context()
  ctx.provide('cmdlineArgs', { get: () => args })
  ctx.provide('appExit', ((code: number) => { exitCodes.push(code) }) as never)
  ctx.provide('appReady', ({
    onReady: (listener: () => void) => { listeners.push(listener); return () => {} },
  }) as never)
  t.after(async () => { await ctx.fiber.dispose() })
  applyStartup(ctx)
  return { ctx, fireReady: () => { for (const listener of [...listeners]) listener() }, exitCodes, readyListenerCount: () => listeners.length }
}

test('committed readiness without a mounted TUI surface exits nonzero with an actionable error', (t) => {
  const { ctx, fireReady, exitCodes } = mountStartupWithReady(t, [])
  const startup = ctx.get(TUI_STARTUP_SERVICE) as { markSurfaceMounted?: () => void } | undefined
  assert.ok(startup !== undefined, 'a normal invocation provides the startup service')
  assert.equal(typeof startup.markSurfaceMounted, 'function', 'the runner mount seam must be provided')
  const stderr = captureStderr()
  try {
    fireReady()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [1], 'a missing required surface must exit nonzero')
  const joined = stderr.lines.join('')
  assert.match(joined, /required TUI surface did not mount/u)
  assert.match(joined, /--profile pi-tui/u)
})

test('a mounted surface leaves committed readiness untouched', (t) => {
  const { ctx, fireReady, exitCodes } = mountStartupWithReady(t, [])
  const startup = ctx.get(TUI_STARTUP_SERVICE) as { markSurfaceMounted?: () => void } | undefined
  startup?.markSurfaceMounted?.()
  const stderr = captureStderr()
  try {
    fireReady()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'a mounted surface must not exit')
  assert.deepEqual(stderr.lines, [])
})

test('--help never arms the missing-surface handshake', (t) => {
  // `--help` runs no action, so the readiness handshake is never registered
  // (commander's own help path exits 0 through appExit, which is unrelated).
  const { ctx, fireReady, exitCodes, readyListenerCount } = mountStartupWithReady(t, ['--help'])
  assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined)
  assert.equal(readyListenerCount(), 0, '--help must not register a readiness listener')
  fireReady()
  assert.deepEqual(exitCodes, [0], 'only commander\'s own help exit is requested')
})

test('incompatibleHarnessMessage is actionable and names both versions', () => {
  const entry = harnessCompatEntryFor('0.1.0-rc.8')
  assert.ok(entry !== undefined, 'rc.8 must match an incompatible entry')
  const message = incompatibleHarnessMessage('0.1.0-rc.8', entry!)
  // The bundle version is read from package.json at runtime (never
  // hardcoded), so the assertion reads it the same way.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }
  assert.ok(message.includes(`dsh-pi-tui v${pkg.version}`), `must name the bundle version: ${message}`)
  assert.ok(message.includes(EXPECTED_REQUIREMENT), 'must name the requirement')
  assert.ok(message.includes('0.1.0-rc.8'), 'must name the installed version')
  assert.ok(message.includes(EXPECTED_UPGRADE), 'must give the exact npm upgrade')
  assert.ok(message.includes('dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.2'), 'must offer the compatible 0.2 fallback for the official rc.8 runtime')
  assert.doesNotMatch(message, /pinned master source|pinned DSH master source distribution/u, 'must not keep Source Mode wording')
})

test('bundleVersionLabel falls back to the release line that imposed the requirement', () => {
  assert.ok(bundleVersionLabel('0.4.0-alpha.1').startsWith('v'), `read version label: ${bundleVersionLabel('0.4.0-alpha.1')}`)
})

test('DSH peer ranges keep the lower-bound compatibility contract', () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dshPeers = Object.entries(packageJson.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  const expectedDevVersion = Object.entries(packageJson.devDependencies ?? {})
    .find(([name]) => name.startsWith('@deepseek-ai/dsh'))?.[1]
  const expectedNpmTarget = process.env.DSH_NPM_VERIFY_TARGET ?? expectedDevVersion
  assert.ok(dshPeers.length > 0, 'the bundle must declare DSH peers')
  // The 0.5.6 candidate lifts the whole peer policy onto the 0.2.2-rc.1
  // floor (the exact family it targets); the previous 0.2.1-rc.* family is no
  // longer claimed.
  for (const [name, range] of dshPeers) {
    assert.equal(range, '>=0.2.2-rc.1', `${name} must use the published-npm DSH compatibility contract`)
    assert.ok(!range.includes('0.1.1'), `${name} must not claim DSH 0.1.1`)
  }
  assert.equal(expectedDevVersion, expectedNpmTarget, 'the package must keep the declared npm target')
  assert.equal(typeof expectedDevVersion, 'string', 'the bundle must declare the primary DSH development target')
  for (const [name, version] of Object.entries(packageJson.devDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) {
      assert.equal(version, expectedDevVersion, `${name} dev dependency must stay exact`)
    }
  }
})

test('harnessCompatEntryFor follows the official DSH tag matrix below the published 0.2.2-rc.1 floor', () => {
  // These entries correspond to the published dsh-v* tags, not invented versions.
  const matrix: readonly [string, string | undefined][] = [
    ['0.1.0-rc.7', undefined],
    ['0.1.0-rc.8', '0.2'],
    ['0.1.1-rc.1', '0.3'],
    ['0.1.1-rc.2', '0.3'],
    ['0.1.2-alpha.1', undefined],
    ['0.1.2-alpha.2', '0.4.0-alpha.1'],
    ['0.1.2-alpha.3', '0.4.0-alpha.1'],
    ['0.1.2-alpha.4', '0.4.0-alpha.2'],
    ['0.1.2-alpha.5', '0.4.0-alpha.2'],
    ['0.1.2-rc.1', '0.4.1'],
    ['0.1.3-alpha.1', undefined],
    ['0.1.3-alpha.2', '0.4.3-alpha.2'],
    ['0.1.5-alpha.1', undefined],
    ['0.1.5-alpha.2', undefined],
    ['0.1.5-rc.1', '0.4.6'],
    ['0.1.5-rc.2', '0.4.6'],
    // Published, but below the current line's alpha.2 Client-contract floor.
    ['0.1.6-alpha.1', '0.4.7-alpha.1'],
    // Published and below the 0.1.7 profile-config/preset floor (PR A):
    // the released 0.4.7-alpha.2 line remains the compatible fallback.
    ['0.1.6-alpha.2', '0.4.7-alpha.2'],
    ['0.1.7-rc.2', '0.5.0'],
    ['0.2.0-rc.1', '0.5.0'],
    // Below the 0.2.1-rc.2 candidate floor. The 0.2.0-rc.2 row keeps its
    // published `next`-channel 0.5.2-rc.1 pairing; 0.2.1-rc.1 has no TUI.
    ['0.2.0-rc.2', '0.5.2-rc.1'],
    ['0.2.0', '0.5.2-rc.1'],
    ['0.2.1-rc.1', undefined],
    // Below the CURRENT 0.2.2-rc.1 floor: the 0.2.1-rc.2 row owns the
    // published 0.5.5 line.
    ['0.2.1-rc.2', '0.5.5'],
    ['0.2.1-rc.5', '0.5.5'],
    ['0.2.1', '0.5.5'],
    ['0.2.2-rc.0', '0.5.5'],
  ]
  for (const [version, fallback] of matrix) {
    const entry = harnessCompatEntryFor(version)
    assert.ok(entry !== undefined, `${version} must match an incompatible entry`)
    assert.equal(entry.upgradeDsh, FLOOR_ENTRY?.upgradeDsh)
    assert.equal(entry.fallbackTui, fallback, `${version} must use its historically compatible TUI line`)
    const message = incompatibleHarnessMessage(version, entry)
    if (fallback === undefined) {
      assert.doesNotMatch(message, /compatible TUI line/u, `${version} must not advertise an unknown fallback`)
    } else {
      assert.ok(message.includes(`@xmoon76/dsh-pi-tui@${fallback}`), `${version} must advertise ${fallback}`)
    }
  }
  assert.equal(harnessCompatEntryFor('0.1.6-alpha.1')?.upgradeDsh, FLOOR_ENTRY?.upgradeDsh, 'the previous alpha.1 is below the floor')
  assert.equal(harnessCompatEntryFor('0.1.6-alpha.2')?.fallbackTui, '0.4.7-alpha.2', 'the released 0.1.6-alpha.2 line falls back to its released TUI')
  const previousRc1 = harnessCompatEntryFor('0.1.7-rc.1')
  assert.equal(previousRc1?.upgradeDsh, FLOOR_ENTRY?.upgradeDsh, 'the previous rc.1 line upgrades to the current target')
  assert.equal(previousRc1?.fallbackTui, '0.4.8', 'rc.1 remains paired with the released 0.4.8 line')
  assert.equal(harnessCompatEntryFor('0.2.2-rc.1'), undefined, 'the published npm floor is supported')
  assert.equal(harnessCompatEntryFor('0.2.2'), undefined, 'the stable line above the floor is supported')
  assert.equal(harnessCompatEntryFor('0.2.3'), undefined)
  assert.equal(harnessCompatEntryFor('1.0.0'), undefined)
})

// ── the temporary model-listing log interception ─────────────────────────
//
// The official llm-deepseek-account and llm-deepseek-api-key providers send
// their model-listing diagnostics to console.error/console.warn with the
// provider tag as the first argument. Those lines corrupt the full-screen
// TUI, so the startup row diverts exactly those tagged lines to
// `$DSH_HOME/logs/dsh-model-listing-<pid>.log`.

/** The provider tags the official DSH providers use, exactly as
 * `createModelListingCache` builds them from the provider plugin name. */
const ACCOUNT_TAG = '[llm-deepseek-account]'
const API_KEY_TAG = '[llm-deepseek-api-key]'

/** Capture console.error/console.warn calls made through the CURRENT
 * console methods, restoring the previous identity at teardown. */
function captureConsole(): {
  errors: unknown[][]
  warns: unknown[][]
  restore: () => void
} {
  const errors: unknown[][] = []
  const warns: unknown[][] = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]) => { errors.push(args) }
  console.warn = (...args: unknown[]) => { warns.push(args) }
  return {
    errors,
    warns,
    restore: () => {
      console.error = originalError
      console.warn = originalWarn
    },
  }
}

/** Point `$DSH_HOME` at an isolated directory for the duration of a test. */
function isolatedDshHome(life: TestLifecycle): { home: string, restore: () => void } {
  const home = life.tempDir('dsh-model-listing-home-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

/** The log file path the interception must use under the given home. */
function listingLogPath(home: string): string {
  return join(home, 'logs', `dsh-model-listing-${process.pid}.log`)
}

test('both provider tags are diverted to the log file and leave the terminal untouched', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  try {
    console.error(ACCOUNT_TAG, 'model listing from https://example.test/models loaded 3 model(s), skipped 0 row(s)')
    console.warn(API_KEY_TAG, 'model listing from https://example.test/models failed (boom); using the bundled catalog')
    console.error(API_KEY_TAG, 'model listing from https://example.test/models loaded 1 model(s), skipped 2 row(s)')
    console.warn(ACCOUNT_TAG, 'model "hidden-model" is not supported by this client')

    assert.deepEqual(terminal.errors, [], 'no matching console.error may reach the terminal')
    assert.deepEqual(terminal.warns, [], 'no matching console.warn may reach the terminal')

    const path = listingLogPath(home.home)
    assert.ok(existsSync(path), `the log file must exist at ${path}`)
    const content = readFileSync(path, 'utf8')
    assert.match(content, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[llm-deepseek-account\] model listing from https:\/\/example\.test\/models loaded 3 model\(s\), skipped 0 row\(s\)$/mu,
      `the account success line must keep its tag and message:\n${content}`)
    assert.match(content, /\[llm-deepseek-api-key\] model listing from https:\/\/example\.test\/models failed \(boom\); using the bundled catalog$/mu,
      `the api-key failure line must keep its tag and message:\n${content}`)
    assert.match(content, /\[llm-deepseek-api-key\] model listing from https:\/\/example\.test\/models loaded 1 model\(s\), skipped 2 row\(s\)$/mu,
      `the api-key success line must keep its tag and message:\n${content}`)
    assert.match(content, /\[llm-deepseek-account\] model "hidden-model" is not supported by this client$/mu,
      `the account catalog problem must keep its tag and message:\n${content}`)
    assert.equal(content.split('\n').filter(line => line !== '').length, 4, 'exactly the four matching lines are recorded')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('unrelated console output still reaches the terminal', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  try {
    console.warn('some other warning')
    console.error('some other error')
    console.warn('[llm-deepseek-other]', 'a different provider tag')
    console.error(`${ACCOUNT_TAG} suffix`, 'a tag that only starts the same')
    console.error(ACCOUNT_TAG, { not: 'a string message' })
    console.error(ACCOUNT_TAG, 'model listing failed', new Error('an extra argument'))

    assert.equal(terminal.warns.length, 2, 'the unrelated warnings must reach the terminal')
    assert.equal(terminal.errors.length, 4, 'the unrelated errors must reach the terminal')
    assert.ok(!existsSync(listingLogPath(home.home)), 'no unrelated output may create the log file')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('--help installs no interception and creates no log file', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const ctx = mountStartup(t, ['--help'])
  try {
    console.error(ACCOUNT_TAG, 'a tagged line after --help')
    assert.equal(terminal.errors.length, 1, '--help must not intercept the console')
    assert.ok(!existsSync(listingLogPath(home.home)), '--help must not create the log file')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('a Host-only process installs no interception', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const previousRole = process.env.DSH_PI_TUI_ROLE
  const previousEntry = process.env.DSH_PI_TUI_HOST_ENTRY
  // `isHostOnlyRole()` requires the marker to name the running main module
  // and that module to be the internal `local-host.mjs` artifact, so the
  // fixture points both at a fabricated file with that exact basename.
  const hostEntry = join(life.tempDir('dsh-host-only-'), 'local-host.mjs')
  writeFileSync(hostEntry, '')
  const previousArgv = process.argv[1]
  process.argv[1] = hostEntry
  process.env.DSH_PI_TUI_ROLE = 'host'
  process.env.DSH_PI_TUI_HOST_ENTRY = hostEntry
  const ctx = mountStartup(t, [])
  try {
    console.error(ACCOUNT_TAG, 'a tagged line in a Host-only process')
    assert.equal(terminal.errors.length, 1, 'a Host-only process must keep its own console behavior')
    assert.ok(!existsSync(listingLogPath(home.home)), 'a Host-only process must not create the log file')
  } finally {
    process.argv[1] = previousArgv
    if (previousRole === undefined) delete process.env.DSH_PI_TUI_ROLE
    else process.env.DSH_PI_TUI_ROLE = previousRole
    if (previousEntry === undefined) delete process.env.DSH_PI_TUI_HOST_ENTRY
    else process.env.DSH_PI_TUI_HOST_ENTRY = previousEntry
    terminal.restore()
    home.restore()
  }
})

test('an unwritable log directory keeps the diagnostic on the terminal', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  // A regular file where the logs directory must be makes both the directory
  // creation and the file open fail.
  mkdirSync(home.home, { recursive: true })
  writeFileSync(join(home.home, 'logs'), 'not a directory')
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  try {
    console.error(ACCOUNT_TAG, 'model listing from https://example.test/models loaded 3 model(s)')
    assert.equal(terminal.errors.length, 1, 'a write failure must fall back to the terminal')
    assert.deepEqual(terminal.errors[0], [ACCOUNT_TAG, 'model listing from https://example.test/models loaded 3 model(s)'],
      'the original tag and message must be preserved')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('unloading the startup row restores the console methods', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const originalError = console.error
  const originalWarn = console.warn
  const ctx = mountStartup(t, [])
  try {
    assert.notEqual(console.error, originalError, 'the interception must be installed')
    assert.notEqual(console.warn, originalWarn, 'the interception must be installed')
    await ctx.fiber.dispose()
    assert.equal(console.error, originalError, 'unloading must restore console.error')
    assert.equal(console.warn, originalWarn, 'unloading must restore console.warn')
  } finally {
    console.error = originalError
    console.warn = originalWarn
    home.restore()
  }
})

test('a wrapper still held by another owner passes through after unload', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  const heldWrapper = console.error
  await ctx.fiber.dispose()
  try {
    heldWrapper(ACCOUNT_TAG, 'model listing from https://example.test/models loaded 1 model(s)')
    assert.equal(terminal.errors.length, 1, 'a wrapper held past unload must fall back to the original')
    assert.ok(!existsSync(listingLogPath(home.home)), 'a wrapper held past unload must not reopen the log')
  } finally {
    terminal.restore()
    home.restore()
  }
})

/** Count the non-empty lines of the interception's log file. */
function listingLogLines(home: string): number {
  return readFileSync(listingLogPath(home), 'utf8').split('\n').filter(line => line !== '').length
}

test('a re-applied row shares the chain instead of nesting a second wrapper', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const first = mountStartup(t, [])
  const firstError = console.error
  const second = mountStartup(t, [])
  try {
    assert.equal(console.error, firstError, 'the re-applied row must not nest another wrapper')
    console.error(ACCOUNT_TAG, 'a tagged line after re-applying')
    assert.deepEqual(terminal.errors, [], 'the tagged line must not reach the terminal')
    assert.equal(listingLogLines(home.home), 1, 'the tagged line must be recorded exactly once')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('releasing the older owner first keeps the interception until the last owner unloads', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const preInstallError = console.error
  const preInstallWarn = console.warn
  const older = mountStartup(t, [])
  const newer = mountStartup(t, [])
  try {
    await older.fiber.dispose()
    assert.notEqual(console.error, preInstallError, 'the interception stays installed while an owner remains')
    console.warn(API_KEY_TAG, 'model listing from https://example.test/models loaded 2 model(s)')
    assert.deepEqual(terminal.warns, [], 'the remaining owner still diverts tagged output')
    await newer.fiber.dispose()
    assert.equal(console.error, preInstallError, 'the last owner unload restores console.error')
    assert.equal(console.warn, preInstallWarn, 'the last owner unload restores console.warn')
    console.error(ACCOUNT_TAG, 'a tagged line after the last owner unloaded')
    assert.equal(terminal.errors.length, 1, 'a closed interception must not reopen the log')
    assert.equal(listingLogLines(home.home), 1, 'the closed interception must not append after unload')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('releasing the newer owner first keeps the interception until the last owner unloads', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const preInstallError = console.error
  const preInstallWarn = console.warn
  const older = mountStartup(t, [])
  const newer = mountStartup(t, [])
  try {
    await newer.fiber.dispose()
    assert.notEqual(console.error, preInstallError, 'the remaining owner keeps the interception installed')
    console.error(ACCOUNT_TAG, 'model listing from https://example.test/models loaded 3 model(s)')
    assert.deepEqual(terminal.errors, [], 'the remaining owner still diverts tagged output')
    await older.fiber.dispose()
    assert.equal(console.error, preInstallError, 'the last owner unload restores console.error')
    assert.equal(console.warn, preInstallWarn, 'the last owner unload restores console.warn')
    console.warn(API_KEY_TAG, 'a tagged line after the last owner unloaded')
    assert.equal(terminal.warns.length, 1, 'a closed interception must not reopen the log')
    assert.equal(listingLogLines(home.home), 1, 'the closed interception must not append after unload')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('the log file is created with owner-only permissions', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  try {
    console.warn(ACCOUNT_TAG, 'model "hidden-model" is not supported by this client')
    const mode = statSync(listingLogPath(home.home)).mode & 0o777
    assert.equal(mode, 0o600, `the log file must be owner-only, got ${mode.toString(8)}`)
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('a session that never lists models leaves no log file behind', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  try {
    console.warn('an unrelated warning')
    assert.ok(!existsSync(listingLogPath(home.home)), 'no matching message must not create the log file')
  } finally {
    terminal.restore()
    home.restore()
  }
})

test('an existing log file keeps its earlier lines', async (t) => {
  const life = testLifecycle(t)
  const home = isolatedDshHome(life)
  mkdirSync(join(home.home, 'logs'), { recursive: true })
  writeFileSync(listingLogPath(home.home), 'an earlier line from a previous run\n')
  const terminal = captureConsole()
  const ctx = mountStartup(t, [])
  try {
    console.warn(API_KEY_TAG, 'model listing from https://example.test/models failed (boom); using the bundled catalog')
    const content = readFileSync(listingLogPath(home.home), 'utf8')
    assert.ok(content.startsWith('an earlier line from a previous run\n'), `the existing content must be kept:\n${content}`)
    assert.match(content, /\[llm-deepseek-api-key\] model listing from https:\/\/example\.test\/models failed \(boom\); using the bundled catalog$/mu)
  } finally {
    terminal.restore()
    home.restore()
  }
})
