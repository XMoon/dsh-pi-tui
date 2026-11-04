/**
 * TSP-7 PR-E: the Quiet Composer v2 presentational view.
 *
 * ONE pure view over render-time read-only values and synchronous click
 * callbacks: the controlled production `ui.editor`, the left Permission
 * trigger + popup, and the right combined Model·Effort trigger (with its
 * anchored quick menu), Stop and Send inside the ONE rounded composer shell.
 * It owns no business state, no timer and no SDK session; the renderer passes
 * the already-controlled editor node and live values sampled at render time.
 *
 * The single scoped stylesheet below is the Owner-frozen v2 demo sheet mapped
 * to the product role namespace (`dsh.composer.*` / `dsh.footer.group`).
 * @module @xmoon76/dsh-pi-tui/tui/tsp/quiet-composer-view
 */

import { html, ui } from '@stencil-hq/tern'
import type { Node } from '@stencil-hq/tern'
import type {
  QuickMenuIntent,
  QuickMenuRenderState,
  QuickMenuRow,
} from './model-quick-menu.ts'
import type { SlashCompletionPopup } from './slash-completion.ts'

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
  modelStack: 'dsh.composer.model-stack',
  model: 'dsh.composer.model',
  modelName: 'dsh.composer.model-name',
  modelEffort: 'dsh.composer.model-effort',
  modelChevron: 'dsh.composer.model-chevron',
  quickMenu: 'dsh.composer.quick-menu',
  quickHead: 'dsh.composer.quick-head',
  quickItem: 'dsh.composer.quick-item',
  quickLabel: 'dsh.composer.quick-label',
  quickValue: 'dsh.composer.quick-value',
  quickScroller: 'dsh.composer.quick-scroller',
  quickFooter: 'dsh.composer.quick-footer',
  quickSearch: 'dsh.composer.quick-search',
  quickNotice: 'dsh.composer.quick-notice',
  quickEmpty: 'dsh.composer.quick-empty',
  quickFailure: 'dsh.composer.quick-failure',
  send: 'dsh.composer.send',
  stop: 'dsh.composer.stop',
  footerGroup: 'dsh.footer.group',
  // TSP I-C: the anchored slash-candidate list. It is a SIBLING of the editor
  // inside the editor's own positioning container, so it floats over the
  // transcript and takes NO layout height — the Composer box never moves.
  editorStack: 'dsh.composer.editor-stack',
  slashMenu: 'dsh.composer.slash-menu',
  slashItem: 'dsh.composer.slash-item',
  slashName: 'dsh.composer.slash-name',
  slashDescription: 'dsh.composer.slash-description',
  slashHint: 'dsh.composer.slash-hint',
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
  /** The ONE combined Model / Reasoning Effort trigger and the quick menu it
   *  anchors. The menu is a SIBLING of the button inside the trigger's own
   *  positioning container, so it floats over the editor without occupying any
   *  layout height of its own. */
  readonly modelQuick: {
    /** The model half of the label: the committed Status value, sanitized. */
    readonly name: string
    /** The effort half, or `undefined` when the selection carries none — then
     *  no empty effort slot is reserved. */
    readonly effort: string | undefined
    /** The complete sanitized Model + Effort facts, never a truncated value. */
    readonly title: string
    readonly interactive: boolean
    readonly expanded: boolean
    readonly panel: QuickMenuRenderState | undefined
  }
  readonly busy: boolean
  readonly sendable: boolean
  /**
   * TSP I-C: the slash candidate list this frame shows, or `undefined` when the
   * seat has nothing to paint. It is the SEAT's own render-time projection —
   * already filtered, already ordered by the shared provider and already
   * windowed — so this view re-sorts nothing, re-queries nothing and claims no
   * availability the catalog did not state.
   */
  readonly slash: SlashCompletionPopup | undefined
  readonly onPermissionToggle: () => void
  readonly onPermissionChoose: (id: string, menuEpoch: number) => void
  /** The combined trigger: opens, or closes, the anchored quick menu. */
  readonly onModelQuickToggle: () => void
  /** One interaction of the CURRENT menu frame. */
  readonly onModelQuickIntent: (intent: QuickMenuIntent) => void
  /** Choose ONE slash candidate of the CURRENT list frame (row id + revision). */
  readonly onSlashChoose: (id: string, revision: number) => void
  readonly onSend: () => void
  readonly onStop: () => void
}

