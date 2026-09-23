/**
 * Regression against the DSH-owned declarative preset composition (0.1.7):
 * the TUI composes the official `@deepseek-ai/dsh-agent-preset-registry`
 * plus the four SHIPPED `@deepseek-ai/dsh-agent-preset` declarations
 * (synced from the target tag's web bundle under config/dsh-presets/) —
 * it must not recreate preset identity through the retired
 * path-root/trust model of `@deepseek-ai/dsh-agent-presets`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const OFFICIAL_IDS = ['standard', 'ptc', 'minimal', 'cordis'] as const
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_DIR = join(REPO_ROOT, 'config', 'dsh-presets')

/** Parse one declarative preset patch the way the Loader reads it: `!!js`
 * expressions stay unevaluated markers the Loader itself evaluates. */
function parsePatch(name: string): { id: string; name: string; config: { id: string; order?: number; plugins: readonly unknown[] } } {
  const document = parse(readFileSync(join(PATCH_DIR, `${name}.patch.yml`), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  })
  const row = document[0]?.insert?.[0]
  assert.ok(row !== undefined, `${name}.patch.yml must insert one declaration row`)
  return row
}

test('the TUI checkout carries no copied official preset root', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'config', 'agent-presets')), false)
})

test('the TUI overlay supplies preset-required Host services', () => {
  const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
  for (const [id, packageName] of [
    ['agent-preset-registry', '@deepseek-ai/dsh-agent-preset-registry'],
    ['subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
    ['cordis-host-runner', '@deepseek-ai/dsh-cordis-host-runner'],
    ['authorization', '@deepseek-ai/dsh-authorization'],
    ['workspace', '@deepseek-ai/dsh-workspace'],
  ] as const) {
    assert.match(patch, new RegExp(`^    - id: ${id}\\n      name: '${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`, 'mu'),
      `${id} must be present on the host overlay`)
  }
})

test('the retired path-root preset model is gone from the composition and the package manifest', () => {
  const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, unknown>
    peerDependencies: Record<string, unknown>
    devDependencies: Record<string, unknown>
    files: readonly string[]
    dsh: { bundle: { patch: readonly string[] | string } }
  }
  assert.doesNotMatch(patch, /@deepseek-ai\/dsh-agent-presets/u, 'no legacy agent-presets row')
  assert.doesNotMatch(patch, /includeShippedRoot|includeUserRoot|^\s*roots:/mu, 'no legacy path-root config')
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
    assert.equal('@deepseek-ai/dsh-agent-presets' in manifest[section], false, `${section} must not carry the retired package`)
  }
  assert.ok('@deepseek-ai/dsh-agent-preset-registry' in manifest.peerDependencies, 'the registry is a runtime peer')
  // The declarative preset plugin is a COMPOSITION row (resolved by the dsh
  // host like every preset plugin name), not a module-graph peer; it stays a
  // development dependency for the real-mount composition test.
})

test('dsh.bundle.patch is the ordered five-patch composition and ships in files', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    files: readonly string[]
    dsh: { bundle: { patch: readonly string[] | string } }
  }
  assert.deepEqual(manifest.dsh.bundle.patch, [
    './cordis.patch.yml',
    './config/dsh-presets/standard.patch.yml',
    './config/dsh-presets/ptc.patch.yml',
    './config/dsh-presets/minimal.patch.yml',
    './config/dsh-presets/cordis.patch.yml',
  ], 'the registry patch composes first, then the four declarations in order')
  for (const file of manifest.dsh.bundle.patch as readonly string[]) {
    assert.equal(existsSync(join(REPO_ROOT, file)), true, `${file} must exist`)
  }
  assert.ok(manifest.files.includes('config'), 'the preset patches ship in the published files')
})

test('the four shipped declarative presets declare the official ids and order', () => {
  for (const [index, id] of OFFICIAL_IDS.entries()) {
    const row = parsePatch(id)
    assert.equal(row.id, `preset-${id}`)
    assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
    assert.equal(row.config.id, id)
    assert.equal(row.config.order, index + 1)
    assert.ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0,
      `${id} must declare a non-empty plugin list`)
    for (const plugin of row.config.plugins) {
      const entry = plugin as { id?: unknown; name?: unknown }
      assert.equal(typeof entry.name, 'string', `${id} plugin row must name a plugin`)
      assert.equal(typeof entry.id, 'string', `${id} plugin row must carry a stable id`)
    }
  }
})

test('the TUI overlay keeps the complete agent-plane disable closure', () => {
  const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
  // This is the smallest closure that prevents base agent-plane rows from
  // leaking into a per-session official preset. Extra rows are intentionally
  // pinned too: deleting one silently changes the effective agent surface.
  const disabledAgentRows = [
    'tool-bash',
    'tool-pwsh',
    'tool-jobs',
    'tool-fs',
    'tool-fs-search',
    'skill-filesystem',
    'tool-skill',
    'command-goal',
    'tool-goal',
    'plan-mode',
    'compaction-basic',
    'command-compact',
    'tool-result-pruner',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-subagent',
    'tool-subagent-fork',
    'workflow-ptc',
    'tool-workflow',
    'tool-ralph',
    'agent-instructions',
    'tool-todo',
    'tool-web',
  ]
  for (const id of disabledAgentRows) {
    assert.match(patch, new RegExp(`^- id: ${id}\\n  disabled: true$`, 'mu'),
      `${id} must stay disabled on the host overlay so preset scope owns it`)
  }
})

async function dispose(fibers: readonly { dispose(): unknown }[]): Promise<void> {
  await Promise.allSettled(fibers.map(fiber => Promise.resolve(fiber.dispose())))
}

test('the local declarative patches compose the official roster through the real registry', async () => {
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  await loader
  ctx.baseUrl = pathToFileURL(`${process.cwd()}/`).href
  // The registry registers its projection unit at construction and requires
  // the shared projection registry to be composed first.
  const projectionsFiber = ctx.plugin(SessionProjectionRegistry)
  await projectionsFiber
  const registryFiber = ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  await registryFiber
  const declarationFibers: Array<{ dispose(): unknown }> = [registryFiber, projectionsFiber, loader]
  try {
    for (const id of OFFICIAL_IDS) {
      const row = parsePatch(id)
      const fiber = ctx.plugin(AgentPreset, row.config as never)
      declarationFibers.unshift(fiber)
      await fiber
    }
    const presets = ctx.get('agentPresets')
    assert.ok(presets !== undefined, 'the preset registry service must be composed')
    const rows = await presets.list()
    // Rows may carry `broken` diagnostics (this package-only test does not
    // install every Host plugin the official rows name; full mount health
    // belongs to the real-profile smoke). The roster itself must be exactly
    // the four shipped declarations, in the official order.
    assert.deepEqual(rows.map(row => row.id), [...OFFICIAL_IDS])
    for (const id of OFFICIAL_IDS) {
      const resolved = await presets.resolve(id)
      assert.equal(resolved.id, id, `official preset ${id} must resolve`)
    }
    assert.equal(presets.defaultId, 'standard')
  } finally {
    await dispose(declarationFibers)
  }
})
