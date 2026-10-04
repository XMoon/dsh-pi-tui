# M3 entry contract

> Authority: this document is the frozen M3 architecture contract produced by the
> M3-0 stage. M3-1 through M3-6 are implemented from it; a stage that needs to
> change a frozen decision must amend this document in the same PR and say why.
> `docs/client-server-migration.md` stays the migration roadmap/status authority;
> this file is the M3 architecture contract and deliberately does not repeat the
> phase history.
>
> Every row below is evidence-backed against the pinned rc.2 public contract. A
> classification is READY only when every method of the semantic port has a proven
> Remote/public source; a nearby namespace with a similar name is never enough.
>
> Review correction: this revision closes the full M3-0 review sequence. Earlier
> passes closed Host/Client dependency closure, CommandRuntimeSurface migration,
> Session handoff ordering, settings-mirror reconnect/race semantics, Client-owned
> slash-command execution, tool-card presentation, image submit/read ownership,
> whole-log `/rewind` navigation and the rc.2 skill-invalidation limitation. The
> final reverse-coupling closure additionally freezes independent
> permission/sandbox/approval semantics, Shift+Tab permission cycling, local-shell
> placement/fail-closed behavior, Remote turn-end flush semantics and Host-local
> legacy-settings migration readiness. These are frozen decisions, not TODOs.

## Amendment register

Architecture/semantic amendments to this frozen contract (not implementation
progress):

| Date | Baseline | Section | Old assumption | New authority | Reason |
|---|---|---|---|---|---|
| 2026-09-30 | `next @ 25295d7f3ac688cd95c94c6ac7c256f4060be218` | §2.1 `interaction` | Approval and Question both described as waterfall-only | Approval remains waterfall/fail-closed for unsupported policy operations; Question gains official `attachWait` + projection + `answer` authority | DSH `0.2.0-rc.2` publishes the full Question contract |
| 2026-10-03 | `next @ e520c01614e27c12b12190b4419bdf7fa3e6636d` | §2.4 / §8 | The explicit Client Remote contribution closure could be read as a global registry for every future feature, and the "a plugin contributing UI is loaded in the Client Context" wording could be read as forbidding Host-originated declarative surfaces | The existing list is the current M3 CORE Remote contribution closure. Existing PiTui imperative UI callbacks/components remain Client-owned. A future feature may own a generated Remote lifecycle, and a Host-owned feature may expose declarative UI as serializable facts/action identity, without moving any callback/component/renderer/editor object across the wire | Clarify composition ownership and preserve the no-callback boundary; no rc.2 capability, dependency or implementation change |

This register is normative from 2026-09-30 onward. Earlier contract corrections
(the `transport.rpc` → `installConnection({ transport })` carrier correction, the
0.2.0-rc.1 `llm.listModels` correction, and the M3-3A public-contract
requalification) remain documented in their existing sections and are not
retroactively reconstructed here.

## 1. Baseline

| Fact | Value | Evidence |
|---|---|---|
| Integration branch | `next` | — |
| Baseline commit | `495bb47403e5c5ff8b7827122b7ddf8246f2f2ec` | `git rev-parse next`; unchanged from the audited reference (no reset performed) |
| Package version | `0.4.9` | `package.json` |
| Installed DSH family | `0.1.7-rc.2` (npm mode) | `test/compat/dsh-mode.json` = `{"mode":"npm"}`; every `@deepseek-ai/*` in `node_modules/.pnpm` resolves `0.1.7-rc.2` (1892 lock references) |
| Spot-checked installed versions | `dsh-client-connection`, `dsh-api-gateway`, `dsh-api-remotes`, `dsh-api-session-controller`, `dsh-api-job-controller` all `0.1.7-rc.2` | `node -p "require('<pkg>/package.json').version"` |
| Upstream tag | `dsh-v0.1.7-rc.2` = `477b4f420553e8a52c2fbccc464d7561b239c443` | `git -C ~/project/deepseek-harness rev-parse dsh-v0.1.7-rc.2^{commit}` |
| Working tree | clean at branch creation; worktree `/home/xmoon/project/dsh-pi-tui-m3-0`, branch `docs/m3-entry-contract` | `git status --short` (empty) |
| Production backend | Direct (unchanged by this stage) | `src/runtime/backend.ts:30` `BackendKind = 'direct'` |

The audited `next` had not advanced, so no re-inventory against a newer HEAD was
required. DSH `master` was not used to redefine any conclusion.

### 1.1 M3-3A requalification against DSH 0.2.0-rc.1

M3-0 was frozen against the 0.1.7-rc.2 evidence baseline above. M3-3A
requalified the exact public API evidence against the then-current published
line **dsh-v0.2.0-rc.1** (`next @ fa7116876e50d298947b2544902ed3f4631feb5a`,
package `0.5.0`, npm mode, source qualification commit
`4878cdabd87d4041bdaff61d04c966883b9fd07a`). The rule applied:

- **M3-0 architecture decisions remain frozen** (owners, locality, capability
  vocabulary, unsupported classes, the M3 PR train). No decision was reopened
  merely because the DSH line advanced.
- **Exact API / Remote / projection evidence was re-derived from the installed
  0.2.0-rc.1 public types** wherever M3-3A builds an adapter on it. Where
  0.2.0-rc.1 corrects an rc.2-era evidence row, the correction is recorded
  here and the M3-3A implementation follows 0.2.0-rc.1 — never the stale rc.2
  shape.

Requalified facts (0.2.0-rc.1, generated
`dsh-llm/lib/typert.remote-client.d.ts` and
`dsh-api-session-controller/lib/typert.remote-client.d.ts`):

| Capability | 0.2.0-rc.1 public Remote | Consequence |
|---|---|---|
| `session.modelCatalog()` | YES | the official grouped selectable model directory (`default` + `routableProviders` + `groups` + `failures`); dsh-web's subagent model settings consume it |
| `llm.listProviders()` | YES | provider registry discovery |
| `llm.listConfigurableProviders()` | YES | configurable-provider directory (config-schema knowledge stays with ConfigPort/M3-3B) |
| `llm.discoverModels(settingsNs, request, signal)` | YES | the add-provider wizard probe |
| `llm.listModels(provider)` | **NO public Remote** | Host method only — §2.2's rc.2-era row implying a Remote source for `listModels` is corrected: the subagent allowlist picker converges on the official `session.modelCatalog` directory; no private `llm/listModels` RPC may be invented |
| `skills/list({sessionId}, signal)` | YES | Session-addressed human-skill catalog, list-only |
| `fileReferences/list(agentId, query, signal)` | YES | Session-scoped `@`-file discovery only |
| `contextPressure` / `contextBreakdown` / `tokenUsage` projections | YES (`dsh-token-meter/lib/types/projection.d.ts`) | official context occupancy: `projectedTokens ?? pressureTokens` (+ `contextWindow`), the same fields dsh-web's ContextMeter reads |
| `turnOutline` projection + `Session.loadThrough(seq)` | YES (`dsh-session-turn-outline`, Client `Session.loadThrough`) | the only Remote deep-history path |

Rechecked unsupported rows (§10) against 0.2.0-rc.1 — all remain unsupported,
with unchanged reasons: sessionless/workspace-scoped `@file` discovery (every
file endpoint is Session-scoped), `@file` existence/canonicalization (no
canonicalization verb), sessionless standing skill catalog and Client skill
body read (`skills/list` is Session-addressed and list-only; no `skills/read`),
`onSkillsChange` hot invalidation (no `skills/*` entry in the forwarded
Remote-event selection), and `refreshTitle` (no official Client verb;
`session/rename` is a distinct explicit rename, not regeneration).

### 1.2 Contract disposition vs live implementation status

This document is the frozen architecture/semantic contract. It answers:

```text
what the semantic contract is
which official authority owns it
which composition owner is allowed to provide it
which lifecycle/currentness rules are frozen
which fallbacks are forbidden
which unsupported classes must fail closed
```

It does NOT answer which PR is currently coding a capability, whether an adapter
has landed, whether CI is green, or how far the current stage has progressed.
Those facts belong in `docs/client-server-migration.md` only.

The classification columns of the §2 matrices are a **frozen contract
disposition / last-requalification snapshot**, not live implementation status,
and they are not updated for ordinary implementation progress. A cell that names
a stage (for example `READY (M3-3A closed it)` or `IMPLEMENTED (M3-3B)`) records
when the disposition was last requalified — it is not a claim that the row was
already true at M3-0. The `Existing Remote impl` and per-sub-domain evidence
columns are a historical snapshot captured at the same requalification points.

None of those columns is the live progress authority.
`docs/client-server-migration.md` remains the only place that reports current
stage/adapter status and qualification evidence.

Amend this frozen contract only when one of these changes:

```text
released DSH semantic authority
public Client/Remote/projection contract
composition ownership
lifetime/currentness invariant
locality classification
failure taxonomy
forbidden fallback
M3 stage boundary itself
```

A Remote adapter implementation landing, or a new regression test being added,
does not by itself require a contract amendment. Never preserve an obsolete
statement merely because an accepted stage plan was written against it;
conversely, do not reopen unrelated frozen decisions without evidence.

### 1.3 M3-4 entry baseline

M3-3B product closure baseline:

```text
next = 25295d7f3ac688cd95c94c6ac7c256f4060be218
DSH exact target = 0.2.0-rc.2 @ 639ed015397290b3745d163aafe02ffee4aa3f84
complete experimental Backend(kind='remote') exists
Direct remains production/default
```

The M3-4 implementation branch starts from the then-current `next` after the
pre-M3-4 governance/documentation changes are merged.

Before M3-4 implementation, run Contract Requalification
(`docs/client-server-migration.md` §Migration process and qualification
governance) if:

```text
the published DSH target changed
- or -
product/runtime changes after the M3-3B closure baseline could invalidate a
frozen semantic/composition assumption
```

Docs-only governance changes that preserve the frozen contract do not by
themselves trigger requalification.

Do not begin M3-4 by editing this document for progress; edit it only if M3-4
discovers that a frozen architecture/semantic assumption is actually wrong.

## 2. Backend capability matrix

### 2.1 The 13 semantic `Backend` properties

`Backend` has `kind` + `capabilities` + the 13 properties below
(`src/runtime/backend.ts:32-67`). The `CAPABILITIES` vocabulary has 12 names
(`src/runtime/capability.ts:18-31`); `pendingInputReader` is a semantic property
without its own capability-name entry, so the two inventories are deliberately not
1:1.

| Backend property | Port (consumer) | Direct impl | Existing Remote impl | Exact rc.2 public source | Contract disposition / last requalification | M3 owner/stage | Acceptance proof |
|---|---|---|---|---|---|---|---|
| `subagent` | `SubagentPort` (viewer prompt, Task Center interrupt) | `runtime/direct/subagent-direct.ts` | `runtime/remote/subagent-remote.ts` | `ClientRemote['subagents'].prompt` / `.interruptByParent`; `dsh-subagent/remote` (`lib/typert.remote-client.d.ts:15-16`); child catalog is the `subagentCatalog` Session projection (`dsh-subagent/lib/types/projection-types.d.ts:64-67`) | READY | M3-3A | L3 `test/remote-subagent-port.test.ts` + published-contract gate `test/remote-official-contract.test.ts:105` |
| `sessionReader` | `SessionReader` (picker list/projection/search, `/status` context row) | `runtime/direct/session-direct.ts` (+`session-search-direct.ts`, `session-projection-direct.ts`) | `runtime/remote/session-reader-remote.ts` (list/blank/projectionBatch/search) | `ISessions.list/refresh/search/binding` (`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:43-153`); `session/search`, `session/projections` Remotes | READY (M3-3A closed it) — `measureContext` reads the official `contextPressure` projection (`projectedTokens ?? pressureTokens`); the same projection face feeds `turnOutline` and the subject-neutral `sessionStatus` snapshot (`dsh-token-meter/lib/types/projection.d.ts:65-72`), **not** a new RPC | M3-3A | parity test Direct vs Remote `measureContext` on a live Session; the D1 "no Client equivalent" skip is retired here |
| `pendingInputReader` | `PendingInputReader` (queue/steering lanes) | `runtime/direct/pending-input-reader-direct.ts` | `runtime/remote/pending-input-reader-remote.ts` | `session.projections.faceOf('inbox')` (`dsh-agent/lib/types/types.d.ts:52-55`) | READY | M3-3A | L3 `test/remote-pending-input-reader.test.ts` |
| `sessionWriter` | `SessionWriter` (ordinary prompt, Ctrl+S steer, Alt+Up remove, cancel, rename) | `runtime/direct/session-writer-direct.ts` | `runtime/remote/session-writer-remote.ts` | `SessionFace.beginSubmission/prompt/updateQueue/cancel/rename` (`.../client/contract/session.d.ts:73-140`); `session/prompt\|updateQueue\|cancel\|rename` Remotes | READY. `refreshTitle` = INTENTIONAL_UNSUPPORTED_IN_M3; generic client-local file attachment needs the D4 upload receipt and fails closed before dispatch | M3-3A | L3 `test/remote-session-writer.test.ts`; D4 relief exists at `fileUploads/upload` (`dsh-client-file-upload/lib/typert.remote-client.d.ts:14`) |
| `sessionLifecycle` | `SessionLifecycle` (create/open/fork) | `runtime/direct/session-lifecycle-direct.ts` | `runtime/remote/session-lifecycle-remote.ts` | `ISessions.create/retain/fork` (`.../contract/sessions.d.ts:80/52/124`); `session.create\|fork` Remotes | READY | M3-2 (owner handoff) + M3-3A (adapter) | L3 `test/remote-session-lifecycle.test.ts`; L5 `smoke:remote-session-lifecycle-parity` |
| `interaction` (Approval) | approval prompt + session approval policy | `runtime/direct/interaction-direct.ts` | approval live request = forwarded `approval/request` **waterfall** (`dsh-api-remotes` forwarded allowlist); `setApprovalPolicy(sessionId, policy)` has **no** dedicated approval-policy Remote and no synchronous exact-equivalent carrier in rc.2 | approval presentation IMPLEMENTED over the forwarded waterfall (`RemoteInteractionPort.onApprovalRequest`); `setApprovalPolicy` = INTENTIONAL_UNSUPPORTED_IN_M3 on the Remote backend and returns `false`. The Remote `/settings` approval row is omitted/disabled rather than guessing a current value or changing the semantic port to async | M3-3B | L3 test that the forwarded approval waterfall settles through the TUI prompt; L3/L6 prove Remote `setApprovalPolicy` fails closed and the approval settings row is unavailable with no hidden Host fallback |
| `interaction` (Question) | live request, timed claim, durable continued state, queued reply, late answer, settled evidence | `runtime/direct/interaction-direct.ts` | **rc.2 publishes the full contract**: live request = forwarded `user-questions/request` **waterfall**; timed claim = `remote.userQuestions.attachWait(sessionId, callId, signal)` stream whose first frame carries Host-computed `remainingMs`; durable state = `userQuestions` Session projection (`active` open/continued + `settled` with final answers); queued late reply = `inbox` projection entries with source `kind == 'user-question-reply'` + same `callId`; late answer = `remote.userQuestions.answer(sessionId, callId, answer)` (Host `REPLY_QUEUED`/`BAD_ANSWER` taxonomy); timeout = Host `TimedQuestionWait` (timeout ≠ Turn cancellation ≠ question cancellation — a timed-out question stays durably answerable as `continued`) | READY — the M3-3B plan consumes exactly these published surfaces; no private RPC and no Direct-only fallback is permitted | M3-3B | L3 adapter contract tests + L5 same-Host wire proof for claim/countdown/continued/queued-reply/late-answer/reconnect; the structural contract gate must reject a future rc that renames or drops these surfaces |
| `catalog` | `Catalog` = `models` + `presets` + `skills` | `runtime/direct/catalog-direct.ts` | models `model-remote.ts`, presets `preset-remote.ts`, skills `skill-remote.ts` | see §2.2 | IMPLEMENTED for the session-scoped surface; the deliberately unsupported skill sub-operations (body read, live `skills/change`) are `INTENTIONAL_UNSUPPORTED_IN_M3` per §2.2 | M3-3A | per §2.2 |
| `config` | `ConfigPort` = 9 sub-domains | `runtime/direct/config-direct.ts` | `runtime/remote/config-remote.ts` (the M3-3B settings mirror + the nine sub-domains) | see §2.3 | IMPLEMENTED (M3-3B) with per-sub-domain status in §2.3: the record subset, the session approval override and the authorization sub-domain are `INTENTIONAL_UNSUPPORTED_IN_M3` and fail closed | M3-3B | per §2.3 + the M3-3B same-Host L5 qualification |
| `hostFile` | `HostFilePort` (`@`-mention discovery, send-time existence resolution, draft canonicalization) | `runtime/direct/host-file-direct.ts` | `runtime/remote/host-file-remote.ts` | session/agent-scoped `fileReferences/list(agentId, query, signal)` (`dsh-api-session-controller/lib/typert.remote-client.d.ts:40,68`; `lib/types/file-references.d.ts:24`). Sessionless/workspace-scoped discovery, and existence-based canonicalization, have **no** rc.2 expression | IMPLEMENTED for the session scope; sessionless/workspace scope + existence probe = INTENTIONAL_UNSUPPORTED_IN_M3 (fail closed, §10) | M3-3A (session scope) / M3-5 (viewer scope preference) | L3 test over `fileReferences/list`; a viewer-child prompt must resolve through the child Session identity rather than a cwd string |
| `sessionArchive` | `SessionArchivePort` (`/export`) | `runtime/direct/session-archive-direct.ts` | `runtime/remote/session-archive-remote.ts` | HTTP exact route `SESSION_LOG_EXPORT_PATH = "/api/session.export"` (`dsh-session-log-export/lib/types/routes.d.ts:7`), registered Host-side via `HostConnectionFetch.register` (`dsh-client-connection/lib/types/rpc.d.ts:128`); reference client `SessionLogDownloadController` (`.../client/controller.d.ts:44-60`) | IMPLEMENTED (M3-3B) — carrier is the composition-owned in-process `Fetch`, never `document.baseURI`; the adapter owns cancellation (rc.2 `download()` takes no signal and `dismiss()` does not abort; only `dispose()` aborts) | M3-3B | L3 + L5 archive stream test including caller abort |
| `hostCommand` | `HostCommandPort` (already-authorized Host command line) | `runtime/direct/host-command-direct.ts` | `runtime/remote/host-command-remote.ts` | `ClientRemote['commands'].execute` (`dsh-commands/remote`, the attachment-preserving path) | READY | M3-3A | L3 `test/remote-host-command.test.ts` |
| `pluginManager` | `PluginManagerPort` (Plugin Manager panel) | `runtime/direct/plugin-manager-direct.ts` | `runtime/remote/plugin-manager-remote.ts` | `ClientRemote['pluginManager']` 12 methods (`dsh-plugin-manager/lib/typert.remote-client.d.ts:25-36`) + forwarded `plugin-manager/*` events | READY | M3-5 | L3 `test/remote-plugin-manager.test.ts` |
| `jobObservation` | `JobObservationPort` (selected Job live tail) | `runtime/direct/job-observation-direct.ts` | `runtime/remote/job-observation-remote.ts` | `IJobs.watchRows/observe/kill/state` (`dsh-api-job-controller/lib/types/client/service.d.ts:45-71`); `job/list\|follow\|kill` Remotes | READY | M3-5 | L3 `test/remote-job-observation.test.ts` |

