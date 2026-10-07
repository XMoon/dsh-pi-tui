/**
 * The welcome card (the startup `🐋` whale + session facts): one whale variant
 * is picked per card lifetime, then the facts render side-by-side, stacked or
 * compact against the live width.
 *
 * Moved verbatim out of `tui-app.ts` (TS4 plan §20). It receives presentation
 * facts exactly as before; no application fact/state moves with it.
 * @module @xmoon76/dsh-pi-tui/tui/components/welcome-card
 */

import { visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { color, hexPaint } from '../theme/runtime.ts'

/** The whale mascot variants: five original designs; one is picked once
 * per process (see WelcomeCard.whaleVariant). */
const WELCOME_WHALES = [
  [
    '        o',
    '      O',
    '     :',
    "  .--'---._      \\_/",
    " (  o      `-----//",
    ' ~~~\\_)~~~~~~~~~~~~',
  ],
  [
    '       z Z',
    "   .------._     \\_/",
    "  (  -      `----//",
    " ~~`~~\\_)~~~~~~~~~~",
  ],
  [
    '                   *',
    " \\_/      .-------.",
    "  \\\\____.'     o  _>",
    "   `-----------\\_)",
  ],
  [
    '       <3',
    '       :',
    "   .---'--.",
    " ( o      `.__  \\_/",
    "   `---\\_)-----`-//",
  ],
  [
    '          \\   /',
    '           \\_/',
    '           | |',
    ' ~~~~~~~~~/ /~~~~~~',
    "         '       o",
    '               o',
  ],
] as const

/** Brand ramp for the whale rows: cyan → blue. Fixed (not a semantic
 * token): custom themes do not override the logo gradient. */
const WELCOME_WHALE_COLORS = [
  '#63C7D1',
  '#5DBBD4',
  '#56AFD7',
  '#50A3D9',
  '#4996DA',
  '#4389D8',
] as const

/** Cells between the whale block and the facts column in side-by-side. */
const WELCOME_WHALE_GAP = 4

/** Layout breakpoints: >= 72 side-by-side, 24..71 stacked, < 24 compact. */
const WELCOME_SIDE_BY_SIDE_MIN_WIDTH = 72

/** The widest whale row across all variants (visible width, ANSI-free).
 * All variants share this layout width so the position stays consistent
 * across picks. */
const WELCOME_WHALE_WIDTH = Math.max(...WELCOME_WHALES.flat().map(line => visibleWidth(line)))

/** Stacked minimum: the whale fills the inner width (widest variant + the
 * 4 box cells). Below this the compact text layout takes over. */
const WELCOME_STACKED_MIN_WIDTH = WELCOME_WHALE_WIDTH + 4

/** Facts column alignment: every label padded to this column. */
const WELCOME_FACT_LABEL_WIDTH = 9

/** The session head card: identity facts, wrapped to the available width so
 * nothing is truncated. Three responsive layouts keep the whale mascot
 * readable without ever truncating facts:
 * - width >= 72: whale left, facts right (side-by-side)
 * - 24 <= width < 72: whale centered above the facts (stacked)
 * - width < 24: compact text rows, no full whale
 */
export class WelcomeCard implements Component {
  private facts: { cwd: string; sessionId: string; model?: string; version: string; preset?: string } | undefined
  private idle = false
  /** M3-5 PR1: hidden while the display subject is a viewed child (the main
   *  session's head must never describe the parent session on a child
   *  surface). The facts stay untouched and reappear on the main subject. */
  private hidden = false
  private lastWidth = -1
  private cached: string[] = []
  /** The height of the LAST render — the frame's layout measurement (the
   * welcome card lives INSIDE the scroll content, so it has no layout
   * box of its own and the host's fullscreen paint snapshot reads this
   * at the onFramePainted boundary instead of re-measuring). */
  lastRenderedHeight = 0
  /** The picked whale variant index; -1 until the first render. Picked
   * once per process — resize and facts changes keep it, only a restart
   * re-picks. */
  private whaleVariant = -1

  /** Replace the facts; the next render rebuilds the card. */
  setFacts(facts: { cwd: string; sessionId: string; model?: string; version: string; preset?: string }): void {
    this.facts = facts
    this.idle = false
    this.cached = []
  }

  /**
   * The pre-session state (deferred session creation): the card invites the
   * first message instead of naming a session that does not exist yet.
   */
  setIdle(idle: boolean): void {
    if (this.idle === idle) return
    this.idle = idle
    this.cached = []
  }

  invalidate(): void {
    this.cached = []
  }

  /**
   * M3-5 PR1: hide the card WITHOUT touching its facts. The main session's
   * head names the main session's model/workspace/session id — none of which
   * may stay visible while the display subject is a viewed child. The facts
   * are kept verbatim, so showing the card again restores the latest main
   * identity with no parked copy.
   * @returns whether the visibility changed (the caller re-measures).
   */
  setHidden(hidden: boolean): boolean {
    if (this.hidden === hidden) return false
    this.hidden = hidden
    this.cached = []
    this.lastRenderedHeight = 0
    return true
  }

  render(width: number): string[] {
    if (this.hidden) {
      this.cached = []
      this.lastRenderedHeight = 0
      return []
    }
    if (this.lastWidth === width && this.cached.length > 0) {
      this.lastRenderedHeight = this.cached.length
      return this.cached
    }
    if (this.whaleVariant < 0) {
      // First render of this process: pick the variant for the whole
      // session. Resize and facts changes keep it; only a restart re-picks.
      this.whaleVariant = Math.floor(Math.random() * WELCOME_WHALES.length)
    }
    this.lastWidth = width
    const inner = Math.max(1, width - 4)
    const rows = this.buildRows(inner, width)
    // No facts and not idle: nothing to frame (an empty box would shift
    // fullscreen row mapping by two rows).
    this.cached = rows.length === 0 ? [] : this.frame(rows, width)
    this.lastRenderedHeight = this.cached.length
    return this.cached
  }

  /** Wrap the layout rows in the original full-width box. */
  private frame(rows: string[], width: number): string[] {
    const b = color.border
    const inner = Math.max(1, width - 4)
    return [
      b(`╭${'─'.repeat(Math.max(0, width - 2))}╮`),
      ...rows.map(row => {
        const vis = visibleWidth(row)
        return `${b('│')} ${row}${' '.repeat(Math.max(0, inner - vis))} ${b('│')}`
      }),
      b(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    ]
  }

  private buildRows(layoutWidth: number, width: number): string[] {
    if (this.idle) {
      const lines = width < WELCOME_STACKED_MIN_WIDTH
        ? [color.textStrong('🐋 dsh-pi-tui'), color.textDim('type a message to start a session')]
        : [color.textStrong('dsh-pi-tui'), color.textDim('type a message to start a session')]
      return this.layout(layoutWidth, width, lines)
    }
    if (this.facts === undefined) return []
    const lines = width < WELCOME_STACKED_MIN_WIDTH ? this.compactFactLines() : this.factLines()
    return this.layout(layoutWidth, width, lines)
  }

  /** The three responsive layouts; the whale is never wrapped or cropped.
   * Breakpoints key on the TERMINAL width; layout math uses the inner
   * (boxed) width. */
  private layout(layoutWidth: number, width: number, lines: string[]): string[] {
    if (width >= WELCOME_SIDE_BY_SIDE_MIN_WIDTH) return this.renderSideBySide(layoutWidth, lines)
    if (width >= WELCOME_STACKED_MIN_WIDTH) return this.renderStacked(layoutWidth, lines)
    return this.renderCompact(layoutWidth, lines)
  }

  /** Whale left, facts right; extra wrapped fact rows continue below the
   * whale rows. */
  private renderSideBySide(width: number, lines: string[]): string[] {
    const whale = this.renderWhaleLines()
    const factsStart = WELCOME_WHALE_WIDTH + WELCOME_WHALE_GAP
    const factsWidth = Math.max(1, width - factsStart)
    const facts = lines.flatMap(line => wrapTextWithAnsi(line, factsWidth))
    const rows: string[] = []
    const total = Math.max(whale.length, facts.length)
    for (let index = 0; index < total; index += 1) {
      const left = index < whale.length ? whale[index]! : ''
      const right = index < facts.length ? facts[index]! : ''
      rows.push(`${left}${' '.repeat(Math.max(0, factsStart - visibleWidth(left)))}${right}`)
    }
    return rows
  }

  /** Whale centered above the facts, one blank row between. The centering
   * offset follows the widest variant, so it shrinks naturally as the
   * width narrows (down to zero when the whale fills the inner width). */
  private renderStacked(width: number, lines: string[]): string[] {
    const whale = this.renderWhaleLines()
    const left = Math.max(0, Math.floor((width - WELCOME_WHALE_WIDTH) / 2))
    const rows = whale.map(line => `${' '.repeat(left)}${line}`)
    rows.push('')
    for (const line of lines) {
      rows.push(...wrapTextWithAnsi(line, width))
    }
    return rows
  }

  /** Compact text rows; the full whale is not shown. */
  private renderCompact(width: number, lines: string[]): string[] {
    return lines.flatMap(line => wrapTextWithAnsi(line, width))
  }

  /** The picked whale variant, painted with the fixed brand gradient (rows
   * beyond the 6-color ramp reuse the last ramp color). */
  private renderWhaleLines(): string[] {
    const whale = WELCOME_WHALES[this.whaleVariant]!
    return whale.map((line, index) => hexPaint(
      WELCOME_WHALE_COLORS[Math.min(index, WELCOME_WHALE_COLORS.length - 1)]!,
      line,
    ))
  }

  /** Session facts in the wide/stacked column layout. The title reads
   * strong, the version muted, labels dim, and values in the body text —
   * the whale's saturated gradient is balanced by readable facts. */
  private factLines(): string[] {
    const facts = this.facts!
    const label = (text: string): string => `${text}${' '.repeat(Math.max(0, WELCOME_FACT_LABEL_WIDTH - text.length))}`
    return [
      `${color.textStrong('dsh-pi-tui')}  ${color.textMuted(facts.version)}`,
      // An ABSENT model fact (a Remote projection that cannot answer yet) omits
      // the line entirely — the label never carries an invented business value.
      ...facts.model === undefined ? [] : [`${color.textDim(label('model'))}${color.text(facts.model)}`],
      ...(facts.preset === undefined ? [] : [`${color.textDim(label('preset'))}${color.text(facts.preset)}`]),
      `${color.textDim(label('cwd'))}${color.text(facts.cwd)}`,
      `${color.textDim(label('session'))}${color.text(facts.sessionId)}`,
    ]
  }

  /** Session facts in the compact layout (whale emoji replaces the ASCII). */
  private compactFactLines(): string[] {
    const facts = this.facts!
    return [
      `${color.textStrong('🐋 dsh-pi-tui')} ${color.textMuted(facts.version)}`,
      [
        facts.model === undefined ? '' : color.text(facts.model),
        facts.preset === undefined ? '' : `preset ${color.text(facts.preset)}`,
      ].filter(part => part !== '').join(' · '),
      color.text(facts.cwd),
      `${color.textDim('session')} ${color.text(facts.sessionId)}`,
    ]
  }
}
