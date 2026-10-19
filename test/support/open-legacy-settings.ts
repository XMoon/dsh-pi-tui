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
 * @module @xmoon76/dsh-pi-tui/test/support/open-legacy-settings
 */

/** The minimal terminal surface the navigation drives. */
export interface SettingsNavTerminal {
  readonly columns: number
  sendInput(data: string): void
  waitForRender(): Promise<void>
}

const DOWN = '\x1b[B'
const ENTER = '\r'
const TAB = '\t'

/**
 * Navigate an ALREADY-OPEN Settings workspace to the legacy editor. The key
 * sequence follows the workspace's real focus model:
 *  - wide/medium (>=96 columns) open on the row list: Tab twice reaches the
 *    category list, then three DOWNs select `Other settings`
 *    (`Appearance → Display → Plugins → Other settings`);
 *  - narrow (<96 columns) open on the category list: three DOWNs select it.
 * Enter then inspects the single legacy row, and the second Enter opens it.
 */
export async function navigateToLegacySettings(vt: SettingsNavTerminal): Promise<void> {
  const keys = vt.columns >= 96
    ? [TAB, TAB, DOWN, DOWN, DOWN, ENTER, ENTER]
    : [DOWN, DOWN, DOWN, ENTER, ENTER]
  for (const key of keys) {
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