`BackendKind` gains `remote` **only** in M3-3B, and only together with a Remote
assembly that advertises exactly the capabilities it serves
(`docs/client-server-migration.md` §Hard invariants). M3-0 does not add it.

### 2.2 `catalog` decomposition

| Sub-domain | Port methods | Exact rc.2 public source | Disposition / last requalification | Gap / owner |
|---|---|---|---|---|
| `ModelCatalog` | `loadDirectory`, `defaultSelection`, `sessionSelection`, `selectSessionModel` | `session/modelCatalog`, `session/selectModel` Remotes; `modelSelection` projection (`dsh-api-session-controller/lib/types/types.d.ts:20-27`) | READY (adapter exists) | — |
| `ModelCatalog` | `discoverModels` | `llm/discoverModels(settingsNs, request, signal)` (`dsh-llm/lib/typert.remote-client.d.ts`) | READY (M3-3A adapter) | the add-provider wizard probe maps to the official Remote; a Host failure must surface, never an empty list |
| `ModelCatalog` | `listProviders`, `listModels` | `llm/listProviders` exists, but `llm.listModels(provider)` is a **Host method with NO public Remote** (0.2.0-rc.1, §1.1 correction) | RETIRED_CROSS_BACKEND_API (M3-3A) | the subagent allowlist picker — the only consumer — now consumes the official `session/modelCatalog()` grouped directory (`loadDirectory`); the port-level per-provider discovery pair was removed rather than kept as a Direct-only shape. No private `llm/listModels` RPC may ever back it |
| `ModelCatalog` | `saveDefaultSelection` | **no Remote write exists or is wanted**: a sessionless `/model` default change has no Remote expression; the live-Session `selectSessionModel` write already carries the Host's best-effort global-default save | INTENTIONAL_UNSUPPORTED — `runtime/remote/model-remote.ts` returns an explicit `unsupported` `WriteOutcome` (never a local success, never a second TUI global-default write); locked by `test/remote-model-port.test.ts` | M3-3A → corrected 2026-10-02 (PR5): this row previously claimed an adapter-owned settings write, which contradicted the adapter, the port contract, and `docs/client-server-migration.md` |
| `PresetCatalog` | `available`, `roster`, `defaultId`, `resolve`, `selectSessionPreset` | `agentPresets/list\|read\|select` (`dsh-agent-preset-registry/lib/typert.remote-client.d.ts:16-18`); `agentPreset` projection (`lib/types/types.d.ts:57-60`) | READY (adapter exists) | `resolve` is roster-backed in `runtime/remote/preset-remote.ts` — an explicit id must exist in the Host roster, an omitted one resolves the Host-effective default, and both the unknown id and the default-less deployment are covered by `test/remote-preset-port.test.ts` |
| `SkillCatalogCapability` | `listHumanSkills` | `skills/list({sessionId}, signal)` (`dsh-api-session-controller/lib/typert.remote-client.d.ts:37,60`; `lib/types/types.d.ts:245-258`) | IMPLEMENTED — `runtime/remote/skill-remote.ts` (Session-scoped read, generation-fenced) | one mapping; `RemoteSurfaceAuthorityReader` already proves the shape |
| `SkillCatalogCapability` | `standing(presetId, cwd)` (sessionless) | **not found** — every skills endpoint is Session-addressed | INTENTIONAL_UNSUPPORTED_IN_M3 | deferred-start skill completion only; owner M3-3A, fail closed |
| `SkillCatalogCapability` | `resolveSkill(name)` (skill body) | **not found** — `skills/list` has no body; there is no `skills/read` | INTENTIONAL_UNSUPPORTED_IN_M3 | the Remote branch never loads/injects a skill body client-side. Human skill gestures stay literal and Host-owned; the `dsh-tool-skill` pre-step performs the body injection for the supported pi-tui composition. Owner M3-3A/M3-4 |
| `SkillCatalogCapability` | `hostLoadsSkillBody(sessionId)` | no rc.2 wire capability bit. For M3's supported in-process pi-tui Host, the generated official preset compositions are a **composition invariant** and mount `@deepseek-ai/dsh-tool-skill` | RESOLVED_COMPOSITION_CONTRACT | M3-1 proves the supported preset compositions carry `tool-skill`; the Remote adapter consumes a composition-owned fact, never probes a hidden Host service. M5/external attach MUST NOT reuse this in-process assumption and fails closed unless a public capability exists |
| `SkillCatalogCapability` | `onSkillsChange(listener)` | Host `skills/change` exists, but rc.2 deliberately does **not** include it in the forwarded Remote-event allowlist; `$on('skills/change')` is not a legal Client event | INTENTIONAL_UNSUPPORTED_IN_M3 | no private forwarding RPC/event. Remote skill catalogs are strongly re-read on Session/binding entry, explicit `/reload`, and `connection/reset`; a live provider-only change between those boundaries may leave autocomplete stale, but execution never injects a stale Client-side body and Host authority decides the gesture. Owner M3-3A/M3-4 |

### 2.3 `ConfigPort` decomposition

| Sub-domain | Port methods | Exact rc.2 public source | Disposition / last requalification |
|---|---|---|---|
| `tuiSettings` | `get()`, `replace(doc)` | read `settings/describe()` → `SettingsDescribeValue{namespaces[].value/base/user/revision}` (`dsh-settings/lib/types/types.d.ts:18-63`); write `settings/replace(ns,section,expectedRevision)` / `update` / `mutate` (`dsh-api-settings-controller/lib/typert.remote-client.d.ts:28-32`); invalidation = `settings/document-updated` plus official `connection/reset` | IMPLEMENTED. **Frozen sync/async bridge:** the adapter owns one serialized Client-local mirror. It installs BOTH invalidation listeners **before** the first `settings/describe()`, commits the first snapshot before Remote-backend readiness, reruns on `settings/document-updated` and after every `connection/reset`, and uses an invalidation/generation counter so a describe result that raced an invalidation is discarded and re-read before becoming current. `get()` returns the last committed snapshot synchronously; it may remain the last-known display value while a reconnect refresh is in flight, but it can never become the post-reconnect authoritative revision until the rerun commits. `replace()` waits for a current mirror/revision, performs the Host write, then forces/awaits a serialized describe refresh instead of optimistically mutating the mirror. No event is assumed to replay across disconnect. **IMPLEMENTED** in `runtime/remote/config-remote.ts`. |
| `footerCommandTrust` | USER-layer mode + trusted command + activation id sets | `settings/describe()` `user` layer per namespace; the TUI's own trust validator stays client-side | IMPLEMENTED |
| `footerCustomItems` | `get()`, `rawForPersistence()` | same USER-layer `user` value | IMPLEMENTED |
| `providers` | `available`, `listCredentialOptions`, `writeProfile`, `writeKeylessProfile` | `llm/listConfigurableProviders` (`dsh-llm/lib/typert.remote-client.d.ts:16`) + `settings/update\|replace` on the adapter-owned profile namespace | IMPLEMENTED |
| `credentials` | `available`, `setReference`, `unsetReference`, `describeReference`, `onChanged` | `credentials/set\|unset\|describe` (`dsh-api-settings-controller/lib/typert.remote-client.d.ts:25-27`); `credentials/reference-updated`, `credentials/record-updated` forwarded events (`dsh-api-remotes/lib/types/remote-events.d.ts:43-47`) | IMPLEMENTED for the reference subset (`recordsSupported() === false` exposes the record read/delete gap as a capability, never as an empty list) |
| `credentials` | `listRecords()`, `deleteRecord(key)` | **not found** — no `credentials/list`, no record delete; the key grammars are disjoint (`dsh-credentials/lib/types/types.d.ts:86-88`) | INTENTIONAL_UNSUPPORTED_IN_M3 — only `/logout` record enumeration/deletion is affected; owner M3-3B, fail closed with an explicit notice |
| `authorization` | `available`, `listTargets`, `begin`, `onEvent`, `respond`, `cancel` | **not found** — `dsh-authorization` publishes no `./client`/`./remote`/`./typert`; no `authorization` namespace and no authorization event in the forwarded allowlist | INTENTIONAL_UNSUPPORTED_IN_M3 — provider sign-in flows (`/login` device/OAuth path) are unavailable on the experimental backend; the API-key path still works through `credentials/set`. Owner M3-3B, fail closed with an explicit notice. Closest public relief: `account/startSignIn\|cancelSignIn` (a different, DeepSeek-account semantic) |
| `permissions` | `presetNames`, `defaultPreset`, `setDefaultPreset`, `applyPermissionPreset`, `approvalOverrideOf` | `permissionPresets/catalog()` (`dsh-permission-presets/lib/typert.remote-client.d.ts:13`) supplies selectable/default preset metadata; the public per-session `permissions` projection exposes **only** `PermissionSelection.currentValue` (`dsh-permission-presets/lib/types/types.d.ts:35-57`); preset apply = `commands/execute` of the official `/permission <preset>` line; default = settings. rc.2 exposes no public Client read for the independent session `approval/policy` override | IMPLEMENTED for preset catalog/default/apply. `approvalOverrideOf(sessionId)` = INTENTIONAL_UNSUPPORTED_IN_M3 on Remote and returns `undefined` only as “unavailable”, never as evidence that the effective policy is `ask`; Remote UI MUST hide/disable the session approval row instead of applying `?? 'ask'` — `approvalOverrideAvailable() === false` is the semantic capability the UI reads |
| `presetDefault` | `available`, `get`, `set` | `agentPresets/list` default + `settings/*` on `agent-preset-registry.selectedDefault` | IMPLEMENTED |
| `subagentModelSelection` | `available`, `get`, `set` | `settings/describe` + `settings/update\|replace` on the exact official namespace `subagent-model-selection-settings` (the `subagent-model-selection` service owns it Host-side) | IMPLEMENTED |

### 2.4 Official Host + Client composition closure

**Frozen decision: strategy B — the TUI owns one explicit minimal composition.**
It mounts only the official Host plugins, Client plugins and generated `/remote`
contributions required by the TUI contract. The
`@deepseek-ai/dsh-api-remotes/client` aggregate assembly is **not** the
production assembly.

This is also the M3/M4 portability boundary: M3 runs the composition in process;
M4 moves the same Host composition behind a local process carrier. Business API
shape does not change when placement changes.

Narrow clarification (2026-10-03 amendment): the §2.4 closure is the CURRENT M3
CORE dependency closure for the rc.2 TUI contract. It is **not** a universal
registry requiring every optional future feature Remote to be centrally owned by
`RemoteClientRuntime`. A future optional feature may own its generated
contribution lifecycle only after that feature is adopted and its public
contract exists on the selected released DSH baseline; such a contribution must
reuse the existing Connection/Gateway and may not duplicate a core
namespace/authority. No current row changes.

#### 2.4.1 Host composition closure

M3-1 adds `src/app/remote/host-runtime.ts`, owned by the dynamically imported
Remote runtime. It mounts the additive official Host plugins onto the existing
DSH Host Context **only while the experimental Remote composition is alive** and
disposes them in reverse order. `cordis.patch.yml` remains unchanged in M3-1;
there is therefore no hidden Loader flag or production Direct row to keep in
sync. The M3-4 internal runtime-selection seam becomes the sole authority that
can construct this owner. Tests may construct it directly.

The existing base/TUI Host already supplies the ordinary domain services,
`credentials`, `typert`, `typertGateway`, commands, sessions/projections,
attachments, workspace and the TUI's existing `job-controller` row. M3-1 MUST
not mount a second job controller. The additive closure is:

| Order | Official Host plugin | Why it is required / dependency closure |
|---:|---|---|
| 1 | `@deepseek-ai/dsh-client-connection` | provides Host `connection`; its Host entry injects `credentials`; no WebServer is required for the in-process RPC carrier |
| 2 | `@deepseek-ai/dsh-client-file-upload` | provides Host `fileUploads`; injects `agents`, `attachments`, `commands`, `connection`; required by the Session controller even though generic TUI attachment UX remains fail-closed until D4 |
| 3 | `@deepseek-ai/dsh-session-stats` | registers the durable whole-log `sessionStats` projection used by the Remote command/status metrics facade; the base bundle supplies `sessionProjections` but does **not** mount this Web-owned projection unit |
| 4 | `@deepseek-ai/dsh-session-turn-outline` | registers the whole-log `turnOutline` projection used by `/rewind` and explicit deep-history navigation; it keeps every turn addressable without hydrating the complete event log |
| 5 | `@deepseek-ai/dsh-api-session-controller` | provides Session/skills/file-reference Remotes and the Session Client's Host authority; its Host injection includes `fileUploads`; it exposes the projections registered in the preceding rows through normal Session snapshots/updates |
| 6 | `@deepseek-ai/dsh-api-settings-controller` | provides settings/credentials Remotes used by `ConfigPort` |
| 7 | `@deepseek-ai/dsh-api-remotes` | registers the forwarded-event allowlist used by approval/questions/settings/credentials/etc.; reuses the base `typertGateway` |
| 8 | `@deepseek-ai/dsh-session-log-export` | registers `SESSION_LOG_EXPORT_PATH = /api/session.export` on Host `connection.fetch`; without this row `SessionArchivePort` has a client carrier but no Host route |

`@deepseek-ai/dsh-api-job-controller` is part of the required Host capability
set but is **reused** from the already-mounted TUI row (`jobController`); the
M3 owner asserts it exists and never duplicates it. The same rule applies to
the rc.2 user-questions service: `@deepseek-ai/dsh-base` already mounts
`id: user-questions -> @deepseek-ai/dsh-user-questions`, and the pi-tui bundle
layers on that base without disabling it, so the M3 composition **reuses**
`userQuestions` (asserted as a prerequisite, with the stable Typert binding
identity verified before/after) instead of adding a second row. A second mount
would replace the namespace owner and duplicate the `userQuestions` Session
projection unit.

