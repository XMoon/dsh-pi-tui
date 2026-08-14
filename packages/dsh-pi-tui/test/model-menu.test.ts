/**
 * Headless tests for the /model in-place submenu flow: loading → model
 * list → effort list, with immediate apply and Esc walking back one level.
 * No second overlay is mounted at any point (the ghost-overlay trap the
 * nested-openSettings pattern fell into).
 * @module @xmoon76/dsh-pi-tui/model-menu.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { ModelSubmenu } from '../src/model-menu.ts'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { VirtualTerminal } from './virtual-terminal.ts'

interface FakeLlm {
  models: readonly { id: string }[]
  efforts: readonly { id: string; name: string }[] | undefined
}

function fakeLlm(shape: FakeLlm): {
  listModels: () => Promise<readonly { id: string }[]>
  resolveModelInfo: () => Promise<{ reasoning?: { efforts?: readonly { id: string; name: string }[] } }>
} {
  return {
    listModels: async () => shape.models,
    resolveModelInfo: async () => shape.efforts === undefined ? {} : { reasoning: { efforts: shape.efforts } },
  }
}

/** Drive the flow: open the settings list, Enter into the provider submenu. */
async function openModelFlow(
  llm: ReturnType<typeof fakeLlm>,
  applied: ModelSelection[],
): Promise<{ vt: VirtualTerminal; app: TuiApp }> {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const current = { provider: 'p', model: 'm0' } as ModelSelection
  app.openSettings(
    [{
      id: 'p',
      label: 'provider',
      currentValue: current.model,
      submenu: (value, done) => new ModelSubmenu('p', current.model, undefined, {
        listModels: llm.listModels,
        resolveModelInfo: llm.resolveModelInfo,
        apply: (next) => applied.push(next),
        requestRender: () => app.requestRender(),
        done,
      }),
    }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  vt.sendInput('\r') // Enter: open the provider's model submenu
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('model submenu loads the model list in place and applies on selection', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({ models: [{ id: 'm1' }, { id: 'm2' }], efforts: undefined }),
    applied,
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  let view = await viewport(vt)
  assert.ok(view.includes('m1') && view.includes('m2'), `model list missing:\n${view}`)
  vt.sendInput('\r') // select the first model (no effort route)
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  assert.deepEqual(applied, [{ provider: 'p', model: 'm1' }], 'model selection must apply')
  view = await viewport(vt)
  assert.ok(view.includes('m1'), `back on the model list:\n${view}`)
})

test('model with reasoning efforts offers the effort list and applies effort', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({
      models: [{ id: 'm1' }, { id: 'm2' }],
      efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }],
    }),
    applied,
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  let view = await viewport(vt)
  assert.ok(view.includes('m1'), `model list missing:\n${view}`)
  vt.sendInput('\r') // m1 has efforts → effort list opens
  await new Promise(resolve => setTimeout(resolve, 30))
  view = await viewport(vt)
  assert.ok(view.includes('High') && view.includes('Low'), `effort list missing:\n${view}`)
  vt.sendInput('\x1b[B') // down from 'Default' to 'High'
  vt.sendInput('\r') // select High
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  assert.deepEqual(
    applied,
    [{ provider: 'p', model: 'm1', reasoningEffort: 'high' }],
    'effort selection must apply with the model',
  )
})

test('esc walks back one level from the effort list, never a ghost panel', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({
      models: [{ id: 'm1' }],
      efforts: [{ id: 'high', name: 'High' }],
    }),
    applied,
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  vt.sendInput('\r') // m1 → effort list
  await new Promise(resolve => setTimeout(resolve, 30))
  let view = await viewport(vt)
  assert.ok(view.includes('High'), `effort list missing:\n${view}`)
  vt.sendInput('\x1b') // esc: back to the model list
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('m1') && !view.includes('High'), `expected model list after esc:\n${view}`)
  vt.sendInput('\x1b') // esc: back to the provider list
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('provider'), `expected provider list after second esc:\n${view}`)
  vt.sendInput('\x1b') // esc: closes the settings overlay entirely
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(!view.includes('provider'), `overlay still mounted after third esc:\n${view}`)
  assert.deepEqual(applied, [], 'nothing applied while just navigating')
})
