/**
 * Headless tests for the P6/D2.3 preset wiring: `composeAgent` (roster-absent
 * and roster-present composition), `recordedPreset` (log-first resolution),
 * `selectBlankSessionPreset` (the official Host blank-Session write) +
 * `turnBoundaryBlank` (the Host turn-boundary blank read), and
 * `presetDisplayText` (the English display copy for the shipped presets).
 * @module @xmoon76/dsh-pi-tui/preset.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { composeAgent, recordedPreset } from '../src/index.ts'
import { presetDisplayText } from '../src/commands.ts'
import { recordedSessionPreset, selectBlankSessionPreset, sessionPresetOf, turnBoundaryBlank, type SessionObservationLike } from '../src/runtime/direct/session-preset-direct.ts'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

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
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd: '/tmp',
    isSeeded: false,
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

/** A small host double that delegates to the official projection definition. */
const agentPresetProjection = {
  stateOf(session: Session, _key: 'agentPreset'): string | null {
    let value = agentPresetProjectionDefinition.init(session.header)
    for (const event of session.snapshotEvents()) value = agentPresetProjectionDefinition.apply(value, event)
    return value
  },
}

function projectedCtx(persistence?: unknown, presets?: unknown, query?: unknown): Context {
  return ctxWith(name => {
    if (name === 'sessionProjections') return agentPresetProjection
    if (name === 'sessionPersistence') return persistence
    if (name === 'agentPresets') return presets
    if (name === 'sessionQuery') return query
    return undefined
  })
}

/** One fake observation lease over the official `observeSession` seam. */
function observation(agentPreset: string | null | undefined): SessionObservationLike {
  return {
    source: 'prepared',
    header: sessionHeader('s1'),
    ...(agentPreset === undefined ? {} : { projections: { values: { agentPreset } } }),
    [Symbol.dispose]: () => {},
  }
}

/** A fake `sessionQuery` whose observation seam serves one value per id. */
function queryObserving(
  observe: (id: string) => SessionObservationLike | Promise<SessionObservationLike>,
): { observeSession: (id: SessionId) => Promise<SessionObservationLike> } {
  return {
    observeSession: async (id: SessionId) => observe(String(id)),
  }
}

/** Minimal unpublished-agent setup inputs for the explicit rc.1 seam. */
function agentCtx(): Context {
  return { on: () => () => {} } as unknown as Context
}

function recordingAgentCtx(events: string[]): Context {
  return {
    on: (event: string) => {
      events.push(event)
      return () => {}
    },
  } as unknown as Context
}

const installSelection = (_agentCtx: Context, _agent: Agent): void => {}
const unpublishedAgent = {} as Agent

test('composeAgent without a roster composes nothing and installs only model selection', async () => {
  const ctx = ctxWith(() => undefined)
  const composition = await composeAgent(ctx, installSelection)
  assert.equal(composition.agentPreset, undefined)
  assert.equal(typeof composition.setup, 'function')
})

test('composeAgent preserves ModelSelectionRef standalone compatibility', async () => {
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  const events: string[] = []
  const composition = await composeAgent(ctxWith(() => undefined), selection)
  await composition.setup(recordingAgentCtx(events))
  assert.deepEqual(events, ['system-prompt/assemble', 'agent/request', 'agent/pre-step'])
})

test('composeAgent installs a legacy selection before mounting a roster', async () => {
  const fake = roster()
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  const events: string[] = []
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, selection)
  await composition.setup(recordingAgentCtx(events))
  assert.deepEqual(events, ['system-prompt/assemble', 'agent/request', 'agent/pre-step'])
  assert.deepEqual(fake.mounted, ['standard'])
})

test('composeAgent passes the composed Agent to the explicit installer', async () => {
  let received: Agent | undefined
  const installer = (_agentCtx: Context, agent: Agent): void => { received = agent }
  const composition = await composeAgent(ctxWith(() => undefined), installer)
  await composition.setup(agentCtx(), unpublishedAgent)
  assert.equal(received, unpublishedAgent)
})

test('composeAgent rejects code when no preset roster exists', async () => {
  const ctx = ctxWith(() => undefined)
  await assert.rejects(
    composeAgent(ctx, installSelection, 'code'),
    /preset "code" is unavailable/,
  )
})

test('composeAgent with a roster resolves the default and mounts it in setup', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, installSelection)
  assert.equal(composition.agentPreset, 'standard')
  await composition.setup(agentCtx(), unpublishedAgent)
  assert.deepEqual(fake.mounted, ['standard'])
})

test('composeAgent mounts the named preset, not the default', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, installSelection, 'minimal')
  assert.equal(composition.agentPreset, 'minimal')
  await composition.setup(agentCtx(), unpublishedAgent)
  assert.deepEqual(fake.mounted, ['minimal'])
})

test('composeAgent accepts a legal custom code preset', async () => {
  const fake = roster()
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  const composition = await composeAgent(ctx, installSelection, 'code')
  assert.equal(composition.agentPreset, 'code')
  await composition.setup(agentCtx(), unpublishedAgent)
  assert.deepEqual(fake.mounted, ['code'])
})

test('composeAgent keeps a real custom code default instead of applying the legacy fallback', async () => {
  const fake = roster()
  const service = { ...fake.service, defaultId: 'code' }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const composition = await composeAgent(ctx, installSelection)
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
  const composition = await composeAgent(ctx, installSelection)
  assert.deepEqual(resolvedIds, ['code', 'ptc'])
  assert.equal(composition.agentPreset, 'ptc')
  await composition.setup(agentCtx(), unpublishedAgent)
  assert.deepEqual(fake.mounted, ['ptc'])
})

