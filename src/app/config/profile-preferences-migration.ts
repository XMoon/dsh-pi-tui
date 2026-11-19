/**
 * The Host-owned migration of the persisted TUI preferences into the
 * canonical `pi-tui-preferences` profile row (M6 PR-A).
 *
 * Sources, in precedence order, for every one of the 20 canonical fields:
 *
 * 1. the canonical profile USER field, when it is explicitly present;
 * 2. the legacy Direct (`tui-app`) or Split Host
 *    (`split-host-pi-tui-runtime`) profile USER field — a single source wins,
 *    two RAW-equal sources migrate once, two different sources are a
 *    fail-closed conflict;
 * 3. the retired `$DSH_HOME/settings.yaml(.imported)` document (read-only,
 *    historical opinion is lower than any explicit profile USER value);
 * 4. otherwise the field stays inherited (its schema default is NOT pinned
 *    into the profile).
 *
 * When every source is readable and consistent, ONE official
 * `ConfigEditor.edit(canonicalEntry, change)` transaction writes the migrated
 * fields plus `legacySettingsMigrationVersion: 2`. The callback re-reads the
 * raw profile patch INSIDE the official profile file lock, so a concurrent
 * settings write (including the official `settings.yaml` importer) cannot be
 * overwritten by a stale snapshot. Nothing else is written: the old profile
 * rows and the `.imported` document stay untouched for downgrade/diagnosis.
 *
 * The migrator is Host-owned. A Split Client never reads the Host Profile and
 * never triggers it.
 *
 * @module @xmoon76/dsh-pi-tui/app/config/profile-preferences-migration
 */

import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseYaml } from 'yaml'
import { PREFERENCE_FIELD_NAMES, PreferencesConfig } from './schema.ts'
import {
  legacyPreferenceValues,
  legacyPresetDefault,
  legacySection,
  readLegacyDocument,
  type LegacyPresetResolver,
  type MigrationDiagLike,
} from './legacy-settings-migration.ts'
import type { SettingsFormsLike } from '../../runtime/config-port.ts'

/** The canonical Loader row id / Settings namespace. */
export const TUI_PREFERENCES_NAMESPACE = 'pi-tui-preferences'
/** The retired Direct profile row (read only, migration source). */
export const LEGACY_DIRECT_NAMESPACE = 'tui-app'
/** The retired Split Host profile row (read only, migration source). */
export const LEGACY_SPLIT_NAMESPACE = 'split-host-pi-tui-runtime'
/** The marker value this migration completes. */
export const TUI_PREFERENCES_MIGRATION_VERSION = 2

/** The stable failure codes a caller/diagnostic may report. */
export type TuiPreferencesMigrationCode =
  | 'TUI_PREFERENCES_MIGRATION_SOURCE'
  | 'TUI_PREFERENCES_MIGRATION_CONFLICT'
  | 'TUI_PREFERENCES_MIGRATION_WRITE'

/** A fail-closed migration failure: the marker is NOT advanced and the raw
 * sources are left untouched. Diagnostics carry codes, profile ownership and
 * FIELD NAMES only — never command bodies, custom values or secrets. */
export class TuiPreferencesMigrationError extends Error {
  readonly code: TuiPreferencesMigrationCode
  readonly fields: readonly string[]

  constructor(code: TuiPreferencesMigrationCode, message: string, fields: readonly string[] = []) {
    super(message)
    this.name = 'TuiPreferencesMigrationError'
    this.code = code
    this.fields = fields
  }
}

/** The narrow structural ConfigEditor port (the real service is injected from
 * the Host context; this module owns no official package dependency). */
export interface ProfileConfigEditorEntryLike {
  readonly options: {
    readonly id: string
    readonly name?: string
    readonly config?: Record<string, unknown>
  }
}

