/**
 * Footer density contract tests (plan 2026-08-31): every builtin item
 * either has a REAL responsive compact density (a strictly shorter form
 * under width pressure) or is an explicitly documented intentional no-op —
 * never a silent "forgot to implement". Style (the persisted format) and
 * Density (the runtime pressure choice) stay orthogonal: a compact pass
 * never writes back into the persisted format.
 *
 * The headline regression: Row 2 = stats-line + turns-steps. Before the
 * fix, stats-line's compact render was a no-op, so moderate narrow widths
 * jumped straight from the full stats line to dropping stats-line
 * (importance 10) — leaving only `t4/s191`. After the fix the row first
 * compacts the stats line and only drops it at extreme narrow widths.
 * @module @xmoon76/dsh-pi-tui/footer-density.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  createBuiltinFooterRegistry,
  INTENTIONALLY_STABLE_DENSITY_ITEMS,
  RESPONSIVE_COMPACT_ITEMS,
} from '../src/footer/builtin-items.ts'
import { FooterComposer, renderSpans } from '../src/footer/composer.ts'
import type { FooterDensity, FooterItemRef } from '../src/footer/types.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

const registry = createBuiltinFooterRegistry()
const composer = new FooterComposer(registry)
const CONTEXT = { taskBrowserAvailable: true, extensionFooterText: '' }

/** Strip ANSI SGR sequences for text-level assertions. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Render one item at an explicit density (the preferred/compact helper). */
function renderDensity(id: string, snapshot: StatusSnapshot, ref: FooterItemRef, density: FooterDensity): string {
  const def = registry.get(id)
  assert.ok(def !== undefined, `item ${id} must be registered`)
  const segment = def.render(snapshot, ref, density, CONTEXT)
  return segment === null ? '' : plain(renderSpans(segment.spans))
}

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

/** A rich main-subject snapshot: every responsive item renders a
 * meaningful preferred form (the canonical density fixture). */
function richSnapshot(): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.agentPreset = { id: 'code', label: 'Code preset', shortLabel: 'CP' }
  snap.composition.model = {
    provider: 'ollama',
    id: 'deepseek-v4-flash:0731-cloud',
    displayName: 'deepseek-v4-flash:0731-cloud',
    reasoningEffort: 'max',
  }
  snap.access.permissionPreset = { id: 'workspace-write', label: 'workspace-write', matched: true }
  snap.access.sandbox = { mode: 'workspace-write' }
  snap.access.approval = { policy: 'never' }
  snap.collaboration.plan = { effective: true }
  snap.activity = {
    phase: 'waiting-approval',
    busy: true,
    queuedCount: 3,
    taskCount: 1,
    childAgentCount: 2,
    todoCount: 3,
  }
  snap.workspace = { cwd: '/home/x/project/foo', branch: 'feat/next', project: 'foo' }
  snap.usage = {
    tokens: { input: 34_000, output: 8_100, cacheRead: 520_000, cacheWrite: 0 },
    cacheHitPct: 93.9,
    performance: { llmMs: 138_800, firstTokenMs: 2_600, tokensPerSec: 659 },
    turns: 4,
    steps: 191,
  }
  snap.usage.context = { usedTokens: 195_000, windowTokens: 272_000, percent: 72 }
  snap.interaction.focusMode = true
  snap.host.dshVersion = '0.1.2-alpha.2'
  return snap as StatusSnapshot
}

/** The plan's Row-2 regression layout: stats-line + turns-steps on the
 * second logical row. */
const ROW2_LAYOUT = {
  schemaVersion: 1 as const,
  rows: [
    { left: [{ id: 'permission-preset' }, { id: 'model' }, { id: 'context' }, { id: 'focus-mode' }], right: [] },
    { left: [{ id: 'stats-line' }, { id: 'turns-steps' }], right: [] },
  ],
}

