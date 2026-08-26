/**
 * User keybinding config parsing and validation (plan §12/§13/§14/§16).
 *
 * Settings shape (namespace `dsh-pi-tui` — the TUI's own settings
 * section, NOT the `pi-tui` profile name — field `keybindings`):
 *
 * ```yaml
 * dsh-pi-tui:
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
import { canonicalizeKeyId } from './key-identity.ts'
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

/** Case-insensitive view of the base-key grammar: `pageUp` and `pageup`
 * are the SAME physical key (the canonical identity is lowercase). */
const BASE_KEYS_LOWER = new Set([...BASE_KEYS].map(key => key.toLowerCase()))

/** The FORK EDITOR's UNCONDITIONAL pre-submit keys (packages/pi-tui
 * TUI_KEYBINDINGS + components/editor.ts handleInput): the editor
 * dispatches these bindings BEFORE its submit check (copy, undo, tab,
 * deletion, kill-ring, line/word cursor moves, newline), so a submit
 * remap onto one of them would be advertised by the read model but could
 * never fire — the editor consumes the key earlier (e.g. `submit: tab`
 * stays autocomplete). Same unsupported-key policy as the Shift+Enter
 * newline rejection (review finding): a binding that can never work is
 * rejected, never advertised. The list is the fork's DEFAULT keys only —
 * the autocomplete-gated select.* keys (up/down/enter/escape/pageUp/
 * pageDown while the dropdown is open) are NOT included: enter is the
 * default submit itself and the others still reach the submit check when
 * the dropdown is closed. Consumer-side validation only — the fork stays
 * pristine. */
const EDITOR_PRE_SUBMIT_KEYS = new Set([
  'ctrl+c', // tui.input.copy
  'ctrl+-', // tui.editor.undo
  'tab', // tui.input.tab
  'ctrl+k', // tui.editor.deleteToLineEnd
  'ctrl+u', // tui.editor.deleteToLineStart
  'ctrl+w', 'alt+backspace', // tui.editor.deleteWordBackward
  'alt+d', 'alt+delete', // tui.editor.deleteWordForward
  'backspace', 'shift+backspace', // tui.editor.deleteCharBackward
  'delete', 'shift+delete', 'ctrl+d', // tui.editor.deleteCharForward
  'ctrl+y', // tui.editor.yank
  'alt+y', // tui.editor.yankPop
  'home', 'ctrl+home', 'ctrl+a', // tui.editor.cursorLineStart
  'end', 'ctrl+end', 'ctrl+e', // tui.editor.cursorLineEnd
  'alt+left', 'ctrl+left', 'alt+b', // tui.editor.cursorWordLeft
  'alt+right', 'ctrl+right', 'alt+f', // tui.editor.cursorWordRight
  'shift+enter', 'ctrl+j', // tui.input.newLine (also covered by dedicated checks)
].map(key => canonicalizeKeyId(key as KeyId)),
)

/** Whether a string is a valid KeyId (the fork's grammar). */
export function isValidKeyId(value: string): value is KeyId {
  if (value === '') return false
  const parts = value.split('+')
  if (parts.length === 0) return false
  const base = parts[parts.length - 1]!
  // Named keys are CASE-INSENSITIVE at parse time: the fork grammar
  // spells pageUp/pageDown with camelCase, but the canonical identity is
  // lowercase (pageup) — accept either spelling (convergence: one
  // physical key has one canonical identity).
  if (!BASE_KEYS.has(base) && !BASE_KEYS_LOWER.has(base.toLowerCase())) return false
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!MODIFIERS.has(parts[index]!)) return false
  }
  // No duplicate modifiers.
  return new Set(parts.slice(0, -1)).size === parts.length - 1
}

/** Whether a key is a plain printable (plan §14: a direct user binding of
 * a plain printable to a Host action would swallow typing). Unmodified
 * single characters (32–126) AND the `space` key name (the fork alias for
 * the spacebar, which types char 32 — a bare `space` binding would swallow
 * every space the user types) are printable; everything with a modifier,
 * a named editing key (enter/tab/escape/arrows/f-keys) or a multi-char
 * sequence is not. */
export function isPlainPrintableKey(key: KeyId): boolean {
  if (key.includes('+')) return false
  if (key === 'space') return true
  return key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126
}

