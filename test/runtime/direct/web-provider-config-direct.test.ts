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
import { UNPARSEABLE_WEB_OVERRIDE_URL } from '../../../src/domain/web-provider-settings.ts'
import type { HostContextLike } from '../../../src/runtime/direct/config-direct.ts'
import type { WebProviderSettings } from '../../../src/runtime/config-port.ts'

/** ONE real readable capture for a test write. Production never fabricates a
 *  capture: every write is bound to the observation the user saw. */
async function captureOf(source: { read(): Promise<WebProviderSettings | undefined> }): Promise<WebProviderSettings> {
  const capture = await source.read()
  assert.ok(capture !== undefined, 'the fixture Host must produce a readable Web capture')
  return capture
}

/** The DTO fields WITHOUT the opaque authority, for the legacy deepEqual
 *  assertions; the authority is asserted separately. */
function withoutAuthority(read: WebProviderSettings | undefined): Omit<WebProviderSettings, 'authority'> | undefined {
  if (read === undefined) return undefined
  const { authority: _authority, ...rest } = read
  return rest
}

function assertAuthority(read: WebProviderSettings | undefined, webRevision: number, apiRevision: number): void {
  assert.ok(read !== undefined)
  assert.equal(typeof read.authority.generation, 'object')
  assert.equal(read.authority.webRevision, webRevision)
  assert.equal(read.authority.apiRevision, apiRevision)
}

interface Descriptor {
  ns: string
  value?: unknown
  base?: unknown
  user?: unknown
  revision?: number
}

type RecordedOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

