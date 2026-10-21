/**
 * The PR-B1 tool-target semantics against the REAL registered tool
 * definitions: the composition root's own scoped-registry lookup, the real
 * `toolPresenterFrom` bridge, the real `toolCardHeader` summary and the real
 * production mapper.
 *
 * The evidence level is stated once, here: these cases mount the REAL
 * `@deepseek-ai/dsh-tools` registry with the REAL published tool plugins
 * (`dsh-tool-fs`, `dsh-tool-bash`, `dsh-tool-fs-search`), so the views they
 * return are the REGISTERED production definitions — not a transcription of
 * them. They are NOT a Host/Client wire proof and NOT a physical-client
 * proof.
 *
 * The failure class this file owns: the mapping must agree with what the
 * REGISTERED tools actually prove, and must refuse exactly where the
 * registered tool and the displayed string disagree.
 * @module @xmoon76/dsh-pi-tui/registered-tool-target-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import * as ShellEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { View, type JsonObject, type Tree } from '@stencil-hq/tern'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { createClientToolPresenter } from '../../src/tui/transcript/client-tool-presenter.ts'
import { toolCardHeader, toolPresenterFrom, type ToolDefinitionLike, type ToolPresenter } from '../../src/tui/transcript/tool-presentation.ts'
import { toolTargetFactsOf, toolTargetKind } from '../../src/tui/transcript/tool-target-semantics.ts'
import { TranscriptNodeKeys, transcriptView } from '../../src/tui/tsp/transcript-view.ts'

const T0 = 1_700_000_000_000

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq, data } as SessionEvent
}
function toolCall(seq: number, id: string, name: string, args: Record<string, unknown>): SessionEvent {
  return ev('tool/call', { turn: 1, step: 0, callId: ToolCallId(id), name, arguments: JSON.stringify(args) }, seq)
}
function toolResult(seq: number, id: string, text: string, meta?: unknown): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${id}`),
      role: 'tool',
      toolCallId: ToolCallId(id),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(id) },
    },
    ...(meta === undefined ? {} : { meta }),
  }, seq)
}

interface FlatNode {
  readonly id: string
  readonly kind: string
  readonly props: JsonObject
}

function flatten(view: View): FlatNode[] {
  const out: FlatNode[] = []
  const visit = (tree: Tree): void => {
    out.push({ id: tree.id, kind: tree.kind, props: tree.props })
    for (const child of tree.children) visit(child)
  }
  const root = view.regions[0]
  if (root) visit(root)
  return out
}

/**
 * A minimal CONCRETE `ctx.shell`: the bash tool's `inject` requires the
 * `shell` capability and the published package ships only the abstract base.
 * The test never EXECUTES a command — it only needs the tool DEFINITION
 * registered so its real `presentCall` can be read.
 */
class ProbeShellExecutor extends ShellExecutor {
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      onExpiry: 'kill',
      stdoutMaxBytes: 64_000,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async execute(_spec: ShellExecSpec): Promise<ShellExecution> {
    throw new Error('the test never executes a command')
  }
}

/** The REAL registry, mounted once for the whole file. */
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(LocalFileSystem)
await ctx.plugin(WorkingDirectory)
await ctx.plugin(ShellEnvPlugin, { dshHome: '/tmp/pr-b1-test-home' })
await ctx.plugin(ProbeShellExecutor)
// The search tools inject the `subprocess` capability. The test never RUNS a
// search — it only needs the tool DEFINITION registered.
ctx.provide('subprocess', {} as never)
await ctx.plugin(ToolFs)
await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
await ctx.plugin(ToolBash)
// The skill tool injects the `skills` capability; the REAL `SkillRegistry` is
// mounted so the tool's OWN call view can be read.
await ctx.plugin(SkillRegistry)
await ctx.plugin(ToolSkill)

const ownerId = SessionId('sess-b1-test')
const scopeFiber = ctx.plugin(() => {})
const owner: Agent = {
  id: ownerId,
  options: {},
  session: Session.create(ownerId),
  inbox: unsupportedInbox(),
  status: 'idle',
  ctx: scopeFiber.ctx,
  send: () => {},
  followup: () => {},
  steer: () => {},
  inject: () => {},
  cancel: () => {},
  runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
  whenIdle: () => Promise.resolve(),
} as unknown as Agent
await ctx.agents.register(owner)

