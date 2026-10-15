# Session Browser Spike + GUI Demo Evidence (2026-10-15)

> **Demo/spike only.** This is not a production Session Browser, does not expose a TSP `/sessions` command, and does not complete PR4-B1. The design remains `CANDIDATE`; visual acceptance is `PENDING_OWNER`.

## Outcome

- **`SPIKE_PROVED`: PASS**, limited to the pinned SDK and the observed Tern client build below. Native tree, scopes, global content search, Cards/Tree projection, footer actions, read-only Details, and the synthetic-only event boundary were exercised in the real headless Tern client.
- **`DEMO_HANDOFF_READY`: PASS.** The standalone demo entry completed the real headless Tern handshake and the Owner has a direct launch command and short review route below.
- **`OWNER_REVIEW_PENDING`: YES.** No design approval is inferred from headless evidence.
- **`PHYSICAL_GUI_NOT_VERIFIED`.** No desktop Tern window, physical mouse/keyboard, IME, wheel, or window-level behavior was exercised by the agent. The headless PNGs are not GUI acceptance.
- **`PR4-B1 IMPLEMENTED`: NO.** No production wiring or product-status change was made.

## Scope and runtime

- Branch/worktree: `spike/tsp-session-browser-demo` at `/home/xmoon/project/dsh-pi-tui-wt/session-browser-spike`, created from the then-current `origin/next`.
- Demo SDK: `@stencil-hq/tern@0.1.0` (already pinned; dependency files unchanged).
- Observed Tern CLI/client: `tern 0.8.3 (e2b8656)` on `linux/x64`. Headless window sizes: 1280×800, 700×600, 400×600, 400×440 (client coordinates). Client default font was not overridden; the resolved physical font and desktop window are `NOT_VERIFIED`.
- Product composition: one native Tern Picker (`tree` for browse, `cards` for global search), native scope control and `[Close] [Details] [Resume]` footer; Details replaces the Picker with one read-only overlay.
- Data and actions are synthetic. The source imports no `SessionReader`, Host, session writer, or production session-transition path. Resume only appends a local `wouldResume` event and paints `Would resume`; the fixed Current identity is unchanged. Subagent fixtures are excluded from the browser projection.
- No `src/**`, `packages/**`, dependency, toolchain, `docs/tern-tsp.md`, or production capability/status changes. No commit, push, or merge was performed.
- The supplied plan refers to **TSP Planning Protocol v3**, but that protocol file was not available in the checked-out workspace. Compliance with that unavailable external planning document is therefore `NOT_VERIFIED`; this work used the available repository `AGENTS.md`, `docs/code-review.md`, `docs/tern-tsp/foundation.md`, and `docs/tui-design-language.md` contracts.

## Reproduction and validation

The final real-client run and retained raw evidence are in [`temp/tern-pane-kK6Q8D/`](../../../temp/tern-pane-kK6Q8D/):

- [assertions.json](../../../temp/tern-pane-kK6Q8D/assertions.json) — `PASS`, no failed assertions; records the exact Tern version.
- [events.jsonl](../../../temp/tern-pane-kK6Q8D/events.jsonl) — interaction and local `wouldResume` records.
- [run.log](../../../temp/tern-pane-kK6Q8D/run.log) — Tern/headless run log.
- PNGs and node/layout snapshots: [`shots/serve/`](../../../temp/tern-pane-kK6Q8D/shots/serve/).

Commands run on the final code snapshot:

```sh
pnpm exec tsc --noEmit --target ESNext --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck scripts/tern-session-browser-demo.mts
node --check scripts/tern-pane-session-browser-spike.mjs
git diff --check
node scripts/tern-pane-drive.mjs scripts/tern-pane-session-browser-spike.mjs
```

All listed checks passed. The final code snapshot includes the review fixes; earlier failing captures are diagnostic only, not inherited passes. The report-only update after this run did not change the demo or flow inputs. Staged/unstaged whitespace and each untracked deliverable were checked separately; `git diff` alone does not cover untracked files. No production or fork suite was needed for this standalone synthetic entry. The Tern headless flow exercised actual client input, layout, events, and PNG capture; it does not establish physical GUI behavior.

