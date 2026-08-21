/**
 * Shared semantic input normalization (Phase 2): the Host's terminal
 * protocol decoding funneled into ONE module so every consumer — the
 * Stable editor channel (EditorInputEvent), the Advanced normalized
 * captures and the Advanced interactive components — sees the SAME event
 * classification. The Host decodes legacy + Kitty CSI-u + modifyOtherKeys
 * encodings, bracketed paste, and key release/repeat filtering HERE; a
 * plugin never parses raw terminal bytes.
 * @module @xmoon76/dsh-pi-tui/extension/input-events
 */

import { isKeyRelease, isKeyRepeat, parseKey } from '@xmoon76/pi-tui'
import type { AdvancedInputEvent } from '../advanced-types.ts'
import type { NormalizedKey } from '../public-types.ts'

/** The bracketed-paste open marker. */
const BRACKETED_PASTE_START = '\x1b[200~'
/** The bracketed-paste close marker. */
const BRACKETED_PASTE_END = '\x1b[201~'

/** Parse a bracketed-paste chunk into its content, or undefined when the
 * data is not a bracketed paste. The fork re-wraps pastes with the
 * markers, so one paste arrives as one bracketed chunk. */
export function parseBracketedPaste(data: string): string | undefined {
  if (!data.startsWith(BRACKETED_PASTE_START) || !data.endsWith(BRACKETED_PASTE_END)) return undefined
  return data.slice(BRACKETED_PASTE_START.length, data.length - BRACKETED_PASTE_END.length)
}

/** Convert a fork key-id string (`ctrl+shift+f`, `up`, `alt+up`) into the
 * public normalized shape. */
export function keyIdToNormalized(keyId: string): NormalizedKey {
  const parts = keyId.toLowerCase().split('+')
  const key = parts[parts.length - 1] ?? ''
  return {
    key,
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    super: parts.includes('super'),
  }
}

/**
 * Normalize raw terminal input into a SEMANTIC input event (the ONLY input
 * shape a plugin ever sees — never raw terminal bytes). Returns undefined
 * for protocol artifacts (Kitty press/repeat/release) and unparseable
 * control sequences (the Host keeps those; a plugin never sees them).
 *
 * Classification:
 * - bracketed paste (`\x1b[200~...\x1b[201~`) → `{ kind: 'paste', text }`;
 * - one key press (parseKey resolves legacy/CSI-u/modifyOtherKeys) →
 *   `{ kind: 'key', key }`;
 * - a plain printable run (multi-char chunk that is not a single key) →
 *   `{ kind: 'text', text }`;
 * - anything else → undefined.
 */
export function normalizeInputEvent(data: string): AdvancedInputEvent | undefined {
  if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
  const paste = parseBracketedPaste(data)
  if (paste !== undefined) return { kind: 'paste', text: paste }
  const parsed = parseKey(data)
  if (parsed !== undefined) return { kind: 'key', key: keyIdToNormalized(parsed) }
  // A plain printable run: multi-char chunks that are not a single key
  // (fast typing / non-bracketed paste heuristic) are TEXT.
  if (data.length > 0 && [...data].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127)) {
    return { kind: 'text', text: data }
  }
  return undefined
}
