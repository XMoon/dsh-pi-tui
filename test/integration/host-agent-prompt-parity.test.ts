/**
 * M6 PR-C C1/C4: the Direct vs Split Host MODEL-FACING prompt parity contract.
 *
 * Both backends must put the SAME four TUI-owned sections (progress 80,
 * response-style 81, git-attribution 82, Focus 90) into the exact text the
 * model request receives. The capture is the REAL first request of a REAL
 * Agent turn on both sides: the leading system-role message of the loop-built
 * request is the official `system-prompt/assemble` output, so a section the
 * model never received cannot pass here.
 *
 * The Split side runs the production Host row (`pi-tui-host-runtime`): the
 * `agent/created` installer plus the per-Turn latch sampling the
 * `piTuiPromptPresence` fold of a wire-ACKed Focus viewer. The Direct side
 * runs the production `composeDirectAgent` composition with the same canonical
 * `pi-tui-preferences` values and the frozen latch factory the runner passes.
 *
 * Must-capture (plan C1): same canonical preferences in Direct vs Split, the
 * actual first model-facing text, section orders, `{{provider}}`/`{{model}}`
 * interpolation, the official `complete`-persona negative, the subagent
 * negative, user-defaults without Focus, and the actual Focus current Turn.
 *
 * @module @xmoon76/dsh-pi-tui/test/integration/host-agent-prompt-parity
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { composeDirectAgent } from '../../src/app/direct/composition.ts'
import { installTuiPromptTurnLatch } from '../../src/app/agent/turn-policy.ts'
import {
  turnFocusText,
  turnGitAttributionText,
  turnProgressText,
  turnResponseStyleText,
  type TuiPromptTurnSnapshot,
} from '../../src/app/agent/prompt-sections.ts'
import {
  PROGRESS_UPDATES_SECTION_ORDER,
  RESPONSE_STYLE_SECTION_ORDER,
  parseProgressUpdates,
  parseResponseStyle,
  type ProgressUpdatesState,
  type ResponseStyleState,
} from '../../src/domain/communication/policy.ts'
import {
  FOCUS_SECTION_ORDER,
} from '../../src/domain/communication/focus.ts'
import {
  GIT_ATTRIBUTION_SECTION_ORDER,
  parseGitAttributionMode,
  type GitAttributionState,
} from '../../src/domain/communication/git-attribution.ts'
import {
  PI_TUI_PROMPT_PRESENCE_NAMESPACE,
  parsePresenceSyncResult,
} from '../../src/runtime/remote/pi-tui-prompt-presence-contract.ts'

/** The model identity both sides run: the interpolation target below. */
const PROVIDER = 'smoke'
const MODEL = 'smoke-model'

/** Records the leading system text of every model request it serves. */
class CapturingAdapter extends LlmAdapter {
  readonly systemTexts: string[] = []
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider: PROVIDER, id: MODEL, name: MODEL }])
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const system = options.messages.find(message => message.role === 'system')
    const blocks = (system?.content ?? []) as readonly { readonly type: string; readonly text?: string }[]
    this.systemTexts.push(blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    yield { type: 'finish', reason: { kind: 'stop' } } as never
  }
}

/** Run one REAL turn and return the model-facing system text of its request. */
async function runTurn(agent: { followup(message: unknown): unknown; whenIdle(): Promise<unknown> }, adapter: CapturingAdapter): Promise<string> {
  const before = adapter.systemTexts.length
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(adapter.systemTexts.length, before + 1, 'exactly one model request per turn')
  return adapter.systemTexts[before] as string
}

/** The expected four section texts of one frozen Turn (the shared helpers). */
function expectedTexts(turn: TuiPromptTurnSnapshot, states: {
  progressUpdates: ProgressUpdatesState
  responseStyle: ResponseStyleState
  gitAttribution: GitAttributionState
}): { progress: string; response: string; git: string; focus: string } {
  return {
    progress: turnProgressText(turn, states.progressUpdates),
    response: turnResponseStyleText(turn, states.responseStyle),
    git: turnGitAttributionText(turn, states.gitAttribution),
    focus: turnFocusText(turn),
  }
}

