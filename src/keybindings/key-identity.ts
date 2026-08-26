/**
 * Canonical physical-key identity (the convergence contract, plan §1/§4.1):
 * one physical key has exactly ONE canonical KeyId, so aliases, modifier
 * order and CASING can never bypass conflict detection, leader-prefix
 * collision or deduplication.
 *
 * ```text
 * esc     -> escape
 * return  -> enter
 * shift+ctrl+p -> ctrl+shift+p
 * ctrl+A  -> ctrl+a
 * ```
 *
 * Canonicalization is a pure string transform on the fork's KeyId grammar:
 * - base-key aliases (`esc`/`escape`, `return`/`enter`) map to ONE name;
 * - modifiers are reordered to the fixed order ctrl → shift → alt → super;
 * - every base is LOWERCASED — including single characters (`A` → `a`,
 *   `ctrl+A` → `ctrl+a`): the fork's runtime parser lowercases the whole
 *   key id and its `matchesKey` is case-insensitive, so two spellings of
 *   one physical key must collapse onto one canonical identity (review
 *   finding: the canonicalizer used to skip single-char bases, so
 *   `ctrl+A` and `ctrl+a` coexisted as "different" keys that the runtime
 *   treated as the same physical key).
 * @module @xmoon76/dsh-pi-tui/keybindings/key-identity
 */

import type { KeyId } from '@xmoon76/pi-tui'

/** The canonical base-key alias map: the KEY is the canonical form, the
 * value is the alias that collapses onto it. */
const BASE_KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  return: 'enter',
}

/** The fixed modifier order every canonical KeyId carries. */
const MODIFIER_ORDER: readonly string[] = ['ctrl', 'shift', 'alt', 'super']

/** The base keys the fork's KeyId grammar accepts (packages/pi-tui
 * keys.ts). The single source for EVERY key-name validation: the user
 * config parser and the Stable plugin registry share it (round-17
 * finding — a plugin could register a key name the runtime parser can
 * never produce, a dead binding). */
export const KEY_ID_BASE_KEYS = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '|', '~', '{', '}', ':', '<', '>', '?',
  'escape', 'esc', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert', 'clear',
  'home', 'end', 'pageUp', 'pageDown', 'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
])

const KEY_ID_MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super'])

/** Case-insensitive view of the base-key grammar: `pageUp` and `pageup`
 * are the SAME physical key (the canonical identity is lowercase). */
const BASE_KEYS_LOWER = new Set([...KEY_ID_BASE_KEYS].map(key => key.toLowerCase()))

/** Whether a string is a valid KeyId (the fork's grammar) — the SHARED
 * grammar policy of the config parser and the plugin registry. Named
 * keys are case-insensitive at parse time (pageUp/pageup), and the
 * modifiers must be unique. */
export function isValidKeyId(value: string): value is KeyId {
  if (value === '') return false
  const parts = value.split('+')
  if (parts.length === 0) return false
  const base = parts[parts.length - 1]!
  if (!BASE_KEYS_LOWER.has(base.toLowerCase())) return false
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!KEY_ID_MODIFIERS.has(parts[index]!)) return false
  }
  // No duplicate modifiers.
  return new Set(parts.slice(0, -1)).size === parts.length - 1
}

/** Whether a key is TEXT-PRODUCING — it types a character into the
 * editor, so a binding on it would swallow (or steal) ordinary typing
 * (round-17 finding): a single printable base (letters/digits/symbols,
 * 32-126) or the spacebar, with NO ctrl/alt/super modifier. SHIFT ALONE
 * does not change this: Shift+A is the raw 'A' byte on legacy terminals
 * (matchesKey('A','shift+a') is TRUE) and the normalized 'a'+shift on
 * Kitty — either way it produces text, so a binding on it behaves
 * terminal-dependently and steals uppercase input on some terminals.
 * Named keys (shift+left, shift+enter, ...) are NOT
 * text-producing and stay bindable. Shared by the config parser
 * (direct bindings + the leader key), the InputRouter (a text key never
 * reaches the plugin stage) and the plugin registry (registration
 * rejection). */
export function isTextProducingKeyId(key: KeyId): boolean {
  const canonical = canonicalizeKeyId(key)
  const parts = canonical.split('+')
  const base = parts[parts.length - 1]!
  const hasNonShiftModifier = parts.slice(0, -1).some(modifier => modifier !== 'shift')
  if (hasNonShiftModifier) return false
  if (base === 'space') return true
  return base.length === 1 && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126
}

