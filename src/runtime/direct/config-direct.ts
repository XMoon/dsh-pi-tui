/**
 * The Direct config adapter (M1.9) — the in-process implementation of
 * `ConfigPort` over the dsh `settings` / `credentials` / `authorization` /
 * `permissionPresets` / `commands` / `agentPresets` services. This is the
 * ONLY module in the config path that touches `ctx` (and the Host schema
 * knowledge: the `llm-pi-ai` / `permission` / `agent-preset-registry`
 * settings namespaces); consumers depend on the port, and a Remote adapter will
 * implement the same interfaces in a later milestone.
 *
 * The /yolo permission switch deliberately stays on the OFFICIAL command
 * line (`commands.execute('/permission danger-full-access')`) so the
 * switch takes the exact host path — the raw commands service never leaks
 * past this adapter.
 *
 * Full contract: docs/architecture/host-client.md + docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/config-direct
 */

import { symbols, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import {
  credentialKeyId,
  credentialKeyScope,
  type CredentialKey,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import {
  AuthorizationDeclinedError,
  type AuthorizationEntry,
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import {
  getPath,
  providerOptionsFor,
  type ProviderCatalogEntry,
  type ProviderOption,
  providerProfileProjectionOf,
} from '../../domain/catalog/provider.ts'
import { cancellationError } from '../process/tasks.ts'
import { SupersededReadError } from '../read-error.ts'
import { safeErrorMessage } from '../process/errors.ts'
import { projectSubagentLimits, projectSubagentModelSelection } from '../subagent-settings.ts'
import {
  projectAgentLoopSettings,
  projectSessionLogUpload,
  projectShellExecutionSettings,
  type SectionFacts,
} from '../host-settings-sections.ts'
import {
  resolveTrustedFooterCommand,
  resolveUserCommandItemActivationIds,
  resolveUserCommandItemFallbackActivationIds,
  resolveUserLayerFooterMode,
} from '../../domain/footer/command-trust.ts'
import { parseFooterCustomItems, type FooterCustomItemsParseResult } from '../../domain/footer/custom-items.ts'
import {
  assertFetchProviderId,
  assertFetchProviderReplaceable,
  assertSearchApiCount,
  assertSearchProviderId,
  assertSearchProviderReplaceable,
  assertWebApiBilling,
  readWebApiBilling,
  webApiAdvancedFactsOf,
  webProviderSelectionFactsOf,
} from '../../domain/web-provider-settings.ts'
import type {
  AccountBalanceOutcome,
  AccountClientMetadata,
  AccountConfig,
  AccountObservation,
  AccountObservationLease,
  AccountWatchEvent,
  AccountProfile,
  AccountProfileOutcome,
  AccountView,
  AuthorizationConfig,
  AuthorizationFlowEvent,
  AuthorizationFlowTarget,
  AuthorizationPromptEvent,
  ConfigPort,
  CredentialConfig,
  CredentialProviderOption,
  FooterCommandTrust,
  FooterCustomItemsConfig,
  FooterCustomItemsRaw,
  PermissionConfig,
  PresetDefaultConfig,
  ProviderConfigGuide,
  ProviderCatalogSnapshot,
  ProviderProfileConfig,
  ProviderProfileFacts,
  SubagentLimits,
  SubagentLimitsConfig,
  SubagentModelSelection,
  SubagentModelSelectionConfig,
  AgentLoopSettings,
  AgentLoopSettingsConfig,
  HostShellExecutor,
  ShellExecutionSettings,
  ShellExecutionSettingsConfig,
  SessionLogUpload,
  SessionLogUploadConfig,
  SectionPatch,
  SectionRead,
  SectionMutationOutcome,
  TuiSettingsConfig,
  VisualToolsConfig,
  VisualToolsState,
  WebProviderConfig,
  WebProviderSettings,
  WebStartupPreferenceConfig,
  WebStartupPreferenceState,
  BackendStartupPreferenceConfig,
  BackendStartupPreferenceState,
  PublicBackendValue,
  AcpStartupPreferenceConfig,
  AcpStartupPreferenceState,
  ConfigReadiness,
  McpServerSources,
  McpServerSourcesConfig,
  McpServerConfiguration,
  McpServerConfigurationConfig,
  McpConfigWriteOutcome,
} from '../config-port.ts'
import {
  baseDictKeysOf,
  classifyMcpServerProvenance,
  projectMcpServerEntry,
  type McpClassifiedServerEntry,
} from '../../domain/mcp/server-config.ts'
import {
  VISUAL_TOOLS_STATUS_SERVICE,
  type VisualToolsRuntimeStatus,
} from '../../domain/visual/runtime-status.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on?: Context['on']
}

/** The structural 0.1.7 SettingsForms surface (descriptor projection +
 * path-scoped mutation). The old `get(namespace)` business-store read is
 * gone upstream: effective values arrive form-projected on the descriptor,
 * and every write carries the read revision. */
export interface SettingsServiceLike {
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsDescriptorLike[] | undefined
  mutate(
    ns: string,
    ops: readonly SettingsMutationOp[],
    expectedRevision?: number,
  ): Promise<unknown>
}

/** One official settings path op (set + unset), the FR4 wire shape. */
export type SettingsMutationOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** The structural credentials service surface. */
export interface CredentialsServiceLike {
  set(ref: string, secret: string): Promise<unknown>
  unset(ref: string): Promise<unknown>
  deleteRecord(key: string): Promise<unknown>
  describe(ref: string): Promise<{ configured: boolean; source?: string }>
  listRecords(): Promise<readonly { key: string; kind?: string }[]>
}

/** The structural permission-presets service surface. */
export interface PermissionPresetsServiceLike {
  get names(): readonly string[]
  /** The 0.1.7 effective-default read (deployment `default` merged with the
   * volatile `defaultPreset` user preference) — the owner already exposes
   * the value, so the TUI must not read it back through Settings forms. */
  readonly defaultPreset?: string
}

/** The structural commands service surface (permission application only). */
export interface CommandsServiceLike {
  execute(agent: unknown, line: string, args: readonly unknown[], signal: AbortSignal): Promise<unknown>
}

/** The structural agent-presets service surface (the registry default). */
export interface AgentPresetsServiceLike {
  get defaultId(): string
}

/** The Direct backend's config: the `ctx` services behind the semantic
 * `ConfigPort` interfaces. */
export class DirectConfigPort implements ConfigPort {
  /** Direct reads hit the in-process Host authority, so its config facts are
   *  always the current ones (§9.1). */
  configReadiness(): ConfigReadiness {
    return 'ready'
  }

  /**
   * Direct settings writes settle inside THIS process's Host settings service
   * (awaited by their handlers) and the Direct branch owns no Client OS
   * retirement capability at all, so there is no Client-local persisted write
   * lifetime to observe here. The split Client's Remote port owns the real
   * registration.
   */
  hasUnsettledWrites(): boolean {
    return false
  }

  readonly tuiSettings: TuiSettingsConfig | undefined
  readonly footerCommandTrust: FooterCommandTrust
  readonly footerCustomItems: FooterCustomItemsConfig
  readonly providers: ProviderProfileConfig
  readonly credentials: CredentialConfig
  readonly authorization: AuthorizationConfig
  readonly account: AccountConfig
  readonly permissions: PermissionConfig
  readonly presetDefault: PresetDefaultConfig
  readonly subagentLimits: SubagentLimitsConfig
  readonly subagentModelSelection: SubagentModelSelectionConfig
  readonly agentLoopSettings: AgentLoopSettingsConfig
  readonly shellExecutionSettings: ShellExecutionSettingsConfig
  readonly sessionLogUpload: SessionLogUploadConfig
  readonly web: WebProviderConfig
  readonly visualTools: VisualToolsConfig
  readonly webStartupPreference: WebStartupPreferenceConfig
  readonly backendStartupPreference: BackendStartupPreferenceConfig
  readonly acpStartupPreference: AcpStartupPreferenceConfig
  readonly mcpServerSources: McpServerSourcesConfig
  readonly mcpServerConfiguration: McpServerConfigurationConfig
  /** FR3: the live Host MCP generation the source read is bound to. */
  private readonly mcpGeneration: (() => object) | undefined

  constructor(
    ctx: HostContextLike,
    tuiSettings: TuiSettingsConfig | undefined,
    agentFor: (sessionId: string) => unknown | undefined,
    mcpGeneration?: () => object,
  ) {
    this.mcpGeneration = mcpGeneration
    this.tuiSettings = tuiSettings
    this.footerCommandTrust = new DirectFooterCommandTrust(ctx)
    this.footerCustomItems = new DirectFooterCustomItems(ctx)
    this.providers = new DirectProviderProfileConfig(ctx)
    this.credentials = new DirectCredentialConfig(ctx)
    this.authorization = new DirectAuthorizationConfig(ctx)
    this.account = new DirectAccountConfig(ctx)
    this.permissions = new DirectPermissionConfig(ctx, agentFor)
    this.presetDefault = new DirectPresetDefaultConfig(ctx)
    this.subagentLimits = new DirectSubagentLimitsConfig(ctx)
    this.subagentModelSelection = new DirectSubagentModelSelectionConfig(ctx)
    this.agentLoopSettings = new DirectAgentLoopSettingsConfig(ctx)
    this.shellExecutionSettings = new DirectShellExecutionSettingsConfig(ctx)
    this.sessionLogUpload = new DirectSessionLogUploadConfig(ctx)
    this.web = new DirectWebProviderConfig(ctx)
    this.visualTools = new DirectVisualToolsConfig(ctx)
    this.webStartupPreference = new DirectWebStartupPreferenceConfig(ctx)
    this.backendStartupPreference = new DirectBackendStartupPreferenceConfig(ctx)
    this.acpStartupPreference = new DirectAcpStartupPreferenceConfig(ctx)
    this.mcpServerSources = new DirectMcpServerSourcesConfig(ctx, mcpGeneration)
    this.mcpServerConfiguration = new DirectMcpServerConfigurationConfig(ctx, mcpGeneration)
  }
}

/** The settings descriptor's shape the form reads need (structural). */
interface SettingsDescriptorLike {
  readonly ns: string
  /** Form-projected effective value (volatile fields only). */
  readonly value?: unknown
  /** The composition base layer (inherited config, defaults resolved). */
  readonly base?: unknown
  readonly user?: unknown
  readonly revision?: number
}

/** Read ONE form descriptor by entry id (the narrow 0.1.7 replacement for
 * the removed `settings.get(ns)` business read). Callers must treat the
 * result as a Settings/UI form projection, never a second business store. */
function readSettingsDescriptor(settings: SettingsServiceLike | undefined, ns: string): SettingsDescriptorLike | undefined {
  if (settings === undefined || typeof settings.describe !== 'function') return undefined
  try {
    return (settings.describe() ?? []).find(entry => entry.ns === ns)
  } catch {
    // A throwing projection read degrades to "no descriptor" — the caller's
    // own fail-soft rules decide what that means.
    return undefined
  }
}

function settingsAuthorityOf(settings: SettingsServiceLike): object {
  const cordisService = settings as SettingsServiceLike & { readonly [symbols.original]?: SettingsServiceLike }
  return cordisService[symbols.original] ?? settings
}

type DirectDescriptorRead =
  | {
      readonly kind: 'ready'
      readonly settings: SettingsServiceLike
      readonly descriptors: readonly SettingsDescriptorLike[]
    }
  | { readonly kind: 'unavailable' | 'unreadable'; readonly reason: string }

/** ONE `describe()` read of the current Host settings service, shared by
 *  every typed section read so a single snapshot never mixes revisions. */
function readDirectDescriptors(ctx: HostContextLike): DirectDescriptorRead {
  const settings = ctx.get('settings') as SettingsServiceLike | undefined
  if (settings === undefined) return { kind: 'unavailable', reason: 'the Host settings service is unavailable' }

  let descriptors: readonly SettingsDescriptorLike[] | undefined
  try {
    descriptors = settings.describe()
  } catch (error) {
    return { kind: 'unreadable', reason: `the Host settings descriptor read failed: ${safeErrorMessage(error)}` }
  }
  if (!Array.isArray(descriptors)) {
    return { kind: 'unreadable', reason: 'the Host settings descriptor list is not readable' }
  }
  return { kind: 'ready', settings, descriptors }
}

function projectDirectDescriptor<T extends object>(
  settings: SettingsServiceLike,
  descriptor: SettingsDescriptorLike,
  project: (effective: unknown, inherited: unknown) => SectionFacts<T> | undefined,
): SectionRead<T> {
  if (typeof descriptor.revision !== 'number' || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0) {
    return { kind: 'unreadable', reason: 'the official Host settings revision is not readable' }
  }
  let projected: SectionFacts<T> | undefined
  try {
    projected = project(descriptor.value, descriptor.base)
  } catch (error) {
    return { kind: 'unreadable', reason: `the official Host settings value is not readable: ${safeErrorMessage(error)}` }
  }
  if (projected === undefined) {
    return { kind: 'unreadable', reason: 'the official Host settings value or inherited base is not readable' }
  }
  return {
    kind: 'ready',
    generation: settingsAuthorityOf(settings),
    revision: descriptor.revision,
    ...projected,
  }
}

function readDirectSection<T extends object>(
  ctx: HostContextLike,
  namespace: string,
  project: (effective: unknown, inherited: unknown) => SectionFacts<T> | undefined,
): SectionRead<T> {
  const read = readDirectDescriptors(ctx)
  if (read.kind !== 'ready') return read
  const descriptor = read.descriptors.find(entry => entry.ns === namespace)
  if (descriptor === undefined) {
    return { kind: 'unavailable', reason: 'the official Host settings section is not mounted' }
  }
  return projectDirectDescriptor(read.settings, descriptor, project)
}

/** The official model-tool shell settings are bound to the Host-served
 *  namespace, following dsh-web: `pwsh-sandbox` wins when both are served,
 *  otherwise the single served row is used, and no served row is unavailable. */
const SHELL_EXECUTOR_ROWS: readonly { readonly executor: HostShellExecutor; readonly namespace: string }[] = [
  { executor: 'pwsh', namespace: 'pwsh-sandbox' },
  { executor: 'bash', namespace: 'bash-sandbox' },
]

function readDirectShellExecutionSection(ctx: HostContextLike): SectionRead<ShellExecutionSettings> {
  const read = readDirectDescriptors(ctx)
  if (read.kind !== 'ready') return read
  const active = SHELL_EXECUTOR_ROWS.find(row => read.descriptors.some(entry => entry.ns === row.namespace))
  if (active === undefined) {
    return { kind: 'unavailable', reason: 'no active Host shell executor settings row is mounted' }
  }
  const descriptor = read.descriptors.find(entry => entry.ns === active.namespace)!
  return projectDirectDescriptor(read.settings, descriptor, projectShellExecutionSettings(active.executor))
}

/** The Direct M5 footer-command trust read: the USER layer of the `tui-app`
 * settings descriptor decides BOTH the command mode and the command (plan
 * §17.4 — a project layer can never silently trigger the user's command).
 * The adapter owns the descriptor access; a Remote adapter replays the same
 * facts from the wire. */
class DirectFooterCommandTrust implements FooterCommandTrust {
  private readonly ctx: HostContextLike
  /** The descriptor snapshot for the CURRENT read pair (both getters
   * share one describe() call per applyFooterSettings evaluation). */
  private descriptorCache: SettingsDescriptorLike | undefined | null = null

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  get userFooterMode(): string | undefined {
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) return undefined
    return resolveUserLayerFooterMode([descriptor], 'tui-app')
  }

  get command() {
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) return undefined
    return resolveTrustedFooterCommand([descriptor], 'tui-app')
  }

  /** The ids the USER layer authorizes for custom command item execution
   * (PR D activation trust, mode-gated): the USER custom layout's refs,
   * but only while the USER layer itself declares footer: custom — a
   * stale leftover layout under footer: default/compact authorizes
   * nothing, so a project merged layout can never resurrect a dormant
   * USER command. */
  get userCommandItemActivationIds() {
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) return new Set<string>()
    return resolveUserCommandItemActivationIds([descriptor], 'tui-app')
  }

  /** The ids authorized for the native FALLBACK surface (the USER's own
   * footerFallbackMode decides). */
  get userCommandItemFallbackActivationIds() {
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) return new Set<string>()
    return resolveUserCommandItemFallbackActivationIds([descriptor], 'tui-app')
  }

  /** One describe() read per synchronous evaluation: the two getters are
   * read together by applyFooterSettings, so caching the descriptor for
   * the current tick halves the settings-service read. */
  private readDescriptor(): SettingsDescriptorLike | undefined {
    if (this.descriptorCache !== null) return this.descriptorCache
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    const found = readSettingsDescriptor(settings, 'tui-app')
    this.descriptorCache = found
    // The cache is per-synchronous-evaluation only: reset on the next
    // macrotask so a settings change is picked up.
    queueMicrotask(() => { this.descriptorCache = null })
    return found
  }
}

