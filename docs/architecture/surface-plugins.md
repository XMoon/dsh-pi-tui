# Plugin Manager and Plugin Detail behavior

Plugin Manager user interactions, inventory presentation and operation surfaces are owned here; the Host-owned plugin inventory and mutations remain in host-client.md.

This is the sole owning document for the following surface-specific behavior. See
[host-client.md](./host-client.md) for Host authority and
[overlay-focus.md](./overlay-focus.md) for focus/lease lifecycle.

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
the plugin content owns the keyboard. At ≥120 columns the frame is
`Categories | List | Details` when the frame can still grant six real business body
rows; at 76..119 it is `Categories | List` while the
rail owns the keys and `List | Details` once the plugin content does, so the rail
is not painted in that second case. That pair needs `allowDual`, a local width ≥76
and SIX real business body rows, so a shorter
frame degrades to ONE business column rather than squeezing the body; the split is
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
cancelling the Host operation. The upgrade view follows the same rule: Esc from
`checking`/`selecting`/`confirm`/`done` returns to that Bundle's Detail, while a
`running` or `unknown` update hides the page (to the List) without cancelling or
re-dispatching the Host operation. The rail's `Tab`/`Enter`/`Right` only
transfer the keyboard into the List. `Esc` in the install/update gradient and
the details sub-state never cross levels. A page factory failure releases the
claim and disposes anything half-built instead of faking success; a page that
starts after an earlier attempt ALWAYS starts on the List, `i` reopens the same
in-flight/failed/unknown install request id without dispatching a second
install, and `u update result` reopens the ONE update lifecycle after it was
hidden.

### Host authority is owned elsewhere

The Host package/profile authority, semantic port, Direct/Remote mapping and
Connection generation fencing are owned by [host-client.md](./host-client.md).
This surface owns the controller/read-epoch/state-machine/workspace behavior; it
never invents catalog facts, and a `@deepseek-ai/` scope or `experimental`
substring is not identity proof.

### Default listing, explicit search and refused bundles

The Host's `BundleInfo.listedByDefault` is a DISPLAY decision, never enablement
or load success. The workspace applies it ONCE, as a local projection over the
same model cards: with an empty query, a `listedByDefault:false` bundle is
listed only while the profile selects it, the profile installs it, or a live row
proves it runs; any non-empty explicit search lifts that gate over the SAME
`model.cards`. A status filter never resurrects a default-hidden card, and no
entry is dropped from the controller, the model or the Host snapshot, because
the Host catalog stays the only authority and explicit search is the documented
route to the complete inventory. The list carries ONE hint line naming that
route; there is no second catalog page, store or navigation level.

A `Host error` outranks every selected/available summary. The SAME Host
`enabled` boolean means different things per target and is labelled accordingly:
a bundle's flag is the profile SELECTION (`Selected in profile`), while a
standalone Loader entry's flag is its effective enablement (`Effective enabled`,
including disabled ancestor groups). `Fiber` stays the separate runtime fact in
both cases, so a bundle the Host refuses with `unsupported-platform` is never
presented as running and an entry is never mislabelled as a profile selection. That refusal blocks only the official catalog Install; it
never locks the recoveries the Host still permits. A selected bundle can always
be disabled through the real `setBundleEnabled(name,false)` plus the
authoritative reread — including while its files are missing or its platform is
refused — and a profile-owned bundle's Remove is answered independently by the
Host `removable`/`availability` facts, through its own destructive confirmation.
The TUI never fabricates a platform decision, retries an indeterminate write, or
reports a refusal as success.

`BundleInfo.update` is the declared Host update SOURCE, never a TUI guess: only
a non-self bundle whose value is `'registry'` offers `Check updates…` (before
Remove), and the entry is answered by the official `listVersions` read. A
bundle whose Host source is `'git'` states that source but never offers the
registry action. The Host's `installed`/`official`/`source`/`readOnlyReason`
facts — not a local check — decide the capability; a bundle with no declared
update source keeps the Remove-then-explicit-install guidance.

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

### Update state machine

Phases (ONE Controller-owned lifecycle, never a second store):

