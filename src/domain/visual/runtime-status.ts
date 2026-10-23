/**
 * The Host-plane runtime-status contract of the built-in visual tools.
 *
 * The contract lives in the domain layer because BOTH the Host row that owns
 * the two registrations and the Direct config adapter that reports their live
 * state need it, and `src/runtime/**` may not import `src/app/**`. The two
 * model-facing tool names stay in the public `./visual-tools` entry.
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
  /** Whether THIS row currently owns live registrations for both tools. */
  applied(): boolean
}
