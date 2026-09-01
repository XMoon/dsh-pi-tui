import { spawn } from 'node:child_process'

/**
 * Open one external URL with the platform opener (fullscreen OSC 8 link
 * clicks — the alt screen's mouse capture swallows the terminal's native
 * click-to-open, so the host owns link activation; the fork reports the
 * URL through its `openUrl` seam).
 *
 * SECURITY: only http/https URLs ever reach an opener — the OSC 8 href
 * comes from rendered transcript content, and `file:`/custom schemes
 * would hand attacker-controlled strings to a shell helper. Fire-and-
 * forget: opener failures are best-effort (a link click must never
 * disturb the TUI).
 */
export function openExternalUrl(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return

  const { command, args } = openerFor(url.href, process.platform)
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Best-effort: an unavailable opener must never crash the surface.
  }
}

/**
 * The platform opener command line. WINDOWS INJECTION SAFETY (round-2
 * review P1): `cmd /c start` re-parses its command line with shell
 * metacharacter rules, so a transcript-controlled `&` in a query string
 * would split into a second COMMAND. The URL is therefore wrapped in
 * literal double quotes — the WHATWG URL serializer never emits a raw
 * quote/space/control character in href, so the quoted token cannot be
 * escaped — and cmd treats everything inside double quotes as literal.
 */
export function openerFor(href: string, platform: string = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', `"${href}"`] }
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [href] }
  }
  return { command: 'xdg-open', args: [href] }
}
