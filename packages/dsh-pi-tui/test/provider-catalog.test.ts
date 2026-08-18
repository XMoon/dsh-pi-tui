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
  type ProviderCatalogEntry,
  type ProviderOption,
} from '../src/provider-catalog.ts'

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

const readSection = (ns: string): unknown => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined)

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
  const options = providerOptionsFor(entries, readSection)
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
  // The deepseek profile's ref is the official one: deduped, one entry only.
  assert.equal(options.filter(option => option.ref === 'DEEPSEEK_API_KEY').length, 1)
  // A hand-declared route with no profile yet: derived ref, custom group.
  // (Its derived ref collides with the configured `acme` profile's stored
  // ref — the merge dedupes by ref, so the acme-gateway entry is the one
  // dropped. This mirrors the web Models page behavior.)
  assert.equal(byRoute.get('acme-gateway'), undefined)
  assert.equal(options.filter(option => option.ref === 'ACME_GATEWAY_API_KEY').length, 1)
  // A catalog route with no profile: derived ref, available group.
  assert.equal(byRoute.get('openrouter')?.ref, 'OPENROUTER_API_KEY')
  assert.equal(byRoute.get('openrouter')?.configured, false)
  assert.equal(byRoute.get('openrouter')?.declared, false)
  assert.equal(byRoute.get('openrouter')?.group, 'available')
})

test('providerOptionsFor degrades to the official target without a directory', () => {
  const options = providerOptionsFor(undefined, readSection)
  assert.deepEqual(options.map(option => option.label), ['deepseek official'])
})

test('providerOptionsFor ignores entries with missing identity', () => {
  const entries: ProviderCatalogEntry[] = [
    { provider: '', displayName: '', settingsNs: 'llm-pi-ai', settingsPath: [] },
    { provider: 'openai', displayName: 'openai', settingsNs: '', settingsPath: [] },
  ]
  const options = providerOptionsFor(entries, readSection)
  assert.deepEqual(options.map(option => option.label), ['deepseek official'])
})
