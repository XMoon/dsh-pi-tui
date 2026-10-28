# Terminal output safety

This is the ONE contract for how `@xmoon76/dsh-pi-tui` projects untrusted text
onto a terminal. It owns the display projection itself, the authority split
between raw source and rendered bytes, and the exceptions; subsystem documents
own their own layout contracts and link here instead of restating this policy.

## Threat and boundary

Text that originates outside the TUI — DSH/Host Job output, Session transcript
rows, model output, tool JSON results, local `!` shell output, subprocess logs,
external package metadata, approval arguments, session titles and search
snippets — may carry arbitrary terminal control bytes. The terminal interprets
those bytes; it does not display them. A raw `ESC ] 52 ; … BEL` can overwrite
the clipboard, `ESC [ ? 1049 h` can switch screens, `ESC [ 2 J` can erase the
frame, and a bare `CR` can rewrite a hint row so the UI lies about which key
does what.

The TUI therefore treats every external byte as display material, never as
terminal protocol. Legitimate application-generated control (framing, cursor,
mouse, images, theme color, the terminal title and the footer's vetted
hyperlinks) is trusted and must survive untouched.

## Authority: one raw source, one disposable projection

| Fact | Authority | Projection |
|---|---|---|
| Job raw bytes, retention proof, exact copy | DSH Host observation / `JobInspectorState` | `sanitizeDisplayLog` on the **body Text only** |
| Transcript message text, classification, persistence | canonical Session/Transcript message | `sanitizeDisplayText` at render construction |
| Rendered row geometry / search hits | the actually painted rows + `JobOutputSearch` | never recomputed from raw bytes |
| Terminal style for **external** log text | the whitelist below | `sanitizeDisplayLog` |
| Plugin install operations, session identities, picker ids | existing controllers / `SessionReader` | display-only string projections |
| TSP frame/currentness | installed SDK + `src/tui/tsp/session.ts` | `sanitizeDisplayText` on node **text props only** |
| Display `/copy` payload | official latest `assistant/message` + same-Session Folder settlement + PR1 publications + `planVisualPlacement` | text spans only; raw Session/`/transcript` keep the marker |

The source of truth — event objects, raw observations, copy payloads, search
source keys, navigation ids, exact-copy offsets and persistence — is **never**
sanitized in place.

`/copy` is a display sink with one deliberate projection of its own: a
published-visual marker line that the renderer CONSUMED is not part of what the
user reads, so the clipboard payload omits that exact source span while every
other byte stays original (see `docs/architecture/transcript.md`, "Display
`/copy` for consumed visual markers"). The durable Session body, the model
history, search and the raw `/transcript` export never take this projection. Rendering is a disposable projection over it: the same raw
value can be copied byte-exactly and also painted safely.

## The two policies

`src/tui/presentation/terminal-text.ts` is the only implementation. It is a
pure linear-time `string -> string` scanner: no cache, no process state, no
side effects, and it returns the exact input string when nothing needs
projection.

### `sanitizeDisplayText(source)` — plain text

Used for prose, labels, Markdown, command arguments, titles, descriptions,
paths, diff line text and tool summaries.

- removes every recognized ANSI/VT sequence: CSI, OSC (including OSC 8), DCS,
  SOS, PM, APC, both 7-bit (`ESC …`) and 8-bit C1 forms, complete or
  unterminated (an unterminated string consumes to end of input);
- removes other ESC-led forms and every remaining C0/C1 control and DEL;
- normalizes `CRLF` to one `LF`, a lone `CR` to one ASCII space;
- converts `TAB` to three spaces;
- preserves `LF`, ordinary Unicode, CJK, emoji and combining marks verbatim;
- never emits raw `ESC`, DEL, C1, OSC, DCS, APC, CSI or any C0 other than `LF`.

### `sanitizeDisplayLog(source)` — untrusted log/terminal text

Used only for captured terminal streams: bash/pwsh tool results, the local
`!`/`!!` shell card, the legacy Job output viewer and the Job workspace body.

- identical control removal, except that **strictly whitelisted complete CSI
  SGR** survives (see below);
- a lone `CR` becomes `LF` so progress frames become readable **records**
  instead of overwriting one screen row (deliberate divergence from PTY
  overwrite semantics; readable history beats exact mutable-screen emulation);
- when at least one SGR survives, an app-owned `ESC[0m` is appended so a
  source-controlled style can never bleed past its display block.

### `sanitizedPhysicalLine(source)` — one physical row

`src/tui/presentation/lines.ts` applies the plain policy and then folds every
surviving `LF` (and any residual `TAB`/`CR`) into one space. It is the required
projection for display slots that are semantically exactly ONE terminal row:
list/panel rows and their labels, badges, secondary text, notices, install log
rows and panel titles; picker item fields (label, group, description, badge /
effort token); one-line headers (tool / command / workflow card heads, Context
row titles, the approval tool name, diff hunk headers); the working message,
dock/todo summary and goal line; the footer's builtin external fields
(model provider/id/effort, cwd, branch, project, agent-preset label, reasoning
effort and host versions) and the welcome card's session facts (cwd, session
id, model, preset, version); and the TSP one-line structured props
(`ui.card.head`, `ui.tool.name`/`title`/`target`, picker `label`/`detail`/
`title`/group labels/subtitle) plus its single-line interaction labels
(approval `tool` identity, question `status`/`header`, option labels). A row
budget, click/hit map or width measurement is built from one array element;
an embedded line break would escape both the row count and the geometry it
indexes.

