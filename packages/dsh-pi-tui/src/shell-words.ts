/**
 * A small, reliable POSIX-ish shell word parser for external-command
 * strings like `$VISUAL`/`$EDITOR` (`code --wait`, `vim -f`, `sensible-editor
 * --nofork`) and `!` shell lines. It handles the quoting rules that matter
 * in practice — single quotes (literal), double quotes (backslash escapes,
 * everything else verbatim — no expansion), and backslash escapes outside
 * quotes — WITHOUT executing a shell.
 *
 * This deliberately replaces naive `command.split(/\s+/)` splitting: an
 * editor path with spaces or a quoted argument would be mangled into
 * phantom arguments.
 * @module @xmoon76/dsh-pi-tui/shell-words
 */

/**
 * Split a command line into words, POSIX-ish. Never throws: unbalanced
 * quotes are treated as a trailing literal word (matching how shells
 * consume the rest of the line). Backslashes before non-special characters
 * are dropped outside quotes; inside double quotes a backslash only escapes
 * `"`, `\`, and `$` and is kept verbatim before anything else.
 * @param line - the raw command line.
 * @returns the parsed words.
 */
export function parseShellWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: "'" | '"' | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote === undefined && char === '\\') {
      // Outside quotes a backslash escapes the next character (verbatim).
      const next = line[index + 1]
      if (next !== undefined) {
        current += next
        index += 1
      } else {
        current += '\\'
      }
      inWord = true
      continue
    }
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char
      inWord = true
      continue
    }
    if (quote === '"' && char === '\\') {
      // Inside double quotes a backslash escapes only `"`, `\`, and `$`;
      // before any other character it is kept verbatim (POSIX).
      const next = line[index + 1]
      if (next === '"' || next === '\\' || next === '$') {
        current += next
        index += 1
      } else {
        current += '\\'
      }
      inWord = true
      continue
    }
    if (quote === "'" && char === "'") {
      quote = undefined
      continue
    }
    if (quote === '"' && char === '"') {
      quote = undefined
      continue
    }
    if (quote === undefined && (char === ' ' || char === '\t' || char === '\n')) {
      if (inWord) {
        words.push(current)
        current = ''
        inWord = false
      }
      continue
    }
    current += char
    inWord = true
  }
  if (inWord) words.push(current)
  return words
}
