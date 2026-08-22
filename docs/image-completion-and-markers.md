# Image completion and markers: `/image` path completion, the `🖼️` marker, flat-text image placeholders

Three consumer-side fixes on the image pipeline (branch `feat/image-pipeline`).
Every change lives in the root bundle — the vendored fork stays pristine
(AGENTS.md decision 8).

## 1. `/image <path>`: natural + Tab completion

### Why

The fork's `CombinedAutocompleteProvider` short-circuits on any
`/command <arg>` line: the command branch runs only when the command has
`getArgumentCompletions`; without it, the branch returns `null` and the path
branch never runs. So natural typing (`/image sh` letter by letter) showed
nothing. Tab had two more gaps:

- `shouldTriggerFileCompletion` (fork autocomplete.ts) trims BOTH ends of the
  line, so `/image ` (trailing space, empty argument) reads as a bare command
  name → Tab is silently blocked. A non-empty prefix (`/image sh`) worked,
  because `force: true` skips the command branch and falls into the forced
  path extraction.
- Tab-accepting a directory (`subdir/`) never showed its children: the
  editor's natural trigger fires only on letters, and the host's reopen
  logic (`TuiEditor.reopenAutocompleteAfterInput`) only covered `@dir/`.

### Design

- **Attach the fork's own extension point**: `SlashCommand.getArgumentCompletions`
  is a first-class fork hook (autocomplete.ts). The `/image` completion entry
  (installed by `installCompletions` in commands.ts, gated by the
  `PATH_ARGUMENT_COMMANDS` set) carries it, backed by `suggestPathArgument`
  (mentions.ts). The session cwd is read at CALL time, so a session switch
  mid-edit stays correct.
