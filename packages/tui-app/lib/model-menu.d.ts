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
import { type Component } from '@dsh-pi-tui/pi-tui';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
/** The model-service surface `/model` needs, read off the live context. */
export interface ModelMenuServices {
    listModels(providerId: string): Promise<readonly {
        id: string;
    }[]>;
    resolveModelInfo(providerId: string, modelId: string): Promise<{
        reasoning?: {
            efforts?: readonly {
                id: string;
                name: string;
                description?: string;
            }[];
        };
    }>;
}
/** Shared deps threaded through both submenu levels. */
interface SubmenuDeps extends ModelMenuServices {
    /** Commit a selection (model, optional effort) and refresh the footer. */
    apply(selection: ModelSelection): void;
    /** Request a frame so the swapped-in list renders. */
    requestRender(): void;
    /** Close this submenu level (Esc, or after an applied selection). */
    done(selected?: string): void;
}
/** The model picker for one provider; the `/model` submenu entry. */
export declare class ModelSubmenu implements Component {
    private inner;
    private readonly requestRender;
    constructor(providerId: string, currentModel: string, currentEffort: string | undefined, deps: SubmenuDeps);
    handleInput(data: string): void;
    invalidate(): void;
    render(width: number): string[];
}
export {};
