/**
 * M3-6 PR3 SettingsRuntime footer-lifecycle owner test. The REAL
 * `createSettingsRuntime` owner is driven with minimal semantic stubs; the
 * footer command runner / dynamic-item runtime are the real classes, with
 * only their one-shot `dispose` observed (never a source lock). Proves the
 * non-truncating disposal contract:
 *
 * - a throwing footer unsubscribe cannot strand the runner or the dynamic
 *   footer-item runtime;
 * - a throwing runner disposal cannot strand the dynamic runtime;
 * - every owned release runs exactly once;
 * - a second owner disposal is inert.
 * @module @xmoon76/dsh-pi-tui/settings-runtime-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiag } from '../src/diag.ts'
import { createSettingsRuntime, type SettingsRuntimeDeps } from '../src/app/surface/settings-runtime.ts'
import { FooterCommandRunner, type FooterCommandConfig } from '../src/footer/command-runner.ts'
import { FooterDynamicItemRuntime } from '../src/footer/dynamic-item-runtime.ts'
import { emptyStatusSnapshot } from '../src/status/types.ts'

const silentDiag = createDiag({ filePath: undefined, stderrLevel: 'off' })

const TRUSTED_COMMAND: FooterCommandConfig = {
  command: 'true',
  timeoutMs: 1_000,
  refreshIntervalMs: 1_000,
  maxRows: 1,
}

/**
 * Build the REAL settings owner with an armed footer command runner and an
 * armed dynamic-item runtime. The lifecycle signal is already aborted so the
 * real runner never spawns a child (the slots under test are created and
 * released regardless).
 */
function createOwner(options: { readonly unsubscribeFailure?: Error }) {
  const counters = { unsubscribe: 0, runnerDispose: 0, dynamicDispose: 0 }
  const controller = new AbortController()
  controller.abort()
  const surface = {
    app: {
      setFooterCustomItems: () => {},
      getEffectiveFooterLayout: () => undefined,
      setFooterPreset: () => {},
      setFooterLayout: () => {},
      setFooterCommandRows: () => {},
      setFooterCommandItemValue: () => {},
      notify: () => {},
      getTerminalWidth: () => 100,
      getTerminalHeight: () => 30,
    },
    status: {
      snapshot: () => emptyStatusSnapshot(),
      subscribe: () => () => {
        counters.unsubscribe += 1
        if (options.unsubscribeFailure !== undefined) throw options.unsubscribeFailure
      },
    },
  }
  const trust = {
    userFooterMode: 'command' as string | undefined,
    command: TRUSTED_COMMAND as FooterCommandConfig | undefined,
    userCommandItemActivationIds: new Set<string>(),
    userCommandItemFallbackActivationIds: new Set<string>(),
  }
  const runtime = createSettingsRuntime({
    surface: surface as unknown as SettingsRuntimeDeps['surface'],
    signal: controller.signal,
    tuiSettings: { get: () => ({ footer: 'command' }), replace: () => {} } as never,
    settingsForms: undefined,
    isCleanedUp: () => false,
    backend: {
      config: {
        footerCommandTrust: trust,
        footerCustomItems: { get: () => ({ items: [], invalidCount: 0 }) },
      },
    } as unknown as SettingsRuntimeDeps['backend'],
    diag: silentDiag,
    status: { refresh: () => {} },
    extensions: () => undefined,
  })
  // A native apply creates the dynamic-item runtime; the trusted command apply
  // then arms the whole-footer runner + its status subscription.
  runtime.applyFooterSettings({ footer: 'full', footerLayout: undefined, footerCustomItems: undefined })
  runtime.applyFooterSettings({ footer: 'command', footerLayout: undefined, footerCustomItems: undefined })
  return { runtime, counters }
}

test('M3-6 PR3: a throwing footer unsubscribe cannot strand the runner or the dynamic runtime', (t) => {
  const failure = new Error('footer unsubscribe failed')
  const { runtime, counters } = createOwner({ unsubscribeFailure: failure })
  const originalRunner = FooterCommandRunner.prototype.dispose
  const originalDynamic = FooterDynamicItemRuntime.prototype.dispose
  t.mock.method(FooterCommandRunner.prototype, 'dispose', function (this: FooterCommandRunner) {
    counters.runnerDispose += 1
    return originalRunner.call(this)
  })
  t.mock.method(FooterDynamicItemRuntime.prototype, 'dispose', function (this: FooterDynamicItemRuntime) {
    counters.dynamicDispose += 1
    return originalDynamic.call(this)
  })

  assert.throws(() => runtime.disposeFooterCommand(), (error: unknown) => error === failure)
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'both later owners were still disposed after the throwing unsubscribe')

  runtime.disposeFooterCommand()
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'a second disposal is inert (no release re-runs)')
})

test('M3-6 PR3: a throwing runner disposal cannot strand the dynamic footer runtime', (t) => {
  const failure = new Error('runner dispose failed')
  const { runtime, counters } = createOwner({})
  const originalDynamic = FooterDynamicItemRuntime.prototype.dispose
  t.mock.method(FooterCommandRunner.prototype, 'dispose', function (this: FooterCommandRunner) {
    counters.runnerDispose += 1
    throw failure
  })
  t.mock.method(FooterDynamicItemRuntime.prototype, 'dispose', function (this: FooterDynamicItemRuntime) {
    counters.dynamicDispose += 1
    return originalDynamic.call(this)
  })

  assert.throws(() => runtime.disposeFooterCommand(), (error: unknown) => error === failure)
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'the dynamic runtime was still disposed after the throwing runner disposal')

  runtime.disposeFooterCommand()
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'a second disposal is inert (no release re-runs)')
})
