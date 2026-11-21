/**
 * Legacy persisted-data readers shared by the Host-owned TUI preference
 * migration (DSH 0.1.7 PR A): the retired `$DSH_HOME/settings.yaml` document
 * and the historical `agent-presets.default` preference.
 *
 * This module owns ONLY the legacy parsing/normalization helpers. The
 * profile-level precedence, conflict handling, write transaction and marker
 * live in `profile-preferences-migration.ts`; the canonical
 * `pi-tui-preferences` row is the sole runtime authority.
 *
 * Contract highlights:
 * - READ ONLY on the legacy file: the upstream Settings importer may already
 *   have renamed `settings.yaml` to `settings.yaml.imported`, so the reader
 *   prefers the live file and falls back to the renamed backup; it NEVER
 *   renames, rewrites, deletes or truncates either.
 * - field-level fail-soft: a malformed optional field never blocks the rest
 *   (the runtime parsers own validation), while the caller keeps the original
 *   sources untouched.
 * - `focusMode` exists here ONLY as a legacy input: it converges into
 *   `displayPreset` (canonical valid → copy, else focusMode 'on' → focus,
 *   else full) and is never carried as a canonical field.
 *
 * @module @xmoon76/dsh-pi-tui/app/config/legacy-settings-migration
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDisplayPreset, type PersistedDisplayInput } from '../../domain/display/preset.ts'
import { parseFooterCommandConfig } from '../../domain/footer/command-trust.ts'
import { isFooterLayout, parseFooterLayout } from '../../domain/footer/layout.ts'

/** The narrow diagnostics sink the migration reports through. */
export interface MigrationDiagLike {
  warn(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
}

/** The registry validation seam for the legacy preset default: resolves
 * against the CURRENT declarations (no alias, no fallback). */
export type LegacyPresetResolver = (id: string) => Promise<void>

/** The normalized, schema-clean footerCommand value for a legacy raw field:
 * the runtime parser's CANONICAL output (fail-soft repairs applied) wrapped
 * in the versioned shape the strict Config schema requires. undefined means
 * the legacy value is unusable (skip with a diagnostic). Writing the raw
 * legacy object instead would let a repaired-at-runtime field (e.g. a
 * string timeoutMs) reach the strict z.number() schema and fail the WHOLE
 * migration batch at ConfigEditor validation. */
function normalizedFooterCommand(value: unknown): { schemaVersion: number; command: string; timeoutMs: number; refreshIntervalMs: number; maxRows: number } | undefined {
  const parsed = parseFooterCommandConfig(value)
  if (parsed === undefined) return undefined
  return { schemaVersion: 1, ...parsed }
}

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

/** Fields whose new Config schema is a STRICT z.object: a malformed legacy
 * value would fail the whole mutate batch at SettingsForms validation, so
 * each is validated through its existing parser BEFORE joining the batch
 * (plan §8.9: one malformed optional field never blocks the rest). */
function strictFieldValid(field: string, value: unknown): boolean {
  if (field === 'footerLayout') return isFooterLayout(parseFooterLayout(value))
  return true
}

/** Read the retired legacy document: prefer the live `settings.yaml`; when
 * the upstream importer's rename wins the read race (the file can vanish
 * between the existence check and the open), fall back to opening the
 * `.imported` backup. A missing file on either path means "no legacy
 * document" (the sync checks keep the common no-legacy boot free of
 * asynchronous I/O before the TUI mounts); any OTHER read error propagates
 * so the caller reports a visible migration failure. */
export async function readLegacyDocument(home: string): Promise<string | undefined> {
  const live = join(home, 'settings.yaml')
  if (existsSync(live)) {
    try {
      return await readFile(live, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const imported = `${live}.imported`
  if (existsSync(imported)) {
    try {
      return await readFile(imported, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

/** Synchronous variant for a startup barrier that must decide whether any
 * legacy value survives before it may continue without a write surface. Same
 * read contract as {@link readLegacyDocument}: live file first, `.imported`
 * backup second, ENOENT means absent, every other error propagates. */
export function readLegacyDocumentSync(home: string): string | undefined {
  const live = join(home, 'settings.yaml')
  if (existsSync(live)) {
    try {
      return readFileSync(live, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const imported = `${live}.imported`
  if (existsSync(imported)) {
    try {
      return readFileSync(imported, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

/** One plain-object section of the legacy document, or undefined. */
export function legacySection(document: unknown, section: string): Record<string, unknown> | undefined {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const value = (document as Record<string, unknown>)[section]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** The historical `agent-presets.default` preference, or undefined. */
export function legacyPresetDefault(document: unknown): string | undefined {
  const section = legacySection(document, 'agent-presets')
  const value = section?.default
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Derive the canonical preference values from the legacy `dsh-pi-tui`
 * section. Field-level fail-soft: a malformed optional field never blocks the
 * rest (the runtime parsers own validation). An absent section produces no
 * values — the schema defaults already express the same effective values, and
 * the profile override must not pin them.
 */
export function legacyPreferenceValues(
  section: Record<string, unknown> | undefined,
  diag: MigrationDiagLike,
): Record<string, unknown> {
  if (section === undefined) return {}
  const values: Record<string, unknown> = {}
  for (const field of COPIED_STRING_FIELDS) {
    const value = section[field]
    if (typeof value === 'string') values[field] = value
  }
  for (const field of COPIED_RAW_FIELDS) {
    const value = section[field]
    if (value === undefined) continue
    if (field === 'footerCommand') {
      // Migrate the parser's CANONICAL output, never the raw legacy object:
      // the runtime parser repairs bad numeric types in place, but the raw
      // strings would still fail the strict z.number() Config schema and
      // reject the whole batch (§8.9 field-level fail-soft).
      const normalized = normalizedFooterCommand(value)
      if (normalized === undefined) {
        diag.warn('legacy TUI field is malformed and was skipped', { field })
        continue
      }
      values[field] = normalized
      continue
    }
    if (!strictFieldValid(field, value)) {
      // §8.9 field-level fail-soft: drop THIS field (visible diagnostic),
      // never the whole batch — the remaining valid fields still migrate.
      diag.warn('legacy TUI field is malformed and was skipped', { field })
      continue
    }
    values[field] = value
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
    values.displayPreset = display.preset
  }
  return values
}
