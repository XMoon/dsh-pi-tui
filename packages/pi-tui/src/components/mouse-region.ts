import {
	type Component,
	dispatchMouseEvent,
	type Focusable,
	isFocusable,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
export class MouseRegion implements Component, Focusable {
	private readonly child: Component;
	private readonly onMouse: MouseRegionHandler;
	private readonly focusedChild: Component & Focusable | undefined;
	private disposed = false;

	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.child = child;
		this.onMouse = onMouse;
		this.focusedChild = isFocusable(child) ? (child as Component & Focusable) : undefined;
	}

	/** Focusable forwarding (X018): the wrapper receives the TUI focus
	 * (gesture target ownership), so the focused flag must reach the child —
	 * otherwise a wrapped Input never emits CURSOR_MARKER and the hardware
	 * cursor / IME candidate window misplaces itself. */
	get focused(): boolean {
		return this.focusedChild?.focused ?? false;
	}

	set focused(value: boolean) {
		if (this.focusedChild !== undefined) this.focusedChild.focused = value;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		const childResult = dispatchMouseEvent(this.child, event);
		if (!childResult) return this.onMouse(event);
		// Rewrite the gesture target to THIS wrapper: the child is a private
		// field not reachable from the mounted tree, so gesture liveness
		// (X018) tracks the wrapper — the mounted unit — and drag/release
		// re-enter through it with the same coordinates (the child receives
		// the event untransformed). A focus request from the child lands on
		// the wrapper too, so overlay focus state and keyboard routing see
		// the mounted unit.
		return {
			...childResult,
			...(childResult.focus ? { focusTarget: this } : {}),
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	invalidate(): void {
		this.child.invalidate();
	}

	/** Transparent keyboard forwarding: a focus request from the mouse
	 * handler lands on the wrapper, so keystrokes must reach the child. */
	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.child.wantsKeyRelease;
	}

	/**
	 * Release the owned child (dsh-pi-tui divergence X007): MouseRegion is
	 * an owning wrapper — containers call dispose() on removal, and the
	 * child's resources (e.g. a Loader's animation timer) must be released
	 * exactly once when the region is removed. Idempotent.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.child.dispose?.();
	}
}
