/**
 * Re-export of the ONE visual tool-name vocabulary.
 *
 * The names live in `domain/transcript/visual-text.ts` because the readable
 * projection of a transcript row needs them and `domain/transcript/**` may only
 * import its own subtree (the architecture gate is closed-world there). The
 * visual domain, the Host row and the TUI consumers import them from here so the
 * visual feature keeps one import site for its own nouns.
 * @module @xmoon76/dsh-pi-tui/domain/visual/tools
 */

export {
  CHART_TOOL_NAME,
  isVisualToolName,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../transcript/visual-text.ts'
