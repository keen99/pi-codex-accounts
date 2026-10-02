import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginCodexAccount } from "../src/codex-accounts.js";
import { createCodexOAuthProvider } from "../src/oauth.js";
import { restoreAccountSelection } from "../src/session-state.js";

/** Loaded only by isolated RPC smoke tests. Never installed as a user extension. */
export default function controls(pi: ExtensionAPI) {
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				plan_type: "test",
				rate_limit: {
					primary_window: { used_percent: 5, limit_window_seconds: 18000 },
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	pi.registerCommand("test-state", {
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				JSON.stringify({
					testState: true,
					selection: restoreAccountSelection(ctx.sessionManager.getBranch()),
					key: await ctx.modelRegistry.getApiKeyForProvider("openai-codex"),
				}),
				"info",
			);
		},
	});
	pi.registerCommand("test-owned-login", {
		handler: async (_args, ctx) => {
			const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-plus" } })).toString("base64url")}.sig`;
			const oauth = createCodexOAuthProvider({
				port: 0,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							access_token: jwt,
							refresh_token: "fake-login-refresh",
							expires_in: 3600,
						}),
						{ status: 200 },
					),
			});
			try {
				await loginCodexAccount("plus", ctx, oauth);
				ctx.ui.notify("test login complete", "info");
			} catch (error) {
				ctx.ui.notify(`test login exit: ${(error as Error).message}`, "info");
			}
		},
	});
	pi.registerCommand("test-reload", {
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
	pi.registerCommand("test-quit", {
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
