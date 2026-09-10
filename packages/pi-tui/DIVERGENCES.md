# pi-tui divergence ledger

> Generated from `packages/pi-tui/vendor-divergences.json` (schema v2). Do not hand-edit this report; change the structured ledger and run `pnpm generate:pi-divergences`.
>
> The ledger records current consumers, structural and behavioral dependencies, semantic upstream comparison, and evidence required before a divergence can be retired.

## Baseline

- Upstream repository: `earendil-works/pi`
- Package: `packages/tui`
- Tag: `v0.85.1`
- Pinned commit: `d981de1229ef899957bbe968bc8dcda02a21f477`

## Audit snapshot

- Audited local source commit: `ba36a689d9bb8c90bf3ffdf5e210d818c2419cb8`
- Branch audited: `chore/revendor-pi-tui-v0.85.1`
- Audit date: `2026-09-09`
- Upstream reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Kimi reference snapshot: `MoonshotAI/kimi-code@9e881528a89945a373002b0b229f91735e8f2c4f`
- Snapshot policy: Reference snapshots and auditedSourceCommit are audit evidence, not continuous views of repository HEAD. Refresh them only during an explicit re-vendor, divergence re-audit, retirement evaluation, or upstream-equivalence review.

- PR3 re-vendor audit: replaced the Earendil packages/tui baseline with exact v0.85.1 (d981de1), re-audited every source-active divergence against the new baseline, re-applied only retained DSH seams, adopted the upstream renderer, mouse, search, Loader and terminal changes, and validated the current Host question/transcript/focus/input surfaces against the immutable source snapshot recorded in verification.auditedSourceCommit.

## Audit rules

- Do not mark a record unused until vendor-internal, inheritance/structural, host, public/extension, behavioral, and test/runtime ownership have all been audited.
- `YES` means semantic equivalence, not merely a matching symbol or a closed issue. `PARTIAL` and `NO` cannot be absorbed.
- Every record has explicit dependency classes. An empty class means absence was audited, not that the audit was skipped.
- Active records have retirement conditions. Non-active records retain retirement evidence; removed records must have no dependency evidence left.
- Source coverage remains enforced by `pnpm gate:pi-vendor-diff --strict`; schema, retirement rules, and report drift are enforced by `pnpm gate:pi-divergence-ledger`.

## Category definitions

- `HARD_HOST_API`: A vendor API required by host routing, lifecycle, terminal, or process ownership.
- `PUBLIC_COMPONENT_CONTRACT`: A component method or shape observable by package consumers or host adapters.
- `LOCAL_UX`: A product interaction behavior retained for DSH UX rather than generic upstream parity.
- `BUGFIX_MISSING_UPSTREAM`: A correctness or robustness fix absent from the pinned upstream behavior.
- `PERF_HOST_DEPENDENT`: A measured render, layout, allocation, or workload performance contract.
- `PACKAGING`: A package shell, build, export, native-module, or artifact-resolution contract.

## Gate policy

- sourceCoverage: Every changed packages/pi-tui/src TypeScript file must be covered by a source-active ledger record.
- staleActive: Source-active records whose listed source files all match the pinned baseline warn by default and fail in strict mode.
- historicalRecords: ABSORBED_UPSTREAM, MOVED_TO_HOST, SUPERSEDED, and REMOVED_UNUSED records remain auditable but do not provide source coverage; REDUNDANT_SHIM remains source-active until its atomic replacement is proven.
- packagingPaths: Non-src paths such as X025 remain registered in the ledger and are ignored by the src-only diff walk.
- referenceSnapshotPolicy: Reference snapshots and auditedSourceCommit are audit evidence, not continuous views of repository HEAD. Refresh them only during an explicit re-vendor, divergence re-audit, retirement evaluation, or upstream-equivalence review.
- Upstream resolution:
  - PI_UPSTREAM_REPO checkout containing the pinned commit
  - known local ~/project/pi checkout
  - codeload tarball fallback via PI_UPSTREAM_TARBALL or PI_UPSTREAM_CURL

## Host relocation audit

- `DROPPED`: `X013` — No known in-repo vendor, host, public, or behavioral consumer remains; external use of this private package behavior is unverified. The host busy indicator is WorkingIndicator.
- `DELIBERATELY_KEPT`: `X030` — A host copy of decodePrintableKey would duplicate the implementation; the package exports map exposes only the root entry.
- `MOVED_TO_HOST`: `X001`, `X002`, `X041` — The DSH searchable picker behavior moved to the Host-owned src/searchable-picker.ts SearchablePicker (guarded by test/searchable-picker.test.ts); the vendored SelectList is restored to the pinned upstream baseline.
- `NOT_MOVABLE`: `X042` — The remaining X042 seam is SettingsList focus/row-budget propagation inside the vendored fork; the SelectList-side Input focus ownership moved to the Host SearchablePicker.
- `NOT_MOVABLE`: `X004A`, `X004B`, `X005`, `X006`, `X007`, `X008`, `X009`, `X010`, `X014`, `X016`, `X018`, `X020`, `X021`, `X022`, `X023`, `X024`, `X025`, `X027`, `X028`, `X029`, `X031`, `X032`, `X033`, `X034`, `X035`, `X036`, `X037`, `X038`, `X039`, `X040`, `X043`, `X044`, `X045`, `X046`, `X047` — The behavior is vendor-internal, terminal-owned, protocol-owned, performance-owned, or requires metadata unavailable at a host wrapper boundary.
- `UPSTREAM_LEVER`: `X005`, `X006`, `X007`, `X008`, `X014`, `X016`, `X021`, `X033`, `X035`, `X048`, `X049`, `X050`, `X051` — Generic improvements may be proposed upstream; an upstream issue or similar implementation is not absorption evidence.
- `SUPERSEDED`: `X012`, `X019` — X012's explicit fuzzy tie-break is redundant under the supported stable-sort runtime contract; X019's Text no-op dispose shim is replaced by Loader-owned X007 cleanup without a base super call.
- `ABSORBED_UPSTREAM`: `X011` — Earendil v0.85.1 clips Input prompts at extremely narrow widths; direct width-0/1 regressions guard the absorbed behavior.
- `NOT_MOVABLE`: `X048` — Input prompt mouse click geometry is a public component contract inside the vendored fork; a host wrapper cannot equivalently fix the Input's own coordinate mapping, and the fix depends on visibleWidth(this.prompt) which is vendor-internal.
- `NOT_MOVABLE`: `X049` — AltScreenSearchComponent owns its PRIVATE query Input; the host cannot reach or rewire that Input, so the mouse-forwarding seam must live inside the vendored fork's alt-screen search component.
- `NOT_MOVABLE`: `X050` — Editor visual-line/wrapped-segment cursor mapping and slash-autocomplete click-submit are internal Editor semantics (two distinct bugs confirmed against upstream v0.85.1 and main); they cannot be reproduced through the public Editor surface from a host wrapper.
- `NOT_MOVABLE`: `X051`, `X052` — Container/Box focus-ownership and input/key-release forwarding is a public component/framework contract inside the vendored fork (the TUI routes keyboard to the focused component and filters key releases by wantsKeyRelease); a host wrapper cannot change how the fork's own focus model resolves overlay roots. X052: SelectList mouse hit-testing is a public built-in component contract inside the vendored fork (setFilter/setSelectedIndex + mouse click are documented capabilities); a host wrapper cannot change how the fork's own component resolves a press/click against its rows, and the fix depends on render-time row identity which is vendor-internal.

## Removed or superseded legacy surfaces

- `inlineSlashTrigger and inline-slash helpers` — `PRODUCT_DECISION`: The host uses explicit, context-gated Tab completion; the old opt-in inline dropdown is not part of DSH UX.
- `setHistoryFilter` — `PRODUCT_DECISION`: DSH recall is mode-agnostic by design; shell-mode history filtering is a separate parity feature.
- `setText preservePasteRegistry option` — `SUPERSEDED`: X023 canonical staging prunes surviving markers and releases vanished entries without a manual opt-in flag.
- `AutocompleteProvider additionalBasePaths` — `NO_HOST_CONSUMER`: MentionProvider owns multi-root fan-out through HostFilePort rather than the old provider option.
- `inlineSkill Enter carve-out` — `PRODUCT_DECISION`: DSH has no mid-prompt inline-skill token; slash commands submit on Enter.
- `getLayoutRoot` — `NO_CONSUMER`: No vendor or host call path was found.
- `WIDTH_CACHE_SIZE 512` — `RESTORED_AS_X039`: Retained as active X039 pending an isolated reproducible 4096-versus-512 CJK burst benchmark; the current X035 benchmark's incidental CJK lines do not establish a benefit.

## Summary

- Records: 53
- Statuses: `ABSORBED_UPSTREAM`: 4, `ACTIVE`: 42, `MOVED_TO_HOST`: 3, `REMOVED_UNUSED`: 2, `SUPERSEDED`: 2

| ID | Status | Risk | Categories | Upstream equivalence |
| --- | --- | --- | --- | --- |
| X001 | MOVED_TO_HOST | HIGH | HARD_HOST_API, PUBLIC_COMPONENT_CONTRACT | NO |
| X002 | MOVED_TO_HOST | HIGH | HARD_HOST_API | NO |
| X003 | REMOVED_UNUSED | HIGH | BUGFIX_MISSING_UPSTREAM | YES |
| X004A | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X004B | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X005 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | PARTIAL |
| X006 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X007 | ACTIVE | CRITICAL | HARD_HOST_API, PUBLIC_COMPONENT_CONTRACT | NO |
| X008 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X009 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X010 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X011 | ABSORBED_UPSTREAM | MEDIUM | BUGFIX_MISSING_UPSTREAM | YES |
| X012 | SUPERSEDED | LOW | BUGFIX_MISSING_UPSTREAM | YES |
| X013 | REMOVED_UNUSED | MEDIUM | BUGFIX_MISSING_UPSTREAM | YES |
| X014 | ACTIVE | MEDIUM | PERF_HOST_DEPENDENT | NO |
| X015 | ABSORBED_UPSTREAM | LOW | BUGFIX_MISSING_UPSTREAM | YES |
| X016 | ACTIVE | CRITICAL | BUGFIX_MISSING_UPSTREAM | NO |
| X017 | ABSORBED_UPSTREAM | LOW | LOCAL_UX | YES |
| X018 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X019 | SUPERSEDED | HIGH | HARD_HOST_API, PUBLIC_COMPONENT_CONTRACT | PARTIAL |
| X020 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X021 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | PARTIAL |
| X022 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X023 | ACTIVE | CRITICAL | HARD_HOST_API, PUBLIC_COMPONENT_CONTRACT | NO |
| X024 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X025 | ACTIVE | HIGH | PACKAGING | NO |
| X026 | ABSORBED_UPSTREAM | MEDIUM | HARD_HOST_API | YES |
| X027 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X028 | ACTIVE | CRITICAL | HARD_HOST_API | NO |
| X029 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X030 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X031 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X032 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X033 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X034 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X035 | ACTIVE | HIGH | PERF_HOST_DEPENDENT | NO |
| X036 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X037 | ACTIVE | CRITICAL | HARD_HOST_API, PUBLIC_COMPONENT_CONTRACT | NO |
| X038 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X039 | ACTIVE | MEDIUM | PERF_HOST_DEPENDENT | NO |
| X040 | ACTIVE | HIGH | PUBLIC_COMPONENT_CONTRACT | NO |
| X041 | MOVED_TO_HOST | HIGH | HARD_HOST_API, PUBLIC_COMPONENT_CONTRACT | NO |
| X042 | ACTIVE | HIGH | PUBLIC_COMPONENT_CONTRACT | NO |
| X043 | ACTIVE | CRITICAL | HARD_HOST_API | NO |
| X044 | ACTIVE | HIGH | HARD_HOST_API | NO |
| X045 | ACTIVE | CRITICAL | HARD_HOST_API | NO |
| X046 | ACTIVE | CRITICAL | HARD_HOST_API | NO |
| X047 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |
| X048 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X049 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X050 | ACTIVE | MEDIUM | BUGFIX_MISSING_UPSTREAM | NO |
| X051 | ACTIVE | MEDIUM | PUBLIC_COMPONENT_CONTRACT | NO |
| X052 | ACTIVE | HIGH | BUGFIX_MISSING_UPSTREAM | NO |

## Divergences

### X001 — SelectList searchable/grouped picker

- Status: `MOVED_TO_HOST`
- Category: `HARD_HOST_API`, `PUBLIC_COMPONENT_CONTRACT`
- Risk: `HIGH`
- Files: `src/components/select-list.ts`
- Last audited: `2026-09-07`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host needs searchable, grouped, pageable, and responsively bounded pickers while a picker is live. Upstream 0.84.4 only provides the basic value list and cannot preserve this host state.

#### Changed surface

- SelectListOptions search/header/no-match settings
- SelectItem groups and group-header rendering
- substring filtering, PageUp/PageDown, setMaxRows, and zero-match navigation

#### Dependency map

**Vendor internal**
- SelectList filtering, selection movement, group headers, and render budget share the active query and visible-window state.
- Audit note: The search Input and list navigation are coupled inside the component.

**Inheritance / structural**
- None found (audited).
- Audit note: No subclass or super edge for the searchable semantics was found; Focusable forwarding is recorded separately under X042.

**Host**
- src/tui-app.ts openPicker and categorized picker rebuild (now Host SearchablePicker)
- src/commands.ts session picker via the TuiApp picker surface (PickerItem/PickerCategory; no direct SelectList import)
- advanced ui.select picker adapter
- Audit note: The Host consumers exercise query, grouping, dynamic rows, and row budgets through TuiApp.openPicker/openCategorizedPicker, which now construct the Host SearchablePicker; the model picker in src/model-menu.ts and footer/configurator.ts are host-owned SettingsList/Input flows, not X001 consumers. The vendor Editor's autocomplete construction is upstream-compatible and is not counted as a consumer of the extended semantics.

**Public / extension**
- Advanced ui.select and picker adapter contracts expose the searchable picker behavior to host-owned integrations.
- Audit note: The package root exports SelectList as a public component.

**Behavioral coupling**
- query preservation across setItems and category changes
- group headers and descriptions consume the same row budget
- zero-result navigation is a no-op while search input remains usable
- vendor Editor autocomplete uses only the upstream-compatible basic SelectList shape and does not prove dependency on search/group/setItems/filter semantics
- Audit note: A type-compatible upstream list would still change host picker navigation and query behavior, even though the vendor Editor's basic autocomplete path would remain type-compatible.

#### Guarding tests

- test/searchable-picker.test.ts: search, groups, paging, setFilter, and zero-match navigation
- test/session-picker-loading.test.ts and picker integration coverage
- test/session-categories.test.ts: categorized picker query carry
- test/sessions.test.ts: PickerHandle.setItems and initialQuery
- test/advanced-broker.test.ts and test/advanced-cordis-lifecycle.test.ts: ui.select picker lifecycle

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/select-list.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference SelectList do not provide the host's combined search, grouping, dynamic setItems, and row-budget contract; Kimi's SearchableList is a separate state-object design, not an upstream equivalent.

#### Retirement conditions

- Provide a semantically equivalent upstream searchable/grouped list, or complete a host-owned picker migration covering query, grouping, dynamic rows, selection identity, paging, and advanced ui.select behavior.
- Run host picker, extension surface, narrow-budget, and zero-result interaction tests after the migration.

#### Replacement mapping

- SelectList search/group/page/row-budget behavior -> Host owner src/searchable-picker.ts SearchablePicker -> guarded by test/searchable-picker.test.ts
- TuiApp openPicker/categorized picker -> Host SearchablePicker API -> existing PickerHandle remains the Host-facing adapter
- advanced ui.select -> TuiApp.openPicker -> SearchablePicker -> advanced broker/lifecycle tests

#### Retirement evidence

- packages/pi-tui/src/components/select-list.ts restored byte-identical to pinned upstream b79e4cc (diff empty)
- test/searchable-picker.test.ts green: search, groups, page keys, zero-match navigation, row budget
- test/session-picker-loading.test.ts, test/session-categories.test.ts, test/sessions.test.ts, test/advanced-broker.test.ts, test/advanced-cordis-lifecycle.test.ts green
- fork typecheck/test/build, surface compat, divergence ledger, strict vendor diff, root build/typecheck/test:bundle green

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Relocated to the Host-owned SearchablePicker (src/searchable-picker.ts) with the vendored SelectList restored to the pinned upstream baseline; the fork no longer carries this divergence.

### X002 — SelectList setItems selection/search preservation

