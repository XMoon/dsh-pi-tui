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
> Review correction: this revision closes both M3-0 review passes. The first
> closed Host/Client dependency closure, CommandRuntimeSurface migration, Session
> handoff ordering and settings-mirror reconnect/race semantics. The final
> reverse-coupling pass additionally freezes Client-owned slash-command execution,
> tool-card presentation, image submit/read ownership, whole-log `/rewind`
> navigation, and the rc.2 skill-invalidation limitation. Those are frozen
> decisions, not TODOs.

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

## 2. Backend capability matrix

### 2.1 The 13 semantic `Backend` properties

`Backend` has `kind` + `capabilities` + the 13 properties below
(`src/runtime/backend.ts:32-67`). The `CAPABILITIES` vocabulary has 12 names
(`src/runtime/capability.ts:18-31`); `pendingInputReader` is a semantic property
without its own capability-name entry, so the two inventories are deliberately not
1:1.

| Backend property | Port (consumer) | Direct impl | Existing Remote impl | Exact rc.2 public source | Status | M3 owner/stage | Acceptance proof |
|---|---|---|---|---|---|---|---|
| `subagent` | `SubagentPort` (viewer prompt, Task Center interrupt) | `runtime/direct/subagent-direct.ts` | `runtime/remote/subagent-remote.ts` | `ClientRemote['subagents'].prompt` / `.interruptByParent`; `dsh-subagent/remote` (`lib/typert.remote-client.d.ts:15-16`); child catalog is the `subagentCatalog` Session projection (`dsh-subagent/lib/types/projection-types.d.ts:64-67`) | READY | M3-3A | L3 `test/remote-subagent-port.test.ts` + published-contract gate `test/remote-official-contract.test.ts:105` |
| `sessionReader` | `SessionReader` (picker list/projection/search, `/status` context row) | `runtime/direct/session-direct.ts` (+`session-search-direct.ts`, `session-projection-direct.ts`) | `runtime/remote/session-reader-remote.ts` (list/blank/projectionBatch/search) | `ISessions.list/refresh/search/binding` (`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:43-153`); `session/search`, `session/projections` Remotes | NEEDS_ADAPTER — only `measureContext` is missing; source is the `contextPressure` / `contextBreakdown` Session projections (`dsh-token-meter/lib/types/projection.d.ts:65-72`), **not** a new RPC | M3-3A | parity test Direct vs Remote `measureContext` on a live Session; the D1 "no Client equivalent" skip is retired here |
| `pendingInputReader` | `PendingInputReader` (queue/steering lanes) | `runtime/direct/pending-input-reader-direct.ts` | `runtime/remote/pending-input-reader-remote.ts` | `session.projections.faceOf('inbox')` (`dsh-agent/lib/types/types.d.ts:52-55`) | READY | M3-3A | L3 `test/remote-pending-input-reader.test.ts` |
| `sessionWriter` | `SessionWriter` (ordinary prompt, Ctrl+S steer, Alt+Up remove, cancel, rename) | `runtime/direct/session-writer-direct.ts` | `runtime/remote/session-writer-remote.ts` | `SessionFace.beginSubmission/prompt/updateQueue/cancel/rename` (`.../client/contract/session.d.ts:73-140`); `session/prompt\|updateQueue\|cancel\|rename` Remotes | READY. `refreshTitle` = INTENTIONAL_UNSUPPORTED_IN_M3; generic client-local file attachment needs the D4 upload receipt and fails closed before dispatch | M3-3A | L3 `test/remote-session-writer.test.ts`; D4 relief exists at `fileUploads/upload` (`dsh-client-file-upload/lib/typert.remote-client.d.ts:14`) |
| `sessionLifecycle` | `SessionLifecycle` (create/open/fork) | `runtime/direct/session-lifecycle-direct.ts` | `runtime/remote/session-lifecycle-remote.ts` | `ISessions.create/retain/fork` (`.../contract/sessions.d.ts:80/52/124`); `session.create\|fork` Remotes | READY | M3-2 (owner handoff) + M3-3A (adapter) | L3 `test/remote-session-lifecycle.test.ts`; L5 `smoke:remote-session-lifecycle-parity` |
| `interaction` | `InteractionPort` (approval prompt, `ask_user_question` provider, session approval policy) | `runtime/direct/interaction-direct.ts` | **none** | approval + question claim/settle = forwarded **waterfall** events `approval/request`, `user-questions/request` (`dsh-api-remotes/lib/types/remote-events.d.ts:16,91`; subscriber `ctx.remote.$on`, `dsh-typert-protocol/lib/types/types.d.ts:367`). There is **no** `approval/*`/`question/*` Remote endpoint. `setApprovalPolicy` has **no dedicated** rc.2 carrier | NEEDS_ADAPTER; `setApprovalPolicy` is a bounded **DECISION_GATE**: M3-3B probes `commands/execute` with the official permission command line (the same public carrier `applyPermissionPreset` already uses); if it cannot preserve the required session-scoped semantics, the affected `/settings` row is explicitly unsupported and fails closed | M3-3B | L3 test that a forwarded `approval/request` waterfall settles through the TUI prompt; L5 either proves the command-line carrier or L3/L6 prove the disabled `/settings` row + notice. `approvalOverrideOf` reads the `permissions` projection (`dsh-permission-presets/lib/types/types.d.ts:47-57`) |
| `catalog` | `Catalog` = `models` + `presets` + `skills` | `runtime/direct/catalog-direct.ts` | models `model-remote.ts`, presets `preset-remote.ts`; **no complete skills adapter** | see §2.2 | NEEDS_ADAPTER | M3-3A | per §2.2 |
| `config` | `ConfigPort` = 9 sub-domains | `runtime/direct/config-direct.ts` | **none** | see §2.3 | NEEDS_ADAPTER | M3-3B | per §2.3 |
| `hostFile` | `HostFilePort` (`@`-mention discovery, send-time existence resolution, draft canonicalization) | `runtime/direct/host-file-direct.ts` | **none** | session/agent-scoped `fileReferences/list(agentId, query, signal)` (`dsh-api-session-controller/lib/typert.remote-client.d.ts:40,68`; `lib/types/file-references.d.ts:24`). Sessionless/workspace-scoped discovery, and existence-based canonicalization, have **no** rc.2 expression | NEEDS_ADAPTER for the session scope; sessionless/workspace scope + existence probe = INTENTIONAL_UNSUPPORTED_IN_M3 (fail closed, §10) | M3-3A (session scope) / M3-5 (viewer scope preference) | L3 test over `fileReferences/list`; a viewer-child prompt must resolve through the child Session identity rather than a cwd string |
| `sessionArchive` | `SessionArchivePort` (`/export`) | `runtime/direct/session-archive-direct.ts` | **none** | HTTP exact route `SESSION_LOG_EXPORT_PATH = "/api/session.export"` (`dsh-session-log-export/lib/types/routes.d.ts:7`), registered Host-side via `HostConnectionFetch.register` (`dsh-client-connection/lib/types/rpc.d.ts:128`); reference client `SessionLogDownloadController` (`.../client/controller.d.ts:44-60`) | NEEDS_ADAPTER — carrier is the composition-owned in-process `Fetch`, never `document.baseURI`; the adapter owns cancellation (rc.2 `download()` takes no signal and `dismiss()` does not abort; only `dispose()` aborts) | M3-3B | L3 + L5 archive stream test including caller abort |
| `hostCommand` | `HostCommandPort` (already-authorized Host command line) | `runtime/direct/host-command-direct.ts` | `runtime/remote/host-command-remote.ts` | `ClientRemote['commands'].execute` (`dsh-commands/remote`, the attachment-preserving path) | READY | M3-3A | L3 `test/remote-host-command.test.ts` |
| `pluginManager` | `PluginManagerPort` (Plugin Manager panel) | `runtime/direct/plugin-manager-direct.ts` | `runtime/remote/plugin-manager-remote.ts` | `ClientRemote['pluginManager']` 12 methods (`dsh-plugin-manager/lib/typert.remote-client.d.ts:25-36`) + forwarded `plugin-manager/*` events | READY | M3-5 | L3 `test/remote-plugin-manager.test.ts` |
| `jobObservation` | `JobObservationPort` (selected Job live tail) | `runtime/direct/job-observation-direct.ts` | `runtime/remote/job-observation-remote.ts` | `IJobs.watchRows/observe/kill/state` (`dsh-api-job-controller/lib/types/client/service.d.ts:45-71`); `job/list\|follow\|kill` Remotes | READY | M3-5 | L3 `test/remote-job-observation.test.ts` |

