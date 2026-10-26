/**
 * REAL Settings-workspace navigation for the suites that used to cross the
 * retired `Extensions → Configure extension settings…` transition (C2-R6
 * Step 4.1).
 *
 * This is TEST SUPPORT ONLY: every step drives the actual `/settings`
 * workspace with the real user keys and waits for a painted frame. It is not a
 * production seam, it never calls a panel-private method, and it never reads a
 * ConfigPort or simulates a commit outcome. The one predicate it accepts
 * (`settled`) is supplied by the caller for ASSERTING an authoritative
 * settlement it already owns.
 * @module @xmoon76/dsh-pi-tui/test/support/settings-workspace-navigation
 */

import assert from 'node:assert/strict'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { selectSettingsCategory, type SettingsRailTerminal } from './settings-rail.ts'

/** The minimal terminal surface the workspace navigation drives. */
export interface SettingsWorkspaceTerminal extends SettingsRailTerminal {
  readonly columns: number
  sendInput(data: string): void
  waitForRender(): Promise<void>
  getViewport(): readonly string[]
}

/**
 * The fixed Rows membership of every category these migrated suites navigate.
 * A label outside this table is a test bug, never a reachability claim: the
 * frozen production snapshot (`src/tui/commands/settings.ts`) is the authority.
 */
export const SETTINGS_CATEGORY_ROWS: Readonly<Record<string, readonly string[]>> = {
  Appearance: [
    'Configured theme', 'Icon style', 'Status line mode', 'Configure footer layout…',
  ],
  Conversation: [
    'Transcript display', 'Transcript detail', 'Thinking detail', 'Progress updates',
    'Response style', 'Submit while busy', 'Git attribution',
  ],
  'Input & Terminal': [
    'Home/End keys', 'Fullscreen', 'Mouse wheel lines', 'Notifications',
    'Notification method', 'Terminal progress', 'Keyboard shortcuts…',
  ],
  Agent: [
    'Approval policy (this session)', 'Default permission', 'Subagent allowed models',
    'Subagent model selection', 'User shell sandbox policy',
  ],
  Tools: ['Visual tools', 'Web Search / Fetch'],
}

const plainLines = (vt: SettingsWorkspaceTerminal): readonly string[] =>
  vt.getViewport().map(stripTerminalSequences)

/**
 * Open the `/settings` workspace (the REAL command) and enter one category's
 * Rows level with the real rail keys. The painted breadcrumb must agree.
 */
export async function openSettingsRows(
  vt: SettingsWorkspaceTerminal,
  invoke: (name: string) => unknown,
  category: string,
): Promise<void> {
  assert.ok(category in SETTINGS_CATEGORY_ROWS, `the navigation table must know ${JSON.stringify(category)}`)
  invoke('settings')
  await vt.waitForRender()
  await selectSettingsCategory(vt, category)
  vt.sendInput('\r') // the category rail -> its Rows level
  await vt.waitForRender()
  const header = plainLines(vt)[0] ?? ''
  assert.ok(
    header.startsWith(`Settings · ${category} · Rows`),
    `the ${category} Rows level must be painted (header: ${JSON.stringify(header)})`,
  )
}

/** Whether a painted line starts with one EXACT identity (a label/raw value)
 *  followed by its separator or the end of the cell — never a prefix of a
 *  longer identity (`9;4` must not match `9;4+7501`). */
function startsWithIdentity(text: string, identity: string): boolean {
  return text === identity || text.startsWith(`${identity} `)
}

/** The panel column where the Rows pane starts (the focused pane header, else 0). */
function rowsPaneStart(lines: readonly string[]): number {
  for (const line of lines) {
    const at = line.indexOf('[Rows (')
    if (at >= 0) return at
  }
  return 0
}

/** The label the Rows pane's own cursor currently marks, or undefined. */
function selectedRowLabel(vt: SettingsWorkspaceTerminal): string | undefined {
  const lines = plainLines(vt)
  const start = rowsPaneStart(lines)
  for (const line of lines) {
    const segment = line.slice(start)
    if (segment.startsWith('> ')) return segment.slice(2)
  }
  return undefined
}

/**
 * The painted cell of the Rows cursor, WITHOUT the neighbouring detail column
 * (a medium frame paints both panes on the same physical line). The value is
 * the row label followed by its summary, trimmed at the pane boundary.
 */
export function paintedSelectedRowCell(vt: SettingsWorkspaceTerminal): string | undefined {
  const lines = plainLines(vt)
  const header = lines.find(line => line.includes('[Rows ('))
  const rowsStart = header === undefined ? 0 : header.indexOf('[Rows (')
  const detailStart = header === undefined ? Number.MAX_SAFE_INTEGER : header.indexOf('Details', rowsStart)
  const end = detailStart > rowsStart ? detailStart : Number.MAX_SAFE_INTEGER
  for (const line of lines) {
    if (!line.slice(rowsStart).startsWith('> ')) continue
    return line.slice(rowsStart + 2, Math.min(end, line.length)).trimEnd()
  }
  return undefined
}

