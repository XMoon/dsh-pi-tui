/**
 * FR3 — the `Settings · Tools · MCP servers` page rendering, short-viewport
 * degradation, keyboard contract and mouse currentness.
 *
 * Evidence level: unit/presentation (L2) over a CONTROLLED controller snapshot.
 * The real controller + real Direct adapters are qualified by
 * `mcp-settings-mounted.test.ts`; this file pins what the user sees at each
 * layout, that no line wraps, and that a gesture can never dispatch against a
 * frame it was not pressed on.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/mcp-servers-page.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import {
  McpServersPage,
  mcpServerStatusText,
  mcpServersLayoutFor,
} from '../../src/tui/panels/mcp-servers-page.ts'
import type { McpServersController, McpServersSnapshot } from '../../src/app/command/mcp-servers.ts'

/** A presentation-only controller stub: it records the intents the page emits. */
class StubController {
  snapshotValue: McpServersSnapshot
  readonly calls: string[] = []
  operable = true

  constructor(snapshot: McpServersSnapshot) {
    this.snapshotValue = snapshot
  }

  snapshot(): McpServersSnapshot {
    return this.snapshotValue
  }

  move(delta: number, visibleNames: readonly string[]): void {
    this.calls.push(`move:${String(delta)}`)
    const current = this.snapshotValue.selectedName
    const index = current === undefined ? -1 : visibleNames.indexOf(current)
    const nextIndex = index === -1
      ? (delta >= 0 ? 0 : visibleNames.length - 1)
      : (index + delta + visibleNames.length) % visibleNames.length
    this.snapshotValue = { ...this.snapshotValue, selectedName: visibleNames[nextIndex] }
  }

  select(name: string, _visibleNames: readonly string[]): void {
    this.calls.push(`select:${name}`)
    this.snapshotValue = { ...this.snapshotValue, selectedName: name }
  }

  refresh(): void { this.calls.push('refresh') }
  probe(): void { this.calls.push('probe') }
  beginRestart(): void { this.calls.push('beginRestart') }
  answerRestart(confirmed: boolean): void { this.calls.push(`answerRestart:${String(confirmed)}`) }
  canOperateSelected(): boolean { return this.operable }
  dispose(): void {}
}

function connected(name: string, toolCount = 2): McpServersSnapshot['rows'][number] {
  return { name, configured: true, status: { state: 'connected', toolCount, connectedAt: 1 }, source: 'Configured' }
}

function snapshot(overrides: Partial<McpServersSnapshot> = {}): McpServersSnapshot {
  return {
    phase: 'ready',
    rows: [connected('alpha'), { name: 'beta', configured: true, status: { state: 'disabled' }, source: 'Plugin-owned' }],
    selectedName: 'alpha',
    ...overrides,
  }
}

function makePage(state: McpServersSnapshot, done: () => void = () => {}): {
  page: McpServersPage
  controller: StubController
} {
  const controller = new StubController(state)
  const page = new McpServersPage({
    controller: controller as unknown as McpServersController,
    requestRender: () => {},
    done,
  })
  return { page, controller }
}

/** Render at one size and return the plain painted lines. */
function render(page: McpServersPage, width: number, rows: number): string[] {
  page.setMaxRows(rows)
  return page.render(width).map(line => stripTerminalSequences(line))
}

test('the frozen breakpoints: >=108 wide, 76..107 medium, <=75 narrow; a short body degrades to one column', () => {
  assert.equal(mcpServersLayoutFor(120, 20), 'wide')
  assert.equal(mcpServersLayoutFor(108, 20), 'wide')
  assert.equal(mcpServersLayoutFor(107, 20), 'medium')
  assert.equal(mcpServersLayoutFor(76, 20), 'medium')
  assert.equal(mcpServersLayoutFor(75, 20), 'narrow')
  assert.equal(mcpServersLayoutFor(44, 8), 'narrow')
  // A two-column frame with fewer than five body rows would hide both columns.
  assert.equal(mcpServersLayoutFor(120, 4), 'medium')
})

test('status vocabulary is the official one — no invented connected-ish label', () => {
  assert.equal(mcpServerStatusText({ state: 'connected', toolCount: 3, connectedAt: 1 }), 'Connected')
  assert.equal(mcpServerStatusText({ state: 'waiting-credentials', lastError: 'no token' }), 'Waiting credentials')
  assert.equal(mcpServerStatusText({ state: 'failed', reason: 'gave-up', lastError: 'boom' }), 'Failed (gave up)')
})

