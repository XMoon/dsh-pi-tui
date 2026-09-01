/**
 * Headless tests for the narrow-screen footer (requirement 9, plan
 * 2026-08-31 §6.2/§13.1, PR #57 revision): every logical row WRAPS (into at
 * most TWO physical lines within the surface's effective budget — the hard
 * CAPACITY is 4 and the surface grants fewer on short viewports), and any
 * row overflow resolves by importance instead of being hard-truncated
 * ('…' appears when truncation, not drops, settles the row), extension
 * footer segments still merge into the footer, and the compact preset
 * keeps its single-line semantics on normal widths. The test verifies
 * IMPORTANT-INFO PRIORITY, not that every old fact survives at every
 * width — low-importance items (branch, counters, the extension segment)
 * are DESIGNED to drop first under pressure.
 * @module @xmoon76/dsh-pi-tui/footer-wrap.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Text } from '@xmoon76/pi-tui'
import { TuiApp, type StatusData } from '../src/tui-app.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'
import { FOOTER_MAX_PHYSICAL_LINES } from '../src/footer/types.ts'

function startApp(columns: number): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

/** Realistic status: at 40 columns the status row's preferred form exceeds
 * the 2-line row cap, so the overflow resolves by IMPORTANCE — the pin
 * keeps permission/model/stats; branch and the counters are DESIGNED to
 * compact/drop first, not "must survive". */
const SHORT_STATUS: StatusData = {
  model: 'deepseek/flash',
  cwd: '/home/x/proj',
  branch: 'feat/narrow-footer',
  turns: 3,
  steps: 7,
  statsLine: '3 turns · 7 steps · 12.3s',
  permission: 'workspace-write',
  contextTokens: 1000,
  contextWindow: 10000,
  // M1: the footer composes the stats line from the STRUCTURED usage.
  usage: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 12300, firstTokenMs: 12_300, tokensPerSec: 0 },
    turns: 3,
    steps: 7,
  },
}

/** Extreme status: more than the whole 4-line capacity even at 40 columns
 * with a plain-width surface — the composer's drop-by-importance fitting
 * (and, only where drops cannot shrink it, the ANSI-safe truncate) must
 * keep it inside the hard capability. */
const EXTREME_STATUS: StatusData = {
  model: 'deepseek/deepseek-v4-flash',
  cwd: '/home/xmoon/project/dsh-pi-tui/src',
  branch: 'feat/pluginization-phase2-5-with-a-very-long-name',
  turns: 3,
  steps: 7,
  statsLine: 'stats ' + 'y'.repeat(300),
  permission: 'workspace-write',
  contextTokens: 1000,
  contextWindow: 10000,
  usage: {
    tokens: { input: 999_900_000, output: 999_900_000, cacheRead: 999_900_000, cacheWrite: 999_900_000 },
    cacheHitPct: 99.9,
    performance: { llmMs: 999_900, firstTokenMs: 999_900, tokensPerSec: 999 },
    turns: 3,
    steps: 7,
  },
}

/**
 * The footer's PHYSICAL LINES straight from the footer component (the
 * authoritative render output the layout engine feeds both screens — no
 * viewport heuristics; below-editor widget rows cannot be mistaken for
 * footer lines and footer content cannot fake its own count).
 */
function footerRows(app: TuiApp): string[] {
  return [...app.footerRenderRowsForTest()]
}

test('a narrow terminal wraps the footer to multiple rows, high-importance info first', async () => {
  const { vt, app } = startApp(40)
  app.setStatus(SHORT_STATUS)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // The high-importance facts survive the 2-line row cap: the permission
  // badge (110) and model (100) outrank branch (70) / counters (45), and
  // the stats row keeps its own 1-line allowance (12.3s lives there).
  assert.ok(view.includes('[workspace-write]'), `permission badge lost:\n${view}`)
  assert.ok(view.includes('deepseek/flash'), `model lost:\n${view}`)
  assert.ok(view.includes('12.3s'), `stats line lost:\n${view}`)
  const rows = footerRows(app)
  assert.ok(rows.length >= 3, `the footer must occupy multiple rows at 40 columns, saw ${rows.length}:\n${view}`)
  // 3 rows here: the stats row's demand is one line at 40 columns, so the
  // second line of the capacity stays unused — still inside the hard 4.
  assert.ok(rows.length <= FOOTER_MAX_PHYSICAL_LINES, `the footer must stay inside its capacity, saw ${rows.length}:\n${view}`)
  app.stop()
})

