/**
 * S2/PR-B §3.2 — the Direct Web provider config contract (rc.2 schema).
 *
 * The adapter is the ONLY write path to the official `web` / `web-deepseek-api`
 * settings sections: every case here asserts the exact namespace, path and
 * revision the Host receives, the read-back the UI must use, and the refusal
 * paths (missing section, unreadable value, rejected revision, invalid human
 * input) that must never be reported as a save. rc.2 has NO single `baseURL`
 * requirement: the read stays ready without one, the two billing modes are the
 * official closed enum, and the YAML-only advanced overrides are detached
 * read-only facts (legacy keys contribute presence only, never values).
 *
 * FIXTURE: a scripted Host `settings` + `credentials` service pair that
 * records every describe/mutate call and applies the official path ops with the
 * revision contract. ABSENT: a real Cordis composition (the L5 execution proof
 * lives in `web-provider-rc2-integration.test.ts`).
 *
 * @module @xmoon76/dsh-pi-tui/web-provider-config-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectConfigPort, DirectWebProviderConfig } from '../../../src/runtime/direct/config-direct.ts'
import type { HostContextLike } from '../../../src/runtime/direct/config-direct.ts'

interface Descriptor {
  ns: string
  value?: unknown
  user?: unknown
  revision?: number
}

interface Recorded {
  readonly ns: string
  readonly ops: readonly { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }[]
  readonly revision: number | undefined
}

/** A scripted settings service with the official revision contract. */
function settingsService(initial: Record<string, Descriptor>) {
  const descriptors = new Map(Object.entries(initial))
  const recorded: Recorded[] = []
  return {
    recorded,
    descriptors,
    describe(): readonly Descriptor[] {
      return [...descriptors.values()]
    },
    async mutate(ns: string, ops: Recorded['ops'], expectedRevision?: number): Promise<void> {
      const descriptor = descriptors.get(ns)
      if (descriptor === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
      if (expectedRevision !== undefined && expectedRevision !== (descriptor.revision ?? 0)) {
        throw new Error(`settings namespace "${ns}" changed since it was read (expected revision ${expectedRevision})`)
      }
      recorded.push({ ns, ops, revision: expectedRevision })
      const next = { ...(descriptor.value as Record<string, unknown>) }
      for (const op of ops) {
        const [key] = op.path
        if (key === undefined) throw new Error('the test store only applies top-level paths')
        next[key] = op.value
      }
      descriptors.set(ns, { ...descriptor, value: next, revision: (descriptor.revision ?? 0) + 1 })
    },
  }
}

/** The pure rc.2 default section the schema resolves for a fresh profile: the
 *  official defaults are APPLIED, the unset override fields are absent, and no
 *  legacy single-endpoint key is projected. */
const PURE_RC2_API_DEFAULTS = {
  searchBilling: 'auto',
  fetchBilling: 'auto',
  count: 10,
  sendOriginalQuestion: true,
}

/** One live Web settings store: the two official sections with their shipped
 *  values, plus the credential presence the Direct adapter reports. */
function host(options: {
  readonly searchProvider?: string
  readonly fetchProvider?: string
  readonly credential?: { configured: boolean; source?: string }
  readonly omitApi?: boolean
  readonly omitWeb?: boolean
  readonly credentialService?: boolean
  /** Overrides for the `web-deepseek-api` section value (merged over the pure
   *  rc.2 defaults; use `undefined` fields deliberately). */
  readonly api?: Record<string, unknown>
} = {}) {
  const settings = settingsService({
    ...options.omitWeb === true ? {} : {
      web: {
        ns: 'web',
        revision: 3,
        value: {
          ...options.searchProvider === undefined ? { searchProvider: 'deepseek-official' } : { searchProvider: options.searchProvider },
          ...options.fetchProvider === undefined ? { fetchProvider: 'http' } : { fetchProvider: options.fetchProvider },
        },
      },
    },
    ...options.omitApi === true ? {} : {
      'web-deepseek-api': {
        ns: 'web-deepseek-api',
        revision: 5,
        value: { ...PURE_RC2_API_DEFAULTS, ...options.api },
      },
    },
  })
  const describes: string[] = []
  const credentials = {
    async describe(ref: string): Promise<{ configured: boolean; source?: string }> {
      describes.push(ref)
      return options.credential ?? { configured: false }
    },
  }
  const ctx: HostContextLike = {
    get: name => name === 'settings' ? settings : name === 'credentials' && options.credentialService !== false ? credentials : undefined,
  }
  return { settings, credentials, describes, ctx }
}

test('read() maps the pure rc.2 defaults, the credential presence and nothing else', async () => {
  const h = host({ credential: { configured: true, source: 'file' }, searchProvider: 'acme-search' })
  const config = new DirectWebProviderConfig(h.ctx)
  const settings = await config.read()
  assert.deepEqual(settings, {
    searchProvider: 'acme-search',
    fetchProvider: 'http',
    api: { searchBilling: 'auto', fetchBilling: 'auto', count: 10, sendOriginalQuestion: true },
    advanced: {},
    credential: { configured: true, source: 'file' },
  })
  assert.equal('baseURL' in (settings?.api ?? {}), false, 'no single-endpoint fact exists on the DTO')
  assert.deepEqual(h.describes, ['DEEPSEEK_API_KEY'], 'presence is read from the official reference, never a value')
  assert.equal(config.available(), true)
})

test('read() stays ready WITHOUT any baseURL: rc.2 routes follow the conversation', async () => {
  // The rc.2 schema has no `baseURL` field at all (the pure-default section
  // above carries none), and a stored LEGACY `baseURL` is not an effective
  // value either: the read succeeds and reports its presence as a fact only.
  const legacy = host({ api: { baseURL: 'https://old.example.test/v1/tools', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: 'sk-legacy-value-never-echo' } })
  const config = new DirectWebProviderConfig(legacy.ctx)
  const read = await config.read()
  assert.equal(read?.api.searchBilling, 'auto', 'the legacy keys never become effective values')
  assert.deepEqual(read?.advanced, { legacyOverrideDetected: true },
    'a projected legacy key is detected as presence only')
  assert.equal(JSON.stringify(read).includes('sk-legacy-value-never-echo'), false,
    'the legacy apiKey value is never copied into the DTO')
  assert.equal(JSON.stringify(read).includes('https://old.example.test/v1/tools'), false,
    'the legacy baseURL value is never copied into the DTO')
  assert.deepEqual(legacy.settings.recorded, [], 'a read never writes')
})

test('read() reports the YAML-only advanced overrides as detached facts per capability', async () => {
  const h = host({ api: {
    searchBaseURL: 'https://search-gateway.example.test/v1/tools',
    searchApiKeyEnv: 'SEARCH_API_KEY_ENV',
    fetchBaseURL: 'https://fetch-gateway.example.test/v1/tools',
  } })
  const read = await new DirectWebProviderConfig(h.ctx).read()
  assert.deepEqual(read?.advanced, {
    searchBaseURL: 'https://search-gateway.example.test/v1/tools',
    searchApiKeyEnv: 'SEARCH_API_KEY_ENV',
    fetchBaseURL: 'https://fetch-gateway.example.test/v1/tools',
  }, 'only non-empty string fields are copied, one capability each')
  assert.equal(read?.api.searchBilling, 'auto', 'the billing values stay the Host\'s own answer')
})

test('a displayed URL override is MASKED: userinfo and query/fragment never reach the DTO', async () => {
  const h = host({ api: {
    searchBaseURL: 'https://user:secret@search.example.test/v1?token=x#frag',
    fetchBaseURL: 'https://fetch.example.test/v1/tools?token=y',
  } })
  const read = await new DirectWebProviderConfig(h.ctx).read()
  assert.equal(read?.advanced.searchBaseURL, 'https://***@search.example.test/v1',
    'the userinfo is replaced and the query/fragment dropped')
  assert.equal(read?.advanced.fetchBaseURL, 'https://fetch.example.test/v1/tools',
    'a credential-free URL still loses its query/fragment')
  const serialized = JSON.stringify(read)
  assert.doesNotMatch(serialized, /secret|user:|token=/u,
    `no credential material survives the projection:\n${serialized}`)
})

test('read() reports UNAVAILABLE for a missing section, an unreadable count or a foreign billing value', async () => {
  assert.equal(await new DirectWebProviderConfig(host({ omitWeb: true }).ctx).read(), undefined,
    'without the provider section there is no fact to report')
  assert.equal(new DirectWebProviderConfig(host({ omitWeb: true }).ctx).available(), false)
  assert.equal(await new DirectWebProviderConfig(host({ omitApi: true }).ctx).read(), undefined,
    'without the API section the API facts are unavailable, never defaulted')
  // A MALFORMED mounted section is the second unreadable case: the descriptors
  // exist (available() answers true) while the validated read answers
  // undefined, which is why the UI gates its WRITE ADMISSION on the readable
  // facts, not on the descriptor pair alone.
  const countMalformed = host({ api: { count: 'ten' } })
  assert.equal(new DirectWebProviderConfig(countMalformed.ctx).available(), true)
  assert.equal(await new DirectWebProviderConfig(countMalformed.ctx).read(), undefined,
    'an invalid count makes the whole section unreadable')
  assert.equal(new DirectWebProviderConfig(host({ omitApi: true }).ctx).available(), false,
    'availability is the SAME authority read() needs: a half-mounted configuration is unavailable')
  // A missing or foreign billing value is UNAVAILABLE too (never silently
  // defaulted to `auto`).
  const billingMissing = host({ api: { searchBilling: undefined } })
  assert.equal(await new DirectWebProviderConfig(billingMissing.ctx).read(), undefined)
  const billingForeign = host({ api: { fetchBilling: 'subscription' } })
  assert.equal(await new DirectWebProviderConfig(billingForeign.ctx).read(), undefined)
  assert.equal(await new DirectWebProviderConfig(billingForeign.ctx).available(), true)
  // An unmounted credential store answers "not configured" exactly like the
  // Direct /login port does, and never invents a source.
  assert.deepEqual((await new DirectWebProviderConfig(host({ credentialService: false }).ctx).read())?.credential, { configured: false })
})

test('the provider selections, API options and billing modes write the exact official path with the CURRENT revision', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  await config.setSearchProvider('deepseek-search-api')
  await config.setFetchProvider('deepseek-fetch-api')
  await config.setSearchApiCount(20)
  await config.setSendOriginalQuestion(false)
  await config.setSearchBilling('account')
  await config.setFetchBilling('api-key')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web', ops: [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }], revision: 3 },
    { ns: 'web', ops: [{ op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' }], revision: 4 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['count'], value: 20 }], revision: 5 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['sendOriginalQuestion'], value: false }], revision: 6 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['searchBilling'], value: 'account' }], revision: 7 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['fetchBilling'], value: 'api-key' }], revision: 8 },
  ])
  // The read-back is the authority the UI must display: the two billing modes
  // are independent and each stays the raw official enum.
  assert.deepEqual(await config.read(), {
    searchProvider: 'deepseek-search-api',
    fetchProvider: 'deepseek-fetch-api',
    api: { searchBilling: 'account', fetchBilling: 'api-key', count: 20, sendOriginalQuestion: false },
    advanced: {},
    credential: { configured: false },
  })
})

test('an explicit `auto` billing write is a real persisted choice, never a reset of the overrides', async () => {
  const h = host({ api: { searchBaseURL: 'https://search-gateway.example.test/v1/tools' } })
  const config = new DirectWebProviderConfig(h.ctx)
  await config.setSearchBilling('auto')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['searchBilling'], value: 'auto' }], revision: 5 },
  ])
  const read = await config.read()
  assert.deepEqual(read?.advanced, { searchBaseURL: 'https://search-gateway.example.test/v1/tools' },
    'the override survives an explicit Automatic choice (the Host owns the precedence)')
})