- Status: `MOVED_TO_HOST`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/components/select-list.ts`
- Last audited: `2026-09-07`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Open host pickers receive asynchronously enriched rows and must refresh without losing the active query or a surviving selected value.

#### Changed surface

- setItems(items) replaces rows while preserving a surviving selection by value
- setItems reapplies the canonical active filter and recalculates the visible window

#### Dependency map

**Vendor internal**
- setItems calls the same filter and selection-window logic used by keyboard navigation.
- Audit note: The replacement operation is not an isolated setter.

**Inheritance / structural**
- None found (audited).
- Audit note: No inheritance edge was found for setItems.

**Host**
- src/tui-app.ts session and categorized SearchablePicker refreshes
- src/commands.ts asynchronous session-title enrichment
- Audit note: Host updates session/category rows while overlays remain mounted; the model picker is SettingsList-owned and is not counted as an X002 SelectList consumer.

**Public / extension**
- SearchablePicker.setItems is the Host dynamic-row API (via the TuiApp PickerHandle); the restored vendored SelectList no longer exposes setItems.
- Audit note: The host PickerHandle dynamic-row API lives in src/tui-app.ts, not the extension AdvancedSelectOptions contract.

**Behavioral coupling**
- selection-by-value survives row enrichment
- active query survives replacement
- zero-match and group-header layout remain bounded
- Audit note: Restoring upstream loses state during a live refresh even when types still pass.

#### Guarding tests

- test/searchable-picker.test.ts: setItems and selected-by-value/search preservation
- test/session-picker-loading.test.ts: asynchronous title refresh/query preservation
- test/sessions.test.ts: setItems with default selection
- test/searchable-picker.test.ts covers the moved-selection refresh regression (non-default selected row during enrichment)

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/select-list.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream 0.84.4 has no setItems operation with query and selection preservation; the audited upstream reference list still does not provide this contract.

#### Retirement conditions

- Retire only together with X001/X041 after a replacement preserves query, selection identity, row enrichment, grouping, and all picker interaction tests.

#### Replacement mapping

- SelectList.setItems query/selection preservation -> SearchablePicker.setItems -> test/searchable-picker.test.ts
- session picker enrichment refresh -> TuiApp PickerHandle.setItems -> SearchablePicker.setItems -> test/session-picker-loading.test.ts and test/sessions.test.ts

#### Retirement evidence

- packages/pi-tui/src/components/select-list.ts restored byte-identical to pinned upstream b79e4cc (diff empty)
- test/searchable-picker.test.ts green: setItems re-applies the canonical query and preserves a surviving selected value; removed-value fallback covered
- dynamic session enrichment integration tests green
- fork typecheck/test/build, surface compat, divergence ledger, strict vendor diff, root build/typecheck/test:bundle green

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Relocated to the Host-owned SearchablePicker.setItems; the moved-selection regression is now covered by test/searchable-picker.test.ts.

### X003 — Editor multi-line insert cursor

- Status: `REMOVED_UNUSED`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The former patch wrote a grapheme count into a code-unit cursor field. That could split supplementary-plane graphemes on the next edit, so the pinned upstream code-unit end is the correct behavior.

#### Changed surface

- Former multi-line insert cursor assignment; no local patch remains

#### Dependency map

**Vendor internal**
- None found (audited).
- Audit note: The former assignment is absent; editor cursor state uses the upstream code-unit representation.

**Inheritance / structural**
- None found (audited).
- Audit note: No structural consumer of the removed assignment exists.

**Host**
- None found (audited).
- Audit note: Host uses the surviving Editor cursor contract, not the removed behavior.

**Public / extension**
- None found (audited).
- Audit note: No public or extension contract requires the defective cursor count.

**Behavioral coupling**
- None found (audited).
- Audit note: The old behavior was document-corrupting rather than a supported behavior.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: supplementary-plane and ZWJ cursor preservation after multi-line insert

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The upstream code-unit cursor assignment is the safe behavior; reapplying the old grapheme-count patch is not semantically equivalent to the editor's cursor representation.

#### Retirement conditions

- Keep the upstream implementation and retain the supplementary-plane regression test; never reintroduce the old patch during a re-vendor.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- The pinned baseline and the audited reference snapshots retain the upstream code-unit assignment.
- Deletion experiment was the 2026-09 re-vendor itself: the ZWJ regression passes with the patch absent.
- Gate evidence: fork typecheck, fork tests, generated-ledger validation, and strict source-diff coverage pass with the record retired.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Historical removed record rechecked. The absence is intentional and protects the editor's code-unit cursor invariant.

### X004A — Editor bounded paste registry

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Large bracketed pastes must not retain an unbounded duplicate registry in memory. Pastes beyond 256 KiB are inserted inline instead of adding another expandable marker.

#### Changed surface

- MAX_PASTE_STORED_CHARS bounded paste-marker admission
- oversize paste fallback inserts ordinary multiline text

#### Dependency map

**Vendor internal**
- Editor insertion, marker expansion, deletion, clear, and registry pruning share paste-entry ownership.
- Audit note: The registry is editor-internal state with multiple mutation paths.

**Inheritance / structural**
- None found (audited).
- Audit note: No subclass or override edge was found for registry admission.

**Host**
- Host editor receives terminal paste data through the Editor paste path.
- Audit note: No host wrapper can enforce the marker memory bound after the fork accepts the paste.

**Public / extension**
- Public Editor paste behavior and expanded-text access depend on bounded marker semantics.
- Audit note: The registry is not directly exposed, but its expansion behavior is.

**Behavioral coupling**
- oversize (>256 KiB) marker-registry storage and admission remain bounded
- oversize content is inserted inline and remains editable as text
- undo and marker expansion stay coherent
- Audit note: The direct cap fixture uses 300 KiB; removing the bound creates a memory-risk regression without a type error.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: oversize 300 KiB paste inline expansion and undo behavior
- test/editor-registry.test.ts: host replacement and marker ownership

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference Editor stores every accepted paste; neither provides the local admission cap and inline fallback.

#### Retirement conditions

- Retire only when upstream or the editor owner provides an equivalent bounded paste policy with the same marker, undo, and large-input behavior.
- Run memory-sensitive registry and host replacement tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the registry is consumed by editor internals and by the expanded-draft handoff. No host-only relocation is available.

### X004B — Editor shallow undo snapshots

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/components/editor.ts`, `src/undo-stack.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Editor snapshots already detach their mutable containers. UndoStack must retain that detached snapshot rather than structured-cloning the entire document again on every edit.

#### Changed surface

- pushUndoSnapshot shallow-copies lines and paste entries
- UndoStack.push stores the already-detached snapshot without a second whole-document clone

#### Dependency map

**Vendor internal**
- Editor pushUndoSnapshot and UndoStack.push jointly define snapshot ownership.
- Audit note: The performance fix spans both the producer and the stack.

**Inheritance / structural**
- None found (audited).
- Audit note: UndoStack has no subclass contract in the vendor or host.

**Host**
- Host editor undo/redo path handles large pasted documents.
- Audit note: The host cannot prevent a deep clone performed inside the fork.

**Public / extension**
- Editor undo and paste expansion remain public observable behavior.
- Audit note: Snapshot representation itself is private.

**Behavioral coupling**
- detached snapshots remain isolated from later edits
- large-paste undo avoids a second whole-document allocation
- Audit note: The optimization must not be replaced with shared mutable line arrays.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: undo isolation and large-paste snapshot behavior
- packages/pi-tui/src/undo-stack.ts: source-level ownership audited; no standalone undo-stack test file

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- packages/tui/src/undo-stack.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream UndoStack.push performs structuredClone on the snapshot; it does not share the local detached-snapshot ownership contract.

#### Retirement conditions

- Retire only after upstream adopts detached snapshot ownership or a benchmarked replacement proves no large-document clone regression while preserving undo isolation.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Corrected the old ledger claim: the local shallow producer alone was insufficient; UndoStack.push is part of the same patch and was audited as one ownership boundary.

### X005 — Editor autocomplete latest-wins

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

A provider that ignores AbortSignal must not block a newer completion request behind a never-settling older request. Request identity and text/cursor snapshots make completion commits latest-wins.

#### Changed surface

- requestId and text/cursor snapshot validation
- latest request can commit without awaiting a prior provider's settlement

#### Dependency map

**Vendor internal**
- Editor completion request, abort controller, dropdown state, and cursor mutation share request identity.
- Audit note: Stale completion callbacks can otherwise overwrite current text.

**Inheritance / structural**
- TuiEditor subclasses the vendor Editor and uses the protected autocomplete seam recorded in X044.
- Audit note: The request state is private but its lifecycle is observed by the host subclass.

**Host**
- src/tui-editor.ts explicit and context-gated completion providers
- host active-screen repaint route for asynchronous completion commits
- Audit note: The host supplies providers that may ignore abort.

**Public / extension**
- Editor autocomplete provider callbacks are a public component integration surface.
- Audit note: Provider timing is an extension-facing behavioral contract.

**Behavioral coupling**
- never-settling old provider cannot stall a newer request
- stale text/cursor results are rejected
- async commit repaints the current screen
- Audit note: A serial promise chain is not semantically equivalent under hostile providers.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: never-settling provider latest-wins regression
- test/autocomplete-active-screen-repaint.test.ts: current-screen repaint

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `PARTIAL`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The audited upstream reference has request identity checks but retains a serial autocomplete task chain; it has not been proven equivalent to the local never-settling latest-wins behavior or host repaint route.

#### Retirement conditions

- Upstream must make completion commits latest-wins even when an aborted provider never settles, with the same stale text/cursor fencing.
- Run provider, subclass, and active-screen repaint tests before removing the local path.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: The audited upstream reference source was inspected rather than inferred from issue status. The remaining serial task chain keeps equivalence PARTIAL.

### X006 — Word-forward skips punctuation at segment start

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/word-navigation.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Forward word navigation should cross leading punctuation at the next word-like segment instead of stopping without moving, including CJK-aware segmentation.

#### Changed surface

- wordForward segment-start punctuation branch

#### Dependency map

**Vendor internal**
- Editor Ctrl/Alt word-forward movement calls wordForward.
- Audit note: The helper is used inside the exported editor behavior.

**Inheritance / structural**
- None found (audited).
- Audit note: No inheritance or structural consumer found.

**Host**
- Host editor keybindings use the vendor word navigation helper.
- Audit note: The host does not reimplement cursor segmentation.

**Public / extension**
- Editor word navigation is observable through the public component input contract.
- Audit note: No direct helper export is required for the behavior to be public.

**Behavioral coupling**
- leading punctuation is crossed rather than producing a no-op
- custom and Intl segmenter word-like classifications remain respected
- Audit note: A similarly named upstream helper can differ at the cursor boundary.

#### Guarding tests

- packages/pi-tui/test/word-navigation.test.ts: leading punctuation with a custom segmenter
- packages/pi-tui/test/editor.test.ts: word movement integration

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/word-navigation.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference stop before a leading punctuation segment in the audited case; the local helper deliberately advances past it.

#### Retirement conditions

- Retire only when upstream's wordForward has the same segment-start punctuation semantics and the cursor-boundary regression remains green.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Checked the helper and its editor call path; did not classify this as absorbed merely because upstream has a similarly named function.

### X007 — Component dispose lifecycle

- Status: `ACTIVE`
- Category: `HARD_HOST_API`, `PUBLIC_COMPONENT_CONTRACT`
- Risk: `CRITICAL`
- Files: `src/tui.ts`, `src/components/scroll-view.ts`, `src/components/loader.ts`, `src/components/box.ts`, `src/components/settings-list.ts`, `src/components/stack.ts`, `src/components/mouse-region.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host owns timers, callbacks, child components, submenu slots, and overlay leases. A single optional Component.dispose contract releases each resource exactly once across removal, hide, replacement, and final surface teardown.

#### Changed surface

- optional Component.dispose and idempotent Container disposal
- Container/Box/Stack child ownership and removal
- ScrollView timer/callback cleanup
- Loader, SettingsList submenu, and opt-in overlay disposal

#### Dependency map

**Vendor internal**
- Container, Box, Stack, ScrollView, SettingsList, Text, and Loader each participate in the release graph.
- Audit note: The patch is an ownership graph, not one helper.

**Inheritance / structural**
- Loader extends Text; the X019 Text.dispose shim was retired (PR2) and Loader.dispose owns the timer cleanup directly.
- ScrollView and Stack override container lifecycle methods.
- Audit note: Override and super edges were checked before any retirement classification.

**Host**
- src/tui-app.ts OverlayBroker.disposeAll and overlay leases
- editor seat, panels, timers, and fullscreen surface teardown
- test/pi-component-compat.test.ts public component compatibility
- src/model-menu.ts ModelSubmenu/EffortSubmenu ownership-safe external dispose (latch/abort owned async work, dispose owned inner exactly once, never done/apply/navigation on teardown)
- Audit note: Host final teardown relies on exactly-once release. Post-v0.85.1 audit: ModelSubmenu and EffortSubmenu now implement ownership-safe external dispose so the SettingsList's submenuComponent.dispose() chain (owner → ModelSubmenu → inner SettingsList → nested EffortSubmenu) latches/aborts every owned async workflow; late resolves cannot repaint or apply after teardown (regressions in test/model-menu.test.ts).

**Public / extension**
- Stable/Advanced/Unstable extension mounts and public component leases
- component compatibility surface accepts optional dispose
- Audit note: Extension-owned remountable leases intentionally opt out of overlay disposeOnHide.

**Behavioral coupling**
- removed children are detached before disposal
- repeated dispose is a no-op
- disposeOnHide is opt-in so remountable overlays survive hide
- Stack clears its second layout representation
- Audit note: Type-compatible removal can leak timers or resurrect disposed children.

#### Guarding tests

- test/pi-component-compat.test.ts: close idempotency, exactly-once disposal, lease invalidation, fullscreen migration
- packages/pi-tui/test/dispose-lifecycle.test.ts: Container and ScrollView ownership
- packages/pi-tui/test/layout.test.ts: Stack entries and disposed layout behavior
- packages/pi-tui/test/overlay-options.test.ts: disposeOnHide ownership
- packages/pi-tui/test/dispose-lifecycle.test.ts: MouseRegion dispose forwarding — owned child disposed exactly once, wrapped Loader timer cleared
- test/model-menu.test.ts: ModelSubmenu/EffortSubmenu ownership-safe external dispose — dispose latches/aborts pending work without done/apply/navigation, and the owner → ModelSubmenu → inner SettingsList → nested EffortSubmenu chain terminates a late effort resolve

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui.ts
- packages/tui/src/components/scroll-view.ts
- packages/tui/src/components/text.ts
- packages/tui/src/components/loader.ts
- packages/tui/src/components/box.ts
- packages/tui/src/components/settings-list.ts
- packages/tui/src/components/stack.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The pinned baseline has no fork-wide optional dispose ownership graph. The audited upstream reference has isolated disposable components, but not the host's Container/Stack/overlay exactly-once contract.

#### Retirement conditions

- Do not retire in a ledger cleanup. A dedicated lifecycle architecture change must replace every ownership edge and preserve exactly-once teardown, remount behavior, extension lifetime, and final OverlayBroker cleanup.
- Run the full component compatibility, layout, overlay, timer, and extension lifecycle suites.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Known ownership graph was re-read in the audited checkout. X007 remains KEEP HARD; no source deletion or upstream absorption experiment was attempted. Re-audited after the v0.85.1 mouse-parity pass: the Model/Effort async submenu ownership chain is closed by external disposal.

### X008 — Serialized OSC 11 queries with late-reply tombstone

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/tui.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

OSC 11 replies carry no request id, so a reply that arrives after its query timed out cannot be paired by content. The fork serializes queries: at most one query is ever in flight, and a timed-out query stays as the active tombstone until a late reply consumes it — the next waiting query is sent only after consumption, so a late reply can never be misattributed to a different query.

#### Changed surface

- OSC 11 queries are serialized through a single active slot plus a waiting queue
- a timed-out in-flight query remains the active late-reply tombstone until consumed
- late OSC 11 replies are swallowed by the tombstone (or the no-reply-expected path) before generic counter handling

#### Dependency map

**Vendor internal**
- TuiBase query queue, timeout callback, response classifier, and reply counter are one protocol state machine.
- Audit note: Queue and counter order cannot be changed independently.

**Inheritance / structural**
- TuiBase is shared by regular and alternate screens.
- Audit note: Both screens inherit the protocol handling path.

**Host**
- src/tui-app.ts TuiApp.runAutoDetect issues OSC 11 background queries
- src/theme.ts provides palette/detection helpers but does not own the query
- Audit note: The query is issued by the host app and routed through the active screen; theme.ts is recorded only as a helper boundary.

**Public / extension**
- None found (audited).
- Audit note: No extension directly owns terminal protocol replies.

**Behavioral coupling**
- a sole late timed-out reply is swallowed by its tombstone and never resolves a different query
- background autodetect remains ordered across retries
- a terminal that never replies leaves the tombstone in place: every waiting query settles on its own referenced timeout (by-design liveness tradeoff — no future query is sent until the tombstone is consumed)
- Audit note: Serialization removes the protocol ambiguity (a reply always pairs with the single in-flight query or its tombstone) at the cost of blocking later queries while a timed-out query awaits its late reply; that tradeoff is deliberate and documented.

#### Guarding tests

- packages/pi-tui/test/osc11-query.test.ts: timed-out query queue/counter alignment
- packages/pi-tui/test/terminal-colors.test.ts: active-screen query routing
- packages/pi-tui/test/osc11-query.test.ts: serialized queries — a late reply to a timed-out query is swallowed by its tombstone and never resolves a concurrent or later query (A-timeout/B-pending and A-timeout-then-B-later regressions)

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream keeps timed-out queries in the pending queue and uses a different counter check; it is not equivalent under a late reply.

#### Retirement conditions

- Retire only after upstream proves the same timeout, late-reply, retry, and active-screen ordering semantics with protocol tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Protocol queue ownership and the reply-swallowing order were checked; no host grep-only conclusion was used.

### X009 — No stray spacer blank on the final row when exiting

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/tui-main-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Exit cleanup must not write a spacer when the cursor is already on the terminal's final row, otherwise a blank remains visible after the TUI stops.

#### Changed surface

- beforeTerminalStop conditional final-row spacer write

#### Dependency map

**Vendor internal**
- TuiMainScreen exit cursor position and terminal stop writer share the final-row calculation.
- Audit note: The behavior sits in the render/exit boundary.

**Inheritance / structural**
- TuiMainScreen extends the main screen implementation used by the host.
- Audit note: No override consumer of the spacer branch was found.

**Host**
- TuiApp normal exit and terminal restart paths.
- Audit note: The host relies on clean terminal restoration.

**Public / extension**
- None found (audited).
- Audit note: Exit cleanup is not extension-controlled.

**Behavioral coupling**
- final-row exit leaves no painted spacer
- non-final-row cursor cleanup remains intact
- Audit note: The visible terminal state is the contract.

#### Guarding tests

- packages/pi-tui/test/tui-render.test.ts: direct final-row stop cleanup fixture
- Missing integration test through the full terminal exit path; retain the focused fixture until that coverage exists

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-main-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream writes the spacer unconditionally; the local branch avoids a visible final-row artifact.

#### Retirement conditions

- Add a dedicated final-row exit regression and retire only if upstream adopts the same conditional write.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Kept active. The audit found no direct extension consumer but the host-visible exit terminal state is a behavioral contract.

### X010 — Capped ESC-prefix scans

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/stdin-buffer.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

