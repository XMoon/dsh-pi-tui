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
  // FR4 intents.
  canBeginAdd(): boolean { return this.addable }
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
  beginEdit(): void { this.calls.push('beginEdit') }
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
  removeEditorDictKey(field: string, key: string): void { this.calls.push(`removeDict:${field}:${key}`) }
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

/** Reach the editor at the compact (100-column) layout: list -> detail -> editor. */
function openEditor(page: McpServersPage, key: 'e' | 'a' = 'e', width = 100, rows = 16): string[] {
  render(page, width, rows)
  if (key === 'e') {
    page.handleInput('\r')
    render(page, width, rows)
  }
  page.handleInput(key)
  return render(page, width, rows)
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

test('the list offers `a Add` only with a current descriptor, and search swallows it', () => {
  const ready = makePage(snapshot({ config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  assert.match(render(ready.page, 100, 14).at(-1) ?? '', /a Add/u)
  const unavailable = makePage(snapshot({ config: { kind: 'unavailable', reason: 'not read' } }))
  assert.doesNotMatch(render(unavailable.page, 100, 14).at(-1) ?? '', /Add/u)

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
  const bar = render(owned.page, 100, 14).at(-1) ?? ''
  assert.match(bar, /e edit/u)
  assert.match(bar, /t (toggle|enable\/disable)/u)
  assert.match(bar, /d delete/u)
  assert.match(bar, /p probe/u)
  assert.match(bar, /x restart/u)
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
  const pluginBar = render(pluginOwned.page, 100, 14).at(-1) ?? ''
  assert.doesNotMatch(pluginBar, /e edit|t toggle|d delete|u reset/u)
  pluginOwned.page.handleInput('e')
  pluginOwned.page.handleInput('d')
  pluginOwned.page.handleInput('u')
  assert.deepEqual(pluginOwned.controller.calls.filter(call => ['beginEdit', 'beginDelete', 'beginReset'].includes(call)), [])
})

test('the editor paints grouped fields and keeps Save + Esc reachable at 44x8', () => {
  const { page } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
  page.handleInput('e')
  // Put the page into the editor view through the Add intent of the stub.
  const added = makePage(snapshot({ config: { kind: 'ready', generation: {}, revision: 1, entries: [] } }))
  added.page.handleInput('a')
  const lines = render(added.page, 44, 8)
  const frame = lines.join('\n')
  assert.match(frame, /Identity/u)
  assert.match(frame, /Name/u)
  assert.match(frame, /Transport/u)
  assert.match(frame, /s Save/u)
  assert.match(frame, /Back \[Esc\]/u)
  assert.equal(lines.length, 8)
  for (const line of lines) assert.ok(visibleWidth(line) <= 44)
  // The page really entered the editor view (not the list).
  assert.match(frame, /Command/u)
})

test('while a form input is active, a/e/t/d/u/s are INPUT characters, never page actions', () => {
  const { page, controller } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
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
  assert.match(confirm, /Discard changes\? \[Keep editing\] \[Discard d\]/u)
  assert.match(confirm, /Keep editing · Esc/u)
  // Enter keeps editing: nothing is discarded and no write happens.
  page.handleInput('\r')
  assert.equal(controller.calls.includes('discardEditor'), false)
  page.handleInput('\x1b')
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
    configConfirm: { kind: 'delete', name: 'alpha', capturedRevision: 1 },
  }))
  const frame = render(page, 100, 14).join('\n')
  assert.match(frame, /Delete alpha\? This removes your added configuration permanently/u)
  assert.match(frame, /Y confirm · Esc cancel/u)
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
    configConfirm: { kind: 'reset', name: 'alpha', capturedRevision: 1 },
  }))
  const frame = render(page, 100, 14).join('\n')
  assert.match(frame, /Remove your override and restore the inherited configuration for alpha\?/u)
  assert.doesNotMatch(frame, /Delete/u)
})

test('the toggle confirmation says the process may change', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { kind: 'toggle', name: 'alpha', nextEnabled: false, capturedRevision: 1 },
  }))
  const frame = render(page, 100, 14).join('\n')
  assert.match(frame, /Change saved configuration\? The MCP process may stop or start/u)
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
  assert.match(frame, /s Save/u, 'the form stays open so the user can re-read and save')
})

test('a control-byte/CJK server name is sanitized in the confirmation bar', () => {
  const { page } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    configConfirm: { kind: 'delete', name: 'bad\u0007name日本', capturedRevision: 1 },
  }))
  const lines = render(page, 100, 14)
  const frame = lines.join('\n')
  assert.doesNotMatch(frame, /\u0007/u)
  assert.match(frame, /Delete bad ?name日本\?/u)
  for (const line of lines) assert.ok(visibleWidth(line) <= 100)
})

