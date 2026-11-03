/**
 * Minimal TUI implementation with differential rendering
 */

import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
import {
	getCapabilities,
	isImageLine,
	setCellDimensions,
	type SixelScreenFootprint,
	type SixelScreenPort,
} from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * Component interface - all components must implement this
 */
export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** Normalized cell-based mouse event. Coordinates are zero-based. */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** Coordinates local to the receiving component. */
	x: number;
	y: number;
	/** Absolute terminal coordinates. */
	screenX: number;
	screenY: number;
	/** Current component bounds. */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Logical lines. Negative values scroll up. */
	wheelDelta?: number;
	/** Consecutive click count when type is click. */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** Stop propagation and suppress renderer-level fallback behavior. */
	handled?: boolean;
	/** Route subsequent drag/release events to this component. Implies handled. */
	capture?: boolean;
	/** Give keyboard focus to this component. Implies handled. */
	focus?: boolean;
	/**
	 * Explicitly request or suppress a render. Move and release default to false;
	 * press, click, drag, and wheel default to true.
	 */
	render?: boolean;
}

/** Internal target metadata used by containers and alternate-screen dispatch. */
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
}

/** Result of dispatching to a concrete component. */
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	/** Keyboard focus target, which may be a delegating parent container. */
	focusTarget?: Component;
}

/**
 * Dispatch an event to a component and retain the exact target and coordinate
 * transform. Containers use this when forwarding events to nested children.
 */
let mouseDispatchRecorder: ((component: Component) => void) | undefined;
let mouseDispatchAllowedSet: Set<Component> | undefined;
/** Install a recorder for the components a mouse dispatch reaches
 * (TuiAltScreen uses it to snapshot the press-time hit relationship so a
 * release's synthesized click cannot transfer to a control painted after
 * the press). Returns the PREVIOUS recorder so callers can restore it on
 * exit — reentrancy-safe when a child handler synchronously triggers a
 * nested mouse dispatch. (dsh-pi-tui divergence X018 hardening.) */
export function setMouseDispatchRecorder(recorder: ((component: Component) => void) | undefined): ((component: Component) => void) | undefined {
	const previous = mouseDispatchRecorder;
	mouseDispatchRecorder = recorder;
	return previous;
}

/** Record a component as reached by the current mouse dispatch (called by
 * dispatchMouseEvent and by wrappers that rewrite the gesture target to
 * themselves). */
export function recordMouseDispatch(component: Component): void {
	mouseDispatchRecorder?.(component);
}

/** Restrict the next mouse dispatch to a set of components (the press-time
 * hit relationship): a synthesized click must not reach a control that was
 * not reachable when the press was rejected. Returns the PREVIOUS set so
 * callers can restore it on exit (reentrancy-safe). */
export function setMouseDispatchAllowedSet(set: Set<Component> | undefined): Set<Component> | undefined {
	const previous = mouseDispatchAllowedSet;
	mouseDispatchAllowedSet = set;
	return previous;
}

