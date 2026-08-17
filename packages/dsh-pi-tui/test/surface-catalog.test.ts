/**
 * Headless unit tests for the surface catalog collector: command scope and
 * shadow derivation, the human-invocation policy filter, provider isolation,
 * cancellation propagation, stable sorting, and full detachment (frozen
 * copies, no borrowed references).
 * @module @xmoon76/dsh-pi-tui/surface-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { SkillSummary, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import {
  listGlobalCommands,
  readSurfaceCatalog,
  type SurfaceCatalogContext,
} from '../src/surface-catalog.ts'

/** A minimal fake agent with a header cwd. */
function fakeAgent(cwd = '/ws'): Agent {
  return { session: { id: 'session-a', header: { cwd }, events: [] } } as unknown as Agent
}

/** A scripted commands service. */
function fakeCommands(list: (agent: Agent) => readonly CommandDescriptor[]): SurfaceCatalogContext['get'] extends never ? never : object {
  return { list }
}

/** A scripted skills service. */
function fakeSkills(list: (options: SkillViewOptions) => Promise<readonly SkillSummary[]>): { list: typeof list } {
  return { list }
}

/** Build a context surface from scripted services. */
function contextOf(options: {
  commands?: { list: (agent: Agent) => readonly CommandDescriptor[] }
  skills?: {
    list?: (options: SkillViewOptions) => Promise<readonly SkillSummary[]>
    snapshot?: (options: SkillViewOptions) => Promise<{ skills: readonly SkillSummary[]; complete: boolean }>
  }
  agentPresets?: { serviceFor: (agent: { ctx: unknown }, name: 'skills') => unknown }
}): SurfaceCatalogContext {
  return {
    get: (name: 'commands' | 'agentPresets' | 'skills') => {
      if (name === 'commands') return options.commands as never
      if (name === 'skills') return options.skills as never
      return options.agentPresets as never
    },
  }
}

/** A catalog entry helper. */
function skill(name: string, invocation: { modelInvocable: boolean; userInvocable: boolean }): SkillSummary {
  return { name, description: `desc-${name}`, invocation, source: 'bundled', provider: 'test' }
}

function command(name: string, description = `desc-${name}`, input?: { hint: string }): CommandDescriptor {
  return { name, description, ...input === undefined ? {} : { input } }
}

test('the global-list helper reads the global layer only (isolated cast)', () => {
  const seen: unknown[] = []
  const commands = fakeCommands((agent) => {
    seen.push(agent)
    return [command('global')]
  }) as never
  listGlobalCommands(commands as never)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], undefined, 'the isolated cast must pass undefined, never a real agent')
})

