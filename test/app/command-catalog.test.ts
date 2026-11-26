/**
 * Headless tests for the command surface catalog layer (M1): synchronous
 * snapshot install (no async I/O before the first input), completion claims
 * (advertised names), the scoped-override merge, skill-wrapper collisions,
 * the human-invocation policy on every /skill entry, and the advertised-miss
 * dispatch decision.
 * @module @xmoon76/dsh-pi-tui/command-catalog.test
 */

import assert from 'node:assert/strict'
import { fakeAgentModel } from '../support/agent-model-double.ts'
import { unavailableAcpAccess, unavailableWebAccess, unavailableMcpServers } from '../support/web-access-fake.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isIndeterminateSkillWrite, registerTuiCommands, type ClientReloadCommandResult, type TuiCommandRunner } from '../../src/commands.ts'
import { CLIENT_RELOAD_REFUSAL_NOTICES } from '../../src/tui/commands/utility.ts'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { LOCAL_COMMANDS, SESSIONLESS_COMMANDS, shouldConsumeAdvertisedMiss } from '../../src/index.ts'
import { classifyCommandLine } from '../../src/domain/command/policy.ts'
import type { SurfaceCatalogSnapshot, SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'
import type { WriteOutcome } from '../../src/runtime/session-writer-port.ts'
import { SessionOperationBarrier, TransitionInProgressError } from '../../src/app/session/operation-barrier.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { unconfiguredPolicyObservation, unconfiguredSessionPolicyPort } from '../support/session-policy-fake.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** A minimal fake agent whose identity marks which session a refresh ran for.
 * Mirrors the real driver's wake semantics: steer/followup synchronously
 * flip status to 'running' (agent-loop's wakeDriver), so tests exercise the
 * same status transitions production sees. */
function fakeAgent(sessionId: string, delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = [], status: 'idle' | 'running' = 'idle'): Agent {
  const options = { provider: 'p', model: 'm' }
  const agent = {
    session: { id: sessionId, header: { cwd: '/ws' }, events: [] },
    options,
    // DSH 0.2.2: the Agent owns its model selection (`AgentModel`).
    model: fakeAgentModel(undefined, options),
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
  state: {
    agent: Agent | undefined
    writerOutcome?: WriteOutcome
    writerCalls?: { kind: 'prompt'; mode?: 'queue' | 'steer'; messages?: readonly unknown[] }[]
    displayWrites?: ('focus' | 'compact' | 'full')[]
  },
  diag: ReturnType<typeof createDiag> = createDiag({ filePath: undefined, stderrLevel: 'off' }),
  options: {
    transitionPending?: boolean
    busyEnter?: string
    generation?: () => number
    initialDisplayPreset?: 'focus' | 'compact' | 'full'
    /** `/new` settlement tests: the preset read and the transaction seams. */
    presetResolve?: () => Promise<{ id: string }>
    navigationStopAccepted?: boolean
    transitionThrows?: { readonly quiesced: boolean; readonly message: string }
    /** M4 PR4: the injected process-owned `/reload-client` capability. */
    requestClientReload?: () => ClientReloadCommandResult
  } = {},
): TuiCommandRunner {
  let displayPreset: 'focus' | 'compact' | 'full' = options.initialDisplayPreset ?? 'full'
  // The scope-bound skill facades delegate to this REAL catalog port (exactly
  // like the production provider).
  const catalog = new DirectCatalogPort(ctx as never, (sessionId) => state.agent?.session.id === sessionId ? state.agent : undefined)
  return {
    beginClientWrite: () => () => {},
    ctx,
    app,
    deliveredFilesSnapshot: () => undefined,
    webAccess: unavailableWebAccess(),
    acpAccess: unavailableAcpAccess(),
    mcpServers: unavailableMcpServers(),
    diag,
    ...sessionScopeFacts(() => state.agent, () => options.generation?.() ?? 1, catalog.skills),
    sessionPolicy: unconfiguredSessionPolicyPort(),
    sessionMarkdown: { read: async () => ({ kind: 'unavailable' }) },
    policy: unconfiguredPolicyObservation(),
    // The scoped collision baseline must read the FAKE registry (which
    // reflects registrations in its global view), exactly like the real
    // commands service does through the production provider.
    listScopedCommands: () => (ctx.get('commands') as unknown as { list(): readonly SurfaceCommandSummary[] }).list(),
    get currentSessionId() { return state.agent?.session.id },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: options.busyEnter === undefined
      ? undefined
      : {
          get: () => ({ busyEnter: options.busyEnter }),
          replace: async () => undefined,
        } as never,
    applyFooterSettings: () => {},
    // WS-2: `/new` pre-selects a Host Workspace before it enters the
    // transition; this stub runner never creates/opens a real Session.
    agents: {
      resolveWorkspace: async () => ({ workspaceId: 'workspace-test', path: '/workspace' }),
      create: async () => { throw new Error('the stub runner never creates a Session') },
      open: async () => { throw new Error('the stub runner never opens a Session') },
    } as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: options.presetResolve === undefined
      ? catalog
      : { ...catalog, presets: { ...catalog.presets, resolve: options.presetResolve } } as never,
    config: new DirectConfigPort(ctx as never, undefined, (sessionId) => state.agent?.session.id === sessionId ? state.agent : undefined),
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort((sessionId) => state.agent?.session.id === sessionId ? state.agent : undefined),
    hostShellCompletion: { pathAuthority: 'client', pathLiteralDialect: 'bash', complete: async () => ({ kind: 'ok', candidates: [] }) },
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
      },
    sessionWriter: {
      prompt: async (_sessionId: string, message: unknown, mode: 'queue' | 'steer') => {
        const outcome = state.writerOutcome
        if (outcome !== undefined && outcome.kind !== 'committed') return outcome
        state.writerCalls?.push({ kind: 'prompt', mode, messages: [message] })
        const target = state.agent as Agent & { followup(message: unknown): void; steer(message: unknown): void }
        if (mode === 'queue') target.followup(message)
        else target.steer(message)
        return outcome ?? { kind: 'committed' as const, value: undefined }
      },
      updateQueue: async (_sessionId: string, _messageId: string) => {
        const outcome = state.writerOutcome
        if (outcome !== undefined && outcome.kind !== 'committed') return outcome
        return outcome ?? { kind: 'committed' as const, value: undefined }
      },
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
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
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: {
      target?: { id: string; header?: { cwd?: string } }
      prepare?: () => Promise<void> | void
      onOldOwnerQuiesced?: () => void
      create: () => Promise<T>
    }) => {
      if (options.transitionThrows !== undefined) {
        if (options.transitionThrows.quiesced) steps.onOldOwnerQuiesced?.()
        throw new Error(options.transitionThrows.message)
      }
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    displayPreset: () => displayPreset,
    setDisplayPreset: (preset) => {
      if (displayPreset === preset) return { kind: 'unchanged', preset }
      displayPreset = preset
      state.displayWrites?.push(preset)
      return { kind: 'applied', preset }
    },
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => displayPreset === 'focus',
    setFocusMode: (enabled) => { displayPreset = enabled ? 'focus' : 'full' },
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openScheduleWorkspace: () => ({ kind: 'success' } as const), createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => options.transitionPending ?? false,
    withSessionTransition: async <T>(
      task: () => T | Promise<T>,
      navigation?: { admission: { oldStopAccepted: boolean } },
    ) => {
      if (options.navigationStopAccepted === true && navigation !== undefined) {
        navigation.admission.oldStopAccepted = true
      }
      return task()
    },
    // The scope-bound writer admission IS the transition refusal now (A3-4):
    // a pending transition makes withWriter throw before the task runs.
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => {
      if (options.transitionPending === true) throw new TransitionInProgressError()
      return task()
    },
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    ...(options.requestClientReload === undefined ? {} : { requestClientReload: options.requestClientReload }),
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

test('display and focus commands share the canonical preset and apply Compact', async () => {
  assert.equal(LOCAL_COMMANDS.has('display'), true, '/display must execute locally')
  assert.equal(SESSIONLESS_COMMANDS.has('display'), true, '/display must work before the first session')
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const displayWrites: ('focus' | 'compact' | 'full')[] = []
  const runner = stubRunner(ctx, app, { agent: undefined, displayWrites })
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name: string, rawInput: string): Promise<{ kind: string; text?: string }> | { kind: string; text?: string } => {
    const definition = services.defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string })({ rawInput })
  }
  assert.deepEqual(await invoke('display', ''), { kind: 'success', text: 'Display: full.' })
  assert.deepEqual(await invoke('display', 'focus'), { kind: 'success', text: 'Display: focus.' })
  assert.deepEqual(await invoke('display', 'status'), { kind: 'success', text: 'Display: focus.' })
  assert.deepEqual(await invoke('focus', 'status'), { kind: 'success', text: 'Focus mode is on.' })
  assert.deepEqual(await invoke('focus', 'off'), { kind: 'success', text: 'Focus mode off.' })
  assert.deepEqual(await invoke('display', 'compact'), { kind: 'success', text: 'Display: compact.' })
  assert.deepEqual(displayWrites, ['focus', 'full', 'compact'], 'every applied preset persists')
  assert.equal(runner.displayPreset?.(), 'compact', 'Compact is the canonical live preset')
  assert.deepEqual(await invoke('focus', 'toggle'), { kind: 'success', text: 'Focus mode on.' })
  assert.deepEqual(await invoke('focus', 'status'), { kind: 'success', text: 'Focus mode is on.' })
  assert.deepEqual(displayWrites, ['focus', 'full', 'compact', 'focus'])
  assert.deepEqual(await invoke('display', 'garbage'), { kind: 'error', text: 'unknown /display verb "garbage" (full|focus|compact|status)' })
  app.stop()
})

test('/focus off maps a seeded Compact state to Full', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const displayWrites: ('focus' | 'compact' | 'full')[] = []
  const runner = stubRunner(ctx, app, { agent: undefined, displayWrites }, undefined, { initialDisplayPreset: 'compact' })
  registerTuiCommandsWithDirectSeams(runner)
  const definition = services.defs.find(candidate => candidate.name === 'focus')
  assert.ok(definition?.handler !== undefined)
  const result = await (definition.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string })({ rawInput: 'off' })
  assert.deepEqual(result, { kind: 'success', text: 'Focus mode off.' })
  assert.equal(runner.displayPreset?.(), 'full')
  assert.deepEqual(displayWrites, ['full'])
  app.stop()
})

