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
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A minimal fake agent whose identity marks which session a refresh ran for.
 * Mirrors the real driver's wake semantics: steer/followup synchronously
 * flip status to 'running' (agent-loop's wakeDriver), so tests exercise the
 * same status transitions production sees. */
function fakeAgent(sessionId: string, delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = [], status: 'idle' | 'running' = 'idle'): Agent {
  const agent = {
    session: { id: sessionId, header: { cwd: '/ws' }, events: [] },
    options: { provider: 'p', model: 'm' },
    status,
  } as unknown as Agent & { status: 'idle' | 'running' }
  Object.assign(agent, {
    steer: (message: { content: { text: string }[] }) => {
      // wakeDriver semantics: a waking send moves an idle agent to running.
      agent.status = 'running'
      delivered.push({ kind: 'steer', text: message.content[0]?.text ?? '' })
    },
    followup: (message: { content: { text: string }[] }) => {
      agent.status = 'running'
      delivered.push({ kind: 'followup', text: message.content[0]?.text ?? '' })
    },
    inject: (message: { content: { text: string }[] }) => {
      // inject never wakes: status unchanged.
      delivered.push({ kind: 'inject', text: message.content[0]?.text ?? '' })
    },
  })
  return agent
}

/** A stub runner with a MUTABLE live agent (the test plays session state). */
function stubRunner(
  ctx: Context,
  app: TuiApp,
  state: { agent: Agent | undefined },
  diag: ReturnType<typeof createDiag> = createDiag({ filePath: undefined, stderrLevel: 'off' }),
  options: { transitionPending?: boolean } = {},
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
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
    },
    host: {
      settings: () => ctx.get('settings'),
      llm: () => ctx.get('llm'),
      credentials: () => ctx.get('credentials'),
      authorization: () => ctx.get('authorization'),
      defaultModel: () => ctx.get('agentDefaultModel'),
      presets: () => ctx.get('agentPresets'),
      tools: () => ctx.get('tools'),
      permission: () => ctx.get('permissionPresets'),
      tokenMeter: () => ctx.get('tokenMeter'),
      commands: () => ctx.get('commands'),
      persistence: () => ctx.get('sessionPersistence'),
    },
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 1 },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => options.transitionPending ?? false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
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
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
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
  // fresh get + policy recheck (the same execution boundary). The original
  // line is steered (which wakes an idle driver) and the body rides the
  // same next-step batch as an injection — turns that wake the driver.
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the transition executes through loadSkill on the current agent')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line is steered (waking an idle driver)')
  assert.equal(delivered[0]?.text, '/glab', 'the original user line is forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'inject', 'the body rides the same next-step batch as an injection')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the loaded body uses the official skill_content rendering')
  app.stop()
})

test('loadSkill steers a RUNNING agent at the next step boundary instead of parking in the inbox', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered, 'running')
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'a bare /name delivers the original line AND the injected body')
  assert.equal(delivered[0]?.kind, 'steer', 'a running agent receives the original line as a steer')
  assert.equal(delivered[0]?.text, '/glab', 'the original user line is forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'inject', 'the body rides the same next-step batch as an injection')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the loaded body uses the official skill_content rendering')
  app.stop()
})

test('the explicit /skill <name> path steers the original line and injects the body on an idle agent', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => name === 'glab'
      ? { name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
      : undefined,
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the explicit /skill path delivers the original line AND the loaded body')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line is steered (waking an idle driver)')
  assert.equal(delivered[0]?.text, '/glab', 'the original user line is forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'inject', 'the body rides the same next-step batch as an injection')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the loaded body uses the official skill_content rendering')
  app.stop()
})

test('a missing agent status still delivers via steer+inject (no status branch)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  delete (agent as { status?: unknown }).status
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the load still delivers')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line is always steered, regardless of status')
  assert.equal(delivered[1]?.kind, 'inject', 'the body rides the same next-step batch')
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

