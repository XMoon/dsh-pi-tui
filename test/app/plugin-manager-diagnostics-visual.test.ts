/**
 * C4 Diagnostics page — responsive/mouse/legacy-key contract. The page must
 * stay readable and copyable at the frozen size matrix, wrap a long Host
 * error without ellipsizing it, gate pointer actions on the LAST painted
 * frame, and leave the existing Details/Install `c` semantics untouched.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-diagnostics-visual.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  formatTuiContributionDiagnostic,
  serializeTuiExtensionDiagnostics,
  type TuiContributionDiagnostic,
  type TuiExtensionDiagnostics,
} from '../../src/app/plugin-manager/extension-inventory.ts'
import { openWorkspace, plain, type WorkspaceHarness } from '../support/plugin-workspace-harness.ts'

const started = new Set<WorkspaceHarness>()
afterEach(() => {
  for (const harness of [...started]) {
    started.delete(harness)
    try { harness.app.dispose() } catch {}
  }
})

async function open(
  diagnostics: () => TuiExtensionDiagnostics | undefined,
  columns: number,
  rows: number,
): Promise<WorkspaceHarness> {
  const harness = await openWorkspace({ columns, rows, diagnostics })
  started.add(harness)
  return harness
}

/** Reason: the real Plugin Manager harness pumps its queued render/microtask
 *  work; this is not a time-based product window. */
async function settleHarness(harness: WorkspaceHarness): Promise<void> {
  await harness.settle() // reason: harness pump, not a deadline
}

function view(entries: readonly TuiContributionDiagnostic[], unmapped: readonly TuiContributionDiagnostic[] = []): TuiExtensionDiagnostics {
  return {
    entries,
    unmappedEntries: unmapped,
    contributionTotals: {
      total: entries.length + unmapped.length,
      active: [...entries, ...unmapped].filter(entry => entry.state === 'active').length,
      failed: [...entries, ...unmapped].filter(entry => entry.state === 'failed').length,
      shadowed: [...entries, ...unmapped].filter(entry => entry.state === 'shadowed').length,
      other: 0,
    },
    registryCounts: { commands: 3, themes: 0, settings: 1, autocomplete: 0, keybindings: 0, renderers: 2, editors: 0 },
    capabilities: ['surface.snapshot', 'slot.input.widget'],
    healthSummary: [...entries, ...unmapped].some(entry => entry.state === 'failed')
      ? `${[...entries, ...unmapped].filter(entry => entry.state === 'failed').length} failed`
      : 'all active',
  }
}

function entry(overrides: Partial<TuiContributionDiagnostic> = {}): TuiContributionDiagnostic {
  return {
    owner: 'uid:owner-a',
    entryId: 'entry-a',
    extensionPoint: 'transcript.tool.renderer',
    id: 'broken-renderer',
    state: 'failed',
    lastError: 'renderer exploded',
    ...overrides,
  }
}

function plainRow(viewport: readonly string[], row: number): string {
  return plain([viewport[row] ?? ''])
}

function rowOf(viewport: readonly string[], needle: string, from = 0): number {
  for (let row = from; row < viewport.length; row += 1) {
    if (plain([viewport[row]!]).includes(needle)) return row
  }
  assert.fail(`the painted frame must contain ${JSON.stringify(needle)}:\n${plain(viewport)}`)
}

function cellIndexOf(viewport: readonly string[], row: number, needle: string): number {
  const line = plainRow(viewport, row)
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `row ${row} must contain ${JSON.stringify(needle)}:\n${line}`)
  return visibleWidth(line.slice(0, index))
}

const press = (harness: WorkspaceHarness, row: number, column: number): void => {
  harness.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
}
const release = (harness: WorkspaceHarness, row: number, column: number): void => {
  harness.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
}

/** The Copy button row for one contribution (the button is painted on the
 *  block's last wrapped row — the error row when one exists). */
function contributionCopyRow(viewport: readonly string[], id: string): number {
  const header = rowOf(viewport, `transcript.tool.renderer:${id}`)
  for (let row = header; row < viewport.length; row += 1) {
    if (plainRow(viewport, row).includes(' Copy [C]')) return row
  }
  assert.fail(`no painted Copy button for ${id}:\n${plain(viewport)}`)
}

