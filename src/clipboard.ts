/**
 * Reliable clipboard WRITE (issue #7).
 *
 * The fullscreen drag selection and the `/copy` command share ONE copy
 * policy, because a bare OSC 52 write is a silent lie in tmux
 * (`set-clipboard external`), SSH chains without passthrough, and
 * terminals that restrict OSC 52 (VTE, Terminal.app): the UI flashed
 * `Copied!` while the system clipboard never changed.
 *
 * The policy, in order:
 *
 * 1. **tmux** (`$TMUX` set): `tmux load-buffer -w -` with the text on
 *    stdin. tmux owns the clipboard write — it works with
 *    `set-clipboard external` (tmux pushes to the terminal clipboard
 *    itself) and never depends on OSC 52 passthrough inside the pane.
 *    A non-zero exit falls through to the platform helpers.
 * 2. **Platform helper**: `pbcopy` (macOS), `wl-copy` (Wayland),
 *    `xclip -selection clipboard` then `xsel --clipboard --input`
 *    (X11), `clip` (Windows). Each helper is gated on its presence
 *    (PATH-aware) and its display environment, so a Wayland+XWayland
 *    session without wl-copy still reaches xclip.
 * 3. **OSC 52 fallback**: only when a TTY is present. OSC 52 has no
 *    reliable ACK, so this is BEST-EFFORT: returning `true` here means
 *    "the escape sequence was written", never "the system clipboard
 *    changed". The caller's `Copied!` flash is therefore only truthful
 *    for the tmux/platform paths; the fallback keeps upstream's
 *    optimistic feedback by design (documented in the plan §2.3.C).
 *    Inside tmux the sequence is wrapped in a DCS passthrough with
 *    doubled ESC bytes (the kimi-code `buildClipboardOSC52` convention),
 *    because tmux swallows bare OSC sequences — the passthrough lets the
 *    terminal emulator behind tmux receive the copy request.
 *
 * Every subprocess runs through an injected {@link CopyExecutor} and
 * every platform fact through a {@link CopyEnvironment}, so the decision
 * trees are exercised with mocks in CI (test/clipboard.test.ts) and the
 * runner wires the real execFile-backed executor once (src/index.ts).
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
  /** Whether stdout is a TTY — the OSC 52 fallback needs a terminal. */
  readonly isTTY: () => boolean
  /** Write the OSC 52 clipboard escape sequence (best-effort fallback). */
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
 * Copy `text` to the system clipboard through the shared policy (tmux →
 * platform helper → OSC 52). Returns whether the copy is believed to have
 * succeeded; the OSC 52 path is best-effort (see the module doc).
 */
export async function copyToClipboard(text: string, run: CopyExecutor, env: CopyEnvironment): Promise<boolean> {
  // A. tmux owns the clipboard when present: `load-buffer -w -` writes
  // the tmux buffer AND pushes it to the terminal clipboard, so
  // `set-clipboard external` works without any pane-side OSC 52
  // passthrough. A failure falls through — never an error by itself.
  if (env.env.TMUX !== undefined) {
    if (await tryRun(run, 'tmux', ['load-buffer', '-w', '-'], text)) return true
  }
  // B. Local platform helpers.
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
  // C. OSC 52 best-effort fallback: the sequence was WRITTEN, not
  // acknowledged — the terminal may still drop it (tmux external without
  // passthrough, restricted terminals). Kept as the last resort so remote
  // sessions without local helpers still get the upstream behavior.
  if (env.isTTY()) {
    try {
      env.writeOsc52(text)
    } catch {
      // A failing stdout write means the sequence never left the process:
      // the copy did not even reach best-effort status (round-2 finding).
      return false
    }
    return true
  }
  return false
}