test('a model-only skill is refused by the explicit /skill <name> path and never delivered', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
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
  assert.deepEqual(delivered, [], 'a model-only skill must never be delivered')
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
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
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
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /not invocable by the user/)
  assert.deepEqual(delivered, [], 'the flipped skill must not be delivered')
  app.stop()
})

test('a direct skill wrapper forwards /name args VERBATIM as the original line (web parity)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'open issue 123' })
  assert.equal(result.kind, 'success')
  // Without a host skill loader the TUI injects the body itself: the user's
  // original line (WITH its arguments) must precede the injected body —
  // the arguments are never dropped.
  assert.equal(delivered.length, 2, 'a /name args invocation delivers the original line AND the body')
  assert.equal(delivered[0]?.text, '/glab open issue 123', 'the original line with args is forwarded verbatim')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the injected body uses the official skill_content rendering')
  app.stop()
})

test('with a visible host skill loader the wrapper forwards the original line only (no double injection)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  // The host's dsh-tool-skill registers the `skill` tool for this agent
  // (with an execute function — the loader shape). The scope argument MUST
  // be the live agent object (AGENTS.md trap: the tool registry is keyed by
  // the live agent, not ctx) — record it so a regression that drops the
  // scope is caught.
  const toolScopes: unknown[] = []
  ctx.provide('tools', {
    get: (name: string, scope: unknown) => {
      toolScopes.push(scope)
      return name === 'skill' ? { name: 'skill', execute: async () => ({}) } : undefined
    },
  } as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'open issue 123' })
  assert.equal(result.kind, 'success')
  // The host's pre-step listener injects the body from the original line;
  // the TUI must NOT inject it again (double injection would duplicate the
  // skill body in the model context).
  assert.equal(delivered.length, 1, 'the host loader owns the injection — only the original line ships')
  assert.equal(delivered[0]?.text, '/glab open issue 123', 'the original line with args is forwarded verbatim')
  assert.equal(toolScopes.length, 1, 'the loader visibility check queried the tool registry once')
  assert.equal(toolScopes[0], agent, 'the tool registry must be queried with the live agent object as scope')
  app.stop()
})

test('the /skill command splits /skill <name> <args> and forwards the args verbatim', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => name === 'glab'
      ? { name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
      : undefined,
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab open issue 123' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the /skill path delivers the normalized line AND the body')
  assert.equal(delivered[0]?.text, '/glab open issue 123', 'the normalized /name args line carries the arguments')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the injected body uses the official skill_content rendering')
  app.stop()
})

test('the /skill command normalizes a bare name to the /name line for the host gesture', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => name === 'glab'
      ? { name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
      : undefined,
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: ' glab ' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the bare /skill path delivers the normalized line AND the body')
  assert.equal(delivered[0]?.text, '/glab', 'a bare name normalizes to the /name line the host gesture matches')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the injected body uses the official skill_content rendering')
  app.stop()
})

test('the direct wrapper preserves leading/multiple whitespace in args', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '   open   issue 123 ' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'a whitespace-padded invocation still delivers the original line AND the body')
  assert.equal(delivered[0]?.text, '/glab open   issue 123 ', 'the wrapper name plus the raw args (leading whitespace trimmed) is the forwarded line')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the injected body uses the official skill_content rendering')
  app.stop()
})

test('the /skill command with args on a RUNNING agent steers the pair into the running turn', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered, 'running')
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => name === 'glab'
      ? { name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
      : undefined,
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab fix bug' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the running /skill path delivers the original line AND the body')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line steers into the running turn')
  assert.equal(delivered[0]?.text, '/glab fix bug', 'the arguments are forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'inject', 'the body rides the same next-step batch')
  app.stop()
})

test('the wrappers tolerate an undefined invocation (defensive rawInput fallback)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as () => Promise<{ kind: string }>)()
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'an undefined invocation still delivers as a bare /name')
  assert.equal(delivered[0]?.text, '/glab', 'a missing rawInput degrades to the bare /name line')
  app.stop()
})

