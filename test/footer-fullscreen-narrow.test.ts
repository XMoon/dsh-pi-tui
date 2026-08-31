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
 * physical lines, the composer's hard capacity is FOUR physical lines,
 * and the SURFACE hands the composer the effective budget
 * min(4, currently-available footer rows) — so the whole footer always
 * fits beside the other pinned chrome on short viewports and the appended
 * Host instruction is never viewport-clipped (plan §6.1; the PR #57 review task, sections 1-3).
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
 * / `expectModel` mark the cells that leave ENOUGH footer slots for the
 * stats line / the model badge after the other pinned chrome (header +
 * todo + working + editor) is laid out — under the surface budget even
 * the model may drop at extreme cells (20x10 leaves 2 slots: the
 * highest-importance permission line wins, plan §7/§8). */
function assertPinnedChromeIntact(
  app: TuiApp,
  view: string,
  columns: number,
  viewportRows: number,
  expectStats: boolean,
  expectModel = true,
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
  // COMPLETELY gone. The responsive compact pass may shorten it to `ww`
  // and the model to its id under pressure.
  assert.ok(view.includes('workspace-write') || view.includes('ww'), `permission badge lost at ${columns}x${viewportRows}:\n${view}`)
  if (expectModel) {
    assert.ok(
      view.includes('deepseek') || view.includes('flash'),
      `the model badge must survive at ${columns}x${viewportRows}:\n${view}`,
    )
  }
  if (expectStats) {
    assert.ok(
      view.includes('12.3s'),
      `the stats row was clipped out of the viewport at ${columns}x${viewportRows}:\n${view}`,
    )
  }
  // The footer's PHYSICAL-LINE contract (plan §6.1/§13.2), read from the
  // footer COMPONENT itself (footerRenderRowsForTest — the exact rows the
  // layout paints; never a viewport reconstruction): at most FOUR footer
  // physical rows (the hard capacity — the effective surface budget can
  // only be SMALLER when the other pinned chrome leaves less room) —
  // and EVERY rendered row must actually be visible in the viewport,
  // which is what fails when the budget exceeds the surface capacity.
  const footerLines = [...app.footerRenderRowsForTest()]
  assert.ok(footerLines.length <= 4, `the footer exceeded its 4-line capacity at ${columns}x${viewportRows}:\n${view}`)
  const plainViewportLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  for (const row of footerLines) {
    const text = row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    assert.ok(text !== '' && plainViewportLines.some(line => line.includes(text)),
      `a rendered footer row was clipped out of the viewport at ${columns}x${viewportRows}: ${JSON.stringify(text)}\n${view}`)
  }
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
  // the 20-column todo panel wraps the chrome, so only TWO footer slots
  // remain — the surface hands the composer total=2, the footer renders
  // status + stats (both one line, both visible) and the status row
  // COMPACTS (ww/flash/ctx 10%) instead of dropping the model, which the
  // plan's "footer must not disappear + one high-importance status must
  // survive" contract covers.
  for (const [columns, viewportRows, expectStats, expectModel] of [
    [80, 24, true, true], [60, 16, true, true], [40, 12, true, true],
    [40, 10, true, true], [30, 10, true, true], [20, 10, true, false],
  ] as const) {
    const { vt, app } = await startFullscreenApp(columns, viewportRows)
    try {
      const view = vt.getViewport().join('\n')
      assert.ok(view.length > 0, `empty viewport at ${columns}x${viewportRows}`)
      assertPinnedChromeIntact(app, view, columns, viewportRows, expectStats, expectModel)
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
    assert.ok(view.includes('workspace-write') || view.includes('ww'), `the status row must survive beside the hint:\n${view}`)
    assert.ok(view.includes('LLM 12.3s'), `the stats row must survive beside the hint:\n${view}`)
    const footerLines = [...app.footerRenderRowsForTest()]
    assert.equal(footerLines.length, 3, `the footer with its instruction must stay inside the effective budget:\n${view}`)
    assert.ok(footerLines[footerLines.length - 1]!.includes('Press Ctrl+C again'), `the hint must be the footer's last line:\n${view}`)
    const plainViewportLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
    for (const row of footerLines) {
      const text = row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
      assert.ok(text !== '' && plainViewportLines.some(line => line.includes(text)),
        `a footer row was clipped out of the viewport: ${JSON.stringify(text)}\n${view}`)
    }
    for (const line of lines) {
      const truncated = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncated, null, `truncated ANSI: ${JSON.stringify(line)}`)
    }
  } finally {
    app.stop()
  }
})

