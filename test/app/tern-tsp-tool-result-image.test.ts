/**
 * PR-C: the TSP renderer's TOOL RESULT image lifecycle — the authorized read,
 * the blob, and the source/hydration/dispose fences.
 *
 * The chain under test is the PRODUCTION one:
 *
 *     a real tool result with an image block
 *       -> the REAL TSP renderer (`mountTspRenderer`) over the shipped SDK
 *       -> the REAL `ImageLoader` (the mount's single cache + read authority)
 *       -> the authorized read port (the composition's `readImage` seam)
 *       -> the REAL `session.blob()` (the only blob sender)
 *       -> the scripted pane's wire (`b` then the `f` that references it)
 *
 * STANDS-IN (never claimed as production): the pane is a scripted tty (not a
 * real Tern client) and the READ PORT is a controlled seam. The REAL
 * Direct/Remote authorization behind that port is qualified separately, with
 * the real attachment service and the real retained binding.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-tool-result-image-session.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect, concatBytes } from '@stencil-hq/tern'
import type { Op, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const T0 = 1_700_000_000_000

// ── The scripted Tern pane ──────────────────────────────────────────────────

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

const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.9.5',
  kinds: ['col', 'row', 'card', 'section', 'md', 'code', 'badge', 'tool', 'text', 'image'],
  features: ['flow', 'styles', 'blobs'],
  apc: 65536,
  credits: 2,
  cols: 120,
  cell: { w: 8, h: 17 },
  dark: true,
  reduceMotion: false,
  hour12: false,
}

interface WireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

/** One wire event, in the order the SDK wrote it. */
type WireEvent =
  | { readonly kind: 'blob'; readonly id: string }
  | { readonly kind: 'frame'; readonly frame: WireFrame }

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly events: WireEvent[] = []

  constructor(hello: typeof HELLO = HELLO) {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(hello)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const match of text.matchAll(/\u001b_tsp;b;id=([0-9a-f]*);/g)) {
        this.events.push({ kind: 'blob', id: match[1]! })
      }
      for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
        const frame = JSON.parse(match[1]!) as WireFrame
        this.events.push({ kind: 'frame', frame })
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }

  /** The blob ids the SDK actually sent, in order. */
  blobIds(): string[] {
    return this.events.filter((event): event is { kind: 'blob'; id: string } => event.kind === 'blob')
      .map(event => event.id)
  }

  /** The frames the SDK actually sent, in order. */
  frames(): WireFrame[] {
    return this.events.filter((event): event is { kind: 'frame'; frame: WireFrame } => event.kind === 'frame')
      .map(event => event.frame)
  }
}

// ── The harness ─────────────────────────────────────────────────────────────

interface ReadCall {
  readonly scope: unknown
  readonly id: string
}

interface Harness {
  readonly renderer: TspRenderer
  readonly loader: ImageLoader
  readonly reads: ReadCall[]
  readonly tern: ScriptedTern
  /** Set the scope the renderer's binding hands out (per display subject). */
  scope(scope: unknown): void
  /** The scope the renderer's binding currently hands out. */
  scopeValue(): unknown
  dispose(): Promise<void>
}

/** The one attachment every case reads. */
const ATTACHMENT: ImageAttachmentRefLike = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 3_891,
  width: 640,
  height: 360,
  name: 'shot.png',
}

/** A real tool row whose result carries one image block. */
function toolRowWithImage(attachment: unknown = ATTACHMENT): TranscriptMessage {
  return {
    kind: 'tool',
    turn: 1,
    name: 'read_image',
    args: '{"path":"shot.png"}',
    result: 'Here is the screenshot.',
    status: 'ok',
    resultBlocks: [
      { type: 'text', text: 'Here is the screenshot.' },
      { type: 'image', attachment },
    ],
  } as unknown as TranscriptMessage
}

