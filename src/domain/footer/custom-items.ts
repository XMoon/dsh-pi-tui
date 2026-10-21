/**
 * User-owned custom footer item definitions (PR C + PR D), neutral half
 * (TS5 §13.3): the persisted raw settings shapes, their validation and
 * normalization, and the config-effective values. Custom definitions are
 * persisted separately from FooterLayoutV1: the layout stores only the
 * canonical `user:*` reference, while this module owns what that item IS.
 * The presentation compilation (FooterItemDefinition / runtime catalog) lives
 * in `tui/footer/custom-item-catalog.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/footer/custom-items
 */

import { DEFAULT_COMMAND_TIMEOUT_MS, type FooterCommandConfig } from './command-config.ts'
import { parseFooterCommandConfig } from './command-trust.ts'
import type { FooterLayoutV1, FooterTone } from './layout.ts'

/** The namespace reserved for user-created definitions. */
export const CUSTOM_FOOTER_ITEM_PREFIX = 'user:'
/** Maximum display name length (measured in Unicode code points). */
export const MAX_CUSTOM_ITEM_NAME_LENGTH = 64
/** Maximum custom text length (measured in Unicode code points). */
export const MAX_CUSTOM_ITEM_TEXT_LENGTH = 256
/** The default refresh interval for a custom command item (PR D §5.2):
 * several command items can coexist, so the default must not spawn one
 * process per item per second (the whole-footer M5 default is 1s). */
export const DEFAULT_CUSTOM_COMMAND_REFRESH_MS = 5000

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u
const TONES: ReadonlySet<string> = new Set([
  'primary', 'accent', 'text', 'textStrong', 'textDim', 'textMuted',
  'border', 'success', 'warning', 'error', 'roleUser', 'shellMode',
])
/** The EXACT key set a v1 text definition may carry. A known-kind object
 * with any OTHER key is forward-compatible raw data (plan §12.1 — an
 * "unknown field object" keeps its raw slot): a future client's field must
 * never be silently normalized away by an unrelated save. */
const TEXT_ITEM_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'id', 'kind', 'text', 'tone'])
/** The EXACT key set a v1 command definition may carry (same rule). */
const COMMAND_ITEM_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion', 'id', 'kind', 'command', 'refreshIntervalMs', 'timeoutMs', 'tone',
])

/** Whether the raw object carries a key outside the allowed v1 set. */
function hasUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return true
  }
  return false
}

/** The PR C/PR D v1 definition union. PR D added the `command`
 * discriminant without changing FooterItemRef or the layout schema. */
export type FooterCustomItemSettings =
  | FooterCustomTextItemSettings
  | FooterCustomCommandItemSettings

/** A user-defined static text value (PR C). */
export interface FooterCustomTextItemSettings {
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: 'text'
  readonly text: string
  readonly tone?: FooterTone | 'auto'
}

/** A user-defined dynamic command value (PR D): the first non-empty
 * sanitized output line of a periodically refreshed shell command. The
 * command/refresh/timeout bounds are the SAME rule set the whole-footer
 * command applies (command-trust's parser) — one validation, never two
 * drifting copies. */
export interface FooterCustomCommandItemSettings {
  readonly schemaVersion: 1
  readonly id: string
  readonly kind: 'command'
  readonly command: string
  readonly refreshIntervalMs?: number
  readonly timeoutMs?: number
  readonly tone?: FooterTone | 'auto'
}

/** The validated runner config for one command definition (maxRows is
 * always 1 — a custom command item is exactly one line; the composer owns
 * width/truncation). The custom-item DEFAULT refresh is 5s (several items
 * can coexist — the whole-footer 1s default would spawn a process per
 * item per second), so an ABSENT refreshIntervalMs is projected to the
 * custom default BEFORE the shared parser runs: an absent default and an
 * explicit 5s must produce the SAME cadence. The parser already validated
 * the definition, so this is defensive. This is the ONE projection both
 * the runtime and the effective-value helpers consume, so the UI, the
 * dirty comparator and the real execution can never drift apart. */
