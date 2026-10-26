/**
 * The root-owned Markdown segment for one Assistant text piece with its
 * display-only shared reference-definition prefix.
 *
 * The prefix exists so a `[text][label]` link keeps resolving when a published
 * figure splits the answer into separate Markdown segments. It is rendered by
 * the SAME vendored `Markdown` instance as the body — never pre-rendered rows,
 * never a second HTML/DOM layer — and the component removes ONLY the leading
 * blank rows that the prefix itself actually added. The body's own leading
 * blank lines stay untouched.
 *
 * The prefix is bounded by its real rendered height at the current width; the
 * trim can therefore never grow with the definition count, and a resize
 * re-measures both renders. No source, Session, search corpus or export is
 * modified.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/shared-definitions-markdown
 */

import {
  Markdown,
  type Component,
  type MarkdownOptions,
  type MarkdownTheme,
} from '@xmoon76/pi-tui'
import { sanitizeDisplayText } from '../../presentation/terminal-text.ts'

/** Count the leading all-blank rendered rows. */
function leadingBlankRows(lines: readonly string[]): number {
  let count = 0
  for (const line of lines) {
    if (line.trim() !== '') break
    count += 1
  }
  return count
}

/** One Markdown segment: the shared definitions prefix plus the body. */
export class SharedDefinitionsMarkdown implements Component {
  private readonly bodyMarkdown: Markdown
  private readonly combinedMarkdown: Markdown
  private readonly prefixMarkdown: Markdown | undefined
  private readonly hasPrefix: boolean
  private cachedWidth = -1
  private cachedLines: string[] | undefined

  constructor(options: {
    readonly body: string
    readonly definitions: string
    readonly theme: MarkdownTheme
    readonly markdownOptions: MarkdownOptions
  }) {
    const body = sanitizeDisplayText(options.body)
    this.hasPrefix = options.definitions !== ''
    const definitions = this.hasPrefix ? sanitizeDisplayText(options.definitions) : ''
    this.bodyMarkdown = new Markdown(body, 0, 0, options.theme, undefined, options.markdownOptions)
    this.combinedMarkdown = new Markdown(definitions + body, 0, 0, options.theme, undefined, options.markdownOptions)
    this.prefixMarkdown = this.hasPrefix
      ? new Markdown(definitions, 0, 0, options.theme, undefined, options.markdownOptions)
      : undefined
  }

  invalidate(): void {
    this.cachedWidth = -1
    this.cachedLines = undefined
    this.bodyMarkdown.invalidate()
    this.combinedMarkdown.invalidate()
    this.prefixMarkdown?.invalidate()
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines
    const combined = this.combinedMarkdown.render(width)
    let lines = combined
    if (this.hasPrefix && this.prefixMarkdown !== undefined) {
      const body = this.bodyMarkdown.render(width)
      const prefixRows = this.prefixMarkdown.render(width).length
      // The prefix can only own the EXCESS leading blank rows over what the
      // body renders by itself. When the body already starts with a blank row,
      // the prefix's separator merges into it and nothing may be trimmed.
      const budget = Math.min(prefixRows, Math.max(0, leadingBlankRows(combined) - leadingBlankRows(body)))
      if (budget > 0) lines = combined.slice(budget)
    }
    this.cachedWidth = width
    this.cachedLines = lines
    return lines
  }
}
