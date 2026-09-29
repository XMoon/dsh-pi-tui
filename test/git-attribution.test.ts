/**
 * Git attribution prompt policy (the prompt-based migration plan §17):
 * parser boundaries, per-mode section text, live mode changes without
 * re-registration, `{{provider}}/{{model}}` resolution through the REAL
 * `installModelSelection()` assembly waterfall, and composed-Agent
 * installation beside the existing TUI sections.
 * @module @xmoon76/dsh-pi-tui/git-attribution.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SystemPromptLike } from '../src/focus.ts'
import {
  DEFAULT_GIT_ATTRIBUTION_MODE,
  GIT_ATTRIBUTION_SECTION_NAME,
  GIT_ATTRIBUTION_SECTION_ORDER,
  installGitAttributionPrompt,
  parseGitAttributionMode,
  type GitAttributionState,
} from '../src/git-attribution.ts'
import { PROGRESS_UPDATES_SECTION_NAME, RESPONSE_STYLE_SECTION_NAME, installProgressUpdatesPrompt, installResponseStylePrompt, type ProgressUpdatesState, type ResponseStyleState } from '../src/communication-policy.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { composeAgent } from '../src/index.ts'

const OFFICIAL_TRAILER = 'Co-Authored-By: @xmoon76/dsh-pi-tui <dsh-pi-tui@xmoon.org>'

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

/** Render a section's text with DSH-style {{variable}} substitution. */
function render(text: string, variables: Record<string, string>): string {
  return text.replaceAll(/\{\{(\w+)\}\}/g, (whole, key: string) => variables[key] ?? whole)
}

test('parser accepts only the exact values and defaults missing/invalid settings', () => {
  assert.equal(DEFAULT_GIT_ATTRIBUTION_MODE, 'off')
  assert.equal(parseGitAttributionMode('off'), 'off')
  assert.equal(parseGitAttributionMode('product'), 'product')
  assert.equal(parseGitAttributionMode('product-model'), 'product-model')
  assert.equal(parseGitAttributionMode(undefined), 'off')
  assert.equal(parseGitAttributionMode('nope'), 'off')
  assert.equal(parseGitAttributionMode(42), 'off')
})

test('off resolves to an empty section', () => {
  const { systemPrompt, text } = promptRegistry()
  const state: GitAttributionState = { mode: 'off' }
  installGitAttributionPrompt(systemPrompt, state)
  assert.equal(text(GIT_ATTRIBUTION_SECTION_NAME), '')
})

test('product contains exactly the official trailer and no model variables', () => {
  const { systemPrompt, text } = promptRegistry()
  const state: GitAttributionState = { mode: 'product' }
  installGitAttributionPrompt(systemPrompt, state)
  const rendered = text(GIT_ATTRIBUTION_SECTION_NAME)
  assert.ok(rendered.includes(OFFICIAL_TRAILER))
  assert.ok(!rendered.includes('{{provider}}'))
  assert.ok(!rendered.includes('{{model}}'))
  assert.ok(!rendered.includes('Assisted-By'))
})

test('product-model renders provider/model through the REAL installModelSelection assembly', async () => {
  // The real DSH waterfall owns the variables; the attribution section only
  // carries the {{provider}}/{{model}} placeholders (plan §2/§8).
  const ctx = new Context()
  const selection: ModelSelectionRef = { current: { provider: 'openai-codex', model: 'gpt-5.6' }, assembled: undefined }
  installModelSelection(ctx, selection)
  const { systemPrompt, text } = promptRegistry()
  const state: GitAttributionState = { mode: 'product-model' }
  installGitAttributionPrompt(systemPrompt, state)

  // Drive the REAL system-prompt/assemble waterfall the way DSH does.
  const assemble = (ctx as unknown as {
    events: { waterfall(name: string, assembly: unknown, context: unknown, next: () => Promise<{ complete: boolean, variables: Record<string, string> }>): Promise<{ complete: boolean, variables: Record<string, string> }> }
  }).events
  const emptyAssembly = { complete: false, variables: {} as Record<string, string> }
  const assembled = await assemble.waterfall('system-prompt/assemble', emptyAssembly, {}, async () => emptyAssembly)
  assert.equal(assembled.variables.provider, 'openai-codex')
  assert.equal(assembled.variables.model, 'gpt-5.6')

  const rendered = render(text(GIT_ATTRIBUTION_SECTION_NAME), assembled.variables)
  assert.ok(rendered.includes(OFFICIAL_TRAILER), `official trailer in:\n${rendered}`)
  assert.ok(rendered.includes('Assisted-By: openai-codex/gpt-5.6'), `route in:\n${rendered}`)
  assert.ok(!rendered.includes('{{provider}}'), `no unresolved provider variable in:\n${rendered}`)
  assert.ok(!rendered.includes('{{model}}'), `no unresolved model variable in:\n${rendered}`)
})

