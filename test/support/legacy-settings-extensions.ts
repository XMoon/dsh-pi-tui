/**
 * The legacy SettingsList's ONLY remaining workspace launcher (C2-R5).
 *
 * Footer layout and Keyboard shortcuts are now same-lease pages, so the
 * `Appearance`/`Input & Terminal` transition rows are gone. The complete legacy
 * editor is still reachable through `Extensions → Configure extension
 * settings…` while its conditional registry has at least one live row; suites
 * that exercise a still-supported legacy section register this probe row so the
 * real navigation path exists.
 * @module @xmoon76/dsh-pi-tui/test/support/legacy-settings-extensions
 */

import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'

/** The probe settings row id the legacy editor opens on. */
export const LEGACY_SETTINGS_PROBE_ID = 'legacy-probe'

/** One live extension-settings row so `Extensions` (and its legacy launcher)
 *  is a real directory member. `themes` is an empty real registry unless one is
 *  supplied. */
export function legacyEditorExtensions(themes: ThemeRegistry = new ThemeRegistry()): {
  themes: ThemeRegistry
  settings: SettingsRegistry
} {
  return { themes, settings: probeRegistry() }
}

/** Register the probe on the LIVE extension service of a real composition
 *  (`mountRunner`): the Settings workspace then sees a real Extensions row. */
export function registerLegacySettingsProbe(ctx: { get(name: string): unknown }): void {
  const service = ctx.get('piTuiExtensions') as { settings?: SettingsRegistry } | undefined
  if (service?.settings === undefined) throw new Error('the composition has no extension settings registry')
  probeRegistry(service.settings)
}

function probeRegistry(registry: SettingsRegistry = new SettingsRegistry()): SettingsRegistry {
  registry.register({
    id: LEGACY_SETTINGS_PROBE_ID,
    label: 'Legacy settings probe',
    description: 'test-only row that makes the Extensions launcher reachable',
    currentValue: '',
  }, 'test')
  return registry
}
