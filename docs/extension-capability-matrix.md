# Pi capability matrix (Phase 4)

The dsh-pi-tui extension platform's capability reference against the Pi
coding-agent extension UI. This table is a **roadmap / compatibility
reference** — NOT a source-hash gate, NOT a promise of Pi source
compatibility. The goal is capability parity: "what a Pi extension can do
commonly, dsh-pi-tui supports at the right tier" — never a line-by-line
Pi API copy.

| Pi capability | dsh equivalent | Tier | Status |
|---|---|---|---|
| `select` | `advanced.ui.select` (imperative selection broker) | Advanced | Phase 4 |
| `confirm` | `advanced.ui.confirm` (imperative confirm broker) | Advanced | Phase 4 |
| `input` | `advanced.ui.input` (imperative free-text broker) | Advanced | Phase 4 |
| `notify` | `advanced.ui.notify` (notification broker) | Advanced | Phase 4 |
| `custom()` | `advanced.ui.custom` (custom interactive UI) | Advanced | Phase 4 |
| `setHeader` / `setFooter` | chrome slots (`register('chrome.header.badge' / 'chrome.footer.status')`) | Stable | M2 |
| configurable footer items | `register('chrome.footer.item')` (configurable, user-orderable footer items) | Stable | M4 |
| `setWidget` | widget slots (`register('input.widget.above' / 'input.widget.below')`) | Stable | M4 |
| `pasteToEditor` | `advanced.editor.pasteToEditor` | Advanced | Phase 2 |
| `setEditorText` | `advanced.editor.setEditorText` | Advanced | Phase 2 |
| `getEditorText` | `advanced.editor.getEditorState` | Advanced | Phase 2 |
| `editor()` | editor replacement (`registerEditor`) | Stable | M9 |
| `addAutocompleteProvider` | autocomplete registry (`registerAutocomplete`) | Stable | M5 |
| `setEditorComponent` / `getEditorComponent` | editor replacement + `advanced.editor` controls | Advanced | Phase 2/4 |
| `theme` / `getAllThemes` / `getTheme` / `setTheme` | theme registry (`registerTheme` + `advanced.host` theme query/select) | Stable/Advanced | M5/Phase 4 |
| `getToolsExpanded` / `setToolsExpanded` | `advanced.host.setToolsExpanded` | Advanced | Phase 4 |
| `setStatus` / `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | `advanced.host.setWorkingMessage` (working override) | Advanced | Phase 4 |
| `setThinkingDetail` | thinking detail (`alt+t` host verb, the unified disclosure model) — no plugin override yet | — | deferred |
| `setTitle` | `advanced.host.setTitle` (title override) | Advanced | Phase 4 |
| `onTerminalInput` | `unstable.input.captureRaw` (raw input interception) | Unstable | Phase 3 |

Tier rules (see `docs/extension-tiers.md`):

- **Stable** — semantic, compatibility-oriented, additive-first.
- **Advanced** — experimental, Host-mediated interactive/high-level
  capabilities; minor releases may break.
- **Unstable** — NO compatibility guarantee; raw/implementation-coupled
  capabilities.

Raw terminal access is ONLY ever Unstable; a capability that needs raw
input or Host-policy bypass never enters Stable or Advanced.
