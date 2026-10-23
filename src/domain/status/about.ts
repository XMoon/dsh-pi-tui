/**
 * The About status projection (Phase 3C / C3): the immutable plain-data view
 * of one About open, its ordered fact rows, and the Copy All serialization.
 *
 * ONE captured {@link AboutStatusView} revision supplies BOTH the displayed
 * strings and the raw copy values — a copy never re-reads the live agent and
 * never strips terminal sequences from painted text. Every fact carries a
 * stable id, its section, its display value and its `copyValue`; an absent
 * authority is `Unavailable` in words, never a fabricated zero.
 *
 * The module is pure and Host-free: it imports no store, no port and no TUI
 * type. The per-open owner is `app/command/about-status.ts`; the panel renders
 * `aboutFactRows(view)` and copies `serializeAboutStatus(view)`.
 * @module @xmoon76/dsh-pi-tui/domain/status/about
 */

import type { SessionStatsFacts } from './stats.ts'

/** The explicit backend selection (mirrors `runtime/backend.ts`'s kind). */
export type AboutBackendKind = 'direct' | 'remote'

/** The Context measurement observation vocabulary (C3): the coordinator's
 * own classification of the last attempt — never inferred from a value. */
export type AboutContextObservation = 'fresh' | 'last-known' | 'unavailable'

/** The whole About view of ONE open: versions/backend, the captured live
 * session's grouped facts (or none), and the open's monotonic epoch. */
export interface AboutStatusView {
  readonly runtime: {
    /** This bundle's own version. */
    readonly tui: string
    /** The installed Harness version, or `undefined` (unreadable). */
    readonly dsh: string | undefined
    readonly backend: AboutBackendKind
  }
  /**
   * The captured live main session, or `none` while sessionless. Every other
   * kind carries the facts captured under the SAME scope; an absent group
   * stays absent (`Unavailable`), never a zero.
   */
  readonly session:
    | { readonly kind: 'none' }
    | {
        readonly kind: 'loading'
        readonly sessionId: string
      }
    | {
        readonly kind: 'ready' | 'unavailable'
        readonly sessionId: string
        /** Projection facts (title/model/effort/preset/cwd); each present
         *  only when its own authority answered. */
        readonly title?: string
        readonly provider?: string
        readonly model?: string
        readonly effort?: string
        readonly preset?: string
        readonly cwd?: string
        /** TRUE when the official Session projection could not answer (an
         *  absent or failed read): the identity facts are then UNKNOWN, and
         *  the view words it with the explicit `Unavailable` state row —
         *  distinguishable from `No active session` and from a present
         *  projection whose individual facts are absent. */
        readonly projectionUnavailable?: boolean
        /** TRUE when the projection read FAILED (the port's
         *  `sessionStatusFailed` bit — the authority threw): distinct from an
         *  ordinary absence, which is a projection that answered "no value".
         *  The report words the two differently (`Projection: Failed` vs
         *  `Projection: Unavailable`). */
        readonly projectionFailed?: boolean
        /** The whole-Session statistics groups; absent when the authority
         *  could not answer. */
        readonly stats?: SessionStatsFacts
        /** The Context occupancy measured through the session's OWN
         *  coordinator (`fresh`/`last-known` value; `undefined` =
         *  unavailable — never a zero). */
        readonly contextUsed?: number
        /** The official Context window of THIS session (the projection's
         *  `context.contextWindow`; absent = unknown). */
        readonly contextWindow?: number
        /** The Context measurement observation word. */
        readonly context: AboutContextObservation
      }
  /** The per-open monotonic epoch: one About entry advances it by one, and a
   *  superseded read can never publish into a newer epoch. */
  readonly epoch: number
}

