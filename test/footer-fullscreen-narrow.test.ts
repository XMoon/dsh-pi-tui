/**
 * Fullscreen narrow-footer regression (plan 2026-08-31 §13.2 / Step 1): the
 * footer is pinned chrome (`shrink: 0`) at the BOTTOM of the fullscreen
 * VStack. When a narrow width lets a logical row wrap past its budget the
 * footer's physical height grows — and because every row below the
 * ScrollView is pinned and non-shrinkable, the BOTTOM footer row(s) are
 * clipped out of the viewport: the statusline "disappears" row by row while
 * the transcript is already at zero.
 *
 * The contract under test: a logical footer row occupies at most TWO
 * physical lines and the surface's global budget is THREE physical lines
 * (status ≤ 2 + stats ≤ 1), so the whole footer always fits beside the
 * other pinned chrome on short viewports (plan §6.1).
 * @module @xmoon76/dsh-pi-tui/footer-fullscreen-narrow.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp, type StatusData } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Realistic status: at narrow widths the status row wraps 3+ times. */
const RICH_STATUS: StatusData = {
  model: 'deepseek/flash',
  cwd: '/home/x/proj',
  branch: 'feat/narrow-footer',
  turns: 3,
  steps: 7,
  statsLine: '3 turns · 7 steps · 12.3s',
  permission: 'workspace-write',
  contextTokens: 1000,
  contextWindow: 10000,
  usage: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 12300, firstTokenMs: 0, tokensPerSec: 0 },
    turns: 3,
    steps: 7,
  },
}

/** Pinned chrome above the editor so short viewports run out of rows —
 * the state where the wrapped footer used to push ITSELF out of the
 * screen. */
async function startFullscreenApp(columns: number, rows: number): Promise<{ vt: VirtualTerminal; app: TuiApp }> {
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus(RICH_STATUS)
  app.setTodoSummary([
    { content: 'fix the narrow footer clipping', status: 'in_progress' },
    { content: 'run the full gate', status: 'pending' },
  ])
  app.setTasks([{ id: 'a', label: 'agent-one', status: 'running' }])
  app.setWorking(true)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  return { vt, app }
}

/** The fullscreen-pinned contract shared by every matrix cell. `expectStats`
 * marks the cells where the OTHER pinned chrome (header + todo + working +
 * editor) still leaves the full 3-line footer budget on screen — the
 * regression cells where the old 4-line budget clipped the stats row out
 * of the viewport. */
function assertPinnedChromeIntact(
  app: TuiApp,
  view: string,
  columns: number,
  viewportRows: number,
  expectStats: boolean,
): void {
  const lines = view.split('\n')
  // The editor frame must survive in full: both borders on screen near the
  // bottom (never pushed out or compressed).
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `editor top border missing at ${columns}x${viewportRows}:\n${view}`)
  assert.ok(
    lines.slice(editorTop + 1).some(line => line.includes('─'.repeat(10))),
    `editor bottom border missing at ${columns}x${viewportRows}:\n${view}`,
  )
  // High-importance footer facts survive every width: the permission badge
  // (importance 110) is the contract's floor — the footer must never be
  // COMPLETELY gone.
  assert.ok(view.includes('workspace-write'), `permission badge lost at ${columns}x${viewportRows}:\n${view}`)
  assert.ok(
    view.includes('deepseek'),
    `the model badge must survive at ${columns}x${viewportRows}:\n${view}`,
  )
  if (expectStats) {
    assert.ok(
      view.includes('12.3s'),
      `the stats row was clipped out of the viewport at ${columns}x${viewportRows}:\n${view}`,
    )
  }
  // The footer's PHYSICAL-LINE contract (plan §6.1/§13.2), read from the
  // footer COMPONENT itself (footerRenderRowsForTest — the exact rows the
  // layout paints; never a viewport reconstruction): at most THREE footer
  // physical rows (in fullscreen it can only be SMALLER, when the other
  // pinned chrome leaves less room).
  const footerLines = [...app.footerRenderRowsForTest()]
  assert.ok(footerLines.length <= 3, `the footer exceeded its 3-line budget at ${columns}x${viewportRows}:\n${view}`)
  // And every rendered line stays inside the terminal width.
  for (const line of lines) {
    assert.ok(
      visibleWidth(line.trimEnd()) <= columns,
      `a rendered line overflows the terminal at ${columns}x${viewportRows}: ${JSON.stringify(line)}`,
    )
  }
  // ANSI sanity: no half-escaped rows.
  for (const line of lines) {
    const truncated = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
    assert.equal(truncated, null, `truncated ANSI at ${columns}x${viewportRows}: ${JSON.stringify(line)}`)
  }
}

test('the footer never clips out of a narrow fullscreen viewport', async () => {
  // The plan's §13.2 matrix. 40x10 / 30x10 are the regression cells: the
  // old 4-line budget pushed the stats row below the screen while the
  // transcript was already at zero. 20x10 is the documented EXTREME cell:
  // the 20-column todo panel wraps to 2 rows of chrome, so only 2 footer
  // slots remain at this width — the composer still honors its 3-line
  // budget (locked at composer level) and keeps the high-importance
  // content visible, which is the plan's "footer must not disappear"
  // assertion for that cell.
  for (const [columns, viewportRows, expectStats] of [
    [80, 24, true], [60, 16, true], [40, 12, true], [40, 10, true], [30, 10, true], [20, 10, false],
  ] as const) {
    const { vt, app } = await startFullscreenApp(columns, viewportRows)
    try {
      const view = vt.getViewport().join('\n')
      assert.ok(view.length > 0, `empty viewport at ${columns}x${viewportRows}`)
      assertPinnedChromeIntact(app, view, columns, viewportRows, expectStats)
    } finally {
      app.stop()
    }
  }
})

test('the armed Ctrl+C instruction never pushes the footer out of a narrow fullscreen viewport', async () => {
  // Ctrl+C (arm) shows the Host instruction: 3 physical lines were then
  // spent on the status row + the exit hint and the stats row clipped.
  // The instruction is an INDEPENDENT surface with a 1-line contract
  // (plan §7): 1 status line + 1 stats line + 1 instruction line must fit
  // — inside the same 3-line budget, read from the footer component.
  const { vt, app } = await startFullscreenApp(40, 10)
  try {
    vt.sendInput('\x03') // arm the exit window: the hint owns its own line
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    assert.ok(view.includes('Press Ctrl+C again to exit'), `the exit hint must stay visible:\n${view}`)
    assert.ok(view.includes('workspace-write'), `the status row must survive beside the hint:\n${view}`)
    assert.ok(view.includes('LLM 12.3s'), `the stats row must survive beside the hint:\n${view}`)
    const footerLines = [...app.footerRenderRowsForTest()]
    assert.equal(footerLines.length, 3, `the footer with its instruction must stay inside the 3-line budget:\n${view}`)
    assert.ok(footerLines[footerLines.length - 1]!.includes('Press Ctrl+C again'), `the hint must be the footer's last line:\n${view}`)
    for (const line of lines) {
      const truncated = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncated, null, `truncated ANSI: ${JSON.stringify(line)}`)
    }
  } finally {
    app.stop()
  }
})