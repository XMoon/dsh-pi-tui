# Surface behavior: workspace and interaction contracts

This document owns the durable, non-transcript workspace and interaction
behavior of the TUI. Each section names the current contract, its source
authority and sink, and the shortcuts that must not be introduced. Host business
authority stays in [host-client.md](./host-client.md); transcript cards/folding in
[transcript.md](./transcript.md); seat/modal/lease mechanics in
[overlay-focus.md](./overlay-focus.md); untrusted-text projection and copy rules
in [terminal-output.md](./terminal-output.md); geometry/tokens in
[design-language.md](./design-language.md).

## Quit (`exit`)

Only the exact trimmed, lowercase word `exit`, submitted from an empty editor,
quits before session creation. `/exit` remains an explicit command. `exit!`,
`Exit`, `exit now` and any other wording are ordinary model prompts.

The decision runs at the top of submission dispatch
(`isPlainExitPrompt` in `src/domain/command/policy.ts`), before any session
creation, history write, viewer gate or busy-Enter steer gate. The exit
controller then latches, disposes the Client surface, prepares the owned-session
retirement and requests `appExit` (see
[concurrency.md](./concurrency.md)).

## Pending input and the queue plane

- `queued`, `steering` and non-user `context` placements are projected from the
  one semantic pending-input reader. The queue pane shows only authoritative
  `queued` rows in projection order; a client-local `sending…` echo stays until
  the matching authoritative occurrence arrives.
- Steering and non-user Context render in ONE ordered ephemeral tail. They are
  never folded into the durable TranscriptFolder, never durable, and never part
  of transcript search.
- A non-user Context body is bounded to two visible rows; it is not exposed as a
  producer source.
- One atomic `setPendingInputPresentation` update owns the pane. Delivery mode
  is captured at the gesture boundary, not re-read during asynchronous
  preparation.
- Local transcript-lane input forces the virtual window to the latest row;
  background steering/context never steals the viewport.
- Local-only rows carry no bulk hint; the hint is scoped to accepted rows.
- `Alt+Up` is recall-all and `Ctrl+S` is a FIFO steer-all. They are bulk
  affordances, not per-occurrence actions. Per-occurrence row
  edit/remove/steer remains a known product gap (GitHub issue), not a promise.

Authority: `src/app/surface/pending-presentation.ts`
(`buildPendingPresentation`, `foldQueueRows`) over the Direct/Remote
`PendingSubmissions` seam; sink: `TuiApp.setPendingInputPresentation`.

Must-not: add a source-specific classifier/filter, correlate echoes by text,
make a local echo addressable through `updateQueue`, render `context` as a user
row, or claim exact-occurrence actions from the bulk gestures.

## Composer submission policy

The Web `ComposerSubmissionPolicy` applies unchanged:

- not running → the draft is queued;
- while running, Enter follows the configured `busyEnter` preference;
- the accelerated chord always performs the OPPOSITE of `busyEnter`.

Public queue-draft/submit-draft extension actions and a replacement editor's
`queue-submit` are explicit commands, never gestures. Resolve the mode once per
submission (`src/domain/command/policy.ts` + the submission controller).

## Subagent viewer

Interactivity is keyed only to the catalog mode (`continuable` = interactive,
`one-shot` = read-only) plus access depth: a depth-1 continuable child is
interactive; a nested child is read-only and never relabeled.

- A continuable viewer's editor is plain text. A non-empty prompt takes exactly
  one path through `SubagentPort` / the official `ctx.subagents.prompt` with a
  caller-minted `requestId`.
- An empty accelerated submit is the child steer-all; it never calls the child
  prompt API.
- Child queue reads/writes use the viewer's semantic writer subject.
- A failure restores the child's own draft slot; a stale viewer restores to the
  old child, never the parent.
- No fake child user row is injected; images are out of scope.
- The footer switches to the viewed child (display subject) while main-only
  chrome hides.

Authority: `src/app/surface/viewer-runtime.ts` (`ViewerRuntime`,
`ViewerAccess`), `viewer-submission.ts`, `src/runtime/subagent-port.ts`; sink:
viewer/footer/status.

Must-not: use `sendMessage`/a direct child followup, submit through the parent,
guess the mode from running/inactive state, or share editor history between
viewers.

## Task Center and Task Browser

One durable descendant catalog plus its runtime projection feeds both Quick and
Full:

- The stable DSH pre-order is never re-sorted; runtime activity is a
  commit-time fact; finished one-shot children stay reachable.
- Jobs form a separate flat group. The footer badge counts running descendants
  at every depth.
- Catalog refreshes are coalesced single-flight; the first frame seeds from the
  cache. A session switch clears browser/badge synchronously.
