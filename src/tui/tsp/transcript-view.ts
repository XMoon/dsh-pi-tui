/**
 * The production TSP transcript mapper (PR3-A): the pure
 * `TranscriptStructureBlock[] -> TSP view` mapper and its one
 * presentation-local identity allocator, moved verbatim from the PR1 spike
 * (`scripts/support/tern-tsp-transcript-view.ts`, which now re-exports this
 * module so the spike and its tests keep the SAME oracle).
 *
 * It reads the canonical transcript structure produced by the production
 * projector and emits official `@stencil-hq/tern` nodes. It owns no event
 * application, no turn/tool-result pairing and no durable identity — it never
 * re-segments Work/Context membership, never classifies a row from its display
 * text, and never writes transport bytes (the SDK's `View`/`Surface` own the
 * wire).
 *
 * Node keys are presentation identities only: the SDK derives wire ids from a
 * parent id plus the child's `key`, so a stable `key` keeps an unchanged row
 * in place across renders. The allocator is scoped to ONE renderer
 * presentation scope (see `TranscriptNodeKeys`; the renderer re-scopes on a
 * `sourceIdentity` change); it is not a persistence identity.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/transcript-view
 */

import { ui } from '@stencil-hq/tern'
import type { Node, Spans, Status } from '@stencil-hq/tern'
import type { SettledQuestionAnswersLookup } from '../../app/surface/interaction-presenter.ts'
import type { StreamingToolPreview } from '../../app/surface/streaming-tool-preparing.ts'
import { contextFormOf } from '../../domain/transcript/context-semantics.ts'
import { subCallDisplayStatus } from '../../domain/transcript/folder.ts'
import { formatBytes } from '../../domain/media/format.ts'
import type { TranscriptMessage, TranscriptToolMessage } from '../../domain/transcript/types.ts'
import { contextPresentationKind } from '../transcript/context-structure.ts'
import type { ContextCluster } from '../transcript/context-structure.ts'
import { contextClusterSummaryParts } from '../transcript/context-summary.ts'
import type { TranscriptStructureBlock, TranscriptWorkSpan } from '../transcript/structure.ts'
import { systemContextBody, toolCardHeader, toolTitle, relativizeToCwd } from '../transcript/tool-presentation.ts'
import type { ToolPresenter } from '../transcript/tool-presentation.ts'
import { toolTargetFactsOf, toolTargetKind } from '../transcript/tool-target-semantics.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

/**
 * One replay-local allocator of presentation keys, scoped to a single
 * `TranscriptFolder`/`Surface` lifetime. It maps a `TranscriptMessage` object
 * to `<namespace>-<n>` on first sight, so a retained carrier object keeps its
 * key through ordinary live updates. A replaced carrier (a merged read group,
 * a cold re-hydration) legitimately gets a fresh key: this is presentation
 * identity, never a domain or wire identity.
 */
export class TranscriptNodeKeys {
  #byMessage = new WeakMap<TranscriptMessage, string>()
  #next = 0

  /** The stable per-lifetime key of one message, allocated on first sight. */
  keyFor(message: TranscriptMessage): string {
    const known = this.#byMessage.get(message)
    if (known !== undefined) return known
    this.#next += 1
    const key = `msg-${this.#next}`
    this.#byMessage.set(message, key)
    return key
  }
}

