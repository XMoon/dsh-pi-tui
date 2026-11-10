import { Input, dispatchMouseEvent, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseDispatchResult, TuiMouseEvent } from '@xmoon76/pi-tui'
import { color } from '../../tui/theme/runtime.ts'

import { componentKeymap } from '../keybindings/component-keymap.ts'
import { formatKeyId } from '../keybindings/hints.ts'

export type TranscriptSearchScope = 'view' | 'full'

export type TranscriptSearchCoverage =
  | 'entire-session'
  | 'loaded-history'
  | 'loaded-history-with-more'

type SearchHintAction =
  | 'app.transcript.search.next'
  | 'app.transcript.search.previous'
  | 'app.transcript.search.scope'
  | 'app.transcript.search.close'

interface ViewSearchResult {
  readonly currentIndex: number
  readonly count: number
}

interface ScopeHit {
  readonly scope: TranscriptSearchScope
  readonly start: number
  readonly end: number
}

interface PressedScope extends ScopeHit {
  readonly epoch: number
}

const compactKeyHint = (action: SearchHintAction): string => {
  const label = componentKeymap.keyHint(action).toLowerCase().replace('shift', '⇧').replace('enter', '↵')
  return label.includes('⇧') ? label.replace('+', '') : label.replace(' / ', '/')
}

const nextHint = `${compactKeyHint('app.transcript.search.next')} next`
const previousHint = `${compactKeyHint('app.transcript.search.previous')} prev`
const scopeHint = `${compactKeyHint('app.transcript.search.scope')} scope`
const closeHint = `${compactKeyHint('app.transcript.search.close')} close`
const closeReaderHint = `${compactKeyHint('app.transcript.search.close')} returns inline`

/** The one search Input and its rendered-view/full-history scope controls. */
export class TranscriptSearchComponent implements Component, Focusable {
  private readonly input = new Input()
  private readonly onQueryChange: (query: string) => void
  private readonly onScopeRequest: (scope: TranscriptSearchScope) => void
  private readonly readViewResult: () => ViewSearchResult | undefined
  private readonly readTemporaryReader: () => boolean
  private readonly readCoverage: () => TranscriptSearchCoverage
  private resultCount = 0
  /** Full results arrive 1-based; 0/0 means no current result. */
  private resultIndex = 0
  private scope: TranscriptSearchScope
  private _focused = false
  private lastRenderWidth = 0
  private titleEpoch = 0
  private titleLayoutKey = ''
  private scopeHits: ScopeHit[] = []
  private pressedScope: PressedScope | undefined

  constructor(options: {
    readonly onQueryChange: (query: string) => void
    readonly onScopeRequest: (scope: TranscriptSearchScope) => void
    readonly readViewResult: () => ViewSearchResult | undefined
    readonly readTemporaryReader: () => boolean
    readonly readCoverage: () => TranscriptSearchCoverage
    readonly initialScope: TranscriptSearchScope
  }) {
    this.onQueryChange = options.onQueryChange
    this.onScopeRequest = options.onScopeRequest
    this.readViewResult = options.readViewResult
    this.readTemporaryReader = options.readTemporaryReader
    this.readCoverage = options.readCoverage
    this.scope = options.initialScope
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
    if (!value) this.pressedScope = undefined
  }

  getScope(): TranscriptSearchScope {
    return this.scope
  }

  setScope(scope: TranscriptSearchScope): void {
    if (this.scope === scope) return
    this.scope = scope
    this.pressedScope = undefined
    this.input.invalidate()
  }

  /** Publish Full's 1-based match position. View reads its mounted batch live. */
  setResult(index: number, count: number): void {
    this.resultIndex = index
    this.resultCount = count
  }

  handleInput(data: string): void {
    const previous = this.input.getValue()
    this.input.handleInput(data)
    const query = this.input.getValue()
    if (query !== previous) this.onQueryChange(query)
  }

  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (event.width !== this.lastRenderWidth) {
      this.pressedScope = undefined
      return undefined
    }