- Question attention is a separate non-work dataset with its own `?N` footer
  fact. Quick shows hidden actionable attention plus active work; Full shows all
  attention plus tracked work.
- Stop is confirmed and capability-gated. Reading Job output belongs to the Job
  workspace, not the Task Browser.

Authority: `src/app/surface/task-browser-runtime.ts`, `task-runtime.ts`
(`openTasksBrowser`, `quickTaskProjection`), `task-presentation.ts`,
`task-attention.ts`; sink: `TaskPanel`, footer, Quick.

Must-not: add job tombstones/history caches, infer provenance from kind/args/
transcript/timing, count Question rows as work, or read job output through the
Task Browser.

## Job Workspace

A selected Job opens one dedicated fullscreen screen lease and returns to the
SAME paused Task Browser (lease ownership: [overlay-focus.md](./overlay-focus.md)).

- Capture one `JobInspectorState` plus the retained tail only. Do not promise
  full history.
- `End` is the ONLY follow re-arm; every manual browse pauses.
- Find is Job-local over the current retained output, never transcript search.
  Edit and result-navigation states are distinct, with `i/N` status.
- Empty/refused bodies are honest. `[GAP]`, `[ERROR]` and `[SETTLED]` facts stay
  independent.
- The Action Bar / `planChrome` budgets rows in fixed priority; every Host
  string crosses the display boundary before theme styling.
- A shell Job with an observed non-empty label gains a Command page in the same
  workspace/screen/observer. `Tab` toggles Output ↔ Command in both directions,
  `Esc` returns to Output, `v` is inert. Both bodies are mounted once and made
  mutually invisible, so each keeps its own follow/viewport/anchor/query and its
  own Find. `C`/`c` copy only when Find does not own the keys.
- Command copy uses the original label bytes verbatim; Output copy uses the
  captured snapshot text. Selection copy is `label.slice(start, end)`. Copy
  only proves emission, never an OS-clipboard receipt; the raw-text policy is
  owned by [terminal-output.md](./terminal-output.md).

Authority: `TuiApp.openJobInspector` + `JobInspectorPanel` (`planChrome`,
`deriveJobInspectorView`), `JobOutputScrollView`, `JobOutputSearch`,
`src/app/surface/task-runtime.ts`; sink: screen/body/Action Bar.

Must-not: add a second observer/screen owner, concatenate status/label/output,
claim full history, move the background transcript, or give a Label Job a
Command page.

## Settings Workspace

`/settings` and its real alias `/status` open ONE fullscreen lease with ONE
navigation focus state. The category rail is the selection owner; the right
column is the content. Width only projects panes (≥108 three, 76–107 two, <76
one). The category order is `About, Models, Account, Appearance, Display, Tools,
Plugins, Other settings`; both names run the same handler and land on `About`
with identical initial focus and entry-refresh behavior. `/statusline` remains
the `/footer` alias and never enters this workspace.

- Every category shares ONE root row plan: header, optional metadata, at most
  one top rule, optional app notice, optional pane header, body, and the single
  physical last-row Action Bar. The app notice is the ONE root-level notice;
  a page's own business notices stay inside that page's body. At ≥76 columns a
  direct About/Models/Account/Plugins page keeps the category rail and shares
  ONE display-only pane header whose focused `[Label]` names the live keyboard
  owner; the page's own semantic hint line is moved unchanged to the frame's
  last row instead of being regenerated at a wider width. The legacy medium
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
  query). A FOCUS TRANSFER that changes the direct page's projection is the same
  boundary: on a narrow terminal one region is painted at a time, so moving the
  keyboard between the Categories rail and the plugin content (in EITHER
  direction) leaves the previous frame on screen; until the destination frame
  paints, the root refuses every key except the real Esc — including the
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
- About reads are non-creating and re-prove the captured SessionScope (owner +
  generation) after every await; a session switch revokes the old view
  immediately, and one semantic entry admits at most one refresh. While
  sessionless, no read starts and the Session-only Refresh is not painted.
- Mouse `Copy`/`Copy All`/`Refresh` targets exist only for the WHOLE painted
  affordance at its last-painted geometry; a clipped or hidden button has no
  target. The whale is decoration: the report carries facts, never artwork.
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
- The four configuration categories (`Appearance`, `Display`, `Tools`, `Other
  settings`) keep their three-level browse (L0 categories, L1 rows, L2 detail)
  and their existing writers.
- Three configuration rows are writable: the configured theme, the transcript
  display setting, and the profile-wide `Visual tools` switch. Browse/copy never
  write.
- `Tools` holds exactly one built-in row, `Visual tools`, backed by the Host
  profile's `pi-tui-visual-tools.enabled` volatile Config (schema default On).
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
- An L2 choice is transient; only an explicit Confirm commits one field through
  its own authority path (the serialized TUI settings document, or the Host
  `pi-tui-visual-tools` form section) and re-reads the authority.
