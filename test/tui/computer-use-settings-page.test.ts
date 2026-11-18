/**
 * The embedded Computer Use Settings page (PR-5 / MAC-09 v2).
 *
 * Proves the page's own transient presentation contract: the official
 * conditions are painted from the controller snapshot, a disabled bundle shows
 * a truthful disabled state and no permission query, Request/Open are explicit
 * action rows (never an optimistic Allowed paint), revoke/retry use a reviewable
 * confirmation, the last row is the delegated action bar, and pointer/keyboard
 * activation reach the SAME controller intent.
 * @module @xmoon76/dsh-pi-tui/computer-use-settings-page.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { TuiMouseEvent } from '@xmoon76/pi-tui'
import { CuaAccessSettingsController } from '../../src/app/command/cua-access-settings.ts'
import type { CuaAccessPort, CuaApplicationState, CuaPtcConfiguration, CuaSystemStatus } from '../../src/runtime/cua-access-port.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import type { PresetDefaultConfig } from '../../src/runtime/config-port.ts'
import { COMPUTER_USE_PAGE_TITLE, ComputerUseSettingsPage } from '../../src/tui/panels/computer-use-settings-page.ts'

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
        version: '0.2.2-rc.3',
      }],
      plugins: [],
      registries: {} as never,
      exemptions: [],
      exemptionWarnings: [],
    }),
  } as unknown as PluginManagerPort
}

function fakePreset(value = 'ptc'): PresetDefaultConfig {
  return { available: () => true, get: () => value, set: async () => {} }
}

function mount(options: { bundleEnabled?: boolean; preset?: string; cua?: Partial<CuaAccessPort> } = {}): {
  page: ComputerUseSettingsPage
  calls: string[]
  done: () => boolean
  render: (width?: number) => string[]
} {
  const fake = fakeCua(options.cua)
  const controller = new CuaAccessSettingsController({
    cuaAccess: fake.port,
    pluginManager: fakePluginManager(options.bundleEnabled ?? true),
    presetDefault: fakePreset(options.preset ?? 'ptc'),
    locale: () => 'zh',
  })
  let closed = false
  const page = new ComputerUseSettingsPage({
    controller,
    requestRender: () => {},
    done: () => { closed = true },
  })
  page.setMaxRows(60)
  return {
    page,
    calls: fake.calls,
    done: () => closed,
    render: (width = 96) => page.render(width),
  }
}

async function settle(mountResult: ReturnType<typeof mount>, needle: string, width = 96): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const frame = mountResult.render(width)
    if (frame.join('\n').includes(needle)) return frame
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`the page never painted ${needle}`)
}

test('a disabled bundle paints Disabled and never queries the CUA access port', async () => {
  const mounted = mount({ bundleEnabled: false })
  const frame = await settle(mounted, 'Disabled')
  const text = frame.join('\n')
  assert.match(text, /Disabled/u)
  assert.doesNotMatch(text, /Accessibility: Not allowed/u)
  assert.deepEqual(mounted.calls, [], 'no cuaAccess read may run while the bundle is disabled')
  assert.equal(mounted.page.title, COMPUTER_USE_PAGE_TITLE)
  assert.equal(frame.length, 60, 'the granted row budget includes the one physical action bar')
  mounted.page.dispose()
})

test('the enabled denied Host paints the two independent permissions and their actions', async () => {
  const mounted = mount()
  const frame = await settle(mounted, 'Accessibility: Not allowed')
  const text = frame.join('\n')
  assert.match(text, /Screen Recording: Not allowed/u)
  assert.match(text, /Responsible app: DSH Computer Use\.app/u)
  assert.match(text, /\[Request permission\]/u)
  assert.match(text, /\[Open Accessibility settings\]/u)
  assert.match(text, /\[Open Screen Recording settings\]/u)
  assert.match(text, /\[r Refresh\]/u)
  assert.equal(frame.at(-1)?.includes('[Esc Back]'), true, 'the last row is the delegated action bar')
  assert.notEqual(mounted.page.paintedEscapeSpan(), undefined)
  assert.ok(mounted.page.paintedBarSpans().some(span => span.id === 'bar:refresh'))
  mounted.page.dispose()
})

test('keyboard activation reaches the controller; Request stays an action, never an Allowed paint', async () => {
  const mounted = mount()
  const frame = await settle(mounted, 'Accessibility: Not allowed')
  // The first enabled action in this fixture is Request Accessibility (the
  // preset is already PTC, persistent PTC is disabled, and the two permissions
  // precede the application actions).
  const requestRow = frame.findIndex(line => line.includes('[Request permission]'))
  assert.ok(requestRow >= 0)
  let cursor = 0
  // Move the page cursor to the Request Accessibility action by repeated Down;
  // the page paints the selected action with a `>` marker.
  for (; cursor < 20; cursor += 1) {
    mounted.page.handleInput('\x1b[B')
    const painted = mounted.render().join('\n')
    if (/>.*\[Request permission\]/u.test(painted)) break
  }
  assert.ok(cursor < 20, 'the Request Accessibility action is reachable by keyboard')
  mounted.page.handleInput('\r')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(mounted.calls.includes('request:accessibility:zh'), 'Enter dispatched the official request')
  // The fresh read after the action remains a real denied observation; the
  // action itself is not painted as Allowed.
  mounted.page.setMaxRows(80)
  const after = mounted.render().join('\n')
  assert.match(after, /Action: Request sent/u)
  assert.match(after, /does not grant permission/u)
  mounted.page.dispose()
})

test('revoke uses a reviewable confirmation before the exact opaque application id is sent', async () => {
  const mounted = mount()
  mounted.page.setMaxRows(80)
  const frame = await settle(mounted, 'TextEdit')
  const revokeRow = frame.findIndex(line => line.includes('[Revoke access…]'))
  assert.ok(revokeRow >= 0)
  const targetRow = revokeRow - 1 // the application identity row
  const click = (x: number, y: number): void => {
    const event = { type: 'press', x, y, width: 96, height: 79 } as TuiMouseEvent
    mounted.page.handleMouse(event)
    mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  }
  const labelCol = frame[revokeRow]!.indexOf('[')
  click(labelCol, revokeRow)
  const confirmation = mounted.render().join('\n')
  assert.match(confirmation, /Revoke this application decision\?/u)
  assert.match(confirmation, /may stop immediately/u)
  assert.match(confirmation, /\[y Revoke\]/u, 'the confirmation decision is painted in the bar')
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [], 'no write before the confirmation')
  mounted.page.handleInput('y')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(mounted.calls.includes('revoke:app-1'), 'the exact painted application id reaches the port')
  assert.ok(!mounted.calls.includes('revoke:app-2'))
  assert.ok(targetRow >= 0)
  mounted.page.dispose()
})

test('Escape closes the page, the bar refresh delegates, and a short grant keeps the bar last', async () => {
  const mounted = mount()
  await settle(mounted, 'Accessibility: Not allowed')
  assert.ok(mounted.page.paintedBarSpans().some(span => span.id === 'bar:refresh'))
  const before = mounted.calls.filter(call => call === 'read:system').length
  mounted.page.activateBarSpan('bar:refresh')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(mounted.calls.filter(call => call === 'read:system').length > before, 'the delegated bar refresh reads again')
  mounted.page.setMaxRows(8)
  const short = mounted.render()
  assert.equal(short.length, 8)
  assert.equal(short.at(-1)?.includes('[Esc Back]'), true, 'the physical bar remains the last granted row')
  mounted.page.handleInput('\x1b')
  assert.equal(mounted.done(), true, 'the page own Esc closes THIS page through the root factory')
  mounted.page.dispose()
})

test('the 44x8 projection keeps the bundle, Host and first permission action on the first screen', async () => {
  const mounted = mount()
  await settle(mounted, 'Accessibility: Not allowed')
  mounted.page.setMaxRows(5)
  mounted.page.invalidate()
  const frame = mounted.render(44)
  const text = frame.join('\n')
  assert.equal(frame.length, 5, 'the root 44x8 grant is five physical rows (4 body + 1 bar)')
  assert.match(text, /Computer Use · Enabled/u)
  assert.match(text, /Host: macOS/u)
  assert.match(text, /Accessibility: Not allowed/u)
  assert.match(text, /\[Request permission\]/u, 'the first missing permission action is paintable on the first screen')
  assert.equal(frame.at(-1)?.includes('[Esc Back]'), true, 'the bar remains the last granted row')
  mounted.page.dispose()
})

test('a short confirmation hides the confirm bar and cannot dispatch until the risk is fully visible', async () => {
  const mounted = mount()
  mounted.page.setMaxRows(80)
  const frame = await settle(mounted, 'TextEdit')
  const revokeRow = frame.findIndex(line => line.includes('[Revoke access…]'))
  assert.ok(revokeRow >= 0)
  const labelCol = frame[revokeRow]!.indexOf('[')
  const event = { type: 'press', x: labelCol, y: revokeRow, width: 96, height: 79 } as TuiMouseEvent
  mounted.page.handleMouse(event)
  mounted.page.handleMouse({ ...event, type: 'click' } as TuiMouseEvent)
  const confirmation = mounted.render().join('\n')
  assert.match(confirmation, /\[y Revoke\]/u)
  mounted.page.setMaxRows(1)
  mounted.page.invalidate()
  const short = mounted.render(44)
  assert.equal(short.length, 1)
  assert.doesNotMatch(short[0]!, /\[y /u, 'a one-row grant cannot paint a confirmation decision')
  mounted.page.handleInput('y')
  assert.deepEqual(mounted.calls.filter(call => call.startsWith('revoke:')), [], 'no revoke may dispatch without the risk')
  mounted.page.dispose()
})

test('two buffered Enters admit exactly ONE Request dispatch and the stale frame is refused', async () => {
  const mounted = mount()
  await settle(mounted, 'Accessibility: Not allowed')
  let frame = mounted.render(96)
  for (let attempt = 0; attempt < 20 && !frame.some(line => line.trimStart().startsWith('> [Request permission]')); attempt += 1) {
    mounted.page.handleInput('\x1b[B')
    frame = mounted.render(96)
  }
  assert.ok(frame.some(line => line.trimStart().startsWith('> [Request permission]')))
  const before = mounted.calls.filter(call => call.startsWith('request:')).length
  mounted.page.handleInput('\r')
  mounted.page.handleInput('\r')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(mounted.calls.filter(call => call.startsWith('request:')).length, before + 1,
    'the second buffered Enter is refused by the frame/admission fence')
  mounted.page.dispose()
})