test('/display compact fails closed on a legacy runner without the canonical setter', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const focusModes: boolean[] = []
  const stub = stubRunner(ctx, app, { agent: undefined })
  const legacy: TuiCommandRunner = { ...stub, setFocusMode: (enabled) => { focusModes.push(enabled) } }
  delete (legacy as { setDisplayPreset?: unknown }).setDisplayPreset
  registerTuiCommandsWithDirectSeams(legacy)
  const definition = services.defs.find(candidate => candidate.name === 'display')
  assert.ok(definition?.handler !== undefined, '/display must be registered')
  const result = await (definition.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string })({ rawInput: 'compact' })
  assert.deepEqual(result, { kind: 'error', text: 'Display preset "compact" is not available in this build.' })
  assert.deepEqual(focusModes, [], 'Compact must never fall back to setFocusMode(false), which would activate Full')
  app.stop()
})

test('an initial snapshot installs skill wrappers and claims SYNCHRONOUSLY with zero catalog I/O', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const state = { agent: undefined }
  const snapshot = snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }, { name: 'find-skills', description: 'Find skills' }] })
  const { wasAdvertised } = registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, state), { snapshot })
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
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const { wasAdvertised } = registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent: undefined }))
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
  startedApps.add(app)
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
  const { wasAdvertised } = registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent: undefined }), { snapshot })
  assert.deepEqual(
    services.registered.filter(name => name === 'glab' || name === 'scoped-cmd' || name === 'builtin'),
    ['glab'],
    'only the non-colliding wrapper installs; scoped and global commands win',
  )
  assert.equal(wasAdvertised('scoped-cmd'), true, 'the effective command stays advertised')
  app.stop()
})

