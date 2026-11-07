import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
tui.start();
if (process.argv[3] === "working") {
	terminal.setProgramStatus({ state: "working", app: "dsh-pi-tui" });
}
if (process.argv[2] === "stop") tui.stop({ preserveScreen: true });
process.exit(0);