- `Verified` requires a ready read-back with a matching value. Rejected/unknown
  outcomes are attributed from a fresh read, never guessed. A refused write is
  reported as `Not saved`/unknown, never as success.
- Theme auto is fenced on the runtime selection intent.
- `Plugins` is a DIRECT page inside the same lease (see Plugin Manager): the
  embedded `PluginManagerWorkspacePanel` paints only its own business body,
  while the root keeps the single Header/Metadata/rule/pane-header/last-row
  bar. At ≥120 columns the frame is `Categories | List | Details`; at 76–119
  the rail focus paints `Categories | List` and the plugin content focus paints
  `List | Details`; below 76 columns it is one column, and the page is not
  mounted while the rail is focused there. `install`/`confirm`/`diagnostics`
  always take the full width (no rail) so risk text is never squeezed. `Tab`
  and `Enter`/`Right` only hand the keyboard to the plugin List (no action);
  `Tab` inside the List keeps its filter cycle, `Shift+Tab` from the untouched
  List root returns to the rail, and `Esc` from the List root returns to the
  rail with the page instance, its view/query/selection/scroll and the
  controller's install request id intact. Only a real category change or the
  Settings teardown disposes the page and releases its Host claim. The legacy
  complete editor stays reachable through `Other settings`.
- The screen lease/currentness mechanics are owned by
  [overlay-focus.md](./overlay-focus.md).

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
  the store; it never claims success without the authoritative absence.
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
- Stored credential records exclude the DeepSeek Account grant.
- The `/login` and `/logout` resolver stays fail-soft when a read fails: the
  always-present builtin target (whose reference is a constant) remains
  addressable, and an explicitly typed reference still resolves. A route whose
  credential reference is UNKNOWN (a failed settings read, a failed or stale
  Remote directory read) is not offered as a route→reference authority — a
  derived reference would be a guess that can point at another provider's
  key, and the last-known routes may belong to another Host.

### Account page

- Host `AccountView` phases drive the display (`succeeded` is presented as
  Authorized). `credential-stored` is a storage fact, not a server-validated
  identity; profile and balance are independent queries with independent
  pending/failed/ready states, and an unavailable balance is never shown as 0.
- Wallet decimal strings are forwarded verbatim. `Usage` and `Top up` use the
  client-local HTTP(S) opener with the official `AccountView.links`; the page
  never receives a token or grant payload.
- Sign in starts the official browser attempt with the Host's own loopback
  callback origin and login source `web`, and paints the authorization URL plus
  the SSH tunnel template for the current callback port. Cancel addresses the
  exact attempt id; a stale id cancels nothing.
- Sign out is an explicit confirmation with the account identity and the
  running-account-task risk. It calls the official `signOut`; the local grant is
  removed and the remote revocation remains background. A failed revocation
  never restores a local grant, and independent API keys stay stored. While the
  sign-out is pending, user navigation and page exit are refused.
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

## Task Quick

Current behavior:

- Hidden by default and paints zero rows. `focused` is the ONE visibility
  authority.
- The only automatic crossing is an effective `app.tasks.open` Down from the
  physically focused Host editor at its last visual line while
  `quickDownEligible` holds (live surface, active tasks, at least one row, no
  blocker/tenant/overlay/workspace).
- Navigation is `task[0..N-1]` plus an optional `Open Task Center…` row; no
  wrap; Up at the first row exits; Esc exits. Enter routes through the shared
  `resolveTaskSelection` with value/session re-proof.
- The hidden-entry Footer hint and the Down route share one predicate.
- The band sits under the whole Footer with ONE top separator and at most five
  rows (separator + identity + navigation).
- Every blocking owner terminates it.

Authority: `src/tui/panels/task-quick-accessory.ts` (`TaskQuickAccessory`,
`planTaskQuickLayout`, `TASK_QUICK_MAX_ROWS = 5`),
`quickTaskProjection`, `TuiApp.quickDownEligible`.

Must-not: add a second catalog/ack ledger/focus owner; a transient row failure
keeps the retained snapshot; passive paint/refresh/wheel never acknowledge.

## Plugin Manager and Plugin Detail

### One controller, one workspace lease

`/plugins` and `Settings → Plugins` are the SAME composition: ONE
`PluginManagerController` per surface and ONE embedded
`PluginManagerWorkspacePanel` inside the existing Settings workspace Alt-Screen
lease. `/plugins` is only a deep link: it takes that lease with the Plugins
category selected and the keyboard on the Plugin List (sessionless, no Session
create/switch, no second screen). The controller outlives the page; a second
page while one still owns the controller returns nothing instead of nesting an
owner; a refused Settings lease leaves no phantom claim.

