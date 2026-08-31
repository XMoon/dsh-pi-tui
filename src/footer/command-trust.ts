/**
 * The footer command TRUST GATE (plan §17.4): a repository/project config
 * must NEVER silently trigger arbitrary shell execution. The command is
 * read ONLY from the settings descriptor's USER layer (the stored
 * document's user section) — never from the merged/resolved value, which
 * a project layer could influence. When the user layer cannot prove the
 * command, command mode is disabled and the native layout applies.
 * @module @xmoon76/dsh-pi-tui/footer/command-trust
 */

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_REFRESH_MS,
  type FooterCommandConfig,
} from './command-runner.ts'
import { isFooterLayout, parseFooterLayout } from './layout.ts'
import type { FooterLayoutV1 } from './types.ts'

/** The settings descriptor's shape the gate reads (structural). */
export interface SettingsDescriptorLike {
  /** The branded namespace (a string identity — compare directly). */
  readonly ns: string
  /** The raw USER section of the stored document (absent = not
   * user-overridden — the gate refuses). */
  readonly user?: unknown
}

/** The persisted footerCommand settings shape. */
export interface FooterCommandSettings {
  readonly schemaVersion: 1
  readonly command: string
  readonly timeoutMs?: number
  readonly refreshIntervalMs?: number
  readonly maxRows?: number
}

/** Validate the persisted footerCommand value (bounds per plan §17.3). */
export function parseFooterCommandConfig(input: unknown): FooterCommandConfig | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  if (raw.schemaVersion !== 1) return undefined
  if (typeof raw.command !== 'string' || raw.command.trim() === '') return undefined
  // A NUL (or any C0 control except the tab the shell itself may carry)
  // makes Node's spawn() throw SYNCHRONOUSLY (ERR_INVALID_ARG_VALUE) —
  // the parse is the fail-soft boundary: a hand-edited/corrupted config
  // degrades to the native fallback here, never breaks the startup/config
  // apply chain (the review's P2).
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.command)) return undefined
  const timeoutMs = raw.timeoutMs === undefined
    ? DEFAULT_COMMAND_TIMEOUT_MS
    : typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? Math.min(Math.max(1, raw.timeoutMs), MAX_COMMAND_TIMEOUT_MS)
      : DEFAULT_COMMAND_TIMEOUT_MS
  const refreshIntervalMs = raw.refreshIntervalMs === undefined
    ? MIN_COMMAND_REFRESH_MS
    : typeof raw.refreshIntervalMs === 'number' && Number.isFinite(raw.refreshIntervalMs)
      ? Math.max(MIN_COMMAND_REFRESH_MS, raw.refreshIntervalMs)
      : MIN_COMMAND_REFRESH_MS
  const maxRows = raw.maxRows === undefined
    ? 1
    : typeof raw.maxRows === 'number' && Number.isFinite(raw.maxRows)
      ? Math.min(Math.max(1, Math.floor(raw.maxRows)), 2)
      : 1
  return { command: raw.command, timeoutMs, refreshIntervalMs, maxRows }
}

/**
 * Resolve the TRUSTED command config: the footerCommand value must be
 * present in the USER layer of the dsh-pi-tui settings descriptor. A
 * merged/project-supplied value is refused (undefined = command mode
 * disabled, native fallback, diagnostic warning).
 * @param descriptors - the settings provider's describe() output.
 * @param namespace - the dsh-pi-tui settings namespace value.
 * @returns the validated config, or undefined when untrusted/invalid.
 */
export function resolveTrustedFooterCommand(
  descriptors: readonly SettingsDescriptorLike[] | undefined,
  namespace: string,
): FooterCommandConfig | undefined {
  if (descriptors === undefined) return undefined
  const descriptor = descriptors.find(entry => entry.ns === namespace)
  if (descriptor === undefined) return undefined
  const user = descriptor.user
  if (typeof user !== 'object' || user === null) return undefined
  const raw = (user as Record<string, unknown>).footerCommand
  return parseFooterCommandConfig(raw)
}

/**
 * Resolve the USER layer's declared footer mode. Command mode must be
 * user-layer-owned as well: a project can flip the MERGED `footer:
 * command`, but the gate never lets a project config silently trigger the
 * user's command — the user layer must declare the command mode too.
 * @returns the user layer's footer value, or undefined when absent.
 */
export function resolveUserLayerFooterMode(
  descriptors: readonly SettingsDescriptorLike[] | undefined,
  namespace: string,
): string | undefined {
  if (descriptors === undefined) return undefined
  const descriptor = descriptors.find(entry => entry.ns === namespace)
  if (descriptor === undefined) return undefined
  const user = descriptor.user
  if (typeof user !== 'object' || user === null) return undefined
  const mode = (user as Record<string, unknown>).footer
  return typeof mode === 'string' ? mode : undefined
}

