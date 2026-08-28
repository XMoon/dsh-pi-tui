/**
 * Regression against the DSH-owned shipped preset roster. The TUI must not
 * recreate the official four presets or replace their system trust with a
 * locally configured root.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'

const OFFICIAL_IDS = ['standard', 'ptc', 'minimal', 'cordis'] as const
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the TUI checkout carries no copied official preset root', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'config', 'agent-presets')), false)
})

async function dispose(fibers: readonly { dispose(): unknown }[]): Promise<void> {
  await Promise.allSettled(fibers.map(fiber => Promise.resolve(fiber.dispose())))
}

test('DSH owns the complete official shipped preset roster', async () => {
  const ctx = new Context()
  const loader = ctx.plugin(Loader)
  await loader
  ctx.baseUrl = pathToFileURL(`${process.cwd()}/`).href
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
    await dispose([presetsFiber, loader])
  }
})
