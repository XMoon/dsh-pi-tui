/**
 * Composer physical-line budget tests (plan 2026-08-31 §6/§8/§13.4/§13.5/
 * §13.6): every LOGICAL row goes through the same 1..2-physical-line
 * contract inside the global budget; the composer carries NO position
 * semantics (no "first row = status / last row = stats"), so a manual
 * 3-row layout renders like any other. The Host instruction transiently
 * REPLACES the last existing physical row (never an extra appended line;
 * an otherwise empty Footer paints the one-line safety exception), and
 * right-zone rows keep their single-line fitZone contract.
 * @module @xmoon76/dsh-pi-tui/footer-row-budget.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { FooterComposer } from '../../src/tui/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../../src/tui/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../../src/domain/footer/presets.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../../src/domain/status/types.ts'
import type { FooterInstructionLike } from '../../src/tui/footer/composer.ts'
import type { FooterLayoutV1, FooterPhysicalLineBudget } from '../../src/tui/footer/presentation-types.ts'

const composer = new FooterComposer(createBuiltinFooterRegistry())
const CONTEXT = { taskBrowserAvailable: true, extensionFooterText: '[EXT-SEG]' }

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

/** A busy snapshot: every default item renders. */
function busySnapshot(): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.model = { provider: 'deepseek', id: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' }
  snap.access.permissionPreset = { id: 'danger-full-access', label: 'danger-full-access', matched: true }
  snap.collaboration.plan.effective = true
  snap.activity.taskCount = 2
  snap.activity.childAgentCount = 1
  snap.workspace = { cwd: '/home/xmoon/project/dsh-pi-tui', branch: 'feat/footer-customization' }
  snap.usage = {
    tokens: { input: 1_200, output: 3_400, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 },
    turns: 12,
    steps: 38,
  }
  snap.usage.context = { usedTokens: 160000, windowTokens: 1_000_000, percent: 16 }
  return snap as StatusSnapshot
}

const INSTRUCTION = { id: 'exit-confirm', text: [{ text: 'Press Ctrl+D again to exit' }], priority: 100 } as const

function plainPhysical(
  snap: StatusSnapshot,
  layout: FooterLayoutV1,
  width: number,
  extra?: { instruction?: FooterInstructionLike; budget?: FooterPhysicalLineBudget },
): string[] {
  const text = composer.render({
    snapshot: snap,
    layout,
    width,
    context: CONTEXT,
    instruction: extra?.instruction,
    physicalLineBudget: extra?.budget,
  })
  return text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
}

/** A manual 3-row layout (the persisted parser still caps at 1..2 rows, so
 * this only reaches the composer directly — the future Add-Row shape). */
const THREE_ROW_LAYOUT: FooterLayoutV1 = {
  schemaVersion: 1,
  rows: [
    { left: [{ id: 'permission-preset' }, { id: 'plan-state' }], right: [] },
    { left: [{ id: 'model' }, { id: 'git-branch' }], right: [] },
    { left: [{ id: 'git-branch' }, { id: 'turns-steps' }], right: [] },
  ],
}

test('every logical row of the default layout stays inside the 1..2-line row contract', () => {
  const snap = busySnapshot()
  for (const width of [200, 120, 80, 60, 40, 30, 20, 10, 1]) {
    const lines = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, width)
    assert.ok(lines.length >= 1, `no rows at ${width}`)
    assert.ok(lines.length <= 4, `the hard capacity at ${width}: ${JSON.stringify(lines)}`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= Math.max(1, width), `row overflows at ${width}: ${JSON.stringify(line)}`)
      const truncatedSgr = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncatedSgr, null, `truncated ANSI at ${width}: ${JSON.stringify(line)}`)
    }
    // The stats row keeps at least one visible line within its allowance:
    // it is a RIGHT-ZONE row (the full context pressure reserves its width
    // first), so at degenerate widths the left zone truncates to its '…'
    // marker while the context survives in its compact form.
    if (width > 4) {
      const stats = lines.find(line => line.includes('ctx') || line.includes('↑') || line.includes('160k/1.0M'))
      assert.ok(stats !== undefined && visibleWidth(stats) <= Math.max(1, width), `stats row lost at ${width}:\n${JSON.stringify(lines)}`)
    }
  }
})

