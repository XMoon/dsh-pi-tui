/**
 * PR-C: the pure TSP transcript projection of a TOOL RESULT that carries
 * structured image blocks.
 *
 * The chain under test is the PRODUCTION mapper
 * (`src/tui/tsp/transcript-view.ts`): the canonical structure → the ONE
 * projection function → the official `@stencil-hq/tern` nodes. No session, no
 * loader, no SDK: the mapper is a PURE function, and these tests prove the
 * shape it produces (and, just as important, the shape it does NOT change).
 *
 * STANDING-IN (never claimed as production): the tool rows are built by hand
 * (the canonical fold's own output is covered by the existing transcript
 * suites), and the per-attachment render state is the DTO the TSP session
 * layer supplies — the session layer's own read/blob/lifecycle behaviour is
 * qualified in `test/app/tern-tsp-tool-result-image.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-tool-result-image.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { textOf } from '../../src/domain/transcript/folder.ts'
import type { TranscriptToolMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import {
  PENDING_IMAGE_BLOB_ID,
  TranscriptNodeKeys,
  transcriptView,
  type ToolImageState,
} from '../../src/tui/tsp/transcript-view.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

const ATTACHMENT = {
  attachmentId: 'att-shot-1',
  mediaType: 'image/png',
  bytes: 3_891,
  width: 640,
  height: 360,
  name: 'shot.png',
} as const

function textBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock
}

function imageBlock(attachment: unknown = ATTACHMENT): ContentBlock {
  return { type: 'image', attachment } as unknown as ContentBlock
}

function toolRow(
  blocks: readonly ContentBlock[],
  overrides: Partial<TranscriptToolMessage> = {},
): TranscriptToolMessage {
  return {
    kind: 'tool',
    turn: 1,
    name: 'read_image',
    args: '{"path":"shot.png"}',
    result: textOf(blocks),
    status: 'ok',
    resultBlocks: blocks,
    ...overrides,
  }
}

/** The rendered view of one tool row (the mapper's only output shape). */
function viewOf(message: TranscriptToolMessage, states?: ReadonlyMap<string, ToolImageState>): {
  readonly kind: string
  readonly props: Record<string, unknown>
  readonly children: readonly { readonly kind: string; readonly props: Record<string, unknown> }[]
} {
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    ...(states === undefined ? {} : { toolImageStates: states }),
  })
  const tools: { kind: string; props: Record<string, unknown>; children: readonly { kind: string; props: Record<string, unknown> }[] }[] = []
  const walk = (node: { kind: string; props: Record<string, unknown>; children: readonly unknown[] }): void => {
    if (node.kind === 'tool' || node.kind === 'card') {
      tools.push(node as never)
    }
    for (const child of node.children) walk(child as never)
  }
  walk(view as never)
  const found = tools[0]
  assert.ok(found !== undefined, 'the row must render one tool or card node')
  return found
}

/** The child nodes of one rendered row, as `kind + key + text` triples. */
function rowsOf(node: { readonly children: readonly { kind: string; props: Record<string, unknown> }[] }): {
  kind: string
  key: string
  text?: string
  blob?: string
}[] {
  return node.children.map(child => ({
    kind: child.kind,
    key: String(child.props.key),
    ...(typeof child.props.text === 'string' ? { text: child.props.text } : {}),
    ...(typeof child.props.blob === 'string' ? { blob: child.props.blob } : {}),
  }))
}

// ── T1: the result block source ─────────────────────────────────────────────

test('T1-01: a text,image,text result renders the blocks in order, without repeating the flat result', () => {
  const message = toolRow([textBlock('Here is the screenshot.'), imageBlock(), textBlock('This is the area to inspect.')])
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'b'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), [
    'args',
    'result-b0-text',
    'result-b1-info',
    'result-b1-image',
    'result-b2-text',
  ])
  assert.equal(rows.find(row => row.key === 'result-b0-text')?.text, 'Here is the screenshot.')
  assert.equal(rows.find(row => row.key === 'result-b2-text')?.text, 'This is the area to inspect.')
  assert.equal(
    rows.some(row => row.key === 'result'),
    false,
    'the flat result must not be drawn again next to the block-wise result',
  )
})

