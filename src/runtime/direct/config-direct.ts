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
  credentialOptionsFor,
  getPath,
  providerOptionsFor,
  type ProviderCatalogEntry,
  type ProviderOption,
} from '../../domain/catalog/provider.ts'
import { cancellationError } from '../process/tasks.ts'
import { safeErrorMessage } from '../process/errors.ts'
import {
  resolveTrustedFooterCommand,
  resolveUserCommandItemActivationIds,
  resolveUserCommandItemFallbackActivationIds,
  resolveUserLayerFooterMode,
} from '../../domain/footer/command-trust.ts'
import { parseFooterCustomItems, type FooterCustomItemsParseResult } from '../../domain/footer/custom-items.ts'
import type {
  AccountBalanceOutcome,
  AccountClientMetadata,
  AccountConfig,
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
  ProviderProfileConfig,
  ProviderProfileFacts,
  SubagentAllowedModelRoute,
  SubagentModelSelectionConfig,
  TuiSettingsConfig,
  WebProviderConfig,
  WebProviderSettings,
  ConfigReadiness,
} from '../config-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on?(event: string, listener: unknown): unknown
}

/** The structural 0.1.7 SettingsForms surface (descriptor projection +
 * path-scoped mutation). The old `get(namespace)` business-store read is
 * gone upstream: effective values arrive form-projected on the descriptor,
 * and every write carries the read revision. */
export interface SettingsServiceLike {
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsDescriptorLike[] | undefined
  mutate(
    ns: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    expectedRevision?: number,
  ): Promise<unknown>
}

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

/** The structural approval service surface (the session override read). */
export interface ApprovalServiceLike {
  overrideOf(session: unknown): 'ask' | 'never' | undefined
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

  readonly tuiSettings: TuiSettingsConfig | undefined
  readonly footerCommandTrust: FooterCommandTrust
  readonly footerCustomItems: FooterCustomItemsConfig
  readonly providers: ProviderProfileConfig
  readonly credentials: CredentialConfig
  readonly authorization: AuthorizationConfig
  readonly account: AccountConfig
  readonly permissions: PermissionConfig
  readonly presetDefault: PresetDefaultConfig
  readonly subagentModelSelection: SubagentModelSelectionConfig
  readonly web: WebProviderConfig

  constructor(
    ctx: HostContextLike,
    tuiSettings: TuiSettingsConfig | undefined,
    agentFor: (sessionId: string) => unknown | undefined,
  ) {
    this.tuiSettings = tuiSettings
    this.footerCommandTrust = new DirectFooterCommandTrust(ctx)
    this.footerCustomItems = new DirectFooterCustomItems(ctx)
    this.providers = new DirectProviderProfileConfig(ctx)
    this.credentials = new DirectCredentialConfig(ctx)
    this.authorization = new DirectAuthorizationConfig(ctx)
    this.account = new DirectAccountConfig(ctx)
    this.permissions = new DirectPermissionConfig(ctx, agentFor)
    this.presetDefault = new DirectPresetDefaultConfig(ctx)
    this.subagentModelSelection = new DirectSubagentModelSelectionConfig(ctx)
    this.web = new DirectWebProviderConfig(ctx)
  }
}

/** The settings descriptor's shape the form reads need (structural). */
interface SettingsDescriptorLike {
  readonly ns: string
  /** Form-projected effective value (volatile fields only). */
  readonly value?: unknown
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

