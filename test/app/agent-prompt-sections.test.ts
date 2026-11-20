/**
 * M6 PR-C C2: the ONE shared per-Agent TUI prompt-section policy.
 *
 * The contract this suite protects (plan §3 C2):
 *
 * ```text
 * Direct and Split Host install the SAME four sections through the SAME
 * neutral functions (app/agent/prompt-sections.ts), and the per-Turn
 * eligibility/focus latch (app/agent/turn-policy.ts) is sampled ONCE at the
 * official turn/start and cleared at turn/end.
 * ```
 *
 * Evidence level: IN_PROCESS over the REAL rc.5 `systemPrompt` registry (the
 * same service production uses) and the REAL synchronous `session/event`
 * plane of a real Session. The section text is asserted through the REAL
 * assembly (`assemble()` + `renderPrompt`), never through a fake registry, so
 * a divergence between "what the provider returns" and "what the model sees"
 * fails here.
 *
 * DELIBERATELY ABSENT: the Host-side presence service (C3), the real
 * two-OS-process Clients (C4 smoke), and any external provider.
 *
 * @module @xmoon76/dsh-pi-tui/app/agent-prompt-sections.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  GIT_ATTRIBUTION_SECTION_NAME,
  GIT_ATTRIBUTION_SECTION_ORDER,
} from '../../src/domain/communication/git-attribution.ts'
import {
  FOCUS_MODE_PROMPT,
  FOCUS_SECTION_NAME,
  FOCUS_SECTION_ORDER,
} from '../../src/domain/communication/focus.ts'
import {
  PROGRESS_UPDATES_SECTION_NAME,
  PROGRESS_UPDATES_SECTION_ORDER,
  RESPONSE_STYLE_SECTION_NAME,
  RESPONSE_STYLE_SECTION_ORDER,
} from '../../src/domain/communication/policy.ts'
import {
  installTuiPromptSections,
  liveDisplayTurnPolicy,
  turnFocusText,
  turnProgressText,
  type SystemPromptLike,
  type TuiPromptLiveStates,
  type TuiPromptTurnPolicy,
} from '../../src/app/agent/prompt-sections.ts'
import { installTuiPromptTurnLatch } from '../../src/app/agent/turn-policy.ts'
import { HostAgentPromptOwner } from '../../src/app/host/features/agent-prompt.ts'
import { installDirectTuiSystemPromptSections } from '../../src/app/direct/system-prompt.ts'

/** The four fixed identities every backend must register. */
const EXPECTED_SECTIONS = [
  { name: PROGRESS_UPDATES_SECTION_NAME, order: PROGRESS_UPDATES_SECTION_ORDER },
  { name: RESPONSE_STYLE_SECTION_NAME, order: RESPONSE_STYLE_SECTION_ORDER },
  { name: GIT_ATTRIBUTION_SECTION_NAME, order: GIT_ATTRIBUTION_SECTION_ORDER },
  { name: FOCUS_SECTION_NAME, order: FOCUS_SECTION_ORDER },
] as const

/** The default live states (all sections non-empty except Focus). */
function liveStates(overrides: Partial<{ mode: 'off' | 'milestones' | 'frequent'; style: 'default' | 'concise' | 'explanatory'; attribution: 'off' | 'product' | 'product-model' }> = {}): TuiPromptLiveStates {
  return {
    progressUpdates: () => ({ mode: overrides.mode ?? 'milestones' }),
    responseStyle: () => ({ style: overrides.style ?? 'concise' }),
    gitAttribution: () => ({ mode: overrides.attribution ?? 'product' }),
  }
}

