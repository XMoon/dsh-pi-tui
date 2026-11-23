/**
 * Headless tests for the PiTui `/preset` panel
 * (`src/tui/pickers/preset-picker.ts`): the Catalog + read-only Details pages,
 * the explicit Use/Set default writers, Loading/Error/Retry, the browse-vs-
 * activate pointer split, stale-gesture refusal, the theme projection and the
 * frozen narrow frame budget.
 *
 * Every assertion reads a REAL painted `VirtualTerminal` frame or the REAL
 * request seams — never a private field. The command/Host owner itself is the
 * subject of `preset-pitui-presentation.test.ts`; here the request is a spy.
 * @module @xmoon76/dsh-pi-tui/preset-picker.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { PresetPickerPanel } from '../../src/tui/pickers/preset-picker.ts'
import type {
  PresetApplyOutcome,
  PresetDefaultOutcome,
  PresetPickerRequest,
  PresetPickerRoster,
} from '../../src/app/command/preset-presentation.ts'
import { runOwned, type OwnedTaskOptions } from '../../src/runtime/process/tasks.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { currentPalette } from '../../src/tui/theme/runtime.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Every TuiApp started here is disposed after each test (single-live-TUI
 *  slot; see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
const linesOf = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripAnsi)
const viewOf = (vt: VirtualTerminal): string => linesOf(vt).join('\n')
const contentLines = (vt: VirtualTerminal): string[] => linesOf(vt).map((line) => {
  const start = line.indexOf('│ ')
  if (start === -1) return line
  const end = line.lastIndexOf(' │')
  return end > start ? line.slice(start + 1, end) : line.slice(start + 1)
})
const rowOf = (vt: VirtualTerminal, needle: string): number => {
  const row = linesOf(vt).findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the frame must contain ${JSON.stringify(needle)}:\n${viewOf(vt)}`)
  return row
}
const cellIndexOf = (vt: VirtualTerminal, row: number, needle: string): number => {
  const plain = linesOf(vt)[row] ?? ''
  const index = plain.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}:\n${plain}`)
  return visibleWidth(plain.slice(0, index))
}
const hexToRgb = (hex: string): number =>
  (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)

const ENTER = '\r'
const TAB = '\t'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const PAGE_DOWN = '\x1b[6~'
const END = '\x1b[F'
const HOME = '\x1b[H'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/* --------------------------------------------------------------- fixtures */

/** The four shipped declarations publish no name/description; the TUI's own
 *  English copy supplies them (the official built-in classification). */
const SHIPPED_ROWS = [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }]

const REVIEWER = {
  id: 'reviewer',
  name: 'My reviewer',
  description: 'Reviews diffs before merge.',
}
const BROKEN = { id: 'broken-custom', name: 'Broken custom', broken: 'agent-presets: failed to mount: bad tools declaration' }

function roster(overrides: Partial<PresetPickerRoster> = {}): PresetPickerRoster {
  const dto = overrides.roster ?? { presets: [...SHIPPED_ROWS, REVIEWER], defaultId: 'standard' }
  return {
    roster: dto,
    currentId: undefined,
    pendingId: undefined,
    defaultId: dto.defaultId,
    canSetDefault: true,
    ...overrides,
  }
}

interface HarnessOptions {
  sessionless?: boolean
  /** The roster delivered right after mount (omit for the loading state). */
  hydrate?: PresetPickerRoster | false
  canSetDefault?: boolean
  apply?: (id: string) => Promise<PresetApplyOutcome> | PresetApplyOutcome
  setDefault?: (id: string) => Promise<PresetDefaultOutcome> | PresetDefaultOutcome
  width?: number
  rows?: number
  fullscreen?: boolean
}

interface Harness {
  vt: VirtualTerminal
  app: TuiApp
  panel: PresetPickerPanel
  applied: string[]
  defaults: string[]
  retries: () => number
  closes: () => number
  setCurrent: (value: boolean) => void
  hydrate: (next: PresetPickerRoster) => void
  error: (message: string) => void
  close: () => void
}

