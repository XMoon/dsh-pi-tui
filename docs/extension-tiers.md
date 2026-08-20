# Extension tiers

The extension surface ships three tiers. A plugin imports ONE tier entry — never the
stable entry's internals, `TuiApp`, `TuiMainScreen`, `TuiAltScreen`,
nor repository-relative paths.

All extension plugins remain standard DeepSeek Harness / Cordis plugins using
`name`, `inject`, and `apply(ctx)`. The tiers are capability facades over the
single `piTuiExtensions` Cordis service — NOT three plugin frameworks, three
loaders, three services, or three HMR/lifecycle runtimes. The package export
paths below are TypeScript/package boundaries; at runtime there is ONE
`piTuiExtensions` service and ONE shared Extension Runtime.

| Tier | Entry | Contract |
|---|---|---|
| Stable | `@xmoon76/dsh-pi-tui/extensions` | Compatibility-oriented; additive-first; existing semantics never silently change; removal requires a planned breaking change. |
| Advanced | `@xmoon76/dsh-pi-tui/extensions/advanced` | Experimental; minor releases may break; a migration note is required; no long-term shims. |
| Unstable | `@xmoon76/dsh-pi-tui/extensions/unstable` | NO compatibility guarantee; implementation may change at any time. |

All tiers reuse the SAME shared extension runtime: caller-fiber ownership, surface
lifecycle, invalidation, capability discovery. Do not fork a second ownership/lifecycle
model per tier.

## Current tier status

- **Stable** (`ADVANCED_API_LEVEL` n/a): the M0–M11 platform — chrome
  slots, widgets, commands, themes, settings, autocomplete, keybindings,
  renderers, managed overlays, the editor SDK. See `docs/extension-api.md`.
- **Advanced** (`ADVANCED_API_LEVEL = 1`, Phase 2): normalized input
  capture (`advanced.input.capture`), focused interactive surfaces
  (interactive managed overlays, `advanced.ui.interactive`), and advanced
  editor control (`advanced.editor.control`). See
  `docs/extension-advanced.md`.
- **Unstable** (`UNSTABLE_API_LEVEL = 1`, Phase 3): raw input
  interception (`unstable.input.raw` — observe/consume/rewrite, exclusive
  raw ownership), the Host emergency fail-safe (triple-Esc), and the
  low-level surface seam (`unstable.surface.handle`). NO compatibility
  guarantee. See `docs/extension-unstable.md`.

The capability model is shared: `service.api().capabilities` carries the
tier-prefixed ids (`advanced.*`, `unstable.*`), feature-detected — never
parsed from the host version. Advanced/Unstable capabilities may evolve
with their APIs; Stable capabilities never silently change semantics.
