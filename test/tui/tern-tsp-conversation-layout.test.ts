/**
 * Native TSP transcript leaf, Copy-source and settled final metadata contracts.
 *
 * Evidence level: production Folder/projection + official SDK View ids. This
 * does not qualify a real Tern client's painted layout or keyboard behavior.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { View, type Tree } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { setAssistantVisualPresentation } from '../../src/domain/visual/presentation.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import { TranscriptNodeKeys, transcriptViewForPreset } from '../../src/tui/tsp/transcript-view.ts'
import { TRANSCRIPT_COPY_ACTION, transcriptCopyPayload } from '../../src/tui/tsp/transcript-copy.ts'

const T0 = 1_700_000_000_000

function event(type: string, data: Record<string, unknown>, seq: number, time = T0 + seq * 1000): SessionEvent {
  return { type, seq: SessionSeq(seq), time, data } as SessionEvent
}

function userEvent(seq: number, time = T0 + seq * 1000): SessionEvent {
  return event('user/message', {
    id: MessageId(`user-${seq}`),
    role: 'user',
    content: [{ type: 'text', text: 'question' }],
    source: { kind: 'user' },
  }, seq, time)
}

function settledFolder(options: { readonly usage?: boolean; readonly durationMs?: number } = {}): TranscriptFolder {
  const start = T0
  const duration = options.durationMs ?? 2_000
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 1 }, 0, start),
    userEvent(1, start + 50),
    event('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('answer'),
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
        stream: [],
      },
      ...(options.usage === false ? {} : { usage: { inputTokens: 3, outputTokens: 4 } }),
    }, 2, start + 100),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, start + duration),
  ])
  return folder
}

function treeFor(folder: TranscriptFolder, preset: 'full' | 'compact' | 'focus', copy = true): Tree[] {
  return View.from({ main: transcriptViewForPreset(folder.messages(), new TranscriptNodeKeys(), {
    preset,
    scopePrefix: 's1-',
    turnActivities: folder.turnActivities(),
    window: { mode: 'latest', hasNewer: false },
    ...(copy ? { transcriptCopy: { action: TRANSCRIPT_COPY_ACTION } } : {}),
  }) }).regions.filter((region): region is Tree => region !== undefined)
}

function flatten(root: Tree): Tree[] {
  const out: Tree[] = []
  const visit = (node: Tree): void => {
    out.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return out
}

function textOf(nodes: readonly Tree[]): string {
  return nodes.flatMap(node => {
    const value = node.props['text']
    return typeof value === 'string' ? [value] : []
  }).join('\n')
}

test('raw text Copy preserves Unicode, whitespace and ordered text blocks without image placeholders', () => {
  const user: TranscriptMessage = {
    kind: 'user', turn: 1, text: 'flat fallback',
    content: [
      { type: 'text', text: ' 你好\n' } as ContentBlock,
      { type: 'image', attachment: { attachmentId: 'secret' } } as unknown as ContentBlock,
      { type: 'text', text: '🧪  ' } as ContentBlock,
    ],
  }
  assert.equal(transcriptCopyPayload(user), ' 你好\n🧪  ')
  assert.equal(transcriptCopyPayload({ kind: 'user', turn: 1, text: ' ' }), ' ')
  assert.equal(transcriptCopyPayload({
    kind: 'user', turn: 1, text: 'image placeholder', content: [{ type: 'image' } as unknown as ContentBlock],
  }), undefined)
  assert.equal(transcriptCopyPayload({ kind: 'thinking', text: 'not a message' } as TranscriptMessage), undefined)
})

test('an open opaque Assistant has no Copy source and settled text keeps its original bytes', () => {
  const open: TranscriptMessage = {
    kind: 'assistant', turn: 1, text: 'stale settled text',
    content: [{ type: 'text', text: 'stale settled text' } as ContentBlock],
    displayBlocks: [{ kind: 'open-opaque', blockType: 'future-block' }],
  }
  assert.equal(transcriptCopyPayload(open), undefined)
  assert.equal(transcriptCopyPayload({
    kind: 'assistant', turn: 1, text: 'fallback',
    content: [{ type: 'text', text: '\n```ts\nconst x = 1\n```  ' } as ContentBlock],
  }), '\n```ts\nconst x = 1\n```  ')
})

test('a published visual Copy projection omits consumed display-only definitions', () => {
  const ref = `sv2_${'1'.repeat(20)}`
  const marker = `[dsh-visual-${ref}]: <#>`
  const message: Extract<TranscriptMessage, { kind: 'assistant' }> = {
    kind: 'assistant', turn: 1, text: `Before\n\n${marker}\n\nAfter`,
    content: [{ type: 'text', text: `Before\n\n${marker}\n\nAfter` } as ContentBlock],
  }
  const source = {
    ref, type: 'chart' as const, title: 'Chart', turn: 1, step: 0,
    stepStartSeq: 1, callSeq: 2, resultSeq: 3, callId: 'chart-call',
    chart: { version: 1 as const, type: 'chart' as const, kind: 'bars' as const, title: 'Chart', unit: 'n', series: [{ label: 'x', value: 1 }] },
    svg: undefined, svgSource: undefined, svgAdmissionWidth: undefined,
  }
  const publication: PublishedVisual = {
    ref, turn: 1, step: 0, stepStartSeq: 1, callSeq: 2, resultSeq: 3, callId: 'publish-call', source,
  }
  setAssistantVisualPresentation(message, {
    subjectKind: 'main', subjectId: 'session', sourceIdentity: {}, session: {}, sessionId: 'session',
    seq: 4, turn: 1, step: 1, text: message.text, content: message.content, assistantRevision: 0,
  }, [publication])
  const payload = transcriptCopyPayload(message)
  assert.equal(payload?.includes(marker), false)
  assert.equal(payload, 'Before\n\n\n\nAfter')
})

test('Full, Compact and Focus share native User and plain Assistant leaves with one Copy action', () => {
  const folder = settledFolder()
  for (const preset of ['full', 'compact', 'focus'] as const) {
    const regions = treeFor(folder, preset)
    const nodes = regions.flatMap(flatten)
    const root = regions[0]!
    assert.equal(root.kind, 'col')
    assert.equal(root.props['gap'], 'none')
    const user = nodes.find(node => node.kind === 'message' && node.props['role'] === 'dsh.transcript.user')
    assert.ok(user, `${preset} has a native User message`)
    assert.equal(user.props['side'], 'end')
    assert.equal(user.props['variant'], 'auto')
    assert.equal(user.props['author'], undefined)
    assert.deepEqual(user.props['actions'], [{ act: TRANSCRIPT_COPY_ACTION, icon: 'copy', title: 'Copy user message' }])
    assert.equal(user.props['time'], '22:13 UTC')
    const assistant = nodes.find(node => node.kind === 'col' && node.props['role'] === 'dsh.transcript.assistant')
    assert.ok(assistant, `${preset} has a plain Assistant message`)
    assert.equal(assistant.children.some(child => child.kind === 'card'), false)
    const footer = assistant.children.at(-1)
    assert.equal(footer?.kind, 'row')
    const button = footer?.children.find(child => child.kind === 'button')
    assert.equal(button?.props['text'], 'Copy')
    assert.equal((button?.props['actions'] as { readonly click?: string } | undefined)?.click, TRANSCRIPT_COPY_ACTION)
    assert.equal(nodes.some(node => node.props['act'] === 'copy'), false)
    assert.equal(textOf(nodes).includes('You'), false)
    assert.equal(textOf(nodes).includes('Assistant'), false)
    assert.equal(textOf(nodes).includes('❯'), false)
  }
})

test('only the official settled final Assistant receives sourced stats and Focus does not duplicate them', () => {
  const folder = settledFolder({ durationMs: 500 })
  const full = flatten(treeFor(folder, 'full')[0]!)
  const final = full.find(node => node.kind === 'col' && node.props['role'] === 'dsh.transcript.assistant')
  assert.ok(final)
  assert.ok(textOf(flatten(final)).includes('Took <1s'))
  assert.ok(textOf(flatten(final)).includes('7 tok'))

  const noUsage = flatten(treeFor(settledFolder({ usage: false }), 'compact')[0]!)
  const noUsageFinal = noUsage.find(node => node.kind === 'col' && node.props['role'] === 'dsh.transcript.assistant')
  assert.ok(noUsageFinal)
  assert.ok(textOf(flatten(noUsageFinal)).includes('Took 2s'))
  assert.equal(textOf(flatten(noUsageFinal)).includes('tok'), false)

  const focus = flatten(treeFor(folder, 'focus')[0]!)
  const focusFinal = focus.find(node => node.kind === 'col' && node.props['role'] === 'dsh.transcript.assistant')
  assert.ok(focusFinal)
  assert.equal(textOf(flatten(focusFinal)).includes('Took'), false)
  assert.equal(textOf(flatten(focusFinal)).includes('tok'), false)
})