test('the frozen size matrix paints within the width and the last fact stays reachable', async () => {
  const diagnostics = view([
    entry({ id: 'first-renderer' }),
    entry({ id: 'last-renderer', owner: 'uid:owner-b', entryId: 'entry-b', state: 'active', lastError: undefined }),
  ])
  for (const [columns, rows] of [[30, 8], [44, 20], [80, 24], [120, 40], [200, 50]] as const) {
    const harness = await open(() => diagnostics, columns, rows)
    try {
      harness.vt.sendInput('d')
      await settleHarness(harness)
      assert.equal(harness.panel.currentView(), 'diagnostics', `${columns}x${rows}`)
      const frame = harness.viewport()
      for (const line of frame) {
        assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} painted an overflowing row: ${JSON.stringify(plain([line]))}`)
      }
      assert.match(plain(frame), /Settings · Plugins/u, `${columns}x${rows} keeps the ONE Settings header`)
      // The 30-column header may truncate the trail, but the diagnostics page is
      // the painted view in every case.
      assert.match(plain(frame), /Diagnost/u, `${columns}x${rows} names the diagnostics page`)
      // End selects the LAST fact and reveals it even at 30x8.
      harness.vt.sendInput('\x1b[F')
      await settleHarness(harness)
      assert.ok(
        plain(harness.viewport()).replace(/\s+/g, '').includes('last-renderer'),
        `${columns}x${rows} must reveal the last fact:\n${plain(harness.viewport())}`,
      )
      // C copies the whole snapshot (the keyboard route never depends on paint).
      harness.vt.sendInput('C')
      await settleHarness(harness)
      assert.equal(harness.copied.at(-1), serializeTuiExtensionDiagnostics(diagnostics), `${columns}x${rows}`)
    } finally {
      started.delete(harness)
      harness.app.dispose()
    }
  }
})

test('at 30x8 a long CJK Host error starts at its identity and is fully reachable by PgDn', async () => {
  const errorText = `renderer callback failed: ${'长鲸错'.repeat(40)} [END]`
  const diagnostics = view([entry({ lastError: errorText })])
  const harness = await open(() => diagnostics, 30, 8)
  try {
    harness.vt.sendInput('d')
    await settleHarness(harness)
    // Select the contribution (Health -> Registries -> Capabilities -> entry).
    for (let step = 0; step < 3; step += 1) {
      harness.vt.sendInput('\x1b[B')
      await settleHarness(harness)
    }
    // A fact taller than the 3-row body must reveal its FIRST line: the
    // cursor, extensionPoint:id and the state chip are all visible.
    const start = plain(harness.viewport())
    assert.match(start, />/)
    assert.match(start, /transcript\.tool\.renderer/)
    assert.match(start, /\[failed\]/)
    // Reachability is the contract (the bar drops whole segments on a 30-cell
    // row); the paging hint is advertised from 80 columns up.
    assert.match(start, /Esc back/u, 'the real Esc destination is always advertised')
    // Page to the END of the block: the unique tail marker proves the last
    // physical error row is reachable by keyboard (overlapping page frames
    // make a naive concatenation non-contiguous).
    let sawCjk = false
    let sawTail = false
    for (let page = 0; page < 20; page += 1) {
      harness.vt.sendInput('\x1b[6~') // PgDn
      await settleHarness(harness)
      const frame = plain(harness.viewport())
      if (frame.includes('长鲸错')) sawCjk = true
      if (frame.includes('[END]')) sawTail = true
    }
    assert.match(start, /renderer callback/, 'the error block starts on the selected fact\'s next row')
    assert.ok(sawCjk, 'the CJK error text is painted while paging')
    assert.ok(sawTail, 'the final error row is reachable by keyboard scrolling')
    // Paging WITHIN one too-tall fact keeps its identity/state sticky at
    // the top: the cursor is visible and `c` copies the same fact, never an
    // unidentifiable offscreen block.
    const paged = plain(harness.viewport())
    assert.match(paged, />/)
    assert.match(paged, /transcript\.tool\.renderer/)
    assert.match(paged, /\[failed\]/)
    harness.vt.sendInput('c')
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry({ lastError: errorText })),
      'the sticky selected fact copies its full value')
    // End is already on the last fact; it must still re-reveal the start
    // after the wheel/page scroll moved the offset.
    harness.vt.sendInput('\x1b[F') // End
    await settleHarness(harness)
    const revealed = plain(harness.viewport())
    assert.match(revealed, />/)
    assert.match(revealed, /transcript\.tool\.renderer/)
    assert.match(revealed, /\[failed\]/)
    harness.vt.sendInput('c')
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry({ lastError: errorText })))
    assert.match(harness.copied.at(-1) ?? '', /\[END\]/)
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})

test('30x8 PgDn covers every error row with sticky identity heads', async () => {
  const tokens = Array.from({ length: 40 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)
  const errorText = tokens.join(' ')
  // A long id makes the identity wrap to three rows — equal to the body
  // height — so the sticky head must reserve one continuation row.
  const longId = `broken-renderer-${'x'.repeat(60)}`
  const diagnostics = view([entry({ id: longId, lastError: errorText })])
  const harness = await open(() => diagnostics, 30, 8)
  try {
    harness.vt.sendInput('d')
    await settleHarness(harness)
    for (let step = 0; step < 3; step += 1) {
      harness.vt.sendInput('\x1b[B')
      await settleHarness(harness)
    }
    let union = ''
    for (let page = 0; page < 24; page += 1) {
      union += plain(harness.viewport())
      if (tokens.every(token => union.includes(token))) break
      harness.vt.sendInput('\x1b[6~') // PgDn
      await settleHarness(harness)
    }
    const missing = tokens.filter(token => !union.includes(token))
    assert.deepEqual(missing, [], 'every error token row must be reachable through PgDn')
    harness.vt.sendInput('\x1b[F') // End: reveal the selected fact start.
    await settleHarness(harness)
    harness.vt.sendInput('c')
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry({ id: longId, lastError: errorText })))
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})

test('PgDn keeps a visible fact selected; Home re-reveals the first fact', async () => {
  const diagnostics = view([
    entry({ id: 'first-renderer', lastError: 'first error' }),
    entry({ id: 'second-renderer', owner: 'uid:owner-b', entryId: 'entry-b', lastError: 'second error' }),
  ])
  const harness = await open(() => diagnostics, 30, 8)
  try {
    harness.vt.sendInput('d')
    await settleHarness(harness)
    // Select the first contribution (Health -> Registries -> Capabilities).
    for (let step = 0; step < 3; step += 1) {
      harness.vt.sendInput('\x1b[B')
      await settleHarness(harness)
    }
    assert.match(plain(harness.viewport()), /^> .*fir/mu, 'the first fact starts selected')
    // Page down until the first fact leaves the body: the page-scroll model
    // moves the selection to the first VISIBLE fact, so `c` is never offscreen.
    let sawSecond = false
    for (let page = 0; page < 8; page += 1) {
      harness.vt.sendInput('\x1b[6~') // PgDn
      await settleHarness(harness)
      if (/^> .*sec/mu.test(plain(harness.viewport()))) {
        sawSecond = true
        break
      }
    }
    assert.ok(sawSecond, 'PgDn selects a fact that is visible on the new page')
    harness.vt.sendInput('\x1b[H') // Home
    await settleHarness(harness)
    assert.match(plain(harness.viewport()), /^> Health/mu, 'Home re-reveals the first fact (Health)')
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})

test('mouse Copy / Copy All / Back act only on the last-painted whole affordance', async () => {
  const diagnostics = view([entry()])
  const harness = await open(() => diagnostics, 120, 40)
  try {
    harness.vt.sendInput('d')
    await settleHarness(harness)
    const frame = harness.viewport()
    const copyRow = contributionCopyRow(frame, 'broken-renderer')
    const copyColumn = cellIndexOf(frame, copyRow, ' Copy [C]') + 3
    press(harness, copyRow, copyColumn)
    await settleHarness(harness)
    assert.deepEqual(harness.copied, [], 'a press alone never copies')
    release(harness, copyRow, copyColumn)
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry()))

    const afterCopy = harness.viewport()
    const allRow = rowOf(afterCopy, 'Copy All [C]')
    const allColumn = cellIndexOf(afterCopy, allRow, 'Copy All [C]') + 3
    press(harness, allRow, allColumn)
    await settleHarness(harness)
    release(harness, allRow, allColumn)
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), serializeTuiExtensionDiagnostics(diagnostics))

    const afterAll = harness.viewport()
    const backRow = rowOf(afterAll, 'Back')
    const backColumn = cellIndexOf(afterAll, backRow, 'Back') + 1
    press(harness, backRow, backColumn)
    await settleHarness(harness)
    release(harness, backRow, backColumn)
    await settleHarness(harness)
    assert.equal(harness.panel.currentView(), 'list')
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})

test('wrong-row, resize and reread stale releases never copy or navigate', async () => {
  const diagnostics = view([
    entry({ id: 'first-renderer' }),
    entry({ id: 'second-renderer', owner: 'uid:owner-b', entryId: 'entry-b' }),
  ])
  const harness = await open(() => diagnostics, 120, 40)
  try {
    harness.vt.sendInput('d')
    await settleHarness(harness)
    const frame = harness.viewport()
    const firstRow = contributionCopyRow(frame, 'first-renderer')
    const firstColumn = cellIndexOf(frame, firstRow, ' Copy [C]') + 3
    const secondRow = contributionCopyRow(frame, 'second-renderer')
    const secondColumn = cellIndexOf(frame, secondRow, ' Copy [C]') + 3

    // Press on the first Copy, release on the second: no copy.
    press(harness, firstRow, firstColumn)
    await settleHarness(harness)
    release(harness, secondRow, secondColumn)
    await settleHarness(harness)
    assert.deepEqual(harness.copied, [])

    // Press on a fact, then resize before the release: the old geometry is dead.
    press(harness, firstRow, firstColumn)
    await settleHarness(harness)
    harness.vt.resize(80, 24)
    await settleHarness(harness)
    release(harness, firstRow, firstColumn)
    await settleHarness(harness)
    assert.deepEqual(harness.copied, [])

    // Press on a fact, then reread the projection before the release.
    const current = harness.viewport()
    const rereadRow = contributionCopyRow(current, 'first-renderer')
    const rereadColumn = cellIndexOf(current, rereadRow, ' Copy [C]') + 3
    press(harness, rereadRow, rereadColumn)
    await settleHarness(harness)
    harness.vt.sendInput('r')
    await settleHarness(harness)
    release(harness, rereadRow, rereadColumn)
    await settleHarness(harness)
    assert.deepEqual(harness.copied, [])
    assert.equal(harness.panel.currentView(), 'diagnostics')
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})

test('Details and Install keep their legacy c/C behavior; only Diagnostics uses C copy all', async () => {
  const harness = await openWorkspace({ columns: 120, rows: 40 })
  started.add(harness)
  try {
    // Details: `c` and `C` still copy the same package identity.
    harness.vt.sendInput('\x1b[F')
    await settleHarness(harness)
    harness.vt.sendInput('\r')
    await settleHarness(harness)
    assert.equal(harness.panel.currentView(), 'details')
    harness.vt.sendInput('c')
    await settleHarness(harness)
    const identity = harness.copied.at(-1)
    harness.vt.sendInput('C')
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), identity, 'C in Details keeps the legacy identity copy')

    // Install: finish an official install, then `C` must still copy the Host
    // install diagnostics (never the diagnostics-page report).
    // A Detail action that the first frame could not paint is revealed first and
    // admitted on the NEXT frame.
    for (let attempt = 0; attempt < 3 && harness.panel.currentView() === 'details'; attempt += 1) {
      harness.vt.sendInput('\r')
      await settleHarness(harness)
    }
    assert.equal(harness.panel.currentView(), 'install')
    harness.vt.sendInput('\r') // inspect
    await settleHarness(harness)
    harness.vt.sendInput('\r') // confirm install
    await settleHarness(harness)
    harness.vt.sendInput('c')
    await settleHarness(harness)
    const installCopy = harness.copied.at(-1)
    assert.ok(installCopy !== undefined && installCopy.length > 0, 'the install view copies its Host diagnostics')
    assert.doesNotMatch(installCopy, /dsh-pi-tui Plugin Diagnostics/)
    harness.vt.sendInput('C')
    await settleHarness(harness)
    assert.equal(harness.copied.at(-1), installCopy, 'C in Install keeps the legacy diagnostics copy')
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})
