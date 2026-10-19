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

The source of truth — event objects, raw observations, copy payloads, search
source keys, navigation ids, exact-copy offsets and persistence — is **never**
sanitized in place. Rendering is a disposable projection over it: the same raw
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
dock/todo summary and goal line; and the TSP one-line structured props
(`ui.card.head`, `ui.tool.name`/`title`/`target`, picker `label`/`detail`/
`title`/group labels/subtitle). A row budget, click/hit map or width
measurement is built from one array element; an embedded line break would
escape both the row count and the geometry it indexes.

Multi-line prose, Markdown, code and result/log bodies keep
`sanitizeDisplayText` (or `sanitizeDisplayLog`) and are carried by a component
or node with a real multi-line budget (`Text`, `Markdown`,
`CompactTextPreview`, `ui.md`, `ui.code`, wrapped rows). Folded terminal
previews re-derive their ONE row from the log-projected text, because the log
policy itself turns a lone `CR` into `LF`.

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
picker `label`/`detail`/`title`, group labels and `subtitle`) use
`sanitizedPhysicalLine`. The tool's canonical `TranscriptMessage.name` and the
`SessionEvent` payload stay raw for tool semantics; only the displayed
`ui.tool.name` is projected. Raw ids, node keys, answer values, action/event
identifiers, SDK frames and currentness are untouched, so source/GUI evidence
tiers are unchanged. A structural node check proves the payload is safe; it
does not prove the closed-source Tern client's own rendering — that remains
`NOT_VERIFIED` until a real pinned pane is tested.

## Test matrix and repro

| Contract | Test owner | What it proves |
|---|---|---|
| projection semantics (whitelist, CR/TAB, incomplete sequences, 1 MiB bound) | `test/terminal-display-sanitize.test.ts` | pure `string -> string` behaviour |
| untrusted transcript bytes on the wire | `test/rendering.test.ts` | Full/Compact/Focus, every message class, raw source unchanged, one-row command/tool/Activity identities |
| Job body / search / copy | `test/job-inspector-workspace.test.ts`, `test/job-output-interaction.test.ts`, `test/job-workspace-visual.test.ts` | hostile output, CR records, Find on the painted row, byte-exact copy |
| local `!` shell log | `test/local-shell-card.test.ts` | whitelisted SGR only, CR frames readable |
| sibling surfaces | `test/approval.test.ts`, `test/plugin-manager-panel.test.ts`, `test/plugin-manager-install.test.ts`, `test/model-picker.test.ts`, `test/job-output-viewer.test.ts`, `test/session-picker-content-search.test.ts` | no fake hint row via CR, no OSC in chrome, LF/CRLF/TAB/OSC folded onto ONE row per single-line field |
| negative controls | `test/footer-ansi-sanitize.test.ts`, `test/terminal-title.test.ts`, `test/history-panel.test.ts` | the specialized contracts above still work |

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
