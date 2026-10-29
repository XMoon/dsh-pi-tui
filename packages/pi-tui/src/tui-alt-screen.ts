import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	type AltScreenSearchMatch,
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getLayoutBoxesAt,
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutBox,
	type LayoutFrame,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	getKittyImagePlacementRows,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type SixelScreenPort,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	Container,
	setMouseDispatchAllowedSet,
	setMouseDispatchRecorder,
	CURSOR_MARKER,
	compositeTuiLine,
	dispatchMouseEvent,
	type OverlayHandle,
	type OverlayTextSelectionRegion,
	retargetMouseEvent,
	TuiBase,
	type TuiMouseButton,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const PAGE_SCROLL_OVERLAP = 4;
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
const DOUBLE_CLICK_INTERVAL_MS = 500;
const COPY_ERROR_FLASH_DURATION_MS = 5000;
// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so mirror common terminal word-selection behavior by keeping paths and kebab-case tokens whole.
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"]);
const wordSegmenter = getWordSegmenter();

interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	/** Whether this point lies between terminal cells rather than on a cell. */
	boundary?: boolean;
}

interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

interface ScrollToEndIndicatorRect {
	row: number;
	column: number;
	width: number;
}

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

interface ActiveSearch {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

export interface TuiAltScreenOptions {
	/**
	 * Logical lines moved for each mouse-wheel event (default: 1). `"auto"` accelerates fast wheel
	 * spins on terminals that send one event per notch. Alt+wheel moves five times as far.
	 */
	wheelScrollLines?: WheelScrollLines;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/**
	 * Use this image protocol for THIS alternate-screen instance instead of the
	 * process-wide `getCapabilities().images` snapshot. The host passes `kitty`
	 * when a managed Native Kitty graphics handle exists, including while a
	 * Zellij live-pane admission is still pending: whether pixels may actually
	 * be painted stays the graphics handle's `canPaint()` decision, while the
	 * screen's clear/redraw/release strategy must already be Kitty. The global
	 * capability cache is never changed by this option; the existing iTerm2
	 * suppression/restore lifecycle still applies. (dsh-pi-tui divergence X070.)
	 */
	imageProtocolOverride?: ImageProtocol | "sixel";
	/**
	 * The Client-local SIXEL trust port (X072). Present only when a Direct SIXEL
	 * graphics owner exists for this app: this screen then recognises the owner's
	 * registered rasters, paints their anchors last, and re-encodes a visible crop
	 * instead of ever cutting a DCS string. Absent means every existing protocol
	 * path is untouched.
	 */
	sixelScreen?: SixelScreenPort;
	/** Style a non-current transcript search match. */
	searchMatchStyle?: (text: string) => string;
	/** Style the current transcript search match. */
	searchCurrentMatchStyle?: (text: string) => string;
	/** Style a transcript search navigation button. */
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	/**
	 * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
	 * primary scroll view while that view is scrolled away from its end.
	 */
	scrollToEndIndicator?: () => string;
	/**
	 * Force the jump-to-end label to show even when the primary scroll view already
	 * follows its end — the host's virtual transcript window is not at the live tail.
	 * Consulted only when {@link scrollToEndIndicator} is set and the primary view
	 * supports follow-end. (dsh-pi-tui divergence X028.)
	 */
	shouldShowScrollToEndIndicator?: () => boolean;
	/**
	 * Handle a primary-button press on the jump-to-end label. Returning true consumes
	 * the click (the host performed its own semantic jump); otherwise the fork falls
	 * back to scrolling the local view to its end. (dsh-pi-tui divergence X028.)
	 */
	onScrollToEndIndicator?: () => boolean | void;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Currently enabled on Windows only. */
	onRightClickPaste?: () => void;
	/** Automatically copy selected text to the clipboard on mouse release (default: true). */
	copyOnSelect?: boolean;
	/**
	 * Copy selected text to the system clipboard. Return `true` on success, an error message to
	 * display on failure, or `false` for a generic error. When omitted, the selection is copied
	 * via an OSC 52 write.
	 */
	copySelection?: (text: string) => Promise<boolean | string>;
	/**
	 * Called when a viewport navigation attempt reaches an edge. The callback
	 * receives -1 for older/upward navigation and +1 for newer/downward
	 * navigation, plus the input source. Returning true lets the host replace
	 * the document (for example, by loading another virtual transcript window).
	 * This is a public boundary seam; consumers never need the private layout or
	 * ScrollView instance to implement virtualized history. (dsh-pi-tui
	 * divergence X028.)
	 */
	onScrollBoundary?: (direction: -1 | 1, source: "wheel" | "page" | "scrollbar") => boolean | void;
	/**
	 * Give a host semantic action first refusal of a non-mouse viewport key.
	 * Returning true consumes the key. This runs before the fork's built-in
	 * Home/End/Page navigation, which lets a Host action such as Ctrl+End keep
	 * its meaning even when a Home/End preset maps that chord to bottom-scroll.
	 * (dsh-pi-tui divergence X028.)
	 */
	onBeforeViewportInput?: (data: string) => boolean | void;
	/**
	 * Handle a primary-button click on one cell: a press and release at the
	 * same cell with no drag in between and no OSC 8 URL under the cursor.
	 * dsh-pi-tui extension: lets the host react to clicks (e.g. expand one
	 * transcript card) without reimplementing selection. (dsh-pi-tui
	 * divergence X018.)
	 */
	onCellClick?: (x: number, y: number) => void;
	/**
	 * A plain left press that starts a selection gesture (the press half
	 * of the same-cell click that later fires {@link onCellClick}).
	 * dsh-pi-tui extension: lets the host record a press-time semantic
	 * identity (e.g. a modal's logical target) so the release click can
	 * reject targets that repainted onto the same cell. (dsh-pi-tui
	 * divergence X018.)
	 */
	onCellPress?: (x: number, y: number) => void;
	/**
	 * The frame-completion boundary: called at the END of every painted
	 * frame, AFTER the frame's layout pass has committed (the scroll
	 * viewport state and every component's painted placement are final).
	 * dsh-pi-tui extension: the host commits its last-painted geometry
	 * snapshot here — the press path of a same-cell click must resolve
	 * against the frame the user actually SAW, never re-measured live
	 * state (a re-measure between paint and press would hand the click to
	 * a target the user never saw). (dsh-pi-tui divergence X054.)
	 */
	onFramePainted?: () => void;
	/**
	 * Defer the viewport input listener's registration out of the
	 * constructor (dsh-pi-tui divergence X043). Input listeners run in
	 * REGISTRATION order, and the constructor registers the viewport
	 * listener FIRST — so every later host listener (the app's single
	 * router, raw-capture stages) sees a chunk only AFTER the viewport has
	 * already consumed wheel/mouse events and semantic scroll keys. With
	 * this option the host installs its own listeners first, then calls
	 * {@link TuiAltScreen.installViewportListener} exactly once.
	 */
	deferViewportListener?: boolean;
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol | "sixel" = null;
	/** Per-instance protocol selection; never mutates the process-wide cache. */
	private readonly imageProtocolOverride?: ImageProtocol | "sixel";
	private savedCapabilities?: TerminalCapabilities;
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	/**
	 * Per-row trusted SIXEL block height of the LAST painted frame (X074).
	 *
	 * Cached instead of re-derived from the line: the previous anchor is a
	 * registered DCS only while its owner lives, and a disposed raster must still
	 * have its whole footprint erased.
	 */
	private previousSixelRows: number[] = [];
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	/** Components the current mouse dispatch reached (recorded via
	 * setMouseDispatchRecorder). */
	private lastMouseDispatchComponents = new Set<Component>();
	/** Snapshot of {@link lastMouseDispatchComponents} at selection-press
	 * time: the release's synthesized click may only reach components that
	 * were reachable when the press was rejected — a control painted after
	 * the press (a structural repaint between press and release) must not
	 * receive it. (dsh-pi-tui divergence X018 hardening.) */
	private selectionPressDispatchComponents: Set<Component> | undefined;
	/** The overlay-owned selection region of the CURRENT gesture, when the press
	 * started inside an overlay that opted into `textSelectionInsets`
	 * (dsh-pi-tui divergence X068). A discardable latch, never a second
	 * selection: {@link selectionAnchor}/{@link selectionFocus} remain the one
	 * range, and this only bounds and revalidates it. */
	private overlaySelectionOrigin: OverlayTextSelectionRegion | undefined;
	private scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	private activeSearch?: ActiveSearch;
	private pressedUrl?: string;
	private selectionDragged = false;
	private mouseCapture?: TuiMouseDispatchTarget;
	private mousePressTarget?: TuiMouseDispatchTarget;
	/** The overlay's painted placement at press time (painted-placement
	 * liveness: the CURRENT overlay placement must still match it before a
	 * synthetic click is synthesized). */
	private mousePressOverlayPlacement:
		| { entry: { component: Component }; col: number; row: number; width: number; height: number }
		| undefined;
	private mousePressPoint?: { x: number; y: number };
	private mousePressMoved = false;
	private lastComponentClick?: {
		timestamp: number;
		count: number;
		component: Component;
		x: number;
		y: number;
	};
	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly mouseEnabled: boolean;
	private readonly searchMatchStyle: (text: string) => string;
	private readonly searchCurrentMatchStyle: (text: string) => string;
	private readonly searchNavigationButtonStyle: (text: string, hovered: boolean) => string;
	private readonly scrollToEndIndicator?: () => string;
	private readonly shouldShowScrollToEndIndicator?: () => boolean;
	private readonly onScrollToEndIndicator?: () => boolean | void;
	private readonly openUrl?: (url: string) => void;
	private readonly onRightClickPaste?: () => void;
	private copyOnSelect: boolean;
	private readonly copySelection?: (text: string) => Promise<boolean | string>;
	private readonly onCellClick?: (x: number, y: number) => void;
	private readonly onCellPress?: (x: number, y: number) => void;
	private readonly onFramePainted?: () => void;
	private readonly onScrollBoundary?: (direction: -1 | 1, source: "wheel" | "page" | "scrollbar") => boolean | void;
	private readonly onBeforeViewportInput?: (data: string) => boolean | void;
	private scrollbarBoundaryNotified?: -1 | 1;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory, options.sixelScreen);
		this.implicitDocument = {
			render: (width) => super.render(width),
			handleMouse: (event) => super.handleMouse(event),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		this.mouseEnabled = options.mouse ?? true;
		this.imageProtocolOverride = options.imageProtocolOverride;
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		this.shouldShowScrollToEndIndicator = options.shouldShowScrollToEndIndicator;
		this.onScrollToEndIndicator = options.onScrollToEndIndicator;
		this.openUrl = options.openUrl;
		this.onRightClickPaste = options.onRightClickPaste;
		this.copyOnSelect = options.copyOnSelect ?? true;
		this.copySelection = options.copySelection;
		this.onCellClick = options.onCellClick;
		this.onCellPress = options.onCellPress;
		this.onFramePainted = options.onFramePainted;
		this.onScrollBoundary = options.onScrollBoundary;
		this.onBeforeViewportInput = options.onBeforeViewportInput;
		if (options.deferViewportListener !== true) {
			this.viewportListenerInstalled = true;
			this.addInputListener((data) => this.handleViewportInput(data));
		}
	}