/** The ordered About fact ids (the Copy All order and the selection order). */
export type AboutFactId =
  | 'runtime.tui'
  | 'runtime.dsh'
  | 'runtime.backend'
  | 'status.unavailable'
  | 'status.projection'
  | 'session.id'
  | 'session.title'
  | 'session.provider'
  | 'session.model'
  | 'session.effort'
  | 'session.preset'
  | 'session.cwd'
  | 'stats.turns'
  | 'stats.steps'
  | 'stats.llmMs'
  | 'tokens.input'
  | 'tokens.output'
  | 'tokens.cacheRead'
  | 'tokens.cacheWrite'
  | 'tokens.cacheHitPct'
  | 'performance.recentTTFB'
  | 'performance.R5'
  | 'performance.All'
  | 'context.used'
  | 'context.window'
  | 'context.percent'
  | 'context.observation'

/** The About fact sections, in frozen order. */
export type AboutFactSection = 'runtime' | 'session' | 'statistics' | 'performance' | 'context'

/** One semantic fact row: the display/copy pair captured from ONE view. */
export interface AboutFact {
  readonly id: AboutFactId
  readonly section: AboutFactSection
  readonly label: string
  /** The painted display string (already presentation-safe). */
  readonly displayValue: string
  /** The RAW copy payload: the exact value, never derived from the paint. */
  readonly copyValue: string
  /** Whether the row's authority answered at all (`false` rows are not
   *  rendered; their absence is the honest `Unavailable` presentation). */
  readonly available: boolean
}

const UNAVAILABLE = 'Unavailable'

/** The state words. `No active session` is a session FACT, not a zero. */
export const ABOUT_NO_ACTIVE_SESSION = 'No active session'

/**
 * The Copy All control-sequence guard: the underlying values stay verbatim
 * EXCEPT escape/control sequences dangerous to terminal rendering (an OSC 52
 * clipboard-write payload or a CSI rewrite inside a "title" must never ride a
 * clipboard copy). A linear scan drops whole ESC/C1-introduced sequences and
 * the remaining C0/C1 controls; ordinary Unicode passes through untouched.
 */
function copySafe(value: string): string {
  // Fast path: any C0 control except the intentionally preserved TAB/LF/CR,
  // DEL, or ANY C1 control (0x80–0x9F) needs the scanner.
  if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) return value
  let out = ''
  let at = 0
  const length = value.length

  /** Drop one CSI sequence whose parameter/final bytes start at `at`. */
  const consumeCsi = (): void => {
    while (at < length) {
      const code = value.charCodeAt(at)
      at += 1
      // Final byte of a CSI sequence.
      if (code >= 0x40 && code <= 0x7e) return
    }
  }

  /** Drop one OSC/DCS/SOS/PM/APC string sequence whose content starts at `at`.
   *  ST is ESC `\` or the C1 ST (0x9C); OSC additionally ends on BEL. An
   *  unterminated sequence drops to the end. */
  const consumeString = (allowBel: boolean): void => {
    while (at < length) {
      const code = value.charCodeAt(at)
      if (allowBel && code === 0x07) { at += 1; return }
      if (code === 0x9c) { at += 1; return }
      if (code === 0x1b && value.charCodeAt(at + 1) === 0x5c) { at += 2; return }
      at += 1
    }
  }

  while (at < length) {
    const code = value.charCodeAt(at)
    if (code === 0x1b) {
      // ESC introducer: CSI, OSC, DCS, SOS, PM or APC consumes its whole
      // sequence; any other ESC pair is a two-byte escape and drops both.
      const next = value.charCodeAt(at + 1)
      at += 2
      if (next === 0x5b) consumeCsi()
      else if (next === 0x5d) consumeString(true)
      else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) consumeString(false)
      continue
    }
    // The C1 introducers are the exact equivalents of the ESC forms above.
    if (code === 0x9b) { at += 1; consumeCsi(); continue }
    if (code === 0x9d) { at += 1; consumeString(true); continue }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      at += 1
      consumeString(false)
      continue
    }
    // Remaining C0/C1 controls (including the standalone 0x80–0x8F range and
    // the C1 ST) are dropped; TAB/LF/CR and ordinary Unicode pass through.
    if ((code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      at += 1
      continue
    }
    out += value[at]
    at += 1
  }
  return out
}

