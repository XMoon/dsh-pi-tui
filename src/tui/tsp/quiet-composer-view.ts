/**
 * TSP-7 PR-E: the Quiet Composer v2 presentational view.
 *
 * ONE pure view over render-time read-only values and synchronous click
 * callbacks: the controlled production `ui.editor`, the left Permission
 * trigger + popup, and the right Model / Effort / Stop / Send controls inside
 * the ONE rounded composer shell. It owns no business state, no timer and no
 * SDK session; the renderer passes the already-controlled editor node and
 * live values sampled at render time.
 *
 * The single scoped stylesheet below is the Owner-frozen v2 demo sheet mapped
 * to the product role namespace (`dsh.composer.*` / `dsh.footer.group`).
 * @module @xmoon76/dsh-pi-tui/tui/tsp/quiet-composer-view
 */

import { html, ui } from '@stencil-hq/tern'
import type { Node } from '@stencil-hq/tern'

/** The ONE surface-scoped stylesheet name the renderer installs. */
export const QUIET_COMPOSER_SHEET = 'dsh-quiet-composer'

/** The product role hooks used by the view and the stylesheet. */
export const QUIET_COMPOSER_ROLES = {
  shell: 'dsh.composer.shell',
  controls: 'dsh.composer.controls',
  permissionStack: 'dsh.composer.permission-stack',
  permission: 'dsh.composer.permission',
  permissionMenu: 'dsh.composer.permission-menu',
  permissionOption: 'dsh.composer.permission.option',
  right: 'dsh.composer.right',
  model: 'dsh.composer.model',
  effort: 'dsh.composer.effort',
  send: 'dsh.composer.send',
  stop: 'dsh.composer.stop',
  footerGroup: 'dsh.footer.group',
} as const

/** One selectable permission preset in the v2 menu (fixed standard set). */
export interface QuietComposerPermissionOption {
  readonly id: string
  readonly label: string
  readonly selected: boolean
  /** Keyboard-highlighted row (menu-local; independent of `selected`). */
  readonly highlighted?: boolean
}

/** The fixed render-time input of the Quiet Composer view. */
export interface QuietComposerViewInput {
  /** The production controlled `ui.editor` node. */
  readonly editor: Node
  /** The presentation scope (`s<scopeEpoch>`), used in identity keys. */
  readonly scope: string
  /** The committed busy lifetime serial (Stop identity). */
  readonly busyEpoch: number
  readonly permission: {
    /** The authoritative current label, already one-line sanitized. */
    readonly label: string
    readonly interactive: boolean
    readonly expanded: boolean
    readonly options: readonly QuietComposerPermissionOption[]
    /** The menu expansion identity; a stale option click never matches. */
    readonly menuEpoch: number
  }
  readonly model: { readonly label: string; readonly title: string; readonly interactive: boolean }
  readonly effort: { readonly label: string; readonly title: string; readonly interactive: boolean }
  readonly busy: boolean
  readonly sendable: boolean
  readonly onPermissionToggle: () => void
  readonly onPermissionChoose: (id: string, menuEpoch: number) => void
  readonly onModel: () => void
  readonly onEffort: () => void
  readonly onSend: () => void
  readonly onStop: () => void
}

/** Build the ONE Quiet Composer shell (editor + controls). */
export function quietComposerView(input: QuietComposerViewInput): Node {
  const scope = input.scope
  const permission = input.permission
  const permissionTitle = permission.interactive
    ? `Permission: ${permission.label} — click to choose`
    : `Permission: ${permission.label} — the current permission is not selectable from this session`
  const menu = permission.expanded
    ? ui.col(
        { key: 'composer-permission-menu', role: QUIET_COMPOSER_ROLES.permissionMenu },
        ...permission.options.map(option => html.button({
          key: `composer-permission-option-${scope}-${permission.menuEpoch}-${option.id}`,
          role: QUIET_COMPOSER_ROLES.permissionOption,
          title: option.label,
          aria: option.label,
          ...(option.selected || option.highlighted === true
            ? {
                attrs: {
                  ...(option.selected ? { 'data-current': 'true' } : {}),
                  ...(option.highlighted === true ? { 'data-highlight': 'true' } : {}),
                } as Readonly<Record<string, string>>,
              }
            : {}),
          onClick: () => input.onPermissionChoose(option.id, permission.menuEpoch),
        }, `${option.label}${option.selected ? ' ✓' : ''}`)),
      )
    : undefined

  return ui.col(
    { key: 'quiet-composer', role: QUIET_COMPOSER_ROLES.shell, gap: 'none' },
    input.editor,
    ui.row(
      { key: 'composer-controls', role: QUIET_COMPOSER_ROLES.controls, gap: 'sm', align: 'center' },
      ui.col(
        { key: 'composer-permission-stack', role: QUIET_COMPOSER_ROLES.permissionStack, gap: 'none' },
        ...(menu === undefined ? [] : [menu]),
        html.button({
          key: `composer-permission-${scope}`,
          role: QUIET_COMPOSER_ROLES.permission,
          title: permissionTitle,
          aria: 'Permission',
          ...(permission.interactive ? {} : { attrs: { 'aria-disabled': 'true' } as Readonly<Record<string, string>> }),
          onClick: () => input.onPermissionToggle(),
        }, ui.icon({ key: 'permission-icon', name: 'shield' }), `${permission.label} ${permission.expanded ? '▴' : '▾'}`),
      ),
      ui.row(
        { key: 'composer-right', role: QUIET_COMPOSER_ROLES.right, gap: 'sm', align: 'center' },
        html.button({
          key: `composer-model-${scope}`,
          role: QUIET_COMPOSER_ROLES.model,
          title: input.model.title,
          aria: 'Switch model',
          ...(input.model.interactive ? {} : { attrs: { 'aria-disabled': 'true' } as Readonly<Record<string, string>> }),
          onClick: () => input.onModel(),
        }, input.model.label),
        html.button({
          key: `composer-effort-${scope}`,
          role: QUIET_COMPOSER_ROLES.effort,
          title: input.effort.title,
          aria: 'Change reasoning effort',
          ...(input.effort.interactive ? {} : { attrs: { 'aria-disabled': 'true' } as Readonly<Record<string, string>> }),
          onClick: () => input.onEffort(),
        }, input.effort.label),
        ...(input.busy ? [html.button({
          key: `composer-stop-${scope}r${input.busyEpoch}`,
          role: QUIET_COMPOSER_ROLES.stop,
          title: 'Stop the running turn',
          aria: 'Stop the running turn',
          onClick: () => input.onStop(),
        }, 'Stop')] : []),
        html.button({
          key: `composer-send-${scope}`,
          role: QUIET_COMPOSER_ROLES.send,
          title: input.sendable ? 'Send message' : 'Type a message to send',
          aria: 'Send message',
          ...(input.sendable ? {} : { attrs: { 'aria-disabled': 'true', disabled: 'disabled' } as Readonly<Record<string, string>> }),
          onClick: () => input.onSend(),
        }, '↑'),
      ),
    ),
  )
}