test('invalid widths normalize to the width-1 surface', () => {
  // The composer is exported: a direct caller handing 0 / -1 / NaN /
  // Infinity gets a deterministic width-1 surface — never an ill-fitted
  // or crashing one.
  const snap = busySnapshot()
  for (const width of [0, -1, -80, Number.NaN, Number.POSITIVE_INFINITY]) {
    const lines = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, width)
    assert.ok(lines.length >= 1 && lines.length <= 4, `normalized budget at ${width}: ${JSON.stringify(lines)}`)
    for (const line of lines) {
      assert.ok(line.length > 0 && visibleWidth(line) <= 1, `row outside the width-1 surface at ${width}: ${JSON.stringify(line)}`)
    }
  }
})

test('a caller budget is CLAMPED to the hard capability (perRow ≤ 2, total ≤ 4)', () => {
  // { perRow: 2, total: 6 } must not raise the composer's ceiling: the
  // effective total clamps to 4. Three rows then share 4 lines with the
  // sequential allocator — every row keeps the SAME 1..2 contract, no
  // stats-role inference (plan §13.4). The second line the allocator
  // grants row 2 goes UNUSED here: the responsive compact pass resolves
  // the row to one line (model id + branch drop), so the render is 3
  // lines — compact before drop, never a slice of the wrapped lines.
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 6 }
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget })
  assert.equal(lines.length, 3, `the clamped budget renders 3 compact rows, saw:\n${JSON.stringify(lines)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, `overflow:\n${JSON.stringify(lines)}`)
})

test('a manual 3-row layout never overflows the DEFAULT capacity', () => {
  // The hard capacity: 4 physical lines total. Three non-empty rows share
  // it: a baseline line each while it lasts, the leftover buys a second
  // line for the hungriest row — and the width/ANSI contracts hold
  // throughout. No overflow, no crash, no role inference.
  const snap = busySnapshot()
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20)
  assert.ok(lines.length <= 4, `the default capacity at 20 columns: ${JSON.stringify(lines)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, `overflow:\n${JSON.stringify(lines)}`)
})

test('the Host instruction replaces the last physical row and keeps the Footer height', () => {
  // Instruction + 3 rows with a caller budget ABOVE the ceiling: the
  // effective budget clamps to 4, the normal 3-row layout renders exactly
  // as it does without an instruction, and the hint overlays its LAST
  // physical row (no appended line, no pushed-out row).
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 6 }
  const baseline = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget })
  const armed = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget, instruction: INSTRUCTION })
  assert.equal(armed.length, baseline.length, `the Footer height must not change:\n${JSON.stringify(armed)}\nvs\n${JSON.stringify(baseline)}`)
  assert.deepEqual(armed.slice(0, -1), baseline.slice(0, -1), 'every row above the last stays byte-identical')
  assert.ok(armed[armed.length - 1]!.includes('Press Ctrl+D again'), `the instruction must own the last row:\n${JSON.stringify(armed)}`)
})

test('the exit hint overlays the last status row and preserves both Footer rows', () => {
  // Instruction + default 2-row layout at 40 columns: the hint replaces
  // the stats row, so the visible Footer keeps its two-row height and the
  // status row is untouched.
  const snap = busySnapshot() as DeepMutable<StatusSnapshot>
  snap.collaboration.plan.effective = false
  const baseline = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40)
  const armed = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, { instruction: INSTRUCTION })
  assert.equal(baseline.length, 2, `the default layout renders two rows:\n${JSON.stringify(baseline)}`)
  assert.equal(armed.length, baseline.length, `the hint must not add a row:\n${JSON.stringify(armed)}`)
  assert.equal(armed[0], baseline[0], 'the status row must stay byte-identical')
  assert.ok(armed[1]!.includes('Press Ctrl+D again to exit'), `the hint must replace the stats row:\n${JSON.stringify(armed)}`)
})

