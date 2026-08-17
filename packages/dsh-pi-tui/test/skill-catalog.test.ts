/**
 * Headless tests for the standing-scope skill catalog adapter (M1): the
 * collector (snapshot-first, list() compatibility, official policy filter,
 * hostile-field rejection, stable sort, freeze, distinct abort
 * propagation) and the capability-gated cold/live target resolution —
 * including the degradation matrix that keeps the TUI alive when an
 * upstream capability is missing or fails (plan appendix B).
 * @module @xmoon76/dsh-pi-tui/skill-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readHumanSkillCatalog,
  resolveColdSkillTarget,
  resolveLiveSkillTarget,
  type AgentPresetsLike,
  type SkillCatalogContext,
  type SkillCatalogReadOptions,
  type SkillRegistryLike,
  type SkillSummaryLike,
} from '../src/skill-catalog.ts'

/** A catalog entry helper with the full invocation policy. */
function skill(name: string, userInvocable: boolean, extra: Partial<SkillSummaryLike> = {}): SkillSummaryLike {
  return {
    name,
    description: `desc-${name}`,
    invocation: { modelInvocable: true, userInvocable },
    ...extra,
  }
}

/** A scripted registry exposing snapshot and/or list. */
function fakeRegistry(script: {
  snapshot?: (options: SkillCatalogReadOptions) => Promise<{ skills: readonly SkillSummaryLike[]; complete: boolean }> | never
  list?: (options: SkillCatalogReadOptions) => Promise<readonly SkillSummaryLike[]> | never
} = {}): SkillRegistryLike {
  return {
    ...script.snapshot === undefined ? {} : { snapshot: script.snapshot },
    ...script.list === undefined ? {} : { list: script.list },
  }
}

function fakeCtx(services: {
  skills?: SkillRegistryLike
  presets?: AgentPresetsLike
}): SkillCatalogContext {
  return {
    get: ((name: 'skills' | 'agentPresets') => {
      if (name === 'skills') return services.skills
      return services.presets
    }) as SkillCatalogContext['get'],
  }
}

test('the collector uses snapshot-first, filters with the official policy, sorts and freezes', async () => {
  let options: SkillCatalogReadOptions | undefined
  const registry = fakeRegistry({
    snapshot: async (opts) => {
      options = opts
      return {
        complete: true,
        skills: [
          skill('zzz', true, { whenToUse: 'late alphabet' }),
          skill('model-only', false),
          skill('aaa', true),
        ],
      }
    },
  })
  const catalog = await readHumanSkillCatalog(registry, { cwd: '/ws', scope: {}, signal: new AbortController().signal })
  assert.deepEqual(catalog.skills.map(item => item.name), ['aaa', 'zzz'], 'only user-invocable skills, name-sorted')
  assert.equal(catalog.skills[1]?.whenToUse, 'late alphabet', 'whenToUse is copied')
  assert.equal(catalog.complete, true)
  assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.skills))
  assert.ok(Object.isFrozen(catalog.skills[0]))
  assert.deepEqual(Object.keys(catalog.skills[1]!).sort(), ['description', 'name', 'whenToUse'],
    'the entry carrying whenToUse keeps exactly the supported display fields')
  assert.equal(options?.cwd, '/ws')
})

test('without snapshot the collector falls back to list() and treats the observation as complete', async () => {
  let listCalled = false
  const registry = fakeRegistry({
    list: async () => {
      listCalled = true
      return [skill('listed', true)]
    },
  })
  const catalog = await readHumanSkillCatalog(registry, { cwd: '/ws', signal: new AbortController().signal })
  assert.equal(listCalled, true)
  assert.deepEqual(catalog.skills.map(item => item.name), ['listed'])
  assert.equal(catalog.complete, true, 'the list() compatibility path is a complete observation')
})

test('an incomplete snapshot is marked incomplete, never treated as authoritative', async () => {
  const registry = fakeRegistry({
    snapshot: async () => ({ complete: false, skills: [skill('partial', true)] }),
  })
  const catalog = await readHumanSkillCatalog(registry, { cwd: '/ws', signal: new AbortController().signal })
  assert.equal(catalog.complete, false, 'the incomplete bit must survive for the last-good retention logic')
  assert.deepEqual(catalog.skills.map(item => item.name), ['partial'])
})

test('malformed and hostile fields are rejected conservatively, never copied or thrown on', async () => {
  const hostile = { toString: () => { throw new Error('hostile') } } as never
  const registry = fakeRegistry({
    snapshot: async () => ({
      complete: true,
      skills: [
        skill('ok', true),
        { name: 42, description: 'non-string name', invocation: { userInvocable: true } } as never,
        { name: 'no-desc', description: hostile, invocation: { userInvocable: true } } as never,
        skill('no-whenuse', true, { whenToUse: hostile } as never),
        { name: 'no-invocation', description: 'd' } as never,
        { name: 'bad-invocation', description: 'd', invocation: { userInvocable: 'yes' } } as never,
      ],
    }),
  })
  const catalog = await readHumanSkillCatalog(registry, { cwd: '/ws', signal: new AbortController().signal })
  assert.deepEqual(
    catalog.skills.map(item => item.name),
    ['no-whenuse', 'ok'],
    'only well-formed user-invocable entries survive; malformed entries are skipped',
  )
  assert.equal(catalog.skills[0]?.whenToUse, undefined, 'a hostile whenToUse is dropped, not copied')
})