async function openPanel(options: HarnessOptions = {}): Promise<Harness> {
  const vt = new VirtualTerminal(options.width ?? 80, options.rows ?? 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  if (options.fullscreen === true) app.setFullscreen(true)
  const applied: string[] = []
  const defaults: string[] = []
  let retries = 0
  let closes = 0
  let current = true
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  const request: PresetPickerRequest = {
    subject: { sessionless: options.sessionless ?? true },
    apply: async (id) => {
      applied.push(id)
      return options.apply === undefined ? { kind: 'switched', preset: id } : options.apply(id)
    },
    setDefault: async (id) => {
      defaults.push(id)
      return options.setDefault === undefined ? { kind: 'saved', preset: id } : options.setDefault(id)
    },
    retry: () => { retries += 1 },
    isCurrent: () => current,
    runOwned: <T>(label: string, task: () => T | Promise<T>, owned: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
      runOwned(label, task, { ...owned, diag })
    },
  }
  let close: () => void = () => {}
  const panel = new PresetPickerPanel({
    request,
    requestRender: () => app.requestRender(),
    close: () => {
      closes += 1
      close()
    },
  })
  close = app.openPresetPicker(panel)
  if (options.hydrate !== false) panel.setRoster(options.hydrate ?? roster())
  await vt.waitForRender()
  return {
    vt,
    app,
    panel,
    applied,
    defaults,
    retries: () => retries,
    closes: () => closes,
    setCurrent: (value) => { current = value },
    hydrate: (next) => panel.setRoster(next),
    error: (message) => panel.setLoadError(message),
    close: () => panel.dispose(),
  }
}

/** One raw SGR left press/release at a 0-based terminal cell. */
function sgrPress(vt: VirtualTerminal, col: number, row: number): void {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
function sgrRelease(vt: VirtualTerminal, col: number, row: number): void {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}
function clickVisibleText(h: Harness, needle: string): void {
  const row = rowOf(h.vt, needle)
  const start = cellIndexOf(h.vt, row, needle)
  const col = start + Math.floor(visibleWidth(needle) / 2)
  sgrPress(h.vt, col, row)
  sgrRelease(h.vt, col, row)
}

/* ------------------------------------------------------- loading + retry */

test('the panel mounts in Loading immediately: no write action, search editable', async () => {
  const h = await openPanel({ hydrate: false })
  const view = viewOf(h.vt)
  assert.ok(view.includes('Agent presets'), `the Catalog identity must paint:\n${view}`)
  assert.ok(view.includes('Loading agent presets…'), `the loading state must paint:\n${view}`)
  assert.ok(view.includes('Close [Esc]'), `only Close is offered while loading:\n${view}`)
  assert.ok(!view.includes('Use next'), `no write action may be offered while loading:\n${view}`)
  assert.ok(!view.includes('Set default'), `no write action may be offered while loading:\n${view}`)
  // The search box stays editable while the read runs.
  h.vt.sendInput('rev')
  await h.vt.waitForRender()
  assert.ok(contentLines(h.vt).some(line => line.includes('rev')), `search typing must land in the input:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [])
  h.app.stop()
})

test('a failed read paints the exact error in the panel and Retry re-enters loading once', async () => {
  const h = await openPanel({ hydrate: false })
  h.error('connection refused: roster unavailable')
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  const flat = view.replace(/\n/g, ' ')
  assert.ok(view.includes('Preset catalog unavailable'), `the failure must name itself:\n${view}`)
  assert.ok(flat.includes('connection refused: roster unavailable'), `the real read reason must be visible:\n${view}`)
  assert.ok(view.includes('Retry'), `a failed read offers Retry:\n${view}`)
  assert.ok(!view.includes('Use next') && !view.includes('Set default'), 'writes are refused after a failed read')
  // Tab reaches the footer and Enter runs the focused Retry (the loading frame
  // is committed before the request callback runs).
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  assert.equal(h.retries(), 1, 'Retry asks the command read owner exactly once')
  await h.vt.waitForRender()
  const loading = viewOf(h.vt)
  assert.ok(loading.includes('Loading agent presets…'), `Retry returns to Loading in place:\n${loading}`)
  assert.deepEqual(h.applied, [])
  h.app.stop()
})

test('a second Retry request cannot run while the first read is still loading', async () => {
  const h = await openPanel({ hydrate: false })
  h.error('boom')
  await h.vt.waitForRender()
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  h.vt.sendInput(ENTER)
  assert.equal(h.retries(), 1, 'the loading state admits one retry for the paint')
  h.app.stop()
})

/* ---------------------------------------------------- empty / zero match */

test('an empty roster is a readable state, never a fabricated first row', async () => {
  const h = await openPanel({ hydrate: roster({ roster: { presets: [] }, defaultId: undefined }) })
  const view = viewOf(h.vt)
  assert.ok(view.includes('No agent presets configured.'), `the empty state must paint:\n${view}`)
  assert.ok(view.includes('No preset selected'), `the disabled write reason must paint:\n${view}`)
  // No selection ⇒ both writers are inert even if their reasons were bypassed.
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [])
  assert.deepEqual(h.defaults, [])
  h.app.stop()
})

test('a zero-match search is distinct text and disables both writes', async () => {
  const h = await openPanel()
  h.vt.sendInput('zzzz-no-match')
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('No matching presets'), `zero-match text must paint:\n${view}`)
  assert.ok(!view.includes('No agent presets configured.'), 'zero-match is not the empty roster')
  assert.ok(view.includes('No preset selected'), `the disabled reason must paint:\n${view}`)
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [])
  assert.deepEqual(h.defaults, [])
  h.app.stop()
})

/* --------------------------------------------- grouping + identity */

test('the Catalog groups Built-in first then Custom, with the group counts', async () => {
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }) })
  const rows = contentLines(h.vt)
  const builtIn = rows.findIndex(line => line.includes('Built-in · 4'))
  const custom = rows.findIndex(line => line.includes('Custom · 1'))
  assert.ok(builtIn >= 0, `the Built-in group must paint with its count:\n${viewOf(h.vt)}`)
  assert.ok(custom > builtIn, `Custom must follow Built-in:\n${viewOf(h.vt)}`)
  const standard = rows.findIndex(line => line.includes('Standard mode (standard)'))
  const reviewer = rows.findIndex(line => line.includes('My reviewer (reviewer)'))
  assert.ok(standard > builtIn && standard < custom, 'built-in rows stay under their group')
  assert.ok(reviewer > custom, 'custom rows stay under their group')
  h.app.stop()
})

test('a Custom declaration reusing a shipped id keeps its own identity and gets no official guide', async () => {
  const custom = { id: 'standard', name: 'Team standard', description: 'Our own standard.' }
  const h = await openPanel({
    hydrate: roster({ roster: { presets: [custom], defaultId: 'standard' }, defaultId: 'standard' }),
  })
  assert.ok(viewOf(h.vt).includes('Custom · 1'), `a named shipped-id declaration is Custom:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Preset details · Team standard'), `Details must describe the custom row:\n${view}`)
  assert.ok(view.includes('Custom'), 'Type is Custom')
  assert.ok(!view.includes('Mode details'), `a Custom declaration never borrows the official guide:\n${view}`)
  assert.ok(view.includes('Our own standard.'), 'its own description is complete')
  h.app.stop()
})

test('a long preset id stays COMPLETE on Details (no terminal hard cut)', async () => {
  const id = `${'k'.repeat(11)}quasar${'z'.repeat(13)}`
  const h = await openPanel({ hydrate: roster({ roster: { presets: [{ id }], defaultId: id }, defaultId: id }) })
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  // Details is a wrapping reader: the complete id appears across physical rows.
  assert.ok(viewOf(h.vt).includes(id), `the complete id must be readable on Details:\n${viewOf(h.vt)}`)
  h.app.stop()
})

/* ------------------------------------------------------- status chips */

test('the sessionless Catalogue never fabricates Current and marks real Next/Default', async () => {
  const h = await openPanel({
    hydrate: roster({ defaultId: 'standard', pendingId: 'ptc' }),
    sessionless: true,
  })
  const view = viewOf(h.vt)
  assert.ok(!view.includes('[current]'), `no Current without a Session:\n${view}`)
  assert.ok(view.includes('[next session]'), `the pending preset carries Next session:\n${view}`)
  assert.ok(view.includes('[default]'), `the default carries Default:\n${view}`)
  const nextRow = rowOf(h.vt, '[next session]')
  assert.ok((linesOf(h.vt)[nextRow] ?? '').includes('PTC mode'), 'the Next chip rides the pending preset')
  h.app.stop()
})

test('a live Catalogue never invents Next session and shows Current + Default as two chips', async () => {
  const h = await openPanel({
    sessionless: false,
    hydrate: roster({ currentId: 'standard', defaultId: 'standard' }),
  })
  const view = viewOf(h.vt)
  assert.ok(!view.includes('[next session]'), `a live panel never invents Next session:\n${view}`)
  const currentRow = rowOf(h.vt, '[current]')
  assert.ok((linesOf(h.vt)[currentRow] ?? '').includes('[default]'), `two states are two chips:\n${view}`)
  h.app.stop()
})

test('the browse target carries Draft only when it is not a committed relationship', async () => {
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }), sessionless: false })
  h.vt.sendInput(DOWN)
  h.vt.sendInput(DOWN)
  await h.vt.waitForRender()
  const draftRow = rowOf(h.vt, '[draft]')
  assert.ok((linesOf(h.vt)[draftRow] ?? '').includes('Minimal mode'), `the moved target is the Draft:\n${viewOf(h.vt)}`)
  // The committed Default row keeps its own chip and never becomes Draft.
  assert.ok((linesOf(h.vt)[h.vt.getViewport().findIndex(line => stripAnsi(line).includes('[default]'))] ?? '').length > 0)
  h.app.stop()
})

