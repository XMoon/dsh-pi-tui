import { defineConfig } from 'tsdown'

// The fork's own build config. tsdown discovers configs by walking up from
// the CWD, so without this file the repository root's tsdown.config.ts (the
// @xmoon76/dsh-pi-tui bundle) would shadow this package's build after the
// root-package migration (entries would resolve against the fork's src/ and
// fail). The settings reproduce the tsdown defaults the fork previously
// built with: entry src/index.ts, ESM, outDir dist, declarations.
export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: true,
})
