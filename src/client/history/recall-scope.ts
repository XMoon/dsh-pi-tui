/**
 * The input-recall SCOPE kernel (TSP I-A): the ONE Client-local, IO-free,
 * UI-free pure state behind the short-lived editor recall of a mounted
 * renderer. It is the single home of the recall projection and of the
 * occurrence / settlement / reseed rules that PiTui used to carry inline in
 * `TuiApp`; the PiTui adapter and the TSP adapter each own ONE instance and
 * neither keeps a second mirror.
 *
 * It is deliberately NOT a persistence authority. Whether a row is written,
 * which cwd file it lands in, and the `lastHistoryContent` dedupe anchor stay
 * with `src/app/surface/input-history.ts` + `src/app/submission/history-persist.ts`;
 * which Session is current stays with the Session runtime's publication. This
 * kernel only folds the reports those owners send into the recall projection
 * its own mount will show.
 *
 * Load-bearing distinctions this kernel preserves verbatim from the PiTui
 * algorithm it was extracted from (`tui-app.ts@9e13c201`):
 *
 * - An occurrence ACCEPTED by {@link HistoryRecallScope.rememberAccepted} is
 *   not a written row: a settlement outcome `skipped` still means the
 *   submission happened, it just carries no disk row.
 * - The sessionless pool (`owner === undefined`) is a real scope, not an
 *   uninitialized one, and the first published owner ADOPTS its unsettled /
 *   same-identity entries.
 * - The bounded settlement queue is not the authority for "was this
 *   occurrence settled" — the durable per-token fact is, and the per-owner
 *   append watermark survives the queue's cap.
 * - The 100-entry recall window is not "all history from writers that share
 *   the submit turn".
 *
 * @module @xmoon76/dsh-pi-tui/client/history/recall-scope
 */

/** The shared cap of the recall snapshot, the scope's pending runs and the
 *  settlement queue (the value PiTui's editor and mirror both used). */
export const INPUT_RECALL_LIMIT = 100

/**
 * One settlement the write owner reported (see
 * {@link HistoryRecallScope.settle}), in APPEND order.
 */
export interface HistoryScopeSettlement {
  /** The occurrence token when the settled submission was a scope Enter
   *  (`undefined` for every other session-history writer: a Ctrl+S / editor /
   *  extension steer, a bare `!`, a sessionless command, …). */
  readonly token?: number
  /** The session id the row carries (`undefined` = a sessionless row). */
  readonly owner: string | undefined
  /** Whether the row was appended, or skipped by the write policy. */
  readonly outcome: 'written' | 'skipped'
  /** The submitted text (the owner's trimmed row content). */
  readonly text: string
}

/** The kernel's public contract: one short-lived recall projection + scope
 *  ledger per mounted renderer. */
export interface HistoryRecallScope {
  /** Latest-first, defensive snapshot; not a storage authority. */
  snapshot(): readonly string[]
  /** Caller has already applied shouldRememberInput; blank is rejected here. */
  rememberAccepted(text: string): number | undefined
  /** Existing TuiApp.seedInputHistory append semantics (NOT reset). */
  seed(entries: readonly string[]): void
  /** Called ONLY at formal Session publication; may adopt sessionless pool. */
  begin(owner: string | undefined): void
  /** Boot with owner omitted; hydrate/reconcile and close with owner present. */
  reset(entries: readonly string[], owner?: string): void
  /** Actual row owner's synchronous append/skip report, ordered by writer. */
  settle(settlement: HistoryScopeSettlement): void
  /** Relocated existing headless diagnostics; no new production consumers. */
  reconcileStepsForTest(): number
  scopeFactCountForTest(): number
}

/**
 * One accepted submission of the OPEN scope: the owner it was accepted for,
 * the OCCURRENCE token threaded through its submission into the persistence
 * record, and its trimmed text. The token is what makes a settlement
 * attributable to exactly this occurrence even when the same text is submitted
 * several times.
 */
interface ScopeSubmission {
  readonly owner: string | undefined
  readonly token: number
  readonly text: string
}

/** One durable per-occurrence settlement fact of the OPEN scope. */
interface ScopeSettledFact {
  readonly owner: string | undefined
  readonly outcome: 'written' | 'skipped'
  /** The number of the ROW OWNER's appends that preceded this settlement —
   *  its rank among the covered rows, which survives the queue's cap. */
  readonly appendsBefore: number
}

