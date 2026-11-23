/**
 * The REAL `/preset` presentation chain: the registered TUI command →
 * `src/tui/commands/models.ts` read/write owners → the PiTui presentation
 * adapter → the mounted `PresetPickerPanel` in the app's own root overlay slot.
 *
 * Only the Host/Config seams are scripted (the shared `preset-command-harness`
 * Direct-shaped fake); the command registration, roster read owner, tokens,
 * panel, overlay slot, pointer routing and settlements are production code.
 * Every assertion reads the real painted `VirtualTerminal` frame or the real
 * Host/Config seam — never a private panel field.
 * @module @xmoon76/dsh-pi-tui/preset-pitui-presentation.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { PresetCatalog } from '../../src/runtime/catalog-port.ts'
import type { OperationResult } from '../../src/runtime/write-outcome.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { disposeHarnessApps, fakeAgent, setup, SHIPPED_ROWS } from '../support/preset-command-harness.ts'

afterEach(() => {
  disposeHarnessApps()
})

type Harness = ReturnType<typeof setup>

const plain = (vt: VirtualTerminal): string[] => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
const viewOf = (vt: VirtualTerminal): string => plain(vt).join('\n')
const rowOf = (vt: VirtualTerminal, needle: string): number => {
  const row = plain(vt).findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the frame must contain ${JSON.stringify(needle)}:\n${viewOf(vt)}`)
  return row
}
const cellIndexOf = (vt: VirtualTerminal, row: number, needle: string): number => {
  const line = plain(vt)[row] ?? ''
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}:\n${line}`)
  return visibleWidth(line.slice(0, index))
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
async function waitForText(t: Harness, needle: string): Promise<void> {
  await waitUntil(() => viewOf(t.vt).includes(needle), JSON.stringify(needle))
}
const ENTER = '\r'
const TAB = '\t'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'

/** One raw SGR left press/release at a 0-based terminal cell. */
function sgrPress(vt: VirtualTerminal, col: number, row: number): void {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
function sgrRelease(vt: VirtualTerminal, col: number, row: number): void {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}
function clickText(t: Harness, needle: string): void {
  const row = rowOf(t.vt, needle)
  const col = cellIndexOf(t.vt, row, needle) + Math.floor(visibleWidth(needle) / 2)
  sgrPress(t.vt, col, row)
  sgrRelease(t.vt, col, row)
}

/** The row fixture the command-plane fake publishes (the shipped declarations
 *  publish no name/description; the TUI's own English copy supplies them). */
const ROWS = [
  ...SHIPPED_ROWS,
  { id: 'reviewer', name: 'My reviewer', description: 'Reviews diffs before merge.' },
]

/** The live DTO of that roster. */
const ROSTER_DTO = {
  presets: [
    { id: 'standard', isDefault: true },
    { id: 'ptc' },
    { id: 'minimal' },
    { id: 'cordis' },
    { id: 'reviewer', name: 'My reviewer', description: 'Reviews diffs before merge.' },
  ],
}

/** A complete scripted preset port for the outcome family. */
function fakePresetPort(options: {
  select?: (id: string) => Promise<OperationResult<{ readonly preset: string }>>
  roster?: () => Promise<unknown>
} = {}): PresetCatalog {
  return {
    available: () => true,
    roster: async () => (options.roster === undefined ? ROSTER_DTO : await options.roster()) as never,
    resolve: async (id?: string) => ({ id: id ?? 'standard' }),
    defaultId: () => 'standard',
    selectSessionPreset: async (_sessionId, id) => options.select === undefined
      ? { ownership: 'current', outcome: { kind: 'committed', value: { preset: id } } }
      : options.select(id),
  }
}

/* ------------------------------------------------- real sessionless chain */

test('real /preset: immediate Loading → Ready Catalog → pointer browse/Details/Back → explicit Use next', async () => {
  const gate = deferred<unknown>()
  let rosterCalls = 0
  const t = setup({
    roster: async () => {
      rosterCalls += 1
      return await gate.promise
    },
    width: 100,
    height: 30,
  })
  t.app.setFullscreen(true)
  await t.run('')
  // The intermediate Loading frame is observable BEFORE the read settles.
  await waitForText(t, 'Agent presets')
  assert.ok(viewOf(t.vt).includes('Loading agent presets…'), `the Catalog must mount in Loading:\n${viewOf(t.vt)}`)
  assert.ok(!viewOf(t.vt).includes('Use next'), 'no write action before the roster settles')
  gate.resolve(ROSTER_DTO)
  await waitForText(t, 'Standard mode (standard)')
  assert.equal(rosterCalls, 1, 'one command-owned roster read')
  assert.ok(viewOf(t.vt).includes('Built-in · 4') && viewOf(t.vt).includes('Custom · 1'),
    `the ready Catalog groups the roster:\n${viewOf(t.vt)}`)

  // FIRST pointer click on a not-selected row: browse only.
  const ptcRow = rowOf(t.vt, 'PTC mode (ptc)')
  const ptcCol = cellIndexOf(t.vt, ptcRow, 'PTC mode (ptc)') + 2
  sgrPress(t.vt, ptcCol, ptcRow)
  sgrRelease(t.vt, ptcCol, ptcRow)
  await t.vt.waitForRender()
  assert.ok(!viewOf(t.vt).includes('Preset details'), `the first click only browses:\n${viewOf(t.vt)}`)
  assert.equal(t.pending.value, undefined, 'browsing never stages a preset')

  // SECOND click on the now-selected row opens the read-only Details.
  const selectedRow = rowOf(t.vt, '[draft]')
  const selectedCol = cellIndexOf(t.vt, selectedRow, 'PTC mode (ptc)') + 2
  sgrPress(t.vt, selectedCol, selectedRow)
  sgrRelease(t.vt, selectedCol, selectedRow)
  await waitForText(t, 'Preset details · PTC mode')
  assert.ok(viewOf(t.vt).includes('ID') && viewOf(t.vt).includes('ptc'), viewOf(t.vt))
  assert.ok(viewOf(t.vt).includes('Use next') && viewOf(t.vt).includes('Set default') && viewOf(t.vt).includes('Enter actions'),
    `Details carries the shared writer bar and the Enter hint:\n${viewOf(t.vt)}`)
  assert.equal(t.pending.value, undefined)

  // The Back row is the pointer way back; query/selection survive.
  clickText(t, 'Back [Esc]')
  await waitForText(t, 'Agent presets')
  assert.ok(viewOf(t.vt).includes('PTC mode (ptc)'), 'Back keeps the Catalog target')

  // The EXPLICIT bottom action is the ONE writer: it stages the run-local
  // pending preset and creates no Session.
  clickText(t, 'Use next')
  await waitUntil(() => t.pending.value === 'ptc', 'the pending preset stage')
  assert.deepEqual(t.ensureCalls, [], 'Use next never creates a Session')
  assert.deepEqual(t.presets.selected, [], 'a sessionless subject never writes the Host')
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the panel close after the committed action')
})

/* ------------------------------------------------------ real blank chain */

test('real /preset on a blank Session commits through the Host writer exactly once', async () => {
  const t = setup({ agent: fakeAgent('s1', []), sessionBlank: true, width: 100, height: 30 })
  await t.run('')
  await waitForText(t, 'Agent presets')
  await waitForText(t, 'Standard mode (standard)')
  // Reading Details never writes.
  t.vt.sendInput(ENTER)
  await waitForText(t, 'Preset details · Standard mode')
  assert.deepEqual(t.presets.selected, [])
  t.vt.sendInput(ESC)
  await waitForText(t, 'Agent presets')
  // The explicit Use session action is the ONE Host write.
  t.vt.sendInput(TAB)
  t.vt.sendInput(ENTER)
  await waitUntil(() => t.presets.selected.length === 1, 'the Host selection')
  assert.deepEqual(t.presets.selected, ['standard'])
  assert.equal(t.pending.value, undefined, 'a live subject never stages the run-local pending preset')
  await waitForText(t, 'session preset switched to standard')
})

/* ------------------------------------------------ started Session refusal */

test('a started Session refuses the bare picker and keeps the typed verbs intact', async () => {
  const writes: unknown[] = []
  const t = setup({
    agent: fakeAgent('s1', [{ type: 'turn/start' }]),
    sessionBlank: false,
    selectLocked: true,
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const refused = await t.run('') as { kind: string; text: string }
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /only available in a new session/)
  await t.vt.waitForRender()
  assert.ok(!viewOf(t.vt).includes('Agent presets'), `no selectable UI for a started Session:\n${viewOf(t.vt)}`)
  assert.deepEqual(t.presets.selected, [])
  // `/preset default <id>` still writes the FUTURE default (typed verb only).
  const saved = await t.run('default minimal') as { kind: string; text: string }
  assert.deepEqual(saved, { kind: 'success', text: 'default preset set: minimal' })
  assert.deepEqual(writes, [[{ op: 'set', path: ['selectedDefault'], value: 'minimal' }]])
  assert.deepEqual(t.presets.selected, [], 'saving the default never changes the current Session')
  // A typed `/preset <id>` on the started Session stays Host-locked.
  const locked = await t.run('minimal') as { kind: string; text: string }
  assert.equal(locked.kind, 'error')
  assert.deepEqual(t.presets.selected, [], 'the started Session never accepts a switch')
})

/* ------------------------------------------------ roster read lifecycle */

test('a failed roster read is an in-panel Error and Retry re-enters the SAME read owner once', async () => {
  let calls = 0
  const t = setup({
    roster: async () => {
      calls += 1
      if (calls === 1) throw new Error('connection refused by the Host')
      return { presets: SHIPPED_ROWS }
    },
  })
  await t.run('')
  await waitForText(t, 'Preset catalog unavailable')
  assert.ok(viewOf(t.vt).includes('connection refused by the Host'), viewOf(t.vt))
  assert.ok(viewOf(t.vt).includes('Retry') && viewOf(t.vt).includes('Close [Esc]'), viewOf(t.vt))
  // Retry through the visible footer; the panel re-enters Loading.
  t.vt.sendInput(TAB)
  t.vt.sendInput(ENTER)
  await waitForText(t, 'Standard mode (standard)')
  assert.equal(calls, 2, 'Retry asks the command read owner exactly one more read')
  assert.ok(!viewOf(t.vt).includes('Preset catalog unavailable'), 'the error is replaced by the hydrated Catalog')
})

test('a roster response that settles after a Session switch never hydrates a ghost overlay', async () => {
  const gate = deferred<unknown>()
  const state = { agent: fakeAgent('s1', []) as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    sessionBlank: true,
    roster: async () => await gate.promise,
  })
  await t.run('')
  await waitForText(t, 'Loading agent presets…')
  state.agent = fakeAgent('s2', [])
  state.generation = 2
  gate.resolve(ROSTER_DTO)
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the stale panel retirement')
  assert.deepEqual(t.presets.selected, [], 'the stale read never switches the new Session')
})

test('a late roster response after the panel was closed paints no ghost', async () => {
  const gate = deferred<unknown>()
  const t = setup({ roster: async () => await gate.promise })
  await t.run('')
  await waitForText(t, 'Loading agent presets…')
  t.vt.sendInput(ESC)
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the user close')
  gate.resolve(ROSTER_DTO)
  await new Promise<void>(resolve => setImmediate(resolve))
  await t.vt.waitForRender()
  assert.ok(!viewOf(t.vt).includes('Agent presets'), `a late read must never reopen the panel:\n${viewOf(t.vt)}`)
  assert.equal(t.pending.value, undefined)
})

/* ------------------------------------------------------- default writer */

test('the explicit Set default action runs the ONE Config writer and refreshes only when unmasked', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }); return undefined },
    },
    refreshCatalog: async () => ({ kind: 'applied', snapshot: {} as never }),
  })
  await t.run('')
  await waitForText(t, 'Agent presets')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput(DOWN) // standard -> ptc
  await t.vt.waitForRender()
  t.vt.sendInput(TAB)
  await t.vt.waitForRender()
  t.vt.sendInput(TAB) // Use next -> Set default
  await t.vt.waitForRender()
  t.vt.sendInput(ENTER)
  await waitUntil(() => mutated.length === 1, 'the Config write')
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'ptc' }])
  await waitUntil(() => t.refreshes.length === 1, 'the standing refresh')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  assert.equal(t.pending.value, undefined, 'Set default never rewrites the pending preset')
  await waitForText(t, 'new-session default set: ptc')
  t.app.dispose()

  // A masked effective preset (pending/launch override) suppresses the refresh.
  mutated.length = 0
  const masked = setup({
    effectivePresetId: 'standard',
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }); return undefined },
    },
    refreshCatalog: async () => ({ kind: 'applied', snapshot: {} as never }),
  })
  await masked.run('')
  await waitForText(masked, 'Agent presets')
  await waitForText(masked, 'Standard mode (standard)')
  masked.vt.sendInput(DOWN)
  await masked.vt.waitForRender()
  masked.vt.sendInput(TAB)
  await masked.vt.waitForRender()
  masked.vt.sendInput(TAB)
  await masked.vt.waitForRender()
  masked.vt.sendInput(ENTER)
  await waitUntil(() => mutated.length === 1, 'the masked Config write')
  assert.deepEqual(masked.refreshes, [], 'a masked default change must not refresh the standing catalog')
})

