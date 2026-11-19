# Settings Workspace behavior

Settings page navigation, editing, read/write settlement and presentation are owned here; Host credentials and configuration authority are not.

This is the sole owning document for the following surface-specific behavior. See
[host-client.md](./host-client.md) for Host authority and
[overlay-focus.md](./overlay-focus.md) for focus/lease lifecycle.

## Settings Workspace

`/settings` and its real alias `/status` open ONE fullscreen lease with ONE
navigation focus state. The category rail is the selection owner; the right
column is the content. Width only projects panes (≥108 three, 76–107 two, <76
one). The category order is the fixed `About, General, Models, Account, Agent,
Appearance, Conversation, Input & Terminal, Tools, Plugins`, and ONE conditional
`Extensions` is appended while the extension settings registry reports live
rows (ten vs eleven painted categories; no hardcoded count anywhere). Both
`/settings` and `/status` run the same handler and land on `About` with
identical initial focus and entry-refresh behavior. `/footer` and its
`/statusline` alias take this SAME lease and mount the Footer layout page;
bare `/keybindings` takes it for the Keyboard shortcuts page (see the
specialist-page contract below).
- The extension-settings DIRECTORY is a live projection of the in-process
  `SettingsRegistry`: the panel reads its `{revision,count}` synchronously before
  every input, pointer and render decision (no second registry, no subscription
  split). A changed revision revokes the previous frame's pressed gesture and
  whole hit map before dispatch, re-reads the one snapshot, re-anchors the
  selected row on a live row of its category, and withholds every key except the
  real `Esc` until a frame composed against the current directory has painted.
  The count alone is never the fence: a same-id owner replacement keeps the
  count and moves only the revision. The event that discovers the change never
  navigates with it; a frame whose directory moved inside its own render
  publishes no grant and schedules the next frame. A registry change invalidates
  the PAINTED FRAME, never a business state it did not touch: an unrelated
  registration, unload or `setValue()` keeps an open candidate choice (re-anchored
  on its candidate identity), the selected category/row and both scroll offsets;
  only a selection that really stopped being valid (a vanished row, or the
  emptied `Extensions` category) repairs the choice and resets its offsets. A
  VANISHED selection also retires its pending/settled PRESENTATION and UI lock:
  the app-owned write keeps settling through the command/Registry owner (its
  health/diagnostic record is unchanged), but it has no row left to paint on,
  the current selection may already belong to another owner, and the request
  identity is advanced so a late settlement can never claim the new selection.
  When the registry empties while `Extensions` is selected, the selection lands
  on `Plugins` with the rail focused and nothing is installed, enabled or
  removed; a stale internal `initialCategory: 'extensions'` request lands on
  `Plugins` too.
- `Extensions` is a real configuration category, not a transition launcher: its
  Rows level projects the LIVE registrations of ONE owning extension at a time.
  The groups are the distinct `owner` identities of the current registry rows,
  ordered by each owner's FIRST appearance in the registry's global
  `order ASC, id ASC` stream; within a group that registry order is preserved.
  The selected row's owner IS the current group — there is no group cursor,
  cached page list or second selection state.
  `Tab`/`Shift+Tab` cycle the groups (wrapping) only at this Rows level with two
  or more groups and no open choice or pending write (both own their keys),
  landing on the target group's FIRST row; `↑`/`↓`/Home/End/page/wheel and both
  scroll offsets stay inside the group. Every other category, focus, choice and
  pending state keeps the root region-key semantics, and a single group paints
  its name and `[1/1]` but keeps the root Tab. The header states
  `Extensions [i/N]` BEFORE the display label, so a narrow frame truncates the
  name and never the position; the Rows pane header degrades
  `Rows (m) · <label>` → `Rows (m) · i/N` → `Rows (m)` inside its own width.
  When the selected row disappears the SAME owner group keeps the page and
  selects its first surviving row; when the whole group unloads the first live
  group becomes current (its first row, Rows focus); the emptied category falls
  back to `Plugins` as above. In every one of those repairs the vanished
  registration's transient phase is retired as described above, so the repaired
  page is immediately operable and never keeps a stale `Saving…` or a stale
  settled word.
- Each extension setting is a native Rows/Detail/Choice entry. The Detail states
  the RAW owner identity and the RAW registry id; a registration that
  contributed no selectable values is READ-ONLY (the Stable contribution has no
  freeform text field, and no editor is invented), and a current value outside
  the registered choices is reported instead of being auto-selected. Only an
  explicit Confirm calls `SettingsRegistry.applyDetailed`; the confirmation
  carries the registration's immutable internal token, so a same-id HMR
  replacement (even with the same owner string) can never receive an old
  confirmation, retry or settlement. `accepted`/`rejected`/`stale`/`gone` keep
  their registry semantics: a rejection records health only for the INVOKING
  owner and paints `Not saved`, while a superseded or unloaded registration is
  reported without a fabricated plugin refusal or rollback. Extension settings
  are runtime-only: nothing here is written to the TUI settings document or a
  Host profile.

- Every category shares ONE root row plan: header, optional metadata, at most
  one top rule, optional app notice, optional pane header, body, and the single
  physical last-row Action Bar. The app notice is the ONE root-level notice;
  a page's own business notices stay inside that page's body. At ≥76 columns a
  direct About/Models/Account page keeps the category rail and shares
  ONE display-only pane header whose focused `[Label]` names the live keyboard
  owner; the page's own semantic hint line is moved unchanged to the frame's
  last row instead of being regenerated at a wider width. The Plugins page keeps
  the rail at ≥120 columns regardless of which side owns the keyboard; at 76..119
  the pair moves with the keyboard instead, so the rail is painted only while the
  Categories rail owns the keys and steps aside for `List | Details` once the
  plugin content does — subject to the same six-real-body-row floor as the wide
  frame, below which either projection falls back to ONE business column (see the
  Plugin Manager section). The full-width
  `install`/`confirm`/`diagnostics` views hide the rail at every width. The legacy medium
  projection keeps its adjacent Categories+Rows at L0 and Rows+Details at
  L1/L2 — the rail is never pinned as a fixed left column. The bar starts at
  the frame's first column, and every child page keeps its own body and action
  rows above it. A terminal resize or any other unrepainted chrome change (the
  root App notice is the same boundary: it moves/shrinks the direct page's
  content box and grant without changing the terminal size) revokes the
  previous frame's action/copy grants before the next paint, even when the
  effective child body grant value is unchanged; until that frame paints, and
  whenever the frame shows only the Esc fallback, only Esc is admitted
  (Backspace is not a portable back key: a page may bind it to an editable
  query). A FOCUS TRANSFER that changes the Plugins content projection is the same
  boundary: at 76..119 columns the adjacent pair follows the keyboard, and on a
  narrow terminal one region is painted at a time, so moving the keyboard between
  the Categories rail and the plugin content (in EITHER direction) leaves the
  previous frame on screen; until the destination frame paints, the root refuses
  every key except the real Esc — including the
  Shift+Tab it intercepts itself and the rail keys it would otherwise act on —
  and a Backspace is refused as well. Mouse presses, releases and wheel gestures
  from the previous frame
  are rejected: the root re-derives the live content box and child grant from
  the live chrome before each pointer gesture, and a release must still match
  the box its press was admitted against. Any pending pointer state is revoked
  when the two disagree. With no granted body row (the
  shortest frames) the Esc action the frame names for that state runs: a real
  back, a state-named cancel such as clearing an editable filter, or an
  explicit wait while a Host mutation is still pending. No unreachable page
  refresh, copy or action runs from an invisible body.
- **The ONE physical last-row Action Bar is pointer-capable across the root and
  its hosted pages.** The root registers the target from the FULLY painted Esc
  span the row really painted: its own bars publish it directly, while a hosted
  page (About/Models/Account/Plugin/Footer/Keybindings/specialist) exposes only
  a read-only span of its own last painted Esc affordance in page columns — the
  root paints that row from column 0, so no column translation is applied. A
  hosted page also exposes its own SEMANTIC identity (the current sub-view plus
  every transient phase its Esc really acts on); the root stores it at press and
  re-proves it at the release, so a child repaint that keeps the same bar cells
  can never hand the gesture to a different Esc outcome. A pure wait/status fact
  (for example a Host write still in flight) publishes no span and is never
  clickable. A release replays the CURRENT state's Esc through the root's
  EXISTING keyboard ladder (`handleInput('\x1b')`: the specialist page's own
  handler, the direct page's return handling, or root `goBack`/close), so a
  pending mutation, dirty draft, awaiting-paint grant or install phase is never
  bypassed. No page registers a second last-row owner, and a page that painted
  no complete Esc affordance leaves the row inert.

- `About` is the default home: the Welcome-card brand/whale plus the runtime
  facts (the bundle's own version, the installed DSH version — `Unknown` when
  unreadable — and the selected backend) and, when a live main Session is
  captured, that Session's identity, whole-Session statistics, measured
  performance and Context occupancy. Every absent authority is worded
  `Unavailable`; no zero is fabricated, and no session is created or written.
- One captured revision supplies both the painted strings and the raw copy
  values. `↑`/`↓`/`PgUp`/`PgDn`/`Home`/`End` select the semantic fact; `c`
  copies the selected fact's exact raw value (numeric rows keep the source
  number, never the rounded display), `Shift+C`/`C` copies the full stable
  report, and `r` refreshes the Session statistics and Context once. `Enter`
  activates only the explicitly selected `Refresh context` action; an ordinary
  fact is inert. `Esc`/`Backspace`/`Left` returns the keyboard to the rail.
  A fact row paints NO per-fact affordance: single-fact copy is advertised only
  as the weak `c copy fact` Action Bar hint, and it is granted only while the
  selected fact's physical row span intersects the painted viewport. `C` and
  the ONE body `Copy All [C]` affordance are not gated on a visible fact row, so
  a narrow frame that drops that segment keeps the keyboard shortcut.