  /** The merged /login option list as the port's CLIENT DTOs: the llm
   * configurable-provider directory over its PER-ENTRY sections when the
   * llm service is present, the settings-only fallback otherwise. The
   * pure merge stays in domain/catalog/provider.ts; this adapter only wires the
   * section reads and maps the schema facts onto the semantic
   * `canProvisionProfile` flag (never a namespace or path across the
   * port). */
  listCredentialOptions(): readonly CredentialProviderOption[] {
    const readSection = (ns: string): unknown => this.readSectionInternal(ns)
    const llm = this.llm()
    if (llm !== undefined) {
      try {
        return providerOptionsFor(llm.listConfigurableProviders(), readSection)
          .map(option => credentialOptionOf(option))
      } catch {
        // A throwing directory read degrades to the settings-only fallback.
      }
    }
    const settingsOnly = credentialOptionsFor(this.readPiAiProvidersInternal())
    return settingsOnly.map((option, index) => {
      const route = index === 0 ? 'deepseek-official' : option.label
      return {
        ...option,
        route,
        configured: true,
        declared: false,
        namesCredential: true,
        group: 'configured' as const,
        // The flag is computed through the SAME rule the llm-absent write
        // branch applies (the conventional `providers.<route>` slot): a
        // hostile providers key that fails the route pattern (or the
        // builtin) is never advertised as writable.
        canProvisionProfile: isKeylessProfileSlot('llm-pi-ai', ['providers', route], route),
      }
    })
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
    await mutateSettings(settings, 'llm-pi-ai', [
      { op: 'set', path: ['providers', route], value: profile },
    ])
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
      await mutateSettings(settings, 'llm-pi-ai', [
        { op: 'set', path: ['providers', route], value: {} },
      ])
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
    await mutateSettings(settings, directoryEntry.settingsNs, [
      { op: 'set', path, value: {} },
    ])
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
): Promise<unknown> {
  const revision = readSettingsDescriptor(settings, ns)?.revision
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
    const register = (event: string): void => {
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
    let flow: ReturnType<AuthorizationServiceLike['begin']>
    try {
      flow = authorization.begin({ key, method: request.method, interaction, signal })
    } catch (error) {
      // A SYNCHRONOUS begin failure (a wire backend throwing before its
      // first await): no attempt exists yet, but the caller-abort listener
      // must still be disposed — a leaked listener on the long-lived
      // runner signal would accumulate across logins (review finding).
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
    this.attempts.set(attemptId, { controller, key, settlement, disposeCallerAbortListener, settled: false })
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
    attempt.controller.abort()
    // Ordinary cancel keeps prompts answerable until the Host settles. Forced
    // caller teardown has destroyed their UI, so rejection is the only way to
    // release a flow that may be awaiting one; the page is gone and the Host
    // outcome remains authoritative.
    if (forcePrompts) this.rejectAttemptPrompts(attemptId)
    attempt.disposeCallerAbortListener()
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

  private rejectAttemptPrompts(attemptId: string): void {
    for (const [promptId, pending] of this.pendingPrompts) {
      if (pending.attemptId !== attemptId) continue
      this.pendingPrompts.delete(promptId)
      pending.cleanup()
      pending.reject(cancellationError('authorization attempt settled'))
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

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private account(): DeepSeekAccountServiceLike | undefined {
    return this.ctx.get('deepseekAccount') as DeepSeekAccountServiceLike | undefined
  }

  available(): boolean {
    return this.account() !== undefined
  }

  async getState(): Promise<AccountView> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    return accountViewOf(await account.getState())
  }

  async getProfile(client: AccountClientMetadata): Promise<AccountProfileOutcome> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const outcome = await account.getProfile({ ...client })
    if (outcome === null) return null
    const value = outcome as { status?: unknown; value?: unknown }
    if (value.status !== 'ready') return { status: 'failed' }
    return { status: 'ready', value: accountProfileOf(value.value) }
  }

  async getBalance(client: AccountClientMetadata): Promise<AccountBalanceOutcome> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const outcome = await account.getBalance({ ...client })
    if (outcome === null) return null
    const value = outcome as { status?: unknown; value?: unknown; bonusWallets?: unknown }
    if (value.status !== 'ready') return { status: 'failed' }
    return {
      status: 'ready',
      value: walletListOf(value.value),
      bonusWallets: walletListOf(value.bonusWallets),
    }
  }

  watch(signal: AbortSignal): AsyncIterable<AccountView> {
    const account = this.account()
    if (account === undefined) {
      // No service: an EMPTY subscription rather than a fabricated state.
      return (async function* empty(): AsyncGenerator<AccountView> {})()
    }
    const source = account.watch(signal)
    return (async function* projected(): AsyncGenerator<AccountView> {
      const iterator = source[Symbol.asyncIterator]()
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) return
          yield accountViewOf(next.value)
        }
      } finally {
        // Ending the signal is the only cancellation (never cancelSignIn):
        // the official iterator owns its own listener release.
        await iterator.return?.(undefined)
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

  async startSignIn(client: AccountClientMetadata): Promise<AccountView> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    const callbackOrigin = this.getCallbackOrigin()
    if (callbackOrigin === undefined) throw new Error('the Host browser callback listener is unavailable')
    // `web` is the only login source a TUI may present (never Desktop).
    return accountViewOf(await account.startSignIn({ ...client }, callbackOrigin, 'web'))
  }

  async cancelSignIn(id: string): Promise<AccountView> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    return accountViewOf(await account.cancelSignIn(id))
  }

  async signOut(client: AccountClientMetadata): Promise<AccountView> {
    const account = this.account()
    if (account === undefined) throw new Error('DeepSeek Account service unavailable')
    return accountViewOf(await account.signOut({ ...client }))
  }

  hasRunningAccountTasks(): boolean {
    // Mirrors the official `isRunningAccountTask` predicate: a running Agent
    // whose latest bound request used the account provider. The predicate is
    // kept structural so this adapter never imports (or duplicates) a Host
    // package; the Host's own signed-out listener owns the actual cancel.
    const agents = this.ctx.get('agents') as { list?(): readonly unknown[] } | undefined
    if (typeof agents?.list !== 'function') return false
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
    if (settings === undefined) return
    await mutateSettings(settings, 'permission', [
      { op: 'set', path: ['defaultPreset'], value: name },
    ])
  }

  approvalOverrideAvailable(): boolean {
    // Direct reads and writes the official session approval policy in-process.
    return true
  }

  approvalOverrideOf(sessionId: string): 'ask' | 'never' | undefined {
    const approval = this.ctx.get('approval') as ApprovalServiceLike | undefined
    if (approval === undefined) return undefined
    // The semantic port resolves the session id to the EXACT live Agent
    // internally; the session object never crosses the boundary.
    const agent = this.agentFor(sessionId) as { readonly session: unknown } | undefined
    if (agent === undefined) return undefined
    try {
      return approval.overrideOf(agent.session)
    } catch {
      // A throwing approval service degrades to "no override", never
      // breaks the settings read.
      return undefined
    }
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

/** The Direct subagent model-selection config: the OFFICIAL
 * `subagentModelSelection` service (`subagent-model-selection-settings`
 * entry) owns the live preference read; the entry's Settings form is the
 * WRITE surface — mounting the service alone does NOT enable anything;
 * the section defaults to disabled with an empty allowlist, and each NEW
 * session samples the preference at composition time. */
export class DirectSubagentModelSelectionConfig implements SubagentModelSelectionConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private settings(): SettingsServiceLike | undefined {
    return this.ctx.get('settings') as SettingsServiceLike | undefined
  }

  private selection(): { current(): { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] } } | undefined {
    return this.ctx.get('subagentModelSelection') as { current(): { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] } } | undefined
  }