/* ------------------------------------------- enter vs pointer activation */

test('Enter opens Details and writes nothing; Esc returns to the same query and target', async () => {
  const h = await openPanel()
  h.vt.sendInput('rev')
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Preset details · My reviewer'), `Enter opens the highlighted Details:\n${view}`)
  assert.ok(!view.includes('Use next') && !view.includes('Set default'), `Details carries no writer:\n${view}`)
  assert.deepEqual(h.applied, [])
  assert.deepEqual(h.defaults, [])
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  const back = contentLines(h.vt)
  assert.ok(back.some(line => line.includes('rev')), `the search query survives Back:\n${viewOf(h.vt)}`)
  assert.ok(back.some(line => line.trimStart().startsWith('> ')), 'the list cursor survives Back')
  h.app.stop()
})

test('a first pointer click only browses; the second click on the selected row opens Details', async () => {
  const h = await openPanel({ fullscreen: true, hydrate: roster({ defaultId: 'standard' }) })
  const reviewerRow = rowOf(h.vt, 'My reviewer')
  const reviewerCol = cellIndexOf(h.vt, reviewerRow, 'My reviewer') + 2
  sgrPress(h.vt, reviewerCol, reviewerRow)
  sgrRelease(h.vt, reviewerCol, reviewerRow)
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Preset details'), `the first click must only browse:\n${viewOf(h.vt)}`)
  assert.ok(contentLines(h.vt).some(line => line.includes('My reviewer') && line.trimStart().startsWith('> ')),
    `the clicked row must become the selection:\n${viewOf(h.vt)}`)
  // The selected row now paints the Draft chip (no committed relationship).
  assert.ok(viewOf(h.vt).includes('[draft]'), viewOf(h.vt))
  const selectedRow = rowOf(h.vt, '[draft]')
  sgrPress(h.vt, reviewerCol, selectedRow)
  sgrRelease(h.vt, reviewerCol, selectedRow)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Preset details · My reviewer'), `the second click activates:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'reading Details never writes')
  h.app.stop()
})

/* ---------------------------------------------------- details full read */

test('Details is ONE scrolled reader: the complete description and shipped guide are reachable', async () => {
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }) })
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  const first = viewOf(h.vt)
  assert.ok(first.includes('Name') && first.includes('Standard mode'), `identity must lead Details:\n${first}`)
  assert.ok(first.includes('ID') && first.includes('standard'), first)
  assert.ok(first.includes('Built-in'), first)
  assert.ok(first.includes('Use: next session only'), `the sessionless scope fact must paint:\n${first}`)
  assert.ok(first.includes('Scope'), first)
  assert.ok(first.includes('Description'), first)
  assert.ok(first.includes('Full coding agent'), `the description must lead the reader:\n${first}`)
  // The official guide is INLINE in the SAME body, not a second page.
  h.vt.sendInput(END)
  await h.vt.waitForRender()
  const tail = viewOf(h.vt)
  assert.ok(tail.includes('How to use'), `the guide tail must be reachable by scrolling:\n${tail}`)
  assert.ok(tail.includes('Back [Esc]'), 'the way back is the last physical row')
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Agent presets'), 'Esc returns to the Catalogue')
  h.app.stop()
})

test('a broken preset is readable on Details but never writable', async () => {
  const h = await openPanel({
    hydrate: roster({ roster: { presets: [BROKEN], defaultId: undefined }, defaultId: undefined }),
  })
  const view = viewOf(h.vt)
  assert.ok(view.includes('[unavailable]'), `the broken row carries the problem chip:\n${view}`)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  const details = viewOf(h.vt)
  assert.ok(details.includes('Failed to load'), `Details names the failure:\n${details}`)
  assert.ok(details.includes('bad tools declaration'), `the complete reason must be readable:\n${details}`)
  assert.ok(!details.includes('Use next') && !details.includes('Set default'), 'Details carries no writer')
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Preset failed to load'), `the Catalog states the disabled reason:\n${viewOf(h.vt)}`)
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [], 'a broken preset can never be applied')
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.defaults, [], 'a broken preset can never become the default')
  h.app.stop()
})

/* ------------------------------------------------ explicit writers */

test('Use next stages exactly one apply through the focused painted action', async () => {
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }) })
  h.vt.sendInput(DOWN)
  h.vt.sendInput(DOWN)
  h.vt.sendInput(TAB)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Use next [Enter]'), `the focused Use names Enter:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, ['minimal'], 'Use next applies exactly the selected raw id')
  assert.deepEqual(h.defaults, [])
  h.app.stop()
})

test('Set default writes exactly once through the original writer', async () => {
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }) })
  h.vt.sendInput(DOWN)
  h.vt.sendInput(DOWN)
  h.vt.sendInput(TAB)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Set default [Enter]'), `the focused Default names Enter:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.defaults, ['minimal'])
  assert.deepEqual(h.applied, [])
  h.app.stop()
})