- About reads are non-creating and re-prove the captured SessionScope (owner +
  generation) after every await; a session switch revokes the old view
  immediately, and one semantic entry admits at most one refresh. While
  sessionless, no read starts and the Session-only Refresh is not painted.
- Mouse `Copy All`/`Refresh` targets exist only for the WHOLE painted
  affordance at its last-painted geometry; a clipped or hidden button has no
  target. Ordinary fact cells publish no hit target at all, so clicking a value
  never copies it. The whale is decoration: the report carries facts, never
  artwork.
- `Models` and `Account` are DIRECT content pages in the SAME lease (not
  fabricated Settings rows and not a second alt-screen owner). Selecting either
  on the rail paints the real page in the right column at once, while the
  keyboard stays on the rail; `Enter`/`Right` then hands the keyboard to that
  page and runs no page action by itself. `Esc`/`Backspace`/`Left` returns the
  keyboard to the rail and keeps the page instance, its view, its draft and its
  watch; only a real category change or a real close disposes it. Narrow paints
  one page with an explicit `Esc`/Back path.
- `Tab` (forward) and `Shift+Tab` (reverse) re-focus ONE logical region and
  never activate, write or read the Host. At `≥76` columns a direct category
  hands the keyboard from the rail to its content page, and About/Account
  content hands it back to the rail (Account only while the page may safely
  yield: its confirmation and pending operation keep the keyboard). At `≥76`
  columns a legacy category cycles `categories → rows → detail` forward and in
  reverse, only re-focusing that pane: focusing the Detail never opens its
  choice, editor or writer. Below 76 columns the root Tab is inert, and the
  existing `Enter`/`Right` (in) and `Esc`/`Left` (back) navigation is unchanged.
  A transient choice, a pending write and the in-place Plugin Manager keep their
  own keys; every region jump lands on the destination's first candidate and
  bumps the pointer-press revision, so a straddling click cannot activate it.
- The configuration categories (`General`, `Agent`, `Appearance`, `Conversation`,
  `Input & Terminal`, `Tools`, and the conditional `Extensions`) keep their
  three-level browse (L0 categories, L1 rows, L2 detail). `About`, `Models`,
  `Account` and `Plugins` remain direct content pages. `General` holds the
  startup backend, the two next-Split-Host startup preferences and the official
  session-log upload switch in one frozen order.
- Configuration rows keep their distinct writer kinds: the configured theme,
  transcript display preset, icon style, mid-turn progress-updates cadence,
  response style, Git attribution, Home/End keys, Mouse wheel lines,
  Notifications, Notification method, Terminal progress and `Agent` user-shell
  sandbox policy are persisted through the ONE serialized TUI settings document;
  the profile-wide `Visual tools` switch and `General` startup backend
  (`Direct`/`Daemon`) selector are the Host profile's revision-checked form
  sections (`pi-tui-visual-tools` and `tui-startup.backend`); `Agent`'s
  `Approval policy` is the official per-Session durable policy event,
  `Default permission` is the Host permission default, and its single
  `Subagent settings` entry stages the Host-owned limits and model-selection
  sections in one embedded page. Transcript detail (`Ctrl+O`) and thinking
  detail (`Alt+T`) remain Client-local RUNTIME-ONLY disclosure states with no
  document field, so their Detail states `not applicable — runtime-only` and
  `Verified` claims only the live runtime fact. `Submit while busy`,
  `Fullscreen` and `Agent` user-shell sandbox are PERSIST-FIRST rows (see below).
  Browsing never writes, and the configuration rows expose no copy verb at all.
- The document-backed rows do NOT share one apply/persist order, and the
  contract keeps their differences instead of normalizing them:
  - `Submit while busy`, `Fullscreen` and the `Agent` user-shell sandbox policy
    are PERSIST-FIRST: the stored document is the authority the row reports as
    its primary `Value` and as its `[current]` chip. A missing/illegal raw value is stated exactly (`not set`,
    `invalid stored value: <raw>`) and never replaced by the consumer's
    fallback; the `Runtime` half names the effect the next read of that document
    will have (`Next busy Enter: …`; the paused transcript mode plus the
    post-close apply). A non-ready/unreadable document refuses the write and
    changes nothing, and only a completed write whose fresh same-field read
    agrees is `Verified`.
  - `Fullscreen` never swaps the screen during the commit. The verified target
    is a transient per-open intent: after the workspace closes through the
    user's own exit, and only while the re-read document still carries exactly
    that value and the app is still idle (no Job/workspace lease, no
    Question/Approval/Save owner, same return screen), the restored transcript
    surface receives ONE physical switch with the preference persistence
    skipped. A forced teardown, a newer blocking owner or any unverified outcome
    switches nothing; the stored preference then applies at the next TUI mount.
  - `Git attribution`, `Home/End keys`, `Mouse wheel lines`, `Notifications`,
    `Notification method` and `Terminal progress` are APPLY-FIRST like
    `icon-style`/`progress-updates`/`response-style`, each driving its ONE
    existing owner: the shared `gitAttributionState` the registered
    `tui:git-attribution` SystemPrompt section reads, the keymap bindings the
    fullscreen viewport really resolves, the NEXT alt-screen mount option, the
    one completion controller's mode/method, and the terminal-native progress
    protocol selection. `Mouse wheel lines` applies to the NEXT fullscreen entry
    only — its live fact says so (`<n> (next fullscreen entry)`) and the mounted
    viewport keeps its constructor-time step — while notification
    writes never emit a notification, and the terminal-progress preference is
    never confused with the Agent's `Progress updates` narration cadence. A
    legacy `on` terminal-progress value is a READ compatibility only and is
    never written back without an explicit confirmation.
  - `icon-style`, `progress-updates` and `response-style` are APPLY-FIRST: the
    live owner changes immediately, the document write follows, and a failed
    persistence never rolls the runtime back. Their Detail keeps two separately
    named facts — the value that already took effect as the primary `Value`, and
    the `Persisted` stored value. While such a commit is pending, that primary
    `Value` already shows the applied value (the projection is re-read when the
    owner changes, not at settlement), and the `Persisted` fact keeps reporting
    the stored value until an authoritative re-read agrees.
  - The explicit `Runtime` label is a property of the row's PRIMARY fact, not of
    its writer kind: the panel paints it only when `edit.primary` is the
    PERSISTED fact, because then `Value` is the stored fact and the live one
    needs its own name. Exactly two rows are built that way — `theme` and the
    Host-authority `visual-tools` switch; every other document row
    (`display-preset` included) is runtime-primary and therefore paints
    `Value` + `Persisted` with no `Runtime` row.
  - `[current]` is a SEPARATE decision from `Value`/`Runtime`: it marks the
    candidate the row considers current, and the two must not be conflated.
    `theme` and `display-preset` keep their pre-existing semantics unchanged —
    the theme is a Host-persisted preference whose non-`ready` backend refuses
    the commit BEFORE any runtime apply, and BOTH mark `[current]` from the
    persisted preference rather than from the live value. The display preset
    still applies through the shared `DisplayState` owner before it persists,
    so its `Value` is the live preset while its `[current]` chip follows the
    stored one. Both keep their existing writer code.
  - The Host-authority `visual-tools` switch marks `[current]` from the Host
    profile's CONFIGURED value (`enabled`), never from the live registry
    registration: whether the registration took effect is the separate `Runtime`
    fact, so a configured On the Host did not apply is a stated mismatch rather
    than a moved `[current]` chip.
  - In every case the `Persisted` fact reports the raw stored value (`not set`
    when the readable document carries none, an explicit unknown when it cannot
    be read), and a normalizer's fallback is never presented as the stored
    value.
