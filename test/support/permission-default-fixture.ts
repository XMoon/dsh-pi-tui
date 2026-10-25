/** Official configuration plane for the PERMISSION default (the
 * `permission` settings section) over a real profile/bundle document.
 *
 * REPRODUCED: real profile/bundle documents, the Loader root Include, the
 * official ConfigEditor and SettingsForms, and the official
 * `@deepseek-ai/dsh-permission-presets` service mounted as a bundle row whose
 * row id IS its settings namespace (`permission`) — so
 * `ConfigPort.permissions.setDefaultPreset()` mutates a REAL configurable
 * plugin entry, exactly like a shipped deployment.
 * STAND-INS: the disposable bundle declares only that one row; the approval and
 * shell capabilities it requires are the caller's real prerequisites.
 * ABSENT: a user's real profile, credentials, an HMR watcher and physical GUI.
 * @module @xmoon76/dsh-pi-tui/test/support/permission-default-fixture
 */
import { createRequire } from 'node:module'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
const BUNDLE = 'permission-default-bundle'
const PROFILE_NAME = 'permission-default-profile'
/** The row id the official plugin ships under; it doubles as the settings
 *  namespace `ConfigPort.permissions` writes. */
const PERMISSION_ROW = 'permission'

export interface PermissionDefaultPlane {
  /** The real `permission` patch document the default write lands in. */
  readonly patchPath: string
  readonly profileDir: string
}

/**
 * Mount the real permission-default plane over an already-mounted Loader and
 * the plugin's own prerequisites (`shell`, `approval`, `sessions`,
 * `sessionProjections`). The caller owns Loader and disposes the Context.
 */
export async function mountPermissionDefaultPlane(
  ctx: Context,
  workRoot: string,
): Promise<PermissionDefaultPlane> {
  const profileDir = join(workRoot, 'profile')
  const bundleDir = join(workRoot, 'permission-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const anchor = require.resolve('@deepseek-ai/dsh-permission-presets/package.json')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: PROFILE_NAME, private: true,
    dsh: { profile: { bundles: [BUNDLE], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: BUNDLE, version: '0.0.0', private: true,
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
  }, null, 2))
  // Only a CONFIGURABLE plugin entry gets a settings namespace, so the
  // permission service must be a profile ROW, not a bare `ctx.plugin` call.
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${PERMISSION_ROW}`,
    `      name: ${JSON.stringify(anchor.replace(/package\.json$/u, 'lib/index.js'))}`,
    '',
  ].join('\n'))
  symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
  writeFileSync(patchPath, '[]\n')
  ctx.provide('profileContext', {
    name: PROFILE_NAME, dir: profileDir, patchPath, installAnchor: anchor,
    cwd: workRoot, home: workRoot, startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  const composed = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches]
  await mountRootInclude(ctx, patchPath, composed, pathToFileURL(anchor).href, 'dsh')
  await ctx.loader.await()
  return { patchPath, profileDir }
}
