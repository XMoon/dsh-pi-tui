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

test('the frozen size matrix paints within the width and reaches every fact', async () => {
  const diagnostics = view([
    entry({ id: 'first-renderer' }),
    entry({ id: 'last-renderer', owner: 'uid:owner-b', entryId: 'entry-b', state: 'active', lastError: undefined }),
  ])
  for (const [columns, rows] of [[30, 8], [44, 20], [80, 24], [120, 40], [200, 50]] as const) {
    const harness = await open(() => diagnostics, columns, rows)
    try {
      harness.vt.sendInput('d')
      await harness.settle()
      assert.equal(harness.panel.currentView(), 'diagnostics', `${columns}x${rows}`)
      const frame = harness.viewport()
      for (const line of frame) {
        assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} painted an overflowing row: ${JSON.stringify(plain([line]))}`)
      }
      assert.match(plain(frame), /Plugins · Diagnostics/)
      // End selects the LAST fact and reveals it even at 30x8.
      harness.vt.sendInput('\x1b[F')
      await harness.settle()
      assert.ok(
        plain(harness.viewport()).replace(/\s+/g, '').includes('last-renderer'),
        `${columns}x${rows} must reveal the last fact:\n${plain(harness.viewport())}`,
      )
      // C copies the whole snapshot (the keyboard route never depends on paint).
      harness.vt.sendInput('C')
      await harness.settle()
      assert.equal(harness.copied.at(-1), serializeTuiExtensionDiagnostics(diagnostics), `${columns}x${rows}`)
    } finally {
      started.delete(harness)
      harness.app.dispose()
    }
  }
})

test('a long CJK Host error wraps without ellipsis and copies in full', async () => {
  const errorText = `renderer callback failed: ${'长鲸错'.repeat(40)}`
  const diagnostics = view([entry({ lastError: errorText })])
  const harness = await open(() => diagnostics, 44, 20)
  try {
    harness.vt.sendInput('d')
    await harness.settle()
    // Select the contribution (Health -> Registries -> Capabilities -> entry).
    for (let step = 0; step < 3; step += 1) {
      harness.vt.sendInput('\x1b[B')
      await harness.settle()
    }
    let union = ''
    for (let page = 0; page < 8; page += 1) {
      union += plain(harness.viewport())
      harness.vt.sendInput('\x1b[6~') // PgDn
      await harness.settle()
    }
    assert.ok(union.includes('长鲸错'), 'the CJK error text is painted')
    // The error is WRAPPED across rows: the whole message survives, so no
    // content cell was replaced by an ellipsis (the meta row's own chrome
    // truncation is not the error).
    assert.ok(
      union.replace(/\s+/g, '').includes(errorText.replace(/\s+/g, '')),
      'the whole Host error is reachable through scrolling',
    )
    harness.vt.sendInput('c')
    await harness.settle()
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry({ lastError: errorText })))
    assert.match(harness.copied.at(-1) ?? '', /长鲸错/)
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
    await harness.settle()
    const frame = harness.viewport()
    const copyRow = contributionCopyRow(frame, 'broken-renderer')
    const copyColumn = cellIndexOf(frame, copyRow, ' Copy [C]') + 3
    press(harness, copyRow, copyColumn)
    await harness.settle()
    assert.deepEqual(harness.copied, [], 'a press alone never copies')
    release(harness, copyRow, copyColumn)
    await harness.settle()
    assert.equal(harness.copied.at(-1), formatTuiContributionDiagnostic(entry()))

    const afterCopy = harness.viewport()
    const allRow = rowOf(afterCopy, 'Copy All [C]')
    const allColumn = cellIndexOf(afterCopy, allRow, 'Copy All [C]') + 3
    press(harness, allRow, allColumn)
    await harness.settle()
    release(harness, allRow, allColumn)
    await harness.settle()
    assert.equal(harness.copied.at(-1), serializeTuiExtensionDiagnostics(diagnostics))

    const afterAll = harness.viewport()
    const backRow = rowOf(afterAll, 'Back')
    const backColumn = cellIndexOf(afterAll, backRow, 'Back') + 1
    press(harness, backRow, backColumn)
    await harness.settle()
    release(harness, backRow, backColumn)
    await harness.settle()
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
    await harness.settle()
    const frame = harness.viewport()
    const firstRow = contributionCopyRow(frame, 'first-renderer')
    const firstColumn = cellIndexOf(frame, firstRow, ' Copy [C]') + 3
    const secondRow = contributionCopyRow(frame, 'second-renderer')
    const secondColumn = cellIndexOf(frame, secondRow, ' Copy [C]') + 3

    // Press on the first Copy, release on the second: no copy.
    press(harness, firstRow, firstColumn)
    await harness.settle()
    release(harness, secondRow, secondColumn)
    await harness.settle()
    assert.deepEqual(harness.copied, [])

    // Press on a fact, then resize before the release: the old geometry is dead.
    press(harness, firstRow, firstColumn)
    await harness.settle()
    harness.vt.resize(80, 24)
    await harness.settle()
    release(harness, firstRow, firstColumn)
    await harness.settle()
    assert.deepEqual(harness.copied, [])

    // Press on a fact, then reread the projection before the release.
    const current = harness.viewport()
    const rereadRow = contributionCopyRow(current, 'first-renderer')
    const rereadColumn = cellIndexOf(current, rereadRow, ' Copy [C]') + 3
    press(harness, rereadRow, rereadColumn)
    await harness.settle()
    harness.vt.sendInput('r')
    await harness.settle()
    release(harness, rereadRow, rereadColumn)
    await harness.settle()
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
    await harness.settle()
    harness.vt.sendInput('\r')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'details')
    harness.vt.sendInput('c')
    await harness.settle()
    const identity = harness.copied.at(-1)
    harness.vt.sendInput('C')
    await harness.settle()
    assert.equal(harness.copied.at(-1), identity, 'C in Details keeps the legacy identity copy')

    // Install: finish an official install, then `C` must still copy the Host
    // install diagnostics (never the diagnostics-page report).
    harness.vt.sendInput('\r')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'install')
    harness.vt.sendInput('\r') // inspect
    await harness.settle()
    harness.vt.sendInput('\r') // confirm install
    await harness.settle()
    harness.vt.sendInput('c')
    await harness.settle()
    const installCopy = harness.copied.at(-1)
    assert.ok(installCopy !== undefined && installCopy.length > 0, 'the install view copies its Host diagnostics')
    assert.doesNotMatch(installCopy, /dsh-pi-tui Plugin Diagnostics/)
    harness.vt.sendInput('C')
    await harness.settle()
    assert.equal(harness.copied.at(-1), installCopy, 'C in Install keeps the legacy diagnostics copy')
  } finally {
    started.delete(harness)
    harness.app.dispose()
  }
})
