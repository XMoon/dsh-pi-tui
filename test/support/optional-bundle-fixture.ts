/**
 * S4-D2 optional-bundle Host fixture (implementation plan §4.1).
 *
 * ONE isolated, real composition per bundle:
 *
 * ```text
 * temp installation manifest (the 12 shipped Optional bundles @ exact rc.2)
 *   └─ temp profile package.json (dsh.profile.bundles: base [+ target])
 *       └─ official loadProfileDirectory() reads the REAL bundle manifest and
 *          its REAL cordis.patch.yml files from the installation
 *           └─ official boot(): Loader + dsh-base + the profile's agent plane
 *              (the TUI overlay's preset registry / disabled base agent rows,
 *              the four generated preset mirrors) + the target bundle patch
 *               └─ real Host services / Agent / Session / ToolRuntime
 * ```
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published rc.2 `dsh-base` family
 * and the published rc.2 Optional bundle packages (exact version), the official
 * profile manifest/patch reader, the official boot Loader, the four shipped
 * preset declarations, real Agent/Session/ToolRuntime/permission services.
 * `TEST STAND-INS`: a temporary profile/installation root whose `node_modules`
 * is one provisioned rc.2 installation tree (a linked layout, not a copied
 * product graph), the TUI overlay's agent-plane rows without the TUI screen
 * rows, and a scripted LLM transport in the tests that own one.
 * `DELIBERATELY ABSENT`: the user's real `DSH_HOME`, network installs inside
 * tests, credentials, a physical GUI, and any TUI surface row.
 *
 * The fixture NEVER fabricates a bundle package: when the provisioned official
 * artifacts are absent it reports an explicit `BLOCKED` reason instead of
 * substituting a local same-name package.
 * @module @xmoon76/dsh-pi-tui/test/support/optional-bundle-fixture
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, loadOverlayPatches, loadProfileDirectory, OFFICIAL_ON_DEMAND_CATALOG, OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TestContext } from 'node:test'
import { testLifecycle } from './temp-lifecycle.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGET_DSH_VERSION = '0.2.1-rc.2'
const BASE_BUNDLE = '@deepseek-ai/dsh-base'
const BIN_NAME = 'dsh'

/** The exact rc.2 Optional/on-demand bundle identities (B01–B14). */
export const S4_D2_BUNDLE_IDS = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
] as const

export type S4D2BundleId = typeof S4_D2_BUNDLE_IDS[number]

/** The official rc.2 Optional + on-demand identity set (12 + 2). */
const OFFICIAL_BUNDLE_IDS = [
  ...OPTIONAL_BUNDLES,
  ...OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName),
] as const

/** Prove the fixture identity set against the OFFICIAL catalog constants, so a
 *  rename/shape drift fails loudly instead of comparing a constant to itself. */
function assertOfficialBundleIdentitySet(): void {
  const expected = new Set(OFFICIAL_BUNDLE_IDS)
  const actual = new Set(S4_D2_BUNDLE_IDS)
  if (expected.size !== actual.size || [...expected].some(name => !actual.has(name as S4D2BundleId))) {
    throw new Error(`S4-D2 fixture: bundle identity drift; official=${[...expected].join(',')} fixture=${[...actual].join(',')}`)
  }
}

/** The exact TUI-overlay agent-plane rows this Host-only composition keeps:
 *  the preset registry and its prerequisites. The TUI screen rows are NOT
 *  mounted (this fixture qualifies Host capability, not the terminal). */
const AGENT_PLANE_INSERT_IDS = new Set([
  'job-controller',
  'workspace',
  'file-reference-local',
  'agent-preset-registry',
  'subagent-model-selection-settings',
  'cordis-host-runner',
])

const GENERATED_PRESETS = ['standard', 'ptc', 'minimal', 'cordis'] as const

type BootPatches = NonNullable<Parameters<typeof boot>[2]>

export interface S4D2Installation {
  /** Directory whose `node_modules` holds the provisioned rc.2 packages. */
  readonly root: string
  /** `node_modules` of the provisioned installation tree. */
  readonly nodeModules: string
}

/** The provisioned installation root, or an explicit BLOCKED reason. */
export type S4D2InstallationResolution =
  | { readonly ok: true; readonly installation: S4D2Installation }
  | { readonly ok: false; readonly reason: string }

function installationCandidates(): readonly string[] {
  const configured = process.env.DSH_PI_TUI_S4_D2_INSTALLATION
  return [
    ...(configured === undefined || configured === '' ? [] : [configured]),
    join(REPO_ROOT, 'temp', 's4-d2-bundles'),
  ]
}

