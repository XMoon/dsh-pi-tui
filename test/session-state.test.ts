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
import { LOCAL_COMMANDS } from '../src/index.ts'
import { CatalogRefreshCoordinator } from '../src/skill-catalog-refresh.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { readSurfaceCatalog, type SurfaceCatalogContext } from '../src/surface-catalog.ts'
import { createDiag } from '../src/diag.ts'
import { currentPalette, darkColors, lightColors } from '../src/theme.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — CI runners export CI=true, which would short-circuit the
// autodetect paths this suite drives through the /settings panel. Clear all
// three (the tests inject terminal replies, so the opt-out only masks the
// code under test).
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A promise the test resolves manually, to stage late completions. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** A minimal fake agent whose identity marks which session a refresh ran for. */
function fakeAgent(sessionId: string): Agent {
  return {
    session: { id: sessionId, header: { cwd: '/ws' }, events: [] },
    options: { provider: 'p', model: 'm' },
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
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(ctx as never, (sessionId) => state.agent?.session.id === sessionId ? state.agent : undefined),
    config: new DirectConfigPort(ctx as never, undefined, (sessionId) => state.agent?.session.id === sessionId ? state.agent : undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort((sessionId) => state.agent?.session.id === sessionId ? state.agent : undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      // The /title tests provide a fake sessionTitle service on the ctx;
      // the stub writer routes to it exactly like the Direct adapter
      // (identity-based: the sessionId resolves to the live session).
      rename: (sessionId, name) => {
        const titles = ctx.get('sessionTitle') as { rename(s: unknown, n: string): void } | undefined
        if (titles === undefined) return false
        titles.rename({ id: sessionId } as never, name)
        return true
      },
      refreshTitle: async (sessionId, signal) => {
        const titles = ctx.get('sessionTitle') as { refresh(s: unknown, signal: AbortSignal): Promise<{ title: string } | undefined> } | undefined
        if (titles === undefined) return { kind: 'unavailable' as const }
        const regenerated = await titles.refresh({ id: sessionId } as never, signal)
        return { kind: 'ok' as const, title: regenerated?.title }
      },
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return state.generation },
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
    // The merged /tasks browser: jobs + subagents, Enter routes to
    // openJobView through `this` so a Proxy-wrapped runner can spy on it.
    openTasksBrowser() {
      const jobs = ctx.get('jobs') as
        | { list: (agent: never) => { id: string; kind: string; label: string; status: string; startedAt: number; detail?: string }[] }
        | undefined
      const snapshots = jobs?.list(state.agent as never) ?? []
      app.openTaskBrowser(
        snapshots.map(job => ({
          value: job.id,
          label: `${job.kind} · ${job.label}`,
          status: job.status,
          detail: job.detail,
          startedAt: job.startedAt,
          group: 'jobs',
        })),
        (value) => this.openJobView(value),
        () => {},
        { header: 'tasks', enableSearch: true },
      )
    },
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
}

/** A fake commands service recording registrations, and a fake skills
 * service whose catalog is controllable per agent. Catalog entries carry
 * the official invocation policy so the user-invocation filter can run. */
type FakeSkillEntry = { name: string; description: string; invocation: { modelInvocable: boolean; userInvocable: boolean } }
function fakeServices() {
  const registered: string[] = []
  const defs: { name: string; handler?: unknown }[] = []
  const disposers = new Map<string, () => void>()
  const catalogs = new Map<object, { promise: Promise<readonly FakeSkillEntry[]>; resolve: (v: readonly FakeSkillEntry[]) => void }>()
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
    list: (options: { scope?: object }): Promise<readonly FakeSkillEntry[]> => {
      const scope = options.scope ?? {}
      const existing = catalogs.get(scope)
      if (existing !== undefined) return existing.promise
      const gate = deferred<readonly FakeSkillEntry[]>()
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

test('/settings working-directory row follows the live session cwd', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const state = { agent: undefined, generation: 1 }
  let liveCwd = '/ws/alpha'
  const runner = stubRunner(ctx, app, state)
  const proxy = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'sessionCwd') return (): string => liveCwd
      return Reflect.get(target, prop, receiver)
    },
  })
  registerTuiCommands(proxy as unknown as typeof runner)
  const settingsDef = services.defs.find(def => def.name === 'settings')
  assert.ok(settingsDef?.handler !== undefined, 'settings handler missing')
  ;(settingsDef!.handler as () => unknown)()
  await vt.waitForRender()
  // The working-directory row sits at the end of the scrolling list (the
  // icon-style and sandbox rows joined the panel, so the list is longer).
  for (let index = 0; index < 10; index += 1) vt.sendInput('\x1b[B')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('/ws/alpha'), `session cwd row missing:\n${view}`)
  // A session switch to another workspace must reflect on the next open.
  liveCwd = '/ws/beta'
  vt.sendInput('\x1b') // close the settings overlay
  await vt.waitForRender()
  ;(settingsDef!.handler as () => unknown)()
  await vt.waitForRender()
  for (let index = 0; index < 10; index += 1) vt.sendInput('\x1b[B')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('/ws/beta'), `updated session cwd missing:\n${view}`)
  app.stop()
})

