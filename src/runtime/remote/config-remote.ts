/**
 * The Remote config adapter (M3-3B) — the official rc.2 wire mapping of
 * `ConfigPort` over ONE M3-1 `RemoteClientRuntime`. It implements the SAME
 * semantic contract as `src/runtime/direct/config-direct.ts`; no Remote-only
 * Config semantics and no Direct fallback exist.
 *
 * Published mapping (docs/m3-entry-contract.md §2.3):
 *
 * ```text
 * TUI settings / footer trust / custom items / providers / permissions /
 * preset default / subagent model selection
 *   -> one serialized, generation-aware Client-local settings mirror over
 *      remote.settings.describe()
 * provider directory -> remote.llm.listConfigurableProviders()
 * permission catalog -> remote.permissionPresets.catalog()
 * preset roster      -> remote.agentPresets.list()
 * API-key references -> remote.credentials.set|unset|describe
 * preset apply       -> remote.commands.execute(`/permission <preset>`)
 * ```
 *
 * Explicitly unsupported on the wire (docs/m3-entry-contract.md §10):
 * authorization flows (no `authorization` namespace anywhere in rc.2),
 * credential-record enumeration/deletion (no `credentials/list` or record
 * delete Remote), and the exact independent session approval-policy read
 * (`approvalOverrideOf` answers `undefined` as "unavailable", never `ask`).
 *
 * Frozen sync/async bridge (§2.3): the port's synchronous reads (`get()`,
 * `presetNames()`, `listCredentialOptions()`, ...) cannot await the wire, so
 * the adapter owns ONE mirror snapshot that `describe()` commits. The
 * invalidation listeners are installed in the constructor, BEFORE the first
 * `describe`, so a document/adapter/catalog change that lands between
 * construction and the first read is still observed by the fence. A
 * `describe()` result commits only when the generation captured before the
 * read is still current AND no invalidation landed during the read;
 * otherwise it is discarded and re-read (bounded). Invalidations mark the
 * snapshot non-current (`readiness()` reports `stale`); they do NOT spawn
 * unowned background work — the application seam drives `describe()`.
 * Writes are serialized, await the official settlement, and then refresh
 * from authority through `describe()`; the mirror is never optimistically
 * patched with the requested value.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/config-remote
 */

import { credentialOptionsFor, providerOptionsFor, type ProviderCatalogEntry, type ProviderOption } from '../../provider-catalog.ts'
import {
  resolveTrustedFooterCommand,
  resolveUserCommandItemActivationIds,
  resolveUserCommandItemFallbackActivationIds,
  resolveUserLayerFooterMode,
} from '../../footer/command-trust.ts'
import { parseFooterCustomItems, type FooterCustomItemsParseResult } from '../../footer/custom-items.ts'
import type {
  AuthorizationConfig,
  AuthorizationFlowEvent,
  AuthorizationFlowTarget,
  ConfigPort,
  CredentialConfig,
  CredentialProviderOption,
  FooterCommandTrust,
  FooterCustomItemsConfig,
  FooterCustomItemsRaw,
  PermissionConfig,
  PresetDefaultConfig,
  ProviderProfileConfig,
  SubagentAllowedModelRoute,
  SubagentModelSelectionConfig,
  TuiSettingsConfig,
  TuiSettingsDoc,
  ConfigReadiness,
} from '../config-port.ts'
import { SupersededReadError } from '../read-error.ts'
import type { RemoteCommandsSource } from './host-command-remote.ts'
import type { RemoteLlmRemotes } from './model-remote.ts'
import type { RemotePresetRemotes } from './preset-remote.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import { remoteFailureMessage } from './write-failure.ts'

/* ------------------------------------------------------------------------- *
 * Structural official rc.2 wire faces (never a Host package import).
 * ------------------------------------------------------------------------- */

/** One path-addressed settings edit, mirroring the official
 *  `SettingsPathOpView` with plain strings (the branded key space never
 *  crosses the port). The path/value payload is opaque wire data. */
export type RemoteSettingsPathOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: string[] }

/** The official `SettingsNamespaceView` subset the mirror projects. */
export interface RemoteSettingsNamespaceView {
  readonly ns: string
  /** Redacted resolved value (defaults → base → user). */
  readonly value?: unknown
  readonly base?: unknown
  /** Redacted raw USER section; a field's presence marks it user-overridden. */
  readonly user?: unknown
  /** Revision of the raw entry this view was read at (the write fence). */
  readonly revision?: number
}

/** The official `SettingsDescribeValue` subset. */
export interface RemoteSettingsDescribeValue {
  readonly writable?: boolean
  readonly hasDocument?: boolean
  readonly namespaces: readonly RemoteSettingsNamespaceView[]
}

/** The official generated `settings` Remote face consumed by the mirror. */
export interface RemoteSettingsRemotes {
  describe(): Promise<RemoteResultLike<RemoteSettingsDescribeValue>>
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<RemoteResultLike<RemoteSettingsNamespaceView>>
  replace(ns: string, section: Record<string, unknown>, expectedRevision: number | undefined): Promise<RemoteResultLike<RemoteSettingsNamespaceView>>
  mutate(ns: string, ops: readonly RemoteSettingsPathOp[], expectedRevision: number | undefined): Promise<RemoteResultLike<RemoteSettingsNamespaceView>>
}

/** One credential reference view (`dsh-credentials` `CredentialInfo`; the
 *  secret value has no slot). */
export interface RemoteCredentialInfoView {
  readonly configured: boolean
  readonly source?: string
  readonly writable?: boolean
}

/** The official generated `credentials` Remote face (references only). */
export interface RemoteCredentialsRemotes {
  describe(refs: string[]): Promise<RemoteResultLike<Record<string, RemoteCredentialInfoView>>>
  set(ref: string, value: string): Promise<RemoteResultLike<void>>
  unset(ref: string): Promise<RemoteResultLike<void>>
}

/** One selectable permission preset (`PresetOption`). */
export interface RemotePermissionPresetOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

/** The official `PermissionCatalog` subset the mirror caches. */
export interface RemotePermissionCatalogView {
  readonly options: readonly RemotePermissionPresetOption[]
  readonly defaultPreset?: string
}

/** The official generated `permissionPresets` Remote face. */
export interface RemotePermissionPresetRemotes {
  catalog(): Promise<RemoteResultLike<RemotePermissionCatalogView>>
}

/** The official generated `llm` directory method (`llm/listConfigurableProviders`).
 *  `RemoteLlmRemotes` (model-remote.ts) only declares the discovery probe, so
 *  the directory method is added HERE instead of widening that shared type
 *  (this adapter may not edit it). */
export interface RemoteLlmDirectoryRemotes {
  listConfigurableProviders(): Promise<RemoteResultLike<readonly ProviderCatalogEntry[]>>
}

/** The forwarded Host events this adapter subscribes to (the rc.2
 *  `dsh-api-remotes` allowlist). The scoped subjects arrive as their
 *  projected string identities. */
