/**
 * PTC image-bearing injected Context: the production TSP session/read chain.
 *
 * The chain under test is REAL:
 *
 *     official `user/message` PTC source events
 *       -> the REAL `TranscriptFolder`
 *       -> the REAL TSP renderer (`mountTspRenderer`) over the shipped SDK
 *       -> the REAL `ImageLoader` (the mount's single cache + read authority)
 *       -> the composition's controlled `readImage` seam
 *       -> the REAL `session.blob()` (the only blob sender)
 *       -> the scripted pane's wire (`b` then the `f` that references it)
 *
 * STAND-IN (never claimed as production): the pane is a scripted TTY, and the
 * READ PORT is a controlled seam. The real Direct/Remote authorization behind
 * that port is qualified separately.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-ptc-context-image.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Op, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { readTspBlobMessages } from '../support/tsp-blob-wire.ts'
import { createSurfaceDraftImageProjection } from '../../src/app/surface/runtime.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const T0 = 1_700_000_000_000

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): void {
    this.isRaw = mode
  }
  type(text: string): void {
    this.emit('data', ENCODER.encode(text))
  }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(bytes)
    return true
  }
}

function helloWith(kinds: readonly string[], features: readonly string[]): Record<string, unknown> {
  return {
    r: 'hello',
    v: 1,
    term: 'tern',
    ver: '0.9.5',
    kinds,
    features,
    apc: 65536,
    credits: 2,
    cols: 120,
    cell: { w: 8, h: 17 },
    dark: true,
    reduceMotion: false,
    hour12: false,
  }
}

const IMAGE_HELLO = helloWith(
  ['col', 'row', 'card', 'section', 'md', 'code', 'badge', 'tool', 'text', 'image'],
  ['flow', 'styles', 'blobs'],
)
const NO_IMAGE_HELLO = helloWith(
  ['col', 'row', 'card', 'section', 'md', 'code', 'badge', 'tool', 'text'],
  ['flow', 'styles', 'blobs'],
)

interface WireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly framesSeen: WireFrame[] = []
  readonly blobIdsSeen: string[] = []

  constructor(hello: Record<string, unknown>, options: { readonly failBlobWrite?: boolean } = {}) {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (options.failBlobWrite === true && text.includes('\u001b_tsp;b;')) throw new Error('the tty owner is gone')
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(hello)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const blob of readTspBlobMessages(bytes)) this.blobIdsSeen.push(blob.id)
      for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
        const frame = JSON.parse(match[1]!) as WireFrame
        this.framesSeen.push(frame)
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }
}

interface ReadCall {
  readonly scope: unknown
  readonly id: string
}

const ATTACHMENT: ImageAttachmentRefLike = {
  attachmentId: 'ptc-att-1',
  mediaType: 'image/png',
  bytes: 3_891,
  width: 640,
  height: 360,
  name: 'nested-shot.png',
}

const ATTACHMENT_2: ImageAttachmentRefLike = {
  attachmentId: 'ptc-att-2',
  mediaType: 'image/png',
  bytes: 4_102,
  width: 320,
  height: 200,
  name: 'other-shot.png',
}

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: T0 + seq, data } as SessionEvent
}

/** Official PTC Context delivery: a `user/message` whose producer source is
 * `ptc-mode` and whose content carries the nested image blocks. */
function ptcContextFolder(attachment: ImageAttachmentRefLike = ATTACHMENT): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 1 }, 0),
    event('tool/call', { turn: 1, step: 0, callId: 'ptc-root-1', name: 'run_code', arguments: '{}' }, 1),
    event('user/message', {
      id: MessageId('ptc-context-message'),
      role: 'user',
      content: [
        { type: 'text', text: 'nested result' },
        { type: 'image', attachment },
      ],
      source: { kind: 'ptc-mode' },
    }, 2),
  ])
  return folder
}

interface Harness {
  readonly renderer: TspRenderer
  readonly loader: ImageLoader
  readonly reads: ReadCall[]
  readonly tern: ScriptedTern
  readonly fatalErrors: unknown[]
  scope(scope: unknown): void
  dispose(): Promise<void>
}

async function mountHarness(options: {
  readonly hello?: Record<string, unknown>
  readonly displayState?: { preset: 'focus' | 'compact' | 'full' }
} = {}): Promise<Harness> {
  const tern = new ScriptedTern(options.hello ?? IMAGE_HELLO)
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const reads: ReadCall[] = []
  let activeScope: unknown = { scope: 'A' }
  const loader = new ImageLoader(async (ref, scope) => {
    reads.push({ scope, id: ref.attachmentId })
    // Distinct bytes per attachment so the SDK's own content dedupe cannot
    // collapse two genuinely different subjects into one blob id.
    return { ref, data: new Uint8Array([ref.attachmentId === 'ptc-att-1' ? 1 : 2, 3, 4]) }
  })
  const fatalErrors: unknown[] = []
  const renderer = mountTspRenderer(session as Session, {
    copyVisual: async () => false,
    requestExit: () => {},
    onFatal: (error: unknown) => { fatalErrors.push(error) },
    ...(options.displayState === undefined ? {} : { displayState: options.displayState }),
  })
  const draftImages = createSurfaceDraftImageProjection(
    () => ({ getDraft: () => '' } as unknown as SubmissionComposerPort),
    { values: () => [] },
  )
  renderer.bindImages({ imageLoader: loader, imageScope: () => activeScope, draftImages })
  return {
    renderer,
    loader,
    reads,
    tern,
    fatalErrors,
    scope(scope: unknown): void { activeScope = scope },
    dispose: async () => { await renderer.dispose() },
  }
}

