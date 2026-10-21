/**
 * The PR-B1 tool-target semantics: the conservative proof that a tool row's
 * DISPLAYED target is a command, a single path or a pattern before the native
 * client is allowed to draw it with the matching syntax.
 *
 * The evidence level is stated once, here: the cases below drive the REAL
 * production mapper over the REAL `TranscriptFolder` and the REAL SDK `View`,
 * and the registered-tool cases drive the REAL registered definitions through
 * the REAL `toolPresenterFrom` bridge. They are NOT a Host/Client wire proof
 * and NOT a physical-client proof.
 *
 * The failure class this file owns: a row that is NOT proven must never claim
 * a specialised kind, and a row that IS proven must claim exactly the kind
 * its registered view proves. Both directions are asserted, so a mapping that
 * always returned `text` would fail here too.
 * @module @xmoon76/dsh-pi-tui/tool-target-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { View, type JsonObject, type Tree } from '@stencil-hq/tern'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { createClientToolPresenter } from '../../src/tui/transcript/client-tool-presenter.ts'
import { toolPresenterFrom, type ToolDefinitionLike } from '../../src/tui/transcript/tool-presentation.ts'
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
  readonly parent: string | undefined
}

function flatten(view: View): FlatNode[] {
  const out: FlatNode[] = []
  const visit = (tree: Tree, parent: string | undefined): void => {
    out.push({ id: tree.id, kind: tree.kind, props: tree.props, parent })
    for (const child of tree.children) visit(child, tree.id)
  }
  const root = view.regions[0]
  if (root) visit(root, undefined)
  return out
}

/**
 * The REAL production mapper over a REAL fold, and the tool node it produced.
 * The presenter is injected the way the composition root injects it.
 */
function toolNodeOf(
  events: readonly SessionEvent[],
  presenter: ToolDefinitionLike | undefined,
  cwd?: string,
): { node: FlatNode | undefined; row: Extract<TranscriptMessage, { kind: 'tool' }> | undefined } {
  const folder = new TranscriptFolder()
  folder.apply(events)
  const keys = new TranscriptNodeKeys()
  const view = View.from({
    main: transcriptView(projectTranscriptStructure(folder.messages()), keys, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(presenter === undefined ? {} : { toolPresenter: toolPresenterFrom(() => presenter) }),
    }),
  })
  const row = folder.messages().find((m): m is Extract<TranscriptMessage, { kind: 'tool' }> => m.kind === 'tool')
  const node = flatten(view).find(candidate => candidate.kind === 'tool')
  return { node, row }
}

/** The read tool's OWN registered view shape (the published contract). */
const READ_PRESENTER: ToolDefinitionLike = {
  presentCall: (args: unknown) => {
    const a = args as { file_path?: string; offset?: number }
    return {
      card: 'generic',
      title: `Read ${a.file_path}`,
      kind: 'read',
      locations: [{ path: String(a.file_path), line: a.offset ?? 1 }],
    }
  },
}

/** The search tool's OWN registered view shape (the published contract). */
const SEARCH_PRESENTER: ToolDefinitionLike = {
  presentCall: (args: unknown) => {
    const a = args as { pattern?: string }
    return { card: 'generic', title: `Glob ${a.pattern}`, kind: 'search', rawInput: a.pattern }
  },
}

/** The bash tool's OWN registered view shape (the published contract). */
const BASH_PRESENTER: ToolDefinitionLike = {
  presentCall: (args: unknown) => {
    const a = args as { command?: string; description?: string }
    return { card: 'terminal', title: String(a.command), description: a.description }
  },
}

// ── The proven kinds ───────────────────────────────────────────────────────

test('a read row whose displayed target is the tool\'s own proven path claims the path kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/tui/tsp/transcript-view.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], READ_PRESENTER)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/tui/tsp/transcript-view.ts')
  assert.equal(node.props['targetKind'], 'path')
})

test('a search row whose displayed target is the tool\'s own proven pattern claims the pattern kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'glob', { pattern: 'src/**/*.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], SEARCH_PRESENTER)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/**/*.ts')
  assert.equal(node.props['targetKind'], 'pattern')
})