test('a non-abort read failure rethrows for the coordinator to classify', async () => {
  const registry = fakeRegistry({
    snapshot: async () => { throw new Error('registry exploded') },
  })
  await assert.rejects(
    readHumanSkillCatalog(registry, { cwd: '/ws', signal: new AbortController().signal }),
    /registry exploded/,
  )
})

test('cancellation propagates distinctly, both before and after the read', async () => {
  const controller = new AbortController()
  controller.abort()
  const registry = fakeRegistry({
    snapshot: async () => { throw new Error('must not run') },
  })
  await assert.rejects(
    readHumanSkillCatalog(registry, { cwd: '/ws', signal: controller.signal }),
    (error: unknown) => (error as Error).name === 'AbortError',
  )
  // Abort WHILE the read is in flight: a signal-honoring registry rejects
  // with the abort, which propagates distinctly (like the real registry,
  // which races provider reads against the signal).
  const midController = new AbortController()
  const mid = fakeRegistry({
    snapshot: async (opts) => {
      if (opts.signal?.aborted === true) throw abortError()
      await new Promise<never>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      })
      throw new Error('unreachable')
    },
  })
  const run = readHumanSkillCatalog(mid, { cwd: '/ws', signal: midController.signal })
  midController.abort()
  await assert.rejects(run, (error: unknown) => (error as Error).name === 'AbortError')
})

/** A cancellation-shaped rejection like the real registry produces. */
function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

test('the cold target resolves the standing scope of the effective preset', async () => {
  const key = { agentPreset: 'fixture' }
  const registry = fakeRegistry({})
  const presets: AgentPresetsLike = {
    standingKeyFor: async (id) => {
      assert.equal(id, 'fixture')
      return key
    },
  }
  const resolution = await resolveColdSkillTarget(fakeCtx({ skills: registry, presets }), 'fixture', '/ws')
  assert.equal(resolution.target?.kind, 'cold-standing')
  assert.equal(resolution.target?.scope, key, 'the standing key is the view scope')
  assert.equal(resolution.target?.registry, registry)
  assert.equal(resolution.degraded, undefined)
})

test('a rosterless deployment resolves the global cold view with no scope', async () => {
  const registry = fakeRegistry({})
  const resolution = await resolveColdSkillTarget(fakeCtx({ skills: registry }), undefined, '/ws')
  assert.equal(resolution.target?.kind, 'cold-global')
  assert.equal(resolution.target?.scope, undefined)
  assert.equal(resolution.degraded, undefined)
})

test('a missing standingKeyFor capability degrades to the global view (upstream API drift)', async () => {
  const registry = fakeRegistry({})
  const resolution = await resolveColdSkillTarget(
    fakeCtx({ skills: registry, presets: { serviceFor: () => undefined } }),
    'fixture',
    '/ws',
  )
  assert.equal(resolution.target?.kind, 'cold-global', 'capability detection must degrade, not crash')
  assert.equal(resolution.degraded, undefined, 'a missing capability is a quiet degradation, not a failure notice')
})

test('a standingKeyFor failure degrades to the global view with a one-shot notice', async () => {
  const registry = fakeRegistry({})
  const presets: AgentPresetsLike = {
    standingKeyFor: async () => { throw new Error('preset broken') },
  }
  const resolution = await resolveColdSkillTarget(fakeCtx({ skills: registry, presets }), 'broken', '/ws')
  assert.equal(resolution.target?.kind, 'cold-global', 'a broken preset still serves the global view')
  assert.match(resolution.degraded ?? '', /skill catalog unavailable for preset "broken": preset broken/)
})

test('a hostile standingKeyFor rejection degrades through safeErrorMessage, never escapes', async () => {
  const hostile = { toString: () => { throw new Error('hostile') } } as never
  const registry = fakeRegistry({})
  const presets: AgentPresetsLike = {
    standingKeyFor: async () => { throw hostile },
  }
  const resolution = await resolveColdSkillTarget(fakeCtx({ skills: registry, presets }), 'x', '/ws')
  assert.equal(resolution.target?.kind, 'cold-global')
  assert.ok((resolution.degraded ?? '').length > 0, 'the notice carries safe text, never the hostile value')
})

test('no skill registry resolves no cold target at all', async () => {
  const resolution = await resolveColdSkillTarget(fakeCtx({}), 'fixture', '/ws')
  assert.equal(resolution.target, undefined)
  assert.equal(resolution.degraded, undefined)
})

test('the live target prefers the preset-scoped registry and always scopes by the AGENT object', () => {
  const scoped = fakeRegistry({})
  const host = fakeRegistry({})
  let resolvedFor: unknown
  const presets: AgentPresetsLike = {
    serviceFor: (agent, name) => {
      resolvedFor = agent
      assert.equal(name, 'skills')
      return scoped
    },
  }
  const agent = { ctx: {} }
  const target = resolveLiveSkillTarget(fakeCtx({ skills: host, presets }), agent, '/ws')
  assert.equal(target?.kind, 'live')
  assert.equal(target?.registry, scoped, 'the preset-scoped registry wins over the host one')
  assert.equal(target?.scope, agent, 'the view scope is the AGENT object')
  assert.equal(resolvedFor, agent)
})

test('the live target falls back to the host registry without a preset-scoped one', () => {
  const host = fakeRegistry({})
  const agent = { ctx: {} }
  const target = resolveLiveSkillTarget(fakeCtx({ skills: host }), agent, '/ws')
  assert.equal(target?.registry, host)
  assert.equal(target?.scope, agent, 'the live view scope is always the agent object')
})

test('no reachable registry resolves no live target', () => {
  assert.equal(resolveLiveSkillTarget(fakeCtx({}), { ctx: {} }, '/ws'), undefined)
})