/** The EXACT scoped lookup the production bootstrap presenter performs. */
const registry = (name: string): ToolDefinitionLike | undefined =>
  (ctx.get('tools') as { get(name: string, scope?: object): ToolDefinitionLike | undefined } | undefined)
    ?.get(name, owner)

const presenter = toolPresenterFrom(registry)

/** The REAL production mapper over a REAL fold, with the REAL bridge. */
function toolNodeOf(events: readonly SessionEvent[], cwd?: string): FlatNode | undefined {
  const folder = new TranscriptFolder()
  folder.apply(events)
  const keys = new TranscriptNodeKeys()
  const view = View.from({
    main: transcriptView(projectTranscriptStructure(folder.messages()), keys, {
      ...(cwd === undefined ? {} : { cwd }),
      toolPresenter: presenter,
    }),
  })
  return flatten(view).find(candidate => candidate.kind === 'tool')
}

const CWD = '/home/xmoon/project/dsh-pi-tui'

// ── The registered tools prove what they actually prove ───────────────────

test('the registered read tool proves a path the head displays verbatim', () => {
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/tui/tsp/transcript-view.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/tui/tsp/transcript-view.ts')
  assert.equal(node.props['targetKind'], 'path')
})

test('the registered read tool proves an absolute path the head relativizes', () => {
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: `${CWD}/src/tui/tsp/transcript-view.ts` }),
    toolResult(2, 'c1', 'ok'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/tui/tsp/transcript-view.ts', 'the head relativized the path')
  assert.equal(node.props['targetKind'], 'path')
})

test('the registered edit tool proves the path the head displays', () => {
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
    toolResult(2, 'c1', 'edited', { path: 'src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }] }),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/a.ts')
  assert.equal(node.props['targetKind'], 'path')
})

test('the registered glob tool proves the pattern the head displays', () => {
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'glob', { pattern: 'src/**/*.ts' }),
    toolResult(2, 'c1', 'src/a.ts'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/**/*.ts')
  assert.equal(node.props['targetKind'], 'pattern')
})

test('the registered grep tool proves the pattern the head displays', () => {
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'grep', { pattern: 'targetKind' }),
    toolResult(2, 'c1', 'src/a.ts:1: targetKind'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'targetKind')
  assert.equal(node.props['targetKind'], 'pattern')
})

test('the registered skill tool is NOT a pattern even though its raw input IS the displayed target', () => {
  // THE COUNTEREXAMPLE for a rawInput-only rule: the registered skill tool
  // declares `kind: 'read'` with `rawInput: <the skill name>`, and the DSH head
  // displays that very same name. So "rawInput equals the displayed string"
  // holds — but the string is a SKILL NAME, not a search pattern. Only the
  // tool's own declared kind ('read', not 'search') tells the two apart.
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'skill', { name: 'my-skill' }),
    toolResult(2, 'c1', 'loaded'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'my-skill', 'the head displays the skill name')
  assert.equal(node.props['targetKind'], 'text', 'a skill name is not a search pattern')
})

test('the registered bash tool does NOT prove the description the head displays', () => {
  // The registered bash `presentCall` proves the COMMAND, but the DSH head
  // summary shows the tool's `description`. Two different strings: the
  // displayed text is not proven to be a command.
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'bash', { command: 'pnpm test:product', description: 'Run the product suite' }),
    toolResult(2, 'c1', 'ok\n[exit code: 0]'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'Run the product suite')
  assert.equal(node.props['targetKind'], 'text', 'the displayed description is not the proven command')
})

test('a tool that is not registered keeps the plain text kind', () => {
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'my_vendor_probe', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['targetKind'], 'text')
})

test('the registered tools the head displays a COUNT for keep the plain text kind', () => {
  // Two real reads merge into one card that shows "2 files", not a path.
  const node = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'a.ts' }),
    toolResult(2, 'c1', 'ok'),
    toolCall(3, 'c2', 'read', { file_path: 'b.ts' }),
    toolResult(4, 'c2', 'ok'),
  ], CWD)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['targetKind'], 'text')
})

// ── Direct / Remote parity, measured on the REAL registry ─────────────────