export interface RemoteConfigEventsSource {
  $on(
    event: 'settings/document-updated',
    listener: (ns: string, revision: number) => void,
  ): () => void
  $on(event: 'credentials/reference-updated', listener: (ref: string) => void): () => void
  $on(event: 'credentials/record-updated', listener: (key: string) => void): () => void
  $on(event: 'permission-presets/catalog-changed', listener: () => void): () => void
  $on(event: 'llm/adapters-updated', listener: () => void): () => void
}

/** The narrow one-source runtime face this adapter consumes. No `sessions`
 *  field is needed: every Config read is process-scoped, and the only
 *  session-scoped method (`approvalOverrideOf`) is deliberately unavailable
 *  on the wire (§10). */
export interface RemoteConfigRuntimeSource {
  readonly remote: {
    readonly settings: RemoteSettingsRemotes
    readonly credentials: RemoteCredentialsRemotes
    readonly commands: RemoteCommandsSource
    readonly permissionPresets: RemotePermissionPresetRemotes
    readonly agentPresets: RemotePresetRemotes
    readonly llm: RemoteLlmRemotes & RemoteLlmDirectoryRemotes
    readonly $on: RemoteConfigEventsSource['$on']
  }
  readonly connection: { readonly generation: RemoteConnectionGenerationSource }
}

/** The small local readiness vocabulary (§2.3). */
export type RemoteConfigReadiness = 'ready' | 'stale' | 'unavailable'

/* ------------------------------------------------------------------------- *
 * Adapter-owned Host schema knowledge (never crosses the port).
 * ------------------------------------------------------------------------- */

const TUI_SETTINGS_NS = 'tui-app'
const PROVIDER_SETTINGS_NS = 'llm-pi-ai'
const PERMISSION_SETTINGS_NS = 'permission'
const PRESET_REGISTRY_NS = 'agent-preset-registry'
const SUBAGENT_SETTINGS_NS = 'subagent-model-selection-settings'

/** The provider route grammar the adapter-owned profile-slot rule enforces
 *  (same rule the Direct adapter applies). */
const PROVIDER_ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** THE ONE adapter-owned rule for where a route's profile slot may live: the
 *  conventional `llm-pi-ai` → `providers.<route>` slot, for a VALID route
 *  that is not the deepseek official builtin. Shared by the option DTO's
 *  `canProvisionProfile` flag and by both write paths, so the flag can never
 *  advertise a slot a write would refuse (and a hostile/malformed directory
 *  entry can never redirect a write). */
function canProvisionKeylessProfile(ns: string, path: readonly string[], route: string): boolean {
  return route !== 'deepseek-official'
    && PROVIDER_ROUTE_PATTERN.test(route)
    && ns === PROVIDER_SETTINGS_NS
    && path.length === 2 && path[0] === 'providers' && path[1] === route
}

/** Map one adapter-internal merged provider option onto the port's CLIENT
 *  DTO: the Host schema facts collapse into `canProvisionProfile`. */
function remoteCredentialOptionOf(option: ProviderOption): CredentialProviderOption {
  return {
    route: option.route,
    label: option.label,
    ref: option.ref,
    configured: option.configured,
    declared: option.declared,
    namesCredential: option.namesCredential,
    group: option.group,
    canProvisionProfile: canProvisionKeylessProfile(option.settingsNs, option.settingsPath, option.route),
  }
}

/** Whether a value is a plain JSON-shaped record (never an array/class). */
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Structural JSON copy of one wire value (a hostile/non-JSON value degrades
 *  to `undefined` rather than escaping as a live Host object). */
function detachedValue(value: unknown): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/** Read the `llm-pi-ai` section's `providers` dict detached (the settings-only
 *  fallback the Direct adapter applies when the directory is unavailable). */
function piAiProvidersOf(section: unknown): Record<string, { apiKeyEnv?: string } | undefined> | undefined {
  const record = plainRecord(section)
  if (record === undefined) return undefined
  const providers = plainRecord(record.providers)
  if (providers === undefined) return undefined
  const out: Record<string, { apiKeyEnv?: string } | undefined> = {}
  for (const [route, profile] of Object.entries(providers)) {
    const entry = plainRecord(profile)
    out[route] = entry === undefined
      ? (profile as { apiKeyEnv?: string } | undefined)
      : { ...typeof entry.apiKeyEnv === 'string' ? { apiKeyEnv: entry.apiKeyEnv } : {} }
  }
  return out
}

/**
 * The forwarded-event seat MUST stay method-bound to its service: the Client
 * `$on` reads its own service state (`this.events`), so a detached reference
 * (`const on = source.remote.$on`) throws
 * `Cannot read properties of undefined (reading 'subscribe')` on the first
 * subscription. `RemoteConfigPort` therefore binds it ONCE and hands the
 * bound seat to both the mirror and the credential listeners; the cast only
 * restores the overload set the structural declaration carries (the same
 * discipline the M3-3A assembly applies to its shared event seat).
 */

/* ------------------------------------------------------------------------- *
 * The serialized, generation-aware mirror.
 * ------------------------------------------------------------------------- */

/** One committed mirror snapshot: every synchronously-readable wire fact.
 *  `tag` values identify the read that produced the snapshot so a stale
 *  result can never be served as current. */
interface RemoteConfigSnapshot {
  readonly generation: RemoteConnectionGeneration
  readonly invalidation: number
  readonly namespaces: ReadonlyMap<string, RemoteSettingsNamespaceView>
  readonly providers: readonly ProviderCatalogEntry[] | undefined
  readonly permissionPresetNames: readonly string[]
  readonly permissionDefaultPreset: string | undefined
  readonly presetRosterDefault: string | undefined
}

/** Bounded re-describe attempts when an invalidation races a read. 5 is
 *  enough for a document/adapter/catalog event burst; a persistent storm
 *  fails loudly (SupersededReadError) instead of committing a stale result. */
const MAX_DESCRIBE_ATTEMPTS = 5

/** Await one official RemoteResult, folding a carrier throw into the failure
 *  branch (the generated Remote resolves; only an assembly defect throws). */
async function settledResult<T>(promise: Promise<RemoteResultLike<T>>): Promise<RemoteResultLike<T>> {
  return promise.catch((error: unknown): RemoteResultLike<T> => ({ ok: false, error }))
}

/** Copy one directory entry into an owned plain record. */
function copyProviderEntry(entry: ProviderCatalogEntry): ProviderCatalogEntry {
  return {
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    ...entry.declared === undefined ? {} : { declared: entry.declared },
  }
}

/**
 * The single Client-local config mirror. It owns:
 * - the invalidation subscriptions (settings document, llm adapters,
 *   permission catalog, Connection generation);
 * - the serialized `describe()` refresh with its generation/invalidation
 *   fence;
 * - the serialized write queue whose tasks refresh from authority after the
 *   official settlement.
 *
 * Invalidations only bump the counter (the snapshot stays readable as the
 * last-known display value); no unowned background promise is started.
 */