/** The Direct PR C Custom Text read: only the settings descriptor's USER
 * section is authoritative. The merged document remains a pass-through for
 * persistence, but project-layer values can never create a user definition.
 * `get()` parses a safe runtime projection; `rawForPersistence()` returns a
 * detached exact USER-layer value so unknown/future definitions survive
 * unrelated writes. A malformed descriptor/collection degrades to an empty
 * fail-soft result, while an unsafe raw clone refuses the write. */
class DirectFooterCustomItems implements FooterCustomItemsConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  get(): FooterCustomItemsParseResult {
    const raw = this.readConfigRaw()
    if (raw.failed) return { items: [], invalidCount: 1 }
    return parseFooterCustomItems(raw.value)
  }

  rawForPersistence(): FooterCustomItemsRaw {
    const raw = this.readConfigRaw()
    if (raw.failed) return { kind: 'unavailable' }
    try {
      return { kind: 'available', value: structuredClone(raw.value) }
    } catch {
      return { kind: 'unavailable' }
    }
  }

  private readConfigRaw(): { value: unknown; failed: boolean } {
    try {
      const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
      const descriptor = readSettingsDescriptor(settings, 'tui-app')
      if (descriptor === undefined) return { value: undefined, failed: true }
      const user = descriptor.user
      if (user === undefined) return { value: undefined, failed: false }
      if (typeof user !== 'object' || user === null || Array.isArray(user)) return { value: undefined, failed: true }
      return { value: (user as Record<string, unknown>).footerCustomItems, failed: false }
    } catch {
      return { value: undefined, failed: true }
    }
  }
}

/** The Direct provider-profile config (`ctx.settings`; the llm-pi-ai
 * schema knowledge is adapter-owned — the wizard never names a settings
 * namespace or path). */
const PROVIDER_ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** The ONE adapter-owned rule for where a keyless profile may live: the
 * conventional llm-pi-ai `providers.<route>` slot, for a VALID provider
 * route that is not the deepseek official builtin. Shared by the option
 * DTO's `canProvisionProfile` flag and the write-time validation — the
 * flag can never advertise a slot the write would refuse (and vice
 * versa): an invalid route (the write throws), the builtin (the write
 * skips) and a non-conventional layout (a route whose profile lives in
 * its OWN section, or a hostile/malformed one — the write skips) are all
 * not keyless-writable. */
function isKeylessProfileSlot(ns: string, path: readonly string[], route: string): boolean {
  return route !== 'deepseek-official'
    && PROVIDER_ROUTE_PATTERN.test(route)
    && ns === 'llm-pi-ai'
    && path.length === 2 && path[0] === 'providers' && path[1] === route
}

/** Map one adapter-internal merged option onto the port's CLIENT DTO:
 * the Host schema facts (`settingsNs`/`settingsPath`) collapse into the
 * semantic `canProvisionProfile` flag — only the flag crosses the port.
 * Exported for the contract tests (the merge tests consume the client
 * DTO, exactly like the command surface does). */
export function credentialOptionOf(option: ProviderOption): CredentialProviderOption {
  return {
    route: option.route,
    label: option.label,
    ref: option.ref,
    configured: option.configured,
    declared: option.declared,
    namesCredential: option.namesCredential,
    group: option.group,
    canProvisionProfile: isKeylessProfileSlot(option.settingsNs, option.settingsPath, option.route),
  }
}

/** Project one settings profile value onto the detached Models facts. Only
 * strings/booleans survive; the route's display label is the directory's own
 * name, never a Client guess. */
function providerFactsOf(route: string, fallbackLabel: string, profile: unknown): ProviderProfileFacts {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    // A primitive/absent profile is still a real configuration fact; there are
    // no structured fields to project.
    return {
      route,
      configured: profile !== undefined,
      displayName: fallbackLabel,
      models: [],
    }
  }
  const record = profile as Record<string, unknown>
  const models = Array.isArray(record.models)
    ? record.models.flatMap(entry => {
        if (typeof entry === 'string') return [entry]
        if (typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string') {
          return [(entry as { id: string }).id]
        }
        return []
      })
    : []
  return {
    route,
    configured: true,
    ...(typeof record.api === 'string' && record.api !== '' ? { api: record.api } : {}),
    ...(typeof record.baseURL === 'string' && record.baseURL !== '' ? { baseURL: record.baseURL } : {}),
    displayName: typeof record.displayName === 'string' && record.displayName !== '' ? record.displayName : fallbackLabel,
    models,
    ...(typeof record.apiKeyEnv === 'string' && record.apiKeyEnv !== '' ? { apiKeyEnv: record.apiKeyEnv } : {}),
  }
}

/**
 * The detached profile facts of one option. The deepseek official builtin is
 * the adapter itself: it has no provider-profile slot, but the route is
 * ALWAYS addressable (the same rule the single-route read applies).
 */
function providerFactsFor(option: CredentialProviderOption, raw: unknown): ProviderProfileFacts {
  if (option.route === 'deepseek-official' && raw === undefined) {
    return { route: option.route, configured: true, displayName: option.label, models: [] }
  }
  return providerFactsOf(option.route, option.label, raw)
}