/** Create ONE recall kernel (TSP I-A). */
export function createHistoryRecallScope(): HistoryRecallScope {
  /** The recall projection, newest first — what ↑/↓ can recall and what
   *  {@link HistoryRecallScope.snapshot} reports. */
  const snapshot: string[] = []
  /**
   * The SCOPE-BOUND TEMPORARY SUBMISSIONS of the OPEN scope, in submission
   * order (newest first): one entry per input accepted by
   * {@link HistoryRecallScope.rememberAccepted} for the scope's owner, each
   * carrying its own OCCURRENCE token. A Session's hydration reseeds recall
   * from the session-scoped JSONL rows, while a submission's own append is
   * ordered behind the session transition (the submit FIFO turn and
   * `ensureSession()`), so a submission accepted inside the
   * publication→hydration window is absent from the snapshot and would be
   * wiped by the reseed.
   *
   * The list is the scope's TRUE submission sequence and is never re-ordered
   * or shrunk; the write owner settles OCCURRENCES into
   * {@link scopeSettlements}, never into this list. The whole list is dropped
   * only when the scope is replaced (or consumed by its owner's reseed / the
   * pool's adoption).
   */
  const scopeInputs: ScopeSubmission[] = []
  /**
   * The ordered settlements of the OPEN scope (oldest first): one report per
   * settled submission, produced by the session-history owner from the SAME
   * synchronous stack as its append (or from its policy skip). The order is
   * the APPEND order, which is the file's row order — the authoritative order
   * of the rows the reseed snapshot carries. This queue is bounded, so it is
   * NOT the authority for "was this occurrence settled"; that fact lives in
   * {@link scopeSettled}.
   */
  const scopeSettlements: HistoryScopeSettlement[] = []
  /**
   * The DURABLE per-occurrence settlement fact of the OPEN scope, keyed by the
   * occurrence token: which outcome settled it and the session id its row
   * carried. Bounded by the scope's own occurrences (never by the queue), so a
   * settlement the queue evicted can neither resurrect the occurrence nor lose
   * it.
   */
  const scopeSettled = new Map<number, ScopeSettledFact>()
  /** The LIVE occurrence tokens of the open scope: the durable facts above are
   *  kept for exactly these (bounded by the scope cap, never by the queue). */
  const scopeOccurrences = new Set<number>()
  /** The number of APPENDS this scope's settlements reported per row owner —
   *  the exact watermark of how many of the snapshot's newest rows the window
   *  owns, even for settlements the bounded queue evicted. */
  const scopeAppends = new Map<string | undefined, number>()
  /**
   * The number of positions the last recall reconcile visited — a
   * HEADLESS-TEST HOOK pinning the frozen plan's O(100) bound (never read by
   * production code).
   */
  let reconcileSteps = 0
  /** The next occurrence token (monotonic per process/mount; only equality
   *  matters). */
  let scopeTokenSeq = 0
  /**
   * The owner the OPEN scope's entries were accepted for (`undefined` = the
   * sessionless pool). The pool is a real scope: a deferred start and the
   * Remote startup resume both accept input before any hydration reseeds the
   * recall, and the first published owner ADOPTS the pool's entries (that
   * submission is persisted under the new Session, so the snapshot cannot
   * carry it yet).
   */
  let scopeOwner: string | undefined = undefined
  /** Whether a recall scope is open. Open at construction (the sessionless
   *  pool); closed by the owning owner's hydration reseed commit. */
  let scopeOpen = true

  /** Drop every durable trace of one occurrence the scope no longer holds. */
  const forgetScopeInput = (entry: ScopeSubmission): void => {
    scopeOccurrences.delete(entry.token)
    scopeSettled.delete(entry.token)
  }

  /** The number of runs of consecutive identical text in the scope. */
  const countScopeRuns = (): number => {
    let runs = 0
    let previous: string | undefined
    for (const entry of scopeInputs) {
      if (entry.text !== previous) { runs += 1; previous = entry.text }
    }
    return runs
  }

  /**
   * APPEND entries (newest first) into the recall snapshot with the SAME
   * semantics the PiTui editor + mirror always used: only CONSECUTIVE
   * duplicates collapse, the cap keeps the newest 100. Non-consecutive
   * repeats like `['a', 'b', 'a']` are legal history and survive.
   */
  const appendSnapshot = (entries: readonly string[]): void => {
    let last: string | undefined
    for (const entry of entries) {
      const trimmed = entry.trim()
      if (trimmed === '' || trimmed === last) continue
      last = trimmed
      snapshot.push(trimmed)
    }
    if (snapshot.length > INPUT_RECALL_LIMIT) {
      snapshot.length = INPUT_RECALL_LIMIT
    }
  }

  const snapshotOf = (): readonly string[] => [...snapshot]

  const rememberAccepted = (text: string): number | undefined => {
    const trimmed = text.trim()
    if (trimmed === '') return undefined
    // The snapshot keeps its own consecutive-duplicate rule (the pre-existing
    // editor recall semantics).
    if (snapshot[0] !== trimmed) {
      snapshot.unshift(trimmed)
      if (snapshot.length > INPUT_RECALL_LIMIT) snapshot.pop()
    }
    if (!scopeOpen) return undefined
    // EVERY accepted Enter is an occurrence: a repeat of an earlier submission
    // is not detectable here anyway (a steer can write between two identical
    // Enters), and the consecutive-duplicate compression belongs to the final
    // seed, which sees every writer in append order.
    scopeTokenSeq += 1
    const token = scopeTokenSeq
    const entry: ScopeSubmission = { owner: scopeOwner, token, text: trimmed }
    const head = scopeInputs[0]
    if (head !== undefined && head.text === trimmed) {
      // A consecutive identical submission. Only the run's FIRST occurrence can
      // ever append (every later one hits the CWD-level consecutive dedupe),
      // while the NEWEST one carries the run's newest rank, so exactly those
      // two are kept: a long run of pending duplicates costs O(1) state and can
      // never evict an older, distinct occurrence.
      let runStart = scopeInputs.length
      for (let index = 0; index < scopeInputs.length; index += 1) {
        if (scopeInputs[index]!.text !== trimmed) { runStart = index; break }
      }
      const first = scopeInputs[runStart - 1]!
      const older = scopeInputs.slice(runStart)
      // Every superseded run member except its oldest one goes: the oldest is
      // the only occurrence that can still append.
      for (let index = 0; index < runStart - 1; index += 1) forgetScopeInput(scopeInputs[index]!)
      scopeInputs.length = 0
      scopeInputs.push(entry, first, ...older)
      scopeOccurrences.add(token)
      return token
    }
    scopeInputs.unshift(entry)
    scopeOccurrences.add(token)
    // The cap counts RUNS of consecutive identical text, exactly like the
    // editor/snapshot recall this scope feeds: a long run of duplicates cannot
    // evict an older, distinct occurrence.
    if (countScopeRuns() > INPUT_RECALL_LIMIT) {
      const oldest = scopeInputs[scopeInputs.length - 1]!
      let runStart = scopeInputs.length - 1
      while (runStart > 0 && scopeInputs[runStart - 1]!.text === oldest.text) runStart -= 1
      for (let index = scopeInputs.length - 1; index >= runStart; index -= 1) {
        forgetScopeInput(scopeInputs[index]!)
      }
      scopeInputs.length = runStart
    }
    return token
  }

  const seed = (entries: readonly string[]): void => {
    appendSnapshot(entries)
  }

  /**
   * Record ONE settlement of the OPEN scope, in append order. The input-history
   * owner calls this from the SAME synchronous stack as its append (the detached
   * task's factory is invoked synchronously) and ALSO when its write policy
   * skips a submission, and it carries the submission's occurrence token
   * whenever the settled submission was a scope Enter. That token — not the
   * text — is what attributes the settlement to exactly one occurrence, so
   * repeated identical submissions stay distinguishable, and the ordering of
   * the settled submissions is what places them against every other
   * session-history writer (a steer, a shell line, a sessionless command).
   */
  const settle = (settlement: HistoryScopeSettlement): void => {
    if (!scopeOpen) return
    // The durable facts FIRST: they outlive the queue's cap for every LIVE
    // occurrence, and a late settlement of an already dropped occurrence adds
    // nothing.
    const appendsBefore = scopeAppends.get(settlement.owner) ?? 0
    if (settlement.outcome === 'written') {
      scopeAppends.set(settlement.owner, appendsBefore + 1)
    }
    if (settlement.token !== undefined && scopeOccurrences.has(settlement.token)) {
      scopeSettled.set(settlement.token, {
        owner: settlement.owner,
        outcome: settlement.outcome,
        appendsBefore,
      })
    }
    scopeSettlements.push(settlement)
    if (scopeSettlements.length > INPUT_RECALL_LIMIT) scopeSettlements.shift()
  }

  /**
   * REPLACE the whole recall projection with the entries of the CURRENT
   * workspace. Session switches must not recall the previous workspace's
   * inputs nor pollute the new workspace's persisted history, so the host
   * resets on every session change. The OPEN scope's occurrences ride along:
   * every successful write keeps its own row once, a policy-skipped occurrence
   * is inserted where its settlement placed it, and a still-unsettled
   * occurrence keeps its rank in the scope's submission order. The commit
   * closes the scope, so ordinary submissions use the plain
   * {@link rememberAccepted} path again.
   * @param entries - the new workspace's persisted entries, newest first.
   * @param owner - the owner whose hydration committed this reseed. The
   *   sessionless boot seed passes no owner: it only seeds the recall pool and
   *   leaves the scope open (boot is not a published Session).
   */
  const reset = (entries: readonly string[], owner?: string): void => {
    snapshot.length = 0
    if (owner === undefined) {
      appendSnapshot(entries)
      return
    }
    // The settlements THIS Session's rows produced, in append order, plus the
    // tokens they carry. The snapshot's newest written-count rows are exactly
    // those appends, in reverse: the append order IS the file order, so no text
    // is ever matched to guess which occurrence a row belongs to.
    const settlements = scopeSettlements.filter(settlement => settlement.owner === owner)
    const retainedTokens = new Set<number>()
    let retainedWrites = 0
    for (const settlement of settlements) {
      if (settlement.outcome === 'written') retainedWrites += 1
      if (settlement.token !== undefined) retainedTokens.add(settlement.token)
    }
    // The watermark is the DURABLE append count for this Session's rows, not
    // the retained queue's: the snapshot's newest covered rows are this
    // window's appends in reverse, whether or not their settlements survived
    // the cap.
    const covered = Math.min(scopeAppends.get(owner) ?? 0, entries.length)
    // Occurrence token → rank (0 = newest), built ONCE: every lookup below is a
    // map read, so the reconstruction stays linear in the scope and the window.
    const ranks = new Map<number, number>()
    for (let index = 0; index < scopeInputs.length; index += 1) {
      ranks.set(scopeInputs[index]!.token, index)
    }
    // The window in the DISK order (newest first), each position tagged with
    // the occurrence rank it carries (`undefined` = another writer's row).
    const windowTexts: string[] = []
    const windowRanks: (number | undefined)[] = []
    const windowRows: boolean[] = []
    let writeSeen = 0
    for (let index = settlements.length - 1; index >= 0; index -= 1) {
      const settlement = settlements[index]!
      const rank = settlement.token === undefined ? undefined : ranks.get(settlement.token)
      if (settlement.outcome === 'written') {
        writeSeen += 1
        // Writes older than the recall window have no row in the projection at
        // all (exactly like the baseline snapshot).
        if (writeSeen > covered) continue
        windowTexts.push(entries[writeSeen - 1]!)
      } else {
        if (rank === undefined) continue
        windowTexts.push(scopeInputs[rank]!.text)
      }
      windowRanks.push(rank)
      windowRows.push(settlement.outcome === 'written')
    }
    // The appends whose settlements the cap evicted are the OLDER window rows:
    // their rows are still part of the projection and must be emitted in the
    // disk order, with no occurrence association (their own facts stay in the
    // map).
    for (let row = retainedWrites; row < covered; row += 1) {
      windowTexts.push(entries[row]!)
      windowRanks.push(undefined)
      windowRows.push(true)
    }
    // The occurrences the window does not carry, in submission order (newest
    // first): a never-settled occurrence is NEWER than every settled submission
    // of the writers that share the submit turn, while an occurrence whose
    // settlement the cap evicted was settled strictly BEFORE every retained
    // one, so it expires BEHIND the whole window.
    const before: number[] = []
    const after: { readonly rank: number; readonly newerRows: number }[] = []
    for (let index = 0; index < scopeInputs.length; index += 1) {
      const token = scopeInputs[index]!.token
      if (retainedTokens.has(token)) continue
      const settled = scopeSettled.get(token)
      if (settled === undefined) before.push(index)
      else if (settled.outcome === 'skipped' && settled.owner === owner) {
        // A skip the queue evicted keeps its rank: it sits after the appends
        // that preceded it, so its boundary is a ROW count inside the covered
        // window (never negative: every append adds a session row, so the
        // covered count is at least the appends that preceded it — a zero
        // boundary means the skip is newer than every covered row and belongs
        // in front of them).
        after.push({ rank: index, newerRows: covered - settled.appendsBefore })
      }
    }
    // The most recent skip first: its boundary is the smallest row count, so an
    // ASCENDING cursor reaches each boundary in turn.
    after.sort((left, right) => (left.newerRows - right.newerRows) || (left.rank - right.rank))
    // ONE ordered cursor: an occurrence the window does not carry is emitted
    // just before the first position that is another writer's row or an older
    // occurrence — no search inside either loop.
    reconcileSteps = 0
    const merged: string[] = []
    let next = 0
    let rowsSeen = 0
    let skipped = 0
    // A skip whose settlement the cap evicted: every one of them settled before
    // every RETAINED settlement, and it belongs after the rows that preceded it.
    const emitEvictedSkips = (upTo: number): void => {
      while (skipped < after.length && after[skipped]!.newerRows <= upTo) {
        merged.push(scopeInputs[after[skipped]!.rank]!.text)
        skipped += 1
      }
    }
    for (let index = 0; index < windowTexts.length; index += 1) {
      reconcileSteps += 1
      const windowRank = windowRanks[index]
      while (next < before.length && (windowRank === undefined || before[next]! < windowRank)) {
        reconcileSteps += 1
        merged.push(scopeInputs[before[next]!]!.text)
        next += 1
      }
      // A skip that settled before this position's append belongs here.
      emitEvictedSkips(rowsSeen)
      merged.push(windowTexts[index]!)
      if (windowRows[index] === true) {
        rowsSeen += 1
        emitEvictedSkips(rowsSeen)
      }
    }
    while (next < before.length) {
      reconcileSteps += 1
      merged.push(scopeInputs[before[next]!]!.text)
      next += 1
    }
    emitEvictedSkips(covered)
    appendSnapshot([...merged, ...entries.slice(covered)])
    scopeInputs.length = 0
    scopeSettlements.length = 0
    scopeSettled.clear()
    scopeOccurrences.clear()
    scopeAppends.clear()
    scopeOpen = false
    scopeOwner = owner
  }

  /**
   * Open the RECALL SCOPE of the owner a commit section is publishing (ordinary
   * transition, fork adoption) or creating (the first Session). The owner's
   * hydration reseeds recall from its disk rows afterwards, so inputs accepted
   * in that gap belong to the new owner and must survive the reseed.
   * A REPLACED owner's pending submissions are dropped with the scope — that is
   * what keeps Session A's input out of Session B's recall — while the
   * SESSIONLESS pool's entries are ADOPTED by the first published owner (that
   * submission is persisted under the new Session; there is no outgoing owner
   * to fence).
   */
  const begin = (owner: string | undefined): void => {
    if (scopeOwner !== undefined) {
      // A REPLACED owner: its occurrences are dropped with the scope.
      scopeInputs.length = 0
      scopeSettlements.length = 0
      scopeSettled.clear()
      scopeOccurrences.clear()
      scopeAppends.clear()
    }
    // The OUTGOING recall pool never survives into the newly published owner.
    // This seam runs AFTER the publication committed (never in the
    // possibly-failing pre-publication phase), while the new owner's hydration
    // reseed only lands later, so without this both a replaced Session's rows
    // AND the boot recall of the CWD history (the FIRST Session's creation has
    // no previous owner) would stay recallable in the meantime. The open
    // scope's own occurrences are re-seeded here, so an input already accepted
    // for this owner stays recallable until the reconcile folds it over the
    // snapshot.
    snapshot.length = 0
    // Only what this owner can still own: an occurrence whose row was already
    // written under ANOTHER identity (a sessionless local command, say) is
    // settled and must not appear in this Session's recall even for a moment;
    // an occurrence that is merely unpersisted belongs to this owner and stays.
    appendSnapshot(scopeInputs
      .filter(entry => {
        const settled = scopeSettled.get(entry.token)
        // Cross-Session visibility follows the SETTLEMENT's identity, never
        // whether a row happened to be written: a sessionless occurrence the
        // policy skipped is just as foreign as a sessionless row.
        return settled === undefined || settled.owner === owner
      })
      .map(entry => entry.text))
    scopeOwner = owner
    scopeOpen = true
  }

  return {
    snapshot: snapshotOf,
    rememberAccepted,
    seed,
    begin,
    reset,
    settle,
    reconcileStepsForTest: () => reconcileSteps,
    scopeFactCountForTest: () => scopeSettled.size,
  }
}
