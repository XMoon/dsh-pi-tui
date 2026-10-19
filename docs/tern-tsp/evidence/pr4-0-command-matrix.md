# PR4-0 evidence — command / origin / reachability ledger

Part of the [PR4-0 capability audit](./pr4-0.md). This is the **complete
enumerated** ledger of the commands the current `next` tree registers, what
owns each one, and what the TSP renderer actually does with it.

Source references are `path:line` against the **single** qualification baseline
recorded in [pr4-0.md § Baseline](./pr4-0.md#baseline--qualification-topology)
(`6a6c0b915527ced2a21d33ba3772c156247efe2f`). The load-bearing claims also carry
an immutable permalink
(`https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/<path>#Lx-Ly`).

## How this list was produced (not a grep of file names)

`registerTuiCommands` (`src/commands.ts:814`) is the single registration seam.
Every built-in goes through `registerOne` (`src/commands.ts:929`) or
`registerTuiCommand` (`src/commands.ts:1483`), and the coordinator calls each
domain registrar at a **frozen position** (`src/commands.ts:1501-1506`,
`1507-2084`). The names below were read from each registrar's actual
registration spec — never from a file name, the completion union, or
`LOCAL_COMMANDS`.

Registration order (authoritative, `src/commands.ts`):

`exit`,`quit` → `settings` → `footer`,`statusline` → `display` → `focus` →
`sessions`,`resume` → `skill` → `reload` → `model` → `new` → `tasks`,`subagents`
→ `plugins` → `yolo` → `preset` → `search` → `title`,`rename` → `copy` →
`attach`,`image` → `export` → `transcript` → `fork` → `rewind` → `status` →
`login` → `logout` → `help` → `keybindings` → *(dynamic)* per-skill wrappers.

## Capability status vocabulary

`SUPPORTED` · `RENDERED_READ_ONLY` · `EXPLICIT_UNAVAILABLE` · `NOT_REACHABLE` ·
`PROJECTION_ONLY` · `UNCLASSIFIED` (only with a recorded blocker).
Independently: `evidence_state` = `VERIFIED`/`PARTIAL`/`UNKNOWN`/`BLOCKED`/
`NOT_RUN`; `qual_tier` = `TYPE_ONLY`/`SDK_SCRIPTED`/`REAL_TERN_HEADLESS`/
`REAL_TERN_GUI`/`L1…L6`; `reachability_class` = `SURFACE_REACHABLE`/
`PROJECTION_ONLY`/`TRANSIENT`/`FORBIDDEN_CONCURRENT_STATE`.

Two rules that decide several rows below:

- `EXPLICIT_UNAVAILABLE` requires a **real input path that is refused with a
  visible outcome**. A silently ignored input is `NOT_REACHABLE`, never
  `EXPLICIT_UNAVAILABLE` (plan §5.1).
- `SUPPORTED` requires the capability's **own authority** to reach a successful
  closure with positive *and* appropriate negative evidence. A registry entry, a
  package being installed, or a generic dispatch route existing is not enough.

## 1. TUI-owned builtins

### 1.1 Fields common to every row in this family (proven, not assumed)

| Field | Value |
|---|---|
| Producer / registration | `registerTuiCommands` (`src/commands.ts:814`) through `registerOne` (`:929`) or `registerTuiCommand` (`:1483`); each row's own registrar line is in Table A |
| Origin classifier | `classifyCommandLine` (`src/domain/command/policy.ts:158-169`) with the live facts at `src/app/submission/controller.ts:1626-1646`; a TUI-owned name yields `client-command` + `source:'tui'` |
| Currentness fence | the submission boundary captures the ownership subject/generation before any await (`src/app/submission/controller.ts:743-749`); each handler re-fences against its own captured scope |
| Input entry | the TSP composer submit gesture → `TspInputHandlers.submit` → `ApplicationEvents.onSubmit` → `SubmissionController` (`src/tui/tsp/session.ts:675-687`, `src/app/surface/application-events.ts:232`) |
| TSP capability gate | `tspBuiltinAvailability` (`src/app/command/tsp-capability.ts:62-75`) at the post-classification admission (`src/app/submission/controller.ts:1683-1695`) |
| Action / presenter seam | the row's own handler (Table A); on TSP the family's only admitted member is the exit pair |
| Locality | Client-local UI/control commands; the Host writes they trigger stay with the original Host owner |
| TSP tier obtained | `L6` for the exit pair (B4 real pane), `L6` for the refusal family (`test/tern-tsp-runner-interactive.test.ts`), `SDK_SCRIPTED` for the renderer-side contracts |

Permalinks: [classifier](https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/domain/command/policy.ts#L158-L169) ·
[TSP capability predicate](https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/app/command/tsp-capability.ts#L62-L75) ·
[refusal admission](https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/app/submission/controller.ts#L1683-L1695)

### 1.2 Table A — registration, handler and its own authoritative sink

| ID | Action (+aliases) | bare/argued | sessionless | Registration (source:line) | Handler → own authoritative sink | Owner / locality |
|---|---|---|---|---|---|---|
| CMD-001 | `/exit` (`/quit`) | bare | yes | `src/tui/commands/utility.ts:41-46` | `runner.requestExit()` → the shared exit orchestration | runner lifecycle (Client) |
| CMD-002 | `/settings` | bare | yes | `src/tui/commands/settings.ts:243-…` | Settings panel over `runner.tuiSettings` / `runner.config` (+ explicit config-readiness notice) | settings runtime (Client UI) |
| CMD-003 | `/footer` (`/statusline`) | bare | yes | `src/tui/commands/settings.ts:1086-…` | Footer configurator over `runner.tuiSettings` + `app.getEffectiveFooterLayout()` | settings runtime (Client UI) |
| CMD-004 | `/display` | bare/argued | yes | `src/tui/commands/settings.ts:1206-1221` | `applyDisplayPreset(runner, verb)` + `app.notify` | display policy (Client) |
| CMD-005 | `/focus` | bare/argued | yes | `src/tui/commands/settings.ts:1229-1261` | `applyDisplayPreset(runner, 'focus'\|'full')` + `app.notify` | display policy (Client) |
| CMD-006 | `/sessions` (`/resume`) | bare/argued | yes | `src/tui/commands/sessions.ts:778-801` | `openSessionPicker(...)` (one Session Browser; `/resume` adds the direct-match fast path) | session presentation (Client UI, Host session list) |
| CMD-007 | `/skill` | bare=picker / argued=invocation | (argued is agent-facing) | `src/tui/commands/skills.ts:61-…` | `loadSkill(scope, name, args, …)` / the skill picker | Host skill pre-step + `loadSkill` (split) |
| CMD-008 | `/reload` | bare | yes | `src/tui/commands/skills.ts:145-…` | `runner.refreshSessionCatalog(scope,'reload')` + settings reload | catalog coordinator + settings (Client) |
| CMD-009 | `/model` | bare | yes | `src/tui/commands/models.ts:169-…` | model catalog + `runner.defaultIntent` / the session model write | settings/Agent model owner (Host) |
| CMD-010 | `/new` | bare | yes | `src/tui/commands/sessions.ts:803-887` | `runner.withSessionTransition` → `runner.transitionTo({create: runner.agents.create})` | session lifecycle (Host) |
| CMD-011 | `/tasks` (`/subagents`) | bare | no | `src/tui/commands/tasks.ts:33-45` | `runner.openTasksBrowser()` | Task Center (Client UI over Host registries) |
| CMD-012 | `/plugins` | bare | yes | `src/tui/commands/tasks.ts:53-60` | `runner.openPluginManager()` | Plugin Manager (Client UI) |
| CMD-013 | `/yolo` | bare | no | `src/tui/commands/models.ts:405-…` | `runner.applyPermissionPreset(scope,'danger-full-access')` (the official permission semantics) | permission policy (Host) |
| CMD-014 | `/preset` | bare/argued | yes | `src/tui/commands/models.ts:448-…` | preset roster read / switch | preset registry + session create (Host) |
| CMD-015 | `/search` | argued | yes | `src/tui/commands/sessions.ts:889-899` | `openSessionPicker(..., {requireQuery:true})` — the SAME browser | session presentation (Client UI) |
| CMD-016 | `/title` (`/rename`) | bare/argued | no | `src/tui/commands/sessions.ts:902-909`, `699-…` | `titleHandler` → `runner.withWriter(scope, …)` session-title write | Host session title |
| CMD-017 | `/copy` | bare | no | `src/tui/commands/artifacts.ts:173-192` | `runner.lastAssistantText(scope)` + `runner.copyToClipboard(text)` | Client clipboard policy |
| CMD-018 | `/attach` (`/image`) | argued | yes | `src/tui/commands/artifacts.ts:196-210` | `stageAttachmentCommand` → the draft image/file store | `client/media` + Host attachment admission (split) |
| CMD-019 | `/export` | bare | no | `src/tui/commands/artifacts.ts:212-227` | acknowledgement; the Client-local save workflow runs on the post-success seam | client artifact IO |
| CMD-020 | `/transcript` | bare | no | `src/tui/commands/artifacts.ts:229-…` | acknowledgement; Client-local Markdown save | client artifact IO |
| CMD-021 | `/fork` | bare | yes | `src/tui/commands/sessions.ts:912-930` | `runner.forkSession(sourceSessionId)` | Host fork + navigation |
| CMD-022 | `/rewind` | bare | yes | `src/tui/commands/sessions.ts:933-944` | `runner.openRewindPicker()` | rewind presentation (Client UI) |
| CMD-023 | `/status` | bare | no | `src/tui/commands/status.ts:171-…` | `runner.requireLiveSessionScope()` + `runner.currentSessionStats(scope)` | status derivation (Host stats) |
| CMD-024 | `/login` | argued | yes | `src/tui/commands/auth.ts:437-…` | credentials/authorization flows via `runner.config` | credentials (Client config) |
| CMD-025 | `/logout` | argued | yes | `src/tui/commands/auth.ts:584-…` | credential clear via `runner.config` | credentials (Client config) |
| CMD-026 | `/help` | bare | yes | `src/tui/commands/utility.ts:50-…` | keymap labels (`app.keybindingsManager()`) + the scoped command list | PiTui keymap labels (Client UI) |
| CMD-027 | `/keybindings` | argued | yes | `src/tui/commands/settings.ts:1265-…` | `app.keybindingsManager()` + the shortcuts editor | keybinding editor (Client UI) |
| CMD-028 | `/kill` | — | — | — (no registration anywhere) | none | no handler anywhere |

### 1.3 Table B — the TSP gate, its sink, and the evidence

For every row except CMD-001, the TSP gate's decision is the same:
`tspBuiltinAvailability` → `unsupported` → the post-classification refusal
(`src/app/submission/controller.ts:1690-1694`) restores the draft into the live
composer and notifies `This command's UI is not available in TSP yet`, **before**
any session ensure/create and with **no** Host write.

| ID | Gate decision | TSP sink | `capability_status` | `evidence_state` | Positive evidence | Negative evidence | `reachability_class` | SDK/GUI tier | Gap → PR |
|---|---|---|---|---|---|---|---|---|---|
| CMD-001 | `available` (`tsp-capability.ts:33,72`) | the real exit orchestration | `SUPPORTED` | `VERIFIED` | B4 real-pane `/exit`,`/quit` records; `test/tern-tsp-runner-interactive.test.ts:98` | `/quit` is the canonical alias and exits identically; a non-empty draft is never silently dropped | `SURFACE_REACHABLE` | `REAL_TERN_HEADLESS` + `L6` | — |
| CMD-002…CMD-027 | `unsupported` | refusal: draft + notice, no Session | `EXPLICIT_UNAVAILABLE` | `VERIFIED` for the **family refusal**; **`NOT_RUN`** for each command's own handler semantics on TSP | family lock `test/tern-tsp-runner-interactive.test.ts:52` (the refusal, the restored draft and `createdSessions === 0`) | the refusal is observable; no Host write, no session — and the same-name genuine Host line is NOT refused (`test/tern-tsp-direct-admission.test.ts:49`) | `SURFACE_REACHABLE` (the refusal is the reachable outcome) | n/a (no SDK node involved) | 4A/4B/4C per family |
| CMD-028 | n/a (no live Client registration, so it classifies through the ordinary precedence) | none | `NOT_REACHABLE` | `VERIFIED` | `src/domain/command/policy.ts:47-69` documents the deliberate disposition | a static `LOCAL_COMMANDS` membership is **not** ownership | `NOT_REACHABLE` | n/a | out of scope |

`CMD-002…CMD-027` is a deliberate range for the refused family: each row's
**registration and own sink are individually enumerated** in Table A, while the
TSP decision and sink are provably identical for the whole family (same
classifier, same predicate, same admission). No row is marked `SUPPORTED`. The
range covers each command's **TUI-owned/bare** form; CMD-007's *argued* form is a
skill invocation and is recorded separately (CMD-SKILL-002 in §3), and CMD-018's
*argued* form is the refused `/attach <path>` line.

## 2. Host-owned commands

The Host catalog is **runtime-resolved** — the repository deliberately never
derives Host authority from a static list (`src/domain/command/policy.ts:53-57`,
`src/commands.ts:2126-2149`). The pinned installed DSH (`0.2.0-rc.2`) packages
that register slash commands are:

| Command | Registering package (installed) | input descriptor |
|---|---|---|
| `/compact` | `@deepseek-ai/dsh-command-compact` | none (execute-kind) |
| `/goal` | `@deepseek-ai/dsh-command-goal` | `hint: "[<objective>\|clear\|edit <objective>\|pause\|resume]"` → claims its argued line |
| `/permission` | `@deepseek-ai/dsh-permission-presets` | `hint: "<preset>"` |
| `/plan` | `@deepseek-ai/dsh-plan-mode` | `hint: "[off\|message]"` |
| `/export` | `@deepseek-ai/dsh-session-log-export` | none (Web-oriented; the repo's own comment also names a Remote Host `/export`, `src/commands.ts:900`) |

Any plugin/profile command joins the same catalog at runtime. Reproduce with
`grep -rn 'ctx.commands.register' node_modules/@deepseek-ai/*/lib/*.js` plus
`dsh --profile <p> --dump-config`.

**Fields that are genuinely shared by §2 and §3** (the §1.1 TUI-family block does
not apply here). Everything else — **route, sink, locality and status** — is
**per row** and is given in the tables: these rows deliberately do NOT share one
seam. A gate-only row, a TUI-gate refusal, a shell-branch refusal, an extension
handler and a Host handler take five different paths, and claiming one common
"Host handler seam" for all of them would be false.

| Field | Value (shared) |
|---|---|
| Backend + renderer | Direct (production) / TSP |
| Classifier invocation + currentness | `classifyCommandLine` (`src/domain/command/policy.ts:158-169`) with live facts built at `src/app/submission/controller.ts:1626-1646`; ownership subject/generation captured at `:743-749` before any await. **Note:** the *outcome* differs per row (`host-command`, `client-command(extension)`, `ordinary-submission`, or a pre-classification refusal such as the shell branch). |
| Input entry | the TSP composer submit gesture (`src/tui/tsp/session.ts:675-687`) → `ApplicationEvents.onSubmit` → `SubmissionController` — except CMD-SHELL-001, which is decided at the `!`-prefix branch (`controller.ts:1543`) inside the same entry |
| Reachability class | `SURFACE_REACHABLE` for every row below |
| SDK/GUI tier | The entry is the TSP composer key path (`src/tui/tsp/session.ts:675-687`) — an SDK `ui.editor` surface driven by `SessionInput{type:'key'}` — so the applicable tiers are `SDK_SCRIPTED` (the router/refusal locks in the shared suites) and `REAL_TERN_HEADLESS` (the SDK input path). What is NOT involved is any SDK **node event** (`action`/`select`/`activate`/`change`/`edit`/`send`); those belong to [sdk-events](./pr4-0-sdk-events.md). The earlier `n/a` rested on the narrower rationale that no SDK *node* is involved, which understated the composer's own SDK surface. |

Per-row overrides are called out in the **classifier → route**, **observable
sink** and **owner / gap** columns; locality is stated per row in the owner
column (Host-owned semantics; Client-local gate decision; extension-handler
behaviour; shell-branch refusal).

| ID | Capability | Producer / registration | Classifier → route | Observable sink | Status | `evidence_state` | Positive | Negative | Owner / locality / gap |
|---|---|---|---|---|---|---|---|---|---|
| CMD-HOST-ROUTE | the **generic genuine-Host command dispatch route on TSP** | Host catalog at runtime; the repo's own comment names a Remote Host `/export` (`src/commands.ts:900`) | `hostOriginClaimOf` → `host-command` → `dispatchViaSession` → `commands.execute` → the Host handler (TUI mirrors subtracted, `src/commands.ts:2126-2149`) | the Host handler itself, once | `SUPPORTED` | `VERIFIED` (`L6`) | `test/tern-tsp-direct-admission.test.ts:49`: a **genuine Host** `/settings` handler ran exactly once on a real Direct composition and was NOT refused by the TSP builtin gate | a successfully mirrored TUI built-in answers `false` for Host origin (`src/commands.ts:2126-2149`), so the positive is not a vacuous "never refuses" | Host-owned; no gap |
| CMD-HOST-COMPACT | `/compact` own semantic result on TSP | `@deepseek-ai/dsh-command-compact` (installed) | execute-kind descriptor → bare-line claim | the Host compaction handler's effect + reread | `UNCLASSIFIED` | `NOT_RUN` | — | — | Host-owned; `BLOCKED_WITH_OWNER`: rides CMD-HOST-ROUTE, but its own closure was not exercised |
| CMD-HOST-GOAL | `/goal` own semantic result on TSP | `@deepseek-ai/dsh-command-goal` | leading-input descriptor → claims the argued line | the Host goal handler's effect + reread | `UNCLASSIFIED` | `NOT_RUN` | — | — | Host-owned; same blocker |
| CMD-HOST-PERMISSION | `/permission` own semantic result on TSP | `@deepseek-ai/dsh-permission-presets` | leading-input descriptor | the permission preset write | `UNCLASSIFIED` | `NOT_RUN` | — | — | Host-owned; same blocker |
| CMD-HOST-PLAN | `/plan` own semantic result on TSP | `@deepseek-ai/dsh-plan-mode` | leading-input descriptor | plan-mode toggle | `UNCLASSIFIED` | `NOT_RUN` | — | — | Host-owned; same blocker |
| CMD-HOST-EXPORT | `/export` (Host) own semantic result on TSP | `@deepseek-ai/dsh-session-log-export` | execute-kind descriptor | the Host export acknowledgement | `UNCLASSIFIED` | `NOT_RUN` | — | — | Host-owned; same blocker |
| CMD-EXPORT-AMBIGUITY | `/export` name coexistence (TUI mirror + a Host `/export` in some profiles) | both registrations exist in some compositions | the TUI mirror LOSES the Host name by construction (`registerOne`'s duplicate refusal, `src/commands.ts:951-962`) | whichever owner wins for that profile | `UNCLASSIFIED` | `NOT_RUN` | — | the duplicate refusal is proven by `src/commands.ts:951-962` | profile composition; no TSP run |

No Host row is called `SUPPORTED` merely because its package is installed or
because the generic route exists.

## 3. Extension contributions, skill wrappers and plain submission

Per-row fields; the shared block above applies only to the four genuinely shared
values.

| ID | Capability | Producer / registration | Classifier → route | Observable sink | Status | `evidence_state` | Positive | Negative | Owner / locality / gap |
|---|---|---|---|---|---|---|---|---|---|
| CMD-EXT-001 | an extension command contribution | client command bridge (`mergeContributions`, `src/commands.ts:1085-1100`) | `client-command`+`source:'extension'` → the gate reports `not-a-tui-builtin` → the contribution's own handler | the contribution's handler effect | `SUPPORTED` | `VERIFIED` | `test/tern-tsp-direct-admission.test.ts:330`: a registered contribution runs and is never refused by the TSP gate | the F1 family lock (`test/tern-tsp-runner-interactive.test.ts:76`) shows a non-TUI line is not refused while a TUI-owned one is (`:52`) | Client-side extension behaviour (the contribution's own handler); no gap |
| CMD-SUBMIT-001 | an ordinary prompt submission on TSP | — (no command involved) | no parsed command → `ordinary-submission` → `dispatchViaSession` → the shared writer | the Host session writer + the model response | `SUPPORTED` | `VERIFIED` (`REAL_TERN_GUI` per B4, not re-run here) | B4 real-pane C1/C2: a typed + pasted prompt was submitted and answered | the `.rec` records show one submission per gesture (no double-send) | `SubmissionController` (Host writer via the Client); no gap |
| CMD-EXT-002 | an **unregistered** slash line reaching the Host writer/model on TSP (`/not-a-registered-command body`) | — | `classifyCommandLine{}` → `ordinary-submission` → the shared ordinary-submission tail (`controller.ts:1894`) | end-to-end: the session writer + a response | `UNCLASSIFIED` | `NOT_RUN` | the ONLY proven half: the line is classified `ordinary-submission` and is **not** refused by the TSP builtin gate (`test/tern-tsp-runner-interactive.test.ts:76`) | the discriminating boundary: the same gate DOES refuse a TUI-owned builtin (`test/tern-tsp-runner-interactive.test.ts:52`), so the non-refusal is not vacuous. The delivery half has no observation. | the classifier is proven; the delivery authority is **not** — `BLOCKED_WITH_OWNER`: exercising the exact line, or asserting the delivered prompt in the F1 test, would close it. (The F1 test's own comment mentions a session being ensured, which the test does **not** assert — a pre-existing comment/test mismatch, reported rather than fixed.) |
| CMD-SKILL-001 | a **live skill wrapper** `/‹skill-name› [args]` | dynamic `registerOne` per human skill (`src/commands.ts:1813-1870`, revalidating at `1915-1945`) | family is `skill-invocation` (`tuiCommand` suppressed — `src/app/submission/controller.ts:1635-1646`) → the gate never captures it → `dispatchViaSession`/steer | the normalized `/name args` line delivered to the Host + the injected body | `UNCLASSIFIED` | `NOT_RUN` | the classification and the shared delivery route are proven in code and by the shared suites | — | `BLOCKED_WITH_OWNER`: the skill's own closure on TSP (body injection by the Host pre-step, `loadSkill` fallback, args preserved) was not exercised |
| CMD-SKILL-002 | `/skill <name> args` | `normalizeSkillInvocation` (`src/domain/command/policy.ts:286-299`) | same as CMD-SKILL-001 | same | `UNCLASSIFIED` | `NOT_RUN` | same | — | same blocker |
| CMD-SKILL-003 | bare `/skill` picker | `src/tui/commands/skills.ts:61` | `client-command(tui)` → `unsupported` → refused | refusal: draft + notice, no Session | `EXPLICIT_UNAVAILABLE` | `VERIFIED` | family refusal lock `test/tern-tsp-runner-interactive.test.ts:52` | `createdSessions === 0`; the draft is restored | owner: the §1 family; gap → 4A |
| CMD-SHELL-001 | `!` / `!!` user-shell lines | `src/app/submission/controller.ts:1543-1556` | refused at the ORIGINAL shell-branch admission | refusal: draft + error notice, **before** any history/session/shell work | `EXPLICIT_UNAVAILABLE` | `VERIFIED` | B4 `b4-c5-3.rec`; `test/tern-tsp-runner-interactive.test.ts:158` | no input-history row is written (`test/tern-tsp-direct-admission.test.ts:132`) | owner: the shell branch; gap → 4A if ever |

The classification precedence is one function, `classifyCommandLine`
(`src/domain/command/policy.ts:158-169`), with the authoritative facts supplied
live: `hostOriginClaimOf` (genuine Host descriptors, TUI mirrors subtracted),
`clientClaimsLine` (Client registry), the extension bridge, and the live
skill-wrapper state. No consumer may re-derive origin from `LOCAL_COMMANDS`, the
completion union or the string `/name`.

## 4. Scenes

### 4.1 `ready` vs **pre-catalog-ready**

| Scene | Observed | Evidence | Status |
|---|---|---|---|
| steady state, Host claims `/settings` | Host handler runs | B4 `b4-hostcmd-origin.rec`; `test/tern-tsp-direct-admission.test.ts:49` | `SUPPORTED` (CMD-HOST-ROUTE) |
| ~immediately after handshake, before the Host catalog resolves | the same `/settings` produced the **TSP refusal notice** | B4 record, `docs/tern-tsp/evidence/pr3-b.md` "Catalog readiness (observed; tracked outside B4)" | **cause NOT established**; recorded, not diagnosed (`UNKNOWN`) |

This audit did **not** reproduce or root-cause the early-catalog window. It is
*not* a TSP admission defect per the B4 record, and it is *not* proven to be a
general Host-catalog characteristic either. It is registered as a decision item
(`catalog readiness UX`) with the honest label `UNKNOWN` for its cause. No global
readiness bug is asserted.

### 4.2 bare vs argued

| Line | Winner | Why |
|---|---|---|
| `/export` (bare) | Host `export` if the profile mounts it, else TUI `export` | bare execute-kind claim |
| `/export foo` | ordinary submission (`hostNameReserved`) | an execute-kind Host descriptor does not claim an argued line (`hostClaimOf`, `src/commands.ts:1972-1977`) |
| `/goal ship` | Host `/goal` claimed line | leading-input descriptor |
| `/name args` for a live skill wrapper | skill invocation | wrapper claims its argued line |
| `/settings foo` | Host name resolved but not claimed → ordinary submission | never a same-named TUI mirror |

## 5. Shortest decision chains (the audit's critical cases)

Every chain is `authority producer → classifier/currentness → entry → sink`.

**CMD-002/D1 — TUI-origin `/settings` (refusal):**
input `Enter` → composer submit → `ApplicationEvents.onSubmit`
(`src/app/surface/application-events.ts:232`) → `SubmissionController` →
`classifyCommandLine{tuiCommand:true}` → `client-command(tui)` →
`tspBuiltinAvailability` → `unsupported` (`tsp-capability.ts:72`) →
`!supportsTuiBuiltinUi` (`src/app/bootstrap.ts:2184`, true on TSP) →
`setEditorText(mergeDraft(...))` + `notify(…'not available in TSP yet')`
(`controller.ts:1690-1694`) → **sink: draft + notice, no Session, no Host write**.
`Positive:` `test/tern-tsp-runner-interactive.test.ts:52`. `Negative:` the
created-session counter stays zero and the draft is re-read from the wire.
Permalink: [refusal admission](https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/app/submission/controller.ts#L1683-L1695).

**CMD-HOST-ROUTE/D2 — Host-origin `/settings` (Host sink):**
`hostOriginClaimOf('/settings')` → `{claimed:true}` → `host-command` →
`dispatchViaSession` (`controller.ts:1743-1746`) → `commands.execute` → the Host
handler. `Positive:` `test/tern-tsp-direct-admission.test.ts:49` asserts the Host
handler ran **exactly once** and the refusal text is absent. `Negative:` TUI
mirror subtraction — a successfully mirrored TUI registration must NOT read as
Host origin (`src/commands.ts:2126-2149`).

**CMD-001 — `/exit`:**
`client-command(tui)` + name ∈ `{exit,quit}` → `available` → sessionless route
(`controller.ts:1701-1704`, `1855-1858`) → `runLocalCommand` →
`clientCommands.get('exit')` → `runner.requestExit()`
(`src/tui/commands/utility.ts:36-39`) → the shared exit orchestration.
`Positive:` `test/tern-tsp-runner-interactive.test.ts:98` + B4 C5 real-pane
records. `Negative:` `/quit` is the canonical alias and exits identically.

**CMD-SHELL-001 — `!`/`!!`:**
`text.startsWith('!')` → `!supportsLocalShellCards` (`bootstrap.ts:2180`) →
restore + `User-shell UI is not available in TSP yet`
(`controller.ts:1544-1556`) → **before** any `persistHistory`/`ensureSession`/
`shell.run`. `Positive:` `test/tern-tsp-runner-interactive.test.ts:158`;
B4 `b4-c5-3.rec`. `Negative:` no input-history row is written
(`test/tern-tsp-direct-admission.test.ts:132`).

**CMD-EXT-002 — `/not-a-registered-command body` (ordinary submission):**
`classifyCommandLine{}` → `ordinary-submission` → the shared ordinary-submission
tail (`controller.ts:1894`). **Proven half:** the classification and the gate's
non-refusal (`test/tern-tsp-runner-interactive.test.ts:76`), with the
discriminating boundary that the same gate DOES refuse a TUI-owned builtin
(`:52`). **Unproven half:** the line actually reaching the Host writer/model —
hence the row is `UNCLASSIFIED`/`NOT_RUN`, not `SUPPORTED`.

**CMD-ELIG — advertised-miss:**
an advertised name the real session lacks is consumed with an explicit error,
never sent to the model (`shouldConsumeAdvertisedMiss`,
`policy.ts:315-320`; `test/tern-tsp-direct-admission.test.ts:359`).

## 6. Gaps and recommended PR

| Gap | Recommended PR | Dependency |
|---|---|---|
| No TSP command UI: every TUI builtin except the exit pair is refused | 4A | **keyboard route:** a presentation seam over the EXISTING seat/key routing + `commands.execute` — no event admission involved. **Pointer route:** the scoped event admission is REQUIRED; a standalone 4A0 is CONDITIONAL on shared consumers + owner approval. See the 4A0 decision. |
| No selectable menu / picker surface in TSP | 4A | same |
| No session/task/viewer panel entry | 4B | 4A's input ownership rules |
| No attachment/clipboard/editor path in TSP | 4C | proven attachment route + Client-local policy reuse |
| Per-command Host closure (`/compact`,`/goal`,`/permission`,`/plan`,`/export`) and skill-invocation closure on TSP | owner decision | run each against TSP, or owner-accept the generic route |
| Full Host enumeration is runtime-dependent | — (recorded) | a profile-scoped enumeration is optional tooling, not a blocker |
| Early-catalog `/settings` window | decision item | owner call: separate issue vs PR4A input |
