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
import { DirectModelCatalog } from '../src/runtime/direct/catalog-direct.ts'
import { createDirectTspFixture, waitFor } from './support/direct-tsp-fixture.ts'
import { MODEL_PROFILE_ROW, mountModelProfile } from './support/model-profile-fixture.ts'
import { pickerProps, waitForPicker } from './support/tsp-picker-wire.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

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