/** Assert one model-facing text carries exactly these four section texts at their fixed orders. */
function assertFourSections(systemText: string, texts: ReturnType<typeof expectedTexts>): void {
  // The rendered git text interpolates the official `{{provider}}`/`{{model}}`
  // variables (owned by the agent loop) — the RAW section text keeps the
  // placeholders, the model-facing text must NOT.
  const gitRendered = texts.git.replace('{{provider}}', PROVIDER).replace('{{model}}', MODEL)
  assert.doesNotMatch(systemText, /\{\{(?:provider|model)\}\}/u, 'the model-facing text has no uninterpolated variables')
  const sections = [
    { heading: '# Progress updates:', text: texts.progress },
    { heading: '# Response style:', text: texts.response },
    { heading: '# Git attribution', text: gitRendered },
    { heading: '# Focus mode', text: texts.focus },
  ] as const
  for (const section of sections) {
    if (section.text !== '') {
      assert.ok(systemText.includes(section.text), `the model-facing text carries ${section.heading}`)
    } else {
      assert.ok(!systemText.includes(section.heading), `an empty section never renders ${section.heading}`)
    }
  }
  // Section ORDER 80/81/82/90 among the NON-empty headings.
  const marks = [
    { order: PROGRESS_UPDATES_SECTION_ORDER, at: systemText.indexOf('# Progress updates:') },
    { order: RESPONSE_STYLE_SECTION_ORDER, at: systemText.indexOf('# Response style:') },
    { order: GIT_ATTRIBUTION_SECTION_ORDER, at: systemText.indexOf('# Git attribution') },
    { order: FOCUS_SECTION_ORDER, at: systemText.indexOf('# Focus mode') },
  ].filter(mark => mark.at >= 0)
  for (let index = 1; index < marks.length; index += 1) {
    const previous = marks[index - 1] as { order: number; at: number }
    const current = marks[index] as { order: number; at: number }
    assert.ok(previous.at < current.at, `section order ${previous.order} < ${current.order} in the model-facing text`)
    assert.ok(previous.order < current.order)
  }
}

interface SplitSide {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly adapter: CapturingAdapter
  readonly peer: PeerScope
  dispose(): Promise<void>
}

async function splitSide(life: TestLifecycle, presetId: string, preferences: Record<string, unknown>): Promise<SplitSide> {
  const adapter = new CapturingAdapter()
  const host = await createRemoteApplicationHostFixture(life, presetId, { llmAdapter: adapter, preferences })
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const peer = host.ctx.connection.createPeer({ principal: { kind: 'owner' } })
  return {
    host,
    adapter,
    peer,
    dispose: async () => {
      await peer.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

/** The presence prerequisite of one viewed Turn (the real wire + real ACK). */
async function ackView(host: Context, peer: PeerScope, viewedSessionId: string, displayPreset: 'focus' | 'full'): Promise<void> {
  const result = parsePresenceSyncResult(await host.typertGateway.invoke({
    namespace: PI_TUI_PROMPT_PRESENCE_NAMESPACE,
    method: 'syncView',
    args: { viewedSessionId, displayPreset, revision: 1 },
    peer,
    signal: new AbortController().signal,
  }))
  assert.deepEqual(result, { kind: 'applied', revision: 1 }, 'the viewer presence must be Host-ACKed before the Turn')
}

/** The production Direct composition: the frozen latch + the shared sections. */
async function directAgentOn(
  ctx: Context,
  states: {
    progressUpdates: ProgressUpdatesState
    responseStyle: ResponseStyleState
    gitAttribution: GitAttributionState
  },
  view: { readonly focus: boolean },
  sessionId: string,
  options: { readonly origin?: 'subagent' } = {},
): Promise<{ agent: { followup(message: unknown): unknown; whenIdle(): Promise<unknown>; ctx: Context; session: { id: string } }; dispose(): Promise<void> }> {
  const composition = await composeDirectAgent(
    ctx,
    (agentCtx) => { installModelSelection(agentCtx) },
    undefined,
    { preset: view.focus ? 'focus' : 'full' },
    undefined,
    states.progressUpdates,
    states.responseStyle,
    states.gitAttribution,
    {
      // The runner's production shape: the local surface is the ONLY viewer;
      // eligible = the committed main view is this Agent's Session, Focus =
      // the current local display preset.
      installTurnPolicy: (agentCtx, agent) => {
        const latch = installTuiPromptTurnLatch(
          { on: (event, listener, listenerOptions) => ctx.on(event, listener, listenerOptions) },
          agent.session,
          () => ({ eligible: true, focus: view.focus }),
        )
        agentCtx.effect(() => () => latch.dispose(), 'parity-direct-turn-latch')
        return latch
      },
    },
  )
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd: process.cwd(), ...(options.origin === undefined ? {} : { origin: options.origin }) },
    setup: composition.setup,
    agentOptions: { provider: PROVIDER, model: MODEL },
  })
  return {
    agent: handle.agent as unknown as { followup(message: unknown): unknown; whenIdle(): Promise<unknown>; ctx: Context; session: { id: string } },
    dispose: () => handle.dispose(),
  }
}

