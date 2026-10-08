/**
 * Process/environment theme detection (TS8-E): whether the environment opts
 * out of colour and the `COLORFGBG` background-family parse. This is
 * Client-local process/environment state — the neutral palette vocabulary
 * lives in `domain/display/theme.ts` and the live palette in
 * `tui/theme/runtime.ts`.
 * @module @xmoon76/dsh-pi-tui/client/theme/environment
 */

/**
 * Parse the COLORFGBG env var (VT100/xterm convention: `fg;bg`, sometimes
 * `fg;default;bg`) into a palette family. The LAST token is the background
 * ANSI 16-color index; 0–6 and 8 are dark, everything else (7, 9–15) light
 * (kimi's parseColorFgBg rule).
 * @param value - the raw COLORFGBG value; defaults to the environment.
 * @returns the palette family, or undefined when unset/unparsable.
 */
export function detectThemeFromColorFgBg(value: string | undefined = process.env.COLORFGBG): 'dark' | 'light' | undefined {
  if (value === undefined || value === '') return undefined
  const bgRaw = value.split(';').at(-1)
  if (bgRaw === undefined) return undefined
  const bg = Number.parseInt(bgRaw, 10)
  if (!Number.isInteger(bg)) return undefined
  const darkBackgrounds = new Set([0, 1, 2, 3, 4, 5, 6, 8])
  return darkBackgrounds.has(bg) ? 'dark' : 'light'
}

/**
 * Whether the environment opts out of colour (NO_COLOR, FORCE_COLOR=0, CI):
 * auto-detection then stays on the dark palette without querying the
 * terminal (kimi detect.ts parity).
 */
export function themeOptOut(): boolean {
  const env = process.env
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true
  if (env.FORCE_COLOR === '0') return true
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0') return true
  return false
}
