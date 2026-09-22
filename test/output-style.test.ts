import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { disposeContext, fakeSession, installVirtualProcessTerminal, makeHarness, mountRunner, sessionEvents, settle } from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { composeAgent } from '../src/index.ts'
import { FOCUS_MODE_PROMPT, type SystemPromptLike } from '../src/focus.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { DEFAULT_OUTPUT_STYLE, installOutputStylePrompt, parseOutputStyle, type OutputStyleState } from '../src/output-style.ts'

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

test('OutputStyle accepts only the four modes and defaults missing/invalid settings to checkpoint', () => {
  assert.equal(DEFAULT_OUTPUT_STYLE, 'checkpoint')
  for (const style of ['none', 'checkpoint', 'concise', 'explanatory']) assert.equal(parseOutputStyle(style), style)
  for (const value of [undefined, null, '', 'default', 'Checkpoint', 1, {}]) assert.equal(parseOutputStyle(value), 'checkpoint')
})

test('all four dynamic sections have bounded communication responsibilities', () => {
  const registry = promptRegistry()
  const state: OutputStyleState = { style: 'checkpoint' }
  const dispose = installOutputStylePrompt(registry.systemPrompt, state)
  assert.equal(registry.sections.get('tui:output-style')!.order, 80)
  const checkpoint = registry.text('tui:output-style')
  assert.match(checkpoint, /important finding.*phase completes.*direction materially changes.*blocker/)
  assert.match(checkpoint, /do not add a mandatory sentence before the first tool call/)
  state.style = 'concise'
  assert.match(registry.text('tui:output-style'), /without a preamble or restating the request/)
  assert.match(registry.text('tui:output-style'), /Never hide errors, warnings/)
  assert.match(registry.text('tui:output-style'), /full detail when the user explicitly requests it/)
  state.style = 'explanatory'
  assert.match(registry.text('tui:output-style'), /rationale and tradeoffs/)
  assert.match(registry.text('tui:output-style'), /Do not turn this into per-tool narration/)
  state.style = 'none'
  assert.equal(registry.text('tui:output-style'), '')
  assert.equal(registry.sections.size, 1)
  dispose()
  assert.equal(registry.sections.size, 0)
})

for (const withRoster of [false, true]) {
  for (const legacy of [false, true]) {
    test(`composition reads persisted style on first assembly (roster=${withRoster}, legacy=${legacy})`, async () => {
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
      const state: OutputStyleState = { style: parseOutputStyle('explanatory') }
      const agent = {} as never
      let installedAgent: unknown
      if (legacy) {
        const composition = await composeAgent(ctx as never, { current: undefined, assembled: undefined }, undefined, display, undefined, state)
        await composition.setup(agentCtx as never)
      } else {
        const composition = await composeAgent(ctx as never, (_ctx, received) => { installedAgent = received }, undefined, display, undefined, state)
        await composition.setup(agentCtx as never, agent)
        assert.equal(installedAgent, agent)
      }
      assert.match(registry.text('tui:output-style'), /# Output style: Explanatory/)
      assert.equal(registry.text('tui:focus-mode'), FOCUS_MODE_PROMPT)
      assert.ok(registry.sections.get('tui:output-style')!.order < registry.sections.get('tui:focus-mode')!.order)
      for (const style of ['none', 'checkpoint'] as const) {
        state.style = style
        assert.equal(display.preset, 'focus')
        assert.equal(registry.text('tui:focus-mode'), FOCUS_MODE_PROMPT)
        if (style === 'none') assert.equal(registry.text('tui:output-style'), '')
        else assert.match(registry.text('tui:output-style'), /# Output style: Checkpoint/)
      }
      for (const preset of ['compact', 'full', 'focus'] as const) {
        display.preset = preset
        assert.equal(state.style, 'checkpoint')
        assert.equal(registry.text('tui:focus-mode'), preset === 'focus' ? FOCUS_MODE_PROMPT : '')
      }
      assert.equal(registry.sections.size, 2)
    })
  }
}

test('production startup restores OutputStyle before compose and settings switch the same live provider', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-output-style-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  life.defer(installVirtualProcessTerminal(vt))
  const session = fakeSession({
    id: 'output-style-session',
    header: { id: 'output-style-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('output style'),
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
  const doc: Record<string, unknown> = {
    theme: 'dark', iconStyle: 'emoji', footer: 'full', fullscreen: 'off',
    busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'input',
    displayPreset: 'focus', focusMode: 'off', wheelScrollLines: '1',
    outputStyle: 'explanatory', customExtension: { keep: true },
  }
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('settings', {
    register: () => ({ get: () => ({ ...doc }), replace: (next: Record<string, unknown>) => { Object.assign(doc, next) } }),
    describe: () => [{ ns: 'dsh-pi-tui', user: {} }],
  } as never)
  const fiber = await mountRunner(ctx, home, harness, { sessionId: session.id }, { sessionId: session.id })
  life.defer(() => fiber.dispose())
  assert.match(registry.text('tui:output-style'), /# Output style: Explanatory/)
  assert.equal(registry.text('tui:focus-mode'), FOCUS_MODE_PROMPT)
  const commands = harness.commands as { handler(name: string): (input: { rawInput: string }) => unknown }
  await commands.handler('settings')({ rawInput: '' })
  await vt.waitForRender()
  vt.sendInput('Output style')
  vt.sendInput('\r') // explanatory -> none
  await settle()
  assert.equal(registry.text('tui:output-style'), '')
  assert.equal(registry.text('tui:focus-mode'), FOCUS_MODE_PROMPT)
  assert.equal(doc.outputStyle, 'none')
  assert.equal(doc.displayPreset, 'focus')
  assert.deepEqual(doc.customExtension, { keep: true })
  vt.sendInput('\x1b')
  await commands.handler('display')({ rawInput: 'compact' })
  await settle()
  assert.equal(registry.text('tui:focus-mode'), '')
  assert.equal(registry.text('tui:output-style'), '')
  assert.equal(doc.outputStyle, 'none')
  assert.equal(doc.displayPreset, 'compact')
  assert.equal(registry.sections.size, 2, 'neither setting recomposes the agent')
})

test('Focus owns hidden context and lifecycle, not generic output organization', () => {
  assert.match(FOCUS_MODE_PROMPT, /Intermediate assistant text is not visible/)
  assert.match(FOCUS_MODE_PROMPT, /Summarize hidden work rather than replaying/)
  assert.match(FOCUS_MODE_PROMPT, /Make the question self-contained/)
  assert.match(FOCUS_MODE_PROMPT, /Continue useful work while independent background work runs/)
  assert.match(FOCUS_MODE_PROMPT, /required background result is unresolved/)
  assert.doesNotMatch(FOCUS_MODE_PROMPT, /result-first|meaningful milestones|implementation insights|don't narrate progress/)
})
