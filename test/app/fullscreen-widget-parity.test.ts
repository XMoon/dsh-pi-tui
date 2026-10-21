/**
 * PR-D Stable widget parity: the `input.widget.above` / `input.widget.below`
 * Stable contributions are mounted on BOTH physical roots (regular document
 * and fullscreen VStack), and their effective fullscreen row grant can fall to
 * ZERO before the editor, the footer or the minimum transcript viewport loses
 * space. Everything here is measured on real painted cells: a real `TuiApp`,
 * the real `SurfaceHost`/`WidgetOutlet`, a real `VirtualTerminal` and (for the
 * public-boundary case) the real Stable extension service.
 * @module @xmoon76/dsh-pi-tui/fullscreen-widget-parity.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Text, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp, type OwnedRunner, type StatusData, type TuiAppEventsBase } from '../../src/tui-app.ts'
import { ExtensionLedger } from '../../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../../src/extension/internal/surface-host.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { runOwned } from '../../src/runtime/process/tasks.ts'
import { PI_TUI_EXTENSIONS_SERVICE, apply as applyExtensionHost } from '../../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { setTheme } from '../../src/tui/theme/runtime.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import type { FooterLayoutV1 } from '../../src/tui/footer/presentation-types.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'

/** The process slot (vendored fork keybindings) is released only by the FINAL
 * dispose, never by stop(): every TuiApp started here is disposed after each
 * test. */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
  // The fork's palette is process-global: a test that switched themes must not
  // leak it into the next one.
  setTheme('dark')
})

/** Let the outlet invalidation batcher (one microtask) and the render request
 * settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

type WidgetZone = 'input.widget.above' | 'input.widget.below'

interface WidgetHandle {
  dispose(): void
  replace(next: unknown): void
}

interface WidgetHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly host: SurfaceHost
  readonly ledger: ExtensionLedger
  readonly submitted: string[]
  attachCount(): number
}

/** The owned-task entry the runner wires in production: the clipboard paste
 * routes through it, so a harness that exercises the right-click paste uses
 * the REAL `runOwned` with a silent capture diag. */
const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
const owned: OwnedRunner = (label, task, options) => {
  runOwned(label, task, { ...options, diag })
}

/** A real TuiApp + SurfaceHost + ExtensionLedger on a live VirtualTerminal.
 * `options.app` extends the TuiApp options (e.g. `readClipboardText`) and
 * `options.events` the events bag (e.g. the real `runOwned`). */
function makeHarness(
  cols: number,
  rows: number,
  ledger = new ExtensionLedger(() => {}),
  options: {
    app?: NonNullable<ConstructorParameters<typeof TuiApp>[2]>
    events?: Partial<TuiAppEventsBase> & { runOwned?: OwnedRunner }
  } = {},
): WidgetHarness {
  const submitted: string[] = []
  const vt = new VirtualTerminal(cols, rows)
  let app!: TuiApp
  const host = new SurfaceHost(ledger, () => app.requestRender())
  let attaches = 0
  const originalAttach = host.attach
  // Test-owned wrapper (the unbound original is called with the instance, not
  // bound to the prototype): proves a screen swap never re-attaches the host.
  host.attach = (chrome, snapshot) => {
    attaches += 1
    originalAttach.call(host, chrome, snapshot)
  }
  app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {}, ...options.events }, { extensionHost: host, ...options.app })
  app.start()
  startedApps.add(app)
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId,
    generation: 1,
    width: cols,
    height: rows,
    fullscreen: false,
    focusedSeat: 'editor',
    themeId: 'dark',
    themeRevision: 0,
  })
  return { vt, app, host, ledger, submitted, attachCount: () => attaches }
}

/** Register one Stable widget contribution through the ledger (the same
 * contribution shape the public service accepts). */
function registerWidget(
  ledger: ExtensionLedger,
  zone: WidgetZone,
  id: string,
  text: string,
  options: { importance?: number; owner?: string } = {},
): WidgetHandle {
  return ledger.register(zone, { id, order: 0 }, {
    view: { kind: 'text', spans: [{ text }] },
    importance: options.importance ?? 0,
  }, options.owner ?? `owner-${id}`) as unknown as WidgetHandle
}

/** Register one multi-row widget contribution (a `rows` view). */
function registerRows(
  ledger: ExtensionLedger,
  zone: WidgetZone,
  id: string,
  rows: readonly string[],
  options: { importance?: number; owner?: string } = {},
): WidgetHandle {
  return ledger.register(zone, { id, order: 0 }, {
    view: { kind: 'rows', rows: rows.map(text => ({ kind: 'text', spans: [{ text }] })) },
    importance: options.importance ?? 0,
  }, options.owner ?? `owner-${id}`) as unknown as WidgetHandle
}

/** A bare SurfaceHost (no TuiApp): the outlet-level unit surface. An attached
 * TuiApp re-issues its own grants on every render pass, so a directly
 * manipulated zero grant is only observable without one. */
function makeBareHost(): { host: SurfaceHost; ledger: ExtensionLedger } {
  const ledger = new ExtensionLedger(() => {})
  const host = new SurfaceHost(ledger, () => {})
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
  return { host, ledger }
}

