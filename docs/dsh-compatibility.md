# DeepSeek Harness compatibility

This document is the source of truth for the `dsh-pi-tui`/DSH version
boundary.

## Runtime compatibility

The DSH versions below are the published tags in the official [DeepSeek Harness
release list](https://github.com/deepseek-ai/deepseek-harness/releases). Each
fallback was checked against the peer manifest at its corresponding TUI tag.

| dsh-pi-tui line | Official DeepSeek Harness tags for the recommended pairing | Policy |
|---|---|---|
| `0.2.x` (latest `v0.2.2`) | `dsh-v0.1.0-rc.8` | Legacy runtime line |
| `0.3.x` | `dsh-v0.1.1-rc.1`, `dsh-v0.1.1-rc.2` | Legacy runtime line |
| `0.4.0-alpha.1` | `dsh-v0.1.2-alpha.2`, `dsh-v0.1.2-alpha.3` | Earlier 0.4 prerelease |
| `0.4.0-alpha.2` | `dsh-v0.1.2-alpha.4`, `dsh-v0.1.2-alpha.5` | Previous 0.4 prerelease |
| `0.4.1` (published) | `dsh-v0.1.2-rc.1` | Historical stable |
| `0.4.3-alpha.2` (historical next npm line) | `dsh-v0.1.3-alpha.2` | Last official runtime tag for this TUI line |
| `0.4.6` (published stable, previous) | `dsh-v0.1.5-rc.1`, `dsh-v0.1.5-rc.2` | Previous stable; validated against the published npm rc.1 family |
| `0.4.7-alpha.1` (published) | `dsh-v0.1.6-alpha.1` | Published forward-integration target; keeps its own alpha.1 contract and is the fallback TUI for an alpha.1 runtime |
| `0.4.7-alpha.2` (published) | `dsh-v0.1.6-alpha.2` | Released forward-integration line; first line on the alpha.2 Client Session contract and the fallback TUI for a 0.1.6-alpha.2 runtime |
| `0.4.8` (published stable, previous) | `dsh-v0.1.7-rc.1` | Previous stable line: the 0.1.7 profile-owned Config, declarative preset registry, SessionId-owned jobs, execute/result shell, and official Client projections/ClientJobs |
| `0.5.1` (published stable, latest) | `dsh-v0.2.0-rc.2` | Current stable line: requires the published 0.2.0-rc.2 exact family — the Question lifecycle consumes the rc.2-only published contracts (`userQuestions.attachWait`/`answer` Remotes and the `userQuestions` Session projection), so the whole DSH peer floor moves to `>=0.2.0-rc.2` |
| `0.5.3` (next-line candidate, unpublished and untagged) | `dsh-v0.2.1-rc.2` | Candidate identity for the next line: the published 0.2.1-rc.2 family is both the exact validation target and the whole peer floor (`>=0.2.1-rc.2`). Reserved candidate only — no tag, no npm publication, and it is NOT the current `@next` dist-tag (which still serves `0.5.2-rc.1`); `pending qualification` |
| — (no TUI) | `dsh-v0.2.1-rc.1` | The intermediate rc.1 release has no released TUI in this matrix; it is deliberately recorded without a `tui` value, and `0.5.3` must never be claimed for it |
| `0.5.2-rc.1` (published next-channel preview) | `dsh-v0.2.0-rc.2` | Previous `@next` preview: reserved in `next` and published to the npm `next` dist-tag on 2026-10-17. Its whole peer floor stays `>=0.2.0-rc.2`, so it does not cover the 0.2.1-rc.2 target — which is why the 0.5.3 candidate moves the floor |
| `0.5.0` (published stable, previous) | `dsh-v0.2.0-rc.1` | Previous stable line: qualifies the published 0.2.0-rc.1 exact family (Koffi pinned 3.1.1) while keeping the `>=0.1.7-rc.2` runtime floor, converges the install allow list to `@deepseek-ai/dsh-subprocess-local,koffi,node-pty`, retires the `fs-ext` consumer build, and passes Source Mode against the 0.2.0-rc.1 release commit |
| `0.4.9` (published stable, previous) | `dsh-v0.1.7-rc.2` | Previous stable line: retires the rc.1 preset chooser policy, converges Direct model selection with the rc.2 availability/background-save semantics, and proves rc.2 dynamic tool updates through the existing P1 surfaces |
| No historical fallback | `dsh-v0.1.0-rc.7`, `dsh-v0.1.2-alpha.1`, `dsh-v0.1.3-alpha.1`, `dsh-v0.1.5-alpha.1`, `dsh-v0.1.5-alpha.2` | Upgrade DSH to a supported release |

The table is keyed to the official release tags above. Do not widen a pairing
from a package peer lower bound alone: npm/node-semver excludes a prerelease
whose major/minor/patch tuple differs from the comparator's prerelease tuple.
For example, `>=0.1.2-rc.1` does not include `0.1.3-alpha.1`, and
`^0.1.1-rc.1` does not include `0.1.2-alpha.1`. The 0.4.5 release raised the
floor to the published npm `0.1.5-rc.1` release, and 0.4.6 kept that same
floor; their open peer range also accepted the compatible `0.1.5-rc.2` family.
The `0.4.7-alpha.2` line raised the floor to the published npm `0.1.6-alpha.2`
release. The `0.4.8` stable release raises the floor to the published npm
`0.1.7-rc.1` release: TUI preferences now live on the
`tui-app` plugin's profile-owned volatile Config (the retired
`settings.register`/`settings.get` business store is gone upstream), and preset
identity comes from the official `@deepseek-ai/dsh-agent-preset-registry` with
the four shipped `@deepseek-ai/dsh-agent-preset` declarations composed from
the generated `generated/dsh-presets/` mirror (the retired `@deepseek-ai/dsh-agent-presets`
path-root/trust model no longer exists). A `0.1.6-alpha.2` runtime therefore
falls back to the released `0.4.7-alpha.2` bundle, which is what the startup
notice offers. `dsh-v0.1.6-alpha.1` predates the alpha.2 Client Session
reference contract; its last compatible TUI stays the published
`0.4.7-alpha.1` bundle. The startup notice is best-effort because Loader rows
mount concurrently; the floor is a registry release, so the notice suggests the
exact npm upgrade target.