Review regressions now cover: browse/metadata-only Details omit stored content, a real content hit retains its bounded snippet, a newer child stays below its parent, unavailable content with zero metadata hits displays a native error explanation, two split-width footer clicks, and narrow keyboard scope switching. The client overrides `empty` text for nonempty queries; the unavailable/no-metadata case therefore uses the native error state with an explicit message instead of pretending it is an ordinary no-match. Long-excerpt scrolling starts from an actual matching search, not ordinary browse Details.

## Spike A–F verdicts

| Spike | Verdict | Evidence / limits |
|---|---|---|
| A — Native tree, depth, lineage, grouping | **PASS** | Wide and narrow browse captures; visible depth-0/1/2 fork chain, orphan/cycle roots, Current distinct from selection, and scrollable synthetic roster. See `01-wide-1280x800-browse.png`, `05-all-workspaces-middle.png`, `06-all-workspaces-last-row.png`. |
| B — Native scopes and global search | **PASS for scope switching; keyboard popup opening NOT_VERIFIED** | Wide/narrow pointer scope input, narrow Tab → Enter scope cycling and return, and cross-workspace search are proved. See `04-wide-all-workspaces.png`, `11-narrow-scope-all-menu.png`, `12-narrow-scope-restored.png`, `16-global-content-only-other-workspace.png`, `35-narrow-scope-keyboard-before.png`, `36-narrow-scope-keyboard-all.png`, `37-narrow-scope-keyboard-workspace.png`. The demo keyboard handler cycles the scope directly and returns focus to the list; it does not prove opening the client's popup with a key. |
| C — Content search / Tree↔Cards | **PASS** | Exact `connection timeout` query returns a title-independent content-only result alongside Metadata and Both groups; clearing restores the same workspace selection and Picker identity. See `13-global-search-400x600.png`, `15-global-search-connection-timeout-700x600.png`. |
| D — Native footer and Resume safety | **PASS with Owner visual question** | Pointer and keyboard actions; list Enter and footer Resume each create one local event; Current, no-match, stale/wrong-ID, and Details-page Resume controls do not create one. At 400×600 with the Footer action zone focused, the disabled Current Resume label is blank in `20-current-resume-disabled.png`; it is readable with list focus in `37-narrow-scope-keyboard-workspace.png` (see V13/G8). |
| E — Read-only Details and scrolling | **PASS** | Pointer Back, Esc, short-window and long CJK/ID/snippet tail reachability; scrolling is issued only when the client capability is negotiated. See `21-details-1280x800.png`, `23-details-tail-400x440.png`, `32-long-details-400x440-start.png`, `33-long-details-400x440-tail.png`. |
| F — Standalone demo handoff | **PASS for headless entry; physical GUI NOT_VERIFIED** | The same `.mts` entry used for Owner launch connected in the real headless Tern pane. Physical startup/window interaction remains for Owner. |

## V01–V19 verification matrix

