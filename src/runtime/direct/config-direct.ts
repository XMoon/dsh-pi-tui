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
import type {
  AuthorizationConfig,
  ConfigPort,
  CredentialConfig,
  PermissionConfig,
  PresetDefaultConfig,
  ProviderProfileConfig,
  ProviderProfileTarget,
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

  readSection(ns: string): unknown {
    const settings = this.settings()
    if (settings === undefined) return undefined
    try {
      return settings.get(ns)
    } catch {
      return undefined
    }
  }

  readPiAiProviders(): Record<string, { apiKeyEnv?: string } | undefined> | undefined {
    const settings = this.settings()
    if (settings === undefined) return undefined
    try {
      const section = settings.get(settingsNamespace('llm-pi-ai')) as
        | { providers?: Record<string, { apiKeyEnv?: string } | undefined> }
        | undefined
      return section?.providers
    } catch {
      return undefined
    }
  }

  async writeProfile(route: string, profile: Record<string, unknown>): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    await settings.mutate(settingsNamespace('llm-pi-ai'), [
      { op: 'set', path: ['providers', route], value: profile },
    ])
  }

  async writeKeylessProfile(target: ProviderProfileTarget): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) return
    await settings.mutate(target.settingsNs, [
      { op: 'set', path: [...target.settingsPath], value: {} },
    ])
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

  describeReference(ref: string): Promise<{ configured: boolean; source?: string }> {
    const credentials = this.credentials()
    if (credentials === undefined) return Promise.resolve({ configured: false })
    return credentials.describe(ref)
  }

  listRecords(): Promise<readonly { key: string; kind?: string }[]> {
    const credentials = this.credentials()
    if (credentials === undefined) return Promise.resolve([])
    return credentials.listRecords()
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
    return authorizationTargets(authorization?.list() ?? [])
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
    return permission?.names ?? []
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
