/**
 * The embedded Computer Use Settings page (PR-5 / MAC-09 v2, SUX-08).
 *
 * Proves the page's own contract: ONE grouped Overview model (Availability →
 * Permissions → Authorization → Application access → Help), the local
 * Applications workbench (grouped list → explicit Detail → complete-risk
 * confirmation), the same-instance returns, and the exact painted-span
 * admission for keyboard and pointer on every real grant.
 * @module @xmoon76/dsh-pi-tui/computer-use-settings-page.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, type TuiMouseEvent } from '@xmoon76/pi-tui'
import {
  CuaAccessSettingsController,
  type CuaActionCapture,
} from '../../src/app/command/cua-access-settings.ts'
import { cuaActionAdmitted } from '../../src/app/command/cua-access-settings.ts'
import type { CuaAccessPort, CuaApplicationState, CuaPtcConfiguration, CuaSystemStatus } from '../../src/runtime/cua-access-port.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import type { PresetDefaultConfig } from '../../src/runtime/config-port.ts'
import { COMPUTER_USE_PAGE_TITLE, ComputerUseSettingsPage } from '../../src/tui/panels/computer-use-settings-page.ts'

const quietDiag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

const STATUS: CuaSystemStatus = {
  platform: 'darwin',
  accessibility: false,
  screenRecording: false,
  helper: { pid: 7, name: 'DSH Computer Use', path: '/helper/dsh-cua-native' },
  parent: { pid: 1, path: '/sbin/launchd' },
  launchApplication: { name: 'DSH Computer Use.app', path: '/helper/DSH Computer Use.app' },
}
const APPLICATIONS: CuaApplicationState = {
  allowedApps: [{ id: 'app-1', name: 'TextEdit', executablePath: '/Applications/TextEdit.app' }],
  blockedApps: [{ id: 'app-2', name: 'Example' }],
  persistentAvailable: true,
}
const PTC: CuaPtcConfiguration = { persistent: false, writable: true }

function fakeCua(overrides: Partial<CuaAccessPort> = {}): { port: CuaAccessPort; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    port: {
      observation: { readSnapshot: () => 1, subscribe: () => () => {} },
      readSystemStatus: async () => { calls.push('read:system'); return STATUS },
      readApplications: async () => { calls.push('read:applications'); return APPLICATIONS },
      readApplicationIcons: async () => { calls.push('read:icons'); return {} },
      readPtcConfiguration: async () => { calls.push('read:ptc'); return PTC },
      requestPermission: async (permission, locale) => { calls.push(`request:${permission}:${locale}`); return STATUS },
      openSettings: async (permission, locale) => { calls.push(`open:${permission}:${locale}`) },
      enablePersistentPtc: async () => { calls.push('persist') },
      revoke: async (id) => { calls.push(`revoke:${id}`) },
      retryApproval: async (id) => { calls.push(`retry:${id}`) },
      ...overrides,
    },
  }
}

function fakePluginManager(enabled: boolean): PluginManagerPort {
  return {
    snapshot: async () => ({
      bundles: [{
        name: '@deepseek-ai/dsh-cua-bundle',
        official: true,
        availability: 'installation',
        enabled,
        installed: false,
        optional: true,
        removable: false,
        rows: [],
        overrides: [],
        version: '0.2.2-rc.5',
      }],
      plugins: [],
      registries: {} as never,
      exemptions: [],
      exemptionWarnings: [],
    }),
  } as unknown as PluginManagerPort
}

function fakePreset(value = 'default'): {
  config: PresetDefaultConfig
  guarded: string[]
} {
  const guarded: string[] = []
  let current = value
  const generation: object = {}
  return {
    guarded,
    config: {
      available: () => true,
      get: () => current,
      set: async () => {},
      readDecision: () => ({ generation, revision: 2, value: current }),
      setGuarded: async (id) => {
        guarded.push(id)
        current = id
        return { kind: 'accepted' }
      },
    },
  }
}

interface Mounted {
  readonly page: ComputerUseSettingsPage
  readonly controller: CuaAccessSettingsController
  readonly calls: string[]
  readonly preset: ReturnType<typeof fakePreset>
  readonly done: () => boolean
  readonly render: (width?: number) => string[]
  readonly view: (width?: number) => string
}

function mount(options: {
  bundleEnabled?: boolean
  preset?: string
  cua?: Partial<CuaAccessPort>
} = {}): Mounted {
  const fake = fakeCua(options.cua)
  const preset = fakePreset(options.preset ?? 'default')
  const controller = new CuaAccessSettingsController({
    cuaAccess: fake.port,
    pluginManager: fakePluginManager(options.bundleEnabled ?? true),
    presetDefault: preset.config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  let closed = false
  const page = new ComputerUseSettingsPage({
    diag: quietDiag,
    controller,
    requestRender: () => {},
    done: () => { closed = true },
  })
  page.setMaxRows(40)
  const render = (width = 52): string[] => page.render(width).map(stripTerminalSequences)
  return {
    page,
    controller,
    calls: fake.calls,
    preset,
    done: () => closed,
    render,
    view: (width = 52) => render(width).join('\n'),
  }
}

async function settle(mounted: Mounted, needle: string, width = 52): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const frame = mounted.render(width)
    if (frame.join('\n').includes(needle)) return frame
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`the page never painted ${needle}`)
}

/** Move the Overview cursor down until the painted selected action is `label`. */
function selectOverviewAction(mounted: Mounted, label: string): void {
  for (let step = 0; step < 40; step += 1) {
    mounted.render(52)
    const selected = mounted.view(52).split('\n').some(line => /^\s*> .*/u.test(line) && line.includes(label))
    if (selected) return
    mounted.page.handleInput('\x1b[B')
  }
  throw new Error(`the Overview action ${JSON.stringify(label)} was never selectable`)
}

