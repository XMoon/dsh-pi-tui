/** Native /model -> original handler -> official default owner -> real profile
 * write and a fresh-context reread. Official Host graph comes from the Direct
 * fixture; see model-profile-fixture for the configuration-plane manifest.
 * No expected committed decision or saved selection is injected into the path.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import { DirectModelCatalog } from '../../../src/runtime/direct/catalog-direct.ts'
import { createDirectTspFixture, waitFor } from '../../support/direct-tsp-fixture.ts'
import { MODEL_PROFILE_ROW, mountModelProfile } from '../../support/model-profile-fixture.ts'
import { pickerActionByBase, pickerNode, pickerProps, waitForPicker } from '../../support/tsp-picker-wire.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

test('official profile: native /model persists through ConfigEditor and survives fresh Loader composition', async t => {
  const life = testLifecycle(t)
  const initial = { provider: 'scripted', model: 'previous-model', reasoningEffort: 'high' }
  const fixture = await createDirectTspFixture(life, { modelPicker: true, profileDefault: initial })
  const defaultOwner = fixture.ctx.get('agentDefaultModel') as AgentDefaultModelConfig
  const editor = fixture.ctx.get('configEditor') as ConfigEditor
  const modelEntry = editor.entries().find(entry => entry.options.id === MODEL_PROFILE_ROW)
  assert.ok(modelEntry)
  const originalFiber = modelEntry.fiber
  const original = DirectModelCatalog.prototype.saveDefaultSelection
  const records: Array<{ selection: unknown; outcome: string }> = []
  DirectModelCatalog.prototype.saveDefaultSelection = async function (selection) {
    const outcome = await original.call(this, selection)
    records.push({ selection, outcome: outcome.kind })
    return outcome
  }
  const restore = () => { DirectModelCatalog.prototype.saveDefaultSelection = original }
  t.after(restore)
  try {
    await waitFor('native renderer', () => fixture.pane.output.text().includes('dock.composer'))
    assert.deepEqual(defaultOwner.currentSelection(), initial)
    const patchPath = join(fixture.workRoot, 'profile', 'cordis.patch.yml')
    assert.deepEqual(parse(readFileSync(patchPath, 'utf8')), [], 'no test pre-seeds the saved selection')
    fixture.pane.key('/model\r')
    await waitForPicker('model directory', fixture.pane)
    assert.equal(records.length, 0)
    // K2: Enter on the catalogue opens the read-only Reader (never a write), and
    // the footer owns the ONE write. This model advertises no effort metadata, so
    // its catalogue has no strip and one Tab reaches the Primary Action.
    fixture.pane.key('\r')
    await waitFor('the read-only Reader', () => fixture.pane.output.text().includes('Identity'))
    assert.equal(records.length, 0, 'Enter on the model list is never a write')
    fixture.pane.key('\u001b')
    await waitForPicker('back on the catalogue', fixture.pane)
    fixture.pane.key('\t')
    fixture.pane.key('\r')
    await waitFor('official default save settles', () => records.length === 1)
    const next = { provider: 'scripted', model: 'scripted-model' }
    assert.deepEqual(records, [{ selection: next, outcome: 'committed' }])
    assert.deepEqual(defaultOwner.currentSelection(), next, 'Loader updates the official volatile config')
    assert.equal(modelEntry.fiber, originalFiber, 'volatile update retains the original Loader fiber')
    const rows = parse(readFileSync(patchPath, 'utf8')) as Array<{ id: string; config: unknown }>
    assert.deepEqual(rows.find(r => r.id === MODEL_PROFILE_ROW)?.config, next, 'real profile patch contains the complete selection and omits effort')
    assert.equal(fixture.modelCalls(), 0, '/model must not create a model request')
    assert.equal([...fixture.ctx.agents.list()].length, 0, 'sessionless /model creates no Agent')
    fixture.pane.key('/model\r')
    await waitFor('authoritative directory reread', () => pickerProps(fixture.pane).state === 'ready')
    assert.equal(
      pickerProps(fixture.pane).selected,
      JSON.stringify(['scripted', 'scripted-model']),
      'the reopened picker highlights the persisted default',
    )
    assert.equal(records.length, 1)
    restore()
    await fixture.settle()
    // This fresh Context owns a fresh Loader/default service. Its only input is
    // the real bundle/profile documents saved above, not the original service.
    const fresh = new Context()
    life.defer(() => fresh.fiber.dispose())
    await fresh.plugin(Loader)
    await mountModelProfile(fresh, fixture.workRoot, undefined)
    const reloaded = fresh.get('agentDefaultModel') as AgentDefaultModelConfig
    assert.notEqual(reloaded, defaultOwner)
    assert.deepEqual(reloaded.currentSelection(), next, 'the new composition reads the persisted default')
  } finally { restore(); await fixture.settle() }
})

test('sessionless /model high effort reaches the first real Agent and request header', async t => {
  const life = testLifecycle(t)
  const initial = { provider: 'scripted', model: 'scripted-model', reasoningEffort: 'low' }
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    // The ONLY stand-in this positive proof adds: the scripted exact model
    // advertises low/high, so the official LLM accepts the real explicit effort.
    reasoningFixtureModel: true,
    profileDefault: initial,
  })
  const defaultOwner = fixture.ctx.get('agentDefaultModel') as AgentDefaultModelConfig
  const liveAgents = () => [...fixture.ctx.agents.list()]
  try {
    await waitFor('native renderer', () => fixture.pane.output.text().includes('dock.composer'))
    assert.equal(liveAgents().length, 0, 'the qualification starts sessionless')
    assert.deepEqual(defaultOwner.currentSelection(), initial,
      'the REAL Host default selection already carries the low effort')

    fixture.pane.key('/model\r')
    await waitForPicker('model directory', fixture.pane)
    assert.equal(liveAgents().length, 0, '/model must not create a Session')
    const draftedStrip = (): string | undefined => {
      const strip = pickerProps(fixture.pane).strip as
        | { readonly items?: ReadonlyArray<{ readonly label: string; readonly on?: boolean }> }
        | undefined
      return strip?.items?.find(item => item.on === true)?.label
    }
    assert.equal(draftedStrip(), 'Low', 'the picker drafts the persisted default effort')
    // Tab owns the catalogue's effort strip; ArrowRight moves low -> high; the
    // second Tab moves the keyboard to the explicit Save default action.
    fixture.pane.key('\t')
    await waitFor('effort strip focused', () => pickerProps(fixture.pane).focus === 'strip')
    fixture.pane.key('\u001b[C')
    await waitFor('high drafted', () => draftedStrip() === 'High')
    fixture.pane.key('\t')
    await waitFor('Save default focused', () => pickerActionByBase(fixture.pane, 'apply')?.label === 'Save default [Enter]')
    assert.equal(liveAgents().length, 0, 'editing the draft is still sessionless and writes nothing')
    fixture.pane.key('\r')
    await waitFor('official default save settles', () => defaultOwner.currentSelection()?.reasoningEffort === 'high')
    assert.deepEqual(defaultOwner.currentSelection(),
      { provider: 'scripted', model: 'scripted-model', reasoningEffort: 'high' },
      'the Loader-backed default service holds the complete saved selection')
    await waitFor('picker dismissed after commit', () => pickerNode(fixture.pane) === undefined)
    const patchPath = join(fixture.workRoot, 'profile', 'cordis.patch.yml')
    const rows = parse(readFileSync(patchPath, 'utf8')) as Array<{ id: string; config: unknown }>
    assert.deepEqual(rows.find(row => row.id === MODEL_PROFILE_ROW)?.config,
      { provider: 'scripted', model: 'scripted-model', reasoningEffort: 'high' },
      'the REAL profile patch holds the complete saved selection')
    assert.equal(liveAgents().length, 0, 'the default save stays sessionless')
    assert.equal(fixture.modelCalls(), 0, 'saving the default issues no model request')

    // The first ordinary input creates the Session through the Direct admission.
    fixture.pane.key('first effort proof\r')
    await waitFor('first Session created', () => liveAgents().length === 1)
    const agent = liveAgents()[0]!
    assert.deepEqual(agent.model.current(),
      { provider: 'scripted', model: 'scripted-model', reasoningEffort: 'high' },
      'the official AgentModel resolves the COMPLETE saved default')
    await waitFor('first real request header', () => agent.session.requestHeader() !== undefined)
    const header = agent.session.requestHeader()!
    assert.equal(header.config.provider, 'scripted')
    assert.equal(header.config.model, 'scripted-model')
    assert.equal(header.config.reasoningEffort, 'high',
      'the FIRST real request header carries the explicit saved effort')
    assert.equal(header.adapterDefaults?.reasoningEffort, undefined,
      'the effort was an explicit choice, never an adapter-materialized default')
    await waitFor('scripted adapter received the request', () => fixture.modelCalls() > 0)
  } finally {
    // Teardown only: the fixture's own bounded settle releases the Host/runner;
    // no test fact waits on this window.
    await fixture.settle()
  }
})