/** One selectable menu row, bound to the intent its own frame minted. */
function quickItem(
  row: QuickMenuRow,
  onIntent: (intent: QuickMenuIntent) => void,
): Node {
  const marker = row.selected || row.highlighted
  return html.button({
    key: row.key,
    role: QUIET_COMPOSER_ROLES.quickItem,
    title: row.label,
    aria: row.label,
    ...(marker
      ? {
          attrs: {
            ...(row.selected ? { 'data-selected': 'true' } : {}),
            ...(row.highlighted ? { 'data-highlight': 'true' } : {}),
          } as Readonly<Record<string, string>>,
        }
      : {}),
    onClick: () => onIntent(row.intent),
  },
    html.span({ role: QUIET_COMPOSER_ROLES.quickLabel }, `${row.label}${row.selected ? ' ✓' : ''}`),
    ...(row.value === undefined && row.chevron === false
      ? []
      : [html.span({ role: QUIET_COMPOSER_ROLES.quickValue }, `${row.value ?? ''}${row.chevron ? ' ›' : ''}`)]),
  )
}

/** The anchored quick menu: a fixed header (Back / Search), the ONE scrolling
 *  body, and the fixed Full footer — all inside the trigger's own positioning
 *  container, so it covers the editor area without taking any layout height. */
function quickMenuNode(
  panel: QuickMenuRenderState,
  onIntent: (intent: QuickMenuIntent) => void,
): Node {
  const body: Node[] = []
  for (const section of panel.sections) {
    if (section.head !== '') {
      body.push(html.div({
        key: `${section.key}-head`,
        role: QUIET_COMPOSER_ROLES.quickHead,
      }, section.head))
    }
    for (const row of section.rows) body.push(quickItem(row, onIntent))
  }
  // A provider that failed to read is inert CONTEXT about the list, so it lives
  // INSIDE the scrolling body: its count comes from the directory and is not
  // bounded, and the fixed Back/search/Full chrome must stay reachable whatever
  // that count is (a short pane with a dozen failed providers is reachable).
  for (const failure of panel.failures) {
    body.push(html.div({
      key: failure.key,
      role: QUIET_COMPOSER_ROLES.quickFailure,
      title: failure.detail,
      aria: failure.label,
      attrs: { 'data-detail': failure.detail } as Readonly<Record<string, string>>,
    }, failure.label))
  }
  return html.div(
    {
      key: `composer-quick-menu-${panel.serial}`,
      role: QUIET_COMPOSER_ROLES.quickMenu,
      aria: 'Model and reasoning effort',
    },
    ...(panel.back === undefined ? [] : [quickItem(panel.back, onIntent)]),
    ...(panel.page === 'models'
      ? [ui.input({
          key: panel.searchKey,
          role: QUIET_COMPOSER_ROLES.quickSearch,
          text: panel.query,
          cursor: panel.cursor,
          placeholder: 'Search models…',
          aria: 'Search models',
          // A pointer click on an UNFOCUSED field is a `focus` event, not a key:
          // without this the panel would keep browsing the list while the client
          // believes the caret is in the search box. The SDK dispatches it from the
          // view it last rendered, so a stale frame's click resolves to nothing.
          onFocus: () => onIntent({ kind: 'focus-search', revision: panel.revision }),
        })]
      : []),
    ...(panel.notice === undefined
      ? []
      : [html.div({
          key: `q${panel.serial}-notice`,
          role: QUIET_COMPOSER_ROLES.quickNotice,
          attrs: { 'data-tone': panel.notice.tone } as Readonly<Record<string, string>>,
        }, panel.notice.text)]),
    html.div({ key: `q${panel.serial}-scroller`, role: QUIET_COMPOSER_ROLES.quickScroller }, ...body),
    ...(panel.empty === undefined
      ? []
      : [html.div({ key: `q${panel.serial}-empty`, role: QUIET_COMPOSER_ROLES.quickEmpty }, panel.empty)]),

    html.div(
      { key: `q${panel.serial}-footer`, role: QUIET_COMPOSER_ROLES.quickFooter },
      quickItem(panel.footer, onIntent),
    ),
  )
}

/** One row of the anchored slash-candidate list. A row is a COMPLETION, never
 *  an execution: `title`/`aria` carry the full name plus its description so a
 *  reviewer or a reader can tell two similar commands apart from the frame
 *  alone, and the highlighted row is marked by exactly one active signal. */
