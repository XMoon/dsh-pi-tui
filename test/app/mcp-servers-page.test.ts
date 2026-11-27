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
  // FR4 intents.
  canBeginAdd(): boolean { return this.addable && !this.savingBlocked }
  canBeginEdit(): boolean { return this.editable }
  canEditConfiguration(): boolean { return this.editable }
  beginAdd(): void {
    this.calls.push('beginAdd')
    this.snapshotValue = {
      ...this.snapshotValue,
      editor: {
        mode: 'add', name: '', nameEditable: true, transport: 'stdio', command: '', args: [], env: [], cwd: '',
        url: '', headers: [], enabled: true, dirty: true, issues: [], capturedRevision: 1,
      },
    }
  }
  beginEdit(): void {
    this.calls.push('beginEdit')
    if (this.snapshotValue.editor === undefined) {
      const row = this.snapshotValue.rows.find(candidate => candidate.name === this.snapshotValue.selectedName)
      this.snapshotValue = {
        ...this.snapshotValue,
        editor: {
          mode: 'edit', name: row?.name ?? 'alpha', nameEditable: false, transport: 'stdio', command: '/bin/echo', args: [],
          env: [], cwd: '', url: '', headers: [], enabled: true, dirty: false, issues: [], capturedRevision: 3,
          ...row?.entryToken === undefined ? {} : { entryToken: row.entryToken },
        },
      }
    }
  }
  beginToggle(): void { this.calls.push('beginToggle') }
  beginDelete(): void { this.calls.push('beginDelete') }
  beginReset(): void { this.calls.push('beginReset') }
  answerConfigConfirm(confirmed: boolean): void { this.calls.push(`answerConfigConfirm:${String(confirmed)}`) }
  saveEditor(): void { this.calls.push('saveEditor') }
  discardEditor(): void { this.calls.push('discardEditor'); this.snapshotValue = { ...this.snapshotValue, editor: undefined } }
  editorDirty(): boolean { return this.snapshotValue.editor?.dirty === true }
  setEditorField(field: string, value: string): void { this.calls.push(`setField:${field}=${value}`) }
  setEditorTransport(_transport: string): void { this.calls.push('setTransport') }
  setEditorEnabled(_enabled: boolean): void { this.calls.push('setEnabled') }
  addEditorArg(): void { this.calls.push('addArg') }
  setEditorArg(index: number, value: string): void { this.calls.push(`setArg:${String(index)}=${value}`) }
  removeEditorArg(index: number): void { this.calls.push(`removeArg:${String(index)}`) }
  addEditorDictKey(field: string): void { this.calls.push(`addDict:${field}`) }
  renameEditorDictKey(field: string, from: string, to: string): void { this.calls.push(`renameDict:${field}:${from}=${to}`) }
  setEditorDictValue(field: string, key: string, value: string, form = 'reference'): void {
    this.calls.push(`setDictValue:${field}:${key}=${value}:${form}`)
  }
  dictValueForm(_field: string, _key: string): 'reference' | 'literal' { return this.formValue }
  setEditorDictForm(field: string, key: string, form: 'reference' | 'literal'): void {
    this.calls.push(`setDictForm:${field}:${key}=${form}`)
    this.formValue = form
  }
  formValue: 'reference' | 'literal' = 'reference'
  savingBlocked = false
  removeEditorDictKey(field: string, key: string): void { this.calls.push(`removeDict:${field}:${key}`) }
  canRemoveDictKey(_field: string, _key: string): boolean { return this.keysRemovable }
  keysRemovable = true
  addable = true
  editable = true
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
    // The controller's read-only pointer-currentness projections: a controlled
    // snapshot starts at the first observation and read.
    observationEpoch: 0,
    configurationReadEpoch: 0,
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
  page.focused = true
  return { page, controller }
}

/** Render at one size through a realistic workbench grant. Page-level cases
 *  supply the grant explicitly; the Root projection itself is proved by the
 *  mounted suite. */
function pageRegion(page: McpServersPage): 'list' | 'detail' {
  return (page as unknown as { region: 'list' | 'detail' }).region
}

function render(page: McpServersPage, width: number, rows: number): string[] {
  const bodyRows = Math.max(0, rows - 1)
  page.setWebWorkbenchGrant({
    width,
    rows: bodyRows,
    barWidth: width,
    allowDual: width >= 108 && bodyRows >= 5,
  })
  return page.render(width).map(line => stripTerminalSequences(line))
}

/** The page-local mouse event base of one frame. */
function mouseBase(width: number, rows: number): {
  readonly button: 'left'
  readonly screenX: number
  readonly screenY: number
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
  readonly width: number
  readonly height: number
} {
  return {
    button: 'left' as const,
    screenX: 1,
    screenY: 1,
    shift: false,
    alt: false,
    ctrl: false,
    width,
    height: Math.max(0, rows - 1),
  }
}

/** Press+release one PAINTED bar span through the page's own hit map. */
function clickBarSpan(page: McpServersPage, id: string, width: number, rows: number): void {
  const span = page.paintedBarSpans().find(candidate => candidate.id === id)
  assert.ok(span !== undefined, `the ${id} span must be published`)
  const base = mouseBase(width, rows)
  page.handleMouse({ ...base, type: 'press', x: span.startCol, y: rows - 1 })
  page.handleMouse({ ...base, type: 'click', x: span.startCol, y: rows - 1 })
}

/** Press+release one painted body row cell. */
function clickBodyCell(page: McpServersPage, width: number, rows: number, y: number): void {
  const base = mouseBase(width, rows)
  page.handleMouse({ ...base, type: 'press', x: 1, y })
  page.handleMouse({ ...base, type: 'click', x: 1, y })
}

/** Reach the editor: list -> detail -> editor. A snapshot that already carries
 *  an open editor is ALREADY the form view; do not replay an activation the
 *  controller did not receive. */
function openEditor(page: McpServersPage, key: 'e' | 'a' = 'e', width = 100, rows = 16): string[] {
  let frame = render(page, width, rows)
  if (frame.some(line => /· (Edit|Add) ·/u.test(line))) return frame
  if (key === 'e') {
    page.handleInput('\r')
    frame = render(page, width, rows)
    if (frame.some(line => /· Edit ·/u.test(line))) return frame
  }
  page.handleInput(key)
  return render(page, width, rows)
}

test('status vocabulary is the official one — no invented connected-ish label', () => {
  assert.equal(mcpServerStatusText({ state: 'connected', toolCount: 3, connectedAt: 1 }), 'Connected')
  assert.equal(mcpServerStatusText({ state: 'waiting-credentials', lastError: 'no token' }), 'Waiting credentials')
  assert.equal(mcpServerStatusText({ state: 'failed', reason: 'gave-up', lastError: 'boom' }), 'Failed (gave up)')
})

test('the wide frame paints the list and the selected detail, one marker and no invented transport', () => {
  const { page } = makePage(snapshot())
  const lines = render(page, 120, 20)
  const frame = lines.join('\n')
  // The 34-cell List keeps Name + Status; Source stays in the readable Detail.
  assert.match(frame, /Name\s+Status/u)
  assert.doesNotMatch(frame, /Name\s+Status\s+Source/u)
  assert.match(frame, /Source: Configured/u)
  assert.match(frame, /> alpha/u)
  assert.match(frame, /beta/u)
  assert.match(frame, /Server: alpha/u)
  assert.match(frame, /Transport: Not exposed/u)
  assert.match(frame, /State: Connected/u)
  assert.match(frame, /Tool count: 2/u)
  assert.match(frame, /Back \[Esc\]/u)
  assert.equal(lines.filter(line => line.startsWith('> ')).length, 1, 'ONE selected-row marker')
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
  assert.match(lines.join('\n'), /Restart server alpha\. Live tools may be interrupted while it rebuilds\./u)
  assert.match(lines.join('\n'), /Confirm \[Y\] · Cancel \[Esc\]/u)
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
  assert.doesNotMatch(bar, /Probe \[P\]|probe/u)
  assert.doesNotMatch(bar, /Restart \[X\]|restart/u)
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
  // Cancel [Esc]s the query without leaving the page.
  page.handleInput('\x1b')
  const restored = render(page, 88, 12).join('\n')
  assert.match(restored, /alpha/u)
  assert.match(restored, /beta/u)
})

test('the list paints a clickable Search and the search bar a clickable Done; Cancel stays the ONE Root Esc', () => {
  const { page, controller } = makePage(snapshot())
  render(page, 100, 14)
  const listBar = render(page, 100, 14).at(-1) ?? ''
  assert.match(listBar, /Search \[\/\]/u, 'the list advertises the search entry')
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:start-search'),
    'the Search entry is a real delegated span')
  clickBarSpan(page, 'bar:start-search', 100, 14)
  const searchFrame = render(page, 100, 14).join('\n')
  assert.match(searchFrame, /search: \//u, 'the same `/` search sink opened the input')
  const searchBar = render(page, 100, 14).at(-1) ?? ''
  assert.match(searchBar, /Done \[Enter\]/u)
  assert.match(searchBar, /Cancel \[Esc\]/u)
  const spans = page.paintedBarSpans()
  assert.ok(spans.some(span => span.id === 'bar:finish-search'), 'Done is a real delegated span')
  assert.equal(spans.some(span => span.id === 'bar:cancel' || span.id === 'bar:search-cancel'), false,
    'the search cancel is the ONE physical Root Esc, never a second span')
  assert.ok(page.paintedEscapeSpan() !== undefined, 'Cancel [Esc] publishes the Root escape span')
  assert.deepEqual(controller.calls, [], 'entering search is Client-local presentation')
  clickBarSpan(page, 'bar:finish-search', 100, 14)
  const list = render(page, 100, 14)
  assert.doesNotMatch(list.join('\n'), /search: \//u, 'Done returns to the list')
  assert.match(list.at(-1) ?? '', /Search \[\/\]/u, 'the list advertises Search again')
})

test('Search stays a Client filter while the Host observation is not ready; Add does not', () => {
  const loading = makePage(snapshot({ phase: 'loading', rows: [], selectedName: undefined }))
  loading.controller.addable = false
  render(loading.page, 100, 14)
  const spans = loading.page.paintedBarSpans().map(span => span.id)
  assert.ok(spans.includes('bar:start-search'), 'Search only filters the Client view')
  assert.equal(spans.includes('bar:add'), false, 'Add needs a current descriptor')
  clickBarSpan(loading.page, 'bar:start-search', 100, 14)
  assert.match(render(loading.page, 100, 14).join('\n'), /search: \//u)
  assert.doesNotMatch(render(loading.page, 100, 14).at(-1) ?? '', /Add \[A\]/u)
})

test('a search-result row click only selects; the query and the search stay', () => {
  const { page, controller } = makePage(snapshot())
  render(page, 100, 14)
  clickBarSpan(page, 'bar:start-search', 100, 14)
  page.handleInput('b')
  const lines = render(page, 100, 14)
  const betaRow = lines.findIndex(line => line.includes('beta'))
  assert.ok(betaRow >= 0, `the filtered result must be painted: ${lines.join('\n')}`)
  // The query edit reconciled the selection onto the only match; the CLICK is
  // the gesture under test.
  controller.calls.length = 0
  clickBodyCell(page, 100, 14, betaRow)
  assert.deepEqual(controller.calls, ['select:beta'], 'a result click is a selection, nothing else')
  const after = render(page, 100, 14).join('\n')
  assert.match(after, /search: \/ b/u, 'the query stays')
  assert.deepEqual(
    controller.calls.filter(call => ['probe', 'beginRestart', 'beginAdd', 'beginEdit', 'beginToggle', 'beginDelete', 'beginReset', 'saveEditor'].includes(call)),
    [],
    'a result row click never runs a Host intent',
  )
})

test('a wheel while searching moves the filtered selection and scrolls no hidden region', () => {
  const { page, controller } = makePage(snapshot())
  render(page, 100, 14)
  clickBarSpan(page, 'bar:start-search', 100, 14)
  render(page, 100, 14)
  const base = mouseBase(100, 14)
  page.handleMouse({ ...base, type: 'wheel', wheelDelta: 1, x: 2, y: 2 })
  assert.deepEqual(controller.calls, ['move:1'], 'the search wheel moves the filtered selection')
  assert.match(render(page, 100, 14).join('\n'), /search: \//u, 'the search stays open')
})

test('a non-zero wheel revokes a pending press even when it scrolls nothing or a modal ignores it', () => {
  // (a) A boundary wheel in a one-result search cannot move the selection, but
  // it is still a gesture boundary: the held row press never selects.
  const single = makePage(snapshot())
  render(single.page, 100, 14)
  single.page.handleInput('/')
  single.page.handleInput('b')
  const lines = render(single.page, 100, 14)
  const row = lines.findIndex(line => line.includes('beta'))
  assert.ok(row >= 0)
  single.controller.calls.length = 0
  const base = mouseBase(100, 14)
  single.page.handleMouse({ ...base, type: 'press', x: 1, y: row })
  single.page.handleMouse({ ...base, type: 'wheel', wheelDelta: -1, x: 1, y: row })
  single.page.handleMouse({ ...base, type: 'click', x: 1, y: row })
  assert.deepEqual(single.controller.calls.filter(call => call.startsWith('select:')), [],
    'a wheel-revoked press never selects')

  // (b) A modal ignores the wheel, but the pending decision press is revoked.
  const modal = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 1 },
  }))
  const modalLines = render(modal.page, 100, 14)
  const barRow = modalLines.length - 1
  const col = (modalLines[barRow] ?? '').indexOf('Confirm [Y]') + 1
  assert.ok(col > 0, `the confirm affordance must paint: ${modalLines[barRow]}`)
  modal.page.handleMouse({ ...base, type: 'press', x: col, y: barRow })
  modal.page.handleMouse({ ...base, type: 'wheel', wheelDelta: 1, x: 2, y: 2 })
  modal.page.handleMouse({ ...base, type: 'click', x: col, y: barRow })
  assert.deepEqual(modal.controller.calls.filter(call => call.startsWith('answerConfigConfirm')), [],
    'a modal wheel revokes its pending decision press')

  // (c) A zero-delta wheel is no input at all: the press survives.
  const zero = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 1 },
  }))
  const zeroLines = render(zero.page, 100, 14)
  const zeroBar = zeroLines.length - 1
  const zeroCol = (zeroLines[zeroBar] ?? '').indexOf('Confirm [Y]') + 1
  zero.page.handleMouse({ ...base, type: 'press', x: zeroCol, y: zeroBar })
  zero.page.handleMouse({ ...base, type: 'wheel', wheelDelta: 0, x: 2, y: 2 })
  zero.page.handleMouse({ ...base, type: 'click', x: zeroCol, y: zeroBar })
  assert.deepEqual(zero.controller.calls, ['answerConfigConfirm:true'],
    'a zero-delta wheel changes nothing')
})

