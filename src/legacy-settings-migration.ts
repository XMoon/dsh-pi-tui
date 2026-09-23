/**
 * One-shot legacy persisted-data migration (DSH 0.1.7 PR A §8): carries the
 * retired `$DSH_HOME/settings.yaml` sections into the profile-owned
 * configuration the 0.1.7 runtime actually reads:
 *
 * - the TUI's historical `dsh-pi-tui` section → the `tui-app` plugin's
 *   volatile Config fields (Settings form `tui-app`);
 * - the historical `agent-presets.default` → the registry's
 *   `agent-preset-registry.selectedDefault` user preference.
 *
 * Contract highlights:
 * - READ ONLY on the legacy file: the upstream 0.1.7 Settings importer may
 *   already have renamed `settings.yaml` to `settings.yaml.imported`, so the
 *   reader prefers the live file and falls back to the renamed backup; it
 *   NEVER renames, rewrites, deletes or truncates either.
 * - the internal `legacySettingsMigrationVersion` marker (a volatile field
 *   of the `tui-app` Config) advances to 1 only after the OWNED writes
 *   settle, so a later restart cannot re-apply old preferences over newer
 *   user values; a failed migration stays visible and retriable.
 * - the legacy preset default is validated through the CURRENT registry
 *   (`resolve(id)`) — no `code → ptc` alias and no guessed replacement:
 *   an id no declaration supplies is an invalid legacy preference that
 *   leaves `selectedDefault` untouched and keeps the official default.
 * - every write goes through the official SettingsForms surface with the
 *   descriptor revision read immediately before it; conflicts and refused
 *   writes surface as diagnostics instead of being swallowed.
 *
 * `focusMode` exists here ONLY as a legacy input: it converges into
 * `displayPreset` (canonical valid → copy, else focusMode 'on' → focus,
 * else full) and is never carried as a canonical field.
 * @module @xmoon76/dsh-pi-tui/legacy-settings-migration
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { resolveDisplayPreset, type PersistedDisplayInput } from './display-preset.ts'
import { appendHistoryLine, historyFilePath } from './history.ts'
import type { SettingsFormsLike, TuiSettingsPathOp } from './runtime/direct/tui-settings-direct.ts'

/** The migration version this build completes. */
const LEGACY_SETTINGS_MIGRATION_VERSION = 1