const SGR = /\x1b\[[0-9;]*m/g
const strip = (text: string): string => text.replace(SGR, '')

/** The painted viewport (physical cells, SGR stripped, right-trimmed). */
function painted(vt: VirtualTerminal): string[] {
  return vt.getViewport().map(line => line.replace(SGR, '').trimEnd())
}

/** The outlet's projected rows, ANSI-stripped. */
function outlet(host: SurfaceHost, zone: 'above' | 'below'): string {
  return strip(zone === 'above' ? host.widgetsAboveText() : host.widgetsBelowText()).trimEnd()
}

/** One SGR primary press+release at 1-based screen coordinates (the fork's
 * fullscreen click path). */
function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

/** One SGR SECONDARY-button press (button 2) at 1-based coordinates: the
 * fork's right-click clipboard-paste trigger. Only the press matters —
 * `handleRightClickPaste` rejects releases. */
function rightClick(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<2;${x};${y}M`)
}

/** Run `body` with the fork's right-click clipboard paste ENABLED. The fork
 * (`packages/pi-tui/src/tui-alt-screen.ts` `handleRightClickPaste`) requires
 * BOTH `process.platform === 'win32'` and a non-VSCode `TERM_PROGRAM`; neither
 * holds on every host that runs this suite, so both gates are neutralised in
 * ONE finally-restored scope. The restoration is exact: the original platform
 * descriptor, and the original `TERM_PROGRAM` string or its absence (a VSCode
 * integrated terminal keeps `TERM_PROGRAM=vscode`, where the fork refuses the
 * paste by design). Each test FILE runs in its own process, and this helper
 * cannot leak past its await. */
async function withRightClickPaste<T>(body: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const hadTermProgram = Object.prototype.hasOwnProperty.call(process.env, 'TERM_PROGRAM')
  const termProgram = process.env.TERM_PROGRAM
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  process.env.TERM_PROGRAM = 'test-terminal'
  try {
    return await body()
  } finally {
    if (hadTermProgram) process.env.TERM_PROGRAM = termProgram
    else delete process.env.TERM_PROGRAM
    if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
  }
}

function rowsWith(lines: readonly string[], needle: string): number[] {
  return lines.map((line, index) => (line.includes(needle) ? index : -1)).filter(index => index !== -1)
}

/** The row indices of the editor's top and bottom border in the painted
 * viewport, anchored on the prompt row: the Todo panel draws its OWN border
 * rule, so a bare "two long `─` runs" search is ambiguous. */
function editorBounds(lines: readonly string[]): { top: number; bottom: number } {
  const border = '─'.repeat(10)
  const prompt = lines.findIndex(line => line.includes('❯'))
  const top = prompt < 0 ? -1 : lines.slice(0, prompt).findLastIndex(line => line.includes(border))
  const bottom = prompt < 0 ? -1 : lines.findIndex((line, index) => index > prompt && line.includes(border))
  assert.ok(prompt >= 0 && top >= 0 && bottom > prompt,
    `the editor's prompt and both borders must be painted:\n${lines.join('\n')}`)
  return { top, bottom }
}

function rowAt(lines: readonly string[], index: number): string {
  const row = lines[index]
  assert.ok(row !== undefined, `row ${index} is outside the painted viewport:\n${lines.join('\n')}`)
  return row
}

/** The bottom row of the MODAL frame occupying the seat (a Question or Save
 * Location frame): the editor prompt row is gone while a modal owns the seat,
 * so the modal's own bottom border anchors the same structural check. */
function modalSeatBottom(lines: readonly string[]): number {
  const bottom = lines.findLastIndex(line => line.includes('╰'))
  assert.ok(bottom >= 0, `the modal frame's bottom border must be painted:\n${lines.join('\n')}`)
  return bottom
}

/** Every footer row the composer produced must be physically painted, and the
 * viewport bottom must be the footer's last row (a clipped pinned row would
 * make the trailing count negative). Fullscreen-only: the regular document
 * flows from the top and its overflow enters the scrollback. `seatBottom`
 * overrides the editor-prompt anchor for the modal-owns-the-seat cases. */
function assertFooterPainted(h: WidgetHarness, lines: readonly string[], seatBottom?: number): void {
  const rows = h.app.footerRenderRowsForTest()
  assert.ok(rows.length > 0, 'the footer must render at least one row')
  for (const row of rows.map(strip).map(text => text.trimEnd())) {
    if (row === '') continue
    assert.ok(lines.some(line => line.includes(row)), `a footer row was clipped out of the viewport: ${JSON.stringify(row)}\n${lines.join('\n')}`)
  }
  const trailing = lines.length - 1 - (seatBottom ?? editorBounds(lines).bottom) - rows.length
  assert.ok(trailing >= 0, `the pinned footer is clipped below the viewport (${trailing}):\n${lines.join('\n')}`)
}

/** The painted rows between the editor's bottom border and the footer's first
 * row — the widget zone's PHYSICAL footprint. */
function trailingZoneRows(h: WidgetHarness, lines: readonly string[]): number {
  return lines.length - 1 - editorBounds(lines).bottom - h.app.footerRenderRowsForTest().length
}

/** Count the outlet's refresh invocations through the production callers (the
 * instance method is wrapped; the original is called unbound through `call`). */
function countWidgetRefresh(host: SurfaceHost): () => number {
  const outletInstance = (host as unknown as { widgetsAbove: { refresh(...args: unknown[]): void } }).widgetsAbove
  const original = outletInstance.refresh
  let calls = 0
  outletInstance.refresh = function (this: unknown, ...args: unknown[]): void {
    calls += 1
    original.apply(this, args)
  }
  return () => calls
}

test('physical matrix preserves below widgets, two-row Footer, multiline Editor and transcript on both roots', async () => {
  const taskItems: TaskPanelItem[] = [
    { value: 'job:matrix-a', label: 'Q-MATRIX-A', status: 'running', active: true, source: 'job', type: 'bash', canStop: true },
    { value: 'job:matrix-b', label: 'Q-MATRIX-B', status: 'running', active: true, source: 'job', type: 'bash', canStop: true },
    { value: 'job:matrix-c', label: 'Q-MATRIX-C', status: 'running', active: true, source: 'job', type: 'bash', canStop: true },
  ]
  const customFooter: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [
      { left: [{ id: 'tasks' }], right: [] },
      { left: [{ id: 'model' }], right: [] },
    ],
  }
  const cases = [
    { name: '80x24-full-below-1', cols: 80, rows: 24, footer: 'full', below: ['BELOW-24-FULL'], instruction: false, draft: 'EDITOR FIRST LINE\nEDITOR LAST LINE' },
    { name: '80x24-compact-below-2', cols: 80, rows: 24, footer: 'compact', below: ['BELOW-24-COMPACT-A', 'BELOW-24-COMPACT-B'], draft: 'EDITOR FIRST LINE\nEDITOR LAST LINE' },
    { name: '80x24-custom-below-3', cols: 80, rows: 24, footer: 'custom', below: ['BELOW-24-CUSTOM-A', 'BELOW-24-CUSTOM-B', 'BELOW-24-CUSTOM-C'], expectTwoFooterRows: true, draft: 'EDITOR FIRST LINE\nEDITOR LAST LINE' },
    { name: '44x20-custom-cjk-below-3', cols: 44, rows: 20, footer: 'custom', below: ['下方组件甲', '下方组件乙', '下方组件丙'], expectTwoFooterRows: true, draft: '编辑器第一行\n编辑器末行' },
    { name: '80x10-compact-below-1', cols: 80, rows: 10, footer: 'compact', below: ['BELOW-10-COMPACT'], draft: 'EDITOR FIRST LINE\nEDITOR LAST LINE' },
    { name: '80x8-full-below-3', cols: 80, rows: 8, footer: 'full', below: ['BELOW-8-FULL-A', 'BELOW-8-FULL-B', 'BELOW-8-FULL-C'], draft: 'EDITOR FIRST LINE\nEDITOR LAST LINE' },
  ] as const

  for (const scenario of cases) {
    for (const fullscreen of [false, true]) {
      const h = makeHarness(scenario.cols, scenario.rows)
      try {
        await h.vt.waitForRender()
        registerRows(h.ledger, 'input.widget.below', `matrix-${scenario.name}`, scenario.below)
        h.app.setTaskSummary({ runningAgents: 0, totalAgents: 0, runningJobs: 3, totalJobs: 3, failedAttention: 0, failedTotal: 0 })
        h.app.setQuickTaskItems(taskItems)
        h.app.setStatus({ model: 'matrix-model' })
        if (scenario.footer === 'compact') h.app.setFooterPreset('compact')
        else h.app.setFooterPreset('full')
        if (scenario.footer === 'custom') h.app.setFooterLayout(customFooter)
        h.app.setTranscript([{ kind: 'assistant', turn: 0, text: 'MATRIX-TRANSCRIPT' }])
        h.app.setDraft(scenario.draft)
        await settle()
        await h.vt.waitForRender()
        // The Host instruction is independently verified by the real narrow
        // exit-confirmation VT test; a non-empty draft intentionally preserves
        // Ctrl+D's forward-delete behavior, so this matrix does not synthesize
        // an impossible instruction+draft state.
        if (fullscreen) h.app.setFullscreen(true)
        await h.vt.waitForRender()
        await settle()

        const hidden = painted(h.vt)
        assert.ok(!hidden.some(line => line.includes('Task Quick') || taskItems.some(item => line.includes(item.label))),
          `${scenario.name}/${fullscreen ? 'fullscreen' : 'main'}: Quick is hidden before entry:\n${hidden.join('\n')}`)
        const mainShortException = scenario.rows === 8 && !fullscreen
        if (mainShortException) {
          assert.ok(!hidden.some(line => line.includes('MATRIX-TRANSCRIPT')),
            `${scenario.name}: the existing flowing Main Root may place Transcript above the short viewport`)
        } else {
          assert.ok(hidden.some(line => line.includes('MATRIX-TRANSCRIPT')),
            `${scenario.name}/${fullscreen ? 'fullscreen' : 'main'}: the Transcript keeps a visible row:\n${hidden.join('\n')}`)
        }
        const initialFooter = h.app.footerRenderRowsForTest().map(strip).map(row => row.trimEnd()).filter(Boolean)
        assert.ok(initialFooter.length > 0, `${scenario.name}: the Footer keeps real content`)
        for (const footerRow of initialFooter) {
          assert.ok(hidden.some(line => line.includes(footerRow)),
            `${scenario.name}: the hidden frame keeps every Footer row visible: ${JSON.stringify(footerRow)}\n${hidden.join('\n')}`)
        }
        if ('expectTwoFooterRows' in scenario && scenario.expectTwoFooterRows) {
          assert.equal(initialFooter.length, 2, `${scenario.name}: custom Footer really occupies two physical rows`)
        }
        const hiddenEditor = editorBounds(hidden)
        const hiddenWidgetRows = outlet(h.host, 'below').split('\n').filter(Boolean)
        if (mainShortException) {
          assert.equal(hiddenWidgetRows.length, 2, `${scenario.name}: preserve the historical Main grant of floor(8/4) below-widget rows`)
          assert.ok(initialFooter.some(row => row.includes('tracked jobs')), `${scenario.name}: the Task Badge remains intact`)
          assert.ok(!initialFooter.some(row => row.includes('↓ view')), `${scenario.name}: the no-room admission hint is absent`)
        }
        const hiddenWidgetIndices = scenario.below
          .map(marker => hidden.findIndex(line => line.includes(marker)))
          .filter(index => index >= 0)
        assert.equal(hiddenWidgetIndices.length, hiddenWidgetRows.length,
          `${scenario.name}: the hidden frame paints only the public widget's actual grant`)
        assert.ok(hiddenWidgetIndices.every(index => index > hiddenEditor.bottom),
          `${scenario.name}: every granted below-widget row follows the Editor`)
        const hiddenFooterIndices = initialFooter.map(row => hidden.findIndex(line => line.includes(row)))
        assert.ok(hiddenFooterIndices.every(index => index >= 0), `${scenario.name}: each hidden Footer row is physically visible`)
        if (hiddenWidgetIndices.length > 0) {
          assert.ok(Math.max(...hiddenWidgetIndices) < Math.min(...hiddenFooterIndices),
            `${scenario.name}: the complete public below grant precedes the Footer:\n${hidden.join('\n')}`)
        }
        if (fullscreen) {
          const scroll = h.app.fullscreenScrollForTest()
          assert.ok(scroll !== undefined && scroll.viewportHeight >= 1,
            `${scenario.name}: fullscreen preserves at least one Transcript row`)
        }

        const entered = h.app.enterTaskQuick()
        await h.vt.waitForRender()
        const active = painted(h.vt)
        if (scenario.rows >= 20) assert.equal(entered, true, `${scenario.name}: ordinary and narrow frames admit at least one task row`)
        if (scenario.rows === 10) assert.equal(entered, true, `${scenario.name}: the one-row below widget and compact Footer still leave one task row`)
        if (scenario.rows === 8) assert.equal(entered, false, `${scenario.name}: the full Footer, multiline Editor and below widget take priority over Quick`)
        assert.equal(h.app.taskQuickFocusedForTest(), entered, `${scenario.name}: entry result and physical focus agree`)
        if (!mainShortException) {
          assert.ok(active.some(line => line.includes('MATRIX-TRANSCRIPT')),
            `${scenario.name}: the active frame retains the Transcript row:\n${active.join('\n')}`)
        }
        const footerRows = h.app.footerRenderRowsForTest().map(strip).map(row => row.trimEnd()).filter(Boolean)
        for (const footerRow of footerRows) {
          assert.ok(active.some(line => line.includes(footerRow)),
            `${scenario.name}: Quick may not clip or borrow a Footer row: ${JSON.stringify(footerRow)}\n${active.join('\n')}`)
        }

        if (entered) {
          const editor = editorBounds(active)
          const widgetRows = outlet(h.host, 'below').split('\n').filter(Boolean)
          const widgetIndices = scenario.below
            .map(marker => active.findIndex(line => line.includes(marker)))
            .filter(index => index >= 0)
          assert.equal(widgetIndices.length, widgetRows.length,
            `${scenario.name}: only the public widget's actual grant is painted`)
          assert.deepEqual(widgetIndices, [...widgetIndices].sort((left, right) => left - right),
            `${scenario.name}: below-widget rows retain their order`)
          for (const index of widgetIndices) {
            assert.ok(index > editor.bottom, `${scenario.name}: the below widget remains after the Editor seat`)
          }
          const footerIndices = footerRows.map(row => active.findIndex(line => line.includes(row)))
          assert.ok(footerIndices.every(index => index >= 0), `${scenario.name}: every Footer row has a physical cell`)
          const footerFirst = Math.min(...footerIndices)
          const footerLast = Math.max(...footerIndices)
          if (widgetIndices.length > 0) {
            assert.ok(Math.max(...widgetIndices) < footerFirst,
              `${scenario.name}: every granted below-widget row precedes the Footer:\n${active.join('\n')}`)
          }
          const itemIndices = taskItems.map(item => active.findIndex(line => line.includes(item.label))).filter(index => index >= 0)
          assert.ok(itemIndices.length >= 1, `${scenario.name}: a granted Quick paints a real task row:\n${active.join('\n')}`)
          const identity = active.findIndex(line => line.startsWith('Task Quick'))
          let quickTop = identity >= 0 ? identity : Math.min(...itemIndices)
          if (identity > 0 && /^─+$/.test(active[identity - 1]!.trim())) quickTop = identity - 1
          assert.ok(quickTop > footerLast,
            `${scenario.name}: Footer rows precede the actual Quick band:\n${active.join('\n')}`)
          assert.ok(itemIndices.every(index => index > footerLast),
            `${scenario.name}: task rows are physically below the complete Footer`)
          assert.ok(itemIndices.every(index => index >= quickTop), `${scenario.name}: task rows follow the optional divider/header`)

          h.vt.sendInput('\x1b')
          await h.vt.waitForRender()
          const closed = painted(h.vt)
          assert.ok(!closed.some(line => line.includes('Task Quick') || taskItems.some(item => line.includes(item.label))),
            `${scenario.name}: exit leaves no Quick paint:\n${closed.join('\n')}`)
          const closedFooter = h.app.footerRenderRowsForTest().map(strip).map(row => row.trimEnd()).filter(Boolean)
          const closedFooterLast = Math.max(...closedFooter.map(row => closed.findIndex(line => line.includes(row))))
          assert.ok(!/^─+$/.test(closed[closedFooterLast + 1]?.trim() ?? ''),
            `${scenario.name}: exit leaves no Quick-owned divider below Footer:\n${closed.join('\n')}`)
        } else {
          assert.ok(!active.some(line => line.includes('Task Quick') || taskItems.some(item => line.includes(item.label))),
            `${scenario.name}: a refused entry leaves no Quick identity, item or divider:\n${active.join('\n')}`)
          if (mainShortException) {
            assert.equal(outlet(h.host, 'below').split('\n').filter(Boolean).length, 2,
              `${scenario.name}: a refused Quick entry does not reduce the Main widget grant`)
            const draft = h.app.getDraft()
            h.vt.sendInput('\x1b[B')
            await h.vt.waitForRender()
            assert.equal(h.app.getDraft(), draft, `${scenario.name}: Down remains an Editor no-op when Quick has no grant`)
            assert.equal(h.app.focusSeatForTest(), 'editor', `${scenario.name}: the refused trigger never transfers focus`)
            h.vt.resize(80, 24)
            await h.vt.waitForRender()
            const restored = painted(h.vt)
            assert.ok(restored.some(line => line.includes('MATRIX-TRANSCRIPT')),
              `${scenario.name}: Transcript content returns to the viewport when the flowing document fits`)
            assert.ok(!restored.some(line => line.includes('Task Quick') || taskItems.some(item => line.includes(item.label))),
              `${scenario.name}: increasing the Main viewport does not auto-open Quick`)
          }
        }
      } finally {
        if (!h.app.isDisposed()) h.app.dispose()
      }
    }
  }
})

