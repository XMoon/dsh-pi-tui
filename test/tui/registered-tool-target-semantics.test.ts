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
import { toolPresenterFrom, type ToolDefinitionLike, type ToolPresenter } from '../../src/tui/transcript/tool-presentation.ts'
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

test('the Direct and Remote branches agree on every registered tool except the search family', () => {
  // The parity question: the Client branch must not guess by tool name (a
  // plugin may shadow a built-in name), so it reads the TOOL-AUTHORED result
  // metadata instead. This case measures the AGREEMENT SET against the real
  // registry, and pins the one family that still diverges.
  const remote = createClientToolPresenter()
  const kindWith = (
    presenter: ToolPresenter,
    name: string,
    args: Record<string, unknown>,
    meta: unknown,
  ): unknown => {
    const folder = new TranscriptFolder()
    folder.apply([
      ev('turn/start', { turn: 1 }, 0),
      toolCall(1, 'c1', name, args),
      toolResult(2, 'c1', 'ok', meta),
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
  const cases: readonly { name: string; args: Record<string, unknown>; meta: unknown }[] = [
    { name: 'read', args: { file_path: 'src/a.ts' }, meta: readMeta },
    { name: 'edit', args: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, meta: undefined },
    { name: 'write', args: { file_path: 'src/b.ts', content: 'x' }, meta: undefined },
    { name: 'bash', args: { command: 'pnpm test', description: 'Run the tests' }, meta: undefined },
  ]
  for (const testCase of cases) {
    assert.equal(
      kindWith(remote, testCase.name, testCase.args, testCase.meta),
      kindWith(direct, testCase.name, testCase.args, testCase.meta),
      `${testCase.name}: the two branches agree`,
    )
  }

  // The search family still diverges: a PATTERN is provable only from the
  // registered call view, because the search tools' result metadata carries
  // the RESULTS, not the pattern. The Remote branch stays plain there.
  assert.equal(
    kindWith(direct, 'glob', { pattern: 'src/**/*.ts' }, undefined),
    'pattern',
    'the Direct branch proves the pattern from the registered call view',
  )
  assert.equal(
    kindWith(remote, 'glob', { pattern: 'src/**/*.ts' }, undefined),
    'text',
    'the Remote branch cannot prove a pattern, and stays conservative',
  )
})