test('the armed Ctrl+C instruction on a chrome-heavy 20x10 viewport is NEVER clipped', async () => {
  // THE P2 regression (PR #57 review task, sections 2 and 7.1): at 20x10 the pinned chrome
  // (header + wrapped todo + working + editor) leaves only TWO footer
  // slots. Without the surface budget the composer still emitted
  // status + stats + instruction (4 rows at this width) and — since the
  // instruction is appended LAST — the exit hint was the row the viewport
  // clipped. The surface must hand the composer
  // total = min(4, availableRows) = 2, so the hint survives IN THE
  // VIEWPORT at the cost of the lower-importance stats row.
  const { vt, app } = await startFullscreenApp(20, 10)
  try {
    vt.sendInput('\x03') // arm the exit window
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    // The hint's viewport-visible form at 20 columns: the full text is
    // 26 cells and the line is 20 — the ANSI-safe cap carries the prefix.
    assert.ok(
      lines.some(line => line.includes('Press Ctrl+C again')),
      `the exit hint must be visible in the VIEWPORT (not only in the component):\n${view}`,
    )
    // One high-importance status fact survives beside it (importance
    // order): the permission badge outranks everything else (the compact
    // pass may shorten it to `ww`).
    assert.ok(view.includes('workspace-write') || view.includes('ww'), `the high-importance status must survive:\n${view}`)
    const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
    assert.ok(editorTop !== -1, `editor top border missing:\n${view}`)
    assert.ok(
      lines.slice(editorTop + 1).some(line => line.includes('─'.repeat(10))),
      `editor bottom border missing:\n${view}`,
    )
    // The footer renders exactly the surface budget: status + hint, hint
    // last, and both rows painted.
    const footerLines = [...app.footerRenderRowsForTest()]
    assert.equal(footerLines.length, 2, `the surface budget must flow into the composer:\n${view}`)
    assert.ok(footerLines[footerLines.length - 1]!.includes('Press Ctrl+C again'), `the hint must be last:\n${view}`)
    const plainViewportLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
    for (const row of footerLines) {
      const text = row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
      assert.ok(text !== '' && plainViewportLines.some(line => line.includes(text)),
        `a footer row was clipped out of the viewport: ${JSON.stringify(text)}\n${view}`)
    }
    for (const line of lines) {
      const truncated = line.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncated, null, `truncated ANSI: ${JSON.stringify(line)}`)
    }
  } finally {
    app.stop()
  }
})

