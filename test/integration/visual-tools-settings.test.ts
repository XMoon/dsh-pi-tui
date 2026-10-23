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
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import {
  CHART_TOOL_NAME,
  SVG_TOOL_NAME,
  VISUAL_TOOLS_STATUS_SERVICE,
} from '../../src/domain/visual/tool-identity.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const BUNDLE = 'visual-tools-fixture-bundle'
const ROW_ID = 'pi-tui-visual-tools'
const PROFILE_PATCH = 'cordis.patch.yml'

interface Plane {
  readonly ctx: Context
  readonly port: DirectConfigPort
  readonly profileDir: string
  dispose(): Promise<void>
}

/** Write the disposable profile/bundle layout once, then mount it for ONE Host
 *  context. The profile patch (the USER document SettingsForms writes) is
 *  deliberately NOT rewritten on a re-mount: the restart case must read the
 *  value the previous Host persisted. */
function writePlane(root: string, resetUserDocument: boolean): string {
  const profileDir = join(root, 'profile')
  const bundleDir = join(root, 'bundle')
  if (!existsSync(join(profileDir, 'package.json'))) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'visual-tools-profile',
      private: true,
      dsh: { profile: { bundles: [BUNDLE], patch: PROFILE_PATCH } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: BUNDLE,
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    }, null, 2))
    // The row module is a one-line re-export of the PRODUCTION Host row: the
    // Loader resolves the schema, apply function and plugin identity from here.
    const rowModule = join(root, 'visual-tools-row.mjs')
    writeFileSync(rowModule, [
      `export { name, inject, Config, apply } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/app/host/visual-tools.ts')).href)}`,
      '',
    ].join('\n'))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${ROW_ID}`,
      `      name: ${JSON.stringify(rowModule)}`,
      '',
    ].join('\n'))
    symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
  }
  const patchPath = join(profileDir, PROFILE_PATCH)
  if (resetUserDocument || !existsSync(patchPath)) writeFileSync(patchPath, '[]\n')
  return profileDir
}

async function bootPlane(life: TestLifecycle, root: string, resetUserDocument = false): Promise<Plane> {
  const profileDir = writePlane(root, resetUserDocument)
  const patchPath = join(profileDir, PROFILE_PATCH)
  const anchor = join(process.cwd(), 'package.json')
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools: () => {},
    section: () => () => {},
  } as never)
  new ToolRuntime(ctx)
  await ctx.plugin(Loader)
  ctx.provide('profileContext', {
    name: 'visual-tools-profile',
    dir: profileDir,
    patchPath,
    installAnchor: anchor,
    cwd: root,
    home: root,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  // A profile resolves its bundles from its OWN node_modules, exactly what a
  // real `dsh plugin --profile` install layout provides.
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  await mountRootInclude(
    ctx,
    patchPath,
    [...profile.layers.flatMap(layer => layer.patches), ...profile.patches],
    pathToFileURL(anchor).href,
    'dsh',
  )
  await ctx.loader.await()
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

test('a default profile exposes both visual tools and a live Off write unregisters the exact pair', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('visual-tools-plane-'))
  const { ctx, port } = plane

  // Default On comes from the Host Config schema, not from a USER document.
  assert.deepEqual(port.visualTools.read(), { enabled: true, userOverridden: false, applied: true })
  const descriptor = settingsDescriptor(plane)
  assert.equal(descriptor?.value?.enabled, true, 'the Host Settings form projects the effective On')
  assert.equal(descriptor?.user?.enabled, undefined, 'no USER override was required for the default')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME)?.description.includes('Render a small static chart'), true)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME)?.description.includes('Render one static, self-contained SVG'), true)
  const schemasWhileOn = ctx.tools.schemas()

  // Off: the official revision-checked write, the Loader volatile commit and
  // the row's disposers must all land on the same Host.
  await port.visualTools.setEnabled(false)
  assert.deepEqual(port.visualTools.read(), { enabled: false, userOverridden: true, applied: false })
  assert.equal(settingsDescriptor(plane)?.user?.enabled, false, 'the USER layer owns the persisted Off')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.deepEqual(ctx.tools.schemas(), [], 'the next model request sees neither schema')
  assert.notEqual(ctx.get(VISUAL_TOOLS_STATUS_SERVICE), undefined, 'the Host row itself stays loaded')

  // On again on the SAME Host: the original definitions are restored exactly
  // once, with their original schema text.
  await port.visualTools.setEnabled(true)
  assert.deepEqual(port.visualTools.read(), { enabled: true, userOverridden: true, applied: true })
  assert.deepEqual(ctx.tools.schemas(), schemasWhileOn, 'the re-registered definitions are byte-identical')
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === CHART_TOOL_NAME).length, 1)
  assert.equal(ctx.tools.schemas().filter(schema => schema.name === SVG_TOOL_NAME).length, 1)
})

test('a persisted Off survives a Host restart with no tools registered and no other profile pollution', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('visual-tools-restart-')
  const first = await bootPlane(life, root, true)
  await first.port.visualTools.setEnabled(false)
  assert.equal(first.port.visualTools.read()?.applied, false)
  await first.dispose()

  const second = await bootPlane(life, root)
  assert.deepEqual(second.port.visualTools.read(), { enabled: false, userOverridden: true, applied: false },
    'the persisted USER value is the new Host composition default')
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
  await port.visualTools.setEnabled(false)

  const foreign = ctx.tools.register(defineTool({
    name: CHART_TOOL_NAME,
    description: 'foreign chart owner',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'foreign',
  }))

  // The persisted value commits (the Loader catches a throwing volatile
  // listener), but the row's own status reports the truth: no live pair.
  await port.visualTools.setEnabled(true)
  assert.deepEqual(port.visualTools.read(), { enabled: true, userOverridden: true, applied: false })
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined, 'the second registration was rolled back')
  assert.equal(ctx.tools.get(CHART_TOOL_NAME)?.description, 'foreign chart owner', 'the foreign definition was not shadowed')

  // Releasing the foreign owner and toggling Off -> On applies the pair again.
  foreign()
  await port.visualTools.setEnabled(false)
  await port.visualTools.setEnabled(true)
  assert.deepEqual(port.visualTools.read(), { enabled: true, userOverridden: true, applied: true })
  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), [CHART_TOOL_NAME, SVG_TOOL_NAME].sort())
})
