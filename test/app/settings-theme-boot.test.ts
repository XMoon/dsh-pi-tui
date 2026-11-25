/**
 * The boot display wiring and the live `Theme: auto` observation contract.
 *
 * Every case drives the REAL composition: `createSettingsRuntime.applyBootDisplay()`
 * over a real `TuiApp`, a `VirtualTerminal` and the real fork parser/query seam.
 * The only substitutions are the external Host-ish seams a unit composition cannot
 * own (the settings document, the display preset and the theme registry).
 *
 * A live scheme report is a change HINT, never a palette decision: the app issues
 * ONE OSC 11 observation, the real background wins, and a timeout retains a
 * previously confirmed background (a scheme-only terminal still follows its
 * report). Boot/settings/reload/hand-off share this ONE owner.
 * @module @xmoon76/dsh-pi-tui/settings-theme-boot.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { Terminal } from '@xmoon76/pi-tui'
import { createSettingsRuntime, type SettingsRuntimeDeps } from '../../src/app/surface/settings-runtime.ts'
import { TuiApp, type OwnedRunner } from '../../src/tui-app.ts'
import { darkColors, lightColors } from '../../src/domain/display/theme.ts'
import { currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

// themeOptOut() skips terminal queries and live scheme reports under NO_COLOR /
// FORCE_COLOR=0 / CI=true — clear all three so the wiring under test stays live
// (the opt-out test sets NO_COLOR for its own scope).
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''
// These are ordinary (non-image) theme cases: pin the image protocol so an
// ambient/host SIXEL handle can never turn the report-triggered observation's
// first call into the §4.4 drain (which would consume the test's reply). The
// one shared-probe/drain case lives in the SIXEL integration suite, on the real
// protocol negotiation. The product lane sanitizes this variable; pinning makes
// a developer run agree with it.
process.env.PI_IMAGE_PROTOCOL = 'none'

const noop = (): void => {}

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
  // The active palette is process-wide; leave the dark default behind.
  setTheme('dark')
})

const runOwned: OwnedRunner = ((_label, task, options) => {
  // The production owned-task entry invokes the factory SYNCHRONOUSLY (the
  // owner slot must exist before any await); mirror that semantics here.
  let result: unknown
  try {
    result = task()
  } catch (error) {
    options.onError?.(error)
    return
  }
  Promise.resolve(result).then(
    (value) => { options.onResult?.(value as never) },
    (error) => { options.onError?.(error) },
  )
}) as OwnedRunner

type ThemeHarness = {
  readonly app: TuiApp
  readonly vt: VirtualTerminal
  readonly writes: string[]
  readonly doc: { theme?: string; homeEndKeys?: string; wheelScrollLines?: string; fullscreen?: string }
  readonly runtime: ReturnType<typeof createSettingsRuntime>
  boot(): void
}

/** Mount the SAME production boot owner over a real app + VirtualTerminal. */
function mountThemeHarness(options: { theme?: string; doc?: Partial<ThemeHarness['doc']> } = {}): ThemeHarness {
  const vt = new VirtualTerminal(100, 24)
  const writes: string[] = []
  const terminal = new Proxy(vt, {
    get(target, prop) {
      if (prop === 'write') {
        return (data: string): void => { writes.push(data); target.write(data) }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as Terminal
  const app = new TuiApp(terminal, { onSubmit: noop, onExit: noop, runOwned })
  app.start()
  startedApps.add(app)
  const doc = {
    theme: options.theme ?? 'auto',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    fullscreen: 'off',
    ...options.doc,
  }
  const deps: SettingsRuntimeDeps = {
    surface: {
      app,
      status: { snapshot: () => ({}) as never, subscribe: () => noop },
    },
    signal: new AbortController().signal,
    tuiSettings: {
      get: () => doc,
      replace: () => Promise.resolve(),
    } as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: {
      config: {
        footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) },
        footerCommandTrust: { command: undefined, userFooterMode: 'default' },
        configReadiness: () => 'ready',
        footerCustomItemsResolved: { items: [], invalidCount: 0 },
      },
    } as never,
    diag: { debug: noop, info: noop, warn: noop, error: noop, dispose: noop } as never,
    status: { refresh: noop },
    extensions: () => undefined,
  }
  const runtime = createSettingsRuntime(deps)
  return {
    app,
    vt,
    writes,
    doc,
    runtime,
    boot: () => { runtime.applyBootDisplay() },
  }
}

async function settle(vt: VirtualTerminal): Promise<void> {
  await vt.waitForRender()
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await vt.waitForRender()
}

/** Wait for a palette fact produced by a REAL observation. The only bounded
 *  window here is the production 800 ms OSC 11 timeout (the contract under
 *  test); the bound is the observation deadline plus scheduling slack. */
async function waitForPalette(expected: typeof darkColors, timeoutMs = 1600): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (currentPalette === expected) return
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  assert.equal(currentPalette, expected, 'the palette did not settle within the observation window')
}

function osc11Queries(writes: readonly string[]): number {
  return writes.filter(data => data.includes('\x1b]11;?')).length
}

test('boot samples the terminal once and only toggles Mode 2031 tracking', async () => {
  const h = mountThemeHarness()
  h.boot()
  assert.equal(osc11Queries(h.writes), 1, 'the boot detection is the single sample')
  const mode = h.writes.filter(data => data === '\x1b[?2031h' || data === '\x1b[?2031l')
  assert.deepEqual(mode, ['\x1b[?2031h'], 'tracking is enabled without sampling again')
  await settle(h.vt)
})

test('a live light report re-queries the real dark background and keeps the dark palette', async () => {
  const h = mountThemeHarness()
  h.boot()
  h.vt.sendInput('\x1b]11;#111111\x07')
  await settle(h.vt)
  assert.equal(currentPalette, darkColors, 'precondition: the boot observation is dark')
  const beforeReport = h.writes.length
  h.vt.sendInput('\x1b[?997;2n') // tmux/Ghostty report the wrong light appearance
  await settle(h.vt)
  assert.equal(osc11Queries(h.writes.slice(beforeReport)), 1,
    'the report must trigger ONE narrow OSC 11 observation')
  assert.equal(currentPalette, darkColors,
    'the report alone must never repaint the surface light before a real reply')
  h.vt.sendInput('\x1b]11;#282A36\x07')
  await settle(h.vt)
  assert.equal(currentPalette, darkColors, 'the real dark background keeps the dark palette')
  // A real light background still follows: same-value reports are change hints.
  h.vt.sendInput('\x1b[?997;2n')
  await settle(h.vt)
  h.vt.sendInput('\x1b]11;#F5F5F5\x07')
  await settle(h.vt)
  assert.equal(currentPalette, lightColors, 'a real light background selects the light palette')
  h.vt.sendInput('\x1b[?997;2n')
  await settle(h.vt)
  h.vt.sendInput('\x1b]11;#282A36\x07')
  await settle(h.vt)
  assert.equal(currentPalette, darkColors, 'the next real dark reply returns to the dark palette')
})

test('a timeout after a confirmed background retains it instead of trusting a contradicting hint', async () => {
  const previous = process.env.COLORFGBG
  process.env.COLORFGBG = '0;15' // would select LIGHT if the timeout fell back to env
  try {
    const h = mountThemeHarness()
    h.boot()
    h.vt.sendInput('\x1b]11;#111111\x07')
    await settle(h.vt)
    assert.equal(currentPalette, darkColors, 'precondition: a confirmed dark background')
    h.vt.sendInput('\x1b[?997;2n') // contradicting hint, then a silent (timeout) observation
    await settle(h.vt)
    // The renewed observation really has to time out before the retention claim
    // is observable; 1 s covers the production 800 ms deadline plus slack.
    await new Promise<void>((resolve) => { setTimeout(resolve, 1000) })
    assert.equal(currentPalette, darkColors,
      'an unconfirmed hint may never override a confirmed background after a timeout')
  } finally {
    if (previous === undefined) delete process.env.COLORFGBG
    else process.env.COLORFGBG = previous
  }
})

test('a scheme-only Auto tenure (no confirmed background) follows its latest report after a timeout', async () => {
  const previous = process.env.COLORFGBG
  delete process.env.COLORFGBG
  try {
    const h = mountThemeHarness()
    h.boot() // silent: the boot observation times out with no background or hint
    await settle(h.vt)
    h.vt.sendInput('\x1b[?997;2n')
    await waitForPalette(lightColors, 2400)
    assert.equal(currentPalette, lightColors, 'the latest report decides when no background was ever confirmed')
    h.vt.sendInput('\x1b[?997;1n')
    await waitForPalette(darkColors, 2400)
    assert.equal(currentPalette, darkColors, 'a later report is the new latest hint')
  } finally {
    if (previous === undefined) delete process.env.COLORFGBG
    else process.env.COLORFGBG = previous
  }
})

test('a same-value report burst uses the latest sample and never flashes light', async () => {
  const h = mountThemeHarness()
  h.boot()
  h.vt.sendInput('\x1b]11;#111111\x07')
  await settle(h.vt)
  // A DISTINCT installed palette makes both failure modes observable: a stale
  // commit shows light, and a dropped follow-up leaves this custom palette.
  const custom = { ...darkColors, primary: '#123456' }
  h.app.applyPalette(custom)
  assert.equal(h.app.currentTheme(), 'custom', 'precondition: a non-builtin installed palette')
  const applied: string[] = []
  h.app.onThemeChanged(() => applied.push(h.app.currentTheme()))
  const before = h.writes.length
  h.vt.sendInput('\x1b[?997;2n')
  h.vt.sendInput('\x1b[?997;2n')
  await settle(h.vt)
  assert.equal(osc11Queries(h.writes.slice(before)), 1,
    'the burst shares ONE app-owned observation, not one query per report')
  // The SUPERSEDED flight answers LIGHT — the opposite of the final background.
  // A stale-commit implementation would paint it.
  h.vt.sendInput('\x1b]11;#F5F5F5\x07')
  await settle(h.vt)
  assert.equal(h.app.currentTheme(), 'custom', 'the superseded answer committed nothing')
  assert.equal(osc11Queries(h.writes.slice(before)), 2,
    'the follow-up observation is actually issued after the drain (a dropped demand leaves it at 1)')
  h.vt.sendInput('\x1b]11;#282A36\x07')
  await settle(h.vt)
  assert.deepEqual(applied, ['dark'], 'only the latest real sample commits the family')
  assert.equal(h.app.currentTheme(), 'dark', 'the real dark background replaces the custom palette')
  assert.equal(currentPalette, darkColors, 'and the installed palette is the dark family')
})

test('a manual override during a pending Auto observation wins over its late answer', async () => {
  const h = mountThemeHarness()
  h.boot()
  h.vt.sendInput('\x1b]11;#F5F5F5\x07') // a real light background: an observable boot commit
  await waitForPalette(lightColors)
  await settle(h.vt)
  const before = h.writes.length
  const pending = h.app.autoDetectTheme()
  assert.equal(osc11Queries(h.writes.slice(before)), 1, 'the explicit Auto request samples once')
  // The user confirms a fixed theme while OSC 11 is still in flight.
  h.app.noteThemeSelection('dark')
  h.app.applyTheme('dark', { value: 'dark' })
  h.vt.sendInput('\x1b]11;#F5F5F5\x07')
  await pending
  await settle(h.vt)
  assert.equal(h.app.currentTheme(), 'dark', 'the late Auto answer must not colour the fixed choice')
  assert.equal(currentPalette, darkColors, 'the fixed dark palette stays installed')
})

test('a stop releases the observation as a cancellation, never as an environment fallback', async () => {
  const previous = process.env.COLORFGBG
  process.env.COLORFGBG = '0;15' // would select LIGHT if it were treated as a timeout
  try {
    const h = mountThemeHarness()
    setTheme('dark')
    h.boot() // the boot observation is still in flight
    h.app.stop()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.equal(currentPalette, darkColors,
      'a released observation is a cancellation: its undefined never reads COLORFGBG')
    h.app.start()
    await settle(h.vt)
    h.vt.sendInput('\x1b]11;#111111\x07')
    await settle(h.vt)
    assert.equal(currentPalette, darkColors, 'the restarted surface re-samples and applies its real reply')
  } finally {
    if (previous === undefined) delete process.env.COLORFGBG
    else process.env.COLORFGBG = previous
  }
})

test('an A→B→A hand-off cannot commit the observation resolved before it', async () => {
  const h = mountThemeHarness()
  h.boot()
  h.vt.sendInput('\x1b]11;#111111\x07')
  await waitForPalette(darkColors)
  await settle(h.vt)
  const pending = h.app.autoDetectTheme() // observation on the main screen
  const beforeHandoff = h.writes.length
  // The reply RESOLVES in this tick, then the screen is handed off twice before
  // its continuation may commit: A(main) -> B(alt) -> A(main). LIGHT would be a
  // visible wrong commit if the released observation were still committed.
  h.vt.sendInput('\x1b]11;#F5F5F5\x07')
  h.app.setFullscreen(true)
  h.app.setFullscreen(false)
  await pending
  await settle(h.vt)
  assert.equal(currentPalette, darkColors, 'a released observation can never colour the restored screen')
  // The restored screen really re-sampled: its fresh LIGHT answer is applied.
  assert.equal(osc11Queries(h.writes.slice(beforeHandoff)), 1,
    'the hand-off completion point issues exactly ONE fresh observation')
  h.vt.sendInput('\x1b]11;#F5F5F5\x07')
  await waitForPalette(lightColors)
  assert.equal(currentPalette, lightColors, 'the fresh reply applies on the restored screen')
})

test('the colour opt-out admits no Auto observation at boot or on a live report', async () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, CI: process.env.CI }
  process.env.NO_COLOR = '1'
  process.env.FORCE_COLOR = ''
  process.env.CI = ''
  try {
    setTheme('dark')
    const h = mountThemeHarness()
    h.boot()
    await settle(h.vt)
    assert.equal(osc11Queries(h.writes), 0, 'the boot detection never queries under the opt-out')
    const before = h.writes.length
    h.vt.sendInput('\x1b[?997;2n')
    await settle(h.vt)
    assert.equal(osc11Queries(h.writes.slice(before)), 0, 'a live report never queries under the opt-out')
    assert.equal(currentPalette, darkColors, 'and it never commits a light palette')
  } finally {
    for (const key of ['NO_COLOR', 'FORCE_COLOR', 'CI'] as const) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('a synchronous theme observer selection wins over the outer transaction', async () => {
  const h = mountThemeHarness({ theme: 'dark' })
  h.boot()
  await settle(h.vt)
  // The observer re-enters with a NEWER deliberate selection during the outer
  // transaction's notification. The outer commit must already be visible and
  // must not overwrite the nested one afterwards.
  const release = h.app.onThemeChanged(() => {
    if (h.app.currentTheme() === 'dark') h.app.noteThemeSelection('auto')
  })
  try {
    h.app.applyTheme('dark', { value: 'dark' })
  } finally {
    release()
  }
  assert.equal(h.app.themeFollowsTerminal(), true,
    'the nested selection is newer and must own the final intent')
})

test('a manual persisted theme applies itself and neither queries nor tracks', async () => {
  const h = mountThemeHarness({ theme: 'light' })
  h.boot()
  assert.equal(osc11Queries(h.writes), 0, 'a manual theme never samples the terminal')
  assert.deepEqual(h.writes.filter(data => data === '\x1b[?2031h' || data === '\x1b[?2031l'), [],
    'a manual theme does not subscribe to scheme reports')
  assert.equal(currentPalette, lightColors, 'the persisted palette is applied')
  await settle(h.vt)
})

test('a live report under a manual selection changes nothing', async () => {
  const h = mountThemeHarness({ theme: 'dark' })
  h.boot()
  const before = h.writes.length
  h.vt.sendInput('\x1b[?997;2n')
  await settle(h.vt)
  assert.equal(osc11Queries(h.writes.slice(before)), 0, 'a fixed theme admits no observation')
  assert.equal(currentPalette, darkColors, 'a fixed theme keeps its palette')
})

test('display and fullscreen persist through the semantic settings port without Direct forms', async () => {
  const writes: unknown[] = []
  let doc = { displayPreset: 'regular', fullscreen: 'off' }
  const runtime = createSettingsRuntime({
    surface: {
      app: {
        setDisplayPreset: () => ({ kind: 'applied' }),
        notify: (message: string) => { assert.fail(message) },
      } as never,
      status: { snapshot: () => ({}) as never, subscribe: () => noop },
    },
    signal: new AbortController().signal,
    tuiSettings: {
      get: () => doc,
      replace: (next: typeof doc) => { writes.push(next); doc = next },
    } as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: { config: { footerCustomItems: { rawForPersistence: () => ({ kind: 'available', value: undefined }) } } } as never,
    diag: { debug: noop, info: noop, warn: noop, error: assert.fail, dispose: noop } as never,
    status: { refresh: noop },
    extensions: () => undefined,
  })
  runtime.setDisplayPreset('focus')
  runtime.setFullscreen(true)
  // Both existing detached writes join the semantic document's FIFO.
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(writes.length, 2)
  assert.equal(doc.displayPreset, 'focus')
  assert.equal(doc.fullscreen, 'on')
})

test('a stored fullscreen preference is restored by the boot application', async () => {
  const h = mountThemeHarness({ theme: 'dark', doc: { fullscreen: 'on' } })
  h.boot()
  assert.equal(h.app.isFullscreen?.(), true, 'a stored `on` mounts the alt screen at boot')
  await settle(h.vt)
})
