/**
 * Headless tests for session-scoped state isolation: the skill command
 * catalog refresh race (an old session's late refresh must not clobber the
 * new session's commands) and the TuiApp per-session override clearing.
 * @module @xmoon76/dsh-pi-tui/session-state.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TuiApp } from '../src/tui-app.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** A promise the test resolves manually, to stage late completions. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** A minimal fake agent whose identity marks which session a refresh ran for. */
function fakeAgent(sessionId: string): Agent {
  return {
    session: { id: sessionId, header: { cwd: '/ws' } },
  } as unknown as Agent
}

/** A stub runner with a MUTABLE generation and live agent (the test plays
 * the session switch by mutating state). */
function stubRunner(
  ctx: Context,
  app: TuiApp,
  state: { agent: Agent | undefined; generation: number },
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
    signal: new AbortController().signal,
    get sessionGeneration() { return state.generation },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    enterView: async () => {},
    requestExit: () => {},
    exit: () => {},
  }
}

/** A fake commands service recording registrations, and a fake skills
 * service whose catalog is controllable per agent. */
function fakeServices() {
  const registered: string[] = []
  const defs: { name: string; handler?: unknown }[] = []
  const disposers = new Map<string, () => void>()
  const catalogs = new Map<object, { promise: Promise<readonly { name: string; description: string }[]>; resolve: (v: readonly { name: string; description: string }[]) => void }>()
  const commands = {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      registered.push(def.name)
      defs.push(def)
      const disposer = (): void => {
        const index = registered.indexOf(def.name)
        if (index !== -1) registered.splice(index, 1)
      }
      disposers.set(def.name, disposer)
      return disposer
    },
    list: () => [{ name: 'builtin', description: 'a builtin', input: { hint: '' } }],
    find: () => undefined,
    execute: async () => undefined,
  }
  const skills = {
    list: (options: { scope?: object }): Promise<readonly { name: string; description: string }[]> => {
      const scope = options.scope ?? {}
      const existing = catalogs.get(scope)
      if (existing !== undefined) return existing.promise
      const gate = deferred<readonly { name: string; description: string }[]>()
      catalogs.set(scope, gate)
      return gate.promise
    },
    get: async () => undefined,
  }
  return {
    registered,
    defs,
    catalogs,
    commands: { ...commands, dispose: (name: string) => disposers.get(name)?.() },
    skills,
  }
}

test('a stale skill refresh cannot register commands into a newer session', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const { refreshSkills } = registerTuiCommands(stubRunner(ctx, app, state))

  // Session A's refresh starts and hangs on the catalog fetch.
  const refreshA = refreshSkills()
  // The session switches to B while A's catalog is still loading.
  state.agent = fakeAgent('session-b')
  state.generation = 2
  const refreshB = refreshSkills()
  // B's catalog arrives: its commands register.
  services.catalogs.get(state.agent)?.resolve([{ name: 'skill-b', description: 'b' }])
  await refreshB
  assert.ok(services.registered.includes('skill-b'), 'the current session\'s commands must register')
  // A's catalog lands LATE: the generation check must drop it entirely.
  for (const [scope, gate] of services.catalogs) {
    if (scope !== state.agent) gate.resolve([{ name: 'skill-a', description: 'a' }])
  }
  await refreshA
  assert.ok(!services.registered.includes('skill-a'), 'a stale refresh must not register old-session commands')
  assert.ok(services.registered.includes('skill-b'), 'the new session\'s commands survive the stale refresh')
  app.stop()
})

test('/quit is a registered alias of /exit sharing its handler', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const state = { agent: undefined, generation: 1 }
  registerTuiCommands(stubRunner(ctx, app, state))
  const exitDef = services.defs.find(def => def.name === 'exit')
  const quitDef = services.defs.find(def => def.name === 'quit')
  assert.ok(exitDef !== undefined, '/exit must be registered')
  assert.ok(quitDef !== undefined, '/quit must be registered')
  assert.equal(quitDef!.handler, exitDef!.handler, '/quit must share the /exit handler')
  app.stop()
})

test('/exit and /quit route through the runner requestExit, never their own teardown', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const state = { agent: undefined, generation: 1 }
  // The handler must call the ONE exit orchestration — a handler that
  // stops the app, flushes or exits itself would diverge from Ctrl+C/Ctrl+D
  // (no timeout, no catch) and could hang a stopped UI forever.
  const requested: string[] = []
  const runner = stubRunner(ctx, app, state)
  const proxy = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'requestExit') return (): void => { requested.push('exit') }
      return Reflect.get(target, prop, receiver)
    },
  })
  registerTuiCommands(proxy as unknown as typeof runner)
  for (const name of ['exit', 'quit']) {
    const def = services.defs.find(entry => entry.name === name)
    assert.ok(def?.handler !== undefined, `${name} handler missing`)
    ;(def!.handler as () => unknown)()
  }
  assert.deepEqual(requested, ['exit', 'exit'], 'both /exit and /quit must call runner.requestExit')
  app.stop()
})

