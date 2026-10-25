/**
 * The INLINE attachment completion grammar: the fixed
 * Client-local attachment actions a draft can reach ANYWHERE in its body, the
 * candidate rows of their path argument, and the immutable ACCEPTANCE record
 * the provider hands to the application.
 *
 * Two distinct seats exist, and they must never be confused:
 *
 * - the ACTION seat — the inline `/name` token (`./skill-reference.ts` owns that
 *   token grammar; a later line's leading token counts, the FIRST line's
 *   leading command token does not). Accepting the fixed `image` / `attach`
 *   action replaces that token with `/image ` and puts the cursor right after
 *   the separator, which is the Client-local path argument seat.
 * - the PATH seat — a declared attachment command's argument the cursor is
 *   inside (`tui/file-completion/context.ts` is the ONE authority for that
 *   question). Accepting a FILE candidate there is what starts the
 *   Client-local attachment intake; accepting a DIRECTORY only continues
 *   completion.
 *
 * This module is deliberately PURE: no Context, Agent, Session, filesystem,
 * DraftStore or Remote. It only classifies a row, computes text and describes
 * an acceptance. Invocation authority stays with the application layer — this
 * module never reads a file, registers an attachment or sends anything.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/autocomplete/inline-attachment
 */

import type { AutocompleteItem } from '@xmoon76/pi-tui'

/** One fixed Client-local attachment action (`/image`, `/attach`). */
export interface InlineAttachmentAction {
  /** The command name without the leading `/`. */
  readonly name: string
  /** The dropdown label. */
  readonly label: string
  /** The dropdown description. */
  readonly description: string
}

/** The FIXED action list (order is the dropdown order). These two names are
 * the Client-local attachment entry points; the neutral declared-command set
 * (`FILE_ARGUMENT_COMMANDS`) is what makes their argument position a path
 * seat, so the two lists can never drift apart. */
export const INLINE_ATTACHMENT_ACTIONS: readonly InlineAttachmentAction[] = [
  { name: 'image', label: 'image', description: 'Insert local image' },
  { name: 'attach', label: 'attach', description: 'Attach local file or image' },
]

/** An attachment ACTION row (`/image` → `Insert local image`). */
export interface InlineAttachmentActionItem extends AutocompleteItem {
  /** The structural row marker (see {@link InlineAttachmentMarker}). */
  readonly inlineAttachment: 'action'
  /** The command name the action inserts. */
  readonly command: string
}

/** A PATH candidate row of an inline attachment argument seat. */
export interface InlineAttachmentPathItem extends AutocompleteItem {
  /** The structural row marker (see {@link InlineAttachmentMarker}). */
  readonly inlineAttachment: 'path'
  /** The declared command whose argument this row completes. */
  readonly command: string
  /** Whether the candidate is a directory (continuation, never an intake). */
  readonly directory: boolean
}

/**
 * The structural marker every row this layer produces carries. It is NOT a
 * permission: an acceptance is honored only while the provider's strict
 * request snapshot still matches AND the accepted row is one of the rows THAT
 * request produced (object identity). The marker exists so the acceptance can
 * tell an inline attachment action/path row from a skill, `@` mention, slash
 * command or extension row — never from label text.
 */
interface InlineAttachmentMarker {
  readonly inlineAttachment: 'action' | 'path'
}

/** Whether one accepted row is an attachment ACTION row. */
export function isInlineAttachmentAction(
  item: AutocompleteItem,
): item is InlineAttachmentActionItem {
  const marker = (item as Partial<InlineAttachmentMarker>).inlineAttachment
  return marker === 'action' && typeof (item as Partial<InlineAttachmentActionItem>).command === 'string'
}

/** Whether one accepted row is an inline attachment PATH candidate. */
export function isInlineAttachmentPath(
  item: AutocompleteItem,
): item is InlineAttachmentPathItem {
  return (item as Partial<InlineAttachmentMarker>).inlineAttachment === 'path'
    && typeof (item as Partial<InlineAttachmentPathItem>).command === 'string'
    && typeof (item as Partial<InlineAttachmentPathItem>).directory === 'boolean'
}

/**
 * How much of the text AFTER the cursor still belongs to the attachment token
 * being completed. Completion only knows what is left of the cursor, so the
 * remainder of the same token — a half-typed filename, its closing quote, or
 * the rest of a path segment — must be consumed too; otherwise it is glued to
 * the accepted value and the prose suffix loses its separation.
 *
 * The token ends at whitespace, at a quote, or at any character a path name
 * cannot contain. Everything from there on is PRESERVED PROSE.
 * @param afterCursor - the raw line text after the cursor.
 * @returns the token remainder to consume and the prose suffix to preserve.
 */
