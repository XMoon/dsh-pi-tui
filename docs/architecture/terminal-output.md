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

## Image protocol preference (`PI_IMAGE_PROTOCOL`)

`PI_IMAGE_PROTOCOL` is the ONE Client-local startup preference for inline image
pixels. `src/tui/graphics/image-protocol-preference.ts` parses it once per
application/renderer lifetime; it is a protocol SELECTION, never a capability.
The real transport admission described below still decides whether the selected
family can actually paint.

| Value (trimmed, case-insensitive) | Meaning |
|---|---|
| unset / empty / `auto` | Existing automatic order: Direct/Zellij keep `Kitty > SIXEL > text`; tmux keeps its live U1/Sxl relative order. |
| `kitty` | Only an admitted Kitty transport; no SIXEL or iTerm2 fallback. |
| `sixel` | Only an admitted SIXEL transport; a static Kitty/iTerm2 detection cannot satisfy it. |
| `iterm2` | Only the Direct legacy OSC 1337 path; multiplexer panes paint text. |
| `none` / `0` | Hard off for every renderer's image pixels; attachment input, persistence and model input are unchanged. |
| Any other value | A startup configuration error that names the variable, the actual value and the allowed values. |

Only `auto` applies the strict local Zellij + Windows Terminal compatibility
rule: a Kitty `a=q OK` is treated as the known startup false positive only when
`ZELLIJ` is a non-empty session marker, `TMUX` and `STY` are empty,
`WT_SESSION` is non-empty, `TERM_PROGRAM` is absent/empty or exactly
`windows_terminal` (lowercased), no SSH marker is set, no conflicting
Kitty/Ghostty/WezTerm/iTerm/Warp marker or `TERM` identity is present, and the
preference is `auto`. The filter only discards Kitty's startup answer: SIXEL is
still selected solely from the pane's DA1 attribute `4`, the local Zellij
`>= 0.45.0` gate and Screen readiness; otherwise the pane paints text. Every
other automatic environment keeps the existing order. An explicit
`kitty`/`sixel`/`iterm2`/`none` always overrides this auto rule.

No preference may bypass a physical gate: Direct SIXEL still requires DA1
attribute `4` plus the Screen's real cell/background facts; Zellij still needs
its one bounded negotiation and version gate; tmux still needs the live single
display client plus `sixel_support=1`/`Sxl` (native) or U1/passthrough (virtual
Kitty); a managed DCS still needs the trusted registry. The experimental TSP
renderer's native `ui.image` path is enabled only for `auto` with the negotiated
`image`+`blobs` capability; explicit values render text-only disabled status,
while `ui.chart`, model attachments and attachment persistence are unaffected.

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
- **Admission follows protocol capability, not a terminal brand.** The Native
  managed path is shared by any Direct terminal whose effective fork
  capability is `images === 'kitty'` (Kitty, Ghostty, WezTerm, Warp, Tern and
  an explicit `PI_IMAGE_PROTOCOL=kitty` override all qualify), attached with
  no multiplexer in between. `TERM` is not an identity fact; a `tmux*`/`screen*`
  value (or `TMUX`/`ZELLIJ`/`STY`, or Herdr) still denies the DIRECT path
  because it is a transport boundary, not a brand policy. `PI_IMAGE_PROTOCOL=none/0`
  is the global hard opt-out, `iterm2` keeps the Direct iTerm2 path, and
  `sixel` never changes this static answer: it denies the Native Kitty factory
  above and is satisfied only by the Direct SIXEL owner's own DA1/Screen facts.
  A non-empty `ZELLIJ` marker makes the process a CANDIDATE: a separate Zellij
  factory creates the same one `KittyGraphicsCore` / `KittyTerminalFacade`
  Native path, sends exactly one per-handle bounded `a=q` query after the real
  input listener is installed, and admits only the matching `OK` from that
  pane. Pending, denied, errored or timed-out admission paints the existing
  text fallback and can never fall back to legacy `a=T`; an empty `ZELLIJ`
  value is not a session marker. A connected Tern TSP renderer keeps its own
  `image`+`blobs` native node path and never mounts a PiTui graphics handle;
  the Tern PiTui fallback uses the same Direct capability above. Every Alt
  Screen derives its image clear/redraw/release strategy from the one managed
  Native handle when that handle exists, even when the static process
  capability is `null` or `iterm2`; without a managed handle the existing
  static protocol (including the iTerm2 suppression/restore lifecycle) is
  unchanged. The tmux virtual path is a separate strict automatic admission
  with its own live-server probe (below). All paths fail closed, and every
  managed path deletes only its own ids.