test('a 3-row layout under the DEFAULT budget keeps its three physical rows', () => {
  // Instruction + 3 rows + the DEFAULT capacity of 4: the normal layout
  // renders three rows, and the hint overlays the last one. Nothing is
  // appended, nothing is pushed out of the Footer budget.
  const snap = busySnapshot()
  const baseline = plainPhysical(snap, THREE_ROW_LAYOUT, 20)
  const armed = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { instruction: INSTRUCTION })
  assert.equal(baseline.length, 3, `the 3-row layout renders three rows:\n${JSON.stringify(baseline)}`)
  assert.equal(armed.length, baseline.length, `the hint must not add a row:\n${JSON.stringify(armed)}`)
  assert.deepEqual(armed.slice(0, 2), baseline.slice(0, 2), 'the first two rows stay byte-identical')
  assert.ok(armed[2]!.includes('Press Ctrl+D again'), `the hint must replace the last row:\n${JSON.stringify(armed)}`)
})

test('a DYNAMIC total of 2 overlays the stats row instead of spending a slot on the hint', () => {
  // The surface may hand the composer fewer lines than the capacity
  // (20x10 chrome-heavy fullscreen): with total 2 the normal layout gives
  // the status row and the stats row one line each; the hint replaces the
  // stats row, so the status row keeps its slot and the Footer height is
  // unchanged.
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 2 }
  const baseline = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, { budget })
  const armed = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, { budget, instruction: INSTRUCTION })
  assert.equal(armed.length, baseline.length, `exactly the surface budget:\n${JSON.stringify(armed)}`)
  assert.deepEqual(armed.slice(0, -1), baseline.slice(0, -1), 'the status row must survive byte-identically')
  assert.ok(armed[armed.length - 1]!.includes('Press Ctrl+D again to exit'), `the hint must replace the stats row:\n${JSON.stringify(armed)}`)
  assert.ok(!armed.some(line => line.includes('↑')), `the stats row must be covered, not appended:\n${JSON.stringify(armed)}`)
})

