/**
 * The Client-local DSH launcher PROFILE reads: the `--profile` argv scrape and
 * the interactive-quit resume hint.
 *
 * Deliberately NOT part of `src/startup.ts`: the startup row is a
 * zero-dependency island that must not share a bundle chunk with the runner,
 * so these runner-side helpers live in their own module. The authoritative
 * Host profile identity (`hostRunningProfile`) is application bootstrap
 * ownership (`app/bootstrap/profile.ts`) and consumes this argv fallback.
 * @module @xmoon76/dsh-pi-tui/client/launcher/profile
 */
/**
 * The dsh profile named by the `--profile` flag in `argv`, in both spellings.
 * This is the ARGV-ONLY fallback: it cannot see the positional `dsh <name>`
 * launch form, because the launcher consumes that bare name by synthesizing
 * `['--profile', ...argv]` for its OWN commander parse and leaves
 * `process.argv` untouched. Prefer `hostRunningProfile`, which reads the Host's
 * profile identity instead of scraping the command line.
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

/**
 * The interactive-quit resume hint (pi parity): `dsh --profile <p>
 * --session <id>`, printed after the terminal restores so the user can
 * re-enter the session later. Returns undefined when there is no session
 * to resume (deferred start never created one).
 * @param profile - the running profile (`hostRunningProfile`).
 * @param sessionId - the live session id.
 * @returns the resume command line, or undefined without a session.
 */
export function resumeCommand(profile: string, sessionId: string): string | undefined {
  const id = sessionId.trim()
  if (id === '') return undefined
  return `dsh --profile ${profile} --session ${id}`
}
