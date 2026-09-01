import { getKeybindings } from "../keybindings.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { Input } from "./input.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/**
	 * Optional group label. When set, a non-interactive header row renders
	 * before the first item of each group (dsh-pi-tui extension; upstream
	 * renders a flat list).
	 */
	group?: string;
	/** Provider-specific metadata (e.g. autocomplete item markers), passed through unchanged. */
	data?: Record<string, unknown>;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	/** Optional style for group header rows (dsh-pi-tui extension). */
	groupHeader?: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export interface SelectListOptions {
	/**
	 * Show a search input above the list. Typing filters items by a
	 * case-insensitive substring over value, label, and description.
	 * Note: `setFilter` is redefined to the same substring filter (it no
	 * longer prefix-matches value only — upstream semantics).
	 * (dsh-pi-tui extension.)
	 */
	enableSearch?: boolean;
	/**
	 * Optional header line rendered above the search input. When search is
	 * enabled the header also carries the live `filtered/total` counts.
	 * (dsh-pi-tui extension.)
	 */
	header?: string;
	/** Message rendered when the (filtered) list is empty. (dsh-pi-tui extension.) */
	noMatchText?: string;
	/**
	 * Render the key-hint footer line. Off by default so inline usages (the
	 * editor autocomplete) keep their compact height. (dsh-pi-tui extension.)
	 */
	showHint?: boolean;
	/**
	 * Pre-fill the search box when the picker opens (e.g. `/sessions <query>`).
	 * (dsh-pi-tui extension.)
	 */
	initialQuery?: string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	/** Lowercased value+label+description per item, rebuilt on setItems. */
	private searchTexts = new Map<SelectItem, string>();
	private selectedIndex: number = 0;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;
	private options: SelectListOptions;
	private searchInput?: Input;
	private searchEnabled: boolean;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(
		items: SelectItem[],
		maxVisible: number,
		theme: SelectListTheme,
		layout: SelectListLayoutOptions = {},
		options: SelectListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.searchTexts = this.buildSearchTexts(items);
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
		this.options = options;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
			const initial = options.initialQuery ?? "";
			if (initial !== "") {
				this.searchInput.setValue(initial);
				this.applyFilter(initial);
			}
		}
	}

	/**
	 * Replace the item list while the picker is open (e.g. enriching rows
	 * with titles as they load). The active search query is re-applied; the
	 * currently selected row (matched by value) stays selected when it
	 * survives the refresh, instead of snapping back to the top.
	 * (dsh-pi-tui extension.)
	 */
	setItems(items: SelectItem[]): void {
		this.items = items;
		this.searchTexts = this.buildSearchTexts(items);
		this.applyFilter(this.searchInput?.getValue() ?? "", true);
	}

	/** The current search query (empty when search is disabled). */
	getFilter(): string {
		return this.searchInput?.getValue() ?? "";
	}

	setFilter(filter: string): void {
		this.applyFilter(filter);
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.options.header !== undefined) {
			const countSuffix = this.searchEnabled ? `  ${this.filteredItems.length}/${this.items.length}` : "";
			const headerText = truncateToWidth(`${this.options.header}${countSuffix}`, width, "");
			lines.push((this.theme.groupHeader ?? this.theme.description)(headerText));
			lines.push("");
		}

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch(this.options.noMatchText ?? "  No matching commands"));
			if (this.options.showHint === true || this.searchEnabled) this.addHintLine(lines, width);
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// Group counts over the full (filtered) sequence, so a header inside
		// the visible window can show how many items its group holds.
		const groupCounts = new Map<string, number>();
		for (const item of this.filteredItems) {
			if (item.group === undefined) continue;
			groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
		}

		// Render visible items, emitting a header row whenever the group of
		// the next item differs from the previous one (ungrouped items form
		// an implicit anonymous group so groups do not bleed across them).
		let lastGroup: string | undefined = undefined;
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const group = item.group ?? "";
			if (group !== lastGroup) {
				if (group !== "") {
					const count = groupCounts.get(group) ?? 0;
					const headerText = truncateToWidth(`  ${group} · ${count}`, width, "");
					lines.push((this.theme.groupHeader ?? this.theme.description)(headerText));
				}
				lastGroup = group;
			}

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		if (this.options.showHint === true || this.searchEnabled) this.addHintLine(lines, width);

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
			this.notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.notifySelectionChange();
		}
		// Page up/down - move by a visible page
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(displayItems.length - 1, this.selectedIndex + this.maxVisible);
			this.notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = displayItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Any other key edits the search box when search is enabled
		else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(keyData);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	/** Re-derive the filtered list from the current query and clamp selection.
	 * `preserveSelection` keeps the currently selected row (by value) when it
	 * survives the filter — used by setItems, where the query did not change
	 * and snapping back to the top would fight the user's cursor. */
	private applyFilter(query: string, preserveSelection = false): void {
		const previousValue = preserveSelection ? this.filteredItems[this.selectedIndex]?.value : undefined;
		if (query === "") {
			this.filteredItems = this.items;
		} else {
			const needle = query.toLowerCase();
			this.filteredItems = this.items.filter((item) => {
				// Precomputed lowercased search text: filtering a large picker
				// no longer re-lowercases every field on every keystroke.
				const searchable = this.searchTexts.get(item);
				return searchable === undefined
					? `${item.value}\n${item.label}\n${item.description ?? ""}`.toLowerCase().includes(needle)
					: searchable.includes(needle);
			});
		}
		if (previousValue !== undefined) {
			const index = this.filteredItems.findIndex(item => item.value === previousValue);
			if (index !== -1) {
				this.selectedIndex = index;
				return;
			}
		}
		this.selectedIndex = 0;
	}

	/** Lowercased value+label+description per item, for fast filtering. */
	private buildSearchTexts(items: SelectItem[]): Map<SelectItem, string> {
		return new Map(items.map(item => [
			item,
			`${item.value}\n${item.label}\n${item.description ?? ""}`.toLowerCase(),
		]));
	}

	private addHintLine(lines: string[], width: number): void {
		const hint = this.searchEnabled
			? "type to filter · ↑↓ navigate · enter select · esc close"
			: "↑↓ navigate · enter select · esc close";
		lines.push("");
		lines.push(this.theme.scrollInfo(truncateToWidth(`  ${hint}`, width - 2, "")));
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