export function splitTokenRemainder(afterCursor: string): { consumed: string; suffix: string } {
  let index = 0
  while (index < afterCursor.length) {
    const char = afterCursor[index]!
    if (char === '"') {
      index += 1
      break
    }
    if (/\s/.test(char)) break
    // A path NAME cannot continue through a non-ASCII character: CJK prose that
    // follows the cursor is the user's text, never the rest of the filename.
    if (!/[A-Za-z0-9._/\-]/.test(char)) break
    index += 1
  }
  return { consumed: afterCursor.slice(0, index), suffix: afterCursor.slice(index) }
}

/**
 * The accepted ACTION replacement: replace the `/` + query span with
 * `/name ` (exactly one separator; an existing separator after the cursor is
 * kept, never doubled) and place the cursor right after the separator, which
 * is the path argument's first position.
 * @param line - the current editor line.
 * @param slashStart - the `/` index of the token.
 * @param cursorCol - the cursor column (the end of the query span).
 * @param name - the accepted action's command name.
 */
export function applyInlineAttachmentAction(
  line: string,
  slashStart: number,
  cursorCol: number,
  name: string,
): { line: string; cursorCol: number } {
  const before = line.slice(0, slashStart)
  const after = line.slice(cursorCol)
  // The rest of the QUERY token (`ge` of a half-typed `/image`) is part of what
  // this accept replaces, never prose.
  const remainder = splitTokenRemainder(after)
  // An existing separator already opens the argument seat; otherwise insert
  // exactly one. Either way the preserved prose keeps its own spacing.
  const hasSeparator = remainder.consumed === '' && after[0] !== undefined && /\s/.test(after[0]!)
  const rest = hasSeparator ? after : remainder.suffix
  const newLine = hasSeparator ? `${before}/${name}${rest}` : `${before}/${name} ${rest}`
  return { line: newLine, cursorCol: before.length + 1 + name.length + 1 }
}

/** A half-open span of ONE inline attachment fragment in the RAW editor
 *  document: the declared command token, its separator and the argument. */
export interface InlineAttachmentSpan {
  readonly line: number
  readonly start: number
  readonly end: number
}

/**
 * The accepted PATH replacement: the argument span is replaced
 * by the accepted candidate's value, so the draft reads `/image sub/` (or
 * `/image ./shots/err.png`) with the cursor right after it — the ordinary
 * completion shape, which is what lets a DIRECTORY seat continue with the
 * children and gives a FILE acceptance a real, undoable step of its own
 * (the vendored editor snapshots before every confirm, so an unchanged
 * document would add an undo checkpoint that restores nothing).
 *
 * The returned span covers the WHOLE inline fragment — the declared command
 * token, its separator and the accepted value — because that is what the
 * canonical placeholder replaces once the file has really been staged.
 * Nothing is staged here: no file has been read at this point.
 * @param line - the current editor line.
 * @param seat - the declared path-argument seat (the ONE classifier's answer).
 * @param cursorCol - the cursor column (the end of the replaced argument).
 * @param cursorLine - the cursor's logical line index.
 * @param value - the accepted candidate's completion value.
 * @returns the new line, the cursor column and the replaced fragment span.
 */
export function applyInlineAttachmentPath(
  line: string,
  seat: {
    readonly commandStart: number
    readonly range: { readonly start: number; readonly end: number }
  },
  cursorCol: number,
  cursorLine: number,
  value: string,
): { line: string; cursorCol: number; span: InlineAttachmentSpan } {
  const start = seat.range.start
  // The remainder of the token being completed (`t"` when the cursor sits
  // inside `"shot|t"`, or just a closing quote) belongs to the replaced
  // fragment; the prose after it is preserved verbatim. This is ONE boundary
  // rule shared with the action step, never a per-shape special case.
  const { suffix } = splitTokenRemainder(line.slice(cursorCol))
  // When the accepted value ENDS the fragment and prose continues right after
  // the cursor, the separator that introduced the argument still has to keep
  // the placeholder and the prose apart (`/image |为什么` must not become
  // `shot.png为什么`). The separator is re-emitted once, never doubled.
  const trailing = suffix !== '' && !/^\s/.test(suffix) ? ' ' : ''
  const end = start + value.length
  return {
    line: `${line.slice(0, start)}${value}${trailing}${suffix}`,
    cursorCol: end,
    span: { line: cursorLine, start: seat.commandStart, end },
  }
}

