/**
 * The public extension SDK entry: `@xmoon76/dsh-pi-tui/extensions`.
 *
 * Exports the public contracts (types, capabilities, slot names) and the
 * Cordis plugin that PROVIDES the `piTuiExtensions` service (`pi-tui-extension-host`
 * Loader row). Third-party plugins import ONLY this entry — never
 * `@xmoon76/pi-tui`, `TuiApp`, or repository internals (the packed `.d.mts`
 * leak gate enforces that).
 *
 * M1 scope: registry primitives only. The service is available before any
 * TUI surface exists (`tuiStartup` gate), so a plugin can register during
 * boot; the SurfaceHost (M2) attaches later and renders the registrations.
 * @module @xmoon76/dsh-pi-tui/extensions
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PI_TUI_EXTENSIONS_SERVICE, PiTuiExtensionServiceImpl } from './extension/service.ts'
import { HOST_COMMAND_CATALOG } from './index.ts'
import { TUI_STARTUP_SERVICE } from './startup.ts'

/** Stable Cordis plugin name for the extension host row. */
export const name = 'pi-tui-extension-host'

/** The host mounts only when the TUI startup flags were parsed (same gate
 * as the runner row: `dsh --profile pi-tui --help` provides nothing, so no
 * extension host mounts either). */
export const inject = [TUI_STARTUP_SERVICE]

/** The `@xmoon76/dsh-pi-tui` package version, read beside the built dist
 * (dist/extensions.mjs → ../package.json; source layout src/extensions.ts →
 * ../package.json — both one level up). */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export { PI_TUI_EXTENSIONS_SERVICE }
export type { PiTuiExtensionService } from './extension/service.ts'

export {
  API_VERSION,
  type ActivitySnapshot,
  type AutocompleteHandle,
  type AutocompleteProviderContribution,
  type ContributionHealth,
  type ContributionRecord,
  type ContributionState,
  type DockItem,
  type EditorContribution,
  type EditorHandle,
  type EditorHost,
  type EditorHostAction,
  type EditorHostActionResult,
  type EditorInputEvent,
  type EditorSnapshot,
  type ExtensionEditor,
  type ExtensionView,
  type FooterSegment,
  type FrameView,
  type HeaderBadge,
  type InputWidget,
  type MarkdownView,
  type MessagePresentationSnapshot,
  type NormalizedKey,
  type PiTuiApiInfo,
  type PiTuiCapability,
  type PiTuiSlotName,
  type PiTuiSlotSemantic,
  type RegistrationHandle,
  type RegistrationSpec,
  type RowsView,
  type SessionSnapshot,
  type SpacerView,
  type StackView,
  type StyledSpan,
  type SurfaceSnapshot,
  type SurfaceStateValues,
  type TextView,
  type TuiAction,
  type TuiAutocompleteItem,
  type TuiAutocompleteProvider,
  type TuiAutocompleteQuery,
  type TuiAutocompleteRegistryView,
  type TuiAutocompleteSuggestions,
  type TuiColorPalette,
  type TuiCommandBridgeView,
  type TuiCommandContribution,
  type TuiCommandHandle,
  type TuiCommandBridgeSnapshot,
  type TuiKeybindingContribution,
  type TuiKeybindingHandle,
  type TuiKeybindingRegistrySnapshot,
  type TuiKeybindingRegistryView,
  type TuiLocalCommandHandler,
  type TuiSettingContribution,
  type TuiSettingHandle,
  type TuiSettingsRegistrySnapshot,
  type TuiSettingsRegistryView,
  type TuiThemeContribution,
  type TuiThemeHandle,
  type TuiMessageRendererContribution,
  type TuiOverlayHandle,
  type TuiOverlayOptions,
  type TuiRendererHandle,
  type TuiRendererRegistrySnapshot,
  type TuiThemeRegistrySnapshot,
  type TuiThemeRegistryView,
  type TuiToolRendererContribution,
  type TuiSizeValue,
  type ToolPresentationSnapshot,
} from './extension/public-types.ts'
export { describeKey } from './extension/public-types.ts'

/**
 * Provide the extension service. The Service base class registers the
 * instance on `ctx` under `piTuiExtensions` and unregisters it when this
 * provider fiber unloads; invalidations coalesce into render requests
 * (until the SurfaceHost attaches in M2 the sink is a no-op).
 * @param ctx - the provider's plugin context.
 */
export function apply(ctx: Context): void {
  if (ctx.get(TUI_STARTUP_SERVICE) === undefined) return
  new PiTuiExtensionServiceImpl(ctx, packageVersion(), () => {}, HOST_COMMAND_CATALOG)
}
