/**
 * The Host entry's COLD header seam: when a Session is no longer live (an ended
 * subagent child), `sessionHeaderFacts` must read the official
 * `sessionQuery.readTitleSnapshots` observation. The official result carries the
 * folded header as `value.session`; a renamed/misread field would make the
 * durable `agent-message` lineage unprovable (or throw) at runtime, so this
 * test pins the real seam shape and its exact-session check.
 *
 * @module test/app/local-acp-host-cold-header
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'

import {
  createHostAcpSessionAccess,
  type SessionTitleObservationLike,
} from '../../src/app/remote-process/local-host-entry.ts'

/**
 * Compile-time guard: the OFFICIAL observation result must be a valid value of
 * this Host's structural seam. If either side renames `session`/`title`, this
 * line fails typecheck instead of the cold header failing at runtime.
 */
function officialObservationIsSeamValue(value: SessionTitleObservationResult): SessionTitleObservationLike {
  return value
}

interface FakeServices {
  readonly [name: string]: unknown
}

function hostAccessWith(services: FakeServices): ReturnType<typeof createHostAcpSessionAccess> {
  const context = { reflect: { get: (name: string) => services[name] } }
  return createHostAcpSessionAccess(context as never)
}

function baseServices(overrides: FakeServices): FakeServices {
  return {
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'ws', path: '/w' } }) },
    sessionController: {
      list: async () => ({ items: [] }),
      modelCatalog: async () => [],
      create: async () => ({ sessionId: 'S' }),
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    attachments: { readImage: async () => ({ data: Uint8Array.of(1), mediaType: 'image/png' }) },
    llm: { listProviders: () => [], listModels: async () => [], resolveCallConfig: async () => ({ provider: 'p', model: 'm' }) },
    tools: {},
    ...overrides,
  }
}

test('a cold Session header is read from the official title observation `value.session`', async () => {
  const access = hostAccessWith(baseServices({
    sessionQuery: {
      readSession: async () => { throw new Error('unused in this test') },
      readTitleSnapshots: async (sessionIds: readonly string[]) => sessionIds.map(sessionId => officialObservationIsSeamValue({
        sessionId,
        status: 'fulfilled',
        value: {
          session: { id: sessionId, cwd: '/w', origin: 'subagent', parentSession: 'PARENT' },
          title: { title: 'child title', updatedAt: 1 },
        },
      } as SessionTitleObservationResult)),
    },
  }))
  assert.deepEqual(await access.sessionHeaderFacts('CHILD'), {
    sessionId: 'CHILD', cwd: '/w', origin: 'subagent', parentSessionId: 'PARENT',
  })
  // A cold header whose id is not the requested Session is NOT that Session.
  const mismatched = hostAccessWith(baseServices({
    sessionQuery: {
      readSession: async () => { throw new Error('unused in this test') },
      readTitleSnapshots: async () => [officialObservationIsSeamValue({
        sessionId: 'CHILD',
        status: 'fulfilled',
        value: { session: { id: 'OTHER' }, title: { title: 'x', updatedAt: 1 } },
      } as SessionTitleObservationResult)],
    },
  }))
  assert.equal(await mismatched.sessionHeaderFacts('CHILD'), undefined)
  // A rejected observation proves nothing and yields no facts.
  const rejected = hostAccessWith(baseServices({
    sessionQuery: {
      readSession: async () => { throw new Error('unused in this test') },
      readTitleSnapshots: async (sessionIds: readonly string[]) => sessionIds.map(sessionId => ({
        sessionId, status: 'rejected', reason: new Error('unavailable'),
      } as SessionTitleObservationResult)),
    },
  }))
  assert.equal(await rejected.sessionHeaderFacts('CHILD'), undefined)
})

test('a LIVE Session header keeps the official live object and never queries the fold', async () => {
  let queried = 0
  const access = hostAccessWith(baseServices({
    sessions: { get: (id: string) => (id === 'LIVE' ? { header: { id: 'LIVE', cwd: '/live' } } : undefined) },
    sessionQuery: {
      readSession: async () => { throw new Error('unused in this test') },
      readTitleSnapshots: async () => { queried += 1; return [] },
    },
  }))
  assert.deepEqual(await access.sessionHeaderFacts('LIVE'), { sessionId: 'LIVE', cwd: '/live' })
  assert.equal(queried, 0, 'a live header needs no cold fold')
})
