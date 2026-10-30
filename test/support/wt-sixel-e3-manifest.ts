/**
 * I8-3 WT GUI evidence — the offline manifest validator (test harness).
 *
 * Lives in `test/support/` because it is test-only: it re-derives what a manifest
 * row claims and never runs as product code.
 *
 * This module is the OFFLINE half of the E3 gate. It cannot take a screenshot
 * and does not try: it re-derives every fact a manifest row claims from the
 * artifacts that row names (screenshot bytes, PNG IHDR, subject trace), and it
 * refuses a `PASS` whose physical story is incomplete. The online half is
 * `scripts/wt-sixel-e3-drive.mjs`, which produces those artifacts.
 *
 * A manifest has three row kinds and each owns DIFFERENT facts:
 * - a FRAME row (`before`, `scrolled`, `expanded`, ...) owns one screenshot and
 *   must match its own SHA-256 and PNG IHDR against the recorded frame bounds;
 * - an `*.input` row records one delivered OS operation and carries no picture;
 * - ONE `trace` row per case owns the subject log digest plus the DA1, tty,
 *   multiplexer and DCS/pixel-expectation story.
 *
 * Only an internally consistent `PASS` frame counts as verified; `GUI_BLOCKED`
 * and `FAIL` are legitimate records and are never counted as passes.
 * @module @xmoon76/dsh-pi-tui/test/support/wt-sixel-e3-manifest
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The topology strings this validator accepts as a REAL terminal GUI lane. */
const REAL_GUI_TOPOLOGY = /WT_REAL_GUI>WSL2_/u

/** One manifest row, as the drive writes it. Every field is optional: a row that
 *  omits a required fact FAILS validation instead of defaulting to a pass. */
export interface WtE3Row {
  readonly run_id?: string
  readonly case_id?: string
  readonly phase?: string
  readonly result?: string
  readonly reason?: string
  readonly topology?: string
  readonly action?: string
  readonly window_hwnd?: string | null
  readonly terminal_size_cells?: readonly number[]
  readonly da1_has_attribute_4?: boolean | null
  readonly screenshot_before?: string | null
  readonly screenshot_after?: string | null
  readonly screenshot_sha256?: string
  readonly screenshot_physical_bounds?: readonly number[] | null
  readonly events_relative_path?: string
  readonly vt_out_sha256?: string | null
  readonly pixels_expected?: boolean
  readonly oracle?: { readonly dcs_written?: boolean; readonly dcs_writes?: number; readonly pixels_expected?: boolean } | null
  readonly [key: string]: unknown
}

/** The facts one validated row established, for a report. */
export interface WtE3RowFacts {
  screenshot?: { name: string; sha256: string; bytes: number }
  pngSize?: { width: number; height: number }
  trace?: { name: string; sha256: string }
  trustedDcsWrites?: number
  frameDcs?: boolean
}

/** The verdict for ONE row. */
export interface WtE3RowVerdict {
  readonly ok: boolean
  readonly countedAsPass: boolean
  readonly failures: readonly string[]
  readonly facts: WtE3RowFacts
}

/** The verdict for a whole manifest. */
export interface WtE3ManifestVerdict {
  readonly rows: readonly { row: WtE3Row; verdict: WtE3RowVerdict }[]
  readonly byCase: ReadonlyMap<string, readonly { row: WtE3Row; verdict: WtE3RowVerdict }[]>
  /** CASES whose frames are all verified AND whose trace closed them. */
  readonly passes: number
  /** The case ids counted in {@link passes}. */
  readonly verifiedCases: readonly string[]
  /** Rows whose own artifacts contradict them, plus per-case closure failures. */
  readonly failures: number
  /** Case-level reasons a case cannot be counted as verified. */
  readonly caseFailures: readonly string[]
}

