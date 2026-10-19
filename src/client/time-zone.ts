/**
 * Client-local request time-zone sampling (request-zone metadata propagation).
 *
 * The Client runtime is the only authority for the zone one human prompt
 * carries: the official Client samples the same `Intl` fact inside
 * `SessionFace.prompt()`, and the Host validates what arrives (its ordinary
 * session controller and its subagent runtime both canonicalize
 * `clientTimeZone` and refuse an unusable value).
 *
 * {@link clientTimeZone} additionally checks the value against the SAME strict
 * profile the Host's `time-context` request reader enforces on a durable
 * `UserMessage.source.clientTimeZone`. The Direct path has no Host validation
 * between this sample and that durable write, and the reader THROWS on a value
 * outside the profile — a Node `TZ=GMT`, for example, makes `Intl` report the
 * offset-only `+00:00`. Such a value must be refused HERE, before the send,
 * instead of breaking the turn later. The Remote path never calls this module:
 * the official `SessionFace` samples and the Host validates there.
 *
 * @module @xmoon76/dsh-pi-tui/client/time-zone
 */

/** Strict zone profile: `UTC` or an IANA `Area/Location` identifier. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** The actionable remedy for the two refusals below: the process zone IS the
 * prompt's zone, so `TZ` on the TUI process is the one place to set it. */
const TZ_REMEDY = 'set TZ to a valid IANA zone (for example Asia/Shanghai) before starting the TUI'

/**
 * Canonicalize one reported zone the way the Host's request reader will.
 * @param value - the reported zone name.
 * @returns the canonical zone, or `undefined` when the reader would refuse it.
 */
export function canonicalClientTimeZone(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value) return undefined
  if (value !== 'UTC' && !IANA_TIME_ZONE.test(value)) return undefined
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
  if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
  return canonical
}

/**
 * Sample the sending Client runtime's IANA zone for ONE human prompt. Called
 * per submit, at the send point — never cached at startup and never the Host's
 * zone.
 * @returns the canonical zone this prompt carries.
 * @throws when the runtime reports no zone, or one the Host would refuse.
 */
export function clientTimeZone(): string {
  const reported = new Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof reported !== 'string' || reported.length === 0) {
    throw new Error(`the TUI process reports no time zone — ${TZ_REMEDY}`)
  }
  const canonical = canonicalClientTimeZone(reported)
  if (canonical === undefined) {
    throw new Error(`the TUI process reports an unusable time zone ${JSON.stringify(reported)} — ${TZ_REMEDY}`)
  }
  return canonical
}
