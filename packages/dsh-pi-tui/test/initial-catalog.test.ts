/**
 * Headless tests for the pre-mount initial catalog resolution (revised
 * design): ONLY the resumed-agent prefetch remains — the deferred start
 * resolves nothing, because a startup catalog probe is disabled in this
 * deployment (host `session/created` observers write durable knob events
 * into every fresh session; see docs/surface-catalog.md). The ready-barrier
 * install itself is covered by command-catalog.test.ts; the real startup
 * wiring is smoke-verified in the profile run.
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

/** A fake context surface whose effective command view adds a scoped entry. */
function fakeCtx(commands: { list: (agent: Agent | undefined) => unknown[] } = {
  list: (agent) => agent === undefined
    ? [{ name: 'globalcmd', description: 'g' }]
    : [{ name: 'globalcmd', description: 'g' }, { name: 'scopedcmd', description: 's' }],
}): SurfaceCatalogContext {
  return {
    get: (name) => {
      if (name === 'commands') return commands as never
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

test('no live agent (the deferred start) resolves nothing — no probe, no notice', async () => {
  const { diag } = capturingDiag()
  const resolution = await resolveInitialCatalog({
    liveAgent: undefined,
    signal: new AbortController().signal,
    ctx: fakeCtx(),
    diag,
  })
  assert.equal(resolution.snapshot, undefined)
  assert.equal(resolution.notice, undefined)
})