test('a failed model selection save rolls the selection back and notifies without an unhandled rejection', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  // The runner's selection is a MUTABLE object the /model apply() updates.
  const selection = {
    current: { provider: 'p', model: 'old-model' },
    assembled: undefined,
    saveSelection: async () => {},
  }
  ctx.provide('llm', {
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p', model: 'm1' }),
    // The persistence write FAILS: the UI must roll back, not fake success.
    saveSelection: async () => { throw new Error('quota exceeded') },
  } as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const runner = stubRunner(ctx, app, state)
  const proxy = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'selected') return selection
      return Reflect.get(target, prop, receiver)
    },
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    registerTuiCommands(proxy as unknown as typeof runner)
    const modelDef = services.defs.find(entry => entry.name === 'model')
    assert.ok(modelDef?.handler !== undefined, '/model handler missing')
    await (modelDef!.handler as () => Promise<unknown>)()
    await vt.waitForRender()
    vt.sendInput('\r') // Enter: open the provider's model submenu
    await new Promise(resolve => setTimeout(resolve, 30)) // model list loads
    await vt.waitForRender()
    vt.sendInput('\r') // Enter: select the first model → apply → save rejects
    await new Promise(resolve => setTimeout(resolve, 30))
    await vt.waitForRender()
    assert.deepEqual(unhandled, [], 'the save rejection must not leak as an unhandled rejection')
    assert.equal(selection.current.model, 'old-model',
      'a failed save must roll the selection back to the previous value')
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('model selection save'), `rollback notice missing:\n${view}`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    app.stop()
  }
})

test('a late FAILED save never rolls back a newer successful selection (latest-wins)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const selection = {
    current: { provider: 'p', model: 'old-model' },
    assembled: undefined,
    saveSelection: async () => {},
  }
  ctx.provide('llm', {
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
  } as never)
  // Saves are gated manually: save(m1) hangs, save(m2) succeeds, then
  // save(m1) FAILS LATE — the rollback must not overwrite m2.
  const gates = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p', model: 'm1' }),
    saveSelection: (next: { model: string }) => {
      const gate = { resolve: () => {}, reject: () => {} } as { resolve: (v: unknown) => void; reject: (e: Error) => void }
      const promise = new Promise<unknown>((res, rej) => {
        gate.resolve = res
        gate.reject = rej
      })
      gates.set(next.model, gate)
      return promise
    },
  } as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const runner = stubRunner(ctx, app, state)
  const proxy = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'selected') return selection
      return Reflect.get(target, prop, receiver)
    },
  })
  registerTuiCommands(proxy as unknown as typeof runner)
  try {
    const modelDef = services.defs.find(entry => entry.name === 'model')
    assert.ok(modelDef?.handler !== undefined, '/model handler missing')
    await (modelDef!.handler as () => Promise<unknown>)()
    await vt.waitForRender()
    // Select m1: its save hangs (deferred).
    vt.sendInput('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    await vt.waitForRender()
    vt.sendInput('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    const saveM1 = gates.get('m1')
    assert.ok(saveM1 !== undefined, 'save(m1) must have started')
    // Back on the provider list: re-enter and select m2 while m1 is pending.
    vt.sendInput('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    await vt.waitForRender()
    vt.sendInput('\x1b[B') // ↓ to m2
    await vt.waitForRender()
    vt.sendInput('\r')
    await new Promise(resolve => setTimeout(resolve, 30))
    const saveM2 = gates.get('m2')
    assert.ok(saveM2 !== undefined, 'save(m2) must have started')
    // m2 succeeds first, then m1 FAILS LATE.
    saveM2.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(selection.current.model, 'm2', 'the successful selection stands')
    saveM1.reject(new Error('quota exceeded'))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(selection.current.model, 'm2',
      'a late failed save must NOT roll back the newer successful selection')
    const view = vt.getViewport().join('\n')
    assert.ok(view.includes('model selection save'), `failure notice missing:\n${view}`)
  } finally {
    app.stop()
  }
})

test('a failing initial skill catalog refresh lands in diagnostics, never silently swallowed', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  services.skills.list = async () => { throw new Error('catalog down') }
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  const lines: string[] = []
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off', sinks: [{ write: (line: string) => { lines.push(line) } }] })
  try {
    const state = { agent: fakeAgent('session-a'), generation: 1 }
    registerTuiCommands(stubRunner(ctx, app, state, diag))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], 'the catalog failure must not leak as an unhandled rejection')
    assert.ok(lines.some(line => /WARN skill catalog refresh/.test(line) && /catalog down/.test(line)),
      `diag must record the failure:\n${lines.join('\n')}`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    app.stop()
  }
})

test('clearSessionOverrides drops per-message expansion toggles', () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  const overrides = (app as unknown as { expandedOverride: Map<object, boolean> }).expandedOverride
  const messageA = { kind: 'thinking', turn: 0 }
  const messageB = { kind: 'tool', turn: 1 }
  overrides.set(messageA, true)
  overrides.set(messageB, true)
  assert.equal(overrides.size, 2)
  app.clearSessionOverrides()
  assert.equal(overrides.size, 0, 'session-scoped expansion overrides must clear on switch')
  app.stop()
})