test('a confirmation bar never drops its target sentence, even at 100 columns', () => {
  // Regression: the confirmation SUBJECT used to be the lowest-priority
  // segment, so at 100 columns the user was left with `Y confirm · Esc cancel`
  // and no readable question. The target is a safety fact and outranks the
  // answer hints.
  for (const width of [100, 80, 72, 44]) {
    const deletePage = makePage(snapshot({ selectedConfig: CONFIG_FACET, configConfirm: { kind: 'delete', name: 'alpha', capturedRevision: 1 } }))
    const deleteBar = render(deletePage.page, width, 14).at(-1) ?? ''
    assert.match(deleteBar, /Delete alpha\?/u, `width ${String(width)}: the Delete subject must survive`)

    const resetPage = makePage(snapshot({
      selectedConfig: { ...CONFIG_FACET, canDelete: false, canReset: true, provenance: 'overridden' },
      configConfirm: { kind: 'reset', name: 'alpha', capturedRevision: 1 },
    }))
    const resetBar = render(resetPage.page, width, 14).at(-1) ?? ''
    assert.match(resetBar, /override|Reset alpha\?/u, `width ${String(width)}: the Reset subject must survive`)

    const togglePage = makePage(snapshot({ selectedConfig: CONFIG_FACET, configConfirm: { kind: 'toggle', name: 'alpha', nextEnabled: false, capturedRevision: 1 } }))
    const toggleBar = render(togglePage.page, width, 14).at(-1) ?? ''
    assert.match(toggleBar, /Change (saved configuration|config)\?/u, `width ${String(width)}: the toggle subject must survive`)

    const restartPage = makePage(snapshot({ confirmingName: 'alpha' }))
    const restartBar = render(restartPage.page, width, 14).at(-1) ?? ''
    assert.match(restartBar, /Restart alpha\?/u, `width ${String(width)}: the Restart subject must survive`)
  }
})

test('a dirty-discard prompt keeps its question at every narrow width', () => {
  for (const width of [100, 80, 44]) {
    const { page } = makePage(snapshot({ selectedConfig: CONFIG_FACET, editor: editorSnapshot({ dirty: true }) }))
    openEditor(page, 'e', width, 16)
    page.handleInput('\x1b')
    const bar = render(page, width, 16).at(-1) ?? ''
    assert.match(bar, /Discard(\?| changes\?)/u, `width ${String(width)}: the discard question must survive`)
  }
})

test('a Save confirmation paints the external-capability subject at every width', () => {
  for (const width of [200, 100, 80, 44]) {
    const { page } = makePage(snapshot({
      selectedConfig: CONFIG_FACET,
      editor: editorSnapshot({ dirty: true }),
      configConfirm: {
        kind: 'save',
        name: 'alpha',
        warning: 'Enabling this server can execute an external command.',
        capturedRevision: 1,
      },
    }))
    const bar = render(page, width, 16).at(-1) ?? ''
    assert.match(bar, /[Ee]xternal command|Save configuration\?/u,
      `width ${String(width)}: the disclosure must be readable`)
    assert.match(bar, /Y confirm|y/u, `width ${String(width)}: the affirmative key is advertised`)
    assert.match(bar, /Esc/u, `width ${String(width)}: the cancel key is advertised`)
  }
})

test('a Save confirmation only dispatches on `y`, never on another key', () => {
  const { page, controller } = makePage(snapshot({
    selectedConfig: CONFIG_FACET,
    editor: editorSnapshot({ dirty: true }),
    configConfirm: { kind: 'save', name: 'alpha', warning: 'Enabling this server can execute an external command.', capturedRevision: 1 },
  }))
  render(page, 100, 16)
  for (const key of ['s', 'e', 'd', 'u', '\r']) page.handleInput(key)
  assert.deepEqual(controller.calls, [], 'no other key may answer the disclosure')
  page.handleInput('y')
  assert.deepEqual(controller.calls, ['answerConfigConfirm:true'])
})

test('a compacted HTTP disclosure still names its target host', () => {
  const warning = 'Enabling this server can send data to an external service. Target: mcp.example.test'
  for (const width of [200, 100, 80, 44]) {
    const { page } = makePage(snapshot({
      selectedConfig: CONFIG_FACET,
      editor: editorSnapshot({ transport: 'streamable-http', dirty: true }),
      configConfirm: { kind: 'save', name: 'alpha', warning, capturedRevision: 1 },
    }))
    const bar = render(page, width, 16).at(-1) ?? ''
    assert.match(bar, /mcp\.example\.test/u,
      `width ${String(width)}: the target host must survive compaction`)
    assert.match(bar, /[Ee]xternal (service|data)/u, `width ${String(width)}: the capability fact must survive`)
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
    const current = /▸ ([^:\n]+):/u.exec(render(page, 100, 20).join('\n'))
    if (current !== null && (current[1] ?? '').trim().startsWith('Env TOKEN stored as')) break
    page.handleInput('\x1b[B')
  }
  page.handleInput('\r')
  assert.deepEqual(controller.calls.filter(call => call.startsWith('setDictForm')), ['setDictForm:env:TOKEN=literal'])
  const after = render(page, 100, 20).join('\n')
  assert.match(after, /stored as: Literal \(stored in profile\)/u, 'the switch is painted')
})
