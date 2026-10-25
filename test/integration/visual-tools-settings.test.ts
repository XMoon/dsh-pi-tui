/**
 * The profile-wide Visual tools switch over the REAL DSH configuration plane.
 *
 * ```text
 * /settings decision state (DirectConfigPort.visualTools)
 *   -> official SettingsForms.mutate('pi-tui-visual-tools', [{ set enabled }])
 *   -> real ConfigEditor/USER profile document write
 *   -> real Loader volatile commit into the running row reference
 *   -> loader/volatile-update on the visual-tools fiber
 *   -> official ToolRuntime register/unregister
 * ```
 *
 * FIXTURE MANIFEST
 * - REAL: the Loader root Include over a disposable profile + bundle, the
 *   official ConfigEditor and SettingsForms, the production
 *   `src/app/host/visual-tools.ts` row (a thin ESM re-export shim is the only
 *   fixture module), the real ToolRuntime registry and the production Direct
 *   config adapter.
 * - STAND-INS: the `systemPrompt` service (the registry only needs its
 *   registration surface; no model turn runs) and the fixture's outside-Git
 *   profile paths are disposable test roots.
 * - ABSENT: a model turn, a Remote Host and a real user DSH_HOME.
 * @module @xmoon76/dsh-pi-tui/test/integration/visual-tools-settings
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ToolRuntime, { defineTool, renderToolsSdk } from '@deepseek-ai/dsh-tools'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import {
  CHART_TOOL_NAME,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../src/app/host/visual-tools.ts'
import { VISUAL_TOOLS_STATUS_SERVICE } from '../../src/domain/visual/runtime-status.ts'
import {
  mountVisualToolsSettingsPlane,
  VISUAL_TOOLS_ROW_ID as ROW_ID,
} from '../support/visual-tools-plane.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

/** The PTC SDK rendering of the CURRENT Host registry: the same definitions a
 *  PTC-mode request presents to the model. */
function ptcSdkOf(ctx: Context): string {
  const schemas = ctx.tools.schemas().flatMap((schema) => {
    const definition = ctx.tools.get(schema.name)
    return definition === undefined
      ? []
      : [{
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: definition.output.schema,
        }]
  })
  return renderToolsSdk(schemas)
}

interface Plane {
  readonly ctx: Context
  readonly port: DirectConfigPort
  readonly profileDir: string
  dispose(): Promise<void>
}

/** The services the production visual row injects besides the registry.
 *  This plane never runs a model turn, so the Agent/Session reads are minimal
 *  structural stand-ins: the row only needs them to be PRESENT for the Loader
 *  to activate it. */
function provideVisualRowDependencies(ctx: Context): void {
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessionQuery', {
    observeSession: async () => { throw new Error('this plane never observes a Session') },
  } as never)
  ctx.provide('sessionProjections', { stateOf: () => undefined } as never)
}

async function bootPlane(life: TestLifecycle, root: string, resetUserDocument = false): Promise<Plane> {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools: () => {},
    section: () => () => {},
  } as never)
  provideVisualRowDependencies(ctx)
  new ToolRuntime(ctx)
  await ctx.plugin(Loader)
  const { profileDir } = await mountVisualToolsSettingsPlane(ctx, root, { resetUserDocument })
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  life.defer(dispose)
  return { ctx, port: new DirectConfigPort(ctx, undefined, () => undefined), profileDir, dispose }
}

function settingsDescriptor(plane: Plane): {
  readonly ns: string
  readonly value?: Record<string, unknown>
  readonly user?: Record<string, unknown>
} | undefined {
  return (plane.ctx as unknown as {
    settings: { describe(): readonly { ns: string; value?: Record<string, unknown>; user?: Record<string, unknown> }[] }
  }).settings.describe().find(entry => entry.ns === ROW_ID)
}

/** The switch facts the UI would project (the revision is dynamic, so the
 *  semantic fields are compared individually). */