/* ------------------------------------------------------- all outcomes */

test('a rejected Host switch keeps the ready Catalog and states the real reason', async () => {
  const calls: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: fakePresetPort({
      select: async (id) => {
        calls.push(id)
        return { ownership: 'current', outcome: { kind: 'rejected', error: { code: 'agent-preset/refused', message: 'host refused this preset' } } }
      },
    }),
  })
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput(TAB)
  t.vt.sendInput(ENTER)
  await waitForText(t, 'host refused this preset')
  assert.deepEqual(calls, ['standard'], 'the refused switch dispatched exactly once')
  assert.ok(viewOf(t.vt).includes('Use session') && viewOf(t.vt).includes('Set default'),
    `a refusal keeps the picker usable:\n${viewOf(t.vt)}`)
  // No implicit retry on the settlement.
  await t.vt.waitForRender()
  assert.deepEqual(calls, ['standard'])
})

test('a locked Host switch keeps the Catalog and names the started Session', async () => {
  const calls: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: fakePresetPort({
      select: async (id) => {
        calls.push(id)
        return { ownership: 'current', outcome: { kind: 'rejected', error: { code: 'agent-preset/locked', message: 'session has already started' } } }
      },
    }),
  })
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput(TAB)
  t.vt.sendInput(ENTER)
  await waitForText(t, 'Locked: this session has already started.')
  assert.deepEqual(calls, ['standard'])
  assert.ok(viewOf(t.vt).includes('Agent presets'), 'a locked refusal keeps the ready Catalog')
})

