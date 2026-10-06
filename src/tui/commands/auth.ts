/**
 * Built-in command definitions for the authorization/provider domain
 * (/login, /logout) plus their provider-picker and add-provider helpers.
 *
 * Registration is explicit: the coordinator (src/commands.ts) calls each
 * registrar at its frozen position. No authorization semantic change lives
 * here — the same provider-native flow, attempt binding, logout reference rows
 * and credential-record capability distinction.
 * @module @xmoon76/dsh-pi-tui/tui/commands/auth
 */

import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { PickerItem, TuiApp } from '../../tui-app.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { CredentialProviderOption } from '../../runtime/config-port.ts'
import {
  deriveKeyRef,
  resolveCredentialArg,
  ROUTE_PATTERN,
  PROTOCOL_CHOICES,
} from '../../provider-catalog.ts'
import {
  authorizationFailureText,
  createAuthorizationFlow,
  flowForRoute,
  mergeLoginTargets,
  type AuthorizationTarget,
  type LoginTarget,
} from '../../authorization.ts'
import type { RegisterOne, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the auth commands consume. */
type AuthCommandRunner = Pick<TuiCommandRunner, 'catalog' | 'config' | 'diag' | 'signal'>

export interface AuthCommandDeps {
  runner: AuthCommandRunner
  app: TuiApp
  registerOne: RegisterOne
}

export interface AuthCommandRegistrars {
  registerLogin(): void
  registerLogout(): void
}

/** The sentinel picker value for the "add a brand-new provider" action row. */
const ADD_PROVIDER_VALUE = '\u0000add-provider'
/** The sentinel prefix for an authorization-target picker row (a credential
 * key can never start with NUL, so route values cannot collide). */
const AUTH_VALUE_PREFIX = '\u0000auth:'


/** Build the merged /login picker rows: reference targets (the API-key
 * path) keep their configured/available/custom groups, prefixed with the
 * `API key` category so the two credential planes are visible at a glance
 * (the fork renders a non-interactive header row per group); authorization
 * targets (the provider sign-in path) get their own group, and the Add New
 * Platform action row is pinned last. Authorization row values carry the
 * AUTH_VALUE_PREFIX so they can never collide with a route. */
function mergedPickerRows(merged: readonly LoginTarget[]): PickerItem[] {
  const rows: PickerItem[] = []
  const groupLabels: Record<string, string> = {
    configured: 'API key · configured',
    available: 'API key · available',
    custom: 'API key · custom',
    authorization: 'sign in with provider',
  }
  for (const target of merged) {
    if (target.kind === 'reference') {
      const group = target.configured ? 'configured' : target.declared ? 'custom' : 'available'
      rows.push({
        value: target.route,
        label: `${target.label} (${target.ref})`,
        group: groupLabels[group],
      })
    } else {
      rows.push({
        value: AUTH_VALUE_PREFIX + target.key,
        label: target.inFlight ? `${target.label} — sign-in in progress` : `${target.label} — sign in`,
        group: groupLabels.authorization,
      })
    }
  }
  rows.push({ value: ADD_PROVIDER_VALUE, label: '[ Add New Platform ]' })
  return rows
}

/** Recover an authorization target from a picked row value (the marker
 * prefix guarantees no collision with reference route values). */
function targetFromPickerValue(merged: readonly LoginTarget[], value: string): AuthorizationTarget | undefined {
  if (!value.startsWith(AUTH_VALUE_PREFIX)) return undefined
  const key = value.slice(AUTH_VALUE_PREFIX.length)
  for (const target of merged) {
    if (target.kind === 'authorization' && target.key === key) return target
  }
  return undefined
}

/** One-line summary of every merged target, for the unknown-target error. */
function mergedTargetsSummary(merged: readonly LoginTarget[]): string {
  return merged.map(target => target.kind === 'reference'
    ? `${target.label} (${target.ref})`
    : `${target.label} (provider sign-in)`).join(', ')
}

/**
 * Run one authorization attempt on the port and report it. Method picking
 * (single method → direct; multiple → a picker) is a client concern; the
 * attempt itself is EVENT-DRIVEN (migration M1.9): the port emits detached
 * notice/prompt events and the TUI answers through `respond`/`cancel` —
 * no callback-bearing interaction ever crosses the contract. On success, a
 * catalog route that is not configured yet gets a minimal keyless profile
 * so the runtime keeps reading the credential record (§12.1 — never an
 * apiKeyEnv, which would switch the request path back to a reference that
 * is not set).
 */
async function runAuthorizationLogin(
  app: TuiApp,
  runner: Pick<TuiCommandRunner, 'catalog' | 'config' | 'diag' | 'signal'>,
  target: AuthorizationTarget,
  options: readonly CredentialProviderOption[],
): Promise<CommandResult> {
  const authorization = runner.config.authorization
  if (!authorization.available()) return { kind: 'error', text: 'authorization service unavailable' }
  if (target.inFlight) return { kind: 'error', text: `sign-in already in progress for ${target.label}` }
  let method = target.methods[0]?.id
  if (method === undefined) return { kind: 'error', text: `no sign-in method available for ${target.label}` }
  if (target.methods.length > 1) {
    const picked = await new Promise<string | undefined>((resolve) => {
      app.openPicker(
        target.methods.map(candidate => ({ value: candidate.id, label: candidate.label })),
        (value) => resolve(value),
        () => resolve(undefined),
        { header: `Sign in method · ${target.label}`, enableSearch: false },
      )
    })
    if (picked === undefined) return { kind: 'error', text: 'login cancelled' }
    method = picked
  }
  // The client flow driver renders notices and prompts and answers them
  // through the port (never a callback across the contract). The
  // subscription is registered BEFORE begin so no early event (a settled
  // outcome can land in the same microtask turn) is ever missed; the
  // flow is BOUND to the attempt id once begin returns, so a concurrent
  // login's events can never be consumed by this flow. The whole attempt
  // is wrapped in try/finally: a throwing begin (or any failure) still
  // unsubscribes and closes the UI — no leaked listener or panel.
  const flow = createAuthorizationFlow(app, authorization)
  const off = authorization.onEvent(flow.onEvent)
  try {
    let started: { kind: 'started'; attemptId: string } | { kind: 'unavailable' }
    try {
      started = await authorization.begin({ key: target.key, method, signal: runner.signal })
    } catch (error) {
      // A begin that REJECTED (or threw synchronously) before any attempt
      // existed is a failed login, not a crash: map it like any other
      // attempt failure. The finally below still unsubscribes and closes
      // the flow UI — no leaked listener or panel.
      if (runner.signal.aborted) return { kind: 'error', text: 'login cancelled' }
      return { kind: 'error', text: authorizationFailureText(error, safeErrorMessage(error)) }
    }
    if (started.kind !== 'started') {
      return { kind: 'error', text: 'authorization service unavailable' }
    }
    flow.bind(started.attemptId)
    // The wait RACES the runner signal: a provider that ignores its abort
    // signal must never hang the command on an outcome that never settles
    // (the adapter already withdrew the prompt bridges on the abort — the
    // UI is closed either way). Whichever finishes first wins; the
    // listener is removed on every path.
    const outcome = await new Promise<{ status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }>((resolve) => {
      let done = false
      const finish = (value: { status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }): void => {
        if (done) return
        done = true
        runner.signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => finish({ status: 'cancelled' })
      flow.outcome.then(finish, () => finish({ status: 'failed', message: 'login failed' }))
      if (runner.signal.aborted) {
        finish({ status: 'cancelled' })
        return
      }
      runner.signal.addEventListener('abort', onAbort, { once: true })
    })
    if (outcome.status === 'cancelled' || runner.signal.aborted) return { kind: 'error', text: 'login cancelled' }
    if (outcome.status === 'failed') {
      if (outcome.code === 'NOT_COMMITTED') {
        // A provider flow bug/abnormality: worth a diagnostic line.
        runner.diag.error('authorization', { key: target.key, error: outcome.message })
      }
      return { kind: 'error', text: authorizationFailureText({ code: outcome.code }, outcome.message ?? 'login failed') }
    }
    const profileNote = await provisionKeylessProfile(runner, target, options)
    return { kind: 'success', text: `signed in to ${target.label}${profileNote}` }
  } finally {
    off()
    flow.close()
  }
}

/**
 * After a successful authorization, write a MINIMAL keyless profile for a
 * catalog route that is not configured yet (§12.1). The record alone does
 * not make the route selectable — llm-pi-ai registers a route only when
 * its settings section names it — and the profile must NOT carry
 * apiKeyEnv, or the request path would switch back to a reference that was
 * never set. Hand-declared/custom routes are left to the add wizard
 * (§12.2). Any failure degrades silently (the sign-in itself succeeded).
 * @returns a user-facing note, or '' when nothing was provisioned.
 */
async function provisionKeylessProfile(
  runner: Pick<TuiCommandRunner, 'config' | 'diag'>,
  target: AuthorizationTarget,
  options: readonly CredentialProviderOption[],
): Promise<string> {
  if (target.route === undefined) return ''
  const option = options.find(candidate => candidate.route === target.route)
  // The option's SEMANTIC flag decides whether a keyless write could ever
  // be accepted (a writable slot exists) — the schema facts behind it
  // (namespace/path) stay inside the adapter; a Remote adapter computes
  // the same flag from the wire.
  if (option === undefined || option.configured || option.declared || !option.canProvisionProfile) return ''
  if (!runner.config.providers.available()) return ''
  try {
    // The adapter resolves the route's profile location internally —
    // only the ROUTE crosses (migration M1.9: no settings schema in the
    // command surface). The outcome is EXPLICIT: only a real write is
    // presented as "recorded"; a directory race or hostile layout is a
    // SKIP (never a fake success, never a fallback guess).
    const outcome = await runner.config.providers.writeKeylessProfile(option.route)
    return outcome.kind === 'written' ? ' — provider profile recorded' : ''
  } catch (error) {
    runner.diag.warn('authorization', { key: target.key, note: 'profile write failed', error: safeErrorMessage(error) })
    return ''
  }
}

/** The credential surface /logout's picker needs — the config port's
 * credentials sub-interface (presence-only reads). */
type LogoutCredentialsLike = Pick<import('../../runtime/config-port.ts').CredentialConfig, 'recordsSupported' | 'listRecords' | 'describeReference'>

/** Value prefixes for the /logout picker rows (no collision with a ref). */
const LOGOUT_REF_VALUE = '\u0000ref:'
const LOGOUT_RECORD_VALUE = '\u0000record:'

/** Build the /logout picker rows: every stored credential record plus every
 * configured reference (presence only — a secret's value never leaves the
 * credentials service). Records are deduplicated by key and labelled with
 * the authorization flow's user-facing name when one owns the key (a
 * record row must say what signing out actually clears). */
async function logoutPickerRows(
  credentials: LogoutCredentialsLike,
  options: readonly CredentialProviderOption[],
  targets: readonly AuthorizationTarget[],
): Promise<{ rows: PickerItem[]; recordCleanupUnavailable: boolean }> {
  const rows: PickerItem[] = []
  const seenRefs = new Set<string>()
  for (const option of options) {
    if (seenRefs.has(option.ref)) continue
    seenRefs.add(option.ref)
    try {
      const info = await credentials.describeReference(option.ref)
      if (info.configured) {
        rows.push({ value: LOGOUT_REF_VALUE + option.ref, label: `${option.label} (${option.ref})`, group: 'API keys' })
      }
    } catch {
      // A throwing describe degrades to "not configured".
    }
  }
  // An enumeration-UNAVAILABLE backend (Remote: rc.2 publishes no record-read
  // Remote) must NOT make the whole picker fail: the reference rows above are
  // still clearable, so the picker opens and the RESULT wording states that
  // stored-record cleanup is unavailable here (plan §9.4). The port owns the
  // capability distinction, so a SUPPORTED backend whose read really fails
  // propagates that failure instead of being mislabelled a capability gap.
  let recordCleanupUnavailable = false
  let records: readonly { key: string; kind?: string }[] = []
  if (credentials.recordsSupported()) {
    records = await credentials.listRecords()
  } else {
    recordCleanupUnavailable = true
  }
  const seenKeys = new Set<string>()
  for (const record of records) {
    if (seenKeys.has(record.key)) continue
    seenKeys.add(record.key)
    const owner = targets.find(target => target.key === record.key)
    const label = owner !== undefined
      ? `${owner.label} — stored credential${record.kind === undefined ? '' : ` (${record.kind})`}`
      : `${record.key}${record.kind === undefined ? '' : ` (${record.kind})`}`
    rows.push({ value: LOGOUT_RECORD_VALUE + record.key, label, group: 'stored credentials' })
  }
  return { rows, recordCleanupUnavailable }
}

/** The add-provider wizard outcome. */
type AddProviderOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; text: string }

/** Run the add-provider wizard: collect route/api/baseURL/displayName/key
 * through question flows, probe the endpoint for its models (falling back to
 * hand entry), review, then persist the profile + credential.
 * @param ctx - the command context.
 * @param app - the TUI surface (question flows / pickers).
 * @param signal - the runner's abort signal (probe cancellation).
 * @param prefilledRoute - route pre-filled from `/login <route>`.
 * @returns the outcome: ok (persisted), cancelled (user aborted), or error
 *   (a validation or persistence failure with a user-facing message).
 */
async function askAddProvider(
  runner: Pick<TuiCommandRunner, 'catalog' | 'config' | 'diag' | 'signal'>,
  app: TuiApp,
  signal: AbortSignal,
  prefilledRoute?: string,
): Promise<AddProviderOutcome> {
  const credentials = runner.config.credentials
  const providers = runner.config.providers
  if (!credentials.available() || !providers.available()) {
    // The settings service and the llm-pi-ai namespace must exist to persist a
    // hand-declared profile; without them the add cannot complete. This is a
    // capability failure, not a user cancellation.
    return { kind: 'error', text: 'adding a provider needs the settings service, which is unavailable' }
  }

  const route = prefilledRoute ?? ''
  const questions = [
    ...(route === '' ? [{ id: 'route', question: 'Provider route (lowercase letters, digits and dashes; e.g. acme-gateway)' }] : []),
    { id: 'api', question: 'Wire protocol', options: PROTOCOL_CHOICES.map(choice => ({ label: choice })) },
    { id: 'baseURL', question: 'Base URL (required for a hand-declared route)' },
    { id: 'displayName', question: 'Display name (optional; defaults to the route)' },
    { id: 'key', question: 'API key (leave empty to keep provider-native authentication)' },
  ]
  const answers = await app.askQuestions(questions)
  const routeValue = (answers.find(answer => answer.id === 'route')?.custom ?? route).trim().toLowerCase()
  if (!ROUTE_PATTERN.test(routeValue)) {
    return { kind: 'error', text: `invalid provider route "${routeValue}" — lowercase letters, digits and dashes only, no leading digit` }
  }
  const api = answers.find(answer => answer.id === 'api')?.selected[0] ?? PROTOCOL_CHOICES[0]
  const baseURL = (answers.find(answer => answer.id === 'baseURL')?.custom ?? '').trim()
  if (baseURL === '') return { kind: 'error', text: 'base URL is required for a hand-declared provider route' }
  try {
    const protocol = new URL(baseURL).protocol
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { kind: 'error', text: `invalid base URL "${baseURL}" — expected an absolute http(s) URL` }
    }
  } catch {
    return { kind: 'error', text: `invalid base URL "${baseURL}" — expected an absolute http(s) URL` }
  }
  const displayName = (answers.find(answer => answer.id === 'displayName')?.custom ?? '').trim() || routeValue
  const key = (answers.find(answer => answer.id === 'key')?.custom ?? '').trim()

  // Probe the endpoint for its advertised models (pi custom-registry fetch
  // equivalent): a discovery success fills the models list; any failure is a
  // hint and falls back to hand entry.
  let discovered: readonly { id: string }[] = []
  let discoveryNote: string | undefined
  try {
    discovered = await runner.catalog.models.discoverModels({
      baseURL,
      api,
      ...key === '' ? {} : { apiKey: key },
      signal,
    })
    if (discovered.length > 0) {
      discoveryNote = `probed ${discovered.length} model${discovered.length > 1 ? 's' : ''}`
    }
  } catch {
    discoveryNote = 'model probe failed — enter model ids by hand'
  }
  const modelAnswers = await app.askQuestions([
    {
      id: 'models',
      question: discoveryNote === undefined
        ? 'Model ids this route serves (one per line)'
        : `Models advertised by the endpoint (${discoveryNote})`,
      ...(discovered.length > 0
        ? { options: discovered.map(model => ({ label: model.id })), multiSelect: true }
        : {}),
    },
  ])
  const modelAnswer = modelAnswers.find(answer => answer.id === 'models')
  const models = modelAnswer?.selected ?? []
  const customModels = (modelAnswer?.custom ?? '')
    .split('\n').map(line => line.trim()).filter(line => line !== '')
  const allModels = [...new Set([...models, ...customModels])]
  if (allModels.length === 0) {
    return { kind: 'error', text: 'at least one model id is required for a hand-declared route' }
  }

  // Persist the profile (settings.mutate) and, when a key was entered, the
  // credential. apiKeyEnv is written ONLY when a key is stored (web Models
  // parity: a keyless route keeps provider-native auth). The two writes are
  // reported separately: a persisted profile with a failed key write (e.g.
  // the reference is shadowed read-only by the environment) must say the
  // provider WAS added and only the key failed, not claim the whole add
  // failed.
  const ref = deriveKeyRef(routeValue)
  const profile: Record<string, unknown> = {
    ...displayName === routeValue ? {} : { displayName },
    api,
    baseURL,
    models: allModels.map(id => ({ id })),
    ...key === '' ? {} : { apiKeyEnv: ref },
  }
  try {
    await providers.writeProfile(routeValue, profile)
  } catch (error) {
    return { kind: 'error', text: `could not add provider: ${safeErrorMessage(error)}` }
  }
  if (key !== '') {
    try {
      await credentials.setReference(ref, key)
    } catch (error) {
      return { kind: 'error', text: `provider ${routeValue} added, but storing the key failed: ${safeErrorMessage(error)}` }
    }
  }
  return {
    kind: 'ok',
    text: key === ''
      ? `provider ${routeValue} added (no key; provider-native authentication)`
      : `API key ${ref} set · provider ${routeValue} added`,
  }
}

