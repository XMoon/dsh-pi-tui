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

/** Mask the credential-bearing parts of one DISPLAYED URL override fact: the
 *  userinfo segment becomes `***` and any query/fragment is dropped, so the
 *  detached fact can never carry a credential into the UI or a diagnostic. */
function maskedOverrideUrl(value: string): string {
  const withoutSuffix = value.replace(/[?#].*$/u, '')
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/iu.exec(withoutSuffix)
  return match === null
    ? withoutSuffix
    : `${match[1]}***@${withoutSuffix.slice(match[0].length)}`
}

/** Project one `web-deepseek-api` descriptor value into the advanced override
 *  facts both adapters report. The URL fields are masked for display (userinfo
 *  and query/fragment never survive); the `*ApiKeyEnv` fields are environment
 *  NAMES, not secret values, and are copied verbatim. */
export function webApiAdvancedFactsOf(value: Record<string, unknown>): WebApiAdvancedFacts {
  const copyField = (field: 'searchBaseURL' | 'searchApiKeyEnv' | 'fetchBaseURL' | 'fetchApiKeyEnv'): string | undefined => {
    const raw = value[field]
    if (typeof raw !== 'string' || raw === '') return undefined
    return field === 'searchBaseURL' || field === 'fetchBaseURL' ? maskedOverrideUrl(raw) : raw
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
