/**
 * Headless tests for the P6 preset wiring: `composeAgent` (roster-absent and
 * roster-present composition) and `recordedPreset` (log-first resolution).
 * The `/preset` command itself is covered by the live-TTY matrix (its handler
 * needs the full agent/commands machinery this harness does not mount).
 * @module @dsh-pi-tui/tui-app/preset.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { composeAgent, recordedPreset } from '../src/index.ts'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'

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
