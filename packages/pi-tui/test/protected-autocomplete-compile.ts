import { Editor } from "../src/components/editor.ts";

/** Compile-only contract fixture for host editor subclasses (X044). */
class HostEditor extends Editor {
	cancelFromHost(): void {
		this.cancelAutocomplete();
	}

	requestFromHost(): void {
		this.requestAutocomplete({ force: true, explicitTab: true });
	}
}

export type ProtectedAutocompleteHostEditor = HostEditor;