/** Press+release the exact painted span of `label` in the body. */
function clickBody(mounted: Mounted, label: string, width = 52): void {
  const frame = mounted.render(width)
  const rows = mounted.page as unknown as { paint?: { bodyRows: number } }
  const bodyRows = rows.paint?.bodyRows ?? frame.length - 1
  const row = frame.findIndex(line => line.includes(label))
  assert.ok(row >= 0 && row < bodyRows, `${label} must be painted in the body:\n${frame.join('\n')}`)
  const start = frame[row]!.indexOf(label)
  const event = { type: 'press', x: start + 1, y: row, width, height: bodyRows } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
}

function grantWorkbench(mounted: Mounted, options: {
  width?: number
  rows?: number
  barWidth?: number
  allowDual?: boolean
} = {}): void {
  mounted.page.setWebWorkbenchGrant({
    width: options.width ?? 96,
    rows: options.rows ?? 20,
    barWidth: options.barWidth ?? 120,
    allowDual: options.allowDual ?? true,
  })
}

test('a disabled bundle paints the truthful Disabled state and no permission query', async () => {
  const mounted = mount({ bundleEnabled: false })
  const frame = await settle(mounted, 'Bundle: Disabled')
  const text = frame.join('\n')
  assert.match(text, /Disabled/u)
  assert.match(text, /Open Settings → Plugins/u, 'the Plugin recovery is the first explicit action')
  assert.doesNotMatch(text, /Accessibility: Not allowed/u)
  assert.deepEqual(mounted.calls, [], 'no cuaAccess read may run while the bundle is disabled')
  assert.equal(mounted.page.title, COMPUTER_USE_PAGE_TITLE)
  mounted.page.dispose()
})

test('the Overview paints Availability, both permissions and their exact actions in one model', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  const text = mounted.view(52)
  assert.match(text, /Bundle: Enabled · provider ready/u)
  assert.match(text, /Host: macOS/u)
  assert.match(text, /Responsible app: DSH Computer Use\.app/u)
  assert.match(text, /Accessibility: Not allowed/u)
  assert.match(text, /Screen Recording: Not allowed/u)
  assert.match(text, /Request permission/u)
  assert.match(text, /Open settings/u)
  assert.match(text, /New Sessions: default/u)
  assert.match(text, /PTC execution: Non-persistent/u)
  assert.match(text, /Applications: 1 always allowed · 1 refused/u)
  assert.match(text, /Manage applications/u)
  const frame = mounted.render(52)
  assert.match(frame.at(-1)!, /Back \[Esc\]/u, 'the physical bar is the last granted row')
  assert.notEqual(mounted.page.paintedEscapeSpan(), undefined)
  assert.ok(mounted.page.paintedBarSpans().some(span => span.id === 'bar:refresh'))
  mounted.page.dispose()
})

test('the 44x8 real grant keeps bundle/Host/first-missing/Request on the first screen', async () => {
  const mounted = mount({
    cua: { readSystemStatus: async () => ({ ...STATUS, accessibility: true, screenRecording: false }) },
  })
  await settle(mounted, 'Bundle: Enabled')
  mounted.page.setMaxRows(5)
  const frame = mounted.render(44)
  const text = frame.join('\n')
  assert.equal(frame.length, 5, '4 body rows + 1 physical bar')
  assert.match(text, /Bundle: Enabled · provider ready/u)
  assert.match(text, /Host: macOS/u)
  assert.match(text, /Screen Recording: Not allowed/u)
  assert.match(text, /Request permission/u)
  assert.doesNotMatch(text, /Accessibility: Allowed/u, 'the short grant never spends its rows on the granted permission')
  // The exact sink follows the MISSING permission (pointer-only, no keyboard).
  const requestRow = frame.findIndex(line => line.includes('Request permission'))
  const start = frame[requestRow]!.indexOf('Request permission')
  const event = { type: 'press', x: start + 1, y: requestRow, width: 44, height: 4 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('request:')), ['request:screenRecording:zh'])
  mounted.page.dispose()
})

test('the 44x8 scrollport keeps the real responsible application reachable in full', async () => {
  const mounted = mount({
    cua: { readSystemStatus: async () => ({ ...STATUS, accessibility: true, screenRecording: false }) },
  })
  await settle(mounted, 'Bundle: Enabled')
  mounted.page.setMaxRows(5)
  const scrollport: string[][] = [mounted.render(44)]
  for (let step = 0; step < 20; step += 1) {
    mounted.page.handleInput('\x1b[6~')
    scrollport.push(mounted.render(44))
  }
  const whole = scrollport
    .map(frame => frame.slice(0, -1).map(line => line.trimEnd()).join(''))
    .join('')
  assert.match(whole, /Responsible app: DSH Computer Use\.app/u)
  assert.match(whole, /\/helper\/DSH Computer Use\.app/u)
  // RFL-001: a short grant never deletes a fact or an action. Both permission
  // groups and the whole Authorization/Application-access model stay inside the
  // SAME scrollport, reachable by a plain scroll.
  assert.match(whole, /Accessibility: Allowed/u)
  assert.ok((whole.match(/Request again/gu) ?? []).length >= 1, 'the allowed permission keeps its explicit action')
  assert.ok((whole.match(/Request permission/gu) ?? []).length >= 1, 'the missing permission keeps its action')
  assert.match(whole, /New Sessions: default/u)
  assert.match(whole, /Set PTC default/u)
  assert.match(whole, /PTC execution: Non-persistent/u)
  assert.match(whole, /Persistent PTC mode…/u)
  assert.match(whole, /Manage applications/u)
  mounted.page.dispose()
})