The page never paints root chrome: it receives a local
`{ width, rows, allowDual }` viewport from the root every frame and paints only
its Search/Filters row (list/details, when admitted), its OWN Host
notice/read-error/exemption row, its business body and ONE semantic bar as its
local last row; the root installs that line as the physical last row only while
the plugin content owns the keyboard. The adjacent `List | Details` pair needs
`allowDual`, a local width ≥76 and six real body rows; the split is
`min(42, max(30, floor((width−2)×0.42))` for the list and the remainder for
Details. A narrower or risk-starved frame degrades to ONE business column and
never to a permanent Categories rail. A wheel is routed by the column the local
pointer is really over: the List column scrolls the List and the Details column
scrolls the Details, in the List view and the Details view alike; the 2-cell
pair gutter belongs to neither pane and is inert.

Esc is a two-level gradient: the untouched List root yields to the Categories
rail (keeping the page and its state), a second Esc closes the Settings lease;
Details returns to the List, confirmation returns to Details, Diagnostics
returns to the List, and a running install's Esc hides the view without
cancelling the Host operation. The rail's `Tab`/`Enter`/`Right` only transfer
the keyboard into the List. `Esc` in the install gradient and the details
sub-state never cross levels. A page factory failure releases the claim and
disposes anything half-built instead of faking success; a page that starts
after an earlier attempt ALWAYS starts on the List, and `i` reopens the same
in-flight/failed/unknown request id without dispatching a second install.

### Host authority is owned elsewhere

The Host package/profile authority, semantic port, Direct/Remote mapping and
Connection generation fencing are owned by [host-client.md](./host-client.md).
This surface owns the controller/read-epoch/state-machine/workspace behavior; it
never invents catalog facts, and a `@deepseek-ai/` scope or `experimental`
substring is not identity proof.

### Inventory read epoch

`readEpoch` makes the latest-started read win. A failed refresh keeps the last
good snapshot and marks `state='error'`; no mutation is admitted while
loading/error/busy, and the controller keeps one mutation in flight. Every
mutation is followed by an authoritative reread while `busyValue` stays set; a
failed reread blocks further writes until a successful refresh. A stopped
surface refuses pre-dispatch writes and does not restore into a destroyed
editor; a dispatched write keeps its accepted receipt and is never
reinterpreted.

### Install state machine

Phases:

```text
editing → inspecting → confirm → starting → installing → applying
                                      │            │
                                      └────────────┴──→ cancelling
                                                         ├─ cancelled       → done
                                                         ├─ too-late        → applying
                                                         ├─ already settled → unknown
                                                         └─ cancel failed   → installing

starting | installing | applying → done | failed | unknown
```

`cancelling` is reachable ONLY from `starting`/`installing`; it is never a
normal successor of `applying`.

- Exactly one `requestId` per attempt; inspect before any install; explicit
  confirmation. The same id is used by `waitForInstall`/`cancelInstall`; a new
  explicit approval gets a NEW id. An unknown result is reconciled through the
  official wait/reread, never claimed as success and never retried
  automatically.
- Explicit cancel is available only while starting/installing. `too-late` means
  the profile is applying and is never reported as cancelled.
- Unknown/failed reconciles through `waitForInstall` plus an inventory reread
  and is NEVER automatically resubmitted.
- A failed install may be retried only by explicit approval of the exact
  Host-reported `pendingBuilds` under a NEW request id.
- `installEpoch` fences stale inspect results; `mutationToken` enforces one
  mutation in flight.
- Leaving/hiding the page never cancels a Host operation. Every new page starts
  on the Plugin List; `i` reopens the SAME controller state (in-flight request,
  failed/unknown requestId, or a recent result) under the SAME request id and
  never dispatches a second install. `hasResumableInstall` is the reopen
  predicate for the list's hint only, never the initial view.
- A Remote reply superseded by a Connection generation change is an
  indeterminate `PluginManagerStaleResultError`, never a new-Host success or
  refusal.

### Detail copy policy

The support sentence pair is module-private
`EXPERIMENTAL_BUNDLE_SUPPORT` in `src/app/plugin-manager/model.ts`. It applies
only to a bundle card with `official === true`, `section === 'experimental'` and
an exact key in the implementation's explicitly enumerated, Host-source-verified
official-bundle set. The exact names and copy are owned by the model and its
tests, not by this document: do not copy the table here. It is bounded app
presentation for explicitly enumerated official-bundle identities, not a
public capability API,
not a Host PASS, and is never derived from enabled/fiber/availability. The
model/tests also own the single Owner-frozen danger confirmation, which is the
only hazard statement.

### Diagnostics page