function slashRow(
  scope: string,
  popup: SlashCompletionPopup,
  row: SlashCompletionPopup['rows'][number],
  onChoose: (id: string, revision: number) => void,
): Node {
  const description = row.description ?? ''
  const full = description === '' ? row.name : `${row.name} — ${description}`
  return html.button({
    key: `slash-${scope}-${popup.revision}-${row.id.replace(/[^A-Za-z0-9._-]+/g, '_')}`,
    role: QUIET_COMPOSER_ROLES.slashItem,
    title: full,
    aria: full,
    ...(row.highlighted
      ? { attrs: { 'data-highlight': 'true' } as Readonly<Record<string, string>> }
      : {}),
    onClick: () => onChoose(row.id, popup.revision),
  },
    html.span({ role: QUIET_COMPOSER_ROLES.slashName }, `${row.highlighted ? '›' : ' '}${row.name}`),
    ...(description === ''
      ? []
      : [html.span({ role: QUIET_COMPOSER_ROLES.slashDescription }, description)]),
  )
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

  const slashMenu = input.slash === undefined || input.slash.rows.length === 0
    ? undefined
    : ui.col(
        {
          key: `composer-slash-menu-${input.scope}-${input.slash.revision}`,
          role: QUIET_COMPOSER_ROLES.slashMenu,
          aria: 'Slash command candidates',
          gap: 'none',
        },
        ...input.slash.rows.map(row => slashRow(
          input.scope,
          input.slash!,
          row,
          input.onSlashChoose,
        )),
        ui.text({
          key: `composer-slash-hint-${input.slash.revision}`,
          wrap: 'none',
          text: '↑↓ select · Tab/Enter complete · Esc close',
        }),
      )

  return ui.col(
    { key: 'quiet-composer', role: QUIET_COMPOSER_ROLES.shell, gap: 'none' },
    // The editor plus its OWN positioning container: the candidate list floats
    // up from the editor and covers the transcript, so it takes no layout row
    // and the Composer, the control line and the Footer never move.
    ui.col(
      { key: 'composer-editor-stack', role: QUIET_COMPOSER_ROLES.editorStack, gap: 'none' },
      ...(slashMenu === undefined ? [] : [slashMenu]),
      input.editor,
    ),
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
        html.div(
          { key: 'composer-model-stack', role: QUIET_COMPOSER_ROLES.modelStack },
          html.button({
            key: `composer-model-quick-${scope}`,
            role: QUIET_COMPOSER_ROLES.model,
            title: input.modelQuick.title,
            aria: 'Model and reasoning effort',
            ...(input.modelQuick.interactive ? {} : { attrs: { 'aria-disabled': 'true' } as Readonly<Record<string, string>> }),
            onClick: () => input.onModelQuickToggle(),
          },
            // The three label parts carry explicit KEYS: the effort part appears
            // and disappears with the committed fact, and without a key the SDK
            // would address the children by position — remounting the chevron
            // under the pointer every time a model gains or loses an effort.
            html.span({ key: 'model-name', role: QUIET_COMPOSER_ROLES.modelName }, input.modelQuick.name),
            ...(input.modelQuick.effort === undefined
              ? []
              : [html.span({ key: 'model-effort', role: QUIET_COMPOSER_ROLES.modelEffort }, `· ${input.modelQuick.effort}`)]),
            html.span(
              { key: 'model-chevron', role: QUIET_COMPOSER_ROLES.modelChevron },
              input.modelQuick.expanded ? '▴' : '▾',
            ),
          ),
          ...(input.modelQuick.expanded && input.modelQuick.panel !== undefined
            ? [quickMenuNode(input.modelQuick.panel, (intent) => input.onModelQuickIntent(intent))]
            : []),
        ),
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
  /* The two dropdown triggers carry the menu's own soft rounding, so a hover
     paints a rounded block instead of a square one beside the round Send. */
  [data-role='dsh.composer.permission'] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 0;
    border-radius: 8px;
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
  /* The combined Model / Effort trigger is ONE flex child of composer-right and
     the direct positioning container of its menu, so a Stop button inserted to
     its right never moves the menu anchor. */
  [data-role='dsh.composer.model-stack'] {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-width: 0;
    flex-shrink: 1;
  }
  [data-role='dsh.composer.model'] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex-shrink: 1;
    padding: 4px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
    text-align: left;
    cursor: pointer;
  }
  [data-role='dsh.composer.model']:hover {
    background: var(--l1);
  }
  [data-role='dsh.composer.model'][aria-disabled='true'] {
    color: var(--t3);
    cursor: not-allowed;
  }
  [data-role='dsh.composer.model'] [data-role='dsh.composer.model-name'] {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-role='dsh.composer.model'] [data-role='dsh.composer.model-effort'] {
    color: var(--t3);
    flex-shrink: 0;
    white-space: nowrap;
  }
  [data-role='dsh.composer.model'] [data-role='dsh.composer.model-chevron'] {
    color: var(--t3);
    flex-shrink: 0;
    width: 10px;
    text-align: center;
  }
  /* The quick menu is anchored to the trigger it belongs to: it floats UP from
     the button, right-aligned with it, and MAY cover the editor. It takes no
     layout height, so the Composer box and the transcript scroll never move. */
  [data-role='dsh.composer.quick-menu'] {
    position: absolute;
    right: 0;
    bottom: calc(100% + 4px);
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 300px;
    max-width: min(320px, calc(100vw - 24px));
    /* The budget must fit the space ABOVE the trigger inside the pane, not just
       a fraction of the viewport: measured on the client, the shortest supported
       pane (900x360) leaves ~224px above the trigger, and a 65vh menu overflowed
       the top of the pane and cut Back and the search field. 55vh keeps the whole
       anchored menu inside the pane at every supported size and still caps at
       440px on a normal one. */
    max-height: min(440px, 55vh);
    padding: 4px;
    border: 1px solid var(--l2);
    border-radius: 8px;
    background: var(--pop-bg);
    box-shadow: none;
  }
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-scroller'] {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
    min-height: 0;
  }
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-head'] {
    padding: 6px 8px 2px;
    color: var(--t3);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
  }
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-item'] {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 32px;
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
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-item']:hover {
    background: rgb(from var(--t1) r g b / 4%);
    color: var(--t1);
  }
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-item'][data-highlight='true'] {
    background: rgb(from var(--t1) r g b / 7%);
    color: var(--t1);
  }
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-item'][data-selected='true'] {
    color: var(--t1);
    font-weight: 500;
  }
  /* The row's own text is the thing that must survive a narrow anchor: a model
     name truncates here. The right-hand summary is secondary, so IT truncates
     first and never eats the row's label (measured on the pinned client: with a
     non-shrinking value the 300px menu dropped the leading word entirely). */
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-label'] {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }
  [data-role='dsh.composer.quick-menu'] [data-role='dsh.composer.quick-value'] {
    color: var(--t3);
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }
  [data-role='dsh.composer.quick-search'] {
    margin: 2px 4px;
  }
  [data-role='dsh.composer.quick-notice'] {
    padding: 4px 8px;
    color: var(--t3);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
  }
  [data-role='dsh.composer.quick-notice'][data-tone='error'] {
    color: var(--bad);
  }
  [data-role='dsh.composer.quick-empty'] {
    padding: 4px 8px;
    color: var(--t4);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.5;
  }
  [data-role='dsh.composer.quick-failure'] {
    padding: 2px 8px;
    color: var(--bad);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
  }
  [data-role='dsh.composer.quick-footer'] {
    display: flex;
    flex-direction: column;
    padding-top: 4px;
    border-top: 1px solid var(--l1);
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
  /* TSP I-C: the editor's own positioning container. It adds no box, no padding
     and no height of its own — the editor keeps the exact metrics it had as a
     direct child of the shell — so introducing it cannot move the Composer. */
  [data-role='dsh.composer.editor-stack'] {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* The candidate list floats UP from the editor and MAY cover the transcript.
     It takes no layout height, so the Composer box and the transcript scroll
     never move (the same anchored pattern the Model quick menu already uses).
     The budget stays inside the pane at every supported size: a short pane has
     the least room above the editor, so the list caps low and scrolls. */
  [data-role='dsh.composer.slash-menu'] {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 4px);
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: min(220px, 40vh);
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--l2);
    border-radius: 8px;
    background: var(--pop-bg);
    box-shadow: none;
  }
  [data-role='dsh.composer.slash-item'] {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
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
  [data-role='dsh.composer.slash-item']:hover {
    background: rgb(from var(--t1) r g b / 4%);
    color: var(--t1);
  }
  [data-role='dsh.composer.slash-item'][data-highlight='true'] {
    background: rgb(from var(--t1) r g b / 7%);
    color: var(--t1);
  }
  /* The command name is the thing that must survive a narrow anchor; the
     description is secondary and truncates first, so a row never loses its
     leading slash-name (the same rule the quick menu's label/value pair
     follows). */
  [data-role='dsh.composer.slash-name'] {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--t1);
  }
  [data-role='dsh.composer.slash-description'] {
    color: var(--t3);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }
  [data-role='dsh.composer.slash-menu'] .sf-text {
    padding: 2px 8px;
    color: var(--t4);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.4;
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