An unbounded or corrupt ESC prefix must not trigger repeated large reslices. The 1024-byte cap degrades an unterminated prefix to ordinary input with bounded work.

#### Changed surface

- MAX_ESCAPE_SEQUENCE_LENGTH scan cap
- oversized ESC-prefix fallback

#### Dependency map

**Vendor internal**
- StdinBuffer scan cursor, prefix parser, and fallback consume the same buffered input.
- Audit note: The cap protects the parser's complexity boundary.

**Inheritance / structural**
- None found (audited).
- Audit note: No subclass or structural consumer found.

**Host**
- ProcessTerminal stdin path and host input router consume decoded chunks.
- Audit note: The host cannot bound a prefix after the buffer has accepted it.

**Public / extension**
- None found (audited).
- Audit note: Raw stdin buffering is below the extension API.

**Behavioral coupling**
- the 1024-byte cap bounds an incomplete ESC prefix
- valid CSI and modifier sequences remain decodable
- the existing long-prefix fixture is only 100 characters and does not reach the cap
- Audit note: This is a robustness boundary; the direct regression feeds an 1100-character incomplete prefix and verifies the buffer degrades and drains it.

#### Guarding tests

- packages/pi-tui/test/stdin-buffer.test.ts: valid ESC sequence, long-prefix, and >1024-byte incomplete-prefix degradation cases

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/stdin-buffer.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference buffer do not contain the local hard cap for an unterminated ESC prefix.

#### Retirement conditions

- Retire only after upstream provides an equivalent bounded parser and valid-sequence compatibility tests cover oversized and corrupt input.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: The audit treats input complexity as a runtime safety property, not an import-consumer question.

### X011 — Input prompt clips on extremely narrow widths

- Status: `ABSORBED_UPSTREAM`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/components/input.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Input must render a clipped prompt at tiny widths instead of emitting an overwide raw line that corrupts the terminal layout.

#### Changed surface

- prompt clipping before render padding and cursor placement

#### Dependency map

**Vendor internal**
- Input prompt width, value rendering, and cursor geometry share the available width.
- Audit note: The guard runs at the component boundary.

**Inheritance / structural**
- SettingsList owns Input instances and forwards focus (X042); the Host SearchablePicker owns its search Input.
- Audit note: Wrapper components inherit the narrow-width behavior through their child.

**Host**
- Question free-text, search boxes, picker filters, and task/history inputs.
- Audit note: Multiple host surfaces can be mounted in narrow terminals.

**Public / extension**
- Public Input component render behavior.
- Audit note: No private host implementation replaces Input rendering.

**Behavioral coupling**
- zero and one-column grants never emit negative or overwide padding
- prompt remains visible enough for editing
- Audit note: Narrow rendering is a visible contract even without a unique host symbol.

#### Guarding tests

- packages/pi-tui/test/input.test.ts: direct tiny-width prompt clipping regressions (width 0 and width 1)
- narrow-width editor, settings, and component render suites exercise the behavior through wrappers

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/input.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The pinned v0.85.1 baseline (d981de1) already clips the prompt at tiny widths (availableWidth <= 0 returns truncateToWidth(this.prompt, width, "")); the local source matches the upstream baseline exactly for this behavior.

#### Retirement conditions

- Keep the upstream prompt-clipping behavior and do not resurrect the raw-prompt fallback.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- git blob comparison at the pinned commit shows no local source divergence for the prompt-clipping path.
- The pinned v0.85.1 upstream input.ts returns truncateToWidth(this.prompt, width, "") when availableWidth <= 0.
- Gate evidence: fork typecheck, fork tests, generated-ledger validation, and strict source-diff coverage pass with the record absorbed.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Absorbed upstream: the pinned v0.85.1 baseline (d981de1) already clips Input prompts at extremely narrow widths, so the fork keeps the pinned upstream behavior with no local source divergence; direct width-0/1 regressions guard the absorbed behavior (equivalence YES).

### X012 — Deterministic fuzzy tie sort

- Status: `SUPERSEDED`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `LOW`
- Files: `src/fuzzy.ts`
- Last audited: `2026-09-07`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The local comparator explicitly preserved input order for equal fuzzy scores. Supported Node engines guarantee stable Array.prototype.sort, so the explicit tie term was redundant and has been removed (PR2).

#### Changed surface

- fuzzyFilter result index tie-breaker

#### Dependency map

**Vendor internal**
- fuzzyFilter constructs result order and passes it directly to sort.
- Audit note: No secondary randomization or map is involved.

**Inheritance / structural**
- None found (audited).
- Audit note: The helper has no inheritance or structural implementation edge.

**Host**
- Host transcript, picker, and command search paths use fuzzyFilter results.
- Audit note: Ordering is user-visible in search results.

**Public / extension**
- Fuzzy helper is used by fork-exported providers and picker behavior.
- Audit note: The result array order is observable.

**Behavioral coupling**
- equal scores preserve original input order
- supported engine range is Node >=22.19 or >=24
- Audit note: The candidate depends on the ECMAScript stable-sort guarantee, not merely on a matching function name.

#### Guarding tests

- packages/pi-tui/test/fuzzy.test.ts: equal-score ordering and fuzzy result behavior

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/fuzzy.ts
- packages/tui/package.json
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: With the package's supported Node engine, upstream score-only sort is stable and preserves the same input-order ties. The explicit index comparator was therefore runtime-equivalent and has been removed. Semantic equivalence relies on the supported runtime stable-sort guarantee; this is not evidence of a new upstream implementation.

#### Retirement conditions

- Confirm the project engine floor, comparator input order, and equal-score regression on every supported Node boundary.
- Run the deletion experiment: restore upstream fuzzy.ts, run vendor fuzzy tests, bundle tests, typecheck, and both vendor gates; keep the explicit comparator if any result changes.

#### Replacement mapping

- fuzzyFilter explicit index tie-break -> supported Node/ECMAScript stable-sort state -> packages/pi-tui/test/fuzzy.test.ts equal-score ordering test

#### Retirement evidence

- supported engine range is Node >=22.19 / >=24 (root and pi-tui package engines)
- fuzzy.ts restored byte-identical to pinned upstream b79e4cc (blob 73c10dcf4b134bfefba2978281b2a6f94352c5b8)
- existing equal-score regression remains green after deletion (packages/pi-tui/test/fuzzy.test.ts)
- fork typecheck/test/build, surface compat, divergence ledger, strict vendor diff, root build/typecheck/test:bundle green

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Retired in PR2: the explicit index tie-break was removed and fuzzy.ts restored byte-identical to the pinned upstream. Equal-score input order is preserved by the supported ECMAScript stable-sort guarantee and remains guarded by the equal-score regression; this is not evidence of a new upstream implementation.

### X013 — setIndicator never revives a stopped loader

- Status: `REMOVED_UNUSED`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/components/loader.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The former patch changed setIndicator after stop, but the host uses its own WorkingIndicator and no vendor Loader path consumes that behavior.

#### Changed surface

- Former setIndicator stopped-loader branch; no local patch remains

#### Dependency map

**Vendor internal**
- None found (audited).
- Audit note: No vendor component constructs or calls Loader/setIndicator in the audited source.

**Inheritance / structural**
- None found (audited).
- Audit note: No override or super consumer of the removed branch was found.

**Host**
- None found (audited).
- Audit note: Host busy feedback is WorkingIndicator in src/, not Loader.

**Public / extension**
- None found (audited).
- Audit note: Loader remains root-exported, but no known in-repo extension or public contract requires the removed stopped-loader setIndicator behavior; external consumers cannot be enumerated from this checkout.

**Behavioral coupling**
- None found (audited).
- Audit note: The old semantic change has no supported consumer; upstream restart behavior is retained.

#### Guarding tests

- No dedicated setIndicator regression exists; loader lifecycle/timer ownership was audited separately and no focused package test guards the removed behavior

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/loader.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The upstream setIndicator behavior is retained and no vendor or host consumer requires the former stopped-loader behavior.

#### Retirement conditions

- Keep the upstream loader implementation and recheck Loader construction/searches whenever the host adds a loader consumer.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- Deletion evidence: current audited host search found WorkingIndicator as the busy indicator and no Loader/setIndicator call path.
- Pinned source and local source match for the retired branch; strict vendor diff reports no stale active entry for this record.
- Gate evidence: fork typecheck, fork tests, generated-ledger validation, and strict source-diff coverage pass with the record retired.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Historical removal rechecked with vendor-internal and host searches. The previous host busy-indicator claim remains rejected.

### X014 — Measured line widths cached

- Status: `ACTIVE`
- Category: `PERF_HOST_DEPENDENT`
- Risk: `MEDIUM`
- Files: `src/layout.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Repeated measureWidth calls should reuse the maximum visible line width for a component and width within a frame instead of rescanning styled lines at every call site.

#### Changed surface

- layout context maxWidthCache keyed by component and width
- measureWidth cache lookup and population

#### Dependency map

**Vendor internal**
- Layout context creation, measureWidth callers, and per-frame invalidation share the cache lifetime.
- Audit note: The cache is scoped to layout work, not a global stale width store.

**Inheritance / structural**
- Container and layout-node implementations call the shared measureWidth helper.
- Audit note: No subclass overrides the cache contract.

**Host**
- Host transcript and fullscreen render trees exercise package layout measurement repeatedly within a frame.
- Audit note: The performance consumer is indirect call frequency through package layout components, not a named host import.

**Public / extension**
- Extension-rendered components participate in the same layout measurement pass.
- Audit note: No extension API exposes the cache directly.

**Behavioral coupling**
- same-frame repeated measurement returns the same width
- cache does not survive a new layout context or width change
- Audit note: Dropping the cache is a measurable frame-cost regression, not a type failure; current tests and render-churn benchmark provide indirect evidence rather than isolated cache-hit instrumentation.

#### Guarding tests

- packages/pi-tui/test/layout.test.ts: indirect measure and scrollbar layout correctness
- packages/pi-tui/test/render-churn-bench.ts: total layout/render churn with representative workload
- Missing direct measure-count/cache-hit, invalidation, and cache-versus-no-cache performance assertion

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/layout.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream remeasures visible lines on every measureWidth call; its scrollbar clamp is already baseline and is not part of this divergence.

#### Retirement conditions

- Run a reproducible host transcript/fullscreen benchmark at representative line counts and widths.
- Retire only if upstream or a replacement has equal or better measured steady-frame cost without stale-width behavior.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the cache is used through layout call frequency; no import-only unused conclusion was made. The upstream thumb clamp was excluded from ownership.

### X015 — Dead _lastEventType state

- Status: `ABSORBED_UPSTREAM`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `LOW`
- Files: `src/keys.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The former local cleanup targeted _lastEventType. The field is still written by Kitty parsing in the upstream baseline, but the current isKeyRelease implementation checks the raw input directly; the source representation is retained because the former local removal is no longer a local diff.

#### Changed surface

- Former _lastEventType removal; no local patch remains

#### Dependency map

**Vendor internal**
- Kitty parser writes _lastEventType; the current isKeyRelease helper does not read it directly.
- Audit note: The write is retained in the pinned baseline, while the old ledger claim that isKeyRelease consumes it was not confirmed.

**Inheritance / structural**
- None found (audited).
- Audit note: No subclass edge beyond the key parser implementation.

**Host**
- Host keybinding and modifier decoding consume key release state indirectly.
- Audit note: The removed cleanup is not a host-owned replacement.

**Public / extension**
- None found (audited).
- Audit note: No extension directly accesses the private field.

**Behavioral coupling**
- key-release behavior remains unchanged
- the retained parser write is dead for isKeyRelease, which scans raw input
- Audit note: The old cleanup is absorbed because the pinned baseline/reference source representation is identical; it is not evidence that isKeyRelease consumes _lastEventType.

#### Guarding tests

- packages/pi-tui/test/keys.test.ts: key release and printable decoding behavior

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/keys.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference retain the field and its parser writes, but isKeyRelease currently uses raw-sequence checks rather than reading _lastEventType; the local source matches the upstream baseline.

#### Retirement conditions

- Keep the upstream key parser state and do not resurrect the former dead-field cleanup.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- git blob comparison at the pinned commit shows no local source divergence for X015.
- The audited upstream reference source retains the parser write; local isKeyRelease source was checked and does not read _lastEventType directly.
- Gate evidence: fork typecheck, fork tests, generated-ledger validation, and strict source-diff coverage pass with the record absorbed.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Historical absorbed record rechecked; its old title is retained for provenance, not as an instruction to edit keys.ts.

### X016 — start does not stack terminal listeners

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `CRITICAL`
- Files: `src/terminal.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Restarting ProcessTerminal during fullscreen transitions must replace every owned listener and buffer exactly once, preserve the original raw mode, and keep Kitty keyboard negotiation balanced.

#### Changed surface

- remove-before-assign resize and stdin data listeners
- destroy previous StdinBuffer and clear negotiation state
- capture raw state only on first start
- push Kitty protocol once per start/stop cycle

#### Dependency map

**Vendor internal**
- ProcessTerminal start/stop, StdinBuffer callback, resize listener, raw mode, and Kitty push/pop state form one lifecycle.
- Audit note: Fixing only resize leaves duplicate stdin delivery or raw-mode leaks.

**Inheritance / structural**
- ProcessTerminal implements the Terminal interface consumed by TuiBase and screens.
- Audit note: No alternate implementation can repair a duplicated ProcessTerminal listener.

**Host**
- TuiApp fullscreen toggle restarts the terminal and reuses the input handler.
- Audit note: A repeated start is a real host path.

**Public / extension**
- Extension surfaces observe terminal input through the canonical host router.
- Audit note: The raw terminal lifecycle itself is not exposed to Stable plugins.

**Behavioral coupling**
- one stdin chunk reaches the handler once
- stop restores the original cooked/raw state
- Kitty push/pop remains balanced
- resize ownership does not accumulate
- Audit note: The type shape remains unchanged while runtime delivery duplicates.

#### Guarding tests

- packages/pi-tui/test/terminal.test.ts: repeated resize listener, stdin listener, raw state, and Kitty protocol tests
- test/process-tui-slot.test.ts and fullscreen restart coverage

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/terminal.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream stacks listeners and re-captures state on repeated start; it does not provide the local all-resource swap and negotiation balance.

#### Retirement conditions

- Retire only after upstream exposes equivalent repeated-start ownership across resize, stdin, buffers, raw state, timers, and Kitty protocol negotiation.
- Run the complete repeated-start/stop and fullscreen restart tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Rechecked the full resource graph, not only the original resize-listener symptom. KEEP HARD.

### X017 — Regular mode owns no mouse

- Status: `ABSORBED_UPSTREAM`
- Category: `LOCAL_UX`
- Risk: `LOW`
- Files: `src/tui-main-screen.ts`, `src/tui-alt-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Mouse handling belongs to the alternate fullscreen screen; regular mode remains mouse-free in the pinned upstream baseline.

#### Changed surface

- Former regular-screen mouse ownership change; no local patch remains

#### Dependency map

**Vendor internal**
- Main and alternate screen constructors keep separate mouse/input ownership.
- Audit note: The source comparison shows the local split matches upstream.

**Inheritance / structural**
- TuiMainScreen and TuiAltScreen share TuiBase but install different screen input behavior.
- Audit note: The distinction is structural screen ownership.

**Host**
- Host fullscreen interactions are installed on TuiAltScreen; regular transcript uses app routing.
- Audit note: No host replacement is needed for the absorbed difference.

**Public / extension**
- None found (audited).
- Audit note: Screen mouse ownership is below the stable extension surface.

**Behavioral coupling**
- regular mode does not claim mouse chunks
- fullscreen mode retains mouse selection/click handling
- Audit note: The ownership split remains observable.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: alternate-screen mouse behavior
- bundle fullscreen input tests

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-main-screen.ts
- packages/tui/src/tui-alt-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference assign mouse behavior to the alternate screen and leave regular mode mouse-free; local source matches.

#### Retirement conditions

- Keep the upstream screen ownership split and recheck it on every re-vendor.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- Pinned source blob comparison found no local patch for X017.
- Current source and fullscreen tests preserve alternate-only mouse ownership.
- Gate evidence: fork typecheck, fork tests, generated-ledger validation, and strict source-diff coverage pass with the record absorbed.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Historical absorbed record retained to prevent the old divergence from silently returning to the active manifest.

### X018 — Click granularity guard, onCellClick, and stale mouse-target revalidation

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/tui-alt-screen.ts`, `src/tui.ts`, `src/components/box.ts`, `src/components/mouse-region.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host needs single-cell fullscreen clicks for click-to-expand. Double-click selection must remain native word selection, and single-click handling must not duplicate clipboard feedback. Pointer events must also never reach a stale target: an overlay hidden or removed since the last paint, a layout root replaced via setLayoutRoot, or a component removed from a Container mid-gesture must stop receiving press/drag/release events immediately (the cached layout frame only refreshes on the next paint).

#### Changed surface

- onCellClick callback for character-granularity clicks
- single/double click branch ownership
- overlay mouse dispatch skips entries no longer mounted or visible
- gesture capture/press targets are revalidated against the live component tree (overlay roots AND their subtrees, layout root, direct children) and cleared when stale
- Container/Box mouse-layout caches are validated against live children (length + identity) before reuse and never re-render un-painted children (no ghost clicks)
- the selection fallback’s synthesized click is restricted to the press-time hit relationship (a control painted after a structural repaint between press and release cannot receive it)
- the mouse-dispatch recorder/allow-set are per-event isolated with depth-based save/restore for BOTH SGR mouse and wheel events: no dead-instance retention, nested raw dispatches (including wheels) are not filtered by an outer allow-set, and nested selection gestures cannot overwrite the outer press snapshot; a full nested press+release pair is documented as unsupported and its click is safely dropped
- wrapper gesture targets (MouseRegion, Host Frame) are rewritten to the mounted wrapper, with focus requests landing on the wrapper too
- MouseRegion transparently forwards handleInput/wantsKeyRelease and the Focusable focused flag to its child
- setLayoutRoot clears an in-flight component mouse gesture
- the selection press-time dispatch snapshot is released when the selection gesture ends (no dead component references retained between gestures)
- a stationary first press on a HIDDEN auto scrollbar jumps the track / starts a drag immediately (includeHiddenAuto on the press path, matching the hover path)
- when a mounted overlay is hit, in-flight pointer gestures that started outside are cancelled (selection gesture + snapshot, scrollbar drag) — the hidden selection must not reappear after the overlay closes and the drag must not resume on release