interface Recorded {
  readonly ns: string
  readonly ops: readonly RecordedOp[]
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
      const nextValue = { ...(descriptor.value as Record<string, unknown>) }
      const nextUser = { ...(descriptor.user as Record<string, unknown>) }
      const base = (descriptor.base ?? {}) as Record<string, unknown>
      for (const op of ops) {
        const [key] = op.path
        if (key === undefined) throw new Error('the test store only applies top-level paths')
        if (op.op === 'set') {
          nextValue[key] = op.value
          nextUser[key] = op.value
          continue
        }
        // The rc.5 official `mutate` substitutes `set(base)` for an `unset`
        // whose path has a deployment value; otherwise it deletes the own field.
        if (base[key] !== undefined) {
          nextValue[key] = base[key]
          nextUser[key] = base[key]
        } else {
          delete nextValue[key]
          delete nextUser[key]
        }
      }
      descriptors.set(ns, { ...descriptor, value: nextValue, user: nextUser, revision: (descriptor.revision ?? 0) + 1 })
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
  /** The `web` descriptor's deployment layer. The shipped base composes
   *  `fetchProvider: http` and no Search provider. */
  readonly base?: Record<string, unknown>
  /** The `web` descriptor's raw USER layer. The default pins the effective
   *  ids as USER overrides (a stored profile). */
  readonly user?: Record<string, unknown>
} = {}) {
  const settings = settingsService({
    ...options.omitWeb === true ? {} : {
      web: {
        ns: 'web',
        revision: 3,
        base: options.base ?? { fetchProvider: 'http' },
        user: options.user ?? {
          searchProvider: options.searchProvider ?? 'deepseek-official',
          ...(options.fetchProvider === undefined || options.fetchProvider === 'http' ? {} : { fetchProvider: options.fetchProvider }),
        },
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
  assertAuthority(settings, 3, 5)
  assert.deepEqual(withoutAuthority(settings), {
    searchProvider: 'acme-search',
    fetchProvider: 'http',
    providerSelection: {
      search: { baseId: undefined, userSet: true, userId: 'acme-search' },
      fetch: { baseId: 'http', userSet: false, userId: undefined },
    },
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

  // URL userinfo may itself contain `@`: structured URL parsing treats the
  // LAST `@` as the userinfo/host boundary, so no fragment of the password
  // may survive as a host or path.
  const multipleAt = host({ api: {
    searchBaseURL: 'https://alice:p1@p2@api.example.test/v1/tools',
  } })
  const multipleRead = await new DirectWebProviderConfig(multipleAt.ctx).read()
  assert.equal(multipleRead?.advanced.searchBaseURL, 'https://***@api.example.test/v1/tools',
    'multiple userinfo @ characters are fully masked')
  assert.doesNotMatch(JSON.stringify(multipleRead), /alice|p1|p2/u,
    'no userinfo fragment survives the multi-@ projection')

  // A control-bearing URL is not safe to echo at all; report only configured.
  const newlineUrl = host({ api: {
    searchBaseURL: 'https://api.example.test/v1?token=abc\nSECRET_AFTER_NL',
  } })
  const newlineRead = await new DirectWebProviderConfig(newlineUrl.ctx).read()
  assert.equal(newlineRead?.advanced.searchBaseURL, UNPARSEABLE_WEB_OVERRIDE_URL,
    'an unparseable/control-bearing URL is reported as configured only')
  assert.doesNotMatch(JSON.stringify(newlineRead), /SECRET_AFTER_NL|token=/u,
    'the unparseable URL value never survives the DTO')
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
  await config.setSearchProvider('deepseek-search-api', await captureOf(config))
  await config.setFetchProvider('deepseek-fetch-api', await captureOf(config))
  await config.setSearchApiCount(20, await captureOf(config))
  await config.setSendOriginalQuestion(false, await captureOf(config))
  await config.setSearchBilling('account', await captureOf(config))
  await config.setFetchBilling('api-key', await captureOf(config))
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
  assert.deepEqual(withoutAuthority(await config.read()), {
    searchProvider: 'deepseek-search-api',
    fetchProvider: 'deepseek-fetch-api',
    providerSelection: {
      search: { baseId: undefined, userSet: true, userId: 'deepseek-search-api' },
      fetch: { baseId: 'http', userSet: true, userId: 'deepseek-fetch-api' },
    },
    api: { searchBilling: 'account', fetchBilling: 'api-key', count: 20, sendOriginalQuestion: false },
    advanced: {},
    credential: { configured: false },
  })
})

test('a non-empty Search YAML override refuses the Billing write with zero Host mutation', async () => {
  const h = host({ searchProvider: 'deepseek-search-api', api: { searchBaseURL: 'https://search-gateway.example.test/v1/tools' } })
  const config = new DirectWebProviderConfig(h.ctx)
  const outcome = await config.setSearchBilling('auto', await captureOf(config))
  assert.equal(outcome.kind, 'rejected')
  assert.match(outcome.reason, /overridden by Host YAML/u)
  assert.deepEqual(h.settings.recorded, [], 'the override owns the capability; no billing write is dispatched')
  const read = await config.read()
  assert.deepEqual(read?.advanced, { searchBaseURL: 'https://search-gateway.example.test/v1/tools' },
    'the override remains the Host fact')
})

test('an explicit `auto` billing write is a real persisted choice when eligible', async () => {
  const h = host({ searchProvider: 'deepseek-search-api' })
  const config = new DirectWebProviderConfig(h.ctx)
  await config.setSearchBilling('api-key', await captureOf(config))
  const auto = await config.setSearchBilling('auto', await captureOf(config))
  assert.equal(auto.kind, 'accepted')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['searchBilling'], value: 'api-key' }], revision: 5 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['searchBilling'], value: 'auto' }], revision: 6 },
  ])
  assert.equal((await config.read())?.api.searchBilling, 'auto')
})

test('a custom configured provider id is reported as-is and never silently replaced', async () => {
  const h = host({ searchProvider: 'acme-search' })
  const config = new DirectWebProviderConfig(h.ctx)
  assert.equal((await config.read())?.searchProvider, 'acme-search')
  assert.deepEqual(h.settings.recorded, [], 'a read never writes')
})

