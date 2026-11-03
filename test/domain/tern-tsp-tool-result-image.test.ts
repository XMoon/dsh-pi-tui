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
import type { Node } from '@stencil-hq/tern'
import { textOf } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage, TranscriptToolMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import {
  DOCK_DRAFT_PREVIEW_ROLE,
  PENDING_IMAGE_BLOB_ID,
  TranscriptNodeKeys,
  dockDraftImageNodes,
  transcriptView,
  type DockDraftImageEntry,
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
    ...(states === undefined ? {} : { imageStates: states }),
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

test('a text,image,text result renders the blocks in order, without repeating the flat result', () => {
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

test('an image-only result renders the identity line and the native image', () => {
  const message = toolRow([imageBlock()])
  const states = new Map<string, ToolImageState>([['att-shot-1', { state: 'ready', blobId: 'a'.repeat(64) }]])
  const rows = rowsOf(viewOf(message, states))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result-b0-info', 'result-b0-image'])
  assert.equal(rows[1]?.text, '[IMAGE] shot.png · 640×360 · 3.8 KiB')
  assert.equal(rows[2]?.blob, 'a'.repeat(64))
})

test('an image,text,image result keeps BOTH image blocks in block order', () => {
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

test('a result WITHOUT an image block keeps its EXACT previous node shape', () => {
  const message = toolRow([textBlock('first'), textBlock('second')])
  const rows = rowsOf(viewOf(message))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result'])
  assert.equal(rows[1]?.text, 'firstsecond')
  assert.equal(rows[1]?.kind, 'code')
})

test('a result without an image block is byte-identical to the same row with NO blocks at all', () => {
  const withBlocks = toolRow([textBlock('first'), textBlock('second')])
  const withoutBlocks = toolRow([], { result: 'firstsecond' })
  const shape = (message: TranscriptToolMessage): unknown => viewOf(message).children.map(child => ({
    kind: child.kind,
    props: child.props,
  }))

  assert.deepEqual(shape(withBlocks), shape(withoutBlocks))
})

test('a text-only tool row renders the EXACT node tree it rendered before the image path existed', () => {
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

test('the same block index keeps the same node key, whatever the render state', () => {
  const message = toolRow([textBlock('before'), imageBlock()])
  const pending = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'loading' }]])))
  const ready = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'c'.repeat(64) }]])))

  assert.equal(pending.find(row => row.key === 'result-b1-image')?.blob, PENDING_IMAGE_BLOB_ID)
  assert.equal(ready.find(row => row.key === 'result-b1-image')?.blob, 'c'.repeat(64))
  assert.equal(pending.find(row => row.key === 'result-b1-image')?.key, ready.find(row => row.key === 'result-b1-image')?.key)
})

// ── T2: the tool family ─────────────────────────────────────────────────────

test('a PTC child projects its OWN image blocks, under its own identity', () => {
  const child = toolRow([textBlock('child text'), imageBlock()], {
    subCallId: 'sub-7',
    name: 'read_image',
    args: '',
  })
  const parent = toolRow([textBlock('parent result')], { name: 'parent_tool', args: '{"a":1}', subCalls: [child] })
  const view = transcriptView(projectTranscriptStructure([parent]), new TranscriptNodeKeys(), {
    imageStates: new Map([['att-shot-1', { state: 'ready', blobId: 'd'.repeat(64) }]]),
  })

  const childNode = JSON.stringify(view).includes('sub-sub-7')
  assert.equal(childNode, true, 'the child keeps its durable subCallId identity')
  const flat = JSON.stringify(view)
  assert.equal(flat.includes('child text'), true, "the child's own text block is rendered")
  assert.equal(flat.includes('parent result'), true, "the parent's own result is rendered")
  assert.equal(flat.includes('result-b1-image'), true, "the child's image block is rendered")
  assert.equal(flat.includes('result-b1-image'), true)
})

test('an unmatched tool row shows ITS OWN image inside the existing warning card', () => {
  const message = toolRow([imageBlock()], { callCount: 0, status: 'error' })
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'e'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), ['provenance', 'args', 'result-b0-info', 'result-b0-image'])
  assert.equal(rows[0]?.text, 'unmatched result')
  assert.equal(rows.find(row => row.key === 'result-b0-image')?.blob, 'e'.repeat(64))
})