test('Already the default and Settings unavailable are painted reasons with zero writes', async () => {
  const already = await openPanel({ hydrate: roster({ defaultId: 'standard' }) })
  already.vt.sendInput(TAB)
  already.vt.sendInput(RIGHT)
  await already.vt.waitForRender()
  assert.ok(viewOf(already.vt).includes('Already the default'), viewOf(already.vt))
  already.vt.sendInput(ENTER)
  await already.vt.waitForRender()
  assert.deepEqual(already.defaults, [], 'a disabled Set default can never write')
  already.app.dispose()

  const unavailable = await openPanel({ hydrate: roster({ defaultId: 'standard', canSetDefault: false }) })
  unavailable.vt.sendInput(TAB)
  unavailable.vt.sendInput(RIGHT)
  await unavailable.vt.waitForRender()
  assert.ok(viewOf(unavailable.vt).includes('Settings unavailable'), viewOf(unavailable.vt))
  unavailable.vt.sendInput(ENTER)
  await unavailable.vt.waitForRender()
  assert.deepEqual(unavailable.defaults, [], 'an unavailable settings owner can never write')
  unavailable.app.stop()
})

test('pointer Use writes exactly the clicked painted action once', async () => {
  const h = await openPanel({ fullscreen: true, hydrate: roster({ defaultId: 'standard' }) })
  clickVisibleText(h, 'Use next')
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, ['standard'], 'the painted primary action applies the selected preset')
  h.app.stop()
})

/* ------------------------------------------------- promise settlement */

test('pending admits no second write and Close does not cancel the admitted one', async () => {
  const pending = deferred<PresetApplyOutcome>()
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }), apply: () => pending.promise })
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, ['standard'])
  const view = viewOf(h.vt)
  assert.ok(view.includes('Applying preset…'), `the pending label must paint:\n${view}`)
  assert.ok(!view.includes('Use next') && !view.includes('Set default'), 'an admitted write offers only Close')
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, ['standard'], 'a second Enter cannot dispatch a second write')
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.equal(h.closes(), 1, 'Esc dismisses the panel')
  pending.resolve({ kind: 'switched', preset: 'standard' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.applied, ['standard'], 'dismissing the UI never cancels the admitted write')
  h.app.stop()
})

test('a locked/rejected settlement restores a Ready Catalogue with the real reason', async () => {
  const h = await openPanel({
    hydrate: roster({ defaultId: 'standard' }),
    apply: () => ({ kind: 'locked', sessionId: 's1' }),
  })
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Locked: this session has already started.'), `the refusal must stay visible:\n${view}`)
  assert.ok(view.includes('Use next') && view.includes('Set default'), 'the picker stays usable after a refusal')
  assert.equal(h.closes(), 0)
  h.app.stop()
})

test('a thrown apply keeps the picker ready and states the failure (no silent success)', async () => {
  const h = await openPanel({
    hydrate: roster({ defaultId: 'standard' }),
    apply: () => { throw new Error('transport exploded') },
  })
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('transport exploded'), `the real error must surface:\n${viewOf(h.vt)}`)
  assert.equal(h.closes(), 0, 'an unknown outcome keeps the panel for a fresh authoritative read')
  h.app.stop()
})

test('a saved OR unconfirmed default both dismiss without an implicit retry', async () => {
  for (const outcome of [{ kind: 'saved', preset: 'ptc' } as const, { kind: 'unconfirmed', message: 'settings write raised' } as const]) {
    const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }), setDefault: () => outcome })
    h.vt.sendInput(DOWN)
    h.vt.sendInput(DOWN)
    h.vt.sendInput(TAB)
    h.vt.sendInput(RIGHT)
    h.vt.sendInput(ENTER)
    await h.vt.waitForRender()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(h.closes(), 1, `${outcome.kind} dismisses the panel`)
    assert.deepEqual(h.defaults, ['minimal'], 'exactly one default write')
    h.app.dispose()
  }
})

/* -------------------------------------------- stale / resize / preempt */

test('a stale panel refuses input when its captured subject moved', async () => {
  const h = await openPanel()
  h.setCurrent(false)
  h.vt.sendInput(TAB)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [], 'a no-longer-current panel writes nothing')
  assert.equal(h.closes(), 1, 'the stale panel retires itself')
  h.app.stop()
})

test('a roster refresh revokes a pending pointer gesture and keeps the selection target', async () => {
  const h = await openPanel({ fullscreen: true, hydrate: roster({ defaultId: 'standard' }) })
  const useRow = rowOf(h.vt, 'Use next')
  const useCol = cellIndexOf(h.vt, useRow, 'Use next') + 2
  sgrPress(h.vt, useCol, useRow)
  h.hydrate(roster({ defaultId: 'ptc' }))
  await h.vt.waitForRender()
  sgrRelease(h.vt, useCol, useRow)
  assert.deepEqual(h.applied, [], 'a release after a roster refresh cannot commit the old action')
  h.app.stop()
})

test('a press/release mismatch and a resize both refuse the action', async () => {
  const h = await openPanel({ fullscreen: true })
  const row = rowOf(h.vt, 'Use next')
  const col = cellIndexOf(h.vt, row, 'Use next') + 2
  sgrPress(h.vt, col, row)
  h.vt.sendInput(DOWN)
  await h.vt.waitForRender()
  sgrRelease(h.vt, col, row)
  assert.deepEqual(h.applied, [], 'a keyboard selection change revokes the pressed action')
  const resizedRow = rowOf(h.vt, 'Use next')
  const resizedCol = cellIndexOf(h.vt, resizedRow, 'Use next') + 2
  sgrPress(h.vt, resizedCol, resizedRow)
  h.vt.resize(60, 24)
  await h.vt.waitForRender()
  sgrRelease(h.vt, resizedCol, resizedRow)
  assert.deepEqual(h.applied, [], 'a release against resized geometry writes nothing')
  h.app.stop()
})

test('a disabled action paints no pointer target and writes nothing', async () => {
  const h = await openPanel({ fullscreen: true, hydrate: roster({ defaultId: 'standard' }) })
  // Set default is disabled on the default row: its painted segment is inert.
  const row = rowOf(h.vt, 'Set default')
  const col = cellIndexOf(h.vt, row, 'Set default') + 2
  sgrPress(h.vt, col, row)
  sgrRelease(h.vt, col, row)
  await h.vt.waitForRender()
  assert.deepEqual(h.defaults, [], 'a disabled painted action has no pointer target')
  h.app.stop()
})

/* --------------------------------------------------------------- budget */