test('an indeterminate Host switch closes the panel and never invites a retry', async () => {
  const calls: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: fakePresetPort({
      select: async (id) => {
        calls.push(id)
        return { ownership: 'current', outcome: { kind: 'indeterminate', error: { code: 'agent-preset/select-indeterminate', message: 'recompose ran but the append failed' } } }
      },
    }),
  })
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput(TAB)
  t.vt.sendInput(ENTER)
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the indeterminate dismissal')
  assert.deepEqual(calls, ['standard'], 'exactly one dispatch, no automatic retry')
  assert.match(viewOf(t.vt), /do not\s+retry/u, `the indeterminate notice must be truthful:\n${viewOf(t.vt)}`)
})

test('an unconfirmed default write dismisses the panel without claiming a rollback', async () => {
  let writes = 0
  const t = setup({
    settings: {
      get: () => undefined,
      mutate: async () => { writes += 1; throw new Error('settings file is read-only') },
    },
  })
  await t.run('')
  await waitForText(t, 'Agent presets')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput(DOWN)
  await t.vt.waitForRender()
  t.vt.sendInput(TAB)
  await t.vt.waitForRender()
  t.vt.sendInput(TAB)
  await t.vt.waitForRender()
  t.vt.sendInput(ENTER)
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the unconfirmed dismissal')
  assert.equal(writes, 1, 'the failed settings mutation is never retried')
  const view = viewOf(t.vt)
  assert.ok(view.includes('settings file is read-only'), `the real failure must be visible:\n${view}`)
  assert.ok(!/rollback|rolled back/i.test(view), `never claim a rollback:\n${view}`)
})

