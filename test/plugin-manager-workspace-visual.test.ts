/**
 * Fullscreen Plugin Manager workspace visual suite (S4-D1 D1-A07/A13):
 * REAL `TuiAltScreen` frames over the production controller/panel at the
 * frozen terminal matrix, section order, truthful state chips, the atomic
 * Experimental section, search/filter, mouse selection and CJK truncation.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-workspace-visual.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { SELF_BUNDLE } from '../src/app/plugin-manager/classify.ts'
import type { TuiApp } from '../src/tui-app.ts'
import { EXPERIMENTAL_NAMES, bundle, openWorkspace, plain, type WorkspaceHarness } from './support/plugin-workspace-harness.ts'

const started = new Set<WorkspaceHarness>()
afterEach(() => {
  for (const harness of [...started]) {
    started.delete(harness)
    try { harness.app.dispose() } catch {}
  }
})

async function open(options: Parameters<typeof openWorkspace>[0] = {}): Promise<WorkspaceHarness> {
  const harness = await openWorkspace(options)
  started.add(harness)
  return harness
}

const rowOf = (harness: WorkspaceHarness, text: string): number =>
  harness.viewport().findIndex(line => plain([line]).includes(text))

const press = (harness: WorkspaceHarness, row: number, col: number): void => {
  harness.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const release = (harness: WorkspaceHarness, row: number, col: number): void => {
  harness.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}

test('the frozen matrix keeps the fullscreen skeleton and a reachable last-row Action Bar', async () => {
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
    const harness = await open({ columns, rows })
    const view = harness.viewport()
    assert.ok(view[0]!.includes('Plugins · All'), `${columns}x${rows} header`)
    assert.match(plain([view.at(-1)!]), /Esc close/, `${columns}x${rows} keeps Esc on the last row`)
    for (const [index, line] of view.entries()) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} line ${index} exceeds the width: ${JSON.stringify(line)}`)
    }
    if (columns >= 96) {
      assert.match(harness.view(), /\[Plugins\]/, `${columns}x${rows} paints the focused left pane label`)
      assert.match(harness.view(), /Details/, `${columns}x${rows} paints the right pane label`)
    } else {
      assert.doesNotMatch(harness.view(), /\[Plugins\]/, `${columns}x${rows} is the one-column projection`)
    }
    if (rows >= 10) {
      assert.ok(view.some(line => plain([line]).startsWith('> ')), `${columns}x${rows} keeps a real selected body row`)
    }
    started.delete(harness)
    harness.app.dispose()
  }
})

test('the four sections keep their order, truthful chips and the Experimental tail', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const view = harness.view()
  const indexOf = (text: string): number => view.indexOf(text)
  assert.ok(indexOf('TUI & Extensions') >= 0)
  assert.ok(indexOf('TUI & Extensions') < indexOf('Official DSH'))
  assert.ok(indexOf('Official DSH') < indexOf('Third-party'))
  assert.ok(indexOf('Third-party') < indexOf('Experimental'))
  assert.match(view, /\[current\]/, 'Current TUI is an explicit state chip')
  assert.match(view, /\[enabled\]/, 'a Host-enabled bundle is enabled, never "active"')
  assert.match(view, /\[disabled\]/, 'a Host-disabled bundle is disabled')
  assert.match(view, /\[available\]/, 'a missing official catalog entry is available')
  assert.doesNotMatch(view, /\[active\]/, 'enabled is never painted as an active/running chip')
  // The atomic Experimental section is the LAST group and carries all 14 Host
  // items; the two external children are last.
  assert.ok(view.includes('Experimental'))
  // The list abbreviates long identities; the ORDER is asserted on the model.
  const experimental = harness.controller.model().sections.at(-1)!.cards.map(card => card.name)
  assert.deepEqual(experimental, [...EXPERIMENTAL_NAMES])
})

test('the Detail is a truthful preview; official missing Install opens inspect/confirm/install', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  harness.vt.sendInput('\x1b[F') // End: last experimental card
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  const detail = harness.view()
  assert.match(detail, /Official DSH catalog entry/)
  assert.match(detail, /Availability\s+Missing/)
  assert.match(detail, /Install…/)
  assert.doesNotMatch(detail, /Status[^\n]*Active/)

  // The explicit Install action starts from the Host installTarget.
  harness.vt.sendInput('\r')
  await harness.settle()
  const install = harness.view()
  assert.match(install, /Official catalog · @deepseek-ai\/dsh-subagent-claude-code/)
  assert.match(install, /offered version 0.2.1-rc.2/, 'the explicit official action already inspected the Host target')
  assert.match(install, /Install/)
  assert.match(plain([harness.viewport().at(-1)!]), /Esc/)
  harness.vt.sendInput('\r') // explicit install confirm
  await harness.settle()
  assert.equal(harness.installCalls.length, 1)
  assert.equal(harness.installCalls[0]!.spec, '@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.2')
  assert.match(harness.view(), /installed version 0.2.1-rc.2/)
})

test('search and the Tab status filter are local projections that keep identity', async () => {
  const harness = await open({ columns: 120, rows: 40 })
  harness.vt.sendInput('/')
  await harness.settle()
  for (const character of 'voice') harness.vt.sendInput(character)
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  const searched = harness.view()
  assert.match(searched, /input-bundle/)
  assert.doesNotMatch(searched, /@vendor\/foo/, 'the query filters the section projection')
  assert.match(searched, /Experimental/)

  harness.vt.sendInput('/')
  await harness.settle()
  harness.vt.sendInput('\x1b') // clear search, stay in the list
  await harness.settle()
  assert.match(harness.view(), /@vendor\/foo/, 'Esc clears the query')

  harness.vt.sendInput('\t') // All -> Enabled
  await harness.settle()
  assert.match(harness.view(), /Plugins · Enabled/)
  assert.doesNotMatch(harness.view(), /\[disabled\]/, 'the Enabled projection excludes disabled cards')
  assert.match(harness.view(), /\[enabled\]/)
  harness.vt.sendInput('\t') // Enabled -> Installed
  harness.vt.sendInput('\t') // Installed -> Available
  await harness.settle()
  assert.match(harness.view(), /Plugins · Available/)
  assert.match(harness.view(), /\[available\]/)
})

test('mouse selection is not an action; a second click enters Details and actions dispatch', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const targetRow = rowOf(harness, '@vendor/foo')
  assert.ok(targetRow >= 0)
  press(harness, targetRow, 3)
  release(harness, targetRow, 3)
  await harness.settle()
  assert.match(harness.view(), /> @vendor\/foo/, 'a single click selects only')
  assert.equal(harness.setBundle.length, 0, 'a single click never toggles')

  harness.vt.sendInput('\r')
  await harness.settle()
  assert.match(harness.view(), /\[Details\]/, 'Enter takes the Details focus')
  assert.match(harness.view(), /Enable…/)
  // A click on the painted action line dispatches the SAME intent as Enter.
  const enableRow = rowOf(harness, 'Enable…')
  assert.ok(enableRow >= 0)
  press(harness, enableRow, 50)
  release(harness, enableRow, 50)
  await harness.settle()
  assert.deepEqual(harness.setBundle, [{ name: '@vendor/foo', enabled: true }])
})

test('a resize between press and release refuses the stale gesture', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const targetRow = rowOf(harness, '@vendor/foo')
  assert.ok(targetRow >= 0)
  press(harness, targetRow, 3)
  harness.vt.resize(100, 30)
  await harness.settle()
  release(harness, targetRow, 3)
  await harness.settle()
  assert.equal(harness.setBundle.length, 0, 'the stale click never activates a card/action')
})

test('CJK identities stay width-safe in the list and complete in Detail/copy', async () => {
  const longName = '@vendor/非常长的中文插件名称用于截断验证'
  const harness = await open({
    columns: 44,
    rows: 20,
    bundles: [
      bundle({ name: SELF_BUNDLE, source: 'file:/tmp/tui' }),
      bundle({ name: longName, title: longName, source: 'https://user:secret@example.com/foo.git' }),
    ],
    plugins: [],
  })
  for (const line of harness.viewport()) {
    assert.ok(visibleWidth(line) <= 44, `line exceeds 44 columns: ${JSON.stringify(line)}`)
  }
  // With only two cards, Down selects the CJK bundle; Enter opens Detail.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  const detail = harness.view()
  assert.ok(detail.replace(/\s+/g, '').includes(longName), `the complete CJK identity is readable:\n${detail}`)
  assert.match(detail.replace(/\s+/g, ''), /https:\/\/\*\*\*@example\.com\/foo\.git/, 'URL credentials are masked')
  assert.doesNotMatch(detail, /secret/)
  harness.vt.sendInput('c')
  await harness.settle()
  assert.equal(harness.copied[0], `${longName}\nsource: https://***@example.com/foo.git`)
})