/** Exact integer rendering (no rounding, no abbreviation) or `Unavailable`. */
function integerOr(value: number | undefined, fallback = UNAVAILABLE): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
}

/** Human-readable LLM wall: the same vocabulary as the legacy /status row. */
function formatLlmDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 1) {
    const text = (ms / 1000).toFixed(1)
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}s`
  }
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

/** One tok/s DISPLAY fact: one-decimal presentation of a finite source. The
 *  raw source number is the fact's `copyValue`, never this rounded string. */
function formatRate(value: number): string {
  const text = value.toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text} tok/s`
}

/** The sessionless/session-loading fact rows (the runtime trio plus the one
 *  state word when a session exists but its facts are not ready). */
function runtimeFacts(view: AboutStatusView): AboutFact[] {
  return [
    {
      id: 'runtime.tui',
      section: 'runtime',
      label: 'TUI',
      displayValue: view.runtime.tui,
      copyValue: view.runtime.tui,
      available: true,
    },
    {
      id: 'runtime.dsh',
      section: 'runtime',
      label: 'DSH',
      displayValue: view.runtime.dsh ?? 'Unknown',
      copyValue: view.runtime.dsh ?? 'Unknown',
      available: true,
    },
    {
      id: 'runtime.backend',
      section: 'runtime',
      label: 'Backend',
      displayValue: view.runtime.backend === 'direct' ? 'Direct' : 'Remote',
      copyValue: view.runtime.backend === 'direct' ? 'Direct' : 'Remote',
      available: true,
    },
  ]
}

/** The projection-scoped session rows (title/provider/model/effort/preset/cwd):
 *  a present value is its own row; an absent authority renders NO row (the
 *  Copy All words it `Unavailable`, never invents a fallback). */
function sessionIdentityFacts(
  session: Extract<AboutStatusView['session'], { kind: 'ready' | 'unavailable' }>,
): AboutFact[] {
  const row = (
    id: AboutFactId,
    label: string,
    value: string | undefined,
  ): AboutFact[] =>
    value === undefined
      ? []
      : [{
          id,
          section: 'session',
          label,
          displayValue: value,
          copyValue: value,
          available: true,
        }]
  return [
    ...row('session.title', 'Title', session.title),
    ...row('session.provider', 'Provider', session.provider),
    ...row('session.model', 'Model', session.model),
    ...row('session.effort', 'Reasoning effort', session.effort),
    ...row('session.preset', 'Preset', session.preset),
    ...row('session.cwd', 'CWD', session.cwd),
  ]
}

/** The Statistics section: whole-Session lifetime + token groups. */
function statisticsFacts(
  session: Extract<AboutStatusView['session'], { kind: 'ready' | 'unavailable' }>,
): AboutFact[] {
  const lifetime = session.stats?.lifetime
  const tokens = session.stats?.tokens
  if (lifetime === undefined && tokens === undefined) return []
  const facts: AboutFact[] = []
  if (lifetime !== undefined) {
    if (lifetime.turns !== undefined) {
      facts.push({ id: 'stats.turns', section: 'statistics', label: 'Turns', displayValue: String(lifetime.turns), copyValue: String(lifetime.turns), available: true })
    }
    if (lifetime.steps !== undefined) {
      facts.push({ id: 'stats.steps', section: 'statistics', label: 'Steps', displayValue: String(lifetime.steps), copyValue: String(lifetime.steps), available: true })
    }
    if (lifetime.llmMs !== undefined) {
      facts.push({
        id: 'stats.llmMs',
        section: 'statistics',
        label: 'LLM wall',
        displayValue: `${formatLlmDuration(lifetime.llmMs)} (${String(lifetime.llmMs)} ms)`,
        copyValue: String(lifetime.llmMs),
        available: true,
      })
    }
  }
  if (tokens !== undefined) {
    facts.push(
      { id: 'tokens.input', section: 'statistics', label: 'Input tokens', displayValue: integerOr(tokens.input), copyValue: String(tokens.input), available: true },
      { id: 'tokens.output', section: 'statistics', label: 'Output tokens', displayValue: integerOr(tokens.output), copyValue: String(tokens.output), available: true },
      { id: 'tokens.cacheRead', section: 'statistics', label: 'Cache read tokens', displayValue: integerOr(tokens.cacheRead), copyValue: String(tokens.cacheRead), available: true },
      { id: 'tokens.cacheWrite', section: 'statistics', label: 'Cache write tokens', displayValue: integerOr(tokens.cacheWrite), copyValue: String(tokens.cacheWrite), available: true },
      {
        id: 'tokens.cacheHitPct',
        section: 'statistics',
        label: 'Cache hit',
        displayValue: `${tokens.cacheHitPct.toFixed(1)}%`,
        // Exact numeric copy: the display rounds, the copied fact never does.
        copyValue: String(tokens.cacheHitPct),
        available: true,
      },
    )
  }
  return facts
}

