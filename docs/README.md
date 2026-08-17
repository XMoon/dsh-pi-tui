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
| `concurrency.md` | contributors | Why dsh sessions cannot be shared across processes, and the divergence guard that enforces it |
| `failure-model.md` | contributors | The async failure & cancellation contract (`runDetached` / `runOwned`, error observation, lifecycle roots) — the rules that prevent unhandled rejections and misclassified cancellations |
| `input-history.md` | contributors | Per-cwd input history: why it left the settings document, the JSONL file design, the recall-order contract, and the migration path |
| `surface-decisions.md` | contributors | Plain-`exit` quitting, background-subagent notices in the queue pane, and the /login credential-target resolution |
| `repair-session.md` | ops | `scripts/repair-session.mjs`: damage classes, the zstd frame-layout constraint, and the failure modes that broke real logs |
| `surface-catalog.md` | contributors | The surface catalog design: resume prefetch + standing-scope cold skills; why composition probes are REMOVED (host `session/created` observers write durable knob events) and the standing-key path that replaces them; the coordinator invariants that keep snapshots detached and first submissions correctly routed |
| `perf-baseline.md` | contributors | Measured rendering performance before/after the incremental read grouping + render-cache optimization, and how to re-run it |
| `tmux-testing.md` | contributors | When to test in tmux instead of headless, the manual verification flows, and every trap hit while real-testing |
| `tmux/` | — | Helper scripts (`ansi2html.mjs`, `tui-demo.sh`) with their own tests |
| `dsh-pi-tui.png` | — | Screenshot used by the root README |

Other documentation, and why it is not here:

- Root `AGENTS.md` — the contributor operating manual: naming, layout, key
  decisions, development loop, traps, and pointers into this directory.
- `packages/pi-tui/AGENTS.md` — the vendored fork's divergence ledger: every
  local fix with its guarding tests. It is the source of record for re-vendor
  verification and intentionally lives with the fork.
- `packages/pi-tui/package.json` → `repository.note` — the single source of
  truth for the vendored upstream version/commit (deliberately not copied
  into any other doc).
- `packages/dsh-pi-tui/README.md` — the published package's npm page
  (user-facing install instructions).
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