test('a Host observation rebuild between press and release refuses the identical-looking gesture', () => {
  const { page, controller } = makePage(snapshot())
  render(page, 100, 14)
  const lines = render(page, 100, 14)
  const row = lines.findIndex(line => line.includes('beta'))
  assert.ok(row >= 0)
  const base = mouseBase(100, 14)
  page.handleMouse({ ...base, type: 'press', x: 1, y: row })
  // Host B replaces Host A with the SAME names, statuses, count and selection:
  // only the observation epoch moved, and no frame has painted it yet.
  controller.snapshotValue = { ...controller.snapshotValue, observationEpoch: 1 }
  page.handleMouse({ ...base, type: 'click', x: 1, y: row })
  assert.deepEqual(controller.calls, [], 'a press from the previous observation never completes')
  // A fresh press on the repainted B frame selects normally.
  const fresh = render(page, 100, 14)
  const freshRow = fresh.findIndex(line => line.includes('beta'))
  clickBodyCell(page, 100, 14, freshRow)
  assert.deepEqual(controller.calls, ['select:beta'], 'a fresh gesture on B is admitted')
})

test('a configuration read result between press and release refuses the old draft intent', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    config: { kind: 'ready', generation: {}, revision: 1, entries: [] },
  }))
  render(page, 100, 14)
  page.handleInput('\r')
  const lines = render(page, 100, 14)
  const barRow = lines.length - 1
  const col = (lines[barRow] ?? '').indexOf('Edit [E]') + 1
  assert.ok(col > 0, `the Edit affordance must paint: ${lines[barRow]}`)
  const base = mouseBase(100, 14)
  page.handleMouse({ ...base, type: 'press', x: col, y: barRow })
  // The same roster re-read the configuration: the revision moved before any
  // frame painted it.
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configurationReadEpoch: 1,
    config: { kind: 'ready', generation: {}, revision: 2, entries: [] },
  }
  page.handleMouse({ ...base, type: 'click', x: col, y: barRow })
  assert.deepEqual(controller.calls, [], 'the old Edit intent never runs against the new revision')
  // A fresh press on the repainted frame opens the draft.
  const fresh = render(page, 100, 14)
  const freshBar = fresh.length - 1
  const freshCol = (fresh[freshBar] ?? '').indexOf('Edit [E]') + 1
  page.handleMouse({ ...base, type: 'press', x: freshCol, y: freshBar })
  page.handleMouse({ ...base, type: 'click', x: freshCol, y: freshBar })
  assert.deepEqual(controller.calls, ['beginEdit'], 'a fresh gesture reads the current revision')
})

test('a query keystroke between a Done press and its release refuses the stale completion', () => {
  const { page } = makePage(snapshot())
  render(page, 100, 14)
  clickBarSpan(page, 'bar:start-search', 100, 14)
  render(page, 100, 14)
  const span = page.paintedBarSpans().find(candidate => candidate.id === 'bar:finish-search')
  assert.ok(span !== undefined)
  const base = mouseBase(100, 14)
  page.handleMouse({ ...base, type: 'press', x: span.startCol, y: 13 })
  page.handleInput('x') // the query text changed under the held Done press
  page.handleMouse({ ...base, type: 'click', x: span.startCol, y: 13 })
  assert.match(render(page, 100, 14).join('\n'), /search: \/ x/u, 'the stale Done never completes')
  // A fresh complete Done click finishes the search exactly once.
  clickBarSpan(page, 'bar:finish-search', 100, 14)
  assert.doesNotMatch(render(page, 100, 14).join('\n'), /search: \//u)
})

test('a raw query edit that keeps the same filter still revokes the held Done', () => {
  const { page } = makePage(snapshot())
  render(page, 100, 14)
  clickBarSpan(page, 'bar:start-search', 100, 14)
  page.handleInput('b')
  render(page, 100, 14)
  const span = page.paintedBarSpans().find(candidate => candidate.id === 'bar:finish-search')
  assert.ok(span !== undefined)
  const base = mouseBase(100, 14)
  page.handleMouse({ ...base, type: 'press', x: span.startCol, y: 13 })
  // A trailing space changes the RAW painted query while the normalized filter
  // ('b') is unchanged: the held Done must still be revoked.
  page.handleInput(' ')
  page.handleMouse({ ...base, type: 'click', x: span.startCol, y: 13 })
  assert.match(render(page, 100, 14).join('\n'), /search: \/ b /u, 'the stale Done never completes')
  // A fresh complete click finishes the search exactly once.
  clickBarSpan(page, 'bar:finish-search', 100, 14)
  assert.doesNotMatch(render(page, 100, 14).join('\n'), /search: \//u)
})

test('removing the last draft row re-centers the row that becomes focused', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({
      args: [],
      env: [{ key: 'E', value: '${credential:E}' }],
      dirty: true,
    }),
  }))
  openEditor(page, 'e', 44, 8)
  wheelFocusUntil(page, 44, 8, frame => /> Env key: E/u.test(frame))
  // The draft loses the whole env entry (key + value + form rows) with no
  // repaint: the focused index now points past the form.
  controller.snapshotValue = {
    ...controller.snapshotValue,
    editor: editorSnapshot({ args: [], env: [], dirty: true }),
  }
  const frame = render(page, 44, 8).join('\n')
  assert.match(frame, /> [^:\n]+:/u, `a focused field stays painted after the removal: ${frame}`)
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

/* ────────────────────────────────────────────────────────────────────────── *
 * FR4: the configuration form, its confirmations and its safety rules.
 * ────────────────────────────────────────────────────────────────────────── */

/** One config-owned selected entry facet. */
const CONFIG_FACET = { name: 'alpha', provenance: 'user-added' as const, canToggle: true, canDelete: true, canReset: false, enabled: true }

function editorSnapshot(overrides: Partial<NonNullable<McpServersSnapshot['editor']>> = {}): NonNullable<McpServersSnapshot['editor']> {
  return {
    mode: 'edit',
    name: 'alpha',
    nameEditable: false,
    transport: 'stdio',
    command: '/bin/echo',
    args: ['--flag'],
    env: [{ key: 'TOKEN', value: '${credential:TOKEN}' }],
    cwd: '',
    url: '',
    headers: [],
    enabled: true,
    dirty: false,
    issues: [],
    capturedRevision: 3,
    ...overrides,
  }
}

test('the list offers `Add [A]` only with a current descriptor, and search swallows it', () => {
  const ready = makePage(snapshot({ config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  assert.match(render(ready.page, 100, 14).at(-1) ?? '', /Add \[A\]/u)
  const unavailable = makePage(snapshot({ config: { kind: 'unavailable', reason: 'not read' } }))
  // The page asks the CONTROLLER, so the stub's own gate decides.
  unavailable.controller.addable = false
  assert.doesNotMatch(render(unavailable.page, 100, 14).at(-1) ?? '', /Add/u)
  // An in-flight Probe blocks Add for the same reason.
  const busy = makePage(snapshot({ config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  busy.controller.addable = false
  assert.doesNotMatch(render(busy.page, 100, 14).at(-1) ?? '', /Add/u)

  const { page, controller } = makePage(snapshot({ config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  render(page, 100, 14)
  page.handleInput('/')
  page.handleInput('a')
  assert.deepEqual(controller.calls.filter(call => call === 'beginAdd'), [], 'a is query text while searching')
})

test('a config-owned detail offers e/t/d/u beside the FR3 p/x; a plugin-owned row offers none', () => {
  const owned = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(owned.page, 100, 14)
  owned.page.handleInput('\r')
  const configured = render(owned.page, 100, 14)
  const bar = configured.at(-1) ?? ''
  // The physical bar keeps the ONE primary business verb and Back.
  assert.match(bar, /Edit \[E\]/u)
  assert.match(bar, /Back \[Esc\]/u)
  assert.doesNotMatch(bar, /Enable\/Disable \[T\]|Delete \[D\]|Probe \[P\]|Restart \[X\]/u)
  // Every other legal verb stays in the nearby body group exactly once.
  const frame = configured.join('\n')
  for (const hint of [/Edit \[E\]/u, /Enable\/Disable \[T\]/u, /Delete \[D\]/u, /Probe \[P\]/u, /Restart \[X\]/u]) {
    assert.match(frame, hint, `configured detail must offer ${String(hint)} in its body`)
  }
  owned.page.handleInput('e')
  assert.deepEqual(owned.controller.calls.filter(call => ['beginEdit', 'beginToggle', 'beginDelete'].includes(call)), ['beginEdit'])
  const toggle = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(toggle.page, 100, 14)
  toggle.page.handleInput('\r')
  render(toggle.page, 100, 14)
  toggle.page.handleInput('t')
  assert.deepEqual(toggle.controller.calls, ['beginToggle'])
  const remove = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(remove.page, 100, 14)
  remove.page.handleInput('\r')
  render(remove.page, 100, 14)
  remove.page.handleInput('d')
  assert.deepEqual(remove.controller.calls, ['beginDelete'])

  const pluginOwned = makePage(snapshot({ selectedConfig: undefined }))
  // The controller denies every CRUD intent for a non-config-owned row.
  pluginOwned.controller.editable = false
  pluginOwned.controller.addable = false
  render(pluginOwned.page, 100, 14)
  pluginOwned.page.handleInput('\r')
  const pluginFrame = render(pluginOwned.page, 100, 14)
  const pluginBar = pluginFrame.at(-1) ?? ''
  assert.match(pluginBar, /Probe \[P\]/u, 'a plugin-owned server keeps its primary probe')
  assert.doesNotMatch(pluginBar, /Edit \[E\]|Enable\/Disable \[T\]|Delete \[D\]|Reset \[U\]/u)
  assert.doesNotMatch(pluginFrame.join('\n'), /Edit \[E\]|Enable\/Disable \[T\]|Delete \[D\]|Reset \[U\]/u)
  pluginOwned.page.handleInput('e')
  pluginOwned.page.handleInput('d')
  pluginOwned.page.handleInput('u')
  assert.deepEqual(pluginOwned.controller.calls.filter(call => ['beginEdit', 'beginDelete', 'beginReset'].includes(call)), [])
})

test('the editor paints grouped fields and keeps Save [S] + Back [Esc] reachable at 44x8', () => {
  const { page } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  page.handleInput('e')
  // Put the page into the editor view through the Add intent of the stub.
  const added = makePage(snapshot({ config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  added.page.handleInput('a')
  const lines = render(added.page, 44, 8)
  const frame = lines.join('\n')
  // RC-B: the fixed identity line is painted INSIDE the body grant, so it is
  // visible at the 44-column floor (where the Root grants no pane header).
  assert.match(frame, /\(unnamed\) · Add/u)
  assert.match(frame, /Name/u)
  assert.match(frame, /Transport/u)
  assert.match(frame, /Save \[S\]/u)
  assert.match(frame, /Back \[Esc\]/u)
  assert.equal(lines.length, 8)
  for (const line of lines) assert.ok(visibleWidth(line) <= 44)
})

test('while a form input is active, a/e/t/d/u/s are INPUT characters, never page actions', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  openEditor(page)
  // Focus the Command row and open its input (rows: name, transport, enabled, command...).
  page.handleInput('\x1b[B')
  page.handleInput('\x1b[B')
  page.handleInput('\x1b[B')
  page.handleInput('\r')
  render(page, 100, 16)
  for (const key of ['a', 'e', 't', 'd', 'u', 's']) page.handleInput(key)
  const typed = controller.calls.filter(call => ['beginAdd', 'beginEdit', 'beginToggle', 'beginDelete', 'beginReset', 'saveEditor'].includes(call))
  assert.deepEqual(typed, ['beginEdit'], 'only the opening intent ran before the input took the keyboard')
  // Enter commits the typed value through the controller.
  page.handleInput('\r')
  const commit = controller.calls.find(call => call.startsWith('setField:command='))
  assert.equal(commit, 'setField:command=/bin/echoaetdus')
})

test('a dirty form Esc opens the discard confirmation; only `d` drops the draft', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page)
  page.handleInput('\x1b')
  const confirm = render(page, 100, 16).join('\n')
  assert.match(confirm, /Discard changes\? Unsaved edits are dropped/u)
  // The affirmative is the explicit D verb; Esc is the default Keep.
  assert.match(confirm, /Discard \[D\] · Keep \[Esc\]/u)
  // Enter keeps editing: nothing is discarded and no write happens.
  page.handleInput('\r')
  assert.equal(controller.calls.includes('discardEditor'), false)
  page.handleInput('\x1b')
  render(page, 100, 16) // the reopened discard question must paint before `d`
  page.handleInput('d')
  assert.equal(controller.calls.includes('discardEditor'), true)
  assert.equal(controller.calls.includes('saveEditor'), false)
})

test('a clean form Esc closes the editor without a discard prompt', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot() }))
  openEditor(page)
  page.handleInput('\x1b')
  assert.equal(controller.calls.includes('discardEditor'), true)
  assert.doesNotMatch(render(page, 100, 16).join('\n'), /Discard changes/u)
})

test('the delete confirmation names the exact server and only `y` dispatches', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 1 },
  }))
  const frame = render(page, 100, 14).join('\n')
  assert.match(frame, /Permanently delete server alpha from this profile\./u)
  assert.match(frame, /Confirm \[Y\] · Cancel \[Esc\]/u)
  page.handleInput('e')
  page.handleInput('x')
  page.handleInput('\r')
  assert.deepEqual(controller.calls, [], 'no other key may answer the confirmation')
  page.handleInput('y')
  assert.deepEqual(controller.calls, ['answerConfigConfirm:true'])
})