test('T1-02: an image-only result renders the identity line and the native image', () => {
  const message = toolRow([imageBlock()])
  const states = new Map<string, ToolImageState>([['att-shot-1', { state: 'ready', blobId: 'a'.repeat(64) }]])
  const rows = rowsOf(viewOf(message, states))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result-b0-info', 'result-b0-image'])
  assert.equal(rows[1]?.text, '[IMAGE] shot.png · 640×360 · 3.8 KiB')
  assert.equal(rows[2]?.blob, 'a'.repeat(64))
})

test('T1-03: an image,text,image result keeps BOTH image blocks in block order', () => {
  const message = toolRow([
    imageBlock({ ...ATTACHMENT, attachmentId: 'att-a', name: 'a.png' }),
    textBlock('between'),
    imageBlock({ ...ATTACHMENT, attachmentId: 'att-b', name: 'b.png' }),
  ])
  const states = new Map<string, ToolImageState>([
    ['att-a', { state: 'ready', blobId: 'a'.repeat(64) }],
    ['att-b', { state: 'ready', blobId: 'b'.repeat(64) }],
  ])
  const rows = rowsOf(viewOf(message, states))

  assert.deepEqual(rows.map(row => row.key), [
    'args',
    'result-b0-info',
    'result-b0-image',
    'result-b1-text',
    'result-b2-info',
    'result-b2-image',
  ])
  assert.equal(rows.find(row => row.key === 'result-b2-image')?.blob, 'b'.repeat(64))
})

test('T1-04: a result WITHOUT an image block keeps its EXACT previous node shape', () => {
  const message = toolRow([textBlock('first'), textBlock('second')])
  const rows = rowsOf(viewOf(message))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result'])
  assert.equal(rows[1]?.text, 'firstsecond')
  assert.equal(rows[1]?.kind, 'code')
})

test('T1-05: a result without an image block is byte-identical to the same row with NO blocks at all', () => {
  const withBlocks = toolRow([textBlock('first'), textBlock('second')])
  const withoutBlocks = toolRow([], { result: 'firstsecond' })
  const shape = (message: TranscriptToolMessage): unknown => viewOf(message).children.map(child => ({
    kind: child.kind,
    props: child.props,
  }))

  assert.deepEqual(shape(withBlocks), shape(withoutBlocks))
})

test('T1-05b: a text-only tool row renders the EXACT node tree it rendered before PR-C', () => {
  // The golden is the row shape the TSP mapper produced BEFORE the image
  // path existed: one `args` code node and one `result` code node, in that
  // order, with no image node and no second result node.
  const message = toolRow([textBlock('alpha')], { name: 'read', args: '{"path":"a.png"}', result: 'alpha' })
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {})
  const tool = (view.children[0] as { children: readonly { children: readonly unknown[] }[] }).children[0]

  assert.deepEqual(JSON.parse(JSON.stringify(tool)), {
    k: 'tool',
    p: {
      key: 'msg-1',
      name: 'read',
      title: 'Read',
      status: 'done',
      target: 'a.png',
      targetKind: 'text',
    },
    c: [
      { k: 'code', p: { key: 'args', text: '{"path":"a.png"}' } },
      { k: 'code', p: { key: 'result', text: 'alpha' } },
    ],
  })
})

test('T1-06: the same block index keeps the same node key, whatever the render state', () => {
  const message = toolRow([textBlock('before'), imageBlock()])
  const pending = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'loading' }]])))
  const ready = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'c'.repeat(64) }]])))

  assert.equal(pending.find(row => row.key === 'result-b1-image')?.blob, PENDING_IMAGE_BLOB_ID)
  assert.equal(ready.find(row => row.key === 'result-b1-image')?.blob, 'c'.repeat(64))
  assert.equal(pending.find(row => row.key === 'result-b1-image')?.key, ready.find(row => row.key === 'result-b1-image')?.key)
})

