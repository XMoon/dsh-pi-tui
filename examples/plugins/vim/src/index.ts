/**
 * The VIM example plugin (Phase 5, plan §3/§4): a production-class modal
 * editor prototype built on the ADVANCED editor SDK — the first real
 * consumer proving the tier selection. The plugin owns the modal state
 * machine (insert/normal), the buffer and the undo/redo stack; the Host
 * owns the seat, submission/session safety and the terminal protocol.
 *
 * Tier usage (plan §3):
 * - Advanced: editor state, semantic input (EditorInputEvent), focus,
 *   editor actions (host.dispatch), the rendered buffer;
 * - the plugin NEVER parses raw terminal bytes (the Host decodes
 *   legacy/CSI-u/modifyOtherKeys into semantic events);
 * - no Unstable usage: the semantic Advanced surface is sufficient for
 *   this prototype (plan §5 — do not use Unstable to show it off).
 *
 * This plugin consumes ONLY the public package exports — exactly like an
 * external package (the examples smoke gates it against the packed
 * tarball).
 * @module dsh-pi-example-vim
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type EditorHost,
  type EditorInputEvent,
  type ExtensionEditor,
  type ExtensionView,
  type NormalizedKey,
  type PiTuiExtensionService,
} from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'dsh-pi-example-vim'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

/** The modal state machine (plan §4: insert/normal; visual deferred). */
type VimMode = 'normal' | 'insert'

/** One undo/redo snapshot (the whole buffer + cursor — simple and safe). */
interface VimSnapshot {
  readonly lines: readonly string[]
  readonly cursorLine: number
  readonly cursorCol: number
}

/** The plugin's editor state (owned by the plugin, never the Host). */
class VimState {
  lines: string[] = ['']
  cursorLine = 0
  cursorCol = 0
  mode: VimMode = 'normal'
  private undoStack: VimSnapshot[] = []
  private redoStack: VimSnapshot[] = []
  private yank: string | undefined

  /** The flat cursor offset (the seat's shape — line lengths + col). */
  flatCursor(): number {
    let offset = 0
    for (let line = 0; line < this.cursorLine && line < this.lines.length; line++) {
      offset += this.lines[line]!.length + 1
    }
    return offset + this.cursorCol
  }

  /** Set the cursor from a flat offset (clamped to the buffer). */
  setFlatCursor(offset: number): void {
    let remaining = Math.max(0, Math.min(offset, this.lines.join('\n').length))
    let line = 0
    while (line < this.lines.length - 1 && remaining > this.lines[line]!.length) {
      remaining -= this.lines[line]!.length + 1
      line += 1
    }
    this.cursorLine = line
    this.cursorCol = Math.max(0, Math.min(remaining, this.lines[line]!.length))
  }

  /** Open a new line below the cursor and enter insert mode (o — an
   * undoable mutation, round-1 finding). */
  openLineBelow(): void {
    this.pushUndo()
    this.lines.splice(this.cursorLine + 1, 0, '')
    this.cursorLine += 1
    this.cursorCol = 0
  }

  /** Push an undo snapshot (clears the redo stack). */
  private pushUndo(): void {
    this.undoStack.push(this.snapshot())
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack = []
  }

  private snapshot(): VimSnapshot {
    return { lines: [...this.lines], cursorLine: this.cursorLine, cursorCol: this.cursorCol }
  }

  /** The current line's text. */
  currentLine(): string {
    return this.lines[this.cursorLine] ?? ''
  }

  /** Insert text at the cursor (the shared insert path for typing/paste). */
  insertText(text: string): void {
    this.pushUndo()
    const line = this.currentLine()
    this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + text + line.slice(this.cursorCol)
    this.cursorCol += text.length
  }

  /** Insert a newline at the cursor (Enter in insert mode). */
  insertNewline(): void {
    this.pushUndo()
    const line = this.currentLine()
    const before = line.slice(0, this.cursorCol)
    const after = line.slice(this.cursorCol)
    this.lines[this.cursorLine] = before
    this.lines.splice(this.cursorLine + 1, 0, after)
    this.cursorLine += 1
    this.cursorCol = 0
  }