  available(): boolean {
    // The OFFICIAL capability is the subagentModelSelection service (its
    // settings entry exists only while the service mounts). Without the
    // official service the /settings rows must not appear at all.
    return this.selection() !== undefined && this.settings() !== undefined
  }

  get(): { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] } {
    const selection = this.selection()
    if (selection === undefined) return { enabled: false, allowedModels: [] }
    try {
      const current = selection.current()
      return {
        enabled: current.enabled === true,
        allowedModels: (current.allowedModels ?? []).flatMap(route => {
          const candidate = route as { provider?: unknown; model?: unknown }
          return typeof candidate?.provider === 'string' && typeof candidate?.model === 'string'
            ? [{ provider: candidate.provider, model: candidate.model }]
            : []
        }),
      }
    } catch {
      // A failing official read reports the shipped default (off, empty).
      return { enabled: false, allowedModels: [] }
    }
  }

  async set(value: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }): Promise<void> {
    // Client-side pre-validation with the OFFICIAL rules (fail fast before
    // the write; the Host validates again on the section boundary):
    // duplicates by provider+model, and enabled requires at least one route.
    assertOfficialSubagentRoutes(value.allowedModels)
    if (value.enabled && value.allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    await mutateSettings(settings, 'subagent-model-selection-settings', [
      { op: 'set', path: ['enabled'], value: value.enabled },
      { op: 'set', path: ['allowedModels'], value: value.allowedModels.map(route => ({ ...route })) },
    ])
  }
}

/** The official route-list rules (mirrored client-side so a malformed edit
 * fails before the Host write; same messages as the Host validator). */
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

/** The OFFICIAL settings section ids the Web provider config addresses. Both
 *  are row ids of the shipped `dsh-base` composition; the adapter owns this
 *  schema knowledge so no consumer ever names a namespace or path. */
const WEB_PROVIDER_NS = 'web'
const WEB_SEARCH_API_NS = 'web-deepseek-api'
/** The credential reference the official DeepSeek web providers resolve
 *  (`apiKeyEnv`'s shipped default); the TUI never writes a literal key. */
