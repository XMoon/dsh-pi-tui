# Example plugins (Phase 5)

The Phase-5 example plugins validate the tiered extension architecture
with REAL consumers — they consume ONLY the public package exports,
exactly like external packages (gated by
`scripts/examples-plugin-smoke.mjs` against the packed tarball).

| Plugin | Tier usage | Validates |
|---|---|---|
| `vim/` | Advanced (editor SDK) | A production-class modal editor prototype: insert/normal modes, h/j/k/l, word movement, x/d/c, i/a/o, undo/redo, yank/paste, multi-line, cursor sync, submit integration — all through semantic `EditorInputEvent`s, never raw bytes. |
| `questionnaire/` | Advanced (imperative UI broker) | A multi-step form: select → free text → confirm → notify, built on the Host's own picker/question/notify infrastructure. |
| `interactive-shell/` | Unstable (raw seam) | A terminal-native interactive surface: exclusive raw input ownership + a raw-rendering low-level mount; `exit` or the Host emergency fail-safe (triple-Esc) returns to the Host. |

## Running the examples

The examples are Cordis plugins: install the packed bundle into a dsh
profile, add the example package, and use the registered commands
(`/questionnaire`, `/shell`) or the vim editor (it wins the editor seat
by priority).

## The API gap process (plan §8)

Every gap found while building the examples is recorded here with its
tier decision:

| Plugin requirement | Current tier | Why the existing API was insufficient | Proposed tier | Smallest new capability |
|---|---|---|---|---|
| Live repaint of a plugin editor's buffer | Advanced | `ExtensionEditor.component` is `readonly` — a live editor cannot swap its rendered view without mutating a readonly-typed object. | Advanced | The GETTER pattern (the plugin returns `get component()`) is the clean live-repaint path — no API change needed; documented in the vim example. |
| Close notification on a low-level mount | Unstable | `UnstableMountLease` has no close event — the shell example polls `lease.active` to detect exit. | Unstable | A close/onClose notification on the mount lease (candidate for the next Unstable iteration). |
| Multi-line prompt editor | Advanced | The imperative `input` broker is single-line (the Host's question free-text row). | Advanced | A multi-line prompt editor (candidate; the vim example proves the editor seam can host one). |
| j/k desired-column preservation | Advanced | `VimState.move` clamps the column to the target line's last char — moving to a shorter line and back loses the column (a production vim tracks `desiredCol` separately). | Advanced | Track a desired column separately from the cursor column (candidate; demo-grade prototype limitation, not blocking). |
| b with leading whitespace | Advanced | `moveWord(false)` from the first word of a line that begins with whitespace stops at col 0 instead of the previous line's last word. | Advanced | Handle the leading-whitespace case in the cross-line branch (candidate; demo-grade prototype limitation, not blocking). |

## Stable promotion review (plan §9)

Candidates evaluated after real use:

- **`advanced.editor` controls** (get/set/cursor/insert/paste/focus):
  used by the vim example (via the seat) and the questionnaire flow.
  NOT promoted: the semantics are still experimental (the seat's flat
  cursor shape is implementation-coupled); keep Advanced.
- **`advanced.ui.notify`**: semantically mature, but only one consumer
  so far; keep Advanced until a second independent consumer exists.
- Nothing else meets the promotion bar (≥2 independent consumers,
  lifecycle-tested, no raw terminal, no Host-policy bypass).

## Failure recovery (plan §13)

The examples exercise the recovery paths:

- a throwing vim `handleInput` is isolated by the seat (the host keeps
  working — guarded by the editor-registry tests);
- a throwing questionnaire handler returns an error result (the command
  bridge's error path);
- the shell's exclusive capture fails open on a throw (the unstable
  registry's fail-open rule);
- owner unload disposes every example resource (the fiber-ownership
  tests);
- the Host emergency fail-safe releases the shell's exclusive capture
  and closes its mount (the unstable fail-safe tests).
