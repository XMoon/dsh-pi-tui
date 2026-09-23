# Generated DSH preset mirror

The `*.patch.yml` files in this directory are GENERATED from the preset
patch assets exported by `@deepseek-ai/dsh-web-app` (see
`scripts/generate-dsh-presets.mjs`).

**DO NOT EDIT.** dsh-pi-tui does not own the shipped preset definitions:
`pnpm build` regenerates the mirror from the official package, and
`test/dsh-preset-parity.test.mjs` fails the suite on any byte drift.

This mirror exists only because DSH 0.1.7's (through 0.1.7-rc.1)
`dsh.bundle.patch` resolves bundle-package-relative paths and cannot
reference another package's exported assets. It is a recorded upstream
packaging gap — remove it when DSH ships a shared preset bundle or
cross-package patch references.
