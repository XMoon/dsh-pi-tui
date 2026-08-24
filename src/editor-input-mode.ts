/**
 * The editor's input-mode codec: `!` / `!!` are EDITOR STATE, never
 * document text (the shell-editor-mode plan). The editor buffer holds the
 * bare command body; the mode is serialized back into the existing textual
 * `!` / `!!` protocol ONLY at host boundaries (submission, history,
 * completion), so the shell business layer (`shell-context.ts`) keeps its
 * authoritative classification unchanged.
 *
 * This module is deliberately pure and dependency-free: every transition
 * and codec rule is testable without a terminal.
 * @module @xmoon76/dsh-pi-tui/editor-input-mode
 */

/** The three editor input modes. */
export type EditorInputMode =
  | 'prompt'
  | 'shell-context'
  | 'shell-local'

/** The visible/serialized prefix of one mode ('' for the prompt). */
export function shellPrefixForMode(mode: EditorInputMode): '' | '!' | '!!' {
  if (mode === 'shell-context') return '!'
  if (mode === 'shell-local') return '!!'
  return ''
}

/**
 * Serialize a mode + body back into the wire form the shell dispatch
 * understands: `prompt + "hello" -> "hello"`, `shell-context + "pwd" ->
 * "!pwd"`, `shell-local + "pwd" -> "!!pwd"`.
 */
export function serializeEditorInput(mode: EditorInputMode, text: string): string {
  return shellPrefixForMode(mode) + text
}

/**
 * Decode a serialized user input line (a history entry, a pasted shell
 * line, a restored submission) into mode + body. The `!!` check runs
 * before `!`; a bare `!` / `!!` decodes to the matching shell mode with an
 * empty body. Any other text is a plain prompt line.
 */
export function editorModeFromHistoryEntry(entry: string): { mode: EditorInputMode; text: string } {
  if (entry.startsWith('!!')) return { mode: 'shell-local', text: entry.slice(2) }
  if (entry.startsWith('!')) return { mode: 'shell-context', text: entry.slice(1) }
  return { mode: 'prompt', text: entry }
}
