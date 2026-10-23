/**
 * The profile-wide Visual tools switch over the REAL Remote wire.
 *
 * ```text
 * /settings decision state (production RemoteConfigPort.visualTools)
 *   -> generated Client `settings.describe` / `settings.mutate`
 *   -> real Typert gateway / in-process carrier
 *   -> Host SettingsController -> official SettingsForms
 *   -> real ConfigEditor/USER profile document write
 *   -> real Loader volatile commit -> loader/volatile-update
 *   -> official Host ToolRuntime register/unregister
 * ```
 *
 * FIXTURE MANIFEST
 * - REAL: `createRemoteApplicationHostFixture` (rc.2 Host services, persistence,
 *   storage, credentials, jobs, gateway, Loader, AgentLoop harness), the shared
 *   `test/support/visual-tools-plane.ts` configuration plane (production Host
 *   row + official ConfigEditor/SettingsForms over a disposable profile), the
 *   production Remote Host composition, the real generated Client runtime and
 *   the production Remote config adapter.
 * - STAND-INS: the fixture's ordinary readiness values (agent default model,
 *   web server) and the unsupported prompt-serializer test double — neither is
 *   on this path. No model turn runs.
 * - ABSENT: a physical browser/GUI and a real user DSH_HOME.
 * @module @xmoon76/dsh-pi-tui/test/integration/visual-tools-remote-wire
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { createRemoteClientRuntime } from '../../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime } from '../../src/app/remote/host-runtime.ts'
import { createRemoteBackendRuntime } from '../../src/app/remote/runtime.ts'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import { CHART_TOOL_NAME, SVG_TOOL_NAME } from '../../src/app/host/visual-tools.ts'
import {
  createRemoteApplicationHostFixture,
  testPromptSerializer,
} from '../support/remote-application-fixture.ts'
import { mountVisualToolsSettingsPlane, VISUAL_TOOLS_ROW_ID } from '../support/visual-tools-plane.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** The Host Settings service surface this suite drives for the external-writer
 *  negative control (the same official service the Remote controller uses). */
interface HostSettings {
  describe(): readonly { ns: string; revision?: number }[]
  mutate(
    ns: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    expectedRevision?: number,
  ): Promise<unknown>
}

test('a Remote Confirm toggles the real Host tool registry through the generated settings wire', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'visual-tools-remote-wire')
  await mountVisualToolsSettingsPlane(host.ctx, join(host.workRoot, 'visual-tools-plane'))

  // The Host itself starts from the schema default: both tools are registered
  // before any Client exists.
  assert.notEqual(host.ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(host.ctx.tools.get(SVG_TOOL_NAME), undefined)
  const hostSettings = (host.ctx as unknown as { settings: HostSettings }).settings
  assert.equal(
    (hostSettings.describe().find(entry => entry.ns === VISUAL_TOOLS_ROW_ID) as { value?: { enabled?: boolean } } | undefined)?.value?.enabled,
    true,
    'the Host form projects the default On',
  )

  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const assembled = await createRemoteBackendRuntime({
    runtime: client,
    promptSerializer: testPromptSerializer,
    fetch: hostRuntime.carrier.fetch,
  })
  t.after(async () => {
    assembled.dispose()
    await client.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  })

  const config = assembled.backend.config
  assert.ok(config instanceof RemoteConfigPort, 'the assembled backend uses the production Remote config adapter')
  assert.equal(config.configReadiness(), 'ready', 'the Remote mirror reached the Host settings plane')

  const initial = config.visualTools.read()
  assert.ok(initial !== undefined, 'the mirrored visual-tools section is readable')
  assert.equal(initial.enabled, true)
  assert.equal(initial.userOverridden, false)
  assert.equal(initial.applied, undefined, 'the wire publishes no Host registry read, so runtime state is unobservable')

  // Off over the REAL wire: the generated settings.mutate reaches the Host
  // SettingsForms, the Loader commits the volatile value and the Host row
  // unregisters both tools.
  await config.visualTools.setEnabled(false, initial.revision)
  assert.equal(config.configReadiness(), 'ready', 'the post-write mirror refresh stayed current')
  const off = config.visualTools.read()
  assert.equal(off?.enabled, false)
  assert.equal(off?.userOverridden, true, 'the Host USER layer owns the persisted Off')
  assert.equal(host.ctx.tools.get(CHART_TOOL_NAME), undefined, 'the Host registry followed the Remote write')
  assert.equal(host.ctx.tools.get(SVG_TOOL_NAME), undefined)

  // On over the same wire: both definitions return.
  assert.ok(off !== undefined)
  await config.visualTools.setEnabled(true, off.revision)
  assert.notEqual(host.ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(host.ctx.tools.get(SVG_TOOL_NAME), undefined)

  // Stale-before-confirm: an external Host writer lands between the Remote
  // decision read and the Confirm, so the decision revision must be refused
  // instead of silently overwriting it.
  const stale = config.visualTools.read()
  assert.ok(stale !== undefined)
  assert.equal(stale.enabled, true)
  const live = hostSettings.describe().find(entry => entry.ns === VISUAL_TOOLS_ROW_ID)
  await hostSettings.mutate(VISUAL_TOOLS_ROW_ID, [{ op: 'set', path: ['enabled'], value: false }], live?.revision)
  assert.equal(host.ctx.tools.get(CHART_TOOL_NAME), undefined, 'the external Off reached the registry')
  await assert.rejects(
    config.visualTools.setEnabled(true, stale.revision),
    /changed since it was read/u,
    'the stale Remote decision can never overwrite the external edit',
  )
  assert.equal(config.visualTools.read()?.enabled, false, 'the external value remains authoritative')
  assert.equal(host.ctx.tools.get(CHART_TOOL_NAME), undefined, 'the stale write never re-registered the tools')
})