| ID | Status | Evidence / result |
|---|---|---|
| V01 — 1280×800 browse | **PASS** | `01-wide-1280x800-browse.png`; Current, selection, scope, and enabled Resume are visible. Scope change: `04-wide-all-workspaces.png`. |
| V02 — 700×600 browse | **PASS** | `08-split-700x600-browse.png`; two real footer clicks (Details, then Resume after pointer Back) are recorded, with exactly one local Resume event for the selected ID. Details: `09-split-700x600-details.png`; hit targets/events: `assertions.json` / `events.jsonl`. |
| V03 — 400×600 browse | **PASS** | `10-narrow-400x600-browse.png`, `11-narrow-scope-all-menu.png`, `12-narrow-scope-restored.png`, `19-narrow-400x600-end.png`; scope menu, End/list scroll, and footer hit targets exercised. |
| V04 — 400×440 + long CJK/ID | **PASS** | `22-details-short-400x440-before-end.png`, `23-details-tail-400x440.png`, `31-long-id-search-400x440.png`, `32-long-details-400x440-start.png`, `33-long-details-400x440-tail.png`; long fields and excerpt tail are painted and reachable, then Esc returns. |
| V05 — Tree depth/group | **PASS** | `01-wide-1280x800-browse.png`; node identities, measured indentation, and parent-before-newer-child order are asserted. The rewind fixture is newer than its fork parent, but remains immediately below it. |
| V06 — This workspace ↔ All workspaces | **PASS for membership change** | Pointer input at wide/narrow widths and narrow Tab/Enter cycling preserve Current and selection. See V01/V03 and `35`–`37` keyboard captures. Keyboard opening of the native popup is `NOT_VERIFIED`, not inferred from direct scope cycling. |
| V07 — Metadata search | **PASS** | `13-global-search-400x600.png`; metadata-only control is classified separately from content-only. |
| V08 — Content-only search | **PASS** | `15-global-search-connection-timeout-700x600.png`; “Notes from the nightly run” matches the Host-mock excerpt although its title does not contain the query. |
| V09 — Global search from workspace scope | **PASS** | `16-global-content-only-other-workspace.png`; `worker log` returns the single content-only match in `docs/research`. |
| V10 — Tree→Cards→Tree | **PASS** | Search/clear input, scope, selection, and Picker identity are asserted in `assertions.json`; see V07–V09 images. |
| V11 — Mouse select → Enter | **PASS** | `18-would-resume-local.png` and `events.jsonl`; one `wouldResume` for the clicked synthetic row, no stale footer activation. |
| V12 — Footer Resume | **PASS** | Visible enabled footer in `18-would-resume-local.png`; real hit target and exactly-one footer-origin event are in `assertions.json` / `events.jsonl`. |
| V13 — Current Resume disabled | **OWNER_DECISION_NEEDED** | Current cannot be resumed. At 400×600 with the Footer action zone focused, `20-current-resume-disabled.png` paints a blank gray primary button; with list focus, the disabled `Resume` label is readable in `37-narrow-scope-keyboard-workspace.png` and the 400×440 `34-short-400x440-browse.png`. The node has `title="Already current"`; physical hover/tooltip behavior is not verified. No workaround or extra page was introduced. |
| V14 — Details → Back | **PASS** | Real pointer Back and Esc restore the same browser selection; see `09-split-700x600-details.png` and `21-details-1280x800.png`. |
| V15 — Details long text | **PASS** | `23-details-tail-400x440.png` and `33-long-details-400x440-tail.png`; tail visibility is checked through clipping ancestors, not only node text. |
| V16 — Loading/error/empty/no-match | **PASS** | `17-search-no-match.png`, `24-scenario-loading.png`, `25-scenario-error.png`, `26-scenario-empty.png`, `27-scenario-content-search-unavailable.png`, `28-content-unavailable-no-metadata-match.png`; unavailable content is explicit even when no metadata matches, and disabled actions do not record Resume. |
| V17 — Stale/wrong ID | **PASS in the demo guard; transport revision UNKNOWN** | Negative controls and zero additional `wouldResume` are recorded in `assertions.json` / `events.jsonl`. The observed Picker wire event does not provide a normative frame revision (`frameRevisionAvailable:false`); this does not prove a general client-side stale-delivery guarantee. |
| V18 — Resize and focus | **PASS** | The flow preserves query, selection, scope and Picker identity across wide/split/narrow/short viewports; pointer selection then keyboard Enter is checked. See `08`–`16` and `22`–`23` captures. |
| V19 — Physical GUI launched | **NOT_VERIFIED** | No physical window screenshot/recording. Owner launch instructions follow; physical evidence is awaiting Owner. |

## G8 visual review

The following ratings apply only to the captured headless Tern 0.8.3 views. `OWNER_DECISION_NEEDED` is not an Owner sign-off.

