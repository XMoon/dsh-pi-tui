# TSP Foundation audit and real-pane evidence — 2026-10-13

> **Status:** VERSIONED EVIDENCE SUMMARY. Not a live implementation status document, universal protocol guarantee or substitute for original run artifacts.
>
> Architecture rules live in [Foundation contract](../foundation.md). Upstream code map in [reference](../upstream-reference.md). This record is intentionally date- and version-specific.

## 1. Evidence provenance

| System | Exact baseline | Evidence type |
|---|---|---|
| dsh-pi-tui | `next@6bb11112dc91dc6e0ade66d4b16a3e83421030f9`; scoped `src/docs/scripts` same as `df157261ad7119c1c93be33e542660c91ea7fbee` | Read-only production source-call-chain audit |
| Published TypeScript SDK | `@stencil-hq/tern@0.1.0`; same `typescript/src` bytes as `stencil-hq/tern-sdk@3c562a1de7a8501baad7338fc32aa85badf48cc4` | Installed source/dist, matching published integrity, SDK tests **read but not rerun** |
| SDK main | `13d3cca8bbd8f055431f8eb3caa434a22e966f8f` | Diff reference; **not** installed |
| Official OMP product | `can1357/oh-my-pi@818dd42b73ab1caad17fa06d4edcc3a97086dc57` | Native/wire/runtime, component and test-source audit; OMP tests **not rerun** |
| Protocol docs | Retrieved 2026-10-13, `etag="6ac553c9-1c7a"`, 26 MD checksums passed in source audit | Published docs snapshot, **not** pinned implementation |
| Tern client | `tern 0.8.3 (e2b8656)`, Linux/WSL2; `tern serve` with repository pane harness | **REAL_TERN_HEADLESS** only, not GUI/IME/physical mouse |

Raw audit inputs are the 2026-10-13 `00-baseline.md` through `07-spike-results.md` reports (Agent work directory `temp/tsp-foundation-audit/20261013-a1a2/`, gitignored). They contain path + source-line + finding IDs, worktree-drift records, errata, and measured-run locations. **They are not included in this committed evidence summary.** Independent reproduction requires checkout of the fixed SHAs and any still-retained local run directories. Exact run directory names are historical locators, **not promised permanent links**.

## 2. Static audit findings now qualified

- A1: pin SDK **44** kinds, SDK main **45**, OMP **43**; OMP lacks `el`, `block`, and stylesheet `s`, but has `media`. Main adds `media`, changes Blob `id` framing, editor placeholder and tmux probe, despite a package version still labeled `0.1.0`. SDK output/ACK/session/reconcile semantics belong to the **installed** code.
- A2: OMP's `describe`, hoist, native `rows` fallback, Frame/ACK stall recovery and test mirror are **independent runtime techniques**. They do not imply our pinned SDK lacks equivalent core responsibilities or is subject to the same hoisting rules.
- A3: OMP sampled Pickers prefer a single item per selectable entity and separate structured facts from prose; no universal type ban on long text. Corrected an early mis-citation: OMP `model-browser.ts:1883–1885` is **generic List detail**, whereas Picker Preview contains word-wrapped warning at `:2168`.
- A4: Current runtime path traces bootstrap → SDK session → projection → **one** `surface.render` → SDK queue → Tern; SDK input → application seat/presenter → original command/submission owner; owned close/dispose. Three `renderLayer` producers use `ui.col` roots. `targets` rebuilding and SDK dispatch are **not** an unconditional double old-frame guard.
- A5: synthetic SDK/OMP/headless-xterm tests cannot certify real Tern layout; tree text alone does not certify pixels. Real `tern serve + ctl` qualifies versioned client behavior but not physical GUI/IME. Real panes require negative controls and one-shot input semantics.
- A6: corrected old study: OMP `TSP_KINDS=43` (not 41); `TspPickerColumn.min` is **used**; OMP emits `rows` fallback; a historic K12 ledger had **no** `Tab/html.button` probe. The separate 0.8.3 run below finally measured that last claim.

## 3. Real headless Tern 0.8.3 results (A7 / report 07)

