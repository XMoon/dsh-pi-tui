/**
 * M6 PR-A — the canonical `pi-tui-preferences` row over the REAL DSH
 * configuration plane.
 *
 * ```text
 * real Loader root Include over a disposable profile + bundle
 *   -> production src/app/config/preferences.ts row (ACTIVE, form hidden)
 *   -> official SettingsForms.mutate / ConfigEditor.edit
 *   -> profile USER cordis.patch.yml write
 *   -> a NEW Host cold boot reads value/user from the SAME profile
 * ```
 *
 * FIXTURE MANIFEST
 * - REAL: the Loader root Include, ConfigEditor, SettingsForms, the production
 *   canonical preference row, the production Direct settings adapter and the
 *   production Host migration.
 * - STAND-INS: none on these paths (the row performs no work).
 * - ABSENT: a model turn, a Remote Client, the real user DSH_HOME and a real
 *   DSH CLI process (the real-process qualification lives in the R0 spike and
 *   the split-process smoke).
 *
 * @module @xmoon76/dsh-pi-tui/test/integration/preferences-profile
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { parse as parseYaml } from 'yaml'
import { DirectTuiSettings, type TuiConfigRefs } from '../../src/runtime/direct/tui-settings-direct.ts'
import {
  migrateProfileTuiPreferences,
  type ProfileConfigEditorLike,
} from '../../src/app/config/profile-preferences-migration.ts'
import {
  mountPreferencesSettingsPlane,
  PREFERENCES_ROW_ID as ROW_ID,
  type PreferencesPlaneOptions,
} from '../support/preferences-plane.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

interface Plane {
  readonly ctx: Context
  readonly profileDir: string
  readonly patchPath: string
  dispose(): Promise<void>
}

/** The official Settings surface as this suite observes it. */
interface RealSettingsForms {
  describe(): readonly {
    ns: string
    value?: unknown
    user?: unknown
    revision?: number
    autoGenerate?: boolean
    schema?: unknown
  }[]
  mutate(
    ns: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    revision?: number,
  ): Promise<unknown>
}

function settingsOf(ctx: Context): RealSettingsForms {
  return (ctx as unknown as { settings: RealSettingsForms }).settings
}

function descriptorOf(ctx: Context) {
  return settingsOf(ctx).describe().find(entry => entry.ns === ROW_ID)
}

async function bootPlane(life: TestLifecycle, root: string, options: PreferencesPlaneOptions = {}): Promise<Plane> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const plane = await mountPreferencesSettingsPlane(ctx, root, options)
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  life.defer(dispose)
  return { ctx, profileDir: plane.profileDir, patchPath: plane.patchPath, dispose }
}

/** The canonical form's schema field names from the schemastery refs JSON. */
function formFields(schema: unknown): readonly string[] {
  const document = schema as { uid?: number; refs?: Record<string, { dict?: Record<string, unknown> }> }
  const root = document.refs?.[String(document.uid)]
  return Object.keys(root?.dict ?? {})
}

test('the canonical row is ACTIVE with a hidden auto page and the complete 21-field schema', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('prefs-default-'))
  const descriptor = descriptorOf(plane.ctx)
  assert.ok(descriptor !== undefined, 'the ACTIVE canonical row must project a Settings section')
  assert.equal(descriptor.autoGenerate, false, 'the row hides its auto-generated page')
  assert.equal(typeof descriptor.revision, 'number', 'the official revision fence is real')
  assert.equal(Object.keys(descriptor.value ?? {}).length, 19,
    'the effective projection carries the 19 always-defaulted fields (two raw fields stay absent)')
  assert.deepEqual(descriptor.user, {}, 'the default profile owns no USER override')
  assert.deepEqual(formFields(descriptor.schema), [
    'theme', 'iconStyle', 'footer', 'footerFallbackMode', 'footerLayout',
    'footerCustomItems', 'footerCommand', 'fullscreen', 'busyEnter',
    'localShellSandbox', 'homeEndKeys', 'displayPreset', 'progressUpdates',
    'gitAttribution', 'responseStyle', 'notificationMode', 'notificationMethod',
    'terminalProgress', 'wheelScrollLines', 'keybindings',
    'legacySettingsMigrationVersion',
  ], 'the form exposes the 20 preferences plus the internal marker')
  assert.equal((plane.ctx as unknown as { piTuiPreferences?: unknown }).piTuiPreferences !== undefined, true,
    'the row publishes the canonical service')
})