/** LEGACY TERMINAL COLLISIONS — REJECTED, never warned (convergence §4.5
 * finding + round-12 finding): on legacy/non-Kitty terminals these keys
 * are INDISTINGUISHABLE from fixed keys, so a binding on them would
 * silently steal the other key (or never fire):
 * - `ctrl+[` is the legacy ESC sequence (0x1b) — binding it would steal
 *   the interrupt/viewer-close key on legacy terminals;
 * - `ctrl+j` / `ctrl+m` are LF/CR (Enter) — binding them would steal
 *   submit/queue on legacy terminals;
 * - `ctrl+i` is the TAB byte (0x09 — the fork's rawCtrlChar maps Ctrl+I
 *   to 9, and matchesKey('\t','ctrl+i') is TRUE, so a Host binding on
 *   ctrl+i fires on Tab presses on legacy terminals — stealing the
 *   editor's tab completion);
 * - `ctrl+h` is the BACKSPACE byte (0x08) — same class as ctrl+i;
 * - `ctrl+_` is the 0x1f byte — the fork maps Ctrl+- to the SAME 0x1f
 *   (rawCtrlChar('-') = 31, the same physical US key as _), so ctrl+_ and
 *   ctrl+- are one physical legacy byte.
 * A binding that depends on the terminal protocol to be distinguishable
 * from a fixed key is unsupported: rejected with a diagnostic. */
const LEGACY_COLLISION_KEYS = new Set(
  ['ctrl+[', 'ctrl+j', 'ctrl+m', 'ctrl+i', 'ctrl+h', 'ctrl+_'].map(key => canonicalizeKeyId(key as KeyId)),
)

/** The NON-CONFIGURABLE overlay/component default keys (plan §3.3 fixed
 * overlay contracts: search close/next/previous, question/tasks flows).
 * A configurable action bound to one of these keys is ECLIPSED while the
 * overlay is open — the fixed key wins by precedence. Warned, not
 * rejected (the binding still works outside the overlay). */
