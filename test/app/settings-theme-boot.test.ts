/**
 * The boot display wiring for `Theme: auto` (settings-runtime).
 *
 * The runtime owns the policy: it samples the terminal ONCE through
 * `autoDetectTheme`, enables Mode 2031 tracking through `trackTerminalTheme`
 * (which no longer samples), and a live scheme report may only change the
 * palette while the persisted preference is still `auto`.
 * @module @xmoon76/dsh-pi-tui/settings-theme-boot.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsRuntime, type SettingsRuntimeDeps } from '../../src/app/surface/settings-runtime.ts'
import type { TuiApp } from '../../src/tui-app.ts'

// themeOptOut() skips terminal queries and live scheme reports under NO_COLOR /
// FORCE_COLOR=0 / CI=true — clear all three so the wiring under test stays live
// (the opt-out test sets NO_COLOR for its own scope).
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

const noop = (): void => {}

type ThemeHarness = {
  runtime: ReturnType<typeof createSettingsRuntime>
  applied: string[]
  detectCalls: number[]
  trackCalls: boolean[]
  report(scheme: 'dark' | 'light'): void
  setTheme(theme: string | undefined): void
  /** Record ONLY the selection intent (a write still in flight). */
  noteSelection(value: string): void
}

function mountThemeRuntime(): ThemeHarness {
  const applied: string[] = []
  const detectCalls: number[] = []
  const trackCalls: boolean[] = []
  let report: ((scheme: 'dark' | 'light') => void) | undefined
  let theme: string | undefined = 'auto'
  /** The runtime owner's deliberate-selection intent (the real `TuiApp` keeps it). */
  let intent: string | undefined
  const app = {
    setHomeEndMode: noop,
    setWheelScrollLines: noop,
    setFullscreen: noop,
    autoDetectTheme: (): Promise<void> => {
      detectCalls.push(1)
      return Promise.resolve()
    },
    trackTerminalTheme: (following: boolean): void => {
      trackCalls.push(following)
    },
    onTerminalThemeChange: (listener: (scheme: 'dark' | 'light') => void): (() => void) => {
      report = listener
      return noop
    },
    applyTheme: (value: string): void => {
      applied.push(value)
    },
    noteThemeSelection: (value: string): void => {
      intent = value
    },
    themeFollowsTerminal: (): boolean => intent === 'auto',
  } as unknown as TuiApp
  const deps: SettingsRuntimeDeps = {
    surface: {
      app,
      status: { snapshot: () => ({}) as never, subscribe: () => noop },
    },
    signal: new AbortController().signal,
    tuiSettings: {
      get: () => ({
        theme,
        homeEndKeys: 'viewport',
        wheelScrollLines: '1',
        fullscreen: 'off',
      }),
    } as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: { config: {} } as never,
    diag: { debug: noop, info: noop, warn: noop, error: noop, dispose: noop } as never,
    status: { refresh: noop },
    extensions: () => undefined,
  }
  const runtime = createSettingsRuntime(deps)
  return {
    runtime,
    applied,
    detectCalls,
    trackCalls,
    report: (scheme) => report?.(scheme),
    // Changing the persisted preference IS a deliberate selection in production (the
    // legacy editor, the reload re-apply, the workspace), so the helper records the
    // runtime owner's intent exactly like those sites do.
    setTheme: (value) => { theme = value; intent = value },
    /** Record ONLY the runtime owner's intent: a deliberate selection whose write is
     *  still in flight, so the persisted document still reads the previous value. */
    noteSelection: (value) => { intent = value },
  }
}

test('the boot wiring samples once through autoDetectTheme and only toggles Mode 2031', () => {
  const harness = mountThemeRuntime()
  harness.runtime.applyBootDisplay()
  assert.equal(harness.detectCalls.length, 1, 'the boot detection is the single sample')
  assert.deepEqual(harness.trackCalls, [true], 'tracking is enabled without sampling again')
})

test('a live scheme report only changes the theme while the latest selection follows the terminal', () => {
  const harness = mountThemeRuntime()
  harness.runtime.applyBootDisplay()
  harness.report('light')
  assert.deepEqual(harness.applied, ['light'], 'auto follows the reported scheme')
  harness.setTheme('dark')
  harness.applied.length = 0
  harness.report('light')
  assert.deepEqual(harness.applied, [], 'an explicit selection ignores live reports')
})

test('a live scheme report is fenced on the selection INTENT, not on a document a pending write has not updated', () => {
  // The regression this locks: gating the listener on the persisted document would let a
  // report colour over a choice that applied runtime-first while its write is in flight.
  const harness = mountThemeRuntime()
  harness.runtime.applyBootDisplay()
  harness.applied.length = 0
  harness.noteSelection('dark')
  harness.report('light')
  assert.deepEqual(harness.applied, [],
    'the intent already left auto although the document still reads auto')
})

test('a runtime switch from a manual theme to auto follows live reports', () => {
  const harness = mountThemeRuntime()
  harness.setTheme('dark')
  harness.runtime.applyBootDisplay()
  assert.deepEqual(harness.applied, ['dark'], 'the persisted manual theme wins at boot')
  harness.applied.length = 0
  // /settings or a reload switches to auto at runtime: it samples once and
  // enables Mode 2031, so the live listener must already exist.
  harness.setTheme('auto')
  harness.report('light')
  assert.deepEqual(harness.applied, ['light'], 'a runtime switch to auto must follow live reports')
})

test('a live scheme report cannot bypass the colour opt-out', () => {
  const previous = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
  try {
    const harness = mountThemeRuntime()
    harness.runtime.applyBootDisplay()
    harness.report('light')
    assert.deepEqual(harness.applied, [], 'NO_COLOR must keep the palette untouched')
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previous
  }
})

test('a manual persisted theme applies itself and does not track', () => {
  const harness = mountThemeRuntime()
  harness.setTheme('light')
  harness.runtime.applyBootDisplay()
  assert.deepEqual(harness.applied, ['light'], 'the persisted palette is applied')
  assert.deepEqual(harness.trackCalls, [false], 'a manual theme stops tracking')
  assert.equal(harness.detectCalls.length, 0, 'a manual theme never samples the terminal')
})
