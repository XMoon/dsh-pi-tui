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

import { randomUUID } from 'node:crypto'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  AuthorizationDeclinedError,
  type AuthorizationInteraction,
  type AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
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
import { cancellationError } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
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
  AuthorizationPromptEvent,
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

/** The structural approval service surface (the session override read). */
export interface ApprovalServiceLike {
  overrideOf(session: unknown): 'ask' | 'never' | undefined
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
  readonly footerCommandTrust: FooterCommandTrust
  readonly footerCustomItems: FooterCustomItemsConfig
  readonly providers: ProviderProfileConfig
  readonly credentials: CredentialConfig
  readonly authorization: AuthorizationConfig
  readonly permissions: PermissionConfig
  readonly presetDefault: PresetDefaultConfig
  readonly subagentModelSelection: SubagentModelSelectionConfig

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
    this.permissions = new DirectPermissionConfig(ctx, agentFor)
    this.presetDefault = new DirectPresetDefaultConfig(ctx)
    this.subagentModelSelection = new DirectSubagentModelSelectionConfig(ctx)
  }
}

/** The settings descriptor's shape the trust read needs (structural). */
interface SettingsDescriptorLike {
  readonly ns: string
  readonly user?: unknown
}

/** The Direct M5 footer-command trust read: the USER layer of the
 * dsh-pi-tui settings descriptor decides BOTH the command mode and the
 * command (plan §17.4 — a project layer can never silently trigger the
 * user's command). The adapter owns the descriptor access; a Remote
 * adapter replays the same facts from the wire. */
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
    return resolveUserLayerFooterMode([descriptor], 'dsh-pi-tui')
  }

  get command() {
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) return undefined
    return resolveTrustedFooterCommand([descriptor], 'dsh-pi-tui')
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
    return resolveUserCommandItemActivationIds([descriptor], 'dsh-pi-tui')
  }

  /** The ids authorized for the native FALLBACK surface (the USER's own
   * footerFallbackMode decides). */
  get userCommandItemFallbackActivationIds() {
    const descriptor = this.readDescriptor()
    if (descriptor === undefined) return new Set<string>()
    return resolveUserCommandItemFallbackActivationIds([descriptor], 'dsh-pi-tui')
  }

  /** One describe() read per synchronous evaluation: the two getters are
   * read together by applyFooterSettings, so caching the descriptor for
   * the current tick halves the settings-service read. */
  private readDescriptor(): SettingsDescriptorLike | undefined {
    if (this.descriptorCache !== null) return this.descriptorCache
    const settings = this.ctx.get('settings') as { describe?(): readonly SettingsDescriptorLike[] | undefined } | undefined
    const descriptors = settings?.describe?.()
    const found = descriptors?.find(entry => entry.ns === 'dsh-pi-tui')
    this.descriptorCache = found ?? undefined
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
    const raw = this.readRaw()
    if (raw.failed) return { items: [], invalidCount: 1 }
    return parseFooterCustomItems(raw.value)
  }

  rawForPersistence(): FooterCustomItemsRaw {
    const raw = this.readRaw()
    if (raw.failed) return { kind: 'unavailable' }
    try {
      return { kind: 'available', value: structuredClone(raw.value) }
    } catch {
      return { kind: 'unavailable' }
    }
  }

  private readRaw(): { value: unknown; failed: boolean } {
    try {
      const settings = this.ctx.get('settings') as { describe?(): readonly SettingsDescriptorLike[] | undefined } | undefined
      if (settings === undefined || typeof settings.describe !== 'function') return { value: undefined, failed: true }
      const descriptors = settings.describe()
      if (descriptors === undefined) return { value: undefined, failed: true }
      const descriptor = descriptors.find(entry => entry.ns === 'dsh-pi-tui')
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
   * pure merge stays in provider-catalog.ts; this adapter only wires the
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

  async writeProfile(route: string, profile: Record<string, unknown>): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('settings service unavailable')
    if (!PROVIDER_ROUTE_PATTERN.test(route)) throw new Error('invalid provider route')
    await settings.mutate('llm-pi-ai', [
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
      await settings.mutate('llm-pi-ai', [
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
    await settings.mutate(directoryEntry.settingsNs, [
      { op: 'set', path, value: {} },
    ])
    return { kind: 'written' }
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

/** The Direct authorization config (`ctx.authorization` behind the
 * authorization.ts seam). The upstream interaction model (notify/prompt
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

  listTargets(): readonly AuthorizationTarget[] {
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
      this.finalizeAttempt(attemptId)
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
    const settlement = flow.then(
      (outcome) => {
        this.finalizeAttempt(attemptId)
        this.emit({ kind: 'settled', attemptId, status: outcome.status })
      },
      (error: unknown) => {
        this.finalizeAttempt(attemptId)
        this.emit({
          kind: 'settled',
          attemptId,
          status: 'failed',
          code: (error as { code?: unknown } | null)?.code as string | undefined,
          message: safeErrorMessage(error),
        })
      },
    )
    this.attempts.set(attemptId, { controller, key, settlement, disposeCallerAbortListener })
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
    this.finalizeAttempt(attemptId)
    return Promise.resolve()
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
      // The client UI must close EVEN IF the upstream flow never settles
      // (a cancel aborts the controller, but a flow that ignores its
      // signal would otherwise leave the prompt UI open forever): the
      // withdrawal event closes exactly the prompt it names (review
      // finding).
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
      const doc = settings.get('permission') as { defaultPreset?: string } | undefined
      return doc?.defaultPreset
    } catch {
      // The namespace is absent until the presets service registers it.
      return undefined
    }
  }

  async setDefaultPreset(name: string): Promise<void> {
    const settings = this.settings()
    if (settings === undefined) return
    await settings.mutate('permission', [
      { op: 'set', path: ['defaultPreset'], value: name },
    ])
  }

  approvalOverrideOf(session: unknown): 'ask' | 'never' | undefined {
    const approval = this.ctx.get('approval') as ApprovalServiceLike | undefined
    if (approval === undefined) return undefined
    try {
      return approval.overrideOf(session)
    } catch {
      // A throwing approval service degrades to "no override", never
      // breaks the settings read.
      return undefined
    }
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
      const doc = settings.get('agent-presets') as { default?: string } | undefined
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
    await settings.mutate('agent-presets', [
      { op: 'set', path: ['default'], value: id },
    ])
  }
}

/** The Direct subagent model-selection config: the OFFICIAL
 * `subagent-model-selection` settings section (registered Host-side by the
 * subagent-model-selection-settings service — mounting the service alone
 * does NOT enable anything; the section defaults to disabled with an
 * empty allowlist, and each NEW session samples the preference at
 * composition time). */
export class DirectSubagentModelSelectionConfig implements SubagentModelSelectionConfig {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private settings(): SettingsServiceLike | undefined {
    return this.ctx.get('settings') as SettingsServiceLike | undefined
  }

  available(): boolean {
    // The OFFICIAL capability is the subagent-model-selection-settings
    // service (it registers the section into the settings service when it
    // mounts). A generic settings service alone does NOT make the section
    // writable — without the official service the /settings rows must not
    // appear at all.
    return this.ctx.get('subagentModelSelection') !== undefined && this.settings() !== undefined
  }

  get(): { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] } {
    const settings = this.settings()
    if (settings === undefined) return { enabled: false, allowedModels: [] }
    try {
      const doc = settings.get('subagent-model-selection') as
        | { enabled?: unknown; allowedModels?: readonly unknown[] }
        | undefined
      return {
        enabled: doc?.enabled === true,
        allowedModels: (doc?.allowedModels ?? []).flatMap(route => {
          const candidate = route as { provider?: unknown; model?: unknown }
          return typeof candidate?.provider === 'string' && typeof candidate?.model === 'string'
            ? [{ provider: candidate.provider, model: candidate.model }]
            : []
        }),
      }
    } catch {
      // The section registers only when the settings service knows it; an
      // unknown namespace reads as the shipped default (off, empty).
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
    await settings.mutate('subagent-model-selection', [
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