test('a 44x8 frame with BOTH permissions missing still reaches both permission actions', async () => {
  const mounted = mount()
  const both = await settle(mounted, 'Bundle: Enabled')
  assert.ok(both.length > 0)
  mounted.page.setMaxRows(5)
  const first = mounted.render(44)
  assert.match(first.join('\n'), /Accessibility: Not allowed/u, 'the first missing permission owns the first screen')
  assert.match(first.join('\n'), /Request permission/u)
  assert.doesNotMatch(first.join('\n'), /Screen Recording: Not allowed/u, 'the second group stays below the first screen')
  const scrollport: string[][] = [first]
  for (let step = 0; step < 20; step += 1) {
    mounted.page.handleInput('\x1b[6~')
    scrollport.push(mounted.render(44))
  }
  const whole = scrollport
    .map(frame => frame.slice(0, -1).map(line => line.trimEnd()).join(''))
    .join('')
  assert.match(whole, /Screen Recording: Not allowed/u, 'the second missing permission is reachable, never deleted')
  assert.equal((whole.match(/Request permission/gu) ?? []).length, 2, 'BOTH missing permissions keep their request action')
  assert.equal((whole.match(/Open settings/gu) ?? []).length, 2, 'both groups keep their Open settings action')
  mounted.page.dispose()
})

test('the reverse missing permission sinks to Accessibility with the same first-screen promise', async () => {
  const mounted = mount({
    cua: { readSystemStatus: async () => ({ ...STATUS, accessibility: false, screenRecording: true }) },
  })
  await settle(mounted, 'Bundle: Enabled')
  mounted.page.setMaxRows(5)
  const frame = mounted.render(44)
  assert.match(frame.join('\n'), /Accessibility: Not allowed/u)
  assert.match(frame.join('\n'), /Request permission/u)
  const requestRow = frame.findIndex(line => line.includes('Request permission'))
  const start = frame[requestRow]!.indexOf('Request permission')
  const event = { type: 'press', x: start + 1, y: requestRow, width: 44, height: 4 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('request:')), ['request:accessibility:zh'])
  mounted.page.dispose()
})

test('keyboard activation dispatches the exact capture and never paints Allowed from the receipt', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Request permission')
  const before = mounted.controller.getSnapshot().epoch
  mounted.page.handleInput('\r')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('request:')), ['request:accessibility:zh'])
  assert.ok(mounted.calls.filter(call => call === 'read:system').length >= 2, 'a fresh official read follows the action')
  const text = mounted.view(52).replace(/\n/gu, '')
  assert.match(text, /Action: Request sent/u)
  assert.match(text, /does not grant permission/u)
  assert.match(text, /Accessibility: Not allowed/u, 'the fresh read remains the real denied observation')
  assert.ok(mounted.controller.getSnapshot().epoch > before, 'the observation identity moved with the read')
  mounted.page.dispose()
})

test('Manage applications opens the SAME instance workbench and returns to the Overview anchor', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  const readsBefore = mounted.calls.filter(call => call === 'read:applications').length
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  assert.equal(mounted.page.embeddedWorkbenchActive(), true, 'the page switches its own projection')
  grantWorkbench(mounted)
  const frame = mounted.render(96).join('\n')
  assert.match(frame, /Applications/u)
  assert.match(frame, /Always allowed/u)
  assert.match(frame, /TextEdit/u)
  assert.match(frame, /Refused/u)
  assert.match(frame, /Example/u)
  assert.equal(mounted.calls.filter(call => call === 'read:applications').length, readsBefore,
    'entering the local workbench performs no extra read')
  // The list Back is a LOCAL return to the same Overview instance.
  mounted.page.handleInput('\x1b')
  assert.equal(mounted.page.embeddedWorkbenchActive(), false)
  mounted.page.setMaxRows(40)
  const overview = mounted.render(52).join('\n')
  assert.match(overview, /Manage applications/u)
  mounted.page.dispose()
})

test('a list row click only selects; the explicit Detail entry then offers the exact decision', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted)
  const list = mounted.render(96).join('\n')
  const row = list.split('\n').findIndex(line => line.includes('TextEdit'))
  const event = { type: 'press', x: 3, y: row, width: 96, height: 20 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [],
    'selecting a row is never a business action')
  // The painted bar `Enter open` is a real pointer route to the Detail.
  const listFrame = mounted.render(96).join('\n')
  assert.match(listFrame, /Enter open/u)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96).join('\n')
  assert.match(detail, /TextEdit/u)
  assert.match(detail, /\/Applications\/TextEdit\.app/u)
  assert.match(detail, /Decision: Always allowed/u)
  assert.match(detail, /Revoke access…/u)
  mounted.page.dispose()
})

test('the revoke confirmation needs the complete risk+target and dispatch is exactly one exact id', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted)
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96).join('\n')
  const actionRow = detail.split('\n').findIndex(line => line.includes('Revoke access…'))
  const start = detail.split('\n')[actionRow]!.indexOf('Revoke access…')
  const event = { type: 'press', x: start + 1, y: actionRow, width: 96, height: 20 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  const confirmation = mounted.render(120).join('\n')
  assert.match(confirmation, /Revoke this application decision\?/u)
  assert.match(confirmation, /may stop immediately/u)
  assert.match(confirmation, /Application: TextEdit · \/Applications\/TextEdit\.app/u)
  assert.match(confirmation, /Decision: Always allowed/u)
  assert.match(confirmation, /Confirm \[Enter\]/u)
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [], 'no write before the explicit confirm')
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), ['revoke:app-1'])
  assert.ok(!mounted.calls.includes('revoke:app-2'))
  mounted.page.dispose()
})

test('a short grant withholds the confirmation verb and cannot dispatch until resized', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted)
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96).join('\n')
  const actionRow = detail.split('\n').findIndex(line => line.includes('Revoke access…'))
  const start = detail.split('\n')[actionRow]!.indexOf('Revoke access…')
  const event = { type: 'press', x: start + 1, y: actionRow, width: 96, height: 20 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  assert.match(mounted.render(120).join('\n'), /Confirm \[Enter\]/u)
  // A 3-row full-width grant cannot hold the complete risk + target.
  grantWorkbench(mounted, { width: 44, rows: 3, barWidth: 44, allowDual: false })
  const short = mounted.render(44)
  assert.equal(short.length, 4)
  assert.doesNotMatch(short.at(-1)!, /Confirm/u, 'no confirm verb is painted without the complete risk')
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [])
  // A sufficient fresh frame restores the explicit decision.
  grantWorkbench(mounted, { width: 120, rows: 20, barWidth: 120, allowDual: false })
  assert.match(mounted.render(120).join('\n'), /Confirm \[Enter\]/u)
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), ['revoke:app-1'])
  mounted.page.dispose()
})