Multi-line prose, Markdown, code and result/log bodies keep
`sanitizeDisplayText` (or `sanitizeDisplayLog`) and are carried by a component
or node with a real multi-line budget (`Text`, `Markdown`,
`CompactTextPreview`, `ui.md`, `ui.code`, wrapped rows). When a folded terminal
preview is reduced to ONE row, the ORDER is load-bearing:
1. project the FULL source under the log policy first — a lone `CR` is a
   zero-width raw control but a visible record/space after the policy, so
   measuring the raw text would under-count the folded row's width;
2. fold the safe `LF` records into the preview (first records, width-capped);
3. re-project the SHORTENED preview so its app-owned `ESC[0m` reset rides at
   the preview tail (the full-log reset was cut away), then fold any residual
   break. Skipping the first step can widen the row past its budget; skipping
   the third can bleed a styled prefix into the next physical row.
A preview that dropped whole records must end in the hidden-content `…`
marker even when the retained text fits the width (only the exact record
budget is unmarked); a width cut already terminates in the same marker, so
the two causes never double it. A final newline — and a trailing segment that
only carries terminal style, such as the app-owned `ESC[0m` — terminates the
last record and is never itself a hidden record; genuinely blank records
(including a blank line between two newlines) stay records.

## SGR whitelist (log policy only)

Only a complete `ESC [` … `m` with numeric semicolon parameters survives:

- attributes `0,1,2,3,4,7,9,22,23,24,27,29,39,49`;
- standard 8/16-color foreground/background `30–37`, `40–47`, `90–97`,
  `100–107`;
- extended color `38/48;5;n` with `0 <= n <= 255`, or `38/48;2;r;g;b` with
  every channel `0..255`;
- empty `ESC[m` as a reset.

The **whole** SGR is rejected on malformed, unknown, colon, empty or
out-of-range parameters and on missing components. A raw C1 CSI never survives
even when it expresses SGR, so no C1 byte reaches the TTY. OSC 8 hyperlinks
are intentionally **not** part of this policy (the footer command's separate
sanitizer keeps its own vetted OSC 8 contract; that contract is unchanged).

## What is forbidden

- **Never** strip ANSI at the final terminal writer
  (`TuiAltScreen`/`TuiMainScreen.terminal.write`) or in the vendored
  `packages/pi-tui/**` fork. Application framing, color, mouse, image and
  cursor protocols are trusted and share that writer.