test('every painted row fits the frozen 44-column frame and the bar is last', async () => {
  const h = await openPanel({ width: 44, rows: 20, hydrate: roster({ currentId: 'standard', defaultId: 'standard', pendingId: 'ptc' }) })
  for (const line of linesOf(h.vt)) {
    assert.ok(visibleWidth(line) <= 44, `no painted row may exceed the terminal width:\n${line}`)
  }
  const row = rowOf(h.vt, 'Close [Esc]')
  assert.equal(row, linesOf(h.vt).findIndex(line => line.includes('Close [Esc]')), 'the bar is painted once')
  const frameBottom = linesOf(h.vt).findIndex(line => line.includes('╰'))
  assert.equal(row, frameBottom - 1, `the action bar must be the last content row:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('short grants keep the real Close [Esc] and the Details Back [Esc]', async () => {
  const h = await openPanel({ width: 44, rows: 9, hydrate: roster({ defaultId: 'standard' }) })
  assert.ok(viewOf(h.vt).includes('Close [Esc]'), `a 7-row content grant keeps the exit bar:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Back [Esc]'), `the Details page keeps its only way back:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('theme switching repaints the state chips through the CURRENT palette', async () => {
  const h = await openPanel({ sessionless: false, hydrate: roster({ currentId: 'standard', defaultId: 'standard' }) })
  const row = rowOf(h.vt, '[current]')
  const col = cellIndexOf(h.vt, row, '[current]')
  assert.equal(h.vt.getCellFgRgb(row, col), hexToRgb(currentPalette.textMuted), viewOf(h.vt))
  h.app.applyTheme('light')
  await h.vt.waitForRender()
  const lightRow = rowOf(h.vt, '[current]')
  const lightCol = cellIndexOf(h.vt, lightRow, '[current]')
  assert.equal(h.vt.getCellFgRgb(lightRow, lightCol), hexToRgb(currentPalette.textMuted),
    `a palette switch must rebake the chips:\n${viewOf(h.vt)}`)
  h.app.stop()
})

/* ------------------------------------------- chips: ink + width matrix */

test('state chips keep textMuted ink on the SELECTED and the UNSELECTED row', async () => {
  const h = await openPanel({
    sessionless: false,
    hydrate: roster({ currentId: 'standard', defaultId: 'standard' }),
  })
  const selectedRow = rowOf(h.vt, '[current]')
  assert.equal(h.vt.getCellFgRgb(selectedRow, cellIndexOf(h.vt, selectedRow, '[current]')),
    hexToRgb(currentPalette.textMuted),
    `the selected row's [current] chip keeps textMuted (never primary):\n${viewOf(h.vt)}`)
  h.vt.sendInput(DOWN)
  await h.vt.waitForRender()
  const unselectedRow = rowOf(h.vt, '[current]')
  assert.ok(!contentLines(h.vt)[unselectedRow]?.trimStart().startsWith('> '), 'the cursor moved off the current row')
  assert.equal(h.vt.getCellFgRgb(unselectedRow, cellIndexOf(h.vt, unselectedRow, '[current]')),
    hexToRgb(currentPalette.textMuted),
    `the unselected row's [current] chip keeps textMuted (never textDim):\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('the chips stay WHOLE and in-budget across the supported widths', async () => {
  const longId = 'a-very-long-custom-preset-name-here'
  for (const width of [44, 48, 56, 80, 120]) {
    const h = await openPanel({
      width,
      rows: 20,
      sessionless: false,
      hydrate: roster({
        roster: {
          presets: [{ id: 'standard' }, { id: 'ptc' }, { id: longId }],
          defaultId: 'standard',
        },
        currentId: 'standard',
        defaultId: 'standard',
      }),
    })
    const view = linesOf(h.vt)
    for (const line of view) {
      assert.ok(visibleWidth(line) <= width, `at ${width} columns no row may overflow:\n${view.join('\n')}`)
    }
    const chipLines = view.filter(line => line.includes('[current]'))
    assert.equal(chipLines.length, 1, `at ${width} exactly the current row is marked:\n${view.join('\n')}`)
    assert.ok(!view.some(line => line.includes('[defaul') && !line.includes('[default]')),
      `at ${width} no half chip may paint:\n${view.join('\n')}`)
    // Two committed states are TWO atomic chips, whole at every width (the
    // badge wraps to its own row instead of dropping or cutting a chip).
    const chipText = view.join('\n')
    assert.ok(chipText.includes('[current]') && chipText.includes('[default]'),
      `at ${width} both committed chips survive whole:\n${view.join('\n')}`)
    assert.ok(!chipText.includes('[current] · [default]'),
      `at ${width} two chips are space-joined, never a grouped badge:\n${view.join('\n')}`)
    h.app.dispose()
  }
})

test('a wide → narrow resize re-wraps the chips whole and the narrow row stays clickable', async () => {
  const longId = 'a-very-long-custom-preset-name-here'
  const h = await openPanel({
    width: 120,
    rows: 20,
    fullscreen: true,
    sessionless: false,
    hydrate: roster({
      roster: {
        presets: [{ id: 'standard' }, { id: longId }],
        defaultId: 'standard',
      },
      currentId: 'standard',
      defaultId: 'standard',
    }),
  })
  assert.ok(linesOf(h.vt).some(line => line.includes('[current] [default]')),
    `the wide frame paints both chips on the row:\n${viewOf(h.vt)}`)
  h.vt.resize(44, 20)
  await h.vt.waitForRender()
  const narrow = linesOf(h.vt)
  assert.ok(narrow.some(line => line.includes('[current]')), `the current chip survives the shrink:\n${narrow.join('\n')}`)
  assert.ok(narrow.some(line => line.includes('[default]')), `the default chip re-wraps whole:\n${narrow.join('\n')}`)
  assert.ok(!narrow.some(line => line.includes('[defaul') && !line.includes('[default]')),
    `the shrink never cuts a chip:\n${narrow.join('\n')}`)
  // The hit map was rebuilt for the narrow geometry: clicking the long row
  // selects THAT raw id (never the chip row).
  const targetRow = narrow.findIndex(line => line.includes('a-very-long'))
  assert.ok(targetRow >= 0, `the long row must paint:\n${narrow.join('\n')}`)
  const leftBorder = narrow[targetRow]!.indexOf('│')
  assert.ok(leftBorder >= 0, `frame border missing:\n${narrow.join('\n')}`)
  sgrPress(h.vt, leftBorder + 3, targetRow)
  sgrRelease(h.vt, leftBorder + 3, targetRow)
  await h.vt.waitForRender()
  const after = linesOf(h.vt)
  assert.ok(after.some(line => line.includes(longId) && line.includes('>')),
    `the click must select the clicked raw id:\n${after.join('\n')}`)
  assert.deepEqual(h.applied, [], 'browsing by pointer writes nothing')
  h.app.dispose()
})

/* ------------------------------------------------------ root slot ownership */

test('the preset slot supersedes identity-safely: an old closer never retires a later panel', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const makeRequest = (pending: string | undefined) => ({
    subject: { sessionless: true },
    apply: async () => ({ kind: 'superseded' as const }),
    setDefault: async () => ({ kind: 'superseded' as const }),
    retry: () => {},
    isCurrent: () => true,
    runOwned: <T>(label: string, task: () => T | Promise<T>, owned: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
      runOwned(label, task, { ...owned, diag: createDiag({ filePath: undefined, stderrLevel: 'off' }) })
    },
    ...(pending === undefined ? {} : { pendingId: pending }),
  })
  const requestA = makeRequest(undefined)
  const requestB = makeRequest(undefined)
  const panelA = new PresetPickerPanel({ request: requestA, requestRender: () => app.requestRender(), close: () => closerA() })
  let closerA: () => void = () => {}
  closerA = app.openPresetPicker(panelA)
  panelA.setRoster(roster({ roster: { presets: [{ id: 'panel-a' }] }, defaultId: 'panel-a' }))
  const panelB = new PresetPickerPanel({ request: requestB, requestRender: () => app.requestRender(), close: () => closerB() })
  let closerB: () => void = () => {}
  closerB = app.openPresetPicker(panelB)
  panelB.setRoster(roster({ roster: { presets: [{ id: 'panel-b' }] }, defaultId: 'panel-b' }))
  await vt.waitForRender()
  assert.equal(panelA.isDisposed(), true, 'mounting the new panel disposes the previous one')
  assert.ok(viewOf(vt).includes('panel-b'), `the new panel owns the surface:\n${viewOf(vt)}`)
  closerA() // a stale async callback from the replaced panel
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('panel-b'), `a stale closer must not retire the later panel:\n${viewOf(vt)}`)
  closerB()
  await vt.waitForRender()
  assert.equal(panelB.isDisposed(), true, 'the current closer retires its own panel')
  assert.ok(!viewOf(vt).includes('Agent presets'), `the closed slot paints nothing:\n${viewOf(vt)}`)
  app.dispose()
})

test('the preset slot is independent from the model slot (one logical overlay each)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  let modelDisposed = 0
  const model: import('@xmoon76/pi-tui').Component & import('@xmoon76/pi-tui').RowBudgetAware = {
    render: () => ['model-surface-body'],
    invalidate: () => {},
    setMaxRows: () => {},
    dispose: () => { modelDisposed += 1 },
  }
  app.openModelPicker(model)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('model-surface-body'), viewOf(vt))
  let closer: () => void = () => {}
  const panel = new PresetPickerPanel({
    request: {
      subject: { sessionless: true },
      apply: async () => ({ kind: 'superseded' as const }),
      setDefault: async () => ({ kind: 'superseded' as const }),
      retry: () => {},
      isCurrent: () => true,
      runOwned: <T>(label: string, task: () => T | Promise<T>, owned: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
        runOwned(label, task, { ...owned, diag: createDiag({ filePath: undefined, stderrLevel: 'off' }) })
      },
    },
    requestRender: () => app.requestRender(),
    close: () => closer(),
  })
  closer = app.openPresetPicker(panel)
  panel.setRoster(roster())
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('Agent presets'), `the preset slot owns the top overlay:\n${viewOf(vt)}`)
  assert.equal(modelDisposed, 0, 'opening /preset never touches the /model slot')
  closer()
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('model-surface-body'),
    `closing /preset restores the independent /model picker:\n${viewOf(vt)}`)
  assert.equal(modelDisposed, 0, 'the /model component survives the /preset close')
  app.dispose()
  assert.equal(modelDisposed, 1, 'the final dispose releases the model slot exactly once')
})

test('a layout-dropped business action is not reachable from the keyboard', async () => {
  // At 32 columns the action bar can only keep Use + Close: Set default is
  // dropped as a whole segment and must not become an invisible Enter target.
  const h = await openPanel({ width: 32, rows: 20, hydrate: roster({ defaultId: 'standard' }) })
  h.vt.sendInput(DOWN) // standard -> ptc (Set default becomes available)
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('Set default') && !view.includes('Default'),
    `the narrow bar must drop the whole secondary action:\n${view}`)
  h.vt.sendInput(TAB)
  h.vt.sendInput(RIGHT) // the ring can only reach the painted Close
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Close [Enter]'), `focus falls on the painted Close:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.deepEqual(h.defaults, [], 'a dropped action never writes through the keyboard')
  assert.equal(h.closes(), 1, 'Enter ran the painted action instead')
  h.app.stop()
})

test('the Catalog Esc ladder clears a non-empty query before it closes', async () => {
  const h = await openPanel()
  h.vt.sendInput('rev')
  await h.vt.waitForRender()
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.equal(h.closes(), 0, 'the first Esc only clears the query')
  assert.ok(viewOf(h.vt).includes('Standard mode (standard)'), `the full list returns:\n${viewOf(h.vt)}`)
  assert.ok(!contentLines(h.vt).some(line => line.trimStart().startsWith('> rev')), 'the query is cleared')
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.equal(h.closes(), 1, 'the second Esc closes the empty-query panel')
  h.app.stop()
})

test('the loading Esc ladder also clears the query before closing', async () => {
  const h = await openPanel({ hydrate: false })
  h.vt.sendInput('rev')
  await h.vt.waitForRender()
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.equal(h.closes(), 0, 'a non-empty query is cleared first while loading')
  h.vt.sendInput(ESC)
  await h.vt.waitForRender()
  assert.equal(h.closes(), 1, 'the empty-query loading panel closes')
  h.app.stop()
})

test('the Details Back pointer span is the button: the inert last-row cells do nothing', async () => {
  const h = await openPanel({ width: 80, rows: 24, fullscreen: true, hydrate: roster({ defaultId: 'standard' }) })
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Preset details · Standard mode'), viewOf(h.vt))
  const backRow = rowOf(h.vt, 'Back [Esc]')
  const frameLeft = linesOf(h.vt)[backRow]!.indexOf('│')
  assert.ok(frameLeft >= 0)
  // The leading padding cell is outside the painted Back span.
  sgrPress(h.vt, frameLeft + 1, backRow)
  sgrRelease(h.vt, frameLeft + 1, backRow)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Preset details'), `an inert last-row cell must not go Back:\n${viewOf(h.vt)}`)
  clickVisibleText(h, 'Back [Esc]')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Agent presets'), `the painted Back span returns:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('every render fits its granted row budget (Catalog and Details, 1..8 rows)', async () => {
  const request: PresetPickerRequest = {
    subject: { sessionless: true },
    apply: async () => ({ kind: 'superseded' }),
    setDefault: async () => ({ kind: 'superseded' }),
    retry: () => {},
    isCurrent: () => true,
    runOwned: <T>(_label: string, task: () => T | Promise<T>, _options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => { void task() },
  }
  const panel = new PresetPickerPanel({ request, requestRender: () => {}, close: () => {} })
  panel.setRoster(roster({ defaultId: 'standard' }))
  for (const grant of [1, 2, 3, 4, 6, 8]) {
    panel.setMaxRows(grant)
    const lines = panel.render(40)
    assert.ok(lines.length <= grant, `Catalog at grant ${grant} painted ${lines.length} rows:\n${lines.join('\n')}`)
    assert.ok(lines.at(-1)?.includes('Close [Esc]'), `Catalog keeps the real Close at grant ${grant}:\n${lines.join('\n')}`)
    for (const line of lines) assert.ok(visibleWidth(line) <= 40, `row overflow at grant ${grant}: ${line}`)
  }
  panel.handleInput(ENTER) // open Details
  for (const grant of [1, 2, 3, 4, 8]) {
    panel.setMaxRows(grant)
    const lines = panel.render(40)
    assert.ok(lines.length <= grant, `Details at grant ${grant} painted ${lines.length} rows:\n${lines.join('\n')}`)
    assert.ok(stripAnsi(lines.at(-1) ?? '').includes('Back [Esc]'),
      `Details keeps the real Back at grant ${grant}:\n${lines.join('\n')}`)
  }
  panel.dispose()
})

test('the official Mode guide renders its sub-headings without literal ### markers', async () => {
  const h = await openPanel({ hydrate: roster({ defaultId: 'standard' }) })
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Mode details'), `the guide section must paint:\n${view}`)
  assert.ok(view.includes('How it works'), `the guide sub-heading must paint:\n${view}`)
  assert.ok(!view.includes('###'), `no literal Markdown heading marker may leak:\n${view}`)
  h.vt.sendInput(END)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('How to use'), viewOf(h.vt))
  assert.ok(!viewOf(h.vt).includes('###'), viewOf(h.vt))
  h.app.stop()
})

test('a wheel anywhere on the Catalog revokes an outstanding footer press', async () => {
  const h = await openPanel({ fullscreen: true, hydrate: roster({ defaultId: 'standard' }) })
  const useRow = rowOf(h.vt, 'Use next')
  const useCol = cellIndexOf(h.vt, useRow, 'Use next') + 2
  sgrPress(h.vt, useCol, useRow)
  // The wheel lands on the group header row (neither an item nor the footer).
  const headerRow = rowOf(h.vt, 'Built-in · 4')
  h.vt.sendInput(`\x1b[<65;${Math.max(1, cellIndexOf(h.vt, headerRow, 'Built-in') + 2)};${headerRow + 1}M`)
  await h.vt.waitForRender()
  sgrRelease(h.vt, useCol, useRow)
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [], 'a wheel between press and release must revoke the action')
  assert.equal(h.closes(), 0, 'the revoked release must not close either')
  assert.ok(viewOf(h.vt).includes('Agent presets'), 'the panel stays ready')
  h.app.stop()
})

test('a long read failure keeps its COMPLETE reason readable above the bar', async () => {
  const h = await openPanel({ hydrate: false, width: 80, rows: 24 })
  const reason = 'gateway rejected the roster read: connection reset by peer while the Host composed the standing preset catalog; retry after the Host settles'
  h.error(reason)
  await h.vt.waitForRender()
  const flat = viewOf(h.vt).replace(/\n/g, ' ').replace(/\s+/g, ' ')
  assert.ok(flat.includes('gateway rejected the roster read'), `the reason head must be readable:\n${viewOf(h.vt)}`)
  assert.ok(flat.includes('retry after the Host settles'), `the reason tail must be readable (no row truncation):\n${viewOf(h.vt)}`)
  assert.ok(viewOf(h.vt).includes('Retry') && viewOf(h.vt).includes('Close [Esc]'),
    `the recovery bar must survive the wrapped reason:\n${viewOf(h.vt)}`)
  const bottom = linesOf(h.vt).findIndex(line => line.includes('╰'))
  assert.ok(linesOf(h.vt)[bottom - 1]?.includes('Retry'), `the bar stays the last content row:\n${viewOf(h.vt)}`)
  h.app.dispose()
})

test('a newer panel mounted from a synchronous focus callback wins the mount window', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const stub = (body: string, onFirstFocus?: () => void, onDispose?: () => void) => {
    let focusedValue = false
    let disposed = 0
    return {
      get focused() { return focusedValue },
      set focused(value: boolean) {
        const was = focusedValue
        focusedValue = value
        if (value && !was) onFirstFocus?.()
      },
      get disposedCount() { return disposed },
      render: () => [body],
      invalidate: () => {},
      setMaxRows: () => {},
      dispose: () => {
        disposed += 1
        onDispose?.()
      },
    }
  }
  let panelB: ReturnType<typeof stub> | undefined
  let closerB: (() => void) | undefined
  const panelA = stub('A-mount-window-body', () => {
    if (panelB !== undefined) return
    panelB = stub('B-newer-mount-body')
    closerB = app.openPresetPicker(panelB)
  })
  const closerA = app.openPresetPicker(panelA)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('B-newer-mount-body'), `the newer mount must own the surface:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('A-mount-window-body'), `the retired mount must leave no ghost:\n${viewOf(vt)}`)
  assert.equal(panelA.disposedCount, 1, 'the superseded mount disposes its own panel exactly once')
  assert.equal(panelB?.focused, true, 'the newer mount owns the live focused seat')
  closerA() // the stale mount's closer must be inert for the newer owner
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('B-newer-mount-body'),
    `the retired mount's closer must not retire the newer owner:\n${viewOf(vt)}`)
  closerB?.()
  closerB?.() // idempotent: a repeated close never double-disposes or resurrects
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('B-newer-mount-body'), 'the current closer closes its own panel')
  assert.ok(!viewOf(vt).includes('A-mount-window-body'), 'the retired mount never resurfaces')
  assert.equal(panelB?.disposedCount, 1, 'the newer panel is disposed exactly once')
  const panelC = stub('C-after-close-body')
  const closerC = app.openPresetPicker(panelC)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('C-after-close-body'), `the slot stays usable after the window:\n${viewOf(vt)}`)
  closerC()
  await vt.waitForRender()
  assert.equal(panelC.disposedCount, 1, 'the follow-up mount closes exactly once')
  app.dispose()
})