test('the reset confirmation never uses Delete wording', () => {
  const { page } = makePage(snapshot({
    selectedConfig: { ...CONFIG_FACET, canDelete: false, canReset: true, provenance: 'overridden' },
    configConfirm: { question: 1, kind: 'reset', name: 'alpha', capturedRevision: 1 },
  }))
  const frame = render(page, 100, 14).join('\n')
  assert.match(frame, /Reset server alpha to its inherited configuration\./u)
  assert.doesNotMatch(frame, /Delete/u)
})

test('the toggle confirmation says the process may change', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'toggle', name: 'alpha', nextEnabled: false, capturedRevision: 1 },
  }))
  const frame = render(page, 100, 14).join('\n')
  assert.match(frame, /Disable server alpha\. The MCP process may stop; live tools may be interrupted\./u)
})

test('the form status reports the captured revision and never claims a connection', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
    configStatus: { kind: 'saved', text: 'Saved · waiting for Host reconcile' },
  }))
  const frame = openEditor(page).join('\n')
  assert.match(frame, /Saved · waiting for Host reconcile/u)
  assert.doesNotMatch(frame, /Connected/u)
})

test('a conflict status stays an error and keeps the draft visible', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
    configStatus: { kind: 'conflict', text: 'Not saved · configuration changed; refresh to review' },
  }))
  const frame = openEditor(page).join('\n')
  assert.match(frame, /Not saved · configuration changed; refresh to review/u)
  assert.match(frame, /Save \[S\]/u, 'the form stays open so the user can re-read and save')
})

test('a control-byte/CJK server name is sanitized in the confirmation bar', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'delete', name: 'bad\u0007name日本', capturedRevision: 1 },
  }))
  const lines = render(page, 100, 14)
  const frame = lines.join('\n')
  assert.doesNotMatch(frame, /\u0007/u)
  assert.match(frame, /Permanently delete server bad ?name日本 from this profile/u)
  for (const line of lines) assert.ok(visibleWidth(line) <= 100)
})

test('the confirmation target stays readable in the BODY at every width', () => {
  // The body carries the exact target/consequence; the bar carries only the
  // decision, so a target is never truncated into a different question.
  for (const width of [100, 80, 72, 44]) {
    const deletePage = makePage(snapshot({ selectedConfig: CONFIG_FACET, configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 1 } }))
    const deleteFrame = render(deletePage.page, width, 14).join('\n').replace(/\s+/gu, ' ')
    assert.match(deleteFrame, /delete server alpha from this profile/u, `width ${String(width)}: the Delete subject must survive`)
    assert.match(deleteFrame, /Confirm \[Y\] · Cancel \[Esc\]/u, `width ${String(width)}: the decision survives`)

    const resetPage = makePage(snapshot({
      selectedConfig: { ...CONFIG_FACET, canDelete: false, canReset: true, provenance: 'overridden' },
      configConfirm: { question: 1, kind: 'reset', name: 'alpha', capturedRevision: 1 },
    }))
    const resetFrame = render(resetPage.page, width, 14).join('\n').replace(/\s+/gu, ' ')
    assert.match(resetFrame, /Reset server alpha to its inherited configuration/u, `width ${String(width)}: the Reset subject must survive`)

    const togglePage = makePage(snapshot({ selectedConfig: CONFIG_FACET, configConfirm: { question: 1, kind: 'toggle', name: 'alpha', nextEnabled: false, capturedRevision: 1 } }))
    const toggleFrame = render(togglePage.page, width, 14).join('\n').replace(/\s+/gu, ' ')
    assert.match(toggleFrame, /Disable server alpha/u, `width ${String(width)}: the toggle subject must survive`)

    const restartPage = makePage(snapshot({ confirmingName: 'alpha' }))
    const restartFrame = render(restartPage.page, width, 14).join('\n').replace(/\s+/gu, ' ')
    assert.match(restartFrame, /Restart server alpha/u, `width ${String(width)}: the Restart subject must survive`)
  }
})

test('a dirty-discard prompt keeps its question at every narrow width', () => {
  for (const width of [100, 80, 44]) {
    const { page } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
    openEditor(page, 'e', width, 16)
    page.handleInput('\x1b')
    const frame = render(page, width, 16).join('\n')
    assert.match(frame, /Discard changes\? Unsaved edits are dropped/u, `width ${String(width)}: the discard question must survive`)
    assert.match(frame, /Discard \[D\] · Keep \[Esc\]/u, `width ${String(width)}: the explicit decision must survive`)
  }
})

test('a Save confirmation paints the external-capability subject at every width', () => {
  for (const width of [200, 100, 80, 44]) {
    const { page } = makePage(snapshot({
      selectedConfig: CONFIG_FACET,
      editor: editorSnapshot({ dirty: true }),
      configConfirm: {
        question: 1,
        kind: 'save',
        name: 'alpha',
        warning: 'Enabling this server can execute an external command.',
        capturedRevision: 1,
      },
    }))
    const frame = render(page, width, 16).join('\n')
    // The full-width view names the SERVER and keeps the capability fact in the
    // body; the bar carries the decision.
    assert.match(frame, /alpha/u, `width ${String(width)}: the exact server must be named`)
    assert.match(frame, /external command/u, `width ${String(width)}: the disclosure must be readable`)
    assert.match(frame, /Confirm \[Y\]/u, `width ${String(width)}: the affirmative key is advertised`)
    assert.match(frame, /Cancel \[Esc\]/u, `width ${String(width)}: the cancel key is advertised`)
  }
})

test('a Save confirmation only dispatches on `y`, never on another key', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
    configConfirm: { question: 1, kind: 'save', name: 'alpha', warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }))
  render(page, 100, 16)
  for (const key of ['s', 'e', 'd', 'u', '\r']) page.handleInput(key)
  assert.deepEqual(controller.calls, [], 'no other key may answer the disclosure')
  page.handleInput('y')
  assert.deepEqual(controller.calls, ['answerConfigConfirm:true'])
})

test('a compacted HTTP confirmation keeps the host in the body and the decision in the bar', () => {
  const warning = 'Enabling this server can send data to an external service. Target: mcp.example.test'
  for (const width of [200, 100, 80, 44]) {
    const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ transport: 'streamable-http', dirty: true }) }))
    openEditor(page, 'e', width, 20)
    controller.snapshotValue = {
      ...controller.snapshotValue,
      configConfirm: { question: 1, kind: 'save', name: 'alpha', warning, capturedRevision: 1 },
    }
    const frame = render(page, width, 20).join('\n')
    // The BODY carries the capability fact and the target host (wrapped,
    // hard-split); it must be readable at every width.
    assert.match(frame, /external service/u, `width ${String(width)}: the capability fact must be in the body`)
    assert.match(frame, /mcp\.example\.test/u, `width ${String(width)}: the target host must be in the body`)
    // The BAR keeps the decision keys, whatever the name/host length.
    assert.match(frame, /Confirm \[Y\]|\by\b/u, `width ${String(width)}: the affirmative key survives`)
    assert.match(frame, /Esc/u, `width ${String(width)}: the escape key survives`)
  }
})

test('the form exposes an explicit storage-form row that the user can switch', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({
      env: [{ key: 'TOKEN', value: '${credential:TOKEN}' }],
      dirty: true,
    }),
  }))
  openEditor(page, 'e')
  const frame = render(page, 100, 20).join('\n')
  // The stored FORM is visible, and it is its own focusable row.
  assert.match(frame, /stored as: Credential reference/u)
  // Walk to that row and switch it.
  for (let step = 0; step < 14; step += 1) {
    const current = /> ([^:\n]+):/u.exec(render(page, 100, 20).join('\n'))
    if (current !== null && (current[1] ?? '').trim().startsWith('Env TOKEN stored as')) break
    page.handleInput('\x1b[B')
  }
  page.handleInput('\r')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('setDictForm')), ['setDictForm:env:TOKEN=literal'])
  const after = render(page, 100, 20).join('\n')
  assert.match(after, /stored as: Literal \(stored in profile\)/u, 'the switch is painted')
})

test('the focused field stays visible while walking the form at short grants', () => {
  for (const [width, rows] of [[80, 10], [44, 8]] as const) {
    const { page } = makePage(snapshot({
      selectedConfig: CONFIG_FACET,
      editor: editorSnapshot({
        args: ['--one', '--two', '--three'],
        env: [
          { key: 'A', value: '${credential:A}' },
          { key: 'B', value: '${credential:B}' },
          { key: 'C', value: '${credential:C}' },
        ],
        dirty: true,
      }),
    }))
    openEditor(page, 'a', width, rows)
    // Walk every field; after each step the FOCUSED label must be painted.
    for (let step = 0; step < 24; step += 1) {
      page.handleInput('\x1b[B')
      const frame = render(page, width, rows).join('\n')
      const focused = /> ([^:\n]+):/u.exec(frame)
      assert.ok(focused !== null, `${width}x${rows} step ${String(step)}: a focused row must be painted`)
      assert.notEqual((focused[1] ?? '').trim(), '', `${width}x${rows} step ${String(step)}: the focus marker labels a field`)
    }
    // Save and Esc remain reachable at the floor after walking.
    const final = render(page, width, rows).join('\n')
    assert.match(final, /Save \[S\]/u, `${width}x${rows}: Save stays reachable`)
    assert.match(final, /Back \[Esc\]/u, `${width}x${rows}: Esc stays reachable`)
  }
})

test('adding rows keeps later fields reachable and the focus visible', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
  }))
  openEditor(page, 'e', 80, 10)
  // Add three argument rows, then walk past them into the env rows.
  controller.addEditorArg()
  controller.addEditorArg()
  controller.addEditorArg()
  for (let step = 0; step < 20; step += 1) {
    page.handleInput('\x1b[B')
    const frame = render(page, 80, 10).join('\n')
    assert.match(frame, /> [^:\n]+:/u, `step ${String(step)}: the focused field is painted`)
  }
})

