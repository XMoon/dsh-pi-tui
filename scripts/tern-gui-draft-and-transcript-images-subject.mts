/**
 * The subject of the real-GUI lane for the PR4 image surfaces: the PRODUCTION
 * projections (User/Assistant/Tool bodies + the dock's draft rows), painted by
 * a REAL Tern GUI window on a REAL display.
 *
 * Same production modules as the headless subject; this one exists separately so
 * the GUI flow can keep the window's own size and the client's own theme/pin
 * variables untouched by the headless lane's resize bands.
 *
 * Usage: DISPLAY=:0 node --import tsx/esm scripts/tern-gui-draft-and-transcript-images-subject.mts
 * @module scripts/tern-gui-draft-and-transcript-images-subject
 */
import { appendFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { connect, ui, type Node } from '@stencil-hq/tern'
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
const PNGS: readonly Uint8Array[] = [
  solidPng(WIDTH, HEIGHT, [0x2f, 0x6f, 0xed]),
  solidPng(WIDTH, HEIGHT, [0xed, 0x6f, 0x2f]),
  solidPng(WIDTH, HEIGHT, [0x2f, 0xed, 0x6f]),
]

const session = await connect({ app: 'tern-gui-draft-and-transcript-images', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'pr4-images-gui' })
if (session.caps.features.includes('styles')) {
  surface.stylesheet('dsh-draft-preview', `
    @media (max-height: 640px) {
      [data-role="dsh.draft-preview"] { display: none; }
    }
  `)
}

const blobIds = PNGS.map(bytes => session.blob(bytes, 'image/png'))
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

/** TWO images in ONE User body: the client's sibling-Viewer question. */
const userRow = {
  kind: 'user',
  turn: 1,
  text: 'Two shots in one message.',
  content: [
    { type: 'text', text: 'Two shots in one message.' },
    { type: 'image', attachment: attachment('att-user', 'first-shot.png') },
    { type: 'image', attachment: attachment('att-assistant', 'second-shot.png') },
  ],
} as unknown as TranscriptMessage

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

/**
 * The controlled editor's OWN draft state. The GUI lane must be able to prove
 * the seat is real and TYPABLE with previews above it, so a delivered key is
 * applied here and the next frame carries the new text/cursor — the same
 * controlled shape the production renderer uses (`text` + `cursor`, no native
 * editing).
 */
/**
 * The BUSY shape seeds a genuinely MULTI-LINE draft (the worst case for the
 * editor's share of a short pane), so the busy gate really exercises a
 * multi-line editor rather than a one-line draft that merely allows 8 lines.
 * The marker file is chosen by the flow, because `launch()` does not forward
 * arbitrary environment variables.
 */
const busyDock = existsSync(`${dir}/busy.marker`)
let draft = busyDock
  ? 'see attached \nplease compare the\nfirst and second shot\nand tell me what differs\n'
  : 'see attached '
let cursor = draft.length

function render(): void {
  const main = transcriptView(projectTranscriptStructure([userRow, toolRow]), new TranscriptNodeKeys(), {
    imageStates: states,
  })
  // The split-pane gate also needs the BUSY dock shape: notices above the band
  // and a MULTI-LINE editor, which is the worst case for the editor's visibility.
  // The launcher does not forward arbitrary env, so the busy shape is selected by
  // a marker file the flow drops into the run directory before launching.
  const busy = busyDock
  const dock = ui.col(
    { key: 'dock' },
    ...(busy
      ? [
        ui.text({ key: 'queue-1', text: 'queued (queue): an earlier queued message' }),
        ui.text({ key: 'notice-1', text: '! a previous attempt failed' }),
        ui.text({ key: 'notice-2', text: 'compacting (summarizing)' }),
      ]
      : []),
    ui.text({ key: 'status', wrap: 'none', text: `Draft ${DRAFT_ENTRIES.length} · DSH TSP renderer · experimental composer` }),
    ...previewNodes(),
    ui.editor({
      key: 'composer',
      text: draft,
      cursor,
      maxLines: 8,
      placeholder: 'Message',
      prompt: '> ',
    }),
  )
  surface.render({ main, dock })
  note({ frame: { cols: session!.caps.cols, draft } })
}

render()
note({ ready: true, blobIds, cols: session.caps.cols, draft })

for await (const input of session) {
  if (input.type === 'key') {
    const key = input.key
    if (key.name === 'f10') break
    // A printable key is the ONLY edit this subject accepts: it proves a real
    // delivered key reaches the controlled editor (the GUI lane's typability
    // witness) without re-implementing the production reducer.
    if (typeof key.text === 'string' && key.text !== '' && key.ctrl !== true && key.alt !== true && key.meta !== true) {
      draft = draft.slice(0, cursor) + key.text + draft.slice(cursor)
      cursor += key.text.length
      note({ typed: key.text, draft })
      render()
    }
    continue
  }
  if (input.event.ev === 'resize' && input.event.sf === surface.id) render()
}

note({ closed: true })
await surface.close({ keep: false })
await session.close()