test('live model switch changes the NEXT rendering without re-registering the section', async () => {
  const ctx = new Context()
  const selection: ModelSelectionRef = { current: { provider: 'openai-codex', model: 'gpt-5.6' }, assembled: undefined }
  installModelSelection(ctx, selection)
  const { sections, systemPrompt, text } = promptRegistry()
  const state: GitAttributionState = { mode: 'product-model' }
  installGitAttributionPrompt(systemPrompt, state)
  const registrations = sections.size

  const assemble = (ctx as unknown as {
    events: { waterfall(name: string, assembly: unknown, context: unknown, next: () => Promise<{ complete: boolean, variables: Record<string, string> }>): Promise<{ complete: boolean, variables: Record<string, string> }> }
  }).events
  const runAssembly = async (): Promise<Record<string, string>> => {
    const emptyAssembly = { complete: false, variables: {} as Record<string, string> }
    const assembled = await assemble.waterfall('system-prompt/assemble', emptyAssembly, {}, async () => emptyAssembly)
    return assembled.variables
  }

  const first = await runAssembly()
  assert.ok(render(text(GIT_ATTRIBUTION_SECTION_NAME), first).includes('Assisted-By: openai-codex/gpt-5.6'))

  // Switch the official ModelSelectionRef.current (the only model authority).
  selection.current = { provider: 'deepseek-official', model: 'deepseek-v4' }
  const second = await runAssembly()
  const rendered = render(text(GIT_ATTRIBUTION_SECTION_NAME), second)
  assert.ok(rendered.includes('Assisted-By: deepseek-official/deepseek-v4'), `next assembly uses the new route:\n${rendered}`)
  assert.equal(sections.size, registrations, 'the section registration count stays 1')
})

test('live MODE change re-renders without re-registration', () => {
  const { sections, systemPrompt, text } = promptRegistry()
  const state: GitAttributionState = { mode: 'product' }
  installGitAttributionPrompt(systemPrompt, state)
  assert.ok(text(GIT_ATTRIBUTION_SECTION_NAME).includes(OFFICIAL_TRAILER))
  state.mode = 'off'
  assert.equal(text(GIT_ATTRIBUTION_SECTION_NAME), '')
  state.mode = 'product-model'
  assert.ok(text(GIT_ATTRIBUTION_SECTION_NAME).includes('Assisted-By: {{provider}}/{{model}}'))
  assert.equal(sections.size, 1, 'one registration across all modes')
})