test('Row2 = stats-line + turns-steps compacts BEFORE dropping at moderate narrow widths', () => {
  const snap = richSnapshot()
  // Moderate narrow (30): the full stats line cannot fit the 2-line row
  // budget, but the COMPACT stats line + the counters can. The pre-fix
  // behavior dropped stats-line here because its compact render was a
  // no-op — the row collapsed to `t4/s191`.
  const text = composer.render({ snapshot: snap, layout: ROW2_LAYOUT, width: 30, context: CONTEXT })
  const lines = plain(text).split('\n')
  assert.ok(lines.some(line => line.includes('↑34k')), `compact stats must survive:\n${plain(text)}`)
  assert.ok(lines.some(line => line.includes('t4/s191')), `the counters must survive:\n${plain(text)}`)
  assert.ok(!plain(text).includes('TTFB'), `the full stats form must not survive at this width:\n${plain(text)}`)
  assert.ok(lines.length <= 4, `the whole footer stays inside the hard capacity:\n${plain(text)}`)
  for (const line of lines) assert.ok(visibleWidth(line) <= 30, `overflow:\n${plain(text)}`)
  // Extreme narrow (15): importance drop still wins (stats-line 10 <
  // turns-steps 45) — compact is a space-saving step, never a priority
  // redefinition.
  const extreme = plain(composer.render({ snapshot: snap, layout: ROW2_LAYOUT, width: 15, context: CONTEXT }))
  assert.ok(extreme.includes('t4/s191'), `the counters survive extreme narrow:\n${extreme}`)
  assert.ok(!extreme.includes('↑'), `stats-line drops at extreme narrow:\n${extreme}`)
})

test('every builtin item has an explicit density decision (responsive or intentional no-op)', () => {
  const responsive = new Set(RESPONSIVE_COMPACT_ITEMS)
  const stable = new Set(INTENTIONALLY_STABLE_DENSITY_ITEMS)
  // No duplicates inside either list.
  assert.equal(responsive.size, RESPONSIVE_COMPACT_ITEMS.length, 'RESPONSIVE_COMPACT_ITEMS must not repeat ids')
  assert.equal(stable.size, INTENTIONALLY_STABLE_DENSITY_ITEMS.length, 'INTENTIONALLY_STABLE_DENSITY_ITEMS must not repeat ids')
  // The two sets partition the whole builtin registry: every registered
  // item is classified exactly once — a future builtin must choose
  // responsive compact or an explicit no-op, never "not handled".
  const union = [...new Set([...RESPONSIVE_COMPACT_ITEMS, ...INTENTIONALLY_STABLE_DENSITY_ITEMS])].sort()
  assert.deepEqual(union, [...registry.ids()].sort(), 'the density audit must cover every builtin id')
  for (const id of responsive) {
    assert.ok(!stable.has(id), `${id} must not be in both density classes`)
  }
})

test('responsive items: compact is never wider than preferred (every declared format)', () => {
  const snap = richSnapshot()
  for (const id of RESPONSIVE_COMPACT_ITEMS) {
    const def = registry.get(id)!
    for (const format of def.formats) {
      const ref: FooterItemRef = { id, format }
      const preferred = renderDensity(id, snap, ref, 'preferred')
      const compact = renderDensity(id, snap, ref, 'compact')
      assert.ok(preferred !== '', `${id}/${format} must render in the fixture`)
      assert.ok(compact !== '', `${id}/${format} compact must render in the fixture`)
      assert.ok(
        visibleWidth(compact) <= visibleWidth(preferred),
        `${id}/${format}: compact (${compact}) must never be wider than preferred (${preferred})`,
      )
    }
  }
})