- `Agent` owns FIVE rows in this frozen order: `Approval policy (this session)`
  (only while a live, still-current captured Session exists — the row stays
  visible with its truthful state when the Host policy read is checking,
  unavailable or failed, and offers no confirmable candidate until a proven
  read answers) → `Default permission` (only while the Host advertises a preset
  roster) → `Subagent settings` (always reachable so each official section can
  state its own readiness) → `User shell sandbox policy` (always painted) →
  `Agent loop` (always reachable so its official section can state its own
  readiness). The
  category stays in the fixed rail even when every row is unavailable, and
  `Agent` has NO transition launcher any more: it has no unmigrated field left.
  - `Approval policy` is scope-pinned and reads the PROVEN Host fact: the
    workspace captures ONE live Session scope on open and never re-targets it.
    A session switch makes the captured scope stale — the Confirm is refused
    synchronously (zero dispatch, the refusal reaches the ONE app notice) and
    reopening the workspace is what speaks about the new Session. `Value` is the
    current official EFFECTIVE approval policy; the `Runtime` detail splits it
    into `Effective: …`, `Session override: <…|none>` and the SAME read's
    independent `Sandbox: <mode> (override: <…|none>)` fact (a policy fact,
    never an enforcement claim), and `Persisted` names
    `Source: Host session policy` and `not written to the TUI Settings
    document — persisted by the Host Session log` (a durable per-Session event,
    never the Host profile default and never a permission
    preset). `Checking…` is painted
    until the first authoritative read answers; a failed or unavailable read is
    stated as such and the user can refresh (`r`). `Verified` requires ONE
    fresh authoritative readback of the SAME exact Session whose effective
    policy equals the requested value — an already-effective `ask` written as a
    no-op is Verified while `override: none` stays stated, and a readback that
    another client changed is indeterminate rather than "this request failed".
    `Not saved` is reserved for a proven pre-dispatch refusal; a dispatched
    write whose ACK/readback is lost is unconfirmed/unverified and never
    retried automatically.
  - `Default permission` is HOST-PERSIST-FIRST: candidates are the Host's raw
    preset ids in Host order, the write is the official
    `permission.defaultPreset` mutation, and `Verified` needs a fresh
    `defaultPreset()` read to agree. It applies to NEW Sessions only — the
    running Session's preset, sandbox and approval knobs are untouched — and a
    Host port without a settings service REFUSES explicitly instead of
    succeeding as a no-op.
  - `Subagent settings` is the single embedded page for the official `subagent`
    limits and `subagent-model-selection-settings` preference. It mounts in this
    workspace's existing body and screen lease; the Root keeps the physical
    Action Bar and Esc. Enter or the painted Agent-row click opens the page, and
    its Back/Discard exit returns to the Agent rows. The page order is fixed:
    Limits (`maxDepth`, `maxActiveSubagents`), then Model selection (`enabled`,
    `allowedModels`).
  - Drafts are per-open Client-local state. Editing numbers, toggling Enabled,
    selecting or removing a `(provider, model)` route, and Reset only stage
    field intents. The grouped Model Directory is read-only; a route toggle
    sends no Host mutation. Saved routes remain visible and removable when the
    directory or that provider is unavailable; absence is claimed only from a
    current successful directory read.
  - Save validates the staged fields and dispatches at most one exact-revision
    mutation per dirty namespace, Limits first. Selection is dispatched only
    while the original Host generation remains current. The two namespaces are
    not a transaction: each settles and reads back independently, a successful
    namespace is not rolled back when the other fails, and only its own verified
    fields leave the draft. A revision conflict requires an explicit Refresh;
    a dispatched Remote write with lost settlement is Outcome unconfirmed and
    is never replayed automatically. A verified result requires a current
    same-generation authoritative readback, not only an ACK.
  - Reset stages one official field-level `unset` and never substitutes
    `set(inherited)`, edits a profile file, or creates another writer. DSH
    computes and returns the current effective value. Its official `unset` may
    materialize that value in the USER patch when a sibling field remains
    overridden; physical USER-field deletion and `overridden=false` are not
    Reset success criteria. The UI's `Inherited` / `Overridden` label compares
    the same descriptor's effective value with its base, not USER-key presence.
  - Limits affect later subagent delegations. Model-selection policy is sampled
    when a new top-level Session is composed; an existing Session keeps its
    recorded policy after settings change.
  - Every `Agent` row that owns a Host write refuses to offer a confirmable
    candidate while its authority cannot vouch for the value: a non-`ready`
    backend (or an unreadable document) keeps the row and its truthful
    last-known/raw facts but offers no candidate, so the UI never invites a
    Confirm that the writer must refuse. `Subagent settings` remains reachable
    and labels each unavailable or last-known section independently; unavailable
    or stale values are read-only.
  - `User shell sandbox policy` is a PERSIST-FIRST TUI-document row: `Value` is
    the RAW stored `localShellSandbox` (`not set` when absent, the invalid raw
    value when illegal, `unknown` when the document cannot be read), `Runtime`
    names the effect the NEXT `!`/`!!` really takes (including
    `bypass (default; no valid saved value)`), and only an agreed fresh
    document read is `Verified`. It is the Host user-shell execution policy —
    never the model's tool sandbox policy, never a permission preset, and it is
    deliberately not part of `Input & Terminal`. When the Host provides no
    user-shell the preference still stores, and the existing executor fails
    closed instead of degrading to a local spawn.
- The Settings workspace is the ONE settings surface: every field it reaches
  is edited by its own native row, row choice, embedded page or typed deeplink,
  so no category carries a transition launcher and no Settings gesture hands
  the user off to a second editor. The retired complete settings editor (and
  its Web rows, phase map and credential hand-off) no longer exists. The
  `SettingsList` component itself remains: independent commands (`/help`,
  `/skill`, `/preset`, `/keybindings conflicts`) open it with their own row
  lists through `TuiApp.openSettings`, which is not a Settings workspace path.
- `Tools` holds the built-in `Visual tools` row (backed by the Host profile's
  `pi-tui-visual-tools.enabled` volatile Config, schema default On), the
  `Shell execution` specialist entry, the `ACP Server` runtime row, the
  `Web Search / Fetch` page entry, when the official manager is mounted
  `MCP servers`, and when the official Computer Use provider and Plugin
  Manager roster are mounted `Computer Use`, in that frozen order. The next-Split-Host Web/ACP startup
  preferences are NOT in Tools: they live in `General` under the SAME row ids
  (`web-autostart`, `acp-autostart`) with no duplicate Tools entry.
  Its stated value is the effective Host form value; `[default]` marks a value
  the USER layer does not declare. Confirm writes that ONE field through the
  official revision-checked settings mutation and re-reads the Host. Off
  releases both built-in registrations from the global Host tool registry and
  On restores the original definitions; already-recorded results and their
  rendering, copy, search and export are unaffected. A missing, unreadable or
  non-current authority keeps the category and row visible but offers no
  candidate and refuses the write (never a fabricated default). On a Direct
  backend `Verified` also requires the Host row's live registration fact to
  agree; Remote has no registry read and states the runtime half as
  unobservable instead of claiming success.
