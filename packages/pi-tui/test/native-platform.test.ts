import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getNativeClipboard, getNativePlatformHelper } from "../src/native-platform.ts";

/**
 * The fork vendors only the pinned Darwin arm64/x64 prebuilds (dsh-pi-tui
 * divergence X025); the Linux X11 and Windows prebuilds remain absent, so
 * the modifier-key/clipboard helpers still degrade to `undefined` there.
 * The Linux packaging assertions below therefore only run when the X11
 * prebuild tree has been vendored; the degradation contract they replace is
 * covered by the "degrades to no native clipboard" test. The Darwin
 * assertions always run: the pinned files are part of this package.
 */
const ARM64_PREBUILD = new URL("../native/linux/prebuilds/linux-arm64/linux-platform-x11.node", import.meta.url);
const ARCH_PREBUILD = new URL(
	`../native/linux/prebuilds/linux-${process.arch}/linux-platform-x11.node`,
	import.meta.url,
);

/**
 * The exact pinned upstream files (earendil-works/pi v1.5.0 @ f9a26365,
 * `packages/tui/native/darwin/prebuilds/`). Git object IDs are the upstream
 * blob IDs, so any replacement/rebuild of the binary is detected here.
 */
const DARWIN_PREBUILDS = [
	{ arch: "arm64", size: 52_024, gitBlob: "3294b6bffd36eaab70d61134e9955992f31f9a8f", cpuType: 0x0100000c },
	{ arch: "x64", size: 22_784, gitBlob: "014383575508654d9f898ee25631b88db8d9740c", cpuType: 0x01000007 },
] as const;

function darwinPrebuild(arch: (typeof DARWIN_PREBUILDS)[number]["arch"]): URL {
	return new URL(`../native/darwin/prebuilds/darwin-${arch}/darwin-platform.node`, import.meta.url);
}

test("ships the pinned single-architecture Darwin prebuilds (X025)", () => {
	for (const expected of DARWIN_PREBUILDS) {
		const path = fileURLToPath(darwinPrebuild(expected.arch));
		const stat = lstatSync(path);
		assert.equal(stat.isSymbolicLink(), false);
		assert.equal(stat.isFile(), true);
		const binary = readFileSync(path);
		assert.equal(binary.length, expected.size);
		const gitBlob = createHash("sha1").update(`blob ${binary.length}\0`).update(binary).digest("hex");
		assert.equal(gitBlob, expected.gitBlob);
		assert.equal(binary.readUInt32LE(0), 0xfeedfacf); // Mach-O 64-bit, little endian.
		assert.equal(binary.readUInt32LE(4), expected.cpuType); // Not a universal/fat file.
		assert.equal(binary.readUInt32LE(12), 8); // MH_BUNDLE.
	}
});

test("Linux ARM64 prebuild supports 64 KB system pages", { skip: !existsSync(ARM64_PREBUILD) }, () => {
	const binary = readFileSync(ARM64_PREBUILD);
	assert.equal(binary.subarray(0, 4).toString(), "\x7fELF");
	const offset = Number(binary.readBigUInt64LE(32));
	const entrySize = binary.readUInt16LE(54);
	const count = binary.readUInt16LE(56);
	let loadSegments = 0;
	for (let index = 0; index < count; index++) {
		const entry = offset + index * entrySize;
		if (binary.readUInt32LE(entry) !== 1) continue;
		loadSegments++;
		const fileOffset = binary.readBigUInt64LE(entry + 8);
		const address = binary.readBigUInt64LE(entry + 16);
		assert.equal((address - fileOffset) % 65536n, 0n);
		assert.ok(binary.readBigUInt64LE(entry + 48) >= 65536n);
	}
	assert.ok(loadSegments > 0);
});

test(
	"Linux clipboard degrades to no helper when the prebuild is not vendored (X025)",
	{ skip: process.platform !== "linux" || !["arm64", "x64"].includes(process.arch) || existsSync(ARCH_PREBUILD) },
	() => {
		const display = process.env.DISPLAY;
		process.env.DISPLAY = ":0";
		try {
			// No prebuild file: `getNativeClipboard` must fail closed instead
			// of importing another platform's binary or crashing.
			assert.equal(getNativeClipboard(), undefined);
			assert.equal(getNativePlatformHelper(), undefined);
		} finally {
			if (display === undefined) delete process.env.DISPLAY;
			else process.env.DISPLAY = display;
		}
	},
);

