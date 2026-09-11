/**
 * Composer contract tests: the composer's default/compact output matches
 * the REFERENCE layout for the same state — same parts, same order, same
 * separators, same wrap/cap/dim behavior. The reference is re-implemented
 * here as the string-level oracle (plan 2026-08-31 §6.2: each logical row
 * occupies 1..2 physical lines inside the global budget; a row WITH a
 * right zone keeps its single-line fitted contract; the Host instruction
 * APPENDS as an independent line and never replaces a user row — the
 * legacy replace-last-row swap is gone).
 * @module @xmoon76/dsh-pi-tui/footer-composer-compat.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { wrapTextWithAnsi, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { color } from '../src/theme.ts'
import { FooterComposer, mergeCommandSurface } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT, COMPACT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { FOOTER_MAX_PHYSICAL_LINES, FOOTER_MAX_PHYSICAL_LINES_PER_ROW } from '../src/footer/types.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

const composer = new FooterComposer(createBuiltinFooterRegistry())

/** The LEGACY renderFooter line-1 parts (the pre-M1 implementation). */
function legacyLine1(snap: StatusSnapshot, editorEmpty: boolean, extensionText: string): string[] {
  const permissionBadge = snap.access.permissionPreset?.id === 'danger-full-access'
    ? color.warning('[yolo]')
    : snap.access.permissionPreset?.id === 'read-only'
      ? color.textMuted('[read-only]')
      : snap.access.permissionPreset?.id === 'workspace-write'
        ? color.text('[workspace-write]')
        : snap.access.permissionPreset?.id === 'custom'
          ? color.warning('[custom]')
          : ''
  const badgeParts: string[] = []
  if (snap.activity.taskCount > 0) {
    badgeParts.push(`${snap.activity.taskCount} task${snap.activity.taskCount === 1 ? '' : 's'} running`)
  }
  if (snap.activity.childAgentCount > 0) {
    badgeParts.push(`${snap.activity.childAgentCount} agent${snap.activity.childAgentCount === 1 ? '' : 's'}`)
  }
  const taskBadge = badgeParts.length === 0
    ? ''
    : color.primary(`[${badgeParts.join(' · ')}${editorEmpty ? ' · ↓ view' : ''}]`)
  const model = snap.composition.model
  const modelLabel = model === undefined
    ? ''
    : `[${model.provider === undefined ? '' : `${model.provider}/`}${model.id}${model.reasoningEffort === undefined ? '' : ` @${model.reasoningEffort}`}]`
  const context = snap.usage.context === undefined || snap.usage.context.windowTokens === undefined
    || snap.usage.context.windowTokens <= 0
    ? ''
    : (() => {
        const used = snap.usage.context!.usedTokens ?? 0
        const window = snap.usage.context!.windowTokens!
        const ratio = Math.min(1, Math.max(0, used / window))
        const filled = Math.round(ratio * 12)
        const pct = Math.min(100, Math.max(0, Math.ceil(ratio * 100)))
        const bar = '█'.repeat(filled) + '░'.repeat(12 - filled)
        return `${color.primary(`[${bar}]`)} ${pct}%`
      })()
  return [
    permissionBadge,
    snap.collaboration.plan.effective ? color.warning('[plan]') : '',
    modelLabel,
    taskBadge,
    snap.workspace.cwd === '' ? '' : snap.workspace.cwd.split('/').filter(Boolean).slice(-2).join('/') || snap.workspace.cwd,
    snap.workspace.branch === undefined || snap.workspace.branch === '' ? '' : snap.workspace.branch,
    context,
    `t${snap.usage.turns}/s${snap.usage.steps}`,
    extensionText,
  ].filter(part => part !== '')
}

/** The token-count formatter (mirrors formatTokens). */
function fmt(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return `${Math.round(count / 1_000_000)}M`
}

