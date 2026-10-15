# PR4-B1-A Session Browser read-path evidence

This record covers the internal, read-only Session Browser Presenter and its
`SessionReader` owner. The frozen plan is
`temp/tern_ux/dsh-pi-tui-tsp-pr4-b1-a-session-browser-read-path-implementation-plan-v1-20261015.md`
(worktree-local). The user-visible command/admission and real Session transition
remain B1-B work.

Evidence files and screenshots are generated per run under the ignored
`temp/tern-pane-*` worktree paths; they are not committed. This document records
the stable coverage and evidence tier, not a GUI or merge approval.

## Authority and scope

- List membership/current ID comes from `SessionReader.list`; title/preset
  enrichment comes from `projectionBatch`; content excerpts and `hasMore` come
  from `SessionReader.search`. The same read owner feeds the production TSP
  Presenter in the integrated Direct and headless flows.
- No new Session writer, `switchSession` call, transition, production command,
  slash-command admission, public API, or `SessionReader` signature was added.
  `/sessions`, `/resume`, and `/search` remain outside B1-A's production
  reachability.
- `TSP Planning Protocol v3`: **NOT_VERIFIED**. This workspace did not provide
  the protocol document; no compliance claim is made.

## Frozen-plan matrix

| Plan item | Result | Evidence |
|---|---|---|
| R01 — list, main rows, Current vs selection, unavailable/empty/error | PASS | `tern-tsp-session-browser-read.test.ts`: `listing unavailable, empty, and list failure remain distinct`; `tern-tsp-session-browser.test.ts`: native tree and Current/selected assertions. Subagents and unlisted rows do not become rows. |
| R02 — projection enrichment, stable Picker, stale batch | PASS | Read-owner projection tests; `55-row projection batches keep the native Picker identity and selected row` exercises the initial and subsequent batches and late enrichment; close/retire rejects late projection. |
| R03 — workspace scope and lineage | PASS — Owner accepted contiguous workspace-run groups | `tern-tsp-session-browser.test.ts` verifies same-workspace parent grouping, A→B→A repeated groups, unique run IDs, original depth, and orphan/cycle membership without duplication; the Direct integration test verifies the persisted A→B→A chain through DirectSessionReader → read owner → production Picker order. A real Tern 0.8.3 screenshot drives the production Presenter with those DirectReader-output rows and shows the repeated A headings in parent-first order. The isolated child rows are official persisted parentSession/isSeeded headers, not a cross-CWD `SessionStore.fork()` execution; current `SessionStore.fork()` inherits its source cwd. The Owner explicitly accepted contiguous grouping and repeated headings; global workspace reordering remains forbidden. |
| R04 — canonical query, debounce, global Cards, content-only hit | PASS | Controlled timer test pins the 250 ms boundary; integrated read + Presenter test keeps a Host content-only hit whose metadata does not match; real Tern headless flow paints the Host result and excerpt. |
| R05 — metadata/Host union order and snippets | PASS | Read-owner test checks metadata list order, Host-only page order, deduplication, `Metadata`/`Content`/`Both`, and Host-owned snippets; existing PiTui session-search regression remains in scope. |
| R06 — unavailable/error content search with local metadata retained | PASS | Read-owner unavailable/error tests and native empty-metadata/unavailable state test distinguish ordinary no-match from unavailable content search; combined projection-failure tests keep Host loading, unavailable, error, and `hasMore` status visible. |
| R07 — `hasMore`, canonical cap/sanitizer, no duplicate query | PASS | Session helper test covers NUL, whitespace, 500-unit cap and a surrogate pair crossing the cap; timer-controlled read-owner test checks canonical query and no duplicate Host request; `hasMore` is a refine hint only. |
| R08 — query generation, close/reopen/dispose, no stale results | PASS | Deferred read-owner tests exercise X/Y, close and dispose during active search, reopening during active search, late list/projection/search resolution, aborted signals, and subject retirement. |
| R09 — browse/search/details/back, identity and scroll epoch | PASS | Native test preserves query/selection on Back/Esc, keeps one Picker ID across enrichment, uses a new Details body identity per reading, and rejects a retired Back target. |
| R10 — selection-only pointer and intent-only activation | PASS | Native test checks selection independently from Current and records only test-observable `activate`/Enter intents; Direct and real-client flows do not switch sessions or write. Footer Resume has the Owner-requested primary visual marker but remains disabled; its offered action does not dispatch a Resume intent. |
| R11 — capability and Reader scroll | PASS | Capability negatives refuse missing kinds/`scroll` and produce no scroll op; native tests target the current Reader body; Tern 0.8.3 headless flow checks the 400×440 Reader tail. |
| R12 — modal priority/exclusivity and retired input | PASS | Renderer integration suspends/restores Browser state around the modal seat, verifies Model/Browser/Preset exclusivity, rejects a retired Browser panel event, and checks that disposal clears all three exposed presenter getters. |
| R13 — no command admission or PiTui behavior change | PASS (scope) | No command/route registration or existing session command implementation changed. Existing command-admission and PiTui session-picker behavior are unchanged; their validation is recorded with the final PR gates. |
| R14 — visual qualification | PARTIAL; rerun production-Presenter matrix for Owner-requested primary Resume styling | A real Tern 0.8.3 production-Presenter multi-viewport Headless matrix passed before the Owner requested primary styling for disabled Resume. That matrix does not qualify this final footer styling, so it must be rerun. `REAL_TERN_GUI`, physical GUI/IME/wheel/theme, and Owner final screenshot sign-off remain **NOT_VERIFIED**. |
| R15 — Direct persisted main Session → same Presenter | PASS | `tern-tsp-session-browser-direct.test.ts` exercises a cold persisted main Session through the real Direct `SessionReader`, read owner, and native TSP Presenter rather than a precomputed capability flag. |
| R16 — Remote read-only semantics | UNKNOWN | No runnable Remote TSP fixture was available for this slice. No Remote Session switch or new Remote wire is claimed. |

The full production-Presenter matrix on the preceding snapshot was
**REAL_TERN_HEADLESS**, not `REAL_TERN_GUI`, and not a real Session switch. It
verified pointer selection-only behavior, Home/End selection with an independent
Current marker, native Tree/Card painting, the Host content-only result/snippet,
and the Reader scroll body/tail across multiple viewports. The Owner-requested
primary styling for disabled Resume arrived after that run, so its screenshots
do not qualify the current delta. PageUp/PageDown could not be delivered by the
available `tern ctl key` path; physical/client PageUp/PageDown remains
**NOT_VERIFIED**.

The F1 study drives the production Presenter with DirectReader-output A→B→A rows
and qualifies the Owner-selected grouping at one viewport; it does not certify
the current multi-viewport presentation or settle any B1-B write-enabled UX
decision.

## Validation record

The feature-specific read-owner, native wire, Direct integration, sanitizer,
and real Tern headless lanes are recorded in the PR work log. The reproducible
commands and evidence-tier definitions are listed in
[Session Browser contract](../session-browser.md). The required repository-wide
build, typecheck, product suite, architecture/boundary gates, and final review
must be reported against the same frozen delivery tree; a test count, commit
identifier, or a green lane from an earlier tree is not evidence for a later
revision.
