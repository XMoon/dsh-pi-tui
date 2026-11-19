# Session Workspace behavior

Session browsing, currentness, navigation, switching and resume are owned here; Host/session ownership and leased-screen focus remain with their respective contracts.

This is the sole owning document for the following surface-specific behavior. See
[host-client.md](./host-client.md) for Host authority and
[overlay-focus.md](./overlay-focus.md) for focus/lease lifecycle.

## Session Workspace

`/sessions`, `/search <query>` and bare `/resume` open ONE fullscreen Session
Workspace over the existing `SessionBrowserReadOwner`; the retired PiTUI Picker
is not a fallback. TSP keeps its own native Presenter over the same owner (see
[tsp/session-browser.md](../tsp/session-browser.md)).

- **A CLI Session launch is Browser-first except for a canonical full id.**
  Bare or explicitly blank `--session` opens Browse All. A canonical full
  Session id is the ONLY value that resumes before the surface mounts through
  the ONE `SessionLifecycle.open`; it needs no roster read. Every other
  non-blank value opens the SAME Browser immediately with the value as its one
  live global query, and the existing `SessionBrowserReadOwner` then applies
  the strict CLI policy — exact official id first, then a legal unique hex
  prefix through the same guarded Resume flow — as soon as the roster lands.
  A keyword or an ambiguous prefix never auto-resumes; a query edit made while
  the roster is loading cancels the pending direct match. This startup entry
  skips the sessionless mount Workspace-preflight wait, and it is never
  blocked by a slow or never-settling Host roster read: the Browser owns the
  first input frame and `Esc` reaches the sessionless Welcome with no Session,
  draft or writer. A genuine canonical open failure keeps its original Host
  error and opens the same Browser once as a MANUAL recovery entry, never a
  second automatic resume.
- **The Host Editor `←←` entry is contextual, never a global binding.** Two
  independent, unmodified `Left` presses within 600 ms from the empty PiTUI Host
  main Editor open the SAME fullscreen Workspace with the All browse intent,
  while bare `/sessions`, bare `/resume` and the Welcome entry carry the Current
  intent (only that intent still decides the one-time missing-Current notice;
  every entry browses the complete official Workspace tree). The gesture requires the Host editor to be the
  real physical keyboard owner on the main surface, prompt mode and a strictly
  empty draft: any text (whitespace included), a staged attachment, an
  in-flight bracketed paste, an open autocomplete and every higher-priority
  seat/modal/overlay leave it inert. The FIRST press is an ordinary editor
  Left; the second consumes that one key. Only a real press counts — Kitty
  repeat/release are protocol artifacts of the same physical press, a paste or
  an Unstable raw rewrite never synthesizes the gesture, and a terminal that
  carries no key-event types cannot strictly distinguish OS auto-repeat from a
  human second press (that limitation is a protocol fact, not a policy). `Esc`
  restores the same Session, draft, editor focus and screen; the gesture never
  switches, stops or writes by itself. TSP has no PiTUI TuiApp, installs no such
  entry and keeps its native Browser.
- **Workspace-first list, one row per Session.** The browse list paints official
  Workspace folders in Host follow order. Each folder contains one row per listed
  Session; within it, active priorities are Needs, Working, then ordinary
  history, each ordered by official `updatedAt` with the previous order as the
  tie-break. Only ordinary history is watermarked, and the watermark is
  RENDERER-LOCAL to one Browser open. The shared default watermark is eight
  ordinary rows for the current Workspace (and a Host-confirmed next-create
  destination) and zero for every other Workspace; a non-current Workspace with
  confirmed Needs/Working starts expanded with those active rows and zero
  ordinary history; every other Workspace starts as its Folder row only.
  Explicit manual collapse hides EVERY
  child row, active and current ones included, and leaves the Folder row with
  its trustworthy counts; `Enter`/`Right` restores the automatic view, `Left`
  collapses again. An expanded non-current Workspace starts at five ordinary
  rows (the current or a Host-confirmed next-create destination at eight), and
  `Show more` adds five more; the operation disappears when history is
  exhausted. Folder, Session and Show more are separate typed targets, not
  PickerGroup headers.
