/**
 * Embedded Plugin Manager visual suite (S4-D1 D1-A07/A13 + PR2): REAL
 * `TuiAltScreen` frames of the Settings workspace lease over the production
 * controller/panel at the frozen terminal matrix, section order, truthful
 * state chips, the atomic Experimental section, search/filter, mouse
 * selection and CJK truncation.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-workspace-visual.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { darkColors, lightColors } from '../../src/domain/display/theme.ts'
import { PluginManagerController } from '../../src/app/plugin-manager/controller.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { PluginChangeFact, PluginManagerPort, PluginManagerSnapshot } from '../../src/runtime/plugin-manager-port.ts'
import { SELF_BUNDLE } from '../../src/app/plugin-manager/classify.ts'
import type { TuiApp } from '../../src/tui-app.ts'
import { EXPERIMENTAL_NAMES, bundle, openWorkspace, plain, row, type WorkspaceHarness } from '../support/plugin-workspace-harness.ts'

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

test('the embedded page keeps ONE Settings skeleton and a reachable last-row Action Bar', async () => {
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [96, 40], [95, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
    const harness = await open({ columns, rows })
    const view = harness.viewport()
    // ONE shared root chrome: header, metadata, one rule, then the plugin body.
    assert.match(plain([view[0]!]), /Settings · Plugins/u, `${columns}x${rows} header`)
    assert.match(plain([view[1]!]), /Scope: Host plugins & TUI extensions/u, `${columns}x${rows} metadata`)
    assert.match(plain([view[2]!]), /^─+$/u, `${columns}x${rows} one top rule`)
    assert.match(plain([view.at(-1)!]), /Esc back/u, `${columns}x${rows} keeps the plugin Esc on the last row`)
    for (const [index, line] of view.entries()) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} line ${index} exceeds the width: ${JSON.stringify(line)}`)
    }
    const paneHeader = view.map(line => plain([line])).find(line => line.includes('[Plugins]'))
    if (columns >= 76) {
      assert.ok(paneHeader !== undefined, `${columns}x${rows} paints the shared focused pane label`)
      const split = harness.panel.contentLayout()
      if (split.dual) assert.match(paneHeader!, /Details/u, `${columns}x${rows} paints the Details label`)
      else assert.doesNotMatch(paneHeader!, /Details/u, `${columns}x${rows} is the single-column projection`)
    } else {
      assert.equal(paneHeader, undefined, `${columns}x${rows} paints no pane header`)
    }
    if (rows >= 10) {
      assert.ok(view.some(line => plain([line]).includes('> ')), `${columns}x${rows} keeps a real selected body row`)
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

  // Select an ENABLED card first: a filter keeps the selected identity while it
  // survives, and re-anchors on the nearest surviving card otherwise.
  harness.vt.sendInput('\x1b[H') // Home: the first card (self bundle, enabled)
  await harness.settle()
  const selected = harness.panel.selectedCardValue()
  assert.ok(selected !== undefined, 'the list has a selected identity')
  harness.vt.sendInput('\t') // All -> Enabled
  await harness.settle()
  assert.doesNotMatch(harness.view(), /\[disabled\]/, 'the Enabled projection excludes disabled cards')
  assert.match(harness.view(), /\[enabled\]/)
  assert.equal(harness.panel.selectedCardValue(), selected, 'the filter keeps the surviving identity selected')
  assert.equal(harness.snapshotCalls(), 1, 'filters are local projections, never a new inventory read')
  harness.vt.sendInput('\t') // Enabled -> Installed
  harness.vt.sendInput('\t') // Installed -> Available
  await harness.settle()
  assert.match(harness.view(), /\[available\]/, 'the Available projection keeps the catalog entries')
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
    'the model reader warning reaches the plugin notice row')
  assert.match(plain([harness.viewport().at(-1)!]), /Esc back/u, 'the warning never displaces the last-row Action Bar')
})

test('mouse selection is not an action; a second click enters Details and actions dispatch', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  const targetRow = rowOf(harness, '@vendor/foo')
  assert.ok(targetRow >= 0)
  // The click must land on the REAL painted cell of the plugin content (the
  // >=120 projection keeps the Categories rail, so the list starts at x=24).
  const targetColumn = plain([harness.viewport()[targetRow]!]).indexOf('@vendor/foo')
  assert.ok(targetColumn >= 24, `the card is painted inside the plugin content:\n${harness.view()}`)
  press(harness, targetRow, targetColumn)
  release(harness, targetRow, targetColumn)
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
  const enableColumn = plain([harness.viewport()[enableRow]!]).indexOf('Enable…')
  press(harness, enableRow, enableColumn)
  release(harness, enableRow, enableColumn)
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
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  })
  const panel = new PluginManagerWorkspacePanel(controller, {
    requestRender: () => {},
    onCopy: () => {},
    onYieldNavigation: () => {},
  })
  const paint = (): string[] => {
    // The embedded page only paints inside its granted local viewport.
    panel.setViewport({ width: 120, rows: 40, allowDual: true })
    return panel.render(120)
  }
  const settle = async (rounds = 8): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }

  controller.open()
  await settle()
  paint() // the frame must exist before any body-based admission
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

test('risk confirmation keeps the frozen warning readable with Cancel default at 80×10 and 44×20', async () => {
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

// ── D3-0: bounded capability copy stays readable on the real page ──────────

const RALPH = '@deepseek-ai/dsh-experimental-ralph-bundle'
const INSPECTOR = '@deepseek-ai/dsh-experimental-inspector-profile'

test('the B11 surface/risk copy is fully readable (scrolled) at 80×24, 72×24 and 44×20', async () => {
  for (const [columns, rows] of [[80, 24], [72, 24], [44, 20]] as const) {
    const harness = await open({
      columns,
      rows,
      bundles: [
        bundle({ name: SELF_BUNDLE, source: 'file:/tmp/tui' }),
        bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
        bundle({
          name: RALPH,
          official: true,
          availability: 'installation',
          installed: false,
          optional: true,
          removable: false,
          enabled: true,
          source: undefined,
        }),
      ],
      plugins: [],
    })
    harness.vt.sendInput('\x1b[F') // End: the Ralph card is the last row
    await harness.settle()
    harness.vt.sendInput('\r')
    await harness.settle()
    const gather = (): string => plain(harness.viewport())
    for (let page = 0; page < 12 && !gather().includes('TUI surface'); page += 1) {
      harness.vt.sendInput('\x1b[6~') // PgDn
      await harness.settle()
    }
    assert.match(gather(), /TUI surface/u, `${columns}x${rows} exposes the surface fact via the existing Detail scroll`)
    for (let page = 0; page < 12 && !gather().includes('May run multiple rounds'); page += 1) {
      harness.vt.sendInput('\x1b[6~')
      await harness.settle()
    }
    const frame = gather()
    assert.match(frame.replace(/\s+/gu, ' '), /ralph is a Host foreground tool/u)
    assert.match(frame.replace(/\s+/gu, ' '), /May run multiple rounds and incur model cost\. No dedicated Ralph UI or guaranteed Job\./u)
    for (const line of harness.viewport()) {
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} capability copy never exceeds the width: ${JSON.stringify(line)}`)
    }
    // The Risk fact keeps the semantic warning ink (not a text/dim token).
    const riskRow = harness.viewport().findIndex(line => plain([line]).includes('May run multiple rounds'))
    assert.ok(riskRow >= 0)
    const riskCol = plain([harness.viewport()[riskRow]!]).indexOf('May run multiple rounds')
    assert.equal(harness.vt.getCellFgRgb(riskRow, riskCol), hexToRgb(darkColors.warning),
      `${columns}x${rows} paints the hazard in warning ink`)
    started.delete(harness)
    harness.app.dispose()
  }
})

test('keeps its unverified host limit visible in the real Detail', async () => {
  const harness = await open({
    columns: 80,
    rows: 24,
    bundles: [
      bundle({ name: SELF_BUNDLE, source: 'file:/tmp/tui' }),
      bundle({
        name: INSPECTOR,
        official: true,
        availability: 'missing',
        installed: false,
        optional: true,
        removable: false,
        source: undefined,
        installTarget: { spec: `${INSPECTOR}@0.2.1-rc.2`, version: '0.2.1-rc.2' },
      }),
    ],
    plugins: [],
  })
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  for (let page = 0; page < 12 && !plain(harness.viewport()).includes('Host activation is not qualified here.'); page += 1) {
    harness.vt.sendInput('\x1b[6~')
    await harness.settle()
  }
  const frame = plain(harness.viewport()).replace(/\s+/gu, ' ')
  assert.match(frame, /Browser\/Node Inspector has no PiTui inspection page\./u)
  assert.match(frame, /captureFetch may expose unredacted debugging data\. Host activation is not qualified here\./u)
  assert.doesNotMatch(frame, /Host capability not yet qualified for TUI/u)
})
