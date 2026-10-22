/**
 * The subject of the PR-C real-GUI OVERFLOW flow: a LONG transcript whose
 * FIRST row carries the production tool-result image projection.
 *
 * It exists to answer the overflow question the short window cannot: with a
 * long surface, the client virtualizes and shows the TAIL, so the image at the
 * top is out of view.
 *
 * The subject can also INVOKE the OFFICIAL SDK scroll op. That invocation is
 * recorded here, and the flow reads the client's response back separately:
 * the record proves the INVOCATION, never a client receipt.
 *
 * The image bytes are a synthetic PNG generated in-process.
 *
 * Usage: node --import tsx/esm scripts/tern-gui-pr-c-image-scroll-subject.mts
 * @module scripts/tern-gui-pr-c-image-scroll-subject
 */
import { appendFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { connect, ui, View, type TspEvent } from '@stencil-hq/tern'
import { projectTranscriptStructure } from '../src/tui/transcript/structure.ts'
import { TranscriptNodeKeys, transcriptView } from '../src/tui/tsp/transcript-view.ts'
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

const WIDTH = 640
const HEIGHT = 360
const BYTES = solidPng(WIDTH, HEIGHT, [0x2f, 0x6f, 0xed])
/** How many filler rows follow the image row. */
const FILLER_ROWS = 200

const session = await connect({ app: 'tern-gui-pr-c-image-scroll', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern GUI pane')
const surface = session.open({ mode: 'inline', title: 'pr-c-image-scroll' })

/** The image row: the PRODUCTION projection of a tool result with an image. */
const imageRow = {
  kind: 'tool',
  turn: 1,
  name: 'read_image',
  args: '{"path":"shot.png"}',
  result: 'Here is the screenshot.',
  status: 'ok',
  resultBlocks: [
    { type: 'text', text: 'Here is the screenshot.' },
    {
      type: 'image',
      attachment: {
        attachmentId: 'prc-synthetic-1',
        mediaType: 'image/png',
        bytes: BYTES.length,
        width: WIDTH,
        height: HEIGHT,
        name: 'shot.png',
      },
    },
    { type: 'text', text: 'This is the area to inspect.' },
  ],
} as unknown as TranscriptMessage

const filler = (index: number): TranscriptMessage => ({
  kind: 'assistant',
  turn: 1,
  text: `filler row ${index}`,
  source: 'model',
} as unknown as TranscriptMessage)

const messages: TranscriptMessage[] = [
  imageRow,
  ...Array.from({ length: FILLER_ROWS }, (_, index) => filler(index)),
]

const blobId = session.blob(BYTES, 'image/png')

/** The most recently rendered view (its reconciled ids are the client's). */
let current: ReturnType<typeof transcriptView> | undefined

function render(): void {
  const view = transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys(), {
    toolImageStates: new Map([['prc-synthetic-1', { state: 'ready', blobId }]]),
  })
  surface.render({ main: view })
  current = view
}

/** The SDK's reconciled node ids of the rendered view (the ids the client knows). */
function reconciledIds(view: ReturnType<typeof transcriptView>): string[] {
  const ids: string[] = []
  const visit = (entry: { id: string; children: readonly { id: string; children: readonly unknown[] }[] }): void => {
    ids.push(entry.id)
    for (const child of entry.children) visit(child as never)
  }
  // The SDK's region array is SPARSE: the slots of the regions this view does
  // not use are undefined, so they are skipped.
  for (const region of View.from({ main: view }).regions) {
    if (region === undefined) continue
    visit(region as never)
  }
  return ids
}

render()
note({ ready: true, blobId, fillerRows: FILLER_ROWS })

for await (const input of session) {
  if (input.type === 'key') {
    if (input.key.name === 'f10') break
    // The OFFICIAL scroll op, invoked at the client's own request path. The
    // client's response is the FLOW's observation, not this record.
    if (input.key.name === 'a') {
      // The OFFICIAL scroll op, aimed at a node the client really knows: the
      // LAST row of the long surface. 'start' is the scroll container's start,
      // so the client's own virtualized view moves back to the head.
      const ids = reconciledIds(current)
      const last = ids[ids.length - 1]
      if (last !== undefined) surface.scroll(last, 'start')
      note({ scrolled: 'start', target: last })
    }
    continue
  }
  const event = input.event as TspEvent
  if (event.ev === 'resize' && event.sf === surface.id) render()
}

note({ closed: true })
await surface.close({ keep: false })
await session.close()