    if (event.y === 1) {
      if (event.type !== 'press' && event.type !== 'click') return undefined
      if (event.button !== 'left') {
        this.pressedScope = undefined
        return undefined
      }
      const result = dispatchMouseEvent(this.input, { ...event, y: 0, height: 1 })
      if (!result) return undefined
      return {
        ...result,
        ...(result.focus ? { focusTarget: this } : {}),
        target: this.mouseTarget(event),
      }
    }

    if (event.type === 'press') {
      this.pressedScope = undefined
      if (event.y !== 0 || event.button !== 'left') return undefined
      const hit = this.scopeAt(event.x)
      if (hit === undefined) return undefined
      this.pressedScope = { ...hit, epoch: this.titleEpoch }
      return { handled: true, capture: true, render: false, target: this.mouseTarget(event) }
    }

    if (event.type === 'drag') {
      this.pressedScope = undefined
      return { handled: true, capture: true, render: false, target: this.mouseTarget(event) }
    }

    if (event.type === 'release') {
      const pressed = this.pressedScope
      const hit = event.y === 0 ? this.scopeAt(event.x) : undefined
      if (event.button !== 'left' || pressed === undefined || hit?.scope !== pressed.scope
        || pressed.epoch !== this.titleEpoch) {
        this.pressedScope = undefined
      }
      return { handled: true, capture: true, render: false, target: this.mouseTarget(event) }
    }