interface TraceEntry {
  readonly at?: number
  readonly kind?: string
  readonly dcs?: boolean
  readonly wtSession?: string | null
  readonly supported?: boolean
  readonly tty?: { readonly stdin?: boolean; readonly stdout?: boolean }
  readonly mux?: { readonly tmux?: string | null; readonly zellij?: string | null; readonly sty?: string | null }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Width/height from a PNG's IHDR chunk, or `undefined` when it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  if (view.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
}

/** Read a JSONL manifest and return its rows, failing on a malformed line. */
export function readWtE3Manifest(path: string): WtE3Row[] {
  const text = readFileSync(path, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as WtE3Row
      } catch {
        throw new Error(`manifest line ${index + 1} is not valid JSON: ${line.slice(0, 120)}`)
      }
    })
}

function readTrace(eventsPath: string): TraceEntry[] {
  return readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceEntry)
}

/**
 * Validate ONE manifest row against its artifacts.
 *
 * @param row - the manifest row.
 * @param options.root - the run directory the row's relative artifact names
 *   resolve against.
 */
export function validateWtE3Row(row: WtE3Row, options: { readonly root: string }): WtE3RowVerdict {
  const root = resolve(options.root)
  const failures: string[] = []
  const facts: WtE3RowFacts = {}
  const pass = row.result === 'PASS'

  if (typeof row.case_id !== 'string' || row.case_id === '') failures.push('case_id is missing')
  if (typeof row.phase !== 'string' || row.phase === '') failures.push('phase is missing')
  if (typeof row.run_id !== 'string' || row.run_id === '') failures.push('run_id is missing')

  // A fabricated VirtualTerminal story can never masquerade as a GUI lane. Only a
  // FRAME row claims pixels, so only a frame row is judged by its topology.
  const frameRow = isFrameRow(row)
  if (pass && frameRow && !REAL_GUI_TOPOLOGY.test(String(row.topology ?? ''))) {
    failures.push(`topology is not a real WT GUI lane: ${row.topology}`)
  }

  // The ONE per-case trace row: the only row that owns the trace digest, and the
  // only one that may assert DA1 / tty / mux / DCS facts.
  if (row.phase === 'trace') {
    // The row's own status is a fact: a trace recorded as GUI_BLOCKED/FAIL cannot
    // close a case just because its file is well formed.
    if (row.result !== 'PASS') failures.push(`trace row is not PASS (${String(row.result)})`)
    const eventsName = row.events_relative_path
    if (typeof eventsName !== 'string' || eventsName === '') {
      failures.push('a trace row must name its events file')
    } else {
      const eventsPath = join(root, eventsName)
      if (!existsSync(eventsPath)) {
        failures.push(`subject trace does not exist: ${eventsName}`)
      } else {
        const bytes = readFileSync(eventsPath)
        const digest = sha256(bytes)
        facts.trace = { name: eventsName, sha256: digest }
        if (digest !== row.vt_out_sha256) failures.push('trace sha256 does not match the recorded digest')
        const entries = readTrace(eventsPath)
        const start = entries.find((entry) => entry.kind === 'before-start')
        const da1 = entries.find((entry) => entry.kind === 'da1-sixel')
        const trustedDcs = entries.filter((entry) => entry.kind === 'write' && entry.dcs === true)
        facts.trustedDcsWrites = trustedDcs.length
        if (start === undefined) {
          failures.push('trace has no before-start record')
        } else {
          if (start.wtSession === null || start.wtSession === undefined || start.wtSession === '') {
            failures.push('trace proves no real WT_SESSION on the tty')
          }
          const mux = start.mux ?? {}
          if ((mux.tmux ?? '') !== '' || (mux.zellij ?? '') !== '' || (mux.sty ?? '') !== '') {
            failures.push(`trace shows a multiplexer topology: ${JSON.stringify(mux)}`)
          }
          if (start.tty?.stdin !== true) failures.push('trace shows no real tty on stdin')
        }
        if (da1 === undefined) failures.push('trace has no DA1 observation')
        else if (da1.supported !== true) failures.push('trace DA1 observation did not admit SIXEL')
        const pixelsExpected = row.pixels_expected !== false
        if (pixelsExpected && trustedDcs.length === 0) {
          failures.push('trace records no trusted DCS write from the production Screen')
        }
        if (!pixelsExpected && trustedDcs.length > 0) {
          failures.push('this case must paint NO pixels, but the trace records a trusted DCS write')
        }
      }
    }
    return { ok: failures.length === 0, countedAsPass: false, failures, facts }
  }

  // A `cleanup` row records whether this case's window really went away. It has
  // no screenshot and must not be judged as a frame.
  if (row.phase === 'cleanup') {
    if (row.result !== 'PASS' && row.result !== 'FAIL') failures.push('a cleanup row must be PASS or FAIL')
    return { ok: failures.length === 0, countedAsPass: false, failures, facts }
  }

  // An `.input` row records a delivered OS operation, not a frame.
  if (typeof row.phase === 'string' && row.phase.endsWith('.input')) {
    if (typeof row.action !== 'string' || row.action === '') failures.push('an input row must name the delivered action')
    return { ok: failures.length === 0, countedAsPass: false, failures, facts }
  }

  if (!pass) return { ok: failures.length === 0, countedAsPass: false, failures, facts }

  if (row.da1_has_attribute_4 !== true) failures.push('DA1 did not declare the SIXEL attribute 4')
  if (row.window_hwnd === null || row.window_hwnd === undefined) failures.push('window_hwnd is missing')
  if (Array.isArray(row.terminal_size_cells) !== true || row.terminal_size_cells.length !== 2) {
    failures.push('terminal_size_cells is missing')
  }

  const screenshotName = row.screenshot_before ?? row.screenshot_after
  if (typeof screenshotName !== 'string' || screenshotName === '') {
    failures.push('a PASS row needs a screenshot')
  } else {
    const screenshotPath = join(root, 'screenshots', screenshotName)
    if (!existsSync(screenshotPath)) {
      failures.push(`screenshot does not exist: ${screenshotName}`)
    } else {
      const bytes = readFileSync(screenshotPath)
      const digest = sha256(bytes)
      facts.screenshot = { name: screenshotName, sha256: digest, bytes: bytes.length }
      if (digest !== row.screenshot_sha256) {
        failures.push(`screenshot sha256 does not match the recorded digest for ${screenshotName}`)
      }
      const size = pngSize(bytes)
      if (size === undefined) {
        failures.push(`screenshot ${screenshotName} is not a PNG`)
      } else {
        facts.pngSize = size
        const bounds = row.screenshot_physical_bounds
        if (!Array.isArray(bounds) || bounds.length !== 4) {
          failures.push('screenshot_physical_bounds is missing')
        } else {
          const left = Number(bounds[0])
          const top = Number(bounds[1])
          const right = Number(bounds[2])
          const bottom = Number(bounds[3])
          if (size.width !== right - left || size.height !== bottom - top) {
            failures.push(
              `screenshot IHDR ${size.width}x${size.height} does not match the recorded physical frame ${right - left}x${bottom - top}`,
            )
          }
        }
      }
    }
  }

  // A frame row only has to be a real, matching screenshot of this run; the DCS
  // and DA1 story belongs to the case's `trace` row.
  if (row.oracle !== null && typeof row.oracle === 'object' && row.oracle.dcs_written === false) {
    facts.frameDcs = false
  }

  return { ok: failures.length === 0, countedAsPass: failures.length === 0, failures, facts }
}