- `Web Search / Fetch` is an EMBEDDED SPECIALIST PAGE inside this same
  workspace lease: `Enter`/`Right` on the row (or its ONE painted
  `Configure Web…` action) mounts the page in the same body under the same
  header/metadata/notice/Action Bar. It is never the legacy `SettingsList`, never
  a second alt-screen overlay and never a second settings manager, and its `Esc`
  ladder is `Detail → Web list → the Tools row → the category rail`.

  The page paints exactly NINE rows in this frozen order: `Web Search Provider`,
  `Web Fetch Provider`, `Search API Result Count`, `Share Original Question`,
  `Search Billing`, `Fetch Billing`, `Search API Override` (read-only),
  `Fetch API Override` (read-only), `DeepSeek API Key`. At ≥100 columns the row list
  (max 34 columns) sits beside the selected row's Detail; at 65–99 columns the
  list is stacked above it; below 65 columns exactly ONE region is painted at a
  time and `Enter`/`Esc` move between the list and its Detail. The frame keeps
  ONE active cursor (the focused region's), ONE pane header and the ONE shared
  last-row Action Bar; a cropped grant scrolls instead of hiding an activation,
  and an Enter whose candidate is not inside the painted viewport does nothing.
  A candidate, state word or `[current]` chip is never painted partially, and
  terminal-untrusted Host text (custom provider ids, URLs, credential source)
  is painted through the existing sanitizers and width helpers.

  Authority is the Host `web` / `web-deepseek-api` sections through the
  `WebProviderConfig` read and its provider/count/question/Billing setters. The
  provider choices are the official identities `DeepSeek server-side
  search`↔`deepseek-official` and `HTTP`↔`http`, plus the separately billed
  `DeepSeek Search API` / `DeepSeek Fetch API`. HOST SELECTION IS AUTHORITATIVE:
  an absent `web.searchProvider`/`web.fetchProvider` is no explicit provider —
  the Host's AUTOMATIC routing state, and supported Host versions may choose the
  actual provider per request based on the served model route (supported Host
  versions may decide the automatic routing differently). The page paints that absence as
  `Automatic`, never precomputes which provider one request would consume and
  never writes a provider merely to display it; an explicitly configured id
  always takes precedence. A configured provider id
  outside those candidates is a CUSTOM route: it is displayed verbatim, it is
  never replaced by a default and the page offers no confirmable provider id for
  it (only the separate deployment-reset entry described below).

  The two provider rows map the OFFICIAL `web` descriptor's THREE distinct
  facts — the effective `value`, the deployment `base` layer and the raw USER
  section — so "no USER override" is decided by the USER own-field, never by an
  effective value that merely equals the deployment default. When the deployment
  composes no provider for a capability, the Detail offers an `Automatic` row
  that means the official USER-layer reset (never a persisted provider id); when
  the deployment's own value is one of the official candidates, that candidate
  is named `deployment default` and choosing it runs the SAME official reset
  instead of re-writing the id. A deployment value outside the candidates is
  shown verbatim; while the USER layer overrides it, the Detail offers ONE
  `Use deployment default` row that maps to the official reset only — it never
  writes the custom id and never touches another field of the section. An
  inherited custom route (no USER own-field) is displayed as-is and offers no
  reset. The reset is the official
  `settings.mutate('web', [{op:'unset', path:[field]}], revision)`; the page
  never substitutes `''`, `null`, `undefined`, `auto` or the deployment id and
  never edits the profile document. Its settled verdict comes from a fresh
  authoritative read: `Verified` requires the read to be ready AND the effective
  raw id to equal the fresh deployment `baseId` (including `undefined`). The
  Host may keep an explicit USER value equal to that base while the same section
  carries another USER override; the page reports that residual state as a fact
  rather than claiming the USER field vanished. A provider write in flight
  carries the action (reset vs explicit id) and the layer facts the frame
  painted; the queue head refuses (`Not saved`, zero writes) a gesture whose
  deployment default or USER layer another writer already changed. Confirming a
  provider the authority already holds with a USER own-field of the same id is a
  zero-write `Verified`; an explicit candidate that is only inherited still
  issues the ONE official setter and is `Verified` only when the fresh USER
  own-field really carries it. The count row offers the `5/10/20/50` presets while the official domain
  stays 1–50: a stored integer outside the presets (for example `7`) is reported
  exactly and is never rewritten by navigation or refresh. `Share Original
  Question` is `on` by default and states the payload boundary (up to 128
  characters of the triggering human question as `ori_question`, never the full
  history or system prompt). `Search Billing` and `Fetch Billing` are two
  independent Host fields over the official closed enum `auto`/`account`/
  `api-key`; each is editable ONLY while its official API provider is the
  EXPLICITLY selected route and has no advanced Host override — under the
  AUTOMATIC provider state the dedicated Billing row is read-only here with ZERO
  writes (the official Client's product policy), because the Host may still
  execute the billed API for other models' requests; a stored Billing mode is
  kept, never deleted or reset. `auto` follows the current conversation's DeepSeek
  route and is not a claim that `DEEPSEEK_API_KEY` is configured. The two
  Override rows are READ-ONLY Host YAML facts: when set they name the official
  field/value the Host really uses (`searchBaseURL`/`searchApiKeyEnv` or
  `fetchBaseURL`/`fetchApiKeyEnv`; never a secret value) and the corresponding
  Billing row states it is overridden; when unset they state that the capability
  follows the current conversation's DeepSeek route instead of inventing a fixed
  public URL. `web-deepseek-api.baseURL`/`apiKeyEnv`/`apiKey` are retired
  profile residue: they are never read as effective values and never written by
  this page (an optional legacy notice points the user to the external profile
  YAML; no automatic migration).

  Every write is ONE explicit confirmation — the keyboard `Enter` OR a click on
  the complete, same-intent `Confirm [Enter]` span that this page painted in the
  LAST frame and the Settings workspace root delegates through its ONE physical
  Action Bar row — that enters the command owner's single Web FIFO. The bar
  paints `Confirm [Enter] · Back [Esc]` (plus a muted `↑/↓ choose` hint when the
  width allows) only while the highlighted candidate is inside the painted
  Detail viewport and the latest authority is ready and writable; a candidate
  row click only moves the draft highlight and writes nothing. A Confirm span
  that is absent, cropped, from a previous frame or invalidated by any
  key/wheel/resize/refresh/save phase dispatches nothing, and the delegated
  activation re-proves the same row, raw candidate and live authority before
  the same `confirmSelected()` path runs. At its turn the intent re-proves
  readiness and section availability, takes the NEWEST committed read as its
  base, refuses a custom-route/candidate violation with ZERO writes and
  dispatches the ONE official setter (or the official reset described above). A
  fresh read-back then decides the settled word: `Verified` only when the
  authority holds the requested identity (for a provider row, the provider
  layer rule above), `Not saved` (with the value the Host really keeps) when a
  readable authority differs, and `Outcome unknown` when the result cannot be
  read back. A superseded read never decides
  a verdict; a newer read is awaited first, and a page closed mid-write only
  loses its own repaint — the dispatched Host operation still settles in the
  command owner. Confirming a value the authority already holds performs NO
  setter (that states the current fact, never a promise about the stored USER
  layer) — except that a provider row's already-current shortcut additionally
  requires the USER own-field to carry that id; the AUTOMATIC (absent) provider
  state never satisfies an explicit candidate — confirming one always issues the
  ONE real setter and verifies from the fresh read-back.
  `Loading…` on page entry or `r` is a real pending state, never a last-known
  value presented as current; every read that settles refreshes the Tools row
  summary and the mounted page from the same facts.

  `DeepSeek API Key` shows ONLY the official credential reference
  (`DEEPSEEK_API_KEY`), its presence and its source layer — never the value.
  Its two actions are `Configure in Models…` and `Clear in Models…` (the latter
  only while the fresh official fact is configured), and both hand a typed
  `ModelsInitialView` (the same reference, or its exact clear target) to the
  workspace root: the root retires the Web page FIRST, then switches to the
  existing Models page with that initial view in the SAME lease. The page never
  runs `/login` text and never touches a secret; Models owns the masked input,
  the clear confirmation and the credential-store mutation, and re-entering the
  Web page performs a fresh presence read. A backend whose Web section is
  unavailable (Remote or a half-mounted/malformed authority) still opens the
  page as a read-only statement with its reason, paints `Unavailable` and offers
  no Confirm or credential action at all.
- `Footer layout` and `Keyboard shortcuts` are EMBEDDED SPECIALIST PAGES in this
  SAME lease. `Appearance` carries the persist-first `Status line mode` row
  (`default`/`compact`/`custom`; a stored `command` is reported as
  `command (manual)` and is never a candidate) plus `Configure footer layout…`;
  `Input & Terminal` carries `Keyboard shortcuts…`. `/footer`, `/statusline` and
  bare `/keybindings` are TYPED DEEPLINKS: the command validates the exact
  row/page pair, takes the Settings lease and mounts the page on the first real
  body grant (never before the lease, never a fallback overlay). The page keeps
  its ONE existing authority — the Footer model/catalog/composer and its
  persist-first save transaction (queue-head USER raw merge, runtime apply only
  after the write), or the ONE `KeybindingEditorController` and its serialized
  writes/conflict checks. The root owns header, metadata, notice, pane header and
  the ONLY physical last-row Action Bar; the page contributes its business body
  and preview above that bar. `Esc` follows the page's own state machine (Footer
  dirty Save/Discard/Keep guard; Keybinding recorder → action detail → query
  clear → list root) back to its source row, then the existing Settings levels
  close; only leaving the whole Settings workspace releases the lease. On the
  page's ROOT state (Footer Row Selector, Keybinding list with an EMPTY query)
  `←` is the same back verb and the page bar advertises it as `← Back` — also
  when the grant is the single Action Bar row — while a sub-page or a
  non-empty query never advertises it. A dirty Footer turns it into the
  Save/Discard/Keep guard. Closing either professional page returns to that
  row's ROWS level — never to an intermediary Detail panel — so the very next
  back key (Esc or `←`) reaches the category rail; the Subagent settings and
  Web Search / Fetch pages keep their own `Detail → row` ladder. Every
  sub-page keeps its own meaning (`←` still moves a Footer item between zones,
  and a non-empty Keybinding query still moves the search cursor). A page that
  blocks USER navigation (dirty Footer draft, in-flight save, non-empty query,
  action detail, recorder/leader, pending mutation) refuses category changes,
  and a page whose current grant or sub-view has not painted admits only the
  page's ROOT back verbs — the real Esc, plus `←` while the page is on that
  same root state — never a hidden save/open/search/list/leader/record control;
  the root's painted content box, revision and child grant fence every pointer
  gesture. The Footer body accepts the pointer wheel as a VIEWPORT-ONLY
  scroll: only rows the last frame really painted in its scrollport are
  eligible, the Fork's signed line count is used as-is (Wheel Lines and Alt are
  never applied twice), and the page keeps the manual offset until the next
  explicit keyboard input. The wheel never calls the model's move/reorder path,
  so the model selection, `row-move` order, Add query/cursor and every drafted
  value stay untouched; the pinned Add search/description, the preview, the
  help and the ONE Action Bar are fixed and inert. A manual offset may hide the
  model cursor: while the painted frame still hides it, every
  Enter/Space/A/M/F/S/Left/Right zone-or-format/tone change/reorder key only
  restores cursor-follow and is consumed (a second such key arriving before the
  restored frame paints is consumed too), while Up/Down navigation, typing, Esc
  and the Row Selector `←` keep their paths. In the zero-match Add picker the
  inert `(no matching items)` notice never carries the cursor: the selected
  Create row is the painted cursor and the first Enter follows the normal
  visible-selection admission. Clicking the guard's `Keep Editing` row runs the
  SAME model return to the Row Selector as keyboard Esc. Inline text editors, the
  delete prompt and a saving page are wheel-inert; a nonzero wheel retires an
  old body press while a zero notch never cancels one. A pending Keybinding
  mutation owns the page until its result is
  painted, so leaving can never strand an invisible write. No second
  alt-screen, overlay, editor or settings manager exists for these entries, and
  a deeplink that cannot take the lease or build its page returns a real command
  error instead of opening an overlay.