| View | Hierarchy | Density | Alignment | Contrast | Consistency | Action clarity | Overflow |
|---|---|---|---|---|---|---|---|
| 1280×800 browse | PASS | PASS | PASS | PASS | PASS | PASS for enabled Resume | PASS |
| 700×600 search/browse | PASS | PASS | PASS | PASS | PASS | PASS in captured frames; disabled-Footer-focus behavior NOT_VERIFIED at this width | PASS |
| 400×600 browse | PASS | PASS | PASS | PASS | PASS | OWNER_DECISION_NEEDED: disabled Current Resume label is blank with Footer action focus (`20`), readable with list focus (`37`); enabled Resume is visible and hit-testable | PASS |
| 400×440 browse/Details | PASS | PASS | PASS | PASS | PASS | PASS in captured list-focus/Details frames (`34`); disabled-Footer-focus behavior NOT_VERIFIED at this height | PASS; long Details tail reached |

The Picker stays compact in browse and search cards; the narrow scope control opens an explicit two-choice menu. Search cards show the workspace and useful excerpt. In the observed 400×600 Current-selected frame with the Footer action zone focused (`20-current-resume-disabled.png`), the disabled primary-button label is blank despite node text and an `Already current` title. It is readable when list focus returns (`37-narrow-scope-keyboard-workspace.png`), including the captured 400×440 list-focus frame (`34-short-400x440-browse.png`). This is a focus-state-specific observation, not a claim about every Current-selected frame or untested viewport/focus combination. Physical hover/tooltip behavior remains unverified. The observed focused state is left for Owner judgment rather than disguised with a second surface or a custom button.

Keyboard scope switching is usable via **Tab → Enter** (direct toggle, focus returns to the list); repeat Tab → Enter to switch back. Opening the native narrow popup itself with a key remains `NOT_VERIFIED` under Spike B and must not be inferred from the switching evidence. The Owner should judge this interaction difference before any production plan.

PiTui-painted VirtualTerminal frames are `NOT_APPLICABLE` to this TSP-native widget; the real versioned headless pane and PNGs are the applicable client evidence. Dark/light/custom themes, alternate fonts, physical hover/tooltips, IME, wheel input, and physical window chrome are `NOT_VERIFIED`.

## Owner GUI launch and 3-minute review

**Run from the worktree root inside a Tern-owned terminal pane** (not an ordinary shell):

```sh
node --import tsx/esm scripts/tern-session-browser-demo.mts
```

This exact entry was launched by the headless harness; the agent did **not** run it in a physical GUI. Press **F10** to close the demo. To restart, run the same command again in the Tern terminal pane.

Suggested review route:

1. Confirm `DEMO ONLY`, `Current` (`Fix API timeout`), the selected row, and the enabled Resume button.
2. Click **Persist session**, then press **Enter**. Confirm the `Would resume` badge appears and Current remains unchanged.
3. Open the narrow scope menu at 400×600; select **All workspaces**, then return to **This workspace**.
4. Search `connection timeout`; confirm the content-only **Notes from the nightly run** result in `docs/research`. Press **Esc** to clear and verify the prior browse selection returns.
5. Search `session-long-`, open **Details**, press **End** to inspect the long CJK/ID/excerpt tail, then **Esc** to return.
6. At 400×600, inspect the three footer actions and list scroll; shorten to 400×440 and check that Details can scroll while the native footer/back path remains available. If Current is selected, hover the disabled Resume action and report whether its `Already current` explanation is visible.

Demo-only controls, not production shortcuts: **F1** cycles `normal → loading → error → empty → search-unavailable → has-more → normal`; **F5** toggles synthetic metadata readiness. **F2–F4** are negative-control probes and are not part of normal use.

Owner GUI screenshots/recording: **awaiting Owner**. Please return `ACCEPTED` or `CHANGES_REQUESTED` with the specific screenshot/interaction. Do not begin production `/sessions` wiring before Owner acceptance and a separate implementation plan.