  /** Delete the character before the cursor (backspace). */
  deleteBefore(): void {
    if (this.cursorCol > 0) {
      this.pushUndo()
      const line = this.currentLine()
      this.lines[this.cursorLine] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol)
      this.cursorCol -= 1
    } else if (this.cursorLine > 0) {
      this.pushUndo()
      const previous = this.lines[this.cursorLine - 1] ?? ''
      const line = this.currentLine()
      this.cursorCol = previous.length
      this.lines.splice(this.cursorLine, 1)
      this.lines[this.cursorLine - 1] = previous + line
      this.cursorLine -= 1
    }
  }

  /** Delete the character AT the cursor (x in normal mode). */
  deleteAt(): void {
    const line = this.currentLine()
    if (this.cursorCol < line.length) {
      this.pushUndo()
      this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1)
      // Clamp the cursor to the shortened line's LAST char (deleting the
      // last char must not leave the cursor past the end — a cursor at
      // `length` is a valid insert position but x there is a no-op).
      this.cursorCol = Math.min(this.cursorCol, Math.max(0, this.currentLine().length - 1))
    } else if (this.cursorLine < this.lines.length - 1) {
      this.pushUndo()
      this.lines.splice(this.cursorLine, 1)
    }
  }

  /** Delete the current line (dd in normal mode). */
  deleteLine(): void {
    this.pushUndo()
    this.yank = this.currentLine()
    if (this.lines.length === 1) {
      this.lines = ['']
      this.cursorLine = 0
      this.cursorCol = 0
      return
    }
    this.lines.splice(this.cursorLine, 1)
    if (this.cursorLine >= this.lines.length) this.cursorLine = this.lines.length - 1
    this.cursorCol = Math.min(this.cursorCol, this.currentLine().length)
  }

  /** Undo (u in normal mode). */
  undo(): void {
    const snapshot = this.undoStack.pop()
    if (snapshot === undefined) return
    this.redoStack.push(this.snapshot())
    this.lines = [...snapshot.lines]
    this.cursorLine = snapshot.cursorLine
    this.cursorCol = snapshot.cursorCol
  }

  /** Redo (Ctrl+R in normal mode). */
  redo(): void {
    const snapshot = this.redoStack.pop()
    if (snapshot === undefined) return
    this.undoStack.push(this.snapshot())
    this.lines = [...snapshot.lines]
    this.cursorLine = snapshot.cursorLine
    this.cursorCol = snapshot.cursorCol
  }

  /** Yank the current line (yy in normal mode). */
  yankLine(): void {
    this.yank = this.currentLine()
  }

  /** Paste the yank buffer after the cursor (p in normal mode). */
  pasteAfter(): void {
    if (this.yank === undefined) return
    this.pushUndo()
    const line = this.currentLine()
    this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + this.yank + line.slice(this.cursorCol)
    this.cursorCol += this.yank.length
  }

  /** Move the cursor (clamped). Normal-mode movement stops at the LAST
   * char of a line (col length-1) — a cursor at `length` is a valid
   * insert position but l/x there would be no-ops (round-1 finding). */
  move(deltaLine: number, deltaCol: number): void {
    this.cursorLine = Math.max(0, Math.min(this.lines.length - 1, this.cursorLine + deltaLine))
    this.cursorCol = Math.max(0, Math.min(Math.max(0, this.currentLine().length - 1), this.cursorCol + deltaCol))
  }

  /** Move to the next/previous word START (w/b in normal mode — vim
   * semantics: w lands on the next word's first char, b on the previous
   * word's first char). */
  moveWord(forward: boolean): void {
    const line = this.currentLine()
    if (forward) {
      // Skip the current word, then any whitespace → the next word start.
      // When the word ends AT the line end, advance to the next line
      // (round-1 finding: w from the last word of a line must not leave
      // the cursor past the end).
      const rest = line.slice(this.cursorCol)
      const word = /^\S*/.exec(rest)?.[0] ?? ''
      const whitespace = /^\s*/.exec(rest.slice(word.length))?.[0] ?? ''
      if (word.length + whitespace.length > 0 && this.cursorCol + word.length + whitespace.length < line.length) {
        this.cursorCol += word.length + whitespace.length
      } else if (this.cursorLine < this.lines.length - 1) {
        this.cursorLine += 1
        this.cursorCol = 0
      }
    } else {
      // Skip whitespace before the cursor, then the previous word → its
      // first char. From the start of a line, land on the previous line's
      // LAST word start (vim b semantics).
      const before = line.slice(0, this.cursorCol)
      const whitespace = /^\s*$/.exec(before)?.[0] ?? ''
      const word = /(\S+)\s*$/.exec(before)?.[1] ?? ''
      if (word.length + whitespace.length > 0) {
        this.cursorCol -= word.length + whitespace.length
      } else if (this.cursorLine > 0) {
        this.cursorLine -= 1
        const previous = this.currentLine()
        const previousWord = /(\S+)\s*$/.exec(previous)?.[1] ?? ''
        this.cursorCol = Math.max(0, previous.length - previousWord.length)
      }
    }
  }

  /** Move to the line start/end (0/$ in normal mode). */
  moveLineStart(): void {
    this.cursorCol = 0
  }

  moveLineEnd(): void {
    // vim semantics: $ lands on the LAST character (col length-1) — a
    // cursor at `length` is a valid INSERT position but x at that
    // position would be a no-op.
    this.cursorCol = Math.max(0, this.currentLine().length - 1)
  }
}