- **PiTUI spends spare list rows on ordinary history, up to a per-group cap.**
  In the ORDINARY Browse list the panel raises the watermark of ALREADY EXPANDED
  groups by ONE ordinary row per step while this frame's actual list budget (the
  pane height the layout gave the list, less the status rows the list itself
  paints) still has spare rows, up to twenty ordinary rows per group. The
  Sessionless `Choose workspace` chooser never grows: it selects an existing
  Workspace, so its spare height stays free instead of filling with unrelated
  Session rows.
  Current/Next groups fill first, then the other expanded groups rotate in
  official order, so one large Workspace cannot starve its siblings. A collapsed
  Folder is never expanded to use the space, and a frame whose base tree already
  overflows its budget never grows. Needs/Working rows, the current Session and
  the selected Session stay visible outside that ordinary cap, and a Session the
  shared projection already forces visible costs no extra row. The watermark
  never decreases inside one open: shrinking the terminal only changes the
  viewport/scroll, and re-rendering the same size and facts does not grow it
  again. `Show more` adds five rows from the CURRENT value and may cross twenty;
  the next open recomputes from the shared defaults. The growth is PiTUI-only and
  per open: the shared projection, TSP Native and every persisted source keep the
  eight/zero defaults.
- **The PiTUI tree has explicit inline action rows.** A real Host registration
  capability paints ONE root `Add directory` row above the official folders; an
  expanded REAL official Workspace paints `+ New session` as its first child
  row. Synthetic groups (`Unassigned`, `Membership ambiguous`) never paint New,
  and a Workspace baseline that is not proven never fabricates a Folder. The
  actions are ordinary rows reachable with `Up`/`Down`, not footer links and
  not a separate focus mode: there is no hidden Actions ring. `Add directory`
  opens the existing bare Host-path editor INLINE under the root row; `New
  session` calls the existing command-owned create handoff with the official
  `workspaceId` and never creates, closes or reports success by itself. ONE
  per-operation pending object locks repeated New activation until that SAME
  operation's own settlement arrives from the command owner: `committed` (the
  command owner alone retires the Browser), or `failed` / `not-committed` /
  `cancelled` (which unlock a deliberate retry). A transient notice, its expiry,
  a timer or a roster diff is never a Folder-New settlement. The Welcome chooser
  paints no `New session` and no `Use directory` child row.
