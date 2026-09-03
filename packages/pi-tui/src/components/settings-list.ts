import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback.
	 *  done() accepts an optional selectedValue and an optional navigateTo id to move the cursor after close. */
	submenu?: (
		currentValue: string,
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
	) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

/**
 * Structural seam: a submenu component that accepts the host's live row
 * grant. SettingsList forwards its own `setMaxRows` value to an open
 * submenu that implements this, and re-forwards on every grant change, so
 * nested lists (e.g. the /model picker) reflow instead of being clipped
 * by the compositor — without SettingsList knowing the submenu's type.
 */
export interface RowBudgetAware {
	setMaxRows?(rows: number): void;
}

export class SettingsList implements Component, Focusable {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	/** Caller-configured item cap; the host may lower it for a short frame. */
	private configuredMaxVisible: number;
	private maxVisible: number;
	/** Inner row budget supplied by a root-owned responsive overlay. */
	private maxRows = Number.POSITIVE_INFINITY;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private navigateAfterClose: string | null = null;
	/**
	 * Submenu generation token (round-5 review P2): every submenu factory
	 * callback captures the generation at OPEN time; a callback that fires
	 * after the submenu was closed, REPLACED or the list disposed is stale
	 * and must be a no-op — otherwise a delayed `done()` could resurrect
	 * navigation on a disposed list.
	 */
	private submenuGeneration = 0;

