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
 * @module @xmoon76/dsh-pi-tui/tui/interaction/save-location
 */

import {
  Input,
  dispatchMouseEvent,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { Frame } from '../components/frame.ts'
import { componentKeymap } from '../keybindings/component-keymap.ts'
import { ACTION_BAR_SEPARATOR } from '../presentation/action-bar.ts'
import { color } from '../theme/runtime.ts'
import type { DirectoryCompletionCandidate } from '../../client/file-completion/directory-completion.ts'

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
  /** Directory completion (abortable; late results after close are fenced).
   * The Client-local capability returns the bare display path; THIS component
   * owns the directory marker it renders. */
  complete(raw: string, signal: AbortSignal): Promise<DirectoryCompletionCandidate[] | null>
}

/** How many suggestion rows are rendered (the rest are summarized). */
const VISIBLE_SUGGESTIONS = 8

/** One clickable verb of the prompt's final action row. */
type SaveAction = 'save' | 'dismiss-suggestions' | 'cancel' | 'yes' | 'no'

/** One complete painted action segment of the LAST render. */
interface SaveActionHit {
  readonly action: SaveAction
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

/** One action-row segment before the current width decides which survive. */
interface SaveActionSegment {
  readonly action: SaveAction
  readonly text: string
}

/**
 * The press-time identity of one action gesture. The click may only run the
 * EXACT action segment painted in the SAME semantic frame: a repaint that
 * moved another verb onto the cell, a resize, a suggestion refresh or any
 * keyboard/wheel change must never hand the press to a different action.
 */
interface ArmedSaveAction extends SaveActionHit {
  readonly width: number
  readonly height: number
  readonly revision: number
  readonly confirming: boolean
  readonly suggestions: number
}

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
  private suggestions: DirectoryCompletionCandidate[] = []
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
  /** Render height from the last paint (stale-geometry guard). */
  private lastRenderHeight = 0
  /** Painted action segments of the LAST render (the only pointer grant). */
  private actionHits: SaveActionHit[] = []
  /** The arm-time identity of the pressed action (undefined = none). */
  private armedAction: ArmedSaveAction | undefined
  /** Local monotonic semantic generation: a press only belongs to the frame
   *  meaning it was armed in. It is NOT a second transaction authority — the
   *  prompt's business state stays `selectedDirectory`/`confirming`/`settled`. */
  private revision = 0
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
      this.armedAction = undefined
      this.mousePressedValue = undefined
      this.actionHits = []
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
  getSuggestions(): readonly DirectoryCompletionCandidate[] {
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

  /**
   * A semantic change of what the painted prompt MEANS: every press-time
   * identity and the previous frame's action hit map die with it (the next
   * render publishes the new one). The prompt's business state is untouched;
   * this only makes a pre-change press unable to complete after the change.
   */
  private markSemanticChange(): void {
    this.revision += 1
    this.actionHits = []
    this.armedAction = undefined
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
    // The visible action row changes with the suggestions (Dismiss ⇄ Cancel).
    this.markSemanticChange()
    // The completion refresh is a component-internal async UI refresh — a
    // rejection degrades to no suggestions and the result is fenced by the
    // generation latch (never a bare fire-and-forget task).
    void this.deps.complete(raw, this.completionAbort.signal) // allowlist: completion refresh degrades to no suggestions (generation-fenced)
      .catch(() => null)
      .then((items) => {
        if (this.settled || generation !== this.completionGeneration) return
        this.suggestions = items ?? []
        this.suggestionCursor = 0
        // A settled suggestion list is a NEW painted meaning: a press made
        // against the previous list can never accept/act on this one.
        this.markSemanticChange()
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
    this.markSemanticChange()
  }

  /** Enter: validate the typed directory, then handle a target collision. */
  private confirmDirectory(): void {
    const directory = this.deps.resolveDirectory(this.input.getValue())
    if (!this.deps.isDirectory(directory)) {
      this.validationError = 'directory does not exist or is not a directory'
      this.markSemanticChange()
      return
    }
    this.validationError = undefined
    this.selectedDirectory = directory
    if (this.deps.targetExists(directory, this.request.filename)) {
      this.confirming = true
      this.suggestions = []
      this.input.focused = false
      this.markSemanticChange()
      return
    }
    this.markSemanticChange()
    this.onDone({ kind: 'selected', directory, overwrite: false })
  }

  /** Esc: close the suggestions first; otherwise cancel the prompt. */
  private handleEscape(): void {
    if (this.suggestions.length > 0) {
      this.suggestions = []
      this.suggestionCursor = 0
      this.markSemanticChange()
      return
    }
    this.markSemanticChange()
    this.onDone({ kind: 'cancelled' })
  }

  /**
   * Mouse parity (same capability audit as QuestionFlow/History private
   * Inputs): the Directory row click-positions the private Input; a
   * suggestion row press selects (resolved by stable VALUE, so an async
   * completion refresh between paint and press cannot select a different
   * row) and a click accepts it (the Tab semantic). The painted action row's
   * complete `Verb [Key]` segments are clickable; every other row stays inert.
   * A press only ARMS the segment — the click must re-prove the same complete
   * target (action, cells, frame geometry and semantic revision) before the
   * existing keyboard sink runs.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.settled) {
      this.armedAction = undefined
      this.mousePressedValue = undefined
      this.actionHits = []
      return undefined
    }
    // Every press starts a fresh gesture: a stale armed action or pressed
    // suggestion identity can never be revived by this gesture's click.
    if (event.type === 'press') {
      this.armedAction = undefined
      this.mousePressedValue = undefined
    }
    // A click consumes both press-time identities, even when its geometry or
    // target no longer matches (nothing may survive into a later gesture).
    const pressedValue = this.mousePressedValue
    const armed = this.armedAction
    if (event.type === 'click') {
      this.mousePressedValue = undefined
      this.armedAction = undefined
    }
    // The hit maps are only valid for the exact frame they were painted for.
    if (event.width !== this.lastRenderWidth || event.height !== this.lastRenderHeight) return undefined
    // Wheel is normalized by the TUI with button "none" (never "left"):
    // it must be handled BEFORE the left-button gate, or a real wheel
    // over a suggestion never reaches moveSuggestion. Any wheel revokes a
    // pending button/suggestion press, even when it scrolls nothing.
    if (event.type === 'wheel') {
      if (!event.wheelDelta) return undefined
      this.armedAction = undefined
      this.mousePressedValue = undefined
      const suggestion = this.suggestionRows.find(entry => entry.row === event.y)
      if (!suggestion) return undefined
      this.moveSuggestion(event.wheelDelta < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) {
      return undefined
    }
    // A painted action segment is recognized BEFORE the directory and
    // suggestion rows: a button must never be swallowed by an Input/row hit.
    const actionHit = this.actionHits.find(hit =>
      hit.row === event.y && event.x >= hit.startCol && event.x < hit.endCol)
    if (event.type === 'press') {
      if (actionHit !== undefined) {
        this.armedAction = {
          ...actionHit,
          width: event.width,
          height: event.height,
          revision: this.revision,
          confirming: this.confirming,
          suggestions: this.suggestions.length,
        }
        return { handled: true }
      }
      // A press on the action row between its complete segments is inert (the
      // latches were released at handler entry).
      if (this.actionHits.some(hit => hit.row === event.y)) return undefined
    } else if (armed !== undefined) {
      // Click: only the EXACT armed target of the SAME semantic frame runs.
      if (actionHit === undefined) return undefined
      if (armed.action !== actionHit.action
        || armed.row !== actionHit.row
        || armed.startCol !== actionHit.startCol
        || armed.endCol !== actionHit.endCol
        || armed.width !== event.width
        || armed.height !== event.height
        || armed.revision !== this.revision
        || armed.confirming !== this.confirming
        || armed.suggestions !== this.suggestions.length) return undefined
      this.runAction(actionHit.action)
      return { handled: true }
    }
    // Collision confirmation is a modal state (y/Enter replaces, n/Esc
    // returns): the directory/suggestion rows are inert while it shows.
    if (this.confirming) return undefined
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
      if (pressedValue !== suggestion.value) {
        // A mismatch (or a click without a fresh press) is rejected; the
        // identity was already released at handler entry.
        return undefined
      }
      const currentIndex = this.suggestions.findIndex(item => item.value === suggestion.value)
      if (currentIndex === -1) return undefined
      this.suggestionCursor = currentIndex
      this.acceptSuggestion()
      return { handled: true }
    }
    return undefined
  }

  /** Run one proven action gesture through the EXISTING keyboard sinks: the
   *  mouse never re-implements the directory validation, collision ladder or
   *  settle ordering. */
  private runAction(action: SaveAction): void {
    switch (action) {
      case 'save': this.confirmDirectory(); return
      case 'dismiss-suggestions': this.handleEscape(); return
      case 'cancel': this.handleEscape(); return
      case 'yes': this.handleInput('y'); return
      case 'no': this.handleInput('n'); return
    }
  }

  handleInput(data: string): void {
    if (data === '\u0000') return
    // Every real key starts a new semantic frame: a pending action press can
    // never complete against the state this key changes (or re-affirms).
    this.markSemanticChange()
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
    // A repaint invalidates the PREVIOUS frame's hit map only; the prompt's
    // business state and every pending settle gate stay untouched.
    this.actionHits = []
    this.armedAction = undefined
    this.input.invalidate()
  }

  render(width: number): string[] {
    this.lastRenderWidth = width
    this.directoryRow = -1
    this.suggestionRows = []
    this.actionHits = []
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
    } else if (this.suggestions.length > 0) {
      lines.push('')
      const visible = this.suggestions.slice(0, VISIBLE_SUGGESTIONS)
      this.suggestionRows = []
      for (let i = 0; i < visible.length; i++) {
        const item = visible[i]
        if (item === undefined) continue
        const pointer = i === this.suggestionCursor ? color.primary('→') : ' '
        // The directory marker is TUI presentation: the Client capability
        // reports the bare path, this component renders the trailing `/` that
        // tells the user the row continues into a directory.
        const directoryLabel = `${item.displayPath}/`
        const label = i === this.suggestionCursor ? color.textStrong(directoryLabel) : directoryLabel
        this.suggestionRows.push({ row: lines.length, value: item.value })
        lines.push(`${pointer} ${label}`)
      }
      if (this.suggestions.length > VISIBLE_SUGGESTIONS) {
        lines.push(color.textDim(`  … ${this.suggestions.length - VISIBLE_SUGGESTIONS} more`))
      }
    }
    lines.push('')
    const actions = this.buildActionRow(lines.length, safeWidth)
    this.actionHits = actions.hits
    lines.push(actions.line)
    this.lastRenderHeight = lines.length
    return lines
  }

  /** The actions the CURRENT prompt state may paint: the forward verb first,
   *  the safe exit last. The state alone decides the wording — never ANSI. */
  private actionRowSegments(): readonly SaveActionSegment[] {
    if (this.confirming) {
      return [
        { action: 'yes', text: 'Yes [Y]' },
        { action: 'no', text: 'No [N]' },
      ]
    }
    if (this.suggestions.length > 0) {
      return [
        { action: 'save', text: 'Save [Enter]' },
        { action: 'dismiss-suggestions', text: 'Dismiss suggestions [Esc]' },
      ]
    }
    return [
      { action: 'save', text: 'Save [Enter]' },
      { action: 'cancel', text: 'Cancel [Esc]' },
    ]
  }

  /** Pack the richest action row that fits WHOLE: the complete row first, then
   *  the safe exit alone. A verb is never painted as half a word and a dropped
   *  segment publishes no hit target; the keyboard ladder always remains. */
  private buildActionRow(row: number, width: number): {
    readonly line: string
    readonly hits: SaveActionHit[]
  } {
    const candidates = this.actionRowSegments()
    for (let keepFrom = 0; keepFrom < candidates.length; keepFrom += 1) {
      const kept = candidates.slice(keepFrom)
      const text = kept.map(segment => segment.text).join(ACTION_BAR_SEPARATOR)
      if (visibleWidth(text) > width) continue
      const hits: SaveActionHit[] = []
      let column = 0
      for (const [index, segment] of kept.entries()) {
        if (index > 0) column += visibleWidth(ACTION_BAR_SEPARATOR)
        const startCol = column
        const endCol = startCol + visibleWidth(segment.text)
        hits.push({ action: segment.action, row, startCol, endCol })
        column = endCol
      }
      // Role 14 affordances: the clickable verbs use the action ink while the
      // inert separators stay in the muted hint role.
      const line = kept.map(segment => color.primary(segment.text)).join(color.textMuted(ACTION_BAR_SEPARATOR))
      return { line, hits }
    }
    return { line: '', hits: [] }
  }

  /** Cancel the prompt (surface dispose / runner abort): settle cancelled
   * and fence every in-flight completion. */
  dispose(): void {
    if (this.settled) return
    this.settled = true
    this.completionAbort.abort()
    this.suggestions = []
    this.actionHits = []
    this.armedAction = undefined
    this.mousePressedValue = undefined
  }
}

/**
 * Frame for the Save Location prompt in the EDITOR SEAT: forwards focus to
 * the prompt so its directory Input keeps the hardware cursor (a plain Frame
 * would swallow the focus flag — the same contract as QuestionFrame).
 */
export class SaveLocationFrame extends Frame implements Focusable {
  private readonly prompt: SaveLocationPrompt

  constructor(prompt: SaveLocationPrompt) {
    super(prompt, true)
    this.prompt = prompt
  }

  get focused(): boolean {
    return this.prompt.focused
  }

  set focused(value: boolean) {
    this.prompt.focused = value
  }
}
