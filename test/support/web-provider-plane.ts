/** Official configuration plane for the S2/PR-B Web provider qualification.
 * REPRODUCED: a real profile/bundle document pair, the Loader root Include, the
 * official ConfigEditor and SettingsForms, and the REAL `web`,
 * `web-search-deepseek`, `web-deepseek-api`, `web-fetch-http` and `tool-web`
 * rows — the same rows `dsh-base` mounts.
 * STAND-INS: none on the Host side; the caller stubs only the outer HTTP
 * transport.
 * ABSENT: a user's real profile, credentials, HMR watcher and physical GUI.
 * @module @xmoon76/dsh-pi-tui/test/support/web-provider-plane
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
const BUNDLE = 's2b-web-provider-fixture'

/** The settings entry ids the Web section addresses (the shipped `dsh-base`
 *  row ids). */
export const WEB_PROVIDER_ROW = 'web'
export const WEB_SEARCH_API_ROW = 'web-deepseek-api'
export const WEB_SEARCH_MESSAGES_ROW = 'web-search-deepseek'
export const WEB_FETCH_HTTP_ROW = 'web-fetch-http'
export const WEB_TOOL_ROW = 'tool-web'

/**
 * Mount the real Web provider rows through the OFFICIAL configuration plane
 * (a disposable bundle + profile patch), so `settings.describe/mutate` address
 * real entries and a volatile write reaches the LIVE provider configuration.
 * The caller owns Loader and mounts it before calling this helper.
 */
export async function mountWebProviderPlane(
  ctx: Context,
  workRoot: string,
): Promise<{ readonly patchPath: string; readonly profileDir: string }> {
  const profileDir = join(workRoot, 'web-profile')
  const bundleDir = join(workRoot, 'web-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const anchor = require.resolve('@deepseek-ai/dsh-web/package.json')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 's2b-web-profile', private: true,
    dsh: { profile: { bundles: [BUNDLE], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: BUNDLE, version: '0.0.0', private: true,
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
  }, null, 2))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${WEB_PROVIDER_ROW}`,
    `      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-web'))}`,
    '      config:',
    '        searchProvider: deepseek-official',
    '        fetchProvider: http',
    `    - id: ${WEB_SEARCH_MESSAGES_ROW}`,
    `      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-web-search-deepseek'))}`,
    '      config:',
    '        apiKeyEnv: DEEPSEEK_API_KEY',
    `    - id: ${WEB_SEARCH_API_ROW}`,
    `      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-web-deepseek-api'))}`,
    '      config:',
    '        apiKeyEnv: DEEPSEEK_API_KEY',
    `    - id: ${WEB_FETCH_HTTP_ROW}`,
    `      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-web-fetch-http'))}`,
    `    - id: ${WEB_TOOL_ROW}`,
    `      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-tool-web'))}`,
    '      config:',
    '        fetch: true',
    '',
  ].join('\n'))
  symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
  writeFileSync(patchPath, '[]\n')
  ctx.provide('profileContext', {
    name: 's2b-web-profile', dir: profileDir, patchPath, installAnchor: anchor,
    cwd: workRoot, home: workRoot, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  await mountRootInclude(ctx, patchPath, [
    ...profile.layers.flatMap(layer => layer.patches), ...profile.patches,
  ], pathToFileURL(anchor).href, 'dsh')
  await ctx.loader.await()
  return { patchPath, profileDir }
}