test('composeAgent propagates an unknown-preset rejection', async () => {
  const fake = roster({ unknown: true })
  const ctx = ctxWith(name => name === 'agentPresets' ? fake.service : undefined)
  await assert.rejects(composeAgent(ctx, installSelection, 'nope'), /not found/)
})

test('recordedPreset returns undefined without the observation seam', async () => {
  const ctx = ctxWith(() => undefined)
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

test('recordedPreset preserves a native V3 code projection without a roster', async () => {
  const ctx = projectedCtx(undefined, undefined, queryObserving(() => observation('code')))
  assert.equal(await recordedPreset(ctx, 's1'), 'code')
})

test('recordedPreset propagates an unknown-session observation rejection', async () => {
  const ctx = projectedCtx(undefined, undefined, queryObserving(() => {
    throw new Error('session "s1" not found')
  }))
  await assert.rejects(recordedPreset(ctx, 's1'), /not found/)
})

test('recordedPreset preserves an unreadable session error instead of falling back to its header', async () => {
  const ctx = projectedCtx(undefined, undefined, queryObserving(() => {
    throw new Error('log unreadable')
  }))
  await assert.rejects(recordedPreset(ctx, 's1'), /log unreadable/)
})

test('recordedPreset uses the projection: the newest selection wins over the header', async () => {
  const ctx = projectedCtx(undefined, undefined, queryObserving(() => observation('minimal')))
  assert.equal(await recordedPreset(ctx, 's1'), 'minimal')
})

test('recordedPreset preserves code when the current roster has a custom code preset', async () => {
  const fake = roster()
  const ctx = ctxWith(name => {
    if (name === 'sessionProjections') return agentPresetProjection
    if (name === 'agentPresets') return fake.service
    if (name === 'sessionQuery') return queryObserving(() => observation('code'))
    return undefined
  })
  assert.equal(await recordedPreset(ctx, 's1'), 'code')
})

test('recordedPreset returns undefined for a pre-roster session log', async () => {
  const ctx = projectedCtx(undefined, undefined, queryObserving(() => observation(null)))
  assert.equal(await recordedPreset(ctx, 's1'), undefined)
})

test('sessionPresetOf reads a header-only session through the projection seam', () => {
  const session = Session.create(SessionId('s1'), [], sessionHeader('s1', 'standard'))
  assert.equal(sessionPresetOf(projectedCtx(), session), 'standard')
})

test('selectBlankSessionPreset delegates to the official agentPresets.select seam', async () => {
  const calls: Array<{ agent: unknown; id: string }> = []
  const service = {
    select: async (agent: unknown, id: string) => { calls.push({ agent, id }); return id },
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const agent = { id: 'agent-1' }
  assert.equal(await selectBlankSessionPreset(ctx, agent, 'minimal'), 'minimal')
  assert.deepEqual(calls, [{ agent, id: 'minimal' }], 'the Host owns the blank check and the recompose transaction')
})

test('selectBlankSessionPreset throws without a preset service', async () => {
  const ctx = ctxWith(() => undefined)
  await assert.rejects(
    selectBlankSessionPreset(ctx, { id: 'agent-1' }, 'standard'),
    /agent presets unavailable/,
  )
})

test('selectBlankSessionPreset propagates the official refusal (e.g. agent-preset/locked)', async () => {
  const service = {
    select: async () => { throw Object.assign(new Error('session has already started'), { code: 'agent-preset/locked' }) },
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  await assert.rejects(
    selectBlankSessionPreset(ctx, { id: 'agent-1' }, 'minimal'),
    /already started/,
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

// ── D2.3 Host turn-boundary blank authority ───────────────────────────────

test('turnBoundaryBlank reads the official turn-boundary authority, never the transcript', () => {
  assert.equal(turnBoundaryBlank(undefined), true, 'no boundary recorded yet = blank')
  assert.equal(turnBoundaryBlank(null), true)
  assert.equal(turnBoundaryBlank({ openTurnStartSeq: null, lastTurn: 0 }), true)
  assert.equal(turnBoundaryBlank({ openTurnStartSeq: 3, lastTurn: 0 }), false, 'an open turn is started')
  assert.equal(turnBoundaryBlank({ openTurnStartSeq: null, lastTurn: 2 }), false, 'a completed turn is started')
  assert.equal(turnBoundaryBlank({ openTurnStartSeq: 'x', lastTurn: 0 }), undefined, 'a malformed value is unknown')
  assert.equal(turnBoundaryBlank({ lastTurn: 0 }), undefined)
  assert.equal(turnBoundaryBlank(42), undefined)
})

test('sessionPresetOf is undefined (never a crash) when the projection read throws', () => {
  const ctx = {
    get: (name: string) => name === 'sessionProjections'
      ? { stateOf: () => { throw new Error('projection teardown') } }
      : undefined,
  }
  assert.equal(sessionPresetOf(ctx as never, { header: { id: 's' } } as never), undefined)
})

test('recordedSessionPreset aborts after the observe await (no compose/resume on a cancelled open)', async () => {
  const started = { resolve: () => {} }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observed = new Promise<void>((resolve) => { started.resolve = resolve })
  const ctx = {
    get: (name: string) => name === 'sessionQuery'
      ? {
          observeSession: async () => {
            started.resolve()
            await gate
            return { projections: { values: { agentPreset: 'standard' } }, [Symbol.dispose]: () => {} }
          },
        }
      : undefined,
  }
  const controller = new AbortController()
  const pending = recordedSessionPreset(ctx as never, 'session-a', controller.signal)
  await observed
  controller.abort()
  release()
  await assert.rejects(pending, /abort/i)
})