test('/tasks Enter opens the job detail through the shared openJobView', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('jobs', {
    list: () => [{ id: 'bash-1', kind: 'bash', label: 'pnpm build', status: 'completed', startedAt: Date.now(), detail: 'exit code: 0' }],
  } as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const opened: string[] = []
  const runner = stubRunner(ctx, app, state)
  const proxy = new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'openJobView') return (id: string): void => { opened.push(id) }
      return Reflect.get(target, prop, receiver)
    },
  })
  registerTuiCommands(proxy as unknown as typeof runner)
  const tasksDef = services.defs.find(def => def.name === 'tasks')
  assert.ok(tasksDef?.handler !== undefined, 'tasks handler missing')
  ;(tasksDef!.handler as () => unknown)()
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('bash · pnpm build'), `job row missing:\n${view}`)
  // Enter on the row must open the detail — completed jobs are reachable
  // exactly through this path (the ↓ trigger only arms while one runs).
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(opened, ['bash-1'], '/tasks selection must route to openJobView')
  app.stop()
})

test('a stale catalog refresh cannot install commands into a newer session', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const installed = registerTuiCommands(stubRunner(ctx, app, state))
  // A coordinator over the real surface hooks: the post-mount refresh owner.
  const coordinator = new CatalogRefreshCoordinator({
    readAgent: (agent, signal) => readSurfaceCatalog(agent, signal, ctx as unknown as SurfaceCatalogContext),
    readStanding: async () => { throw new Error('not used') },
    installSnapshot: installed.installSnapshot,
    enterCatalogTransition: installed.enterTransition,
  }, new AbortController().signal, createDiag({ filePath: undefined, stderrLevel: 'off' }))

  // Session A's refresh starts and hangs on the catalog fetch.
  const refreshA = coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: state.generation },
    agent: state.agent,
  })
  // The session switches to B while A's catalog is still loading.
  state.agent = fakeAgent('session-b')
  state.generation = 2
  const refreshB = coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: state.generation },
    agent: state.agent,
  })
  // B's catalog arrives: its commands register.
  services.catalogs.get(state.agent)?.resolve([{ name: 'skill-b', description: 'b', invocation: { modelInvocable: true, userInvocable: true } }])
  const outcomeB = await refreshB
  assert.equal(outcomeB.kind, 'applied')
  assert.ok(services.registered.includes('skill-b'), 'the current session\'s commands must register')
  // A's catalog lands LATE: the coordinator's epoch must drop it entirely.
  for (const [scope, gate] of services.catalogs) {
    if (scope !== state.agent) gate.resolve([{ name: 'skill-a', description: 'a', invocation: { modelInvocable: true, userInvocable: true } }])
  }
  const outcomeA = await refreshA
  assert.equal(outcomeA.kind, 'superseded', 'the stale refresh must report superseded')
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

