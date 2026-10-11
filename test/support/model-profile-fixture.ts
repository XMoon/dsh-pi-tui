/** Official configuration plane for isolated Model persistence qualification.
 * REPRODUCED: real profile/bundle documents, Loader root Include, official
 * ConfigEditor, SettingsForms and AgentDefaultModelConfig with a live entry.
 * STAND-INS: the disposable bundle provides only the real default-model row;
 * model endpoints and tty are supplied by the caller's separate fixture.
 * ABSENT: a user's real profile, credentials, HMR watcher and physical GUI.
 */
import { createRequire } from 'node:module'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import type { ModelSelectionDto } from '../../src/runtime/catalog-port.ts'

const require = createRequire(import.meta.url)
const BUNDLE = 'tsp-model-profile-fixture'
export const MODEL_PROFILE_ROW = 'model-default'

/** The caller mounts and owns Loader before acquiring this profile plane. */
export async function mountModelProfile(
  ctx: Context,
  workRoot: string,
  initial: ModelSelectionDto | undefined,
): Promise<{ readonly patchPath: string; readonly profileDir: string }> {
  const profileDir = join(workRoot, 'profile')
  const bundleDir = join(workRoot, 'model-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const anchor = require.resolve('@deepseek-ai/dsh-agent-default-model/package.json')
  if (initial !== undefined) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'tsp-model-profile', private: true,
      dsh: { profile: { bundles: [BUNDLE], patch: 'cordis.patch.yml' } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: BUNDLE, version: '0.0.0', private: true,
      dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${MODEL_PROFILE_ROW}`,
      `      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-agent-default-model'))}`,
      `      config: ${JSON.stringify(initial)}`,
      '',
    ].join('\n'))
    symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
    writeFileSync(patchPath, '[]\n')
  }
  ctx.provide('profileContext', {
    name: 'tsp-model-profile', dir: profileDir, patchPath, installAnchor: anchor,
    cwd: workRoot, home: workRoot, startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  // Startup must compose the persisted profile layer after the bundle layer;
  // bundles-only recovery loading would discard the saved override on restart.
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  await mountRootInclude(ctx, patchPath, [
    ...profile.layers.flatMap(layer => layer.patches), ...profile.patches,
  ], pathToFileURL(anchor).href, 'dsh')
  await ctx.loader.await()
  return { patchPath, profileDir }
}