// ── T2: the tool family ─────────────────────────────────────────────────────

test('T2-01: a PTC child projects its OWN image blocks, under its own identity', () => {
  const child = toolRow([textBlock('child text'), imageBlock()], {
    subCallId: 'sub-7',
    name: 'read_image',
    args: '',
  })
  const parent = toolRow([textBlock('parent result')], { name: 'parent_tool', args: '{"a":1}', subCalls: [child] })
  const view = transcriptView(projectTranscriptStructure([parent]), new TranscriptNodeKeys(), {
    toolImageStates: new Map([['att-shot-1', { state: 'ready', blobId: 'd'.repeat(64) }]]),
  })

  const childNode = JSON.stringify(view).includes('sub-sub-7')
  assert.equal(childNode, true, 'the child keeps its durable subCallId identity')
  const flat = JSON.stringify(view)
  assert.equal(flat.includes('child text'), true, "the child's own text block is rendered")
  assert.equal(flat.includes('parent result'), true, "the parent's own result is rendered")
  assert.equal(flat.includes('result-b1-image'), true, "the child's image block is rendered")
  assert.equal(flat.includes('result-b1-image'), true)
})

test('T2-02: an unmatched tool row shows ITS OWN image inside the existing warning card', () => {
  const message = toolRow([imageBlock()], { callCount: 0, status: 'error' })
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'e'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), ['provenance', 'args', 'result-b0-info', 'result-b0-image'])
  assert.equal(rows[0]?.text, 'unmatched result')
  assert.equal(rows.find(row => row.key === 'result-b0-image')?.blob, 'e'.repeat(64))
})

test('T2-03: a MERGED read group keeps the flat text result (its blocks are the first member\'s)', () => {
  const message = toolRow([imageBlock()], { name: 'read', callCount: 2, args: '2 files', result: 'first\n\nsecond' })
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'f'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result'])
  assert.equal(rows[1]?.text, 'first\n\nsecond')
  assert.equal(rows.some(row => row.kind === 'image'), false, 'a merged group never projects an image')
})

test('T2-04: an ordinary single read still projects its image (the merge rule is not a blanket read rule)', () => {
  const message = toolRow([imageBlock()], { name: 'read' })
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'g'.repeat(64) }]])))

  assert.equal(rows.some(row => row.kind === 'image'), true)
})

test('T2-05: an ask_user_question row keeps the settled-answer authority and its original structure', () => {
  const message = toolRow([imageBlock()], { name: 'ask_user_question', callId: 'call-1' })
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    settledQuestionAnswersLookup: (callId: string) => (callId === 'call-1'
      ? [{ id: 'q1', selected: ['yes'] }]
      : undefined),
    toolImageStates: new Map([['att-shot-1', { state: 'ready', blobId: 'h'.repeat(64) }]]),
  })
  const flat = JSON.stringify(view)

  assert.equal(flat.includes('answers'), true, 'the settled batch is the result body')
  assert.equal(flat.includes('q1'), true)
  assert.equal(flat.includes('result-b0-image'), false, 'the settled path never projects an image')
  assert.equal(flat.includes('[IMAGE]'), false)
})

test('T2-06: a settled ask_user_question row with an EMPTY batch keeps the empty-batch meaning', () => {
  const message = toolRow([imageBlock()], { name: 'ask_user_question', callId: 'call-2' })
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    settledQuestionAnswersLookup: () => [],
  })
  const flat = JSON.stringify(view)

  assert.equal(flat.includes('answers'), true)
  assert.equal(flat.includes('result-b0-image'), false)
})

// ── T3: the reference input and the negotiated capability ──────────────────

test('T3-01: the four project raster types are presentable', () => {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    const message = toolRow([imageBlock({ ...ATTACHMENT, mediaType })])
    const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'i'.repeat(64) }]])))
    assert.equal(rows.some(row => row.kind === 'image'), true, `${mediaType} must be presentable`)
  }
})