This table is dependency-closed: `session-controller` is not allowed to be
mounted with a test-only `fileUploads` stand-in, and the archive adapter is not
considered available unless `session-log-export` is mounted. Existing smoke
fixtures that manually `provide('fileUploads', ...)` or `provide('fileUpload',
...)` are dependency-isolation tests, not proof of the product composition.

Composition-ownership rule (2026-10-03 amendment): generated Remote availability
does not choose Host composition ownership. `RemoteHostRuntime` owns the current
M3 additive Host closure because those rows are required by the M3 core graph; a
future feature-owned Host plugin remains owned by that feature unless a separate
accepted architecture change promotes it into base/common/core composition. No
current row is added, removed or reclassified.

#### 2.4.2 Client generated Remote contributions

The generated contribution list remains explicit: it is the **current M3 core
generated contribution closure** for the rc.2 TUI contract (2026-10-03
clarification), not an implied list of every Remote the TUI may ever consume or
mount. Every row is a public `./remote` native-ESM subpath and is mounted by the
Client runtime owner `RemoteClientRuntime`:

| Contribution | Namespaces gained | Consumed by |
|---|---|---|
| `@deepseek-ai/dsh-api-session-controller/remote` | `session`, `skills`, `fileReferences` | lifecycle, reader, writer, pending input, skill catalog, surface authority, host file |
| `@deepseek-ai/dsh-api-job-controller/remote` | `job` | `IJobs` / job observation |
| `@deepseek-ai/dsh-commands/remote` | `commands` | Host command port, surface authority, permission apply |
| `@deepseek-ai/dsh-subagent/remote` | `subagents` | subagent port, viewer prompt |
| `@deepseek-ai/dsh-agent-preset-registry/remote` | `agentPresets` | preset catalog |
| `@deepseek-ai/dsh-plugin-manager/remote` | `pluginManager` | plugin manager port |
| `@deepseek-ai/dsh-user-questions/remote` | `userQuestions` | `QuestionInteractionPort` (live waterfall, `claimTimedWait`, `answerContinued`) plus the `userQuestions` Session projection the surface reconciles from |
| `@deepseek-ai/dsh-api-settings-controller/remote` | `settings`, `credentials` | `ConfigPort` (settings/credentials) |
| `@deepseek-ai/dsh-permission-presets/remote` | `permissionPresets` | `ConfigPort.permissions` |
| `@deepseek-ai/dsh-llm/remote` | `llm` | provider directory / discovery |
| `@deepseek-ai/dsh-client-file-upload/remote` | `fileUploads` | official Client file-upload service required by the Session Client |

Why not the aggregate:

- the aggregate mounts namespaces the TUI does not call (terminal, office/PDF,
  schedule, dynamic Cordis runner, message feedback, ...);
- it pulls declaration dependencies outside the TUI's intended module closure;
- it is itself a browser module-loader bundle, while the selected `/remote`
  contributions are plain native ESM;
- owning the list here is what lets M4 move the same composition without
  redefining product capabilities.

#### 2.4.3 Client plugin order and the rc.2 bundle shim

The in-process Client Context mounts in this order:

```text
typert registry
  -> Connection (installConnection + explicit composition-owned transport:
     fetch = Host createSharedFetchHandler('/api') adapter,
     openStream = Host typertGateway.wireStream.open adapter, ownsHost: true)
  -> API Gateway
  -> explicit /remote contributions
  -> Client fileUpload service
  -> Client Sessions
  -> Client Jobs
  -> TUI Remote backend/application adapters
```

The `fileUpload` service is a **composition dependency**, not permission to
silently enable generic attachment UX. M3 keeps the D4 attachment class
fail-closed until the upload-receipt transaction is intentionally surfaced.

rc.2 publishes the following six required Client plugin entries as
`platform: web` `lib/client.js` module-loader bundles. These are the complete
allowlist for the scoped Node shim in M3-1:

| Public Client entry | Role in M3 | Shim-required |
|---|---|---:|
| `@deepseek-ai/dsh-typert-registry/client` | Client `ctx.typert` registry | yes |
| `@deepseek-ai/dsh-client-connection/client` | Connection generation/state and public `installConnection` | yes |
| `@deepseek-ai/dsh-api-gateway/client` | `ctx.remote`, streams/events, contribution mount API | yes |
| `@deepseek-ai/dsh-client-file-upload/client` | provides `ctx.fileUpload`, required by Session Client | yes |
| `@deepseek-ai/dsh-api-session-controller/client` | `ctx.sessions`, `SessionReference`/`SessionBinding` | yes |
| `@deepseek-ai/dsh-api-job-controller/client` | `ctx.jobs` | yes |

The shim is deliberately **not** a general Web runtime. `client-runtime.ts`
installs a temporary `window.__ModuleLoader__.load` registry only around these
exact dynamic imports, rejects an unknown bundle id or duplicate definition,
instantiates the captured factories in dependency order, and restores the
previous global in `finally`/dispose. `/remote` contributions never pass through
the shim. No `document`, `navigator`, WebSocket or global fetch fallback is
allowed on the in-process path.

Dependency declarations follow the normal repository rule: every
`@deepseek-ai/*` package imported by `src/` must be a declared peer (and an
exact dev/test dependency where the repository's compatibility policy requires
it). M3-1 therefore makes the runtime composition closure explicit in
`package.json`: `dsh-client-connection`, `dsh-client-file-upload`,
`dsh-api-gateway`, `dsh-api-job-controller`, `dsh-api-settings-controller`,
`dsh-api-remotes`, `dsh-session-stats`, `dsh-session-turn-outline`, and
`dsh-typert-registry` are peers at
the supported DSH floor and exact rc.2 dev/test dependencies, unless already
declared in the appropriate section. The root must never rely on one of these
only as a transitive dependency of `dsh-api-remotes` or another DSH package.

Forwarded Host events consumed by the TUI come from the mounted
`@deepseek-ai/dsh-api-remotes` Host row: `approval/request` (waterfall),
`user-questions/request` (waterfall), `credentials/reference-updated`,
`credentials/record-updated`, `settings/document-updated`,
`permission-presets/catalog-changed`, `llm/adapters-updated`,
`agent-preset/selected`, `plugin-manager/changed|install-log|install-state`,
`goal/activation-changed`, `api-session/activity|added|error|removed|status`, and
`commands/change`. `skills/change` is intentionally **not** in that allowlist in
rc.2; §2.2 freezes the resulting M3 behavior rather than inventing a private
forwarder.

#### 2.4.4 Composition ownership inventory (frozen)

For every Host/Client service that materially affects M3 composition, this
contract freezes its locality, composition owner, consumer, reuse-vs-additive
rule and duplicate-mount prohibition. Owner classes:

```text
BASE_HOST_PREREQUISITE   owned by ordinary DSH/base/profile composition;
                         migration code may require/read/adapt/verify identity
                         but MUST NOT mount a second copy
M3_ADDITIVE_HOST         a Host contribution genuinely added by the M3
                         composition contract; it may mount only the rows frozen
                         in §2.4.1
GENERATED_CLIENT_REMOTE  official Client-side generated Remote/service
                         contribution; the TUI consumes it and never
                         reconstructs its namespace object
CLIENT_LOCAL             terminal/editor/clipboard/draft/overlay/keybinding/
                         local-shell/UI extension state; no Host semantic
                         coupling is invented for it
```

| Domain/service | Class | Composition owner | Consumer | Reuse vs additive mount | Duplicate-owner rule |
|---|---|---|---|---|---|
| `userQuestions` Host service | `BASE_HOST_PREREQUISITE` | `@deepseek-ai/dsh-base` (row `user-questions`) | `InteractionPort` (Direct + Remote) | reuse; `RemoteHostRuntime` asserts presence and verifies the stable Typert binding identity before/after | never mount a second `UserQuestionService`: it would replace the namespace owner and register the `userQuestions` projection unit twice |
| `userQuestions` Client Remote | `GENERATED_CLIENT_REMOTE` | official client contribution (`@deepseek-ai/dsh-user-questions/remote`) | `QuestionInteractionPort` + the `userQuestions` Session projection | additive Client contribution; identity preserved | never rebuild/copy the generated namespace object |
| `configEditor` | `BASE_HOST_PREREQUISITE` | profile/base composition when `profileContext` enables the config plane | `ConfigPort` settings mirror | reuse | `RemoteHostRuntime` must not mount it to satisfy Remote composition |
| `settings` | `BASE_HOST_PREREQUISITE` | profile/base composition | Remote Config adapter over the generated `settings` Remote | reuse | no second settings authority or namespace |
| `jobController` | `BASE_HOST_PREREQUISITE` | the existing TUI row | `JobObservationPort` | reuse | no second job observation authority |
| M3 Host API/session helper rows | `M3_ADDITIVE_HOST` | `RemoteHostRuntime` (§2.4.1) | the M3 adapters | additive, §2.4.1 only | mount only the frozen additive closure |
| TUI Task Center / Question presentation | `CLIENT_LOCAL` | TUI application surface | user-facing surfaces | n/a | presentation over semantic authority; never becomes Host authority |

The exact package/row names may evolve; the ownership class and the
duplicate-owner rule may not.

#### 2.4.5 Wire-shape invariants (frozen)

These are permanent M3 correctness constraints that apply to every lifetime and
composition change governed by this contract:

```text
generated Remote namespace object identity is preserved
prototype accessors are not copied via object spread
receiver-sensitive event methods are passed method-bound
one Client runtime owns one semantic assembly
base-owned service namespace/projection ownership is never replaced by additive M3 composition
```

The normative statements and forbidden forms are recorded in
`docs/client-server-migration.md` §Hard invariants; the detailed coupling and
composition-owner inventory is in `docs/client-server-coupling.md`; qualification
evidence is in `docs/client-server-migration.md`.

## 3. Non-Backend application seams

These seams are deliberately **outside** `Backend` and outside the capability
vocabulary (`src/runtime/backend.ts:33-67`, `src/runtime/capability.ts:18-31`).
Several already have complete, contract-proven Remote adapters, so M3 work here is
composition rather than adapter building. This inventory includes command-runtime
facts as well as presentation/status/viewer facts; a Direct-only fact may not be
left implicit merely because it is not a `Backend` property.

### 3.1 Presentation / status / secondary-surface seams