export class DirectProviderProfileConfig implements ProviderProfileConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private settings(): SettingsServiceLike | undefined {
    return this.ctx.get('settings') as SettingsServiceLike | undefined
  }

  available(): boolean {
    return this.settings() !== undefined
  }

  /** The llm directory surface (the catalog port's directory source). */
  private llm(): { listConfigurableProviders(): readonly ProviderCatalogEntry[] } | undefined {
    return this.ctx.get('llm') as { listConfigurableProviders(): readonly ProviderCatalogEntry[] } | undefined
  }

  /** Read ONE provider-config form descriptor's EFFECTIVE value DETACHED
   * (the entry id comes from the directory entries — internal to the
   * adapter, a consumer never names a namespace). The 0.1.7 projection
   * carries the entry's volatile fields; the llm-pi-ai `providers` dict is
   * volatile, so the section data the merge needs survives the projection.) */
  private readSectionInternal(ns: string): unknown {
    const settings = this.settings()
    if (settings === undefined) return undefined
    try {
      return detachedSection(readSettingsDescriptor(settings, ns)?.value)
    } catch {
      // An unreadable projection degrades to undefined (the old read-side
      // degradation — /login never escapes its command handler).
      return undefined
    }
  }

  /**
   * The llm-pi-ai section, detached, with the read FAILURE reported (the
   * fail-soft reader hides it, which is right for a display degradation but
   * wrong for an authoritative read).
   */
  private readProviderSection(): { readonly value: unknown; readonly failure?: string } {
    const settings = this.settings()
    if (settings === undefined) return { value: undefined }
    try {
      const descriptor = (settings.describe() ?? []).find(entry => entry.ns === 'llm-pi-ai')
      return { value: detachedSection(descriptor?.value) }
    } catch (error) {
      return { value: undefined, failure: safeErrorMessage(error) }
    }
  }

  /** The llm-pi-ai `providers` dict (route → apiKeyEnv), detached. */
  private readPiAiProvidersInternal(): Record<string, { apiKeyEnv?: string } | undefined> | undefined {
    const section = this.readSectionInternal('llm-pi-ai') as
      | { providers?: Record<string, { apiKeyEnv?: string } | undefined> }
      | undefined
    if (section === undefined || typeof section !== 'object' || section === null) return undefined
    const providers = section.providers
    if (providers === undefined) return undefined
    // Detached copy of the providers dict (route → apiKeyEnv only).
    const out: Record<string, { apiKeyEnv?: string } | undefined> = {}
    for (const [route, profile] of Object.entries(providers)) {
      out[route] = profile === undefined || typeof profile !== 'object' || profile === null
        ? profile
        : { ...(typeof profile.apiKeyEnv === 'string' ? { apiKeyEnv: profile.apiKeyEnv } : {}) }
    }
    return out
  }

  /**
   * The ONE settings read of a provider snapshot: every namespace
   * descriptor, indexed by namespace. `settings.describe()` returns ALL
   * namespaces, so ONE call per snapshot replaces one call per provider
   * route (the old per-route read amplified a large `llm-pi-ai` section
   * into hundreds of reads and deep copies).
   */
  private readDescriptors(): { readonly byNs: ReadonlyMap<string, SettingsDescriptorLike>; readonly failure?: string } {
    const settings = this.settings()
    if (settings === undefined) return { byNs: new Map() }
    try {
      const byNs = new Map<string, SettingsDescriptorLike>()
      for (const descriptor of settings.describe() ?? []) byNs.set(descriptor.ns, descriptor)
      return { byNs }
    } catch (error) {
      // A THROWING settings read is a FAILED read: reporting it (instead of
      // degrading to "no profiles") keeps a broken read from rendering as
      // "no providers configured".
      return { byNs: new Map(), failure: safeErrorMessage(error) }
    }
  }

  /**
   * The ONE provider snapshot of a directory: the settings are read ONCE
   * and each namespace the directory names is detached ONCE, so every route
   * is projected from that single read. The pure merge stays in
   * domain/catalog/provider.ts; this adapter only wires the reads and maps
   * the schema facts onto the semantic `canProvisionProfile` flag (never a
   * namespace or path across the port).
   */
  private catalogFromDirectory(entries: readonly ProviderCatalogEntry[]): ProviderCatalogSnapshot {
    const { byNs, failure } = this.readDescriptors()
    if (failure !== undefined) return { options: [], profiles: [], failure }
    const sections = new Map<string, unknown>()
    for (const ns of new Set(entries.map(entry => entry.settingsNs))) {
      const descriptor = byNs.get(ns)
      if (descriptor === undefined) continue
      const value = detachedSection(descriptor.value)
      if (value !== undefined) sections.set(ns, value)
    }
    const profileOf = (entry: ProviderCatalogEntry): unknown => {
      const section = sections.get(entry.settingsNs)
      if (section === undefined) return undefined
      return entry.settingsPath.length === 0 ? section : getPath(section, entry.settingsPath)
    }
    const rawProfiles = new Map<string, unknown>()
    for (const entry of entries) {
      if (entry.provider.length === 0 || entry.settingsNs.length === 0) continue
      rawProfiles.set(entry.provider, profileOf(entry))
    }
    const options = providerOptionsFor(entries, entry => providerProfileProjectionOf(profileOf(entry)))
      .map(option => credentialOptionOf(option))
    const profiles = options.map(option => providerFactsFor(option, rawProfiles.get(option.route)))
    return { options, profiles }
  }

  /**
   * The settings-only fallback (no llm directory): the conventional
   * llm-pi-ai `providers` slot is the only profile location.
   *
   * The section is read ONCE and both the options and the profile facts come
   * from that one read. Every profile route stays a provider — a keyless
   * profile (no `apiKeyEnv`) is still a CONFIGURED provider; the presence of
   * a key is not the membership authority.
   */
  private settingsOnlyCatalog(): ProviderCatalogSnapshot {
    // The section read is REPORTED here: a failed settings read must not
    // look like "this installation has no other provider".
    const read = this.readProviderSection()
    if (read.failure !== undefined) return { options: [], profiles: [], failure: read.failure }
    const section = read.value as
      | { providers?: Record<string, unknown> }
      | undefined
    const declared = section?.providers
    const entries: ProviderCatalogEntry[] = declared === undefined
      ? []
      : Object.keys(declared).map(route => ({
          provider: route,
          displayName: route,
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', route],
        }))
    const options = providerOptionsFor(entries, entry => providerProfileProjectionOf(declared?.[entry.provider]))
      .map(option => credentialOptionOf(option))
    const profiles = options.map(option => providerFactsFor(option, declared?.[option.route]))
    return { options, profiles }
  }

  /** The merged /login option list as the port's CLIENT DTOs: the llm
   * configurable-provider directory over its PER-ENTRY sections when the
   * llm service is present, the settings-only fallback otherwise. The
   * pure merge stays in domain/catalog/provider.ts; this adapter only wires the
   * section reads and maps the schema facts onto the semantic
   * `canProvisionProfile` flag (never a namespace or path across the
   * port). */
  listCredentialOptions(): readonly CredentialProviderOption[] {
    const llm = this.llm()
    if (llm !== undefined) {
      let entries: readonly ProviderCatalogEntry[]
      try {
        entries = llm.listConfigurableProviders()
      } catch {
        // A throwing directory read degrades to the settings-only fallback.
        return this.settingsOnlyCatalog().options
      }
      const catalog = this.catalogFromDirectory(entries)
      if (catalog.failure === undefined) return catalog.options
      // The SETTINGS read failed. The Models page reports that failure; the
      // /login and /logout parser stays fail-soft — but only for the facts
      // it actually knows: the routes' credential references come from the
      // profile, so a DERIVED reference would be a guess that can point at
      // another provider's key. Only the builtin (whose reference is a
      // constant) stays addressable, and an explicitly typed reference still
      // resolves.
      return providerOptionsFor([], () => undefined).map(option => credentialOptionOf(option))
    }
    const catalog = this.settingsOnlyCatalog()
    if (catalog.failure === undefined) return catalog.options
    // A failed settings read: only the builtin target (a constant
    // reference) stays addressable for the /login and /logout resolver.
    return providerOptionsFor([], () => undefined).map(option => credentialOptionOf(option))
  }

  /**
   * The ONE provider snapshot the Models page reads: the directory and the
   * settings are read ONCE, and every route's profile facts come from that
   * one read. A FAILED read is reported (`failure`), never presented as an
   * empty catalog.
   */
  readCatalog(): ProviderCatalogSnapshot {
    const llm = this.llm()
    if (llm === undefined) return this.settingsOnlyCatalog()
    let entries: readonly ProviderCatalogEntry[]
    try {
      entries = llm.listConfigurableProviders()
    } catch (error) {
      return { options: [], profiles: [], failure: safeErrorMessage(error) }
    }
    return this.catalogFromDirectory(entries)
  }

  readProfile(route: string): ProviderProfileFacts {
    // The deepseek official builtin is the adapter itself: there is no
    // provider-profile slot, but the route is always addressable.
    if (route === 'deepseek-official') {
      return { route, configured: true, displayName: 'deepseek official', models: [] }
    }
    const llm = this.llm()
    if (llm !== undefined) {
      let entry: ProviderCatalogEntry | undefined
      try {
        entry = llm.listConfigurableProviders().find(candidate => candidate.provider === route)
      } catch {
        entry = undefined
      }
      if (entry !== undefined) {
        const section = this.readSectionInternal(entry.settingsNs)
        const profile = entry.settingsPath.length === 0 ? section : getPath(section, entry.settingsPath)
        return providerFactsOf(route, entry.displayName, profile)
      }
    }
    // The settings-only fallback (no llm directory): the conventional
    // llm-pi-ai providers slot is the only profile location.
    const section = this.readSectionInternal('llm-pi-ai') as
      | { providers?: Record<string, unknown> }
      | undefined
    return providerFactsOf(route, route, section?.providers?.[route])
  }

  configGuide(): ProviderConfigGuide {
    // The launcher's own profile context names the EXACT patch file it
    // applies last; without one no path is guessed (custom/programmatic
    // compositions have no durable profile file).
    const profile = this.ctx.get('profileContext') as { patchPath?: unknown } | undefined
    return typeof profile?.patchPath === 'string' && profile.patchPath !== ''
      ? { profilePatchPath: profile.patchPath }
      : {}
  }

  async writeProfile(route: string, profile: Record<string, unknown>): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    if (!PROVIDER_ROUTE_PATTERN.test(route)) throw new Error('invalid provider route')
    // The create is CONDITIONAL: it writes the profile of a NEW route. ONE
    // read decides both the route's absence and the revision the write is
    // checked against, so a profile configured in between is refused by the
    // Host's revision guard instead of being overwritten.
    const descriptor = readSettingsDescriptor(settings, 'llm-pi-ai')
    if (getPath(descriptor?.value, ['providers', route]) !== undefined) {
      throw new Error(`provider route "${route}" already exists`)
    }
    await mutateSettings(settings, 'llm-pi-ai', [
      { op: 'set', path: ['providers', route], value: profile },
    ], descriptor?.revision)
  }

  async writeKeylessProfile(route: string): Promise<{ kind: 'written' } | { kind: 'skipped'; reason: string }> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    // The route becomes a settings path segment in the fallback layout.
    // Validate it at the Host boundary too: callers normally pass a catalog
    // route, but a malformed/hostile provider directory must never turn this
    // write into a path-injection primitive.
    if (!PROVIDER_ROUTE_PATTERN.test(route)) throw new Error('invalid provider route')
    // The deepseek official BUILTIN has no provider-profile slot (it is
    // the adapter itself, never a configured provider): a keyless write
    // for it is refused EXPLICITLY before any path resolution — without
    // the llm service the conventional fallback would otherwise write
    // `providers.deepseek-official`, contradicting the option DTO's
    // canProvisionProfile: false (and the command surface). The refusal
    // covers both backends uniformly (a directory can never offer the
    // builtin either).
    if (route === 'deepseek-official') {
      return { kind: 'skipped', reason: 'the deepseek official builtin has no provider-profile slot' }
    }
    // The route's profile location is resolved INTERNALLY from the
    // CURRENT directory: with the llm service present, the entry's own
    // section/path is used VERBATIM (a consumer never names a namespace);
    // a route the directory no longer offers is SKIPPED (a directory race
    // between the catalog read and the authorization completion must never
    // fall back to a guessed slot) — reported as a skip, never a silent
    // no-op the caller could present as a success. Only when the llm
    // service is ABSENT (the settings-only /login fallback) does the
    // conventional llm-pi-ai slot apply.
    const llm = this.llm()
    if (llm === undefined) {
      // ONE current read: the route's profile presence AND the revision the
      // write is checked against. A profile that appeared in the meantime is
      // NOT overwritten — the write is skipped and the caller re-reads.
      const descriptor = readSettingsDescriptor(settings, 'llm-pi-ai')
      if (getPath(descriptor?.value, ['providers', route]) !== undefined) {
        return { kind: 'skipped', reason: `provider route "${route}" already has a profile` }
      }
      await mutateSettings(settings, 'llm-pi-ai', [
        { op: 'set', path: ['providers', route], value: {} },
      ], descriptor?.revision)
      return { kind: 'written' }
    }
    const directoryEntry = llm.listConfigurableProviders().find(candidate => candidate.provider === route)
    if (directoryEntry === undefined) {
      return { kind: 'skipped', reason: `no configurable-provider entry for ${route}` }
    }
    // The directory metadata is validated against the adapter-owned
    // provider-config schema before it reaches a mutate: the entry must
    // live in the llm-pi-ai section and its path must be the providers
    // slot OF THE ROUTE — a hostile/malformed directory entry can never
    // redirect the write to an arbitrary namespace or path. The SAME rule
    // drives the option DTO's canProvisionProfile flag, so the flag can
    // never advertise a slot the write would refuse.
    const path = [...directoryEntry.settingsPath]
    const validLayout = isKeylessProfileSlot(directoryEntry.settingsNs, path, route)
    if (!validLayout) {
      return { kind: 'skipped', reason: `hostile or malformed directory entry for ${route}` }
    }
    // ONE current read (see the conventional slot above): the write never
    // overwrites a profile that exists now, and the revision fences a
    // concurrent change between the check and the write.
    const descriptor = readSettingsDescriptor(settings, directoryEntry.settingsNs)
    if (getPath(descriptor?.value, path) !== undefined) {
      return { kind: 'skipped', reason: `provider route "${route}" already has a profile` }
    }
    await mutateSettings(settings, directoryEntry.settingsNs, [
      { op: 'set', path, value: {} },
    ], descriptor?.revision)
    return { kind: 'written' }
  }
}

/** Carry the CURRENT descriptor revision on every form write (the 0.1.7
 * conflict contract): a concurrent external edit surfaces as the official
 * SettingsConflictError instead of a silent last-write-wins. */
async function mutateSettings(
  settings: SettingsServiceLike,
  ns: string,
  ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
  expectedRevision?: number,
): Promise<unknown> {
  // The revision the CALLER decided on, when it has one: the Host's
  // revision guard then refuses a write whose namespace changed in between.
  const revision = expectedRevision ?? readSettingsDescriptor(settings, ns)?.revision
  return settings.mutate(ns, ops, revision)
}

/** A JSON-safe DETACHED copy of one settings section (settings documents
 * are zod-validated plain JSON; a hostile/uncloneable value degrades to
 * undefined — never aliased, never thrown on). */
function detachedSection(value: unknown): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/** The Direct credentials config (`ctx.credentials` + the credential
 * event wiring). */
export class DirectCredentialConfig implements CredentialConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private credentials(): CredentialsServiceLike | undefined {
    return this.ctx.get('credentials') as CredentialsServiceLike | undefined
  }

  available(): boolean {
    return this.credentials() !== undefined
  }

  async setReference(ref: string, secret: string): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('credentials service unavailable')
    await credentials.set(ref as CredentialRef, secret)
  }

  async unsetReference(ref: string): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('credentials service unavailable')
    await credentials.unset(ref as CredentialRef)
  }

  async deleteRecord(key: string): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('credentials service unavailable')
    await credentials.deleteRecord(key as CredentialKey)
  }

  async describeReference(ref: string): Promise<{ configured: boolean; source?: string }> {
    const credentials = this.credentials()
    if (credentials === undefined) return { configured: false }
    const info = await credentials.describe(ref)
    // Detached copy (the service record is Host-owned).
    return { configured: info.configured, ...typeof info.source === 'string' ? { source: info.source } : {} }
  }

  recordsSupported(): boolean {
    return true
  }

  async listRecords(): Promise<readonly { key: string; kind?: string }[]> {
    const credentials = this.credentials()
    if (credentials === undefined) return []
    const records = await credentials.listRecords()
    // Detached copies (presence + kind only; a secret never leaves the
    // credentials service, and the records are never aliased).
    return records.map(record => ({
      key: record.key,
      ...typeof record.kind === 'string' ? { kind: record.kind } : {},
    }))
  }

  onChanged(listener: () => void): () => void {
    const disposers: Array<() => void> = []
    const register = (event: 'credentials/reference-updated' | 'credentials/record-updated'): void => {
      const dispose = this.ctx.on?.(event, listener)
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
    register('credentials/reference-updated')
    register('credentials/record-updated')
    // The port returns a disposer so surface remounts/HMR can never
    // accumulate duplicate listeners (review finding).
    return () => { for (const dispose of disposers) dispose() }
  }
}

