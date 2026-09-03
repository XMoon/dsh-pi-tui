# pi-tui Agent Guide

`packages/pi-tui` is a vendored copy of pi-tui from the upstream pi-mono
project, pinned to Earendil `v0.84.4` (see `UPSTREAM.json` — the single
source of truth for the baseline; generated reports may repeat the pin but
must not become a second hand-maintained source). It is no longer patched via
pnpm patches — all local fixes are applied directly to the source. The differential-rendering behavior in `src/tui.ts`
matches upstream; the schema-v2 `vendor-divergences.json` is the authoritative
inventory, and `DIVERGENCES.md` is the generated human report.

## Hard rules

- **Never overwrite this directory wholesale when syncing from upstream.**
  Each local divergence must be re-verified after a sync; its test and evidence
  record is listed in the generated `DIVERGENCES.md`.
- **Read the structured ledger before editing any file under `src/`.**
  `vendor-divergences.json` is the source of truth and `DIVERGENCES.md` is
  generated from it. Every record has an ID, status, category, risk, consumer
  evidence, semantic upstream comparison, retirement conditions, and guarding
  tests. Do not re-add removed kimi-only code; do not delete a hard seam
  without a host-side replacement.
- **Run the ledger gates for every re-vendor.** Use
  `pnpm gate:pi-divergence-ledger`, `pnpm generate:pi-divergences`, and
  `pnpm gate:pi-vendor-diff --strict`. Never mark a record unused from host
  grep alone: vendor-internal, inheritance/structural, host,
  public/extension, behavioral, and test/runtime ownership must all be
  explicitly audited. `ABSORBED_UPSTREAM` requires semantic `YES`; an
  `UNKNOWN` comparison cannot retire; `REMOVED_UNUSED` requires empty audited
  dependency classes plus deletion evidence; and `REDUNDANT_SHIM` requires an
  atomic replacement mapping and evidence.
- **Source ownership:** `src/` and `test/` are upstream-owned (Earendil
  baseline + re-applied divergences). `README.md` keeps the upstream content
  plus the local fork/ledger header, which must be preserved or re-applied
  after a sync. `package.json`, `tsconfig.json`, `tsdown.config.ts`,
  `UPSTREAM.json`, `vendor-divergences.json`, `DIVERGENCES.md`, and
  `AGENTS.md` are XMoon-owned package shell — never overwrite them from
  upstream.
- **Package shell contract:** name stays `@xmoon76/pi-tui`, `private: true`,
  tsdown build producing `dist/index.mjs` + `dist/index.d.mts`. Do not
  switch to the upstream tsgo contract. Native prebuilds are deliberately NOT
  vendored (supported surface: Linux/WSL/SSH into Linux). "Degrade" is
  input-capability loss, not a crash: without the prebuilds Shift+Tab is
  indistinguishable from Tab and the Windows/Apple Terminal Shift+Enter
  modifier fallback is unavailable — `terminal.ts` falls back to sequence
  heuristics only. If Windows/macOS become supported platforms, vendor the
  matching `native/` prebuilds from the pinned upstream tarball.
- **When an upstream file conflicts with a local divergence, the Earendil
  file is the base** — re-apply the necessary patch on top. Never go the
  other direction (local file as base, cherry-picking upstream code back).

## Hard gates (re-vendor acceptance)

```bash
pnpm --dir packages/pi-tui typecheck   # fork typecheck
pnpm --dir packages/pi-tui test        # fork suite (node --test)
pnpm --dir packages/pi-tui build       # fork build (dist/index.mjs + dist/index.d.mts)
pnpm gate:pi-surface-compat            # bundle: component lifecycle compat gate
pnpm gate:pi-divergence-ledger          # schema, retirement, and generated-report gate
pnpm generate:pi-divergences             # regenerate DIVERGENCES.md from the JSON ledger
pnpm gate:pi-vendor-diff --strict       # pinned source coverage, including stale-entry checks
```

`gate:pi-surface-compat` is a re-vendor hard gate, not an optional smoke.

## Re-vendor flow

1. Read `UPSTREAM.json` for the pinned baseline (repository, package, tag,
   commit).
2. Fetch the pinned upstream package; copy `src/` and `test/` from the
   pinned baseline. Merge upstream README content while preserving the local
   fork/ledger header.
3. Re-apply each source-active record in
   `vendor-divergences.json` (never wholesale-copy an old local file back).
   Historical `ABSORBED_UPSTREAM` and `REMOVED_UNUSED` records stay explicit
   with evidence but are not re-applied.
4. Re-verify every dependency class and guarding test. Update the JSON record
   when upstream absorbs a behavior or a retirement audit changes; then run
   `pnpm generate:pi-divergences` to refresh the report. Do not hand-edit
   `DIVERGENCES.md`.
5. Run the ledger and source hard gates above, then the bundle gates
   (`pnpm build`, `pnpm typecheck`, `pnpm test:bundle`).

## Testing

- This package's tests run with `node --test` (`pnpm --dir packages/pi-tui
  test`). The repo has no vitest anywhere.
- Prefer adding new narrow-width tests to the existing test file of the
  corresponding component.