test('a MERGED read group keeps the flat text result (its blocks are the first member\'s)', () => {
  const message = toolRow([imageBlock()], { name: 'read', callCount: 2, args: '2 files', result: 'first\n\nsecond' })
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'f'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result'])
  assert.equal(rows[1]?.text, 'first\n\nsecond')
  assert.equal(rows.some(row => row.kind === 'image'), false, 'a merged group never projects an image')
})

test('an ordinary single read still projects its image (the merge rule is not a blanket read rule)', () => {
  const message = toolRow([imageBlock()], { name: 'read' })
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'g'.repeat(64) }]])))

  assert.equal(rows.some(row => row.kind === 'image'), true)
})

test('an ask_user_question row keeps the settled-answer authority and its original structure', () => {
  const message = toolRow([imageBlock()], { name: 'ask_user_question', callId: 'call-1' })
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    settledQuestionAnswersLookup: (callId: string) => (callId === 'call-1'
      ? [{ id: 'q1', selected: ['yes'] }]
      : undefined),
    imageStates: new Map([['att-shot-1', { state: 'ready', blobId: 'h'.repeat(64) }]]),
  })
  const flat = JSON.stringify(view)

  assert.equal(flat.includes('answers'), true, 'the settled batch is the result body')
  assert.equal(flat.includes('q1'), true)
  assert.equal(flat.includes('result-b0-image'), false, 'the settled path never projects an image')
  assert.equal(flat.includes('[IMAGE]'), false)
})

test('a settled ask_user_question row with an EMPTY batch keeps the empty-batch meaning', () => {
  const message = toolRow([imageBlock()], { name: 'ask_user_question', callId: 'call-2' })
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    settledQuestionAnswersLookup: () => [],
  })
  const flat = JSON.stringify(view)

  assert.equal(flat.includes('answers'), true)
  assert.equal(flat.includes('result-b0-image'), false)
})

// ── T3: the reference input and the negotiated capability ──────────────────

test('the four project raster types are presentable', () => {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    const message = toolRow([imageBlock({ ...ATTACHMENT, mediaType })])
    const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'i'.repeat(64) }]])))
    assert.equal(rows.some(row => row.kind === 'image'), true, `${mediaType} must be presentable`)
  }
})

test('a malformed reference renders an invalid-attachment line and NO image node', () => {
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

test('a media type outside the project raster set renders an unsupported-format line', () => {
  const message = toolRow([imageBlock({ ...ATTACHMENT, mediaType: 'image/svg+xml' })])
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'k'.repeat(64) }]])))

  assert.equal(rows.some(row => row.kind === 'image'), false)
  assert.match(String(rows.find(row => row.key === 'result-b0-info')?.text), /Unsupported image format$/u)
})

test('without a negotiated image capability the row renders the unavailable line and NO image node', () => {
  const message = toolRow([imageBlock()])
  const rows = rowsOf(viewOf(message))

  assert.deepEqual(rows.map(row => row.key), ['args', 'result-b0-info'])
  assert.match(String(rows[1]?.text), /Native image display unavailable in this Tern pane$/u)
})

