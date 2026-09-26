/**
 * The DSH launcher PROFILE identity and the resume hint (plan §27).
 *
 * Deliberately NOT part of `src/startup.ts`: the startup row is a
 * zero-dependency island that must not share a bundle chunk with the runner,
 * so these runner-side helpers live in their own module and the entry
 * re-exports them unchanged.
 * @module @xmoon76/dsh-pi-tui/dsh-profile
 */
/**
 * The dsh profile named by the `--profile` flag in `argv`, in both spellings.
 * This is the ARGV-ONLY fallback: it cannot see the positional `dsh <name>`
 * launch form, because the launcher consumes that bare name by synthesizing
 * `['--profile', ...argv]` for its OWN commander parse and leaves
 * `process.argv` untouched. Prefer {@link hostRunningProfile}, which reads the
 * Host's profile identity instead of scraping the command line.
 * @param argv - the process argument vector.
 * @param fallback - the default profile.
 */
export function runningProfile(argv: readonly string[] = process.argv, fallback = 'pi-tui'): string {
  // Scan backwards: like commander, the LAST occurrence wins.
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]!
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
    if (arg === '--profile' && i + 1 < argv.length && argv[i + 1] !== undefined && argv[i + 1] !== '') {
      return argv[i + 1]!
    }
  }
  return fallback
}

/** The one context read {@link hostRunningProfile} needs (a cordis Context satisfies it). */
export interface ProfileContextReadLike {
  get(name: string): unknown
}

/**
 * The profile this process actually runs — the official Host
 * `profileContext.name` when it is composed, else {@link runningProfile}'s
 * argv scrape.
 *
 * `profileContext.name` is the launcher's own profile identity, so it is
 * correct for EVERY launch form: `--profile <name>`, `--profile=<name>`, the
 * positional `dsh <name>`, and `--from-default-profile <name>`. The argv
 * scrape only knows the flag form, which is why it is the fallback for a
 * profile-less mount (tests, an embedded surface) rather than the primary
 * source.
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

/**
 * The interactive-quit resume hint (pi parity): `dsh --profile <p>
 * --session <id>`, printed after the terminal restores so the user can
 * re-enter the session later. Returns undefined when there is no session
 * to resume (deferred start never created one).
 * @param profile - the running profile ({@link hostRunningProfile}).
 * @param sessionId - the live session id.
 * @returns the resume command line, or undefined without a session.
 */
export function resumeCommand(profile: string, sessionId: string): string | undefined {
  const id = sessionId.trim()
  if (id === '') return undefined
  return `dsh --profile ${profile} --session ${id}`
}