test('a regular -> fullscreen switch recomposes the budget (widgets are fullscreen-inactive)', async () => {
  // PR #57 review R3 P1: the widget zones mount ONLY on the regular
  // surface. With populated widgets on a short terminal the REGULAR
  // budget is squeezed (widgets + header + editor), while the FULLSCREEN
  // root does not mount the widgets at all — the same geometry must
  // grant the fullscreen footer its full effective budget, which proves
  // BOTH the conditional accounting and the mode-switch recomposition.
  const { ExtensionLedger } = await import('../src/extension/internal/ledger.ts')
  const { SurfaceHost } = await import('../src/extension/internal/surface-host.ts')
  const { Text } = await import('@xmoon76/pi-tui')
  const ledger = new ExtensionLedger(() => {})
  const vt = new VirtualTerminal(80, 8)
  let app!: TuiApp
  const host = new SurfaceHost(ledger, () => app.requestRender())
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId,
    generation: 1,
    width: 80,
    height: 8,
    fullscreen: false,
    focusedSeat: 'editor',
    themeId: 'dark',
    themeRevision: 0,
  })
  app.setStatus(RICH_STATUS)
  ledger.register('input.widget.below', { id: 'b1', order: 1 }, {
    view: { kind: 'rows', rows: [
      { kind: 'text', spans: [{ text: 'widget-row-1' }] },
      { kind: 'text', spans: [{ text: 'widget-row-2' }] },
      { kind: 'text', spans: [{ text: 'widget-row-3' }] },
    ] },
    importance: 0,
  }, 'p1')
  host.refreshOutlets()
  await vt.waitForRender()
  // REGULAR at 80x8: the regular surface is a FLOWING document — overflow
  // enters the terminal scrollback and the footer is never
  // viewport-clipped there, so it always receives the FULL capacity
  // (demand-limited to 3 rows here) and populated widgets never squeeze
  // it (PR #57 review P2: do not trade fullscreen clipping for regular
  // information loss).
  const regularRows = [...app.footerRenderRowsForTest()]
  assert.equal(regularRows.length, 3, `the regular footer keeps its full demand inside the capacity, saw ${regularRows.length}:\n${regularRows.join('\n')}`)
  // FULLSCREEN at unchanged geometry: the widgets are NOT mounted (and
  // the widgets stay unrendered), but the pinned chrome IS — the budget
  // recomposes to the surface capacity (8 - header 1 - editor 3 = 4 →
  // capacity-capped; the demand-limited footer keeps its rows).
  app.setFullscreen(true)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const fullscreenRows = [...app.footerRenderRowsForTest()]
  assert.ok(fullscreenRows.length >= 2, `the fullscreen footer must survive beside its pinned chrome:\n${fullscreenRows.join('\n')}`)
  for (const row of fullscreenRows) {
    const text = row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    assert.ok(view.split('\n').some(line => line.includes(text)),
      `a fullscreen footer row was clipped: ${JSON.stringify(text)}\n${view}`)
  }
  for (const line of vt.getViewport()) {
    assert.ok(!line.includes('widget-row'), `an unmounted widget must not paint in fullscreen:\n${line}`)
  }
  app.stop()
})

test('a surface with ZERO available footer slots renders nothing at all', async () => {
  // The pinned chrome alone fills the terminal (header + editor = every
  // row): the surface grants total = 0 and the composer renders NOTHING —
  // even the armed Host instruction stays unpainted, because no footer
  // line could avoid the clip and painting one would exceed the granted
  // budget (the composer agrees with its Text component: zero rows).
  const vt = new VirtualTerminal(80, 4)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus(RICH_STATUS)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('\x03')
  await vt.waitForRender()
  try {
    const footerLines = [...app.footerRenderRowsForTest()]
    assert.equal(footerLines.length, 0, `a zero-slot surface must render no footer rows:\n${footerLines.join('\n')}`)
  } finally {
    app.stop()
  }
})