function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Format a `t.skip()` reason for an unavailable provisioned installation. */
export function skippedInstallationReason(required: readonly S4D2BundleId[] = S4_D2_BUNDLE_IDS): string | undefined {
  const resolution = resolveS4D2Installation(required)
  return resolution.ok ? undefined : resolution.reason
}

/**
 * Resolve the provisioned official rc.2 installation for the requested
 * bundles. A missing or wrong-version package is a concrete BLOCKED fact, never
 * a local same-name substitute.
 */
export function resolveS4D2Installation(required: readonly S4D2BundleId[] = S4_D2_BUNDLE_IDS): S4D2InstallationResolution {
  assertOfficialBundleIdentitySet()
  const requiredPackages = [BASE_BUNDLE, ...required]
  const attempts: string[] = []
  for (const root of installationCandidates()) {
    const nodeModules = join(root, 'node_modules')
    const problems: string[] = []
    for (const packageName of requiredPackages) {
      const manifest = readManifest(join(nodeModules, packageName, 'package.json'))
      if (manifest === undefined) {
        problems.push(`${packageName} is absent`)
        continue
      }
      if (manifest['name'] !== packageName) {
        problems.push(`${packageName} has mismatched manifest name ${String(manifest['name'])}`)
      }
      if (manifest['version'] !== TARGET_DSH_VERSION) {
        problems.push(`${packageName}@${String(manifest['version'])} is not @${TARGET_DSH_VERSION}`)
      }
      const repository = manifest['repository']
      const repositoryUrl = typeof repository === 'string'
        ? repository
        : (repository as { url?: unknown } | undefined)?.url
      if (typeof repositoryUrl !== 'string' || !repositoryUrl.includes('deepseek-ai/deepseek-harness')) {
        problems.push(`${packageName} lacks the official deepseek-harness repository provenance`)
      }
    }
    if (problems.length === 0) return { ok: true, installation: { root, nodeModules } }
    attempts.push(`${root}: ${problems.join('; ')}`)
  }
  return {
    ok: false,
    reason: `BLOCKED: no provisioned official DSH ${TARGET_DSH_VERSION} Optional-bundle installation was found. `
      + `Provision it with scripts/dsh-s4-d2-bundles-smoke.mjs --provision (or set DSH_PI_TUI_S4_D2_INSTALLATION); `
      + `checked: ${attempts.join(' | ')}`,
  }
}

export interface OptionalBundleHostOptions {
  /** The exact bundle packages whose real patch layers compose after base. */
  readonly bundles?: readonly S4D2BundleId[]
  /**
   * Bundle packages installed as PROFILE-owned dependencies (the on-demand
   * B13/B14 shape: a real published package in the profile). Shipped Optional
   * bundles need no entry here.
   */
  readonly profileDependencies?: Readonly<Record<string, string>>
  /** Mount the four generated official preset declarations (agent plane). */
  readonly presets?: boolean
  /** Extra official patch layers applied after the bundle layers. */
  readonly patches?: BootPatches
  /** Host-preparation hook (e.g. a scripted LLM adapter, an approval answerer). */
  readonly prepare?: (ctx: Context) => void | Promise<void>
  /** The working directory handed to fresh Agents (default: `<root>/work`). */
  readonly sessionCwd?: string
  /** Boot through the PROVISIONED installation's own `dsh-app-boot` module so
   *  every Host package module identity matches (required by the official
   *  ConfigEditor settings-write path). Defaults to the test-imported module. */
  readonly installationBoot?: boolean
}

export interface CreateAgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly preset?: string
  readonly cwd?: string
}

export interface OptionalBundleHost {
  readonly ctx: Context
  readonly root: string
  readonly profileDir: string
  readonly installation: S4D2Installation
  /** The bundle layers that participated in THIS boot, base first. */
  readonly activeBundles: readonly string[]
  /** The official Host plugin manager of this profile. */
  readonly pluginManager: {
    listBundles(): Promise<readonly unknown[]>
    setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  }
  /** Create a live Agent/Session through the official `ctx.agents` service. */
  createAgent(sessionId: SessionId, options?: CreateAgentOptions): Promise<Agent>
  /** The effective tool names one Agent (or the global scope) sees. */
  toolNames(agent?: Agent): string[]
  hasTool(name: string, agent?: Agent): boolean
  /** The durable session events of one Agent. */
  events(agent: Agent): readonly unknown[]
  /** The real Loader entry states (id, fiber state, failure message). */
  loaderEntries(): readonly { readonly id: string; readonly state: number; readonly error?: string }[]
  /** Dispose this Context and boot the SAME profile again from disk. */
  restart(): Promise<OptionalBundleHost>
  dispose(): Promise<void>
}

