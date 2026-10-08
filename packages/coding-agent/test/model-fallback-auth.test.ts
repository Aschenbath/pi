import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function runtime(models: Model<Api>[], authenticated: string[]): ModelRuntime {
	return {
		getModels: () => models,
		hasConfiguredAuth: (provider: string) => authenticated.includes(provider),
	} as unknown as ModelRuntime;
}

// Regression coverage for #10160: a known prefix does not make a raw model ID provider-qualified.
describe("CLI raw model ID fallback after unsuccessful provider inference", () => {
	const direct = model("anthropic", "unrelated-model");
	for (const reverse of [false, true]) {
		for (const suffix of ["", ":high", ":exacto"]) {
			const id = `anthropic/unique-model${suffix === ":exacto" ? suffix : ""}`;
			const gateways = [model("openrouter", id), model("vercel-ai-gateway", id)];
			const models = [direct, ...(reverse ? [...gateways].reverse() : gateways)];
			const cliModel = `anthropic/unique-model${suffix}`;
			it(`selects the sole authenticated gateway (${suffix || "bare"}, reverse=${reverse})`, () => {
				const result = resolveCliModel({ cliModel, modelRuntime: runtime(models, ["vercel-ai-gateway"]) });
				expect(result.model).toBe(gateways[1]);
				expect(result.error).toBeUndefined();
				expect(result.warning).toBeUndefined();
				expect(result.thinkingLevel).toBe(suffix === ":high" ? "high" : undefined);
			});

			for (const authenticated of [[], ["openrouter", "vercel-ai-gateway"]]) {
				it(`reports ambiguity with ${authenticated.length} authenticated gateways (${suffix || "bare"}, reverse=${reverse})`, () => {
					const result = resolveCliModel({ cliModel, modelRuntime: runtime(models, authenticated) });
					expect(result.model).toBeUndefined();
					expect(result.error).toContain("ambiguous across providers");
					expect(result.error).toContain(`openrouter/${id}`);
					expect(result.error).toContain(`vercel-ai-gateway/${id}`);
					expect(result.error).toContain(
						authenticated.length === 0
							? "No matching provider is authenticated"
							: "More than one matching provider is authenticated",
					);
				});
			}
		}
	}

	it("retains a unique unauthenticated raw ID for first-time --api-key setup", () => {
		const gateway = model("vercel-ai-gateway", "anthropic/unique-model");
		expect(resolveCliModel({ cliModel: gateway.id, modelRuntime: runtime([direct, gateway], []) }).model).toBe(
			gateway,
		);
	});

	it("honors an explicit provider even when a different gateway is authenticated", () => {
		const gateway = model("openrouter", "anthropic/unique-model");
		const other = model("vercel-ai-gateway", gateway.id);
		const modelRuntime = runtime([direct, gateway, other], [other.provider]);
		expect(resolveCliModel({ cliProvider: gateway.provider, cliModel: gateway.id, modelRuntime }).model).toBe(
			gateway,
		);
		expect(resolveCliModel({ cliModel: `${gateway.provider}/${gateway.id}`, modelRuntime }).model).toBe(gateway);
	});

	it("keeps an authenticated inferred provider preferred over raw gateway IDs", () => {
		const native = model("anthropic", "unique-model");
		const gateway = model("openrouter", "anthropic/unique-model");
		expect(
			resolveCliModel({
				cliModel: gateway.id,
				modelRuntime: runtime([native, gateway], [native.provider, gateway.provider]),
			}).model,
		).toBe(native);
	});

	it("matches fallback IDs case-insensitively", () => {
		const gateway = model("vercel-ai-gateway", "anthropic/unique-model");
		const other = model("openrouter", gateway.id);
		expect(
			resolveCliModel({
				cliModel: "ANTHROPIC/UNIQUE-MODEL",
				modelRuntime: runtime([direct, other, gateway], [gateway.provider]),
			}).model,
		).toBe(gateway);
	});

	it("prefers a literal ID ending in a valid thinking-level name", () => {
		const base = model("openrouter", "anthropic/unique-model");
		const literal = model("vercel-ai-gateway", `${base.id}:high`);
		const result = resolveCliModel({
			cliModel: literal.id,
			modelRuntime: runtime([direct, base, literal], [base.provider]),
		});
		expect(result.model).toBe(literal);
		expect(result.thinkingLevel).toBeUndefined();
	});

	it("parses a thinking level after a literal colon suffix", () => {
		const gateway = model("vercel-ai-gateway", "anthropic/unique-model:exacto");
		const other = model("openrouter", gateway.id);
		const result = resolveCliModel({
			cliModel: `${gateway.id}:high`,
			modelRuntime: runtime([direct, other, gateway], [gateway.provider]),
		});
		expect(result.model).toBe(gateway);
		expect(result.thinkingLevel).toBe("high");
	});
});
