/**
 * Reliable clipboard WRITE (issue #7).
 *
 * ONE policy serves every copy intent: the fullscreen drag selection and
 * the `/copy` command both call {@link copyToClipboard}. The clipboard
 * belongs to the terminal client the user is actually interacting with —
 * a local terminal, tmux, an SSH chain, a container, or a remote terminal
 * transport (ORCA/xterm.js) — and the Direct/Remote BACKEND mode does NOT
 * tell us which. So the policy delivers through two INDEPENDENT legs and
 * never lets one suppress the other:
 *
 * 1. **terminal-client leg** — the OSC 52 sequence written to stdout
 *    (gated on a TTY; inside tmux the existing DCS passthrough form).
 *    OSC 52 has no reliable ACK, so a successful write means "the sequence
 *    was EMITTED", never "the user's clipboard changed": best-effort by
 *    construction.
 * 2. **native/helper leg** — tmux → platform helper (`pbcopy` macOS,
 *    `wl-copy` Wayland, `xclip`/`xsel` X11, `clip` Windows). This is the
 *    local-desktop compatibility path for terminals that restrict OSC 52.
 *    A helper success is a local compatibility signal ONLY: it must never
 *    stop the terminal-client leg. On a remote host a successful
 *    `tmux load-buffer`/`wl-copy` would otherwise short-circuit the copy
 *    and strand the text in the remote host clipboard, which the user
 *    cannot paste from.
 *
 * The overall result is the OR of the two legs — either delivery
 * succeeding is a copy (a failed OSC 52 write must not fail a native
 * success, and a failed native helper must not fail an emitted OSC 52).
 *
 * Every subprocess runs through an injected {@link CopyExecutor} and every
 * platform fact through a {@link CopyEnvironment}, so the decision trees
 * are exercised with mocks in CI (test/clipboard.test.ts) and the runner
 * wires the real execFile-backed executor once (src/index.ts).
 * @module @xmoon76/dsh-pi-tui/clipboard
 */

/** The command runner abstraction (CI injects mocks). The text payload is
 * piped to the command's stdin. */
export interface CopyExecutor {
  (
    command: string,
    args: readonly string[],
    input: string,
  ): Promise<{ code: number }>
}

/** Platform facts the copy decision tree reads. */
export interface CopyEnvironment {
  readonly platform: string
  readonly env: Record<string, string | undefined>
  /** PATH-aware helper detection (see commandOnPath in image/clipboard.ts). */
  readonly exists: (command: string) => boolean
  /** Whether stdout is a TTY — the OSC 52 leg needs a terminal. */
  readonly isTTY: () => boolean
  /** Write the OSC 52 clipboard escape sequence (inside tmux: passthrough). */
  readonly writeOsc52: (text: string) => void
}

/** Run one helper; a non-zero exit or a throwing executor is a miss. */
async function tryRun(run: CopyExecutor, command: string, args: readonly string[], input: string): Promise<boolean> {
  try {
    const result = await run(command, args, input)
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Build the OSC 52 clipboard sequence for `text`. Inside tmux the bare
 * sequence would be swallowed, so it is wrapped in a DCS passthrough with
 * doubled ESC bytes (the kimi-code `buildClipboardOSC52` convention) —
 * the terminal emulator behind tmux then receives the copy request.
 */
export function buildOsc52Sequence(text: string, insideTmux: boolean): string {
  const payload = Buffer.from(text, 'utf8').toString('base64')
  const sequence = `\x1b]52;c;${payload}\x07`
  if (!insideTmux) return sequence
  const escaped = sequence.replaceAll('\x1b', '\x1b\x1b')
  return `\x1bPtmux;${escaped}\x1b\\`
}

/**
 * The terminal-client leg: emit the OSC 52 sequence when a TTY is present.
 * Returns whether the sequence was WRITTEN (best-effort — no ACK exists).
 * Deliberately synchronous and light: it must never wait on a host
 * subprocess probe.
 */
function emitTerminalClipboard(text: string, env: CopyEnvironment): boolean {
  if (!env.isTTY()) return false
  try {
    env.writeOsc52(text)
  } catch {
    // A failing stdout write means the sequence never left the process.
    return false
  }
  return true
}

/**
 * The native/helper leg: the local-desktop compatibility chain. Returns
 * whether one helper ACCEPTED the text (a local signal only — never proof
 * that the user's terminal clipboard changed). This leg is independent of
 * the terminal-client leg and cannot suppress it.
 */
async function tryNativeClipboard(text: string, run: CopyExecutor, env: CopyEnvironment): Promise<boolean> {
  // tmux owns a local buffer when present: `load-buffer -w -` writes the
  // tmux buffer AND pushes it to the terminal clipboard where supported.
  if (env.env.TMUX !== undefined) {
    if (await tryRun(run, 'tmux', ['load-buffer', '-w', '-'], text)) return true
  }
  if (env.platform === 'darwin') {
    if (await tryRun(run, 'pbcopy', [], text)) return true
  } else if (env.platform === 'win32') {
    if (await tryRun(run, 'clip', [], text)) return true
  } else {
    // POSIX: each helper is gated on its display environment AND its
    // presence, so a Wayland+XWayland session without wl-copy still
    // reaches xclip (same independence rule as the image probe).
    if (env.env.WAYLAND_DISPLAY !== undefined && env.exists('wl-copy')) {
      if (await tryRun(run, 'wl-copy', [], text)) return true
    }
    if (env.env.DISPLAY !== undefined) {
      if (env.exists('xclip') && await tryRun(run, 'xclip', ['-selection', 'clipboard'], text)) return true
      if (env.exists('xsel') && await tryRun(run, 'xsel', ['--clipboard', '--input'], text)) return true
    }
  }
  return false
}

/**
 * Copy `text` to the user's clipboard through the shared policy. Both legs
 * are attempted where applicable (terminal-client first — it is cheap and
 * must not wait on a helper probe), and the copy succeeds when EITHER leg
 * does. See the module doc for the delivery model.
 */
export async function copyToClipboard(text: string, run: CopyExecutor, env: CopyEnvironment): Promise<boolean> {
  const terminalEmitted = emitTerminalClipboard(text, env)
  const nativeAccepted = await tryNativeClipboard(text, run, env)
  return terminalEmitted || nativeAccepted
}
