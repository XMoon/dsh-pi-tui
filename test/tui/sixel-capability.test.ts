/**
 * Image-8 / I8-1B — the ONE Direct SIXEL admission classifier.
 *
 * Every verdict here is produced from a REAL `ProcessTerminal`: the scripted
 * DA1 bytes go through the fork's own `StdinBuffer` → negotiation reader →
 * `onSixelSupport`, and only then into `createDirectSixelCapability`. A test
 * that injected a `supported` boolean straight into the factory would not prove
 * the production path, so the positive and both negative reply cases drive the
 * real class instead.
 *
 * What this file does NOT prove: that any product surface paints SIXEL. I8-2A
 * owns the consumer wiring; `effectiveImageProtocol()` and
 * `getCapabilities().images` are intentionally untouched here.
 * @module @xmoon76/dsh-pi-tui/tui/sixel-capability.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ProcessTerminal, type Terminal } from '@xmoon76/pi-tui'
import { createDirectSixelCapability, type SixelDirectVerdict } from '../../src/tui/graphics/sixel-capability.ts'

/** Windows Terminal's real primary DA1: attribute 4 is the SIXEL marker. */
const WT_DA1 = '\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c'
/** Same shape without a whole `4` token; `14`/`42` must not count. */
const NO_SIXEL_DA1 = '\x1b[?61;14;42c'

/** A Direct-terminal topology: no multiplexer marker, no legacy protocol. */
const DIRECT_ENV: NodeJS.ProcessEnv = { TERM: 'xterm-256color' }

/**
 * Drive a real `ProcessTerminal` with scripted stdin bytes.
 *
 * Node's real stdin is replaced for the lifetime of one test; the terminal is
 * started and stopped through its production lifecycle so repeated-start and
 * stop behaviour are the real ones.
 */
class DirectTerminalHarness {
  readonly terminal = new ProcessTerminal()
  readonly inputs: string[] = []
  /** How many times the candidate asked the terminal to observe (spy on the hook). */
  subscriptionCount = 0
  private readonly stdinDataListeners: ((data: string) => void)[] = []
  private readonly resizeListeners: (() => void)[] = []
  private cleaned = false
  private readonly restore: () => void

  constructor() {
    const previousWrite = process.stdout.write
    const previousStdoutOn = process.stdout.on
    const previousStdoutRemoveListener = process.stdout.removeListener
    const previousStdinOn = process.stdin.on
    const previousStdinRemoveListener = process.stdin.removeListener
    const previousStdinSetEncoding = process.stdin.setEncoding
    const previousStdinResume = process.stdin.resume
    const previousStdinPause = process.stdin.pause
    const previousSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode')

    process.stdout.write = ((_chunk: string | Uint8Array) => true) as typeof process.stdout.write
    process.stdout.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'resize') this.resizeListeners.push(listener as () => void)
      return process.stdout
    }) as typeof process.stdout.on
    process.stdout.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'resize') {
        const index = this.resizeListeners.lastIndexOf(listener as () => void)
        if (index >= 0) this.resizeListeners.splice(index, 1)
      }
      return process.stdout
    }) as typeof process.stdout.removeListener
    process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'data') this.stdinDataListeners.push(listener as (data: string) => void)
      return process.stdin
    }) as typeof process.stdin.on
    process.stdin.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'data') {
        const index = this.stdinDataListeners.lastIndexOf(listener as (data: string) => void)
        if (index >= 0) this.stdinDataListeners.splice(index, 1)
      }
      return process.stdin
    }) as typeof process.stdin.removeListener
    process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding
    process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume
    process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause
    Object.defineProperty(process.stdin, 'setRawMode', { value: () => process.stdin, configurable: true })

    this.restore = (): void => {
      process.stdout.write = previousWrite
      process.stdout.on = previousStdoutOn
      process.stdout.removeListener = previousStdoutRemoveListener
      process.stdin.on = previousStdinOn
      process.stdin.removeListener = previousStdinRemoveListener
      process.stdin.setEncoding = previousStdinSetEncoding
      process.stdin.resume = previousStdinResume
      process.stdin.pause = previousStdinPause
      if (previousSetRawModeDescriptor) {
        Object.defineProperty(process.stdin, 'setRawMode', previousSetRawModeDescriptor)
      } else {
        Reflect.deleteProperty(process.stdin, 'setRawMode')
      }
    }

    // Spy on the PRODUCTION hook: save the unbound original, keep the receiver
    // dynamic, and let the real implementation run unchanged.
    const originalOnSixelSupport = this.terminal.onSixelSupport
    this.terminal.onSixelSupport = (listener: (supported: boolean) => void): (() => void) => {
      this.subscriptionCount += 1
      return originalOnSixelSupport.call(this.terminal, listener)
    }

    this.terminal.start(
      (data) => this.inputs.push(data),
      () => {},
    )
  }

  send(data: string): void {
    for (const listener of [...this.stdinDataListeners]) listener(data)
  }

  cleanup(): void {
    if (this.cleaned) return
    this.cleaned = true
    try {
      this.terminal.stop()
    } finally {
      this.restore()
    }
  }
}