| ID | Result | Measured assertions / limit | Historical run locator |
|---|---|---|---|
| S1 | **Observed** `kinds=45`, features 10 (`styles`,`scroll`,`flow` included); credits 2; sample `cols=47`, cell 8×16 | `total` 9, `failed` 0, `informational` 4 | `temp/tern-pane-lINnMe` |
| S2 | **NOT_APPLICABLE**: client's advertised 45 kinds supersets the pinned 44; cannot select a pinned-but-unadvertised kind | No valid contrast constructed | S1 result |
| S3 | **UNKNOWN**: `focus('layer')` caret outcome cannot be inferred | Two attempted positive editor focus probes used wrong actual node IDs; no valid success control. Both runs kept a ledger, **each** `total` 24, **`failed` 1** (that invalid control), `informational` 8. Client **did** report `unknown id` on invented target and recognized `layer` without that error | `temp/tern-pane-EgpoNW`, `temp/tern-pane-v8BQ4y` |
| S4 | **Observed** modal backdrop blocks pointer through-click | Same-coordinate open/closed/reopen control, background action count unchanged when covered. Ledgers: `total` 24, `failed` 1 (the S3 control), `informational` 8, each | `temp/tern-pane-EgpoNW`, `temp/tern-pane-v8BQ4y` |
| S5 | **Observed only in tested tree**: clicking descendants did not emit a UI event whose ID equals region root `layer` | Ledger: `total` 24, `failed` 1 (the S3 control), `informational` 8. Does **not** prove no stale `select/activate/action` across rewritten frames, other root shapes or client releases | `temp/tern-pane-v8BQ4y` |
| S6 | **Partially observed**: frame ACKs matched sent sequence; `error(s:9)` appeared **before** `ack(s:9)` | Ledger: `total` 24, `failed` 1 (the S3 control), `informational` 8. This was an **error**, not an ordinary UI `action/select` event; displaced-frame events not constructed | `temp/tern-pane-EgpoNW` |
| S7 | **Observed** Picker `focus:'list'/'preview'` changes client classes `f-list/f-preview` and reverses | `total` 8, `failed` 0, `informational` 4. Does not prove caret/keyboard scroll | `temp/tern-pane-S3ihPs` |
| S8 | **Observed** blob with/without `id` recognized via `r:blobs.have`, random hash missing | `total` 7, `failed` 0, `informational` 2; no per-blob ACK assumed | `temp/tern-pane-LTgf6h` |
| S9 | **Observed** `media` renders success and missing-file paths differently | `total` 11, `failed` 0, `informational` 5; image viewer state and `Not found` negative control | `temp/tern-pane-ox3DXS` |
| #10 | **Observed** `Tab`+`Enter` reached program as keys, no `html.button` action | Ledger: `total` 11, `failed` 0, `informational` 5. Tested client/layout only; this probe **was not in K12** | `temp/tern-pane-ox3DXS` |

The cell names are the harness ledger's own fields (`scripts/tern-pane-drive.mjs`: `total` counts every recorded entry, `informational` those marked as `measure`), so a row records `total/failed/informational` only where the run kept an assertions ledger; rows without one (S2 has no run at all) are marked instead of counted, and no count is inferred.

Run directories were reported retained, under gitignored `temp`. The assistant drafting this summary **has not received their `wire.jsonl`, tree JSON or PNG bytes**, only the report; it does not claim independent visual inspection. The run author states those operations did not modify production code/test/docs or user daemon. Reproduce before depending on pixel-level details that are not preserved in the repository.

### Historical worktree evidence (separately scoped)

- K12 `wrap-ux/temp/overlay-root-spike/runs/k12-final`: Tern 0.8.3, `total` 31, `failed` 0, `informational` 16; A5 independently read ledger and recorded eight tree JSON/PNG snapshots. This is historical run output, **not** production source. Do not turn a documented UI example into an SDK type requirement.
- `/preset` Gate A `preset-ux/temp/tern-pane-hTfjc1`: Tern 0.8.2, `total` 113, `failed` 0, `informational` 29; raw run read later for historical record. Irrelevant to a cross-feature foundation qualification.
- Fact-wrap spike: Tern 0.8.2 reported that newlines embedded in a single item's `detail` do not create guaranteed multiple selectable-row height. This is a *product-specific client observation*, not a rule mandating particular text budgeting across TSP.
- `docs/tern-tsp/evidence/pr4-a-preset.md` does not record the exact client build; do not infer its version as a verified fact from a neighboring run.

## 4. Explicitly **not** qualified by this work

1. Correct caret/IME/edit/send focus behavior of `surface.focus('layer')`, physical GUI/OS focus and native Tab cycling for **other** element types.
2. Deterministic *late user event* after a prior frame was replaced; event types `select/activate/action` do not provide a frame revision. SDK handler routing and application currentness still require separate correctness proofs.
3. Client view-state preservation or scroll reset from revision-bearing node keys (`del/add` is source-proven, user-visible result unmeasured).
4. Operation-specific Reader `scroll`/`reveal` acceptance, behavior at arbitrary scroller nesting, and physical mouse wheel.
5. Missing-kind fallback on a truly nonadvertising client, exact fonts/themes/enlargement, Remote/full product profile, every future Tern version, and untested other kinds.

No listed UNKNOWN blocks writing **these documents**. A future feature is gated only if it materially relies on the relevant unknown; evidence tier and Owner waiver must be explicit. Never write `PASS` for `NOT_APPLICABLE`, `NOT_VERIFIED` or `OWNER_ACCEPTED_LIMITATION`.

## 5. Validation and source map

- `00-baseline.md`: versions, installed SDK source/dist mapping and worktree drift.
- `01-protocol-sdk.md`: protocol verbs/kinds/props/features, real installed API, event-field table, SDK test index and errata.
- `02-omp-native-runtime.md`: OMP startup→event→exit chains, separate Reconciler and fallback rules.
- `03-omp-component-practices.md`: product components and corrected Preview/List Detail source split.
- `04-dsh-production-crosswalk.md`: 19-stage application/SDK chain, single ownership, presentational state inventory and event routes.
- `05-evidence-and-gaps.md`: instrumentation limitations and preregistered spike questions, revised by its E5/E6 errata.
- `06-contradiction-ledger.md`: historic Q/K/MUST verdicts; **read R3 and R4 errata before quoting original summary**.
- `07-spike-results.md`: client measurements and remaining unknowns.

For repository-native verification use `test/tern-tsp-*.test.ts`, `test/support/tsp-terminal-fixture.ts`, `scripts/tern-pane-*.mjs`, and [`docs/tern-pane-harness.md`](../../tern-pane-harness.md); choose the smallest relevant test/probe rather than claiming a full qualification from a source-read or green unrelated CI.