```text
checking → selecting → confirm → running → done
   │           │          │         │
   └───────────┴──────────┘         └──→ unknown
```

- `Check updates…` requires the current Host model card to be a non-self
  `target:'bundle'` with `update:'registry'`, and fixes the installed version and
  read epoch before `listVersions(name,{})`. An UNFINISHED preview
  (`checking`/`selecting`/`confirm`) is reused when the page is re-entered; only
  an explicit `r` repeats its registry read, and a new inventory read
  invalidates an unconfirmed list (`Bundle changed; check versions again`). A
  `done` result is historical evidence, not a frozen preview: `Check updates…`
  on the same bundle starts a NEW check (never a re-dispatch and never a reuse
  of the old registry/version selection), while `u update result` reopens the
  settled result until that new check replaces it.
- `selecting` renders every Host-listed version verbatim: tags, publication
  time, prerelease, deprecation, bundle declaration and compatibility. A
  non-bundle, incompatible or deprecated row is not selectable; a legal
  prerelease is selectable only by an explicit choice (the initial suggestion is
  the first eligible stable version and does NOT silently pick a prerelease).
- `confirm` shows `From → To`, the Host-answered registry, and the consequence
  warning; Cancel is the default choice, and a dangerous primary is painted only
  when its whole warning fits the painted body (a tiny frame withholds it and
  says why). Enter/pointer activation re-checks the last-painted action and the
  current installed-version/read epoch; a changed inventory withdraws the
  confirmation without writing.
- `execute` sets the request id, `running`, `busyValue` and `mutationToken`
  synchronously, then calls the official `updateBundle(name, exactVersion,
  {registry, requestId})` exactly once. While the update owns the path, Remove,
  Toggle, a new Install, build approval and a second Update are refused. Hiding
  the page never cancels or re-dispatches it.
- `running` renders the official `plugin-manager/update-state` steps and the
  matched `install-state`/install-log by exact request id; unrelated ids never
  enter the update log. `s stop target install` exists only while the update step
  is `installing` AND the matched install phase is `installing`; it calls
  `cancelInstall(requestId)` and keeps waiting for the update result. A
  `cancelled` / `too-late` / `not-running` answer is only a notice, never the
  update's outcome.
- The returned `PluginUpdateResultFact` is reported as TWO independent fields:
  the target `result` (`application`, `stage`, `version`, error, restart) and
  the optional Host `restore` (its own application/error/version). A target
  failure with a successful restore and a target failure with a failed restore
  are distinct states; a missing restore is never presented as a restored
  version. `restart-required` is shown as such.
- The update is `done` only after a fresh authoritative `snapshot()` read. The
  observed installed version is a separate fact from the operation result; a
  failed reread is `Inventory stale`, never a fabricated current version.
- A transport/Remote-generation failure after dispatch is `unknown`: it is
  neither success nor failure nor cancellation, is never retried, and keeps the
  local write lock. A successful authoritative reread plus an explicit
  `Acknowledge uncertainty` is the only release; the acknowledgement states that
  the Host may still be finishing the update.
- A settled update while the page is hidden is notified once and stays
  reopenable through the List's `u update result`; `Check updates…` after
  `done` starts a new check instead. No second update history/task center
  exists.

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

Derive only from `availability`, `canRemove`, `isSelf`, `version`,
`installTarget` and the Host `update`/error facts:

- self → managed outside this screen;
- installation → upgrade DSH; no in-place update or Remove;
- profile-owned with `update:'registry'` → name `Check updates…` and state that
  the Host re-checks the exact target before changing the profile;
- profile-owned with `update:'git'` → state that the bundle is managed from its
  Git source and is updated there, never through the Plugin Manager;
- profile-owned without an update source → Remove first, then an explicit later
  install; state when removal is not permitted;
- missing with an official target the Host itself refuses (for example
  `unsupported-platform`) → install unavailable with the Host reason;
- missing with an official target → the Host-offered target (masked spec +
  version); Install remains the only path;
- missing without a target → install unavailable;
- show `Version difference` only when both versions are known and differ; never
  claim "latest"; an unreadable current version is `unavailable`.

The guidance never dispatches a mutation and never echoes full userinfo/tokens.