The Plugin Manager list opens a read-only Diagnostics page with `d`; it is a
FULL-WIDTH business view of the SAME embedded page/controller/Settings lease
(never a Settings category, a second controller or a second screen owner). The
root keeps its single Header/Metadata/rule/pane-header row; the shared app
notice is painted by the root, and the page's own Host inventory notice is not
painted on this view. One immutable read produces its
facts: the extension ledger's contribution health records, each live registry's
contribution count, and `api().capabilities`. Contributions with a PROVEN
`ownerEntryIds` association are grouped by owner; all others stay visible under
`Unassociated extension contributions`. Each record shows the exact
`extensionPoint:id`, its state and the whole `lastError` (wrapped, scrollable,
never silently truncated), and `c` copies its exact block while `C` copies the
whole stable report. Both payloads pass the SAME shared terminal-control guard
as About: ESC/CSI/OSC/DCS/C1 sequences and non-whitespace controls are removed,
TAB/LF/CR become visible escapes, and only the report's generated line breaks
remain structural. `r` rereads this projection only; it never refreshes the
official package inventory, and a ledger failure/recovery is reflected on the
next painted read. With no extension service attached the page says
`Unavailable`. Host package state, install logs and the Host inventory's
`Stale`/error notice are NOT extension diagnostics and never label this page.
Mouse `Copy [C]`, `Copy All [C]` and `Back` targets exist only for the whole
affordance at its last-painted geometry; copy uses the snapshot that was
painted.

Authority: `src/app/plugin-manager/extension-inventory.ts`
(`describeTuiExtensionDiagnostics`), `src/app/surface/plugin-manager-runtime.ts`
(the `diagnostics()` read on the ONE controller), `src/tui/plugin-manager/workspace.ts`
(the page/renderer and last-painted targets); sink: the Plugin Manager body,
action row and App clipboard.

Must-not: add a second controller/store/scanner, poll the ledger, fold package
inventory or install logs into extension health, infer an owner association from
a name/prefix, or let a Host `Stale`/error notice label the extension projection.

### Detail upgrade guidance

Derive only from `availability`, `canRemove`, `isSelf`, `version` and
`installTarget`:

- self → managed outside this screen;
- installation → upgrade DSH; no in-place update or Remove;
- profile-owned → Remove first, then an explicit later install; state when
  removal is not permitted;
- missing with an official target → the Host-offered target (masked spec +
  version); Install remains the only path;
- missing without a target → install unavailable;
- show `Version difference` only when both versions are known and differ; never
  claim "latest"; an unreadable current version is `unavailable`.

The guidance never dispatches a mutation and never echoes full userinfo/tokens.

## Attachments and input completion

Attachment completion and intake are Client-local:

- `/attach` and `/image` carry path-argument completion backed by
  `suggestPathArgument(argument, clientCwd)`. An unscoped term uses
  finder-first discovery with a bounded recursive fallback; a scoped empty term
  lists that directory's children; a scoped non-empty term constrains the
  search; Windows drive/UNC tokens keep their own dialect.
- Tab on an empty argument is a file-completion site only for commands that
  declare path-argument completion; accepting a directory reopens its children.
  The Client cwd is read at call time and stays independent of the Session/Host
  cwd. `@` whole-tree search remains Host-scoped. Multi-word/quoted arguments do
  not complete.
- `/attach <path>` is the canonical Client intake. Images go through the image
  pipeline; other regular files stage as metadata-only drafts and are streamed
  through `ctx.attachments.saveFileStream()` only when an agent-bound submission
  is admitted. `/image` stays image-only compatibility. Neither reads the file
  eagerly or routes through the Host filesystem.
- The attachment intake and the Ctrl+V paste intent share ONE active composer
  and the existing draft stores; there is no second draft copy. `/attach` and
  `/image` read the current draft and insert the canonical placeholder through
  the mounted composer of the active renderer, and announce success only AFTER
  that intake succeeded and the placeholder inserted — for an image that means
  its bytes were read, for a generic regular file that means the metadata draft
  exists (only a bounded signature prefix was inspected; the content streams at
  submit time, see above); with no mounted composer — or with the renderer's own
  builtin admission refusing the command — they fail instead of staging. A
  pending intake never writes a replaced composer seat or a newer ownership
  generation/session; its late outcomes are published only
  while both its own seat and its session are still current, and the explicit
  session-changed/transition refusal is published only while its own seat is
  still current (it exists precisely because the session moved). On a renderer
  without a command card the synchronous `CommandResult.error` of these commands
  keeps its one result-notice owner; that scope never publishes a success, so
  the async intake's single message stays with the composer. Clipboard intents
  are queued as ONE per-surface FIFO of accepted triggers: each accepted trigger
  probes the OS clipboard at most once, a later trigger's probe starts only
  after the previous one settled (read + commit or failure), and a failed intent
  never blocks the following one. Paste text inserts at the live caret and never
  submits; an empty or unsupported clipboard is not an error, and an
  unreferenced-draft prune runs against the live draft before a new image is
  staged. The platform probe, deployment image policy, Host attachment
  admission and Direct/Remote submission paths stay their own authorities.
