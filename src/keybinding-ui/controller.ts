/**
 * Persistence and runtime projection for the Keyboard Shortcuts Editor.
 *
 * The controller is deliberately narrow: settings are accessed through the
 * get/replace ConfigPort surface, while runtime state is projected through
 * HostKeybindingManager. It never watches settings and never writes a file.
 */

import { APP_KEYBINDINGS } from '../keybindings/definitions.ts'
import { parseUserKeybindings } from '../keybindings/config.ts'
import { formatKeyId } from '../keybindings/hints.ts'
import type { HostKeybindingManager } from '../keybindings/manager.ts'
import { serializeTuiSettingsMutation, type TuiSettingsDoc, type TuiSettingsConfig } from '../runtime/config-port.ts'
import type { KeyId } from '@xmoon76/pi-tui'
import type { AppKeybindingId } from '../keybindings/types.ts'
import {
  buildKeybindingEditorModel,
  editorBindingsFor,
  type KeybindingEditorBinding,
  type KeybindingEditorModel,
} from './model.ts'
import { safeErrorMessage } from '../error-boundary.ts'
import type { ParsedUserKeybindings } from '../keybindings/config.ts'

export type KeybindingMutation =
  | {
      readonly kind: 'add'
      readonly action: AppKeybindingId
      readonly binding: KeybindingEditorBinding
    }
  | {
      readonly kind: 'replace'
      readonly action: AppKeybindingId
      readonly previous: KeybindingEditorBinding
      readonly binding: KeybindingEditorBinding
    }
  | {
      readonly kind: 'remove'
      readonly action: AppKeybindingId
      readonly binding: KeybindingEditorBinding
    }
  | {
      readonly kind: 'set-action'
      readonly action: AppKeybindingId
      readonly bindings: readonly KeybindingEditorBinding[]
    }
  | {
      readonly kind: 'reset-action'
      readonly action: AppKeybindingId
    }
  | {
      readonly kind: 'disable-action'
      readonly action: AppKeybindingId
    }
  | {
      readonly kind: 'set-leader'
      readonly key: KeyId | undefined
    }
  | {
      readonly kind: 'reset-all'
    }

export type KeybindingMutationResult =
  | {
      readonly kind: 'applied'
      readonly model: KeybindingEditorModel
      readonly parsed: ParsedUserKeybindings
      readonly message: string
    }
  | {
      readonly kind: 'rejected' | 'error'
      readonly message: string
    }

export type KeybindingMutationRunner = (
  mutation: KeybindingMutation,
  onResult: (result: KeybindingMutationResult) => void,
  onError: (error: unknown) => void,
) => void