test('a custom provider refreshed before a stale Direct intent is never overwritten', async () => {
  for (const item of [
    { field: 'searchProvider', value: 'custom-search', write: (config: DirectWebProviderConfig, capture: WebProviderSettings) => config.setSearchProvider('deepseek-search-api', capture) },
    { field: 'fetchProvider', value: 'custom-fetch', write: (config: DirectWebProviderConfig, capture: WebProviderSettings) => config.setFetchProvider('deepseek-fetch-api', capture) },
  ] as const) {
    const h = host()
    const descriptor = h.settings.descriptors.get('web')!
    const value = descriptor.value as Record<string, unknown>
    value[item.field] = item.value
    descriptor.revision = (descriptor.revision ?? 0) + 1
    const config = new DirectWebProviderConfig(h.ctx)
    assert.equal((await config.read())?.[item.field], item.value,
      'the Direct adapter sees the external custom route before the old intent reaches its setter')
    const outcome = await item.write(config, await captureOf(config))
    assert.equal(outcome.kind, 'rejected')
    assert.match(outcome.reason, /custom route/u)
    assert.equal(value[item.field], item.value)
    assert.deepEqual(h.settings.recorded, [], 'the Direct adapter refuses before Host mutate')
  }
})

test('invalid human input is refused BEFORE any Host write', async () => {
  const h = host({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
  const config = new DirectWebProviderConfig(h.ctx)
  for (const count of [0, 51, 2.5, Number.NaN]) {
    await assert.rejects(config.setSearchApiCount(count, await captureOf(config)), /count must be an integer from 1 through 50/u)
  }
  // The billing mode is the official CLOSED enum; legacy free-form values and
  // typos are refused before the Host settings service is ever consulted. The
  // invalid values are cast through the enum type on purpose: the RUNTIME guard
  // is the subject.
  for (const mode of ['subscription', 'AUTO', 'api_key', '', 'auto '] as readonly string[]) {
    await assert.rejects(config.setSearchBilling(mode as 'auto' | 'account' | 'api-key', await captureOf(config)), /billing mode/u, `refused: ${mode}`)
    await assert.rejects(config.setFetchBilling(mode as 'auto' | 'account' | 'api-key', await captureOf(config)), /billing mode/u, `refused: ${mode}`)
  }
  assert.deepEqual(h.settings.recorded, [], 'a refused input never reaches the Host settings service')
  // The three official modes write their exact field.
  await config.setSearchBilling('api-key', await captureOf(config))
  await config.setFetchBilling('account', await captureOf(config))
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['searchBilling'], value: 'api-key' }], revision: 5 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['fetchBilling'], value: 'account' }], revision: 6 },
  ])
})

test('an unmounted settings section refuses the write instead of inventing a namespace', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  const capture = await captureOf(config)
  h.settings.descriptors.delete('web')
  const webOutcome = await config.setSearchProvider('deepseek-official', capture)
  assert.equal(webOutcome.kind, 'rejected')
  assert.match(webOutcome.reason, /is not mounted/u)

  const apiHost = host()
  const apiConfig = new DirectWebProviderConfig(apiHost.ctx)
  const apiCapture = await captureOf(apiConfig)
  apiHost.settings.descriptors.delete('web-deepseek-api')
  const billingOutcome = await apiConfig.setSearchBilling('account', apiCapture)
  assert.equal(billingOutcome.kind, 'rejected')
  assert.match(billingOutcome.reason, /is not mounted/u)
  const fetchBillingOutcome = await apiConfig.setFetchBilling('account', apiCapture)
  assert.equal(fetchBillingOutcome.kind, 'rejected')
  assert.match(fetchBillingOutcome.reason, /is not mounted/u)
  assert.deepEqual(h.settings.recorded, [])
  assert.deepEqual(apiHost.settings.recorded, [])
})

test('a rejected settings mutation surfaces with its own typed reason (never a silent success)', async () => {
  const h = host({ searchProvider: 'deepseek-official', fetchProvider: 'deepseek-fetch-api' })
  h.settings.mutate = async () => {
    throw Object.assign(new Error('SETTINGS_CONFLICT: revision moved'), { code: 'SETTINGS_CONFLICT' })
  }
  const config = new DirectWebProviderConfig(h.ctx)
  const provider = await config.setSearchProvider('deepseek-search-api', await captureOf(config))
  assert.equal(provider.kind, 'conflict')
  assert.match(provider.reason, /SETTINGS_CONFLICT/u)
  const billing = await config.setFetchBilling('account', await captureOf(config))
  assert.equal(billing.kind, 'conflict')
  assert.match(billing.reason, /SETTINGS_CONFLICT/u)
})