/** Commit one transcript subject under one projection source token. */
function commit(renderer: TspRenderer, folder: TranscriptFolder, source: object): void {
  renderer.display.setTranscript(folder.messages(), folder.turnActivities(), undefined, undefined, undefined, source)
}

async function until(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function frameText(tern: ScriptedTern): string {
  const pieces: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      pieces.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(tern.framesSeen)
  return pieces.join('\n')
}

interface LiveNode {
  readonly id: string
  readonly kind: string
  readonly props: Record<string, unknown>
  readonly children: string[]
}

/** The pane's CURRENT tree (op-folded, retired nodes removed). */
function currentNodes(tern: ScriptedTern): LiveNode[] {
  const live = new Map<string, LiveNode>()
  const insert = (node: { id?: string; k?: string; p?: Record<string, unknown>; c?: readonly unknown[] }, parentId?: string): void => {
    if (typeof node.id !== 'string') return
    live.set(node.id, { id: node.id, kind: node.k ?? '', props: { ...(node.p ?? {}) }, children: [] })
    if (parentId !== undefined) live.get(parentId)?.children.push(node.id)
    for (const child of node.c ?? []) insert(child as never, node.id)
  }
  const remove = (id: string): void => {
    const node = live.get(id)
    if (node === undefined) return
    for (const child of [...node.children]) remove(child)
    live.delete(id)
  }
  for (const frame of tern.framesSeen) {
    for (const op of frame.ops) {
      if (op[0] === 'add') insert(op[4] as never, op[2] as string | undefined)
      else if (op[0] === 'set') {
        const node = live.get(op[1] as string)
        if (node !== undefined) Object.assign(node.props, op[2] as Record<string, unknown>)
      } else if (op[0] === 'text') {
        const node = live.get(op[1] as string)
        if (node === undefined) continue
        node.props.text = op[2] === 'append'
          ? `${String(node.props.text ?? '')}${String(op[3])}`
          : String(op[3])
      } else if (op[0] === 'del') remove(op[1] as string)
    }
  }
  return [...live.values()]
}

/** The image nodes of the pane's CURRENT tree. */
function currentImageNodes(tern: ScriptedTern): { id: string; blob?: string }[] {
  return currentNodes(tern)
    .filter(node => node.kind === 'image')
    .map(node => ({ id: node.id, ...(typeof node.props.blob === 'string' ? { blob: node.props.blob } : {}) }))
}

test('a PTC Context image is read once and rendered through the production session entry', async () => {
  const harness = await mountHarness({ displayState: { preset: 'full' } })
  try {
    commit(harness.renderer, ptcContextFolder(), {})
    await until('the authorized PTC Context read', () => harness.reads.length === 1)
    await until('the one PTC Context blob', () => harness.tern.blobIdsSeen.length === 1)
    const read = harness.reads[0]!
    assert.equal(read.id, 'ptc-att-1')
    assert.deepEqual(read.scope, { scope: 'A' })
    const images = currentImageNodes(harness.tern)
    assert.equal(images.length, 1, 'the Context row paints one native image node')
    assert.equal(images[0]?.blob, harness.tern.blobIdsSeen[0])
    assert.match(frameText(harness.tern), /\[IMAGE\] nested-shot\.png · 640×360/)
    assert.deepEqual(harness.fatalErrors, [])
  } finally {
    await harness.dispose()
  }
})

test('a pane without the image capability reads nothing and paints the readable fallback', async () => {
  const harness = await mountHarness({ hello: NO_IMAGE_HELLO, displayState: { preset: 'full' } })
  try {
    commit(harness.renderer, ptcContextFolder(), {})
    await until('the rendered fallback identity row', () => frameText(harness.tern).includes('[IMAGE] nested-shot.png'))
    assert.deepEqual(harness.reads, [], 'the unsupported pane performs no attachment read')
    assert.deepEqual(harness.tern.blobIdsSeen, [])
    assert.match(frameText(harness.tern), /Native image display unavailable in this Tern pane/)
    assert.deepEqual(harness.fatalErrors, [])
  } finally {
    await harness.dispose()
  }
})

test('switching the display subject retires the old PTC Context image and its subscription', async () => {
  const harness = await mountHarness({ displayState: { preset: 'full' } })
  try {
    commit(harness.renderer, ptcContextFolder(), {})
    await until('the first subject read', () => harness.reads.length === 1)
    await until('the first subject image', () => currentImageNodes(harness.tern).length === 1)

    // The new subject has a DIFFERENT attachment and a new display scope.
    harness.scope({ scope: 'B' })
    commit(harness.renderer, ptcContextFolder(ATTACHMENT_2), {})
    await until('the second subject read', () => harness.reads.length === 2)
    assert.deepEqual(harness.reads[1], { scope: { scope: 'B' }, id: 'ptc-att-2' })
    await until('the second subject image replaces the first', () => {
      const images = currentImageNodes(harness.tern)
      return images.length === 1 && images[0]?.blob === harness.tern.blobIdsSeen.at(-1)
    })
    assert.equal(harness.tern.blobIdsSeen.length, 2, 'one blob per visible subject load')

    // Retiring the subject leaves no old image and no stale occurrence.
    commit(harness.renderer, new TranscriptFolder(), {})
    await until('the retired subject tree', () => currentImageNodes(harness.tern).length === 0)
    assert.equal(harness.reads.length, 2, 'a retired subject starts no further read')
    assert.deepEqual(harness.fatalErrors, [])
  } finally {
    await harness.dispose()
  }
})

/** A compact-visible Work: Process A → claimed PTC image Context → Process B. */
function ptcWorkFolder(): TranscriptFolder {
  const contextMessage = {
    id: MessageId('ptc-work-context-message'),
    role: 'user',
    content: [
      { type: 'text', text: 'nested result' },
      { type: 'image', attachment: ATTACHMENT },
    ],
    source: { kind: 'ptc-mode' },
  }
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 1 }, 0),
    event('tool/call', { turn: 1, step: 0, callId: 'ptc-work-c1', name: 'read', arguments: '{}' }, 1),
    event('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('ptc-work-r1'), role: 'tool', toolCallId: 'ptc-work-c1',
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'ptc-work-c1' },
      },
    }, 2),
    event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [contextMessage] }, 3),
    event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    event('user/message', contextMessage, 5),
    event('tool/call', { turn: 1, step: 1, callId: 'ptc-work-c2', name: 'bash', arguments: '{}' }, 6),
    event('tool/result', {
      turn: 1, step: 1,
      message: {
        id: MessageId('ptc-work-r2'), role: 'tool', toolCallId: 'ptc-work-c2',
        content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'ptc-work-c2' },
      },
    }, 7),
    event('assistant/message', {
      turn: 1, step: 2,
      message: { id: MessageId('ptc-work-final'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 8),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 9),
  ])
  return folder
}

