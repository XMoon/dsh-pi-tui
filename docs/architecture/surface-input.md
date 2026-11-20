# Input, attachment and shell surface behavior

Composer attachment intake, completion routing, @ references and shell-input surface behavior are owned here; submission admission and Host execution authority remain in the shared contracts.

This is the sole owning document for the following surface-specific behavior. See
[host-client.md](./host-client.md) for Host authority and
[overlay-focus.md](./overlay-focus.md) for focus/lease lifecycle.

## Attachments and input completion

Attachment completion and intake are Client-local:

- `/attach` and `/image` carry path-argument completion backed by
  `suggestPathArgument(argument, clientCwd)`. An unscoped term uses
  time-budgeted finder-first discovery with a bounded recursive fallback; a
  scoped empty term lists that directory's children; a scoped NON-empty term
  matches the named directory's DIRECT children first — when any direct child
  matches, exactly those candidates answer (no recursion into the subtree);
  with no matching direct child the time-budgeted finder, then the bounded
  fallback, search the scope. Windows drive/UNC tokens keep their own dialect.
- Tab on an empty argument is a file-completion site only for commands that
  declare path-argument completion; accepting a directory reopens its children.
  The Client cwd is read at call time and stays independent of the Session/Host
  cwd. `@` whole-tree search remains Host-scoped. An UNCLOSED quoted argument
  completes inside the quotes (a quoted name may contain spaces); a CLOSED
  quote is treated as a complete token and does not complete. An accepted
  DIRECTORY keeps its quote open so the next completion continues in the same
  token, while an accepted FILE closes it.
- The attachment path token's boundary is ONE shared grammar, the same in every
  renderer: an unquoted word ends at an ASCII space or tab, a CR or an LF ends it
  in either form (an open quoted token never reaches across a line for its
  partner), and a Unicode whitespace such as U+3000 stays ordinary filename
  content. A line break may really sit inside a line — one renderer inserts a
  bracketed paste verbatim, another normalizes CR to LF before this grammar ever
  sees it — and an accept replaces a fragment of ONE logical line, leaving that
  break and every later line byte-for-byte untouched.