test('Close during an admitted write dismisses the UI but never cancels the Host write', async () => {
  const gate = deferred<OperationResult<{ readonly preset: string }>>()
  const calls: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: fakePresetPort({
      select: async (id) => {
        calls.push(id)
        return await gate.promise
      },
    }),
  })
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput(TAB)
  t.vt.sendInput(ENTER)
  await waitForText(t, 'Applying preset…')
  assert.deepEqual(calls, ['standard'])
  assert.ok(!viewOf(t.vt).includes('Use session'), 'an admitted write offers only Close')
  t.vt.sendInput(ESC)
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the pending dismissal')
  gate.resolve({ ownership: 'current', outcome: { kind: 'committed', value: { preset: 'standard' } } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['standard'], 'the admitted Host write still settled exactly once')
  await waitForText(t, 'session preset switched to standard')
})

/* ------------------------------------------------------ overlay lifecycle */

test('one /preset invocation owns one overlay: a newer one retires the previous panel', async () => {
  const t = setup({ width: 100, height: 30, rows: ROWS })
  await t.run('')
  await waitForText(t, 'Agent presets')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput('rev')
  await waitForText(t, 'My reviewer')
  // A second bare invocation retires the first panel and mounts its own.
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  const headers = plain(t.vt).filter(line => line.includes('Agent presets'))
  assert.equal(headers.length, 1, `exactly one logical preset overlay:\n${viewOf(t.vt)}`)
})