/** One frozen effective-catalog snapshot with explicit command rows (the
 * mirror-provenance cases need a `definitionId` the shorthands never carry). */
function snapshotWithCommands(
  commands: readonly { name: string; description: string; definitionId?: string }[],
  skills: readonly { name: string; description: string }[],
): SurfaceCatalogSnapshot {
  return Object.freeze({
    commands: Object.freeze(commands.map(command => Object.freeze({ ...command }))),
    scopedCommands: Object.freeze([]),
    skills: Object.freeze(skills.map(skill => Object.freeze({ ...skill }))),
    issues: Object.freeze([]),
  })
}

test('the TUI\'s OWN Direct mirror never self-collides with its own skill wrapper (exact definitionId provenance)', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const { installSnapshot, wasAdvertised, isSkillWrapper } = registerTuiCommandsWithDirectSeams(
    stubRunner(ctx, app, { agent: undefined }),
    { snapshot: snapshotOf({ skills: [{ name: 'wf', description: 'a workflow skill' }] }) },
  )
  assert.equal(isSkillWrapper('wf'), true, 'the wrapper installs')
  // The NEXT effective Host catalog read still carries this surface's OWN global
  // compatibility mirror — stamped with the EXACT definitionId it registered.
  // The skill must not collide with the mirror of ITSELF.
  installSnapshot(snapshotWithCommands(
    [
      { name: 'alpha', description: 'alpha' },
      { name: 'wf', description: '[skill] a workflow skill', definitionId: '@xmoon76/dsh-pi-tui/mirror/wf' },
    ],
    [{ name: 'wf', description: 'a workflow skill' }],
  ))
  assert.deepEqual(services.registered.filter(name => name === 'wf'), ['wf'],
    'the TUI mirror is not genuine Host authority: the wrapper must survive its own refresh')
  assert.equal(isSkillWrapper('wf'), true, 'the live wrapper stays a live wrapper')
  assert.equal(wasAdvertised('wf'), true, 'the wrapper stays advertised after the refresh')
})

test('a GENUINE same-name Host command still blocks the skill wrapper (the mirror exclusion is not a bypass)', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  // The genuine command is LIVE in the global layer …
  services.commands.register({ name: 'wf', description: 'the genuine Host wf' })
  const { wasAdvertised, isSkillWrapper } = registerTuiCommandsWithDirectSeams(
    stubRunner(ctx, app, { agent: undefined }),
    // … and the effective read carries ITS OWN provenance, never this
    // surface's mirror id.
    { snapshot: snapshotWithCommands(
      [
        { name: 'alpha', description: 'alpha' },
        { name: 'wf', description: 'the genuine Host wf', definitionId: '@host/genuine/wf' },
      ],
      [{ name: 'wf', description: 'a workflow skill' }],
    ) },
  )
  assert.equal(isSkillWrapper('wf'), false,
    'a genuine Host same-name winner keeps the name: the wrapper never registers')
  assert.equal(wasAdvertised('wf'), true, 'the genuine Host command stays advertised')
})

