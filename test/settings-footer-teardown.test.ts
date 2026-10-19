/**
 * The settings owner's footer-command teardown (R4-2).
 *
 * The per-item command runners live in the mounted `TuiApp` and are armed by
 * THIS runtime (`applyFooterSettings` -> `app.syncFooterCommandItems`). A
 * renderer branch without a `TuiApp` — the TSP renderer — never arms them, and
 * the teardown must therefore release NOTHING there: reading `surface.app`
 * throws `the surface is not mounted`, which previously turned every legal TSP
 * exit into a recorded cleanup failure (and did the same on the PiTui branch
 * before the boot applied the stored document).
 *
 * Both directions are asserted on the REAL `createSettingsRuntime`: unarmed is
 * inert and never touches the app; armed releases the app's footer exactly once.
 * @module @xmoon76/dsh-pi-tui/settings-footer-teardown.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsRuntime, type SettingsRuntimeDeps } from '../src/app/surface/settings-runtime.ts'
import type { TuiApp } from '../src/tui-app.ts'

const noop = (): void => {}

function mountRuntime(options: {
  readonly reads: { app: number }
  readonly onFooterDispose: () => void
}): ReturnType<typeof createSettingsRuntime> {
  const app = {
    disposeFooterCommand: () => { options.onFooterDispose() },
    syncFooterCommandItems: noop,
    applyFooterCommandConfig: noop,
    requestFooterCommandRefresh: noop,
    disableFooterCommand: noop,
    setFooterCustomItems: noop,
    setFooterPreset: noop,
    setFooterLayout: noop,
    getEffectiveFooterLayout: () => [],
    notify: noop,
  } as unknown as TuiApp
  const deps: SettingsRuntimeDeps = {
    surface: {
      get app(): TuiApp {
        options.reads.app += 1
        return app
      },
      status: { snapshot: () => ({}) as never, subscribe: () => noop },
    },
    signal: new AbortController().signal,
    tuiSettings: { get: () => ({}) } as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: {
      config: {
        footerCustomItems: {
          get: () => ({ items: [], invalidCount: 0 }),
          rawForPersistence: () => ({ kind: 'unavailable' }),
        },
        // The user layer opted into the command footer and owns a trusted
        // command config: the arm path this guard's positive half drives.
        footerCommandTrust: {
          userFooterMode: 'command',
          command: {},
          userCommandItemActivationIds: new Set<string>(),
        },
      },
    } as never,
    diag: { debug: noop, info: noop, warn: noop, error: noop, dispose: noop } as never,
    status: { refresh: noop },
    extensions: () => undefined,
  }
  return createSettingsRuntime(deps)
}

test('an UNARMED footer command releases nothing and never reads the app (the TSP shape)', () => {
  const reads = { app: 0 }
  let footerDisposals = 0
  const runtime = mountRuntime({ reads, onFooterDispose: () => { footerDisposals += 1 } })

  runtime.disposeFooterCommand()
  assert.equal(reads.app, 0, 'the teardown must not read the app when nothing was armed')
  assert.equal(footerDisposals, 0, 'nothing was created, so nothing is released')
})

test('an ARMED footer command is still released exactly once on teardown', () => {
  const reads = { app: 0 }
  let footerDisposals = 0
  const runtime = mountRuntime({ reads, onFooterDispose: () => { footerDisposals += 1 } })
  runtime.applyFooterSettings({ footer: 'command' }, [])
  runtime.disposeFooterCommand()
  assert.equal(footerDisposals, 1, 'the armed Pi footer is released exactly ONCE')
})
