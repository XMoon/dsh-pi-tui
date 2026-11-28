# Settings Workspace behavior

Settings page navigation, editing, read/write settlement and presentation are owned here; Host credentials and configuration authority are not.

This is the sole owning document for the following surface-specific behavior. See
[host-client.md](./host-client.md) for Host authority and
[overlay-focus.md](./overlay-focus.md) for focus/lease lifecycle.

## Settings Workspace

`/settings` and its real alias `/status` open ONE fullscreen lease with ONE
navigation focus state. The category rail is the selection owner; the right
column is the content. Width only projects panes (≥108 three, 76–107 two, <76
one). The category order is the fixed `About, Host, Models, Account, Agent,
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
  name and never the position. Owner-group switching is intentionally
  keyboard-only: the existing `Tab`/`Shift+Tab` contract is the documented
  pointer-coverage exception, and pointer coverage is scoped to the currently
  painted owner group's rows, Detail and actions; no pointer target is added
  for switching owners. The Rows pane header degrades
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
  have two explicit modes. The original runtime-only mode stays entirely
  in-process: nothing is written to the TUI settings document or a Host
  profile. A persisted row is an author-declared opt-in over that package's
  official per-package Config carrier: the Detail states `Host profile ·
  effective`, `Inherited`, `USER field`, `Differs from inherited` and
  `Runtime in this Client` as separate facts; an unavailable or stale Host
  authority is read-only with its reason; and one Confirm dispatches ONE Host
  Config CAS write relative to `data`. A conflict paints
  `Not saved · Host Config changed; refresh and review`; an unconfirmed
  dispatch paints an unknown outcome and is never retried automatically. A
  verified Host save is independent from this Client applying the new Config.
  The Choice `[current]` candidate is derived from the authoritative EFFECTIVE
  value only: a declared `set` matching it, or the `unset` choice when
  EFFECTIVE equals INHERITED. A matching USER value alone never marks
  `[current]`; an out-of-choices external effective value keeps every option
  unselected and shows the existing out-of-choices warning. Reset stages the
  official field `unset`: the authoritative EFFECTIVE value must return to the
  inherited value. The USER own field may remain present when another sibling
  override keeps the USER config alive; the Detail shows that literal USER
  state rather than claiming the field vanished.

- The wide frame (`W ≥ 108`) distributes its live INTEGER cell grant across
  `Categories | Rows | Details` in bounded steps:
  `Categories = 22 + min(8, floor(max(0, W−120)/10))`,
  `Rows = 42 + min(28, floor(7·max(0, W−120)/20))`, and `Details` takes the
  remainder after both 2-cell `COLUMN_GAP` gutters. The allocation is a pure
  function of the width: no theme, focus, content, Host state, preference or
  cached measurement participates, so data can never move a column. The two
  gutters are blank and own no target, scroll or copy. The medium 76–107
  adjacent pair, the `<76` single column, the medium 22/40 widths, the
  height/chrome budget and the focus ladder are unchanged. The SAME `Categories`
  width rule positions the wide direct-pages rail (About/Models/Account) and the
  Plugins `W ≥ 120` rail; the Plugins child keeps its own local split and
  six-real-body-row admission (see [surface-plugins.md](./surface-plugins.md)),
  which is never the Standard `Rows` width.

- Every category shares ONE root row plan: header, optional metadata, at most
  one top rule, optional app notice, optional pane header, body, and the single
  physical last-row Action Bar. Entering or leaving an inline choice does not
  change the root chrome allocation. Only the actual viewport and admitted
  notice/row budget govern its degradation; the choice body consumes the same
  real grant. The app notice is the ONE root-level notice;
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
- **Each browse level publishes at most ONE forward pointer target.** On the
  category rail the fully painted `open`/`focus` hint is the pointer analogue of
  `Enter`/`Right`; on the Rows level each painted `Right`/`Enter <action>` half
  is targetable, and when both halves are on screen they join into ONE span over
  the cells the LAST frame really drew (a half the width dropped or truncated is
  simply absent). Its release replays the CURRENT state's Enter ladder
  (`handleInput('\r')`). The action word is the
  row's real forward action: a mountable embedded specialist page is `open`, a
  row whose specialist page cannot be composed or opened stays `details` (never
  a false `open`), a writable row is `choose` unless an edit commit is pending
  (the choice cannot start then, so the word is `details`), and every other row
  is `details`. A hint the width dropped or truncated publishes no target, and
  clicking the row itself still only selects it. The Detail level publishes no
  second forward target: its own `Change…`/`Manage…` affordances remain the
  pointer route.

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
- The configuration categories (`Host`, `Agent`, `Appearance`, `Conversation`,
  `Input & Terminal`, `Tools`, and the conditional `Extensions`) keep their
  three-level browse (L0 categories, L1 rows, L2 detail). `About`, `Models`,
  `Account` and `Plugins` remain direct content pages. `Host` is the USER-facing
  title of the internal `general` category: it holds the startup backend, the
  `Web UI` page entry, the `ACP access` page entry and the official
  session-log upload switch in one frozen order.
- Configuration rows keep their distinct writer kinds: the configured theme,
  transcript display preset, icon style, mid-turn progress-updates cadence,
  response style, Git attribution, Home/End keys, Mouse wheel lines,
  Notifications, Notification method, Terminal progress and `Agent` user-shell
  sandbox policy are persisted through the ONE serialized TUI settings document;
  the profile-wide `Visual tools` switch and `Host` startup backend
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
- A Host-form scalar whose writer is revision-and-authority checked (Visual
  tools, the startup Backend, the Web next-start preference, Session log
  upload) carries that section's revision AND its opaque settings-authority
  generation as ONE captured decision. The L2 fence is never rebased from a
  later refresh, and the shared serialized Config queue re-proves both at its
  head before dispatch; a moved revision or a REPLACED generation — even one
  exposing the same revision and value — is a definite refusal (internally
  `not-saved`, painted `Could not save`) with ZERO target mutation. Only a
  CURRENT same-generation readback can earn `verified` (painted `Saved`); an
  accepted write the readback cannot attribute is internally unverified and is
  painted `Could not confirm save`, never a refusal. The Root's own Change entry
  re-proves that the row it painted still addresses the same authority after
  its refresh; otherwise the old gesture
  stays browsing and a new explicit gesture is required.
- **Host-configuration save feedback.** The three Host-configuration scalars
  (`Backend`, `Tools · Visual tools`, `Host · Session log upload`), the hosted
  Agent/Shell/Subagent writers, the `Web Search / Fetch` page and the
  `Web UI`/`ACP access` pages project the SAME internal settlement as one
  short, scope-local result: `Saving…` for a
  pending save (the Web UI/ACP runtime phase keeps `Waiting for the answer…`
  and their copy phase keeps `Copying the client command…`); `Saved` for a
  verified save; `No changes` for a legitimate no-op;
  `Could not save` plus the real reason for a proven pre-dispatch refusal or CAS
  conflict; `Could not confirm save` plus `The change may have been saved.
  Refresh and check.` for an accepted-but-unattributable readback or lost
  receipt; `Web enabled`/`Web disabled` or `ACP enabled`/`ACP disabled` for a
  verified live runtime action; `Could not confirm change` plus `Refresh and
  check.` for an unattributable runtime request; and `Requested state not
  reached` when the request reported success but the observed state differs.
  These words never authorize an action: the internal four-way settlement,
  same-generation readback, typed refusal-vs-unknown distinction, dirty/leave
  guard, Retry policy and business writer are unchanged. A clean browse paints
  no persistent saved/verified banner. A retained historical success never
  claims currency. When the source is not ready, the numeric pages, the Root
  Host-configuration scalars, the Subagent page and the `Web Search / Fetch`
  page demote it to `Last-known · read-only` with `Previous save completed;
  refresh to review.`; a READY replacement retires the obsolete receipt without
  a read-only claim. A
  known-success receipt is bound to the observation that proved it: a later
  Host/Config observation retires it rather than repainting it as current. No
  settlement surface presents a stale success as a current saved value.
  The Subagent page keeps each namespace's own prefix
  (`Limits: Saved` / `Selection: Could not confirm save`), and Copy/Open
  receipts keep their own fixed words.
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
  - `Backend` (`startup-backend`) is a NEXT cold-launch fact only: a save never
    switches the running TUI/Host. Its L2 decision captures the Host form
    section's revision AND its opaque settings-authority generation; both travel
    with the request through the ONE serialized Config write queue to the
    dispatch boundary, so a replaced Host (even one that exposes the same
    revision and value) cannot receive the old decision. A verified NEW value may
    open ONE transient follow-up inside the SAME lease (`direct → daemon` offers
    the optional service install; `daemon → direct` records the process-lifetime
    exit-transition intent). The follow-up exists ONLY for a same-generation
    `verified` result (painted `Saved`) that actually changed the value: a
    same-value save, a
    pre-dispatch refusal, an accepted-but-unverifiable readback and an unknown
    outcome never record an intent or offer the install, and offer no `Retry
    save` — a fresh explicit `Change… → Confirm` is the only way to act again.
    `Not now`/Esc/row change withdraws it with zero management IO, one explicit
    `Install service` confirmation drives exactly one profile-scoped install
    through the existing control plane (never a start/enable/migrate), and a
    platform without the local capability paints only the truthful refusal
    line. A stale settlement never repaints a newer follow-up.
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
  `Parallel tool calls` (always reachable so its official section can state its
  own readiness; the internal row id stays `agent-loop`). The
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
  - `Subagent settings` is the third real grouped Detail TENANT: it mounts
    INSIDE this workspace's existing Detail pane, so the parent Categories/Rows
    stay painted and readable while it holds the active device. Its route is
    entered only through Rows `Enter`/`Right` or the Detail preview's `Open…`
    (a painted row click only selects), and its one page renders the two
    official sections as ONE group of four fields: Limits (`maxDepth`,
    `maxActiveSubagents`), then Model selection (`enabled`, `allowedModels`).
    The Root keeps the ONE physical Action Bar and the ONE Esc affordance; the
    child's painted bar is that last row, and every actionable key is admitted
    only through its really painted span (the body fallbacks included).
  - The group browses fields without a second store: a field row click only
    selects, and the selected field's complete explicit action
    (`Edit [Enter]` for a number, `Toggle [Enter]` for Enabled,
    `Manage [Enter]` for the model directory) is the ONE way to start a change.
    `Tab`/`Shift+Tab` move the field selection locally. Numeric editing shows
    the raw Input and the current/last-confirmed value; Stage accepts only the
    field's real safe-integer contract, so empty/whitespace/negative/fraction/
    exponent/out-of-range text stays in the Input with its real error and
    stages nothing. A blank input is never an implicit Reset.
  - The selected field's `Details [?]` is a page-local Advanced disclosure in
    the SAME Detail space: it states the complete field identity, the current/
    last-confirmed, inherited, comparison, revision, scope and effect timing,
    and `Reset to inherited…` publishes after that necessary copy was really
    read. Reset stages ONE official field-level `unset` (no second confirm at
    this group level) and never substitutes `set(inherited)` or edits a profile
    file. `allowedModels` is read by its complete route identities rather than
    a count.
  - The model directory is a read-only projection inside the same tenant:
    route identity is always the exact `(provider, model)` pair, a row click
    only selects and the explicit `Add route [Enter]` / `Remove route [Enter]`
    stages the choice. A `/` search filters provider/model identities; while the
    search Input owns the keyboard, `Enter`/`Tab` is `Done` and only the real
    Back remains, and route hit targets/actions and Refresh are not painted.
    The first `Esc` ends search, and a second `Esc`/`Left` returns to the group
    with the query, the field, the selected route and the manually scrolled
    directory offset intact. At a medium Detail width the complete Refresh
    receipt survives even when the longer route action moves to its complete
    body target. A saved route
    remains visible and removable when the directory or that provider is
    unavailable; absence means only that a route was not listed in a current
    successful ready directory, never physical deletion or future routability. Removing the last allowed route while the
    candidate Enabled is On is refused with its real reason; Enabled Off allows
    it, and On with no routes is a legal dirty draft that Save refuses.
  - Save is the ONE explicit grouped commit: it validates the whole staged
    candidate and dispatches at most one exact-revision mutation per dirty
    namespace, Limits first. Selection is dispatched only while the original
    Host generation remains current. The two namespaces are not a transaction:
    each settles and reads back independently, a successful namespace is not
    rolled back when the other fails, and only its own verified fields leave the
    draft. A captured-authority change rejects the whole intent; a definite
    stale sibling does not block a still-current dirty namespace, while a
    settled unconfirmed outcome offers no new Save/Retry and requires an
    explicit Refresh. A lost settlement paints `Limits: Could not confirm save`
    and/or `Selection: Could not confirm save` with the save-feedback recovery
    line and is never replayed automatically; a saved result requires a current
    same-generation authoritative readback, not only an ACK.
  - Dirty parent navigation is the ONE page-owned leave question: `Save` keeps
    the group, `Discard and leave` clears the local intents and re-proves the
    captured target before it navigates, and `Keep` stays. A settled unknown
    outcome is asked as `Leave anyway` and never claims a rollback. Save/exit,
    Refresh and the question are admitted only while their necessary facts and
    the complete action span were painted in THIS frame; a bar-dropped action
    stays reachable through its body fallback, and a grant that cannot paint
    the necessary copy publishes only the safe Back/Keep/Wait. The current
    field's visible block, the real dirty count, the section settlement and any
    refusal reason are the priority facts on a short grant.
  - Limits affect later subagent delegations. Model-selection policy is sampled
    when a new top-level Session is composed; an existing Session keeps its
    recorded policy after settings change.
  - `Subagent settings` labels each unavailable or last-known section
    independently; an unreadable or stale section is read-only and its facts
    never become a fabricated current value. A User-patch materialization on
    Reset is legal: DSH's Host readback decides the effective value, and
    physical USER-field deletion / `overridden=false` are not Reset success
    criteria.
  - Every `Agent` row that owns a Host write refuses to offer a confirmable
    candidate while its authority cannot vouch for the value: a non-`ready`
    backend (or an unreadable document) keeps the row and its truthful
    last-known/raw facts but offers no candidate, so the UI never invites a
    Confirm that the writer must refuse.
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
  its Web rows, phase map and credential hand-off) no longer exists, and the
  retired PiTui `/acp` short `SettingsList` menu is gone too. `/web` and `/acp`
  are NOT independent overlays any more: both are typed deep links into this
  workspace's `Host · Web UI` and `Host · ACP access` pages (see below).
  `/preset` is its own independent root capturing overlay
  (`TuiApp.openPresetPicker`), never a `SettingsList` row list and never part
  of this workspace's lease. `/keybindings conflicts` is NOT one of them: it
  enters the same Keyboard shortcuts specialist page in this workspace.
- `Tools` holds the built-in `Visual tools` row (backed by the Host profile's
  `pi-tui-visual-tools.enabled` volatile Config, schema default On), the
  `Shell execution` specialist entry, the `Web Search / Fetch` page entry, when
  the official manager is mounted `MCP servers`, and when the official
  Computer Use provider and Plugin Manager roster are mounted `Computer Use`,
  in that frozen order. Neither the ACP listener nor its next-Split-Host
  startup preference is in `Tools` any more: both live inside the ONE
  `Host → ACP access` page (see below), with no second row. The Web preference
  has no standalone row at all — it is edited inside the `Web UI` page (see
  below).
  Its stated value is the effective Host form value; `[default]` marks a value
  the USER layer does not declare. Confirm writes that ONE field through the
  official revision-checked settings mutation and re-reads the Host. The L2
  decision captures the section revision AND the opaque Host settings-authority
  generation from the SAME observation; the replacement fence travels through
  the shared serialized Config queue to the dispatch boundary, so a replaced
  Host (even with the same revision/value) is painted `Could not save` with zero
  dispatch. An accepted write paints `Saved` only from a CURRENT same-generation
  readback that carries the requested value; an accepted-but-unattributable
  readback paints `Could not confirm save` + `The change may have been saved.
  Refresh and check.`, never `Could not save`, and never triggers the runtime
  claim below. Non-verified outcomes offer no `Retry save`: the user returns
  with a fresh explicit `Change… → Confirm`. Off
  releases both built-in registrations from the global Host tool registry and
  On restores the original definitions; already-recorded results and their
  rendering, copy, search and export are unaffected. A missing, unreadable or
  non-current authority keeps the category and row visible but offers no
  candidate and refuses the write (never a fabricated default). On a Direct
  backend `Saved` also requires the Host row's live registration fact to agree;
  a stored On/Off the registry did not adopt paints `Could not confirm save`
  with the specific `Tools are not active` / `Tools are still active` reason.
  Remote has no registry read and states the runtime half as unobservable
  instead of claiming success.
- `Web Search / Fetch` is the ONE Adaptive Web WORKBENCH inside this same
  workspace lease: `Enter`/`Right` on the Tools row (or its ONE painted
  `Configure Web…` action) mounts it once under the same header/metadata/notice
  and the same ONE physical last-row Action Bar. The REAL Categories rail stays
  painted beside the page's own List/Detail regions while the grant supports it;
  the workbench is never the legacy `SettingsList`, a second alt-screen overlay,
  a second settings manager, a fourth column or a new generic controller. Its
  `Esc` ladder is `Web Detail → Web list → the REAL initiating level` — the
  Tools Rows level for a Rows entry, the Tools Detail for a Detail
  `Configure Web…` entry. The visible rail's Back leaves the workbench for that
  same level; it never closes the whole Settings workspace.

  The ONE real grant decides the projection (W = frame width, H =
  `chromeGeometry(plan).contentRows`, C = the elastic Categories width, G = the
  2-cell gutter); a page-local width breakpoint or a terminal-size guess never
  does:
  - `W ≥ 120` and `H ≥ 6`: `Categories(C) │ Web List(34) │ Details(D)` with
    `D = W − C − G − 34 − G` (the wide frame always keeps `D ≥ 40`). The rail
    stays painted while either the rail or the page owns the keyboard.
  - `76 ≤ W < 120` and `H ≥ 6`: rail focus paints `Categories(22) │ Web
    List(W − 24)` with the child list only; child focus paints `Web List(34) │
    Details(W − 36)` and the rail steps aside.
  - any `W < 76` or `H < 6`: exactly ONE current region — the Categories rail
    while the rail owns the keyboard, otherwise the child's current list or
    Detail region.
  - `H = 0`: only the truthful Back physical row remains; no body cell is a
    target and no page read, Tab, Open, refresh, credential or Confirm runs.
  The child's local `List(34) │ 2-cell gutter │ remaining Detail` split is
  measured from its granted BODY width, never the terminal width, and the ONE
  physical Action Bar always starts at column 0 with the FULL frame width (the
  page receives that bar width separately from its body grant). The body keeps
  ONE active cursor/`[Label]` device per region; a cropped grant scrolls instead
  of hiding an activation, and an Enter whose candidate is not inside the
  painted viewport does nothing.

  The Root owns the ONE seat and the child owns its ONE local region. A list row
  click/keyboard selection — including a click on the visible passive preview
  while the rail owns the keyboard — only SELECTS and hands the keyboard to the
  Web list; `Enter`/`Right`/the painted `Open [Enter]` is the ONE explicit entry
  into the selected row's Detail, and an option click only moves the draft.
  `Tab`/`Shift+Tab` is a pure focus transfer: List ↔ Detail while the pair is
  visible, the untouched list may yield to the rail (at 76–119 this reveals
  `Categories │ List`) and return to the SAME list, and it is inert in a
  one-region projection. The Detail's own Back cancels the unsubmitted local
  candidate without a Host write; the rail's Back/Esc returns to the real
  initiating level. A Saving row refuses a parent category/Tab jump from every
  seat; an active choice or a Detail-held unknown outcome refuses the parent
  retire, while a clean browse or a truly read-only Detail allows it. A
  category change retires the SAME instance exactly once.

  The ONE physical bar states only what THIS frame offers: list `Open [Enter] ·
  Refresh [R] · Back [Esc]`; writable Detail `Confirm [Enter] · Refresh [R] ·
  Back [Esc]` (plus a muted candidate hint when it fits) only while the
  highlighted candidate is inside the painted Detail viewport; read-only/
  loading `Refresh [R] · Back [Esc]`; Saving `Saving… · Back [Esc]`; credential
  Detail `Open in Models… [Enter] · Refresh [R] · Back [Esc]` while a selectable
  credential action is really visible. Whole segments are dropped, never cut;
  where nothing whole fits, the real Esc key remains the documented exit. Long
  natural-prose explanations wrap to a comfortable reading width (about 72
  cells); real values, identities and YAML facts keep the full granted width.

  The page paints exactly NINE rows in this frozen order: `Web Search Provider`,
  `Web Fetch Provider`, `Search API Result Count`, `Share Original Question`,
  `Search Billing`, `Fetch Billing`, `Search API Override` (read-only),
  `Fetch API Override` (read-only), `DeepSeek API Key`. A candidate, state word
  or `[current]` chip is never painted partially, and terminal-untrusted Host
  text (custom provider ids, URLs, credential source) is painted through the
  existing sanitizers and width helpers.

  Authority is the Host `web` / `web-deepseek-api` sections through the
  `WebProviderConfig` read and its provider/count/question/Billing setters. A
  ready read carries the opaque Host settings-authority generation and both
  namespace revisions; page entry, explicit `r`, queue admission and post-write
  verification use `readFresh()` (Direct: a real descriptor read; Remote: an
  official `describeFresh`), never a cached mirror. A synchronous currentness
  fact compares a cached observation with the adapter's known generation and
  revisions; a non-current observation paints `Last-known · read-only` for the
  affected row, offers no Confirm and cannot authorize a write. Count/question
  depend on the API namespace, provider rows on `web`, and Billing on both;
  an independent namespace revision never makes another row unwritable. The
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
  never edits the profile document. The confirmed decision carries the
  generation and BOTH revisions of the frame that painted it plus the raw layer
  facts; the command FIFO and the adapter's actual dispatch boundary re-prove
  the SAME generation, the target `web` revision and those facts. A moved target
  revision (including a sibling field) or changed deployment/USER facts is
  `Could not save` with ZERO writes; a newer read is never adopted as a new
  authorization. A legal no-op (no USER own-field and effective equal to the
  deployment base, or an explicit USER pin already carrying the requested id) is
  the distinct `No changes` outcome with ZERO Host mutation. `Saved` requires a
  trusted fresh readback started after the receipt: the effective raw id equals
  the fresh deployment `baseId` for a reset, and an explicit set additionally
  requires the USER own-field to carry the requested id. The Host may keep an
  explicit USER value equal to that base while the same section carries another
  USER override; the page reports that residual state as a fact rather than
  claiming the USER field vanished. The count row offers the `5/10/20/50` presets while the official domain
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
  paints `Confirm [Enter] · Refresh [R] · Back [Esc]` (plus a muted `↑/↓ choose`
  hint when the width allows) only while the highlighted candidate is inside the
  painted Detail viewport and the latest authority is ready and writable; a
  candidate row click only moves the draft highlight and writes nothing, and
  the list's `Open [Enter]` is the explicit Detail entry. A Confirm span
  that is absent, cropped, from a previous frame or invalidated by any
  key/wheel/resize/refresh/save phase dispatches nothing. The confirmed decision
  carries the EXACT semantic action, raw candidate, row and original capture
  (generation, both revisions and observed facts) from the LAST painted frame;
  keyboard `Enter` and the delegated span consume that same typed decision,
  never a live index or a candidate list re-derived after the paint, and an
  A→B→A authority round trip cannot revive an earlier press. At its turn the
  intent re-proves readiness and section availability against that capture,
  refuses a changed generation/target revision/semantic fact with ZERO writes,
  and dispatches the ONE official setter (or the official reset described
  above). A target `web` revision change (including a sibling field) refuses
  provider writes; count/question bind only their own `web-deepseek-api`
  revision; Billing additionally binds the `web` provider dependency revision
  and re-reads raw eligibility (its API is still the explicitly selected route
  and its capability override is still unset). A fresh read started after the
  receipt decides the settled word: `Saved` only when it belongs to the
  captured generation and holds the requested raw value/action (for a provider
  row, the provider layer rule above), `No changes` for a validated zero-write
  request, `Could not save` (with the value the Host really keeps) for a proven
  pre-dispatch refusal or CAS conflict, and `Could not confirm save` when an
  accepted write's readback is unavailable, different or superseded (the Detail
  adds `The change may have been saved. Refresh and check.`). A superseded read
  never decides a verdict; a newer read is awaited first, and a page closed
  mid-write only loses its own repaint — the dispatched Host operation still
  settles in the command owner. Confirming a value the authority already holds
  performs NO setter and is `No changes` (that states the current fact, never a
  promise about the stored USER layer) — except that a provider row's no-op
  additionally requires the USER own-field to carry that id; the AUTOMATIC
  (absent) provider state never satisfies an explicit candidate — confirming one
  always issues the ONE real setter and verifies from the fresh read-back.
  `Loading…` on page entry or `r` is a real pending state, never a last-known
  value presented as current. A readable but non-current authority demotes the
  value head to `Last-known · read-only` and a retained success to `Previous
  save completed; refresh to review.`; a newer trusted observation retires the
  old success instead of repainting it as current. Every read that settles
  refreshes the Tools row summary and the mounted page from the same facts.

  `DeepSeek API Key` shows ONLY the official credential reference
  (`DEEPSEEK_API_KEY`), its presence and its source layer — never the value.
  Its two body actions are `Configure in Models…` and `Clear in Models…` (the
  latter only while the fresh official fact is configured), the bar names the
  selectable one as `Open in Models… [Enter]`, and both hand a typed
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
  `Input & Terminal` carries `Keyboard shortcuts…`. `/footer`, `/statusline`,
  bare `/keybindings` and `/keybindings conflicts` are TYPED DEEPLINKS: the
  command validates the exact row/page pair, takes the Settings lease and
  mounts the page on the first real body grant (never before the lease, never a
  fallback overlay). Bare `/keybindings` opens the page's `All` view;
  `/keybindings conflicts` opens the SAME page and lease in its transient
  `Conflicts` view. A failure to read the settings document or mount the typed
  page is a real command error that also carries the current runtime conflict
  records; it never degrades to a second overlay. The page keeps
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
- A verified write settlement (`Verified`, or `Saved` for the
  Host-configuration scalars above) requires a ready read-back with a matching
  value. A refusal is proven by the write path; a fresh read establishes the
  current fact, never attribution of an unknown prior write. The painted word
  follows the Host-configuration save feedback above
  for those scalars and each other row's existing `Status` vocabulary; a
  refused or unattributable write is never reported as success. For the
  apply-first fields a failed persistence never rolls the live runtime back, so
  the screen must keep stating BOTH facts (the applied runtime value and the
  unchanged stored one); the runtime-only fields carry no document read at all, so they never
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
  mounted while the rail is focused there. `install`/`update`/`confirm`/
  `diagnostics` always take the full width (no rail) so risk text is never
  squeezed. `Tab`
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

The normal Root Detail browse is the Settings owner of the cross-surface
body-action proximity rule in
[design-language.md](./design-language.md#74-body-actions-and-proximity).
Root-specific: ordinary fields wrap at 64 cells and prose at 72; a settlement
reason keeps the pane's full width as primary exception information, while long
identities/commands may use the whole grant; every published body action carries
the row it really painted (only the LAST frame's row is a pointer target), and
choice/dirty confirmation/service-install/risk seen-tracking keep their own
pinned/visibility contracts.

### Host numeric pages, Session log upload and the Host category

`/settings → Agent → Parallel tool calls` is the first real single-value DETAIL
TENANT: it is edited INSIDE the workspace's real Detail pane, so the parent
Categories/Rows stay painted and readable while it holds the active device.
`/settings → Tools → Shell execution` is the second real numeric DETAIL TENANT:
the same hosted presentation edited as ONE GROUP of two fields inside the same
real Detail pane. Both numeric rows share ONE page implementation and ONE
per-open controller inside the existing Settings lease; the Agent route commits
as `single` (one Confirm = stage + save) and the Shell route as `grouped`
(local field stages + ONE explicit Save). The Root keeps the physical Action
Bar and the ONE Esc affordance, and a painted control delegates to the SAME
page/controller path a key press uses. The Shell row keeps its internal
`shell-execution` id, category, order, scope, freshness,
`shell-execution-settings` tag and the Host-served effective caps summary (the
executor identity is painted in the page's source heading); it is entered only
through its explicit forward action (`Enter`/`Right` from Rows, or the Detail
preview's `Open…`), never by a row click or Tab.

- **Grouped browse presentation.** The grouped page paints the Host heading, the
  settlement/current facts and the field group first, then the existing
  `Edit…`/`Details…`/`Discard…`/`Refresh…` verbs as ONE compact body group
  (whole verbs only; separators and padding are inert), then the single clean
  staging note `Edit values, then Save to apply.` and the effect/help prose. The
  same real targets still select a field, open the raw Input, open Advanced or
  discard; Stage never writes and each verb keeps its own admission.
- **Shell numeric display.** The browse paints an exact SI display form
  (`60000 ms` → `60 s`, `64000 bytes` → `64 kB`) only for a positive safe
  integer divisible by 1000; every other value keeps its raw ms/bytes text.
  Inputs, Advanced facts, Reset/CAS, dirty equality and the official mutation
  always use the raw numbers. The Root `Shell execution` row uses the same
  display form (`60 s · 64 kB`), and the Host-served executor identity stays in
  the page's source heading.

- **Row identity and entry.** The `Agent` row keeps its internal `agent-loop`
  id, category, order, scope, freshness and `agent-loop-settings` specialist
  tag; its visible label is `Parallel tool calls`, its summary is the
  authoritative effective number (`Unavailable` / `Unreadable` when the section
  is not served) and its description states that the NEXT Agent step uses the
  value while already dispatched calls are unchanged. The row never reads a
  child draft and never writes. Selecting the row only selects it;
  `Enter`/`Right` are its `change` forward action and open the same Detail with
  the raw numeric Input, the Detail preview paints `Change [Enter]` and
  `Details…`, and a page-local `?` (or the painted `Details [?]` span) opens the
  same Advanced disclosure without an edit detour. An unreadable or last-known
  row advertises `details`, never a writable `change`. No global key binding is
  added for any of these.
- **ONE Confirm.** Valid text is staged and saved in the SAME call stack: one
  painted Confirm (pointer) or `Enter` (keyboard) dispatches exactly ONE
  revision-checked official mutation. Empty text is `Value is required.`,
  invalid text stays in the Input with the field's real error and zero write,
  and a value equal to the current effective one is a real no-op (`No changes`),
  never a fabricated `Saved`. The official unset stays a separate explicit
  intent: Advanced's `Reset to inherited…` (or `x` there) opens a confirmation
  whose necessary risk copy must have been painted before Confirm is admitted,
  and it sends the official `unset` even when the effective value already equals
  the inherited one — never `set(inherited)` and never a USER-field deletion
  claim. The confirming actions are admitted only through their own REALLY
  painted span: a confirmation, leave or refresh segment that a narrow row drops
  is inert for the keyboard and the pointer alike, and a grant that paints no
  body row admits nothing but the page's own Back. A grant that DOES paint a
  body keeps the page's documented page-local entry keys (a dropped bar hint is
  not a revoked key). The scrollable confirmation body obeys the same wheel the
  tenant body uses, so a pointer-only user can reach the risk fragments that
  gate Confirm.
- **Entry is explicit.** Row selection and Tab are never a mount: an ordinary
  Detail fact or blank cell click only transfers the Detail column's focus
  (the scoped exception to the ordinary L1→L2 click that this page owns), and
  the tenant plus its raw Input are entered only through the painted
  `Change [Enter]` / `?` affordances or Enter/Right on the row. One Confirm is
  one stage→save handoff: it retires that editor's admission before it stages,
  refuses any key delivered by its own synchronous callback, and re-proves the
  captured text and source identity before the single mutation is dispatched.
  The grouped Shell route below follows the same explicit-entry rule through its
  own `Open…`/`Edit` affordances.
- **Authority and status.** Effective/inherited/revision/generation, official
  availability and the write result stay owned by the ConfigPort and the
  existing per-open controller; the page paints the current value, the
  requested value and the Host-configuration save feedback above (`Saved` /
  `No changes` / `Could not save` / `Could not confirm save`) exactly as the
  Host settlement and same-generation readback prove. `Last-known · read-only`
  is never called Ready, a superseded capture refuses the edit until an
  explicit Refresh, and a Refresh discards a draft only after its own
  confirmation.
- **Parent navigation stays guarded, not hidden.** A pending write refuses
  every parent category/row/pane/Tab/Back path; the raw Input, the Advanced
  disclosure and an active page question own their local keys. A definite dirty
  draft and a settled ambiguous outcome open the page's OWN leave question
  (`Discard and leave [D]` / `Leave anyway [D]`, plus `Keep [Esc]`), and the
  unknown acknowledgement never undoes a possibly applied Host write. The
  captured continuation re-proves the SAME mounted page instance and the SAME
  source category/row before it applies the captured destination, and a
  destination that vanished in the meantime is refused instead of applied. For
  the Agent single value a clean page leaves on the same gesture (Tab retires it
  and returns the original Rows selection); the Shell group's Tab is a LOCAL
  field move and the Root never takes it. The lease/focus mechanics are owned by
  [overlay-focus.md](./overlay-focus.md).

- **Group browse.** Entering the group selects the FIRST field and never opens
  the raw Input. The group paints both fields' labels/units and candidate
  values, the served `Current` for every staged field, and the real
  `N unsaved change(s)` count projected from the controller's patch keys.
  `Up`/`Down` clamp on the two fields, `Tab`/`Shift+Tab` wrap between them, and
  a field row click only SELECTS. `Enter`/`Right` or the painted `Edit` opens
  the CURRENT field's Input; `Stage` (a complete painted span) validates and
  stages that field locally and returns to the browse. `Details`/`?` opens the
  selected field's Advanced disclosure.
- **ONE Save, ONE batch.** The grouped Save is admitted only while the patch is
  current, valid, non-pending and its dirty facts (the count, or one complete
  staged field block) and the Save span were really painted: the bar publishes
  NO Save span while those facts are scrolled out. Every labelled fact is
  composed as its REAL physical lines: the complete label wraps, a numeric
  value moves to its own line (indent only when the indent itself fits) and a
  value that cannot be shown WHOLE admits no Stage span or Enter at all. The
  raw Input's own window is part of that proof: when it clips the number, the
  canonical fact is required even for already-canonical text. A sufficient
  grant returns the action with the raw Input and prior patch intact. It dispatches the
  whole set/reset patch as ONE revision-checked official mutation on the
  captured executor row, keeps the group and its field selection, and paints
  the Host readback as `Saved`. Empty/whitespace/invalid Input keeps the raw
  text and the field's REAL issue with zero write; a normal Stage equal to the
  served value removes only that field's patch (`No changes` only when the whole
  patch is empty), and an empty text is never an implicit unset.
- **Selected-field Advanced and reset.** `Details` opens the CURRENT field's
  effective/inherited/comparison/revision/scope, the Host executor identity and
  the reset semantics. `Reset to inherited…` (or `x` there) stages the official
  `unset` of THAT field and returns to the browse: no second confirmation and
  no write, and the action (bar and body alike) is published only after the
  complete selected identity and the unset/stage-until-Save explanation were
  really painted in THIS disclosure instance. An unread or jumped-past
  disclosure publishes NO Reset action; a sequential scroll that really paints
  the facts publishes it for a genuine fresh activation. A reset is a real dirty intent even when the effective value equals
  the inherited one, and `Reset staged` is never painted as the inherited
  value. A later legal Stage of another field keeps it; staging the same value
  of the reset field removes only that field's intent. The Host readback decides
  the value after Save; neither USER-field deletion nor `overridden=false` is a
  success criterion.
- **Dirty navigation.** A dirty Back and a dirty parent row/category/pane click
  are the SAME one leave gate: the page opens
  `Save [S] · Discard and leave [D] · Keep [Esc]`, compacting the WHOLE segments
  first (`Save · Discard [D] · Keep [Esc]`) so a normal medium child bar keeps
  all three complete actions. If the third action still drops, the complete
  `Discard and leave…` is a REAL body action beside the necessary copy; a grant
  that cannot show that copy together with its answer admits only `Keep`.
  `Save` saves and STAYS (it never chases the captured parent destination),
  `Keep` retains the group/field/draft, and `Discard and leave` clears the local
  patch before re-proving the captured destination. A plain local `Discard` is
  a body action too (`Discard…`) and stays; `Refresh` asks before it discards
  the draft and re-reads. A pending write refuses every parent route outright;
  the raw Input, the Advanced disclosure and an active question own their local
  keys, while a settled unknown outcome keeps the guarded leave gate. Unknown
  outcomes offer only `Leave anyway` (never compacted to a `Discard` label) plus `Keep`
  and the requested intents with BOTH last-confirmed caps; leaving does not undo
  a possibly applied Host write. A stale/refused capture's leave copy states
  that Save is unavailable until an explicit Refresh instead of advertising it.
- **Bar-only and short grants.** A grant that paints no body row admits only the
  page's own Back/Keep/Cancel/Wait, and the Root never takes the grouped Tab for
  a parent focus move. A short body keeps the selected field's value/unit, its
  served `Current`, the real state/dirty count and complete actions before the
  secondary prose; an action whose complete span does not fit is dropped WHOLE
  and its shortcut key stays inert until a repaint admits it. The bar and the
  body use ONE admission contract: a displayed action always means what its
  handler does. A question publishes its accept only while its necessary copy
  is complete in that frame (optional requested detail stays scrollable);
  otherwise the action row is an inert blank, not an actionable-looking word.
  A browse Save disappears with its dirty facts; the local Discard keeps a real
  body affordance; the ambiguous outcome never compacts its acknowledgement to
  the definite `Discard` wording.
- **Authority and status.** Effective/inherited/revision/generation and the
  executor identity stay owned by the ConfigPort and the per-open controller;
  the page paints the same Host-configuration save feedback above (`Saved` /
  `No changes` / `Could not save` / `Could not confirm save`) and the
  `Last-known`/read-only states as the single route. A superseded, refused or
  replaced capture paints its heading as `Last-known · …` and a staged field's
  served value as
  `Last confirmed: …` (never `Current:`); the settlement state is the FIRST
  readable body row, so a short grant cannot hide it behind prose. The read-only
  state still offers its real local `Discard…` body action (a definite refusal
  is safe to abandon) while an ambiguous outcome offers none. A refresh re-reads
  the served row, clears the draft and requires a NEW explicit Edit/Stage/Save;
  it never replays the lost intent. An accepted write whose readback serves a
  DIFFERENT executor row is painted `Could not confirm save` (internally
  unverified) even when the caps look identical.

Numeric validation follows the owning field: the Agent field requires a safe
positive integer (`Number.isSafeInteger(n) && n>=1`), while the Shell fields
require a positive finite number as the Host runtime does (decimal and
scientific text are legal, and the browse paints the canonical number).

- `Shell execution` edits the two numeric caps (`timeoutMs`, `maxOutputBytes`) of
  the Host-served model-tool executor row in ONE mutation. The executor-row
  selection, currentness and single-batch write authority are owned by
  [host-client.md](./host-client.md#agent-loop-shell-execution-and-session-log-settings-authority);
  this page only paints and edits the two caps of that already-bound row. The
  caps affect the NEXT shell execution; a running subprocess keeps its current
  timeout. This is not the `!`/`!!` user-shell sandbox policy.
- `Parallel tool calls` edits only `agent-loop.maxParallelToolCalls`. The next
  Agent step samples the saved budget immediately before executing its next
  non-empty tool batch; tool calls already dispatched are never rewritten. The
  other `agent-loop` Config (notably `agents`) is never part of this page's
  write.
- The category's USER-visible title is `Host`; the internal category id stays
  `general` (routing, serialization and every row id are unchanged). `Host`
  paints `Backend`, `Web UI`, `ACP access` and `Session log upload` in that
  frozen order. `Web UI` and `ACP access` are NAVIGATION rows: they carry no
  inline candidate and open the `Web UI` and `ACP access` pages described
  below. The ACP listener runtime state and the persisted next-split-Host
  startup preference are raised by that ONE page, never by two rows. `Session log
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
  is painted `Could not save` with zero dispatch. A lost settlement paints
  `Could not confirm save` + `The change may have been saved. Refresh and
  check.`, and a fresh readback that disagrees with an accepted write paints
  `Could not confirm save` with the Host's real value; neither offers a blind
  replay: a manual `Retry save` appears only for a definite `Could not save`
  settlement and re-dispatches the previously confirmed candidate through the
  current row's revision/generation write check. It does not reopen the L2
  confirmation.
  A non-current or disconnected authority offers no candidate and never
  presents a stale On/Off as the current Host state. Retaining a historical row
  is a TUI presentation choice, not a requirement of the official namespace
  lifecycle.