/** The seconds formatter (mirrors formatSeconds). */
function sec(ms: number): string {
  const text = (ms / 1000).toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}s`
}

/** The row separator the default layout renders with: no persisted
 * separator → the composer's two-space join. */
const SEP = '  '

/** One reference zone item: the preferred text, the compact density form
 * the composer falls back to under pressure, the drop importance and the
 * reverse-layout-order tie-break position. */
interface RefItem {
  text: string
  readonly compact: string
  readonly importance: number
  readonly order: number
}

/** The reference zone fit (the composer's compact → drop → truncate
 * discipline, plan §9.2–§9.4 — the string-level oracle for zone width
 * pressure: importance ASC, then reverse layout order as the tie-break,
 * the tail ANSI-safely truncated with '…'). */
function fitZoneRef(items: RefItem[], budget: number): string {
  const totalOf = (list: readonly RefItem[]): number =>
    list.reduce((sum, item, index) => sum + visibleWidth(item.text) + (index === 0 ? 0 : SEP.length), 0)
  if (totalOf(items) <= budget) return items.map(item => item.text).join(SEP)
  const kept = [...items]
  const byImportance = [...kept].sort((a, b) => a.importance - b.importance || b.order - a.order)
  for (const victim of byImportance) {
    if (totalOf(kept) <= budget) break
    if (visibleWidth(victim.compact) < visibleWidth(victim.text)) victim.text = victim.compact
  }
  if (totalOf(kept) <= budget) return kept.map(item => item.text).join(SEP)
  for (const victim of byImportance) {
    if (kept.length === 1) break
    const without = kept.filter(item => item !== victim)
    if (totalOf(without) <= budget) {
      kept.splice(0, kept.length, ...without)
      break
    }
    if (totalOf(without) < totalOf(kept)) kept.splice(0, kept.length, ...without)
  }
  while (totalOf(kept) > budget && kept.length > 1) kept.pop()
  if (totalOf(kept) > budget && kept.length > 0) {
    const last = kept[kept.length - 1]!
    const prefixWidth = totalOf(kept.slice(0, -1))
    const room = Math.max(1, budget - prefixWidth - (kept.length === 1 ? 0 : SEP.length))
    last.text = truncateToWidth(last.text, room, '…')
  }
  return kept.map(item => item.text).join(SEP)
}

/** The reference physical rows of ONE logical row (plan 2026-08-31 §6.2):
 * a row WITHOUT a right zone wraps its preferred form into its 1..2-line
 * allowance; a row WITH a right zone keeps the composer's single-line fit
 * contract (the right zone reserves its ideal width first, the left zone
 * fits the remainder, the right zone re-fits the leftover room and drops
 * entirely when even one cell is left). */
function referenceRow(row: { left: RefItem[]; right: RefItem[] }, width: number, allowance: number): string[] {
  if (row.right.length === 0) {
    const preferred = wrapTextWithAnsi(row.left.map(item => item.text).join(SEP), width)
    if (preferred.length <= allowance) return preferred
    // The fitted form may still wrap past the allowance (word-boundary
    // waste): shrink the multi-line CELL budget until it fits, then fall
    // back to the ANSI-safe tail cap — never a slice of the wrapped lines.
    let cells = width * allowance
    for (;;) {
      const wrapped = wrapTextWithAnsi(fitZoneRef(row.left, cells), width)
      if (wrapped.length <= allowance) return wrapped
      if (cells <= 1) return [`${truncateToWidth(wrapped[0] ?? '', Math.max(0, width - 1), '')}…`]
      cells = Math.max(1, cells - Math.max(1, wrapped.length - allowance))
    }
  }
  if (row.left.length === 0) {
    const fitted = fitZoneRef(row.right, width)
    return [`${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`]
  }
  const rightFull = row.right.map(item => item.text).join(SEP)
  const leftBudget = Math.max(1, width - visibleWidth(rightFull) - 1)
  const leftText = fitZoneRef(row.left, leftBudget)
  const leftWidth = visibleWidth(leftText)
  const rightRoom = Math.max(0, width - leftWidth - 1)
  if (rightRoom < 1) return [leftText]
  const finalRight = fitZoneRef(row.right, rightRoom)
  const gap = ' '.repeat(Math.max(0, width - leftWidth - visibleWidth(finalRight)))
  return [`${leftText}${gap}${finalRight}`]
}

/** The reference footer: the sequential physical-line allocation (every
 * renderable row earns a baseline line first, the leftover then buys the
 * demanding rows their second line in layout order, capped at the hard
 * per-row capability) + the legacy dim pass over every physical row. */
function referenceFooter(rows: Array<{ left: RefItem[]; right: RefItem[] }>, width: number): string {
  const renderable = rows.filter(row => row.left.length > 0 || row.right.length > 0)
  const demands = renderable.map(row => row.right.length === 0
    ? wrapTextWithAnsi(row.left.map(item => item.text).join(SEP), width).length
    : 1)
  const allowances = renderable.map(() => 0)
  let remaining = FOOTER_MAX_PHYSICAL_LINES
  for (let index = 0; index < renderable.length; index += 1) {
    const baseline = Math.min(1, remaining)
    allowances[index] = baseline
    remaining -= baseline
  }
  for (let index = 0; index < renderable.length && remaining > 0; index += 1) {
    if (demands[index]! <= 1) continue
    const extra = Math.min(demands[index]! - 1, FOOTER_MAX_PHYSICAL_LINES_PER_ROW - 1, remaining)
    allowances[index]! += extra
    remaining -= extra
  }
  const physical: string[] = []
  renderable.forEach((row, index) => {
    if (allowances[index]! < 1) return
    physical.push(...referenceRow(row, width, allowances[index]!))
  })
  return physical.map(row => color.textDim(row)).join('\n')
}

/** The reference short cwd (last two path segments). */
function shortCwdRef(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || cwd
}

/** The reference cwd basename (the compact density form). */
function basenameRef(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.at(-1) ?? cwd
}

/** A reference item tone (the semantic token the definition would carry). */
type RefTone = 'warning' | 'textMuted' | 'text' | 'primary' | 'success'

/** Apply an item's semantic tone exactly like the composer's renderSpans
 * (an absent tone leaves the text plain for the final dim pass). */
function toneText(text: string, tone: RefTone): string {
  switch (tone) {
    case 'warning': return color.warning(text)
    case 'textMuted': return color.textMuted(text)
    case 'text': return color.text(text)
    case 'primary': return color.primary(text)
    case 'success': return color.success(text)
  }
}

/** The default layout's row-1 LEFT zone (the identity facts + the
 * extension bridge; the leading view-scope item renders nothing on the
 * main subject). The tasks badge mirrors the LEGACY count shape the
 * compat snapshots carry (no Task Center totals). */
function defaultRow1Left(snap: StatusSnapshot, context: { taskBrowserAvailable: boolean }, extensionText: string): RefItem[] {
  const items: RefItem[] = []
  const push = (text: string, compact: string, importance: number, tone?: RefTone): void => {
    if (text === '') return
    items.push({
      text: tone === undefined ? text : toneText(text, tone),
      compact: tone === undefined ? compact : toneText(compact, tone),
      importance,
      order: items.length,
    })
  }
  const preset = snap.access.permissionPreset
  if (preset !== undefined) {
    const badge = preset.id === 'danger-full-access' ? '[yolo]'
      : preset.id === 'read-only' ? '[read-only]'
        : preset.id === 'workspace-write' ? '[workspace-write]'
          : preset.id === 'custom' ? '[custom]' : ''
    const compact = preset.id === 'read-only' ? 'ro' : preset.id === 'workspace-write' ? 'ww' : badge.slice(1, -1)
    const tone: RefTone = preset.id === 'danger-full-access' || preset.id === 'custom'
      ? 'warning'
      : preset.id === 'read-only' ? 'textMuted' : 'text'
    push(badge, compact, 110, tone)
  }
  const model = snap.composition.model
  if (model !== undefined) {
    const label = `${model.provider === undefined ? '' : `${model.provider}/`}${model.id}`
      + (model.reasoningEffort === undefined ? '' : ` @${model.reasoningEffort}`)
    push(`[${label}]`, model.id, 100)
  }
  const tasks = snap.activity.taskCount
  const agents = snap.activity.childAgentCount
  if (tasks > 0 || agents > 0) {
    const parts: string[] = []
    const compactParts: string[] = []
    if (tasks > 0) {
      parts.push(`${tasks} task${tasks === 1 ? '' : 's'} running`)
      compactParts.push(`${tasks}t`)
    }
    if (agents > 0) {
      parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
      compactParts.push(`${agents}a`)
    }
    if (context.taskBrowserAvailable) compactParts.push('↓')
    push(
      `[${parts.join(' · ')}${context.taskBrowserAvailable ? ' · ↓ view' : ''}]`,
      `[${compactParts.join('·')}]`,
      85,
      'primary',
    )
  }
  push(snap.workspace.cwd === '' ? '' : shortCwdRef(snap.workspace.cwd), basenameRef(snap.workspace.cwd), 80)
  push(snap.workspace.branch ?? '', snap.workspace.branch ?? '', 70)
  push(extensionText, extensionText, 0)
  return items
}

/** The default layout's row-1 RIGHT zone: the plan state and the Focus
 * Mode indicator (both render nothing when inactive). */
function defaultRow1Right(snap: StatusSnapshot): RefItem[] {
  const items: RefItem[] = []
  const state = snap.collaboration.plan.pending !== undefined
    ? 'plan pending'
    : snap.collaboration.plan.effective ? 'plan' : undefined
  if (state !== undefined) {
    items.push({
      text: toneText(`[${state}]`, 'warning'),
      compact: toneText(state, 'warning'),
      importance: 115,
      order: 0,
    })
  }
  if (snap.interaction.focusMode) {
    items.push({
      text: toneText('focus', 'textMuted'),
      compact: toneText('focus', 'textMuted'),
      importance: 120,
      order: items.length,
    })
  }
  return items
}

/** The default layout's row-2 LEFT zone: the stats-line facts as REAL
 * semantic placements (session usage, cache hit, recent latency and
 * speed) plus the turn/step counters, each with its persisted importance
 * override (the drop order: cache-hit → latency → speed/turns-steps →
 * usage). */
function defaultRow2Left(snap: StatusSnapshot): RefItem[] {
  const t = snap.usage.tokens
  const p = snap.usage.performance
  const items: RefItem[] = [{
    text: toneText(`↑${fmt(t.input)} ↓${fmt(t.output)}`
      + (t.cacheRead > 0 ? ` R${fmt(t.cacheRead)}` : '')
      + (t.cacheWrite > 0 ? ` W${fmt(t.cacheWrite)}` : ''), 'success'),
    compact: toneText(`↑${fmt(t.input)} ↓${fmt(t.output)}`, 'success'),
    importance: 55,
    order: 0,
  }]
  if (snap.usage.cacheHitPct !== undefined) {
    items.push({
      text: toneText(`CH${snap.usage.cacheHitPct.toFixed(1)}%`, 'success'),
      compact: toneText(`${snap.usage.cacheHitPct.toFixed(1)}%`, 'success'),
      importance: 30,
      order: items.length,
    })
  }
  items.push({
    text: toneText(`TTFB ${sec(p.firstTokenMs)}`, 'textMuted'),
    compact: toneText(sec(p.firstTokenMs), 'textMuted'),
    importance: 40,
    order: items.length,
  })
  items.push({
    text: toneText(`${p.tokensPerSec} tok/s`, 'textMuted'),
    compact: toneText(`${p.tokensPerSec}t/s`, 'textMuted'),
    importance: 45,
    order: items.length,
  })
  items.push({
    text: `t${snap.usage.turns}/s${snap.usage.steps}`,
    compact: `t${snap.usage.turns}/s${snap.usage.steps}`,
    importance: 45,
    order: items.length,
  })
  return items
}

/** The default layout's row-2 RIGHT zone: the full context pressure. */
function defaultRow2Right(snap: StatusSnapshot): RefItem[] {
  const context = snap.usage.context
  if (context === undefined || context.windowTokens === undefined || context.windowTokens <= 0) return []
  const used = context.usedTokens ?? 0
  const window = context.windowTokens
  const percent = context.percent ?? Math.min(100, Math.max(0, Math.ceil((used * 100) / window)))
  return [{
    text: toneText(`${fmt(used)}/${fmt(window)} (${percent}%)`, 'primary'),
    compact: toneText(`ctx ${percent}%`, 'primary'),
    importance: 100,
    order: 0,
  }]
}

/** The two reference rows of the builtin default layout. */
function defaultReferenceRows(
  snap: StatusSnapshot,
  context: { taskBrowserAvailable: boolean },
  extensionText: string,
): Array<{ left: RefItem[]; right: RefItem[] }> {
  return [
    { left: defaultRow1Left(snap, context, extensionText), right: defaultRow1Right(snap) },
    { left: defaultRow2Left(snap), right: defaultRow2Right(snap) },
  ]
}

/** A realistic main-subject snapshot. */
function mainSnapshot(): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    composition: { model: { provider: 'deepseek', id: 'flash', displayName: 'flash' } },
    access: { permissionPreset: { id: 'workspace-write', label: 'workspace-write', matched: true } },
    workspace: { cwd: '/home/x/proj', branch: 'main' },
    usage: {
      tokens: { input: 1200, output: 3400, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 },
      turns: 2,
      steps: 5,
      context: { usedTokens: 25000, windowTokens: 100000, percent: 25 },
    },
  }
}

const CONTEXT = { taskBrowserAvailable: true, extensionFooterText: '' }

/** The compact preset's row as reference items (the legacy parts; the
 * tested width never engages the compact density, so the compact form
 * mirrors the preferred one). */
function compactReferenceRows(snap: StatusSnapshot, editorEmpty: boolean, extensionText: string): Array<{ left: RefItem[]; right: RefItem[] }> {
  const parts = legacyLine1(snap, editorEmpty, extensionText)
  return [{
    left: parts.map((text, order) => ({ text, compact: text, importance: 100 - order, order })),
    right: [],
  }]
}

test('default preset output is byte-equivalent to the reference footer (wide)', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(defaultReferenceRows(snap, CONTEXT, ''), 100)
  const actual = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.equal(actual, expected)
})

test('default preset output is byte-equivalent to the reference footer (narrow, wrapped)', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(defaultReferenceRows(snap, CONTEXT, ''), 40)
  const actual = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 40, context: CONTEXT })
  assert.equal(actual, expected)
})

test('compact preset output is byte-equivalent to the reference compact footer', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(compactReferenceRows(snap, true, ''), 100)
  const actual = composer.render({ snapshot: snap, layout: COMPACT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.equal(actual, expected)
})

test('the dynamic exit instruction appends as an INDEPENDENT line (the stats row survives)', () => {
  // plan 2026-08-31 §7: the instruction is no longer a Row-2 REPLACER —
  // it reserves its own line from the global budget; the user layout rows
  // render beside it, position-independent.
  const snap = mainSnapshot()
  const expected = [
    referenceFooter(defaultReferenceRows(snap, CONTEXT, ''), 100),
    color.textDim('Press Ctrl+Shift+X again to exit'),
  ].join('\n')
  const actual = composer.render({
    snapshot: snap,
    layout: DEFAULT_FOOTER_LAYOUT,
    width: 100,
    context: CONTEXT,
    instruction: { id: 'exit-confirm', text: [{ text: 'Press Ctrl+Shift+X again to exit' }], priority: 100 },
  })
  assert.equal(actual, expected)
})

test('permission/plan/task/focus variants stay byte-equivalent', () => {
  for (const permission of ['danger-full-access', 'read-only', 'custom'] as const) {
    const snap = mainSnapshot()
    const variant: StatusSnapshot = {
      ...snap,
      access: { permissionPreset: { id: permission, label: permission, matched: permission !== 'custom' } },
      collaboration: { plan: { effective: true } },
      interaction: { ...snap.interaction, focusMode: true },
      activity: { ...snap.activity, taskCount: 1, childAgentCount: 2 },
    }
    const expected = referenceFooter(defaultReferenceRows(variant, CONTEXT, ''), 100)
    const actual = composer.render({ snapshot: variant, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
    assert.equal(actual, expected, `permission ${permission}`)
  }
})

test('extension segments merge at the reference position', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(defaultReferenceRows(snap, CONTEXT, '[EXT-SEG]'), 100)
  const actual = composer.render({
    snapshot: snap,
    layout: DEFAULT_FOOTER_LAYOUT,
    width: 100,
    context: { ...CONTEXT, extensionFooterText: '[EXT-SEG]' },
  })
  assert.equal(actual, expected)
})

test('a right zone is reserved and the left zone fits the remaining width', () => {
  const snap = mainSnapshot()
  const layout = {
    schemaVersion: 1 as const,
    rows: [{
      left: [
        { id: 'permission-preset' },
        { id: 'model' },
        { id: 'cwd' },
        { id: 'turns-steps' },
      ],
      right: [{ id: 'view-scope' }],
    }],
  }
  // The right zone (view-scope) renders nothing on the main subject, so
  // the row is left-only.
  const actual = composer.render({ snapshot: snap, layout, width: 100, context: CONTEXT })
  assert.ok(actual.includes('[workspace-write]'), `left zone missing:\n${actual}`)
  assert.ok(actual.includes('t2/s5'), `counters missing:\n${actual}`)
})

test('a throwing item is isolated (omitted, never crashes the composer)', () => {
  const snap = mainSnapshot()
  const registry = createBuiltinFooterRegistry()
  registry.register({
    id: 'boom',
    label: 'Boom',
    defaultZone: 'left',
    defaultImportance: 0,
    formats: ['x'],
    defaultFormat: 'x',
    render: () => { throw new Error('boom') },
  })
  const composer2 = new FooterComposer(registry)
  const layout = {
    schemaVersion: 1 as const,
    rows: [{ left: [{ id: 'boom' }, { id: 'model' }], right: [] }],
  }
  const actual = composer2.render({ snapshot: snap, layout, width: 100, context: CONTEXT })
  assert.ok(actual.includes('[deepseek/flash]'), `the surviving item must render:\n${actual}`)
  assert.ok(!actual.includes('boom'), `the throwing item must be omitted:\n${actual}`)
})

test('mergeCommandSurface keeps its contract under the new capacity (smoke)', () => {
  // The COMMAND footer surface is deliberately UNCHANGED by the capacity
  // work: trusted command rows keep their row list, and the instruction
  // still merges onto the last row slot of the COMMAND surface (its own
  // contract, distinct from the native row allocator), tail-capped at
  // narrow widths.
  const instruction = { id: 'exit-confirm', text: [{ text: 'Press Ctrl+Shift+X again to exit' }], priority: 100 }
  assert.equal(mergeCommandSurface(['cmd row one', 'cmd row two'], instruction, 20)
    .replace(/\x1b\[[0-9;]*m/g, ''),
    'cmd row one\nPress Ctrl+Shift+X…')
  assert.equal(mergeCommandSurface(['cmd row one'], instruction, 100)
    .replace(/\x1b\[[0-9;]*m/g, ''),
    'cmd row one\nPress Ctrl+Shift+X again to exit')
  assert.equal(mergeCommandSurface(['only'], undefined, 100), 'only')
  // Budget normalization mirrors the native composer: exactly 0 grants
  // nothing; negative totals are invalid input and floor at 1 (the hint
  // can never be silently hidden by an underflow); absurd values clamp to
  // the hard capacity; degenerate widths still bound every row.
  const instr = { id: 'exit-confirm', text: [{ text: 'Press Ctrl+Shift+X again to exit' }], priority: 100 }
  assert.equal(mergeCommandSurface(['cmd'], instr, 20, { total: 0 }), '')
  assert.equal(
    mergeCommandSurface(['cmd'], instr, 20, { total: -1 }).replace(/\x1b\[[0-9;]*m/g, ''),
    'Press Ctrl+Shift+X…',
  )
  assert.equal(
    mergeCommandSurface(['cmd'], instr, 20, { total: 999 }).replace(/\x1b\[[0-9;]*m/g, ''),
    'cmd\nPress Ctrl+Shift+X…',
  )
  // A degenerate width normalizes to the width-1 surface: every row
  // collapses to its 1-cell ellipsis form.
  assert.equal(
    mergeCommandSurface(['cmd'], instr, Number.NaN, { total: 4 }).replace(/\x1b\[[0-9;]*m/g, ''),
    '…\n…',
  )
  // OMITTED budget = the legacy contract BYTE-IDENTICAL — the caller's
  // width passes through un-normalized (edge widths included).
  for (const edgeWidth of [Number.NaN, 0, -5, 7.5]) {
    const actual = mergeCommandSurface(['cmd row one', 'cmd row two'], instr, edgeWidth as number)
    const legacyWrapped = wrapTextWithAnsi('Press Ctrl+Shift+X again to exit', edgeWidth as number)
    const legacyRow = legacyWrapped.length > 1
      ? `${truncateToWidth(legacyWrapped[0]!, Math.max(1, (edgeWidth as number) - 1), '')}…`
      : legacyWrapped[0]!
    // The command merge does NOT dim (the legacy command surface contract).
    const expected = [`cmd row one`, legacyRow].join('\n')
    assert.equal(actual, expected, `omitted-budget legacy behavior at width ${edgeWidth}:\n${actual}`)
  }
  // An INVISIBLE instruction is absent on the command surface too: it
  // neither paints a line nor consumes a budget slot (native parity).
  for (const text of ['  ', '\u001b[38;2;0;0;0m\u001b[39m  ']) {
    const withBlank = mergeCommandSurface(['cmd'], { id: 'b', text: [{ text }], priority: 100 }, 20, { total: 2 })
    assert.equal(withBlank.replace(/\x1b\[[0-9;]*m/g, ''), 'cmd', `a blank instruction must be treated as absent:\n${withBlank}`)
  }
  // Non-finite totals are SUPPLIED budgets: they fall back to the hard
  // capacity instead of bypassing the budget (the legacy path is only
  // for an OMITTED budget).
  for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const lines = mergeCommandSurface(['cmd', 'cmd two'], instr, 20, { total: nonFinite })
      .replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    assert.ok(lines.length <= 4, `non-finite total ${nonFinite} must stay inside the capacity:\n${lines}`)
    assert.ok(lines[lines.length - 1]!.includes('Press Ctrl+Shift+X'), `the hint must survive a non-finite total ${nonFinite}:\n${lines}`)
  }
})

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

test('independent golden vectors lock the composed output (wide/narrow/compact)', () => {
  const snap = mainSnapshot()
  // Hand-verified fixed vectors (independent of the referenceFooter oracle).
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    // The status row (identity facts; the inactive plan/focus right zone
    // renders nothing) and the stats row: the stats-line facts as semantic
    // placements plus the counters on the left, the full context pressure
    // flush right (no cache activity → the cache-hit placement is absent).
    '[workspace-write]  [deepseek/flash]  x/proj  main\n↑1.2k ↓3.4k  TTFB 0s  0 tok/s  t2/s5                                                  25k/100k (25%)',
  )
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 40, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    // 40 columns: the status row fills its 2-line allowance (50 cells → 2
    // rows); the stats row is a RIGHT-ZONE row (its single-line fit
    // contract), so the left zone compacts then drops the latency
    // placement against the context's reserved width.
    '[workspace-write]  [deepseek/flash]\nx/proj  main\n↑1.2k ↓3.4k  0t/s  t2/s5  25k/100k (25%)',
  )
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 20, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    // 20 columns: the status row compact-pass shortens its items first
    // (ww/flash/proj); only the model/cwd/branch survive. The stats row's
    // left zone loses every placement but the (truncated) usage pair — the
    // right-zone context stays reserved and renders flush right.
    '[workspace-write]\nflash  proj  main\n↑1.2… 25k/100k (25%)',
  )
  assert.equal(
    composer.render({ snapshot: snap, layout: COMPACT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    '[workspace-write]  [deepseek/flash]  x/proj  main  [███░░░░░░░░░] 25%  t2/s5',
  )
  // The status row's right zone (plan state + Focus Mode) renders flush
  // right when active — only the left zone is fitted to the remainder.
  const focusSnap = mainSnapshot() as DeepMutable<StatusSnapshot>
  focusSnap.interaction = { ...focusSnap.interaction, focusMode: true }
  assert.equal(
    composer.render({ snapshot: focusSnap as StatusSnapshot, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    '[workspace-write]  [deepseek/flash]  x/proj  main                                              focus\n↑1.2k ↓3.4k  TTFB 0s  0 tok/s  t2/s5                                                  25k/100k (25%)',
  )
  // The extension bridge keeps its position at the status row's tail.
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: { ...CONTEXT, extensionFooterText: '[EXT-SEG]' } })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    '[workspace-write]  [deepseek/flash]  x/proj  main  [EXT-SEG]\n↑1.2k ↓3.4k  TTFB 0s  0 tok/s  t2/s5                                                  25k/100k (25%)',
  )
  // The dim pass wraps EVERY physical row in the textDim SGR pair.
  const ansi = composer.render({ snapshot: snap, layout: COMPACT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.equal(ansi, '\x1b[38;2;136;136;136m\x1b[38;2;224;224;224m[workspace-write]\x1b[39m\x1b[38;2;136;136;136m  [deepseek/flash]  x/proj  main  \x1b[38;2;79;168;255m[███░░░░░░░░░]\x1b[39m\x1b[38;2;136;136;136m 25%  t2/s5\x1b[39m')
})

test('a row that becomes the ONLY logical line follows the SAME 1..2-line contract', () => {
  // A 2-row layout whose FIRST row renders empty (every item unavailable,
  // e.g. an unloaded extension item): the survivor is an ordinary row, NOT
  // a role-assigned tail — it keeps the uniform per-row contract (at most
  // TWO physical lines within the global budget), with no position-based
  // single-line cap (plan 2026-08-31 §6.2/Step 4).
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.usage = {
    tokens: { input: 1200, output: 3400, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 },
    turns: 2,
    steps: 5,
  }
  const text = composer.render({
    snapshot: snap,
    layout: {
      schemaVersion: 1,
      rows: [
        { left: [{ id: 'ext:gone/unknown' }], right: [] },
        { left: [{ id: 'stats-line' }], right: [] },
      ],
    },
    width: 30,
    context: CONTEXT,
  })
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = plain.split('\n')
  assert.ok(lines.length >= 1 && lines.length <= 2, `the lone row must respect the uniform per-row contract:\n${plain}`)
  assert.ok(plain.includes('↑1.2k'), `the row content must survive:\n${plain}`)
  for (const line of lines) {
    assert.ok(line.length <= 30, `every physical row stays inside the width:\n${plain}`)
  }
})

test('the instruction as the ONLY logical line caps to one physical row', () => {
  // A 1-row layout whose status row renders empty + the dynamic exit
  // instruction: the instruction's own INDEPENDENT surface contract caps
  // it to one physical row (plan 2026-08-31 §7).
  const snap = emptyStatusSnapshot()
  const text = composer.render({
    snapshot: snap,
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'ext:gone/unknown' }], right: [] }] },
    width: 30,
    context: CONTEXT,
    instruction: { id: 'exit-confirm', text: [{ text: 'Press Ctrl+Shift+X again to exit — this hint is deliberately long' }], priority: 100 },
  })
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = plain.split('\n')
  assert.equal(lines.length, 1, `the instruction must cap to one physical row:\n${plain}`)
  assert.ok(plain.includes('Press Ctrl+Shift+X'), `the hint must survive:\n${plain}`)
})

test('an EMPTY stats row does not cap the status row as if it were the stats tail', () => {
  // A 2-row layout whose STATS row renders empty (no usage facts): the
  // FIRST (status) row is the only line and is NOT the stats row — it
  // must keep the budgeted wrap, not be force-capped to one physical row.
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  snap.access.permissionPreset = { id: 'workspace-write', label: 'workspace-write', matched: true }
  snap.workspace = { cwd: '/very/long/path/that/wraps/a/lot', branch: 'main' }
  const text = composer.render({
    snapshot: snap,
    layout: {
      schemaVersion: 1,
      rows: [
        { left: [{ id: 'permission-preset' }, { id: 'model' }, { id: 'cwd' }], right: [] },
        { left: [{ id: 'stats-line' }], right: [] },
      ],
    },
    width: 40,
    context: CONTEXT,
  })
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = plain.split('\n')
  assert.ok(lines.length > 1, `the status row must keep its budgeted wrap:\n${plain}`)
})