For the current candidate line, install the recommended DSH family. The `0.5.3`
candidate moves the whole runtime peer floor to `>=0.2.1-rc.2`: that release is
both the minimum supported runtime and the exact npm family this checkout
targets. The intermediate `0.2.1-rc.1` release is deliberately NOT supported
(the matrix records it without a TUI), and every older runtime below the floor
must use its paired TUI line from the table above.

The published manifest states that same floor as `engines.dsh`
(`>=0.2.1-rc.2`) next to `engines.node`, and the packed artifact must carry it
too. DSH prefers `engines.dsh` over the DSH peer ranges and consults the peers
only when the field is absent, so `engines.dsh` is the runtime-declared
contract while the peers keep the npm-level fallback at the identical floor. A
floor move therefore belongs in the matrix row, the peer ranges and
`engines.dsh` together, and the compatibility gate fails on a partial move.
Upstream evaluates `engines.dsh` with prereleases included, which accepts later
prereleases of a different release tuple that npm's peer rule excludes; range
equality with the floor does not by itself qualify every such prerelease.

The candidate TUI itself is NOT installable yet, and there is deliberately no
`dsh plugin -- add` line here: `@latest` is the `0.5.1` stable line and `@next`
still serves `0.5.2-rc.1`, both with the `>=0.2.0-rc.2` floor, so neither
installs a TUI compatible with the `0.2.1-rc.2` target (npm/node-semver excludes
a different-tuple prerelease). Prepare the target DSH family now and validate
this checkout's candidate through the isolated npm driver; the candidate's own
install command is published together with its `next-v0.5.3` release. The
recommended DSH upgrade explicitly allows the DSH native install scripts:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.1-rc.2
```

The checkout is npm Mode and targets the published `0.2.1-rc.2` family through
its lockfile with the whole DSH peer floor at `>=0.2.1-rc.2`. Use the
local development flow to materialize it:

```sh
pnpm dev:doctor
pnpm dev:bootstrap
pnpm dev:doctor
```

Source Mode remains available for explicit source-boundary validation:

```sh
pnpm compat:dsh:source -- --dsh-dir "$HOME/project/deepseek-harness"
```

The startup notice on an old runtime suggests the exact published upgrade:

```sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.1-rc.2
```

A `0.2.0-rc.2` runtime pairs with the published `0.5.1` stable line (and with the
published `0.5.2-rc.1` next-channel preview, which shares that baseline). A
`dsh-v0.2.1-rc.1` runtime has no paired TUI in this matrix. A
`dsh-v0.2.0-rc.1` or older-family runtime falls back to the published
`0.5.0` TUI line, which keeps its own `>=0.1.7-rc.2` floor. If the official
`dsh-v0.1.0-rc.8` runtime must be kept, use the compatible
0.2 TUI line:

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.8
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.2
```