test('a commands/change event re-merges completions without re-probing and without losing the saved scoped overrides', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const snapshot = snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] })
  const { wasAdvertised } = registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent: undefined }), { snapshot })
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
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { wasAdvertised, enterTransition } = registerTuiCommandsWithDirectSeams(
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
  // line is steered (which wakes an idle driver) and the body follows as a
  // second ordered steer prompt — turns that wake the driver.
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the transition executes through loadSkill on the current agent')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line is steered (waking an idle driver)')
  assert.equal(delivered[0]?.text, '/glab', 'the original user line is forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'steer', 'the body rides the second ordered steer prompt')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the loaded body uses the official skill_content rendering')
  app.stop()
})

test('loadSkill refuses a session switch while resolving the skill body', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const first = fakeAgent('session-a', delivered)
  const replacement = fakeAgent('session-a', delivered)
  const state: { agent: Agent | undefined } = { agent: first }
  let generation = 1
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => {
      state.agent = replacement
      generation = 2
      return { name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }
    },
  } as never)
  const { defs } = services
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, state, undefined, { generation: () => generation }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /session changed while loading/u)
  assert.deepEqual(delivered, [], 'the stale skill must not write either Agent')
  app.stop()
})

test('loadSkill steers a RUNNING agent at the next step boundary instead of parking in the inbox', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered, 'running')
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'a bare /name delivers the original line AND the injected body')
  assert.equal(delivered[0]?.kind, 'steer', 'a running agent receives the original line as a steer')
  assert.equal(delivered[0]?.text, '/glab', 'the original user line is forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'steer', 'the body rides the second ordered steer prompt')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the loaded body uses the official skill_content rendering')
  app.stop()
})

test('the explicit /skill <name> path steers the original line and injects the body on an idle agent', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the explicit /skill path delivers the original line AND the loaded body')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line is steered (waking an idle driver)')
  assert.equal(delivered[0]?.text, '/glab', 'the original user line is forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'steer', 'the body rides the second ordered steer prompt')
  assert.match(delivered[1]?.text ?? '', /<skill_content name="glab">/, 'the loaded body uses the official skill_content rendering')
  app.stop()
})

test('the explicit /skill path admits and commits inside the shared prompt-admission window', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
  const runner = stubRunner(ctx, app, { agent })
  const inside = { value: false }
  const prepareInside: boolean[] = []
  const admissionLines: string[] = []
  const prepare = runner.prepareDraftMessage
  runner.prepareDraftMessage = async (text: string) => {
    prepareInside.push(inside.value)
    return prepare(text)
  }
  runner.withPromptAdmission = async <T>(_agent: unknown, line: string, task: () => Promise<T> | T): Promise<T> => {
    admissionLines.push(line)
    inside.value = true
    try {
      return await task()
    } finally {
      inside.value = false
    }
  }
  registerTuiCommandsWithDirectSeams(runner)
  const skillDef = services.defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab @image.png' })
  assert.equal(result.kind, 'success')
  // The image capability check + attachment admission (`prepareDraftMessage`)
  // and the delivery commit must both run INSIDE the per-Agent window shared
  // with `/model` selection; running the admission outside it would let a
  // concurrent model switch change the model mid-admission.
  assert.deepEqual(prepareInside, [true], 'the skill admission runs inside the prompt-admission window')
  assert.deepEqual(admissionLines, ['/glab @image.png'], 'the whole invocation line reaches the window')
  assert.equal(delivered.length, 2, 'both ordered prompts were committed inside the window')
  app.stop()
})

test('a transition started after the skill writer entered waits for the skill to commit', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
  const runner = stubRunner(ctx, app, { agent })
  let transitionPending = false
  runner.sessionTransitionPending = () => transitionPending
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let releaseWriter!: () => void
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })
  // Park AFTER the barrier counted this writer but BEFORE the skill task runs:
  // the pre-fix in-writer `sessionTransitionPending()` re-check runs at the very
  // start of the task, so it must observe the transition that starts now.
  runner.withWriter = (_scope, task) => barrier.runWriter('session-a', async () => {
    order.push('writer-entered')
    await writerGate
    return task()
  })
  const prepare = runner.prepareDraftMessage
  runner.prepareDraftMessage = async (text: string) => {
    order.push('admission')
    return prepare(text)
  }
  const writer = runner.sessionWriter
  const originalPrompt = writer.prompt
  writer.prompt = async (sessionId, message, mode) => {
    order.push('commit')
    return originalPrompt(sessionId, message, mode)
  }
  registerTuiCommandsWithDirectSeams(runner)
  const skillDef = services.defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const pending = (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab @image.png' })
  for (let attempt = 0; attempt < 200 && !order.includes('writer-entered'); attempt += 1) {
    await new Promise(resolveTick => setImmediate(resolveTick))
  }
  assert.ok(order.includes('writer-entered'), 'the skill must own the writer before the transition starts')
  assert.deepEqual(order, ['writer-entered'], 'the parked writer has not run its admission yet')
  // A transition starts AFTER the writer entered: the barrier's writer-first
  // contract requires it to WAIT for this writer to drain — it must not cancel
  // an in-flight skill invocation. An in-writer re-check (the reviewed defect)
  // would read `true` here and abandon the skill.
  transitionPending = true
  const transition = barrier.runTransition(async () => { order.push('transition-body') })
  await new Promise(resolveTick => setImmediate(resolveTick))
  assert.ok(!order.includes('transition-body'), 'the later transition waits for the skill writer')
  assert.ok(!order.includes('commit'), 'the skill has not committed while parked')
  releaseWriter()
  const result = await pending
  await transition
  assert.equal(result.kind, 'success')
  assert.ok(order.indexOf('admission') < order.indexOf('commit'), 'admission finishes before the commit')
  assert.equal(order.filter(entry => entry === 'commit').length, 2, 'both ordered skill prompts commit inside the writer')
  assert.equal(order.at(-1), 'transition-body', 'every skill commit happens before the later transition body')
  app.stop()
})

