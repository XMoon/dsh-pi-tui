/**
 * The ONE per-package extension-config row identity.
 *
 * The Config carrier row id is derived from the installed npm manifest `name`
 * (the exact UTF-8 `package.json#name`), never from a display name, alias,
 * directory or version. Host-side discovery and the Direct/Remote Settings
 * adapters must derive it through this single neutral function so fixture
 * generation, profile discovery and the config port cannot drift.
 *
 * @module @xmoon76/dsh-pi-tui/domain/extension-config/row-id
 */

import { createHash } from 'node:crypto'

/**
 * Derive one package's profile-owned Config row id.
 *
 * @param packageName - the resolved npm package name (the manifest `name`).
 * @returns the Loader row id that package's patch must insert.
 */
export function extensionConfigRowId(packageName: string): string {
  return `pi-tui-extcfg-${createHash('sha256').update(packageName, 'utf8').digest('hex').slice(0, 32)}`
}