/** The record scope every llm-pi-ai provider flow writes under (matches
 * `@deepseek-ai/dsh-llm-pi-ai`'s RECORD_SCOPE — the TUI addresses flows by
 * route through it). Direct Host knowledge, kept beside the adapter that
 * interprets the Host authorization entries. */
export const LLM_PI_AI_SCOPE = 'llm-pi-ai'

/** The structural authorization service surface this Direct adapter reads. */
export interface AuthorizationServiceLike {
  list(): readonly AuthorizationEntry[]
  describe(key: CredentialKey): AuthorizationEntry | undefined
  begin(request: {
    key: CredentialKey
    method?: string
    interaction: {
      notify(notice: AuthorizationNotice): void
      prompt(prompt: {
        kind: 'text' | 'secret' | 'select'
        message: string
        placeholder?: string
        options?: readonly { id: string; label: string; description?: string }[]
        signal?: AbortSignal
      }): Promise<string>
    }
    signal?: AbortSignal
  }): Promise<{ status: 'authorized' | 'cancelled' }>
  cancel(key: CredentialKey): void
}

/** Map the Host authorization entries to detached /login flow targets,
 * deriving the route from the key's scope (llm-pi-ai flows address the provider
 * route). This is the ONLY place that knows the Host entry shape. */
export function authorizationTargets(entries: readonly AuthorizationEntry[]): AuthorizationFlowTarget[] {
  return entries.map(entry => ({
    kind: 'authorization',
    route: credentialKeyScope(entry.key) === LLM_PI_AI_SCOPE ? credentialKeyId(entry.key) : undefined,
    key: entry.key,
    label: entry.label,
    methods: entry.methods,
    inFlight: entry.inFlight,
  }))
}

/** Read an abort signal without control-flow narrowing (the caller can abort
 * between the synchronous pre-dispatch check and attempt installation). */
function callerAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** The Direct authorization config (`ctx.authorization` behind the config
 * port's AuthorizationConfig). The upstream interaction model (notify/prompt
 * callbacks) is bridged into the port's EVENT model: the adapter owns the
 * bridge interaction, consumers see only detached events and answer with
 * `respond`/`cancel` — no callback ever crosses the contract. */
export class DirectAuthorizationConfig implements AuthorizationConfig {
  private readonly ctx: HostContextLike
  private readonly listeners = new Set<(event: AuthorizationFlowEvent) => void>()
  /** Pending prompt promises: promptId → the answer bridge. */
  private readonly pendingPrompts = new Map<string, {
    attemptId: string
    resolve: (answer: string) => void
    reject: (error: unknown) => void
    /** Remove the prompt's abort listener (every settlement path runs it
     * so a resolved prompt never leaks its listener). */
    cleanup: () => void
  }>()
  /** attemptId → the upstream attempt's withdraw controller + the observed
   * settlement promise (held so the flow is never a floating promise) +
   * the caller-abort listener disposer. */
  private readonly attempts = new Map<string, {
    controller: AbortController
    key: CredentialKey
    settlement: Promise<void>
    disposeCallerAbortListener: () => void
    /** The terminal event for this attempt has been emitted exactly once. */
    settled: boolean
    /** A forced caller/page teardown owns prompt cleanup for this attempt. */
    forced: boolean
  }>()

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private authorization(): AuthorizationServiceLike | undefined {
    return this.ctx.get('authorization') as AuthorizationServiceLike | undefined
  }

  available(): boolean {
    return this.authorization() !== undefined
  }

  listTargets(): readonly AuthorizationFlowTarget[] {
    const authorization = this.authorization()
    // Detached copies — the method OBJECTS are cloned too (a shallow
    // array copy would still alias the Host's method rows).
    return authorizationTargets(authorization?.list() ?? [])
      .map(target => ({ ...target, methods: target.methods.map(method => ({ ...method })) }))
  }

  /** The in-process registry is read on demand: there is no mirror to refresh
   *  and no Connection generation to fence. */
  refreshTargets(): Promise<void> {
    return Promise.resolve()
  }

  targetsState(): 'ready' | 'unavailable' {
    // Direct is always current: `unavailable` means the official plugin is not
    // installed, which is a definite fact, never an unread snapshot.
    return this.available() ? 'ready' : 'unavailable'
  }

  onEvent(listener: (event: AuthorizationFlowEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  begin(request: {
    key: string
    method?: string
    signal?: AbortSignal
  }): Promise<{ kind: 'started'; attemptId: string } | { kind: 'unavailable' }> {
    const authorization = this.authorization()
    if (authorization === undefined) return Promise.resolve({ kind: 'unavailable' })
    const attemptId = randomUUID()
    const controller = new AbortController()
    const key = request.key as CredentialKey
    const signal = request.signal === undefined
      ? controller.signal
      : AbortSignal.any([request.signal, controller.signal])
    // The upstream seam is callback-shaped; the adapter bridges it:
    // notices and prompts become detached EVENTS, and the prompt promise
    // resolves through `respond` / rejects through `cancel` — the flow
    // never sees the TUI, and the TUI never crosses the contract with a
    // callback.
    const interaction: AuthorizationInteraction = {
      notify: (notice) => {
        this.emit({ kind: 'notice', attemptId, notice: { ...notice } })
      },
      prompt: (prompt) => this.bridgePrompt(attemptId, prompt),
    }
    // The CALLER's signal (the runner's teardown) aborts the attempt the
    // same way cancel() does: reject the pending prompt bridges and emit
    // their withdrawals IMMEDIATELY — a provider that ignores its abort
    // signal must never leave the client's prompt UI open (or the command
    // hanging on the outcome) until some settlement that never comes.
    // The listener is DISPOSED on every settlement/cancel path (never
    // left attached to the long-lived runner signal — a leak per login).
    // The attempt is REMOVED from the map by the SAME idempotent path
    // (see finalizeAttempt), so a provider that ignores its signal and
    // never settles cannot retain the attempt/controller/listener either
    // — repeated aborted logins leave nothing behind.
    const withdrawOnCallerAbort = (): void => {
      // Forced page/runner teardown: there is no prompt UI left to answer.
      // Reject the bridges as lifecycle cleanup so the Host flow can settle;
      // the page is already gone, so no false terminal is painted.
      this.cancelAttempt(attemptId, true)
    }
    const disposeCallerAbortListener = (): void => {
      request.signal?.removeEventListener('abort', withdrawOnCallerAbort)
    }
    // An ALREADY-ABORTED caller signal never dispatches the abort event to
    // a listener added afterwards — and the upstream flow must NOT be
    // started at all (a provider that ignores its signal would otherwise
    // keep the attempt and the listener retained forever even though the
    // login is already cancelled). Finalize deterministically: report the
    // attempt as settled-cancelled immediately, nothing is retained.
    if (request.signal?.aborted === true) {
      this.emit({ kind: 'settled', attemptId, status: 'cancelled' })
      return Promise.resolve({ kind: 'started', attemptId })
    }
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', withdrawOnCallerAbort, { once: true })
    }
    // Install the attempt record BEFORE begin(): the provider can emit a
    // prompt synchronously from begin(), and the bridge must be able to see
    // the attempt and its forced-teardown state. The settlement promise is
    // replaced immediately after begin() returns the flow promise.
    this.attempts.set(attemptId, {
      controller,
      key,
      settlement: Promise.resolve(),
      disposeCallerAbortListener,
      settled: false,
      forced: false,
    })
    // A caller can abort between the listener installation and this record;
    // the event found no attempt then. Mark the record forced now so any
    // synchronous prompt is rejected as surface-disposed.
    if (callerAborted(request.signal)) this.cancelAttempt(attemptId, true)
    let flow: ReturnType<AuthorizationServiceLike['begin']>
    try {
      flow = authorization.begin({ key, method: request.method, interaction, signal })
    } catch (error) {
      // A SYNCHRONOUS begin failure (a wire backend throwing before its
      // first await): remove the placeholder and the caller-abort listener.
      this.attempts.delete(attemptId)
      disposeCallerAbortListener()
      return Promise.reject(error)
    }
    // The attempt runs detached: its settlement is an EVENT, never a
    // return value. The settlement promise is HELD in the attempts map
    // (observed, never a floating discard) and removed when it settles.
    // The handlers are IDEMPOTENT against a prior finalizeAttempt (the
    // caller abort): a late upstream settlement after the finalization
    // only emits (the command already unsubscribed — a listener-less emit
    // is a no-op) and removes nothing twice.
    const settleUpstream = (
      outcome: { status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string },
    ): void => {
      const attempt = this.attempts.get(attemptId)
      if (attempt === undefined || attempt.settled) return
      attempt.settled = true
      this.finalizeAttempt(attemptId)
      this.emit({
        kind: 'settled',
        attemptId,
        status: outcome.status,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      })
    }
    const settlement = flow.then(
      outcome => settleUpstream(outcome),
      (error: unknown) => {
        settleUpstream({
          status: 'failed',
          code: (error as { code?: unknown } | null)?.code as string | undefined,
          message: safeErrorMessage(error),
        })
      },
    )
    const record = this.attempts.get(attemptId)
    if (record !== undefined) record.settlement = settlement
    return Promise.resolve({ kind: 'started', attemptId })
  }

  respond(attemptId: string, promptId: string, answer: string | null): Promise<void> {
    const pending = this.pendingPrompts.get(promptId)
    if (pending === undefined || pending.attemptId !== attemptId) return Promise.resolve()
    this.pendingPrompts.delete(promptId)
    pending.cleanup()
    if (answer === null) {
      // The human declined the prompt: the seam's decline taxonomy, not a
      // withdrawal (the flow distinguishes the two).
      pending.reject(new AuthorizationDeclinedError())
    } else {
      pending.resolve(answer)
    }
    return Promise.resolve()
  }

  cancel(attemptId: string): Promise<void> {
    this.cancelAttempt(attemptId)
    return Promise.resolve()
  }

  /** Request cancellation without tearing down prompts or forging a terminal
   *  outcome. A pending prompt is not proof that the provider avoided
   *  `commit()`: prompt() and commit() are independent, and the official
   *  service suppresses abort while committing. Keep the prompt answerable and
   *  let `settleUpstream` withdraw/reject it and emit the one authoritative
   *  outcome. */
  private cancelAttempt(attemptId: string, forcePrompts = false): void {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined || attempt.settled) return
    // Record the forced intent BEFORE dispatching abort: a provider abort
    // listener can synchronously call prompt(), and bridgePrompt() must
    // already see the dead surface. Abort still precedes bridge rejection.
    if (forcePrompts) {
      attempt.forced = true
      attempt.controller.abort()
      this.rejectAttemptPrompts(attemptId, 'authorization surface disposed')
      attempt.disposeCallerAbortListener()
      return
    }
    // Ordinary cancel only requests Host withdrawal. KEEP the caller-abort
    // listener alive: a later forced page teardown must still be able to
    // release a prompt the Host could not withdraw during its commit.
    attempt.controller.abort()
  }