// ── D-T01: the same contribution paints on both roots ────────────────────

test('D-T01: an above widget paints adjacent to the editor in regular AND fullscreen', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'ABOVE-SENTINEL-1')
  await settle()
  await h.vt.waitForRender()

  const regular = painted(h.vt)
  const regularBounds = editorBounds(regular)
  assert.ok(rowAt(regular, regularBounds.top - 1).includes('ABOVE-SENTINEL-1'),
    `the regular above widget must sit directly above the editor:\n${regular.join('\n')}`)
  assert.equal(rowsWith(regular, 'ABOVE-SENTINEL-1').length, 1, 'exactly one painted copy')

  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const alt = painted(h.vt)
  const altBounds = editorBounds(alt)
  assert.ok(rowAt(alt, altBounds.top - 1).includes('ABOVE-SENTINEL-1'),
    `the fullscreen above widget must sit directly above the editor:\n${alt.join('\n')}`)
  assert.equal(rowsWith(alt, 'ABOVE-SENTINEL-1').length, 1, 'exactly one painted copy')
  assertFooterPainted(h, alt)
})

// ── D-T02: below-only zone ──────────────────────────────────────────────

test('D-T02: a below-only widget paints between the editor and the footer in both modes', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'BELOW-SENTINEL-2')
  await settle()
  await h.vt.waitForRender()

  const regular = painted(h.vt)
  assert.ok(rowAt(regular, editorBounds(regular).bottom + 1).includes('BELOW-SENTINEL-2'),
    `the regular below widget must sit directly below the editor:\n${regular.join('\n')}`)
  assert.equal(outlet(h.host, 'above'), '', 'no above contribution is projected')

  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  const alt = painted(h.vt)
  const bounds = editorBounds(alt)
  assert.ok(rowAt(alt, bounds.bottom + 1).includes('BELOW-SENTINEL-2'),
    `the fullscreen below widget must sit between the editor and the footer:\n${alt.join('\n')}`)
  assert.ok(!rowAt(alt, bounds.top - 1).includes('BELOW-SENTINEL-2'), 'the below widget must not leak above the editor')
  assert.equal(rowsWith(alt, 'BELOW-SENTINEL-2').length, 1, 'exactly one painted copy')
  assert.equal(trailingZoneRows(h, alt), 1, 'only the below widget occupies the trailing zone')
  assertFooterPainted(h, alt)
})

// ── D-T03: both zones, capped at three rows each ─────────────────────────