async function mountHarness(options: {
  readonly read?: (ref: ImageAttachmentRefLike, scope: unknown) => Promise<{ ref: unknown; data: Uint8Array }>
  readonly hello?: typeof HELLO
} = {}): Promise<Harness> {
  const tern = new ScriptedTern(options.hello ?? HELLO)
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const reads: ReadCall[] = []
  let activeScope: unknown = { scope: 'A' }
  const loader = new ImageLoader(async (ref, scope) => {
    reads.push({ scope, id: ref.attachmentId })
    if (options.read === undefined) return { ref, data: new Uint8Array([1, 2, 3, 4]) }
    return await options.read(ref, scope)
  })
  const renderer = mountTspRenderer(session, { requestExit: () => {} })
  renderer.bindImages({ imageLoader: loader, imageScope: () => activeScope })
  return {
    renderer,
    loader,
    reads,
    tern,
    scope(scope: unknown): void {
      activeScope = scope
    },
    scopeValue(): unknown {
      return activeScope
    },
    dispose: async () => {
      await renderer.dispose()
    },
  }
}

/** Commit one transcript subject under one projection source token. */
function commit(
  renderer: TspRenderer,
  messages: readonly TranscriptMessage[],
  source: object,
): void {
  renderer.display.setTranscript(messages, undefined, undefined, undefined, undefined, source)
}

/**
 * Wait for an AUTHORITATIVE condition, bounded by a deadline.
 *
 * The condition is always a fact about the wire or the loader - the blob the
 * SDK sent, the frame the pane received, the loader's own state - never
 * "give the system time". A blind sleep would let a case pass for the wrong
 * reason.
 */