#### Dependency map

**Vendor internal**
- Alt-screen mouse selection state, click granularity, and clipboard callback share the selection lifecycle.
- Audit note: The callback cannot be extracted without preserving native selection behavior.

**Inheritance / structural**
- TuiAltScreen extends TuiBase and owns the fullscreen viewport listener.
- Audit note: No subclass replaces click classification.

**Host**
- src/tui-app.ts handleFullscreenClick expands the question/transcript surface.
- Audit note: The callback is a direct host seam.

**Public / extension**
- TuiAltScreen options expose the click callback through the public component constructor.
- Audit note: The shape is also consumed by compatibility tests.

**Behavioral coupling**
- single click invokes host callback
- double click selects a word and preserves copy-on-select semantics
- selection feedback is not duplicated
- a hidden/removed overlay or a replaced/removed layout target never receives pointer events, even before the next paint
- Audit note: A callback with the wrong granularity is not equivalent. Liveness is checked against the currently mounted component tree, never the cached layout frame, so structural changes take effect immediately.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: onCellClick and double-click selection
- test/tui-app.test.ts, test/rendering.test.ts, and test/thinking-disclosure.test.ts: fullscreen click-to-expand host behavior
- packages/pi-tui/test/mouse-components.test.ts: stale overlay mouse targets — hidden overlay clicks and captured drags after hide()
- packages/pi-tui/test/mouse-components.test.ts: stale layout mouse targets — captured drags after setLayoutRoot swap and after removing a layout node mid-gesture
- packages/pi-tui/test/mouse-components.test.ts: stale fresh-press dispatch — removed components and replaced seat children receive no new presses, and not-yet-painted replacements receive no ghost clicks
- packages/pi-tui/test/mouse-components.test.ts: selection fallback click across a repaint — a click whose press was rejected before a repaint does not transfer to the newly painted child
- packages/pi-tui/test/mouse-components.test.ts: mouse dispatch recorder lifecycle — the module recorder is cleared after each event (no dead-instance retention)
- packages/pi-tui/test/mouse-components.test.ts: nested mouse dispatch isolation — a nested press or wheel triggered during a synthetic click is not filtered by the outer allow-set, and a nested selection gesture cannot overwrite the outer press snapshot
- packages/pi-tui/test/mouse-components.test.ts: wheel event isolation — a top-level wheel leaves no residual components in the reached set, and a nested wheel is not filtered by the outer allow-set
- packages/pi-tui/test/mouse-components.test.ts: nested gesture targets — SelectList inside an overlay-root Container and inside a MouseRegion still fire onSelect
- packages/pi-tui/test/mouse-components.test.ts: MouseRegion transparent keyboard forwarding, wrapper focus ownership, and Focusable flag propagation (CURSOR_MARKER)
- test/busy-enter.test.ts: fullscreen /settings SettingsList row responds to a mouse click through the Host Frame wrapper; frame borders/padding do not activate rows
- test/editor-seat-non-owning.test.ts: ghost click and selection-fallback cross-repaint regressions on the production EditorSeatMount path
- packages/pi-tui/test/tui-alt-screen.test.ts: selection press-time component snapshot lifecycle — the press snapshots the reached set and the release clears it
- packages/pi-tui/test/tui-alt-screen.test.ts: hidden auto scrollbar track jumps on a stationary first press; in-flight selection gesture and scrollbar drag are cancelled when the pointer lands on a capturing overlay

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-alt-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has no onCellClick callback and therefore cannot express host fullscreen click ownership.

#### Retirement conditions

- Retire only when upstream supplies a callback with the same single-cell/double-click and clipboard ordering semantics, AND revalidates gesture targets against the live component tree (hidden/removed overlays, replaced layout roots, removed layout nodes must stop receiving pointer events before the next paint), AND a stale mouse-layout cache dispatches neither removed children nor not-yet-painted replacements until the next real render (no ghost clicks), AND the selection fallback’s synthesized click cannot transfer to a control painted after the press, AND mouse dispatch isolation covers wheel events as well as SGR mouse events (a top-level wheel leaves no residual components in the reached set, and a nested wheel is not filtered by an outer allow-set), then run fullscreen, selection, stale-target, ghost-click, cross-repaint, and wheel-isolation compatibility tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the host callback is a structural and behavioral seam, not a convenience import.

### X019 — Text no-op dispose inheritance shim

- Status: `SUPERSEDED`
- Category: `HARD_HOST_API`, `PUBLIC_COMPONENT_CONTRACT`
- Risk: `HIGH`
- Files: `src/components/text.ts`
- Last audited: `2026-09-07`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Text.dispose was a no-op solely so Loader's dispose override and super.dispose call typechecked. The inheritance edge was real, but the base no-op has been removed by an atomic Loader cleanup (PR2).

#### Changed surface

- Text.dispose(): void no-op (pre-retirement, removed in PR2)
- Loader.dispose override called stop and super.dispose (pre-retirement, removed in PR2)

#### Dependency map

**Vendor internal**
- Loader extended Text and called super.dispose in the pre-retirement local implementation.
- Audit note: This was an existing inheritance consumer, not unused code.

**Inheritance / structural**
- Loader -> Text.dispose -> super.dispose (pre-retirement edge, removed in PR2)
- Audit note: The required structural audit sample is present.

**Host**
- X007 lifecycle consumers can dispose Loader through the Component contract.
- Audit note: No direct host call to Text.dispose exists; X007 owns the Loader disposal edge.

**Public / extension**
- Component.dispose is optional and public component consumers may dispose a Loader instance.
- Audit note: Removing the shim did not remove Loader timer cleanup.

**Behavioral coupling**
- Loader.stop timer cleanup must remain exactly once
- Text no longer carries a dispose member (X019 retired in PR2)
- Audit note: The safe change is an atomic inheritance cleanup, not a REMOVED_UNUSED classification.

#### Guarding tests

- packages/pi-tui/test/dispose-lifecycle.test.ts: Loader cleanup and idempotency
- packages/pi-tui/test/layout.test.ts and test/pi-component-compat.test.ts: component lifecycle contract

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `PARTIAL`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/text.ts
- packages/tui/src/components/loader.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream Text has no dispose member, and the local Text now matches upstream byte-identically. Loader disposal remains intentionally local under X007: Loader.dispose owns the timer cleanup directly without a base super call.

#### Retirement conditions

- Apply one atomic change: remove Text.dispose and remove Loader's super.dispose call while retaining Loader.dispose and timer cleanup.
- Run lifecycle, Loader timer, layout, surface compatibility, and typecheck gates before changing status.

#### Replacement mapping

- Text.dispose no-op + Loader super.dispose chain -> X007 Loader.dispose owner keeps timer-cleanup state directly -> packages/pi-tui/test/dispose-lifecycle.test.ts

#### Retirement evidence

- text.ts restored byte-identical to pinned upstream b79e4cc (blob 7a50e2721028d544f641ab5f66ef1b752ff6d1f7)
- Loader.dispose remains and calls stop() directly; no override keyword and no super.dispose() remain
- package typecheck green (no inheritance type errors after removing the base member)
- dispose-lifecycle tests green (Loader cleanup and idempotency)
- surface compatibility + divergence ledger + strict vendor diff + root build/typecheck/test:bundle green

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Retired in PR2: Text.dispose was removed and text.ts restored byte-identical to the pinned upstream. Loader keeps the real X007 timer cleanup directly (dispose -> stop -> clearInterval) without override/super.dispose; the X019 base-class shim is gone while Loader disposal remains intentionally local under X007.

### X020 — Editor clearHistory

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

When a session or workspace changes, the host must replace the prompt-history context and browsing state without reconstructing the editor.

#### Changed surface

- Editor.clearHistory clears entries and browsing state

#### Dependency map

**Vendor internal**
- Editor history entries, current browsing index, and draft callbacks are reset together.
- Audit note: Clearing only the array leaves stale browsing state.

**Inheritance / structural**
- TuiEditor owns an Editor instance and calls clearHistory during seat/session changes.
- Audit note: No subclass override of clearHistory was found.

**Host**
- src/editor-seat-holder.ts session/workspace switch
- src/tui-editor.ts host editor adapter
- Audit note: This is a direct replacement-editor/session seam.

**Public / extension**
- Editor public method used by host adapter; history callbacks remain part of X029.
- Audit note: The method is not an internal-only optimization.

**Behavioral coupling**
- old prompts cannot reappear after a session switch
- history browsing exits cleanly
- mode-aware draft state is not resurrected
- Audit note: A host-side rebuild is not equivalent because it changes editor seat identity and focus.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts:375-393 clearHistory entries and browsing-state reset
- packages/pi-tui/test/editor-history-keybindings.test.ts: history keybinding behavior
- test/editor-seat-non-owning.test.ts and session/editor switch coverage

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has no clearHistory method or equivalent host seat reset operation.

#### Retirement conditions

- Provide an upstream or host-owned operation that clears history and browsing state without replacing the editor seat, then run session-switch and mode-history tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed direct host seat-holder use; KEEP HARD.

### X021 — Wrapped lines are foreground-balanced

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/utils.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Every wrapped physical line must close non-background ANSI attributes so styles do not leak into padding, table borders, or following rows while preserving the background across the wrapped segment.

#### Changed surface

- AnsiCodeTracker.getLineEndReset closes foreground and non-background attributes
- wrapSingleLine appends a final segment reset

#### Dependency map

**Vendor internal**
- wrapSingleLine, ANSI tracking, markdown rendering, and line padding share reset semantics.
- Audit note: The helper is used by multiple text and markdown paths.

**Inheritance / structural**
- None found (audited).
- Audit note: No inheritance edge; the coupling is shared utility behavior.

**Host**
- TranscriptFolder output feeds styled Markdown and host renderers
- table and panel borders follow wrapped content
- Audit note: transcript.ts owns fold/data/state; wrapping is performed by the shared utility and package/host renderers. The consumer is rendered output, not a direct method call.

**Public / extension**
- Extension renderers can return ANSI-styled lines consumed by the shared wrapper.
- Audit note: The utility's output reaches public component rendering.

**Behavioral coupling**
- foreground/bold/dim/etc. close at each physical line
- background remains open for cell padding
- OSC 8 and table borders do not leak
- Audit note: Upstream's partial markdown table reset is not equivalent to general wrap balancing.

#### Guarding tests

- packages/pi-tui/test/wrap-ansi.test.ts: foreground and background reset behavior
- packages/pi-tui/test/markdown.test.ts: inline-code style does not leak into table borders

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `PARTIAL`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/utils.ts
- packages/tui/src/components/markdown.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has table-cell style resets but does not balance all non-background attributes at every wrapped line boundary.

#### Retirement conditions

- Upstream must provide general wrap balancing for all tracked non-background attributes, not only markdown table cells.
- Run ANSI, markdown, OSC 8, and background-preservation tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Compared semantic reset behavior and recorded PARTIAL rather than ABSORBED_UPSTREAM.

### X022 — Editor public cursor synchronization setCursor

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host's replacement editor needs to restore a clamped line/column cursor without firing onChange, mutating history, or changing document text.

#### Changed surface

- Editor.setCursor line/column API
- grapheme-boundary clamping and repaint without onChange

#### Dependency map

**Vendor internal**
- setCursor uses editor line state, cursor clamping, and render invalidation without normal insertion side effects.
- Audit note: It is deliberately separate from setTextAndCursor (X023).

**Inheritance / structural**
- Host TuiEditor and SeatEditor adapters access the public method without a cast.
- Audit note: No override edge found.

**Host**
- src/editor-seat-holder.ts replacement-editor fallback and cursor restore
- Audit note: The host cannot restore the cursor through a public upstream equivalent.

**Public / extension**
- Editor component public method and HostEditorAdapter optional capability.
- Audit note: The cursor API is part of a compatibility boundary.

**Behavioral coupling**
- requested position clamps to existing line and grapheme boundary
- onChange and undo/history remain untouched
- repaint is requested
- Audit note: A setter that fires normal edit callbacks is not equivalent.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: setCursor clamping and no onChange
- test/editor-seat-non-owning.test.ts: replacement cursor handoff

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream exposes no public cursor synchronization method with the local side-effect-free contract.

#### Retirement conditions

- Provide an upstream public cursor setter with the same clamping, no-change, no-undo, and repaint semantics, then run seat handoff and cursor tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the replacement-editor host consumer and kept the seam active.

### X023 — Editor side-effect-free text/cursor staging

- Status: `ACTIVE`
- Category: `HARD_HOST_API`, `PUBLIC_COMPONENT_CONTRACT`
- Risk: `CRITICAL`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Declined editor replacement and seat handoffs need to install normalized text and a cursor without onChange, undo, history, or stale paste-marker side effects; staging must leave autocomplete state for the host to cancel conditionally after handoff.

#### Changed surface

- Editor.setTextAndCursor normalization and atomic staging
- paste registry pruning to markers surviving in staged text
- staging leaves autocomplete untouched while the host conditionally cancels stale completion after handoff

#### Dependency map

**Vendor internal**
- Editor document, cursor, history, undo stack, and paste registry are updated in one staging operation
- Autocomplete state is deliberately left untouched by setTextAndCursor
- Audit note: The pruning rule is part of marker ownership; stale-autocomplete cancellation belongs to the host handoff after staging.

**Inheritance / structural**
- Host TuiEditor/SeatEditor use the method through the editor adapter; no subclass override was found.
- Audit note: The public method avoids private casts.

**Host**
- src/editor-seat-holder.ts declined-key replacement fallback and wire handoff
- host.cancelAutocomplete is conditionally called after staging when the dropdown/request is stale
- Audit note: The host transfers drafts between editor seats; Editor.setTextAndCursor itself does not cancel autocomplete.

**Public / extension**
- HostEditorAdapter optional staging capability
- Editor public text/cursor contract
- Audit note: Callers depend on absence of edit callbacks during staging.

**Behavioral coupling**
- line endings and tabs normalize
- no onChange/no undo/history push
- staging does not cancel autocomplete
- the host conditionally cancels stale dropdown/request after staging
- surviving paste markers still expand and orphaned entries are released
- Audit note: A plain setText plus cursor setter would not preserve normalization, marker pruning, and callback/undo side effects; autocomplete cancellation is an explicit host decision after staging.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: public staging and normalization
- test/editor-registry.test.ts: declined fallback preserves autocomplete state and paste-registry pruning
- test/editor-seat-non-owning.test.ts: seat handoff and host stale-autocomplete cancellation

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has no atomic side-effect-free text/cursor staging operation and no equivalent paste-registry pruning contract.

#### Retirement conditions

- Provide a public upstream staging operation with all normalization, transient-state, undo/history, and marker-pruning semantics.
- Run editor registry, seat handoff, public API, and lifecycle tests before replacing the method.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the old preservePasteRegistry option is superseded by this stronger canonical staging contract.

### X024 — Line-head selections copy without emoji-column indent

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/tui-alt-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Fullscreen transcript lines reserve leading columns for a bullet/emoji. Copying a selection that begins at physical column zero should remove only that synthetic padding, while mid-line spaces and residual real indentation survive the bounded strip.

#### Changed surface

- copySelectionToClipboard receives selection start metadata
- line-head-only removal of one to three synthetic spaces

#### Dependency map

**Vendor internal**
- Alt-screen selection coordinates and flattened copied text are combined before invoking the clipboard callback.
- Audit note: The column check must happen before metadata is discarded.

**Inheritance / structural**
- TuiAltScreen owns the native selection and copy path inherited from TuiBase.
- Audit note: No host subclass can recover startColumn from final text.

**Host**
- src/clipboard.ts callback and fullscreen drag-copy UX
- Audit note: The host callback shape receives only final text.

**Public / extension**
- TuiAltScreen copySelection option is a public component contract.
- Audit note: The host cannot move this behavior to a string-only wrapper.

**Behavioral coupling**
- a single-row selection beginning at column zero strips synthetic padding
- a selection beginning mid-line keeps its first-row leading spaces
- four or more real indentation spaces are not all stripped; residual indentation survives
- Audit note: The implementation applies the column-zero strip per copied row; its bounded 1-to-3-space removal leaves residual indentation on four-plus-space lines. Multi-row selections beginning mid-line, ANSI, wide-grapheme, and scroll cases still need explicit coverage. A text-only host callback loses the selection metadata required for equivalence.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: line-head and mid-line selection copy cases
- test/clipboard.test.ts and fullscreen clipboard integration
- Missing dedicated multi-row mid-line/ANSI/wide-grapheme regression; add before retirement

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-alt-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream copySelection receives only flattened text and retains all leading spaces; neither the pinned baseline nor the audited upstream reference exposes selection start metadata for this rule.

#### Retirement conditions

- Expose selection metadata upstream or remove synthetic padding from selectable text, then map line-head, mid-line, and real-indentation behavior one-for-one.
- Run the selection and clipboard compatibility tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Reconfirmed the planned high-risk contradiction: a host text callback alone cannot replace X024.

### X025 — Explicit tsdown build config and package rename