class RemoteConfigMirror {
  private readonly settings: RemoteSettingsRemotes
  private readonly llm: RemoteLlmRemotes & RemoteLlmDirectoryRemotes
  private readonly permissionPresets: RemotePermissionPresetRemotes
  private readonly agentPresets: RemotePresetRemotes
  private readonly generation: RemoteConnectionGenerationSource
  /** Every invalidation subscription, owned and released exactly once. */
  private readonly subscriptions: Array<() => void> = []
  private snapshot: RemoteConfigSnapshot | undefined
  /** Incremented by every invalidation; a read that raced one is discarded. */
  private invalidation = 0
  /** The in-flight describe promise (coalesces concurrent refreshes). */
  private refresh: Promise<void> | undefined
  /** The last invalidation-triggered rerun failure (diagnostic; a failure
   *  leaves the snapshot stale until a later describe commits). */
  private refreshFailure: unknown
  /** The serialized write chain (never an optimistic local patch). */
  private writes: Promise<void> = Promise.resolve()
  private disposed = false
  /** False while the constructor is still installing subscriptions, so a
   *  synchronously-notified generation subscription cannot start a read
   *  before construction finishes. */
  private constructed = false

  constructor(source: RemoteConfigRuntimeSource) {
    this.settings = source.remote.settings
    this.llm = source.remote.llm
    this.permissionPresets = source.remote.permissionPresets
    this.agentPresets = source.remote.agentPresets
    this.generation = source.connection.generation
    // FROZEN ORDERING (§2.3): install every invalidation listener BEFORE the
    // first describe(), so an invalidation that lands between construction
    // and the first describe is observed by the fence instead of being
    // silently missed.
    const on = source.remote.$on
    this.subscriptions.push(on('settings/document-updated', () => { this.invalidate() }))
    this.subscriptions.push(on('llm/adapters-updated', () => { this.invalidate() }))
    this.subscriptions.push(on('permission-presets/catalog-changed', () => { this.invalidate() }))
    this.subscriptions.push(this.generation.subscribe(() => { this.invalidate() }))
    this.constructed = true
  }

  /** Mark the committed snapshot non-current and rerun the read (§2.3). A
   *  read must not treat the snapshot as authoritative until a fresh
   *  describe commits. */
  private invalidate(): void {
    this.invalidation += 1
    this.scheduleRefresh()
  }

  /**
   * The invalidation-triggered rerun. The promise is coalesced with any
   * explicit `describe()` (one in-flight read serves both), and its failure
   * is RECORDED (never swallowed) instead of becoming an unhandled
   * rejection: the invalidation fact is already stored in the counter, so a
   * failed rerun leaves `readiness()` stale and `lastRefreshFailure()` set.
   */
  private scheduleRefresh(): void {
    if (!this.constructed || this.disposed) return
    // Both settlement sides are handled here (success clears the recorded
    // failure, rejection RECORDS it), so this detach can never become an
    // unhandled rejection — the allowlist marker is the rule's explicit
    // escape hatch for exactly this recorded-owner shape.
    void this.describe().then( // allowlist: rejection recorded in refreshFailure
      () => { this.refreshFailure = undefined },
      (error: unknown) => { this.refreshFailure = error },
    )
  }

  /** The last refresh failure (invalidation rerun OR explicit read), or undefined. */
  lastRefreshFailure(): unknown {
    return this.refreshFailure
  }

  /** Record one failed refresh so `lastRefreshFailure()` stays truthful even
   *  when nobody awaited the read (the assembly's initial-read barrier). */
  recordFailure(error: unknown): void {
    this.refreshFailure = error
  }

  /** Clear a recorded failure after a successful read. */
  recordSuccess(): void {
    this.refreshFailure = undefined
  }

  /** Whether the backend can be read at all (a Connection generation exists). */
  usable(): boolean {
    return this.generation.getSnapshot() !== undefined
  }

  /** The truthfulness of the current snapshot. */
  readiness(): RemoteConfigReadiness {
    const generation = this.generation.getSnapshot()
    // A disconnected Connection has no authority to mirror: never "ready".
    if (generation === undefined) return 'unavailable'
    const snapshot = this.snapshot
    // No COMMITTED read means there are no authoritative values at all — not
    // even last-known ones. Reporting `stale` here would let a consumer
    // present its own built-in defaults as "last known Host values" (§9.1);
    // for the config consumer the truthful state is "nothing to show".
    if (snapshot === undefined) return 'unavailable'
    // A generation change or an invalidation both make the last commit
    // non-current; the last-known value stays readable but not authoritative.
    if (!Object.is(snapshot.generation, generation)) return 'stale'
    if (snapshot.invalidation !== this.invalidation) return 'stale'
    return 'ready'
  }

  /** The last committed snapshot, even when stale (the §2.3 display value). */
  private lastKnown(): RemoteConfigSnapshot | undefined {
    return this.snapshot
  }

  /** One namespace's descriptor from the last-known snapshot. */
  namespace(ns: string): RemoteSettingsNamespaceView | undefined {
    return this.snapshot?.namespaces.get(ns)
  }

  providers(): readonly ProviderCatalogEntry[] | undefined {
    return this.snapshot?.providers
  }

  permissionPresetNames(): readonly string[] {
    return this.snapshot?.permissionPresetNames ?? []
  }

  permissionDefaultPreset(): string | undefined {
    return this.snapshot?.permissionDefaultPreset
  }

  presetRosterDefault(): string | undefined {
    return this.snapshot?.presetRosterDefault
  }

  /** Whether the last-known snapshot still belongs to the live state. */
  private isCurrent(): boolean {
    return this.readiness() === 'ready'
  }

  /** Refresh when the snapshot is not current (a write's pre-flight fence). */
  async ensureCurrent(): Promise<void> {
    if (!this.isCurrent()) await this.describe()
  }

