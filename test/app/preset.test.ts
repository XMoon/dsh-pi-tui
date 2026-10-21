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
import { composeAgent, recordedPreset } from '../../src/index.ts'
import { presetDisplayText } from '../../src/commands.ts'
import { builtInGuide, GUIDE_SECTION_HEADS } from '../../src/tui/tsp/preset-guide-content.ts'
import { recordedSessionPreset, selectBlankSessionPreset, sessionPresetOf, turnBoundaryBlank, type SessionObservationLike } from '../../src/runtime/direct/session-preset-direct.ts'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
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

test('composeAgent without a roster composes preset-free — no id is special', async () => {
  const ctx = ctxWith(() => undefined)
  const composition = await composeAgent(ctx, installSelection, 'code')
  assert.equal('agentPreset' in composition, false, 'a rosterless deployment carries no preset identity, even for code')
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

test('composeAgent composes a declared code default as itself — never rewritten', async () => {
  const fake = roster()
  const service = {
    ...fake.service,
    defaultId: 'code',
    // Real-registry semantics: an omitted id resolves the declared default.
    resolve: async (id?: string) => ({ id: id ?? 'code' }),
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  const composition = await composeAgent(ctx, installSelection)
  assert.equal(composition.agentPreset, 'code')
  await composition.setup(agentCtx(), unpublishedAgent)
  assert.deepEqual(fake.mounted, ['code'])
})

test('composeAgent refuses an undeclared default — no ptc fallback, one resolution', async () => {
  const fake = roster()
  const resolvedIds: Array<string | undefined> = []
  const service = {
    ...fake.service,
    defaultId: 'code',
    resolve: async (id?: string) => {
      const wanted = id ?? 'code'
      resolvedIds.push(wanted)
      if (wanted === 'code') throw Object.assign(new Error('unknown preset'), { presetId: 'code' })
      return { id: wanted }
    },
  }
  const ctx = ctxWith(name => name === 'agentPresets' ? service : undefined)
  await assert.rejects(composeAgent(ctx, installSelection), /unknown preset/u)
  assert.deepEqual(resolvedIds, ['code'], 'exactly one registry resolution — no fallback probe')
  assert.deepEqual(fake.mounted, [])
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
  // A shipped declaration publishes no name (the official built-in
  // classification); the canonical id mapping keeps the TUI's built-in
  // picker copy stable regardless of the declaration's description.
  assert.deepEqual(presetDisplayText({ id: 'standard', description: '中文描述' }), {
    name: 'Standard mode',
    description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
  })
  assert.equal(presetDisplayText({ id: 'ptc' }).name, 'PTC mode')
  assert.equal(presetDisplayText({ id: 'minimal' }).name, 'Minimal mode')
  assert.equal(presetDisplayText({ id: 'cordis' }).name, 'Creator mode')
})

test('presetDisplayText renders declaration metadata for everything else', () => {
  assert.deepEqual(
    presetDisplayText({ id: 'custom', name: 'My Preset', description: 'mine' }),
    { name: 'My Preset', description: 'mine' },
  )
  // A declaration that names itself owns its copy, even on a shipped id
  // (official rule: named metadata is never translated).
  assert.deepEqual(presetDisplayText({ id: 'standard', name: 'User Standard' }), { name: 'User Standard' })
  // An unknown id without a name falls back to the id itself.
  assert.deepEqual(presetDisplayText({ id: 'custom' }), { name: 'custom' })
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

test('builtInGuide carries the four shipped presets\u2019 official copy verbatim, sectioned in the official order', () => {
  // The upstream seat values this module pins (the exact composition the official
  // Web dialog renders): `## Mode details` -> intro + explanation, `## How to use`
  // -> usage. Source: deepseek-ai/deepseek-harness@d743267388641bc76f17c45ce8b4c231aed1d32c
  // `packages/client/ui-agent-preset/src/client/guide-locales.ts` (`guideEn`).
  const sectionHead = GUIDE_SECTION_HEADS
  const shipped = {
    standard: {
      intro: 'Choose Standard mode when starting a new task. Describe what you want to accomplish, point to the relevant files, and explain how to check the result.',
      explanation: [
        '### How it works',
        'The agent calls tools directly to read and edit files, search, and run terminal commands. It includes Skills, planning, goals, subagents, workflows, and context compaction.',
        '### When to choose it',
        'Start here for everyday coding, file work, and research. Standard mode can also write scripts and process files in batches. PTC changes how tool calls are organized; it is not required for batch tasks.',
      ].join('\n\n'),
      usage: [
        '### Fix a bug',
        '> Find out why submitting the search form twice makes the results disappear. Fix it and run the relevant tests. Explain the cause and what changed.',
        'Expected output: a code change, the relevant test results, and an explanation of the cause.',
        '### Organize project notes',
        '> Read the Markdown notes in this project. Summarize the agreed decisions and open questions, with links to the source files.',
        'Expected output: a summary with references that you can check against the original notes.',
      ].join('\n\n'),
    },
    ptc: {
      intro: 'Choose PTC mode when starting a new task. Specify the input files, processing rules, and output format. The agent writes the code.',
      explanation: [
        '### How tools are called',
        'PTC means Programmatic Tool Calling. In this built-in preset, the agent uses run_code to write a TypeScript program that calls tools through a generated SDK. The program can use loops, conditions, error handling, and concurrent calls where appropriate.',
        '### What reaches the model',
        'Tool results first reach the program, which can filter and combine them. The model receives what the program prints or returns; image results are attached separately. Nested tool calls are still recorded and remain subject to tool permissions.',
        '### Compared with Standard mode',
        'Both modes can handle coding and batch tasks. Standard mode exposes individual tools directly; PTC organizes tool calls in code. The current PTC preset leaves the workflow tool disabled. Speed and token use depend on the task and how the program handles its results.',
      ].join('\n\n'),
      usage: [
        '### Check a set of configuration files',
        '> Check all JSON files in configs/. List missing required fields and invalid values against schema.json. Save a CSV with one row per issue. Include unreadable files in the report and keep checking the rest. Leave the original files unchanged.',
        'Expected output: an issue summary and a CSV report. The program can repeat the same checks, handle individual failures, and collect the results.',
        '### Summarize error logs',
        '> Analyze the log files in logs/. Group errors by service and error type. Show the ten most frequent groups and one example from each. Save the full counts to a CSV.',
        'Expected output: the top error groups and a complete count table. Intermediate data can be aggregated in the program before the summary reaches the model.',
      ].join('\n\n'),
    },
    minimal: {
      intro: 'Choose Minimal mode for a new task. For a comparison, hold the model, permissions, input, and starting workspace state constant across runs.',
      explanation: [
        '### What is included',
        'One persistent shell tool and a fixed system prompt. The built-in preset does not load Skills, planning, context compaction, or the standard runtime context.',
        '### When to choose it',
        'Use it as a baseline for experiments and comparisons. It can still read files and execute scripts through shell commands, but offers fewer built-in ways to manage a long task. Fewer tools does not necessarily make it easier for a beginner.',
      ].join('\n\n'),
      usage: [
        '### Compare performance on a small bug fix',
        '> Run the tests for this project, find the cause of the failure, and make the smallest fix. Run the relevant tests again and report the result.',
        'Run the same task separately in Standard and Minimal modes from the same starting state. Compare task completion, tool calls, and the resulting changes. Minimal mode performs the work through terminal commands.',
      ].join('\n\n'),
    },
    cordis: {
      intro: 'Choose Creator mode for a new task. Describe the capability you want, where it should appear, and how you will verify it.',
      explanation: [
        '### What you can create',
        'Creator mode includes the standard task tools plus runtime inspection, persistent plugin management, and guidance for authoring Cordis plugins and agent presets. It can create a plugin that adds a capability or UI, or a preset that combines tools and prompts for a particular job.',
        '### Plugins and modes',
        'A plugin adds capabilities to DSH, such as a tool, a service connection, or a UI entry. A mode is an agent preset that selects tools and defines how the agent works in a task. A plugin can be included in a custom preset.',
        '### How the result takes effect',
        'Ask the agent to install and verify the result, not just generate source code. A plugin may load immediately or require a restart, depending on what it changes. A newly created preset is selected when starting a new task.',
      ].join('\n\n'),
      usage: [
        '### Add a UI',
        '> Create a DSH plugin that adds a project notes entry to the sidebar. Let me browse the Markdown files in this workspace and preview a selected note. Install it and verify that the page opens.',
        'Expected output: an installed plugin with a working entry and preview page, plus any remaining activation steps.',
        '### Add a tool',
        '> Create a plugin with a tool that reads this project\u2019s test report and summarizes the failed tests. Register it and verify it with a sample report.',
        'Expected output: a plugin with a callable tool and a verified sample call.',
        '### Create my own mode',
        '> Create a \u201cCode review\u201d mode based on Standard mode. Have it prioritize potential bugs and test gaps, cite file paths and lines, and ask before modifying files. Save it as a selectable preset.',
        'Expected output: a custom preset for new tasks. These review instructions guide the agent; permission settings determine which actions it can execute.',
      ].join('\n\n'),
    },
  }
  for (const [id, copy] of Object.entries(shipped)) {
    const md = builtInGuide({ id, builtIn: true })
    const want = [
      `## ${sectionHead.modeDetails}`,
      [copy.intro, copy.explanation].join('\n\n'),
      `## ${sectionHead.howToUse}`,
      copy.usage,
    ].join('\n\n')
    assert.equal(md, want, `${id}: the guide is the pinned upstream copy in the official order`)
  }
})

test('builtInGuide never lends the official copy to a Custom declaration or an unknown shipped id', () => {
  // A declaration that reuses a shipped id but publishes its own name stays Custom
  // (the caller derives `builtIn` from the raw DTO); it must not inherit the guide.
  assert.equal(builtInGuide({ id: 'standard', builtIn: false }), undefined)
  assert.equal(builtInGuide({ id: 'ptc', builtIn: false }), undefined)
  // A shipped-classified row whose id is not in the pinned table gets nothing
  // (never a fabricated or empty guide).
  assert.equal(builtInGuide({ id: 'not-a-shipped-id', builtIn: true }), undefined)
})
