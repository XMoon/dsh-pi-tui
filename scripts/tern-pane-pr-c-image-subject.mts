/**
 * The subject of the PR-C real-pane flow: the PRODUCTION tool-result image
 * projection, painted by a REAL Tern client.
 *
 * It renders the very nodes the shipped renderer emits — the production
 * `transcriptView` mapper over a real tool result that carries an image block
 * — and it sends the image through the OFFICIAL SDK blob channel, exactly as
 * `src/tui/tsp/session.ts` does. Nothing here re-implements the projection:
 * the identity line, the node keys and the block order come from the
 * production mapper.
 *
 * The image bytes are a synthetic PNG generated in-process (a solid 640x360
 * canvas): no user content and no real attachment ever reaches a client.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-pr-c-image-subject.mts
 * @module scripts/tern-pane-pr-c-image-subject
 */
import { appendFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { connect, ui, type TspEvent } from '@stencil-hq/tern'
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

const WIDTH = 640
const HEIGHT = 360
const BYTES = solidPng(WIDTH, HEIGHT, [0x2f, 0x6f, 0xed])

const session = await connect({ app: 'tern-pane-pr-c-image', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'pr-c-image' })

/** The tool result the production projection renders: text, image, text. */
const message = {
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

// The OFFICIAL blob channel — the same call the renderer makes, and it must
// precede the frame that references the blob id.
const blobId = session.blob(BYTES, 'image/png')

function render(): void {
  const view = transcriptView(projectTranscriptStructure([message]), new TranscriptNodeKeys(), {
    toolImageStates: new Map([['prc-synthetic-1', { state: 'ready', blobId }]]),
  })
  surface.render({ main: view })
}

render()
note({ ready: true, blobId })

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