- An L2 choice is transient; only an explicit Confirm commits one field through
  its own authority path (the serialized TUI settings document, the Host
  `pi-tui-visual-tools` form section, or — for the two runtime-only disclosure
  fields — the `TuiApp` state owner `Ctrl+O`/`Alt+T` share, with no persistence
  step) and re-reads the authority. A writer refuses a value outside its frozen
  candidate set BEFORE it mutates anything: the parsers' fail-safe defaults are
  normalization, never validation. The progress-updates and response-style
  writers mutate the ONE shared prompt-state object the registered
  SystemPrompt providers read (`ProgressUpdatesState` / `ResponseStyleState`):
  no section is re-registered, no Agent is recomposed and nothing reaches the
  Focus/Compact presentation state.
- `Verified` requires a ready read-back with a matching value. Rejected/unknown
  outcomes are attributed from a fresh read, never guessed. A refused write is
  reported as `Not saved`/unknown, never as success. For the apply-first fields
  a failed persistence never rolls the live runtime back, so the screen must
  keep stating BOTH facts (the applied runtime value and the unchanged stored
  one); the runtime-only fields carry no document read at all, so they never
  paint a persistence phase.
- Theme auto is fenced on the runtime selection intent.
- `Plugins` is a DIRECT page inside the same lease (see Plugin Manager): the
  embedded `PluginManagerWorkspacePanel` paints only its own business body,
  while the root keeps the single Header/Metadata/rule/pane-header/last-row
  bar. At ≥120 columns the frame is `Categories | List | Details` — provided the
  frame can still grant six real business body rows (a shorter frame degrades to
  one business column); at 76–119 the rail focus paints `Categories | List` and the
  plugin content focus paints `List | Details` under the SAME six-row floor, so a
  shorter frame keeps one business column; below 76 columns it is one column, and
  the page is not
  mounted while the rail is focused there. `install`/`confirm`/`diagnostics`
  always take the full width (no rail) so risk text is never squeezed. `Tab`
  and `Enter`/`Right` only hand the keyboard to the plugin List (no action);
  `Tab` inside the List keeps its filter cycle, `Shift+Tab` from the untouched
  List root returns to the rail, and `Esc` from the List root returns to the
  rail with the page instance, its view/query/selection/scroll and the
  controller's install request id intact. Only a real category change or the
  Settings teardown disposes the page and releases its Host claim. No Settings
  level hands the user off to a second editor. `Extensions` is a real
  configuration category whose Rows
  project one owning extension's live settings at a time (see the Settings
  Workspace contract above).
- The screen lease/currentness mechanics are owned by
  [overlay-focus.md](./overlay-focus.md).

### Host numeric pages, Session log upload and General

`/settings → Agent → Agent loop` and `/settings → Tools → Shell execution` are
two SPECIALIST pages sharing ONE numeric renderer inside the existing Settings
lease. Each page owns only its per-open draft, focus, scroll and confirmation;
the Root keeps the physical Action Bar and Esc, and a painted row/field/Reset/
Apply/Save/Back control delegates to the SAME page/controller path a key press
uses. Both pages paint the current effective value and its
`Differs from base` / `Matches base` relation to the base, an explicit
`[Reset]` per field and `Status: …` feedback. These comparison labels are not
USER-layer override presence claims.
The fixed status line reports `Ready`, `Unavailable`, `Unreadable` or
`Last-known · read-only` from the captured read and the live section; it never
says Ready for a missing, unreadable or superseded authority. A field's
`[Reset]` action is painted as a complete segment and its pointer span is
derived from that same painted line; a width that cannot host the whole word
drops the Reset target entirely.
Numeric validation follows the owning field: Agent loop requires a safe
positive integer (`Number.isSafeInteger(n) && n>=1`), while the Shell fields
require a positive finite number as the Host runtime does. An empty field stages
the official Reset; invalid text keeps
the draft and never dispatches. Save sends ONE exact-revision/revision-checked
Host mutation for the page's namespace and reports `Not saved`, `Unverified` or
`Outcome unconfirmed` exactly as the Host settlement and same-generation
readback prove; a stale captured page is read-only until an explicit refresh.
Reset stages the official field `unset`, then shows the Host's CURRENT readback;
neither USER-field deletion nor `overridden=false` is a success criterion.

- `Agent loop` edits only `agent-loop.maxParallelToolCalls`. The next Agent step
  samples the saved budget immediately before executing its next non-empty tool
  batch; tool calls already dispatched are never rewritten. The other
  `agent-loop` Config (notably `agents`) is never part of this page's write.
- `Shell execution` edits the two numeric caps (`timeoutMs`,
  `maxOutputBytes`) of the Host-served model-tool executor row in ONE mutation.
  The bound row follows official dsh-web: `pwsh-sandbox` is preferred when both
  `bash-sandbox` and `pwsh-sandbox` are served, otherwise the single served row
  is used, and no served row is `Unavailable`; the Client OS is never used to
  guess it. A stale captured generation/revision or a same-revision switch to
  the other served row refuses the write. The caps
  affect the NEXT shell execution; a running subprocess keeps its current
  timeout. This is not the `!`/`!!` user-shell sandbox policy.
- `General` paints `Backend`, `Start Web automatically`, `Start ACP
  automatically` and `Session log upload` in that frozen order. `Session log
  upload` is the official `session-log-deepseek.enabled` scalar row and is
  absent entirely when the current Host does not serve that namespace. Its
  candidate row offers `On`, `Off` and `Reset` only on a current authority;
  `On` carries the explicit risk (session-log data, possibly conversation
  content, is sent with requests to the official DeepSeek API), `Off` is a real
  saved value, and `Reset` is the official `unset` whose readback MAY be `On`.
  The risk sentence is a scrollable first-class fact of the confirmation
  flow: a short frame may reveal it before Confirm, and no incompletely painted
  Confirm button has a pointer target; warning, candidate and Confirm need not
  share one frame. The CAS fence captured when L2
  opened (Host generation + exact revision) is never rebased by a later
  refresh, so a changed same-Host revision or a same-revision Host replacement
  is `Not saved` with zero dispatch. A lost settlement is `Outcome unconfirmed`
  and a fresh readback that disagrees with an accepted write is `Unverified`;
  neither offers a blind replay: a manual `Retry save` appears only for a
  definite `Not saved` settlement and re-dispatches the previously confirmed
  candidate through the current row's revision/generation write check. It does
  not reopen the L2 confirmation.
  A non-current or disconnected authority offers no candidate and never
  presents a stale On/Off as the current Host state. Retaining a historical row
  is a TUI presentation choice, not a requirement of the official namespace
  lifecycle.

### Startup backend (General)

`/settings → General → Backend` is the FIRST of the four `General` rows; the
migrated `Start Web automatically`, `Start ACP automatically` and the
`Session log upload` switch follow it in that order. Its candidates are `Direct` and `Daemon`, persisted to the official
Profile Config `tui-startup.backend` (`direct`/`daemon`) through the same
revision-checked Settings mutation the other Host form rows use; an explicit
`Direct` or `Daemon` choice is the sole persisted authority and the current
process's backend is never read from this row.