test('a confirmation armed on an older observation is discarded after the same-id rollover', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted)
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96).join('\n')
  const actionRow = detail.split('\n').findIndex(line => line.includes('Revoke access…'))
  const start = detail.split('\n')[actionRow]!.indexOf('Revoke access…')
  const event = { type: 'press', x: start + 1, y: actionRow, width: 96, height: 20 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  assert.match(mounted.render(120).join('\n'), /Confirm \[Enter\]/u)
  // A newer observation exposes the SAME application id.
  await mounted.controller.refresh()
  const after = mounted.render(120).join('\n')
  assert.doesNotMatch(after, /Confirm \[Enter\]/u, 'the old confirmation is retired by the newer observation')
  assert.match(after, /observation changed; the confirmation was discarded/u)
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [])
  mounted.page.dispose()
})

test('an accepted action owns the page: Waiting bar, no Esc target, no second action or leave', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const mounted = mount({
    cua: {
      revoke: async (id) => { mounted.calls.push(`revoke:${id}`); await gate },
    },
  })
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted)
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96).join('\n')
  const actionRow = detail.split('\n').findIndex(line => line.includes('Revoke access…'))
  const start = detail.split('\n')[actionRow]!.indexOf('Revoke access…')
  const event = { type: 'press', x: start + 1, y: actionRow, width: 96, height: 20 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  mounted.render(120)
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(mounted.controller.getSnapshot().busy, true)
  const waiting = mounted.render(120)
  assert.match(waiting.at(-1)!, /Waiting/u)
  assert.equal(mounted.page.paintedEscapeSpan(), undefined, 'Waiting is not a Cancel affordance')
  mounted.page.handleInput('\x1b')
  mounted.page.handleInput('\r')
  assert.equal(mounted.page.leaveEmbeddedWorkbench(), false, 'an accepted action refuses the local mode switch')
  assert.equal(mounted.page.embeddedWorkbenchActive(), true)
  assert.equal(mounted.page.requestParentLeave(undefined as never, () => {}), 'refuse')
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(mounted.controller.getSnapshot().busy, false)
  mounted.page.dispose()
})

test('both allowed permissions keep both groups and their explicit actions in one model', async () => {
  const mounted = mount({
    cua: { readSystemStatus: async () => ({ ...STATUS, accessibility: true, screenRecording: true }) },
  })
  await settle(mounted, 'Bundle: Enabled')
  const text = mounted.view(52).replace(/\n/gu, ' ')
  assert.match(text, /Accessibility: Allowed/u)
  assert.match(text, /Screen Recording: Allowed/u)
  assert.equal((text.match(/Request again/gu) ?? []).length, 2, 'each allowed group keeps its explicit request-again action')
  assert.equal((text.match(/Open settings/gu) ?? []).length, 2, 'each group keeps its explicit Open settings action')
  assert.match(text, /New Sessions: default/u)
  assert.match(text, /Persistent PTC mode…/u)
  mounted.page.dispose()
})

test('a workbench notice row never keeps the hidden action it overwrote', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  // Find the Detail action's line at a generous grant, then shrink the grant so
  // that action occupies the LAST body row (the notice will overwrite it).
  grantWorkbench(mounted, { width: 96, rows: 20, barWidth: 120, allowDual: false })
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const generous = mounted.render(96)
  const actionRow = generous.findIndex(line => line.includes('Revoke access…'))
  assert.ok(actionRow >= 0)
  grantWorkbench(mounted, { width: 96, rows: actionRow + 1, barWidth: 120, allowDual: false })
  mounted.render(96)
  const compact = mounted.render(96)
  assert.equal(compact.findIndex(line => line.includes('Revoke access…')), actionRow,
    'the action is on the grant last body row')
  // Arm it, then let a newer observation retire the confirmation: the page
  // paints a notice over that same row.
  const start = compact[actionRow]!.indexOf('Revoke access…')
  const press = { type: 'press', x: start + 1, y: actionRow, width: 96, height: actionRow + 1 } as TuiMouseEvent
  mounted.page.handleMouse(press)
  mounted.page.handleMouse({ ...press, type: 'click' } as TuiMouseEvent)
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  await mounted.controller.refresh()
  const notice = mounted.render(96)
  assert.match(notice[actionRow] ?? '', /Notice:/u, 'the notice overwrote the action row')
  mounted.page.handleMouse(press)
  mounted.page.handleMouse({ ...press, type: 'click' } as TuiMouseEvent)
  assert.doesNotMatch(mounted.render(96).join('\n'), /Revoke this application decision\?/u,
    'a notice cell must never activate the action it replaced')
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [])
  mounted.page.dispose()
})

test('an unreadable application list keeps the real reason and never offers a fake empty list', async () => {
  const mounted = mount({
    cua: { readApplications: async () => { throw new Error('applications read failed') } },
  })
  const frame = await settle(mounted, 'Applications: applications read failed')
  const text = frame.join('\n').replace(/\s+/gu, ' ')
  assert.match(text, /Applications: applications read failed/u)
  assert.doesNotMatch(text, /none saved yet/u, 'an unreadable list is never painted as an empty one')
  assert.doesNotMatch(text, /Manage applications/u, 'no management verb is offered without a readable list')
  mounted.page.dispose()
})