test('performance compact never exceeds a shorter persisted style (speed/latency)', () => {
  const snap = richSnapshot()
  // The latency style is already minimal: the compact both-facts form
  // (`138.8s 659t/s`) is WIDER, so the item must fall back to the
  // preferred form — a legitimate no-op, never a wider compact.
  const latencyRef: FooterItemRef = { id: 'performance', format: 'latency' }
  assert.equal(renderDensity('performance', snap, latencyRef, 'preferred'), '2.6s')
  assert.equal(renderDensity('performance', snap, latencyRef, 'compact'),
    renderDensity('performance', snap, latencyRef, 'preferred'),
    'latency compact must be a no-op (the style is already shorter)')
  // Same for the speed style.
  const speedRef: FooterItemRef = { id: 'performance', format: 'speed' }
  assert.equal(renderDensity('performance', snap, speedRef, 'preferred'), '659 tok/s')
  assert.equal(renderDensity('performance', snap, speedRef, 'compact'),
    renderDensity('performance', snap, speedRef, 'preferred'),
    'speed compact must be a no-op (the style is already shorter)')
  // The full style still gets the strictly shorter both-facts compact.
  assert.equal(renderDensity('performance', snap, { id: 'performance', format: 'full' }, 'compact'), '138.8s 659t/s')
})

test('token-usage compact never exceeds a shorter persisted io style (cache-heavy)', () => {
  const snap = snapshotWith(s => {
    s.usage.tokens = { input: 1, output: 1, cacheRead: 1_500_000, cacheWrite: 0 }
  })
  // A tiny io pair beside a huge cache total: the io form (`1/1`) is
  // already shorter than the aggregate compact (`1.5M`) — the item must
  // fall back to the preferred form, never emit a wider compact.
  const ioRef: FooterItemRef = { id: 'token-usage', format: 'io' }
  assert.equal(renderDensity('token-usage', snap, ioRef, 'preferred'), '1/1')
  assert.equal(renderDensity('token-usage', snap, ioRef, 'compact'),
    renderDensity('token-usage', snap, ioRef, 'preferred'),
    'io compact must be a no-op (the style is already shorter)')
  // The total style still gets the strictly shorter compact aggregate.
  assert.equal(renderDensity('token-usage', snap, { id: 'token-usage', format: 'total' }, 'compact'), '1.5M')
})

test('B-class compact presentations match the agreed golden strings', () => {
  // The structural invariants prove compact is SHORTER; these goldens
  // prove it is the AGREED string (a drift like `q3 → x3` or `td3 → t3`
  // would still satisfy "shorter" but must fail here).
  const snap = richSnapshot()
  const cases: Array<[string, string]> = [
    ['tasks', '[1t·2a·↓]'],
    ['sandbox-mode', 'ww'],
    ['run-state', 'w-approval'],
    ['queue', 'q3'],
    ['agents', 'a2'],
    ['todo', 'td3'],
    ['performance', '138.8s 659t/s'],
    ['stats-line', '↑34k ↓8.1k · LLM 138.8s · 659t/s'],
  ]
  for (const [id, expected] of cases) {
    assert.equal(renderDensity(id, snap, { id }, 'compact'), expected, `${id} compact golden`)
  }
})

test('responsive items: compact is STRICTLY shorter under the canonical fixture', () => {
  const snap = richSnapshot()
  for (const id of RESPONSIVE_COMPACT_ITEMS) {
    // git-branch's default format is already the plain form, so its
    // compact is a no-op there; the fixture uses the label style to prove
    // the responsive compact is real (the plan's A-class mapping).
    const ref: FooterItemRef = id === 'git-branch' ? { id, format: 'label' } : { id }
    const preferred = renderDensity(id, snap, ref, 'preferred')
    const compact = renderDensity(id, snap, ref, 'compact')
    assert.ok(preferred !== '', `${id} must render in the fixture`)
    assert.ok(compact !== '', `${id} compact must render in the fixture`)
    assert.ok(
      visibleWidth(compact) < visibleWidth(preferred),
      `${id}: compact (${compact}) must be strictly shorter than preferred (${preferred})`,
    )
  }
})