- **Never** sanitize the source object, the copy payload, the search source
  key, a navigation id, a picker value or an exact-copy offset. Only the
  painted string is disposable.
- **Never** sanitize an already theme-painted string: that would strip the
  TUI's own trusted color. Project the external part **before** the theme
  applies.
- **Never** add a terminal emulator, PTY, image passthrough or a
  color-preserving parser dependency to solve this.

## Kitty graphics ownership

Inline Kitty graphics are the ONE protocol family with a Client-local
ownership layer in front of the terminal writer: `src/tui/graphics/**` (the
per-physical-terminal `KittyGraphicsCore` plus the `KittyTerminalFacade` both
screens write through). The vendored screens still own their text frames,
scrollback and layout; the Core owns image ids, upload residency, placements,
retirement and the resident budget.

- **One authority for image data.** Only the Core emits a hard
  `a=d,d=I,i=<own id>` retirement. A legacy writer's per-id delete of a managed
  id is layout intent, not ownership: it becomes a scoped placement removal
  (`a=d,d=i,i=<id>`) so the pixels disappear in that frame while the data stays
  resident for a re-show. This holds for the id's whole life, including after
  its occurrence is gone: a per-id delete for ANY id inside the Core's own id
  range is a placement removal, never a data free.
- **Ids are a monotonic range.** The Core hands out a contiguous, forward-only
  id range from a random start in the lower half of the 32-bit space, so (a)
  ownership is decidable in O(1) with no session-long id set, (b) a historical
  id can never be re-used and a new occurrence can never adopt old pixels, and
  (c) the range never wraps — at exhaustion the Core falls back to text rather
  than risk re-use.
- **Foreign owners are untouched.** A per-id delete for an id outside the Core's
  range passes through byte-for-byte (a foreign id that numerically coincides
  with one of the Core's own ids would run the placement-removal part of the
  same request; the plan forbids claiming that probability is zero, and no
  host-side scheme can make it zero without retaining every historical id). A global `a=d,d=A` / `a=d,d=a` (including
  the bare `a=d`, whose `d` specifier defaults to `a`) never reaches the
  terminal; it is translated into the same operations scoped to the buffer that
  emitted it. Kitty keeps the main and the alternate screen's images in
  separate stores, so a leased alternate screen can never cost the main screen
  its data.
- **Painted pixels are terminal-retained.** An occurrence that goes away after
  being painted does not hard-delete its image: the pixels may still be in the
  viewport or the scrollback. The Core drops its own payload copy and keeps the
  id known (never re-used, never deleted by the Core); an upload that never
  reached a placement is released when its OCCURRENCE retires, never merely
  because a screen stopped — a stopped screen does not end its components. The
  main screen's `stop()` never sends `d=I` in either `preserveScreen` mode; the
  alternate screen releases the ids it placed, and only those, on both of its
  global forms (`d=A` and a repaint's `d=a`, the latter as a scoped placement
  removal so a retired-but-visible image cannot leave a ghost).
- **The budget bounds the working set, not the session.** The Core limits the
  payload and decoded footprint it currently manages; it has no cumulative
  image-id quota, because the main screen's scrollback legitimately grows with
  the session and a displayed image may never be refused (nor force-deleted)
  because of how many images came before it.
- **A write is an offer, not an acknowledgement.** A failing `Terminal.write()`
  never leaves the Core believing bytes landed: the images that write touched
  lose their residency and the next placement re-sends them. Queued own-id
  retirements are taken and only committed once the sink accepted them (a
  failed retire write is retried), and a failing cleanup still restores the
  physical terminal before it is reported. An ambiguous placement — the write
  threw after possibly painting — is retained like any other possibly-visible
  image rather than deleted on a guess.
- **Managed commands are quiet and typed.** Transmission is
  `a=t,f=100,i=<id>,q=2` in at most 4096-character chunks and EVERY chunk
  carries `q=2`; a placement anchor is `a=p,i=...,p=...,c=...,r=...,C=1,q=2;`
  (the trailing `;` is what makes the fork's main-screen image-line parser
  track it). The payload is re-sent only after a clear that really invalidated
  it. The facade observes `CSI 2J`, `CSI 3J` and a screen-buffer switch as
  residency invalidations and never rewrites text, OSC 8/52, mouse or keyboard
  modes, or a foreign APC.
