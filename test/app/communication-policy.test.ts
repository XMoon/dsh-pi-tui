import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { disposeContext, fakeSession, installVirtualProcessTerminal, makeHarness, mountRunner, sessionEvents, settle } from '../support/runner-harness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { navigateToLegacySettings } from '../support/open-legacy-settings.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { composeAgent } from '../../src/index.ts'
import { FOCUS_MODE_PROMPT } from '../../src/domain/communication/focus.ts'
import type { DisplayState } from '../../src/domain/display/preset.ts'
import {
  DEFAULT_PROGRESS_UPDATES,
  DEFAULT_RESPONSE_STYLE,
  PROGRESS_UPDATES_SECTION_NAME,
  PROGRESS_UPDATES_SECTION_ORDER,
  RESPONSE_STYLE_SECTION_NAME,
  RESPONSE_STYLE_SECTION_ORDER,
  parseProgressUpdates,
  parseResponseStyle,
  type ProgressUpdatesState,
  type ResponseStyleState,
} from '../../src/domain/communication/policy.ts'
import { installProgressUpdatesPrompt, installResponseStylePrompt, type SystemPromptLike } from '../../src/app/direct/system-prompt.ts'

function promptRegistry() {
  const sections = new Map<string, Parameters<SystemPromptLike['section']>[0]>()
  const systemPrompt: SystemPromptLike = {
    section(section) {
      assert.equal(sections.has(section.name), false, 'sections register once')
      sections.set(section.name, section)
      return () => { sections.delete(section.name) }
    },
  }
  const text = (name: string): string => {
    const section = sections.get(name)!
    return typeof section.text === 'function' ? section.text({}) : section.text
  }
  return { sections, systemPrompt, text }
}

function communicationRegistry(display: DisplayState = { preset: 'full' }) {
  const registry = promptRegistry()
  const progressUpdatesState: ProgressUpdatesState = { mode: DEFAULT_PROGRESS_UPDATES }
  const responseStyleState: ResponseStyleState = { style: DEFAULT_RESPONSE_STYLE }
  const disposeProgress = installProgressUpdatesPrompt(registry.systemPrompt, display, progressUpdatesState)
  const disposeResponse = installResponseStylePrompt(registry.systemPrompt, responseStyleState)
  return {
    registry,
    display,
    progressUpdatesState,
    responseStyleState,
    gitAttributionState: { mode: 'off' },
    progress: () => registry.text(PROGRESS_UPDATES_SECTION_NAME),
    response: () => registry.text(RESPONSE_STYLE_SECTION_NAME),
    dispose: () => { disposeProgress(); disposeResponse() },
  }
}

test('parsers accept only the exact values and default missing/invalid settings', () => {
  assert.equal(DEFAULT_PROGRESS_UPDATES, 'milestones')
  assert.equal(DEFAULT_RESPONSE_STYLE, 'default')
  for (const mode of ['off', 'milestones', 'frequent']) assert.equal(parseProgressUpdates(mode), mode)
  for (const value of [undefined, null, '', 'checkpoint', 'Milestones', 1, {}]) assert.equal(parseProgressUpdates(value), 'milestones')
  for (const style of ['default', 'concise', 'explanatory']) assert.equal(parseResponseStyle(style), style)
  for (const value of [undefined, null, '', 'none', 'Default', 1, {}]) assert.equal(parseResponseStyle(value), 'default')
})