`BackendKind` gains `remote` **only** in M3-3B, and only together with a Remote
assembly that advertises exactly the capabilities it serves
(`docs/client-server-migration.md` §Hard invariants). M3-0 does not add it.

### 2.2 `catalog` decomposition

| Sub-domain | Port methods | Exact rc.2 public source | Status | Gap / owner |
|---|---|---|---|---|
| `ModelCatalog` | `loadDirectory`, `defaultSelection`, `sessionSelection`, `selectSessionModel` | `session/modelCatalog`, `session/selectModel` Remotes; `modelSelection` projection (`dsh-api-session-controller/lib/types/types.d.ts:20-27`) | READY (adapter exists) | — |
| `ModelCatalog` | `listProviders`, `listModels`, `discoverModels` | `llm/listProviders`, `llm/listConfigurableProviders`, `llm/discoverModels` (`dsh-llm/lib/typert.remote-client.d.ts:15-17`) | NEEDS_ADAPTER | the current adapter returns UNAVAILABLE; the official namespace **does** exist, so this is adapter work for M3-3A, not a gap |
| `ModelCatalog` | `saveDefaultSelection` | no dedicated Remote; the global default lives in settings | NEEDS_ADAPTER | map onto `settings/update\|replace` on the adapter-owned default-model namespace, or classify `unsupported` (today's behavior) for M3-3A |
| `PresetCatalog` | `available`, `roster`, `defaultId`, `resolve`, `selectSessionPreset` | `agentPresets/list\|read\|select` (`dsh-agent-preset-registry/lib/typert.remote-client.d.ts:16-18`); `agentPreset` projection (`lib/types/types.d.ts:57-60`) | READY (adapter exists; verify `resolve` coverage) | — |
| `SkillCatalogCapability` | `listHumanSkills` | `skills/list({sessionId}, signal)` (`dsh-api-session-controller/lib/typert.remote-client.d.ts:37,60`; `lib/types/types.d.ts:245-258`) | NEEDS_ADAPTER | one mapping; `RemoteSurfaceAuthorityReader` already proves the shape |
| `SkillCatalogCapability` | `standing(presetId, cwd)` (sessionless) | **not found** — every skills endpoint is Session-addressed | INTENTIONAL_UNSUPPORTED_IN_M3 | deferred-start skill completion only; owner M3-3A, fail closed |
| `SkillCatalogCapability` | `resolveSkill(name)` (skill body) | **not found** — `skills/list` has no body; there is no `skills/read` | INTENTIONAL_UNSUPPORTED_IN_M3 | the Remote branch never loads/injects a skill body client-side. Human skill gestures stay literal and Host-owned; the `dsh-tool-skill` pre-step performs the body injection for the supported pi-tui composition. Owner M3-3A/M3-4 |
| `SkillCatalogCapability` | `hostLoadsSkillBody(sessionId)` | no rc.2 wire capability bit. For M3's supported in-process pi-tui Host, the generated official preset compositions are a **composition invariant** and mount `@deepseek-ai/dsh-tool-skill` | RESOLVED_COMPOSITION_CONTRACT | M3-1 proves the supported preset compositions carry `tool-skill`; the Remote adapter consumes a composition-owned fact, never probes a hidden Host service. M5/external attach MUST NOT reuse this in-process assumption and fails closed unless a public capability exists |
| `SkillCatalogCapability` | `onSkillsChange(listener)` | Host `skills/change` exists, but rc.2 deliberately does **not** include it in the forwarded Remote-event allowlist; `$on('skills/change')` is not a legal Client event | INTENTIONAL_UNSUPPORTED_IN_M3 | no private forwarding RPC/event. Remote skill catalogs are strongly re-read on Session/binding entry, explicit `/reload`, and `connection/reset`; a live provider-only change between those boundaries may leave autocomplete stale, but execution never injects a stale Client-side body and Host authority decides the gesture. Owner M3-3A/M3-4 |

### 2.3 `ConfigPort` decomposition

| Sub-domain | Port methods | Exact rc.2 public source | Status |
|---|---|---|---|
| `tuiSettings` | `get()`, `replace(doc)` | read `settings/describe()` → `SettingsDescribeValue{namespaces[].value/base/user/revision}` (`dsh-settings/lib/types/types.d.ts:18-63`); write `settings/replace(ns,section,expectedRevision)` / `update` / `mutate` (`dsh-api-settings-controller/lib/typert.remote-client.d.ts:28-32`); invalidation = `settings/document-updated` plus official `connection/reset` | NEEDS_ADAPTER. **Frozen sync/async bridge:** the adapter owns one serialized Client-local mirror. It installs BOTH invalidation listeners **before** the first `settings/describe()`, commits the first snapshot before Remote-backend readiness, reruns on `settings/document-updated` and after every `connection/reset`, and uses an invalidation/generation counter so a describe result that raced an invalidation is discarded and re-read before becoming current. `get()` returns the last committed snapshot synchronously; it may remain the last-known display value while a reconnect refresh is in flight, but it can never become the post-reconnect authoritative revision until the rerun commits. `replace()` waits for a current mirror/revision, performs the Host write, then forces/awaits a serialized describe refresh instead of optimistically mutating the mirror. No event is assumed to replay across disconnect. |
| `footerCommandTrust` | USER-layer mode + trusted command + activation id sets | `settings/describe()` `user` layer per namespace; the TUI's own trust validator stays client-side | NEEDS_ADAPTER |
| `footerCustomItems` | `get()`, `rawForPersistence()` | same USER-layer `user` value | NEEDS_ADAPTER |
| `providers` | `available`, `listCredentialOptions`, `writeProfile`, `writeKeylessProfile` | `llm/listConfigurableProviders` (`dsh-llm/lib/typert.remote-client.d.ts:16`) + `settings/update\|replace` on the adapter-owned profile namespace | NEEDS_ADAPTER |
| `credentials` | `available`, `setReference`, `unsetReference`, `describeReference`, `onChanged` | `credentials/set\|unset\|describe` (`dsh-api-settings-controller/lib/typert.remote-client.d.ts:25-27`); `credentials/reference-updated`, `credentials/record-updated` forwarded events (`dsh-api-remotes/lib/types/remote-events.d.ts:43-47`) | NEEDS_ADAPTER |
| `credentials` | `listRecords()`, `deleteRecord(key)` | **not found** — no `credentials/list`, no record delete; the key grammars are disjoint (`dsh-credentials/lib/types/types.d.ts:86-88`) | INTENTIONAL_UNSUPPORTED_IN_M3 — only `/logout` record enumeration/deletion is affected; owner M3-3B, fail closed with an explicit notice |
| `authorization` | `available`, `listTargets`, `begin`, `onEvent`, `respond`, `cancel` | **not found** — `dsh-authorization` publishes no `./client`/`./remote`/`./typert`; no `authorization` namespace and no authorization event in the forwarded allowlist | INTENTIONAL_UNSUPPORTED_IN_M3 — provider sign-in flows (`/login` device/OAuth path) are unavailable on the experimental backend; the API-key path still works through `credentials/set`. Owner M3-3B, fail closed with an explicit notice. Closest public relief: `account/startSignIn\|cancelSignIn` (a different, DeepSeek-account semantic) |
| `permissions` | `presetNames`, `defaultPreset`, `setDefaultPreset`, `applyPermissionPreset`, `approvalOverrideOf` | `permissionPresets/catalog()` (`dsh-permission-presets/lib/typert.remote-client.d.ts:13`); per-session value = the `permissions` projection (`lib/types/types.d.ts:47-57`); apply = `commands/execute` (the official command line, exactly as Direct `/yolo` does); default = settings | NEEDS_ADAPTER. `approvalOverrideOf` is served by the `permissions` projection; the approval-policy **write** is the same bounded **DECISION_GATE** as `interaction.setApprovalPolicy`, with fail-closed fallback if the public command carrier cannot preserve the required semantics |
| `presetDefault` | `available`, `get`, `set` | `agentPresets/list` default + `settings/*` on `agent-preset-registry.selectedDefault` | NEEDS_ADAPTER |
| `subagentModelSelection` | `available`, `get`, `set` | `settings/describe` + `settings/update\|replace` on the official `subagent-model-selection` section | NEEDS_ADAPTER |

### 2.4 Official Host + Client composition closure

**Frozen decision: strategy B — the TUI owns one explicit minimal composition.**
It mounts only the official Host plugins, Client plugins and generated `/remote`
contributions required by the TUI contract. The
`@deepseek-ai/dsh-api-remotes/client` aggregate assembly is **not** the
production assembly.

This is also the M3/M4 portability boundary: M3 runs the composition in process;
M4 moves the same Host composition behind a local process carrier. Business API
shape does not change when placement changes.

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
M3 owner asserts it exists and never duplicates it.

This table is dependency-closed: `session-controller` is not allowed to be
mounted with a test-only `fileUploads` stand-in, and the archive adapter is not
considered available unless `session-log-export` is mounted. Existing smoke
fixtures that manually `provide('fileUploads', ...)` or `provide('fileUpload',
...)` are dependency-isolation tests, not proof of the product composition.

#### 2.4.2 Client generated Remote contributions

The generated contribution list remains explicit. Every row is a public
`./remote` native-ESM subpath and is mounted by the Client runtime owner:

| Contribution | Namespaces gained | Consumed by |
|---|---|---|
| `@deepseek-ai/dsh-api-session-controller/remote` | `session`, `skills`, `fileReferences` | lifecycle, reader, writer, pending input, skill catalog, surface authority, host file |
| `@deepseek-ai/dsh-api-job-controller/remote` | `job` | `IJobs` / job observation |
| `@deepseek-ai/dsh-commands/remote` | `commands` | Host command port, surface authority, permission apply |
| `@deepseek-ai/dsh-subagent/remote` | `subagents` | subagent port, viewer prompt |
| `@deepseek-ai/dsh-agent-preset-registry/remote` | `agentPresets` | preset catalog |
| `@deepseek-ai/dsh-plugin-manager/remote` | `pluginManager` | plugin manager port |
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
  -> Connection (installConnection + composition-owned rpc carrier)
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
| `PresentationReader` | `src/app/surface/session-presentation.ts:74-82` (injected Direct facts) | `runtime/remote/presentation-read-remote.ts` (READY) | `SessionBinding.eventSource` + `SessionFace` snapshot + `loadOlder()` | NEEDS_APPLICATION_SEAM | M3-4 |
| rewind candidate / deep-history source | `openRewindPicker` → `collectRewindCandidates(session.snapshotEvents())` today | none | whole-log `turnOutline` projection for candidate identity/preview + `SessionFace.loadThrough(seq)` only when the selected/visible turn needs its loaded events; exact binding-generation fence around the operation | NEEDS_APPLICATION_SEAM | M3-4 |
| tool-card presentation | `bootstrap.ts` resolves `ctx.tools.get(name, liveAgent)` and calls Host `ToolDefinition.presentCall/presentResult` | none | Client derives cards from raw durable/transient `tool/call` + `tool/result` fields and persisted metadata/content; Host presenter callbacks never cross the Client contract. TUI/extension renderers stay Client-owned; unknown/custom tools use the existing bounded generic/raw fallback | NEEDS_APPLICATION_SEAM | M3-4 |
| image draft / prompt preparation | `bootstrap.ts` reads `ctx.attachments.imageLimits`, `ctx.attachments.saveImages`, `ctx.llm.resolveModelInfo` during Direct preparation | none | Client-local draft bytes + safety caps; after a Session exists, validate against the Session `imageLimits` projection when available and serialize official `PromptContentPart {type:'image', mediaType, data, name?}`. Host `session/prompt` owns durable admission and model-modality refusal | NEEDS_APPLICATION_SEAM | M3-4 |
| durable Session image read | `surface.start(...readImage)` calls Host `ctx.attachments.readImage(ref)` | none | official `session/attachment({sessionId, attachmentId})`, addressed by the exact main/child Session and fenced by binding generation. Recalled images that need re-send bytes use the same authorized read before prompt serialization | NEEDS_APPLICATION_SEAM | M3-4 main / M3-5 child viewer |
| `TaskReader` | `src/task-browser-runtime.ts`, `src/app/surface/runtime.ts:279-305` | `runtime/remote/task-read-remote.ts` (READY) | `projectionsBySession.subagentCatalog` + `IJobs.watchRows`; full descendant tree stays an upstream gap | NEEDS_APPLICATION_SEAM | M3-5 |
| `SurfaceAuthorityReader` | shadow only today | `runtime/remote/surface-authority-remote.ts` (READY) | `commands/list` + `skills/list` | NEEDS_APPLICATION_SEAM | M3-4 |
| `SubmissionPresentation` | `src/app/submission/controller.ts:431` (hardwired Direct) | `RemoteSubmissionPresentation` (`src/submission-presentation.ts:129-161`) | official `SessionSnapshot.pendingSubmissions` (`.../client/contract/snapshot.d.ts:58-61`) | NEEDS_APPLICATION_SEAM (only hardwired non-Backend source) | M3-4 |
| Assistant transient stream | `src/app/bootstrap.ts:1961-1969`, `session-presentation.ts:317`, `viewer-runtime.ts:400` | **no port/installer**; reconstructed by `RemotePresentationReader.liveInputs` | `SessionBinding.eventSource` transient entries (`AssistantLiveChunkEvent`, `SessionEventSource.subscribe`); identity = binding generation, never an Agent object | NEEDS_APPLICATION_SEAM | M3-4 (main) / M3-5 (viewer) |
| main Session binding/projection source | `src/app/bootstrap.ts:390-412`, `src/app/session/**` | `SessionHandle.client` + `acquireMainSurfaceReference` / `pinExistingGeneration` | `SessionOwnerRef` → `SessionBinding` map | NEEDS_APPLICATION_SEAM | M3-2 |
| viewer child binding/projection source | `src/app/surface/viewer-runtime.ts:58-64,216-237` | `RemoteTaskReader` catalog + `RemotePresentationReader` + `RemoteSubagentPort` | child binding generation + Session id (never `sessionId` alone) | NEEDS_APPLICATION_SEAM | M3-5 |
| status: current session/model | `status-runtime.ts:196-249` | `RemoteModelCatalog.sessionSelection()` | `modelSelection` projection + Client list `cwd` | NEEDS_APPLICATION_SEAM | M3-4 |
| status: cwd/workspace | `status-runtime.ts:171,254-261` | `RemoteSessionReader.list()` row `cwd` | Client list/binding `cwd`; git branch stays Client-local | NEEDS_APPLICATION_SEAM | M3-4 |
| status: preset/composition | `status-runtime.ts:244-248` | `RemotePresetCatalog` | `agentPreset` projection | NEEDS_APPLICATION_SEAM | M3-4 |
| status: permissions/sandbox/approval | `status-runtime.ts:302-414` | none | `permissions` projection (`dsh-permission-presets/lib/types/types.d.ts:47-57`); `permissionPresets/catalog` for options | NEEDS_ADAPTER | M3-3B / M3-4 |
| status: plan | `status-runtime.ts:337-339`, `session-presentation.ts:332` | none | `plan` projection (`dsh-plan-mode/lib/types/types.d.ts:42-45`) | NEEDS_ADAPTER | M3-4 |
| status: goal | `status-runtime.ts:485-503` | none (fold) | `goal` projection / `goal/change` durable events | NEEDS_ADAPTER | M3-4 |
| status: todos | `tui-app.ts` todo dock | none (fold) | `todos` projection (`dsh-tool-todo/lib/types/types.d.ts:38-45`) | NEEDS_ADAPTER | M3-4 |
| status: usage/tokens | `status-runtime.ts:341` | none (fold) | `tokenUsage` projection (`dsh-token-meter/lib/types/projection.d.ts:65-67`) | NEEDS_ADAPTER | M3-4 |
| status: context pressure/window | `status-runtime.ts:298-445` | `measureContext` returns `undefined` | `contextPressure` / `contextBreakdown` projections (`dsh-token-meter/lib/types/projection.d.ts:68-72`) | NEEDS_ADAPTER (revises the outdated D1 skip) | M3-3A |
| status: host/profile facts | `status-runtime.ts:268-271` | n/a | Client-local process facts | READY (Client-local) | — |
| status: running/activity | `tui-app.ts` activity projection | Client list `running` bit | folded event window + Client `running`; task counts follow M3-5 | NEEDS_APPLICATION_SEAM | M3-4 / M3-5 |

### 3.2 Command runtime facts (previously omitted)

`src/app/command/runtime.ts` deliberately hides Direct objects behind
`CommandRuntimeSurface`, but the surface itself is still a migration contract.
M3-0 freezes every hook below; M3-4 must not satisfy any of them by resolving a
Direct Agent/Session behind the Remote path.

| `CommandRuntimeSurface` hook | Current Direct source | Frozen Remote/application replacement | Stage / acceptance |
|---|---|---|---|
| `listScopedCommands()` | Host command registry via the Direct composition | `RemoteSurfaceAuthorityReader` / `commands/list`, keyed by the current live Session scope; completion synthesis stays Client-local | M3-4; command claim/collision parity |
| `sessionRunning(sessionId)` | exact Direct Agent `.status` | exact `SessionBinding`/`SessionSnapshot.running`; currentness is the existing `SessionScopeAuthority` + binding-generation fence | M3-4 |
| `sessionRouting(sessionId)` | Direct Agent `options.provider/model` + `session.header.cwd` | provider/model from `modelSelection` projection; cwd from Client Session list/binding | M3-4 |
| `approvalOverride(sessionId)` | `ConfigPort.permissions.approvalOverrideOf` (already semantic) | same `ConfigPort` implementation over the `permissions` projection | M3-3B, consumed by M3-4 |
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
| TUI built-in command | Client-local static registration | Client Context / TUI runner; never registered into Host `ctx.commands` |
| TUI skill wrapper | Client-local command surface; live skill metadata from §2.2 | Client Context validates/claims the advertised skill name, then converges the Remote execution to the official literal `/name [instructions]` user gesture; Host `dsh-tool-skill` pre-step resolves the current definition and injects the body. The Remote branch never calls Client `skills/read` because rc.2 exposes none |
| Extension command contribution | Client extension registry | the contribution callback executes in the Client Context that owns it |

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
            '- in-process ClientConnectionRpc (composition-owned bridge)
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
| in-process RPC bridge | composition-owned `ClientConnectionRpc` over the Host connection/Gateway carrier | available before Client Connection install | follows Host connection generation | with RemoteHostRuntime | close/abort may synchronously settle client requests |
| Client Context | `client-runtime.ts` exact sequence from §2.4.3 | connection generation defined + Session list phase `ready`; Job roster has its own readiness and must be proven by M3-1 L5 but does not block main-session readiness | owner observes official generation/reset only; no watchdog | adapters/refs first, then Client fiber in reverse mount order | plugin disposers/generation subscribers may fire synchronously |
| Connection | official Client plugin with `installConnection({transport:{rpc}})` | `generation.getSnapshot() !== undefined` | official loop; `connection/reset` is cache invalidation | late in Client reverse-dispose | reset clears generation synchronously |
| Gateway | official Client plugin | after Connection generation | owns `$events`, streams and forwarded events | before Connection | listeners are removed while Context is live |
| `/remote` contributions | explicit §2.4.2 list | namespace mount complete | follow Gateway generation | reverse mount order | namespace unregister may invalidate readers synchronously |
| Client fileUpload | official Client plugin after `fileUploads` Remote contribution | service provided | follows Gateway generation | before Gateway, after Session/Job users are gone | no Worker/browser path may be reached merely by mounting it |
| Client Sessions | official Session Client after Client fileUpload | `list.phase === 'ready'` | owns baseline/history recovery | before fileUpload/Gateway | final `release()` can synchronously retire a binding scope |
| Client Jobs | official Job Client | first roster frame for job surfaces | follows Gateway stream generation | before lower Client services | watchers/listeners settle on dispose |
| Remote backend/application adapters | TUI owners | after required Client readiness and (for settings) first mirror commit | capture + re-check connection/binding generation | **first** | abort/unsubscribe before Context disposal |
| main `SessionReference` | `acquireMainSurfaceReference` → `sessions.retain(tuiMainView)` | no `ready` await required to establish identity | exact `binding` object remains the owner identity | release exactly once before Client Context | last release may retire binding synchronously |
| bounded operation reference | `pinExistingGeneration` → `sessions.retain(tuiOperation)` after borrow | no | rejects replacement by `Object.is` | release at operation end | never cold-opens a replacement generation |

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
4. use the public Connection `installConnection(ctx, { transport: { rpc } })`
   hook with the composition-owned in-process `ClientConnectionRpc`;
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

Current code already commits the new owner synchronously before `retireOld`
(`src/app/session/commit-order.ts:69-100`, `src/app/session/runtime.ts:226-299`).
M3-2 preserves that ordering and moves `initLiveSession` to the post-release
surface phase.

Current Direct-owner assumptions M3-2 must remove: `runtime.ts:239-241,262-266,532-533,686-687`
(the four "without a Direct owner" throws), `runtime.ts:431-434,726` (`fromHandle`),
`bootstrap.ts:485-493` (`initLiveSession`/`refreshLiveCatalog`), and
`bootstrap.ts:886-889` — `clientOwnerOf()` (`session-lifecycle-port.ts:266-269`)
exists but is never consumed by the runner.

### 5.5 Lifecycle reference-ownership table

| # | Path | Acquire | Transfer | Release on success | Release on supersession/failure | Visible owner |
|---|---|---|---|---|---|---|
| 1 | startup open/resume | `lifecycle.open` (`bootstrap.ts:651`) | `publishResumedOwner` synchronously (`runtime.ts:719-735`) | `retireOwnedSession` (`runtime.ts:757-832`) | `requireOpened` throws; Remote mid-acquire abort releases (`session-lifecycle-remote.ts:362-364`) | core owner after publish |
| 2 | sessionless first create | `lifecycle.create` (`runtime.ts:864-872`) | `commitFirstSession` (`runtime.ts:688-711`) | retirement on exit/HMR | `requireCreated` throws; Remote superseded releases (`:338-341`) | sessionless until commit |
| 3 | `/new` | `transitionTo` create (`bootstrap.ts:1184`) | commit (`runtime.ts:226-245`) | old owner `runtime.ts:247-261` | pre-commit abort, zero side effects | child after commit |
| 4 | ordinary switch/open | `lifecycle.open` (`runtime.ts:361-364`) | commit | old owner | Remote `unavailable`/`cancelled` produce no owner | old stays current on failure |
| 5 | `/fork` success | `lifecycle.fork` publication-only | `adoptFork` commit (`runtime.ts:518-597`) | source retired (`:555-572`) | child parked if not current; Remote child has no `client` | child after adoption |
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
| `sessions.flush(agent.session)` (`bootstrap.ts:1941-1950`) | durable turn barrier | no public Client flush verb → Host-owned (no-op on Remote) | session | M3-5 |
| `agentNow()` / `registeredAgentIs` / `queueAgentFor(childId)` (`bootstrap.ts:412,1519,1772`) | current owner identity, exact Agent fence, child queue address | binding generation identity + child Session identity + `SessionWriter.updateQueue` | app/session | M3-2 / M3-5 |
| `ctx.jobs` / `ctx.subagents` (`bootstrap.ts:1792-1826`) | Task Center roster/detail | `RemoteTaskReader` + `RemoteJobObservationPort` + `IJobs.watchRows` | task surface | M3-5 |
| `sessions.get` / `agents.get().status` / `sessionQuery.observeSession` (viewer) | live + cold child transcript/activity | child binding generation + `RemotePresentationReader` + `RemoteTaskReader` | viewer | M3-5 |
| `new DirectSubmissionPresentation` (`submission/controller.ts:431`) | optimistic echo before the authoritative occurrence | official `SessionSnapshot.pendingSubmissions` | submission | M3-4 |
| command runtime `sessionStats` / `lastAssistantText` | `/status`, `/copy`/read facades need owner-scoped historical facts | §3.2 Remote metrics + paged last-assistant readers over exact binding/projections | command/application | M3-4 |
| command runtime exact-Agent catalog target | live `/reload`/catalog refresh must not retarget after switch | exact `SessionScope` + binding generation; `RemoteSurfaceAuthorityReader` + `SkillCatalogCapability` | command/application | M3-4 |
| command runtime `promptAdmission(agent, ...)` | Direct per-Agent prompt/image admission | writer/scope admission + Client-local preflight + official Session write; unsupported attachment class fails before dispatch | submission/command | M3-4 |
| TUI/extension command callback via `ctx.commands.execute` | normalize/execute Client-owned slash-command callbacks | Client-local execution plane from §3.3; Host commands alone cross `HostCommandPort` | command/application | M3-4 |

No fake `Agent` wrapper is introduced anywhere, including inside the command runtime.
No Host callback is moved into the Client: tool presentation and TUI command
callbacks become Client-owned behavior, while Host tool/command semantics remain
Host-owned.

## 7. Locality matrix

Semantic ownership is stated independent of transport placement; M3 composes an
in-process wire, M4/M5 change placement only.

| Operation/state | Client-local | Host-owned | Wire seam | M3 behavior |
|---|---:|---:|---|---|
| terminal rendering, editor, overlays, keybindings | ✓ | | none | local |
| clipboard / OSC 52 | ✓ | | none | local (never backend-determined) |
| external editor | ✓ | | none | local |
| local `!` / `!!` shell | ✓ | | none | local (Client process, Client cwd); unchanged under M3's in-process wire |
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

M3 is an in-process wire on one machine, so the "explicitly split" operations keep
their current Client-local behavior unchanged under M3: `!`/`!!` (spawns in the TUI
process with the TUI cwd), `/image` and `/attach` local reads, the external editor,
`/export`/`/transcript` file writes (Save Location), and `/open`-style working
directory changes. A local `/image` read is only **staging**: before a Session
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
domain state is mounted: M3's answer is that a plugin contributing UI is loaded in
the Client Context and reads Host domain state only through public Remote facts;
a Host-only extension stays in the Host Context. M3-6 owns any rebinding this
requires. The public Extension API keeps its semantics, and no callback crosses
the wire (AGENTS.md hard rule; `docs/extension-api.md`).

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
| full descendant subagent tree | POST_M3_NON_BLOCKING | no exact official equivalent (D1 skip) | post-M3 / upstream | direct-child catalog parity only |
| `session.createdAt`, Direct `live` bit | POST_M3_NON_BLOCKING | no public Client field / different `running` semantic | post-M3 | D1 ledger skips |
| cross-client concurrency (Web+TUI, reconnect, cold resume, Host crash) | POST_M3_NON_BLOCKING (M8) | DSH `SessionHandle`/`SessionWriteLease` is the writer authority; the full matrix is an M8 deliverable | M8 | M8 proof |
| `interaction.setApprovalPolicy` carrier; `permissions.setDefaultPreset` | DECISION_GATE_WITH_FAIL_CLOSED_DEFAULT | no dedicated rc.2 approval-policy endpoint. M3-3B first probes `commands/execute` using the official permission command line (the same public carrier already used by permission-preset apply); if that does not preserve the required session-scoped semantics, the affected `/settings` row is explicitly unsupported. There is no hidden Host fallback | M3-3B | L5 proves the command carrier **or** L3/L6 prove the disabled row and notice; either outcome closes the gate |
| synchronous `TuiSettingsConfig.get()` over async settings Remote | RESOLVED_ADAPTER_CONTRACT | §2.3 freezes listener-before-read, serialized describe, `settings/document-updated` + `connection/reset` invalidation, in-flight invalidation rerun and post-write authoritative refresh | M3-3B | race tests: event-during-read, disconnect-change-reconnect, write/read round trip |
| Client runtime uses Web module-loader bundles | RESOLVED_PACKAGING_ADAPTATION | exact six-entry shim allowlist and lifecycle are frozen in §2.4.3/§4.2; `/remote` contributions stay native ESM | M3-1 | L5 connect/list/reconnect/dispose + allowed/forbidden bundle-loader tests; no browser fallback reached |
| Host composition dependency closure | RESOLVED_COMPOSITION_CONTRACT | §2.4.1 includes Host connection → fileUploads → sessionStats/turnOutline → session-controller, settings, forwarded events and session-log-export; existing jobController is reused, not duplicated | M3-1 | L5 real composition (no `fileUploads`/`fileUpload` test doubles) + `sessionStats`/`turnOutline` projection + archive route probes |
| `CommandRuntimeSurface` Direct facts | RESOLVED_APPLICATION_CONTRACT | §3.2 classifies all nine hooks; no Remote path may call `attachmentForSession`/resolve an Agent | M3-4 | L6 command runtime on wire + static/runtime no-Direct-Agent assertion |
| TUI/extension slash-command callback execution | RESOLVED_APPLICATION_CONTRACT | §3.3 separates Host descriptor/execution authority from Client callback execution; no Client callback enters Host `ctx.commands` | M3-4 | L6 TUI built-in + extension callback execute locally; Host command still executes once through `HostCommandPort` |
| tool-card presenter callbacks | RESOLVED_APPLICATION_CONTRACT | rc.2 Client cards derive from raw event fields; Host `presentCall/presentResult` values are not a Client transport. §3.1/§6 freeze Client-side derivation + generic fallback | M3-4 | live + replay parity for representative shell/edit/read/web/image cards; static no-`ctx.tools` Remote assertion |
| Remote image submit/read | RESOLVED_APPLICATION_CONTRACT | official image prompt parts + Host `session/prompt` admission, Session `imageLimits` projection, and `session/attachment` durable reads cover images without the D4 generic-file receipt path | M3-4/M3-5 | sessionless staging, first-create recheck, model refusal, recalled-image resend, main/child durable read |
| `/rewind` full-history candidate source | RESOLVED_APPLICATION_CONTRACT | `turnOutline` is the whole-log turn index; `loadThrough(seq)` materializes only selected/needed old turns without changing normal bounded transcript retention | M3-1/M3-4 | candidate beyond initial window is visible; generation replacement/abort discards stale picker work |

**No pinned rc.2 M3_BLOCKER remains after these decisions.** The approval-policy
row is a bounded implementation decision with an already-frozen fail-closed
outcome; every other formerly open item now has an exact owner, dependency
closure and acceptance proof. The intentionally unsupported skill hot-refresh
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
  Clients, readiness, generation/reset observation and reverse disposal. No TUI
  product cutover.
- **Tests**: L5 `test/remote-client-runtime.test.ts`: real connect/list,
  fileUpload dependency present, `sessionStats` + `turnOutline` projections
  present, Job roster, reconnect, same-binding probe, archive-route registration, dispose; zero leaked
  subscriptions/fibers/refs; loader allowlist test; architecture-gate tests.
- **Must not change**: `src/startup.ts` zero-dependency/static graph;
  `cordis.patch.yml` Direct composition; public CLI/entry exports; production
  backend remains Direct.
- **Entry**: revised M3-0 accepted. **Exit**: the real dependency-closed L5
  composition is green and startup still cannot statically reach Remote
  composition. **Rollback**: delete the dynamic loader edge and the two Remote
  composition owners; normal Host patch is byte-for-byte unaffected.

### M3-2 — Remote Session owner spine

- **Files/owners**: new `src/app/remote/session-owners.ts`
  (`RemoteSessionOwnerAccess` + `RemoteSessionOwnerRetirement`); remove the four
  Direct-owner throws in `src/app/session/runtime.ts` and the Direct-attachment
  throws in `bootstrap.ts`; consume `clientOwnerOf()`.
- **Behavior axis**: exact binding-generation identity; `retain → commit → release`
  handoff; park/release/supersession/fatal cleanup.
- **Tests**: L6 ownership (`test/runner-session-retirement.test.ts` extensions +
  a new Remote owner-mapping L6 test); same-id/new-generation stays distinct; no
  reference leak or premature release.
- **Must not change**: Direct retirement order (`cancel → idle → drain → flush →
  dispose`), transition gate/operation barrier semantics, the synchronous
  commit-order generation bump.
- **Entry**: M3-1. **Exit**: L6 green, Direct behavior unchanged. **Rollback**:
  keep the Direct owner path authoritative; the Remote mapping is additive.

### M3-3A — Remote backend closure: session / runtime / catalog / host-file

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
  credentials, permissions, preset default, subagent-model-selection), new
  `src/runtime/remote/interaction-remote.ts` (forwarded waterfalls + the
  `setApprovalPolicy` decision gate), new
  `src/runtime/remote/session-archive-remote.ts` (`/api/session.export` through
  the composition-owned fetch), `BackendKind` gains `remote`, Remote `Backend`
  assembly + exact capability advertisement.
