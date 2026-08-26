/**
 * Canonical physical-key identity (the convergence contract, plan §1/§4.1):
 * one physical key has exactly ONE canonical KeyId, so aliases and
 * modifier order can never bypass conflict detection, leader-prefix
 * collision or deduplication.
 *
 * ```text
 * esc     -> escape
 * return  -> enter
 * shift+ctrl+p -> ctrl+shift+p
 * ```
 *
 * Canonicalization is a pure string transform on the fork's KeyId grammar:
 * - base-key aliases (`esc`/`escape`, `return`/`enter`) map to ONE name;
 * - modifiers are reordered to the fixed order ctrl → shift → alt → super.
 *
 * The fork's grammar casing is PRESERVED for named keys (`pageUp`,
 * `pageDown`, `Home` is NOT lower-cased — see {@link BASE_KEY_ALIASES}).
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
 * Canonicalize one KeyId: collapse base-key aliases and reorder the
 * modifiers to the fixed order. Idempotent — canonicalizing a canonical
 * key returns it unchanged.
 *
 * ```text
 * 'esc'            -> 'escape'
 * 'return'         -> 'enter'
 * 'shift+ctrl+p'   -> 'ctrl+shift+p'
 * 'alt+ctrl+x'     -> 'ctrl+alt+x'
 * 'pageUp'         -> 'pageUp'        (named-key casing preserved)
 * ```
 * @param key - the raw KeyId.
 * @returns the canonical KeyId.
 */
export function canonicalizeKeyId(key: KeyId): KeyId {
  const raw = key as string
  if (raw === '' || !raw.includes('+')) {
    const aliased = BASE_KEY_ALIASES[raw] ?? raw
    return aliased as KeyId
  }
  const parts = raw.split('+')
  const base = parts[parts.length - 1]!
  const modifiers = parts.slice(0, -1)
  // Collapse the base alias first, then order the modifiers.
  const canonicalBase = BASE_KEY_ALIASES[base] ?? base
  const ordered = MODIFIER_ORDER.filter(modifier => modifiers.includes(modifier))
  // A modifier not in the fixed order is impossible per the fork grammar,
  // but keep it appended (defensive — never drop an unknown modifier).
  const extra = modifiers.filter(modifier => !MODIFIER_ORDER.includes(modifier))
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