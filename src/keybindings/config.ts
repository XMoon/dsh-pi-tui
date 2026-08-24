/**
 * User keybinding config parsing and validation (plan §12/§13/§14/§16).
 *
 * Settings shape (namespace `pi-tui`, field `keybindings`):
 *
 * ```yaml
 * pi-tui:
 *   keybindings:
 *     app.input.steer: ctrl+s
 *     app.permission.cycle: [shift+tab, ctrl+shift+p]
 *     app.history.search: ctrl+r
 *     app.transcript.toggleThinking: false
 *     leader: ctrl+x
 *     bindings:
 *       app.tasks.open: <leader>t
 * ```
 *
 * Semantics (plan §12):
 * - string: a single key (or a `<leader>X` sequence, M6);
 * - array: multiple keys;
 * - `false`: disable the action's effective binding;
 * - absent: the builtin default.
 *
 * Fail-soft (plan §16): a malformed entry is a diagnostic + ignore; it
 * never disables the whole map and never prevents the TUI from starting.
 * @module @xmoon76/dsh-pi-tui/keybindings/config
 */

import type { KeyId } from '@xmoon76/pi-tui'
import { APP_KEYBINDINGS, NON_CONFIGURABLE_ACTIONS } from './definitions.ts'
import type { AppKeybindingId, LeaderBinding, LeaderConfig, UserKeybindingValue, UserKeybindingsConfig } from './types.ts'

/** The special keys of the keybindings settings object. */
const LEADER_KEY = 'leader'
const BINDINGS_KEY = 'bindings'

/** The leader sequence marker (`<leader>t`). */
export const LEADER_PREFIX = '<leader>'

/** The base keys the fork's KeyId grammar accepts (keys.ts). */
const BASE_KEYS = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '|', '~', '{', '}', ':', '<', '>', '?',
  'escape', 'esc', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert', 'clear',
  'home', 'end', 'pageUp', 'pageDown', 'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super'])

/** Whether a string is a valid KeyId (the fork's grammar). */
export function isValidKeyId(value: string): value is KeyId {
  if (value === '') return false
  const parts = value.split('+')
  if (parts.length === 0) return false
  const base = parts[parts.length - 1]!
  if (!BASE_KEYS.has(base)) return false
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!MODIFIERS.has(parts[index]!)) return false
  }
  // No duplicate modifiers.
  return new Set(parts.slice(0, -1)).size === parts.length - 1
}

/** Whether a key is a plain printable (plan §14: a direct user binding of
 * a plain printable to a Host action would swallow typing). */
export function isPlainPrintableKey(key: KeyId): boolean {
  if (key.includes('+')) return false
  return key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126
}

/** Terminal-unreliable combinations (plan §13 item 5): legacy terminals
 * send Ctrl+J as LF (Enter) and Ctrl+M as CR (Enter), so binding them is
 * a silent no-op on those terminals. Warned, not rejected. */
const TERMINAL_UNRELIABLE_KEYS = new Set(['ctrl+j', 'ctrl+m'])

/** The parsed, validated user configuration. */
export interface ParsedUserKeybindings {
  /** The direct action → keys map (leader sequences removed). */
  readonly bindings: UserKeybindingsConfig
  /** The leader configuration (undefined when unset). */
  readonly leader: LeaderConfig | undefined
  /** The leader-sequence bindings (`<leader>X`). */
  readonly leaderBindings: readonly LeaderBinding[]
  /** Fail-soft diagnostics (warnings, never fatal). */
  readonly diagnostics: readonly string[]
}

/** Parse and validate the raw `keybindings` settings value. Unknown
 * actions, invalid keys and malformed entries are diagnostics + ignored
 * (plan §16). */
export function parseUserKeybindings(
  raw: unknown,
  options: { leaderTimeoutMs?: number } = {},
): ParsedUserKeybindings {
  const diagnostics: string[] = []
  const bindings: UserKeybindingsConfig = {}
  const leaderBindings: LeaderBinding[] = []
  let leader: LeaderConfig | undefined

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    if (raw !== undefined) diagnostics.push('keybindings: expected an object, ignored')
    return { bindings, leader, leaderBindings, diagnostics }
  }
  const doc = raw as Record<string, unknown>

  // The leader key itself.
  const leaderValue = doc[LEADER_KEY]
  if (leaderValue !== undefined) {
    if (typeof leaderValue === 'string' && isValidKeyId(leaderValue)) {
      leader = { key: leaderValue, timeoutMs: options.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS }
    } else {
      diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — ignored`)
    }
  }

  // The nested `bindings` map merges with the top-level action entries.
  const entries: [string, unknown][] = []
  for (const [key, value] of Object.entries(doc)) {
    if (key === LEADER_KEY) continue
    if (key === BINDINGS_KEY) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          entries.push([nestedKey, nestedValue])
        }
      } else {
        diagnostics.push('keybindings: "bindings" must be an object — ignored')
      }
      continue
    }
    entries.push([key, value])
  }

  for (const [actionId, value] of entries) {
    if (!(actionId in APP_KEYBINDINGS)) {
      diagnostics.push(`keybindings: unknown action "${actionId}" — ignored`)
      continue
    }
    const action = actionId as AppKeybindingId
    if (NON_CONFIGURABLE_ACTIONS.has(action)) {
      diagnostics.push(`keybindings: action "${actionId}" is not user-configurable in this version — ignored`)
      continue
    }
    if (value === false) {
      bindings[action] = false
      continue
    }
    const values = Array.isArray(value) ? value : [value]
    const keys: KeyId[] = []
    for (const entry of values) {
      if (typeof entry !== 'string') {
        diagnostics.push(`keybindings: "${actionId}" entry "${String(entry)}" is not a key string — ignored`)
        continue
      }
      if (entry.startsWith(LEADER_PREFIX)) {
        const completing = entry.slice(LEADER_PREFIX.length)
        if (completing === '') {
          diagnostics.push(`keybindings: "${actionId}" has a bare "<leader>" sequence — a completing key is required — ignored`)
          continue
        }
        if (!isValidKeyId(completing)) {
          diagnostics.push(`keybindings: "${actionId}" has an invalid leader sequence "${entry}" — ignored`)
          continue
        }
        leaderBindings.push({ action, key: completing })
        continue
      }
      if (!isValidKeyId(entry)) {
        diagnostics.push(`keybindings: "${actionId}" has an invalid key "${entry}" — ignored`)
        continue
      }
      if (isPlainPrintableKey(entry)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind the plain printable key "${entry}" to a Host action — ignored`)
        continue
      }
      if (TERMINAL_UNRELIABLE_KEYS.has(entry)) {
        diagnostics.push(`keybindings: "${actionId}" binds "${entry}", which legacy terminals report as Enter — the binding may not fire there`)
      }
      keys.push(entry)
    }
    if (keys.length > 0) bindings[action] = keys.length === 1 ? keys[0]! : keys
  }

  // A leader sequence without a leader key is inert: warn once.
  if (leaderBindings.length > 0 && leader === undefined) {
    diagnostics.push('keybindings: leader sequences configured but no "leader" key — the sequences are ignored')
    return { bindings, leader, leaderBindings: [], diagnostics }
  }
  return { bindings, leader, leaderBindings, diagnostics }
}

/** The default leader timeout (plan §6 M6: pending prefix expiry). */
export const DEFAULT_LEADER_TIMEOUT_MS = 1500