- The attachment marker is always `🖼️ ` (U+1F5BC + U+FE0F + space), so its
  visible width is three cells; a font without an emoji face may show a gap
  (accepted).
- Mixed user messages keep an inline `🖼️ name` / `📄 name` placeholder in the
  flat text and bubble, with thumbnails in block order. The placeholder text is
  a DISPLAY projection only; source content blocks are untouched
  ([terminal-output.md](./terminal-output.md)).
- Fullscreen-only attachment collapse: the info bar
  `🖼️ name · W×H · bytes` is constant in every state; only image rows come and
  go. Hit-testing covers only collapsible user/assistant thumbnails, re-measures
  the row map before resolving, and attachment rows win over the message-card
  toggle. A session switch clears the collapse set. Re-expanding re-uploads the
  base64 (accepted cost).
- Composer draft images have a live, bounded preview band between the plugin
  widget zone and the editor seat on both roots. It is a READ-ONLY projection
  of the **expanded composer draft** (`getDraft()`/`getExpandedText()`, the
  same text submission uses) and the live `DraftImageStore`, so its occurrence
  count and identities agree with the images that would be sent. The source
  capability exposes only `values()`; the preview never stages a second
  attachment, removes by id or reorders the draft. The store owns every staged
  byte and every budget; the existing unreferenced-draft cleanup is a separate
  runtime-owned path.
- The band shows exactly ONE card for the **LAST referenced occurrence** in
  the draft, so a newly pasted image is immediately visible. The identity row
  is painted first: `🖼️ #<draftId>/<totalOccurrences> · W×H · bytes`, then the
  remaining-occurrence count and, fullscreen only, an ASCII `x` removal
  control at the far right. The image is fit to at most **44×3** at >=70
  columns and **22×3** at 50–69; the identity row plus image rows never exceed
  four rows. Under 50 columns or with a 1–3 row grant the band degrades to a
  one-line count/latest-identity summary with no pixel card and no removal
  control; with no safe space it paints zero rows. The line/total identity
  uses the canonical `🖼️ ` marker (VS16). Pixel rendering is limited to PNG on
  Kitty and the original format on iTerm2 at or under 4 MiB; unsupported/
  oversized/recalled drafts paint the real MIME, name, dimensions and
  `Preview unavailable` in the **card identity row**. The one-line summary
  fallback paints only the occurrence count plus the latest `#id W×H`, never
  a pixel claim. The band reads no new file
  and registers no decoder. Its row grant participates in the unified
  fullscreen pinned-chrome/footer/widget budget; the widget/footer reservation
  is bounded to avoid a feedback cycle and may under-grant, never overflow.
- The fullscreen `x` control edits exactly ONE canonical placeholder occurrence
  in the **visible editor text** (removing at most one adjacent separator
  space), preserves the cursor's relative position, paste markers and mode.
  It deliberately does NOT prune the removed draft: the editor undo history
  can restore the canonical placeholder from an older snapshot. The removal is
  itself a REAL undoable editor edit (the pre-removal document is recorded), so
  Undo restores exactly the removed occurrence; it is never a silent
  programmatic text replacement. Staged bytes
  are protected by the `DraftImageStore`'s idempotent `(editor owner, image id)`
  undo leases: the host fork Editor exposes the canonical placeholders its real
  Undo snapshots still reference, and the surface reconciles the leases after
  every host-editor mutation (typing, paste, Undo, programmatic restore) and
  after a preview removal. Repeated `x → Undo → x` therefore cannot multiply a
  lease. When the editor's undo history is really retired (a submitted-draft
  clear), the store releases that owner's leases immediately — backend
  acceptance, working state and turn identity are not part of the undo
  lifetime. A session switch does not retire the host undo history, so
  undo-referenced bytes survive it, and the retained PiTui editor draft keeps
  every image it still references; dispose drops every lease.
- The undo-retention budget (8 images / 32 MiB, separate from the active
  16 / 64 MiB draft caps) applies only to images that are undo-leased and no
  longer referenced by the live **expanded** draft; an image Undo restored into
  the draft is an ACTIVE attachment again. Active admission never evicts
  retention-only bytes to make room. When the budget is exceeded, the oldest
  evictable retention-only image is retired: the REGISTERED OWNER's editor
  trims the placeholder from the undo snapshots that could restore it (the
  rest of those snapshots, including newer still-retained images, stays
  undoable) and only then do its bytes leave the store. Live occurrences and
  in-flight submission pins are never evicted; when every candidate is
  protected the budget may temporarily exceed its cap and re-converges later.
