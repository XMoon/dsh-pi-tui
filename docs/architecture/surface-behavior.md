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

`/settings` opens one fullscreen lease with ONE navigation focus state. The
category rail is the selection owner; the right column is the content. Width
only projects panes (≥108 three, 76–107 two, <76 one). The category order is
`About, Models, Account, Appearance, Display, Plugins, Other settings`;
`/settings` lands on `About`.

- `About` is the default home: a read-only projection of the brand and the two
  package versions (the bundle's own version and the installed DSH version as
  two independent facts; an unreadable DSH version reads `Unknown`). It shares
  the Welcome card's whale pattern and brand gradient, and it never creates a
  session, reads a configuration authority or writes anything.
- `Models` and `Account` are DIRECT content pages in the SAME lease (not
  fabricated Settings rows and not a second alt-screen owner). Selecting either
  on the rail paints the real page in the right column at once, while the
  keyboard stays on the rail; `Enter`/`Right` then hands the keyboard to that
  page and runs no page action by itself. `Esc`/`Backspace`/`Left` returns the
  keyboard to the rail and keeps the page instance, its view, its draft and its
  watch; only a real category change or a real close disposes it. Narrow paints
  one page with an explicit `Esc`/Back path.
- The four configuration categories keep their three-level browse (L0
  categories, L1 rows, L2 detail) and their existing writers.
- Exactly two configuration rows are writable: the configured theme and the
  transcript display setting. Browse/copy never write.
- An L2 choice is transient; only an explicit Confirm commits one field through
  the serialized whole-document `ConfigPort` path and re-reads the authority.
- `Verified` requires a ready read-back with a matching value. Rejected/unknown
  outcomes are attributed from a fresh read, never guessed. A refused write is
  reported as `Not saved`/unknown, never as success.
- Theme auto is fenced on the runtime selection intent.
- `Plugins` is a direct page entry inside the same lease (see Plugin Manager);
  the legacy complete editor stays reachable through `Other settings`.
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
  catalog: `Configured` /
  `Key missing` for an API-key reference, `Signed in` / `Not signed in` for a
  provider-native sign-in, `Checking…` while the read is pending, `Outcome
  unknown` for a failed read and `Unavailable` for a backend that cannot
  answer the question. A credential reference may be shared by several
  providers: the reference is read ONCE per generation and every row shows
  that answer.
- The stored-record presence is ONE enumeration for the page. The full
  Stored Credentials list (with its per-reference audit) is read only when the
  user opens that view, and a backend that cannot enumerate records is
  `Unavailable`, never an empty list.
- An authority-dependent write (the API key, the stored-credential clear and
  the native sign-in) waits for a FRESH read: while a refresh is in flight,
  or the last snapshot is not the current authority (a stale snapshot), those
  actions are disabled and the page states that the configuration is not
  current.
- `Add Provider` is a catalog: `Available providers` lists the unconfigured
  providers this installation offers, each with the operation this page can
  really perform for it (a native sign-in, the prefilled setup draft, or an
  explicit manual-only reason), and `Other sign-ins` lists the sign-in flows
  that no provider profile addresses. One `Custom provider…` action opens the
  existing draft. Browsing writes nothing; a catalog entry is activated only
  by an explicit Enter, and a route with no supported operation states why
  instead of claiming success.
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
  identity (reference vs stored record). After the clear the page re-reads the
  store; it never claims success without the authoritative absence.
- The custom provider draft is one page-local form over route → protocol →
  base URL → display name → optional key → discovered/manual model ids →
  review → create. Nothing persists before Create. Profile and credential
  writes are separate Host operations; a persisted profile with a failed key
  write is reported as a partial outcome with the exact failed stage.
  The Create is CONDITIONAL: it writes the profile of a NEW route, it is
  refused when the route already has a profile, and it is checked against the
  revision its decision was read at — a provider configured in the meantime
  is refused (the user re-reads and retries), never overwritten.
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
target, clear the Account grant as a generic record, or let an older page
settlement repaint the current page.

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

`/plugins` and `Settings → Plugins` open the SAME `PluginManagerWorkspacePanel`
and `PluginManagerController` inside the existing workspace Alt-Screen lease.
Settings keeps its L0/L1/L2 state while the page is on top; Esc returns to
Settings L0 with Plugins selected, while direct entry returns to the untouched
conversation. The controller outlives the page; a second open is a no-op; a
refused lease leaves no phantom claim.

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
- Leaving/hiding the page never cancels a Host operation. `i` reopens the SAME
  controller state (in-flight request, failed/unknown requestId, or a recent
  result); `hasResumableInstall` is the reopen predicate.
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

Authority: `src/commands.ts` (`PATH_ARGUMENT_COMMANDS`),
`src/tui/file-completion/path-argument.ts`,
`src/tui/interaction/autocomplete/provider.ts`,
`src/domain/transcript/content-blocks.ts`,
`src/tui/components/media/image-thumbnail.ts`.

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