test('a composed TUI Agent receives the attribution section beside the existing policies', async () => {
  const ctx = new Context()
  const display: DisplayState = { preset: 'full' }
  const progressUpdatesState: ProgressUpdatesState = { mode: 'milestones' }
  const responseStyleState: ResponseStyleState = { style: 'default' }
  const gitAttributionState: GitAttributionState = { mode: 'product' }
  const sections = new Map<string, Parameters<SystemPromptLike['section']>[0]>()
  let installSelectionCalls = 0
  const composition = await composeAgent(
    ctx,
    (agentCtx: Context) => {
      installSelectionCalls += 1
      // Stand in for the real systemPrompt service with a recording registry.
      ;(agentCtx as unknown as { get(name: string): unknown }).get = (name: string): unknown => {
        if (name === 'systemPrompt') {
          return {
            section(section: Parameters<SystemPromptLike['section']>[0]) {
              sections.set(section.name, section)
              return () => { sections.delete(section.name) }
            },
          }
        }
        return undefined
      }
    },
    undefined,
    display,
    undefined,
    progressUpdatesState,
    responseStyleState,
    gitAttributionState,
  )
  composition.setup(ctx, {} as never)
  assert.equal(installSelectionCalls, 1)
  assert.ok(sections.has(GIT_ATTRIBUTION_SECTION_NAME), 'attribution section installed')
  assert.ok(sections.has(PROGRESS_UPDATES_SECTION_NAME), 'progress section unchanged')
  assert.ok(sections.has(RESPONSE_STYLE_SECTION_NAME), 'response-style section unchanged')
  const attribution = sections.get(GIT_ATTRIBUTION_SECTION_NAME)!
  assert.equal(attribution.order, GIT_ATTRIBUTION_SECTION_ORDER)
  const textOf = (name: string): string => {
    const section = sections.get(name)!
    return typeof section.text === 'function' ? section.text({}) : section.text
  }
  assert.ok(textOf(GIT_ATTRIBUTION_SECTION_NAME).includes(OFFICIAL_TRAILER))
})

test('omitting the attribution state installs no section', async () => {
  const ctx = new Context()
  const display: DisplayState = { preset: 'full' }
  const sections = new Map<string, Parameters<SystemPromptLike['section']>[0]>()
  const composition = await composeAgent(
    ctx,
    (agentCtx: Context) => {
      ;(agentCtx as unknown as { get(name: string): unknown }).get = (name: string): unknown => {
        if (name === 'systemPrompt') {
          return {
            section(section: Parameters<SystemPromptLike['section']>[0]) {
              sections.set(section.name, section)
              return () => { sections.delete(section.name) }
            },
          }
        }
        return undefined
      }
    },
    undefined,
    display,
  )
  composition.setup(ctx, {} as never)
  assert.equal(sections.has(GIT_ATTRIBUTION_SECTION_NAME), false, 'no attribution section without the state')
})

// Keep the unused policy imports meaningful for the composition assertions.
void installProgressUpdatesPrompt
void installResponseStylePrompt

test('product-model renders through the REAL SystemPrompt + model selection end to end', async () => {
  // The full production chain: the REAL dsh SystemPrompt service owns the
  // section registry AND drives the assembly waterfall itself (so the REAL
  // installModelSelection() listener populates provider/model for the step),
  // and renderPrompt performs the {{variable}} interpolation (plan §9/§17:
  // no unresolved variable may survive in the final model-facing text).
  const { Context: RealContext } = await import('@deepseek-ai/cordis')
  const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const ctx = new RealContext()
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  const systemPrompt = ctx.get('systemPrompt') as unknown as {
    section(section: Parameters<SystemPromptLike['section']>[0]): () => void
    assemble(): Promise<Parameters<typeof renderPrompt>[0]>
  }

  const selection: ModelSelectionRef = { current: { provider: 'openai-codex', model: 'gpt-5.6' }, assembled: undefined }
  installModelSelection(ctx, selection)
  const state: GitAttributionState = { mode: 'product-model' }
  const dispose = installGitAttributionPrompt(systemPrompt as unknown as SystemPromptLike, state)

  const render = async (): Promise<string> => systemPrompt.assemble().then(renderPrompt)

  const first = await render()
  assert.ok(first.includes('Assisted-By: openai-codex/gpt-5.6'), `real service + real selection:\n${first}`)
  assert.ok(first.includes(OFFICIAL_TRAILER), 'the official trailer is in the final prompt')
  assert.ok(!first.includes('{{provider}}') && !first.includes('{{model}}'), 'no unresolved variable survives')

  // Model switch: the SAME registration renders the new route on the next
  // assembly (DSH's own variables; no listener, no re-registration).
  selection.current = { provider: 'deepseek-official', model: 'deepseek-v4' }
  const second = await render()
  assert.ok(second.includes('Assisted-By: deepseek-official/deepseek-v4'), `the next assembly uses the new route:\n${second}`)
  dispose()
})
