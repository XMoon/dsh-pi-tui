/**
 * I8-3 Lane F subject — DETERMINISTIC_PRODUCT_GUI.
 *
 * One case per process, one dedicated Windows Terminal window. The REAL
 * `ProcessTerminal` owns the tty, so DA1 / `CSI 16t` / OSC 11 come from the
 * actual terminal, never from a script. The REAL `TuiApp` composes the same
 * image factory, screens and loaders production uses; the case only injects the
 * SOURCE FACTS a Host would deliver (transcript events, draft bytes, published
 * visuals). Every interaction the case asserts on is produced by the OS
 * keyboard/mouse through that window — this file never calls a picker, a
 * fullscreen toggle outside the case's START CONFIG, or a click handler.
 *
 *   node --import tsx/esm scripts/wt-sixel-e3-subject.mts \
 *     --case WT01 --fixture-root <abs dir> --events <abs JSONL> [--hold <seconds>]
 *
 * The event log records what the app actually wrote (DCS bytes, clears, cursor
 * moves) and the terminal facts it observed; it is an OBSERVATION channel, not
 * an interaction channel.
 * @module wt-sixel-e3-subject
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ProcessTerminal } from '@xmoon76/pi-tui'

import { DraftImageStore } from '../src/client/media/image/draft-store.ts'
import { ImageLoader } from '../src/client/media/image/loader.ts'
import { SvgRasterLoader } from '../src/client/media/svg/raster-loader.ts'
import { rasterizeSvg } from '../src/client/media/svg/rasterize.ts'
import { setAssistantVisualPresentation, type VisualPresentationKey } from '../src/domain/visual/presentation.ts'
import type { PublishedVisual } from '../src/domain/visual/publication.ts'
import { svgFactFromArgs, svgHumanText } from '../src/domain/visual/svg.ts'
import { SVG_TOOL_NAME } from '../src/domain/visual/tools.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { TuiAppEvents } from '../src/tui-app.ts'

/* ------------------------------------------------------------------ argv --- */

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]!
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

const CASE_ID = arg('case')
const FIXTURE_ROOT = resolve(arg('fixture-root'))
const EVENTS_PATH = resolve(arg('events'))
const HOLD_SECONDS = Number(arg('hold', '0'))
if (!existsSync(FIXTURE_ROOT)) throw new Error(`fixture root does not exist: ${FIXTURE_ROOT}`)

mkdirSync(join(EVENTS_PATH, '..'), { recursive: true })

/* --------------------------------------------------------------- logging --- */

interface EventRecord {
  readonly at: number
  readonly kind: string
  readonly [key: string]: unknown
}

const startedAt = Date.now()

/**
 * Capture the ONE input callback the fork hands to `ProcessTerminal.start`.
 *
 * `ProcessTerminal` has no public feed method: OS keystrokes arrive through the
 * callback the terminal passes to its own `start`, and that is the exact chain a
 * case must use. Wrapping `start` to remember the callback keeps the case inside
 * the production parser instead of calling an app handler directly.
 */
let realInput: ((data: string) => void) | undefined

function terminalInput(text: string): void {
  if (realInput === undefined) throw new Error('the terminal has not received its input callback yet')
  realInput(text)
}

function record(kind: string, fields: Record<string, unknown> = {}): void {
  const entry: EventRecord = { at: Date.now() - startedAt, kind, ...fields }
  appendFileSync(EVENTS_PATH, `${JSON.stringify(entry)}\n`)
}

/* -------------------------------------------------------------- fixtures --- */

/**
 * Deterministic sources. Identical algorithms to the plan's §G2 table so the
 * oracle can recompute every band without trusting this process.
 */
async function sharp(): Promise<typeof import('sharp').default> {
  const module = await import('sharp')
  return module.default
}

function bandsRgba(width: number, height: number, bands: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const bandHeight = height / bands
  for (let y = 0; y < height; y += 1) {
    const band = Math.min(bands - 1, Math.floor(y / bandHeight))
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      rgba[offset] = (20 * band) % 256
      rgba[offset + 1] = 255 - 20 * band
      rgba[offset + 2] = (37 * band) % 256
      rgba[offset + 3] = 255
    }
  }
  return rgba
}

function alphaRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const top = y < height / 2
      const left = x < width / 2
      if (top && left) {
        rgba.set([255, 0, 0, 255], offset)
      } else if (top && !left) {
        rgba.set([0, 0, 255, 255], offset)
      } else if (!top && left) {
        rgba.set([0, 255, 0, 128], offset)
      } else {
        rgba.set([0, 0, 0, 0], offset)
      }
    }
  }
  return rgba
}

function tailRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      // Alternating 2px rows make a partial final SIXEL band unambiguous.
      rgba.set(Math.floor(y / 2) % 2 === 0 ? [220, 30, 40, 255] : [30, 60, 220, 255], offset)
    }
  }
  return rgba
}

function twoBandRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rgba.set(y < height / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4)
    }
  }
  return rgba
}

function gradientRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      rgba[offset] = Math.round((x / width) * 255)
      rgba[offset + 1] = Math.round((y / height) * 255)
      // A hard edge every 200px so a clipped raster cannot look plausible.
      rgba[offset + 2] = Math.floor(y / 200) % 2 === 0 ? 40 : 220
      rgba[offset + 3] = 255
    }
  }
  return rgba
}

async function pngOf(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const sharpModule = await sharp()
  const buffer = await sharpModule(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer()
  return new Uint8Array(buffer)
}

const SVG12 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300"><desc>Twelve hard bands</desc>${Array.from(
  { length: 12 },
  (_, index) =>
    `<rect x="0" y="${index * 25}" width="500" height="25" fill="rgb(${(20 * index) % 256},${255 - 20 * index},${(37 * index) % 256})"/>`,
).join('')}</svg>`

const SVG_ALPHA = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#ff0000" fill-opacity="0.5"/></svg>'

/* --------------------------------------------------------------- sources --- */

interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name: string
}

/** The bytes the loader answers for each attachment id, keyed for the read. */
const sources = new Map<string, Uint8Array>()

function stageSource(ref: ImageRef, bytes: Uint8Array): ImageRef {
  sources.set(ref.attachmentId, bytes)
  return { ...ref, bytes: bytes.byteLength }
}

/**
 * One transcript of image occurrences, optionally padded with text turns.
 *
 * The padding is SOURCE DATA, not an interaction: a case whose matrix row says
 * "scroll through the transcript" needs a transcript long enough to overflow the
 * viewport, otherwise Windows Terminal's page buttons collapse and there is
 * nothing to scroll (— the real reason WT01/WT13 first recorded a blocked
 * scroll). Each filler line is uniquely numbered so a screenshot can prove which
 * region of the history is on screen.
 */
function transcriptOf(refs: readonly ImageRef[], fillerTurns = 0): TranscriptFolder {
  const folder = new TranscriptFolder()
  // The filler goes FIRST and the image occurrences LAST: a transcript paints
  // from its tail, so padding after the images would push them out of the
  // viewport and a case that must show pixels would paint none.
  const events = [] as never[]
  for (let index = 0; index < fillerTurns; index += 1) {
    events.push({
      type: 'user/message',
      seq: index + 1,
      time: index + 1,
      data: {
        content: [{ type: 'text', text: `HISTORY-LINE-${String(index + 1).padStart(3, '0')}` }],
        source: { kind: 'user' },
      },
    } as never)
  }
  for (const [index, ref] of refs.entries()) {
    events.push({
      type: 'user/message',
      seq: fillerTurns + index + 1,
      time: fillerTurns + index + 1,
      data: { content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } },
    } as never)
  }
  folder.apply(events)
  return folder
}

/**
 * One tool call plus its result, in the REAL durable shape the folder folds:
 * `tool/call` carries the arguments, and `tool/result` carries a first-class
 * tool-role message whose `toolCallId` is the call identity.
 */
function toolSvgTranscript(svg: string, title: string, description: string): TranscriptFolder {
  const fact = svgFactFromArgs({ title, description, svg })
  const human = svgHumanText(fact)
  const folder = new TranscriptFolder()
  folder.apply([
    {
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 0,
        step: 0,
        callId: 'call-svg',
        name: SVG_TOOL_NAME,
        // Durable tool arguments are a JSON STRING; the card parses it.
        arguments: JSON.stringify({ title, description, svg }),
      },
    } as never,
    {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: 'msg-svg-result',
          role: 'tool',
          toolCallId: 'call-svg',
          content: [
            { type: 'text', text: human },
            { type: 'text', text: `visual-v1:${JSON.stringify(fact)}` },
          ],
          isError: false,
        },
      },
    } as never,
  ])
  return folder
}

function assistantSvgTranscript(svg: string, title: string, description: string, admissionWidth = 64): {
  readonly folder: TranscriptFolder
  readonly assistant: TranscriptMessage & { kind: 'assistant' }
} {
  const fact = svgFactFromArgs({ title, description, svg })
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as unknown as SessionEvent,
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: MessageId('i8-3-assistant-svg'),
          role: 'assistant',
          content: [{ type: 'text', text: `Before.\n\n[dsh-visual-sv1_${'a'.repeat(20)}]: <#>\n\nAfter.` }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ]
  folder.apply(events)
  const assistant = folder
    .messages()
    .find((message): message is TranscriptMessage & { kind: 'assistant' } => message.kind === 'assistant')!
  const ref = `sv1_${'a'.repeat(20)}`
  const publication: PublishedVisual = {
    ref,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: 'present-svg',
    source: {
      ref,
      type: 'svg',
      title: fact.title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: 'svg-source',
      chart: undefined,
      svg: fact,
      svgSource: svg,
      svgAdmissionWidth: admissionWidth,
    },
  }
  const key: VisualPresentationKey = {
    subjectKind: 'main',
    subjectId: 'session',
    sourceIdentity: {},
    session: {},
    sessionId: 'session',
    seq: 10,
    turn: 0,
    step: 1,
    text: '',
    content: undefined,
    assistantRevision: 0,
  }
  setAssistantVisualPresentation(assistant, key, [publication])
  return { folder, assistant }
}