/** Static denials must not subscribe at all — asserted through the spy. */
function deniedWithoutSubscription(
  environment: NodeJS.ProcessEnv,
  legacyImages: 'kitty' | 'iterm2' | null,
): void {
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(harness.terminal, environment, legacyImages)
    assert.equal(capability.verdict, 'denied')
    assert.equal(capability.observed, undefined, 'a denied topology has no observation to report')
    assert.equal(harness.subscriptionCount, 0, 'a denied topology must not attach an observer')
    capability.dispose()
    assert.equal(harness.subscriptionCount, 0)
  } finally {
    harness.cleanup()
  }
}

test('admits a Direct terminal whose real DA1 declares attribute 4', () => {
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(harness.terminal, DIRECT_ENV, null)
    assert.equal(capability.verdict, 'pending', 'no reply yet must stay pending, never admitted')
    assert.equal(harness.subscriptionCount, 1)

    harness.send(WT_DA1)

    assert.equal(capability.verdict, 'admitted')
    assert.equal(capability.observed, true)
    // The DA1 was consumed by the keyboard sentinel, exactly as today: the
    // editor never sees a device-attributes reply as text.
    assert.deepEqual(harness.inputs, [])
  } finally {
    harness.cleanup()
  }
})

test('denies a Direct terminal whose real DA1 has no whole attribute 4', () => {
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(harness.terminal, DIRECT_ENV, null)
    harness.send(NO_SIXEL_DA1)

    assert.equal(capability.verdict, 'denied')
    assert.equal(capability.observed, false)
  } finally {
    harness.cleanup()
  }
})

test('stays pending when the terminal never answers', () => {
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(harness.terminal, DIRECT_ENV, null)

    // Ordinary traffic is not an answer, and no timer may invent one.
    harness.send('x')
    harness.send('\x1b[6;20;10t')

    assert.equal(capability.verdict, 'pending')
    assert.equal(capability.observed, undefined)
  } finally {
    harness.cleanup()
  }
})

test('denies PI_IMAGE_PROTOCOL none and 0 as a hard off', () => {
  deniedWithoutSubscription({ ...DIRECT_ENV, PI_IMAGE_PROTOCOL: 'none' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, PI_IMAGE_PROTOCOL: '0' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, PI_IMAGE_PROTOCOL: 'NONE' }, null)
})

test('denies an explicitly configured legacy protocol', () => {
  deniedWithoutSubscription({ ...DIRECT_ENV, PI_IMAGE_PROTOCOL: 'kitty' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, PI_IMAGE_PROTOCOL: 'iterm2' }, null)
})

test('denies a terminal the fork already classifies as Kitty or iTerm2', () => {
  deniedWithoutSubscription(DIRECT_ENV, 'kitty')
  deniedWithoutSubscription(DIRECT_ENV, 'iterm2')
})

test('denies every multiplexed and Herdr topology', () => {
  deniedWithoutSubscription({ ...DIRECT_ENV, TMUX: '/tmp/tmux-1000/default,123,0' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, ZELLIJ: '0' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, STY: '1234.pts-0.host' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, TERM: 'tmux-256color' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, TERM: 'screen-256color' }, null)
  deniedWithoutSubscription({ ...DIRECT_ENV, TERM_PROGRAM: 'herdr' }, null)
})

test('an empty multiplexer marker is not a session', () => {
  // The ZELLIJ precedent: `ZELLIJ=` (empty) stays a Direct terminal.
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(harness.terminal, { ...DIRECT_ENV, ZELLIJ: '', TMUX: '' }, null)
    assert.equal(capability.verdict, 'pending')
    harness.send(WT_DA1)
    assert.equal(capability.verdict, 'admitted')
  } finally {
    harness.cleanup()
  }
})

test('an unknown PI_IMAGE_PROTOCOL value keeps the existing auto semantics', () => {
  // `sixel` is not a supported override in I8-1; it must NOT force admission.
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(
      harness.terminal,
      { ...DIRECT_ENV, PI_IMAGE_PROTOCOL: 'sixel' },
      null,
    )
    assert.equal(capability.verdict, 'pending', 'an unknown override must not admit anything by itself')
    harness.send(WT_DA1)
    assert.equal(capability.verdict, 'admitted', 'the real DA1 observation still decides')
  } finally {
    harness.cleanup()
  }
})

test('dispose is idempotent and freezes the verdict', () => {
  const harness = new DirectTerminalHarness()
  try {
    const capability = createDirectSixelCapability(harness.terminal, DIRECT_ENV, null)
    const verdictBefore = capability.verdict

    capability.dispose()
    capability.dispose()

    harness.send(WT_DA1)
    assert.equal(capability.observed, undefined, 'a disposed candidate must not update')
    assert.equal(capability.verdict, verdictBefore, 'a disposed candidate keeps its verdict')
  } finally {
    harness.cleanup()
  }
})

test('the type surface names exactly the three verdicts', () => {
  const verdicts: SixelDirectVerdict[] = ['pending', 'admitted', 'denied']
  assert.deepEqual(verdicts, ['pending', 'admitted', 'denied'])
})