test('T3-02: a malformed reference renders an invalid-attachment line and NO image node', () => {
  const broken = [
    { ...ATTACHMENT, attachmentId: '' },
    { ...ATTACHMENT, width: 0 },
    { ...ATTACHMENT, height: -1 },
    { ...ATTACHMENT, width: Number.NaN },
    { ...ATTACHMENT, width: 12.5 },
    { ...ATTACHMENT, bytes: -1 },
    { ...ATTACHMENT, bytes: 1.5 },
  ]
  for (const attachment of broken) {
    const message = toolRow([imageBlock(attachment)])
    const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'j'.repeat(64) }]])))
    assert.equal(rows.some(row => row.kind === 'image'), false, 'a malformed reference never renders an image node')
    assert.match(String(rows.find(row => row.key === 'result-b0-info')?.text), /Invalid image attachment$/u)
  }
})

test('T3-03: a media type outside the project raster set renders an unsupported-format line', () => {
  const message = toolRow([imageBlock({ ...ATTACHMENT, mediaType: 'image/svg+xml' })])
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'k'.repeat(64) }]])))

  assert.equal(rows.some(row => row.kind === 'image'), false)
  assert.match(String(rows.find(row => row.key === 'result-b0-info')?.text), /Unsupported image format$/u)
})

test('T3-04: without a negotiated image capability the row renders the unavailable line and NO image node', () => {
  const message = toolRow([imageBlock()])
  const rows = rowsOf(viewOf(message))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result-b0-info'])
  assert.match(String(rows[1]?.text), /Native image display unavailable in this Tern pane$/u)
})

test('T3-05: every state renders its OWN fixed status phrase', () => {
  const cases: readonly [ToolImageState, RegExp][] = [
    [{ state: 'unsupported' }, /Native image display unavailable in this Tern pane$/u],
    [{ state: 'no-scope' }, /Image unavailable for this session$/u],
    [{ state: 'loading' }, /Loading image…$/u],
    [{ state: 'error' }, /Image read failed$/u],
    [{ state: 'too-large' }, /Image exceeds 16 MiB Blob limit$/u],
  ]
  for (const [state, pattern] of cases) {
    const message = toolRow([imageBlock()])
    const rows = rowsOf(viewOf(message, new Map([['att-shot-1', state]])))
    assert.match(String(rows.find(row => row.key === 'result-b0-info')?.text), pattern)
  }
})

test('T3-06: a READY state renders no status suffix, and a pending state renders the placeholder id', () => {
  const ready = rowsOf(viewOf(toolRow([imageBlock()]), new Map([['att-shot-1', { state: 'ready', blobId: 'l'.repeat(64) }]])))
  assert.equal(ready.find(row => row.key === 'result-b0-info')?.text, '[IMAGE] shot.png · 640×360 · 3.8 KiB')

  for (const state of [{ state: 'loading' }, { state: 'error' }, { state: 'too-large' }] as const) {
    const rows = rowsOf(viewOf(toolRow([imageBlock()]), new Map([['att-shot-1', state]])))
    assert.equal(rows.find(row => row.key === 'result-b0-image')?.blob, PENDING_IMAGE_BLOB_ID)
  }
})

test('T3-07: the identity line runs the attachment name through the untrusted display sanitizer', () => {
  const escape = String.fromCharCode(27)
  const message = toolRow([imageBlock({ ...ATTACHMENT, name: `shot${escape}[31m.png` })])
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'error' }]])))
  const info = String(rows.find(row => row.key === 'result-b0-info')?.text)

  assert.equal(info.includes(escape), false, 'no escape character reaches the identity line')
  assert.equal(info.includes('31m'), false, 'the SGR body is dropped with its introducer')
  assert.equal(info.endsWith('\u00b7 Image read failed'), true, 'the status phrase is appended to the identity line')
})