/** The rendered buffer (the plugin's view of its state). */
function renderBuffer(state: VimState): ExtensionView {
  const rows = state.lines.map((line, index) => ({
    kind: 'text' as const,
    spans: [
      // The cursor line is marked (the ExtensionView kit has no cursor
      // concept — the marker is the plugin's own rendering choice).
      ...(index === state.cursorLine
        ? [{ text: `> ${line}`, tone: 'accent' as const, emphasis: 'normal' as const }]
        : [{ text: `  ${line}`, tone: 'text' as const, emphasis: 'normal' as const }]),
    ],
  }))
  return {
    kind: 'rows',
    rows: [
      { kind: 'text', spans: [{ text: `-- ${state.mode.toUpperCase()} --`, tone: 'textDim' }] },
      ...rows,
    ],
  }
}

/** The vim editor contribution (single-winner via the Stable editor SDK). */
function createVimEditor(host: EditorHost): ExtensionEditor {
  const state = new VimState()
  // The initial draft (the seat transfers the host draft at handoff).
  const initial = host.getSnapshot().text
  if (initial !== '') {
    state.lines = initial.split('\n')
    state.cursorLine = 0
    state.cursorCol = 0
  }
  const editor: ExtensionEditor = {
    // A GETTER: the seat recompiles editor.component on every
    // host.invalidate() — the getter returns the CURRENT buffer view, so
    // a live repaint never needs to mutate a readonly-typed object (the
    // Phase-5 API-gap note: ExtensionEditor.component is readonly, and
    // the getter pattern is the clean live-repaint path).
    get component() { return renderBuffer(state) },
    getText: () => state.lines.join('\n'),
    setText: (text) => {
      state.lines = text === '' ? [''] : text.split('\n')
      state.cursorLine = 0
      state.cursorCol = 0
    },
    getCursor: () => state.flatCursor(),
    setCursor: (offset) => state.setFlatCursor(offset),
    get focused() { return true },
    // The mode-tinted border (normal = default, insert = accent).
    borderColor: (text) => text,
    handleInput: (event) => handleVimInput(event, state, host, editor),
    dispose: () => {},
  }
  return editor
}