export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	if (mouseDispatchAllowedSet !== undefined && !mouseDispatchAllowedSet.has(component)) {
		return undefined;
	}
	recordMouseDispatch(component);
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) {
		// The component forwarded the event to a child it hosts. Like a delegating container, it routes
		// keys to that child itself, so it keeps keyboard focus. Focusing the child directly would leave
		// focus on a detached component once the host removes it, e.g. a closed settings submenu.
		const forwarded = result as TuiMouseDispatchResult;
		if (!forwarded.focus || !component.handleInput) return forwarded;
		// The forwarding component also OWNS the gesture (dsh-pi-tui divergence X018): the retained
		// press target must name a component the alternate screen can still locate in its painted
		// layout, and a delegating component need not be a Container (a SettingsList renders its
		// submenu itself). Re-targeting to the owner keeps the release click routed through the
		// owner's own current hit-testing instead of a child it may no longer host.
		return {
			...forwarded,
			focusTarget: component,
			target: {
				...forwarded.target,
				component,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** Recreate local coordinates for a previously dispatched mouse target. */
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/** Optional handler for keyboard input when component has focus. */
	handleInput?(data: string): void;

	/** Optional normalized mouse handler. */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;

	/**
	 * Release resources (timers, listeners, render callbacks) when the
	 * component is removed from a container. Containers call this on
	 * removeChild/clear. (dsh-pi-tui divergence X007.)
	 */
	dispose?(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;
type PendingTerminalColorQuery = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette: Array<RgbColor | undefined>;
	/** Targets that already replied, so duplicates do not count twice. */
	replied: Set<string>;
	/**
	 * Receives the result: the promise's resolve until the timeout, then `onLateReply`. Unset once the
	 * query completed (on the DA1 reply or once every color replied); later replies are ignored.
	 */
	deliver: ((colors: TerminalColors) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

const TERMINAL_PALETTE_SIZE = 16;
/** OSC 10 and 11 plus OSC 4 for every palette color. */
const TERMINAL_COLOR_REPLY_COUNT = 2 + TERMINAL_PALETTE_SIZE;
/**
 * Default colors, palette colors 0-15, and a trailing primary device attributes (DA1) request.
 * Every terminal answers DA1 and terminals answer in order, so the DA1 reply marks the end of
 * the color replies, including for terminals that ignore the color queries.
 */
const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: TERMINAL_PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}\x1b[c`;
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;
/** A single OSC 11 background observation (narrow seam; see queryTerminalBackgroundColor). */
const TERMINAL_BACKGROUND_QUERY = "\x1b]11;?\x07";

/**
 * Whether ANY screen in this process has issued a narrow OSC 11 observation (X060). The physical
 * terminal input chain is shared while a probe belongs to one screen, so once this process owns
 * background observations every screen consumes an unowned background reply instead of forwarding
 * it as user input. A process that only uses upstream's API keeps upstream's behavior (an unowned
 * color reply is ordinary input again) — upstream's suite relies on that, and Node's test runner
 * isolates test files, so a suite that never calls the seam still sees upstream's forwarding.
 */
let backgroundObservationOwned = false;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
	/**
	 * Dispose the component when the overlay is permanently removed
	 * (hide() / hideOverlay()) — ownership ends with the removal
	 * (dsh-pi-tui divergence X007). DEFAULT FALSE (upstream behavior):
	 * hide() only unregisters, so an integrator that re-mounts the SAME
	 * component elsewhere (fullscreen screen migration) keeps it alive.
	 * Set true when this overlay's entry is the component's sole owner.
	 */
	disposeOnHide?: boolean;
	/**
	 * Whether this capturing overlay takes keyboard focus when it is FIRST
	 * mounted (default true). `false` is for the host's internal fullscreen
	 * REBIND (dsh-pi-tui divergence X056): the entry is re-created for an
	 * existing logical node and the host restores the real keyboard owner
	 * afterwards, so an automatic focus here would emit a spurious
	 * onFocus/onBlur pair on every screen swap. The entry keeps its normal
	 * capturing policy for later show/focus.
	 */
	initialFocus?: boolean;
	/**
	 * Let the primary viewport keep receiving scroll/navigation input while
	 * THIS capturing overlay holds keyboard focus (dsh-pi-tui divergence
	 * X058). The overlay still owns the keyboard (unlike `nonCapturing`) and
	 * still owns the pointer INSIDE its own rectangle — an event the overlay
	 * handles is never also applied to the background. Only the primary
	 * viewport's SCROLL/navigation additionally stays live when the overlay
	 * does not consume the event: wheel / Alt+wheel anywhere, PageUp/PageDown,
	 * scrollbar hit-testing/dragging, and background text selection outside the
	 * overlay rectangle. Keyboard keys the overlay's focused component can
	 * consume (Home/End, Ctrl+U/Ctrl+D, Up/Down, typing) still win.
	 *
	 * Default false: an ordinary capturing overlay keeps upstream's full
	 * viewport block. Ignored for `nonCapturing` overlays.
	 */
	viewportPassthrough?: boolean;
	/**
	 * Allow selecting the visible text INSIDE this overlay's painted content
	 * rectangle (dsh-pi-tui divergence X068). Insets describe the overlay's own
	 * chrome (border rows, side padding) measured from the LAST PAINTED
	 * placement, so the selectable region is that placement minus the insets
	 * and never depends on a guessed coordinate.
	 *
	 * The overlay stays a complete modal: pointer ownership of its rectangle,
	 * keyboard focus, background blocking and every component's hit testing are
	 * unchanged. Only a press that NO component consumed and that lands inside
	 * the region starts the alternate screen's existing text selection, which is
	 * clipped to that region for the whole gesture (drag outside maps to the
	 * nearest region cell; the background is never selectable or copyable). The
	 * selection is dropped when the overlay's painted placement moves, when it
	 * is hidden/closed or replaced, or when a newer overlay covers it.
	 *
	 * DEFAULT UNDEFINED (upstream): an unconsumed press on the overlay neither
	 * selects nor copies anything. This is not `viewportPassthrough`; it never
	 * exposes the transcript behind the overlay, and it is inert on the regular
	 * main screen, which has no application-owned text selection.
	 */
	textSelectionInsets?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/** Last rendered terminal-relative overlay rectangle. */
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

/**
 * Options for an INTERNAL order-preserving overlay restore (dsh-pi-tui
 * divergence X056). The host temporarily suppresses a set of overlays (a
 * Question / Save Location modal, or a screen swap) and later restores them.
 * Upstream `setHidden(false)` / `focus()` promote the overlay's visual order
 * AND take keyboard focus as side effects; an internal restore must reproduce
 * the pre-suppression stacking and keyboard ownership instead (e.g. a
 * nonCapturing HUD that legitimately sat above the focused capturing overlay,
 * or a deliberately `blur`red overlay that must not fire a spurious
 * onFocus/onBlur).
 *
 * - `preserveOrder: true` — perform the visibility change WITHOUT the
 *   `focusOrder` promotion.
 * - `preserveFocus: true` — perform the visibility change WITHOUT taking
 *   keyboard focus (`setHidden(false)` only; `focus()` always focuses).
 */
export interface OverlayOrderPreservingOptions {
	preserveOrder?: boolean;
	preserveFocus?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean, options?: OverlayOrderPreservingOptions): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/**
	 * Focus this overlay and bring it to the visual front. With
	 * `preserveOrder: true` the overlay takes the keyboard WITHOUT being
	 * promoted to the front (internal restore).
	 */
	focus(options?: OverlayOrderPreservingOptions): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
	/** Get the most recent rendered bounds for a visible overlay. */
	getBounds(): OverlayBounds | undefined;
}

/**
 * One mounted overlay entry. Exported as a TYPE only for the alternate
 * screen's `textSelectionInsets` origin (dsh-pi-tui divergence X068): the
 * captured origin must prove it still names the SAME painted entry, and entry
 * identity is the only value that changes on a rebind/remount. It is not part
 * of the package's public entry point and carries no runtime value.
 */
export type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	bounds?: OverlayBounds;
};

type RenderedOverlayLayout = {
	entry: OverlayStackEntry;
	row: number;
	col: number;
	width: number;
	height: number;
};

/**
 * The overlay-owned text-selection region captured at press time
 * (dsh-pi-tui divergence X068): the entry that was actually PAINTED, the
 * half-open screen-cell rectangle inside its chrome, and the outer placement
 * the rectangle was derived from. It is a discardable latch, never a second
 * selection: {@link TuiAltScreen}'s anchor/focus remain the one range.
 */
export interface OverlayTextSelectionRegion {
	entry: OverlayStackEntry;
	rect: { minX: number; maxX: number; minY: number; maxY: number };
	placement: { col: number; row: number; width: number; height: number };
}

/** The half-open content rectangle of one painted overlay placement after its
 *  declared chrome insets, or undefined when it has no selectable cell
 *  (dsh-pi-tui divergence X068). */
function overlayTextSelectionRect(
	layout: RenderedOverlayLayout,
	insets: Readonly<{ top: number; right: number; bottom: number; left: number }>,
): { minX: number; maxX: number; minY: number; maxY: number } | undefined {
	const minX = layout.col + Math.max(0, Math.floor(insets.left));
	const maxX = layout.col + layout.width - Math.max(0, Math.floor(insets.right));
	const minY = layout.row + Math.max(0, Math.floor(insets.top));
	const maxY = layout.row + layout.height - Math.max(0, Math.floor(insets.bottom));
	if (maxX <= minX || maxY <= minY) return undefined;
	return { minX, maxX, minY, maxY };
}

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container - a component that contains other components
 */
export class Container implements Component, Focusable {
	children: Component[] = [];
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };
	/** The child the last mouse press focused (dsh-pi-tui divergence
	 * X051): focus/input forward to THIS child only — never broadcast to
	 * all children (a multi-Input Container must not show every cursor
	 * or consume every key). */
	private focusedChild: Component | undefined;

	/**
	 * Focusable (dsh-pi-tui divergence X051): a Container used as an
	 * overlay root (showOverlay accepts any Component) must forward the
	 * focused flag to the child the mouse press hit — the overlay focus
	 * state tracks the mounted root, so without forwarding an Input
	 * inside a plain Container root never receives focused=true (no IME
	 * cursor).
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

	/** Transparent input forwarding (dsh-pi-tui divergence X051): a
	 * Container overlay root must reach the interactive child the mouse
	 * press focused. */
	handleInput(data: string): void {
		this.liveFocusedChild()?.handleInput?.(data);
	}

	/** Transparent key-release capability (dsh-pi-tui divergence X051): a
	 * Container that becomes the keyboard focus owner must forward the
	 * child's wantsKeyRelease, or the TUI filters Kitty key releases
	 * before they reach the child. (Mirrors MouseRegion.) */
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

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			if (this.focusedChild === component) this.clearFocusedChild();
			// Removal ends ownership: release the child's resources.
			// (dsh-pi-tui divergence X007.)
			component.dispose?.();
		}
	}

	clear(): void {
		// Detach FIRST (X007 exactly-once): a reentrant child.dispose()
		// that calls back into this Container must not double-dispose or
		// skip the remaining children.
		const children = this.children;
		this.children = [];
		this.clearFocusedChild();
		for (const child of children) child.dispose?.();
	}

	/**
	 * Release every child exactly once (dsh-pi-tui divergence X007
	 * hardening): the children are detached BEFORE disposal, so a second
	 * dispose() is a no-op instead of double-disposing the children.
	 * Deliberately NOT `this.clear()` — ScrollView overrides clear() to
	 * throw (its child cannot be cleared), and dispose() must stay valid
	 * for every Container subclass.
	 */
	dispose(): void {
		const children = this.children;
		this.children = [];
		this.clearFocusedChild();
		for (const child of children) child.dispose?.();
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
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
			cached.width === event.width &&
			cached.children.length === this.children.length &&
			cached.children.every((entry, index) => entry.component === this.children[index]);
		if (!cacheValid) return undefined;
		const mouseChildren = cached!.children;
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (event.y >= childY && event.y < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				// The press that requests focus names the child the
				// overlay root must forward focus/input to (X051).
				if (result?.focus) this.focusedChild = child;
				// Focus promotion to the container root applies to plain
				// Container/Box overlay roots only — NEVER to the TUI root
				// itself (TuiBase extends Container, so without this guard
				// a TUI-root mouse dispatch would steal the focus target
				// from the clicked child).
				if (result?.focus && !(this instanceof TuiBase) && (this as Component).handleInput) {
					return { ...result, focusTarget: this };
				}
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
		// Extremely narrow terminals can report tiny or even non-positive
		// column counts; never propagate a width below 1 into components.
		// (dsh-pi-tui divergence X032.)
		width = Math.max(1, width);
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors>;
	/**
	 * Observe the terminal's default background with one narrow OSC 11 query (the Host's
	 * `Theme: auto` path). Concurrent calls on the same screen share one observation, the
	 * promise resolves `undefined` on timeout or `stop()`, and the reply never reaches the
	 * editor or a raw input listener.
	 */
	queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = false;
	private clearOnShrink = false;
	protected fullRedrawCount = 0;
	protected stopped = false;
	/**
	 * Color queries waiting for their DA1 reply, oldest first. Terminals answer in order, so color
	 * replies belong to the oldest one. Queries stay here after a timeout to collect late replies.
	 */
	private pendingTerminalColorQueries: PendingTerminalColorQuery[] = [];
	/** The single in-flight narrow OSC 11 background observation (see the API below). */
	private backgroundProbe:
		| { promise: Promise<RgbColor | undefined>; settle: (background: RgbColor | undefined) => void; timer: NodeJS.Timeout }
		| undefined;
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	/** Directory for debug/crash logs. When undefined, debug logging is disabled and crash dumps fall back to the OS temp directory. */
	protected readonly logDirectory: string | undefined;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	/** X056: monotonic stamp identifying the NEWEST focus transition. A focus
	 * callback runs synchronously and may start another transition; the outer
	 * one bails out when superseded. */
	private focusRevision = 0;
	/** X056: the last component whose focus intent was explicitly released
	 * (unfocus) or whose lifecycle ended (hide / hidden / hideOverlay), keyed by
	 * its release stamp. A pending transition to a target released DURING the
	 * transition must re-derive instead of installing it. A WeakMap keeps every
	 * released target (an onBlur may release several) without retaining them. */
	private focusIntentSeq = 0;
	private readonly focusReleaseSeq = new WeakMap<Component, number>();
	private overlayStack: OverlayStackEntry[] = [];
	/** The last-painted overlay layouts (protected: TuiAltScreen's
	 * gesture-liveness check reads the CURRENT painted placement of a
	 * retained target). */
	protected renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}

	/**
	 * The text-selection region an unconsumed press at one screen cell would
	 * start, resolved from the LAST PAINTED overlay placement (dsh-pi-tui
	 * divergence X068), or undefined when that cell is not selectable content.
	 *
	 * The TOPMOST painted overlay that opted in with `textSelectionInsets` wins;
	 * an ordinary overlay above it keeps upstream's opaque block (the caller
	 * only reaches this after the overlay dispatch found no consumer). The
	 * region is the painted placement minus the declared insets, as a half-open
	 * cell rectangle, and is refused when either inner dimension is < 1.
	 */
	protected overlayTextSelectionRegionAt(x: number, y: number): OverlayTextSelectionRegion | undefined {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			const insets = layout.entry.options?.textSelectionInsets;
			// An overlay whose cached geometry is stale (hidden, removed or
			// conditional) must not claim the pointer: the same liveness rule
			// the overlay dispatch applies. (dsh-pi-tui divergence X018.)
			if (insets === undefined || !this.overlayStack.includes(layout.entry) || !this.isOverlayVisible(layout.entry)) {
				continue;
			}
			if (x < layout.col || x >= layout.col + layout.width || y < layout.row || y >= layout.row + layout.height) {
				continue;
			}
			const rect = overlayTextSelectionRect(layout, insets);
			if (rect === undefined) return undefined;
			if (x < rect.minX || x >= rect.maxX || y < rect.minY || y >= rect.maxY) return undefined;
			return {
				entry: layout.entry,
				rect,
				placement: { col: layout.col, row: layout.row, width: layout.width, height: layout.height },
			};
		}
		return undefined;
	}

	/**
	 * Whether a captured overlay text-selection region still describes the
	 * CURRENT paint: the entry is still a mounted, visible overlay, its painted
	 * placement is byte-identical, and no other visible overlay paints above it
	 * (dsh-pi-tui divergence X068). A resize/remount, a hide/close, or a newer
	 * modal therefore retires the region instead of letting a stale selection
	 * land on the new frame.
	 */
	protected isOverlayTextSelectionRegionLive(region: OverlayTextSelectionRegion): boolean {
		if (!this.overlayStack.includes(region.entry) || !this.isOverlayVisible(region.entry)) return false;
		// A newer visible overlay with a HIGHER focus order will paint above this
		// region on the very next frame — and it already owns the pointer in the
		// window before that paint. Retire NOW: a release between the mount and
		// the next frame must not copy a range the new owner covers.
		for (const entry of this.overlayStack) {
			if (
				entry !== region.entry &&
				entry.focusOrder > region.entry.focusOrder &&
				this.isOverlayVisible(entry)
			) {
				return false;
			}
		}
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			if (layout.entry !== region.entry) {
				if (this.isOverlayVisible(layout.entry)) return false;
				continue;
			}
			return (
				layout.col === region.placement.col &&
				layout.row === region.placement.row &&
				layout.width === region.placement.width &&
				layout.height === region.placement.height
			);
		}
		return false;
	}

	/** Whether a component is still a mounted, visible overlay. Subclasses
	 * (TuiAltScreen) revalidate gesture targets against this before
	 * dispatching pointer events. (dsh-pi-tui divergence X018 hardening.) */
	protected isOverlayComponentLive(component: Component): boolean {
		const entry = this.overlayStack.find((candidate) => candidate.component === component);
		return entry !== undefined && this.isOverlayVisible(entry);
	}

	/** Whether a component is inside a mounted, visible overlay's subtree
	 * (Container children reachable through `children`). Gesture targets
	 * recorded from a nested dispatch (e.g. a SelectList inside an
	 * overlay-root Container) must stay live for the whole gesture.
	 * (dsh-pi-tui divergence X018 hardening.) */
	protected isOverlaySubtreeLive(component: Component): boolean {
		return this.overlayStack.some(
			(entry) => this.isOverlayVisible(entry) && this.componentTreeContains(entry.component, component),
		);
	}

	/** Walk a mounted component's `children` subtree looking for `target`. */
	protected componentTreeContains(root: Component, target: Component): boolean {
		if (root === target) return true;
		const children = (root as Container).children;
		if (children === undefined) return false;
		for (const child of children) {
			if (this.componentTreeContains(child, target)) return true;
		}
		return false;
	}

	/** The last-painted child layout of a Container/Box (the cached child
	 * heights from the most recent render). The TuiAltScreen
	 * painted-placement liveness check walks this to re-derive a nested
	 * descendant's CURRENT painted origin after an internal reflow.
	 * (dsh-pi-tui divergence X018 hardening.) */
	protected getContainerMouseLayout(
		component: Component,
	): { width: number; children: Array<{ component: Component; height: number }> } | undefined {
		return (component as { mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> } })
			.mouseLayout;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };
	/**
	 * The Client-local SIXEL trust port (X072), or undefined for every other
	 * terminal. A Screen never parses a DCS itself: it asks this port, which
	 * only recognizes rasters its own owner encoded.
	 */
	protected readonly sixelScreen: SixelScreenPort | undefined;
	/** Whether `start()` has brought the terminal up (only then may a query go out). */
	private terminalStarted = false;
	/** Observers of this screen's ONE real `CSI 6;h;w t` parse (X072). */
	private readonly cellSizeListeners = new Set<(cell: { widthPx: number; heightPx: number }) => void>();

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string, sixelScreen?: SixelScreenPort) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory;
		this.sixelScreen = sixelScreen;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	/**
	 * Whether this line must be treated as an IMAGE by the physical Screen
	 * (X072): a legacy Kitty/iTerm2 placement, or an exact DCS the Client-local
	 * SIXEL owner registered.
	 *
	 * This is a trust question, not a syntax question. A DCS that is not in the
	 * owner's registry stays ordinary text and goes through the normal
	 * normalization/truncation path, so an arbitrary `ESC P…q…ESC \` from a tool
	 * result can never be promoted to a device command.
	 */
	protected isRenderableImageLine(line: string): boolean {
		// A candidate marker is an INTERNAL identity, not text: it must never be
		// normalized, sliced or composited, and an overlay that reaches its row
		// yields the block. (X072.)
		return isImageLine(line)
			|| this.sixelScreen?.footprint(line) !== undefined
			|| this.sixelScreen?.candidate(line) !== undefined;
	}

	/** The registered SIXEL footprint of a trusted anchor line, if any (X072). */
	protected sixelFootprint(line: string): SixelScreenFootprint | undefined {
		return this.sixelScreen?.footprint(line);
	}

	/**
	 * Observe every real cell-size reply this screen parses, or return the
	 * current value immediately when it is already known (X072).
	 *
	 * There is ONE parser (`consumeCellSizeResponse`); observers never see a
	 * query they issued, only the terminal's actual `CSI 6;h;w t` answer.
	 */
	onCellSizeObserved(listener: (cell: { widthPx: number; heightPx: number }) => void): () => void {
		this.cellSizeListeners.add(listener);
		return () => {
			this.cellSizeListeners.delete(listener);
		};
	}

	/**
	 * Ask the terminal for its cell size in device pixels (`CSI 16t`, answered as
	 * `CSI 6;h;w t`) on behalf of a consumer that needs REAL geometry (X072).
	 *
	 * Unlike the startup probe this refuses before `start()`: a query written to
	 * a terminal this screen does not own yet would be answered into the input
	 * stream of whoever does.
	 */
	queryCellSizeForSixel(): void {
		if (!this.terminalStarted) return;
		this.terminal.write("\x1b[16t");
	}

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.hideTerminalCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true, empty rows are cleared when content shrinks.
	 * When false (default), empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		// X056: a focus callback runs synchronously and may start a NEWER focus
		// transition (an onBlur that re-requests focus, an onFocus that mounts
		// another overlay). The outer transition must not overwrite whatever the
		// newer one established, so it stamps itself and bails out when superseded.
		const revision = ++this.focusRevision;
		const intentSeq = this.focusIntentSeq;
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		// The restore bookkeeping is PENDING until this transition completes: a
		// synchronous callback may supersede it, and the newer transaction owns
		// the final state.
		let pendingRestore: OverlayFocusRestoreState | undefined;
		let pendingClear = false;
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					const resolved = this.resolveBlockedOverlayFocusResume(restoreState);
					nextFocus = resolved.component;
					if (resolved.clear) pendingClear = true;
				} else {
					pendingRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				pendingRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				const resolved = this.resolveBlockedOverlayFocusResume(restoreState);
				nextFocus = resolved.component;
				if (resolved.clear) pendingClear = true;
			} else if (overlayFocusRestore === "clear") {
				pendingClear = true;
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
			// An onBlur callback may have started a newer transition.
			if (revision !== this.focusRevision) return;
		}
		// The pending target's OWN focus intent/lifecycle may have been changed
		// by that onBlur (blur/hide/close on it) without starting a new
		// transition: never install a released/hidden/removed target.
		if (nextFocus !== null) {
			const releasedSeq = this.focusReleaseSeq.get(nextFocus);
			if (releasedSeq !== undefined && releasedSeq > intentSeq) {
				nextFocus = this.getTopmostVisibleOverlay(nextFocus)?.component ?? null;
			}
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
			// An onFocus callback may have started a newer transition.
			if (revision !== this.focusRevision) return;
		}

		if (pendingClear) this.clearOverlayFocusRestore();
		if (pendingRestore !== undefined) this.overlayFocusRestore = pendingRestore;

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	/** Resolve a blocked overlay restore into its target focus. When the blocked
	 * state is CONSUMED (focus-target resume) the caller must clear it — but
	 * only once its own transition completes, because a synchronous focus
	 * callback may supersede it (X056). */
	private resolveBlockedOverlayFocusResume(
		restoreState: BlockedOverlayFocusRestoreState,
	): { component: Component | null; clear: boolean } {
		if (restoreState.resume.status === "restore-overlay") {
			return { component: restoreState.overlay.component, clear: false };
		}
		return { component: restoreState.resume.target, clear: true };
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		// Structural walk over public `children` (X051): Box is a public
		// overlay root with children + Focusable forwarding, so the
		// instanceof Container gate would report an Input under a Box root
		// as unmounted and miss the Box subtree in focus resolution.
		return this.componentTreeContains(root, target);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible (and not an X056 rebind)
		if (options?.initialFocus !== false && !options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.hideTerminalCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					// X056: a pending transition to this component must not install it.
					this.focusReleaseSeq.set(component, ++this.focusIntentSeq);
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// Opt-in ownership end (dsh-pi-tui divergence X007): with
					// disposeOnHide the removal releases the component's
					// resources. The stack-guard makes this run exactly once
					// per removal; the default (no flag) keeps upstream
					// behavior so re-mountable integrations stay alive.
					if (options?.disposeOnHide === true) component.dispose?.();
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.hideTerminalCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean, setHiddenOptions?: OverlayOrderPreservingOptions) => {
				// X056: record the release BEFORE the idempotent early-return — an
				// already-hidden pending target released from a callback must not
				// be installed by the outer transition either.
				if (hidden) this.focusReleaseSeq.set(component, ++this.focusIntentSeq);
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						// X056: an internal restore must not promote the visual
						// order nor take keyboard focus.
						if (setHiddenOptions?.preserveOrder !== true) entry.focusOrder = ++this.focusOrderCounter;
						if (setHiddenOptions?.preserveFocus !== true) this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: (focusOptions?: OverlayOrderPreservingOptions) => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				// X056: an internal restore must not promote the visual order.
				if (focusOptions?.preserveOrder !== true) entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				// X056: record the release even when this component is not yet
				// focused — it may be the PENDING target of an in-flight
				// transition that must re-derive instead of installing it.
				this.focusReleaseSeq.set(component, ++this.focusIntentSeq);
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
			getBounds: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				return { ...entry.bounds };
			},
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		// X056: a pending transition to this component must not install it.
		this.focusReleaseSeq.set(overlay.component, ++this.focusIntentSeq);
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		// Opt-in ownership end (dsh-pi-tui divergence X007, same contract
		// as OverlayHandle.hide's disposeOnHide).
		if (overlay.options?.disposeOnHide === true) overlay.component.dispose?.();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.hideTerminalCursor();
		this.requestRender();
	}

	/** Hide the cursor while running. After stop(), the shell owns the cursor and it must stay visible. */
	private hideTerminalCursor(): void {
		if (!this.stopped) this.terminal.hideCursor();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** Check if the focused component is a visible overlay */
	protected isOverlayFocused(): boolean {
		return this.overlayStack.some(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/**
	 * Whether a visible overlay currently BLOCKS the primary viewport's
	 * scroll/navigation input and pointer gestures. An overlay opted into
	 * `viewportPassthrough` (dsh-pi-tui divergence X058) does not block; every
	 * other visible overlay, including `nonCapturing` ones, keeps the upstream
	 * block so this predicate is exactly `hasOverlay()` minus opted-in entries.
	 */
	protected hasBlockingOverlay(): boolean {
		return this.overlayStack.some(
			(entry) => this.isOverlayVisible(entry) && !this.overlayViewportPassthroughEntry(entry),
		);
	}

	/**
	 * Whether one overlay entry qualifies for the X058 viewport passthrough:
	 * it must be a CAPTURING overlay that explicitly opted in. `nonCapturing`
	 * never qualifies — the option is documented as ignored for it, and a
	 * nonCapturing notice must keep the upstream viewport/scrollbar block.
	 */
	private overlayViewportPassthroughEntry(entry: OverlayStackEntry): boolean {
		return entry.options?.nonCapturing !== true && entry.options?.viewportPassthrough === true;
	}

	/**
	 * Whether the primary viewport currently PASSTHROUGHS scroll/navigation
	 * input while an overlay owns the keyboard (dsh-pi-tui divergence X058):
	 * the FOCUSED visible overlay opted in, and no other visible overlay blocks
	 * the viewport. Stacking an ordinary modal above stops the passthrough
	 * immediately; hiding it restores it.
	 */
	protected overlayViewportPassthrough(): boolean {
		const focused = this.overlayStack.find(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
		if (focused === undefined || !this.overlayViewportPassthroughEntry(focused)) return false;
		return !this.overlayStack.some(
			(entry) => entry !== focused && this.isOverlayVisible(entry) && !this.overlayViewportPassthroughEntry(entry),
		);
	}

	/** Keep overlay containers as keyboard focus owners when a nested control is clicked. */
	protected resolveMouseFocusTarget(component: Component): Component {
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			const overlay = this.overlayStack[index]!;
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		return component;
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			// The layout cache is only refreshed on render: an overlay that
			// was hidden or removed since the last frame must not receive
			// pointer events (its cached geometry is stale until the next
			// paint). (dsh-pi-tui divergence X018 hardening.)
			if (!this.overlayStack.includes(layout.entry) || !this.isOverlayVisible(layout.entry)) {
				continue;
			}
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = dispatchMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(exclude?: Component): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.component === exclude) continue;
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.terminalStarted = true;
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		this.terminalStarted = false;
		this.cancelRenderTimer();
		// Release a pending narrow background observation: a stopped screen must
		// never apply a late OSC 11 result (and its timer must not stay armed).
		this.settleBackgroundProbe(undefined);
		// (dsh-pi-tui divergence X066.) The teardown steps are exception-safe:
		// every step is still ATTEMPTED after an earlier one throws, because a
		// throwing `beforeTerminalStop()` (a failing image/cleanup write) would
		// otherwise strand the terminal in raw mode, with the cursor hidden and
		// the alternate screen still active. The FIRST failure is the one
		// rethrown, so a later recovery failure never masks the original cause,
		// and a recovery-only failure is never reported as success.
		const failures: unknown[] = [];
		const attempt = (step: () => void): void => {
			try {
				step();
			} catch (error) {
				failures.push(error);
			}
		};
		attempt(() => {
			if (this.terminalColorSchemeNotificationsEnabled) {
				this.terminal.write("\x1b[?2031l");
			}
		});
		attempt(() => this.beforeTerminalStop(options));
		attempt(() => this.terminal.showCursor());
		attempt(() => this.terminal.stop());
		attempt(() => this.afterTerminalStop(options));
		if (failures.length > 0) throw failures[0];
	}

	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		this.renderRequested = true;
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(() => {
			this.immediateRenderScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			// A previously queued scheduleRender() can create a timer before this
			// callback runs. User input must preempt that throttled frame.
			this.cancelRenderTimer();
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
		});
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleTerminalInput(data: string): void {
		if (this.consumeTerminalColorResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}
		// Consume terminal cell size responses BEFORE the input listeners
		// (dsh-pi-tui divergence X046): every terminal-owned protocol reply
		// is filtered before the host/raw listeners run, so a listener that
		// consumes every chunk (a question/approval modal, an unstable raw
		// capture) can never swallow the reply and leave the cell
		// dimensions stale. Upstream consumes it after the listeners.
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			// Keyboard input is latency-sensitive. Avoid the throttled timer path,
			// where even setTimeout(0) can take a full 16 ms tick on Windows.
			this.requestImmediateRender();
		}
	}

	private consumeTerminalColorResponse(data: string): boolean {
		// The narrow OSC 11 observation is served first, from the SAME parse: it is
		// one observation of the terminal background, so a concurrent full query
		// still records the reply below. Without a pending full query this branch
		// also consumes a stray/late background reply, which must never reach the
		// editor or a raw input listener.
		const servedBackgroundProbe = this.consumeTerminalBackgroundResponse(data);
		const query = this.pendingTerminalColorQueries[0];
		if (!query) {
			return servedBackgroundProbe;
		}
		if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)) {
			this.pendingTerminalColorQueries.shift();
			this.completeTerminalColorQuery(query);
			return true;
		}

		const response = parseOscColorResponse(data);
		if (!response) {
			return false;
		}
		const { target, rgb } = response;
		const key = String(target);
		if (!query.deliver || query.replied.has(key)) {
			return true;
		}
		query.replied.add(key);
		if (target === "foreground") {
			query.foreground = rgb;
		} else if (target === "background") {
			query.background = rgb;
		} else if (target < TERMINAL_PALETTE_SIZE) {
			query.palette[target] = rgb;
		}
		if (query.replied.size === TERMINAL_COLOR_REPLY_COUNT) {
			this.completeTerminalColorQuery(query);
		}
		return true;
	}

	private terminalColorQueryResult(query: PendingTerminalColorQuery): TerminalColors {
		const palette = query.palette.every((color) => color !== undefined) ? (query.palette as RgbColor[]) : undefined;
		return { foreground: query.foreground, background: query.background, palette };
	}

	private completeTerminalColorQuery(query: PendingTerminalColorQuery): void {
		const deliver = query.deliver;
		query.deliver = undefined;
		clearTimeout(query.timer);
		deliver?.(this.terminalColorQueryResult(query));
	}

	/** Serve the narrow OSC 11 observation's in-flight probe, if any. */
	private consumeTerminalBackgroundResponse(data: string): boolean {
		const response = parseOscColorResponse(data);
		if (!response || response.target !== "background") {
			return false;
		}
		const probe = this.backgroundProbe;
		if (probe !== undefined) {
			this.backgroundProbe = undefined;
			clearTimeout(probe.timer);
			probe.settle(response.rgb);
		}
		// A background reply is terminal protocol traffic, never editor input —
		// including one that arrives after its observation timed out, was released
		// by stop(), or belongs to a screen that has since been swapped out. The
		// physical terminal input chain is shared, so forwarding it would surface
		// a protocol reply as user activity on whichever screen owns the terminal
		// now (the host's onUserInput / raw-input path). (X060.)
		return backgroundObservationOwned;
	}

	private settleBackgroundProbe(background: RgbColor | undefined): void {
		const probe = this.backgroundProbe;
		if (probe === undefined) return;
		this.backgroundProbe = undefined;
		clearTimeout(probe.timer);
		probe.settle(background);
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// The ONE place a real cell reply becomes a fact (X072). Observers read
		// the parsed value, never the wire bytes, so there is no second parser
		// that could interpret the same reply differently.
		for (const listener of this.cellSizeListeners) {
			listener({ widthPx, heightPx });
		}
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) {
			this.renderedOverlayLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of this.overlayStack) entry.bounds = undefined;

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!this.isRenderableImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		// A trusted SIXEL anchor is a device command, not cell content: slicing it
		// as text would emit a corrupted command (X072). An overlay that reaches
		// this row wins the cell, so this frame paints no pixels on it and the
		// image's own identity row stays visible above.
		if (this.sixelScreen?.footprint(baseLine) !== undefined || this.sixelScreen?.candidate(baseLine) !== undefined) {
			return compositeTuiLine("", overlayLine, startCol, overlayWidth, totalWidth);
		}
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * The absolute line range a visible overlay painted on this frame (X072).
	 *
	 * Overlay placements are viewport-relative, exactly like the compositor's own
	 * `workingHeight - termHeight` origin, so the mapping is derived from the same
	 * inputs instead of being guessed by the caller.
	 */
	protected overlayPaintedLineRange(
		overlayRow: number,
		overlayHeight: number,
		totalLines: number,
	): { first: number; last: number } {
		const viewportStart = Math.max(0, totalLines - this.terminal.rows);
		const first = viewportStart + overlayRow;
		return { first, last: first + overlayHeight - 1 };
	}

	/** Whether a visible overlay painted any cell on any of these absolute lines. */
	protected linesCoveredByOverlay(firstLine: number, lastLine: number, totalLines: number): boolean {
		for (const layout of this.renderedOverlayLayouts) {
			const range = this.overlayPaintedLineRange(layout.row, layout.height, totalLines);
			if (range.last < firstLine || range.first > lastLine) continue;
			return true;
		}
		return false;
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * Query the terminal's theme colors: the default foreground (OSC 10), the default background
	 * (OSC 11), and ANSI colors 0-15 (OSC 4), followed by a DA1 request that marks the end of the
	 * replies. Resolves when the DA1 reply or all color replies arrive, or when the timeout expires.
	 * Colors the terminal did not report are undefined; the palette is only set when all 16 arrived.
	 * @param timeoutMs Query timeout in milliseconds, for terminals that do not answer DA1 either.
	 * @param onLateReply Receives the replies if the query completes after the timeout, e.g. over slow links.
	 */
	queryTerminalColors({
		timeoutMs,
		onLateReply,
	}: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return new Promise((resolve) => {
			const query: PendingTerminalColorQuery = {
				palette: Array.from({ length: TERMINAL_PALETTE_SIZE }, () => undefined),
				replied: new Set(),
				deliver: resolve,
				timer: undefined,
			};
			// Resolve with the replies so far, and keep collecting late replies for `onLateReply`.
			query.timer = setTimeout(() => {
				query.deliver = onLateReply;
				resolve(this.terminalColorQueryResult(query));
			}, timeoutMs);
			this.pendingTerminalColorQueries.push(query);
			this.terminal.write(TERMINAL_COLOR_QUERY);
		});
	}

	/**
	 * Observe the terminal's default background with ONE OSC 11 query. This is the narrow
	 * background-only seam the Host uses for `Theme: auto`; the full {@link queryTerminalColors}
	 * API above stays upstream-verbatim for consumers that need the foreground or the palette.
	 *
	 * - one in-flight observation per screen: concurrent calls on the same screen share it;
	 * - resolves `undefined` on timeout, and on `stop()` (the pending resolver and timer are
	 *   released, so a stopped screen never applies a late result);
	 * - once this process has used the seam, a well-formed OSC 11 reply is consumed at this layer
	 *   (late, stray and cross-screen ones too) and can never reach the editor or a raw input
	 *   listener, because the physical terminal input chain is shared while a probe is per screen;
	 * - OSC 11 carries no request id, so the resolved colour is an observation of the CURRENT
	 *   terminal background, not a reply strictly attributable to this request. Callers own the
	 *   "still relevant?" guard (screen identity, screen stopped, a newer explicit theme choice).
	 * @param options.timeoutMs - observation timeout in milliseconds.
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		const inFlight = this.backgroundProbe;
		if (inFlight !== undefined) return inFlight.promise;
		let settle!: (background: RgbColor | undefined) => void;
		const promise = new Promise<RgbColor | undefined>((resolve) => {
			settle = resolve;
		});
		const timer = setTimeout(() => this.settleBackgroundProbe(undefined), timeoutMs);
		backgroundObservationOwned = true;
		this.backgroundProbe = { promise, settle, timer };
		this.terminal.write(TERMINAL_BACKGROUND_QUERY);
		return promise;
	}
}