test('intentional no-op items keep compact == preferred (explicitly documented)', () => {
  const snap = richSnapshot()
  for (const id of INTENTIONALLY_STABLE_DENSITY_ITEMS) {
    const preferred = renderDensity(id, snap, { id }, 'preferred')
    const compact = renderDensity(id, snap, { id }, 'compact')
    assert.equal(compact, preferred, `${id} must be an explicit density no-op`)
  }
  // The identity-bearing / opaque items also hold when they actually
  // render: the viewer identity block and the extension bridge.
  const viewer = snapshotWith(snap => {
    snap.view.subject = { kind: 'subagent', id: 'c1', label: 'audit', mode: 'one-shot', activity: 'running' }
  })
  assert.equal(renderDensity('view-scope', viewer, { id: 'view-scope' }, 'compact'),
    renderDensity('view-scope', viewer, { id: 'view-scope' }, 'preferred'))
  const def = registry.get('ext:*')!
  const extContext = { ...CONTEXT, extensionFooterText: '[EXT-SEG]' }
  const extPreferred = def.render(snap, { id: 'ext:*' }, 'preferred', extContext)
  const extCompact = def.render(snap, { id: 'ext:*' }, 'compact', extContext)
  assert.equal(extCompact === null ? '' : plain(renderSpans(extCompact.spans)),
    extPreferred === null ? '' : plain(renderSpans(extPreferred.spans)),
    'ext:* must never be rewritten by a density pass')
})

test('density never pollutes the persisted style (Style × Density orthogonal)', () => {
  const snap = richSnapshot()
  // context(format=full): preferred full → compact percent → preferred full again.
  const contextRef: FooterItemRef = { id: 'context', format: 'full' }
  const contextPreferred = renderDensity('context', snap, contextRef, 'preferred')
  assert.equal(contextPreferred, '195k/272k (72%)')
  assert.equal(renderDensity('context', snap, contextRef, 'compact'), 'ctx 72%')
  assert.equal(renderDensity('context', snap, contextRef, 'preferred'), contextPreferred,
    'a compact pass must not write back into the persisted format')
  // model(format=badge): preferred badge → compact id → preferred badge again.
  const modelRef: FooterItemRef = { id: 'model', format: 'badge' }
  const modelPreferred = renderDensity('model', snap, modelRef, 'preferred')
  assert.equal(modelPreferred, '[ollama/deepseek-v4-flash:0731-cloud @max]')
  assert.equal(renderDensity('model', snap, modelRef, 'compact'), 'deepseek-v4-flash:0731-cloud')
  assert.equal(renderDensity('model', snap, modelRef, 'preferred'), modelPreferred,
    'a compact pass must not write back into the persisted format')
})

test('the width matrix locks preferred → compact → importance-drop → truncate', () => {
  const snap = richSnapshot()
  const at = (width: number): string =>
    plain(composer.render({ snapshot: snap, layout: ROW2_LAYOUT, width, context: CONTEXT }))
  // Wide: the full stats line renders (preferred).
  const wide = at(120)
  assert.ok(wide.includes('LLM 138.8s') && wide.includes('tok/s'), `wide must keep the full stats:\n${wide}`)
  // Moderate narrow: compact stats + counters (never a straight drop).
  const moderate = at(30)
  assert.ok(moderate.includes('↑34k') && moderate.includes('t4/s191'), `moderate must compact first:\n${moderate}`)
  assert.ok(!moderate.includes('TTFB'), `moderate must not keep the full stats:\n${moderate}`)
  // Narrower: importance drop (stats-line 10 < turns-steps 45).
  const narrow = at(15)
  assert.ok(narrow.includes('t4/s191') && !narrow.includes('↑'), `narrow must drop by importance:\n${narrow}`)
  // Every width: hard capacity, width-bounded, no broken ANSI.
  for (const width of [120, 100, 80, 60, 50, 40, 30, 20, 15, 10, 5, 1]) {
    const text = composer.render({ snapshot: snap, layout: ROW2_LAYOUT, width, context: CONTEXT })
    const lines = text.split('\n')
    assert.ok(lines.length <= 4, `hard capacity at ${width}:\n${plain(text)}`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= Math.max(1, width), `overflow at ${width}: ${JSON.stringify(line)}`)
      const truncated = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncated, null, `truncated ANSI at ${width}: ${JSON.stringify(line)}`)
    }
  }
})

/** Deep-mutable build shape (the snapshot is deeply readonly). */
function snapshotWith(patch: (snap: DeepMutable<StatusSnapshot>) => void): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  patch(snap)
  return snap as StatusSnapshot
}