- A Composer submit takes a SCOPED bridge reservation of the submitted images
  BEFORE the clear (the fork's `onBeforeSubmitClear`, which returns a one-shot
  release) and releases it in a `finally` after the synchronous submit
  dispatch — for Enter, Ctrl+Enter, plugin submits and Ctrl+S steer alike. The
  existing business owner (`pinDraftAttachments`/`runReservedSubmit`, the
  HostCommand fallback) takes its own attachment reservation synchronously
  inside that dispatch, so the clear can never strand images that are part of
  the outgoing message and no bridge outlives the call stack. These clears
  retire the editor's undo history, so a delivered message — and the image
  bytes its successful write consumed — cannot be resurrected by Undo; a
  failed submission restores the draft before its reservation releases. Local
  commands, early refusals and empty submits acquire no long-lived reservation.
- The `x` control is offered only when the current seat editor exposes the
  narrow Undo-retirement seam; a Replacement Editor without it still renders
  the preview but has no safe removal control. A Replacement Editor without a
  real undo-retiring clear falls back to a plain text clear (which pushes
  undo), so the host editor's leases stay and a handoff back to the host seat
  can still undo the placeholder with real bytes. A rejected submission
  restores the draft before its business reservation releases, so a restored
  placeholder never becomes dead text. A successful removal also resets the
  fork's multi-click selection history, so an immediate second x after undo is
  a fresh click rather than a swallowed double-click. Undo (the editor's
  `tui.editor.undo`) therefore restores a live image, never a token that
  renders as text. An occurrence
  that exists only inside a large-paste marker is shown by the expanded
  projection but has NO removal control: the editor text cannot address it
  safely, and its draft (and any in-flight pin) must survive. When the
  previewed last occurrence shares an image id with an earlier hidden
  occurrence, it still gets a control only when the raw text after the raw
  last occurrence is a marker-free literal identical to the expanded suffix
  after the previewed occurrence; that proves no hidden content follows it and
  it maps to the raw last occurrence. Otherwise the control is suppressed.
  Regular mode has no fake mouse control: the user deletes the canonical
  placeholder text. The preview is display-only and never changes submission
  semantics. Its Image/base64 caches are short-lived: pruned to the
  currently displayed card on render and released on session switch/dispose.

Authority: `src/commands.ts` (`PATH_ARGUMENT_COMMANDS`),
`src/tui/file-completion/path-argument.ts`,
`src/tui/interaction/autocomplete/provider.ts`,
`src/domain/transcript/content-blocks.ts`,
`src/tui/components/media/image-thumbnail.ts`,
`src/tui/components/media/draft-image-preview.ts`,
`src/client/media/image/placeholder.ts`,
`src/client/media/image/draft-store.ts`,
`src/client/media/image/types.ts`,
`src/app/submission/composer-port.ts`,
`src/app/surface/application-events.ts`,
`src/tui/commands/artifacts.ts`,
`src/app/command/tsp-capability.ts`,
`src/app/submission/submit-flow.ts`.

## Session `@` completion routing

The Session `@` scope has ONE frozen Host-side router, used by BOTH backends:

```text
bare workspace fuzzy search   -> official ctx.fileReferences
  @foo @readme @src @.env         (workspace index, cache, exclusions, scoring,
                                   maxResults stay authoritative)

explicit path navigation      -> dsh-pi-tui Host scoped discovery
  @src/ @./ @../x @/abs @~/x      (the exact scope the user typed)
  Windows drive/UNC paths
```

The route is decided by the TOKEN's own shape (any separator, a root form, or a
Windows drive/UNC path), never by resolved workspace containment, official
result count or filesystem existence. The official provider is called ONLY on
the bare route; an authoritative official empty result stays empty and never
falls back to the scanner. The scoped route never calls the official provider,
so explicitly named excluded directories, symlink scopes, parent and absolute
paths all work; the accepted candidate is materialized as an absolute Host path,
and ranking scores the SCOPE-RELATIVE candidate (the home prefix never
fabricates matches).

- POSIX boundary: on a POSIX Host a backslash is an ordinary filename character,
  but the reused path resolver selects its Windows dialect from the token alone
  and normalizes separators. An ambiguous POSIX token containing a backslash
  (`foo\bar`, `dir\name/foo`) therefore stays with the official provider
  instead of being searched in a normalized (different) directory. This is a
  deliberate fail-closed narrowing until the shared resolver distinguishes host
  dialect, token dialect and literal backslashes.
