/**
 * Headless tests for the command surface catalog layer (M1): synchronous
 * snapshot install (no async I/O before the first input), completion claims
 * (advertised names), the scoped-override merge, skill-wrapper collisions,
 * the human-invocation policy on every /skill entry, and the advertised-miss
 * dispatch decision.
 * @module @xmoon76/dsh-pi-tui/command-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { shouldConsumeAdvertisedMiss } from '../src/index.ts'
import type { SurfaceCatalogSnapshot } from '../src/surface-catalog.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A minimal fake agent whose identity marks which session a refresh ran for. */
function fakeAgent(sessionId: string, injected: string[] = []): Agent {
  return {
    session: { id: sessionId, header: { cwd: '/ws' }, events: [] },
    options: { provider: 'p', model: 'm' },
    inject: (message: { content: { text: string }[] }) => { injected.push(message.content[0]?.text ?? '') },
  } as unknown as Agent
}

/** A stub runner with a MUTABLE live agent (the test plays session state). */
function stubRunner(
  ctx: Context,
  app: TuiApp,
  state: { agent: Agent | undefined },
  diag: ReturnType<typeof createDiag> = createDiag({ filePath: undefined, stderrLevel: 'off' }),
): TuiCommandRunner {
  return {
    ctx,
    app,
    diag,
    get liveAgent() { return state.agent },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    agents: {} as never,
    sessions: { flush: async () => {} },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    signal: new AbortController().signal,
    get sessionGeneration() { return 1 },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    enterView: async () => {},
    requestExit: () => {},
    exit: () => {},
  }
}

/** A fake commands service recording registrations, and a fake skills
 * service with scripted list/get and invocation policies. */
function fakeServices() {
  const registered: string[] = []
  const defs: { name: string; description?: string; handler?: unknown }[] = []
  const commands = {
    register: (def: { name: string; description?: string; handler?: unknown }): (() => void) => {
      registered.push(def.name)
      defs.push(def)
      return (): void => {
        const index = registered.indexOf(def.name)
        if (index !== -1) registered.splice(index, 1)
      }
    },
    list: () => [
      { name: 'builtin', description: 'a builtin', input: { hint: '' } },
      // The real registry reflects registrations in the global view; the
      // fake's list must too (completion merges read it fresh).
      ...registered.map(name => ({ name, description: 'registered' })),
    ],
    find: () => undefined,
    execute: async () => undefined,
  }
  let listCalls = 0
  const skills = {
    listCalls: (): number => listCalls,
    list: async () => {
      listCalls += 1
      throw new Error('the skills list must not be fetched during a snapshot install')
    },
    get: async () => undefined,
  }
  return { registered, defs, commands, skills }
}

/** A snapshot shaped like a startup-probe result. */
function snapshotOf(options: { skills?: { name: string; description: string }[]; scoped?: { name: string; description: string }[] }): SurfaceCatalogSnapshot {
  const scoped = options.scoped ?? [{ name: 'scoped-cmd', description: 'preset scoped' }]
  return Object.freeze({
    commands: Object.freeze([
      Object.freeze({ name: 'alpha', description: 'alpha' }),
      ...scoped.map(command => Object.freeze({ ...command })),
    ]),
    scopedCommands: Object.freeze(scoped.map(command => Object.freeze({ ...command }))),
    skills: Object.freeze((options.skills ?? []).map(skill => Object.freeze({ ...skill }))),
    issues: Object.freeze([]),
  })
}

test('an initial snapshot installs skill wrappers and claims SYNCHRONOUSLY with zero catalog I/O', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const state = { agent: undefined }
  const snapshot = snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }, { name: 'find-skills', description: 'Find skills' }] })
  const { wasAdvertised } = registerTuiCommands(stubRunner(ctx, app, state), { snapshot })
  // No await anywhere: the whole install is one synchronous commit.
  assert.deepEqual(
    services.registered.filter(name => name === 'glab' || name === 'find-skills').sort(),
    ['find-skills', 'glab'],
    'the direct skill wrappers must be registered from the snapshot',
  )
  assert.equal(services.skills.listCalls(), 0, 'no async catalog fetch may happen during a snapshot install')
  // Claims: built-ins + scoped overrides + skill wrappers.
  assert.equal(wasAdvertised('glab'), true, 'a skill wrapper is advertised')
  assert.equal(wasAdvertised('scoped-cmd'), true, 'a scoped override is advertised')
  assert.equal(wasAdvertised('exit'), true, 'a TUI built-in is advertised')
  assert.equal(wasAdvertised('missing'), false, 'an unknown name is never advertised')
  app.stop()
})

test('without a snapshot no skill wrappers install and claims cover only the global view', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const { wasAdvertised } = registerTuiCommands(stubRunner(ctx, app, { agent: undefined }))
  assert.deepEqual(services.registered.filter(name => name === 'glab' || name === 'find-skills'), [],
    'no skill wrapper may install without a snapshot or a live session')
  assert.equal(wasAdvertised('builtin'), true)
  assert.equal(wasAdvertised('glab'), false)
  app.stop()
})