    if (event.type !== 'click') return undefined
    if (event.y !== 0) {
      this.pressedScope = undefined
      return undefined
    }
    const pressed = this.pressedScope
    this.pressedScope = undefined
    const hit = this.scopeAt(event.x)
    if (event.button !== 'left' || pressed === undefined || hit?.scope !== pressed.scope
      || pressed.epoch !== this.titleEpoch) {
      return { handled: true, render: false, target: this.mouseTarget(event) }
    }
    this.onScopeRequest(hit.scope)
    return { handled: true, render: true, target: this.mouseTarget(event) }
  }

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
    this.lastRenderWidth = width
    const safeWidth = Math.max(1, width)
    const query = this.input.getValue()
    const matchStatus = query === '' ? '' : this.matchStatus()
    const title = this.renderTitle(safeWidth, matchStatus)
    const layoutKey = `${safeWidth}:${this.scopeHits.map(hit => `${hit.scope}:${hit.start}:${hit.end}`).join('|')}`
    if (layoutKey !== this.titleLayoutKey) {
      this.titleLayoutKey = layoutKey
      this.titleEpoch += 1
      this.pressedScope = undefined
    }
    const hint = color.textDim(this.renderHint(safeWidth))
    return [title, ...this.input.render(safeWidth), hint]
  }

  private matchStatus(): string {
    if (this.scope === 'full') {
      return this.resultCount === 0 || this.resultIndex < 1
        ? 'No matches'
        : `${this.resultIndex}/${this.resultCount}`
    }
    const result = this.readViewResult()
    if (result === undefined || result.count === 0 || result.currentIndex < 0) return 'No matches'
    return `${result.currentIndex + 1}/${result.count}`
  }

  private renderTitle(width: number, matchStatus: string): string {
    const activeView = this.scope === 'view'
    const statusWidth = visibleWidth(matchStatus)
    const viewLong = activeView ? '[View]' : 'View'
    const fullLong = activeView ? 'Full' : '[Full]'
    const longScopes = `${viewLong} | ${fullLong}`
    const label = 'Find transcript  '
    const longWithLabel = `${label}${longScopes}`
    const longFits = visibleWidth(longWithLabel) + (matchStatus === '' ? 0 : statusWidth + 1) <= width
    const titleLabel = longFits ? label : ''
    const longFitsWithoutLabel = visibleWidth(longScopes) + (matchStatus === '' ? 0 : statusWidth + 1) <= width

    let viewText = viewLong
    let fullText = fullLong
    let separator = ' | '
    if (!longFitsWithoutLabel) {
      viewText = activeView ? '[V]' : 'V'
      fullText = activeView ? 'F' : '[F]'
      separator = '|'
    }
    const base = `${titleLabel}${viewText}${separator}${fullText}`
    const baseWidth = visibleWidth(base)
    const gap = matchStatus === '' ? width - baseWidth : Math.max(1, width - baseWidth - statusWidth)
    const plain = `${base}${' '.repeat(Math.max(0, gap))}${matchStatus}`
    const startAt = (scope: TranscriptSearchScope): number => {
      const segment = scope === 'view' ? viewText : fullText
      return visibleWidth(base.slice(0, base.indexOf(segment)))
    }
    this.scopeHits = [
      { scope: 'view', start: startAt('view'), end: startAt('view') + visibleWidth(viewText) },
      { scope: 'full', start: startAt('full'), end: startAt('full') + visibleWidth(fullText) },
    ]

    const paintedBase = `${titleLabel ? color.textStrong('Find transcript') + '  ' : ''}`
      + `${activeView ? color.textStrong(viewText, 'primary') : color.textDim(viewText)}`
      + `${color.textDim(separator)}`
      + `${activeView ? color.textDim(fullText) : color.textStrong(fullText, 'primary')}`
    const paintedStatus = matchStatus === '' ? '' : color.textMuted(matchStatus)
    const plainWithSpaces = `${paintedBase}${' '.repeat(Math.max(0, gap))}${paintedStatus}`
    const padding = ' '.repeat(Math.max(0, width - visibleWidth(plain)))
    return `${plainWithSpaces}${padding}`
  }

  private renderHint(width: number): string {
    const coverage = this.scope === 'full' ? this.readCoverage() : undefined
    const coverageText = coverage === 'entire-session'
      ? 'Entire session'
      : coverage === 'loaded-history-with-more'
        ? 'Loaded history; earlier history not searched'
        : coverage === 'loaded-history'
          ? 'Loaded history'
          : undefined
    const segments = [
      { name: 'previous', full: previousHint, short: previousHint },
      { name: 'next', full: nextHint, short: nextHint },
      { name: 'scope', full: scopeHint, short: scopeHint },
      ...(coverageText === undefined ? [] : [{
        name: 'coverage',
        full: coverageText,
        short: coverage === 'loaded-history-with-more' ? 'Older not searched' : coverage === 'loaded-history' ? 'Loaded' : 'Entire',
      }]),
      {
        name: 'close',
        full: this.readTemporaryReader() ? closeReaderHint : closeHint,
        short: this.readTemporaryReader()
          ? `${formatKeyId(componentKeymap.keysFor('app.transcript.search.close')[0]!)} inline`
          : `${formatKeyId(componentKeymap.keysFor('app.transcript.search.close')[0]!)} close`,
      },
    ]
    const removed = new Set<string>()
    const text = (): string => segments
      .filter(segment => !removed.has(segment.name))
      .map(segment => segment.full)
      .join(' · ')
    for (const name of ['previous', 'next', 'scope']) {
      if (visibleWidth(text()) <= width) break
      removed.add(name)
    }
    if (visibleWidth(text()) > width) {
      const coverageSegment = segments.find(segment => segment.name === 'coverage')
      if (coverageSegment !== undefined) coverageSegment.full = coverageSegment.short
    }
    if (visibleWidth(text()) > width) {
      const closeSegment = segments.find(segment => segment.name === 'close')
      if (closeSegment !== undefined) closeSegment.full = closeSegment.short
    }
    if (visibleWidth(text()) > width) {
      const closeSegment = segments.find(segment => segment.name === 'close')
      if (closeSegment !== undefined) {
        closeSegment.full = formatKeyId(componentKeymap.keysFor('app.transcript.search.close')[0]!)
      }
    }
    return text()
  }

  private scopeAt(column: number): ScopeHit | undefined {
    return this.scopeHits.find(hit => column >= hit.start && column < hit.end)
  }

  private mouseTarget(event: TuiMouseEvent): NonNullable<TuiMouseDispatchResult['target']> {
    return {
      component: this,
      originX: event.screenX - event.x,
      originY: event.screenY - event.y,
      width: event.width,
      height: event.height,
    }
  }
}
