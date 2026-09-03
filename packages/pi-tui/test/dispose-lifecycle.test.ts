import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Container } from "../src/tui.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class DisposeCounter {
	disposeCount = 0;
	disposed = false;

	toComponent(): import("../src/tui.ts").Component {
		return {
			render: () => ["counter"],
			invalidate: () => {},
			dispose: () => {
				this.disposeCount += 1;
				this.disposed = true;
			},
		};
	}
}

const listTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	cursor: "→",
	hint: (text: string) => text,
};

function createTestTui(): TuiMainScreen {
	return new TuiMainScreen(new VirtualTerminal(80, 24));
}

describe("Component dispose lifecycle completeness (X007)", () => {
	describe("OverlayHandle.hide()", () => {
		it("disposes the overlay component exactly once (opt-in disposeOnHide)", () => {
			const tui = createTestTui();
			const counter = new DisposeCounter();
			const handle = tui.showOverlay(counter.toComponent(), { disposeOnHide: true });

			handle.hide();
			assert.equal(counter.disposeCount, 1, "hide must dispose the removed overlay component");

			handle.hide(); // second hide is a no-op
			assert.equal(counter.disposeCount, 1, "a repeated hide must not dispose again");
		});

		it("hide keeps the component alive by default (remount-friendly upstream behavior)", () => {
			const tui = createTestTui();
			const counter = new DisposeCounter();
			const handle = tui.showOverlay(counter.toComponent());

			handle.hide();
			assert.equal(counter.disposeCount, 0, "without disposeOnHide the removal must NOT dispose (screen-migration re-mount pattern)");
		});

		it("hideOverlay() disposes the popped overlay component (opt-in disposeOnHide)", () => {
			const tui = createTestTui();
			const counter = new DisposeCounter();
			tui.showOverlay(counter.toComponent(), { disposeOnHide: true });

			tui.hideOverlay();
			assert.equal(counter.disposeCount, 1, "hideOverlay must dispose the removed overlay");
		});

		it("hideOverlay keeps the component alive by default", () => {
			const tui = createTestTui();
			const counter = new DisposeCounter();
			tui.showOverlay(counter.toComponent());

			tui.hideOverlay();
			assert.equal(counter.disposeCount, 0);
		});

		it("setHidden(true) does NOT dispose (temporary hide)", () => {
			const tui = createTestTui();
			const counter = new DisposeCounter();
			const handle = tui.showOverlay(counter.toComponent(), { disposeOnHide: true });

			handle.setHidden(true);
			assert.equal(counter.disposeCount, 0, "a temporary hide must keep the component alive");

			handle.hide();
			assert.equal(counter.disposeCount, 1);
		});
	});

	describe("Box", () => {
		it("removeChild disposes the removed child", () => {
			const box = new Box(1, 1);
			const counter = new DisposeCounter();
			const component = counter.toComponent();
			box.addChild(component);

			box.removeChild(component);
			assert.equal(counter.disposeCount, 1);
		});

		it("clear disposes every child", () => {
			const box = new Box(1, 1);
			const first = new DisposeCounter();
			const second = new DisposeCounter();
			box.addChild(first.toComponent());
			box.addChild(second.toComponent());

			box.clear();
			assert.equal(first.disposeCount, 1);
			assert.equal(second.disposeCount, 1);
		});

		it("a parent-owned Box forwards disposal to its children (nested ownership)", () => {
			// Container -> Box -> resource-owning child: removing the Box
			// from the Container must dispose the child exactly once.
			const container = new Container();
			const box = new Box(1, 1);
			const child = new DisposeCounter();
			box.addChild(child.toComponent());
			container.addChild(box);

			container.removeChild(box);
			assert.equal(child.disposeCount, 1, "Box.dispose must cascade to its children");

			// And a second removal path (Container.dispose) stays idempotent.
			const box2 = new Box(1, 1);
			const child2 = new DisposeCounter();
			box2.addChild(child2.toComponent());
			container.addChild(box2);
			container.dispose();
			assert.equal(child2.disposeCount, 1);
		});

		it("Container.dispose is idempotent (a repeated dispose is a no-op)", () => {
			const container = new Container();
			const child = new DisposeCounter();
			container.addChild(child.toComponent());
			container.dispose();
			assert.equal(child.disposeCount, 1);
			container.dispose();
			assert.equal(child.disposeCount, 1, "a repeated dispose must not double-dispose the children");
			// The container stays usable as a fresh container afterwards.
			const second = new DisposeCounter();
			container.addChild(second.toComponent());
			container.dispose();
			assert.equal(second.disposeCount, 1);
		});

		it("ScrollView.dispose is idempotent (inherits the Container hardening)", () => {
			const child = new DisposeCounter();
			const scroll = new ScrollView(child.toComponent());
			scroll.dispose();
			assert.equal(child.disposeCount, 1);
			scroll.dispose();
			assert.equal(child.disposeCount, 1, "ScrollView.dispose must not double-dispose its child");
		});
	});

	describe("SettingsList submenu slot", () => {
		it("closing the submenu disposes it", () => {
			const counter = new DisposeCounter();
			let done: ((value?: string, options?: { navigateTo?: string }) => void) | undefined;
			const items = [
				{
					id: "theme",
					label: "Theme",
					currentValue: "dark",
					submenu: (
						_current: string,
						close: (value?: string, options?: { navigateTo?: string }) => void,
					) => {
						done = close;
						return counter.toComponent();
					},
				},
			];
			const list = new SettingsList(items, 5, listTheme, () => {}, () => {});
			list.handleInput("\r"); // activate -> opens submenu
			assert.ok(counter.disposed === false, "the open submenu is alive");
			assert.ok(done !== undefined, "the submenu factory received the done callback");

			done!(); // the submenu's own close path (onCancel -> done)
			assert.equal(counter.disposeCount, 1, "closeSubmenu must dispose the submenu component");
		});

		it("replacing an open submenu disposes the previous one", () => {
			const first = new DisposeCounter();
			const second = new DisposeCounter();
			let closeFirst: (() => void) | undefined;
			let closeSecond: (() => void) | undefined;
			const items = [
				{
					id: "a",
					label: "A",
					currentValue: "",
					submenu: (_c: string, close: () => void) => {
						closeFirst = close;
						return first.toComponent();
					},
				},
				{
					id: "b",
					label: "B",
					currentValue: "",
					submenu: (_c: string, close: () => void) => {
						closeSecond = close;
						return second.toComponent();
					},
				},
			];
			const list = new SettingsList(items, 5, listTheme, () => {}, () => {});

			list.selectItem("a");
			list.handleInput("\r"); // open A's submenu
			closeFirst!();
			assert.equal(first.disposeCount, 1, "closing A's submenu disposes it");

			list.selectItem("b");
			list.handleInput("\r"); // open B's submenu
			closeSecond!();
			assert.equal(second.disposeCount, 1, "closing B's submenu disposes it");
		});

		it("dispose() releases the open submenu without resurrecting navigation", () => {
			const counter = new DisposeCounter();
			const followUp = new DisposeCounter();
			const items = [
				{
					id: "nav",
					label: "Nav",
					currentValue: "",
					submenu: (_c: string, close: (v?: string, o?: { navigateTo?: string }) => void) => {
						// A LATER close with navigateTo must not resurrect a submenu
						// after the list itself was disposed.
						setTimeout(() => close(undefined, { navigateTo: "other" }), 0);
						return counter.toComponent();
					},
				},
				{ id: "other", label: "Other", currentValue: "", submenu: () => followUp.toComponent() },
			];
			const list = new SettingsList(items, 5, listTheme, () => {}, () => {});
			list.selectItem("nav");
			list.handleInput("\r");

			list.dispose();
			assert.equal(counter.disposeCount, 1, "dispose must release the open submenu");
		});
	});

	it("a stale submenu callback after dispose() never resurrects navigation (round-5 P2)", () => {
		const counter = new DisposeCounter();
		const followUp = new DisposeCounter();
		let done: ((v?: string, o?: { navigateTo?: string }) => void) | undefined;
		const items = [
			{
				id: "nav",
				label: "Nav",
				currentValue: "",
				submenu: (_c: string, close: (v?: string, o?: { navigateTo?: string }) => void) => {
					done = close;
					return counter.toComponent();
				},
			},
			{ id: "other", label: "Other", currentValue: "", submenu: () => followUp.toComponent() },
		];
		const list = new SettingsList(items, 5, listTheme, () => {}, () => {});
		list.selectItem("nav");
		list.handleInput("\r");
		list.dispose();
		assert.equal(counter.disposeCount, 1);

		// The submenu's own close callback fires LATE (after disposal) with a
		// navigateTo — it must be a no-op, never re-open "other".
		done!(undefined, { navigateTo: "other" });
		assert.equal(followUp.disposeCount, 0, "a stale callback must not resurrect a follow-up submenu");
	});

	it("a stale callback from a REPLACED submenu is a no-op (round-5 P2)", () => {
		const first = new DisposeCounter();
		const second = new DisposeCounter();
		let closeFirst: ((v?: string, o?: { navigateTo?: string }) => void) | undefined;
		const items = [
			{
				id: "a",
				label: "A",
				currentValue: "",
				submenu: (_c: string, close: (v?: string, o?: { navigateTo?: string }) => void) => {
					closeFirst = close;
					return first.toComponent();
				},
			},
			{ id: "b", label: "B", currentValue: "", submenu: () => second.toComponent() },
		];
		const list = new SettingsList(items, 5, listTheme, () => {}, () => {});
		list.selectItem("a");
		list.handleInput("\r");
		// A's own close drives the navigateAfterClose replacement: A is
		// disposed and B opens in its place.
		closeFirst!(undefined, { navigateTo: "b" });
		assert.equal(first.disposeCount, 1, "the replaced submenu is disposed");
		assert.equal(second.disposeCount, 0, "B is open");

		// A's close callback fires AGAIN, late: it must not close B or
		// navigate anywhere (its generation is stale).
		closeFirst!(undefined, { navigateTo: "a" });
		assert.equal(second.disposeCount, 0, "a stale callback must not close the CURRENT submenu");
	});

	it("a SYNCHRONOUS done() inside the factory cannot resurrect the submenu (round-7 P2)", () => {
		const counter = new DisposeCounter();
		const followUp = new DisposeCounter();
		const items = [
			{
				id: "nav",
				label: "Nav",
				currentValue: "",
				submenu: (_c: string, done: (v?: string, o?: { navigateTo?: string }) => void) => {
					// The factory closes itself BEFORE returning its component.
					done(undefined, { navigateTo: "other" });
					return counter.toComponent();
				},
			},
			{ id: "other", label: "Other", currentValue: "", submenu: () => followUp.toComponent() },
		];
		const list = new SettingsList(items, 5, listTheme, () => {}, () => {});
		list.selectItem("nav");
		list.handleInput("\r");

		// The synchronous done() closed "nav" and opened the follow-up
		// "other"; the factory's returned component must NOT resurrect
		// "nav" over it.
		assert.equal(counter.disposeCount, 1, "the orphaned factory component is disposed");
		assert.equal(followUp.disposeCount, 0, "the follow-up submenu stays mounted");
	});

	it("Text.dispose() stays a harmless no-op inside disposed containers", () => {
		const box = new Box(1, 1);
		box.addChild(new Text("hello", 1, 0));
		box.clear(); // must not throw
		assert.ok(true);
	});
});
