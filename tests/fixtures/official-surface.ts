/**
 * Stand-in for the official @charmland/pi-hyper-provider@0.4.0 registration
 * surface, used by tests/provider.integration.test.ts to prove both extensions
 * can be installed at once.
 *
 * It deliberately registers under the OFFICIAL identifiers — provider id
 * "hyper", status key "hyper", /hyper-status command, hyper-prism-route entry
 * renderer, HYPER_API_KEY — and publishes a model with an id we also serve
 * ("glm-5.3"), so the test asserts provider-scoped model resolution instead of
 * accidental global-key behaviour.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function officialSurfaceFixture(pi: ExtensionAPI) {
	pi.registerProvider("hyper", {
		baseUrl: "https://hyper.charm.land/v1",
		apiKey: "$HYPER_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "glm-5.3",
				name: "Official fixture GLM 5.3",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 512,
			},
		],
	});

	pi.registerEntryRenderer("hyper-prism-route", () => undefined);

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status",
		handler: async () => {},
	});

	pi.on("turn_end", (_event, ctx) => {
		ctx.ui.setStatus("hyper", "Hyper fixture status");
	});
}
