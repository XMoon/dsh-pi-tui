# TSP Foundation runtime gap closure — 2026-10-13

> **Status:** VERSIONED RUNTIME EVIDENCE AND DECISION RECORD, not a live implementation contract or a declaration that all findings have been fixed.
>
> **Current product baseline for this closure:** `XMoon/dsh-pi-tui next@8d329ebf310fb6d1db4b86a939eadb20474231df` (PR #299 merged); installed `@stencil-hq/tern@0.1.0` (TypeScript SDK source `stencil-hq/tern-sdk@3c562a1de7a8501baad7338fc32aa85badf48cc4`; Node loads its compiled `dist`); Tern client `0.8.3 (e2b8656)` **REAL_TERN_HEADLESS**. Checked SDK `main@13d3cca8bbd8f055431f8eb3caa434a22e966f8f` has no `Surface.#queue/#flush` fix. Source lines and client claims apply to these versions only.
>
> **Companions:** [live Foundation contract](../foundation.md) · [TSP integration and status](../../tern-tsp.md) · [original Foundation evidence](./foundation-20261013.md) · [Tern SDK issue #48](https://github.com/stencil-hq/tern-sdk/issues/48) · [diagnostic PR #299](https://github.com/XMoon/dsh-pi-tui/pull/299).

## 1. What this record closes — and what it does not

The Foundation audit (CP0–CP4) inspected runtime event currentness (F1), focus and input routing (F2), and Surface/frame lifecycle (F3). It produced **14 Finding IDs**, not counting independent scenarios L1–L6 or unknowns U1–U9. Two defects were confirmed in the initial audit; the others were bounded risks, unknowns, or negative findings. The subsequent PR #299 changed the **current resolution state** of F3-002, not its original audit classification.

| Initial audit class | Count | Findings | Current disposition |
|---|---:|---|---|
| `CONFIRMED_DEFECT` | 2 | **F3-001** (P2), **F3-002** (P3) | F3-001 **OPEN / UPSTREAM_REPORTED**; F3-002 **FIXED** in #299 |
| `RISK_UNPROVEN` / `UNKNOWN` | 6 | F1-002, F1-003, F1-007, F2-001, F3-003 (`RISK_UNPROVEN`); F2-004 (`UNKNOWN`) | Remain open as evidence limitations, not established user-visible defects |
| `NO_GAP_CONFIRMED_IN_TESTED_SCOPE` | 6 | F1-001, F1-004, F1-005, F1-006, F2-002, F2-003 | No gap **only in each finding's tested equivalence class** |
| **Total** | **14** | | No new finding numbers invented here |

**Do not conflate:** (a) an observed protocol error, (b) an observed diagnostic gap, and (c) user-visible impact. Neither confirmed defect established a user-visible failure. `U8` (missing ACK may indefinitely block ordinary frame progress) is an independent UNKNOWN, **not** a fifteenth finding. Earlier S3 labels in `foundation-20261013.md` refer to that prior study's focus/caret probe; the later CP3 credit-stall probe uses its **own** S3 identifier. Do not combine their assertion counts.

## 2. F3-001 — confirmed stale Focus Op after credit-blocked coalescing

**State:** `CONFIRMED_DEFECT / P2 / OPEN / UPSTREAM_REPORTED` · [stencil-hq/tern-sdk#48](https://github.com/stencil-hq/tern-sdk/issues/48), opened 2026-10-13. **No fix is installed or released.**

**Source → decision → sink:**

```text
TSP seat/presenter changes desired focus
  → dsh-pi-tui/src/tui/tsp/session.ts applyFocus() → surface.focus(id)
  → pinned SDK Surface.send() appends ['focus', id] to #queue
  → SDK render() replaces #pending with newest View while credit is blocked
  → ACK → #flush(): [diff(#sent → #pending)] + [#queue, unchanged]
  → Tern applies frame ops in order, rejecting unknown focus target
  → error{sf, s, op, msg} → SDK event iterator
  → app diagnostics (after PR #299)
```

The SDK is the **frame / credit / queued-Op owner**. The app remains the **desired focus/seat owner**; the Tern client owns **actual node existence and caret**. A client-side rejection is not an ACK failure, and an SDK frame ACK is not a business-currentness token.

**Controlled scripted credit-stall positive/negative evidence (SDK pin):** two frames occupy two available credits. During the blocked interval no frame is emitted (`frames 2 → 2`); a modal opens then is withdrawn, and release sends a coalesced frame with the historical focus sequence `['layer.modal-1.answer', null, 'dock.composer']` even though the modal input never reached the client. Historical CP3 S3 targeted lane: **2 tests passed; ledger 2 checks + 3 measurements**. This describes the original baseline defect probe, not the later candidate test's expected-failure assertion.

**Real client evidence (headless Tern 0.8.3):** `s=5` frame Op kinds were `[del, del, add, add, add, focus, focus]`. The two focus ops were `layer.modal-1.answer` and `dock.composer`. The client returned exactly:

```json
{"ev":"error","sf":"s1","s":5,"op":5,"msg":"unknown id layer.modal-1.answer"}
```

Baseline R5 real-pane run: **11 assertions / 0 failed / 7 informational**. The following valid focus was applied and a test key `q` reached the composer. Thus **the protocol rejection is confirmed, but a user-visible focus/input defect was NOT observed**. The original Foundation S3 invalid caret-positive-control result does not alter this conclusion.

**Owner disposition:** report upstream and wait; no local frame reconciler, focus queue, ACK watchdog, retry, or application-side deferred-focus workaround. The event-driven `applyFocus(true)` path does **not** guarantee another `render()`, so deferring until the next render is not an equivalent local repair. `Surface.#pending/#queue` reconciliation belongs to the SDK, not a second shadow implementation in `dsh-pi-tui`.

### F3-004 — the same credit/queue boundary on a queued `Surface.scroll()` (Reader body)

**The same SDK boundary as F3-001; the app-side consequence retired with the node-identity
fix.** The Reader page is the one place the app drives a native scroll container, and it
addresses the body node of the frame it built. While a Reader body id was FRAME-SCOPED, a
`Surface.scroll()` queued under a blocked frame credit could be delivered after a later
View replaced the pending one, so it named a body the client had never received (the
earlier revision of this entry records that sequence id by id). That was a SECOND symptom
of the per-frame node key: a key that changes every frame also makes the SDK diff
`del + add`, so the client REMOUNTED the Reader — losing its scroll position — and the
app's own scroll target was retired by the remount.

The fix is the same one the picker needed: `model-picker-view.ts` now keys the layer, the
picker and the Reader by the panel SERIAL only (`model-<serial>`, `model-details-reader-<serial>`,
`model-details-body-<serial>`), so every long-lived node keeps ONE identity for the panel's
life. The targeted test
`test/tern-tsp-model-picker.test.ts` → *"a scroll queued behind a stalled frame credit stays
a REAL Reader body"* still drives the exact stall (held acks, more repaints than the pane's
two credits, a real `End` while stalled, one more repaint that replaces the pending View,
then the release) and now asserts the STRONGER fact: the scroll op the client finally
receives names the body the client already has (measured: every queued scroll id is in the
delivered set, and the delivered set contains that body).

**Status.** The SDK's `#queue`/`#flush` behaviour itself is unmodified and stays upstream
with F3-001 — the app simply no longer trips it. No second scroll queue, shadow sent View,
ACK watchdog or automatic retry was added, and none is needed for this symptom.

## 3. F3-002 — diagnostic gap fixed independently

**Original state:** `CONFIRMED_DEFECT / P3`: Tern's `error{sf,s,op,msg}` reached the SDK event iterator, but the application's modal/picker event paths did not consume it and the error was silently dropped.

**Current state:** `FIXED` by merged [PR #299](https://github.com/XMoon/dsh-pi-tui/pull/299) (merged into `next@8d329ebf`). In `src/tui/tsp/session.ts`, `routeInput` handles protocol `error` before the modal and picker routes and invokes existing `options.logError` with the recognized `sf`, `s`, `op`, `msg` fields, subject to the surface-scope guard. It does **not** treat an error as a fatal signal, send a new focus, retry an operation, show a business notice, or change the business writer.

**Separate real client witness from the F3-001 evaluation:** with the unmodified pinned SDK, `s=5/op=5` elicited the client error and the PR #299 diagnostic; isolated SDK focus-filter candidates eliminated **that specific** error and therefore emitted no corresponding diagnostic. This confirms diagnostics are responsive to protocol events; it **does not** mean PR #299 fixes the queue bug.

## 4. F3-003 and the remaining bounded findings

**F3-003 — `RISK_UNPROVEN`:** the application's normal `surface.close({keep:false})` can fail before unregistering the Surface. SDK Session shutdown can then attempt a second close with default `keep:true`; these are **not equivalent intents**. Source and targeted failure path show the divergent `x` messages, but **no real Tern residual UI/output consequence is established**. No cleanup/retention patch was authorized; revisit only with a material client reproducer or changed SDK behavior.

| Finding | Bounded state / what not to infer |
|---|---|
| F1-002 | A synthetic `id:'layer'` event can reach an app-side action writer; real Tern 0.8.3 did **not** emit this id in the tested gestures. No universal real-client reachability proof. |
| F1-003 | The current `targets` admission is payload/currentness-driven and can accept a live non-control id in synthetic scenarios. No proof all possible real-client event addressing is safe. |
| F1-007 | A delayed event addressed to an old, retired node id can be silently ignored after a later View; actual frequency and user impact not established. |
| F2-001 | Tern recognized `surface.focus('layer')` and moved the **a11y focus proxy** to its region; physical caret and text editing outcome still require GUI evidence. |
| F2-004 | `focus(null)` was accepted, with a11y proxy geometry remaining; true internal caret-owner clearing remains **UNKNOWN**. |
| U8 (non-finding) | If frame ACK never arrives, blocked ordinary frames can remain blocked. This is not evidence of a practical deadlock or a reason to add an ACK watchdog. |

The six `NO_GAP_CONFIRMED_IN_TESTED_SCOPE` findings remain explicitly limited to their audited event shapes and lifecycle equivalence classes. In particular, none asserts universal prevention of late UI events or all future focus transformations.

## 5. SDK fix-feasibility experiments (informational, **not production changes**)

A separate CP0–CP4 feasibility pass used the **same published SDK pin** as the baseline, confirmed TypeScript `dist`/source provenance, compared three isolated `#flush` strategies, and performed a real-client 0.8.3 headless comparison. The original A1 (filter focus ids absent from the post-diff View) removed the **observed** `unknown id`; in that real-client run the baseline and candidates all produced six frames/four ACKs, reached the composer, and painted an identical PNG. This proves **only the tested consumer/frame shape**, not correctness for all SDK users. It was never installed in this repository or published upstream.

After an Owner review flagged raw `surface.send(add/del/focus)` compatibility and no-Focus-frame performance, an **Agent-reported** E7/E8 addendum evaluated a revised experimental A1′ with a conservative `#rawStructure` flag and lazy Focus checking:

| Reported result | Evidence tier / limit |
|---|---|
| Original A1 can incorrectly remove a legal focus on a node created by queued raw `add`, or preserve a focus after queued raw `del`. | **Agent-reported `TARGETED_SDK_TEST`**; 11 scenarios × 4 variants in the addendum summary. This is a public-API limitation of original A1, not an observed `dsh-pi-tui` production regression. |
| A1′ retains legal focus in the tested raw/structural sequences, drops provably invalid ids, and retains `focus(null)` and unrelated native Op order. | **Agent-reported `TARGETED_SDK_TEST`**; raw SDK/Node tests, **not** real-client verification of raw `add/del` sequences. |
| A1′ skips a full View walk for no-Focus frames. Agent compared a 24,004-node tree and reported no added tree traversal in the no-Focus fast path. | **Agent-reported performance measurement**; the allocation probe was `INVALID_INSTRUMENT` and must not be quoted as proof of memory overhead. |
| Cross-frame raw `del` and client/SDK tree divergence can remain unresolved without a second topology authority. | **Explicit scope boundary**, not `NO_GAP`. |

**Provenance limitation:** the E7/E8 addendum's four original reports, patch, ledgers, and raw timing data were **not supplied with this documentation package**; the four observations above are transcribed from the Owner-provided Agent Checkpoint 2 summary and are **not independently re-executed or patch-reviewed here**. Do not elevate them to a released SDK contract or `REAL_TERN_HEADLESS` proof. The earlier CP0–CP4 reports and compliance review **were supplied** and support the original F3 audit and A1 feasibility claims.

**Disposition changed from implementation planning to reporting:** the project deliberately chose [`stencil-hq/tern-sdk#48`](https://github.com/stencil-hq/tern-sdk/issues/48), not an SDK fix PR. No E9/additional implementation gate is required for the act of reporting this confirmed bug; any eventual upstream solution and cross-language release coordination belong to its maintainers. The TypeScript/Rust/Python/Go source review found analogous raw queue append shapes (**`SOURCE_ONLY`**; other language runtime behaviors not exercised), but the project does **not** own a four-language patch.

## 6. Version, authority and reproduction boundaries

| Surface | Verified / not verified |
|---|---|
| Product | `next@8d329ebf`: diagnostics present and merged; TSP still opt-in; no F3-001 fix or local workaround. |
| Published SDK | TypeScript `@stencil-hq/tern@0.1.0`; installed Node uses `dist`. Upstream `main@13d3cca8` compared only as a source reference, not a consumable upgrade. |
| Terminal | Tern `0.8.3 (e2b8656)`, **headless**. No physical GUI/IME/caret qualification claimed. |
| Initial audit | 14 Finding IDs; historical CP0–CP4 baseline `next@b83f261d`; current PR #299 status is a subsequent update. |
| F3-001 follow-up | Separate feasibility run at `next@8d329ebf`; CP2 pin + scripted SDK, CP3 real headless baseline vs isolated SDK copies. Raw runs remain in gitignored `temp/`, not versioned in this document. |
| Later E7/E8 | Checkpoint 2 Agent report only in this document; its raw reports/patch were not part of this doc-generation input. |

Historical reproducibility hints (paths are **local historical locators, not repository links**):

- Foundation CP3: `temp/tsp-runtime-gap-20261013-cp01/runs/f3-credit-focus-probe.test.ts`, `runs/f3-credit-ledger.jsonl`, `temp/tern-pane-F3-cp01/wire.jsonl`, `assertions.json`.
- SDK feasibility: `temp/tsp-f3-001-eval-20261013-cp0/runs/sdk-matrix.test.ts`, `renderer-matrix.test.ts`, `original-s3-probe.test.ts`, `matrix-summary.json`, and `temp/tern-pane-f3-001-eval-{baseline,a1,a2,a3}/wire.jsonl` / `assertions.json`.
- Full case attribution and limitations: local audit reports `01-event-currentness.md`, `02-focus-input.md`, `03-surface-lifecycle.md`, `04-gap-ledger.md`, `05-reproduction-index.md`; feasibility reports `00-baseline.md` through `06-plan-compliance.md`. These are **not** committed into `docs/` and must not be represented as durable links.

## 7. Maintenance decisions and re-open triggers

1. **Current actions:** F3-001 stays `OPEN / P2 / UPSTREAM_REPORTED` ([SDK #48](https://github.com/stencil-hq/tern-sdk/issues/48)); F3-004's SDK boundary (the queued `Surface.scroll()`, the same `#queue`/`#flush` filter as F3-001) stays upstream with F3-001, but its APP-SIDE symptom is RETIRED by the node-identity fix — the Reader keeps one id per panel, so a queued scroll can no longer name a body the client never received; F3-002 stays `FIXED` ([project #299](https://github.com/XMoon/dsh-pi-tui/pull/299)); F3-003 stays `RISK_UNPROVEN`.
2. **No new local infrastructure:** no second Frame/Focus queue, shadow sent View, ACK watchdog, automatic operation retry, or SDK fork/patch merely to silence this error.
3. **Revisit F3-001** when upstream SDK changes relevant `Surface` semantics / publishes a candidate fix; when a Tern client changes per-Op rejection to frame-level failure; or when a real input/focus failure is correlated with the protocol diagnostic. Rapid modal/focus transitions becoming a routine feature also warrants requalification.
4. **Revisit F3-003** if a real broken-tty/retention consequence is observed, or upstream close semantics materially change. Do not equate a source-level divergent default with a confirmed visible residue.
5. **Documentation discipline:** amend [`../foundation.md`](../foundation.md) only for cross-feature invariant changes; update [`../../tern-tsp.md`](../../tern-tsp.md) for product/issue status; append further dated evidence rather than rewriting [`foundation-20261013.md`](./foundation-20261013.md). No GitHub Issue, experimental SDK PoC, or diagnostic PR changes the PiTui default or declares full TSP readiness.
