/**
 * The ONE OSC 7577 admission gate shared by the Direct root, the daemon
 * supervisor and the Client entry. `DSH_PI_TUI_RENDERER=tsp` is an explicit
 * renderer opt-in: even when the SDK later declines and PiTui fallback mounts,
 * the boot is still a TSP attempt and must not publish a program-resume record.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/program-resume-admission
 */

import { tspRequested } from './renderer-selection.ts'

/** True only when this boot never requested the experimental TSP renderer. */
export function programResumeAdmitted(env: { readonly DSH_PI_TUI_RENDERER?: string | undefined }): boolean {
  return !tspRequested(env)
}

/**
 * Build a capability only when this boot is admitted. A TSP opt-in never
 * invokes the builder, so the fallback cannot create a reporter later.
 */
export function admitProgramResume<T>(
  env: { readonly DSH_PI_TUI_RENDERER?: string | undefined },
  build: () => T | undefined,
): T | undefined {
  return programResumeAdmitted(env) ? build() : undefined
}
