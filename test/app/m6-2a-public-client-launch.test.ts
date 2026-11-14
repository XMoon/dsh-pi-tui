/**
 * M6-2A public Client launch: the private v1 envelope decoder that carries the
 * public `sessionLaunch`/`presetId` intent into the surface Client, its
 * mutual exclusion with the internal exact Session channel, and the reexec
 * environment that must DROP the envelope.
 *
 * Evidence level: structural. These exercise the pure boundary functions of
 * the real Client entry (no process/Host is started); the real public `dsh`
 * path is the packed smoke's job.
 * @module @xmoon76/dsh-pi-tui/m6-2a-public-client-launch.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeClientLaunchEnvelope,
  surfaceStartupFacts,
  createClientReexecChildEnvironment,
  type ClientLaunchEnvelope,
} from '../../src/app/remote-process/local-client-entry.ts'

const SESSION_ENV = 'SPLIT_PROCESS_CLIENT_SESSION'
const PRESET_ENV = 'SPLIT_PROCESS_CLIENT_PRESET'
const ENVELOPE_ENV = 'SPLIT_PROCESS_CLIENT_LAUNCH_V1'

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── envelope decoding (positive) ─────────────────────────────────────────

test('decodes a browse envelope with an empty query', () => {
  const envelope = decodeClientLaunchEnvelope(JSON.stringify({ version: 1, sessionLaunch: { kind: 'browse', query: '' } }))
  assert.deepEqual(envelope.sessionLaunch, { kind: 'browse', query: '' })
})

test('decodes a lookup envelope with a non-empty query', () => {
  const envelope = decodeClientLaunchEnvelope(JSON.stringify({ version: 1, sessionLaunch: { kind: 'lookup', query: 'mysql' } }))
  assert.deepEqual(envelope.sessionLaunch, { kind: 'lookup', query: 'mysql' })
})

test('decodes a continue envelope (no query) and a preset', () => {
  const envelope = decodeClientLaunchEnvelope(JSON.stringify({ version: 1, sessionLaunch: { kind: 'continue' }, presetId: 'minimal' }))
  assert.deepEqual(envelope.sessionLaunch, { kind: 'continue' })
  assert.equal(envelope.presetId, 'minimal')
})

// ── envelope decoding (negative: fail closed) ────────────────────────────

for (const [label, raw] of [
  ['invalid JSON', '{not json'],
  ['not an object', '[]'],
  ['unknown key', JSON.stringify({ version: 1, extra: true })],
  ['wrong version', JSON.stringify({ version: 2 })],
  ['browse with a non-empty query', JSON.stringify({ version: 1, sessionLaunch: { kind: 'browse', query: 'x' } })],
  ['lookup with an empty query', JSON.stringify({ version: 1, sessionLaunch: { kind: 'lookup', query: '   ' } })],
  ['continue carrying a query', JSON.stringify({ version: 1, sessionLaunch: { kind: 'continue', query: 'x' } })],
  ['unknown launch kind', JSON.stringify({ version: 1, sessionLaunch: { kind: 'resume' } })],
  ['empty presetId', JSON.stringify({ version: 1, presetId: '' })],
  ['oversized envelope', JSON.stringify({ version: 1, sessionLaunch: { kind: 'lookup', query: 'x'.repeat(17 * 1024) } })],
] as const) {
  test(`rejects an envelope: ${label}`, () => {
    assert.throws(() => decodeClientLaunchEnvelope(raw), /local client entry:/u)
  })
}

// ── surfaceStartupFacts: envelope vs exact channel ───────────────────────

const SURFACE = { dshAnchor: '/x/@deepseek-ai/dsh/package.json', profile: 'pi-tui', mode: 'surface' as const }

test('the envelope drives the public sessionLaunch, not an exact sessionId', () => {
  const envelope: ClientLaunchEnvelope = { sessionLaunch: { kind: 'lookup', query: 'mysql' }, presetId: 'std' }
  const facts = withEnv({ [SESSION_ENV]: undefined, [PRESET_ENV]: undefined }, () => surfaceStartupFacts(SURFACE, envelope))
  assert.deepEqual(facts, { sessionLaunch: { kind: 'lookup', query: 'mysql' }, presetId: 'std' })
})

test('a bare launch yields no facts (sessionless)', () => {
  const facts = withEnv({ [SESSION_ENV]: undefined, [PRESET_ENV]: undefined }, () => surfaceStartupFacts(SURFACE, undefined))
  assert.deepEqual(facts, {})
})

test('the internal exact sessionId channel is preserved when no envelope exists', () => {
  const facts = withEnv({ [SESSION_ENV]: 'abc-123', [PRESET_ENV]: 'std' }, () => surfaceStartupFacts(SURFACE, undefined))
  assert.deepEqual(facts, { sessionId: 'abc-123', presetId: 'std' })
})

test('an envelope and an exact Session channel are mutually exclusive', () => {
  const envelope: ClientLaunchEnvelope = { sessionLaunch: { kind: 'continue' } }
  assert.throws(
    () => withEnv({ [SESSION_ENV]: 'abc-123', [PRESET_ENV]: undefined }, () => surfaceStartupFacts(SURFACE, envelope)),
    /mutually exclusive/u,
  )
})

test('a non-surface mode ignores the envelope entirely', () => {
  const envelope: ClientLaunchEnvelope = { sessionLaunch: { kind: 'lookup', query: 'mysql' } }
  const facts = withEnv({ [SESSION_ENV]: 'abc-123' }, () => surfaceStartupFacts({ ...SURFACE, mode: 'qualification' }, envelope))
  assert.deepEqual(facts, {})
})

// ── reexec environment drops the envelope ────────────────────────────────

test('the replacement-Client environment drops the public launch envelope', () => {
  const intent = {
    expectedInstanceId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'abc-123',
    dshAnchor: '/x/@deepseek-ai/dsh/package.json',
    profile: 'pi-tui',
    dshVersion: '0.2.2-rc.3',
    targetPackageRoot: '/x/pkg',
    targetEntry: '/x/pkg/dist/local-client.mjs',
    targetBuildId: 'b',
    targetBundleVersion: '0.5.7',
  }
  const env = createClientReexecChildEnvironment(intent, {
    [ENVELOPE_ENV]: JSON.stringify({ version: 1, sessionLaunch: { kind: 'continue' } }),
    SPLIT_PROCESS_CLIENT_PRESET: 'std',
  })
  assert.equal(env[ENVELOPE_ENV], undefined, 'the envelope never rides the handoff')
  assert.equal(env[SESSION_ENV], 'abc-123', 'the confirmed exact Session is restored instead')
  assert.equal(env[PRESET_ENV], undefined, 'a handoff never creates via preset')
})