test('the DirectConfigPort exposes the same sub-domain through the assembly', async () => {
  const h = host()
  const port = new DirectConfigPort(h.ctx, undefined, () => undefined)
  assert.equal(port.web.available(), true)
  assert.equal((await port.web.read())?.api.count, 10)
  await port.web.setSendOriginalQuestion(false, await captureOf(port.web))
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['sendOriginalQuestion'], value: false }], revision: 5 },
  ])
})

// ── PR2: the SAME descriptor's USER/base layer projection + official reset ──

test('read() projects the SAME web descriptor value/base/user layers as detached facts', async () => {
  const h = host({
    searchProvider: 'deepseek-search-api',
    fetchProvider: 'deepseek-fetch-api',
    base: { searchProvider: 'deepseek-official', fetchProvider: 'http' },
    user: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
  })
  const read = await new DirectWebProviderConfig(h.ctx).read()
  assert.deepEqual(read?.providerSelection, {
    search: { baseId: 'deepseek-official', userSet: true, userId: 'deepseek-search-api' },
    fetch: { baseId: 'http', userSet: true, userId: 'deepseek-fetch-api' },
  }, 'baseId and the USER own-field are different facts from the effective value')

  // A present but EMPTY raw USER value keeps `userSet: true` with no userId: it
  // is a real override state, never folded into "no override".
  const empty = host({ user: { searchProvider: '' } })
  assert.deepEqual((await new DirectWebProviderConfig(empty.ctx).read())?.providerSelection.search, {
    baseId: undefined,
    userSet: true,
    userId: undefined,
  })
  // A USER value EQUAL to the deployment value is still an own-field override
  // (the plan's AC03): the effective/base comparison cannot see it.
  const equal = host({
    searchProvider: 'deepseek-official',
    base: { fetchProvider: 'http', searchProvider: 'deepseek-official' },
    user: { searchProvider: 'deepseek-official' },
  })
  assert.deepEqual((await new DirectWebProviderConfig(equal.ctx).read())?.providerSelection.search, {
    baseId: 'deepseek-official',
    userSet: true,
    userId: 'deepseek-official',
  })

  // An unreadable layer is UNAVAILABLE, never "no USER override".
  for (const layer of ['base', 'user'] as const) {
    const missing = host()
    Reflect.deleteProperty(missing.settings.descriptors.get('web')!, layer)
    assert.equal(await new DirectWebProviderConfig(missing.ctx).read(), undefined,
      `a missing ${layer} layer makes the whole Web read unavailable`)
  }
})

test('restore providers send the exact official unset at the read revision and skip a true no-op', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  const reset = await config.restoreSearchProvider(await captureOf(config))
  assert.equal(reset.kind, 'accepted')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web', ops: [{ op: 'unset', path: ['searchProvider'] }], revision: 3 },
  ], 'the reset is ONE official unset path op with the descriptor revision')
  // The second reset finds no USER own-field: a real no-op, zero Host writes.
  const noChange = await config.restoreFetchProvider(await captureOf(config))
  assert.equal(noChange.kind, 'no-changes')
  assert.equal(h.settings.recorded.length, 1, 'no unset is dispatched when the USER field is absent')
  // The authoritative read-back reports the post-reset layers/effective value.
  const read = await config.read()
  assert.deepEqual(read?.providerSelection, {
    search: { baseId: undefined, userSet: false, userId: undefined },
    fetch: { baseId: 'http', userSet: false, userId: undefined },
  })
  assert.equal(read?.searchProvider, undefined, 'Search base is absent, so the effective value is Automatic')
  assert.equal(read?.fetchProvider, 'http', 'Fetch keeps the shipped deployment HTTP value')
  assert.deepEqual(read?.api, { searchBilling: 'auto', fetchBilling: 'auto', count: 10, sendOriginalQuestion: true },
    'a provider reset never touches the web-deepseek-api section')
})

