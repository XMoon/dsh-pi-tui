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