/** Explicit mapper inputs the projection itself does not own. */
export interface TranscriptViewOptions {
  /** Workspace root for the shared tool-args path relativization; optional. */
  readonly cwd?: string
  /**
   * A renderer-local scope prefix applied to the TOP-LEVEL block keys. The
   * SDK derives every node id from its parent's id plus the child key, so
   * prefixing the top level re-namespaces the WHOLE subtree — the mechanism
   * by which a replaced projection source (session commit, cold rehydrate,
   * viewer switch) can never inherit another fold's SDK node ids or
   * terminal-local state. Presentation identity only, NOT a durable or
   * domain identity; the default (`''`) keeps the PR1 oracle's key shapes.
   */
  readonly scopePrefix?: string
  /**
   * PR3-B B3 (§3.9): the authoritative settled-answer lookup the interaction
   * owner installs (an official `userQuestions` projection read). It is
   * consulted ONLY for an `ask_user_question` tool row carrying an official
   * `callId`, and only to render that row's result body — the canonical
   * transcript message is never rewritten.
   */
  readonly settledQuestionAnswersLookup?: SettledQuestionAnswersLookup
  /**
   * PR-B1: the presentation bridge over the REGISTERED tool definitions
   * (the SAME bridge the PiTui renderer consumes). It is consulted ONLY to
   * decide whether a tool row's displayed target is PROVEN to be a command, a
   * single path or a pattern, so the native client can draw it with the
   * matching syntax. It never changes the displayed string, the body, the
   * card's identity or its status — an absent bridge leaves every row's
   * target plain `text`, exactly as before.
   */
  readonly toolPresenter?: ToolPresenter
  /**
   * PR-B3: the LIVE tool-call Preparing projection — the read-only snapshot
   * the application owner already derived from the official assistant stream
   * (`StreamingToolPreview`). It is presentation input only: the mapper never
   * owns a preview, never subscribes to a delta, never decides when a
   * Preparing row disappears (the owner clears the preview and the NEXT
   * snapshot says so) and never re-parses a partial argument payload.
   *
   * The rows are placed on the SAME canonical structure: only the TRAILING
   * open Work span may adopt the rows of its own turn, every other turn fails
   * open as standalone rows after the transcript. An absent option (or an
   * empty array) renders exactly the tree the mapper rendered before.
   */
  readonly preparingPreviews?: readonly StreamingToolPreview[]
}

/** `ok|error|running` -> the SDK's card/tool `status` vocabulary. */
function toolStatus(status: 'ok' | 'error' | 'running'): Status {
  return status === 'ok' ? 'done' : status
}

/**
 * Whether one settled tool card has no genuine `tool/call` behind it: an
 * orphan result (`callCount === 0`, no origin) or the official
 * `tool-not-started` crash-recovery diagnostic. Such a row must never present
 * a completed execution status.
 */
function isUnmatchedToolRow(message: Extract<TranscriptMessage, { kind: 'tool' }>): boolean {
  return message.origin === 'tool-not-started' || (message.origin === undefined && message.callCount === 0)
}

function toolBodyNodes(
  message: Extract<TranscriptMessage, { kind: 'tool' }>,
  options: TranscriptViewOptions,
  wrap = false,
): Node[] {
  const nodes: Node[] = []
  if (message.args !== '') nodes.push(ui.code({ key: 'args', text: sanitizeDisplayText(message.args), ...(wrap ? { wrap: true } : {}) }))
  // The body is decided by the SHOWN result, never by the recorded payload: a
  // running `ask_user_question` row can carry an empty recorded result while
  // the official projection already settled it, and the settled batch is still
  // the authority. An absent lookup answers `''` and omits the body exactly as
  // before, so an ordinary tool row is unchanged.
  const result = shownToolResult(message, options)
  if (result !== '') nodes.push(ui.code({ key: 'result', text: sanitizeDisplayText(result), ...(wrap ? { wrap: true } : {}) }))
  return nodes
}

/**
 * The result body of one tool row. PR3-B B3 (§3.9): an `ask_user_question`
 * row carrying an official `callId` shows the AUTHORITATIVE settled answer
 * batch when the projection has one. An ABSENT settled entry falls back to the
 * call's own recorded result; an EMPTY batch is a real settled outcome (a late
 * reply settled the question without a readable batch) and must NOT fall back
 * to the timeout payload it replaced.
 */
function shownToolResult(message: Extract<TranscriptMessage, { kind: 'tool' }>, options: TranscriptViewOptions): string {
  if (message.name !== 'ask_user_question' || message.callId === undefined) return message.result
  const settled = options.settledQuestionAnswersLookup?.(message.callId)
  return settled === undefined ? message.result : JSON.stringify({ answers: settled })
}

/**
 * PR-B2: one native INLINE tool node for one PTC sub-call. Identity is the
 * child's own durable `subCallId` (never its name, its array position or the
 * parent's revision); header, target and status come from the same authorities
 * as the top-level row (`toolCardHeader`, `subCallDisplayStatus`). The body is
 * the complete child output, wrapped; a child with no header summary shows its
 * raw args instead of a headless empty card.
 */