- `/attach` and `/image` are ALSO inline attachment sites: the
  FIRST logical line's leading command token stays the leading command seat
  above, while a declared attachment command token at any other cursor position
  (mid-body prose, or a later line's leading token) opens the same inline
  `/name` dropdown with two fixed actions (`Insert local image`, `Attach local
  file or image`) and then the SAME Client-local path candidates. Accepting a
  DIRECTORY only continues that path seat. Accepting a FILE replaces exactly
  the accepted inline fragment with the canonical placeholder through one real
  undoable edit of the live draft and never submits, queues or steers it;
  `weird/image`, URLs, `/usr/bin` and ordinary paths are never such a site. The
  intake is the same one `/attach <path>` uses (one read, the existing draft
  stores, no second draft copy); the inline route differs only in its commit
  target. Every confirm gesture (Tab, Enter, mouse click and the single-candidate
  Tab shortcut) is accept-only there because those rows bind no leading-command
  prefix, and the acceptance is honored only while the accepted request's strict
  snapshot, the accepting row's own identity, the live editor document/cursor,
  the seat and the surface generation all still match.
  Ownership is proven BEFORE the write; the notice reports the write. A
  successful placeholder replacement is exactly what makes the accepted draft
  snapshot no longer describe the draft, so the `attached … — Enter to send`
  success notice is gated on the intake's Session OWNER and on the commit
  actually returning `true` — never on the pre-commit snapshot (that would
  swallow every real success) and never after a refused commit (a rolled-back
  item announces nothing).
- `/attach <path>` is the canonical Client intake. Images go through the image
  pipeline; other regular files stage as metadata-only drafts. On the Direct
  backend a submission streams the draft through the in-process
  `ctx.attachments.saveFileStream()`; on the Remote backend the same Client-local
  stream is uploaded through the official authenticated raw file route, whose
  Host `FileUploads` authority stores the bytes and returns a Session-scoped
  receipt. The Remote prompt carries that receipt, and the pending-submission
  echo uses the Host-issued file metadata — never a local name/size guess. The
  Client-local path never becomes a Host file reference in either backend.
  `/image` stays image-only compatibility. Neither reads the file eagerly or
  routes through the Host filesystem.
- A generic-file submission is bound to the attach-time local source identity:
  the file is streamed at submit time, and a source that was deleted, replaced
  (including a FIFO), or changed (size/mtime/inode) is refused before any Host
  prompt. A Remote upload that completed does not by itself mean the Host
  accepted the prompt; only Host prompt acceptance, its durable history or an
  Inbox row carrying the same request carries that fact. A failure before the
  prompt is dispatched restores the same draft and never retries or reuses a
  staged receipt. A durable generic file recalled from the Host queue
  (`Alt+Up`) has no official Client carrier to re-bind a receipt on EITHER
  backend: the gesture refuses the whole recall before staging any draft or
  removing any queue occurrence and keeps the queue and editor unchanged; the
  user removes the file-bearing occurrence through `/queue` and recalls again.
  This is a shared semantic boundary, not a transport capability difference and
  not a claim of full file parity.
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
- A REAL terminal bracketed paste whose complete body is one absolute image file
  path plus the terminal's single trailing ASCII space is a THIRD intake source,
  distinct from `/attach`/`/image` and from the Ctrl+V OS-clipboard probe: the
  pasted path first appears as ordinary editable text, the asynchronous read
  stages the image in the SAME draft store, and the ONE proven paste span (never
  an `indexOf` match) is replaced with the canonical placeholder through one
  real undoable edit. The candidate grammar is strict — absolute POSIX, no
  control characters, one trailing space, a case-insensitive
  png/jpg/jpeg/webp/gif extension — while the file content remains the MIME,
  size and dimension authority. Until the read settles, every submit/queue/steer
  path refuses BEFORE clearing the draft or its Undo history and asks for a
  retry; a failed read keeps the path text and reports the basename. Only the
  default host composer and the TSP composer claim it: plugin replacement
  editors and shell-mode pastes keep their raw paste semantics, and a non-image
  paste is inert.
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
  uses the canonical `🖼️ ` marker (VS16). Pixel rendering uses raw PNG on
  Kitty, the original format on iTerm2, and — on Kitty — a bounded
  ASYNCHRONOUS PNG derivative of a local JPEG/WebP draft, all within the
  existing 4 MiB staged-source cap. That derivative is the SAME Client-local
  decoder the transcript uses (first frame only, EXIF orientation applied,
  fitted inside 768×768 without enlargement). The identity row, the `x` hit
  and the submitted bytes keep the ORIGINAL draft dimensions, media type and
  encoded bytes; while the derivative is pending the card paints the original
  identity plus `…`, and only an admission or decoder failure shows
  `Preview unavailable`. The derived state belongs to the ONE last-visible
  card of the mounted component (at most one running conversion) and is
  retired on a card switch, session switch, invalidation or dispose: a late
  result never repaints another card or a destroyed surface, and an
  Undo-restored draft is re-derived on the next visible paint. Unsupported/
  oversized/empty/recalled drafts and GIFs paint the real MIME, name,
  dimensions and `Preview unavailable` in the **card identity row**. The
  one-line summary fallback paints only the occurrence count plus the latest
  `#id W×H`, never a pixel claim. The band reads no new file, never reads a
  recalled durable ref and registers no global decoder or pixel cache. Its row
  grant participates in the unified fullscreen pinned-chrome/footer/widget
  budget; the widget/footer reservation is bounded to avoid a feedback cycle
  and may under-grant, never overflow.
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
`src/tui/interaction/autocomplete/installed-provider.ts`,
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

### Input completion seat

The candidate list has ONE source and ONE composition. The single catalog commit
point in `src/commands.ts` publishes the effective display catalog (Host rows,
Client registrations and merged extension contributions) together with the
collision and Host-claims bookkeeping, and that same install reaches the mounted
renderer by renderer kind: PiTui through the editor's installed autocomplete
provider, a renderer without a PiTui editor through the mount's command-completion
install port, which only forwards. Both compose their provider from
`createInstalledAutocompleteProvider`, so there is never a second catalog,
resolver, claims map or ranking implementation.

- A candidate row is a display fact only. Screening happens once, at that commit
  point, by real source provenance: a genuine Host-origin winner keeps its row and
  is never screened by renderer capability; a live dynamic Skill wrapper keeps its
  row; a row proven to be this surface's own TUI registration is offered only
  while the mounted renderer can run that command family, read from the mounted
  presenters at each commit (never a version or a name guess), and it never falls
  through to a same-name extension contribution; every other admitted row stays
  visible. A failed synthesis (a name collision) withdraws ALL displayed
  candidates while the Host input claims stay live.
- A bare `/name` candidate carries no argument, so a builtin whose bare form needs
  UI the renderer lacks is not offered. Offering a row is never an execution claim:
  submitting the original text still runs the unchanged gate and refusal.
- The renderer's own seat (`src/tui/tsp/input-completion.ts`) opens a list at
  exactly the positions the SHARED classifier already recognizes, and classifies
  nothing itself: the FIRST logical line's leading command token with no space
  before the caret is the command seat; an `@` token at a real boundary is the Host
  mention seat; a declared file-argument command (`/attach`, `/image`) is the
  Client-local path seat, and its own `leading` fact separates the legacy first-line
  argument seat from the inline body seat; a `/name` token at any other position is
  the inline seat the two fixed attachment actions share with the skill lexicon. A
  literal `!`/`!!` shell line, an email, `pkg@1.0.0`, a URL, a bare `./path` or
  ordinary prose open nothing, and the seat never asks a plugin about a position it
  did not admit. Which of those positions exists at all is the classifier's
  contract (`## Attachments and input completion` above and
  `## Session \`@\` completion routing` below), not a second rule invented per
  renderer.
- Sources never substitute for each other. A Host mention answers ONLY from
  `HostFilePort` under the current completion scope; an authoritative empty or
  `unavailable` answer opens no Client-local listing, is never re-scanned locally
  and is never presented as "the file does not exist" (see
  `docs/architecture/host-client.md`). A Client-local path argument answers ONLY
  from the local cwd and never queries the Host port; `/image @foo` is a local
  argument, not a mention. A text `/name` row — including one a plugin forged with
  attachment-shaped fields — never grants a read, because the shared provider's own
  strict request snapshot and row identity are the permission. A failed COMMAND
  catalog blocks only the command seat: a withdrawn catalog says nothing about the
  Host or local file sources.
- Accepting a candidate is a Composer edit, not a submission: the shared provider
  computes the replacement and the renderer's composer applies it as one
  conditional atomic write that keeps the text before and after the admitted token
  and parks the caret where the provider landed it — never at the end of the
  draft, which is what a whole-document draft write does. The span an accept may
  rewrite is the token the ORIGINAL classifier named for that seat (the `@` token,
  the argument range, the inline `/name` token plus whatever its own grammar
  consumes right of the caret, the command token), so no answer can move the `@`,
  eat the prose, rewrite the `/image` command token or reach another line; an
  out-of-span answer writes nothing. Only a later, separate submit gesture reaches
  the submission controller. The write is refused as a whole when the live document
  or caret no longer matches the document the replacement was computed against,
  when the caret is not a grapheme boundary, or when the change is not confined to
  one logical line; a refused completion changes no text, caret, paste lease or
  frame.
- An accepted inline attachment FILE is a two-phase gesture, and the two halves
  have different owners. The provider hands the immutable acceptance to the seat,
  which only STAGES it for that one gesture; the mount settles it through the
  installed command-plane stager — the same `runAttachmentIntake` authority the
  leading `/attach`/`/image` commands use (one Client-local read, the existing
  budget, the existing draft stores, the existing notices) — AFTER the composer's
  own atomic write committed the accepted document and caret. A refused write, a
  stale seat, an uninstalled stager, a moved document or caret, or an edit that
  walked away and back to the same bytes (the composer's edit-revision fence)
  produce no read, no store mutation, no placeholder and no success notice, and the
  user's own path text stays editable. An accepted ACTION writes `/image `/
  `/attach ` and reopens the same seat's path candidates; an accepted DIRECTORY
  continues the path seat; neither reads anything. The canonical placeholder
  replaces exactly the accepted fragment through one atomic composer edit that
  preserves every other paste lease, and the intake's session-scope and transition
  fences stay the command plane's. The leading argument seat never stages on an
  accept: the command handler still runs on the NEXT explicit submit.
- Any currentness loss ends the browse without touching the draft: a new catalog
  commit, a formal completion-scope change, a cleared draft, a Session
  publication, a hydration window, a disposed renderer, or a higher input seat
  taking the keys. A late answer and a click on an older frame's row are dropped on
  the same fence. The Host file scope is a completion-scope fact ONLY for the
  answers the Host produced (the `@` mention and Host shell facts): the declared
  path argument and the inline action/skill lexicon are Client-local, so their
  snapshot is scoped by the Client cwd, the document and the input mode — a Host
  workspace identity/revision change (including the sessionless mount's own
  first-workspace preflight confirming the launch directory, and an A→B→A
  selection) never fences them. That is the one case a painted Client-local row
  would otherwise stay visible while its accept wrote nothing, because the seat
  holds no Host scope of its own to withdraw it.
- While the list is open it owns ↑/↓, Tab/Shift+Tab, plain Enter and Escape:
  Escape closes only the list, and a modified or otherwise unconsumed key retires
  the list first and then reaches its existing owner exactly once — so a visible
  list can never turn Cancel into a no-op, and a no-op key can never leave a
  dismissed list painted. Plain Enter ACCEPTS and is never a submit, with ONE
  exception: when the first logical line's WHOLE command token already names the
  highlighted candidate and the caret sits at that token's end, there is nothing
  left to complete and Enter stays the submission gesture it has always been. For
  every other seat an Enter that cannot complete is still consumed, so a mention, a
  path, an action or a skill never executes or sends on the accept gesture. With
  the list closed the Composer's own arrows keep their existing meaning, including
  the input-history recall browse.

Authority: `src/commands.ts`,
`src/tui/interaction/autocomplete/installed-provider.ts`,
`src/tui/tsp/input-completion.ts`, `src/tui/tsp/editor.ts`,
`src/tui/tsp/session.ts`, `src/tui/commands/artifacts.ts`,
`src/app/command/tsp-capability.ts`, `src/app/surface/runtime.ts`,
`src/runtime/host-file-port.ts`.


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
fabricates matches). For a non-empty scoped term the same direct-child-first
rule as Client path completion applies: a matching DIRECT child of the named
scope answers without recursion; only when none matches does the scoped search
descend. Both localities bound the finder's whole work with one shared wall
clock budget; an over-budget run is a finder failure whose partial output is
never presented — the existing bounded fallback answers instead. A finder run
that finishes within the budget is ranked exactly into the all-types and
directory-only top 50 sets; no claim of a global best-50 over an arbitrarily
large tree is made when the work does not finish in time.

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
`src/app/host/features/file-reference.ts` and the private
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
- `!` is context-bearing: its completed result is written exactly once to the
  Session that submitted it, by the application's Session-write owner. `!!` is
  session-excluded: it writes no Session event and is never visible to the
  model. Both execute in the Host environment; the execution adapter itself
  never writes Session state.
- `bypass`/`sandbox` are Host execution policies, not machine locality.
  `localShellSandbox` defaults to `bypass`. Direct persists it in the `tui-app`
  settings document; in split-process mode the Host-only profile disables
  `tui-app`, so the `pi-tui-host-runtime` Loader row uses the same Config
  schema as the settings owner and the Remote ConfigPort reads and writes that
  Host descriptor. The Host validates the Client's requested policy against its
  live setting before preparation and again before spawn; a stale or mismatched
  request fails closed. Sandbox mode requires Host enforcement `full` and never
  falls back to bypass.
- One run is a Host-owned ONE-SHOT execution on Direct and Remote alike: both
  policies spawn the raw `['bash', '-c', command]` through the official
  `ctx.subprocess.spawn` seam in the Host workspace/environment and settle once
  with the process's real exit code or terminating signal. `sandbox` first
  resolves the exact live Session's policy, calls the official
  `ctx.sandbox.confine` exactly ONCE before the spawn, requires
  `enforcement: 'full'`, and spawns the EXACT argv that one call returned; a
  composition without the required official capabilities refuses before any
  spawn instead of degrading to bypass. The Client never spawns the command or
  supplies Host environment facts; on the Remote path, the Owner-only Host
  admission requires the exact live Session named by the request, and an unknown
  or mismatched Session fails closed before execution. Direct remains the
  production default and serves this contract in-process; Remote is the
  split-process transport of the same contract.
- Output is collected through the subprocess provider's per-stream collect/spill
  dispositions: each stream keeps a bounded in-memory tail and reports its own
  truncation instead of claiming lossless bytes, and the Host-local spill file —
  when one exists — holds the complete stream (a stream larger than the spill cap
  has no spill file). The managed range is joined before the collected readers
  are read once; there is no incremental stream, acknowledgement window or
  second output owner.
- Sandbox diagnostics follow the official bash-sandbox order: classify an
  OBSERVED runner-fatal from the collected stderr FIRST, even when that stream
  is truncated — a retained tail that positively matches a runner-fatal rule is
  a runner failure, never a denial and never a settled shell result, so it is
  not written to the Session. Only when no runner-fatal is observed does
  truncation decide the remainder: a nonzero exit with truncated stderr is a
  reason-UNKNOWN settlement (a higher-priority runner-fatal line may have been
  dropped), the card preserves the real exit and truncation, asserts no definite
  `sandbox denied`, and states that the failure reason cannot be determined, the
  command may have executed and it must not be retried automatically. A denial
  signature is never asserted while stderr is truncated; only a complete stderr
  may confirm a denial. This reason-unknown is distinct from the transport-level
  UNKNOWN of a lost terminal result. A pre-spawn runner failure remains its own
  failed outcome. A zero exit, a signal kill and a bypass run are outside this
  rule.
- Cancellation aborts the run; the subprocess provider terminates the managed
  process range and the Host joins that range before returning the settled
  result. A run whose terminal result is lost is a transport-level UNKNOWN
  outcome, distinct from the sandbox reason-unknown above: the card states that
  the command may have executed, the run is never replayed, and an unknown
  result is never written to the Session.
- Completion uses one shell grammar over the selected semantic port. Direct keeps its existing `bash -lc` compgen and fork path provider. Remote queries command names, variables, git subcommands and paths on the Host, scoped by the ONE completion target captured with the request: a live Session answers from that Session's effective cwd and Host environment; a sessionless surface whose Workspace selection confirmed a Host-issued id answers from that Workspace's Host directory and Host environment (zero Session, zero Agent, zero Session write); a sessionless surface with no selected Workspace answers `unavailable` with no Host read and no Client fallback. A Host refusal never falls back to Client PATH or filesystem, and a Workspace that is unregistered, revoked or unreadable during the completion is `unavailable` rather than a stale or empty success. A completion RESULT may not cross a Connection generation: a candidate reply that arrives (or is applied as an asynchronous result) after the Connection generation changed is refused, matching the official Client lifecycle (request abort, menu generation, editor document currentness, plus Host re-validation at execution). An A→B→A Workspace switch is a new selection revision: a candidate produced before it is never applied to the new editor state. Accepting an already-displayed candidate that only edits the user's draft is NOT itself a Connection-generation check; execution admission remains the authority for whether a command runs.
- The user-shell card is one-shot. Every `!`/`!!` gesture freezes a
  Client-local display placement captured synchronously at acceptance; the card
  is a standalone transcript block and is never appended to the live tail by
  later Agent/Tool events. In the folded default it paints at most three
  physical rows: the header/status, the single `$ command` row, and — settled
  only — one authoritative outcome row (an exit/signal/timeout/truncation or
  error fact). A running card paints no output preview. The retained bounded
  streams, their own truncation lines (each naming the Host-local spill file
  when one exists), a definite `sandbox denied` fact only when no
  reason-unknown applies, the reason-unknown notice (`stderr truncated; failure
  reason cannot be determined, command may have executed; do not retry
  automatically`) for a nonzero sandbox run with truncated stderr when no
  runner-fatal was observed, and the real `[exit N]` / `[signal NAME]` /
  `[timed out]` markers stay reachable through the existing card expansion
  (never by reading the spill file). The retained body is bounded; at most 32
  settled cards are kept per mount, evicting the oldest settled card first
  while every running card stays owned by its run. A settled `!!` is a
  Client-local display record: it survives later Enter / Ctrl+S submissions
  and a later `!`; only a real Session switch/hydrate, a TUI remount or Alt+K
  retires it. Alt+K drops settled cards only, never cancels the process (Esc
  owns that) and never deletes Session events. A committed `!` removes exactly
  ITS OWN local card after `SessionWriter` reports committed, leaving every
  other shell card in place; rejected, indeterminate, cancelled or unknown
  outcomes keep their diagnostic card. A retained `!` card additionally carries
  a Client-local Session-submission marker: `not submitted` for a rejected,
  cancelled or pre-dispatch failure, and `submission uncertain` for an
  indeterminate write that must not be retried automatically. The marker is
  visible in the folded outcome row, and the expanded card keeps the concrete
  writer reason without changing the Host execution status (`[ok]`/`[error]`). The Child Viewer never renders the
  main Session's shell cards; they stay owned by the hidden main view and
  return with it, while a real Session replacement clears them.
- The card's placement belongs to the Client-local display policy, not to the
  Session event order: if its source row leaves the current window the card is
  not materialized there, and a card accepted while browsing history is
  anchored once when the latest window first returns — never to the global
  tail and never as a fake Session turn.

Authority: `src/tui/interaction/editor-input-mode.ts`
(`shellPrefixForMode`, `serializeEditorInput`, `editorModeFromHistoryEntry`),
`src/tui/interaction/tui-editor.ts`, `src/client/shell/compgen.ts`,
`src/app/submission/user-shell.ts`, `src/app/config/schema.ts`,
`src/app/host/pi-tui-host-runtime.ts`, `src/runtime/remote/config-remote.ts`,
`src/runtime/host-user-shell-port.ts`,
`src/runtime/host-user-shell-execution.ts`,
`src/runtime/host-shell-completion-port.ts`,
`src/runtime/direct/host-user-shell-direct.ts`,
`src/runtime/direct/host-shell-completion-direct.ts`,
`src/runtime/remote/host-user-shell-remote.ts`,
`src/runtime/remote/host-shell-completion-remote.ts`,
`src/runtime/remote/pi-tui-host-user-shell-host-bridge.ts` and
`src/app/host/features/host-user-shell.ts`.

Must-not: put the prefix in the buffer/cursor math, route a shell line through
slash commands, downgrade sandbox to bypass, call `ctx.sandbox.confine` more than
once, spawn an argv other than the one it returned, skip the official
`ctx.subprocess.spawn` seam, replace the one-shot bounded collect with an
arbitrary-length byte-perfect stream or a custom ACK/backpressure/mux/relay, add
a second file channel, a second process owner, polling/jobs or a public API for
this path, cache a failed compgen run, or let a mode-less plugin seat inject
`prompt` into a Host `!` submit.