  /** Serialize one write against every other write on this mirror. */
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writes.then(task, task)
    this.writes = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Commit one fresh snapshot, or leave the last-known value untouched.
   *
   * The fence is deliberately double: the Connection generation captured
   * before the read must still be current (a reconnect must never publish
   * the previous Host's document), AND the invalidation counter must not
   * have moved (a document/adapter/catalog change during the read means the
   * result describes a superseded state). Either failure discards the
   * result and re-reads, bounded.
   */
  describe(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    // One in-flight refresh serves every concurrent caller (a write's
    // post-settlement refresh coalesces with an app-triggered one).
    if (this.refresh !== undefined) return this.refresh
    // Publish the in-flight placeholder BEFORE invoking runDescribe(): its
    // synchronous prologue dispatches the official reads, and an
    // invalidation landing there (the raced-document case) calls describe()
    // re-entrantly. Without the placeholder that nested call would start a
    // SECOND read instead of joining this one.
    const refresh = Promise.withResolvers<void>()
    this.refresh = refresh.promise
    this.runDescribe().then(
      () => {
        this.refresh = undefined
        refresh.resolve()
      },
      (error: unknown) => {
        this.refresh = undefined
        refresh.reject(error)
      },
    )
    return refresh.promise
  }

  private async runDescribe(): Promise<void> {
    for (let attempt = 0; attempt < MAX_DESCRIBE_ATTEMPTS; attempt += 1) {
      if (this.disposed) return
      const generation = this.generation.getSnapshot()
      // Disconnected: there is no authority to mirror. Never commit.
      if (generation === undefined) return
      const invalidation = this.invalidation
      // The mandatory read plus the auxiliary directory/catalog/roster reads
      // happen inside one fence; aux failures degrade to undefined (the
      // Direct adapter's fail-soft fallbacks), the settings read does not.
      const [settingsResult, providersResult, catalogResult, presetsResult] = await Promise.all([
        settledResult(this.settings.describe()),
        settledResult(this.llm.listConfigurableProviders()),
        settledResult(this.permissionPresets.catalog()),
        settledResult(this.agentPresets.list()),
      ])
      // Latest-only fence: a newer generation or any invalidation makes this
      // read's result non-authoritative; it must never commit — re-read.
      if (this.disposed) return
      if (!Object.is(generation, this.generation.getSnapshot()) || invalidation !== this.invalidation) continue
      if (!settingsResult.ok) {
        throw new Error(`settings.describe failed: ${remoteFailureMessage(settingsResult.error)}`)
      }
      if (!Array.isArray(settingsResult.value.namespaces)) {
        throw new Error('settings.describe returned an unusable namespace list')
      }
      const namespaces = new Map<string, RemoteSettingsNamespaceView>()
      for (const view of settingsResult.value.namespaces) {
        if (typeof view?.ns !== 'string') continue
        namespaces.set(view.ns, {
          ns: view.ns,
          ...view.value === undefined ? {} : { value: detachedValue(view.value) },
          ...view.user === undefined ? {} : { user: detachedValue(view.user) },
          ...view.revision === undefined ? {} : { revision: view.revision },
        })
      }
      this.snapshot = {
        generation,
        invalidation,
        namespaces,
        providers: providersResult.ok && Array.isArray(providersResult.value)
          ? providersResult.value.map(copyProviderEntry)
          : undefined,
        permissionPresetNames: catalogResult.ok && Array.isArray(catalogResult.value?.options)
          ? catalogResult.value.options.flatMap(option => typeof option?.value === 'string' ? [option.value] : [])
          : [],
        permissionDefaultPreset: catalogResult.ok && typeof catalogResult.value?.defaultPreset === 'string'
          ? catalogResult.value.defaultPreset
          : undefined,
        presetRosterDefault: presetsResult.ok && Array.isArray(presetsResult.value?.presets)
          ? presetsResult.value.presets.find(preset => preset.isDefault === true)?.id
          : undefined,
      }
      return
    }
    throw new SupersededReadError('the settings mirror describe was repeatedly superseded by invalidation')
  }

  /**
   * Serialized namespace write.
   *
   * A write first guarantees a CURRENT mirror (so the revision fence it
   * carries was read from the live document), dispatches the official
   * `settings.mutate` with that revision, and only then refreshes from
   * authority. The mutate's returned view is deliberately NOT trusted as the
   * mirror's new state: the refreshed `describe` snapshot is the only new
   * authority, which is what makes "never an optimistic local write" true.
   */
  async mutate(ns: string, ops: readonly RemoteSettingsPathOp[]): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureCurrent()
      const snapshot = this.lastKnown()
      if (snapshot === undefined || !this.isCurrent()) {
        // §9.1: a write against a backend that cannot vouch for its values
        // fails IMMEDIATELY with an explicit reason — never a silent no-op and
        // never an optimistic local success (the pre-flight refresh above
        // already had its chance).
        throw new Error(this.generation.getSnapshot() === undefined
          ? 'the Remote configuration is unavailable on this connection; the change was not saved'
          : snapshot === undefined
            ? 'the Remote configuration has not been read yet; the change was not saved'
            : 'the Remote configuration is not current; the change was not saved')
      }
      // A genuinely empty diff is a no-op ONLY once the mirror is current:
      // returning earlier would let a stale mirror report success for a
      // document it computed from superseded values (§8.1/§9.1).
      if (ops.length === 0) return
      const descriptor = snapshot.namespaces.get(ns)
      if (descriptor === undefined) {
        throw new Error(`settings namespace "${ns}" is not available in this deployment`)
      }
      const result = await settledResult(this.settings.mutate(ns, [...ops], descriptor.revision))
      if (!result.ok) throw new Error(`settings.mutate(${ns}) failed: ${remoteFailureMessage(result.error)}`)
      // Authoritative refresh AFTER the official settlement.
      await this.describe()
    })
  }

  /** Drop the cached snapshot (and any in-flight read's publication right). */
  disposeCache(): void {
    this.snapshot = undefined
    this.invalidation += 1
  }

  /** Release every subscription and the cache exactly once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.subscriptions) unsubscribe()
    this.subscriptions.length = 0
    this.disposeCache()
  }
}

/* ------------------------------------------------------------------------- *
 * `tuiSettings` (the `tui-app` namespace).
 * ------------------------------------------------------------------------- */

/** The tui-app Config defaults (src/tui-config.ts): the SAME fallbacks the
 *  Direct adapter's live Cordis Config supplies for an absent field. Raw
 *  pass-through fields (footerLayout/footerCustomItems/footerCommand/
 *  keybindings) have no default and stay verbatim. */
const TUI_SETTINGS_DEFAULTS: {
  readonly theme: string
  readonly iconStyle: string
  readonly footer: string
  readonly footerFallbackMode: string
  readonly fullscreen: string
  readonly busyEnter: string
  readonly localShellSandbox: string
  readonly homeEndKeys: string
  readonly displayPreset: string
  readonly progressUpdates: string
  readonly gitAttribution: string
  readonly responseStyle: string
  readonly notificationMode: string
  readonly notificationMethod: string
  readonly wheelScrollLines: string
} = {
  theme: 'auto',
  iconStyle: 'emoji',
  footer: 'full',
  footerFallbackMode: 'default',
  fullscreen: 'on',
  busyEnter: 'queue',
  localShellSandbox: 'bypass',
  homeEndKeys: 'input',
  displayPreset: 'full',
  progressUpdates: 'milestones',
  gitAttribution: 'off',
  responseStyle: 'default',
  notificationMode: 'unfocused',
  notificationMethod: 'auto',
  wheelScrollLines: '1',
}

/** Every top-level field the replace diff considers — byte-identical to the
 *  Direct adapter's list (the Config's declared preference keys). Unknown
 *  keys in a replacement document are ignored: the schema is the authority. */