test('a missing agent status still delivers via steer+inject (no status branch)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the load still delivers')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line is always steered, regardless of status')
  assert.equal(delivered[1]?.kind, 'steer', 'the body rides the second ordered steer prompt')
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
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: 'model-only' })
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /not invocable by the user/)
  assert.deepEqual(delivered, [], 'a model-only skill must never be delivered')
  app.stop()
})

test('bare /skill returns the fixed usage error without catalog, picker or skill write; explicit args still load', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const writerCalls: { kind: 'prompt'; mode?: 'queue' | 'steer'; messages?: readonly unknown[] }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const runner = stubRunner(ctx, app, { agent, writerCalls })
  let catalogReads = 0
  const originalListScopedSkills = runner.listScopedSkills
  runner.listScopedSkills = async (scope, signal) => {
    catalogReads += 1
    return originalListScopedSkills(scope, signal)
  }
  let settingsOpened = 0
  app.openSettings = (() => { settingsOpened += 1 }) as unknown as TuiApp['openSettings']
  const { defs } = services
  registerTuiCommandsWithDirectSeams(runner)
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const handler = skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>
  for (const rawInput of ['', '   ', '\t\n']) {
    assert.deepEqual(await handler({ rawInput }), {
      kind: 'error',
      text: 'Usage: /skill <name> [args]. Type / to discover available skills.',
    })
  }
  assert.equal(catalogReads, 0, 'the bare usage branch never reads the skill catalog')
  assert.equal(settingsOpened, 0, 'the bare usage branch never opens a settings list')
  assert.deepEqual(delivered, [], 'the bare usage branch never starts a Skill write')
  assert.deepEqual(writerCalls, [], 'no session writer was reached')
  const loaded = await handler({ rawInput: 'glab alpha beta' })
  assert.equal(loaded.kind, 'success')
  assert.equal((delivered as { text?: string }[])[0]?.text, '/glab alpha beta', 'the explicit path forwards the normalized line and args')
  app.stop()
})

test('a direct skill wrapper re-checks the policy on the CURRENT agent at execution time', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
  const { wasAdvertised } = registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }))
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
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }))
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
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }))
  const skillDef = defs.find(def => def.name === 'skill')
  assert.ok(skillDef?.handler !== undefined)
  const result = await (skillDef!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: 'glab fix bug' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the running /skill path delivers the original line AND the body')
  assert.equal(delivered[0]?.kind, 'steer', 'the original line steers into the running turn')
  assert.equal(delivered[0]?.text, '/glab fix bug', 'the arguments are forwarded verbatim')
  assert.equal(delivered[1]?.kind, 'steer', 'the body rides the second ordered steer prompt')
  app.stop()
})

test('the wrappers tolerate an undefined invocation (defensive rawInput fallback)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const { defs } = services
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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

test('the ordered prompt fallback carries the official source fields and a provider default', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  // The fake agent records the FULL messages, not just their text, so the
  // source can be asserted. A raw inject would fail this contract test.
  const steered: { content: { text: string }[]; source: { kind?: string; name?: string; form?: string } }[] = []
  const agent = {
    session: { id: 'session-a', header: { cwd: '/ws' }, events: [] },
    options: { provider: 'p', model: 'm' },
    status: 'idle',
  } as unknown as Agent
  Object.assign(agent, {
    steer: (message: { content: { text: string }[]; source: { kind?: string; name?: string; form?: string } }) => steered.push(message),
    followup: () => {},
    inject: () => { throw new Error('raw inject is not part of the semantic skill fallback') },
  })
  // No provider field on the loaded skill: the fallback must default it.
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled' }),
  } as never)
  const { defs } = services
  const writerCalls: { kind: 'prompt'; mode?: 'queue' | 'steer'; messages?: readonly unknown[] }[] = []
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent, writerCalls }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.deepEqual(writerCalls.map(call => call.kind), ['prompt', 'prompt'], 'the fallback uses two official prompt operations')
  assert.deepEqual(writerCalls.map(call => call.mode), ['steer', 'steer'], 'both fallback messages use steer mode')
  assert.equal(writerCalls[0]?.messages?.[0], steered[0], 'the line is sent first')
  assert.equal(writerCalls[1]?.messages?.[0], steered[1], 'the skill body is sent second')

  assert.equal(steered.length, 2, 'the fallback steers the line and body')
  const body = steered[1]
  assert.equal(body?.source.kind, 'skill-invocation', 'the fallback uses the official skill-invocation source kind')
  assert.equal(body?.source.name, 'glab', 'the source names the invoked skill')
  assert.equal(body?.source.form, 'instructions', 'the source marks the body as instructions-form context')
  assert.match(body?.content[0]?.text ?? '', /provider "tui"/, 'a missing provider defaults to "tui" in the rendering')
  assert.match(body?.content[0]?.text ?? '', /<skill_content name="glab">/, 'the body uses the official skill_content rendering')
  app.stop()
})