- **Admission is narrower than capability.** The Native managed path requires a
  real Kitty terminal directly attached (no multiplexer); Kitty-compatible
  terminals, iTerm2 and unknown terminals keep the legacy `Image`/text fallback,
  and no environment override can force admission. The tmux virtual path is a
  separate strict automatic admission with its own live-server probe (below);
  both paths fail closed.

### tmux virtual backend (strict automatic admission)

This is a second transport, never a second owner: one `KittyGraphicsCore` in
`placementMode: 'tmux-virtual'` behind the same `KittyTerminalFacade`. With
`PI_TUI_TMUX_KITTY_IMAGES` unset, the backend attempts the live-server admission
automatically; the exact value `1` is the equivalent explicit attempt for users
who already configured it, and it never forces admission. `0` and every other
value disable the backend before any admission query runs. `PI_IMAGE_PROTOCOL=none`
remains the global image opt-out and wins over the automatic attempt; the
`0`/`iterm2` protocol values are also refused by this admission. Admission is
always the live server's answer, never the pane's environment.

- **Admission is a live server fact, not pane environment.** The backend asks
  the real tmux server (`show-options … allow-passthrough`, `display-message …
  '#{session_name}'`, `list-clients …`) with fixed argv, no shell, a 500 ms
  timeout and a bounded reply. It requires the pane option to be exactly `all`,
  exactly one attached client whose session is the pane's,
  `client_termname = xterm-kitty` and `client_termtype = kitty[(version)]`.
  Pane environment (`TMUX`, `TMUX_PANE`, `TERM`) is necessary context only:
  inherited `TERM_PROGRAM`/`KITTY_WINDOW_ID` never grant admission, and option
  `on`/`off`, no client, mixed clients, a non-Kitty client, a nested multiplexer
  or any query failure fails closed before image work. The backend never writes
  tmux configuration: `allow-passthrough=all` and the single attached Kitty
  client are user-provided preconditions, and no option is ever set for the
  user.
- **Revocation is one-way.** Any real probe failure or change to the six
  identity fields latches the handle revoked for the rest of the process. The
  component then paints the text fallback, and the facade refuses an entire
  managed physical write batch (no DCS and no placeholder cell) once that batch
  carries a managed command, a managed grid row (proved by that row's own
  provenance marker, never by its bytes), or a retirement; the refusal also
  latches the remaining physical chunks of that synchronised frame, because the
  fork writer keeps flushing the same frame after the app boundary swallows the
  refusal. Every managed physical batch re-probes immediately before its own
  write (a retirement batch and the frame that follows it are two batches, not
  one admission decision). A queued
  never-placed retirement is dropped locally instead of being sent to a possibly
  different client (the abandoned upload is invisible and is never reused); a
  text-only fallback frame is still writable. There is no hot client migration: re-enabling requires a new TUI
  process. A component render may answer from a real probe at
  most 250 ms old, while every managed physical write batch re-probes; a
  cross-process change is therefore caught before the next managed batch, never
  atomically.
- **One outer namespace, one residency slot.** A Kitty virtual placement is an
  invisible prototype attached to ordinary text cells, so `main` and `alt`
  share the one outer image namespace. A `?1049h`/`?1049l` switch only updates
  the screen fact; a real `2J`/`3J` clear (or a failed write) invalidates the
  slot, and the next placement re-transmits before its grid.
- **Text owns visibility; the wire never hard-deletes by layout.** In this
  mode, a writer-issued per-id delete of a managed id is the frame saying those
  cells are gone, so it emits nothing — erased placeholder cells are what
  removes the image. Global `d=A`/`d=a` (including bare `a=d`) never reach the
  outer terminal either. Only an occurrence that was never placed retires with
  the Core's own `d=I`; a painted occurrence stays terminal-retained (payload
  released, id never re-used), exactly like Native.