- **`suggestPathArgument(argumentText, cwd)`** is shell-style and
  directory-local (the fd whole-tree fuzzy search stays `@`'s job). It
  resolves `~`, absolute and relative forms, and mirrors the fork's
  `getFileSuggestions` display rules so a completed value always reads like
  what the user typed (`./`, `~/` and `dir/` forms preserved, spaces quoted,
  directories first with a trailing `/`).
- **Tab on an empty argument**: `MentionProvider.shouldTriggerFileCompletion`
  overrides the fork's trim quirk — a slash-command line WITH an argument
  position (space present after `trimStart`, even trailing) is a
  file-completion site. A pure command name (`/image`, no space) stays
  command-name completion.
- **Directory continuation**: `TuiEditor.reopenAutocompleteAfterInput` now
  re-triggers for `/cmd <dir>/` path arguments too (same shape as the
  `@dir/` reopen), so Tab-accepting a directory immediately shows its
  children. Plain prose paths (`see /tmp/`) are untouched.

### Accepted limitations

- Multi-word arguments (embedded spaces inside one argument) do not complete:
  the fork's argument apply replaces the WHOLE argument range with the item
  value, so completing a later word would clobber the earlier ones. Quoted
  arguments are deferred with them.

### Extension compatibility

Host-owned slash-command completion; the plugin autocomplete chain
(`AutocompleteRegistry`) is still consulted only after the host provider
returns `null` — no semantic change to the M5 contract.

## 2. The `🖼` marker carries U+FE0F (`🖼️`)

### Why

The space after the emoji was always present in every marker site
(`🖼 dsh-pi-tui.png · 1490×1284 · 392.2 KiB`); the overlap was a width-math
mismatch. U+1F5BC has NO default emoji presentation, so the fork's width
measurement (`get-east-asian-width` via `visibleWidth`) counts it as ONE
cell — but fonts with an emoji face render it TWO cells wide. The glyph
overhang eats the single space and collides with the filename — exactly the
font-dependent "overlap" reported.

### Fix

Every marker site renders `🖼️ ` (U+1F5BC + U+FE0F + space):
`visibleWidth('🖼️ ') === 3` (2 cells + the space), matching what emoji fonts
draw, so both the glyph and the truncation math stay aligned. Sites:

- the transcript thumbnail fallback (`ImageThumbnail.fallbackText`)
- the queue preview (`queueTextOf` in src/index.ts)
- the markdown export (`markdownContent` in src/transcript.ts)

Fonts without an emoji face may show a small gap where the VS16 cell sits;
accepted. Guarded by the `visibleWidth('🖼️ ') === 3` assertion in
test/image-thumbnail.test.ts.

## 3. Mixed user messages keep an inline image placeholder in the flat text

### Why

Submitting expands `[image #N (W×H)]` into ordered `ContentBlock`s, but the
user BUBBLE rendered only the text runs — the thumbnail sat on its own row
between them, so a message read as `❯ 这张图是啥` followed by an image line,
with no trace of the image inside the user's own message. The FLAT text
(`message.text`, built with `textOf`) joined only the text blocks too: the
search overlay matched `'check   done'` — no image identity, no position —
and a loader-less host dropped the image entirely. The queue preview already
had the right convention (`🖼️ shot.png` inline).

### Fix

- `textWithImageMarkers(blocks)` (src/transcript.ts): text blocks verbatim,
  image blocks as an inline `🖼️ name` marker AT their position. A marker
  boundary always carries one separating space — the `/image` insertion
  leaves NO space before the placeholder, so `这张图是啥[image…]` must not
  read as `这张图是啥🖼️ shot.png` — while a space the user already typed is
  never doubled. Identical to `textOf` for text-only content.
- The user-message fold (`TranscriptFolder`, `user/message`) uses it for
  `message.text`, so search finds image-bearing messages by name and no
  consumer ever sees a mixed message reduced to its text alone.
- The transcript BUBBLE renders the marker inline too
  (`TuiApp.renderUserBlocks`): one bubble whose text reads like the draft
  the user submitted (`❯ 这张图是啥 🖼️ shot.png`), with the thumbnails
  following as attachment rows in block order — the bubble carries the
  position, the thumbnail carries the picture. (The earlier ordered layout
  split the text into separate bubbles around each thumbnail, so the bubble
  itself never showed where the image sat.)
- `TuiApp.renderBlockSequence`'s loader-less fallback uses the same
  projection — an image is never silently dropped.
- `textOf` is unchanged: assistant/tool text paths (markdown rendering,
  their search text) are not polluted. Assistant image blocks still render
  via thumbnails; their flat text keeps the old join.

## 4. Fullscreen attachment collapse (click to hide/show the image)

### Why

On image-capable terminals the thumbnail renders the picture itself — but
with no caption, nothing on the row says WHICH attachment it is, and a tall
image monopolizes the transcript. The ask: click the attachment to collapse
the picture back to its identity line, click again to expand. Scope:
**fullscreen only** — the regular surface deliberately stays mouse-free
(fork divergence 25, guarded by tests), so enabling clicks there would need
a fork change AND would suppress terminal-native text selection.

### Design

- **The info bar is CONSTANT.** `ImageThumbnail` renders
  `🖼️ name · W×H · bytes` as its first line in EVERY state — unsupported
  terminals, loading, error, ready, collapsed, expanded. Only the IMAGE
  rows come and go; the identity never disappears, and the collapsed form
  is byte-identical to what non-image terminals already see.
- **Live `collapsedRef` getter.** The host passes
  `() => collapsedImages.has(attachmentId)`; the render cache key carries
  the bit, so a fullscreen click only repaints (no rebuild, no invalidate).
  A collapsed image creates no placement; the fork's differential renderer
  deletes the previous frame's vanished kitty tile automatically (the alt
  screen's `prepareKittyScreen` eviction path).
- **Hit-testing.** `rebuildMessages` records each attachment's row span
  (message-relative) inside `messageRows` (walking the direct
  `ImageThumbnail` children of the message container). `handleFullscreenClick`
  re-measures the map first (`refreshMessageRows` — a thumbnail that just
  finished loading grew from 1 row to image rows), then attachment rows
  WIN over the message-level card toggle. `toggleAttachmentCollapsed` flips
  the set and rebuilds (fresh heights immediately).
- **Lifecycle.** `collapsedImages` is cleared by `clearSessionOverrides`
  like the card expansion overrides — a session switch never leaks click
  state.

### Re-expand cost

A collapsed image's placement is deleted; re-expanding re-uploads the
base64 (a few hundred KB — the alt screen re-uploads through
`prepareKittyScreen`). Acceptable; a "keep the upload, drop only the
placement" optimization is possible later.

## Guarding tests

- `test/mentions.test.ts` — suggestPathArgument (bare prefix, directory
  continuation, `~`/absolute forms, quoting, single-token gate, provider
  integration through the fork command branch, the Tab gate override).
- `test/tui-editor.test.ts` — headless: `/image sh` natural dropdown, Tab on
  an empty argument lists the cwd, Tab-accepting a directory reopens at its
  children, and the non-mention trailing-slash regression stays closed.
- `test/image-thumbnail.test.ts` — the `🖼️ ` marker + width math; the
  collapsed mode keeps the info bar and drops only the image rows (the
  cache key flips with the getter).
- `test/image-collapse.test.ts` — fullscreen: click collapses the image
  rows (the NEXT message moves up), a second click re-expands, one
  attachment's collapse never touches the other, and
  `clearSessionOverrides` re-expands (session-scoped state).
- `test/image-transcript.test.ts` — the fold's flat text interleaves
  `🖼️ shot.png` between the text runs.
- `test/queue-notices.test.ts`, `test/folding.test.ts` — the updated marker
  in queue rows and the markdown export.
