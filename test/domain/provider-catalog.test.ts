/**
 * Headless tests for the /login provider catalog surface: the pure merge of
 * the llm configurable-provider directory with the settings section, the
 * derived credential references, the route-pattern gate, and the picker row
 * builder. The handler flows themselves live in login-credentials.test.ts.
 * @module @xmoon76/dsh-pi-tui/provider-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ROUTE_PATTERN,
  deriveKeyRef,
  getPath,
  providerOptionsFor,
  providerProfileProjectionOf,
  type ProviderCatalogEntry,
  type ProviderOption,
} from '../../src/domain/catalog/provider.ts'

/** A settings section the pi-ai adapter would register. */
const LLM_PI_AI_SECTION = {
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    acme: { apiKeyEnv: 'ACME_GATEWAY_API_KEY' },
    // A route that never names a credential (provider-native discovery).
    anthropic: { apiKeyEnv: undefined },
  },
}

/** Project one directory entry's profile out of a settings section — the
 *  adapter's single-snapshot projection. */
const readProfile = (section: unknown) => (entry: ProviderCatalogEntry) =>
  providerProfileProjectionOf(getPath(section, entry.settingsPath))

test('getPath walks dotted paths into plain objects', () => {
  const section = { providers: { acme: { apiKeyEnv: 'ACME_API_KEY' } } }
  assert.equal(getPath(section, ['providers', 'acme', 'apiKeyEnv']), 'ACME_API_KEY')
  assert.equal(getPath(section, ['providers', 'missing']), undefined)
  assert.equal(getPath(section, ['providers', 'acme', 'missing']), undefined)
  assert.equal(getPath(section, []), section)
  assert.equal(getPath(null, ['a']), undefined)
  assert.equal(getPath('str', ['a']), undefined)
})

test('deriveKeyRef matches the web Models page derivation', () => {
  assert.equal(deriveKeyRef('anthropic'), 'ANTHROPIC_API_KEY')
  assert.equal(deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
  assert.equal(deriveKeyRef('acme-gateway'), 'ACME_GATEWAY_API_KEY')
  assert.equal(deriveKeyRef('deepseek-official'), 'DEEPSEEK_OFFICIAL_API_KEY')
})

test('ROUTE_PATTERN accepts valid route ids and refuses leading digits', () => {
  assert.equal(ROUTE_PATTERN.test('acme-gateway'), true)
  assert.equal(ROUTE_PATTERN.test('anthropic'), true)
  assert.equal(ROUTE_PATTERN.test('a'), true)
  assert.equal(ROUTE_PATTERN.test('a1-b2'), true)
  assert.equal(ROUTE_PATTERN.test('1acme'), false)
  assert.equal(ROUTE_PATTERN.test('Acme'), false)
  assert.equal(ROUTE_PATTERN.test('acme_gateway'), false)
  assert.equal(ROUTE_PATTERN.test(''), false)
})

test('providerOptionsFor merges the directory with the settings section', () => {
  const entries: ProviderCatalogEntry[] = [
    { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
    // A hand-declared route with a stored profile.
    { provider: 'acme', displayName: 'Acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'], declared: true },
    // A hand-declared route with NO stored profile yet (the add case).
    { provider: 'acme-gateway', displayName: 'Acme Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme-gateway'], declared: true },
    // A catalog route with no profile and no apiKeyEnv yet.
    { provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
  ]
  const options = providerOptionsFor(entries, readProfile(LLM_PI_AI_SECTION))
  // Deepseek official always leads.
  assert.equal(options[0]?.label, 'deepseek official')
  assert.equal(options[0]?.ref, 'DEEPSEEK_API_KEY')
  const byRoute = new Map(options.map(option => [option.route, option]))
  // Configured profile routes keep their stored apiKeyEnv.
  assert.equal(byRoute.get('openai')?.ref, 'OPENAI_API_KEY')
  assert.equal(byRoute.get('openai')?.configured, true)
  assert.equal(byRoute.get('openai')?.group, 'configured')
  assert.equal(byRoute.get('acme')?.ref, 'ACME_GATEWAY_API_KEY')
  assert.equal(byRoute.get('acme')?.configured, true)
  // A stored profile that never names a credential falls back to the derived ref.
  assert.equal(byRoute.get('anthropic')?.ref, 'ANTHROPIC_API_KEY')
  assert.equal(byRoute.get('anthropic')?.configured, true)
  // The deepseek profile's ref is the official one, and the directory offers
  // no `deepseek` route of its own: one entry, one route.
  assert.equal(options.filter(option => option.ref === 'DEEPSEEK_API_KEY').length, 1)
  // A hand-declared route with no profile yet: derived ref, custom group. It
  // SHARES the reference the configured `acme` profile names, and both stay
  // visible — two providers, one credential target.
  assert.equal(byRoute.get('acme-gateway')?.ref, 'ACME_GATEWAY_API_KEY')
  assert.equal(byRoute.get('acme-gateway')?.configured, false)
  assert.equal(byRoute.get('acme-gateway')?.group, 'custom')
  assert.equal(options.filter(option => option.ref === 'ACME_GATEWAY_API_KEY').length, 2)
  // A catalog route with no profile: derived ref, available group.
  assert.equal(byRoute.get('openrouter')?.ref, 'OPENROUTER_API_KEY')
  assert.equal(byRoute.get('openrouter')?.configured, false)
  assert.equal(byRoute.get('openrouter')?.declared, false)
  assert.equal(byRoute.get('openrouter')?.group, 'available')
})

test('providerOptionsFor keeps every route that shares one credential reference', () => {
  const entries: ProviderCatalogEntry[] = [
    { provider: 'alpha', displayName: 'Alpha', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'alpha'] },
    { provider: 'beta', displayName: 'Beta', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'beta'] },
  ]
  const section = { providers: { alpha: { apiKeyEnv: 'SHARED_API_KEY' }, beta: { apiKeyEnv: 'SHARED_API_KEY' } } }
  const options = providerOptionsFor(entries, readProfile(section))
  assert.deepEqual(options.map(option => option.route), ['deepseek-official', 'alpha', 'beta'])
  // One reference, two provider rows: the reference is read once, the
  // providers stay distinct.
  assert.deepEqual(options.map(option => option.ref), ['DEEPSEEK_API_KEY', 'SHARED_API_KEY', 'SHARED_API_KEY'])
  assert.equal(options.filter(option => option.ref === 'SHARED_API_KEY').length, 2)
})

test('providerOptionsFor degrades to the official target without a directory', () => {
  const options = providerOptionsFor(undefined, readProfile(LLM_PI_AI_SECTION))
  assert.deepEqual(options.map(option => option.label), ['deepseek official'])
})

test('providerOptionsFor ignores entries with missing identity', () => {
  const entries: ProviderCatalogEntry[] = [
    { provider: '', displayName: '', settingsNs: 'llm-pi-ai', settingsPath: [] },
    { provider: 'openai', displayName: 'openai', settingsNs: '', settingsPath: [] },
  ]
  const options = providerOptionsFor(entries, readProfile(LLM_PI_AI_SECTION))
  assert.deepEqual(options.map(option => option.label), ['deepseek official'])
})
