/**
 * In-place submenu components for `/model`: the model list and the
 * reasoning-effort list render INSIDE the SettingsList's submenu slot
 * (the fork's `SettingItem.submenu` mechanism), so no second overlay is
 * ever mounted. A nested `openSettings` would leave the outer panel
 * mounted beneath the inner one and layered Esc handling — the ghost
 * overlay the `/subagents` flow warns about. Each level's Esc returns to
 * the level above; selecting a model or effort applies it immediately.
 * @module @dsh-pi-tui/tui-app/model-menu
 */
import { SettingsList, Text, matchesKey } from '@dsh-pi-tui/pi-tui';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { settingsListTheme } from "./theme.js";
/**
 * Wrap a loading/error child so Esc still returns to the parent list while
 * the real content is pending.
 */
class EscDismiss {
    child;
    onEsc;
    constructor(child, onEsc) {
        this.child = child;
        this.onEsc = onEsc;
    }
    handleInput(data) {
        if (matchesKey(data, 'escape')) {
            this.onEsc();
            return;
        }
        this.child.handleInput?.(data);
    }
    invalidate() {
        this.child.invalidate?.();
    }
    render(width) {
        return this.child.render(width);
    }
}
/** The reasoning-effort picker for one model; applies on selection. */
class EffortSubmenu {
    inner;
    requestRender;
    constructor(providerId, modelId, currentEffort, deps) {
        const applyAndClose = (effortId) => {
            deps.apply(effortId === undefined || effortId === '__default'
                ? { provider: providerId, model: modelId }
                : { provider: providerId, model: modelId, reasoningEffort: ReasoningEffortId(effortId) });
            deps.done(effortId);
        };
        this.inner = new EscDismiss(new Text('Loading model info…', 0, 0), () => deps.done());
        this.requestRender = deps.requestRender;
        void deps.resolveModelInfo(providerId, modelId).then(info => {
            const efforts = info.reasoning?.efforts;
            if (efforts === undefined || efforts.length === 0) {
                // No effort choice: apply the model directly and return to the list.
                applyAndClose(undefined);
                return;
            }
            this.inner = new SettingsList([
                {
                    id: '__default',
                    label: 'Default',
                    description: 'Provider default reasoning effort',
                    currentValue: currentEffort === undefined ? '← current' : '',
                    values: ['✓'],
                },
                ...efforts.map(effort => ({
                    id: effort.id,
                    label: effort.name,
                    description: effort.description,
                    currentValue: currentEffort === effort.id ? '← current' : '',
                    values: ['✓'],
                })),
            ], 6, settingsListTheme, (effortId) => applyAndClose(effortId), () => deps.done(), {});
            this.requestRender();
        }).catch(() => {
            // Info unavailable: fall back to the plain model selection.
            applyAndClose(undefined);
        });
    }
    handleInput(data) {
        this.inner.handleInput?.(data);
    }
    invalidate() {
        this.inner.invalidate?.();
    }
    render(width) {
        return this.inner.render(width);
    }
}
/** The model picker for one provider; the `/model` submenu entry. */
export class ModelSubmenu {
    inner;
    requestRender;
    constructor(providerId, currentModel, currentEffort, deps) {
        this.inner = new EscDismiss(new Text('Loading models…', 0, 0), () => deps.done());
        this.requestRender = deps.requestRender;
        void deps.listModels(providerId).then(list => {
            this.inner = new SettingsList(list.map(model => ({
                id: model.id,
                label: model.id,
                description: model.id === currentModel ? '← current' : undefined,
                currentValue: model.id === currentModel ? '← current' : '',
                submenu: (value, done) => new EffortSubmenu(providerId, model.id, currentEffort, { ...deps, done }),
            })), 6, settingsListTheme, () => { }, () => deps.done(), { enableSearch: true });
            this.requestRender();
        }).catch(() => {
            this.inner = new EscDismiss(new Text('models unavailable', 0, 0), () => deps.done());
            this.requestRender();
        });
    }
    handleInput(data) {
        this.inner.handleInput?.(data);
    }
    invalidate() {
        this.inner.invalidate?.();
    }
    render(width) {
        return this.inner.render(width);
    }
}