test('the fallback injection forwards the resource base hint', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't', resourceBase: { kind: 'directory', path: '/skills/glab' } }),
  } as never)
  const { defs } = services
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
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

test('a cancelled semantic skill write propagates cancellation instead of a command error', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const agent = fakeAgent('session-a')
  const runner = stubRunner(ctx, app, { agent, writerOutcome: { kind: 'cancelled' } })
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  registerTuiCommandsWithDirectSeams(runner, { snapshot: snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] }) })
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  await assert.rejects(
    () => (wrapper!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  app.stop()
})

test('an indeterminate semantic skill write is explicit and does not auto-retry', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const agent = fakeAgent('session-a')
  const runner = stubRunner(ctx, app, { agent, writerOutcome: { kind: 'indeterminate', error: { code: 'transport/unknown', message: 'delivery state unknown' } } })
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'GitLab CLI', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  registerTuiCommandsWithDirectSeams(runner, { snapshot: snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] }) })
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  await assert.rejects(
    () => (wrapper!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: '' }),
    (error: unknown) => isIndeterminateSkillWrite(error),
  )
  app.stop()
})

test('an indeterminate title write suppresses outer draft restoration', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const agent = fakeAgent('session-a')
  const runner = stubRunner(ctx, app, { agent })
  runner.sessionWriter.rename = async () => ({
    kind: 'indeterminate' as const,
    error: { code: 'transport/unknown', message: 'title result unknown' },
  })
  const registered = registerTuiCommandsWithDirectSeams(runner)
  const title = services.defs.find(def => def.name === 'title')
  assert.ok(title?.handler !== undefined)

  const result = await (title.handler as (invocation: { rawInput: string; commandId: string }) => Promise<unknown>)({ rawInput: 'new title', commandId: 'cmd-title' })
  assert.deepEqual(result, {
    kind: 'error',
    text: 'session title result is indeterminate — do not retry automatically',
  })
  assert.equal(registered.takeCommandDraftDisposition('cmd-title'), 'suppressed')
  assert.equal(registered.takeCommandDraftDisposition('cmd-title'), undefined)
  // The normalized public result carries no private draft marker.
  app.stop()
})

test('a throwing skill steer releases the image pin (review finding)', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
  registerTuiCommandsWithDirectSeams(runner)
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
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  const registered = registerTuiCommandsWithDirectSeams(
    stubRunner(ctx, app, { agent }, createDiag({ filePath: undefined, stderrLevel: 'off' }), { transitionPending: true }),
    { snapshot: snapshotOf({ skills: [{ name: 'glab', description: 'GitLab CLI' }] }) },
  )
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined, 'the skill wrapper must be registered')
  const result = await (wrapper!.handler as (invocation: { rawInput: string; commandId: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: 'fix the pipeline', commandId: 'cmd-transition' })
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /transition is in progress/, 'the refusal explains the retry')
  assert.equal(delivered.length, 0, 'the skill must never write the old agent during a transition')
  assert.ok(app.getDraft().includes('/glab fix'), 'the invocation line is restored to the editor')
  assert.equal(registered.takeCommandDraftDisposition('cmd-transition'), 'restored')
  app.stop()
})

test('the transition fence does NOT refuse skill invocations when no transition is in flight', async () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  const delivered: { kind: 'steer' | 'followup' | 'inject'; text: string }[] = []
  const agent = fakeAgent('session-a', delivered)
  ctx.provide('skills', {
    list: async () => [],
    get: async (name: string) => ({ name, description: 'body', content: 'body', invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled', provider: 't' }),
  } as never)
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent }), { snapshot: snapshotOf({
    skills: [{ name: 'glab', description: 'GitLab CLI' }],
  }) })
  const wrapper = services.defs.findLast(def => def.name === 'glab')
  assert.ok(wrapper?.handler !== undefined)
  const result = await (wrapper!.handler as (invocation: { rawInput: string }) => Promise<{ kind: string }>)({ rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 2, 'the skill delivers the line and the body as usual')
  app.stop()
})

