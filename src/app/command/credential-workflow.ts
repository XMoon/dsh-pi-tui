/**
 * The ONE credential/auth workflow between the commands, the Settings Models
 * page and the ConfigPort. It owns:
 *
 *  - the shared auth-target resolution (`/login` / `/logout` deep links),
 *  - the DeepSeek Account flow EXCLUSION from the generic provider flows
 *    (the account page owns that authority),
 *  - the provider/key/record operations and the Add Provider atomic stages.
 *
 * It is deliberately non-UI: the Models page drives its own drafts and renders
 * the results; the command layer turns a destination into a workspace
 * deeplink. No Host service object, credential value, token or grant payload
 * crosses this module.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/credential-workflow
 */

import type {
  AccountConfig,
  AuthorizationConfig,
  AuthorizationFlowTarget,
  CredentialConfig,
  CredentialProviderOption,
  ProviderConfigGuide,
  ProviderProfileConfig,
  ProviderProfileFacts,
} from '../../runtime/config-port.ts'
import {
  classifyCredentialArg,
  deriveKeyRef,
  PROTOCOL_CHOICES,
  ROUTE_PATTERN,
} from '../../domain/catalog/provider.ts'
import { flowForRoute, mergeLoginTargets, type LoginTarget } from './authorization.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'

/** The stable authorization key the official PlatformAccount registers. The
 * generic provider flows must never start it: Account sign-in is owned by the
 * Account page and the official `deepseekAccount.startSignIn` path. */
export const ACCOUNT_AUTHORIZATION_KEY = 'deepseek-account-platform/default'
/** The user-facing account route name (`/login deepseek-account`). */
export const ACCOUNT_ROUTE = 'deepseek-account'

/** One explicit clear target the Models/logout flow may present. */
export type CredentialClearTarget =
  | {
      readonly kind: 'reference'
      readonly ref: string
      readonly label: string
      /** The provider route the reference belongs to, when one names it. */
      readonly route?: string
    }
  | {
      readonly kind: 'record'
      readonly key: string
      readonly label: string
      /** The provider route the record authorizes, when one maps it. */
      readonly route?: string
    }

/** The ONE semantic destination a `/login` or `/logout` line resolves to. The
 * command layer maps this onto the Settings workspace; it never executes a
 * credential operation itself. */
export type AuthDestination =
  | { readonly kind: 'models'; readonly view: 'list' }
  | { readonly kind: 'models'; readonly view: 'provider'; readonly route: string }
  | { readonly kind: 'models'; readonly view: 'reference'; readonly ref: string; readonly label?: string }
  | { readonly kind: 'models'; readonly view: 'add-provider'; readonly route?: string }
  | { readonly kind: 'models'; readonly view: 'logout-list' }
  | { readonly kind: 'models'; readonly view: 'logout'; readonly target: CredentialClearTarget }
  | { readonly kind: 'account'; readonly view: 'page' }
  | { readonly kind: 'account'; readonly view: 'signout' }
  | { readonly kind: 'error'; readonly message: string }

/** Whether one Host authorization flow is the DeepSeek Account's own flow. */
export function isAccountAuthorizationFlow(target: AuthorizationFlowTarget): boolean {
  return target.key === ACCOUNT_AUTHORIZATION_KEY
}

/** The generic provider flows the /login, Models and logout surfaces may
 * offer. The Account flow is excluded HERE (the one shared resolver) so no
 * view can start it as a provider-native sign-in or clear it as a record. */
export function genericAuthorizationTargets(
  targets: readonly AuthorizationFlowTarget[],
): AuthorizationFlowTarget[] {
  return targets.filter(target => !isAccountAuthorizationFlow(target))
}

/** One target summary for the unknown-target error (the same address spaces
 * the user can type). */
export function authTargetsSummary(options: readonly CredentialProviderOption[], targets: readonly AuthorizationFlowTarget[]): string {
  const merged = mergeLoginTargets(options, genericAuthorizationTargets(targets))
  return merged.map(target => target.kind === 'reference'
    ? `${target.label} (${target.ref})`
    : `${target.label} (provider sign-in)`).join(', ')
}

function isAccountArg(arg: string): boolean {
  return arg.toLowerCase() === ACCOUNT_ROUTE || arg === ACCOUNT_AUTHORIZATION_KEY
}

/** Resolve a `/login` argument to its workspace destination. The rules are
 * the existing command semantics: an explicit env-var / known ref keeps the
 * reference path, a known route opens its provider detail, a new valid route
 * starts the Add Provider wizard, and the account target is its own page. */
