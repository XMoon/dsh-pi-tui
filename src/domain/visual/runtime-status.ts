/**
 * The Host-plane runtime-status contract of the built-in visual tools.
 *
 * The contract lives in the domain layer because BOTH the Host row that owns
 * the three registrations and the Direct config adapter that reports their live
 * state need it, and `src/runtime/**` may not import `src/app/**`. The three
 * model-facing tool names are `CHART_TOOL_NAME`, `SVG_TOOL_NAME` and
 * `PRESENT_VISUAL_TOOL_NAME` in `domain/visual/tools.ts`.
 *
 * The status is the Host row's own registration fact — never a second
 * persisted enable value. The Remote wire exposes no equivalent, so a Remote
 * read reports the runtime state as unobservable instead of guessing.
 * @module @xmoon76/dsh-pi-tui/domain/visual/runtime-status
 */

/** The Host-plane service the visual-tools row provides after it mounts. */
export const VISUAL_TOOLS_STATUS_SERVICE = 'piTuiVisualToolsStatus'

/** The visual-tools row's own live registration read. */
export interface VisualToolsRuntimeStatus {
  /** Whether THIS row currently owns live registrations for ALL three tools. */
  applied(): boolean
}
