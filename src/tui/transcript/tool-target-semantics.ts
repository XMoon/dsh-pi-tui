/**
 * The PR-B1 tool-target semantics: the ONE place that decides whether the
 * target string a tool head DISPLAYS is provably a command, a single path or
 * a pattern — so the native client can draw it with the matching syntax.
 *
 * The contract is deliberately conservative, and it is a CONSISTENCY test, not
 * a guess:
 *
 * > The displayed target is only given a specialised kind when the tool's own
 * > registered presentation view proves THAT EXACT STRING **and** the tool's
 * > own declared semantics say what KIND of thing that string is.
 *
 * The proof comes from the official `ToolCallView` / `ToolResultView` the tool
 * author declares (`presentCall` / `presentResult`), read through the SAME
 * `ToolPresenter` bridge the PiTui renderer already consumes. Nothing here
 * re-parses the raw args, infers from the tool NAME, or guesses from the
 * shape of a string: a tool that declares no view yields `text`, always.
 *
 * Why TWO conditions are needed (the string identity AND the declared kind):
 *
 * - The **string identity** answers "is the DISPLAYED text the thing the tool
 *   proved?". The head shows `toolCardHeader().summary`, which the DSH layer
 *   derives from the args with its OWN key preferences (for `bash` the summary
 *   is the `description`, not the command; for `read` it is the
 *   workspace-RELATIVIZED path). A view that proves "there is a path" is NOT
 *   enough — the client would then draw a different string as if it were the
 *   proven one.
 * - The **declared kind** answers "WHAT IS that string?". The official
 *   `ToolCallKind` vocabulary (`read | edit | delete | move | search |
 *   execute | fetch | other`) is the tool AUTHOR's own semantic declaration.
 *   Without it, `rawInput` alone would be a semantic trap: the registered
 *   `skill` tool declares `kind: 'read'` with `rawInput: <skill name>`, and
 *   the head displays that same name — so a "rawInput equals the displayed
 *   string" rule would call a SKILL NAME a search pattern. The same field
 *   holds a command (`bash`), a pattern (`glob`/`grep`), a URL
 *   (`web_fetch`) and a todo array (`todo_write`); only the declared kind
 *   tells them apart.
 *
 * The result is a CONSERVATIVE SUBSET of the SDK's vocabulary: `path`,
 * `pattern` and the default `text`. `command` is NOT claimed in this round —
 * it is a deferred capability, and `query` is never claimed because no
 * registered tool declares a query-bearing call view.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/tool-target-semantics
 */

import type { ToolCallKind, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import type { ToolPresenter } from './tool-presentation.ts'

/**
 * The SDK's tool-target vocabulary, restricted to what this module proves.
 *
 * `command` is deliberately NOT in this set: it is a deferred capability for
 * a later round, not a missing one (see `toolTargetKind`).
 */
export type ToolTargetKind = 'path' | 'pattern' | 'text'

/** The presentation read one tool row needs. */
export interface ToolTargetFacts {
  /**
   * The REGISTERED tool's call view, or undefined when the tool declares
   * none — OR when the bridge's views are not tool-authored (the Client
   * branch derives them from the tool name, which is a guess, not a proof).
   */
  readonly callView: ToolCallView | undefined
  /** The registered tool's result view (undefined when the tool declares none). */
  readonly resultView: ToolResultView | undefined
}

/**
 * The relativization the head applied to the args-derived summary, applied
 * HERE to the tool's own proven path so the two strings can be compared.
 * @param text - the tool's own path.
 * @param cwd - the workspace root the head relativizes against.
 */
function relativize(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(root + '/') || text.startsWith(root + '\\')) return text.slice(root.length + 1)
  return text
}

/** The paths ONE view proves, per its own shape. */
function pathsOfView(view: ToolCallView | ToolResultView | undefined): string[] {
  if (view === undefined) return []
  const paths = new Set<string>()
  // A call view carries `locations`; a diff view (either stage) carries
  // `diffs`; a read RESULT carries a single `path`.
  if ('locations' in view && view.locations !== undefined) {
    for (const location of view.locations) {
      if (typeof location.path === 'string' && location.path !== '') paths.add(location.path)
    }
  }
  if (view.card === 'diff') {
    for (const diff of view.diffs) {
      if (typeof diff.path === 'string' && diff.path !== '') paths.add(diff.path)
    }
  }
  if (view.card === 'read' && typeof view.path === 'string' && view.path !== '') paths.add(view.path)
  return [...paths]
}

/**
 * The paths this row's tool proves, from ONE stage only.
 *
 * The two stages legitimately spell the SAME file differently: the call view
 * repeats the argument the model wrote (`src/a.ts`), while the settled result
 * reports the path the tool resolved (`/workspace/src/a.ts`). Unioning the two
 * would read one file as two and refuse every settled call — the head would
 * lose its `path` kind exactly when the call finishes.
 *
 * So the settled RESULT is the authority for what happened, and the call view
 * answers only when the result does NOT prove a path — either because there is
 * no result view yet (a running call) or because that view carries no path at
 * all. Whichever stage answers, the "exactly one path" rule is applied WITHIN
 * that stage, so a genuinely multi-file call still refuses.
 */