test('a CUSTOM effective route is restorable through unset while an explicit official set stays refused', async () => {
  const h = host({
    searchProvider: 'acme-search',
    base: { searchProvider: 'deepseek-official', fetchProvider: 'http' },
    user: { searchProvider: 'acme-search' },
  })
  const config = new DirectWebProviderConfig(h.ctx)
  assert.equal((await config.read())?.providerSelection.search.baseId, 'deepseek-official')
  const refused = await config.setSearchProvider('deepseek-search-api', await captureOf(config))
  assert.equal(refused.kind, 'rejected', 'the explicit-set protection keeps refusing to overwrite a custom route')
  assert.match(refused.reason, /custom route/u)
  assert.deepEqual(h.settings.recorded, [], 'the refused explicit set wrote nothing')
  await config.restoreSearchProvider(await captureOf(config))
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web', ops: [{ op: 'unset', path: ['searchProvider'] }], revision: 3 },
  ], 'the USER reset is the official unset, never a custom-id write')
  const read = await config.read()
  assert.equal(read?.searchProvider, 'deepseek-official', 'the deployment default now applies')
  assert.equal(read?.fetchProvider, 'http', 'the Fetch sibling is untouched')
})

test('an unreadable USER/base layer refuses the reset instead of assuming no override', async () => {
  for (const layer of ['base', 'user'] as const) {
    const h = host()
    const config = new DirectWebProviderConfig(h.ctx)
    const capture = await captureOf(config)
    Reflect.deleteProperty(h.settings.descriptors.get('web')!, layer)
    const search = await config.restoreSearchProvider(capture)
    assert.equal(search.kind, 'rejected')
    assert.match(search.reason, /USER\/base layers/u)
    const fetch = await config.restoreFetchProvider(capture)
    assert.equal(fetch.kind, 'rejected')
    assert.match(fetch.reason, /USER\/base layers/u)
    assert.deepEqual(h.settings.recorded, [], 'an unreadable layer is never a write authorization')
  }
})

test('read() returns the provider layers observed at its synchronous return, not before the credential await', async () => {
  const h = host()
  let releaseCredential: () => void = () => {}
  let credentialStarted = false
  const gate = new Promise<void>(resolve => { releaseCredential = resolve })
  h.credentials.describe = async () => {
    credentialStarted = true
    await gate
    return { configured: false }
  }
  const pending = new DirectWebProviderConfig(h.ctx).read()
  while (!credentialStarted) await new Promise(resolve => setImmediate(resolve))
  // Another writer moves the provider while the credential read is pending.
  const descriptor = h.settings.descriptors.get('web')!
  descriptor.user = { searchProvider: 'deepseek-search-api' }
  descriptor.value = { searchProvider: 'deepseek-search-api', fetchProvider: 'http' }
  descriptor.revision = (descriptor.revision ?? 0) + 1
  releaseCredential()
  const read = await pending
  assert.deepEqual(read?.providerSelection.search, {
    baseId: undefined,
    userSet: true,
    userId: 'deepseek-search-api',
  }, 'the returned layer facts are the state at the synchronous return, not a snapshot the credential read outlived')
  assert.equal(read?.searchProvider, 'deepseek-search-api')
})

// ── SUX-06A: original-generation capture, CAS revision and replacement ──────

test('read() rejects a settings-authority replacement during the credential await; a fresh read gets the new Host', async () => {
  const a = host()
  const b = host({ api: { count: 20 } })
  let current = a
  const ctx: HostContextLike = {
    get: name => name === 'settings'
      ? current.settings
      : name === 'credentials' ? current.credentials : undefined,
  }
  const config = new DirectWebProviderConfig(ctx)
  // A REAL capture from A, before the replacement.
  const captureA = (await config.read())!
  assert.equal(captureA.authority.generation, a.settings)
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  a.credentials.describe = async () => {
    started = true
    await gate
    return { configured: false }
  }
  const pending = config.read()
  while (!started) await new Promise(resolve => setImmediate(resolve))
  current = b
  release()
  await assert.rejects(pending, /authority changed/u)
  const fresh = await config.read()
  assert.equal(fresh?.api.count, 20)
  assert.notEqual(fresh?.authority.generation, a.settings, 'the fresh read belongs to B')
  const outcome = await config.setSearchProvider('deepseek-search-api', captureA)
  assert.equal(outcome.kind, 'rejected')
  assert.match(outcome.reason, /authority changed/u)
  assert.deepEqual(a.settings.recorded, [])
  assert.deepEqual(b.settings.recorded, [], 'the stale A capture never reached B')
  // A FRESH B gesture is the only request that reaches B, and it writes at B's
  // own revision.
  const freshWrite = await config.setSearchProvider('deepseek-search-api', fresh!)
  assert.equal(freshWrite.kind, 'accepted')
  assert.equal(b.settings.recorded.length, 1)
  assert.equal((b.settings.descriptors.get('web')?.value as Record<string, unknown>).searchProvider, 'deepseek-search-api')
})