test('a base-owned env key states it cannot be removed and backspace does nothing', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({
      env: [{ key: 'BASE_KEY', value: 'base-value' }, { key: 'USER_KEY', value: '${credential:U}' }],
      dirty: true,
    }),
  }))
  // The stub denies removal of exactly BASE_KEY.
  controller.canRemoveDictKey = (_field: string, key: string) => key !== 'BASE_KEY'
  openEditor(page, 'e')
  const frame = render(page, 120, 24).join('\n')
  assert.match(frame, /BASE_KEY · Inherited · cannot remove here/u,
    'the base-owned key states why Remove is absent')
  // Focus the BASE_KEY row and press backspace: nothing is removed.
  for (let step = 0; step < 14; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(page, 120, 24).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim() === 'Env key') {
      const withBase = render(page, 120, 24).join('\n').includes('BASE_KEY · Inherited')
      if (withBase) break
    }
    page.handleInput('\x1b[B')
  }
  page.handleInput('\x7f')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeDict')), [],
    'a base-owned key never reaches the removal intent')
})

test('the Detail Action Bar advertises exactly the actions the controller allows', () => {
  // User-added: probe/restart + the full CRUD set that the facet allows.
  const userAdded = makePage(snapshot({
    selectedConfig: { ...CONFIG_FACET, canDelete: true, canReset: false },
  }))
  render(userAdded.page, 120, 20)
  userAdded.page.handleInput('\r')
  const userAddedFrame = render(userAdded.page, 120, 20)
  const userBar = userAddedFrame.at(-1) ?? ''
  const userBody = userAddedFrame.join('\n')
  assert.match(userBar, /Edit \[E\]/u, 'the editable facet keeps the primary Edit on the bar')
  for (const hint of [/Probe \[P\]/u, /Restart \[X\]/u, /Enable\/Disable \[T\]/u, /Delete \[D\]/u]) {
    assert.match(userBody, hint, `user-added detail must offer ${String(hint)} in its body`)
  }
  assert.doesNotMatch(userBody, /Reset \[U\]/u, 'user-added has no override to reset')

  // Inherited (unmodified): edit + toggle, NEITHER delete nor reset.
  const inherited = makePage(snapshot({
    selectedConfig: { name: 'alpha', provenance: 'inherited', canToggle: true, canDelete: false, canReset: false },
  }))
  render(inherited.page, 120, 20)
  inherited.page.handleInput('\r')
  const inheritedBody = render(inherited.page, 120, 20).join('\n')
  assert.match(inheritedBody, /Edit \[E\]/u)
  assert.match(inheritedBody, /Enable\/Disable \[T\]/u)
  assert.doesNotMatch(inheritedBody, /Delete \[D\]/u, 'an inherited entry offers no Delete')
  assert.doesNotMatch(inheritedBody, /Reset \[U\]/u, 'an unmodified inherited entry offers no Reset')

  // Overridden: edit + toggle + reset, no Delete.
  const overridden = makePage(snapshot({
    selectedConfig: { name: 'alpha', provenance: 'overridden', canToggle: true, canDelete: false, canReset: true },
  }))
  render(overridden.page, 120, 20)
  overridden.page.handleInput('\r')
  const overriddenBody = render(overridden.page, 120, 20).join('\n')
  assert.match(overriddenBody, /Reset \[U\]/u)
  assert.doesNotMatch(overriddenBody, /Delete \[D\]/u)

  // Plugin-owned: NO CRUD, but the FR3 Probe/Restart ARE available.
  const pluginOwned = makePage(snapshot({ selectedConfig: undefined }))
  pluginOwned.controller.canOperateSelected = () => true
  render(pluginOwned.page, 120, 20)
  pluginOwned.page.handleInput('\r')
  const pluginFrame = render(pluginOwned.page, 120, 20)
  const pluginBar = pluginFrame.at(-1) ?? ''
  const pluginBody = pluginFrame.join('\n')
  assert.match(pluginBar, /Probe \[P\]/u, 'a plugin-owned server is still probeable (FR3) and owns the primary bar verb')
  assert.match(pluginBody, /Restart \[X\]/u, 'a plugin-owned server is still restartable (FR3) in the body')
  assert.doesNotMatch(pluginBody, /Edit \[E\]|Enable\/Disable \[T\]|Delete \[D\]|Reset \[U\]/u)

  // Retained cleanup record: no CRUD and no Probe/Restart.
  const retained = makePage(snapshot({
    rows: [{ name: 'gone', configured: false, status: { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } }, source: 'Retained/removed' }],
    selectedName: 'gone',
    selectedConfig: undefined,
  }))
  retained.controller.canOperateSelected = () => false
  render(retained.page, 120, 20)
  retained.page.handleInput('\r')
  const retainedFrame = render(retained.page, 120, 20)
  const retainedBar = retainedFrame.at(-1) ?? ''
  assert.match(retainedBar, /Refresh \[R\]/u, 'only the re-observation action remains')
  assert.doesNotMatch(retainedFrame.join('\n'), /Probe \[P\]|Restart \[X\]|Edit \[E\]|Delete \[D\]|Reset \[U\]/u)

  // A write in flight: the editor bar no longer advertises `Save [S]`.
  const saving = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
    configStatus: { kind: 'saving', text: 'Saving configuration…' },
  }))
  openEditor(saving.page, 'e')
  const savingBar = render(saving.page, 120, 20).at(-1) ?? ''
  assert.doesNotMatch(savingBar, /Save \[S\]/u, 'a frozen draft must not advertise Save')
  assert.match(savingBar, /Saving/u)
  assert.doesNotMatch(savingBar, /Esc/u,
    'the informational saving bar has no exit target')
})

test('a config write in flight removes every detail CRUD affordance from the bar', () => {
  // Toggle/Delete/Reset settle on the DETAIL view (no form open), so the bar is
  // visible while the write is unsettled: it must not advertise an Edit the
  // controller refuses, while Probe/Restart stay independently available.
  const { page, controller } = makePage(snapshot({
    selectedConfig: { ...CONFIG_FACET, canDelete: true, canReset: true },
    configStatus: { kind: 'saving', text: 'Saving configuration…' },
  }))
  // The controller denies every edit while saving.
  controller.canBeginEdit = () => false
  render(page, 120, 20)
  page.handleInput('\r')
  const frame = render(page, 120, 20)
  const bar = frame.at(-1) ?? ''
  assert.match(bar, /Probe \[P\]/u, 'the independently available primary owns the bar')
  assert.match(bar, /Back \[Esc\]/u)
  assert.doesNotMatch(bar, /Edit \[E\]/u, 'no Edit while a write is unsettled')
  assert.match(frame.join('\n'), /Restart \[X\]/u, 'Restart stays reachable in the body')
})

test('an explicit empty Enter commits an empty literal, while Esc keeps the value', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ env: [{ key: 'E', value: 'stored' }], dirty: true }),
  }))
  controller.formValue = 'literal'
  openEditor(page, 'e')
  // Focus the Env value row, open the input, press Enter on the empty text.
  for (let step = 0; step < 14; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(page, 100, 20).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim() === 'Env E') break
    page.handleInput('\x1b[B')
  }
  page.handleInput('\r')
  render(page, 100, 20)
  page.handleInput('\r') // empty commit on a LITERAL
  assert.ok(controller.calls.includes('setDictValue:env:E=:literal'),
    `an explicit empty literal must be committed: ${controller.calls.join(',')}`)

  // Cancel [Esc]s the edit without touching the value.
  controller.calls.length = 0
  page.handleInput('\r')
  page.handleInput('\x1b')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('setDictValue')), [],
    'Esc never commits')
})

test('an empty Enter on a credential reference keeps the value (a blank ref is invalid)', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ env: [{ key: 'E', value: '${credential:E}' }], dirty: true }),
  }))
  controller.formValue = 'reference'
  openEditor(page, 'e')
  for (let step = 0; step < 14; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(page, 100, 20).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim() === 'Env E') break
    page.handleInput('\x1b[B')
  }
  page.handleInput('\r')
  page.handleInput('\r')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('setDictValue')), [],
    'a blank credential reference is not committed')
})

test('the FORM body always names its target, never the previously selected server', () => {
  const add = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ mode: 'add', name: '', nameEditable: true, dirty: true }),
  }))
  const addFrame = render(add.page, 120, 20).join('\n')
  const addIdentity = addFrame.split('\n').find(line => /· Add ·/u.test(line)) ?? ''
  assert.match(addIdentity, /\(unnamed\) · Add · new user server/u, `the Add target must be named: ${addIdentity}`)
  assert.doesNotMatch(addIdentity, /alpha/u, 'the old selection must not be presented as the Add target')

  const edit = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  const editFrame = render(edit.page, 120, 20).join('\n')
  const editIdentity = editFrame.split('\n').find(line => /· Edit ·/u.test(line)) ?? ''
  assert.match(editIdentity, /alpha · Edit · /u, `the Edit target must be named: ${editIdentity}`)
})

test('a form-row click only SELECTS; the explicit field verb runs the intent', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
  }))
  openEditor(page, 'e')
  const lines = render(page, 100, 20)
  const mouseBase = { button: 'left' as const, screenX: 1, screenY: 1, shift: false, alt: false, ctrl: false }
  // Find the painted "Transport" row (its explicit verb switches transport).
  const transportLine = lines.findIndex(line => line.includes('Transport:'))
  assert.ok(transportLine >= 0)
  page.handleMouse({ ...mouseBase, type: 'press', x: 2, y: transportLine, width: 100, height: 19 })
  page.handleMouse({ ...mouseBase, type: 'click', x: 2, y: transportLine, width: 100, height: 19 })
  assert.equal(controller.calls.includes('setTransport'), false,
    'a row click only selects the field')
  const selected = render(page, 100, 20).join('\n')
  assert.match(selected, /> Transport:/u, 'the clicked row is now the focused field')
  // The complete explicit verb is a real delegated span and runs the intent.
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:activate-field:transport'),
    'the focused field publishes its complete verb')
  page.activateBarSpan('bar:activate-field:transport')
  assert.ok(controller.calls.includes('setTransport'), 'the explicit verb runs the Enter intent')

  // A press whose frame repaints before the release never completes.
  controller.calls.length = 0
  const refreshed = render(page, 100, 18)
  const transportAgain = refreshed.findIndex(line => line.includes('Transport:'))
  assert.ok(transportAgain >= 0)
  page.handleMouse({ ...mouseBase, type: 'press', x: 2, y: transportAgain, width: 100, height: 17 })
  render(page, 100, 17)
  page.handleMouse({ ...mouseBase, type: 'click', x: 2, y: transportAgain, width: 100, height: 17 })
  assert.deepEqual(controller.calls, [], 'a stale press never activates a field')
})

test('a pointer cannot change the draft while a confirmation owns the page', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page, 'e')
  controller.calls.length = 0
  // The user presses `s`: the disclosure question opens over the SAME draft but
  // takes the whole body; no form field is painted or targetable behind it.
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: { question: 1, kind: 'save', name: 'alpha', warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }
  const frame = render(page, 100, 20).join('\n')
  assert.doesNotMatch(frame, /Transport:/u, 'the full-width question hides the form body')
  const mouse = { button: 'left' as const, screenX: 1, screenY: 1, width: 100, height: 19, shift: false, alt: false, ctrl: false }
  page.handleMouse({ ...mouse, type: 'press', x: 2, y: 0 })
  page.handleMouse({ ...mouse, type: 'click', x: 2, y: 0 })
  assert.deepEqual(controller.calls, [], 'no draft mutation may bypass the open confirmation')
  assert.equal(page.handleMouse({ ...mouse, type: 'click', x: 2, y: 0 }), undefined)

  // After the question is answered, the SAME field click selects again
  // (positive control: the lock is the modal, not a broken mouse path).
  const plain = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(plain.page, 'e')
  const plainLines = render(plain.page, 100, 20)
  const plainTransport = plainLines.findIndex(line => line.includes('Transport:'))
  plain.page.handleMouse({ ...mouse, type: 'press', x: 2, y: plainTransport })
  plain.page.handleMouse({ ...mouse, type: 'click', x: 2, y: plainTransport })
  assert.match(render(plain.page, 100, 20).join('\n'), /> Transport:/u,
    'a non-modal field click still selects')
})

test('a delegated last-row span reaches the page through the Root seam', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  render(page, 100, 20)
  // The Root registers what paintedBarSpans() publishes; releasing one must
  // run the SAME intent the painted affordance names.
  const spans = page.paintedBarSpans()
  assert.ok(spans.some(span => span.id === 'bar:add'), `the Add span must be published: ${spans.map(s => s.id).join(',')}`)
  page.activateBarSpan('bar:add')
  assert.ok(controller.calls.includes('beginAdd'), `the delegated Add must run the intent: ${controller.calls.join(',')}`)
})