const WEB_API_KEY_REF = 'DEEPSEEK_API_KEY'
/** Shipped range of the official `web-deepseek-api.count` schema. */
const WEB_SEARCH_API_COUNT_MIN = 1
const WEB_SEARCH_API_COUNT_MAX = 50

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
    // or malformed one is UNAVAILABLE, never a defaulted value.
    const provider = formValueOf(readSettingsDescriptor(settings, WEB_PROVIDER_NS))
    const api = formValueOf(readSettingsDescriptor(settings, WEB_SEARCH_API_NS))
    if (provider === undefined || api === undefined) return undefined
    const baseURL = api.baseURL
    const count = api.count
    const sendOriginalQuestion = api.sendOriginalQuestion
    if (typeof baseURL !== 'string' || baseURL === '') return undefined
    if (typeof count !== 'number' || !Number.isInteger(count)) return undefined
    if (typeof sendOriginalQuestion !== 'boolean') return undefined
    return {
      searchProvider: optionalId(provider.searchProvider),
      fetchProvider: optionalId(provider.fetchProvider),
      api: { baseURL, count, sendOriginalQuestion },
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
    await this.mutate('web', [{ op: 'set', path: ['searchProvider'], value: id }])
  }

  async setFetchProvider(id: 'http' | 'deepseek-fetch-api'): Promise<void> {
    assertFetchProviderId(id)
    await this.mutate('web', [{ op: 'set', path: ['fetchProvider'], value: id }])
  }

  async setSearchApiCount(count: number): Promise<void> {
    assertSearchApiCount(count)
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['count'], value: count }])
  }

  async setSendOriginalQuestion(enabled: boolean): Promise<void> {
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['sendOriginalQuestion'], value: enabled }])
  }

  async setSearchApiBaseURL(url: string): Promise<void> {
    assertSearchApiBaseURL(url)
    await this.mutate(WEB_SEARCH_API_NS, [{ op: 'set', path: ['baseURL'], value: url }])
  }

  /** One revision-checked official settings mutation. The section must be a
   *  real configured entry: an unmounted section is an explicit failure rather
   *  than a write against an invented namespace. */
  private async mutate(
    ns: typeof WEB_PROVIDER_NS | typeof WEB_SEARCH_API_NS,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
  ): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    if (readSettingsDescriptor(settings, ns) === undefined) {
      throw new Error(`the official Host settings section "${ns}" is not mounted`)
    }
    await mutateSettings(settings, ns, ops)
  }
}

/** The form-projected value of one settings descriptor (volatile fields only),
 *  or `undefined` when the descriptor or its value is unusable. */
function formValueOf(descriptor: SettingsDescriptorLike | undefined): Record<string, unknown> | undefined {
  const value = descriptor?.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** A configured provider id, or `undefined` for an absent/empty selection. */
function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The official candidate ids (the only values this UI ever writes). */
function assertSearchProviderId(id: string): void {
  if (id !== 'deepseek-official' && id !== 'deepseek-search-api') {
    throw new Error(`unsupported web search provider id "${id}"`)
  }
}

function assertFetchProviderId(id: string): void {
  if (id !== 'http' && id !== 'deepseek-fetch-api') {
    throw new Error(`unsupported web fetch provider id "${id}"`)
  }
}

/** The official `count` rule, checked before the write (the Host validates
 *  again on the section boundary). */
function assertSearchApiCount(count: number): void {
  if (!Number.isInteger(count) || count < WEB_SEARCH_API_COUNT_MIN || count > WEB_SEARCH_API_COUNT_MAX) {
    throw new Error(`the web search API count must be an integer from ${WEB_SEARCH_API_COUNT_MIN} through ${WEB_SEARCH_API_COUNT_MAX}`)
  }
}

/**
 * The API base rule for the human write entry: an absolute `https:` URL with no
 * userinfo, query, fragment, or trailing `/search` / `/fetch` action name. The
 * official provider still owns runtime availability — this only keeps an
 * unusable or dangerous base out of the durable configuration.
 */
function assertSearchApiBaseURL(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('the Search/Fetch API endpoint must be an absolute https:// URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('the Search/Fetch API endpoint must use https://')
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('the Search/Fetch API endpoint must not carry credentials in the URL')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('the Search/Fetch API endpoint must not carry a query or fragment')
  }
  if (/\/(?:search|fetch)$/u.test(parsed.pathname)) {
    throw new Error('the Search/Fetch API endpoint is the API base: drop the trailing /search or /fetch action')
  }
}
