/**
 * Neutral icon vocabulary and setting normalization (TS8-D split from the
 * legacy root `src/icons.ts`).
 *
 * This module owns WHAT a structural icon means — the presentation style
 * names, the semantic identities and the fail-safe normalization of a
 * persisted style value. It never owns a concrete glyph: the terminal palette
 * (emoji / symbols / minimal bytes) lives in `src/tui/icons.ts`, so the
 * transcript domain can carry a {@link IconSemantic} without pulling renderer
 * presentation into the semantic authority.
 * @module @xmoon76/dsh-pi-tui/domain/display/icons
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
  | 'section-collapsed'
  | 'section-expanded'
  | 'working-a'
  | 'working-b'
  | 'assistant-bullet'
  | 'thinking'
  | 'compaction'

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
  'section-collapsed',
  'section-expanded',
  'working-a',
  'working-b',
  'assistant-bullet',
  'thinking',
  'compaction',
]

/** The plain section disclosure semantic used by Compact Work spans and
 * Context clusters — deliberately distinct from the Focus root's whale
 * identity. */
export function sectionDisclosureSemantic(expanded: boolean): 'section-collapsed' | 'section-expanded' {
  return expanded ? 'section-expanded' : 'section-collapsed'
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
