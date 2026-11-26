export const WEB_SEARCH_API_COUNT_MIN = 1
export const WEB_SEARCH_API_COUNT_MAX = 50

const SEARCH_PROVIDER_IDS = new Set(['deepseek-official', 'deepseek-search-api'])
const FETCH_PROVIDER_IDS = new Set(['http', 'deepseek-fetch-api'])

export function assertSearchProviderId(id: string): void {
  if (!SEARCH_PROVIDER_IDS.has(id)) {
    throw new Error(`unsupported web search provider id "${id}"`)
  }
}

export function assertSearchProviderReplaceable(value: unknown): void {
  if (value === undefined || value === '') return
  if (typeof value !== 'string') {
    throw new Error('the configured Web search provider is unreadable and cannot be replaced')
  }
  if (!SEARCH_PROVIDER_IDS.has(value)) {
    throw new Error(`the configured Web search provider uses a custom route "${value}" and cannot be replaced`)
  }
}

export function assertFetchProviderId(id: string): void {
  if (!FETCH_PROVIDER_IDS.has(id)) {
    throw new Error(`unsupported web fetch provider id "${id}"`)
  }
}

export function assertFetchProviderReplaceable(value: unknown): void {
  if (value === undefined || value === '') return
  if (typeof value !== 'string') {
    throw new Error('the configured Web fetch provider is unreadable and cannot be replaced')
  }
  if (!FETCH_PROVIDER_IDS.has(value)) {
    throw new Error(`the configured Web fetch provider uses a custom route "${value}" and cannot be replaced`)
  }
}

export function assertSearchApiCount(count: number): void {
  if (!Number.isInteger(count) || count < WEB_SEARCH_API_COUNT_MIN || count > WEB_SEARCH_API_COUNT_MAX) {
    throw new Error(`the web search API count must be an integer from ${WEB_SEARCH_API_COUNT_MIN} through ${WEB_SEARCH_API_COUNT_MAX}`)
  }
}

/** The official rc.2 `searchBilling` / `fetchBilling` closed enum. */
const WEB_API_BILLING_MODES = new Set(['auto', 'account', 'api-key'])

/** Whether `mode` is one of the official closed billing modes. */
export function isWebApiBilling(mode: string): mode is 'auto' | 'account' | 'api-key' {
  return WEB_API_BILLING_MODES.has(mode)
}

/** Accept exactly the official closed billing enum; anything else (including a
 *  legacy free-form value) is refused before it can reach the Host settings. */
export function assertWebApiBilling(mode: string): void {
  if (!WEB_API_BILLING_MODES.has(mode)) {
    throw new Error(`unsupported web API billing mode "${mode}" (the official modes are auto, account and api-key)`)
  }
}

/** The official billing mode of one `web-deepseek-api` descriptor field, or
 *  `undefined` when the field is absent or outside the closed enum. `undefined`
 *  is UNAVAILABLE — the adapters must never silently default it to `auto`. */
export function readWebApiBilling(
  value: Record<string, unknown>,
  field: 'searchBilling' | 'fetchBilling',
): 'auto' | 'account' | 'api-key' | undefined {
  const raw = value[field]
  return typeof raw === 'string' && WEB_API_BILLING_MODES.has(raw)
    ? raw as 'auto' | 'account' | 'api-key'
    : undefined
}

/** The rc.2 YAML-only advanced override fields, as DETACHED read-only facts:
 *  only non-empty string values are copied, and the legacy single-endpoint keys
 *  (`baseURL`/`apiKeyEnv`/`apiKey`) contribute PRESENCE only — never a value. */
export interface WebApiAdvancedFacts {
  searchBaseURL?: string
  searchApiKeyEnv?: string
  fetchBaseURL?: string
  fetchApiKeyEnv?: string
  legacyOverrideDetected?: boolean
}

/** The display fact for a configured URL the Host cannot prove parseable.
 *  The value is deliberately NOT echoed: reporting only that it is configured
 *  is safer than guessing which bytes are credentials. */
export const UNPARSEABLE_WEB_OVERRIDE_URL = '[configured URL unavailable]'

/** Mask the credential-bearing parts of one DISPLAYED URL override fact.
 *  Structured URL parsing is the authority: the LAST `@` separates the
 *  userinfo from the host (so a password containing `@` cannot leak), while
 *  query/fragment and every raw control character are dropped. A value that
 *  cannot be parsed as an http(s) URL is reported only as configured, never
 *  echoed. */