export function resolveLoginDestination(
  rawArg: string,
  options: readonly CredentialProviderOption[],
  targets: readonly AuthorizationFlowTarget[],
): AuthDestination {
  const generic = genericAuthorizationTargets(targets)
  const arg = rawArg.trim()
  if (arg === '') return { kind: 'models', view: 'list' }
  if (isAccountArg(arg)) return { kind: 'account', view: 'page' }
  const match = classifyCredentialArg(arg, options)
  if (match !== undefined) {
    if (match.kind === 'ref') return { kind: 'models', view: 'reference', ref: match.ref }
    const option = options.find(candidate => candidate.ref === match.option.ref)
    if (option !== undefined) return { kind: 'models', view: 'provider', route: option.route }
    return { kind: 'models', view: 'reference', ref: match.option.ref, label: match.option.label }
  }
  if (ROUTE_PATTERN.test(arg)) {
    const flow = flowForRoute(generic, arg)
    if (flow !== undefined) return { kind: 'models', view: 'provider', route: arg }
    return { kind: 'models', view: 'add-provider', route: arg }
  }
  return {
    kind: 'error',
    message: `unknown credential target "${arg}" — ${authTargetsSummary(options, targets)}`,
  }
}

/** Resolve a `/logout` argument to its workspace destination. A known route
 * clears the credential the route really uses (a keyless profile with a flow
 * stores a RECORD, never the derived reference); a literal ref clears that
 * reference; the account target opens the Account Sign out confirmation. */
export function resolveLogoutDestination(
  rawArg: string,
  options: readonly CredentialProviderOption[],
  targets: readonly AuthorizationFlowTarget[],
): AuthDestination {
  const generic = genericAuthorizationTargets(targets)
  const arg = rawArg.trim()
  if (arg === '') return { kind: 'models', view: 'logout-list' }
  if (isAccountArg(arg)) return { kind: 'account', view: 'signout' }
  const match = classifyCredentialArg(arg, options)
  if (match !== undefined) {
    const option = match.kind === 'route'
      ? options.find(candidate => candidate.ref === match.option.ref)
      : options.find(candidate => candidate.ref === match.ref)
    const flow = option !== undefined && option.route !== 'deepseek-official' && !option.namesCredential
      ? flowForRoute(generic, option.route)
      : undefined
    if (flow !== undefined) {
      return {
        kind: 'models',
        view: 'logout',
        target: { kind: 'record', key: flow.key, label: flow.label, ...(flow.route === undefined ? {} : { route: flow.route }) },
      }
    }
    const ref = match.kind === 'route' ? match.option.ref : match.ref
    const label = option?.label ?? ref
    return {
      kind: 'models',
      view: 'logout',
      target: { kind: 'reference', ref, label, ...(option === undefined ? {} : { route: option.route }) },
    }
  }
  // A route that has a flow but no credential option (a foreign scope the
  // catalog does not expose) is cleared by its record.
  const flow = flowForRoute(generic, arg.toLowerCase())
  if (flow !== undefined) {
    return {
      kind: 'models',
      view: 'logout',
      target: { kind: 'record', key: flow.key, label: flow.label, ...(flow.route === undefined ? {} : { route: flow.route }) },
    }
  }
  return {
    kind: 'error',
    message: `unknown credential target "${arg}" — ${authTargetsSummary(options, targets)}`,
  }
}

/** One stored credential row the Models Stored credentials list paints. */
export interface StoredCredentialRow {
  readonly kind: 'reference' | 'record'
  /** The exact ref / record key the clear operation addresses. */
  readonly key: string
  readonly label: string
  readonly route?: string
  /** The credential store's own source layer, for a reference. */
  readonly source?: string
  /** The record kind the store reports, when it reports one. */
  readonly kindHint?: string
}

/** One Add Provider draft (page-local until Create). */
export interface CreateProviderDraft {
  readonly route: string
  readonly api: string
  readonly baseURL: string
  readonly displayName: string
  readonly models: readonly string[]
  readonly apiKey: string
}

/** The Add Provider atomic outcome. The profile write and the credential
 * write are separate Host operations: a persisted profile with a failed key
 * write must never be reported as a whole-add failure. */
export type CreateProviderOutcome =
  | { readonly kind: 'created'; readonly text: string }
  | { readonly kind: 'profile-written-key-failed'; readonly text: string; readonly reason: string }
  | { readonly kind: 'rejected'; readonly text: string }

/** The narrow operations the workflow consumes (the runner's config/catalog
 * seams, never a Host service). */
