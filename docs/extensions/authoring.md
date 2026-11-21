# Plugin authoring guide — which tier should I use?

The dsh-pi-tui extension platform ships three tiers over ONE
`piTuiExtensions` service. A plugin imports ONE tier entry and stays a
standard DeepSeek Harness / Cordis plugin (`name`, `inject`, `apply`).

## The decision tree

```text
Can the plugin express its UI with semantic contributions
(chrome slots, widgets, commands, themes, settings, autocomplete,
keybindings, renderers, managed overlays, editor replacement)?
        │
        ├─ YES → STABLE  (@xmoon76/dsh-pi-tui/extensions)
        │
        └─ NO — does it need custom INTERACTION (state, focus,
           normalized input, prompts, custom surfaces)?
                │
                ├─ YES → ADVANCED  (@xmoon76/dsh-pi-tui/extensions/advanced)
                │
                └─ NO — does it need RAW terminal input, exclusive
                   input ownership, Host-policy bypass, or
                   implementation-coupled primitives?
                        │
                        └─ YES → UNSTABLE  (@xmoon76/dsh-pi-tui/extensions/unstable)
```

## Tier contracts

| Tier | Entry | Contract | Breaks |
|---|---|---|---|
| Stable | `@xmoon76/dsh-pi-tui/extensions` | Semantic, Host-controlled, compatibility-oriented; additive-first; existing semantics never silently change. | Only a planned breaking change with a migration path. |
| Advanced | `@xmoon76/dsh-pi-tui/extensions/advanced` | Experimental higher-freedom interactive APIs: normalized input capture, focused interactive surfaces, editor control, the imperative UI broker, custom UI, host-state overrides. Still Host-mediated — never raw terminal bytes, never private TUI objects. | Minor releases may break; a migration note is required; no long-term shims. |
| Unstable | `@xmoon76/dsh-pi-tui/extensions/unstable` | NO compatibility guarantee. Raw input interception (observe/consume/rewrite, exclusive ownership), the Host emergency fail-safe (triple-Esc), the low-level surface seam. A broken plugin can disrupt Host behavior. | Anything, anytime. |

## Per-package Host configuration row

An installed npm bundle can get its OWN official profile Settings section
without shipping executable Host code. The package inserts one row into its
own `dsh.bundle.patch` and points that row at the trusted carrier subpath:

```yaml
- insert:
    - id: pi-tui-extcfg-93457ce1c3d199d03e0628d57954f4f5
      name: '@xmoon76/dsh-pi-tui/extension-config'
      config:
        data:
          theme: midnight
          limit: 5
```

- `insert` is always a LIST: the official patch shape is
  `PatchOptions.insert?: EntryOptions[]`, and the `id`, `name` and `config` keys
  belong to the inserted entry.
- The row id is exactly `pi-tui-extcfg-` followed by the first 32 lowercase hex
  characters of SHA-256 over the UTF-8 package name — here the package is
  `example-plugin`:
  `createHash('sha256').update('example-plugin', 'utf8').digest('hex').slice(0, 32)`.
  The npm `package.json` name decides it, never a display name, an alias or a
  directory.
- Every package uses its own row id with the same carrier module, so two
  packages mount two independent official Settings namespaces with independent
  revisions.
- `data` is ordinary non-secret JSON the package persists for itself. It is not
  a place for credentials, tokens or API keys, and the carrier declares no
  default, no business schema and no runtime behavior.
- The row is a Host configuration carrier only: it performs no work, publishes
  no service and declares no TUI surface.

### Persisted settings over that carrier

A `./tui` entry can expose one or more author-declared settings over the same
official `data` object, without shipping a second schema or its own settings
service:

```ts
service.registerSetting({
  id: 'example.limit',
  label: 'Example limit',
  currentValue: String(config.limit ?? 5), // this Client's live runtime fact
  persisted: {
    path: ['limit'], // relative to the package's Config `data`
    choices: [
      { id: 'five', op: 'set', value: 5 },
      { id: 'ten', label: 'Ten', op: 'set', value: 10 },
      { id: 'inherit', label: 'Use inherited', op: 'unset' },
    ],
  },
})
```