- Status: `ACTIVE`
- Category: `PACKAGING`
- Risk: `HIGH`
- Files: `tsdown.config.ts`, `src/native-module-path.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The vendored package has an XMoon package shell and must build from its own CWD without the root tsdown config shadowing it. Native self-reference must follow the package rename.

#### Changed surface

- package-local tsdown entry/output/declaration configuration
- TUI_PACKAGE_NAME native-module self-reference uses @xmoon76/pi-tui

#### Dependency map

**Vendor internal**
- native-module-path resolves package metadata and optional native assets through the renamed package.
- Audit note: The package shell and source helper are coupled.

**Inheritance / structural**
- None found (audited).
- Audit note: No class inheritance dependency; build and package resolution are structural tooling contracts.

**Host**
- Root pnpm build invokes packages/pi-tui build before bundling the root package.
- Audit note: The published root artifact consumes the fork's generated dist.

**Public / extension**
- Root bundle and package exports resolve dist/index.mjs and declarations from the renamed private fork.
- Audit note: Package metadata is part of the install/build boundary.

**Behavioral coupling**
- building from packages/pi-tui is deterministic
- root tsdown does not shadow the fork config
- optional native lookup fails gracefully under the renamed scope
- Audit note: A source diff gate must not ignore this non-src divergence.

#### Guarding tests

- packages/pi-tui/test/native-module-path.test.ts: renamed package lookup and graceful fallback
- pnpm --dir packages/pi-tui build and root bundle build
- scripts/tarball-smoke.mjs package/export checks

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/native-module-path.ts
- packages/tui/package.json
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream package metadata and build contract use the Earendil scope/tooling. Copying them would break the private @xmoon76 package shell and root bundle build.

#### Retirement conditions

- Retire only if the package shell, package-local build configuration, output exports, and renamed native lookup are deliberately redesigned together.
- Run fork build, root build, declaration, tarball, and optional-native fallback checks.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Non-src packaging divergence was explicitly included in the structured ledger; the source diff gate will continue to ignore it while the ledger gate validates it.

### X026 — Injectable selection clipboard handler

- Status: `ABSORBED_UPSTREAM`
- Category: `HARD_HOST_API`
- Risk: `MEDIUM`
- Files: `src/tui-alt-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The former local clipboard seam is now provided by Earendil 0.84.4 through copySelection, copyOnSelect, and active-selection methods.

#### Changed surface

- Former local clipboard injection patch; current local source uses the upstream callback contract

#### Dependency map

**Vendor internal**
- TuiAltScreen selection and copy methods call the injected copySelection callback.
- Audit note: The behavior is now owned by the upstream implementation.

**Inheritance / structural**
- TuiAltScreen constructor options carry copySelection through the screen lifecycle.
- Audit note: No local replacement branch remains.

**Host**
- src/clipboard.ts callback supplies host clipboard policy and Copied!/Copy failed feedback.
- Audit note: The host remains a consumer of the upstream seam, not of a local divergence.

**Public / extension**
- TuiAltScreen copySelection/copyOnSelect public options.
- Audit note: The absorbed API must remain covered by surface compatibility tests.

**Behavioral coupling**
- single and double selection copy behavior remains native
- host callback result controls feedback
- Audit note: Absorption is semantic because the current API and callback ordering match.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: selection/copy behavior
- test/clipboard.test.ts: host callback feedback
- test/pi-component-compat.test.ts: public surface

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `YES`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-alt-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Pinned upstream natively supplies the callback and selection controls required by the host; the local source matches that API and no extra patch is re-applied.

#### Retirement conditions

- Keep the upstream copy-selection API and verify the host callback path on each re-vendor.

#### Replacement mapping

- Former local clipboard patch -> upstream copySelection/copyOnSelect/active-selection API; host policy remains src/clipboard.ts.

#### Retirement evidence

- Pinned source exposes all required callback and selection methods.
- Bundle clipboard tests pass through the upstream callback path without a local X026 patch.
- Gate evidence: fork typecheck, fork tests, generated-ledger validation, and strict source-diff coverage pass with the record absorbed.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Historical absorbed record rechecked against the pinned baseline and recorded Pi source. It remains a real host capability, but no longer a local divergence.

### X027 — fd directory typing does not rely on trailing separator

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/autocomplete.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

fd output can identify a directory without a trailing slash, including through symlinks. statSync classification preserves the directory path and uses the separator only as a fallback.

#### Changed surface

- typeDirectoryOutputLines stat-based directory classification
- trailing separator fallback only when stat fails

#### Dependency map

**Vendor internal**
- CombinedAutocompleteProvider and directory-output typing share path normalization and completion item construction.
- Audit note: The provider owns the behavior below host wrappers.

**Inheritance / structural**
- MentionProvider wraps the fork's CombinedAutocompleteProvider for shell-mode/path positions; the wrapper does not replace the fork classifier.
- Audit note: The current host passes fdPath=null to this inner provider for deterministic fallback, so no claim is made that the host's @-mention HostFilePort path exercises fd output.

**Host**
- src/mentions.ts delegates shell-mode command/path positions and slash-command-name completion to CombinedAutocompleteProvider
- public AutocompleteProvider consumers may provide an fd-backed provider
- Audit note: The current @ flow uses HostFilePort/discoverMention and the /image path uses completeImageArgument/LocalFileSource; neither is counted as a direct fd consumer of X027.

**Public / extension**
- AutocompleteProvider output is public through editor completion integration
- CombinedAutocompleteProvider accepts an fd-backed path for callers that opt into it
- Audit note: Directory item type and insertion behavior are observable when the fd-backed provider path is used.

**Behavioral coupling**
- bare directory lines remain directories
- symlinks are followed by stat
- failed stat keeps a trailing separator as a fallback
- Audit note: The audited upstream reference also changed nested/fuzzy ordering, which is not part of X027.

#### Guarding tests

- packages/pi-tui/test/autocomplete.test.ts: typeDirectoryOutputLines and fd-backed provider cases
- test/file-completion-convergence.test.ts: host file completion is explicitly separate and does not prove fd-path usage

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/autocomplete.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference classify plain fd lines by trailing slash and slice directory names; the local path uses stat first and avoids dropping the final character.

#### Retirement conditions

- Retire only when upstream directory completion classifies bare and symlinked directories with the same insertion text and fallback behavior.
- Run fd, symlink, trailing-slash, and host @ completion tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Separated X027 from upstream's unrelated nested/fuzzy autocomplete changes. The current host's @ and /image paths are separate from fd output; the public fd-backed provider path remains a supported vendor capability, so this is not classified as unused.

### X028 — Fullscreen viewport boundary, pre-input, and search-reset seams

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `CRITICAL`
- Files: `src/tui-alt-screen.ts`, `src/components/scroll-view.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host virtual transcript owns paging and search while the fork owns viewport mechanics. Boundary callbacks, pre-input interception, canScroll, and clearSearch let both owners cooperate without duplicating the scroll implementation.

#### Changed surface

- onScrollBoundary for final unconsumed edge attempts
- onBeforeViewportInput before built-in Home/End/Page handling
- ScrollView.canScroll and host prompt-navigation fallthrough
- clearSearch and previous/next prompt routing

#### Dependency map

**Vendor internal**
- TuiAltScreen viewport listener, ScrollView scroll state, built-in search, and scrollbar edge detection share input ordering.
- Audit note: The seams are coupled to the primary scroll view, not arbitrary callbacks.

**Inheritance / structural**
- TuiAltScreen owns a ScrollView and routes its viewport input before component dispatch.
- Audit note: No host wrapper can reproduce the built-in scrollbar/viewport state safely.

**Host**
- src/tui-app.ts wires onBeforeViewportInput and onScrollBoundary, owns virtual transcript paging/Home/End, and calls clearSearch for jumpLatest and prompt navigation
- Audit note: Host wires the callbacks and clearSearch; ScrollView.canScroll is consumed internally by TuiAltScreen as fallback state, not called by the host.

**Public / extension**
- TuiAltScreenOptions viewport callbacks and ScrollView.canScroll public component shape.
- Audit note: The seams are part of compatibility tests.

**Behavioral coupling**
- only a primary viewport edge emits a boundary
- host pre-input can claim semantic keys before built-ins
- short transcripts let keys fall through to focused components
- jump-latest resets built-in search
- Audit note: Restoring upstream can silently consume navigation keys or bypass virtual transcript ownership.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: boundary, overscroll, page, scrollbar, and search reset
- packages/pi-tui/test/tui-shrink.test.ts and ScrollView canScroll coverage
- test/home-end-keys.test.ts: bundle Home/End ownership

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-alt-screen.ts
- packages/tui/src/components/scroll-view.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream lacks the host callbacks and canScroll seam; its built-in viewport behavior cannot express virtual transcript paging or host pre-input ownership.

#### Retirement conditions

- Provide an upstream listener/viewport contract that maps edge, pre-input, search reset, canScroll, and prompt navigation semantics one-for-one.
- Run fullscreen interaction and host virtual transcript tests before any replacement.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Rechecked all four seams and the short-transcript fallthrough; KEEP HARD.

### X029 — Editor history callbacks

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host must preserve !/!! input mode across prompt recall and history-draft browsing. Recall, save, and restore callbacks provide the mode-aware history contract.

#### Changed surface

- onRecall callback
- onHistoryDraftSave callback
- onHistoryDraftRestore callback

#### Dependency map

**Vendor internal**
- Editor history navigation invokes callbacks at recall and draft transitions in a defined order.
- Audit note: The callbacks are attached to internal history branches.

**Inheritance / structural**
- TuiEditor assigns the callback properties on its Editor instance.
- Audit note: No private cast is used for these callbacks.

**Host**
- src/tui-editor.ts mode-aware history adapter
- src/editor-seat-holder.ts draft handoff
- Audit note: The host stores and restores mode metadata outside the vendor document.

**Public / extension**
- Editor public callback properties are consumed by the host adapter.
- Audit note: Third-party editor subclasses could observe the same public shape.

**Behavioral coupling**
- recall round-trips mode
- history draft save/restore does not turn mode prefixes into document text
- up/down browsing remains compatible
- Audit note: A generic history API without mode callbacks is only partial.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: editor history callbacks and keybindings
- test/editor-input-mode.test.ts: !/!! mode round-trip

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has no mode-aware history callback properties; Kimi's similar callbacks are design evidence, not upstream equivalence.

#### Retirement conditions

- Provide a public history event/callback contract that preserves mode metadata and draft transitions, then run editor and host mode round-trip tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed callbacks are direct host API consumers and not removed kimi-only residue.

### X030 — decodePrintableKey root re-export

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/index.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host imports decodePrintableKey from the package root for editor mode parsing, footer configuration, and keybinding UI. The implementation remains in keys.ts; this divergence is the public re-export.

#### Changed surface

- index.ts root export of decodePrintableKey

#### Dependency map

**Vendor internal**
- Vendor Editor imports decodePrintableKey relatively from keys.ts; it does not depend on the root re-export.
- Audit note: Internal and root consumers were distinguished.

**Inheritance / structural**
- None found (audited).
- Audit note: No inheritance edge; the contract is package entry export shape.

**Host**
- src/tui-editor.ts !/!! printable parsing
- src/footer/configurator.ts
- src/keybinding-ui/list.ts
- Audit note: The TuiEditor consumer was explicitly included in this audit.

**Public / extension**
- Package root export map exposes the decoder to host and public integrations.
- Audit note: The host cannot deep-import the private keys.ts path through the exports map.

**Behavioral coupling**
- root import resolves the same decoder as the relative internal path
- printable key parsing stays consistent across editor and configuration UI
- Audit note: Moving or copying the function could create two decoder implementations.

#### Guarding tests

- packages/pi-tui/test/keys.test.ts: direct src/index root export smoke and decoder behavior
- test/editor-input-mode.test.ts: !/!! mode codec behavior
- test/keybinding-integration.test.ts and footer configurator tests

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/index.ts
- packages/tui/src/keys.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference define decodePrintableKey in keys.ts but do not export it from the package root; the root public entry remains a real host dependency.

#### Retirement conditions

- Upstream must export the same decoder from its package root with compatible declarations, or a deliberate package API migration must update every root consumer and compatibility fixture.
- Do not replace this with a host copy while the package exports map remains root-only.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Corrected the incomplete old consumer inventory: TuiEditor, footer configurator, and keybinding UI all use the root export.

### X031 — CJK URL boundary tokenizer

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/components/markdown.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Marked GFM autolinks can absorb CJK or full-width punctuation after a bare URL. The tokenizer cuts at the first boundary while keeping balanced full-width parentheses in the URL.

#### Changed surface

- CjkBoundaryUrlTokenizer URL token boundary logic
- Markdown parser extension registration

#### Dependency map

**Vendor internal**
- Markdown parser tokenizers and rendered link nodes share the boundary result.
- Audit note: The change is inside the fork Markdown component.

**Inheritance / structural**
- Markdown component wraps marked output without a host subclass override.
- Audit note: No structural consumer found beyond the component path.

**Host**
- TranscriptFolder output and message renderers display Markdown containing CJK URLs.
- Audit note: transcript.ts emits message/fold data; package Markdown and host renderers perform wrapping and display. Host transcript content supplies the real punctuation cases.

**Public / extension**
- Public Markdown component/render path consumes marked tokens.
- Audit note: Rendered href/text are observable.

**Behavioral coupling**
- CJK punctuation is not included in bare URL href/text
- balanced full-width parentheses remain eligible
- ordinary Latin URLs retain marked behavior
- Audit note: A generic URL tokenizer with a similar name is not enough without boundary semantics.

#### Guarding tests

- packages/pi-tui/test/markdown.test.ts: CJK and full-width punctuation after bare URLs
- test/rendering.test.ts: transcript Markdown rendering

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/markdown.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference marked configuration does not contain the CJK boundary tokenizer; the old landed-upstream note was incorrect.

#### Retirement conditions

- Retire only when upstream or the Markdown owner provides equivalent CJK/full-width URL boundary and balanced-parenthesis behavior.
- Run Markdown link and transcript rendering tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Both the pinned baseline and the audited upstream reference source were checked; no issue closure was treated as absorption.

### X032 — Container.render width clamp

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/tui.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

A non-positive width must be clamped before it reaches component repeat/padding logic so narrow or transient geometry cannot crash the whole render tree.

#### Changed surface

- Container.render clamps width to at least one column

#### Dependency map

**Vendor internal**
- Container width is passed to every child component render and layout helper.
- Audit note: The entry-point clamp protects the whole component tree.

**Inheritance / structural**
- Container is the base for Box/Stack and host component containers.
- Audit note: Inherited render paths receive the clamped width.

**Host**
- Host narrow terminal and responsive overlay layouts can transiently produce zero or negative grants.
- Audit note: The host supports narrow terminals and resize rebuilds.

**Public / extension**
- Extension components are rendered under Container-owned widths.
- Audit note: The defensive boundary protects third-party components too.

**Behavioral coupling**
- width 0 and negative widths become one
- positive widths are unchanged
- child rendering does not receive invalid repeat counts
- Audit note: This is defense-in-depth even where the normal host minimum is larger.

#### Guarding tests

- packages/pi-tui/test/tui-render.test.ts: width 0, -3, and 5 clamp behavior
- test/frame-tiny.test.ts and narrow host render suites

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream passes non-positive Container widths to child rendering; it does not provide the local entry-point clamp.

#### Retirement conditions

- Retire only if every supported geometry path guarantees a positive width before Container.render and direct negative-width regressions remain covered.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Kept as a cheap whole-tree defensive boundary; no behavior cleanup was attempted.

### X033 — Overwide rendered lines are truncated, not fatal

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/tui-main-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Host components can produce a line one or more columns wider than a transient terminal width. The main screen must truncate it instead of throwing and taking down the TUI.

#### Changed surface

- overwide non-image line truncation to terminal width
- truncate-before-segment-reset ordering

#### Dependency map

**Vendor internal**
- TuiMainScreen line processing, ANSI segment reset, kitty image scan, and differential render cache share processed-line output.
- Audit note: X033 and X035 are separate ownership records over the same processing pass.

**Inheritance / structural**
- TuiMainScreen extends the screen base and processes all rendered component lines.
- Audit note: No host subclass can catch a throw after the screen processing path.

**Host**
- Host narrow-terminal layouts, transcript cards, and wide graphemes.
- Audit note: The host deliberately supports responsive and 40-column surfaces.

**Public / extension**
- Extension renderer output is passed into the same main-screen line processor.
- Audit note: A plugin can produce an overwide grapheme or styled line.

**Behavioral coupling**
- overwide ordinary lines are clipped rather than fatal
- reset is appended after the truncation slice
- image line behavior remains separate
- Audit note: Changing only the throw to a slice before reset can leak styles.

#### Guarding tests

- packages/pi-tui/test/tui-render.test.ts: overwide, styled, CJK, and reset ordering
- test/frame-tiny.test.ts and narrow host render coverage

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-main-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream throws on overwide rendered lines; local processing truncates before appending the complete segment reset.

#### Retirement conditions

- Retire only if upstream accepts overwide lines without fatal termination and preserves truncation/reset/image ordering.
- Run narrow-width and styled-line regressions across the cold and cached processing paths.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the reset ordering and its cross-dependency with X035; kept active.

### X034 — wordWrapLine single-grapheme overwide guard

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

An atomic grapheme wider than the available width cannot be split. The guard prevents recursive rewrapping from overflowing the call stack; X033 clips the eventual screen line.

#### Changed surface

- wordWrapLine sub-grapheme width check before recursive wrapping

#### Dependency map

**Vendor internal**
- Editor draft wrapping, cursor row mapping, and main-screen truncation depend on the overwide grapheme result.
- Audit note: The guard is inside Editor's recursive wrapping helper.

**Inheritance / structural**
- TuiEditor uses the vendor Editor wrapping implementation through composition/subclassing.
- Audit note: No independent host wrapper can prevent recursion once the helper is called.

**Host**
- Host editor at widths 1-8 and responsive draft/editor seats.
- Audit note: CJK and ZWJ drafts exercise the boundary.

**Public / extension**
- Editor render behavior is visible to host and editor integrations.
- Audit note: The helper itself is private but its rendering contract is public.

**Behavioral coupling**
- wide CJK/ZWJ grapheme produces one chunk
- no RangeError from recursive wrapping
- cursor and line rendering remain usable at narrow widths
- Audit note: The one-column overflow is intentionally handled by X033.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: wordWrapLine and narrow Editor rendering at widths 1-8
- packages/pi-tui/test/tui-render.test.ts: narrow screen clipping

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream recursively rewraps a single overwide grapheme and can overflow the stack; it does not provide the local base case.

#### Retirement conditions

- Retire only with an upstream grapheme-aware base case that preserves narrow Editor rendering and cursor mapping, then run CJK/ZWJ width tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Kept active because the failure is an editor-internal recursion hazard, not an absence of host imports.

### X035 — Per-frame processed-line reuse

- Status: `ACTIVE`
- Category: `PERF_HOST_DEPENDENT`
- Risk: `HIGH`
- Files: `src/tui-main-screen.ts`, `src/utils.ts`, `src/tui.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Steady transcript frames should process only changed rendered line values. The host keeps component render arrays stable as a useful render optimization, while the main-screen cache itself compares primitive string values and can reuse equal fresh strings too.