const FIXED_OVERLAY_KEYS = new Set(
  Object.values(APP_KEYBINDINGS)
    .filter(definition => !definition.configurable)
    .flatMap(definition => definition.defaultKeys)
    .map(canonicalizeKeyId),
)

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

  // The leader key itself. A plain PRINTABLE leader key is rejected: the
  // machine consumes it while idle (arming the pending state), so a
  // printable leader would swallow typing — same rule as a direct
  // printable binding (review finding). The check runs on the CANONICAL
  // key: an uppercase `SPACE`/`Space` spelling is still the printable
  // spacebar (the whole pipeline is grammar → canonicalize → policy →
  // store, review finding).
  const leaderValue = doc[LEADER_KEY]
  if (leaderValue !== undefined) {
    if (typeof leaderValue === 'string' && isValidKeyId(leaderValue)) {
      const canonicalLeader = canonicalizeKeyId(leaderValue as KeyId)
      if (isPlainPrintableKey(canonicalLeader)) {
        diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — a plain printable leader would swallow typing — ignored`)
      } else if (LEGACY_COLLISION_KEYS.has(canonicalLeader)) {
        // Legacy terminal collisions are REJECTED for the leader prefix too
        // (convergence finding): a leader on ctrl+[ / ctrl+j / ctrl+m would
        // swallow the lifecycle Esc/Enter on legacy terminals.
        diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — it collides with a fixed key on legacy terminals — ignored`)
      } else {
        leader = { key: canonicalLeader, timeoutMs: options.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS }
      }
    } else {
      diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — ignored`)
    }
  }

  // The nested `bindings` map merges with the top-level action entries. A
  // duplicate action declaration (top level AND nested, or twice) is a
  // diagnostic — never a silent last-write-wins (plan §15/§16): the FIRST
  // declaration wins, the later one is ignored.
  const entries: [string, unknown][] = []
  const seen = new Set<string>()
  const pushEntry = (actionId: string, value: unknown): void => {
    if (seen.has(actionId)) {
      diagnostics.push(`keybindings: action "${actionId}" declared more than once — the later entry is ignored`)
      return
    }
    seen.add(actionId)
    entries.push([actionId, value])
  }
  for (const [key, value] of Object.entries(doc)) {
    if (key === LEADER_KEY) continue
    if (key === BINDINGS_KEY) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          pushEntry(nestedKey, nestedValue)
        }
      } else {
        diagnostics.push('keybindings: "bindings" must be an object — ignored')
      }
      continue
    }
    pushEntry(key, value)
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
        // Esc (aliases included) is the leader's pending-CANCEL fixed
        // contract — a completion on it could never fire (convergence
        // contract §4.6a). Rejected at the parser.
        const canonicalCompleting = canonicalizeKeyId(completing as KeyId)
        if (canonicalCompleting === 'escape') {
          diagnostics.push(`keybindings: "${actionId}" binds a "<leader>escape" sequence — Esc is the leader cancel key and cannot be a completion — ignored`)
          continue
        }
        // Legacy terminal collisions are REJECTED for completions too
        // (convergence finding): a completion on ctrl+[ / ctrl+j / ctrl+m
        // would swallow the lifecycle Esc/Enter on legacy terminals.
        if (LEGACY_COLLISION_KEYS.has(canonicalCompleting)) {
          diagnostics.push(`keybindings: "${actionId}" binds a "<leader>${completing}" sequence — it collides with a fixed key on legacy terminals — ignored`)
          continue
        }
        leaderBindings.push({ action, key: canonicalCompleting })
        continue
      }
      if (!isValidKeyId(entry)) {
        diagnostics.push(`keybindings: "${actionId}" has an invalid key "${entry}" — ignored`)
        continue
      }
      // The policy pipeline is grammar → CANONICALIZE → policy → store
      // (review finding): every check below runs on the canonical identity,
      // so an uppercase spelling (`SPACE`, `ctrl+A`, `CTRL+RETURN`) can
      // never bypass the printable guard or the collision sets — the raw
      // spelling is only used in the diagnostic text.
      const canonicalEntry = canonicalizeKeyId(entry as KeyId)
      if (isPlainPrintableKey(canonicalEntry)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind the plain printable key "${entry}" to a Host action — ignored`)
        continue
      }
      // Shift+Enter is the fork editor's FIXED newline key (tui.input
      // .newLine): binding it to app.input.submit would be advertised by
      // the read model but could never fire as a submit (the editor
      // treats it as newline; the host submit seam excludes it). Rejected
      // with a diagnostic — a binding that can never work must not be
      // accepted (convergence §3 finding).
      if (actionId === 'app.input.submit' && canonicalEntry === 'shift+enter') {
        diagnostics.push('keybindings: "app.input.submit" cannot bind Shift+Enter — it is the editor newline key — ignored')
        continue
      }
      // Legacy terminal collisions are REJECTED (convergence §4.5 +
      // round-12 finding): a binding indistinguishable from a fixed key
      // on legacy terminals is unsupported, never a warning.
      if (LEGACY_COLLISION_KEYS.has(canonicalEntry)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind "${entry}" — it collides with a fixed key on legacy terminals (Ctrl+[ is Esc; Ctrl+J/M is Enter; Ctrl+I/H are Tab/Backspace; Ctrl+_ is Ctrl+-) — ignored`)
        continue
      }
      // The fork editor CONSUMES its own editing bindings BEFORE the
      // submit check, so an app.input.submit remap onto one of them could
      // never fire (review finding: `submit: tab` stayed autocomplete).
      // Rejected like Shift+Enter — never advertised as a submit key. The
      // other actions are NOT affected: the host ladder consumes their
      // keys before the editor, so they really fire.
      if (actionId === 'app.input.submit' && EDITOR_PRE_SUBMIT_KEYS.has(canonicalEntry)) {
        diagnostics.push(`keybindings: "app.input.submit" cannot bind "${entry}" — the editor consumes it before submit — ignored`)
        continue
      }
      // Fixed overlay-key precedence (review finding): a configurable
      // action bound to a non-configurable overlay's key is eclipsed
      // while that overlay is open (e.g. the search toggle remapped to
      // Enter collides with search.next). The binding still works
      // outside the overlay; warned, never silently dropped.
      if (FIXED_OVERLAY_KEYS.has(canonicalEntry)) {
        diagnostics.push(`keybindings: "${actionId}" binds "${entry}", which a non-configurable overlay owns while it is open — the overlay wins there`)
      }
      keys.push(canonicalEntry)
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
