/**
 * TSP I-C: the ONE mount-local slash-completion seat.
 *
 * It owns the SHORT-LIVED interaction state of the first logical line's leading
 * `/` command token: the candidate list one query settled, which row is
 * highlighted, the request that list belongs to, and the abort that retires it.
 * It owns NO catalog (the single commit point in `src/commands.ts` publishes
 * one), NO provider (the shared installed-provider factory composes it), NO
 * draft (the ONE `TspComposer` writes text and caret) and NO execution: accepting
 * a candidate only ever edits the composer, and a LATER separate Enter stays the
 * only gesture that reaches the existing submission path.
 *
 * Every asynchronous settlement and every accept gesture re-checks the whole
 * currentness set — the request identity, the catalog source revision, the live
 * document, the live UTF-16 caret and the mount's own admission — never the
 * abort signal alone, because an answer can arrive after the user typed on,
 * after a Session was published, or after a Picker took the keys. A settlement
 * or a click that no longer matches paints nothing, writes nothing and submits
 * nothing.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/slash-completion
 */

import type { AutocompleteItem, AutocompleteProvider } from '@xmoon76/pi-tui'
import type { Key } from '@stencil-hq/tern'
import type { TspComposer } from './editor.ts'

/**
 * The most candidate rows one paint shows; the rest stay in the list (§3.1
 * ceiling, Owner-ratified after the real-client measurement below).
 *
 * Measured on the pinned client: the space above the editor is ~146px at the
 * shortest supported matrix cell (900x360), while six rows plus the hint need
 * ~196px, so at THAT cell the popup scrolls and its last painted row is clipped.
 * The pinned Tern reports no pane rows/height (`Capabilities` carries `cols` and
 * `cell` only), so the window cannot shrink itself to the space that exists, and
 * estimating the client layout is forbidden. The Owner therefore kept the
 * six-row ceiling and accepted the short-pane clipping as a recorded known
 * limitation (with the two failing client assertions), not a reworded pass.
 */
export const SLASH_COMPLETION_MAX_ROWS = 6

/** One candidate row as the painter receives it. `id` is the row's identity
 *  inside its own list revision, so a click names the row that was painted and
 *  an old frame's row can never be mistaken for the current one. The
 *  `description` is the Provider's own composed text (its argument hint already
 *  rides it) — this layer never synthesizes a hint or an availability claim. */
export interface SlashCompletionRow {
  readonly id: string
  /** The command name WITH the leading slash (`/model`). */
  readonly name: string
  readonly description: string | undefined
  readonly highlighted: boolean
}

/** The render-time projection of the seat; `undefined` = paint no popup. The
 *  painter observes it and never re-reads, re-filters or re-sorts a catalog. */
export interface SlashCompletionPopup {
  readonly revision: number
  /** The painted window only; the rows beyond it stay reachable because the
   *  window walks with the highlighted row. */
  readonly rows: readonly SlashCompletionRow[]
}

export interface TspSlashCompletion {
  /** Replace the provider AND its catalog source (ONE catalog commit).
   *  `sourceFailed` is the command layer's FAILED-SOURCE state (a name
   *  collision withdrew every candidate while the Host claims stayed live): the
   *  seat then queries NOTHING AT ALL, so no plugin fallback can resurrect a
   *  menu whose command source is known-bad. */
  install(provider: AutocompleteProvider, sourceFailed?: boolean): void
  /** Re-derive the seat after an accepted composer edit. Never submits. */
  onComposerEdit(): void
  /** The Tab trigger. `true` = this seat owned the key (a query started). */
  requestTab(): boolean
  /** Handle one key the ladder reached this seat on. `true` = consumed here. */
  handleKey(key: Key): boolean
  /** Accept the highlighted candidate through the shared Provider and the ONE
   *  composer conditional write. Returns whether the gesture was CONSUMED as a
   *  completion. `false` — the only such case — means the token under the caret
   *  already names that candidate in full, so there was nothing to complete and
   *  the key stays the existing gesture it always was (Enter submits). A refused,
   *  out-of-token or no-op accept is still consumed: failing to complete must
   *  never turn into executing the draft.
   *  Never called for a key this seat did not own. */
  accept(): boolean
  /** Accept the row a click named, ONLY while that row is the current frame's. */
  acceptClick(id: string, revision: number): void
  /** The popup projection for this frame (`undefined` = nothing to paint).
   *  `maxRows` is the calling surface's own row budget: the styled shell paints
   *  the seat window, a pane without `el`+`styles` paints a smaller one — and in
   *  BOTH cases the window is the one that follows the highlighted row, so a
   *  candidate the user selected is never off-window. */
  renderState(maxRows?: number): SlashCompletionPopup | undefined
  /** Whether a popup currently owns this seat's keys. */
  isOpen(): boolean
  /**
   * End the browse and abort any in-flight request WITHOUT touching the draft,
   * the caret or a paste lease. Returns whether a popup actually went away, so
   * a caller that already renders never adds a second frame (the Permission
   * menu's close has the same shape).
   */
  retire(): boolean
}

