/**
 * The ONE experimental renderer opt-in predicate. It lives outside the
 * `app/bootstrap/**` composition zone so every application owner can share the
 * exact rule without importing bootstrap helpers.
 *
 * @module @xmoon76/dsh-pi-tui/app/renderer-opt-in
 */

/** Whether this boot explicitly asked for the experimental TSP renderer. */
export function tspRequested(env: { readonly DSH_PI_TUI_RENDERER?: string | undefined }): boolean {
  return env.DSH_PI_TUI_RENDERER === 'tsp'
}
