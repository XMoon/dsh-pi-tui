/** Official configuration plane for both Subagent settings namespaces.
 *
 * REPRODUCED: real profile/bundle documents, the Loader root Include, the
 * official ConfigEditor and SettingsForms, and the official subagent runtime
 * and model-selection rows. The runtime row is the fixture's only subagent
 * manager; callers mount its prerequisites rather than a second runtime.
 * STAND-INS: the disposable bundle contains only the two relevant rows.
 * ABSENT: a user's real profile, credentials and physical terminal.
 * @module @xmoon76/dsh-pi-tui/test/support/subagent-section-fixture
 */
import { createRequire } from 'node:module'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
const BUNDLE = 'subagent-section-bundle'
const PROFILE_NAME = 'subagent-section-profile'
/** The row id the official plugin ships under; it doubles as the settings
 *  namespace the TUI writer mutates. */
const SECTION_ROW = 'subagent-model-selection-settings'
const PLUGIN = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

type Selection = { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] }
type Limits = { maxDepth: number; maxActiveSubagents: number }

export interface SubagentSectionInitial extends Selection {
  readonly limits?: Limits
  readonly userSelection?: Partial<Selection>
  readonly userLimits?: Partial<Limits>
  readonly homeLimits?: Partial<Limits>
}

export interface SubagentSectionPlane {
  readonly patchPath: string
  readonly profileDir: string
  /** Re-read the actual USER profile document through the official loader. */
  userConfig(namespace: string): unknown
}

/** Mount both real sections over an already-mounted Loader. The caller owns
 * the Context and supplies workingDirectory/sessionProjections prerequisites. */
export async function mountSubagentSectionPlane(
  ctx: Context,
  workRoot: string,
  initial: SubagentSectionInitial,
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
  const limits = initial.limits ?? { maxDepth: 1, maxActiveSubagents: 8 }
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: subagent',
    "      name: '@deepseek-ai/dsh-subagent'",
    `      config: ${JSON.stringify(limits)}`,
    `    - id: ${SECTION_ROW}`,
    `      name: ${JSON.stringify(PLUGIN)}`,
    '      config:',
    `        enabled: ${initial.enabled}`,
    `        allowedModels: ${JSON.stringify(initial.allowedModels)}`,
    '',
  ].join('\n'))
  symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
  const user = [
    ...initial.userLimits === undefined ? [] : [{ id: 'subagent', config: initial.userLimits }],
    ...initial.userSelection === undefined ? [] : [{ id: SECTION_ROW, config: initial.userSelection }],
  ]
  writeFileSync(patchPath, `${JSON.stringify(user)}\n`)
  const homeDir = join(workRoot, 'home')
  mkdirSync(homeDir)
  if (initial.homeLimits !== undefined) {
    writeFileSync(join(homeDir, 'cordis.patch.yml'), `${JSON.stringify([{ id: 'subagent', config: initial.homeLimits }])}\n`)
  }
  const profileContext = {
    name: PROFILE_NAME, dir: profileDir, patchPath, installAnchor: anchor,
    cwd: workRoot, home: homeDir, startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profileContext as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  const composed = readProfilePatches('dsh', profileContext)
  await mountRootInclude(ctx, patchPath, composed, pathToFileURL(anchor).href, 'dsh')
  await ctx.loader.await()
  return {
    patchPath, profileDir,
    userConfig: namespace => loadProfileDirectory('dsh', profileDir, anchor).patches
      .findLast(row => row.id === namespace && row.config !== undefined)?.config,
  }
}
