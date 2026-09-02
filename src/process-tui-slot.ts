/**
 * The process-local single-live-TUI slot (re-vendor lifecycle follow-up
 * P3).
 *
 * The vendored fork's keybindings (`getKeybindings()`) are a
 * PROCESS-GLOBAL singleton: a TuiApp mutates the shared `tui.editor.submit`,
 * Home/End and alt-screen mappings while it runs, so two LIVE TuiApps in
 * one Node process would silently fight over one keybinding state (App A
 * submit = Ctrl+X, App B submit = Enter — only one can win; the other
 * app's input becomes unpredictable). The product/CLI architecture is one
 * process = one live TUI, and this module makes that invariant explicit
 * and fail-fast.
 *
 * Slot semantics: the slot is held by a LIVE surface. `TuiApp.start()`
 * claims it and `TuiApp.stop()` releases it, so the invariant enforced is
 * "never two CONCURRENTLY LIVE surfaces" — exactly what the
 * process-global keybindings require. A stop/start round-trip (the
 * external-editor suspend/resume, surface stop/start cycles) never trips
 * the guard (release then re-claim); fullscreen main/alt-screen swaps
 * stop/start the SCREENS, not the app, so they never touch this module at
 * all. Final disposal releases through the same stop path
 * (`TuiApp.dispose()` calls `stop()`). The slot is deliberately NOT held
 * through a stop: the existing headless suite exercises many sequential
 * start/stop surfaces per process, and a stopped surface is not live —
 * only a concurrently LIVE second surface is the hazard.
 *
 * This is a host-side guard over the vendored singleton, NOT a
 * re-vendoring of the fork's keybinding manager (which stays upstream-
 * shaped; plan §10 explicitly excludes a generalized per-instance
 * KeybindingsManager refactor).
 * @module @xmoon76/dsh-pi-tui/process-tui-slot
 */

/** The number of LIVE (started, not stopped) TuiApps in this process. */
let liveTuiCount = 0

/**
 * Claim the process's single live-TUI slot. Throws deterministically when
 * another TuiApp is already live in this process — a second live surface
 * would silently share the fork's process-global keybinding state.
 * @param surfaceId - the claiming surface's id (diagnostic only).
 */
export function claimProcessTuiSlot(surfaceId: string): void {
  if (liveTuiCount !== 0) {
    throw new Error(
      `dsh-pi-tui supports one live TuiApp per process (pi-tui keybindings are process-global); `
        + `the surface "${surfaceId}" cannot start while another TuiApp is live`,
    )
  }
  liveTuiCount += 1
}

/** Release the process live-TUI slot (idempotent — a double release is a
 * no-op; a release without a claim is a no-op too). */
export function releaseProcessTuiSlot(): void {
  if (liveTuiCount > 0) liveTuiCount -= 1
}

/** Test hook: the current number of live TUIs in this process. */
export function liveTuiCountForTest(): number {
  return liveTuiCount
}