for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
  test(`D-T03: ${cols}x${rows} fullscreen orders above -> editor -> below -> footer and caps both zones at three rows`, async () => {
    const h = makeHarness(cols, rows)
    registerRows(h.ledger, 'input.widget.above', 'a1', ['ABOVE-1', 'ABOVE-2', 'ABOVE-3', 'ABOVE-4', 'ABOVE-5'])
    registerRows(h.ledger, 'input.widget.below', 'b1', ['BELOW-1', 'BELOW-2', 'BELOW-3', 'BELOW-4', 'BELOW-5'])
    h.app.setFullscreen(true)
    await settle()
    await h.vt.waitForRender()
    const lines = painted(h.vt)
    const bounds = editorBounds(lines)
    for (const n of [1, 2, 3]) {
      assert.ok(rowAt(lines, bounds.top - 3 + (n - 1)).includes(`ABOVE-${n}`), `above row ${n} out of order:\n${lines.join('\n')}`)
      assert.ok(rowAt(lines, bounds.bottom + n).includes(`BELOW-${n}`), `below row ${n} out of order:\n${lines.join('\n')}`)
    }
    assert.equal(rowsWith(lines, 'ABOVE-').length, 3, 'the above zone caps at three rows')
    assert.equal(rowsWith(lines, 'BELOW-').length, 3, 'the below zone caps at three rows')
    const scroll = h.app.fullscreenScrollForTest()
    assert.ok(scroll !== undefined && scroll.viewportHeight >= 1, `the transcript viewport must keep at least one row: ${JSON.stringify(scroll)}`)
    assert.equal(h.app.focusSeatForTest(), 'editor', 'a widget never takes the seat')
    assertFooterPainted(h, lines)
  })
}

// ── D-T04: zero grant under real pressure ───────────────────────────────

test('D-T04: an 80x8 fullscreen retires both widget zones without clipping the editor or the footer', async () => {
  const h = makeHarness(80, 8)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'ABOVE-SENTINEL-4')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'BELOW-SENTINEL-4')
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), 'ABOVE-SENTINEL-4', 'the regular grant is untouched')
  assert.equal(outlet(h.host, 'below'), 'BELOW-SENTINEL-4', 'the regular grant is untouched')

  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), '', 'a zero grant projects no above rows')
  assert.equal(outlet(h.host, 'below'), '', 'a zero grant projects no below rows')
  assert.equal(h.host.hasWidgetsAbove(), false, 'the zone is physically empty')
  assert.equal(h.host.hasWidgetsBelow(), false, 'the zone is physically empty')
  const alt = painted(h.vt)
  assert.equal(rowsWith(alt, 'ABOVE-SENTINEL-4').length + rowsWith(alt, 'BELOW-SENTINEL-4').length, 0,
    `no widget row may be painted without room:\n${alt.join('\n')}`)
  editorBounds(alt)
  assert.equal(trailingZoneRows(h, alt), 0, 'no phantom zone row between the seat and the footer')
  assertFooterPainted(h, alt)

  // The registration itself is untouched: leaving fullscreen restores the
  // ORIGINAL regular grants (above 3, below floor(8/4)=2).
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), 'ABOVE-SENTINEL-4')
  assert.equal(outlet(h.host, 'below'), 'BELOW-SENTINEL-4')
})

// ── D-T05 / D-T06: actual demand, above-first priority ──────────────────

test('D-T05: at 80x10 a below-only widget uses the single spare row (an empty above zone cannot reserve it)', async () => {
  const h = makeHarness(80, 10)
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'BELOW-SPARE-5')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), '', 'no above demand is invented')
  assert.equal(outlet(h.host, 'below'), 'BELOW-SPARE-5', 'the single spare row goes to the only real demand')
  const lines = painted(h.vt)
  assert.ok(rowAt(lines, editorBounds(lines).bottom + 1).includes('BELOW-SPARE-5'), lines.join('\n'))
  assert.equal(trailingZoneRows(h, lines), 1)
  assertFooterPainted(h, lines)
})

test('D-T06: at 80x10 with both zones the above demand takes the single spare row and the below zone yields', async () => {
  const h = makeHarness(80, 10)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'ABOVE-WINS-6')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'BELOW-YIELDS-6')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), 'ABOVE-WINS-6')
  assert.equal(outlet(h.host, 'below'), '', 'the below zone yields the last row')
  const lines = painted(h.vt)
  const bounds = editorBounds(lines)
  assert.ok(rowAt(lines, bounds.top - 1).includes('ABOVE-WINS-6'), lines.join('\n'))
  assert.equal(rowsWith(lines, 'BELOW-YIELDS-6').length, 0)
  assert.equal(trailingZoneRows(h, lines), 0)
  assertFooterPainted(h, lines)
})

// ── D-T07: zero -> nonzero across resizes ───────────────────────────────

test('D-T07: a fullscreen 120x40 -> 80x8 -> 200x60 resize sequence retires and restores widgets without re-registering', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'RESIZE-ABOVE-7')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'RESIZE-BELOW-7')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.ok(rowsWith(painted(h.vt), 'RESIZE-ABOVE-7').length === 1)
  const recordsBefore = h.ledger.snapshot('input.widget.above').records.length

  h.vt.resize(80, 8)
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), '', 'the short viewport retires the zone')
  assert.equal(outlet(h.host, 'below'), '')
  assert.equal(rowsWith(painted(h.vt), 'RESIZE-ABOVE-7').length, 0, 'no stale above row survives the resize')

  h.vt.resize(200, 60)
  await settle()
  await h.vt.waitForRender()
  const grown = painted(h.vt)
  assert.equal(outlet(h.host, 'above'), 'RESIZE-ABOVE-7', 'the live registration reappears')
  assert.equal(outlet(h.host, 'below'), 'RESIZE-BELOW-7', 'the live registration reappears')
  const bounds = editorBounds(grown)
  assert.ok(rowAt(grown, bounds.top - 1).includes('RESIZE-ABOVE-7'), grown.join('\n'))
  assert.ok(rowAt(grown, bounds.bottom + 1).includes('RESIZE-BELOW-7'), grown.join('\n'))
  assert.equal(h.ledger.snapshot('input.widget.above').records.length, recordsBefore, 'no re-registration happened')
})

// ── D-T08: width-only resize with CJK content ───────────────────────────

test('D-T08: a width-only 120 -> 44 resize re-wraps CJK widget content inside the new width', async () => {
  const h = makeHarness(120, 40)
  // 120 cells of CJK: ONE physical row at 120 columns and several at 44, so
  // the outlet row COUNT is the discriminator (a stale 120-column bake would
  // keep one row).
  registerWidget(h.ledger, 'input.widget.above', 'a1', '中文部件宽度测试内容'.repeat(6))
  registerRows(h.ledger, 'input.widget.below', 'b1', ['BELOW-WRAP-ONE', 'BELOW-WRAP-TWO'])
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  const cjkRows = (lines: readonly string[]): number[] => lines
    .map((line, index) => (/[\u4e00-\u9fff]/.test(line) ? index : -1))
    .filter(index => index !== -1)
  const wideRows = outlet(h.host, 'above').split('\n')
  assert.equal(wideRows.length, 1, `the long CJK line must fit one row at 120 columns:\n${wideRows.join('\n')}`)
  assert.equal(cjkRows(painted(h.vt)).length, 1, 'exactly one painted above widget row at 120 columns')

  h.vt.resize(44, 40)
  await settle()
  await h.vt.waitForRender()
  const lines = painted(h.vt)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 44, `a painted row exceeded the new width: ${JSON.stringify(line)}`)
  }
  const narrowRows = outlet(h.host, 'above').split('\n')
  assert.ok(narrowRows.length > wideRows.length,
    `the width change must re-wrap the outlet, saw ${narrowRows.length} rows after ${wideRows.length}:\n${narrowRows.join('\n')}`)
  for (const row of narrowRows) {
    assert.ok(visibleWidth(row) <= 44, `an outlet row exceeded the new width: ${JSON.stringify(row)}`)
  }
  assert.equal(cjkRows(lines).length, narrowRows.length, 'every re-wrapped row is physically painted')
  for (const row of outlet(h.host, 'below').split('\n')) {
    assert.ok(visibleWidth(row) <= 44, `a below outlet row exceeded the new width: ${JSON.stringify(row)}`)
  }
  assert.ok(outlet(h.host, 'above') !== '' && outlet(h.host, 'below') !== '', 'the zones survive the width change')
  editorBounds(lines)
  assertFooterPainted(h, lines)
})

// ── D-T09: repeated mode swaps ──────────────────────────────────────────

test('D-T09: three regular<->fullscreen swaps keep one copy, one host attachment and one registration per zone', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'SWAP-ABOVE-9')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'SWAP-BELOW-9')
  await settle()
  await h.vt.waitForRender()
  for (let round = 0; round < 3; round++) {
    h.app.setFullscreen(true)
    await h.vt.waitForRender()
    const alt = painted(h.vt)
    assert.equal(rowsWith(alt, 'SWAP-ABOVE-9').length, 1, `round ${round}: one above copy\n${alt.join('\n')}`)
    assert.equal(rowsWith(alt, 'SWAP-BELOW-9').length, 1, `round ${round}: one below copy\n${alt.join('\n')}`)
    const bounds = editorBounds(alt)
    assert.ok(rowAt(alt, bounds.top - 1).includes('SWAP-ABOVE-9'))
    assert.ok(rowAt(alt, bounds.bottom + 1).includes('SWAP-BELOW-9'))

    h.app.setFullscreen(false)
    await h.vt.waitForRender()
    const regular = painted(h.vt)
    assert.equal(rowsWith(regular, 'SWAP-ABOVE-9').length, 1, `round ${round}: one regular copy\n${regular.join('\n')}`)
    assert.equal(rowsWith(regular, 'SWAP-BELOW-9').length, 1, `round ${round}: one regular copy\n${regular.join('\n')}`)
  }
  assert.equal(h.attachCount(), 1, 'the screen swap must not re-attach the SurfaceHost')
  assert.equal(h.ledger.snapshot('input.widget.above').records.length, 1, 'no duplicate registration')
  assert.equal(h.ledger.snapshot('input.widget.below').records.length, 1, 'no duplicate registration')
  const outletInstance = h.host as unknown as { widgetsAbove: { compiledIdentitiesForTest(): readonly string[] } }
  assert.equal(outletInstance.widgetsAbove.compiledIdentitiesForTest().length, 1, 'no zombie compiled node')
})

