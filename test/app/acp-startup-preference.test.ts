/**
 * UNIT: the pre-Ready ACP startup preference consumption (PO-1B).
 *
 * `applyAcpStartupPreference` reads the profile-owned
 * `pi-tui-acp-preferences.autoStart` BEFORE Ready and, only when it is strictly
 * `true`, asks the entry-owned controller to bind the listener. The failure
 * taxonomy is fixed: a corrupted composition (missing settings service, missing
 * section, non-boolean value) fails startup loudly, while a failing bind is a
 * bounded `acp-autostart-unavailable` diagnostic that keeps the Host Ready.
 *
 * @module @xmoon76/dsh-pi-tui/app/acp-startup-preference.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import {
  applyAcpStartupPreference,
  type AcpControlController,
} from '../../src/app/remote-process/local-host-entry.ts'
import type { AcpAccessStatus } from '../../src/runtime/acp-access-port.ts'

/** One fake Host context projecting a single settings section (or none). */
function contextWithSettings(descriptor: { ns?: unknown; value?: unknown } | undefined | 'no-service'): Context {
  return {
    get(name: string): unknown {
      if (name !== 'settings') return undefined
      if (descriptor === 'no-service') return undefined
      return {
        describe: () => (descriptor === undefined ? [] : [descriptor]),
      }
    },
  } as unknown as Context
}

/** A controller stub recording the requested enablement and returning one state. */
function controllerReturning(state: () => Promise<AcpAccessStatus>): {
  controller: AcpControlController
  calls: boolean[]
} {
  const calls: boolean[] = []
  const controller = {
    setEnabled: async (enabled: boolean) => { calls.push(enabled); return state() },
    getStatus: async () => ({ state: 'disabled' } as AcpAccessStatus),
    quiesce: () => {},
    close: async () => {},
    cleanupSync: () => {},
  } as unknown as AcpControlController
  return { controller, calls }
}

function collect(): { emit: (record: Record<string, unknown>) => void; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = []
  return { emit: record => { records.push(record) }, records }
}

test('UNIT: a corrupted composition fails startup loudly (never read as Off)', async () => {
  const { controller } = controllerReturning(async () => ({ state: 'enabled' }))
  await assert.rejects(applyAcpStartupPreference(contextWithSettings('no-service'), controller, () => {}),
    /no settings service/u)
  await assert.rejects(applyAcpStartupPreference(contextWithSettings(undefined), controller, () => {}),
    /projects no "pi-tui-acp-preferences" settings section/u)
  await assert.rejects(
    applyAcpStartupPreference(contextWithSettings({ ns: 'pi-tui-acp-preferences', value: { autoStart: 'yes' } }), controller, () => {}),
    /"pi-tui-acp-preferences.autoStart" is not a boolean/u,
  )
  await assert.rejects(
    applyAcpStartupPreference(contextWithSettings({ ns: 'pi-tui-acp-preferences', value: {} }), controller, () => {}),
    /is not a boolean/u,
  )
})

test('UNIT: autoStart=false binds nothing and records no diagnostic', async () => {
  const { controller, calls } = controllerReturning(async () => ({ state: 'enabled' }))
  const { emit, records } = collect()
  await applyAcpStartupPreference(
    contextWithSettings({ ns: 'pi-tui-acp-preferences', value: { autoStart: false } }),
    controller,
    emit,
  )
  assert.deepEqual(calls, [])
  assert.deepEqual(records, [])
})

test('UNIT: autoStart=true binds once and records the applied fact', async () => {
  const { controller, calls } = controllerReturning(async () => ({ state: 'enabled' }))
  const { emit, records } = collect()
  await applyAcpStartupPreference(
    contextWithSettings({ ns: 'pi-tui-acp-preferences', value: { autoStart: true } }),
    controller,
    emit,
  )
  assert.deepEqual(calls, [true])
  assert.equal(records.length, 1)
  assert.equal(records[0].m4a0, 'acp-autostart')
  assert.equal(records[0].status, 'enabled')
})

test('UNIT: a bind that did not reach enabled is a bounded unavailable diagnostic', async () => {
  const { controller } = controllerReturning(async () => ({ state: 'disabled' }))
  const { emit, records } = collect()
  await applyAcpStartupPreference(
    contextWithSettings({ ns: 'pi-tui-acp-preferences', value: { autoStart: true } }),
    controller,
    emit,
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].m4a0, 'diagnostic')
  assert.equal(records[0].code, 'acp-autostart-unavailable')
  assert.equal(records[0].failure, 'not-enabled')
  assert.equal(records[0].state, 'disabled')
})

test('UNIT: a rejected enable is a mutation-failed diagnostic and never enabled', async () => {
  const controller = {
    setEnabled: async () => { throw new Error('socket in use') },
    getStatus: async () => ({ state: 'disabled' } as AcpAccessStatus),
    quiesce: () => {},
    close: async () => {},
    cleanupSync: () => {},
  } as unknown as AcpControlController
  const { emit, records } = collect()
  await applyAcpStartupPreference(
    contextWithSettings({ ns: 'pi-tui-acp-preferences', value: { autoStart: true } }),
    controller,
    emit,
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].code, 'acp-autostart-unavailable')
  assert.equal(records[0].failure, 'mutation-failed')
  // The exception text (a socket path) must NOT be published.
  assert.equal('error' in records[0], false)
})

test('UNIT: a missing controller is a controller-missing diagnostic', async () => {
  const { emit, records } = collect()
  await applyAcpStartupPreference(
    contextWithSettings({ ns: 'pi-tui-acp-preferences', value: { autoStart: true } }),
    undefined,
    emit,
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].code, 'acp-autostart-unavailable')
  assert.equal(records[0].failure, 'controller-missing')
})
