/**
 * The disposable profile/bundle layout for the visual-tools Settings plane.
 *
 * It mounts the PRODUCTION `src/app/host/visual-tools.ts` row (through a
 * one-line ESM re-export shim) plus the official ConfigEditor and SettingsForms
 * over a caller-owned Host Context, so `settings.describe/mutate` address the
 * real `pi-tui-visual-tools` entry. Both the Direct and the Remote/wire suites
 * use this SAME layout: the only difference is which Client adapter drives it.
 *
 * The caller owns the Context and whichever services the row injects (a real
 * `ToolRuntime` and the Loader are required before mounting).
 * @module @xmoon76/dsh-pi-tui/test/support/visual-tools-plane
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'

/** The fixture bundle name (never a production package). */
export const VISUAL_TOOLS_BUNDLE = 'visual-tools-fixture-bundle'

/** The row id, which is also the Settings namespace. */
export const VISUAL_TOOLS_ROW_ID = 'pi-tui-visual-tools'

const PROFILE_PATCH = 'cordis.patch.yml'

export interface VisualToolsSettingsPlane {
  readonly profileDir: string
  readonly patchPath: string
}

/**
 * Write the disposable profile/bundle layout once. The USER document (the
 * profile patch) is rewritten only when requested: a restart case must read the
 * value the previous Host persisted.
 */
export function writeVisualToolsProfile(root: string, resetUserDocument: boolean): VisualToolsSettingsPlane {
  const profileDir = join(root, 'profile')
  const bundleDir = join(root, 'bundle')
  if (!existsSync(join(profileDir, 'package.json'))) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'visual-tools-profile',
      private: true,
      dsh: { profile: { bundles: [VISUAL_TOOLS_BUNDLE], patch: PROFILE_PATCH } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: VISUAL_TOOLS_BUNDLE,
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    }, null, 2))
    // The row module is a one-line re-export of the PRODUCTION Host row: the
    // Loader resolves the schema, apply function and plugin identity from here.
    const rowModule = join(root, 'visual-tools-row.mjs')
    writeFileSync(rowModule, [
      `export { name, inject, Config, apply } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/app/host/visual-tools.ts')).href)}`,
      '',
    ].join('\n'))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${VISUAL_TOOLS_ROW_ID}`,
      `      name: ${JSON.stringify(rowModule)}`,
      '',
    ].join('\n'))
    symlinkSync(bundleDir, join(profileDir, 'node_modules', VISUAL_TOOLS_BUNDLE), 'dir')
  }
  const patchPath = join(profileDir, PROFILE_PATCH)
  if (resetUserDocument || !existsSync(patchPath)) writeFileSync(patchPath, '[]\n')
  return { profileDir, patchPath }
}

/**
 * Mount the official configuration plane over an EXISTING Host Context. The
 * caller has already mounted the Loader and the services the row injects; this
 * helper owns only the disposable profile/bundle files and the two official
 * configuration services.
 */
export async function mountVisualToolsSettingsPlane(
  ctx: Context,
  root: string,
  options: { readonly resetUserDocument?: boolean } = {},
): Promise<VisualToolsSettingsPlane> {
  const plane = writeVisualToolsProfile(root, options.resetUserDocument === true)
  const anchor = join(process.cwd(), 'package.json')
  ctx.provide('profileContext', {
    name: 'visual-tools-profile',
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
  // A profile resolves its bundles from its OWN node_modules, exactly what a
  // real `dsh plugin --profile` install layout provides.
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
