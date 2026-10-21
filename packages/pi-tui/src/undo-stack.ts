/**
 * Generic undo stack with caller-detached snapshot semantics.
 *
 * Stores snapshots as-is: callers must push already-detached state (the
 * editor shallow-clones its mutable containers; the input pushes immutable
 * primitives). Popped snapshots are returned directly (no re-cloning) since
 * they are already detached. (dsh-pi-tui divergence X004B: the previous
 * clone-on-push semantics re-deep-cloned every snapshot, so the editor's
 * shallow snapshot was pointless — O(document) memory churn per edit.)
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** Store the given (caller-detached) snapshot on the stack. */
	push(state: S): void {
		this.stack.push(state);
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