test('the page-local bar targets and the Root seam publish the same affordances', () => {
  const { page } = makePage(snapshot({ selectedConfig: CONFIG_FACET, config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  const lines = render(page, 100, 20)
  // A page-local click still works through the child's own hit map…
  const mouse = { button: 'left' as const, screenX: 1, screenY: 1, shift: false, alt: false, ctrl: false }
  const y = lines.findIndex(line => line.includes('Add [A]'))
  assert.ok(y >= 0)
  const col = (lines[y] ?? '').indexOf('Add [A]') + 1
  page.handleMouse({ ...mouse, type: 'press', x: col, y, width: 100, height: 19 })
  page.handleMouse({ ...mouse, type: 'click', x: col, y, width: 100, height: 19 })
  // …and the published spans match the bar segments that really painted.
  render(page, 100, 20)
  const published = page.paintedBarSpans().map(span => span.id)
  assert.equal(published.includes('bar:back'), false, 'Esc is the ONE Root-owned target, never a delegated duplicate')
  assert.ok(page.paintedEscapeSpan() !== undefined, 'the painted Esc span is published to the Root')
  assert.ok(published.includes('bar:save'), `the form's non-Esc spans publish: ${published.join(',')}`)
})

test('the Save disclosure lives in the body at 44 columns, not only in the bar', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page, 'e', 44, 8)
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: { question: 1, kind: 'save', name: 'a'.repeat(32), warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }
  const frame = render(page, 44, 8).join('\n')
  // The complete safety fact is painted in the body (wrapped), even though the
  // 32-character name and the narrow bar cannot hold it.
  assert.match(frame, /execute an external\s+command\./u, `the capability must be in the body: ${frame}`)
  // The decision keys survive even when the question segment drops.
  assert.match(frame, /Confirm \[Y\]/u, `the affirmative key must survive: ${frame}`)
  assert.match(frame, /Esc/u)
  // POSITIVE control: at 44x8 the whole fact set fits, so `y` really dispatches.
  page.handleInput('y')
  assert.ok(controller.calls.includes('answerConfigConfirm:true'),
    `a fully reviewed confirmation must be accepted: ${controller.calls.join(',')}`)

  // NEGATIVE control on the same frame budget: when the granted rows cannot show
  // the facts, no affirmative key is painted and `y` is refused.
  const small = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(small.page, 'e', 44, 3)
  small.controller.snapshotValue = {
    ...small.controller.snapshotValue,
    configConfirm: { question: 1, kind: 'save', name: 'a'.repeat(32), warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }
  const smallFrame = render(small.page, 44, 3).join('\n')
  assert.doesNotMatch(smallFrame, /Confirm \[Y\]/u, `no affirmative key on an unreviewable frame: ${smallFrame}`)
  assert.match(smallFrame, /Resize to review/u)
  small.page.handleInput('y')
  assert.deepEqual(small.controller.calls.filter(call => call.startsWith('answerConfigConfirm')), [],
    'an unreviewable confirmation must refuse the key')
})

test('the narrow form keeps the target identity at every width', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ mode: 'add', name: 'a'.repeat(32), nameEditable: true, dirty: true }),
  }))
  for (const width of [44, 72, 80, 120]) {
    const lines = render(page, width, 12)
    const frame = lines.join('\n')
    assert.match(frame, new RegExp('a'.repeat(32)), `width ${String(width)}: the name must survive: ${frame}`)
    const identity = lines.find(line => /· Add\b/u.test(line)) ?? ''
    assert.match(identity, /a{6}/u, `width ${String(width)}: the identity names the add target: ${identity}`)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${String(width)}: no line may overflow`)
  }
})

test('the value input hint states what an empty Enter really does per storage form', () => {
  const literalPage = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ env: [{ key: 'E', value: 'stored' }], dirty: true }),
  }))
  literalPage.controller.formValue = 'literal'
  openEditor(literalPage.page, 'e')
  for (let step = 0; step < 14; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(literalPage.page, 100, 20).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim() === 'Env E') break
    literalPage.page.handleInput('\x1b[B')
  }
  literalPage.page.handleInput('\r')
  const literalFrame = render(literalPage.page, 100, 20).join('\n')
  assert.match(literalFrame, /Enter on empty sets it empty/u,
    `a literal must state that an empty Enter clears: ${literalFrame}`)
  assert.doesNotMatch(literalFrame, /blank keeps current/u)

  const referencePage = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ env: [{ key: 'E', value: '${credential:E}' }], dirty: true }),
  }))
  referencePage.controller.formValue = 'reference'
  openEditor(referencePage.page, 'e')
  for (let step = 0; step < 14; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(referencePage.page, 100, 20).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim() === 'Env E') break
    referencePage.page.handleInput('\x1b[B')
  }
  referencePage.page.handleInput('\r')
  const referenceFrame = render(referencePage.page, 100, 20).join('\n')
  assert.match(referenceFrame, /Enter on empty keeps current/u,
    `a reference must state that an empty Enter keeps the value: ${referenceFrame}`)
})

test('a Detail confirmation (toggle) paints its consequence body and blocks when it cannot fit', () => {
  // The Detail hosts the Toggle/Delete/Reset/Restart confirmations. The
  // confirmation body is painted at the TOP of the Detail, so the user reads
  // the target and consequence before reaching the `Confirm [Y]` bar.
  const wide = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'toggle', name: 'alpha', nextEnabled: false, capturedRevision: 1 },
  }))
  // A user reached the Detail before the question opened; the view is detail.
  ;(wide.page as unknown as { view: string }).view = 'detail'
  const wideFrame = render(wide.page, 100, 24).join('\n')
  assert.match(wideFrame, /Disable server alpha\./u, 'the toggle consequence is painted in the Detail body')
  assert.match(wideFrame, /may stop/u)
  assert.match(wideFrame, /Confirm \[Y\]/u)

  // At 44x5 the fact set still fits its 4 body rows, so it stays confirmable.
  const fits = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'toggle', name: 'a'.repeat(32), nextEnabled: false, capturedRevision: 1 },
  }))
  ;(fits.page as unknown as { view: string }).view = 'detail'
  const fitsFrame = render(fits.page, 44, 5).join('\n')
  assert.match(fitsFrame, /may stop/u, 'the whole consequence is visible at 44x5')
  assert.match(fitsFrame, /Confirm \[Y\]/u, 'a fully visible confirmation stays executable')

  // A grant that cannot show the whole consequence paints NO affirmative key
  // and says why: the admission is the VISIBLE content, not the wrap result.
  const tiny = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'toggle', name: 'a'.repeat(32), nextEnabled: false, capturedRevision: 1 },
  }))
  ;(tiny.page as unknown as { view: string }).view = 'detail'
  const tinyFrame = render(tiny.page, 44, 3).join('\n')
  assert.doesNotMatch(tinyFrame, /Confirm \[Y\]/u, 'an unreviewable confirmation paints no affirmative key')
  assert.match(tinyFrame, /Resize to review/u)
  assert.match(tinyFrame, /Esc/u)
})

test('a fully painted long HTTP host is NOT blocked (the split inserted no space)', () => {
  const host = 'a'.repeat(63)
  const warning = `Enabling this server can send data to an external service. Target: ${host}`
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ transport: 'streamable-http', dirty: true }) }))
  openEditor(page, 'e', 44, 20)
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: { question: 1, kind: 'save', name: 'svc', warning, capturedRevision: 1 },
  }
  const lines = render(page, 44, 20).map(line => line.trimEnd())
  const frame = lines.join('\n')
  // The host is fully painted, split across two lines by the hard wrap…
  const joined = lines.map(line => line.trim()).join('')
  assert.ok(joined.includes(host), `the whole 63-character host must be painted:\n${frame}`)
  // …so the decision is executable, not blocked.
  assert.doesNotMatch(frame, /Resize to review/u, 'a fully painted long host must not be blocked')
  assert.match(frame, /Confirm \[Y\]|\by\b/u)
})

test('the input-mode bar commits through the SAME path as the keyboard Enter', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ env: [{ key: 'E', value: 'stored' }], dirty: true }),
  }))
  controller.formValue = 'literal'
  openEditor(page, 'e')
  for (let step = 0; step < 14; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(page, 100, 20).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim() === 'Env E') break
    page.handleInput('\x1b[B')
  }
  page.handleInput('\r')
  // The input bar publishes `Apply [Enter]` as a real pointer intent; the spans
  // are captured from the frame that really painted the input.
  render(page, 100, 20)
  const spans = page.paintedBarSpans()
  assert.ok(spans.some(span => span.id === 'bar:apply-input'),
    `the apply affordance must be published: ${spans.map(s => s.id).join(',')}`)
  // Activating it runs the SAME commit the keyboard Enter does.
  page.activateBarSpan('bar:apply-input')
  assert.ok(controller.calls.includes('setDictValue:env:E=:literal'),
    `the apply intent must commit the value: ${controller.calls.join(',')}`)
})

test('a discard whose fact set cannot be painted refuses `d` like any other confirmation', () => {
  // Generous grant: the discard body fits, so `d` really drops the draft.
  const roomy = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(roomy.page, 'e', 100, 20)
  roomy.page.handleInput('\x1b')
  const roomyFrame = render(roomy.page, 100, 20).join('\n')
  assert.match(roomyFrame, /nothing has been written yet/u, 'the discard body states what is dropped')
  assert.match(roomyFrame, /Discard \[D\] · Keep \[Esc\]/u, 'the complete decision is painted')
  roomy.page.handleInput('d')
  assert.ok(roomy.controller.calls.includes('discardEditor'), 'a fully visible discard is executable')

  // A grant too small for the fact set: no affirmative affordance and `d` is
  // refused — the bar offers only the real Keep.
  const tight = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(tight.page, 'e', 44, 2)
  tight.page.handleInput('\x1b')
  const tightFrame = render(tight.page, 44, 2).join('\n')
  assert.doesNotMatch(tightFrame, /Discard \[D\]/u,
    `no executable discard affordance on an unreviewable frame: ${tightFrame}`)
  assert.match(tightFrame, /Resize to review/u)
  tight.page.handleInput('d')
  assert.deepEqual(tight.controller.calls.filter(call => call === 'discardEditor'), [],
    'an unreviewable discard must refuse `d`')
})

test('an active form input owns the body: a pointer cannot switch fields behind it', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page, 'e', 100, 20)
  // Focus the Command row (an Edit's Name is read-only) and open its input.
  for (let step = 0; step < 6; step += 1) {
    const focused = /> ([^:\n]+):/u.exec(render(page, 100, 20).join('\n'))
    if (focused !== null && (focused[1] ?? '').trim().startsWith('Command')) break
    page.handleInput('\x1b[B')
  }
  page.handleInput('\r')
  render(page, 100, 20)
  const lines = render(page, 100, 20)
  const transportLine = lines.findIndex(line => line.includes('Transport:'))
  assert.ok(transportLine >= 0)
  const mouse = { button: 'left' as const, screenX: 1, screenY: 1, shift: false, alt: false, ctrl: false }
  controller.calls.length = 0
  // A body row click must be refused while the input owns the page…
  page.handleMouse({ ...mouse, type: 'press', x: 2, y: transportLine, width: 100, height: 19 })
  page.handleMouse({ ...mouse, type: 'click', x: 2, y: transportLine, width: 100, height: 19 })
  assert.deepEqual(controller.calls, [], 'the input modal owns the body for the pointer too')

  // …while its OWN apply/cancel spans stay reachable.
  const spans = page.paintedBarSpans().map(span => span.id)
  assert.ok(spans.includes('bar:apply-input'), `the input bar publishes apply: ${spans.join(',')}`)
  assert.equal(spans.includes('bar:cancel'), false, 'Cancel is the ONE Root-owned Esc target')
  assert.ok(page.paintedEscapeSpan() !== undefined, 'the input bar publishes its Esc span to the Root')
})

test('a question that has not painted yet is not executable (no cross-question authorisation)', () => {
  // A question can open in state and be answered before its frame paints. The
  // verdict is bound to the PAINTED identity, so `y` must be refused then —
  // the previous frame's admission (no modal → false) must not carry over.
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page, 'e', 100, 20)
  controller.calls.length = 0
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: { question: 1, kind: 'save', name: 'alpha', warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }
  // No render between opening the question and the answer.
  page.handleInput('y')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('answerConfigConfirm')), [],
    'an unpainted question must refuse its answer')

  // After the frame paints the same answer is accepted.
  const frame = render(page, 100, 20).join('\n')
  assert.match(frame, /can execute an external command/u)
  page.handleInput('y')
  assert.ok(controller.calls.includes('answerConfigConfirm:true'),
    `a painted question accepts the answer: ${controller.calls.join(',')}`)

  // The decisive case: a PREVIOUS question already painted (so an admission
  // exists), then a DIFFERENT question opens and is answered before painting.
  // The old admission must not authorise the new question.
  const second = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(second.page, 'e', 100, 20)
  second.controller.snapshotValue = {
    ...second.controller.snapshotValue,
    configConfirm: { question: 1, kind: 'toggle', name: 'alpha', nextEnabled: false, capturedRevision: 1 },
  }
  render(second.page, 100, 20) // the toggle question paints → admitted
  second.controller.calls.length = 0
  // A different question replaces it without a repaint between.
  second.controller.snapshotValue = {
    ...second.controller.snapshotValue,
    configConfirm: { question: 2, kind: 'delete', name: 'alpha', capturedRevision: 1 },
  }
  second.page.handleInput('y')
  assert.deepEqual(second.controller.calls.filter(call => call.startsWith('answerConfigConfirm')), [],
    'a NEW unpainted question must not reuse the previous admission')
})

test('a blocked question refuses both the key and the pointer confirm intent', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page, 'e', 44, 3)
  controller.calls.length = 0
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: { question: 1, kind: 'save', name: 'a'.repeat(32), warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }
  const frame = render(page, 44, 3).join('\n')
  assert.match(frame, /Resize to review/u)
  page.handleInput('y')
  page.activateBarSpan('bar:confirm')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('answerConfigConfirm')), [],
    'a blocked question accepts neither input path')
})

test('a grant with no body rows can never confirm: nothing was painted to review', () => {
  // 200x1 is a TRUE zero-body grant: only the one truthful bar row remains.
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
    configConfirm: { question: 1, kind: 'save', name: 'a', warning: 'Short.', capturedRevision: 1 },
  }))
  // The editor is open before the question arrives (as a user's would be).
  openEditor(page, 'e', 100, 20)
  controller.calls.length = 0
  const lines = render(page, 200, 1)
  const frame = lines.join('\n')
  assert.equal(lines.length, 1, 'a zero-row grant paints exactly the physical bar')
  assert.doesNotMatch(frame, /Short\./u, `the fact cannot be painted in a zero-row body: ${frame}`)
  assert.doesNotMatch(frame, /Confirm \[Y\]/u, `a zero-row grant paints no affirmative key: ${frame}`)
  assert.match(frame, /Cancel \[Esc\]/u, 'the real cancel stays the only decision')
  page.handleInput('y')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('answerConfigConfirm')), [],
    'a zero-row grant must refuse the answer')
})

test('a reopened discard needs a new painted admission for both keyboard and pointer', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  openEditor(page)
  page.handleInput('\x1b')
  render(page, 100, 16)
  page.handleInput('\x1b') // keep editing
  page.handleInput('\x1b') // reopen before another paint
  page.handleInput('d')
  page.activateBarSpan('bar:discard') // the previous frame's target is stale too
  assert.equal(controller.calls.includes('discardEditor'), false)
  render(page, 100, 16)
  page.handleInput('d')
  assert.equal(controller.calls.includes('discardEditor'), true)
})

/* ────────────────────────────────────────────────────────────────────────── *
 * PR-D D2: the editor wheel and the per-field Remove affordance.
 * ────────────────────────────────────────────────────────────────────────── */

/** Walk the form focus with the keyboard Down until the frame matches. */
function focusUntil(page: McpServersPage, width: number, rows: number, predicate: (frame: string) => boolean): void {
  for (let step = 0; step < 40; step += 1) {
    if (predicate(render(page, width, rows).join('\n'))) return
    page.handleInput('\x1b[B')
  }
  assert.fail(`the form focus never reached the expected row:\n${render(page, width, rows).join('\n')}`)
}

/** Walk the form focus with the WHEEL until the frame matches. */
function wheelFocusUntil(page: McpServersPage, width: number, rows: number, predicate: (frame: string) => boolean): void {
  for (let step = 0; step < 40; step += 1) {
    if (predicate(render(page, width, rows).join('\n'))) return
    page.handleMouse({ ...mouseBase(width, rows), type: 'wheel', wheelDelta: 1, x: 2, y: 2 })
  }
  assert.fail(`the wheel never reached the expected form row:\n${render(page, width, rows).join('\n')}`)
}

test('the editor wheel moves only the current form focus, never the hidden list selection or detail', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--one'], dirty: true }),
  }))
  // The WIDE layout still holds the list model behind the whole-page form.
  openEditor(page, 'e', 120, 24)
  const base = mouseBase(120, 24)
  assert.match(render(page, 120, 24).join('\n'), /> Name:/u, 'the focus starts on the first field')
  // The LEFT region (where the hidden list would live) moves the FORM focus.
  page.handleMouse({ ...base, type: 'wheel', wheelDelta: 1, x: 4, y: 5 })
  assert.match(render(page, 120, 24).join('\n'), /> Transport:/u,
    'the left-region wheel advances the form field')
  // The RIGHT region (where the hidden Detail would live) moves the FORM focus.
  page.handleMouse({ ...base, type: 'wheel', wheelDelta: 1, x: 100, y: 5 })
  assert.match(render(page, 120, 24).join('\n'), /> Enabled:/u,
    'the right-region wheel advances the form field')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('move:') || call.startsWith('select:')), [],
    'the wheel never moves the hidden list selection')
  assert.equal(controller.snapshotValue.selectedName, 'alpha', 'the hidden selection is untouched')
})

test('the short editor wheel reaches an off-screen field; the explicit Enter opens its intent', () => {
  for (const [width, rows] of [[44, 20], [44, 8]] as const) {
    const { page, controller } = makePage(snapshot({
      selectedConfig: CONFIG_FACET,
      editor: editorSnapshot({ args: ['--one', '--two', '--three'], dirty: true }),
    }))
    openEditor(page, 'e', width, rows)
    wheelFocusUntil(page, width, rows, frame => /> Arg 2:/u.test(frame))
    const lines = render(page, width, rows)
    const focusRow = lines.findIndex(line => line.includes('> Arg 2'))
    assert.ok(focusRow >= 0, `${width}x${rows}: the wheeled-to field must be painted`)
    controller.calls.length = 0
    // A body-row click only SELECTS the field; it never opens its editor.
    clickBodyCell(page, width, rows, focusRow)
    assert.doesNotMatch(render(page, width, rows).join('\n'), /edit: >/u,
      `${width}x${rows}: a row click never opens the field's input`)
    // The explicit Enter verb runs the same row intent.
    page.handleInput('\r')
    assert.match(render(page, width, rows).join('\n'), /edit: >/u,
      `${width}x${rows}: the explicit verb opened the field's own input`)
    page.handleInput('Z')
    page.handleInput('\r')
    assert.deepEqual(controller.calls.filter(call => call.startsWith('setArg')), [`setArg:1=--twoZ`],
      `${width}x${rows}: the input commit ran the row's own sink exactly once`)
  }
})