const DIFF_FIELDS: readonly string[] = [
  'theme',
  'iconStyle',
  'footer',
  'footerFallbackMode',
  'footerLayout',
  'footerCustomItems',
  'footerCommand',
  'fullscreen',
  'busyEnter',
  'localShellSandbox',
  'homeEndKeys',
  'displayPreset',
  'progressUpdates',
  'gitAttribution',
  'responseStyle',
  'notificationMode',
  'notificationMethod',
  'wheelScrollLines',
  'keybindings',
]

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Project the effective section into the semantic document (all required
 *  fields present; absent/unknown scalars fall back to the Config defaults;
 *  the raw fields ride verbatim). */
function tuiSettingsDocOf(section: unknown): TuiSettingsDoc {
  const record = plainRecord(section) ?? {}
  return {
    theme: stringOr(record.theme, TUI_SETTINGS_DEFAULTS.theme),
    iconStyle: stringOr(record.iconStyle, TUI_SETTINGS_DEFAULTS.iconStyle),
    footer: stringOr(record.footer, TUI_SETTINGS_DEFAULTS.footer),
    footerFallbackMode: stringOr(record.footerFallbackMode, TUI_SETTINGS_DEFAULTS.footerFallbackMode),
    footerLayout: record.footerLayout,
    footerCustomItems: record.footerCustomItems,
    footerCommand: record.footerCommand as TuiSettingsDoc['footerCommand'],
    fullscreen: stringOr(record.fullscreen, TUI_SETTINGS_DEFAULTS.fullscreen),
    busyEnter: stringOr(record.busyEnter, TUI_SETTINGS_DEFAULTS.busyEnter),
    localShellSandbox: stringOr(record.localShellSandbox, TUI_SETTINGS_DEFAULTS.localShellSandbox),
    homeEndKeys: stringOr(record.homeEndKeys, TUI_SETTINGS_DEFAULTS.homeEndKeys),
    progressUpdates: stringOr(record.progressUpdates, TUI_SETTINGS_DEFAULTS.progressUpdates),
    gitAttribution: stringOr(record.gitAttribution, TUI_SETTINGS_DEFAULTS.gitAttribution),
    responseStyle: stringOr(record.responseStyle, TUI_SETTINGS_DEFAULTS.responseStyle),
    displayPreset: stringOr(record.displayPreset, TUI_SETTINGS_DEFAULTS.displayPreset),
    notificationMode: stringOr(record.notificationMode, TUI_SETTINGS_DEFAULTS.notificationMode),
    notificationMethod: stringOr(record.notificationMethod, TUI_SETTINGS_DEFAULTS.notificationMethod),
    wheelScrollLines: stringOr(record.wheelScrollLines, TUI_SETTINGS_DEFAULTS.wheelScrollLines),
    keybindings: record.keybindings,
  }
}

/** Whether two whole-value field snapshots are observationally equal. */
function fieldEquals(left: unknown, right: unknown): boolean {
  return left === right || stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        return Object.fromEntries(Object.keys(entry).sort().map(key => [key, (entry as Record<string, unknown>)[key]]))
      }
      return entry
    }) ?? 'undefined'
  } catch {
    // A non-JSON value (hostile or cyclic) compares by identity only.
    return '\u0000unserializable'
  }
}

/** The Direct adapter's write reconciliation, replayed over the wire
 *  descriptor (effective `value` + raw `user` + revision fence): only a
 *  field that actually changes the effective snapshot is written, and a
 *  dropped field is an UNSET only while the USER layer owns it. */
function diffTuiSettings(current: unknown, user: unknown, next: TuiSettingsDoc): RemoteSettingsPathOp[] {
  const currentSection = plainRecord(current) ?? {}
  const nextSection = next as unknown as Record<string, unknown>
  const userSection = plainRecord(user)
  const ops: RemoteSettingsPathOp[] = []
  for (const field of DIFF_FIELDS) {
    const requested = nextSection[field]
    const effective = currentSection[field]
    const owned = userSection?.[field]
    if (requested !== undefined) {
      if (owned !== undefined) {
        if (fieldEquals(requested, owned)) {
          // The USER override already stores exactly this value: no op.
        } else if (!fieldEquals(requested, effective)) {
          ops.push({ op: 'set', path: [field], value: requested })
        } else if (effective === null || typeof effective !== 'object') {
          // requested === effective !== owned on a SCALAR: the caller wrote
          // the inherited value over its own override — a reset-to-inherited,
          // expressed as an UNSET so the override stops shadowing.
          ops.push({ op: 'unset', path: [field] })
        }
        // requested === effective !== owned on an OBJECT is the merged-view
        // restate (upstream merges nested objects recursively): a NO-OP, so a
        // merged superset is never pinned and a partial override is never
        // destroyed.
      } else if (!fieldEquals(requested, effective)) {
        // No USER override: only a value that changes the effective snapshot
        // is written — inherited values are never promoted into the profile.
        ops.push({ op: 'set', path: [field], value: requested })
      }
    } else if (effective !== undefined && owned !== undefined) {
      ops.push({ op: 'unset', path: [field] })
    }
  }
  return ops
}

class RemoteTuiSettingsConfig implements TuiSettingsConfig {
  /** Stable queue identity shared by every wrapper around this mirror, so
   *  two adapters can never lose a get→modify→replace update (§2.3). */
  readonly mutationQueueKey: object
  private readonly mirror: RemoteConfigMirror

  constructor(mirror: RemoteConfigMirror) {
    this.mirror = mirror
    this.mutationQueueKey = mirror
  }

  get(): TuiSettingsDoc {
    return tuiSettingsDocOf(this.mirror.namespace(TUI_SETTINGS_NS)?.value)
  }

  async replace(doc: TuiSettingsDoc): Promise<void> {
    const descriptor = this.mirror.namespace(TUI_SETTINGS_NS)
    if (descriptor === undefined) {
      throw new Error('settings entry "tui-app" is unavailable on this connection')
    }
    if (descriptor.value === undefined) {
      // An entry with volatile fields always projects a populated object; an
      // absent projection is unrepresentable — fail loud rather than diffing
      // every defaulted field against undefined and pinning the whole
      // document into the USER layer.
      throw new Error('settings entry "tui-app" exposes no form projection')
    }
    const ops = diffTuiSettings(descriptor.value, descriptor.user, doc)
    await this.mirror.mutate(TUI_SETTINGS_NS, ops)
  }
}

/* ------------------------------------------------------------------------- *
 * USER-layer footer trust + custom items.
 * ------------------------------------------------------------------------- */

/** The Direct M5 trust read, replayed from the mirrored descriptor's USER
 *  layer. A project layer can never grant trust: only `descriptor.user` is
 *  consulted, never the merged `value`. */
class RemoteFooterCommandTrust implements FooterCommandTrust {
  private readonly mirror: RemoteConfigMirror

  constructor(mirror: RemoteConfigMirror) {
    this.mirror = mirror
  }

  private descriptor(): readonly { readonly ns: string; readonly user?: unknown }[] | undefined {
    const view = this.mirror.namespace(TUI_SETTINGS_NS)
    return view === undefined ? undefined : [view]
  }

