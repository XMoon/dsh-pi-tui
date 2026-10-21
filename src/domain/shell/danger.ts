/**
 * The destructive-shell predicate the approval dialog uses (kimi-inspired).
 * Transport/UI-neutral: it answers exactly one question — whether one shell
 * command matches a known destructive pattern — and owns nothing else.
 * @module @xmoon76/dsh-pi-tui/domain/shell/danger
 */

/** Shell commands the approval dialog flags as dangerous (kimi-inspired). */
const DANGER_PATTERNS: readonly RegExp[] = [
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /^:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bgit\s+push\b[^\n|;]*(--force\b|\s-f\b)/,
  /\b(shutdown|reboot|poweroff|init\s+0)\b/,
  />+\s*\/dev\/sd/,
  /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/,
]

/**
 * Whether a shell command matches a destructive pattern. `rm` is treated
 * specially: any spelling of recursive + force flags (`rm -rf`, `rm -r -f`,
 * `rm -rf /`) is dangerous; the remaining patterns are verbatim matches.
 */
export function dangerCommand(command: string): boolean {
  // Slice the flags from the WORD-BOUNDED rm match itself: slicing from the
  // first "rm" substring (e.g. inside "alarm") would read flags from the
  // wrong offset and both miss and misfire depending on what follows.
  const rm = /\brm\b/i.exec(command)
  if (rm !== null) {
    const flags = command.slice(rm.index + rm[0].length)
    const combined = flags.match(/-\w+/g)?.join('') ?? ''
    if (combined.includes('r') && combined.includes('f')) return true
  }
  return DANGER_PATTERNS.some(pattern => pattern.test(command))
}