| Seam | Consumer | Existing Remote adapter | Required Remote/public source | Status | M3 stage |
|---|---|---|---|---|---|
| `PresentationReader` | `src/app/surface/session-presentation.ts:74-82` (injected Direct facts) | `runtime/remote/presentation-read-remote.ts` (READY) | `SessionBinding.eventSource` + `SessionFace` snapshot + `loadOlder()` | IMPLEMENTED (M3-4 PR2/PR4: the application seam consumes the reader for hydrate/rehydrate, history paging, `loadThrough`, stats/last-assistant paging) | M3-4 |
| rewind candidate / deep-history source | `openRewindPicker` → `collectRewindCandidates(session.snapshotEvents())` today | none | whole-log `turnOutline` projection for candidate identity/preview + `SessionFace.loadThrough(seq)` only when the selected/visible turn needs its loaded events; exact binding-generation fence around the operation | IMPLEMENTED (M3-4 PR4: picker authority = `turnOutline`, detail = official `loadThrough`, the picker-open transport identity is captured once and re-checked before the fork; review round 2 closed the re-capture hole) | M3-4 |
| tool-card presentation | `bootstrap.ts` resolves `ctx.tools.get(name, liveAgent)` and calls Host `ToolDefinition.presentCall/presentResult` | none | Client derives cards from raw durable/transient `tool/call` + `tool/result` fields and persisted metadata/content; Host presenter callbacks never cross the Client contract. TUI/extension renderers stay Client-owned; unknown/custom tools use the existing bounded generic/raw fallback | IMPLEMENTED (M3-4 PR4: `createClientToolPresenter` derives edit/patch/terminal cards from raw facts; the Host registry lookup itself is now DIRECT-ONLY — PR4 review round) | M3-4 |
| image draft / prompt preparation | `bootstrap.ts` reads `ctx.attachments.imageLimits`, `ctx.attachments.saveImages`, `ctx.llm.resolveModelInfo` during Direct preparation | none | Client-local draft bytes + safety caps; after a Session exists, validate against the Session `imageLimits` projection when available and serialize official `PromptContentPart {type:'image', mediaType, data, name?}`. Host `session/prompt` owns durable admission and model-modality refusal | NEEDS_APPLICATION_SEAM | M3-4 |
| durable Session image read | `surface.start(...readImage)` calls Host `ctx.attachments.readImage(ref)` | none | official `session/attachment({sessionId, attachmentId})`, addressed by the exact main/child Session and fenced by binding generation. Recalled images that need re-send bytes use the same authorized read before prompt serialization. **M3-5 PR2 scope note:** the read authority belongs to the attachment ref's OWNING PRESENTATION, not to the ambient display subject: `TuiApp` stamps each `ImageThumbnail` with the presentation scope sampled ONCE at construction, the component keeps it IMMUTABLE, and the loader keys bytes/in-flight/errors/subscribers by `(scope, attachmentId)`. The scope is a lifetime token (main owner generation | child viewer generation, carrying the Session id), so a same-id binding rollover is a new scope and a stale component of a replaced presentation fails closed against its OWN released binding instead of asking the parent. This mirrors the official Web client's `WeakMap<SessionBinding, …>` history-image cache | IMPLEMENTED (M3-5 PR2) | M3-4 main / M3-5 child viewer |
| user `!` / `!!` execution + interrupt | IMPLEMENTED (M3-4 PR3): `app/submission/user-shell.ts` consumes the injected `HostUserShellPort` (Direct adapter: bypass spawn + dsh-shell sandbox, fail-closed when absent; Remote adapter: truthful unavailable) and cancels the Session turn through the semantic `SessionWriter.cancel` under a live-scope admission | Direct adapter + truthful-unavailable Remote adapter | **Shell amendment (M3-4 PR3)**: `!` and `!!` are BOTH Host-side user-shell operations; they differ ONLY in whether the completed result enters Session/model context (`!` submits through `SessionWriter`; `!!` stays presentation-only). `bypass`/`sandbox` are Host execution policies, not locality choices. The gesture/editor/card/presentation stays Client-owned; execution (cwd/PATH/env/shell discovery/process lifetime/exit/cancellation) is Host-owned behind `HostUserShellPort`. Direct executes through the Direct Host adapter (in-process; spawn lives behind adapter ownership); currentness = exact Session/binding generation; the turn cancel uses semantic `SessionWriter`. `!!` means Session/model-EXCLUDED, never sessionless: with no current Session the TUI ensures one first and executes in that Session's Host workspace, persisting the input history under that Session identity | IMPLEMENTED (Direct adapters + Remote truthful-unavailable fail-closed; the Remote CARRIER_GAP itself is the open U11a/U11b carrier debt, NOT a missing application seam) | M3-4 |
| legacy TUI settings migration bootstrap | `bootstrap.ts` calls `migrateLegacySettings()` with Host `profileContext.home`/`$DSH_HOME`, Host SettingsForms and Host `agentPresets.resolve()` before compose/resume | none (and none required) | this is a **Host-local one-shot data migration**, not a Client Remote capability. It remains on the Host side of the bundle and must settle before the first Remote settings mirror/readiness and before any Session compose/resume | RESOLVED_COMPOSITION_CONTRACT — the Client never opens its own `$DSH_HOME/settings.yaml(.imported)` and never resolves a legacy preset locally | M3-1 ordering; consumed by M3-3B readiness |
| `TaskReader` | `src/task-browser-runtime.ts`, `src/app/surface/runtime.ts:279-305` | `runtime/remote/task-read-remote.ts` (READY) | `projectionsBySession.subagentCatalog` + `IJobs.watchRows`. **Corrected in M3-5 PR2** (implementation-time capability audit): there is no dedicated Client descendant-list carrier, but the full descendant tree is NOT an upstream gap — the official parent `subagentCatalog` projections already carry the authoritative recursive membership, so the Remote adapter reproduces the official descendant semantics (`parentId`/`depth`/stable pre-order/`mode`/`hasChildren`, branch-scoped `corrupt`/`unavailable` diagnostics) by consuming them recursively, with the documented rc.2 diagnostic-taxonomy carrier limitation (`gateway/internal` cannot express `corrupt`; it maps to `unavailable`) | IMPLEMENTED (M3-5 PR2) | M3-5 |
| `SurfaceAuthorityReader` | shadow only today | `runtime/remote/surface-authority-remote.ts` (READY) | `commands/list` + `skills/list` | IMPLEMENTED (M3-4 PR4: the command surface's live catalog read runs through `RemoteCommandSource`; review round 2 added the §16 exact-binding fence) | M3-4 |
| `SubmissionPresentation` | `src/app/submission/controller.ts:431` (hardwired Direct) | `RemoteSubmissionPresentation` (`src/submission-presentation.ts:129-161`) | official `SessionSnapshot.pendingSubmissions` (`.../client/contract/snapshot.d.ts:58-61`) | IMPLEMENTED (M3-4 PR2: `RemoteSubmissionPresentation` is the only optimistic identity on the Remote submission path) | M3-4 |
| Assistant transient stream | `src/app/bootstrap.ts:1961-1969`, `session-presentation.ts:317`, `viewer-runtime.ts:400` | **no port/installer**; reconstructed by `RemotePresentationReader.liveInputs` | `SessionBinding.eventSource` transient entries (`AssistantLiveChunkEvent`, `SessionEventSource.subscribe`); identity = binding generation, never an Agent object | IMPLEMENTED for the MAIN surface (M3-4 PR2: the official eventSource ingress feeds transient chunks through the shared pipeline; the child viewer stays M3-5) | M3-4 (main) / M3-5 (viewer) |
| main Session binding/projection source | `src/app/bootstrap.ts:390-412`, `src/app/session/**` | `SessionHandle.client` + `acquireMainSurfaceReference` / `pinExistingGeneration` | `SessionOwnerRef` → `SessionBinding` map | NEEDS_APPLICATION_SEAM | M3-2 |
| viewer child binding/projection source | `src/app/surface/viewer-runtime.ts:58-64,216-237` | `RemoteTaskReader` catalog + `RemotePresentationReader` + `RemoteSubagentPort` | child binding generation + Session id (never `sessionId` alone) | NEEDS_APPLICATION_SEAM | M3-5 |
| status: current session/model | `status-runtime.ts:196-249` | `RemoteModelCatalog.sessionSelection()` | `modelSelection` projection + Client list `cwd` | IMPLEMENTED (M3-4 PR2/PR4: the Remote status owner reads the official projections) | M3-4 |
| status: cwd/workspace | `status-runtime.ts:171,254-261` | `RemoteSessionReader.list()` row `cwd` | Client list/binding `cwd`; git branch stays Client-local | IMPLEMENTED (M3-4 PR2: the workspace fact is the official session row; an unknown live-session cwd renders empty, never the Client cwd) | M3-4 |
| status: preset/composition | `status-runtime.ts:244-248` | `RemotePresetCatalog` | `agentPreset` projection | IMPLEMENTED (M3-4 PR2/PR4: projection-backed composition facts) | M3-4 |
| status: permission preset | `status-runtime.ts:302-414` | `RemoteConfigPort.permissions` | public `permissions.currentValue` projection + `permissionPresets/catalog` for label/options | IMPLEMENTED (M3-4 PR4: projection-authoritative row + ConfigPort cycle) | M3-3B / M3-4 |
| status: independent sandbox mode | `status-runtime.ts:302-414` currently calls Host `sandboxPolicy.resolve({session})` | none | **no public rc.2 Client view** of the effective session sandbox mode/deployment default; Host `sandboxMode` is internal projection state, not a public `SessionProjectionMap` value | INTENTIONAL_UNSUPPORTED_IN_M3 — omit this structured fact on Remote; never infer it from a preset name/currentValue | M3-4 |
| status: independent approval override | `status-runtime.ts:302-414` currently calls Host `approval.overrideOf(session)` | none | **no public rc.2 Client read** of the last `approval/policy` override; public `permissions` projection exposes only preset `currentValue` | INTENTIONAL_UNSUPPORTED_IN_M3 — omit this structured fact on Remote; the `/settings` session-approval row is disabled/hidden | M3-3B / M3-4 |
| permission-cycle action (`Shift+Tab` / `app.permission.cycle`) | `status-runtime.ts` currently calls Host `permissionPresets.set(session, next)` synchronously | none | current preset = public `permissions.currentValue`; selectable order = `permissionPresets/catalog`; write = `ConfigPort.permissions.applyPermissionPreset(sessionId, next)` → official Host command carrier | IMPLEMENTED (M3-4 PR4: projection-authoritative current value + ConfigPort write + owned async cycle with admission transport fence; review round 2 kept post-dispatch indeterminate observable) | M3-4 |
| status: plan | `status-runtime.ts:337-339`, `session-presentation.ts:332` | none | `plan` projection (`dsh-plan-mode/lib/types/types.d.ts:42-45`) | NEEDS_ADAPTER | M3-4 |
| status: goal | `status-runtime.ts:485-503` | none (fold) | `goal` projection / `goal/change` durable events | NEEDS_ADAPTER | M3-4 |
| status: todos | `tui-app.ts` todo dock | none (fold) | `todos` projection (`dsh-tool-todo/lib/types/types.d.ts:38-45`) | NEEDS_ADAPTER | M3-4 |
| status: usage/tokens | `status-runtime.ts:341` | none (fold) | `tokenUsage` projection (`dsh-token-meter/lib/types/projection.d.ts:65-67`) | NEEDS_ADAPTER | M3-4 |
| status: context pressure/window | `status-runtime.ts:298-445` | `measureContext` maps the official `contextPressure` projection off the exact retained binding (`runtime/remote/session-reader-remote.ts`) | `contextPressure` / `contextBreakdown` projections (`dsh-token-meter/lib/types/projection.d.ts:68-72`) | IMPLEMENTED; an unretained Session or an absent generation reports `undefined` (no invented token-meter call) | M3-3A |
| status: host/profile facts | `status-runtime.ts:268-271` | n/a | Client-local process facts | READY (Client-local) | — |
| status: running/activity | `tui-app.ts` activity projection | Client list `running` bit | folded event window + Client `running`; task counts follow M3-5 | NEEDS_APPLICATION_SEAM | M3-4 / M3-5 |

### 3.2 Command runtime facts (previously omitted)

`src/app/command/runtime.ts` deliberately hides Direct objects behind
`CommandRuntimeSurface`, but the surface itself is still a migration contract.
M3-0 freezes every hook below; M3-4 must not satisfy any of them by resolving a
Direct Agent/Session behind the Remote path.

| `CommandRuntimeSurface` hook | Current Direct source | Frozen Remote/application replacement | Stage / acceptance |
|---|---|---|---|
| `listScopedCommands()` | Host command registry via the Direct composition | `RemoteSurfaceAuthorityReader` / `commands/list`, keyed by the current live Session scope; completion synthesis stays Client-local | M3-4; command claim/collision parity. **Host-origin semantics (PR5 v4 §1C-3/§1C-4)**: this read is the EFFECTIVE WINNER view, and Host ORIGIN is that view minus this surface's own Direct compatibility mirrors (identified by the exact registered `definitionId`). Raw registry membership is never Host authority on its own; a same-name Agent-scoped genuine Host definition is the complete effective descriptor and must not be subtracted. `definitionId` is provenance/discovery metadata, never authorization. |
| `sessionRunning(sessionId)` | exact Direct Agent `.status` | exact `SessionBinding`/`SessionSnapshot.running`; currentness is the existing `SessionScopeAuthority` + binding-generation fence | M3-4 |
| `sessionRouting(sessionId)` | Direct Agent `options.provider/model` + `session.header.cwd` | provider/model from `modelSelection` projection; cwd from Client Session list/binding | M3-4 |
| `approvalOverride(sessionId)` | `ConfigPort.permissions.approvalOverrideOf` (already semantic) | Remote `ConfigPort` returns `undefined` as an **unavailable exact override read**; M3-4 must not interpret that as `ask` and must omit/disable the only consumer row that needs the exact override | M3-3B, consumed by M3-4; fail-closed settings-row test |
| `sessionStats(sessionId)` | `computeStats(directSession.snapshotEvents())` | one Remote metrics facade: lifetime `turns/steps/llmMs` from official `sessionStats`, token/cache totals from `tokenUsage`, `contextWindow` from the context projections, and the TUI's deliberately recent TTFT/TPS from the exact binding's durable+transient window. If fewer than the required recent valid samples are loaded, page older history only until the recent window is complete or history-start is reached; never scan the whole log for lifetime totals | M3-4; Direct-vs-Remote `SessionStats` parity fixture |
| `lastAssistantText(sessionId)` | Direct Session event scan | exact binding `eventSource`; search the loaded window newest-first and call `loadOlder()` until an assistant message is found or history-start is proven | M3-4; cold-resume + paged-history test |
| `refreshLiveCatalog(sessionId, source)` | `CatalogRefreshCoordinator` captures the exact Direct Agent | keep the coordinator but replace its target with the already-fenced live Session scope / exact binding generation; read commands through `RemoteSurfaceAuthorityReader` and skills through `SkillCatalogCapability`. No Agent-shaped compatibility wrapper | M3-4; session-switch stale refresh must be rejected |
| `refreshStandingCatalog(presetId, source)` | Direct standing preset/cwd read | the existing §2.2 sessionless standing-skill gap applies. Remote returns the explicit unavailable/unsupported outcome; it must not probe a hidden Session or Host filesystem | M3-4; sessionless `/preset` path fail-closed test |
| `promptAdmission(sessionId, line, task)` | Direct per-Agent prompt/image admission | **retire the Direct-Agent admission hook on the Remote branch.** Scope/writer admission remains `SessionRuntime.withWriter`; client draft/image preflight remains Client-local; Host business admission occurs in the official Session write path. Any attachment class whose receipt transaction is not surfaced is rejected before dispatch (§10) | M3-4; busy/queue/image admission parity and no-Direct-Agent assertion |

The shared `CommandRuntime` and its `SessionScopeAuthority` currentness fence stay.
Only the provider of these application facts changes. If implementation needs a
new neutral interface, it may rename/split `CommandRuntimeSurface`, but it must
preserve this table's ownership and may not turn it into a second backend SDK.

Projection availability note: projection keys registered by agent-scoped rows
(`plan`, `todos`) exist only while the composing preset mounts those rows — the
TUI bundle patch disables `plan-mode` and `tool-todo` at the host plane and the
preset reintroduces them per session (`cordis.patch.yml:193,229`). This is not a
Remote-specific risk: the Direct path reads the same Host projection registry, so
the Remote read has the identical availability contract. `session.projections` is
the wire read (`dsh-api-session-controller/lib/typert.remote-client.d.ts:28`).

### 3.3 Client command execution plane

The command *catalog/claim* and command *callback execution* are different
ownership planes. M3-0 freezes that split because the current Direct implementation
registers TUI callbacks into Host `ctx.commands`, which cannot survive M4 without
moving a UI callback across the process boundary.

| Command class | Authority / discovery | Execution owner under wire mode |
|---|---|---|
| Host command | `commands/list` / `RemoteSurfaceAuthorityReader`; Host claim semantics remain authoritative | `HostCommandPort` → official `commands/execute` |
| TUI built-in command | Client-local static registration | **Remote/wire mode:** Client Context / TUI runner ONLY — never registered into or invoked through Host `ctx.commands` on the Remote branch. **Direct:** may mirror-register the SAME TUI definition (one definition, an adapter compatibility mirror — never a second business authority) into the in-process Host command registry so the existing dispatch surface (busy-Enter, sessionless execution, `commands/change` refresh) keeps working; this does NOT make Host `ctx.commands` the cross-backend semantic owner, and retiring that mirror is a later Direct-retirement stage, not M3-4 |
| TUI skill wrapper | Client-local command surface; live skill metadata from §2.2 | Client Context validates/claims the advertised skill name, then converges the Remote execution to the official literal `/name [instructions]` user gesture; Host `dsh-tool-skill` pre-step resolves the current definition and injects the body. The Remote branch never calls Client `skills/read` because rc.2 exposes none |
| Extension command contribution | Client extension registry | the contribution callback executes in the Client Context that owns it |

**PR4 prerequisite discovered during PR3 (concrete evidence):** the current
Remote submission path resolves the live owner as a transport-neutral
structural projection (`{status, session:{id}}`), and a TUI-owned sessionless
command (observed with `/image`) still reaches
`ctx.commands.execute(projectedAgent, …)` — the dsh-commands execution
contract assumes a real Direct Agent (`agent.session.append.bind(...)` crashes
on the projection). Two workarounds were tried and rejected: bypassing
`service.execute` to call the global-layer handler directly (duplicates
command-plane ownership), and passing `agent: undefined` (downstream
subscribers still assume Agent identity). PR4 must implement the §3.3
Client-owned execution registry split — the structural projection must never
be enriched into a fake DSH Agent.

M3-4 therefore extracts the existing TUI command handlers from the Host command
service into one Client-local execution registry/normalizer. It may reuse the
current parser/result vocabulary, but **no handler function, component or callback
is registered into or invoked through Host `ctx.commands` on the Remote branch**.
The catalog shown to the user is still the Client-side merge of Host descriptors,
TUI built-ins and extension contributions. Host claim/collision precedence stays
unchanged: a Host descriptor can claim a name/line; a Client contribution can
never erase that Host authority.

`RemoteSurfaceAuthorityReader` remains metadata-only and `HostCommandPort` remains
Host-execution-only. Neither is widened to carry Client callbacks. The current
Direct per-skill wrapper (`loadSkill` + TUI-owned `renderSkillInvocation`) remains
a Direct compatibility implementation; the Remote branch deliberately converges
that command onto rc.2's official explicit-user-skill gesture so the Host performs
the authoritative `get`/`isUserInvocable` recheck at pre-step time. The visible
slash-command claim and trailing-instructions UX are preserved; the private
Direct skill-body renderer is **not** promoted into a cross-process contract.
L6 must prove a TUI built-in and an extension command execute without
`ctx.commands.execute`, a skill wrapper submits exactly one literal user gesture
without a Client-side body load, and an advertised Host command still runs
exactly once through `HostCommandPort`.

## 4. Client / Host / Connection lifetime

### 4.1 Ownership graph (one owner per resource)

```text
Existing DSH Host Context (base + normal pi-tui patch)
  |- base Host domain services + typert/typertGateway
  |- existing TUI jobController row
  '- RemoteHostRuntime (M3-1; dynamic, experimental owner)
       |- Host ConnectionService
       |- Host fileUploads
       |- sessionStats + turnOutline projection units
       |- api-session-controller
       |- api-settings-controller
       |- api-remotes (forwarded events)
       '- session-log-export
            |
            '- in-process transport (composition-owned: shared Fetch handler + wireStream.open)
                    |
Client Context (M3-1 owner: src/app/remote/client-runtime.ts)
  |- typert registry
  |- Connection -> generation/state
  |- Gateway -> namespaces/$stream/$on
  |- explicit /remote contributions (including fileUploads)
  |- Client fileUpload service
  |- Client Sessions / Client Jobs
  '- Remote backend/application adapters
                    |
Application owners: session ownership core, command runtime, submission, surface
```

`RemoteHostRuntime` is the M3 gate authority. If it was not explicitly
constructed by the dynamically imported experimental Remote runtime, none of
the additive Host plugins exist. M3-1 therefore does not add a production
Cordis row whose `disabled` expression must predict a future backend choice.

| Resource | Constructs / mounts | Readiness | Reconnect ownership | Disposal / order | Reentrancy rule |
|---|---|---|---|---|---|
| existing Host Context | DSH Loader + normal pi-tui patch | existing Host startup gate | n/a | disposed after RemoteHostRuntime and Client Context | Cordis disposers may run synchronously |
| `RemoteHostRuntime` | additive Host plugins from §2.4.1, in dependency order | every plugin fiber mounted; required services (`connection`, `fileUploads`) present | Host connection owns carrier state | after Client Context, reverse plugin order; then existing Host lifecycle continues | no plugin callback may target a disposed Client |
| in-process RPC bridge | composition-owned explicit transport over the Host `createSharedFetchHandler('/api')` + `typertGateway.wireStream.open` seams | available before Client Connection install | follows Host connection generation | with RemoteHostRuntime | close/abort may synchronously settle client requests |
| Client Context | `client-runtime.ts` exact sequence from §2.4.3 | connection generation defined + Session list phase `ready`; Job roster has its own readiness and must be proven by M3-1 L5 but does not block main-session readiness | owner observes official generation/reset only; no watchdog | adapters/refs first, then Client fiber in reverse mount order | plugin disposers/generation subscribers may fire synchronously |
| Connection | official Client plugin with `installConnection({transport:{fetch, openStream, ownsHost:true}})` over the composition-owned in-process carrier | `generation.getSnapshot() !== undefined` | official loop; `connection/reset` is cache invalidation | late in Client reverse-dispose | reset clears generation synchronously |
| Gateway | official Client plugin | after Connection generation | owns `$events`, streams and forwarded events | before Connection | listeners are removed while Context is live |
| `/remote` contributions | explicit §2.4.2 list | namespace mount complete | follow Gateway generation | reverse mount order | namespace unregister may invalidate readers synchronously |
| Client fileUpload | official Client plugin after `fileUploads` Remote contribution | service provided | follows Gateway generation | before Gateway, after Session/Job users are gone | no Worker/browser path may be reached merely by mounting it |
| Client Sessions | official Session Client after Client fileUpload | `list.phase === 'ready'` | owns baseline/history recovery | before fileUpload/Gateway | final `release()` can synchronously retire a binding scope |
| Client Jobs | official Job Client | first roster frame for job surfaces | follows Gateway stream generation | before lower Client services | watchers/listeners settle on dispose |
| Remote backend/application adapters | TUI owners | after required Client readiness and (for settings) first mirror commit | capture + re-check connection/binding generation | **first** | abort/unsubscribe before Context disposal |
| main `SessionReference` | `acquireMainSurfaceReference` → `sessions.retain(tuiMainView)` | no `ready` await required to establish identity | exact `binding` object remains the owner identity | release exactly once before Client Context | last release may retire binding synchronously |
| bounded operation reference | `pinExistingGeneration` → `sessions.retain(tuiOperation)` after borrow | no | rejects replacement by `Object.is` | release at operation end | never cold-opens a replacement generation |
| child viewer `SessionReference` | `acquireChildViewReference(address)` → `sessions.retain(tuiChildView)` | awaits `ready` when the viewer must start from a stable first window | the exact `binding` object + the durable parent/child/mode address | `release()` exactly once on every exit/switch/swap/dispose path, AFTER the child live ingress is disposed | addressed by `SubagentAddress` only (never a plain id); owns Client lifetime only and never creates or activates a Host Agent |

Frozen disposal order:

```text
adapter subscriptions / in-flight ops / exact Session refs
  -> Client Context (Jobs -> Sessions -> fileUpload -> contributions -> Gateway -> Connection -> typert)
  -> RemoteHostRuntime (session-log-export -> api-remotes -> settings -> session -> turnOutline -> sessionStats -> fileUploads -> Host connection)
  -> existing Host persistence / Host Context lifecycle
  -> restore scoped process globals (module-loader shim must already be gone)
```

The shim is normally restored immediately after Client bundle import/instantiation,
not held until application shutdown. Disposal still defensively restores it if
construction failed mid-flight.

### 4.2 Node-runtime fact: exact scoped-loader adaptation

rc.2 has no Node-native entry for the six Client plugins listed in §2.4.3; each
public `./client` subpath resolves to a `platform: web` `lib/client.js` that
registers itself through `window.__ModuleLoader__.load(...)`. Plain Node import
therefore fails before the official plugin can be obtained.

M3-1 freezes one packaging-only adaptation in
`src/app/remote/client-runtime.ts`:

1. save the previous `globalThis.window` / loader state;
2. install a minimal `window.__ModuleLoader__.load` implementation whose
   accepted bundle ids are exactly the six §2.4.3 entries;
3. dynamically import and instantiate those entries in dependency order;
4. use the public Connection `installConnection(ctx, { transport })` hook with
   the explicit composition-owned carrier: `transport.fetch` adapts the Host
   `connection.createSharedFetchHandler('/api')` and `transport.openStream`
   adapts the Host `typertGateway.wireStream.open`; `ownsHost: true` and no
   `location` are passed (the verified rc.2 public carrier — the M3-1
   implementation supersedes the earlier `transport.rpc` wording);
5. restore the previous global immediately after construction (and in every
   failure path). Disposal may not depend on the shim still being installed.

The shim must reject unknown/duplicate registrations and is covered by a test
that imports each allowed entry plus one forbidden entry. It is **not** allowed
to grow browser APIs. In particular the in-process composition must not reach
`WebSocket`, `document.baseURI`, `navigator.onLine`, `globalThis.fetch` or a
browser `Worker` as part of connect/list/reconnect/dispose. `location` is
omitted and the Client connection uses `ownsHost: true`.

This is an rc.2 packaging adaptation, not a second Client runtime: Connection,
Gateway, Session/Job state machines and generated Remotes remain official.

### 4.3 Dynamic-load boundary (frozen)

```text
src/startup.ts  --(!static)-->  remote composition / client packages
bootstrap runtime selection  --dynamic import()-->  experimental Remote runtime
```

- New edge: `src/runtime/backend-loader.ts` is the **only** module that dynamically
  imports `src/app/remote/runtime.ts`; it has no static edge to
  `runtime/remote/**`, `app/remote/**` or any `@deepseek-ai/dsh-*/(client|remote)`
  specifier.
- `scripts/pre-m3-architecture-gate.mjs` Rule 4 already enforces the startup
  reachability rule (`:160-164,405-422`; tests
  `test/pre-m3-architecture-gate.test.mjs:198-257,358-366`), but its
  `REMOTE_COMPOSITION_SPECIFIER = /^@deepseek-ai\/dsh-(?:client-|api-)/`
  (`:89`) is too narrow: it misses `@deepseek-ai/dsh-commands/remote`,
  `dsh-subagent/remote`, `dsh-agent-preset-registry/remote`,
  `dsh-plugin-manager/remote`, `dsh-llm/remote`, `dsh-permission-presets/remote`,
  and it does not name a future `app/remote/**` prefix. **M3-1 extends that regex
  and adds the corresponding test rows in the gate's own test file** — no new test
  module.


### 4.4 Legacy TUI settings migration is Host-local and precedes Client readiness

`src/legacy-settings-migration.ts` is a one-shot migration of the retired
Host-profile `$DSH_HOME/settings.yaml(.imported)` into the current Host Settings
forms. It reads Host profile storage and validates the historical preset through
the Host preset registry, so it is **not** a Client-local preference import and
does not gain a Remote protocol.

M3 freezes the ordering:

```text
Host/profile startup prerequisites
  -> migrateLegacySettings(Host profileContext + SettingsForms + agentPresets)
  -> RemoteHostRuntime composition
  -> Client runtime / Connection readiness
  -> Remote ConfigPort settings mirror first describe
  -> application compose/resume
```

The existing “before display/progress/response/notification startup state and
before compose/resume” rule remains authoritative. The new additional rule is
that a Remote Client never reads its own process `$DSH_HOME` to satisfy this
migration. M3-1 owns the ordering barrier; M3-3B may not declare its first
settings mirror ready until that Host migration prerequisite has settled.

Acceptance: L5 composition proves the Remote Client path performs no
`profileContext`/legacy-file read and cannot race the first settings mirror ahead
of the Host migration. A migration failure remains visible/retriable exactly as
today and prevents the marker from being falsely advanced.


## 5. Session ownership contract

### 5.1 Exact identity rule (frozen)

```text
same exact retained Client binding generation  -> same SessionOwnerRef
same sessionId retained again after the old generation retired -> DIFFERENT SessionOwnerRef
```

Identity source: `SessionHandle.client.bindingIdentity`
(`src/runtime/session-lifecycle-port.ts:101-104`), which the Remote adapter sets to
the exact `SessionReference.binding` object
(`src/runtime/remote/session-reference.ts:131`). The official field is
`readonly binding: SessionBinding` — "Identity-stable logical binding for one
materialized Client Session" (`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:25`;
`.../client/sessions/service.d.ts:75-83`). It is minted once per
`materializeScope` and deleted with the scope when the last reference releases, so
a same-id re-retain yields a new object.