test('runaway host content is capped at the 4-line capacity, tail cut', async () => {
  const { vt, app } = startApp(40)
  app.setStatus(EXTREME_STATUS)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const rows = footerRows(app)
  // The composer hard capacity is FOUR physical lines now (2 lines per
  // logical row × 2 rows) — the extreme state spends it as 2 + 2: the
  // wrapped rows are never sliced; the overflow resolves by importance
  // and the remnants cut with '…'.
  assert.ok(rows.length <= FOOTER_MAX_PHYSICAL_LINES, `the footer must never exceed ${FOOTER_MAX_PHYSICAL_LINES} rows, saw ${rows.length}:\n${view}`)
  assert.ok(rows.length >= 3, `the extreme state must still wrap to multiple rows, saw ${rows.length}:\n${view}`)
  // The extreme state spends the capacity as 2 status rows + 2 stats
  // rows; the overflow resolves by IMPORTANCE (highest facts survive)
  // with no viewport overflow. '…' only appears when the ANSI-safe
  // truncate (not drops) settles the row — drops may fit without it.
  for (const row of rows) {
    assert.ok(visibleWidth(row.replace(/\x1b\[[0-9;]*m/g, '')) <= 40, `row overflows:\n${view}`)
  }
  app.stop()
})

test('extension footer segments still merge into the wrapped footer', async () => {
  const startExtApp = async (columns: number): Promise<{ vt: VirtualTerminal; app: TuiApp }> => {
    const ledger = new ExtensionLedger(() => {})
    const vt = new VirtualTerminal(columns, 24)
    let app!: TuiApp
    const host = new SurfaceHost(ledger, () => app.requestRender())
    app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
    app.start()
    host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
      surfaceId: host.surfaceId,
      generation: 1,
      width: columns,
      height: 24,
      fullscreen: false,
      focusedSeat: 'editor',
      themeId: 'dark',
      themeRevision: 0,
    })
    app.setStatus(SHORT_STATUS)
    ledger.register('chrome.footer.status', { id: 'seg' }, {
      spans: [{ text: '[EXT-SEG]' }],
    }, 'p1')
    await vt.waitForRender()
    return { vt, app }
  }
  // At a normal width the segment renders at its preferred form.
  const wide = await startExtApp(80)
  try {
    const view = wide.vt.getViewport().join('\n')
    assert.ok(view.includes('[EXT-SEG]'), `the extension segment must merge into the footer:\n${view}`)
    assert.ok(view.includes('deepseek/flash'), `host state must survive beside the segment:\n${view}`)
  } finally {
    wide.app.stop()
  }
  // Narrower: the responsive compact pass shortens the host items FIRST
  // (ww/flash/proj/ctx 10%) — at 40 columns that frees enough room for
  // the segment (importance 0) to SURVIVE; the compact-before-drop
  // discipline only sacrifices it when compact alone cannot fit the row.
  const narrow = await startExtApp(40)
  try {
    const view = narrow.vt.getViewport().join('\n')
    assert.ok(view.includes('[EXT-SEG]'), `the segment must survive once compact frees the room:\n${view}`)
    assert.ok(view.includes('workspace-write') || view.includes('ww'), `high-importance state must survive:\n${view}`)
    assert.ok(view.includes('12.3s'), `the stats row must survive:\n${view}`)
  } finally {
    narrow.app.stop()
  }
  // Extreme narrow: the segment (importance 0) drops FIRST (importance
  // order), never overflowing or breaking the composed rows.
  const extreme = await startExtApp(30)
  try {
    const view = extreme.vt.getViewport().join('\n')
    assert.ok(!view.includes('[EXT-SEG]'), `the low-importance segment must drop under extreme pressure:\n${view}`)
    assert.ok(view.includes('workspace-write') || view.includes('ww'), `high-importance state must survive:\n${view}`)
    assert.ok(view.includes('12.3s'), `the stats row must survive:\n${view}`)
  } finally {
    extreme.app.stop()
  }
})