test('a capacity of 4 lets BOTH rows wrap (2 + 2) when no instruction competes', () => {
  // Two logical rows that each need two physical lines at 40 columns, no
  // instruction: the capacity of 4 lets each row take its full 1..2
  // contract — 2 + 2 = 4. The old hard total of 3 would have cut the
  // second row to one line for no reason.
  const snap = busySnapshot()
  const layout: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [
      { left: [{ id: 'model' }, { id: 'git-branch' }], right: [] },
      { left: [{ id: 'git-branch' }, { id: 'context' }], right: [] },
    ],
  }
  const lines = plainPhysical(snap, layout, 40)
  assert.equal(lines.length, 4, `both rows may wrap to two inside the capacity, saw:\n${JSON.stringify(lines)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, `overflow:\n${JSON.stringify(lines)}`)
})

test('a capacity of 4 with an active hint keeps the full four-row layout and overlays its last row', () => {
  // The same two hungry rows + the active hint: the hint adds no budget
  // pressure — the rows keep their computed 2 + 2 layout, and the hint
  // replaces the fourth physical row.
  const snap = busySnapshot()
  const layout: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [
      { left: [{ id: 'model' }, { id: 'git-branch' }], right: [] },
      { left: [{ id: 'git-branch' }, { id: 'context' }], right: [] },
    ],
  }
  const baseline = plainPhysical(snap, layout, 40)
  const armed = plainPhysical(snap, layout, 40, { instruction: INSTRUCTION })
  assert.equal(armed.length, baseline.length, `the full four-row layout must stay:\n${JSON.stringify(armed)}`)
  assert.deepEqual(armed.slice(0, -1), baseline.slice(0, -1), 'the first three rows stay byte-identical')
  assert.ok(armed[armed.length - 1]!.includes('Press Ctrl+D again to exit'), `the hint must replace the last row:\n${JSON.stringify(armed)}`)
})

test('the transient instruction keeps normal Footer height at every width and budget', () => {
  // The zero-jitter contract: for every supported width and surface grant,
  // a non-empty normal Footer renders the SAME number of physical rows with
  // and without the instruction; only the LAST row is replaced, and every
  // row stays width-bounded.
  const snap = busySnapshot()
  for (const width of [100, 40, 20, 1]) {
    for (const total of [4, 2, 1]) {
      const budget: FooterPhysicalLineBudget = { perRow: 2, total }
      const baseline = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, width, { budget })
      const armed = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, width, { budget, instruction: INSTRUCTION })
      assert.equal(armed.length, baseline.length,
        `height changed at width ${width}, total ${total}:\n${JSON.stringify(armed)}\nvs\n${JSON.stringify(baseline)}`)
      if (baseline.length === 0) continue
      assert.deepEqual(armed.slice(0, -1), baseline.slice(0, -1),
        `a non-last row changed at width ${width}, total ${total}`)
      // At the width-1 surface both the normal row and the instruction cap
      // to the same '…' marker, so only assert a distinct replacement when
      // the normal row had distinguishable text.
      if (baseline[baseline.length - 1] !== '…') {
        assert.notEqual(armed[armed.length - 1], baseline[baseline.length - 1],
          `the instruction must replace the last row at width ${width}, total ${total}`)
      }
      assert.ok(armed[armed.length - 1] === '…' || armed[armed.length - 1]!.includes('Press'),
        `the instruction must keep its visible prefix at width ${width}, total ${total}:\n${JSON.stringify(armed)}`)
      for (const line of armed) {
        assert.ok(visibleWidth(line) <= Math.max(1, width), `overflow at width ${width}, total ${total}: ${JSON.stringify(line)}`)
      }
    }
  }
})

test('EMPTY_FOOTER_EXCEPTION: an otherwise empty Footer paints one visible instruction row', () => {
  // Plan §2.3: a Footer whose normal layout renders NO row (every item
  // unavailable) has no last row to overlay. With a positive budget it
  // paints the ONE instruction row so the exit confirmation never becomes
  // invisible. This is the only case where the instruction changes the
  // height from 0 to 1.
  const layout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'ext:gone/unknown' }], right: [] }] }
  const baseline = composer.render({
    snapshot: emptyStatusSnapshot(),
    layout,
    width: 30,
    context: CONTEXT,
    physicalLineBudget: { perRow: 2, total: 2 },
  })
  assert.equal(baseline, '', 'the normal layout renders no row')
  const armed = composer.render({
    snapshot: emptyStatusSnapshot(),
    layout,
    width: 30,
    context: CONTEXT,
    instruction: INSTRUCTION,
    physicalLineBudget: { perRow: 2, total: 2 },
  })
  const lines = armed.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  assert.equal(lines.length, 1, `exactly the one-row safety exception:\n${JSON.stringify(lines)}`)
  assert.ok(lines[0]!.includes('Press Ctrl+D again'), `the instruction must be visible:\n${JSON.stringify(lines)}`)
})

test('invalid perRow/total budgets normalize inside the hard capability', () => {
  // NaN, ±Infinity, zero/negative/fractional/absurd values must never
  // hang the fit loops (e.g. `wrapped.length <= NaN` is always false) —
  // each normalizes to the SAME canonical output as the equivalent valid
  // budget, never past perRow ≤ 2 / total ≤ 4.
  const snap = busySnapshot()
  const assertNormalized = (raw: { perRow?: number; total?: number }, equivalent: FooterPhysicalLineBudget, label: string): void => {
    const lines = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 30, {
      budget: { perRow: raw.perRow ?? 2, total: raw.total ?? 4 },
    })
    const canonical = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 30, { budget: equivalent })
    assert.deepEqual(lines, canonical, `${label} must normalize to the equivalent render:\n${JSON.stringify(lines)}\nvs\n${JSON.stringify(canonical)}`)
    assert.ok(lines.length <= 4, `${label} stays inside the hard capacity:\n${JSON.stringify(lines)}`)
    for (const line of lines) assert.ok(visibleWidth(line) <= 30, `${label} overflow:\n${JSON.stringify(lines)}`)
  }
  // Non-finite values fall back to the DEFAULT budget.
  for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertNormalized({ perRow: nonFinite }, { perRow: 2, total: 4 }, `perRow ${nonFinite}`)
    assertNormalized({ total: nonFinite }, { perRow: 2, total: 4 }, `total ${nonFinite}`)
  }
  // Finite junk floors at 1 (negative/0/fractional perRow → 1 line per
  // row; negative total → 1 total line — never a silent empty footer)…
  assertNormalized({ perRow: 0 }, { perRow: 1, total: 4 }, 'perRow 0')
  assertNormalized({ perRow: -1 }, { perRow: 1, total: 4 }, 'perRow -1')
  assertNormalized({ perRow: 1.9 }, { perRow: 1, total: 4 }, 'perRow 1.9')
  assertNormalized({ total: -1 }, { perRow: 2, total: 1 }, 'total -1')
  assertNormalized({ total: 3.9 }, { perRow: 2, total: 3 }, 'total 3.9')
  // …and absurd values clamp to the hard capability (perRow ≤ 2, total ≤ 4).
  assertNormalized({ perRow: 999 }, { perRow: 2, total: 4 }, 'perRow 999')
  assertNormalized({ total: 999 }, { perRow: 2, total: 4 }, 'total 999')
})

test('an oversized UN-droppable item resolves by ANSI-safe truncate with …', () => {
  // A single-item row whose preferred form exceeds even the full
  // allowance cannot be compacted shorter and cannot lose its only item —
  // the ONLY semantic exit is the ANSI-safe tail truncate: the surviving
  // rows carry the '…' marker, stay width-bounded, and never contain
  // the raw oversized payload.
  const registry = createBuiltinFooterRegistry()
  registry.register({
    id: 'wall',
    label: 'Wall',
    defaultZone: 'left',
    defaultImportance: 100,
    formats: ['x'],
    defaultFormat: 'x',
    render: () => ({ spans: [{ text: `${'y'.repeat(300)}END-MARKER` }] }),
  })
  const wallComposer = new FooterComposer(registry)
  const text = wallComposer.render({
    snapshot: emptyStatusSnapshot(),
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'wall' }], right: [] }] },
    width: 40,
    context: { taskBrowserAvailable: false, extensionFooterText: '' },
  })
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  assert.equal(lines.length, 2, `the item must take its 2-line allowance:\n${JSON.stringify(lines)}`)
  assert.ok(lines[1]!.includes('…'), `the tail must carry the truncate marker:\n${JSON.stringify(lines)}`)
  const joined = lines.join('')
  assert.ok(!joined.includes('END-MARKER'), `the raw payload must not survive (it was cut):\n${JSON.stringify(lines)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 40, `overflow:\n${JSON.stringify(lines)}`)
})