test('a terminal row whose displayed target IS the tool\'s own command claims the command kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'bash', { command: 'pnpm test:product' }),
    toolResult(2, 'c1', 'ok'),
  ], BASH_PRESENTER)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'pnpm test:product')
  assert.equal(node.props['targetKind'], 'command')
})

// ── The refusals ───────────────────────────────────────────────────────────

test('a bash row whose displayed target is the tool\'s description never claims the command kind', () => {
  // The head shows the `description` (the DSH summary key preference), while
  // the tool proves the `command`. The two are DIFFERENT strings, so the
  // displayed text is not proven to be a command.
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'bash', { command: 'pnpm test:product', description: 'Run the product suite' }),
    toolResult(2, 'c1', 'ok'),
  ], BASH_PRESENTER)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'Run the product suite')
  assert.equal(node.props['targetKind'], 'text')
})

test('a row with no registered presenter keeps the plain text kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], undefined)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/a.ts')
  assert.equal(node.props['targetKind'], 'text')
})

test('a tool that declares no view keeps the plain text kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'my_vendor_probe', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], READ_PRESENTER)
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['targetKind'], 'text')
})

test('a row whose displayed target differs from the tool\'s proven path keeps the plain text kind', () => {
  // The presenter proves `src/a.ts`, but the head displays something else.
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], {
    presentCall: () => ({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path: 'src/OTHER.ts' }] }),
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/a.ts')
  assert.equal(node.props['targetKind'], 'text')
})

test('a row whose displayed target differs from the tool\'s proven pattern keeps the plain text kind', () => {
  // The search tool proves the pattern `src/**/*.ts`, but the head displays
  // the query the DSH summary key prefers. Two different strings: the
  // displayed text is not proven to be the pattern.
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'web_search', { query: 'tern tsp tool card' }),
    toolResult(2, 'c1', 'ok'),
  ], {
    presentCall: () => ({
      card: 'generic',
      title: 'Web search',
      kind: 'search',
      rawInput: 'src/**/*.ts',
    }),
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'tern tsp tool card')
  assert.equal(node.props['targetKind'], 'text')
})

test('a tool that does not DECLARE the search kind never proves a pattern', () => {
  // The declared kind is the semantic discriminator. This tool's raw input
  // IS a string the head could display, but it declares `kind: 'execute'` —
  // so the string is a COMMAND, never a search pattern. (The registered
  // background bash is exactly this shape.)
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'bash', { command: 'sleep 1', description: 'Background a sleep', run_in_background: true }),
    toolResult(2, 'c1', 'started'),
  ], {
    presentCall: () => ({
      card: 'generic',
      title: 'sleep 1',
      kind: 'execute',
      rawInput: 'sleep 1',
    }),
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'Background a sleep')
  assert.equal(node.props['targetKind'], 'text')
})

test('a tool that declares the search kind and displays its raw input claims the pattern kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'glob', { pattern: 'src/**/*.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], {
    presentCall: () => ({
      card: 'generic',
      title: 'Glob src/**/*.ts',
      kind: 'search',
      rawInput: 'src/**/*.ts',
    }),
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/**/*.ts')
  assert.equal(node.props['targetKind'], 'pattern')
})

test('a row proving SEVERAL paths keeps the plain text kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], {
    presentCall: () => ({
      card: 'generic',
      title: 'Read',
      kind: 'read',
      locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    }),
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['targetKind'], 'text')
})

test('a result view whose path DISAGREES with the displayed path keeps the plain text kind', () => {
  // The call view proves `src/a.ts` and the result view proves a DIFFERENT
  // path. Two proven paths, one displayed string: the displayed string is not
  // identified as either of them, so the row refuses.
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok', { path: '/host/absolute/other.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 }),
  ], {
    presentCall: () => ({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path: 'src/a.ts' }] }),
    presentResult: () => ({
      card: 'read',
      path: '/host/absolute/other.ts',
      offset: 1,
      lines: [{ number: 1, text: 'a' }],
      totalLines: 1,
    }),
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/a.ts')
  assert.equal(node.props['targetKind'], 'text')
})

test('a merged read group keeps the plain text kind', () => {
  // Two real reads collapse into ONE card that shows a count, not a path.
  const { node, row } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'a.ts' }),
    toolResult(2, 'c1', 'ok'),
    toolCall(3, 'c2', 'read', { file_path: 'b.ts' }),
    toolResult(4, 'c2', 'ok'),
  ], READ_PRESENTER)
  assert.ok(row !== undefined, 'the merged row exists')
  assert.equal(row.callCount, 2, 'the fold merged the two reads')
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['targetKind'], 'text')
})

