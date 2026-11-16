/** Official FR5-B configuration plane: the real profile/bundle documents, the
 * Loader root Include, the official ConfigEditor and SettingsForms, and the
 * official `agent-loop`, `bash-sandbox` and `session-log-deepseek` rows.
 *
 * REPRODUCED: real profile patches, ConfigEditor/SettingsForms, the official
 * plugins and their live volatile config objects.
 * STAND-INS: the disposable bundle contains only these rows; the caller mounts
 * their prerequisite services.
 * ABSENT: a user's real profile, credentials and physical terminal.
 * @module @xmoon76/dsh-pi-tui/test/support/host-sections-fixture
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
const BUNDLE = 'host-sections-bundle'
const PROFILE_NAME = 'host-sections-profile'

export interface HostSectionsInitial {
  /** The bundle `agent-loop` config; absent = the plugin's own defaults. */
  readonly agentLoop?: { readonly maxParallelToolCalls?: number }
  /** The bundle `bash-sandbox` config; absent = `{ timeoutMs: 60000 }`. */
  readonly bashSandbox?: { readonly timeoutMs?: number; readonly maxOutputBytes?: number }
  /** The bundle `session-log-deepseek` config; absent = enabled true. */
  readonly sessionLog?: { readonly enabled?: boolean }
  /** The USER profile patch rows, keyed by plugin id. */
  readonly user?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export interface HostSectionsPlane {
  readonly patchPath: string
  readonly profileDir: string
  /** Re-read the actual USER profile document through the official loader. */
  userConfig(namespace: string): unknown
}

/** Mount the real rows over an already-mounted Loader context. */
export async function mountHostSectionsPlane(
  ctx: Context,
  workRoot: string,
  initial: HostSectionsInitial = {},
): Promise<HostSectionsPlane> {
  const profileDir = join(workRoot, 'profile')
  const bundleDir = join(workRoot, 'section-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const anchor = require.resolve('@deepseek-ai/dsh-agent-loop/package.json')
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
  const bash = initial.bashSandbox ?? { timeoutMs: 60_000 }
  const sessionLog = initial.sessionLog ?? {}
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: agent-loop',
    "      name: '@deepseek-ai/dsh-agent-loop'",
    '      config:',
    `        agents: []${initial.agentLoop?.maxParallelToolCalls === undefined ? '' : `\n        maxParallelToolCalls: ${initial.agentLoop.maxParallelToolCalls}`}`,
    '    - id: bash-sandbox',
    "      name: '@deepseek-ai/dsh-bash-sandbox'",
    '      config:',
    `        timeoutMs: ${bash.timeoutMs ?? 60_000}`,
    ...bash.maxOutputBytes === undefined ? [] : [`        maxOutputBytes: ${bash.maxOutputBytes}`],
    '    - id: session-log-deepseek',
    "      name: '@deepseek-ai/dsh-session-log-deepseek'",
    ...sessionLog.enabled === undefined
      ? []
      : [
          '      config:',
          `        enabled: ${sessionLog.enabled}`,
        ],
    '',
  ].join('\n'))
  symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
  const userRows = Object.entries(initial.user ?? {}).map(([id, config]) => ({ id, config }))
  writeFileSync(patchPath, `${JSON.stringify(userRows)}\n`)
  const homeDir = join(workRoot, 'home')
  mkdirSync(homeDir)
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
