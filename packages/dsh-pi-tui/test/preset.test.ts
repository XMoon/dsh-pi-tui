/**
 * Headless tests for the P6 preset wiring: `composeAgent` (roster-absent and
 * roster-present composition), `recordedPreset` (log-first resolution), and
 * `recomposeBlank` (blank-only swap shared by /preset and --preset).
 * @module @xmoon76/dsh-pi-tui/preset.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { composeAgent, recordedPreset, recomposeBlank } from '../src/index.ts'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Minimal roster double recording every mount. */
function roster(overrides: {
  resolveId?: string | undefined
  unknown?: boolean
  mountThrows?: boolean
} = {}) {
  const mounted: string[] = []
  return {
    mounted,
    service: {
      resolve: async (id?: string) => {
        if (overrides.unknown) throw new Error(`agent-presets: preset "${id}" not found (available: standard)`)
        return { id: id ?? overrides.resolveId ?? 'standard' }
      },
      mount: async (_agentCtx: Context, id: string) => {
        if (overrides.mountThrows === true) throw new Error(`agent-presets: preset "${id}" failed to mount: broken`)
        mounted.push(id)
      },
      recompose: async (_agentCtx: Context, id: string) => {
        if (overrides.unknown) throw new Error(`agent-presets: preset "${id}" not found (available: standard)`)
        return { id }
      },
    },
  }
}

function ctxWith(get: (name: string) => unknown): Context {
  return { get } as unknown as Context
}

/** A minimal unpublished-agent scope: model selection registers two listeners. */
function agentCtx(): Context {
  return { on: () => () => {} } as unknown as Context
}

function selection(): ModelSelectionRef {
  return { current: { provider: 'p', model: 'm' }, assembled: undefined }
}

test('composeAgent without a roster composes nothing and installs only model selection', async () => {
  const ctx = ctxWith(() => undefined)
  const composition = await composeAgent(ctx, selection())
  assert.equal(composition.agentPreset, undefined)
  assert.equal(typeof composition.setup, 'function')
})

test('composeAgent with a roster resolves the default and mounts it in setup', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, selection())
  assert.equal(composition.agentPreset, 'standard')
  await composition.setup(agentCtx())
  assert.deepEqual(fake.mounted, ['standard'])
})

test('composeAgent mounts the named preset, not the default', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, selection(), 'minimal')
  assert.equal(composition.agentPreset, 'minimal')
  await composition.setup(agentCtx())
  assert.deepEqual(fake.mounted, ['minimal'])
})

test('composeAgent propagates an unknown-preset rejection', async () => {
  const fake = roster({ unknown: true })
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  await assert.rejects(composeAgent(ctx, selection(), 'nope'), /not found/)
})

test('recordedPreset returns undefined without persistence', async () => {
  const ctx = ctxWith(() => undefined)
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

test('recordedPreset returns undefined for an unknown session', async () => {
  const persistence = {
    list: async () => [{ id: 'other', createdAt: 1 }],
    inspect: async () => { throw new Error('not found') },
  }
  const ctx = ctxWith(name => name === 'sessionPersistence' ? persistence : undefined)
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

test('recordedPreset falls back to the header preset when the log is unreadable', async () => {
  const persistence = {
    list: async () => [{ id: 's1', agentPreset: 'standard', createdAt: 1 }],
    inspect: async () => { throw new Error('log unreadable') },
  }
  const ctx = ctxWith(name => name === 'sessionPersistence' ? persistence : undefined)
  assert.equal(await recordedPreset(ctx, 's1'), 'standard')
})

test('recordedPreset resolves from the log: the newest selection wins over the header', async () => {
  const persistence = {
    list: async () => [{ id: 's1', agentPreset: 'standard', createdAt: 1 }],
    inspect: async () => ({
      meta: { id: 's1', agentPreset: 'standard', createdAt: 1 },
      events: [
        { type: 'agent-preset/selected', seq: 1, time: 2, data: { agentPreset: 'minimal' } },
      ],
    }),
  }
  const ctx = ctxWith(name => name === 'sessionPersistence' ? persistence : undefined)
  assert.equal(await recordedPreset(ctx, 's1'), 'minimal')
})

test('recordedPreset returns undefined for a pre-roster session log', async () => {
  const persistence = {
    list: async () => [{ id: 's1', createdAt: 1 }],
    inspect: async () => ({
      meta: { id: 's1', createdAt: 1 },
      events: [{ type: 'user/message', seq: 1, time: 2, data: { content: [], source: { kind: 'user' } } }],
    }),
  }
  const ctx = ctxWith(name => name === 'sessionPersistence' ? persistence : undefined)
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

/** A blank/started session double recording appended selections. */
function sessionWith(events: readonly SessionEvent[]): { session: { id: string; events: readonly SessionEvent[]; append: (type: string, data: unknown) => void }; appended: unknown[] } {
  const appended: unknown[] = []
  return {
    appended,
    session: {
      id: 's1',
      events,
      append: (_type: string, data: unknown) => { appended.push(data) },
    },
  }
}

test('recomposeBlank swaps a blank session and records the selection', async () => {
  const recomposed: string[] = []
  const fake = roster()
  const service = {
    ...fake.service,
    recompose: async (_agentCtx: Context, id: string) => { recomposed.push(id); return { id } },
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const { session, appended } = sessionWith([])
  const outcome = await recomposeBlank(ctx, { ctx: agentCtx(), session }, 'minimal')
  assert.deepEqual(outcome, { kind: 'switched', preset: 'minimal' })
  assert.deepEqual(recomposed, ['minimal'])
  assert.deepEqual(appended, [{ agentPreset: 'minimal' }])
})

test('recomposeBlank refuses a started session without touching the roster', async () => {
  let recomposed = 0
  const service = {
    ...roster().service,
    recompose: async () => { recomposed += 1; return { id: 'x' } },
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const { session, appended } = sessionWith([{ type: 'turn/start', seq: 1, time: 1, data: {} } as SessionEvent])
  const outcome = await recomposeBlank(ctx, { ctx: agentCtx(), session }, 'minimal')
  assert.deepEqual(outcome, { kind: 'locked' })
  assert.equal(recomposed, 0)
  assert.equal(appended.length, 0)
})

test('recomposeBlank throws without a roster', async () => {
  const ctx = ctxWith(() => undefined)
  const { session } = sessionWith([])
  await assert.rejects(
    recomposeBlank(ctx, { ctx: agentCtx(), session }, 'standard'),
    /agent presets unavailable/,
  )
})

test('recomposeBlank propagates an unknown-preset rejection', async () => {
  const fake = roster({ unknown: true })
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const { session } = sessionWith([])
  await assert.rejects(
    recomposeBlank(ctx, { ctx: agentCtx(), session }, 'nope'),
    /not found/,
  )
})