// ── D-T10: replace / dispose / re-register ──────────────────────────────

test('D-T10: replace, dispose and re-register propagate to the fullscreen paint', async () => {
  const h = makeHarness(120, 40)
  const handle = registerWidget(h.ledger, 'input.widget.above', 'a1', 'REPLACE-OLD-10')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(rowsWith(painted(h.vt), 'REPLACE-OLD-10').length, 1)

  handle.replace({ view: { kind: 'text', spans: [{ text: 'REPLACE-NEW-10' }] }, importance: 0 })
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), 'REPLACE-NEW-10')
  assert.equal(rowsWith(painted(h.vt), 'REPLACE-NEW-10').length, 1, 'the replaced body reaches the alt screen')
  assert.equal(rowsWith(painted(h.vt), 'REPLACE-OLD-10').length, 0, 'the old body must not linger')

  handle.dispose()
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), '')
  assert.equal(rowsWith(painted(h.vt), 'REPLACE-NEW-10').length, 0, 'a disposed contribution clears the alt screen')
  assert.equal(trailingZoneRows(h, painted(h.vt)), 0, 'no zombie row after disposal')

  registerWidget(h.ledger, 'input.widget.above', 'a1', 'REPLACE-AGAIN-10')
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), 'REPLACE-AGAIN-10', 'a new registration under the same owner/id recovers')
  assert.equal(rowsWith(painted(h.vt), 'REPLACE-AGAIN-10').length, 1)
})

// ── D-T11: two owners, same local id ────────────────────────────────────

test('D-T11: two owners sharing a local widget id stay independent in fullscreen', async () => {
  const h = makeHarness(120, 40)
  const ownerA = registerWidget(h.ledger, 'input.widget.above', 'status', 'OWNER-A-TEXT-11', { owner: 'owner-a' })
  const ownerB = registerWidget(h.ledger, 'input.widget.above', 'status', 'OWNER-B-TEXT-11', { owner: 'owner-b' })
  assert.ok(ownerA !== undefined && ownerB !== undefined)
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  let lines = painted(h.vt)
  assert.equal(rowsWith(lines, 'OWNER-A-TEXT-11').length, 1, lines.join('\n'))
  assert.equal(rowsWith(lines, 'OWNER-B-TEXT-11').length, 1, lines.join('\n'))

  ownerA.dispose()
  await settle()
  await h.vt.waitForRender()
  lines = painted(h.vt)
  assert.equal(rowsWith(lines, 'OWNER-A-TEXT-11').length, 0, 'the unloaded owner disappears')
  assert.equal(rowsWith(lines, 'OWNER-B-TEXT-11').length, 1, 'the surviving owner keeps painting on the same alt screen')
  const outletInstance = h.host as unknown as { widgetsAbove: { compiledIdentitiesForTest(): readonly string[] } }
  assert.deepEqual(outletInstance.widgetsAbove.compiledIdentitiesForTest(), ['owner-b\u0000status'], 'the removed owner leaves no cache entry')
})

// ── D-T12: empty contributions and zero grants ──────────────────────────

test('D-T12: a zero grant and an empty contribution project nothing, and the live registration survives', () => {
  const { host, ledger } = makeBareHost()
  host.setWidgetRowsAbove(0)
  assert.equal(outlet(host, 'above'), '', 'an empty zone stays empty at a zero grant')
  assert.equal(host.hasWidgetsAbove(), false)

  // An empty view (no spans) is an abdication, not a row.
  const empty = ledger.register('input.widget.above', { id: 'empty' }, { view: { kind: 'text', spans: [] } }, 'owner-empty') as unknown as WidgetHandle
  host.refreshOutlets()
  assert.equal(outlet(host, 'above'), '', 'an empty contribution paints no row')
  assert.equal(host.hasWidgetsAbove(), false)

  const real = registerWidget(ledger, 'input.widget.above', 'real', 'HIDDEN-AT-ZERO-12')
  host.refreshOutlets()
  assert.equal(outlet(host, 'above'), '', 'a real contribution is physically hidden at a zero grant')
  assert.equal(host.hasWidgetsAbove(), false, 'a zero grant is not a visible widget')
  assert.equal(ledger.snapshot('input.widget.above').records.length, 2, 'both registrations are retained')

  host.setWidgetRowsAbove(3)
  assert.equal(outlet(host, 'above'), 'HIDDEN-AT-ZERO-12', 'a positive grant brings the live registration back')
  assert.equal(host.hasWidgetsAbove(), true)

  real.dispose()
  empty.dispose()
  host.refreshOutlets()
  assert.equal(outlet(host, 'above'), '', 'disposal clears the zone again')
  assert.equal(host.hasWidgetsAbove(), false)
  host.dispose()
})

// ── D-T13: input ownership ──────────────────────────────────────────────

test('D-T13: fullscreen typing and submit reach the editor, never the widget', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'PASSIVE-WIDGET-13')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  const before = outlet(h.host, 'above')

  h.vt.sendInput('hello widget')
  await settle()
  await h.vt.waitForRender()
  assert.ok(h.app.seatTextForTest().includes('hello widget'), 'the editor owns the keystrokes')
  assert.equal(outlet(h.host, 'above'), before, 'the widget view never receives raw input')
  assert.equal(h.app.focusSeatForTest(), 'editor')

  h.vt.sendInput('\r')
  await settle()
  await h.vt.waitForRender()
  assert.deepEqual(h.submitted, ['hello widget'], 'the submission reaches the host submit sink')
  assert.equal(rowsWith(painted(h.vt), 'PASSIVE-WIDGET-13').length, 1, 'the widget stays a passive decoration')
})

// ── D-T14: blocking modals keep precedence ──────────────────────────────

test('D-T14: a fullscreen Question then Approval still capture input while widgets stay passive background', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'BACKGROUND-WIDGET-14')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  const before = outlet(h.host, 'above')

  const question = h.app.askQuestions([{ id: 'q1', question: 'PROCEED-Q-14?', options: [{ label: 'yes' }] }])
  await settle()
  await h.vt.waitForRender()
  let lines = painted(h.vt)
  assert.ok(lines.join('\n').includes('PROCEED-Q-14?'), `the question must be visible:\n${lines.join('\n')}`)
  assert.equal(h.app.focusSeatForTest(), 'overlay', 'the question owns the seat')
  assert.equal(rowsWith(lines, 'BACKGROUND-WIDGET-14').length, 1, 'the widget stays painted as background')
  assert.equal(outlet(h.host, 'above'), before, 'the question never feeds the widget')

  h.vt.sendInput('1')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  const answers = await question
  assert.equal(answers[0]?.selected[0], 'yes', 'the question answer settles through the modal')
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.app.focusSeatForTest(), 'editor', 'the seat returns to the editor after the question')
  assert.equal(rowsWith(painted(h.vt), 'BACKGROUND-WIDGET-14').length, 1)

  const decision = h.app.showApprovalPrompt({ toolName: 'bash', reason: 'APPROVAL-R-14?' })
  await settle()
  await h.vt.waitForRender()
  lines = painted(h.vt)
  assert.ok(lines.join('\n').includes('Approve bash?'), `the approval must be visible:\n${lines.join('\n')}`)
  assert.equal(h.app.focusSeatForTest(), 'overlay', 'the approval owns the seat')
  assert.equal(outlet(h.host, 'above'), before, 'the approval never feeds the widget')
  h.vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.app.focusSeatForTest(), 'editor')
  assert.equal(rowsWith(painted(h.vt), 'BACKGROUND-WIDGET-14').length, 1, 'the widget survives both modals')
})

// ── D-T15: footer priority under pressure ───────────────────────────────

const RICH_STATUS: StatusData = {
  model: 'deepseek/flash',
  cwd: '/home/x/proj',
  branch: 'feat/pr-d-widgets',
  turns: 3,
  steps: 7,
  permission: 'workspace-write',
  contextTokens: 1000,
  contextWindow: 10000,
  usage: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 12300, firstTokenMs: 12_300, tokensPerSec: 0 },
    turns: 3,
    steps: 7,
  },
}

