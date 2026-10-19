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
import { darkColors, lightColors } from '../src/domain/display/theme.ts'
import { PluginManagerController } from '../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type { PluginChangeFact, PluginManagerPort, PluginManagerSnapshot } from '../src/runtime/plugin-manager-port.ts'
import { SELF_BUNDLE } from '../src/app/plugin-manager/classify.ts'
import type { TuiApp } from '../src/tui-app.ts'
import { EXPERIMENTAL_NAMES, bundle, openWorkspace, plain, row, type WorkspaceHarness } from './support/plugin-workspace-harness.ts'

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
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [96, 40], [95, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
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

const hexToRgb = (hex: string): number =>
  (parseInt(hex.slice(1, 3), 16) << 16) | (parseInt(hex.slice(3, 5), 16) << 8) | parseInt(hex.slice(5, 7), 16)

test('the page paints the live palette tokens in dark, light and custom themes', async () => {
  for (const [theme, palette] of [['dark', darkColors], ['light', lightColors]] as const) {
    const harness = await open({ columns: 120, rows: 30 })
    harness.app.applyTheme(theme)
    await harness.settle()

    const chipRow = rowOf(harness, '[current]')
    const chipCol = plain([harness.viewport()[chipRow]!]).indexOf('[current]')
    assert.equal(harness.vt.getCellFgRgb(chipRow, chipCol), hexToRgb(palette.textMuted),
      `${theme}: a state chip uses the textMuted role`)

    const paneRow = rowOf(harness, '[Plugins]')
    const paneCol = plain([harness.viewport()[paneRow]!]).indexOf('[Plugins]')
    assert.equal(harness.vt.getCellFgRgb(paneRow, paneCol), hexToRgb(palette.primary),
      `${theme}: the focused pane label uses primary`)

    harness.app.applyTheme('dark')
    harness.app.dispose()
    started.delete(harness)
  }

  const harness = await open({ columns: 120, rows: 30 })
  const custom = { ...darkColors, primary: '#445566', textMuted: '#112233' }
  harness.app.applyPalette(custom)
  await harness.settle()
  const chipRow = rowOf(harness, '[current]')
  const chipCol = plain([harness.viewport()[chipRow]!]).indexOf('[current]')
  assert.equal(harness.vt.getCellFgRgb(chipRow, chipCol), hexToRgb('#112233'), 'custom textMuted is live')
  const paneRow = rowOf(harness, '[Plugins]')
  const paneCol = plain([harness.viewport()[paneRow]!]).indexOf('[Plugins]')
  assert.equal(harness.vt.getCellFgRgb(paneRow, paneCol), hexToRgb('#445566'), 'custom primary is live')
  harness.app.applyTheme('dark')
  harness.app.dispose()
  started.delete(harness)
})

test('reader exemption warnings are visible on the page', async () => {
  const harness = await open({ columns: 120, rows: 30, exemptionWarnings: ['unreadable exemption record'] })
  assert.match(harness.view(), /version exemptions: unreadable exemption record/,
    'the model reader warning reaches the notice row')
  assert.match(plain([harness.viewport().at(-1)!]), /Esc close/, 'the warning never displaces the last-row Action Bar')
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

test('a model refresh whose repaint has NOT run refuses a click on the old Enable action', async () => {
  let enabled = false
  const setBundle: Array<{ name: string; enabled: boolean }> = []
  const snapshotOf = (): PluginManagerSnapshot => ({
    bundles: [bundle({ name: '@vendor/foo', enabled, source: 'file:/tmp/foo' })],
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  })
  const change = (): PluginChangeFact => ({ changed: true, application: 'applied', stage: 'enable', target: '@vendor/foo' })
  const port: PluginManagerPort = {
    snapshot: async () => snapshotOf(),
    inspect: async () => ({ status: 'refused', problem: 'unknown', reason: 'not used' }),
    setBundleEnabled: async (name, next) => { setBundle.push({ name, enabled: next }); enabled = next; return change() },
    setPluginEnabled: async () => change(),
    removeBundle: async () => ({ ...change(), stage: 'remove' }),
    startInstall: async () => ({ ...change(), stage: 'install' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }
  const controller = new PluginManagerController(port, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  const panel = new PluginManagerWorkspacePanel(controller, {
    rows: () => 40,
    columns: () => 120,
    requestRender: () => {},
    notice: () => undefined,
    onCopy: () => {},
  })
  const paint = (): string[] => panel.render(120)
  const settle = async (rounds = 8): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }

  controller.open('direct-command')
  await settle()
  panel.handleInput('\r') // Details
  const painted = paint().map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
  const actionRow = painted.findIndex(line => line.includes('Enable…'))
  assert.ok(actionRow >= 0, `the detail paints Enable…:\n${painted.join('\n')}`)

  // The Host invalidation changes the authoritative model; the panel's queued
  // repaint has NOT run yet, so the painted action still reads Enable….
  enabled = true
  controller.refresh()
  for (let index = 0; index < 20 && controller.model().cards[0]?.enabled !== true; index += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  assert.equal(controller.model().cards[0]?.enabled, true, 'the authoritative model changed')

  panel.onCellPress(50, actionRow)
  panel.onCellClick(50, actionRow)
  await settle()
  assert.deepEqual(setBundle, [], 'the stale Enable… click must not become a Disable on the newer model')
  controller.dispose()
  panel.dispose()
})

test('a resize whose repaint has NOT run refuses press+release on the old hit map', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const before = harness.panel.selectedCardValue()
  const targetRow = rowOf(harness, '@vendor/foo')
  assert.ok(targetRow >= 0)

  // The terminal geometry changes, but no render is awaited: the painted map
  // still carries the previous 140x40 targets. Both halves of the gesture are
  // sent into that window.
  harness.vt.resize(100, 30)
  press(harness, targetRow, 3)
  release(harness, targetRow, 3)
  await harness.settle()

  assert.equal(harness.panel.selectedCardValue(), before, 'the stale map must not select a card')
  assert.equal(harness.setBundle.length, 0, 'the stale map must not dispatch an action')
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
  const cjkLine = plain([harness.viewport()[rowOf(harness, '非常长')]!])
  assert.match(cjkLine, /\[(current|enabled|disabled|available)\]/,
    'the status chip stays whole beside the long CJK identity')
  // With only two cards, Down selects the CJK bundle; Enter opens Detail.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  const detail = harness.view()
  assert.ok(detail.replace(/\s+/g, '').includes(longName), `the complete CJK identity is readable:\n${detail}`)
  assert.match(detail.replace(/\s+/g, ''), /https:\/\/\*\*\*@example\.com\/foo\.git/, 'URL credentials are masked')
  assert.doesNotMatch(detail, /secret/)
  // The Detail opens at its top; one Down moves the action cursor and reveals
  // the pinned-by-scroll action block at 44x20.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  const withActions = harness.view()
  assert.match(withActions, /Actions/, 'the action block is reachable at 44x20')
  assert.match(withActions, /(Back|Remove|Enable)/, 'an action is painted at 44x20')
  harness.vt.sendInput('c')
  await harness.settle()
  assert.equal(harness.copied[0], `${longName}\nsource: https://***@example.com/foo.git`)
})

// ── B03 Auto Review safety confirmation (D2-2) ─────────────────────────────

const AUTO_REVIEW_VISUAL = '@deepseek-ai/dsh-experimental-auto-review'

async function selectCard(harness: WorkspaceHarness, value: string): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    if (harness.panel.selectedCardValue() === value) return
    harness.vt.sendInput('\x1b[B')
    await harness.settle()
  }
  assert.fail(`card ${value} was not selectable`)
}

test('B03 risk confirmation keeps the frozen warning readable with Cancel default at 80×10 and 44×20', async () => {
  const warning = 'Disabling Auto Review can change existing Auto sessions to Full access. Auto Review is not a sandbox. Continue?'
  for (const [columns, rows] of [[80, 10], [44, 20]] as const) {
    const harness = await open({
      columns,
      rows,
      bundles: [
        bundle({ name: SELF_BUNDLE, source: 'file:/tmp/tui', rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'e-tui' }] }),
        bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
        bundle({
          name: AUTO_REVIEW_VISUAL,
          official: true,
          availability: 'installation',
          installed: false,
          optional: true,
          removable: false,
          enabled: true,
          source: undefined,
          rows: [{ rowId: 'auto-review', moduleName: AUTO_REVIEW_VISUAL, entryId: 'e-auto', title: 'Auto Review' }],
        }),
        ...EXPERIMENTAL_NAMES.filter(name => name !== AUTO_REVIEW_VISUAL).map(name => bundle({
          name,
          official: true,
          availability: 'missing',
          installed: false,
          optional: true,
          removable: false,
          source: undefined,
          installTarget: { spec: `${name}@0.2.1-rc.2`, version: '0.2.1-rc.2' },
        })),
      ],
      plugins: [
        row({ entryId: 'e-tui', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
        row({ entryId: 'e-auto', moduleName: AUTO_REVIEW_VISUAL, patchId: 'auto-review', enabled: true, fiberPhase: 'active' }),
      ],
    })
    await selectCard(harness, `bundle:${AUTO_REVIEW_VISUAL}`)
    harness.vt.sendInput('\r')
    await harness.settle()
    // A short screen may reveal the selected Detail action first; Enter is the
    // ONE admission path for both the reveal and the explicit action.
    for (let step = 0; step < 3 && harness.panel.currentView() === 'details'; step += 1) {
      harness.vt.sendInput('\r')
      await harness.settle()
    }
    assert.equal(harness.panel.currentView(), 'confirm', `${columns}x${rows} opens the shared confirmation`)
    const frame = harness.view()
    assert.doesNotMatch(frame, /\[Details\]/, 'the confirmation is a page, not a detail overlay')
    // The frozen consequence is fully carried by the painted frame; a long
    // wrap is allowed, a missing/truncated word is not.
    const compacted = frame.replace(/\s+/gu, ' ')
    assert.ok(compacted.includes(warning), `${columns}x${rows} must paint the whole consequence:\n${frame}`)
    // The warning really wears the semantic warning token.
    const warningRow = rowOf(harness, 'Disabling Auto Review')
    assert.ok(warningRow >= 0, `${columns}x${rows} must paint the warning:\n${frame}`)
    const warningCol = plain([harness.viewport()[warningRow]!]).indexOf('Disabling Auto Review')
    assert.equal(harness.vt.getCellFgRgb(warningRow, warningCol), hexToRgb(darkColors.warning),
      `${columns}x${rows} paints the consequence in warning ink`)
    // Cancel is the default and the visible primary is never Enter-confirmed
    // by accident.
    assert.match(plain([harness.viewport().at(-1)!]), /Enter confirm/)
    harness.vt.sendInput('\r') // default Cancel
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'details')
    assert.deepEqual(harness.setBundle, [], `${columns}x${rows} default Cancel writes nothing`)
    for (let step = 0; step < 3 && harness.panel.currentView() === 'details'; step += 1) {
      harness.vt.sendInput('\r') // Disable… again (reveal then dispatch on short screens)
      await harness.settle()
    }
    assert.equal(harness.panel.currentView(), 'confirm')
    const confirmFrame = harness.view()
    if (/PgUp\/PgDn details/u.test(plain([harness.viewport().at(-1)!]))) {
      // A short screen scrolls the explanation; after scrolling to the end the
      // entire consequence remains readable, and the pinned choices stay.
      harness.vt.sendInput('\x1b[6~')
      await harness.settle()
      assert.match(plain([harness.viewport().at(-1)!]), /Esc cancel/)
    }
    assert.match(confirmFrame, /Disable Auto Review/)
    started.delete(harness)
    harness.app.dispose()
  }
})
