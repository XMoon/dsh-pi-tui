/**
 * Shared L6 test fixture: the REAL Direct `TuiSettingsConfig` adapter over a
 * schema-accurate `SettingsForms` stand-in and mutable plugin-Config references.
 *
 * The UI suites must drive the PRODUCTION adapter, not a hand-rolled
 * `get`/`replace` object: this fixture gives the workspace tests the same
 * `DirectTuiSettings` the deployment composes, so "UI → path-scoped
 * `SettingsForms.mutate` → the Loader committing the volatile reference →
 * authoritative re-read" is the real chain. The `SettingsForms` stand-in owns
 * the official path-op shape (describe/mutate + revision fence), exactly like
 * `test/tui-settings-direct.test.ts`.
 * @module @xmoon76/dsh-pi-tui/support/direct-settings-fixture
 */

import { DirectTuiSettings, type SettingsFormsLike, type TuiConfigRefs, type TuiSettingsPathOp } from '../../src/runtime/direct/tui-settings-direct.ts'
import type { TuiSettingsDoc } from '../../src/runtime/config-port.ts'

/** One mutation the adapter really dispatched. */
export interface DirectSettingsCall {
  readonly ns: string
  readonly ops: readonly TuiSettingsPathOp[]
  /** The revision fence the adapter passed (the SAME snapshot it diffed against). */
  readonly revision: number | undefined
}

export interface DirectSettingsFixture {
  readonly settings: DirectTuiSettings
  /** Every real `SettingsForms.mutate` the adapter dispatched, in order. */
  readonly calls: readonly DirectSettingsCall[]
  /** The current EFFECTIVE document (the mutable references). */
  readonly document: () => TuiSettingsDoc
  /** The revision the Host currently serves. */
  readonly revision: () => number
}

const FIELD_DEFAULTS: Record<string, unknown> = {
  theme: 'auto',
  iconStyle: 'emoji',
  footer: 'full',
  footerFallbackMode: 'default',
  fullscreen: 'off',
  busyEnter: 'queue',
  localShellSandbox: 'bypass',
  homeEndKeys: 'input',
  displayPreset: 'full',
  progressUpdates: 'milestones',
  responseStyle: 'default',
  gitAttribution: 'off',
  notificationMode: 'unfocused',
  notificationMethod: 'auto',
  terminalProgress: '9;4+7501',
  wheelScrollLines: '1',
  footerLayout: undefined,
  footerCustomItems: undefined,
  footerCommand: undefined,
  keybindings: undefined,
}

/** Build the REAL Direct adapter over a mutable reference set and a Host-ish
 *  `SettingsForms` that owns the revision fence and commits the ops into the
 *  references (the Loader's authoritative round-trip). */
export function createDirectSettingsFixture(overrides: Record<string, unknown> = {}): DirectSettingsFixture {
  const values: Record<string, unknown> = { ...FIELD_DEFAULTS, ...overrides }
  const calls: DirectSettingsCall[] = []
  let revision = 7
  const ref = (field: string): { get(): unknown } => ({ get: () => values[field] })
  const refs = new Proxy({} as TuiConfigRefs, {
    get: (_target, field: string) => ref(field),
  })
  const forms: SettingsFormsLike = {
    describe: () => [{
      ns: 'tui-app',
      value: { ...values },
      user: {},
      revision,
    }],
    mutate: async (ns, ops, expectedRevision) => {
      calls.push({ ns, ops, revision: expectedRevision })
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw Object.assign(new Error(`settings namespace "${ns}" changed since it was read`), { code: 'SETTINGS_CONFLICT' })
      }
      for (const op of ops) {
        if (op.op === 'set') values[op.path.join('.')] = op.value
        else delete values[op.path.join('.')]
      }
      revision += 1
    },
  }
  const settings = new DirectTuiSettings(refs, forms)
  return {
    settings,
    calls,
    document: () => settings.get(),
    revision: () => revision,
  }
}
