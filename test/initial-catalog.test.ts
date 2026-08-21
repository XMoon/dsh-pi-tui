/**
 * Headless tests for the pre-mount initial catalog resolution:
 * - the resumed-agent PREFETCH (a live read emits no session events);
 * - the deferred start's cold STANDING-SCOPE skill read (no Agent, no
 *   session, no turn — the mechanism that avoids the probe dead end).
 * The ready-barrier install itself is covered by command-catalog.test.ts;
 * the real startup wiring is smoke-verified in the profile run.
 * @module @xmoon76/dsh-pi-tui/initial-catalog.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createDiag } from '../src/diag.ts'
import { resolveInitialCatalog } from '../src/index.ts'
import type { SurfaceCatalogContext } from '../src/surface-catalog.ts'

/** A fake agent with a header cwd. */
function fakeAgent(sessionId = 'session-live'): Agent {
  return {
    session: { id: sessionId, header: { cwd: '/ws' }, events: [] },
    options: { provider: 'p', model: 'm' },
  } as unknown as Agent
}

/** A fake context surface whose effective command view adds a scoped entry,
 * optionally carrying a skills registry and an agent-presets service for
 * the cold standing path. */
function fakeCtx(services: {
  commands?: { list: (agent: Agent | undefined) => unknown[] }
  skills?: { snapshot?: (options: { cwd?: string; scope?: object; signal?: AbortSignal }) => Promise<{ skills: unknown[]; complete: boolean }> }
  presets?: { standingKeyFor?: (id?: string) => Promise<object> }
} = {}): SurfaceCatalogContext {
  const commands = services.commands ?? {
    list: (agent) => agent === undefined
      ? [{ name: 'globalcmd', description: 'g' }]
      : [{ name: 'globalcmd', description: 'g' }, { name: 'scopedcmd', description: 's' }],
  }
  return {
    get: (name) => {
      if (name === 'commands') return commands as never
      if (name === 'skills') return services.skills as never
      if (name === 'agentPresets') return services.presets as never
      return undefined
    },
  }
}

function capturingDiag(): { diag: ReturnType<typeof createDiag>; lines: string[] } {
  const lines: string[] = []
  return {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off', sinks: [{ write: (line: string) => { lines.push(line) } }] }),
    lines,
  }
}

test('a resumed agent prefetches its effective catalog and reports no notice', async () => {
  const { diag, lines } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: fakeAgent('session-resumed'),
    signal: new AbortController().signal,
    ctx: fakeCtx(),
    diag,
  })
  assert.ok(resolution.snapshot !== undefined, 'the prefetch snapshot must be returned')
  assert.deepEqual(resolution.snapshot.commands.map(command => command.name), ['globalcmd', 'scopedcmd'])
  assert.equal(resolution.notice, undefined)
  assert.ok(lines.some(line => /surface catalog prefetched/.test(line)))
})

test('a failed prefetch degrades to a one-shot notice, never a startup failure', async () => {
  const { diag } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: fakeAgent('session-resumed'),
    signal: new AbortController().signal,
    ctx: {
      get: () => {
        throw new Error('hostile context')
      },
    } as never,
    diag,
  })
  assert.equal(resolution.snapshot, undefined)
  assert.match(resolution.notice ?? '', /surface catalog unavailable: hostile context/)
})

test('a cancelled prefetch installs nothing and reports nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  const { diag } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: fakeAgent('session-resumed'),
    signal: controller.signal,
    ctx: fakeCtx(),
    diag,
  })
  assert.equal(resolution.snapshot, undefined)
  assert.equal(resolution.notice, undefined)
})

test('a deferred start reads the cold human skill catalog through the preset standing scope', async () => {
  const key = { agentPreset: 'standard' }
  let readOptions: { cwd?: string; scope?: object } | undefined
  const { diag, lines } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: undefined,
    presetId: 'standard',
    signal: new AbortController().signal,
    ctx: fakeCtx({
      skills: {
        snapshot: async (options) => {
          readOptions = options
          return {
            complete: true,
            skills: [
              { name: 'user-skill', description: 'u', invocation: { modelInvocable: true, userInvocable: true }, whenToUse: 'x' },
              { name: 'model-only', description: 'm', invocation: { modelInvocable: true, userInvocable: false } },
            ],
          }
        },
      },
      presets: {
        standingKeyFor: async (id) => {
          assert.equal(id, 'standard')
          return key
        },
      },
    }),
    diag,
  })
  assert.equal(resolution.snapshot, undefined)
  assert.ok(resolution.skills !== undefined, 'the cold standing read must return a skill catalog')
  assert.deepEqual(resolution.skills.skills.map(skill => skill.name), ['user-skill'],
    'only human-invocable skills reach the cold catalog')
  assert.equal(resolution.skills.complete, true)
  assert.equal(readOptions?.scope, key, 'the standing key is the read scope')
  assert.equal(resolution.notice, undefined)
  assert.ok(lines.some(line => /skill catalog standing ready/.test(line) && /skills=1/.test(line)))
})

test('a broken standing mount degrades the cold read to the global view with a one-shot notice', async () => {
  const { diag } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: undefined,
    presetId: 'broken',
    signal: new AbortController().signal,
    ctx: fakeCtx({
      skills: {
        snapshot: async () => ({ complete: true, skills: [{ name: 'global-skill', description: 'g', invocation: { modelInvocable: true, userInvocable: true } }] }),
      },
      presets: {
        standingKeyFor: async () => { throw new Error('preset exploded') },
      },
    }),
    diag,
  })
  assert.ok(resolution.skills !== undefined, 'the global layer still serves the cold catalog')
  assert.deepEqual(resolution.skills.skills.map(skill => skill.name), ['global-skill'])
  assert.match(resolution.notice ?? '', /skill catalog unavailable for preset "broken": preset exploded/)
})

test('a failed cold read degrades to a notice — the TUI still starts with built-ins', async () => {
  const { diag, lines } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: undefined,
    presetId: 'standard',
    signal: new AbortController().signal,
    ctx: fakeCtx({
      skills: {
        snapshot: async () => { throw new Error('registry down') },
      },
      presets: {
        standingKeyFor: async () => ({ agentPreset: 'standard' }),
      },
    }),
    diag,
  })
  assert.equal(resolution.skills, undefined)
  assert.match(resolution.notice ?? '', /skill catalog unavailable: registry down/)
  assert.ok(lines.some(line => /WARN skill catalog unavailable/.test(line) && /phase=cold/.test(line)))
})

test('a deferred start with no skill registry resolves nothing', async () => {
  const { diag } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: undefined,
    presetId: 'standard',
    signal: new AbortController().signal,
    ctx: fakeCtx({ presets: { standingKeyFor: async () => ({ agentPreset: 'standard' }) } }),
    diag,
  })
  assert.equal(resolution.skills, undefined)
  assert.equal(resolution.notice, undefined)
})

test('no live agent and no preset resolution path resolves nothing — no probe, no notice', async () => {
  const { diag } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: undefined,
    signal: new AbortController().signal,
    ctx: fakeCtx(),
    diag,
  })
  assert.equal(resolution.snapshot, undefined)
  assert.equal(resolution.skills, undefined)
  assert.equal(resolution.notice, undefined)
})