test('the fallback injection carries the official source fields and a provider default', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  // The fake agent records the FULL message, not just the text, so the
  // source can be asserted.
  const injected: { source: { kind?: string; name?: string; form?: string }; text: string }[] = []
  const agent = {
    session: { id: 'session-a', header: { cwd: '/ws' }, events: [] },
    options: { provider: 'p', model: 'm' },
    status: 'idle',
  } as unknown as Agent
  Object.assign(agent, {
    steer: () => {},
    followup: () => {},
    inject: (message: { content: { text: string }[]; source: unknown }) => {
      injected.push({ ...message, text: message.content[0]?.text ?? '' } as never)
    },
  })
  // No provider field on the loaded skill: the fallback must default it.
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(injected.length, 1, 'the fallback injected exactly one body message')
  assert.equal(injected[0]?.source.kind, 'skill-invocation', 'the fallback uses the official skill-invocation source kind')
  assert.equal(injected[0]?.source.name, 'glab', 'the source names the invoked skill')
  assert.equal(injected[0]?.source.form, 'instructions', 'the source marks the injection as instructions-form context')
  assert.match(injected[0]?.text ?? '', /provider "tui"/, 'a missing provider defaults to "tui" in the rendering')
  assert.match(injected[0]?.text ?? '', /<skill_content name="glab">/, 'the body uses the official skill_content rendering')
  app.stop()
})

test('the fallback injection forwards the resource base hint', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't', resourceBase: { kind: 'directory', path: '/skills/glab' } }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(delivered[1]?.text ?? '', /Base directory for this skill: \/skills\/glab/, 'the fallback rendering carries the resource base hint')
  app.stop()
})

test('a tool merely NAMED skill without a loader shape is treated as no host loader (fallback injects)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  // A scoped shadow merely named `skill` (no execute): the host's gesture
  // listener would NOT inject for it (identity mismatch), so the TUI must
  // NOT treat it as the loader either — the fallback covers the body.
  ctx.provide('tools', {
    get: () => ({ name: 'skill', parameters: {} }),
  } as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the shadow tool does not suppress the fallback injection')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the body is injected by the TUI fallback')
  app.stop()
})

test('a throwing skill steer releases the image pin (review finding)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const agent = fakeAgent('session-a')
  // A hostile/sync-throwing steer: the invocation must still release its
  // pin so pruning and draft capacity are never blocked forever.
  const throwing = agent as unknown as { steer: () => void }
  throwing.steer = () => { throw new Error('steer failed') }
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => name === 'glab'
      ? { name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
      : undefined,
  } as never)
  const runner = stubRunner(ctx, app, { agent })
  const draft = runner.imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  registerTuiCommands(runner)
  const skillDef = services.defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  await assert.rejects(
    () => (skillDef!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: 'glab' }),
    /steer failed/,
  )
  assert.equal(runner.imageStore.isPinned(draft.id), false, 'the pin releases even when steer throws')
  app.stop()
})

// ── review round 5: the transition fence refuses skill invocations ─────────

test('the transition fence refuses a skill invocation mid-transition (zero writes, line restored)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  registerTuiCommands(
    stubRunner(ctx, app, { agent }, createDiag({ filePath: undefined, stderrLevel: 'off' }), { transitionPending: true }),
    { snapshot: snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] }) },
  )
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined, 'the skill wrapper must be registered')
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: 'fix the pipeline' })
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /transition is in progress/, 'the refusal explains the retry')
  assert.equal(delivered.length, 0, 'the skill must never write the old agent during a transition')
  assert.ok(app.getDraft().includes('/glab fix'), 'the invocation line is restored to the editor')
  app.stop()
})

test('the transition fence does NOT refuse skill invocations when no transition is in flight', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  registerTuiCommands(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the skill delivers the line and the body as usual')
  app.stop()
})