	/**
	 * Register the viewport input listener explicitly — only valid with the
	 * {@link TuiAltScreenOptions.deferViewportListener} constructor option,
	 * idempotent afterwards (subsequent calls are no-ops). Registration
	 * order IS dispatch order: call this AFTER every host listener that
	 * must see raw chunks first. (dsh-pi-tui divergence X043.)
	 */
	installViewportListener(): void {
		if (this.viewportListenerInstalled) return;
		this.viewportListenerInstalled = true;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	private viewportListenerInstalled = false;

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setWheelScrollLines(lines: WheelScrollLines): void {
		this.wheelScroll.setLines(lines);
	}

	getCopyOnSelect(): boolean {
		return this.copyOnSelect;
	}

	setCopyOnSelect(enabled: boolean): void {
		this.copyOnSelect = enabled;
	}

	/** Whether the fullscreen viewport has a non-empty active text selection. */
	hasActiveSelection(): boolean {
		return this.getActiveSelectionText() !== undefined;
	}

	/** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	/**
	 * Drop the text selection and multi-click history, e.g. before the host
	 * replaces the transcript.
	 *
	 * `preserveClickHistory` (dsh-pi-tui divergence X068) keeps the multi-click
	 * window alive for a repaint that does NOT replace the corpus — the host
	 * repainting an overlay's own content while the user is mid gesture. The
	 * selection range still dies (its cells name the frame being replaced), but
	 * dropping `lastClick` there would turn every double-click into two single
	 * clicks, because the first click's own disclosure repaint runs through the
	 * same host callback.
	 */
	resetTextSelection(options?: { preserveClickHistory?: boolean }): void {
		this.clearTextSelection();
		if (options?.preserveClickHistory !== true) this.lastClick = undefined;
	}

	/** The lines of the last rendered frame, one per terminal row, as written to the terminal. */
	getScreenLines(): string[] {
		return [...this.previousScreen];
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		// A gesture captured on the OLD root's tree must not survive the
		// swap (the live-tree liveness check would otherwise still accept a
		// component that is also a direct child). (dsh-pi-tui divergence
		// X018 hardening.)
		this.clearComponentMouseGesture();
		this.requestRender();
	}

	/**
	 * The last-painted screen rect of a mounted component — the frame the
	 * user last SAW — or undefined when the component is not part of the
	 * last painted layout. The narrow read-only painted-geometry query
	 * (dsh-pi-tui divergence X054): a host that must resolve a click
	 * against the painted frame (never re-measured live state) reads the
	 * chrome heights here at the {@link TuiAltScreenOptions.onFramePainted}
	 * boundary. Only the rect is exposed — never the internal layout tree.
	 */
	getPaintedBox(component: Component): { x: number; y: number; width: number; height: number } | undefined {
		const frame = this.currentLayout;
		if (frame === undefined) return undefined;
		const visit = (box: LayoutBox): { x: number; y: number; width: number; height: number } | undefined => {
			if (box.component === component) return { ...box.rect };
			for (const child of box.children) {
				const match = visit(child);
				if (match) return match;
			}
			return undefined;
		};
		return visit(frame.root);
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = this.imageProtocolOverride !== undefined ? this.imageProtocolOverride : capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.overlaySelectionOrigin = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.clearComponentMouseGesture();
		this.lastComponentClick = undefined;
		this.resetRenderState();
		const term = process.env.TERM?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		const mouseSequence =
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.closeSearch();
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		// A stop ends the screen that painted the overlay frame, so an
		// overlay-owned range names cells that are about to be replaced. Retire
		// it whether the gesture was still in flight or already released; a
		// completed background selection keeps its upstream #9311 semantics.
		// (dsh-pi-tui divergence X068.)
		if (this.overlaySelectionOrigin !== undefined) this.clearTextSelection();
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.clearComponentMouseGesture();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		// A stop during an in-flight selection must not retain the
		// press-time dispatch snapshot (no stale component references
		// across stop/restart). (dsh-pi-tui divergence X018 hardening.)
		this.selectionPressDispatchComponents = undefined;
		if (options.preserveScreen) {
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
			this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
				(line) =>
					// A SIXEL raster belongs to the alt screen that just ended: replaying
					// its DCS as main-screen history text would paint a stale image over
					// the restored content. (X074.)
					this.sixelFootprint(line) !== undefined
						? ""
						: isImageLine(line) || visibleWidth(line) <= width
							? line
							: sliceByColumn(line, 0, width, true),
			);
			let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
			for (let row = 0; row < this.lastDocument.length; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
			this.terminal.write(buffer);
		}
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	private prepareKittyScreen(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);

			const cachedImage = this.uploadedKittyImages.get(placement.imageId);
			const nextCachedImage = {
				transmissionGeneration: placement.transmissionGeneration,
				transmissionBytes: placement.transmissionBytes,
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			if (cachedImage) this.uploadedKittyImages.delete(placement.imageId);
			this.uploadedKittyImages.set(placement.imageId, nextCachedImage);

			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? placement.replacementLine
				: line;
		});

		let cachedOffscreenImageCount = 0;
		let cachedOffscreenTransmissionBytes = 0;
		let cachedOffscreenDecodedBytes = 0;
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (visibleImageIds.has(imageId)) continue;
			cachedOffscreenImageCount += 1;
			cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
		}

