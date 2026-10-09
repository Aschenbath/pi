import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	let testDir: string;
	let scriptPath: string;
	let binDir: string;

	beforeEach(() => {
		testDir = realpathSync(mkdtempSync(join(tmpdir(), "pi exec test-")));
		scriptPath = join(testDir, "command.mjs");
		writeFileSync(
			scriptPath,
			[
				"const args = process.argv.slice(2);",
				'if (args[0] === "--wait") { setInterval(() => {}, 1000); }',
				"else {",
				"  process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));",
				'  process.stderr.write("fixture stderr");',
				'  process.exitCode = args[0] === "--fail" ? 7 : 0;',
				"}",
			].join("\n"),
		);
		if (process.platform === "win32") {
			binDir = join(testDir, "node_modules", ".bin");
			mkdirSync(binDir, { recursive: true });
			const shim = `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %errorlevel%\r\n`;
			for (const extension of ["cmd", "bat"]) {
				writeFileSync(join(binDir, `pi-exec-fixture.${extension}`), shim);
			}
			vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
			vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("preserves native executable arguments, working directory, and output", async () => {
		const args = ["argument with spaces", "literal&value"];
		const result = await execCommand(process.execPath, [scriptPath, ...args], testDir);
		expect(JSON.parse(result.stdout)).toEqual({ args, cwd: testDir });
		expect(result).toMatchObject({ stderr: "fixture stderr", code: 0, killed: false });
	});

	it("preserves a native executable's nonzero exit code", async () => {
		const result = await execCommand(process.execPath, [scriptPath, "--fail"], testDir);
		expect(result).toMatchObject({ stderr: "fixture stderr", code: 7, killed: false });
	});

	it("returns failure for a missing command", async () => {
		const result = await execCommand("pi-command-that-does-not-exist-10616", [], testDir);
		expect(result.code).not.toBe(0);
		expect(result.killed).toBe(false);
	});

	it("keeps timeout cancellation for native executables", async () => {
		const result = await execCommand(process.execPath, [scriptPath, "--wait"], testDir, { timeout: 50 });
		expect(result.killed).toBe(true);
	});

	it("keeps abort cancellation for native executables", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await execCommand(process.execPath, [scriptPath, "--wait"], testDir, {
			signal: controller.signal,
		});
		expect(result.killed).toBe(true);
	});

	// #10616: npm-style launchers need Windows command resolution and escaping.
	describe.skipIf(process.platform !== "win32")("Windows command shims", () => {
		it("resolves a bare command through PATH and PATHEXT", async () => {
			const args = ["--version"];
			const result = await execCommand("pi-exec-fixture", args, testDir);
			expect(JSON.parse(result.stdout)).toEqual({ args, cwd: testDir });
			expect(result).toMatchObject({ stderr: "fixture stderr", code: 0, killed: false });
		});

		it("preserves quoted and literal arguments through a cmd shim", async () => {
			const args = ["argument with spaces", "literal&value", "(parentheses)", 'quote"value', ""];
			const result = await execCommand(join(binDir, "pi-exec-fixture.cmd"), args, testDir);
			expect(JSON.parse(result.stdout)).toEqual({ args, cwd: testDir });
			expect(result).toMatchObject({ stderr: "fixture stderr", code: 0, killed: false });
		});

		it.each(["cmd", "bat"])("preserves stdout, stderr, and nonzero exit codes for .%s", async (extension) => {
			const args = ["--fail"];
			const result = await execCommand(join(binDir, `pi-exec-fixture.${extension}`), args, testDir);
			expect(JSON.parse(result.stdout)).toEqual({ args, cwd: testDir });
			expect(result).toMatchObject({ stderr: "fixture stderr", code: 7, killed: false });
		});
	});
});