- **The cursor is ONE typed row identity.** `> ` marks the selection; `●` marks
  the current opened Session, and `· Current` marks the one official Workspace
  that uniquely contains it. Selection never changes Current, the Host working
  directory or Workspace order. `Right` expands a collapsed Folder and then
  enters its first visible child, `Left` moves from a child to its parent Folder
  and collapses an expanded Folder, and `Enter` runs the selected row's own verb
  (Expand/Collapse, New, Add, More, Open, or the chooser's Choose workspace).
  Every activation is admitted only against the rows the LAST frame really
  painted: a row scrolled or budgeted out of the frame cannot be opened by a
  blind key. The cursor is preserved by row id across official reorders and
  expansion changes; a hidden Session re-anchors on its parent Folder and a
  removed Folder on its nearest surviving neighbor.
- **A Session row is a tree CHILD of its Folder.** The `> ` selection gutter
  keeps the tree's leftmost two cells, while a Session's `●` current bullet,
  its identity and its metadata start two cells further right; the bullet
  therefore follows the same indent instead of staying in the root column. The
  Folder row, its disclosure, `+ New session`, `Add directory` and `Show more`
  keep their own relative indent, and the flat search-result list keeps its old,
  unindented geometry.
- **A sessionless destination is not a Current Session.** A Host-verified
  next-create Workspace is ordered first and painted `Next` with the same
  eight-row base history watermark; it never renders as `Current`, because Current
  means the opened Session's unique official membership.
- **Choose/add a directory returns through the same Browser lifecycle.** The
  sessionless Welcome's Choose directory opens the same `/sessions` Browser at
  its full Workspace folder tree, titled `Choose workspace`; there a Folder's
  `Enter` or label click commits that existing official Workspace as the
  next-create intent and returns, while `Right`/`Left` and the disclosure only
  browse. That chooser paints no `Use directory` row and no `New session` child.
  A first submit refused by the Host Workspace preflight opens the same Browser
  only AFTER the submission owner has restored the draft, directly in the inline
  Host absolute-path editor with the refused path prefilled for correction. The
  ONE physical Action Bar paints its local Host-registration verbs
  `Verify [Enter]` and `Cancel [Esc]` — while a painted suggestion block is up
  the same slot names `Hide suggestions [Esc]` — never a Workspace selection;
  the editor body paints no second verb row. It rejects an empty value and a
  shape that is definitely non-absolute for the known Host dialect while the
  Host resolve remains the final judge, and dispatches at most one Host
  resolution until it settles; a rejection keeps the text and the previously confirmed intent, while
  a success commits the next-create intent. That chooser returns to the Welcome
  only after success; ordinary Browser Add returns to Browse, never creates a
  Session, and its official Verify commits that existing Workspace as the
  next-create intent — so a sessionless Add IS the standing-Workspace switch
  (there is no separate Use directory gesture in the ordinary tree).
  `New session` on a Folder reuses the existing `/new` transaction with
  that `workspaceId`, keeps the old Session until the commit, reports a refusal,
  and retires the Browser only after a committed switch.
- **Only a proven PRE-CREATE Workspace refusal opens recovery navigation.** A
  `/new` whose Host `resolveWorkspace` refuses (the semantic port's typed
  `refused`) opens the same Browser's full Workspace tree after the failed
  transaction settles and its single-flight releases; the old Session, its
  Turn, draft and next-create intent are untouched while the user browses, and
  a Session is created only by the user's explicit `New session` on the chosen
  Folder (the existing Folder-New transaction owns that create). The sessionless
  first ordinary submit follows the same admission only after the submission
  owner restored the exact draft and its attachment references: it enters the
  existing inline Host editor prefilled with the refused proposal, Verify only
  commits the next-create Workspace, and the user must submit again for the
  first Session to be created. `unavailable` (a disconnected or unreadable Host)
  and `superseded` (a newer generation or selection) never navigate, an unknown
  refusal code is never guessed into one, and no post-selection create failure,
  cancellation, teardown or dropped draft opens a chooser or replays the earlier
  prompt. A refusal whose captured subject or next intention is no longer
  current is silent: it never repaints, selects or overwrites the newer surface.
- **The inline Host-directory editor completes official Host levels, never a
  Client path.** Opening `Add directory`, or the refused-first-submit path
  editor, starts ONE per-open editor controller with its own private Input.
  Ordinary Add first reads `list(undefined)` and, unless a retained/recovered
  path or a real user edit exists, prefills the official Host home plus the Host
  separator and reuses that SAME listing as the first level. The Host home is
  the only dialect fact; the Client's own homedir, cwd, platform and local
  completion never answer here. A late home answer never rewrites real input or
  its cursor, a cleared value stays blank without a request, and a retained
  initial/recovered path always outranks the home prefill.
  Prefix typing issues ONE debounced `list(parent)`. Candidates are only the
  official child `name`s matching that prefix (case-insensitive for the Host's
  Windows dialect), keep the Host's own order, show at most eight rows, keep
  `hidden` children visible, and are identified ONLY by the official
  `entry.path`. `Tab` or a candidate click writes that path plus the Host
  separator and queries the next level; `Up`/`Down` cycle only rows the frame
  really painted; `Enter` verifies the RAW Input through the existing
  `onAddDirectory`/`resolveWorkspace` transaction and never accepts a
  candidate; the first `Esc` hides a painted suggestion block and the next
  leaves the editor. The ONE bar's `Hide suggestions [Esc]`/`Cancel [Esc]`
  replay that SAME two-layer ladder. A candidate action, browse read or transport rollover
  never registers a Workspace: only the explicit `Enter` reaches the ONE
  existing resolution, which may then commit the next-create intent. A failed,
  refused or unavailable read is stated as such (`Directory unreadable: …`,
  `Directory suggestions unavailable: …`, or an observable unexpected read
  failure); an empty official level is `No child directories`; a prefix with no
  match is distinct; and `truncated` is never presented as a complete no-match.
  A request whose Host connection generation is replaced settles the CURRENT
  editor's browse state as stopped rather than leaving a permanent loading
  claim or presenting the stale result; the raw value and manual Host
  verification remain usable, a new edit starts the next prefix generation,
  and the Home-read case states the reopen path for browsing again.
  While verification pends the editor advertises only the verifying state and
  no completion, mouse or Tab action may start another read or write; a
  settlement returns to editing with the same raw value. A frame too short to
  paint the Input never submits, and 80×2 has no editor body and only the real
  `Esc` action. The Input, home read, latest query generation and painted
  candidate admission are disposed with the editor or the per-open lease, so a
  late result can never repaint a newer open.
- **A sessionless Host surface starts UNSELECTED unless the launch directory is
  provably the Host's.** `@`, the first Session and the standing Skill read
  dispatch nothing while no Host Workspace is chosen: the Welcome says so and
  points at the existing `Choose workspace` Browser. The Client's own launch
  directory becomes an AUTOMATIC Host-path candidate only when the authenticated
  local Host identity proves the same directory object — Linux
  `/proc/<hostPid>/root/<launchCwd>` and the Client launch directory are
  directories with identical `(dev, ino)`, with the Host PID starttime still
  equal to the authenticated one. The candidate is re-proved before the Host
  `workspace.create` and again before its `workspaceId` is adopted, and the
  automatic proposal is one-shot: a committed create consumes it rather than
  assuming it later. An explicit Browser/Add choice always outranks it and
  persists across the Client's next sessionless create.
- **An unprovable launch directory never degrades into a guess.** A different
  inode/device (another mount namespace, a symlinked or replaced directory), an
  unreadable `/proc`, a stale/absent Host identity or a non-Linux Client leaves
  the surface unselected; the user chooses through the SAME Browser/Add flow.
  A Direct/sessionless surface keeps its historical launch-directory proposal —
  there the process IS the Host.
- **The first submit without a selection refuses before any Host write.** An
  unselected sessionless submit creates no Workspace and no Session, keeps the
  draft with the submission owner, states the missing Host workspace, and opens
  the existing Workspace Browser at most ONCE per mounted surface (a cancelled
  picker stays unselected; no render, reload or repeat submit reopens it).
- **The next-create intent is Client-local and runner-scoped.** One
  `WorkspaceNextIntentOwner` carries the optional `host-path` proposal, its
  provenance (launch default, proved automatic candidate, explicit user choice),
  the Client-local selection revision and the last confirmed Workspace id.
  `capture()` returns `undefined` while unselected, so no caller can fabricate a
  Host request. Directory selection or verification changes only that intent; a
  committed create consumes the captured intent, a stale intent fails before any
  Host `create`, and a failed preflight marks the Welcome status rejected
  without replacing the confirmed target.
- **Activity is sampled, never inferred.** One accepted roster revision produces
  one sample from `SessionWorkspaceFactsPort.readActivity` over the read owner's
  roster. Activity generation and eligibility updates are separate from
  Workspace membership revision, and stale roster results are inert. `running`,
  `pending` and `attentionSourceState` retain provenance. Unknown/unavailable/
  denied facts remain complete in Peek/Details; compact rows hide them rather
  than printing them once per Session. A Working row paints `Working`, while
  only confirmed answerability paints `Needs attention`.
- **Answerability is a gate, not a classification.** Only a pending candidate
  this Client can really answer may enter `Needs attention`: a live forwarded
  Question/Approval invocation held by the Client-root delivery owner
  ([host-client.md](./host-client.md)), or a `continued` Question whose official
  projection proves no queued reply while this composition holds the answer
  capability. A pending candidate without that proof stays in its base group
  with `Pending unverified`; it is never a Needs row, never answerable from the
  list, and never retried. `readActivity.attention` is a candidate, not
  permission, and the answer itself always happens after the Session is
  committed, through the surface's existing Question/Approval owner. Every
  Activity sample and every eligibility change applies in the SAME frame: a
  revoked answerability immediately leaves `Needs attention` and its count,
  because a classification is a fact and not a deferred animation.
- **Workspace baseline is the membership authority.** Browse folders use official
  `workspaceId`/`sessionIds` in follow order. A missing, denied, failed or ended
  follow invalidates membership and keeps the roster usable as a flat fallback;
  cwd never proves membership. Ambiguous and unassigned rows are explicit only
  after a valid baseline. There is no `w` key that changes a scope selector.
- **Attention stays inside its Workspace.** Needs/Working are row priorities inside each official Workspace folder, never a cross-folder section or a reason to filter out sibling folders. Browse scope is not narrowed, so the header paints no outside-attention count.
- **Search stays global.** The panel never re-filters the Host's bounded search
  page by the browse scope; only a real editor text change reaches the read
  owner's one debounced Host search generation. `Enter` in the editor only moves
  focus to the first real result; a second `Enter` from the results list is the
  ONE activation: it returns when that result is the Current Session and is the
  guarded Resume otherwise. Results are never re-grouped by Activity.
- **Current row Enter returns.** A listed, painted Current Session row's `Enter`
  (Browse, the Search-results second `Enter`, or Peek `Enter`) closes the Browser
  and returns to the Session that opened it: no Resume intent and no Session
  switch, with the Session id, draft, turn and writer untouched. Every other
  Session row keeps the guarded Resume. The action bar names the real verb —
  `Return [Enter]` in secondary navigation ink for Current, `Open [Enter]` primary
  otherwise — and the Current branch is decided only after the same listed and
  painted admission a Resume needs. A Session row click still only selects;
  returning requires the physical bar segment or `Enter`.
- **`Space` is a read-only Peek.** It opens a plain-text detail of the selected
  painted Session row (full Session id, identity, official Workspace
  membership, cwd, preset, updated, running, pending, source) and nothing else:
  no Agent, no Question/Approval form, no Session `open`/`retain`, no writer and
  no Host call. Folder, New, Add and Show more rows have no Peek and never
  inherit the last Session. `Esc` returns to the previous focus with the same
  selection, query and scroll; `Enter` activates the PINNED Session — returning
  when it is Current, otherwise an open that still has to pass the read owner's
  eligibility/currentness before any switch. The Peek is
  pinned to ITS Session id: if a roster/search refresh no longer lists that
  Session, the Peek exits to its previous focus and the list re-anchors on a
  listed row — it never silently
  shows, or switches to, a different Session.
- **Header, Preview and navigation.** The header is ONE row: `Sessions · <listed
  count>` (or `Choose workspace` in the chooser) with the real `/ Search` target
  on the right. It never repeats the Current Session id or an `All workspaces`
  scope; `Current`/`Next` live on the official Folder row. `Tab`/`Shift+Tab`
  jump by ONE Folder TITLE in the projected tree (wrapping, skipping Sessions,
  New and Show more; from Add they start at the first/last Folder; zero Folders
  is a no-op), and never enter a second focus ring. `Up`/`Down`, `Home`/`End`
  and `PageUp`/`PageDown` move within the actually visible rows. The wide
  read-only Preview follows the typed node (Folder facts, New, Add, Show more or
  the Session detail) and the action bar advertises only the selected row's real
  `Enter` verb. From `112x12` the frame is two columns: the list keeps at least
  44 cells, a two-cell gap, and the rest is the read-only preview/Peek; below
  that it is one column. Frame-level facts (search editor, status and Host error
  lines) span the full width; the Esc action bar is always the last physical
  row, and a short frame withholds activation instead of opening a row it did
  not paint. The inline Add editor consumes the keyboard while it is open; Tab
  never changes the Workspace cursor and `Esc` cancels back to the tree.
- **Mouse is the last painted hit-map.** One render commits a frame revision and
  the REAL painted cell ranges of every tree row plus the Folder disclosure,
  search results and the physical Action Bar's action segments. A click acts
  only on the SAME frame revision and SAME target range as its press; any
  scroll, resize, search, Activity or content change between press and release
  drops the gesture. In the ordinary Browse tree a Folder's title/blank area
  AND its disclosure both toggle that Folder exactly once, so the whole row is
  the disclosure target while the `> ` gutter and Session rows keep their own
  verbs. In the Sessionless `Choose workspace` Browser the same title click
  commits that existing official Workspace and returns, while its disclosure
  only toggles. A Session row click only selects; `+ New session`,
  `Add directory` and `Show more` clicks run their named explicit action;
  Resume is the guarded `Enter` verb and the Current row's `Enter` is its Return.
  The ONE physical Action Bar is
  pointer-capable for its complete painted `Verb [Key]` segments only
  (`Return [Enter]`, `Open [Enter]`, `Peek [Space]`, `Close [Esc]`, `Back [Esc]`,
  `Results [Enter]`, `Verify [Enter]`, `Cancel [Esc]`, and the selected row's
  real Enter verb); each runs the existing method (`resumeSelected`,
  `openPeek`, `handleEscape`, `handleSearchInput`, `handleDirectorySubmit`,
  `handleDirectoryCancel`, `activateSelectedBrowseRow`) and never starts a
  second navigation state machine. The Peek pane paints NO local action line:
  the global bar is the only navigation row, and its `Open [Enter]`/`Return
  [Enter]` is the one explicit activation. A press records the LIVE terminal grant beside the frame
  revision, so a resize that has not repainted yet also drops the gesture. A
  same-row double click on the same word stays the terminal's word-selection
  gesture, so one fast double click toggles a Folder at most once.
- **Wheel scrolls the painted pane it really hits.** The mouse wheel navigates
  the ordinary Browse typed selection over the painted list viewport (painted
  rows and their trailing blank), the Search result selection over the real
  painted result rows (a wheel there moves focus from the Search editor to that
  result list), and the pinned Peek detail over its actual body lines.
  It uses the fork's already-computed signed line count — the Wheel Lines
  setting and the Alt acceleration are never applied a second time — and only
  acts on zones derived from the LAST painted frame and its live terminal
  grant. Header, status, the Search Input, the column gap, the ordinary
  read-only Preview, the Action Bar and the inline Host-directory editor are
  inert; a wheel never activates, resumes, queries, expands or writes. The
  leased root consumes every wheel, so an inert wheel never scrolls the
  background Transcript; a real navigation hit retires an old press while an
  inert wheel leaves a legal press intact.
- **One lifecycle.** Each open keeps exactly one Workspace follow, one roster
  read owner, one Activity sample generation and one fullscreen lease. The close
  path aborts list/search/Activity, disposes the follow once, stops the screen
  once and restores the return surface once; a late result from any of the three
  sources can never paint into a newer open. An Activity update never moves the
  cursor to another Session: the selection is preserved by Session id and the
  scroll anchor by the visible row id, so the user keeps browsing the same row
  while the groups and statuses repaint truthfully.

Authority: `TuiApp.openSessionWorkspace` + `SessionWorkspacePanel`,
`projectPiTuiWorkspaceTree` (the ONE PiTUI action-row adapter over the shared
visible tree), `buildSessionWorkspaceView` (the ONE pure classifier),
`SessionBrowserReadOwner`, `SessionWorkspaceFactsPort` and the Client-root
forwarded-answer eligibility view; sink: the leased fullscreen screen.

Must-not: add a second Session roster, a second Activity reader, a Host pending
store, a Workspace registry or a persisted Workspace table, re-filter Host
search results, infer membership from a cwd, treat `attention` as answer
authority, expose an answer form in Peek, give a row a hit region the frame did
not paint, or treat an accepted Resume intent as a committed switch.