test('capability-truthful discovery copy is registered for the conditional commands', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  registerTuiCommandsWithDirectSeams(stubRunner(ctx, app, { agent: undefined }))
  const descriptionOf = (name: string): string => {
    const def = services.defs.find(candidate => candidate.name === name)
    assert.ok(def?.description !== undefined, `/${name} must be registered with a description`)
    return def.description
  }
  // Each description stays truthful about the conditional capability it
  // advertises; the supported rename/switch/default subpaths stay discoverable
  // and the unsupported ones no longer over-promise.
  assert.equal(descriptionOf('model'),
    'Switch the model (and reasoning effort) for this session; before a session exists, change the default when supported')
  assert.equal(descriptionOf('title'),
    'Set the session title; without an argument, regenerate it from the conversation when supported (overwrites the current title)')
  assert.equal(descriptionOf('attach'),
    'Attach an image or file to the draft; generic-file delivery requires backend support (tab completes the path)')
  assert.equal(descriptionOf('transcript'),
    'Export this session as official Markdown')
  assert.equal(descriptionOf('login'),
    'Open Models to configure provider credentials or sign in to DeepSeek Account')
  assert.equal(descriptionOf('logout'),
    'Open Models to clear a stored provider credential or sign out of DeepSeek Account')
  app.stop()
})

test('the built-in command decomposition preserves the exact primary set and registration order', () => {
  // TS1 moved the definitions into `src/tui/commands/**`: this lock proves the
  // decomposition neither lost nor added a command and kept the raw
  // registration sequence (including each alias at its own position), which
  // the synchronous `commands/change` effects depend on.
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const runner = stubRunner(ctx, app, { agent: undefined })
  registerTuiCommandsWithDirectSeams(runner)
  // The seven existing aliases: an alias is another NAME of the same logical
  // command, registered immediately after its primary. `/status` is the
  // `/settings` alias (C5).
  const ALIASES = new Set(['quit', 'status', 'statusline', 'resume', 'subagents', 'image', 'rename'])
  // The built-in primaries, in their frozen registration order. `/web` is the
  // M5-W PR-C Split-Client control entry and registers immediately after
  // Settings; `/acp` is the PO-5E Split-Client ACP quick control and
  // registers immediately after `/web`.
  assert.deepEqual(
    services.registered.filter(name => !ALIASES.has(name)),
    [
      'exit', 'reload-client', 'settings', 'web', 'acp', 'footer', 'display', 'focus', 'sessions', 'skill', 'reload', 'model',
      'new', 'tasks', 'queue', 'schedule', 'plugins', 'yolo', 'preset', 'search', 'title', 'copy', 'attach', 'view-image',
      'export', 'transcript', 'deliverables', 'fork', 'rewind', 'login', 'logout', 'keybindings',
    ],
  )
  // The raw sequence: every alias registers immediately after its primary.
  assert.deepEqual(services.registered, [
    'exit', 'quit',
    'reload-client',
    'settings', 'status',
    'web',
    'acp',
    'footer', 'statusline',
    'display', 'focus',
    'sessions', 'resume',
    'skill', 'reload',
    'model',
    'new',
    'tasks', 'subagents',
    'queue',
    'schedule',
    'plugins',
    'yolo', 'preset',
    'search',
    'title', 'rename',
    'copy', 'attach', 'image', 'view-image', 'export', 'transcript', 'deliverables',
    'fork', 'rewind',
    'login', 'logout',
    'keybindings',
  ])
  // C5: `/status` is the real `/settings` alias, not a second handler.
  const settings = services.defs.find(definition => definition.name === 'settings')
  const status = services.defs.find(definition => definition.name === 'status')
  assert.ok(settings?.handler !== undefined && status?.handler !== undefined)
  assert.equal(status.handler, settings.handler, 'the alias and primary share ONE handler')
  assert.match(status.description ?? '', /alias of \/settings/u)
  assert.equal(LOCAL_COMMANDS.has('status'), true)
  assert.equal(SESSIONLESS_COMMANDS.has('status'), true, 'the alias executes before a session exists')
  // The alias definition has no `input` descriptor, so it claims the BARE
  // token only; an argued `/status x` is an ordinary submission and the
  // production classifier must not route it to the alias handler.
  assert.equal(runner.clientCommands.claimsLine({ name: 'status', rawInput: '' }), true)
  assert.equal(runner.clientCommands.claimsLine({ name: 'status', rawInput: 'x' }), false)
  assert.equal(classifyCommandLine({
    hostOriginClaim: undefined,
    tuiCommand: false,
    extensionCommand: false,
    skillInvocation: false,
  }).kind, 'ordinary-submission', 'argued /status x is not a Client invocation')
  assert.equal(classifyCommandLine({
    hostOriginClaim: { claimed: true, attachments: false },
    tuiCommand: false,
    extensionCommand: false,
    skillInvocation: false,
  }).kind, 'host-command', 'a genuine Host claim still owns an argued /status line')
  app.stop()
})

