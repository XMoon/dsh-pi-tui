/**
 * Header single-line contract (external review P2, PR #254): the global
 * header is ALWAYS exactly one physical line, on every surface and display
 * preset. The app mark, plan badge and extension header badges keep their
 * semantics; the SESSION TITLE is the flexible element and is ANSI/CJK/emoji-
 * safe truncated (or dropped) so the composed row never wraps.
 * @module @xmoon76/dsh-pi-tui/header-single-line.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, Text, visibleWidth } from '@xmoon76/pi-tui'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { TuiApp } from '../src/tui-app.ts'
import { enterChildDisplaySubject } from './support/display-subject.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(columns = 100, rows = 24, host?: SurfaceHost): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} },
    host === undefined ? {} : { extensionHost: host })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function plain(row: string): string {
  return stripTerminalSequences(row).trimEnd()
}

/** A real extension host with one header badge contribution, wired into the app. */
function startAppWithHeaderBadge(): {
  vt: VirtualTerminal
  app: TuiApp
  host: SurfaceHost
  ledger: ExtensionLedger
} {
  const ledger = new ExtensionLedger(() => {})
  let app!: TuiApp
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const started = startApp(40, 24, host)
  app = started.app
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
  ledger.register('chrome.header.badge', { id: 'badge' }, { text: 'B' }, 'p1')
  host.refreshOutlets()
  return { vt: started.vt, app, host, ledger }
}

test('the header stays one physical line at 20/40/80/120 columns for a 200-char title', async () => {
  for (const columns of [20, 40, 80, 120]) {
    const { vt, app } = startApp(columns, 24)
    app.setSessionTitle('L'.repeat(200))
    app.setPlanMode(true)
    await vt.waitForRender()
    const rows = app.headerRenderRowsForTest()
    assert.equal(rows.length, 1, `columns ${columns}: the header must be exactly one row:\n${rows.join('\n')}`)
    assert.ok(visibleWidth(rows[0]!) <= columns,
      `columns ${columns}: the header must fit (got ${visibleWidth(rows[0]!)}):\n${rows[0]}`)
    // The app mark survives; the title is the element that yields.
    assert.ok(plain(rows[0]!).includes('dsh-pi-tui'), `columns ${columns}: the app mark must survive:\n${rows[0]}`)
    app.dispose()
  }
})

test('the header budget accounts for plan + extension badges, not only the title', async () => {
  const { vt, app, host } = startAppWithHeaderBadge()
  app.setSessionTitle('L'.repeat(200))
  app.setPlanMode(true)
  app.refreshChrome()
  host.refreshOutlets()
  await vt.waitForRender()
  let rows = app.headerRenderRowsForTest()
  assert.equal(rows.length, 1, `a long title + plan + extension badge must stay one row:\n${rows.join('\n')}`)
  assert.ok(visibleWidth(rows[0]!) <= 40, `the row must fit 40 (got ${visibleWidth(rows[0]!)}):\n${rows[0]}`)
  assert.ok(plain(rows[0]!).includes('[plan]'), `the plan badge must survive:\n${rows[0]}`)
  // A short title leaves room for both the title and the badge run.
  app.setSessionTitle('short')
  app.refreshChrome()
  host.refreshOutlets()
  await vt.waitForRender()
  rows = app.headerRenderRowsForTest()
  assert.equal(rows.length, 1, `a short title stays one row:\n${rows.join('\n')}`)
  assert.ok(plain(rows[0]!).includes('short'), `the short title must render:\n${rows[0]}`)
  assert.ok(plain(rows[0]!).includes('[B]'), `the extension badge must render when room allows:\n${rows[0]}`)
  app.dispose()
})

test('a CJK / emoji / ANSI title is truncated cell-safely to one row', async () => {
  const titles = [
    '研究子会话标题'.repeat(20),
    '🐋'.repeat(60),
    '\u001b[31mred title\u001b[0m'.repeat(20),
    'e\u0301 combining title '.repeat(20),
  ]
  for (const title of titles) {
    for (const columns of [20, 40, 80]) {
      const { vt, app } = startApp(columns, 24)
      app.setSessionTitle(title)
      await vt.waitForRender()
      const rows = app.headerRenderRowsForTest()
      assert.equal(rows.length, 1, `columns ${columns}: one row expected for ${JSON.stringify(title.slice(0, 12))}:\n${rows.join('\n')}`)
      assert.ok(visibleWidth(rows[0]!) <= columns,
        `columns ${columns}: fits (got ${visibleWidth(rows[0]!)}):\n${rows[0]}`)
      app.dispose()
    }
  }
})

test('20x10 fullscreen with a 200-char title keeps the editor on main AND in the child viewer', async () => {
  // MAIN.
  const main = startApp(20, 10)
  main.app.setSessionTitle('L'.repeat(200))
  main.app.setStatus({ model: 'p/m', cwd: '/w', turns: 1, steps: 1 })
  main.app.setFullscreen(true)
  await main.vt.waitForRender()
  let lines = main.vt.getViewport()
  let editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1 && lines.slice(editorTop + 1).some(line => line.includes('─'.repeat(10))),
    `the MAIN editor frame must survive a 200-char title:\n${lines.map(plain).join('\n')}`)
  assert.ok(lines.map(plain)[0]!.startsWith('🐋'), 'the header owns row 0')
  main.app.setFullscreen(false)
  main.app.dispose()

  // CHILD viewer: the bar must sit directly under the one-line header and the
  // editor frame must survive.
  const child = startApp(20, 10)
  child.app.setSessionTitle('L'.repeat(200))
  child.app.setStatus({ model: 'p/m', cwd: '/w', turns: 1, steps: 1 })
  enterChildDisplaySubject(child.app, {
    id: 'child-1', label: 'research', mode: 'continuable', activity: 'running',
    cwd: '/child', turns: 1, steps: 1,
  })
  child.app.setFullscreen(true)
  await child.vt.waitForRender()
  lines = child.vt.getViewport()
  const view = lines.map(plain)
  assert.equal(view.findIndex(line => line.includes('‹')), 1,
    `the subject bar must be the row under the one-line header:\n${view.join('\n')}`)
  editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1 && lines.slice(editorTop + 1).some(line => line.includes('─'.repeat(10))),
    `the CHILD editor frame must survive:\n${view.join('\n')}`)
  child.app.setFullscreen(false)
  child.app.dispose()
})

test('regular, fullscreen and every display preset share the one-line header rule', async () => {
  for (const preset of ['full', 'compact', 'focus'] as const) {
    const vt = new VirtualTerminal(40, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
    app.start()
    startedApps.add(app)
    app.setSessionTitle('L'.repeat(200))
    await vt.waitForRender()
    assert.equal(app.headerRenderRowsForTest().length, 1, `${preset}: regular one row`)
    app.setFullscreen(true)
    await vt.waitForRender()
    assert.equal(app.headerRenderRowsForTest().length, 1, `${preset}: fullscreen one row`)
    app.setFullscreen(false)
    app.dispose()
  }
})
