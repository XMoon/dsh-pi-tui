import { defineConfig } from 'tsdown'

// The dsh bundle ships self-contained: the vendored pi-tui fork is bundled
// into dist/ (like kimi-code's CLI bundles @moonshot-ai/pi-tui), so
// @xmoon76/pi-tui stays private and is never published. Only pi-tui is
// bundled; everything else (dsh/cordis services, chalk, commander, marked,
// get-east-asian-width) stays external and resolves from the profile's
// node_modules at runtime.
export default defineConfig({
  entry: ['./src/index.ts', './src/startup.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: true,
  deps: {
    onlyBundle: ['@xmoon76/pi-tui'],
  },
})