test('a Host without durable application storage states it and still paints the true counts', async () => {
  const mounted = mount({
    cua: { readApplications: async () => ({ ...APPLICATIONS, persistentAvailable: false }) },
  })
  await settle(mounted, 'Bundle: Enabled')
  const text = mounted.view(52).replace(/\s+/gu, '')
  assert.match(text, /Applications:1alwaysallowed·1refused/u, 'the counts stay the real observation')
  assert.match(text, /durableapplicationstorageisunavailable/u)
  mounted.page.dispose()
})

test('a zero-body grant keeps only the page real safe bar in both projections', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  // Overview H0: the grant is the ONE physical safe bar; no body row exists.
  mounted.page.setMaxRows(1)
  const overview = mounted.render(44)
  assert.equal(overview.length, 1)
  assert.match(overview[0]!, /Back \[Esc\]/u)
  assert.doesNotMatch(overview[0]!, /Refresh|Help|Up\/Down select|Enter activate/u,
    'a zero-body Overview bar advertises no hidden action')
  assert.deepEqual(mounted.page.paintedBarSpans(), [],
    'no business bar span is published without a body row')
  assert.notEqual(mounted.page.paintedEscapeSpan(), undefined, 'only the real escape route is published')
  const readsBefore = mounted.calls.filter(call => call.startsWith('read:')).length
  mounted.page.handleInput('r')
  mounted.page.handleInput('\r')
  mounted.page.handleInput('\t')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(mounted.calls.filter(call => call.startsWith('read:')).length, readsBefore,
    'a zero-body frame runs no read for a key it did not advertise')
  // Applications H0 at the list root and at an armed risk confirmation.
  mounted.page.setMaxRows(20)
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted, { width: 96, rows: 0, barWidth: 120, allowDual: false })
  const list = mounted.render(96)
  assert.equal(list.length, 1)
  assert.match(list[0]!, /Back \[Esc\]/u)
  assert.doesNotMatch(list[0]!, /Refresh|Help|Enter open|Tab detail/u)
  assert.deepEqual(mounted.page.paintedBarSpans(), [], 'no list/detail verb is published at H0')
  assert.notEqual(mounted.page.paintedEscapeSpan(), undefined)
  grantWorkbench(mounted, { width: 96, rows: 20, barWidth: 120, allowDual: false })
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96)
  const actionRow = detail.findIndex(line => line.includes('Revoke access…'))
  assert.ok(actionRow >= 0)
  const start = detail[actionRow]!.indexOf('Revoke access…')
  const press = { type: 'press', x: start + 1, y: actionRow, width: 96, height: 20 } as TuiMouseEvent
  mounted.page.handleMouse(press)
  mounted.page.handleMouse({ ...press, type: 'click' } as TuiMouseEvent)
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  grantWorkbench(mounted, { width: 96, rows: 0, barWidth: 120, allowDual: false })
  const risk = mounted.render(96)
  assert.equal(risk.length, 1)
  assert.match(risk[0]!, /Cancel \[Esc\]/u)
  assert.doesNotMatch(risk[0]!, /Confirm/u, 'a zero-row risk frame never advertises Confirm')
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [],
    'a zero-row risk frame cannot be confirmed')
  mounted.page.dispose()
})

const MANY: CuaApplicationState = {
  allowedApps: Array.from({ length: 10 }, (_, index) => ({
    id: `app-${String(index + 1)}`,
    name: `App ${String(index + 1)}`,
    executablePath: `/Applications/App ${String(index + 1)}.app`,
  })),
  blockedApps: [],
  persistentAvailable: true,
}

const MANY_LONG: CuaApplicationState = {
  allowedApps: Array.from({ length: 10 }, (_, index) => ({
    id: `app-${String(index + 1)}`,
    name: `App ${String(index + 1)}`,
    executablePath: index === 0
      ? `/Applications/${'Very Long Application Name/'.repeat(6)}App 1.app`
      : `/Applications/App ${String(index + 1)}.app`,
  })),
  blockedApps: [],
  persistentAvailable: true,
}

const LONG_PATH: CuaApplicationState = {
  allowedApps: [{
    id: 'app-long',
    name: 'A',
    executablePath: `/Applications/${'Very Long Application Name/'.repeat(6)}A.app`,
  }],
  blockedApps: [{ id: 'app-b', name: 'B' }],
  persistentAvailable: true,
}

async function enterApplications(
  mounted: Mounted,
  options: { width?: number, rows?: number, allowDual?: boolean } = {},
): Promise<string[]> {
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted, {
    width: options.width ?? 96,
    rows: options.rows ?? 20,
    barWidth: options.width ?? 96,
    allowDual: options.allowDual ?? false,
  })
  return mounted.render(options.width ?? 96)
}

function clickCell(mounted: Mounted, width: number, height: number, x: number, y: number): void {
  const event = { type: 'press', x, y, width, height } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
}

function wheelCell(mounted: Mounted, width: number, height: number, x: number, y: number, delta: number): void {
  mounted.page.handleMouse({ type: 'wheel', x, y, width, height, wheelDelta: delta } as TuiMouseEvent)
}

test('a single-region Applications list publishes no hidden Detail verb or row target', async () => {
  const mounted = mount({ cua: { readApplications: async () => LONG_PATH } })
  await enterApplications(mounted, { width: 44, rows: 18 })
  const list = mounted.render(44).join('\n')
  assert.match(list, /Always allowed/u)
  assert.doesNotMatch(list, /Revoke access…/u, 'the hidden Detail verb is not painted in the list')
  // The hidden Detail build puts `Revoke access…` on row 7; that cell is an
  // ordinary blank list cell in a single-region grant and must stay inert.
  clickCell(mounted, 44, 18, 3, 7)
  assert.doesNotMatch(mounted.render(44).join('\n'), /Revoke this application decision\?/u)
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [])
  // Symmetric: from the Detail, a hidden List row cell must not select or switch.
  mounted.page.handleInput('\r') // Enter opens the selected row (A is selected at mount)
  mounted.render(44)
  assert.match(mounted.render(44).join('\n'), /Decision: Always allowed/u)
  clickCell(mounted, 44, 18, 3, 1)
  const detail = mounted.render(44).join('\n')
  assert.match(detail, /Decision: Always allowed/u, 'a hidden List row cell never leaves the Detail')
  assert.doesNotMatch(detail, /Enter open/u)
  mounted.page.dispose()
})

