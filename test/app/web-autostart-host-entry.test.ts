/**
 * The Host cold-boot Web startup preference (M5-W PR-C) — the pre-Ready
 * sequence in `src/app/remote-process/local-host-entry.ts`.
 *
 * Evidence level: L5 unit over the REAL production function with a controlled
 * Host context and record sink. The official Loader/SettingsForms persistence
 * (profile patch -> next-process read) is proven by
 * `test/integration/web-startup-preference.test.ts`; the packed split-process
 * lane proves the two real Host processes.
 *
 * The contract pinned here:
 *  - a `false` preference touches no Web service and emits nothing;
 *  - a `true` preference calls the SAME `piTuiWebAccess.setEnabled(true)`;
 *  - a failed enable NEVER blocks the Host (the caller still publishes Ready)
 *    and emits ONE fixed diagnostic — no exception text, URL, token, cookie or
 *    profile path can ride it;
 *  - a corrupted composition (missing service/section/non-boolean) fails loudly
 *    instead of being read as Off.
 *
 * @module @xmoon76/dsh-pi-tui/test/app/web-autostart-host-entry
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import {
  applyWebStartupPreference,
  type WebAutostartFailure,
} from '../../src/app/remote-process/local-host-entry.ts'
import type { PiTuiWebAccessStatus } from '../../src/runtime/remote/pi-tui-web-access-contract.ts'

/** One recorded control-channel line. */
type Recorded = Record<string, unknown>

/** A controlled Host context: settings describe + the private Web service. */
function fakeContext(options: {
  readonly autoStart?: unknown
  readonly withSection?: boolean
  readonly withSettings?: boolean
  readonly service?: { setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus> } | undefined
  readonly onServiceRead?: () => void
}) {
  const withSettings = options.withSettings ?? true
  const withSection = options.withSection ?? true
  return {
    get(name: string): unknown {
      if (name === 'settings') {
        if (!withSettings) return undefined
        return {
          describe: () => withSection
            ? [{ ns: 'pi-tui-web-preferences', value: { autoStart: options.autoStart ?? false } }]
            : [],
        }
      }
      if (name === 'piTuiWebAccess') {
        options.onServiceRead?.()
        return options.service
      }
      return undefined
    },
  } as unknown as Context
}

async function run(
  options: Parameters<typeof fakeContext>[0],
): Promise<{ records: Recorded[]; enabled: boolean[] }> {
  const records: Recorded[] = []
  const enabled: boolean[] = []
  const service = options.service === undefined
    ? undefined
    : {
        setEnabled: async (value: boolean) => {
          enabled.push(value)
          return options.service!.setEnabled(value)
        },
      }
  await applyWebStartupPreference(
    fakeContext({ ...options, service }),
    record => { records.push(record) },
  )
  return { records, enabled }
}

const SENSITIVE = 'http://127.0.0.1:4321/?token=SECRET-LAUNCH-TOKEN /home/u/.dsh/profiles/pi-tui'

test('an Off preference touches no Web service and records nothing', async () => {
  let serviceRead = 0
  const { records, enabled } = await run({
    autoStart: false,
    onServiceRead: () => { serviceRead += 1 },
  })
  assert.deepEqual(records, [])
  assert.deepEqual(enabled, [])
  assert.equal(serviceRead, 0, 'an Off cold boot must not even resolve the Web service')
})

test('an On preference calls the SAME Host setEnabled(true) and records the reached state', async () => {
  const { records, enabled } = await run({
    autoStart: true,
    service: { setEnabled: async () => ({ state: 'enabled' }) },
  })
  assert.deepEqual(enabled, [true], 'the ONE Host mutation is setEnabled(true)')
  assert.deepEqual(records, [{
    m4a0: 'web-autostart',
    processRole: 'host',
    pid: process.pid,
    phase: 'pre-ready',
    status: 'enabled',
  }])
  assert.doesNotMatch(JSON.stringify(records), /SECRET|token|http:/u)
})

test('a failed Web enable emits ONE fixed redacted diagnostic and never forwards error text', async () => {
  const { records, enabled } = await run({
    autoStart: true,
    service: {
      setEnabled: async () => {
        throw new Error(`failed to mount http://127.0.0.1:4321/?token=SECRET-LAUNCH-TOKEN from /home/u/.dsh/profiles/pi-tui`)
      },
    },
  })
  assert.deepEqual(enabled, [true])
  assert.equal(records.length, 1, 'exactly ONE diagnostic for the bounded failure')
  assert.deepEqual(records[0], {
    m4a0: 'diagnostic',
    processRole: 'host',
    pid: process.pid,
    code: 'web-autostart-unavailable',
    failure: 'mutation-failed' satisfies WebAutostartFailure,
  }, 'the record is a fixed category — no exception text field exists')
  assert.doesNotMatch(JSON.stringify(records), /SECRET|token|http:|127\.0\.0\.1|\.dsh/u,
    'no URL, token, cookie or profile path can ride the pre-Ready diagnostic')
})

test('an unavailable/changing outcome is recorded by the Host state vocabulary only', async () => {
  const unavailable = await run({
    autoStart: true,
    service: { setEnabled: async () => ({ state: 'unavailable', reason: `broken at ${SENSITIVE}` }) },
  })
  assert.deepEqual(unavailable.records, [{
    m4a0: 'diagnostic',
    processRole: 'host',
    pid: process.pid,
    code: 'web-autostart-unavailable',
    failure: 'not-enabled',
    state: 'unavailable',
  }], 'the Host state is carried, the reason text is NOT')
  assert.doesNotMatch(JSON.stringify(unavailable.records), /SECRET|token|http:|\.dsh/u)

  const changing = await run({
    autoStart: true,
    service: { setEnabled: async () => ({ state: 'changing' }) },
  })
  assert.deepEqual(changing.records[0], {
    m4a0: 'diagnostic',
    processRole: 'host',
    pid: process.pid,
    code: 'web-autostart-unavailable',
    failure: 'not-enabled',
    state: 'changing',
  })
})

test('a missing private Web service is a fixed service-missing diagnostic', async () => {
  const { records } = await run({ autoStart: true, service: undefined })
  assert.deepEqual(records, [{
    m4a0: 'diagnostic',
    processRole: 'host',
    pid: process.pid,
    code: 'web-autostart-unavailable',
    failure: 'service-missing',
  }])
})

test('a corrupted preference composition fails loudly instead of reading Off', async () => {
  await assert.rejects(run({ autoStart: true, withSettings: false }), /no settings service/u)
  await assert.rejects(run({ autoStart: true, withSection: false }), /projects no "pi-tui-web-preferences" settings section/u)
  await assert.rejects(run({ autoStart: 'yes' }), /is not a boolean/u)
  await assert.rejects(run({ autoStart: true, service: undefined, withSection: false }),
    /projects no "pi-tui-web-preferences"/u,
    'the configuration check runs before any service call')
})
