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

/** The most candidate rows one paint shows; the rest stay in the list. */
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
  readonly rows: readonly SlashCompletionRow[]
  /** Candidates the window does not show — a truthful overflow count. */
  readonly hidden: number
}

export interface TspSlashCompletion {
  /** Replace the provider AND its catalog source (ONE catalog commit). */
  install(provider: AutocompleteProvider): void
  /** Re-derive the seat after an accepted composer edit. Never submits. */
  onComposerEdit(): void
  /** The Tab trigger. `true` = this seat owned the key (a query started). */
  requestTab(): boolean
  /** Handle one key the ladder reached this seat on. `true` = consumed here. */
  handleKey(key: Key): boolean
  /** Accept the highlighted candidate through the shared Provider and the ONE
   *  composer conditional write. Returns whether a completion was actually
   *  WRITTEN: `false` means there was nothing left to accept (the token already
   *  names that command, the provider handed the document back, or the fence
   *  refused), and the caller then leaves the key with its existing owner.
   *  Never called for a key this seat did not own. */
  accept(): boolean
  /** Accept the row a click named, ONLY while that row is the current frame's. */
  acceptClick(id: string, revision: number): void
  /** The popup projection for this frame (`undefined` = nothing to paint). */
  renderState(): SlashCompletionPopup | undefined
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
    return trimmed.startsWith('/') && !trimmed.includes(' ')
  }

  const documentOf = (): SeatDocument => {
    const state = ports.composer.state()
    const lines = state.text.split('\n')
    const cursorLine = state.text.slice(0, state.cursor).split('\n').length - 1
    return {
      text: state.text,
      cursor: state.cursor,
      lines,
      cursorLine,
      cursorCol: (lines[cursorLine] ?? '').length,
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
    if (installed === undefined) {
      // No catalog source installed (yet, or anymore): nothing to query, no
      // application policy call, no popup.
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
    void installed.getSuggestions([...document.lines], document.cursorLine, document.cursorCol, {
      signal: controller.signal,
      force: false,
    }).then((result) => { // allowlist: the seat's own suggestion settlement — every branch settles the state
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
    // The Provider's own `prefix` naming the candidate exactly is the "already
    // complete" fact. A byte compare cannot see it: the command-name rule ALWAYS
    // appends one separator space, so a fully typed `/new` still differs from
    // what the Provider hands back by that one space. A gesture with nothing
    // left to complete must not be swallowed — for Enter that is the plain
    // submit that ran `/new` before this seat existed.
    const alreadyComplete = `/${item.value}` === shown.prefix
    if (alreadyComplete) {
      // Nothing to complete, so nothing is consumed and NOTHING is withdrawn
      // here either: the Composer's own frame for this key drops the list
      // through the document fence, which keeps the most common gesture
      // (type a whole command, press Enter) at the frame count it had before
      // this seat existed.
      return false
    }
    const nextText = applied.lines.join('\n')
    const lineStart = applied.lines.slice(0, Math.max(0, applied.cursorLine))
      .reduce((length, line) => length + line.length + 1, 0)
    const nextCursor = lineStart + applied.cursorCol
    // The Provider handing the document back unchanged is the other half of the
    // same fact: there was nothing left to write.
    const writes = nextText !== document.text || nextCursor !== document.cursor
    // The popup goes BEFORE the write, so the ONE frame the composer commits
    // already carries the finished text with no stale list beside it.
    const hadPopup = withdraw()
    if (!writes) {
      // Nothing was completed, so the gesture that asked for it is still the
      // gesture it always was. `handleKey` only reaches this for a key the seat
      // owned, and a click never submits — see the callers.
      if (hadPopup) ports.requestRender()
      return false
    }
    const accepted = ports.composer.applyCompletionEdit(
      { text: document.text, cursor: document.cursor },
      { text: nextText, cursor: nextCursor },
    )
    if (!accepted && hadPopup) ports.requestRender()
    return accepted
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
    install: (installed) => {
      // A catalog commit REPLACES the source: the previous list, every in-flight
      // answer and every painted row identity go with it, so a withdrawn command
      // can never stay in the menu or be accepted afterwards. The next edit (or
      // Tab) queries the new source.
      sourceRevision += 1
      provider = installed
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
          if (accept()) return true
          // `accept()` already withdrew the list; the token was complete (or the
          // fence refused), so this Enter goes to the Composer reducer, which
          // classifies and submits exactly as it did before this seat existed.
          return false
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
      accept()
    },
    renderState: () => {
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
      const start = Math.min(
        Math.max(0, shown.selected - SLASH_COMPLETION_MAX_ROWS + 1),
        Math.max(0, total - SLASH_COMPLETION_MAX_ROWS),
      )
      const end = Math.min(total, start + SLASH_COMPLETION_MAX_ROWS)
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
      return { revision: shown.revision, rows, hidden: total - (end - start) }
    },
    isOpen: () => list !== undefined && list.items.length > 0,
    retire: () => withdraw(),
  }
}
