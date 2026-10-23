/**
 * The Settings category rail, as a test helper.
 *
 * Phase 3C / C2-A made the About page the workspace's default home, so a case
 * that exercises another category has to WALK the rail with the real keys —
 * the same keys a user presses. The rail order is frozen, and a narrow
 * terminal opens on the About CONTENT (Esc returns to the rail).
 * @module @xmoon76/dsh-pi-tui/test/support/settings-rail
 */

import assert from 'node:assert/strict'
import { stripTerminalSequences } from '@xmoon76/pi-tui'

/** The minimal terminal surface the rail walk drives. */
export interface SettingsRailTerminal {
  readonly columns: number
  sendInput(data: string): void
  waitForRender(): Promise<void>
  getViewport(): readonly string[]
}

/** The painted category order of the Settings rail. */
export const SETTINGS_CATEGORY_ORDER = [
  'About', 'Models', 'Account', 'Appearance', 'Display', 'Tools', 'Plugins', 'Other settings',
] as const

/** Whether the painted frame shows the Settings category rail. A narrow
 *  terminal paints the single-column category list OR the About content, so
 *  the rail's own labels are the witness. */
export function settingsRailVisible(vt: SettingsRailTerminal): boolean {
  return vt.getViewport().map(stripTerminalSequences)
    .some(line => /^(?:> | {2})(?:About|Models|Account|Appearance|Display|Tools|Plugins|Other settings)(?: {2,}|\s*$)/u.test(line))
}

/**
 * Walk the category rail to one category with the real keys. The rail is the
 * ONLY selection owner: the helper presses its own Down keys and returns to
 * the rail first when the terminal is too narrow for one.
 */
export async function selectSettingsCategory(vt: SettingsRailTerminal, category: string): Promise<void> {
  const target = SETTINGS_CATEGORY_ORDER.indexOf(category as (typeof SETTINGS_CATEGORY_ORDER)[number])
  assert.ok(target >= 0, `the harness must know the category ${JSON.stringify(category)}`)
  if (!settingsRailVisible(vt)) {
    // A narrow terminal opens on the About CONTENT: Esc returns to the rail.
    vt.sendInput('\u001b')
    await vt.waitForRender()
  }
  for (let step = 0; step < target; step += 1) {
    vt.sendInput('\u001b[B')
    await vt.waitForRender()
  }
}