// Opt in on a Windows test desktop: this replaces the system clipboard contents.
test(
	"writes Windows clipboard text through the native helper without command fallbacks",
	{ skip: process.platform !== "win32" || process.env.PI_TEST_NATIVE_CLIPBOARD !== "1" },
	async () => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard?.setText);
		for (const text of ["clipboard café 日本語", "", "second write"]) {
			await clipboard.setText(text);
			assert.equal(await clipboard.getText(), text);
			assert.equal(await clipboard.getImage(), null);
		}
	},
);

test(
	"uses the native platform helper directly as the clipboard API",
	{ skip: !["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) },
	() => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard);
		assert.equal(typeof clipboard.getText, "function");
		assert.equal(typeof clipboard.getImage, "function");
		assert.equal(typeof clipboard.setText, "function");
		assert.equal(clipboard, getNativePlatformHelper());
		assert.equal(clipboard, getNativeClipboard());
	},
);

test(
	"loads the vendored Darwin prebuild through the native platform lookup",
	{ skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) },
	() => {
		const helper = getNativePlatformHelper();
		assert.ok(helper);
		assert.equal(typeof helper.getText, "function");
		assert.equal(typeof helper.getImage, "function");
		assert.equal(typeof helper.getFilePaths, "function");
		assert.equal(typeof helper.setText, "function");
		// The upstream helper has no enableVirtualTerminalInput (Windows-only).
		assert.equal(typeof helper.isModifierPressed, "function");
		assert.equal(typeof helper.isModifierPressed?.("shift"), "boolean");
		const loaded = Object.keys(createRequire(import.meta.url).cache);
		assert.ok(
			loaded.some((path) =>
				path.endsWith(`/native/darwin/prebuilds/darwin-${process.arch}/darwin-platform.node`)),
			`the native lookup did not load the vendored prebuild; loaded native modules: ${loaded.filter((path) => path.endsWith(".node")).join(", ")}`,
		);
	},
);

// Opt in on a macOS test desktop: this replaces the system clipboard contents.
test(
	"reads and writes macOS clipboard text through the native helper",
	{ skip: process.platform !== "darwin" || process.env.PI_TEST_NATIVE_CLIPBOARD !== "1" },
	async () => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard?.setText);
		const original = await clipboard.getText();
		try {
			for (const text of ["clipboard café 日本語", "", "second write"]) {
				await clipboard.setText(text);
				assert.equal(await clipboard.getText(), text);
				assert.equal(await clipboard.getImage(), null);
				assert.equal(await clipboard.getFilePaths?.(), null);
			}
		} finally {
			// Best-effort restore: only a text payload can be preserved, so this
			// opt-in lane must not run while the clipboard holds an image or
			// multiple pasteboard items.
			await clipboard.setText(typeof original === "string" ? original : "");
		}
	},
);

test("Linux loads X11 lazily and rechecks DISPLAY", { skip: !["arm64", "x64"].includes(process.arch) || !existsSync(ARCH_PREBUILD) }, async (t) => {
	const require = createRequire(import.meta.url);
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const display = process.env.DISPLAY;
	const waylandDisplay = process.env.WAYLAND_DISPLAY;
	const modulePath = fileURLToPath(ARCH_PREBUILD);
	const previous = require.cache[modulePath];
	t.after(() => {
		Object.defineProperty(process, "platform", platform);
		if (display === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = display;
		if (waylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = waylandDisplay;
		if (previous) require.cache[modulePath] = previous;
		else delete require.cache[modulePath];
	});
	Object.defineProperty(process, "platform", { value: "linux" });
	delete process.env.DISPLAY;
	process.env.WAYLAND_DISPLAY = "wayland-0";
	assert.equal(getNativeClipboard(), undefined); // Wayland paste uses wl-paste.
	let available = false;
	const helper = {
		getText: t.mock.fn(async () => (available ? "X11" : undefined)),
		getImage: t.mock.fn(async () => null),
	};
	const module = new Module(modulePath);
	module.exports = helper;
	require.cache[modulePath] = module;
	process.env.DISPLAY = ":0";
	const clipboard = getNativeClipboard()!;
	assert.equal(clipboard, helper);
	assert.equal(helper.getText.mock.callCount(), 0);
	assert.equal(await clipboard.getText(), undefined);
	available = true;
	assert.equal(await clipboard.getText(), "X11");
	assert.equal(await clipboard.getImage(), null);
	delete process.env.DISPLAY;
	assert.equal(getNativeClipboard(), undefined);
	process.env.DISPLAY = ":1";
	assert.equal(getNativeClipboard(), clipboard);
});