/**
 * Select ONE frozen Rows entry with `Home` + bounded `↓` presses. The walk
 * proves every step moved the selection; it never uses a legacy list index or
 * feeds a bare string to an old filter.
 */
export async function selectSettingsRow(vt: SettingsWorkspaceTerminal, label: string): Promise<void> {
  const known = Object.values(SETTINGS_CATEGORY_ROWS).some(rows => rows.includes(label))
  assert.ok(known, `${JSON.stringify(label)} is not one of the frozen Settings Rows entries`)
  vt.sendInput('\x1b[H') // Home -> the category's first row
  await vt.waitForRender()
  let previous = selectedRowLabel(vt)
  assert.ok(previous !== undefined, 'the Rows level must paint a selected row')
  for (let step = 0; step < 40; step += 1) {
    if (startsWithIdentity(previous, label)) return
    vt.sendInput('\x1b[B')
    await vt.waitForRender()
    const next = selectedRowLabel(vt)
    assert.ok(next !== undefined, 'the Rows level must keep a selected row')
    assert.notEqual(next, previous, `the row selection stopped moving before ${JSON.stringify(label)}`)
    previous = next
  }
  assert.fail(`${JSON.stringify(label)} is not reachable in the current Rows level`)
}

/** The column where the Details pane starts (its pane header, else 0). */
export function settingsDetailsPaneStart(vt: SettingsWorkspaceTerminal): number {
  return detailsPaneStart(plainLines(vt))
}

/** The column where the Details pane starts (its pane header, else 0). */
function detailsPaneStart(lines: readonly string[]): number {
  const header = lines.findIndex(line => line.includes('[Details]'))
  if (header < 0) return 0
  const at = lines[header]!.indexOf('[Details]')
  return Math.max(0, at - 2)
}

/** The whole painted Details column (wrapped facts read there, not across the
 *  neighbouring Rows pane). */
export function paintedDetailsText(vt: SettingsWorkspaceTerminal): string {
  const lines = plainLines(vt)
  const start = detailsPaneStart(lines)
  return lines.map(line => line.slice(start)).join('\n')
}

/** The candidate the DETAIL choice's own cursor currently marks, or undefined. */
function selectedCandidate(vt: SettingsWorkspaceTerminal): string | undefined {
  const lines = plainLines(vt)
  const start = detailsPaneStart(lines)
  for (const line of lines) {
    const tail = line.slice(start)
    const at = tail.indexOf('> ')
    if (at >= 0) return tail.slice(at + 2)
  }
  return undefined
}

/** Open the selected row's native Detail/Choice (Rows -> Detail) and wait. */
export async function openSettingsChoice(vt: SettingsWorkspaceTerminal): Promise<void> {
  vt.sendInput('\r') // Rows -> Detail; a writable row opens its native choice
  await vt.waitForRender()
}

/**
 * Reveal `candidate` in the OPEN choice with bounded Up/Down keys and wait for
 * the painted frame. It never dispatches anything.
 */
export async function selectSettingsChoice(vt: SettingsWorkspaceTerminal, candidate: string): Promise<void> {
  // The candidate list does not wrap: walk to the top first, then down.
  for (let step = 0; step < 12; step += 1) {
    vt.sendInput('\x1b[A')
    await vt.waitForRender()
  }
  let reached = false
  for (let step = 0; step < 40; step += 1) {
    const selected = selectedCandidate(vt)
    if (selected !== undefined && startsWithIdentity(selected, candidate)) {
      reached = true
      break
    }
    vt.sendInput('\x1b[B')
    await vt.waitForRender()
  }
  assert.ok(reached, `the ${JSON.stringify(candidate)} candidate must be painted and selectable`)
}

/**
 * Open the selected row's native Detail/Choice, reveal `candidate`, and dispatch
 * it with ONE explicit Confirm. `settled` (optional, caller-owned) is polled
 * after the Confirm so a case can wait for the authoritative settlement it
 * asserts on; the helper never fabricates one.
 */
export async function confirmSettingsChoice(
  vt: SettingsWorkspaceTerminal,
  candidate: string,
  settled?: () => boolean | Promise<boolean>,
): Promise<void> {
  await openSettingsChoice(vt)
  await selectSettingsChoice(vt, candidate)
  vt.sendInput('\r') // the ONE explicit Confirm
  await vt.waitForRender()
  for (let round = 0; round < 12; round += 1) {
    await vt.waitForRender()
    if (settled === undefined) {
      if (round >= 3) return
      continue
    }
    if (await settled()) return
  }
  assert.ok(settled === undefined || await settled(), 'the authoritative settlement did not arrive')
}