/**
 * Resolve the USER layer's declared custom layout (PR D activation trust):
 * the layout whose refs MAY authorize custom command items — but only
 * while the USER layer itself declares footer: custom (see
 * resolveUserCommandItemActivationIds). A project can supply a MERGED
 * `footerLayout` for rendering, but it can never activate a dormant USER
 * command — the same principle as the command-mode gate above: the user
 * layer must own the layout that decides what executes.
 * @returns the validated USER-layer layout, or undefined when absent or
 * invalid (an invalid user layout authorizes nothing — fail-safe).
 */
export function resolveUserLayerFooterLayout(
  descriptors: readonly SettingsDescriptorLike[] | undefined,
  namespace: string,
): FooterLayoutV1 | undefined {
  if (descriptors === undefined) return undefined
  const descriptor = descriptors.find(entry => entry.ns === namespace)
  if (descriptor === undefined) return undefined
  const user = descriptor.user
  if (typeof user !== 'object' || user === null) return undefined
  const layout = (user as Record<string, unknown>).footerLayout
  const parsed = parseFooterLayout(layout)
  return isFooterLayout(parsed) ? parsed : undefined
}

/**
 * Resolve the USER layer's declared footerFallbackMode (the native mode
 * the user's own command-mode fallback restores).
 */
export function resolveUserLayerFooterFallbackMode(
  descriptors: readonly SettingsDescriptorLike[] | undefined,
  namespace: string,
): string | undefined {
  if (descriptors === undefined) return undefined
  const descriptor = descriptors.find(entry => entry.ns === namespace)
  if (descriptor === undefined) return undefined
  const user = descriptor.user
  if (typeof user !== 'object' || user === null) return undefined
  const mode = (user as Record<string, unknown>).footerFallbackMode
  return typeof mode === 'string' ? mode : undefined
}

/** The shared empty authorization set. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

/** Every item id a layout references (the authorization projection). */
function layoutRefIds(layout: FooterLayoutV1): Set<string> {
  const ids = new Set<string>()
  for (const row of layout.rows) {
    for (const ref of row.left) ids.add(ref.id)
    for (const ref of row.right) ids.add(ref.id)
  }
  return ids
}

/**
 * The ids the USER layer AUTHORIZES for custom command item execution
 * (PR D activation trust, mode-gated): the USER custom layout's refs, but
 * ONLY while the USER layer itself declares `footer: custom`. A stale
 * leftover layout under `footer: default/compact` (the /settings switch
 * deliberately keeps the old layout) authorizes NOTHING — a project
 * flipping the MERGED mode to custom can never resurrect a dormant USER
 * command. `footer: command` authorizes nothing while the whole-footer
 * command surface runs (the caller suspends per-item runners); the native
 * fallback case uses resolveUserCommandItemFallbackActivationIds.
 */
export function resolveUserCommandItemActivationIds(
  descriptors: readonly SettingsDescriptorLike[] | undefined,
  namespace: string,
): ReadonlySet<string> {
  if (resolveUserLayerFooterMode(descriptors, namespace) !== 'custom') return EMPTY_IDS
  const layout = resolveUserLayerFooterLayout(descriptors, namespace)
  return layout === undefined ? EMPTY_IDS : layoutRefIds(layout)
}

/**
 * The ids authorized for the native FALLBACK surface (a merged
 * `footer: command` the USER layer does not own). The FULL semantic is
 * encoded HERE so no caller can forget the outer mode gate:
 *
 *   USER footer === 'command'
 *     && USER footerFallbackMode === 'custom'
 *     && valid USER footerLayout
 *   → the layout's refs
 *   otherwise → empty
 *
 * A USER who never opted into command mode (footer: default/compact)
 * authorizes NOTHING even with stale fallback metadata; a PROJECT
 * forcing the merged command mode can never turn it into execution
 * authorization.
 */
export function resolveUserCommandItemFallbackActivationIds(
  descriptors: readonly SettingsDescriptorLike[] | undefined,
  namespace: string,
): ReadonlySet<string> {
  if (resolveUserLayerFooterMode(descriptors, namespace) !== 'command') return EMPTY_IDS
  if (resolveUserLayerFooterFallbackMode(descriptors, namespace) !== 'custom') return EMPTY_IDS
  const layout = resolveUserLayerFooterLayout(descriptors, namespace)
  return layout === undefined ? EMPTY_IDS : layoutRefIds(layout)
}