export interface ProfileConfigEditorLike {
  entries(): readonly ProfileConfigEditorEntryLike[]
  edit(
    entry: ProfileConfigEditorEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** Everything the one-shot Host migration needs, injected by its caller. */
export interface ProfilePreferencesMigrationInput {
  /** The active profile's USER patch file (`profileContext.patchPath`). */
  readonly patchPath: string
  /** The official profile config editor, or undefined in a deployment that
   * has no profile persistence surface at all. */
  readonly configEditor: ProfileConfigEditorLike | undefined
  /** The official Settings write surface. */
  readonly forms: SettingsFormsLike | undefined
  /** The DSH home that held the retired settings.yaml. */
  readonly home: string
  readonly resolvePreset: LegacyPresetResolver
  readonly diag: MigrationDiagLike
}

/** The migration outcome. A real failure throws instead (fail closed). */
export type ProfilePreferencesMigrationReport =
  | { readonly status: 'current' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'absent'; readonly fields: readonly string[] }
  | { readonly status: 'migrated'; readonly fields: readonly string[]; readonly presetDefault?: string }

/** Sentinel: a concurrent Host already completed this migration. */
class MigrationAlreadyCurrent extends Error {}

const JS_TAG = 'tag:yaml.org,2002:js'

/** The schemastery schema's callable validation form (the schema object is
 * invoked directly; the declared Config type is the OUTPUT, not the input). */
const validatePreferences = PreferencesConfig as unknown as (value: unknown) => unknown

/** Reject any `!!js` expression inside a profile USER value: a macro is not a
 * trusted user scalar, and must never be evaluated or copied as one. */
function assertNoJsExpression(value: unknown, source: string, fields: readonly string[]): void {
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false
    if (!Array.isArray(node)) {
      const record = node as Record<string, unknown>
      if (typeof record.__jsExpr === 'string') return true
      return Object.values(record).some(visit)
    }
    return node.some(visit)
  }
  if (visit(value)) {
    throw new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_SOURCE',
      `profile row "${source}" carries a !!js expression, which is not a trusted USER value`,
      fields,
    )
  }
}

/** One plain-object USER config of a named profile row (last declaration wins,
 * exactly like the official `findLast` override rule). */