test('a collapsed Work never reads its carried PTC Context image; expanding the exact Work does', async () => {
  const harness = await mountHarness({ displayState: { preset: 'compact' } })
  const toggle = (id: string, collapsed: boolean): void => {
    const frame = harness.tern.framesSeen.at(-1)
    assert.ok(frame !== undefined)
    harness.tern.input.type(`\u001b_tsp;e;${JSON.stringify({ ev: 'toggle', sf: frame.sf, id, collapsed })}\u001b\\`)
  }
  try {
    harness.renderer.bindInput({
      exit() {}, cancel() {}, submit() {}, steer() {}, pasteMedia() {}, pastedPath: () => {},
      admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput() {},
      listContinuedQuestions: () => [], reopenContinuedQuestion: () => false,
      openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true, openTasksBrowserUi() {}, tasksBrowserUiAvailable: () => true,
    })
    commit(harness.renderer, ptcWorkFolder(), {})
    await until('the collapsed Work section', () => currentNodes(harness.tern).some(node => node.kind === 'section' && node.id.includes('-work-')))
    assert.equal(harness.reads.length, 0, 'a collapsed Work starts no hidden PTC Context read')
    assert.deepEqual(harness.tern.blobIdsSeen, [])

    const work = currentNodes(harness.tern).find(node => node.kind === 'section' && node.id.includes('-work-'))!
    assert.equal(work.props['collapsed'], true, 'fixture: the Work starts collapsed')
    toggle(work.id, false)
    await until('the exact Work to open', () => currentNodes(harness.tern).find(node => node.id === work.id)?.props['collapsed'] === false)
    await until('the PTC Context image read after expanding', () => harness.reads.length === 1)
    await until('the PTC Context image node after expanding', () => currentImageNodes(harness.tern).length === 1)
    assert.equal(harness.reads[0]?.id, 'ptc-att-1')
    assert.equal(harness.tern.blobIdsSeen.length, 1)
    assert.match(frameText(harness.tern), /\[IMAGE\] nested-shot\.png/)
    assert.deepEqual(harness.fatalErrors, [])
  } finally {
    await harness.dispose()
  }
})
