# PR4-0 evidence — command / origin / reachability ledger

Part of the [PR4-0 capability audit](./pr4-0.md). This is the **complete
enumerated** ledger of the commands the current `next` tree registers, what
owns each one, and what the TSP renderer actually does with it.

Source-reference convention: every `file:line` below is against the **single**
qualification baseline recorded in [pr4-0.md § Baseline](./pr4-0.md#baseline--qualification-topology).
Per-row commit-pinned blob URLs are deliberately not used, so this document does
not break when history is rewritten; the baseline SHA plus `path:line` is the
immutable reference.

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

## 1. TUI-owned builtins — the authoritative table

All of these are the Client registry's `client-command` + `source:'tui'` family
(`src/domain/command/policy.ts:158-169`) and reach the TSP gate at
`src/app/submission/controller.ts:1683-1695`. The TSP renderer's capability
predicate (`src/app/command/tsp-capability.ts:33,62-75`) admits **only**
`exit`/`quit`; every other name in this table is refused with the notice
`This command's UI is not available in TSP yet` and the draft restored — no
session is created, no Host write happens.

| ID | Command (+aliases) | bare vs argued | sessionless | TSP status | evidence_state | reachability | owner of the refused capability | gap → PR |
|---|---|---|---|---|---|---|---|---|
| CMD-001 | `/exit` (`/quit`) | bare | yes | `SUPPORTED` | `VERIFIED` (`REAL_TERN_HEADLESS` + `L6`, B4 C5) | `SURFACE_REACHABLE` | runner exit controller | — |
| CMD-002 | `/settings` (TUI) | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6`) | `SURFACE_REACHABLE` | `settings-runtime.ts` (PiTui panel) | 4A |
| CMD-003 | `/footer` (`/statusline`) | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`SDK_SCRIPTED`/`L6` family) | `SURFACE_REACHABLE` | footer configurator | 4A |
| CMD-004 | `/display` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | display preset reachable via settings only | 4A/PR5C |
| CMD-005 | `/focus` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | Focus policy | 4A/PR5C |
| CMD-006 | `/sessions` (`/resume`) | bare/argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | session-presentation picker | 4B |
| CMD-007 | `/skill` | bare=picker / argued=invocation | (argued is agent-facing) | bare `EXPLICIT_UNAVAILABLE`; argued `SUPPORTED` (via the skill-invocation family) | `PARTIAL` (shared path; no TSP-specific test) | `SURFACE_REACHABLE` | picker UI / Host skill pre-step | 4A picker |
| CMD-008 | `/reload` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | catalog refresh | 4A |
| CMD-009 | `/model` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | model picker + settings/Agent model owner | 4A (highest value) |
| CMD-010 | `/new` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`REAL_TERN_HEADLESS`, B4 §6.4-8) | `SURFACE_REACHABLE` | session transition | 4B |
| CMD-011 | `/tasks` (`/subagents`) | bare | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | Task Center (`supportsTaskCenter=false`, `task-runtime.ts:521,535`) | 4B |
| CMD-012 | `/plugins` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | Plugin Manager panel | 4B |
| CMD-013 | `/yolo` | bare | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | delegates to `/permission danger-full-access` (Host) | 4A |
| CMD-014 | `/preset` | bare/argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | preset registry + session create | 4A |
| CMD-015 | `/search` | argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | session browser (shared with `/sessions`) | 4B |
| CMD-016 | `/title` (`/rename`) | bare/argued | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | session-title Host owner | 4A |
| CMD-017 | `/copy` | bare | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | `client-actions.ts` clipboard policy | 4C |
| CMD-018 | `/attach` (`/image`) | argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | `client/media` draft store + attachment admission | 4C |
| CMD-019 | `/export` (TUI) | bare | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | client artifact save owner | 4C |
| CMD-020 | `/transcript` | bare | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | client artifact save owner | 4C |
| CMD-021 | `/fork` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`REAL_TERN_HEADLESS`, B4 §6.4-8) | `SURFACE_REACHABLE` | Host fork + navigation | 4B |
| CMD-022 | `/rewind` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | rewind picker | 4B |
| CMD-023 | `/status` | bare | no | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | status cards | 4A |
| CMD-024 | `/login` | argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | auth flow | 4A |
| CMD-025 | `/logout` | argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | auth flow | 4A |
| CMD-026 | `/help` | bare | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | PiTui keymap labels (`utility.ts:61`) | 4A |
| CMD-027 | `/keybindings` | argued | yes | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`L6` family) | `SURFACE_REACHABLE` | keybinding editor UI | 4A |
| CMD-028 | per-skill `/‹skill-name› [args]` | bare/argued | agent-facing | `SUPPORTED` for the invocation (family is `skill-invocation`, never captured by the gate) | `PARTIAL` (shared path; no TSP-specific test) | `SURFACE_REACHABLE` | Host skill pre-step + `loadSkill` | 4A (picker only) |
| CMD-029 | `!` / `!!` shell lines | — | — | `EXPLICIT_UNAVAILABLE` | `VERIFIED` (`REAL_TERN_HEADLESS`, B4 C5) | `SURFACE_REACHABLE` | original shell branch (`controller.ts:1550-1556`) | 4A (if ever) |
| CMD-030 | `/kill` | — | — | `NOT_REACHABLE` (no live registration; not TUI-owned) | `VERIFIED` (policy doc `policy.ts:47-69`) | `NOT_REACHABLE` | no handler anywhere | out of scope |

`/permission` is **not** a TUI registration (`src/commands.ts:2042-2045`); it is
Host-owned and therefore takes the Host route (below). `/plan` is runner-handled
and Host-owned (`src/domain/command/policy.ts:96-99`).

`NOT_REACHABLE` for `/kill` is the correct label precisely because the static
`LOCAL_COMMANDS` membership is **not** ownership: the classifier consults the
live Client registry, and `/kill` has none.

## 2. Host-owned commands

The Host catalog is **runtime-resolved** — the repository deliberately never
derives Host authority from a static list (`src/domain/command/policy.ts:53-57`,
`src/commands.ts:2126-2149`). The pinned installed DSH (`0.2.0-rc.2`) packages
that register slash commands are:

| Host command | Registering package (installed) | TSP status | note |
|---|---|---|---|
| `/compact` | `@deepseek-ai/dsh-command-compact` | `SUPPORTED` (Host route) | execute-kind, no `input` hint |
| `/goal` | `@deepseek-ai/dsh-command-goal` | `SUPPORTED` (Host route) | `input.hint = "[<objective>|clear|edit …]"` → claims its argued line |
| `/permission` | `@deepseek-ai/dsh-permission-presets` | `SUPPORTED` (Host route) | `input.hint = "<preset>"` |
| `/plan` | `@deepseek-ai/dsh-plan-mode` | `SUPPORTED` (Host route) | `input.hint = "[off|message]"` |
| `/export` | `@deepseek-ai/dsh-session-log-export` | `SUPPORTED` (Host route) when the profile mounts it | Web-oriented; the repo's own comment also names a Remote Host `/export` (`src/commands.ts:900`) |

Any plugin/profile command (a user's own plugin) joins the same catalog at
runtime; the audit deliberately does not freeze a global list. Reproduce with
`grep -rn 'ctx.commands.register' node_modules/@deepseek-ai/*/lib/*.js` plus
`dsh --profile <p> --dump-config`.

Evidence: `test/tern-tsp-direct-admission.test.ts:49` proves the decisive case —
a **genuine Host** `/settings` keeps its Host sink and is *not* refused by the
TSP builtin gate, on a real Direct composition (`L6`). The negative is
`test/tern-tsp-runner-interactive.test.ts:52`: a **TUI-owned** `/settings` is
refused with the draft restored and **no Session created**.

## 3. Extension contributions and skill wrappers

| Source | Registration | TSP routing |
|---|---|---|
| Extension command contribution | client command bridge (`mergeContributions`, `src/commands.ts:1085-1100`) | `client-command` + `source:'extension'` → the TSP gate reports `not-a-tui-builtin` → the contribution's own handler runs (never refused). Locked by `test/tern-tsp-direct-admission.test.ts:330`. |
| Live skill wrapper | dynamic `registerOne` per human skill (`src/commands.ts:1813-1870`, revalidating at `1915-1945`) | family is `skill-invocation` (`tuiCommand` is suppressed for it — `src/app/submission/controller.ts:1635-1646`), so the gate never captures it; the invocation travels as an agent-facing prompt. |
| `/skill <name> args` | same handler | `normalizeSkillInvocation` (`policy.ts:286-299`) → `/<name> args`. |

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
| steady state, Host claims `/settings` | Host handler runs | B4 `b4-hostcmd-origin.rec`; `test/tern-tsp-direct-admission.test.ts:49` | `SUPPORTED` |
| ~immediately after handshake, before the Host catalog resolves | the same `/settings` produced the **TSP refusal notice** | B4 record, `docs/tern-tsp/evidence/pr3-b.md` "Catalog readiness (observed; tracked outside B4)" | **cause NOT established**; recorded, not diagnosed |

This audit did **not** reproduce or root-cause the early-catalog window. It is
*not* a TSP admission defect per the B4 record, and it is *not* proven to be a
general Host-catalog characteristic either. It is registered below as a decision
item (`catalog readiness UX`), with the honest label `UNKNOWN` for its cause.
No global readiness bug is asserted.

### 4.2 bare vs argued

| Line | Winner | Why |
|---|---|---|
| `/export` (bare) | Host `export` if the profile mounts it, else TUI `export` | bare execute-kind claim |
| `/export foo` | ordinary submission (`hostNameReserved`) | an execute-kind Host descriptor does not claim an argued line (`hostClaimOf`, `src/commands.ts:1974-1981`) |
| `/goal ship` | Host `/goal` claimed line | leading-input descriptor |
| `/name args` for a live skill wrapper | skill invocation | wrapper claims its argued line |
| `/settings foo` | Host name resolved but not claimed → ordinary submission | never a same-named TUI mirror |

## 5. Shortest decision chains (the audit's critical cases)

**CMD-002/D1 — TUI-origin `/settings` (refusal):**
input `Enter` → composer submit → `ApplicationEvents.onSubmit`
(`src/app/surface/application-events.ts:232`) → `SubmissionController` →
`classifyCommandLine{tuiCommand:true}` → `client-command(tui)` →
`tspBuiltinAvailability` → `unsupported` (`tsp-capability.ts:72`) →
`!supportsTuiBuiltinUi` (`bootstrap.ts:2184`, true on TSP) →
`setEditorText(mergeDraft(...))` + `notify(…'not available in TSP yet')`
(`controller.ts:1690-1694`) → **sink: draft + notice, no Session, no Host write**.
`Positive:` `test/tern-tsp-runner-interactive.test.ts:52`. `Negative:` the
session-created counter stays `0`; the draft is re-read from the wire.

**CMD-002/D2 — Host-origin `/settings` (Host sink):**
`hostOriginClaimOf('/settings')` → `{claimed:true}` → `host-command` →
`dispatchViaSession` (`controller.ts:1743-1746`) → `commands.execute` → the Host
handler. `Positive:` `test/tern-tsp-direct-admission.test.ts:49` asserts the Host
handler ran **exactly once** and the refusal text is absent. `Negative:` TUI
mirror subtraction — a successfully mirrored TUI registration must NOT read as
Host origin (`src/commands.ts:2126-2149`, `hostOriginDescriptors`).

**CMD-001 — `/exit`:**
`client-command(tui)` + name ∈ `{exit,quit}` → `available` → sessionless route
(`controller.ts:1701-1704,1855-1858`) → `runLocalCommand` →
`clientCommands.get('exit')` → handler → `runner.requestExit()`
(`src/tui/commands/utility.ts:36-39`) → the shared exit orchestration. `Positive:`
`test/tern-tsp-runner-interactive.test.ts:98` + B4 C5 real-pane records.
`Negative:` `/quit` is the canonical alias and exits identically; a non-empty
draft is never silently dropped by the exit path (B4).

**CMD-029 — `!`/`!!`:**
`text.startsWith('!')` → `!supportsLocalShellCards` (`bootstrap.ts:2180`) →
restore + `User-shell UI is not available in TSP yet` (`controller.ts:1544-1556`)
→ **before** any `persistHistory`/`ensureSession`/`shell.run`. `Positive:`
`test/tern-tsp-runner-interactive.test.ts:158`; B4 `b4-c5-3.rec`.
`Negative:` no input-history row is written (`test/tern-tsp-direct-admission.test.ts:132`).

**CMD-007 — `/not-a-registered-command body` (ordinary submission, not a refusal):**
`classifyCommandLine{}` → `ordinary-submission` → the model path. `Positive/Lock:`
`test/tern-tsp-runner-interactive.test.ts:76` (the F1 regression: the gate must
never refuse a non-TUI family).

**CMD-ELIG — advertised-miss:**
an advertised name the real session lacks is consumed with an explicit error,
never sent to the model (`shouldConsumeAdvertisedMiss`, `policy.ts:315-320`;
`test/tern-tsp-direct-admission.test.ts:359`).

## 6. Gaps and recommended PR

| Gap | Recommended PR | Dependency |
|---|---|---|
| No TSP generic command UI: every TUI builtin except the exit pair is refused | 4A | a real non-key event admission + selection/presenter seam |
| No selectable menu / picker surface in TSP | 4A | same |
| No session/task/viewer panel entry | 4B | 4A's input ownership rules |
| No attachment/clipboard/editor path in TSP | 4C | proven attachment route + Client-local policy reuse |
| Full Host enumeration is runtime-dependent | — (recorded) | a profile-scoped enumeration is a PR4-0+ tooling item, not a blocker |
| Early-catalog `/settings` window | decision item | owner call: separate issue vs PR4A input |
