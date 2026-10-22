/**
 * Phase 3C / C2-A — the Settings `About` page display boundary.
 *
 * The About page is a ROOT-owned read-only projection: the brand whale plus
 * the two package versions. The versions arrive from the Client launcher, so
 * they are data at a display boundary like any other: the projection must
 * project them onto one physical row without ever letting a terminal escape
 * byte or an over-wide cell reach the frame.
 *
 * The page is driven through its own `render()` seam with the REAL panel and
 * the REAL intents; only the two version facts are hostile inputs.
 *
 * @module @xmoon76/dsh-pi-tui/settings-about-page.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import {
  SettingsWorkspacePanel,
  type SettingsWorkspacePanelIntents,
  type SettingsWorkspaceSnapshot,
} from '../../src/tui/panels/settings-workspace-panel.ts'

const SNAPSHOT: SettingsWorkspaceSnapshot = {
  configReadiness: 'ready',
  capturedAt: 0,
  rows: [
    { id: 'theme', category: 'appearance', label: 'Configured theme', summary: 'auto', value: 'auto', scope: 'TUI settings document', freshness: 'ready', description: 'palette', action: 'inspect' },
  ],
}

function openPanel(
  facts: { readonly tui: string; readonly dsh: string | undefined },
  options: { readonly columns?: number; readonly rows?: number } = {},
): SettingsWorkspacePanel {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const intents: SettingsWorkspacePanelIntents = {
    aboutVersionFacts: facts,
    rows: () => rows,
    columns: () => columns,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => {},
    onOpenLegacy: () => {},
    onCopy: () => {},
  }
  return new SettingsWorkspacePanel({ readSnapshot: () => SNAPSHOT }, intents)
}

const plain = (panel: SettingsWorkspacePanel, width = 120): string =>
  panel.render(width).map(stripTerminalSequences).join('\n')

test('a hostile version fact is projected onto one physical row, and the source value is untouched', () => {
  const hostile = '\u001b]52;c;YXR0YWNr\u00071.0.0'
  const facts = { tui: hostile, dsh: '0.2.1-rc.2' }
  const panel = openPanel(facts)
  // The RAW painted lines: a stripped frame would hide an escape byte. The
  // frame's OWN theme sequences are legitimate; the hostile payload is not.
  for (const line of panel.render(120)) {
    assert.ok(!line.includes('\u001b]52'), 'no OSC payload reaches the frame')
    assert.ok(!line.includes('\u001b]'), 'no string-control introducer from the value reaches the frame')
    assert.ok(!line.includes('YXR0YWNr'), 'no payload text reaches the frame')
  }
  const frame = plain(panel)
  assert.match(frame, /TUI\s+.*1\.0\.0/u, 'the readable part of the version stays visible')
  assert.equal(facts.tui, hostile, 'the source fact is untouched: the panel only projects it')
})

test('a CJK version fact never overflows the painted column', () => {
  const panel = openPanel({ tui: '版本'.repeat(40), dsh: '0.2.1-rc.2' })
  for (const line of panel.render(120)) {
    assert.ok(visibleWidth(line) <= 120, `no frame line exceeds the terminal width: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
})

test('an unreadable DSH version reads as Unknown and the TUI version keeps its own value', () => {
  const panel = openPanel({ tui: '0.5.3', dsh: undefined })
  const frame = plain(panel)
  assert.match(frame, /TUI\s+0\.5\.3/u, 'the TUI version is its own fact')
  assert.match(frame, /DSH\s+Unknown/u, 'an unreadable DSH version reads as Unknown')
})

test('the About page reads the configuration document exactly once and writes nothing', () => {
  let reads = 0
  const intents: SettingsWorkspacePanelIntents = {
    aboutVersionFacts: { tui: '0.5.3', dsh: '0.2.1-rc.2' },
    rows: () => 40,
    columns: () => 120,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => {},
    onOpenLegacy: () => {},
    onCopy: () => {},
  }
  const panel = new SettingsWorkspacePanel({
    readSnapshot: () => { reads += 1; return SNAPSHOT },
  }, intents)
  panel.render(120)
  assert.equal(reads, 1, 'the workspace reads its configuration document exactly once')
})

test('a long version fact is never truncated: it wraps, and the About page scrolls it into view', () => {
  const long = '1.0.0-rc.1+build.20261022.deadbeef.verylongmetadata'
  // A tall narrow frame: the whole About content is visible at once, so the
  // fact's physical rows can be read back as ONE value.
  const tall = openPanel({ tui: long, dsh: long }, { columns: 30, rows: 40 })
  const frame = tall.render(30).map(stripTerminalSequences)
  for (const line of frame) {
    assert.ok(visibleWidth(line) <= 30, `no frame line exceeds the column: ${JSON.stringify(line)}`)
    assert.ok(!line.includes('\u2026'), `the fact is never truncated: ${JSON.stringify(line)}`)
  }
  // The rows of one fact are contiguous: dropping the row breaks and the
  // indentation rebuilds the exact value.
  const squashed = frame.join('').replace(/[ \t]+/gu, '')
  assert.ok(squashed.includes(long), `the whole fact is painted: ${JSON.stringify(squashed)}`)

  // A short narrow frame: the fact does not fit, and the About page scrolls
  // the rest of it into view.
  const short = openPanel({ tui: long, dsh: long }, { columns: 30, rows: 6 })
  const first = short.render(30).map(stripTerminalSequences)
  assert.ok(!first.some(line => line.includes('DSH')), `the DSH fact is below the fold: ${JSON.stringify(first)}`)
  const painted = new Set<string>()
  for (let step = 0; step < 10; step += 1) {
    for (const line of short.render(30).map(stripTerminalSequences)) painted.add(line)
    short.handleInput('\u001b[B') // Down scrolls the About projection
  }
  assert.ok([...painted].some(line => line.includes('DSH')), 'the scroll reveals the DSH fact')
})