/**
 * Create the auth-command registrars over the coordinator's primitives. The
 * factory only closes over its dependencies; it registers nothing until one of
 * the returned registrars is called at its frozen position.
 */
export function createAuthCommands(deps: AuthCommandDeps): AuthCommandRegistrars {
  const { runner, app, registerOne } = deps

  const registerLogin = (): void => {
    registerOne({
      name: 'login',
      description: 'Configure provider credentials; provider-native sign-in is available when supported',
      input: { hint: '[<route|env-var>]' },
      handler: async (invocation) => {
        const credentials = runner.config.credentials
        if (!credentials.available()) return { kind: 'error', text: 'credentials service unavailable' }
        // The two credential planes: reference targets from the provider
        // catalog, authorization flows from the seam. An absent authorization
        // service degrades to the reference-only surface.
        const targets = runner.config.authorization.listTargets()
        const options = runner.config.providers.listCredentialOptions()
        const merged = mergeLoginTargets(options, targets)
        const arg = invocation.rawInput.trim()
        let route: string | undefined
        let ref: string | undefined
        let target: AuthorizationTarget | undefined
        if (arg !== '') {
          // An explicit env-var / known-ref name ALWAYS keeps the reference
          // path, even when the same route has an authorization flow (§11.1,
          // §11.2, §11.5 case D): the typed name is the escape hatch.
          const known = resolveCredentialArg(arg, options)
          if (known !== undefined) {
            const option = options.find(candidate => candidate.ref === known)
            if (option !== undefined) {
              // Known route: a profile that explicitly names apiKeyEnv keeps
              // the reference path; a KEYLESS route with a flow goes
              // provider-native (§11.3 vs §11.4).
              const flow = option.route !== 'deepseek-official' ? flowForRoute(targets, option.route) : undefined
              if (flow !== undefined && option.namesCredential === false) {
                target = flow
              } else {
                route = option.route
                ref = option.ref
              }
            } else {
              // Novel env-var name: use it verbatim (no route to map to).
              ref = known
            }
          } else if (ROUTE_PATTERN.test(arg)) {
            // A route that has no credential option but IS offered by an
            // authorization flow starts the flow (§11.4); a genuinely new
            // route starts the add wizard.
            const flow = flowForRoute(targets, arg)
            if (flow !== undefined) {
              target = flow
            } else {
              const outcome = await askAddProvider(runner, app, runner.signal, arg)
              if (outcome.kind === 'cancelled') return { kind: 'error', text: 'add provider cancelled' }
              if (outcome.kind === 'error') return { kind: 'error', text: outcome.text }
              return { kind: 'success', text: outcome.text }
            }
          } else {
            return { kind: 'error', text: `unknown credential target "${arg}" — ${mergedTargetsSummary(merged)}` }
          }
        } else if (merged.length > 1) {
          // Picker with search + grouping + the Add New Platform action row.
          // Reference rows keep their route value; authorization rows carry a
          // key marker so the two address spaces never collide.
          const picked = await new Promise<string | undefined>((resolve) => {
            app.openPicker(
              mergedPickerRows(merged),
              (value) => resolve(value),
              () => resolve(undefined),
              {
                enableSearch: true,
                header: 'login · providers',
                noMatchText: '  no matching providers',
                width: 76,
                maxHeight: 26,
                showHint: true,
              },
            )
          })
          if (picked === undefined) return { kind: 'error', text: 'login cancelled' }
          if (picked === ADD_PROVIDER_VALUE) {
            const outcome = await askAddProvider(runner, app, runner.signal)
            if (outcome.kind === 'cancelled') return { kind: 'error', text: 'add provider cancelled' }
            if (outcome.kind === 'error') return { kind: 'error', text: outcome.text }
            return { kind: 'success', text: outcome.text }
          }
          const authTarget = targetFromPickerValue(merged, picked)
          if (authTarget !== undefined) {
            target = authTarget
          } else {
            route = picked
          }
        } else {
          const only = merged[0]
          if (only === undefined) return { kind: 'error', text: 'no credential targets available' }
          if (only.kind === 'authorization') {
            target = only
          } else {
            route = only.route
            ref = only.ref
          }
        }
        if (target !== undefined) {
          return runAuthorizationLogin(app, runner, target, options)
        }
        if (route === undefined && ref === undefined) return { kind: 'error', text: 'no credential targets available' }
        const option = route === undefined ? undefined : options.find(candidate => candidate.route === route)
        const targetRef = ref ?? option?.ref ?? deriveKeyRef(route ?? '')
        const label = option?.label ?? route ?? targetRef
        // §9.3: the backend's provider-auth sub-capability must never be
        // SILENTLY unavailable. When the authorization surface is absent here
        // (Remote rc.2 publishes none) and the route's profile names no
        // credential reference, the API-key path below is still the supported
        // one — but the user has to be told that OAuth/device sign-in is not
        // offered on this backend, because the wire cannot say whether this
        // particular keyless route is OAuth-only or uses the conventional
        // env-var reference. A hard block would hide provider login entirely,
        // which §9.3 also forbids.
        const providerSignInNote = runner.config.authorization.available() || option === undefined || option.namesCredential
          ? ''
          : ' — provider sign-in (OAuth/device) is unavailable on this backend'
        // The prompt and the WRITE have separate failure scopes: a cancelled
        // prompt is a user cancellation, while a dispatched credential write
        // reports its real settlement (the adapter never reclassifies a proven
        // Host result because the transport generation rolled over).
        let key: string
        try {
          const answers = await app.askQuestions([
            { id: 'key', question: `Enter the API key for ${label}${providerSignInNote}:`, masked: true },
          ])
          key = answers[0]?.custom ?? ''
        } catch {
          return { kind: 'error', text: 'login cancelled' }
        }
        if (key === '') return { kind: 'error', text: 'empty key; nothing set' }
        try {
          await credentials.setReference(targetRef, key)
        } catch (error) {
          // A pre-dispatch refusal (no current Connection generation) means the
          // key provably never left; anything else is this Host's own refusal.
          // Either way the key is NEVER retried automatically.
          if (error instanceof SupersededReadError) {
            return { kind: 'error', text: 'connection unavailable; the API key was not sent — reconnect and retry' }
          }
          return { kind: 'error', text: `could not store the API key: ${safeErrorMessage(error)}` }
        }
        return { kind: 'success', text: `API key ${targetRef} set` }
      },
    })
  }

  const registerLogout = (): void => {
    registerOne({
      name: 'logout',
      description: 'Clear provider credentials; stored-record cleanup is available when supported',
      input: { hint: '[<route|env-var>]' },
      handler: async (invocation) => {
        const credentials = runner.config.credentials
        if (!credentials.available()) return { kind: 'error', text: 'credentials service unavailable' }
        const targets = runner.config.authorization.listTargets()
        const options = runner.config.providers.listCredentialOptions()
        const arg = invocation.rawInput.trim()
        if (arg !== '') {
          // A configured/derived reference name takes the reference path
          // (§13.1) — EXCEPT a keyless route with a flow, whose login stores
          // a RECORD: clearing the never-set derived ref would be a silent
          // no-op, so the record is what gets cleared (§13.2).
          const resolved = resolveCredentialArg(arg, options)
          if (resolved !== undefined) {
            const option = options.find(candidate => candidate.ref === resolved)
            const flow = option !== undefined && option.route !== 'deepseek-official' && !option.namesCredential
              ? flowForRoute(targets, option.route)
              : undefined
            if (flow !== undefined) {
              await credentials.deleteRecord(flow.key)
              return { kind: 'success', text: `${flow.label} signed out locally — stored credential cleared` }
            }
            await credentials.unsetReference(resolved)
            return { kind: 'success', text: `API key ${resolved} cleared` }
          }
          // A route naming a flow directly (no provider option for it).
          const flow = flowForRoute(targets, arg.toLowerCase())
          if (flow !== undefined) {
            await credentials.deleteRecord(flow.key)
            return { kind: 'success', text: `${flow.label} signed out locally — stored credential cleared` }
          }
          return { kind: 'error', text: `unknown credential target "${arg}" — ${mergedTargetsSummary(mergeLoginTargets(options, targets))}` }
        }
        // No argument: aggregate what actually exists — stored records plus
        // configured references (§13.3). Presence and kind only; a secret's
        // value never leaves the credentials service.
        const { rows, recordCleanupUnavailable } = await logoutPickerRows(credentials, options, targets)
        if (rows.length === 0) {
          return {
            kind: 'error',
            text: recordCleanupUnavailable
              ? 'nothing to sign out; stored credential records cannot be enumerated or removed on this backend'
              : 'nothing to sign out',
          }
        }
        // §9.4: a reference clear must not imply that stored records were also
        // cleaned up when this backend cannot even enumerate them.
        const recordLimitationNote = recordCleanupUnavailable
          ? '; stored credential records cannot be enumerated or removed on this backend'
          : ''
        const picked = await new Promise<string | undefined>((resolve) => {
          app.openPicker(
            rows,
            (value) => resolve(value),
            () => resolve(undefined),
            { enableSearch: true, header: 'logout · credentials', noMatchText: '  nothing to sign out', width: 76, maxHeight: 26, showHint: true },
          )
        })
        if (picked === undefined) return { kind: 'error', text: 'logout cancelled' }
        if (picked.startsWith(LOGOUT_RECORD_VALUE)) {
          await credentials.deleteRecord(picked.slice(LOGOUT_RECORD_VALUE.length))
          return { kind: 'success', text: `${picked.slice(LOGOUT_RECORD_VALUE.length)} signed out locally — stored credential cleared` }
        }
        const targetRef = picked.slice(LOGOUT_REF_VALUE.length)
        await credentials.unsetReference(targetRef)
        return { kind: 'success', text: `API key ${targetRef} cleared${recordLimitationNote}` }
      },
    })
  }

  return { registerLogin, registerLogout }
}
