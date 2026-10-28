/**
 * The subject of the real-pane lane for the PR4 image surfaces: the PRODUCTION
 * projection + the PRODUCTION dock draft rows, painted by a REAL Tern client.
 *
 * It renders the very nodes the shipped renderer emits — `transcriptView` for
 * the User/Assistant/Tool bodies and `dockDraftImageNodes` for the dock — and
 * sends every image through the OFFICIAL SDK blob channel exactly as
 * `src/tui/tsp/session.ts` does. Nothing here re-implements a projection: the
 * identity lines, node keys, block order and the 2/1/0 width policy all come
 * from the production modules.
 *
 * The image bytes are synthetic PNGs generated in-process: no user content and
 * no real attachment ever reaches a client.
 *
 * The dock is driven over the three frozen width bands with a real resize, so
 * the client's own layout (and the editor's continued visibility) is measured
 * rather than assumed.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-draft-and-transcript-images-subject.mts
 * @module scripts/tern-pane-draft-and-transcript-images-subject
 */
import { appendFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { connect, ui, type Node, type TspEvent } from '@stencil-hq/tern'
import { projectTranscriptStructure } from '../src/tui/transcript/structure.ts'
import {
  TranscriptNodeKeys,
  dockDraftImageNodes,
  transcriptView,
  type DockDraftImageEntry,
  type ToolImageState,
} from '../src/tui/tsp/transcript-view.ts'
import type { TranscriptMessage } from '../src/domain/transcript/types.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)

/** CRC-32 (the PNG chunk checksum). */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

/** One synthetic PNG: a solid canvas of the given size. */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return new Uint8Array(Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

const WIDTH = 320
const HEIGHT = 180
/** One distinct solid PNG per visible occurrence (a different colour each). */
const PNGS: readonly Uint8Array[] = [
  solidPng(WIDTH, HEIGHT, [0x2f, 0x6f, 0xed]),
  solidPng(WIDTH, HEIGHT, [0xed, 0x6f, 0x2f]),
  solidPng(WIDTH, HEIGHT, [0x2f, 0xed, 0x6f]),
]

const session = await connect({ app: 'tern-pane-draft-and-transcript-images', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'pr4-images' })
// The production renderer installs this ONE sheet so a SHORT WINDOW hides the
// preview band; the lane exercises the same rule.
if (session.caps.features.includes('styles')) {
  surface.stylesheet('dsh-draft-preview', `
    @media (max-height: 640px) {
      [data-role="dsh.draft-preview"] { display: none; }
    }
  `)
}

// The OFFICIAL blob channel — the same call the renderer makes. Each blob must
// precede the frame that references it.
const blobIds = PNGS.map((bytes, index) => session.blob(bytes, 'image/png'))
const states = new Map<string, ToolImageState>([
  ['att-user', { state: 'ready', blobId: blobIds[0]! }],
  ['att-assistant', { state: 'ready', blobId: blobIds[1]! }],
  ['att-tool', { state: 'ready', blobId: blobIds[2]! }],
])

const attachment = (id: string, name: string): Record<string, unknown> => ({
  attachmentId: id,
  mediaType: 'image/png',
  bytes: PNGS[0]!.length,
  width: WIDTH,
  height: HEIGHT,
  name,
})

/** The ordered User body: text → image → text. */
const userRow = {
  kind: 'user',
  turn: 1,
  text: 'Please inspect these screenshots.',
  content: [
    { type: 'text', text: 'Please inspect these screenshots.' },
    { type: 'image', attachment: attachment('att-user', 'user-shot.png') },
    { type: 'text', text: 'The second one shows the failing area.' },
  ],
} as unknown as TranscriptMessage

/** The Assistant body: image → text (its own attachment). */
const assistantRow = {
  kind: 'assistant',
  turn: 1,
  text: 'Here is the diagram.',
  content: [
    { type: 'image', attachment: attachment('att-assistant', 'diagram.png') },
    { type: 'text', text: 'Here is the diagram.' },
  ],
} as unknown as TranscriptMessage

/** The Tool result (the PR3 shape, unchanged by PR4). */
const toolRow = {
  kind: 'tool',
  turn: 1,
  name: 'read_image',
  args: '{"path":"shot.png"}',
  result: 'Here is the screenshot.',
  status: 'ok',
  resultBlocks: [
    { type: 'text', text: 'Here is the screenshot.' },
    { type: 'image', attachment: attachment('att-tool', 'shot.png') },
  ],
} as unknown as TranscriptMessage

// THREE staged draft occurrences: the dock's 2/1/0 width policy is exercised by
// a REAL resize of this same program.
const DRAFT_ENTRIES: readonly DockDraftImageEntry[] = PNGS.map((_bytes, index) => ({
  id: index + 1,
  ordinal: index,
  caption: `#${index + 1} · ${WIDTH}×${HEIGHT}`,
  name: `draft-${index + 1}.png`,
  state: { state: 'ready', blobId: blobIds[index]! },
}))

/** The ONE preview row, or nothing when the frozen gate allows no preview. */
function previewNodes(): readonly Node[] {
  const row = dockDraftImageNodes(DRAFT_ENTRIES, previewLimit())
  return row === undefined ? [] : [row]
}

/** The frozen preview-count decision, mirroring the production renderer. */
function previewLimit(): number {
  const canPreview = session!.caps.features.includes('styles')
    && session!.caps.features.includes('blobs')
    && session!.caps.kinds.includes('image')
  if (!canPreview) return 0
  const cols = session!.caps.cols
  return cols < 72 ? 0 : cols < 100 ? 1 : 2
}

function render(): void {
  const main = transcriptView(projectTranscriptStructure([userRow, assistantRow, toolRow]), new TranscriptNodeKeys(), {
    imageStates: states,
  })
  // The dock mirrors the production dock's order: the draft rows sit directly
  // above the controlled editor, and the editor is ALWAYS present.
  const dock = ui.col(
    { key: 'dock' },
    ui.text({ key: 'status', wrap: 'none', text: `Draft ${DRAFT_ENTRIES.length} · DSH TSP renderer · experimental composer` }),
    ...previewNodes(),
    ui.editor({ key: 'composer', text: 'see attached ', cursor: 13, maxLines: 8, placeholder: 'Message', prompt: '> ' }),
  )
  surface.render({ main, dock })
  note({
    frame: { cols: session!.caps.cols, blobIds },
  })
}

render()
note({ ready: true, blobIds })

for await (const input of session) {
  if (input.type === 'key') {
    if (input.key.name === 'f10') break
    continue
  }
  const event = input.event as TspEvent
  if (event.ev === 'resize' && event.sf === surface.id) render()
}

note({ closed: true })
await surface.close({ keep: false })
await session.close()