function expectVisualState(
  port: DirectConfigPort,
  expected: { readonly enabled: boolean; readonly userOverridden: boolean; readonly applied: boolean | undefined },
): void {
  const state = port.visualTools.read()
  assert.ok(state !== undefined, 'the Host visual tools switch must be readable')
  assert.equal(state.enabled, expected.enabled)
  assert.equal(state.userOverridden, expected.userOverridden)
  assert.equal(state.applied, expected.applied)
  assert.equal(typeof state.revision, 'number', 'the decision fence is a real Host revision')
}

/** Submit one switch decision at the revision its CURRENT state was read at
 *  (the real UI carries the revision captured when the choice opened). */
async function submitVisualTools(port: DirectConfigPort, enabled: boolean): Promise<void> {
  const state = port.visualTools.read()
  assert.ok(state !== undefined, 'the switch state must be readable before a write')
  await port.visualTools.setEnabled(enabled, state.revision)
}

test('a default profile exposes all three visual tools and a live Off write unregisters the exact group', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('visual-tools-plane-'))
  const { ctx, port } = plane
  // An UNRELATED resident tool: the switch must never disturb the rest of the
  // global registry, and the PTC SDK proves the full list, not only names.
  ctx.tools.register(defineTool({
    name: 'probe_unrelated_tool',
    description: 'an unrelated Host tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'unrelated',
  }))

  // Default On comes from the Host Config schema, not from a USER document.
  expectVisualState(port, { enabled: true, userOverridden: false, applied: true })
  const descriptor = settingsDescriptor(plane)
  assert.equal(descriptor?.value?.enabled, true, 'the Host Settings form projects the effective On')
  assert.equal(descriptor?.user?.enabled, undefined, 'no USER override was required for the default')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME)?.description.includes('Render a small static chart'), true)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME)?.description.includes('Render one static, self-contained SVG'), true)
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME)?.description.includes('Select previously generated'), true)
  const sdkWhileOn = ptcSdkOf(ctx)
  assert.match(sdkWhileOn, /dsh_pi_tui_chart/u, 'the PTC SDK lists the chart tool')
  assert.match(sdkWhileOn, /dsh_pi_tui_svg/u, 'the PTC SDK lists the SVG tool')
  assert.match(sdkWhileOn, /present_visual/u, 'the PTC SDK lists the publication tool')
  assert.match(sdkWhileOn, /probe_unrelated_tool/u, 'the PTC SDK lists unrelated resident tools too')
  const schemasWhileOn = ctx.tools.schemas().filter(schema => schema.name !== 'probe_unrelated_tool')

  // Off: the official revision-checked write, the Loader volatile commit and
  // the row's disposers must all land on the same Host.
  await submitVisualTools(port, false)
  expectVisualState(port, { enabled: false, userOverridden: true, applied: false })
  assert.equal(settingsDescriptor(plane)?.user?.enabled, false, 'the USER layer owns the persisted Off')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined)
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name),
    ['probe_unrelated_tool'],
    'the next request catalog loses all three visual schemas and keeps the unrelated tool',
  )
  const sdkWhileOff = ptcSdkOf(ctx)
  assert.doesNotMatch(sdkWhileOff, /dsh_pi_tui_chart/u)
  assert.doesNotMatch(sdkWhileOff, /dsh_pi_tui_svg/u)
  assert.doesNotMatch(sdkWhileOff, /present_visual/u)
  assert.match(sdkWhileOff, /probe_unrelated_tool/u, 'the unrelated tool stays visible to PTC')
  assert.notEqual(ctx.get(VISUAL_TOOLS_STATUS_SERVICE), undefined, 'the Host row itself stays loaded')

  // On again on the SAME Host: the original definitions are restored exactly
  // once, with their original schema text.
  await submitVisualTools(port, true)
  expectVisualState(port, { enabled: true, userOverridden: true, applied: true })
  const visualSchemasBack = ctx.tools.schemas().filter(schema => schema.name !== 'probe_unrelated_tool')
  assert.deepEqual(visualSchemasBack, schemasWhileOn, 'the re-registered definitions are byte-identical')
  assert.equal(visualSchemasBack.filter(schema => schema.name === CHART_TOOL_NAME).length, 1)
  assert.equal(visualSchemasBack.filter(schema => schema.name === SVG_TOOL_NAME).length, 1)
  assert.equal(visualSchemasBack.filter(schema => schema.name === PRESENT_VISUAL_TOOL_NAME).length, 1)
  const sdkBackOn = ptcSdkOf(ctx)
  assert.match(sdkBackOn, /dsh_pi_tui_chart/u)
  assert.match(sdkBackOn, /dsh_pi_tui_svg/u)
  assert.match(sdkBackOn, /probe_unrelated_tool/u)
})