test('/new keeps the accepted-stop phase when a commit throw escapes the transaction', async () => {
  // The transition's synchronous commit can throw AFTER the OLD-owner quiesce.
  // The handler must keep the phase fact instead of letting the generic
  // command path drop it: the stronger "stopped (cannot resume)" only when the
  // quiesce callback fired; otherwise the weaker "requested, not confirmed".
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const run = async (quiesced: boolean): Promise<{ kind: string; text?: string }> => {
    const runner = stubRunner(ctx, app, { agent: undefined }, undefined, {
      presetResolve: async () => ({ id: 'test-preset' }),
      navigationStopAccepted: true,
      transitionThrows: { quiesced, message: 'commit seam exploded' },
    })
    registerTuiCommandsWithDirectSeams(runner)
    const definition = services.defs.filter(candidate => candidate.name === 'new').at(-1)
    assert.ok(definition?.handler !== undefined, 'the /new handler must be registered')
    return (definition.handler as (invocation: never) => Promise<{ kind: string; text?: string }>)({
      commandId: 'cmd-new', agent: undefined, rawInput: '', signal: new AbortController().signal,
    } as never)
  }
  const afterQuiesce = await run(true)
  assert.equal(afterQuiesce.kind, 'error')
  assert.match(afterQuiesce.text ?? '', /commit seam exploded/)
  assert.match(afterQuiesce.text ?? '', /old turn stopped \(cannot resume\)/,
    'a commit throw after the quiesce keeps the stronger proven fact')
  const beforeQuiesce = await run(false)
  assert.equal(beforeQuiesce.kind, 'error')
  assert.match(beforeQuiesce.text ?? '', /turn stop requested \(not yet confirmed\)/,
    'a throw before the quiesce must not claim a stopped Turn')
  assert.doesNotMatch(beforeQuiesce.text ?? '', /old turn stopped \(cannot resume\)/)
})

// ── M4 PR4: `/reload-client` ────────────────────────────────────────────────

test('`/reload-client` is a bare reserved sessionless Client command with fixed notices', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const requests: ClientReloadCommandResult[] = []
  let next: ClientReloadCommandResult = { kind: 'accepted' }
  const runner = stubRunner(ctx, app, { agent: undefined }, undefined, {
    requestClientReload: () => {
      requests.push(next)
      return next
    },
  })
  registerTuiCommandsWithDirectSeams(runner)

  // The LIVE Client registry owns the BARE token only (the official
  // `matchEnter` semantics): an argued line is an ordinary submission and can
  // never reach the reload handler.
  assert.equal(runner.clientCommands.claimsLine({ name: 'reload-client', rawInput: '' }), true)
  assert.equal(runner.clientCommands.claimsLine({ name: 'reload-client', rawInput: ' anything' }), false)
  // The policy sets keep the name reserved/plugin-proof and sessionless: the
  // reload must work before the first session and must never create one.
  assert.equal(LOCAL_COMMANDS.has('reload-client'), true)
  assert.equal(SESSIONLESS_COMMANDS.has('reload-client'), true)
  // The production classifier routes the bare line to the Client command
  // family (never the Host/ordinary-submission families).
  assert.deepEqual(
    classifyCommandLine({
      hostOriginClaim: undefined,
      tuiCommand: runner.clientCommands.claimsLine({ name: 'reload-client' }),
      extensionCommand: false,
      skillInvocation: false,
    }),
    { kind: 'client-command', source: 'tui' },
  )
  // The original `/reload` (catalog/settings refresh) stays a DISTINCT
  // command — the new process reload never replaced it.
  const reload = services.defs.find(definition => definition.name === 'reload')
  const reloadClient = services.defs.find(definition => definition.name === 'reload-client')
  assert.ok(reload?.handler !== undefined && reloadClient?.handler !== undefined)
  assert.notEqual(reload.handler, reloadClient.handler)

  const handler = reloadClient.handler as (invocation: { commandId: string }) => CommandResult
  // Accepted: ONE success result, no duplicate notice — the new surface is the
  // success evidence.
  assert.deepEqual(handler({ commandId: 'cmd-reload-client' }), { kind: 'success' })
  assert.equal(requests.length, 1)
  // Every refusal maps to its ONE fixed notice and still returns `error`.
  for (const [reason, text] of Object.entries(CLIENT_RELOAD_REFUSAL_NOTICES)) {
    next = { kind: 'refused', reason: reason as keyof typeof CLIENT_RELOAD_REFUSAL_NOTICES }
    assert.deepEqual(handler({ commandId: `cmd-${reason}` }), { kind: 'error', text },
      `/${reason} must report its fixed notice`)
  }
  assert.equal(requests.length, 1 + Object.keys(CLIENT_RELOAD_REFUSAL_NOTICES).length)
  app.stop()
})

test('`/reload-client` on Direct (no process capability) is an explicit local refusal', () => {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeServices()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', services.skills as never)
  const runner = stubRunner(ctx, app, { agent: undefined })
  registerTuiCommandsWithDirectSeams(runner)
  const definition = services.defs.find(candidate => candidate.name === 'reload-client')
  assert.ok(definition?.handler !== undefined)
  const result = (definition.handler as (invocation: { commandId: string }) => CommandResult)({ commandId: 'cmd-direct' })
  assert.deepEqual(result, {
    kind: 'error',
    text: 'Client reload is available only in the split Client.',
  }, 'Direct answers the fixed unavailable refusal — no Host RPC, no model prompt, no restart')
  app.stop()
})