for (const [rows, widgetRows] of [[12, 2], [10, 0]] as const) {
  test(`D-T15: at 80x${rows} the multirow footer and its critical hint survive while the widget zones yield to ${widgetRows} rows`, async () => {
    const h = makeHarness(80, rows)
    h.app.setStatus(RICH_STATUS)
    h.app.setTodoSummary([
      { content: 'keep the footer visible', status: 'in_progress' },
      { content: 'drop widgets first', status: 'pending' },
    ])
    h.app.setTasks([{ id: 'a', label: 'agent-one', status: 'running' }])
    h.app.setWorking(true)
    registerWidget(h.ledger, 'input.widget.above', 'a1', 'PRIORITY-ABOVE-15')
    registerWidget(h.ledger, 'input.widget.below', 'b1', 'PRIORITY-BELOW-15')
    h.app.setFullscreen(true)
    await settle()
    h.vt.sendInput('\x04')
    await settle()
    await h.vt.waitForRender()

    const lines = painted(h.vt)
    const footerRows = h.app.footerRenderRowsForTest()
    assert.equal(footerRows.length, 3, 'the rich footer keeps its full three-row demand')
    for (const row of footerRows.map(strip).map(text => text.trimEnd()).filter(text => text !== '')) {
      assert.ok(lines.some(line => line.includes(row)), `a footer row was clipped: ${JSON.stringify(row)}\n${lines.join('\n')}`)
    }
    assert.ok(strip(footerRows[footerRows.length - 1]!).includes('Press Ctrl+D again'),
      `the exit hint must survive as the last footer row:\n${footerRows.map(strip).join('\n')}`)
    const paintedWidgets = rowsWith(lines, 'PRIORITY-ABOVE-15').length + rowsWith(lines, 'PRIORITY-BELOW-15').length
    assert.equal(paintedWidgets, widgetRows, `the widget zones must yield to the footer pressure:\n${lines.join('\n')}`)
    assert.equal(trailingZoneRows(h, lines), rowsWith(lines, 'PRIORITY-BELOW-15').length,
      'the trailing zone holds exactly the granted below rows')
    editorBounds(lines)
  })
}

// ── D-T16: no widget -> no cost, no phantom rows ────────────────────────

test('D-T16: with no widget registered, fullscreen scrolling keeps the zones empty and never re-budgets them', async () => {
  const h = makeHarness(120, 40)
  h.app.setTranscript(Array.from({ length: 40 }, (_, index) => ({
    kind: 'assistant' as const,
    turn: index + 1,
    text: `transcript line ${index + 1} `.repeat(4),
  })))
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  const scrollBefore = h.app.fullscreenScrollForTest()
  assert.ok(scrollBefore !== undefined, 'the fullscreen scroll pane exists')
  assert.ok(scrollBefore.contentHeight > scrollBefore.viewportHeight, 'the transcript must overflow for this test')

  const refreshCalls = countWidgetRefresh(h.host)
  for (let i = 0; i < 3; i++) {
    h.vt.sendInput('\x1b[5~')
    await settle()
    await h.vt.waitForRender()
  }
  const scrollAfter = h.app.fullscreenScrollForTest()
  assert.ok(scrollAfter !== undefined && scrollAfter.scrollTop < scrollBefore.scrollTop, 'PageUp moved the viewport')
  assert.equal(refreshCalls(), 0, 'scroll frames must not re-budget or recompile the widget zones')

  const lines = painted(h.vt)
  assert.equal(outlet(h.host, 'above'), '')
  assert.equal(outlet(h.host, 'below'), '')
  assert.equal(trailingZoneRows(h, lines), 0, 'an unregistered widget zone occupies no row')
  editorBounds(lines)
  assertFooterPainted(h, lines)
})

// ── D-T17: theme change and owner unload ────────────────────────────────

test('D-T17: a theme switch re-bakes the widget palette in both modes and an unload clears it', async () => {
  const h = makeHarness(120, 40)
  const above = registerWidget(h.ledger, 'input.widget.above', 'a1', 'THEME-WIDGET-17')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'THEME-BELOW-17')
  await settle()
  await h.vt.waitForRender()

  const cellColour = (sentinel: string): number | undefined => {
    const lines = painted(h.vt)
    const row = rowsWith(lines, sentinel)[0]
    if (row === undefined) return undefined
    return h.vt.getCellFgRgb(row, lines[row]!.indexOf(sentinel))
  }
  const darkRegular = cellColour('THEME-WIDGET-17')
  assert.equal(darkRegular, 0xE0E0E0, 'the dark palette text colour is painted')

  h.app.applyTheme('light')
  await settle()
  await h.vt.waitForRender()
  assert.equal(cellColour('THEME-WIDGET-17'), 0x1A1A1A, 'the regular widget repaints with the light palette')
  assert.equal(cellColour('THEME-BELOW-17'), 0x1A1A1A, 'the below zone repaints too')

  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(cellColour('THEME-WIDGET-17'), 0x1A1A1A, 'the fullscreen widget paints the light palette')
  h.app.applyTheme('dark')
  await settle()
  await h.vt.waitForRender()
  assert.equal(cellColour('THEME-WIDGET-17'), 0xE0E0E0, 'the fullscreen widget repaints back to dark')

  above.dispose()
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), '', 'the unloaded owner is cleared')
  assert.equal(rowsWith(painted(h.vt), 'THEME-WIDGET-17').length, 0, 'no stale widget text survives the unload')
  assert.equal(rowsWith(painted(h.vt), 'THEME-BELOW-17').length, 1, 'the surviving zone keeps painting')
})

test('D-T17b: the compiled widget tree is reused within one theme revision and recompiled across a theme switch', async () => {
  const h = makeHarness(120, 40)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'TREE-WIDGET-17B')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  const key = 'owner-a1\u0000a1'
  const identities = (): readonly string[] => (h.host as unknown as { widgetsAbove: { compiledIdentitiesForTest(): readonly string[] } })
    .widgetsAbove.compiledIdentitiesForTest()
  assert.deepEqual(identities(), [key])
  const nodeBefore = compiledNodeFor(h, key)
  assert.ok(nodeBefore !== undefined, 'the compiled node is cached')

  // A width change within the SAME theme revision re-measures but keeps the
  // compiled tree (the reference-stability contract the per-frame reuse
  // depends on).
  h.vt.resize(100, 40)
  await settle()
  await h.vt.waitForRender()
  assert.equal(compiledNodeFor(h, key), nodeBefore, 'a width change must not recompile the tree')

  // A theme switch is the tree's validity boundary: the ANSI is palette-baked
  // at compile time, so the node is recompiled exactly once and the
  // owner-scoped key survives.
  h.app.applyTheme('light')
  await settle()
  await h.vt.waitForRender()
  assert.notEqual(compiledNodeFor(h, key), nodeBefore, 'a theme switch must recompile the tree')
  assert.deepEqual(identities(), [key], 'the owner-scoped key survives the recompile')
  const afterTheme = compiledNodeFor(h, key)
  h.host.refreshOutlets()
  assert.equal(compiledNodeFor(h, key), afterTheme, 'a later same-theme refresh reuses the new tree')
})

/** White-box identity probe: the compiled node behind one owner-scoped key.
 * The rendered text alone cannot distinguish "reused tree" from "recompiled
 * tree" with identical content, so the identity is read from the outlet's
 * compile cache — the same white-box technique the KEY-SET assertions of
 * test/extension/extension-layout-budget.test.ts use. */
function compiledNodeFor(h: WidgetHarness, key: string): unknown {
  const cache = (h.host as unknown as { widgetsAbove: { compiledNodes: Map<string, { node: unknown }> } }).widgetsAbove.compiledNodes
  return cache.get(key)?.node
}

// ── D-T18: the real Stable service boundary ─────────────────────────────

interface StableWidgetService {
  register(slot: string, spec: { id: string; order?: number }, value: unknown): WidgetHandle
  _ledger(): unknown
  attachSurface(bridge: { subscribe(listener: (state: unknown) => void): () => void }, capabilities: ReadonlySet<string>, surfaceId: string): void
}