export function customCommandConfigOf(item: FooterCustomCommandItemSettings): FooterCommandConfig | undefined {
  return parseFooterCommandConfig({
    schemaVersion: 1,
    command: item.command,
    timeoutMs: item.timeoutMs,
    refreshIntervalMs: item.refreshIntervalMs ?? DEFAULT_CUSTOM_COMMAND_REFRESH_MS,
    maxRows: 1,
  })
}

/** The effective refresh interval of a command definition (absent = the
 * 5s default). Dirty comparison and the runtime use the EFFECTIVE value so
 * an absent default and an explicit default are the same fact. The value
 * is the SAME normalized value the runner executes (the shared parser
 * clamps refresh to >= 1s): a hand-edited out-of-range raw value is
 * preserved in storage for forward compatibility, but the UI and the
 * dirty comparator never lie about the real cadence. */
export function effectiveCustomCommandRefreshMs(item: FooterCustomCommandItemSettings): number {
  return customCommandConfigOf(item)?.refreshIntervalMs ?? DEFAULT_CUSTOM_COMMAND_REFRESH_MS
}

/** The effective timeout of a command definition (absent = the whole-footer
 * 300ms default; the shared parser clamps to 1..1000ms — the UI reports
 * the same value the runner enforces). */
export function effectiveCustomCommandTimeoutMs(item: FooterCustomCommandItemSettings): number {
  return customCommandConfigOf(item)?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
}

/** A parser result that also lets the caller report invalid entries once
 * without preventing valid user definitions from loading. */
export interface FooterCustomItemsParseResult {
  readonly items: readonly FooterCustomItemSettings[]
  readonly invalidCount: number
}

function codePointLength(text: string): number {
  return [...text].length
}

/** Normalize the name typed by the user and return undefined for a name that
 * cannot form a stable user namespace id. Colons are reserved so a user name
 * cannot impersonate another canonical namespace such as `ext:*`. */
export function normalizeCustomItemName(input: string): string | undefined {
  const name = input.trim()
  if (name === '' || CONTROL_CHARS.test(name)) return undefined
  if (name.includes(':')) return undefined
  if (codePointLength(name) > MAX_CUSTOM_ITEM_NAME_LENGTH) return undefined
  return name
}

/** Convert a user-facing name to the deterministic persisted id. */
export function customItemId(name: string): string | undefined {
  const normalized = normalizeCustomItemName(name)
  return normalized === undefined ? undefined : `${CUSTOM_FOOTER_ITEM_PREFIX}${normalized}`
}

/** Return the user-facing part of a canonical id. */
export function customItemName(id: string): string {
  return id.startsWith(CUSTOM_FOOTER_ITEM_PREFIX)
    ? id.slice(CUSTOM_FOOTER_ITEM_PREFIX.length)
    : id
}

function isTone(value: unknown): value is FooterTone | 'auto' {
  return value === 'auto' || (typeof value === 'string' && TONES.has(value))
}

/** Parse one persisted definition. Invalid definitions are rejected at this
 * boundary; callers can keep the rest of the collection. */