/** The fork matcher's RUNTIME MODIFIER CAPABILITY per base key (keys.ts
 * switch — the exact answer to "does this base+modifier combination have
 * at least one matching path?"):
 * - `escape`: NONE — any modifier hits `modifier !== 0 → false`;
 * - `f1`..`f12`: NONE — same hard reject;
 * - `clear`: `shift` | `ctrl` ONLY — the case has no kitty /
 *   modifyOtherKeys fallback and matchesLegacyModifierSequence supports
 *   exactly shift or exactly ctrl (round-24 finding: alt+clear /
 *   super+clear / ctrl+alt+clear / ctrl+shift+clear can never be
 *   matched);
 * - every OTHER base: ANY grammar-supported modifier — a CSI-u /
 *   modifyOtherKeys fallback exists (probe-verified for insert/delete/
 *   home/end/pageUp/pageDown/arrows/space/tab/enter/backspace and the
 *   single-character branch). */
const RUNTIME_MODIFIER_CAPABILITY: Readonly<Record<string, ReadonlySet<string>>> = {
  escape: new Set(),
  clear: new Set(['shift', 'ctrl']),
}

/** Whether a key is a runtime-bindable KeyId (round-22 finding): the
 * fork's matcher hard-rejects ANY modifier on the F-keys and Escape
 * (keys.ts: `if (modifier !== 0) return false`), and `clear` only
 * supports exactly shift or exactly ctrl — every other syntactically
 * valid combination can NEVER fire on any terminal protocol, so
 * advertising it would be a dead binding. This gate separates
 * "syntactically valid grammar" from "the runtime can actually match
 * it"; the config parser (direct bindings, the leader key and
 * completions) and the plugin registry share it. Unmodified keys stay
 * bindable. */
export function isRuntimeBindableKeyId(key: KeyId): boolean {
  const canonical = canonicalizeKeyId(key)
  if (!isValidKeyId(canonical)) return false
  const parts = canonical.split('+')
  if (parts.length === 1) return true
  const base = parts[parts.length - 1]!
  const modifiers = parts.slice(0, -1)
  // The F-keys are unconditionally unmodifiable.
  if (/^f\d+$/.test(base)) return false
  const capability = RUNTIME_MODIFIER_CAPABILITY[base]
  if (capability === undefined) return true
  return modifiers.length === 1 && capability.has(modifiers[0]!)
}

/** The fork EDITOR's unconditionally-owned binding keys (packages/pi-tui
 * TUI_KEYBINDINGS defaults + the editor's hardcoded shift+backspace /
 * shift+delete): the InputRouter's editorAccepts probe claims this whole
 * set for the focused editor on EVERY keystroke, so a Stable plugin
 * binding on one of these keys can never fire — the editor wins by
 * precedence and even a replacement editor's decline re-runs the probe
 * (round-19 finding). The plugin registry rejects them at registration;
 * the USER config parser does NOT (a Host action resolves BEFORE the
 * editor, so tab/arrows/etc. stay bindable for user overrides). This is
 * the single inventory — derived sets (the submit pre-submit keys) and
 * the registry share it, never a third hard-coded copy. */
export const EDITOR_OWNED_KEY_IDS: ReadonlySet<string> = new Set([
  // Navigation (tui.editor.cursorUp/Down/Left/Right, cursorWordLeft/
  // Right, cursorLineStart/End, pageUp/pageDown, jumpForward/Backward)
  'up', 'down', 'left', 'right', 'ctrl+b', 'ctrl+f',
  'alt+left', 'ctrl+left', 'alt+b', 'alt+right', 'ctrl+right', 'alt+f',
  'home', 'ctrl+home', 'ctrl+a', 'end', 'ctrl+end', 'ctrl+e',
  'pageUp', 'ctrl+pageUp', 'pageDown', 'ctrl+pageDown',
  'ctrl+]', 'ctrl+alt+]',
  // Editing (deleteCharBackward/Forward, deleteWordBackward/Forward,
  // deleteToLineStart/End, yank, yankPop, undo)
  'backspace', 'shift+backspace', 'delete', 'shift+delete', 'ctrl+d',
  'ctrl+w', 'alt+backspace', 'alt+d', 'alt+delete',
  'ctrl+u', 'ctrl+k', 'ctrl+y', 'alt+y', 'ctrl+-',
  // Input / select (newLine, tab, copy, submit, select.*)
  'shift+enter', 'ctrl+j', 'enter', 'tab', 'escape', 'ctrl+c',
].map(key => canonicalizeKeyId(key as KeyId)))