test('effective commands merge global + agent-scoped entries; scoped derivation keeps only overrides', async () => {
  const globalList = [command('alpha'), command('shared', 'global-desc')]
  const effectiveList = [
    command('alpha'),
    command('shared', 'scoped-desc'),
    command('zeta'),
  ]
  const ctx = contextOf({
    commands: {
      list: (agent) => (agent === undefined ? globalList : effectiveList),
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(
    snapshot.commands.map(item => `${item.name}:${item.description}`),
    ['alpha:desc-alpha', 'shared:scoped-desc', 'zeta:desc-zeta'],
    'the effective view (scoped shadow winning) is the command list',
  )
  assert.deepEqual(
    snapshot.scopedCommands.map(item => `${item.name}:${item.description}`),
    ['shared:scoped-desc', 'zeta:desc-zeta'],
    'scoped overrides: the shadowing entry AND the agent-only entry',
  )
  assert.deepEqual(snapshot.issues, [])
})

test('an identical scoped descriptor needs no override entry', async () => {
  const ctx = contextOf({
    commands: {
      list: (agent) => agent === undefined
        ? [command('same', 'd')]
        : [command('same', 'd')],
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(snapshot.scopedCommands, [])
  assert.deepEqual(snapshot.commands.map(item => item.name), ['same'])
})

test('a missing commands service is a successful empty result, not an issue', async () => {
  const ctx = contextOf({ skills: { list: async () => [] } })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(snapshot.commands, [])
  assert.deepEqual(snapshot.scopedCommands, [])
  assert.deepEqual(snapshot.issues, [])
})

test('the human skill catalog applies the official user-invocation policy', async () => {
  const ctx = contextOf({
    commands: { list: () => [] },
    skills: {
      list: async () => [
        skill('both', { modelInvocable: true, userInvocable: true }),
        skill('user-only', { modelInvocable: false, userInvocable: true }),
        skill('model-only', { modelInvocable: true, userInvocable: false }),
        skill('neither', { modelInvocable: false, userInvocable: false }),
      ],
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(snapshot.skills.map(item => item.name), ['both', 'user-only'])
  assert.deepEqual(snapshot.issues, [])
})

test('skills are read with the agent scope, the session cwd and the signal', async () => {
  let options: SkillViewOptions | undefined
  const ctx = contextOf({
    skills: {
      list: async (opts) => {
        options = opts
        return []
      },
    },
  })
  const agent = fakeAgent('/ws/session')
  const signal = new AbortController().signal
  await readSurfaceCatalog(agent, signal, ctx)
  assert.equal(options?.cwd, '/ws/session')
  assert.equal(options?.scope, agent, 'the scope must be the AGENT object, never its context')
  assert.equal(options?.signal, signal)
})

test('an agentPresets scoped skill service wins over the host registry (apiproxy parity)', async () => {
  const scoped = fakeSkills(async () => [skill('scoped-skill', { modelInvocable: true, userInvocable: true })])
  const host = fakeSkills(async () => [skill('host-skill', { modelInvocable: true, userInvocable: true })])
  let resolvedFor: unknown
  const ctx = contextOf({
    agentPresets: {
      serviceFor: (agent, name) => {
        resolvedFor = agent
        assert.equal(name, 'skills')
        return scoped as never
      },
    },
    skills: host as never,
  })
  const agent = fakeAgent()
  const snapshot = await readSurfaceCatalog(agent, new AbortController().signal, ctx)
  assert.deepEqual(snapshot.skills.map(item => item.name), ['scoped-skill'])
  assert.equal(resolvedFor, agent, 'serviceFor must receive the agent object')
})

test('an ordinary skills failure empties skills with a detached issue while commands still land', async () => {
  const ctx = contextOf({
    commands: { list: () => [command('alpha')] },
    skills: {
      list: async () => { throw new Error('skills down') },
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(snapshot.commands.map(item => item.name), ['alpha'])
  assert.deepEqual(snapshot.skills, [])
  assert.equal(snapshot.issues.length, 1)
  assert.equal(snapshot.issues[0]?.provider, 'skills')
  assert.equal(snapshot.issues[0]?.message, 'skills down')
})

test('an ordinary commands failure empties commands with a detached issue while skills still land', async () => {
  const ctx = contextOf({
    commands: {
      list: () => { throw new Error('commands down') },
    },
    skills: {
      list: async () => [skill('ok', { modelInvocable: true, userInvocable: true })],
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(snapshot.commands, [])
  assert.deepEqual(snapshot.scopedCommands, [])
  assert.deepEqual(snapshot.skills.map(item => item.name), ['ok'])
  assert.equal(snapshot.issues[0]?.provider, 'commands')
})

test('an incomplete LIVE observation carries a detached skills issue (never authoritative)', async () => {
  const ctx = contextOf({
    commands: { list: () => [] },
    skills: {
      snapshot: async () => ({
        complete: false,
        skills: [skill('partial', { modelInvocable: true, userInvocable: true })],
      }),
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.deepEqual(snapshot.skills.map(item => item.name), ['partial'])
  assert.equal(snapshot.issues.length, 1)
  assert.equal(snapshot.issues[0]?.provider, 'skills')
  assert.match(snapshot.issues[0]?.message ?? '', /incomplete skill observation/)
})

test('cancellation propagates out of the whole read, never degrading into an issue', async () => {
  const controller = new AbortController()
  const ctx = contextOf({
    commands: { list: () => [command('alpha')] },
    skills: {
      list: async () => { throw new Error('late skills failure') },
    },
  })
  controller.abort()
  await assert.rejects(readSurfaceCatalog(fakeAgent(), controller.signal, ctx), (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError')
    return true
  })
})

test('a hostile thrown value is detached through safeErrorMessage, never rethrown raw', async () => {
  const hostile = { toString: () => { throw new Error('hostile') } } as never
  const ctx = contextOf({
    commands: { list: () => { throw hostile } },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.equal(snapshot.issues.length, 1)
  assert.ok(snapshot.issues[0]?.message.length > 0, 'the issue must carry safe text, never the hostile value')
})

test('the snapshot is fully detached and frozen: later source mutation cannot leak in', async () => {
  const catalog = [
    skill('zzz', { modelInvocable: true, userInvocable: true }),
    skill('aaa', { modelInvocable: true, userInvocable: true }),
  ]
  const ctx = contextOf({
    commands: { list: () => [command('gamma'), command('beta')] },
    skills: { list: async () => catalog },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.commands) && Object.isFrozen(snapshot.scopedCommands))
  assert.ok(Object.isFrozen(snapshot.skills) && Object.isFrozen(snapshot.issues))
  for (const item of snapshot.commands) assert.ok(Object.isFrozen(item))
  for (const item of snapshot.skills) assert.ok(Object.isFrozen(item))
  // Mutate the source arrays after the read: the snapshot must not move.
  catalog[0] = skill('hijacked', { modelInvocable: true, userInvocable: true })
  catalog.reverse()
  ;(catalog[0] as { description: string }).description = 'mutated'
  assert.deepEqual(snapshot.skills.map(item => item.name), ['aaa', 'zzz'])
  assert.deepEqual(snapshot.commands.map(item => item.name), ['beta', 'gamma'])
  // The summaries carry no agent/service/provider references by construction:
  // every entry is a fresh { name, description[, input] } object.
  for (const item of snapshot.skills) assert.deepEqual(Object.keys(item).sort(), ['description', 'name'])
  for (const item of snapshot.commands) assert.deepEqual(Object.keys(item).sort(), ['description', 'name'])
})

test('command summaries preserve the input hint and freeze it', async () => {
  const ctx = contextOf({
    commands: {
      list: (agent) => agent === undefined
        ? []
        : [command('plan', 'Enter plan mode', { hint: '[off|message]' })],
    },
  })
  const snapshot = await readSurfaceCatalog(fakeAgent(), new AbortController().signal, ctx)
  const plan = snapshot.commands.find(item => item.name === 'plan')
  assert.ok(plan !== undefined)
  assert.equal(plan.input?.hint, '[off|message]')
  assert.ok(Object.isFrozen(plan.input))
})