/* ------------------------------------------------------------ case matrix --- */

interface CasePlan {
  /** Injected SOURCE facts only; never an interaction. */
  readonly build: () => Promise<CaseBuild>
  /** The case's START CONFIG (the product has no default fullscreen key). */
  readonly startFullscreen?: boolean
  /** Environment the case needs before the app exists. */
  readonly env?: Record<string, string | undefined>
}

interface CaseBuild {
  readonly transcript: TranscriptFolder
  readonly draft?: { readonly bytes: Uint8Array; readonly mediaType: string; readonly width: number; readonly height: number; readonly name: string }
  readonly note?: string
}

const FIXTURES = resolve(process.cwd(), 'test/fixtures/images')
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

const SAMPLE_PNG = (): Uint8Array => fixture('transcript-sample.png')
const SAMPLE_JPG = (): Uint8Array => fixture('transcript-sample.jpg')
const SAMPLE_WEBP = (): Uint8Array => fixture('transcript-sample.webp')
const SAMPLE_GIF = (): Uint8Array => fixture('transcript-sample.gif')

async function transcriptCase(
  sources: readonly { name: string; mediaType: ImageRef['mediaType']; bytes: Uint8Array; width: number; height: number }[],
  fillerTurns = 0,
): Promise<CaseBuild> {
  const refs = sources.map((source, index) =>
    stageSource(
      {
        attachmentId: `att-${CASE_ID}-${index}`,
        mediaType: source.mediaType,
        bytes: source.bytes.byteLength,
        width: source.width,
        height: source.height,
        name: source.name,
      },
      source.bytes,
    ),
  )
  return { transcript: transcriptOf(refs, fillerTurns) }
}

