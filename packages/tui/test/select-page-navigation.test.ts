import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme, defaultSelectListTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const items = Array.from({ length: 13 }, (_, index) => ({ value: `option${index}`, label: `option${index}` }));
const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

// Regression coverage for #7629, including the editor's routing of shared page keys.
describe("select page navigation", () => {
	afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

	for (const remapped of [false, true]) {
		const pageDown = remapped ? "\x16" : "\x1b[6~";
		const pageUp = remapped ? "\x1bv" : "\x1b[5~";
		const configure = () =>
			setKeybindings(
				new KeybindingsManager(
					TUI_KEYBINDINGS,
					remapped
						? {
								"tui.select.pageDown": "ctrl+v",
								"tui.select.pageUp": "alt+v",
								"tui.editor.pageDown": "ctrl+v",
								"tui.editor.pageUp": "alt+v",
							}
						: {},
				),
			);

		it(`pages SelectList and clamps without duplicate notifications (remapped=${remapped})`, () => {
			configure();
			const list = new SelectList(items, 5, defaultSelectListTheme);
			const changes: string[] = [];
			list.onSelectionChange = (item) => changes.push(item.value);
			for (const [key, expected] of [
				[pageDown, 5],
				[pageDown, 10],
				[pageDown, 12],
				[pageDown, 12],
				[pageUp, 7],
				[pageUp, 2],
				[pageUp, 0],
				[pageUp, 0],
			] as const) {
				list.handleInput(key);
				assert.equal(list.getSelectedItem()?.value, `option${expected}`);
			}
			assert.deepEqual(
				changes,
				[5, 10, 12, 7, 2, 0].map((index) => `option${index}`),
			);
			list.handleInput("\x1b[A");
			assert.equal(list.getSelectedItem()?.value, "option12");
		});

		it(`pages filtered settings without editing the query or value (remapped=${remapped})`, () => {
			configure();
			const settings = [...items, { value: "unrelated", label: "unrelated" }].map((item) => ({
				id: item.value,
				label: item.label,
				currentValue: "off",
				values: ["off", "on"],
			}));
			const changes: string[] = [];
			const list = new SettingsList(
				settings,
				5,
				settingsTheme,
				(id) => changes.push(id),
				() => {},
				{ enableSearch: true },
			);
			for (const char of "option") list.handleInput(char);
			const query = list.render(80)[0];
			list.handleInput(pageDown);
			list.handleInput(pageDown);
			list.handleInput(pageDown);
			list.handleInput(pageUp);
			assert.deepEqual(changes, []);
			assert.equal(list.render(80)[0], query);
			list.handleInput("\r");
			assert.deepEqual(changes, ["option7"]);
		});

		it(`pages autocomplete without moving the draft cursor (remapped=${remapped})`, async () => {
			configure();
			const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme, {
				autocompleteMaxVisible: 5,
			});
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					items.map((item) => ({ name: item.value })),
					process.cwd(),
				),
			);
			editor.handleInput("/");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(editor.isShowingAutocomplete(), true);
			const cursor = editor.getCursor();
			editor.handleInput(pageDown);
			editor.handleInput(pageDown);
			editor.handleInput(pageUp);
			assert.equal(editor.getText(), "/");
			assert.deepEqual(editor.getCursor(), cursor);
			editor.handleInput("\t");
			assert.equal(editor.getText(), "/option5 ");
		});
	}

	it("pages only matching items and tolerates empty lists", () => {
		const list = new SelectList(items, 5, defaultSelectListTheme);
		list.setFilter("option1");
		list.handleInput("\x1b[6~");
		assert.equal(list.getSelectedItem()?.value, "option12");
		list.handleInput("\x1b[5~");
		assert.equal(list.getSelectedItem()?.value, "option1");
		list.setFilter("missing");
		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[5~");
		assert.equal(list.getSelectedItem(), null);
		const empty = new SettingsList(
			[],
			5,
			settingsTheme,
			() => assert.fail("changed empty list"),
			() => {},
		);
		empty.handleInput("\x1b[6~");
		empty.handleInput("\x1b[5~");
		assert.match(empty.render(80).join("\n"), /No settings available/);
	});
});
