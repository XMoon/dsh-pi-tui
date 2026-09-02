/**
 * The process-local single-live-TUI slot (re-vendor lifecycle follow-up
 * P3).
 *
 * The shared resource this lock protects is NOT the terminal raw-mode —
 * it is the vendored fork's PROCESS-GLOBAL keybindings
 * (`getKeybindings()` singleton). A TuiApp's HostKeybindingManager syncs
 * `app.input.submit` → `tui.editor.submit` (plus Home/End and alt-screen
 * mappings) into that singleton on EVERY rebuild (constructor, user
 * remap, safe-mode flip, plugin keybinding sync, extension unload/HMR) —
 * and the manager SURVIVES `stop()`: a stopped-but-not-final-disposed
 * surface is still a valid surface generation (the Stable extension
 * contract keeps registrations/handles alive across start/stop
 * round-trips; only the final `dispose()` ends it), so its later rebuild
 * would silently repaint the process-global bindings under a second,
 * concurrently started app.
 *
 * Therefore the slot is held from the FIRST successful `start()` until
 * the FINAL `dispose()`:
 *
 * ```text
 * first start → claim
 * stop        → KEEP claim (the namespace is still owned)
 * same start  → no re-claim
 * final dispose (completed teardown) → release
 * ```
 *
 * Exclusivity is FAIL-CLOSED: the release happens only at the END of a
 * successfully completed final teardown. If `dispose()` throws midway,
 * the slot stays claimed — a half-torn-down surface must never be
 * publicly replaceable by a new one. `stop()` never releases (a
 * throwing stop teardown must not fail open either).
 *
 * This is a host-side guard over the vendored singleton, NOT a
 * re-vendoring of the fork's keybinding manager (which stays upstream-
 * shaped; plan §10 explicitly excludes a generalized per-instance
 * KeybindingsManager refactor).
 * @module @xmoon76/dsh-pi-tui/process-tui-slot
 */

/** The number of process-slot claims outstanding in this process (1 =
 * one TuiApp owns the process-global keybinding namespace). */
let liveTuiCount = 0

/**
 * Claim the process slot. Throws deterministically when another TuiApp
 * already owns it (no final dispose yet) — a second surface would
 * silently share (and fight over) the fork's process-global keybinding
 * state.
 * @param surfaceId - the claiming surface's id (diagnostic only).
 */
export function claimProcessTuiSlot(surfaceId: string): void {
  if (liveTuiCount !== 0) {
    throw new Error(
      `dsh-pi-tui supports one live TuiApp per process (pi-tui keybindings are process-global); `
        + `the surface "${surfaceId}" cannot start while another TuiApp owns the process slot`,
    )
  }
  liveTuiCount += 1
}

/** Release the process slot (idempotent — a double release is a no-op;
 * a release without a claim is a no-op too). Must be called ONLY from
 * the completed final dispose path (fail-closed). */
export function releaseProcessTuiSlot(): void {
  if (liveTuiCount > 0) liveTuiCount -= 1
}

/** Test hook: the number of outstanding process-slot claims (0 or 1). */
export function liveTuiCountForTest(): number {
  return liveTuiCount
}
