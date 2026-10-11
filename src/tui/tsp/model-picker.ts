/** Native /model presentation only. All reads, writes and settlements are
 * injected by the existing command; the official SDK remains the tty owner.
 */
import { ui, View, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import type {
  ModelPresentation,
  ModelPickerRequest,
  ModelPickerHandle,
  ModelPickerDirectory,
} from '../../app/command/model-presentation.ts'
import {
  projectModelDirectory,
  effortChoicesOf,
  initialEffortOf,
  PROVIDER_DEFAULT,
  type ModelPickerModelRow,
} from '../pickers/model-directory.ts'

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const boundaries = (text: string): number[] =>
  [...segmenter.segment(text)].map((s) => s.index).concat(text.length)
const rowId = (row: ModelPickerModelRow): string => JSON.stringify([row.providerId, row.modelId])
interface Panel {
  readonly serial: number
  readonly request: ModelPickerRequest
  revision: number
  disposed: boolean
  phase: 'loading' | 'ready' | 'error' | 'pending'
  page: 'models' | 'details' | 'effort'
  query: string
  cursor: number
  selected: string | undefined
  notice: string
  directory: ModelPickerDirectory | undefined
  rows: readonly ModelPickerModelRow[]
  efforts: Map<string, string>
}

export class TspModelPicker {
  private readonly render: () => void
  private readonly canInteract: () => boolean
  private readonly notify: ModelPresentation['notify']
  private panel: Panel | undefined
  private serial = 0
  private targets = new Map<string, { panel: Panel; revision: number }>()
  private cols = 120
  private suspended = false

  constructor(deps: {
    render(): void
    canInteract(): boolean
    notify: ModelPresentation['notify']
  }) {
    this.render = deps.render
    this.canInteract = deps.canInteract
    this.notify = deps.notify
  }

  readonly presentation: ModelPresentation = {
    open: (request) => this.open(request),
    notify: (message, kind) => {
      this.notify(message, kind)
    },
  }

  private current(): Panel | undefined {
    const p = this.panel
    if (p === undefined || p.disposed) return undefined
    if (!p.request.isCurrent()) {
      this.retire()
      return undefined
    }
    return p
  }

  private open(request: ModelPickerRequest): ModelPickerHandle {
    this.retire()
    const p: Panel = {
      serial: ++this.serial,
      request,
      revision: 0,
      disposed: false,
      phase: 'loading',
      page: 'models',
      query: '',
      cursor: 0,
      selected: undefined,
      notice: '',
      directory: undefined,
      rows: [],
      efforts: new Map(),
    }
    this.panel = p
    this.change(p)
    return {
      isDisposed: () => p.disposed,
      close: () => {
        if (p.disposed) return
        p.disposed = true
        if (this.panel === p) {
          this.panel = undefined
          this.targets.clear()
          this.render()
        }
      },
      setLoadError: (message) => {
        if (this.current() !== p) return
        p.phase = 'error'
        p.notice = message + ' — reopen /model to retry'
        this.change(p)
      },
      setDirectory: (directory) => {
        if (this.current() !== p) return
        const rows = projectModelDirectory(
          directory.directory,
          directory.current,
          directory.sessionless,
        ).models
        const previous = p.efforts
        p.directory = directory
        p.rows = rows
        p.efforts = new Map()
        for (const row of rows) {
          const id = rowId(row),
            choices = effortChoicesOf(row),
            old = previous.get(id)
          const next =
            old !== undefined && choices.some((c) => c.value === old)
              ? old
              : initialEffortOf(row, choices)
          if (next !== undefined) p.efforts.set(id, next)
        }
        if (p.selected === undefined) {
          const configured = rows.find((r) => directory.sessionless ? r.isDefault : r.isCurrent)
          p.selected = configured === undefined ? undefined : rowId(configured)
        }
        p.phase = 'ready'
        this.align(p)
        this.change(p)
      },
    }
  }

  /** Synchronous local retirement: no write cancellation and no render IO.
   * The renderer's hydration/disposal frame owns the next repaint. */
  retire(): void {
    if (this.panel !== undefined) this.panel.disposed = true
    this.panel = undefined
    this.targets.clear()
  }
  isOpen(): boolean {
    return this.current() !== undefined
  }
  resize(cols: number): void {
    this.cols = cols
  }
  suspend(): void {
    if (!this.suspended) {
      this.suspended = true
      if (this.panel !== undefined) this.panel.revision++
      this.targets.clear()
    }
  }
  desiredFocusId(): string | undefined {
    return this.targets.keys().next().value
  }
  private visible(p: Panel): readonly ModelPickerModelRow[] {
    const q = p.query.toLowerCase()
    return p.rows.filter((r) =>
      `${r.providerName} ${r.providerId} ${r.modelName} ${r.modelId}`.toLowerCase().includes(q),
    )
  }
  private row(p: Panel): ModelPickerModelRow | undefined {
    return this.visible(p).find((r) => rowId(r) === p.selected)
  }
  private align(p: Panel): void {
    if (this.row(p) === undefined)
      p.selected = this.visible(p)[0] === undefined ? undefined : rowId(this.visible(p)[0]!)
  }
  private change(p: Panel): void {
    p.revision++
    if (this.panel === p && !p.disposed) this.render()
  }
  private close(p: Panel): void {
    p.disposed = true
    if (this.panel === p) {
      this.panel = undefined
      this.targets.clear()
      this.render()
    }
  }

  private act(p: Panel, revision: number, action: string, value?: string): void {
    if (!this.canInteract() || this.current() !== p || p.revision !== revision) return
    if (action === 'close') {
      this.close(p)
      return
    }
    if (p.phase !== 'ready') return
    if (action === 'browse') {
      if (!this.visible(p).some((r) => rowId(r) === value)) return
      p.selected = value
      this.change(p)
      return
    }
    if (action === 'clear') {
      p.query = ''
      p.cursor = 0
      this.align(p)
      this.change(p)
      return
    }
    if (action === 'back') {
      p.page = 'models'
      this.change(p)
      return
    }
    const row = this.row(p)
    if (row === undefined) return
    if (action === 'details') {
      p.page = 'details'
      this.change(p)
      return
    }
    const choices = effortChoicesOf(row)
    if (action === 'effort') {
      if (!choices.some((c) => c.value === value)) return
      p.efforts.set(rowId(row), value!)
      this.change(p)
      return
    }
    if (action !== 'apply') return
    if (choices.length > 0 && p.page !== 'effort') {
      p.page = 'effort'
      this.change(p)
      return
    }
    const effort = p.efforts.get(rowId(row))
    if (choices.length > 0 && !choices.some((c) => c.value === effort)) return
    const selection =
      effort === undefined || effort === PROVIDER_DEFAULT
        ? { provider: row.providerId, model: row.modelId }
        : { provider: row.providerId, model: row.modelId, reasoningEffort: effort }
    p.notice = ''
    p.phase = 'pending'
    this.change(p)
    p.request.runOwned('model selection', () => p.request.apply(selection), {
      isCancellation: () => p.disposed,
      onResult: (outcome) => {
        if (this.current() !== p || outcome === 'superseded') return
        if (outcome === 'committed' || outcome === 'indeterminate') {
          this.close(p)
          return
        }
        p.phase = 'ready'
        p.page = 'models'
        p.notice ||= `Model selection ${outcome}.`
        this.change(p)
      },
      onError: () => {
        if (this.current() !== p) return
        p.phase = 'ready'
        p.page = 'models'
        p.notice = 'Model selection could not complete.'
        this.change(p)
      },
    })
  }

  handleKey(key: Key): boolean {
    const p = this.current()
    if (p === undefined) return false
    if (!this.canInteract()) return true
    if (key.ctrl === true && key.name === 'c') return false // original interrupt owner
    if (key.name === 'escape') {
      if (p.page !== 'models' && p.phase === 'ready') {
        p.page = 'models'
        this.change(p)
      } else this.close(p)
      return true
    }
    if (p.phase === 'pending' || p.phase === 'error') return true
    if (key.name === 'enter') {
      this.act(p, p.revision, 'apply')
      return true
    }
    if (key.name === 'tab' && p.phase === 'ready') {
      this.act(p, p.revision, p.page === 'models' ? 'details' : 'back')
      return true
    }
    if (key.ctrl || key.alt || key.meta) return true
    if (p.page === 'effort' && (key.name === 'left' || key.name === 'right')) {
      const row = this.row(p)
      if (row !== undefined) {
        const cs = effortChoicesOf(row),
          i = cs.findIndex((c) => c.value === p.efforts.get(rowId(row)))
        const next = cs[(Math.max(i, 0) + (key.name === 'left' ? -1 : 1) + cs.length) % cs.length]
        if (next !== undefined) this.act(p, p.revision, 'effort', next.value)
      }
      return true
    }
    if (p.page !== 'models') return true
    if (key.name === 'up' || key.name === 'down') {
      const rows = this.visible(p),
        i = rows.findIndex((r) => rowId(r) === p.selected)
      const next = rows[(Math.max(i, 0) + (key.name === 'up' ? -1 : 1) + rows.length) % rows.length]
      if (next !== undefined) this.act(p, p.revision, 'browse', rowId(next))
      return true
    }
    const bs = boundaries(p.query)
    if (key.name === 'left' || key.name === 'right')
      p.cursor =
        key.name === 'left'
          ? (bs.filter((i) => i < p.cursor).at(-1) ?? 0)
          : (bs.find((i) => i > p.cursor) ?? p.query.length)
    else if (key.name === 'backspace') {
      const start = bs.filter((i) => i < p.cursor).at(-1) ?? 0
      p.query = p.query.slice(0, start) + p.query.slice(p.cursor)
      p.cursor = start
    } else if (key.name === 'delete') {
      const end = bs.find((i) => i > p.cursor) ?? p.query.length
      p.query = p.query.slice(0, p.cursor) + p.query.slice(end)
    } else if (key.name === 'home' || key.name === 'end') {
      p.cursor = key.name === 'home' ? 0 : p.query.length
    } else if (key.text !== undefined) {
      p.query = p.query.slice(0, p.cursor) + key.text + p.query.slice(p.cursor)
      const raw = p.cursor + key.text.length
      p.cursor = boundaries(p.query).find((i) => i >= raw) ?? p.query.length
    } else return true
    this.align(p)
    this.change(p)
    return true
  }

  handleEvent(event: TspEvent): boolean {
    const target =
      'id' in event && typeof event.id === 'string' ? this.targets.get(event.id) : undefined
    if (target === undefined) return false
    if (event.ev === 'select' || event.ev === 'activate')
      this.act(target.panel, target.revision, 'browse', event.item)
    else if (event.ev === 'action') this.act(target.panel, target.revision, event.act, event.value)
    return true
  }

  renderLayer(): Node | undefined {
    this.targets.clear()
    const p = this.current()
    if (p === undefined) return undefined
    if (this.suspended) {
      this.suspended = false
      p.revision++
    }
    const revision = p.revision,
      row = this.row(p),
      d = p.directory
    const summary =
      (d?.sessionless ? 'Default: ' : 'Current: ') +
      (d?.current === undefined
        ? 'Unknown'
        : `${d.current.provider} / ${d.current.model}${d.current.reasoningEffort === undefined ? '' : ' · ' + d.current.reasoningEffort}`)
    const button = (action: string, label: string, disabled = false, value?: string): Node =>
      ui.el({
        key: action + (value === undefined ? '' : '-' + encodeURIComponent(value)),
        tag: 'button',
        role: 'model-action',
        text: label,
        class: disabled ? 'model-action-disabled' : undefined,
        attrs: disabled ? { 'aria-disabled': 'true' } : undefined,
        onClick: disabled ? undefined : () => this.act(p, revision, action, value),
      })
    const choices = row === undefined ? [] : effortChoicesOf(row)
    const primary =
      p.phase === 'pending'
        ? 'Selecting…'
        : choices.length > 0 && p.page !== 'effort'
          ? 'Choose effort'
          : d?.sessionless
            ? 'Save default'
            : 'Apply'
    const description =
      row === undefined
        ? undefined
        : d?.directory.groups
            .find((g) => g.id === row.providerId)
            ?.models.find((m) => m.id === row.modelId)?.description
    const details =
      row === undefined
        ? ui.text('No matching selectable model.')
        : ui.card(
            { head: row.modelName },
            ui.text('Provider: ' + row.providerName),
            ui.text('ID: ' + row.modelId),
            ui.text(description ?? 'No description advertised.'),
            ui.text(
              'Draft effort: ' +
                (choices.find((c) => c.value === p.efforts.get(rowId(row)))?.label ??
                  'Not advertised'),
            ),
          )
    const header = ui.card(
      { head: d?.sessionless ? 'Default for new sessions' : 'Use for this session' },
      ui.text(summary),
      ui.text(p.notice || 'Browsing does not apply a model.'),
    )
    const epoch = 'model-' + p.serial + '-rev-' + revision
    const items = this.visible(p).map((r) => ({
      id: rowId(r),
      label: r.modelName,
      detail: r.providerName,
      title: r.modelId,
      badges: [
        ...(r.isDefault ? [{ text: 'Default' }] : []),
        ...(r.currentEffort === undefined ? [] : [{ text: r.currentEffort + ' current' }]),
      ],
    }))
    if (!p.query)
      for (const [i, f] of (d?.directory.failures ?? []).entries())
        items.push({ id: 'failure-' + i, label: f.name, detail: f.message, title: '', badges: [] })
    const layer =
      p.page !== 'models'
        ? ui.col(
            {},
            ui.overlay(
              {
                key: epoch,
                anchor: 'center',
                size: 'full',
                head: p.page === 'effort' ? 'Choose effort' : 'Model details',
              },
              header,
              details,
              ...(p.page === 'effort'
                ? [
                    ui.row(
                      { gap: 'sm', wrap: true },
                      ...choices.map((c) =>
                        button(
                          'effort',
                          c.label + (c.value === p.efforts.get(rowId(row!)) ? ' ✓' : ''),
                          p.phase !== 'ready',
                          c.value,
                        ),
                      ),
                    ),
                  ]
                : []),
              ui.row(
                { gap: 'sm', wrap: true },
                button('back', 'Back', p.phase !== 'ready'),
                button('close', 'Close'),
                button('apply', primary, p.phase !== 'ready' || row === undefined),
              ),
            ),
          )
        : ui.col(
            {},
            ui.picker(
              {
                key: epoch,
                title: 'Models',
                subtitle: d?.sessionless ? 'Default for new sessions' : 'Use for this session',
                query: p.query,
                cursor: p.cursor,
                selected: row === undefined ? undefined : rowId(row),
                current: p.rows.filter((r) => r.isCurrent).map(rowId),
                items: items.map((i) =>
                  i.id.startsWith('failure-') ? { ...i, disabled: 'Unavailable provider' } : i,
                ),
                order: items.map((i) => i.id),
                size: 'md',
                layout: 'rows',
                preview: this.cols >= 120 ? 'side' : 'none',
                state: p.phase === 'loading' ? 'loading' : p.phase === 'error' ? 'error' : 'ready',
                message: p.phase === 'error' ? p.notice : undefined,
                empty: 'No matching models. Clear search to continue.',
                strip: { label: p.notice || summary, items: [] },
                actions: [
                  { id: 'close', label: 'Close', end: true },
                  {
                    id: 'clear',
                    label: 'Clear search',
                    disabled: !p.query || p.phase !== 'ready' ? true : undefined,
                  },
                  {
                    id: 'details',
                    label: 'Details',
                    disabled: row === undefined || p.phase !== 'ready' ? true : undefined,
                  },
                  {
                    id: 'apply',
                    label: primary,
                    primary: true,
                    disabled: row === undefined || p.phase !== 'ready' ? true : undefined,
                  },
                ],
              },
              header,
              details,
            ),
          )
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        if (node.kind === 'picker' || node.kind === 'overlay')
          this.targets.set(node.id, { panel: p, revision })
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }
}
