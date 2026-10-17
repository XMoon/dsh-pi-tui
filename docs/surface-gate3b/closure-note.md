# Gate-3B Closure Note — 2026-10-16

**Status:** `PENDING_MANUAL` / `NOT_READY_FOR_UNQUALIFIED_ACCEPTANCE`. This is an evidence closure record, not Gate Owner acceptance and not Phase 3C authorization.

## Provenance and contract

- Integration branch: `audit/gate3b-closure-20261016`, based on the verified `origin/next` tree. The exact immutable baseline/current revision is recorded in the PR body, not `docs/**`.
- DSH mode/version: npm / `0.2.0-rc.2`; Direct is production default; Remote remains experimental.
- Contract: the Phase 3B accepted Overall, the detailed Gate-3B closure execution plan, the current `docs/surface-decisions.md`, `docs/tui-design-language.md`, `docs/keybinding-architecture.md`, `docs/client-server-migration.md`, `docs/client-server-coupling.md`, `docs/overlay-focus-contract.md`, and `docs/code-review.md`.
- Gate-3A independent Owner acceptance: `UNKNOWN` in the checked repository artifact set; Owner confirmation is still required. Gate-3B Owner decision: `PENDING` until explicit action.
- Merged scope: B1 PRs #286/#289/#292/#293; B2 #295/#300; B3 #302/#307; B4 #311/#318/#319. No Phase 3C implementation, vendor source change, new public API or Remote GA claim is included.

## Thirteen acceptance IDs

Automated details and source/test traces are in the [evidence matrix](evidence-matrix.md) and [qualification log](qualification-log.md). `PASS_AUTOMATED` denotes current-worktree automated evidence only; it is not a manual pass, Owner waiver, or Gate acceptance. The initial `verify:prepush` failure and post-fix sublane results are recorded explicitly.

| ID | Automated conclusion | Manual status | Remaining qualification note |
|---|---|---|---|
| J-01 | PASS_AUTOMATED | M-02 `NOT_RUN` | Retained output/status/gap/settlement and observer lifecycle are covered by Direct and Remote application tests. |
| J-02 | PARTIAL | M-01 `NOT_RUN` | Same-run official Bash/Pwsh producer→Registry→Direct→Copy All is present; Remote Host/Client→Command Copy All is separately present, but Remote same-run producer attribution is not proven. Shell execution is controlled. |
| J-03 | PASS_AUTOMATED | M-01/M-06 `NOT_RUN` | Exact selection/retained Output copy and stale/clipboard controls are automated; native clipboard/OSC52 remains open. |
| J-04 | PASS_AUTOMATED | M-02 `NOT_RUN` | Follow pause/search/Esc/End and Remote retained reader are automated; physical terminal navigation remains open. |
| S-01 | PASS_AUTOMATED | M-07 `NOT_RUN` | Responsive Settings reachability is VT-qualified; physical glyph/theme behavior remains open. |
| S-02 | PASS_AUTOMATED | M-03 `NOT_RUN` | Real Remote/Direct Host write/reread and same-field parity are automated; no real operator profile write was performed. |
| H-01 | PASS_AUTOMATED | M-04/M-06 `NOT_RUN` | Search, preview and exact-source copy are automated; IME/system clipboard remain open. |
| H-02 | PASS_AUTOMATED | M-04 `NOT_RUN` | Enter-without-submit and Esc draft/cursor restoration are automated; native IME remains open. |
| H-03 | PASS_AUTOMATED | M-04 `NOT_RUN` | Question/Approval PARK/REFUSE/FIFO and stale-callback behavior are automated; native focus/IME evidence remains open. |
| Q-01 | PASS_AUTOMATED | M-05 `PARTIAL`; M-07 `NOT_RUN` | One Main 80×24 tmux frame is captured; trusted widget and full terminal layouts remain open. |
| Q-02 | PASS_AUTOMATED | M-04 `NOT_RUN`; M-05 `PARTIAL` | X063 visual-boundary and host key routing are automated; real IME/widget environment and full M-05 matrix remain open. |
| Q-03 | PASS_AUTOMATED | M-05 `PARTIAL`; M-07 `NOT_RUN` | Footer preflight and typed Full action are automated; the limited tmux capture did not verify activation; physical widget/CJK frames remain open. |
| X-01 | PASS_AUTOMATED | M-02..M-04/M-06..M-07 `NOT_RUN`; M-05 `PARTIAL` | Cross-surface lifecycle/currentness is automated; native clipboard, IME, widget and remaining terminal evidence is open. |

## Owner, focus, currentness and compatibility invariants

- **Job:** one observer per selected workspace; Command copy comes from official command label bytes; retained Output is not a full archive; UI observation never consumes `jobs.read()`.
- **Settings:** success requires Host write and authoritative reread; refused and unverified outcomes remain distinct; unrelated USER fields are not pinned.
- **History:** active tenant and editor winner remain authoritative; Question/Approval blocks or parks History under the broker contract; stale callbacks cannot steal focus or restore an obsolete editor.
- **Task Quick:** hidden means zero rows; X063 is the visual-boundary authority; admission uses the hint-enabled Footer candidate; Full is a typed action; preserve the accepted Main Root 80×8 flowing exception and do not reduce widget grants.
- **Backend/root/extension/vendor:** Direct stays production; Remote stays experimental; Main and Fullscreen retain their separate budgets; no public Extension or vendored source change is made.

## Frozen-tree verification and review

- Environment, targeted results, the initial `verify:prepush` failure and its corrected sublane results, plus the required local gate ledger: [qualification log](qualification-log.md). The full PR CI run remains pending.
- Native manual checks: `M-01..M-04` and `M-06..M-07 NOT_RUN`; `M-05 PARTIAL` with a limited tmux witness; no Owner waiver. See [manual checklist](manual-terminal-checklist.md) and [qualification log](qualification-log.md).
- Independent reviewer: `ACCEPTED` for this PR/evidence artifact only; see [review findings](review-findings.md). This does not grant Gate Owner acceptance or waive manual qualification.

## Closure axes and Owner decision

- Contract: `PARTIAL` — the 13 IDs and current approved deltas are retained, but the separate Gate-3A Owner acceptance record is `UNKNOWN`.
- Implementation: `PASS` — current merged B1–B4 product source is unchanged; the corrected bundle typecheck and product suite passed, and the initial `verify:prepush` failure is recorded.
- Qualification: `PARTIAL` — automated results are recorded, but material M cases remain `NOT_RUN`, and J-02 Remote producer attribution remains partial.
- Surface/reachability: `PARTIAL` — automated user-reachable flows exist; native terminal/clipboard/IME/widget checks remain unavailable.
- Independent review: `ACCEPTED` for this PR/evidence artifact only.
- Gate-3B Owner decision: **PENDING UNTIL EXPLICIT USER ACTION**. No acceptance, scoped waiver, or authorization for Phase 3C is inferred from this note, CI, PR approval, or reviewer acceptance.