const CASES: Record<string, CasePlan> = {
  WT01: {
    // WT01 scrolls through a transcript of four image occurrences, so the
    // history must be long enough to overflow the 32-row viewport.
    build: async () =>
      transcriptCase(
        [
          { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
          { name: 'sample.jpg', mediaType: 'image/jpeg', bytes: SAMPLE_JPG(), width: 640, height: 480 },
          { name: 'sample.webp', mediaType: 'image/webp', bytes: SAMPLE_WEBP(), width: 640, height: 480 },
          { name: 'sample.gif', mediaType: 'image/gif', bytes: SAMPLE_GIF(), width: 320, height: 200 },
        ],
        40,
      ),
  },
  WT02: {
    startFullscreen: true,
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
        { name: 'sample.jpg', mediaType: 'image/jpeg', bytes: SAMPLE_JPG(), width: 640, height: 480 },
      ]),
  },
  WT03: {
    // The draft card appears because the EDITOR receives the stage's placeholder
    // token; the store only provides the bytes a paste would have produced. The
    // case's own operations (typing text, deleting the preview) are OS input.
    build: async () => ({
      transcript: transcriptOf([]),
      draft: { bytes: await pngOf(twoBandRgba(80, 40), 80, 40), mediaType: 'image/png', width: 80, height: 40, name: 'draft.png' },
    }),
  },
  WT04: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT05: {
    build: async () =>
      transcriptCase([
        { name: 'first.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
        { name: 'second.png', mediaType: 'image/png', bytes: await pngOf(twoBandRgba(160, 120), 160, 120), width: 160, height: 120 },
        { name: 'third.png', mediaType: 'image/png', bytes: await pngOf(gradientRgba(240, 160), 240, 160), width: 240, height: 160 },
      ]),
  },
  WT06: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
        { name: 'sample.jpg', mediaType: 'image/jpeg', bytes: SAMPLE_JPG(), width: 640, height: 480 },
        { name: 'sample.webp', mediaType: 'image/webp', bytes: SAMPLE_WEBP(), width: 640, height: 480 },
      ]),
  },
  WT07: {
    // A Tool card is COLLAPSED by default; expanding it is the case's operation and
    // is declared ONLY by the drive's case table (one authority, no mirror here).
    build: async () => ({ transcript: toolSvgTranscript(SVG12, 'Twelve bands', 'Twelve hard bands') }),
  },
  WT08: {
    build: async () => ({ transcript: assistantSvgTranscript(SVG12, 'Twelve bands', 'Twelve hard bands').folder }),
  },
  WT09: {
    build: async () => ({ transcript: assistantSvgTranscript(SVG12, 'Twelve bands', 'Twelve hard bands').folder }),
  },
  WT10: {
    build: async () =>
      transcriptCase([
        { name: 'long.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 1200, 12), 200, 1200), width: 200, height: 1200 },
      ]),
  },
  WT11: {
    build: async () =>
      transcriptCase([
        { name: 'long.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 1200, 12), 200, 1200), width: 200, height: 1200 },
      ]),
  },
  WT12: {
    build: async () =>
      transcriptCase([
        { name: 'large.png', mediaType: 'image/png', bytes: await pngOf(gradientRgba(1000, 1200), 1000, 1200), width: 1000, height: 1200 },
        { name: 'small.png', mediaType: 'image/png', bytes: await pngOf(twoBandRgba(80, 40), 80, 40), width: 80, height: 40 },
      ]),
  },
  WT13: {
    // WT13 scrolls Main, exits/re-enters and searches across image history, so
    // the transcript needs real scrollback beyond the viewport.
    build: async () =>
      transcriptCase(
        [
          { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
          { name: 'tail.png', mediaType: 'image/png', bytes: await pngOf(tailRgba(200, 37), 200, 37), width: 200, height: 37 },
        ],
        40,
      ),
  },
  WT14: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT15: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT16: {
    build: async () =>
      transcriptCase([
        { name: 'long.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 1200, 12), 200, 1200), width: 200, height: 1200 },
      ]),
  },
  WT17: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT18: {
    build: async () =>
      transcriptCase([
        { name: 'alpha.png', mediaType: 'image/png', bytes: await pngOf(alphaRgba(200, 120), 200, 120), width: 200, height: 120 },
      ]),
  },
  WT19: {
    build: async () =>
      transcriptCase([
        { name: 'alpha.png', mediaType: 'image/png', bytes: await pngOf(alphaRgba(200, 120), 200, 120), width: 200, height: 120 },
        { name: 'tail.png', mediaType: 'image/png', bytes: await pngOf(tailRgba(200, 37), 200, 37), width: 200, height: 37 },
      ]),
  },
  WT20: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT21: {
    env: { PI_IMAGE_PROTOCOL: 'none' },
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT22: {
    build: async () =>
      transcriptCase([
        { name: 'corrupt.jpg', mediaType: 'image/jpeg', bytes: fixture('transcript-corrupt.jpg'), width: 640, height: 480 },
        { name: 'over-limit.jpg', mediaType: 'image/jpeg', bytes: fixture('transcript-over-limit.jpg'), width: 640, height: 480 },
        { name: 'sample.gif', mediaType: 'image/gif', bytes: SAMPLE_GIF(), width: 320, height: 200 },
      ]),
  },
  WT23: {
    build: async () => {
      const sources = [] as { name: string; mediaType: ImageRef['mediaType']; bytes: Uint8Array; width: number; height: number }[]
      for (let index = 0; index < 24; index += 1) {
        const width = 120 + (index % 5) * 20
        const height = 90 + (index % 7) * 30
        sources.push({
          name: `variants-${String(index).padStart(2, '0')}.png`,
          mediaType: 'image/png',
          bytes: await pngOf(bandsRgba(width, height, 6), width, height),
          width,
          height,
        })
      }
      return transcriptCase(sources)
    },
  },
  WT24: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
      ]),
  },
  WT25: {
    build: async () => {
      const folder = new TranscriptFolder()
      // A REAL tool result whose TEXT carries an untrusted DCS-looking byte
      // sequence: the product must escape it into visible text and never let it
      // reach Terminal.write as an image command.
      folder.apply([
        {
          type: 'tool/call',
          seq: 1,
          time: 1,
          data: { turn: 0, step: 0, callId: 'call-dcs', name: 'echo', arguments: JSON.stringify({ text: 'untrusted' }) },
        } as never,
        {
          type: 'tool/result',
          seq: 2,
          time: 2,
          data: {
            turn: 0,
            step: 0,
            message: {
              id: 'msg-dcs-result',
              role: 'tool',
              toolCallId: 'call-dcs',
              content: [{ type: 'text', text: 'ESC-P-PAYLOAD \u001bP0;0;0q"1;1;10;10#0;2;0;0;0#0~~\u001b\\ TAIL' }],
              isError: false,
            },
          },
        } as never,
      ])
      return { transcript: folder }
    },
  },
  WT26: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
        { name: 'searchable.png', mediaType: 'image/png', bytes: await pngOf(twoBandRgba(160, 120), 160, 120), width: 160, height: 120 },
      ]),
  },
  WT27: {
    build: async () =>
      transcriptCase([
        { name: 'bands.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
        { name: 'second.png', mediaType: 'image/png', bytes: await pngOf(twoBandRgba(160, 120), 160, 120), width: 160, height: 120 },
        { name: 'third.png', mediaType: 'image/png', bytes: await pngOf(gradientRgba(240, 160), 240, 160), width: 240, height: 160 },
      ]),
  },
  WT28: {
    build: async () =>
      transcriptCase([
        { name: 'first.png', mediaType: 'image/png', bytes: await pngOf(alphaRgba(200, 120), 200, 120), width: 200, height: 120 },
        { name: 'second.png', mediaType: 'image/png', bytes: await pngOf(bandsRgba(200, 240, 12), 200, 240), width: 200, height: 240 },
        { name: 'third.png', mediaType: 'image/png', bytes: await pngOf(tailRgba(200, 37), 200, 37), width: 200, height: 37 },
      ]),
  },
  WT_SVG_ALPHA: {
    build: async () => ({ transcript: assistantSvgTranscript(SVG_ALPHA, 'Half red', 'Semi-transparent red square').folder }),
  },
}

