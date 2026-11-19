/**
 * The disposable profile/bundle layout for the canonical
 * `pi-tui-preferences` row.
 *
 * It mounts the PRODUCTION `src/app/config/preferences.ts` row (through a
 * one-line ESM re-export shim) plus the official ConfigEditor / SettingsForms
 * over a caller-owned Host Context, so `settings.describe/mutate` and
 * `configEditor.edit` address the real canonical entry — the same row the
 * bundle declares and every backend reads.
 *
 * The layout mirrors `web-preferences-plane.ts` (and the retired
 * `visual-tools-plane.ts`): a profile resolves its bundles from its OWN
 * node_modules, exactly what a real `dsh plugin --profile` install provides,
 * and the USER document is the profile patch.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/preferences-plane
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'

/** The fixture bundle name (never a production package). */
export const PREFERENCES_BUNDLE = 'preferences-fixture-bundle'

/** The row id, which is also the Settings namespace. */
export const PREFERENCES_ROW_ID = 'pi-tui-preferences'

const PROFILE_PATCH = 'cordis.patch.yml'

export interface PreferencesPlaneOptions {
  /** Rewrite the profile patch to its empty form. */
  readonly resetUserDocument?: boolean
  /** Mount the canonical row DISABLED (the negative control). */
  readonly disabledRow?: boolean
  /** Extra profile USER rows written before mount (for example the retired
   * `tui-app` migration source). */
  readonly userRows?: readonly Record<string, unknown>[]
  /** A command-line/home overlay applied ABOVE the profile (official
   * ConfigEditor override refusal). */
  readonly overlay?: readonly Record<string, unknown>[]
}

export interface PreferencesPlane {
  readonly profileDir: string
  readonly patchPath: string
}

/**
 * Write the disposable profile/bundle layout once. The USER document is
 * rewritten only when requested: a restart case must read the values the
 * previous Host persisted.
 *
 * @param root - the disposable test root.
 * @param options - reset/disabled/extra-USER-row controls.
 */
export function writePreferencesProfile(root: string, options: PreferencesPlaneOptions = {}): PreferencesPlane {
  const profileDir = join(root, 'profile')
  const bundleDir = join(root, 'bundle')
  if (!existsSync(join(profileDir, 'package.json'))) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'preferences-profile',
      private: true,
      dsh: { profile: { bundles: [PREFERENCES_BUNDLE], patch: PROFILE_PATCH } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: PREFERENCES_BUNDLE,
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    }, null, 2))
    // The row module is a one-line re-export of the PRODUCTION row: the Loader
    // resolves the schema, apply function and plugin identity from here.
    const rowModule = join(root, 'preferences-row.mjs')
    writeFileSync(rowModule, [
      `export { name, Config, apply } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/app/config/preferences.ts')).href)}`,
      '',
    ].join('\n'))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${PREFERENCES_ROW_ID}`,
      `      name: ${JSON.stringify(rowModule)}`,
      ...(options.disabledRow === true ? ['      disabled: true'] : []),
      '',
    ].join('\n'))
    symlinkSync(bundleDir, join(profileDir, 'node_modules', PREFERENCES_BUNDLE), 'dir')
  }
  const patchPath = join(profileDir, PROFILE_PATCH)
  if (options.resetUserDocument === true || !existsSync(patchPath)) {
    const rows = (options.userRows ?? []).map(row => JSON.stringify(row))
    writeFileSync(patchPath, rows.length === 0 ? '[]\n' : `[${rows.join(',')}]\n`)
  }
  return { profileDir, patchPath }
}

/**
 * Mount the official configuration plane over an EXISTING Host Context. The
 * caller has already mounted the Loader prerequisites; this helper owns only
 * the disposable profile/bundle files and the two official configuration
 * services.
 */
export async function mountPreferencesSettingsPlane(
  ctx: Context,
  root: string,
  options: PreferencesPlaneOptions = {},
): Promise<PreferencesPlane & {
  readonly settings: NonNullable<ReturnType<Context['get']>>
  readonly configEditor: NonNullable<ReturnType<Context['get']>>
}> {
  const plane = writePreferencesProfile(root, options)
  const anchor = join(process.cwd(), 'package.json')
  const overlay = options.overlay ?? []
  ctx.provide('profileContext', {
    name: 'preferences-profile',
    dir: plane.profileDir,
    patchPath: plane.patchPath,
    installAnchor: anchor,
    cwd: root,
    home: root,
    startedBundles: [],
    overlays: overlay,
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  const profile = loadProfileDirectory('dsh', plane.profileDir, anchor)
  await mountRootInclude(
    ctx,
    plane.patchPath,
    [...profile.layers.flatMap(layer => layer.patches), ...profile.patches, ...overlay],
    pathToFileURL(anchor).href,
    'dsh',
  )
  await ctx.loader.await()
  return {
    ...plane,
    settings: ctx.get('settings'),
    configEditor: ctx.get('configEditor'),
  }
}