test('every state renders its OWN fixed status phrase', () => {
  const cases: readonly [ToolImageState, RegExp][] = [
    [{ state: 'unsupported' }, /Native image display unavailable in this Tern pane$/u],
    [{ state: 'disabled' }, /Image preview disabled by PI_IMAGE_PROTOCOL$/u],
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

test('a READY state renders no status suffix, and a pending state renders the placeholder id', () => {
  const ready = rowsOf(viewOf(toolRow([imageBlock()]), new Map([['att-shot-1', { state: 'ready', blobId: 'l'.repeat(64) }]])))
  assert.equal(ready.find(row => row.key === 'result-b0-info')?.text, '[IMAGE] shot.png · 640×360 · 3.8 KiB')

  for (const state of [{ state: 'loading' }, { state: 'error' }, { state: 'too-large' }] as const) {
    const rows = rowsOf(viewOf(toolRow([imageBlock()]), new Map([['att-shot-1', state]])))
    assert.equal(rows.find(row => row.key === 'result-b0-image')?.blob, PENDING_IMAGE_BLOB_ID)
  }
})

test('the identity line runs the attachment name through the untrusted display sanitizer', () => {
  const escape = String.fromCharCode(27)
  const message = toolRow([imageBlock({ ...ATTACHMENT, name: `shot${escape}[31m.png` })])
  const rows = rowsOf(viewOf(message, new Map([['att-shot-1', { state: 'error' }]])))
  const info = String(rows.find(row => row.key === 'result-b0-info')?.text)

  assert.equal(info.includes(escape), false, 'no escape character reaches the identity line')
  assert.equal(info.includes('31m'), false, 'the SGR body is dropped with its introducer')
  assert.equal(info.endsWith('\u00b7 Image read failed'), true, 'the status phrase is appended to the identity line')
})

// ── T4: the User / Assistant ordered body (PR4) ─────────────────────────────

/** The rendered view of one NON-tool row (User/Assistant body projection). */
function bodyViewOf(
  message: TranscriptMessage,
  states?: ReadonlyMap<string, ToolImageState>,
): { readonly kind: string; readonly props: Record<string, unknown>; readonly children: readonly { readonly kind: string; readonly props: Record<string, unknown> }[] } {
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    ...(states === undefined ? {} : { imageStates: states }),
  })
  const cards: { kind: string; props: Record<string, unknown>; children: readonly { readonly kind: string; readonly props: Record<string, unknown> }[] }[] = []
  const walk = (node: { kind: string; props: Record<string, unknown>; children: readonly unknown[] }): void => {
    if (node.kind === 'card') cards.push(node as never)
    for (const child of node.children) walk(child as never)
  }
  walk(view as never)
  const found = cards[0]
  assert.ok(found !== undefined, 'the row must render one card node')
  return found
}

function userRow(content: readonly ContentBlock[], text: string): TranscriptMessage {
  return { kind: 'user', turn: 1, text, content } as unknown as TranscriptMessage
}

test('a user message with text→image→text→image renders the four blocks in order under one card', () => {
  const message = userRow(
    [textBlock('before'), imageBlock({ ...ATTACHMENT, attachmentId: 'att-a', name: 'a.png' }), textBlock('after'), imageBlock({ ...ATTACHMENT, attachmentId: 'att-b', name: 'b.png' })],
    'beforeafter',
  )
  const states = new Map<string, ToolImageState>([
    ['att-a', { state: 'ready', blobId: 'a'.repeat(64) }],
    ['att-b', { state: 'ready', blobId: 'b'.repeat(64) }],
  ])
  const rows = rowsOf(bodyViewOf(message, states))

  assert.deepEqual(rows.map(row => row.key), [
    'body-b0-text',
    'body-b1-info',
    'body-b1-image',
    'body-b2-text',
    'body-b3-info',
    'body-b3-image',
  ])
  assert.equal(rows.find(row => row.key === 'body-b1-image')?.blob, 'a'.repeat(64))
  assert.equal(rows.find(row => row.key === 'body-b3-image')?.blob, 'b'.repeat(64))
  assert.equal(rows.some(row => row.key === 'body'), false,
    'the flat body must not be drawn beside the block-wise body')
})

test('a text-only user message keeps the EXACT legacy flat body and its body key', () => {
  const withContent = userRow([textBlock('plain text')], 'plain text')
  const withoutContent: TranscriptMessage = { kind: 'user', turn: 1, text: 'plain text' }
  const shape = (message: TranscriptMessage): unknown => ({
    kind: bodyViewOf(message).kind,
    props: bodyViewOf(message).props,
    children: bodyViewOf(message).children.map(child => ({ kind: child.kind, props: child.props })),
  })

  assert.deepEqual(rowsOf(bodyViewOf(withContent)).map(row => row.key), ['body'],
    'a text-only content list keeps the single flat body')
  assert.deepEqual(shape(withContent), shape(withoutContent),
    'a text-only message is byte-identical to the same message with NO content list')
})

test('a user image without a prepared state states the reason and draws no image node', () => {
  const rows = rowsOf(bodyViewOf(userRow([imageBlock()], '')))

  assert.deepEqual(rows.map(row => row.key), ['body-b0-info'])
  assert.match(String(rows[0]?.text), /Native image display unavailable in this Tern pane$/u)
})

test('the SAME attachment twice in one user body draws two sibling image nodes and one identity per block', () => {
  const message = userRow([imageBlock(), imageBlock()], '')
  const rows = rowsOf(bodyViewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'c'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), [
    'body-b0-info',
    'body-b0-image',
    'body-b1-info',
    'body-b1-image',
  ])
  assert.equal(rows.filter(row => row.kind === 'image').length, 2,
    'two occurrences of the same durable ref are two visible nodes')
  assert.equal(rows.every(row => row.blob === undefined || row.blob === 'c'.repeat(64)), true,
    'both nodes name the one blob')
})