### tmux virtual backend (strict automatic admission)

This is a second transport, never a second owner: one `KittyGraphicsCore` in
`placementMode: 'tmux-virtual'` behind the same `KittyTerminalFacade`. With
`PI_TUI_TMUX_KITTY_IMAGES` unset, the backend attempts the live-server admission
automatically; the exact value `1` is the equivalent explicit attempt for users
who already configured it, and it never forces admission. `0` and every other
value disable the backend before any admission query runs. `PI_IMAGE_PROTOCOL=none`
remains the global image opt-out and wins over the automatic attempt; the
`0`/`iterm2` protocol values are also refused by this admission. Admission is
always the live server's answer, never the pane's environment. A user may set
`PI_TUI_TMUX_KITTY_PLACEHOLDERS=1` to assert that an older outer terminal really
implements Unicode placeholders despite being unable to answer the feature
query; the assertion replaces only the U1 capability proof and never bypasses
the live server, identity, hard-off or revoke checks.

- **Admission is a live server fact; U1 is a separate capability fact.** The
  backend asks the real tmux server (`show-options … allow-passthrough`,
  `display-message … '#{session_name}'`, `list-clients …`) with fixed argv, no
  shell, a 500 ms timeout and a bounded reply. It requires the pane option to be
  exactly `all` and exactly one ordinary display TTY client whose session is the
  pane's and whose name/tty are non-empty. The live `#{client_control_mode}`
  column is the only control-connection authority: explicit Control Mode
  clients (`1`) may coexist with that one display client, are never counted as
  display clients, and their join, exit or change never revokes the handle.
  A missing or non-`0`/`1` control value, or any malformed record, fails closed.
  An unknown renderer is not rejected at this server
  boundary. The live client report itself may be known pre-feature-query U1
  evidence: a real XTVERSION program of `kitty` or `ghostty` in
  `client_termtype` is sufficient; `client_termname` is only a transport hint
  and may be a generic `xterm-256color` fallback, never an additional brand
  condition. Otherwise the backend sends exactly one per-handle
  DCS-wrapped Kitty `a=q,i=<random>,e=T,U=1` query after the real input listener is
  installed; only a reply with the same id, `e=T`, `U=1` and `OK` admits. A base
  Kitty `a=q` `OK` without `e`/`U` is not U1 evidence, and this transport never
  falls back to ordinary `a=p` or legacy `a=T`. Pending feature state does not
  suspend the live identity check: a client change during probing still latches
  the one-way revoke, and a feature reply is committed only while the bound
  client identity is still current. Pane environment (`TMUX`,
  `TMUX_PANE`, `TERM`) is necessary context only: inherited
  `TERM_PROGRAM`/`KITTY_WINDOW_ID` never grant admission. Option
  `on`/`off`, no ordinary display client, two ordinary display clients, a live
  outer tmux/screen client, a nested multiplexer or any query failure fails
  closed before image work. The
  backend never writes tmux configuration: `allow-passthrough=all` and the
  single ordinary display client are user-provided preconditions, and no option
  is ever set for the user.
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

## SIXEL capability facts and the pixel gate

SIXEL has no image-id residency model, so nothing here is shared with the Kitty
Core. What the Client may rely on is one observed terminal fact and one gate:

- **The primary DA1 is the only capability source for Direct SIXEL.** A terminal
  that paints SIXEL advertises attribute `4` in its primary device-attributes
  reply; the
  graphics-inquiry query is not a reliable substitute (some terminals never
  answer it). `ProcessTerminal` therefore observes a COMPLETE DA1 and exposes it
  through the optional `Terminal.onSixelSupport()` (divergence X071). The
  observation is passive: it issues no query, selects no protocol, and does not
  change the keyboard-negotiation, program-status or color-query sentinels that
  already own those replies. Parameters are matched as whole tokens, so `14` and
  `42` are not SIXEL evidence. The observed answer belongs to the physical
  terminal and survives `stop()`/`start()`; a new instance starts unknown.
- **Admission is a candidate verdict, not permission to paint.**
  `src/tui/graphics/sixel-capability.ts` folds the observation together with the
  environment and the existing legacy capability into
  `pending | admitted | denied`. An explicit `PI_IMAGE_PROTOCOL=none|0`, a
  configured or detected Kitty/iTerm2 terminal, and any multiplexer topology
  deny the candidate outright; no reply stays `pending`, which consumers treat
  as "not paintable". A managed Kitty handle keeps precedence over SIXEL even
  while its own admission is pending or revoked, so a multiplexed pane paints
  text instead of silently switching protocol.
- **Three real facts, one projection, one protocol answer.**
  `src/tui/graphics/sixel-image.ts` is the only Direct SIXEL owner. It paints
  only after the DA1 attribute, the active Screen's real `CSI 6;h;w t` reply and
  the active Screen's real OSC 11 background have all arrived for THAT screen;
  a missing fact is text, never a `9x18` default cell or a guessed background.
  The screen handoff and every terminal resize re-observe those facts, and a
  colour-scheme report re-observes them without changing the binding. Only then
  does `effectiveImageProtocol()` answer `'sixel'` — from the owner's live
  readiness, never from `getCapabilities().images` or `PI_IMAGE_PROTOCOL`.
- **A DCS is a device command, so the Screen must own it.** A SIXEL raster has
  no deletable id: only clearing the whole occupied cell footprint (`CSI 2K` per
  affected row) removes it, and clearing the anchor row alone leaves pixels
  behind. The Screen therefore receives exactly one narrow trust port
  (`SixelScreenPort`, divergence X072): it reports the real footprint of an
  EXACT string the owner encoded, and re-encodes a visible crop from the same
  source at the same scale. A DCS is never parsed for syntax, sliced, truncated,
  reflowed or composited as text; an unregistered one stays ordinary text.
- **The image workspace consumes the same owner.** `ImageWorkspacePanel` keeps
  ONE leased screen for its list/viewer states; its `ImageViewerPanel` and
  `SvgViewerPanel` paint through the SAME `ImageGraphics` handle and
  `SvgRasterLoader` the rest of the surface uses — never a second graphics owner
  or SVG raster pipeline. An SVG thumbnail's clickable body is the Screen's
  last-committed footprint (`paintedBodyAt`), read at hit time; a pending,
  covered, collapsed or revoked occurrence holds no pixels and no hit.
- **Residency follows the physical frame, not component lifetime.** A component
  in SIXEL mode emits an inert candidate marker for its block, never a DCS. The
  Screen collects the blocks its FINAL layout really shows — including a
  bottom-clipped block and an anchor that scrolled above the viewport — and asks
  the owner to reconcile that frame's demands. The owner grants residency within
  its fixed budget (bottom-up: the newest visible content wins), answers
  `materialize()` with the exact DCS only for a granted and ready window, and
  takes no other token→DCS path. After a frame is really written, the Screen
  reports every raster the physical screen still shows (written this frame, or
  kept by the diff); the owner pins those occurrences, releases every other
  retained record, and only then tasks the one encoder lane for granted-but-
  unready blocks, which paint on a later settled frame. A component that merely
  rendered, an occurrence scrolled off screen, and a pending or refused block
  all hold no pixels and no clickable body.