async function until(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The image nodes the SDK actually drew, across all frames (the whole tree). */
function drawnImageNodes(tern: ScriptedTern): { id: string; blob?: string }[] {
  const drawn: { id: string; blob?: string }[] = []
  const walk = (node: { readonly id: string; readonly k: string; readonly p?: Record<string, unknown>; readonly c?: readonly unknown[] }): void => {
    if (node.k === 'image') {
      const blob = node.p?.blob
      drawn.push({ id: node.id, ...(typeof blob === 'string' ? { blob } : {}) })
    }
    for (const child of node.c ?? []) walk(child as never)
  }
  for (const frame of tern.frames()) {
    for (const op of frame.ops) {
      if (op[0] !== 'add') continue
      walk(op[4] as never)
    }
  }
  return drawn
}

/** One live node of the pane's CURRENT tree. */
interface LiveNode {
  readonly id: string
  readonly kind: string
  readonly props: Record<string, unknown>
  readonly children: LiveNode[]
}

/**
 * The pane's CURRENT tree, rebuilt by applying the SDK's ops in order
 * (`add` inserts the carried subtree, `set`/`text` update a node, `del`
 * removes a node and its subtree).
 *
 * The historical scan above only proves that a node was DRAWN at some point;
 * this one proves what the pane SHOWS NOW — the difference between "the new
 * subject's image was drawn once" and "the new subject's image is on screen
 * and the retired one is gone".
 */
function currentNodes(tern: ScriptedTern): LiveNode[] {
  const live = new Map<string, LiveNode>()
  const insert = (node: { id?: string; k?: string; p?: Record<string, unknown>; c?: readonly unknown[] }, parentId: string | undefined): void => {
    if (typeof node.id !== 'string') return
    const entry: LiveNode = { id: node.id, kind: node.k ?? '', props: { ...(node.p ?? {}) }, children: [] }
    live.set(node.id, entry)
    if (parentId !== undefined) live.get(parentId)?.children.push(entry)
    for (const child of node.c ?? []) insert(child as never, node.id)
  }
  const remove = (id: string): void => {
    const node = live.get(id)
    if (node === undefined) return
    for (const child of [...node.children]) remove(child.id)
    live.delete(id)
  }
  for (const frame of tern.frames()) {
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
  const images: { id: string; blob?: string }[] = []
  for (const node of currentNodes(tern)) {
    if (node.kind !== 'image') continue
    const blob = node.props.blob
    images.push({ id: node.id, ...(typeof blob === 'string' ? { blob } : {}) })
  }
  return images
}

// ── T4: the loader scope ────────────────────────────────────────────────────

test('T4-01: two display subjects with the SAME attachment id read their OWN bytes', async () => {
  const byScope = new Map<unknown, Uint8Array>()
  const harness = await mountHarness({
    read: async (ref, scope) => {
      const data = byScope.get(scope) ?? new Uint8Array([9])
      return { ref, data }
    },
  })
  const sourceA = {}
  const sourceB = {}
  const scopeA = { scope: 'A' }
  const scopeB = { scope: 'B' }
  byScope.set(scopeA, new Uint8Array([1, 1, 1]))
  byScope.set(scopeB, new Uint8Array([2, 2, 2]))

  harness.scope(scopeA)
  commit(harness.renderer, [toolRowWithImage()], sourceA)
  await until('the first subject to send its blob', () => harness.tern.blobIds().length === 1)
  harness.scope(scopeB)
  commit(harness.renderer, [toolRowWithImage()], sourceB)
  await until('the second subject to send its own blob', () => harness.tern.blobIds().length === 2)

  const ids = harness.tern.blobIds()
  assert.equal(ids.length, 2, 'each subject sent its own blob')
  assert.notEqual(ids[0], ids[1], 'the same attachment id under two scopes carries two different byte sets')
  assert.deepEqual(harness.reads.map(read => read.id), ['att-1', 'att-1'])
  assert.notEqual(harness.reads[0]?.scope, harness.reads[1]?.scope, 'each read carries its own scope')
  await harness.dispose()
})

test('T4-02: a failed read of one subject never touches the other subject\'s state', async () => {
  const harness = await mountHarness({
    read: async (ref, scope) => {
      if ((scope as { scope: string }).scope === 'A') throw new Error('the Host denied the attachment')
      return { ref, data: new Uint8Array([7, 7]) }
    },
  })
  const scopeA = { scope: 'A' }
  const scopeB = { scope: 'B' }

  harness.scope(scopeA)
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the denied read to settle', () => harness.loader.get(ATTACHMENT, scopeA).state === 'error')
  assert.equal(harness.loader.get(ATTACHMENT, scopeA).state, 'error')
  assert.equal(harness.loader.get(ATTACHMENT, scopeB).state, 'idle', "the other subject's scope is untouched")

  harness.scope(scopeB)
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the other subject to read its own bytes', () => harness.loader.get(ATTACHMENT, scopeB).state === 'ready')
  assert.equal(harness.loader.get(ATTACHMENT, scopeB).state, 'ready')
  assert.equal(harness.loader.get(ATTACHMENT, scopeA).state, 'error', "the failed subject keeps its own failure")
  await harness.dispose()
})

test('T4-03: a late settle of a RETIRED subject never sends a blob for the new subject', async () => {
  let releaseA!: () => void
  const gate = new Promise<void>(resolve => { releaseA = resolve })
  const harness = await mountHarness({
    read: async (ref, scope) => {
      if ((scope as { scope: string }).scope === 'A') {
        await gate
        return { ref, data: new Uint8Array([1, 1, 1]) }
      }
      return { ref, data: new Uint8Array([2, 2, 2]) }
    },
  })
  const scopeA = { scope: 'A' }
  const scopeB = { scope: 'B' }

  harness.scope(scopeA)
  commit(harness.renderer, [toolRowWithImage()], {})
  await until("the first subject's read to start", () => harness.reads.length === 1)
  assert.equal(harness.reads.length, 1, "the first subject's read is in flight")

  // The subject is replaced while the read is still open.
  harness.scope(scopeB)
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the new subject to send its blob', () => harness.tern.blobIds().length === 1)
  releaseA()
  await until("the retired subject's read to settle", () => harness.loader.get(ATTACHMENT, scopeA).state === 'ready')

  const ids = harness.tern.blobIds()
  assert.equal(ids.length, 1, 'only the CURRENT subject sent a blob')
  assert.equal(harness.loader.get(ATTACHMENT, scopeA).state, 'ready', "the retired subject's own read still settled")
  assert.equal(harness.loader.get(ATTACHMENT, scopeB).state, 'ready')
  await harness.dispose()
})

// ── T7: the blob and the wire ───────────────────────────────────────────────

test('T7-01: the blob is sent BEFORE the frame that references it', async () => {
  const harness = await mountHarness()
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the pane to receive the image blob', () => harness.tern.blobIds().length === 1)

  const blobIndex = harness.tern.events.findIndex(event => event.kind === 'blob')
  const drawn = drawnImageNodes(harness.tern)
  assert.equal(drawn.length > 0, true, 'the pane drew the image node')
  const frameIndex = harness.tern.events.findIndex(event => event.kind === 'frame'
    && JSON.stringify(event.frame).includes(drawn[0]!.id))
  assert.equal(blobIndex >= 0, true, 'the blob was sent')
  assert.equal(frameIndex > blobIndex, true, 'the blob precedes the frame that references it')
  assert.equal(drawn[0]?.blob, harness.tern.blobIds()[0], 'the image node carries the real blob id')
  await harness.dispose()
})

test('T7-02: a repeated repaint of the SAME subject never re-sends the blob', async () => {
  const harness = await mountHarness()
  const source = {}
  commit(harness.renderer, [toolRowWithImage()], source)
  await until('the first blob to be sent', () => harness.tern.blobIds().length === 1)
  const afterFirst = harness.tern.blobIds().length
  const framesBefore = harness.tern.frames().length
  commit(harness.renderer, [toolRowWithImage()], source)
  commit(harness.renderer, [toolRowWithImage()], source)
  await until('the repeated repaints to reach the pane', () => harness.tern.frames().length > framesBefore)

  assert.equal(afterFirst, 1)
  assert.equal(harness.tern.blobIds().length, 1, 'the SDK dedupes the blob content')
  assert.equal(harness.reads.length, 1, 'the image is read once')
  await harness.dispose()
})

test('T7-03: bytes over the 16 MiB blob gate are never sent', async () => {
  const harness = await mountHarness({
    read: async (ref) => ({ ref, data: new Uint8Array(16 * 1024 * 1024 + 1) }),
  })
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the over-limit bytes to be ready', () => harness.loader.get(ATTACHMENT, harness.scopeValue()).state === 'ready')

  assert.deepEqual(harness.tern.blobIds(), [], 'the over-limit bytes never reach the wire')
  const frame = harness.tern.frames().at(-1)
  assert.equal(JSON.stringify(frame).includes('Image exceeds 16 MiB Blob limit'), true,
    'the row states the over-limit reason')
  await harness.dispose()
})

test('T7-04: a settle after the disposal sends neither a blob nor a frame', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const harness = await mountHarness({
    read: async (ref) => {
      await gate
      return { ref, data: new Uint8Array([3, 3]) }
    },
  })
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the gated read to start', () => harness.reads.length === 1)
  const blobsBefore = harness.tern.blobIds().length
  const framesBefore = harness.tern.frames().length

  await harness.dispose()
  release()
  await until('the late read to settle inside the loader', () => harness.loader.get(ATTACHMENT, harness.scopeValue()).state === 'ready')

  assert.equal(harness.tern.blobIds().length, blobsBefore, 'no blob is sent after the disposal')
  assert.equal(harness.tern.frames().length, framesBefore, 'no frame is sent after the disposal')
  assert.equal(harness.loader.listenerCount(), 0, 'every presentation subscription is released')
})

// ── T8: the source and the rehydration ──────────────────────────────────────

test('T8-01: a ready repaint of the SAME subject keeps the image node\'s identity', async () => {
  const harness = await mountHarness()
  const source = {}
  // The SAME carrier object: a repaint of one subject re-projects the very
  // same transcript rows, so the presentation identity must not move.
  const messages = [toolRowWithImage()]
  commit(harness.renderer, messages, source)
  await until('the image node to be drawn', () => drawnImageNodes(harness.tern).length > 0)
  const first = drawnImageNodes(harness.tern).at(-1)

  // A repaint that really CHANGES something: the SDK diffs the view, so a
  // frame follows. An unchanged repaint would send nothing at all, and the
  // identity assertion would be vacuous.
  const framesBefore = harness.tern.frames().length
  ;(messages[0] as { args: string }).args = '{"path":"other.png"}'
  commit(harness.renderer, messages, source)
  await until('the changed repaint to reach the pane', () => harness.tern.frames().length > framesBefore)
  const second = drawnImageNodes(harness.tern).at(-1)

  assert.equal(first?.id, second?.id, 'the image node keeps its id across a repaint')
  await harness.dispose()
})

test('T8-02: a NEW subject draws its own image and never the retired one', async () => {
  const byScope = new Map<string, Uint8Array>()
  const harness = await mountHarness({
    read: async (ref, scope) => {
      const key = (scope as { scope: string }).scope
      const data = byScope.get(key) ?? new Uint8Array([0])
      return { ref, data }
    },
  })
  byScope.set('A', new Uint8Array([1, 1, 1]))
  byScope.set('B', new Uint8Array([2, 2, 2]))

  harness.scope({ scope: 'A' })
  commit(harness.renderer, [toolRowWithImage()], {})
  await until("the first subject's blob", () => harness.tern.blobIds().length === 1)
  const aBlob = harness.tern.blobIds().at(-1)

  harness.scope({ scope: 'B' })
  commit(harness.renderer, [toolRowWithImage()], {})
  await until("the second subject's blob", () => harness.tern.blobIds().length === 2)
  const bBlob = harness.tern.blobIds().at(-1)

  assert.notEqual(aBlob, bBlob, 'the new subject carries its own bytes')
  // The CURRENT tree, not the historical one: the new subject's image is on
  // screen and the retired subject's image is GONE from it. A renderer that
  // kept the old node (or never drew the new one) fails here.
  const current = currentImageNodes(harness.tern)
  assert.equal(current.length, 1, 'the pane shows exactly one image node')
  assert.equal(current[0]?.blob, bBlob, "the CURRENT image node carries the NEW subject's blob")
  assert.equal(current.some(node => node.blob === aBlob), false,
    "the retired subject's image is not in the current tree")
  await harness.dispose()
})

test('T8-03: the hydration window drops the outgoing subject\'s image subscriptions', async () => {
  const harness = await mountHarness()
  const source = {}
  commit(harness.renderer, [toolRowWithImage()], source)
  await until('the visible image to be subscribed', () => harness.loader.listenerCount() === 1)
  assert.equal(harness.loader.listenerCount(), 1, 'the visible image is subscribed')

  harness.renderer.display.beginSessionHydration()
  assert.equal(harness.loader.listenerCount(), 0, 'the hydration releases the outgoing subscription')
  await harness.dispose()
})

test('T8-04: a subject with NO scope never reads and never sends a blob', async () => {
  const harness = await mountHarness()
  harness.scope(undefined)
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the row to state the unavailable reason', () =>
    JSON.stringify(harness.tern.frames().at(-1)).includes('Image unavailable for this session'))

  assert.deepEqual(harness.reads, [], 'an absent scope reads nothing')
  assert.deepEqual(harness.tern.blobIds(), [], 'an absent scope sends no blob')
  const frame = harness.tern.frames().at(-1)
  assert.equal(JSON.stringify(frame).includes('Image unavailable for this session'), true,
    'the row states that the image is unavailable for this session')
  await harness.dispose()
})

test('T8-05: a pane WITHOUT the image capability never reads and never sends a blob', async () => {
  const harness = await mountHarness({
    hello: { ...HELLO, kinds: HELLO.kinds.filter(kind => kind !== 'image'), features: HELLO.features.filter(feature => feature !== 'blobs') },
  })
  commit(harness.renderer, [toolRowWithImage()], {})
  await until('the row to state the unavailable-capability reason', () =>
    JSON.stringify(harness.tern.frames().at(-1)).includes('Native image display unavailable in this Tern pane'))

  assert.deepEqual(harness.reads, [], 'a pane without the capability reads nothing')
  assert.deepEqual(harness.tern.blobIds(), [])
  const frame = harness.tern.frames().at(-1)
  assert.equal(JSON.stringify(frame).includes('Native image display unavailable in this Tern pane'), true)
  await harness.dispose()
})