test('a malformed and an unsupported-format user image render their reasons and no image node', () => {
  const broken = rowsOf(bodyViewOf(userRow([imageBlock({ ...ATTACHMENT, attachmentId: '' })], '')))
  assert.match(String(broken.find(row => row.key === 'body-b0-info')?.text), /Invalid image attachment$/u)
  assert.equal(broken.some(row => row.kind === 'image'), false)

  const svg = rowsOf(bodyViewOf(userRow([imageBlock({ ...ATTACHMENT, mediaType: 'image/svg+xml' })], '')))
  assert.match(String(svg.find(row => row.key === 'body-b0-info')?.text), /Unsupported image format$/u)
  assert.equal(svg.some(row => row.kind === 'image'), false)
})

test('a settled assistant body with images renders block-wise; a text-only one keeps its flat body', () => {
  const mixed: TranscriptMessage = {
    kind: 'assistant', turn: 1, text: 'diagram', content: [imageBlock(), textBlock('diagram')],
  } as unknown as TranscriptMessage
  const rows = rowsOf(bodyViewOf(mixed, new Map([['att-shot-1', { state: 'ready', blobId: 'd'.repeat(64) }]])))
  assert.deepEqual(rows.map(row => row.key), ['body-b0-info', 'body-b0-image', 'body-b1-text'])
  assert.equal(rows.find(row => row.key === 'body-b0-image')?.blob, 'd'.repeat(64))

  const textOnly: TranscriptMessage = { kind: 'assistant', turn: 1, text: 'hi', content: [textBlock('hi')] }
  assert.deepEqual(rowsOf(bodyViewOf(textOnly)).map(row => row.key), ['body'])
})

test('an assistant displayBlocks list with an image outranks the settled content and never doubles it', () => {
  const message: TranscriptMessage = {
    kind: 'assistant',
    turn: 1,
    text: 'settled text',
    content: [textBlock('settled text'), imageBlock({ ...ATTACHMENT, attachmentId: 'att-settled' })],
    displayBlocks: [
      { kind: 'content', block: textBlock('live text') },
      { kind: 'content', block: imageBlock({ ...ATTACHMENT, attachmentId: 'att-live' }) },
    ],
  } as unknown as TranscriptMessage
  const states = new Map<string, ToolImageState>([
    ['att-settled', { state: 'ready', blobId: 'e'.repeat(64) }],
    ['att-live', { state: 'ready', blobId: 'f'.repeat(64) }],
  ])
  const rows = rowsOf(bodyViewOf(message, states))

  assert.deepEqual(rows.map(row => row.key), ['body-b0-text', 'body-b1-info', 'body-b1-image'])
  assert.equal(rows.find(row => row.key === 'body-b0-text')?.text, 'live text',
    'the live display list is the body authority')
  assert.equal(rows.find(row => row.key === 'body-b1-image')?.blob, 'f'.repeat(64))
  assert.equal(rows.some(row => row.blob === 'e'.repeat(64)), false,
    'the settled content is NOT drawn beside the display list')
})