function childToolNode(child: TranscriptToolMessage, options: TranscriptViewOptions): Node {
  const header = toolCardHeader(child.name, child.args, options.cwd)
  const body: Node[] = []
  if (header.summary === '' && child.args !== '') {
    body.push(ui.code({ key: 'args', text: sanitizeDisplayText(child.args), wrap: true }))
  }
  body.push(...toolChildNodes(child, options))
  if (child.result !== '') body.push(ui.code({ key: 'result', text: sanitizeDisplayText(child.result), wrap: true }))
  return ui.tool(
    {
      key: `sub-${child.subCallId!}`,
      frame: 'inline',
      name: sanitizedPhysicalLine(child.name),
      title: sanitizedPhysicalLine(header.title),
      status: toolStatus(subCallDisplayStatus(child)),
      ...(header.summary === '' ? {} : {
        target: sanitizedPhysicalLine(header.summary),
        // A child target is presentation text only: no registered-tool
        // provenance is consulted, so no command/path/pattern kind is guessed.
        targetKind: 'text',
      }),
    },
    ...body,
  )
}

/**
 * The ordered nested-call block of one tool card: the direct-child count head,
 * then each child's own native inline tool in durable dispatch order. The
 * count is the DIRECT children of this card; a child with grandchildren runs
 * this same rule one level down (never a Work-level lookup).
 */
function toolChildNodes(parent: TranscriptToolMessage, options: TranscriptViewOptions): Node[] {
  const subCalls = parent.subCalls
  if (subCalls === undefined || subCalls.length === 0) return []
  return [
    ui.text({ key: 'child-head', text: `Child calls · ${subCalls.length}` }),
    ...subCalls.map(child => childToolNode(child, options)),
  ]
}

function toolNode(message: Extract<TranscriptMessage, { kind: 'tool' }>, key: string, options: TranscriptViewOptions): Node {
  const header = toolCardHeader(message.name, message.args, options.cwd)
  if (isUnmatchedToolRow(message)) {
    const provenance = message.origin === 'tool-not-started' ? 'not started' : 'unmatched result'
    return ui.card(
      { key, head: sanitizedPhysicalLine(header.title), tone: 'warning' },
      ui.badge({ key: 'provenance', text: provenance }),
      ...toolBodyNodes(message, options),
    )
  }
  // PR-B2: only a parent that carries PTC children gets the wrapped parent
  // body and the nested block; every other tool row keeps its previous view
  // shape and SDK props byte-identically. The order is fixed:
  // parent args -> child block -> parent result.
  const hasChildren = (message.subCalls?.length ?? 0) > 0
  const existing = toolBodyNodes(message, options, hasChildren)
  const args = existing.filter(node => node.props.key === 'args')
  const result = existing.filter(node => node.props.key === 'result')
  const others = existing.filter(node => node.props.key !== 'args' && node.props.key !== 'result')
  return ui.tool(
    {
      key,
      name: sanitizedPhysicalLine(message.name),
      title: sanitizedPhysicalLine(header.title),
      status: toolStatus(message.status),
      // PR-B1: the target KIND is the ONLY thing that changes. The displayed
      // string, the body, the key and the status are byte-identical to the
      // plain row; a row whose target is not PROVEN by the registered tool's
      // own presentation view keeps the plain `text` kind.
      ...(header.summary === '' ? {} : {
        target: sanitizedPhysicalLine(header.summary),
        targetKind: toolTargetKind(
          header.summary,
          toolTargetFactsOf(options.toolPresenter, message),
          options.cwd,
        ),
      }),
    },
    ...args,
    ...others,
    ...toolChildNodes(message, options),
    ...result,
  )
}

/**
 * The safe body of one injected Context row through the existing
 * `systemContextBody` helper (never a raw `<system-reminder>` XML envelope);
 * a body that is not an envelope at all is shown verbatim.
 */
function contextBodyNodes(message: Extract<TranscriptMessage, { kind: 'system' }>): Node[] {
  const body = systemContextBody(message.text)
  if (body === undefined) return [ui.md({ key: 'body', text: sanitizeDisplayText(message.text) })]
  if (body.length === 0) return []
  return [ui.code({ key: 'body', text: sanitizeDisplayText(body.join('\n')) })]
}