- **Every managed command gets its own passthrough DCS.** Each transmission
  chunk, the `a=p,U=1` placement and each Core retirement is wrapped separately
  as `DCS tmux;` with every inner ESC doubled. Text, SGR, OSC 8/52, mouse and
  cursor sequences and foreign per-id commands stay byte-for-byte. The
  placeholder grid is real text cells: `U+10EEEE` + row + column +
  most-significant-image-id-byte diacritics, foreground = low 24 id bits,
  underline = low 24 placement bits, explicit `39;59m` per row. Image ids keep
  the full 32-bit value (the upper byte is a diacritic, never truncated), and
  each grid axis is bounded by the 297-entry diacritic table before encoding.
- **First visible frame survives vertical clipping.** If a managed image's
  first row is already above the viewport when it is first painted, the layout
  engine prefixes the exact existing `a=p,U=1` sequence to the first actually
  visible placeholder row of the same image block (current-frame source and clip
  only; at most the 297-row component bound is inspected). A zero-width private
  provenance marker, created only from the live Core handle and stripped before
  every real terminal write, identifies the managed anchor; the layout also
  requires the marker/anchor/cell identity to agree. It never synthesizes an
  id/geometry, never emits one anchor per row, never relocates an unmarked
  foreign virtual image, and leaves visible-anchor, Native and text output
  unchanged. Authority: `src/tui/graphics/tmux-image.ts`,
  `src/tui/graphics/kitty-terminal.ts`, `src/layout.ts` +
  `src/terminal-image.ts` (vendored divergence X067); proof:
  `packages/pi-tui/test/layout.test.ts` plus the real-Screen first-middle and
  foreign-negative cases in `test/integration/kitty-tmux-screen.test.ts`.
- **Grid provenance is per row; content is never proof.** Every managed grid row
  carries its own zero-width private marker (`\x1b_pi:tmux-grid:v1…`); the anchor
  row carries it immediately AFTER its `a=p,U=1` command so the fork's anchor
  parser still reads the command first. The facade strips exactly that private
  sequence from the wire and treats a row as managed only when its own marker was
  seen, or when the previous physical write cut the same row mid-line. This is
  independent of frame shape: a full main-screen frame, a 1 MiB chunk cut inside
  a row, and an `alt` differential frame that rewrites one non-anchor row with
  absolute addressing all prove provenance from the row itself. A text line that
  merely contains `U+10EEEE`, or even a full placeholder cell's characters, is
  ordinary text and stays writable on a revoked handle. The gate never reserves
  or strips a byte that could come from caller data (`0x01` and every other raw
  terminal byte pass through unchanged on both transports); only the exact
  private marker sequence is removed. Because the marker is zero-width
  (`visibleWidth` strips APC), it never changes layout, clipping or diffing.
  Authority: `src/tui/graphics/tmux-image.ts`,
  `src/tui/graphics/kitty-terminal.ts`; proof: the per-row split, ALT-diff,
  plain-text and raw-byte regressions in
  `test/integration/kitty-tmux-screen.test.ts`.
- **No metadata shortcut.** The virtual component does not register the fork's
  Native placement metadata: its clipping is cell clipping by the real text
  layout, not a source-pixel crop of a cursor-positioned rectangle.

Proof: `test/tui/tmux-kitty-admission.test.ts`,
`test/tui/kitty-tmux-virtual.test.ts`,
`test/integration/kitty-tmux-screen.test.ts`, plus the Native and virtual halves
of `test/tui/kitty-graphics-owner.test.ts` and the geometry parity in
`test/tui/kitty-native-protocol.test.ts`.

## Specialized contracts that stay as they are

These own their own policy and are guarded by negative-control regression
tests, not converted to the log policy:

- `src/tui/footer/ansi-sanitize.ts` — the user-configured footer command may
  style its output (SGR + vetted OSC 8).
