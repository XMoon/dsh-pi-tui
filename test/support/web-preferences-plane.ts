/**
 * The disposable profile/bundle layout for the profile-owned Web startup
 * preference plane (`pi-tui-web-preferences`).
 *
 * It mounts the PRODUCTION `src/app/host/web-preferences.ts` row (through a
 * one-line ESM re-export shim) plus the official ConfigEditor and SettingsForms
 * over a caller-owned Host Context, so `settings.describe/mutate` address the
 * real `pi-tui-web-preferences` entry — the exact section `/settings` writes and
 * the Host cold boot reads.
 *
 * The layout deliberately mirrors `visual-tools-plane.ts`: a profile resolves its
 * bundles from its OWN node_modules, exactly what a real `dsh plugin --profile`
 * install provides, and the USER document is the profile patch.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/web-preferences-plane
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'

/** The fixture bundle name (never a production package). */
export const WEB_PREFERENCES_BUNDLE = 'web-preferences-fixture-bundle'

/** The row id, which is also the Settings namespace. */
export const WEB_PREFERENCES_ROW_ID = 'pi-tui-web-preferences'

const PROFILE_PATCH = 'cordis.patch.yml'

export interface WebPreferencesSettingsPlane {
  readonly profileDir: string
  readonly patchPath: string
}

/**
 * Write the disposable profile/bundle layout once. The USER document (the
 * profile patch) is rewritten only when requested: a restart case must read the
 * value the previous Host persisted.
 *
 * @param root - the disposable test root.
 * @param resetUserDocument - rewrite the profile patch to its empty form.
 * @param disabledRow - mount the row DISABLED (the negative control: a row that
 *   is not active must contribute no writable settings section).
 */
export function writeWebPreferencesProfile(
  root: string,
  resetUserDocument: boolean,
  disabledRow = false,
): WebPreferencesSettingsPlane {
  const profileDir = join(root, 'profile')
  const bundleDir = join(root, 'bundle')
  if (!existsSync(join(profileDir, 'package.json'))) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'web-preferences-profile',
      private: true,
      dsh: { profile: { bundles: [WEB_PREFERENCES_BUNDLE], patch: PROFILE_PATCH } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: WEB_PREFERENCES_BUNDLE,
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    }, null, 2))
    // The row module is a one-line re-export of the PRODUCTION Host row: the
    // Loader resolves the schema, apply function and plugin identity from here.
    const rowModule = join(root, 'web-preferences-row.mjs')
    writeFileSync(rowModule, [
      `export { name, Config, apply } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/app/host/web-preferences.ts')).href)}`,
      '',
    ].join('\n'))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${WEB_PREFERENCES_ROW_ID}`,
      `      name: ${JSON.stringify(rowModule)}`,
      ...(disabledRow ? ['      disabled: true'] : []),
      '',
    ].join('\n'))
    symlinkSync(bundleDir, join(profileDir, 'node_modules', WEB_PREFERENCES_BUNDLE), 'dir')
  }
  const patchPath = join(profileDir, PROFILE_PATCH)
  if (resetUserDocument || !existsSync(patchPath)) writeFileSync(patchPath, '[]\n')
  return { profileDir, patchPath }
}

/**
 * Mount the official configuration plane over an EXISTING Host Context. The
 * caller has already mounted the Loader; this helper owns only the disposable
 * profile/bundle files and the two official configuration services.
 */
export async function mountWebPreferencesSettingsPlane(
  ctx: Context,
  root: string,
  options: { readonly resetUserDocument?: boolean; readonly disabledRow?: boolean } = {},
): Promise<WebPreferencesSettingsPlane> {
  const plane = writeWebPreferencesProfile(root, options.resetUserDocument === true, options.disabledRow === true)
  const anchor = join(process.cwd(), 'package.json')
  ctx.provide('profileContext', {
    name: 'web-preferences-profile',
    dir: plane.profileDir,
    patchPath: plane.patchPath,
    installAnchor: anchor,
    cwd: root,
    home: root,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  const profile = loadProfileDirectory('dsh', plane.profileDir, anchor)
  await mountRootInclude(
    ctx,
    plane.patchPath,
    [...profile.layers.flatMap(layer => layer.patches), ...profile.patches],
    pathToFileURL(anchor).href,
    'dsh',
  )
  await ctx.loader.await()
  return plane
}
