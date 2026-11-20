/**
 * M6 PR-A — the Host-owned canonical TUI preference migration contract.
 *
 * The migration carries the retired Direct (`tui-app`) / Split Host
 * (`split-host-pi-tui-runtime`) profile USER fields and the historical
 * `settings.yaml(.imported)` document into the canonical
 * `pi-tui-preferences` row, once, without trusting the merged effective layer
 * and without ever merging a user-owned whole value. Conflicts, unreadable
 * sources, `!!js` expressions and refused writes fail closed with FIELD NAMES
 * and never advance the marker.
 *
 * @module @xmoon76/dsh-pi-tui/profile-preferences-migration.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import {
  migrateProfileTuiPreferences,
  TuiPreferencesMigrationError,
  type ProfileConfigEditorLike,
  type ProfilePreferencesMigrationInput,
} from '../../src/app/config/profile-preferences-migration.ts'
import type { MigrationDiagLike } from '../../src/app/config/legacy-settings-migration.ts'
import type { SettingsFormsLike, TuiSettingsDescriptorLike, TuiSettingsPathOp } from '../../src/runtime/direct/tui-settings-direct.ts'

const CANONICAL = 'pi-tui-preferences'
const DIRECT = 'tui-app'
const SPLIT = 'split-host-pi-tui-runtime'

interface HarnessState {
  canonical: Record<string, unknown>
  direct?: Record<string, unknown>
  split?: Record<string, unknown>
  registry: Record<string, unknown>
}

function rawPatch(state: HarnessState, extraRows = ''): string {
  const rows: unknown[] = [
    { id: 'pi-tui-preferences', name: '@xmoon76/dsh-pi-tui/preferences', ...(Object.keys(state.canonical).length ? { config: state.canonical } : {}) },
  ]
  if (state.direct !== undefined) rows.push({ id: DIRECT, name: '@xmoon76/dsh-pi-tui', config: state.direct })
  if (state.split !== undefined) rows.push({ id: SPLIT, name: '@xmoon76/dsh-pi-tui/host-runtime', config: state.split })
  return `${yamlStringify(rows)}${extraRows}`
}

function diagHarness(): { diag: MigrationDiagLike; warnings: Array<{ message: string; fields?: Record<string, unknown> }>; infos: string[] } {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    diag: {
      warn: (message, fields) => { warnings.push({ message, fields }) },
      info: message => { infos.push(message) },
    },
  }
}

/** A profile-file-backed harness: `forms.describe` and `editor.edit` both
 * observe the SAME raw USER document, so a write is visible to a retry. */
