/**
 * TSP-7 Welcome D: the native empty-state view that occupies the Main region.
 *
 * ONE pure presentational view over already-committed facts: the shared whale
 * asset (plain rows, coloured by CSS), the product name, the formally
 * committed TUI version, the single Resume action and one static tip. It owns
 * no Session facts, no listing, no focus and no business state: the renderer
 * passes the version it already committed, the whale rows of the mount's ONE
 * pick, and the real availability of the registered `/sessions` UI entry.
 *
 * The Dock stays the ONE Quiet Composer; this view never renders into it, and
 * a client that negotiated neither `el` nor `styles` gets the plain text
 * fallback with no claim of a clickable affordance.
 * @module @xmoon76/dsh-pi-tui/tui/tsp/welcome-view
 */

import { html, ui } from '@stencil-hq/tern'
import type { Node } from '@stencil-hq/tern'
import { welcomeWhaleGradientColors } from '../components/welcome-whale.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

/** The ONE surface-scoped stylesheet name the renderer installs for this view. */
export const TSP_WELCOME_SHEET = 'dsh-welcome'

/** The product name line (the same identity the PiTui Welcome card states). */
const WELCOME_PRODUCT_NAME = 'dsh-pi-tui'

/** The static tip line; it is never random, animated or fetched. */
const WELCOME_TIP = 'Tip: Type / to browse commands.'

/** The unavailable-state reason: the typed command stays the working route. */
const WELCOME_RESUME_UNAVAILABLE = 'Resume is unavailable here — type /sessions to browse sessions'

/** The frozen role namespace of this view (`dsh.welcome.*`, never `welcome.*`). */
const ROLES = {
  stage: 'dsh.welcome.stage',
  box: 'dsh.welcome.box',
  whale: 'dsh.welcome.whale',
  whaleLine: (index: number): string => `dsh.welcome.whale-line-${index}`,
  brand: 'dsh.welcome.brand',
  name: 'dsh.welcome.name',
  version: 'dsh.welcome.version',
  resume: 'dsh.welcome.resume',
  resumeIcon: 'dsh.welcome.resume-icon',
  resumeLabel: 'dsh.welcome.resume-label',
  resumeArrow: 'dsh.welcome.resume-arrow',
  tip: 'dsh.welcome.tip',
} as const

/** The render-time input: committed facts plus ONE action and ONE scope key. */
export interface WelcomeViewInput {
  /** The formally committed `StatusSnapshot.host.tuiVersion`; `undefined`
   *  while no status commit has landed, which draws NO version line. */
  readonly tuiVersion: string | undefined
  /** The mount's ONE whale pick, as ANSI-free plain rows. */
  readonly whaleLines: readonly string[]
  /** Whether the registered `/sessions` UI entry really exists right now. */
  readonly resumeAvailable: boolean
  /** Whether this client negotiated BOTH `el` and `styles` (the styled path). */
  readonly nativeStyled: boolean
  /** Whether this client negotiated the `icon` KIND. `el`+`styles` do NOT
   *  imply it, so the leading icon is sent only when the pane really paints
   *  one; without it the action keeps its label and arrow and claims nothing. */
  readonly nativeIcon: boolean
  /** The presentation scope prefix of the current subject (`s<epoch>-`); the
   *  action key rides it so a retired subject's button can never act. */
  readonly scopeKey: string
  readonly workspacePath?: string
  readonly workspaceStatus?: 'proposed' | 'verifying' | 'confirmed' | 'rejected'
  readonly workspaceError?: string
  readonly onChooseDirectory?: () => void
  readonly onResume: () => void
}

/** The brand ramp, read ONCE from the shared whale asset (never a second copy). */
const WHALE_RAMP: readonly string[] = welcomeWhaleGradientColors()

/** The whale row colours as scoped rules, generated from the ONE ramp. */
const WHALE_LINE_STYLES = WHALE_RAMP
  .map((color, index) => `[data-role='${ROLES.whaleLine(index)}'] { color:${color}; }`)
  .join('\n')

/**
 * The ONE scoped sheet for this view. Selectors stay inside `dsh.welcome.*`,
 * so no rule can reach the composer's `dsh.composer.*` or another panel.
 */
export const TSP_WELCOME_STYLES = `
  [data-role='${ROLES.stage}'] {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    min-height:clamp(260px,calc(100vh - 190px),560px);
    padding:0 16px; box-sizing:border-box; min-width:0;
  }
  [data-role='${ROLES.box}'] {
    display:flex; flex-direction:column; align-items:center;
    gap:14px; max-width:100%; text-align:center;
  }
  [data-role='${ROLES.whale}'] {
    font:13px/1.17 var(--mono); white-space:pre; flex-shrink:0; letter-spacing:0;
  }
  [data-role^='dsh.welcome.whale-line-'] { white-space:pre; line-height:1.17; }
  ${WHALE_LINE_STYLES}
  [data-role='${ROLES.brand}'] { display:flex; flex-direction:column; align-items:center; gap:4px; }
  [data-role='${ROLES.name}'] {
    font:600 24px/1.25 var(--sans); color:var(--t1); white-space:nowrap;
  }
  [data-role='${ROLES.version}'] {
    font:12px var(--mono); color:var(--t3); white-space:nowrap;
  }
  [data-role='${ROLES.resume}'] {
    display:flex; align-items:center; justify-content:center;
    gap:8px; width:max-content; max-width:100%;
    border:1px solid var(--l2); border-radius:8px; background:var(--l1);
    padding:8px 12px; color:var(--t1); font:12px var(--sans); cursor:pointer;
  }
  [data-role='${ROLES.resume}']:hover { background:var(--l2); }
  [data-role='${ROLES.resume}']:focus-visible { outline:2px solid var(--t1); outline-offset:2px; }
  [data-role='${ROLES.resume}'][disabled] {
    cursor:not-allowed; opacity:0.6;
  }
  [data-role='${ROLES.resumeIcon}'], [data-role='${ROLES.resumeArrow}'] { color:var(--t3); }
  [data-role='${ROLES.tip}'] {
    font:12px var(--sans); color:var(--t3); text-align:center; margin-top:8px;
  }
  @media(max-width:520px) {
    [data-role='${ROLES.stage}'] { padding-left:12px; padding-right:12px; }
    [data-role='${ROLES.name}'] { font-size:21px; }
  }
  @media(max-height:420px) {
    [data-role='${ROLES.stage}'] { padding-top:10px; min-height:0; }
    [data-role='${ROLES.box}'] { padding:10px 14px; gap:6px; }
    [data-role='${ROLES.whale}'] { font-size:10px; }
    [data-role='${ROLES.name}'] { font-size:18px; }
    [data-role='${ROLES.version}'] { font-size:10px; }
    [data-role='${ROLES.tip}'] { display:none; }
    [data-role='${ROLES.resume}'] { padding:5px 9px; }
  }
`