test('a revision-checked mutate persists the USER patch and a cold boot reads it', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('prefs-persist-')
  const first = await bootPlane(life, root, { resetUserDocument: true })
  const before = descriptorOf(first.ctx)
  assert.ok(before !== undefined)
  await settingsOf(first.ctx).mutate(ROW_ID, [{ op: 'set', path: ['theme'], value: 'dark' }], before.revision)
  const after = descriptorOf(first.ctx)
  assert.equal((after?.value as { theme?: string }).theme, 'dark', 'the effective value commits live')
  assert.equal((after?.user as { theme?: string }).theme, 'dark', 'the USER layer owns the value')

  const document = parseYaml(readFileSync(first.patchPath, 'utf8')) as Array<Record<string, unknown>>
  const row = document.find(candidate => candidate.id === ROW_ID)
  assert.ok(row !== undefined, 'the profile patch carries the canonical USER row')
  assert.equal(Object.hasOwn(row, 'insert'), false, 'the persisted row is an ordinary USER row')
  assert.deepEqual((row.config as { theme?: string }).theme, 'dark')

  await first.dispose()
  const second = await bootPlane(life, root)
  const cold = descriptorOf(second.ctx)
  assert.equal((cold?.user as { theme?: string }).theme, 'dark', 'a NEW Host cold-boots the persisted value')
  assert.equal((cold?.value as { theme?: string }).theme, 'dark')
})

test('the Direct adapter writes the canonical row through path-scoped revision-fenced ops', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('prefs-direct-'), { resetUserDocument: true })
  const adapter = new DirectTuiSettings(
    (plane.ctx as unknown as { piTuiPreferences: TuiConfigRefs }).piTuiPreferences,
    settingsOf(plane.ctx),
  )
  await adapter.replace({ ...adapter.get(), terminalProgress: 'off' })
  const after = descriptorOf(plane.ctx)
  assert.equal((after?.user as { terminalProgress?: string }).terminalProgress, 'off',
    'only the changed field is pinned into the USER layer')
  assert.deepEqual(Object.keys(after?.user ?? {}), ['terminalProgress'],
    'the replace never promotes inherited/default values into the profile')
  assert.equal(adapter.get().terminalProgress, 'off', 'the live reference reflects the commit')
})

test('a row disabled by composition is honestly absent and refuses writes', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('prefs-disabled-')
  // The fixture layout is written once; create it disabled.
  const ctx = new Context()
  await ctx.plugin(Loader)
  const plane = await mountPreferencesSettingsPlane(ctx, root, { disabledRow: true })
  life.defer(() => ctx.fiber.dispose())
  assert.equal(descriptorOf(ctx), undefined, 'a non-ACTIVE row contributes no writable Settings section')
  await assert.rejects(
    () => settingsOf(ctx).mutate(ROW_ID, [{ op: 'set', path: ['theme'], value: 'dark' }], undefined),
    /No configurable plugin entry/u,
  )
  assert.equal((ctx as unknown as { piTuiPreferences?: unknown }).piTuiPreferences, undefined,
    'no canonical service is published by a disabled row')
  assert.equal(readFileSync(plane.patchPath, 'utf8'), '[]\n', 'the refused write never touches the profile')
})

test('a command-line overlay override is refused by the official ConfigEditor and leaves the profile byte-identical', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('prefs-override-')
  const plane = await bootPlane(life, root, {
    resetUserDocument: true,
    overlay: [{ id: ROW_ID, config: { theme: 'light' } }],
  })
  const before = descriptorOf(plane.ctx)
  assert.ok(before !== undefined)
  const bytes = readFileSync(plane.patchPath)
  await assert.rejects(
    () => settingsOf(plane.ctx).mutate(ROW_ID, [{ op: 'set', path: ['theme'], value: 'dark' }], before.revision),
    /overridden by a home patch or command-line overlay/u,
  )
  assert.ok(readFileSync(plane.patchPath).equals(bytes), 'the refused write leaves the profile unchanged')
})

