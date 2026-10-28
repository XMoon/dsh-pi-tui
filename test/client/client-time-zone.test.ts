/**
 * The Client-local request-zone sampler (`client/time-zone.ts`): the sending
 * TUI process reports the zone ONE human prompt carries, in the strict profile
 * the Host's `time-context` request reader enforces on a durable
 * `UserMessage.source.clientTimeZone`.
 *
 * Every case controls the ambient `TZ` (or the runtime `Intl` itself) instead
 * of depending on the machine's zone, so the assertions are the sampler's
 * contract, never the CI host's locale.
 * @module @xmoon76/dsh-pi-tui/client-time-zone.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalClientTimeZone, clientTimeZone } from '../../src/client/time-zone.ts'

/** Run `body` with the process zone set to `zone`, always restoring the prior one. */
function withProcessZone<T>(zone: string, body: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

test('keeps a canonical IANA zone and UTC unchanged', () => {
  assert.equal(canonicalClientTimeZone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(canonicalClientTimeZone('Europe/Paris'), 'Europe/Paris')
  assert.equal(canonicalClientTimeZone('UTC'), 'UTC')
})

test('refuses every zone the Host request reader would refuse', () => {
  // An offset-only or non-Area/Location name (`TZ=GMT` reports `+00:00`) and a
  // non-canonical name are outside the reader's strict profile.
  assert.equal(canonicalClientTimeZone('+00:00'), undefined)
  assert.equal(canonicalClientTimeZone('GMT'), undefined)
  assert.equal(canonicalClientTimeZone(''), undefined)
  assert.equal(canonicalClientTimeZone(' Asia/Shanghai'), undefined)
  assert.equal(canonicalClientTimeZone('Asia/Shanghai '), undefined)
  // Profile-shaped but not resolvable: the reader's own canonicalization fails.
  assert.equal(canonicalClientTimeZone('Not/AZone'), undefined)
})

test('samples the process zone of THIS send', () => {
  assert.equal(withProcessZone('Asia/Shanghai', () => clientTimeZone()), 'Asia/Shanghai')
  assert.equal(withProcessZone('UTC', () => clientTimeZone()), 'UTC')
})

test('refuses a reported zone the reader would reject instead of sending it', () => {
  // `TZ=GMT` makes Node report the offset-only `+00:00`: writing it to the
  // durable source would make the Host's request reader throw inside the
  // time-context pre-step, so the send must be refused here instead.
  assert.throws(() => withProcessZone('GMT', () => clientTimeZone()), /unusable time zone/u)
})

test('refuses a runtime that reports no zone at all', () => {
  const original = Intl.DateTimeFormat
  const reported = (timeZone: string | undefined): void => {
    ;(Intl as { DateTimeFormat: unknown }).DateTimeFormat = function stub() {
      return { resolvedOptions: () => ({ timeZone }) }
    }
  }
  try {
    reported(undefined)
    assert.throws(() => clientTimeZone(), /reports no time zone/u)
    reported('')
    assert.throws(() => clientTimeZone(), /reports no time zone/u)
  } finally {
    ;(Intl as { DateTimeFormat: unknown }).DateTimeFormat = original
  }
})