- **A residency decision never rewrites committed scrollback.** On the main
  screen a projected block whose pixels already sit above the viewport is a
  historical fact: a change of residency/materialization for the SAME occurrence
  must be projected onto the previous physical line, not treated as new content.
  Only a real content change (source, fold, deletion, reorder, text, width,
  clear or reset) may become `firstChanged`; a no-write frame keeps the previous
  physical raster set instead of releasing it as an empty one.
- **The erase and the paint order belong to the physical Screen.** The main
  screen (X073) expands its diff to the union of the old and new footprint,
  erases every covered row before any text lands on it, and writes the command
  after every text row of the frame, positioned from the clamped top margin and
  protected by DECSC/DECRC because a DCS's post-command cursor is
  terminal-defined. The alternate screen (X074) re-encodes the visible window
  for a bottom-clipped or top-scrolled block, erases the old footprint, writes
  text/border/overlay/scrollbar first and one command per visible block last. A
  trusted anchor whose registered raster columns do not reach the scrollbar's
  single track column keeps its intact command and only that anchor row loses the
  bar glyph; a real horizontal overlap still yields the column, and an overlay
  that claims the block still withholds it. The image's identity row above the
  body stays text in every case.
- **Untrusted text never becomes SIXEL.** The sanitizers accept no DCS; only a
  codec operating on authorized image bytes may produce a sequence, and only the
  owner's registry can make the Screen treat it as an image.

### Native tmux SIXEL is a separate transport from passthrough

A tmux pane that is compiled with native SIXEL support paints the pane's OWN
SIXEL DCS; it does not need the Kitty passthrough envelope. The two transports
therefore have different authorities and must never be collapsed:

- **Admission is live server + client evidence, never a pane hint.**
  `src/tui/graphics/tmux-sixel-admission.ts` admits only when the live tmux
  server reports `#{sixel_support}=1`, exactly one ordinary display client
  (Control Mode excluded) owns the pane's session with valid name/tty and is
  not a nested multiplexer; `termname`/`termtype` are recorded as optional
  live identity fields and may be empty when the client does not provide
  them, and `show-messages -T -t <exact client>` reports exactly
  one complete `Sxl: (flag) true`. A pane DA1 SIXEL attribute, `TERM_PROGRAM`,
  `WT_SESSION`, `KITTY_WINDOW_ID` or a terminal brand is never proof. The
  binding is immutable for the TUI lifetime; any later mismatch, lost server
  support or lost Sxl revokes the handle one way, and only a restart may choose
  a transport again.
- **The automatic factory order is fixed.** `auto` tries Native Kitty, ONE
  Zellij negotiated handle (Kitty > SIXEL > text), native tmux SIXEL, tmux
  virtual Kitty, then Direct SIXEL. The explicit preferences use only their own
  subset of that order and never create a competing backend: `kitty` never
  admits a SIXEL transport (no Direct SIXEL factory, no native tmux SIXEL, and
  the Zellij handle never considers it); `sixel` never constructs Native Kitty
  or tmux virtual Kitty; `iterm2`/`none` create no managed handle. A live
  known-U1 Kitty/Ghostty tmux client (or the explicit
  `PI_TUI_TMUX_KITTY_PLACEHOLDERS=1` assertion) keeps the virtual transport
  ahead of SIXEL in `auto`; a merely pending unknown-renderer U1 probe does not
  outrank a proven Sxl client. `PI_TUI_TMUX_KITTY_IMAGES=0` disables only the
  virtual Kitty transport and never this native SIXEL route;
  `PI_IMAGE_PROTOCOL=none|0|kitty|iterm2` denies native tmux SIXEL before any
  tmux query, while `sixel` admits only that native SIXEL route (never the
  virtual Kitty one).
