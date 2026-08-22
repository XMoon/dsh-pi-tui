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

Submitting expands `[image #N (W×H)]` into ordered `ContentBlock`s, and the
transcript renders them in order (text → thumbnail → text) whenever the
loader is wired — position was preserved on screen. But the FLAT text
(`message.text`, built with `textOf`) joined only the text blocks: the
search overlay matched `'check   done'` — no image identity, no position —
and a loader-less host rendered mixed messages with the image silently
dropped. The queue preview already had the right convention (`🖼️ shot.png`
inline).

### Fix

- `textWithImageMarkers(blocks)` (src/transcript.ts): text blocks verbatim,
  image blocks as an inline `🖼️ name` marker AT their position. Identical to
  `textOf` for text-only content.
- The user-message fold (`TranscriptFolder`, `user/message`) uses it for
  `message.text`, so search finds image-bearing messages by name and no
  consumer ever sees a mixed message reduced to its text alone.
- `TuiApp.renderBlockSequence`'s loader-less fallback uses the same
  projection — an image is never silently dropped.
- `textOf` is unchanged: assistant/tool text paths (markdown rendering,
  their search text) are not polluted. Assistant image blocks still render
  via thumbnails; their flat text keeps the old join.

## Guarding tests

- `test/mentions.test.ts` — suggestPathArgument (bare prefix, directory
  continuation, `~`/absolute forms, quoting, single-token gate, provider
  integration through the fork command branch, the Tab gate override).
- `test/tui-editor.test.ts` — headless: `/image sh` natural dropdown, Tab on
  an empty argument lists the cwd, Tab-accepting a directory reopens at its
  children, and the non-mention trailing-slash regression stays closed.
- `test/image-thumbnail.test.ts` — the `🖼️ ` marker + width math.
- `test/image-transcript.test.ts` — the fold's flat text interleaves
  `🖼️ shot.png` between the text runs.
- `test/queue-notices.test.ts`, `test/folding.test.ts` — the updated marker
  in queue rows and the markdown export.