test('the Host migration writes the canonical USER row under the real profile lock and leaves legacy rows untouched', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('prefs-migration-')
  const legacyRow = {
    id: 'tui-app',
    name: '@xmoon76/dsh-pi-tui',
    config: { sessionId: '', theme: 'dark', responseStyle: 'concise' },
  }
  const plane = await bootPlane(life, root, { resetUserDocument: true, userRows: [legacyRow] })
  const settings = settingsOf(plane.ctx)
  const report = await migrateProfileTuiPreferences({
    patchPath: plane.patchPath,
    configEditor: (plane.ctx as unknown as { configEditor: ProfileConfigEditorLike }).configEditor,
    forms: settings,
    home: root,
    resolvePreset: async () => {},
    diag: { warn: () => {}, info: () => {} },
  })
  assert.equal(report.status, 'migrated')
  const canonical = descriptorOf(plane.ctx)
  assert.deepEqual(canonical?.user, {
    theme: 'dark', responseStyle: 'concise', legacySettingsMigrationVersion: 2,
  }, 'the canonical row carries every migrated explicit value plus marker 2')
  const document = parseYaml(readFileSync(plane.patchPath, 'utf8')) as Array<Record<string, unknown>>
  assert.deepEqual(document.find(row => row.id === 'tui-app'), legacyRow,
    'the retired Direct row is preserved byte-for-byte for downgrade/diagnosis')
  assert.ok(document.some(row => row.id === ROW_ID), 'the canonical USER row is committed')

  const retry = await migrateProfileTuiPreferences({
    patchPath: plane.patchPath,
    configEditor: (plane.ctx as unknown as { configEditor: ProfileConfigEditorLike }).configEditor,
    forms: settings,
    home: root,
    resolvePreset: async () => {},
    diag: { warn: () => {}, info: () => {} },
  })
  assert.equal(retry.status, 'current', 'marker 2 makes a retry a pure read')
})

test('a conflicting legacy Direct/Split pair fails closed and never writes the canonical row', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('prefs-conflict-')
  const plane = await bootPlane(life, root, {
    resetUserDocument: true,
    userRows: [
      { id: 'tui-app', name: '@xmoon76/dsh-pi-tui', config: { theme: 'dark' } },
      { id: 'split-host-pi-tui-runtime', name: '@xmoon76/dsh-pi-tui/host-runtime', config: { theme: 'light' } },
    ],
  })
  const bytes = readFileSync(plane.patchPath)
  await assert.rejects(
    () => migrateProfileTuiPreferences({
      patchPath: plane.patchPath,
      configEditor: (plane.ctx as unknown as { configEditor: ProfileConfigEditorLike }).configEditor,
      forms: settingsOf(plane.ctx),
      home: root,
      resolvePreset: async () => {},
      diag: { warn: () => {}, info: () => {} },
    }),
    /legacy TUI preference sources disagree for: theme/u,
  )
  assert.ok(readFileSync(plane.patchPath).equals(bytes),
    'the fail-closed conflict leaves both raw legacy sources untouched and writes no marker')
})

test('an unsafe !!js scalar in a legacy profile source is rejected, never evaluated', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('prefs-js-')
  const ctx = new Context()
  await ctx.plugin(Loader)
  const plane = await mountPreferencesSettingsPlane(ctx, root, { resetUserDocument: true })
  life.defer(() => ctx.fiber.dispose())
  writeFileSync(plane.patchPath, [
    `- id: ${ROW_ID}`,
    "  name: '@xmoon76/dsh-pi-tui/preferences'",
    '- id: tui-app',
    "  name: '@xmoon76/dsh-pi-tui'",
    '  config:',
    '    theme: !!js env.THEME',
    '',
  ].join('\n'))
  await assert.rejects(
    () => migrateProfileTuiPreferences({
      patchPath: plane.patchPath,
      configEditor: (ctx as unknown as { configEditor: ProfileConfigEditorLike }).configEditor,
      forms: settingsOf(ctx),
      home: root,
      resolvePreset: async () => {},
      diag: { warn: () => {}, info: () => {} },
    }),
    /carries a !!js expression/u,
  )
  assert.match(readFileSync(plane.patchPath, 'utf8'), /!!js env\.THEME/u,
    'the raw source is never rewritten')
})

test('the production bundle declares the canonical row exactly once', () => {
  const bundle = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  const entries = parseYaml(bundle) as Array<{ insert?: Array<{ id?: string }>; id?: string }>
  const rows = entries.flatMap(entry => entry.insert ?? [entry])
  assert.equal(rows.filter(row => row.id === ROW_ID).length, 1,
    'the canonical row is declared exactly once in the bundle patch')
  assert.match(bundle, /id: pi-tui-preferences\n      name: '@xmoon76\/dsh-pi-tui\/preferences'\n      disabled: !!js/u,
    'the row is config-only and disabled solely in the daemon supervisor')
})