function rawUserConfigs(text: string): Map<string, Record<string, unknown>> {
  let document: unknown
  try {
    document = parseYaml(text, {
      customTags: [{ tag: JS_TAG, resolve: (value: string) => ({ __jsExpr: value }) }],
    })
  } catch (error) {
    throw new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_SOURCE',
      `profile patch is not readable YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const rows = document === null ? [] : document
  if (!Array.isArray(rows)) {
    throw new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_SOURCE',
      'profile patch must be a YAML sequence',
    )
  }
  const configs = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    if (Object.hasOwn(record, 'insert')) continue
    const id = record.id
    if (typeof id !== 'string') continue
    const config = record.config
    if (config === undefined) {
      if (configs.has(id) && configs.get(id) !== undefined) continue
      configs.set(id, {})
      continue
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new TuiPreferencesMigrationError(
        'TUI_PREFERENCES_MIGRATION_SOURCE',
        `profile row "${id}" has a non-object config`,
        [id],
      )
    }
    configs.set(id, config as Record<string, unknown>)
  }
  for (const id of [TUI_PREFERENCES_NAMESPACE, LEGACY_DIRECT_NAMESPACE, LEGACY_SPLIT_NAMESPACE]) {
    const config = configs.get(id)
    if (config !== undefined) assertNoJsExpression(config, id, [])
  }
  return configs
}

/** The explicit migration marker of one raw USER section (absent/invalid = 0). */
function markerOf(config: Record<string, unknown> | undefined): number {
  const value = config?.legacySettingsMigrationVersion
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** The fields a Settings form's USER override currently owns. */
function ownedFields(user: unknown): ReadonlySet<string> {
  if (user === null || typeof user !== 'object' || Array.isArray(user)) return new Set()
  return new Set(Object.keys(user as Record<string, unknown>))
}

/** The migration decisions derived from all sources for one canonical write. */
interface MigrationPlan {
  readonly migrated: Record<string, unknown>
  readonly fields: readonly string[]
  readonly presetDefault?: string
}

/**
 * Run the Host-owned migration barrier.
 *
 * Callers MUST await this before the first TUI/Agent/Host-business read of
 * the canonical preferences: Direct in `app/bootstrap.ts` (before display
 * resolution / agent compose), the Split Host entry after the profile settled
 * and before Web/ACP startup preferences and Ready.
 */
export async function migrateProfileTuiPreferences(
  input: ProfilePreferencesMigrationInput,
): Promise<ProfilePreferencesMigrationReport> {
  const { forms, configEditor, diag } = input
  if (forms === undefined || configEditor === undefined) {
    const reason = forms === undefined ? 'settings service unavailable' : 'config editor unavailable'
    diag.warn('canonical TUI preference migration unavailable; will retry on next start', { reason })
    return { status: 'unavailable', reason }
  }
  // The canonical row must be a Loader-managed profile entry for the official
  // edit to be possible. A deployment that mounts the live references WITHOUT
  // the row (an embedded/test composition, never a real installed profile —
  // the `tui-app`/Host Runtime inject would keep those from starting) has no
  // persistence surface at all: report it as unavailable and retry later
  // instead of pretending a marker write happened.
  const entry = configEditor.entries().find(candidate => candidate.options.id === TUI_PREFERENCES_NAMESPACE)
  if (entry === undefined) {
    diag.warn('canonical TUI preference migration unavailable; will retry on next start', {
      reason: `no "${TUI_PREFERENCES_NAMESPACE}" Loader entry in this composition`,
    })
    return { status: 'unavailable', reason: 'canonical preferences row is not Loader-managed' }
  }
  const canonical = forms.describe()?.find(descriptor => descriptor.ns === TUI_PREFERENCES_NAMESPACE)
  if (canonical === undefined) {
    throw new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_SOURCE',
      `the active profile projects no "${TUI_PREFERENCES_NAMESPACE}" settings row`,
    )
  }
  if (markerOf(canonical.user as Record<string, unknown> | undefined) >= TUI_PREFERENCES_MIGRATION_VERSION) {
    return { status: 'current' }
  }

  // The retired settings.yaml(.imported) document: field-level normalization
  // and fail-soft are the existing helpers' contract. A read/parse failure is
  // visible and retriable; the marker must not advance.
  let legacyValues: Record<string, unknown> = {}
  let presetDefault: string | undefined
  let legacyText: string | undefined
  try {
    legacyText = await readLegacyDocument(input.home)
  } catch (error) {
    throw new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_SOURCE',
      `legacy settings document read failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (legacyText !== undefined) {
    let document: unknown
    try {
      document = parseYaml(legacyText)
    } catch (error) {
      throw new TuiPreferencesMigrationError(
        'TUI_PREFERENCES_MIGRATION_SOURCE',
        `legacy settings document is malformed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    legacyValues = legacyPreferenceValues(legacySection(document, 'dsh-pi-tui'), diag)
    presetDefault = legacyPresetDefault(document)
  }

  // The legacy preset default goes FIRST (its own namespace): a failure here
  // aborts before the marker advances, and both writes are idempotent, so a
  // retry re-applies the same values. A current-registry validation failure is
  // a diagnostic (the official default stays effective), never a guessed id.
  let migratedPreset: string | undefined
  if (presetDefault !== undefined) {
    try {
      await input.resolvePreset(presetDefault)
      migratedPreset = presetDefault
    } catch (error) {
      diag.warn('legacy agent preset default is invalid or unavailable; keeping the official default', {
        preset: presetDefault,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (migratedPreset !== undefined) {
    const registry = forms.describe()?.find(descriptor => descriptor.ns === 'agent-preset-registry')
    if (!ownedFields(registry?.user).has('selectedDefault')) {
      try {
        await forms.mutate('agent-preset-registry', [
          { op: 'set', path: ['selectedDefault'], value: migratedPreset },
        ], registry?.revision)
      } catch (error) {
        throw new TuiPreferencesMigrationError(
          'TUI_PREFERENCES_MIGRATION_WRITE',
          `agent-preset-registry.selectedDefault write failed: ${error instanceof Error ? error.message : String(error)}`,
          ['agent-preset-registry.selectedDefault'],
        )
      }
    }
  }

  let plan: MigrationPlan | undefined
  try {
    await configEditor.edit(entry, (current, _inherited) => {
      // The official ConfigEditor runs this callback INSIDE the profile file
      // lock: re-read the raw USER sources here so a concurrent write observed
      // after the pre-check cannot be overwritten with a stale snapshot.
      const sources = rawUserConfigs(readFileSync(input.patchPath, 'utf8'))
      const canonicalRaw = sources.get(TUI_PREFERENCES_NAMESPACE) ?? {}
      if (markerOf(canonicalRaw) >= TUI_PREFERENCES_MIGRATION_VERSION) throw new MigrationAlreadyCurrent()
      const directRaw = sources.get(LEGACY_DIRECT_NAMESPACE) ?? {}
      const splitRaw = sources.get(LEGACY_SPLIT_NAMESPACE) ?? {}
      const migrated: Record<string, unknown> = {}
      const conflicts: string[] = []
      for (const field of PREFERENCE_FIELD_NAMES) {
        if (Object.hasOwn(canonicalRaw, field)) continue
        const hasDirect = Object.hasOwn(directRaw, field)
        const hasSplit = Object.hasOwn(splitRaw, field)
        if (hasDirect && hasSplit) {
          if (isDeepStrictEqual(directRaw[field], splitRaw[field])) migrated[field] = directRaw[field]
          else conflicts.push(field)
          continue
        }
        if (hasDirect) {
          migrated[field] = directRaw[field]
          continue
        }
        if (hasSplit) {
          migrated[field] = splitRaw[field]
          continue
        }
        if (Object.hasOwn(legacyValues, field)) migrated[field] = legacyValues[field]
      }
      if (conflicts.length > 0) {
        throw new TuiPreferencesMigrationError(
          'TUI_PREFERENCES_MIGRATION_CONFLICT',
          `legacy TUI preference sources disagree for: ${conflicts.join(', ')}. Set the canonical "${TUI_PREFERENCES_NAMESPACE}" USER field explicitly to resolve it.`,
          conflicts,
        )
      }
      const next: Record<string, unknown> = {
        ...canonicalRaw,
        ...migrated,
        legacySettingsMigrationVersion: TUI_PREFERENCES_MIGRATION_VERSION,
      }
      // Validate the WHOLE candidate through the canonical schema before the
      // official write; an invalid legacy value fails closed with the field
      // path in the message, never a silent skip.
      try {
        validatePreferences(next)
      } catch (error) {
        throw new TuiPreferencesMigrationError(
          'TUI_PREFERENCES_MIGRATION_SOURCE',
          `legacy TUI preference value is invalid: ${error instanceof Error ? error.message : String(error)}`,
          Object.keys(migrated),
        )
      }
      plan = {
        migrated,
        fields: [...Object.keys(migrated), 'legacySettingsMigrationVersion'],
        ...(migratedPreset === undefined ? {} : { presetDefault: migratedPreset }),
      }
      return next
    })
  } catch (error) {
    if (error instanceof MigrationAlreadyCurrent) return { status: 'current' }
    if (error instanceof TuiPreferencesMigrationError) {
      diag.warn('canonical TUI preference migration failed; will retry on next start', {
        code: error.code,
        fields: error.fields,
        reason: error.message,
      })
      throw error
    }
    const wrapped = new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_WRITE',
      `canonical "${TUI_PREFERENCES_NAMESPACE}" write failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    diag.warn('canonical TUI preference migration failed; will retry on next start', {
      code: wrapped.code,
      reason: wrapped.message,
    })
    throw wrapped
  }
  if (plan === undefined) {
    throw new TuiPreferencesMigrationError(
      'TUI_PREFERENCES_MIGRATION_WRITE',
      'the canonical preferences edit settled without a migration plan',
    )
  }
  diag.info('canonical TUI preferences migrated', {
    fields: plan.fields,
    ...(plan.presetDefault === undefined ? {} : { presetDefault: plan.presetDefault }),
  })
  if (plan.fields.length === 1) return { status: 'absent', fields: plan.fields }
  return {
    status: 'migrated',
    fields: plan.fields,
    ...(plan.presetDefault === undefined ? {} : { presetDefault: plan.presetDefault }),
  }
}