- `src/tui/terminal/title.ts` — the terminal title projection.
- `src/tui/components/source-text-layout.ts` + the History / Job Command
  readers — offset-aware exact-source rendering and copy.
- extension `slot-outlet` spans — the extension boundary owns its presentation.

## TSP opt-in parity

The experimental Tern renderer (`DSH_PI_TUI_RENDERER=tsp`, off by default) maps
the same transcript structure onto SDK nodes. Multi-line node content
(`ui.text` bodies, `ui.md`, `ui.code`, `ui.badge`) uses `sanitizeDisplayText`;
one-line structured props (`ui.card.head`, `ui.tool.name`/`title`/`target`,
picker `label`/`detail`/`title`, group labels and `subtitle`) and the
single-line interaction labels (approval `tool` identity, question
`status`/`header`, option labels) use `sanitizedPhysicalLine`; the approval
reason/arguments, question body/detail and option descriptions keep the
multi-line plain policy. The tool's canonical `TranscriptMessage.name` and the
`SessionEvent` payload stay raw for tool semantics; only the displayed
`ui.tool.name` is projected. Raw ids, node keys, answer values, action/event
identifiers, SDK frames and currentness are untouched, so source/GUI evidence
tiers are unchanged. A structural node check proves the payload is safe; it
does not prove the closed-source Tern client's own rendering — that requires
version-qualified real-pane evidence before it may be claimed.

## Terminal title (OSC 0) and terminal-local cwd (OSC 7)

OSC 0 (window title, Session identity) and OSC 7 (terminal-local cwd) are
DISTINCT authorities. The title source order is fixed:

```text
1. session title non-empty                    -> dsh · <sanitized session title>
2. session identity WITH an official cwd      -> dsh · <shortCwd(official session cwd)>
                                                 (Direct and Remote alike)
3. session identity WITHOUT an official cwd   -> dsh
                                                 (never the Client launch cwd)
4. no session identity (sessionless, either   -> dsh · <shortCwd(Client launch cwd)>
   backend)
5. a Remote Host cwd may be shown as OSC 0 identity, but is never published as
   the OSC 7 terminal-local cwd
```

Step 3 is the negative control that separates identity from the OSC 7 fallback:
a session that exists but has no official cwd names itself with the bare brand,
never with the local directory. Step 4 is legal on both branches — with no
session identity there is no Host workspace to impersonate.

The seam is `updateTerminalTitle({ sessionTitle, cwd: sessionCwdFact() })`; the
cwd source is never re-chosen in the terminal adapter. Authority:
`src/app/surface/status-runtime.ts`, `src/tui/terminal/title.ts`. Proof:
`test/app/tern-terminal.test.ts` (fact/observable matrix) and
`test/tui/terminal-title.test.ts` (connected OSC 0 proof).

## Test matrix and repro

| Contract | Test owner | What it proves |
|---|---|---|
| projection semantics (whitelist, CR/TAB, incomplete sequences, 1 MiB bound) | `test/tui/terminal-display-sanitize.test.ts` | pure `string -> string` behaviour |
| untrusted transcript bytes on the wire | `test/domain/rendering.test.ts` | Full/Compact/Focus, every message class, raw source unchanged, one-row command/tool/Activity identities |
| Job body / search / copy | `test/app/job-inspector-workspace.test.ts`, `test/app/job-output-interaction.test.ts`, `test/app/job-workspace-visual.test.ts` | hostile output, CR records, Find on the painted row, byte-exact copy |
| local `!` shell log | `test/tui/local-shell-card.test.ts` | whitelisted SGR only, CR frames readable |
| sibling surfaces | `test/domain/approval.test.ts`, `test/app/plugin-manager-classify.test.ts`, `test/app/plugin-manager-install.test.ts`, `test/tui/model-picker.test.ts`, `test/integration/job-output-viewer.test.ts`, `test/app/session-picker-content-search.test.ts` | no fake hint row via CR, no OSC in chrome, LF/CRLF/TAB/OSC folded onto ONE row per single-line field |
| builtin footer + welcome chrome | `test/domain/footer-display-safety.test.ts`, `test/domain/rendering.test.ts` | hostile cwd/model/branch/project/preset/version rendered through the REAL default footer and welcome card: one physical row each, no OSC/C1 at the TTY, raw workspace authority untouched |
| TSP interaction labels | `test/app/tern-tsp-interaction.test.ts` | approval tool identity / question header / option labels carry no LF or control in their SDK props; question body/detail and option descriptions stay multi-line |
| negative controls | `test/tui/footer-ansi-sanitize.test.ts`, `test/tui/terminal-title.test.ts`, `test/client/history-panel.test.ts` | the specialized contracts above still work |