  /** The ONE idempotent local-finalization path for an attempt: rejects
   * and withdraws every pending prompt bridge, disposes the caller-abort
   * listener, removes the attempt from the map and aborts the upstream
   * controller. Safe to call from cancel(), the caller-abort listener and
   * the settlement handlers (whichever runs first wins; later calls are
   * no-ops). A provider that ignores its signal and never settles cannot
   * retain the attempt/controller/listener — repeated aborted logins
   * leave nothing behind (review finding). */
  private finalizeAttempt(attemptId: string): void {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) return
    this.attempts.delete(attemptId)
    this.rejectAttemptPrompts(attemptId)
    attempt.disposeCallerAbortListener()
    attempt.controller.abort()
  }

  /** Bridge one upstream prompt into an event + a pending answer promise. */
  private bridgePrompt(attemptId: string, prompt: AuthorizationPrompt): Promise<string> {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined || attempt.forced) {
      // The page is gone (or its teardown already won): no UI can answer this
      // prompt. Reject as a withdrawal/surface disposal, never a human decline.
      return Promise.reject(cancellationError('authorization surface disposed'))
    }
    return new Promise<string>((resolve, reject) => {
      const promptId = randomUUID()
      // The pending entry carries the abort-listener REMOVAL so every
      // settlement path (respond, cancel, attempt settle, withdrawal)
      // cleans up after itself — a resolved prompt must never leave its
      // abort listener registered (a leak per prompt, review finding).
      let removeAbortListener: (() => void) | undefined
      const pending = {
        attemptId,
        resolve,
        reject,
        cleanup: (): void => { removeAbortListener?.() },
      }
      this.pendingPrompts.set(promptId, pending)
      const event: AuthorizationPromptEvent = prompt.kind === 'select'
        ? {
            kind: 'select',
            message: prompt.message,
            options: prompt.options.map(option => ({
              id: option.id,
              label: option.label,
              ...(option.description !== undefined && option.description !== ''
                ? { description: option.description }
                : {}),
            })),
          }
        : {
            kind: prompt.kind,
            message: prompt.message,
            ...(prompt.placeholder !== undefined && prompt.placeholder !== ''
              ? { placeholder: prompt.placeholder }
              : {}),
          }
      this.emit({ kind: 'prompt', attemptId, promptId, prompt: event })
      // The flow may withdraw a prompt on its own (its signal): the
      // withdrawal is NOT a decline — surface it as an event so the
      // consumer closes the prompt UI, and reject with a non-decline
      // cancellation. An ALREADY-aborted signal (the flow withdrew before
      // the bridge even registered) must take the SAME path immediately —
      // never leave the pending promise unresolved.
      const withdraw = (): void => {
        removeAbortListener?.()
        const existing = this.pendingPrompts.get(promptId)
        if (existing === undefined || existing !== pending) return
        this.pendingPrompts.delete(promptId)
        reject(cancellationError('authorization prompt withdrawn'))
        this.emit({ kind: 'prompt-withdrawn', attemptId, promptId })
      }
      if (prompt.signal?.aborted === true) {
        withdraw()
        return
      }
      if (prompt.signal !== undefined) {
        const signal = prompt.signal
        removeAbortListener = () => { signal.removeEventListener('abort', withdraw) }
        signal.addEventListener('abort', withdraw, { once: true })
      }
    })
  }

  private rejectAttemptPrompts(attemptId: string, reason = 'authorization attempt settled'): void {
    for (const [promptId, pending] of this.pendingPrompts) {
      if (pending.attemptId !== attemptId) continue
      this.pendingPrompts.delete(promptId)
      pending.cleanup()
      pending.reject(cancellationError(reason))
      // The Host has settled; close the prompt and release any flow await.
      this.emit({ kind: 'prompt-withdrawn', attemptId, promptId })
    }
  }

  private emit(event: AuthorizationFlowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A listener must never break the attempt (the surface that
        // cannot render a notice loses the notice, never the flow).
      }
    }
  }
}

/** The structural DeepSeek Account host service (the official
 * `DeepSeekAccount` abstract class's public surface). */
export interface DeepSeekAccountServiceLike {
  getState(): Promise<unknown>
  getProfile(client: AccountClientMetadata): Promise<unknown>
  getBalance(client: AccountClientMetadata): Promise<unknown>
  watch(signal: AbortSignal, includeIdentityChanges?: boolean): AsyncIterable<unknown>
  startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<unknown>
  cancelSignIn(id: string): Promise<unknown>
  signOut(client: AccountClientMetadata): Promise<unknown>
}

/** The structural Host webserver surface the account adapter needs. */
export interface WebServerServiceLike {
  getOrigin(): string
}

/** The Direct DeepSeek Account adapter (`ctx.deepseekAccount` + the official
 * `ctx.webServer` callback listener). Every DTO is a detached copy: no token,
 * grant payload, PKCE value, PlatformSession or service object crosses the
 * port. The callback origin is ALWAYS the Host listener's own bound loopback
 * root — a Client never supplies one. */
export class DirectAccountConfig implements AccountConfig {
  private readonly ctx: HostContextLike
  private readonly observationLeases = new WeakMap<object, { epoch: number; active: boolean }>()
  private readonly serviceInvalidationListeners = new Set<() => void>()
  private observationEpoch = 0

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
    ctx.on?.('internal/service', name => {
      if (name !== 'deepseekAccount') return
      this.invalidateObservations()
      for (const listener of [...this.serviceInvalidationListeners]) listener()
    })
  }

  private account(): DeepSeekAccountServiceLike | undefined {
    return this.ctx.get('deepseekAccount') as DeepSeekAccountServiceLike | undefined
  }

  available(): boolean {
    return this.account() !== undefined
  }

  private observe(view: AccountView, lease: object = {}): AccountObservation {
    this.observationLeases.set(lease, { epoch: this.observationEpoch, active: true })
    return { view, lease: lease as AccountObservationLease }
  }

  private invalidateObservations(): void {
    this.observationEpoch += 1
  }

  private assertObservation(lease: AccountObservationLease, method: string): void {
    const record = this.observationLeases.get(lease)
    if (record === undefined || !record.active || record.epoch !== this.observationEpoch || !this.available()) {
      throw new SupersededReadError(`Direct account.${method} does not have a current Host observation`)
    }
  }

  isObservationCurrent(lease: AccountObservationLease): boolean {
    const record = this.observationLeases.get(lease)
    return record !== undefined && record.active && record.epoch === this.observationEpoch && this.available()
  }

  async getState(): Promise<AccountObservation> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const epoch = this.observationEpoch
    const view = accountViewOf(await account.getState())
    if (epoch !== this.observationEpoch || !this.available()) {
      throw new SupersededReadError('Direct account.getState was superseded by Host observation invalidation')
    }
    return this.observe(view)
  }

  async getProfile(client: AccountClientMetadata, lease: AccountObservationLease): Promise<AccountProfileOutcome> {
    this.assertObservation(lease, 'getProfile')
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const outcome = await account.getProfile({ ...client })
    this.assertObservation(lease, 'getProfile')
    if (outcome === null) return null
    const value = outcome as { status?: unknown; value?: unknown }
    if (value.status !== 'ready') return { status: 'failed' }
    return { status: 'ready', value: accountProfileOf(value.value) }
  }

  async getBalance(client: AccountClientMetadata, lease: AccountObservationLease): Promise<AccountBalanceOutcome> {
    this.assertObservation(lease, 'getBalance')
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const outcome = await account.getBalance({ ...client })
    this.assertObservation(lease, 'getBalance')
    if (outcome === null) return null
    const value = outcome as { status?: unknown; value?: unknown; bonusWallets?: unknown }
    if (value.status !== 'ready') return { status: 'failed' }
    return {
      status: 'ready',
      value: walletListOf(value.value),
      bonusWallets: walletListOf(value.bonusWallets),
    }
  }

  watch(signal: AbortSignal): AsyncIterable<AccountWatchEvent> {
    const owner = this
    return (async function* directAccountWatch(): AsyncGenerator<AccountWatchEvent> {
      const lease = {}
      const watchEpoch = owner.observationEpoch
      const account = owner.account()
      if (account === undefined) {
        owner.invalidateObservations()
        yield { kind: 'invalidated', reason: 'service-unavailable' }
        return
      }
      const revokeWatchLease = (): void => {
        const record = owner.observationLeases.get(lease)
        if (record !== undefined) record.active = false
      }
      const invalidateOwner = (): void => {
        owner.invalidateObservations()
        revokeWatchLease()
      }
      let resolveServiceChanged!: () => void
      const serviceChanged = new Promise<void>(resolve => { resolveServiceChanged = resolve })
      const onServiceChanged = (): void => { resolveServiceChanged() }
      owner.serviceInvalidationListeners.add(onServiceChanged)
      if (owner.observationEpoch !== watchEpoch) resolveServiceChanged()
      try {
        const source = account.watch(signal)
        const iterator = source[Symbol.asyncIterator]()
        try {
          while (!signal.aborted) {
            const nextResult = iterator.next().then(
              result => ({ kind: 'next' as const, result }),
              error => ({ kind: 'error' as const, error }),
            )
            const winner = await Promise.race([
              nextResult,
              serviceChanged.then(() => ({ kind: 'service-changed' as const })),
            ])
            if (winner.kind === 'service-changed') {
              revokeWatchLease()
              yield { kind: 'invalidated', reason: 'service-changed' }
              return
            }
            if (winner.kind === 'error') throw winner.error
            if (owner.observationEpoch !== watchEpoch) {
              revokeWatchLease()
              yield { kind: 'invalidated', reason: 'service-changed' }
              return
            }
            if (winner.result.done === true) {
              invalidateOwner()
              if (!signal.aborted) yield { kind: 'invalidated', reason: 'watch-ended' }
              return
            }
            if (signal.aborted) return
            yield { kind: 'current', observation: owner.observe(accountViewOf(accountUpdateStateOf(winner.result.value)), lease) }
          }
        } finally {
          await iterator.return?.(undefined)
        }
      } catch {
        if (!signal.aborted) {
          invalidateOwner()
          yield { kind: 'invalidated', reason: 'watch-failed' }
        }
      } finally {
        owner.serviceInvalidationListeners.delete(onServiceChanged)
        revokeWatchLease()
      }
    })()
  }

  getCallbackOrigin(): string | undefined {
    const webServer = this.ctx.get('webServer') as WebServerServiceLike | undefined
    if (webServer === undefined) return undefined
    let origin: string
    try {
      origin = webServer.getOrigin()
    } catch {
      // Not bound (or not URL-expressible): the capability is unavailable.
      return undefined
    }
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      return undefined
    }
    // The account callback contract is a browser-accessible LOOPBACK HTTP
    // origin without a path/query/fragment. Anything else is refused rather
    // than forwarded to the Host.
    if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    if (!isLoopbackUrlHost(url.hostname)) return undefined
    return url.origin
  }

  async startSignIn(client: AccountClientMetadata, lease: AccountObservationLease): Promise<AccountObservation> {
    this.assertObservation(lease, 'startSignIn')
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const callbackOrigin = this.getCallbackOrigin()
    if (callbackOrigin === undefined) throw new Error('the Host browser callback listener is unavailable')
    // `web` is the only login source a TUI may present (never Desktop).
    const view = accountViewOf(await account.startSignIn({ ...client }, callbackOrigin, 'web'))
    this.assertObservation(lease, 'startSignIn')
    return { view, lease }
  }

  async cancelSignIn(id: string, lease: AccountObservationLease): Promise<AccountObservation> {
    this.assertObservation(lease, 'cancelSignIn')
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const view = accountViewOf(await account.cancelSignIn(id))
    this.assertObservation(lease, 'cancelSignIn')
    return { view, lease }
  }

  async signOut(client: AccountClientMetadata, lease: AccountObservationLease): Promise<AccountObservation> {
    this.assertObservation(lease, 'signOut')
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const view = accountViewOf(await account.signOut({ ...client }))
    this.assertObservation(lease, 'signOut')
    return { view, lease }
  }

  async hasRunningAccountTasks(lease: AccountObservationLease): Promise<boolean> {
    this.assertObservation(lease, 'hasRunningAccountTasks')
    // Mirrors the official `isRunningAccountTask` predicate: a running Agent
    // whose latest bound request used the account provider. The Host's own
    // signed-out listener remains the cancellation owner.
    const agents = this.ctx.get('agents') as { list(): readonly unknown[] } | undefined
    if (agents === undefined) throw new Error('Host Agent service unavailable')
    return agents.list().some(candidate => {
      const agent = candidate as {
        readonly status?: unknown
        readonly session?: { requestContext?(): unknown }
      }
      if (agent.status !== 'running') return false
      const context = agent.session?.requestContext?.()
      return typeof context === 'object' && context !== null
        && (context as { provider?: unknown }).provider === 'deepseek-account'
    })
  }
}

/** Whether one URL hostname is exactly the loopback authority the official
 *  `loginOrigin` accepts (a broader 127/8 address would be rejected by the
 *  provider, so the adapter must not advertise it). */
function isLoopbackUrlHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** The rc.2 `account/watch` frame envelope: every frame is
 *  `{type: 'snapshot' | 'credentials-changed', state}`. This is the external
 *  Host data boundary, so the published envelope is checked here and the
 *  payload is handed to `accountViewOf` as a plain detached copy. A
 *  `credentials-changed` frame is a fresh snapshot of the same view, never a
 *  sign-out: only the Host-approved view shape is forwarded. */
function accountUpdateStateOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    throw new Error('DeepSeek Account watch frame is not an AccountUpdate')
  }
  const update = value as { readonly type?: unknown; readonly state?: unknown }
  if (
    (update.type !== 'snapshot' && update.type !== 'credentials-changed')
    || typeof update.state !== 'object' || update.state === null
  ) {
    throw new Error('DeepSeek Account watch frame is not an AccountUpdate')
  }
  return update.state
}

