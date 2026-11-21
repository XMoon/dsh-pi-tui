/**
 * Test-only Settings entry used to drive the OFFICIAL `settings.yaml` importer
 * against a real profile transaction. It is never shipped: the preferences
 * integration plane installs it under a fixture package so the official
 * importer's `ui-settings-general` section can be accepted by the real
 * SettingsForms instead of being rejected for a missing entry.
 *
 * @module @xmoon76/dsh-pi-tui/test-support/preferences-ui-general-row
 */

import z from '@deepseek-ai/schemastery'

export const name = 'pi-tui-test-ui-general'

export const Config = z.object({
  welcomeNoticeVersion: z.string().default('').volatile(),
})

/** Register the profile-owned auto page; the importer performs the write. */
export function apply(ctx: {
  inject: (services: readonly string[], callback: (child: {
    effect: (register: () => () => void) => void
    settings: { configure: (presentation: { auto: boolean }, owner: unknown) => () => void }
  }) => void) => void
  fiber: unknown
}): void {
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
