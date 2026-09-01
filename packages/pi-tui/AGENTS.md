# pi-tui Agent Guide

`packages/pi-tui` is a vendored copy of pi-tui from the upstream pi-mono
project, pinned to Earendil `v0.84.4` (see `UPSTREAM.json` — the single
source of truth for the baseline; do not copy the version/commit into other
docs). It is no longer patched via pnpm patches — all local fixes are applied
directly to the source. The differential-rendering behavior in `src/tui.ts`
matches upstream; the only remaining divergences are listed in
`DIVERGENCES.md`.

## Hard rules

- **Never overwrite this directory wholesale when syncing from upstream.**
  Each local divergence must be re-verified after a sync; all of them are
  guarded by tests (see `DIVERGENCES.md`).
- **Read `DIVERGENCES.md` before editing any file under `src/`.** Every
  divergence has an ID, category, consumer, upstream status and guarding
  tests. Do not re-add removed kimi-only code; do not delete a hard seam
  without a host-side replacement.
- **Source ownership:** `src/`, `test/`, `README.md` are upstream-owned
  (Earendil baseline + re-applied divergences). `package.json`,
  `tsconfig.json`, `tsdown.config.ts`, `UPSTREAM.json`, `DIVERGENCES.md`,
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
```

`gate:pi-surface-compat` is a re-vendor hard gate, not an optional smoke.

## Re-vendor flow

1. Read `UPSTREAM.json` for the pinned baseline (repository, package, tag,
   commit).
2. Fetch the pinned upstream package; copy upstream-owned files
   (`src/`, `test/`, `README.md`) over the local ones.
3. Re-apply every `HARD_HOST_API` / `BUGFIX_MISSING_UPSTREAM` divergence
   from `DIVERGENCES.md` (never wholesale-copy an old local file back).
4. Re-verify each guarding test; update `DIVERGENCES.md` (a divergence that
   upstream absorbed becomes `ABSORBED_UPSTREAM`; a dead entry becomes
   `STALE_LEDGER` and is fixed in place).
5. Run the hard gates above, then the bundle gates
   (`pnpm build`, `pnpm typecheck`, `pnpm test:bundle`).

## Testing

- This package's tests run with `node --test` (`pnpm --dir packages/pi-tui
  test`). The repo has no vitest anywhere.
- Prefer adding new narrow-width tests to the existing test file of the
  corresponding component.