export interface CredentialWorkflowDeps {
  readonly providers: ProviderProfileConfig
  readonly credentials: CredentialConfig
  readonly authorization: AuthorizationConfig
  readonly account: AccountConfig
  readonly catalog: { readonly models: { available(): boolean; discoverModels(request: {
    baseURL: string
    api: string
    apiKey?: string
    signal?: AbortSignal
  }): Promise<readonly { id: string }[]> } }
  readonly signal: AbortSignal
  readonly diag: { error(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void }
}

/** The shared provider/credential operations. */
export class CredentialWorkflow {
  private readonly deps: CredentialWorkflowDeps

  constructor(deps: CredentialWorkflowDeps) {
    this.deps = deps
  }

  /** The merged targets INCLUDING the account row (the Models list paints the
   * account as its own entry; it is never a generic provider flow). */
  mergedTargets(): readonly LoginTarget[] {
    return mergeLoginTargets(this.deps.providers.listCredentialOptions(), this.genericTargets())
  }

  genericTargets(): readonly AuthorizationFlowTarget[] {
    return genericAuthorizationTargets(this.deps.authorization.listTargets())
  }

  options(): readonly CredentialProviderOption[] {
    return this.deps.providers.listCredentialOptions()
  }

  account(): AccountConfig {
    return this.deps.account
  }

  readProfile(route: string): ProviderProfileFacts {
    return this.deps.providers.readProfile(route)
  }

  configGuide(): ProviderConfigGuide {
    return this.deps.providers.configGuide()
  }

  /** Every stored credential the user can clear: configured references plus
   * the store's records. Presence only; no value is read. */
  async storedCredentials(): Promise<{
    readonly rows: readonly StoredCredentialRow[]
    readonly recordCleanupUnavailable: boolean
    readonly referenceReadFailures: readonly string[]
  }> {
    const credentials = this.deps.credentials
    const options = this.options()
    const targets = this.genericTargets()
    const rows: StoredCredentialRow[] = []
    const referenceReadFailures: string[] = []
    const seenRefs = new Set<string>()
    for (const option of options) {
      if (seenRefs.has(option.ref)) continue
      seenRefs.add(option.ref)
      try {
        const info = await credentials.describeReference(option.ref)
        if (!info.configured) continue
        rows.push({
          kind: 'reference',
          key: option.ref,
          label: option.label,
          route: option.route,
          ...(info.source === undefined ? {} : { source: info.source }),
        })
      } catch (error) {
        referenceReadFailures.push(`${option.ref}: ${safeErrorMessage(error)}`)
      }
    }
    let recordCleanupUnavailable = false
    let records: readonly { key: string; kind?: string }[] = []
    if (credentials.recordsSupported()) {
      records = await credentials.listRecords()
    } else {
      recordCleanupUnavailable = true
    }
    const seenKeys = new Set<string>()
    for (const record of records) {
      // The DeepSeek Account grant is NOT a generic provider record: the Account
      // page owns its sign-in/sign-out. Listing it here would let `/logout`
      // delete a grant the user never asked to clear as a provider credential.
      if (record.key === ACCOUNT_AUTHORIZATION_KEY) continue
      if (seenKeys.has(record.key)) continue
      seenKeys.add(record.key)
      const owner = targets.find(target => target.key === record.key)
      rows.push({
        kind: 'record',
        key: record.key,
        label: owner === undefined ? record.key : owner.label,
        ...(owner?.route === undefined ? {} : { route: owner.route }),
        ...(record.kind === undefined ? {} : { kindHint: record.kind }),
      })
    }
    return { rows, recordCleanupUnavailable, referenceReadFailures }
  }

  /** The Account row's current summary (the Models list). A failure is stated,
   * never rendered as signed out. */
  async accountSummary(): Promise<{ readonly available: boolean; readonly status?: 'signed-out' | 'credential-stored'; readonly failure?: string }> {
    const account = this.deps.account
    if (!account.available()) return { available: false }
    try {
      const view = await account.getState()
      return { available: true, status: view.status }
    } catch (error) {
      return { available: true, failure: safeErrorMessage(error) }
    }
  }

  describeReference(ref: string): Promise<{ configured: boolean; source?: string }> {
    return this.deps.credentials.describeReference(ref)
  }

  async setReference(ref: string, secret: string): Promise<void> {
    await this.deps.credentials.setReference(ref, secret)
  }

  async clearReference(ref: string): Promise<void> {
    await this.deps.credentials.unsetReference(ref)
  }

  async deleteRecord(key: string): Promise<void> {
    await this.deps.credentials.deleteRecord(key)
  }