Forbidden shortcuts, each refuted: `sessionId` equality (a brand over a string with
no generation component); a readiness boolean (`SessionReference.ready` is the
history-open wait, not an identity); a copied generation id string (the only public
generation id is the *connection* `ConnectionGeneration.id`, which does not change
on same-id re-retain); a re-derived wrapper (the borrow/pin contract refuses a
wrapper by `Object.is`).

### 5.2 Handle-to-owner mapping (M3-2 spec)

| Method | Source data | Lifetime / post-release | Strength |
|---|---|---|---|
| `fromHandle(handle)` | `handle.client?.bindingIdentity`; `undefined` for a Direct handle or a Remote publication-only fork handle | must never resurrect a retired binding; a later same-id retain mints a new owner | `WeakMap<bindingIdentity, SessionOwnerRef>`; the owner→`ClientSessionOwner` side is **strong** so `retire` can `release()` |
| `sessionId(owner)` | `SessionReference.sessionId` / `SessionBinding.sessionId` | stable for the owner's lifetime; **throws** when unknown | — |
| `completionIdentity(owner)` | no public per-generation string exists in rc.2 | return `undefined` and route completion from the client-visible `SessionSnapshot.running`; a minted opaque per-owner token is the alternative. **Never the sessionId** (same-id rollover must change it) | — |

Re-wrapping the same exact `bindingIdentity` preserves owner identity and refreshes
the stored wrapper; the adapter must guarantee one authoritative wrapper per
generation (each wrapper owns a reference count).

### 5.3 Retirement semantics (frozen)

`Remote retirement != Agent.cancel + Agent.whenIdle + AgentHandle.dispose`. The
Host remains the execution owner; the symbols do not exist on the Remote side
(`directAgentOf`/`ownerHandleOf` return `undefined`,
`src/runtime/session-lifecycle-port.ts:246-259`).

| Method | Remote meaning |
|---|---|
| `whenIdleOrAbort(owner, signal)` | local wait + cancellation only: observe `SessionSnapshot.running` plus the abort signal; never destroy the Host Agent |
| `flush(owner)` | deliberate no-op — Host-owned durability; no public Client flush verb |
| `preCancel(owner)` | deliberate no-op — synchronous by contract, cannot dispatch a Host RPC; the async cancel is `SessionWriter.cancel` |
| `retire(owner, mode)` | exact Client reference `release()` exactly once; `mode` has no distinct Remote order |
| `park(owner)` | conditional: a Remote fork child is publication-only and carries no `client`, so nothing is parked today. If M3 ever parks a retained owner it must hold the exact reference strongly per sessionId |
| `retireParked()` | release every parked exact reference exactly once; empty report when none are parked |

### 5.4 Transition ordering (frozen)

The ownership handoff and the heavier surface initialization are two distinct
phases. The exact order is:

```text
retain/acquire NEW exact Client generation
  -> validate supersession (release NEW and stop if superseded)
  -> commit application SessionOwnerRef + completion identity SYNCHRONOUSLY
  -> release/retire OLD main-surface reference
  -> initialize NEW presentation/catalog/live subscriptions (initLiveSession)
```

Never release OLD before NEW is committed. Equally, never make
`initLiveSession` part of the ownership handoff: it may await Remote reads and
must not extend the period in which OLD is retained. The synchronous commit is
the reentrancy fence — if releasing OLD synchronously retires its binding or
fires listeners, every application currentness read already points at NEW.

If post-handoff surface initialization fails, report/tear down the NEW surface
according to the normal fatal/application error path; do **not** resurrect OLD
as an implicit rollback. A superseded NEW acquisition, by contrast, is
released before commit and OLD remains current.

Current code commits the new owner synchronously before `retireOld`
(`src/app/session/commit-order.ts`, `src/app/session/runtime.ts`). M3-2 kept
that ordering and additionally moved the NEW-owner mapping into the synchronous
commit section (a transaction-local `committedOwner`): the post-commit phases
reuse the exact owner the commit published instead of re-wrapping the handle,
because for a Remote reference wrapper every `fromHandle` is an ownership
transfer, never a free re-read.

M3-2 (DONE) removed the Direct-owner assumptions this section had inventoried:
the four "without a Direct owner" throws in `src/app/session/runtime.ts` are
now transport-neutral owned-generation failures (the fork shape became the
publication→open adoption path of §5.5 row 5), `bootstrap.ts`'s
`initLiveSession`/`refreshLiveCatalog` no longer hard-throw on an owner without
a Direct attachment (an M3-2 staging no-op; M3-4 supplies the real Remote
presentation provider), and `clientOwnerOf()` is consumed by the Remote owner
provider `src/app/remote/session-owners.ts` as its sole mapping source.

### 5.5 Lifecycle reference-ownership table

| # | Path | Acquire | Transfer | Release on success | Release on supersession/failure | Visible owner |
|---|---|---|---|---|---|---|
| 1 | startup open/resume | `lifecycle.open` (`bootstrap.ts:651`) | `publishResumedOwner` synchronously (`runtime.ts:719-735`) | `retireOwnedSession` (`runtime.ts:757-832`) | `requireOpened` throws; Remote mid-acquire abort releases (`session-lifecycle-remote.ts:362-364`) | core owner after publish |
| 2 | sessionless first create | `lifecycle.create` (`runtime.ts:864-872`) | `commitFirstSession` (`runtime.ts:688-711`) | retirement on exit/HMR | `requireCreated` throws; Remote superseded releases (`:338-341`) | sessionless until commit |
| 3 | `/new` | `transitionTo` create (`bootstrap.ts:1184`) | commit (`runtime.ts:226-245`) | old owner `runtime.ts:247-261` | pre-commit abort, zero side effects | child after commit |
| 4 | ordinary switch/open | `lifecycle.open` (`runtime.ts:361-364`) | commit | old owner | Remote `unavailable`/`cancelled` produce no owner | old stays current on failure |
| 5 | `/fork` success | `lifecycle.fork` publication-only | `adoptFork` commit: a Direct handle adopts its owned agent directly; a Remote publication-only child is adopted through `lifecycle.open(childId)` (one fork dispatch + at most one adoption retain, re-fenced before commit) | source retired | child parked if not current; a stale-after-open Remote adoption releases the NEW owner exactly once; Remote child publication handles park nothing | child after adoption |
| 6 | `/rewind` fork/adoption | same as `/fork` (`application-events.ts:228-245`) | `adoptFork` + `onAdopted` | source retired (awaited on the picker path) | park | child after adoption |
| 7 | superseded create | new handle acquired mid-flight | — | — | Remote releases the new owner; runtime stays silent | old stays current |
| 8 | superseded open | new retain | — | — | Remote `owner.release()` | old stays current |
| 9 | superseded fork | publication only | — | — | `parkForkOwner`; Remote handle has no `client` → no-op | child catalogued, not selected |
| 10 | published-with-error | Direct child handle owned; Remote creates no reference | fork: `parkForkOwner`; create: throws | `retireParked` | Remote: nothing to release | old stays current; child identity preserved |
| 11 | generation replacement/reconnect | — | — | — | every adapter fences on the captured connection generation; the Client controller's reconnect path rebuilds baseline/open windows without retiring retained scopes | a normal reconnect preserves the exact `SessionBinding` object and therefore the same `SessionOwnerRef`; if a scope is actually retired and later materialized again, the new binding object MUST map to a new owner |
| 12 | same-id new binding generation | new `retain` after full release | new binding object | old released once | — | a **different** `SessionOwnerRef` (locked by `test/remote-session-lifecycle.test.ts:193-208`) |
| 13 | parked/refused fork child | Direct owner pool; Remote none | `parkForkOwner` | `retireParked` | — | Remote `park` is a no-op today |
| 14 | exit during transition | current owner captured at admission | `preCancel` then appExit | memoized retirement | late committed child retired | exactly-once cancel |
| 15 | fatal startup after retain, before mount | resume owner published | `bootstrap.ts:1295-1311` | `retireOwnedSession()` | — | nothing else registered |
| 16 | HMR/disposal | resume/first owner | `registerRunnerDisposal` (`bootstrap.ts:1328-1348`) | `retireOwnedSession()` | — | surface disposed first, then retirement |

No row ends with "caller cleans up": every release names the runtime, the adapter,
or the parked-owner drain.

## 6. Presentation migration matrix

