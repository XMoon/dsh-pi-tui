/**
 * S2/PR-B §3.2 — the Direct Web provider config contract.
 *
 * The adapter is the ONLY write path to the official `web` / `web-deepseek-api`
 * settings sections: every case here asserts the exact namespace, path and
 * revision the Host receives, the read-back the UI must use, and the refusal
 * paths (missing section, non-volatile/absent value, rejected revision,
 * invalid human input) that must never be reported as a save.
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
import { DirectConfigPort, DirectWebProviderConfig } from '../src/runtime/direct/config-direct.ts'
import type { HostContextLike } from '../src/runtime/direct/config-direct.ts'

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

/** One live Web settings store: the two official sections with their shipped
 *  values, plus the credential presence the Direct adapter reports. */
function host(options: {
  readonly searchProvider?: string
  readonly fetchProvider?: string
  readonly credential?: { configured: boolean; source?: string }
  readonly omitApi?: boolean
  readonly omitWeb?: boolean
  readonly credentialService?: boolean
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
        value: { baseURL: 'https://api.deepseek.com/v1/tools', count: 10, sendOriginalQuestion: true },
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

test('read() maps the official sections, the credential presence and nothing else', async () => {
  const h = host({ credential: { configured: true, source: 'file' }, searchProvider: 'acme-search' })
  const config = new DirectWebProviderConfig(h.ctx)
  const settings = await config.read()
  assert.deepEqual(settings, {
    searchProvider: 'acme-search',
    fetchProvider: 'http',
    api: { baseURL: 'https://api.deepseek.com/v1/tools', count: 10, sendOriginalQuestion: true },
    credential: { configured: true, source: 'file' },
  })
  assert.deepEqual(h.describes, ['DEEPSEEK_API_KEY'], 'presence is read from the official reference, never a value')
  assert.equal(config.available(), true)
})

test('read() reports UNAVAILABLE for a missing section instead of shipped defaults', async () => {
  assert.equal(await new DirectWebProviderConfig(host({ omitWeb: true }).ctx).read(), undefined,
    'without the provider section there is no fact to report')
  assert.equal(new DirectWebProviderConfig(host({ omitWeb: true }).ctx).available(), false)
  assert.equal(await new DirectWebProviderConfig(host({ omitApi: true }).ctx).read(), undefined,
    'without the API section the API facts are unavailable, never defaulted')
  // A malformed value is unavailable too (never coerced).
  const malformed = host()
  malformed.settings.descriptors.set('web-deepseek-api', {
    ns: 'web-deepseek-api',
    revision: 1,
    value: { baseURL: 'https://api.deepseek.com/v1/tools', count: 'ten', sendOriginalQuestion: true },
  })
  assert.equal(await new DirectWebProviderConfig(malformed.ctx).read(), undefined)
  // An unmounted credential store answers "not configured" exactly like the
  // Direct /login port does, and never invents a source.
  assert.deepEqual((await new DirectWebProviderConfig(host({ credentialService: false }).ctx).read())?.credential, { configured: false })
})

test('the provider selections and API options write the exact official path with the CURRENT revision', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  await config.setSearchProvider('deepseek-search-api')
  await config.setFetchProvider('deepseek-fetch-api')
  await config.setSearchApiCount(20)
  await config.setSendOriginalQuestion(false)
  await config.setSearchApiBaseURL('https://api.example.com/v1/tools')
  assert.deepEqual(h.settings.recorded, [
    { ns: 'web', ops: [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }], revision: 3 },
    { ns: 'web', ops: [{ op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' }], revision: 4 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['count'], value: 20 }], revision: 5 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['sendOriginalQuestion'], value: false }], revision: 6 },
    { ns: 'web-deepseek-api', ops: [{ op: 'set', path: ['baseURL'], value: 'https://api.example.com/v1/tools' }], revision: 7 },
  ])
  // The read-back is the authority the UI must display.
  assert.deepEqual(await config.read(), {
    searchProvider: 'deepseek-search-api',
    fetchProvider: 'deepseek-fetch-api',
    api: { baseURL: 'https://api.example.com/v1/tools', count: 20, sendOriginalQuestion: false },
    credential: { configured: false },
  })
})

test('a custom configured provider id is reported as-is and never silently replaced', async () => {
  const h = host({ searchProvider: 'acme-search' })
  const config = new DirectWebProviderConfig(h.ctx)
  assert.equal((await config.read())?.searchProvider, 'acme-search')
  assert.deepEqual(h.settings.recorded, [], 'a read never writes')
})

test('invalid human input is refused BEFORE any Host write', async () => {
  const h = host()
  const config = new DirectWebProviderConfig(h.ctx)
  for (const count of [0, 51, 2.5, Number.NaN]) {
    await assert.rejects(config.setSearchApiCount(count), /count must be an integer from 1 through 50/u)
  }
  for (const url of [
    'http://api.example.com/v1/tools',
    'not-a-url',
    'https://user:secret@api.example.com/v1/tools',
    'https://api.example.com/v1/tools?key=x',
    'https://api.example.com/v1/tools#frag',
    'https://api.example.com/v1/tools/search',
    'https://api.example.com/v1/tools/fetch',
  ]) {
    await assert.rejects(config.setSearchApiBaseURL(url), /endpoint/u, `refused: ${url}`)
  }
  assert.deepEqual(h.settings.recorded, [], 'a refused input never reaches the Host settings service')
  // The same rule accepts the official base and a custom https base.
  await config.setSearchApiBaseURL('https://api.deepseek.com/v1/tools')
  await config.setSearchApiBaseURL('https://gateway.example.com/deepseek/v1/tools')
  assert.equal(h.settings.recorded.length, 2)
})

test('an unmounted settings section refuses the write instead of inventing a namespace', async () => {
  const h = host({ omitWeb: true })
  const config = new DirectWebProviderConfig(h.ctx)
  await assert.rejects(config.setSearchProvider('deepseek-official'), /is not mounted/u)
  assert.deepEqual(h.settings.recorded, [])
})

test('a rejected settings mutation surfaces with its own reason (never a silent success)', async () => {
  const h = host()
  h.settings.mutate = async () => { throw new Error('SETTINGS_CONFLICT: revision moved') }
  const config = new DirectWebProviderConfig(h.ctx)
  await assert.rejects(config.setSearchProvider('deepseek-search-api'), /SETTINGS_CONFLICT/u)
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