test('/subagents is a registered alias of /tasks sharing its handler', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const state = { agent: undefined, generation: 1 }
  registerTuiCommands(stubRunner(ctx, app, state))
  const tasksDef = services.defs.find(def => def.name === 'tasks')
  const subagentsDef = services.defs.find(def => def.name === 'subagents')
  assert.ok(tasksDef !== undefined, '/tasks must be registered')
  assert.ok(subagentsDef !== undefined, '/subagents must be registered as an alias')
  assert.equal(subagentsDef!.handler, tasksDef!.handler, '/subagents must share the /tasks handler')
  app.stop()
})

test('/queue is fully removed: the name is no longer host-owned or registered', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  registerTuiCommands(stubRunner(ctx, app, state))
  const queueDef = services.defs.find(def => def.name === 'queue')
  assert.equal(queueDef, undefined,
    '/queue must not be registered — the name is released (input steers to the model like any unknown /line)')
  assert.ok(!LOCAL_COMMANDS.has('queue'), '/queue must be gone from LOCAL_COMMANDS')
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

test('a failing skill catalog refresh degrades to a detached issue, never an unhandled rejection', async () => {
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
    const installed = registerTuiCommands(stubRunner(ctx, app, state, diag))
    const coordinator = new CatalogRefreshCoordinator({
      readAgent: (agent, signal) => readSurfaceCatalog(agent, signal, ctx as unknown as SurfaceCatalogContext),
      readStanding: async () => { throw new Error('not used') },
      installSnapshot: installed.installSnapshot,
      enterCatalogTransition: installed.enterTransition,
    }, new AbortController().signal, diag)
    // The provider failure becomes a DETACHED issue inside the snapshot:
    // the refresh still applies (the commands field survives), the issue
    // lands in diagnostics, and nothing rejects.
    const outcome = await coordinator.refresh({
      source: 'live-session',
      target: { kind: 'agent', key: state.generation },
      agent: state.agent,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(unhandled, [], 'the catalog failure must not leak as an unhandled rejection')
    assert.equal(outcome.kind, 'applied', 'a provider issue is a partial failure, not a refresh failure')
    if (outcome.kind === 'applied') {
      assert.equal(outcome.snapshot.issues.length, 1, 'the issue must be recorded on the snapshot')
      assert.equal(outcome.snapshot.issues[0]?.provider, 'skills')
      assert.deepEqual(outcome.snapshot.skills, [], 'the failed skills field stays empty')
    }
    assert.ok(lines.some(line => /INFO catalog applied/.test(line) && /issues=1/.test(line)),
      `diag must record the partial failure:\n${lines.join('\n')}`)
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

/** A title-handler invocation; only rawInput and signal are consumed. */
function titleInvocation(rawInput: string, signal: AbortSignal = new AbortController().signal) {
  return { commandId: 'cmd-test', agent: undefined as never, rawInput, signal }
}

/** A fake sessionTitle service recording rename/refresh calls. */
function fakeTitles(overrides: {
  refresh?: (session: unknown, signal?: AbortSignal) => Promise<unknown>
  rename?: (session: unknown, name: string) => unknown
} = {}) {
  const calls = {
    rename: [] as { sessionId: string; name: string }[],
    refresh: [] as { sessionId: string; signal: AbortSignal | undefined }[],
  }
  const titles = {
    get: () => undefined,
    rename: (session: unknown, name: string): unknown => {
      calls.rename.push({ sessionId: (session as { id: string }).id, name })
      if (overrides.rename !== undefined) return overrides.rename(session, name)
      return { title: name, eventSeq: 1, messageSeqs: [], source: { kind: 'user' } }
    },
    refresh: async (session: unknown, signal?: AbortSignal): Promise<unknown> => {
      calls.refresh.push({ sessionId: (session as { id: string }).id, signal })
      if (overrides.refresh !== undefined) return overrides.refresh(session, signal)
      return undefined
    },
  }
  return { titles, calls }
}

test('/rename is a registered alias of /title sharing its handler', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('sessionTitle', fakeTitles().titles as never)
  registerTuiCommands(stubRunner(ctx, app, { agent: fakeAgent('session-a'), generation: 1 }))
  const titleDef = services.defs.find(def => def.name === 'title')
  const renameDef = services.defs.find(def => def.name === 'rename')
  assert.ok(titleDef !== undefined, '/title must be registered')
  assert.ok(renameDef !== undefined, '/rename must be registered')
  assert.equal(renameDef!.handler, titleDef!.handler, '/rename must share the /title handler')
  app.stop()
})

test('/title without an argument regenerates and overwrites the current title', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const { titles, calls } = fakeTitles({
    refresh: async () => ({ title: 'fresh ai title', eventSeq: 3, messageSeqs: [], source: { kind: 'auto' } }),
  })
  ctx.provide('sessionTitle', titles as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  const signal = new AbortController().signal
  registerTuiCommands(stubRunner(ctx, app, state))
  const titleDef = services.defs.find(def => def.name === 'title')
  assert.ok(titleDef?.handler !== undefined, '/title handler missing')
  const result = await (titleDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation('', signal))
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls.rename, [], 'a no-argument call must never pin a title')
  assert.equal(calls.refresh.length, 1, 'a no-argument call must refresh once')
  assert.equal(calls.refresh[0]!.sessionId, state.agent.session.id, 'refresh must target the live session id')
  assert.equal(calls.refresh[0]!.signal, signal, 'the invocation signal must be forwarded to refresh')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('title regenerated: fresh ai title'), `regeneration notice missing:\n${view}`)
  app.stop()
})

test('/rename without an argument behaves identically (regenerates)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const { titles, calls } = fakeTitles({
    refresh: async () => ({ title: 'renamed by ai', eventSeq: 4, messageSeqs: [], source: { kind: 'auto' } }),
  })
  ctx.provide('sessionTitle', titles as never)
  registerTuiCommands(stubRunner(ctx, app, { agent: fakeAgent('session-a'), generation: 1 }))
  const renameDef = services.defs.find(def => def.name === 'rename')
  assert.ok(renameDef?.handler !== undefined, '/rename handler missing')
  const result = await (renameDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation(''))
  assert.equal(result.kind, 'success')
  assert.equal(calls.refresh.length, 1, '/rename without an argument must refresh')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('title regenerated: renamed by ai'), `regeneration notice missing:\n${view}`)
  app.stop()
})