export function maskWebProviderOverrideUrl(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return UNPARSEABLE_WEB_OVERRIDE_URL
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return UNPARSEABLE_WEB_OVERRIDE_URL
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return UNPARSEABLE_WEB_OVERRIDE_URL
  if (parsed.host === '') return UNPARSEABLE_WEB_OVERRIDE_URL
  const authority = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  return parsed.username === '' && parsed.password === ''
    ? authority
    : `${parsed.protocol}//***@${parsed.host}${parsed.pathname}`
}

/** Project one `web-deepseek-api` descriptor value into the advanced override
 *  facts both adapters report. The URL fields are masked for display (userinfo
 *  and query/fragment never survive); the `*ApiKeyEnv` fields are environment
 *  NAMES, not secret values, and are copied verbatim. */
export function webApiAdvancedFactsOf(value: Record<string, unknown>): WebApiAdvancedFacts {
  const copyField = (field: 'searchBaseURL' | 'searchApiKeyEnv' | 'fetchBaseURL' | 'fetchApiKeyEnv'): string | undefined => {
    const raw = value[field]
    if (typeof raw !== 'string' || raw === '') return undefined
    return field === 'searchBaseURL' || field === 'fetchBaseURL' ? maskWebProviderOverrideUrl(raw) : raw
  }
  const searchBaseURL = copyField('searchBaseURL')
  const searchApiKeyEnv = copyField('searchApiKeyEnv')
  const fetchBaseURL = copyField('fetchBaseURL')
  const fetchApiKeyEnv = copyField('fetchApiKeyEnv')
  const legacyOverrideDetected = ['baseURL', 'apiKeyEnv', 'apiKey']
    .some(field => typeof value[field] === 'string' && (value[field] as string) !== '')
  return {
    ...(searchBaseURL !== undefined ? { searchBaseURL } : {}),
    ...(searchApiKeyEnv !== undefined ? { searchApiKeyEnv } : {}),
    ...(fetchBaseURL !== undefined ? { fetchBaseURL } : {}),
    ...(fetchApiKeyEnv !== undefined ? { fetchApiKeyEnv } : {}),
    ...(legacyOverrideDetected ? { legacyOverrideDetected: true } : {}),
  }
}

/** One capability's OFFICIAL layering facts on the `web` descriptor. These are
 *  three DISTINCT facts, never interchangeable: `baseId` is the deployment
 *  layer's own selection (which the TUI only maps to an official unset — it is
 *  NOT the provider a request executes), `userSet` is whether the USER layer
 *  carries the field at all (the ONLY override authority), and `userId` is that
 *  own-field's raw id when it is a non-empty string (display/stale-guard only).
 *  `userSet: true` with `userId: undefined` is a real state (an abnormal/empty
 *  raw USER value) and must not collapse into `userSet: false`. */
export interface WebProviderSelectionFacts {
  readonly baseId: string | undefined
  readonly userSet: boolean
  readonly userId: string | undefined
}

/** Project one capability's layering facts from the SAME `web` descriptor's
 *  `base`/`user` projections. `undefined` when either layer is not a plain
 *  object: the caller MUST treat that as an unreadable section, never as "no
 *  USER override". */