/** The Performance section: each measured figure only when its own authority
 *  answered (no `0 tok/s` for a sample-less scope). */
function performanceFacts(
  session: Extract<AboutStatusView['session'], { kind: 'ready' | 'unavailable' }>,
): AboutFact[] {
  const recent = session.stats?.recent
  const sessionPerformance = session.stats?.sessionPerformance
  if (recent === undefined && sessionPerformance === undefined) return []
  const facts: AboutFact[] = []
  const ttfb = recent?.firstTokenMsAvg
  if (ttfb !== undefined) {
    facts.push({
      id: 'performance.recentTTFB',
      section: 'performance',
      label: 'TTFB (recent)',
      displayValue: formatLlmDuration(ttfb),
      copyValue: String(ttfb),
      available: true,
    })
  }
  const r5 = recent?.tokensPerSec
  if (r5 !== undefined && Number.isFinite(r5)) {
    facts.push({ id: 'performance.R5', section: 'performance', label: 'R5 tokens/sec', displayValue: formatRate(r5), copyValue: String(r5), available: true })
  }
  const all = sessionPerformance?.tokensPerSec
  if (all !== undefined && Number.isFinite(all)) {
    facts.push({ id: 'performance.All', section: 'performance', label: 'All tokens/sec', displayValue: formatRate(all), copyValue: String(all), available: true })
  }
  return facts
}

/** The Context section: occupancy/window/percent + the explicit observation
 *  word. Percent only when both numbers exist and the window is positive. */
function contextFacts(
  session: Extract<AboutStatusView['session'], { kind: 'ready' | 'unavailable' }>,
): AboutFact[] {
  const used = session.contextUsed
  const window = session.contextWindow
  const facts: AboutFact[] = []
  if (used !== undefined) {
    facts.push({ id: 'context.used', section: 'context', label: 'Used tokens', displayValue: integerOr(used), copyValue: String(used), available: true })
  }
  if (window !== undefined) {
    facts.push({ id: 'context.window', section: 'context', label: 'Window tokens', displayValue: integerOr(window), copyValue: String(window), available: true })
  }
  if (used !== undefined && window !== undefined && window > 0) {
    const percent = (used / window) * 100
    facts.push({
      id: 'context.percent',
      section: 'context',
      label: 'Percent',
      displayValue: `${percent.toFixed(1)}%`,
      // Exact numeric copy: the display rounds, the copied fact never does.
      copyValue: String(percent),
      available: true,
    })
  }
  facts.push({
    id: 'context.observation',
    section: 'context',
    label: 'Observation',
    displayValue: session.context === 'fresh' ? 'Fresh' : session.context === 'last-known' ? 'Last-known' : UNAVAILABLE,
    copyValue: session.context === 'fresh' ? 'Fresh' : session.context === 'last-known' ? 'Last-known' : UNAVAILABLE,
    available: true,
  })
  return facts
}

