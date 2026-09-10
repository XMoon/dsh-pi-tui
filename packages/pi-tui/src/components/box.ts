import { isFocusable, type Component, type Focusable, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth } from "../utils.ts";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component, Focusable {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;
	/** The child the last mouse press focused (dsh-pi-tui divergence
	 * X051): focus/input forward to THIS child only — never broadcast to
	 * all children. */
	private focusedChild: Component | undefined;

	/**
	 * Focusable (dsh-pi-tui divergence X051): a Box used as an overlay
	 * root (showOverlay accepts any Component) must forward the focused
	 * flag to the child the mouse press hit — the overlay focus state
	 * tracks the mounted root, so without forwarding an Input inside a
	 * plain Box root never receives focused=true (no IME cursor).
	 */
	get focused(): boolean {
		const child = this.liveFocusedChild();
		return child !== undefined && isFocusable(child) && child.focused;
	}

	set focused(value: boolean) {
		const child = this.liveFocusedChild();
		if (child !== undefined && isFocusable(child)) {
			child.focused = value;
		}
	}

	/** Transparent input forwarding (dsh-pi-tui divergence X051): a Box
	 * overlay root must reach the interactive child the mouse press
	 * focused. */
	handleInput(data: string): void {
		this.liveFocusedChild()?.handleInput?.(data);
	}

	/** Transparent key-release capability (dsh-pi-tui divergence X051): a
	 * Box that becomes the keyboard focus owner must forward the child's
	 * wantsKeyRelease, or the TUI filters Kitty key releases before they
	 * reach the child. (Mirrors MouseRegion.) */
	get wantsKeyRelease(): boolean | undefined {
		return this.liveFocusedChild()?.wantsKeyRelease;
	}

	/** The focused child is only valid while it is still a LIVE direct
	 * child: a subclass/caller may replace `children` directly (the
	 * public structural mutation contract), and keyboard input / the
	 * focused flag / wantsKeyRelease must never reach a detached child.
	 * The reference is dropped until a new mouse press names a new focus
	 * owner — replacement never silently transfers focus to the new
	 * child, and re-mounting the old child later can never resurrect the
	 * stale identity. The detached child's focused flag is cleared too
	 * (IME/hardware-cursor state must not survive a detach). (dsh-pi-tui
	 * divergence X051 hardening.) */
	private liveFocusedChild(): Component | undefined {
		const child = this.focusedChild;
		if (child !== undefined && this.children.includes(child)) return child;
		this.clearFocusedChild();
		return undefined;
	}

	/** Drop the focused-child reference and clear the child's focused
	 * flag (IME/hardware-cursor state must not survive a detach — a
	 * removed child re-mounted elsewhere must not keep CURSOR_MARKER).
	 * (dsh-pi-tui divergence X051 hardening.) */
	private clearFocusedChild(): void {
		const child = this.focusedChild;
		if (child !== undefined && isFocusable(child)) {
			child.focused = false;
		}
		this.focusedChild = undefined;
	}

	// Cache for rendered output
	private cache?: RenderCache;
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			if (this.focusedChild === component) this.clearFocusedChild();
			this.invalidateCache();
			// Removal ends ownership: release the child's resources, exactly
			// like Container.removeChild (dsh-pi-tui divergence X007).
			component.dispose?.();
		}
	}

	clear(): void {
		// Detach FIRST (X007 exactly-once): a reentrant child.dispose()
		// that calls back into this Box must not double-dispose or skip
		// the remaining children.
		const children = this.children;
		this.children = [];
		this.clearFocusedChild();
		this.invalidateCache();
		for (const child of children) child.dispose?.();
	}

	/**
	 * Release every child (dsh-pi-tui divergence X007): a Box nested under
	 * a Container/overlay must forward disposal — without this, only
	 * box.removeChild/clear released children and a parent-owned Box
	 * leaked its resource-owning subtree.
	 */
	dispose(): void {
		this.clear();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const contentWidth = Math.max(1, event.width - this.paddingX * 2);
		const contentY = event.y - this.paddingY;
		const contentX = event.x - this.paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		// The cached mouse layout is only refreshed on render: child
		// mutations (addChild/removeChild/clear, or a subclass directly
		// replacing `children`) must invalidate it. A click must hit the
		// geometry that was ACTUALLY PAINTED: when the cache is stale
		// (removed children, or new children not yet painted), dispatch
		// nothing — re-rendering the live children here would hand the
		// click to a component the user cannot see yet (a ghost click).
		// The next real render refreshes the cache. (dsh-pi-tui divergence
		// X018 hardening.)
		const cached = this.mouseLayout;
		const cacheValid =
			cached !== undefined &&
			cached.width === contentWidth &&
			cached.children.length === this.children.length &&
			cached.children.every((entry, index) => entry.component === this.children[index]);
		if (!cacheValid) return undefined;
		const mouseChildren = cached!.children;
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (contentY >= childY && contentY < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
				// The press that requests focus names the child the
				// overlay root must forward focus/input to (X051).
				if (result?.focus) this.focusedChild = child;
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		// A paint is a focus-liveness observation point: a child that was
		// replaced via direct `children` mutation is invalidated HERE (not
		// lazily on the next keyboard event), so re-mounting it later can
		// never resurrect the stale forwarding identity. (dsh-pi-tui
		// divergence X051 hardening.)
		this.liveFocusedChild();
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		const childLines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}
		this.mouseLayout = { width: contentWidth, children: mouseChildren };

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity
		if (this.matchCache(width, childLines, bgSample)) {
			return this.cache!.lines;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		// Update cache
		this.cache = { childLines, width, bgSample, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