#### Changed surface

- previousRawLines and previousLineImageIds caches
- value-equality processing fast path
- asciiVisibleWidth and exported SEGMENT_RESET support
- cache invalidation on width/state restore

#### Dependency map

**Vendor internal**
- TuiMainScreen differential processing, image-id scanning, truncation/reset, and TuiBase render state restoration share cache validity.
- Audit note: The cache is invalidated on width changes and state resets.

**Inheritance / structural**
- TuiMainScreen compares each rendered line value with the previous line value; component-array identity is not required for the string cache hit.
- Audit note: The contract is value-based for strings, not reference-based.

**Host**
- src/tui-app.ts BulletedComponent and ThinkingCompactComponent return stable arrays as an upstream render optimization
- long transcript and streaming spinner frames
- Audit note: Host stability helps avoid upstream render work, but is not the proof of the main-screen line-cache hit.

**Public / extension**
- Extension renderer components enter the same line-processing pipeline.
- Audit note: The cache behavior is observable through rendered output and performance, not a public cache method.

**Behavioral coupling**
- steady equal line values write no changes
- fresh arrays with equal primitive strings also hit the cache
- width changes invalidate reuse
- cached and cold paths both truncate/normalize/reset equivalently
- kitty image IDs remain aligned
- Audit note: Upstream BoundedTerminalWriter solves output-string size, not this per-frame reuse contract.

#### Guarding tests

- packages/pi-tui/test/tui-render.test.ts: equal primitive-line frame and steady-frame performance regression
- packages/pi-tui/test/render-preprocess-bench.ts: 1k-10k line benchmark
- test/rendering.test.ts: indirect host component-array stability only; it does not prove main-screen cache identity
- Missing direct cache invalidation, cold/cached equivalence, image-ID alignment, and instrumentation assertions

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-main-screen.ts
- packages/tui/src/utils.ts
- packages/tui/src/tui.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference reprocess every line each frame. Its bounded writer prevents huge output formation but does not replace value-based per-frame line reuse or the host render-cost contract.

#### Retirement conditions

- Provide a benchmarked replacement with equal steady-frame CPU and allocation cost at representative transcript sizes.
- Run cold/cached render, image-id, width-invalidation, and host reference-stability tests before removal.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: KEEP PERF CONTRACT. The audit corrected the old reference-identity wording: the implementation compares primitive string values, so fresh equal strings also reuse processed output. Performance behavior still requires benchmark evidence rather than host imports alone.

### X036 — FOCUS_IN and FOCUS_OUT reach app listeners

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/tui-alt-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Fullscreen focus reports must clean up native selection on FOCUS_OUT while still reaching app-level listeners for notification suppression and clipboard/image tracking.

#### Changed surface

- viewport focus handler performs cleanup then returns undefined for FOCUS_IN/FOCUS_OUT

#### Dependency map

**Vendor internal**
- Alt-screen viewport focus cleanup and TuiBase/app input listener fan-out share the listener result.
- Audit note: Cleanup and passthrough must happen in that order.

**Inheritance / structural**
- TuiAltScreen inherits TuiBase listener dispatch and installs the viewport listener.
- Audit note: No host workaround can observe a consumed report.

**Host**
- TuiApp.routeInput/handleInput focus tracking
- notification and clipboard-image focus policy
- Audit note: The app listener is registered above the viewport path.

**Public / extension**
- App input listener registration is a host/extension-adjacent input contract.
- Audit note: Raw focus reports remain internal to the screen but fan-out is observable.

**Behavioral coupling**
- FOCUS_OUT clears alternate-screen selection
- FOCUS_IN and FOCUS_OUT are still observed by app listeners
- the app listener passthrough is ordered after alternate-screen cleanup
- Audit note: The divergence is an alternate-screen cleanup/passthrough contract; no main-screen FOCUS handler parity claim is made.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: app listener observes both focus reports and selection cleanup remains
- test/focus-ui.test.ts and notification focus behavior

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-alt-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream consumes both focus reports inside the alt-screen viewport handler; local behavior cleans up FOCUS_OUT and passes both reports through.

#### Retirement conditions

- Retire only when upstream provides equivalent cleanup plus app-listener fan-out on the alternate screen, then run focus and notification tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the passthrough is required after cleanup and is not safely movable to a host text/search layer.

### X037 — Editor-owned submit binding tui.editor.submit

- Status: `ACTIVE`
- Category: `HARD_HOST_API`, `PUBLIC_COMPONENT_CONTRACT`
- Risk: `CRITICAL`
- Files: `src/keybindings.ts`, `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Editor submission must be remappable without changing plain Input submission. The editor binding is also shared by physical-submit detection, PasteBurst, and backslash-Enter fallback.

#### Changed surface

- process-global tui.editor.submit binding definition
- Editor submit and backslash-enter checks use the editor binding
- X038 physical Enter detection reads the same effective binding

#### Dependency map

**Vendor internal**
- Editor submit branch, PasteBurst physical-submit check, backslash-enter fallback, and keybinding registry share tui.editor.submit.
- Audit note: All three Editor paths must move together.

**Inheritance / structural**
- TuiEditor is a host subclass/composition boundary over the vendor Editor; keybinding names are structural process-global state.
- Audit note: A host interception cannot reproduce all internal branches safely.

**Host**
- src/keybindings/manager.ts onEditorSubmitSync
- src/tui-app.ts editorAccepts inventory and dispose-time default restore
- src/keybindings/definitions.ts
- Audit note: The host remaps editor submission while keeping tui.input.submit at enter.

**Public / extension**
- Editor public submit behavior and keybinding contract
- Stable/Advanced editor integrations observe submit semantics
- Audit note: The dedicated binding prevents configuration leakage into plain Inputs.

**Behavioral coupling**
- submit: ctrl+x affects Editor but not question/search Input
- physical Enter under a remapped binding is distinguished from the remapped chord
- backslash-enter uses the effective editor submit keys
- Audit note: A host-only interception would bypass or duplicate X038 and Editor internal semantics.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: editor submit binding split
- test/keybinding-integration.test.ts: anti-pollution and default restore
- packages/pi-tui/test/keybindings.test.ts: binding registry

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/keybindings.ts
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has only tui.input.submit; it cannot express the editor-only binding or its shared physical-submit semantics.

#### Retirement conditions

- Upstream must provide a per-editor binding/action consumed by submit, PasteBurst physical-submit detection, and backslash-enter fallback.
- Run anti-pollution, remap, PasteBurst, history, and editor input tests before changing either half.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: KEEP HARD. Cross-audited with X038; both the binding definition and editor call sites are required.

### X038 — PasteBurst non-bracketed paste fallback

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/paste-burst.ts`, `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Terminals and tmux can lose bracketed-paste markers and deliver a paste as rapid plain characters. The trailing physical Enter must insert a newline rather than submit a partial draft.

#### Changed surface

- PasteBurst single-character timing detector
- Editor disablePasteBurst option/setter and integration
- physical-submit Enter suppression with X037 remap distinction

#### Dependency map

**Vendor internal**
- PasteBurst state, Editor input loop, bracketed-paste path, insert-point feeds, and submit binding are one input-ordering contract.
- Audit note: The multi-character chunk reset is intentional for typed-ahead/test input.

**Inheritance / structural**
- TuiEditor exposes the disablePasteBurst setter through its Editor integration.
- Audit note: No host copy can observe each physical character after the fork parser consumes it.

**Host**
- Host editor paste path across SSH, tmux, iTerm2, and remapped submit configurations.
- Audit note: The bugfix is editor-internal and deliberately has no single host import consumer.

**Public / extension**
- Editor constructor option and setDisablePasteBurst integration surface.
- Audit note: Integrations can opt out while the default remains enabled.

**Behavioral coupling**
- eight or more single chars within the burst window mark a paste
- physical Enter is suppressed to newline
- remapped submit chord still submits mid-burst
- physical Enter under a remap breaks the burst
- Audit note: The X037 cross-semantics are part of this record.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: PasteBurst fallback and X037 cross tests
- docs/tmux-testing.md: two-step terminal driving guidance
- test/editor-input-mode.test.ts: submit behavior

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference have no PasteBurst fallback or disable option. The local editor-internal terminal behavior cannot be judged unused from host imports.

#### Retirement conditions

- Retire only if supported terminal environments provide reliable bracketed paste markers or upstream implements an equivalent fallback and opt-out contract.
- Run terminal/tmux timing, remapped submit, and editor input tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Restored and re-audited after the earlier incorrect no-host-consumer removal.

### X039 — WIDTH_CACHE_SIZE 4096

- Status: `ACTIVE`
- Category: `PERF_HOST_DEPENDENT`
- Risk: `MEDIUM`
- Files: `src/utils.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

CJK-heavy host transcripts and width/theme invalidation bursts are intended to benefit from a 4096-entry non-ASCII width cache; the upstream 512-entry FIFO may thrash in those bursts, pending an isolated benchmark.

#### Changed surface

- WIDTH_CACHE_SIZE constant 4096 instead of 512

#### Dependency map

**Vendor internal**
- visibleWidth, wrapping, layout measurement, and render preprocessing share the non-ASCII width cache.
- Audit note: The cache is global utility state with bounded eviction.

**Inheritance / structural**
- None found (audited).
- Audit note: No inheritance edge; all width callers use the utility.

**Host**
- CJK-heavy transcript, Markdown, fullscreen, and theme invalidation paths.
- Audit note: The consumer is measured burst workload.

**Public / extension**
- Extension-rendered text uses visibleWidth indirectly.
- Audit note: No public cache API is exposed.

**Behavioral coupling**
- cache remains bounded
- a larger working set is intended to reduce repeated CJK measurement
- width results remain identical
- Audit note: The current render-preprocess benchmark targets X035 and contains incidental CJK lines; it does not establish a 4096-versus-512 result for X039. Removal must be decided by an isolated benchmark, not import search.

#### Guarding tests

- packages/pi-tui/test/layout.test.ts and wrap-ansi.test.ts: width correctness
- packages/pi-tui/test/render-preprocess-bench.ts: X035 render benchmark with incidental CJK workload
- Missing isolated 4096-vs-512 cache-size assertion and reproducible CJK burst benchmark

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/utils.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference use a 512-entry cache; local uses 4096 intending to reduce CJK burst thrashing, but an isolated 4096-versus-512 measurement remains pending.

#### Retirement conditions

- Run a repeatable CJK burst benchmark across cold, theme-change, and width-change paths.
- Retire only if 512 or an upstream replacement is no worse within the agreed performance budget.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: KEEP unless benchmark disproves the workload benefit; no behavior change was made.

### X040 — Input.setValue cursor placement

- Status: `ACTIVE`
- Category: `PUBLIC_COMPONENT_CONTRACT`
- Risk: `HIGH`
- Files: `src/components/input.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Prefilled query and draft inputs should place the cursor at the end by default, while callers doing mid-edit replacement can request a clamped preserved cursor explicitly.

#### Changed surface

- Input.setValue(value, { cursor }) option
- default end placement and preserve mode

#### Dependency map

**Vendor internal**
- Input value, cursor clamp, search filter, and render cursor marker share setValue semantics.
- Audit note: X041 calls this through SearchablePicker filter synchronization.

**Inheritance / structural**
- SettingsList owns Input children and forwards focus; the Host SearchablePicker owns its search Input.
- Audit note: Wrapper behavior depends on the child's cursor placement.

**Host**
- SearchablePicker initialQuery/setFilter
- src/history-panel.ts history query
- src/task-panel.ts task query
- src/question.ts question draft/prefill paths
- Audit note: These callers append or continue typing after prefill; the cited host paths are concrete setValue consumers rather than a generic editor-adjacent bucket.

**Public / extension**
- Input public setValue API and picker/filter adapters.
- Audit note: The option is part of the component contract.

**Behavioral coupling**
- setValue('foo') then typing appends by default
- preserve explicitly retains a clamped mid-edit cursor
- filter query synchronization keeps the cursor at the end
- Audit note: Upstream/kimi clamp-at-zero behavior is not equivalent for prefills.

#### Guarding tests

- packages/pi-tui/test/input.test.ts: X040 cursor semantics
- test/searchable-picker.test.ts: initial query/filter continuation
- Host setValue callsites in history-panel.ts, task-panel.ts, and question.ts were audited; no direct host cursor assertion exists

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/input.ts
- packages/tui/src/components/select-list.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Both the pinned baseline and the audited upstream reference setValue preserves/clamps the existing cursor at zero for a fresh Input; they do not provide the local end-by-default plus explicit preserve option.

#### Retirement conditions

- Provide an upstream setValue cursor contract with end-by-default prefills and explicit preserve semantics, then run Input, SearchablePicker, question, and history tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Kept with X041 because canonical filter synchronization relies on the end-placement behavior.

### X041 — SelectList canonical filter query

- Status: `MOVED_TO_HOST`
- Category: `HARD_HOST_API`, `PUBLIC_COMPONENT_CONTRACT`
- Risk: `HIGH`
- Files: `src/components/select-list.ts`
- Last audited: `2026-09-07`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

filterQuery is the single source of truth for the rendered search box, getFilter, setFilter, setItems, and category switches. This prevents programmatic filters from disappearing on the next keypress.

#### Changed surface

- filterQuery canonical state
- setFilter synchronizes the search Input and applies the filter
- getFilter and setItems read the same canonical query

#### Dependency map

**Vendor internal**
- SearchablePicker search Input, filter application, item replacement, selection, and category rebuild share filterQuery.
- Audit note: The source-of-truth rule prevents mirrored search state.

**Inheritance / structural**
- MarqueeFilterAdapter wraps SearchablePicker and reads getFilter through the public shape; it does not call setFilter.
- Audit note: The host PickerHandle getFilter/setFilter closures are separate structural adapters; no subclass override was found.

**Host**
- src/tui-app.ts categorized picker query handoff and category cycle
- src/commands.ts session prefill and row enrichment
- src/tui-app.ts PickerHandle getFilter/setFilter closures and MarqueeFilterAdapter getFilter read
- Audit note: Host calls both programmatic and typed filter paths through distinct adapters; the categorized lifecycle consumes initialQuery once and category navigation preserves the live query (an empty query stays empty).

**Public / extension**
- SearchablePicker.getFilter/setFilter are Host component methods; the restored vendored SelectList keeps only the upstream setFilter.
- Audit note: AdvancedSelectOptions does not expose these methods; the host PickerHandle adapter lives in src/tui-app.ts, so its public-host status is kept distinct from the package component contract.

**Behavioral coupling**
- programmatic filter is visible in the search box
- next key refines rather than resets the programmatic query
- setItems preserves the live query
- initialQuery is consumed only when the categorized picker lifecycle is created; a cleared (empty) query is a valid live state and never falls back to the initial value
- getFilter is truthful with search disabled
- Audit note: X040 cursor placement is part of the visible continuation behavior. Typed input, programmatic setFilter, setItems refreshes, category cycle, setCategory, and external-search handoff all preserve the one live canonical query, including the empty-string state.

#### Guarding tests

- test/searchable-picker.test.ts: canonical filter state
- test/session-picker-loading.test.ts and picker category/filter integration
- test/session-categories.test.ts: initialQuery consumed-once, programmatic cross-category carry, and typed/cleared lifecycle regressions

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/select-list.ts
- packages/tui/src/components/input.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has no searchable SelectList or canonical filter state. The local query behavior is not present to absorb.

#### Retirement conditions

- Retire only together with X001/X002 after a replacement has one query source of truth across typed, programmatic, setItems, category, and advanced ui.select paths.

#### Replacement mapping

- SelectList canonical filterQuery/getFilter/setFilter -> SearchablePicker canonical query state -> test/searchable-picker.test.ts
- categorized picker query lifecycle -> TuiApp live `query` -> initialQuery consumed once at lifecycle creation -> test/session-categories.test.ts regressions
- categorized/session-search query carry -> TuiApp categorized picker initialQuery handoff -> SearchablePicker canonical query -> test/session-categories.test.ts and test/session-picker-content-search.test.ts

#### Retirement evidence

- packages/pi-tui/src/components/select-list.ts restored byte-identical to pinned upstream b79e4cc (diff empty)
- test/searchable-picker.test.ts green: programmatic/typed/setItems/initialQuery query paths share one canonical state; search-disabled programmatic filter covered
- test/session-categories.test.ts green: initialQuery clears once and never resurrects on Tab; programmatic and typed queries survive category switches; cleared-empty survives
- categorized/session-search integration tests green
- fork typecheck/test/build, surface compat, divergence ledger, strict vendor diff, root build/typecheck/test:bundle green

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Relocated to the Host-owned SearchablePicker/TuiApp picker lifecycle. initialQuery is consumed only at lifecycle initialization; typed, programmatic, setItems, category and external-search paths preserve one live canonical query, including the empty-string state.

### X042 — Focusable propagation on Input-owning lists

- Status: `ACTIVE`
- Category: `PUBLIC_COMPONENT_CONTRACT`
- Risk: `HIGH`
- Files: `src/components/settings-list.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

List wrappers own the Input or submenu the user actually types into. Focus state must propagate so the cursor marker and IME candidate positioning follow the focused child.

#### Changed surface

- SettingsList Focusable propagation reaches search Input and conditionally forwards to an open submenu
- row-budget forwarding for nested submenu lists
- SettingsList mouse hit-testing uses the FINAL painted rows (a render-time mouseRows map built after the description shrink AND the tail slice), never a re-derived range from maxVisible — a click hits the row the user actually saw, resolved by item ID with pressed-identity click activation; the search Input is reachable only where the LAST paint put it (the tail slice may drop it off-screen — a click on the row that replaced it must not reach the hidden input); every left press replaces the gesture identity at handler entry (a delegated search press or an inert-row press clears the old latch — a later synthesized click on the same cell must not activate an item that repainted there)