  async beginAuthorization(
    key: string,
    method: string | undefined,
    signal: AbortSignal,
  ): Promise<{ kind: 'started'; attemptId: string } | { kind: 'unavailable' }> {
    return this.deps.authorization.begin({ key, ...(method === undefined ? {} : { method }), signal })
  }

  authorizationEvents(listener: Parameters<AuthorizationConfig['onEvent']>[0]): () => void {
    return this.deps.authorization.onEvent(listener)
  }

  respondAuthorization(attemptId: string, promptId: string, answer: string | null): Promise<void> {
    return this.deps.authorization.respond(attemptId, promptId, answer)
  }

  async cancelAuthorization(attemptId: string): Promise<void> {
    await this.deps.authorization.cancel(attemptId)
  }

  async discoverModels(request: {
    baseURL: string
    api: string
    apiKey?: string
  }): Promise<readonly { id: string }[]> {
    return this.deps.catalog.models.discoverModels({ ...request, signal: this.deps.signal })
  }

  /** After a successful provider authorization: write a MINIMAL keyless
   * profile for a catalog route that is not configured yet. A failure is
   * reported as a note (the sign-in itself succeeded), never retried. */
  async provisionKeylessProfile(route: string | undefined): Promise<string> {
    if (route === undefined) return ''
    const option = this.options().find(candidate => candidate.route === route)
    if (option === undefined || option.configured || option.declared || !option.canProvisionProfile) return ''
    if (!this.deps.providers.available()) return ''
    try {
      const outcome = await this.deps.providers.writeKeylessProfile(option.route)
      return outcome.kind === 'written' ? ' — provider profile recorded' : ''
    } catch (error) {
      this.deps.diag.warn('authorization', {
        route,
        note: 'profile write failed',
        error: safeErrorMessage(error),
      })
      return ''
    }
  }

  /** The Add Provider atomic create: validate, persist the profile, then the
   * optional credential. The outcome names the exact stage that failed. */
  async createProvider(draft: CreateProviderDraft): Promise<CreateProviderOutcome> {
    const providers = this.deps.providers
    const credentials = this.deps.credentials
    if (!credentials.available() || !providers.available()) {
      return {
        kind: 'rejected',
        text: 'adding a provider needs the settings service, which is unavailable',
      }
    }
    const route = draft.route.trim().toLowerCase()
    if (!ROUTE_PATTERN.test(route)) {
      return {
        kind: 'rejected',
        text: `invalid provider route "${route}" — lowercase letters, digits and dashes only, no leading digit`,
      }
    }
    if (!PROTOCOL_CHOICES.includes(draft.api as typeof PROTOCOL_CHOICES[number])) {
      return { kind: 'rejected', text: `invalid wire protocol "${draft.api}"` }
    }
    const baseURL = draft.baseURL.trim()
    let protocol: string
    try {
      protocol = new URL(baseURL).protocol
    } catch {
      return { kind: 'rejected', text: `invalid base URL "${baseURL}" — expected an absolute http(s) URL` }
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { kind: 'rejected', text: `invalid base URL "${baseURL}" — expected an absolute http(s) URL` }
    }
    const models = [...new Set(draft.models.map(id => id.trim()).filter(id => id !== ''))]
    if (models.length === 0) {
      return { kind: 'rejected', text: 'at least one model id is required for a hand-declared route' }
    }
    const displayName = draft.displayName.trim() || route
    const key = draft.apiKey.trim()
    const ref = deriveKeyRef(route)
    const profile: Record<string, unknown> = {
      ...displayName === route ? {} : { displayName },
      api: draft.api,
      baseURL,
      models: models.map(id => ({ id })),
      ...key === '' ? {} : { apiKeyEnv: ref },
    }
    try {
      await providers.writeProfile(route, profile)
    } catch (error) {
      return { kind: 'rejected', text: `could not add provider: ${safeErrorMessage(error)}` }
    }
    if (key === '') {
      return { kind: 'created', text: `provider ${route} added (no key; provider-native authentication)` }
    }
    try {
      await credentials.setReference(ref, key)
    } catch (error) {
      const reason = error instanceof SupersededReadError
        ? 'connection unavailable; the API key was not sent'
        : safeErrorMessage(error)
      return {
        kind: 'profile-written-key-failed',
        text: `provider ${route} added, but storing the key failed: ${reason}`,
        reason,
      }
    }
    return { kind: 'created', text: `API key ${ref} set · provider ${route} added` }
  }
}

/** The user-facing text for one authorization attempt failure (the existing
 * command taxonomy — kept in `authorization.ts` would add no value here). */
export { authorizationFailureText } from './authorization.ts'