export interface KeybindingEditorControllerOptions {
  readonly settings: TuiSettingsConfig | undefined
  readonly manager: HostKeybindingManager
  readonly onDiagnostic?: (message: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneKeybindings(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {}
  const clone: Record<string, unknown> = { ...raw }
  if (isRecord(raw.bindings)) clone.bindings = { ...raw.bindings }
  return clone
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function removeActionDeclarations(raw: Record<string, unknown>, action: AppKeybindingId): void {
  delete raw[action]
  if (!isRecord(raw.bindings)) return
  const bindings = { ...raw.bindings }
  delete bindings[action]
  raw.bindings = bindings
}

function actionBindings(
  action: AppKeybindingId,
  parsed: ParsedUserKeybindings,
): KeybindingEditorBinding[] {
  return [...editorBindingsFor(action, parsed)]
}

function sameBinding(left: KeybindingEditorBinding, right: KeybindingEditorBinding): boolean {
  return left.kind === right.kind && left.key === right.key
}

function dedupeBindings(bindings: readonly KeybindingEditorBinding[]): KeybindingEditorBinding[] {
  const result: KeybindingEditorBinding[] = []
  for (const binding of bindings) {
    if (!result.some(existing => sameBinding(existing, binding))) result.push(binding)
  }
  return result
}

function writeActionDeclarations(
  raw: Record<string, unknown>,
  action: AppKeybindingId,
  bindings: readonly KeybindingEditorBinding[],
): void {
  removeActionDeclarations(raw, action)
  const values = dedupeBindings(bindings).map(binding => binding.kind === 'leader' ? `<leader>${binding.key}` : binding.key)
  // An empty declaration means "no override" in the parser (and therefore
  // restores the builtin). `false` is reserved for the explicit Disable
  // command and must not be conflated with removing the final shortcut.
  raw[action] = values.length === 0 ? [] : values.length === 1 ? values[0]! : values
}

function actionFromMutation(mutation: KeybindingMutation): AppKeybindingId | undefined {
  switch (mutation.kind) {
    case 'add':
    case 'replace':
    case 'remove':
    case 'set-action':
    case 'reset-action':
    case 'disable-action':
      return mutation.action
    case 'set-leader':
    case 'reset-all':
      return undefined
  }
}

function isBenignParserDiagnostic(message: string): boolean {
  // This warning describes a scoped overlay precedence rule. The action still
  // works outside that overlay, so the editor may persist it after showing the
  // warning instead of treating it as a dead binding.
  return message.includes('non-configurable overlay owns while it is open')
}

function conflictSignature(conflict: {
  readonly key: KeyId
  readonly actions: readonly { readonly action: string; readonly scope: string; readonly source: string }[]
}): string {
  return `${conflict.key}\u0000${conflict.actions.map(action => `${action.action}:${action.scope}:${action.source}`).sort().join('|')}`
}

function affectedActions(mutation: KeybindingMutation): readonly AppKeybindingId[] {
  const action = actionFromMutation(mutation)
  return action === undefined ? [] : [action]
}

function describeConflict(conflict: {
  readonly key: KeyId
  readonly actions: readonly { readonly action: string }[]
}): string {
  const actions = conflict.actions.map(action => action.action).join(', ')
  return `Cannot save: ${formatKeyId(conflict.key)} conflicts with ${actions}. Choose another shortcut.`
}

function applyMutation(
  raw: Record<string, unknown>,
  current: ParsedUserKeybindings,
  mutation: KeybindingMutation,
): Record<string, unknown> | undefined {
  switch (mutation.kind) {
    case 'add': {
      const bindings = actionBindings(mutation.action, current)
      writeActionDeclarations(raw, mutation.action, [...bindings, mutation.binding])
      return raw
    }
    case 'replace': {
      const bindings = actionBindings(mutation.action, current).filter(binding => !sameBinding(binding, mutation.previous))
      writeActionDeclarations(raw, mutation.action, [...bindings, mutation.binding])
      return raw
    }
    case 'remove': {
      const bindings = actionBindings(mutation.action, current).filter(binding => !sameBinding(binding, mutation.binding))
      writeActionDeclarations(raw, mutation.action, bindings)
      return raw
    }
    case 'set-action':
      writeActionDeclarations(raw, mutation.action, mutation.bindings)
      return raw
    case 'reset-action':
      removeActionDeclarations(raw, mutation.action)
      return raw
    case 'disable-action':
      removeActionDeclarations(raw, mutation.action)
      raw[mutation.action] = false
      return raw
    case 'set-leader':
      if (mutation.key === undefined) {
        delete raw.leader
        // Clearing the prefix also removes its completions. Leaving inert
        // <leader> entries behind would make the next parse warn and would
        // not be a useful state for an interactive editor.
        for (const definition of Object.values(APP_KEYBINDINGS)) {
          const bindings = actionBindings(definition.id, current)
          if (!bindings.some(binding => binding.kind === 'leader')) continue
          const direct = bindings.filter(binding => binding.kind === 'direct')
          if (direct.length === 0) removeActionDeclarations(raw, definition.id)
          else writeActionDeclarations(raw, definition.id, direct)
        }
      } else {
        raw.leader = mutation.key
      }
      return raw
    case 'reset-all':
      return undefined
  }
}

export class KeybindingEditorController {
  private readonly settings: TuiSettingsConfig | undefined
  private readonly manager: HostKeybindingManager
  private readonly onDiagnostic: (message: string) => void

  constructor(options: KeybindingEditorControllerOptions) {
    this.settings = options.settings
    this.manager = options.manager
    this.onDiagnostic = options.onDiagnostic ?? (() => {})
  }

  readModel(): KeybindingEditorModel {
    if (this.settings === undefined) throw new Error('Keyboard shortcuts are unavailable because settings are not connected.')
    const doc = this.settings.get()
    const parsed = parseUserKeybindings(doc.keybindings)
    for (const diagnostic of parsed.diagnostics) this.onDiagnostic(diagnostic)
    return buildKeybindingEditorModel(this.manager, parsed)
  }

  async mutate(mutation: KeybindingMutation): Promise<KeybindingMutationResult> {
    if (this.settings === undefined) {
      return { kind: 'error', message: 'Keyboard shortcuts are unavailable because settings are not connected.' }
    }
    const settings = this.settings
    return serializeTuiSettingsMutation(settings, async () => {
      try {
        const currentDoc = settings.get()
        const raw = cloneKeybindings(currentDoc.keybindings)
        const current = parseUserKeybindings(raw)
        const definition = actionFromMutation(mutation)
        if (definition !== undefined && !APP_KEYBINDINGS[definition]!.configurable) {
          return { kind: 'rejected', message: 'This shortcut is fixed by the application and cannot be changed.' }
        }
        const nextRaw = applyMutation(raw, current, mutation)
        const parsed = parseUserKeybindings(nextRaw)
        for (const diagnostic of parsed.diagnostics) this.onDiagnostic(diagnostic)

        const previousDiagnostics = new Set(current.diagnostics)
        const newHardDiagnostics = parsed.diagnostics.filter(diagnostic => !previousDiagnostics.has(diagnostic) && !isBenignParserDiagnostic(diagnostic))
        if (newHardDiagnostics.length > 0) {
          return { kind: 'rejected', message: `Cannot save: ${newHardDiagnostics[0]}` }
        }

        const preflight = this.manager.preflight(parsed)
        const currentManagerDiagnostics = new Set(this.manager.diagnosticsList())
        const newManagerDiagnostics = preflight.diagnostics.filter(diagnostic => !currentManagerDiagnostics.has(diagnostic))
        // Any mutation can make an existing leader prefix unusable (for
        // example, adding a direct binding on the prefix key). Reject only a
        // newly introduced diagnostic so an unrelated edit can still repair a
        // configuration that was already persisted with a warning.
        const leaderProblem = newManagerDiagnostics.find(diagnostic => diagnostic.includes('leader key') || diagnostic.includes('ambiguous leader sequence'))
        if (leaderProblem !== undefined) {
          return { kind: 'rejected', message: `Cannot save: ${leaderProblem}` }
        }

        const affected = new Set(affectedActions(mutation))
        const currentConflictSet = new Set(this.manager.snapshot().conflicts.map(conflictSignature))
        const newConflict = preflight.snapshot.conflicts.find(conflict =>
          conflict.actions.some(action => affected.has(action.action as AppKeybindingId))
          && !currentConflictSet.has(conflictSignature(conflict)),
        )
        if (newConflict !== undefined) return { kind: 'rejected', message: describeConflict(newConflict) }

        const nextDoc = { ...currentDoc } as TuiSettingsDoc
        if (nextRaw === undefined) delete nextDoc.keybindings
        else nextDoc.keybindings = nextRaw
        // The transaction intentionally has one replace and only projects the
        // same parsed candidate after persistence succeeds.
        await Promise.resolve(settings.replace(nextDoc))
        this.manager.setUserConfiguration(parsed)
        return {
          kind: 'applied',
          model: buildKeybindingEditorModel(this.manager, parsed),
          parsed,
          message: 'Keyboard shortcut settings saved.',
        }
      } catch (error) {
        return { kind: 'error', message: `Could not save keyboard shortcuts: ${safeErrorMessage(error)}` }
      }
    })
  }
}

export function keybindingSummary(model: KeybindingEditorModel): string {
  return model.summary
}

export function hasDeclaredAction(
  parsed: ParsedUserKeybindings,
  action: AppKeybindingId,
): boolean {
  return hasOwn(parsed.bindings, action)
}
