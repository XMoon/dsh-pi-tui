/**
 * FR1 L5 (Direct): the real mounted PiTui `/model` path end to end — the actual
 * TuiApp + Direct backend + real base Host, a real Root Session created by a
 * real model turn, the picker's Team row driven by real keyboard input, the
 * official `agentTeams.setEnabled` write, and the authoritative projection
 * painted back on the SAME surface. Also covers the independent OFF
 * confirmation seat for a Session that already recorded a model request.
 *
 * @module @xmoon76/dsh-pi-tui/model-team-l5.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { startS4D3Application } from '../support/application-fixture.ts'
import { skippedInstallationReason } from '../support/optional-bundle-fixture.ts'

const skip = skippedInstallationReason([])

class L5Adapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ready' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ready' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function teamOf(host: { ctx: { get(name: string): unknown } }): {
  isEnabled(agent: Agent): boolean
} {
  return host.ctx.get('agentTeams') as { isEnabled(agent: Agent): boolean }
}

test('FR1 L5 Direct: the mounted /model Team row writes the real Host and reads back', { skip }, async t => {
  const adapter = new L5Adapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    presets: true,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  // A real turn creates the Root Session AND records modelSelection.lastUsed.
  const agent = await app.submitFirstPrompt('start the FR1 L5 scenario')
  await app.waitFor(() => teamOf(app.host).isEnabled(agent) === false, 'Team starts OFF')
  await app.settle()

  // Open /model through the real command path.
  for (const character of '/model') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Agent Team'), 'the /model Team row mounts')
  assert.match(app.view(), /Agent Team\s+On\s+\[Off\]/u, `the picker reads the official OFF state:\n${app.view()}`)

  // Tab to the Team row, Enter enables it: the official Host write runs and the
  // SAME frame repaints the authoritative ON state.
  app.vt.sendInput('\t')
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => teamOf(app.host).isEnabled(agent) === true, 'the official Host Team service turns ON')
  await app.waitFor(() => /Agent Team\s+\[On\]\s+Off/u.test(app.view()), 'the picker reads the ON projection back')
  const modeEvents = app.host.events(agent).filter(event => (event as { type?: string }).type === 'team/mode')
  assert.equal(modeEvents.length, 1, 'exactly one durable team/mode for the enable')

  // Disabling over a recorded model request must open the independent seat.
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Disable Agent Team'), 'the OFF confirmation seat mounts')
  assert.equal(teamOf(app.host).isEnabled(agent), true, 'opening the seat writes nothing')
  app.vt.sendInput('\x1b') // Esc cancels with zero writes
  await app.settle()
  assert.equal(teamOf(app.host).isEnabled(agent), true, 'Esc cancels the OFF with no Host write')
  await app.waitFor(() => !app.view().includes('Disable Agent Team'), 'the seat closes')

  // Re-open the seat and confirm it through the real keyboard path.
  app.vt.sendInput('\r')
  await app.waitFor(() => app.view().includes('Disable Agent Team'), 'the OFF confirmation seat mounts again')
  app.vt.sendInput('\x1b[C') // Right -> focus the Disable action
  await app.settle()
  app.vt.sendInput('\r') // Confirm
  await app.waitFor(() => teamOf(app.host).isEnabled(agent) === false, 'the confirmed OFF reaches the Host')
  await app.waitFor(() => /Agent Team\s+On\s+\[Off\]/u.test(app.view()), 'the picker reads the OFF projection back')
  const allEvents = app.host.events(agent).filter(event => (event as { type?: string }).type === 'team/mode')
  assert.equal(allEvents.length, 2, 'exactly one durable team/mode per confirmed write (enable + disable)')
})