test('a throw after a synchronous newer mount leaves the newer panel live', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const stub = (body: string, onFirstFocus?: () => void, onDispose?: () => void) => {
    let focusedValue = false
    let disposed = 0
    return {
      get focused() { return focusedValue },
      set focused(value: boolean) {
        const was = focusedValue
        focusedValue = value
        if (value && !was) onFirstFocus?.()
      },
      get disposedCount() { return disposed },
      render: () => [body],
      invalidate: () => {},
      setMaxRows: () => {},
      dispose: () => {
        disposed += 1
        onDispose?.()
      },
    }
  }
  let panelB: ReturnType<typeof stub> | undefined
  let closerB: (() => void) | undefined
  const panelA = stub('A-throw-body', () => {
    if (panelB !== undefined) return
    panelB = stub('B-survives-body')
    closerB = app.openPresetPicker(panelB)
    throw new Error('qualification focus failure')
  })
  assert.throws(() => app.openPresetPicker(panelA), /qualification focus failure/u)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('B-survives-body'),
    `the newer mount survives the failed older mount:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('A-throw-body'), `the failed mount leaves no ghost:\n${viewOf(vt)}`)
  assert.equal(panelB?.focused, true, 'the newer mount keeps the focused seat')
  closerB?.()
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('B-survives-body'), 'the surviving panel closes normally')
  assert.ok(!viewOf(vt).includes('A-throw-body'), 'the failed mount never resurfaces')
  app.dispose()
})


test('a read failure taller than the status viewport scrolls to its complete last line', async () => {
  const h = await openPanel({ hydrate: false, width: 44, rows: 20 })
  const reason = Array.from({ length: 80 }, (_, index) => `cause-${index}`).join(' ')
  h.error(reason)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('cause-0'), `the head must be readable first:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('cause-79'), `the tail starts below the viewport:\n${viewOf(h.vt)}`)
  assert.match(viewOf(h.vt), /rows 1-\d+\/\d+/u, `the scroll fact must state the position:\n${viewOf(h.vt)}`)

  h.vt.sendInput(END)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('cause-79'), `End must reach the LAST error line:\n${viewOf(h.vt)}`)
  assert.ok(viewOf(h.vt).includes('Retry') && viewOf(h.vt).includes('Close [Esc]'),
    `the real recovery actions must survive the scroll:\n${viewOf(h.vt)}`)

  h.vt.sendInput(HOME)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('cause-0'), `Home returns to the first line:\n${viewOf(h.vt)}`)

  // The search box stays editable in the error state: the error viewport owns
  // only its navigation keys.
  h.vt.sendInput('ptc')
  await h.vt.waitForRender()
  assert.ok(linesOf(h.vt).some(line => line.includes('> ptc')), `the search must stay live:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'scrolling/typing an error writes nothing')
  assert.equal(h.closes(), 0)
  h.app.dispose()
})

test('a short grant still scrolls the complete read failure without losing the exit bar', async () => {
  const h = await openPanel({ hydrate: false, width: 44, rows: 10 })
  const reason = Array.from({ length: 80 }, (_, index) => `short-cause-${index}`).join(' ')
  h.error(reason)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('short-cause-0'), `the head must be readable:\n${viewOf(h.vt)}`)
  h.vt.sendInput(END)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('short-cause-79'), `End must reach the last line on a short grant:\n${viewOf(h.vt)}`)
  const bottom = linesOf(h.vt).findIndex(line => line.includes('╰'))
  assert.ok(linesOf(h.vt)[bottom - 1]?.includes('Retry'), `the bar stays the last content row:\n${viewOf(h.vt)}`)
  assert.ok(viewOf(h.vt).includes('Close [Esc]'), `Close stays reachable:\n${viewOf(h.vt)}`)
  h.app.dispose()
})


test('a panel mounted by the previous close callback wins the new open request', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const stub = (body: string, onFirstFocus?: () => void, onDispose?: () => void) => {
    let focusedValue = false
    let disposed = 0
    return {
      get focused() { return focusedValue },
      set focused(value: boolean) {
        const was = focusedValue
        focusedValue = value
        if (value && !was) onFirstFocus?.()
      },
      get disposedCount() { return disposed },
      render: () => [body],
      invalidate: () => {},
      setMaxRows: () => {},
      dispose: () => {
        disposed += 1
        onDispose?.()
      },
    }
  }
  let panelC: ReturnType<typeof stub> | undefined
  let closerC: (() => void) | undefined
  let openedC = false
  const panelA = stub('A-old-surface-body', undefined, () => {
    if (openedC) return
    openedC = true
    panelC = stub('C-close-callback-body')
    closerC = app.openPresetPicker(panelC)
  })
  const closerA = app.openPresetPicker(panelA)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('A-old-surface-body'), viewOf(vt))

  const panelB = stub('B-losing-open-body')
  const closerB = app.openPresetPicker(panelB)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('C-close-callback-body'),
    `the panel opened by the close callback must stay the owner:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('B-losing-open-body'),
    `the late request must never mount over the newer owner:\n${viewOf(vt)}`)
  assert.equal(panelB.disposedCount, 1, 'the losing request disposes itself exactly once')
  closerB() // inert: it never owned the slot
  closerA() // inert: its panel was already retired
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('C-close-callback-body'), 'inert closers never retire the newer owner')
  closerC?.()
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('C-close-callback-body'), 'the current closer closes its own panel')
  app.dispose()
})