function provenPaths(facts: ToolTargetFacts): string[] {
  const settled = pathsOfView(facts.resultView)
  if (settled.length > 0) return settled
  return pathsOfView(facts.callView)
}

/**
 * The tool AUTHOR's own semantic declaration for this call, or undefined. It
 * is the discriminator that makes `rawInput` safe to read: the same field
 * holds a command, a pattern, a URL, a skill name or a todo array, and only
 * the declared kind tells them apart.
 */
function declaredKind(facts: ToolTargetFacts): ToolCallKind | undefined {
  const call = facts.callView
  if (call === undefined || !('kind' in call)) return undefined
  const kind = call.kind
  return typeof kind === 'string' ? kind : undefined
}

/**
 * The pattern the tool's own view proves, or undefined. ONLY a tool that
 * declares the `search` kind may prove a pattern: its salient raw input is
 * then the pattern the tool searches with. A tool that declares any other
 * kind proves NOTHING about patterns, no matter what its raw input holds.
 */
function provenPattern(facts: ToolTargetFacts): string | undefined {
  if (declaredKind(facts) !== 'search') return undefined
  const call = facts.callView
  if (call === undefined || !('rawInput' in call)) return undefined
  const raw = call.rawInput
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/**
 * Decide the target kind of ONE tool row.
 *
 * The inputs are the row's own facts and the tool's registered views; the
 * output is a kind the client may draw with. The row's DISPLAYED target is
 * the only string that is ever classified.
 *
 * Every refusal below is a CONSEQUENCE of the string-identity proof, not a
 * separate rule about the row: a merged read group shows `2 files` (never a
 * proven path), an orphan row shows no target at all, and a row whose tool
 * declares nothing proves nothing. So the proof itself refuses them.
 *
 * @param displayed - the exact string the head will display (the summary).
 * @param facts - the registered tool's call/result views.
 * @param cwd - the workspace root the head relativizes against.
 * @returns the proven kind, or `text` when nothing is proven.
 */
export function toolTargetKind(
  displayed: string,
  facts: ToolTargetFacts,
  cwd: string | undefined,
): ToolTargetKind {
  // `command` is NOT claimed in this round. It is a DEFERRED capability, not
  // a missing one: the registered bash tool proves the command, but the DSH
  // head shows the tool's `description`, so the two are different strings and
  // the string-identity proof does not hold. Claiming it would need the
  // DISPLAYED string to change (an independent visible-content decision),
  // which is out of this round's scope.

  // A search call view proves a PATTERN — but only a tool that DECLARES the
  // `search` kind may: its salient raw input is then the pattern it searches
  // with. A tool that declares another kind proves nothing about patterns.
  const pattern = provenPattern(facts)
  if (pattern !== undefined && pattern === displayed) return 'pattern'

  // A location/diff/read view proves a PATH — but only a SINGLE one, and only
  // when the displayed string IS that path (the head relativizes absolute
  // paths against the workspace root, so the proof is relativized too).
  const paths = provenPaths(facts)
  if (paths.length === 1) {
    const path = paths[0]!
    if (path === displayed || relativize(path, cwd) === displayed) return 'path'
  }
  return 'text'
}

/**
 * Read one tool row's registered presentation views through the bridge. The
 * bridge is the SAME one the PiTui renderer consumes; an absent presenter
 * yields no views, and the row then stays `text`.
 * @param presenter - the presentation bridge, when one is wired.
 * @param message - the folded tool row.
 * @returns the call/result views the registered tool declares.
 */
export function toolTargetFactsOf(
  presenter: ToolPresenter | undefined,
  message: Extract<TranscriptMessage, { kind: 'tool' }>,
): ToolTargetFacts {
  if (presenter === undefined) return { callView: undefined, resultView: undefined }
  // A call view is PROOF only when the REGISTERED tool author declared it. The
  // Client branch derives its call views from the tool name and the raw args:
  // that repeats a name-keyed guess, and a plugin may register its own tool
  // under a built-in name, so the name cannot even identify the built-in. Such
  // a view proves nothing about what the string IS, and it must not be read as
  // a path/pattern proof.
  const callView = presenter.callViewIsToolAuthored === true ? presenter.call(message.name, message.args) : undefined
  let resultView: ToolResultView | undefined
  try {
    resultView = presenter.result(message.name, message.args, {
      content: message.resultBlocks ?? [],
      isError: message.status === 'error',
      ...(message.meta === undefined ? {} : { meta: message.meta }),
    })
  } catch {
    // A tool's own presenter threw: the row keeps the plain `text` target.
    // The bridge itself already guards a throwing `presentCall`; this guard
    // covers a `result` that throws outside the bridge's own try.
    resultView = undefined
  }
  return { callView, resultView }
}