/** The editor's POST-SUBMIT keys (fork components/editor.ts handleInput
 * dispatch order — arrows, page keys and the jump chords are checked
 * AFTER the submit check, so a submit remap onto them WOULD fire). The
 * app.input.submit pre-submit inventory is EDITOR_OWNED minus this set
 * (round-9 finding: a submit remap on a PRE-submit key could never
 * fire; a post-submit key is fine). */
export const EDITOR_POST_SUBMIT_KEYS: ReadonlySet<string> = new Set(
  ['up', 'down', 'left', 'right', 'ctrl+b', 'ctrl+f',
    'pageUp', 'ctrl+pageUp', 'pageDown', 'ctrl+pageDown',
    'ctrl+]', 'ctrl+alt+]', 'enter', 'escape']
    .map(key => canonicalizeKeyId(key as KeyId)),
)

/** Whether one canonical key id is a fork EDITOR-owned key (the shared
 * plugin-registration policy; see {@link EDITOR_OWNED_KEY_IDS}). */
export function isEditorOwnedKeyId(key: KeyId): boolean {
  return EDITOR_OWNED_KEY_IDS.has(canonicalizeKeyId(key))
}

/**
 * Canonicalize one KeyId: collapse base-key aliases, reorder the modifiers
 * to the fixed order and lowercase every base. Idempotent — canonicalizing
 * a canonical key returns it unchanged.
 *
 * ```text
 * 'esc'            -> 'escape'
 * 'return'         -> 'enter'
 * 'shift+ctrl+p'   -> 'ctrl+shift+p'
 * 'alt+ctrl+x'     -> 'ctrl+alt+x'
 * 'A'              -> 'a'
 * 'ctrl+A'         -> 'ctrl+a'
 * 'pageUp'         -> 'pageup'       (named keys canonicalize to
 *                                    lowercase — the runtime parser
 *                                    lowercases, so the canonical form
 *                                    must match; the fork's matchesKey
 *                                    is case-insensitive, convergence
 *                                    finding)
 * ```
 * @param key - the raw KeyId.
 * @returns the canonical KeyId.
 */
export function canonicalizeKeyId(key: KeyId): KeyId {
  const raw = key as string
  if (raw === '' || !raw.includes('+')) {
    // LOWERCASE FIRST, then apply the alias map: `ESC` → `esc` →
    // `escape`, `RETURN` → `return` → `enter`, `A` → `a`. Order matters —
    // an uppercase alias must collapse onto the canonical base
    // (convergence finding). Single characters lowercase too (a bare
    // letter is one physical key regardless of its spelling).
    const lowered = raw.toLowerCase()
    const aliased = BASE_KEY_ALIASES[lowered] ?? lowered
    return aliased as KeyId
  }
  const parts = raw.split('+')
  const base = parts[parts.length - 1]!
  const modifiers = parts.slice(0, -1)
  // Collapse the base alias first (case-insensitive: lowercase the base
  // BEFORE the alias lookup so `ESC` collapses to `escape`), then order
  // the modifiers. Named keys canonicalize to LOWERCASE so the keymap
  // identity matches the runtime parser's lowercased normalized keys
  // (pageUp/pageup are the same key). Single-character bases lowercase
  // too — `ctrl+A` and `ctrl+a` are ONE physical key (the fork's
  // matchesKey lowercases everything).
  const loweredBase = base.toLowerCase()
  const canonicalBase = BASE_KEY_ALIASES[loweredBase] ?? loweredBase
  const loweredMods = modifiers.map(m => m.toLowerCase())
  const ordered = MODIFIER_ORDER.filter(modifier => loweredMods.includes(modifier))
  // A modifier not in the fixed order is impossible per the fork grammar,
  // but keep it appended (defensive — never drop an unknown modifier).
  const extra = loweredMods.filter(modifier => !MODIFIER_ORDER.includes(modifier))
  return [...ordered, ...extra, canonicalBase].join('+') as KeyId
}

/**
 * The canonical IDENTITY of one physical key: a string that is EQUAL for
 * every spelling of the same physical key (esc/escape, ctrl+shift+p /
 * shift+ctrl+p). Built to be collision-free for the fork grammar (the
 * canonical KeyId already is; the identity is a convenience wrapper used
 * as a Map/Set key).
 * @param key - the raw KeyId.
 * @returns the canonical identity string.
 */
export function canonicalKeyIdentity(key: KeyId): string {
  return canonicalizeKeyId(key)
}