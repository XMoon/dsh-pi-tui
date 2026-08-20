# Extension tiers

The extension surface ships three tiers. A plugin imports ONE tier entry — never the
stable entry's internals, `PiTuiApp`, `PiTuiMainScreen`, `PiTuiAltScreen`,
nor repository-relative paths.

| Tier | Entry | Contract |
|---|---|---|
| Stable | `@xmoon76/dsh-pi-tui/extensions` | Compatibility-oriented; additive-first; existing semantics never silently change; removal requires a planned breaking change. |
| Advanced | `@xmoon76/dsh-pi-tui/extensions/advanced` | Experimental; minor releases may break; a migration note is required; no long-term shims. |
| Unstable | `@xmoon76/dsh-pi-tui/extensions/unstable` | NO compatibility guarantee; implementation may change at any time. |

All tiers reuse the SAME shared extension runtime: caller-fiber ownership, surface
lifecycle, invalidation, capability discovery. Do not fork a second ownership/lifecycle
model per tier. Phase 1 ships metadata only: an exported path, a tier constant
(`ADVANCED_API_LEVEL` / `UNSTABLE_API_LEVEL`, both `0`), the reserved
capability namespaces `advanced.` / `unstable.`, and the shared `ExtensionTier` type.
No advanced/unstable capability is implemented yet and no Host-private surface is exposed.