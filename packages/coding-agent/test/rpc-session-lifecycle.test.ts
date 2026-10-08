import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({ records: [] as Record<string, unknown>[] }));
vi.mock("../src/core/output-guard.ts", () => ({
	takeOverStdout: () => {},
	writeRawStdout: (line: string) => rpcIo.records.push(JSON.parse(line)),
	waitForRawStdoutBackpressure: async () => {},
	flushRawStdout: async () => {},
}));

// #10470: exercise the real JSONL parser, RPC dispatcher, runtime replacement, and extension hooks.
describe("RPC session replacement lifecycle", () => {
	let harness: Harness | undefined;
	let runtime: AgentSessionRuntime | undefined;
	let input: PassThrough | undefined;
	const signals = ["SIGTERM", "SIGHUP"] as const;
	let signalListeners = signals.map((signal) => process.listeners(signal));

	afterEach(async () => {
		await runtime?.dispose();
		runtime = undefined;
		input?.removeAllListeners();
		input?.destroy();
		input = undefined;
		for (const [index, signal] of signals.entries()) {
			for (const listener of process.listeners(signal)) {
				if (!signalListeners[index].includes(listener)) process.off(signal, listener);
			}
		}
		vi.restoreAllMocks();
		harness?.cleanup();
		harness = undefined;
		rpcIo.records = [];
	});

	async function startRpc() {
		signalListeners = signals.map((signal) => process.listeners(signal));
		harness = await createHarness();
		const fixture = harness;
		fixture.setResponses([fauxAssistantMessage("seed answer"), fauxAssistantMessage("after replacement")]);
		const lifecycle: string[] = [];
		let cancel = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime: fixture.session.modelRuntime,
				settingsManager: fixture.settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(pi) => {
							pi.on("session_start", (event, ctx) => {
								lifecycle.push(`start:${event.reason}`);
								pi.appendEntry("rpc-start", { reason: event.reason });
								ctx.ui.notify(`started:${event.reason}`);
							});
							pi.on("session_shutdown", (event) => {
								lifecycle.push(`shutdown:${event.reason}`);
							});
							pi.on("resources_discover", () => {
								lifecycle.push("discover");
							});
							pi.on("session_before_switch", () => ({ cancel }));
							pi.on("session_before_fork", () => ({ cancel }));
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: fixture.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: fixture.tempDir,
			agentDir: fixture.tempDir,
			sessionManager: SessionManager.create(fixture.tempDir, join(fixture.tempDir, "sessions")),
		});
		input = new PassThrough();
		// RPC only uses the readable-stream interface, not stdin's TTY-specific methods.
		vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
		void runRpcMode(runtime);
		await vi.waitFor(() => expect(input?.listenerCount("data")).toBe(1));
		expect(lifecycle.filter((event) => event.startsWith("start:"))).toEqual(["start:startup"]);
		await runtime.session.prompt("seed");
		return {
			lifecycle,
			cancel: () => {
				cancel = true;
			},
		};
	}

	async function command(command: RpcCommand) {
		const id = `request-${rpcIo.records.length}`;
		input!.write(`${JSON.stringify({ ...command, id })}\n`);
		await vi.waitFor(() =>
			expect(rpcIo.records.some((record) => record.type === "response" && record.id === id)).toBe(true),
		);
		return rpcIo.records.find((record) => record.type === "response" && record.id === id)!;
	}

	for (const type of ["new_session", "switch_session", "fork", "clone"] as const) {
		for (const cancelled of [false, true]) {
			it(`${type} ${cancelled ? "cancellation preserves the current binding" : "starts the replacement exactly once"}`, async () => {
				const fixture = await startRpc();
				const previous = runtime!.session;
				const entryId = previous.sessionManager
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
				const request: RpcCommand =
					type === "switch_session"
						? { type, sessionPath: previous.sessionFile! }
						: type === "fork"
							? { type, entryId }
							: { type };
				if (cancelled) fixture.cancel();
				fixture.lifecycle.length = 0;
				rpcIo.records = [];
				const response = await command(request);
				expect(response).toMatchObject({ success: true, command: type, data: { cancelled } });
				if (cancelled) {
					expect(runtime!.session).toBe(previous);
					expect(fixture.lifecycle).toEqual([]);
				} else {
					const reason = type === "new_session" ? "new" : type === "switch_session" ? "resume" : "fork";
					expect(runtime!.session).not.toBe(previous);
					expect(fixture.lifecycle.filter((event) => event !== "discover")).toEqual([
						`shutdown:${reason}`,
						`start:${reason}`,
					]);
					expect(fixture.lifecycle.filter((event) => event === "discover")).toHaveLength(1);
					expect(rpcIo.records.filter((record) => record.method === "notify")).toHaveLength(1);
					if (type === "new_session") {
						expect(
							runtime!.session.sessionManager
								.getEntries()
								.filter((entry) => entry.type === "custom" && entry.customType === "rpc-start"),
						).toHaveLength(1);
					}
				}
				expect(await command({ type: "get_state" })).toMatchObject({
					success: true,
					data: { sessionId: runtime!.session.sessionId },
				});
				rpcIo.records = [];
				expect(await command({ type: "prompt", message: "next" })).toMatchObject({ success: true });
				await runtime!.session.waitForIdle();
				expect(rpcIo.records.filter((record) => record.type === "agent_start")).toHaveLength(1);
				expect(rpcIo.records.filter((record) => record.type === "agent_settled")).toHaveLength(1);
			});
		}
	}
});