#### Dependency map

**Vendor internal**
- SettingsList submenu/search lifecycle shares focus and row-budget state.
- Audit note: The SelectList-side Input focus ownership moved to the Host SearchablePicker; the remaining vendor-owned seam is SettingsList.

**Inheritance / structural**
- SettingsList implements Focusable; SettingsList forwards only when a submenu structurally exposes focused.
- Audit note: The conditional optional-method edge is real; post-v0.85.1 audit: ALL four Host submenu wrappers (ThemeSubmenu, ModelSubmenu, EffortSubmenu, SubagentModelAllowlistSubmenu) implement Focusable and forward the focused flag to their inner SettingsList (re-applied after async inner swaps), so the SettingsList propagateFocus() edge reaches every submenu's focus-sensitive child.

**Host**
- src/tui-app.ts FocusForwardingFrame and settings overlays
- src/theme-menu.ts, src/model-menu.ts, and src/subagent-model-menu.ts submenu wrappers
- test/theme-picker.test.ts and test/model-menu.test.ts CURSOR_MARKER regressions
- Audit note: Host frames rely on the child accepting focus; editor-seat-holder.ts is an editor seat/draft handoff rather than a list-focus wrapper. Post-v0.85.1 audit: all four submenu wrappers (ThemeSubmenu, ModelSubmenu, EffortSubmenu, SubagentModelAllowlistSubmenu) forward Focusable state to their inner SettingsList/Input, including ModelSubmenu's async inner replacement (the swapped-in searchable list receives the already-active focus and emits CURSOR_MARKER); the non-searchable wrappers (EffortSubmenu, SubagentModelAllowlistSubmenu) forward the flag too, so no IME/cursor path is lost at any wrapper boundary.

**Public / extension**
- Focusable component interface and row-budget-aware submenu public shape.
- Audit note: The public wrapper contract is used by host and extensions, but optional structural focus must be made explicit by each submenu owner.

**Behavioral coupling**
- focused top-level SettingsList emits cursor marker through its actual Input
- IME candidate window follows top-level search focus
- submenu receives focus only when it implements Focusable
- selection/description tail remains within budget
- Audit note: Post-v0.85.1 audit: ALL four Host submenu wrappers implement Focusable and forward the focused flag to their inner SettingsList (re-applied after async inner swaps), so the SettingsList propagateFocus() edge reaches every submenu's focus-sensitive child; no follow-up gap remains.

#### Guarding tests

- packages/pi-tui/test/settings-list.test.ts: focus/row-budget behavior
- test/extension-focus-seat.test.ts: SurfaceSnapshot.focusedSeat state only (not SettingsList or IME)
- test/theme-picker.test.ts: ThemeSubmenu forwards focused state to the search Input (CURSOR_MARKER present when focused, absent when not)
- test/model-menu.test.ts: ModelSubmenu retains focus across the async inner swap (CURSOR_MARKER on the swapped-in searchable list only when focused)
- packages/pi-tui/test/settings-list.test.ts: description-shrink click identity (Case A), search+shrink row offset (Case B), inert chrome (Case C)

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/select-list.ts
- packages/tui/src/components/settings-list.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream lists do not implement the local focus propagation and nested row-budget forwarding contract.

#### Retirement conditions

- Provide equivalent upstream Focusable propagation and nested row-budget semantics, then run IME, cursor marker, submenu, and extension focus lifecycle tests.

#### Replacement mapping

- SelectList-side Input focus ownership -> moved to Host SearchablePicker (src/searchable-picker.ts) -> test/searchable-picker.test.ts focus tests
- remaining vendor-owned seam -> SettingsList focus/row-budget propagation -> packages/pi-tui/test/settings-list.test.ts

#### Retirement evidence

- SelectList-side focus forwarding removed from the fork; the restored select-list.ts matches the pinned upstream baseline (diff empty)
- test/searchable-picker.test.ts focus tests green (focused flag reaches the search Input cursor marker)
- packages/pi-tui/test/settings-list.test.ts focus/row-budget behavior green
- fork typecheck/test/build, surface compat, divergence ledger, strict vendor diff, root build/typecheck/test:bundle green

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: The SelectList side of this divergence moved to the Host SearchablePicker; the record now covers only the SettingsList vendor seam. Re-audited after the v0.85.1 mouse-parity pass: ALL four Host submenu wrappers (ThemeSubmenu, ModelSubmenu, EffortSubmenu, SubagentModelAllowlistSubmenu) implement Focusable and forward the focused flag to their inner SettingsList (re-applied after async inner swaps); CURSOR_MARKER regressions cover the searchable wrappers, and the non-searchable wrappers forward the flag too, so no IME/cursor path is lost at any wrapper boundary.

### X043 — Deferred viewport input listener registration

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `CRITICAL`
- Files: `src/tui-alt-screen.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Fullscreen host routing must register before the viewport listener so raw captures and host policy see every chunk before built-in scrolling consumes it.

#### Changed surface

- deferViewportListener constructor option
- idempotent installViewportListener method
- host router-first registration order

#### Dependency map

**Vendor internal**
- TuiAltScreen constructor, viewport listener, input dispatch order, and host listener installation share registration timing.
- Audit note: Listener order is a lifecycle/resource contract.

**Inheritance / structural**
- TuiAltScreen inherits TuiBase listener dispatch where registration order determines consumption.
- Audit note: No post-construction wrapper can reorder an already-registered listener.

**Host**
- src/tui-app.ts fullscreen setFullscreen installs routeInput then viewport listener
- unstable raw capture stage and host pre-input policy
- Audit note: The host explicitly opts into deferred registration.

**Public / extension**
- Unstable raw capture contract observes arbitrary fullscreen chunks before viewport consumption.
- Audit note: The low-level tier still depends on the screen routing seam.

**Behavioral coupling**
- router/preHost sees wheel, mouse, and semantic scroll before viewport
- default constructor path preserves upstream order
- install is idempotent
- X028 pre-input still runs inside the viewport
- Audit note: Constructor-first registration changes who consumes input without changing types.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: default/deferred listener registration and idempotent install
- test/unstable-interactive.test.ts and test/unstable-input.test.ts: host raw capture behavior
- test/input-router.test.ts and test/home-end-keys.test.ts: host routing
- Missing exhaustive raw rewrite, wheel/mouse, and semantic-scroll ordering matrix

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui-alt-screen.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream always registers the viewport listener in the constructor, making it run before later host/raw listeners; no listener phase/priority contract replaces the local option.

#### Retirement conditions

- Upstream must expose listener phase/priority ordering that guarantees protocol -> host/raw -> viewport -> component semantics.
- Run registration-order, raw-capture, wheel/mouse, and fullscreen routing tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: KEEP HARD. Registration order itself is the input-routing contract; no cleanup was attempted.

### X044 — Protected autocomplete seam

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `HIGH`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-06`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

The host TuiEditor subclass needs to drive explicit/context-gated completion, stale-dropdown cancellation, and context-specific SelectList layout through supported protected seams rather than unsafe casts to private methods or private autocomplete state.

#### Changed surface

- requestAutocomplete visibility private -> protected
- cancelAutocomplete visibility private -> protected
- getAutocompleteSelectListLayout protected layout decision hook

#### Dependency map

**Vendor internal**
- Editor completion state, request/cancel methods, provider callbacks, dropdown lifecycle, and SelectList construction are coupled.
- Audit note: Visibility and the layout decision hook are the only local code changes; behavior remains vendor-owned.

**Inheritance / structural**
- src/tui-editor.ts subclass calls requestAutocomplete/cancelAutocomplete/getAutocompleteSelectListLayout through protected access.
- Audit note: This is the explicit structural audit target.

**Host**
- src/tui-editor.ts explicit/context-gated completion and file-completion layout selection
- host active-screen repaint route for SelectedMarquee timer callbacks
- Audit note: The host no longer depends on private implementation casts or private autocomplete state.

**Public / extension**
- Host editor adapter and subclass compatibility surface.
- Audit note: Protected is intentionally not a root public method for unrelated consumers.

**Behavioral coupling**
- explicit completion uses the same request state
- stale dropdown cancellation stays synchronized with Editor input
- default slash-command layout remains unchanged
- file contexts use a single full-path layout with selected-row marquee while other autocomplete contexts keep their existing layout
- upstream signature changes fail at typecheck instead of silently at runtime
- Audit note: A public wrapper, private-state adapter, or inline host layout decision would change the supported structural contract.

#### Guarding tests

- packages/pi-tui/test/protected-autocomplete-compile.ts: compile-only host subclass contract
- packages/pi-tui/test/editor.test.ts: no-provider protected seam
- test/advanced-editor.test.ts and editor autocomplete integration
- test/autocomplete-marquee-active-screen.test.ts: file marquee context and active-screen timer routing

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The pinned baseline and audited upstream reference keep requestAutocomplete and cancelAutocomplete private. Neither upstream version exposes getAutocompleteSelectListLayout; the slash layout decision remains inline in createAutocompleteList, so the host needs an additive protected layout hook alongside the visibility divergence.

#### Retirement conditions

- Upstream must expose protected or equivalent subclass-safe completion request/cancel lifecycle and context-specific layout decision seams with compatible semantics.
- Run subclass typecheck, stale-dropdown/autocomplete, and layout-hook tests before changing visibility or retiring this record.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed the subclass edge and kept the request/cancel and layout seams; audited upstream reference has private request/cancel methods and no layout hook (inline slash layout), so it is not semantically equivalent.

### X045 — Editor expanded-cursor mapping getExpandedCursor

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `CRITICAL`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Expanded draft handoffs need the cursor in getExpandedText coordinates. Every paste marker before the raw cursor expands the offset, and a cursor inside an atomic marker snaps to the expanded content end.

#### Changed surface

- getExpandedCursor public method
- single-pass marker tokenizer shared with getExpandedText
- raw-coordinate cursor mapping and inside-marker snap

#### Dependency map

**Vendor internal**
- Editor paste registry, marker tokenizer, expanded text, and cursor state share raw marker coordinates.
- Audit note: Text and cursor must use one tokenizer to avoid expansion drift.

**Inheritance / structural**
- HostEditorAdapter/SeatEditor optional getExpandedCursor capability reads the public method.
- Audit note: No private cast path is used.

**Host**
- src/editor-seat-holder.ts wireCursorOf and editor seat handoffs
- steer/submit/viewer expanded draft paths
- Audit note: Host transfers text and cursor together across seats.

**Public / extension**
- Host editor adapter optional expanded-cursor capability.
- Audit note: The capability is public at the host adapter boundary.

**Behavioral coupling**
- markers before the cursor add only their content expansion delta
- between-marker positions do not over-count later markers
- inside-marker positions snap to expanded content end
- literal marker text inside pasted content is not rescanned
- Audit note: Type-compatible text-only expansion is not enough for cursor handoff.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: every raw cursor position, marker collision, and bounded snap
- test/editor-seat-non-owning.test.ts: expanded draft/cursor handoff

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream has getExpandedText but no cursor-pair mapping; its multi-round marker replacement would also rescan marker-like content.

#### Retirement conditions

- Provide an upstream text/cursor pair API with one-pass marker expansion and the same raw-coordinate/snap rules.
- Run marker collision, every-position mapping, and all host seat handoff tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Rechecked the round-2 robustness fixes; kept active and separate from X023 text staging.

### X046 — Cell-size replies consumed before input listeners

- Status: `ACTIVE`
- Category: `HARD_HOST_API`
- Risk: `CRITICAL`
- Files: `src/tui.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Terminal cell-size replies must update image geometry even when a modal or raw capture consumes every ordinary input chunk. Protocol replies are filtered before host listeners.

#### Changed surface

- CSI 6;H;W t cell-size response classification before listener dispatch

#### Dependency map

**Vendor internal**
- TuiBase terminal response classifiers and input listener loop share protocol precedence.
- Audit note: Cell-size, OSC 11, and color-scheme replies have an ordering contract.

**Inheritance / structural**
- TuiMainScreen and TuiAltScreen inherit TuiBase protocol handling.
- Audit note: Both regular and fullscreen surfaces need the same reply precedence.

**Host**
- src/terminal-image.ts and fullscreen image rendering consume cell dimensions
- questions, approvals, and unstable raw captures can consume ordinary chunks
- Audit note: The host modal/capture layers make listener ordering observable.

**Public / extension**
- Unstable raw input capture contract must not swallow terminal negotiation replies.
- Audit note: The low-level surface still cannot own protocol replies.

**Behavioral coupling**
- cell dimensions update despite consume-everything listener
- protocol reply never reaches ordinary host handlers
- image coordinate math stays current under modal/raw capture
- Audit note: Moving the classifier after listeners creates a silent stale-geometry failure.

#### Guarding tests

- packages/pi-tui/test/tui-cell-size-input.test.ts: reply before consume-everything listener
- test/unstable-input.test.ts and test/unstable-interactive.test.ts: host raw-capture integration
- Missing dedicated modal-plus-raw-capture cell-size regression; fullscreen image rendering is covered separately but does not assert protocol ordering

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream consumes the cell-size response after input listeners; a listener that consumes every chunk can swallow it.

#### Retirement conditions

- Upstream must guarantee all terminal-owned protocol replies precede host/raw listener consumption, or expose an equivalent protocol-priority stage.
- Run cell-size, modal, raw-capture, and fullscreen image tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: KEEP HARD. Reply ordering is terminal protocol ownership, not a host import detail.

### X047 — Anchored Kitty repeat/release classification

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/keys.ts`
- Last audited: `2026-09-03`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Generic Terminal.start input callbacks may deliver arbitrary multi-character chunks. Repeat/release filtering must recognize only complete Kitty protocol sequences so ordinary batched text containing suffixes such as :2u or :3~ is not swallowed before it reaches the focused component.

#### Changed surface

- anchored complete-sequence Kitty event classifier
- isKeyRepeat exact repeat detection
- isKeyRelease exact release detection

#### Dependency map

**Vendor internal**
- keys.ts protocol parsing and TuiBase input filtering call the exported repeat/release helpers before focused-component dispatch.
- Audit note: The helper is a package-owned protocol boundary shared by both direct consumers and inherited TUI surfaces.

**Inheritance / structural**
- TuiBase, TuiMainScreen, and TuiAltScreen use the same pre-listener filtering path.
- Audit note: A root-only replay cannot safely replace the inherited filter without duplicating or reordering input ownership.

**Host**
- src/input-router.ts and src/tui-app.ts depend on repeat/release artifacts being inert
- VirtualTerminal and generic Terminal injections can forward arbitrary data chunks
- Audit note: Production StdinBuffer splits ordinary stdin text, but the public Terminal callback contract and injected terminals do not promise one logical event per callback.

**Public / extension**
- Terminal.start(onInput) accepts arbitrary string chunks
- exported isKeyRepeat/isKeyRelease helpers are consumed at the package boundary
- Audit note: The fix protects custom terminal integrations and test/injected transports, not just the production stdin adapter.

**Behavioral coupling**
- complete Kitty repeat/release sequences remain inert
- ordinary text containing :2u, :3u, :2A, or :3~ remains editable
- bracketed paste payloads and incomplete sequences are not protocol artifacts
- Audit note: Substring matching creates data loss for valid batched input; anchoring preserves protocol filtering without a root-side replay path.

#### Guarding tests

- packages/pi-tui/test/keys.test.ts: complete Kitty forms, lookalike text, bracketed paste, and partial sequences
- test/terminal-focus.test.ts: injected batched text with Kitty-like suffixes reaches the editor and user-activity seam

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/keys.ts
- packages/tui/src/tui.ts
- packages/tui/src/terminal.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: The pinned upstream helpers use broad substring checks, while the local classifier requires a complete Kitty CSI sequence. The generic Terminal callback contract permits batching, and TuiBase independently filters after root listeners, so a consumer-side replay is not equivalent.

#### Retirement conditions

- Upstream must provide exact complete-sequence repeat/release classification or a protocol-priority input stage that covers arbitrary Terminal callback chunks and inherited TuiBase consumers.
- Run the lookalike-text, bracketed-paste, partial-sequence, and root injected-terminal regressions before removing the fork fix.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: KEEP HARD. The supported generic Terminal boundary accepts arbitrary chunks; root replay would duplicate inherited input ownership.