test('a surface that grants ZERO lines (exactly 0) renders nothing at all', () => {
  // total === 0 is a surface DECISION (its pinned chrome alone fills the
  // viewport): the composer renders NOTHING — not even the Host
  // instruction — so it never exceeds the granted budget and never
  // disagrees with its Text component (zero rows). A NEGATIVE total is
  // INVALID caller input, not a decision: it normalizes like other junk
  // (floor 1) so the instruction can never be silently hidden by an
  // arithmetic underflow.
  const snap = busySnapshot()
  const text = composer.render({
    snapshot: snap,
    layout: DEFAULT_FOOTER_LAYOUT,
    width: 40,
    context: CONTEXT,
    instruction: INSTRUCTION,
    physicalLineBudget: { perRow: 2, total: 0 },
  })
  assert.equal(text, '', 'total 0 must render nothing')
  const negative = composer.render({
    snapshot: snap,
    layout: DEFAULT_FOOTER_LAYOUT,
    width: 40,
    context: CONTEXT,
    instruction: INSTRUCTION,
    physicalLineBudget: { perRow: 2, total: -1 },
  }).replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(negative.includes('Press Ctrl+D again'), `a negative total must NOT hide the instruction:\n${negative}`)
})

test('an instruction that renders NOTHING reserves no line and paints nothing', () => {
  // A Host instruction that renders nothing VISIBLE (empty spans,
  // whitespace-only text, blank SGR-only text) is indistinguishable from
  // an absent one: no extra (blank) physical line, no reserved budget —
  // the composer agrees with its Text component (zero rows for invisible
  // content).
  const snap = busySnapshot()
  const without = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40)
  for (const text of ['  ', '\x1b[38;2;0;0;0m\x1b[39m  ', '\x1b[38:2::0:0:0m\x1b[39m  ']) {
    const withBlank = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, {
      instruction: { id: 'blank', text: [{ text }], priority: 100 },
    })
    assert.deepEqual(withBlank, without, `a blank instruction must be treated as absent (${JSON.stringify(text)}):\n${JSON.stringify(withBlank)}\nvs\n${JSON.stringify(without)}`)
  }
  const withEmpty = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, {
    instruction: { id: 'empty', text: [], priority: 100 },
  })
  assert.deepEqual(withEmpty, without, `an empty instruction must be treated as absent:\n${JSON.stringify(withEmpty)}\nvs\n${JSON.stringify(without)}`)
})