/** Validate a whole manifest, grouped by case id for the report. */
export function validateWtE3Manifest(
  path: string,
  options: { readonly root?: string; readonly requireCleanTree?: boolean } = {},
): WtE3ManifestVerdict {
  const root = options.root ?? dirname(resolve(path))
  const rows = readWtE3Manifest(path).map((row) => ({ row, verdict: validateWtE3Row(row, { root }) }))
  const byCase = new Map<string, { row: WtE3Row; verdict: WtE3RowVerdict }[]>()
  for (const entry of rows) {
    const caseId = String(entry.row.case_id ?? '')
    const list = byCase.get(caseId) ?? []
    list.push(entry)
    byCase.set(caseId, list)
  }

  // A frame proves a PICTURE ONLY inside a case whose trace proves the terminal
  // was a real, DA1-admitting WT tty. Counting frames alone let a row with a
  // self-declared `da1_has_attribute_4` and a copied screenshot look verified —
  // the exact weak-evidence-green failure this validator exists to stop.
  const caseFailures: string[] = []
  const verifiedCases: string[] = []
  for (const [caseId, entries] of byCase) {
    const traceRows = entries.filter((entry) => entry.row.phase === 'trace')
    const frames = entries.filter((entry) => isFrameRow(entry.row))
    // RFL-012: an EMPTY frame list makes `frames.every(...)` true, so a case with
    // only bookkeeping rows could be counted as verified. A case must prove at
    // least one picture; stop before the every() check.
    if (frames.length === 0) {
      caseFailures.push(`${caseId}: no frame row`)
      continue
    }
    // Exactly one trace, for the same reason: duplicates would let a PASS shadow a
    // FAIL (RFL-011 applies the same rule to cleanup below).
    if (traceRows.length !== 1) {
      caseFailures.push(`${caseId}: expected exactly one trace row, found ${traceRows.length}`)
      continue
    }
    const trace = traceRows[0]!
    if (trace === undefined) {
      caseFailures.push(`${caseId}: no trace row (frames cannot be verified without the terminal facts)`)
      continue
    }
    if (trace.verdict.ok !== true) {
      caseFailures.push(`${caseId}: trace row failed: ${trace.verdict.failures.join('; ')}`)
      continue
    }
    // RFL-009 + RFL-011: a case whose window was never confirmed closed has leaked
    // a 900-second subject; its evidence cannot be counted. Exactly ONE cleanup row
    // is required — `find()` would let a PASS shadow a later FAIL.
    const cleanupRows = entries.filter((entry) => entry.row.phase === 'cleanup')
    if (cleanupRows.length !== 1) {
      caseFailures.push(`${caseId}: expected exactly one cleanup row, found ${cleanupRows.length} (the window teardown is unverified)`)
      continue
    }
    const cleanup = cleanupRows[0]!
    if (cleanup.verdict.ok !== true || cleanup.row.result !== 'PASS') {
      caseFailures.push(`${caseId}: cleanup failed: ${cleanup.verdict.failures.join('; ') || String(cleanup.row.reason ?? cleanup.row.result)}`)
      continue
    }
    // Dirty-tree evidence is not a frozen verification of this deliverable.
    if (options.requireCleanTree === true && entries.some((entry) => entry.row.git_status_clean === false)) {
      caseFailures.push(`${caseId}: run was recorded on an unclean tree`)
      continue
    }
    if (frames.every((entry) => entry.verdict.countedAsPass === true)) verifiedCases.push(caseId)
    else caseFailures.push(`${caseId}: at least one frame row is not a verified frame`)
  }

  return {
    rows,
    byCase,
    // "passes" counts CASES, not frames: the unit of an E3 claim is one case with
    // its frame and trace closure, never an isolated screenshot. Row failures and
    // case-closure failures stay separate so neither double-counts the other.
    passes: verifiedCases.length,
    verifiedCases,
    failures: rows.filter((entry) => entry.verdict.ok !== true).length,
    caseFailures,
  }
}

/** A row that asserts a rendered frame (as opposed to an operation or the trace). */
export function isFrameRow(row: WtE3Row): boolean {
  // An explicit ALLOWLIST of the phases that assert a rendered frame. A denylist
  // silently absorbed new bookkeeping phases (`cleanup`) and then reported a sound
  // case as unverified, because a cleanup row legitimately has no screenshot.
  return FRAME_PHASES.has(String(row.phase ?? ''))
}

/** Phases whose row asserts one captured frame. */
const FRAME_PHASES = new Set(['before', 'after', 'scrolled', 'expanded', 'intermediate', 'restored', 'cropped'])
