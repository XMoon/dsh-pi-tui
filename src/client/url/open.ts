import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

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
 * @module @xmoon76/dsh-pi-tui/client/url/open
 */
export function openExternalUrl(rawUrl: string): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return

  try {
    const { command, args } = openerFor(url.href, process.platform)
    // Windows PowerShell must stay attached until its browser request completes.
    const detached = process.platform !== 'win32'
    const child = spawn(command, args, { stdio: 'ignore', detached })
    child.on('error', () => {})
    if (detached) child.unref()
  } catch {
    // Best-effort: an unavailable opener must never crash the surface.
  }
}

/**
 * The platform opener command line. Windows carries the URL as Base64 data in a
 * fixed PowerShell script, then carries that script as an EncodedCommand. The
 * raw URL never enters cmd, a PowerShell source string or any log/diagnostic.
 */
export function openerFor(href: string, platform: string = process.platform, systemRoot = process.env.SystemRoot): { command: string; args: string[] } {
  if (platform === 'win32') {
    if (systemRoot === undefined || !/^[A-Za-z]:[\\/]/u.test(systemRoot)) {
      throw new Error('Windows system root is unavailable')
    }
    const urlData = Buffer.from(href, 'utf8').toString('base64')
    const script = `$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${urlData}'))\r\nStart-Process -FilePath $url -ErrorAction Stop`
    return {
      command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    }
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [href] }
  }
  return { command: 'xdg-open', args: [href] }
}