test('/title without an argument on a blank session leaves the title as-is', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const { titles, calls } = fakeTitles({ refresh: async () => undefined })
  ctx.provide('sessionTitle', titles as never)
  registerTuiCommands(stubRunner(ctx, app, { agent: fakeAgent('session-a'), generation: 1 }))
  const titleDef = services.defs.find(def => def.name === 'title')
  assert.ok(titleDef?.handler !== undefined, '/title handler missing')
  const result = await (titleDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation(''))
  assert.equal(result.kind, 'success', 'a blank session must degrade to a success notice, not an error')
  assert.equal(calls.refresh.length, 1)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('no conversation yet — title left as-is'), `blank-session notice missing:\n${view}`)
  app.stop()
})

test('/title with an argument pins the title; an invalid title surfaces as an error result', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const { titles, calls } = fakeTitles({
    // The service rejects only hostile input; a plain title pins cleanly.
    rename: (_session, name: string) => {
      if (name.includes('\u0000')) throw new Error('session title must contain visible characters')
    },
  })
  ctx.provide('sessionTitle', titles as never)
  const state = { agent: fakeAgent('session-a'), generation: 1 }
  registerTuiCommands(stubRunner(ctx, app, state))
  const titleDef = services.defs.find(def => def.name === 'title')
  assert.ok(titleDef?.handler !== undefined, '/title handler missing')
  const ok = await (titleDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation('fix footer'))
  assert.equal(ok.kind, 'success')
  assert.deepEqual(calls.rename, [{ sessionId: state.agent.session.id, name: 'fix footer' }],
    'an argument must pin exactly the trimmed name')
  assert.deepEqual(calls.refresh, [], 'an argument must never trigger regeneration')
  // Whitespace-only input counts as NO argument: it regenerates, never pins.
  const whitespace = await (titleDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation('   '))
  assert.equal(whitespace.kind, 'success')
  assert.equal(calls.refresh.length, 1, 'whitespace-only input must take the regeneration path')
  // Hostile input the service rejects must surface as an error result.
  const bad = await (titleDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation('\u0000bad'))
  assert.equal(bad.kind, 'error')
  assert.ok((bad.text ?? '').includes('must contain visible characters'),
    `the invalid-title failure must surface as an error result, got: ${bad.text}`)
  app.stop()
})