interface HostTracker {
  current: OptionalBundleHost | undefined
}

interface HostOptions {
  readonly root: string
  readonly installation: S4D2Installation
  readonly settings: OptionalBundleHostOptions
  readonly tracker: HostTracker
  readonly environment: EnvironmentOwner
  readonly lease: HostLease
}

/** One per-TestContext environment owner: every host shares the SAME captured
 *  original, and only the last released host restores it (hooks run FIFO). */
interface EnvironmentOwner {
  previous: Map<string, string | undefined>
  refs: number
  restored: boolean
}

interface HostLease {
  released: boolean
}

interface HostState {
  readonly ctx: Context
  readonly options: HostOptions
  readonly activeBundles: readonly string[]
}

/** Read the profile manifest's selected bundle layers (never a second store). */
function selectedBundles(profileDir: string): string[] {
  const manifest = readManifest(join(profileDir, 'package.json'))
  const bundles = (manifest?.['dsh'] as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(entry => typeof entry !== 'string')) {
    throw new Error(`S4-D2 fixture: ${join(profileDir, 'package.json')} has no readable dsh.profile.bundles`)
  }
  return bundles as string[]
}

function writeProfile(
  profileDir: string,
  bundles: readonly string[],
  dependencies: Readonly<Record<string, string>>,
  installationBoot: boolean,
): void {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 's4-d2-optional-bundle-profile',
    private: true,
    dependencies,
    dsh: { profile: { bundles, patch: 'cordis.patch.yml' } },
  }, null, 2))
  // HMR is deliberately disabled in this Host-only fixture (no application
  // readiness owner). Only the installation-boot variant performs official
  // ConfigEditor recomposes (real settings writes), so only it needs the same
  // fact on DISK; the default fixture keeps the historical empty profile patch.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), installationBoot ? '- id: hmr\n  disabled: true\n' : '[]\n')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
}

/** The official agent-plane layer of the TUI overlay, without its screen rows. */
function agentPlanePatches(): BootPatches {
  return loadOverlayPatches(BIN_NAME, join(REPO_ROOT, 'cordis.patch.yml')).flatMap((patch) => {
    if (patch.insert !== undefined) {
      const rows = patch.insert.filter(row => AGENT_PLANE_INSERT_IDS.has(String(row.id)))
      return rows.length === 0 ? [] : [{ ...patch, insert: rows }]
    }
    return patch.disabled === true ? [patch] : []
  })
}

function presetPatches(): BootPatches {
  return GENERATED_PRESETS.flatMap(id =>
    loadOverlayPatches(BIN_NAME, join(REPO_ROOT, 'generated', 'dsh-presets', `${id}.patch.yml`)))
}

/** Create the temp root and the real profile/installation documents on disk. */
function prepareRoot(
  root: string,
  installation: S4D2Installation,
  bundles: readonly string[],
  profileDependencies: Readonly<Record<string, string>>,
  installationBoot: boolean,
): string {
  const profileDir = join(root, 'profile')
  const home = join(root, 'home')
  const work = join(root, 'work')
  const installationDir = join(root, 'installation')
  for (const dir of [profileDir, home, work, installationDir]) mkdirSync(dir, { recursive: true })
  if (!existsSync(join(installationDir, 'node_modules'))) {
    symlinkSync(installation.nodeModules, join(installationDir, 'node_modules'), 'dir')
  }
  writeFileSync(join(installationDir, 'package.json'), JSON.stringify({
    name: 's4-d2-rc2-installation',
    private: true,
    dependencies: {
      [BASE_BUNDLE]: TARGET_DSH_VERSION,
      ...Object.fromEntries(OPTIONAL_BUNDLES.map(name => [name, TARGET_DSH_VERSION])),
    },
  }, null, 2))
  if (!existsSync(join(profileDir, 'node_modules'))) {
    // A real profile resolves its own installed dependencies here; the fixture
    // links the ONE provisioned rc.2 tree instead of duplicating it.
    symlinkSync(installation.nodeModules, join(profileDir, 'node_modules'), 'dir')
  }
  writeProfile(profileDir, bundles, profileDependencies, installationBoot)
  return profileDir
}

/** Resolve the OFFICIAL `dsh-app-boot` of the provisioned installation, so the
 *  Host modules share one instance (the ConfigEditor reload ledger is a
 *  module-level WeakMap keyed by the boot Context). */