test('a custom configured provider id is reported as-is and never silently replaced', async () => {
  const h = host({ searchProvider: 'acme-search' })
  const config = new DirectWebProviderConfig(h.ctx)
  assert.equal((await config.read())?.searchProvider, 'acme-search')
  assert.deepEqual(h.settings.recorded, [], 'a read never writes')
})

test('a custom provider refreshed before a stale Direct intent is never overwritten', async () => {
  for (const item of [
    { field: 'searchProvider', value: 'custom-search', write: (config: DirectWebProviderConfig) => config.setSearchProvider('deepseek-search-api') },
    { field: 'fetchProvider', value: 'custom-fetch', write: (config: DirectWebProviderConfig) => config.setFetchProvider('deepseek-fetch-api') },
  ] as const) {
    const h = host()
    const descriptor = h.settings.descriptors.get('web')!
    const value = descriptor.value as Record<string, unknown>
    value[item.field] = item.value
    descriptor.revision = (descriptor.revision ?? 0) + 1
    const config = new DirectWebProviderConfig(h.ctx)
    assert.equal((await config.read())?.[item.field], item.value,
      'the Direct adapter sees the external custom route before the old intent reaches its setter')
    await assert.rejects(item.write(config), /custom route/u)
    assert.equal(value[item.field], item.value)
    assert.deepEqual(h.settings.recorded, [], 'the Direct adapter refuses before Host mutate')
  }
})