- **Behavior axis**: complete semantic Remote backend, or the explicit
  fail-closed classes in §10. Settings never rely on event replay across a
  disconnect and never commit a describe result that raced an invalidation.
- **Tests**: L3 + L5; archive abort; settings initial readiness,
  event-during-describe rerun, disconnect/change/reconnect refresh and
  write/read round trip; approval-policy gate either proven or fail-closed.
- **Must not change**: Direct backend assembly; capability vocabulary semantics.
- **Entry**: M3-2 + M3-3A. **Exit**: complete Remote backend or explicit
  unsupported classification; no Direct Host fallback. **Rollback**: keep
  `BackendKind = 'direct'`.

### M3-4 — main application / command / surface Remote composition

- **Files/owners**: Remote application runtime; internal bootstrap runtime
  selection seam; `app/surface/session-presentation.ts`; submission presentation
  injection; startup resume/sessionless create; switch/new/fork/rewind; ordinary
  prompt/steer/queue; model/preset; transcript hydration + live output;
  assistant-stream ingress from `eventSource`; **all §3.2 command-runtime
  facts** (commands/running/routing/approval/stats/last-assistant/catalog
  refresh/prompt admission); the §3.3 Client command execution plane; whole-log
  `/rewind` over `turnOutline`; Client-derived tool cards; main-Session image
  staging/prompt admission and durable image reads.