/** The narrow diagnostics sink the migration reports through. */
export interface MigrationDiagLike {
  warn(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
}

/** The registry validation seam for the legacy preset default: resolves
 * against the CURRENT declarations (no alias, no fallback). */
export type LegacyPresetResolver = (id: string) => Promise<void>

/** Everything the one-shot migration needs, injected by the runner. */
export interface LegacySettingsMigrationInput {
  /** The harness home that held the retired settings.yaml. */
  readonly home: string
  /** The official SettingsForms write surface. */
  readonly forms: SettingsFormsLike | undefined
  /** The CURRENT-registry preset validation seam. */
  readonly resolvePreset: LegacyPresetResolver
  /** The marker read (the `tui-app` Config's volatile field). */
  readonly migrationMarker: { get(): number }
  readonly diag: MigrationDiagLike
}

/** The migration outcome, for tests and diagnostics. */
export type LegacySettingsMigrationReport =
  | { readonly status: 'current' }
  | { readonly status: 'absent' }
  | { readonly status: 'migrated'; readonly fields: readonly string[]; readonly presetDefault?: string }
  | { readonly status: 'failed'; readonly reason: string }

/** String preference fields copied verbatim from the legacy section (the
 * consumers' parsers stay the fail-soft authority on every value). */
const COPIED_STRING_FIELDS: readonly string[] = [
  'theme',
  'iconStyle',
  'footer',
  'footerFallbackMode',
  'fullscreen',
  'busyEnter',
  'localShellSandbox',
  'homeEndKeys',
  'notificationMode',
  'notificationMethod',
  'wheelScrollLines',
  'progressUpdates',
  'responseStyle',
]

/** Whole-value fields copied verbatim (raw data — unknown/future entries
 * must survive the migration untouched). */
const COPIED_RAW_FIELDS: readonly string[] = [
  'footerLayout',
  'footerCustomItems',
  'footerCommand',
  'keybindings',
]

/** Read the retired legacy document: prefer the live `settings.yaml`; when
 * the upstream importer's rename wins the race, retry the `.imported`
 * backup. Returns undefined when neither file exists. */
async function readLegacyDocument(home: string): Promise<string | undefined> {
  const live = join(home, 'settings.yaml')
  if (existsSync(live)) return readFile(live, 'utf8')
  const imported = `${live}.imported`
  if (existsSync(imported)) return readFile(imported, 'utf8')
  return undefined
}

/** Carry the legacy per-cwd input history (which used to live inside the
 * retired settings section) into the $DSH_HOME/user-history/*.jsonl files
 * — never back into Config. Idempotent per cwd: an existing file means
 * that cwd already migrated (a crash mid-write leaves the file in place,
 * so the next boot resumes from the unwritten cwds). */
function migrateLegacyHistory(home: string, section: Record<string, unknown> | undefined): void {
  const history = section?.history
  if (history === null || typeof history !== 'object' || Array.isArray(history)) return
  for (const [cwd, entries] of Object.entries(history as Record<string, unknown>)) {
    if (!Array.isArray(entries) || entries.length === 0) continue
    const file = historyFilePath(home, cwd)
    if (existsSync(file)) continue
    // File order is oldest-first; the stored arrays are newest-first.
    for (const entry of entries.slice().reverse()) {
      if (typeof entry !== 'string') continue
      try { appendHistoryLine(file, entry, undefined) } catch { /* best effort */ }
    }
  }
}

/** One plain-object section of the legacy document, or undefined. */
function legacySection(document: unknown, section: string): Record<string, unknown> | undefined {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const value = (document as Record<string, unknown>)[section]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Derive the `tui-app` field ops from the legacy `dsh-pi-tui` section.
 * Field-level fail-soft: a malformed optional field never blocks the rest
 * (the runtime parsers own validation). An absent section produces no ops —
 * the schema defaults already express the same effective values, and the
 * profile override must not pin them. */
function tuiAppOps(section: Record<string, unknown> | undefined): TuiSettingsPathOp[] {
  if (section === undefined) return []
  const ops: TuiSettingsPathOp[] = []
  for (const field of COPIED_STRING_FIELDS) {
    const value = section[field]
    if (typeof value === 'string') ops.push({ op: 'set', path: [field], value })
  }
  for (const field of COPIED_RAW_FIELDS) {
    const value = section[field]
    if (value !== undefined) ops.push({ op: 'set', path: [field], value })
  }
  // The display convergence runs only when the legacy document carried a
  // display opinion: a valid canonical value is copied verbatim, an invalid
  // one converges through the legacy focusMode rule, and a section with
  // neither field leaves the schema default ('full') unpinned.
  if (section.displayPreset !== undefined || section.focusMode !== undefined) {
    const display = resolveDisplayPreset({
      displayPreset: typeof section.displayPreset === 'string' ? section.displayPreset : undefined,
      focusMode: typeof section.focusMode === 'string' ? section.focusMode : undefined,
    } satisfies PersistedDisplayInput)
    ops.push({ op: 'set', path: ['displayPreset'], value: display.preset })
  }
  return ops
}

/**
 * Run the one-shot legacy migration. The caller OWNS the ordering barrier
 * (PR A §8.4): this must settle before display/progress/response/
 * notification startup state is resolved and before any Agent is
 * composed or resumed.
 */
export async function migrateLegacySettings(input: LegacySettingsMigrationInput): Promise<LegacySettingsMigrationReport> {
  const { forms, diag } = input
  if (input.migrationMarker.get() >= LEGACY_SETTINGS_MIGRATION_VERSION) return { status: 'current' }
  if (forms === undefined) {
    // Without the official write surface nothing can migrate; the marker
    // must NOT advance, so a later boot with the surface retries.
    diag.warn('legacy settings migration unavailable: settings service missing', {})
    return { status: 'failed', reason: 'settings service unavailable' }
  }
  const legacyText = await readLegacyDocument(input.home)
  if (legacyText === undefined) {
    // Nothing to import anywhere: complete the marker so the retired file
    // a later downgrade recreates cannot override newer values. A refused
    // marker write is VISIBLE and retried on the next boot (the marker is
    // the only thing this path owns).
    try {
      await completeMarker(forms)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      diag.warn('legacy settings marker write failed; will retry on next start', { reason })
      return { status: 'failed', reason: `marker write failed: ${reason}` }
    }
    return { status: 'absent' }
  }
  let document: unknown
  try {
    document = parse(legacyText)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    diag.warn('legacy settings document is malformed; migration will retry on next start', { reason })
    return { status: 'failed', reason: `malformed legacy settings document: ${reason}` }
  }
  const tuiSection = legacySection(document, 'dsh-pi-tui')
  // The per-cwd input history rides along (JSONL files only — never Config).
  migrateLegacyHistory(input.home, tuiSection)
  // The legacy preset default migrates FIRST (its own namespace): a failure
  // here aborts before the marker advances, and both writes are idempotent,
  // so a retry re-applies the same values.
  const presetSection = legacySection(document, 'agent-presets')
  let presetDefault: string | undefined
  if (typeof presetSection?.default === 'string' && presetSection.default !== '') {
    const id = presetSection.default
    try {
      await input.resolvePreset(id)
      presetDefault = id
    } catch (error) {
      // Invalid/obsolete legacy preference: diagnostic, no guessed
      // replacement, the official current default stays effective.
      diag.warn('legacy agent preset default is invalid or unavailable; keeping the official default', {
        preset: id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (presetDefault !== undefined) {
    const revision = forms.describe()?.find(entry => entry.ns === 'agent-preset-registry')?.revision
    try {
      await forms.mutate('agent-preset-registry', [
        { op: 'set', path: ['selectedDefault'], value: presetDefault },
      ], revision)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      diag.warn('legacy agent preset default migration failed; will retry on next start', { reason })
      return { status: 'failed', reason: `agent-preset-registry.selectedDefault write failed: ${reason}` }
    }
  }
  // The TUI preference batch (plus the marker) is the completing write.
  const ops = tuiAppOps(tuiSection)
  ops.push({ op: 'set', path: ['legacySettingsMigrationVersion'], value: LEGACY_SETTINGS_MIGRATION_VERSION })
  try {
    const revision = forms.describe()?.find(entry => entry.ns === 'tui-app')?.revision
    await forms.mutate('tui-app', ops, revision)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    diag.warn('legacy TUI settings migration failed; will retry on next start', { reason })
    return { status: 'failed', reason: `tui-app migration write failed: ${reason}` }
  }
  const migratedFields = ops.map(op => op.path.join('.'))
  diag.info('legacy settings migrated', { fields: migratedFields, ...presetDefault === undefined ? {} : { presetDefault } })
  return {
    status: 'migrated',
    fields: migratedFields,
    ...presetDefault === undefined ? {} : { presetDefault },
  }
}

/** Advance the marker alone (no legacy document anywhere). Throws on a
 * refused write — the caller reports the failure so the next boot retries. */
async function completeMarker(forms: SettingsFormsLike): Promise<void> {
  const revision = forms.describe()?.find(entry => entry.ns === 'tui-app')?.revision
  await forms.mutate('tui-app', [
    { op: 'set', path: ['legacySettingsMigrationVersion'], value: LEGACY_SETTINGS_MIGRATION_VERSION },
  ], revision)
}
