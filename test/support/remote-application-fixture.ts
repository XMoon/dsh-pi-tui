/**
 * Shared M3-4 PR1 remote-application test fixture: the ordinary rc.2 Host
 * Context (the same base shape as the M3-1 L5 suite), the unsupported
 * prompt-serializer stand-in, and the bounded wait helper. Consumers:
 * test/app/remote-application-runtime.test.ts (the aggregate) and
 * test/app/application-runtime-selection.test.ts (the real selection chain).
 *
 * FIXTURE MANIFEST (L5 evidence governance; see each consuming suite's own
 * header for the per-suite view):
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - real rc.2 Host services required by the composition: real persistence
 *   (Jsonl), storage/domain, credentials, jobs + job controller, gateway,
 *   loader, presets, userQuestions, workspace, filesystem
 * - the official in-process Client/Gateway path over the real carrier
 * - M3 additive Host rows mount/unwind with the composed runtime
 * - the OFFICIAL `@deepseek-ai/dsh-api-workspace-files` Host service plus the
 *   Host sandbox-policy service it injects (Delivered files PR2): the same two
 *   official services the production `cordis.patch.yml` row composes. The
 *   bundle's patch ALWAYS mounts that row, so the Remote composition's
 *   `workspaceFiles` prerequisite is a production fact here too — reproducing
 *   it is parity, not a substitution.
 * - with `pluginManagerProfile: true` (M3-5 PR4): a real managed profile
 *   directory (`profileContext`) plus the real base-owned
 *   `@deepseek-ai/dsh-plugin-manager` Host service, so the Remote Plugin
 *   Manager L6 reads the genuine Host authority over the wire
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - `agentDefaultModel` + `webServer`: the minimal readiness values the
 *   composition requires (identical to the M3-1 L5 fixture); they carry no
 *   Remote-wire state.
 * - `fileReferences` (TS8-HF1): the official `@`-file reference provider the
 *   production Host mounts from `@deepseek-ai/dsh-file-reference-local`. The
 *   Remote Host composition now requires it (the private `piTuiFileReferences`
 *   bare route delegates to it); the stand-in answers an empty workspace index
 *   and no consumer of this fixture asserts its candidates. The REAL service
 *   is opt-in for the wire proofs (`fileReferences: 'local'`).
 * - the LLM adapter (`StubLlmAdapter` by default; PR3 suites inject a real
 *   scripted streaming adapter): a scripted endpoint stand-in — the Host
 *   emits REAL agent events, the wire forwards them, only the model itself
 *   is synthetic.
 * - the prompt serializer ONLY for suites that still pass PR1's unsupported
 *   test double (the PR3 submission suites compose the PRODUCTION
 *   serializer instead).
 *
 * REAL PRODUCTION CAPABILITIES (exercised, not substituted)
 * - attachments: the frozen-rc.2 `LocalAttachmentStore`
 *   (`@deepseek-ai/dsh-attachment-local`, devDependency) mounted at the
 *   workRoot — real admission/normalization, real content-addressed
 *   durable objects, real readImage. The PR3 Image L6 traverses this REAL
 *   path end to end (staged bytes → PromptContentPart → durable
 *   attachment → official readAttachment → byte equality).
 *
 * The PR1 composition proofs (identity, disposal ordering, failure unwind)
 * remain valid because they never traverse the stand-in paths; the PR3
 * suites that DO traverse submission/image paths run against the production
 * capabilities above.
 * @module @xmoon76/dsh-pi-tui/support/remote-application-fixture
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as piTuiHostRuntime from '../../src/app/host/pi-tui-host-runtime.ts'
import * as performanceHost from '../../src/app/host/performance-host.ts'
import type { RemotePromptSerializer } from '../../src/runtime/remote/session-writer-remote.ts'
import { testLifecycle, type TestLifecycle } from './temp-lifecycle.ts'

/** The unsupported prompt serializer stand-in: the plan-sanctioned
 *  prompt-serializer substitution (the only PR1-specific SEMANTIC
 *  substitution — the readiness stand-ins are listed in the header). */