  get userFooterMode(): string | undefined {
    return resolveUserLayerFooterMode(this.descriptor(), TUI_SETTINGS_NS)
  }

  get command(): ReturnType<typeof resolveTrustedFooterCommand> {
    return resolveTrustedFooterCommand(this.descriptor(), TUI_SETTINGS_NS)
  }

  get userCommandItemActivationIds(): ReadonlySet<string> {
    return resolveUserCommandItemActivationIds(this.descriptor(), TUI_SETTINGS_NS)
  }

  get userCommandItemFallbackActivationIds(): ReadonlySet<string> {
    return resolveUserCommandItemFallbackActivationIds(this.descriptor(), TUI_SETTINGS_NS)
  }
}

class RemoteFooterCustomItems implements FooterCustomItemsConfig {
  private readonly mirror: RemoteConfigMirror

  constructor(mirror: RemoteConfigMirror) {
    this.mirror = mirror
  }

  /** Read the USER-layer `footerCustomItems` slot; `failed` marks a
   *  descriptor/user section that cannot be read safely. */
  private readUserRaw(): { readonly value: unknown; readonly failed: boolean } {
    const descriptor = this.mirror.namespace(TUI_SETTINGS_NS)
    if (descriptor === undefined) return { value: undefined, failed: true }
    const user = descriptor.user
    if (user === undefined) return { value: undefined, failed: false }
    const section = plainRecord(user)
    if (section === undefined) return { value: undefined, failed: true }
    return { value: section.footerCustomItems, failed: false }
  }

  get(): FooterCustomItemsParseResult {
    const raw = this.readUserRaw()
    if (raw.failed) return { items: [], invalidCount: 1 }
    return parseFooterCustomItems(raw.value)
  }