function harness(options: {
  readonly canonical?: Record<string, unknown>
  readonly direct?: Record<string, unknown>
  readonly split?: Record<string, unknown>
  readonly registry?: Record<string, unknown>
  readonly extraRows?: string
  readonly entryName?: string
  readonly refuseWrite?: boolean
  readonly beforeChange?: (state: HarnessState, patchPath: string) => void
} = {}) {
  const home = join(tmpdir(), `dsh-pi-tui-prefs-migration-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(home, { recursive: true })
  const state: HarnessState = {
    canonical: { ...(options.canonical ?? {}) },
    ...(options.direct === undefined ? {} : { direct: { ...options.direct } }),
    ...(options.split === undefined ? {} : { split: { ...options.split } }),
    registry: { ...(options.registry ?? {}) },
  }
  const patchPath = join(home, 'cordis.patch.yml')
  writeFileSync(patchPath, rawPatch(state, options.extraRows ?? ''), 'utf8')
  let revision = 3
  const writes: Array<Record<string, unknown>> = []
  const mutations: Array<{ ns: string; ops: readonly TuiSettingsPathOp[]; revision?: number }> = []
  const forms: SettingsFormsLike = {
    describe: (): readonly TuiSettingsDescriptorLike[] => [
      { ns: CANONICAL, value: { ...state.canonical }, user: { ...state.canonical }, revision },
      { ns: 'agent-preset-registry', value: { ...state.registry }, user: { ...state.registry }, revision: 9 },
    ],
    mutate: async (ns, ops, expectedRevision) => {
      if (expectedRevision !== undefined && expectedRevision !== revision && ns === CANONICAL) {
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
      mutations.push({ ns, ops, revision: expectedRevision })
      const section = ns === 'agent-preset-registry' ? state.registry : state.canonical
      for (const op of ops) {
        if (op.op === 'set') section[op.path[0]!] = op.value
        else delete section[op.path[0]!]
      }
      revision += 1
    },
  }
  const configEditor: ProfileConfigEditorLike = {
    entries: () => [{ options: { id: CANONICAL, name: options.entryName ?? '@xmoon76/dsh-pi-tui/preferences' } }],
    edit: async (_entry, change) => {
      if (options.refuseWrite === true) {
        throw new Error(`Configuration for "${CANONICAL}" is overridden by a home patch or command-line overlay`)
      }
      options.beforeChange?.(state, patchPath)
      const next = change({}, {})
      writes.push(next)
      state.canonical = next
      revision += 1
      writeFileSync(patchPath, rawPatch(state, options.extraRows ?? ''), 'utf8')
    },
  }
  const input = (resolvePreset: (id: string) => Promise<void> = async () => {}): ProfilePreferencesMigrationInput => ({
    patchPath,
    configEditor,
    forms,
    home,
    resolvePreset,
    diag: diagHarness().diag,
  })
  return { home, state, patchPath, forms, configEditor, writes, mutations, input, revision: () => revision, document: () => readFileSync(patchPath, 'utf8') }
}

const alwaysResolves: (id: string) => Promise<void> = async () => {}
const neverResolves: (id: string) => Promise<void> = async (id) => {
  throw Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' })
}

function legacyDocument() {
  return `dsh-pi-tui:
  theme: dark
  iconStyle: symbols
  footer: custom
  displayPreset: compact
  notificationMode: always
  wheelScrollLines: "5"
  progressUpdates: frequent
  responseStyle: concise
agent-presets:
  default: minimal
`
}

function withLegacy(h: ReturnType<typeof harness>, document = legacyDocument()) {
  writeFileSync(join(h.home, 'settings.yaml'), document, 'utf8')
  return h
}

test('a legacy document alone migrates into the canonical row and completes marker 2', async () => {
  const h = withLegacy(harness())
  const report = await migrateProfileTuiPreferences(h.input(alwaysResolves))
  assert.equal(report.status, 'migrated')
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0]!.theme, 'dark')
  assert.equal(h.writes[0]!.displayPreset, 'compact')
  assert.equal(h.writes[0]!.legacySettingsMigrationVersion, 2)
  assert.deepEqual(h.mutations.filter(call => call.ns === 'agent-preset-registry').map(call => call.ops), [
    [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }],
  ])
})

test('a single legacy Direct or Split profile USER value migrates without needing the row ACTIVE', async () => {
  const direct = await migrateProfileTuiPreferences(harness({ direct: { theme: 'dark', responseStyle: 'concise' } }).input())
  assert.equal(direct.status, 'migrated')
  const split = await migrateProfileTuiPreferences(harness({ split: { theme: 'light' } }).input())
  assert.equal(split.status, 'migrated')
})

test('two RAW-equal legacy USER sources migrate once', async () => {
  const h = harness({ direct: { theme: 'dark' }, split: { theme: 'dark' } })
  const report = await migrateProfileTuiPreferences(h.input())
  assert.equal(report.status, 'migrated')
  assert.equal(h.writes[0]!.theme, 'dark')
})

test('two different legacy USER sources are a fail-closed conflict that writes nothing', async () => {
  const h = harness({ direct: { theme: 'dark', footer: 'custom' }, split: { theme: 'light', footer: 'custom' } })
  const before = h.document()
  await assert.rejects(
    () => migrateProfileTuiPreferences(h.input()),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_CONFLICT'
      && error.fields.length === 1 && error.fields[0] === 'theme',
  )
  assert.equal(h.writes.length, 0, 'a conflict must not write a partial canonical row')
  assert.equal(h.document(), before, 'the raw legacy sources stay byte-identical')
})

test('whole-value fields conflict as whole values and are never deep-merged', async () => {
  const h = harness({
    direct: { footerCommand: { schemaVersion: 1, command: 'date', timeoutMs: 1, refreshIntervalMs: 1, maxRows: 1 } },
    split: { footerCommand: { schemaVersion: 1, command: 'uptime', timeoutMs: 1, refreshIntervalMs: 1, maxRows: 1 } },
  })
  await assert.rejects(
    () => migrateProfileTuiPreferences(h.input()),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_CONFLICT'
      && error.fields.includes('footerCommand'),
  )
  assert.equal(h.writes.length, 0)
})

test('an explicit canonical USER field wins; the remaining fields still migrate', async () => {
  const h = harness({
    canonical: { theme: 'light' },
    direct: { theme: 'dark', responseStyle: 'concise' },
  })
  const report = await migrateProfileTuiPreferences(h.input())
  assert.equal(report.status, 'migrated')
  assert.equal(h.writes[0]!.theme, 'light', 'canonical theme wins')
  assert.equal(h.writes[0]!.responseStyle, 'concise', 'an unowned field still migrates')
})

test('no source at all still writes marker 2 (defaults are never pinned)', async () => {
  const h = harness()
  const report = await migrateProfileTuiPreferences(h.input())
  assert.equal(report.status, 'absent')
  assert.deepEqual(h.writes[0], { legacySettingsMigrationVersion: 2 })
})

test('marker 2 is current: no edit and no write', async () => {
  const h = harness({ canonical: { theme: 'dark', legacySettingsMigrationVersion: 2 } })
  const report = await migrateProfileTuiPreferences(h.input())
  assert.equal(report.status, 'current')
  assert.equal(h.writes.length, 0)
})

test('a concurrent migration that completed under the lock is current, not a write', async () => {
  const h = harness({
    beforeChange: (state, patchPath) => {
      state.canonical = { legacySettingsMigrationVersion: 2 }
      writeFileSync(patchPath, rawPatch(state), 'utf8')
    },
  })
  const report = await migrateProfileTuiPreferences(h.input())
  assert.equal(report.status, 'current')
  assert.equal(h.writes.length, 0)
})

test('an invalid/unsafe source fails closed with the source code', async () => {
  await assert.rejects(
    () => migrateProfileTuiPreferences(harness({ direct: { theme: 42 } }).input()),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_SOURCE',
  )
  await assert.rejects(
    () => migrateProfileTuiPreferences(harness({ extraRows: `- id: ${DIRECT}\n  name: 'x'\n  config:\n    theme: !!js env.THEME\n` }).input()),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_SOURCE',
  )
})

test('a malformed historical field is skipped with a diagnostic while the rest migrates', async () => {
  const h = harness()
  writeFileSync(join(h.home, 'settings.yaml'), `dsh-pi-tui:
  theme: dark
  footerLayout: { not: a layout }
`, 'utf8')
  const report = await migrateProfileTuiPreferences(h.input())
  assert.equal(report.status, 'migrated')
  assert.equal(h.writes[0]!.theme, 'dark')
  assert.equal(h.writes[0]!.footerLayout, undefined)
})

test('the legacy focusMode only converges into displayPreset', async () => {
  const h = harness()
  writeFileSync(join(h.home, 'settings.yaml'), 'dsh-pi-tui:\n  focusMode: "on"\n', 'utf8')
  await migrateProfileTuiPreferences(h.input())
  assert.equal(h.writes[0]!.displayPreset, 'focus')
})

test('an invalid legacy preset default is a diagnostic; the official default stays', async () => {
  const h = withLegacy(harness())
  const report = await migrateProfileTuiPreferences(h.input(neverResolves))
  assert.equal(report.status, 'migrated')
  assert.equal(report.presetDefault, undefined)
  assert.equal(h.mutations.some(call => call.ns === 'agent-preset-registry'), false)
})

test('a registry selectedDefault the USER already owns is never rewritten', async () => {
  const h = withLegacy(harness({ registry: { selectedDefault: 'standard' } }))
  await migrateProfileTuiPreferences(h.input(alwaysResolves))
  assert.equal(h.mutations.some(call => call.ns === 'agent-preset-registry'), false)
})

test('a non-canonical package identity is rejected before any write', async () => {
  const h = harness({ entryName: '@xmoon76/dsh-pi-tui', direct: { theme: 'dark' } })
  const before = h.document()
  await assert.rejects(
    () => migrateProfileTuiPreferences(h.input()),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_SOURCE'
      && /expected "@xmoon76\/dsh-pi-tui\/preferences"/u.test(error.message),
  )
  assert.equal(h.writes.length, 0, 'a wrong package identity must never receive the canonical write')
  assert.equal(h.document(), before, 'the profile is untouched')
})

test('a missing Settings surface fails closed while legacy USER values survive', async () => {
  const h = harness({ direct: { theme: 'dark' } })
  const before = h.document()
  await assert.rejects(
    () => migrateProfileTuiPreferences({ ...h.input(), forms: undefined }),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_UNAVAILABLE'
      && /refusing to start with defaults/u.test(error.message),
    'a legacy value must not be silently replaced by canonical defaults',
  )
  assert.equal(h.document(), before, 'the raw legacy source is preserved')
  assert.equal(h.writes.length, 0, 'no canonical write happened')
})

test('a missing Settings surface with no surviving legacy value is a safe unavailable no-op', async () => {
  const h = harness()
  const report = await migrateProfileTuiPreferences({ ...h.input(), forms: undefined })
  assert.deepEqual(report, { status: 'unavailable', reason: 'settings service unavailable' })
  assert.equal(h.writes.length, 0)
})

test('a missing canonical Loader entry fails closed while legacy USER values survive', async () => {
  const h = harness({ direct: { theme: 'dark' } })
  const before = h.document()
  const configEditor = {
    entries: () => [],
    edit: async () => { throw new Error('the canonical edit must never run') },
  } as unknown as ProfileConfigEditorLike
  await assert.rejects(
    () => migrateProfileTuiPreferences({ ...h.input(), configEditor }),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_UNAVAILABLE',
  )
  assert.equal(h.document(), before)
  assert.equal(h.writes.length, 0)
})

test('a refused canonical write is a WRITE failure and does not advance the marker', async () => {
  await assert.rejects(
    () => migrateProfileTuiPreferences(harness({ direct: { theme: 'dark' }, refuseWrite: true }).input()),
    (error: unknown) => error instanceof TuiPreferencesMigrationError
      && error.code === 'TUI_PREFERENCES_MIGRATION_WRITE'
      && /overridden by a home patch or command-line overlay/u.test(error.message),
  )
})

test('retrying after a successful migration is idempotent (current, one write)', async () => {
  const h = withLegacy(harness())
  const first = await migrateProfileTuiPreferences(h.input(alwaysResolves))
  const second = await migrateProfileTuiPreferences(h.input(alwaysResolves))
  assert.equal(first.status, 'migrated')
  assert.equal(second.status, 'current')
  assert.equal(h.writes.length, 1)
})

test('the historical .imported document is read when the live file is gone', async () => {
  const h = harness()
  writeFileSync(join(h.home, 'settings.yaml.imported'), 'dsh-pi-tui:\n  theme: light\n', 'utf8')
  await migrateProfileTuiPreferences(h.input())
  assert.equal(h.writes[0]!.theme, 'light')
})
