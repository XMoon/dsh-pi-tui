/**
 * The authoritative running-profile read for this process — the official Host
 * `profileContext.name` when it is composed, else the Client-local argv scrape
 * (`client/launcher/profile.ts`).
 *
 * `profileContext.name` is the launcher's own profile identity, so it is
 * correct for EVERY launch form: `--profile <name>`, `--profile=<name>`, the
 * positional `dsh <name>`, and `--from-default-profile <name>`. The argv scrape
 * only knows the flag form, which is why it is the fallback for a profile-less
 * mount (tests, an embedded surface) rather than the primary source. Bootstrap
 * composition ownership: it reads one Host context service and nothing else.
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/profile
 */

import { runningProfile } from '../../client/launcher/profile.ts'

/** The one context read {@link hostRunningProfile} needs (a cordis Context satisfies it). */
export interface ProfileContextReadLike {
  get(name: string): unknown
}

/**
 * The profile this process actually runs.
 * @param ctx - the plugin context (or any structural `get`-only stand-in).
 * @param argv - the process argument vector for the fallback path.
 * @param fallback - the default profile for the fallback path.
 * @returns the running profile name.
 */
export function hostRunningProfile(
  ctx: ProfileContextReadLike,
  argv: readonly string[] = process.argv,
  fallback = 'pi-tui',
): string {
  const name = (ctx.get('profileContext') as { readonly name?: string } | undefined)?.name
  return name ?? runningProfile(argv, fallback)
}