test('/title without an argument surfaces a failing refresh as an error result', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const { titles } = fakeTitles({ refresh: async () => { throw new Error('provider quota exceeded') } })
  ctx.provide('sessionTitle', titles as never)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    registerTuiCommands(stubRunner(ctx, app, { agent: fakeAgent('session-a'), generation: 1 }))
    const titleDef = services.defs.find(def => def.name === 'title')
    assert.ok(titleDef?.handler !== undefined, '/title handler missing')
    const result = await (titleDef!.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation(''))
    assert.equal(result.kind, 'error')
    assert.ok((result.text ?? '').includes('provider quota exceeded'),
      `the refresh failure must surface as an error result, got: ${result.text}`)
    assert.deepEqual(unhandled, [], 'the refresh rejection must not leak as an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    app.stop()
  }
})

test('/title and /rename degrade when the sessionTitle service is absent', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  registerTuiCommands(stubRunner(ctx, app, { agent: fakeAgent('session-a'), generation: 1 }))
  const titleDef = services.defs.find(def => def.name === 'title')
  const renameDef = services.defs.find(def => def.name === 'rename')
  assert.ok(titleDef?.handler !== undefined && renameDef?.handler !== undefined)
  for (const def of [titleDef!, renameDef!]) {
    const result = await (def.handler as (inv: ReturnType<typeof titleInvocation>) => Promise<{ kind: string; text?: string }>)(titleInvocation(''))
    assert.equal(result.kind, 'error')
    assert.equal(result.text, 'session title service unavailable')
  }
  app.stop()
})

test('/settings theme autodetect applies only while auto stays the latest choice', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  registerTuiCommands(stubRunner(ctx, app, { agent: fakeAgent('session-a'), generation: 1 }))
  const settingsDef = services.defs.find(def => def.name === 'settings')
  assert.ok(settingsDef?.handler !== undefined, 'settings handler missing')
  ;(settingsDef!.handler as () => unknown)()
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Theme 行（起点 auto）
  await vt.waitForRender()
  // auto → dark → light → auto：最后一次选择是 auto，落地应应用。
  // 注入与当前调色板（light，上一步显式选择）不同的深色应答：只有
  // 检测真正落地才能变 dark——断言不能被显式选择的副作用掩盖。
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r') // light → auto（autodetect 发出）
  await vt.waitForRender()
  vt.sendInput('\x1b]11;#000000\x07') // 深色应答
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(currentPalette, darkColors,
    'a detection landing while auto is the latest choice must apply')
  // 再选 auto，然后在查询落地前切走：落地必须被拒绝。
  vt.sendInput('\r') // auto → dark
  await vt.waitForRender()
  vt.sendInput('\r') // dark → light
  await vt.waitForRender()
  vt.sendInput('\r') // light → auto（新查询）
  await vt.waitForRender()
  vt.sendInput('\r') // auto → dark（查询仍在途，latest choice = dark）
  await vt.waitForRender()
  vt.sendInput('\x1b]11;#eeeeee\x07') // 浅色应答：守卫应拒绝，保持 dark
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(currentPalette, darkColors,
    'a detection landing after the user left auto must not apply')
  app.stop()
})