		let evictedImageDeletion = "";
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (
				cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
				cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
				cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
			) {
				break;
			}
			if (visibleImageIds.has(imageId)) continue;
			evictedImageDeletion += deleteKittyImage(imageId);
			this.uploadedKittyImages.delete(imageId);
			cachedOffscreenImageCount -= 1;
			cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
		}
		return { lines, evictedImageDeletion };
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousSixelRows = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	/**
	 * Per-row trusted SIXEL block heights for this frame, dropping any block a
	 * visible overlay paints over (X074).
	 *
	 * The raster is ONE command covering its whole footprint and it is written
	 * LAST, so a per-row decision would either cover the overlay text or leave
	 * half a picture. Such a block yields this frame; its identity row above stays
	 * on screen and the block returns when the overlay is gone (the anchor line
	 * changes, so the next frame re-enters the changed range).
	 */
	private prepareSixelRows(screen: string[]): number[] {
		const rows = new Array<number>(screen.length).fill(0);
		let any = false;
		for (let row = 0; row < screen.length; row++) {
			const footprint = this.sixelFootprint(screen[row] ?? "");
			if (footprint === undefined) continue;
			rows[row] = footprint.rows;
			any = true;
		}
		if (!any) return rows;
		if (this.hasOverlayEntries) {
			for (let row = 0; row < rows.length; row++) {
				const height = rows[row] ?? 0;
				if (height === 0) continue;
				if (!this.linesCoveredByOverlay(row, row + height - 1, screen.length)) continue;
				screen[row] = "";
				rows[row] = 0;
			}
		}
		return rows;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		if (!lines) return;

		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestRender();
			return;
		}
	}

	private toggleSearch(): void {
		if (this.activeSearch) {
			this.closeSearch();
			return;
		}
		const component = new AltScreenSearchComponent(
			(query) => this.updateSearchQuery(query),
			this.searchNavigationButtonStyle,
		);
		const search: ActiveSearch = {
			component,
			index: new AltScreenSearchIndex(),
			query: "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.activeSearch = search;
		search.overlay = this.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 32,
			margin: 1,
		});
	}

	private closeSearch(): void {
		const search = this.activeSearch;
		if (!search) return;
		this.activeSearch = undefined;
		search.overlay?.hide();
		this.requestRender();
	}

	/** Close the built-in fullscreen transcript search, if one is active. (dsh-pi-tui divergence X028.) */
	clearSearch(): boolean {
		if (!this.activeSearch) return false;
		this.closeSearch();
		return true;
	}

	private updateSearchQuery(query: string): void {
		const search = this.activeSearch;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.requestRender();
	}

	private navigateSearch(direction: -1 | 1): void {
		const search = this.activeSearch;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.requestRender();
	}

	private getSearchNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		const search = this.activeSearch;
		const bounds = search?.overlay?.getBounds();
		if (!search || !bounds) return undefined;
		if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
			return undefined;
		}
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	private handleSearchMouseEvent(event: SgrMouseEvent): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const direction = this.getSearchNavigationDirectionAt(event.x, event.y);
		if (search.component.setHoveredNavigationDirection(direction)) this.requestRender();
		if (direction === undefined || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) {
			return false;
		}
		this.navigateSearch(direction);
		return true;
	}

	private refreshSearch(layout: LayoutFrame): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		const lines = box?.scrollContentLines;
		if (!lines || !search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}

		const shouldRevealSelection = search.selectionMode !== "retain";
		const result = search.index.search(lines, search.query);
		const matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.selectionMode === "retain") return false;

		const exactIndex = result.changed
			? search.selectedKey
				? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
				: -1
			: search.selectedIndex;
		let selectedIndex = -1;
		if (matches.length > 0) {
			if (search.selectionMode === "query") {
				let low = 0;
				let high = matches.length;
				while (low < high) {
					const middle = low + Math.floor((high - low) / 2);
					if ((matches[middle]!.segments[0]?.row ?? 0) < search.anchorRow) low = middle + 1;
					else high = middle;
				}
				selectedIndex = low < matches.length ? low : 0;
			} else if (search.selectionMode === "next") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
			} else if (search.selectionMode === "previous") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
			} else {
				selectedIndex =
					exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
			}
		}

		search.selectedIndex = selectedIndex;
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		let target = before;
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	private shouldDeferViewportInputToOverlay(): boolean {
		return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
	}

	private clearComponentMouseGesture(): void {
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressMoved = false;
		this.mousePressOverlayPlacement = undefined;
	}

	/** Whether a gesture target is still mounted and visible: an overlay
	 * target must still be in the overlay stack and visible, a layout
	 * target must still be part of the rendered layout frame. (dsh-pi-tui
	 * divergence X018 hardening.) */
	private isMouseTargetLive(target: TuiMouseDispatchTarget): boolean {
		return this.isComponentLive(target.component);
	}

	/** Re-derive a nested descendant's CURRENT painted offset inside a
	 * container root from the last-painted child layouts (Box padding +
	 * preceding sibling heights). Returns undefined when the target is not
	 * painted under the root. Used for overlay roots, explicit layout
	 * roots, and the implicit document (the TuiBase's own Container
	 * mouseLayout). (dsh-pi-tui divergence X018 hardening.) */
	private paintedDescendantOffset(root: Component, target: Component): { x: number; y: number } | undefined {
		// The root itself is the target (a direct overlay-root press): its
		// painted origin is the overlay origin, regardless of whether it
		// has a cached child layout.
		if (root === target) return { x: 0, y: 0 };
		const layout = this.getContainerMouseLayout(root);
		if (layout === undefined) return undefined;
		// Box padding: the child content starts after paddingX/paddingY.
		const padding = (root as { getPadding?: () => { x: number; y: number } }).getPadding?.() ?? { x: 0, y: 0 };
		let y = padding.y;
		for (const { component, height } of layout.children) {
			if (component === target) return { x: padding.x, y };
			if ((component as Container).children !== undefined) {
				const nested = this.paintedDescendantOffset(component, target);
				if (nested !== undefined) return { x: padding.x + nested.x, y: y + nested.y };
			}
			y += height;
		}
		return undefined;
	}

	/** Whether the gesture target's CURRENT painted placement matches the
	 * press-time placement: a still-mounted component whose overlay moved
	 * or reflowed (e.g. a centered overlay that grew after the press
	 * selected a described row) must not receive a synthetic click
	 * retargeted with the OLD origin — the release cell is no longer the
	 * pressed cell. (dsh-pi-tui divergence X018 hardening.) */
	private isMouseTargetPlacementLive(target: TuiMouseDispatchTarget): boolean {
		// Overlay targets AND their subtrees: the overlay's CURRENT painted
		// placement must still match the press-time placement (a nested
		// descendant's origin is offset by its wrapper's padding, so the
		// ROOT placement is the stable identity).
		for (const layout of this.renderedOverlayLayouts) {
			if (this.componentTreeContains(layout.entry.component, target.component)) {
				const press = this.mousePressOverlayPlacement;
				if (
					press === undefined ||
					press.entry !== layout.entry ||
					layout.col !== press.col ||
					layout.row !== press.row ||
					layout.width !== press.width ||
					layout.height !== press.height
				) {
					return false;
				}
				// The ROOT placement is stable, but a descendant may have
				// reflowed INSIDE it (a preceding sibling grew): the
				// target's CURRENT painted origin (re-derived from the
				// last-painted child layout) must still match the
				// press-time origin.
				const current = this.paintedDescendantOffset(layout.entry.component, target.component);
				return (
					current !== undefined &&
					current.x === target.originX - press.col &&
					current.y === target.originY - press.row
				);
			}
		}
		// Layout-root targets: the press-time origin is the box rect
		// origin (dispatchMouseToLayout sets x = screenX - box.rect.x). The
		// current layout frame must still place the component at the SAME
		// absolute origin — containment of the OLD origin is not enough (a
		// target that reflowed inside its ancestor still overlaps the old
		// point, but the release cell is no longer the pressed cell).
		if (this.currentLayout !== undefined) {
			const boxes = getLayoutBoxesAt(this.currentLayout, target.originX, target.originY);
			// The deepest box whose subtree contains the target: its
			// CURRENT rect origin + the target's offset within it (from
			// the last-painted child layout) is the target's CURRENT
			// painted origin, which must equal the press-time origin.
			const ancestor = boxes.find(box => this.componentTreeContains(box.component, target.component));
			if (ancestor !== undefined) {
				const offset = this.paintedDescendantOffset(ancestor.component, target.component);
				return (
					offset !== undefined &&
					ancestor.rect.x + offset.x === target.originX &&
					ancestor.rect.y + offset.y === target.originY
				);
			}
			// Implicit-document children (the legacy single-document mode
			// without setLayoutRoot): the implicit document renders via
			// super.render, which accumulates the TuiBase's direct children
			// vertically, so a direct child's screen origin is the implicit
			// document's current box origin + its offset within the
			// TuiBase's last-painted child layout. A sibling reflow or a
			// scroll between press and release moves the target — the
			// release cell is no longer the pressed cell, so mounted
			// liveness alone must not accept the retained click.
			const implicitBox = boxes.find(box => box.component === this.implicitDocument);
			if (implicitBox !== undefined) {
				const offset = this.paintedDescendantOffset(this, target.component);
				return (
					offset !== undefined &&
					implicitBox.rect.x + offset.x === target.originX &&
					implicitBox.rect.y + offset.y === target.originY
				);
			}
			return false;
		}
		return true;
	}

	/** Whether a component is still mounted and reachable: a live overlay,
	 * a node of the current layout root's component tree, or a direct
	 * child (implicit-document dispatch). Liveness is checked against the
	 * CURRENTLY MOUNTED component tree, never the cached layout frame: a
	 * component removed from a Container, or a whole layout root replaced
	 * via setLayoutRoot(), must stop receiving pointer events immediately —
	 * the frame only refreshes on the next paint. (dsh-pi-tui divergence
	 * X018 hardening.) */
	private isComponentLive(component: Component): boolean {
		// Overlay roots AND their subtrees: a gesture target recorded from
		// a nested dispatch (e.g. a SelectList inside an overlay-root
		// Container) must stay live for the whole gesture.
		if (this.isOverlaySubtreeLive(component)) return true;
		// The implicit document is the screen's own dispatch wrapper (its
		// handleMouse forwards to the direct children); it is always live.
		if (component === this.implicitDocument) return true;
		if (this.layoutRoot !== undefined) {
			return this.componentTreeContains(this.layoutRoot, component);
		}
		// No layout root: dispatch goes through the implicit document to
		// the direct children (and their subtrees).
		for (const child of this.children) {
			if (this.componentTreeContains(child, component)) return true;
		}
		return false;
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			// A focus-out aborts the IN-FLIGHT gesture. A COMPLETED background
			// selection survives it (upstream #9311 behavior, unchanged), but an
			// overlay-owned range may not: the frame it names is no longer the
			// one the terminal is presenting. (dsh-pi-tui divergence X068.)
			const hadOverlaySelection = this.overlaySelectionOrigin !== undefined;
			const hadActiveSelection = this.selectionPressActive || hadOverlaySelection;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			if (this.activeSearch?.component.setHoveredNavigationDirection(undefined)) this.requestRender();
			this.stopScrollbarDrag();
			this.pressedUrl = undefined;
			this.selectionDragged = false;
			this.clearComponentMouseGesture();
			this.lastComponentClick = undefined;
			// A focus-out aborts any in-flight selection gesture: release
			// the press-time dispatch snapshot too, so it cannot retain
			// the press-time components until the next gesture. (dsh-pi-tui
			// divergence X018 hardening.)
			this.selectionPressDispatchComponents = undefined;
			if (hadActiveSelection) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				this.selectionGranularity = "character";
				this.selectionInitialRange = undefined;
				this.overlaySelectionOrigin = undefined;
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			this.lastClick = undefined;
			// Do not consume focus reports: app-level input listeners (terminal
			// focus tracking for notifications, clipboard-image hints) rely on
			// them too, and the main-screen renderer lets them through.
			return undefined;
		}
		if (data === FOCUS_IN) return undefined;

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			// Wheel events go through the SAME per-event isolation as SGR
			// mouse events: a top-level wheel must not accumulate components
			// into the long-lived reached set, and a nested wheel triggered
			// during a synthetic click must not inherit the outer allow-set.
			// (dsh-pi-tui divergence X018 hardening.)
			let consumed = false;
			this.withMouseDispatchContext(() => {
				const lines = this.wheelScroll.next(wheelEvent.direction, performance.now());
				// SGR mouse button codes use bit 3 (value 8) for the Alt modifier.
				const wheelDelta =
					wheelEvent.direction * ((wheelEvent.button & 8) !== 0 ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines);
				const event = this.createMouseEvent("wheel", wheelEvent.button, wheelEvent.x, wheelEvent.y, { wheelDelta });
				const overlay = this.dispatchMouseToOverlay(event);
				const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
				if (result) {
					if (this.applyMouseDispatchResult(event, result)) this.requestRender();
					consumed = true;
					return;
				}
				// A `viewportPassthrough` overlay (X058) does not own the wheel:
				// when it leaves the event unhandled the primary viewport still
				// scrolls, on either side of the overlay rectangle. The overlay's
				// rectangle keeps pointer ownership for every event it DOES
				// handle (the dispatch above).
				if (this.shouldDeferViewportInputToOverlay() && !this.overlayViewportPassthrough()) return;
				this.routeWheel(wheelEvent, wheelDelta);
				consumed = true;
			});
			return consumed ? { consume: true } : undefined;
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			this.handleMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		// A focused (non-search) overlay keeps priority over EVERYTHING,
		// including the host seam: overlay input must never be preempted by
		// a host-claimed viewport key (Home/End, search chords). The search
		// overlay is excluded so the host seam below can still suppress the
		// built-in search key while the search input is focused.
		// A `viewportPassthrough` overlay (X058) keeps its keyboard focus but
		// lets the PRIMARY VIEWPORT's page navigation through when the overlay
		// does not consume the key. Deliberately limited to PageUp/PageDown:
		// Home/End, Ctrl+U/Ctrl+D, Up/Down and the prompt keys stay available to
		// the overlay's own focused input, so the narrow allow-list never steals
		// an editing key from the search box.
		if (this.overlayViewportPassthrough()) {
			if (keybindings.matches(data, "tui.altScreen.pageUp")) {
				const handled = this.pageViewport(-1, isRelease);
				if (handled !== undefined) return handled;
			}
			if (keybindings.matches(data, "tui.altScreen.pageDown")) {
				const handled = this.pageViewport(1, isRelease);
				if (handled !== undefined) return handled;
			}
		}
		if (this.shouldDeferViewportInputToOverlay()) return undefined;
		if (!isRelease && this.onBeforeViewportInput?.(data) === true) return { consume: true };
		// When the primary scroll view has nothing to scroll (short content, or a
		// full-screen component mounted as the layout root), let navigation keys
		// fall through to the focused component instead of consuming them.
		const primaryScrollable = this.getPrimaryScrollView().canScroll;
		if (keybindings.matches(data, "tui.altScreen.search")) {
			if (!isRelease) this.toggleSearch();
			return { consume: true };
		}
		if (this.activeSearch?.overlay?.isFocused()) {
			if (keybindings.matches(data, "tui.altScreen.searchNext")) {
				if (!isRelease) this.navigateSearch(1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
				if (!isRelease) this.navigateSearch(-1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				if (!isRelease) this.closeSearch();
				return { consume: true };
			}
		}
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			return this.pageViewport(-1, isRelease);
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			return this.pageViewport(1, isRelease);
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			if (!isRelease) this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			if (!isRelease) this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.lineUp")) {
			if (!isRelease) this.scrollBy(-1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.lineDown")) {
			if (!isRelease) this.scrollBy(1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	/**
	 * One primary-viewport page step (shared by the normal viewport key chain
	 * and the X058 `viewportPassthrough` allow-list). Preserves the upstream
	 * semantics exactly: a key RELEASE never scrolls but is still consumed when
	 * the viewport can scroll; a non-scrollable viewport falls through to the
	 * boundary callback and otherwise returns undefined (so the key reaches the
	 * focused component).
	 */
	private pageViewport(direction: -1 | 1, isRelease: boolean): { consume: true } | undefined {
		const view = this.getPrimaryScrollView();
		if (!view.canScroll) {
			if (!isRelease && this.onScrollBoundary?.(direction, "page") === true) return { consume: true };
			return undefined;
		}
		if (!isRelease) {
			const remaining = view.scrollBy(direction * Math.max(1, view.viewportHeight - PAGE_SCROLL_OVERLAP));
			if (direction < 0 ? remaining < 0 : remaining > 0) this.onScrollBoundary?.(direction, "page");
			this.requestRender();
		}
		return { consume: true };
	}

	private decodeMouseButton(button: number): TuiMouseButton {
		switch (button & 3) {
			case 0:
				return "left";
			case 1:
				return "middle";
			case 2:
				return "right";
			default:
				return "none";
		}
	}

	private createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "wheel" ? "none" : this.decodeMouseButton(button),
			x,
			y,
			screenX: x,
			screenY: y,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.terminal.rows),
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	private dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.currentLayout) return undefined;
		const visited = new Set<Component>();
		const boxes = getLayoutBoxesAt(this.currentLayout, event.screenX, event.screenY);
		for (const box of boxes) {
			if (visited.has(box.component)) continue;
			// The frame is a cache of the last paint: a box whose component
			// was removed or replaced since then must not receive a FRESH
			// pointer event (the captured-gesture path revalidates via
			// isMouseTargetLive; this covers new presses/clicks before the
			// next render). (dsh-pi-tui divergence X018 hardening.)
			if (!this.isComponentLive(box.component)) continue;
			if (getLayoutNode(box.component) && box.component.handleMouse === Container.prototype.handleMouse) continue;
			visited.add(box.component);
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y,
				width: box.rect.width,
				height: box.rect.height,
			});
			if (result) return result;
		}
		return undefined;
	}

	private applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const focusTarget = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		const focusChanged = result.focus === true && this.getFocusedComponent() !== focusTarget;
		if (result.focus) this.setFocus(focusTarget);
		if (result.capture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	private dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	private getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		const now = Date.now();
		const previous = this.lastComponentClick;
		const count =
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.component === target.component &&
			previous.x === x &&
			previous.y === y
				? (previous.count % 3) + 1
				: 1;
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		return count;
	}

	private clearTextSelection(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		// The captured overlay region dies with the range it bounded, whether
		// the clear came from resetTextSelection() (host content/screen change),
		// the modal barrier, focus-out, a stale region, the scrollbar or stop.
		// (dsh-pi-tui divergence X068.)
		this.overlaySelectionOrigin = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		// The press-time dispatch snapshot is dead once the selection
		// gesture ends: release the component references instead of
		// retaining the whole press-time reached set until the next
		// selection press or TUI disposal. (dsh-pi-tui divergence X018
		// hardening.)
		this.selectionPressDispatchComponents = undefined;
	}

	private mouseEventDepth = 0;

	/** Per-event mouse dispatch isolation, shared by SGR mouse events and
	 * wheel events: a nested mouse dispatch triggered synchronously by a
	 * child handler must not (a) be filtered by an outer synthetic-click
	 * allow-set, nor (b) overwrite the outer event's reached-component set
	 * or selection-press snapshot. Save the outer state, install a fresh
	 * set + recorder with the allow-set cleared, and restore on exit. The
	 * OUTERMOST event's selection snapshot must persist (its release reads
	 * it), so only NESTED events restore it. (dsh-pi-tui divergence X018
	 * hardening.) */
	private withMouseDispatchContext(body: () => void): void {
		const nested = this.mouseEventDepth > 0;
		this.mouseEventDepth += 1;
		const previousComponents = this.lastMouseDispatchComponents;
		const previousSelectionSnapshot = this.selectionPressDispatchComponents;
		const previousAllowedSet = setMouseDispatchAllowedSet(undefined);
		this.lastMouseDispatchComponents = new Set();
		const previousRecorder = setMouseDispatchRecorder((component) => {
			this.lastMouseDispatchComponents.add(component);
		});
		try {
			body();
		} finally {
			// Restore the PREVIOUS recorder on every exit: the module-global
			// slot must not retain a stopped/disposed TuiAltScreen (memory
			// leak), and a nested mouse dispatch must not wipe an outer
			// recorder (reentrancy). (dsh-pi-tui divergence X018 hardening.)
			setMouseDispatchRecorder(previousRecorder);
			this.lastMouseDispatchComponents = previousComponents;
			if (nested) {
				// A nested event restores the outer snapshot immediately.
				// NOTE: a child handler synchronously triggering a FULL
				// nested press+release pair is NOT a supported pattern —
				// the nested release runs after this restore and its
				// synthesized click is filtered by the OUTER snapshot
				// (dropped, never misrouted). Nested single events (a
				// press) are isolated correctly.
				this.selectionPressDispatchComponents = previousSelectionSnapshot;
			}
			setMouseDispatchAllowedSet(previousAllowedSet);
			this.mouseEventDepth -= 1;
		}
	}

	private handleMouseEvent(raw: SgrMouseEvent): void {
		this.withMouseDispatchContext(() => {
			this.handleMouseEventBody(raw);
		});
	}

	private handleMouseEventBody(raw: SgrMouseEvent): void {
		const isMotion = (raw.button & 32) !== 0;
		const type: TuiMouseEvent["type"] = raw.release
			? "release"
			: isMotion
				? this.decodeMouseButton(raw.button) === "none"
					? "move"
					: "drag"
				: "press";
		const event = this.createMouseEvent(type, raw.button, raw.x, raw.y);

		if (this.mouseCapture || this.mousePressTarget) {
			const target = this.mouseCapture ?? this.mousePressTarget!;
			// The gesture target may have been hidden or removed since the
			// gesture started (an overlay hide/removal, a layout rebuild):
			// a stale target must not keep receiving press/drag/release
			// events. Clear the gesture and fall through to a fresh
			// dispatch against the CURRENT overlays/layout. (dsh-pi-tui
			// divergence X018 hardening.)
			if (!this.isMouseTargetLive(target)) {
				this.clearComponentMouseGesture();
			} else {
				if (this.mousePressPoint && (raw.x !== this.mousePressPoint.x || raw.y !== this.mousePressPoint.y)) {
					this.mousePressMoved = true;
					this.lastComponentClick = undefined;
				}
				let render = false;
				const targetResult = this.dispatchMouseToTarget(event, target);
				if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
				if (raw.release) {
					if (
						!this.mousePressMoved &&
						this.mousePressPoint?.x === raw.x &&
						this.mousePressPoint.y === raw.y &&
						// The press-time painted placement must still match
						// the CURRENT placement: a still-mounted component
						// whose overlay moved/reflowed must not receive a
						// synthetic click retargeted with the old origin.
						// (dsh-pi-tui divergence X018 hardening.)
						this.isMouseTargetPlacementLive(target)
					) {
						const clickEvent = this.createMouseEvent("click", raw.button, raw.x, raw.y, {
							clickCount: this.getComponentClickCount(target, raw.x, raw.y),
						});
						const clickResult = this.dispatchMouseToTarget(clickEvent, target);
						if (clickResult) render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
					}
					this.clearComponentMouseGesture();
				}
				if (render) this.requestRender();
				return;
			}
		}

		// An overlay-owned text-selection gesture OWNS the pointer for its whole
		// duration (dsh-pi-tui divergence X068): drag and release belong to the
		// captured region even when the pointer leaves the overlay's rectangle,
		// and must never reach a background component, the scrollbar, the
		// jump-to-end label or the modal barrier. The handler revalidates the
		// region and clips every point into it.
		if (this.overlaySelectionOrigin !== undefined && this.selectionPressActive) {
			this.handleSelectionMouseEvent(raw);
			return;
		}

		if (this.handleSearchMouseEvent(raw)) return;

		const overlay = this.dispatchMouseToOverlay(event);
		if (!overlay.hit) {
			if (this.handleScrollToEndIndicatorMouseEvent(raw)) return;
			const scrollbarHandled = this.handleScrollbarMouseEvent(raw);
			if (!this.scrollbarDrag) this.updateScrollbarHover(raw.x, raw.y);
			if (scrollbarHandled) return;
		} else {
			this.stopScrollbarHover();
		}

		const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
		if (result) {
			const render = this.applyMouseDispatchResult(event, result);
			if (type === "press") {
				this.clearTextSelection();
				this.mousePressTarget = result.target;
				this.mousePressPoint = { x: raw.x, y: raw.y };
				this.mousePressMoved = false;
				// The overlay's painted placement at press time: the
				// painted-placement liveness check compares the CURRENT
				// overlay placement against this (a nested descendant's
				// origin is offset by its wrapper's padding, so the ROOT
				// placement is the stable identity). (dsh-pi-tui divergence
				// X018 hardening.)
				this.mousePressOverlayPlacement = undefined;
				for (const layout of this.renderedOverlayLayouts) {
					if (this.componentTreeContains(layout.entry.component, result.target.component)) {
						this.mousePressOverlayPlacement = {
							entry: layout.entry,
							col: layout.col,
							row: layout.row,
							width: layout.width,
							height: layout.height,
						};
						break;
					}
				}
			}
			if (render) this.requestRender();
			return;
		}

		// A mounted overlay owns the pointer even when its component
		// returns undefined (inert chrome / a plain overlay without mouse
		// handling): the modal must block right-click paste and transcript
		// selection on the background — a drag over an inert overlay must
		// never select/copy the hidden underlying text. (dsh-pi-tui
		// divergence X018 hardening.)
		if (overlay.hit) {
			// An unconsumed press inside the painted content rectangle of an
			// overlay that opted into `textSelectionInsets` starts the
			// alternate screen's OWN selection there. Every component still
			// gets first refusal (the dispatch above), so a button press keeps
			// its normal gesture; the region comes from the LAST PAINTED
			// placement, never from a guessed coordinate. (dsh-pi-tui
			// divergence X068.)
			if (type === "press") {
				const region = this.overlayTextSelectionRegionAt(raw.x, raw.y);
				if (region !== undefined) {
					this.handleSelectionMouseEvent(raw, region);
					return;
				}
			}
			// A gesture that STARTED outside and lands on the overlay must
			// be cancelled: an in-flight selection (or scrollbar drag) must
			// not stay armed under the modal — the hidden selection must
			// not reappear after the overlay closes, and the drag must not
			// resume on release. A COMPLETED visible selection stays.
			if (this.selectionPressActive) this.clearTextSelection();
			if (this.scrollbarDrag !== undefined) this.stopScrollbarDrag();
			return;
		}

		if (this.handleRightClickPaste(raw)) return;
		this.handleSelectionMouseEvent(raw);
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
				button,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				button,
			};
		}
		return undefined;
	}

	private routeWheel(event: WheelEvent, delta: number): void {
		let remaining = delta;
		const seen = new Set<ScrollView>();
		let primarySeen = false;
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			if (scrollView === this.getPrimaryScrollView()) primarySeen = true;
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) {
			primarySeen = true;
			remaining = primary.scrollBy(remaining);
		}
		// Only the final unconsumed remainder is a transcript boundary. A nested
		// scroll view may hit its edge and bubble into an outer view; reporting
		// the primary edge before that outer view consumes the remainder would
		// load a virtual page even though the gesture still had somewhere to go.
		// (dsh-pi-tui divergence X028.)
		if (primarySeen && remaining < 0) this.onScrollBoundary?.(-1, "wheel");
		else if (primarySeen && remaining > 0) this.onScrollBoundary?.(1, "wheel");
		this.updateScrollbarHover(event.x, event.y);
		this.requestRender();
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	private handleRightClickPaste(event: SgrMouseEvent): boolean {
		if (
			!this.onRightClickPaste ||
			process.platform !== "win32" ||
			process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||
			event.release ||
			event.button !== 2
		) {
			return false;
		}
		try {
			this.onRightClickPaste();
		} catch {
			// Clipboard paste is best-effort.
		}
		return true;
	}

	private handleScrollToEndIndicatorMouseEvent(event: SgrMouseEvent): boolean {
		const rect = this.scrollToEndIndicatorRect;
		if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
		const handled = this.onScrollToEndIndicator?.() === true;
		if (!handled) this.scrollToBottom();
		return true;
	}

	private getScrollbarTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		// A `viewportPassthrough` overlay (X058) leaves the SCROLLBAR live; every
		// other visible overlay keeps the upstream block.
		if (this.hasBlockingOverlay() || !this.currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.trackTop &&
				y < geometry.trackTop + geometry.trackHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y, true)?.scrollView);
	}

	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	private scrollScrollbarToPointer(
		scrollView: ScrollView,
		geometry: ScrollbarGeometry,
		pointerY: number,
		grabOffset: number,
	): void {
		const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
		const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
		const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
		scrollView.scrollTo(scrollTop);
		// Notify the host when dragging the PRIMARY scrollbar to an edge
		// (virtual transcript paging). (dsh-pi-tui divergence X028.)
		if (scrollView === this.getPrimaryScrollView() && geometry.maxScrollTop > 0) {
			if (scrollView.scrollTop <= 0) {
				if (this.scrollbarBoundaryNotified !== -1) {
					this.scrollbarBoundaryNotified = -1;
					this.onScrollBoundary?.(-1, "scrollbar");
				}
			} else if (scrollView.scrollTop >= geometry.maxScrollTop) {
				if (this.scrollbarBoundaryNotified !== 1) {
					this.scrollbarBoundaryNotified = 1;
					this.onScrollBoundary?.(1, "scrollbar");
				}
			} else {
				this.scrollbarBoundaryNotified = undefined;
			}
		}
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const box = this.currentLayout
				? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				this.scrollScrollbarToPointer(
					this.scrollbarDrag.scrollView,
					geometry,
					event.y,
					this.scrollbarDrag.grabOffset,
				);
			}
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		// A stationary FIRST press on a hidden auto scrollbar must jump the
		// track / start a drag immediately (includeHiddenAuto), exactly like
		// the hover path — otherwise the press is a no-op until a second
		// press after the hover revealed the bar. (dsh-pi-tui divergence
		// X018 hardening.)
		const target = this.getScrollbarTargetAt(event.x, event.y, true);
		if (!target) return false;
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.overlaySelectionOrigin = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		// The scrollbar press ends any in-flight selection gesture: release
		// the press-time dispatch snapshot too (X018 lifecycle).
		this.selectionPressDispatchComponents = undefined;
		this.setScrollbarHover(target.scrollView);
		this.scrollbarBoundaryNotified = undefined;
		const onThumb =
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		const grabOffset = onThumb ? event.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		if (!onThumb) this.scrollScrollbarToPointer(target.scrollView, target.geometry, event.y, grabOffset);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset,
		};
		return true;
	}

	private stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
		this.scrollbarBoundaryNotified = undefined;
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return this.clampSelectionPoint({
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		});
	}

	/**
	 * Clip one selection point into the captured overlay region, if any
	 * (dsh-pi-tui divergence X068). A drag that leaves the region maps to its
	 * nearest cell (the last visible cell for an exclusive boundary point), so
	 * neither the highlight nor the copied text can ever reach the frame chrome
	 * or the background behind the modal.
	 */
	private clampSelectionPoint(point: SelectionPoint): SelectionPoint {
		const region = this.overlaySelectionOrigin;
		if (region === undefined) return point;
		const { rect } = region;
		const row = Math.max(rect.minY, Math.min(rect.maxY - 1, point.row));
		const maxCol = point.boundary === true ? rect.maxX : rect.maxX - 1;
		return { ...point, row, col: Math.max(rect.minX, Math.min(maxCol, point.col)) };
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		if (point.scrollView && this.currentLayout) {
			const lines = getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines;
			if (lines) return lines[point.row] ?? "";
		}
		return this.previousScreen[point.row] ?? "";
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
			segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
			start = end;
		}
		const clickedSegmentIndex = segments.findIndex(
			(segment) => point.col >= segment.start && point.col < segment.end,
		);
		if (clickedSegmentIndex < 0) return undefined;

		const canJoin = (
			left: { selectable: boolean; joiner: boolean },
			right: { selectable: boolean; joiner: boolean },
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		let selectionStart = segments[clickedSegmentIndex].start;
		let selectionEnd = segments[clickedSegmentIndex].end;
		for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1], segments[index]); index--) {
			selectionStart = segments[index - 1].start;
		}
		for (
			let index = clickedSegmentIndex;
			index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
			index++
		) {
			selectionEnd = segments[index + 1].end;
		}
		return {
			start: this.clampSelectionPoint({ ...point, col: selectionStart }),
			end: this.clampSelectionPoint({ ...point, col: selectionEnd, boundary: true }),
		};
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		// An overlay-owned line selection covers the visible content rectangle
		// of that row, never the frame chrome around it (divergence X068).
		const region = this.overlaySelectionOrigin;
		const start = region?.rect.minX ?? 0;
		const end = region?.rect.maxX ?? visibleWidth(this.getSelectionSourceLine(point));
		return {
			start: this.clampSelectionPoint({ ...point, col: start }),
			end: this.clampSelectionPoint({ ...point, col: end, boundary: true }),
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.requestRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent, overlayOrigin?: OverlayTextSelectionRegion): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		// An overlay-owned range is only valid while the overlay it was captured
		// from is still painted at the SAME placement (dsh-pi-tui divergence
		// X068): a resize/remount, a hide/close or a newer modal clears the
		// gesture instead of copying text that no longer sits there. A PRESS is
		// exempt: its region was just resolved from the live paint.
		if (
			overlayOrigin === undefined &&
			this.overlaySelectionOrigin !== undefined &&
			!this.isOverlayTextSelectionRegionLive(this.overlaySelectionOrigin)
		) {
			this.clearTextSelection();
			return;
		}
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const isClick =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col;
			const clickedUrl = isClick ? this.pressedUrl : undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			if (isClick) {
				const clickEvent = this.createMouseEvent("click", event.button, event.x, event.y, {
					clickCount: this.lastClick?.count ?? 1,
				});
				// The synthesized click must belong to the SAME painted hit
				// relationship as the press: a control that appeared after a
				// structural repaint between press and release must not
				// receive a click whose press was rejected against the
				// previous paint. Restrict the dispatch to the components
				// that were reachable at press time. (dsh-pi-tui divergence
				// X018 hardening.)
				const previousAllowedSet = setMouseDispatchAllowedSet(this.selectionPressDispatchComponents);
				let result: TuiMouseDispatchResult | undefined;
				try {
					const overlay = this.dispatchMouseToOverlay(clickEvent);
					result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(clickEvent));
				} finally {
					// Restore the previous allow-set: a nested mouse dispatch
					// triggered by a child handler must not leak its
					// restriction into the outer traversal (reentrancy).
					setMouseDispatchAllowedSet(previousAllowedSet);
				}
				if (result) {
					const render = this.applyMouseDispatchResult(clickEvent, result);
					this.clearTextSelection();
					if (render) this.requestRender();
					return;
				}
			}
			// The press-time dispatch snapshot was consumed by the click
			// synthesis above (or was never needed for a drag): release the
			// component references now that the selection gesture ended.
			// (dsh-pi-tui divergence X018 hardening.)
			this.selectionPressDispatchComponents = undefined;
			if (
				!this.selectionDragged &&
				clickedUrl === undefined &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col &&
				// Character granularity = a single click: a double click
				// selects a word and stays a selection, never a disclosure.
				this.selectionGranularity === "character"
			) {
				// Coordinates are 0-based screen cells (SGR values minus one).
				// A plain click is a disclosure action, not a selection: skip
				// the clipboard feedback so the host callback owns the click.
				// (dsh-pi-tui divergence X018.)
				this.onCellClick?.(event.x, event.y);
				this.requestRender();
				return;
			}
			if (this.copyOnSelect) void this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		this.selectionPressActive = true;
		// ONE gesture has ONE owner: a press always installs ITS origin, so a
		// completed overlay selection can never clamp a later background press
		// into the old rectangle. (dsh-pi-tui divergence X068.)
		this.overlaySelectionOrigin = overlayOrigin;
		this.selectionPressDispatchComponents = new Set(this.lastMouseDispatchComponents);
		// The press half of a same-cell click: the host records a
		// press-time semantic identity so the release click can reject
		// targets that repainted onto the same cell. (dsh-pi-tui
		// divergence X018.)
		this.onCellPress?.(event.x, event.y);
		const scrollView =
			// A `viewportPassthrough` overlay (X058) keeps background selection
			// anchored in scroll-content coordinates; every other visible overlay
			// keeps the upstream screen-coordinate block. The overlay rectangle
			// itself already rejects selection through the pointer-ownership
			// truncation above.
			!this.hasBlockingOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		// An overlay-owned selection never arms a hyperlink: the region's text is
		// the modal's own content, not a transcript link under it.
		// (dsh-pi-tui divergence X068.)
		this.pressedUrl = range || overlayOrigin !== undefined
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.requestRender();
	}

	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	private getActiveSelectionText(): string | undefined {
		const selection = this.getSelectionBounds();
		if (!selection) return undefined;
		const region = this.overlaySelectionOrigin;
		if (region !== undefined) {
			// This is the ONE sink every read and copy path funnels through
			// (`hasActiveSelection`, `copyActiveSelectionToClipboard`, the
			// release copy), so liveness must hold HERE and not only at the
			// input handlers and the post-composite revalidation: a hidden
			// overlay, a newer overlay painted above it, a screen stop or a
			// focus-out can all invalidate the region BEFORE the next frame
			// runs that revalidation, and a read in that window would still
			// copy cells of a frame that is no longer painted. Retire the range
			// and the latch together. (dsh-pi-tui divergence X068.)
			if (!this.isOverlayTextSelectionRegionLive(region)) {
				this.clearTextSelection();
				return undefined;
			}
			return this.getOverlaySelectionText(selection, region);
		}
		let sourceLines: readonly string[] = this.previousScreen;
		if (selection.start.scrollView) {
			if (!this.currentLayout) return undefined;
			const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
			if (!box?.scrollContentLines) return undefined;
			sourceLines = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			const sliced = stripTerminalSequences(
				sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
			).trimEnd();
			// dsh-pi-tui extension: when the selection starts at the line
			// head, drop the emoji-column indent (1-3 cells) so copied
			// transcript lines do not carry the bullet column's padding.
			// Content indentation of 4+ cells (code blocks) survives;
			// 1-2 cell content indents are rare and dropped. (dsh-pi-tui
			// divergence X024.)
			lines.push(columns.start === 0 ? sliced.replace(/^ {1,3}/, "") : sliced);
		}
		const text = lines.join("\n");
		return text.length === 0 ? undefined : text;
	}

	/**
	 * The visible text of one overlay-owned selection (dsh-pi-tui divergence
	 * X068): each row is sliced to the capture's column range inside the overlay
	 * content rectangle, terminal sequences are stripped and real spaces and
	 * indentation are PRESERVED. The transcript branch's `trimEnd` and its 1-3
	 * cell bullet-strip (X024) are deliberately not applied: file content and
	 * paths must copy exactly as painted.
	 */
	private getOverlaySelectionText(
		selection: { start: SelectionPoint; end: SelectionPoint },
		region: OverlayTextSelectionRegion,
	): string | undefined {
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = this.previousScreen[row] ?? "";
			const columns = this.getSelectionColumns(line, row, selection, region.rect.minX, region.rect.maxX);
			if (columns.end <= columns.start) {
				lines.push("");
				continue;
			}
			lines.push(stripTerminalSequences(sliceByColumn(line, columns.start, columns.end - columns.start, true)));
		}
		const text = lines.join("\n");
		return text.length === 0 ? undefined : text;
	}

	private async copySelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	private async copyTextToClipboard(text: string): Promise<boolean> {
		// Prefer an injected clipboard implementation (native clipboard + platform tools with a
		// verified success path) when the host app provides one. A bare OSC 52 write can show
		// "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
		// without OSC 52 clipboard passthrough), so only report success when it actually copies.
		if (this.copySelection) {
			const result = await this.copySelection(text);
			const ok = result === true;
			this.flash(
				ok ? "Copied!" : typeof result === "string" ? result : "Copy failed",
				ok ? undefined : COPY_ERROR_FLASH_DURATION_MS,
			);
			return ok;
		}
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
		return true;
	}

	private applySearchTextHighlight(text: string, current: boolean): string {
		const style = current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
		let result = "";
		let plainStart = 0;
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				index += 1;
				continue;
			}
			if (index > plainStart) result += style(text.slice(plainStart, index));
			result += ansi.code;
			index += ansi.length;
			plainStart = index;
		}
		if (plainStart < text.length) result += style(text.slice(plainStart));
		return result;
	}

	private applySearchHighlights(screen: string[], layout: LayoutFrame): string[] {
		const search = this.activeSearch;
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		if (!box) return screen;

		const rangesByRow = new Map<number, SearchHighlightRange[]>();
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		const minRow = Math.max(0, box.rect.y, box.clip.y);
		const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
		const minColumn = Math.max(0, box.rect.x, box.clip.x);
		const maxColumn = Math.min(
			this.terminal.columns,
			box.rect.x + box.rect.width,
			box.clip.x + box.clip.width,
			scrollbarColumn ?? Number.POSITIVE_INFINITY,
		);
		const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
		const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
		let low = 0;
		let high = search.matches.length;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			const match = search.matches[middle]!;
			const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
			if (lastRow < minContentRow) low = middle + 1;
			else high = middle;
		}
		for (let matchIndex = low; matchIndex < search.matches.length; matchIndex++) {
			const match = search.matches[matchIndex]!;
			if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
			for (const segment of match.segments) {
				const row = box.rect.y + segment.row - scrollView.scrollTop;
				if (row < minRow || row >= maxRow) continue;
				const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
				const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
				if (endCol <= startCol) continue;
				const ranges = rangesByRow.get(row) ?? [];
				ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
				rangesByRow.set(row, ranges);
			}
		}

		const result = [...screen];
		for (const [row, ranges] of rangesByRow) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const lineWidth = visibleWidth(line);
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				const startCol = Math.min(range.startCol, lineWidth);
				const endCol = Math.min(range.endCol, lineWidth);
				if (endCol <= startCol) continue;
				const before = sliceByColumn(line, 0, startCol, true);
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				line = `${before}${this.applySearchTextHighlight(highlighted, range.current)}${after}`;
			}
			result[row] = line;
		}
		return result;
	}

	private applySelectionHighlight(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		// An overlay-owned selection paints ONLY inside the captured content
		// rectangle: interior rows would otherwise span the whole line and
		// invert the frame border and the covered background, while the copied
		// text is already clipped to the same rectangle (dsh-pi-tui divergence
		// X068 keeps ONE range for highlight and copy).
		const region = this.overlaySelectionOrigin;
		if (region !== undefined) {
			minRow = Math.max(minRow, region.rect.minY);
			maxRow = Math.min(maxRow, region.rect.maxY - 1);
			minColumn = Math.max(minColumn, region.rect.minX);
			maxColumn = Math.min(maxColumn, region.rect.maxX);
		}
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${this.applySelectionHighlight(selected)}${after}`;
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeScrollToEndIndicator(screen: string[], layout: LayoutFrame, width: number): string[] {
		this.scrollToEndIndicatorRect = undefined;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		// The host predicate is part of the documented contract only when an
		// indicator is configured AND the primary view supports follow-end:
		// short-circuit those prerequisites before consulting it.
		if (!this.scrollToEndIndicator || !scrollView.followEnd) return screen;
		const hostNeedsIndicator = this.shouldShowScrollToEndIndicator?.() === true;
		if (scrollView.isFollowingEnd && !hostNeedsIndicator) {
			return screen;
		}
		const box = getScrollViewBox(layout, scrollView);
		const clip = box?.clip;
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		const row = clip.y + clip.height - 1;
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
		const label = truncateToWidth(this.scrollToEndIndicator(), clip.width, "");
		const labelWidth = visibleWidth(label);
		const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
		const rightEdge = scrollbarColumn ?? clip.x + clip.width;
		const availableWidth = Math.max(0, rightEdge - column);
		const text = truncateToWidth(label, availableWidth, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		return result;
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender(), this.sixelScreen);
		if (this.refreshSearch(nextLayout)) {
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender(), this.sixelScreen);
		}
		let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		screen = this.applySearchHighlights(screen, nextLayout);
		screen = this.compositeScrollToEndIndicator(screen, nextLayout, width);
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		// An overlay-owned selection names cells of the frame it was captured
		// from. The overlays were just re-composited, so this is the FIRST point
		// where the new paint is authoritative: if the opted-in overlay moved,
		// was hidden/closed, or a newer overlay now covers it, the range must not
		// paint over the replacement frame. (dsh-pi-tui divergence X068.)
		if (this.overlaySelectionOrigin !== undefined && !this.isOverlayTextSelectionRegionLive(this.overlaySelectionOrigin)) {
			this.clearTextSelection();
		}
		screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		// The trusted SIXEL blocks of THIS frame, after overlay coverage yielded
		// (X074). Computed before the line resets because an anchor DCS must never
		// be normalized, and because a dropped block is plain blank content.
		const sixelRows = this.prepareSixelRows(screen);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (this.isRenderableImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const changedRows = screen.map((line, row) => line !== this.previousScreen[row]);
		const imageAnchorsNeedRedraw = screen.some(
			(line, row) =>
				changedRows[row] &&
				(this.isRenderableImageLine(line) || this.isRenderableImageLine(this.previousScreen[row] ?? "")),
		);
		// A SIXEL raster is ONE command: a write on ANY row it covers destroys the
		// pixels there, so a changed row inside an old or new block forces the
		// whole block to be cleared and repainted (X074).
		const sixelCoveredRows = new Set<number>();
		for (const declared of [this.previousSixelRows, sixelRows]) {
			for (let row = 0; row < declared.length; row++) {
				const rows = declared[row] ?? 0;
				for (let offset = 0; offset < rows; offset++) sixelCoveredRows.add(row + offset);
			}
		}
		const sixelNeedRedraw = changedRows.some(
			(changed, row) => changed && (sixelCoveredRows.has(row) || (sixelRows[row] ?? 0) > 0),
		);
		const isWezTerm = Boolean(process.env.WEZTERM_PANE) || process.env.TERM_PROGRAM?.toLowerCase() === "wezterm";
		const imageCellsNeedRedraw =
			!imageAnchorsNeedRedraw &&
			isWezTerm &&
			this.imageProtocol === "kitty" &&
			changedRows.some(Boolean) &&
			screen.some((line, row) => {
				const placementRows = getKittyImagePlacementRows(line);
				if (placementRows === undefined) return false;
				for (let coveredRow = row; coveredRow < row + placementRows; coveredRow++) {
					if (changedRows[coveredRow]) return true;
				}
				return false;
			});
		const imagesNeedRedraw = imageAnchorsNeedRedraw || imageCellsNeedRedraw;
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		const preparedKittyScreen =
			redrawImages && this.imageProtocol === "kitty"
				? this.prepareKittyScreen(screen)
				: { lines: screen, evictedImageDeletion: "" };

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			const clearImages =
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? deleteAllKittyPlacements()
					: this.deleteKittyImages();
			buffer += `${clearImages}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += preparedKittyScreen.evictedImageDeletion;

		// WezTerm erases intersecting Kitty image cells when a later row write touches a covered row.
		// Draw image placements after every clear and text write so nothing later intersects them; preserve
		// the existing interleaved output for text-only frames and every other terminal.
		const drawKittyImagesLast =
			redrawImages && this.imageProtocol === "kitty" && screen.some(isImageLine) && isWezTerm;
		if (drawKittyImagesLast) {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				if (isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				if (!isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
		} else {
			// Clear every row an OLD or NEW trusted SIXEL block covers before any
			// text lands on it: `CSI 2K` erases the raster cells of exactly that
			// row (a real Windows Terminal observation, not an inference), and the
			// anchor-only clear leaves pixels behind. (X074.)
			if (sixelNeedRedraw) {
				for (const row of [...sixelCoveredRows].sort((left, right) => left - right)) {
					if (row < 0 || row >= height) continue;
					buffer += `\x1b[${row + 1};1H\x1b[2K`;
				}
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				// An anchor is a device command, not cell text: text (border,
				// overlay, scrollbar, search highlight) is written first, and the
				// command follows in the pass below.
				if ((sixelRows[row] ?? 0) > 0) continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
			}
			// ONE DCS per visible, uncovered block, at its own absolute row and only
			// after every text write of this frame. Sixel and Kitty are mutually
			// exclusive protocol modes, so this pass never mixes with
			// `drawKittyImagesLast`.
			if (fullRedraw || sixelNeedRedraw) {
				for (let row = 0; row < height; row++) {
					if ((sixelRows[row] ?? 0) === 0) continue;
					buffer += `\x1b[${row + 1};1H${screen[row]}`;
				}
			}
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousSixelRows = sixelRows;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
		// The frame-completion boundary (dsh-pi-tui divergence X054): the
		// layout pass has committed and the frame is painted — the host
		// commits its last-painted geometry snapshot here (the press path
		// of a same-cell click must resolve against the frame the user
		// actually SAW, never re-measured live state).
		this.onFramePainted?.();
	}
}