test('below-editor widget rows are NEVER counted as footer rows', async () => {
  // The widgetsBelow Text renders between the editor seat and the footer on
  // the regular surface: with a populated below-widget zone the footer's
  // physical-line count must still come from the footer COMPONENT alone
  // (the widget rows render separately, never into the footer budget).
  const ledger = new ExtensionLedger(() => {})
  const vt = new VirtualTerminal(80, 24)
  let app!: TuiApp
  const host = new SurfaceHost(ledger, () => app.requestRender())
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId,
    generation: 1,
    width: 80,
    height: 24,
    fullscreen: false,
    focusedSeat: 'editor',
    themeId: 'dark',
    themeRevision: 0,
  })
  app.setStatus(SHORT_STATUS)
  ledger.register('input.widget.below', { id: 'b1', order: 1 }, {
    view: { kind: 'rows', rows: [
      { kind: 'text', spans: [{ text: 'below-widget-row-1' }] },
      { kind: 'text', spans: [{ text: 'below-widget-row-2' }] },
      { kind: 'text', spans: [{ text: 'below-widget-row-3' }] },
    ] },
    importance: 0,
  }, 'p1')
  host.refreshOutlets()
  await vt.waitForRender()
  try {
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('below-widget-row-1'), `the below-widget zone must render:\n${view}`)
    const rows = footerRows(app)
    // 80 columns: the status row's preferred form (89 cells) wraps into
    // exactly TWO lines + the stats row = 3 — the budget, unaffected by
    // the widget zone (the old viewport heuristic would have counted 5+).
    assert.equal(rows.length, 3, `a populated widgetsBelow must not inflate the footer count, saw ${rows.length}:\n${rows.join('\n')}`)
    assert.ok(!rows.some(row => row.includes('below-widget')), `widget rows must not land in the footer component:\n${rows.join('\n')}`)
  } finally {
    app.stop()
  }
})

test('the compact preset keeps its single-line semantics on normal widths', async () => {
  const { vt, app } = startApp(100)
  app.setStatus(SHORT_STATUS)
  app.setFooterPreset('compact')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('12.3s'), `compact must hide the stats line:\n${view}`)
  const rows = footerRows(app)
  assert.equal(rows.length, 1, `compact at a normal width must stay one row, saw ${rows.length}:\n${view}`)
  app.stop()
})

test('a wide terminal keeps the two-row footer (no behavior change)', async () => {
  const { vt, app } = startApp(120)
  app.setStatus(SHORT_STATUS)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const rows = footerRows(app)
  assert.equal(rows.length, 2, `full preset at a wide width stays two rows, saw ${rows.length}:\n${view}`)
  app.stop()
})

test('footer content that looks like chrome still counts by the component', async () => {
  // A branch name OF border glyphs flows through the real app path into
  // the footer component: the physical-line count stays anchored to the
  // footer Text's render output (never a border-anchor heuristic).
  const { vt, app } = startApp(120)
  app.setStatus({ ...SHORT_STATUS, branch: '─'.repeat(10) })
  await vt.waitForRender()
  const rows = footerRows(app)
  assert.equal(rows.length, 2, `border-like content must not change the row count, saw ${rows.length}:\n${rows.join('\n')}`)
  assert.ok(rows.some(row => row.includes('─'.repeat(10))), `the border content must render:\n${rows.join('\n')}`)
  app.stop()
})
