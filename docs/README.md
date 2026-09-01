# dsh-pi-tui documentation

This directory is the home for everything that needs more than a paragraph:
design rationale, hard-won contracts, operational procedures, and measured
data. The root `AGENTS.md` stays the *operating manual* — it summarizes the
rules here and points at the details, so a contributor who reads one file
knows where the rest lives.

## Map

| File | Audience | What it records |
|---|---|---|
| `architecture.md` | contributors | Which module owns which state, and the planned extraction order for the runner's remaining responsibilities |
| `concurrency.md` | contributors | Why dsh sessions cannot be shared across processes; the open-time session lock (`owner.lock`, pid/starttime stale takeover), the process lease and the cooling verifier, which enforce it |
| `failure-model.md` | contributors | The async failure & cancellation contract (`runDetached` / `runOwned`, error observation, lifecycle roots) — the rules that prevent unhandled rejections and misclassified cancellations |
| `input-history.md` | contributors | Per-cwd input history: why it left the settings document, the JSONL file design (v1/v2 rows, read-only load, recall vs. persistence), the recall-order contract, the session-first editor recall scope (↑/↓ session-projected, Ctrl+R broader), the Ctrl+R search panel (scope/detail/accept semantics), and the migration path |
| `surface-decisions.md` | contributors | Plain-`exit` quitting, background-subagent notices in the queue pane, the /login credential-target resolution, the Web-parity tool-card rendering rules (web cards, structured rawInput, plan content), the mode-aware subagent viewer contract (continuable = interactive follow-up editor, one-shot = read-only; the single `ctx.subagents.followup` write path, per-child drafts, the child-owned footer while viewing), the durable hierarchical task browser (`listDescendants`, stable pre-order, done-one-shot reachability, nested read-only authority), the surface-adaptive Focus disclosure (regular Ctrl+O master with full-reveal, fullscreen Ctrl+O Thought-ROOT bulk — expand recent / collapse all — plus nearest-owner mouse disclosure including the internal blank-row collapse, the unified Thinking detail model — compact by default, Alt+T bulk toggle, per-card click overrides), the selected-row marquee, and the local-shell display policy (5/20 preview rows, Ctrl+O master outside fullscreen Focus, Alt+K dismiss) |
| `input-and-card-polish.md` | contributors | The `!`/`!!` compgen completion bridge, the local-shell sandbox `/settings` row (default bypass), the `ask_user_question` answers card (folded summary + expanded answer lines), the goal cards (`get_goal`/`create_goal`/`update_goal` folded summary + field lines), the fullscreen todo-dock click mapping, and the web-parity JSON folded-preview audit (schedule/cordis-inspect/ralph) |
| `transcript-gutter.md` | contributors | The transcript right-gutter width contract (2 cells at the terminal's right edge, transcript surface only): the measurement==render invariant every geometry path must hold, the folded-row truncation rule, and the narrow-terminal test conventions |
| `image-completion-and-markers.md` | contributors | The `/image <path>` completion design (the fork's `getArgumentCompletions` extension point, the `shouldTriggerFileCompletion` trim quirk, directory reopen), the `🖼️` U+FE0F marker rationale (1-cell math vs 2-cell emoji fonts), the flat-text image placeholder for mixed user messages, and the fullscreen attachment collapse (constant info bar + click to hide/show the image rows) |
| `repair-session.md` | ops | `scripts/repair-session.mjs`: damage classes, the zstd frame-layout constraint, and the failure modes that broke real logs |
| `releasing.md` | ops | The version bump, bilingual changelog/README update, verification gates, local commit/tag, explicit push approval, and CI publication checklist |
| `local-development.md` | ops | The main/next worktree policy, npm/source DSH modes, read-only doctor, cached source bootstrap, and environment safety rules |
| `surface-catalog.md` | contributors | The surface catalog design: resume prefetch + standing-scope cold skills; why composition probes are REMOVED (host `session/created` observers write durable knob events) and the standing-key path that replaces them; the coordinator invariants that keep snapshots detached and first submissions correctly routed |
| `client-server-migration.md` | contributors | The server/client migration source of truth: phase status (M0–M8), backend default, rollback state, hard invariants, known blockers, startup constraint |
| `dsh-compatibility.md` | users/contributors | The DSH 0.3/0.4 runtime boundary, target version window, old-runtime recovery, and legacy session/preset data compatibility |
| `dsh-source-build-debugging.md` | contributors | The local DSH checkout build order, source-artifact linking, unpublished-version traps, duplicate `dsh-scope` diagnosis, and target-profile validation sequence |
| `client-server-coupling.md` | contributors | The migration coupling allowlist: the (file, pattern) baseline enforced by `scripts/client-boundary-gate.mjs`, the four categories (DIRECT_HOST_REQUIRED / MIGRATABLE / CLIENT_LOCAL / TEMPORARY_EXCEPTION), and the locality rules for new features |
| `perf-baseline.md` | contributors | Measured rendering performance before/after the incremental read grouping + render-cache optimization, and how to re-run it |
| `tmux-testing.md` | contributors | When to test in tmux instead of headless, the manual verification flows, and every trap hit while real-testing |
| `footer-customization.md` | users | User guide for `/footer`: builtin items and styles, Custom Text, trusted Custom Command Items, whole-footer commands, extension items, responsive behavior, raw settings reference, and troubleshooting |
| `extension-api.md` | plugin authors | The extension API v1 author guide: import rules, the surface table, lifecycle/render contracts, deprecation policy, stability |
| `extension-advanced.md` | plugin authors | The ADVANCED tier author guide (Phase 2/4): normalized input capture, focused interactive surfaces, advanced editor control, the imperative UI broker, custom UI and the host-state facade — the Host-mediated contract and the capture ladder position |
| `extension-capability-matrix.md` | plugin authors | The Pi capability reference: Pi capability → dsh equivalent → tier → status (roadmap, not a hash gate) |
| `plugin-authoring.md` | plugin authors | The "which tier should I use?" decision tree and the authoring checklist |
| `extension-unstable.md` | plugin authors | The UNSTABLE tier author guide (Phase 3): raw input interception, exclusive raw ownership, the emergency fail-safe, the low-level surface seam — NO compatibility guarantee |
| `keybinding-architecture.md` | contributors | The user-orchestrable keybinding design: the semantic action inventory (`app.*`), the context-aware effective keymap, the input ladder, the leader (M6) machinery, user configuration, and the static gate |
| `extension-tiers.md` | plugin authors | The three-tier contract table and the current tier status (`ADVANCED_API_LEVEL` / `UNSTABLE_API_LEVEL`) |
| `tmux/` | — | Helper scripts (`ansi2html.mjs`, `tui-demo.sh`) with their own tests |
| `dsh-pi-tui.png` | — | Screenshot used by the root README |

Other documentation, and why it is not here:

- Root `CHANGELOG.md` — the 简体中文 release history, maintained on every
  release per the hard rule in `AGENTS.md` (Keep a Changelog 1.1.0 format),
  with `CHANGELOG.en.md` kept in sync as the English version.
- Root `AGENTS.md` — the contributor operating manual: naming, layout, key
  decisions, development loop, traps, and pointers into this directory.
- `packages/pi-tui/AGENTS.md` — the vendored fork's divergence ledger: every
  local fix with its guarding tests. It is the source of record for re-vendor
  verification and intentionally lives with the fork.
- `packages/pi-tui/UPSTREAM.json` — the single source of truth for the
  vendored upstream version/commit (deliberately not copied into any other
  doc; the fork's `package.json` `repository.note` defers to it).
- `README.md` — the repository root is the published package, so the root
  README is the npm page (user-facing install instructions).
- `.agents/AGENTS.md` — private, gitignored environment handbook for this
  machine only; never commit it.

## How these docs evolve

The point of this documentation is to keep knowledge that was expensive to
gain: **human decisions** (why something is done this way) and **traps** that
only surfaced after repeated testing. When you change behavior:

- Record the decision and its rationale at the same time as the code, in the
  doc that owns the topic. A fix without a recorded reason is a trap waiting
  to be re-introduced.
- Write the rule and the *why* — not a walkthrough of the implementation.
  If the reader needs the code's line-by-line behavior, the code and its
  tests are the reference; the doc should say why the behavior is the way it
  is and what must not be broken.
- Keep a new fact in exactly one place. If a doc needs to reference it,
  link, don't copy — stale copies are how this directory got messy.
- English only, unless the user explicitly asks otherwise.