async function installationBoot(installationManifest: string): Promise<typeof boot> {
  const packageJson = JSON.parse(readFileSync(join(dirname(installationManifest), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), 'utf8')) as { readonly main?: string }
  const entry = join(dirname(installationManifest), 'node_modules', '@deepseek-ai', 'dsh-app-boot', packageJson.main ?? 'lib/index.js')
  const loaded = await import(pathToFileURL(entry).href) as { readonly boot: typeof boot }
  return loaded.boot
}

async function bootAt(options: HostOptions): Promise<OptionalBundleHost> {
  const profileDir = join(options.root, 'profile')
  const installationManifest = join(options.root, 'installation', 'package.json')
  const profile = loadProfileDirectory(BIN_NAME, profileDir, installationManifest)
  if (profile.skippedBundles.length > 0) {
    throw new Error(`S4-D2 fixture: the profile could not load its selected bundles: ${profile.skippedBundles
      .map(bundle => `${bundle.packageName}: ${bundle.reason}`).join(' | ')}`)
  }
  const basePatches = profile.layers.filter(layer => layer.packageName === BASE_BUNDLE).flatMap(layer => layer.patches)
  const bundlePatches = profile.layers.filter(layer => layer.packageName !== BASE_BUNDLE).flatMap(layer => layer.patches)
  if (basePatches.length === 0) throw new Error('S4-D2 fixture: the profile did not compose the official dsh-base bundle')
  const patches: BootPatches = [
    ...basePatches,
    ...(options.settings.presets === true ? agentPlanePatches() : []),
    ...(options.settings.presets === true ? presetPatches() : []),
    // HMR needs a real application readiness owner; this Host-only fixture has
    // no TUI/CLI surface, so the module watcher is deliberately not mounted.
    { id: 'hmr', disabled: true },
    ...bundlePatches,
    ...profile.patches,
    ...(options.settings.patches ?? []),
  ]
  const profileContext = {
    name: 's4-d2-optional-bundle-profile',
    dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: installationManifest,
    cwd: options.settings.sessionCwd ?? join(options.root, 'work'),
    home: join(options.root, 'home'),
    startedBundles: profile.layers.map(layer => layer.packageName),
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  // The Loader can write the composed tree back into its root config when a
  // plugin self-disposes; production boot rewrites the empty root every start.
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  const bootFn = options.settings.installationBoot === true
    ? await installationBoot(installationManifest)
    : boot
  const ctx = await bootFn(BIN_NAME, join(profileDir, 'cordis.yml'), patches, async hostCtx => {
    hostCtx.provide('profileContext', profileContext)
    await options.settings.prepare?.(hostCtx)
  }, pathToFileURL(installationManifest).href)
  const state: HostState = { ctx, options, activeBundles: profile.layers.map(layer => layer.packageName) }
  const host: OptionalBundleHost = {
    ctx: state.ctx,
    root: options.root,
    profileDir,
    installation: options.installation,
    activeBundles: state.activeBundles,
    pluginManager: ctx.get('pluginManager') as OptionalBundleHost['pluginManager'],
    async createAgent(sessionId, agentOptions = {}) {
      const handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: agentOptions.cwd ?? options.settings.sessionCwd ?? join(options.root, 'work'),
          ...agentOptions.preset === undefined ? {} : { agentPreset: agentOptions.preset },
        },
        ...agentOptions.provider === undefined || agentOptions.model === undefined
          ? {}
          : { agentOptions: { provider: agentOptions.provider, model: agentOptions.model } },
        setup: () => {},
      })
      return handle.agent
    },
    toolNames(agent) {
      return ctx.tools.schemas(agent).map(schema => schema.name)
    },
    hasTool(name, agent) {
      return ctx.tools.get(name, agent) !== undefined
    },
    events(agent) {
      return agent.session.snapshotEvents() as unknown as readonly unknown[]
    },
    loaderEntries() {
      return collectLoaderEntries(ctx.get('loader'))
    },
    async restart() {
      // A disposed host has released its shared lease; a new boot would never
      // restore the original environment. Callers must start a fresh host.
      if (options.lease.released) throw new Error('S4-D2 fixture: cannot restart a disposed host')
      await ctx.fiber.dispose()
      // A restart is a fresh boot of THIS host's profile root: re-apply its
      // disposable environment before boot even when another host is live.
      // Only the LATEST host returned by restart owns disposal; a stale host
      // object must not be disposed after a restart.
      applyEnvironment(options.root)
      return bootAt(options)
    },
    async dispose() {
      try {
        await ctx.fiber.dispose()
      } finally {
        releaseEnvironment(options.environment, options.lease)
      }
    },
  }
  options.tracker.current = host
  return host
}

