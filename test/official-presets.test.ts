/**
 * Regression against the DSH-owned shipped preset roster. The TUI must not
 * recreate the official four presets or replace their system trust with a
 * locally configured root.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const OFFICIAL_IDS = ['standard', 'ptc', 'minimal', 'cordis'] as const
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the TUI checkout carries no copied official preset root', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'config', 'agent-presets')), false)
})

test('the TUI overlay supplies preset-required Host services', () => {
  const patch = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
  for (const [id, packageName] of [
    ['agent-presets', '@deepseek-ai/dsh-agent-presets'],
    ['subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
    ['code-runtime', '@deepseek-ai/dsh-code-runtime-worker-thread'],
    ['cordis-host-runner', '@deepseek-ai/dsh-cordis-host-runner'],
    ['authorization', '@deepseek-ai/dsh-authorization'],
  ] as const) {
    assert.match(patch, new RegExp(`^    - id: ${id}\\n      name: '${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'$`, 'mu'),
      `${id} must be present on the host overlay`)
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
    'tool-str-replace-editor',
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
    'workflow-worker-thread',
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

test('DSH owns the complete official shipped preset roster', async () => {
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  await loader
  ctx.baseUrl = pathToFileURL(`${process.cwd()}/`).href
  // alpha.2 agent-presets registers its projection unit at construction and
  // requires the shared projection registry to be composed first.
  const projectionsFiber = ctx.plugin(SessionProjectionRegistry)
  await projectionsFiber
  const presetsFiber = ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [],
    includeShippedRoot: true,
    includeUserRoot: false,
  })
  await presetsFiber
  try {
    const presets = ctx.get('agentPresets')
    assert.ok(presets !== undefined, 'agent-presets service must be composed')
    const rows = await presets.list()
    const official = rows.filter(row => (OFFICIAL_IDS as readonly string[]).includes(row.id))
    assert.deepEqual(official.map(row => row.id), [...OFFICIAL_IDS])
    assert.deepEqual(official.map(row => row.trust), OFFICIAL_IDS.map(() => 'system'))
    assert.deepEqual(official.map(row => row.broken), OFFICIAL_IDS.map(() => undefined),
      'the DSH-shipped rows must be healthy at discovery time')
    for (const id of OFFICIAL_IDS) {
      const resolved = await presets.resolve(id)
      assert.equal(resolved.id, id, `official preset ${id} must resolve`)
      assert.equal(resolved.broken, undefined, `official preset ${id} must not resolve as broken`)
    }
    // Full mount health belongs to the target DSH profile integration: this
    // package-only test does not install every Host plugin named by the
    // official rows. The real-profile smoke is the blocking mount check.
  } finally {
    await dispose([presetsFiber, projectionsFiber, loader])
  }
})