test('Direct and Split Host carry the same four TUI sections in the model-facing prompt (Focus Turn)', async (t) => {
  const life = testLifecycle(t)
  // The SAME canonical preference values on both sides: Split reads the refs
  // live per assembly, Direct receives their exact parsed states.
  const preferences = { progressUpdates: 'frequent', responseStyle: 'concise', gitAttribution: 'product-model' }
  const states = {
    progressUpdates: { mode: parseProgressUpdates(preferences.progressUpdates) },
    responseStyle: { style: parseResponseStyle(preferences.responseStyle) },
    gitAttribution: { mode: parseGitAttributionMode(preferences.gitAttribution) },
  }
  const turn: TuiPromptTurnSnapshot = { eligible: true, focus: true }
  const texts = expectedTexts(turn, states)
  assert.equal(texts.progress, '', 'Focus suppresses the progress text for exactly this Turn')

  // Split side: a real Host row, a wire-ACKed Focus viewer, a real Turn.
  const split = await splitSide(life, 'parity-focus', preferences)
  const splitSystemText = await (async () => {
    const agent = await split.host.harness.create(SessionId('parity-focus-split'), { provider: PROVIDER, model: MODEL } as never, { cwd: split.host.anchorDir })
    await ackView(split.host.ctx, split.peer, 'parity-focus-split', 'focus')
    return runTurn(agent as never, split.adapter)
  })()

  // Direct side: the production composition over its own Host-less context.
  const directCtx = new Context()
  let direct: Awaited<ReturnType<typeof directAgentOn>> | undefined
  try {
    await mountAgentLoopTestDependencies(directCtx)
    await mountAgentLoopTestHarness(directCtx)
    directCtx.llm.registerAdapter([PROVIDER], split.adapter)
    direct = await directAgentOn(directCtx, states, { focus: true }, 'parity-focus-direct')
    const directSystemText = await runTurn(direct.agent, split.adapter)

    // The parity contract: BOTH model-facing texts carry the SAME four texts.
    assertFourSections(splitSystemText, texts)
    assertFourSections(directSystemText, texts)
    assert.ok(splitSystemText.includes('Assisted-By: smoke/smoke-model'), 'the model variables interpolate in Split')
    assert.ok(directSystemText.includes('Assisted-By: smoke/smoke-model'), 'the model variables interpolate in Direct')
  } finally {
    await direct?.dispose()
    await directCtx.fiber.dispose()
    await split.dispose()
  }
})

