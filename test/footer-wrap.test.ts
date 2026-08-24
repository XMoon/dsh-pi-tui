/**
 * Headless tests for the narrow-screen footer (requirement 9): the host
 * line-1 WRAPS instead of being hard-truncated (host info survives on
 * narrow terminals), the row caps backstop runaway content (host ≤3 rows,
 * stats ≤1, total ≤4, tail cut with '…'), extension footer segments still
 * merge into the wrapped footer, and the compact preset keeps its
 * single-line semantics on normal widths.
 * @module @xmoon76/dsh-pi-tui/footer-wrap.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Text } from '@xmoon76/pi-tui'
import { TuiApp, type StatusData } from '../src/tui-app.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(columns: number): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

/** Realistic status: wraps to 2-3 host rows at 40 columns (everything the
 * old hard truncation cut — branch, counters, context bar — must survive). */
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
    performance: { llmMs: 12300, firstTokenMs: 0, tokensPerSec: 0 },
    turns: 3,
    steps: 7,
  },
}

/** Extreme status: more than the 3-row host budget even at 40 columns —
 * the cap must cut the tail with '…'. The stats line is the longest the
 * pi vocabulary can produce, so it wraps and caps too. */
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

/** The viewport rows that carry footer content. */
function footerRows(view: string): string[] {
  return view.split('\n').filter(line => line.trim() !== '' && (
    line.includes('[workspace-write]') || line.includes('[yolo]') || line.includes('[read-only]')
    || line.includes('deepseek') || line.includes('/home/') || line.includes('t3/s7')
    || line.includes('LLM') || line.includes('↑') || line.includes('…')))
}

test('a narrow terminal wraps the footer to multiple rows without losing host info', async () => {
  const { vt, app } = startApp(40)
  app.setStatus(SHORT_STATUS)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // Every host fact survives the narrow width — the old hard truncation
  // cut everything past column 40 (the counters, branch, context bar).
  assert.ok(view.includes('[workspace-write]'), `permission badge lost:\n${view}`)
  assert.ok(view.includes('deepseek/flash'), `model lost:\n${view}`)
  assert.ok(view.includes('feat/narrow-footer'), `branch lost:\n${view}`)
  assert.ok(view.includes('t3/s7'), `turn/step counters lost:\n${view}`)
  assert.ok(view.includes('12.3s'), `stats line lost:\n${view}`)
  const rows = footerRows(view)
  assert.ok(rows.length >= 3, `the footer must occupy multiple rows at 40 columns, saw ${rows.length}:\n${view}`)
  app.stop()
})

test('runaway host content is capped: ≤3 host rows + 1 stats row, tail cut', async () => {
  const { vt, app } = startApp(40)
  app.setStatus(EXTREME_STATUS)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const rows = footerRows(view)
  assert.ok(rows.length <= 4, `the footer must never exceed 4 rows, saw ${rows.length}:\n${view}`)
  assert.ok(rows.length >= 3, `the extreme state must still wrap to multiple rows, saw ${rows.length}:\n${view}`)
  assert.ok(rows.some(row => row.includes('…')), `the capped rows must carry the ellipsis:\n${view}`)
  assert.ok(rows.some(row => row.includes('↑') && row.includes('…')), `the stats row must survive its own cap with the ellipsis:\n${view}`)
  app.stop()
})

test('extension footer segments still merge into the wrapped footer', async () => {
  const ledger = new ExtensionLedger(() => {})
  const vt = new VirtualTerminal(40, 24)
  let app!: TuiApp
  const host = new SurfaceHost(ledger, () => app.requestRender())
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId,
    generation: 1,
    width: 40,
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
  host.refreshOutlets()
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('[EXT-SEG]'), `the extension segment must merge into the footer:\n${view}`)
  assert.ok(view.includes('deepseek/flash'), `host state must survive beside the segment:\n${view}`)
  app.stop()
})

test('the compact preset keeps its single-line semantics on normal widths', async () => {
  const { vt, app } = startApp(100)
  app.setStatus(SHORT_STATUS)
  app.setFooterPreset('compact')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('12.3s'), `compact must hide the stats line:\n${view}`)
  const rows = footerRows(view)
  assert.equal(rows.length, 1, `compact at a normal width must stay one row, saw ${rows.length}:\n${view}`)
  app.stop()
})

test('a wide terminal keeps the two-row footer (no behavior change)', async () => {
  const { vt, app } = startApp(120)
  app.setStatus(SHORT_STATUS)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const rows = footerRows(view)
  assert.equal(rows.length, 2, `full preset at a wide width stays two rows, saw ${rows.length}:\n${view}`)
  app.stop()
})
