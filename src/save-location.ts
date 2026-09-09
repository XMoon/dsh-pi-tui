/**
 * The Client-local Save Location prompt (Pre-Stage-D export convergence): a
 * narrow directory chooser that sits in the EDITOR SEAT while the user picks
 * where an artifact (session archive or readable transcript) is stored. The
 * filename is FIXED and non-editable; only the directory is editable. The
 * prompt is filesystem UI, NOT an agent question — it never goes through
 * TuiQuestion / QuestionFlow / askQuestions.
 *
 * Interaction:
 * - typing / Left / Right  -> edit the directory (the shared Input)
 * - Up / Down              -> move the directory suggestion selection
 * - Tab                    -> accept the selected directory suggestion
 * - Enter                  -> validate and choose the typed directory
 * - Esc                    -> close the suggestions first; otherwise cancel
 *
 * After Enter validates the directory, a target-file collision enters a small
 * confirmation state (Yes replaces, No returns to directory selection). The
 * prompt is pure component: the app layer owns the promise/abort plumbing,
 * the seat swap, and input routing while the prompt is active.
 * @module @xmoon76/dsh-pi-tui/save-location
 */

import {
  Input,
  dispatchMouseEvent,
  matchesKey,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { componentKeymap } from './keybindings/component-keymap.ts'
import { color } from './theme.ts'
import type { DirectoryCompletionItem } from './file-completion/directory-completion.ts'

/** What the Save Location prompt asks for. */
export interface SaveLocationRequest {
  /** The prompt title (e.g. "Save session archive"). */
  readonly title: string
  /** The FIXED artifact filename (displayed, never editable). */
  readonly filename: string
  /** The initial editable directory value (the Client cwd, `./` preferred). */
  readonly initialDirectory: string
}

/** The outcome of the Save Location interaction. */
export type SaveLocationResult =
  | {
    readonly kind: 'selected'
    readonly directory: string
    /** Whether the user explicitly consented to REPLACING an existing
     * target file (the collision Yes). The sink refuses to overwrite a
     * target that appeared after the prompt's collision check unless this
     * consent was given — no silent overwrite. */
    readonly overwrite: boolean
  }
  | { readonly kind: 'cancelled' }

/** The Client-local filesystem facts the prompt needs (injected so headless
 * tests can drive the interaction without a real filesystem). */
export interface SaveLocationDeps {
  /** Resolve the typed directory against the Client cwd; returns the
   * absolute path. */
  resolveDirectory(input: string): string
  /** Whether the resolved path exists and is a directory. */
  isDirectory(path: string): boolean
  /** Whether the final target file (`join(directory, filename)`) exists. */
  targetExists(directory: string, filename: string): boolean
  /** Directory completion (abortable; late results after close are fenced). */
  complete(raw: string, signal: AbortSignal): Promise<DirectoryCompletionItem[] | null>
}

/** How many suggestion rows are rendered (the rest are summarized). */
const VISIBLE_SUGGESTIONS = 8

/**
 * The interactive Save Location prompt. Renders the fixed filename row and
 * the editable directory row, with directory suggestions below; Enter
 * validates, Tab accepts a suggestion, Esc closes suggestions first and
 * cancels the prompt otherwise. A target-file collision enters a Yes/No
 * confirmation state.
 */
export class SaveLocationPrompt implements Component, Focusable {
  private readonly request: SaveLocationRequest
  private readonly deps: SaveLocationDeps
  private readonly onDone: (result: SaveLocationResult) => void
  private readonly input = new Input()
  /** The latest directory suggestions (empty = none). */
  private suggestions: DirectoryCompletionItem[] = []
  /** Highlighted suggestion index. */
  private suggestionCursor = 0
  /** Completion generation: a late result from an older refresh is dropped. */
  private completionGeneration = 0
  /** The CURRENT generation's abort controller (a superseded refresh aborts
   * the previous scan; the prompt's settle/dispose aborts the live one). */
  private completionAbort = new AbortController()
  /** Local validation error shown under the directory row. */
  private validationError: string | undefined
  /** The validated directory awaiting a collision decision. */
  private selectedDirectory: string | undefined
  /** Whether the collision confirmation state is showing. */
  private confirming = false
  private _focused = false
  /** Latched by settle (onDone) or dispose: in-flight completions are fenced. */
  private settled = false
  /** Physical row of the Directory input line from the last render (-1). */
  private directoryRow = -1
  /** Physical row → suggestion VALUE from the last render (mouse parity:
   * stable identity — a completion refresh between paint and press/release
   * must not select/accept a different row). */
  private suggestionRows: Array<{ row: number; value: string }> = []
  /** The pressed suggestion VALUE (mouse parity). */
  private mousePressedValue: string | undefined
  /** Render width from the last paint (stale-geometry guard). */
  private lastRenderWidth = 0
  /** Called when the prompt needs a re-render (async completion results). */
  onChange: (() => void) | undefined

  constructor(
    request: SaveLocationRequest,
    deps: SaveLocationDeps,
    onDone: (result: SaveLocationResult) => void,
  ) {
    this.request = request
    this.deps = deps
    // The settle latch: the FIRST result wins, and a settled prompt fences
    // every in-flight completion (the app also disposes the prompt on
    // settle, but the component must not depend on the caller for that).
    this.onDone = (result) => {
      if (this.settled) return
      this.settled = true
      this.completionAbort.abort()
      onDone(result)
    }
    this.input.setValue(request.initialDirectory)
    this.input.onSubmit = () => this.confirmDirectory()
    this.input.onEscape = () => this.handleEscape()
    this.input.focused = this._focused
    this.refreshSuggestions()
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    // The free-text Input renders its hardware cursor only while focused AND
    // editing (the confirmation state has no text row).
    this.input.focused = value && !this.confirming
  }

  /** The current directory field value (test hook). */
  getValue(): string {
    return this.input.getValue()
  }

  /** The currently highlighted suggestion (test hook). */
  getSuggestionCursor(): number {
    return this.suggestionCursor
  }

  /** The visible suggestions (test hook). */
  getSuggestions(): readonly DirectoryCompletionItem[] {
    return this.suggestions
  }

  /** Whether the collision confirmation state is showing (test hook). */
  isConfirming(): boolean {
    return this.confirming
  }

  /** The current validation error text (test hook). */
  getValidationError(): string | undefined {
    return this.validationError
  }

  /** Refresh the directory suggestions for the current field value. Each
   * refresh owns its generation AND its abort controller: a superseded
   * refresh aborts the previous scan (rapid typing must not leave
   * concurrent filesystem scans/processes running — only the latest
   * generation's completion is live), and a late result after a newer
   * refresh or after settle/dispose is dropped. */
  private refreshSuggestions(): void {
    const generation = ++this.completionGeneration
    this.completionAbort.abort()
    this.completionAbort = new AbortController()
    const raw = this.input.getValue()
    this.suggestions = []
    this.suggestionCursor = 0
    // The completion refresh is a component-internal async UI refresh — a
    // rejection degrades to no suggestions and the result is fenced by the
    // generation latch (never a bare fire-and-forget task).
    void this.deps.complete(raw, this.completionAbort.signal) // allowlist: completion refresh degrades to no suggestions (generation-fenced)
      .catch(() => null)
      .then((items) => {
        if (this.settled || generation !== this.completionGeneration) return
        this.suggestions = items ?? []
        this.suggestionCursor = 0
        this.onChange?.()
      })
  }

  /** Accept the highlighted suggestion and continue into its children. */
  private acceptSuggestion(): void {
    const item = this.suggestions[this.suggestionCursor]
    if (item === undefined) return
    this.input.setValue(item.value)
    this.validationError = undefined
    this.refreshSuggestions()
  }

  /** Move the suggestion selection (wraps within the visible window). */
  private moveSuggestion(direction: -1 | 1): void {
    if (this.suggestions.length === 0) return
    const count = Math.min(this.suggestions.length, VISIBLE_SUGGESTIONS)
    this.suggestionCursor = (this.suggestionCursor + direction + count) % count
  }

  /** Enter: validate the typed directory, then handle a target collision. */
  private confirmDirectory(): void {
    const directory = this.deps.resolveDirectory(this.input.getValue())
    if (!this.deps.isDirectory(directory)) {
      this.validationError = 'directory does not exist or is not a directory'
      return
    }
    this.validationError = undefined
    this.selectedDirectory = directory
    if (this.deps.targetExists(directory, this.request.filename)) {
      this.confirming = true
      this.suggestions = []
      this.input.focused = false
      return
    }
    this.onDone({ kind: 'selected', directory, overwrite: false })
  }

  /** Esc: close the suggestions first; otherwise cancel the prompt. */
  private handleEscape(): void {
    if (this.suggestions.length > 0) {
      this.suggestions = []
      this.suggestionCursor = 0
      return
    }
    this.onDone({ kind: 'cancelled' })
  }

  /**
   * Mouse parity (same capability audit as QuestionFlow/History private
   * Inputs): the Directory row click-positions the private Input; a
   * suggestion row press selects (resolved by stable VALUE, so an async
   * completion refresh between paint and press cannot select a different
   * row) and a click accepts it (the Tab semantic). Title/File/error/
   * collision/hint rows stay inert.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // The row map is only valid for the last painted width.
    if (event.width !== this.lastRenderWidth) return undefined
    // Collision confirmation is a modal state (y/Enter replaces, n/Esc
    // returns): the directory/suggestion rows are inert while it shows.
    if (this.confirming) return undefined
    // Wheel is normalized by the TUI with button "none" (never "left"):
    // it must be handled BEFORE the left-button gate, or a real wheel
    // over a suggestion never reaches moveSuggestion.
    if (event.type === 'wheel') {
      if (!event.wheelDelta) return undefined
      const suggestion = this.suggestionRows.find(entry => entry.row === event.y)
      if (!suggestion) return undefined
      this.moveSuggestion(event.wheelDelta < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) {
      return undefined
    }
    // Directory row: click-to-position the private Input. The row is
    // 'Directory: ' + the Input's render with the prompt stripped; the
    // Input's value starts at ITS OWN local x=2 (the '> ' prompt), at
    // row column 11, so the Input-local x = row x - 11 + 2 = row x - 9.
    if (event.y === this.directoryRow) {
      const localX = event.x - 9
      if (localX < 0) return { handled: true }
      const result = dispatchMouseEvent(this.input, { ...event, x: localX, y: 0, height: 1 })
      return result ? { ...result, focus: true } : undefined
    }
    const suggestion = this.suggestionRows.find(entry => entry.row === event.y)
    if (suggestion !== undefined) {
      if (event.type === 'press') {
        // Every press starts a fresh gesture: clear any latched pressed
        // identity first (a rejected stale press must not leave an old
        // VALUE that a later synthetic click could match).
        this.mousePressedValue = undefined
        // Resolve the CURRENT cursor by the pressed VALUE (a completion
        // refresh between paint and press may have reordered the list
        // WITHOUT a repaint). No match => reject.
        const currentIndex = this.suggestions.findIndex(item => item.value === suggestion.value)
        if (currentIndex === -1) return undefined
        this.mousePressedValue = suggestion.value
        this.suggestionCursor = currentIndex
        return { handled: true, focus: true }
      }
      // click = Tab accept, but only the exact pressed identity (press A
      // → refresh → release must not accept whatever moved into the row).
      if (this.mousePressedValue !== suggestion.value) {
        this.mousePressedValue = undefined
        return undefined
      }
      this.mousePressedValue = undefined
      const currentIndex = this.suggestions.findIndex(item => item.value === suggestion.value)
      if (currentIndex === -1) return undefined
      this.suggestionCursor = currentIndex
      this.acceptSuggestion()
      return { handled: true }
    }
    return undefined
  }

  handleInput(data: string): void {
    if (data === '\u0000') return
    if (this.confirming) {
      // Collision confirmation: y/Enter replaces, n/Esc returns to the
      // directory selection (never cancels the whole command automatically).
      if (matchesKey(data, 'y') || componentKeymap.matches(data, 'question.confirm')) {
        const directory = this.selectedDirectory
        if (directory !== undefined) this.onDone({ kind: 'selected', directory, overwrite: true })
      } else if (matchesKey(data, 'n') || componentKeymap.matches(data, 'question.cancel')) {
        this.confirming = false
        this.input.focused = this._focused
        this.refreshSuggestions()
      }
      return
    }
    // Tab accepts the highlighted suggestion (the shared Input rejects Tab).
    if (matchesKey(data, 'tab')) {
      this.acceptSuggestion()
      return
    }
    // Up/Down move the suggestion selection when suggestions exist (the
    // shared Input has no Up/Down handling).
    if (componentKeymap.matches(data, 'question.cursorUp')) {
      this.moveSuggestion(-1)
      return
    }
    if (componentKeymap.matches(data, 'question.cursorDown')) {
      this.moveSuggestion(1)
      return
    }
    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() !== before) {
      this.validationError = undefined
      this.refreshSuggestions()
    }
  }

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
    this.lastRenderWidth = width
    this.directoryRow = -1
    this.suggestionRows = []
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    lines.push(color.textStrong(this.request.title))
    lines.push('')
    lines.push(`${color.textDim('File:')} ${this.request.filename}`)
    const inputLines = this.input.render(safeWidth)
    const inputLine = inputLines[0] ?? ''
    const stripped = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine
    this.directoryRow = lines.length
    lines.push(`${color.textDim('Directory:')} ${stripped}`)
    if (this.validationError !== undefined) {
      lines.push(color.textDim(` ${this.validationError}`))
    }
    if (this.confirming) {
      const target = this.selectedDirectory === undefined
        ? this.request.filename
        : `${this.selectedDirectory}${this.selectedDirectory.endsWith('/') || this.selectedDirectory.endsWith('\\') ? '' : '/'}${this.request.filename}`
      lines.push('')
      lines.push(color.textDim('File already exists:'))
      lines.push(color.textDim(` ${target}`))
      lines.push('')
      lines.push('Replace existing file?')
      lines.push(color.textDim('y yes · n no'))
      return lines
    }
    if (this.suggestions.length > 0) {
      lines.push('')
      const visible = this.suggestions.slice(0, VISIBLE_SUGGESTIONS)
      this.suggestionRows = []
      for (let i = 0; i < visible.length; i++) {
        const item = visible[i]
        if (item === undefined) continue
        const pointer = i === this.suggestionCursor ? color.primary('→') : ' '
        const label = i === this.suggestionCursor ? color.textStrong(item.label) : item.label
        this.suggestionRows.push({ row: lines.length, value: item.value })
        lines.push(`${pointer} ${label}`)
      }
      if (this.suggestions.length > VISIBLE_SUGGESTIONS) {
        lines.push(color.textDim(`  … ${this.suggestions.length - VISIBLE_SUGGESTIONS} more`))
      }
    }
    lines.push('')
    lines.push(color.textDim('tab complete · ↵ save · esc cancel'))
    return lines
  }

  /** Cancel the prompt (surface dispose / runner abort): settle cancelled
   * and fence every in-flight completion. */
  dispose(): void {
    if (this.settled) return
    this.settled = true
    this.completionAbort.abort()
    this.suggestions = []
  }
}