/**
 * The ordered About fact rows of ONE captured view. The SAME `view` object
 * supplies every display and copy value (one revision, one truth).
 */
export function aboutFactRows(view: AboutStatusView): readonly AboutFact[] {
  const rows: AboutFact[] = [...runtimeFacts(view)]
  const session = view.session
  if (session.kind === 'none') {
    rows.push({
      id: 'status.unavailable',
      section: 'session',
      label: 'Session',
      displayValue: ABOUT_NO_ACTIVE_SESSION,
      copyValue: ABOUT_NO_ACTIVE_SESSION,
      available: true,
    })
  } else if (session.kind === 'loading') {
    rows.push(
      { id: 'session.id', section: 'session', label: 'Session ID', displayValue: session.sessionId, copyValue: session.sessionId, available: true },
      {
        id: 'status.unavailable',
        section: 'session',
        label: 'Status',
        displayValue: 'Loading…',
        copyValue: 'Loading…',
        available: true,
      },
    )
  } else {
    rows.push(
      { id: 'session.id', section: 'session', label: 'Session ID', displayValue: session.sessionId, copyValue: session.sessionId, available: true },
      ...sessionIdentityFacts(session),
      // The projection's own availability row: a missing/failed official
      // projection is an explicit state word — distinguishable from
      // `No active session` and never silently folded into a ready view.
      // A FAILED read (`Projection: Failed`) is distinct from an ordinary
      // absence (`Projection: Unavailable`).
      ...(session.projectionUnavailable === true
        ? [{
            // A DISTINCT stable id: the Projection row and the final Status row
            // can coexist in the degraded view, and a shared id would make both
            // rows paint selected and `find()` copy the wrong one.
            id: 'status.projection' as const,
            section: 'session' as const,
            label: 'Projection',
            displayValue: session.projectionFailed === true ? 'Failed' : UNAVAILABLE,
            copyValue: session.projectionFailed === true ? 'Failed' : UNAVAILABLE,
            available: true,
          }]
        : []),
      ...statisticsFacts(session),
      ...performanceFacts(session),
      ...contextFacts(session),
    )
    if (session.kind === 'unavailable') {
      rows.push({
        id: 'status.unavailable',
        section: 'session',
        label: 'Status',
        displayValue: UNAVAILABLE,
        copyValue: UNAVAILABLE,
        available: true,
      })
    }
  }
  // The copy control guard applies at THIS single boundary for EVERY branch:
  // a sessionless runtime value and a loading Session ID are untrusted too,
  // and the per-field copy must never bypass the guard the report already
  // applies. The captured facts (Host title, foreign-machine cwd) keep their
  // bytes verbatim except terminal-active sequences.
  return rows.map(row => ({ ...row, copyValue: row.copyValue === '' ? row.copyValue : copySafe(row.copyValue) }))
}

/**
 * The stable Copy All serialization (UTF-8 LF): every DEFINED fact id in the
 * frozen order, with `Unavailable` for an absent authority — offscreen facts
 * are never dropped. While sessionless the session-specific groups are OMITTED
 * entirely (no long list of artificial `Unavailable`) and the session line
 * reads `No active session`. The whale is decoration and never serialized.
 */
