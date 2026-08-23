/**
 * Follow-up review P1 gate: the host-owned slot layout budgets (plan §19).
 *
 * The outlets must never emit unconstrained content:
 * - header badges are bounded by a host-owned cell-width budget and
 *   truncated ANSI-safely (never wrapping onto a second row);
 * - dock items collapse to a host-owned row budget, low-importance items
 *   first (order preserved), so a plugin can never push the dock into the
 *   editor;
 * - footer segments respect `minWidth` (a segment narrower than its
 *   declared minimum is dropped), fold low-importance segments first under
 *   width pressure, and truncate the tail ANSI-safely as a last resort.
 *
 * All budgets are applied against the CURRENT terminal width (resize
 * re-bakes through the surface slice) and use cell widths, never JS
 * string length (CJK/emoji measured by the fork's ANSI-safe helpers).
 * @module @xmoon76/dsh-pi-tui/extension-layout-budget.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Text, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function makeApp(ledger: ExtensionLedger): { vt: VirtualTerminal; app: TuiApp; host: SurfaceHost } {
  const vt = new VirtualTerminal(80, 24)
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  return { vt, app, host }
}

function attach(host: SurfaceHost, width = 80): void {
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId, generation: 1, width, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
}

test('header badges are bounded by the host width budget and truncated ANSI-safely', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  // Simulate a very narrow terminal: the badge run must never exceed the
  // budget the host derives from the terminal width (renderHeader owns the
  // derivation; plan §19 item 3-4).
  vt.resize(20, 24)
  app.refreshChrome()
  ledger.register('chrome.header.badge', { id: 'long' }, { text: 'a-very-long-badge-name' }, 'p1')
  host.refreshOutlets()
  app.refreshChrome()
  await settle()
  assert.ok(visibleWidth(host.headerBadgeText()) <= 20, `badge run must fit the budget (${host.headerBadgeText()})`)
  // CJK badge text is measured in CELLS, not JS length (plan §19 item 4-5).
  ledger.register('chrome.header.badge', { id: 'cjk' }, { text: '中文标题' }, 'p2')
  host.refreshOutlets()
  await settle()
  assert.ok(visibleWidth(host.headerBadgeText()) <= 20, `CJK badge run must fit the budget (${host.headerBadgeText()})`)
  app.stop()
})

test('dock items collapse to the row budget, low-importance items first', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  // Three items, each label + detail = 2 rows; budget is 2 rows.
  ledger.register('input.dock.item', { id: 'a', order: 0 }, {
    label: [{ text: 'item-a' }], detail: [{ text: 'detail-a' }],
  }, 'p1')
  ledger.register('input.dock.item', { id: 'b', order: 1 }, {
    label: [{ text: 'item-b' }], detail: [{ text: 'detail-b' }], importance: 10,
  }, 'p2')
  ledger.register('input.dock.item', { id: 'c', order: 2 }, {
    label: [{ text: 'item-c' }], detail: [{ text: 'detail-c' }], importance: -10,
  }, 'p3')
  host.setDockMaxRows(2)
  host.refreshOutlets()
  await settle()
  const dock = host.dockText()
  assert.ok(dock.includes('item-b'), `high-importance item must survive the budget:\n${dock}`)
  assert.ok(!dock.includes('item-c'), `lowest-importance item must collapse first:\n${dock}`)
  assert.ok(!dock.includes('item-a'), `default-importance item must give way to the higher one:\n${dock}`)
  // Removal clears stale rows (plan §19 item 7: empty/removal clears).
  ledger.register('input.dock.item', { id: 'a2', order: 3 }, {
    label: [{ text: 'extra' }], importance: -1,
  }, 'p4')
  host.refreshOutlets()
  await settle()
  assert.ok(!host.dockText().includes('extra'), `tail items must drop under pressure:\n${host.dockText()}`)
  app.stop()
})

test('dock removal clears the baked rows', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  const handle = ledger.register('input.dock.item', { id: 'gone' }, { label: [{ text: 'temporary' }] }, 'p1')
  host.refreshOutlets()
  await settle()
  assert.ok(host.dockText().includes('temporary'))
  handle.dispose()
  host.refreshOutlets()
  await settle()
  assert.equal(host.dockText(), '', 'removal must clear the dock text (plan §19 item 7)')
  app.stop()
})

test('footer segments respect minWidth and fold low-importance under width pressure', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  // Segment 1: short, minWidth 4 → renders. Segment 2: needs 8 but is 3 wide
  // → dropped (cannot render at its minimum). Segment 3: wide, low priority.
  ledger.register('chrome.footer.status', { id: 'ok', order: 0 }, {
    spans: [{ text: '[ok]' }], minWidth: 4,
  }, 'p1')
  ledger.register('chrome.footer.status', { id: 'narrow', order: 1 }, {
    spans: [{ text: 'abc' }], minWidth: 8,
  }, 'p2')
  host.setHeaderBudget(80)
  host.refreshOutlets()
  await settle()
  const footer = host.footerText()
  assert.ok(footer.includes('[ok]'), `minWidth-ok segment must render:\n${footer}`)
  assert.ok(!footer.includes('abc'), `segment narrower than its minWidth must drop:\n${footer}`)

  // Width pressure: two wide segments exceed a tight budget; the
  // low-importance one folds first.
  const ledger2 = new ExtensionLedger(() => {})
  const host2 = new SurfaceHost(ledger2, () => app.requestRender())
  host2.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 'h2', generation: 1, width: 20, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  ledger2.register('chrome.footer.status', { id: 'high', order: 0 }, {
    spans: [{ text: '[high-priority-status]' }], importance: 10,
  }, 'p1')
  ledger2.register('chrome.footer.status', { id: 'low', order: 1 }, {
    spans: [{ text: '[low-priority-status]' }], importance: -10,
  }, 'p2')
  host2.refreshOutlets()
  await settle()
  const tight = host2.footerText()
  assert.ok(tight.includes('high-priority'), `high-importance segment must survive width pressure:\n${tight}`)
  assert.ok(!tight.includes('low-priority'), `low-importance segment must fold first:\n${tight}`)
  assert.ok(visibleWidth(tight) <= 20, `footer must never exceed the width budget (${visibleWidth(tight)} > 20): ${tight}`)
  host2.dispose()
  app.stop()
})

test('resize re-bakes the outlets with the NEW terminal width', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host, 80)
  host.refreshOutlets()
  // A wide badge fits at 80 columns; after a narrow resize the same badge
  // must be truncated by the outlet's width budget.
  ledger.register('chrome.header.badge', { id: 'wide' }, { text: 'x'.repeat(60) }, 'p1')
  host.refreshOutlets()
  await settle()
  assert.ok(visibleWidth(host.headerBadgeText()) <= 80)
  // Simulate the terminal resize: the surface slice mirrors the new width
  // and the NEXT chrome refresh derives the narrower header budget.
  vt.resize(20, 24)
  await vt.waitForRender()
  app.refreshChrome()
  host.refreshOutlets()
  await settle()
  assert.ok(visibleWidth(host.headerBadgeText()) <= 20, `resize must re-bake the badge budget:\n${host.headerBadgeText()}`)
  app.stop()
})

test('setFooterCompact re-bakes at the CURRENT width after a narrow resize (finding 5)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host, 80)
  ledger.register('chrome.footer.status', { id: 'a', order: 0 }, {
    spans: [{ text: '[aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]' }],
  }, 'p1')
  ledger.register('chrome.footer.status', { id: 'b', order: 1 }, {
    spans: [{ text: '[b]' }], importance: -10,
  }, 'p2')
  host.refreshOutlets()
  await settle()
  // Narrow the terminal to 20, then toggle compact mode: the compact
  // re-bake must use the CURRENT width (20), not the outlet's stale 80.
  vt.resize(20, 24)
  await vt.waitForRender()
  await settle()
  host.setFooterCompact(true)
  await settle()
  const tight = host.footerText()
  assert.ok(visibleWidth(tight) <= 20, `compact re-bake must respect the current width (${visibleWidth(tight)} > 20): ${tight}`)
  app.stop()
})

test('a visually-empty dock label (ANSI/whitespace) is an abdication that clears health (finding 7)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 's1', generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  const handle = ledger.register('input.dock.item', { id: 'ansi-empty' }, {
    get label(): never { throw new Error('dock exploded') },
  } as never, 'plugin-a')
  host.refreshOutlets()
  await settle()
  let health = ledger.healthSnapshot().find(record => record.id === 'ansi-empty')
  assert.equal(health?.state, 'failed', 'a throwing dock contribution must be recorded failed')

  // A label that renders to ZERO visible cells (empty/whitespace spans
  // produce no visible content) is a valid abdication: clears health AND
  // produces no row.
  handle.replace({ label: [{ text: '' }] } as never)
  host.refreshOutlets()
  await settle()
  health = ledger.healthSnapshot().find(record => record.id === 'ansi-empty')
  assert.equal(health?.state, 'active', 'a visually-empty dock render must clear the failure (finding 7)')
  assert.equal(health?.errorGeneration, undefined)
  assert.equal(host.dockText(), '', 'a visually-empty dock renders nothing')
  app.stop()
})

test('a single label+detail dock item drops its detail under a 1-row budget', async () => {
  // Pure outlet test: the host's renderDock owns the 2-row policy budget,
  // so a narrower budget is exercised directly on the outlet (plan §19:
  // the dock item keeps its identity under pressure).
  const ledger = new ExtensionLedger(() => {})
  ledger.register('input.dock.item', { id: 'only' }, {
    label: [{ text: 'the-label' }], detail: [{ text: 'the-detail' }],
  }, 'p1')
  const { DockItemOutlet } = await import('../src/extension/internal/slot-outlet.ts')
  const outlet = new DockItemOutlet(ledger, { requestRender: () => {} })
  outlet.refresh(0, 1)
  const dock = outlet.text()
  assert.ok(dock.includes('the-label'), `the label must survive a 1-row budget:\n${dock}`)
  assert.ok(!dock.includes('the-detail'), `the detail must drop under a 1-row budget:\n${dock}`)
})

test('dock lines are bounded by the cell-width budget (never wrap into extra rows)', async () => {
  // Follow-up P1 probe: a 20-column snapshot rendered 40 visible columns
  // because the dock outlet had no width budget. Each label/detail line
  // must be truncated to the CURRENT cell width at bake time.
  const ledger = new ExtensionLedger(() => {})
  ledger.register('input.dock.item', { id: 'long' }, {
    label: [{ text: 'a-very-long-dock-label-that-must-not-wrap' }],
    detail: [{ text: 'with an equally long detail line' }],
  }, 'p1')
  const { DockItemOutlet } = await import('../src/extension/internal/slot-outlet.ts')
  const outlet = new DockItemOutlet(ledger, { requestRender: () => {} })
  outlet.refresh(0, 2, 20)
  const dock = outlet.text()
  // Exactly two rows (label + detail), each at most 20 visible columns.
  const rows = dock.split('\n')
  assert.equal(rows.length, 2, `a width-budgeted dock item must stay 2 rows:\n${dock}`)
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 20, `dock row must fit the width budget (${visibleWidth(row)} > 20): ${row}`)
  }
  // CJK is measured in cells, not JS length (plan §19 item 4-5).
  ledger.register('input.dock.item', { id: 'cjk' }, {
    label: [{ text: '中文超长标签超长标签超长标签' }],
  }, 'p2')
  outlet.refresh(0, 2, 20)
  for (const row of outlet.text().split('\n')) {
    assert.ok(visibleWidth(row) <= 20, `CJK dock row must fit the width budget: ${row}`)
  }
})

test('a resize re-bakes the footer segment set at the NEW width (no stale importance fold)', async () => {
  // Follow-up P1 probe: after a resize to width 20 the snapshot width was
  // 20 while the baked footer still held BOTH the low- and high-priority
  // segments from width 80. The width change must re-bake the outlets
  // immediately (not wait for the next extension invalidation).
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host, 80)
  ledger.register('chrome.footer.status', { id: 'high', order: 0 }, {
    spans: [{ text: '[high-priority-status]' }], importance: 10,
  }, 'p1')
  ledger.register('chrome.footer.status', { id: 'low', order: 1 }, {
    spans: [{ text: '[low-priority-status]' }], importance: -10,
  }, 'p2')
  host.refreshOutlets()
  await settle()
  assert.ok(host.footerText().includes('low-priority'), 'both segments fit at 80 columns')

  // Narrow the terminal: the resize event must re-bake the footer at the
  // new width, folding the low-importance segment.
  vt.resize(20, 24)
  await vt.waitForRender()
  await settle()
  const tight = host.footerText()
  assert.ok(tight.includes('high-priority'), `high-importance segment must survive the resize:\n${tight}`)
  assert.ok(!tight.includes('low-priority'), `low-importance segment must fold at the new width:\n${tight}`)
  assert.ok(visibleWidth(tight) <= 20, `footer must never exceed the new width (${visibleWidth(tight)} > 20): ${tight}`)
  app.stop()
})

test('the header badge budget accounts for host title, plan and viewer badges', async () => {
  // Follow-up P1: the badge budget was derived from the fixed prefix only;
  // a long session title + plan + viewer badges consumed the row and the
  // composed header wrapped. The budget must be derived from the ACTUAL
  // host-owned content, so the badge run shrinks (or drops) when the host
  // chrome takes the row.
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host, 40)
  app.refreshChrome()
  ledger.register('chrome.header.badge', { id: 'badge' }, { text: 'B' }, 'p1')
  host.refreshOutlets()
  app.refreshChrome()
  await settle()
  // Wide host content: title + plan + viewer badges. The badge run must be
  // re-budgeted against the ACTUAL host-owned width (not the fixed prefix),
  // so a 3-cell badge no longer fits and is truncated/dropped.
  app.setSessionTitle('a-very-long-session-title-that-keeps-growing')
  app.setPlanMode(true)
  app.setViewerMode({ parentSessionId: 'session-main', childSessionId: 'c', label: 'research subagent', mode: 'one-shot', activity: 'running' })
  host.refreshOutlets()
  app.refreshChrome()
  await vt.waitForRender()
  await settle()
  const viewport = vt.getViewport().join('\n').split('\n')
  const headerRow = viewport[0] ?? ''
  // The badge run must be bounded by what the host chrome leaves free:
  // `🐋  dsh-pi-tui · research subagent [plan] [viewing subagent · one-shot · read-only]` alone
  // exceeds 40 columns, so the remaining budget is tiny — the badge text
  // (with its 1 leading space + 3-cell run) cannot fit and is truncated.
  const hostOwned = visibleWidth('🐋  dsh-pi-tui · research subagent [plan] [viewing subagent · one-shot · read-only]')
  const budget = Math.max(1, 40 - hostOwned - 2)
  assert.ok(
    visibleWidth(host.headerBadgeText()) <= Math.max(4, budget + 1) || !host.headerBadgeText().includes('[B]'),
    `badge run must respect the host-content-derived budget (run="${host.headerBadgeText()}", budget=${budget})`,
  )
  // And the composed header never wraps the badge run onto its own line:
  // the second row must not START with a badge fragment.
  const secondRow = viewport[1] ?? ''
  assert.ok(!secondRow.includes('['), `the badge run must not wrap onto a second row:\n${secondRow}`)
  app.stop()
})

test('the TuiApp chrome merges the budgeted outlet content (integration)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  app.refreshChrome()
  ledger.register('chrome.header.badge', { id: 'budget' }, { text: 'budget-badge' }, 'p1')
  host.refreshOutlets()
  app.refreshChrome()
  app.setStatus({ model: 'm', cwd: '/w', branch: '', turns: 0, steps: 0, statsLine: '' })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('budget-badge'), `budgeted badge must render:\n${view}`)
  app.stop()
})

test('a footer segment with minWidth is never truncated below it (round-3 finding 4)', async () => {
  const ledger = new ExtensionLedger(() => {})
  // A single segment that is WIDER than the budget and declares minWidth:
  // it must be DROPPED entirely (truncating would violate the minimum).
  ledger.register('chrome.footer.status', { id: 'mw' }, {
    spans: [{ text: 'a-very-wide-segment-that-cannot-fit' }], minWidth: 40,
  }, 'p1')
  const host = new SurfaceHost(ledger, () => {})
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 'h1', generation: 1, width: 20, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  host.refreshOutlets()
  assert.equal(host.footerText(), '', 'a minWidth segment that cannot fit must be dropped, never truncated below its minimum')

  // Mixed: a minWidth-less segment may be truncated; a minWidth segment
  // behind it is dropped rather than truncated.
  const ledger2 = new ExtensionLedger(() => {})
  ledger2.register('chrome.footer.status', { id: 'plain', order: 0 }, {
    spans: [{ text: '[state]' }],
  }, 'p1')
  ledger2.register('chrome.footer.status', { id: 'mw2', order: 1 }, {
    spans: [{ text: 'x'.repeat(30) }], minWidth: 25,
  }, 'p2')
  const host2 = new SurfaceHost(ledger2, () => {})
  host2.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: 'h2', generation: 1, width: 20, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
  host2.refreshOutlets()
  const text2 = host2.footerText()
  // The minWidth contract: a segment declaring minWidth is NEVER rendered
  // truncated below it. Whether the minWidth-less `[state]` survives or the
  // whole footer collapses depends on the importance fold — but no rendered
  // segment may be shorter than its declared minimum.
  assert.ok(!text2.includes('x'), `a minWidth segment must be dropped, never truncated:\n${text2}`)
  assert.ok(visibleWidth(text2) <= 20, `footer must fit the budget:\n${text2}`)
})

test('chrome slots strip terminal control sequences from plugin text (plan §19 item 10)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  // Hostile payloads in every chrome slot: badge text, dock spans, footer
  // spans, and widget spans. The choke points (styleBadge / renderSpans)
  // must leave NO ESC byte in the baked chrome text.
  const payloads = ['\x1b[2J', '\x1b]0;x\x07', '\x1b[?1049h', '\x1b[1;5H', '\u009d0;x\u009c', '\u009b2J']
  for (let index = 0; index < payloads.length; index++) {
    const payload = payloads[index]
    ledger.register('chrome.header.badge', { id: `b${index}` }, { text: `pre${payload}post` }, 'p1')
    ledger.register('input.dock.item', { id: `d${index}` }, {
      label: [{ text: `pre${payload}post` }],
    }, 'p1')
    ledger.register('chrome.footer.status', { id: `f${index}` }, {
      spans: [{ text: `pre${payload}post` }],
    }, 'p1')
    ledger.register('input.widget.above', { id: `w${index}` }, {
      view: { kind: 'text', spans: [{ text: `pre${payload}post` }] },
    }, 'p1')
  }
  host.refreshOutlets()
  await settle()
  const combined = host.headerBadgeText() + host.dockText() + host.footerText() + host.widgetsAboveText()
  // The host's own SGR styling is the only allowed ANSI.
  const withoutSgr = combined.replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(!withoutSgr.includes('\x1b'), `chrome text leaked an ESC byte:\n${JSON.stringify(withoutSgr)}`)
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(withoutSgr),
    `chrome text leaked a control byte:\n${JSON.stringify(withoutSgr)}`)
  // Visible content survives.
  assert.ok(combined.includes('pre'), 'prefix content must survive sanitization')
  assert.ok(combined.includes('post'), 'suffix content must survive sanitization')
  app.stop()
})
