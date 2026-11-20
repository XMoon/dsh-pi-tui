/**
 * The ONE Client-local daemon administration capability (M6 UX PR2).
 *
 * PR2 gives the running TUI two EXPLICIT, user-authorized daemon actions:
 * install this Profile's optional user service, and — only on a confirmed
 * whole-Host exit — stop this Profile's Host. Both are already owned by
 * `local-daemon-control.runDaemonControl`; this module is a deliberately thin
 * profile-bound adapter over that ONE authority so no UI/renderer ever
 * constructs an OS command, guesses a PID/profile or holds its own Host state.
 *
 * What this module owns:
 * - binding ONE already-verified official Profile fact set to the existing
 *   `runDaemonControl` verbs `install` and `stop`;
 * - reporting the ORIGINAL result (code/stdout/stderr) unchanged, so the
 *   caller's success claim can only ever rest on the manager/ownership
 *   post-proof `runDaemonControl` already performs.
 *
 * What it deliberately does NOT own: profile discovery (the caller supplies the
 * official `profileContext` / split-Client entry facts), the admin seat, kernel
 * identity, the OS managers, Host readiness, retry policy, or any Host-running
 * cache. It performs NO IO at construction: the manager is only reached when a
 * user actually chose the action.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/local-profile-daemon-admin
 */

import type { DaemonControlDeps, DaemonControlProfile, DaemonControlResult } from './local-daemon-control.ts'
import { resolveProfilePackageRoot } from './daemon-launcher.ts'
import { readInstalledDshVersion } from './local-scope.ts'

/** The verbs PR2 exposes. `status`/`start`/`restart`/`logs`/`uninstall` stay CLI-only. */
export type ProfileDaemonAdminVerb = 'install' | 'stop'

/**
 * The process-local daemon administration port. It is a VALUE passed through
 * the in-process composition only: it never crosses the Remote wire, never
 * reaches an extension API and never appears in a public declaration.
 */
export interface ProfileDaemonAdmin {
  /** The exact official Profile identity these actions address. */
  readonly profile: string
  /**
   * Run ONE already-authorized management verb for {@link profile}.
   * @param verb - the user-selected action.
   * @returns the existing control plane's result, unchanged.
   */
  run(verb: ProfileDaemonAdminVerb): Promise<DaemonControlResult>
}

/** The injectable seam, so a composition test can prove the call shape. */
export interface ProfileDaemonAdminDeps {
  /** The bound run function (production: the existing `runDaemonControl`). */
  readonly run: (verb: ProfileDaemonAdminVerb) => Promise<DaemonControlResult>
}

/**
 * Bind the EXACT official Profile facts to the existing control plane.
 *
 * The profile is captured by value here: callers pass the profile their process
 * composition already verified (the Host `profileContext` on Direct, the split
 * Client entry's official `profileDir`/`dshHome`/`packageRoot`/anchor facts on
 * Daemon). Nothing is re-resolved from argv, cwd or an environment guess later.
 * @param profile - the official Profile facts this process belongs to.
 * @param deps - the bound run seam.
 * @returns the port the Settings follow-up and the final exit root consume.
 */
export function createProfileDaemonAdmin(
  profile: DaemonControlProfile,
  deps: ProfileDaemonAdminDeps,
): ProfileDaemonAdmin {
  const bound = Object.freeze({ ...profile })
  return Object.freeze({
    profile: bound.name,
    run: (verb: ProfileDaemonAdminVerb) => deps.run(verb),
  })
}

/**
 * The production run seam for ONE official Profile. The existing
 * `local-daemon-control` module is imported lazily so that neither a cold
 * launch nor a Settings read pulls the OS managers into the process graph; it
 * also keeps `src/app/bootstrap.ts` free of a static manager dependency.
 * @param profile - the official Profile facts.
 * @returns the unbound run function the port is built over.
 */
export function profileDaemonAdminRun(
  profile: DaemonControlProfile,
  deps: DaemonControlDeps = {},
): (verb: ProfileDaemonAdminVerb) => Promise<DaemonControlResult> {
  return async (verb) => {
    const { runDaemonControl } = await import('./local-daemon-control.ts')
    return await runDaemonControl({ verb }, profile, deps)
  }
}

/** The official Host `profileContext` facts the Direct composition reads. */
export interface DirectProfileContextLike {
  readonly name: string
  readonly dir: string
  readonly home: string
  readonly installAnchor: string
}

/**
 * Resolve the Direct-side admin Profile from the SAME official Host
 * `profileContext` the CLI cold-control path consumes, with the SAME
 * installed-package resolution (`daemon-launcher.resolveProfilePackageRoot` +
 * `readInstalledDshVersion`). This proves the local install capability WITHOUT
 * loading the OS managers: it reads the profile manifest and the installed DSH
 * version only, never a Host/manager probe.
 * @param profileContext - the official Host profile facts.
 * @returns the bound Profile facts, or `undefined` when the installed profile
 *   cannot be proven — the caller then offers no install/stop action (fail
 *   closed) instead of falling back to a guessed identity.
 */export function resolveDirectDaemonAdminProfile(
  profileContext: DirectProfileContextLike,
): DaemonControlProfile | undefined {
  // The ONE official package-root rule the CLI cold-control path owns
  // (`daemon-launcher.resolveProfilePackageRoot`); the launcher module is
  // already part of the Direct composition, so this adds no new start graph.
  const packageRoot = resolveProfilePackageRoot(profileContext.dir)
  return {
    name: profileContext.name,
    dir: profileContext.dir,
    home: profileContext.home,
    installAnchor: profileContext.installAnchor,
    packageRoot,
    dshVersion: readInstalledDshVersion(profileContext.installAnchor),
  }
}