test('both branches prove the path of ONE settled read from its tool-authored metadata', () => {
  // Exactly what this case asserts: for ONE successful read whose metadata and
  // envelope describe the same single file, the Direct branch and the Client
  // branch both reach `path`. That is the whole measured claim.
  //
  // It is NOT a family-wide matrix and NOT a claim about every registered
  // tool. The search family has its own case below, the edit family another,
  // and the refusals have their own cases elsewhere in this file.
  const remote = createClientToolPresenter()
  const kindWith = (
    presenter: ToolPresenter,
    name: string,
    args: Record<string, unknown>,
    meta: unknown,
    text = 'ok',
  ): unknown => {
    const folder = new TranscriptFolder()
    folder.apply([
      ev('turn/start', { turn: 1 }, 0),
      toolCall(1, 'c1', name, args),
      toolResult(2, 'c1', text, meta),
    ])
    const keys = new TranscriptNodeKeys()
    const view = View.from({
      main: transcriptView(projectTranscriptStructure(folder.messages()), keys, {
        cwd: CWD,
        toolPresenter: presenter,
      }),
    })
    return flatten(view).find(node => node.kind === 'tool')?.props['targetKind']
  }

  const direct = toolPresenterFrom(registry)
  const readMeta = { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 }
  const readEnvelope = '<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: a\n</content>'

  assert.equal(
    kindWith(direct, 'read', { file_path: 'src/a.ts' }, readMeta, readEnvelope),
    'path',
    'the Direct branch proves the path from the registered tool',
  )
  assert.equal(
    kindWith(remote, 'read', { file_path: 'src/a.ts' }, readMeta, readEnvelope),
    'path',
    'the Remote branch proves the same path from the tool-authored metadata',
  )
})

test('an edit with NO result metadata is proven by Direct and refused by the Client', () => {
  // This case measures ONE running-shaped edit: call args only, no result
  // metadata. There the Direct branch has the registered tool's own
  // `presentCall`, while the Client's call view is derived from the tool NAME
  // (a guess, so it is not proof). A plugin may register its own tool under a
  // built-in name, which is why that guess cannot be trusted.
  //
  // It does NOT measure a settled edit: with result metadata present the two
  // branches agree, and the real-execution case below covers that.
  const remote = createClientToolPresenter()
  const kindWith = (
    presenter: ToolPresenter,
    name: string,
    args: Record<string, unknown>,
  ): unknown => {
    const folder = new TranscriptFolder()
    folder.apply([
      ev('turn/start', { turn: 1 }, 0),
      toolCall(1, 'c1', name, args),
      toolResult(2, 'c1', 'ok'),
    ])
    const keys = new TranscriptNodeKeys()
    const view = View.from({
      main: transcriptView(projectTranscriptStructure(folder.messages()), keys, {
        cwd: CWD,
        toolPresenter: presenter,
      }),
    })
    return flatten(view).find(node => node.kind === 'tool')?.props['targetKind']
  }

  const direct = toolPresenterFrom(registry)
  const editArgs = { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }
  assert.equal(kindWith(direct, 'edit', editArgs), 'path',
    'the Direct branch proves the path from the registered tool')
  assert.equal(kindWith(remote, 'edit', editArgs), 'text',
    'the Remote branch refuses: its call view is derived from the tool name')
})

test('one glob call proves its pattern on Direct and stays plain on the Client', () => {
  // This case measures ONE glob call. A PATTERN is provable only from the
  // registered call view, because the search tools' result metadata carries
  // the RESULTS, not the pattern. The Client branch stays plain.
  //
  // `grep` is not separately exercised here; it shares the same shape (a
  // `search`-kind call view whose raw input is the pattern), so this is a
  // sample, not a family-wide matrix.
  const remote = createClientToolPresenter()
  const kindWith = (presenter: ToolPresenter): unknown => {
    const folder = new TranscriptFolder()
    folder.apply([
      ev('turn/start', { turn: 1 }, 0),
      toolCall(1, 'c1', 'glob', { pattern: 'src/**/*.ts' }),
      toolResult(2, 'c1', 'ok'),
    ])
    const keys = new TranscriptNodeKeys()
    const view = View.from({
      main: transcriptView(projectTranscriptStructure(folder.messages()), keys, {
        cwd: CWD,
        toolPresenter: presenter,
      }),
    })
    return flatten(view).find(node => node.kind === 'tool')?.props['targetKind']
  }

  assert.equal(kindWith(toolPresenterFrom(registry)), 'pattern',
    'the Direct branch proves the pattern from the registered call view')
  assert.equal(kindWith(remote), 'text',
    'the Remote branch cannot prove a pattern, and stays conservative')
})

