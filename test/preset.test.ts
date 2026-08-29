/**
 * Headless tests for the P6 preset wiring: `composeAgent` (roster-absent and
 * roster-present composition), `recordedPreset` (log-first resolution),
 * `recomposeBlank` (blank-only swap shared by /preset and --preset), and
 * `presetDisplayText` (the English display copy for the shipped presets).
 * @module @xmoon76/dsh-pi-tui/preset.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { composeAgent, recordedPreset, recomposeBlank } from '../src/index.ts'
import { presetDisplayText } from '../src/commands.ts'
import { sessionPresetOf } from '../src/runtime/direct/session-preset-direct.ts'
import {
  normalizePersistedSessionPresetId,
  resolvePersistedSessionPresetId,
} from '../src/runtime/session-preset.ts'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

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

function sessionHeader(id: string, agentPreset?: string): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 1,
    cwd: '/tmp',
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

/** A small host double that delegates to the official projection definition. */
const agentPresetProjection = {
  stateOf(session: Session, _key: 'agentPreset'): string | null {
    let value = agentPresetProjectionDefinition.init(session.header)
    for (const event of session.events) value = agentPresetProjectionDefinition.apply(value, event)
    return value
  },
}

function projectedCtx(persistence?: unknown, presets?: unknown): Context {
  return ctxWith(name => {
    if (name === 'sessionProjections') return agentPresetProjection
    if (name === 'sessionPersistence') return persistence
    if (name === 'agentPresets') return presets
    return undefined
  })
}

const rosterWithoutCode = {
  resolve: async (id?: string) => {
    if (id === 'code') throw new Error('agent-presets: preset "code" not found (available: ptc)')
    return { id: id ?? 'ptc' }
  },
}

const emptyRoster = {
  resolve: async (id?: string) => {
    throw new Error(`agent-presets: preset "${id}" not found (available: none)`)
  },
}

test('persisted code normalization is roster-aware and inert without roster data', async () => {
  assert.equal(normalizePersistedSessionPresetId('code'), 'code')
  assert.equal(normalizePersistedSessionPresetId('code', ['ptc']), 'ptc')
  assert.equal(normalizePersistedSessionPresetId('code', []), undefined)
  assert.equal(normalizePersistedSessionPresetId('code', ['ptc', 'code']), 'code')
  assert.equal(await resolvePersistedSessionPresetId('code', undefined, undefined), undefined)
  assert.equal(await resolvePersistedSessionPresetId('code', [], emptyRoster), undefined)
})

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

test('composeAgent rejects code when no preset roster exists', async () => {
  const ctx = ctxWith(() => undefined)
  await assert.rejects(
    composeAgent(ctx, selection(), 'code'),
    /preset "code" is unavailable/,
  )
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

test('composeAgent accepts a legal custom code preset', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, selection(), 'code')
  assert.equal(composition.agentPreset, 'code')
  await composition.setup(agentCtx())
  assert.deepEqual(fake.mounted, ['code'])
})

test('composeAgent keeps a real custom code default instead of applying the legacy fallback', async () => {
  const fake = roster()
  const service = { ...fake.service, defaultId: 'code' }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const composition = await composeAgent(ctx, selection())
  assert.equal(composition.agentPreset, 'code')
})

test('composeAgent resolves an absent legacy code default as ptc', async () => {
  const fake = roster()
  const resolvedIds: Array<string | undefined> = []
  const service = {
    ...fake.service,
    defaultId: 'code',
    resolve: async (id?: string) => {
      resolvedIds.push(id)
      if (id === 'code') throw Object.assign(new Error('unknown preset'), { presetId: 'code' })
      return { id: id ?? 'standard' }
    },
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const composition = await composeAgent(ctx, selection())
  assert.deepEqual(resolvedIds, ['code', 'ptc'])
  assert.equal(composition.agentPreset, 'ptc')
  await composition.setup(agentCtx())
  assert.deepEqual(fake.mounted, ['ptc'])
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

test('recordedPreset drops persisted code when the roster service is absent', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1', 'code')],
    inspect: async () => ({ meta: sessionHeader('s1', 'code'), events: [] }),
  }
  assert.equal(await recordedPreset(projectedCtx(persistence), 's1'), undefined)
})

test('recordedPreset returns undefined for an unknown session', async () => {
  const persistence = {
    list: async () => [sessionHeader('other')],
    inspect: async () => { throw new Error('not found') },
  }
  const ctx = projectedCtx(persistence)
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

test('recordedPreset preserves an unreadable session error instead of falling back to its header', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1', 'standard')],
    inspect: async () => { throw new Error('log unreadable') },
  }
  const ctx = projectedCtx(persistence)
  await assert.rejects(recordedPreset(ctx, 's1'), /log unreadable/)
})

test('recordedPreset uses the projection: the newest selection wins over the header', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1', 'standard')],
    inspect: async () => ({
      meta: sessionHeader('s1', 'standard'),
      events: [
        { type: 'agent-preset/selected', seq: 0, time: 2, data: { agentPreset: 'minimal' } } as SessionEvent,
      ],
    }),
  }
  const ctx = projectedCtx(persistence)
  assert.equal(await recordedPreset(ctx, 's1'), 'minimal')
})