test('a painted Remove deletes exactly the focused removable row and writes nothing', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--flag'], env: [{ key: 'E', value: '${credential:E}' }], dirty: true }),
  }))
  openEditor(page, 'e', 100, 20)
  focusUntil(page, 100, 20, frame => /> Arg 1:/u.test(frame))
  const bar = render(page, 100, 20).at(-1) ?? ''
  assert.match(bar, /Remove \[Backspace\]/u, 'the removable row advertises Remove')
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:remove-form-row'))
  controller.calls.length = 0
  clickBarSpan(page, 'bar:remove-form-row', 100, 20)
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeArg')), ['removeArg:0'],
    'only the focused argument row is removed')
  assert.deepEqual(
    controller.calls.filter(call => call.startsWith('set') || call === 'saveEditor' || call.startsWith('removeDict')),
    [],
    'nothing else is touched and no Host write runs',
  )
  // The original keyboard Backspace stays the same sink on the same row.
  page.handleInput('\x7f')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeArg')), ['removeArg:0', 'removeArg:0'],
    'the keyboard Backspace removes the same focused row through the same intent')
})

test('an inherited key never paints or runs Remove, while a user-added key right beside it does', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({
      env: [{ key: 'BASE', value: 'base' }, { key: 'USER', value: '${credential:U}' }],
      dirty: true,
    }),
  }))
  // The real controller refuses removal of exactly the base-owned key.
  controller.canRemoveDictKey = (_field: string, key: string) => key !== 'BASE'
  openEditor(page, 'e', 100, 32)
  focusUntil(page, 100, 32, frame => /> Env key: BASE · Inherited/u.test(frame))
  const inheritedBar = render(page, 100, 32).at(-1) ?? ''
  assert.doesNotMatch(inheritedBar, /Remove/u, 'an inherited key offers no Remove affordance')
  assert.equal(page.paintedBarSpans().some(span => span.id === 'bar:remove-form-row'), false)
  controller.calls.length = 0
  // Even a forged activation of the absent span runs nothing.
  page.activateBarSpan('bar:remove-form-row')
  page.handleInput('\x7f')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeDict')), [],
    'the inherited key is never removed')
  // The user-added key beside it paints Remove and removes ONLY that key.
  focusUntil(page, 100, 32, frame => /> Env key: USER/u.test(frame))
  const userBar = render(page, 100, 32).at(-1) ?? ''
  assert.match(userBar, /Remove/u)
  controller.calls.length = 0
  clickBarSpan(page, 'bar:remove-form-row', 100, 32)
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeDict')), ['removeDict:env:USER'])
})

test('Remove is absent while an input, a discard prompt or a save owns the editor', () => {
  // (a) the active input bar is the input's own decision surface.
  const input = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--flag'], dirty: true }),
  }))
  openEditor(input.page, 'e', 100, 20)
  focusUntil(input.page, 100, 20, frame => /> Arg 1:/u.test(frame))
  input.page.handleInput('\r')
  const inputBar = render(input.page, 100, 20).at(-1) ?? ''
  assert.match(inputBar, /Apply \[Enter\]/u)
  assert.doesNotMatch(inputBar, /Remove/u)
  // (b) an unsettled Save freezes the draft and offers no Remove.
  const saving = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--flag'], dirty: true }),
    configStatus: { kind: 'saving', text: 'Saving configuration…' },
  }))
  openEditor(saving.page, 'e', 100, 20)
  const savingBar = render(saving.page, 100, 20).at(-1) ?? ''
  assert.match(savingBar, /Saving configuration/u)
  assert.doesNotMatch(savingBar, /Remove/u)
  // (c) the discard question owns the decision surface.
  const discard = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--flag'], dirty: true }),
  }))
  openEditor(discard.page, 'e', 100, 20)
  discard.page.handleInput('\x1b')
  const discardBar = render(discard.page, 100, 20).at(-1) ?? ''
  assert.match(discardBar, /Discard/u)
  assert.doesNotMatch(discardBar, /Remove/u)
})

test('a wheel between the Remove press and its release never removes', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--flag'], dirty: true }),
  }))
  openEditor(page, 'e', 100, 20)
  focusUntil(page, 100, 20, frame => /> Arg 1:/u.test(frame))
  const span = page.paintedBarSpans().find(candidate => candidate.id === 'bar:remove-form-row')
  assert.ok(span !== undefined)
  const base = mouseBase(100, 20)
  page.handleMouse({ ...base, type: 'press', x: span.startCol, y: 19 })
  page.handleMouse({ ...base, type: 'wheel', wheelDelta: 1, x: 2, y: 3 })
  render(page, 100, 20)
  page.handleMouse({ ...base, type: 'click', x: span.startCol, y: 19 })
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeArg')), [],
    'a wheel-revoked Remove press never removes')
  // A fresh complete click is the positive control and removes once.
  page.handleInput('\x1b[A') // back to the Arg 1 row the wheel moved off
  render(page, 100, 20)
  clickBarSpan(page, 'bar:remove-form-row', 100, 20)
  assert.deepEqual(controller.calls.filter(call => call.startsWith('removeArg')), ['removeArg:0'])
})

test('44 columns keeps the COMPLETE Remove [Backspace] beside Save and Back for a removable row', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['--flag'], dirty: true }),
  }))
  openEditor(page, 'e', 44, 20)
  wheelFocusUntil(page, 44, 20, frame => /> Arg 1:/u.test(frame))
  const bar = render(page, 44, 20).at(-1) ?? ''
  // The layout drops the BROWING hints first and keeps the three actions whole.
  assert.match(bar, /Save \[S\]/u)
  assert.match(bar, /Remove \[Backspace\]/u, `the full Remove literal must survive: ${bar}`)
  assert.match(bar, /Back \[Esc\]/u)
  assert.doesNotMatch(bar, /Enter edit|Tab next|↑\/↓ field/u, 'the browsing hints yield first')
  assert.ok(visibleWidth(bar) <= 44, `no overflow at 44 columns: ${bar}`)
  assert.ok(page.paintedBarSpans().some(span => span.id === 'bar:remove-form-row'),
    'the complete Remove is a real target')
})