test('Milestones owns phase boundaries, not newly established findings', () => {
  const t = communicationRegistry()
  assert.match(t.progress(), /# Progress updates: Milestones/)
  assert.match(t.progress(), /coherent phase/)
  assert.match(t.progress(), /substantial phase has completed/)
  assert.match(t.progress(), /direction materially changes/)
  assert.match(t.progress(), /required user input/)
  assert.match(t.progress(), /continue working instead of reporting that partial conclusion/)
  assert.match(t.progress(), /do not add a mandatory preamble before the first tool call/)
  // The old Checkpoint rule — "an important finding is established" —
  // authorized a checkpoint for a partial finding while the same
  // investigation continues. Milestones must never reintroduce it.
  assert.doesNotMatch(t.progress(), /important finding/)
  assert.doesNotMatch(t.progress(), /as findings emerge|findings become established/)
  t.dispose()
})

test('Frequent deliberately allows the active updates Milestones suppresses', () => {
  const t = communicationRegistry()
  t.progressUpdatesState.mode = 'frequent'
  assert.match(t.progress(), /# Progress updates: Frequent/)
  assert.match(t.progress(), /longer or multi-step/)
  assert.match(t.progress(), /meaningful findings/)
  assert.match(t.progress(), /what was established/)
  assert.match(t.progress(), /what you are doing next/)
  assert.match(t.progress(), /Group related actions/)
  // Frequency stays semantic — no mechanical cadence rule.
  assert.doesNotMatch(t.progress(), /every \d|timer|token count/)
  t.dispose()
})

test('Off actively suppresses progress narration instead of an empty section', () => {
  const t = communicationRegistry()
  t.progressUpdatesState.mode = 'off'
  assert.match(t.progress(), /# Progress updates: Off/)
  assert.match(t.progress(), /Do not provide progress narration while working/)
  assert.match(t.progress(), /required user input or a blocker/)
  t.dispose()
})

test('Concise owns visible-answer density, never work-progress cadence', () => {
  const t = communicationRegistry()
  t.responseStyleState.style = 'concise'
  const concise = t.response()
  assert.match(concise, /# Response style: Concise/)
  assert.match(concise, /compact and result-first/)
  assert.match(concise, /Avoid unnecessary preambles, restating the request/)
  assert.match(concise, /information needed for correctness, decisions, blockers, and user action/)
  assert.match(concise, /fuller detail when the user explicitly asks for it/)
  // The axes must not drift together again.
  assert.doesNotMatch(concise, /during work|progress update|milestone|tool call/)
  t.dispose()
})

test('Explanatory owns rationale depth, never work-progress cadence', () => {
  const t = communicationRegistry()
  t.responseStyleState.style = 'explanatory'
  const explanatory = t.response()
  assert.match(explanatory, /# Response style: Explanatory/)
  assert.match(explanatory, /rationale, architecture, non-obvious behavior, and tradeoffs/)
  assert.match(explanatory, /explain why it was not chosen/)
  assert.match(explanatory, /explanations of why, constraints, and decisions/)
  assert.doesNotMatch(explanatory, /during work|progress update|milestone|tool call/)
  t.dispose()
})

test('Default response style adds no answer-style guidance', () => {
  const t = communicationRegistry()
  assert.equal(t.response(), '')
  t.dispose()
})

test('changing one axis never mutates the other axis or the display', () => {
  const t = communicationRegistry()
  t.progressUpdatesState.mode = 'off'
  assert.equal(t.responseStyleState.style, 'default')
  assert.equal(t.display.preset, 'full')
  t.responseStyleState.style = 'explanatory'
  assert.equal(t.progressUpdatesState.mode, 'off')
  assert.equal(t.display.preset, 'full')
  t.display.preset = 'compact'
  assert.equal(t.progressUpdatesState.mode, 'off')
  assert.equal(t.responseStyleState.style, 'explanatory')
  assert.equal(t.registry.sections.size, 2, 'no setting change re-registers sections')
  t.dispose()
})

test('sections register once with pinned names and orders', () => {
  const t = communicationRegistry()
  assert.equal(t.registry.sections.get(PROGRESS_UPDATES_SECTION_NAME)!.name, 'tui:progress-updates')
  assert.equal(t.registry.sections.get(PROGRESS_UPDATES_SECTION_NAME)!.order, 80)
  assert.equal(t.registry.sections.get(RESPONSE_STYLE_SECTION_NAME)!.name, 'tui:response-style')
  assert.equal(t.registry.sections.get(RESPONSE_STYLE_SECTION_NAME)!.order, 81)
  assert.ok(PROGRESS_UPDATES_SECTION_ORDER < RESPONSE_STYLE_SECTION_ORDER)
  assert.ok(RESPONSE_STYLE_SECTION_ORDER < 90, 'both communication sections precede the Focus section')
  // Live settings and Focus changes read the providers, never re-register.
  t.progressUpdatesState.mode = 'frequent'
  t.responseStyleState.style = 'concise'
  t.display.preset = 'focus'
  assert.equal(t.registry.sections.size, 2)
  t.dispose()
  assert.equal(t.registry.sections.size, 0)
})

test('Focus suppresses the effective progress section for every cadence while response style stays active', () => {
  const t = communicationRegistry({ preset: 'focus' })
  for (const mode of ['off', 'milestones', 'frequent'] as const) {
    t.progressUpdatesState.mode = mode
    assert.equal(t.progress(), '', `Focus must empty the progress section for ${mode}`)
    assert.equal(t.progressUpdatesState.mode, mode, 'Focus never mutates the saved cadence')
  }
  t.responseStyleState.style = 'explanatory'
  assert.match(t.response(), /# Response style: Explanatory/)
  t.dispose()
})

test('the reported UX bug: Milestones must not authorize a checkpoint for a partial finding mid-investigation', () => {
  // Plain-language intent (prompt-contract regression, not a model E2E):
  // a local probe that establishes one partial fact followed by MORE
  // investigation of the same question is progress narration inside one
  // still-open coherent phase — Milestones must forbid exactly that, and
  // only Frequent may allow it.
  const t = communicationRegistry()
  t.progressUpdatesState.mode = 'milestones'
  assert.match(t.progress(), /Do not report a partial finding merely because it was just discovered/)
  assert.match(t.progress(), /If you are about to continue investigating the same question, continue working instead of reporting that partial conclusion/)
  t.progressUpdatesState.mode = 'frequent'
  assert.match(t.progress(), /keep the user actively informed with brief updates as meaningful findings become established/)
  t.dispose()
})

test('Focus prompt states the surface fact without owning cadence or style preferences', () => {
  assert.match(FOCUS_MODE_PROMPT, /Progress-only intermediate assistant messages cannot reach the user on this surface, so continue working instead of generating them/)
  assert.match(FOCUS_MODE_PROMPT, /Intermediate assistant text is not visible/)
  assert.match(FOCUS_MODE_PROMPT, /Make the question self-contained/)
  assert.match(FOCUS_MODE_PROMPT, /Continue useful work while independent background work runs/)
  assert.match(FOCUS_MODE_PROMPT, /required background result is unresolved/)
  // Focus owns surface visibility only — no cadence or style vocabulary.
  assert.doesNotMatch(FOCUS_MODE_PROMPT, /milestone|frequent|concise|explanatory|response style/)
})

for (const withRoster of [false, true]) {
  for (const legacy of [false, true]) {
    test(`composition reads persisted settings on first assembly (roster=${withRoster}, legacy=${legacy})`, async () => {
      const registry = promptRegistry()
      let mounted = false
      const presets = {
        resolve: async () => ({ id: 'standard' }),
        mount: async () => { mounted = true },
      }
      const ctx = { get: () => withRoster ? presets : undefined }
      const agentCtx = {
        get: () => {
          assert.equal(mounted, withRoster, 'prompt installs after preset mount')
          return registry.systemPrompt
        },
        on: () => () => {},
      }
      const display: DisplayState = { preset: 'focus' }
      const progressUpdatesState: ProgressUpdatesState = { mode: parseProgressUpdates('frequent') }
      const responseStyleState: ResponseStyleState = { style: parseResponseStyle('explanatory') }
      const agent = {} as never
      let installedAgent: unknown
      if (legacy) {
        const composition = await composeAgent(ctx as never, { current: undefined, assembled: undefined }, undefined, display, undefined, progressUpdatesState, responseStyleState)
        await composition.setup(agentCtx as never)
      } else {
        const composition = await composeAgent(ctx as never, (_ctx, received) => { installedAgent = received }, undefined, display, undefined, progressUpdatesState, responseStyleState)
        await composition.setup(agentCtx as never, agent)
        assert.equal(installedAgent, agent)
      }
      assert.equal(registry.text('tui:progress-updates'), '', 'Focus suppresses the progress section')
      assert.match(registry.text('tui:response-style'), /# Response style: Explanatory/)
      assert.equal(registry.text('tui:focus-mode'), FOCUS_MODE_PROMPT)
      // The plan §12 scenario: full -> frequent/explanatory, into Focus, back out.
      display.preset = 'full'
      assert.match(registry.text('tui:progress-updates'), /# Progress updates: Frequent/)
      for (const mode of ['milestones', 'off'] as const) {
        progressUpdatesState.mode = mode
        assert.equal(display.preset, 'full')
        assert.match(registry.text('tui:progress-updates'), new RegExp(`# Progress updates: ${mode === 'off' ? 'Off' : 'Milestones'}`))
        assert.match(registry.text('tui:response-style'), /# Response style: Explanatory/)
      }
      progressUpdatesState.mode = 'frequent'
      for (const preset of ['compact', 'focus', 'full'] as const) {
        display.preset = preset
        assert.equal(progressUpdatesState.mode, 'frequent', 'display changes never mutate the saved cadence')
        assert.equal(registry.text('tui:focus-mode'), preset === 'focus' ? FOCUS_MODE_PROMPT : '')
        if (preset === 'focus') assert.equal(registry.text('tui:progress-updates'), '')
        else assert.match(registry.text('tui:progress-updates'), /# Progress updates: Frequent/)
      }
      assert.equal(registry.sections.size, 3)
    })
  }
}

test('plain composeAgent callers without communication states install no communication sections', async () => {
  const registry = promptRegistry()
  const ctx = { get: () => undefined }
  const agentCtx = { get: () => registry.systemPrompt, on: () => () => {} }
  const composition = await composeAgent(ctx as never, { current: undefined, assembled: undefined }, undefined, { preset: 'full' })
  await composition.setup(agentCtx as never)
  assert.equal(registry.sections.has('tui:progress-updates'), false)
  assert.equal(registry.sections.has('tui:response-style'), false)
  assert.ok(registry.sections.has('tui:focus-mode'), 'the Focus section still installs')
})

test('production startup resolves both settings before compose and settings switch the same live provider', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-communication-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  life.defer(installVirtualProcessTerminal(vt))
  const session = fakeSession({
    id: 'communication-policy-session',
    header: { id: 'communication-policy-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('communication policy'),
  })
  const harness = makeHarness(home, session)
  const registry = promptRegistry()
  const agents = harness.agents as {
    resume(options: { setup?: (ctx: Context, agent: never) => unknown }): Promise<unknown>
  }
  const resume = agents.resume.bind(agents)
  t.mock.method(agents, 'resume', (options: Parameters<typeof resume>[0]) => resume({
    ...options,
    setup: (ctx, agent) => {
      t.mock.method(ctx, 'get', (name: string) => name === 'systemPrompt' ? registry.systemPrompt : undefined)
      return options.setup?.(ctx, agent)
    },
  }))
  // Both new keys persisted on the plugin's profile-owned Config
  // references; loaded before the first compose. The Settings surface
  // records the path-scoped writes.
  const doc: Record<string, unknown> = {
    progressUpdates: 'off', responseStyle: 'explanatory', customExtension: { keep: true },
  }
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const { Config: TuiConfigSchema } = await import('../../src/index.ts')
  const resolved = TuiConfigSchema({ progressUpdates: 'off', responseStyle: 'explanatory' } as never) as unknown as Record<string, { get(): unknown }>
  const effective = Object.fromEntries(
    Object.entries(resolved).filter(([field]) => field !== 'sessionId' && field !== 'startupStatusOutput')
      .map(([field, ref]) => [field, ref.get()]).filter(([, value]) => value !== undefined),
  )
  ctx.provide('settings', {
    describe: () => [{ ns: 'tui-app', value: effective, user: { ...doc }, revision: 1 }],
    mutate: async (_ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      for (const op of ops) {
        if (op.op === 'set') doc[op.path[0]!] = op.value
        else delete doc[op.path[0]!]
      }
    },
  } as never)
  const fiber = await mountRunner(ctx, home, harness, { sessionId: session.id }, {
    sessionId: session.id,
    progressUpdates: 'off',
    responseStyle: 'explanatory',
  })
  life.defer(() => fiber.dispose())
  assert.match(registry.text('tui:progress-updates'), /# Progress updates: Off/)
  assert.match(registry.text('tui:response-style'), /# Response style: Explanatory/)
  const commands = harness.commands as { handler(name: string): (input: { rawInput: string }) => unknown }
  await commands.handler('settings')({ rawInput: '' })
  await vt.waitForRender()
  await navigateToLegacySettings(vt)
  vt.sendInput('Response style')
  vt.sendInput('\r') // explanatory -> default
  await settle()
  assert.equal(registry.text('tui:response-style'), '')
  assert.match(registry.text('tui:progress-updates'), /# Progress updates: Off/)
  assert.equal(doc.responseStyle, 'default')
  assert.equal(doc.progressUpdates, 'off')
  assert.equal(doc.displayPreset, undefined, 'displayPreset is never pinned by an unrelated write')
  assert.deepEqual(doc.customExtension, { keep: true })
  vt.sendInput('\x1b')
  // Plan §12 behavior: switch to Focus without recompose, then back.
  await commands.handler('display')({ rawInput: 'focus' })
  await settle()
  assert.equal(registry.text('tui:progress-updates'), '', 'Focus empties the effective progress section')
  assert.equal(registry.text('tui:response-style'), '')
  assert.equal(registry.text('tui:focus-mode'), FOCUS_MODE_PROMPT)
  await commands.handler('display')({ rawInput: 'full' })
  await settle()
  assert.match(registry.text('tui:progress-updates'), /# Progress updates: Off/)
  assert.equal(registry.sections.size, 4, 'neither setting recomposes the agent')
  assert.equal(registry.text('tui:git-attribution'), '', 'the default-off attribution section is empty')
})

// ── C2-R1: the two prompt axes are independent live objects ────────────────
//
// The provider half of the contract: the section closures are installed ONCE
// and read the LIVE state object on every assembly, so mutating that object
// changes the effective text without re-registering anything, and neither axis
// can move the other. This case deliberately mutates the state directly — it is
// NOT the Settings path; the joined Settings→writer→provider chain is the
// separate case below.
test('the registered sections read the live axes, and neither axis moves the other', () => {
  const display: DisplayState = { preset: 'full' }
  const t = communicationRegistry(display)
  const progress = t.progressUpdatesState
  const response = t.responseStyleState
  assert.equal(t.registry.sections.size, 2, 'both sections registered once at composition')

  // The widgets the workspace commits mutate the SAME objects (the writers do
  // `runner.progressUpdatesState.mode = parseProgressUpdates(value)`).
  for (const mode of ['off', 'milestones', 'frequent'] as const) {
    progress.mode = parseProgressUpdates(mode)
    assert.equal(t.progressUpdatesState, progress, 'the shared object identity never changes')
    assert.equal(t.registry.sections.size, 2, 'a cadence change never re-registers')
    if (mode === 'off') assert.match(t.progress(), /# Progress updates: Off/)
    if (mode === 'milestones') assert.match(t.progress(), /# Progress updates: Milestones/)
    if (mode === 'frequent') assert.match(t.progress(), /# Progress updates: Frequent/)
    assert.equal(response.style, 'default', 'the other axis is untouched')
  }
  progress.mode = 'frequent'
  for (const style of ['default', 'concise', 'explanatory'] as const) {
    response.style = parseResponseStyle(style)
    assert.equal(t.responseStyleState, response, 'the shared object identity never changes')
    if (style === 'default') assert.equal(t.response(), '')
    if (style === 'concise') assert.match(t.response(), /# Response style: Concise/)
    if (style === 'explanatory') assert.match(t.response(), /# Response style: Explanatory/)
    assert.equal(progress.mode, 'frequent', 'the progress cadence survives every response-style write')
  }
  // Focus: the effective progress section empties while BOTH selected values
  // stay exactly as the user saved them.
  display.preset = 'focus'
  assert.equal(t.progress(), '')
  assert.match(t.response(), /# Response style: Explanatory/)
  assert.equal(progress.mode, 'frequent', 'Focus never rewrites the saved cadence')
  assert.equal(response.style, 'explanatory', 'Focus never rewrites the saved style')
  display.preset = 'full'
  assert.match(t.progress(), /# Progress updates: Frequent/)
  t.dispose()
})

/**
 * The complete source→sink chain the C2-R1 plan requires for the two prompt
 * axes: the REAL Settings workspace commits a Conversation row, the production
 * runner's shared state object changes, and the ALREADY REGISTERED SystemPrompt
 * provider reads the new text. Deliberately one case, not two: separately
 * proving "UI → state" and "state → prompt" would leave the join unproven.
 */
test('a Settings workspace Confirm reaches the registered prompt section through the production runner', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-r1-prompt-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(120, 40)
  life.defer(installVirtualProcessTerminal(vt))
  const session = fakeSession({
    id: 'c2-r1-prompt-session',
    header: { id: 'c2-r1-prompt-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('c2-r1 prompt chain'),
  })
  const harness = makeHarness(home, session)
  const registry = promptRegistry()
  const agents = harness.agents as {
    resume(options: { setup?: (ctx: Context, agent: never) => unknown }): Promise<unknown>
  }
  const resume = agents.resume.bind(agents)
  t.mock.method(agents, 'resume', (options: Parameters<typeof resume>[0]) => resume({
    ...options,
    setup: (ctx, agent) => {
      t.mock.method(ctx, 'get', (name: string) => name === 'systemPrompt' ? registry.systemPrompt : undefined)
      return options.setup?.(ctx, agent)
    },
  }))
  // Both axes start from their documented defaults.
  const doc: Record<string, unknown> = { progressUpdates: 'milestones', responseStyle: 'default' }
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('settings', {
    describe: () => [{ ns: 'tui-app', value: { ...doc }, user: { ...doc }, revision: 1 }],
    mutate: async (_ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      for (const op of ops) {
        if (op.op === 'set') doc[op.path[0]!] = op.value
        else delete doc[op.path[0]!]
      }
    },
  } as never)
  const fiber = await mountRunner(ctx, home, harness, { sessionId: session.id }, {
    sessionId: session.id,
    progressUpdates: 'milestones',
    responseStyle: 'default',
  })
  life.defer(() => fiber.dispose())
  assert.equal(registry.text('tui:response-style'), '', 'the default response style adds no guidance')
  assert.match(registry.text('tui:progress-updates'), /# Progress updates: Milestones/)

  // Drive the NEW workspace: Conversation -> Progress updates -> Response style,
  // confirming BOTH axes so each has its own joined proof (a shared-state
  // regression on one axis must fail on its own, not be masked by the other).
  const commands = harness.commands as { handler(name: string): (input: { rawInput: string }) => unknown }
  await commands.handler('settings')({ rawInput: '' })
  await vt.waitForRender()
  await selectSettingsCategory(vt, 'Conversation')
  vt.sendInput('\r') // L0 -> L1
  await vt.waitForRender()
  for (let step = 0; step < 3; step += 1) {
    vt.sendInput('\x1b[B') // -> Progress updates
    await vt.waitForRender()
  }
  vt.sendInput('\r') // open the choice
  await vt.waitForRender()
  vt.sendInput('\x1b[A') // milestones -> off
  await vt.waitForRender()
  vt.sendInput('\r') // Confirm
  await waitForFrame(
    () => String(doc.progressUpdates),
    value => value === 'off',
    () => vt.waitForRender(),
    'the workspace commit never persisted its progress cadence',
  )
  assert.match(registry.text('tui:progress-updates'), /# Progress updates: Off/,
    'the ALREADY REGISTERED progress provider reads the workspace commit')
  assert.equal(registry.sections.size, 4, 'no section was re-registered by the cadence commit')

  // The SECOND axis, confirmed from the same real workspace. After the settlement
  // the panel is at L2, so Esc returns to the Rows level first and only then does
  // Down move to the next row.
  vt.sendInput('\x1b') // settled Detail -> Rows
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // Progress updates -> Response style
  await vt.waitForRender()
  vt.sendInput('\r') // open the choice
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // default -> concise
  await vt.waitForRender()
  vt.sendInput('\r') // Confirm
  // Wait on the AUTHORITATIVE signal — the committed DOCUMENT value — not a
  // timer. The section text follows the live state synchronously, so the
  // persisted value settling is the event that proves the whole commit finished.
  await waitForFrame(
    () => String(doc.responseStyle),
    value => value === 'concise',
    () => vt.waitForRender(),
    'the workspace commit never persisted its response style',
  )
  assert.match(registry.text('tui:response-style'), /# Response style: Concise/,
    'the ALREADY REGISTERED response-style provider reads the workspace commit')
  assert.equal(doc.responseStyle, 'concise', 'and the same commit persisted')
  assert.match(registry.text('tui:progress-updates'), /# Progress updates: Off/,
    'the progress axis keeps the cadence that was committed first')
  assert.equal(registry.sections.size, 4, 'no section was re-registered by either commit')
})