/** The styled D layout: centred stage, whale, brand, ONE action, tip. */
function styledWelcome(input: WelcomeViewInput): Node {
  const rows = input.whaleLines.map((line, index) => html.div(
    { key: `welcome-whale-line-${index}`, role: ROLES.whaleLine(index) },
    line,
  ))
  const version = input.tuiVersion === undefined
    ? undefined
    : `v${sanitizeDisplayText(input.tuiVersion)} · DeepSeek Harness`
  return ui.col(
    { key: 'welcome-main', gap: 'none' },
    html.div({ key: 'welcome-stage', role: ROLES.stage },
      html.div({ key: 'welcome-box', role: ROLES.box },
        html.div({ key: 'welcome-whale', role: ROLES.whale }, ...rows),
        html.div({ key: 'welcome-brand', role: ROLES.brand },
          html.div({ key: 'welcome-name', role: ROLES.name }, WELCOME_PRODUCT_NAME),
          ...(version === undefined
            ? []
            : [html.div({ key: 'welcome-version', role: ROLES.version }, version)]),
        ),
        ...(input.workspacePath === undefined ? [] : [html.div({ key: 'welcome-workspace', role: ROLES.tip }, `${input.workspaceStatus === 'confirmed' ? 'Host directory' : input.workspaceStatus === 'rejected' ? 'Host directory unavailable' : input.workspaceStatus === 'verifying' ? 'Checking Host directory' : 'Proposed directory'}: ${sanitizeDisplayText(input.workspacePath)}`)]),
        ...(input.workspaceError === undefined ? [] : [html.div({ key: 'welcome-workspace-error', role: ROLES.tip }, sanitizeDisplayText(input.workspaceError))]),
        html.button({ key: `welcome-choose-${input.scopeKey}`, role: ROLES.resume, title: 'Choose a Host directory', attrs: { 'aria-label': 'Choose directory' }, onClick: () => input.onChooseDirectory?.() }, html.span({ key: 'welcome-choose-label', role: ROLES.resumeLabel }, 'Choose directory')),

        html.button({
          key: `welcome-resume-${input.scopeKey}`,
          role: ROLES.resume,
          title: input.resumeAvailable ? 'Open the existing Session Browser' : WELCOME_RESUME_UNAVAILABLE,
          attrs: input.resumeAvailable
            ? { 'aria-label': 'Resume session' } as Readonly<Record<string, string>>
            : { 'aria-label': 'Resume session', 'aria-disabled': 'true', disabled: 'disabled' } as Readonly<Record<string, string>>,
          ...(input.resumeAvailable ? { onClick: () => input.onResume() } : {}),
        },
          // The icon is the CLIENT's own icon vocabulary, never a hand-painted
        // glyph: `↶` is already the icon registry's `context-recall` mark and
        // the design language forbids one glyph carrying two meanings in one
        // family (docs/architecture/design-language.md §4.4 + the width gate).
        // It is sent ONLY when the pane negotiated the `icon` kind — a node
        // the client cannot paint is a false affordance, not a decoration.
        ...(input.nativeIcon
          ? [ui.icon({ key: 'welcome-resume-icon', role: ROLES.resumeIcon, name: 'history' })]
          : []),
          html.span({ key: 'welcome-resume-label', role: ROLES.resumeLabel }, 'Resume session'),
          html.span({ key: 'welcome-resume-arrow', role: ROLES.resumeArrow }, '›'),
        ),
        html.div({ key: 'welcome-tip', role: ROLES.tip }, WELCOME_TIP),
      ),
    ),
  )
}

/**
 * The unstyled fallback for a client that negotiated neither `el` nor
 * `styles`: plain text only, and NO claim of a clickable affordance — the
 * typed `/sessions` command stays the route there.
 */
function plainWelcome(input: WelcomeViewInput): Node {
  return ui.col(
    { key: 'welcome-main', gap: 'sm', align: 'center' },
    ui.text({ key: 'welcome-name', text: WELCOME_PRODUCT_NAME }),
    ...(input.tuiVersion === undefined
      ? []
      : [ui.text({
          key: 'welcome-version',
          text: sanitizeDisplayText(`v${input.tuiVersion} · DeepSeek Harness`),
        })]),
    ui.text({ key: 'welcome-resume-hint', text: 'Use /sessions to resume' }),
  )
}

/** Build the Welcome Main view for the current mount and subject. */
export function welcomeView(input: WelcomeViewInput): Node {
  return input.nativeStyled ? styledWelcome(input) : plainWelcome(input)
}