test('a long status wraps whole and the Detail can scroll a long name and last error', () => {
  const name = 'server-with-a-very-long-name-that-must-wrap-fully'
  const tail = 'final-diagnostic-tail'
  const { page } = makePage(snapshot({
    rows: [{
      name,
      configured: true,
      status: { state: 'failed', reason: 'unclosed-generation', lastError: `${'diagnostic '.repeat(12)}${tail}` },
      source: 'Configured',
    }],
    selectedName: name,
  }))
  const list = render(page, 34, 10)
  const listFrame = list.join('\n')
  // The official status is never abbreviated into a different word; it wraps
  // into the item's own extra physical line.
  assert.match(listFrame, /Failed \(unclosed/u)
  assert.match(listFrame, /generation\)/u)
  assert.doesNotMatch(listFrame, /Failed \(unclosed gen/u)
  for (const line of list) assert.ok(visibleWidth(line) <= 34)
  // Detail carries the WHOLE name and the scrollable last error.
  page.handleInput('\r')
  const detail = render(page, 34, 10)
  const joined = detail.join('\n')
  assert.match(joined.replace(/\s+/gu, ' '), /Server: server-with-a-very-long-na me-that-must-wrap-fully/u)
  assert.match(joined, /Last error: diagnostic/u)
  for (let step = 0; step < 30; step += 1) {
    page.handleInput('\x1b[B')
    if (render(page, 34, 10).join('\n').includes(tail)) break
  }
  assert.match(render(page, 34, 10).join('\n'), new RegExp(tail, 'u'),
    'the full diagnostic is reachable through the real physical scroll')
})

test('a narrow Detail keeps every dropped action reachable through the body', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 44, 16)
  page.handleInput('\r')
  const lines = render(page, 44, 16)
  const frame = lines.join('\n')
  // The frozen bar cannot hold the secondary actions whole at 44 cells; their
  // complete labels move into the scrollable body with the SAME intents.
  assert.match(frame, /Actions/u, `the body carries the dropped actions: ${frame}`)
  assert.match(frame, /Enable\/Disable \[T\]/u)
  const row = lines.findIndex(line => line.includes('Enable/Disable [T]'))
  assert.ok(row >= 0)
  controller.calls.length = 0
  clickBodyCell(page, 44, 16, row)
  assert.deepEqual(controller.calls, ['beginToggle'], 'the body fallback uses the bar action sink once')
})

test('a dual child grant names BOTH local regions with the one active device', () => {
  const { page } = makePage(snapshot())
  page.setWebWorkbenchGrant({ width: 80, rows: 21, barWidth: 80, allowDual: true })
  page.render(80)
  const listHeader = stripTerminalSequences(page.paneHeader(80))
  assert.match(listHeader, /\[MCP servers \(2\)\]/u)
  assert.match(listHeader, /Details/u)
  assert.doesNotMatch(listHeader, /\[Details\]/u, 'the List owns the active device while it is the current region')
  assert.ok(visibleWidth(listHeader) <= 80)
  page.handleInput('\r')
  page.render(80)
  const detailHeader = stripTerminalSequences(page.paneHeader(80))
  assert.match(detailHeader, /MCP servers \(2\)/u)
  assert.match(detailHeader, /\[Details\]/u, 'the Detail owns the active device after Open')
  assert.ok(visibleWidth(detailHeader) <= 80)
})

test('an unconfirmed outcome is never silently abandoned from the browse frame', () => {
  let done = 0
  const { page, controller } = makePage(snapshot({
    configStatus: { kind: 'unconfirmed', text: 'Outcome unconfirmed; inspect the Host configuration before retrying' },
    configOutcomeUnconfirmed: true,
  }), () => { done += 1 })
  render(page, 100, 14)
  page.handleInput('\x1b')
  const warning = render(page, 100, 14).join('\n')
  assert.match(warning, /Outcome unconfirmed/u)
  assert.match(warning, /Refresh \[R\]/u)
  assert.match(warning, /Leave \[D\]/u)
  assert.match(warning, /Keep \[Esc\]/u)
  page.handleInput('\x1b')
  assert.equal(done, 0, 'Esc keeps the warning open, never leaves')
  page.handleInput('\x1b')
  render(page, 100, 14)
  page.handleInput('d')
  assert.equal(done, 1, 'only the explicit leave, after its warning repainted, closes the page')
  assert.equal(controller.calls.includes('refresh'), false, 'leaving does not replay the unknown write')
  assert.equal(controller.calls.some(call => /save|toggle|delete|reset|restart/u.test(call)), false)
})

test('an unconfirmed form Back warns before discarding local edits', () => {
  let done = 0
  const { page, controller } = makePage(snapshot({
    editor: editorSnapshot({ dirty: true }),
    configStatus: { kind: 'unconfirmed', text: 'Outcome unconfirmed; inspect the Host configuration before retrying' },
    configOutcomeUnconfirmed: true,
  }), () => { done += 1 })
  render(page, 100, 14)
  page.handleInput('\x1b')
  const warning = render(page, 100, 14).join('\n')
  assert.match(warning, /Leave form\? The change may have been applied/u)
  assert.match(warning, /Discard \[D\]/u)
  assert.match(warning, /Keep \[Esc\]/u)
  page.handleInput('d')
  assert.equal(done, 0, 'the page stays open after dropping only the local draft')
  assert.equal(controller.calls.includes('discardEditor'), true)
  assert.equal(controller.calls.some(call => /save|toggle|delete|reset|restart/u.test(call)), false)
  const after = render(page, 100, 14).join('\n')
  assert.match(after, /Outcome unconfirmed/u, 'the prior receipt remains visible')
})

test('a body verb painted inside a focused form row activates instead of selecting', () => {
  const { page } = makePage(snapshot({
    editor: editorSnapshot(),
    config: { kind: 'ready', generation: {}, revision: 3, entries: [] },
  }))
  // Focus is already covered by the navigation cases; pin the Arg 1 row here
  // so this case isolates the overlapping hit target.
  ;(page as unknown as { formFocus: number }).formFocus = 6
  const lines = render(page, 44, 20)
  const row = lines.findIndex(line => /Arg 1:/u.test(line) && /Edit \[Enter\]/u.test(line))
  const suffix = row < 0 ? -1 : lines[row]!.indexOf('Edit [Enter]')
  assert.ok(row >= 0 && suffix >= 0, `the narrow bar must drop the Arg 1 body verb:\n${lines.join('\n')}`)
  const base = mouseBase(44, 20)
  page.handleMouse({ ...base, type: 'press', x: suffix + 1, y: row })
  page.handleMouse({ ...base, type: 'click', x: suffix + 1, y: row })
  const after = render(page, 44, 20).join('\n')
  assert.match(after, /^edit:/mu, `the suffix must open the explicit input, not just select the row:\n${after}`)
})


test('an Edit target removed while its form is open returns to the List, not a fallback Detail', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  openEditor(page, 'e', 100, 16)
  const before = controller.snapshotValue
  // The target disappears while the user is still in its form; the controller
  // moves its selection to the nearest remaining server.
  controller.snapshotValue = {
    ...before,
    rows: before.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
    selectedConfig: undefined,
    editor: editorSnapshot({ dirty: true }),
  }
  page.handleInput('\x1b')
  render(page, 100, 16)
  page.handleInput('d')
  const frame = render(page, 100, 16).join('\n')
  assert.doesNotMatch(frame, /Server: beta/u, 'a fallback server must not inherit the lost Edit target Detail')
  assert.match(frame, /Name/u, 'the page must return to the List')
})

test('a confirmed Delete returns to the List once the removed target is proven gone', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }))
  render(page, 100, 16)
  page.handleInput('y')
  assert.deepEqual(controller.calls.filter(call => call === 'answerConfigConfirm:true'), ['answerConfigConfirm:true'])
  // The dispatch settlement is asynchronous: a pre-dispatch/saving render still
  // has the target listed and must not discard the removal intent.
  render(page, 100, 16)
  const before = controller.snapshotValue
  controller.snapshotValue = {
    ...before,
    configConfirm: undefined,
    rows: before.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
    selectedConfig: undefined,
    configStatus: { kind: 'saved', text: 'Config removed · waiting for Host reconcile' },
  }
  const frame = render(page, 100, 16).join('\n')
  assert.doesNotMatch(frame, /Server: beta/u, 'the fallback Detail must not become the deleted target')
  assert.match(frame, /Config removed/u, 'the List keeps the honest receipt')
  assert.match(frame, /waiting for Host reconcile/u, 'the narrow List receipt wraps instead of truncating')
})

test('every visible line of a wrapped form field is a selection target', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ command: `/bin/echo ${'z'.repeat(80)}`, dirty: true }),
  }))
  focusUntil(page, 44, 12, frame => /> Command:/u.test(frame))
  const lines = render(page, 44, 12)
  const row = lines.findIndex(line => /z{4,}/u.test(line) && !/Command:/u.test(line))
  assert.ok(row >= 0, `the wrapped command must paint a continuation line:\n${lines.join('\n')}`)
  clickBodyCell(page, 44, 12, row)
  assert.equal((page as unknown as { formFocus: number }).formFocus, 3,
    'a continuation line selects the Command field, not a blank row')
})

test('Add is a List action; the same key in Detail is inert', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  page.handleInput('\r')
  page.handleInput('a')
  assert.equal(controller.calls.includes('beginAdd'), false)
  assert.doesNotMatch(render(page, 100, 16).join('\n'), /· Add ·/u)
})

test('a long removable field puts its dropped verb on a reachable body line', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ args: ['z'.repeat(100)], dirty: true }),
  }))
  ;(page as unknown as { formFocus: number }).formFocus = 6
  const lines = render(page, 44, 20)
  const row = lines.findIndex(line => /^\s+Edit \[Enter\]/u.test(line))
  assert.ok(row >= 0, `the dropped verb must have a complete body line:\n${lines.join('\n')}`)
  const base = mouseBase(44, 20)
  page.handleMouse({ ...base, type: 'press', x: 3, y: row })
  page.handleMouse({ ...base, type: 'click', x: 3, y: row })
  assert.match(render(page, 44, 20).join('\n'), /^edit:/mu,
    'the standalone verb line invokes the same explicit input intent')
})

test('a saved Delete does not leave the Detail before the roster proves removal', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 100, 16)
  page.handleInput('\r')
  const detail = controller.snapshotValue
  controller.snapshotValue = {
    ...detail,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }
  render(page, 100, 16)
  page.handleInput('y')
  const before = controller.snapshotValue
  controller.snapshotValue = {
    ...before,
    configConfirm: undefined,
    configStatus: { kind: 'saved', text: 'Config removed · waiting for Host reconcile' },
  }
  render(page, 100, 16)
  assert.equal(pageRegion(page), 'detail', 'the exact Detail stays active while alpha is still listed')
  assert.match(render(page, 100, 16).join('\n'), /Server: alpha/u)
})

test('a Delete is bound to the exact entry token, not a same-name replacement', () => {
  const oldToken = {}
  const newToken = {}
  const { page, controller } = makePage(snapshot({
    rows: [
      { ...connected('alpha'), entryToken: oldToken },
      { ...connected('beta'), entryToken: {} },
    ],
    selectedConfig: CONFIG_FACET,
  }))
  render(page, 100, 16)
  page.handleInput('\r')
  const detail = controller.snapshotValue
  controller.snapshotValue = {
    ...detail,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }
  render(page, 100, 16)
  page.handleInput('y')
  const saving = controller.snapshotValue
  controller.snapshotValue = {
    ...saving,
    configConfirm: undefined,
    rows: [
      { ...connected('alpha'), entryToken: newToken },
      { ...connected('beta'), entryToken: {} },
    ],
    selectedName: 'alpha',
    configStatus: { kind: 'saved', text: 'Config removed · waiting for Host reconcile' },
  }
  render(page, 100, 16)
  assert.equal(pageRegion(page), 'list',
    'a same-name new token is NOT the deleted instance; the old Detail must return to the List')
})

test('a retired saved Delete never resurrects a stale success after roster removal', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 100, 16)
  page.handleInput('\r')
  const detail = controller.snapshotValue
  controller.snapshotValue = {
    ...detail,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }
  render(page, 100, 16)
  page.handleInput('y')
  const saving = controller.snapshotValue
  controller.snapshotValue = {
    ...saving,
    configConfirm: undefined,
    configStatus: { kind: 'saved', text: 'Config removed · waiting for Host reconcile' },
  }
  render(page, 100, 16)
  assert.equal(pageRegion(page), 'detail', 'the roster still lists alpha')
  // The controller retires its own receipt; the page must not preserve a
  // synthetic current Saved fact.
  controller.snapshotValue = { ...controller.snapshotValue, configStatus: undefined }
  render(page, 100, 16)
  controller.snapshotValue = {
    ...controller.snapshotValue,
    rows: controller.snapshotValue.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
    selectedConfig: undefined,
  }
  const frame = render(page, 100, 16).join('\n')
  assert.equal(pageRegion(page), 'list')
  assert.doesNotMatch(frame, /Config removed/u, 'a retired receipt is not re-created by the page')
})