	/**
	 * Focusable (dsh-pi-tui divergence X042): the focused flag propagates to
	 * the input the user is actually typing into — the search Input on the
	 * main list, the open submenu component while it is active — so it
	 * emits the hardware CURSOR_MARKER for IME candidate-window positioning.
	 * The wrapper contract: every component owning an Input/Editor must
	 * forward focus; a plain Component swallows the flag and the IME
	 * misplaces its candidate window.
	 */
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.propagateFocus();
	}

	private propagateFocus(): void {
		if (this.searchInput !== undefined) this.searchInput.focused = this._focused;
		const submenu = this.submenuComponent;
		if (submenu !== null && "focused" in submenu) {
			(submenu as Focusable).focused = this._focused;
		}
	}

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.configuredMaxVisible = Math.max(1, Math.floor(maxVisible));
		this.maxVisible = this.configuredMaxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** Update the live inner row budget without resetting selection or submenu. */
	setMaxRows(rows: number): void {
		this.maxRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : Number.POSITIVE_INFINITY;
		this.recomputeVisibleBudget();
		this.forwardBudgetToSubmenu();
	}

	/** Forward the current grant to an open submenu that accepts it, so
	 * nested lists stay within the same row budget on resize. */
	private forwardBudgetToSubmenu(): void {
		const child = this.submenuComponent as RowBudgetAware | null;
		child?.setMaxRows?.(this.maxRows);
	}

	/** Reserve search, scroll and hint rows before deriving the item count. */
	private recomputeVisibleBudget(): void {
		const prefix = this.searchEnabled ? 2 : 0;
		const indicator = this.filteredItems.length > 1 ? 1 : 0;
		const hint = 2;
		const budget = this.maxRows === Number.POSITIVE_INFINITY
			? this.configuredMaxVisible
			: this.maxRows - prefix - indicator - hint;
		this.maxVisible = Math.max(1, Math.min(this.configuredMaxVisible, budget));
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	/** Move selection to the item with the given id (no-op if not found). */
	selectItem(id: string): void {
		const items = this.searchEnabled ? this.filteredItems : this.items;
		const index = items.findIndex((i) => i.id === id);
		if (index !== -1) {
			this.selectedIndex = index;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	/**
	 * Release owned resources: the open submenu component (its slot owns
	 * the lifecycle). Raw release — deliberately NOT closeSubmenu(), whose
	 * navigateAfterClose handling would resurrect a FOLLOW-UP submenu
	 * during disposal. Idempotent. (dsh-pi-tui divergence X007.)
	 */
	dispose(): void {
		this.navigateAfterClose = null;
		this.submenuGeneration++;
		this.submenuComponent?.dispose?.();
		this.submenuComponent = null;
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return this.finalizeEmpty(lines);
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return this.finalizeEmpty(lines);
		}

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(36, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		let visibleCount = this.maxVisible;
		let window = this.renderItemWindow(width, maxLabelWidth, displayItems, visibleCount);
		// The selected row's description (1 blank + k wrapped rows) renders
		// outside the item window, so it is unaccounted by the budget
		// reservation. Shrink the WINDOW (selection-centered) until the
		// assembled list fits the grant with room for the description block
		// and the hint tail (setMaxRows contract). Only the local
		// `visibleCount` shrinks — `maxVisible` stays the budget-derived
		// baseline, so moving to a row without a description restores the
		// full window (no render-time ratchet on PageUp/PageDown).
		while (Number.isFinite(this.maxRows)
			&& lines.length + window.length + this.descriptionRowCount(width, displayItems) + 2 > this.maxRows
			&& visibleCount > 1) {
			visibleCount -= 1;
			window = this.renderItemWindow(width, maxLabelWidth, displayItems, visibleCount);
		}
		lines.push(...window);

		// Description for the selected item — wrapped, then capped to the
		// rows left after the hint, so the hint below always survives.
		const descBudget = Number.isFinite(this.maxRows)
			? Math.max(0, this.maxRows - lines.length - 2)
			: Number.POSITIVE_INFINITY;
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description && descBudget > 0) {
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			lines.push("");
			const keep = descBudget === Number.POSITIVE_INFINITY
				? wrappedDesc.length
				: Math.min(wrappedDesc.length, Math.max(0, descBudget - 1));
			for (const line of wrappedDesc.slice(0, keep)) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		// Keep the hint tail on degenerate tiny grants (mirrors SelectList):
		// a head slice would cut the hint, the non-negotiable tail row.
		if (Number.isFinite(this.maxRows) && lines.length > this.maxRows) {
			return lines.slice(lines.length - this.maxRows);
		}
		return lines;
	}

	/** Finalize the empty/no-match assembly against the live grant
	 * (setMaxRows contract covers every path): `render().length <=
	 * maxRows` with priority search input > no-match message > hint >
	 * blank spacers. SettingsList has no header, so after the blank
	 * spacers only an extreme grant needs to yield rows. */
	private finalizeEmpty(lines: string[]): string[] {
		if (!Number.isFinite(this.maxRows)) return lines;
		const limit = Math.max(1, Math.floor(this.maxRows));
		if (lines.length <= limit) return lines;
		const compact = lines.filter(line => line !== "");
		if (compact.length <= limit) return compact;
		// Extreme grant: keep the head (the search input, then the
		// message) per priority.
		return compact.slice(0, limit);
	}

	/** Render the item window (rows + scroll indicator) at `visibleCount`,
	 * centered on the selected row. */
	private renderItemWindow(width: number, maxLabelWidth: number, displayItems: SettingItem[], visibleCount: number): string[] {
		const lines: string[] = [];

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(visibleCount / 2), displayItems.length - visibleCount),
		);
		const endIndex = Math.min(startIndex + visibleCount, displayItems.length);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	/** The rendered row count of the selected item's description block
	 * (1 blank + wrapped lines) at the current width. */
	private descriptionRowCount(width: number, displayItems: SettingItem[]): number {
		const selectedItem = displayItems[this.selectedIndex];
		if (!selectedItem?.description) return 0;
		return 1 + wrapTextWithAnsi(selectedItem.description, width - 4).length;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0))
		) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private activateItem(): void {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			// Replacing an open submenu ends its ownership: dispose the old
			// component before the new one takes over (dsh-pi-tui divergence
			// X007 — the submenu slot owns the component's lifecycle).
			this.submenuComponent?.dispose?.();
			const generation = ++this.submenuGeneration;
			const component = item.submenu(
				item.currentValue,
				(selectedValue?: string, options?: { navigateTo?: string }) => {
					// A callback from a CLOSED/REPLACED/DISPOSED submenu is
					// stale: it must never resurrect navigation (round-5 P2).
					if (generation !== this.submenuGeneration) return;
					if (selectedValue !== undefined) {
						item.currentValue = selectedValue;
						this.onChange(item.id, selectedValue);
					}
					if (options?.navigateTo) {
						this.navigateAfterClose = options.navigateTo;
					}
					this.closeSubmenu();
				},
			);
			// The factory may call done() SYNCHRONOUSLY before returning
			// (round-7 review P2): the callback passed its own generation
			// check, closeSubmenu() ran, and the outer assignment would
			// otherwise RESURRECT the closed submenu (or overwrite a
			// follow-up submenu opened by navigateAfterClose). Re-check the
			// generation AFTER the factory returns and release the orphan.
			if (generation !== this.submenuGeneration) {
				component.dispose?.();
				return;
			}
			this.submenuComponent = component;
			// The freshly opened submenu becomes the input the user types
			// into: forward the current focus state so its CURSOR_MARKER
			// (IME positioning) matches the list's focus (dsh-pi-tui
			// divergence). A submenu that accepts row budgets also inherits
			// the CURRENT grant immediately (async submenus like /model
			// open on a loading shell and swap in their list later, so the
			// forward must also happen on the swap path).
			this.propagateFocus();
			this.forwardBudgetToSubmenu();
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		// Closing the submenu ends its ownership: release the component's
		// resources (dsh-pi-tui divergence X007) and invalidate every
		// outstanding submenu callback (round-5 P2).
		this.submenuGeneration++;
		this.submenuComponent?.dispose?.();
		this.submenuComponent = null;
		if (this.navigateAfterClose !== null) {
			const id = this.navigateAfterClose;
			this.navigateAfterClose = null;
			this.submenuItemIndex = null;
			this.selectItem(id);
			// Open the target item's submenu automatically
			this.activateItem();
		} else if (this.submenuItemIndex !== null) {
			// Restore selection to the item that opened the submenu
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
		this.recomputeVisibleBudget();
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