test('a scoped override blocks a same-name skill wrapper; the effective command wins', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const snapshot = snapshotOf({
    scoped: [{ name: 'scoped-cmd', description: 'preset scoped' }],
    skills: [
      { name: 'glab', description: 'GitLab CLI' },
      { name: 'scoped-cmd', description: 'a skill that collides' },
      { name: 'builtin', description: 'a skill that collides with the global view' },
    ],
  })
  const { wasAdvertised } = registerTuiCommands(stubRunner(ctx, app, { agent: undefined }), { snapshot })
  assert.deepEqual(
    services.registered.filter(name => name === 'glab' || name === 'scoped-cmd' || name === 'builtin'),
    ['glab'],
    'only the non-colliding wrapper installs; scoped and global commands win',
  )
  assert.equal(wasAdvertised('scoped-cmd'), true, 'the effective command stays advertised')
  app.stop()
})

test('a commands/change event re-merges completions without re-probing and without losing the saved scoped overrides', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const snapshot = snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] })
  const { wasAdvertised } = registerTuiCommands(stubRunner(ctx, app, { agent: undefined }), { snapshot })
  assert.equal(wasAdvertised('scoped-cmd'), true, 'the scoped override is advertised after the install')
  const readsBefore = services.skills.listCalls()
  // An external registry change (e.g. a global plugin registering a command):
  // the listener re-reads the GLOBAL view and re-merges the saved overrides.
  ctx.emit('commands/change')
  assert.equal(wasAdvertised('scoped-cmd'), true, 'the saved scoped override survives the re-merge')
  assert.equal(wasAdvertised('builtin'), true, 'the fresh global view flows in')
  assert.equal(services.skills.listCalls(), readsBefore, 'a commands/change never re-probes')
  app.stop()
})

test('the revalidating transition keeps skill names as revalidating handlers and clears scoped previews', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const injected: string[] = []
  const agent = fakeAgent('session-a', injected)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { wasAdvertised, enterTransition } = registerTuiCommands(
    stubRunner(ctx, app, { agent }),
    { snapshot: snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] }) },
  )
  assert.equal(wasAdvertised('scoped-cmd'), true)
  // The target changes (composition → live agent): the transition fires.
  enterTransition()
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper !== undefined, 'the skill NAME survives the transition')
  assert.match(wrapper!.description ?? '', /\[skill: revalidating\]/, 'the wrapper is marked revalidating')
  assert.equal(wasAdvertised('scoped-cmd'), false, 'scoped previews clear: no new input sees the old scope')
  assert.equal(wasAdvertised('glab'), true,
    'the transition wrapper stays advertised: submitting /glab resolves through the revalidating handler')
  // The transition handler still executes against the CURRENT agent with a
  // fresh get + policy recheck (the same execution boundary).
  const result = await (wrapper!.handler as () => Promise<{ kind: string }>)()
  assert.equal(result.kind, 'success')
  assert.equal(injected.length, 1, 'the transition executes through loadSkill on the current agent')
  app.stop()
})

test('the advertised-miss dispatch decision consumes advertised misses and keeps the plain fallback', () => {
  assert.equal(shouldConsumeAdvertisedMiss(undefined, true), true,
    'an advertised command missing from the real session is consumed')
  assert.equal(shouldConsumeAdvertisedMiss(undefined, false), false,
    'an unadvertised miss keeps the existing plain-input fallback')
  assert.equal(shouldConsumeAdvertisedMiss({ result: { kind: 'success' } }, true), false,
    'a resolved command never consumes')
  assert.equal(shouldConsumeAdvertisedMiss({ result: { kind: 'error', text: 'x' } }, true), false,
    'an executed error is a command outcome, not a miss')
})

test('a model-only skill is refused by the explicit /skill <name> path and never injected', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const injected: string[] = []
  const agent = fakeAgent('session-a', injected)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => name === 'model-only'
      ? { name, description: 'model only', content: 'body', invocation: { modelInvocable: true, userInvocable: false }, source: 'bundled', provider: 't' }
      : undefined,
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: 'model-only' })
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /not invocable by the user/)
  assert.deepEqual(injected, [], 'a model-only skill must never be injected')
  app.stop()
})

test('the /skill picker offers only human-invocable skills', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const agent = fakeAgent('session-a')
  const human = { name: 'human-skill', description: 'Human invocable', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
  const modelOnly = { name: 'model-only', description: 'Model only', invocation: { modelInvocable: true, userInvocable: false }, source: 'bundled', provider: 't' }
  ctx.provide('skills', {
    list: async () => [human, modelOnly],
    get: async () => undefined,
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('human-skill'), `the human skill must be offered:\n${view}`)
  assert.ok(!view.includes('model-only'), `a model-only skill must not be offered:\n${view}`)
  app.stop()
})

test('a direct skill wrapper re-checks the policy on the CURRENT agent at execution time', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const injected: string[] = []
  const agent = fakeAgent('session-a', injected)
  // The probe summary said user-invocable; the CURRENT agent's definition
  // has since flipped to model-only.
  ctx.provide('skills', {
    list: async () => [],
    get: async () => ({ name: 'flipped', description: 'now model only', content: 'body', invocation: { modelInvocable: true, userInvocable: false }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  const { wasAdvertised } = registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'flipped', description: 'was human invocable' }],
  }) })
  assert.equal(wasAdvertised('flipped'), true, 'the snapshot advertised it')
  const wrapper = defs.find(def => def.name === 'flipped')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as () => Promise<{ kind: string; text?: string }>)()
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /not invocable by the user/)
  assert.deepEqual(injected, [], 'the flipped skill must not be injected')
  app.stop()
})