test('an unconfirmed Delete with the target gone never paints a success receipt', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }))
  render(page, 100, 16)
  page.handleInput('y')
  const before = controller.snapshotValue
  controller.snapshotValue = {
    ...before,
    configConfirm: undefined,
    rows: before.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
    selectedConfig: undefined,
    configStatus: { kind: 'unconfirmed', text: 'Outcome unconfirmed; inspect the Host configuration before retrying' },
  }
  const frame = render(page, 100, 16).join('\n')
  assert.equal(pageRegion(page), 'list', 'the List is safe to browse after an unknown outcome')
  assert.match(frame, /Outcome unconfirmed/u, 'the truthful unknown receipt stays visible')
  assert.doesNotMatch(frame, /Config removed/u, 'a refused/unknown delete must never become a success')
  // Once the controller retires the unknown status there is still NO proof of
  // success, so no synthetic removal receipt may appear.
  controller.snapshotValue = { ...controller.snapshotValue, configStatus: undefined }
  assert.doesNotMatch(render(page, 100, 16).join('\n'), /Config removed/u,
    'a retired unknown status is not a saved Delete')
})

test('a same-name removed/re-added Edit target is not the old instance', () => {
  const oldToken = {}
  const newToken = {}
  const { page, controller } = makePage(snapshot({
    rows: [
      { ...connected('alpha'), entryToken: oldToken },
      { name: 'beta', configured: true, status: { state: 'disabled' }, source: 'Plugin-owned', entryToken: {} },
    ],
    selectedConfig: CONFIG_FACET,
  }))
  render(page, 100, 16)
  page.handleInput('\r')
  render(page, 100, 16)
  page.handleInput('e')
  render(page, 100, 16)
  assert.equal(controller.snapshotValue.editor?.entryToken, oldToken)
  const before = controller.snapshotValue
  controller.snapshotValue = {
    ...before,
    editor: undefined,
    rows: [
      { ...connected('alpha'), entryToken: newToken },
      { ...connected('beta'), entryToken: {} },
    ],
    selectedName: 'alpha',
    selectedConfig: CONFIG_FACET,
  }
  render(page, 100, 16)
  assert.equal(pageRegion(page), 'list',
    'a same-name replacement is a new instance; the old Edit must return to the List')
})

test('a clipped unknown-leave warning refuses affirmative Leave until its facts repaint', () => {
  let done = 0
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configOutcomeUnconfirmed: true,
  }), () => { done += 1 })
  render(page, 100, 16)
  page.handleInput('\x1b')
  // The warning has not painted yet: Leave cannot inherit a previous frame.
  page.handleInput('d')
  assert.equal(done, 0, 'an unpainted warning refuses Leave')
  const clipped = render(page, 44, 4).join('\n')
  assert.match(clipped, /Keep \[Esc\]/u)
  assert.doesNotMatch(clipped, /Leave \[D\]/u, 'a clipped warning must not publish the affirmative leave')
  page.handleInput('d')
  assert.equal(done, 0, 'the hidden decision is inert')
  const full = render(page, 100, 16).join('\n')
  assert.match(full, /Leave \[D\]/u)
  page.handleInput('d')
  assert.equal(done, 1, 'the freshly painted warning admits the explicit leave')
})

test('a form with no painted field publishes no Save or field verb and accepts no hidden edit', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot(),
  }))
  const empty = render(page, 100, 3).join('\n')
  assert.doesNotMatch(empty, /Save \[S\]|Edit \[Enter\]|Activate/u,
    'no field row is painted, so no field action is advertised')
  page.handleInput('s')
  assert.equal(controller.calls.includes('saveEditor'), false,
    'a hidden Save key must not reach the controller')
  const full = render(page, 100, 20).join('\n')
  assert.match(full, /Save \[S\]/u)
  page.handleInput('s')
  assert.equal(controller.calls.includes('saveEditor'), true)
})

test('a no-match filter hides the retained selection from Detail and pointer CRUD', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 120, 20)
  page.handleInput('/')
  for (const char of 'zzz') page.handleInput(char)
  page.handleInput('\r')
  const list = render(page, 120, 20).join('\n')
  assert.match(list, /No managed MCP servers match/u)
  page.handleInput('\t')
  const detail = render(page, 120, 20).join('\n')
  assert.match(detail, /Select a managed server/u)
  assert.doesNotMatch(detail, /Server: alpha|Delete \[D\]|Edit \[E\]/u,
    'a filtered-out selection has no facts or actionable verbs')
  page.handleInput('e')
  page.handleInput('d')
  assert.equal(controller.calls.some(call => /beginEdit|beginDelete/u.test(call)), false,
    'keyboard CRUD cannot target the hidden selection')
  const base = mouseBase(120, 20)
  page.handleMouse({ ...base, type: 'press', x: 40, y: 2 })
  page.handleMouse({ ...base, type: 'click', x: 40, y: 2 })
  assert.equal(controller.calls.some(call => /beginEdit|beginDelete/u.test(call)), false,
    'a pointer cannot revive the hidden target')
})

test('a pointer Refresh in the unknown-leave warning uses the same sink as R', () => {
  let done = 0
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configOutcomeUnconfirmed: true,
  }), () => { done += 1 })
  render(page, 100, 16)
  page.handleInput('\x1b')
  render(page, 100, 16)
  const refresh = page.paintedBarSpans().find(span => span.id.includes('refresh'))
  assert.ok(refresh !== undefined, 'the warning paints Refresh')
  page.activateBarSpan(refresh.id)
  assert.equal(controller.calls.includes('refresh'), true, 'the pointer runs the keyboard recovery intent')
  assert.equal(done, 0, 'Refresh never leaves the page')
})

test('List Back during a saving configuration stays mounted and never drops the receipt', () => {
  let done = 0
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configStatus: { kind: 'saving', text: 'Saving configuration…' },
  }), () => { done += 1 })
  render(page, 100, 16)
  page.handleInput('\x1b')
  assert.equal(done, 0, 'a dispatched write keeps the page mounted')
  assert.doesNotMatch(render(page, 100, 16).join('\n'), /Saving configuration…/u)
  controller.snapshotValue = { ...controller.snapshotValue, configStatus: undefined }
  render(page, 100, 16)
  page.handleInput('\x1b')
  assert.equal(done, 1)
})

test('a refused Delete return intent cannot redirect a different Detail target', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 100, 16)
  page.handleInput('\r')
  const detail = controller.snapshotValue
  controller.snapshotValue = {
    ...detail,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }
  render(page, 100, 16)
  page.handleInput('y')
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: undefined,
    configStatus: { kind: 'rejected', text: 'Not saved · the Host refused this write' },
  }
  render(page, 100, 16)
  // Move to beta and open its Detail after the old Delete was refused.
  controller.snapshotValue = {
    ...controller.snapshotValue,
    selectedName: 'beta',
    selectedConfig: { ...CONFIG_FACET, name: 'beta' },
  }
  render(page, 100, 16)
  page.handleInput('\r')
  render(page, 100, 16)
  assert.equal(pageRegion(page), 'detail')
  // A later removal of the old alpha target must not yank beta's Detail to List.
  controller.snapshotValue = {
    ...controller.snapshotValue,
    rows: controller.snapshotValue.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
    selectedConfig: { ...CONFIG_FACET, name: 'beta' },
  }
  const frame = render(page, 100, 16).join('\n')
  assert.equal(pageRegion(page), 'detail', 'the refused target is no longer a return owner')
  assert.match(frame, /Server: beta/u)
})

test('an input hidden by a short non-zero grant cannot stage text or Apply until it repaints', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot(),
  }))
  ;(page as unknown as { formFocus: number }).formFocus = 3
  render(page, 100, 20)
  page.handleInput('\r')
  render(page, 100, 20)
  page.handleInput('x')
  assert.match(render(page, 100, 20).join('\n'), /edit: > \/bin\/echox/u)
  const clipped = render(page, 100, 3).join('\n')
  assert.match(clipped, /Resize to review the input/u)
  assert.doesNotMatch(clipped, /Apply \[Enter\]/u)
  const input = (page as unknown as { formInput: { input: { getValue(): string } } }).formInput
  page.handleInput('y')
  page.handleInput('\r')
  assert.equal(input.input.getValue(), '/bin/echox', 'hidden typing is refused')
  assert.equal(controller.calls.some(call => call.startsWith('setField:command=')), false,
    'a hidden Enter cannot commit the staged input')
  const restored = render(page, 100, 20).join('\n')
  assert.match(restored, /edit: > \/bin\/echox/u, 'the same input value survives the resize')
  assert.match(restored, /Apply \[Enter\]/u)
  page.handleInput('\r')
  assert.equal(controller.calls.some(call => call.startsWith('setField:command=/bin/echox')), true)
})

test('a wide form paints the current field verb only once (bar, not duplicated body fallback)', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot(),
  }))
  ;(page as unknown as { formFocus: number }).formFocus = 3
  const frame = render(page, 100, 20).join('\n')
  assert.equal((frame.match(/Edit \[Enter\]/gu) ?? []).length, 1,
    'the bar primary is not duplicated by a body fallback')
})

test('a clipped warning pointer Refresh retires the warning through the real recovery sink', () => {
  let done = 0
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configOutcomeUnconfirmed: true,
    restartOutcomeUnconfirmed: true,
  }), () => { done += 1 })
  render(page, 100, 16)
  page.handleInput('\x1b')
  const clipped = render(page, 100, 3).join('\n')
  assert.doesNotMatch(clipped, /Leave \[D\]/u)
  const refresh = page.paintedBarSpans().find(span => span.id.includes('refresh'))
  assert.ok(refresh !== undefined, 'the wide bar still publishes the legal recovery')
  page.activateBarSpan(refresh.id)
  assert.equal(controller.calls.includes('refresh'), true)
  assert.equal(done, 0)
  assert.doesNotMatch(render(page, 100, 16).join('\n'), /Outcome unconfirmed/u,
    'the recovery transfer closes the warning')
})

test('a deliberate selection departure retires the saved Delete return intent before A is removed', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 120, 20)
  page.handleInput('\r')
  const detail = controller.snapshotValue
  controller.snapshotValue = {
    ...detail,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }
  render(page, 120, 20)
  page.handleInput('y')
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: undefined,
    configStatus: { kind: 'saved', text: 'Config removed · waiting for Host reconcile' },
  }
  render(page, 120, 20)
  assert.equal(pageRegion(page), 'detail', 'A is still listed while its delete saves')
  page.handleInput('\x1b')
  page.handleInput('\x1b[B') // deliberate selection B
  render(page, 120, 20)
  page.handleInput('\t')
  render(page, 120, 20)
  assert.equal(pageRegion(page), 'detail')
  controller.snapshotValue = {
    ...controller.snapshotValue,
    rows: controller.snapshotValue.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
  }
  const frame = render(page, 120, 20).join('\n')
  assert.equal(pageRegion(page), 'detail', 'the old A return intent does not redirect B')
  assert.match(frame, /Server: beta/u)
})

test('a pending List publishes Wait, not a clickable Back, at H0', () => {
  let done = 0
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configStatus: { kind: 'saving', text: 'Saving configuration…' },
  }), () => { done += 1 })
  const frame = render(page, 100, 1).join('\n')
  assert.match(frame, /Waiting for the Host/u)
  assert.doesNotMatch(frame, /Back \[Esc\]|Open \[Enter\]/u)
  assert.deepEqual(page.paintedBarSpans(), [], 'no hidden clickable parent exit at H0')
  page.handleInput('\x1b')
  assert.equal(done, 0)
  assert.match(render(page, 100, 1).join('\n'), /Waiting for the Host/u)
  controller.snapshotValue = { ...controller.snapshotValue, configStatus: undefined }
  assert.match(render(page, 100, 1).join('\n'), /Back \[Esc\]/u,
    'settlement restores the real H0 Back')
})

test('a filter-induced selection of B retires the saved Delete A return intent', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET }))
  render(page, 120, 20)
  page.handleInput('\r')
  const detail = controller.snapshotValue
  controller.snapshotValue = {
    ...detail,
    configConfirm: { question: 1, kind: 'delete', name: 'alpha', capturedRevision: 3 },
  }
  render(page, 120, 20)
  page.handleInput('y')
  controller.snapshotValue = {
    ...controller.snapshotValue,
    configConfirm: undefined,
    configStatus: { kind: 'saved', text: 'Config removed · waiting for Host reconcile' },
  }
  render(page, 120, 20)
  page.handleInput('\x1b')
  page.handleInput('/')
  for (const char of 'beta') page.handleInput(char)
  page.handleInput('\r')
  render(page, 120, 20)
  assert.equal(controller.snapshotValue.selectedName, 'beta', 'the filter intentionally selects B')
  page.handleInput('\t')
  render(page, 120, 20)
  assert.equal(pageRegion(page), 'detail')
  controller.snapshotValue = {
    ...controller.snapshotValue,
    rows: controller.snapshotValue.rows.filter(row => row.name !== 'alpha'),
    selectedName: 'beta',
  }
  const frame = render(page, 120, 20).join('\n')
  assert.equal(pageRegion(page), 'detail', 'A removal does not redirect the filtered B Detail')
  assert.match(frame, /Server: beta/u)
})