test('a fullscreen swap keeps the SAME panel state (query + selection)', async () => {
  const t = setup({ width: 100, height: 30, rows: ROWS })
  await t.run('')
  await waitForText(t, 'Agent presets')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput('rev')
  await waitForText(t, 'My reviewer')
  t.app.setFullscreen(true)
  await t.vt.waitForRender()
  assert.ok(viewOf(t.vt).includes('My reviewer'), `the query survives the screen swap:\n${viewOf(t.vt)}`)
  assert.ok(!viewOf(t.vt).includes('PTC mode (ptc)'), 'the filter still applies after the remount')
  t.app.setFullscreen(false)
  await t.vt.waitForRender()
  assert.ok(viewOf(t.vt).includes('My reviewer'), `the panel survives the return swap:\n${viewOf(t.vt)}`)
  const headers = plain(t.vt).filter(line => line.includes('Agent presets'))
  assert.equal(headers.length, 1, `one logical overlay after both swaps:\n${viewOf(t.vt)}`)
})

test('a blocking Approval suspends the panel and restores the SAME hydrated instance', async () => {
  const t = setup({ width: 100, height: 30 })
  await t.run('')
  await waitForText(t, 'Agent presets')
  await waitForText(t, 'Standard mode (standard)')
  void t.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await waitForText(t, 'Approve bash?')
  assert.ok(!viewOf(t.vt).includes('Agent presets'), `the blocking owner suspends the panel:\n${viewOf(t.vt)}`)
  t.vt.sendInput('y')
  await waitForText(t, 'Agent presets')
  assert.ok(viewOf(t.vt).includes('Standard mode (standard)'),
    `the restored panel keeps its hydrated rows:\n${viewOf(t.vt)}`)
})

test('the app final dispose releases the panel slot for a later surface', async () => {
  const first = setup({ width: 100, height: 30 })
  await first.run('')
  await waitForText(first, 'Agent presets')
  first.app.dispose()
  // A fresh app can claim the process slot and mount its own panel: the retired
  // surface kept neither the slot nor a live overlay callback.
  const second = setup({ width: 100, height: 30 })
  await second.run('')
  await waitForText(second, 'Agent presets')
  await waitForText(second, 'Standard mode (standard)')
  second.app.dispose()
})

/* ---------------------------------------- AltScreen pointer-only journey */

test('AltScreen SGR journey: browse → details → Back → explicit pointer Use → one sink', async () => {
  const t = setup({ width: 100, height: 30, rows: ROWS })
  t.app.setFullscreen(true)
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  // Search narrows by the COMPLETE identity; browse target follows the filter.
  t.vt.sendInput('rev')
  await waitForText(t, 'My reviewer')
  await waitForText(t, '[draft]')
  const row = rowOf(t.vt, 'My reviewer (reviewer)')
  const col = cellIndexOf(t.vt, row, 'My reviewer (reviewer)') + 2
  // First click on the selected row IS the activation (it was already the
  // highlight); a click on another row first would only browse.
  sgrPress(t.vt, col, row)
  sgrRelease(t.vt, col, row)
  await waitForText(t, 'Preset details · My reviewer')
  assert.ok(viewOf(t.vt).includes('Custom'), 'Details identifies the Custom type')
  clickText(t, 'Back [Esc]')
  await waitForText(t, 'Agent presets')
  assert.ok(viewOf(t.vt).includes('rev'), 'Back keeps the search query')
  clickText(t, 'Use next')
  await waitUntil(() => t.pending.value === 'reviewer', 'the pointer writer sink')
  assert.deepEqual(t.ensureCalls, [], 'the pointer primary action creates no Session')
  assert.deepEqual(t.presets.selected, [], 'the sessionless pointer action never writes the Host')
})