const plan = CASES[CASE_ID]
if (plan === undefined) throw new Error(`unknown case: ${CASE_ID} (known: ${Object.keys(CASES).join(', ')})`)

/* ------------------------------------------------------------- execution --- */

async function main(): Promise<void> {
  const build = await plan.build()
  for (const [name, value] of Object.entries(plan.env ?? {})) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  const terminal = new ProcessTerminal()
  const startReal = terminal.start.bind(terminal)
  terminal.start = (onInput: (data: string) => void, onResize: () => void): void => {
    realInput = onInput
    startReal(onInput, onResize)
  }
  const store = new DraftImageStore()
  const loader = new ImageLoader(async (ref) => {
    const id = (ref as { attachmentId?: string }).attachmentId ?? ''
    const bytes = sources.get(id)
    if (bytes === undefined) throw new Error(`unknown attachment: ${id}`)
    return { ref: {}, data: bytes }
  })
  const svgLoader = new SvgRasterLoader(rasterizeSvg)

  // OBSERVATION channel: every byte the app writes still reaches the real tty;
  // the log keeps the wire facts an oracle needs (DCS, clears, cursor moves).
  const wire: string[] = []
  let dcsWrites = 0
  const realWrite = terminal.write.bind(terminal)
  terminal.write = (data: string): void => {
    if (data.includes('\u001bP')) dcsWrites += 1
    wire.push(data)
    record('write', {
      bytes: data.length,
      head: data.slice(0, 64),
      dcs: data.includes('\u001bP'),
      dcsBytes: data.includes('\u001bP') ? data.slice(data.indexOf('\u001bP')).length : 0,
      dcsPrefix: data.includes('\u001bP') ? data.slice(data.indexOf('\u001bP'), data.indexOf('\u001bP') + 24) : undefined,
      clears2J: (data.match(/\u001b\[2J/g) ?? []).length,
      clears2K: (data.match(/\u001b\[2K/g) ?? []).length,
      clears3J: (data.match(/\u001b\[3J/g) ?? []).length,
    })
    realWrite(data)
  }

  const events: TuiAppEvents = {
    onSubmit: () => record('submit'),
    onExit: () => record('exit-request'),
    onCancel: () => record('cancel'),
    runOwned: (_label: string, task: () => unknown) => {
      void Promise.resolve(task()).catch((error: unknown) => record('owned-failure', { message: String(error) }))
    },
  }

  const app = new TuiApp(terminal, events, {
    draftImagePreviewSource: { values: () => store.values() },
    draftImageStoreForTest: store,
    imageLoader: loader,
    imageTheme: { fallbackColor: (text: string) => text },
    svgRasterLoader: svgLoader,
  })

  terminal.onSixelSupport?.((supported) => record('da1-sixel', { supported }))

  record('before-start', {
    case: CASE_ID,
    fixtureRoot: FIXTURE_ROOT,
    tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    term: process.env.TERM ?? null,
    termProgram: process.env.TERM_PROGRAM ?? null,
    wtSession: process.env.WT_SESSION ?? null,
    mux: { tmux: process.env.TMUX ?? null, zellij: process.env.ZELLIJ ?? null, sty: process.env.STY ?? null },
    columns: terminal.columns,
    rows: terminal.rows,
    piImageProtocol: process.env.PI_IMAGE_PROTOCOL ?? null,
    sources: [...sources.entries()].map(([id, bytes]) => ({ id, bytes: bytes.byteLength })),
  })

  app.start()
  record('after-start', { columns: terminal.columns, rows: terminal.rows })

  if (plan.startFullscreen === true) {
    // START CONFIG, not a simulated user action: the product has no default
    // fullscreen keybinding, so the case's initial surface is set here.
    app.setFullscreen(true)
    record('start-config', { fullscreen: true })
  }

  if (build.draft !== undefined) {
    const image = store.add({
      bytes: build.draft.bytes,
      mediaType: build.draft.mediaType,
      width: build.draft.width,
      height: build.draft.height,
      name: build.draft.name,
    })
    record('draft-staged', { placeholder: image.placeholder, name: build.draft.name, width: build.draft.width, height: build.draft.height })
    // The placeholder enters the REAL editor through the terminal input chain,
    // which is how a paste/drop lands it. The app's own preview then paints.
    terminalInput(image.placeholder)
    record('draft-placeholder-typed', { placeholder: image.placeholder })
  }

  app.setTranscript(build.transcript.messages())
  app.requestRender()
  record('transcript-committed', { messages: build.transcript.messages().length, note: build.note ?? null })

  let shutDown = false
  const shutdown = (reason: string): void => {
    if (shutDown) return
    shutDown = true
    record('shutdown-final', {
      reason,
      writes: wire.length,
      dcsCount: wire.filter((chunk) => chunk.includes('\u001bP')).length,
      dcsBytes: wire.filter((chunk) => chunk.includes('\u001bP')).reduce((total, chunk) => total + chunk.length, 0),
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    })
    try {
      app.dispose()
    } catch (error) {
      record('dispose-failure', { message: String(error) })
    }
    try {
      terminal.stop()
    } catch (error) {
      record('stop-failure', { message: String(error) })
    }
    process.exit(0)
  }

  // Windows Terminal closing the window hangs up the pty, which reaches this
  // process as SIGHUP (not SIGTERM). Handling all three keeps the shutdown record
  // present for a real window close as well as a driver-initiated stop.
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  process.on('beforeExit', () => {
    if (shutDown === false) shutdown('beforeExit')
  })

  // G4 PERFORMANCE (raw series only): the subject is the only place that owns the
  // real encoder/Screen, so the measurement happens here, against the production
  // chain, and is recorded as raw numbers. No threshold is asserted: a slow but
  // correct frame is an observation, not a failure.
  if (process.env.I8_3_PERF === '1') await measurePerformance(app, terminal, build, record, () => dcsWrites)

  record('ready', { holdSeconds: HOLD_SECONDS })
  if (HOLD_SECONDS > 0) setTimeout(() => shutdown('hold-elapsed'), HOLD_SECONDS * 1000)
}

/**
 * One warm-repaint series against the REAL app.
 *
 * The first version timed `setTranscript` + `requestRender` only, which measures
 * the app's bookkeeping and NOT the SIXEL encode or the Screen write — the two
 * costs this case exists to observe. The series therefore waits for the terminal
 * to actually receive the DCS before closing the sample, bounded by a real
 * timeout so a stuck frame is reported instead of hanging the run.
 */
async function measurePerformance(
  app: TuiApp,
  terminal: ProcessTerminal,
  build: CaseBuild,
  record: (kind: string, fields?: Record<string, unknown>) => void,
  dcsCounter: () => number,
): Promise<void> {
  const series: { totalMs: number; encoded: boolean }[] = []
  const heapBefore = process.memoryUsage()
  await new Promise((resolve) => setTimeout(resolve, 200))
  for (let index = 0; index < 5; index += 1) {
    const before = dcsCounter()
    const started = performance.now()
    app.setTranscript(build.transcript.messages())
    app.requestRender()
    const deadline = Date.now() + 5_000
    let encoded = false
    while (Date.now() < deadline) {
      if (dcsCounter() > before) {
        encoded = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    series.push({ totalMs: Math.round((performance.now() - started) * 100) / 100, encoded })
  }
  const heapAfter = process.memoryUsage()
  const totals = series.map((entry) => entry.totalMs).sort((left, right) => left - right)
  record('perf', {
    reps: series.length,
    // Each sample spans requestRender -> the DCS reaching Terminal.write, so it
    // includes queueing, encoding and the frame write.
    seriesMs: series.map((entry) => entry.totalMs),
    encodedInSeries: series.filter((entry) => entry.encoded).length,
    medianMs: totals[Math.floor(totals.length / 2)],
    minMs: totals[0],
    maxMs: totals[totals.length - 1],
    // Only five samples exist, so a p95 would be a fabricated number.
    p95Ms: 'NOT_CLAIMED (n=5, insufficient)',
    rssBefore: heapBefore.rss,
    rssAfter: heapAfter.rss,
    heapUsedBefore: heapBefore.heapUsed,
    heapUsedAfter: heapAfter.heapUsed,
    terminalColumns: terminal.columns,
    terminalRows: terminal.rows,
  })
}

void main()

/* Keep the unused-fixture helpers referenced so the case table stays declarative. */
void SAMPLE_PNG
void writeFileSync
void HOLD_SECONDS