/**
 * The immutable ACCEPTANCE of one inline attachment row: everything the application needs to prove the accepted document is
 * really installed, and — for a FILE — the exact raw span the canonical
 * placeholder replaces. It is a one-shot USER OPERATION description, never a
 * second copy of business state: it carries no store, no bytes and no editor.
 */
export interface InlineAttachmentAcceptance {
  /** `action` opens the path argument; `directory` continues completion;
   *  `path` is the one that starts the Client-local attachment intake. */
  readonly kind: 'action' | 'directory' | 'path'
  /** The declared attachment command (`image`, `attach`). */
  readonly command: string
  /** The user-facing path the row stands for (`./shots/err.png`), already
   *  unquoted — the intake reads THIS, never a path re-parsed from the draft.
   *  '' for an action row (it selects no file). */
  readonly path: string
  /** The FULL raw editor document this accept produces (never expanded: paste
   *  markers stay markers). The application observes EXACTLY this text before
   *  it acts; a `path` acceptance installs it UNCHANGED (the fragment stays
   *  editable until the file has really been staged), every other kind's
   *  applied document carries the replacement. */
  readonly lines: readonly string[]
  /** The cursor the accept produces. */
  readonly cursorLine: number
  readonly cursorCol: number
  /** The raw fragment the canonical placeholder replaces — `kind: 'path'`
   *  only, and always resolved against the ACCEPT time document. */
  readonly span?: InlineAttachmentSpan
}

/**
 * The user-facing path text of one accepted candidate value: a value this
 * layer's presentation quoted (`"my file.png"`, `"sub dir/"`) is unquoted, so
 * the intake receives the same path the user chose. Only a FULLY quoted value
 * is unwrapped — an unclosed or embedded quote stays verbatim (that path is
 * genuinely invalid and the intake's own error reports it).
 * @param value - the completion value.
 */
export function unquoteCandidateValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}

/**
 * The FILE PATH a completed candidate value stands for.
 *
 * A candidate's `value` is the EDITOR replacement text: the Client-local path
 * engine prefixes the argument's own leading separator run back onto it so
 * that accepting a candidate preserves the spacing the user typed
 * (`/image    sho` → `/image    shots/a.png`). That text is NOT a filesystem
 * path — feeding it to the intake would look for a name starting with spaces.
 *
 * So the editor text and the read target are separated HERE, once: the
 * leading separator run is dropped and only a fully quoted remainder is
 * unwrapped. An injected run after a directory (the fork's own continuation
 * shape) is part of the user's typed spacing, not of the file name.
 * @param value - the candidate's editor replacement value.
 */
export function candidatePath(value: string): string {
  const withoutLeading = value.replace(/^[ \t]+/, '')
  return unquoteCandidateValue(withoutLeading)
}

/**
 * One inline attachment INTAKE stake: what the
 * application hands to the command plane, which owns the ONE Client-local read
 * and the existing `DraftImageStore` / `DraftFileStore`.
 *
 * The application fills the editor-side facts (the accepted path, the raw
 * draft the acceptance installed, the raw fragment and the ONE commit); the
 * command plane fills the business facts (session scope currency, read, store,
 * notices). Neither side re-implements the other's authority: the application
 * never reads a file, and the command plane never edits the editor.
 */
export interface InlineAttachmentStake {
  /** The declared attachment command (`image` requires an image, `attach`
   *  accepts an image or a generic file). */
  readonly command: string
  /** The chosen path exactly as the user selected it (quotes removed). */
  readonly path: string
  /** The raw draft the acceptance installed (paste markers unexpanded). The
   *  commit is refused when the live draft is no longer exactly this. */
  readonly rawDraft: string
  /** The raw fragment the canonical placeholder replaces. */
  readonly span: InlineAttachmentSpan
  /** Whether the seat this stake was taken for is still the live one. */
  current(): boolean
  /** The live raw draft, or undefined when the seat moved away. */
  draft(): string | undefined
  /** Commit the canonical placeholder as ONE real, undoable edit that fires
   *  the editor's change notification. Returns false when the fragment no
   *  longer matches the live draft (a stale intake never edits a new draft)
   *  and never submits anything. It may throw when the editor itself fails —
   *  that failure keeps the owned task's ordinary classification. */
  commit(placeholder: string): boolean
  /** One transient notice (the intake's success/refusal feedback). */
  notify(message: string, kind?: 'info' | 'error'): void
}

/** The command plane's inline attachment entry: read + stage + commit through
 *  the SAME authority the leading `/image` `/attach` commands use. */
export type InlineAttachmentStager = (stake: InlineAttachmentStake) => void