export interface TspSlashCompletionPorts {
  /** The ONE mount composer: the only writer of text and caret. */
  readonly composer: TspComposer
  /** Whether the Composer may own the keys right now — the SAME live facts the
   *  composer seat itself is admitted by (no modal, no Reader, no Presenter,
   *  not hydrating, not disposed). A seat that is not admitted can neither keep
   *  a popup visible nor consume a key. */
  readonly admitted: () => boolean
  /** Commit one frame for a popup-only change (the composer's own `onChanged`
   *  already carries every text change, so this never doubles a render). */
  readonly requestRender: () => void
}

/** The document position one query is addressed to, in the Provider's own
 *  `(lines, cursorLine, cursorCol)` shape, with the UTF-16 caret kept beside it
 *  so an accept can re-check the EXACT document it was computed against. */
interface SeatDocument {
  readonly text: string
  readonly cursor: number
  readonly lines: readonly string[]
  readonly cursorLine: number
  readonly cursorCol: number
}

/** The in-flight request: its identity, the catalog revision it was issued
 *  against, and the abort it owns. */
interface PendingQuery {
  readonly sourceRevision: number
  readonly controller: AbortController
}

/** One settled list a frame may show. */
interface CandidateList {
  readonly revision: number
  readonly query: PendingQuery
  readonly items: readonly AutocompleteItem[]
  readonly prefix: string
  readonly document: SeatDocument
  selected: number
}