The value is a NEXT cold-launch fact. The `Runtime` half always states
`Applies on next launch; current TUI/Host remains unchanged`: a verified write
never hot-switches the running process, never spawns or stops a Host, and never
changes the current backend. The summary marks `(default)` only while the USER
layer does not declare the value; a Profile section that is unreadable or
carries an illegal value is `Unavailable` and cannot be edited, never silently
shown as the shipped `direct` default. When `DSH_PI_TUI_BACKEND` is set for the
current launch, the Detail adds ONE read-only `Current launch: … (environment
override)` fact (an illegal override value is reported too); that fact is a
launch input only and is never written back into the persisted preference.

### Models page

The provider list and detail are detached ConfigPort projections
(`readCatalog`, `describeReference`, `recordPresence`, `listRecords`).
The page never infers a stored key from a route/profile.

- ONE catalog read per generation: the provider rows and their profile facts
  come from ONE provider snapshot (the adapter reads the configurable-provider
  directory and the settings once per snapshot, and never repeats a settings
  read or a deep copy per provider route). The credential presence is a
  SEPARATE, later read: one `describe` per UNIQUE reference, issued after
  the catalog succeeds. The catalog read runs AFTER the first painted frame of
  the page: the constructor performs no Host read, so selecting `Models` on the
  rail paints the Loading state instead of blocking the input path.
- The page's reads are armed BEHIND the frame that paints their
  Loading/Reading state, not behind a timer. The renderer writes a frame
  synchronously after the component tree renders, and the page starts a read
  only after that write. A `setTimeout(0)` is not this boundary: frames are
  throttled (up to the render interval), so a timer can run the synchronous
  Host scan before the state frame reaches the terminal. The rule covers the
  first catalog read, the catalog R refresh, the stored-credential list
  (opening it and R) and the record-clear confirmation.
- The read state is explicit: `Loading` (no authoritative rows yet), `Ready`,
  `Refreshing` (a read in flight over a live snapshot), `Stale` (the last
  snapshot is not the current authority — a failed refresh over the last good
  snapshot, or a backend mirror that is not current) and `Error` (no
  authoritative read at all, with a retry). A failed read is never painted as
  "no providers configured".
- The HOME lists the CONFIGURED provider profiles — the Host's own
  profile-present fact — plus the independent DeepSeek Account row. The
  presence of an API key never decides the membership, and an unconfigured
  directory route is not a HOME row.
- The credential/record state of a row is an INDEPENDENT fact, read after the
  catalog, and it has its OWN freshness: a new generation's presence is
  `Checking…` until it answers, so the previous answer is never painted as a
  fresh confirmation (a write's authoritative read-back keeps its priority
  through the per-reference generation fence). `Configured` /
  `Key missing` for an API-key reference, `Signed in` / `Not signed in` for a
  provider-native sign-in, `Checking…` while the read is pending, `Outcome
  unknown` for a failed read and `Unavailable` for a backend that cannot
  answer the question. A credential reference may be shared by several
  providers: the reference is read ONCE per generation and every row shows
  that answer.
- The stored-record presence is ONE enumeration for the page. The full
  Stored Credentials list (with its per-reference audit) is read only when the
  user opens that view, and a backend that cannot enumerate records is
  `Unavailable`, never an empty list. Opening that view, opening a clear target
  and the R refresh all start their read AFTER the painted frame — never in
  the input path — and a deferred read is CONSUMED by the view's own refresh: a
  user who already left the view pays no stored-credential scan, and no read
  happens twice.
- An authority-dependent write waits for the FRESH read of its OWN authority.
  The provider-profile actions (the native sign-in, the Add create and a
  provider-detail Configure API Key) wait for the provider catalog: while a
  refresh is in flight, or the last snapshot is not the current authority (a
  stale snapshot), they are disabled and the page states that the configuration
  is not current. The page addressed by an EXPLICIT credential reference
  (`/login REF`) and the stored-credential clear instead wait for the credential
  store's authoritative read of that exact identity: the reference page's write
  is disabled until `describeReference` answers (a failed read is retried with
  r), and a clear re-read drops the previous confirmation before the new answer
  arrives. Those actions stay usable when the provider catalog is stale — the
  fail-soft resolver guarantees an explicitly typed reference is addressable,
  and the write is verified by its own read-back.
- `Add Provider` is a catalog: `Available providers` lists the unconfigured
  providers this installation offers, each with the operation this page can
  really perform for it (a native sign-in, the prefilled setup draft, or an
  explicit manual-only reason), and `Other sign-ins` lists the sign-in flows
  that no provider profile addresses. One `Custom provider…` action opens the
  existing draft. The list is narrowed by typed text (a visible filter line
  with the match count); `Esc` clears the filter before it leaves the
  catalog. Browsing writes nothing; a catalog entry is activated only by an
  explicit Enter, and a route with no supported operation states why instead
  of claiming success.
- `Tab` and `Shift+Tab` move the page's ONE cursor between its body rows and its
  bottom action group (both directions toggle; the destination is the region's
  first candidate, and the first ENABLED action). The jump only repaints the
  selection and may reveal the destination row through the existing list
  scroll: it never opens a form, starts a flow or writes, and `Enter` remains
  the only activation key. A view with no body row (for example a zero-match
  Add catalog filter), no enabled action, or no paintable body/action space
  ignores the key instead of creating an invisible selection. An active
  QuestionFlow, native picker or model picker keeps its own Tab meaning; the
  page advertises `Tab sections` only while both regions are really paintable.
- Provider detail shows route, profile presence, protocol, endpoint, models,
  auth kind and credential presence (presence only, not a connection test).
- `Configure API Key` opens a page-local masked editor (the existing
  QuestionFlow component); an empty/cancelled answer writes nothing. A resolved
  `setReference` is not a success: `describeReference` must report the reference
  configured before the page paints `Verified`; otherwise it states the
  failure/unknown outcome. Below the QuestionFlow's 8-row supported budget the
  page paints a resize state and refuses submit; eligibility is re-evaluated
  against the live body height and the current auth-notice rows on every input,
  not only when a frame is painted.
- `Clear stored credential` is a single explicit confirmation for the exact
  identity (reference vs stored record). The confirmation is enabled only by
  the AUTHORITATIVE read of that identity: a target that is still `reading`
  cannot be confirmed (the delete is never dispatched before the store was
  checked), and a deeplink that opens the target reads it after the first
  frame. A clear that is IN FLIGHT owns its own state: a refresh never re-arms
  or resets it, the confirmation stays locked until the Host answers, and the
  same delete can never be dispatched twice. After the clear the page re-reads
  the exact key; it never claims success without the authoritative absence.
- A stored-RECORD clear has four truthful outcomes, not one failure bucket. A
  dispatched delete whose Host settlement the Client could not observe (lost
  ACK, transport throw, cancelled/internal failure) is `Outcome unconfirmed —
  refresh stored credentials before retrying`: the page keeps the exact key,
  offers only the read-only `Refresh records [r]` action and never re-sends the
  delete or reuses the old confirmation. A definite pre-dispatch refusal
  (no current Connection) is `Not sent`; a definite input refusal is `Failed`;
  a record still present on the current Host is `Still stored` (it may have
  been re-created) and never claims the delete did not run; a successful
  readback reports `local stored credential cleared` and states that this does
  not revoke access at the issuer or switch the current model. A readback
  failure is unconfirmed too. An unconfirmed view may be left (`Esc`); a
  pending mutation still blocks leaving and a second dispatch.