export function webProviderSelectionFactsOf(
  base: unknown,
  user: unknown,
  field: 'searchProvider' | 'fetchProvider',
): WebProviderSelectionFacts | undefined {
  if (!isPlainRecord(base) || !isPlainRecord(user)) return undefined
  const baseValue = base[field]
  const userValue = user[field]
  return {
    baseId: typeof baseValue === 'string' && baseValue !== '' ? baseValue : undefined,
    userSet: Object.hasOwn(user, field),
    userId: typeof userValue === 'string' && userValue !== '' ? userValue : undefined,
  }
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** The effective provider id of one official `web` descriptor value. */
export function webProviderEffectiveId(
  value: Record<string, unknown> | undefined,
  field: 'searchProvider' | 'fetchProvider',
): string | undefined {
  const raw = value?.[field]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** Whether the official USER/base layering facts moved since the capture. The
 *  target namespace revision is checked separately; this is the semantic fact
 *  comparison (a same-revision Host can still project different layers). */
export function webProviderSelectionChanged(
  current: WebProviderSelectionFacts | undefined,
  captured: WebProviderSelectionFacts,
): boolean {
  return current === undefined
    || current.baseId !== captured.baseId
    || current.userSet !== captured.userSet
    || current.userId !== captured.userId
}

/** Whether an explicit provider select is already stored as a USER own-field.
 *  An inherited effective value with the same id is NOT a no-op: the explicit
 *  pin must reach the official setter. */
export function webProviderSelectIsNoOp(
  selection: WebProviderSelectionFacts,
  effective: string | undefined,
  id: string,
): boolean {
  return effective === id && selection.userSet && selection.userId === id
}

/** Whether a provider restore is already satisfied: no USER own-field and the
 *  effective value already equals the deployment base. */
export function webProviderRestoreIsNoOp(
  selection: WebProviderSelectionFacts,
  effective: string | undefined,
): boolean {
  return !selection.userSet && effective === selection.baseId
}

/** The refusal reason for an explicit provider select when the current
 *  effective route is a CUSTOM id. A custom route is never overwritten here. */
export function webProviderSelectRefusal(
  capability: 'search' | 'fetch',
  effective: string | undefined,
): string | undefined {
  if (effective === undefined) return undefined
  const official = capability === 'search' ? SEARCH_PROVIDER_IDS : FETCH_PROVIDER_IDS
  if (official.has(effective)) return undefined
  return `the configured provider is a custom route (${effective}); only the official candidates are selectable here`
}

/** The non-empty rc.2 YAML-only override FIELD NAMES of one capability, read
 *  from the official `web-deepseek-api` descriptor value. This is the raw
 *  presence guard: display labels, masked facts or a UI boolean never decide
 *  billing eligibility. */
export function webAdvancedOverrideFieldNames(
  value: Record<string, unknown> | undefined,
  capability: 'search' | 'fetch',
): readonly string[] {
  const fields = capability === 'search'
    ? ['searchBaseURL', 'searchApiKeyEnv'] as const
    : ['fetchBaseURL', 'fetchApiKeyEnv'] as const
  return fields.filter(field => typeof value?.[field] === 'string' && (value[field] as string) !== '')
}

/** The official billing eligibility of one capability: only the EXPLICITLY
 *  selected API route with no non-empty YAML override admits its Billing row.
 *  The other capability's override/provider never blocks this one. */
export type WebBillingEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** The shared eligibility REASON: the same product policy answers both the
 *  command admission (detached facts) and the adapter dispatch guard (raw
 *  descriptor facts). */
export function webBillingEligibilityReason(
  capability: 'search' | 'fetch',
  effectiveProvider: string | undefined,
  overrideFields: readonly string[],
): string | undefined {
  const apiId = capability === 'search' ? 'deepseek-search-api' : 'deepseek-fetch-api'
  if (effectiveProvider !== apiId) {
    return capability === 'search'
      ? 'the DeepSeek Search API Billing is editable here only while that API is the explicitly selected provider; Automatic routes at request time'
      : 'the Fetch route is not the DeepSeek Fetch API; Fetch Billing applies only to that API'
  }
  if (overrideFields.length > 0) {
    return `the ${capability} API is overridden by Host YAML (${overrideFields.join(' and ')}); the billing choice cannot be written here`
  }
  return undefined
}

export function webBillingEligibility(
  webValue: Record<string, unknown> | undefined,
  apiValue: Record<string, unknown> | undefined,
  capability: 'search' | 'fetch',
): WebBillingEligibility {
  const field = capability === 'search' ? 'searchProvider' : 'fetchProvider'
  const reason = webBillingEligibilityReason(
    capability,
    webProviderEffectiveId(webValue, field),
    webAdvancedOverrideFieldNames(apiValue, capability),
  )
  return reason === undefined ? { ok: true } : { ok: false, reason }
}

/** Whether two Web observations belong to the SAME Host authority observation:
 *  the opaque generation always, plus the target namespace revision(s) (`both`
 *  by default). A→B→A is three distinct observations even when the numeric
 *  revisions and values repeat. */
export function sameWebAuthority(
  a: { readonly generation: object; readonly webRevision: number; readonly apiRevision: number } | undefined,
  b: { readonly generation: object; readonly webRevision: number; readonly apiRevision: number } | undefined,
  target: 'both' | 'web' | 'api' = 'both',
): boolean {
  if (a === undefined || b === undefined) return a === b
  if (!Object.is(a.generation, b.generation)) return false
  const web = a.webRevision === b.webRevision
  const api = a.apiRevision === b.apiRevision
  return target === 'web' ? web : target === 'api' ? api : web && api
}

/** Internal control-flow sentinel: the captured request is already satisfied
 *  and NO Host mutation may be dispatched. Adapters translate it into the
 *  distinct `no-changes` outcome; it never reaches a UI or a wire. */
export class WebProviderNoChanges extends Error {
  constructor() {
    super('the Host already holds the requested Web setting; nothing was written')
    this.name = 'WebProviderNoChanges'
  }
}
