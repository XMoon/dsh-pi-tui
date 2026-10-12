/** Official configuration plane for isolated PRESET-default persistence
 * qualification.
 *
 * REPRODUCED: real profile/bundle documents, the Loader root Include, the
 * official ConfigEditor and SettingsForms, and the official preset DECLARING
 * plugin (`@deepseek-ai/dsh-agent-preset`, whose config IS one preset
 * definition) mounted as a bundle row — so the roster under test is declared
 * through the loader with a resolution base, exactly like a shipped preset.
 * STAND-INS: the disposable bundle declares fixture presets with no child
 * plugins, so no third-party plugin graph is needed.
 * ABSENT: a user's real profile, the shipped four preset declarations,
 * credentials, an HMR watcher and physical GUI.
 * @module @xmoon76/dsh-pi-tui/test/support/preset-profile-fixture
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
const BUNDLE = 'tsp-preset-profile-fixture'
const DECLARING_PLUGIN = '@deepseek-ai/dsh-agent-preset'
const REGISTRY_PLUGIN = '@deepseek-ai/dsh-agent-preset-registry'
const PROFILE_NAME = 'tsp-preset-profile'

export interface PresetProfileRow {
  readonly id: string
  readonly name?: string
}

/**
 * Mount the preset-declaring profile plane over an already-mounted Loader and
 * `agentPresets` registry. Returns the real patch document path the default
 * write must land in.
 */
export async function mountPresetProfile(
  ctx: Context,
  workRoot: string,
  rows: readonly PresetProfileRow[],
): Promise<{
  readonly patchPath: string
  readonly profileDir: string
  /** The composed profile-layer patches (the documents a composition reads). */
  readonly patches: readonly unknown[]
}> {
  const profileDir = join(workRoot, 'profile')
  const bundleDir = join(workRoot, 'preset-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const anchor = require.resolve(`${REGISTRY_PLUGIN}/package.json`)
  // A FRESH composition writes the disposable profile/bundle documents; a RELOAD
  // (`rows` empty) composes exactly what is already on disk, so it never rewrites
  // the saved patch document the default write landed in.
  if (rows.length > 0) {
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
    // The registry itself must be a PROFILE ROW: only a configurable plugin
    // entry gets a settings namespace, and the preset-default write mutates the
    // `agent-preset-registry` namespace.
    const rowsPatch = [
      `    - id: agent-preset-registry`,
      `      name: ${JSON.stringify(require.resolve(REGISTRY_PLUGIN))}`,
      `      config:`,
      `        default: ${JSON.stringify(rows[0]!.id)}`,
      ...rows.map((row) => [
        `    - id: preset-${row.id}`,
        `      name: ${JSON.stringify(require.resolve(DECLARING_PLUGIN))}`,
        `      config:`,
        `        id: ${JSON.stringify(row.id)}`,
        ...(row.name === undefined ? [] : [`        name: ${JSON.stringify(row.name)}`]),
        `        plugins: []`,
      ].join('\n')),
    ]
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), `- insert:\n${rowsPatch.join('\n')}\n`)
    symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
    writeFileSync(patchPath, '[]\n')
  }
  ctx.provide('profileContext', {
    name: PROFILE_NAME, dir: profileDir, patchPath, installAnchor: anchor,
    cwd: workRoot, home: workRoot, startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  // Startup must compose the persisted profile layer after the bundle layer;
  // bundles-only recovery loading would discard the saved override on restart.
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  const composed = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches]
  await mountRootInclude(ctx, patchPath, composed, pathToFileURL(anchor).href, 'dsh')
  await ctx.loader.await()
  return { patchPath, profileDir, patches: composed }
}