/** A real SystemPrompt registry scoped to one fake Agent scope key. */
async function mountRegistry(): Promise<{
  ctx: Context
  scope: object
  registry: SystemPromptLike
  render(): Promise<string>
  dispose(): Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: 'BASE PERSONA', personaSuffix: '' })
  const scope = {}
  const registry = ctx.systemPrompt as unknown as SystemPromptLike
  return {
    ctx,
    scope,
    registry,
    render: async () => renderPrompt(await ctx.systemPrompt.assemble({ scope } as never)),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

test('the shared installer registers exactly the four TUI sections at their fixed orders', async () => {
  const mounted = await mountRegistry()
  try {
    const turn: TuiPromptTurnPolicy = { currentTurn: () => ({ eligible: true, focus: false }) }
    const disposers = installTuiPromptSections({
      systemPrompt: mounted.registry,
      turn,
      live: liveStates(),
    })
    assert.equal(disposers.length, 4, 'four registrations, one per section')
    const assembly = await mounted.ctx.systemPrompt.assemble({ scope: mounted.scope } as never)
    const tuiSections = assembly.sections
      .filter(section => section.name.startsWith('tui:'))
      .map(section => ({ name: section.name, order: (EXPECTED_SECTIONS.find(expected => expected.name === section.name) ?? { order: -1 }).order }))
    assert.deepEqual(tuiSections, EXPECTED_SECTIONS.map(section => ({ name: section.name, order: section.order })),
      'the four TUI sections register once each at their fixed orders')
    for (const dispose of disposers) dispose()
  } finally {
    await mounted.dispose()
  }
})

test('the frozen Turn snapshot owns eligibility and Focus; the preference axes stay live providers', async () => {
  const mounted = await mountRegistry()
  try {
    let frozen: { eligible: boolean; focus: boolean } | undefined = { eligible: true, focus: false }
    const turn: TuiPromptTurnPolicy = { currentTurn: () => frozen }
    const mode = { mode: 'milestones' as 'off' | 'milestones' | 'frequent' }
    const disposers = installTuiPromptSections({
      systemPrompt: mounted.registry,
      turn,
      live: {
        progressUpdates: () => mode,
        responseStyle: () => ({ style: 'concise' as const }),
        gitAttribution: () => ({ mode: 'product' as const }),
      },
    })
    try {
      // eligible + non-focus: all three communication sections render.
      let prompt = await mounted.render()
      assert.match(prompt, /# Progress updates: Milestones/u)
      assert.match(prompt, /# Response style: Concise/u)
      assert.match(prompt, /# Git attribution/u)
      assert.doesNotMatch(prompt, /# Focus mode/u)

      // The LIVE preference axis moves without touching the Turn snapshot.
      mode.mode = 'frequent'
      prompt = await mounted.render()
      assert.match(prompt, /# Progress updates: Frequent/u, 'the live cadence reaches the next assembly')

      // eligible + focus: Focus renders, progress is suppressed, others stay.
      frozen = { eligible: true, focus: true }
      prompt = await mounted.render()
      assert.match(prompt, /# Focus mode/u)
      assert.ok(prompt.includes(FOCUS_MODE_PROMPT), 'the exact Focus instruction reaches the model')
      assert.doesNotMatch(prompt, /# Progress updates/u, 'Focus suppresses the progress section')
      assert.match(prompt, /# Response style: Concise/u, 'response style is independent of Focus')
      assert.match(prompt, /# Git attribution/u, 'attribution is independent of Focus')
      assert.equal(mode.mode, 'frequent', 'Focus never mutates the saved cadence')

      // Not eligible (no current TUI viewer): NONE of the four participate.
      frozen = { eligible: false, focus: true }
      prompt = await mounted.render()
      assert.doesNotMatch(prompt, /# Progress updates/u)
      assert.doesNotMatch(prompt, /# Response style/u)
      assert.doesNotMatch(prompt, /# Git attribution/u)
      assert.doesNotMatch(prompt, /# Focus mode/u,
        'an ineligible Turn renders no TUI policy even when the focus bit is set')
      assert.match(prompt, /BASE PERSONA/u, 'the deployment persona is untouched')

      // Between Turns (no frozen snapshot): also nothing.
      frozen = undefined
      prompt = await mounted.render()
      assert.doesNotMatch(prompt, /# Progress updates|# Response style|# Git attribution|# Focus mode/u)
    } finally {
      for (const dispose of disposers) dispose()
    }
  } finally {
    await mounted.dispose()
  }
})

test('the live preference providers are re-read per assembly even when they return FRESH state objects', async () => {
  // The Split Host shape: every accessor call parses the canonical refs into
  // a NEW state object. Capturing the object at registration would freeze the
  // values for the Agent's whole lifetime (the regression this pins).
  const mounted = await mountRegistry()
  try {
    let progress: 'off' | 'milestones' | 'frequent' = 'frequent'
    const disposers = installTuiPromptSections({
      systemPrompt: mounted.registry,
      turn: { currentTurn: () => ({ eligible: true, focus: false }) },
      live: {
        progressUpdates: () => ({ mode: progress }),
        responseStyle: () => ({ style: 'concise' as const }),
        gitAttribution: () => ({ mode: 'product' as const }),
      },
    })
    try {
      let prompt = await mounted.render()
      assert.match(prompt, /# Progress updates: Frequent/u)
      progress = 'off'
      prompt = await mounted.render()
      assert.match(prompt, /# Progress updates: Off/u,
        'a fresh state object per accessor call reaches the next assembly')
      assert.doesNotMatch(prompt, /# Progress updates: Frequent/u)
    } finally {
      for (const dispose of disposers) dispose()
    }
  } finally {
    await mounted.dispose()
  }
})

test('the latch samples ONCE at turn/start, freezes for the Turn, and clears only at the matching turn/end', () => {
  // A minimal synchronous event plane matching the official `session/event`
  // contract (the real one is covered by the assembly test below).
  const listeners: Array<(session: { id: string }, event: { type: string; data?: unknown }) => void> = []
  const source = {
    on: (_event: 'session/event', listener: (session: { id: string }, event: { type: string; data?: unknown }) => void) => {
      listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    },
  }
  const sessionA = { id: 'session-a' }
  const sessionB = { id: 'session-b' }
  let samples = 0
  let next: { eligible: boolean; focus: boolean } = { eligible: true, focus: false }
  const latch = installTuiPromptTurnLatch(source, sessionA, () => {
    samples += 1
    return next
  })
  try {
    const emit = (session: { id: string }, type: string, turn: number): void => {
      for (const listener of [...listeners]) listener(session, { type, data: { turn } })
    }
    assert.equal(latch.currentTurn(), undefined, 'between Turns there is no policy')
    // Another Session's boundary never moves this latch.
    emit(sessionB, 'turn/start', 1)
    assert.equal(latch.currentTurn(), undefined)
    assert.equal(samples, 0, 'a foreign Session never samples this Agent')
    // A REPLACED same-id Session object never moves this latch either.
    emit({ id: 'session-a' }, 'turn/start', 1)
    assert.equal(samples, 0, 'a replaced same-id Session never samples this Agent')
    // The first real boundary samples ONCE and freezes.
    emit(sessionA, 'turn/start', 1)
    assert.deepEqual(latch.currentTurn(), { eligible: true, focus: false })
    assert.equal(samples, 1)
    // A later viewer change must NOT move the frozen Turn.
    next = { eligible: false, focus: true }
    assert.deepEqual(latch.currentTurn(), { eligible: true, focus: false },
      'the sampled policy is frozen for exactly this Turn')
    assert.equal(samples, 1, 'the sampler is called once per Turn')
    // A stale (wrong Turn number) or replaced-object end boundary must NOT
    // clear the frozen Turn.
    emit(sessionA, 'turn/end', 2)
    emit({ id: 'session-a' }, 'turn/end', 1)
    assert.deepEqual(latch.currentTurn(), { eligible: true, focus: false },
      'only the exact matching turn/end clears the frozen Turn')
    // The exact matching turn/end clears.
    emit(sessionA, 'turn/end', 1)
    assert.equal(latch.currentTurn(), undefined, 'the matching turn/end clears the latch')
    // The next Turn resamples the CURRENT viewers.
    emit(sessionA, 'turn/start', 2)
    assert.deepEqual(latch.currentTurn(), { eligible: false, focus: true })
    assert.equal(samples, 2)
    // Disposal removes exactly this listener and clears the policy.
    latch.dispose()
    emit(sessionA, 'turn/end', 2)
    emit(sessionA, 'turn/start', 3)
    assert.equal(samples, 2, 'a disposed latch never samples again')
    assert.equal(listeners.length, 0, 'the listener was removed')
  } finally {
    latch.dispose()
  }
})

test('a remounted latch never reconstructs a Turn that started before it existed', () => {
  // Plan §8.5 (Host remount): an already-open Turn has no authoritative
  // previous Focus snapshot — the latch must FAIL CLOSED (no TUI policy for
  // the remainder of that Turn), never reconstruct one from current views.
  const listeners: Array<(session: { id: string }, event: { type: string; data?: unknown }) => void> = []
  const source = {
    on: (_event: 'session/event', listener: (session: { id: string }, event: { type: string; data?: unknown }) => void) => {
      listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    },
  }
  const sessionA = { id: 'session-a' }
  const emit = (session: { id: string }, type: string, turn: number): void => {
    for (const listener of [...listeners]) listener(session, { type, data: { turn } })
  }
  // The Turn (turn 1) is ALREADY open when the latch installs mid-Turn.
  let samplingAllowed = false
  const latch = installTuiPromptTurnLatch(source, sessionA, () => {
    if (!samplingAllowed) throw new Error('a remounted latch must never sample an already-open Turn')
    return { eligible: true, focus: false }
  })
  try {
    assert.equal(latch.currentTurn(), undefined,
      'no snapshot is reconstructed for a Turn that started before the latch existed')
    // The already-open Turn's own end boundary changes nothing.
    emit(sessionA, 'turn/end', 1)
    assert.equal(latch.currentTurn(), undefined)
    // The NEXT Turn freezes normally from the current viewers.
    samplingAllowed = true
    emit(sessionA, 'turn/start', 2)
    assert.deepEqual(latch.currentTurn(), { eligible: true, focus: false },
      'the next Turn samples at its own boundary like any other')
  } finally {
    latch.dispose()
  }
})

test('the latch freezes the snapshot a real Session boundary publishes, and the assembly renders it', async (t) => {
  // The end-to-end ordering proof on the REAL rc.5 services: a real Session's
  // synchronous `session/event` publish feeds the latch, and the REAL
  // SystemPrompt assembly then renders exactly the frozen policy.
  const { createRemoteApplicationHostFixture } = await import('../support/remote-application-fixture.ts')
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const { createUserMessage, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const life = testLifecycle(t)
  class CompletedAdapter extends LlmAdapter {
    override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
      return Promise.resolve({ provider, id: model, name: model })
    }
    override listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
      return Promise.resolve([{ provider: 'smoke', id: 'smoke-model', name: 'smoke-model' }])
    }
    override async *stream(): AsyncIterable<never> {
      yield { type: 'finish', reason: { kind: 'stop' } } as never
    }
  }
  const host = await createRemoteApplicationHostFixture(life, 'c2-turn-latch', {
    llmAdapter: new CompletedAdapter(),
    // This case installs its OWN controlled latch + sections on the real
    // Agent; the Host Runtime row would install the production policy first
    // and collide on the section names (that installation has its own suites).
    withoutHostRuntime: true,
  })
  try {
    const agent = await host.harness.create(
      SessionId('c2-turn-latch-session'),
      { provider: 'smoke', model: 'smoke-model' } as never,
      { cwd: host.anchorDir },
    )
    let viewers: Array<'focus' | 'full'> = ['focus']
    const latch = installTuiPromptTurnLatch(
      { on: (event, listener, options) => host.ctx.on(event, listener, options) },
      agent.session as unknown as { readonly id: string },
      () => ({ eligible: viewers.length > 0, focus: viewers.includes('focus') }),
    )
    const registry = agent.ctx.get('systemPrompt') as unknown as SystemPromptLike
    const disposers = installTuiPromptSections({
      systemPrompt: registry,
      turn: latch,
      live: liveStates({ mode: 'milestones', attribution: 'off' }),
    })
    const renderAgentPrompt = async (): Promise<string> => renderPrompt(
      await (agent.ctx.get('systemPrompt') as unknown as {
        assemble(context: unknown): Promise<Parameters<typeof renderPrompt>[0]>
      }).assemble({ agent, scope: agent }),
    )
    try {
      // Outside a Turn nothing renders.
      assert.doesNotMatch(await renderAgentPrompt(), /# Focus mode|# Progress updates/u)
      // The REAL turn freezes focus=true at turn/start, before the loop's
      // first assembly of that Turn.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      // The turn ENDED, so the latch cleared and the next render is empty.
      assert.equal(latch.currentTurn(), undefined, 'the ended turn cleared the latch')
      assert.doesNotMatch(await renderAgentPrompt(), /# Focus mode|# Progress updates/u,
        'between Turns no TUI policy renders')
      // The next Turn resamples a NEW viewer set (now non-focus, still eligible).
      viewers = ['full']
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      assert.equal(latch.currentTurn(), undefined)
      // And with NO viewers the next Turn is ineligible.
      viewers = []
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      // The Agent really ran three turns: the boundaries were all observed.
      const turns = (agent.session as unknown as {
        snapshotEvents(): ReadonlyArray<{ type: string }>
      }).snapshotEvents().filter(event => event.type === 'turn/start')
      assert.equal(turns.length, 3, 'three real turns crossed the synchronous latch')
    } finally {
      for (const dispose of disposers) dispose()
      latch.dispose()
    }
  } finally {
    await host.dispose()
  }
})

test('the Direct compatibility adapter installs the SAME four sections from one display state', async () => {
  const mounted = await mountRegistry()
  try {
    const displayState: { preset: 'focus' | 'compact' | 'full' } = { preset: 'full' }
    const disposers = installDirectTuiSystemPromptSections(mounted.ctx as never, {
      displayState,
      progressUpdatesState: { mode: 'milestones' },
      responseStyleState: { style: 'concise' },
      gitAttributionState: { mode: 'product' },
    })
    assert.equal(disposers.length, 4, 'the adapter installs the same four sections')
    let prompt = await mounted.render()
    assert.match(prompt, /# Progress updates: Milestones/u)
    assert.match(prompt, /# Response style: Concise/u)
    assert.match(prompt, /# Git attribution/u)
    // The pre-C2 semantics stay: the live display state drives Focus, and a
    // live flip is seen by the next assembly with no re-registration.
    displayState.preset = 'focus'
    prompt = await mounted.render()
    assert.ok(prompt.includes(FOCUS_MODE_PROMPT), 'a live Focus flip reaches the next assembly')
    assert.doesNotMatch(prompt, /# Progress updates/u)
    for (const dispose of disposers) dispose()
  } finally {
    await mounted.dispose()
  }
})

test('the pure turn text helpers stay the ONE authority for each section', () => {
  // The helpers are what every adapter (Direct, Host, tests) folds through;
  // an adapter that re-derives the text would bypass this contract.
  const eligibleFrozen = { eligible: true, focus: false }
  const focusFrozen = { eligible: true, focus: true }
  const ineligible = { eligible: false, focus: false }
  assert.match(turnProgressText(eligibleFrozen, { mode: 'frequent' }), /# Progress updates: Frequent/u)
  assert.equal(turnProgressText(focusFrozen, { mode: 'frequent' }), '', 'Focus empties progress')
  assert.equal(turnProgressText(ineligible, { mode: 'frequent' }), '', 'an ineligible Turn renders nothing')
  assert.equal(turnProgressText(undefined, { mode: 'frequent' }), '', 'no Turn renders nothing')
  assert.equal(turnFocusText(eligibleFrozen), '')
  assert.equal(turnFocusText(focusFrozen), FOCUS_MODE_PROMPT)
  assert.equal(turnFocusText(ineligible), '')
  assert.equal(turnFocusText(undefined), '')
})

test('the live-display compatibility policy keeps every Turn eligible', () => {
  const policy = liveDisplayTurnPolicy({ preset: 'focus' })
  assert.deepEqual(policy.currentTurn(), { eligible: true, focus: true })
  const full = liveDisplayTurnPolicy({ preset: 'full' })
  assert.deepEqual(full.currentTurn(), { eligible: true, focus: false })
})
test('the Host prompt owner releases every observer and section at dispose, and remounts cleanly (RFL-004 lifecycle)', () => {
  // ONE roster-observer pair per owner lifetime: dispose() releases the
  // agent/created + agent/disposed listeners and unregisters every installed
  // section; a late roster event installs nothing; a remount is a fresh owner.
  const listeners = new Map<string, Array<(payload: { agent: unknown }) => void>>()
  const emit = (event: string, agent: unknown): void => {
    for (const listener of [...listeners.get(event) ?? []]) listener({ agent })
  }
  const ctx = {
    on(event: string, listener: (payload: { agent: unknown }) => void) {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== listener))
      }
    },
    effect(fn: () => () => void) {
      fn()
    },
    reflect: { get: () => ({ list: () => [makeAgent('a1')] }) },
  }
  const registered: string[] = []
  const unregistered: string[] = []
  const makeAgent = (id: string): unknown => ({
    id,
    session: { id, header: { origin: 'user' } },
    ctx: {
      get: (name: string) => (name === 'systemPrompt' ? {
        section: (spec: { name: string }) => {
          registered.push(`${id}:${spec.name}`)
          return () => { unregistered.push(`${id}:${spec.name}`) }
        },
        assemble: async () => ({ sections: [] }),
      } : undefined),
    },
  })
  const options = {
    ctx,
    voters: { snapshotVoters: () => ({ eligible: false, focus: false }) },
    preferences: {
      progressUpdates: () => ({ mode: 'off' }),
      responseStyle: () => ({ style: 'concise' }),
      gitAttribution: () => ({ mode: 'product' }),
    },
  }
  const owner = new HostAgentPromptOwner(ctx as never, options as never)
  owner.installLiveAgents()
  assert.equal(registered.length, 4, 'the four sections install once on the live Agent')
  emit('agent/created', makeAgent('a2'))
  assert.equal(registered.length, 8, 'a later Agent installs through the roster event')
  owner.dispose()
  assert.equal(listeners.get('agent/created')?.length, 0, 'dispose releases the created observer')
  assert.equal(listeners.get('agent/disposed')?.length, 0, 'dispose releases the disposed observer')
  assert.equal(unregistered.length, 8, 'dispose unregisters every installed section')
  emit('agent/created', makeAgent('a3'))
  assert.equal(registered.length, 8, 'a disposed owner never installs again')
  // A remount is a fresh owner over the same Host state.
  const remounted = new HostAgentPromptOwner(ctx as never, options as never)
  remounted.installLiveAgents()
  assert.equal(registered.length, 12, 'the remounted owner installs on the live Agent exactly once')
  remounted.dispose()
  assert.equal(unregistered.length, 12, 'the remounted owner releases everything it installed')
})