test('an assistant open-opaque image block states that it is pending and fabricates no image', () => {
  const message: TranscriptMessage = {
    kind: 'assistant',
    turn: 1,
    text: '',
    content: [imageBlock({ ...ATTACHMENT, attachmentId: 'att-open' })],
    displayBlocks: [{ kind: 'open-opaque', blockType: 'image' }],
  } as unknown as TranscriptMessage
  const rows = rowsOf(bodyViewOf(message, new Map([['att-open', { state: 'ready', blobId: 'g'.repeat(64) }]])))

  assert.deepEqual(rows.map(row => row.key), ['body-b0-block'])
  assert.match(String(rows[0]?.text), /^Open block · image · pending$/u)
  assert.equal(rows.some(row => row.kind === 'image'), false,
    'an unfinished block never becomes a drawn blob')
})

test('an unknown finalized block degrades to a payload-free type tag, never the block JSON', () => {
  const unknownBlock = { type: 'future-thing', secret: 'do-not-print' } as unknown as ContentBlock
  const message = userRow([imageBlock(), unknownBlock], '')
  const rows = rowsOf(bodyViewOf(message, new Map([['att-shot-1', { state: 'ready', blobId: 'h'.repeat(64) }]])))

  const tag = rows.find(row => row.key === 'body-b1-block')
  assert.equal(tag?.text, 'Unknown block · future-thing')
  assert.equal(JSON.stringify(rows).includes('do-not-print'), false,
    'no block payload reaches the terminal')
})

test('the User image identity line runs an untrusted attachment name through the display sanitizer', () => {
  const escape = String.fromCharCode(27)
  const message = userRow([imageBlock({ ...ATTACHMENT, name: `shot${escape}[31m.png` })], '')
  const rows = rowsOf(bodyViewOf(message, new Map([['att-shot-1', { state: 'loading' }]])))
  const info = String(rows.find(row => row.key === 'body-b0-info')?.text)

  assert.equal(info.includes(escape), false, 'no escape character reaches the body identity line')
  assert.equal(info.includes('31m'), false, 'the SGR body is dropped with its introducer')
})

// ── T5: the dock's PURE draft-preview band (responsive amendment) ──────────

/** One prepared dock entry (the chip's display facts only). */
function dockEntry(id: number, ordinal: number, state?: ToolImageState): DockDraftImageEntry {
  return {
    id,
    ordinal,
    caption: `#${id} · 640×360`,
    name: `draft-${id}.png`,
    state,
  }
}

/** The child chips of the ONE preview row. */
function chipsOf(node: Node | undefined): readonly Node[] {
  assert.ok(node !== undefined, 'a preview row must be projected')
  return node.children
}

/** One chip's image node, if it drew one. */
function chipImage(chip: Node): Node | undefined {
  return chip.children.find(child => child.kind === 'image')
}

test('the preview band is ONE row carrying two bordered chips side by side', () => {
  const row = dockDraftImageNodes([
    dockEntry(1, 0, { state: 'ready', blobId: 'a'.repeat(64) }),
    dockEntry(2, 1, { state: 'ready', blobId: 'b'.repeat(64) }),
  ], 2)

  assert.ok(row !== undefined)
  assert.equal(row.kind, 'row', 'the band is a single row, never a vertical stack')
  assert.equal(row.props.key, 'draft-preview')
  assert.equal(row.props.role, DOCK_DRAFT_PREVIEW_ROLE, 'the stylesheet role names the row')
  assert.equal(row.props.wrap, false, 'the client must not wrap two chips onto two lines')
  assert.deepEqual(chipsOf(row).map(chip => chip.props.key), ['draft-chip-1-0', 'draft-chip-2-1'],
    'each chip is keyed by the draft id and the occurrence rank')
})

