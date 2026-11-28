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
//
// `performance-host` is a NESTED source module exposed as a FLAT entry: it is
// a Host-plane Loader row (`src/app/host/performance-host.ts`), so it belongs
// to the application layer, while the package subpath stays
// `@xmoon76/dsh-pi-tui/performance-host`. The root source ledger is closed, so
// the flat DIST name comes from this object entry, never from a new
// `src/*.ts` module (AGENTS.md "Source module placement").
const bundleConfig = defineConfig({
  entry: [
    './src/index.ts',
    './src/startup.ts',
    './src/extensions.ts',
    './src/builtins.ts',
    './src/extension/advanced.ts',
    './src/extension/unstable.ts',
    { 'performance-host': './src/app/host/performance-host.ts' },
    // M4-B2-HF: the ONE built-in PiTui Host Runtime Loader entry. Internal Host
    // composition surface, not a user-installable business plugin; the two
    // private business services stay internal modules.
    { 'host-runtime': './src/app/host/pi-tui-host-runtime.ts' },
    // PR-D: the Host-plane visual tool row. Nested source module + flat dist
    // entry, exactly the performance-host precedent; the root ledger stays
    // closed at seven stable entries.
    { 'visual-tools': './src/app/host/visual-tools.ts' },
    // M5-W PR-C: the profile-owned Web startup preference row. Same precedent:
    // the canonical nested Host module is exposed under a flat package subpath.
    { 'web-preferences': './src/app/host/web-preferences.ts' },
    // M6-2A: the daemon Coordinator Loader row. Canonical nested module
    // (app/remote-process), flat dist subpath for the Loader. It is a plugin
    // entry, never a `bin` and never a public executable export.
    { 'daemon-launcher': './src/app/remote-process/daemon-launcher.ts' },
    // PO-1B: the profile-owned ACP startup preference row. Same precedent.
    { 'acp-preferences': './src/app/host/acp-preferences.ts' },
    // M6 PR-A: the canonical profile-owned TUI preference row. Same precedent:
    // the canonical nested app/config module under a flat package subpath.
    { preferences: './src/app/config/preferences.ts' },
    // R8-E PR-1: the ONE trusted Config-only carrier row third-party bundles
    // name from their own per-package profile rows. Same precedent.
    { 'extension-config': './src/app/host/extension-config-carrier.ts' },
  ],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: true,
  deps: {
    onlyBundle: ['@xmoon76/pi-tui', '@deepseek-ai/dsh-client-store', 'zustand', 'immer'],
  },
})

// M4-A0 process entries: internal qualification artifacts (no package export,
// no bin). They are separate builds because they are standalone Node programs,
// not Loader plugins, and deliberately ship no `.d.mts` surface. The thin
// launchers import their real work through `import()` after the official
// launcher has installed the runtime package-resolution interception.
const processEntryConfig = defineConfig({
  entry: {
    'local-host': './src/app/remote-process/local-host-entry.ts',
    'local-client': './src/app/remote-process/local-client-entry.ts',
    // NAF-1 public headless entry. It shares the local-client runtime graph so
    // both consume the ONE bundled Store closure; declarations are emitted by
    // the declaration-only pass below.
    'native-client': './src/app/remote-process/native-client.ts',
    'acp-stdio': './src/app/remote-process/acp-stdio-entry.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  clean: false,
  dts: false,
  deps: {
    onlyBundle: ['@xmoon76/pi-tui', '@deepseek-ai/dsh-client-store', 'zustand', 'immer'],
  },
})

// Public declarations for the headless entry. The pinned declaration plugin
// emits no runtime chunks, so this pass cannot create a second Store closure or
// overwrite the process-entry runtime graph.
const nativeClientDtsConfig = defineConfig({
  entry: { 'native-client': './src/app/remote-process/native-client.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: false,
  dts: { emitDtsOnly: true },
  deps: {
    onlyBundle: ['@xmoon76/pi-tui', '@deepseek-ai/dsh-client-store', 'zustand', 'immer'],
  },
})

export default [bundleConfig, processEntryConfig, nativeClientDtsConfig]
