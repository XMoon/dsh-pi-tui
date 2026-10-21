import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
// Upstream references its own published name; this package is renamed for
// the XMoon vendor shell, so the self-reference must follow the rename or
// the installed-package candidate can never resolve. (dsh-pi-tui
// divergence X025 packaging shell.)
const TUI_PACKAGE_NAME = "@xmoon76/pi-tui";

export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
	resolvePackage?: (specifier: string) => string;
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
	const candidates: string[] = [];

	try {
		const packageEntry = (options.resolvePackage ?? moduleRequire.resolve)(TUI_PACKAGE_NAME);
		candidates.push(join(dirname(packageEntry), "..", nativePath));
	} catch {
		// Standalone binaries do not have an installed TUI package.
	}

	candidates.push(
		join(moduleDir, "..", nativePath),
		join(moduleDir, nativePath),
		join(dirname(options.execPath ?? process.execPath), nativePath),
	);
	return Array.from(new Set(candidates));
}