test('the wide frame paints the list and the selected detail, one marker and no invented transport', () => {
  const { page } = makePage(snapshot())
  const lines = render(page, 120, 20)
  const frame = lines.join('\n')
  assert.match(frame, /Name\s+Status\s+Source/u)
  assert.match(frame, /▸ alpha/u)
  assert.match(frame, /beta/u)
  assert.match(frame, /Server: alpha/u)
  assert.match(frame, /Transport: Not exposed/u)
  assert.match(frame, /State: Connected/u)
  assert.match(frame, /Tool count: 2/u)
  assert.match(frame, /Back \[Esc\]/u)
  assert.equal(lines.filter(line => line.startsWith('▸ ')).length, 1, 'ONE selected-row marker')
  for (const line of lines) assert.ok(visibleWidth(line) <= 120)
  assert.equal(lines.length, 20, 'the page fills its exact grant')
})

test('the 44-wide frame keeps the selected row, its status and a complete Esc at 8 and at the real 5-line child grant', () => {
  for (const grant of [8, 5]) {
    const { page } = makePage(snapshot())
    // At a 44x8 terminal the root grants the page 5 lines (4 content + the one
    // physical Action Bar); this page is also exercised at its full 8-line
    // grant so a taller narrow grant cannot lose the Esc affordance either.
    const lines = render(page, 44, grant)
    const frame = lines.join('\n')
    assert.match(frame, /alpha/u, `grant ${String(grant)} paints the selected row`)
    assert.match(frame, /Connected/u, `grant ${String(grant)} paints the status`)
    assert.match(frame, /Back \[Esc\]/u, `grant ${String(grant)} paints the complete Esc affordance`)
    assert.ok(lines[lines.length - 1]!.includes('Back [Esc]'), 'the physical last row is the Action Bar')
    assert.ok(page.paintedEscapeSpan() !== undefined, 'a complete Esc affordance publishes its pointer span')
    for (const line of lines) assert.ok(visibleWidth(line) <= 44, `no line may exceed the frame: ${line}`)
    assert.equal(lines.length, grant, 'the page fills its exact grant')
  }
})

test('a probe that connected but did not confirm cleanup is its OWN result, never a pure success', () => {
  const { page } = makePage(snapshot({
    lastProbe: {
      name: 'alpha',
      kind: 'cleanup-unconfirmed',
      value: { ok: true, toolNames: ['echo'], truncated: false, durationMs: 4, closeConfirmed: false, cleanupError: 'close timeout' },
    },
  }))
  const frame = render(page, 120, 20).join('\n')
  assert.match(frame, /Last probe: ok · 1 tools · 4 ms · cleanup not confirmed/u)
})

test('an empty, loading, unavailable and read-error observation never fakes a server list', () => {
  const empty = makePage(snapshot({ rows: [], selectedName: undefined }))
  assert.match(render(empty.page, 88, 10).join('\n'), /No managed MCP servers/u)

  const loading = makePage(snapshot({ phase: 'loading', rows: [], selectedName: undefined }))
  assert.match(render(loading.page, 88, 10).join('\n'), /Loading MCP servers…/u)

  const unavailable = makePage(snapshot({ phase: 'unavailable', phaseReason: 'Host MCP Manager is not mounted', rows: [], selectedName: undefined }))
  const unavailableFrame = render(unavailable.page, 88, 10).join('\n')
  assert.match(unavailableFrame, /UNAVAILABLE · Host MCP Manager is not mounted/u)

  const stale = makePage(snapshot({ phase: 'read-error', phaseReason: 'observation lost' }))
  const staleFrame = render(stale.page, 88, 10).join('\n')
  assert.match(staleFrame, /READ ERROR/u)
  assert.match(staleFrame, /last known/u)
})

test('a restart confirmation owns the keyboard: only y executes, every other key is inert', async () => {
  let done = 0
  const { page, controller } = makePage(snapshot({ confirmingName: 'alpha' }), () => { done += 1 })
  const lines = render(page, 88, 12)
  assert.match(lines.join('\n'), /Restart alpha\? Live tools may be interrupted/u)
  assert.match(lines.join('\n'), /Y confirm · Esc cancel/u)
  page.handleInput('p')
  page.handleInput('r')
  page.handleInput('\r')
  assert.deepEqual(controller.calls, [], 'no other key may dispatch a Host operation or navigate')
  page.handleInput('y')
  assert.deepEqual(controller.calls, ['answerRestart:true'])
  page.handleInput('\x1b')
  assert.deepEqual(controller.calls, ['answerRestart:true', 'answerRestart:false'])
  assert.equal(done, 0, 'Esc in the confirmation cancels it, never the page')
})