test('the dual Applications wheel consumes the actual signed line delta per painted region', async () => {
  const mounted = mount({ cua: { readApplications: async () => MANY_LONG } })
  await enterApplications(mounted, { width: 120, rows: 6, allowDual: true })
  const columns = (frame: string[]): { list: string[], detail: string[] } => ({
    list: frame.slice(0, -1).map(line => line.slice(0, 34)),
    detail: frame.slice(0, -1).map(line => line.slice(36)),
  })
  const before = columns(mounted.render(120))
  // The two-cell gutter between the painted panes owns no scroll.
  wheelCell(mounted, 120, 6, 34, 1, 2)
  assert.deepEqual(mounted.render(120), mounted.render(120), 'the gutter frame is stable')
  const gutter = columns(mounted.render(120))
  assert.deepEqual(gutter, before, 'the gutter wheel changes nothing')
  // Over the List, the ACTUAL delta 2 advances the viewport by exactly 2 lines
  // (never a hidden ±3 multiplier).
  wheelCell(mounted, 120, 6, 5, 1, 2)
  const listMoved = columns(mounted.render(120))
  assert.deepEqual(listMoved.list.slice(0, listMoved.list.length - 2), before.list.slice(2))
  assert.deepEqual(listMoved.detail, before.detail, 'the wheel over the List leaves the Detail alone')
  // Over the Detail, the same actual delta scrolls only the Detail.
  const detailBefore = columns(mounted.render(120))
  wheelCell(mounted, 120, 6, 60, 1, 2)
  const detailMoved = columns(mounted.render(120))
  assert.deepEqual(detailMoved.detail.slice(0, detailMoved.detail.length - 2), detailBefore.detail.slice(2))
  assert.deepEqual(detailMoved.list, detailBefore.list, 'the wheel over the Detail leaves the List alone')
  mounted.page.dispose()
})

test('the first Overview action click after a dual Applications return is active', async () => {
  const mounted = mount()
  await enterApplications(mounted, { width: 120, rows: 40, allowDual: true })
  assert.equal(mounted.page.leaveEmbeddedWorkbench(), true)
  mounted.render(52)
  assert.match(mounted.view(52), /Accessibility: Not allowed/u)
  clickBody(mounted, 'Request permission')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('request:')), ['request:accessibility:zh'],
    'the retained dual grant must not make the Overview verb passive')
  mounted.page.dispose()
})

test('Applications Help is real content and Esc closes it before leaving the mode', async () => {
  const mounted = mount()
  await enterApplications(mounted, { width: 96, rows: 20 })
  mounted.page.handleInput('?')
  const help = mounted.render(96).join('\n')
  assert.match(help, /Help and recovery/u, 'the workbench paints the real Help')
  assert.match(help, /Back \[Esc\]/u)
  mounted.page.handleInput('\x1b')
  const back = mounted.render(96).join('\n')
  assert.match(back, /Always allowed/u, 'Esc closes Help and stays in Applications')
  assert.doesNotMatch(back, /Help and recovery/u)
  mounted.page.handleInput('\x1b')
  assert.match(mounted.render(52).join('\n'), /Bundle: Enabled/u, 'the next Esc leaves to the same Overview')
  mounted.page.dispose()
})

test('the list bar advertises Open only while the selected row is really painted', async () => {
  const mounted = mount({ cua: { readApplications: async () => MANY } })
  await enterApplications(mounted, { width: 96, rows: 6 })
  assert.match(mounted.render(96).at(-1)!, /Enter open/u)
  mounted.page.handleInput('\x1b[6~') // PageDown: the list scrolls, the selection stays
  const paged = mounted.render(96)
  assert.doesNotMatch(paged.at(-1)!, /Enter open/u, 'an offscreen selection advertises no Open')
  mounted.page.handleInput('\x1b[B') // moving the selection reveals it again
  assert.match(mounted.render(96).at(-1)!, /Enter open/u)
  mounted.page.dispose()
})

test('the Applications Detail states unreadable storage and keeps the receipt visible', async () => {
  const mounted = mount({
    cua: {
      readApplications: async () => ({ ...APPLICATIONS, persistentAvailable: false }),
    },
  })
  await enterApplications(mounted, { width: 96, rows: 20 })
  mounted.page.handleInput('\r')
  mounted.render(96)
  assert.match(mounted.render(96).join('\n'), /durable application storage is unavailable/u)
  assert.match(mounted.render(96).join('\n'), /Revoke access…/u)
  mounted.page.handleInput('\r') // Enter activates the painted verb
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 10))
  const settled = mounted.render(96).join('\n')
  assert.match(settled, /Action: .*revoked/u, 'the settled outcome is painted in the active projection')
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), ['revoke:app-1'])
  mounted.page.dispose()
})

test('a removed target keeps its own attribution visible at a short grant', async () => {
  let applications: CuaApplicationState = {
    allowedApps: [{ id: 'app-1', name: 'TextEdit', executablePath: '/Applications/TextEdit.app' }],
    blockedApps: [{ id: 'app-2', name: 'Example' }],
    persistentAvailable: true,
  }
  const mounted = mount({
    cua: {
      readApplications: async () => applications,
      revoke: async (id) => {
        applications = { ...applications, allowedApps: applications.allowedApps.filter(application => application.id !== id) }
      },
    },
  })
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted, { width: 96, rows: 20, barWidth: 120, allowDual: false })
  mounted.render(96)
  mounted.page.handleInput('\r') // open the selected TextEdit Detail
  mounted.render(96)
  mounted.page.handleInput('\r') // the visible Revoke verb
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  mounted.page.handleInput('y')
  await settle(mounted, 'Application access revoked')
  // A short grant still reveals the abnormal result at the TOP of the active
  // projection, and the deterministic fallback is not labelled as the target.
  grantWorkbench(mounted, { width: 96, rows: 4, barWidth: 120, allowDual: false })
  const short = mounted.render(96).join('\n')
  assert.match(short, /Action: Application access revoked/u)
  assert.match(short, /Target: Always allowed application: TextEdit \(\/Applications\/TextEdit\.app\)/u)
  assert.doesNotMatch(short, /Target: Refused application: Example/u)
  mounted.page.dispose()
})