export function parseFooterCustomItem(input: unknown): FooterCustomItemSettings | undefined {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
    const raw = input as Record<string, unknown>
    if (raw.schemaVersion !== 1) return undefined
    if (typeof raw.id !== 'string' || customItemId(customItemName(raw.id)) !== raw.id) return undefined
    if (raw.tone !== undefined && !isTone(raw.tone)) return undefined
    // Preserve an explicit `auto` token for settings round-trips. Compilation
    // treats it like an absent tone, but silently dropping a valid user field
    // would make an unrelated get→replace cycle lossy.
    const tone = raw.tone === undefined ? undefined : raw.tone
    if (raw.kind === 'text') {
      if (hasUnknownKeys(raw, TEXT_ITEM_KEYS)) return undefined
      if (typeof raw.text !== 'string' || raw.text.trim() === '' || CONTROL_CHARS.test(raw.text)) return undefined
      if (codePointLength(raw.text) > MAX_CUSTOM_ITEM_TEXT_LENGTH) return undefined
      return {
        schemaVersion: 1,
        id: raw.id,
        kind: 'text',
        text: raw.text,
        ...(tone === undefined ? {} : { tone }),
      }
    }
    if (raw.kind === 'command') {
      if (hasUnknownKeys(raw, COMMAND_ITEM_KEYS)) return undefined
      // The command/refresh/timeout bounds come from the whole-footer
      // command parser (command-trust): one rule set for both surfaces.
      // Non-finite numeric fields are DROPPED (treated as absent — the
      // persisted item must never carry NaN/Infinity), finite out-of-range
      // values are accepted and clamped by the runtime exactly like the
      // whole-footer config.
      const refresh = typeof raw.refreshIntervalMs === 'number' && Number.isFinite(raw.refreshIntervalMs)
        ? raw.refreshIntervalMs
        : undefined
      const timeout = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
        ? raw.timeoutMs
        : undefined
      const config = parseFooterCommandConfig({
        schemaVersion: 1,
        command: raw.command,
        timeoutMs: timeout,
        refreshIntervalMs: refresh,
        maxRows: 1,
      })
      if (config === undefined) return undefined
      // The parser proved `command` is a non-empty control-free string; the
      // cast bridges the unknown raw slot (the config's own command field
      // is the validated copy).
      const command = config.command
      return {
        schemaVersion: 1,
        id: raw.id,
        kind: 'command',
        command,
        ...(refresh === undefined ? {} : { refreshIntervalMs: refresh }),
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        ...(tone === undefined ? {} : { tone }),
      }
    }
    return undefined
  } catch {
    // Settings are untrusted; a hostile getter/proxy is one invalid entry,
    // not a reason to abort startup or discard the valid remainder.
    return undefined
  }
}

/** Parse the collection without letting one malformed or duplicate entry
 * break startup. The first definition for an id wins deterministically. A
 * hostile collection-level proxy/iterator fails closed as one invalid
 * collection instead of escaping into startup or reload. */
export function parseFooterCustomItems(input: unknown): FooterCustomItemsParseResult {
  try {
    if (input === undefined) return { items: [], invalidCount: 0 }
    if (!Array.isArray(input)) return { items: [], invalidCount: 1 }
    const items: FooterCustomItemSettings[] = []
    const ids = new Set<string>()
    let invalidCount = 0
    for (const candidate of input) {
      const item = parseFooterCustomItem(candidate)
      if (item === undefined || ids.has(item.id)) {
        invalidCount += 1
        continue
      }
      ids.add(item.id)
      items.push(item)
    }
    return { items, invalidCount }
  } catch {
    return { items: [], invalidCount: 1 }
  }
}


/** Every item id a layout references (the authorization / active-set
 * projection). An absent layout activates nothing. */
export function activeFooterItemIds(layout: FooterLayoutV1 | undefined): Set<string> {
  const ids = new Set<string>()
  if (layout === undefined) return ids
  for (const row of layout.rows) {
    for (const ref of row.left) ids.add(ref.id)
    for (const ref of row.right) ids.add(ref.id)
  }
  return ids
}

/** The EXECUTABLE command item ids (PR D activation trust, final formula):
 *
 *   executable = USER trusted definitions ∩ USER-authorized ids ∩
 *                currently rendered layout ids
 *
 * The trusted definitions come from the USER-layer semantic read; the
 * authorized ids come from the ConfigPort's mode-gated projection (a stale
 * leftover USER layout under footer: default/compact authorizes nothing); the
 * rendered layout is what the composer actually shows — a command hidden by
 * the merged layout must not keep running in the background. A /footer save is
 * the special case where the just-committed validated layout is both
 * authorized and rendered. */
export function executableCommandItemIds(
  trustedCommands: readonly FooterCustomCommandItemSettings[],
  authorizedIds: ReadonlySet<string>,
  renderedLayout: FooterLayoutV1 | undefined,
): Set<string> {
  const trustedIds = new Set(trustedCommands.map(item => item.id))
  const renderedIds = activeFooterItemIds(renderedLayout)
  const executable = new Set<string>()
  for (const id of renderedIds) {
    if (trustedIds.has(id) && authorizedIds.has(id)) executable.add(id)
  }
  return executable
}