test('D-T18: the real Stable extension service paints a registered widget on the alt screen and removes it there on unload', async () => {
  const ctx = new Context()
  let harness: WidgetHarness | undefined
  try {
    await ctx.plugin(Loader)
    const startupFiber = ctx.plugin((c) => {
      c.provide(TUI_STARTUP_SERVICE, {})
    })
    await startupFiber
    const hostFiber = ctx.plugin(applyExtensionHost)
    await hostFiber
    const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as StableWidgetService
    harness = makeHarness(100, 30, service._ledger() as ExtensionLedger)
    service.attachSurface(
      { subscribe: (listener) => harness!.host.subscribeState(listener as never) },
      harness.host.capabilitiesOf() as ReadonlySet<string>,
      harness.host.surfaceId,
    )
    harness.app.setFullscreen(true)
    await settle()
    await harness.vt.waitForRender()

    // Registered from a real caller fiber: the fiber owns the contribution.
    const ownerFiber = ctx.plugin((c) => {
      const scoped = c.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as StableWidgetService
      scoped.register('input.widget.above', { id: 'service-widget', order: 0 }, {
        view: { kind: 'text', spans: [{ text: 'SERVICE-WIDGET-18' }] },
      })
    })
    await ownerFiber
    await settle()
    await harness.vt.waitForRender()
    const withWidget = painted(harness.vt)
    assert.equal(rowsWith(withWidget, 'SERVICE-WIDGET-18').length, 1,
      `the public registration must paint on the alt screen:\n${withWidget.join('\n')}`)
    assert.ok(rowAt(withWidget, editorBounds(withWidget).top - 1).includes('SERVICE-WIDGET-18'))

    await ownerFiber.dispose()
    await settle()
    await harness.vt.waitForRender()
    const unloaded = painted(harness.vt)
    assert.equal(rowsWith(unloaded, 'SERVICE-WIDGET-18').length, 0,
      `unloading the owner fiber must clear the same alt screen:\n${unloaded.join('\n')}`)
    assert.equal(trailingZoneRows(harness, unloaded), 0)
    editorBounds(unloaded)
  } finally {
    if (harness !== undefined) {
      startedApps.delete(harness.app)
      if (!harness.app.isDisposed()) harness.app.dispose()
    }
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
})

// ── D-T20: LIVE protected-chrome height changes (review F1) ─────────────

test('D-T20: a live multi-line draft re-derives the fullscreen grant instead of clipping the footer', async () => {
  const h = makeHarness(80, 12)
  registerRows(h.ledger, 'input.widget.above', 'a1', ['GRANT-ROW-1', 'GRANT-ROW-2', 'GRANT-ROW-3'])
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'GRANT-BELOW-20')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above').split('\n').length, 3, 'the roomy grant starts at three above rows')
  assertFooterPainted(h, painted(h.vt))

  // A real bracketed paste grows the editor WITHOUT any terminal resize: the
  // grant derived from the three-row editor is now stale.
  h.vt.sendInput('\x1b[200~one\ntwo\nthree\nfour\nfive\x1b[201~')
  await settle()
  await h.vt.waitForRender()
  assert.ok(h.app.seatTextForTest().includes('five'), 'the paste reached the editor')
  assert.equal(outlet(h.host, 'above'), '', 'the above zone yields to the grown editor')
  assert.equal(outlet(h.host, 'below'), '', 'the below zone yields too')
  const lines = painted(h.vt)
  assert.equal(rowsWith(lines, 'GRANT-ROW-1').length, 0, 'no stale widget row survives')
  const scroll = h.app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined && scroll.viewportHeight >= 1, `the transcript keeps its minimum row: ${JSON.stringify(scroll)}`)
  assertFooterPainted(h, lines)
  assert.equal(h.app.focusSeatForTest(), 'editor')

  // Shrinking the chrome back restores the zones with NO unrelated invalidation.
  h.app.setEditorText('')
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above').split('\n').length, 3, 'the grant returns when the chrome shrinks')
  assert.equal(rowsWith(painted(h.vt), 'GRANT-ROW-3').length, 1, 'the restored grant is physically painted')
  assertFooterPainted(h, painted(h.vt))
})

test('D-T20b: a Todo panel expansion in fullscreen re-derives the widget grant', async () => {
  const h = makeHarness(80, 14)
  h.app.setTodoSummary([
    { content: 'first todo', status: 'in_progress' },
    { content: 'second todo', status: 'pending' },
  ])
  registerRows(h.ledger, 'input.widget.above', 'a1', ['PANEL-ROW-1', 'PANEL-ROW-2', 'PANEL-ROW-3'])
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above').split('\n').length, 3, 'the roomy grant starts at three rows')

  // Opening the panel adds three pinned chrome rows without a resize.
  assert.equal(h.app.toggleTodoPanel(), true, 'the panel is visible')
  await settle()
  await h.vt.waitForRender()
  const openRows = outlet(h.host, 'above').split('\n').filter(row => row !== '')
  assert.ok(openRows.length < 3, `the widget zone must yield to the panel, saw ${openRows.length} rows`)
  assert.equal(rowsWith(painted(h.vt), 'PANEL-ROW-1').length, 1, 'the first granted row is painted')
  assertFooterPainted(h, painted(h.vt))

  // Closing it restores the roomier grant.
  assert.equal(h.app.toggleTodoPanel(), false, 'the panel is hidden again')
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above').split('\n').length, 3, 'the grant returns when the panel closes')
  assertFooterPainted(h, painted(h.vt))
})

// ── D-T21: pointer geometry includes the widget footprint (review F2) ────

test('D-T21: a fullscreen Question option click resolves against the widget footprint', async () => {
  const h = makeHarness(80, 30)
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'POINTER-BELOW-21')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  const question = h.app.askQuestions([{ id: 'q', question: 'PICK-ONE-21?', options: [{ label: 'OPTION-A' }, { label: 'OPTION-B' }] }])
  await settle()
  await h.vt.waitForRender()
  const lines = painted(h.vt)
  assert.equal(rowsWith(lines, 'POINTER-BELOW-21').length, 1, `the below widget must be painted:\n${lines.join('\n')}`)
  const optionRow = rowsWith(lines, 'OPTION-B')[0]
  assert.ok(optionRow !== undefined && optionRow > 0, `the second option must be painted:\n${lines.join('\n')}`)

  click(h.vt, 10, optionRow + 1)
  await settle()
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  const answers = await question
  assert.equal(answers[0]?.selected[0], 'OPTION-B', 'the click selects the option the user pointed at')
})

test('D-T21b: a widget row is not a fullscreen Todo pointer target', async () => {
  const h = makeHarness(80, 24)
  h.app.setTodoSummary([
    { content: 'first todo', status: 'in_progress' },
    { content: 'second todo', status: 'pending' },
  ])
  assert.equal(h.app.toggleTodoPanel(), true, 'the todo panel is visible')
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'POINTER-ABOVE-21B')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'POINTER-BELOW-21B')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  let lines = painted(h.vt)
  assert.equal(h.app.isTodoPanelVisible(), true)
  const widgetRow = rowsWith(lines, 'POINTER-ABOVE-21B')[0]
  assert.ok(widgetRow !== undefined, `the above widget must be painted:\n${lines.join('\n')}`)

  // Negative: the widget row is passive — it must never resolve to the Todo
  // target whose (unadjusted) region used to cover it.
  click(h.vt, 10, widgetRow + 1)
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.app.isTodoPanelVisible(), true, `clicking a widget row must not toggle the Todo panel:\n${painted(h.vt).join('\n')}`)

  // Positive control: a real Todo panel row still resolves.
  lines = painted(h.vt)
  const todoRows = rowsWith(lines, 'Todo')
  assert.equal(todoRows.length, 1, `the todo panel title must be painted once:\n${lines.join('\n')}`)
  click(h.vt, 10, todoRows[0]! + 1)
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.app.isTodoPanelVisible(), false, 'a real Todo panel row still toggles the panel')
})

// ── D-T22..D-T24: modal seat replacement (external review P2) ────────────
//
// The three cases drive every direction through an ABORT (or the raw
// presentation call) instead of a key press: a key press re-enters
// `handleQuestionKey`, which ends in `TuiApp.requestRender()` and would mask a
// bypassed budget sync, so a key-driven test cannot prove the fix.

test('D-T22: a Question frame replacing the seat under a capturing overlay re-derives the grant', async () => {
  const h = makeHarness(80, 14)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'MODAL-ABOVE-22')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'MODAL-BELOW-22')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(rowsWith(painted(h.vt), 'MODAL-BELOW-22').length, 1, 'the roomy grant paints the below zone')

  // A capturing overlay owns the seat FIRST, so the Question's own
  // setFocusSeat('overlay') is a no-op: the presentation path itself is the
  // only budget trigger (external review P2 — a raw screen render left it
  // stale and clipped the footer).
  h.app.openPicker([{ value: 'p', label: 'PICK-22' }], () => {}, () => {})
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.app.focusSeatForTest(), 'overlay')

  const controller = new AbortController()
  const question = h.app.askQuestions(
    [{ id: 'q', question: 'TALL-22?', options: Array.from({ length: 6 }, (_, index) => ({ label: `OPT-${index + 1}` })) }],
    controller.signal,
  )
  const questionSettled = question.then(value => value, error => String(error))
  await settle()
  await h.vt.waitForRender()
  const lines = painted(h.vt)
  assert.equal(outlet(h.host, 'above'), '', 'the taller seat retires the above zone')
  assert.equal(outlet(h.host, 'below'), '', 'the taller seat retires the below zone')
  assert.equal(rowsWith(lines, 'MODAL-ABOVE-22').length + rowsWith(lines, 'MODAL-BELOW-22').length, 0,
    `no stale widget row may survive the seat replacement:\n${lines.join('\n')}`)
  const scroll = h.app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined && scroll.viewportHeight >= 1, `the transcript keeps its minimum row: ${JSON.stringify(scroll)}`)
  assertFooterPainted(h, lines, modalSeatBottom(lines))
  assert.equal(h.app.focusSeatForTest(), 'overlay')

  // The abort-driven restore (NOT a key press) must re-derive the roomier
  // grant for the restored editor seat.
  controller.abort()
  await questionSettled
  await settle()
  await h.vt.waitForRender()
  assert.equal(rowsWith(painted(h.vt), 'MODAL-BELOW-22').length, 1, 'the abort-driven restore re-derives the roomier grant')
})

