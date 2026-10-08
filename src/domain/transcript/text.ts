/**
 * Transcript text helpers (TS8-D): the ONE `latestLine` projection, extracted
 * from the legacy root `src/present.ts` because the transcript fold consumes
 * it as a SEMANTIC summary while the rest of that module is tool-card
 * presentation.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/text
 */

/** The last line of a text (the Web's running-reasoning summary). */
export function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}