For official `dsh-v0.1.1-rc.1` or `dsh-v0.1.1-rc.2`, use the compatible 0.3
TUI line:

```sh
npm install -g @deepseek-ai/dsh@0.1.1-rc.1
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.3
```

The historical 0.4.1 stable pair uses the concrete `dsh-v0.1.2-rc.1` tag.
Official `dsh-v0.1.2-alpha.2`/`alpha.3` use
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`, `alpha.4`/`alpha.5` use
`@xmoon76/dsh-pi-tui@0.4.0-alpha.2`, and `dsh-v0.1.3-alpha.2` uses
`@xmoon76/dsh-pi-tui@0.4.3-alpha.2`. The published 0.1.5-rc.1/rc.2 family is
the last runtime for the `0.4.6` stable release. The `0.5.0` line unified its
whole DSH peer floor at `>=0.1.7-rc.2` while validating the published
`0.2.0-rc.1` distribution. The current M3-3B line moves the whole peer floor
to `>=0.2.0-rc.2`: its Question lifecycle consumes rc.2-only published
contracts, so a mixed rc.1 family is a false compatibility statement rather
than a supported floor. The `0.4.8` line keeps its `>=0.1.7-rc.1` floor and
stays the rc.1 pairing.

The `0.5.3` candidate raises the floor again to `>=0.2.1-rc.2` (one whole
published family, never a mixed rc.1/rc.2 install). `0.2.1-rc.1` is recorded
without a TUI on purpose, and the previous 0.2.0-rc.2 pairing stays with the
published `0.5.1` line and the published `0.5.2-rc.1` next-channel preview
(neither covers the new floor).

The root README intentionally uses DSH's moving `latest`/`alpha` channels for
ordinary stable/preview installs; the exact release pairing and compatibility
checks in this document and the dated changelogs remain pinned. For a
reproducible release verification, always name a published version explicitly.

The 0.2.1-rc.2 target also mounts one new base row that is NOT an optional
bundle: `@deepseek-ai/dsh-web-deepseek-api` (the DeepSeek Search/Fetch API
provider). The base keeps its shipped defaults (`web.searchProvider:
deepseek-official`, `web.fetchProvider: http`); the TUI profile never mounts a
second web provider row.

### Web Search / Fetch in `/settings`

S2 exposes the official decision in the TUI: `/settings` → `Other` →
`Web Search / Fetch` opens the existing editor's Web section, where the search
provider (`Messages`, the official default, or `DeepSeek Search API`), the fetch
provider (`HTTP`, the official default, or `DeepSeek Fetch API`), the Search API
result count, `Share Original Question` and the API endpoint base can be chosen.
The values are the official `web` / `web-deepseek-api` settings sections, so the
NEXT search/fetch uses them (an already-running operation is never changed);
`[current]` moves only after the official mutation and its read-back agree, and
a refused write is reported as `Not saved` (never as a success).

- The DeepSeek APIs are separate, opt-in billed endpoints: they send the
  request to an external URL, and a login or an ordinary Messages plan does not
  guarantee coverage of their fees. The default Messages search / HTTP fetch
  stay in place unless the user opts in, call no billed API, and are not
  changed by installing or enabling any other bundle — this Web configuration
  is owned by the base profile (`@deepseek-ai/dsh-web-deepseek-api`), not by a
  Bxx Optional Bundle. Changing the endpoint base sends the credential and
  query to that endpoint, so it must be confirmed explicitly.
- `Share Original Question` is `true` in the official rc.2
  `@deepseek-ai/dsh-web-deepseek-api` default and sends up to 128 characters of
  the triggering human question (`ori_question`) only — never the full history
  or the system prompt. Switching it off affects the next API call only.
- The API key is the official credential reference `DEEPSEEK_API_KEY`. The
  settings section shows only whether it is configured and its source layer; the
  value is entered and cleared through the existing masked
  `/login DEEPSEEK_API_KEY` / `/logout DEEPSEEK_API_KEY` commands (the settings
  surface closes before either runs).
- Remote backends report the section as unavailable: the wire publishes no
  web-provider configuration, so no Host namespace or secret is ever named
  client-side.

### Model catalog (`/model`)

The official rc.2 `@deepseek-ai/dsh-llm-deepseek` catalog lists
`id: deepseek-flash` with the display name `DeepSeek-V4.1-Flash` (plus
`deepseek-v4-pro`). `/model` keeps the official provider catalog as its only
source: the picker projects the exact `(provider, model)` identity, searches
both the id and the display name, and commits the id — never the display name,
a Web badge or a locally injected row. A deployment that overrides
`llm-deepseek`'s `models` array is authoritative: when the effective catalog
omits `deepseek-flash`, the picker does not show or submit it. An empty official
catalog (for example the API-key provider without a configured credential and
without discovery) is shown as no models rather than silently filled from a
hard-coded list.

## Data compatibility

Runtime compatibility and data compatibility are separate. A 0.4 runtime
requires the declared DSH lower bound, but it continues to read
sessions created by 0.3.x. The 0.2.1-rc.2 target adds Session events and projection facts (for example
`job/registered`, `job/settled`, `working-directory/change`, and the v2
external-subagent catalog). S2 qualifies the READ boundary this target owns: the
current format is read without rewriting the artifact, a released older
generation is classified and read through the official migration without a
write (only a write open publishes the successor), an unsupported newer format is
refused with its diagnostic instead of reading as an empty Session, and the
released-v3 reader contract refuses the rc.2-only event types. A generation the
current promotion cannot represent (surface events before the first step) is
refused with the official message and keeps its bytes; open it with the runtime
that wrote it. Back up a Session file before downgrading, and never hand-edit
JSONL: the TUI only displays what the official reader returns.

The historical DSH `0.1.5-rc.1` runtime persists
Session V2; `0.1.5-rc.2` and the current `0.1.6-alpha.2` line persist
Session V3 and own the V2-to-V3 migration when an older session is opened.
Preset state is read through DSH's `agentPreset` session projection: the
creation header initializes the state and the newest `agent-preset/selected`
event wins.

The canonical shipped preset ids are `standard`, `ptc`, `minimal`, and `cordis`,
declared as ordinary Cordis rows and registered through the official
`@deepseek-ai/dsh-agent-preset-registry`. dsh-pi-tui does not own these
definitions: the four patch files under `generated/dsh-presets/` are a
generated byte-exact mirror of `@deepseek-ai/dsh-web-app`'s exported preset
assets (`pnpm gen:dsh-presets`), parity-gated by
`test/dsh-preset-parity.test.mjs` — a recorded workaround for the 0.1.7
`dsh.bundle.patch` limitation that bundle patches only resolve
package-relative paths. Remove the mirror when DSH ships a shared preset
bundle or cross-package patch references. Built-in display classification is
the official rule (a known shipped id publishing no `name`); the TUI keeps only
its fixed English copy. No local preset copy or `code` runtime
alias is shipped. DSH's V2→V3 migration owns historical session header and
`agent-preset/selected` conversion from `code` to `ptc`; the current projection
therefore preserves a native custom preset literally named `code`. An
omitted legacy settings default is never aliased — with no matching
declaration in the current roster it is an invalid preference that keeps the
official default; new command/config writes are validated against the roster
(including its broken diagnostics) before they are saved.

## Source Mode validation

Source Mode is a CI and local-validation adapter for an unpublished DSH
checkout. It is not a published package-install mode and it never changes the
package contract or vendors DSH into this repository.

The pin lives in [`test/compat/dsh-source.json`](../test/compat/dsh-source.json)
and contains the full DeepSeek Harness commit SHA and expected version. The
source lane then:

1. checks out that exact SHA;
2. runs the official `pnpm install --frozen-lockfile`, `pnpm build:official`,
   and `pnpm release:pack --family dsh` commands; the temporary consumer install
uses `--no-frozen-lockfile --lockfile=false` so the tracked registry lockfile
cannot be consulted for unpublished DSH metadata;
3. validates the embedded `package/package.json` metadata for the complete DSH
   tarball family required by this TUI; and
4. installs those tarballs through temporary pnpm overrides before running the
   ordinary TUI, preset, and old-runtime checks.

The CI policy is deliberately explicit: pushes to `next` and pull requests
whose base is `next` follow the tracked `test/compat/dsh-mode.json` policy;
`main` and every tag, including `next-v*`, always use registry-backed npm mode
with a frozen lockfile. This checkout's policy is npm mode and targets
the published `0.2.1-rc.2` candidate family declared by `package.json` and
resolved by its lockfile (the runtime peer floor is `>=0.2.1-rc.2`). The source lane
independently pins `deepseek-harness` to
`687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`) in
`test/compat/dsh-source.json` and builds and validates that family from
source. (The historical `0.1.7-rc.2` tag's source tree could not self-clean —
its `tsconfig.desktop-keyboard-tests.json` declares an `outDir` upstream
`scripts/clean.ts` rejects — which is why the `0.4.9` release carried a
Source Mode waiver; the `0.2.0-rc.1` release commit no longer hits that
path, and rc.2 builds on the same layout.)

The Source Mode ecosystem check prints
`SKIPPED: requires published compatible DSH/pi2dsh combination` because the
published `pi2dsh` bridge cannot prove compatibility against an unpublished
source family. That check remains blocking in npm mode.

For local validation, use the isolated driver rather than workspace symlinks:

```sh
pnpm compat:dsh:source -- --dsh-dir "$HOME/project/deepseek-harness"
pnpm compat:dsh:npm
```

The isolated P1 profile smoke installs the packed candidate plus a probe bundle
into a throwaway `DSH_HOME` and boots the real TUI on the checkout's published
exact-family target; the probe proves that the bundle's `job-controller` row
composed
(`ctx.jobController`), that `follow()` opens for a real registered Job, and that
observing it never advances the model-facing `jobs.read()` cursor:

```sh
pnpm smoke:p1-profile -- <candidate.tgz>
```

A dirty local DSH tree is allowed only with a visible reproducibility warning;
CI requires a clean checkout. Source-only overrides and generated manifests are
removed with the temporary validation workspace and must never be committed to
`package.json`, the lockfile, or a release tarball.

## Validation

- Gate A validates the real TUI surface with `VirtualTerminal + TuiApp`.
- The independent official-preset gate installs only the exact target DSH and
  candidate artifact, then runs real `standard`/`ptc`/`minimal`/`cordis`
  Agent/Session creation, durable-header, degradation, and `/goal` isolation
  checks. It is runnable without a supported published `pi2dsh` release.
- Gate B separately validates the published `pi2dsh` consumer metadata against
  the exact manifest DSH version and candidate TUI version. An unsupported peer
  declaration is an `ECOSYSTEM_CONTRACT_BLOCKER`, not a forced install or a
  runtime-smoke pass. **Temporarily disabled in CI (2026-09-02):** the
  published `pi2dsh@0.24.0` bridge is runtime-incompatible with the
  `0.1.2-alpha.4` baseline — its `^0.1.2-alpha.1` peers satisfy alpha.4
  semver-wise (so the metadata preflight passes), but the bridge predates the
  alpha.4 Session/subagent APIs and fails the real runtime smoke. The gate is
  switched off (with a documented re-enable procedure in `.github/workflows/ci.yml`)
  until a `pi2dsh` release declares and runs on DSH `>= 0.1.2-alpha.4`; the
  official-preset gate above keeps the real preset coverage meanwhile. The
  local driver (`pnpm smoke:pi2dsh`) remains available for manual runs.
- **Second, independent Gate B blocker (extension API v2).** The published
  `pi2dsh@0.24.0` bridge hard-gates the host API version
  (`api().apiVersion !== 1` ⇒ it refuses to host Pi components), and the
  candidate now reports **API v2** (`docs/extension-api.md`). The pinned
  consumer therefore also needs a v2-aware release; its manifest
  (`test/compat/pi2dsh.json`) keeps recording `apiVersion=1` because that is
  the consumer's own requirement — never silently rewritten to match this
  host. Re-enabling Gate B requires a `pi2dsh` release that accepts API v2.
- **0.5.0 qualification disposition (user-authorized, 2026-09-28).** The
  promotion qualification ran the local `pnpm smoke:pi2dsh` driver against the
  0.5.0 candidate: the metadata preflight blocks with
  `ECOSYSTEM_CONTRACT_BLOCKER` because every published `pi2dsh` release
  through `0.25.2` declares `@xmoon76/dsh-pi-tui: ^0.3.3` (which does not
  cover 0.5.0) and DSH peers that predate the `0.2.0-rc.1` family. The gate is
  working as designed — it blocks instead of force-installing — and the
  promotion authority explicitly classified this as an external
  published-consumer contract blocker for the 0.5.0 qualification (the
  re-enable condition above is unchanged; no manifest value was rewritten to
  mask it).
- The runtime-boundary smoke intentionally runs the 0.4 candidate against DSH
  0.1.1 and requires a nonzero unsupported-runtime outcome. Friendly startup
  guidance is asserted when emitted, but raw import failure is accepted because
  DSH Loader mounts profile entries concurrently.

### 0.2.1-rc.2 Remote qualification (S3 PR-C, experimental)

The experimental Remote backend was requalified against the exact released
`dsh-v0.2.1-rc.2` family as part of the S3 Remote parity work. This subsection
records conclusions and limits only — no version identity, compatibility-matrix
row, peer range or `engines.dsh` value changes here:

- Session creation uses the ONE official
  `ClientSessions.create({sessionId, cwd, agentPreset})` entry and adopts the
  returned identity (`sessionId` is correlation only). Fork always passes
  `allowMigration:false`, so deriving a child never migrates the source record;
  an explicit user open/resume keeps the official `retain → Session.open` path,
  where the Host may migrate.
- The official `formatStatus` (`current | migration-required`) is surfaced
  read-only in the Session Browser on both backends. The TUI never parses the
  on-disk format itself, never derives a second migration fact, and never
  performs the migration.
- A resolved `session/prompt` is Host ADMISSION, not durability. The TUI adds no
  client-side flush/sleep/retry, because rc.2 publishes no durable-flush verb;
  the Host owns the append from admission onward.
- Time Context is the official `@deepseek-ai/dsh-time-context` plugin enabled by
  the official `standard`/`ptc`/`cordis` presets and never by `minimal`. The TUI
  adds no clock, no timezone-setting surface and no local timer.
- Remote remains EXPERIMENTAL and is not the production default: there is still
  no public CLI/env/config selector, and Direct stays the release default.
- NOT covered by this qualification: a preset-Loader-driven mount of the
  time-context plugin (`@deepseek-ai/dsh-time-context` is only a transitive dev
  dependency of `@deepseek-ai/dsh-web-app` here), the "Host accepted but not yet
  appended" interleaving (`NOT_FORCED`), and any real Tern GUI path.

### 0.2.1-rc.2 Optional-bundle runtime qualification (S4-D2, PR-D2)

S4-D2 qualifies the 14 published rc.2 Optional/On-demand bundle packages over an
isolated real Host composition (official profile/patch reader, boot Loader,
`dsh-base`, the four generated preset mirrors and the exact bundle patch). The
fixture isolates `HOME`/`DSH_HOME`/`DSH_AGENTS_HOME` and the four XDG roots
(`CONFIG`/`CACHE`/`DATA`/`STATE`); `TMPDIR`/`TMP`/`TEMP` stay ambient. Provenance is
exact package name + `0.2.1-rc.2` + the official `deepseek-ai/deepseek-harness`
repository URL. The rows marked PASS are **local qualification on the
provisioned official artifact tree**; a clean checkout/CI without that tree
reports explicit `BLOCKED` and skips the Host tests, and the
`smoke:s4-d2-bundles --gate` mode exits nonzero there. S5 must provision the
exact artifacts for the final release claim. This section does **not** change
the release identity, compatibility matrix, peer ranges or `engines.dsh`, and it
does not close the S4-D2 stage:

- **B01 Team, B03 Auto Review, B05 Worktree, B07 Persistent Terminal, B08 Session
  Search, B09 Session Titles, B10 Badge Skill, B11 Ralph and B12 Plugin Market**
  have real Host positive paths and the documented negative/cleanup controls;
  the evidence index is the S4-D2 ledger in `docs/client-server-migration.md`.
  B05/B07/B08/B09/B10/B11 keep `HOST_CAPABLE=PASS`, but their real
  Bundle→mounted-TUI L6 is **PENDING** and `DEFERRED_WITH_OWNER` to S4-D3; the
  generic existing consumers are not claimed as a full TUI qualification.
- **B02 Voice** mounts the real speech registry/API controller and reports the
  host-local model as `unprepared` in this isolated Host (no model download is
  performed by tests); the browser microphone surface remains unqualified.
- **B04 Inspector** is PENDING/BLOCKED: its real Loader row waits on the Web
  `webServer`/`connection` services that a TUI profile does not compose. The
  installed patch declares `captureFetch:true`, but the capture behavior is
  `NOT_VERIFIED` because no capture path is mounted; no DevTools UI is claimed.
- **B06 CoT Translation** was exercised through the real translator route with a
  local controlled endpoint (only the external transport is substituted); it
  demonstrably sends the given reasoning/private text to that endpoint, and the
  TUI still has no browser CoT reader.
- **B12 Plugin Market** has no official default marketplace; an explicitly
  configured offline index is read, while unknown/invalid sources are refused.
  The SAME real Host's Creator `plugin_market` tool (cordis preset) reads that
  configured index and its plugin; the Web Discover page is not a TUI surface.
- **B13 Claude Code / B14 Codex** are EXTERNAL_UNVERIFIED/BLOCKED: the official
  package, `missing` catalog entry with exact `installTarget`, local profile
  install and one-shot external-child schema are verified. The default suite
  starts no native provider; the real start is opt-in via
  `DSH_PI_TUI_S4_D2_NATIVE=1` and, under the isolated HOME, recorded the real
  no-auth result. The CLI `--native` sub-gate records credential presence only
  and never fabricates a native PASS. No mock/system-CLI success is accepted,
  and no Continue/Resume affordance exists.
- CI without the provisioned official artifact tree reports `BLOCKED` for the
  in-process qualification tests instead of substituting packages; the
  `smoke:s4-d2-bundles` CLI has separate `--provision`, `--network` and
  `--native` gates. B04 and B13/B14 need an explicit Owner decision before S4-D2
  can close.
