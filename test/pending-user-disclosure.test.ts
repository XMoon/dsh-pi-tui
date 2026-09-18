/**
 * Pending steering long-user disclosure: an ephemeral text-only steering /
 * sending row joins the SAME visual-row compaction as a durable text-only user
 * message — head + compact marker + tail while collapsed, a tail collapse
 * control while expanded, and the status line always visible. The identity is
 * the stable `rpc:<id>` / `id:<id>` key, so a local echo and its authoritative
 * replacement share the explicit disclosure state, while a stale press can
 * never transfer to a replacement row. None of this state is durable: it is
 * presentation-only and pruned to the live pending keys.
 * @module @xmoon76/dsh-pi-tui/pending-user-disclosure.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import type { PendingUserRow } from '../src/tui-app.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(width = 100, height = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewRows(vt: VirtualTerminal): Promise<string[]> {
  await vt.waitForRender()
  return vt.getViewport().map(line => stripTerminalSequences(line).replace(/[│┃█]$/, '').trimEnd())
}

function clickCell(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, index) => `${prefix}${index + 1}`).join('\n')
}

function steering(target: TuiApp, rows: readonly PendingUserRow[]): void {
  target.setPendingInputPresentation({ queued: [], steering: rows, running: true })
}

function longRow(id: string, prefix: string, rpcId?: string): PendingUserRow {
  return {
    id,
    ...(rpcId === undefined ? {} : { rpcId }),
    text: lines(24, prefix),
    status: 'steering',
    foldableText: true,
  }
}

function compactMarkerCount(rows: readonly string[]): number {
  return rows.filter(row => row.includes('rows compacted')).length
}

function collapseFooterRows(rows: readonly string[]): number[] {
  return rows.flatMap((row, index) => row.includes('▴ Collapse') ? [index] : [])
}

test('pending: a long text-only steering row folds by visual rows (regular)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  const rows = await viewRows(vt)
  const view = rows.join('\n')
  assert.equal(compactMarkerCount(rows), 1, `the pending row must fold:\n${view}`)
  assert.ok(view.includes('p-1') && view.includes('p-4'), 'head rows visible')
  assert.ok(view.includes('p-22') && view.includes('p-24'), 'tail rows visible')
  assert.ok(!view.includes('p-12'), 'the middle is hidden')
  assert.ok(view.includes('17 rows compacted'))
  assert.ok(view.includes('steering…'), 'the status line always stays visible')
  assert.ok(view.includes('ctrl+o to expand'), 'regular names the effective key')
  app.stop()
})

test('pending: a short steering row renders in full (no marker/footer)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  steering(app, [{ id: 'p1', rpcId: 'r1', text: lines(8, 's-'), status: 'steering', foldableText: true }])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0)
  assert.equal(collapseFooterRows(rows).length, 0)
  assert.ok(rows.some(row => row.includes('s-8')))
  assert.ok(rows.some(row => row.includes('steering…')))
  app.stop()
})

test('pending: a non-text-only row fails open to the full presentation', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  steering(app, [{ id: 'p1', rpcId: 'r1', text: lines(24, 'm-'), status: 'steering', foldableText: false }])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'mixed content is never folded')
  assert.ok(rows.some(row => row.includes('m-12')), 'the whole row is visible')
  app.stop()
})

test('pending: an UNKNOWN foldability fact fails open to full', async () => {
  const { vt, app } = startApp()
  app.setTranscript([])
  steering(app, [{ id: 'p1', rpcId: 'r1', text: lines(24, 'u-'), status: 'steering' }])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'absent foldableText must not be guessed as text-only')
  assert.ok(rows.some(row => row.includes('u-12')))
  app.stop()
})

test('pending: fullscreen marker expands, keeps the status line, and the tail collapses', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('p-12')), 'the marker click expands the pending row')
  assert.ok(rows.some(row => row.includes('steering…')), 'the status line survives expansion')
  const footerY = collapseFooterRows(rows)
  assert.equal(footerY.length, 1, `tail control missing:\n${rows.join('\n')}`)

  clickCell(vt, 60, footerY[0]!)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the tail click restores compact')
  assert.ok(!rows.some(row => row.includes('p-12')))
  assert.ok(rows.some(row => row.includes('steering…')))
  app.setFullscreen(false)
  app.stop()
})

test('pending: fullscreen Focus defaults compact and advertises click only', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  app.setFocusMode(true)
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'pending defaults compact in fullscreen Focus')
  assert.ok(rows.some(row => row.includes('click to expand')))
  assert.ok(!rows.join('\n').includes('ctrl+o to expand'), 'no dead Ctrl+O promise')

  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  const footer = rows[collapseFooterRows(rows)[0]!] ?? ''
  assert.ok(footer.includes('click'), 'the tail offers the click')
  assert.ok(!footer.includes('ctrl+o'), 'the tail never promises Ctrl+O inside fullscreen Focus')
  app.setFullscreen(false)
  app.setFocusMode(false)
  app.stop()
})

test('pending: a disabled toggleExpand key keeps the fullscreen mouse round-trip', async () => {
  const { vt, app } = startApp(100, 40)
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('p-12')))
  const footerY = collapseFooterRows(rows)
  assert.equal(footerY.length, 1)
  assert.ok(!rows[footerY[0]!]!.includes('ctrl+o'), 'never a dead key hint')
  clickCell(vt, 60, footerY[0]!)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'mouse alone returns to compact')
  app.setFullscreen(false)
  app.stop()
})

test('pending: a disabled toggleExpand key renders the regular row in full', async () => {
  const { vt, app } = startApp()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': false }))
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  const rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 0, 'no fold without an affordance')
  assert.equal(collapseFooterRows(rows).length, 0, 'no dead footer either')
  assert.ok(rows.some(row => row.includes('p-12')))
  app.stop()
})

test('pending: local echo → authoritative occurrence keeps the explicit expansion (rpcId continuity)', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [{ id: 'local-1', rpcId: 'r1', local: true, text: lines(24, 'p-'), status: 'steering', foldableText: true }])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('p-12')), 'the local echo expands')

  // The authoritative occurrence replaces the echo: same rpc correlation,
  // different occurrence id — the disclosure state must survive.
  steering(app, [{ id: 'occ-9', rpcId: 'r1', text: lines(24, 'p-'), status: 'steering', foldableText: true }])
  rows = await viewRows(vt)
  assert.ok(rows.some(row => row.includes('p-12')), 'the authoritative replacement stays expanded')
  assert.equal(compactMarkerCount(rows), 0)
  app.setFullscreen(false)
  app.stop()
})

test('pending: disclosure state is pruned when the row disappears', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  assert.ok((await viewRows(vt)).some(row => row.includes('p-12')))

  // The lane empties (the durable message materialized), then the SAME key
  // reappears: a stale override must not resurface.
  steering(app, [])
  await viewRows(vt)
  steering(app, [longRow('p1', 'p-', 'r1')])
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the pruned state re-derives compact')
  assert.ok(!rows.some(row => row.includes('p-12')))
  app.setFullscreen(false)
  app.stop()
})

test('pending: a stale marker press never transfers to a replacement row', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [longRow('a', 'A-', 'ra'), longRow('b', 'B-', 'rb')])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 2)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  assert.ok(rows[markerY - 1]!.includes('A-4'), 'the first marker belongs to row A')

  // Press A's marker but do NOT release: row A disappears and B takes its
  // place before the release.
  vt.sendInput(`\x1b[<0;10;${markerY + 1}M`)
  steering(app, [longRow('b', 'B-', 'rb')])
  rows = await viewRows(vt)
  vt.sendInput(`\x1b[<0;10;${markerY + 1}m`)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'row B must stay compact')
  assert.ok(!rows.some(row => row.includes('B-12')), 'the stale press must not expand the replacement row')
  app.setFullscreen(false)
  app.stop()
})

test('pending: a press followed by a resize never acts on the stale frame', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  vt.sendInput(`\x1b[<0;10;${markerY + 1}M`)
  vt.resize(80, 40)
  await viewRows(vt)
  vt.sendInput(`\x1b[<0;10;${markerY + 1}m`)
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'the stale-geometry release must be dropped')
  assert.ok(!rows.some(row => row.includes('p-12')))
  app.setFullscreen(false)
  app.stop()
})

test('pending: Ctrl+O collapses an explicitly expanded pending row (regular)', async () => {
  const { vt, app } = startApp(100, 40)
  app.setTranscript([])
  steering(app, [longRow('p1', 'p-', 'r1')])
  app.setFullscreen(true)
  let rows = await viewRows(vt)
  const markerY = rows.findIndex(row => row.includes('rows compacted'))
  clickCell(vt, 10, markerY)
  assert.ok((await viewRows(vt)).some(row => row.includes('p-12')))

  vt.sendInput('\x0f')
  rows = await viewRows(vt)
  assert.equal(compactMarkerCount(rows), 1, 'Ctrl+O collapses the explicitly expanded pending row')
  assert.ok(!rows.some(row => row.includes('p-12')))
  app.setFullscreen(false)
  app.stop()
})

test('pending: resize re-decides the fold from visual rows', async () => {
  const { vt, app } = startApp(200, 40)
  app.setTranscript([])
  const text = Array.from({ length: 8 }, () => 'x'.repeat(100)).join('\n')
  steering(app, [{ id: 'p1', rpcId: 'r1', text, status: 'steering', foldableText: true }])
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'wide: 8 visual rows stays full')
  vt.resize(80, 40)
  assert.equal(compactMarkerCount(await viewRows(vt)), 1, 'narrow: wrapping crosses the threshold')
  vt.resize(200, 40)
  assert.equal(compactMarkerCount(await viewRows(vt)), 0, 'wide again: the fold is re-decided')
  app.stop()
})
