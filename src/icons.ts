/**
 * The first-party structural icon system (plan: icon-style-symbols).
 *
 * Every first-party structural glyph the TUI paints — tool-card headers,
 * context-injection rows, the Focus disclosure, the default working frames —
 * resolves through ONE registry keyed by SEMANTIC + style, never a
 * hard-coded emoji string scattered across renderers. The three palettes:
 *
 * - `emoji` — the legacy colorful set (the default; before == after).
 * - `symbols` — a small, monochrome, terminal-safe set whose glyphs all
 *   measure ONE cell under the fork's `visibleWidth()` (enforced by
 *   test/icons.test.ts). Colors never live here: the renderer's existing
 *   semantic color context (header title, error, textDim, ...) paints the
 *   glyph.
 * - `minimal` — NOT a third skin: ordinary decorative icons are hidden
 *   (empty glyph) and only state/interaction markers survive (error,
 *   interrupted, question, disclosure, working). The working pair is the
 *   same `• / ◦` as symbols — minimal's calm comes from REMOVING static
 *   icons, never from changing animation semantics (a reduced-motion
 *   preference would be its own setting).
 *
 * Because `minimal` yields empty glyphs, renderers must never build
 * `` `${icon} ${title}` `` directly — use {@link iconPrefix}, which returns
 * the icon plus its two-space separator only when a glyph exists.
 *
 * Deliberate non-goals (see the plan): no global emoji sanitizer, no
 * glyph persistence in session/fold state (fold state carries the
 * SEMANTIC, resolved at render time), no user/assistant/tool-content
 * rewriting, no font dependencies. The assistant whale bullet, the header
 * brand whale, the thinking/compaction markers and the image attachment
 * marker stay emoji-only in this version — they are content-adjacent or
 * brand markers, not registry semantics.
 * @module @xmoon76/dsh-pi-tui/icons
 */

/** The presentation style for structural icons. */
export type IconStyle = 'emoji' | 'symbols' | 'minimal'

/** One structural icon identity: WHAT the glyph means, never the glyph. */
export type IconSemantic =
  | 'tool-read'
  | 'tool-search'
  | 'tool-shell'
  | 'tool-write'
  | 'tool-edit'
  | 'tool-code'
  | 'tool-generic'
  | 'subagent'
  | 'workflow'
  | 'error'
  | 'interrupted'
  | 'question'
  | 'slash-command'
  | 'context-file'
  | 'context-skill'
  | 'context-plugin'
  | 'context-notice'
  | 'context-recall'
  | 'context-generic'
  | 'disclosure-collapsed'
  | 'disclosure-expanded'
  | 'working-a'
  | 'working-b'

/** Every semantic, for exhaustive palette/width sweeps. */
export const ALL_ICON_SEMANTICS: readonly IconSemantic[] = [
  'tool-read',
  'tool-search',
  'tool-shell',
  'tool-write',
  'tool-edit',
  'tool-code',
  'tool-generic',
  'subagent',
  'workflow',
  'error',
  'interrupted',
  'question',
  'slash-command',
  'context-file',
  'context-skill',
  'context-plugin',
  'context-notice',
  'context-recall',
  'context-generic',
  'disclosure-collapsed',
  'disclosure-expanded',
  'working-a',
  'working-b',
]

/** The full palette: semantic × style. The emoji column is the historical
 * glyph EXACTLY (default behavior must not change); the symbols column is
 * the compact monochrome vocabulary (see the plan for the design notes —
 * ◆/◇ express agent/workflow hierarchy, ▸/▾ disclosure state, •/◦ the
 * working pair, all mirroring upstream pi/kimi/opencode conventions). */
const ICONS: Record<IconStyle, Record<IconSemantic, string>> = {
  emoji: {
    'tool-read': '📖',
    'tool-search': '🔍',
    'tool-shell': '🖥️',
    'tool-write': '📝',
    'tool-edit': '✏️',
    'tool-code': '⚙️',
    'tool-generic': '🛠️',
    subagent: '🤖',
    workflow: '🧵',
    error: '❌',
    interrupted: '⏹️',
    question: '❓',
    'slash-command': '🎛️',
    'context-file': '📄',
    'context-skill': '📚',
    'context-plugin': '📦',
    'context-notice': '📌',
    'context-recall': '🕘',
    'context-generic': '📎',
    'disclosure-collapsed': '🐋',
    'disclosure-expanded': '🐳',
    'working-a': '🐋',
    'working-b': '🐳',
  },
  symbols: {
    'tool-read': '▤',
    'tool-search': '⌕',
    'tool-shell': '›',
    'tool-write': '+',
    'tool-edit': '~',
    'tool-code': '◆',
    'tool-generic': '•',
    subagent: '◆',
    workflow: '◇',
    error: '×',
    interrupted: '■',
    question: '?',
    'slash-command': '›',
    'context-file': '▤',
    'context-skill': '◆',
    'context-plugin': '◇',
    'context-notice': '!',
    'context-recall': '↶',
    'context-generic': '·',
    'disclosure-collapsed': '▸',
    'disclosure-expanded': '▾',
    'working-a': '•',
    'working-b': '◦',
  },
  minimal: {
    // Ordinary decorative icons are HIDDEN — the title + semantic color
    // carry the meaning. Only state/interaction markers survive.
    'tool-read': '',
    'tool-search': '',
    'tool-shell': '',
    'tool-write': '',
    'tool-edit': '',
    'tool-code': '',
    'tool-generic': '',
    subagent: '',
    workflow: '',
    'slash-command': '',
    'context-file': '',
    'context-skill': '',
    'context-plugin': '',
    'context-notice': '',
    'context-recall': '',
    'context-generic': '',
    error: '×',
    interrupted: '■',
    question: '?',
    'disclosure-collapsed': '▸',
    'disclosure-expanded': '▾',
    // The working pair is UNIFIED with symbols — minimal removes static
    // icons, it does not change animation semantics.
    'working-a': '•',
    'working-b': '◦',
  },
}

/** Resolve one semantic icon for a style. Returns a PURE glyph (possibly
 * EMPTY in `minimal`) — never an ANSI-colored string; the renderer's
 * semantic color context paints it. */
export function iconFor(semantic: IconSemantic, style: IconStyle): string {
  return ICONS[style][semantic]
}

/** The icon plus its TWO-space trailing separator when the style shows a
 * glyph, '' when the glyph is hidden (minimal). Renderers MUST compose
 * headers as `` `${iconPrefix(...)}${title}` `` — the raw `` `${icon} ${title}` ``
 * form would leave a dangling leading space under minimal. The two-space
 * trail preserves the historical emoji layout byte-for-byte, so the default
 * emoji rendering is unchanged. */
export function iconPrefix(semantic: IconSemantic, style: IconStyle): string {
  const icon = iconFor(semantic, style)
  return icon === '' ? '' : `${icon}  `
}

/** Normalize any persisted/old value to a valid IconStyle: unknown and
 * missing values fail-safe to `emoji` (backward compatibility — an old
 * settings file without the field must behave exactly as before). */
export function iconStyleOf(value: string | undefined | null): IconStyle {
  switch (value) {
    case 'symbols':
    case 'minimal':
      return value
    default:
      return 'emoji'
  }
}
