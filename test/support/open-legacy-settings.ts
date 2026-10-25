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
 * C2-R3 retired the `Agent → Agent settings…` launcher (that category has no
 * unmigrated field left), so the editor is reached through a launcher that still
 * exists: `Appearance → Footer & status line…`. That launcher focuses the editor
 * on its own row, so this helper then clears the search box to put the cursor
 * back at the list top — the state the index-based legacy suites assert against.
 * @module @xmoon76/dsh-pi-tui/test/support/open-legacy-settings
 */

import { selectSettingsCategory, type SettingsRailTerminal } from './settings-rail.ts'

/** The minimal terminal surface the navigation drives. */
export interface SettingsNavTerminal extends SettingsRailTerminal {
  readonly columns: number
  sendInput(data: string): void
  waitForRender(): Promise<void>
}

const ENTER = '\r'
const DOWN = '\x1b[B'

/** The launcher that still opens the legacy editor (Appearance's own fourth
 *  row: Theme, Icon style, Footer, then the transition row). */
const REMAINING_LAUNCHER_CATEGORY = 'Appearance'
const REMAINING_LAUNCHER_DOWNS = 2

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
  await selectSettingsCategory(vt, REMAINING_LAUNCHER_CATEGORY)
  vt.sendInput(ENTER)
  await vt.waitForRender()
  for (let step = 0; step < REMAINING_LAUNCHER_DOWNS; step += 1) {
    vt.sendInput(DOWN)
    await vt.waitForRender()
  }
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