test('each chip draws its bounded native image plus one compact caption, and nothing else', () => {
  const row = dockDraftImageNodes([dockEntry(1, 0, { state: 'ready', blobId: 'c'.repeat(64) })], 2)
  const [chip] = chipsOf(row)
  assert.ok(chip !== undefined)

  assert.deepEqual(chip.children.map(child => child.props.key), ['image', 'caption'],
    'exactly an image and a caption — no out-of-row identity line')
  const image = chipImage(chip)!
  assert.equal(image.props.blob, 'c'.repeat(64))
  assert.deepEqual(image.props.max, { w: '12ch', h: '4lines' },
    'the node carries the OMP-style responsive ceiling, not a fixed pixel size')
  const caption = chip.children[1]!
  assert.equal(caption.props.text, '#1 · 640×360')
  assert.equal(caption.props.wrap, 'none')
  assert.deepEqual(caption.props.max, { w: '12ch' })
})

test('the frozen preview limit is 2 / 1 / 0 across the 100 and 72 column edges', () => {
  const entries = [
    dockEntry(1, 0, { state: 'ready', blobId: 'a'.repeat(64) }),
    dockEntry(2, 1, { state: 'ready', blobId: 'b'.repeat(64) }),
    dockEntry(3, 2, { state: 'ready', blobId: 'c'.repeat(64) }),
  ]
  const chips = (limit: number): number => chipsOf(dockDraftImageNodes(entries, limit)).length

  assert.equal(chips(2), 2, 'the 100+ band shows two')
  assert.equal(chips(1), 1, 'the 72..99 band shows one')
  assert.equal(dockDraftImageNodes(entries, 0), undefined, 'below 72 nothing is projected at all')
  assert.equal(chips(2), 2, 'a third occurrence never makes the row wrap — it is simply not shown')
})

test('an empty draft projects NO row at all, keeping the pre-amendment dock', () => {
  assert.equal(dockDraftImageNodes([], 2), undefined)
  assert.equal(dockDraftImageNodes([], 0), undefined)
})

test('a chip with no drawable pixels states the reason and fabricates no blob', () => {
  for (const state of [
    { state: 'too-large' },
    { state: 'error' },
    { state: 'no-scope' },
    { state: 'unsupported' },
    { state: 'disabled' },
  ] as unknown as ToolImageState[]) {
    const row = dockDraftImageNodes([dockEntry(1, 0, state)], 2)
    const [chip] = chipsOf(row)
    assert.ok(chip !== undefined)
    assert.equal(chipImage(chip), undefined, 'no native image node without drawable bytes')
    const unavailable = chip.children.find(child => child.props.key === 'unavailable')
    assert.ok(unavailable !== undefined, 'the chip states that the preview is unavailable')
    assert.equal(unavailable.props.wrap, 'none')
    assert.equal(chip.children.some(child => child.props.key === 'caption'), true,
      'the identity caption still tells the reader which image it is')
  }
})

test('a LOADING chip shows `Preview unavailable` and draws NO image node', () => {
  const row = dockDraftImageNodes([dockEntry(1, 0, { state: 'loading' })], 2)
  const [chip] = chipsOf(row)
  assert.ok(chip !== undefined)

  assert.equal(chipImage(chip), undefined,
    'a pending read must not claim bytes it does not have')
  const unavailable = chip.children.find(child => child.props.key === 'unavailable')
  assert.equal(unavailable?.props.text, 'Preview unavailable')
  assert.equal(chip.children.some(child => child.props.key === 'caption'), true,
    'the caption still identifies which draft it is')

  // The ready transition replaces the TEXT with the image under the same chip.
  const ready = chipsOf(dockDraftImageNodes([dockEntry(1, 0, { state: 'ready', blobId: 'd'.repeat(64) })], 2))[0]!
  assert.equal(ready.props.key, chip.props.key, 'the chip keeps its key across the transition')
  assert.equal(chipImage(ready)?.props.blob, 'd'.repeat(64))
})

test('a repeated token yields two chips with distinct keys over the same bytes', () => {
  const row = dockDraftImageNodes([
    dockEntry(1, 0, { state: 'ready', blobId: 'e'.repeat(64) }),
    dockEntry(1, 1, { state: 'ready', blobId: 'e'.repeat(64) }),
  ], 2)

  assert.deepEqual(chipsOf(row).map(chip => chip.props.key), ['draft-chip-1-0', 'draft-chip-1-1'],
    'the same draft id under two ranks is two occurrences, never one attachment')
})