test('a persisted Off survives a Host restart with no tools registered and no other profile pollution', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('visual-tools-restart-')
  const first = await bootPlane(life, root, true)
  await submitVisualTools(first.port, false)
  assert.equal(first.port.visualTools.read()?.applied, false)
  await first.dispose()

  const second = await bootPlane(life, root)
  expectVisualState(second.port, { enabled: false, userOverridden: true, applied: false })
  assert.equal(second.ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(second.ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(second.ctx.tools.schemas(), [])

  // Only the visual-tools entry carries the profile write: the TUI settings
  // document and every other namespace stay untouched.
  const namespaces = (second.ctx as unknown as {
    settings: { describe(): readonly { ns: string; user?: Record<string, unknown> }[] }
  }).settings.describe()
  assert.deepEqual(namespaces.map(entry => entry.ns), [ROW_ID])
  assert.equal(second.profileDir, first.profileDir)
})

test('a re-enable blocked by a foreign same-name definition stays atomic and reports not applied', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('visual-tools-conflict-'))
  const { ctx, port } = plane
  await submitVisualTools(port, false)

  const foreign = ctx.tools.register(defineTool({
    name: CHART_TOOL_NAME,
    description: 'foreign chart owner',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'foreign',
  }))

  // The persisted value commits (the Loader catches a throwing volatile
  // listener), but the row's own status reports the truth: no live group.
  await submitVisualTools(port, true)
  expectVisualState(port, { enabled: true, userOverridden: true, applied: false })
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined, 'the SVG registration was rolled back')
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined, 'the publication registration was rolled back')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME)?.description, 'foreign chart owner', 'the foreign definition was not shadowed')

  // Releasing the foreign owner and toggling Off -> On applies the group again.
  foreign()
  await submitVisualTools(port, false)
  await submitVisualTools(port, true)
  expectVisualState(port, { enabled: true, userOverridden: true, applied: true })
  assert.deepEqual(
    ctx.tools.schemas().map(schema => schema.name).sort(),
    [CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME].sort(),
  )
})

test('a Confirm based on a stale revision is refused and the external edit survives', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('visual-tools-stale-'))
  const decision = plane.port.visualTools.read()
  assert.ok(decision !== undefined)
  assert.equal(decision.enabled, true)

  // An external writer turns the switch Off after the UI read its decision
  // state but before the user's Confirm reaches the Host.
  const forms = (plane.ctx as unknown as {
    settings: {
      describe(): readonly { ns: string; revision?: number }[]
      mutate(
        ns: string,
        ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
        expectedRevision?: number,
      ): Promise<unknown>
    }
  }).settings
  const live = forms.describe().find(entry => entry.ns === ROW_ID)
  await forms.mutate(ROW_ID, [{ op: 'set', path: ['enabled'], value: false }], live?.revision)
  expectVisualState(plane.port, { enabled: false, userOverridden: true, applied: false })

  // The stale decision's revision is the fence: the official write refuses it.
  await assert.rejects(
    plane.port.visualTools.setEnabled(true, decision.revision),
    /changed since it was read/u,
    'a stale Confirm can never overwrite the external edit',
  )
  expectVisualState(plane.port, { enabled: false, userOverridden: true, applied: false })
  assert.equal(plane.ctx.tools.get(CHART_TOOL_NAME), undefined, 'the external Off stays applied')
})