### Web UI page (Host)

`/settings → Host → Web UI` — and the PiTui `/web` deep link — open ONE
EMBEDDED SPECIALIST PAGE inside this same Settings lease, and that page is a
REAL DETAIL TENANT: it mounts inside the workspace's real Detail pane, so the
parent Categories/Rows stay painted and readable while it holds the active
device. The child owns only its Detail body cells; the Root keeps the shared
chrome, the ONE physical last-row Action Bar and the ONE `Esc` pointer target.
There is no separate Web overlay, no second screen and no second Settings
workspace. The breadcrumb is `Settings · Host · Web UI`.

The tenant and its authority are entered only through the Rows level's
`Enter`/`Right` or the Detail preview's complete `Open…`; an ordinary row click
only selects the row and a Detail blank/fact click only transfers the Detail
column's focus. The mount requires a REAL Detail content row (`contentRows >=
1`): a `/web` first frame that cannot grant one is a real command error that
closes the lease — never a silent Rows fallback and never a Host read. A
terminal resize keeps the SAME mounted page instance and performs no extra Host
read; a mounted page that later receives a zero-body grant keeps only its own
painted bar (`Back [Esc]`) and no hidden body action.

Two authorities are painted as two separate reading groups and are NEVER merged:

- `Current Host` is the LIVE listener state of the running Split Host, read
  through the semantic `WebAccessPort` and bound to the Connection generation
  it was read under. Its `Serving` and `Access` facts keep the listener fact
  distinct from any write settlement. Every runtime action is qualified by a
  CURRENT observation; a generation change revokes the actions, the staged
  next-start intent, the link request and the pointer map, paints `Checking…`
  and re-reads before a new action is offered. On Direct the page states
  `Unavailable · Split Host only` and offers no runtime action; it never reads
  a fake Host.
- `Next Host Start` is the persisted PROFILE preference
  (`pi-tui-web-preferences.autoStart`, default Off) for the NEXT Split Host
  start, read through the ConfigPort and written ONLY by the existing
  revision-checked `web-autostart` settings writer. It never toggles the
  running Host, and a runtime toggle never changes it. `Off (default)` marks
  the schema default the USER layer does not declare; a non-ready
  configuration, a missing revision, an unreadable section or a last-known
  value without a CURRENT settings-authority generation is
  `Unavailable`/read-only and never a guessed default. The `Change…` gesture
  itself belongs to the observation that frame painted: a silent replacement of
  the settings authority (even with an identical revision and value) retires the
  painted affordance and requires a fresh frame and gesture. The choice
  captures that SAME observation's revision and generation; they travel through
  the ONE serialized Config queue to its head, where a moved revision or a
  replaced generation is `Could not save` with ZERO mutation and no CAS rebase.
  An accepted write paints `Saved` only from a CURRENT same-generation
  authoritative read that carries the requested value; an
  accepted-but-unattributable readback paints `Could not confirm save` (never
  `Could not save`), and a lost/unknown receipt paints `Could not confirm save`
  with `The change may have been saved. Refresh and check.`. No outcome is
  retried automatically and the page offers no `Retry save`: a new explicit
  `Change… → Confirm save` is the only way to act again.

The page keeps ONE transient phase: `loading`, `ready`, `confirm-disable`,
`choose-autostart`, `confirm-save`, `pending-runtime`, `pending-config` or
`settled`. Only the phase decides what the body and the Action Bar offer. The
business verbs (`Open in browser`, `Copy access link`, `Enable Web`,
`Disable Web…`, `Refresh`) and the configuration field (`Start automatically`)
are different controls: clicking a COMPLETE verb executes it (Disable only
enters its risk confirmation), the backing padding/blank cells only select the
row, and `Change…` on the field is the explicit entry into the candidate
choice. The whole-row blank/padding click is NEVER a business action. `Refresh` is a
real body action in EVERY `ready`/`settled` projection (not only the
changing/unavailable one): it performs one authoritative status read, and the
same painted admission gates the body verb, the bar span and `r`; a
same-generation external listener change is therefore refreshable without a
hidden key. The same `Start automatically` flow is: select the field, open the `Change…` choice,
choose `On`/`Off` (the current one carries `[current]`; staging writes nothing),
then the ONE explicit `Confirm save`.

Admission is ONE semantic fact shared by the body, the keyboard and the
delegated last-row spans: only an action whose complete verb/field/answer row
was really painted in the CURRENT frame may run. A clipped, scrolled-out,
dropped-wholesale or previous-frame control never writes. The two confirmations
are gated by the SAME rule and by the complete necessary copy in that frame:

| Phase | Body / actions | Confirm and `Esc` |
|---|---|---|
| enabled Host | `Open in browser`, `Copy access link` (`Contains a sign-in token`), `Disable Web…` (`Stops serving; does not revoke access`), `Refresh` | `Esc` performs the clean parent leave |
| disabled Host | `Enable Web`, `Refresh` | `Esc` performs the clean parent leave |
| changing / unavailable / unreadable | `Refresh` only, never a Host write | `Esc` performs the clean parent leave |
| `confirm-disable` | the exact sentence `Stop serving the Web UI? Existing browser credentials and sessions are not revoked.` FIRST, then `Disable Web` and `Cancel` | the accept row and the `Confirm [Enter]` bar segment exist ONLY while the whole risk sentence shares the painted viewport; a short grant paints no accept word and Enter is inert, while `Cancel`/`Esc` always performs zero writes. A selected `Cancel` never advertises an Enter confirm |
| `Next Host Start` choice | `Choose the value the next Host start applies:`, the complete `On`/`Off` candidates and the next-start-only lifetime sentence | choosing/`Select [Enter]` stages only; no write |
| `confirm-save` | the complete `Save the next Host start preference as On/Off?`, the next-start-only lifetime sentence, `Confirm save` and `Cancel` | only `Confirm save` calls the writer and only while the question and lifetime sentence are complete in the SAME frame; `Esc` steps back with zero writes |
| `pending-runtime` | `Waiting for the answer…`, no second action | the page's own `Back [Esc]` leaves while the dispatched write keeps settling in its OWN owner (never cancelled, replayed or repainted); parent clicks/Tab are refused |
| `pending-config` | `Saving…`, no second action | the page's own `Back [Esc]` leaves while the dispatched write keeps settling in its OWN owner (never cancelled, replayed or repainted); parent clicks/Tab are refused |

The first focus is the enabled Host's `Open in browser`, the disabled Host's
`Enable Web`, otherwise the editable `Start automatically` row when a
preference can really be written, else `Refresh`. Label/value cells that do not
fit are WRAPPED, never truncated into a different writable-looking value; a
short frame scrolls ONE Detail column and a scroll/resize back to a sufficient
grant restores the complete confirmation without any automatic confirmation.

Parent navigation is the tenant's ONE guarded leave: `ready`/`settled`/
`loading` allow it (the read that no longer owns the page is retired);
`choose-autostart`, `confirm-disable` and `confirm-save` refuse every parent
route until the user's own local `Cancel`; `pending-runtime`/`pending-config`
refuse parent clicks/Tab while the explicit page `Back [Esc]` stays the
documented exit, and the write owner still settles and diagnoses the dispatched
request. A forced teardown retires the page directly. A settled ambiguous
outcome keeps its truthful `Could not confirm save` and normal Back never claims
a rollback. The page's `done` is instance-fenced and always returns to the Host
Rows level (also for `/web`); re-entering builds a NEW page instance and starts
exactly ONE new authoritative read.

A write settlement is painted with the Host-configuration save feedback above.
The runtime write paints `Web enabled`/`Web disabled` only when the
authoritative re-read agrees, `Not changed` for a definite zero-write refusal
before dispatch, `Requested state not reached` when the request reported success
but the Host reads otherwise, and `Could not confirm change` + `Refresh and
check.` when the receipt was lost, the Host changed during the request or the
read-back could not be performed; it is never retried automatically and never
attributed from a fresh read. The preference write paints `Saved` / `Could not
save` / `Could not confirm save` on its own side, with the same-generation rule
above: a pre-dispatch fence refusal is `Could not save`, an accepted write with
a stale, replaced or disagreeing readback is `Could not confirm save`, and a
lost settlement is also `Could not confirm save` with `The change may have been
saved. Refresh and check.`. The authenticated launch URL is requested only
by an explicit `Open in browser` / `Copy access link`, handed straight to the
Client-local opener or clipboard, and never painted, stored, logged or attached
to a diagnostic. A credential-bearing failure — the URL request, the Client
opener OR the clipboard throwing — is converted at that boundary to the fixed
safe word/reason (`Open failed` / `Clipboard unavailable`,
`The access link could not be obtained or handed over.`): the original error,
its cause and the URL never reach the owned-task diagnostic, a notice, a
painted cell or a trace.

### ACP access page (Host)

`/settings → Host → ACP access` — and the PiTui `/acp` deep link — open ONE
EMBEDDED SPECIALIST PAGE inside this same Settings lease, and that page is a
REAL DETAIL TENANT: it mounts inside the workspace's real Detail pane, so the
parent Categories/Rows stay painted and readable while it holds the active
device. The child owns only its Detail body cells; the Root keeps the shared
chrome, the ONE physical last-row Action Bar and the ONE `Esc` pointer target.
There is no separate ACP overlay, no second screen and no second Settings
workspace. The breadcrumb is `Settings · Host · ACP access`. The TSP-native
`/acp` picker keeps its own native contract (see
[surface-behavior.md](./surface-behavior.md#acp-quick-control-acp)).

The tenant and its authority are entered only through the Rows level's
`Enter`/`Right` or the Detail preview's complete `Open…`; an ordinary row click
only selects the row and a Detail blank/fact click only transfers the Detail
column's focus. The mount requires a REAL Detail content row (`contentRows >=
1`): an `/acp` first frame that cannot grant one is a real command error that
closes the lease — never a silent Rows fallback and never a Host read. A
terminal resize keeps the SAME mounted page instance and performs no extra Host
read; a mounted page that later receives a zero-body grant keeps only its own
painted bar (`Back [Esc]`) and no hidden body action.

Three authorities are painted as three separate reading groups and are NEVER
merged:

- `Current Host` is the LIVE listener state of the running Split Host, read
  through the semantic `AcpAccessPort` and bound to the Connection generation it
  was read under. Every runtime action needs a CURRENT observation plus ONE live
  preflight read under the SAME generation; a generation change revokes the
  actions, the confirmation and the pointer map, paints `Checking…` and re-reads.
  A resolved `enabled`/`disabled` is the only state that admits Enable/Disable;
  `changing` and `unavailable` admit none. The runtime write dispatches at most
  ONE `setEnabled(target, generation)` and then ONE authoritative read-back; a
  preflight that already reached the target (or a changing/unavailable Host)
  dispatches ZERO writes and states `Not changed`. A dispatched request whose
  receipt/read-back is lost (transport failure, Host replacement, unreadable
  read-back) paints `Could not confirm change` + `Refresh and check.` and is
  never retried; a `changing` read-back is unconfirmed too. On Direct the page states
  `Unavailable · Split Host only` and `Access Unavailable`, offers no runtime
  action and reads no fake Host.
- `Next Host Start` is the persisted PROFILE preference
  (`pi-tui-acp-preferences.autoStart`, default Off) for the NEXT Split Host
  start, read through the ConfigPort and written ONLY by the existing
  revision-and-authority-checked `acp-autostart` settings writer. It never
  toggles the running Host, and a runtime toggle never changes it.
  `Off (default)` marks the schema default the USER layer does not declare; a
  non-ready configuration, a missing revision or a missing current
  settings-authority generation (the ConfigPort's `generation`) is
  `Unavailable`/read-only and never a guessed default. A last-known value may
  stay painted while the backend is stale, but its undefined generation never
  grants an edit.
  The revision AND the settings-authority generation captured when the choice
  opened are the decision fence. They travel with the request through the
  ConfigPort's serialized write queue to the actual official mutation boundary:
  the adapter re-checks both at the queue head immediately before dispatch, so a
  decision made against Host A can never become a write against Host B. A moved
  revision or a replaced generation refused before dispatch paints `Could not
  save`, with ZERO writes and without rebasing the CAS onto newer authority.
  When dispatch is known accepted, only a CURRENT same-generation authoritative
  read that carries the requested value paints `Saved`; an unreadable,
  disagreeing or different-generation readback paints `Could not confirm save`
  because the mutation may have committed — never `Could not save`. A
  dispatched request whose receipt is lost, or whose dispatch outcome otherwise
  cannot be attributed, is also `Could not confirm save` with `The change may
  have been saved. Refresh and check.` and is never retried. Every actual generation
  rollover retires a staged choice that has not dispatched, even when the
  replacement exposes the same revision and value; an old-frame `Change…` press
  cannot establish a new choice against the replacement without a fresh frame
  and gesture. An already dispatched `pending-config` request keeps its
  original owner until settlement, is never cancelled or replayed by the page
  or a rollover, and the page Back may leave while that owner still settles it.
  The writer's internal outcomes are projected through the save-feedback
  mapping above; the painted `Status` word is `Saved`, `Could not save` or
  `Could not confirm save`, never an internal settlement name.
- `Client Setup` is Client-local: it states the local IPC endpoint /
  same-OS-user / stdio bridge facts and the ONE copyable command
  `dsh --profile <proven-profile> acp stdio`, composed from the OFFICIAL Profile
  identity the composition proved (`runner.profileDaemonAdmin?.profile`) with
  platform-appropriate quoting (POSIX on Linux/macOS, PowerShell on Windows). `Copy client command` is an explicit clipboard action: it
  reads no socket, requests no Host URL/token, starts no stdio process and works
  whether or not the listener is enabled (the page states that the listener must
  be enabled before a client can connect). A `false`/throwing clipboard is
  `Clipboard unavailable`; only `true` paints `Client command copied`. When the
  composition cannot prove the Profile identity, the page paints
  `Client command unavailable · Profile identity not verified` and publishes no
  Copy row/target, and never guesses a profile name from argv/cwd/env.

The page keeps ONE transient phase: `loading`, `ready`, `confirm-disable`,
`choose-autostart`, `confirm-save`, `pending-runtime`, `pending-config`,
`pending-copy` or `settled`. Only the phase decides which body controls and bar
segments exist.

Admission is ONE semantic fact shared by the body, the keyboard and the
delegated last-row spans: only an action whose complete verb/field/answer row
was really painted in the CURRENT frame may run. A clipped, scrolled-out,
dropped-wholesale or previous-frame control never writes, and the keyboard
`Enter`, `r`/`R` and the painted bar span read exactly that set. The complete
business verbs (`Copy client command`, `Enable ACP`, `Disable ACP…`, `Refresh`)
are the action spans; the row label padding, a field's label/value cells, a pure
fact row and blank cells only select (or are inert) and never act. `Refresh` is
a real body action in EVERY `ready`/`settled` projection, not only the
changing/unavailable one: it performs one authoritative status read, so a
same-generation external listener change is refreshable without a hidden key.
The `Start automatically` flow is: select the field, open the complete `Change…`
affordance, choose `On`/`Off` (the current one carries `[current]`; staging
writes nothing), then the ONE explicit `Confirm save`.

The two confirmations are gated by the SAME rule and by the complete necessary
copy in that frame:

| Phase | Body / actions | Confirm and `Esc` |
|---|---|---|
| enabled Host | `Disable ACP…` (`Disconnects active ACP clients`), `Refresh` | `Esc` performs the clean parent leave |
| disabled Host | `Enable ACP`, `Refresh` | `Esc` performs the clean parent leave |
| changing / unavailable / unreadable | `Refresh` only, never a Host write | `Esc` performs the clean parent leave |
| `confirm-disable` | the exact sentence `Disable the local ACP listener? All connected ACP clients will be disconnected. Host sessions, Agents and this TUI will keep running.` FIRST, then `Disable ACP` and `Cancel` | the accept row and the `Confirm [Enter]` bar segment exist ONLY while the whole risk sentence shares the painted viewport; a short grant paints no accept word and Enter is inert, while `Cancel`/`Esc` always performs zero writes. A selected `Cancel` never advertises an Enter confirm |
| `Next Host Start` choice | the complete `On`/`Off` candidates; choosing/`Select [Enter]` stages only; no write | `Esc` steps back with zero writes |
| `confirm-save` | the complete `Save the next Host start preference as On/Off?`, the `Applies on the next Host start; the running Host is unchanged.` lifetime sentence, `Confirm save` and `Cancel` | only `Confirm save` calls the writer and only while the question and lifetime sentence are complete in the SAME frame; `Esc` steps back with zero writes |
| `pending-runtime` | `Waiting for the answer…`, no second action | the page's own `Back [Esc]` leaves while the dispatched write keeps settling in its OWN owner (never cancelled, replayed or repainted); parent clicks/Tab are refused |
| `pending-config` | `Saving…`, no second action | the page's own `Back [Esc]` leaves while the dispatched write keeps settling in its OWN owner (never cancelled, replayed or repainted); parent clicks/Tab are refused |
| `pending-copy` | `Copying the client command…`, no second action | the page's own `Back [Esc]` leaves while the copy keeps settling in its OWN owner; parent clicks/Tab are refused |

The Client-local `Copy client command` row is NOT part of the runtime action
group: it sits after the Client Setup facts/command and exists whenever the
Profile is proven. The first focus is the enabled Host's `Disable ACP…`, the
disabled Host's `Enable ACP`, otherwise the `Copy client command` row when the
Profile is proven, else the editable `Start automatically` row when its
preference can really be written, else `Refresh`. Keyboard order follows the
painted order. Label/value cells that do not fit are WRAPPED, never truncated into a
different writable-looking value, and a complete action verb is never painted
partially; a short frame scrolls ONE Detail column and a scroll/resize back to a
sufficient grant restores the complete confirmation without any automatic
confirmation.

The Action Bar paints `Refresh [R] · Back [Esc]`,
`Disable [Enter] · Refresh [R] · Back [Esc]` (or the selected row's own
`Enable`/`Copy`/`Change` verb), `Confirm [Enter] · Cancel [Esc]`,
`Select [Enter] · Cancel [Esc]` or `Confirm save [Enter] · Cancel [Esc]` as the
phase decides; only the ROOT owns the physical last row and every segment is
dropped WHOLE. Every pointer-capable target is the last-painted row/bar geometry
under the same admission as `Enter`, so a stale press/release, a resize, a
generation change or a phase change can never activate an old control. A short
frame scrolls ONE column and never drops the `Esc` affordance.

Parent navigation is the tenant's ONE guarded leave: `ready`/`settled`/`loading`
allow it (the read that no longer owns the page is retired);
`choose-autostart`, `confirm-disable` and `confirm-save` refuse every parent
route until the user's own local `Cancel`; `pending-runtime`, `pending-config`
and `pending-copy` refuse parent clicks/Tab while the explicit page `Back [Esc]`
stays the documented exit, and the write/copy owner still settles and diagnoses
the dispatched request. A forced teardown retires the page directly. The page's
`done` is instance-fenced and always returns to the Host Rows level (also for
`/acp`); re-entering builds a NEW page instance and starts exactly ONE new
authoritative read.

A write settlement is painted with the Host-configuration save feedback above.
The runtime write paints `ACP enabled`/`ACP disabled` only when the
authoritative re-read agrees, `Not changed` for a definite zero-write preflight
refusal, `Requested state not reached` when the request reported success but the
Host reads otherwise, and `Could not confirm change` + `Refresh and check.` when
the receipt was lost, the Host changed during the request or the read-back could
not be performed; it is never retried automatically and never attributed from a
fresh read. The preference write paints `Saved` / `Could not save` / `Could not
confirm save` on its own side. Closing an ACP View detaches it; Host Sessions,
Agents and the TUI remain.

Authority: `src/tui/panels/acp-access-settings-page.ts`,
`src/tui/commands/settings.ts` (`createAcpAccessPage`,
`commitSettingsWorkspaceField`'s `acp-autostart` field, `openAcpAccessWorkspace`),
the `AcpAccessPort`, `ConfigPort.acpStartupPreference` and
`runner.profileDaemonAdmin?.profile`.

Must-not: read or invent a socket path, start/stop a Host or stdio process from
Copy, write `autoStart` from the runtime toggle (or vice versa), retry a
dispatched write, attribute an unknown outcome from a fresh read, treat a stale
Config mirror as a current preference, offer a Confirm the writer must refuse,
guess the Profile name, or mount a second overlay/lease/Settings screen.

### Startup backend (Host)

`/settings → Host → Backend` is the FIRST of the four `Host` rows; the `Web
UI` page entry, the `ACP access` page entry and the `Session log upload` switch
follow it in that order. Its candidates are `Direct` and `Daemon`, persisted to the official
Profile Config `tui-startup.backend` (`direct`/`daemon`) through the same
revision-checked Settings mutation the other Host form rows use; an explicit
`Direct` or `Daemon` choice is the sole persisted authority and the current
process's backend is never read from this row.

The value is a NEXT cold-launch fact. The `Runtime` half always states
`Applies on next launch; current TUI/Host remains unchanged`: a verified write
never hot-switches the running process, never spawns or stops a Host, and never
changes the current backend. The L2 decision carries the section revision and
the opaque Host settings-authority generation from ONE observation; the shared
serialized Config queue re-proves both at its head, so a queued decision whose
authority was replaced behind a predecessor is painted `Could not save` with
ZERO dispatch and no CAS rebase (a same-revision/same-value replacement is still
a different authority). Only a CURRENT same-generation readback that carries the
requested value paints `Saved`; an accepted write without that proof paints
`Could not confirm save` + `The change may have been saved. Refresh and check.`
and neither records the exit-transition intent nor offers the install follow-up.
The summary marks `(default)` only while the USER
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
- **Normal browse action flow.** The ordinary home/provider/reference/records
  browse paints its real content first, then its existing action block, then
  pads to the ONE physical bar. Action rows and their targets come from the
  actually appended rows (never a `height − 1 − actions` guess), so a short page
  keeps its actions near its facts. The picker, QuestionFlow and short/no-body
  fallbacks keep their specialised placement. Clear/sign-out confirmation,
  active browser authorization, pending writes and the add/review flows keep
  their original pinned rows and full-width exact risk/identity copy; the
  64/72 reading widths apply only to the normal browse. Provider facts lead
  with route/profile and the independent `Auth kind`/`Credential` presence;
  protocol/endpoint/models and the masked secret editor stay fully readable.
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
- **Normal browse action flow.** The ordinary signed-in/signed-out page paints
  Status, the independent Profile and Balance first, then its existing action
  block and padding, with the normal Callback/source helper facts after the
  account facts. `Usage`/`Top up` keep the official links. The sign-out
  confirmation, running-task check, active attempt URL/SSH and pending states
  keep their original pinned actions and full-width exact risk/identity copy;
  the 64/72 reading widths apply only to the normal browse.
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

`/settings → Tools → MCP servers` is ONE embedded Adaptive Workbench inside the
shared Settings lease (no second alt-screen, modal or Settings workspace). It
lists the ONE Host manager's servers in the manager's own order; a row's Detail
shows `Server`, `Source`, `Transport` (always `Not exposed` — the official list
publishes no transport), `State`, the `Tool count` only when connected,
`Attempt/retry` when the Host reports one, a sanitized `Last error`, and the last
probe's stage/closure facts. Status words are the official ones; there is no
invented `connected-ish`/`installed` flag. `Source` is `Configured`,
`Plugin-owned`, `Retained/removed` or `Unknown`, and a non-current settings read
never becomes `Plugin-owned`.

The Detail follows the action boundary: `Server`, `State`, tool count/attempt,
the sanitized last error/cleanup, the current operation and the configuration
receipt come first; the legally admitted body actions (`Probe`, `Restart`,
`Edit`, `Enable/Disable`, `Delete`, `Reset`, `Refresh`) follow as ONE body group;
`Source`, the saved configuration/transport, the last probe and other
diagnostics come after. The physical bar keeps ONE primary business verb (`Edit`
if present, else `Probe`, else `Refresh`) and the page's `Back [Esc]`; secondary
verbs get no second clickable bar copy. Only a verb whose complete span really
painted publishes a target, and the controller predicates, confirmations and
official SettingsForms writes are unchanged.

The workbench shares the Web UI workbench's ONE Root seat, rail grant and
physical last row. The Root owns the Categories rail and the ONE Action Bar; the
page owns only its local List/Detail region, its full-width form and its
questions. `W ≥ 120` and `H ≥ 6` paint `Categories(C) │ MCP List(34) │ 2 │
Details(D)` with `D = W − C − 38` (the Detail keeps its `≥ 40` floor). At
`76 ≤ W < 120` the rail focus paints `Categories(22) │ MCP List(W − 24)` with no
Detail; the child focus paints `MCP List(34) │ 2 │ Details(W − 36)` and the rail
steps aside. Any `W < 76` or `H < 6` paints exactly ONE current region: the rail
when the rail owns the keyboard, otherwise the page's current List/Detail/form
region. At `H = 0` only the truthful bar row remains: a rail or browse frame
offers the real `Back [Esc]`, a form `Back`/`Keep` (or the saving notice), and a
confirmation only its real `Cancel`/`Keep`; no body target exists. A form or a
risk question takes the WHOLE body at every width, so no rail, List or Detail
cell stays clickable behind it.

The List paints `Name` and the complete Status at its real width; a long status
wraps on the item's own physical line(s), never abbreviated into another word.
The Source is in the readable Detail; a single-region List may add it only
when the grant is at least 56 cells wide and can still hold at least 12 name
cells, the complete Status column and the whole 17-cell label. Long names may tail-omit in the List, but the Detail, confirmation and
identity line always carry the complete name. The List scrolls in physical rows.

A row click or keyboard move only SELECTS; `Open [Enter]`/`Enter`/`Right` is the
ONE explicit entry into the selected server's Detail. `Tab`/`Shift+Tab` is a
pure focus transfer: List ↔ Detail while both are painted; the untouched List
may yield to the rail and return to the SAME List. `Tab` is inert in a
one-region projection. `Esc`/`Left` returns Detail → List and List → the REAL
initiating level (Rows or Detail); a form or question owns its own Back ladder.

The physical Action Bar carries ONE primary business verb and `Back [Esc]`:
`Edit [E]` when the configuration entry is editable, else `Probe [P]` when it is
operable, else `Refresh [R]`. Every other admitted business verb is a complete
label in the scrollable Detail body (`Probe`, `Restart`, `Edit`,
`Enable/Disable`, `Delete`, `Reset`, `Refresh`), uses the SAME action sink
exactly once, and only a really painted span is a pointer target. Shortcut keys
for these relocated verbs use that same LAST-frame body/bar admission and the
existing pointer frame-currentness fence (a stale, clipped or scrolled-out verb
is inert until the current Detail scroll reveals its complete label); the
controller's live eligibility checks still decide whether it runs. If the
physical bar already supplies Refresh as its primary, the body does not repeat
it. Whole segments are dropped, never cut, and long diagnostics
remain wrapped and reachable through the physical scroll.

Probe and Restart require a current manager observation, a live (not retained)
listed entry and no in-flight operation; they do NOT depend on the configuration
descriptor. Every configuration edit additionally requires the same-generation
current settings descriptor and that entry's config source; `loading`, `stale`
and `unavailable` states explain themselves and expose no executable action. A
write uses ONE official revision-checked settings mutation; its result is
`Saving configuration…`, `Saved · waiting for Host reconcile`, a revision
conflict, an unavailable Host, a proven refusal, or `Outcome unconfirmed …` after
a lost settlement. A saved configuration is NEVER reported as Connected; the
manager's watch remains the only status authority, and Probe/Restart results
never overwrite the saved configuration fact. A probe is positive only when the
official result is `ok` AND cleanup is confirmed; a connected-but-unclean probe
is its own `cleanup not confirmed` fact. A settled restart says
`Restart settled · awaiting connected status` and waits for the watch; a lost
settlement is never retried.

A search is the ONE modal whose filtered RESULT rows stay pointer-selectable: a
result-row click only selects (the query and search stay open and no Host intent
runs), a wheel moves that filtered selection only, and the search's
`Done [Enter]` / the list's `Search [/]` replay the SAME Enter and `/` sinks; the
single `Cancel [Esc]` is never a second span, it is the Root's physical escape.
When the filter has no visible result, the controller's retained selection is
not a Detail subject: it paints no server facts, action targets or CRUD
dispatch; only Add/Refresh/Back stay legal until a row is visible again.
An ACTIVE form input is such a modal too: the body cannot be clicked or wheeled
behind it, while its own `Apply [Enter]` / `Cancel [Esc]` stay reachable. Every
env/header value carries an EXPLICIT storage form the user chooses —
`Credential reference` (the default, written as the official
`${credential:REF}` token) or `Literal (stored in profile)` — shown on its own
row and never inferred from the typed text; the disclosure's HTTP target is the
host alone and fails closed to `Unknown target` when the URL cannot be parsed,
so no path, query or credential can be echoed. Per-key Remove is offered for
keys the BASE layer does not own only: the official per-key `unset` on a
base-owned key RESTORES the inherited value (it cannot delete it), so such rows
state `Inherited · cannot remove here` and a backspace on them is inert. The
currently focused removable row also paints a complete `Remove [Backspace]`
segment beside `s Save` (dropped by the layout only when the row cannot hold it
whole) whose click is the same Backspace intent; an active input, an open
question or an unsettled save never offers it. An empty Enter on a `Literal`
value commits the empty string (the only way to override an inherited value with
nothing, since a base-owned key cannot be removed); an empty Enter on a
`Credential reference` keeps the current value.

Keys: list `↑/↓` move, `Enter`/`Right` opens the Detail, `a` begins Add from the
LIST only, `/` filters by name, `r` re-observes, `Esc` cancels search / returns
to the real parent; Detail `p` probes, `x` asks the exact Restart question,
`e` edits, `t` asks Enable/Disable, `d` asks the exact-name Delete, `u` asks
Reset-to-inherited, `r` refreshes, `Esc` returns to the List. In a form, `↑/↓`
and `Tab`/`Shift+Tab` move the focused field; a field-row click only selects;
the complete explicit verb (`Edit [Enter]`, `Switch [Enter]`, `Toggle [Enter]`,
`Add [Enter]`, `Remove [Backspace]`) activates the existing intent. While an
input is active every key is text except its own Apply/Cancel. At `44×8` the
List keeps the selected row, its complete Status and `Back [Esc]`; the form keeps
the exact identity, current field, its complete status and Save/Back reachable
(the focused field's verb moves to the body when the bar cannot hold it whole).

For a server the SAME current Host settings descriptor proves config-owned, the
Detail also offers `Edit`, Enable/Disable, permanent `Delete` (User-added
entries only) and `Reset to inherited` (entries whose effective configuration
differs from the base only). `Add` is a List action (the `a` key). Add and Edit
open a whole-page scrollable form inside the same specialist; the form's FIXED
identity line is painted INSIDE the body grant and names the exact target:
`<name> · Add/Edit · <source>`, degrading source → mode at narrow widths while
keeping the full name and mode. A form row click only SELECTS the field; its
complete explicit verb (`Edit [Enter]`, `Switch [Enter]`, `Toggle [Enter]`,
`Add [Enter]`, `Remove [Backspace]`) activates the existing intent. Add returns
to the page's REAL origin, the List; Edit returns to the original server's
active Detail while that exact target is still listable, otherwise to the List
with the truthful unavailable/refusal status. A confirmed Delete likewise
returns to the List once the roster proves the deleted target gone; a nearest
fallback selection is never presented as the original target. A removal receipt
is retained only for a saved Delete, and the next explicit configuration action
clears it; an unconfirmed/refused Delete never becomes a success receipt. A
refused/unknown Delete, a deliberate selection departure, or an explicit open
of another target retires the old return intent so it cannot redirect the new
Detail; automatic roster fallback is not a departure. An
exact Edit/Delete target means the same roster entry instance, not merely the
same name: a removed and same-name re-added entry is a new instance.

An Edit keeps the name read-only; a rename is two explicit actions. A stored
plain value is shown only as `Set (hidden)` in a non-editing row, while a
`${credential:REF}` reference stays verbatim. The form's draft, validation,
focus, discard confirmation and one configuration status are Client-local and
die with the page. A dirty `Esc` asks `Discard changes?` with Keep as the
default; only an explicit discard drops the draft with zero writes. A Save whose
draft can reach outside the Host asks ONE explicit question before writing —
`Enabling this server can execute an external command.` for a stdio entry, and
`Enabling this server can send data to an external service. Target: <host>` for
an HTTP entry (the host only, never a credential) — and only an affirmative
answer dispatches the write. A zero-diff Save reports `No changes` and performs
no mutation, never `Saved`.

EVERY dangerous confirmation — Save, Enable/Disable, Delete, Reset and
Restart — paints the same exact target / action / consequence body in the view
that hosts it (the form for Save and discard, the Detail for the rest), wrapped
at the real body width with unbreakable tokens hard-split. The Action Bar carries
only the decision (`Confirm [Y] · Cancel [Esc]`, or `Discard [D] · Keep [Esc]`
for a dirty form). A confirmation is executable only while its entire fact set
fits the rows the current grant really gives it, and only for the specific
question INSTANCE the last painted frame admitted: each opening gets a fresh
instance identity (including a same-name/same-revision question after a Host
generation replacement, and a discard prompt reopened before repaint). The Host
generation is retired with its open question; a new question cannot inherit an
older frame's admission. A question that opened but has not painted yet is
refused exactly like a blocked one, so a key arriving inside a render window can
never commit an unreviewed write.

While a configuration write is unsettled, the page keeps only the truthful
`Saving configuration…` status and a real `Esc` notice; it offers no discard and
no false Back. A pending List bar (normal or H0) states Wait and publishes no
clickable parent exit; Detail→List remains legal, and the form's saving bar is
informational with no exit target. Settlement restores the real receipt/notice
without requiring another key. A dispatched write is never cancelled or replayed. A write that
loses its settlement paints `Outcome unconfirmed …` and keeps the prior receipt;
an unconfirmed configuration write closes the local configuration admission and
a lost restart settlement closes blind restart retry until an EXPLICIT `R`
re-observes the Host. The configuration gate re-opens only after that refresh has
produced a newer current roster AND a same-generation ready descriptor read; the
restart gate after the newer current roster. A background roster publication
alone never re-opens either. The prior unknown notice is retained (never
rewritten as Saved, Cancelled or Connected); a new Add/Edit/confirm/restart is
then a fresh explicit decision. A form Back while the write is unknown asks
`Leave form? The change may have been applied. Discarding local edits does not
undo it.` and only an explicit leave drops the local draft. With no form open,
Detail → List stays legal, but the List's parent leave first states that the
prior outcome may have been applied and offers the explicit leave or `Refresh`.
The transient `Waiting …` notice is derived from the current pending state and
disappears when that operation/config write settles, so the real receipt/notice
is never masked. Leaving the page still never retries, cancels or rewrites the
dispatched Host operation. The parent-leave warning is admission-bound like every other question:
if its complete consequence does not fit the CURRENT grant, only Keep (plus the
read-only Refresh recovery) is published; Leave is absent and its key/pointer is
inert until a fresh frame paints the whole warning. The form likewise publishes
Save, field verbs and Apply only when the exact current field AND its active
Input row are actually painted in the current grant; otherwise it offers
resize/Back/Cancel and preserves the draft and active input across resize, never
staging hidden text.

Pointer ownership is the last painted frame's. A List click, including the
passive rail preview, only selects and hands the keyboard to the List; a Detail
body click outside a painted action is inert; a form-row click only selects its
field. The form's
body verb, the bar's complete spans and the Detail body fallback all use the ONE
existing action sink. The wheel reaches only the region under the pointer inside
the REAL child body box (translated with the child's own width/height): the List
moves its selection, the Detail scrolls its own physical offset, the form moves
only its field focus, and a confirmation/input/saving state is inert. A
gutter/header/blank does nothing. ANY effective wheel — a boundary/no-op one or
one a modal ignores — retires the pending press. A press whose frame repaints,
whose Host generation/roster/configuration-read epoch changed, or whose
full-width transition has not painted never completes. This is UI anti-replay
only: the Host manager generation, the official settings revision CAS and the
write terminal settlement remain the sole write authority.

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
control. A row click only selects: Enter/Right, the painted Rows forward hint,
the Detail's `Manage Computer Use…`, the Plugin card and the `/settings` entry
are the explicit mount gestures.

The mounted instance has exactly TWO projections:

- `Overview` is a Standard grouped Detail TENANT: ONE continuous semantic line
  model (Availability → Permissions → Authorization → Application
  access → Help/Recovery) paints inside the real Detail pane, the parent
  Categories/Rows stay live, and the page's own semantic line becomes the ONE
  physical last-row Action Bar. The normal and the short grant come from that
  same model; a short grant drops the optional weak section headings and moves
  the optional explanatory prose after the facts/actions inside the same
  scrollport instead of keeping a second copy of any fact or action. Each heading
  is attached to a populated group (no empty Permissions/Authorization heading),
  and a normal permission fact is followed by its Request/Open actions before
  its optional explanation. At the real `44×8` grant (4 body rows + the bar) the
  bundle truth, the Host truth, the first missing permission and its request
  action are all visible. Both permission groups are ordered missing-first
  (Accessibility before Screen Recording when both are missing); an already
  allowed group still keeps its explicit request-again/open actions.
- `Applications` is the existing Adaptive Workbench projection: the SAME
  Categories rail, the page's local List/Detail grant and ONE physical bar. The
  persisted decisions are grouped `Always allowed` / `Refused`; a row click or
  list movement only selects, Enter/Right or the painted `Enter open` enters
  the exact Detail, and the page's dangerous confirmation is its ONE full-width
  sub-view. Entering Applications performs no Host read. A clean list may yield
  to the rail, and the rail Back is a LOCAL return to the SAME mounted Overview
  instance (no dispose, remount or extra read). Every projection change
  (Overview↔Applications, the full-width confirmation) must repaint before a
  new key or pointer may act on it. The ONE final painted projection is the
  admission: a single-region grant publishes only the region it really painted
  (hidden rows/verbs are never a route, and a notice-overwritten row loses its
  business target), the dual projection publishes both visible regions, and a
  scrolled-out or overwritten selection advertises no Open. The wheel consumes
  the actual signed line delta of the event for the painted region under the
  pointer; the two-cell gutter owns no scroll. The Detail is a full
  keyboard/wheel scrollport. The settled receipt and official readback stay in
  the ACTIVE Applications projection (List and Detail), are revealed once at
  their first line, retain the original target's safe public identity (never the
  opaque id, never a fallback row), and the same Help content is real there
  instead of an invisible Esc step. The target is captured ONCE from the exact
  painted decision kind (application group + public name/path, permission, or
  preset/PTC fact) and is painted on every terminal outcome, so the same opaque
  id in the other decision group can never supply it and a later roster change
  cannot re-resolve it; a `nothing was sent` pre-dispatch refusal is the
  existing definite-refusal category and never enters the unconfirmed recovery
  state. A newer observation retires an armed risk in the page's observation
  subscription BEFORE the Root composes the next frame; render never changes the
  projection.

Authority is never the page: the bundle selection/availability comes from the
existing Plugin Manager roster, the saved default preset from the existing
`ConfigPort.presetDefault`, and system permissions, the official helper /
launch-application identity, PTC execution and persisted application decisions
come from the official provider through the ONE semantic `cuaAccess` port
(Direct: the live Host service resolved per call; Split: the official generated
`@deepseek-ai/dsh-cua/remote` namespace with connection-generation fencing).
The page owns only the per-open observation identity, one serialized action and
its cursor/scroll/confirmation/help state.

`Set PTC default` is the ONE guarded preset-default write: it captures the live
settings-authority generation and the exact `agent-preset-registry` revision the
painted frame read, refuses BEFORE dispatch when either moved (the old decision
is never rebased onto a replacement Host), and paints a confirmed result only
from a fresh same-authority observation whose effective default is `ptc`. The
caller's Computer Use observation is an independent authority at that boundary:
Direct re-proves it immediately before the official mutation and the Remote
mirror re-proves it inside the serialized queue head, so a write queued behind
an unrelated settings mutation dispatches nothing once the page observation was
superseded. An unproven effective default paints Unknown and offers no write. The
ordinary one-argument preset write and its `/preset default` caller are
unchanged, and this page never starts or switches a Session. Persistent PTC is
a separate explicit confirmed write with a possible runtime reload.

A disabled or missing bundle paints `Disabled`/`Unavailable` and performs no
CUA query; it is never a fabricated denial or `Ready`. A supported Host paints
Accessibility and Screen Recording as two independent observations
(`Allowed`/`Not allowed`/`Unknown`), the Host platform and the official
helper/responsible-application identity actually reported by the provider (the
responsible application stays reachable in the same scrollport; it is never
fabricated and never pushes the first missing permission off the short first
screen). `Request permission`/`Request again` and `Open settings` are action
receipts only: a successful call does not paint Allowed; a fresh read must
observe it. An unknown/unavailable read never keeps an older `Allowed`
actionable. A new action receipt or notice is revealed inside the current grant
rather than scrolling away.

The persisted application decisions are listed from the official
`applications()` result only; Session-only grants are not listed. `Revoke
access…` and `Allow asking again…` use the exact opaque `CuaApplicationId` that
was painted, require a reviewable confirmation (affected work may stop / no
access is granted), never target an application by name re-resolution, and
re-read the official list afterwards. Two decisions in the same group whose
public identity (sanitized name + path) cannot be told apart offer NO dangerous
confirmation: the page never guesses an opaque target. A confirmation is its own
projection: the confirm verb is paintable only while the complete risk text and
the exact target fit the SAME granted body; a resize re-evaluates from scratch
and never keeps a hidden confirm. Closing the page or a Host/connection
generation change discards late results and retires an armed confirmation; a
dispatched Host effect is not claimed undone.

The published observation identity moves on every superseding read, refresh and
invalidation; each action carries the exact painted capture (observation
identity plus target fact) and is re-proved at admission and again at the
dispatch boundary. A read-only `reading` state never blocks Back. An accepted
action owns the page until its own settlement: Waiting is published ONCE
synchronously at acceptance (after the exact decision, epoch and provider basis
were captured), the bar is a truthful `Waiting…` with no cancel, and a second
action, parent leave, the page's own Back or a local mode switch is refused.
The captured full eligibility (provider, platform, target and preset facts) is
re-proven after that synchronous publication and again at the actual sink. An
unconfirmed DISPATCHED effect is a terminal `unknown` receipt that owns the
recovery admission: every write stays retired (a gesture is not a retry and
never overwrites the receipt) until ONE explicit user Refresh settles an
authority adequate for the same next decision; background/post-effect readbacks
update facts but never clear it, and a failed relevant read cannot authorize it.
A dispatched error with no proof of no-effect is `unknown` with the actual
current-provider reason; only a proven pre-dispatch refusal is `not sent`/failed
with its exact reason. An explicit unsupported Host (for example Windows) denies
EVERY CUA write; a failed system observation leaves the independently current
application decisions usable. Closing the page never claims a Host rollback. A
grant with no body row paints only its truthful safe bar (`Back`, or
`Waiting…`/`Cancel` when an action/risk owns the page) and runs no read or
hidden action.

The page's `Open Settings → Plugins` action retires the specialist and switches
the SAME lease to the Plugin Manager. After the first explicit bundle enable the
Plugin Manager shows a one-shot recoverable next-step notice that points at this
page; the Tools row and the card's `Manage Computer Use…` remain available
later. The official application-consent Question keeps the existing Question
seat and answer writer, and paints the official `Risks` card for the
`cua-app-access` approval (no second Question owner or answer queue).

Must-not: read or write the macOS TCC database, call `osascript`/`tccutil`, run
`open` on the Client to fake the Host's System Settings, infer the responsible
app from the terminal, keep a second permission/application store, poll in the
background, auto-enable the bundle or persistent PTC, or paint a Client-local
platform verdict for a Split Host.