### X048 — Input mouse click positioning under custom prompts

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/components/input.ts`
- Last audited: `2026-09-08`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Input supports arbitrary prompts (new Input({ prompt: ... })) and renders them with visibleWidth (width - visibleWidth(this.prompt)), but handleMouse offsets the click column by a hardcoded 2 (the default "> " prompt width). Custom prompts therefore misplace the cursor: a wider prompt shifts the cursor right, an empty prompt shifts it left, and CJK prompts break because string length != visible width.

#### Changed surface

- Input.handleMouse click column is offset by visibleWidth(this.prompt) instead of a fixed 2 columns

#### Dependency map

**Vendor internal**
- Input.render lays out the value at width - visibleWidth(this.prompt); handleMouse now uses the same visibleWidth offset.
- Audit note: Single-line arithmetic fix inside Input; no other component reads the click column.

**Inheritance / structural**
- Input does not override or extend another component's mouse handling.
- Audit note: No override/super edge affected.

**Host**
- Host editor seat and search inputs use Input with default and custom prompts; click-to-position now matches the rendered prompt width.
- Audit note: Host behavior improves for custom prompts; the default prompt (width 2) is unchanged.

**Public / extension**
- Input is a public component; custom prompt + mouse click positioning is part of its public contract.
- Audit note: No extension API change; behavioral fix only.

**Behavioral coupling**
- click column = event.x - visibleWidth(prompt), clamped at 0
- default prompt "> " (width 2) keeps the previous behavior
- empty, wide, and CJK prompts position the cursor at the clicked value column
- Audit note: Regression tests cover empty, wide, CJK, and default prompts.

#### Guarding tests

- packages/pi-tui/test/input.test.ts: X048 mouse click positioning — empty prompt, wide prompt (">>> "), CJK prompt (visible width != string length), and default prompt (width 2) click-to-cursor regressions

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/input.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream v0.85.1 (and current upstream main) hardcode event.x - 2 in Input.handleMouse, so custom prompts misplace the cursor; the fork offsets by visibleWidth(this.prompt).

#### Retirement conditions

- Retire only when upstream Input.handleMouse offsets the click column by the prompt's visible width (or otherwise positions the cursor correctly for arbitrary prompts), then run the empty/wide/CJK/default prompt click-position tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed upstream v0.85.1 and current upstream main both use event.x - 2; the fork fix is a one-line arithmetic change with click-position regressions.

### X049 — Fullscreen transcript-search query Input mouse forwarding

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/alt-screen-search.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

AltScreenSearchComponent renders a mouse-aware Input and forwards keyboard/focus to it, but had no component-level mouse forwarding: a click on the query Input fell through to the overlay component, which has no handleMouse(), so the fullscreen transcript-search query cursor could not be positioned by mouse. The Host cannot fix this cleanly because the component and its private Input are inside the vendored fork.

#### Changed surface

- AltScreenSearchComponent.handleMouse forwards press events on the last-painted query-content row to its private Input, with the gesture/focus target rewritten to the component (X018 liveness tracks the mounted unit); the result-count suffix and borders stay inert

#### Dependency map

**Vendor internal**
- AltScreenSearchComponent owns the private Input; the component-level handleMouse uses the last-painted input width (cached in render) and the same previous/current query comparison as handleInput.
- Audit note: Single-component forwarding inside the fork; no other component reads the search query row.

**Inheritance / structural**
- AltScreenSearchComponent implements Component and Focusable; the new handleMouse follows the MouseRegion/Frame wrapper pattern (dispatch to the private child, rewrite target/focus to the mounted unit).
- Audit note: No override/super edge affected.

**Host**
- The built-in fullscreen transcript search relies on this vendor-owned component; TuiAltScreen.handleSearchMouseEvent still owns the navigation buttons.
- Audit note: Host behavior improves for the query Input; navigation-button handling is unchanged.

**Public / extension**
- AltScreenSearchComponent is not part of the public extension surface; the change is vendor-internal.
- Audit note: No extension API change.

**Behavioral coupling**
- press on the query-content row positions the Input cursor at the clicked value column
- the result-count suffix, top/bottom borders, and the navigation-button row stay inert
- typing after the click inserts at the clicked query position
- Audit note: Regression tests cover cursor positioning, inert chrome, and the fullscreen integration path.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: X049 — query Input press positions the cursor, typing inserts at the clicked column, result-count suffix and borders inert, and the fullscreen TuiAltScreen click-to-position integration

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/alt-screen-search.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream v0.85.1 (d981de1) and current upstream main (aa23e784c) both lack component-level mouse forwarding for the transcript-search query Input; the fork forwards press events to the private Input with last-painted geometry and wrapper target/focus ownership.

#### Retirement conditions

- Retire only when pinned upstream includes semantically equivalent query-Input mouse forwarding in AltScreenSearchComponent (or the component is restructured so the Host can forward without changing the vendor surface), then run the query-cursor, inert-chrome, and fullscreen integration tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed upstream v0.85.1 and current upstream main both lack the query-Input mouse forwarding; the fork fix is component-level forwarding with last-painted geometry and wrapper target/focus ownership.

### X050 — Editor mouse click parity: wrapped-segment cursor placement and slash-completion submit

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `MEDIUM`
- Files: `src/components/editor.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

Two upstream Editor mouse-path bugs: (1) handleMouse forces targetIndex = lastGraphemeIndex when a click lands at/after the end of a NON-last wrapped visual segment, placing the cursor one grapheme BEFORE the segment end instead of at the end; (2) the autocomplete list's onSelect (the mouse click path) applies a slash-prefix completion but does not submit, while the keyboard Enter path explicitly falls through to submit for slash prefixes — a click on a /command suggestion must behave like Enter. The fork fixes both: the natural end-of-segment position (chunk.length, matching the Input clamp-to-end behavior) and the slash submit fall-through. The slash-completion mouse click mirrors the keyboard Enter path INCLUDING the disableSubmit guard: a mouse click on a `/command` suggestion must not bypass the public 'submission disabled' contract.

#### Changed surface

- Editor.handleMouse click-to-cursor on a wrapped non-last visual segment: clicking at/after the segment text places the cursor at the segment end, not one grapheme before it
- Editor autocomplete onSelect (mouse click): a slash-prefix completion applies, cancels the autocomplete, and submits (submitValue), exactly like the keyboard Enter path
- the slash-completion mouse click cancels the autocomplete and honors disableSubmit before submitting (exactly like the keyboard Enter path)
- the autocomplete mouse dispatch is fenced to the PAINTED list instance (renderedAutocompleteList) and the press-time list instance — an async suggestion swap that has not repainted cannot receive a click aimed at the old screen (no unpainted slash submit)

#### Dependency map

**Vendor internal**
- Editor.handleMouse builds the visual line map and maps the click column to a grapheme index; the fork removed the upstream decrement that shifted the end-of-segment hit one grapheme back.
- Editor.createAutocompleteList onSelect now mirrors the keyboard Enter path for slash prefixes (apply → cancel → submitValue).
- Audit note: Two single-branch fixes inside Editor; no other component reads the wrapped-segment cursor mapping or the autocomplete onSelect.

**Inheritance / structural**
- Editor does not override another component's mouse handling; the host TuiEditor extends Editor and inherits the fixed mapping.
- Audit note: No override/super edge affected.

**Host**
- The host editor seat uses Editor; wrapped-line click-to-position now lands at the segment end.
- Audit note: Host behavior improves for wrapped lines; the last-segment clamp-to-end behavior is unchanged.

**Public / extension**
- Editor is a public component; wrapped-segment click cursor placement is part of its public contract.
- Audit note: No extension API change; behavioral fix only.

**Behavioral coupling**
- click at/after the end of a non-last wrapped segment places the cursor at the segment end
- click past the last segment still clamps to the line end
- clicking a slash-prefix autocomplete suggestion submits the completed command and clears the editor
- Audit note: Regression tests cover the wrapped non-last segment, the last-segment clamp, and the slash-completion click submit.

#### Guarding tests

- packages/pi-tui/test/editor.test.ts: X050 — clicking past the text of a wrapped non-last segment lands at the segment end, clicking past the last segment clamps to the line end, and clicking a slash-prefix autocomplete suggestion submits the completed command (like keyboard Enter)
- packages/pi-tui/test/editor.test.ts: disableSubmit=true blocks the mouse slash-completion submit and cancels the autocomplete
- packages/pi-tui/test/editor.test.ts: unpainted list replacement cannot receive a click; press A → repaint B → release must not activate B

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/editor.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream v0.85.1 (d981de1) and current upstream main (aa23e784c) both force targetIndex = lastGraphemeIndex for clicks at/after the end of a non-last wrapped segment, and both apply slash-prefix autocomplete completions on click without submitting; the fork keeps the natural end-of-segment position and submits slash completions like the keyboard path.

#### Retirement conditions

- Retire only when upstream Editor.handleMouse places the cursor at the end of a wrapped non-last segment AND upstream autocomplete onSelect submits slash-prefix completions like the keyboard Enter path, then run the wrapped-segment, last-segment, and slash-completion click tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed upstream v0.85.1 and current upstream main both keep the decrement and the non-submitting slash onSelect; the fork fixes both editor mouse paths.

### X051 — Container/Box overlay-root focus and input forwarding

- Status: `ACTIVE`
- Category: `PUBLIC_COMPONENT_CONTRACT`
- Risk: `MEDIUM`
- Files: `src/tui.ts`, `src/components/box.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

showOverlay accepts any Component as the overlay root, and the overlay focus state tracks the mounted root (dispatchMouseToOverlay rewrites the focusTarget to the root). A plain Container or Box root containing an interactive child (e.g. an Input) therefore never forwarded the focused flag or keyboard input to that child: the child received the mouse press but stayed focused=false (no IME cursor) and never received keys. The fork tracks the child the mouse press focused and forwards focus/input to THAT child only — never broadcasting to all children (a multi-Input root must not show every cursor or consume every key). The focus promotion to the container root is excluded for the TUI root itself (TuiBase extends Container), so a TUI-root mouse dispatch never steals the focus target from the clicked child.

#### Changed surface

- Container and Box implement Focusable: the focused flag forwards to the child the last mouse press focused (tracked in handleMouse), and handleInput forwards to that child only
- focus promotion to the container root applies to plain Container/Box overlay roots only, never to the TUI root (TuiBase extends Container)
- focusedChild is cleared on removeChild/clear/dispose so a detached child never keeps receiving keyboard input
- Container and Box forward the focused child's wantsKeyRelease (the TUI filters Kitty key releases by the focused component's wantsKeyRelease, so a Container/Box focus owner without forwarding drops releases aimed at the child)
- the focused child is live-child fenced: a direct `children` replacement invalidates the old forwarding target at the NEXT PAINT (render is the liveness observation point, not the next keyboard event) — keyboard input / focused / wantsKeyRelease never reach a detached child, re-mounting the old child later can never resurrect the stale identity, the detached child's focused flag is cleared (IME/hardware-cursor state does not survive a detach), and replacement never silently transfers focus to the new child (a fresh mouse press names the new focus owner)

#### Dependency map

**Vendor internal**
- Container.handleMouse and Box.handleMouse record the child whose dispatch result requested focus; the focused getter/setter and handleInput forward to that child only.
- TuiBase extends Container; the focus-promotion guard excludes TuiBase instances so the TUI root never becomes the focus target of its own children's mouse presses.
- Audit note: Two container classes share the same focusedChild pattern; the TUI-root exclusion is required because TuiBase inherits Container.

**Inheritance / structural**
- Container and Box are base container classes; subclasses (ScrollView, Stack, HStack/VStack) inherit the new Focusable surface and input forwarding.
- TuiBase extends Container; the instanceof TuiBase guard in Container.handleMouse keeps the TUI root's focus behavior unchanged.
- Audit note: The Focusable addition is additive; existing subclasses that override handleInput/handleMouse keep their behavior.

**Host**
- The Host wraps interactive overlays in FocusForwardingFrame, which already forwards focus/input; the Container/Box forwarding covers the public showOverlay(component) contract for direct roots.
- Audit note: Host behavior is unchanged (FocusForwardingFrame remains the primary path); the public contract now works for plain Container/Box roots too.

**Public / extension**
- Extensions may call showOverlay with any Component; a plain Container/Box root with an interactive child now receives focus and keyboard input.
- Audit note: No extension API change; the existing public showOverlay contract is completed.

**Behavioral coupling**
- a mouse press on an Input inside a plain Container/Box overlay root forwards focused=true and keyboard input to that Input
- in a multi-child root only the CLICKED child receives focus and keys (no fan-out)
- removing/clearing/disposing the focused child clears the forwarding reference
- the TUI root (TuiBase) never promotes its own children's focus to itself
- replacing `children` directly (the public structural mutation contract) drops the old focused child at the next paint: keyboard input / focused / wantsKeyRelease never reach it, the replacement does not implicitly inherit focus, re-mounting the old child later does not resurrect the stale identity, the detached child's focused flag is cleared, and a fresh press re-establishes the focus owner
- Audit note: Regression tests cover the single-child root, the multi-child no-fan-out case, the removal lifecycle, and the TUI-root focus identity.

#### Guarding tests

- packages/pi-tui/test/tui-alt-screen.test.ts: X051 — an Input inside a plain Container overlay root receives the focused flag and keyboard input; in a multi-child Container root only the clicked child receives focus and keys; an Input inside a plain Box overlay root receives focus and keyboard input; the TUI root keeps the clicked component as the focus target
- packages/pi-tui/test/tui-alt-screen.test.ts: a wantsKeyRelease child receives Kitty key releases through a Container overlay root and through a Box overlay root
- packages/pi-tui/test/tui-alt-screen.test.ts: direct `children` replacement in a Container and in a Box drops the old focused child (no keyboard input to the detached child, no implicit focus transfer, a fresh press re-establishes the owner); a detached focused child's wantsKeyRelease does not leak
- packages/pi-tui/test/tui-alt-screen.test.ts: A→B→A direct `children` replacement in a Container and in a Box does not resurrect the stale focus owner (keyboard input after re-mounting the old child reaches nothing; the detached child's focused flag is cleared; a fresh press re-establishes the owner)

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/tui.ts
- packages/tui/src/components/box.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream Container and Box are not Focusable and do not forward input; the fork adds focusedChild tracking so a plain overlay root reaches its interactive child, with the TUI root excluded from focus promotion.

#### Retirement conditions

- Retire only when upstream Container/Box forward focus and input to the child the mouse press focused (or the overlay focus model changes so the root no longer needs to forward), then run the single-child, multi-child no-fan-out, removal lifecycle, and TUI-root focus identity tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed upstream Container and Box lack focus/input forwarding; the fork tracks the mouse-focused child and forwards to it only, excluding the TUI root (TuiBase extends Container).

### X052 — SelectList last-painted mouse identity

- Status: `ACTIVE`
- Category: `BUGFIX_MISSING_UPSTREAM`
- Risk: `HIGH`
- Files: `src/components/select-list.ts`
- Last audited: `2026-09-09`
- Baseline compared: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`

#### Why it exists

SelectList mouse hit-testing derived the pressed row from the LIVE selectedIndex/filteredItems (getVisibleRange) and latched a raw array INDEX as the gesture identity. A filter/selection change between paint and press (or between press and release) could therefore transfer a click on item A to whatever item repainted into the same physical row — onSelect can run a command/action, so this is a real activation bug, not a highlight offset. The fork now builds a render-time physical-row → item-identity map from the FINAL painted rows, latches the pressed ITEM identity, and a click may only activate the exact identity that was pressed (every left press replaces the latch at handler entry).

#### Changed surface

- SelectList mouse hit-testing uses the FINAL painted rows (a render-time mouseRows map built in render), never a re-derived range from the live selectedIndex/filteredItems — a press/click hits the row the user actually saw
- the pressed gesture identity is the ITEM (object identity), not an array index; a click may only activate the exact pressed identity (a repaint that moved a different item onto the cell rejects the click)
- every left press replaces the pressed identity at handler entry, BEFORE the empty-filter guard (a press/click on an empty filtered-out screen still clears the old latch — the TUI keeps the old press target when the empty press returns undefined, so a later release on the same cell synthesizes a click that must not match a stale identity)

#### Dependency map

**Vendor internal**
- SelectList.render records physical row → item identity; handleMouse resolves the CURRENT index by the painted item identity (indexOf) and rejects when the painted item is no longer in the live list.
- Audit note: The scroll-indicator row is recorded as inert (undefined) so a click on it never resolves to an item.

**Inheritance / structural**
- SelectList is a leaf component; no subclass overrides handleMouse.
- Audit note: None.

**Host**
- Host SearchablePicker/openPicker wrap SelectList; the host mouse parity already resolves by VALUE/ID identity, and the fork-side fence closes the same-instance filter/selection swap.
- Audit note: Host behavior is unchanged; the fork fence covers the public SelectList contract directly.

**Public / extension**
- SelectList is a public built-in component; setFilter/setSelectedIndex + mouse click are documented capabilities.
- Audit note: No API change; the existing public surface is completed with last-painted identity semantics.

**Behavioral coupling**
- a press on a painted row resolves to the painted item even when the live visible range moved (no repaint)
- press A → filter change + repaint → release on the same cell does NOT activate the item that moved there
- a press on the scroll-indicator row is inert
- every left press replaces the pressed identity (no stale-latch activation), including a press on an empty filtered-out screen (filter empties → press → filter restores → a click without a fresh press must not activate)
- Audit note: Regression tests cover the no-repaint live-range case, the repaint transfer case (unit + real TUI click synthesis), and the existing press/click activation.

#### Guarding tests

- packages/pi-tui/test/select-list.test.ts: a press on a painted row resolves to the painted item even when the live visible range moved without a repaint (setSelectedIndex after render)
- packages/pi-tui/test/select-list.test.ts: press A → setFilter + repaint → release on the same cell does NOT activate the item that moved there
- packages/pi-tui/test/select-list.test.ts: press A → filter empties the list + repaint → press the empty screen → filter restores + repaint → a click without a fresh press must NOT activate A (the empty-state press cleared the old latch)
- packages/pi-tui/test/mouse-components.test.ts: real TUI click synthesis — press row 0, filter change + repaint, release on the same cell: the repainted row must not receive the pressed item's click (mousePressTarget → repaint → same-component synthetic click contract)
- packages/pi-tui/test/mouse-components.test.ts: existing press/click activation on painted rows (render first) and wheel-scroll press/click activation

#### Upstream comparison

- Baseline: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Semantic equivalence: `NO`
- Reference snapshot: `earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`
- Relevant upstream files:
- packages/tui/src/components/select-list.ts
- Relevant issues/PRs:
- None recorded; issue/PR state was not used as semantic proof.
- Remaining semantic delta: Upstream SelectList derives the pressed row from the live visible range and latches an array index; the fork builds a render-time physical-row → item-identity map and latches the pressed item identity, so a filter/selection change can never transfer a click to a different item.

#### Retirement conditions

- Retire only when upstream SelectList hit-tests against last-painted rows with item-identity gesture tracking (or the mouse model changes so the same-instance filter/selection swap cannot transfer a click), then run the no-repaint live-range, repaint-transfer (unit + TUI click synthesis), and inert scroll-indicator tests.

#### Replacement mapping

- None recorded.

#### Retirement evidence

- None recorded.

#### Audit record

- Scope: `vendor-internal`, `inheritance-structural`, `host`, `public-extension`, `behavioral`, `tests`
- Notes: Confirmed upstream SelectList (v0.85.1 and current main) still derives the pressed row from the live visible range and latches an array index; the fork fences mouse dispatch to the last-painted rows with item-identity gesture tracking.
