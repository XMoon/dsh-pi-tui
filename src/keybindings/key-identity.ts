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