test('detail keys probe/restart; the list only navigates; Esc steps back one level', () => {
  let done = 0
  const { page, controller } = makePage(snapshot(), () => { done += 1 })
  render(page, 88, 12)
  // List: p/x are not list actions.
  page.handleInput('p')
  page.handleInput('x')
  assert.deepEqual(controller.calls, [])
  // Enter opens the detail view (compact layout).
  page.handleInput('\r')
  render(page, 88, 12)
  page.handleInput('p')
  page.handleInput('x')
  assert.deepEqual(controller.calls, ['probe', 'beginRestart'])
  // Esc returns to the list, a second Esc closes the page.
  page.handleInput('\x1b')
  render(page, 88, 12)
  assert.equal(done, 0)
  page.handleInput('\x1b')
  assert.equal(done, 1)
})

test('a retained cleanup record advertises no Probe/Restart affordance', () => {
  const { page } = makePage(snapshot({
    rows: [{ name: 'gone', configured: false, status: { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } }, source: 'Retained/removed' }],
    selectedName: 'gone',
  }))
  const bar = render(page, 88, 12).at(-1) ?? ''
  assert.match(bar, /Back \[Esc\]/u)
  assert.doesNotMatch(bar, /p probe|probe/u)
  assert.doesNotMatch(bar, /x restart|restart/u)
})

test('search filters by name only and p/x/r are query text while searching', () => {
  const { page, controller } = makePage(snapshot())
  render(page, 88, 12)
  page.handleInput('/')
  page.handleInput('b')
  page.handleInput('e')
  page.handleInput('p')
  page.handleInput('x')
  page.handleInput('r')
  const frame = render(page, 88, 12).join('\n')
  assert.match(frame, /search: \/ bepxr/u)
  assert.doesNotMatch(frame, /alpha/u, 'a non-matching row is filtered out')
  assert.equal(controller.calls.includes('probe'), false)
  assert.equal(controller.calls.includes('beginRestart'), false)
  assert.equal(controller.calls.includes('refresh'), false)
  // Esc cancels the query without leaving the page.
  page.handleInput('\x1b')
  const restored = render(page, 88, 12).join('\n')
  assert.match(restored, /alpha/u)
  assert.match(restored, /beta/u)
})

test('a restarted refresh/grant change invalidates the previous pointer gesture', () => {
  const { page, controller } = makePage(snapshot())
  const lines = render(page, 120, 20)
  const rowIndex = lines.findIndex(line => line.includes('beta'))
  assert.ok(rowIndex >= 0)
  const mouseBase = { button: 'left' as const, screenX: 1, screenY: 1, shift: false, alt: false, ctrl: false }
  page.handleMouse({ ...mouseBase, type: 'press', x: 1, y: rowIndex, width: 120, height: 19 })
  // A resize repaints a different grant: the recorded press is stale.
  render(page, 120, 18)
  page.handleMouse({ ...mouseBase, type: 'click', x: 1, y: rowIndex, width: 120, height: 19 })
  assert.deepEqual(controller.calls, [], 'a press from the previous frame never selects')
  // A same-frame press -> release selects exactly that row.
  const fresh = render(page, 120, 20)
  const betaRow = fresh.findIndex(line => line.includes('beta'))
  page.handleMouse({ ...mouseBase, type: 'press', x: 1, y: betaRow, width: 120, height: 19 })
  page.handleMouse({ ...mouseBase, type: 'click', x: 1, y: betaRow, width: 120, height: 19 })
  assert.deepEqual(controller.calls, ['select:beta'])
})

test('a wheel moves the list selection and never leaks past the frame', () => {
  const { page, controller } = makePage(snapshot())
  render(page, 88, 12)
  const wheelBase = { button: 'left' as const, screenX: 1, screenY: 1, width: 88, height: 11, shift: false, alt: false, ctrl: false }
  page.handleMouse({ ...wheelBase, type: 'wheel', wheelDelta: 1, x: 1, y: 2 })
  assert.deepEqual(controller.calls, ['move:1'])
})
