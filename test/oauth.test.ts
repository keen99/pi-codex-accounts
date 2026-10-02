import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CodexAccountStore,
	ensureActiveCodexAuth,
	loginCodexAccount,
} from "../src/codex-accounts.js";
import { createCodexOAuthProvider } from "../src/oauth.js";
import { FileCodexAccountStorageBackend } from "../src/storage.js";

const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.sig`;
const tokenFetch: typeof fetch = async () =>
	new Response(
		JSON.stringify({
			access_token: jwt,
			refresh_token: "rotated-refresh",
			expires_in: 3600,
		}),
		{ status: 200 },
	);
function manual(signal?: AbortSignal): Promise<string> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(new Error("cancelled"));
		signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
			once: true,
		});
	});
}
function portFromUrl(url: string): number {
	return Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port);
}
async function assertPortReleased(port: number) {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("Escape cancels entire owned login, closes callback port, makes no token request", async () => {
	let requests = 0,
		port = 0;
	const controller = new AbortController();
	const oauth = createCodexOAuthProvider({
		port: 0,
		fetchFn: async () => {
			requests++;
			return tokenFetch("");
		},
	});
	const ctx = {
		ui: {
			notify: (text: string) => {
				const url = text.match(
					/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\n ]+/,
				)?.[0];
				if (url) port = portFromUrl(url);
			},
			input: async () => undefined, // Escape result
		},
	} as unknown as ExtensionCommandContext;
	await assert.rejects(
		loginCodexAccount("plus", ctx, oauth, controller),
		/cancelled/,
	);
	assert.equal(requests, 0);
	assert.ok(port > 0);
	await assertPortReleased(port);
});

test("browser callback completes while input waits; input closes without requiring typing", async () => {
	let port = 0,
		inputClosed = false;
	const controller = new AbortController();
	let callbackDone: Promise<unknown> | undefined;
	const ctx = {
		ui: {
			notify: (text: string) => {
				const urlString = text.match(
					/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\n ]+/,
				)?.[0];
				if (!urlString) return;
				const url = new URL(urlString);
				const redirect = new URL(url.searchParams.get("redirect_uri")!);
				port = Number(redirect.port);
				redirect.hostname = "127.0.0.1";
				redirect.search = new URLSearchParams({
					code: "browser-code",
					state: url.searchParams.get("state")!,
				}).toString();
				callbackDone = fetch(redirect).then((response) => {
					assert.equal(response.status, 200);
				});
			},
			input: (
				_title: string,
				_placeholder: string,
				options: { signal: AbortSignal },
			) =>
				new Promise<string | undefined>((resolve) => {
					options.signal.addEventListener(
						"abort",
						() => {
							inputClosed = true;
							resolve(undefined);
						},
						{ once: true },
					);
				}),
		},
	} as unknown as ExtensionCommandContext;
	const result = await loginCodexAccount(
		"plus",
		ctx,
		createCodexOAuthProvider({ port: 0, fetchFn: tokenFetch }),
		controller,
	);
	await callbackDone;
	assert.equal(result.accountId, "test-account");
	assert.equal(inputClosed, true);
	await assertPortReleased(port);
});

test("manual code can complete login without browser callback", async () => {
	let port = 0;
	const result = await createCodexOAuthProvider({
		port: 0,
		fetchFn: tokenFetch,
	}).login({
		onAuth: ({ url }) => {
			port = portFromUrl(url);
		},
		onManualCodeInput: async () => "manual-code",
		onPrompt: async () => {
			throw new Error("unexpected fallback prompt");
		},
	});
	assert.equal(result.refresh, "rotated-refresh");
	await assertPortReleased(port);
});

test("occupied port fails fast and never closes somebody else's server", async () => {
	const other = createServer((_req, res) => res.end("other server still here"));
	await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
	const port = (other.address() as { port: number }).port;
	try {
		await assert.rejects(
			createCodexOAuthProvider({ port }).login({
				onAuth: () => assert.fail("auth should not start"),
				onPrompt: async () => "",
			}),
			/occupied/,
		);
		assert.equal(
			await (await fetch(`http://127.0.0.1:${port}`)).text(),
			"other server still here",
		);
	} finally {
		await new Promise<void>((resolve) => other.close(() => resolve()));
	}
});

test("OAuth state mismatch rejects manual redirect and closes owned server", async () => {
	let port = 0;
	await assert.rejects(
		createCodexOAuthProvider({ port: 0, fetchFn: tokenFetch }).login({
			onAuth: ({ url }) => {
				port = portFromUrl(url);
			},
			onManualCodeInput: async () =>
				"http://localhost/auth/callback?code=wrong&state=wrong",
			onPrompt: async () => "",
		}),
		/state mismatch/,
	);
	await assertPortReleased(port);
});

test("deadline abort closes owned server while manual input is still waiting", async () => {
	const controller = new AbortController();
	let port = 0;
	const operation = createCodexOAuthProvider({ port: 0 }).login({
		signal: controller.signal,
		onAuth: ({ url }) => {
			port = portFromUrl(url);
			setTimeout(() => controller.abort(new Error("test deadline")), 10);
		},
		onManualCodeInput: manual,
		onPrompt: async () => "",
	});
	await assert.rejects(operation, /test deadline/);
	await assertPortReleased(port);
});

test("refresh timeout aborts transport, waits settlement under lock, writes nothing partial", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-refresh-timeout-"));
	const path = join(dir, "accounts.json");
	const raw = JSON.stringify({
		default: "plus",
		accounts: { plus: { access: jwt, refresh: "old-refresh", expires: 0 } },
	});
	writeFileSync(path, raw);
	let settled = false,
		sawHeldLock = false;
	try {
		const oauth = createCodexOAuthProvider({
			requestTimeoutMs: 15,
			fetchFn: (_url, options) =>
				new Promise((_resolve, reject) => {
					sawHeldLock = existsSync(`${path}.lock`);
					options?.signal?.addEventListener(
						"abort",
						() => {
							assert.equal(existsSync(`${path}.lock`), true);
							setTimeout(() => {
								settled = true;
								reject(new Error("transport aborted and settled"));
							}, 10);
						},
						{ once: true },
					);
				}),
		});
		const ctx = {
			modelRegistry: {
				setRuntimeApiKey: () => undefined,
				removeRuntimeApiKey: () => undefined,
			},
		} as unknown as ExtensionContext;
		const result = await ensureActiveCodexAuth(
			ctx,
			new CodexAccountStore(new FileCodexAccountStorageBackend(path)),
			{ accountName: "plus", oauthProvider: oauth },
		);
		assert.equal(result.status, "error");
		assert.equal(settled, true);
		assert.equal(sawHeldLock, true);
		assert.equal(existsSync(`${path}.lock`), false);
		assert.equal(readFileSync(path, "utf8"), raw);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