test('an unconfirmed revoke keeps its receipt visible at a short grant and only Refresh rearms', async () => {
  const basis = 1
  let applications: CuaApplicationState = {
    allowedApps: [{ id: 'app-1', name: 'TextEdit', executablePath: '/Applications/TextEdit.app' }],
    blockedApps: [{ id: 'app-2', name: 'Example' }],
    persistentAvailable: true,
  }
  const mounted = mount({
    cua: {
      observation: { readSnapshot: () => basis, subscribe: () => () => {} },
      readApplications: async () => applications,
      revoke: async () => { throw new Error('lost receipt after dispatch') },
    },
  })
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted, { width: 96, rows: 20, barWidth: 120, allowDual: false })
  mounted.render(96)
  mounted.page.handleInput('\r')
  mounted.render(96)
  mounted.page.handleInput('\r')
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  mounted.page.handleInput('y')
  await settle(mounted, 'outcome could not be confirmed')
  assert.equal(mounted.controller.getSnapshot().action?.requiresRecovery, true)
  assert.equal(cuaActionAdmitted(
    mounted.controller.getSnapshot(),
    { epoch: mounted.controller.getSnapshot().epoch, kind: 'revoke', applicationId: 'app-2', applicationGroup: 'refused' },
  ).ok, false, 'an unconfirmed effect retires the write actions')
  // The roster changes after the lost dispatch; the original target identity
  // must survive (captured from the exact decision, not re-resolved).
  applications = { allowedApps: [], blockedApps: [], persistentAvailable: true }
  await mounted.controller.refresh()
  grantWorkbench(mounted, { width: 96, rows: 6, barWidth: 120, allowDual: false })
  const retained = mounted.render(96).join('\n')
  assert.match(retained, /Action outcome unconfirmed/u)
  assert.match(retained, /Target: Always allowed application: TextEdit \(\/Applications\/TextEdit\.app\)/u)
  // An explicit Refresh settles the application authority and rearms the action.
  mounted.page.handleInput('r')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(mounted.controller.getSnapshot().action?.requiresRecovery, false)
  mounted.page.dispose()
})

test('the Detail keyboard scroll reaches a verb pushed below a long path grant', async () => {
  const mounted = mount({ cua: { readApplications: async () => LONG_PATH } })
  await enterApplications(mounted, { width: 44, rows: 8 })
  mounted.page.handleInput('\r') // open the selected row
  const first = mounted.render(44).join('\n')
  assert.doesNotMatch(first, /Revoke access…/u, 'the long path pushes the verb below the grant')
  for (let step = 0; step < 20 && !mounted.render(44).join('\n').includes('Revoke access…'); step += 1) {
    mounted.page.handleInput('\x1b[6~')
  }
  assert.match(mounted.render(44).join('\n'), /Revoke access…/u, 'PageDown reaches the complete verb')
  mounted.page.handleInput('\r')
  assert.match(mounted.render(44).join('\n'), /Revoke this application decision\?/u)
  mounted.page.dispose()
})

test('a Waiting Overview refuses the page own Back until the action settles', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const mounted = mount({ cua: { requestPermission: async () => { await held; return STATUS } } })
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Request permission')
  mounted.page.handleInput('\r')
  assert.equal(mounted.controller.getSnapshot().busy, true)
  mounted.page.render(52)
  assert.match(mounted.render(52).at(-1)!, /Waiting for the action to settle/u)
  mounted.page.handleInput('\x1b')
  assert.notEqual((mounted.page as unknown as { disposed?: boolean }).disposed, true,
    'the page own Back never retires an accepted action')
  assert.equal(mounted.controller.getSnapshot().busy, true)
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  mounted.page.dispose()
})

test('after a settled receipt, moving the List selection keeps it painted and Open advertised', async () => {
  let applications: CuaApplicationState = {
    allowedApps: Array.from({ length: 6 }, (_, index) => ({
      id: `app-${String(index + 1)}`,
      name: `App ${String(index + 1)}`,
      executablePath: `/Applications/App ${String(index + 1)}.app`,
    })),
    blockedApps: [],
    persistentAvailable: true,
  }
  const mounted = mount({
    cua: {
      readApplications: async () => applications,
      revoke: async (id) => {
        applications = { ...applications, allowedApps: applications.allowedApps.filter(application => application.id !== id) }
      },
    },
  })
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted, { width: 96, rows: 20, barWidth: 96, allowDual: false })
  mounted.render(96)
  mounted.page.handleInput('\r') // open App 1 Detail
  mounted.render(96)
  mounted.page.handleInput('\r') // arm and confirm the visible revoke
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  mounted.page.handleInput('y')
  await settle(mounted, 'Application access revoked')
  // The receipt is first in the short List; the fallback selection and one Down
  // must both remain really painted (the reveal hint uses the same layout).
  grantWorkbench(mounted, { width: 96, rows: 5, barWidth: 96, allowDual: false })
  mounted.render(96)
  mounted.page.handleInput('\x1b') // Detail -> List
  mounted.render(96)
  assert.match(mounted.render(96).join('\n'), /Target: Always allowed application: App 1/u)
  mounted.page.handleInput('\x1b[B')
  const frame = mounted.render(96)
  assert.ok(frame.slice(0, -1).some(line => /^> /u.test(line)), 'the moved selection is painted')
  assert.match(frame.at(-1)!, /Enter open/u, 'the moved selection is still Open-able')
  mounted.page.dispose()
})