| Current Direct dependency | Why needed | Remote replacement | Owner | Stage |
|---|---|---|---|---|
| `LiveSessionAgent` (`session-presentation.ts:52-58`) | opaque live-session identity (id/header/log) | Client binding generation + `ISessions.binding(id)` | `app/session` | M3-4 |
| `session.snapshotEvents()` (`:305-308`) | cold hydration of transcript/stats/todo/compaction | `SessionBinding.eventSource` window + `loadOlder()` | presentation | M3-4 |
| full-log `snapshotEvents()` for `/rewind` | enumerate every completed human turn without changing normal transcript retention | `turnOutline` whole-log projection; `loadThrough(seq)` only for a turn whose event detail must be materialized | command/application | M3-4 |
| `ctx.tools.get(...).presentCall/presentResult` | specialized tool cards during live output and replay | Client-only card derivation from raw event args/result/content/meta; extension renderers remain Client-owned; unknown tool falls back generically | presentation | M3-4 |
| `ctx.attachments.saveImages/readImage` + `ctx.llm.resolveModelInfo` | draft image admission, durable image replay/recall, model capability preflight | official image prompt parts + Host `session/prompt` admission; `session/attachment` for authorized durable reads; Session `imageLimits` projection for post-create preflight | submission/presentation | M3-4 main / M3-5 viewer |
| `session.header.cwd` (`:304`) | per-session workspace for history recall/shell | Client list/binding `cwd` | status/session | M3-4 |
| `installModelSelection(agent)` (`bootstrap.ts:838`) | Agent-scoped model selection install | `modelSelection` projection | catalog/app | M3-4 |
| `planActive(agent)` (`bootstrap.ts:840-843`) | plan badge + Esc gating | `plan` projection | status | M3-4 |
| `assistantStreamBaselineFor(agent)` / `installAssistantStream` (`bootstrap.ts:839,1961-1969`) | live transient output with exact identity | `eventSource` transient entries via a subscription ingress; identity = binding generation | surface | M3-4 / M3-5 |
| `agent.status === 'running'` (`submission/controller.ts:444,677`) | submit-vs-queued row, delivery resolution | `SessionSnapshot.running` | submission | M3-4 |
| `workingFromLog(agent.session.snapshotEvents())` (`bootstrap.ts:1934`) | compaction/working read | Client event window | presentation | M3-4 |
| `sessions.flush(agent.session)` (`bootstrap.ts:1941-1950`) | Direct turn-end durability hint | no public Client flush verb → Host owns durability; the Remote application hook is a deliberate no-op | session/application | M3-4 (main event routing must already be Direct-free) |
| `agentNow()` / `registeredAgentIs` / `queueAgentFor(childId)` (`bootstrap.ts:412,1519,1772`) | current owner identity, exact Agent fence, child queue address | binding generation identity + child Session identity + `SessionWriter.updateQueue` | app/session | M3-2 / M3-5 |
| `ctx.jobs` / `ctx.subagents` (`bootstrap.ts:1792-1826`) | Task Center roster/detail | `RemoteTaskReader` + `RemoteJobObservationPort` + `IJobs.watchRows` | task surface | M3-5 |
| `sessions.get` / `agents.get().status` / `sessionQuery.observeSession` (viewer) | live + cold child transcript/activity | child binding generation + `RemotePresentationReader` + `RemoteTaskReader` | viewer | M3-5 |
| `new DirectSubmissionPresentation` (`submission/controller.ts:431`) | optimistic echo before the authoritative occurrence | official `SessionSnapshot.pendingSubmissions` | submission | M3-4 |
| command runtime `sessionStats` / `lastAssistantText` | `/status`, `/copy`/read facades need owner-scoped historical facts | §3.2 Remote metrics + paged last-assistant readers over exact binding/projections | command/application | M3-4 |
| command runtime exact-Agent catalog target | live `/reload`/catalog refresh must not retarget after switch | exact `SessionScope` + binding generation; `RemoteSurfaceAuthorityReader` + `SkillCatalogCapability` | command/application | M3-4 |
| command runtime `promptAdmission(agent, ...)` | Direct per-Agent prompt/image admission | writer/scope admission + Client-local preflight + official Session write; unsupported attachment class fails before dispatch | submission/command | M3-4 |
| TUI/extension command callback via `ctx.commands.execute` | normalize/execute Client-owned slash-command callbacks | Client-local execution plane from §3.3; Host commands alone cross `HostCommandPort` | command/application | M3-4 |
| `statusRuntime.cyclePermission()` → Host `permissionPresets.set(session,next)` | Shift+Tab permission cycling | Client reads authoritative `permissions.currentValue` + catalog order, then calls semantic async `ConfigPort.permissions.applyPermissionPreset`; stale generation cannot apply UI state | status/application | M3-4 |
| `LocalShell.resolveShell()` → Host `ctx.shell`; exact Agent interrupt | optional sandboxed user shell + cancel/currentness | `HostUserShellPort` with a Direct Host adapter (execution behind adapter ownership) and a truthful-unavailable Remote adapter; exact binding-generation fence + `SessionWriter.cancel`/prompt for session semantics; Remote `!`/`!!` (both policies) fail closed — no qualified one-shot Host user-shell carrier exists at rc.2 | submission/application | M3-4 |
| `migrateLegacySettings(profileContext.home, SettingsForms, agentPresets.resolve)` | one-shot retired Host-profile settings import before first compose/resume | stays Host-local and completes before Remote settings readiness; no Client `$DSH_HOME`/preset-registry access | startup/composition | M3-1 |

No fake `Agent` wrapper is introduced anywhere, including inside the command runtime.
No Host callback is moved into the Client: tool presentation and TUI command
callbacks become Client-owned behavior, while Host tool/command semantics remain
Host-owned.

### 6.1 Surface reachability classification (frozen)

The contract may state that a surface owns input or that a concurrent surface is
forbidden. It must not require a test-only navigation path: a state may exist in
a projection without being user-navigable. Use the migration document's
classification vocabulary (§Migration process and qualification governance):

```text
SURFACE_REACHABLE
PROJECTION_ONLY
TRANSIENT
FORBIDDEN_CONCURRENT_STATE
```

Reachability is stated only where it affects ownership/focus semantics. Example:
a visible Question owns the response seat, so opening the Task Center is not an
allowed competing input path; the projection may still define an `answering` row
for that Question without making the concurrent state user-navigable.

## 7. Locality matrix

Semantic ownership is stated independent of transport placement; M3 composes an
in-process wire, M4/M5 change placement only.

| Operation/state | Client-local | Host-owned | Wire seam | M3 behavior |
|---|---:|---:|---|---|
| terminal rendering, editor, overlays, keybindings | ✓ | | none | local |
| clipboard / OSC 52 | ✓ | | none | local (never backend-determined) |
| external editor | ✓ | | none | local |
| user `!` / `!!` shell — gesture/editor/card/presentation | ✓ | | none | Client-owned editor mode, shell card, bounded tail/fold/copy presentation |
| user `!` / `!!` shell — execution (cwd/PATH/env/shell discovery/process/exit/cancel) | | ✓ | `HostUserShellPort` (Direct adapter in-process; **no qualified one-shot Host user-shell Remote carrier at rc.2**) | Direct: Host adapter executes with the Session workspace; `!` result returns through `SessionWriter`, `!!` writes nothing. Remote: BOTH `!` and `!!` and BOTH policies fail closed with a visible error and execute nothing (U11a/U11b); never Client spawn, never Host `ctx.shell` borrowing, never sandbox→bypass downgrade |
| user `!` / `!!` shell completion facts | completion request/UX | ✓ | Direct: Host compgen behind the Direct adapter; Remote: **no carrier** | Direct keeps shell-aware completion (the process IS the Host); Remote shows no shell-specific suggestions and never reads Client PATH/filesystem for Host shell state |
| `@file` discovery (session scope) | | ✓ | `fileReferences/list(agentId, query, signal)` | remote Host |
| `@file` discovery (sessionless/workspace scope) | | | **no rc.2 expression** | fail closed (INTENTIONAL_UNSUPPORTED_IN_M3) |
| `@file` existence/canonicalization | | ✓ | **no callable rc.2 expression** (the Host canonicalizes internally when promoting prompt file parts) | fail closed; relative mentions keep their literal text |
| Session persistence/log, history window | | ✓ | Client Session binding / `session.list\|page\|projections\|search` | remote Host |
| Session archive generation | | ✓ | HTTP `GET /api/session.export` via the composition-owned fetch | remote Host |
| `/image` / clipboard image file read + draft bytes | ✓ | | local filesystem / memory only | Client-local staging; before a Session exists only TUI safety/RAM caps apply |
| image prompt admission + durable image storage | draft bytes originate Client-side | ✓ | official `Session.prompt(PromptContentPart[])`; Session `imageLimits` projection; Host returns authoritative attachment/model refusal | supported in M3 after Session creation; no `fileUploads` receipt is required for image parts |
| durable Session image display / recall | | ✓ | `session/attachment({sessionId, attachmentId})` | remote Host read, exact Session/binding fenced |
| generic file attachment byte storage | Client-local file source | ✓ | `fileUploads/upload` receipt transaction | D4 (post-M3); remains unsupported in M3 |
| Plugin Manager truth | | ✓ | `pluginManager/*` + forwarded events | remote Host |
| settings / credentials / permissions / preset default | | ✓ | `settings/*`, `credentials/*`, `permissionPresets/*`, `agentPresets/*` | remote Host |
| provider authorization sign-in | | ✓ | **no rc.2 expression** | fail closed (INTENTIONAL_UNSUPPORTED_IN_M3) |
| Task/Job/subagent truth | | ✓ | Client projections + `IJobs` + `subagents/*` | remote Host |
| TUI notification delivery | ✓ | | none | local |
| user-history persistence (`$DSH_HOME/user-history/*.jsonl`) | ✓ | | none | local (per-machine input history; verified as Client-local in the coupling inventory) |
| extension UI callbacks / components | ✓ | | Client Context / extension surface | local |
| extension Host/domain state | | ✓ | public Remote facts only | remote Host |
| session transition coordination, operation barrier | ✓ | | none | local |
| pending-input presentation policy (lane labels) | ✓ | | none | local over the semantic projection |
| model-selection *intent* install | | ✓ | `modelSelection` projection | remote Host |

M3 is an in-process wire on one machine, but locality is frozen as if M4 could
split the process tomorrow. **Shell amendment (M3-4 PR3)**: `!` and `!!` are
both Host-side user-shell operations — bypass and sandbox are Host execution
policies, not locality choices — and they differ only in result routing (`!`
submits the completed command+output through the semantic Session writer; `!!`
keeps the card presentation-only with zero Session/model write). `!!` is
Session/model-EXCLUDED, never sessionless: with no current Session the TUI
ensures one first and executes in that Session's Host workspace, persisting the
input history under that Session identity. The rc.2 terminal-controller Remote
is a retained interactive PTY carrier (screen-stream output, no per-command
authoritative exit status, no one-shot cancel, no sandbox variant) and therefore
does not qualify as the one-shot Host user-shell carrier: Remote `!`/`!!` fail
closed until a public carrier qualifies (U11a/U11b); a Client-side shell under
a Remote Session would be a critical locality violation, and no implementation
may “borrow” Host `ctx.shell` just because both sides happen to share one
process. Shell completion follows the same authority: Direct keeps the
real-shell compgen bridge behind the Direct Host adapter, while Remote shows no
shell-specific suggestions rather than completing from Client `process.env.PATH`
or the Client filesystem. `/image` and `/attach` local reads, the external
editor, `/export`/`/transcript` file writes (Save Location), and `/open`-style
working-directory changes. A local `/image` read is only **staging**: before a Session
exists the TUI can enforce only its own memory/safety cap; after creation/retain,
the exact Session's `imageLimits` projection is re-applied before serialization,
and Host `session/prompt` remains the final image/model admission authority. A
recalled durable image is never re-sent by citing a Host-private reference: the
Client first reads its authorized bytes through `session/attachment` and submits
ordinary official image data.

What M3 must NOT do is let a Host-owned semantic run on the Client filesystem:
`@file` already goes through `HostFilePort`, and the fail-closed rows above apply.
M5 (external attach) is where `!`/`!!`, the external editor and local file reads
must fail closed until a Host seam exists; that is a placement change, not a
semantic rewrite, because the ownership above is already correct.

## 8. Extension ownership

| Piece | Context under wire mode | Rule |
|---|---|---|
| `PiTuiExtensionService` (`piTuiExtensions`), contribution ledger, keybinding/renderer/editor/autocomplete/theme registries, SurfaceHost, Plugin Manager UI integration, Advanced/Unstable input captures | **Client Context** | UI contribution lifecycle is caller-fiber-owned (`ctx.effect`); the service is provided by the TUI process |
| Host plugins / domain services / durable state | **Host Context** | never reached by a Client callback |
| across the boundary | serializable facts / generated Remotes only | **no callback, component, renderer or editor object crosses** |

Audit result: no `src/extension/**` module reads a Host service (`ctx.get('<host
service>')` is absent); the extension boundary is already Host-free. The one open
question is where an extension plugin that needs BOTH UI contributions and Host
domain state is mounted: M3's answer is that a plugin using the existing PiTui
**imperative** extension API (callback/component/editor/renderer contribution) is
loaded in the Client Context and reads Host domain state only through public
Remote facts; a Host-only extension stays in the Host Context. M3-6 owns any
rebinding this requires. The public Extension API keeps its semantics, and no
callback crosses the wire (AGENTS.md hard rule; `docs/extension-api.md`).

Clarification (2026-10-03 amendment): that Client-context rule covers the
existing imperative extension API and does not require every future Host-owned
feature that exposes UI to move its implementation into the Client Context. A
Host-owned feature may instead expose a **declarative** surface while keeping its
callbacks and business authority Host-side:

```text
Host-owned feature/domain
  -> Host-owned callback/state
  -> serialized declarative surface / action identity
  -> official Remote
  -> Client-local renderer + local input projection
```

This is not a PiTuiExtension callback crossing the wire: no executable
callback/component/renderer/editor object crosses the boundary. It is a legal
future architecture pattern only — no current rc.2 API, dependency, composition
owner or support claim is created by it. See the 2026-10-03 amendment register
row and `docs/client-server-migration.md` §Hard invariants.

## 9. Error / reconnect semantics

### 9.1 Generation replacement (`connected A -> disconnected -> generation B`)

- Source of truth: `ctx.connection.generation` (`ConnectionGenerationState`;
  `id: number` monotone per connect, `undefined` while not connected) plus
  `ConnectionState` (`connected|disconnected|connecting`);
  `'connection/reset'` is the official cache-invalidation signal.
- Every Remote adapter captures the generation before dispatch and re-checks it
  after the await, returning unavailable/superseded rather than a stale value
  (`session-reader-remote.ts:152-163,227`; `session-writer-remote.ts:197-214,272-276`;
  `session-lifecycle-remote.ts:221-228,349-352,387-396`;
  `GenerationCache.invalidate()` on reconnect for one-shot caches).
- Frozen: the TUI introduces **no** transport watchdog. In-flight reads become
  superseded; Host settlements stay real; normal reconnect does **not** retire a
  retained Session scope, so the exact `SessionBinding` object and its
  `SessionOwnerRef` survive while baseline/open-window state is rebuilt. If a
  scope is actually retired and later materialized again, object identity changes
  and §5.1 requires a new owner. M3-1 L5 locks both cases. Presentation sources
  re-read from the retained binding; the application rebuilds only what the
  connection-generation change invalidates.
- The settings mirror is explicitly generation-aware (§2.3): `connection/reset`
  invalidates its authority and schedules a fresh `settings/describe()` after the
  new generation is usable. A `settings/document-updated` event is not assumed to
  replay across a disconnect, and an in-flight old-generation describe can never
  commit over the reconnect refresh.

### 9.2 Writer-held recovery (M3-5)

`session/writer-held` settles `rejected` with preserved `details` and no retry, no
lock takeover, no Direct fallback (`session-writer-remote.ts`,
`src/runtime/remote/write-failure.ts:110-125`). Frozen application behavior:
preserve/restore the user draft as appropriate, settle local echo/ack
deterministically, show the actionable guidance (`SESSION_WRITER_HELD_GUIDANCE`),
and never claim a holder the contract does not supply.

### 9.3 Failure taxonomy (preserved at every stage)

`pre-dispatch unavailable/cancelled` · `Host/business rejected` ·
`committed/published success` · `published-with-error` · `indeterminate transport
settlement` · `locally superseded ownership`. These are never collapsed into a
generic Remote error. The Remote classifier proves `rejected` only for domain
codes, `gateway/bad-request`, and the pinned Gateway's pre-invocation codes;
`gateway/internal` / `gateway/result-invalid` / unknown codes / code-less throws
stay `indeterminate` (`src/runtime/remote/write-failure.ts:131-153`).

## 10. Known unsupported / blockers