test('invalid human input is refused BEFORE any Host write', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  for (const count of [0, 51, 2.5, Number.NaN]) {
    await assert.rejects(config.setSearchApiCount(count), /count must be an integer from 1 through 50/u)
  }
  // The billing mode is the official CLOSED enum; legacy free-form values and
  // typos are refused before the Host settings service is ever consulted. The
  // invalid values are cast through the enum type on purpose: the RUNTIME guard
  // is the subject.
  for (const mode of ['subscription', 'AUTO', 'api_key', '', 'auto '] as readonly string[]) {
    await assert.rejects(config.setSearchBilling(mode as 'auto' | 'account' | 'api-key'), /billing mode/u, `refused: ${mode}`)
    await assert.rejects(config.setFetchBilling(mode as 'auto' | 'account' | 'api-key'), /billing mode/u, `refused: ${mode}`)
  }
  assert.deepEqual(h.settings.recorded, [], 'a refused input never reaches the Host settings service')
  // The three official modes write their exact field.
  await config.setSearchBilling('api-key')
  await config.setFetchBilling('auto')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['searchBilling'], value: 'api-key' }], revision: 5 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['fetchBilling'], value: 'auto' }], revision: 6 },
  ])
})

test('an unmounted settings section refuses the write instead of inventing a namespace', async () => {
  const h = host({ omitWeb: true })
  const config = new DirectWebProviderConfig(h.ctx)
  await assert.rejects(config.setSearchProvider('deepseek-official'), /is not mounted/u)
  const apiHost = host({ omitApi: true })
  const apiConfig = new DirectWebProviderConfig(apiHost.ctx)
  await assert.rejects(apiConfig.setSearchBilling('account'), /is not mounted/u)
  await assert.rejects(apiConfig.setFetchBilling('account'), /is not mounted/u)
  assert.deepEqual(h.settings.recorded, [])
  assert.deepEqual(apiHost.settings.recorded, [])
})

test('a rejected settings mutation surfaces with its own reason (never a silent success)', async () => {
  const h = host()
  h.settings.mutate = async () => { throw new Error('SETTINGS_CONFLICT: revision moved') }
  const config = new DirectWebProviderConfig(h.ctx)
  await assert.rejects(config.setSearchProvider('deepseek-search-api'), /SETTINGS_CONFLICT/u)
  await assert.rejects(config.setFetchBilling('account'), /SETTINGS_CONFLICT/u)
})

test('the DirectConfigPort exposes the same sub-domain through the assembly', async () => {
  const h = host()
  const port = new DirectConfigPort(h.ctx, undefined, () => undefined)
  assert.equal(port.web.available(), true)
  assert.equal((await port.web.read())?.api.count, 10)
  await port.web.setSendOriginalQuestion(false)
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['sendOriginalQuestion'], value: false }], revision: 5 },
  ])
})