/** The modal input state machine (semantic events only — never raw bytes). */
function handleVimInput(
  event: EditorInputEvent,
  state: VimState,
  host: EditorHost,
  editor: ExtensionEditor,
): boolean {
  if (event.kind === 'paste') {
    if (state.mode === 'insert') {
      state.insertText(event.text)
      host.invalidate()
    }
    return true
  }
  if (event.kind === 'text') {
    if (state.mode === 'insert') {
      state.insertText(event.text)
      host.invalidate()
    }
    return true
  }
  const key = event.key
  if (state.mode === 'insert') {
    if (isKey(key, 'escape')) {
      state.mode = 'normal'
      state.cursorCol = Math.max(0, state.cursorCol - 1)
      host.invalidate()
      return true
    }
    if (isKey(key, 'enter')) {
      state.insertNewline()
      host.invalidate()
      return true
    }
    if (isKey(key, 'backspace')) {
      state.deleteBefore()
      host.invalidate()
      return true
    }
    if (isKey(key, 'left')) {
      if (state.cursorCol > 0) state.cursorCol -= 1
      else if (state.cursorLine > 0) { state.cursorLine -= 1; state.cursorCol = state.currentLine().length }
      return true
    }
    if (isKey(key, 'right')) {
      if (state.cursorCol < state.currentLine().length) state.cursorCol += 1
      else if (state.cursorLine < state.lines.length - 1) { state.cursorLine += 1; state.cursorCol = 0 }
      return true
    }
    if (isKey(key, 'up')) {
      if (state.cursorLine > 0) state.cursorLine -= 1
      state.cursorCol = Math.min(state.cursorCol, state.currentLine().length)
      return true
    }
    if (isKey(key, 'down')) {
      if (state.cursorLine < state.lines.length - 1) state.cursorLine += 1
      state.cursorCol = Math.min(state.cursorCol, state.currentLine().length)
      return true
    }
    return true
  }
  // Normal mode.
  if (isKey(key, 'escape')) return true
  if (isKey(key, 'enter')) {
    // Submit integration (plan §4): Enter in normal mode dispatches the
    // host-owned submit action — the Host executes submission/session
    // safety, never the plugin.
    host.dispatch('submit')
    return true
  }
  if (isKey(key, 'h')) { state.move(0, -1); return true }
  if (isKey(key, 'l')) { state.move(0, 1); return true }
  if (isKey(key, 'j')) { state.move(1, 0); return true }
  if (isKey(key, 'k')) { state.move(-1, 0); return true }
  if (isKey(key, 'w')) { state.moveWord(true); return true }
  if (isKey(key, 'b')) { state.moveWord(false); return true }
  if (isKey(key, '0')) { state.moveLineStart(); return true }
  if (isKey(key, '$')) { state.moveLineEnd(); return true }
  if (isKey(key, 'x')) { state.deleteAt(); host.invalidate(); return true }
  if (isKey(key, 'd')) { state.deleteLine(); host.invalidate(); return true }
  if (isKey(key, 'u')) { state.undo(); host.invalidate(); return true }
  // Ctrl+R redo (isKey requires no modifiers — check the ctrl flag
  // directly).
  if (key.key === 'r' && key.ctrl) { state.redo(); host.invalidate(); return true }
  if (isKey(key, 'y')) { state.yankLine(); return true }
  if (isKey(key, 'p')) { state.pasteAfter(); host.invalidate(); return true }
  if (isKey(key, 'i')) { state.mode = 'insert'; return true }
  if (isKey(key, 'a')) { state.mode = 'insert'; state.cursorCol = Math.min(state.cursorCol + 1, state.currentLine().length); return true }
  if (isKey(key, 'o')) {
    // o opens a new line below — an undoable mutation (round-1 finding).
    state.openLineBelow()
    state.mode = 'insert'
    host.invalidate()
    return true
  }
  // c (change): delete the char at the cursor and enter insert mode (the
  // DoD's x/d/c — round-1 finding).
  if (isKey(key, 'c')) {
    state.deleteAt()
    state.mode = 'insert'
    host.invalidate()
    return true
  }
  return true
}

/** Whether a normalized key matches a plain key name (no modifiers). */
function isKey(key: NormalizedKey, name: string): boolean {
  return key.key === name && !key.ctrl && !key.alt && !key.shift && !key.super
}

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return
  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('slot.chrome.header.badge')) return
  service.registerEditor({
    id: 'example-vim',
    priority: 1,
    description: 'The Phase-5 vim modal editor example (Advanced editor SDK).',
    create: (host) => createVimEditor(host),
  })
}