test('a terminal HEIGHT resize recomposes the footer at the fresh surface budget', async () => {
  // PR #57 review P1: the footer's physical-line budget derives from the
  // terminal geometry. A resize (height AND width) must recompose the
  // footer BEFORE the frame paints — shrinking a chrome-heavy fullscreen
  // from 20x24 to 20x10 must not keep the old 4-row footer text (its
  // bottom rows — the appended instruction FIRST — would clip), and
  // growing it back must restore the fuller footer.
  const { vt, app } = await startFullscreenApp(40, 24)
  try {
    vt.sendInput('\x03') // arm the exit hint: it must survive every resize
    await vt.waitForRender()
    const before = [...app.footerRenderRowsForTest()]
    assert.ok(before.length >= 3, `roomy viewport renders the fuller footer, saw ${before.length}`)

    // Shrink 40x24 → 20x10: budget collapses to the surface capacity.
    vt.resize(20, 10)
    await vt.waitForRender()
    const shrunk = [...app.footerRenderRowsForTest()]
    assert.ok(shrunk.length <= 2, `the shrunken viewport must cap the footer at its 2 available slots, saw ${shrunk.length}\n${shrunk.join('\n')}`)
    assert.ok(
      shrunk[shrunk.length - 1]!.includes('Press Ctrl+C again'),
      `the hint must survive the height shrink:\n${shrunk.join('\n')}`,
    )
    let view = vt.getViewport().join('\n')
    assert.ok(
      view.split('\n').some(line => line.includes('Press Ctrl+C again')),
      `the hint must be visible in the VIEWPORT after the shrink:\n${view}`,
    )

    // Grow back: the full capacity is available again.
    vt.resize(40, 24)
    await vt.waitForRender()
    const grown = [...app.footerRenderRowsForTest()]
    assert.ok(grown.length >= shrunk.length, `growing must not keep the shrunken footer:\n${grown.join('\n')}`)
    view = vt.getViewport().join('\n')
    assert.ok(
      view.split('\n').some(line => line.includes('Press Ctrl+C again to exit')),
      `the hint must be uncapped again after the growth:\n${view}`,
    )
  } finally {
    app.stop()
  }
})

test('the command footer consumes the surface budget: the hint is never clipped behind command rows', async () => {
  // PR #57 review P2: the COMMAND footer surface previously bypassed the
  // surface physical-line budget — on a chrome-heavy short fullscreen the
  // command row + the appended instruction exceeded the granted slots and
  // the hint (last) was the clipped row. The command surface now consumes
  // the same effective total: instruction reserves 1 first, the trusted
  // command rows keep the remaining slots in order.
  const { vt, app } = await startFullscreenApp(20, 10)
  try {
    app.setFooterCommandRows(['cmd-status'])
    await vt.waitForRender()
    vt.sendInput('\x03') // arm the exit hint
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    // effective total at 20x10 = 2: 1 command row + 1 hint.
    assert.ok(
      lines.some(line => line.includes('Press Ctrl+C again')),
      `the exit hint must be visible in the VIEWPORT:\n${view}`,
    )
    assert.ok(view.includes('cmd-status'), `the command row must keep the remaining slot:\n${view}`)
    const footerLines = [...app.footerRenderRowsForTest()]
    assert.equal(footerLines.length, 2, `1 command row + hint inside the effective budget:\n${view}`)
    assert.ok(footerLines[footerLines.length - 1]!.includes('Press Ctrl+C again'), `the hint must be last:\n${view}`)
    const plainViewportLines = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
    for (const row of footerLines) {
      const text = row.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
      assert.ok(text !== '' && plainViewportLines.some(line => line.includes(text)),
        `a footer row was clipped out of the viewport: ${JSON.stringify(text)}\n${view}`)
    }
  } finally {
    app.stop()
  }
})

test('a ONE-slot command surface spends the slot on the instruction', async () => {
  // 20x9 leaves a single footer slot: with the hint armed the command row
  // drops and the instruction takes the only line (the task's allocation
  // rule: prefer the instruction on a one-slot surface).
  const { vt, app } = await startFullscreenApp(20, 9)
  try {
    app.setFooterCommandRows(['cmd-status'])
    await vt.waitForRender()
    vt.sendInput('\x03')
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    assert.ok(
      lines.some(line => line.includes('Press Ctrl+C again')),
      `the exit hint must own the only slot:\n${view}`,
    )
    const footerLines = [...app.footerRenderRowsForTest()]
    assert.equal(footerLines.length, 1, `exactly the granted slot:\n${view}`)
    assert.ok(footerLines[0]!.includes('Press Ctrl+C again'), `the slot must be the hint:\n${view}`)
    assert.ok(!view.includes('cmd-status'), `the command row must drop under height pressure:\n${view}`)
  } finally {
    app.stop()
  }
})