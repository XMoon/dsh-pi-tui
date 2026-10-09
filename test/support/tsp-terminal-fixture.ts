/**
 * The scripted TSP pane as the PROCESS tty, so the REAL composition root can be
 * driven through the official SDK.
 *
 * `installVirtualProcessTerminal` (runner-harness) only routes production
 * `ProcessTerminal` instances — the TSP renderer never uses one: its connector
 * calls the shipped SDK `connect()`, which reads `process.stdin`/`process.stdout`
 * directly. This fixture installs the same scripted pane the live-mount suite
 * uses (probe reply, frame acks under credit flow control, raw-mode recording)
 * as those process streams, so `productionTspConnector` → `connectTspRenderer` →
 * the real `SurfaceRuntime`/`SurfaceLifecycle`/`ExitController` are the ones under
 * test. Nothing here fakes application state: only the tty boundary is simulated.
 * @module test/support/tsp-terminal-fixture
 */

import { EventEmitter } from 'node:events'
import { concatBytes, type Op, type TermInput, type TermOutput } from '@stencil-hq/tern'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** The official hello reply the pane sends for the DA1 probe. */
const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool'],
  features: ['flow', 'styles'],
  apc: 65536,
  credits: 2,
  cols: 120,
  cell: { w: 8, h: 17 },
  dark: true,
  reduceMotion: false,
  hour12: false,
}

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  readonly raw: boolean[] = []
  readonly received: string[] = []
  setRawMode(mode: boolean): void {
    this.isRaw = mode
    this.raw.push(mode)
  }
  type(text: string): void {
    this.emit('data', ENCODER.encode(text))
  }
}

class FakeOutput extends EventEmitter implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly rows = 30
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(bytes)
    return true
  }
  text(): string {
    return DECODER.decode(concatBytes(this.chunks))
  }
}

interface WireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

export interface TspPane {
  readonly input: FakeInput
  readonly output: FakeOutput
  /**
   * Bytes delivered in the SAME input chunk as the hello reply — the race shape:
   * the SDK decodes the handshake AND the key in one read, so a legal quit can be
   * consumed before the application ownership transfer.
   */
  queueWithHandshake(bytes: string): void
  /** Hold the handshake reply until {@link releaseHandshake} (a held handshake). */
  holdHandshake(): void
  releaseHandshake(): void
  /** Never answer the probe: the shipped SDK declines after its timeout. */
  decline(): void
  /** Make the FIRST `x` close-frame write throw (the acquired release fails). */
  failCloseWrite(value: unknown): void
  /** Whether the official SDK ever ran its DA1 probe (i.e. connected). */
  probed(): boolean
  /** Successfully RECORDED `x {"id":…,"keep":false}` surface frames (not a
   *  count of Session.close() calls: a failed `x` write is not recorded here). */
  closeFrames(): number
  /** Frame ops sent, per surface, in order. */
  frameCount(): number
  restore(): void
}

/** Install the scripted pane as `process.stdin`/`process.stdout`. */
export function installTspPane(): TspPane {
  const input = new FakeInput()
  const output = new FakeOutput()
  let probed = false
  let queued = ''
  let mode: 'reply' | 'hold' | 'decline' = 'reply'
  let closeFailure: { readonly set: boolean; readonly value: unknown } = { set: false, value: undefined }
  let closeFailureValue: unknown
  let heldReply: (() => void) | undefined
  const closeBodies: string[] = []
  let frames = 0

  const reply = (): void => {
    const pending = queued
    queued = ''
    // ONE chunk: the handshake reply and any queued key bytes.
    setTimeout(() => input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c${pending}`), 1)
  }

  output.onWrite = bytes => {
    const text = DECODER.decode(bytes)
    if (text.includes('\u001b[c')) {
      probed = true
      if (mode === 'decline') return
      if (mode === 'hold') { heldReply = reply; return }
      reply()
      return
    }
    if (closeFailure.set && /\u001b_tsp;x;/.test(text)) {
      // Fail the FIRST close-frame write only: the SDK's own close sequence may
      // write more than once, and a second failure would aggregate instead of
      // rejecting with the EXACT injected value (R7-1).
      closeFailure = { set: false, value: undefined }
      throw closeFailureValue
    }
    for (const match of text.matchAll(/\u001b_tsp;x;([\s\S]*?)\u001b\\/g)) closeBodies.push(match[1]!)
    for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
      frames += 1
      const frame = JSON.parse(match[1]!) as WireFrame
      // A real pane acks every frame it drew (credit flow control).
      setTimeout(() => input.type(
        `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
      ), 0)
    }
  }

  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')
  Object.defineProperty(process, 'stdin', { configurable: true, get: () => input })
  Object.defineProperty(process, 'stdout', { configurable: true, get: () => output })
  // The shipped SDK declines inside multiplexers (`TMUX`/`STY`/`ZELLIJ` are
  // truthy even as "0") and under an explicit `TERN_TSP=0`. Clear them for the
  // duration: the simulated pane IS the tty authority here.
  const declined = ['TMUX', 'STY', 'ZELLIJ', 'TERN_TSP', 'DSH_PI_TUI_RENDERER', 'DSH_PI_TUI_LOG'] as const
  const previousEnv = new Map<string, string | undefined>()
  for (const name of declined) {
    previousEnv.set(name, process.env[name])
    delete process.env[name]
  }

  return {
    input,
    output,
    queueWithHandshake: (bytes: string) => { queued += bytes },
    holdHandshake: () => { mode = 'hold' },
    releaseHandshake: () => { mode = 'reply'; const run = heldReply; heldReply = undefined; run?.() },
    decline: () => { mode = 'decline' },
    failCloseWrite: (value: unknown) => { closeFailure = { set: true, value }; closeFailureValue = value },
    probed: () => probed,
    closeFrames: () => closeBodies.length,
    frameCount: () => frames,
    restore: () => {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (stdinDescriptor === undefined) delete (process as { stdin?: unknown }).stdin
      else Object.defineProperty(process, 'stdin', stdinDescriptor)
      if (stdoutDescriptor === undefined) delete (process as { stdout?: unknown }).stdout
      else Object.defineProperty(process, 'stdout', stdoutDescriptor)
    },
  }
}
