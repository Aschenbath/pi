import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext, type TranscriptContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test",
	provider: "test-anthropic",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsStrictTools: true },
};
const grammarError =
	"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";
function tool(strict?: "prefer" | "require", name = "lookup"): Tool {
	return {
		name,
		description: "Lookup",
		parameters: Type.Object({ required: Type.String(), optional: Type.Optional(Type.String()) }),
		...(strict ? { constrainedSampling: { type: "json_schema" as const, strict } } : {}),
	};
}
function successResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function run(
	tools: Tool[],
	options: {
		status?: number;
		message?: string;
		failEveryTime?: boolean;
		requestOptions?: Partial<AnthropicOptions>;
		context?: TranscriptContext;
		nativeTools?: boolean;
		abort?: AbortController;
	} = {},
) {
	const requests: MessageCreateParamsStreaming[] = [];
	const context =
		options.context ?? normalizeContext({ messages: [{ role: "user", content: "go", timestamp: 0 }], tools });
	const selectedModel = options.nativeTools
		? {
				...model,
				compat: { ...model.compat, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
			}
		: model;
	const result = await stream(selectedModel, context, {
		apiKey: "test-key",
		maxRetries: 0,
		signal: options.abort?.signal,
		...options.requestOptions,
		fetch: async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as MessageCreateParamsStreaming);
			if (requests.length === 1 || options.failEveryTime) {
				options.abort?.abort();
				return Response.json(
					{ type: "error", error: { type: "invalid_request_error", message: options.message ?? grammarError } },
					{ status: options.status ?? 400 },
				);
			}
			return successResponse();
		},
	}).result();
	return { result, requests, context };
}

// #10409: prefer is a request-level fallback; require must never be weakened.
describe("Anthropic strict grammar fallback", () => {
	it("retries prefer tools once with their ordinary schemas and reapplies payload hooks", async () => {
		const preferred = tool("prefer");
		const original = structuredClone(preferred);
		const onPayload = vi.fn((payload: unknown) => ({
			...(payload as MessageCreateParamsStreaming),
			metadata: { user_id: "hook-user" },
		}));
		const { result, requests } = await run([preferred], { requestOptions: { onPayload } });
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[0].tools?.[0]).toMatchObject({
			strict: true,
			input_schema: { required: ["required", "optional"] },
		});
		expect(requests[1].tools?.[0]).not.toHaveProperty("strict");
		expect(requests[1].tools?.[0]).toMatchObject({
			input_schema: {
				properties: { required: { type: "string" }, optional: { type: "string" } },
				required: ["required"],
			},
		});
		expect(requests[1].metadata).toEqual({ user_id: "hook-user" });
		expect(onPayload).toHaveBeenCalledTimes(2);
		expect(preferred).toEqual(original);
	});

	it.each(["required", "mixed", "ordinary", "unsupported"])("does not downgrade %s tools", async (kind) => {
		const preferred = tool("prefer");
		const tools =
			kind === "required"
				? [tool("require")]
				: kind === "mixed"
					? [preferred, tool("require", "required_tool")]
					: kind === "unsupported"
						? [{ ...preferred, parameters: Type.Object({ count: Type.Integer({ minimum: 1 }) }) }]
						: [tool()];
		const { result, requests } = await run(tools);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("compiled grammar is too large");
		expect(requests).toHaveLength(1);
	});

	it.each([
		[400, "invalid tool schema"],
		[401, grammarError],
		[500, grammarError],
	])("does not fallback for unrelated status %i / error", async (status, message) => {
		const { result, requests } = await run([tool("prefer")], {
			status: status as number,
			message: message as string,
		});
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("surfaces a second grammar rejection without looping", async () => {
		const { result, requests } = await run([tool("prefer")], { failEveryTime: true });
		expect(requests).toHaveLength(2);
		expect(result.stopReason).toBe("error");
	});

	it("does not retry after cancellation", async () => {
		const { result, requests } = await run([tool("prefer")], { abort: new AbortController() });
		expect(result.stopReason).toBe("aborted");
		expect(requests).toHaveLength(1);
	});

	it("does not replay a stream that has already started", async () => {
		const events = [
			{
				type: "message_start",
				message: { id: "msg_started", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
			{ type: "error", error: { type: "invalid_request_error", message: grammarError } },
		];
		const fetch = vi.fn(
			async () =>
				new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "go", timestamp: 0 }], tools: [tool("prefer")] }),
			{ apiKey: "test-key", fetch },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toMatchObject([{ type: "text", text: "partial" }]);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("uses the ordinary transport retry budget after the one schema fallback", async () => {
		const requests: MessageCreateParamsStreaming[] = [];
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "go", timestamp: 0 }], tools: [tool("prefer")] }),
			{
				apiKey: "test-key",
				maxRetries: 1,
				fetch: async (_input, init) => {
					requests.push(JSON.parse(String(init?.body)) as MessageCreateParamsStreaming);
					if (requests.length === 1)
						return Response.json(
							{ error: { type: "invalid_request_error", message: grammarError } },
							{ status: 400 },
						);
					if (requests.length === 2)
						return Response.json(
							{ error: { type: "overloaded_error", message: "overloaded" } },
							{ status: 503, headers: { "retry-after-ms": "0" } },
						);
					return successResponse();
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(3);
		expect(requests[0].tools?.[0]).toHaveProperty("strict", true);
		expect(requests[1].tools?.[0]).not.toHaveProperty("strict");
		expect(requests[2].tools?.[0]).not.toHaveProperty("strict");
	});

	it("preserves OAuth tool name mapping on fallback", async () => {
		const { result, requests } = await run([tool("prefer", "read")], {
			requestOptions: { apiKey: "sk-ant-oat-test" },
		});
		expect(result.stopReason).toBe("stop");
		expect(requests[0].tools?.[0]).toMatchObject({ name: "Read", strict: true });
		expect(requests[1].tools?.[0]).toMatchObject({ name: "Read" });
		expect(requests[1].tools?.[0]).not.toHaveProperty("strict");
	});

	it("rebuilds native mid-conversation tool additions without strict sampling", async () => {
		const context = normalizeContext({
			messages: [
				{ role: "system", content: "", toolsAdded: [tool(undefined, "initial")], timestamp: 0 },
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "system", content: "", toolsAdded: [tool("prefer")], timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			],
		});
		const { result, requests } = await run([], { context, nativeTools: true });
		expect(result.stopReason).toBe("stop");
		const definitions = (request: MessageCreateParamsStreaming) =>
			request.messages.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.flatMap((block) =>
							block.type === "tool_addition" && block.tool.type === "tool_definition"
								? [block.tool.definition]
								: [],
						)
					: [],
			);
		expect(definitions(requests[0])[0]).toMatchObject({ name: "lookup", strict: true });
		expect(definitions(requests[1])[0]).not.toHaveProperty("strict");
	});
});
