import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { LlamaModelInfo } from "../src/extensions/llama/client.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

async function serve(model: LlamaModelInfo, props: unknown) {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.setHeader("Content-Type", "application/json");
		if (request.url === "/models") response.end(JSON.stringify({ data: [model] }));
		else if (request.url === "/props?model=qwen&autoload=false") response.end(JSON.stringify(props));
		else response.writeHead(404).end();
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, requests };
}

// Regression for the context-discovery gap related to #10082.
describe("llama.cpp runtime context window", () => {
	it.each([
		{ description: "training context", meta: { n_ctx_train: 8192 }, args: undefined },
		{ description: "catalog runtime context", meta: { n_ctx: 8192 }, args: undefined },
		{
			description: "configured context before slot allocation",
			meta: { n_ctx_train: 8192 },
			args: ["--ctx-size", "131072"],
		},
	])("uses the served slot size instead of $description and restores it from cache", async ({ meta, args }) => {
		const model: LlamaModelInfo = { id: "qwen", status: { value: "loaded", args }, meta };
		const { url, requests } = await serve(model, {
			default_generation_settings: { n_ctx: 65536 },
			chat_template: "{% if enable_thinking %}think{% endif %}",
		});
		let stored: ModelsStoreEntry | undefined;
		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist !== undefined && publication.persist !== null)
				stored = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const credential = { type: "api_key" as const, key: "local", env: { LLAMA_BASE_URL: url } };
		const first = createLlamaProvider();
		await first.provider.refreshModels?.({
			credential,
			stored,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(first.provider.getModels()).toEqual([
			expect.objectContaining({ id: "qwen", contextWindow: 65536, maxTokens: 65536, reasoning: true }),
		]);
		expect(
			stored?.models.map((entry) => [
				entry.type ?? "chat",
				"contextWindow" in entry ? entry.contextWindow : undefined,
			]),
		).toEqual([
			["chat", 65536],
			["classifier", 65536],
		]);

		const restored = createLlamaProvider();
		const requestCount = requests.length;
		await restored.provider.refreshModels?.({
			credential,
			stored,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});
		expect(restored.provider.getModels()[0]?.contextWindow).toBe(65536);
		expect(requests).toHaveLength(requestCount);

		// Sleeping models keep the observed size without a props request that could wake them.
		model.status = { value: "sleeping" };
		model.meta = { n_ctx_train: 8192 };
		await restored.provider.refreshModels?.({
			credential,
			stored,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(stored?.models.map((entry) => ("contextWindow" in entry ? entry.contextWindow : undefined))).toEqual([
			65536, 65536,
		]);
		expect(requests.filter((request) => request.startsWith("/props"))).toHaveLength(1);
	});

	it.each([
		undefined,
		null,
		"invalid",
		{ n_ctx: 0 },
		{ n_ctx: -1 },
		{ n_ctx: 1.5 },
		{ n_ctx: "65536" },
		{ n_ctx: Number.MAX_SAFE_INTEGER + 1 },
	])("retains catalog fallback for invalid generation settings %j", async (generationSettings) => {
		const { url } = await serve(
			{ id: "qwen", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
			{
				default_generation_settings: generationSettings,
			},
		);
		const { provider } = createLlamaProvider();
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(provider.getModels()[0]?.contextWindow).toBe(32768);
	});
});
