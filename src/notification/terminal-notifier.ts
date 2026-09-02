/**
 * The terminal notification backend (plan §6): turns a completion event
 * into a terminal sequence through an injected writer, so headless tests
 * assert sequences and trigger counts without a real desktop.
 *
 * Methods: `bell` (BEL — the universal fallback), `osc9` (terminal
 * native notification), `osc777` (VTE notify-send compatibility), and
 * `auto` (resolve from the terminal environment with a small, testable
 * rule — never a huge terminal database).
 *
 * SECURITY: every dynamic payload embedded in an OSC sequence is
 * sanitized (ESC / BEL / ST / C0 control chars stripped) — a session
 * title or any future dynamic text can never inject an arbitrary
 * terminal sequence. The v1 copy is a fixed string, which is the safest
 * payload of all.
 * @module @xmoon76/dsh-pi-tui/terminal-notifier
 */

import type { NotificationMethod } from './settings.ts'

/** The writer seam: tests inject a recorder, the runner passes
 * `process.stdout`. */
export interface TerminalNotifierWriter {
  write(sequence: string): void
}

/** The minimal stream surface the writer guard needs. */
export interface GuardedWriteStream {
  write(data: string): unknown
  on(event: 'error', listener: () => void): unknown
}

/** Streams that already carry the guard's error listener. Weakly held —
 * a dead test stream is collectable, and a remount/HMR that wraps the
 * SAME process.stdout again never accumulates a second listener. */
const guardedStreams = new WeakSet<object>()

/**
 * Wrap a writable stream as a notification writer with a process-wide
 * async-error guard. A closed/broken stream (EPIPE) reports its failure
 * ASYNCHRONOUSLY through the stream's `error` event — a synchronous
 * try/catch around `write()` cannot see it, and an `error` event with no
 * listener becomes an uncaught exception that would crash the host. The
 * guard attaches ONE no-op `error` listener per stream (deduplicated in
 * a WeakSet, so repeated runner remounts around the same process.stdout
 * never accumulate listeners or stale closures), and every write —
 * notifications AND the focus-reporting mode writes — rides the same
 * guarded writer.
 *
 * NOTE — this is deliberately a PROCESS-WIDE stdout error policy, not a
 * notification-only protection: once the listener is attached, ANY
 * later process.stdout error is swallowed (the TUI's own frame writes,
 * terminal-title OSC, …), so Node will no longer throw on an unhandled
 * stream 'error'. For an interactive TUI that is the intended semantic
 * (a detached terminal must not EPIPE-crash the whole process). If a
 * unified stdout lifecycle diagnostic/exit policy is wanted later, this
 * guard belongs in a general terminal/process lifecycle layer, not the
 * notification writer.
 */
export function guardedStreamWriter(stream: GuardedWriteStream): TerminalNotifierWriter {
  if (!guardedStreams.has(stream as object)) {
    guardedStreams.add(stream as object)
    stream.on('error', () => {
      // The stream is broken (e.g. the terminal closed): the
      // notification is Client-local UX — swallow the error, never
      // crash the host.
    })
  }
  return {
    write(sequence: string): void {
      stream.write(sequence)
    },
  }
}

/** Strip every terminal-control character from an OSC payload: the ST
 * terminator (`ESC \`) first (its ESC would otherwise leave a lone
 * backslash), then ESC, BEL, every remaining C0 control + DEL, and the
 * C1 controls (`\x80-\x9f` — the 8-bit ST `\x9c` alone can terminate an
 * OSC sequence in 8-bit mode). */
export function sanitizeOscPayload(text: string): string {
  return text
    .replace(/\x1b\\/g, '')
    .replace(/\x1b/g, '')
    .replace(/\x07/g, '')
    .replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '')
}

/**
 * Resolve the `auto` method from the terminal environment. The OSC 9
 * whitelist is aligned with the Codex notification backend (the
 * verified OSC 9 implementations): iTerm2 / WezTerm / Ghostty / Warp
 * / Kitty are recognized — by `TERM_PROGRAM`, by their `TERM` aliases
 * (`xterm-ghostty`, `xterm-kitty`), or by the Kitty window-id env
 * marker. Terminals WITHOUT a confirmed OSC 9 implementation (Apple
 * Terminal, Alacritty, GNOME/Konsole/VTE, VS Code, Windows Terminal,
 * …) deliberately fall through: VTE-based terminals get the
 * notify-send OSC 777 form, everything unknown falls back to `bell`.
 * `auto` is conservative on purpose — unknown means bell, never a
 * guessed OSC 9 (users can always pin `method=osc9` explicitly). */
export function resolveAutoMethod(env: NodeJS.ProcessEnv = process.env): NotificationMethod {
  const program = (env.TERM_PROGRAM ?? '').toLowerCase()
  const term = (env.TERM ?? '').toLowerCase()
  if (
    program === 'iterm.app'
    || program === 'wezterm'
    || program === 'ghostty'
    || program === 'warpterminal'
    || term === 'xterm-ghostty'
    || term === 'xterm-kitty'
    || env.KITTY_WINDOW_ID !== undefined
  ) {
    return 'osc9'
  }
  if (env.VTE_VERSION !== undefined) {
    return 'osc777'
  }
  return 'bell'
}

/**
 * The terminal notification backend. `notify` resolves the effective
 * method (auto → environment rule), sanitizes the payload, and writes
 * exactly one sequence through the injected writer. A throwing writer is
 * the caller's problem — the runner wraps the sink so a notification
 * failure can never crash the TUI.
 */
export class TerminalNotifier {
  private readonly writer: TerminalNotifierWriter

  constructor(writer: TerminalNotifierWriter) {
    this.writer = writer
  }

  /** Emit one completion notification. */
  notify(method: NotificationMethod, title: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
    const resolved = method === 'auto' ? resolveAutoMethod(env) : method
    const safeTitle = sanitizeOscPayload(title)
    const safeBody = sanitizeOscPayload(body)
    switch (resolved) {
      case 'osc9':
        this.writer.write(`\x1b]9;${safeBody}\x07`)
        return
      case 'osc777':
        this.writer.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`)
        return
      case 'bell':
      default:
        this.writer.write('\x07')
        return
    }
  }
}
