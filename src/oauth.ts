/**
 * Owned Codex PKCE flow, matching pi's client/endpoints. Unlike the legacy
 * provider, we own the callback server and honor cancellation during every wait.
 * No private process handles, port sweeps, process kills, or detached exchanges.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

export type OAuthCredentials = {
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
};
export type DeviceCodeInfo = { userCode: string; verificationUri: string };
export type CodexOAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
	signal?: AbortSignal;
};
export type CodexOAuthSelectPrompt = {
	message: string;
	options: { id: string; label: string }[];
	signal?: AbortSignal;
};
export type CodexOAuthCallbacks = {
	signal?: AbortSignal;
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	onDeviceCode?: (info: DeviceCodeInfo) => void;
	onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;
	onPrompt: (prompt: CodexOAuthPrompt) => Promise<string>;
	onSelect?: (prompt: CodexOAuthSelectPrompt) => Promise<string | undefined>;
};
export type CodexOAuthProvider = {
	login(callbacks: CodexOAuthCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string | Promise<string>;
};
export type RefreshOnlyCodexOAuthProvider = Pick<
	CodexOAuthProvider,
	"refreshToken" | "getApiKey"
>;

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const JWT_CLAIM = "https://api.openai.com/auth";
export type OAuthOptions = {
	port?: number;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
};

function cancelError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("Codex login cancelled");
}
function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancelError(signal);
}
function parseCode(input: string, expectedState: string): string {
	const value = input.trim();
	let code: string | null | undefined;
	let state: string | null | undefined;
	try {
		const url = new URL(value);
		code = url.searchParams.get("code");
		state = url.searchParams.get("state");
	} catch {
		if (value.includes("code=")) {
			const params = new URLSearchParams(value);
			code = params.get("code");
			state = params.get("state");
		} else if (value.includes("#")) {
			[code, state] = value.split("#", 2);
		} else code = value;
	}
	if (state && state !== expectedState) throw new Error("OAuth state mismatch");
	if (!code) throw new Error("Missing authorization code");
	return code;
}
function accountIdFromToken(token: string): string {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
		);
		const id = payload?.[JWT_CLAIM]?.chatgpt_account_id;
		if (typeof id === "string" && id) return id;
	} catch {
		/* error below contains no token */
	}
	throw new Error("OpenAI returned an access token without a Codex account ID");
}

async function exchange(
	body: URLSearchParams,
	options: OAuthOptions,
	parent?: AbortSignal,
): Promise<OAuthCredentials> {
	const controller = new AbortController();
	const abort = () => controller.abort(cancelError(parent));
	parent?.addEventListener("abort", abort, { once: true });
	if (parent?.aborted) abort();
	const timeout = setTimeout(
		() => controller.abort(new Error("Codex token request timed out")),
		options.requestTimeoutMs ?? 30_000,
	);
	try {
		checkSignal(controller.signal);
		const response = await (options.fetchFn ?? fetch)(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: controller.signal,
		});
		// Await fetch settlement and body parsing before returning to the locked
		// refresh transaction. Never abandon a token exchange via Promise.race.
		if (!response.ok)
			throw new Error(
				`OpenAI token request failed (HTTP ${response.status}); retry or re-login.`,
			);
		const json = (await response.json()) as Record<string, unknown>;
		if (
			typeof json.access_token !== "string" ||
			typeof json.refresh_token !== "string" ||
			typeof json.expires_in !== "number"
		) {
			throw new Error("OpenAI token response is missing required fields");
		}
		return {
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
			accountId: accountIdFromToken(json.access_token),
		};
	} finally {
		clearTimeout(timeout);
		parent?.removeEventListener("abort", abort);
	}
}

export function createCodexOAuthProvider(
	options: OAuthOptions = {},
): CodexOAuthProvider {
	return {
		getApiKey: (credential) => credential.access,
		refreshToken: (credential) =>
			exchange(
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: credential.refresh,
					client_id: CLIENT_ID,
				}),
				options,
			),
		login: (callbacks) => ownedLogin(callbacks, options),
	};
}
export function getDefaultCodexOAuthProvider(
	_providerId: string,
): CodexOAuthProvider {
	return createCodexOAuthProvider();
}

async function ownedLogin(
	callbacks: CodexOAuthCallbacks,
	options: OAuthOptions,
): Promise<OAuthCredentials> {
	checkSignal(callbacks.signal);
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(16).toString("hex");
	const redirectUri =
		options.port === undefined
			? REDIRECT_URI
			: `http://localhost:${options.port}/auth/callback`;
	const sockets = new Set<Socket>();
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const browserCode = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	// Handler attached immediately: abort/bind failures cannot leak a rejection.
	void browserCode.catch(() => undefined);
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/auth/callback") {
			res.writeHead(404).end();
			return;
		}
		if (url.searchParams.get("state") !== state) {
			res.writeHead(400).end("OAuth state mismatch");
			return;
		}
		if (url.searchParams.has("error")) {
			res.writeHead(400).end("Login was not authorized");
			rejectCode(new Error("OpenAI login was not authorized"));
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			res.writeHead(400).end("Missing code");
			return;
		}
		res
			.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			.end("Login received. You can close this browser tab.");
		resolveCode(code);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const abort = () => rejectCode(cancelError(callbacks.signal));
	callbacks.signal?.addEventListener("abort", abort, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", (error: NodeJS.ErrnoException) =>
				reject(
					error.code === "EADDRINUSE"
						? new Error(
								`Codex login port ${options.port ?? 1455} is occupied. Finish or cancel that login; no other process was touched.`,
							)
						: error,
				),
			);
			server.listen(options.port ?? 1455, "127.0.0.1", resolve);
		});
		checkSignal(callbacks.signal);
		const actualPort = (server.address() as { port: number }).port;
		const actualRedirect =
			options.port === 0
				? `http://localhost:${actualPort}/auth/callback`
				: redirectUri;
		const url = new URL("https://auth.openai.com/oauth/authorize");
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: actualRedirect,
			scope: "openid profile email offline_access",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "pi",
		}).toString();
		callbacks.onAuth({
			url: url.toString(),
			instructions: "Complete browser login; Escape in pi cancels.",
		});
		const manual = callbacks.onManualCodeInput
			? callbacks.onManualCodeInput(callbacks.signal)
			: callbacks.onPrompt({
					message: "Paste authorization code or redirect URL; Escape cancels",
					signal: callbacks.signal,
				});
		const manualCode = manual.then((input) => parseCode(input, state));
		const code = await Promise.race([browserCode, manualCode]);
		checkSignal(callbacks.signal);
		callbacks.onProgress?.("Exchanging authorization code…");
		return await exchange(
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				code_verifier: verifier,
				redirect_uri: actualRedirect,
			}),
			options,
			callbacks.signal,
		);
	} finally {
		callbacks.signal?.removeEventListener("abort", abort);
		for (const socket of sockets) socket.destroy();
		if (server.listening)
			await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