- **Writes are trusted complete DCS only.** `src/tui/graphics/tmux-sixel.ts`
  wraps the real `Terminal` and scans the byte stream for the owner's exact
  `ESC P0;1;q … ESC \` DCS. The fork's `BoundedTerminalWriter` can split a
  frame at 1 MiB, so a partial command is held (bounded by the owner's 32 MiB
  registry budget) and never reaches the sink; a complete string is accepted
  only when the owner's exact registry reports its footprint; an unregistered
  complete DCS is a refusal with zero managed bytes, never ordinary text. After
  registry acceptance a forced live admission probe runs BEFORE the first byte.
  A refused command writes zero managed bytes, throws
  `TmuxGraphicsRevokedError`, drops the owner's paintable facts, and the app
  boundary schedules one full text repaint. Ordinary text and
  other ANSI sequences pass through in order; ordinary IO errors propagate
  unchanged. No unwrapped or partially wrapped command ever escapes, and no
  `DCS tmux;` envelope is added.
- **The same SIXEL owner and Screen contract.** `src/tui/graphics/sixel-image.ts`
  keeps ONE encoder, registry, crop path and Screen port for Direct and tmux
  SIXEL; only the admission source and the write gate differ. `graphics.mode`
  stays `'sixel'`, so every media consumer keeps asking
  `effectiveImageProtocol()` and gets `'sixel'` only while the owner can paint.

Proof: `packages/pi-tui/test/terminal.test.ts` (passive DA1 observation),
`test/tui/sixel-capability.test.ts` (production DA1 stream to verdict),
`test/client/sixel-image.test.ts` (three-fact gating, trust registry, crop
variants), `packages/pi-tui/test/tui-cell-size-input.test.ts` (the one cell-size
parser), `packages/pi-tui/test/tui-sixel-main.test.ts` (X073 erase/paint order)
and `packages/pi-tui/test/layout.test.ts` + `tui-alt-screen.test.ts` (X074 crop
and paint order), plus the end-to-end chain in
`test/integration/sixel-direct-screen.test.ts`. The native tmux SIXEL server/
client evidence and the trusted-DCS write gate are guarded by
`test/tui/tmux-sixel-admission.test.ts` and
`test/integration/sixel-tmux-native-screen.test.ts`.

### Zellij native SIXEL is one negotiated pane handle

A Zellij pane inherits the outer terminal's environment, so `TERM_PROGRAM`,
`WT_SESSION`, `getCapabilities().images` and an inherited Kitty capability are
not pane capability proof. The product creates ONE `zellij-negotiated` handle
per app lifetime when `ZELLIJ` is a non-empty session marker with no nested
`TMUX`/`STY`. `PI_IMAGE_PROTOCOL=none`/`0`/`iterm2` creates no Zellij handle;
`sixel` and `kitty` create it with their own single-protocol policy. That
handle owns both the existing Native Kitty Core/Facade and a potential Direct
SIXEL owner; only one of them can ever become paintable.

- **Selection is driven by two live pane facts, exactly once.** In `auto`, the
  existing bounded Kitty `a=q` query (500 ms) answers the pane's Kitty
  transport; the terminal's passive primary DA1 observation
  (`onSixelSupport`, attribute `4`) answers SIXEL. Kitty wins whenever its
  probe returns the matching `OK`, even if DA1 also declares SIXEL, except for
  the strict local Windows Terminal rule described above, where the startup
  `OK` is filtered to `denied`. SIXEL is selected only when Kitty did not
  admit, DA1 declares attribute `4`, and the LOCAL `zellij --version` is
  strictly `>= 0.45.0` (older programs advertised SIXEL unconditionally). No
  answer, a timeout, a missing/malformed version or an ineligible version
  settles to text; DA1 has ONE 800 ms initial bound. Unknown is never treated
  as positive.
- **Explicit protocol values keep one decision path.** `kitty` sends the same
  ONE `a=q` and accepts only a matching `OK`; SIXEL is never eligible. `sixel`
  sends NO Kitty probe at all (`ZellijKittyAdmission.denyWithoutProbe()` commits
  the Kitty branch denied after the coordinator's capability/callback wiring
  exists), creates no Kitty pixel delegate, and still requires the same DA1 +
  local version + Screen readiness; failure is text. Both modes keep the same
  one-way selection and the same bounded re-query/revoke contract.
- **No runtime protocol switching.** Once `kitty` or `sixel` is committed the
  choice never changes. A late Kitty `OK` or DA1 reply is consumed but inert.
  After SIXEL is selected, a later complete DA1 that omits attribute `4`
  permanently revokes SIXEL: the owner drops every registered raster, grant and
  clickable footprint and forces a full text repaint. It never falls back to
  Kitty and never re-enters SIXEL.
- **One write path, one SIXEL owner.** The negotiated handle keeps the existing
  `ZellijKittyTerminal` as the ONLY `Terminal` writer; the potential SIXEL
  branch is `createSixelGraphicsWithAdmission()` over the SAME encoder,
  registry, crop path and `SixelScreenPort` as Direct/native-tmux SIXEL. Every
  Main/Alt/workspace Screen receives that port at construction even while the
  handle is pending; the port's owner refuses all pixels unless SIXEL is
  selected and the three Direct-SIXEL facts (DA1, real cell size, real OSC 11
  background) are complete. `effectiveImageProtocol()` derives
  `'kitty' | 'sixel' | null` from the handle's live selection and `canPaint()`;
  it never falls back to the inherited fork capability for a Zellij pane.
- **Per-source rendering is one lazy delegate.** `ZellijNegotiatedImage`
  renders the caller's fallback until selection, then creates exactly one
  protocol delegate per source: `NativeKittyImage` for Kitty or the SIXEL
  owner's `image()` for SIXEL. It never creates both pixel children and never
  switches after selection.
- **SIXEL re-verifies the pane on ownership changes.** After SIXEL is selected,
  a real terminal resize, screen handoff or external-editor resume sends ONE
  bounded `CSI c` re-query while the app owns the input listener. The reply is
  consumed after `StdinBuffer` framing and before the editor; the capability
  boolean remains the existing `onSixelSupport` observation. Until the
  affirmative reply arrives the surface paints text; a negative reply or the
  800 ms bound revokes SIXEL permanently. There is no per-frame query.
- **Zellij's transparent first band needs a bounded width repair.** The ONE
  SIXEL encoder can emit a first band with no painted pixels when the source's
  top band is fully transparent; Zellij may then infer a zero-width image.
  `src/tui/graphics/zellij-sixel-width.ts` accepts only the production
  encoder's own grammar, verifies the declared raster width, and inserts a
  transparent `!<widthPx>?$` run before the first `-`. It never rewrites an
  arbitrary/external DCS, never duplicates an existing run, and refuses an
  over-budget or unrecognised grammar (the occurrence then paints text). Full
  and crop variants go through the same `admit()` entry, so the registry and
  physical Screen always see the same repaired bytes.
- **A screen constructed before selection keeps the Kitty cleanup protocol.**
  `TuiAltScreen` captures its image protocol at construction. While the
  negotiated handle is pending/denied it therefore uses the legacy Kitty
  lifecycle (it paints no pixels because the consumer gate is `null`); a
  confirmed SIXEL selection uses SIXEL screen semantics. SIXEL clearing itself
  is driven by the independent Screen port, not by this construction-time
  protocol value.

Proof: `test/tui/zellij-image.test.ts`,
`test/tui/zellij-sixel-width.test.ts`,
`test/integration/kitty-zellij-screen.test.ts`,
`test/integration/sixel-zellij-native-screen.test.ts`,
`test/client/sixel-image.test.ts`, plus the existing Direct SIXEL and native
tmux SIXEL suites. Real Zellij GUI/outer-terminal pixels are qualified by the
release protocol smoke, never by a repository-doc claim.

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
