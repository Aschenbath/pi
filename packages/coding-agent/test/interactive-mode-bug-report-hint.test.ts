import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { SettingsManager, type WarningSettings } from "../src/core/settings-manager.ts";
import { formatCrashExtensionHint, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type BugReportHintContext = {
	settingsManager: SettingsManager;
	suggestBugReport(): void;
	maybeShowInstallChangeWarning(): boolean;
};

const maybeSuggestBugReport = Reflect.get(InteractiveMode.prototype, "maybeSuggestBugReport") as (
	this: BugReportHintContext,
	message: AssistantMessage,
) => void;

function errorMessage(errorMessage: string): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

function createContext(warnings: WarningSettings = {}) {
	return {
		settingsManager: SettingsManager.inMemory({ warnings }),
		suggestBugReport: vi.fn(),
		maybeShowInstallChangeWarning: vi.fn(() => false),
	};
}

describe("InteractiveMode bug report hints", () => {
	test("identifies extensions with frames in a crash stack", () => {
		expect(formatCrashExtensionHint(["npm:pi-observational-memory"])).toBe(
			"A stack frame came from loaded extension `npm:pi-observational-memory`, which may be involved. Try disabling it with `pi config`, or run `pi -ne` to confirm.",
		);
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});

	test("does not suggest reports for retryable provider failures", () => {
		const context = createContext();
		const failures = [
			"500 Internal Server Error",
			"502 Bad Gateway",
			"503 Service Unavailable",
			"504 Gateway Timeout",
			"429 Too Many Requests",
			"Provider overloaded",
			"Network connection lost",
			"Request timed out",
		];

		for (const failure of failures) maybeSuggestBugReport.call(context, errorMessage(failure));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test("does not suggest reports for cancellations", () => {
		const context = createContext();

		maybeSuggestBugReport.call(context, errorMessage("This operation was aborted"));
		maybeSuggestBugReport.call(context, errorMessage("Request cancelled"));
		maybeSuggestBugReport.call(context, fauxAssistantMessage("", { stopReason: "aborted" }));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test.each([undefined, true])("suggests reports for unexpected errors with bugReport=%s", (bugReport) => {
		const context = createContext({ bugReport });

		maybeSuggestBugReport.call(context, errorMessage("Unexpected internal state"));

		expect(context.suggestBugReport).toHaveBeenCalledOnce();
	});

	// Regression: https://github.com/earendil-works/pi/issues/10354
	test("suppresses bug report hints when disabled", () => {
		const context = createContext({ bugReport: false });

		maybeSuggestBugReport.call(context, errorMessage("Login expired; run the extension's login command"));

		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});

	test("can enable hints after an error while they were disabled", async () => {
		const context = createContext({ bugReport: false });
		maybeSuggestBugReport.call(context, errorMessage("Login expired"));
		expect(context.suggestBugReport).not.toHaveBeenCalled();

		context.settingsManager.setWarnings({ bugReport: true });
		await context.settingsManager.flush();
		maybeSuggestBugReport.call(context, errorMessage("Unexpected internal state"));

		expect(context.suggestBugReport).toHaveBeenCalledOnce();
	});

	test.each([true, false])("keeps install change warnings with bugReport=%s", (bugReport) => {
		const context = createContext({ bugReport });
		context.maybeShowInstallChangeWarning.mockReturnValue(true);

		maybeSuggestBugReport.call(context, errorMessage("Cannot find module './worker.js'"));

		expect(context.maybeShowInstallChangeWarning).toHaveBeenCalledOnce();
		expect(context.suggestBugReport).not.toHaveBeenCalled();
	});
});