- **Behavior axis**: the first complete main TUI on the in-process wire. The
  command layer keeps its scope/currentness semantics but has no Direct
  Agent/Session resolver on this branch; no TUI/extension callback is executed
  by Host `ctx.commands`, and no tool card calls Host `ctx.tools`.
- **Tests**: L6 application composition; transcript/status/presentation parity;
  command catalog/claim parity plus local TUI/extension execution; cold paged
  last-assistant; Remote `SessionStats` parity; catalog-refresh stale fence;
  `/rewind` candidate outside the initial event window; representative tool-card
  live/replay parity; sessionless image staging → first-create limit recheck →
  Host model/admission refusal; recalled durable-image resend; busy/queue/image
  prompt-admission parity; static/runtime assertions that `attachmentForSession`,
  Host `ctx.commands.execute` for Client-owned commands, `ctx.tools.get`, and
  Direct `ctx.attachments`/`ctx.llm` image admission are not reachable from the
  Remote branch.
- **Must not change**: Direct default; transition gate/commit order; no fake
  Agent; unsupported standing-skill/generic-file classes stay fail-closed.
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
[x] all non-Backend M3 seams classified, including every CommandRuntimeSurface hook, Client command execution, tool-card presentation, rewind history and image submit/read
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
[x] locality matrix complete, including sessionless image staging vs Host image admission and generic-file D4
[x] extension Client/Host Context ownership decided; Client command callbacks never cross into Host ctx.commands
[x] generation replacement/reconnect semantics frozen, including settings mirror invalidation
[x] writer-held recovery stage/behavior frozen (M3-5)
[x] M3-1..M3-6 boundaries finalized
[x] each stage has entry/exit/test/rollback scope
[x] zero unowned UNKNOWN/TBD items; rc.2 skills/change hot invalidation is explicitly unsupported rather than silently assumed
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
| 4 | Is `ConfigPort` fully expressible on rc.2? | §2.3 — all but authorization and credential-record enumeration/deletion |
| 5 | Is `InteractionPort` fully expressible on rc.2? | §2.1 + §10 — approval/question yes via forwarded waterfalls; `setApprovalPolicy` is an owned M3-3B gate |
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
| 24 | Where do status/command facts come from remotely? | §3 — Client Session projections/event source plus the §3.2 fact mapping and §3.3 Client command execution plane; no Direct Agent/Host-callback fallback |
| 25 | Which secondary surfaces are deferred to M3-5? | §11 M3-5 |
| 26 | Which commands/actions remain Client-local? | §3.3 + §7 — TUI built-ins/extension callbacks, terminal/editor/local shell, local draft/file reads and Client artifact saves; Host commands still execute through `HostCommandPort` |
| 27 | Which path/file operations are Host-owned? | §7 |
| 28 | Where do extension UI callbacks live? | §8 — Client Context |
| 29 | How do Host extension facts cross without callbacks? | §8 — as serializable public Remote facts |
| 30 | Is M3 entry GREEN or BLOCKED? | §10/§12 — GREEN after both closure passes: composition/lifetime/settings plus Client command execution, tool presentation, image ownership, rewind history and explicit skill-invalidation limitation |
| 31 | What are the final M3-1..M3-6 PR boundaries? | §11 |
| 32 | Which stage first produces a complete experimental wire TUI? | M3-4, including the command runtime (not only transcript/submission) |
| 33 | Which stage handles writer-held UI recovery? | M3-5 |
| 34 | Which stage closes reconnect/HMR/fatal cleanup? | M3-6 (generation semantics frozen in M3-0 §9; observation in M3-1) |

