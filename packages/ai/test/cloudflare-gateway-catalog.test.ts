import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
} from "../src/api/cloudflare.ts";
import { streamSimple } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let temporaryRoot: string | undefined;
let models: Record<string, Model<Api>>;

beforeAll(() => {
	temporaryRoot = mkdtempSync(join(tmpdir(), "pi-cloudflare-catalog-"));
	const preloadPath = join(temporaryRoot, "catalog.mjs");
	const outputPath = join(temporaryRoot, "output");
	const metadata = {
		name: "Gateway fixture",
		tool_call: true,
		reasoning: false,
		modalities: { input: ["text"], output: ["text"] },
		limit: { context: 32768, output: 4096 },
		cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 },
	};
	const catalog = {
		"cloudflare-ai-gateway": {
			models: {
				"openai/gpt-4o": metadata,
				"anthropic/claude-sonnet-4.5": metadata,
				"workers-ai/@cf/test/model": { ...metadata, name: "Gateway worker" },
				"deepseek/deepseek-v4-pro": {
					...metadata,
					name: "DeepSeek fixture",
					reasoning: true,
					modalities: { input: ["text", "image"], output: ["text"] },
				},
				"xai/grok-4.5": metadata,
				"grok/grok-fixture": metadata,
				"deepseek/no-tools": { ...metadata, tool_call: false },
				"xai/no-tool-capability": { ...metadata, tool_call: undefined },
				"alibaba/qwen-fixture": metadata,
				"moonshotai/kimi-fixture": metadata,
				"unknown/model": metadata,
				"missing-prefix": metadata,
			},
		},
		"cloudflare-workers-ai": {
			models: {
				"@cf/test/model": { ...metadata, name: "Direct worker" },
				"@cf/test/fallback": metadata,
			},
		},
	};
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  if (String(input) === "https://models.dev/api.json") return Response.json(catalog);\n` +
			`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
			`};\n`,
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	models = JSON.parse(readFileSync(join(outputPath, "providers/cloudflare-ai-gateway.json"), "utf8"));
});

afterAll(() => {
	if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

// Regression for #10539: generation discarded supported upstreams before they reached the model selector.
describe("Cloudflare AI Gateway catalog generation", () => {
	it.each(["deepseek/deepseek-v4-pro", "grok/grok-4.5", "grok/grok-fixture"])(
		"includes %s through the documented compatible endpoint",
		(id) => {
			expect(models[id]).toMatchObject({
				id,
				provider: "cloudflare-ai-gateway",
				api: "openai-completions",
				baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			});
		},
	);

	it("normalizes the models.dev xai prefix to the gateway's grok prefix", () => {
		expect(models["grok/grok-4.5"]).toBeDefined();
		expect(models["xai/grok-4.5"]).toBeUndefined();
	});

	it.each(["deepseek/deepseek-v4-pro", "grok/grok-4.5"])(
		"dispatches generated %s metadata with the gateway URL, model ID, and authentication",
		async (id) => {
			const chunk = {
				id: "chatcmpl-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: id,
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			};
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
				new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);
			vi.stubEnv("CLOUDFLARE_API_KEY", "fixture-gateway-token");
			vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "fixture-account");
			vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "fixture-gateway");

			const result = await streamSimple(models[id], {
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			}).result();

			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toBe(
				"https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/compat/chat/completions",
			);
			expect(JSON.parse(init?.body as string).model).toBe(id);
			const headers = new Headers(init?.headers);
			expect(headers.get("cf-aig-authorization")).toBe("Bearer fixture-gateway-token");
			expect(headers.get("authorization")).toBeNull();
		},
	);

	it("preserves upstream model limits, pricing, and image capability", () => {
		expect(models["deepseek/deepseek-v4-pro"]).toMatchObject({
			name: "DeepSeek fixture",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 32768,
			maxTokens: 4096,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
			compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
		});
	});

	it("preserves native OpenAI and Anthropic routes and IDs", () => {
		expect(models["gpt-4o"]).toMatchObject({
			api: "openai-responses",
			baseUrl: CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
		});
		expect(models["claude-sonnet-4-5"]).toMatchObject({
			api: "anthropic-messages",
			baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
		});
	});

	it("keeps explicit Workers AI metadata and mirrors missing Workers AI models", () => {
		expect(models["workers-ai/@cf/test/model"]).toMatchObject({
			name: "Gateway worker",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			compat: { sendSessionAffinityHeaders: true },
		});
		expect(models["workers-ai/@cf/test/fallback"]).toMatchObject({
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			compat: { sendSessionAffinityHeaders: true },
		});
	});

	it("excludes entries without tool support or a documented gateway route", () => {
		expect(Object.keys(models).sort()).toEqual(
			[
				"gpt-4o",
				"claude-sonnet-4-5",
				"workers-ai/@cf/test/model",
				"workers-ai/@cf/test/fallback",
				"deepseek/deepseek-v4-pro",
				"grok/grok-4.5",
				"grok/grok-fixture",
			].sort(),
		);
	});
});
