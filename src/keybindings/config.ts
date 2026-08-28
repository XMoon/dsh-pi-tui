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
import { canonicalizeKeyId, EDITOR_OWNED_KEY_IDS, EDITOR_POST_SUBMIT_KEYS, isRuntimeBindableKeyId, isTextProducingKeyId, isValidKeyId } from './key-identity.ts'
import { APP_KEYBINDINGS, NON_CONFIGURABLE_ACTIONS } from './definitions.ts'
import type { AppKeybindingId, LeaderBinding, LeaderConfig, UserKeybindingValue, UserKeybindingsConfig } from './types.ts'

/** The special keys of the keybindings settings object. */
const LEADER_KEY = 'leader'
const BINDINGS_KEY = 'bindings'

/** The leader sequence marker (`<leader>t`). */
export const LEADER_PREFIX = '<leader>'

/** The fork's KeyId grammar (moved to key-identity.ts — the SHARED
 * policy of the config parser and the plugin registry; re-exported here
 * for callers of the parser module). */
export { isValidKeyId }

/** Physical Escape is reserved for the Host lifecycle path (overlay close,
 * shell exit, interrupt/double-cancel). Only the lifecycle action itself may
 * declare it; every other action would otherwise steal that path. */
export function isPhysicalEscapeAction(action: string): boolean {
  return action === 'app.agent.interrupt'
}

/** The FORK EDITOR's UNCONDITIONAL PRE-SUBMIT keys — DERIVED from the
 * shared {@link EDITOR_OWNED_KEY_IDS} inventory minus the POST-SUBMIT
 * keys (packages/pi-tui components/editor.ts handleInput dispatch
 * order): the editor dispatches these bindings BEFORE its submit check
 * (copy, undo, tab, deletion, kill-ring, line/word cursor moves,
 * newline), so a submit remap onto one of them would be advertised by
 * the read model but could never fire — the editor consumes the key
 * earlier (e.g. `submit: tab` stays autocomplete). Same unsupported-key
 * policy as the Shift+Enter newline rejection (review finding): a
 * binding that can never work is rejected, never advertised. The
 * POST-SUBMIT keys (arrows, page keys, jump chords, enter, escape) DO
 * reach the submit check and stay bindable for submit. Consumer-side
 * validation only — the fork stays pristine. */
const EDITOR_PRE_SUBMIT_KEYS = new Set(
  [...EDITOR_OWNED_KEY_IDS].filter(key => !EDITOR_POST_SUBMIT_KEYS.has(key)),
)

/** Whether the fork editor consumes a key before the submit action can see
 * it. The interactive editor shares this derived inventory with the parser. */
export function isEditorSubmitPreSubmitKey(key: KeyId): boolean {
  return EDITOR_PRE_SUBMIT_KEYS.has(canonicalizeKeyId(key))
}

/** Whether a key is a PLAIN (unmodified) printable — the strict subset of
 * {@link isTextProducingKeyId} with no modifier at all (plan §14). The
 * parser rejects the BROADER text-producing set (shift-only printables
 * included — round-17 finding: Shift+A is the raw 'A' byte on legacy
 * terminals, so a Host binding on it would steal typing); this helper is
 * kept for the exact "no modifier" classification. */
export function isPlainPrintableKey(key: KeyId): boolean {
  if (key.includes('+')) return false
  if (key === 'space') return true
  return key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126
}

/** TERMINAL-AMBIGUOUS KEYS — REJECTED, never warned (convergence §4.5
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
 *   ctrl+- are ONE physical legacy byte — BOTH spellings are rejected
 *   (round-16 finding: ctrl+- used to bypass the inventory while its
 *   twin ctrl+_ was rejected);
 * - `ctrl+-` is the fork editor's undo key, and on legacy terminals its
 *   byte IS the 0x1f above — indistinguishable from ctrl+_;
 * - `ctrl+backspace` is TERMINAL-AMBIGUOUS: the fork's matchesRawBackspace
 *   reads raw 0x08 as Ctrl+Backspace on Windows Terminal (WT_SESSION) but
 *   as plain Backspace on legacy terminals/tmux — a binding on it fires
 *   on some terminals and can never fire on others (round-20 finding).
 * A binding that depends on the terminal protocol to be distinguishable
 * from a fixed key is unsupported: rejected with a diagnostic.
 *
 * The inventory is SHARED (round-13 finding): the config parser AND the
 * Stable plugin registry (KeybindingRegistry.register) must reject the
 * SAME canonical key ids — a plugin registration on ctrl+i would
 * otherwise resolve in the EffectiveKeymap but never match the router's
 * normalized plugin lookup (\t normalizes to `tab`, not `ctrl+i`). */
