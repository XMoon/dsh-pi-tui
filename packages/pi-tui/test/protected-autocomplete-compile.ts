import { Editor } from "../src/components/editor.ts";
import type { SelectListLayoutOptions } from "../src/components/select-list.ts";

/** Compile-only contract fixture for host editor subclasses (X044). */
class HostEditor extends Editor {
	cancelFromHost(): void {
		this.cancelAutocomplete();
	}

	requestFromHost(): void {
		this.requestAutocomplete({ force: true, explicitTab: true });
	}

	layoutFromHost(prefix: string): SelectListLayoutOptions | undefined {
		return this.getAutocompleteSelectListLayout(prefix);
	}
}

export type ProtectedAutocompleteHostEditor = HostEditor;