- Parent-traversal spelling: on a POSIX Host the filesystem backend anchors a
  path containing a `..` segment with its PHYSICAL spelling (raw
  `<anchor>/<path>` concatenation, so an intermediate symlink is resolved by
  the kernel before the parent step) and resolves other paths lexically. The
  scoped search tests the whole anchored spelling and keeps the raw
  concatenation when required; the Direct discovery driver joins its base
  without re-normalizing, so completion and the model's read cannot land in two
  different physical directories. A home shorthand emits an absolute normalized
  value; the bare `~`/`~/` root form uses the raw `homedir()` spelling.
- Direct and Remote share this authority: the Direct adapter reaches it
  in-process; the Remote Client reaches the SAME router through the private
  `piTuiFileReferences` endpoint (the official `fileReferences` namespace stays
  mounted and authoritative for bare queries). The custom endpoint AUGMENTS the
  official provider; it does not replace it. Bare-query ranking, result bound,
  exclusion policy, implicit hidden matching and cache/invalidation remain
  official behavior.

Authority: `src/runtime/direct/file-completion/host-discovery.ts`,
`src/app/remote/pi-tui-file-reference-host.ts` and the private
`piTuiFileReferences` contract. Proof: `test/client/host-file-port.test.ts`,
`test/runtime/remote/remote-host-file-port.test.ts`.

## `!` / `!!` shell input

`!` and `!!` are EDITOR STATE, not document text. Three modes (`prompt`,
`shell-context`, `shell-local`) hold a bare command body and serialize back to
`!`/`!!` only at Host boundaries.

- Empty-body transitions: `!` → shell-context; `!` again → shell-local;
  Backspace steps back; Esc cancels (autocomplete Esc first).
- A `!` after body text is literal; in shell-local an empty-body `!` is literal
  body text (there is no fourth mode).
- Bracketed paste normalizes only into an EMPTY prompt.
- Submission (Enter, the accelerated chord, Ctrl+S, a plugin sink, the subagent
  path) serializes and resets to prompt BEFORE dispatch. History stays
  serialized and decodes on recall. Handoffs carry the wire form.
- The prompt glyph is `❯ `, `! ` or `!!` in prompt/shell-mode inks.
- `!` is context-bearing (result enters the Session/model); `!!` is
  session-excluded (no session write, no model visibility). Both execute in the
  Host environment.
- `bypass`/`sandbox` are Host execution policies, not machine locality.
  `localShellSandbox` persists in the TUI settings document, default `bypass`.
  `sandbox` uses the DSH shell executor; `bypass` uses the plain spawn path. A
  policy the composition cannot serve fails closed with a visible error and
  never downgrades.
- Completion inside a shell line: the first word uses `compgen -A command`;
  a `$` prefix uses `compgen -A variable`; later words use path completion plus
  a small subcommand table. One `bash -lc` spawn per request (never `-ic`),
  abortable, hard-capped, latest-only commit. Failure/timeout degrades to no
  suggestions. Command-name results cache per cwd+PATH for 30 s (success only);
  subcommand/variable results are never cached. Items are name-only; applying a
  command item replaces the first word after the prefix, which is never
  touched.
- The user-shell card: a running card collapses to the newest five source
  lines; a settled card to at most twenty visual rows with an honest hidden
  marker. Ctrl+O expands to the retained buffer except fullscreen Focus.
  Alt+K dismisses settled cards only; it never cancels the process (Esc owns
  that) and never deletes session events.

Authority: `src/tui/interaction/editor-input-mode.ts`
(`shellPrefixForMode`, `serializeEditorInput`, `editorModeFromHistoryEntry`),
`src/tui/interaction/tui-editor.ts`, `src/client/shell/compgen.ts`,
`src/app/submission/user-shell.ts`, `src/app/config/schema.ts`,
`src/runtime/direct/host-user-shell-direct.ts`.

Must-not: put the prefix in the buffer/cursor math, route a shell line through
slash commands, downgrade sandbox to bypass, cache a failed compgen run, or let
a mode-less plugin seat inject `prompt` into a Host `!` submit.

## Question, Goal, cards and the todo dock

Question lifetime and seat ownership live in
[overlay-focus.md](./overlay-focus.md). Goal/ask tool cards and JSON-result
folded previews live in [transcript.md](./transcript.md). The one small surface
contract left here is the fullscreen todo-dock click loop:

- Summary click opens the compact panel; panel click goes compact → full; a
  full-list click closes to summary.
- Compute `dockHeight`/`dockTop` and check the dock region before the todo-panel
  branch. When the panel hides the summary, `dockHeight` is 0 and the dock
  branch is inert.
- The regular surface has no mouse; do not toggle a random message card when the
  dock row is clicked.

Authority: `TuiApp` todo-dock geometry/hit-testing
(`dock.render(width).length`, `handleTodoPanelClick`).