Only JSON scalars (`string | number | boolean | null`) are allowed; the
choices are a closed list, duplicate ids and an empty path are rejected at
registration, and an `unset` choice carries no value. `values` and `onChange`
cannot be combined with `persisted`. The Settings → Extensions row shows the
Host profile's effective/inherited/USER facts and this Client's runtime value
separately; saving is one official revision-checked Host mutation and is
never written to the TUI settings document. `unset` is Reset: it restores the
inherited effective value, and the USER leaf may remain present when a sibling
override keeps that USER config alive. The plugin must not put secrets,
tokens or credentials in that Config `data`.

## Client-local `./tui` entry

A package that also contributes TUI surfaces declares the opt-in in its
installed `package.json` and exports the module from the same package:

```json
{
  "exports": { "./tui": "./dist/tui.mjs" },
  "dshPiTui": {
    "manifestVersion": 1,
    "entrypoints": { "./tui": "tui-local" }
  }
}
```

The `./tui` module is an ordinary Cordis plugin (`name`, optional `inject`,
`apply(ctx, config)`), not a second plugin system. When the package is
selected in the active profile AND its trusted Config row is mounted, the
CURRENT Client loads it through that Client's EXISTING official Loader:

- Direct loads it in the Direct session's Client scope; a Split Client loads
  it in its own Client Context. The Host never imports `./tui`, and the
  official Host Plugin Manager remains the only install/selection authority.
- `config` is the Config row's effective `data` value verbatim — `null`,
  `false`, `0`, arrays and absent values are real values. A failed read is
  reported as unavailable, its live contributions are unloaded, and the value
  is never replaced by `{}`.
- The contributions (commands, Footer, settings, …) are owned by the real
  Loader entry's fiber, so disabling the bundle, unloading the surface or
  exiting the Client disposes them. The same bytes enabled again create a new
  fiber; no duplicate registration survives the old one.
- Code identity is taken from the exact ESM module file the official Loader
  imports, not from a `require` condition, and the process remembers the
  identity it actually imported across same-PID surface revisions, including a
  failed first apply after a successful import. The official package version
  is also a currentness input: a version bump makes the old `./tui` code
  `reload-required` even when a thin entry file is unchanged. Changed `./tui`
  bytes are never hot-imported in the same process: the old code keeps running
  and the package reports `reload-required`; a Split Client sees an actionable
  `/reload-client` notice, while Direct requires an explicit application
  restart.

A malformed opt-in, missing `./tui` export, missing/wrong Config row, or a
failed import/apply only costs that package's PiTui Client status. It never
blocks the package's official DSH installation, Host rows or native
enable/disable lifecycle.

## Rules that never change

- **One service, one runtime.** The tiers are capability facades over the
  single `piTuiExtensions` service — never three plugin systems, loaders
  or HMR runtimes.
- **Caller-fiber ownership.** Every registration, capture, lease and
  prompt is owned by the calling Cordis fiber: owner unload/HMR disposes
  it. A stale surface handle is inert.
- **Feature-detect, never parse versions.** Check
  `service.api().capabilities.has(...)` before relying on a capability.
- **No repository-private imports, ever.** Low-level access is exposed
  through the supported tier entries only.
- **Raw terminal access is ONLY Unstable.** A capability that needs raw
  input or Host-policy bypass never enters Stable or Advanced.
- **Do not expand Stable to make a plugin work.** If a plugin inherently
  needs low-level input, custom components or Host-policy bypass, place
  it in Advanced or Unstable.

## Authoring checklist

1. Read `docs/extensions/stable.md` (Stable), `docs/extensions/advanced.md`
   (Advanced) or `docs/extensions/unstable.md` (Unstable) for the tier's
   full contract.
2. Feature-detect the capabilities you use.
3. Register through the public entry only; keep the plugin's resources
   caller-fiber-owned (never leak handles past `apply`).
4. Test against the PACKED tarball (the repo's smoke gates show how:
   `scripts/examples-plugin-smoke.mjs`).
