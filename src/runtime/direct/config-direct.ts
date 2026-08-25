/**
 * The Direct config adapter (M1.9) — the in-process implementation of
 * `ConfigPort` over the dsh `settings` / `credentials` / `authorization` /
 * `permissionPresets` / `commands` / `agentPresets` services. This is the
 * ONLY module in the config path that touches `ctx` (and the Host schema
 * knowledge: the `llm-pi-ai` / `permission` / `agent-presets` settings
 * namespaces); consumers depend on the port, and a Remote adapter will
 * implement the same interfaces in a later milestone.
 *
 * The /yolo permission switch deliberately stays on the OFFICIAL command
 * line (`commands.execute('/permission danger-full-access')`) so the
 * switch takes the exact host path — the raw commands service never leaks
 * past this adapter.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/config-direct
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import {
  authorizationTargets,
  type AuthorizationServiceLike,
  type AuthorizationTarget,
} from '../../authorization.ts'
import {
  credentialOptionsFor,
  providerOptionsFor,
  type ProviderCatalogEntry,
  type ProviderOption,
} from '../../provider-catalog.ts'
import type {
  AuthorizationConfig,
  ConfigPort,
  CredentialConfig,
  PermissionConfig,
  PresetDefaultConfig,
  ProviderProfileConfig,
  TuiSettingsConfig,
} from '../config-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on?(event: string, listener: unknown): unknown
}

/** The structural settings service surface. */
export interface SettingsServiceLike {
  get(ns: string): unknown
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]): Promise<unknown>
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
}

/** The structural commands service surface (permission application only). */
export interface CommandsServiceLike {
  execute(agent: unknown, line: string, args: readonly unknown[], signal?: AbortSignal): Promise<unknown>
}

/** The structural agent-presets service surface (the roster default). */
export interface AgentPresetsServiceLike {
  get defaultId(): string
}

/** The Direct backend's config: the `ctx` services behind the semantic
 * `ConfigPort` interfaces. */
export class DirectConfigPort implements ConfigPort {
  readonly tuiSettings: TuiSettingsConfig | undefined
  readonly providers: ProviderProfileConfig
  readonly credentials: CredentialConfig
  readonly authorization: AuthorizationConfig
  readonly permissions: PermissionConfig
  readonly presetDefault: PresetDefaultConfig

  constructor(
    ctx: HostContextLike,
    tuiSettings: TuiSettingsConfig | undefined,
    agentFor: (sessionId: string) => unknown | undefined,
  ) {
    this.tuiSettings = tuiSettings
    this.providers = new DirectProviderProfileConfig(ctx)
    this.credentials = new DirectCredentialConfig(ctx)
    this.authorization = new DirectAuthorizationConfig(ctx)
    this.permissions = new DirectPermissionConfig(ctx, agentFor)
    this.presetDefault = new DirectPresetDefaultConfig(ctx)
  }
}

/** The Direct provider-profile config (`ctx.settings`; the llm-pi-ai
 * schema knowledge is adapter-owned — the wizard never names a settings
 * namespace or path). */