- The custom provider draft is one page-local form over route → protocol →
  base URL → display name → optional key → discovered/manual model ids →
  review → create. Nothing persists before Create. Profile and credential
  writes are separate Host operations; a persisted profile with a failed key
  write is reported as a partial outcome with the exact failed stage.
  The Create is CONDITIONAL: it writes the profile of a NEW route, it is
  refused when the route already has a profile, and it is checked against the
  revision its decision was read at — a provider configured in the meantime
  is refused (the user re-reads and retries), never overwritten. A directory
  route whose profile lives OUTSIDE the conventional provider slot (the
  catalog's `Manual setup only` rows) is refused too: the wizard can only
  write the conventional slot, so it never reports a created provider the Host
  would not read. The same rule governs the keyless profile write after a
  native sign-in: it never overwrites an existing profile, and a failed OR
  stale provider read authorizes no write at all.
- Provider-native sign-in uses the existing authorization attempt owner: early
  events are buffered before attempt binding, notices/URLs stay visible above
  in-page prompts, select/text/secret prompts answer through `respond`, a Host
  withdrawal closes only that prompt without answering, and settlement returns
  to the provider detail. A successful sign-in may write a minimal keyless
  profile for an unconfigured catalog route. An ordinary cancel/back is a
  REQUEST: it keeps any open prompt answerable and waits for the Host's
  authoritative settlement; the page refuses user navigation while a key
  write, Add Provider create, clear or native attempt still owns it. Browser
  Account attempts are never cancelled this way. A forced page teardown
  (blocking owner or workspace teardown) cannot keep a prompt answerable: the
  adapter releases the destroyed prompt bridge as cleanup, and the Host may
  report failed/cancelled even when a commit had started; the next Host read
  remains authoritative. That forced-teardown boundary has no safe
  adapter-only outcome.
- On the Split wire a lost attempt stream (including the page's own teardown
  closing it) is the FOURTH outcome `unconfirmed`: the page closes the open
  prompts/notice and states that the sign-in outcome is unknown and credentials
  must be refreshed first. It never paints failed/cancelled/authorized from a
  lost frame and never retries the attempt.
  A roster that was not read for the current Connection generation is stale:
  `/login` falls back to the Models list and the page revalidates before
  offering a native attempt; a Host without the authorization service keeps the
  API-key/provider list usable and states that native sign-in is unavailable.
- Stored credential records exclude the DeepSeek Account grant; the row is
  never a generic `/logout` clear target, while `/logout deepseek-account`
  keeps opening the Account sign-out surface. A foreign-scope orphan record is
  listed as its raw key with its exact kind and is clearable by that exact key.
- A STALE authorization roster never decides a `/logout` target: account
  sign-out and an explicit credential reference (a known reference name, or a
  token the route grammar cannot produce — uppercase/underscore) stay
  addressable, while a route-shaped or ambiguous target falls back to the
  stored-credentials list, which reads the CURRENT Host first. An unknown
  target in that state opens the list instead of an error page.
- The `/login` and `/logout` resolver stays fail-soft when a read fails: the
  always-present builtin target (whose reference is a constant) remains
  addressable, and an explicitly typed reference still resolves. A route whose
  credential reference is UNKNOWN (a failed settings read, a failed or stale
  Remote directory read) is not offered as a route→reference authority — a
  derived reference would be a guess that can point at another provider's
  key, and the last-known routes may belong to another Host.

### Account page

- Host `AccountView` phases drive the display (`succeeded` is presented as
  Authorized). A detached view is current only while paired with its adapter-
  issued local observation lease; without a valid lease it is last-known, not
  signed-out. Invalidation never implies a credential change. `credential-stored`
  is a storage fact, not a server-validated identity; profile and balance are
  independent queries with independent pending/failed/ready states, and an
  unavailable balance is never shown as 0. The page binds profile/balance reads,
  every Account mutation and the running-task risk read to the same current
  observation. A stale lease keeps profile/balance/links and authorization URLs
  last-known; already-started profile/balance results cannot commit across the
  account state serial. The official Watch is the only writer of the page's
  AccountView; Refresh releases the current subscription and waits for its complete
  initial snapshot. Stale Profile/Balance facts are marked last-known, and a stale
  authorization URL is not presented as current.
- Wallet decimal strings are forwarded verbatim. `Usage` and `Top up` use the
  client-local HTTP(S) opener with the official `AccountView.links`; the page
  never receives a token or grant payload.
- Sign in starts the official browser attempt with the Host's own loopback
  callback origin and login source `web`, and paints the authorization URL plus
  the SSH tunnel template for the current callback port. Cancel addresses the
  exact attempt id; a stale id cancels nothing.
- Sign out is an explicit confirmation with the account identity and the
  running-account-task risk. The page starts an asynchronous Host check; while it
  is pending or unavailable, Sign out is disabled and the distinct status is
  visible. An unavailable result offers `Retry task check`; only a current known
  result enables the destructive action. The check's Host authority and
  Direct/Remote semantics belong to [host-client.md](./host-client.md#provider-credentials-and-deepseek-account).
- The Watch subscription is the only writer of the page's AccountView. A successful
  SignIn/Cancel/SignOut call ends local `busy`; until the next complete Watch
  snapshot arrives, the prior view and its details are last-known and cannot
  authorize another mutation. A failed or unconfirmed mutation shows an explicit
  result notice, is never replayed automatically, and closes any SignOut
  confirmation. Explicit Refresh releases the old subscription and reopens the
  official Watch. Older task checks cannot authorize a newer Account view,
  confirmation, page or connection.
- The official `signOut` removes the local grant and leaves remote revocation in
  the background. A failed revocation never restores a local grant, and
  independent API keys stay stored. While sign-out is pending, user navigation
  and page exit are refused.
- Closing the page ends only the watch subscription; an in-flight browser
  attempt keeps running on the Host, and reopening reads the Host state again.

Authority: `src/tui/commands/settings.ts`
(`readSettingsWorkspaceSnapshot`, `commitSettingsWorkspaceField`, the Models/
Account page sources), `src/app/command/credential-workflow.ts`,
`src/app/command/account-workflow.ts`, `SettingsWorkspacePanel`,
`ModelsWorkspacePage`, `AccountWorkspacePage`, `TuiApp.openSettingsWorkspace`.

Must-not: add a second store/subscription/write path, fabricate defaults, commit
after close/replacement, paint a non-ready save as verified, show a secret or
token, infer credential presence from a route, offer an invisible confirm
target, clear the Account grant as a generic record, let an older page
settlement repaint the current page, drive the visual-tools switch from a TUI
preference, or claim its Host registry registration took effect when the
backend has no registry evidence.

### MCP servers page

`/settings → Tools → MCP servers` is ONE embedded specialist page inside the
shared Settings lease (no second alt-screen, modal or Settings workspace). It
lists the ONE Host manager's servers in the manager's own order with `Name`,
`Status` and `Source`; a row's Detail shows `Server`, `Source`, `Transport`
(always `Not exposed` — the official list publishes no transport), `State`, the
`Tool count` only when connected, `Attempt/retry` when the Host reports one, a
sanitized `Last error`, and the last probe's stage/closure facts. Status words
are the official ones; there is no invented `connected-ish`/`installed` flag.
`Source` is `Configured`, `Plugin-owned`, `Retained/removed` or `Unknown`, and a
non-current settings read never becomes `Plugin-owned`.

For a server the SAME current Host settings descriptor proves configuration-owned,
the Detail also offers `Edit`, Enable/Disable, permanent `Delete`
(User-added entries only) and `Reset to inherited` (entries whose effective
configuration differs from the base only). `Add` is a LIST action (the `a`
key); Add and Edit open a whole-page scrollable form inside the same specialist.
The form's FIXED identity line is painted INSIDE the body grant (the Root grants
no pane-header row on a narrow layout): wide shows
`<name> · Add/Edit · <source>`, narrow degrades source → mode and keeps the full
NAME and mode as the last facts — never the server selected in the list before
Add started: `Identity` (name/transport/enabled),
`Connection` (stdio command/working dir or HTTP URL), `Parameters` (one row per
argument or key/value pair) and a `Status` line with the fixed `Save`/`Esc` bar.
An Edit keeps the name read-only; a rename is two explicit actions. A stored
plain value is shown only as `Set (hidden)` in a non-editing row, while a
`${credential:REF}` reference stays verbatim. The form's draft, validation,
focus, discard confirmation and one configuration status are Client-local and
die with the page. A dirty `Esc` asks `Discard changes?` with Keep editing as the
default; only an explicit discard drops the draft with zero writes. A Save whose
draft can reach outside the Host asks ONE explicit question before writing —
`Enabling this server can execute an external command.` for a stdio entry, and
`Enabling this server can send data to an external service. Target: <host>` for
an HTTP entry (the host only, never a credential) — and only an affirmative
answer dispatches the write. EVERY dangerous confirmation — Save,
Enable/Disable, Delete, Reset and Restart — paints the same target / action /
consequence body in the view that hosts it (the form for Save and discard, the
Detail for the rest), wrapped at THAT column's real width with unbreakable
tokens hard-split, so a narrow frame with a long server name or HTTP host still
shows the whole fact; the Action Bar carries only the decision
(`y confirm · Esc cancel`). A confirmation is executable only while its entire
fact set fits the rows the current grant really gives it, and only for the
specific question INSTANCE the last painted frame admitted: each opening gets
a fresh instance identity (including a same-name/same-revision question after a
Host generation replacement, and a discard prompt reopened before repaint).
The Host generation is retired with its open question; a new question cannot
inherit an older frame's admission. A question that opened but has not painted
yet is refused exactly like a blocked one, so a key arriving inside a render
window can never commit an unreviewed write. Otherwise the bar
paints no affirmative key, says `Resize to review…`, and both the key and the
pointer refuse — an uninformed `y` is never accepted. A pointer obeys the same
modal authority as the keyboard: while a confirmation, discard prompt, restart
question or search owns the surface, no click can change the draft, and every
painted Action-Bar segment — including the input bar's `Enter apply` — is a
pointer target for its own intent. A search is the ONE modal whose filtered
RESULT rows stay pointer-selectable: a result-row click only selects (the query
and the search stay open and no Host intent runs), a wheel moves that filtered
selection only, and the search's `Done [Enter]` / the list's `Search [/]` replay
the SAME Enter and `/` sinks — the single `Cancel [Esc]` is never a second span,
it is the Root's physical escape. An ACTIVE form input is such a modal too: the
body cannot be clicked behind it, while its own `Enter apply` / `Esc cancel`
stay reachable. Every env/header value carries an EXPLICIT storage
form the user chooses — `Credential reference` (the default, written as the
official `${credential:REF}` token) or `Literal (stored in profile)` — shown on
its own row and never inferred from the typed text; the disclosure's HTTP target
is the host alone and fails closed to `Unknown target` when the URL cannot be
parsed, so no path, query or credential can be echoed. Per-key Remove is offered
for keys the BASE layer does not own only: the official per-key `unset` on a
base-owned key RESTORES the inherited value (it cannot delete it), so such rows
state `Inherited · cannot remove here` and a backspace on them is inert. The
CURRENTLY FOCUSED removable row also paints a complete `Remove [Backspace]`
segment beside `s Save` (dropped by the layout only when the row cannot hold it
whole) whose click is the same Backspace intent; an active input, an open
question or an unsettled save never offers it.

Keys: list `↑/↓` move, `Enter` opens the detail, `a` begins Add from the LIST
when the Host settings are current and no configuration write is unsettled, `/`
filters by name, `r` re-observes, `Esc` cancels search / returns to Tools; detail `p` probes, `x` asks
`Restart <name>? Live tools may be interrupted` (only `y` dispatches, `Esc`
cancels), `e` edits, `t` asks
`Change saved configuration? The MCP process may stop or start`, `d` asks the
exact-name Delete confirmation, `u` asks the Reset-to-inherited confirmation,
`r` refreshes, `Esc` returns to the list. In a form, `↑/↓`/`Tab` move focus,
`Enter` activates a field or row (a click on a painted field row is the same
intent, under the same last-painted press/release rule), `s` asks to save (an
external-capability acknowledgement first, naming the exact server, when the
draft can reach outside the Host), `Esc` leaves an input or asks the discard
confirmation — except while a Save is unsettled, where `Esc` reports that the
dispatched write cannot be cancelled here instead of offering a discard. While
an input is active `a/e/t/d/u/s` are text. An empty Enter on a `Literal` value
commits the empty string (the only way to override an inherited value with
nothing, since a base-owned key cannot be removed); an empty Enter on a
`Credential reference` keeps the current value.
Delete/Reset/toggle/Save confirmations respond only to `y` or `Esc`. While searching,
`p/x/r/y` and every CRUD key are query text only. Probe/Restart require a
current manager observation, a live (not retained) listed entry and no in-flight
operation; they do NOT depend on the configuration descriptor. Every
configuration edit additionally requires the same-generation current settings
descriptor and that entry's config source; `loading`/`stale`/`unavailable`
states explain themselves and expose no executable action. A write uses ONE official
revision-checked settings mutation; the result is `Saving configuration…`,
`Saved · waiting for Host reconcile`, a revision conflict, an unavailable Host,
a proven refusal, or `Outcome unconfirmed …` after a lost settlement. A saved
configuration is NEVER reported as Connected; the manager's watch remains the
only status authority, and Probe/Restart results never overwrite the saved
configuration fact. Probe reports a positive result only when the official
result is `ok` AND cleanup is confirmed; a connected-but-unclean probe is its
own `cleanup not confirmed` fact. A settled restart says
`Restart settled · awaiting connected status` and waits for the watch; a lost
settlement says `Outcome unconfirmed; refresh Host status before
retrying` and is never retried.

Layouts: `≥108` columns paint the list and the selected server side by side with
one focus (`Enter` switches to the detail actions, `Esc` back to the list);
`76–107` paint one compact column with a selected-row summary and an in-page
detail state; `≤75` paint the list only. `44×8` keeps the selected row, its
status and the complete `Back [Esc]`; the form keeps the current field, its
status and `Save`/`Esc` reachable. Mouse targets are the last painted cells and
a press whose frame repaints never completes. A wheel reaches only the region
under the pointer: the list moves its selection, the Detail scrolls itself, the
form moves its OWN field focus (never the hidden list selection or detail
offset), and a search wheel moves only the filtered result selection; ANY
effective wheel — a boundary/no-op one or one a modal ignores — retires the
pending press. The pointer identity additionally carries the page revision and
the READ-ONLY Host roster / configuration-read epochs, so a press recorded
before a Host replacement (even one with identical names, statuses and row
count) or before a configuration re-read is refused until the next frame
paints. That is UI anti-replay only: the Host manager generation, the official
settings revision CAS and the write terminal settlement remain the sole write
authority.

Authority: `src/app/command/mcp-servers.ts` (`McpServersController`),
`src/tui/panels/mcp-servers-page.ts`, the `McpServerPort`,
`ConfigPort.mcpServerSources` / `ConfigPort.mcpServerConfiguration`, and the
shared Settings panel.
Must-not: spawn or speak MCP itself, write a second profile file or bypass the
official settings mutation, treat `configured` or a materialized USER key as a
source/override verdict, rewrite a whole existing entry (dirty paths only),
offer permanent Delete for an inherited/overridden server, show a resolved
secret, own a second fleet/status cache, optimistically paint Connected after a
configuration write or restart, retry a dispatched write, or let a late result
from a replaced Host generation reach the page.

### Computer Use page

`/settings → Tools → Computer Use` is ONE embedded specialist page inside the
same Settings lease (no second alt-screen, modal or Settings workspace). The
official Experimental `Computer use` Plugin Manager card's bounded
`Manage Computer Use…` action switches to the SAME page in the SAME lease: the
root retires the Plugin child and releases its claim on the next frame before
mounting the page. The page is omitted when the composition has no official CUA
access port and no Plugin Manager roster; it must not be painted as an inert
control.

Authority is never the page: the bundle selection/availability comes from the
existing Plugin Manager roster, the saved default preset from the existing
`ConfigPort.presetDefault`, and system permissions, the official helper /
launch-application identity, PTC execution and persisted application decisions
come from the official provider through the ONE semantic `cuaAccess` port
(Direct: the live Host service resolved per call; Split: the official generated
`@deepseek-ai/dsh-cua/remote` namespace with connection-generation fencing).
The page owns only a per-open observation epoch, one serialized write and its
cursor/scroll/confirmation/help state.

A disabled or missing bundle paints `Disabled`/`Unavailable` and performs no
CUA query; it is never a fabricated denial or `Ready`. A supported Host paints
Accessibility and Screen Recording as two independent observations
(`Allowed`/`Not allowed`/`Unknown`), and the helper/launch-application identity
and Host platform actually reported by the provider. `Request permission` and
`Open settings` are action receipts only: a successful call does not paint
Allowed; a fresh read must observe it. An unknown/unavailable read never keeps
an older `Allowed` actionable. The PTC facts are separate: the saved default
preset changes NEW Sessions only, while persistent PTC is an explicit
confirmed write with a possible runtime reload.

The persisted application decisions are listed from the official
`applications()` result only; Session-only grants are not listed. `Revoke…` and
`Allow asking again…` use the exact opaque `CuaApplicationId` that was painted,
require a reviewable confirmation (affected work may stop / no access is
granted), never target an application by name re-resolution, and re-read the
official list afterwards. A confirmation is its own projection: the confirm
key is paintable only while the complete risk text and target fit the granted
body; a short frame paints cancel/back only. Closing the page or a Host/
connection generation change discards late results; a dispatched Host effect
is not claimed undone.

The short/narrow first screen (`44×8`) keeps the bundle/Host identity and the
first missing permission action reachable; the body scrolls freely (wheel or
keys) and is never jumped away from its first facts by an automatic selection
scroll. Actions require the CURRENT painted frame and a live re-read of the
target, and the controller admits ONE write per open (a second buffered
Enter/click is refused). The page's `Open Settings → Plugins` action retires the
specialist and switches the SAME lease to the Plugin Manager. After the first
explicit bundle enable the Plugin Manager shows a one-shot recoverable next-step
notice that points at this page; the Tools row and the card's
`Manage Computer Use…` remain available later. The official application-consent
Question keeps the existing Question seat and answer writer, and paints the
official `Risks` card for the `cua-app-access` approval (no second Question
owner or answer queue).

Must-not: read or write the macOS TCC database, call `osascript`/`tccutil`, run
`open` on the Client to fake the Host's System Settings, infer the responsible
app from the terminal, keep a second permission/application store, poll in the
background, auto-enable the bundle or persistent PTC, or paint a Client-local
platform verdict for a Split Host.