test('a clean parent leave is a query: the page never calls the Root continuation itself', () => {
  const mounted = mount()
  let leaves = 0
  assert.equal(mounted.page.requestParentLeave(
    { categoryId: 'tools', rowId: 'computer-use', focus: 'rows' },
    () => { leaves += 1 },
  ), 'allow')
  assert.equal(leaves, 0, 'the Root owns the ONE leave transaction')
  mounted.page.dispose()
})

test('an accepted revoke owns the page synchronously before its first await', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const mounted = mount({ cua: { revoke: async () => { await held } } })
  await enterApplications(mounted, { width: 96, rows: 20 })
  mounted.page.handleInput('\r')
  mounted.render(96)
  mounted.page.handleInput('\r')
  assert.match(mounted.render(96).join('\n'), /Revoke this application decision\?/u)
  mounted.page.handleInput('y')
  // No await: the same input turn already reads the accepted ownership.
  assert.equal(mounted.controller.getSnapshot().busy, true, 'Waiting is published synchronously')
  assert.equal(mounted.page.requestParentLeave(
    { categoryId: 'tools', rowId: 'computer-use', focus: 'rows' },
    () => {},
  ), 'refuse')
  // The page's own Esc must not retire the page behind the Waiting bar either.
  mounted.page.handleInput('\x1b')
  mounted.page.render(96)
  assert.equal(mounted.page.embeddedWorkbenchActive(), true)
  assert.equal(mounted.controller.getSnapshot().busy, true)
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  mounted.page.dispose()
})

test('a non-Darwin Host paints Unsupported and the Plugins recovery route', async () => {
  const mounted = mount({
    cua: {
      readSystemStatus: async () => ({
        platform: 'win32',
        sessionLocked: false,
        captureAvailable: true,
        elevated: false,
        helper: { pid: 9, name: 'helper', path: '/helper' },
      }),
    },
  })
  const frame = await settle(mounted, 'Unsupported platform')
  const text = frame.join('\n')
  assert.match(text, /Unsupported platform \(win32\)/u)
  assert.match(text, /Open Settings → Plugins/u)
  assert.doesNotMatch(text, /Accessibility: /u, 'no macOS permission row is fabricated for Windows')
  mounted.page.dispose()
})

test('the preset action is admitted only with the guarded decision and dispatches the guarded writer', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Set PTC default')
  mounted.page.handleInput('\r')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.preset.guarded, ['ptc'])
  const text = mounted.view(52).replace(/\n/gu, ' ')
  assert.match(text, /New Sessions: ptc \(PTC is the saved default\)/u)
  assert.match(text, /confirmed by the current Host/u)
  mounted.page.dispose()
})

test('two decisions with the same public identity offer no dangerous confirmation', async () => {
  const duplicated: CuaApplicationState = {
    allowedApps: [
      { id: 'app-a', name: 'Same', executablePath: '/Applications/Same.app' },
      { id: 'app-b', name: 'Same', executablePath: '/Applications/Same.app' },
    ],
    blockedApps: [],
    persistentAvailable: true,
  }
  const mounted = mount({ cua: { readApplications: async () => duplicated } })
  await settle(mounted, 'Bundle: Enabled')
  selectOverviewAction(mounted, 'Manage applications')
  mounted.page.handleInput('\r')
  grantWorkbench(mounted)
  mounted.render(96)
  mounted.page.activateBarSpan('bar:open')
  const detail = mounted.render(96).join('\n')
  assert.match(detail, /shares its visible identity/u)
  assert.doesNotMatch(detail, /Revoke access…/u, 'the confirmation would have to guess its target')
  mounted.page.dispose()
})

test('help scrolls inside the same Overview and Esc closes help before the page', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  mounted.page.setMaxRows(6)
  mounted.page.handleInput('?')
  let frame = mounted.render(44)
  for (let step = 0; step < 60 && !frame.join('\n').includes('Help and recovery'); step += 1) {
    mounted.page.handleInput('\x1b[6~')
    frame = mounted.render(44)
  }
  assert.match(frame.join('\n'), /Help and recovery/u)
  mounted.page.handleInput('\x1b')
  assert.equal(mounted.done(), false, 'Esc closes help first')
  assert.doesNotMatch(mounted.render(44).join('\n'), /Help and recovery/u)
  mounted.page.handleInput('\x1b')
  assert.equal(mounted.done(), true)
  mounted.page.dispose()
})

test('a stale painted frame admits no keyboard or pointer action until it repaints', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  const frame = mounted.render(52)
  const row = frame.findIndex(line => line.includes('Request permission'))
  assert.ok(row >= 0)
  const start = frame[row]!.indexOf('Request permission') + 1
  // Publish a new observation WITHOUT painting a new frame.
  const refresh = mounted.controller.refresh()
  mounted.page.handleInput('\r')
  const event = { type: 'press', x: start, y: row, width: 52, height: 40 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  await refresh
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('request:')), [],
    'a key/click against the previous frame never dispatches')
  mounted.render(52)
  selectOverviewAction(mounted, 'Request permission')
  mounted.page.handleInput('\r')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('request:')), ['request:accessibility:zh'],
    'a fresh painted frame restores the action')
  mounted.page.dispose()
})

test('the action capture is the exact observation identity the page painted', async () => {
  const mounted = mount()
  await settle(mounted, 'Bundle: Enabled')
  const snapshot = mounted.controller.getSnapshot()
  const capture: CuaActionCapture = { epoch: snapshot.epoch, kind: 'request', permission: 'accessibility' }
  assert.equal(cuaActionAdmitted(snapshot, capture).ok, true)
  assert.equal(cuaActionAdmitted(snapshot, { ...capture, epoch: snapshot.epoch + 1 }).ok, false)
  mounted.page.dispose()
})
