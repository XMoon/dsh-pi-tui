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
import { contextFormOf } from '../../domain/transcript/context-semantics.ts'
import type { TranscriptMessage } from '../../domain/transcript/types.ts'
import { contextPresentationKind } from '../transcript/context-structure.ts'
import type { ContextCluster } from '../transcript/context-structure.ts'
import { contextClusterSummaryParts } from '../transcript/context-summary.ts'
import type { TranscriptStructureBlock, TranscriptWorkSpan } from '../transcript/structure.ts'
import { systemContextBody, toolCardHeader } from '../transcript/tool-presentation.ts'

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

function toolBodyNodes(message: Extract<TranscriptMessage, { kind: 'tool' }>, options: TranscriptViewOptions): Node[] {
  const nodes: Node[] = []
  if (message.args !== '') nodes.push(ui.code({ key: 'args', text: message.args }))
  // The body is decided by the SHOWN result, never by the recorded payload: a
  // running `ask_user_question` row can carry an empty recorded result while
  // the official projection already settled it, and the settled batch is still
  // the authority. An absent lookup answers `''` and omits the body exactly as
  // before, so an ordinary tool row is unchanged.
  const result = shownToolResult(message, options)
  if (result !== '') nodes.push(ui.code({ key: 'result', text: result }))
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

function toolNode(message: Extract<TranscriptMessage, { kind: 'tool' }>, key: string, options: TranscriptViewOptions): Node {
  const header = toolCardHeader(message.name, message.args, options.cwd)
  const body = toolBodyNodes(message, options)
  if (isUnmatchedToolRow(message)) {
    const provenance = message.origin === 'tool-not-started' ? 'not started' : 'unmatched result'
    return ui.card(
      { key, head: header.title, tone: 'warning' },
      ui.badge({ key: 'provenance', text: provenance }),
      ...body,
    )
  }
  return ui.tool(
    {
      key,
      name: message.name,
      title: header.title,
      status: toolStatus(message.status),
      ...(header.summary === '' ? {} : { target: header.summary, targetKind: 'text' }),
    },
    ...body,
  )
}

/**
 * The safe body of one injected Context row through the existing
 * `systemContextBody` helper (never a raw `<system-reminder>` XML envelope);
 * a body that is not an envelope at all is shown verbatim.
 */
function contextBodyNodes(message: Extract<TranscriptMessage, { kind: 'system' }>): Node[] {
  const body = systemContextBody(message.text)
  if (body === undefined) return [ui.md({ key: 'body', text: message.text })]
  if (body.length === 0) return []
  return [ui.code({ key: 'body', text: body.join('\n') })]
}

function systemNode(message: Extract<TranscriptMessage, { kind: 'system' }>, key: string): Node {
  if (message.context === true) {
    const kind = contextPresentationKind(message)
    const head = message.label ?? contextFormOf(message) ?? 'Context'
    return ui.card(
      { key, head },
      ui.badge({ key: 'kind', text: kind ?? 'generic' }),
      ...contextBodyNodes(message),
    )
  }
  // Non-context system rows are orchestration evidence (llm-retry /
  // turn-max-tokens); they are never turn-foundation Context.
  return ui.card({ key, head: message.origin ?? 'System' }, ui.md({ key: 'body', text: message.text }))
}

function commandNode(message: Extract<TranscriptMessage, { kind: 'command' }>, key: string): Node {
  const name = message.name ?? 'command'
  const head = message.args === null || message.args === '' ? `/${name}` : `/${name} ${message.args}`
  const outcome = message.outcome
  // The official `command/done` kind is the only status authority: a run
  // without a done is running, and a fragment-only fallback invents nothing.
  const status: Status = outcome === null ? 'running' : outcome.kind === 'error' ? 'error' : 'done'
  const body = outcome?.text === undefined || outcome.text === '' ? [] : [ui.md({ key: 'body', text: outcome.text })]
  return ui.card({ key, head, status }, ...body)
}

function compactionNode(message: Extract<TranscriptMessage, { kind: 'compaction' }>, key: string): Node {
  const status: Status = message.error !== undefined && message.error !== ''
    ? 'error'
    : message.running === true ? 'running' : 'done'
  const body = message.text === '' ? [] : [ui.md({ key: 'body', text: message.text })]
  return ui.card(
    { key, head: 'Compaction', status },
    ui.badge({ key: 'counts', text: `${message.items} items · ${message.tokens} tokens` }),
    ...body,
  )
}

function workflowNode(message: Extract<TranscriptMessage, { kind: 'workflow' }>, key: string): Node {
  return ui.card(
    { key, head: message.name },
    ui.badge({ key: 'state', text: message.status }),
    ui.badge({ key: 'members', text: `${message.members.length} members` }),
  )
}

/** One native node for one non-structural transcript row. */
function messageNode(message: TranscriptMessage, key: string, options: TranscriptViewOptions): Node {
  switch (message.kind) {
    case 'user':
      return ui.card({ key, head: 'You' }, ui.md({ key: 'body', text: message.text }))
    case 'assistant':
      return ui.card({ key, head: 'Assistant' }, ui.md({ key: 'body', text: message.text }))
    case 'thinking':
      return ui.card(
        { key, head: 'Thinking', ...(message.running === true ? { status: 'running' } : {}) },
        ui.md({ key: 'body', text: message.text, ...(message.running === true ? { stream: true } : {}) }),
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
      return ui.card({ key, head: 'Earlier turns' }, ui.md({ key: 'body', text: message.text }))
  }
}

/** One native Work container keyed by its canonical span owner. */
function workNode(span: TranscriptWorkSpan, keys: TranscriptNodeKeys, options: TranscriptViewOptions, prefix: string): Node {
  const head: Spans = ['Work', ` · turn ${span.turn}`]
  return ui.section(
    { key: `${prefix}work-${keys.keyFor(span.owner)}`, head },
    ...span.members.map(member => messageNode(member, keys.keyFor(member), options)),
  )
}

/** One native Context container keyed by its canonical cluster owner. */
function clusterNode(cluster: ContextCluster, keys: TranscriptNodeKeys, options: TranscriptViewOptions, prefix: string): Node {
  const parts = contextClusterSummaryParts(cluster)
  return ui.card(
    { key: `${prefix}ctx-${keys.keyFor(cluster.owner)}`, head: parts.length === 0 ? 'Context' : parts.join(' · ') },
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
  return ui.col(
    { key: 'transcript' },
    ...structure.map(block => {
      switch (block.kind) {
        case 'message':
          return messageNode(block.message, `${prefix}${keys.keyFor(block.message)}`, options)
        case 'work':
          return workNode(block.span, keys, options, prefix)
        case 'context-cluster':
          return clusterNode(block.cluster, keys, options, prefix)
      }
    }),
  )
}