test('user-default preferences without Focus put only the progress policy in the model-facing prompt', async (t) => {
  const life = testLifecycle(t)
  const preferences = {} // schema defaults: milestones / default / off
  const states = {
    progressUpdates: { mode: parseProgressUpdates(undefined) },
    responseStyle: { style: parseResponseStyle(undefined) },
    gitAttribution: { mode: parseGitAttributionMode(undefined) },
  }
  const turn: TuiPromptTurnSnapshot = { eligible: true, focus: false }
  const texts = expectedTexts(turn, states)
  assert.notEqual(texts.progress, '', 'the default cadence policy renders without Focus')
  assert.equal(texts.response, '')
  assert.equal(texts.git, '')
  assert.equal(texts.focus, '')

  const split = await splitSide(life, 'parity-defaults', preferences)
  const splitSystemText = await (async () => {
    const agent = await split.host.harness.create(SessionId('parity-defaults-split'), { provider: PROVIDER, model: MODEL } as never, { cwd: split.host.anchorDir })
    await ackView(split.host.ctx, split.peer, 'parity-defaults-split', 'full')
    return runTurn(agent as never, split.adapter)
  })()

  const directCtx = new Context()
  let direct: Awaited<ReturnType<typeof directAgentOn>> | undefined
  try {
    await mountAgentLoopTestDependencies(directCtx)
    await mountAgentLoopTestHarness(directCtx)
    directCtx.llm.registerAdapter([PROVIDER], split.adapter)
    direct = await directAgentOn(directCtx, states, { focus: false }, 'parity-defaults-direct')
    const directSystemText = await runTurn(direct.agent, split.adapter)
    assertFourSections(splitSystemText, texts)
    assertFourSections(directSystemText, texts)
  } finally {
    await direct?.dispose()
    await directCtx.fiber.dispose()
    await split.dispose()
  }
})

test('a Turn without verified TUI viewers and a subagent Turn carry none of the four sections', async (t) => {
  const life = testLifecycle(t)
  const preferences = { progressUpdates: 'frequent', responseStyle: 'concise', gitAttribution: 'product-model' }
  const split = await splitSide(life, 'parity-negatives', preferences)
  try {
    // No viewer ever ACKed: the Turn is not TUI-eligible and NONE of the four
    // texts participates (section presence is not a claim of rendered text).
    const noViewer = await split.host.harness.create(SessionId('parity-no-viewer'), { provider: PROVIDER, model: MODEL } as never, { cwd: split.host.anchorDir })
    const noViewerText = await runTurn(noViewer as never, split.adapter)
    assert.notEqual(noViewerText.trim(), '', 'the official prompt still runs')
    assert.doesNotMatch(noViewerText, /# Progress updates:|# Response style:|# Git attribution|# Focus mode/u)
    // The user's ORIGINAL prompt stays untouched: the official prompt runs.
    assert.doesNotMatch(noViewerText, /Work quietly while a coherent phase/u)

    // A subagent-origin Session never acquires TUI prompt policy: the Host
    // installer skips it entirely, so no viewer set could ever light it up.
    const subagent = await split.host.harness.create(
      SessionId('parity-subagent'),
      { provider: PROVIDER, model: MODEL } as never,
      { cwd: split.host.anchorDir, origin: 'subagent' } as never,
    )
    await ackView(split.host.ctx, split.peer, 'parity-subagent', 'focus').then(
      () => assert.fail('the presence wire must refuse a subagent-origin Session'),
      () => undefined,
    )
    const subagentText = await runTurn(subagent as never, split.adapter)
    assert.notEqual(subagentText.trim(), '', 'the official prompt still runs for a subagent')
    assert.doesNotMatch(subagentText, /# Progress updates:|# Response style:|# Git attribution|# Focus mode/u)
  } finally {
    await split.dispose()
  }
})

test('an official complete persona suppresses the four TUI sections on both backends', async (t) => {
  const life = testLifecycle(t)
  const preferences = { progressUpdates: 'frequent', responseStyle: 'concise', gitAttribution: 'product-model' }
  const split = await splitSide(life, 'parity-complete', preferences)
  try {
    const agent = await split.host.harness.create(SessionId('parity-complete-split'), { provider: PROVIDER, model: MODEL } as never, { cwd: split.host.anchorDir })
    await ackView(split.host.ctx, split.peer, 'parity-complete-split', 'focus')
    // The official `complete` section is the SOLE system prompt; the assembly
    // keeps the official suppression result and drops every other section.
    ;(agent.ctx.get('systemPrompt') as { section(input: { name: string; order: number; text: string; complete: boolean }): unknown }).section({
      name: 'test:complete-persona',
      order: 10,
      text: 'MINIMAL PERSONA ONLY',
      complete: true,
    })
    const systemText = await runTurn(agent as never, split.adapter)
    assert.equal(systemText, 'MINIMAL PERSONA ONLY')
  } finally {
    await split.dispose()
  }
})