test('recordedPreset normalizes a legacy code selection to canonical ptc', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1', 'standard')],
    inspect: async () => ({
      meta: sessionHeader('s1', 'standard'),
      events: [
        { type: 'agent-preset/selected', seq: 0, time: 2, data: { agentPreset: 'code' } } as SessionEvent,
      ],
    }),
  }
  const ctx = projectedCtx(persistence, rosterWithoutCode)
  assert.equal(await recordedPreset(ctx, 's1'), 'ptc')
})

test('recordedPreset normalizes a legacy code header to canonical ptc', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1', 'code')],
    inspect: async () => ({
      meta: sessionHeader('s1', 'code'),
      events: [],
    }),
  }
  const ctx = projectedCtx(persistence, rosterWithoutCode)
  assert.equal(await recordedPreset(ctx, 's1'), 'ptc')
})

test('recordedPreset preserves code when the current roster has a custom code preset', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1', 'standard')],
    inspect: async () => ({
      meta: sessionHeader('s1', 'standard'),
      events: [
        { type: 'agent-preset/selected', seq: 0, time: 2, data: { agentPreset: 'code' } } as SessionEvent,
      ],
    }),
  }
  const fake = roster()
  const ctx = ctxWith(name => {
    if (name === 'sessionProjections') return agentPresetProjection
    if (name === 'sessionPersistence') return persistence
    if (name === 'agentPresets') return fake.service
    return undefined
  })
  assert.equal(await recordedPreset(ctx, 's1'), 'code')
})

test('recordedPreset returns undefined for a pre-roster session log', async () => {
  const persistence = {
    list: async () => [sessionHeader('s1')],
    inspect: async () => ({
      meta: sessionHeader('s1'),
      events: [],
    }),
  }
  const ctx = projectedCtx(persistence)
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

test('sessionPresetOf reads a header-only session through the projection seam', () => {
  const session = Session.create(SessionId('s1'), [], sessionHeader('s1', 'standard'))
  assert.equal(sessionPresetOf(projectedCtx(), session), 'standard')
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

test('recomposeBlank accepts a legal custom code preset', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const { session, appended } = sessionWith([])
  const outcome = await recomposeBlank(ctx, { ctx: agentCtx(), session }, 'code')
  assert.deepEqual(outcome, { kind: 'switched', preset: 'code' })
  assert.deepEqual(appended, [{ agentPreset: 'code' }])
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

test('presetDisplayText maps the four shipped presets to fixed English copy', () => {
  // The official shipped root may provide localized metadata; the canonical
  // id mapping keeps the TUI's built-in picker copy stable.
  assert.deepEqual(presetDisplayText({ id: 'standard', trust: 'system', name: '标准模式', description: '中文描述' }), {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  })
  assert.equal(presetDisplayText({ id: 'ptc', trust: 'system' }).name, 'PTC mode')
  assert.equal(presetDisplayText({ id: 'minimal', trust: 'system' }).name, 'Minimal mode')
  assert.equal(presetDisplayText({ id: 'cordis', trust: 'system' }).name, 'Creator mode')
})

test('presetDisplayText renders file metadata for everything else', () => {
  assert.deepEqual(
    presetDisplayText({ id: 'custom', trust: 'user', name: 'My Preset', description: 'mine' }),
    { name: 'My Preset', description: 'mine' },
  )
  // A user-authored preset may shadow a shipped id: trust decides.
  assert.deepEqual(presetDisplayText({ id: 'standard', trust: 'user', name: 'User Standard' }), { name: 'User Standard' })
  assert.deepEqual(presetDisplayText({ id: 'custom', trust: 'system' }), { name: 'custom' })
})