export const testPromptSerializer: RemotePromptSerializer = {
  preflight: () => ({ kind: 'unsupported', reason: 'm3-4 pr1 composition test: no production serializer yet' }),
  serialize: async () => ({ kind: 'unsupported', reason: 'm3-4 pr1 composition test: no production serializer yet' }),
}

/** Bounded test-local wait. */
export async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** In-process stub LLM route (the proven M2 fixture shape). */
export class StubLlmAdapter extends LlmAdapter {
  override resolveModel(_provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider: 'smoke', id: model, name: model })
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider: 'smoke', id: 'smoke', name: 'smoke' }])
  }

  override async *stream(_options: unknown): AsyncGenerator<never> {}
}

/** The managed profile fixture the real base-owned PluginManager prerequisite
 *  reads (M3-5 PR4 L6): a real profile directory + a real dsh installation
 *  anchor, plus ONE distinctive disposable bundle listed while DISABLED (the
 *  official toggle target) and a `@xmoon76/dsh-pi-tui`-named stand-in for the
 *  Current-TUI negative control. */
export interface PluginManagerProfileFixture {
  /** The real managed profile directory (`profileContext.dir`). */
  readonly profileDir: string
  /** The distinctive fixture bundle (togglable, listed while disabled). */
  readonly bundleName: string
  /** The bundle names the profile manifest currently selects (Host truth). */
  selectedBundles(): readonly string[]
}

/** The fixture bundle name (distinctive, never a production package). */
export const PLUGIN_MANAGER_FIXTURE_BUNDLE = 'm3-5-pr4-fixture-bundle'

/**
 * Build the real managed profile directory the base-owned PluginManager
 * prerequisite reads: a real profile manifest + patch, a real dsh installation
 * anchor manifest, ONE distinctive disposable bundle listed while DISABLED,
 * and a `@xmoon76/dsh-pi-tui`-named stand-in (the exact-name Current-TUI
 * negative-control target).
 */
function mountPluginManagerProfile(
  workRoot: string,
  options: {
    /**
     * Build a profile with NO installed fixture bundles: the base-owned
     * `profileContext`/Loader/PluginManager graph stays the same, but a real
     * `installBundle()` call is the only way a package can arrive. Used by the
     * S5 A09/A10 real-Host install evidence; the default keeps the M3-5 PR4
     * fixture bundle for the toggle tests.
     */
    readonly emptyProfile?: boolean
  } = {},
): {
  profileContext: Record<string, unknown>
  fixture: PluginManagerProfileFixture
} {
  const profileDir = join(workRoot, 'profile')
  const installationDir = join(workRoot, 'installation')
  const installationAnchor = join(installationDir, 'package.json')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(installationDir, { recursive: true })
  writeFileSync(installationAnchor, JSON.stringify({
    name: 'm3-5-pr4-fixture-installation',
    private: true,
    dependencies: {},
  }, null, 2))
  if (options.emptyProfile !== true) {
    const fixtureBundleDir = join(profileDir, 'node_modules', PLUGIN_MANAGER_FIXTURE_BUNDLE)
    const selfBundleDir = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    mkdirSync(fixtureBundleDir, { recursive: true })
    mkdirSync(selfBundleDir, { recursive: true })
    // A real bundle manifest (no patch rows): the official manager lists it,
    // resolves it, and can select it through the profile manifest.
    writeFileSync(join(fixtureBundleDir, 'package.json'), JSON.stringify({
      name: PLUGIN_MANAGER_FIXTURE_BUNDLE,
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: [] } },
    }, null, 2))
    // The Current-TUI protection is the exact shipped name; only a resolvable
    // manifest is needed for the card to exist (its patch declares no rows).
    writeFileSync(join(selfBundleDir, 'package.json'), JSON.stringify({
      name: '@xmoon76/dsh-pi-tui',
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: [] } },
    }, null, 2))
  }
  const fixtureDependencies = options.emptyProfile === true
    ? {}
    : { [PLUGIN_MANAGER_FIXTURE_BUNDLE]: '0.0.0', '@xmoon76/dsh-pi-tui': '0.0.0' }
  const writeManifest = (bundles: readonly string[]): void => {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'm3-5-pr4-fixture-profile',
      private: true,
      dependencies: fixtureDependencies,
      dsh: { profile: { bundles, patch: 'cordis.patch.yml' } },
    }, null, 2))
  }
  writeManifest([])
  writeFileSync(profilePatchPath, '[]\n')
  return {
    profileContext: {
      name: 'm3-5-pr4-fixture',
      dir: profileDir,
      patchPath: profilePatchPath,
      installAnchor: installationAnchor,
      cwd: workRoot,
      home: workRoot,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
    fixture: {
      profileDir,
      bundleName: PLUGIN_MANAGER_FIXTURE_BUNDLE,
      selectedBundles: () => {
        const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
          dsh?: { profile?: { bundles?: string[] } }
        }
        return manifest.dsh?.profile?.bundles ?? []
      },
    },
  }
}