test('D-T23: a queued Question handover re-derives the grant for the new frame height', async () => {
  const h = makeHarness(80, 20)
  registerRows(h.ledger, 'input.widget.above', 'a1', ['ABOVE-23-1', 'ABOVE-23-2', 'ABOVE-23-3'])
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'BELOW-23')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above').split('\n').length, 3, 'the editor seat leaves room for three above rows')
  assert.equal(outlet(h.host, 'below'), 'BELOW-23')

  const controller = new AbortController()
  const first = h.app.askQuestions([{ id: 'q1', question: 'SHORT-23?', options: [{ label: 'ONLY' }] }], controller.signal)
  const firstSettled = first.then(value => value, error => String(error))
  const second = h.app.askQuestions([{ id: 'q2', question: 'TALL-23?', options: Array.from({ length: 8 }, (_, index) => ({ label: `OPT-${index + 1}` })) }])
  const secondSettled = second.then(value => value, error => String(error))
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'below'), 'BELOW-23', 'the short frame still leaves room for the zones')

  // Abort the first flow: the seat hands straight over to the queued frame
  // (FOUR rows taller here) with NO key press in between, so the handover
  // itself must re-derive the budget, and the seat stays 'overlay' throughout.
  controller.abort()
  await firstSettled
  await settle()
  await h.vt.waitForRender()
  const lines = painted(h.vt)
  assert.ok(lines.join('\n').includes('TALL-23?'), `the queued question must own the seat:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('❯')), 'the editor must NOT be restored between two queued questions')
  assert.equal(h.app.focusSeatForTest(), 'overlay')
  // 80x20: protected chrome = header 1 + the 12-row frame; the grant room is
  // 20 - 13 - FOOTER_MAX(4) - 1 transcript row = 2 rows.
  assert.equal(outlet(h.host, 'above').split('\n').length, 2, 'the grant follows the taller frame')
  assert.equal(outlet(h.host, 'below'), '', 'the below zone yields to the taller frame')
  assert.equal(rowsWith(lines, 'ABOVE-23-3').length, 0, 'the withdrawn third above row must not linger')
  const scroll = h.app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined && scroll.viewportHeight >= 1, `the transcript keeps its minimum row: ${JSON.stringify(scroll)}`)
  assertFooterPainted(h, lines, modalSeatBottom(lines))

  h.vt.sendInput('\x1b')
  await secondSettled
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above').split('\n').length, 3, 'the editor restore brings the full grant back')
  assert.equal(outlet(h.host, 'below'), 'BELOW-23')
})

test('D-T24: a Save Location prompt re-derives the grant on enter and on restore', async () => {
  const h = makeHarness(80, 14)
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'SAVE-ABOVE-24')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'SAVE-BELOW-24')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()
  assert.equal(rowsWith(painted(h.vt), 'SAVE-BELOW-24').length, 1, 'the roomy grant paints the below zone')

  h.app.openPicker([{ value: 'p', label: 'PICK-24' }], () => {}, () => {})
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.app.focusSeatForTest(), 'overlay')

  const controller = new AbortController()
  const prompt = h.app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-24.zip', initialDirectory: './' },
    {
      resolveDirectory: (input: string) => `/tmp/${input}`,
      isDirectory: () => true,
      targetExists: () => false,
      complete: async () => null,
    },
    controller.signal,
  )
  const promptSettled = prompt.then(value => value, error => String(error))
  await settle()
  await h.vt.waitForRender()
  const lines = painted(h.vt)
  assert.equal(outlet(h.host, 'above'), '', 'the prompt frame retires the above zone')
  assert.equal(outlet(h.host, 'below'), '', 'the prompt frame retires the below zone')
  assert.equal(rowsWith(lines, 'SAVE-BELOW-24').length, 0, `no stale widget row survives the prompt:\n${lines.join('\n')}`)
  const scroll = h.app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined && scroll.viewportHeight >= 1, `the transcript keeps its minimum row: ${JSON.stringify(scroll)}`)
  assertFooterPainted(h, lines, modalSeatBottom(lines))

  // The abort-driven restore (NOT a key press) must re-derive the roomier
  // grant for the restored editor seat.
  controller.abort()
  assert.deepEqual(await promptSettled, { kind: 'cancelled' })
  await settle()
  await h.vt.waitForRender()
  assert.equal(rowsWith(painted(h.vt), 'SAVE-BELOW-24').length, 1, 'the abort-driven restore re-derives the roomier grant')
})

test('D-T25: a right-click paste that shrinks the Save Location frame re-derives the grant before its completion resolves', async () => {
  // The Save Location prompt's suggestion list is cleared SYNCHRONOUSLY on
  // input while the replacement scan is still pending
  // (src/tui/interaction/save-location.ts refreshSuggestions), so the frame
  // shrinks with no host render request until the async completion lands. The
  // synthetic right-click paste must therefore re-derive the budget itself.
  const suggestions = Array.from({ length: 5 }, (_, index) => ({ value: `dir-${index + 1}/`, displayPath: `dir-${index + 1}` }))
  let releaseCompletion: (() => void) | undefined
  const deps = {
    resolveDirectory: (input: string) => `/tmp/${input}`,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async (raw: string) => {
      if (raw === './') return suggestions
      // HELD: the pasted path's scan never resolves until the test releases it.
      return await new Promise<typeof suggestions | null>((resolve) => { releaseCompletion = () => resolve(null) })
    },
  }
  const h = makeHarness(80, 20, new ExtensionLedger(() => {}), {
    app: { readClipboardText: async () => 'newdir/' },
    events: { runOwned: owned },
  })
  registerWidget(h.ledger, 'input.widget.above', 'a1', 'PASTE-ABOVE-25')
  registerWidget(h.ledger, 'input.widget.below', 'b1', 'PASTE-BELOW-25')
  h.app.setFullscreen(true)
  await settle()
  await h.vt.waitForRender()

  const prompt = h.app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-25.zip', initialDirectory: './' },
    deps,
  )
  const promptSettled = prompt.then(value => value, error => String(error))
  await settle()
  await h.vt.waitForRender()
  assert.equal(outlet(h.host, 'above'), '', 'the tall five-suggestion frame retires the above zone')
  assert.equal(outlet(h.host, 'below'), '', 'the tall five-suggestion frame retires the below zone')
  const tallFrame = modalSeatBottom(painted(h.vt))

  // The REAL right-click clipboard trigger (win32-gated in the fork), landing
  // inside the prompt frame.
  await withRightClickPaste(async () => {
    rightClick(h.vt, 12, tallFrame - 2)
    await settle()
    await h.vt.waitForRender()
  })
  assert.ok(releaseCompletion !== undefined, 'the right-click paste must start the held directory completion')
  const shrunk = painted(h.vt)
  const shrunkBottom = modalSeatBottom(shrunk)
  assert.ok(shrunkBottom < tallFrame, `the suggestion-less frame must be shorter (${shrunkBottom} < ${tallFrame}):\n${shrunk.join('\n')}`)
  // The discriminating assertion: the grant follows the SHORTER frame while the
  // completion is still held.
  assert.equal(rowsWith(shrunk, 'PASTE-ABOVE-25').length, 1, `the shorter frame restores the above zone:\n${shrunk.join('\n')}`)
  assert.equal(rowsWith(shrunk, 'PASTE-BELOW-25').length, 1, `the shorter frame restores the below zone:\n${shrunk.join('\n')}`)
  assertFooterPainted(h, shrunk, shrunkBottom)

  releaseCompletion()
  await settle()
  await h.vt.waitForRender()
  const released = painted(h.vt)
  assert.equal(rowsWith(released, 'PASTE-BELOW-25').length, 1, 'releasing the completion keeps the grant stable')
  assertFooterPainted(h, released, modalSeatBottom(released))

  h.vt.sendInput('\x1b')
  await promptSettled
})