Minimal reproduction:

```ts
import { sanitizeDisplayLog, sanitizeDisplayText } from './src/tui/presentation/terminal-text.ts'

sanitizeDisplayText('\u001b]52;c;YXR0YWNr\u0007ok\u001b[2J')  // 'ok'
sanitizeDisplayLog('start\r10%\r100%\n')                     // 'start\n10%\n100%\n'
sanitizeDisplayLog('a\u001b[38;5;196mred\u001b[0m')          // keeps the SGR, ends with ESC[0m
sanitizeDisplayLog('a\u001b[38;2;999;1;1mb')                  // 'ab' (malformed SGR dropped whole)
```

Wire assertions must assert that the malicious **specific** sequences are
absent and that the only surviving SGR are whitelisted — never that the stream
contains zero `ESC`, because application-owned cursor, rendering, color, input
and protocol controls legitimately use it.

## Attachment placeholder projection

Attachment placeholders exist only in the DISPLAY projection:
`textWithAttachmentMarkers(blocks)` keeps text blocks verbatim and inserts
`🖼️ name` / `📄 name` at each block's position with exactly one separating
space (never doubling a user-typed space). For text-only content it equals
`textOf`. The projection feeds the user-message flat text, the search corpus and
the bubble/loader-less fallback.

Authority: `src/domain/transcript/content-blocks.ts` (re-exported by
`src/transcript.ts`), consumed by `TuiApp`.

Must-not: mutate the source `ContentBlock`s or an assistant/tool `textOf`; let
search miss the image identity; let a loader-less host drop the image; treat the
marker as a second persisted representation.

Proof: `test/client/image-transcript.test.ts`, `test/client/folding.test.ts`,
`test/app/queue-notices.test.ts`.

## Surface-specific projection

The generic policies above are the only sanitizers. Two surface-specific
applications are load-bearing:

- **Task Browser.** Every dynamic Task Browser field (list/detail/parent/mode/
  status/access/Stop confirmation, header, stale banner, no-match text) goes
  through `sanitizedPhysicalLine` BEFORE width/theme. The one app transient
  notice line does the same for Stop/interrupt/delivery-error text. Stored
  notices and business DTOs stay raw. The Job workspace keeps its own
  `chromeText()` projection. The Search row is user/query text and is outside
  this boundary. Never sanitize after theme styling, never sanitize the copy
  payload/DTO, and do not add a second single-line helper.
  Proof: `test/app/task-browser-text-safety.test.ts`,
  `test/app/task-center-refactor.test.ts`.
- **Job Command / Output copy.** Output Copy sends the captured
  `JobObservedSnapshot.text` verbatim; Command Copy All sends the original
  `label` byte-exact (whitespace/TAB/CRLF/trailing newline survive); drag sends
  `label.slice(start, end)`. Every chrome field strips complete CSI/OSC/APC/DCS
  and drops C0/C1/DEL before styling. Official bytes and copy payloads are never
  rewritten, and no payload is inferred from painted/truncated text. `Copy sent`
  proves emission only, never an OS-clipboard receipt. Authority:
  `src/tui/components/source-text-layout.ts`, `JobCommandDocument`/`Reader`,
  `ClientActions.copySelection`. Proof: `test/app/job-workspace-visual.test.ts`
  ("the Command page owns the EXACT selection copy", "copies only the original
  label").