/** The location roots a real package install must never read from the
 *  developer's machine. `TMPDIR`/`TMP`/`TEMP` stay ambient deliberately: the
 *  test-lifecycle roots must not nest inside a previous host's disposable tree. */
const ISOLATED_HOME_KEYS = [
  'HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
] as const

/** Explicit package-manager config/auth environment a real `pnpm` child could
 *  inherit from the runner. Home/XDG redirection alone does NOT neutralize
 *  these: `npm_config_userconfig`/`NPM_CONFIG_USERCONFIG` (and their global/cache
 *  twins) name paths outside the fixture root, so the real-pnpm evidence must
 *  remove them and substitute test-owned paths. */
const PACKAGE_MANAGER_ENV_PATTERN = /^(?:npm|pnpm)_config_/i
const PACKAGE_MANAGER_AUTH_PATTERN = /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)$/i

/** Point every credential/config/cache store at the fixture root. Returns the
 *  exact restore action; the caller owns it through the test lifecycle. */
function isolateFixtureHome(root: string): () => void {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const values: Record<(typeof ISOLATED_HOME_KEYS)[number], string> = {
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, '.agents'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  }
  const previous = new Map<string, string | undefined>()
  const remember = (key: string): void => {
    if (!previous.has(key)) previous.set(key, process.env[key])
  }
  for (const key of ISOLATED_HOME_KEYS) {
    remember(key)
    process.env[key] = values[key]
  }
  // Remove every ambient package-manager config/auth override, then point the
  // explicit user/global config and cache at test-owned empty paths. Registry
  // selection stays the caller's explicit install option.
  for (const key of Object.keys(process.env)) {
    if (!PACKAGE_MANAGER_ENV_PATTERN.test(key) && !PACKAGE_MANAGER_AUTH_PATTERN.test(key)) continue
    remember(key)
    delete process.env[key]
  }
  // npm refuses to load the SAME file as both user and global config, so the
  // two test-owned files stay distinct (both empty).
  const userNpmrc = join(home, '.npmrc')
  const globalNpmrc = join(home, '.npmrc.global')
  writeFileSync(userNpmrc, '')
  writeFileSync(globalNpmrc, '')
  const cache = join(home, '.npm-cache')
  mkdirSync(cache, { recursive: true })
  const overrides: Record<string, string> = {
    npm_config_userconfig: userNpmrc,
    NPM_CONFIG_USERCONFIG: userNpmrc,
    npm_config_globalconfig: globalNpmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    npm_config_cache: cache,
    NPM_CONFIG_CACHE: cache,
  }
  for (const [key, value] of Object.entries(overrides)) {
    remember(key)
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The ordinary rc.2 Host fixture: real services, no M3 rows, no Remote composition. */
/**
 * Mount the OFFICIAL Host workspace-file service the Remote composition
 * requires (`@deepseek-ai/dsh-api-workspace-files`) together with the sandbox
 * policy it injects.
 *
 * The production `cordis.patch.yml` ALWAYS mounts that row, so a Host graph
 * that composes the Remote backend must reproduce the same two official
 * services — exactly once, never a second copy and never a stand-in. Exported
 * so every suite that builds its OWN Host Context composes the same rows
 * instead of hand-rolling them.
 * @param ctx - the Host Context the graph mounts onto.
 */
export async function mountWorkspaceFileService(ctx: Context): Promise<void> {
  const SandboxPolicyService = (await import('@deepseek-ai/dsh-sandbox-policy')).default
  await ctx.plugin(SandboxPolicyService)
  const WorkspaceFiles = (await import('@deepseek-ai/dsh-api-workspace-files')).default
  await ctx.plugin(WorkspaceFiles)
}

export async function createRemoteApplicationHostFixture(
  life: TestLifecycle,
  presetId: string,
  options: {
    /** Replace the default `smoke` LLM adapter (e.g. a streaming stand-in).
     *  The default registers the non-streaming `StubLlmAdapter`. */
    readonly llmAdapter?: LlmAdapter
    /**
     * Reproduce the base-owned Host PluginManager prerequisite (M3-5 PR4):
     * a real `profileContext` over a real profile directory plus the real
     * `@deepseek-ai/dsh-plugin-manager` Host service. Off by default so every
     * other consumer keeps its exact previous composition.
     *
     * `{ emptyProfile: true }` keeps the SAME official graph but writes a
     * profile with no installed fixture bundles, so a real `installBundle()`
     * is the only way a package can arrive (S5 A09/A10 real-install
     * evidence).
     */
    readonly pluginManagerProfile?: boolean | {
      readonly emptyProfile?: boolean
    }
    /**
     * Point HOME/USERPROFILE/DSH_HOME/DSH_AGENTS_HOME and the four XDG roots at
     * this fixture's disposable root before the composition boots. Required for
     * a REAL pnpm install so the package store, user config and credentials
     * never touch the developer's real home (S5 A09/A10).
     */
    readonly isolateHome?: boolean
    /**
     * TS8-HF1: the Host `@`-file reference provider the private
     * `piTuiFileReferences` bare route delegates. `'local'` mounts the REAL
     * `@deepseek-ai/dsh-file-reference-local` service the production Host
     * mounts; a provider object is used as-is; the default is the empty
     * stand-in (see the FIXTURE MANIFEST header).
     */
    readonly fileReferences?: 'local' | {
      list(
        agent: unknown,
        query: string,
        signal?: AbortSignal,
      ): Promise<readonly { readonly path: string; readonly kind: 'file' | 'directory' }[]>
    }
  } = {},
): Promise<{
  ctx: Context
  workRoot: string
  anchorDir: string
  /** The production AgentLoop test driver (composes real live Agents). */
  harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
  /** Present only with `pluginManagerProfile: true`. */
  pluginManager?: PluginManagerProfileFixture
  dispose(): Promise<void>
}> {
  const workRoot = life.tempDir('dsh-m3-4-pr1-')
  if (options.isolateHome === true) life.defer(isolateFixtureHome(workRoot))
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const ctx = new Context()
  let persistenceFiber: Fiber | undefined
  let harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>> | undefined
  let pluginManager: { profileContext: Record<string, unknown>; fixture: PluginManagerProfileFixture } | undefined
  try {
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
    harness = await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['smoke'], options.llmAdapter ?? new StubLlmAdapter())
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'smoke', model: 'smoke' }),
      saveSelection: async () => {},
    })
    // The REAL durable attachment backend (M3-4 PR3 image L6): the frozen
    // rc.2 LocalAttachmentStore — content-addressed objects under the
    // workRoot, real normalization/admission, real readImage. This replaces
    // PR2's hand-provided identity stub (which sufficed only because no
    // Remote prompt ever carried an image).
    const LocalAttachmentStore = (await import('@deepseek-ai/dsh-attachment-local')).default
    await ctx.plugin(LocalAttachmentStore, { dshHome: workRoot })
    ctx.provide('webServer', { registerUpgrade: () => () => {} })
    // Host prerequisite for the M3 Remote composition (TS8-HF1): the private
    // `piTuiFileReferences` bare route delegates the official provider. The
    // production Host mounts `@deepseek-ai/dsh-file-reference-local`; this
    // stand-in is the empty workspace index the composition needs to exist
    // (see the FIXTURE MANIFEST header).
    if (options.fileReferences === 'local') {
      const LocalFileReferenceService = (await import('@deepseek-ai/dsh-file-reference-local')).default
      await ctx.plugin(LocalFileReferenceService)
    } else {
      ctx.provide('fileReferences',
        (options.fileReferences ?? { list: async () => [] }) as never)
    }
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(Loader)
    if (options.pluginManagerProfile !== undefined && options.pluginManagerProfile !== false) {
      pluginManager = mountPluginManagerProfile(
        workRoot,
        typeof options.pluginManagerProfile === 'object' ? options.pluginManagerProfile : {},
      )
      ctx.provide('profileContext', pluginManager.profileContext as never)
      // The REAL base-owned Host service (`@deepseek-ai/dsh-base` mounts it
      // when a profile exists): the M3 additive Host runtime must REUSE it and
      // never mount a second manager.
      const PluginManager = (await import('@deepseek-ai/dsh-plugin-manager')).default
      await ctx.plugin(PluginManager, {})
    }
    await ctx.plugin(AgentPresetRegistry, { default: presetId })
    await ctx.get('agentPresets')!.register({ id: presetId, name: `preset ${presetId}`, plugins: [] })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    await ctx.plugin(LocalFileSystem)
    // The OFFICIAL Host file service (the bundle's `workspace-files` row) — a
    // Remote-composition prerequisite, mounted exactly once.
    await mountWorkspaceFileService(ctx)
    // 0.2.1-rc.2's SessionController nests the official skill catalog and the real
    // `@`-file reference provider injects the directory owner: both require
    // the real `workingDirectory` service (the same row dsh-base mounts once).
    await ctx.plugin(WorkingDirectory)
    // M4-B2-HF: the built-in PiTui Host Runtime owns the package contribution
    // and both private Host services exactly once; Performance remains its own
    // independent row. `createRemoteHostRuntime()` only verifies their gates.
    await ctx.plugin(piTuiHostRuntime)
    await ctx.plugin(performanceHost)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    // The REAL writable credential provider the production base composition
    // mounts (`packages/bundle/base/cordis.patch.yml`, id `credentials`):
    // the abstract `@deepseek-ai/dsh-credentials` seam has no set/unset, so
    // mounting it here made every credential WRITE fail with "credentials.set
    // is not a function" — a fixture prerequisite error, not a product gap.
    await ctx.plugin(LocalCredentials, { path: join(workRoot, '.credentials.yaml'), watch: false })
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(toolJobs)
    await ctx.plugin(JobController, {})
    // 0.2.1-rc.2 requires the Gateway's access decider: `TypertGatewayService.inject`
    // is ['typert', 'remoteAccess'], so the official RemoteAccess owner mounts
    // first (the base layer's order) — never a fake `remoteAccess` provide.
    await ctx.plugin(RemoteAccessService)
    await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
      new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
    })
  } catch (error) {
    try {
      await persistenceFiber?.dispose()
    } catch {
      // The context disposal below still runs.
    }
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      await persistenceFiber?.dispose()
    } catch (error) {
      await ctx.fiber.dispose().catch(() => {})
      throw error
    }
    await ctx.fiber.dispose()
  }
  life.defer(dispose)
  assert.ok(harness !== undefined, 'the agent-loop harness must be mounted')
  return {
    ctx,
    workRoot,
    anchorDir,
    harness,
    ...pluginManager === undefined ? {} : { pluginManager: pluginManager.fixture },
    dispose,
  }
}

export { testLifecycle }
