/** Official configuration plane for the SUBAGENT model-selection section.
 *
 * REPRODUCED: real profile/bundle documents, the Loader root Include, the
 * official ConfigEditor and SettingsForms, and the official
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings` service mounted as a
 * bundle row — so the section is a REAL configurable plugin entry whose settings
 * namespace the TUI writer mutates.
 * STAND-INS: the disposable bundle declares only that one row.
 * ABSENT: a user's real profile, credentials and physical GUI.
 * @module @xmoon76/dsh-pi-tui/test/support/subagent-section-fixture
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
const BUNDLE = 'subagent-section-bundle'
const PROFILE_NAME = 'subagent-section-profile'
/** The row id the official plugin ships under; it doubles as the settings
 *  namespace the TUI writer mutates. */
const SECTION_ROW = 'subagent-model-selection-settings'
const PLUGIN = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

export interface SubagentSectionPlane {
  readonly patchPath: string
  readonly profileDir: string
}

/** Mount the real subagent model-selection section over an already-mounted
 *  Loader. The caller owns Loader and disposes the Context. */
export async function mountSubagentSectionPlane(
  ctx: Context,
  workRoot: string,
  initial: { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] },
): Promise<SubagentSectionPlane> {
  const profileDir = join(workRoot, 'profile')
  const bundleDir = join(workRoot, 'section-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const anchor = require.resolve('@deepseek-ai/dsh-tool-subagent/package.json')
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
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${SECTION_ROW}`,
    `      name: ${JSON.stringify(PLUGIN)}`,
    '      config:',
    `        enabled: ${initial.enabled}`,
    `        allowedModels: ${JSON.stringify(initial.allowedModels)}`,
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
