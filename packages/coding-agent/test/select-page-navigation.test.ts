import { CombinedAutocompleteProvider, setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { SelectSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const ids = Array.from({ length: 25 }, (_, index) => `option${String(index).padStart(2, "0")}`);

// Regression coverage for #7629: custom selectors and wrappers must handle the configured page keys too.
describe("interactive selector page navigation", () => {
	let harness: Harness | undefined;
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		setKeybindings(new KeybindingsManager());
	});

	it("gives autocomplete paging precedence over clipboard paste only while the picker is open", async () => {
		const keybindings = new KeybindingsManager({
			"tui.select.pageDown": "ctrl+v",
			"tui.select.pageUp": "alt+v",
			"app.clipboard.pasteImage": ["ctrl+v", "alt+v"],
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		const paste = vi.fn();
		editor.onPasteImage = paste;
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				ids.map((name) => ({ name })),
				process.cwd(),
			),
		);
		editor.handleInput("/");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput("\x16");
		editor.handleInput("\x16");
		editor.handleInput("\x1bv");
		expect(paste).not.toHaveBeenCalled();
		editor.handleInput("\t");
		expect(editor.getText()).toBe("/option05 ");
		editor.handleInput("\x16");
		expect(paste).toHaveBeenCalledTimes(1);
	});

	for (const remapped of [false, true]) {
		const pageDown = remapped ? "\x16" : "\x1b[6~";
		const pageUp = remapped ? "\x1bv" : "\x1b[5~";
		const configure = () =>
			setKeybindings(
				new KeybindingsManager(
					remapped
						? {
								"tui.select.pageDown": "ctrl+v",
								"tui.select.pageUp": "alt+v",
							}
						: {},
				),
			);

		it(`pages the model picker by ten while keeping its query (remapped=${remapped})`, async () => {
			configure();
			harness = await createHarness({ models: ids.map((id) => ({ id })) });
			const selected = vi.fn();
			const selector = new ModelSelectorComponent(
				{ requestRender: () => {} } as unknown as TUI,
				harness.getModel(ids[0]),
				harness.session.modelRuntime,
				[],
				selected,
				() => {},
				"option",
			);
			try {
				await vi.waitFor(() =>
					expect(stripAnsi(selector.render(120).join("\n"))).toContain("Model catalogs refreshed."),
				);
				for (const [key, index] of [
					[pageDown, 10],
					[pageDown, 20],
					[pageDown, 24],
					[pageDown, 24],
					[pageUp, 14],
					[pageUp, 4],
					[pageUp, 0],
					[pageUp, 0],
				] as const) {
					selector.handleInput(key);
					expect(stripAnsi(selector.render(120).join("\n"))).toMatch(new RegExp(`→ .*${ids[index]} \\[faux\\]`));
				}
				expect(selector.getSearchInput().getValue()).toBe("option");
				selector.handleInput("\r");
				expect(selected).toHaveBeenCalledWith(harness.getModel(ids[0]));
			} finally {
				selector.dispose();
			}
		});

		it(`pages model configuration without changing enabled models (remapped=${remapped})`, async () => {
			configure();
			harness = await createHarness({ models: ids.map((id) => ({ id })) });
			const changed = vi.fn();
			const selector = new ScopedModelsSelectorComponent(
				{ allModels: ids.map((id) => harness!.getModel(id)!), enabledModelIds: null },
				{ onChange: changed, onPersist: () => {}, onCancel: () => {} },
			);
			for (const char of "option") selector.handleInput(char);
			selector.handleInput(pageDown);
			selector.handleInput(pageDown);
			selector.handleInput(pageUp);
			expect(changed).not.toHaveBeenCalled();
			expect(selector.getSearchInput().getValue()).toBe("option");
			selector.handleInput("\r");
			expect(changed).toHaveBeenCalledWith(ids.filter((_, index) => index !== 8).map((id) => `faux/${id}`));
		});

		it(`pages login providers by eight, including filtered and empty results (remapped=${remapped})`, () => {
			configure();
			const selected = vi.fn();
			const providers = ids.map((id) => ({ id, name: id, authType: "api_key" as const }));
			const selector = new OAuthSelectorComponent("login", providers, selected, () => {}, "option");
			selector.handleInput(pageDown);
			selector.handleInput(pageDown);
			selector.handleInput(pageUp);
			selector.handleInput("\r");
			expect(selected).toHaveBeenLastCalledWith(ids[8], "api_key");
			selector.handleInput("zzz");
			selector.handleInput(pageDown);
			selector.handleInput(pageUp);
			selector.handleInput("\r");
			expect(selected).toHaveBeenCalledTimes(1);
		});

		it(`forwards pages through searchable settings and thinking selectors (remapped=${remapped})`, () => {
			configure();
			const selected = vi.fn();
			const preview = vi.fn();
			const submenu = new SelectSubmenu(
				"Options",
				"",
				ids.map((value) => ({ value, label: value })),
				ids[0],
				selected,
				() => {},
				preview,
				{ searchable: true },
			);
			for (const char of "option") submenu.handleInput(char);
			submenu.handleInput(pageDown);
			expect(preview).toHaveBeenLastCalledWith(ids[10]);
			submenu.handleInput(pageDown);
			submenu.handleInput(pageUp);
			submenu.handleInput("\r");
			expect(selected).toHaveBeenCalledWith(ids[10]);
			const thinking = new ThinkingSelectorComponent("off", ["off", "low", "medium", "high"], selected, () => {});
			thinking.handleInput(pageDown);
			expect(thinking.getSelectList().getSelectedItem()?.value).toBe("high");
			thinking.handleInput(pageUp);
			expect(thinking.getSelectList().getSelectedItem()?.value).toBe("off");
		});

		it(`pages fork history by ten and clamps at its ends (remapped=${remapped})`, () => {
			configure();
			const selected = vi.fn();
			const selector = new UserMessageSelectorComponent(
				ids.map((id) => ({ id, text: id })),
				selected,
				() => {},
			);
			const list = selector.getMessageList();
			for (const [key, index] of [
				[pageUp, 14],
				[pageUp, 4],
				[pageUp, 0],
				[pageUp, 0],
				[pageDown, 10],
				[pageDown, 20],
				[pageDown, 24],
			] as const) {
				list.handleInput(key);
				list.handleInput("\r");
				expect(selected).toHaveBeenLastCalledWith(ids[index]);
			}
		});
	}
});
