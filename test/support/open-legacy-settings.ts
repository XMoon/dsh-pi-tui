/**
 * Phase 3B / B2-A test support: reach the pre-B2-A complete settings editor
 * through the REAL `/settings` entry.
 *
 * Since B2-A, `/settings` opens the readonly fullscreen Settings workspace; the
 * legacy SettingsList lives behind the per-category transition launchers. Every
 * pre-existing suite that drives the real command and then interacts with (or
 * asserts on) the legacy rows must cross that bridge through the real workspace
 * keys and the real handoff — never by calling `TuiApp.openSettings` or the
 * legacy builder directly.
 *
 * Since Phase 3C / C2-A the workspace opens on its About home, so the walk
 * starts from there: the category rail is the only selection owner.
 *
 * C2-R5 retired the `Appearance → Footer & status line…` and
 * `Input & Terminal → Input & terminal settings…` launchers, so the editor is
 * reached through the ONLY remaining launcher: the conditional
 * `Extensions → Configure extension settings…` row. A suite must register a
 * live extension settings row (see `legacy-settings-extensions.ts`). The
 * launcher focuses the editor on its own row, so this helper then clears the
 * search box to put the cursor back at the list top — the state the index-based
 * legacy suites assert against.
 * @module @xmoon76/dsh-pi-tui/test/support/open-legacy-settings
 */

import { settingsRailVisible, type SettingsRailTerminal } from './settings-rail.ts'

/** The minimal terminal surface the navigation drives. */
export interface SettingsNavTerminal extends SettingsRailTerminal {
  readonly columns: number
  sendInput(data: string): void
  waitForRender(): Promise<void>
}

const ENTER = '\r'
const DOWN = '\x1b[B'

/**
 * Navigate an ALREADY-OPEN Settings workspace to the existing settings editor.
 * The key sequence follows the workspace's real focus model: walk the category
 * rail to `Appearance`, Enter into its Rows level, Enter that category's
 * transition launcher, then reset the legacy list cursor to its first row.
 */
export async function navigateToLegacySettings(vt: SettingsNavTerminal): Promise<void> {
  // The walk reads the painted frame to find the rail, so the FIRST frame of
  // the workspace must be on screen before the walk starts.
  await vt.waitForRender()
  if (!settingsRailVisible(vt)) {
    // A narrow terminal opens on the About CONTENT: Esc returns to the rail.
    vt.sendInput('\u001b')
    await vt.waitForRender()
  }
  // `Extensions` is appended after the nine fixed categories and exists only
  // while the registry has live rows: walk the rail to it by its painted label
  // (bounded), never by a fixed index.
  for (let step = 0; step < 10; step += 1) {
    const painted = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
    if (painted.some(line => /^> Extensions(?:\s{2,}|\s*$)/u.test(line))) break
    vt.sendInput(DOWN)
    await vt.waitForRender()
  }
  const selected = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  if (!selected.some(line => /^> Extensions(?:\s{2,}|\s*$)/u.test(line))) {
    throw new Error('the Extensions category is not reachable; register a live extension settings row')
  }
  vt.sendInput(ENTER)
  await vt.waitForRender()
  // Extensions holds exactly ONE row (the transition launcher).
  vt.sendInput(ENTER)
  await vt.waitForRender()
  // The launcher focused the editor on its own section; a filter edit plus its
  // clear re-anchors the cursor at the list top WITHOUT walking the rows (the
  // legacy list resets its index whenever the query changes).
  vt.sendInput('z')
  await vt.waitForRender()
  vt.sendInput('\x7f')
  await vt.waitForRender()
}

/** Run `/settings` and navigate to the legacy editor through the real workspace. */
export async function openLegacySettingsPanel(
  invoke: (name: string) => unknown,
  vt: SettingsNavTerminal,
): Promise<void> {
  invoke('settings')
  await vt.waitForRender()
  await navigateToLegacySettings(vt)
}