/** The ONE scoped sheet: every selector starts from the two product role
 * hooks, so no rule can reach another TSP panel or Tern chrome. */
export const QUIET_COMPOSER_STYLES = `
  [data-role='dsh.composer.shell'] {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--l2);
    border-radius: 12px;
    background: var(--card);
    margin-bottom: 4px;
  }
  [data-role='dsh.composer.shell'] .sf-editor {
    min-height: calc(2 * var(--sf-lh));
    padding: 2px 2px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    outline: 0;
    color: var(--t1);
    font-family: var(--sans);
  }
  [data-role='dsh.composer.shell'] .sf-editor.focused {
    border: 0;
    box-shadow: none;
    outline: 0;
  }
  [data-role='dsh.composer.shell'] .sf-editor .sf-ed-ph {
    color: var(--t4);
  }
  [data-role='dsh.composer.shell'] .sf-editor .sf-caret {
    background: var(--accent);
  }
  [data-role='dsh.composer.controls'] {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }
  [data-role='dsh.composer.permission-stack'] {
    position: relative;
    flex-shrink: 0;
  }
  [data-role='dsh.composer.permission'] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 2px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--t2);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    cursor: pointer;
    flex-shrink: 0;
  }
  [data-role='dsh.composer.permission']:hover {
    color: var(--t1);
  }
  [data-role='dsh.composer.permission'] .sf-icon {
    color: var(--t3);
  }
  [data-role='dsh.composer.permission-menu'] {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 168px;
    padding: 4px;
    border: 1px solid var(--l2);
    border-radius: 8px;
    background: var(--pop-bg);
    box-shadow: none;
  }
  [data-role='dsh.composer.permission-menu'] [data-role='dsh.composer.permission.option'] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  [data-role='dsh.composer.permission-menu'] [data-role='dsh.composer.permission.option']:hover {
    background: rgb(from var(--t1) r g b / 4%);
  }
  [data-role='dsh.composer.permission-menu'] [data-role='dsh.composer.permission.option'][data-highlight='true'] {
    background: rgb(from var(--t1) r g b / 7%);
  }
  [data-role='dsh.composer.permission-menu'] [data-role='dsh.composer.permission.option'][data-current='true'] {
    color: var(--t1);
    font-weight: 500;
  }
  [data-role='dsh.composer.right'] {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: nowrap;
  }
  [data-role='dsh.composer.model'] {
    display: inline-block;
    flex-shrink: 1;
    max-width: 240px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 4px 2px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--t1);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  [data-role='dsh.composer.model']:hover {
    color: var(--t1);
    background: var(--l1);
  }
  [data-role='dsh.composer.effort'] {
    flex-shrink: 0;
    padding: 4px 2px;
    border: none;
    background: transparent;
    color: var(--t3);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    cursor: pointer;
  }
  [data-role='dsh.composer.effort']:hover {
    color: var(--t1);
  }
  [data-role='dsh.composer.send'] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--accent-fill);
    color: #fff;
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
  }
  [data-role='dsh.composer.send']:hover {
    filter: brightness(1.06);
  }
  [data-role='dsh.composer.send'][aria-disabled='true'] {
    opacity: 0.75;
    background: var(--l1);
    color: var(--t3);
    box-shadow: inset 0 0 0 1px var(--l3);
    cursor: not-allowed;
    filter: none;
  }
  [data-role='dsh.composer.stop'] {
    flex-shrink: 0;
    padding: 4px 10px;
    border: 1px solid rgb(from var(--bad) r g b / 35%);
    border-radius: 999px;
    background: transparent;
    color: var(--bad);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
    cursor: pointer;
  }
  [data-role='dsh.composer.stop']:hover {
    background: rgb(from var(--bad) r g b / 10%);
  }
  [data-role='dsh.footer.group'] {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0;
  }
  [data-role='dsh.footer.group'] .sf-status {
    height: var(--sf-lh);
    min-height: 0;
    line-height: var(--sf-lh);
    background: transparent;
    border: none;
    box-shadow: none;
    outline: none;
    margin: 0;
    padding-top: 0;
    padding-bottom: 0;
  }
  [data-role='dsh.footer.group'] .sf-status .sf-st-row {
    height: var(--sf-lh);
    min-height: 0;
    line-height: var(--sf-lh);
    margin: 0;
    padding-top: 0;
    padding-bottom: 0;
  }
`