export function createTspSlashCompletion(
  ports: TspSlashCompletionPorts,
): TspSlashCompletion {
  let provider: AutocompleteProvider | undefined
  /** Whether the current source is a FAILED catalog synthesis (see `install`). */
  let sourceFailed = false
  /** Bumped by every catalog install: a newer commit makes an older request,
   *  an older list and an older painted row permanently unusable. */
  let sourceRevision = 0
  /** Bumped per settled list: the identity a click and a node key carry. */
  let listRevision = 0
  let pending: PendingQuery | undefined
  let list: CandidateList | undefined

  /** The leading-`/` command seat, decided EXACTLY as the shared Provider
   *  decides it: the FIRST logical line, the `trimStart()`ed text before the
   *  caret starting with `/` and carrying no space. An argument position, an
   *  inline `/skill`, an `@` mention, a shell line and ordinary prose are
   *  therefore never this seat, and the Provider stays the authority on what a
   *  query for a real seat returns (an unresolvable `/usr/lo` simply yields no
   *  candidates). */
  const inCommandSeat = (document: SeatDocument): boolean => {
    if (document.cursorLine !== 0) return false
    const before = (document.lines[0] ?? '').slice(0, document.cursorCol)
    const trimmed = before.trimStart()
    // The SAME whitespace rule the token bounds below use: ANY whitespace (not
    // just a literal space) ends the command token. A `/new\targument` draft is an
    // argument position, and a seat that only looked for ' ' would treat the
    // tab-separated tail as part of the command name — letting the plugin
    // fallback answer for, and a completion rewrite, a token this milestone
    // never completes.
    return trimmed.startsWith('/') && !/\s/.test(trimmed)
  }

  /** The composer document in the Provider's own (lines, cursorLine, cursorCol)
   *  shape. `cursorCol` is the caret's column INSIDE its line — the UTF-16
   *  offset the user is actually at, never that line's length: a query and the
   *  replacement it computes must describe the token under the caret, so a
   *  caret in the middle of `/new` with trailing text both sees the right prefix
   *  and preserves that tail. `SeatDocument.cursor` keeps the flat UTF-16 offset
   *  the live-document fence compares against. */
  /** The command token under the caret: from the first non-space at/behind the
   *  caret to the first whitespace after it, on the FIRST logical line only. */
  const commandToken = (document: SeatDocument): { start: number; end: number } | undefined => {
    if (document.cursorLine !== 0) return undefined
    const line = document.lines[0] ?? ''
    let start = document.cursorCol
    while (start > 0 && !/\s/.test(line.charAt(start - 1))) start -= 1
    let end = document.cursorCol
    while (end < line.length && !/\s/.test(line.charAt(end))) end += 1
    return { start, end }
  }

  const documentOf = (): SeatDocument => {
    const state = ports.composer.state()
    const lines = state.text.split('\n')
    const before = state.text.slice(0, state.cursor)
    const cursorLine = before.split('\n').length - 1
    return {
      text: state.text,
      cursor: state.cursor,
      lines,
      cursorLine,
      cursorCol: before.length - (before.lastIndexOf('\n') + 1),
    }
  }

  /** The seat's own state withdrawal: pure state, never a render, never a draft
   *  touch. The in-flight answer is aborted AND fenced by its identity, so a
   *  Provider that ignores its signal still cannot paint. Returns whether a
   *  popup existed (the caller needs a frame only then). */
  const withdraw = (): boolean => {
    const hadPopup = list !== undefined
    const inFlight = pending
    pending = undefined
    list = undefined
    inFlight?.controller.abort()
    return hadPopup
  }

  /** The live-document half of the fence (the draft and the caret the user is
   *  actually editing now, read SYNCHRONOUSLY — never from a kept snapshot). */
  const documentStillLive = (document: SeatDocument): boolean => {
    if (!ports.admitted()) return false
    const live = ports.composer.state()
    return live.text === document.text && live.cursor === document.cursor
  }

  const query = (): boolean => {
    const installed = provider
    if (installed === undefined || sourceFailed) {
      // No catalog source installed (yet, or anymore), or the source is a FAILED
      // synthesis: nothing to query, no application policy call, no plugin
      // fallback asked, no popup.
      withdraw()
      return false
    }
    const document = documentOf()
    if (!inCommandSeat(document)) {
      withdraw()
      return false
    }
    const controller = new AbortController()
    const request: PendingQuery = { sourceRevision, controller }
    // The previous answer is aborted AND unfenced before this one is issued, so
    // two in-flight queries can never both paint.
    withdraw()
    pending = request
    // `force:false` ALWAYS: the shared Provider's leading-command branch answers
    // a forced request with `null`, so a forced Tab would mean "never propose".
    // A Tab is a TRIGGER here, never a file-completion request.
    // The seat owns BOTH settlements below (fulfilment fences and paints,
    // rejection closes the browse), so nothing is discarded unhandled and no
    // second owner exists — the same shape as the mounted renderer's own loop.
    void installed.getSuggestions([...document.lines], document.cursorLine, document.cursorCol, { // allowlist: the seat's own two-branch settlement
      signal: controller.signal,
      force: false,
    }).then((result) => {
      // A newer request, a replaced catalog, a taken seat or a moved document:
      // this answer is dropped and the newer state keeps its own.
      if (pending !== request || request.sourceRevision !== sourceRevision
        || !documentStillLive(document)) {
        if (pending === request) pending = undefined
        return
      }
      if (result === null || result.items.length === 0) {
        // No candidates is a CLOSED seat, not an empty shell: no list, and no
        // extra frame for a popup that was never painted.
        pending = undefined
        list = undefined
        return
      }
      list = {
        revision: ++listRevision,
        query: request,
        items: result.items,
        prefix: result.prefix,
        document,
        selected: 0,
      }
      ports.requestRender()
    }, () => {
      // A rejected suggestion query is a failed source, never an empty one, and
      // never a message this seat invents: the popup stays closed and the draft
      // is untouched. The extension-health accounting happened once, in the
      // registry the command layer already wraps.
      if (pending === request) {
        pending = undefined
        list = undefined
      }
    })
    return true
  }

  const accept = (): boolean => {
    const shown = list
    const installed = provider
    const item = shown === undefined ? undefined : shown.items[shown.selected]
    // A stale list, a replaced catalog or a moved document accepts NOTHING.
    if (shown === undefined || installed === undefined || item === undefined
      || shown.query !== pending || shown.query.sourceRevision !== sourceRevision
      || !documentStillLive(shown.document)) {
      if (withdraw()) ports.requestRender()
      return false
    }
    const document = shown.document
    const applied = installed.applyCompletion(
      [...document.lines],
      document.cursorLine,
      document.cursorCol,
      item,
      shown.prefix,
    )
    const nextText = applied.lines.join('\n')
    const lineStart = applied.lines.slice(0, Math.max(0, applied.cursorLine))
      .reduce((length, line) => length + line.length + 1, 0)
    const nextCursor = lineStart + applied.cursorCol
    const token = commandToken(document)
    // The ONLY case that hands the key back to its existing owner: the WHOLE
    // token under the caret already names the highlighted candidate and the caret
    // sits at that token's end, so there is genuinely nothing left to complete
    // and Enter is the submit it has always been (type `/new`, press Enter, run
    // `/new`). Decided on the DOCUMENT alone, never on what the Provider chose to
    // return: in `/newbie` with the caret after `/new` the before-caret prefix
    // matches `/new` while the token does not, and the Provider's apply is a
    // no-op there — treating "wrote nothing" as "nothing to complete" would hand
    // that Enter to the submit path and execute a command the user never finished
    // typing.
    const tokenAlreadyComplete = token !== undefined
      && (document.lines[0] ?? '').slice(token.start, token.end) === `/${item.value}`
      && document.cursorCol === token.end
    if (tokenAlreadyComplete) {
      // Nothing is consumed and NOTHING is withdrawn here either: the Composer's
      // own frame for this key drops the list through the document fence, which
      // keeps the most common gesture at the frame count it had before this seat
      // existed.
      return false
    }
    // A completion may rewrite the COMMAND TOKEN and nothing else: the text
    // before the token (the indentation the user typed) and everything from the
    // token end onward (an argument, a tail, a following line) must survive
    // byte-for-byte. The shared provider is a plugin extension point and may
    // hand back an arbitrary `prefix`; whoever produced that answer must not be
    // able to move the `/`, eat the indentation or overwrite the tail, so an
    // out-of-token result is refused here rather than written and undone.
    const tokenOnlySpan = token !== undefined
      && nextText.startsWith(document.text.slice(0, token.start))
      && nextText.endsWith(document.text.slice(token.end))
      && nextCursor >= token.start
      && nextCursor <= nextText.length - (document.text.length - token.end)
    // The Provider handing the document back unchanged, or an answer whose
    // replacement reaches outside the token, writes nothing.
    const writes = tokenOnlySpan
      && (nextText !== document.text || nextCursor !== document.cursor)
    // The popup goes BEFORE the write, so the ONE frame the composer commits
    // already carries the finished text with no stale list beside it.
    const hadPopup = withdraw()
    // A `writes` plan is not a COMMITTED write: the composer still owns the
    // final say (a grapheme-boundary caret, a change confined to one logical
    // line), and a candidate value that breaks either — a plugin may hand back
    // any text at all — is refused there. `false` means no editor frame is
    // coming either, so the withdrawn popup would stay PAINTED while the seat
    // already considers itself closed, and the user's next Escape would hit
    // Cancel instead of dismissing a list they can still see. The frame is
    // owed on EVERY path that wrote nothing, and a successful write is never
    // double-rendered (the composer's own sink already committed that frame).
    const written = writes
      && ports.composer.applyCompletionEdit(
        { text: document.text, cursor: document.cursor },
        { text: nextText, cursor: nextCursor },
      )
    if (!written && hadPopup) ports.requestRender()
    // CONSUMED in every case except `tokenAlreadyComplete`. An accept gesture that
    // could not write must never degrade into executing the user's draft: the
    // list is gone and the NEXT Enter is the explicit submit.
    return true
  }

  const move = (step: 1 | -1): void => {
    const shown = list
    if (shown === undefined || shown.items.length === 0) return
    const total = shown.items.length
    shown.selected = (shown.selected + step + total) % total
    ports.requestRender()
  }

  /** The row identity: the Provider's own value at its own position, so two
   *  rows carrying the same text inside one list never share a click. */
  const rowId = (item: AutocompleteItem, index: number): string => `${index}:${item.value}`

  return {
    install: (installed, failedSource = false) => {
      // A catalog commit REPLACES the source: the previous list, every in-flight
      // answer and every painted row identity go with it, so a withdrawn command
      // can never stay in the menu or be accepted afterwards. The next edit (or
      // Tab) queries the new source.
      sourceRevision += 1
      provider = installed
      sourceFailed = failedSource
      if (withdraw()) ports.requestRender()
    },
    onComposerEdit: () => {
      query()
    },
    requestTab: () => query(),
    handleKey: (key) => {
      const shown = list
      const modified = key.ctrl === true || key.alt === true || key.meta === true
      if (shown === undefined) {
        // CLOSED: only an unmodified Tab inside this seat is a trigger. Every
        // other key keeps exactly the owner it has today — including I-B's ↑/↓
        // History, the submit gestures, cancel, paste and the edits.
        if (modified || key.name !== 'tab' || key.shift === true) return false
        return query()
      }
      // OPEN. A key this seat does not own ENDS the browse first and is then
      // delivered to its original owner, so a candidate list never swallows an
      // application gesture and never edits the draft twice.
      if (modified) {
        withdraw()
        return false
      }
      switch (key.name) {
        case 'up':
        case 'down': {
          // A modified arrow was already handled above; a Shift arrow is not a
          // browse gesture and belongs to its existing owner.
          if (key.shift === true) {
            withdraw()
            return false
          }
          move(key.name === 'up' ? -1 : 1)
          return true
        }
        case 'tab': {
          // Tab walks the list, Shift+Tab walks back. With ONE candidate there is
          // nowhere to walk, so the gesture accepts that one candidate — and
          // accepting is NEVER an execution. Tab is always the completion
          // gesture here (never a literal tab): unlike Enter it has no existing
          // submit meaning to preserve.
          if (shown.items.length > 1) move(key.shift === true ? -1 : 1)
          else accept()
          return true
        }
        case 'enter': {
          // A plain Enter ACCEPTS the highlighted candidate — it never executes
          // it. The one exception is the case where there is nothing left to
          // accept: the typed token already names that command exactly, so the
          // Enter the user has always pressed (type `/new`, press Enter, run it)
          // must stay the submit gesture it was. A modified Enter is not this
          // seat's business at all.
          if (key.shift === true) {
            withdraw()
            return false
          }
          // `false` here can ONLY mean "the token is already complete in full":
          // the Enter then goes to the Composer reducer and classifies/submits
          // exactly as it did before this seat existed. Every other outcome —
          // including a refused or no-op accept — is consumed here.
          return accept()
        }
        case 'escape': {
          // Close the popup; the draft and the caret stay untouched and the key
          // is consumed: an open candidate list never becomes a cancel intent.
          if (withdraw()) ports.requestRender()
          return true
        }
        default: {
          // A printable edit, a deletion or a caret move: the old snapshot is
          // retired and the SAME key then reaches the composer reducer exactly
          // once, after which the natural query re-derives the seat.
          withdraw()
          return false
        }
      }
    },
    accept,
    acceptClick: (id, revision) => {
      const shown = list
      // A click is admitted ONLY for the row of the frame that painted it, at
      // the revision that list carries. An old row, a superseded frame or a
      // list the mount can no longer show is a NO-OP — never a submit and never
      // a draft write (the accept itself re-checks the live document).
      if (shown === undefined || shown.revision !== revision) return
      const index = shown.items.findIndex((item, itemIndex) => rowId(item, itemIndex) === id)
      if (index < 0) return
      shown.selected = index
      if (accept()) return
      // The click had nothing to complete (the token already names that
      // candidate). For a KEY that is the right answer — the gesture stays what
      // it always was — but a pointer press has no second half to come, so the
      // list it dismissed must actually go away instead of looking inert.
      if (withdraw()) ports.requestRender()
    },
    renderState: (maxRows = SLASH_COMPLETION_MAX_ROWS) => {
      const shown = list
      if (shown === undefined || shown.items.length === 0) return undefined
      // A popup the mount can no longer show is withdrawn AT THE PAINT, so a
      // composer that lost the keys never keeps a clickable frame.
      if (shown.query !== pending || shown.query.sourceRevision !== sourceRevision
        || !documentStillLive(shown.document)) {
        withdraw()
        return undefined
      }
      const total = shown.items.length
      // The window walks with the highlighted row; the ORDER stays exactly the
      // Provider's (never re-sorted here) and the default highlight is the first
      // candidate.
      const budget = Math.max(1, maxRows)
      const start = Math.min(
        Math.max(0, shown.selected - budget + 1),
        Math.max(0, total - budget),
      )
      const end = Math.min(total, start + budget)
      const rows: SlashCompletionRow[] = []
      for (let index = start; index < end; index += 1) {
        const item = shown.items[index]!
        rows.push({
          id: rowId(item, index),
          name: `/${item.value}`,
          description: item.description,
          highlighted: index === shown.selected,
        })
      }
      return { revision: shown.revision, rows }
    },
    isOpen: () => list !== undefined && list.items.length > 0,
    retire: () => withdraw(),
  }
}