function systemNode(message: Extract<TranscriptMessage, { kind: 'system' }>, key: string): Node {
  if (message.context === true) {
    const kind = contextPresentationKind(message)
    const head = sanitizedPhysicalLine(message.label ?? contextFormOf(message) ?? 'Context')
    return ui.card(
      { key, head },
      ui.badge({ key: 'kind', text: kind ?? 'generic' }),
      ...contextBodyNodes(message),
    )
  }
  // Non-context system rows are orchestration evidence (llm-retry /
  // turn-max-tokens); they are never turn-foundation Context.
  return ui.card({ key, head: message.origin ?? 'System' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
}

function commandNode(message: Extract<TranscriptMessage, { kind: 'command' }>, key: string): Node {
  const name = message.name ?? 'command'
  const head = sanitizedPhysicalLine(message.args === null || message.args === '' ? `/${name}` : `/${name} ${message.args}`)
  const outcome = message.outcome
  // The official `command/done` kind is the only status authority: a run
  // without a done is running, and a fragment-only fallback invents nothing.
  const status: Status = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'done'
  const body = outcome?.text === undefined || outcome.text === '' ? [] : [ui.md({ key: 'body', text: sanitizeDisplayText(outcome.text) })]
  return ui.card({ key, head, status }, ...body)
}

function compactionNode(message: Extract<TranscriptMessage, { kind: 'compaction' }>, key: string): Node {
  const status: Status = message.error !== undefined && message.error !== ''
    ? 'error'
    : message.running === true ? 'running' : 'done'
  const body = message.text === '' ? [] : [ui.md({ key: 'body', text: sanitizeDisplayText(message.text) })]
  return ui.card(
    { key, head: 'Compaction', status },
    ui.badge({ key: 'counts', text: `${message.items} items · ${message.tokens} tokens` }),
    ...body,
  )
}

function workflowNode(message: Extract<TranscriptMessage, { kind: 'workflow' }>, key: string): Node {
  return ui.card(
    { key, head: sanitizedPhysicalLine(message.name) },
    ui.badge({ key: 'state', text: message.status }),
    ui.badge({ key: 'members', text: `${message.members.length} members` }),
  )
}

/** One native node for one non-structural transcript row. */
function messageNode(message: TranscriptMessage, key: string, options: TranscriptViewOptions): Node {
  switch (message.kind) {
    case 'user':
      return ui.card({ key, head: 'You' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
    case 'assistant':
      return ui.card({ key, head: 'Assistant' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
    case 'thinking':
      return ui.card(
        { key, head: 'Thinking', ...(message.running === true ? { status: 'running' } : {}) },
        ui.md({ key: 'body', text: sanitizeDisplayText(message.text), ...(message.running === true ? { stream: true } : {}) }),
      )
    case 'tool':
      return toolNode(message, key, options)
    case 'system':
      return systemNode(message, key)
    case 'command':
      return commandNode(message, key)
    case 'compaction':
      return compactionNode(message, key)
    case 'workflow':
      return workflowNode(message, key)
    case 'summary':
      return ui.card({ key, head: 'Earlier turns' }, ui.md({ key: 'body', text: sanitizeDisplayText(message.text) }))
  }
}

/**
 * PR-B3: ONE read-only Preparing row for one live tool call whose arguments
 * are still streaming. The row is plain TEXT on the native `row` kind: no
 * badge, no status, no icon, no timer, no action — a Preparing row states
 * that arguments are arriving, never that a tool is running or done.
 *
 * The content is read, never re-derived: the name is the stream's own tool
 * name (through the shared `toolTitle` table), the summary is the owner's
 * already-extracted field (sanitized and folded to one line, then
 * display-relativized against the workspace root) and the byte count is the
 * owner's exact UTF-8 count through the shared `formatBytes`. The partial
 * argument prefix and the start time never reach the view.
 *
 * The identity is the call's own id when it arrived, and the durable
 * turn/step/index position before that — never the summary, the name or the
 * byte count (a byte update must not re-key the row).
 * @param cwd - the workspace root for the display-only path relativization.
 * @param keyPrefix - the scope prefix of a STANDALONE row (a row inside a
 * Work section is already scoped by its section's own id).
 */
function preparingRow(
  preview: StreamingToolPreview,
  cwd: string | undefined,
  keyPrefix: string,
): Node {
  const key = `preparing-${preview.callId === ''
    ? `idx-${preview.turn}-${preview.step}-${preview.index}`
    : preview.callId}`
  const name = preview.name ?? ''
  const title = name === '' ? 'Preparing tool…' : `Preparing ${toolTitle(name)}…`
  const summary = preview.summary === undefined
    ? undefined
    : relativizeToCwd(sanitizeDisplayText(preview.summary).replace(/\r\n|\r|\n/g, ' '), cwd)
  return ui.row(
    { key: `${keyPrefix}${key}`, wrap: true },
    ui.text({ key: 'label', text: sanitizeDisplayText(title) }),
    ...(summary === undefined ? [] : [ui.text({ key: 'summary', text: ` · ${summary}` })]),
    ui.text({ key: 'bytes', text: ` · ${formatBytes(preview.argumentBytes)}` }),
  )
}

/**
 * PR-B3: the Preparing previews grouped by their durable turn — ascending
 * turn, and inside a group ascending index. A local, per-call projection: no
 * long-lived map, no second preview authority and no cached order.
 */
function groupPreparingPreviews(
  previews: readonly StreamingToolPreview[],
): [number, StreamingToolPreview[]][] {
  const groups = new Map<number, StreamingToolPreview[]>()
  for (const preview of previews) {
    const group = groups.get(preview.turn)
    if (group === undefined) groups.set(preview.turn, [preview])
    else group.push(preview)
  }
  for (const group of groups.values()) group.sort((left, right) => left.index - right.index)
  return [...groups.entries()].sort((left, right) => left[0] - right[0])
}

/** One native Work container keyed by its canonical span owner. Its ordered
 * structural parts place a carried snapshot-only Context cluster as a nested
 * `clusterNode` card; the flat member sequence is never re-derived here. The
 * optional Preparing rows are the LAST children of the section: they follow
 * every durable part of the open run. */
function workNode(
  span: TranscriptWorkSpan,
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions,
  prefix: string,
  previews: readonly StreamingToolPreview[] = [],
): Node {
  const head: Spans = ['Work', ` · turn ${span.turn}`]
  return ui.section(
    { key: `${prefix}work-${keys.keyFor(span.owner)}`, head },
    ...span.parts.map(part => part.kind === 'message'
      ? messageNode(part.message, keys.keyFor(part.message), options)
      : clusterNode(part.cluster, keys, options, prefix)),
    ...previews.map(preview => preparingRow(preview, options.cwd, '')),
  )
}

/** One native Context container keyed by its canonical cluster owner. */
function clusterNode(cluster: ContextCluster, keys: TranscriptNodeKeys, options: TranscriptViewOptions, prefix: string): Node {
  const parts = contextClusterSummaryParts(cluster)
  return ui.card(
    { key: `${prefix}ctx-${keys.keyFor(cluster.owner)}`, head: parts.length === 0 ? 'Context' : sanitizedPhysicalLine(parts.join(' · ')) },
    ...cluster.members.map(member => messageNode(member, keys.keyFor(member), options)),
  )
}

/**
 * Map the canonical structural blocks of one transcript window onto a native
 * TSP view: the whole structure as ONE `col` root, in raw visual order.
 * @param structure - `projectTranscriptStructure()` output; the mapper never
 * re-derives a Work/Context boundary.
 * @param keys - the replay-local key allocator, one per surface lifetime.
 * @param options - explicit helper inputs (workspace root for tool summaries).
 */
export function transcriptView(
  structure: readonly TranscriptStructureBlock[],
  keys: TranscriptNodeKeys,
  options: TranscriptViewOptions = {},
): Node {
  // The scope prefix applies to the TOP-LEVEL block keys only: every nested
  // id derives from its parent's id, so the whole rendered subtree lands in
  // the new namespace without re-keying (or re-classifying) any row.
  const prefix = options.scopePrefix ?? ''
  // PR-B3: the Preparing placement is a PURE projection on the same canonical
  // structure — the mapper never re-groups a row, never opens an older Work
  // and never invents a Work owner. Only the TRAILING block may adopt
  // Preparing rows, and only for its OWN turn: that Work run is the one still
  // open at the end of the window. Every other turn fails open as standalone
  // rows after the transcript (ascending turn, then ascending index).
  const groups = groupPreparingPreviews(options.preparingPreviews ?? [])
  const trailing = structure.length === 0 ? undefined : structure[structure.length - 1]
  const openTurn = trailing?.kind === 'work' ? trailing.span.turn : undefined
  /** The rows the trailing open Work adopts (empty when it adopts none). */
  let adopted: readonly StreamingToolPreview[] = []
  /** The rows that stand alone after the transcript. */
  const standalone: Node[] = []
  for (const [turn, group] of groups) {
    if (turn === openTurn) {
      adopted = group
      continue
    }
    for (const preview of group) standalone.push(preparingRow(preview, options.cwd, prefix))
  }
  return ui.col(
    { key: 'transcript' },
    ...structure.map(block => {
      switch (block.kind) {
        case 'message':
          return messageNode(block.message, `${prefix}${keys.keyFor(block.message)}`, options)
        case 'work':
          return workNode(block.span, keys, options, prefix, block === trailing ? adopted : [])
        case 'context-cluster':
          return clusterNode(block.cluster, keys, options, prefix)
      }
    }),
    ...standalone,
  )
}