/** A detached account state copy (no Host record is aliased). */
function accountViewOf(value: unknown): AccountView {
  const view = value as AccountView
  const attempt = view.attempt
  return {
    status: view.status,
    links: { usageUrl: view.links.usageUrl, topUpUrl: view.links.topUpUrl },
    attempt: attempt === null
      ? null
      : {
          id: attempt.id,
          phase: attempt.phase,
          ...(attempt.authorizeUrl === undefined ? {} : { authorizeUrl: attempt.authorizeUrl }),
          ...(attempt.expiresAt === undefined ? {} : { expiresAt: attempt.expiresAt }),
          ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
        },
  }
}

/** A detached profile copy. */
function accountProfileOf(value: unknown): AccountProfile {
  const profile = value as AccountProfile
  return {
    id: profile.id,
    name: profile.name,
    contact: profile.contact,
    ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
  }
}

/** A detached wallet list with the decimal strings retained verbatim. */
function walletListOf(value: unknown): readonly import('../config-port.ts').AccountWallet[] {
  if (!Array.isArray(value)) return []
  return value.map(entry => {
    const wallet = entry as { currency: string; balance: string }
    return { currency: wallet.currency, balance: wallet.balance }
  })
}

/** The Direct permission config (`ctx.permissionPresets` +
 * `ctx.settings` + the official command line for the apply). */
export class DirectPermissionConfig implements PermissionConfig {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => unknown | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  private settings(): SettingsServiceLike | undefined {
    return this.ctx.get('settings') as SettingsServiceLike | undefined
  }

  presetNames(): readonly string[] {
    const permission = this.ctx.get('permissionPresets') as PermissionPresetsServiceLike | undefined
    // Detached copy (the service's table is Host-owned).
    return [...(permission?.names ?? [])]
  }

  defaultPreset(): string | undefined {
    // Read authority is the owning service's effective value (0.1.7); the
    // Settings form remains the WRITE surface only.
    const permission = this.ctx.get('permissionPresets') as PermissionPresetsServiceLike | undefined
    try {
      return permission?.defaultPreset
    } catch {
      // A throwing service read degrades to "no persisted default".
      return undefined
    }
  }

  async setDefaultPreset(name: string): Promise<void> {
    const settings = this.settings()
    // A missing settings service is an EXPLICIT failure, never a silent no-op:
    // reporting success here would let the Settings UI claim a Verified write
    // that never reached the Host (same rule as this file's other writers).
    if (settings === undefined) throw new Error('settings service unavailable')
    await mutateSettings(settings, 'permission', [
      { op: 'set', path: ['defaultPreset'], value: name },
    ])
  }

  async applyPermissionPreset(
    sessionId: string,
    presetId: string,
    signal: AbortSignal,
  ): Promise<{ kind: 'applied' } | { kind: 'unavailable'; cause: 'commands' | 'permission' }> {
    const commands = this.ctx.get('commands') as CommandsServiceLike | undefined
    if (commands === undefined) return { kind: 'unavailable', cause: 'commands' }
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return { kind: 'unavailable', cause: 'permission' }
    // The preset id is validated against the composed table BEFORE it
    // reaches the official command line: an id the deployment does not
    // offer (or a hostile id with command-line metacharacters) is refused
    // as unavailable — it can never be interpolated into an arbitrary
    // /permission invocation.
    if (!this.presetNames().includes(presetId)) return { kind: 'unavailable', cause: 'permission' }
    const execution = await commands.execute(agent, `/permission ${presetId}`, [], signal)
    if (execution === undefined) return { kind: 'unavailable', cause: 'permission' }
    return { kind: 'applied' }
  }
}

/** The Direct preset-default config: the 0.1.7 registry's own
 * `defaultId` (deployment `default` merged with the volatile
 * `selectedDefault` user preference and the chooser policy) is the read
 * authority; the `agent-preset-registry` Settings form is the WRITE
 * surface for "future sessions" defaults. */
export class DirectPresetDefaultConfig implements PresetDefaultConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private settings(): SettingsServiceLike | undefined {
    return this.ctx.get('settings') as SettingsServiceLike | undefined
  }

  available(): boolean {
    return this.settings() !== undefined
  }

  get(): string | undefined {
    const presets = this.ctx.get('agentPresets') as AgentPresetsServiceLike | undefined
    try {
      return presets?.defaultId
    } catch {
      // A throwing registry read degrades to "no default known".
      return undefined
    }
  }

  async set(id: string): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    await mutateSettings(settings, 'agent-preset-registry', [
      { op: 'set', path: ['selectedDefault'], value: id },
    ])
  }
}

/** Official typed sections use the caller's captured Settings authority and CAS revision. */
async function mutateDirectSection(
  ctx: HostContextLike,
  namespace: string,
  ops: readonly SettingsMutationOp[],
  expectedRevision: number,
  generation: object,
): Promise<SectionMutationOutcome> {
  const settings = ctx.get('settings') as SettingsServiceLike | undefined
  if (settings === undefined || !Object.is(settingsAuthorityOf(settings), generation)) {
    return { kind: 'rejected', reason: 'the Host settings authority changed; refresh before saving' }
  }
  if (ops.length === 0) return { kind: 'rejected', reason: 'no settings fields were staged' }
  try {
    await settings.mutate(namespace, ops, expectedRevision)
    return { kind: 'accepted' }
  } catch (error) {
    const reason = safeErrorMessage(error)
    if ((error as { readonly code?: unknown } | null)?.code === 'SETTINGS_CONFLICT') {
      return { kind: 'conflict', reason }
    }
    // ConfigEditor can persist before Loader reconciliation throws. An unknown
    // dispatched failure therefore cannot prove the profile stayed unchanged.
    return { kind: 'outcome-unconfirmed', reason }
  }
}

export class DirectSubagentLimitsConfig implements SubagentLimitsConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): SectionRead<SubagentLimits> {
    return readDirectSection(this.ctx, 'subagent', projectSubagentLimits)
  }

  async refresh(): Promise<void> {}

  async mutate(
    patch: SectionPatch<SubagentLimits>,
    expectedRevision: number,
    generation: object,
  ): Promise<SectionMutationOutcome> {
    const ops: SettingsMutationOp[] = []
    for (const field of ['maxDepth', 'maxActiveSubagents'] as const) {
      const edit = patch[field]
      if (edit === undefined) continue
      ops.push(edit.kind === 'reset'
        ? { op: 'unset', path: [field] }
        : { op: 'set', path: [field], value: edit.value })
    }
    return mutateDirectSection(this.ctx, 'subagent', ops, expectedRevision, generation)
  }
}

/** The official model-selection section is sampled by new top-level Sessions. */
export class DirectSubagentModelSelectionConfig implements SubagentModelSelectionConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): SectionRead<SubagentModelSelection> {
    return readDirectSection(this.ctx, 'subagent-model-selection-settings', projectSubagentModelSelection)
  }

  async refresh(): Promise<void> {}

  async mutate(
    patch: SectionPatch<SubagentModelSelection>,
    expectedRevision: number,
    generation: object,
  ): Promise<SectionMutationOutcome> {
    const ops: SettingsMutationOp[] = []
    if (patch.enabled !== undefined) {
      ops.push(patch.enabled.kind === 'reset'
        ? { op: 'unset', path: ['enabled'] }
        : { op: 'set', path: ['enabled'], value: patch.enabled.value })
    }
    if (patch.allowedModels !== undefined) {
      ops.push(patch.allowedModels.kind === 'reset'
        ? { op: 'unset', path: ['allowedModels'] }
        : { op: 'set', path: ['allowedModels'], value: patch.allowedModels.value.map(route => ({ ...route })) })
    }
    return mutateDirectSection(this.ctx, 'subagent-model-selection-settings', ops, expectedRevision, generation)
  }
}

/** The official Agent-loop scheduling section (`agent-loop`). */
const AGENT_LOOP_NS = 'agent-loop'
/** The official DeepSeek session-log contribution section. */
const SESSION_LOG_UPLOAD_NS = 'session-log-deepseek'

export class DirectAgentLoopSettingsConfig implements AgentLoopSettingsConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): SectionRead<AgentLoopSettings> {
    return readDirectSection(this.ctx, AGENT_LOOP_NS, projectAgentLoopSettings)
  }

  async refresh(): Promise<void> {}

  async mutate(
    patch: SectionPatch<AgentLoopSettings>,
    expectedRevision: number,
    generation: object,
  ): Promise<SectionMutationOutcome> {
    const ops: SettingsMutationOp[] = []
    if (patch.maxParallelToolCalls !== undefined) {
      ops.push(patch.maxParallelToolCalls.kind === 'reset'
        ? { op: 'unset', path: ['maxParallelToolCalls'] }
        : { op: 'set', path: ['maxParallelToolCalls'], value: patch.maxParallelToolCalls.value })
    }
    return mutateDirectSection(this.ctx, AGENT_LOOP_NS, ops, expectedRevision, generation)
  }
}

/** The two numeric caps of the Host-served model-tool shell executor. The
 *  namespace follows the official dsh-web served-bound rule (`pwsh` preferred),
 *  never the Client OS; no served row is unavailable. */
export class DirectShellExecutionSettingsConfig implements ShellExecutionSettingsConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): SectionRead<ShellExecutionSettings> {
    return readDirectShellExecutionSection(this.ctx)
  }

  async refresh(): Promise<void> {}

  async mutate(
    patch: SectionPatch<ShellExecutionSettings>,
    expectedRevision: number,
    generation: object,
    expectedExecutor: HostShellExecutor,
  ): Promise<SectionMutationOutcome> {
    if (patch.executor !== undefined) {
      return { kind: 'rejected', reason: 'the Host shell executor identity is a Host observation, not an editable setting' }
    }
    // Re-resolve the served-bound row at dispatch: a profile change between
    // the page's read and Save must not write the other namespace.
    const current = readDirectShellExecutionSection(this.ctx)
    if (current.kind !== 'ready') {
      return { kind: 'rejected', reason: current.reason }
    }
    if (current.effective.executor !== expectedExecutor) {
      return { kind: 'rejected', reason: 'the Host served shell row changed; refresh before saving' }
    }
    const namespace = SHELL_EXECUTOR_ROWS.find(row => row.executor === current.effective.executor)!.namespace
    const ops: SettingsMutationOp[] = []
    for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
      const edit = patch[field]
      if (edit === undefined) continue
      ops.push(edit.kind === 'reset'
        ? { op: 'unset', path: [field] }
        : { op: 'set', path: [field], value: edit.value })
    }
    return mutateDirectSection(this.ctx, namespace, ops, expectedRevision, generation)
  }
}

export class DirectSessionLogUploadConfig implements SessionLogUploadConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): SectionRead<SessionLogUpload> {
    return readDirectSection(this.ctx, SESSION_LOG_UPLOAD_NS, projectSessionLogUpload)
  }

  async refresh(): Promise<void> {}

  async mutate(
    patch: SectionPatch<SessionLogUpload>,
    expectedRevision: number,
    generation: object,
  ): Promise<SectionMutationOutcome> {
    const ops: SettingsMutationOp[] = []
    if (patch.enabled !== undefined) {
      ops.push(patch.enabled.kind === 'reset'
        ? { op: 'unset', path: ['enabled'] }
        : { op: 'set', path: ['enabled'], value: patch.enabled.value })
    }
    return mutateDirectSection(this.ctx, SESSION_LOG_UPLOAD_NS, ops, expectedRevision, generation)
  }
}

/** The OFFICIAL settings section ids the Web provider config addresses. Both
 *  are row ids of the shipped `dsh-base` composition; the adapter owns this
 *  schema knowledge so no consumer ever names a namespace or path. */
const WEB_PROVIDER_NS = 'web'
const WEB_SEARCH_API_NS = 'web-deepseek-api'
/** The credential reference the official DeepSeek web providers resolve
 *  (`apiKeyEnv`'s shipped default); the TUI never writes a literal key. */
const WEB_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** The Direct Web provider config (`ctx.settings` + `ctx.credentials`): the
 *  official `web` / `web-deepseek-api` sections behind the semantic
 *  `WebProviderConfig` sub-domain. The Host owns the values and the live
 *  selection; this adapter only reads them and routes revision-checked writes
 *  to the exact official paths. */
