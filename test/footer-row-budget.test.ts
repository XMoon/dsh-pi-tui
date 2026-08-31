/**
 * Composer physical-line budget tests (plan 2026-08-31 §6/§8/§13.4/§13.5/
 * §13.6): every LOGICAL row goes through the same 1..2-physical-line
 * contract inside the global budget; the composer carries NO position
 * semantics (no "first row = status / last row = stats"), so a manual
 * 3-row layout renders like any other, the Host instruction is an
 * independent reserved line (never a row replacement), and right-zone rows
 * keep their single-line fitZone contract.
 * @module @xmoon76/dsh-pi-tui/footer-row-budget.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { FooterComposer } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'
import type { FooterInstructionLike } from '../src/footer/composer.ts'
import type { FooterLayoutV1, FooterPhysicalLineBudget } from '../src/footer/types.ts'

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

const INSTRUCTION = { id: 'ctrl-c-exit', text: [{ text: 'Press Ctrl+C again to exit' }], priority: 100 } as const

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
    // The stats row keeps at least one visible line within its allowance —
    // with the hard capacity of 4 it may even wrap INTO two when the
    // surface has the room (its demand is lower in layout order). At
    // degenerate widths the truncated stats line may no longer carry its
    // 'LLM' text, only its leading '↑' counter.
    if (width > 4) {
      const stats = lines.find(line => line.includes('LLM') || line.includes('↑'))
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
  // stats-role inference (plan §13.4).
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 6 }
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget })
  assert.equal(lines.length, 4, `the clamped budget must allow 3 baseline rows + one second line, saw:\n${JSON.stringify(lines)}`)
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

test('the Host instruction never deletes a user row when the budget fits', () => {
  // Instruction + 3 rows with a caller budget ABOVE the ceiling: the
  // effective budget clamps to 4, which still fits 3 baseline rows + the
  // appended instruction — the legacy "replace the last row slot" swap is
  // gone (plan §7/§13.4).
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 6 }
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget, instruction: INSTRUCTION })
  assert.equal(lines.length, 4, `the instruction must APPEND, not replace:\n${JSON.stringify(lines)}`)
  // At 20 columns the hint itself is tail-capped ('…') — its own 1-line
  // contract.
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again'), `the instruction must be last:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `row 1 must survive:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('deepseek')), `row 2 must survive:\n${JSON.stringify(lines)}`)
})

test('the Host instruction reserves its line; capacity 4 gives status 2 + stats 1 + hint', () => {
  // Instruction + default 2-row layout at 40 columns with the effective
  // total of 4 (the plan §7 example): the hint reserves 1, the two rows
  // share the remaining 3 — a baseline each, the leftover buys the status
  // row its second line. 2 + 1 + 1 = 4; nothing replaced, nothing
  // overflows.
  const snap = busySnapshot()
  const lines = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, { instruction: INSTRUCTION })
  assert.equal(lines.length, 4, `2 + 1 + hint inside the capacity of 4:\n${JSON.stringify(lines)}`)
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again to exit'), `the hint must be its own line:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `the status row must survive:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('LLM')), `the stats row must survive (not be replaced):\n${JSON.stringify(lines)}`)
})

test('a 3-row layout under the DEFAULT budget fits beside the instruction', () => {
  // Instruction + 3 rows + the DEFAULT capacity of 4: the instruction
  // reserves 1, the three rows share the remaining 3 (one baseline line
  // each) — nothing is replaced, the instruction always survives, and no
  // row is rendered wider than the terminal (plan §7/§8).
  const snap = busySnapshot()
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { instruction: INSTRUCTION })
  assert.equal(lines.length, 4, `3 rows + hint inside the capacity of 4:\n${JSON.stringify(lines)}`)
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again'), `the hint must be last:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `row 1 must survive:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('deepseek')), `row 2 must survive:\n${JSON.stringify(lines)}`)
  // Width 20 truncates the row to 'feat/footer-customi…' — its PREFIX
  // survives, which is the point (the row renders; its tail is cut by the
  // ANSI-safe truncate, never by viewport clip).
  assert.ok(lines.some(line => line.includes('feat/footer-customi')), `row 3 must survive:\n${JSON.stringify(lines)}`)
})

test('a DYNAMIC total of 2 still keeps the instruction and drops the stats tail', () => {
  // The surface may hand the composer fewer lines than the capacity
  // (20x10 chrome-heavy fullscreen): with total 2 + an active hint the
  // layout rows share 1 line — the highest-importance row survives, the
  // LOWEST-priority row drops as a global-height decision, and the
  // instruction is never viewport-clipped (plan §7/§8; the composer-level
  // half of the 20x10 regression).
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 2 }
  const lines = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, { budget, instruction: INSTRUCTION })
  assert.equal(lines.length, 2, `exactly the surface budget, hint included:\n${JSON.stringify(lines)}`)
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again to exit'), `the hint must be last:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `the highest-importance row must survive:\n${JSON.stringify(lines)}`)
  assert.ok(!lines.some(line => line.includes('LLM')), `the stats tail must drop under height pressure:\n${JSON.stringify(lines)}`)
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

test('a capacity of 4 with an active hint splits it as 2 + 1 + hint', () => {
  // The same two hungry rows + the active hint: the hint reserves 1
  // first, the rows share 3 — baseline 2 + one second line for the FIRST
  // row in layout order. 2 + 1 + hint = 4, exactly the plan's
  // "space-sufficient" example.
  const snap = busySnapshot()
  const layout: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [
      { left: [{ id: 'model' }, { id: 'git-branch' }], right: [] },
      { left: [{ id: 'git-branch' }, { id: 'context' }], right: [] },
    ],
  }
  const lines = plainPhysical(snap, layout, 40, { instruction: INSTRUCTION })
  assert.equal(lines.length, 4, `2 + 1 + hint inside the capacity, saw:\n${JSON.stringify(lines)}`)
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again to exit'), `the hint must be last:\n${JSON.stringify(lines)}`)
  assert.ok(lines[0]!.includes('deepseek'), `the first row must keep its second line:\n${JSON.stringify(lines)}`)
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
  // Finite junk floors at 1 (0/-1/1.9 → 1 line per row)…
  assertNormalized({ perRow: 0 }, { perRow: 1, total: 4 }, 'perRow 0')
  assertNormalized({ perRow: -1 }, { perRow: 1, total: 4 }, 'perRow -1')
  assertNormalized({ perRow: 1.9 }, { perRow: 1, total: 4 }, 'perRow 1.9')
  assertNormalized({ total: 3.9 }, { perRow: 2, total: 3 }, 'total 3.9')
  // …and absurd values clamp to the hard capability (perRow ≤ 2, total ≤ 4).
  assertNormalized({ perRow: 999 }, { perRow: 2, total: 4 }, 'perRow 999')
  assertNormalized({ total: 999 }, { perRow: 2, total: 4 }, 'total 999')
})

test('a surface that grants ZERO lines renders nothing at all', () => {
  // total ≤ 0 is a surface DECISION (its pinned chrome alone fills the
  // viewport): the composer renders NOTHING — not even the Host
  // instruction — so it never exceeds the granted budget and never
  // disagrees with its Text component (zero rows).
  const snap = busySnapshot()
  for (const total of [0, -1]) {
    const text = composer.render({
      snapshot: snap,
      layout: DEFAULT_FOOTER_LAYOUT,
      width: 40,
      context: CONTEXT,
      instruction: INSTRUCTION,
      physicalLineBudget: { perRow: 2, total },
    })
    assert.equal(text, '', `total ${total} must render nothing`)
  }
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
  snap.interaction.focusMode = true
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