const PROVIDER_ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

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

  /** Read ONE provider-config settings section DETACHED (the section URI
   * comes from the directory entries — internal to the adapter, a
   * consumer never names a namespace). */
  private readSectionInternal(ns: string): unknown {
    const settings = this.settings()
    if (settings === undefined) return undefined
    try {
      return detachedSection(settings.get(ns))
    } catch {
      // An unregistered namespace degrades to undefined (the old read-side
      // degradation — /login never escapes its command handler).
      return undefined
    }
  }

  /** The llm-pi-ai `providers` dict (route → apiKeyEnv), detached. */
  private readPiAiProvidersInternal(): Record<string, { apiKeyEnv?: string } | undefined> | undefined {
    const section = this.readSectionInternal(settingsNamespace('llm-pi-ai')) as
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

  /** The merged /login option list: the llm configurable-provider
   * directory over its PER-ENTRY sections when the llm service is
   * present, the settings-only fallback otherwise. The pure merge stays
   * in provider-catalog.ts; this adapter only wires the section reads. */
  listCredentialOptions(): readonly ProviderOption[] {
    const readSection = (ns: string): unknown => this.readSectionInternal(ns)
    const llm = this.llm()
    if (llm !== undefined) {
      try {
        return providerOptionsFor(llm.listConfigurableProviders(), readSection)
      } catch {
        // A throwing directory read degrades to the settings-only fallback.
      }
    }
    const settingsOnly = credentialOptionsFor(this.readPiAiProvidersInternal())
    return settingsOnly.map((option, index) => index === 0 ? {
      ...option,
      route: 'deepseek-official',
      configured: true,
      declared: false,
      namesCredential: true,
      group: 'configured' as const,
      settingsNs: '',
      settingsPath: [],
    } : {
      ...option,
      route: option.label,
      configured: true,
      declared: false,
      namesCredential: true,
      group: 'configured' as const,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', option.label],
    })
  }

  async writeProfile(route: string, profile: Record<string, unknown>): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    if (!PROVIDER_ROUTE_PATTERN.test(route)) throw new Error('invalid provider route')
    await settings.mutate(settingsNamespace('llm-pi-ai'), [
      { op: 'set', path: ['providers', route], value: profile },
    ])
  }

  async writeKeylessProfile(route: string): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    // The route becomes a settings path segment in the fallback layout.
    // Validate it at the Host boundary too: callers normally pass a catalog
    // route, but a malformed/hostile provider directory must never turn this
    // write into a path-injection primitive.
    if (!PROVIDER_ROUTE_PATTERN.test(route)) throw new Error('invalid provider route')
    // The route's profile location is resolved INTERNALLY from the
    // CURRENT directory: with the llm service present, the entry's own
    // section/path is used VERBATIM (a consumer never names a namespace);
    // a route the directory no longer offers writes NOTHING (a directory
    // race between the catalog read and the authorization completion must
    // never fall back to a guessed slot). Only when the llm service is
    // ABSENT (the settings-only /login fallback) does the conventional
    // llm-pi-ai slot apply.
    const llm = this.llm()
    if (llm === undefined) {
      await settings.mutate(settingsNamespace('llm-pi-ai'), [
        { op: 'set', path: ['providers', route], value: {} },
      ])
      return
    }
    const directoryEntry = llm.listConfigurableProviders().find(candidate => candidate.provider === route)
    if (directoryEntry === undefined) return
    // The directory metadata is validated against the adapter-owned
    // provider-config schema before it reaches a mutate: the entry must
    // live in the llm-pi-ai section and its path must be the providers
    // slot OF THE ROUTE — a hostile/malformed directory entry can never
    // redirect the write to an arbitrary namespace or path.
    const path = [...directoryEntry.settingsPath]
    const validLayout = directoryEntry.settingsNs === settingsNamespace('llm-pi-ai')
      && path.length === 2 && path[0] === 'providers' && path[1] === route
    if (!validLayout) return
    await settings.mutate(directoryEntry.settingsNs, [
      { op: 'set', path, value: {} },
    ])
  }
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

  onChanged(listener: () => void): void {
    this.ctx.on?.('credentials/reference-updated', listener)
    this.ctx.on?.('credentials/record-updated', listener)
  }
}

/** The Direct authorization config (`ctx.authorization` behind the
 * authorization.ts seam). */
export class DirectAuthorizationConfig implements AuthorizationConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private authorization(): AuthorizationServiceLike | undefined {
    return this.ctx.get('authorization') as AuthorizationServiceLike | undefined
  }

  available(): boolean {
    return this.authorization() !== undefined
  }

  listTargets(): readonly AuthorizationTarget[] {
    const authorization = this.authorization()
    // Detached copies — the method OBJECTS are cloned too (a shallow
    // array copy would still alias the Host's method rows).
    return authorizationTargets(authorization?.list() ?? [])
      .map(target => ({ ...target, methods: target.methods.map(method => ({ ...method })) }))
  }

  begin(request: {
    key: string
    method?: string
    interaction: AuthorizationInteraction
    signal?: AbortSignal
  }): Promise<{ status: 'authorized' | 'cancelled' }> {
    const authorization = this.authorization()
    if (authorization === undefined) return Promise.resolve({ status: 'cancelled' })
    return authorization.begin({
      ...request,
      key: request.key as CredentialKey,
    })
  }
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
    const settings = this.settings()
    if (settings === undefined) return undefined
    try {
      const doc = settings.get(settingsNamespace('permission')) as { defaultPreset?: string } | undefined
      return doc?.defaultPreset
    } catch {
      // The namespace is absent until the presets service registers it.
      return undefined
    }
  }

  async setDefaultPreset(name: string): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) return
    await settings.mutate(settingsNamespace('permission'), [
      { op: 'set', path: ['defaultPreset'], value: name },
    ])
  }

  async applyPermissionPreset(
    sessionId: string,
    presetId: string,
    signal?: AbortSignal,
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

/** The Direct preset-default config (`ctx.settings` `agent-presets`
 * namespace + the roster's own default). */
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
    const settings = this.settings()
    if (settings === undefined) return undefined
    try {
      const doc = settings.get(settingsNamespace('agent-presets')) as { default?: string } | undefined
      // `??` semantics: an empty saved value is displayed as-is, only an
      // ABSENT value falls back to the roster default (old behavior).
      if (doc?.default !== undefined) return doc.default
    } catch {
      // An unreadable namespace falls back to the roster default.
    }
    const presets = this.ctx.get('agentPresets') as AgentPresetsServiceLike | undefined
    return presets?.defaultId
  }

  async set(id: string): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    await settings.mutate(settingsNamespace('agent-presets'), [
      { op: 'set', path: ['default'], value: id },
    ])
  }
}