export const TERMINAL_AMBIGUOUS_KEY_IDS: ReadonlySet<string> = new Set(
  ['ctrl+[', 'ctrl+j', 'ctrl+m', 'ctrl+i', 'ctrl+h', 'ctrl+_', 'ctrl+-', 'ctrl+backspace'].map(key => canonicalizeKeyId(key as KeyId)),
)

/** Whether one canonical key id is a terminal-ambiguous key (the shared
 * policy of the config parser and the plugin registry). */
export function isTerminalAmbiguousKeyId(key: KeyId): boolean {
  return TERMINAL_AMBIGUOUS_KEY_IDS.has(canonicalizeKeyId(key))
}

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
  // Actions whose ONLY declaration is a leader sequence (no direct keys).
  // The empty-array marker is written ONLY after the leader prefix is
  // confirmed valid (review round 39 finding): a missing/invalid leader
  // makes the sequences inert (fail-soft) and the action must fall back
  // to its builtin default — a marker left behind would suppress the
  // builtin for a config that was diagnosed and ignored.
  const leaderOnlyActions = new Set<AppKeybindingId>()
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
      if (!isRuntimeBindableKeyId(canonicalLeader)) {
        diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — the runtime can never match this modifier combination (F-keys and Escape take no modifiers; Clear takes only Shift/Ctrl) — ignored`)
      } else if (isTextProducingKeyId(canonicalLeader)) {
        diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — a text-producing leader would swallow typing — ignored`)
      } else if (canonicalLeader === 'escape') {
        diagnostics.push(`keybindings: invalid leader key "${String(leaderValue)}" — physical Escape is reserved for the Host lifecycle path — ignored`)
      } else if (TERMINAL_AMBIGUOUS_KEY_IDS.has(canonicalLeader)) {
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
    if (!Object.prototype.hasOwnProperty.call(APP_KEYBINDINGS, actionId)) {
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
        // The runtime-bindable gate (round-22/24 finding): a completion
        // whose modifier combination the fork matcher can never match
        // (F-keys/Escape take no modifiers; Clear takes only Shift/Ctrl).
        if (!isRuntimeBindableKeyId(canonicalCompleting)) {
          diagnostics.push(`keybindings: "${actionId}" binds a "<leader>${completing}" sequence — the runtime can never match this modifier combination (F-keys and Escape take no modifiers; Clear takes only Shift/Ctrl) — ignored`)
          continue
        }
        // Legacy terminal collisions are REJECTED for completions too
        // (convergence finding): a completion on ctrl+[ / ctrl+j / ctrl+m
        // would swallow the lifecycle Esc/Enter on legacy terminals.
        if (TERMINAL_AMBIGUOUS_KEY_IDS.has(canonicalCompleting)) {
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
      if (canonicalEntry === 'escape' && !isPhysicalEscapeAction(actionId)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind "${entry}" — physical Escape is reserved for the Host lifecycle path — ignored`)
        continue
      }
      // RUNTIME-BINDABLE GATE (round-22/24 finding): the fork matcher
      // can never match certain modifier combinations (F-keys/Escape
      // take no modifiers — keys.ts `modifier !== 0` → false; Clear
      // takes only Shift/Ctrl — no CSI-u fallback), so accepting them
      // would advertise a key that can never fire. Separates "valid
      // grammar" from "runtime-bindable" — the plugin registry shares
      // the gate.
      if (!isRuntimeBindableKeyId(canonicalEntry)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind "${entry}" — the runtime can never match this modifier combination (F-keys and Escape take no modifiers; Clear takes only Shift/Ctrl) — ignored`)
        continue
      }
      if (isTextProducingKeyId(canonicalEntry)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind the text-producing key "${entry}" to a Host action — ignored`)
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
      if (TERMINAL_AMBIGUOUS_KEY_IDS.has(canonicalEntry)) {
        diagnostics.push(`keybindings: "${actionId}" cannot bind "${entry}" — it collides with a fixed key on legacy terminals (Ctrl+[ is Esc; Ctrl+J/M is Enter; Ctrl+I/H are Tab/Backspace; Ctrl+_ and Ctrl+- are one key; Ctrl+Backspace is Backspace on legacy, Ctrl+Backspace on Windows Terminal) — ignored`)
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
      if (FIXED_OVERLAY_KEYS.has(canonicalEntry)
        && !(canonicalEntry === 'escape' && isPhysicalEscapeAction(actionId))) {
        diagnostics.push(`keybindings: "${actionId}" binds "${entry}", which a non-configurable overlay owns while it is open — the overlay wins there`)
      }
      keys.push(canonicalEntry)
    }
    if (keys.length > 0) {
      bindings[action] = keys.length === 1 ? keys[0]! : keys
    } else if (leaderBindings.some(binding => binding.action === action)) {
      // A LEADER-ONLY declaration (no direct keys, only `<leader>X`
      // sequences): record the action — the empty-array marker is
      // written AFTER the leader prefix is confirmed valid (review
      // round 39 finding: the marker used to be written here, before
      // the leader check, so a missing/invalid leader — diagnosed and
      // ignored — still suppressed the builtin default).
      leaderOnlyActions.add(action)
    }
  }

  // The leader machine runs after the editor-owned submit seam for focused
  // editors. Reject completions that the current effective submit binding
  // would consume before the machine can see them (Enter by default, or a
  // parsed user remap). This is done after all entries are parsed so nested
  // and top-level declarations share the same policy.
  const submitValue = bindings['app.input.submit']
  const submitKeys = submitValue === false
    ? new Set<KeyId>()
    : submitValue === undefined
      ? new Set(APP_KEYBINDINGS['app.input.submit'].defaultKeys)
      : new Set(Array.isArray(submitValue) ? submitValue : [submitValue])
  const usableLeaderBindings = leaderBindings.filter(binding => {
    if (!submitKeys.has(binding.key)) return true
    diagnostics.push(`keybindings: "${binding.action}" binds a "<leader>${binding.key}" sequence, but ${binding.key} is an editor-owned submit key — ignored`)
    return false
  })
  if (usableLeaderBindings.length !== leaderBindings.length) {
    leaderBindings.length = 0
    leaderBindings.push(...usableLeaderBindings)
    for (const action of leaderOnlyActions) {
      if (!leaderBindings.some(binding => binding.action === action)) leaderOnlyActions.delete(action)
    }
  }

  // A leader sequence without a leader key is inert: warn once.
  if (leaderBindings.length > 0 && leader === undefined) {
    diagnostics.push('keybindings: leader sequences configured but no "leader" key — the sequences are ignored')
    return { bindings, leader, leaderBindings: [], diagnostics }
  }
  // The leader prefix is confirmed valid: write the empty-array markers
  // for the leader-only declarations (review round 37 — the unified
  // override contract: absent = builtin, direct = replace, leader-only =
  // replace, direct+leader = both user triggers with the builtin removed,
  // false = remove all). The empty array compiles no direct rules but
  // suppresses the builtin; the leader sequences live in `leaderBindings`.
  // Written only NOW so a missing/invalid leader (fail-soft: the
  // sequences are ignored) leaves the action on its builtin default
  // (review round 39 finding).
  for (const action of leaderOnlyActions) {
    bindings[action] = []
  }
  return { bindings, leader, leaderBindings, diagnostics }
}

/** The default leader timeout (plan §6 M6: pending prefix expiry). */
export const DEFAULT_LEADER_TIMEOUT_MS = 1500
