/**
 * M3-6 PR3 footer-command lifecycle owner test (TS5 §13.4: the slots moved
 * from the application settings owner into the TUI footer runtime). The REAL
 * `createFooterRuntime` owner is driven with minimal semantic stubs; the whole
 * footer command runner and the dynamic-item runtime are the real classes,
 * with only their one-shot `dispose` observed (never a source lock). Proves
 * the non-truncating disposal contract:
 *
 * - a throwing footer unsubscribe cannot strand the runner or the dynamic
 *   footer-item runtime;
 * - a throwing runner disposal cannot strand the dynamic runtime;
 * - every owned release runs exactly once;
 * - a second owner disposal is inert.
 * @module @xmoon76/dsh-pi-tui/footer-runtime-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createFooterRuntime } from '../src/tui/footer/runtime.ts'
import { FooterCommandRunner } from '../src/tui/footer/command-runner.ts'
import { FooterDynamicItemRuntime } from '../src/tui/footer/dynamic-item-runtime.ts'
import type { FooterCommandConfig } from '../src/domain/footer/command-config.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/domain/footer/presets.ts'
import { emptyStatusSnapshot } from '../src/domain/status/types.ts'

const TRUSTED_COMMAND: FooterCommandConfig = {
  command: 'true',
  timeoutMs: 1_000,
  refreshIntervalMs: 1_000,
  maxRows: 1,
}

/**
 * Build the REAL footer runtime with an armed whole-footer command runner and
 * an armed dynamic-item runtime. The lifecycle signal is already aborted so the
 * real runner never spawns a child (the slots under test are created and
 * released regardless).
 */
function createOwner(options: { readonly unsubscribeFailure?: Error }) {
  const counters = { unsubscribe: 0, runnerDispose: 0, dynamicDispose: 0 }
  const controller = new AbortController()
  controller.abort()
  const runtime = createFooterRuntime({
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    subscribeStatus: () => () => {
      counters.unsubscribe += 1
      if (options.unsubscribeFailure !== undefined) throw options.unsubscribeFailure
    },
    onCommandOutput: () => {},
    onCommandItemValue: () => {},
    onNotifyOnce: () => {},
    effectiveLayout: () => DEFAULT_FOOTER_LAYOUT,
  })
  // A native apply reconciles the dynamic-item runtime; the trusted command
  // apply then arms the whole-footer runner + its status subscription.
  runtime.syncCommandItems([], new Set<string>(), controller.signal)
  runtime.armCommand(TRUSTED_COMMAND, controller.signal)
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

  assert.throws(() => runtime.dispose(), (error: unknown) => error === failure)
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'both later owners were still disposed after the throwing unsubscribe')

  runtime.dispose()
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

  assert.throws(() => runtime.dispose(), (error: unknown) => error === failure)
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'the dynamic runtime was still disposed after the throwing runner disposal')

  runtime.dispose()
  assert.deepEqual(counters, { unsubscribe: 1, runnerDispose: 1, dynamicDispose: 1 },
    'a second disposal is inert (no release re-runs)')
})
