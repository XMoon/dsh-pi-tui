/**
 * Stable identity of the Host-resident visual tools and of the Host-plane
 * contract that reports whether their registrations are live.
 *
 * The two names are model-facing protocol identities: durable `tool/call` and
 * `tool/result` history names them, so they must not change. The identity
 * lives in the domain layer because BOTH the Host row that registers the tools
 * and the Direct config adapter that reads their live visibility need it, and
 * `src/runtime/**` may not import `src/app/**`.
 *
 * The status service is the Host row's own registration fact — never a second
 * persisted enable value. The Remote wire exposes no equivalent, so a Remote
 * read reports the runtime state as unobservable instead of guessing.
 * @module @xmoon76/dsh-pi-tui/domain/visual/tool-identity
 */

/** The chart tool's stable, model-facing name. */
export const CHART_TOOL_NAME = 'dsh_pi_tui_chart'

/** The SVG tool's stable, model-facing name. */
export const SVG_TOOL_NAME = 'dsh_pi_tui_svg'

/** The Host-plane service the visual-tools row provides after it mounts. */
export const VISUAL_TOOLS_STATUS_SERVICE = 'piTuiVisualToolsStatus'

/** The visual-tools row's own live registration read. */
export interface VisualToolsRuntimeStatus {
  /** Whether THIS row currently owns live registrations for both tools. */
  applied(): boolean
}