test('a right-zone row keeps its single-line contract while left-only siblings wrap', () => {
  const snap = busySnapshot() as DeepMutable<StatusSnapshot>
  snap.interaction.displayPreset = 'focus'
  const layout: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [
      { left: [{ id: 'permission-preset' }, { id: 'model' }, { id: 'git-branch' }, { id: 'context' }], right: [] },
      { left: [{ id: 'permission-preset' }], right: [{ id: 'focus-mode' }] },
    ],
  }
  for (const width of [80, 40, 20, 10]) {
    const lines = plainPhysical(snap, layout, width)
    assert.ok(lines.length <= 4, `budget at ${width}: ${JSON.stringify(lines)}`)
    // The right-zone row is always exactly one line with the pinned focus
    // item at its tail.
    const rightLine = lines[lines.length - 1]!
    assert.ok(rightLine.includes('focus'), `the right zone must render at ${width}:\n${JSON.stringify(lines)}`)
    assert.ok(visibleWidth(rightLine) <= width, `right zone overflow at ${width}:\n${JSON.stringify(lines)}`)
  }
})

test('footer CONTENT carrying border-like glyphs is still ONE physical row', () => {
  // A footer item whose text is a run of box-drawing dashes (a custom
  // rule/divider item) must never be mistaken for structure by anything
  // down the line: it is one ordinary physical row inside the same
  // budget — no border-anchor heuristics (plan §13.2).
  const registry = createBuiltinFooterRegistry()
  registry.register({
    id: 'divider',
    label: 'Divider',
    defaultZone: 'left',
    defaultImportance: 90,
    formats: ['x'],
    defaultFormat: 'x',
    render: () => ({ spans: [{ text: '\u2500'.repeat(10) }] }),
  })
  const dividerComposer = new FooterComposer(registry)
  const text = dividerComposer.render({
    snapshot: emptyStatusSnapshot(),
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'divider' }], right: [] }] },
    width: 80,
    context: { taskBrowserAvailable: false, extensionFooterText: '' },
  })
  assert.equal(text.split('\n').length, 1, 'a border-like item is one physical row')
})