#!/usr/bin/env node
/**
 * Screen-level oracle for the fullscreen Focus replay harness (investigation
 * tooling, NOT production code). See `docs/focus-replay-harness.md`.
 *
 * Marker/proxy detectors gave false positives (they matched the Thinking tail or
 * the held-back final block). This one only looks at the TERMINAL SCREEN that
 * `scripts/focus-replay-probe.mts` recorded:
 *
 *   holes            = a run of >=2 transcript rows that is non-blank in the
 *                      paint before AND after, blank in this paint, with the rows
 *                      above stable and the same lines returning at the same rows.
 *                      A scroll / re-anchor moves the surrounding rows too, so it
 *                      can never be reported as a hole.
 *   abaAlternations  = the composed frame goes A -> B -> A, i.e. it flips to a
 *                      different state and flips straight back (the shape the
 *                      transcript-batch lifecycle bug produced).
 *
 * The animated busy indicator glyph is masked. Self-test: punching a synthetic
 * hole into an artifact yields exactly one reported hole.
 *
 * Usage: node scripts/focus-screen-holes.mjs <artifact.json> [--dump]
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: node scripts/focus-screen-holes.mjs <artifact.json> [--dump]')
  process.exit(2)
}
const dump = process.argv.includes('--dump')
const artifact = JSON.parse(readFileSync(path, 'utf8'))
const screens = artifact.screens ?? []
const chromeRows = 7

const rowsOf = screen => screen.texts.map(maskGlyph)
const nonBlank = row => row.trim() !== ''
/** The busy indicator animates on wall-clock time; mask its glyph. */
const maskGlyph = row => (row.includes('Working...') ? row.replace(/^\S+/, 'WORKING') : row)

function transcript(rows) {
  return rows.slice(0, Math.max(0, rows.length - chromeRows))
}

const holes = []
const shifts = []
for (let index = 1; index + 1 < screens.length; index += 1) {
  const before = transcript(rowsOf(screens[index - 1]))
  const current = transcript(rowsOf(screens[index]))
  const after = transcript(rowsOf(screens[index + 1]))
  const length = Math.min(before.length, current.length, after.length)

  // The live tail keeps streaming BELOW the hole, so only the rows ABOVE the
  // hole must be stable, and the lost lines must come back at the SAME rows.
  const aboveStable = holeStart => {
    for (let row = 0; row < holeStart; row += 1) {
      if ((before[row] ?? '') !== (current[row] ?? '')) return false
      if ((after[row] ?? '') !== (before[row] ?? '')) return false
    }
    return true
  }
  const restoredAtSameRows = (holeStart, holeEnd) => {
    for (let row = holeStart; row <= holeEnd; row += 1) {
      if ((after[row] ?? '') !== (before[row] ?? '')) return false
    }
    return true
  }

  let row = 0
  while (row < length) {
    if (nonBlank(current[row] ?? '')) { row += 1; continue }
    let end = row
    while (end + 1 < length && !nonBlank(current[end + 1] ?? '')) end += 1
    const holeLength = end - row + 1
    const bounded = row > 0 && end + 1 < length
      && nonBlank(before[row - 1] ?? '') && nonBlank(before[end + 1] ?? '')
      && nonBlank(after[row - 1] ?? '') && nonBlank(after[end + 1] ?? '')
    if (holeLength >= 2 && bounded && aboveStable(row) && restoredAtSameRows(row, end)) {
      holes.push({
        paintSeq: screens[index].paintSeq,
        chunkSeq: screens[index].chunkSeq,
        rows: [row, end],
        length: holeLength,
        beforeLines: before.slice(row, end + 1).length,
        lost: before.slice(row, end + 1).map(line => line.trim()).filter(Boolean).slice(0, 4),
      })
    }
    row = end + 1
  }

  // A -> B -> A alternation of the whole composed screen: the frame flips to a
  // different state and flips straight back.
  const screenKey = rows => rows.join('\u0001')
  if (screenKey(before) === screenKey(after) && screenKey(before) !== screenKey(current)) {
    shifts.push({
      paintSeq: screens[index].paintSeq,
      chunkSeq: screens[index].chunkSeq,
      kind: 'A-B-A screen alternation',
    })
  }
}

const total = screens.length
// Usability guard: the oracle is only meaningful for a HEADLESS, sync-ON
// artifact. A real-terminal run has no xterm snapshots and `REPLAY_SYNC=off`
// strips the `?2026` markers, so `screens`/`paintRecords` come out empty. A
// vacuous `holes = 0 / abaAlternations = 0` must never be read as acceptance.
// The transcript region only: a chrome/footer-only artifact (or one whose
// transcript rows are all blank) has no samples to judge, even though it has
// rows on screen and may carry synchronized-output transactions.
const screensWithTranscriptRows = screens.filter(screen => transcript(rowsOf(screen)).some(nonBlank)).length
const transactions = artifact.metrics?.transactions ?? 0
const sameWritePaints = (artifact.paintRecords ?? []).filter(paint => paint.endsInSameWrite === true).length
const usable = total > 0 && screensWithTranscriptRows > 0 && (transactions > 0 || sameWritePaints > 0)
const unusableReason = usable
  ? null
  : total === 0 || screensWithTranscriptRows === 0
    ? 'no transcript samples (real-terminal artifact, REPLAY_SYNC=off, or a chrome-only artifact: the oracle needs headless + REPLAY_SYNC=on with transcript rows)'
    : 'no synchronized-output transactions recorded (REPLAY_SYNC=off?)'

console.log(JSON.stringify({
  artifact: path,
  usable,
  ...(usable ? {} : { unusableReason }),
  paints: total,
  screensWithTranscriptRows,
  holes: holes.length,
  abaAlternations: shifts.length,
  holeDetail: holes.slice(0, 20),
}, null, 1))

if (!usable) {
  console.error(`focus-screen-holes: artifact is NOT usable as acceptance evidence — ${unusableReason}`)
  process.exit(2)
}

if (dump && holes.length > 0) {
  const byPaint = new Map(screens.map(screen => [screen.paintSeq, screen]))
  const target = holes[0]
  const index = screens.findIndex(screen => screen.paintSeq === target.paintSeq)
  for (const offset of [-1, 0, 1]) {
    const screen = screens[index + offset]
    if (screen === undefined) continue
    const tag = offset === 0 ? 'HOLE' : offset < 0 ? 'PRE' : 'POST'
    console.log(`\n==== ${tag} P${screen.paintSeq} chunkSeq=${screen.chunkSeq}`)
    rowsOf(screen).slice(0, screen.texts.length - chromeRows).forEach((line, row) => {
      if (nonBlank(line)) console.log(`   ${String(row).padStart(2)}|${line.slice(0, 96)}`)
    })
  }
}