export class DirectWebProviderConfig implements WebProviderConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private settings(): SettingsServiceLike | undefined {
    return this.ctx.get('settings') as SettingsServiceLike | undefined
  }

  private credentials(): CredentialsServiceLike | undefined {
    return this.ctx.get('credentials') as CredentialsServiceLike | undefined
  }

  available(): boolean {
    const settings = this.settings()
    if (settings === undefined) return false
    // Availability is EXACTLY the authority `read()` needs: both official
    // sections. A half-mounted configuration has no readable Web settings, so
    // the UI must present it as unavailable instead of offering writes against
    // facts it cannot read.
    return readSettingsDescriptor(settings, WEB_PROVIDER_NS) !== undefined
      && readSettingsDescriptor(settings, WEB_SEARCH_API_NS) !== undefined
  }

  async read(): Promise<WebProviderSettings | undefined> {
    const settings = this.settings()
    if (settings === undefined) return undefined
    // Both official descriptors must be readable form projections: a missing
    // or malformed one is UNAVAILABLE, never a defaulted value. The `web`
    // descriptor is read ONCE: its `value`, `base` and `user` are the same
    // snapshot, so the layering facts can never be stitched from mismatched
    // reads.
    const providerDescriptor = readSettingsDescriptor(settings, WEB_PROVIDER_NS)
    const provider = formValueOf(providerDescriptor)
    const api = formValueOf(readSettingsDescriptor(settings, WEB_SEARCH_API_NS))
    if (provider === undefined || api === undefined) return undefined
    // `base`/`user` are official projections (always objects when the section
    // is readable). A missing/non-object layer is UNAVAILABLE — never "there is
    // no USER override".
    const providerSelection = webProviderSelectionFrom(providerDescriptor)
    if (providerSelection === undefined) return undefined
    // There is NO single `baseURL` requirement: an unset Search/Fetch endpoint
    // keeps the read ready (the Host selects the actual provider at request
    // time). A missing/foreign billing value, though, is UNAVAILABLE — never a
    // silent `auto`.
    const searchBilling = readWebApiBilling(api, 'searchBilling')
    const fetchBilling = readWebApiBilling(api, 'fetchBilling')
    const count = api.count
    const sendOriginalQuestion = api.sendOriginalQuestion
    if (searchBilling === undefined || fetchBilling === undefined) return undefined
    if (typeof count !== 'number' || !Number.isInteger(count)) return undefined
    if (typeof sendOriginalQuestion !== 'boolean') return undefined
    return {
      searchProvider: optionalId(provider.searchProvider),
      fetchProvider: optionalId(provider.fetchProvider),
      providerSelection,
      api: { searchBilling, fetchBilling, count, sendOriginalQuestion },
      advanced: webApiAdvancedFactsOf(api),
      credential: await this.credentialFact(),
    }
  }

  /** Presence/source of the official reference (never the value). An unmounted
   *  credential store is `configured: false` — the same answer the Direct
   *  `/login` port gives, and the UI's own guidance names the command. */
  private async credentialFact(): Promise<WebProviderSettings['credential']> {
    const credentials = this.credentials()
    if (credentials === undefined) return { configured: false }
    const info = await credentials.describe(WEB_API_KEY_REF as CredentialRef)
    return {
      configured: info.configured === true,
      ...(typeof info.source === 'string' && info.source !== '' ? { source: info.source } : {}),
    }
  }

  async setSearchProvider(id: 'deepseek-official' | 'deepseek-search-api'): Promise<void> {
    assertSearchProviderId(id)
    await this.mutate('web', [{ op: 'set', path: ['searchProvider'], value: id }], descriptor => {
      const current = formValueOf(descriptor)
      if (current === undefined) throw new Error('the official Host Web settings section is unreadable')
      assertSearchProviderReplaceable(current.searchProvider)
    })
  }

  async setFetchProvider(id: 'http' | 'deepseek-fetch-api'): Promise<void> {
    assertFetchProviderId(id)
    await this.mutate('web', [{ op: 'set', path: ['fetchProvider'], value: id }], descriptor => {
      const current = formValueOf(descriptor)
      if (current === undefined) throw new Error('the official Host Web settings section is unreadable')
      assertFetchProviderReplaceable(current.fetchProvider)
    })
  }

  async setSearchApiCount(count: number): Promise<void> {
    assertSearchApiCount(count)
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['count'], value: count }])
  }

  async setSendOriginalQuestion(enabled: boolean): Promise<void> {
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['sendOriginalQuestion'], value: enabled }])
  }

  async setSearchBilling(mode: 'auto' | 'account' | 'api-key'): Promise<void> {
    assertWebApiBilling(mode)
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['searchBilling'], value: mode }])
  }

  async setFetchBilling(mode: 'auto' | 'account' | 'api-key'): Promise<void> {
    assertWebApiBilling(mode)
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['fetchBilling'], value: mode }])
  }

  async restoreSearchProvider(): Promise<void> {
    await this.restoreProvider('searchProvider')
  }

  async restoreFetchProvider(): Promise<void> {
    await this.restoreProvider('fetchProvider')
  }

  /** The ONE official USER-layer reset of one provider selection: a single
   *  `unset` path op at the descriptor revision the reset decision read. A
   *  readable section whose USER layer does not own the field is a real no-op
   *  (there is nothing to remove); an unreadable `base`/`user` layer is an
   *  error, never an assumed "no override". This deliberately does NOT consult
   *  the effective value: a custom route is a reason to refuse an explicit SET,
   *  never a reason to hide an official reset of the USER layer. */
  private async restoreProvider(field: 'searchProvider' | 'fetchProvider'): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    const descriptor = readSettingsDescriptor(settings, WEB_PROVIDER_NS)
    if (descriptor === undefined) {
      throw new Error(`the official Host settings section "${WEB_PROVIDER_NS}" is not mounted`)
    }
    const user = plainRecordOf(descriptor.user)
    const base = plainRecordOf(descriptor.base)
    if (user === undefined || base === undefined) {
      throw new Error('the official Host Web settings section does not report its USER/base layers')
    }
    if (!Object.hasOwn(user, field)) return
    await settings.mutate(WEB_PROVIDER_NS, [{ op: 'unset', path: [field] }], descriptor.revision)
  }

  /** One revision-checked official settings mutation. The section must be a
   *  real configured entry: an unmounted section is an explicit failure rather
   *  than a write against an invented namespace. */
  private async mutate(
    ns: typeof WEB_PROVIDER_NS | typeof WEB_SEARCH_API_NS,
    ops: readonly SettingsMutationOp[],
    validate?: (descriptor: SettingsDescriptorLike) => void,
  ): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    const descriptor = readSettingsDescriptor(settings, ns)
    if (descriptor === undefined) {
      throw new Error(`the official Host settings section "${ns}" is not mounted`)
    }
    validate?.(descriptor)
    // This descriptor both validates the provider choice and supplies the CAS
    // token; never reread a newer revision after making that decision.
    await settings.mutate(ns, ops, descriptor.revision)
  }
}

/** The form-projected value of one settings descriptor (volatile fields only),
 *  or `undefined` when the descriptor or its value is unusable. */
function formValueOf(descriptor: SettingsDescriptorLike | undefined): Record<string, unknown> | undefined {
  return plainRecordOf(descriptor?.value)
}

/** One detached plain record, or `undefined` for a non-object value. */
function plainRecordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** The SAME `web` descriptor's per-capability layering facts, or `undefined`
 *  when either the `base` or the `user` projection is unreadable. */
function webProviderSelectionFrom(
  descriptor: SettingsDescriptorLike | undefined,
): WebProviderSettings['providerSelection'] | undefined {
  const search = webProviderSelectionFactsOf(descriptor?.base, descriptor?.user, 'searchProvider')
  const fetch = webProviderSelectionFactsOf(descriptor?.base, descriptor?.user, 'fetchProvider')
  if (search === undefined || fetch === undefined) return undefined
  return { search, fetch }
}

/** A configured provider id, or `undefined` for an absent/empty selection. */
function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The official profile entry id of the Host row that owns the built-in
 *  visual tools (its Loader row id is also its Settings namespace). */
const VISUAL_TOOLS_NS = 'pi-tui-visual-tools'

/**
 * The Direct visual-tools switch: the `pi-tui-visual-tools` form section's
 * effective `enabled` value plus the owning Host row's live registration
 * status. The write is a revision-checked path mutation of the exact
 * `enabled` field — never a whole-section replace, so an unrelated or
 * unknown field is never pinned into the USER layer.
 *
 * The status service is the row's own fact, not a second enable state: a
 * Remote backend has no equivalent wire and reports `applied: undefined`
 * instead of inferring success from the committed configuration.
 */
class DirectVisualToolsConfig implements VisualToolsConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): VisualToolsState | undefined {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    const descriptor = readSettingsDescriptor(settings, VISUAL_TOOLS_NS)
    if (descriptor === undefined) return undefined
    const value = formValueOf(descriptor)
    const enabled = value?.enabled
    // A missing or non-boolean effective value is NOT the schema default:
    // report the section as unreadable instead of inventing `true`.
    if (typeof enabled !== 'boolean') return undefined
    const revision = descriptor.revision
    // Without the read revision the decision cannot be submitted conditionally;
    // report the section unreadable rather than allowing a silent overwrite.
    if (typeof revision !== 'number') return undefined
    const user = descriptor.user
    const userSection = typeof user === 'object' && user !== null && !Array.isArray(user)
      ? user as Record<string, unknown>
      : undefined
    const status = this.ctx.get(VISUAL_TOOLS_STATUS_SERVICE) as VisualToolsRuntimeStatus | undefined
    const applied = status === undefined || typeof status.applied !== 'function'
      ? undefined
      : status.applied()
    return {
      enabled,
      revision,
      userOverridden: userSection?.enabled !== undefined,
      applied,
    }
  }

  async setEnabled(enabled: boolean, expectedRevision: number): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) throw new Error('the Host settings service is unavailable')
    if (readSettingsDescriptor(settings, VISUAL_TOOLS_NS) === undefined) {
      throw new Error(`the "pi-tui-visual-tools" Host settings section is not mounted`)
    }
    // Submit the revision the USER's decision was read at — never a revision
    // observed at write time, which would turn an external edit into a silent
    // overwrite.
    await mutateSettings(settings, VISUAL_TOOLS_NS, [
      { op: 'set', path: ['enabled'], value: enabled },
    ], expectedRevision)
  }
}

/** The official profile entry id of the Host row that owns the Web startup
 *  preference (its Loader row id is also its Settings namespace). */
const WEB_STARTUP_PREFERENCE_NS = 'pi-tui-web-preferences'

/**
 * The Direct Web startup preference: the `pi-tui-web-preferences` form
 * section's effective `autoStart` value. The write is a revision-checked path
 * mutation of the exact `autoStart` field — never a whole-section replace, so
 * an unrelated or unknown field is never pinned into the USER layer.
 *
 * It deliberately does NOT read or touch the private `piTuiWebAccess` service:
 * the preference is the NEXT Host launch's behavior, and the current Host's
 * Web state stays that service's sole authority.
 */
class DirectWebStartupPreferenceConfig implements WebStartupPreferenceConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): WebStartupPreferenceState | undefined {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    const descriptor = readSettingsDescriptor(settings, WEB_STARTUP_PREFERENCE_NS)
    if (descriptor === undefined) return undefined
    const value = formValueOf(descriptor)
    const autoStart = value?.autoStart
    // A missing or non-boolean effective value is NOT the schema default:
    // report the section as unreadable instead of inventing `false`.
    if (typeof autoStart !== 'boolean') return undefined
    const revision = descriptor.revision
    // Without the read revision the decision cannot be submitted conditionally;
    // report the section unreadable rather than allowing a silent overwrite.
    if (typeof revision !== 'number') return undefined
    const user = descriptor.user
    const userSection = typeof user === 'object' && user !== null && !Array.isArray(user)
      ? user as Record<string, unknown>
      : undefined
    return {
      autoStart,
      revision,
      userOverridden: userSection?.autoStart !== undefined,
    }
  }

  async setAutoStart(value: boolean, expectedRevision: number): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) throw new Error('the Host settings service is unavailable')
    if (readSettingsDescriptor(settings, WEB_STARTUP_PREFERENCE_NS) === undefined) {
      throw new Error(`the "pi-tui-web-preferences" Host settings section is not mounted`)
    }
    // Submit the revision the USER's decision was read at — never a revision
    // observed at write time, which would turn an external edit into a silent
    // overwrite.
    await mutateSettings(settings, WEB_STARTUP_PREFERENCE_NS, [
      { op: 'set', path: ['autoStart'], value },
    ], expectedRevision)
  }
}

/** The official profile entry id of the Host row that owns the startup backend
 *  selection (its Loader row id is also its Settings namespace). */
const TUI_STARTUP_NS = 'tui-startup'

/**
 * The Direct startup backend preference: the `tui-startup` form section's
 * effective `backend` value. The write is a revision-checked path mutation of
 * the exact `backend` field — never a whole-section replace, so an unrelated or
 * unknown field is never pinned into the USER layer.
 *
 * FAIL-CLOSED: an effective `backend` value outside `direct|daemon` is NOT a
 * read — `read()` returns `undefined` rather than mapping it to `direct`, so an
 * illegal Profile value without an environment override fails closed in the
 * launcher and the Settings row reports it as unreadable.
 */