test('AltScreen pointer negatives: stale press after resize, disabled action and press/release mismatch', async () => {
  const t = setup({ width: 100, height: 30 })
  t.app.setFullscreen(true)
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  // A press, then a terminal resize, then the release: the geometry moved, so
  // nothing may commit.
  let row = rowOf(t.vt, 'Use next')
  let col = cellIndexOf(t.vt, row, 'Use next') + 2
  sgrPress(t.vt, col, row)
  t.vt.resize(80, 24)
  await t.vt.waitForRender()
  sgrRelease(t.vt, col, row)
  assert.equal(t.pending.value, undefined, 'a release against resized geometry writes nothing')

  // A disabled action has no painted pointer target.
  row = rowOf(t.vt, 'Set default')
  col = cellIndexOf(t.vt, row, 'Set default') + 2
  sgrPress(t.vt, col, row)
  sgrRelease(t.vt, col, row)
  await t.vt.waitForRender()
  assert.equal(t.pending.value, undefined, 'the default row installs nothing through Set default')
  assert.deepEqual(t.presets.selected, [])

  // Press on one action, release on another: no action runs.
  const useRow = rowOf(t.vt, 'Use next')
  const useCol = cellIndexOf(t.vt, useRow, 'Use next') + 2
  const closeRow = rowOf(t.vt, 'Close [Esc]')
  const closeCol = cellIndexOf(t.vt, closeRow, 'Close [Esc]') + 2
  sgrPress(t.vt, useCol, useRow)
  sgrRelease(t.vt, closeCol, closeRow)
  await t.vt.waitForRender()
  assert.equal(t.pending.value, undefined, 'a press/release mismatch writes nothing')
  assert.ok(viewOf(t.vt).includes('Agent presets'), 'a mismatched release also does not close')
})

test('real /preset: Details reader Enter focuses first; the second Enter writes the shared Use', async () => {
  const t = setup({ width: 100, height: 30 })
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput('\r')
  await waitForText(t, 'Preset details · Standard mode')
  assert.equal(t.pending.value, undefined, 'opening Details never writes')
  assert.ok(viewOf(t.vt).includes('Enter actions'), viewOf(t.vt))
  t.vt.sendInput('\r')
  await t.vt.waitForRender()
  assert.ok(viewOf(t.vt).includes('Use next [Enter]'), `the first Enter only focuses:\n${viewOf(t.vt)}`)
  assert.equal(t.pending.value, undefined, 'the focus move is zero-write')
  t.vt.sendInput('\r')
  await waitUntil(() => t.pending.value === 'standard', 'the explicit Details Use write')
  await waitUntil(() => !viewOf(t.vt).includes('Agent presets'), 'the panel closes after the write')
  assert.deepEqual(t.ensureCalls, [], 'Use next still creates no Session')
})

test('real /preset: Details Tab→Tab→Enter saves the default and syncs the blank Session', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    width: 100,
    height: 30,
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
  })
  await t.run('')
  await waitForText(t, 'Standard mode (standard)')
  t.vt.sendInput('\x1b[B') // standard -> ptc
  await t.vt.waitForRender()
  t.vt.sendInput('\r')
  await waitForText(t, 'Preset details · PTC mode')
  t.vt.sendInput('\t')
  await t.vt.waitForRender()
  t.vt.sendInput('\t')
  await t.vt.waitForRender()
  assert.ok(viewOf(t.vt).includes('Set default [Enter]'), `the flat ring reaches Default:\n${viewOf(t.vt)}`)
  t.vt.sendInput('\r')
  await waitUntil(() => mutated.length === 1, 'the Config default write')
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'ptc' }])
  await waitUntil(() => t.presets.selected.includes('ptc'), 'the blank Session sync')
  assert.deepEqual(t.presets.selected, ['ptc'], 'one shared selection writer ran once')
  await waitForText(t, 'current blank session switched to ptc')
})
