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
    assert.ok(lines.length <= 3, `the global budget at ${width}: ${JSON.stringify(lines)}`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= Math.max(1, width), `row overflows at ${width}: ${JSON.stringify(line)}`)
      const truncatedSgr = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncatedSgr, null, `truncated ANSI at ${width}: ${JSON.stringify(line)}`)
    }
    // The default two-row layout: the stats row keeps exactly one line —
    // the status row's leftover hunger eats the spare line first. (At
    // degenerate widths the truncated stats line may no longer carry its
    // 'LLM' text, only its leading '↑' counter.)
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
    assert.ok(lines.length >= 1 && lines.length <= 3, `normalized budget at ${width}: ${JSON.stringify(lines)}`)
    for (const line of lines) {
      assert.ok(line.length > 0 && visibleWidth(line) <= 1, `row outside the width-1 surface at ${width}: ${JSON.stringify(line)}`)
    }
  }
})

test('a manual 3-row layout renders position-agnostically (no stats-role inference)', () => {
  // With a budget that fits three rows, EVERY row renders; no row is
  // forced to one line for being "the last one" (plan §13.4).
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 6 }
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget })
  // Row 1: permission + plan fit in one line; rows 2 and 3 wrap into two
  // physical lines each — all inside perRow. Crucially the LAST row is
  // allowed the same 1..2 contract as any other row.
  assert.equal(lines.length, 5, `rows must share the budget by demand, saw:\n${JSON.stringify(lines)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, `overflow:\n${JSON.stringify(lines)}`)
})

test('a manual 3-row layout never overflows the DEFAULT global budget', () => {
  // The default surface policy: 3 physical lines total. Three non-empty
  // rows share it: a baseline line each while it lasts, tail rows drop as
  // a budget decision — and the width/ANSI contracts hold throughout.
  const snap = busySnapshot()
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20)
  assert.ok(lines.length <= 3, `the default budget at 20 columns: ${JSON.stringify(lines)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 20, `overflow:\n${JSON.stringify(lines)}`)
})

test('the Host instruction never deletes a user row when the budget fits', () => {
  // Instruction + 3 rows with an explicit budget: ALL rows render and the
  // instruction appends — the legacy "replace the last row slot" swap is
  // gone (plan §7/§13.4).
  const snap = busySnapshot()
  const budget: FooterPhysicalLineBudget = { perRow: 2, total: 6 }
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { budget, instruction: INSTRUCTION })
  assert.equal(lines.length, 6, `the instruction must APPEND, not replace:\n${JSON.stringify(lines)}`)
  // At 20 columns the hint itself is tail-capped ('…') — its own 1-line
  // contract.
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again'), `the instruction must be last:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `row 1 must survive:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('deepseek')), `row 2 must survive:\n${JSON.stringify(lines)}`)
})

test('the Host instruction reserves its line and both default rows survive it', () => {
  // Instruction + default 2-row layout at a narrow width: the instruction
  // reserves 1 line first; the layout rows share the remaining 2 (a
  // baseline line each). Nothing is replaced, nothing overflows.
  const snap = busySnapshot()
  const lines = plainPhysical(snap, DEFAULT_FOOTER_LAYOUT, 40, { instruction: INSTRUCTION })
  assert.ok(lines.length <= 3, `total must stay inside the global budget:\n${JSON.stringify(lines)}`)
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again to exit'), `the hint must be its own line:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `the status row must survive:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('LLM')), `the stats row must survive (not be replaced):\n${JSON.stringify(lines)}`)
})

test('a 3-row layout under the DEFAULT budget drops its TAIL rows, never the instruction', () => {
  // Instruction + 3 rows + the DEFAULT 3-line budget: the instruction
  // reserves 1, two rows share the remaining 2, and row 3 DROPS as a
  // global-budget decision — never via a "replace the last row slot"
  // swap, and the instruction always survives (plan §7/§8).
  const snap = busySnapshot()
  const lines = plainPhysical(snap, THREE_ROW_LAYOUT, 20, { instruction: INSTRUCTION })
  assert.equal(lines.length, 3, `exactly the default budget, hint included:\n${JSON.stringify(lines)}`)
  assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+C again'), `the hint must be last:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('[yolo]')), `row 1 must survive:\n${JSON.stringify(lines)}`)
  assert.ok(lines.some(line => line.includes('deepseek')), `row 2 must survive:\n${JSON.stringify(lines)}`)
  assert.ok(!lines.some(line => line.includes('t12/s38')), `row 3 must drop as a budget decision:\n${JSON.stringify(lines)}`)
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
    assert.ok(lines.length <= 3, `budget at ${width}: ${JSON.stringify(lines)}`)
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