/** Walk the real Loader tree's own entry groups (never a second registry). */
function collectLoaderEntries(loader: unknown): Array<{ id: string; state: number; error?: string }> {
  const out: Array<{ id: string; state: number; error?: string }> = []
  const seen = new Set<unknown>()
  const walk = (tree: unknown): void => {
    if (tree === null || typeof tree !== 'object' || seen.has(tree)) return
    seen.add(tree)
    const store = (tree as { store?: Record<string, unknown> }).store
    if (store === undefined) return
    for (const raw of Object.values(store)) {
      const entry = raw as { options?: { id?: unknown }; fiber?: { state?: number; error?: unknown }; error?: unknown; subtree?: unknown }
      const id = entry.options?.id
      if (typeof id === 'string') {
        const error = entry.fiber?.error ?? entry.error
        out.push({
          id,
          state: entry.fiber?.state ?? -1,
          ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
        })
      }
      walk(entry.subtree)
    }
  }
  walk(loader)
  return out
}

// TMPDIR/TMP/TEMP stay ambient: the test-lifecycle temp roots must not nest
// inside a previous host's disposable tree. They carry no credential/agent
// state, so leaving them alone does not weaken the isolation boundary.
const ISOLATED_ENV_KEYS = [
  'HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
] as const

/** Point every credential/agent/cache/temp location at the disposable root;
 *  `scrubbedParentEnv()` preserves HOME, so native providers must never see the
 *  real one. Returns the exact previous values for restoration.
 *  (`TMPDIR`/`TMP`/`TEMP` intentionally stay ambient; this covers the
 *  credential/agent/cache roots only.) */
function environmentValues(root: string): Record<string, string> {
  const home = join(root, 'home')
  return {
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, '.agents'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  }
}

function applyEnvironment(root: string): void {
  const values = environmentValues(root)
  for (const key of ISOLATED_ENV_KEYS) process.env[key] = values[key]
}

function isolateEnvironment(root: string): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>()
  for (const key of ISOLATED_ENV_KEYS) previous.set(key, process.env[key])
  applyEnvironment(root)
  return previous
}

const environmentOwners = new WeakMap<TestContext, EnvironmentOwner>()

/** Acquire (or share) the test-context environment owner. A second concurrent
 *  host reuses the SAME original capture and points the process at its own
 *  disposable root; only the last release restores the original. */
function acquireEnvironment(t: TestContext, root: string): EnvironmentOwner {
  const existing = environmentOwners.get(t)
  if (existing === undefined || existing.refs === 0) {
    const owner: EnvironmentOwner = { previous: isolateEnvironment(root), refs: 0, restored: false }
    environmentOwners.set(t, owner)
    owner.refs += 1
    return owner
  }
  applyEnvironment(root)
  existing.refs += 1
  return existing
}

function releaseEnvironment(owner: EnvironmentOwner, lease: HostLease): void {
  if (lease.released) return
  lease.released = true
  owner.refs -= 1
  if (owner.refs === 0 && !owner.restored) {
    owner.restored = true
    restoreEnvironment(owner.previous)
  }
}

function restoreEnvironment(previous: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/**
 * Bind the fixture to one `TestContext` lifecycle and boot the host. Every temp
 * root and the per-test environment restore are owned by the test (shared
 * refcount, so concurrent hosts restore the original only at the last release).
 */
export async function startS4D2Host(
  t: TestContext,
  settings: OptionalBundleHostOptions,
): Promise<OptionalBundleHost> {
  const resolution = resolveS4D2Installation(settings.bundles ?? [])
  if (!resolution.ok) throw new Error(resolution.reason)
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s4-d2-')
  const tracker: HostTracker = { current: undefined }
  const lease: HostLease = { released: false }
  const environment = acquireEnvironment(t, root)
  // Fallback release if boot throws before a host exists; the host dispose is
  // normally the release path and this call is idempotent.
  life.defer(() => releaseEnvironment(environment, lease))
  const options: HostOptions = { root, installation: resolution.installation, settings, tracker, environment, lease }
  // Teardown releases whichever Context a restart left live, then the lease
  // fallback above observes an already-released lease.
  life.defer(() => tracker.current?.dispose())
  prepareRoot(
    root,
    resolution.installation,
    [BASE_BUNDLE, ...(settings.bundles ?? [])],
    settings.profileDependencies ?? {},
    settings.installationBoot === true,
  )
  return bootAt(options)
}

/** Whether a selected profile manifest still lists `bundle` (restart proof). */
export function profileSelectsBundle(profileDir: string, bundle: string): boolean {
  return selectedBundles(profileDir).includes(bundle)
}
