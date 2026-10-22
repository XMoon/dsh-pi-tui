/**
 * Phase 3B / B2-A test support: reach the pre-B2-A complete settings editor
 * through the REAL `/settings` entry.
 *
 * Since B2-A, `/settings` opens the readonly fullscreen Settings workspace; the
 * legacy SettingsList lives behind its `Other settings` → `Open existing
 * settings…` compatibility bridge. Every pre-existing suite that drives the real
 * command and then interacts with (or asserts on) the legacy rows must cross
 * that bridge through the real workspace keys and the real handoff — never by
 * calling `TuiApp.openSettings` or the legacy builder directly.
 *
 * Since Phase 3C / C2-A the workspace opens on its About home, so the walk
 * starts from there: the category rail is the only selection owner.
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

/**
 * Navigate an ALREADY-OPEN Settings workspace to the legacy editor. The key
 * sequence follows the workspace's real focus model: walk the category rail to
 * `Other settings`, Enter into its Rows level, and Enter the single legacy
 * launcher row.
 */
export async function navigateToLegacySettings(vt: SettingsNavTerminal): Promise<void> {
  // The walk reads the painted frame to find the rail, so the FIRST frame of
  // the workspace must be on screen before the walk starts.
  await vt.waitForRender()
  await selectSettingsCategory(vt, 'Other settings')
  for (const key of [ENTER, ENTER]) {
    vt.sendInput(key)
    await vt.waitForRender()
  }
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