  rawForPersistence(): FooterCustomItemsRaw {
    const raw = this.readUserRaw()
    if (raw.failed) return { kind: 'unavailable' }
    try {
      return { kind: 'available', value: structuredClone(raw.value) }
    } catch {
      return { kind: 'unavailable' }
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Providers.
 * ------------------------------------------------------------------------- */

class RemoteProviderProfileConfig implements ProviderProfileConfig {
  private readonly mirror: RemoteConfigMirror

  constructor(mirror: RemoteConfigMirror) {
    this.mirror = mirror
  }

  available(): boolean {
    return this.mirror.usable()
  }

  /** The merged /login options: the mirrored configurable-provider directory
   *  over its per-entry sections when present, the settings-only fallback
   *  otherwise (the same merge the Direct adapter wires). */
  listCredentialOptions(): readonly CredentialProviderOption[] {
    const directory = this.mirror.providers()
    if (directory !== undefined) {
      return providerOptionsFor(directory, ns => this.mirror.namespace(ns)?.value)
        .map(option => remoteCredentialOptionOf(option))
    }
    const settingsOnly = credentialOptionsFor(piAiProvidersOf(this.mirror.namespace(PROVIDER_SETTINGS_NS)?.value))
    return settingsOnly.map((option, index) => {
      const route = index === 0 ? 'deepseek-official' : option.label
      return {
        ...option,
        route,
        configured: true,
        declared: false,
        namesCredential: true,
        group: 'configured' as const,
        // The SAME adapter-owned rule the write paths apply: a hostile
        // providers key (or the builtin) is never advertised as writable.
        canProvisionProfile: canProvisionKeylessProfile(PROVIDER_SETTINGS_NS, ['providers', route], route),
      }
    })
  }

  async writeProfile(route: string, profile: Record<string, unknown>): Promise<void> {
    // The ONE profile-slot rule gates the write: the conventional
    // llm-pi-ai `providers.<route>` slot, for a valid non-builtin route.
    if (!canProvisionKeylessProfile(PROVIDER_SETTINGS_NS, ['providers', route], route)) {
      throw new Error('invalid provider route')
    }
    await this.mirror.mutate(PROVIDER_SETTINGS_NS, [
      { op: 'set', path: ['providers', route], value: profile },
    ])
  }

  async writeKeylessProfile(route: string): Promise<{ kind: 'written' } | { kind: 'skipped'; reason: string }> {
    if (route === 'deepseek-official') {
      // The builtin has no provider-profile slot; refuse EXPLICITLY before
      // any path resolution (the same reason string as Direct).
      return { kind: 'skipped', reason: 'the deepseek official builtin has no provider-profile slot' }
    }
    if (!PROVIDER_ROUTE_PATTERN.test(route)) throw new Error('invalid provider route')
    // Refresh first so the route's location is resolved from the CURRENT
    // directory, never a stale one.
    await this.mirror.ensureCurrent()
    const directory = this.mirror.providers()
    if (directory === undefined) {
      // The directory is not mirrored (its read degraded): the conventional
      // llm-pi-ai slot applies, exactly like Direct's settings-only fallback.
      await this.mirror.mutate(PROVIDER_SETTINGS_NS, [
        { op: 'set', path: ['providers', route], value: {} },
      ])
      return { kind: 'written' }
    }
    const entry = directory.find(candidate => candidate.provider === route)
    if (entry === undefined) {
      // A directory race between the catalog read and the authorization
      // completion must never fall back to a guessed slot — report the skip.
      return { kind: 'skipped', reason: `no configurable-provider entry for ${route}` }
    }
    const path = [...entry.settingsPath]
    // The directory metadata is validated against the SAME adapter-owned rule
    // the option flag uses: a hostile/malformed entry can never redirect the
    // write to an arbitrary namespace or path.
    if (!canProvisionKeylessProfile(entry.settingsNs, path, route)) {
      return { kind: 'skipped', reason: `hostile or malformed directory entry for ${route}` }
    }
    await this.mirror.mutate(entry.settingsNs, [
      { op: 'set', path, value: {} },
    ])
    return { kind: 'written' }
  }
}

/* ------------------------------------------------------------------------- *
 * Credentials (references only).
 * ------------------------------------------------------------------------- */

class RemoteCredentialConfig implements CredentialConfig {
  private readonly credentials: RemoteCredentialsRemotes
  private readonly generation: RemoteConnectionGenerationSource
  private readonly on: RemoteConfigEventsSource['$on']
  /** Every active listener subscription, so dispose() releases them once. */
  private readonly active = new Set<() => void>()

  constructor(
    credentials: RemoteCredentialsRemotes,
    on: RemoteConfigEventsSource['$on'],
    generation: RemoteConnectionGenerationSource,
  ) {
    this.credentials = credentials
    this.on = on
    this.generation = generation
  }

  available(): boolean {
    return this.generation.getSnapshot() !== undefined
  }

  /**
   * The generation fence every credential operation shares: a Remote async
   * result must re-check the Connection generation before it can mutate
   * visible state (AGENTS.md). A credential call that completed against a
   * replaced Host is reported as superseded instead of as a success on the
   * NEW Host — the write may have landed on the old one, and the UI must not
   * claim otherwise.
   */
  private fence(captured: RemoteConnectionGeneration | undefined): void {
    if (captured === undefined || !Object.is(captured, this.generation.getSnapshot())) {
      throw new SupersededReadError('the credential result belongs to a replaced Connection generation')
    }
  }

  async setReference(ref: string, secret: string): Promise<void> {
    const captured = this.generation.getSnapshot()
    const result = await settledResult(this.credentials.set(ref, secret))
    if (!result.ok) throw new Error(`credentials.set(${ref}) failed: ${remoteFailureMessage(result.error)}`)
    this.fence(captured)
  }

  async unsetReference(ref: string): Promise<void> {
    const captured = this.generation.getSnapshot()
    const result = await settledResult(this.credentials.unset(ref))
    if (!result.ok) throw new Error(`credentials.unset(${ref}) failed: ${remoteFailureMessage(result.error)}`)
    this.fence(captured)
  }

  async describeReference(ref: string): Promise<{ configured: boolean; source?: string }> {
    const captured = this.generation.getSnapshot()
    const result = await settledResult(this.credentials.describe([ref]))
    if (!result.ok) throw new Error(`credentials.describe(${ref}) failed: ${remoteFailureMessage(result.error)}`)
    // A read from a replaced Host must not be presented as the current
    // configuration (the /logout picker degrades a throwing describe to
    // "not configured" — fail closed, never a stale row).
    this.fence(captured)
    const info = result.value?.[ref]
    if (info === undefined) return { configured: false }
    return {
      configured: info.configured === true,
      ...typeof info.source === 'string' ? { source: info.source } : {},
    }
  }

  /**
   * Unsupported on the wire (docs/m3-entry-contract.md §2.3/§10): rc.2
   * publishes no credentials record read Remote and no record delete Remote
   * (`credentials/describe|set|unset` address REFERENCE names only, and the
   * two key grammars are disjoint). The port's `CredentialConfig` shape has
   * no availability marker for the record subset, so the correction is
   * deferred to a port-level change (out of this task's two-file scope);
   * this adapter instead REJECTS with a truthful message rather than faking
   * an empty list or a silent successful delete.
   */
  listRecords(): Promise<readonly { key: string; kind?: string }[]> {
    return Promise.reject(new Error(
      'the Remote credentials backend cannot enumerate stored credential records: rc.2 publishes no credentials record read Remote (docs/m3-entry-contract.md §10)',
    ))
  }

  /** @see listRecords — no record delete Remote exists on rc.2. */
  deleteRecord(key: string): Promise<void> {
    return Promise.reject(new Error(
      `the Remote credentials backend cannot delete stored credential record "${key}": rc.2 publishes no credential record delete Remote (docs/m3-entry-contract.md §10)`,
    ))
  }

  onChanged(listener: () => void): () => void {
    let disposed = false
    const offReference = this.on('credentials/reference-updated', () => { listener() })
    const offRecord = this.on('credentials/record-updated', () => { listener() })
    const unsubscribe = (): void => {
      // Disposed EXACTLY once: the returned disposer and dispose() may both
      // run (teardown plus a caller's own cleanup) and must not double-off.
      if (disposed) return
      disposed = true
      offReference()
      offRecord()
      this.active.delete(unsubscribe)
    }
    this.active.add(unsubscribe)
    return unsubscribe
  }

  /** Release every active listener subscription exactly once. */
  dispose(): void {
    for (const unsubscribe of [...this.active]) unsubscribe()
  }
}

/* ------------------------------------------------------------------------- *
 * Authorization (unsupported on rc.2).
 * ------------------------------------------------------------------------- */

class RemoteAuthorizationConfig implements AuthorizationConfig {
  available(): boolean {
    // INTENTIONAL_UNSUPPORTED_IN_M3 (docs/m3-entry-contract.md §10): rc.2
    // publishes no authorization namespace/Remote at all. Never a private RPC.
    return false
  }

  listTargets(): readonly AuthorizationFlowTarget[] {
    // No fake targets: there is no catalog to list.
    return []
  }

  begin(): Promise<{ kind: 'unavailable' }> {
    return Promise.resolve({ kind: 'unavailable' })
  }

  onEvent(_listener: (event: AuthorizationFlowEvent) => void): () => void {
    return () => {}
  }

  respond(): Promise<void> {
    return Promise.reject(new Error(
      'authorization is unavailable on this backend: rc.2 publishes no authorization Remote (docs/m3-entry-contract.md §10)',
    ))
  }

  cancel(): Promise<void> {
    return Promise.reject(new Error(
      'authorization is unavailable on this backend: rc.2 publishes no authorization Remote (docs/m3-entry-contract.md §10)',
    ))
  }
}

/* ------------------------------------------------------------------------- *
 * Permissions.
 * ------------------------------------------------------------------------- */

class RemotePermissionConfig implements PermissionConfig {
  private readonly mirror: RemoteConfigMirror
  private readonly commands: RemoteCommandsSource

  constructor(mirror: RemoteConfigMirror, commands: RemoteCommandsSource) {
    this.mirror = mirror
    this.commands = commands
  }

  presetNames(): readonly string[] {
    return this.mirror.permissionPresetNames()
  }

  defaultPreset(): string | undefined {
    // The settings `permission.defaultPreset` section is the user preference;
    // the catalog's `defaultPreset` is the deployment default the preference
    // shadows. Merged = the settings value when present, else the catalog.
    const section = plainRecord(this.mirror.namespace(PERMISSION_SETTINGS_NS)?.value)
    const configured = section?.defaultPreset
    if (typeof configured === 'string' && configured !== '') return configured
    return this.mirror.permissionDefaultPreset()
  }

  async setDefaultPreset(name: string): Promise<void> {
    await this.mirror.mutate(PERMISSION_SETTINGS_NS, [
      { op: 'set', path: ['defaultPreset'], value: name },
    ])
  }

  approvalOverrideOf(_sessionId: string): undefined {
    // INTENTIONAL_UNSUPPORTED_IN_M3 (docs/m3-entry-contract.md §10): rc.2 has
    // no public Client read of the independent session `approval/policy`
    // override. `undefined` means "unavailable", NEVER `ask` — the Remote
    // settings row must be hidden/disabled instead of guessing.
    return undefined
  }

  async applyPermissionPreset(
    sessionId: string,
    presetId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'applied' } | { kind: 'unavailable'; cause: 'commands' | 'permission' }> {
    // The preset id is validated against the composed catalog BEFORE it
    // reaches the official command line: an unknown (or hostile) id can never
    // be interpolated into an arbitrary /permission invocation.
    if (!this.presetNames().includes(presetId)) return { kind: 'unavailable', cause: 'permission' }
    const result = await this.commands.execute(sessionId, `/permission ${presetId}`, [], signal)
    if (!result.ok) return { kind: 'unavailable', cause: 'permission' }
    // `undefined` is the official "no matching command" result: the preset
    // was not switched, so this is not an applied outcome.
    if (result.value === undefined) return { kind: 'unavailable', cause: 'permission' }
    return { kind: 'applied' }
  }
}

/* ------------------------------------------------------------------------- *
 * Preset default + subagent model selection.
 * ------------------------------------------------------------------------- */

class RemotePresetDefaultConfig implements PresetDefaultConfig {
  private readonly mirror: RemoteConfigMirror

  constructor(mirror: RemoteConfigMirror) {
    this.mirror = mirror
  }

  available(): boolean {
    return this.mirror.usable()
  }

  get(): string | undefined {
    // The saved user preference shadows the roster's own default.
    const section = plainRecord(this.mirror.namespace(PRESET_REGISTRY_NS)?.value)
    const selected = section?.selectedDefault
    if (typeof selected === 'string' && selected !== '') return selected
    return this.mirror.presetRosterDefault()
  }

  async set(id: string): Promise<void> {
    await this.mirror.mutate(PRESET_REGISTRY_NS, [
      { op: 'set', path: ['selectedDefault'], value: id },
    ])
  }
}

class RemoteSubagentModelSelectionConfig implements SubagentModelSelectionConfig {
  private readonly mirror: RemoteConfigMirror

  constructor(mirror: RemoteConfigMirror) {
    this.mirror = mirror
  }

  available(): boolean {
    // BOTH the official settings section and a readable settings backend.
    return this.mirror.usable() && this.mirror.namespace(SUBAGENT_SETTINGS_NS) !== undefined
  }

  get(): { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] } {
    const section = plainRecord(this.mirror.namespace(SUBAGENT_SETTINGS_NS)?.value)
    if (section === undefined) return { enabled: false, allowedModels: [] }
    const allowedModels = (Array.isArray(section.allowedModels) ? section.allowedModels : []).flatMap(route => {
      const candidate = route as { readonly provider?: unknown; readonly model?: unknown }
      return typeof candidate?.provider === 'string' && typeof candidate?.model === 'string'
        ? [{ provider: candidate.provider, model: candidate.model }]
        : []
    })
    return { enabled: section.enabled === true, allowedModels }
  }

  async set(value: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }): Promise<void> {
    // Client-side pre-validation with the official rules (the Host validates
    // again on the section boundary): fail fast before any write.
    assertOfficialSubagentRoutes(value.allowedModels)
    if (value.enabled && value.allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    // The mirror never patches optimistically, so a failed write leaves the
    // authoritative snapshot untouched and the next get() reads authority.
    await this.mirror.mutate(SUBAGENT_SETTINGS_NS, [
      { op: 'set', path: ['enabled'], value: value.enabled },
      { op: 'set', path: ['allowedModels'], value: value.allowedModels.map(route => ({ ...route })) },
    ])
  }
}

/** The official route-list rules (mirrored client-side so a malformed edit
 *  fails before the Host write; same messages as the Host validator). */
function assertOfficialSubagentRoutes(routes: readonly SubagentAllowedModelRoute[]): void {
  const seen = new Set<string>()
  for (const route of routes) {
    if (route.provider.length === 0 || route.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const key = `${route.provider}\u0000${route.model}`
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
  }
}

/* ------------------------------------------------------------------------- *
 * The port.
 * ------------------------------------------------------------------------- */

/**
 * The Remote config port over ONE Client runtime source. The mirror is
 * created first (its invalidation listeners are installed in its
 * constructor, before the first describe), then every sub-domain projects
 * the mirror's last-known snapshot.
 */
export class RemoteConfigPort implements ConfigPort {
  private readonly mirror: RemoteConfigMirror
  private readonly tuiSettingsWrapper: RemoteTuiSettingsConfig
  private readonly credentialConfig: RemoteCredentialConfig

  readonly footerCommandTrust: FooterCommandTrust
  readonly footerCustomItems: FooterCustomItemsConfig
  readonly providers: ProviderProfileConfig
  readonly credentials: CredentialConfig
  readonly authorization: AuthorizationConfig
  readonly permissions: PermissionConfig
  readonly presetDefault: PresetDefaultConfig
  readonly subagentModelSelection: SubagentModelSelectionConfig

  /** `undefined` while the `tui-app` namespace is absent from the mirror
   *  (the port's documented absence contract). */
  get tuiSettings(): TuiSettingsConfig | undefined {
    return this.mirror.namespace(TUI_SETTINGS_NS) === undefined ? undefined : this.tuiSettingsWrapper
  }

  constructor(source: RemoteConfigRuntimeSource) {
    // Bind the event seat to its service BEFORE anything subscribes.
    const on = source.remote.$on.bind(source.remote) as unknown as RemoteConfigEventsSource['$on']
    const bound: RemoteConfigRuntimeSource = {
      remote: { ...source.remote, $on: on },
      connection: source.connection,
    }
    this.mirror = new RemoteConfigMirror(bound)
    this.tuiSettingsWrapper = new RemoteTuiSettingsConfig(this.mirror)
    this.footerCommandTrust = new RemoteFooterCommandTrust(this.mirror)
    this.footerCustomItems = new RemoteFooterCustomItems(this.mirror)
    this.providers = new RemoteProviderProfileConfig(this.mirror)
    this.credentialConfig = new RemoteCredentialConfig(
      bound.remote.credentials,
      on,
      source.connection.generation,
    )
    this.credentials = this.credentialConfig
    this.authorization = new RemoteAuthorizationConfig()
    this.permissions = new RemotePermissionConfig(this.mirror, source.remote.commands)
    this.presetDefault = new RemotePresetDefaultConfig(this.mirror)
    this.subagentModelSelection = new RemoteSubagentModelSelectionConfig(this.mirror)
  }

  /** Commit one fresh mirror snapshot (or leave the last-known value). A
   *  failure is RECORDED as well as thrown, so `readiness()` stays truthful
   *  and `lastRefreshFailure()` explains why even when the caller only
   *  awaited the assembly's read barrier. */
  async describe(): Promise<void> {
    try {
      await this.mirror.describe()
      this.mirror.recordSuccess()
    } catch (error) {
      this.mirror.recordFailure(error)
      throw error
    }
  }

  /** The truthfulness of the current snapshot. */
  readiness(): RemoteConfigReadiness {
    return this.mirror.readiness()
  }

  /** The semantic currentness signal (§9.1): the UI marks last-known values
   *  non-current and refuses writes while this is not `ready`. */
  configReadiness(): ConfigReadiness {
    return this.mirror.readiness()
  }

  /** The last invalidation-triggered rerun failure, or undefined. */
  lastRefreshFailure(): unknown {
    return this.mirror.lastRefreshFailure()
  }

  /** Drop the cached snapshot (and any in-flight read's publication right).
   *  Subscriptions stay installed so a later describe can repopulate. */
  disposeCache(): void {
    this.mirror.disposeCache()
  }

  /** Release every subscription (mirror + credential listeners) and the
   *  cache exactly once. */
  dispose(): void {
    this.mirror.dispose()
    this.credentialConfig.dispose()
  }
}
