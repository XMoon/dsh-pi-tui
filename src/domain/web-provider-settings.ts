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

export function assertSearchApiBaseURL(url: string): void {
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
