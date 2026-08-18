import { defineConfig } from 'tsdown'

// The dsh bundle ships self-contained: the vendored pi-tui fork is bundled
// into dist/ (like kimi-code's CLI bundles @moonshot-ai/pi-tui), so
// @xmoon76/pi-tui stays private and is never published. Only pi-tui is
// bundled; everything else (dsh/cordis services, chalk, commander, marked,
// get-east-asian-width) stays external and resolves from the profile's
// node_modules at runtime.
//
// Entry list (M3/E): the runner + startup rows, the public extension SDK
// (`extensions`), and the Loader-only first-party contributor (`builtins`).
// Flat entry files keep tsdown's nested-output-path rules out of the way;
// the subpath names come from package.json#exports.
export default defineConfig({
  entry: [
    './src/index.ts',
    './src/startup.ts',
    './src/extensions.ts',
    './src/builtins.ts',
  ],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: true,
  deps: {
    onlyBundle: ['@xmoon76/pi-tui'],
  },
})
