/**
 * Composer contract tests: the composer's default/compact output matches
 * the REFERENCE layout for the same state — same parts, same order, same
 * separators, same wrap/cap/dim behavior. The reference is re-implemented
 * here as the string-level oracle (plan 2026-08-31 §6.2: each logical row
 * occupies 1..2 physical lines; the tail line truncates ANSI-safely to its
 * one row; the Host instruction APPENDS as an independent line and never
 * replaces a user row — the legacy replace-last-row swap is gone).
 * @module @xmoon76/dsh-pi-tui/footer-composer-compat.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { wrapTextWithAnsi, truncateToWidth } from '@xmoon76/pi-tui'
import { color } from '../src/theme.ts'
import { FooterComposer } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT, COMPACT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { FOOTER_MAX_PHYSICAL_LINES_PER_ROW } from '../src/footer/types.ts'
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

/** The LEGACY stats line (formatStats of the structured usage). */
function legacyStatsLine(snap: StatusSnapshot): string {
  const t = snap.usage.tokens
  const p = snap.usage.performance
  const fmt = (count: number): string => {
    if (count < 1000) return String(count)
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`
    if (count < 1_000_000) return `${Math.round(count / 1000)}k`
    if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`
    return `${Math.round(count / 1_000_000)}M`
  }
  const sec = (ms: number): string => {
    const text = (ms / 1000).toFixed(1)
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}s`
  }
  const piParts = [
    `↑${fmt(t.input)}`,
    `↓${fmt(t.output)}`,
    t.cacheRead > 0 ? `R${fmt(t.cacheRead)}` : '',
    t.cacheWrite > 0 ? `W${fmt(t.cacheWrite)}` : '',
    t.cacheRead > 0 || t.cacheWrite > 0 ? `CH${(snap.usage.cacheHitPct ?? 0).toFixed(1)}%` : '',
  ].filter(part => part !== '')
  return `${piParts.join(' ')} | LLM ${sec(p.llmMs)} · TTFB ${sec(p.firstTokenMs)} · ${p.tokensPerSec} tok/s`
}

/** The REFERENCE footer rows (plan 2026-08-31 §6.2): the first row wraps
 * into 1..2 physical lines (its cap boundary cut with '…'); the tail line
 * is its own row, truncated ANSI-safely to the full width. The composer's
 * item-level fitting can only DROP more than this reference (semantic
 * importance), never render wider or taller. */
function referenceFooter(line1: string[], line2: string, width: number): string {
  const line1Rows = wrapTextWithAnsi(line1.join('  '), width)
  const rows: string[] = []
  for (let index = 0; index < Math.min(line1Rows.length, FOOTER_MAX_PHYSICAL_LINES_PER_ROW); index += 1) {
    const row = line1Rows[index]!
    rows.push(index === FOOTER_MAX_PHYSICAL_LINES_PER_ROW - 1 && line1Rows.length > FOOTER_MAX_PHYSICAL_LINES_PER_ROW
      ? `${truncateToWidth(row, Math.max(1, width - 1), '')}…`
      : row)
  }
  if (line2 !== '') rows.push(truncateToWidth(line2, width, '…'))
  return rows.map(row => color.textDim(row)).join('\n')
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

test('default preset output is byte-equivalent to the reference footer (wide)', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(legacyLine1(snap, true, ''), legacyStatsLine(snap), 100)
  const actual = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.equal(actual, expected)
})

test('default preset output is byte-equivalent to the reference footer (narrow, wrapped)', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(legacyLine1(snap, true, ''), legacyStatsLine(snap), 40)
  const actual = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 40, context: CONTEXT })
  assert.equal(actual, expected)
})

test('compact preset output is byte-equivalent to the reference compact footer', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(legacyLine1(snap, true, ''), '', 100)
  const actual = composer.render({ snapshot: snap, layout: COMPACT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.equal(actual, expected)
})

test('the Ctrl+C instruction appends as an INDEPENDENT line (the stats row survives)', () => {
  // plan 2026-08-31 §7: the instruction is no longer a Row-2 REPLACER —
  // it reserves its own line from the global budget; the user layout rows
  // render beside it, position-independent.
  const snap = mainSnapshot()
  const expected = [
    referenceFooter(legacyLine1(snap, true, ''), legacyStatsLine(snap), 100),
    color.textDim('Press Ctrl+C again to exit'),
  ].join('\n')
  const actual = composer.render({
    snapshot: snap,
    layout: DEFAULT_FOOTER_LAYOUT,
    width: 100,
    context: CONTEXT,
    instruction: { id: 'ctrl-c-exit', text: [{ text: 'Press Ctrl+C again to exit' }], priority: 100 },
  })
  assert.equal(actual, expected)
})

test('permission/plan/task variants stay byte-equivalent', () => {
  for (const permission of ['danger-full-access', 'read-only', 'custom'] as const) {
    const snap = mainSnapshot()
    const variant: StatusSnapshot = {
      ...snap,
      access: { permissionPreset: { id: permission, label: permission, matched: permission !== 'custom' } },
      collaboration: { plan: { effective: true } },
      activity: { ...snap.activity, taskCount: 1, childAgentCount: 2 },
    }
    const expected = referenceFooter(legacyLine1(variant, true, ''), legacyStatsLine(variant), 100)
    const actual = composer.render({ snapshot: variant, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
    assert.equal(actual, expected, `permission ${permission}`)
  }
})

test('extension segments merge at the reference position', () => {
  const snap = mainSnapshot()
  const expected = referenceFooter(legacyLine1(snap, true, '[EXT-SEG]'), legacyStatsLine(snap), 100)
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

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

test('independent golden vectors lock the composed output (wide/narrow/compact)', () => {
  const snap = mainSnapshot()
  // Hand-verified fixed vectors (independent of the referenceFooter oracle).
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    '[workspace-write]  [deepseek/flash]  x/proj  main  [███░░░░░░░░░] 25%  t2/s5\n↑1.2k ↓3.4k | LLM 8.1s · TTFB 0s · 0 tok/s',
  )
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 40, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    // 40 columns: the status row fills its 2-line allowance exactly (75
    // cells → 2 rows) and the stats row keeps its own 1-line allowance,
    // ANSI-safely cut at the FULL width.
    '[workspace-write]  [deepseek/flash]\nx/proj  main  [███░░░░░░░░░] 25%  t2/s5\n↑1.2k ↓3.4k | LLM 8.1s · TTFB 0s · 0 to…',
  )
  assert.equal(
    composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 20, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    // 20 columns: the status row's preferred form (75 cells) exceeds the
    // 2×20-cell row budget — importance fitting drops cwd(80)/branch(70)/
    // context(100) BEFORE model(100)/permission(110) and truncates the
    // rest; never a slice of the wrapped lines (plan §6.2). The stats row
    // keeps its own allowance, cut at the full width.
    '[workspace-write]\n[deepseek/flash]\n↑1.2k ↓3.4k | LLM 8…',
  )
  assert.equal(
    composer.render({ snapshot: snap, layout: COMPACT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
      .replace(/\x1b\[[0-9;]*m/g, ''),
    '[workspace-write]  [deepseek/flash]  x/proj  main  [███░░░░░░░░░] 25%  t2/s5',
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
  // A 1-row layout whose status row renders empty + the Ctrl+C
  // instruction: the instruction's own INDEPENDENT surface contract caps
  // it to one physical row (plan 2026-08-31 §7).
  const snap = emptyStatusSnapshot()
  const text = composer.render({
    snapshot: snap,
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'ext:gone/unknown' }], right: [] }] },
    width: 30,
    context: CONTEXT,
    instruction: { id: 'ctrl-c-exit', text: [{ text: 'Press Ctrl+C again to exit — this hint is deliberately long' }], priority: 100 },
  })
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = plain.split('\n')
  assert.equal(lines.length, 1, `the instruction must cap to one physical row:\n${plain}`)
  assert.ok(plain.includes('Press Ctrl+C'), `the hint must survive:\n${plain}`)
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
