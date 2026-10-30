/**
 * I8-3 — offline validation of the WT E3 evidence manifest.
 *
 * A manifest row may only claim `PASS` when the offline-verifiable facts agree:
 * the screenshot exists, its SHA-256 matches the recorded digest, its PNG IHDR
 * size matches the recorded physical frame bounds, the phase/run/case identity
 * is consistent across the row, the subject trace exists and hashes to the
 * recorded digest, and a `PASS` row proves a trusted DCS was written by the
 * production Screen. This test never opens a window: it exists so a fabricated
 * or inconsistent manifest cannot pass an E3 review.
 * @module @xmoon76/dsh-pi-tui/tooling/wt-sixel-e3-manifest.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { readWtE3Manifest, validateWtE3Manifest, validateWtE3Row } from '../support/wt-sixel-e3-manifest.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A real 2x2 PNG: enough for the IHDR check, too small to be a screenshot. */
const PNG_2x2 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxAADQAAAJgAB63c4mQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

interface Workspace {
  readonly root: string
}

function workspace(t: test.TestContext): Workspace {
  // Repository rule: every test-created fixture directory goes through
  // `testLifecycle`, which owns the run root and its teardown.
  const root = testLifecycle(t).tempDir('wt-e3-manifest-')
  mkdirSync(join(root, 'screenshots'), { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
  return { root }
}

function soundRow(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const png = join(root, 'screenshots', 'I8-3-R-WT01-before.png')
  writeFileSync(png, PNG_2x2)
  const log = join(root, 'logs', 'WT01.events.jsonl')
  const trace = [
    { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: 'abc', tty: { stdin: true, stdout: true }, mux: {} },
    { at: 2, kind: 'da1-sixel', supported: true },
    { at: 3, kind: 'write', bytes: 40, dcs: true, dcsBytes: 32, clears2K: 3 },
    { at: 4, kind: 'ready' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  writeFileSync(log, `${trace}\n`)
  return {
    run_id: 'I8-3-20261030T000000Z',
    case_id: 'WT01',
    phase: 'before',
    git_sha: 'f636996088c3d7cd3ca9ed52d2e7e855e4e00c91',
    lane: 'DETERMINISTIC_PRODUCT_GUI',
    topology: 'WT_REAL_GUI>WSL2_D13>REAL_ProcessTerminal>REAL_TuiApp>Screen>Terminal.write; DSH_Host=ABSENT',
    window_hwnd: '0x1A2B',
    terminal_size_cells: [100, 32],
    da1_has_attribute_4: true,
    screenshot_before: 'I8-3-R-WT01-before.png',
    screenshot_sha256: sha256(PNG_2x2),
    screenshot_physical_bounds: [100, 200, 102, 202],
    events_relative_path: 'logs/WT01.events.jsonl',
    oracle: { expected_band: 5, observed_band: 5, dcs_written: true },
    result: 'PASS',
    visual_owner_accepted: false,
    ...overrides,
  }
}

/** The ONE per-case row that owns the trace digest. */
function traceRow(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const log = join(root, 'logs', 'WT01.events.jsonl')
  if (!existsSync(log)) {
    // A trace row is validated against its artifact; create the default one so a
    // test that only cares about the row's own fields is not silently ordering-
    // dependent on another fixture having run first.
    writeFileSync(
      log,
      `${[
        { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: 'abc', tty: { stdin: true, stdout: true }, mux: {} },
        { at: 2, kind: 'da1-sixel', supported: true },
        { at: 3, kind: 'write', bytes: 40, dcs: true, dcsBytes: 32 },
        { at: 4, kind: 'shutdown', reason: 'SIGHUP' },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    )
  }
  return {
    run_id: 'I8-3-20261030T000000Z',
    case_id: 'WT01',
    phase: 'trace',
    events_relative_path: 'logs/WT01.events.jsonl',
    vt_out_sha256: sha256(new Uint8Array(readFileSync(log))),
    result: 'PASS',
    pixels_expected: true,
    ...overrides,
  }
}

test('a consistent PASS row validates', (t) => {
  const { root } = workspace(t)
  const verdict = validateWtE3Row(soundRow(root), { root })
  assert.deepEqual(verdict.failures, [])
  assert.equal(verdict.ok, true)
})

test('a screenshot whose bytes do not match the digest fails', (t) => {
  const { root } = workspace(t)
  const row = soundRow(root, { screenshot_sha256: 'a'.repeat(64) })
  const verdict = validateWtE3Row(row, { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('screenshot sha256')), verdict.failures.join('; '))
})

test('a screenshot whose IHDR size disagrees with the recorded bounds fails', (t) => {
  const { root } = workspace(t)
  const row = soundRow(root, { screenshot_physical_bounds: [0, 0, 800, 600] })
  const verdict = validateWtE3Row(row, { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('IHDR')), verdict.failures.join('; '))
})

test('a PASS row without a trusted DCS in its trace fails', (t) => {
  const { root } = workspace(t)
  const row = soundRow(root)
  const log = join(root, 'logs', 'WT01.events.jsonl')
  writeFileSync(
    log,
    `${[
      { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: 'abc', tty: { stdin: true, stdout: true }, mux: {} },
      { at: 2, kind: 'da1-sixel', supported: true },
      { at: 3, kind: 'write', bytes: 10, dcs: false, clears2K: 0 },
      { at: 4, kind: 'ready' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  )
  const verdict = validateWtE3Row(traceRow(root), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('DCS')), verdict.failures.join('; '))
})

test('a PASS row whose DA1 did not declare SIXEL fails', (t) => {
  const { root } = workspace(t)
  const verdict = validateWtE3Row(soundRow(root, { da1_has_attribute_4: false }), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('DA1')), verdict.failures.join('; '))
})

test('a trace row whose DA1 observation denied SIXEL fails', (t) => {
  const { root } = workspace(t)
  const log = join(root, 'logs', 'WT01.events.jsonl')
  writeFileSync(
    log,
    `${[
      { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: 'abc', tty: { stdin: true, stdout: true }, mux: {} },
      { at: 2, kind: 'da1-sixel', supported: false },
      { at: 3, kind: 'write', bytes: 40, dcs: true, dcsBytes: 32 },
      { at: 4, kind: 'shutdown', reason: 'SIGHUP' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  )
  const verdict = validateWtE3Row(traceRow(root), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('DA1')), verdict.failures.join('; '))
})

test('a case that must paint no pixels fails when it does paint', (t) => {
  const { root } = workspace(t)
  const verdict = validateWtE3Row(traceRow(root, { pixels_expected: false }), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('must paint NO pixels')), verdict.failures.join('; '))
})

test('a PASS row inside a multiplexer topology fails', (t) => {
  const { root } = workspace(t)
  const row = soundRow(root)
  const log = join(root, 'logs', 'WT01.events.jsonl')
  writeFileSync(
    log,
    `${[
      { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: 'abc', tty: { stdin: true, stdout: true }, mux: { tmux: '/tmp/tmux-1000/default,123,0' } },
      { at: 2, kind: 'da1-sixel', supported: true },
      { at: 3, kind: 'write', bytes: 40, dcs: true, dcsBytes: 32, clears2K: 3 },
      { at: 4, kind: 'ready' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  )
  const verdict = validateWtE3Row(traceRow(root), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('multiplexer')), verdict.failures.join('; '))
})

test('a row that lacks a real WT_SESSION fails', (t) => {
  const { root } = workspace(t)
  const row = soundRow(root, {})
  const log = join(root, 'logs', 'WT01.events.jsonl')
  writeFileSync(
    log,
    `${[
      { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: null, tty: { stdin: true, stdout: true }, mux: {} },
      { at: 2, kind: 'da1-sixel', supported: true },
      { at: 3, kind: 'write', bytes: 40, dcs: true, dcsBytes: 32, clears2K: 3 },
      { at: 4, kind: 'ready' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  )
  const verdict = validateWtE3Row(traceRow(root), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('WT_SESSION')), verdict.failures.join('; '))
})

test('a video-terminal claim from a VirtualTerminal is rejected by the topology field', (t) => {
  const { root } = workspace(t)
  const verdict = validateWtE3Row(soundRow(root, { topology: 'VirtualTerminal>Screen' }), { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('topology')), verdict.failures.join('; '))
})

test('a trace that is not the one recorded does not validate', (t) => {
  const { root } = workspace(t)
  const row = traceRow(root)
  const log = join(root, 'logs', 'WT01.events.jsonl')
  writeFileSync(log, `${JSON.stringify({ at: 1, kind: 'ready' })}\n`)
  const verdict = validateWtE3Row(row, { root })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.failures.some((failure: string) => failure.includes('trace sha256')), verdict.failures.join('; '))
})

test('a non-PASS row records its status without pretending to be verified', (t) => {
  const { root } = workspace(t)
  const verdict = validateWtE3Row(soundRow(root, { result: 'GUI_BLOCKED', screenshot_before: null }), { root })
  assert.equal(verdict.ok, true, 'a blocked row is a legitimate record')
  assert.equal(verdict.countedAsPass, false)
})

test('a frame with no trace row does not count as a verified case (RFL-001)', (t) => {
  const { root } = workspace(t)
  const path = join(root, 'manifest.jsonl')
  // The frame is internally consistent on purpose: correct screenshot digest, IHDR
  // matching the recorded bounds, and a SELF-DECLARED DA1 attribute. Before the fix
  // this single row counted as a pass, which is exactly the weak-evidence green
  // manifest the E3 gate exists to prevent.
  writeFileSync(path, `${JSON.stringify(soundRow(root))}\n`)
  const verdict = validateWtE3Manifest(path, { root })
  assert.equal(verdict.passes, 0, 'a frame without its trace proves no terminal facts')
  assert.ok(verdict.caseFailures.some((failure: string) => failure.includes('no trace row')), verdict.caseFailures.join('; '))
})

test('a case whose trace failed is not counted even when its frame is sound', (t) => {
  const { root } = workspace(t)
  const path = join(root, 'manifest.jsonl')
  const log = join(root, 'logs', 'WT01.events.jsonl')
  // `soundRow` seeds a good trace; overwrite it AFTERWARDS with a trace that proves
  // no real WT_SESSION, so the frame stays sound while its case trace fails.
  const frame = soundRow(root)
  writeFileSync(
    log,
    `${[
      { at: 1, kind: 'before-start', columns: 100, rows: 32, wtSession: null, tty: { stdin: true }, mux: {} },
      { at: 2, kind: 'da1-sixel', supported: true },
      { at: 3, kind: 'write', bytes: 40, dcs: true },
      { at: 4, kind: 'shutdown-final' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  )
  writeFileSync(path, `${JSON.stringify(frame)}\n${JSON.stringify(traceRow(root))}\n`)
  const verdict = validateWtE3Manifest(path, { root })
  assert.equal(verdict.passes, 0)
  assert.ok(verdict.caseFailures.some((failure: string) => failure.includes('trace row failed')), verdict.caseFailures.join('; '))
})

test('a sound frame plus sound trace counts exactly one verified CASE', (t) => {
  const { root } = workspace(t)
  const path = join(root, 'manifest.jsonl')
  writeFileSync(path, `${JSON.stringify(soundRow(root))}\n${JSON.stringify(traceRow(root))}\n`)
  const verdict = validateWtE3Manifest(path, { root })
  assert.equal(verdict.passes, 1)
  assert.deepEqual(verdict.verifiedCases, ['WT01'])
  assert.deepEqual(verdict.caseFailures, [])
})

test('an unclean-tree run is refused when the caller requires a frozen tree', (t) => {
  const { root } = workspace(t)
  const path = join(root, 'manifest.jsonl')
  writeFileSync(
    path,
    `${JSON.stringify(soundRow(root, { git_status_clean: false }))}\n${JSON.stringify(traceRow(root, { git_status_clean: false }))}\n`,
  )
  assert.equal(validateWtE3Manifest(path, { root }).passes, 1, 'without the flag the case is still a sound record')
  const frozen = validateWtE3Manifest(path, { root, requireCleanTree: true })
  assert.equal(frozen.passes, 0)
  assert.ok(frozen.caseFailures.some((failure: string) => failure.includes('unclean tree')), frozen.caseFailures.join('; '))
})

test('the manifest reader parses JSONL rows and reports the file it read', (t) => {
  const { root } = workspace(t)
  const path = join(root, 'manifest.jsonl')
  writeFileSync(path, `${JSON.stringify(soundRow(root))}\n${JSON.stringify(soundRow(root, { phase: 'after' }))}\n`)
  const rows = readWtE3Manifest(path)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].case_id, 'WT01')
  assert.equal(rows[1].phase, 'after')
})
