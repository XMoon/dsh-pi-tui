/** Pure tests for the canonical PR2 display preset model. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { FOCUS_MODE_PROMPT, installFocusPrompt } from '../src/focus.ts'
import { StatusStore } from '../src/status/store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import {
  displayPolicyFor,
  isDisplayPreset,
  isDisplayPresetAvailable,
  isFocusDisplayPreset,
  resolveDisplayPreset,
  type DisplayState,
} from '../src/display-preset.ts'

test('recognizes the complete display vocabulary and exposes every preset', () => {
  assert.equal(isDisplayPreset('focus'), true)
  assert.equal(isDisplayPreset('compact'), true)
  assert.equal(isDisplayPreset('full'), true)
  assert.equal(isDisplayPreset('other'), false)
  assert.equal(isDisplayPresetAvailable('focus'), true)
  assert.equal(isDisplayPresetAvailable('full'), true)
  assert.equal(isDisplayPresetAvailable('compact'), true)
  assert.equal(isFocusDisplayPreset('focus'), true)
  assert.equal(isFocusDisplayPreset('full'), false)
  assert.equal(isFocusDisplayPreset('compact'), false)
})

test('returns each preset disclosure policy', () => {
  assert.deepEqual(displayPolicyFor('focus'), {
    turnLayer: 'collapsed',
    processLayer: 'collapsed',
    focusBehavior: true,
  })
  assert.deepEqual(displayPolicyFor('full'), {
    turnLayer: 'open',
    processLayer: 'expanded',
    focusBehavior: false,
  })
  assert.deepEqual(displayPolicyFor('compact'), {
    turnLayer: 'open',
    processLayer: 'collapsed',
    focusBehavior: false,
  })
})

test('canonical persistence wins over legacy Focus for every recognized preset', () => {
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'focus', focusMode: 'off' }), {
    preset: 'focus', canonicalize: false, source: 'canonical',
  })
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'full', focusMode: 'on' }), {
    preset: 'full', canonicalize: false, source: 'canonical',
  })
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'compact', focusMode: 'on' }), {
    preset: 'compact', canonicalize: false, source: 'canonical',
  })
  assert.deepEqual(resolveDisplayPreset({ displayPreset: 'garbage', focusMode: 'on' }), {
    preset: 'full', canonicalize: true, source: 'invalid-canonical',
  })
})

test('legacy Focus migration maps on to Focus and everything else to Full', () => {
  assert.deepEqual(resolveDisplayPreset({ focusMode: 'on' }), {
    preset: 'focus', canonicalize: true, source: 'legacy-focus',
  })
  for (const focusMode of ['off', '', 'ON', 'yes', undefined]) {
    assert.deepEqual(resolveDisplayPreset({ focusMode }), {
      preset: 'full', canonicalize: true, source: 'legacy-full',
    })
  }
})

test('one shared DisplayState drives the Focus prompt, TuiApp, and status projection', () => {
  const displayState: DisplayState = { preset: 'full' }
  const statusStore = new StatusStore()
  const sections: Array<{ text: string | (() => string) }> = []
  const disposePrompt = installFocusPrompt({
    get: (name: string) => name === 'systemPrompt'
      ? { section: (section: { text: string | (() => string) }) => { sections.push(section); return () => {} } }
      : undefined,
  } as never, displayState)
  assert.ok(disposePrompt !== undefined)
  const app = new TuiApp(new VirtualTerminal(80, 24), {
    onSubmit: () => {},
    onExit: () => {},
  }, { displayState, statusStore })
  const promptText = () => {
    const text = sections[0]?.text
    return typeof text === 'function' ? text() : text ?? ''
  }
  assert.equal(promptText(), '')
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'full')
  assert.deepEqual(app.setDisplayPreset('focus'), { kind: 'applied', preset: 'focus' })
  assert.equal(promptText(), FOCUS_MODE_PROMPT)
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'focus')
  assert.equal(sections.length, 1, 'the shared prompt must not be re-registered')
  assert.deepEqual(app.setDisplayPreset('full'), { kind: 'applied', preset: 'full' })
  assert.equal(promptText(), '')
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'full')
  disposePrompt()
  app.dispose()
})

test('TuiApp shares the canonical state and applies Compact without Focus behavior', async () => {
  const displayState: DisplayState = { preset: 'full' }
  const statusStore = new StatusStore()
  let notifications = 0
  const unsubscribe = statusStore.subscribe(() => { notifications += 1 })
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    displayState,
    statusStore,
  })
  app.start()
  await vt.waitForRender()
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'full')
  assert.deepEqual(app.setDisplayPreset('focus'), { kind: 'applied', preset: 'focus' })
  assert.equal(displayState.preset, 'focus')
  assert.equal(app.isFocusModeEnabled(), true)
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'focus')
  await vt.waitForRender()
  const beforeCompactRevision = statusStore.revision()
  const beforeCompactNotifications = notifications
  assert.deepEqual(app.setDisplayPreset('compact'), { kind: 'applied', preset: 'compact' })
  assert.equal(displayState.preset, 'compact')
  assert.equal(app.isFocusModeEnabled(), false, 'Compact must not enable the Focus behavioral policy')
  assert.equal(statusStore.snapshot().interaction.displayPreset, 'compact')
  assert.ok(statusStore.revision() > beforeCompactRevision, 'Compact must update the status projection')
  assert.ok(notifications > beforeCompactNotifications, 'Compact must notify the footer')
  await vt.waitForRender()
  assert.deepEqual(app.setDisplayPreset('compact'), { kind: 'unchanged', preset: 'compact' })
  assert.equal(displayState.preset, 'compact', 're-applying the live preset is unchanged, not a reset')
  unsubscribe()
  app.dispose()
})