| Item | Classification | Why (evidence) | Owner / stage | Acceptance proof |
|---|---|---|---|---|
| sessionless / workspace-scoped `@file` discovery | INTENTIONAL_UNSUPPORTED_IN_M3 | every rc.2 file endpoint is Session-scoped: `fileReferences/list(agentId,…)`, `workspaceFiles/*` keyed by `SessionId`; `directoryPicker/list` is a directory browser, not `@`-discovery | M3-3A | fail-closed notice on the deferred-start surface; L3 test asserts `workspace` scope → unavailable |
| `@file` existence-based canonicalization | INTENTIONAL_UNSUPPORTED_IN_M3 | no callable canonicalization remote; prompt file parts carry only an upload `receiptId`; the Host canonicalizes internally | M3-3A | L3 test: relative mentions stay literal; no local-fs probe |
| provider authorization sign-in (`/login` device/OAuth path) | INTENTIONAL_UNSUPPORTED_IN_M3 | `dsh-authorization` publishes no client/remote face; no `authorization` namespace and no authorization event in the 27-entry forwarded allowlist | M3-3B | fail-closed notice; API-key `/login` still works via `credentials/set` |
| `credentials.listRecords` / `deleteRecord` (only `/logout` record cleanup) | INTENTIONAL_UNSUPPORTED_IN_M3 | no `credentials/list` or record-delete endpoint; key grammars are disjoint | M3-3B | fail-closed notice; reference unset still works |
| sessionless standing skill catalog + Client-side skill body read | INTENTIONAL_UNSUPPORTED_IN_M3 | `skills/list` is Session-addressed and list-only; no `skills/read` | M3-3A/M3-4 | fail-closed for standing reads; live human gesture stays literal and Host pre-step owns body injection |
| live `SkillCatalogCapability.onSkillsChange` hot invalidation | INTENTIONAL_UNSUPPORTED_IN_M3 | Host `skills/change` is not in rc.2's forwarded Remote-event allowlist; no legal Client `$on` key exists | M3-3A/M3-4 | no private event seam; strong re-read on binding entry, `/reload`, and `connection/reset`; invocation never uses a stale Client-side body |
| `refreshTitle` on Remote | INTENTIONAL_UNSUPPORTED_IN_M3 | no official Client verb | M3-3A | existing explicit `unsupported` outcome |
| generic client-local file attachment on the wire | INTENTIONAL_UNSUPPORTED_IN_M3 (D4) | needs the upload receipt transaction; `fileUploads/upload` exists as the D4 relief | D4 | D2.2 serializer already fails closed before dispatch |
| full descendant subagent tree | CLOSED_IN_M3_5_PR2 | the official parent `subagentCatalog` projections ARE the recursive membership authority (no separate Client descendant-list carrier is needed): M3-5 PR2 reproduces the official descendant semantics by walking them recursively | M3-5 PR2 | `src/runtime/remote/task-read-remote.ts` + `test/remote-task-read.test.ts`, `test/remote-task-read-shadow.test.ts`, `pnpm smoke:remote-task-read-parity` (`skipped: []`) |
| rc.2 Remote descendant-catalog missing-key provenance / failure-scope fidelity | INTENTIONAL_UNSUPPORTED_IN_M3 (carrier limitation) | the Client projection state cannot distinguish the Host `null` (missing Session) from a non-null baseline that omits `subagentCatalog`; both settle `ready` with the key absent, and `ProjectionValueStore.values()` exposes only rows. The Remote adapter therefore uses the BRANCH-LOCAL `unavailable` policy, preserving the released Client/Web branch-isolation behavior (an unreadable/absent child catalog stays expandable/retryable; only `ready + empty` is a known leaf) and the representable missing-Session semantics. It MUST NOT infer provenance from Session-list membership, catalog presence, messages, logs or any other authority | M3-5 PR2 (carrier owner: upstream Client) | `src/runtime/remote/task-read-remote.ts` + `test/remote-task-read.test.ts` F4d cases; the real-wire ghost branch parity in `pnpm smoke:remote-task-read-parity`; ledger row in `docs/client-server-migration.md` |
| rc.2 Remote diagnostic-taxonomy fidelity (`corrupt` vs `unavailable`) | INTENTIONAL_UNSUPPORTED_IN_M3 (carrier limitation) | the Host `session.projections` handler collapses a corrupt / source-conflicting SessionQuery failure into `gateway/internal`, so the Client carrier cannot express the upstream reason; the Remote adapter MUST NOT infer `corrupt` from messages/causes/log shapes | M3-5 PR2 (carrier owner: upstream) | code keeps the `corrupt` semantic mapping for a surviving structured reason, maps `gateway/internal` to `unavailable`, and the carrier-shaped negative regression pins it; `docs/client-server-migration.md` records the limitation |
| `session.createdAt`, Direct `live` bit | POST_M3_NON_BLOCKING | no public Client field / different `running` semantic | post-M3 | D1 ledger skips |
| cross-client concurrency (Web+TUI, reconnect, cold resume, Host crash) | POST_M3_NON_BLOCKING (M8) | DSH `SessionHandle`/`SessionWriteLease` is the writer authority; the full matrix is an M8 deliverable | M8 | M8 proof |
| exact session approval-policy read/write (`InteractionPort.setApprovalPolicy`, `ConfigPort.permissions.approvalOverrideOf`, `/settings` approval row) | INTENTIONAL_UNSUPPORTED_IN_M3 | rc.2 has no public Client read of the independent `approval/policy` override and no synchronous exact carrier matching `InteractionPort.setApprovalPolicy`; public `permissions` exposes only preset `currentValue` | M3-3B/M3-4 | Remote setter returns `false`, override read returns `undefined` as unavailable, and the Remote approval settings row is hidden/disabled; no `?? 'ask'`, event-log reconstruction or preset-name inference |
| independent sandbox/approval structured status facts | INTENTIONAL_UNSUPPORTED_IN_M3 | rc.2 does not expose the Host `sandboxPolicy.resolve()` result or approval override as public Session projection values | M3-4 | permission preset remains visible from `permissions.currentValue`; sandbox/approval fields are omitted, never guessed |
| user `!` / `!!` shell on the Remote backend (both policies) | INTENTIONAL_UNSUPPORTED_IN_M3 | rc.2's terminal-controller Remote is a retained interactive PTY carrier (screen-stream output, no per-command authoritative exit status, no one-shot cancel, no sandbox variant) — it fails the one-shot Host user-shell carrier qualification (U11a/U11b) | M3-4 | Remote `!` and `!!` BOTH fail closed with a visible error and execute nothing; no Client spawn, no Host `ctx.shell` borrowing, no sandbox→bypass downgrade; Direct executes both modes through the Host-owned adapter |
| synchronous `TuiSettingsConfig.get()` over async settings Remote | RESOLVED_ADAPTER_CONTRACT | §2.3 freezes listener-before-read, serialized describe, `settings/document-updated` + `connection/reset` invalidation, in-flight invalidation rerun and post-write authoritative refresh | M3-3B | race tests: event-during-read, disconnect-change-reconnect, write/read round trip |
| Client runtime uses Web module-loader bundles | RESOLVED_PACKAGING_ADAPTATION | exact six-entry shim allowlist and lifecycle are frozen in §2.4.3/§4.2; `/remote` contributions stay native ESM | M3-1 | L5 connect/list/reconnect/dispose + allowed/forbidden bundle-loader tests; no browser fallback reached |
| Host composition dependency closure | RESOLVED_COMPOSITION_CONTRACT | §2.4.1 includes Host connection → fileUploads → sessionStats/turnOutline → session-controller, settings, forwarded events and session-log-export; existing jobController is reused, not duplicated | M3-1 | L5 real composition (no `fileUploads`/`fileUpload` test doubles) + `sessionStats`/`turnOutline` projection + archive route probes |
| `CommandRuntimeSurface` Direct facts | RESOLVED_APPLICATION_CONTRACT | §3.2 classifies all nine hooks; no Remote path may call `attachmentForSession`/resolve an Agent | M3-4 | L6 command runtime on wire + static/runtime no-Direct-Agent assertion |
| TUI/extension slash-command callback execution | RESOLVED_APPLICATION_CONTRACT | §3.3 separates Host descriptor/execution authority from Client callback execution; no Client callback enters Host `ctx.commands` | M3-4 | L6 TUI built-in + extension callback execute locally; Host command still executes once through `HostCommandPort` |
| tool-card presenter callbacks | RESOLVED_APPLICATION_CONTRACT | rc.2 Client cards derive from raw event fields; Host `presentCall/presentResult` values are not a Client transport. §3.1/§6 freeze Client-side derivation + generic fallback | M3-4 | live + replay parity for representative shell/edit/read/web/image cards; static no-`ctx.tools` Remote assertion |
| Remote image submit/read | RESOLVED_APPLICATION_CONTRACT | official image prompt parts + Host `session/prompt` admission, Session `imageLimits` projection, and `session/attachment` durable reads cover images without the D4 generic-file receipt path | M3-4/M3-5 | sessionless staging, first-create recheck, model refusal, recalled-image resend, main/child durable read |
| `/rewind` full-history candidate source | RESOLVED_APPLICATION_CONTRACT | `turnOutline` is the whole-log turn index; `loadThrough(seq)` materializes only selected/needed old turns without changing normal bounded transcript retention | M3-1/M3-4 | candidate beyond initial window is visible; generation replacement/abort discards stale picker work |

**No pinned rc.2 M3_BLOCKER remains after these decisions.** The independent
approval-policy read/write/status surface and Remote sandboxed-local-shell mode
are explicit fail-closed unsupported classes rather than deferred carrier
guesses; every supported item has an exact owner, dependency closure and
acceptance proof. The intentionally unsupported skill hot-refresh
behavior is explicit and does not authorize a private Remote event. M3-1 may
start only from this revised contract.

## 11. Final M3 PR train

Common to every stage: no public backend flag, no `dsh --profile pi-tui` behavior
change, Direct remains the production default, and every stage leaves Direct green.
Each stage declares its L1–L6 test layer
(`docs/client-server-migration.md` §M3 test-layer contract).

### M3-1 — official Host + Client runtime composition (no product cutover)

- **Files/owners**: new `src/app/remote/host-runtime.ts`, new
  `src/app/remote/client-runtime.ts`, new `src/runtime/backend-loader.ts`;
  `package.json` declares the exact §2.4 composition peers/dev pins;
  `scripts/pre-m3-architecture-gate.mjs` + its test widen the Remote-composition
  specifier rule. `cordis.patch.yml` does **not** gain experimental Remote rows.
- **Host composition**: dynamically mount the exact §2.4.1 official closure on
  the existing Host Context; reuse the existing `jobController`; no test-double
  `fileUploads`; register both `sessionStats` and `turnOutline`; prove
  `/api/session.export` is registered.
- **Client composition**: exact §2.4.3 order, including official Client
  `fileUpload` before Sessions and the explicit `fileUploads` `/remote`
  contribution. The six-entry scoped loader shim is the only Node adaptation.
- **Behavior axis**: in-process official Connection/Gateway/Remotes/domain
  Clients, readiness, generation/reset observation and reverse disposal. The
  §4.4 Host-local legacy-settings migration settles before Client/settings
  readiness; the Remote Client never reads its own `$DSH_HOME`. No TUI product
  cutover.
- **Tests**: L5 `test/remote-client-runtime.test.ts`: real connect/list,
  fileUpload dependency present, `sessionStats` + `turnOutline` projections
  present, Job roster, reconnect, same-binding probe, archive-route registration, dispose; zero leaked
  subscriptions/fibers/refs; loader allowlist test; Host legacy-migration-before-settings-readiness ordering and a static/runtime no-Client-`profileContext`/legacy-file-read assertion; architecture-gate tests.
- **Must not change**: `src/startup.ts` zero-dependency/static graph;
  `cordis.patch.yml` Direct composition; public CLI/entry exports; production
  backend remains Direct.
- **Entry**: revised M3-0 accepted. **Exit**: the real dependency-closed L5
  composition is green and startup still cannot statically reach Remote
  composition. **Rollback**: delete the dynamic loader edge and the two Remote
  composition owners; normal Host patch is byte-for-byte unaffected.

### M3-2 — Remote Session owner spine

- **Status**: DONE.
- **Files/owners**: `src/app/remote/session-owners.ts`
  (`createRemoteSessionOwnerServices`: `SessionOwnerAccess` +
  `SessionOwnerRetirement` sharing one registry state); the four
  Direct-owner throws in `src/app/session/runtime.ts` are removed (transport-
  neutral owned-generation failures; the fork shape is now the
  publication→open adoption); the Direct-attachment throws in `bootstrap.ts`
  are M3-2 staging no-ops; `clientOwnerOf()` is consumed by the Remote owner
  provider as its sole mapping source.
- **Behavior axis**: exact binding-generation identity (`WeakMap` keyed by the
  exact `SessionReference.binding` object; wrapper transfer commits the new
  authority before releasing the replaced TUI reference exactly once; a
  released wrapper is a dead ownership claim and is refused outright — it can
  never re-resolve, so it cannot publish an owner with no retained Client
  reference, while a fresh retain of a still-live binding re-activates the
  SAME owner); `retain → commit → release` handoff with a
  transaction-local `committedOwner` mapped once; a pre-publication commit
  seam failure releases the acquired NEW owner exactly once (OLD stays
  current); park/release/supersession/fatal cleanup (`whenIdleOrAbort`
  observes the borrowed exact binding's `SessionSnapshot.running` with
  subscribe-then-recheck fencing and full listener cleanup even for a
  synchronous subscription notification, local abort only; `flush`/`preCancel`
  are deliberate no-ops; `retire` releases the authoritative Client reference
  exactly once, state detached before `release()` for reentrancy).
- **Evidence**: L6 `test/remote-session-owners.test.ts` (R1–R12 identity,
  transfer, exactly-once release, released-wrapper refusal, still-live-binding
  re-activation, listener cleanup incl. a synchronous subscription
  notification, parked drain) and
  `test/session-runtime-remote-owner-handoff.test.ts` (H1–H12 exact event
  ordering, supersession, same-id rollover with the stale-subject completion
  fence, fork publication→open adoption, pre-publication commit-throw
  exactly-once release, exit/fatal release; plus the Direct-shaped
  no-extra-open lock);
  `test/runner-session-navigation.test.ts` locks that a production Direct
  `/fork` never performs the extra adoption open.