class DirectBackendStartupPreferenceConfig implements BackendStartupPreferenceConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): BackendStartupPreferenceState | undefined {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    const descriptor = readSettingsDescriptor(settings, TUI_STARTUP_NS)
    if (descriptor === undefined) return undefined
    const value = formValueOf(descriptor)
    const backend = value?.backend
    if (!isPublicBackendValue(backend)) return undefined
    const revision = descriptor.revision
    if (typeof revision !== 'number') return undefined
    const user = descriptor.user
    const userSection = typeof user === 'object' && user !== null && !Array.isArray(user)
      ? user as Record<string, unknown>
      : undefined
    return { backend, revision, userOverridden: userSection?.backend !== undefined }
  }

  async setBackend(value: PublicBackendValue, expectedRevision: number): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) throw new Error('the Host settings service is unavailable')
    if (readSettingsDescriptor(settings, TUI_STARTUP_NS) === undefined) {
      throw new Error('the "tui-startup" Host settings section is not mounted')
    }
    await mutateSettings(settings, TUI_STARTUP_NS, [
      { op: 'set', path: ['backend'], value },
    ], expectedRevision)
  }
}

/** The typed guard for the closed public backend vocabulary. */
function isPublicBackendValue(value: unknown): value is PublicBackendValue {
  return value === 'direct' || value === 'daemon'
}

/** The official profile entry id of the Host row that owns the ACP startup
 *  preference (its Loader row id is also its Settings namespace). */
const ACP_STARTUP_PREFERENCE_NS = 'pi-tui-acp-preferences'

/**
 * The Direct ACP startup preference: the `pi-tui-acp-preferences` form
 * section's effective `autoStart` value. The write is a revision-checked path
 * mutation of the exact `autoStart` field — never a whole-section replace, so an
 * unrelated or unknown field is never pinned into the USER layer.
 *
 * It deliberately does NOT read or touch the private `piTuiAcpAccess` service:
 * the preference is the NEXT Host launch's behavior, and the current Host's
 * listener state stays that service's sole authority.
 */
class DirectAcpStartupPreferenceConfig implements AcpStartupPreferenceConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  read(): AcpStartupPreferenceState | undefined {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    const descriptor = readSettingsDescriptor(settings, ACP_STARTUP_PREFERENCE_NS)
    if (descriptor === undefined) return undefined
    const value = formValueOf(descriptor)
    const autoStart = value?.autoStart
    if (typeof autoStart !== 'boolean') return undefined
    const revision = descriptor.revision
    if (typeof revision !== 'number') return undefined
    const user = descriptor.user
    const userSection = typeof user === 'object' && user !== null && !Array.isArray(user)
      ? user as Record<string, unknown>
      : undefined
    return { autoStart, revision, userOverridden: userSection?.autoStart !== undefined }
  }

  async setAutoStart(value: boolean, expectedRevision: number): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) throw new Error('the Host settings service is unavailable')
    if (readSettingsDescriptor(settings, ACP_STARTUP_PREFERENCE_NS) === undefined) {
      throw new Error(`the "pi-tui-acp-preferences" Host settings section is not mounted`)
    }
    await mutateSettings(settings, ACP_STARTUP_PREFERENCE_NS, [
      { op: 'set', path: ['autoStart'], value },
    ], expectedRevision)
  }
}


/** The `servers` map of one descriptor layer (own keys), or undefined. */
function plainServersOf(layer: unknown): Record<string, unknown> | undefined {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return undefined
  const servers = (layer as { servers?: unknown }).servers
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? servers as Record<string, unknown>
    : undefined
}

/** The official settings namespace the shared Host MCP manager owns. */
const MCP_SERVER_SOURCES_NS = 'mcp-manager'

/** Whether one detached value equals the `set` value of the same path (the
 *  read-back proof that an op really is in force). */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]))
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftKeys = Object.keys(left)
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every(key => Object.hasOwn(right, key)
        && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
  }
  return false
}

/** Read one path off a detached value (own keys only). */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/**
 * Whether every op of a committed batch is in force in the read-back. A `set`
 * must show its value; an `unset` must show the ABSENCE it asked for — either
 * the whole entry is gone (a User-added Delete) or the specific key/field is
 * absent (a per-key patch or a reset that restored the base value into a
 * different shape). An `unset` that merely happens to leave the entry present
 * is NOT proof, so it can never make the batch look committed.
 */
function opsHold(read: McpServerConfiguration, ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[]): boolean {
  if (read.kind !== 'ready') return false
  const entries = new Map(read.entries.map(entry => [entry.name, entry]))
  for (const op of ops) {
    const name = op.path[1]
    if (name === undefined) return false
    const entry = entries.get(name)
    if (op.op === 'unset') {
      // `unset ['servers', name]`: the entry must be GONE from the effective
      // configuration (a Reset keeps it only when the base still provides it,
      // which the read-back reports as a present entry — so a Reset is proven
      // by its `set`-free shape only when the entry disappeared, and otherwise
      // the batch is not proven and the outcome stays unconfirmed).
      if (op.path.length === 2) {
        if (entry !== undefined) return false
        continue
      }
      if (entry === undefined) return false
      if (valueAt(entry.effective, op.path.slice(2)) !== undefined) return false
      continue
    }
    if (entry === undefined) return false
    const relative = op.path.slice(2)
    if (relative.length === 0) continue
    if (!sameJson(valueAt(entry.effective, relative), op.value)) return false
  }
  return true
}

/** Whether the read-back proves the batch did NOT take effect (the revision
 *  never moved AND no `set` value is in force). */
function opsRejected(read: McpServerConfiguration, expectedRevision: number, ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[]): boolean {
  if (read.kind !== 'ready') return false
  if (read.revision !== expectedRevision) return false
  return !opsHold(read, ops)
}

/**
 * The Direct MCP configuration-source read. It projects the EFFECTIVE
 * `mcp-manager.servers` key set from the official Host settings descriptor —
 * the only evidence of which manager entries the configuration holds. It
 * exposes no entry, transport, credential or secret, and it never writes.
 */
export class DirectMcpServerSourcesConfig implements McpServerSourcesConfig {
  private readonly ctx: HostContextLike
  private readonly generation: () => object
  /** A stable fallback identity for a composition that never wires the MCP
   *  manager generation: it can never match a real roster generation, so a
   *  consumer honestly reports Unknown instead of mixing authorities. */
  private readonly unwiredGeneration = Object.freeze({})

  constructor(ctx: HostContextLike, generation?: () => object) {
    this.ctx = ctx
    this.generation = generation ?? (() => this.unwiredGeneration)
  }

  read(): McpServerSources {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) {
      return { kind: 'unavailable', reason: 'the Host settings service is unavailable' }
    }
    const descriptor = readSettingsDescriptor(settings, MCP_SERVER_SOURCES_NS)
    if (descriptor === undefined) {
      return {
        kind: 'unavailable',
        reason: 'the "mcp-manager" Host settings section is not mounted',
      }
    }
    const value = descriptor.value
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { kind: 'unavailable', reason: 'the "mcp-manager" settings section is not readable' }
    }
    const servers = (value as Record<string, unknown>).servers
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      return { kind: 'unavailable', reason: 'the "mcp-manager.servers" configuration is not readable' }
    }
    const configuredNames = Object.freeze(Object.keys(servers as Record<string, unknown>))
    return {
      kind: 'ready',
      configuredNames,
      generation: this.generation(),
      ...descriptor.revision === undefined ? {} : { revision: descriptor.revision },
    }
  }

  /** Direct reads the in-process Host authority, so a read is already current. */
  async refresh(): Promise<void> {}
}

/**
 * The Direct FR4 MCP server configuration read/write. It reads the official
 * `mcp-manager` descriptor's value/base/user layers in ONE `describe()` and
 * classifies every entry's provenance from that same descriptor; every write
 * is ONE official `settings.mutate('mcp-manager', ops, expectedRevision)`
 * call. The write never touches `TuiSettingsDoc` and never writes a file.
 */
export class DirectMcpServerConfigurationConfig implements McpServerConfigurationConfig {
  private readonly ctx: HostContextLike
  private readonly generation: () => object
  private readonly unwiredGeneration = Object.freeze({})

  constructor(ctx: HostContextLike, generation?: () => object) {
    this.ctx = ctx
    this.generation = generation ?? (() => this.unwiredGeneration)
  }

  read(): McpServerConfiguration {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) {
      return { kind: 'unavailable', reason: 'the Host settings service is unavailable' }
    }
    let descriptor: SettingsDescriptorLike | undefined
    try {
      descriptor = readSettingsDescriptor(settings, MCP_SERVER_SOURCES_NS)
    } catch {
      descriptor = undefined
    }
    if (descriptor === undefined) {
      return { kind: 'unavailable', reason: 'the "mcp-manager" Host settings section is not mounted' }
    }
    const value = descriptor.value
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { kind: 'unavailable', reason: 'the "mcp-manager" settings section is not readable' }
    }
    const servers = (value as Record<string, unknown>).servers
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      return { kind: 'unavailable', reason: 'the "mcp-manager.servers" configuration is not readable' }
    }
    if (typeof descriptor.revision !== 'number') {
      return { kind: 'unavailable', reason: 'the "mcp-manager" settings revision is not readable' }
    }
    // ONE descriptor, projected detached: base/user/effective all belong to
    // the same read; a name that appears in neither layer of THIS descriptor
    // is not config-owned and is simply absent from the entries.
    const entries: McpClassifiedServerEntry[] = []
    const baseServers = plainServersOf(descriptor.base)
    for (const name of Object.keys(servers as Record<string, unknown>)) {
      const provenance = classifyMcpServerProvenance(descriptor.base, { servers }, name)
      if (provenance === undefined) continue
      const effective = projectMcpServerEntry(detachedSection((servers as Record<string, unknown>)[name]))
      if (effective === undefined) continue
      const baseKeys = baseDictKeysOf(baseServers?.[name])
      entries.push({ name, provenance, effective, ...baseKeys === undefined ? {} : { baseKeys } })
    }
    return {
      kind: 'ready',
      generation: this.generation(),
      revision: descriptor.revision,
      entries: Object.freeze(entries),
    }
  }

  /** Direct reads the in-process Host authority, so a read is already current. */
  async refresh(): Promise<void> {}

  async mutate(
    ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[],
    expectedRevision: number,
    pinnedGeneration: object,
  ): Promise<McpConfigWriteOutcome> {
    // The Host-generation fence: a decision taken against another generation
    // is never dispatched against the current one.
    if (!Object.is(this.generation(), pinnedGeneration)) {
      return {
        kind: 'failed',
        failure: { kind: 'rejected', reason: 'the Host authority changed; re-read the configuration before saving' },
      }
    }
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (settings === undefined) {
      return { kind: 'failed', failure: { kind: 'rejected', reason: 'the Host settings service is unavailable' } }
    }
    const wireOps: readonly SettingsMutationOp[] = ops.map(op => op.op === 'set'
      ? { op: 'set' as const, path: [...op.path], value: op.value }
      : { op: 'unset' as const, path: [...op.path] })
    try {
      await settings.mutate(MCP_SERVER_SOURCES_NS, wireOps, expectedRevision)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      const message = safeErrorMessage(error)
      if (code === 'SETTINGS_CONFLICT') {
        // The official CAS refusal is its own outcome: the draft survives and
        // the user re-reads instead of the write being reported as a rejection.
        return { kind: 'failed', failure: { kind: 'conflict', reason: message } }
      }
      // The official `ConfigEditor.edit` PERSISTS the profile patch and only
      // then reconciles the Loader, so a throw from `settings.mutate` does NOT
      // prove the write was refused — the entry may already be on disk. The
      // read-back is the only honest classifier: if the caller's op is now in
      // force the write COMMITTED (report `saved`), if it is provably absent
      // the Host refused it, and anything else is unobservable.
      const observed = this.read()
      if (observed.kind === 'ready' && Object.is(this.generation(), pinnedGeneration)) {
        if (opsHold(observed, ops)) return { kind: 'saved', revision: observed.revision }
        if (opsRejected(observed, expectedRevision, ops)) {
          return { kind: 'failed', failure: { kind: 'rejected', reason: message } }
        }
      }
      return { kind: 'failed', failure: { kind: 'outcome-unconfirmed', reason: message } }
    }
    // Saved is a READ-BACK fact from the SAME Host authority: re-read the
    // descriptor and report the committed revision only when it is still
    // readable AND the generation the caller pinned is still current. A Host
    // replacement during the write makes the outcome unobservable here, never
    // a `saved` claim about another authority's namespace.
    const readBack = this.read()
    if (readBack.kind !== 'ready') {
      return {
        kind: 'failed',
        failure: { kind: 'outcome-unconfirmed', reason: readBack.reason },
      }
    }
    if (!Object.is(this.generation(), pinnedGeneration)) {
      return {
        kind: 'failed',
        failure: { kind: 'outcome-unconfirmed', reason: 'the Host authority changed while the write settled' },
      }
    }
    return { kind: 'saved', revision: readBack.revision }
  }
}