test('a readable revision 0 is a valid CAS token', async () => {
  const h = host()
  h.settings.descriptors.get('web')!.revision = 0
  h.settings.descriptors.get('web-deepseek-api')!.revision = 0
  const config = new DirectWebProviderConfig(h.ctx)
  const capture = await captureOf(config)
  assert.equal(capture.authority.webRevision, 0)
  assert.equal(capture.authority.apiRevision, 0)
  const outcome = await config.setSearchApiCount(20, capture)
  assert.equal(outcome.kind, 'accepted')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['count'], value: 20 }], revision: 0 },
  ])
})

test('a malformed namespace revision makes the read unavailable and refuses every write', async () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const h = host()
    const config = new DirectWebProviderConfig(h.ctx)
    const capture = await captureOf(config)
    h.settings.descriptors.get('web')!.revision = bad
    assert.equal(await config.read(), undefined, `revision ${String(bad)} must not authorize a read`)
    const outcome = await config.setSearchProvider('deepseek-search-api', capture)
    assert.equal(outcome.kind, 'rejected')
    assert.match(outcome.reason, /revision is not readable/u)
    assert.deepEqual(h.settings.recorded, [], 'a malformed revision never reaches the Host mutate')
  }
})

// ── SUX-06A: real-adapter no-op and second-line guards ──────────────────────

test('an explicit select already pinned in the USER layer is a zero-write no-changes', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  const capture = await captureOf(config)
  assert.equal(capture.providerSelection.search.userSet, true)
  assert.equal(capture.providerSelection.search.userId, 'deepseek-official')
  const outcome = await config.setSearchProvider('deepseek-official', capture)
  assert.equal(outcome.kind, 'no-changes')
  assert.deepEqual(h.settings.recorded, [], 'the explicit pin needs no Host mutation')
})

test('Direct Billing re-proves the web provider dependency revision', async () => {
  const h = host({ searchProvider: 'deepseek-search-api' })
  const config = new DirectWebProviderConfig(h.ctx)
  const capture = await captureOf(config)
  const web = h.settings.descriptors.get('web')!
  web.value = { ...(web.value as Record<string, unknown>), fetchProvider: 'deepseek-fetch-api' }
  web.user = { ...(web.user as Record<string, unknown>), fetchProvider: 'deepseek-fetch-api' }
  web.revision = (web.revision ?? 0) + 1
  const outcome = await config.setSearchBilling('account', capture)
  assert.equal(outcome.kind, 'conflict')
  assert.match(outcome.reason, /dependency changed since it was read/u)
  assert.deepEqual(h.settings.recorded, [], 'the API revision never dispatches without its web dependency')
})

test('Direct provider writes re-prove the same-revision base/USER facts', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  const capture = await captureOf(config)
  const web = h.settings.descriptors.get('web')!
  // Same numeric revision, different USER/base projection: the captured
  // decision no longer describes this Host state.
  web.value = { ...(web.value as Record<string, unknown>), searchProvider: 'deepseek-search-api' }
  web.user = { ...(web.user as Record<string, unknown>), searchProvider: 'deepseek-search-api' }
  const outcome = await config.setSearchProvider('deepseek-official', capture)
  assert.equal(outcome.kind, 'rejected')
  assert.match(outcome.reason, /selection changed since the page read it/u)
  assert.deepEqual(h.settings.recorded, [], 'a same-revision semantic drift never reaches the Host mutate')
})

test('a half-mounted Web observation is never current, even for the readable target', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  const capture = await captureOf(config)
  assert.equal(config.isObservationCurrent(capture, 'api'), true)
  h.settings.descriptors.delete('web')
  assert.equal(config.isObservationCurrent(capture, 'api'), false,
    'a missing web descriptor cannot authorize even an API-only write')
})