test('an orphan result row renders the warning card and never a tool node', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolResult(1, 'c-orphan', 'late replay evidence'),
  ], READ_PRESENTER)
  assert.equal(node, undefined, 'an orphan row is never a tool node')
})

// ── The unchanged surface ──────────────────────────────────────────────────

test('the target kind is the ONLY difference: the target, title, status and body are unchanged', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'the result body'),
  ] as const
  const withoutPresenter = toolNodeOf(events, undefined).node
  const withPresenter = toolNodeOf(events, READ_PRESENTER).node
  assert.ok(withoutPresenter !== undefined && withPresenter !== undefined)
  assert.equal(withPresenter.props['target'], withoutPresenter.props['target'])
  assert.equal(withPresenter.props['title'], withoutPresenter.props['title'])
  assert.equal(withPresenter.props['name'], withoutPresenter.props['name'])
  assert.equal(withPresenter.props['status'], withoutPresenter.props['status'])
  assert.equal(withPresenter.props['key'], withoutPresenter.props['key'])
  // The only difference is the kind itself.
  assert.equal(withoutPresenter.props['targetKind'], 'text')
  assert.equal(withPresenter.props['targetKind'], 'path')
  assert.deepEqual(
    Object.keys(withPresenter.props).filter(key => key !== 'targetKind').sort(),
    Object.keys(withoutPresenter.props).filter(key => key !== 'targetKind').sort(),
    'the tool node carries no new prop',
  )
})

test('a workspace-relative display of an absolute proven path still claims the path kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: '/repo/src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], {
    presentCall: () => ({ card: 'generic', title: 'Read', kind: 'read', locations: [{ path: '/repo/src/a.ts' }] }),
  }, '/repo')
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['target'], 'src/a.ts', 'the head relativized the displayed path')
  assert.equal(node.props['targetKind'], 'path')
})

test('a presenter that throws leaves the row with the plain text kind', () => {
  const { node } = toolNodeOf([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'c1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'c1', 'ok'),
  ], {
    presentCall: () => { throw new Error('the tool presenter exploded') },
  })
  assert.ok(node !== undefined, 'the tool node exists')
  assert.equal(node.props['targetKind'], 'text')
})

// ── The Remote branch ──────────────────────────────────────────────────────

test('the Remote branch reaches the path kind for the tools whose OWN result metadata states a path', () => {
  // The Client-derived presenter never consults a Host registry. It derives a
  // diff view from the raw edit/write arguments, and it reads the TOOL-AUTHORED
  // result metadata for the read family. So a Remote read row reaches the same
  // path kind as a Direct one, without a Host field and without inferring by
  // tool name.
  const remote = createClientToolPresenter()
  const kindsOf = (name: string, args: Record<string, unknown>, meta?: unknown): unknown => {
    const folder = new TranscriptFolder()
    folder.apply([
      ev('turn/start', { turn: 1 }, 0),
      toolCall(1, 'c1', name, args),
      toolResult(2, 'c1', 'ok', meta),
    ])
    const keys = new TranscriptNodeKeys()
    const view = View.from({
      main: transcriptView(projectTranscriptStructure(folder.messages()), keys, {
        cwd: '/repo',
        toolPresenter: remote,
      }),
    })
    return flatten(view).find(node => node.kind === 'tool')?.props['targetKind']
  }

  assert.equal(kindsOf('read', { file_path: 'src/a.ts' }, {
    path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1,
  }), 'path', 'the tool-authored metadata states the path the head displays')
  assert.equal(kindsOf('edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), 'path',
    'the Remote branch derives the edit path from the raw arguments')
  assert.equal(kindsOf('write', { file_path: 'src/b.ts', content: 'x' }), 'path')
  assert.equal(kindsOf('read', { file_path: 'src/a.ts' }), 'text',
    'without the tool-authored metadata there is no proof, so the row stays plain')
  assert.equal(kindsOf('glob', { pattern: 'src/**/*.ts' }), 'text',
    'a search pattern is provable only from the registered call view')
})