// ── A REAL read execution, through both branches ──────────────────────────

test('a REAL read execution yields the SAME view on both branches', async (t) => {
  // The Client derivation requires the result content to be exactly the ONE
  // read envelope the metadata describes, and requires the envelope's path and
  // the metadata's path to be the SAME string. Both are assumptions about the
  // REAL tool's output, so assert them against an actual execution: if the
  // envelope shape or the path ever diverge, this case fails instead of the
  // feature silently degrading to `text` forever.
  const life = testLifecycle(t)
  const dir = life.tempDir('pr-b1-real-read-')
  await mkdir(join(dir, 'src'), { recursive: true })
  const filePath = join(dir, 'src', 'real.ts')
  await writeFile(filePath, 'const answer = 42\n')

  const outcome = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('call-b1-real-read'),
    name: 'read',
    arguments: { file_path: filePath },
    agent: owner,
  })
  assert.equal(outcome.isError, false, 'the real read succeeded')

  const only = outcome.content.length === 1 ? outcome.content[0] : undefined
  assert.ok(only !== undefined && only.type === 'text', 'the real result is ONE text block')
  const envelopePath = /^<path>([^\n]*)<\/path>/.exec(only.text)?.[1]
  const metaPath = (outcome.meta as { path?: string } | undefined)?.path
  assert.equal(envelopePath, metaPath, 'the envelope path and the metadata path agree')

  const argsRaw = JSON.stringify({ file_path: filePath })
  const input = {
    content: outcome.content,
    isError: outcome.isError,
    ...outcome.meta === undefined ? {} : { meta: outcome.meta },
  }
  const directView = toolPresenterFrom(registry).result('read', argsRaw, input)
  const clientView = createClientToolPresenter().result('read', argsRaw, input)
  assert.ok(directView !== undefined && directView.card === 'read', 'the Direct branch produced a read view')
  assert.ok(clientView !== undefined && clientView.card === 'read', 'the Client branch produced a read view')
  for (const field of ['path', 'offset', 'totalLines'] as const) {
    assert.equal(clientView[field], directView[field], `the two branches agree on ${field}`)
  }
  assert.deepEqual(clientView.lines, directView.lines, 'the two branches agree on the lines')
})

test('a REAL settled read asked for by a RELATIVE path still claims the path kind', async () => {
  // The two stages of a real call spell one file differently: `presentCall`
  // repeats the argument the model wrote (`package.json`), while the result
  // metadata reports the path the tool resolved (an absolute path). The
  // classifier must read that as ONE file. Unioning the two representations
  // would demote the row to `text` exactly when the call finishes.
  const relative = 'package.json'
  const args = { file_path: relative }
  const outcome = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('call-b1-relative'),
    name: 'read',
    arguments: args,
    agent: owner,
  })
  assert.equal(outcome.isError, false, 'the real relative read succeeded')

  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', args),
    // The REAL result content: the read envelope is what the tool's own
    // presenter parses, so a placeholder body would prove nothing.
    ev('tool/result', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('result-c1'),
        role: 'tool',
        toolCallId: ToolCallId('c1'),
        content: [...outcome.content],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
      ...outcome.meta === undefined ? {} : { meta: outcome.meta },
    }, 2),
  ])
  const row = folder.messages().find((m): m is Extract<typeof m, { kind: 'tool' }> => m.kind === 'tool')
  assert.ok(row !== undefined, 'the folded row exists')
  const cwd = process.cwd()
  const header = toolCardHeader('read', row.args, cwd)
  const facts = toolTargetFactsOf(presenter, row)
  const callPath = (facts.callView as { locations?: { path?: string }[] } | undefined)?.locations?.[0]?.path
  const resultPath = (facts.resultView as { card: string; path?: string } | undefined)?.path
  assert.equal(callPath, relative, 'the call view repeats the RELATIVE argument')
  assert.ok(resultPath !== undefined && resultPath.startsWith('/'), 'the result view reports the resolved ABSOLUTE path')
  assert.notEqual(callPath, resultPath, 'the two stages spell the same file differently')
  assert.equal(header.summary, relative, 'the head shows the argument the model wrote')
  assert.equal(
    toolTargetKind(header.summary, facts, cwd),
    'path',
    'one file is one path, however each stage spells it',
  )
})
