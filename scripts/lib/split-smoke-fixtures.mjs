/**
 * Isolated fixture writers for the split-process smoke lanes.
 *
 * Both fixtures are copied INTO the installed profile so their official
 * `@deepseek-ai/*` imports resolve from that profile (never from the
 * repository checkout), exactly like a production profile row. Importing this
 * module performs no I/O.
 *
 * @module split-smoke-fixtures
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError, SplitSmokeWaitError } from './split-smoke-diagnostics.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** The test-only offline Host LLM route (official Loader row + patch override). */
export function writeSurfaceLlmFixture(profileDir, workDir) {
  const stubPath = join(profileDir, 'm4b2s-stub-llm.mjs')
  writeFileSync(stubPath, `import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const name = 'm4b2s-stub-llm'
export const inject = ['llm']
class StubLlmAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider: 'stub', id: model, name: model }) }
  listModels() { return Promise.resolve([{ provider: 'stub', id: 'stub', name: 'stub' }]) }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'stub answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'stub answer' } }
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['stub'], new StubLlmAdapter()) }
`, { mode: 0o600 })
  const patchPath = join(workDir, 'm4b2s-llm.patch.yml')
  writeFileSync(patchPath, [
    '- insert:',
    '    - id: m4b2s-stub-llm',
    `      name: '${pathToFileURL(stubPath).href}'`,
    '      inject: [llm]',
    '- id: agent-default-model',
    '  config:',
    '    provider: stub',
    '    model: stub',
    '',
  ].join('\n'), { mode: 0o600 })
  return { stubPath, patchPath }
}

/**
 * The isolated Host workload overlay. The fixture file is copied into
 * the installed profile so its official `@deepseek-ai/*` imports resolve from
 * that profile (never from the repository checkout), exactly like the stub
 * LLM row above. One row registers the scripted adapter; `agent-default-model`
 * routes the Agent to it.
 */
export function writeC1WorkFixture(profileDir, workDir) {
  const source = join(SCRIPT_DIR, '..', 'fixtures', 'split-process-host-work.mjs')
  const fixturePath = join(profileDir, 'split-process-host-work.mjs')
  writeFileSync(fixturePath, readFileSync(source), { mode: 0o600 })
  chmodSync(fixturePath, 0o600)
  const rows = [
    '- insert:',
    '    - id: split-process-host-work',
    `      name: '${pathToFileURL(fixturePath).href}'`,
    '      inject: [llm, tools, jobs, subagents, agents, typertGateway, connection]',
    '- id: agent-default-model',
    '  config:',
    '    provider: c1-qualification',
    '    model: c1',
    '',
  ]
  const patchPath = join(workDir, 'm4-c1-work.patch.yml')
  writeFileSync(patchPath, rows.join('\n'), { mode: 0o600 })
  chmodSync(patchPath, 0o600)
  // T52: a profile-scoped override of the REAL `standard` preset. The
  // generated preset patch is the canonical plugin list; only the
  // `tool-ask-user` row switches to its official timed mode (1s foreground
  // window). The production preset itself is untouched.
  const standardPatch = parseYaml(readFileSync(join(SCRIPT_DIR, '..', '..', 'generated', 'dsh-presets', 'standard.patch.yml'), 'utf8'))
  const presetRow = standardPatch.find(entry => Array.isArray(entry.insert))?.insert?.find(entry => entry.id === 'preset-standard')
  assert(presetRow !== undefined && presetRow.config !== undefined, 'T52 the generated standard preset row is missing')
  const plugins = structuredClone(presetRow.config.plugins)
  const askRow = plugins.find(entry => entry.id === 'tool-ask-user')
  assert(askRow !== undefined, 'T52 the standard preset has no tool-ask-user row')
  askRow.config = { mode: 'timed', timeout: 1 }
  const timedPatchPath = join(workDir, 'm4-c1-work-timed.patch.yml')
  const basePatches = parseYaml(readFileSync(patchPath, 'utf8'))
  writeFileSync(timedPatchPath, JSON.stringify([
    ...basePatches,
    { id: 'preset-standard', config: { ...presetRow.config, plugins } },
  ], null, 2), { mode: 0o600 })
  chmodSync(timedPatchPath, 0o600)
  return { fixturePath, patchPath, timedPatchPath }

}

/** Read every host-workload fixture proof line (an absent file is simply empty). */
function readC1WorkEvents(workRoot) {
  const path = join(workRoot, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** Wait for one fixture proof matching the predicate. */
export async function waitForC1WorkEvent(workRoot, predicate, label, timeoutMs = 60_000) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const event = readC1WorkEvents(workRoot).find(predicate)
    if (event !== undefined) return event
    await sleep(25)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', {
    code: 'WORK_PROOF_WAIT_TIMEOUT',
    waitLabel: label,
    elapsedMs: Date.now() - started,
  })
}