export function serializeAboutStatus(view: AboutStatusView): string {
  // Every external/raw field passes the SAME control guard (the plan's
  // "verbatim except dangerous terminal controls") — the runtime versions
  // and the Session ID are untrusted inputs just like the title.
  const safe = (value: string): string => copySafe(value)
  const lines: string[] = [
    'dsh-pi-tui Status',
    `TUI: ${safe(view.runtime.tui)}`,
    `DSH: ${safe(view.runtime.dsh ?? 'Unknown')}`,
    `Backend: ${view.runtime.backend === 'direct' ? 'Direct' : 'Remote'}`,
  ]
  const session = view.session
  if (session.kind === 'none') {
    lines.push('', 'Session', `Session ID: ${ABOUT_NO_ACTIVE_SESSION}`)
    return lines.join('\n')
  }
  // The ONE captured revision supplies every copied value (never a re-read).
  // A LOADING live view serializes the SAME fixed report shape: every defined
  // id in order, its pending/absent authority worded (never a dropped group).
  const rows = aboutFactRows(view)
  const valueOf = (id: AboutFactId, fallback = UNAVAILABLE): string =>
    rows.find(row => row.id === id)?.copyValue ?? fallback
  const displayOf = (id: AboutFactId, fallback = UNAVAILABLE): string =>
    rows.find(row => row.id === id)?.displayValue ?? fallback
  // Copy All keeps the fixed sections/labels/order and the human units, but a
  // numeric row carries the EXACT source value — the report never re-rounds a
  // copied number. An absent authority stays the bare `Unavailable`.
  const exactWithUnit = (id: AboutFactId, unit: string): string => {
    const value = valueOf(id)
    return value === UNAVAILABLE ? value : `${value}${unit}`
  }
  // TTFB is a duration: the report keeps the readable display AND the exact
  // source ms (the same pair shape as LLM wall); the per-field copy alone is
  // not the report. An absent authority stays the bare `Unavailable`.
  const durationWithExactMs = (id: AboutFactId): string => {
    const display = displayOf(id)
    return display === UNAVAILABLE ? display : `${display} (${valueOf(id)} ms)`
  }
  lines.push('', 'Session', `Session ID: ${safe(session.sessionId)}`)
  lines.push(
    `Title: ${valueOf('session.title')}`,
    `Provider: ${valueOf('session.provider')}`,
    `Model: ${valueOf('session.model')}`,
    `Reasoning effort: ${valueOf('session.effort')}`,
    `Preset: ${valueOf('session.preset')}`,
    `CWD: ${valueOf('session.cwd')}`,
    '',
    'Statistics',
    `Turns: ${valueOf('stats.turns')}`,
    `Steps: ${valueOf('stats.steps')}`,
    // The report keeps BOTH the readable duration and the exact raw ms —
    // the row's display value already carries the pair; absent words
    // Unavailable without a fabricated suffix.
    `LLM wall: ${displayOf('stats.llmMs')}`,
    `Input tokens: ${valueOf('tokens.input')}`,
    `Output tokens: ${valueOf('tokens.output')}`,
    `Cache read tokens: ${valueOf('tokens.cacheRead')}`,
    `Cache write tokens: ${valueOf('tokens.cacheWrite')}`,
    `Cache hit: ${exactWithUnit('tokens.cacheHitPct', '%')}`,
    '',
    'Performance',
    `TTFB (recent): ${durationWithExactMs('performance.recentTTFB')}`,
    `R5 tokens/sec: ${exactWithUnit('performance.R5', ' tok/s')}`,
    `All tokens/sec: ${exactWithUnit('performance.All', ' tok/s')}`,
    '',
    'Context',
    `Used tokens: ${valueOf('context.used')}`,
    `Window tokens: ${valueOf('context.window')}`,
    `Percent: ${exactWithUnit('context.percent', '%')}`,
    `Observation: ${session.kind === 'loading'
      ? 'Loading…'
      : session.context === 'fresh' ? 'Fresh' : session.context === 'last-known' ? 'Last-known' : UNAVAILABLE}`,
  )
  if (session.kind === 'loading') {
    lines.push('Status: Loading…')
  } else if (session.projectionUnavailable === true) {
    // The failure bit words the projection state precisely (plan §3.2
    // step 5): a thrown authority is `Failed`, an answered-absent one is
    // `Unavailable` — never one shared word for two different states.
    lines.push(session.projectionFailed === true ? 'Projection: Failed' : 'Projection: Unavailable')
  }
  if (session.kind === 'unavailable') {
    lines.push('Status: Unavailable')
  }
  return lines.join('\n')
}
