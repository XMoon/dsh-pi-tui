/**
 * Headless tests for the startup compatibility gate: on a DeepSeek Harness
 * older than the minimum (dsh-v0.1.1-rc.1) the TUI must fail with an
 * ACTIONABLE message — the loader cannot even resolve the authorization row
 * the profile mounts on such a harness, and a raw ERR_MODULE_NOT_FOUND
 * stack would tell the user nothing. The gate prints the friendly message
 * first, then fails the startup row with the same text as its cause.
 * `--help` stays available on any harness (the action never runs).
 * @module @xmoon76/dsh-pi-tui/startup.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyStartup, TUI_STARTUP_SERVICE, HARNESS_COMPAT, bundleVersionLabel, harnessCompatEntryFor, incompatibleHarnessMessage } from '../src/startup.ts'
import { versionAtLeast } from '../src/dsh-version.ts'

/** Point process.argv[1] at a fabricated @deepseek-ai/dsh package whose
 * version the launcher walk resolves. */
function fakeLauncher(version: string): { restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-gate-'))
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

test('an older harness fails startup with the actionable message', () => {
  const launcher = fakeLauncher('0.1.0-rc.8')
  const stderr = captureStderr()
  try {
    const ctx = new Context()
    ctx.provide('cmdlineArgs', { get: () => ['--session', 's1'] })
    ctx.provide('appExit', ((code: number) => { void code }) as never)
    assert.throws(() => applyStartup(ctx), (error: Error) => error.message.includes('requires DeepSeek Harness 0.1.1-rc.1'))
    assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined, 'the startup service must not be provided on an old harness')
    const joined = stderr.lines.join('')
    assert.ok(joined.includes(`running dsh 0.1.0-rc.8`), `stderr must name the installed version:\n${joined}`)
    assert.ok(joined.includes('Upgrade dsh first'), `stderr must give the upgrade path:\n${joined}`)
  } finally {
    stderr.restore()
    launcher.restore()
  }
})

test('the minimum harness version starts normally and provides the service', () => {
  const launcher = fakeLauncher('0.1.1-rc.1')
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

test('a newer harness line also starts normally', () => {
  const launcher = fakeLauncher('0.1.1-rc.2')
  try {
    const ctx = mountStartup([])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined)
  } finally {
    launcher.restore()
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
  assert.ok(message.includes('DeepSeek Harness 0.1.1-rc.1 or later'), 'must name the requirement')
  assert.ok(message.includes('0.1.0-rc.8'), 'must name the installed version')
  assert.ok(message.includes('npm install -g @deepseek-ai/dsh@0.1.1-rc.1'), 'must give the upgrade command')
})

test('bundleVersionLabel falls back to the release line that imposed the requirement', () => {
  assert.ok(bundleVersionLabel('0.3.0').startsWith('v'), `read version label: ${bundleVersionLabel('0.3.0')}`)
})

test('harnessCompatEntryFor covers the incompatible range and lets newer lines through', () => {
  const entry = HARNESS_COMPAT.find(candidate => candidate.max === '0.1.1-rc.1')
  assert.ok(entry !== undefined, 'the pre-rc.1 entry must exist')
  assert.equal(entry?.since, '0.3.0')
  assert.equal(harnessCompatEntryFor('0.1.0-rc.8'), entry, 'rc.8 is incompatible')
  assert.equal(harnessCompatEntryFor('0.1.0-rc.1'), entry, 'rc.1 is incompatible')
  assert.equal(harnessCompatEntryFor('0.1.1-rc.1'), undefined, 'the floor itself is supported')
  assert.equal(harnessCompatEntryFor('0.1.1-rc.2'), undefined)
  assert.equal(harnessCompatEntryFor('0.1.1'), undefined)
  assert.equal(harnessCompatEntryFor('1.0.0'), undefined)
})