- **Delivered as**: PR #195, implementation commit
  `c913e3f738ca18fd98539801019a95e28752c695` (base `next` @ `226abeb3`).
  §19.1 adjustment (maintainer-directed during the PR review): the evidence
  anchor is the frozen implementation commit, not a moving PR HEAD — later
  commits on the same PR (review fixes, doc follow-ups) do not update this
  line; the PR itself carries the delivered range and per-commit map.
  Reviewed through a review-fix loop ending in an unconditional accept with
  no unresolved P0/P1/P2, plus post-accept failure-path hardening rounds
  (post-publication commit-seam containment, the awaited pre-publication
  release, and the recall-commit-point boundary — the owner publication is
  the transition's commit point; all mutation-verified).
- **Must not change** (verified unchanged): Direct retirement order
  (`cancel → idle → drain → flush → dispose` in
  `test/runner-session-retirement.test.ts`), transition gate/operation barrier
  semantics, the synchronous commit-order generation bump, fork source-pin /
  command-settlement ordering.
- **Entry**: M3-1. **Exit**: L6 green, Direct behavior unchanged.
  **Rollback**: keep the Direct owner path authoritative; the Remote mapping
  is additive and non-composed (no production call site exists).

### M3-3A — Remote backend closure: session / runtime / catalog / host-file

- **Status**: DONE — delivered as the M3-3A PR (see
  `docs/client-server-migration.md` §M3-3A status for the owners, matrix and
  evidence). Delivered adjustments vs this frozen sketch, all driven by the
  §1.1 0.2.0-rc.1 requalification and the M3-3A plan: the skill adapter is
  `src/runtime/remote/skill-remote.ts`; the subagent allowlist picker
  converged on the official `session.modelCatalog` directory so the port-level
  `listProviders`/`listModels` pair was RETIRED (a semantic-port correction,
  not a shape drift); `HostFilePort` gained the truthful
  `ok`/`unavailable` result split; `SessionReader` gained the `turnOutline`
  and `sessionStatus` projection reads; `PresentationReader` gained the
  official `loadThrough`. The Direct adapters map the same semantics (their
  coupling inventory moved accordingly).
- **Files/owners**: `RemoteInteractionPort` is **not** here (M3-3B);
  complete `model-remote.ts` (`llm/*` provider discovery, default-selection
  decision), `preset-remote.ts` `resolve` coverage, new
  `src/runtime/remote/skill-catalog-remote.ts`, new
  `src/runtime/remote/host-file-remote.ts` (session scope),
  `session-reader-remote.ts` `measureContext` via the `contextPressure`
  projection. `SkillCatalogCapability.onSkillsChange` remains the explicit rc.2
  unsupported class from §2.2/§10; no private forwarded event is added.
- **Behavior axis**: the capabilities the main interaction needs.
- **Tests**: L3 per adapter + selected L4/L5 parity; the published-contract gate.
- **Must not change**: semantic port shapes; Direct adapters.
- **Entry**: M3-1. **Exit**: no Direct fallback; the contract gate is green;
  fail-closed classes match §10. **Rollback**: adapters are non-composed.

### M3-3B — config / interaction / archive / management + Backend assembly

- **Files/owners**: new `src/runtime/remote/config-remote.ts` (generation-aware
  serialized settings mirror, footer trust/custom items, providers,
  credentials, permissions, preset default, the exact
  `subagent-model-selection-settings` namespace), new
  `src/runtime/remote/interaction-remote.ts` (the forwarded approval waterfall
  plus the rc.2 Question contract: `userQuestions.attachWait` timed claim,
  `userQuestions.answer` late answer, and the `userQuestions`/`inbox`
  projections for durable answerability and queued-reply detection —
  Remote `setApprovalPolicy` stays the explicit fail-closed unsupported
  method), new
  `src/runtime/remote/session-archive-remote.ts` (`/api/session.export` through
  the composition-owned fetch), `BackendKind` gains `remote`, Remote `Backend`
  assembly + exact capability advertisement.
- **Behavior axis**: complete semantic Remote backend, or the explicit
  fail-closed classes in §10. Settings never rely on event replay across a
  disconnect and never commit a describe result that raced an invalidation.
- **Tests**: L3 + L5; archive abort; settings initial readiness,
  event-during-describe rerun, disconnect/change/reconnect refresh and
  write/read round trip; approval-policy read/write unsupported behavior and
  hidden/disabled Remote settings row.
- **Must not change**: Direct backend assembly; capability vocabulary semantics.
- **Entry**: M3-2 + M3-3A. **Exit**: complete Remote backend or explicit
  unsupported classification; no Direct Host fallback. **Rollback**: keep
  `BackendKind = 'direct'`.
- **Status: DONE (zero product cutover).** Delivered: the rc.2 family floor
  (`>=0.2.0-rc.2` peers, exact `0.2.0-rc.2` dev/source target at
  `639ed015…`); the reconverged Approval/Question matrices in §2.1; the rc.2
  published-surface gate in `test/remote-official-contract.test.ts`; the
  `QuestionInteractionPort` on BOTH backends plus the timed/continued UI
  lifecycle (`src/app/surface/question-controller.ts`, documented in
  `docs/surface-decisions.md`); the Remote ConfigPort settings mirror with
  the explicit unsupported subsets; the `/api/session.export` Remote archive;
  and ONE experimental Remote `Backend` (`BackendKind 'remote'`,
  `REMOTE_IMPLEMENTED_CAPABILITIES`). Direct remains production/default and no
  production bootstrap selects Remote. See the M3-3B status section of
  `docs/client-server-migration.md` for the file map, the semantic/UI impact
  matrix and the validation evidence.

### M3-4 — main application / command / surface Remote composition

- **Files/owners**: Remote application runtime; internal bootstrap runtime
  selection seam; `app/surface/session-presentation.ts`; submission presentation
  injection; startup resume/sessionless create; switch/new/fork/rewind; ordinary
  prompt/steer/queue; model/preset; transcript hydration + live output;
  assistant-stream ingress from `eventSource`; **all §3.2 command-runtime
  facts** (commands/running/routing/approval/stats/last-assistant/catalog
  refresh/prompt admission); the §3.3 Client command execution plane; whole-log
  `/rewind` over `turnOutline`; Client-derived tool cards; main-Session image
  staging/prompt admission and durable image reads; permission-preset cycling
  through `ConfigPort.permissions.applyPermissionPreset`; Client-owned shell
  gesture/card/presentation over Host-owned execution (`HostUserShellPort`);
  the Remote no-op replacement for the Direct `sessions.flush`
  turn-end hint.
- **Behavior axis**: the first complete main TUI on the in-process wire. The
  command layer keeps its scope/currentness semantics but has no Direct
  Agent/Session resolver on this branch; no TUI/extension callback is executed
  by Host `ctx.commands`, no tool card calls Host `ctx.tools`, Shift+Tab never
  calls Host `permissionPresets.set`, and the Remote shell path never resolves
  Host `ctx.shell`, never spawns in the Client process, and never holds a
  Direct Agent.
- **Tests**: L6 application composition; transcript/status/presentation parity;
  command catalog/claim parity plus local TUI/extension execution; cold paged
  last-assistant; Remote `SessionStats` parity; catalog-refresh stale fence;
  `/rewind` candidate outside the initial event window; representative tool-card
  live/replay parity; sessionless image staging → first-create limit recheck →
  Host model/admission refusal; recalled durable-image resend; busy/queue/image
  prompt-admission parity; permission-cycle async write + stale-generation
  rejection; Remote approval/sandbox status omission; Direct Host-adapter shell
  execution + context submit + cancel; Remote `!`/`!!` fail-closed behavior
  (zero Client spawn, zero Session write) and `!!` zero-Session-write;
  turn-end routing proves the Remote flush hook is a no-op; static/runtime
  assertions that `attachmentForSession`, Host `ctx.commands.execute` for
  Client-owned commands, `ctx.tools.get`, Host `permissionPresets.set`,
  `ctx.shell`, Direct `ctx.attachments`/`ctx.llm` image admission, Direct
  `sessions.flush`, and Client `node:child_process` shell execution are not
  reachable from the Remote branch.
- **Must not change**: Direct default; transition gate/commit order; no fake
  Agent; unsupported standing-skill/generic-file, independent
  approval/sandbox-status, and the entire Remote user-shell class (both `!`
  and `!!`, both policies) stay fail-closed.
- **Entry**: M3-3B. **Exit**: the main TUI **including slash-command runtime**
  runs on the wire with Direct default intact. **Rollback**: remove the
  selection seam's Remote branch.

### M3-5 — secondary surfaces + writer-held recovery

- **Files/owners**: Task Center (`RemoteTaskReader`), Job viewer
  (`RemoteJobObservationPort`, already at the Backend seam), subagent viewer
  (child binding identity + `RemotePresentationReader` + `RemoteSubagentPort`),
  Plugin Manager (`RemotePluginManagerPort`), Remote surface authority, writer-held
  UI recovery, child-viewer durable image reads through `session/attachment`,
  remaining secondary presentation.
- **Behavior axis**: every non-main surface has no `ctx.jobs`/`ctx.subagents`
  dependence on the Remote path.
- **Tests**: L6 viewer/task integration; child/viewer stale-generation fences;
  child durable-image read is addressed by the child Session and cannot repaint
  after viewer replacement.
- **Must not change**: Direct Task/Job/viewer behavior.
- **Entry**: M3-4. **Exit**: no `ctx.jobs`/`ctx.subagents` dependence on the Remote
  path; stale-generation fences proven. **Rollback**: keep the Direct surfaces.

### M3-6 — locality / extensions / reconnect / closure

- **Files/owners**: extension Client-vs-Host Context ownership; locality
  fail-closed rules; reconnect full-surface recovery; shutdown/HMR/fatal cleanup;
  the M3 closure matrix/docs/gates.
- **Behavior axis**: production backend Direct, experimental backend in-process
  wire, no public switch, no external attach, no IPC/TCP.
- **Tests**: locality/reconnect/teardown L5/L6; the M3 closure matrix.
- **Must not change**: the public Extension API; release/publish behavior.
- **Entry**: M3-4 + M3-5. **Exit**: `M3 DONE`, `M4 NOT STARTED`.
  **Rollback**: M3-6 may split closure from implementation if one PR is too large.

## 12. Entry gate

```text
[x] baseline + exact DSH install verified
[x] every Backend property classified
[x] Catalog sub-domains individually classified
[x] ConfigPort method families individually classified
[x] all non-Backend M3 seams classified, including every CommandRuntimeSurface hook, Client command execution, tool-card presentation, rewind history, image submit/read, permission-cycle/local-shell ownership and Host-local legacy-settings migration
[x] every READY row cites an exact rc.2 public Client/Remote source
[x] no Remote row relies on Direct Host service fallback
[x] Host + Client composition dependency closure and disposal owners frozen, including sessionStats + turnOutline projection units
[x] dynamic import/static startup boundary frozen
[x] official aggregate-vs-minimal Client assembly decision made (minimal), including fileUpload closure
[x] Remote exact-generation owner identity frozen
[x] every SessionOwnerRetirement method has Remote semantics
[x] retain-new -> commit -> release-old -> init-surface ordering frozen
[x] all lifecycle/supersession/fatal/HMR reference paths accounted for
[x] Direct assumptions in presentation/viewer/status/tasks inventoried
[x] assistant transient-stream replacement identified
[x] locality matrix complete, including sessionless image staging vs Host image admission, generic-file D4, the Host-owned user-shell execution amendment, and the Remote user-shell fail-closed semantics (both modes)
[x] extension Client/Host Context ownership decided; Client command callbacks never cross into Host ctx.commands
[x] generation replacement/reconnect semantics frozen, including settings mirror invalidation
[x] writer-held recovery stage/behavior frozen (M3-5)
[x] M3-1..M3-6 boundaries finalized
[x] each stage has entry/exit/test/rollback scope
[x] zero unowned UNKNOWN/TBD items; rc.2 skills/change hot invalidation, independent approval/sandbox reads and Remote sandboxed-local-shell execution are explicitly unsupported rather than silently assumed
[x] blocker verdict explicit: M3 ENTRY GREEN
[x] docs updated
[x] normal gates green (recorded in the M3-0 PR)
[x] focused Remote contract/parity lanes green (recorded in the M3-0 PR)
[x] git diff --check clean (recorded in the M3-0 PR)
```

**M3 ENTRY GREEN — no pinned-contract blocker.** The M3-0 PR is documentation-only:
Direct production behavior is unchanged, Remote product composition stays inactive,
and `BackendKind` remains `direct`.

## 13. Validation record

Run at this baseline (documentation-only diff):

| Lane | Command | Result |
|---|---|---|
| build | `pnpm build` | ok (fork + bundle, 17 files) |
| typecheck | `pnpm typecheck:bundle` | ok |
| architecture gate | `pnpm gate:architecture` | `pre-m3-architecture-gate: ok (321 file(s), dependency direction clean)` |
| boundary gate | `pnpm gate:boundary` | `client-boundary-gate: ok (28 file(s), no new Host coupling or stale baseline)` |
| product suite | `pnpm test:product` | 6175 tests, 6175 pass, 0 fail (includes `test/remote-official-contract.test.ts`, the published-contract gate) |
| Remote read/parity lanes | `smoke:remote-session-read`, `smoke:remote-session-read-parity`, `smoke:remote-presentation-parity`, `smoke:remote-surface-authority-parity`, `smoke:remote-task-read-parity`, `smoke:remote-session-lifecycle-parity`, `smoke:remote-d2-fork`, `smoke:remote-d1-closure`, `smoke:remote-d2-closure` | all passed (presentation parity `mismatchCount 0`; lifecycle/fork flows covered; D1 closure `mismatchCount 0`) |
| startup/boundary strictness | `pnpm smoke:boundary`, `pnpm smoke:startup-strictness` | passed — `0.4.9.tgz × DSH 0.1.1-rc.2 (rejected)`, `0.4.9.tgz × DSH 0.1.7-rc.2 (exit 1)` |
| packaging | `pnpm pack:release` | ok — prepack (clean + build + typecheck:bundle + `test:product` 6175 pass) and all eight postpack public-package smokes passed |
| exact-family compatibility | `pnpm compat:dsh:client-family` | passed — 0.1.7-rc.2 exact family (isolated install: session-read, session-read parity, lifecycle parity, D2 closure) |
| whitespace | `git diff --check` (unstaged and staged) | clean |

## Appendix A — plan §18 question index

| # | Question | Answer location |
|---|---|---|
| 1 | Can rc.2 satisfy every `Backend` property without Direct fallback? | §2.1 — 7 of 13 are READY today; the other 6 are Remote-adapter work with a named rc.2 source and named fail-closed classes (no property needs a Direct Host fallback) |
| 2 | Which exact Remote adapter files are missing today? | §2.1 `interaction`, `config`; §2.2 `skills`; §2.3 all; `hostFile`, `sessionArchive`; plus the owner spine (M3-2) |
| 3 | Is `Catalog` fully composable remotely, including Skills? | §2.2 — models/presets yes (provider discovery is adapter work); live skills list yes; Client skill-body read, sessionless standing catalog and live `skills/change` subscription are explicit M3 unsupported classes |
| 4 | Is `ConfigPort` fully expressible on rc.2? | §2.3/§10 — preset catalog/default/apply and most settings/credentials are expressible; authorization, credential-record enumeration/deletion, and the exact independent approval-override read are explicit M3 unsupported classes |
| 5 | Is `InteractionPort` fully expressible on rc.2? | §2.1 + §10 — approval/question yes via forwarded waterfalls; synchronous `setApprovalPolicy` has no exact public rc.2 carrier and is explicitly unsupported on Remote M3 |
| 6 | Can all `HostFilePort` semantics be expressed remotely? | §2.1 + §7 — session scope yes; sessionless scope and existence-based canonicalization no |
| 7 | Can `SessionArchivePort` map to a public rc.2 carrier without private APIs? | §2.1 — yes, HTTP `/api/session.export` via the composition-owned fetch; cancellation is adapter-owned |
| 8 | Which module owns Host/Client Remote composition? | §2.4/§4.1 — `src/app/remote/host-runtime.ts` + `src/app/remote/client-runtime.ts` (M3-1) |
| 9 | Which official Host plugins, Client plugins and generated contributions are mounted? | §2.4 — exact dependency-closed lists and order, including `sessionStats` + whole-log `turnOutline` |
| 10 | Aggregate or minimal mount — which and why? | §2.4 — minimal |
| 11 | What is readiness? | §4.1 — Host closure mounted; Client connection generation defined; Session list `ready`; settings adds its own first-mirror readiness in M3-3B |
| 12 | What is disposed, in what order? | §4.1 |
| 13 | What happens on generation replacement? | §9.1 |
| 14 | What exact object is Remote owner identity? | §5.1 — `SessionReference.binding` (the `SessionBinding` object) |
| 15 | How does one handle map to one stable `SessionOwnerRef`? | §5.2 |
| 16 | What does each retirement method mean remotely? | §5.3 |
| 17 | How are parked Remote owners represented and released? | §5.3 — a no-op today; if parked, a strong per-sessionId reference released by `retireParked` |
| 18 | How does same-id rollover avoid stale-currentness? | §5.1 (`Object.is` on the exact binding object; a new materialization mints a new owner) |
| 19 | Is `retain → commit → release` proven for every transition? | §5.4/§5.5 — exact order is retain/validate → synchronous commit → release old → initialize new surface; Remote owner consumption is M3-2 |
| 20 | What replaces `LiveSessionAgent` for main presentation? | §6 — Client binding generation + `eventSource` + projections |
| 21 | What replaces child exact-Agent identity in viewer mode? | §3 + §6 — child binding generation + Session identity |
| 22 | What replaces Direct assistant-stream install/baseline? | §3 + §6 — `eventSource` transient entries through a subscription ingress |
| 23 | What replaces `ctx.jobs` / `ctx.subagents` on the Remote path? | §3 + §11 M3-5 — `RemoteTaskReader`, `RemoteJobObservationPort`, Client projections |
| 24 | Where do status/command facts come from remotely? | §3 — public Client Session projections/event source plus the §3.2 fact mapping and §3.3 Client command execution plane; permission preset is public, while independent sandbox/approval facts are explicitly omitted rather than inferred; no Direct Agent/Host-callback fallback |
| 25 | Which secondary surfaces are deferred to M3-5? | §11 M3-5 |
| 26 | Which commands/actions remain Client-local? | §3.3 + §7 — TUI built-ins/extension callbacks, terminal/editor, the shell gesture/card/presentation (execution is Host-owned per the shell amendment), local draft/file reads and Client artifact saves; Host commands still execute through `HostCommandPort`; the ENTIRE Remote user-shell class (`!`/`!!`, both policies) is fail-closed rather than borrowing Host `ctx.shell` or spawning Client-side |
| 27 | Which path/file operations are Host-owned? | §7 |
| 28 | Where do extension UI callbacks live? | §8 — Client Context |
| 29 | How do Host extension facts cross without callbacks? | §8 — as serializable public Remote facts |
| 30 | Is M3 entry GREEN or BLOCKED? | §10/§12 — GREEN after the final reverse-coupling closure: composition/lifetime/settings, Client command execution, tool presentation, image ownership, rewind history, permission/access semantics, local-shell locality, Host-local legacy migration, and explicit unsupported classes |
| 31 | What are the final M3-1..M3-6 PR boundaries? | §11 |
| 32 | Which stage first produces a complete experimental wire TUI? | M3-4, including the command runtime (not only transcript/submission) |
| 33 | Which stage handles writer-held UI recovery? | M3-5 |
| 34 | Which stage closes reconnect/HMR/fatal cleanup? | M3-6 (generation semantics frozen in M3-0 §9; observation in M3-1) |
